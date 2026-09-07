/**
 * The platform-neutral quickfire view model (quickfire-overlay-spec §4, §7).
 *
 * These types started life in `apps/shell/overlay/quickfireSurfaceModel.ts` as
 * the props contract between the chrome owner and the overlay surface. The
 * mobile sheets render the same information natively, and the parity rule in
 * `apps/shell/SKILL.md` is explicit that the two clients share canonical
 * presentation *rules*, not renderer components — so the rules live here and
 * each client keeps its own renderer.
 *
 * Everything in this module is JSON-shaped: on desktop it still crosses a
 * process boundary as serialized overlay props.
 */

import type { TextMatchRange } from "@vibestudio/shared/panelChrome";

export type { TextMatchRange };

/** The four scopes of §1.2, in chip order. */
export type QuickfireMode = "all" | "commands" | "goto" | "quickfire";

export const QUICKFIRE_MODE_PREFIX: Record<
  QuickfireMode,
  "" | ">" | "@" | "/"
> = {
  all: "",
  commands: ">",
  goto: "@",
  quickfire: "/",
};

export const QUICKFIRE_MODE_CHIPS: Array<{
  mode: QuickfireMode;
  label: string;
}> = [
  { mode: "all", label: "All" },
  { mode: "commands", label: "Commands" },
  { mode: "goto", label: "Go to" },
  { mode: "quickfire", label: "Quickfire agent" },
];

/** Cycle order for repeating the palette accelerator while open (§1.3). */
export const QUICKFIRE_MODE_CYCLE: QuickfireMode[] = [
  "all",
  "commands",
  "goto",
  "quickfire",
];

export interface QuickfireRow {
  id: string;
  title: string;
  /**
   * Where the query matched the title. A palette that ranks by a match and then
   * refuses to show it makes the ordering look arbitrary.
   */
  titleRanges?: TextMatchRange[];
  /** Secondary line: where it leads, or what activating it will do. */
  meta?: string;
  /** Emoji or short glyph; neither client has an icon registry of its own. */
  icon?: string;
  /** Trailing chip, e.g. "Already open". */
  badge?: string;
  /** Trailing keyboard hint, display only. Desktop renders it; mobile does not. */
  accelerator?: string;
  danger?: boolean;
  /** Listed but not runnable in the current context. */
  disabled?: boolean;
}

export interface QuickfireToolCall {
  id: string;
  name: string;
  /** Running work, finished work, and work that ended badly must look different. */
  state: "running" | "done" | "failed";
  /** Named, bounded arguments from the canonical invocation request. */
  arguments?: QuickfireToolArgument[];
  output?: string;
  progress?: string[];
  failure?: string;
  /** Wall time the invocation record accounts for, when it has both ends. */
  durationMs?: number;
  /** The call paused for a decision; the approval card is where it is answered. */
  awaitingApproval?: boolean;
  /** Images the call produced. A screenshot tool that shows no screenshot is a
   *  tool the user has to take on faith. */
  images?: QuickfireImage[];
}

export interface QuickfireToolArgument {
  name: string;
  value: string;
  /** Known syntax only; renderers must not guess a grammar. */
  language?: string | null;
}

/**
 * An image a tool returned — a screenshot, a rendered chart.
 *
 * The bytes are *optional* on purpose. On desktop the transcript crosses a
 * process boundary as serialized overlay props on every reduce flush, and a
 * 400 KB screenshot re-serialized at 30 Hz is not a picture, it is a stall. So
 * the projection describes the image always and carries it only when the
 * surface may show it now: mobile, which has no boundary, gets it inline;
 * desktop asks for one on the user's gesture (`reveal-image`).
 */
export interface QuickfireImage {
  id: string;
  mimeType: string;
  width?: number;
  height?: number;
  /** Decoded size, for the "show it" affordance's label. */
  bytes: number;
  /** Present only when this surface may render it right now. */
  dataUrl?: string;
}

/** One attachment, named rather than counted — a count is not a description. */
export interface QuickfireAttachment {
  id: string;
  name: string;
  /** MIME type or a short kind word, whichever the channel recorded. */
  kind?: string;
  /** Bytes, when known; rendered as a human size. */
  size?: number;
}

