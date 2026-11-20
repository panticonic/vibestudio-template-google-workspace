import { isDeepStrictEqual } from "node:util";
import { isGmailApiError } from "@workspace/gmail";
import { channelClientRpcMethods } from "@workspace/pubsub/rpc-contract";
import { contextId as actualContextId, rpc } from "@workspace/runtime";
import { bindGmailComposeHistory } from "@workspace-skills/gmail-compose-history-bindings";
import type { ComposeSelection, GmailContinuity, GmailGoalReport, ReadResult, RetainedCompose, SearchResult } from "./program/types.js";
import { ownedGmailProvider, type ProviderRequest, type ProviderWorld } from "./provider.js";

type Source = {
  key: string; title: string; room: string; channelId: string; targetId: string;
  messageId: string; ownerId: string; envelopeIds: string[];
};
type Seed = { contextId: string; caseId: string; sources: Source[] };
type Operation =
  | { kind: "get" | "verify"; id: string }
  | { kind: "find"; cursor: string | null }
  | { kind: "sent" };
export type OpenGmailWorld = {
  id: string;
  goal: string;
  provider: ProviderWorld;
  expected: {
    compose: string | null;
    status: GmailContinuity;
    operations: readonly Operation[];
    requests: readonly ProviderRequest[];
    providerId: string | null;
  };
};
type Lineage = Awaited<ReturnType<ReturnType<typeof bindGmailComposeHistory>["services"]["gmailComposeHistory"]["read"]>>;
const statuses = new Set(["review", "saving", "saved", "sent", "delivery-unknown"]);
const text = (row: Record<string, unknown>, key: string) => typeof row[key] === "string" && row[key] ? row[key] as string : null;

async function readCoordinates(source: Source, lineage: Lineage, signal: AbortSignal): Promise<RetainedCompose> {
  const state: Record<string, unknown> = {};
  for (const event of lineage.events) {
    const row = await rpc.call(source.targetId, channelClientRpcMethods.getEnvelope, [event.id], { signal });
    if (!row || row.messageId !== event.id || row.id !== event.seq || row.senderId !== source.ownerId)
      throw new Error("The compose history changed before its provider coordinates were read");
    const payload = (row.payload as { payload: { messageId: string; initialState?: object; update?: object } }).payload;
    if (payload.messageId !== source.messageId)
      throw new Error("The provider identity belongs to another compose");
    Object.assign(state, payload.initialState, payload.update);
  }
  const latest = lineage.events.at(-1);
  const mimeId = text(state, "rfcMessageId");
  const threadId = text(state, "threadId");
  const current = text(state, "status");
  if (!latest || !mimeId || !/^<[^<>\s]+>$/u.test(mimeId) || !threadId ||
      !current || !statuses.has(current) || latest.state.status !== current)
    throw new Error("The retained compose has no current provider identity");
  return {
    id: source.messageId, channelId: source.channelId,
    state: current as RetainedCompose["state"], draftId: text(state, "draftId"),
    sentId: text(state, "sentMessageId"), mimeId, threadId, evidence: [...source.envelopeIds],
  };
}

