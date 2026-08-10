import type { GmailAttentionDecision } from "@workspace/gmail/card-types";
import type { GmailAttentionEvent } from "../sync/thread-model.js";
import {
  TRIAGE_SYSTEM_PROMPT,
  buildTriagePrompt,
  parseTriageResponse,
  type TriageVerdict,
} from "./prompt.js";
import type { TriageCandidate, TriageStore } from "./triage-store.js";
import type { WakeQueue } from "./wake.js";

export const TRIAGE_BATCH_MAX = 25;
export const TRIAGE_MIN_CANDIDATE_AGE_MS = 60_000;
export const TRIAGE_RUNS_PER_HOUR_CAP = 12;
export const TRIAGE_MAX_ATTEMPTS = 2;

export const KNOWN_SENDER_SOURCE = "known-sender";
export const TRIAGE_SOURCE = "triage";

export interface TriageEngineDeps {
  store: TriageStore;
  wake: WakeQueue;
  /**
   * One LLM call over the built prompt; returns raw model text. Injected so
   * the engine stays unit-testable and provider-agnostic.
   */
  runTriageModel: (channelId: string, systemPrompt: string, userPrompt: string) => Promise<string>;
  /** Whether the channel finished onboarding (no LLM spend before that). */
  isConfigured: (channelId: string) => boolean;
  /** Mark a thread surfaced/woken in the local cache + thread card. */
  applyDecision: (
    channelId: string,
    threadId: string,
    decision: GmailAttentionDecision
  ) => Promise<void>;
  now?: () => number;
}

export type TriagePassResult =
  | { kind: "skipped"; reason: "empty" | "too-fresh" | "rate-capped" | "not-configured" }
  | { kind: "ran"; outcome: "ok" | "fallback"; woke: number; surfaced: number; ignored: number };

/**
 * Two-stage triage: a free deterministic prefilter at sync time (known-sender
 * shortcut, unread+inbox gate) and a batched LLM pass over queued candidate
 * metadata, decided against the user's natural-language preferences.
 */
export class TriageEngine {
  constructor(private readonly deps: TriageEngineDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Exact next time this channel's durable candidate queue needs attention. */
  nextWakeAt(channelId: string, now = this.now()): number | undefined {
    const oldest = this.deps.store.oldestCandidateAt(channelId);
    if (oldest === undefined) return undefined;
    if (!this.deps.isConfigured(channelId) && !this.deps.store.hasSavedPrefs(channelId)) {
      return undefined;
    }
    const minimumAgeAt = oldest + TRIAGE_MIN_CANDIDATE_AGE_MS;
    if (minimumAgeAt > now) return minimumAgeAt;
    if (this.deps.store.runsInLastHour(channelId) >= TRIAGE_RUNS_PER_HOUR_CAP) {
      return now + 10 * 60 * 1000;
    }
    return now + 1000;
  }

  /**
   * Stage 1 (sync-time, free): route a new-mail event. Returns the decision
   * applied immediately (known-sender wake) or null when the event was
   * queued for the LLM pass / not triage-worthy.
   */
  considerEvent(channelId: string, event: GmailAttentionEvent): GmailAttentionDecision | null {
    if (!event.unread || !event.inInbox) return null;
    const prefs = this.deps.store.getPrefs(channelId);
    if (prefs.knownSenderShortcut && event.priorReplyToSender) {
      const decision: GmailAttentionDecision = {
        wake: true,
        directiveId: KNOWN_SENDER_SOURCE,
        directiveName: "Known sender",
        reason: "From someone you have replied to before",
        actions: ["surface", "summarize"],
      };
      this.deps.store.recordHit(channelId, event.threadId, decision);
      if (this.deps.store.shouldStartTurn(channelId, event, KNOWN_SENDER_SOURCE)) {
        this.deps.wake.enqueue(channelId, event, decision);
      }
      return decision;
    }
    // Everything else waits for the batched LLM pass — never per-message calls.
    this.deps.store.enqueueCandidate(channelId, event);
    return null;
  }

  /**
   * Stage 2 (alarm-driven): run one batched LLM call over queued candidates.
   * Returns the delay until this channel's queue should be looked at again,
   * or undefined when the queue is drained.
   */
  async runTriagePass(
    channelId: string
  ): Promise<{ result: TriagePassResult; retryInMs?: number }> {
    const now = this.now();
    const oldest = this.deps.store.oldestCandidateAt(channelId);
    if (oldest === undefined) return { result: { kind: "skipped", reason: "empty" } };
    if (!this.deps.isConfigured(channelId) && !this.deps.store.hasSavedPrefs(channelId)) {
      // Zero LLM spend before onboarding: only the known-sender shortcut runs.
      return { result: { kind: "skipped", reason: "not-configured" } };
    }
    const age = now - oldest;
    if (age < TRIAGE_MIN_CANDIDATE_AGE_MS) {
      return {
        result: { kind: "skipped", reason: "too-fresh" },
        retryInMs: TRIAGE_MIN_CANDIDATE_AGE_MS - age,
      };
    }
    if (this.deps.store.runsInLastHour(channelId) >= TRIAGE_RUNS_PER_HOUR_CAP) {
      return { result: { kind: "skipped", reason: "rate-capped" }, retryInMs: 10 * 60 * 1000 };
    }

    const candidates = this.deps.store.pendingCandidates(channelId, TRIAGE_BATCH_MAX);
    const prefs = this.deps.store.getPrefs(channelId);

    let verdicts: TriageVerdict[] | null = null;
    let outcome: "ok" | "fallback" = "ok";
    try {
      const response = await this.deps.runTriageModel(
        channelId,
        TRIAGE_SYSTEM_PROMPT,
        buildTriagePrompt(prefs.preferencesText, candidates)
      );
      verdicts = parseTriageResponse(response, candidates.length);
    } catch {
      verdicts = null;
    }

    if (!verdicts) {
      const retriable = candidates.filter((c) => c.attempts + 1 < TRIAGE_MAX_ATTEMPTS);
      this.deps.store.bumpCandidateAttempts(channelId, candidates);
      if (retriable.length === candidates.length) {
        // Whole batch still retriable: leave it queued for the next alarm.
        this.deps.store.recordRun(channelId, candidates.length, "error");
        return {
          result: { kind: "ran", outcome: "fallback", woke: 0, surfaced: 0, ignored: 0 },
          retryInMs: TRIAGE_MIN_CANDIDATE_AGE_MS,
        };
      }
      // Out of attempts: deterministic fallback — visible-but-quiet beats
      // silent loss. Prior-reply candidates wake, the rest surface.
      outcome = "fallback";
      verdicts = candidates.map((candidate, index) => ({
        index: index + 1,
        decision: candidate.priorReply ? "wake" : "surface",
        reason: "Triage model unavailable — surfaced without analysis",
      }));
    }

    const byIndex = new Map(verdicts.map((verdict) => [verdict.index, verdict]));
    let woke = 0;
    let surfaced = 0;
    let ignored = 0;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      // Missing verdict for a candidate → surface (never silently drop).
      const verdict = byIndex.get(index + 1) ?? {
        index: index + 1,
        decision: "surface" as const,
        reason: "No triage verdict returned",
      };
      try {
        await this.applyVerdict(channelId, candidate, verdict);
      } catch (err) {
        // The decision (e.g. SURFACE) did not stick — the actionable flag /
        // thread card update failed. Do NOT dequeue: leaving the candidate in
        // the queue lets the next alarm retry it rather than silently dropping
        // a thread the model decided to surface.
        console.error(
          `[gmail-agent] triage applyVerdict failed channel=${channelId} thread=${candidate.threadId}:`,
          err
        );
        continue;
      }
      if (verdict.decision === "wake") woke += 1;
      else if (verdict.decision === "surface") surfaced += 1;
      else ignored += 1;
      this.deps.store.removeCandidate(channelId, candidate.threadId, candidate.messageId);
    }
    this.deps.store.recordRun(channelId, candidates.length, outcome);
    const remaining = this.deps.store.oldestCandidateAt(channelId);
    return {
      result: { kind: "ran", outcome, woke, surfaced, ignored },
      ...(remaining !== undefined ? { retryInMs: 1000 } : {}),
    };
  }

