import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GmailAttentionDecision } from "@workspace/gmail/card-types";
import { TriageEngine, TRIAGE_MIN_CANDIDATE_AGE_MS } from "./triage-engine.js";
import type { TriageCandidate, TriageStore } from "./triage-store.js";

const NOW = 2_000_000_000_000;

function candidate(threadId: string, overrides: Partial<TriageCandidate> = {}): TriageCandidate {
  return {
    channelId: "ch-1",
    threadId,
    messageId: `${threadId}-msg`,
    from: "a@example.com",
    to: "me@example.com",
    subject: "Question",
    snippet: "Quick question",
    labels: ["INBOX", "UNREAD"],
    priorReply: false,
    enqueuedAt: NOW - TRIAGE_MIN_CANDIDATE_AGE_MS - 1,
    attempts: 0,
    ...overrides,
  };
}

/**
 * Minimal fake TriageStore: only the methods `runTriagePass`/`applyVerdict`
 * touch are implemented; the rest are no-ops. Records removeCandidate calls so
 * we can assert what was (and was not) dequeued.
 */
function makeStore(candidates: TriageCandidate[]): {
  store: TriageStore;
  removed: Array<{ threadId: string; messageId: string }>;
  queue: TriageCandidate[];
} {
  const queue = [...candidates];
  const removed: Array<{ threadId: string; messageId: string }> = [];
  const store = {
    oldestCandidateAt: () =>
      queue.length ? Math.min(...queue.map((c) => c.enqueuedAt)) : undefined,
    hasSavedPrefs: () => true,
    getPrefs: () => ({ preferencesText: "everything", knownSenderShortcut: false }),
    runsInLastHour: () => 0,
    pendingCandidates: (_channelId: string, limit: number) => queue.slice(0, limit),
    bumpCandidateAttempts: () => undefined,
    recordRun: () => undefined,
    recordHit: () => undefined,
    removeCandidate: (_channelId: string, threadId: string, messageId: string) => {
      removed.push({ threadId, messageId });
      const i = queue.findIndex((c) => c.threadId === threadId && c.messageId === messageId);
      if (i >= 0) queue.splice(i, 1);
    },
    shouldStartTurn: () => false,
  } as unknown as TriageStore;
  return { store, removed, queue };
}

describe("TriageEngine surface-failure handling", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a candidate queued (no silent drop) when applyDecision throws", async () => {
    const { store, removed } = makeStore([candidate("thr-1")]);
    const applyDecision = vi.fn<
      (channelId: string, threadId: string, decision: GmailAttentionDecision) => Promise<void>
    >(async () => {
      throw new Error("card update failed");
    });

    const engine = new TriageEngine({
      store,
      wake: { enqueue: () => undefined } as never,
      runTriageModel: async () => JSON.stringify([{ i: 1, decision: "surface", reason: "r" }]),
      isConfigured: () => true,
      applyDecision,
      now: () => NOW,
    });

    const { result } = await engine.runTriagePass("ch-1");

    expect(applyDecision).toHaveBeenCalledTimes(1);
    // The decision failed → the candidate must NOT be dequeued (left for retry).
    expect(removed).toHaveLength(0);
    expect(result).toMatchObject({ kind: "ran", surfaced: 0 });
    // The failure is logged, not swallowed.
    expect(console.error).toHaveBeenCalled();
  });

  it("dequeues a candidate only after applyDecision succeeds", async () => {
    const { store, removed } = makeStore([candidate("thr-2")]);
    const applyDecision = vi.fn(async () => undefined);

    const engine = new TriageEngine({
      store,
      wake: { enqueue: () => undefined } as never,
      runTriageModel: async () => JSON.stringify([{ i: 1, decision: "surface", reason: "r" }]),
      isConfigured: () => true,
      applyDecision,
      now: () => NOW,
    });

    const { result } = await engine.runTriagePass("ch-1");

    expect(applyDecision).toHaveBeenCalledTimes(1);
    expect(removed).toEqual([{ threadId: "thr-2", messageId: "thr-2-msg" }]);
    expect(result).toMatchObject({ kind: "ran", surfaced: 1 });
  });

  it("processes the rest of the batch when one candidate's decision fails", async () => {
    const { store, removed } = makeStore([candidate("thr-a"), candidate("thr-b")]);
    const applyDecision = vi.fn(async (_c: string, threadId: string) => {
      if (threadId === "thr-a") throw new Error("boom");
    });

    const engine = new TriageEngine({
      store,
      wake: { enqueue: () => undefined } as never,
      runTriageModel: async () =>
        JSON.stringify([
          { i: 1, decision: "surface", reason: "r" },
          { i: 2, decision: "surface", reason: "r" },
        ]),
      isConfigured: () => true,
      applyDecision,
      now: () => NOW,
    });

    const { result } = await engine.runTriagePass("ch-1");

    expect(applyDecision).toHaveBeenCalledTimes(2);
    // Only the succeeding candidate is dequeued; the failing one stays queued.
    expect(removed).toEqual([{ threadId: "thr-b", messageId: "thr-b-msg" }]);
    expect(result).toMatchObject({ kind: "ran", surfaced: 1 });
  });
});
