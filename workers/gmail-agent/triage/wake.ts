import type { SqlStorage } from "@workspace/runtime/worker";
import type { GmailAttentionDecision } from "@workspace/gmail/card-types";
import type { GmailAttentionEvent } from "../sync/thread-model.js";

export const WAKE_DEBOUNCE_MS = 90_000;
export const WAKE_TURN_CAP_PER_HOUR = 4;
const WAKE_CAP_WINDOW_MS = 60 * 60 * 1000;

export interface QueuedAttentionHit {
  threadId: string;
  directiveId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  reason: string;
  actions: string[];
  enqueuedAt: number;
}

export type WakeDecision =
  | { kind: "idle" }
  /** Window still open: wake again at `deadline`. */
  | { kind: "wait"; deadline: number }
  /** Debounce elapsed but the hourly cap is hit: keep hits queued. */
  | { kind: "capped"; queued: number; retryAt: number }
  /** Drain everything into one digest turn now. */
  | { kind: "turn" };

/**
 * Pure wake policy: one digest turn per debounce window, hard-capped per
 * hour. Capped windows keep hits queued so a later digest still covers them.
 */
export function computeWakeDecision(opts: {
  queuedCount: number;
  oldestEnqueuedAt: number | undefined;
  recentTurnTimestamps: number[];
  now: number;
  debounceMs?: number;
  capPerHour?: number;
}): WakeDecision {
  const debounceMs = opts.debounceMs ?? WAKE_DEBOUNCE_MS;
  const capPerHour = opts.capPerHour ?? WAKE_TURN_CAP_PER_HOUR;
  if (opts.queuedCount === 0 || opts.oldestEnqueuedAt === undefined) return { kind: "idle" };
  const deadline = opts.oldestEnqueuedAt + debounceMs;
  if (deadline > opts.now) return { kind: "wait", deadline };
  const windowStart = opts.now - WAKE_CAP_WINDOW_MS;
  const recent = opts.recentTurnTimestamps.filter((ts) => ts > windowStart).sort((a, b) => a - b);
  if (recent.length >= capPerHour) {
    return {
      kind: "capped",
      queued: opts.queuedCount,
      retryAt: recent[0]! + WAKE_CAP_WINDOW_MS,
    };
  }
  return { kind: "turn" };
}

/** Single digest prompt covering every queued hit in one agent turn. */
export function buildWakeDigestPrompt(hits: QueuedAttentionHit[], overflowNote?: string): string {
  const lines: string[] = [
    `${hits.length} new message${hits.length === 1 ? "" : "s"} matched your attention preferences since the last digest.`,
    "",
  ];
  for (const hit of hits) {
    lines.push(
      `- Thread ${hit.threadId} | From: ${hit.from || "(unknown)"} | Subject: ${hit.subject || "(no subject)"}`,
      `  Why: ${hit.reason}`,
      `  Snippet: ${hit.snippet || "(none)"}`
    );
  }
  lines.push(
    "",
    "Write ONE short digest message for the user, then publish a digest card with gmail_publish_digest covering these threads (at most 5 items, with a one-line gist each).",
    "Do not send mail without an explicit user request; agent-prepared drafts must stay in review on a compose card."
  );
  if (overflowNote) lines.push("", overflowNote);
  return lines.join("\n");
}

export interface WakeQueueDeps {
  sql: SqlStorage;
  now?: () => number;
}

/** SQL-backed queue + rate-cap bookkeeping for attention wake turns. */
export class WakeQueue {
  constructor(private readonly deps: WakeQueueDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  enqueue(channelId: string, event: GmailAttentionEvent, decision: GmailAttentionDecision): void {
    this.deps.sql.exec(
      `INSERT OR REPLACE INTO gmail_attention_queue
       (channel_id, thread_id, directive_id, from_addr, to_addr, subject, snippet, reason, actions_json, enqueued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      channelId,
      event.threadId,
      decision.directiveId ?? "unknown",
      event.from,
      event.to,
      event.subject,
      event.snippet,
      decision.reason ?? decision.directiveName ?? decision.directiveId ?? "attention rule",
      JSON.stringify(decision.actions ?? ["surface"]),
      this.now()
    );
  }

  queued(channelId: string): QueuedAttentionHit[] {
    return this.deps.sql
      .exec(
        `SELECT * FROM gmail_attention_queue WHERE channel_id = ? ORDER BY enqueued_at ASC`,
        channelId
      )
      .toArray()
      .map((row) => ({
        threadId: String(row["thread_id"]),
        directiveId: String(row["directive_id"]),
        from: String(row["from_addr"]),
        to: String(row["to_addr"]),
        subject: String(row["subject"]),
        snippet: String(row["snippet"]),
        reason: String(row["reason"]),
        actions: parseActions(row["actions_json"]),
        enqueuedAt: Number(row["enqueued_at"] ?? 0),
      }));
  }

  queuedCount(channelId: string): number {
    const row = this.deps.sql
      .exec(`SELECT COUNT(*) AS count FROM gmail_attention_queue WHERE channel_id = ?`, channelId)
      .toArray()[0];
    return Number(row?.["count"] ?? 0);
  }

  decision(channelId: string, now = this.now()): WakeDecision {
    const oldest = this.deps.sql
      .exec(
        `SELECT MIN(enqueued_at) AS oldest FROM gmail_attention_queue WHERE channel_id = ?`,
        channelId
      )
      .toArray()[0];
    const oldestEnqueuedAt =
      oldest && oldest["oldest"] !== null ? Number(oldest["oldest"]) : undefined;
    const recentTurnTimestamps = this.deps.sql
      .exec(
        `SELECT started_at FROM gmail_wake_turns WHERE channel_id = ? AND started_at > ?`,
        channelId,
        now - WAKE_CAP_WINDOW_MS
      )
      .toArray()
      .map((row) => Number(row["started_at"]));
    return computeWakeDecision({
      queuedCount: this.queuedCount(channelId),
      oldestEnqueuedAt,
      recentTurnTimestamps,
      now,
    });
  }

  /** Exact next wake implied by the durable queue and hourly cap. */
  nextWakeAt(channelId: string, now = this.now()): number | undefined {
    const decision = this.decision(channelId, now);
    switch (decision.kind) {
      case "idle":
        return undefined;
      case "wait":
        return decision.deadline;
      case "capped":
        return decision.retryAt;
      case "turn":
        return now + 1000;
    }
  }

  /** Remove and return all queued hits, recording the wake turn for the cap. */
  drain(channelId: string, now = this.now()): QueuedAttentionHit[] {
    const hits = this.queued(channelId);
    this.deps.sql.exec(`DELETE FROM gmail_attention_queue WHERE channel_id = ?`, channelId);
    this.deps.sql.exec(
      `DELETE FROM gmail_wake_turns WHERE channel_id = ? AND started_at <= ?`,
      channelId,
      now - WAKE_CAP_WINDOW_MS
    );
    this.deps.sql.exec(
      `INSERT INTO gmail_wake_turns (channel_id, started_at) VALUES (?, ?)`,
      channelId,
      now
    );
    return hits;
  }
}

function parseActions(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : ["surface"];
  } catch {
    return ["surface"];
  }
}