export interface QuickfireGroup {
  key: string;
  label: string;
  rows: QuickfireRow[];
}

export interface QuickfireArgChip {
  name: string;
  label: string;
  value: string;
}

/** Breadcrumb state while a command's arguments are being collected (§4.2). */
export interface QuickfireArgSessionView {
  commandTitle: string;
  chips: QuickfireArgChip[];
  /** Placeholder for the argument being prompted. */
  activeLabel: string;
  error: string | null;
}

/** The persistent "which panel will this act on" line (§4.1). */
export interface QuickfireContextStrip {
  title: string;
  icon?: string;
  /** Set when the bound slot closed while the surface was open (§4.4). */
  lost?: boolean;
}

/** One rendered transcript line spoken by a participant. */
export interface QuickfireTranscriptMessage {
  kind: "message";
  id: string;
  /** "you" for this device's own messages, otherwise the agent handle. */
  author: "you" | "agent" | "other";
  authorLabel: string;
  /** Primary replies lead; intermediate narration remains supporting context. */
  tier?: "primary" | "secondary";
  /** Flattened plain text. Still the whole content for compact renderers. */
  text: string;
  /** Still streaming: render the live delta treatment. */
  streaming?: boolean;
  error?: boolean;
  /**
   * The failure text itself. `error` alone says a turn broke without saying
   * how, which leaves the user with nothing to act on in a venue whose whole
   * point is speed.
   */
  errorText?: string;
  /** Which model produced this, when the channel recorded one. */
  modelLabel?: string;
  /** Named attachments. Announcing "2 attachments" told the user nothing. */
  attachments?: QuickfireAttachment[];
  /** Epoch ms this message landed; display only, and absent when unrecorded. */
  at?: number;
  /** The author revised it after sending. */
  edited?: boolean;
  /**
   * The escalation the sender declared (messaging plan §4.5). This is the whole
   * reason a notification-bound conversation is open at all, so the surface says
   * what rung it came in on and what the sender called it.
   */
  escalation?: { alert: "inbox" | "interrupt"; title?: string };
  /**
   * Sent from this surface but not yet acknowledged by the channel — including
   * text queued while the conversation was still binding. Without this the
   * first message a user ever sends here vanishes until the agent replies.
   */
  pending?: boolean;
}

/** A non-conversational line: lifecycle, diagnostic, fork, or task marginalia. */
export interface QuickfireTranscriptNotice {
  kind: "notice";
  id: string;
  severity: "info" | "warning" | "error";
  title: string;
  detail?: string;
  /**
   * The chat panel offers a recovery this venue cannot run (resume at reset,
   * retry on a local model, start clean). The overlay says so and offers the
   * panel rather than pretending the notice is inert.
   */
  recoverable?: boolean;
  at?: number;
}

/**
 * Agent-authored rich content this venue deliberately does not execute: inline
 * UI cards and custom message types (command-overlay client-runtime plan §2).
 *
 * It used to be dropped from the projection entirely, so an agent that answered
 * with a card produced a conversation with a visible gap in it. Now it is
 * announced, described by whatever the channel recorded, and offered to the one
 * surface that can run it.
 */
export interface QuickfireTranscriptRich {
  kind: "rich";
  id: string;
  /** "Interactive card", "Chart" — the type's own name where the channel has one. */
  title: string;
  detail?: string;
  at?: number;
}

/** The agent is doing something that has not produced a message yet. */
export interface QuickfireTranscriptActivity {
  kind: "activity";
  id: string;
  state: "working" | "waiting";
  phase: "starting" | "thinking" | "using-tools" | "responding" | "waiting";
  /** What can make a parked turn runnable again. */
  waitingFor?: "user" | "background" | "external";
  label: string;
}

/** A model reasoning record, intentionally distinct from its eventual reply. */
export interface QuickfireTranscriptThinking {
  kind: "thinking";
  id: string;
  text: string;
  streaming?: boolean;
}

/** One invocation at its canonical position in channel history. */
export interface QuickfireTranscriptTool {
  kind: "tool";
  id: string;
  call: QuickfireToolCall;
}

