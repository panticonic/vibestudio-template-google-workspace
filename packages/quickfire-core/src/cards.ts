/**
 * Transcript entries → the declarative cards both overlay renderers draw.
 *
 * The two clients used to each decide, inline and separately, what an entry's
 * heading said, which glyph it took, what colour it read as, which parts were
 * worth a disclosure and what a tool record's details were called. The results
 * drifted (desktop said "Agent active", mobile said "Agent active" but styled it
 * as an ordinary message; desktop rendered a notice as `title — detail` glued
 * into one Markdown string), and every one of those decisions was a *shared*
 * product decision made twice.
 *
 * So this module owns them. It is pure, takes `now` rather than reading a clock,
 * and emits nothing platform-specific: tones and glyph *names*, never colours or
 * icon components. A renderer's job shrinks to mapping a card onto its own
 * primitives, which is why the same card model can drive a DOM overlay and a
 * React Native sheet without either one re-deriving product meaning.
 */

import { markdownToPlainText, parseMarkdown } from "./markdown";
import type {
  QuickfireAttachment,
  QuickfireImage,
  QuickfireToolCall,
  QuickfireTranscriptEntry,
} from "./model";

/** Semantic colour role. Each client maps these onto its own palette. */
export type QuickfireTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "reasoning";

/** Semantic icon name. Each client maps these onto its own icon set. */
export type QuickfireGlyph =
  | "you"
  | "agent"
  | "person"
  | "spark"
  | "tool"
  | "check"
  | "cross"
  | "alert"
  | "info"
  | "clock"
  | "reasoning"
  | "card"
  | "paperclip"
  | "bell"
  | "gavel";

/** A small trailing label: state, model, count. Never the only carrier of meaning. */
export interface QuickfireBadge {
  id: string;
  label: string;
  tone: QuickfireTone;
}

/** A named block of detail, shown behind a disclosure. */
export interface QuickfireDetail {
  id: string;
  label: string;
  /** `code` is monospace and pre-wrapped; `markdown` goes through the parser. */
  format: "code" | "markdown" | "text";
  text: string;
  /** Optional grammar for code presentation and syntax highlighting. */
  language?: string | null;
}

/**
 * Something this venue cannot do itself.
 *
 * Both are honest about the venue's limits rather than pretending: the compact
 * surface shows the fact and points at the surface that can act on it.
 */
export type QuickfireCardActionId =
  | "open-chat"
  | "copy"
  /** Ask the chrome for an image's bytes (desktop; see `QuickfireImage`). */
  | "reveal-image"
  /** Put a message back on the wire — the user's own words, unchanged. */
  | "retry";

export interface QuickfireCardAction {
  id: QuickfireCardActionId;
  label: string;
  /** Payload: text to copy or resend, or the image id to reveal. */
  value?: string;
}

/** One tool invocation, ready to render. */
export interface QuickfireWorkRecord {
  id: string;
  name: string;
  state: QuickfireToolCall["state"];
  tone: QuickfireTone;
  glyph: QuickfireGlyph;
  /** "running", "failed", "1.2s" — what the collapsed pill says after the name. */
  statusLabel: string;
  details: QuickfireDetail[];
  /** Pictures the call produced, shown as pictures. */
  images: QuickfireImageView[];
  /** True while the call is in flight, so the pill can spin. */
  busy: boolean;
}

/** An image, either ready to draw or ready to be asked for. */
export interface QuickfireImageView {
  id: string;
  /** Set when the surface may draw it now. */
  dataUrl: string | null;
  /** "1280×800 · 402 KB" — enough to decide whether to ask for it. */
  label: string;
  alt: string;
}

