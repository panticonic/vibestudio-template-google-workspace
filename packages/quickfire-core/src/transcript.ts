/**
 * Pure projection from a reduced channel view to the bounded transcript tail the
 * quickfire surfaces render (quickfire-overlay-spec §2.4).
 *
 * Kept apart from the session hook so it can be tested without standing up any
 * RPC transport: this is where the transcript's shape, ordering, and truncation
 * rule are decided, and those are the parts worth pinning down. Both the desktop
 * overlay and the mobile sheet render this exact projection.
 *
 * What a message IS comes from `chatMessagesFromChannelView` — the same merge
 * the chat panel reads. This surface used to keep only `text` blocks off the raw
 * view, which meant an approval request, a rate-limit diagnostic, a lifecycle
 * notice, and a turn that ended without a reply all rendered as nothing at all.
 * The compact venue is entitled to draw those *briefly*; it is not entitled to
 * not know about them. Only presentation is decided here.
 */

import type { ChannelViewState } from "@workspace/agentic-protocol";
import { chatMessagesFromChannelView } from "@workspace/agentic-core/channel-chat-merge";
import {
  base64ByteLength,
  extractResultImages,
  imageDataUrl,
} from "@workspace/agentic-core/result-images";
import type { ChatMessage } from "@workspace/agentic-core/channel-chat-merge";
import type {
  QuickfireToolCall,
  QuickfireTranscriptEntry,
  QuickfireTranscriptMessage,
} from "./model";

/** Last N entries pushed to the surface (§2.4). */
export const TRANSCRIPT_LIMIT = 20;

/**
 * Which end of the conversation a surface reads from.
 *
 * The two clients genuinely differ, so this is a parameter rather than a
 * constant. The mobile sheet is a chat: compose at the bottom, oldest first,
 * newest above the keyboard. The desktop overlay puts the one input at the TOP,
 * where the palette's input already lives — so the newest message belongs
 * directly under it, and older ones recede downward. Truncation is unaffected:
 * both keep the same last N, and only the render order differs.
 */
export type TranscriptOrder = "oldest-first" | "newest-first";

export interface TranscriptProjectionOptions {
  limit?: number;
  /**
   * How image results reach the surface. `inline` embeds them (mobile, and any
   * renderer in the same process); `on-demand` describes them and embeds only
   * the ones the user has asked to see (`revealedImageIds`), because the desktop
   * overlay's props are IPC.
   */
  imageDelivery?: "inline" | "on-demand";
  revealedImageIds?: ReadonlySet<string>;
  order?: TranscriptOrder;
  /**
   * Text sent from this surface that the channel has not echoed back yet,
   * including sends still queued behind the binding handshake.
   */
  pendingTexts?: readonly string[];
  /** A local send was accepted but its durable agent turn has not arrived yet. */
  awaitingResponse?: boolean;
}

export interface TranscriptProjection {
  entries: QuickfireTranscriptEntry[];
  /** Entries the bound dropped, so the surface can say so honestly. */
  olderCount: number;
}

/**
 * Content types this venue renders through some *other* record, so projecting
 * them again would double up rather than add anything.
 *
 * Progress cards are represented by their invocation record; the credential
 * request is the compose row's own banner; a typing pill is the activity row.
 * Note what is NOT here any more: `inline_ui` and `custom` used to be dropped
 * outright, which turned an agent's card into a hole in the conversation. This
 * venue still will not execute them — it announces them and offers the surface
 * that can (see `projectRichContent`).
 */
const REPRESENTED_ELSEWHERE = new Set([
  "toolcall-progress",
  "credential-connect",
  "typing",
]);

/**
 * Project the reduced channel view into the bounded tail the surface renders.
 *
 * Exported for tests: this is the only place transcript shape is decided. The
 * truncation rule is always "last N"; `order` decides only which end the caller
 * reads from, and the surface's scroll behavior follows it.
 */
