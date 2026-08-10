import type { SqlStorage } from "@workspace/runtime/worker";
import { isGmailApiError, type GmailClient, type GmailThread } from "@workspace/gmail";
import type { GmailAttentionDecision, GmailThreadCardState } from "@workspace/gmail/card-types";
import { handleGmailError, type GmailFailure } from "../errors.js";
import type { TriageEngine } from "../triage/triage-engine.js";
import type { TriageStore } from "../triage/triage-store.js";
import type { GmailCards } from "../cards/cards.js";
import { parseAddressEntries } from "../people/address.js";
import type { PeopleStore } from "../people/people-store.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  INITIAL_THREAD_LOAD_LIMIT,
  type GmailChannelState,
  type GmailThreadStateRow,
} from "../types.js";
import {
  METADATA_HEADERS,
  attentionEventFromThread,
  header,
  threadCardFromRow,
  threadCardState,
} from "./thread-model.js";

const MAX_TRANSIENT_RETRIES = 2;
const RATE_LIMIT_BASE_BACKOFF_MS = 60_000;
const RATE_LIMIT_MAX_BACKOFF_MS = 15 * 60 * 1000;

// NOTE: Gmail push notifications (users.watch → Cloud Pub/Sub) would replace
// this polling loop entirely, but they require a GCP topic the deployment
// does not have. History-based incremental polling stays for now.

export type SyncResult =
  | { ok: true; historyId: string; threadsUpdated: number }
  | { ok: false; error: GmailFailure };

export interface SyncEngineDeps {
  sql: SqlStorage;
  gmailFor: (channelId: string) => GmailClient;
  triage: TriageEngine;
  store: TriageStore;
  people: PeopleStore;
  cards: GmailCards;
  getChannelState: (channelId: string) => GmailChannelState;
  saveChannelState: (state: GmailChannelState) => void;
  publishSetup: (channelId: string) => Promise<void>;
  now?: () => number;
}

/**
 * History-based incremental Gmail sync into the local thread cache. Thread
 * refreshes go through the multipart batch endpoint. Failure policy: auth
 * errors pause polling, rate limits back off, network/server errors retry
 * then surface lastError.
 */
export class SyncEngine {
  constructor(private readonly deps: SyncEngineDeps) {}

