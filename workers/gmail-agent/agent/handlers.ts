import type { SqlStorage } from "@workspace/runtime/worker";
import {
  isGmailApiError,
  type GmailClient,
  type GmailMessage,
  type GmailThread,
} from "@workspace/gmail";
import type {
  GmailAttentionPrefs,
  GmailContactCandidate,
  GmailDigestItem,
  GmailThreadCardState,
} from "@workspace/gmail/card-types";
import { failureResult } from "../errors.js";
import type { TriageStore } from "../triage/triage-store.js";
import type { SyncEngine, SyncResult } from "../sync/sync-engine.js";
import type { GmailCards } from "../cards/cards.js";
import type { LabelResolver } from "./label-resolver.js";
import type { SendAsCache } from "./sendas-cache.js";
import type { TriageEngine } from "../triage/triage-engine.js";
import type { TriageCandidate } from "../triage/triage-store.js";
import { ComposeHandlers } from "./compose-handlers.js";
import { failGmailOperation } from "./error-policy.js";
import {
  METADATA_HEADERS,
  decodeBase64UrlBytes,
  header,
  normalizeEmailAddress,
  textFromPart,
  threadCardState,
} from "../sync/thread-model.js";
import type { PeopleStore, PersonCandidate } from "../people/people-store.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  booleanArg,
  numberArg,
  record,
  stringArg,
  type GmailChannelState,
} from "../types.js";

export { candidatesArg } from "./compose-handlers.js";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Attachment filenames are attacker-influenced email data: strip path
 * separators and traversal, collapse to a safe charset, cap length.
 */
export function sanitizeAttachmentFilename(raw: string | undefined): string {
  if (!raw) return "";
  const base = raw.split(/[/\\]/).pop() ?? "";
  return base
    .replace(/\.\.+/g, ".")
    .replace(/[^A-Za-z0-9._ ()-]/g, "_")
    .replace(/^[. ]+/, "")
    .trim()
    .slice(0, 120);
}