export function projectTranscript(
  state: ChannelViewState,
  selfParticipantKey: string | null,
  options: TranscriptProjectionOptions = {},
): TranscriptProjection {
  const {
    limit = TRANSCRIPT_LIMIT,
    order = "oldest-first",
    pendingTexts = [],
    awaitingResponse = false,
    imageDelivery = "inline",
    revealedImageIds,
  } = options;
  const merged = chatMessagesFromChannelView(state);
  const toolCalls = projectToolCalls(state, {
    imageDelivery,
    ...(revealedImageIds ? { revealedImageIds } : {}),
  });

  const projected: QuickfireTranscriptEntry[] = [];
  for (const message of merged) {
    if (message.retracted) continue;
    if (message.contentType && REPRESENTED_ELSEWHERE.has(message.contentType))
      continue;
    const entry = projectChatMessage(
      message,
      selfParticipantKey,
      toolCalls,
      messageTimeOf(state, message.id),
    );
    if (entry) projected.push(entry);
  }

  // Optimistic echoes follow the durable transcript. Activity comes after
  // them: work starts because of the send, and both renderer orders therefore
  // place the live status between the input and the message that caused it.
  for (const [index, text] of pendingTexts.entries()) {
    projected.push({
      kind: "message",
      id: `pending:${index}:${text.slice(0, 32)}`,
      author: "you",
      authorLabel: "you",
      text,
      pending: true,
    });
  }

  // A turn that is open but has produced nothing yet is the case the overlay
  // most needed and least had: the user pressed Enter and the card sat blank.
  const activity = currentActivity(state, awaitingResponse);
  if (activity) projected.push(activity);

  // Truncate before reordering: the bound is on WHICH entries are kept (the
  // newest N), never on which end they are read from.
  const olderCount = Math.max(0, projected.length - limit);
  const tail = projected.slice(-limit);
  return {
    entries: order === "newest-first" ? [...tail].reverse() : tail,
    olderCount,
  };
}