export interface QuickfireCard {
  id: string;
  /** The entry kind this came from, for testing and for renderer-level tweaks. */
  kind: QuickfireTranscriptEntry["kind"];
  /** Speech reads as a bubble; the rest read as annotations on the conversation. */
  layout: "speech" | "note";
  role: "you" | "agent" | "person" | "system";
  /** Mirrors conversational message hierarchy; absent for non-message records. */
  tier?: "primary" | "secondary";
  tone: QuickfireTone;
  glyph: QuickfireGlyph;
  /** Heading: who spoke, or what happened. */
  title: string;
  /** Second heading line: model, time, escalation — the things worth a glance. */
  meta: string | null;
  badges: QuickfireBadge[];
  /** Main content. `null` when the card is only a heading plus details. */
  body: { format: "markdown" | "text"; text: string } | null;
  details: QuickfireDetail[];
  work: QuickfireWorkRecord[];
  actions: QuickfireCardAction[];
  /** Live: render the streaming treatment (caret, spinner). */
  busy: boolean;
  /**
   * Whether this card follows one from the same speaker, so the renderer can
   * drop the repeated heading the way the chat panel does.
   */
  continues: boolean;
  /** Flattened text for screen readers, copy, and search. */
  plainText: string;
  /** The entry this surface was opened on; drawn with an emphasis ring. */
  focused: boolean;
}

export interface QuickfireCardOptions {
  /** Epoch ms "now", passed in so the projection stays pure and testable. */
  now: number;
  /** Reading order of `entries`; grouping is computed chronologically either way. */
  order?: "oldest-first" | "newest-first";
  /** Entry id the surface was opened on, marked so the user can find it. */
  focusId?: string | null;
}

export function transcriptCards(
  entries: readonly QuickfireTranscriptEntry[],
  options: QuickfireCardOptions,
): QuickfireCard[] {
  const chronological =
    options.order === "newest-first" ? [...entries].reverse() : entries;
  const cards: QuickfireCard[] = [];
  for (const [index, entry] of chronological.entries()) {
    const previous = chronological[index - 1];
    cards.push({
      ...cardFor(entry, previous, options.now),
      focused: Boolean(options.focusId) && entry.id === options.focusId,
    });
  }
  return options.order === "newest-first" ? cards.reverse() : cards;
}

function cardFor(
  entry: QuickfireTranscriptEntry,
  previous: QuickfireTranscriptEntry | undefined,
  now: number,
): Omit<QuickfireCard, "focused"> {
  const card = buildCard(entry, now);
  return {
    ...card,
    continues:
      card.layout === "speech" &&
      previous?.kind === "message" &&
      entry.kind === "message" &&
      previous.author === entry.author &&
      previous.authorLabel === entry.authorLabel,
  };
}

/** Everything a card is except its place in the list. */
type CardCore = Omit<QuickfireCard, "continues" | "focused">;

function buildCard(entry: QuickfireTranscriptEntry, now: number): CardCore {
  switch (entry.kind) {
    case "message":
      return messageCard(entry, now);
    case "thinking":
      return thinkingCard(entry);
    case "tool":
      return toolCard(entry);
    case "activity":
      return activityCard(entry);
    case "notice":
      return noticeCard(entry, now);
    case "approval":
      return approvalCard(entry, now);
    case "rich":
      return richCard(entry, now);
  }
}

function toolCard(
  entry: Extract<QuickfireTranscriptEntry, { kind: "tool" }>,
): CardCore {
  const [record] = workRecords([entry.call]);
  return {
    id: entry.id,
    kind: "tool",
    layout: "note",
    role: "agent",
    tone: record?.tone ?? "neutral",
    glyph: record?.glyph ?? "tool",
    title: record?.name ?? entry.call.name,
    meta: record?.statusLabel ?? null,
    badges: [],
    body: null,
    details: [],
    work: record ? [record] : [],
    actions: [],
    busy: record?.busy ?? false,
    plainText: `${entry.call.name} — ${record?.statusLabel ?? entry.call.state}`,
  };
}

