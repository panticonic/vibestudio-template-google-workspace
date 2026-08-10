import { describe, expect, it } from "vitest";
import {
  WAKE_DEBOUNCE_MS,
  WAKE_TURN_CAP_PER_HOUR,
  buildWakeDigestPrompt,
  computeWakeDecision,
  type QueuedAttentionHit,
} from "./wake.js";

const NOW = 1_000_000_000;

function hit(threadId: string, overrides: Partial<QueuedAttentionHit> = {}): QueuedAttentionHit {
  return {
    threadId,
    directiveId: "rule-1",
    from: "a@example.com",
    to: "me@example.com",
    subject: "Question",
    snippet: "Quick question",
    reason: "matched rule-1",
    actions: ["surface", "summarize"],
    enqueuedAt: NOW,
    ...overrides,
  };
}

describe("computeWakeDecision", () => {
  it("is idle with an empty queue", () => {
    expect(
      computeWakeDecision({
        queuedCount: 0,
        oldestEnqueuedAt: undefined,
        recentTurnTimestamps: [],
        now: NOW,
      })
    ).toEqual({ kind: "idle" });
  });

  it("waits until the debounce window elapses from the oldest hit", () => {
    expect(
      computeWakeDecision({
        queuedCount: 2,
        oldestEnqueuedAt: NOW - 10_000,
        recentTurnTimestamps: [],
        now: NOW,
      })
    ).toEqual({ kind: "wait", deadline: NOW - 10_000 + WAKE_DEBOUNCE_MS });
  });

  it("fires a turn once the window elapses and the cap is free", () => {
    expect(
      computeWakeDecision({
        queuedCount: 3,
        oldestEnqueuedAt: NOW - WAKE_DEBOUNCE_MS,
        recentTurnTimestamps: [NOW - 30 * 60_000],
        now: NOW,
      })
    ).toEqual({ kind: "turn" });
  });

  it("caps at four wake turns per hour and retries when the oldest ages out", () => {
    const turns = [NOW - 50 * 60_000, NOW - 40 * 60_000, NOW - 30 * 60_000, NOW - 10 * 60_000];
    expect(turns).toHaveLength(WAKE_TURN_CAP_PER_HOUR);
    expect(
      computeWakeDecision({
        queuedCount: 5,
        oldestEnqueuedAt: NOW - WAKE_DEBOUNCE_MS - 1,
        recentTurnTimestamps: turns,
        now: NOW,
      })
    ).toEqual({ kind: "capped", queued: 5, retryAt: NOW - 50 * 60_000 + 60 * 60_000 });
  });

  it("ignores turn timestamps older than one hour for the cap", () => {
    const turns = [
      NOW - 2 * 60 * 60_000,
      NOW - 61 * 60_000,
      NOW - 20 * 60_000,
      NOW - 10 * 60_000,
    ];
    expect(
      computeWakeDecision({
        queuedCount: 1,
        oldestEnqueuedAt: NOW - WAKE_DEBOUNCE_MS,
        recentTurnTimestamps: turns,
        now: NOW,
      })
    ).toEqual({ kind: "turn" });
  });
});

describe("buildWakeDigestPrompt", () => {
  it("folds all queued hits into one digest prompt", () => {
    const prompt = buildWakeDigestPrompt([hit("thr-1"), hit("thr-2", { subject: "Invoice" })]);
    expect(prompt).toContain("2 new messages matched your attention preferences");
    expect(prompt).toContain("Thread thr-1");
    expect(prompt).toContain("Thread thr-2");
    expect(prompt).toContain("Subject: Invoice");
    expect(prompt).toContain("ONE short digest message");
    expect(prompt).toContain("gmail_publish_digest");
    expect(prompt).toContain("Do not send mail without an explicit user request");
  });

  it("uses singular phrasing for one hit", () => {
    expect(buildWakeDigestPrompt([hit("thr-1")])).toContain(
      "1 new message matched your attention preferences"
    );
  });
});
