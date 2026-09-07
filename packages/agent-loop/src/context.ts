/**
 * buildModelContext (WS1 §1.4.1 / §2.4.1, pure): convert the folded session
 * entries into a model message array. Replaces buildSessionContext +
 * TrajectoryBackedSessionStorage — the log IS the session.
 */

import type {
  AgentState,
  AssistantModelIdentity,
  SessionEntry,
} from "./state.js";

export interface ModelMessage {
  role: "user" | "assistant" | "toolResult";
  content?: unknown;
  blocks?: unknown[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  model?: AssistantModelIdentity;
}

export function buildModelContext(
  state: AgentState,
  contextThroughSeq: number = Number.POSITIVE_INFINITY,
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const entry of state.entries) {
    if (entry.seq > contextThroughSeq) break;
    messages.push(modelMessageFromEntry(entry, state));
  }
  return messages;
}

/** Speaker label for an attributed (non-self) message — handle/name, else the id. */
function participantLabel(ref: {
  displayName?: string;
  metadata?: Record<string, unknown>;
  id: string;
}): string {
  const base = baseParticipantLabel(ref);
  // A guest envelope (messaging plan §4.6/§4.10.4): the speaker is not on this
  // roster, so `@handle` will not reach them. Say where they spoke from and the
  // exact ref that does, or the model has no way to answer.
  const origin = ref.metadata?.["origin"];
  const originChannelId =
    origin && typeof origin === "object"
      ? (origin as { channelId?: unknown }).channelId
      : undefined;
  if (typeof originChannelId === "string" && originChannelId) {
    const handle = ref.metadata?.["handle"];
    const replyRef =
      typeof handle === "string" && handle
        ? `agent:${handle}@${originChannelId}`
        : `channel:${originChannelId}`;
    return `${base} (guest from channel ${originChannelId}; reply with notify to:"${replyRef}")`;
  }
  return base;
}

function baseParticipantLabel(ref: {
  displayName?: string;
  metadata?: Record<string, unknown>;
  id: string;
}): string {
  if (typeof ref.displayName === "string" && ref.displayName)
    return ref.displayName;
  const handle = ref.metadata?.["handle"];
  if (typeof handle === "string" && handle) return handle;
  return ref.id;
}

/** Flatten an assistant message's blocks to its visible text (for attributed context). */
function assistantBlocksToText(blocks: unknown[]): string {
  const parts: string[] = [];
  for (const raw of blocks) {
    if (raw && typeof raw === "object") {
      const block = raw as Record<string, unknown>;
      if (block["type"] === "text") {
        const text =
          typeof block["content"] === "string"
            ? block["content"]
            : block["text"];
        if (typeof text === "string") parts.push(text);
      }
    }
  }
  return parts.join("\n").trim() || "(no text content)";
}

const STRUCTURED_INTERACTION_INSTRUCTION =
  "Act on this structured UI interaction now. Treat the interaction payload as authoritative; do not rediscover its target from visible labels or repository search.";

function interactiveUserContent(
  message: unknown,
  interaction: unknown,
): Record<string, unknown> {
  return {
    message,
    instruction: STRUCTURED_INTERACTION_INSTRUCTION,
    interaction,
  };
}

function modelMessageFromEntry(
  entry: SessionEntry,
  state: Pick<AgentState, "selfId" | "forkSeq" | "lineageSelfIds">,
): ModelMessage {
  switch (entry.kind) {
    case "user": {
      const interaction = entry.metadata?.interaction;
      if (entry.structuredInput !== undefined) {
        return {
          role: "user",
          content: interaction
            ? {
                ...interactiveUserContent(
                  readableUserMessage(entry.content),
                  interaction,
                ),
                structuredInput: entry.structuredInput,
              }
            : {
                message: readableUserMessage(entry.content),
                structuredInput: entry.structuredInput,
              },
        };
      }
      return {
        role: "user",
        content: interaction
          ? interactiveUserContent(entry.content, interaction)
          : entry.content,
      };
    }
    case "assistant": {
      // Another participant's message (e.g. a different agent in the channel) is presented
      // as an attributed `user` message, NOT as this agent's own prior `assistant` turn —
      // otherwise the model reads other agents' messages as its own voice and continues them.
      const author = entry.senderRef;
      const inheritedSelf =
        entry.seq <= state.forkSeq &&
        !!author?.id &&
        state.lineageSelfIds.includes(author.id);
      if (author?.id && author.id !== state.selfId && !inheritedSelf) {
        return {
          role: "user",
          content: `[${participantLabel(author)}]: ${assistantBlocksToText(entry.blocks)}`,
        };
      }
      return {
        role: "assistant",
        blocks: entry.blocks,
        ...(entry.model ? { model: entry.model } : {}),
      };
    }
    case "tool-result":
      return {
        role: "toolResult",
        toolCallId: entry.invocationId,
        toolName: entry.name,
        content: entry.result,
        isError: entry.isError,
      };
    case "note":
      return { role: "user", content: { note: entry.text } };
  }
}

/** Extract the readable text paired with a structured prompt sidecar. */
function readableUserMessage(content: unknown): unknown {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const blocks = (content as { blocks?: unknown }).blocks;
    if (Array.isArray(blocks)) {
      const text = blocks
        .map((block) =>
          block &&
          typeof block === "object" &&
          typeof (block as { content?: unknown }).content === "string"
            ? (block as { content: string }).content
            : null,
        )
        .filter((value): value is string => value !== null)
        .join("\n");
      if (text) return text;
    }
  }
  return content;
}
