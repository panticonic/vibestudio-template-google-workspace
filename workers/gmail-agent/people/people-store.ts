import type { SqlStorage } from "@workspace/runtime/worker";
import type { ParsedAddress } from "./address.js";

export interface PersonCandidate {
  email: string;
  displayName?: string;
  sentTo: number;
  receivedFrom: number;
  lastInteractionAt?: number;
  youReplied: boolean;
  score: number;
}

interface PeopleRow {
  email: string;
  display_name: string | null;
  sent_to_count: number;
  received_from_count: number;
  last_interaction_at: number | null;
  you_replied: number;
}

const RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const RECENCY_BONUS = 5;

export interface PeopleStoreDeps {
  sql: SqlStorage;
  now?: () => number;
}

/**
 * Derived per-channel address book harvested from synced mail headers.
 * Ranking favors people the user writes to (and especially replies to),
 * with a small recency bonus — see scoreRow.
 */
export class PeopleStore {
  constructor(private readonly deps: PeopleStoreDeps) {}

  private get sql(): SqlStorage {
    return this.deps.sql;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private ensureRow(channelId: string, email: string): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO gmail_people (channel_id, email) VALUES (?, ?)`,
      channelId,
      email
    );
  }

  /** Prefer a real display name over none / an email-shaped placeholder. */
  private upgradeDisplayName(channelId: string, email: string, name: string | undefined): void {
    if (!name || name.includes("@")) return;
    this.sql.exec(
      `UPDATE gmail_people SET display_name = ?
       WHERE channel_id = ? AND email = ?
         AND (display_name IS NULL OR display_name = '' OR display_name LIKE '%@%'
              OR LENGTH(?) > LENGTH(display_name))`,
      name,
      channelId,
      email,
      name
    );
  }

  recordIncoming(channelId: string, entry: { email: string; name?: string; at: number }): void {
    const email = entry.email.toLowerCase();
    this.ensureRow(channelId, email);
    this.sql.exec(
      `UPDATE gmail_people SET
         received_from_count = received_from_count + 1,
         last_interaction_at = MAX(COALESCE(last_interaction_at, 0), ?)
       WHERE channel_id = ? AND email = ?`,
      entry.at,
      channelId,
      email
    );
    this.upgradeDisplayName(channelId, email, entry.name);
  }

  recordOutgoing(channelId: string, recipients: ParsedAddress[], at: number): void {
    for (const recipient of recipients) {
      const email = recipient.email.toLowerCase();
      this.ensureRow(channelId, email);
      this.sql.exec(
        `UPDATE gmail_people SET
           sent_to_count = sent_to_count + 1,
           last_interaction_at = MAX(COALESCE(last_interaction_at, 0), ?)
         WHERE channel_id = ? AND email = ?`,
        at,
        channelId,
        email
      );
      this.upgradeDisplayName(channelId, email, recipient.name);
    }
  }

  markReplied(channelId: string, email: string): void {
    const normalized = email.toLowerCase();
    this.ensureRow(channelId, normalized);
    this.sql.exec(
      `UPDATE gmail_people SET you_replied = 1 WHERE channel_id = ? AND email = ?`,
      channelId,
      normalized
    );
  }

  count(channelId: string): number {
    const row = this.sql
      .exec(`SELECT COUNT(*) AS n FROM gmail_people WHERE channel_id = ?`, channelId)
      .toArray()[0];
    return Number(row?.["n"] ?? 0);
  }

  private scoreRow(row: PeopleRow): number {
    const recency =
      row.last_interaction_at && this.now() - Number(row.last_interaction_at) <= RECENCY_WINDOW_MS
        ? RECENCY_BONUS
        : 0;
    return (
      Number(row.sent_to_count) * 3 +
      Number(row.received_from_count) +
      (Number(row.you_replied) === 1 ? 10 : 0) +
      recency
    );
  }

  private toCandidate(row: PeopleRow): PersonCandidate {
    return {
      email: String(row.email),
      ...(row.display_name ? { displayName: String(row.display_name) } : {}),
      sentTo: Number(row.sent_to_count),
      receivedFrom: Number(row.received_from_count),
      ...(row.last_interaction_at ? { lastInteractionAt: Number(row.last_interaction_at) } : {}),
      youReplied: Number(row.you_replied) === 1,
      score: this.scoreRow(row),
    };
  }

  private rows(channelId: string, where: string, params: unknown[]): PeopleRow[] {
    return this.sql
      .exec(
        `SELECT email, display_name, sent_to_count, received_from_count, last_interaction_at, you_replied
         FROM gmail_people WHERE channel_id = ? AND (${where})`,
        channelId,
        ...params
      )
      .toArray() as unknown as PeopleRow[];
  }

  /** Fast prefix/substring typeahead over email and display name. */
  suggest(channelId: string, prefix: string, limit = 8): PersonCandidate[] {
    const needle = prefix.trim().toLowerCase().replace(/[%_]/g, " ");
    if (!needle) return [];
    const rows = this.rows(channelId, `email LIKE ? OR LOWER(COALESCE(display_name, '')) LIKE ?`, [
      `${needle}%`,
      `%${needle}%`,
    ]);
    return rows
      .map((row) => this.toCandidate(row))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(limit, 20)));
  }

  /**
   * Fuzzy-ish name resolution: every query token must hit the display name
   * or the email local part (case-insensitive substring).
   */
  resolve(channelId: string, name: string, limit = 5): PersonCandidate[] {
    const tokens = name
      .toLowerCase()
      .split(/[\s,;]+/)
      .map((token) => token.replace(/[%_]/g, " ").trim())
      .filter(Boolean);
    if (tokens.length === 0) return [];
    const where = tokens
      .map(
        () =>
          `(LOWER(COALESCE(display_name, '')) LIKE ? OR SUBSTR(email, 1, INSTR(email, '@') - 1) LIKE ?)`
      )
      .join(" AND ");
    const params = tokens.flatMap((token) => [`%${token}%`, `%${token}%`]);
    return this.rows(channelId, where, params)
      .map((row) => this.toCandidate(row))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(limit, 10)));
  }
}
