import type { SqlStorage } from "@workspace/runtime/worker";
import type { GmailThreadCardState } from "@workspace/gmail/card-types";
import type { failureResult } from "./errors.js";
import type { GmailHandlers } from "./agent/handlers.js";
import type { SyncEngine } from "./sync/sync-engine.js";
import { normalizeEmailAddress, threadCardFromRow } from "./sync/thread-model.js";
import { numberArg, stringArg, type GmailChannelState, type GmailThreadStateRow } from "./types.js";

export interface GmailParticipantApiDeps {
  sql: SqlStorage;
  handlers: GmailHandlers;
  sync: SyncEngine;
  getChannelState: (channelId: string) => GmailChannelState;
}

export interface GmailOverview {
  email?: string;
  unread: number;
  inbox: number;
  needsAttentionCount: number;
  lastSyncAt?: string;
  lastError?: string;
  authStatus: "ok" | "reconnect-required";
  actionable: GmailThreadCardState[];
}

/**
 * Read-mostly agent-to-agent surface. Other agents may inspect mail state and
 * request review-state drafts, but can never send mail: sending requires the
 * user's Send click on the compose card or an explicit user instruction to
 * the Gmail agent.
 */
export class GmailParticipantApi {
  constructor(private readonly deps: GmailParticipantApiDeps) {}

  /**
   * Cache-first thread search; falls back to the Gmail API on a cache miss.
   * Returns the same summary shape as the gmail_search tool so callers can
   * act on results uniformly ({ threadId, subject, from, snippet, unread,
   * date }); use gmail_getThread for full contents.
   */
  async query(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<
    | { source: "cache" | "api"; query: string; count: number; results: GmailQueryResult[] }
    | ReturnType<typeof failureResult>
  > {
    const q = stringArg(args, "q");
    if (!q) throw new Error("gmail_query requires q");
    const maxResults = Math.max(1, Math.min(numberArg(args, "maxResults") ?? 10, 25));
    const like = `%${q.replace(/[%_]/g, " ")}%`;
    const rows = this.deps.sql
      .exec(
        `SELECT * FROM gmail_threads
         WHERE channel_id = ? AND (subject LIKE ? OR from_addr LIKE ? OR snippet LIKE ?)
         ORDER BY updated_at DESC
         LIMIT ?`,
        channelId,
        like,
        like,
        like,
        maxResults
      )
      .toArray() as unknown as GmailThreadStateRow[];
    if (rows.length > 0) {
      const results = rows.map((row) => summarizeThreadCard(threadCardFromRow(row)));
      return { source: "cache", query: q, count: results.length, results };
    }
    // Agent-to-agent lookups are silent: no search card in the channel.
    const result = await this.deps.handlers.search(channelId, {
      q,
      limit: maxResults,
      mirrorToCard: false,
    });
    if ("error" in result) return result;
    return {
      source: "api",
      query: q,
      count: result.results.length,
      results: result.results,
    };
  }

  getThread(channelId: string, args: Record<string, unknown>) {
    return this.deps.handlers.readMail(channelId, {
      threadId: stringArg(args, "threadId"),
      format: "full",
      includeAttachmentList: true,
    });
  }

  getOverview(channelId: string, needsAttentionCount: number): GmailOverview {
    const state = this.deps.getChannelState(channelId);
    const counts =
      this.deps.sql
        .exec(
          `SELECT
             SUM(CASE WHEN unread = 1 THEN 1 ELSE 0 END) AS unread,
             SUM(CASE WHEN in_inbox = 1 THEN 1 ELSE 0 END) AS inbox
           FROM gmail_threads WHERE channel_id = ?`,
          channelId
        )
        .toArray()[0] ?? {};
    return {
      email: state.emailAddress,
      unread: Number(counts["unread"] ?? 0),
      inbox: Number(counts["inbox"] ?? 0),
      needsAttentionCount,
      ...(state.lastSyncAt ? { lastSyncAt: new Date(state.lastSyncAt).toISOString() } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
      authStatus: state.syncState === "auth-needed" ? "reconnect-required" : "ok",
      actionable: this.deps.sync.listActionableThreads(channelId, 8),
    };
  }

  /** Prepare mail on behalf of another agent — always review, never send. */
  requestDraft(channelId: string, args: Record<string, unknown>) {
    return this.deps.handlers.requestDraft(channelId, args);
  }

  /** Read-only contact resolution for other agents (same handler surface). */
  resolveContact(channelId: string, args: Record<string, unknown>) {
    return this.deps.handlers.resolveContact(channelId, args);
  }
}

export interface GmailQueryResult {
  threadId: string;
  subject: string;
  /** Raw From header display string. */
  from?: string;
  /** Parsed bare address from the From header. */
  fromEmail?: string;
  snippet: string;
  unread: boolean;
  date?: string;
}

function summarizeThreadCard(card: GmailThreadCardState): GmailQueryResult {
  return {
    threadId: card.threadId,
    subject: card.subject,
    ...(card.from ? { from: card.from } : {}),
    ...(normalizeEmailAddress(card.from) ? { fromEmail: normalizeEmailAddress(card.from) } : {}),
    snippet: card.lastSnippet,
    unread: card.unreadCount > 0,
    date: new Date(card.updatedAt).toISOString(),
  };
}
