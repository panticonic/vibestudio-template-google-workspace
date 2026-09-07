import { CONTENT_TYPE_INLINE_UI, type MethodDefinition } from "@workspace/pubsub";
import type { ChatMessage } from "@workspace/agentic-core";

/**
 * Optional browser-owned surfaces that an AgenticChat participant can expose.
 *
 * The selection is a capability boundary, not merely a rendering preference:
 * omitted features are neither advertised as channel methods nor mounted by
 * the stock layout. The selection is fixed for the lifetime of a mounted chat
 * participant because changing its method surface requires a new channel join.
 */
export const AGENTIC_CHAT_FEATURES = [
  "feedback",
  "inline-ui",
  "action-bar",
  "client-eval",
] as const;

export type AgenticChatFeature = (typeof AGENTIC_CHAT_FEATURES)[number];

export interface ResolvedAgenticChatFeatures {
  readonly feedback: boolean;
  readonly inlineUi: boolean;
  readonly actionBar: boolean;
  readonly clientEval: boolean;
}

/** Explicit preset for hosts that want every stock AgenticChat capability. */
export const FULL_AGENTIC_CHAT_FEATURES: readonly AgenticChatFeature[] = AGENTIC_CHAT_FEATURES;

export function resolveAgenticChatFeatures(
  features: readonly AgenticChatFeature[]
): ResolvedAgenticChatFeatures {
  const selected = new Set(features);
  return Object.freeze({
    feedback: selected.has("feedback"),
    inlineUi: selected.has("inline-ui"),
    actionBar: selected.has("action-bar"),
    clientEval: selected.has("client-eval"),
  });
}

/**
 * Compose independently owned method groups and reject ambiguous ownership.
 * A duplicate method is a feature-boundary defect, so it fails before joining
 * the channel instead of relying on object-spread order.
 */
export function composeAgenticChatMethods(
  ...groups: Array<Record<string, MethodDefinition> | undefined>
): Record<string, MethodDefinition> {
  const methods: Record<string, MethodDefinition> = {};
  for (const group of groups) {
    if (!group) continue;
    for (const [name, definition] of Object.entries(group)) {
      if (Object.hasOwn(methods, name)) {
        throw new Error(`AgenticChat method ${JSON.stringify(name)} has multiple owners`);
      }
      methods[name] = definition;
    }
  }
  return methods;
}

/**
 * Apply the same capability selection to the stock transcript. The durable
 * channel view remains complete for custom consumers; only the stock
 * presentation omits historical inline UI when that surface is unavailable.
 */
export function selectAgenticChatTranscriptMessages(
  messages: ChatMessage[],
  features: ResolvedAgenticChatFeatures
): ChatMessage[] {
  return features.inlineUi
    ? messages
    : messages.filter((message) => message.contentType !== CONTENT_TYPE_INLINE_UI);
}
