import { isDeepStrictEqual } from "node:util";
import { serializeByKey } from "@vibestudio/shared/keyedSerializer";
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
  const issuedComposes = new Map<string, RetainedCompose>();
  const pending = new Map<string, Promise<unknown>>();
  let last: ReadResult | null = null;
  let before: ReadResult | null = null;
  const operations: Operation[] = [];
  type ProviderEvidence = { found: Set<string>; searched: Set<string | null>; searchPages: Map<string | null, SearchResult>; nextCursor: string | null; reads: ReadResult[] };
  const providerEvidence = new Map<string, ProviderEvidence>();
  function evidenceFor(id: string): ProviderEvidence {
    let evidence = providerEvidence.get(id);
    if (!evidence) { evidence = { found: new Set(), searched: new Set(), searchPages: new Map(), nextCursor: null, reads: [] }; providerEvidence.set(id, evidence); }
    return evidence;
  }

  function checkSelection(composeId: string) {
    const selected = issuedComposes.get(composeId);
    if (!selected) throw new Error("Read the selected retained compose before using its provider details");
    return selected;
  }
  function runInOrder<T>(run: () => Promise<T>): Promise<T> {
    return serializeByKey(pending, "provider", run);
  }
  const services = {
    gmailGoalCatalog: {
      async discover() {
        return structuredClone(catalog);
      },
    },
    gmailGoalCompose: {
      read: (id: string) => runInOrder(async () => {
        const source = selectedSources.get(id);
        if (!source) throw new Error("Read only an owned compose in the authorized catalog");
        if (!issuedComposes.has(id)) issuedComposes.set(id, await readRetained(source));
        return structuredClone(issuedComposes.get(id)!);
      }),
    },
    gmailGoalProvider: {
      getDraft: (composeId: string, draftId: string) => runInOrder(async () => {
        const compose = checkSelection(composeId);
        const evidence = evidenceFor(composeId);
        if (draftId !== compose.draftId && (!evidence.searched.size || evidence.nextCursor !== null || !evidence.found.has(draftId)))
          throw new Error("Use the retained draft ID or a completed matching provider search");
        before = await mail.getDraft(draftId);
        last = before;
        evidence.reads.push(structuredClone(before));
        operations.push({ kind: "get", id: draftId });
        return structuredClone(before);
      }),
      findDrafts: (composeId: string, cursor: string | null) => runInOrder(async (): Promise<SearchResult> => {
        const compose = checkSelection(composeId);
        const evidence = evidenceFor(composeId);
        const cached = evidence.searchPages.get(cursor);
        if (cached) return structuredClone(cached);
        if (cursor !== evidence.nextCursor)
          throw new Error("Follow an observed identity search cursor");
        evidence.searched.add(cursor);
        operations.push({ kind: "find", cursor });
        try {
          const page = await mail.findDrafts(compose.mimeId, cursor);
          const ids = page.drafts.map(({ id }) => id);
          ids.forEach((id) => evidence.found.add(id));
          evidence.nextCursor = page.nextPageToken ?? null;
          const result: SearchResult = { status: "complete", ids, next: evidence.nextCursor };
          evidence.searchPages.set(cursor, result);
          return structuredClone(result);
        } catch (error) {
          if (isGmailApiError(error)) return { status: "unavailable", ids: [], next: null };
          throw error;
        }
      }),
      verifyDraft: (composeId: string, draftId: string, digest: string) => runInOrder(async () => {
        const compose = checkSelection(composeId);
        const evidence = evidenceFor(composeId);
        if (!evidence.reads.some(read => read.status === "found" && read.record.id === draftId && read.record.digest === digest &&
            read.record.mimeId === compose.mimeId && read.record.threadId === compose.threadId))
          throw new Error("Verify the exact earlier draft revision with matching retained identities");
        last = await mail.getDraft(draftId);
        evidence.reads.push(structuredClone(last));
        operations.push({ kind: "verify", id: draftId });
        return structuredClone(last);
      }),
      readSent: (composeId: string) => runInOrder(async () => {
        const compose = checkSelection(composeId);
        if (!compose.sentId) throw new Error("Use only the retained provider delivery ID");
        last = await mail.readSent(compose.sentId);
        evidenceFor(composeId).reads.push(structuredClone(last));
        operations.push({ kind: "sent" });
        return structuredClone(last);
      }),
    },
  };

  async function verify(value: unknown) {
    const envelope = value as { status?: string; skill?: string; outcome?: GmailGoalReport } | null;
    const report = envelope?.outcome ?? value as GmailGoalReport | null;
    const expectedSource = seed.sources.find(({ key }) => key === world.expected.compose);
    const native = expectedSource ? await readRetained(expectedSource) : null;
    const persisted = mail.readback();
    const selected = report?.composeId ? issuedComposes.get(report.composeId) ?? null : null;
    const reads = selected ? evidenceFor(selected.id).reads : [];
    const providerRead = reads.find(read => read.status === "found" && isDeepStrictEqual(read.record, report?.provider)) ?? reads.at(-1) ?? null;
    const observed = providerRead?.status === "found" ? providerRead.record : null;
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
      discoveredOwnedComposes: catalog.length === seed.sources.length,
      verifiedComposeLineage: isDeepStrictEqual(selected, native),
      boundProviderReadback: isDeepStrictEqual(observed, expectedProvider) &&
        (!providerChange || persisted.providerRevisionChanged),
      preservedGmailState: persisted.blockedProviderCalls === 0 &&
        expectedDrafts && isDeepStrictEqual(persisted.sent, initial.sent) &&
        persisted.credentialReads === Number(mail.requests.length > 0),
      reportedGmailContinuity: report?.status === world.expected.status && report.composeId === (native?.id ?? null) &&
        isDeepStrictEqual(report.retainedEvents, native?.evidence ?? []) && isDeepStrictEqual(report.provider, observed),
    };
    return { contextId, caseId, goal: world.goal, passed: Object.values(checks).every(Boolean), checks,
      catalog, selected, native, operations, requests: structuredClone(mail.requests), persisted,
      before: structuredClone(reads[0] ?? null), readback: structuredClone(providerRead),
      providerObservations: Object.fromEntries([...providerEvidence].map(([id, evidence]) => [id, structuredClone(evidence.reads)])) };
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
