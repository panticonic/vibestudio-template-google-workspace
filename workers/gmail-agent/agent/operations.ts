import type { GmailHandlers } from "./handlers.js";
import type { GmailParticipantApi } from "../participant-api.js";
import { numberArg, record } from "../types.js";

/** Everything an operation needs at dispatch time. */
export interface GmailOperationContext {
  handlers: GmailHandlers;
  participantApi: GmailParticipantApi;
  queuedWakeCount: (channelId: string) => number;
}

export type GmailOperationExposure = "tool" | "method" | "participant";

export interface GmailOperationAuth {
  requiredScopes: string[];
  googleApis: string[];
  reconnectPrompt: string;
}

export interface GmailOperation {
  /** Canonical name; model tools use this verbatim. */
  name: string;
  description: string;
  schema: Record<string, unknown>;
  exposure: GmailOperationExposure[];
  auth?: GmailOperationAuth;
  /** Run ensureRecovered (channel replay catch-up) before dispatching. */
  needsRecovery?: boolean;
  run: (ctx: GmailOperationContext, channelId: string, args: Record<string, unknown>) => unknown;
}

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false } as const;

const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_WRITE_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_SETTINGS_SCOPE = "https://www.googleapis.com/auth/gmail.settings.basic";
const GOOGLE_CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts";
const GOOGLE_OTHER_CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.other.readonly";

const GMAIL_API = "Gmail API";
const PEOPLE_API = "People API";

const GMAIL_READ_AUTH: GmailOperationAuth = {
  requiredScopes: [GMAIL_READ_SCOPE],
  googleApis: [GMAIL_API],
  reconnectPrompt:
    "Reconnect Google Workspace from the Gmail setup card so Vibestudio can request Gmail read/modify access.",
};

const GMAIL_WRITE_AUTH: GmailOperationAuth = {
  requiredScopes: [GMAIL_WRITE_SCOPE],
  googleApis: [GMAIL_API],
  reconnectPrompt:
    "Reconnect Google Workspace from the Gmail setup card so Vibestudio can request Gmail read/modify access.",
};

const GMAIL_SEND_AS_AUTH: GmailOperationAuth = {
  requiredScopes: [GMAIL_READ_SCOPE, GMAIL_SETTINGS_SCOPE],
  googleApis: [GMAIL_API],
  reconnectPrompt:
    "Reconnect Google Workspace from the Gmail setup card so Vibestudio can request Gmail and Gmail settings access.",
};

const GMAIL_CONTACTS_AUTH: GmailOperationAuth = {
  requiredScopes: [GMAIL_READ_SCOPE, GOOGLE_CONTACTS_SCOPE, GOOGLE_OTHER_CONTACTS_SCOPE],
  googleApis: [GMAIL_API, PEOPLE_API],
  reconnectPrompt:
    "Reconnect Google Workspace from the Gmail setup card so Vibestudio can request Gmail and Google contacts access.",
};

const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    q: { type: "string", minLength: 1 },
    limit: { type: "number", minimum: 1, maximum: 50 },
    pageToken: { type: "string" },
    mirrorToCard: { type: "boolean" },
  },
  required: ["q"],
  additionalProperties: false,
} as const;