function messageCard(
  entry: Extract<QuickfireTranscriptEntry, { kind: "message" }>,
  now: number,
): CardCore {
  const badges: QuickfireBadge[] = [];
  if (entry.pending)
    badges.push({ id: "pending", label: "sending", tone: "neutral" });
  if (entry.error)
    badges.push({ id: "error", label: "failed", tone: "danger" });
  if (entry.edited)
    badges.push({ id: "edited", label: "edited", tone: "neutral" });
  if (entry.escalation) {
    badges.push({
      id: "escalation",
      label: entry.escalation.alert === "interrupt" ? "interrupt" : "inbox",
      tone: entry.escalation.alert === "interrupt" ? "warning" : "info",
    });
  }

  const details: QuickfireDetail[] = [];
  // The failure text, not just a red border. `error: true` alone told the user
  // that something broke and refused to say what.
  if (entry.errorText) {
    details.push({
      id: "error",
      label: "What went wrong",
      format: "text",
      text: entry.errorText,
    });
  }
  if (entry.attachments?.length) {
    details.push({
      id: "attachments",
      label: `Attachments · ${entry.attachments.length}`,
      format: "text",
      text: entry.attachments.map(describeAttachment).join("\n"),
    });
  }

  const meta = joinMeta([
    entry.escalation?.title ?? null,
    entry.modelLabel ?? null,
    entry.at === undefined ? null : relativeTime(entry.at, now),
  ]);
  const body = entry.text.trim()
    ? { format: "markdown" as const, text: entry.text }
    : null;
  const plainText = body ? markdownToPlainText(parseMarkdown(body.text)) : "";
  return {
    id: entry.id,
    kind: "message",
    layout: "speech",
    role:
      entry.author === "you"
        ? "you"
        : entry.author === "agent"
          ? "agent"
          : "person",
    tier: entry.tier ?? "primary",
    tone: entry.error
      ? "danger"
      : entry.author === "you"
        ? "accent"
        : "neutral",
    glyph:
      entry.author === "you"
        ? "you"
        : entry.author === "agent"
          ? "spark"
          : "person",
    title: entry.authorLabel,
    meta,
    badges,
    body,
    details,
    work: [],
    actions: [
      ...(entry.error && entry.author === "you"
        ? [{ id: "retry" as const, label: "Send again", value: entry.text }]
        : entry.error
          ? [openChat("Pick this up in the chat panel")]
          : []),
      ...(entry.text.trim()
        ? [{ id: "copy" as const, label: "Copy", value: entry.text }]
        : []),
    ],
    busy: entry.streaming === true,
    plainText: [entry.authorLabel, plainText, entry.errorText ?? ""]
      .filter(Boolean)
      .join("\n"),
  };
}

function thinkingCard(
  entry: Extract<QuickfireTranscriptEntry, { kind: "thinking" }>,
): CardCore {
  const plain = markdownToPlainText(parseMarkdown(entry.text));
  const heading = abbreviate(
    entry.streaming ? lastLine(plain) : firstLine(plain),
  );
  // When the whole thought fits in the heading, a disclosure would open onto a
  // copy of what you just read.
  const complete = heading === plain.trim();
  return {
    id: entry.id,
    kind: "thinking",
    layout: "note",
    role: "agent",
    tone: "reasoning",
    glyph: "reasoning",
    // Say what it thought, not that it thought. A stack of identical "Thought
    // for a moment" rows is a stack of rows carrying no information at all —
    // the one thing a collapsed record must never be. While the thought is
    // still arriving the newest line is the interesting one; once it has
    // settled, its opening line is what the rest hangs off.
    title: heading || "Thinking",
    meta: null,
    badges: [],
    body: null,
    // Reasoning is detail by definition: it opens on demand, and while it is
    // streaming the renderer opens it so the user can watch.
    details: complete
      ? []
      : [
          {
            id: "reasoning",
            label: "Reasoning",
            format: "markdown",
            text: entry.text,
          },
        ],
    work: [],
    actions: [],
    busy: entry.streaming === true,
    plainText: markdownToPlainText(parseMarkdown(entry.text)),
  };
}

function activityCard(
  entry: Extract<QuickfireTranscriptEntry, { kind: "activity" }>,
): CardCore {
  const working = entry.state === "working";
  const background =
    entry.state === "waiting" && entry.waitingFor === "background";
  const title = working
    ? "Working"
    : background
      ? "Working in background"
      : entry.waitingFor === "user"
        ? "Waiting for you"
        : "Waiting";
  return {
    id: entry.id,
    kind: "activity",
    layout: "note",
    role: "agent",
    tone: working || background ? "accent" : "warning",
    glyph: working || background ? "spark" : "clock",
    title,
    meta: entry.label,
    badges: [],
    body: null,
    details: [],
    work: [],
    actions: [],
    busy: working || background,
    plainText: `${title} — ${entry.label}`,
  };
}