function projectChatMessage(
  message: ChatMessage,
  selfParticipantKey: string | null,
  toolCalls: ToolCallProjection,
  at: number | undefined,
): QuickfireTranscriptEntry | null {
  const { contentType } = message;
  const when = at === undefined ? {} : { at };

  if (contentType === "inline_ui" || contentType === "custom") {
    return projectRichContent(message, when);
  }

  if (contentType === "invocation" && message.invocation) {
    const call = toolCalls.byId.get(message.invocation.id);
    return call ? { kind: "tool", id: message.id, call } : null;
  }

  if (contentType === "thinking") {
    const text = message.content ?? "";
    if (!text.trim()) return null;
    return {
      kind: "thinking",
      id: message.id,
      text,
      ...(message.complete === false ? { streaming: true } : {}),
    };
  }

  if (contentType === "approval" && message.approval) {
    const question = message.approval.question ?? message.content;
    return {
      kind: "approval",
      id: message.id,
      status:
        message.approval.status === "granted"
          ? "granted"
          : message.approval.status === "denied"
            ? "denied"
            : "pending",
      question,
      ...(message.approval.reason ? { reason: message.approval.reason } : {}),
      // The question is the headline; anything else the card carried is the
      // detail behind it, which the compact venue keeps behind a disclosure
      // rather than discarding.
      ...(message.content && message.content !== question
        ? { detail: message.content }
        : {}),
      ...when,
    };
  }

  if (contentType === "diagnostic" && message.diagnostic) {
    const severity =
      message.diagnostic.severity === "error"
        ? "error"
        : message.diagnostic.severity === "warning"
          ? "warning"
          : "info";
    return {
      kind: "notice",
      id: message.id,
      severity,
      title: message.diagnostic.title,
      ...((message.diagnostic.detail ?? message.content)
        ? { detail: message.diagnostic.detail ?? message.content }
        : {}),
      // The panel offers "Resume at reset" / "Retry with local model" here.
      // This venue cannot run either, so it advertises the panel instead.
      ...(message.diagnostic.resetAt || severity === "error"
        ? { recoverable: true }
        : {}),
      ...when,
    };
  }

  if (contentType === "lifecycle" && message.lifecycle) {
    if (message.lifecycle.status === "waiting") {
      return {
        kind: "activity",
        id: message.id,
        state: "waiting",
        phase: "waiting",
        waitingFor: waitingTarget(message.lifecycle.reason),
        label: message.lifecycle.title,
      };
    }
    return {
      kind: "notice",
      id: message.id,
      severity: "info",
      title: message.lifecycle.title,
      ...((message.lifecycle.detail ?? message.content)
        ? { detail: message.lifecycle.detail ?? message.content }
        : {}),
      ...when,
    };
  }

  if (contentType === "task" && message.task) {
    const task = message.task;
    const status = task.execution.status;
    return {
      kind: "notice",
      id: message.id,
      severity: status === "error" ? "error" : "info",
      title: task.title || "Background task",
      ...(task.execution.description
        ? { detail: task.execution.description }
        : status === "running" || status === "pending"
          ? { detail: "In progress" }
          : {}),
      ...when,
    };
  }

  if (contentType === "fork" || contentType === "cross-channel-sent") {
    // Marginalia: it happened, it is not a turn here, and this venue offers no
    // way to switch conversations — so it is stated and not made actionable.
    return {
      kind: "notice",
      id: message.id,
      severity: "info",
      title:
        contentType === "fork"
          ? "This conversation was forked"
          : "Sent in another conversation",
      ...(message.content ? { detail: message.content } : {}),
      ...when,
    };
  }

  if (contentType === "automation") {
    return {
      kind: "notice",
      id: message.id,
      severity: "info",
      title: message.content || "Automation ran",
      ...when,
    };
  }

  const text = message.content ?? "";
  const hasBody = text.trim().length > 0;
  const senderType = message.senderMetadata?.type;
  const isAgent = senderType === "agent";
  const isSelf =
    selfParticipantKey !== null && message.senderId === selfParticipantKey;
  const streaming = message.complete === false && !message.error;

  // A bodiless message with no tool records, errors, or attachments is noise.
  if (!hasBody && !message.error && !message.attachments?.length) return null;

  const projectedMessage: QuickfireTranscriptMessage = {
    kind: "message",
    id: message.id,
    author: isSelf ? "you" : isAgent ? "agent" : "other",
    authorLabel: isSelf
      ? "you"
      : (message.senderMetadata?.name ?? (isAgent ? "agent" : "someone")),
    text,
    ...(message.tier === "secondary" ? { tier: "secondary" as const } : {}),
    ...(streaming ? { streaming: true } : {}),
    ...(message.error ? { error: true, errorText: message.error } : {}),
    ...(message.pending ? { pending: true } : {}),
    ...(message.model?.displayName || message.model?.ref
      ? {
          modelLabel: (message.model.displayName ||
            message.model.ref) as string,
        }
      : {}),
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((attachment, index) => ({
            id: attachment.id || `${message.id}:${index}`,
            name: attachment.name || `attachment ${index + 1}`,
            ...(attachment.mimeType ? { kind: attachment.mimeType } : {}),
            ...(attachment.data?.length
              ? { size: attachment.data.length }
              : {}),
          })),
        }
      : {}),
    ...(message.editedAt || message.revision ? { edited: true } : {}),
    ...(message.escalation && message.escalation.alert !== "none"
      ? {
          escalation: {
            alert: message.escalation.alert,
            ...(message.escalation.title
              ? { title: message.escalation.title }
              : {}),
          },
        }
      : {}),
    ...when,
  };
  return projectedMessage;
}

function waitingTarget(
  reason: string | undefined,
): "user" | "background" | "external" {
  if (reason === "waiting_for_background") return "background";
  if (
    reason === "input_required" ||
    reason === "model_credential_required" ||
    reason === "model_credential_reconnect_required"
  ) {
    return "user";
  }
  return "external";
}

/**
 * An agent-authored card this venue does not run (plan §2).
 *
 * Naming it and saying where it *can* be opened is the honest form; the earlier
 * behavior — dropping it — made the transcript disagree with the channel about
 * what had been said.
 */
function projectRichContent(
  message: ChatMessage,
  when: { at?: number },
): QuickfireTranscriptEntry {
  const typeId = message.custom?.typeId;
  const failure = message.custom?.error?.message;
  // `content` for these rows is the card's serialized payload, not prose. It is
  // the card's *state*, so showing it here would be a wall of JSON where a
  // sentence belongs; the card's own surface is the place that renders it.
  return {
    kind: "rich",
    id: message.id,
    title: typeId ? `Card · ${typeId}` : "Interactive card",
    ...(failure ? { detail: failure } : {}),
    ...when,
  };
}