/** A user decision the compact venue cannot answer inline. */
export interface QuickfireTranscriptApproval {
  kind: "approval";
  id: string;
  status: "pending" | "granted" | "denied";
  question: string;
  reason?: string;
  /** What is actually being asked for, when the request carried a payload. */
  detail?: string;
  at?: number;
}

export type QuickfireTranscriptEntry =
  | QuickfireTranscriptMessage
  | QuickfireTranscriptTool
  | QuickfireTranscriptNotice
  | QuickfireTranscriptActivity
  | QuickfireTranscriptThinking
  | QuickfireTranscriptApproval
  | QuickfireTranscriptRich;

/**
 * Resume state for a conversation that already existed when the surface opened
 * (§1.4). `messageCount` is null when the channel log could not be read — the
 * chip says "resumed" without inventing a count.
 */
export interface QuickfireResumeChip {
  messageCount: number | null;
  /** Epoch ms of the last durable message; display only, never an expiry. */
  lastActivityAt: number | null;
}

/** The `/` mode conversation view. */
export interface QuickfireComposeView {
  /**
   * What the conversation is bound to (messaging plan §4.8). `slot` is the
   * Quickfire agent over a panel; `conversation` is an existing channel opened
   * from a notification — no clear, no fresh, and "promote" means "open its
   * chat panel". Absent ⇒ `slot`.
   */
  kind?: "slot" | "conversation";
  panelTitle: string;
  hint: string;
  /**
   * Which end of the conversation the transcript is rendered from. Presentation
   * only — the projection has already ordered the messages; the renderer uses
   * this to place the compose hint next to the input rather than after the
   * oldest message.
   */
  transcriptOrder?: "oldest-first" | "newest-first";
  /** Why sending is unavailable right now; null when the user can type. */
  disabledReason: string | null;
  /** Bounded tail of the conversation: last N entries plus the live delta. */
  transcript: QuickfireTranscriptEntry[];
  /**
   * How many entries the bound dropped. The compact venue keeps a tail on
   * purpose, but silently showing 20 of 200 reads as "this is the whole
   * conversation", so the count is offered alongside the way to see them all.
   */
  olderCount: number;
  /**
   * Whether those older entries can be shown here, right now, without leaving.
   * The venue keeps a tail on purpose, but "N older entries hidden" with no way
   * to see them is the surface telling the user it knows something they cannot
   * have; the replay the client already holds is enough to widen the window.
   */
  expandable: boolean;
  /** True while the preceding durable history page is being fetched. */
  loadingOlder: boolean;
  /** A model credential request the compact surface cannot complete inline. */
  credentialRequest: { providerId: string; reason: string | null } | null;
  /** Non-null only when this open resumed an existing conversation. */
  resume: QuickfireResumeChip | null;
  /**
   * The message this surface was opened *on* — the notification the person
   * tapped (messaging plan §4.8). Opening a conversation and leaving the user
   * to work out which line they were called about is most of what made the
   * notification path feel like a dead end, so the entry is marked.
   */
  focusMessageId?: string | null;
  /** True while the conversation is still being resolved/created. */
  connecting: boolean;
  /** True while an agent turn is open; the compose row shows a stop affordance. */
  streaming: boolean;
  /**
   * The conversation was promoted to a chat panel, which now owns it (§1.4).
   * The client offers "continued in chat panel →" plus "start a new
   * conversation here" instead of a compose row.
   */
  promoted: boolean;
  /** True once a conversation exists, enabling clear/promote in the header. */
  hasConversation: boolean;
  /** Set when resolving or sending failed; shown inline, never as a modal. */
  error: string | null;
  /**
   * One-tap openers for an empty conversation.
   *
   * A blank box under "ask about this panel" tells you the venue exists and
   * nothing about what it can do. These are the capabilities, phrased as the
   * questions people actually arrive with, and they are panel-aware because a
   * browser panel and a workspace panel are asked different things.
   */
  suggestions?: QuickfireSuggestion[];
}

export interface QuickfireSuggestion {
  id: string;
  label: string;
  /** What is actually sent; usually longer than the label. */
  prompt: string;
}