function noticeCard(
  entry: Extract<QuickfireTranscriptEntry, { kind: "notice" }>,
  now: number,
): CardCore {
  const tone: QuickfireTone =
    entry.severity === "error"
      ? "danger"
      : entry.severity === "warning"
        ? "warning"
        : "info";
  return {
    id: entry.id,
    kind: "notice",
    layout: "note",
    role: "system",
    tone,
    glyph: entry.severity === "info" ? "info" : "alert",
    title: entry.title,
    meta: entry.at === undefined ? null : relativeTime(entry.at, now),
    badges: [],
    // The detail is the notice's own prose. Gluing it to the title with an em
    // dash — which is what both renderers did — made a two-sentence diagnostic
    // read as one run-on heading.
    body: entry.detail ? { format: "markdown", text: entry.detail } : null,
    details: [],
    work: [],
    actions: entry.recoverable
      ? [openChat("The chat panel can recover from this")]
      : [],
    busy: false,
    plainText: [entry.title, entry.detail ?? ""].filter(Boolean).join("\n"),
  };
}

function approvalCard(
  entry: Extract<QuickfireTranscriptEntry, { kind: "approval" }>,
  now: number,
): CardCore {
  const pending = entry.status === "pending";
  return {
    id: entry.id,
    kind: "approval",
    layout: "note",
    role: "system",
    tone: pending
      ? "warning"
      : entry.status === "granted"
        ? "success"
        : "danger",
    glyph: "gavel",
    title: pending
      ? "Waiting for your decision"
      : entry.status === "granted"
        ? "You allowed this"
        : "You declined this",
    meta: joinMeta([
      // Answering happens on the approval card, which floats beside this one
      // (spec §2.3a). Saying so is the difference between a card that looks
      // broken and one that tells you where the button is.
      pending ? "Answer it on the approval card" : null,
      entry.at === undefined ? null : relativeTime(entry.at, now),
    ]),
    badges: [],
    body: { format: "markdown", text: entry.question },
    details: [
      ...(entry.reason
        ? [
            {
              id: "reason",
              label: "Why",
              format: "markdown" as const,
              text: entry.reason,
            },
          ]
        : []),
      ...(entry.detail
        ? [
            {
              id: "detail",
              label: "Request",
              format: "code" as const,
              text: entry.detail,
            },
          ]
        : []),
    ],
    work: [],
    actions: [],
    busy: false,
    plainText: [entry.question, entry.reason ?? "", entry.detail ?? ""]
      .filter(Boolean)
      .join("\n"),
  };
}

function richCard(
  entry: Extract<QuickfireTranscriptEntry, { kind: "rich" }>,
  now: number,
): CardCore {
  return {
    id: entry.id,
    kind: "rich",
    layout: "note",
    role: "agent",
    tone: "info",
    glyph: "card",
    title: entry.title,
    meta: joinMeta([
      "Interactive here, not runnable here",
      entry.at === undefined ? null : relativeTime(entry.at, now),
    ]),
    badges: [],
    body: entry.detail ? { format: "markdown", text: entry.detail } : null,
    details: [],
    actions: [openChat("Open it in the chat panel")],
    work: [],
    busy: false,
    plainText: [entry.title, entry.detail ?? ""].filter(Boolean).join("\n"),
  };
}

/** First non-empty line — a thought's topic sentence. */
function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

/** Last non-empty line — where a thought currently is, while it streams. */
function lastLine(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim());
  return lines.at(-1)?.trim() ?? "";
}

/**
 * One line's worth of a thought.
 *
 * Cuts on a sentence boundary when there is one close enough to read as a
 * complete thought, and otherwise on a word boundary — never mid-word, which
 * reads as corruption rather than as truncation.
 */