const READ_SCHEMA = {
  type: "object",
  properties: {
    threadId: { type: "string" },
    messageId: { type: "string" },
    format: { enum: ["metadata", "full"] },
    maxBodyChars: { type: "number", minimum: 500, maximum: 100_000 },
    includeAttachmentList: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

const MODIFY_SCHEMA = {
  type: "object",
  properties: {
    threadIds: { type: "array", items: { type: "string" }, maxItems: 100 },
    messageIds: { type: "array", items: { type: "string" }, maxItems: 100 },
    addLabels: { type: "array", items: { type: "string" }, maxItems: 10 },
    removeLabels: { type: "array", items: { type: "string" }, maxItems: 10 },
    markRead: { type: "boolean" },
    archive: { type: "boolean" },
    localCategory: { type: "string" },
  },
  additionalProperties: false,
} as const;

const CANDIDATES_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      email: { type: "string" },
      displayName: { type: "string" },
      sentTo: { type: "number" },
      receivedFrom: { type: "number" },
      lastInteractionAt: { type: "number" },
      youReplied: { type: "boolean" },
      source: { type: "string" },
      score: { type: "number" },
    },
    required: ["email"],
    additionalProperties: false,
  },
} as const;

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    mode: { enum: ["new", "reply"] },
    threadId: { type: "string" },
    to: { type: "string" },
    cc: { type: "string" },
    bcc: { type: "string" },
    from: { type: "string" },
    subject: { type: "string" },
    body: { type: "string" },
    composeCardId: { type: "string" },
    saveToGmail: { type: "boolean" },
    toCandidates: CANDIDATES_SCHEMA,
  },
  additionalProperties: false,
} as const;

const SEND_SCHEMA = {
  type: "object",
  properties: {
    to: { type: "string" },
    cc: { type: "string" },
    bcc: { type: "string" },
    from: { type: "string" },
    subject: { type: "string" },
    body: { type: "string" },
    threadId: { type: "string" },
    messageId: { type: "string" },
    sourceThreadId: { type: "string" },
    draftId: { type: "string" },
    toCandidates: CANDIDATES_SCHEMA,
  },
  required: ["body"],
  additionalProperties: false,
} as const;

const CONTACTS_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1 },
    mode: { enum: ["resolve", "suggest"] },
    limit: { type: "number", minimum: 1, maximum: 10 },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const SET_ATTENTION_SCHEMA = {
  type: "object",
  properties: {
    preferences: { type: "string", minLength: 1 },
    mode: { enum: ["replace", "append"] },
    knownSenderShortcut: { type: "boolean" },
    markConfigured: { type: "boolean" },
    summary: { type: "string" },
    dryRun: { type: "boolean" },
  },
  required: ["preferences"],
  additionalProperties: false,
} as const;

const PUBLISH_DIGEST_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", minLength: 1 },
    items: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          threadId: { type: "string", minLength: 1 },
          from: { type: "string" },
          subject: { type: "string" },
          gist: { type: "string" },
          suggested: { enum: ["reply", "archive", "read", "open"] },
          unread: { type: "boolean" },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
    },
    moreCount: { type: "number", minimum: 0 },
  },
  required: ["headline", "items"],
  additionalProperties: false,
} as const;

/**
 * The single Gmail operation table. Runner tools, onMethodCall dispatch, and
 * the advertised participant method list are all generated from this — the
 * three surfaces cannot drift.
 */
