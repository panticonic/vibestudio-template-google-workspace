/**
 * FeedbackIngest — durable intake for `ui.feedback` events targeting this
 * agent (render failures, invalid card state, expired method calls, …).
 *
 * Design constraints:
 * - **Deduped**: render errors fire per-mount; `occurrenceKey` collapses
 *   repeats (with a TTL so a recurring failure resurfaces eventually).
 * - **Never mints a turn**: feedback is queued and prepended to the agent's
 *   next turn input as a diagnostic note — a feedback storm can never spin
 *   the agent by itself. If a turn is already running, the vessel may steer
 *   the note into it instead.
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import type { UiFeedbackPayload } from "@workspace/agentic-protocol";

const DEDUPE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PER_CHANNEL = 20;

export class FeedbackIngest {
  constructor(
    private readonly sql: SqlStorage,
    private readonly now: () => number = () => Date.now()
  ) {
    FeedbackIngest.createTables(sql);
  }

  static createTables(sql: SqlStorage): void {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS feedback_seen (
        occurrence_key TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        note TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  }

  /** Record a feedback payload for the agent's next turn, unless deduplicated. */
  ingest(channelId: string, payload: UiFeedbackPayload): void {
    const ts = this.now();
    this.sql.exec(`DELETE FROM feedback_seen WHERE created_at < ?`, ts - DEDUPE_TTL_MS);
    const seen = this.sql
      .exec(`SELECT 1 FROM feedback_seen WHERE occurrence_key = ?`, payload.occurrenceKey)
      .toArray();
    if (seen.length > 0) return;
    this.sql.exec(
      `INSERT OR REPLACE INTO feedback_seen (occurrence_key, created_at) VALUES (?, ?)`,
      payload.occurrenceKey,
      ts
    );
    this.enqueue(channelId, formatFeedbackNote(payload));
  }

  /** Queue a note for the next turn on this channel (bounded). */
  private enqueue(channelId: string, note: string): void {
    this.sql.exec(
      `INSERT INTO pending_feedback (channel_id, note, created_at) VALUES (?, ?, ?)`,
      channelId,
      note,
      this.now()
    );
    // Bound the queue: keep only the newest entries.
    this.sql.exec(
      `DELETE FROM pending_feedback
       WHERE channel_id = ? AND id NOT IN (
         SELECT id FROM pending_feedback WHERE channel_id = ?
         ORDER BY id DESC LIMIT ?
       )`,
      channelId,
      channelId,
      MAX_PENDING_PER_CHANNEL
    );
  }

  /** Drain queued notes for a channel (consumed into the next turn input). */
  consume(channelId: string): string[] {
    const rows = this.sql
      .exec(`SELECT id, note FROM pending_feedback WHERE channel_id = ? ORDER BY id ASC`, channelId)
      .toArray();
    if (rows.length === 0) return [];
    this.sql.exec(`DELETE FROM pending_feedback WHERE channel_id = ?`, channelId);
    return rows.map((row) => String(row["note"]));
  }
}

export function formatFeedbackNote(payload: UiFeedbackPayload): string {
  const refs = payload.refs ?? {};
  const where = [
    refs.typeId ? `type ${refs.typeId}` : null,
    refs.messageId ? `card ${refs.messageId}` : null,
    refs.callId ? `call ${refs.callId}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const category =
    payload.category === "render_failed"
      ? "A UI component you published failed to render"
      : payload.category === "state_invalid"
        ? "A card you published has state that fails its registered schema"
        : payload.category === "type_not_registered"
          ? "A card you published references an unregistered message type"
          : payload.category === "method_call_failed"
            ? "A method call you were handling failed or expired"
            : payload.category === "load_stalled"
              ? "A card you published is stuck loading in the panel (its renderer never compiled)"
              : "A suspended wait timed out";
  return [
    `[ui-feedback] ${category}${where ? ` (${where})` : ""}.`,
    `Error: ${payload.error.message}`,
    `Fix the underlying problem or tell the user what went wrong; do not ignore this.`,
  ].join("\n");
}