  private get sql(): SqlStorage {
    return this.deps.sql;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async syncChannel(channelId: string): Promise<SyncResult> {
    let attempt = 0;
    for (;;) {
      try {
        const result = await this.syncOnce(channelId);
        this.clearFailureState(channelId);
        await this.deps.publishSetup(channelId).catch(() => undefined);
        return result;
      } catch (err) {
        if (
          (isGmailApiError(err, "network") || isGmailApiError(err, "server")) &&
          attempt < MAX_TRANSIENT_RETRIES
        ) {
          attempt += 1;
          continue;
        }
        const failure = handleGmailError({ channelId, operation: "sync" }, err);
        if (!failure) throw err;
        await this.recordSyncFailure(channelId, failure);
        return { ok: false, error: failure };
      }
    }
  }

  private async syncOnce(
    channelId: string
  ): Promise<{ ok: true; historyId: string; threadsUpdated: number }> {
    const state = this.deps.getChannelState(channelId);
    const gmail = this.deps.gmailFor(channelId);
    if (!state.historyId) {
      const profile = await gmail.getProfile();
      state.historyId = profile.historyId;
      state.emailAddress = profile.emailAddress;
      state.lastSyncAt = this.now();
      state.lastError = undefined;
      this.deps.saveChannelState(state);
      await this.seedRepliedSendersFromSentMail(channelId).catch(() => undefined);
      await this.bootstrapRecentThreads(channelId, profile.emailAddress);
      return { ok: true, historyId: profile.historyId, threadsUpdated: 0 };
    }

    if (!state.emailAddress) {
      const profile = await gmail.getProfile();
      state.emailAddress = profile.emailAddress;
    }
    const diff = await gmail.syncSince(state.historyId);
    await this.refreshThreads(
      channelId,
      diff.threads.map((thread) => thread.threadId),
      state.emailAddress,
      { allowWake: true }
    );
    state.historyId = diff.historyId;
    state.lastSyncAt = this.now();
    state.lastError = undefined;
    this.deps.saveChannelState(state);
    return { ok: true, historyId: diff.historyId, threadsUpdated: diff.threads.length };
  }

  /** Apply the failure policy to persisted channel state + setup card. */
  private async recordSyncFailure(channelId: string, failure: GmailFailure): Promise<void> {
    const state = this.deps.getChannelState(channelId);
    state.lastSyncAt = this.now();
    if (failure.kind === "auth") {
      // Poll alarm scheduling skips auth-needed channels until checkNow succeeds.
      state.syncState = "auth-needed";
      state.lastError = failure.message;
    } else if (failure.kind === "rate-limited") {
      const backoff = Math.min(
        failure.retryAfterMs ?? Math.max((state.backoffMs ?? 0) * 2, RATE_LIMIT_BASE_BACKOFF_MS),
        RATE_LIMIT_MAX_BACKOFF_MS
      );
      state.backoffMs = backoff;
      state.rateLimitedUntil = this.now() + backoff;
    } else {
      state.lastError = failure.message;
    }
    this.deps.saveChannelState(state);
    await this.deps.publishSetup(channelId).catch(() => undefined);
  }

  private clearFailureState(channelId: string): void {
    const state = this.deps.getChannelState(channelId);
    if (
      state.syncState === "ok" &&
      state.rateLimitedUntil === undefined &&
      state.backoffMs === undefined &&
      state.lastError === undefined
    ) {
      return;
    }
    state.syncState = "ok";
    state.rateLimitedUntil = undefined;
    state.backoffMs = undefined;
    state.lastError = undefined;
    this.deps.saveChannelState(state);
  }

  async bootstrapRecentThreads(channelId: string, userEmail: string): Promise<void> {
    const gmail = this.deps.gmailFor(channelId);
    const result = await gmail.listMessages({
      maxResults: INITIAL_THREAD_LOAD_LIMIT,
      labelIds: ["INBOX"],
      format: "metadata",
      metadataHeaders: METADATA_HEADERS,
    });
    const threadIds = Array.from(
      new Set(
        result.messages
          .map((message) => message.threadId)
          .filter((threadId): threadId is string => Boolean(threadId))
      )
    );
    await this.refreshThreads(channelId, threadIds, userEmail);
  }

  async seedRepliedSendersFromSentMail(channelId: string): Promise<void> {
    const gmail = this.deps.gmailFor(channelId);
    const result = await gmail.search("in:sent", {
      maxResults: 50,
      format: "metadata",
      metadataHeaders: ["To", "Cc", "Bcc"],
    });
    for (const message of result.messages) {
      const at = Number(message.internalDate ?? 0) || this.now();
      for (const headerName of ["To", "Cc", "Bcc"]) {
        const entries = parseAddressEntries(header(message, headerName));
        // The same sent-mail pass backfills the derived people store.
        if (headerName !== "Bcc") this.deps.people.recordOutgoing(channelId, entries, at);
        for (const entry of entries) {
          this.deps.store.recordRepliedSender(channelId, entry.email, entry.email, "sent-mail");
          this.deps.people.markReplied(channelId, entry.email);
        }
      }
    }
  }

  /** Feed message headers into the derived people store during sync. */
  private harvestPeople(channelId: string, thread: GmailThread, userEmail?: string): void {
    const user = userEmail?.toLowerCase();
    for (const message of thread.messages ?? []) {
      const at = Number(message.internalDate ?? 0) || this.now();
      const from = parseAddressEntries(header(message, "From"))[0];
      const outgoing =
        (message.labelIds ?? []).includes("SENT") || (user !== undefined && from?.email === user);
      if (outgoing) {
        const recipients = [
          ...parseAddressEntries(header(message, "To")),
          ...parseAddressEntries(header(message, "Cc")),
        ].filter((entry) => entry.email !== user);
        this.deps.people.recordOutgoing(channelId, recipients, at);
      } else if (from && from.email !== user) {
        this.deps.people.recordIncoming(channelId, { email: from.email, name: from.name, at });
      }
    }
  }

  /**
   * Refresh many threads with one multipart batch call (chunked at 50 by the
   * client). Per-thread not-found reconciles locally as archived, exactly
   * like the single-thread path.
   */
  async refreshThreads(
    channelId: string,
    threadIds: string[],
    userEmail?: string,
    opts: { allowWake?: boolean } = {}
  ): Promise<GmailThreadCardState[]> {
    if (threadIds.length === 0) return [];
    const gmail = this.deps.gmailFor(channelId);
    const items = await gmail.batchGetThreads(threadIds, {
      format: "metadata",
      metadataHeaders: METADATA_HEADERS,
    });
    const cards: GmailThreadCardState[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const threadId = threadIds[index]!;
      if (item.error) {
        if (item.error.code === "not-found") {
          const archived = await this.reconcileMissingThread(channelId, threadId);
          if (archived) cards.push(archived);
          continue;
        }
        throw item.error;
      }
      cards.push(await this.ingestThread(channelId, item.value!, userEmail, opts));
    }
    return cards;
  }

  /** Single-thread refresh (openThread / post-send paths). */
  async refreshThread(
    channelId: string,
    threadId: string,
    userEmail?: string,
    opts: { allowWake?: boolean } = {}
  ): Promise<GmailThreadCardState> {
    const gmail = this.deps.gmailFor(channelId);
    let thread: GmailThread;
    try {
      thread = await gmail.getThread(threadId, {
        format: "metadata",
        metadataHeaders: METADATA_HEADERS,
      });
    } catch (err) {
      if (!isGmailApiError(err, "not-found")) throw err;
      const archived = await this.reconcileMissingThread(channelId, threadId);
      if (!archived) throw err;
      return archived;
    }
    return this.ingestThread(channelId, thread, userEmail, opts);
  }

  /** not-found: the thread vanished in Gmail; reconcile locally as archived. */
  private async reconcileMissingThread(
    channelId: string,
    threadId: string
  ): Promise<GmailThreadCardState | null> {
    const existing = this.threadRow(channelId, threadId);
    if (!existing) return null;
    const archived = threadCardFromRow({
      ...existing,
      unread: 0,
      in_inbox: 0,
      actionable: 0,
      updated_at: this.now(),
    });
    this.sql.exec(
      `UPDATE gmail_threads SET unread = 0, in_inbox = 0, actionable = 0, updated_at = ? WHERE channel_id = ? AND thread_id = ?`,
      archived.updatedAt,
      channelId,
      threadId
    );
    await this.deps.cards.updateThread(channelId, threadId, {
      kind: "statusChange",
      status: "archived",
    });
    return archived;
  }

  /** Shared post-fetch path: people harvest, triage routing, row + card upsert. */
  private async ingestThread(
    channelId: string,
    thread: GmailThread,
    userEmail?: string,
    opts: { allowWake?: boolean } = {}
  ): Promise<GmailThreadCardState> {
    const existing = this.threadRow(channelId, thread.id);
    this.harvestPeople(channelId, thread, userEmail);
    const event = attentionEventFromThread(thread, userEmail);
    let decision: GmailAttentionDecision | null = null;
    if (event && opts.allowWake) {
      event.priorReplyToSender = this.deps.store.hasRepliedToSender(channelId, event.from);
      decision = this.deps.triage.considerEvent(channelId, event);
    }
    const card = threadCardState(thread, existing?.category, userEmail, decision ?? undefined);
    this.upsertThreadRow(channelId, card);
    await this.deps.cards.updateThread(channelId, thread.id, card);
    return card;
  }

  /** Apply a deferred triage decision to the cached row + thread card. */
  async applyTriageDecision(
    channelId: string,
    threadId: string,
    decision: GmailAttentionDecision
  ): Promise<void> {
    const row = this.threadRow(channelId, threadId);
    if (!row) {
      // The thread the triage model decided to surface is not in the local
      // cache, so there is no row to flag actionable and no card to update —
      // the decision is effectively dropped. Log it instead of vanishing
      // silently so the divergence is visible.
      console.warn(
        `[gmail-agent] applyTriageDecision: no cached thread row channel=${channelId} thread=${threadId}; surface decision dropped`
      );
      return;
    }
    this.sql.exec(
      `UPDATE gmail_threads SET actionable = 1, updated_at = ? WHERE channel_id = ? AND thread_id = ?`,
      this.now(),
      channelId,
      threadId
    );
    const fresh = this.threadRow(channelId, threadId);
    if (fresh) {
      await this.deps.cards.updateThread(channelId, threadId, {
        ...threadCardFromRow(fresh),
        actionable: true,
        attention: decision,
      });
    }
  }

  private upsertThreadRow(channelId: string, card: GmailThreadCardState): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_threads
       (channel_id, thread_id, subject, from_addr, snippet, unread, in_inbox, actionable, category, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      channelId,
      card.threadId,
      card.subject,
      card.from,
      card.snippet,
      card.unread ? 1 : 0,
      card.inInbox ? 1 : 0,
      card.actionable ? 1 : 0,
      card.category ?? null,
      card.updatedAt
    );
  }