export const GMAIL_OPERATIONS: GmailOperation[] = [
  // ── model tools (also callable as methods) ─────────────────────────────────
  {
    name: "gmail_search",
    description:
      'Search Gmail with full query syntax (e.g. "in:inbox newer_than:1d", "from:alice@example.com has:attachment"). ' +
      "Returns { query, count, nextPageToken?, results: [{ threadId, subject, from, fromEmail, snippet, unread, date }] }. " +
      "Pass pageToken to fetch the next page instead of raising limit. " +
      "By default the results are also published as a search card in the channel; pass mirrorToCard: false for internal lookups the user does not need to see.",
    schema: SEARCH_SCHEMA,
    exposure: ["tool", "method"],
    auth: GMAIL_READ_AUTH,
    needsRecovery: true,
    run: (ctx, channelId, args) => ctx.handlers.search(channelId, args),
  },
  {
    name: "gmail_read",
    description:
      "Read a thread or single message. { threadId? | messageId?, format?: 'metadata'|'full' (default full), maxBodyChars?, includeAttachmentList? }. " +
      "Use format 'metadata' when you only need headers/snippets — it is much cheaper. " +
      "Returns sanitized text bodies; never persist full bodies into chat messages or card state.",
    schema: READ_SCHEMA,
    exposure: ["tool", "method"],
    auth: GMAIL_READ_AUTH,
    run: (ctx, channelId, args) => ctx.handlers.readMail(channelId, args),
  },
  {
    name: "gmail_modify",
    description:
      "Modify threads/messages in Gmail: { threadIds?|messageIds?, addLabels?, removeLabels?, markRead?, archive?, localCategory? }. " +
      "Labels are REAL Gmail labels by name (created automatically when missing) — use them for durable organization. " +
      "markRead/archive are shorthands for removing UNREAD/INBOX. Many ids are batched in one API call. " +
      "localCategory only tags the thread in this channel's cache.",
    schema: MODIFY_SCHEMA,
    exposure: ["tool", "method"],
    auth: GMAIL_WRITE_AUTH,
    needsRecovery: true,
    run: (ctx, channelId, args) => ctx.handlers.modifyMail(channelId, args),
  },
  {
    name: "gmail_draft",
    description:
      "Create or update a draft on a compose card: { mode: 'new'|'reply', threadId?, to?, cc?, bcc?, subject?, body?, composeCardId?, saveToGmail?, toCandidates? }. " +
      "YOU write the body. The card lands in 'review' when complete (user's Send click is the only authorization to send) or 'drafting' when recipient/subject/body are missing — that is not an error. " +
      "mode 'reply' resolves recipient and subject from the thread. saveToGmail also persists a Gmail draft (re-saving updates it). " +
      "Pass toCandidates from gmail_contacts so the card offers one-click recipient selection.",
    schema: DRAFT_SCHEMA,
    exposure: ["tool", "method"],
    auth: GMAIL_SEND_AS_AUTH,
    needsRecovery: true,
    run: (ctx, channelId, args) => ctx.handlers.draftMail(channelId, args),
  },
  {
    name: "gmail_send",
    description:
      "Send a Gmail message immediately. Use ONLY when the user explicitly asked to send without review; otherwise use gmail_draft so the user reviews and clicks Send on the compose card. " +
      "Parameters: { to: string, cc?, bcc?, from? (must be a configured send-as alias), subject: string, body: string, threadId?, messageId? }.",
    schema: SEND_SCHEMA,
    exposure: ["tool", "method"],
    auth: GMAIL_SEND_AS_AUTH,
    needsRecovery: true,
    run: (ctx, channelId, args) => ctx.handlers.send(channelId, args),
  },
  {
    name: "gmail_contacts",
    description:
      "Resolve a person to email candidates with interaction evidence (sent/received counts, recency, whether you replied) — mail history first, Google contacts fallback. " +
      "{ query: string, mode?: 'resolve' (default) | 'suggest' (fast prefix typeahead, no network), limit? }. " +
      "Use BEFORE drafting when the user names a recipient without an address. Never invent addresses. " +
      "One high-confidence candidate → use it; several plausible → ask the user or pass them as toCandidates to gmail_draft.",
    schema: CONTACTS_SCHEMA,
    exposure: ["tool", "method"],
    auth: GMAIL_CONTACTS_AUTH,
    needsRecovery: true,
    run: (ctx, channelId, args) => ctx.handlers.contacts(channelId, args),
  },
  {
    name: "gmail_set_attention",
    description:
      "Save the user's standing attention preferences as natural language: { preferences: string, mode?: 'replace'|'append', knownSenderShortcut?: boolean, markConfigured?: boolean, summary?: string, dryRun?: boolean }. " +
      "A lightweight triage pass reads new-mail metadata against this text and decides wake/surface/ignore. " +
      "Write the preferences in the user's own words, complete first-run setup with markConfigured: true. " +
      "knownSenderShortcut (default on) deterministically wakes for senders the user has replied to. " +
      "The result may include dryRun: recent surfaced/woken mail re-evaluated under the new text — summarize it for the user (e.g. '2 of the last 5 wakes would now stay quiet'), and be explicit that previously ignored mail is not re-checked.",
    schema: SET_ATTENTION_SCHEMA,
    exposure: ["tool", "method"],
    // Tool calls default to a dry run; the setAttentionPrefs RPC does not.
    run: (ctx, channelId, args) => ctx.handlers.setAttention(channelId, { dryRun: true, ...args }),
  },
  {
    name: "gmail_snooze",
    description:
      "Snooze a thread: archive it now (archive: false to keep it) and get a reminder wake at the given time: { threadId, remindAt?: ISO datetime, inMs?: number, note?, archive? }. " +
      "Default reminder is 24h. The reminder arrives as a wake digest ('Reminder: …'). Re-snoozing a thread replaces its reminder.",
    schema: {
      type: "object",
      properties: {
        threadId: { type: "string", minLength: 1 },
        remindAt: { type: "string" },
        inMs: { type: "number", minimum: 60_000 },
        note: { type: "string", maxLength: 300 },
        archive: { type: "boolean" },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
    exposure: ["tool", "method"],
    auth: GMAIL_WRITE_AUTH,
    needsRecovery: true,
    run: (ctx, channelId, args) => ctx.handlers.snooze(channelId, args),
  },
  {
    name: "gmail_list_reminders",
    description: "List this channel's snoozed-thread reminders.",
    schema: NO_ARGS,
    exposure: ["tool", "method"],
    run: (ctx, channelId) => ctx.handlers.listReminders(channelId),
  },
  {
    name: "cancelReminder",
    description: "Cancel a snoozed-thread reminder",
    schema: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
      additionalProperties: false,
    },
    exposure: ["method"],
    run: (ctx, channelId, args) => ctx.handlers.cancelReminder(channelId, args),
  },
  {
    name: "gmail_get_attachment",
    description:
      "Fetch an email attachment and save it as a workspace file: { messageId, attachmentId, filename?, mimeType?, threadId?, saveAs? }. " +
      "Returns { saved, path, size, mimeType? } — read the saved file with normal workspace tools (e.g. to extract an invoice amount from a PDF). " +
      "Pass filename/mimeType/threadId from gmail_read's attachment list when you have them (saves a lookup). Max 10MB.",
    schema: {
      type: "object",
      properties: {
        messageId: { type: "string", minLength: 1 },
        attachmentId: { type: "string", minLength: 1 },
        filename: { type: "string" },
        mimeType: { type: "string" },
        threadId: { type: "string" },
        saveAs: { type: "string" },
      },
      required: ["messageId", "attachmentId"],
      additionalProperties: false,
    },
    exposure: ["tool", "method"],
    auth: GMAIL_READ_AUTH,
    needsRecovery: true,
    run: (ctx, channelId, args) => ctx.handlers.getAttachment(channelId, args),
  },
  {
    name: "gmail_publish_digest",
    description:
      "Publish a compact digest card in the channel: { headline: string, items: [{ threadId, from?, subject?, gist?, suggested?: 'reply'|'archive'|'read'|'open', unread? }] (max 5), moreCount? }. " +
      "Use at the end of a wake-digest turn: one short chat message + one digest card, never one message per email.",
    schema: PUBLISH_DIGEST_SCHEMA,
    exposure: ["tool", "method"],
    run: (ctx, channelId, args) => ctx.handlers.publishDigest(channelId, args),
  },

  // ── UI / method-only operations ────────────────────────────────────────────
  {
    name: "checkNow",
    description: "Synchronize Gmail now",
    schema: NO_ARGS,
    exposure: ["method"],
    auth: GMAIL_READ_AUTH,
    needsRecovery: true,
    run: (ctx, channelId) => ctx.handlers.checkInbox(channelId),
  },
  {
    name: "markConfigured",
    description: "Mark first-run Gmail setup complete",
    schema: {
      type: "object",
      properties: { summary: { type: "string" } },
      additionalProperties: false,
    },
    exposure: ["method"],
    run: (ctx, channelId, args) => ctx.handlers.markConfigured(channelId, args),
  },
  {
    name: "reconnect",
    description: "Re-verify the Google credential and report auth status",
    schema: NO_ARGS,
    exposure: ["method"],
    needsRecovery: true,
    run: (ctx, channelId) => ctx.handlers.reconnect(channelId),
  },
  {
    name: "openThread",
    description: "Publish or focus a Gmail thread card",
    schema: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
      additionalProperties: false,
    },
    exposure: ["method"],
    auth: GMAIL_READ_AUTH,
    needsRecovery: true,
    run: (ctx, channelId, args) => ctx.handlers.openThread(channelId, args),
  },
  {
    name: "compose",
    description: "Create a Gmail compose card",
    schema: { type: "object", additionalProperties: true },
    exposure: ["method"],
    run: (ctx, channelId, args) => ctx.handlers.compose(channelId, args),
  },
  {
    name: "draftReply",
    description: "Create an AI-drafted reply compose card for a Gmail thread",
    schema: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
      additionalProperties: true,
    },
    exposure: ["method"],
    auth: GMAIL_SEND_AS_AUTH,
    needsRecovery: true,
    run: (ctx, channelId, args) => ctx.handlers.draftReply(channelId, args),
  },
  {
    name: "saveDraft",
    description: "Save a Gmail draft from a compose card",
    schema: { type: "object", additionalProperties: true },
    exposure: ["method"],
    auth: GMAIL_SEND_AS_AUTH,
    needsRecovery: true,
    run: (ctx, channelId, args) => ctx.handlers.saveDraft(channelId, args),
  },
  {
    name: "discardCompose",
    description: "Mark a Gmail compose card discarded",
    schema: { type: "object", additionalProperties: true },
    exposure: ["method"],
    run: (ctx, channelId, args) => ctx.handlers.discardCompose(channelId, args),
  },
  {
    name: "archiveThread",
    description: "Archive a Gmail thread",
    schema: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
      additionalProperties: false,
    },
    exposure: ["method"],
    auth: GMAIL_WRITE_AUTH,
    needsRecovery: true,
    run: (ctx, channelId, args) => ctx.handlers.archiveThread(channelId, args),
  },
  {
    name: "markRead",
    description: "Mark a Gmail thread read",
    schema: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
      additionalProperties: false,
    },
    exposure: ["method"],
    auth: GMAIL_WRITE_AUTH,
    needsRecovery: true,
    run: (ctx, channelId, args) => ctx.handlers.markRead(channelId, args),
  },
  {
    name: "resolveContact",
    description:
      "Resolve a person name to email candidates with interaction evidence (history first, Google contacts fallback)",
    schema: {
      type: "object",
      properties: { name: { type: "string" }, limit: { type: "number" } },
      required: ["name"],
      additionalProperties: false,
    },
    exposure: ["method"],
    auth: GMAIL_CONTACTS_AUTH,
    needsRecovery: true,
    run: (ctx, channelId, args) => ctx.handlers.resolveContact(channelId, args),
  },
  {
    name: "contactSuggest",
    description: "Fast typeahead over the derived address book (no network)",
    schema: {
      type: "object",
      properties: { prefix: { type: "string" }, limit: { type: "number" } },
      additionalProperties: false,
    },
    exposure: ["method"],
    run: (ctx, channelId, args) => ctx.handlers.contactSuggest(channelId, args),
  },
  {
    name: "listActionableThreads",
    description: "Return current actionable Gmail threads",
    schema: {
      type: "object",
      properties: { limit: { type: "number" } },
      additionalProperties: false,
    },
    exposure: ["method"],
    needsRecovery: true,
    run: (ctx, channelId, args) =>
      ctx.handlers.listActionableThreads(channelId, numberArg(record(args), "limit") ?? 6),
  },
  {
    name: "setPollInterval",
    description: "Configure Gmail polling interval",
    schema: {
      type: "object",
      properties: { pollIntervalMs: { type: "number" } },
      required: ["pollIntervalMs"],
      additionalProperties: false,
    },
    exposure: ["method"],
    run: (ctx, channelId, args) => ctx.handlers.setPollInterval(channelId, args),
  },
  {
    name: "getAttentionPrefs",
    description: "Read the channel's natural-language attention preferences",
    schema: NO_ARGS,
    exposure: ["method"],
    run: (ctx, channelId) => ctx.handlers.getAttentionPrefs(channelId),
  },

  // ── participant API (agent-to-agent; read/draft, never send) ─────────────
  {
    name: "gmail_query",
    description:
      "Agent API: search threads (cache-first). Returns { source, query, count, results: [{ threadId, subject, from, fromEmail, snippet, unread, date }] }.",
    schema: {
      type: "object",
      properties: { q: { type: "string" }, maxResults: { type: "number" } },
      required: ["q"],
      additionalProperties: false,
    },
    exposure: ["participant"],
    auth: GMAIL_READ_AUTH,
    needsRecovery: true,
    run: (ctx, channelId, args) => ctx.participantApi.query(channelId, args),
  },
  {
    name: "gmail_getThread",
    description: "Agent API: fetch sanitized thread contents",
    schema: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
      additionalProperties: false,
    },
    exposure: ["participant"],
    auth: GMAIL_READ_AUTH,
    run: (ctx, channelId, args) => ctx.participantApi.getThread(channelId, args),
  },
  {
    name: "gmail_getOverview",
    description: "Agent API: dashboard snapshot of mail state",
    schema: NO_ARGS,
    exposure: ["participant"],
    auth: GMAIL_READ_AUTH,
    needsRecovery: true,
    run: (ctx, channelId) =>
      ctx.participantApi.getOverview(channelId, ctx.queuedWakeCount(channelId)),
  },
  {
    name: "gmail_requestDraft",
    description: "Agent API: prepare a compose card in review state (never sends)",
    schema: { type: "object", additionalProperties: true },
    exposure: ["participant"],
    auth: GMAIL_SEND_AS_AUTH,
    needsRecovery: true,
    run: (ctx, channelId, args) => ctx.participantApi.requestDraft(channelId, args),
  },
  {
    name: "gmail_resolveContact",
    description:
      "Agent API: resolve a person name to email candidates with interaction evidence (read-only)",
    schema: {
      type: "object",
      properties: { name: { type: "string" }, limit: { type: "number" } },
      required: ["name"],
      additionalProperties: false,
    },
    exposure: ["participant"],
    auth: GMAIL_CONTACTS_AUTH,
    needsRecovery: true,
    run: (ctx, channelId, args) => ctx.participantApi.resolveContact(channelId, args),
  },
];

