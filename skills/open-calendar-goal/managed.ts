import { isDeepStrictEqual } from "node:util";
import { sha256HexSyncText, sortForCanonicalJson } from "@vibestudio/content-addressing";
import { contextId as actualContextId, fs } from "@workspace/runtime";
import type { CalendarDecision, CalendarHandoff, CalendarReadback, CalendarRecord, CalendarReport, CalendarSource, CalendarWindow } from "./program/types.js";
import { ownedCalendarProvider, projectCalendarRecord, type CalendarRequest, type Timeline } from "./provider.js";

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
type WindowState = { source: CalendarSource; start: string; end: string; current: CalendarWindow; refreshed: boolean };
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

function expectedProviderTrace(world: OpenCalendarWorld, start: string, end: string): CalendarRequest[] {
  const trace: CalendarRequest[] = [];
  const catalogs = Math.ceil(world.timelines.length / world.catalogPageSize);
  for (let i = 0; i < catalogs; i++) trace.push({ method: "catalog", calendarId: null, key: i ? "p" + i : null,
    generation: 0, start: null, end: null, status: 200 });
  const generations = world.expected.refresh ? 2 : 1;
  for (let generation = 1; generation <= generations; generation++) {
    for (const calendarId of world.expected.scope) {
      const timeline = world.timelines.find(({ id }) => id === calendarId);
      if (!timeline) throw new Error("Expected trace references an unknown calendar");
      const pages = generation === 1 ? timeline.initial : timeline.refresh ?? timeline.initial;
      for (const [i, page] of pages.entries()) {
        trace.push({ method: "window", calendarId, key: i ? "p" + i : null, generation, start, end,
          status: typeof page === "number" ? page : 200 });
        if (typeof page === "number") break;
      }
    }
  }
  const requested = world.expected.verify;
  if (requested) {
    const override = world.timelines.find(({ id }) => id === requested.calendarId)?.readback?.[requested.eventId];
    trace.push({ method: "event", calendarId: requested.calendarId, key: requested.eventId,
      generation: generations, start: null, end: null, status: typeof override === "number" ? override : 200 });
  }
  return trace;
}

function sameProviderReads(actual: CalendarRequest[], expected: CalendarRequest[]) {
  if (actual.length !== expected.length) return false;
  // A calendar's cursor and generation advance independently of the other
  // calendars. Only catalog discovery and final event verification order the
  // entire set of reads.
  const phase = (row: CalendarRequest) => row.method === "catalog" ? 0 : row.method === "window" ? 1 : 2;
  if (actual.some((row, i) => i > 0 && phase(row) < phase(actual[i - 1]!))) return false;
  const calendarIds = new Set(expected.map(({ calendarId }) => calendarId));
  return [...calendarIds].every((id) => isDeepStrictEqual(
    actual.filter(({ calendarId }) => calendarId === id),
    expected.filter(({ calendarId }) => calendarId === id),
  ));
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
  let lastReadback: { requested: CalendarRecord; observed: CalendarReadback } | null = null;
  let artifact: CalendarHandoff | null = null;
  let busy = false;

  async function exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (busy) throw new Error("Wait for the current Calendar operation to finish");
    busy = true;
    try { return await run(); }
    finally { busy = false; }
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
    return structuredClone(state.current);
  }

  function isObserved(record: CalendarRecord) {
    return windows.get(record?.calendarId)?.current.records.some((item) => isDeepStrictEqual(item, record)) ?? false;
  }

  const services = {
    calendarGoalCatalog: {
      discover: () => exclusive(async () => {
        catalog ??= (await provider.client.listCalendars()).map(({ id, summary, description, timeZone }) =>
          ({ id, name: summary ?? "", description: description ?? "", timeZone: timeZone ?? "UTC" }));
        return structuredClone(catalog);
      }),
    },
    calendarGoalWindows: {
      open: (id: string, start: string, end: string) => exclusive(async () => {
        const source = catalog?.find((item) => item.id === id);
        if (!source || windows.has(id) || lastReadback || artifact)
          throw new Error("Open each relevant discovered calendar once before verification");
        const normalizedStart = instant(start);
        const normalizedEnd = instant(end);
        if (normalizedStart < startBound || normalizedEnd > endBound || normalizedStart >= normalizedEnd)
          throw new Error("The Calendar interval exceeds the authorized observation window");
        const state: WindowState = {
          source, start: normalizedStart, end: normalizedEnd, refreshed: false,
          current: { id: "window-" + (windows.size + 1), calendarId: id, status: "unavailable", records: [] },
        };
        const result = await readWindow(state, "open");
        windows.set(id, state);
        return result;
      }),
      refresh: (windowId: string) => exclusive(async () => {
        const state = [...windows.values()].find(({ current }) => current.id === windowId);
        if (!state || state.refreshed || lastReadback || artifact)
          throw new Error("Refresh an opened Calendar window once before verification");
        const result = await readWindow(state, "refresh");
        state.refreshed = true;
        return result;
      }),
    },
    calendarGoalReadback: {
      verify: (record: CalendarRecord) => exclusive(async () => {
        if (lastReadback || artifact || !isObserved(record))
          throw new Error("Verify a current observed Calendar event once before staging");
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
        lastReadback = { requested: structuredClone(record), observed };
        return structuredClone(observed);
      }),
    },
    calendarGoalHandoff: {
      stage: (decision: CalendarDecision) => exclusive(async () => {
        const startable = decision.status === "selected" && decision.selection !== null &&
          lastReadback?.observed.status === "current" && isDeepStrictEqual(lastReadback.observed.record, decision.selection);
        const holdable = decision.status === "held" && decision.selection === null && decision.evidence.length > 0;
        if (artifact || !world.canStage || !(startable || holdable) || !decision.evidence.every(isObserved) ||
            !windows.size || [...windows.values()].some(({ current, refreshed }) => !refreshed || current.status !== "complete"))
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
    const expectedTrace = expectedProviderTrace(world, startBound, endBound);
    const visibleCatalog = world.timelines.map(({ id, name, description, timeZone }) => ({ id, name, description, timeZone }));
    const ask = world.expected.verify ? resolveExpected(world, world.expected.verify) : null;
    const observed = lastReadback as { requested: CalendarRecord; observed: CalendarReadback } | null;
    const expectedReadback = !ask ? null : decision.status === "stale" ?
      { status: decision.evidence.length ? "changed" : "missing", record: decision.evidence[0] ?? null } :
      decision.status === "incomplete" ? { status: "unavailable", record: null } : { status: "current", record: ask };
    const checks = {
      discoveredCalendarSources: isDeepStrictEqual(catalog, visibleCatalog),
      exactCalendarWindows: sameProviderReads(trace.requests, expectedTrace),
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
