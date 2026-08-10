/**
 * Shared Gmail card payload contracts.
 *
 * TS interfaces are imported by both the gmail-agent worker (emission) and
 * the skill renderers (consumption). The matching JSON Schema documents are
 * registered with the channel message types so the platform validates card
 * states at emission and fold time. Schemas are deliberately permissive
 * (`additionalProperties: true`, nothing hard-required beyond identity) so
 * renderers tolerate extra fields while still catching shape mistakes.
 */

import type { GmailThreadState } from "./renderers/gmail-thread.reducer.js";

// ── Attention/triage decisions ──────────────────────────────────────────────

export type GmailAttentionAction =
  | "surface"
  | "summarize"
  | "draft"
  | "archive"
  | "markRead";

/**
 * Why a thread surfaced. `directiveId`/`directiveName` are freeform labels
 * ("known-sender", "triage"); `reason` is the triage model's explanation.
 */
export interface GmailAttentionDecision {
  wake: boolean;
  directiveId?: string;
  directiveName?: string;
  reason?: string;
  actions?: GmailAttentionAction[];
}

export interface GmailAttentionHit {
  threadId: string;
  directiveId: string;
  directiveName: string;
  reason: string;
  actions: GmailAttentionAction[];
  matchedAt: number;
}

/** Natural-language attention preferences (replaces the old rule sets). */
export interface GmailAttentionPrefs {
  /** The user's standing triage preferences, in their own words. */
  preferencesText: string;
  /** Deterministic fast-path: wake for senders the user has replied to. */
  knownSenderShortcut: boolean;
  updatedAt: number;
}

// ── Card states ─────────────────────────────────────────────────────────────

export interface GmailThreadCardState extends GmailThreadState {
  threadId: string;
  subject: string;
  from: string;
  snippet: string;
  unread: boolean;
  inInbox: boolean;
  category?: string;
  actionable: boolean;
  attention?: GmailAttentionDecision;
  updatedAt: number;
}

export type GmailComposeStatus =
  | "drafting"
  | "review"
  | "sending"
  | "sent"
  | "saved"
  | "error"
  | "discarded";

/** Resolved recipient candidate (from resolveContact/contactSuggest). */
export interface GmailContactCandidate {
  email: string;
  displayName?: string;
  sentTo: number;
  receivedFrom: number;
  lastInteractionAt?: number;
  youReplied: boolean;
  source: "history" | "google-contacts";
  score: number;
}

export interface GmailComposeCardState {
  to?: string;
  cc?: string;
  bcc?: string;
  /** Send-as alias to send from (must be a configured alias). */
  from?: string;
  /** Available send-as aliases, default first; renderer shows a picker when >1. */
  fromOptions?: string[];
  subject?: string;
  body?: string;
  draftId?: string;
  threadId?: string;
  sourceThreadId?: string;
  status: GmailComposeStatus;
  error?: string;
  /** Recipient candidates the agent resolved; renderer offers one-click pick. */
  toCandidates?: GmailContactCandidate[];
}

export interface GmailSetupAuthState {
  status: "ok" | "reconnect-required" | "unknown";
}

export interface GmailSetupAddressBookState {
  /** People known from synced mail history. */
  knownPeople: number;
  /** Google contacts (People API) availability for fallback resolution. */
  googleContacts: "available" | "unavailable" | "unknown";
}

export interface GmailSetupState {
  status: "onboarding" | "configured";
  auth: GmailSetupAuthState;
  email?: string;
  setupSummary?: string;
  /** The user's natural-language attention preference, agent-maintained. */
  attentionPreference?: string;
  pollIntervalMs: number;
  lastSyncAt?: string;
  lastError?: string;
  addressBook?: GmailSetupAddressBookState;
}

/** One row in a digest or search-result card. */
export interface GmailDigestItem {
  threadId: string;
  from: string;
  subject: string;
  /** Agent-written one-liner: why this matters / what it says. */
  gist?: string;
  suggested?: "reply" | "archive" | "read" | "open";
  unread?: boolean;
}

/** Immutable per-wake digest card: posted once, scrolls away with chat. */
export interface GmailDigestCardState {
  generatedAt: number;
  /** Agent-written headline, e.g. "3 new — 1 needs a reply". */
  headline: string;
  unread?: number;
  items: GmailDigestItem[];
  /** Count of additional surfaced threads not shown ("ask me to list them"). */
  moreCount?: number;
}