/** Dispatch index keyed by the exact current operation names. */
export function buildOperationIndex(): Map<string, GmailOperation> {
  const index = new Map<string, GmailOperation>();
  for (const op of GMAIL_OPERATIONS) {
    if (index.has(op.name)) throw new Error(`duplicate gmail operation: ${op.name}`);
    index.set(op.name, op);
  }
  return index;
}

export function toolOperations(): GmailOperation[] {
  return GMAIL_OPERATIONS.filter((op) => op.exposure.includes("tool"));
}

export function operationAuth(operation: string): GmailOperationAuth | undefined {
  return buildOperationIndex().get(operation)?.auth;
}

export function missingScopeActionForOperation(operation: string): string | undefined {
  const auth = operationAuth(operation);
  if (!auth) return undefined;
  const scopes = auth.requiredScopes.map((scope) => `\`${scope}\``).join(", ");
  const apis = auth.googleApis.join(", ");
  return `${auth.reconnectPrompt} Required scopes: ${scopes}. If reconnect still fails, enable ${apis} in the Google Cloud project and reconnect.`;
}

/** Methods advertised on the participant descriptor (UI + agent surfaces). */
export function advertisedMethods(): Array<{ name: string; description: string }> {
  return GMAIL_OPERATIONS.filter(
    (op) => op.exposure.includes("method") || op.exposure.includes("participant")
  ).map((op) => ({ name: op.name, description: op.description.split(". ")[0]! }));
}