function findAttachmentPart(
  message: GmailMessage,
  attachmentId: string
): { filename?: string; mimeType?: string } | null {
  let found: { filename?: string; mimeType?: string } | null = null;
  const walk = (part: NonNullable<GmailMessage["payload"]> | undefined): void => {
    if (!part || found) return;
    if (part.body?.attachmentId === attachmentId) {
      found = {
        ...(part.filename ? { filename: part.filename } : {}),
        ...(part.mimeType ? { mimeType: part.mimeType } : {}),
      };
      return;
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(message.payload);
  return found;
}

export interface GmailHandlersDeps {
  sql: SqlStorage;
  gmailFor: (channelId: string) => GmailClient;
  sync: SyncEngine;
  store: TriageStore;
  triage: TriageEngine;
  labels: LabelResolver;
  sendAs: SendAsCache;
  people: PeopleStore;
  cards: GmailCards;
  getChannelState: (channelId: string) => GmailChannelState;
  saveChannelState: (state: GmailChannelState) => void;
  publishSetup: (channelId: string) => Promise<void>;
  generateDraftReplyBody: (channelId: string, thread: GmailThread) => Promise<string>;
  isSubscribed: (channelId: string) => boolean;
  /** Workspace file write (worker fs) — used by attachment saving. */
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  /** Shared clock (test-injectable; defaults to Date.now at the worker). */
  now: () => number;
}

/**
 * The single implementation layer for every Gmail operation. The runner
 * tools, onMethodCall dispatch, and participant API all route here, so
 * behavior cannot drift between surfaces.
 */
export class GmailHandlers {
  private readonly composeOps: ComposeHandlers;

  constructor(private readonly deps: GmailHandlersDeps) {
    this.composeOps = new ComposeHandlers(deps);
  }

  // ── inbox & sync ──────────────────────────────────────────────────────────

  /** Always attempts (even when auth-needed) so reconnect recovery works. */
  async checkInbox(channelId: string): Promise<SyncResult | ReturnType<typeof failureResult>> {
    const result = await this.deps.sync.syncChannel(channelId);
    if (!result.ok) return failureResult(result.error);
    return result;
  }

  setPollInterval(channelId: string, args: Record<string, unknown>): { pollIntervalMs: number } {
    const pollIntervalMs = Math.max(
      60_000,
      numberArg(args, "pollIntervalMs") ?? DEFAULT_POLL_INTERVAL_MS
    );
    const state = this.deps.getChannelState(channelId);
    state.pollIntervalMs = pollIntervalMs;
    this.deps.saveChannelState(state);
    return { pollIntervalMs };
  }

  /**
   * Re-verify the Google credential by attempting a sync; a success clears
   * the auth-needed state, a failure keeps the reconnect banner up.
   */
  async reconnect(channelId: string): Promise<{
    ok: boolean;
    auth: { status: "ok" | "reconnect-required" };
    error?: string;
  }> {
    const result = await this.deps.sync.syncChannel(channelId);
    const state = this.deps.getChannelState(channelId);
    await this.deps.publishSetup(channelId);
    return {
      ok: result.ok,
      auth: { status: state.syncState === "auth-needed" ? "reconnect-required" : "ok" },
      ...(result.ok ? {} : { error: result.error.message }),
    };
  }

  /** Publish (or refresh) a standalone thread card so the channel focuses it. */
  async openThread(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<
    { threadId: string; opened: true; messageId: string } | ReturnType<typeof failureResult>
  > {
    const threadId = stringArg(args, "threadId");
    if (!threadId) throw new Error("openThread requires threadId");
    let card: GmailThreadCardState;
    try {
      card = await this.deps.sync.refreshThread(
        channelId,
        threadId,
        this.deps.getChannelState(channelId).emailAddress
      );
    } catch (err) {
      return await this.failGmail(channelId, "openThread", err);
    }
    const handle = await this.deps.cards.publishThread(channelId, card);
    // messageId lets the caller (digest/search rows) chat.focusMessage() it.
    return { threadId, opened: true, messageId: handle.messageId };
  }

  listActionableThreads(channelId: string, limit: number): GmailThreadCardState[] {
    return this.deps.sync.listActionableThreads(channelId, limit);
  }

  // ── attention preferences ─────────────────────────────────────────────────

  getAttentionPrefs(channelId: string): GmailAttentionPrefs {
    const prefs = this.deps.store.getPrefs(channelId);
    return {
      preferencesText: prefs.preferencesText,
      knownSenderShortcut: prefs.knownSenderShortcut,
      updatedAt: prefs.updatedAt,
    };
  }

  /**
   * Save the user's natural-language attention preferences. Optionally
   * completes first-run setup in the same call (markConfigured: true).
   */
  async setAttention(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{
    saved: true;
    preferences: GmailAttentionPrefs;
    configured?: boolean;
    retriaged?: number;
    dryRun?: GmailAttentionDryRun;
  }> {
    const text = stringArg(args, "preferences");
    if (!text) throw new Error("setAttention requires preferences text");
    const mode = stringArg(args, "mode") === "append" ? "append" : "replace";
    const current = this.deps.store.getPrefs(channelId);
    const preferencesText =
      mode === "append" && this.deps.store.hasSavedPrefs(channelId)
        ? `${current.preferencesText}\n${text}`
        : text;
    const knownSenderShortcut = booleanArg(args, "knownSenderShortcut");
    const saved = this.deps.store.setPrefs(channelId, {
      preferencesText,
      ...(knownSenderShortcut !== undefined ? { knownSenderShortcut } : {}),
    });

    // Dry run over recent wakes/surfaces so the agent can tell the user what
    // would change. Must run BEFORE retriage (which clears the hit store).
    // SCOPED claim: ignored mail leaves no hit, so this can only show
    // previously-surfaced mail getting quieter — never previously ignored
    // mail starting to wake.
    let dryRun: GmailAttentionDryRun | undefined;
    if (booleanArg(args, "dryRun")) {
      dryRun = await this.dryRunRecentHits(channelId, preferencesText);
    }

    // Re-evaluate what's already in the inbox against the new preferences.
    const retriaged = this.deps.sync.retriageStoredThreads(channelId);

    let configured: boolean | undefined;
    if (booleanArg(args, "markConfigured")) {
      await this.markConfigured(channelId, {
        summary: stringArg(args, "summary") ?? `Watching for: ${text.slice(0, 200)}`,
      });
      configured = true;
    } else {
      await this.deps.publishSetup(channelId);
    }
    return {
      saved: true,
      preferences: saved,
      ...(configured !== undefined ? { configured } : {}),
      ...(retriaged > 0 ? { retriaged } : {}),
      ...(dryRun ? { dryRun } : {}),
    };
  }

  /** Re-evaluate the last ≤15 surfaced/woken threads against new text. */
  private async dryRunRecentHits(
    channelId: string,
    preferencesText: string
  ): Promise<GmailAttentionDryRun | undefined> {
    const hits = this.deps.store
      .hits(channelId, 15)
      // Only triage outcomes have a meaningful before-state to compare; the
      // known-sender shortcut and reminders are deterministic.
      .filter((hit) => hit.directiveId === "triage");
    if (hits.length === 0) return undefined;
    const candidates: TriageCandidate[] = [];
    const before = new Map<string, "wake" | "surface">();
    for (const hit of hits) {
      const row = this.deps.sync.threadRow(channelId, hit.threadId);
      if (!row) continue;
      before.set(hit.threadId, hit.directiveName === "Triage: surfaced" ? "surface" : "wake");
      candidates.push({
        channelId,
        threadId: row.thread_id,
        messageId: `dry-run-${row.updated_at}`,
        from: row.from_addr,
        to: "",
        subject: row.subject,
        snippet: row.snippet,
        labels: [],
        priorReply: this.deps.store.hasRepliedToSender(channelId, row.from_addr),
        enqueuedAt: row.updated_at,
        attempts: 0,
      });
    }
    if (candidates.length === 0) return undefined;
    const verdicts = await this.deps.triage.evaluateCandidates(
      channelId,
      candidates,
      preferencesText
    );
    if (!verdicts) return undefined; // rate-capped or model unavailable
    const byIndex = new Map(verdicts.map((verdict) => [verdict.index, verdict]));
    const changed: GmailAttentionDryRun["changed"] = [];
    let unchanged = 0;
    candidates.forEach((candidate, index) => {
      const after = byIndex.get(index + 1)?.decision ?? "surface";
      const previous = before.get(candidate.threadId) ?? "surface";
      if (after === previous) {
        unchanged += 1;
      } else {
        changed.push({
          threadId: candidate.threadId,
          subject: candidate.subject,
          before: previous,
          after,
        });
      }
    });
    return {
      reEvaluated: candidates.length,
      changed,
      unchanged,
      note: "Re-evaluated recent surfaced/woken mail only — previously ignored mail is not re-checked.",
    };
  }

  async markConfigured(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ configured: true; configuredAt: string; summary?: string }> {
    const state = this.deps.getChannelState(channelId);
    const summary = stringArg(args, "summary")?.slice(0, 500);
    state.setupStatus = "configured";
    state.configuredAt = Date.now();
    state.setupSummary = summary;
    this.deps.saveChannelState(state);
    await this.deps.publishSetup(channelId);
    return {
      configured: true,
      configuredAt: new Date(state.configuredAt).toISOString(),
      ...(summary ? { summary } : {}),
    };
  }

  // ── search ────────────────────────────────────────────────────────────────

  /**
   * Gmail search with full query syntax and pagination. Publishes an
   * ephemeral gmail.search card unless `mirrorToCard: false` (e.g. when the
   * model paginates internally).
   */
  async search(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<
    | {
        query: string;
        count: number;
        nextPageToken?: string;
        results: GmailSearchResultSummary[];
      }
    | ReturnType<typeof failureResult>
  > {
    const q = stringArg(args, "q");
    if (!q) throw new Error("search requires q");
    const mirrorToCard = booleanArg(args, "mirrorToCard") ?? true;
    const pageToken = stringArg(args, "pageToken");
    const limit = Math.max(1, Math.min(numberArg(args, "limit") ?? 10, 50));
    const cardHandle = mirrorToCard
      ? await this.deps.cards.createSearch(channelId, q).catch(() => null)
      : null;
    try {
      const gmail = this.deps.gmailFor(channelId);
      // threads.list gives TRUE thread pagination: `limit` means N threads,
      // not N messages deduped down to fewer threads.
      const page = await gmail.listThreads({
        q,
        maxResults: limit,
        ...(pageToken ? { pageToken } : {}),
      });
      const hydrated = await gmail.batchGetThreads(
        page.threads.map((thread) => thread.id),
        { format: "metadata", metadataHeaders: METADATA_HEADERS }
      );
      const threads: GmailThreadCardState[] = [];
      for (const item of hydrated) {
        if (item.error) {
          if (item.error.code === "not-found") continue;
          throw item.error;
        }
        threads.push(threadCardState(item.value!));
      }
      const items = threads.map(searchDigestItem);
      if (cardHandle) {
        await this.deps.cards
          .updateSearch(channelId, cardHandle.messageId, {
            status: "done",
            results: items,
            ...(page.resultSizeEstimate !== undefined
              ? { totalEstimate: page.resultSizeEstimate }
              : {}),
          })
          .catch(() => undefined);
      }
      return {
        query: q,
        count: threads.length,
        ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
        results: threads.map((thread) => ({
          threadId: thread.threadId,
          subject: thread.subject,
          ...(thread.from ? { from: thread.from } : {}),
          // Bare parsed address alongside the display string so callers can
          // address mail without re-parsing the header themselves.
          ...(normalizeEmailAddress(thread.from)
            ? { fromEmail: normalizeEmailAddress(thread.from) }
            : {}),
          snippet: thread.lastSnippet,
          unread: thread.unreadCount > 0,
          date: new Date(thread.updatedAt).toISOString(),
        })),
      };
    } catch (err) {
      if (cardHandle) {
        await this.deps.cards
          .updateSearch(channelId, cardHandle.messageId, {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          })
          .catch(() => undefined);
      }
      return await this.failGmail(channelId, "search", err);
    }
  }

  // ── read ──────────────────────────────────────────────────────────────────

  /**
   * Read a thread or single message. format "metadata" returns headers and
   * snippets only; "full" (default) includes sanitized text bodies.
   */
  async readMail(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<
    | { threadId: string; messages: Array<Record<string, unknown>> }
    | { messageId: string; message: Record<string, unknown> }
    | ReturnType<typeof failureResult>
  > {
    const threadId = stringArg(args, "threadId");
    const messageId = stringArg(args, "messageId");
    if (!threadId && !messageId) throw new Error("read requires threadId or messageId");
    const format = stringArg(args, "format") === "metadata" ? "metadata" : "full";
    const maxBodyChars = Math.max(
      500,
      Math.min(numberArg(args, "maxBodyChars") ?? 20_000, 100_000)
    );
    const includeAttachments = booleanArg(args, "includeAttachmentList") ?? false;
    try {
      const gmail = this.deps.gmailFor(channelId);
      const opts =
        format === "metadata"
          ? ({ format: "metadata", metadataHeaders: METADATA_HEADERS } as const)
          : ({ format: "full" } as const);
      if (threadId) {
        const thread = await gmail.getThread(threadId, opts);
        return {
          threadId,
          messages: (thread.messages ?? []).map((message) =>
            sanitizeMessage(message, format, maxBodyChars, includeAttachments)
          ),
        };
      }
      const message = await gmail.getMessage(messageId!, opts);
      return {
        messageId: messageId!,
        message: sanitizeMessage(message, format, maxBodyChars, includeAttachments),
      };
    } catch (err) {
      return await this.failGmail(channelId, "read", err);
    }
  }

  // ── snooze / reminders ────────────────────────────────────────────────────

  /**
   * Snooze a thread: archive it now (default) and wake the agent with a
   * reminder digest at `remindAt`. Setting a new reminder for the same
   * thread replaces the old one.
   */
  async snooze(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<
    | { snoozed: true; threadId: string; remindAt: string; archived: boolean }
    | ReturnType<typeof failureResult>
  > {
    const threadId = stringArg(args, "threadId");
    if (!threadId) throw new Error("snooze requires threadId");
    const now = this.deps.now();
    const inMs = numberArg(args, "inMs");
    const remindAtArg = stringArg(args, "remindAt");
    const parsedAt = remindAtArg ? Date.parse(remindAtArg) : NaN;
    const remindAt =
      inMs && inMs > 0
        ? now + inMs
        : Number.isFinite(parsedAt)
          ? parsedAt
          : now + 24 * 60 * 60 * 1000; // default: tomorrow
    if (remindAt <= now) throw new Error("snooze remindAt must be in the future");

    const row = this.deps.sync.threadRow(channelId, threadId);
    this.deps.store.setReminder(channelId, {
      threadId,
      remindAt,
      note: stringArg(args, "note"),
      ...(row ? { subject: row.subject, from: row.from_addr } : {}),
    });

    const archive = booleanArg(args, "archive") ?? true;
    if (archive) {
      const archived = await this.archiveThread(channelId, { threadId });
      if ("error" in archived) return archived;
    }
    return {
      snoozed: true,
      threadId,
      remindAt: new Date(remindAt).toISOString(),
      archived: archive,
    };
  }

  listReminders(channelId: string): {
    reminders: Array<{ threadId: string; remindAt: string; note?: string; subject?: string }>;
  } {
    return {
      reminders: this.deps.store.listReminders(channelId).map((reminder) => ({
        threadId: reminder.threadId,
        remindAt: new Date(reminder.remindAt).toISOString(),
        ...(reminder.note ? { note: reminder.note } : {}),
        ...(reminder.subject ? { subject: reminder.subject } : {}),
      })),
    };
  }

  cancelReminder(channelId: string, args: Record<string, unknown>): { cancelled: boolean } {
    const threadId = stringArg(args, "threadId");
    if (!threadId) throw new Error("cancelReminder requires threadId");
    return { cancelled: this.deps.store.deleteReminder(channelId, threadId) };
  }

  // ── attachments ───────────────────────────────────────────────────────────

  /**
   * Fetch an attachment and save it as a workspace file. The Gmail API's
   * attachments.get returns only { size, data } — filename/mimeType/threadId
   * come from the caller (gmail_read's attachment list has them) or, as a
   * fallback, from one message lookup.
   */
  async getAttachment(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<
    | { saved: true; path: string; size: number; mimeType?: string }
    | ReturnType<typeof failureResult>
  > {
    const messageId = stringArg(args, "messageId");
    const attachmentId = stringArg(args, "attachmentId");
    if (!messageId || !attachmentId) {
      throw new Error("getAttachment requires messageId and attachmentId");
    }
    let filename = stringArg(args, "filename") ?? stringArg(args, "saveAs");
    let mimeType = stringArg(args, "mimeType");
    let threadId = stringArg(args, "threadId");
    try {
      const gmail = this.deps.gmailFor(channelId);
      if (!filename || !threadId) {
        // Metadata fallback: one message lookup to find the part.
        const message = await gmail.getMessage(messageId, { format: "full" });
        threadId = threadId ?? message.threadId;
        const part = findAttachmentPart(message, attachmentId);
        filename = filename ?? part?.filename ?? undefined;
        mimeType = mimeType ?? part?.mimeType ?? undefined;
      }
      const attachment = await gmail.getAttachment(messageId, attachmentId);
      if (attachment.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `attachment is ${attachment.size} bytes — exceeds the ${MAX_ATTACHMENT_BYTES} byte save limit`
        );
      }
      const safeName =
        sanitizeAttachmentFilename(filename) || `attachment-${attachmentId.slice(0, 12)}`;
      const dir = sanitizeAttachmentFilename(threadId ?? messageId) || messageId;
      const path = `gmail-attachments/${dir}/${safeName}`;
      const bytes = decodeBase64UrlBytes(attachment.data);
      await this.deps.writeFile(path, bytes);
      return {
        saved: true,
        path,
        size: bytes.byteLength,
        ...(mimeType ? { mimeType } : {}),
      };
    } catch (err) {
      return await this.failGmail(channelId, "getAttachment", err);
    }
  }

  // ── modify (labels / read / archive / local category) ────────────────────

  /**
   * Unified mutation: real Gmail labels (names auto-created), mark read,
   * archive, and the optional local-only category. Accepts thread ids and/or
   * message ids; message ids route through the native batchModify endpoint.
   */
  async modifyMail(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<
    | {
        modified: true;
        threadIds: string[];
        messageIds: string[];
        addedLabels: string[];
        removedLabels: string[];
      }
    | ReturnType<typeof failureResult>
  > {
    const threadIds = stringArrayArg(args, "threadIds", stringArg(args, "threadId"));
    const messageIds = stringArrayArg(args, "messageIds", stringArg(args, "messageId"));
    if (threadIds.length === 0 && messageIds.length === 0) {
      throw new Error("modify requires threadIds or messageIds");
    }
    if (threadIds.length + messageIds.length > 100) {
      throw new Error("modify accepts at most 100 ids per call");
    }
    const addNames = stringArrayArg(args, "addLabels");
    const removeNames = stringArrayArg(args, "removeLabels");
    if (booleanArg(args, "markRead")) removeNames.push("UNREAD");
    if (booleanArg(args, "archive")) removeNames.push("INBOX");
    const localCategory = stringArg(args, "localCategory");
    if (addNames.length === 0 && removeNames.length === 0 && !localCategory) {
      throw new Error(
        "modify requires at least one change (labels, markRead, archive, or localCategory)"
      );
    }
    try {
      const gmail = this.deps.gmailFor(channelId);
      const addLabelIds = await this.deps.labels.resolveIds(channelId, addNames, {
        createMissing: true,
      });
      const removeLabelIds = await this.deps.labels.resolveIds(channelId, removeNames, {
        createMissing: false,
      });
      if (addLabelIds.length > 0 || removeLabelIds.length > 0) {
        if (messageIds.length > 0) {
          await gmail.batchModify({ messageIds, addLabelIds, removeLabelIds });
        }
        for (const threadId of threadIds) {
          await gmail.modifyLabels({ threadId, addLabelIds, removeLabelIds });
        }
      }
      const markedRead = removeLabelIds.includes("UNREAD");
      const archived = removeLabelIds.includes("INBOX");
      for (const threadId of threadIds) {
        if (localCategory) {
          this.deps.sql.exec(
            `UPDATE gmail_threads SET category = ?, updated_at = ? WHERE channel_id = ? AND thread_id = ?`,
            localCategory,
            Date.now(),
            channelId,
            threadId
          );
          await this.deps.cards.updateThread(channelId, threadId, { category: localCategory });
        }
        if (markedRead || archived) {
          await this.deps.sync.applyLocalThreadFlags(channelId, threadId, {
            ...(markedRead ? { unread: false } : {}),
            ...(archived ? { inInbox: false } : {}),
            actionable: false,
            status: archived ? "archived" : "open",
          });
        }
      }
      return {
        modified: true,
        threadIds,
        messageIds,
        addedLabels: addLabelIds,
        removedLabels: removeLabelIds,
      };
    } catch (err) {
      return await this.failGmail(channelId, "modify", err);
    }
  }

  /** UI convenience wrappers over modifyMail (thread card buttons). */
  async archiveThread(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ threadId: string; archived: true } | ReturnType<typeof failureResult>> {
    const threadId = stringArg(args, "threadId");
    if (!threadId) throw new Error("archiveThread requires threadId");
    const result = await this.modifyMail(channelId, { threadIds: [threadId], archive: true });
    if ("error" in result) return result;
    return { threadId, archived: true };
  }

  async markRead(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ threadId: string; read: true } | ReturnType<typeof failureResult>> {
    const threadId = stringArg(args, "threadId");
    if (!threadId) throw new Error("markRead requires threadId");
    const result = await this.modifyMail(channelId, { threadIds: [threadId], markRead: true });
    if ("error" in result) return result;
    return { threadId, read: true };
  }

  // ── digest card ───────────────────────────────────────────────────────────

  /** Publish an immutable digest card (agent-authored items, ≤5 rows). */
  async publishDigest(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ published: true; messageId: string }> {
    const headline = stringArg(args, "headline");
    if (!headline) throw new Error("publishDigest requires headline");
    const rawItems = Array.isArray(args["items"]) ? args["items"] : [];
    const items: GmailDigestItem[] = rawItems
      .map((item) => record(item))
      .filter((item) => typeof item["threadId"] === "string" && item["threadId"])
      .slice(0, 5)
      .map((item) => ({
        threadId: String(item["threadId"]),
        from: typeof item["from"] === "string" ? item["from"] : "",
        subject: typeof item["subject"] === "string" ? item["subject"] : "(no subject)",
        ...(typeof item["gist"] === "string" && item["gist"]
          ? { gist: item["gist"].slice(0, 200) }
          : {}),
        ...(isSuggestedAction(item["suggested"]) ? { suggested: item["suggested"] } : {}),
        ...(item["unread"] === true ? { unread: true } : {}),
      }));
    if (items.length === 0) throw new Error("publishDigest requires at least one item");
    const moreCount = numberArg(args, "moreCount");
    const handle = await this.deps.cards.publishDigest(channelId, {
      generatedAt: Date.now(),
      headline: headline.slice(0, 200),
      items,
      ...(moreCount && moreCount > 0 ? { moreCount } : {}),
    });
    return { published: true, messageId: handle.messageId };
  }

  // ── contact resolution ────────────────────────────────────────────────────

  /**
   * Resolve a person name to recipient candidates. Derived mail-history
   * store first; when it has nothing, fall back to the Google address book
   * (People API). Missing People scopes degrade gracefully: the failure is
   * remembered per channel (people_api_status) and surfaced on the setup
   * card instead of erroring the call.
   */
  async resolveContact(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ query: string; candidates: GmailContactCandidate[] }> {
    const name = stringArg(args, "name") ?? stringArg(args, "query");
    if (!name) throw new Error("resolveContact requires name");
    const limit = Math.max(1, Math.min(numberArg(args, "limit") ?? 5, 10));
    const fromHistory = this.deps.people
      .resolve(channelId, name, limit)
      .map((candidate) => historyCandidate(candidate));
    if (fromHistory.length > 0) return { query: name, candidates: fromHistory };

    const state = this.deps.getChannelState(channelId);
    if (state.peopleApiStatus === "unavailable") return { query: name, candidates: [] };
    try {
      const gmail = this.deps.gmailFor(channelId);
      const contacts = await gmail.searchContacts(name, { pageSize: limit });
      const others =
        contacts.length >= limit ? [] : await gmail.searchOtherContacts(name, { pageSize: limit });
      const seen = new Set<string>();
      const candidates: GmailContactCandidate[] = [];
      for (const contact of [...contacts, ...others]) {
        if (seen.has(contact.email)) continue;
        seen.add(contact.email);
        candidates.push({
          email: contact.email,
          ...(contact.displayName ? { displayName: contact.displayName } : {}),
          sentTo: 0,
          receivedFrom: 0,
          youReplied: false,
          source: "google-contacts",
          score: 0,
        });
        if (candidates.length >= limit) break;
      }
      await this.setPeopleApiStatus(channelId, "ok");
      return { query: name, candidates };
    } catch (err) {
      if (isGmailApiError(err, "forbidden") || isGmailApiError(err, "auth-expired")) {
        await this.setPeopleApiStatus(channelId, "unavailable");
        return { query: name, candidates: [] };
      }
      throw err;
    }
  }

  /** Derived-store-only typeahead — never touches the network. */
  contactSuggest(
    channelId: string,
    args: Record<string, unknown>
  ): { prefix: string; candidates: GmailContactCandidate[] } {
    const prefix = stringArg(args, "prefix") ?? stringArg(args, "query");
    if (!prefix) return { prefix: "", candidates: [] };
    const limit = Math.max(1, Math.min(numberArg(args, "limit") ?? 5, 10));
    return {
      prefix,
      candidates: this.deps.people
        .suggest(channelId, prefix, limit)
        .map((candidate) => historyCandidate(candidate)),
    };
  }

  /** Unified contacts entry point: mode "resolve" (default) or "suggest". */
  async contacts(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<
    | { query: string; candidates: GmailContactCandidate[] }
    | { prefix: string; candidates: GmailContactCandidate[] }
  > {
    if (stringArg(args, "mode") === "suggest") return this.contactSuggest(channelId, args);
    return this.resolveContact(channelId, args);
  }

  private async setPeopleApiStatus(channelId: string, status: "ok" | "unavailable"): Promise<void> {
    const state = this.deps.getChannelState(channelId);
    if (state.peopleApiStatus === status) return;
    state.peopleApiStatus = status;
    this.deps.saveChannelState(state);
    await this.deps.publishSetup(channelId).catch(() => undefined);
  }

  // ── compose / draft / send (implemented in compose-handlers.ts) ─────────

  draftMail(channelId: string, args: Record<string, unknown>) {
    return this.composeOps.draftMail(channelId, args);
  }

  compose(channelId: string, args: Record<string, unknown>) {
    return this.composeOps.compose(channelId, args);
  }

  requestDraft(channelId: string, args: Record<string, unknown>) {
    return this.composeOps.requestDraft(channelId, args);
  }

  draftReply(channelId: string, args: Record<string, unknown>) {
    return this.composeOps.draftReply(channelId, args);
  }

  send(channelId: string, args: Record<string, unknown>) {
    return this.composeOps.send(channelId, args);
  }

  saveDraft(channelId: string, args: Record<string, unknown>) {
    return this.composeOps.saveDraft(channelId, args);
  }

  discardCompose(channelId: string, args: Record<string, unknown>) {
    return this.composeOps.discardCompose(channelId, args);
  }

  // ── error policy ──────────────────────────────────────────────────────────

  /** Shared Gmail failure policy — see error-policy.ts. */
  private failGmail(channelId: string, operation: string, err: unknown) {
    return failGmailOperation(this.deps, channelId, operation, err);
  }
}

export interface GmailAttentionDryRun {
  reEvaluated: number;
  changed: Array<{
    threadId: string;
    subject?: string;
    before: "wake" | "surface";
    after: "wake" | "surface" | "ignore";
  }>;
  unchanged: number;
  note: string;
}

export interface GmailSearchResultSummary {
  threadId: string;
  subject: string;
  from?: string;
  fromEmail?: string;
  snippet: string;
  unread: boolean;
  date?: string;
}

function historyCandidate(candidate: PersonCandidate): GmailContactCandidate {
  return { ...candidate, source: "history" };
}

function searchDigestItem(card: GmailThreadCardState): GmailDigestItem {
  return {
    threadId: card.threadId,
    from: card.from,
    subject: card.subject,
    ...(card.lastSnippet ? { gist: card.lastSnippet.slice(0, 140) } : {}),
    ...(card.unreadCount > 0 ? { unread: true } : {}),
  };
}

function isSuggestedAction(value: unknown): value is "reply" | "archive" | "read" | "open" {
  return value === "reply" || value === "archive" || value === "read" || value === "open";
}

function sanitizeMessage(
  message: GmailMessage,
  format: "metadata" | "full",
  maxBodyChars: number,
  includeAttachments: boolean
): Record<string, unknown> {
  return {
    id: message.id,
    threadId: message.threadId,
    from: header(message, "From") ?? "",
    to: header(message, "To") ?? "",
    date: header(message, "Date") ?? "",
    subject: header(message, "Subject") ?? "",
    snippet: message.snippet ?? "",
    labels: message.labelIds ?? [],
    ...(format === "full"
      ? { bodyText: textFromPart(message.payload).slice(0, maxBodyChars) }
      : {}),
    ...(includeAttachments ? { attachments: attachmentList(message) } : {}),
  };
}

function attachmentList(
  message: GmailMessage
): Array<{ filename: string; mimeType?: string; attachmentId?: string; size?: number }> {
  const out: Array<{ filename: string; mimeType?: string; attachmentId?: string; size?: number }> =
    [];
  const walk = (part: NonNullable<GmailMessage["payload"]> | undefined): void => {
    if (!part) return;
    if (part.filename && (part.body?.attachmentId || part.body?.size)) {
      out.push({
        filename: part.filename,
        ...(part.mimeType ? { mimeType: part.mimeType } : {}),
        ...(part.body?.attachmentId ? { attachmentId: part.body.attachmentId } : {}),
        ...(part.body?.size !== undefined ? { size: part.body.size } : {}),
      });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(message.payload);
  return out;
}

function stringArrayArg(
  args: Record<string, unknown>,
  key: string,
  fallbackSingle?: string
): string[] {
  const raw = args[key];
  const list = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  if (list.length === 0 && fallbackSingle) return [fallbackSingle];
  return Array.from(new Set(list.map((item) => item.trim())));
}
