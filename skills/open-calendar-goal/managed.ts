import { isDeepStrictEqual } from "node:util";
import { serializeByKey } from "@vibestudio/shared/keyedSerializer";
import { sha256HexSyncText, sortForCanonicalJson } from "@vibestudio/content-addressing";
import { contextId as actualContextId, fs } from "@workspace/runtime";
import type { CalendarDecision, CalendarHandoff, CalendarReadback, CalendarRecord, CalendarReport, CalendarSource, CalendarWindow } from "./program/types.js";
import { ownedCalendarProvider, projectCalendarRecord, type Timeline } from "./provider.js";

type EventRef = { calendarId: string; eventId: string; updated?: string; source?: "readback" };
export type OpenCalendarWorld = {
  id: string;
  goal: string;
  window: { start: string; end: string };
  timelines: readonly Timeline[];
  catalogPageSize: number;
  canStage: boolean;
  expected: {
    scope: readonly string[];
    refresh: boolean;
    status: CalendarDecision["status"];
    selection: EventRef | null;
    evidence: readonly EventRef[];
    verify?: EventRef;
    stage: boolean;
  };
};
type WindowState = { source: CalendarSource; start: string; end: string; opened: CalendarWindow; current: CalendarWindow; refreshed: boolean };
type Attempt = { kind: "open" | "refresh"; calendarId: string; start: string; end: string };