/** Ephemeral search-results card; a new search creates a new card. */
export interface GmailSearchCardState {
  query: string;
  status: "searching" | "done" | "error";
  results: GmailDigestItem[];
  totalEstimate?: number;
  error?: string;
  searchedAt: number;
}

// ── JSON Schemas (registered with the channel message types) ───────────────

const ATTENTION_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    wake: { type: "boolean" },
    directiveId: { type: "string" },
    directiveName: { type: "string" },
    reason: { type: "string" },
    actions: { type: "array", items: { type: "string" } },
  },
} as const;

const THREAD_CARD_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    threadId: { type: "string" },
    subject: { type: "string" },
    from: { type: "string" },
    snippet: { type: "string" },
    participants: { type: "array", items: { type: "string" } },
    lastSnippet: { type: "string" },
    unreadCount: { type: "number" },
    hasDraft: { type: "boolean" },
    status: { enum: ["unread", "open", "archived"] },
    unread: { type: "boolean" },
    inInbox: { type: "boolean" },
    category: { type: "string" },
    actionable: { type: "boolean" },
    attention: ATTENTION_DECISION_SCHEMA,
    updatedAt: { type: "number" },
  },
  required: ["threadId"],
} as const;

export const GMAIL_THREAD_STATE_SCHEMA: Record<string, unknown> = THREAD_CARD_SCHEMA;

/** Thread updates are reducer patches (kind-tagged) or partial states. */
export const GMAIL_THREAD_UPDATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {
    kind: { type: "string" },
  },
};

const DIGEST_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    threadId: { type: "string" },
    from: { type: "string" },
    subject: { type: "string" },
    gist: { type: "string" },
    suggested: { enum: ["reply", "archive", "read", "open"] },
    unread: { type: "boolean" },
  },
  required: ["threadId", "from", "subject"],
} as const;

export const GMAIL_DIGEST_STATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {
    generatedAt: { type: "number" },
    headline: { type: "string" },
    unread: { type: "number" },
    items: { type: "array", items: DIGEST_ITEM_SCHEMA },
    moreCount: { type: "number" },
  },
  required: ["generatedAt", "headline", "items"],
};

export const GMAIL_SEARCH_STATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {
    query: { type: "string" },
    status: { enum: ["searching", "done", "error"] },
    results: { type: "array", items: DIGEST_ITEM_SCHEMA },
    totalEstimate: { type: "number" },
    error: { type: "string" },
    searchedAt: { type: "number" },
  },
  required: ["query", "status", "results", "searchedAt"],
};

/** Search updates are merge patches over the search card state. */
export const GMAIL_SEARCH_UPDATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {
    status: { enum: ["searching", "done", "error"] },
    results: { type: "array", items: DIGEST_ITEM_SCHEMA },
    totalEstimate: { type: "number" },
    error: { type: "string" },
  },
};

export const GMAIL_SETUP_STATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {
    status: { enum: ["onboarding", "configured"] },
    auth: {
      type: "object",
      additionalProperties: true,
      properties: { status: { enum: ["ok", "reconnect-required", "unknown"] } },
      required: ["status"],
    },
    email: { type: "string" },
    setupSummary: { type: "string" },
    attentionPreference: { type: "string" },
    pollIntervalMs: { type: "number" },
    lastSyncAt: { type: "string" },
    lastError: { type: "string" },
    addressBook: {
      type: "object",
      additionalProperties: true,
      properties: {
        knownPeople: { type: "number" },
        googleContacts: { enum: ["available", "unavailable", "unknown"] },
      },
    },
  },
  required: ["status", "auth", "pollIntervalMs"],
};

export const GMAIL_COMPOSE_STATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {
    to: { type: "string" },
    cc: { type: "string" },
    bcc: { type: "string" },
    from: { type: "string" },
    fromOptions: { type: "array", items: { type: "string" } },
    subject: { type: "string" },
    body: { type: "string" },
    draftId: { type: "string" },
    threadId: { type: "string" },
    sourceThreadId: { type: "string" },
    status: { enum: ["drafting", "review", "sending", "sent", "saved", "error", "discarded"] },
    error: { type: "string" },
    toCandidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          email: { type: "string" },
          displayName: { type: "string" },
          source: { type: "string" },
          score: { type: "number" },
        },
        required: ["email"],
      },
    },
  },
  required: ["status"],
};

/** Compose updates are merge patches over the compose state. */
export const GMAIL_COMPOSE_UPDATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {
    status: { enum: ["drafting", "review", "sending", "sent", "saved", "error", "discarded"] },
    error: { type: "string" },
    draftId: { type: "string" },
    body: { type: "string" },
  },
};