const ABBREVIATED_LENGTH = 96;

export function abbreviate(text: string, limit = ABBREVIATED_LENGTH): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  const sentence = collapsed.slice(0, limit).match(/^.*?[.!?](?=\s)/u)?.[0];
  if (sentence && sentence.length > limit / 2) return sentence;
  const cut = collapsed.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function openChat(label: string): QuickfireCardAction {
  return { id: "open-chat", label };
}

function workRecords(
  calls: readonly QuickfireToolCall[] | undefined,
): QuickfireWorkRecord[] {
  if (!calls?.length) return [];
  return calls.map((call) => ({
    id: call.id,
    name: call.name,
    state: call.state,
    tone:
      call.state === "failed"
        ? "danger"
        : call.state === "running"
          ? "accent"
          : "success",
    glyph:
      call.state === "failed"
        ? "cross"
        : call.state === "running"
          ? "tool"
          : "check",
    statusLabel: workStatusLabel(call),
    busy: call.state === "running",
    details: workDetails(call),
    images: (call.images ?? []).map((image) => imageView(image, call.name)),
  }));
}

function workStatusLabel(call: QuickfireToolCall): string {
  if (call.awaitingApproval) return "waiting for approval";
  if (call.state === "running") {
    return call.progress?.length
      ? (call.progress.at(-1) ?? "running")
      : "running";
  }
  if (call.state === "failed") return "failed";
  return call.durationMs === undefined
    ? "done"
    : formatDuration(call.durationMs);
}

function workDetails(call: QuickfireToolCall): QuickfireDetail[] {
  const details: QuickfireDetail[] = [];
  for (const [index, argument] of (call.arguments ?? []).entries()) {
    details.push({
      id: `argument:${argument.name}:${index}`,
      label: argument.name,
      format: "code",
      text: argument.value,
      ...(argument.language ? { language: argument.language } : {}),
    });
  }
  if (call.progress?.length) {
    details.push({
      id: "progress",
      label: `Progress · ${call.progress.length}`,
      format: "text",
      text: call.progress.join("\n"),
    });
  }
  if (call.output) {
    details.push({
      id: "output",
      label: "Output",
      format: "code",
      text: call.output,
    });
  }
  if (call.failure) {
    details.push({
      id: "failure",
      label: "Failure",
      format: "code",
      text: call.failure,
    });
  }
  return details;
}

function imageView(
  image: QuickfireImage,
  toolName: string,
): QuickfireImageView {
  const size = [
    image.width && image.height ? `${image.width}×${image.height}` : null,
    formatBytes(image.bytes),
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    id: image.id,
    dataUrl: image.dataUrl ?? null,
    label: size,
    alt: `Image from ${toolName}`,
  };
}

function describeAttachment(attachment: QuickfireAttachment): string {
  const facts = [
    attachment.kind,
    attachment.size === undefined ? null : formatBytes(attachment.size),
  ]
    .filter(Boolean)
    .join(" · ");
  return facts ? `${attachment.name} (${facts})` : attachment.name;
}

function joinMeta(parts: ReadonlyArray<string | null>): string | null {
  const kept = parts.filter((part): part is string =>
    Boolean(part && part.trim()),
  );
  return kept.length > 0 ? kept.join(" · ") : null;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

/**
 * Coarse, human relative time. Display only — never an expiry, never a deadline.
 * Both clients had their own copy of this, and they disagreed about rounding.
 */
export function relativeTime(epochMs: number, now: number): string {
  const seconds = Math.round((now - epochMs) / 1_000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "Resumed · 3 messages · 2h ago"; each segment is omitted when unknown. */
export function resumeLabel(
  resume: { messageCount: number | null; lastActivityAt: number | null },
  now: number,
): string {
  const parts = ["Resumed"];
  if (resume.messageCount !== null) {
    parts.push(
      `${resume.messageCount} message${resume.messageCount === 1 ? "" : "s"}`,
    );
  }
  if (resume.lastActivityAt !== null)
    parts.push(relativeTime(resume.lastActivityAt, now));
  return parts.join(" · ");
}