  /**
   * Pure re-evaluation of candidates against arbitrary preference text —
   * used by the preference-change dry run. Touches neither the queue nor the
   * hit store; only the run-rate cap is consumed. Returns null when the cap
   * is hit or the model output is unusable (callers degrade gracefully).
   */
  async evaluateCandidates(
    channelId: string,
    candidates: TriageCandidate[],
    preferencesText: string
  ): Promise<TriageVerdict[] | null> {
    if (candidates.length === 0) return [];
    if (this.deps.store.runsInLastHour(channelId) >= TRIAGE_RUNS_PER_HOUR_CAP) return null;
    try {
      const response = await this.deps.runTriageModel(
        channelId,
        TRIAGE_SYSTEM_PROMPT,
        buildTriagePrompt(preferencesText, candidates.slice(0, TRIAGE_BATCH_MAX))
      );
      const verdicts = parseTriageResponse(response, candidates.length);
      this.deps.store.recordRun(channelId, candidates.length, verdicts ? "ok" : "error");
      return verdicts;
    } catch {
      this.deps.store.recordRun(channelId, candidates.length, "error");
      return null;
    }
  }

  private async applyVerdict(
    channelId: string,
    candidate: TriageCandidate,
    verdict: TriageVerdict
  ): Promise<void> {
    if (verdict.decision === "ignore") return;
    const decision: GmailAttentionDecision = {
      wake: true,
      directiveId: TRIAGE_SOURCE,
      directiveName: verdict.decision === "wake" ? "Triage: wake" : "Triage: surfaced",
      reason: verdict.reason,
      actions: ["surface"],
    };
    this.deps.store.recordHit(channelId, candidate.threadId, decision);
    // Let errors propagate to runTriagePass's per-candidate handler — a failed
    // surface/card update must keep the candidate queued, not silently drop it.
    await this.deps.applyDecision(channelId, candidate.threadId, decision);
    if (verdict.decision === "wake") {
      const event = eventFromCandidate(candidate);
      if (this.deps.store.shouldStartTurn(channelId, event, TRIAGE_SOURCE)) {
        this.deps.wake.enqueue(channelId, event, decision);
      }
    }
  }
}

function eventFromCandidate(candidate: TriageCandidate): GmailAttentionEvent {
  return {
    threadId: candidate.threadId,
    messageId: candidate.messageId,
    from: candidate.from,
    to: candidate.to,
    subject: candidate.subject,
    snippet: candidate.snippet,
    labels: candidate.labels,
    ...(candidate.category ? { category: candidate.category } : {}),
    hasAttachment: false,
    priorReplyToSender: candidate.priorReply,
    unread: true,
    inInbox: true,
    addressedToUser: true,
  };
}