function instant(value: string) {
  if (!/(Z|[+-][0-9]{2}:[0-9]{2})$/u.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error("Use a calendar interval with an explicit UTC offset");
  return new Date(value).toISOString();
}

function providerStatus(error: unknown) {
  return error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : null;
}

function handoffBytes({ status, selection, evidence }: CalendarDecision) {
  return JSON.stringify(sortForCanonicalJson({ format: 1, status, selection, evidence }), null, 2) + "\n";
}

function resolveExpected(world: OpenCalendarWorld, ref: EventRef): CalendarRecord {
  const timeline = world.timelines.find(({ id }) => id === ref.calendarId);
  if (!timeline) throw new Error("Expected record has no fixture calendar");
  const pages = world.expected.refresh ? timeline.refresh ?? timeline.initial : timeline.initial;
  const row = ref.source === "readback" ? timeline.readback?.[ref.eventId] : pages
    .flatMap((page) => typeof page === "number" ? [] : page)
    .find((event) => event.id === ref.eventId && (ref.updated === undefined || event.updated === ref.updated));
  if (!row || typeof row !== "object") throw new Error("Expected record has no fixture revision");
  return projectCalendarRecord(timeline, row);
}

export async function prepareOpenCalendarGoal(input: { contextId: string; caseId: string }, world: OpenCalendarWorld) {
  const { contextId, caseId } = input;
  if (actualContextId !== contextId || world.id !== caseId)
    throw new Error("Calendar reconciliation must run in its owned workspace context");
  const startBound = instant(world.window.start);
  const endBound = instant(world.window.end);
  const provider = ownedCalendarProvider(world.timelines, world.catalogPageSize);
  let catalog: CalendarSource[] | null = null;
  const windows = new Map<string, WindowState>();
  const attempts: Attempt[] = [];
  const readbacks: { requested: CalendarRecord; observed: CalendarReadback }[] = [];
  let artifact: CalendarHandoff | null = null;
  const pending = new Map<string, Promise<unknown>>();

  function runInOrder<T>(run: () => Promise<T>): Promise<T> {
    return serializeByKey(pending, "provider", run);
  }

  async function readWindow(state: WindowState, kind: Attempt["kind"]) {
    const { source, start, end } = state;
    attempts.push({ kind, calendarId: source.id, start, end });
    try {
      const result = await provider.client.listEvents(source.id, { timeMin: start, timeMax: end, showDeleted: true, singleEvents: true });
      state.current = { id: state.current.id, calendarId: source.id, status: "complete",
        records: result.items.map((event) => projectCalendarRecord(source, event)) };
    } catch (error) {
      if (!providerStatus(error)) throw error;
      state.current = { id: state.current.id, calendarId: source.id, status: "unavailable", records: [] };
    }
    return state.current;
  }

  function isObserved(record: CalendarRecord) {
    return windows.get(record?.calendarId)?.current.records.some((item) => isDeepStrictEqual(item, record)) ?? false;
  }

  const services = {
    calendarGoalCatalog: {
      discover: () => runInOrder(async () => {
        catalog ??= (await provider.client.listCalendars()).map(({ id, summary, description, timeZone }) =>
          ({ id, name: summary ?? "", description: description ?? "", timeZone: timeZone ?? "UTC" }));
        return structuredClone(catalog);
      }),
    },
    calendarGoalWindows: {
      open: (id: string, start: string, end: string) => runInOrder(async () => {
        const source = catalog?.find((item) => item.id === id);
        if (!source) throw new Error("Open a calendar from the authorized discovery result");
        const normalizedStart = instant(start);
        const normalizedEnd = instant(end);
        if (normalizedStart < startBound || normalizedEnd > endBound || normalizedStart >= normalizedEnd)
          throw new Error("The Calendar interval exceeds the authorized observation window");
        const previous = windows.get(id);
        if (previous?.start === normalizedStart && previous.end === normalizedEnd)
          return structuredClone(previous.opened);
        if (previous)
          throw new Error("Open the bounded Calendar interval before verification");
        const empty: CalendarWindow = {
          id: "window-" + (windows.size + 1), calendarId: id, status: "unavailable", records: [],
        };
        const state: WindowState = {
          source, start: normalizedStart, end: normalizedEnd, refreshed: false,
          opened: empty, current: empty,
        };
        state.opened = await readWindow(state, "open");
        windows.set(id, state);
        return structuredClone(state.opened);
      }),
      refresh: (windowId: string) => runInOrder(async () => {
        const state = [...windows.values()].find(({ current }) => current.id === windowId);
        if (state?.refreshed) return structuredClone(state.current);
        if (!state)
          throw new Error("Refresh an opened Calendar window before verification");
        const result = await readWindow(state, "refresh");
        state.refreshed = true;
        return structuredClone(result);
      }),
    },
    calendarGoalReadback: {
      verify: (record: CalendarRecord) => runInOrder(async () => {
        const issued = readbacks.find(value => isDeepStrictEqual(value.requested, record));
        if (issued) return structuredClone(issued.observed);
        if (!isObserved(record))
          throw new Error("Verify a current observed Calendar event before staging");
        let observed: CalendarReadback;
        try {
          const timeline = windows.get(record.calendarId)!;
          const current = projectCalendarRecord(timeline.source, await provider.client.getEvent(record.calendarId, record.eventId));
          observed = { status: isDeepStrictEqual(current, record) ? "current" : "changed", record: current };
        } catch (error) {
          const status = providerStatus(error);
          if (!status) throw error;
          observed = { status: status === 404 ? "missing" : "unavailable", record: null };
        }
        readbacks.push({ requested: structuredClone(record), observed });
        return structuredClone(observed);
      }),
    },
    calendarGoalHandoff: {
      stage: (decision: CalendarDecision) => runInOrder(async () => {
        const startable = decision.status === "selected" && decision.selection !== null && isObserved(decision.selection) &&
          readbacks.some(value => value.observed.status === "current" && isDeepStrictEqual(value.observed.record, decision.selection));
        const relevant = new Set([...decision.evidence, ...(decision.selection ? [decision.selection] : [])].map(value => value.calendarId));
        const holdable = decision.status === "held" && decision.selection === null && decision.evidence.length > 0;
        if (artifact || !world.canStage || !(startable || holdable) || !decision.evidence.every(isObserved) ||
            !relevant.size || [...relevant].some(id => { const window = windows.get(id); return !window?.refreshed || window.current.status !== "complete"; }))
          throw new Error("Stage an authorized decision only after complete current Calendar evidence");
        const path = (await fs.mkdtemp("calendar-handoff")) + "/scheduling-handoff.json";
        const content = handoffBytes(decision);
        await fs.writeFile(path, content);
        if (await fs.readFile(path, "utf8") !== content) throw new Error("Calendar handoff readback does not match the staged decision");
        artifact = { path, sha256: sha256HexSyncText(content) };
        return { ...artifact };
      }),
    },
  };

  function expectedDecision(): CalendarDecision {
    return {
      status: world.expected.status,
      selection: world.expected.selection ? resolveExpected(world, world.expected.selection) : null,
      evidence: world.expected.evidence.map((ref) => resolveExpected(world, ref)),
    };
  }

  async function verify(value: unknown) {
    const report = value as Partial<CalendarReport> | null;
    const decision = expectedDecision();
    const reportEvidence = report?.decision?.evidence;
    const handoffText = artifact ? await fs.readFile(artifact.path, "utf8") : null;
    const trace = provider.trace();
    const visibleCatalog = world.timelines.map(({ id, name, description, timeZone }) => ({ id, name, description, timeZone }));
    const ask = world.expected.verify ? resolveExpected(world, world.expected.verify) : null;
    const observed = readbacks.find(value => isDeepStrictEqual(value.requested, ask)) ?? null;
    const expectedReadback = !ask ? null : decision.status === "stale" ?
      { status: decision.evidence.length ? "changed" : "missing", record: decision.evidence[0] ?? null } :
      decision.status === "incomplete" ? { status: "unavailable", record: null } : { status: "current", record: ask };
    const checks = {
      discoveredCalendarSources: isDeepStrictEqual(catalog, visibleCatalog),
      groundedCalendarEvidence: (!decision.selection || isObserved(decision.selection)) && decision.evidence.every(isObserved),
      boundCalendarReadback: isDeepStrictEqual(observed?.requested ?? null, ask) &&
        isDeepStrictEqual(observed?.observed ?? null, expectedReadback),
      reconciledCalendarDecision: report?.decision?.status === decision.status &&
        isDeepStrictEqual(report.decision.selection, decision.selection) && Array.isArray(reportEvidence) &&
        reportEvidence.length === decision.evidence.length &&
        decision.evidence.every((item) => reportEvidence.some((seen) => isDeepStrictEqual(item, seen))),
      verifiedCalendarHandoff: world.expected.stage ?
        Boolean(artifact && handoffText && Array.isArray(reportEvidence) && isDeepStrictEqual(report?.handoff, artifact) &&
          handoffText === handoffBytes({ ...decision, evidence: reportEvidence }) &&
          artifact.sha256 === sha256HexSyncText(handoffText)) : artifact === null && report?.handoff === null,
      preservedCalendarAuthority: trace.denied === 0 && trace.credentialReads === 1,
    };
    return { passed: Object.values(checks).every(Boolean), caseId, contextId, goal: world.goal, checks, catalog, attempts, providerRequests: trace.requests,
      windows: [...windows.values()].map(({ current }) => current), readback: observed, handoff: artifact, handoffText };
  }

  async function qualify() {
    await services.calendarGoalCatalog.discover();
    const opened = [];
    for (const calendarId of world.expected.scope)
      opened.push(await services.calendarGoalWindows.open(calendarId, world.window.start, world.window.end));
    if (world.expected.refresh) {
      for (const window of opened) await services.calendarGoalWindows.refresh(window.id);
    }
    if (world.expected.verify) await services.calendarGoalReadback.verify(resolveExpected(world, world.expected.verify));
    const decision = expectedDecision();
    const handoff = world.expected.stage ? await services.calendarGoalHandoff.stage(decision) : null;
    const report = { decision, handoff };
    return { ...await verify(report), report };
  }
  return { goal: world.goal, services, verify, qualify };
}