export async function prepareOpenGmailGoal(
  input: { contextId: string; caseId: string }, world: OpenGmailWorld, seed: Seed,
) {
  const { contextId, caseId } = input;
  if (actualContextId !== contextId || seed.contextId !== contextId || caseId !== world.id || seed.caseId !== caseId)
    throw new Error("Gmail recovery must use its owned workspace context");
  const mail = ownedGmailProvider(world.provider);
  const initial = mail.readback();
  const catalog: ComposeSelection[] = seed.sources.map(({ messageId: id, title, room }) => ({ id, title, room }));
  const selectedSources = new Map(seed.sources.map((source) => [source.messageId, source]));
  async function readRetained(source: Source): Promise<RetainedCompose> {
    const signal = AbortSignal.timeout(20_000);
    const binding = bindGmailComposeHistory({ ...source, goal: world.goal }, { signal });
    try {
      const history = await binding.services.gmailComposeHistory.read(binding.request.operationId);
      return await readCoordinates(source, history, signal);
    } catch (error) {
      if (signal.aborted) throw new Error("The retained Gmail compose read timed out", { cause: error });
      throw error;
    }
  }
  let selected: RetainedCompose | null = null;
  let discovered = false;
  let busy = false;
  let last: ReadResult | null = null;
  let before: ReadResult | null = null;
  const operations: Operation[] = [];
  const found = new Set<string>();
  const searched = new Set<string | null>();
  let nextCursor: string | null = null;

  function checkSelection(composeId: string) {
    if (!selected || selected.id !== composeId) throw new Error("Read the selected retained compose before using its provider details");
    return selected;
  }
  async function exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (busy) throw new Error("Wait for the current Gmail read to finish");
    busy = true;
    try { return await run(); }
    finally { busy = false; }
  }
  const services = {
    gmailGoalCatalog: {
      async discover() {
        discovered = true;
        return structuredClone(catalog);
      },
    },
    gmailGoalCompose: {
      read: (id: string) => exclusive(async () => {
        const source = selectedSources.get(id);
        if (!discovered || !source || selected) throw new Error("Select one observed compose in the authorized catalog");
        selected = await readRetained(source);
        return structuredClone(selected);
      }),
    },
    gmailGoalProvider: {
      getDraft: (composeId: string, draftId: string) => exclusive(async () => {
        const compose = checkSelection(composeId);
        if (draftId !== compose.draftId && (!searched.size || nextCursor !== null || !found.has(draftId)))
          throw new Error("Use the retained draft ID or a completed matching provider search");
        before = await mail.getDraft(draftId);
        last = before;
        operations.push({ kind: "get", id: draftId });
        return structuredClone(before);
      }),
      findDrafts: (composeId: string, cursor: string | null) => exclusive(async (): Promise<SearchResult> => {
        const compose = checkSelection(composeId);
        if (cursor !== nextCursor || searched.has(cursor) || searched.size >= 5)
          throw new Error("Follow the latest exact identity search cursor once");
        searched.add(cursor);
        operations.push({ kind: "find", cursor });
        try {
          const page = await mail.findDrafts(compose.mimeId, cursor);
          const ids = page.drafts.map(({ id }) => id);
          ids.forEach((id) => found.add(id));
          nextCursor = page.nextPageToken ?? null;
          return { status: "complete", ids, next: nextCursor };
        } catch (error) {
          if (isGmailApiError(error)) return { status: "unavailable", ids: [], next: null };
          throw error;
        }
      }),
      verifyDraft: (composeId: string, draftId: string, digest: string) => exclusive(async () => {
        const compose = checkSelection(composeId);
        if (before?.status !== "found" || before.record.id !== draftId || before.record.digest !== digest ||
            before.record.mimeId !== compose.mimeId || before.record.threadId !== compose.threadId ||
            operations.some((row) => row.kind === "verify"))
          throw new Error("Verify the exact earlier draft revision with matching retained identities");
        last = await mail.getDraft(draftId);
        operations.push({ kind: "verify", id: draftId });
        return structuredClone(last);
      }),
      readSent: (composeId: string) => exclusive(async () => {
        const compose = checkSelection(composeId);
        if (!compose.sentId || operations.length) throw new Error("Use only the retained provider delivery ID");
        last = await mail.readSent(compose.sentId);
        operations.push({ kind: "sent" });
        return structuredClone(last);
      }),
    },
  };

  async function verify(value: unknown) {
    const envelope = value as { status?: string; skill?: string; outcome?: GmailGoalReport } | null;
    const report = envelope?.outcome;
    const expectedSource = seed.sources.find(({ key }) => key === world.expected.compose);
    const native = expectedSource ? await readRetained(expectedSource) : null;
    const persisted = mail.readback();
    const observed = last?.status === "found" ? last.record : null;
    const expectedProvider = [...persisted.drafts, ...persisted.sent].find(({ id }) => id === world.expected.providerId) ?? null;
    const providerChange = world.provider.changeAfterRead;
    const unchanged = initial.drafts.filter(({ id }) =>
      !providerChange || providerChange.next !== null || id !== providerChange.id);
    const expectedDrafts = persisted.drafts.length === unchanged.length && persisted.drafts.every((draft, index) => {
      if (providerChange?.id !== draft.id) return isDeepStrictEqual(draft, unchanged[index]);
      const { digest, sent, ...fields } = draft;
      return !sent && Boolean(digest) && isDeepStrictEqual(fields, providerChange.next);
    });
    const checks = {
      discoveredOwnedComposes: discovered && catalog.length === seed.sources.length,
      verifiedComposeLineage: isDeepStrictEqual(selected, native),
      exactGmailRequests: isDeepStrictEqual(operations, world.expected.operations) &&
        isDeepStrictEqual(mail.requests, world.expected.requests),
      boundProviderReadback: isDeepStrictEqual(observed, expectedProvider) &&
        (!providerChange || persisted.providerRevisionChanged),
      preservedGmailState: persisted.blockedProviderCalls === 0 &&
        expectedDrafts && isDeepStrictEqual(persisted.sent, initial.sent) &&
        persisted.credentialReads === Number(mail.requests.length > 0),
      reportedGmailContinuity: envelope?.status === "workspace-skill-reviewed" && envelope.skill === "gmail" &&
        report?.status === world.expected.status && report.composeId === (native?.id ?? null) &&
        isDeepStrictEqual(report.retainedEvents, native?.evidence ?? []) && isDeepStrictEqual(report.provider, observed),
    };
    return { contextId, caseId, goal: world.goal, passed: Object.values(checks).every(Boolean), checks,
      catalog, selected, native, operations, requests: structuredClone(mail.requests), persisted,
      before: structuredClone(before), readback: structuredClone(last) };
  }

  async function qualify() {
    await services.gmailGoalCatalog.discover();
    const source = seed.sources.find(({ key }) => key === world.expected.compose);
    const compose = source ? await services.gmailGoalCompose.read(source.messageId) : null;
    if (compose) {
      for (const step of world.expected.operations) {
        if (step.kind === "get") await services.gmailGoalProvider.getDraft(compose.id, step.id);
        else if (step.kind === "find") await services.gmailGoalProvider.findDrafts(compose.id, step.cursor);
        else if (step.kind === "sent") await services.gmailGoalProvider.readSent(compose.id);
        else {
          if (before?.status !== "found") throw new Error("Reference provider readback requires the earlier revision");
          await services.gmailGoalProvider.verifyDraft(compose.id, step.id, before.record.digest);
        }
      }
    }
    const report = { status: world.expected.status, composeId: compose?.id ?? null,
      retainedEvents: compose?.evidence ?? [], provider: last?.status === "found" ? last.record : null };
    return verify({ status: "workspace-skill-reviewed", skill: "gmail", outcome: report });
  }

  return { goal: world.goal, services, verify, qualify };
}