/**
 * Epoch ms for a message, read from the durable record rather than invented.
 *
 * `ChatMessage` carries no timestamp — the merge is about content — so the time
 * comes from the projected envelope that produced it. A message the channel
 * never timestamped simply has none, and the surface omits the field instead of
 * showing "just now" for something from yesterday.
 */
function messageTimeOf(
  state: ChannelViewState,
  messageId: string,
): number | undefined {
  const projected = state.messages[messageId];
  const stamp =
    projected?.completedAt ?? projected?.startedAt ?? projected?.updatedAt;
  if (!stamp) return undefined;
  const parsed = Date.parse(stamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Full display data for each invocation, keyed by the canonical invocation id.
 * Ordering is deliberately not decided here: the channel merge intersperses
 * invocation and reasoning messages by their recorded lifecycle timestamps.
 */
interface ToolCallProjection {
  byId: Map<string, QuickfireToolCall>;
}

function projectToolCalls(
  state: ChannelViewState,
  images: {
    imageDelivery: "inline" | "on-demand";
    revealedImageIds?: ReadonlySet<string>;
  },
): ToolCallProjection {
  const byId = new Map<string, QuickfireToolCall>();
  for (const invocation of Object.values(state.invocations)) {
    if (!invocation.turnId) continue;
    if (typeof invocation.name !== "string" || invocation.name.length === 0)
      continue;
    const progress = invocation.progress
      .map(
        (item) =>
          item.message ??
          (item.data === undefined ? "" : formatDetail(item.data)),
      )
      .filter(Boolean)
      .slice(-20);
    const failure = invocation.failure ?? invocation.terminalReason;
    const resultImages = extractResultImages(
      invocation.result ?? invocation.outputs,
    ).map((image, index) => {
      const id = `${invocation.invocationId}:${index}`;
      const visible =
        images.imageDelivery === "inline" ||
        images.revealedImageIds?.has(id) === true;
      return {
        id,
        mimeType: image.mimeType,
        ...(image.width === undefined ? {} : { width: image.width }),
        ...(image.height === undefined ? {} : { height: image.height }),
        bytes: base64ByteLength(image.data),
        ...(visible ? { dataUrl: imageDataUrl(image) } : {}),
      };
    });
    const duration = durationBetween(
      invocation.startedAt,
      invocation.completedAt ?? invocation.updatedAt,
    );
    const call: QuickfireToolCall = {
      id: invocation.invocationId,
      name: invocation.name,
      state:
        invocation.status === "failed" ||
        invocation.status === "cancelled" ||
        invocation.status === "abandoned"
          ? "failed"
          : invocation.status === "completed"
            ? "done"
            : "running",
      ...(invocation.request === undefined
        ? {}
        : { arguments: formatToolArguments(invocation.request) }),
      ...(invocation.result === undefined && invocation.outputs.length === 0
        ? {}
        : {
            output: formatDetail(
              invocation.result === undefined
                ? invocation.outputs
                : invocation.result,
            ),
          }),
      ...(progress.length > 0 ? { progress } : {}),
      ...(failure ? { failure: formatDetail(failure) } : {}),
      ...(duration === undefined ? {} : { durationMs: duration }),
      ...(invocation.requiresApproval && invocation.status !== "completed"
        ? { awaitingApproval: true }
        : {}),
      ...(resultImages.length > 0 ? { images: resultImages } : {}),
    };
    byId.set(invocation.invocationId, call);
  }
  return { byId };
}

function currentActivity(
  state: ChannelViewState,
  awaitingResponse: boolean,
): QuickfireTranscriptEntry | null {
  const turns = Object.values(state.turns).sort(
    (left, right) => activityOrder(right) - activityOrder(left),
  );
  const activeTurn = turns.find(
    (turn) => turn.status === "open" || turn.status === "waiting",
  );
  // Waiting turns are already projected by the canonical chat merge as a
  // lifecycle entry carrying the actual summary/reason. `projectChatMessage`
  // turns that one entry into the compact activity shape; adding another here
  // would render the same wait twice.
  if (activeTurn?.status === "waiting") return null;
  const orphanedRunningInvocation = Object.values(state.invocations).find(
    (invocation) =>
      invocation.status === "running" || invocation.status === "started",
  );
  const turnId = activeTurn?.turnId ?? orphanedRunningInvocation?.turnId;
  if (!turnId) {
    return awaitingResponse
      ? {
          kind: "activity",
          id: "activity:awaiting-response",
          state: "working",
          phase: "starting",
          label: "starting",
        }
      : null;
  }

  const hasRunningTool = Object.values(state.invocations).some(
    (invocation) =>
      invocation.turnId === turnId &&
      (invocation.status === "running" || invocation.status === "started"),
  );
  const turnMessages = Object.values(state.messages).filter(
    (message) =>
      message.turnId === turnId &&
      message.status !== "completed" &&
      message.status !== "failed",
  );
  const hasResponse = turnMessages.some((message) =>
    (message.blocks ?? []).some(
      (block) =>
        block.type === "text" && "content" in block && Boolean(block.content),
    ),
  );
  const phase = hasRunningTool
    ? "using-tools"
    : hasResponse
      ? "responding"
      : "thinking";
  return {
    kind: "activity",
    id: `activity:${turnId}`,
    state: "working",
    phase,
    label:
      phase === "using-tools"
        ? "using tools"
        : phase === "responding"
          ? "responding"
          : "thinking",
  };
}

/** Milliseconds between two ISO stamps, when both are present and sane. */
function durationBetween(
  from: string | undefined,
  to: string | undefined,
): number | undefined {
  if (!from || !to) return undefined;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return undefined;
  return end - start;
}

function activityOrder(turn: ChannelViewState["turns"][string]): number {
  if (turn.lastSeq !== undefined) return turn.lastSeq;
  const timestamp = Date.parse(turn.updatedAt ?? turn.openedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatDetail(value: unknown): string {
  const seen = new WeakSet<object>();
  let rendered: string;
  try {
    rendered =
      typeof value === "string"
        ? value
        : (JSON.stringify(
            value,
            (key, nested) => {
              if (
                (key === "data" || key === "base64") &&
                typeof nested === "string"
              ) {
                return `[${nested.length} characters omitted]`;
              }
              if (typeof nested === "string" && nested.length > 2_000) {
                return `${nested.slice(0, 2_000)}…`;
              }
              if (nested && typeof nested === "object") {
                if (seen.has(nested)) return "[circular]";
                seen.add(nested);
              }
              return nested;
            },
            2,
          ) ?? String(value));
  } catch {
    rendered = String(value);
  }
  return rendered.length > 6_000
    ? `${rendered.slice(0, 6_000)}\n… detail truncated`
    : rendered;
}

function formatToolArguments(
  value: unknown,
): NonNullable<QuickfireToolCall["arguments"]> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).map(
      ([name, argument]) => ({
        name,
        value: typeof argument === "string" ? argument : formatDetail(argument),
        ...argumentLanguage(name, argument),
      }),
    );
  }
  return [
    {
      name: "input",
      value: formatDetail(value),
      ...argumentLanguage("input", value),
    },
  ];
}

function argumentLanguage(name: string, value: unknown): { language?: string } {
  const key = name.toLowerCase();
  if (typeof value !== "string") return { language: "json" };
  if (/^(?:code|expression|javascript|js|script|source)$/u.test(key)) {
    return { language: "javascript" };
  }
  if (/^(?:typescript|ts)$/u.test(key)) return { language: "typescript" };
  if (/^(?:command|cmd|shell|bash)$/u.test(key)) return { language: "shell" };
  if (/^(?:css|html|xml|sql|json|markdown)$/u.test(key))
    return { language: key };
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") return { language: "json" };
  } catch {
    // Ordinary prose/path arguments stay monospace without pretend highlighting.
  }
  return {};
}

/** A turn is in flight while any turn is open or waiting on the user. */
export function hasOpenTurn(state: ChannelViewState): boolean {
  return Object.values(state.turns).some(
    (turn) => turn.status === "open" || turn.status === "waiting",
  );
}
