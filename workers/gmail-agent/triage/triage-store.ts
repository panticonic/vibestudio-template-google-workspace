import type { SqlStorage } from "@workspace/runtime/worker";
import type {
  GmailAttentionAction,
  GmailAttentionDecision,
  GmailAttentionHit,
  GmailAttentionPrefs,
} from "@workspace/gmail/card-types";
import { DEFAULT_ATTENTION_PREFERENCES } from "../schema.js";
import { normalizeEmailAddress, type GmailAttentionEvent } from "../sync/thread-model.js";

const ATTENTION_ACTIONS = ["surface", "summarize", "draft", "archive", "markRead"] as const;

export function parseActionsJson(value: unknown): GmailAttentionAction[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is GmailAttentionAction =>
          (ATTENTION_ACTIONS as readonly string[]).includes(String(item))
        )
      : ["surface"];
  } catch {
    return ["surface"];
  }
}

/** A new-mail candidate queued for the batched LLM triage pass. */
export interface TriageCandidate {
  channelId: string;
  threadId: string;
  messageId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  labels: string[];
  category?: string;
  priorReply: boolean;
  enqueuedAt: number;
  attempts: number;
}

export interface TriageStoreDeps {
  sql: SqlStorage;
  now?: () => number;
}

/**
 * Persistence layer for triage state: natural-language attention preferences,
 * surfaced hits, replied-sender memory, turn dedup, the triage candidate
 * queue, and run-rate bookkeeping.
 */
export class TriageStore {
  constructor(private readonly deps: TriageStoreDeps) {}