  threadRow(channelId: string, threadId: string): GmailThreadStateRow | null {
    return (
      (this.sql
        .exec(
          `SELECT * FROM gmail_threads WHERE channel_id = ? AND thread_id = ?`,
          channelId,
          threadId
        )
        .toArray()[0] as unknown as GmailThreadStateRow | undefined) ?? null
    );
  }

  listActionableThreads(channelId: string, limit: number): GmailThreadCardState[] {
    const rows = this.sql
      .exec(
        `SELECT * FROM gmail_threads
         WHERE channel_id = ? AND actionable = 1
         ORDER BY updated_at DESC
         LIMIT ?`,
        channelId,
        Math.max(1, Math.min(limit, 25))
      )
      .toArray() as unknown as GmailThreadStateRow[];
    return rows.map((row) =>
      threadCardFromRow(row, this.deps.store.hitForThread(channelId, row.thread_id))
    );
  }

  async applyLocalThreadFlags(
    channelId: string,
    threadId: string,
    flags: {
      unread?: boolean;
      inInbox?: boolean;
      actionable?: boolean;
      status?: GmailThreadCardState["status"];
    }
  ): Promise<void> {
    const existing = this.threadRow(channelId, threadId);
    if (!existing) return;
    this.sql.exec(
      `UPDATE gmail_threads
       SET unread = COALESCE(?, unread),
           in_inbox = COALESCE(?, in_inbox),
           actionable = COALESCE(?, actionable),
           updated_at = ?
       WHERE channel_id = ? AND thread_id = ?`,
      typeof flags.unread === "boolean" ? (flags.unread ? 1 : 0) : null,
      typeof flags.inInbox === "boolean" ? (flags.inInbox ? 1 : 0) : null,
      typeof flags.actionable === "boolean" ? (flags.actionable ? 1 : 0) : null,
      this.now(),
      channelId,
      threadId
    );
    const row = this.threadRow(channelId, threadId);
    if (row) {
      await this.deps.cards.updateThread(channelId, threadId, {
        ...threadCardFromRow(row),
        ...(flags.status ? { status: flags.status } : {}),
      });
    }
  }

  /**
   * Re-enqueue stored unread inbox threads into the triage queue (after a
   * preference change). Works from the local cache — no Gmail re-fetch.
   */
  retriageStoredThreads(channelId: string): number {
    this.deps.store.clearHits(channelId);
    const rows = this.sql
      .exec(
        `SELECT * FROM gmail_threads WHERE channel_id = ? AND unread = 1 AND in_inbox = 1`,
        channelId
      )
      .toArray() as unknown as GmailThreadStateRow[];
    for (const row of rows) {
      this.deps.store.enqueueCandidate(channelId, {
        threadId: row.thread_id,
        messageId: `retriage-${row.updated_at}`,
        from: row.from_addr,
        to: "",
        subject: row.subject,
        snippet: row.snippet,
        labels: ["INBOX", "UNREAD"],
        ...(row.category ? { category: row.category } : {}),
        hasAttachment: false,
        priorReplyToSender: this.deps.store.hasRepliedToSender(channelId, row.from_addr),
        unread: true,
        inInbox: true,
        addressedToUser: true,
      });
    }
    return rows.length;
  }

  /** Polling interval helper used by the worker alarm. */
  defaultPollInterval(): number {
    return DEFAULT_POLL_INTERVAL_MS;
  }
}