  private get sql(): SqlStorage {
    return this.deps.sql;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  // ── attention preferences ─────────────────────────────────────────────────

  getPrefs(channelId: string): GmailAttentionPrefs & { triageModel?: string } {
    const row = this.sql
      .exec(`SELECT * FROM gmail_attention_prefs WHERE channel_id = ?`, channelId)
      .toArray()[0];
    if (!row) {
      return {
        preferencesText: DEFAULT_ATTENTION_PREFERENCES,
        knownSenderShortcut: true,
        updatedAt: 0,
      };
    }
    return {
      preferencesText: String(row["preferences_text"]),
      knownSenderShortcut: Number(row["known_sender_shortcut"] ?? 1) === 1,
      ...(row["triage_model"] ? { triageModel: String(row["triage_model"]) } : {}),
      updatedAt: Number(row["updated_at"] ?? 0),
    };
  }

  /** Whether the user has explicitly saved preferences. */
  hasSavedPrefs(channelId: string): boolean {
    return (
      this.sql
        .exec(`SELECT channel_id FROM gmail_attention_prefs WHERE channel_id = ?`, channelId)
        .toArray().length > 0
    );
  }

  setPrefs(
    channelId: string,
    prefs: { preferencesText: string; knownSenderShortcut?: boolean; triageModel?: string }
  ): GmailAttentionPrefs {
    const current = this.getPrefs(channelId);
    const next = {
      preferencesText: prefs.preferencesText.slice(0, 4000),
      knownSenderShortcut: prefs.knownSenderShortcut ?? current.knownSenderShortcut,
      triageModel: prefs.triageModel ?? current.triageModel,
      updatedAt: this.now(),
    };
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_attention_prefs
       (channel_id, preferences_text, known_sender_shortcut, triage_model, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      channelId,
      next.preferencesText,
      next.knownSenderShortcut ? 1 : 0,
      next.triageModel ?? null,
      next.updatedAt
    );
    return next;
  }

  // ── surfaced hits ─────────────────────────────────────────────────────────

  recordHit(channelId: string, threadId: string, decision: GmailAttentionDecision): void {
    if (!decision.wake || !decision.directiveId || !decision.directiveName) return;
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_attention_hits
       (channel_id, thread_id, directive_id, directive_name, reason, actions_json, matched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      channelId,
      threadId,
      decision.directiveId,
      decision.directiveName,
      decision.reason ?? decision.directiveName,
      JSON.stringify(decision.actions ?? ["surface"]),
      this.now()
    );
  }

  clearHits(channelId: string): void {
    this.sql.exec(`DELETE FROM gmail_attention_hits WHERE channel_id = ?`, channelId);
  }

  hits(channelId: string, limit = 8): GmailAttentionHit[] {
    const rows = this.sql
      .exec(
        `SELECT * FROM gmail_attention_hits
         WHERE channel_id = ?
         ORDER BY matched_at DESC
         LIMIT ?`,
        channelId,
        Math.max(1, Math.min(limit, 50))
      )
      .toArray();
    return rows.map((row) => ({
      threadId: String(row["thread_id"]),
      directiveId: String(row["directive_id"]),
      directiveName: String(row["directive_name"]),
      reason: String(row["reason"]),
      actions: parseActionsJson(row["actions_json"]),
      matchedAt: Number(row["matched_at"] ?? 0),
    }));
  }

  hitForThread(channelId: string, threadId: string): GmailAttentionHit | null {
    const row = this.sql
      .exec(
        `SELECT * FROM gmail_attention_hits
         WHERE channel_id = ? AND thread_id = ?
         ORDER BY matched_at DESC
         LIMIT 1`,
        channelId,
        threadId
      )
      .toArray()[0];
    return row
      ? {
          threadId,
          directiveId: String(row["directive_id"]),
          directiveName: String(row["directive_name"]),
          reason: String(row["reason"]),
          actions: parseActionsJson(row["actions_json"]),
          matchedAt: Number(row["matched_at"] ?? 0),
        }
      : null;
  }

  // ── replied-sender memory ─────────────────────────────────────────────────

  recordRepliedSender(
    channelId: string,
    email: string | undefined,
    display: string | undefined,
    source: "sent-mail" | "send"
  ): void {
    if (!email) return;
    const now = this.now();
    this.sql.exec(
      `INSERT INTO gmail_replied_senders
       (channel_id, email, display, first_replied_at, last_replied_at, source)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, email) DO UPDATE SET
         display = COALESCE(excluded.display, gmail_replied_senders.display),
         last_replied_at = excluded.last_replied_at,
         source = excluded.source`,
      channelId,
      email.toLowerCase(),
      display ?? null,
      now,
      now,
      source
    );
  }

  hasRepliedToSender(channelId: string, from: string): boolean {
    const email = normalizeEmailAddress(from);
    if (!email) return false;
    const row = this.sql
      .exec(
        `SELECT email FROM gmail_replied_senders WHERE channel_id = ? AND email = ? LIMIT 1`,
        channelId,
        email
      )
      .toArray()[0];
    return Boolean(row);
  }

  /**
   * Turn dedup: returns true (and records the message key) only the first
   * time a given source surfaces a given thread message.
   */
  shouldStartTurn(channelId: string, event: GmailAttentionEvent, sourceId: string): boolean {
    if (!event.unread || !event.inInbox) return false;
    const messageKey = event.messageId ?? String(event.internalDate ?? "unknown");
    const row = this.sql
      .exec(
        `SELECT last_message_id FROM gmail_attention_turns
         WHERE channel_id = ? AND thread_id = ? AND directive_id = ?`,
        channelId,
        event.threadId,
        sourceId
      )
      .toArray()[0];
    if (String(row?.["last_message_id"] ?? "") === messageKey) return false;
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_attention_turns
       (channel_id, thread_id, directive_id, last_message_id, started_at)
       VALUES (?, ?, ?, ?, ?)`,
      channelId,
      event.threadId,
      sourceId,
      messageKey,
      this.now()
    );
    return true;
  }

  // ── triage candidate queue ────────────────────────────────────────────────

  enqueueCandidate(channelId: string, event: GmailAttentionEvent): void {
    // Re-syncing the same message refreshes its metadata but keeps the
    // original enqueued_at — otherwise a busy mailbox could reset candidate
    // age every poll and starve the triage pass.
    this.sql.exec(
      `INSERT INTO gmail_triage_queue
       (channel_id, thread_id, message_id, from_addr, to_addr, subject, snippet, labels_json, category, prior_reply, enqueued_at, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(channel_id, thread_id, message_id) DO UPDATE SET
         from_addr = excluded.from_addr,
         to_addr = excluded.to_addr,
         subject = excluded.subject,
         snippet = excluded.snippet,
         labels_json = excluded.labels_json,
         category = excluded.category,
         prior_reply = excluded.prior_reply`,
      channelId,
      event.threadId,
      event.messageId ?? String(event.internalDate ?? "unknown"),
      event.from.slice(0, 300),
      event.to.slice(0, 300),
      event.subject.slice(0, 200),
      event.snippet.slice(0, 200),
      JSON.stringify(event.labels.slice(0, 20)),
      event.category ?? null,
      event.priorReplyToSender ? 1 : 0,
      this.now()
    );
  }

  pendingCandidates(channelId: string, limit: number): TriageCandidate[] {
    return this.sql
      .exec(
        `SELECT * FROM gmail_triage_queue
         WHERE channel_id = ?
         ORDER BY enqueued_at ASC
         LIMIT ?`,
        channelId,
        Math.max(1, limit)
      )
      .toArray()
      .map((row) => ({
        channelId,
        threadId: String(row["thread_id"]),
        messageId: String(row["message_id"]),
        from: String(row["from_addr"]),
        to: String(row["to_addr"]),
        subject: String(row["subject"]),
        snippet: String(row["snippet"]),
        labels: parseLabels(row["labels_json"]),
        ...(row["category"] ? { category: String(row["category"]) } : {}),
        priorReply: Number(row["prior_reply"] ?? 0) === 1,
        enqueuedAt: Number(row["enqueued_at"] ?? 0),
        attempts: Number(row["attempts"] ?? 0),
      }));
  }

  channelsWithPendingCandidates(): string[] {
    return this.sql
      .exec(`SELECT DISTINCT channel_id FROM gmail_triage_queue`)
      .toArray()
      .map((row) => String(row["channel_id"]));
  }

  oldestCandidateAt(channelId: string): number | undefined {
    const row = this.sql
      .exec(
        `SELECT MIN(enqueued_at) AS oldest FROM gmail_triage_queue WHERE channel_id = ?`,
        channelId
      )
      .toArray()[0];
    return row && row["oldest"] !== null ? Number(row["oldest"]) : undefined;
  }

  removeCandidate(channelId: string, threadId: string, messageId: string): void {
    this.sql.exec(
      `DELETE FROM gmail_triage_queue WHERE channel_id = ? AND thread_id = ? AND message_id = ?`,
      channelId,
      threadId,
      messageId
    );
  }

  bumpCandidateAttempts(channelId: string, candidates: TriageCandidate[]): void {
    for (const candidate of candidates) {
      this.sql.exec(
        `UPDATE gmail_triage_queue SET attempts = attempts + 1
         WHERE channel_id = ? AND thread_id = ? AND message_id = ?`,
        channelId,
        candidate.threadId,
        candidate.messageId
      );
    }
  }

  // ── snoozed-thread reminders ──────────────────────────────────────────────

  setReminder(
    channelId: string,
    reminder: { threadId: string; remindAt: number; note?: string; subject?: string; from?: string }
  ): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_reminders
       (channel_id, thread_id, remind_at, note, subject, from_addr, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      channelId,
      reminder.threadId,
      reminder.remindAt,
      reminder.note ?? null,
      reminder.subject ?? null,
      reminder.from ?? null,
      this.now()
    );
  }

  listReminders(channelId: string): Array<{
    threadId: string;
    remindAt: number;
    note?: string;
    subject?: string;
    from?: string;
  }> {
    return this.sql
      .exec(
        `SELECT * FROM gmail_reminders WHERE channel_id = ? ORDER BY remind_at ASC`,
        channelId
      )
      .toArray()
      .map((row) => ({
        threadId: String(row["thread_id"]),
        remindAt: Number(row["remind_at"]),
        ...(row["note"] ? { note: String(row["note"]) } : {}),
        ...(row["subject"] ? { subject: String(row["subject"]) } : {}),
        ...(row["from_addr"] ? { from: String(row["from_addr"]) } : {}),
      }));
  }

  /** Remove and return all due reminders across channels. */
  drainDueReminders(now: number): Array<{
    channelId: string;
    threadId: string;
    remindAt: number;
    note?: string;
    subject?: string;
    from?: string;
  }> {
    const due = this.sql
      .exec(`SELECT * FROM gmail_reminders WHERE remind_at <= ?`, now)
      .toArray()
      .map((row) => ({
        channelId: String(row["channel_id"]),
        threadId: String(row["thread_id"]),
        remindAt: Number(row["remind_at"]),
        ...(row["note"] ? { note: String(row["note"]) } : {}),
        ...(row["subject"] ? { subject: String(row["subject"]) } : {}),
        ...(row["from_addr"] ? { from: String(row["from_addr"]) } : {}),
      }));
    this.sql.exec(`DELETE FROM gmail_reminders WHERE remind_at <= ?`, now);
    return due;
  }

  deleteReminder(channelId: string, threadId: string): boolean {
    const existing = this.sql
      .exec(
        `SELECT thread_id FROM gmail_reminders WHERE channel_id = ? AND thread_id = ?`,
        channelId,
        threadId
      )
      .toArray();
    if (existing.length === 0) return false;
    this.sql.exec(
      `DELETE FROM gmail_reminders WHERE channel_id = ? AND thread_id = ?`,
      channelId,
      threadId
    );
    return true;
  }

  nextReminderAt(): number | undefined {
    const row = this.sql.exec(`SELECT MIN(remind_at) AS next FROM gmail_reminders`).toArray()[0];
    return row && row["next"] !== null ? Number(row["next"]) : undefined;
  }

  // ── triage run rate bookkeeping ───────────────────────────────────────────

  recordRun(channelId: string, candidates: number, outcome: "ok" | "fallback" | "error"): void {
    const now = this.now();
    this.sql.exec(
      `DELETE FROM gmail_triage_runs WHERE channel_id = ? AND started_at <= ?`,
      channelId,
      now - 60 * 60 * 1000
    );
    this.sql.exec(
      `INSERT INTO gmail_triage_runs (channel_id, started_at, candidates, outcome) VALUES (?, ?, ?, ?)`,
      channelId,
      now,
      candidates,
      outcome
    );
  }

  runsInLastHour(channelId: string): number {
    const row = this.sql
      .exec(
        `SELECT COUNT(*) AS count FROM gmail_triage_runs WHERE channel_id = ? AND started_at > ?`,
        channelId,
        this.now() - 60 * 60 * 1000
      )
      .toArray()[0];
    return Number(row?.["count"] ?? 0);
  }
}

function parseLabels(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
