/**
 * Multi-agent addressing: one pure, unit-testable function that decides
 * whether a participant should respond to a channel message.
 *
 * Addressing data (`mentions`, `replyTo`, `to`) lives on the message payload
 * at the protocol level — never in ad-hoc metadata. Durable conversation
 * state (the last completed message's sender) is maintained by the channel DO
 * and passed in, so the decision survives agent hibernation and restarts.
 */

import type { ParticipantSelector } from "./events.js";

export const RESPOND_POLICIES = [
  "all",
  "mentioned",
  "mentioned-strict",
  "mentioned-or-followup",
  "from-participants",
] as const;

export type RespondPolicy = (typeof RESPOND_POLICIES)[number];

export function isRespondPolicy(value: unknown): value is RespondPolicy {
  return RESPOND_POLICIES.includes(value as RespondPolicy);
}

/**
 * Channel-level conversation policy.
 * - "directed" (default): agents do not pile onto other agents' messages —
 *   an agent-authored message only draws a response when it explicitly
 *   addresses the responder (mention / to / replyTo).
 * - "open": deliberate agent swarms; agent-authored messages are treated
 *   like user messages (still subject to the hop cap).
 * - "moderated": nobody responds unless explicitly addressed, regardless of
 *   per-participant policy.
 */
export const CONVERSATION_POLICIES = ["open", "directed", "moderated"] as const;
export type ConversationPolicy = (typeof CONVERSATION_POLICIES)[number];

export function isConversationPolicy(value: unknown): value is ConversationPolicy {
  return CONVERSATION_POLICIES.includes(value as ConversationPolicy);
}

/** Default cap on consecutive agent-to-agent replies in one causal chain. */
export const DEFAULT_AGENT_HOP_LIMIT = 4;

export interface AddressedMessage {
  senderParticipantId: string;
  /** Actor kind of the sender ("user" | "agent" | ...). */
  senderKind: string;
  mentions?: string[] | undefined;
  replyTo?: string | undefined;
  /** Participant id that authored the message being replied to, if known. */
  replyToSenderId?: string | undefined;
  to?: ParticipantSelector[] | undefined;
  /** Consecutive agent-authored hops in this causal chain (0 for users). */
  agentHops?: number | undefined;
}

export interface ResolveShouldRespondInput {
  event: AddressedMessage;
  self: { participantId: string; roles?: string[] | undefined };
  policy: RespondPolicy;
  /** Allow-list for the "from-participants" policy. */
  respondFrom?: readonly string[] | undefined;
  /** Participant ids currently in the channel (used by the pair heuristic). */
  participantIds: readonly string[];
  /** Durable last-completed-message sender from the channel DO. */
  lastCompletedSender: string | null;
  conversationPolicy?: ConversationPolicy | undefined;
  agentHopLimit?: number | undefined;
}

export interface ShouldRespondDecision {
  respond: boolean;
  /** Human-readable reason — logged so "why didn't it answer" is debuggable. */
  reason: string;
}

function selectorsInclude(
  selectors: ParticipantSelector[],
  self: { participantId: string; roles?: string[] | undefined }
): boolean {
  return selectors.some((selector) => {
    if (selector.kind === "all") return true;
    if (selector.kind === "participant") return selector.participantId === self.participantId;
    if (selector.kind === "role") {
      return selector.role !== undefined && (self.roles ?? []).includes(selector.role);
    }
    return false;
  });
}

function explicitlyAddressed(input: ResolveShouldRespondInput): boolean {
  const { event, self } = input;
  if (event.mentions?.includes(self.participantId)) return true;
  if (event.to && event.to.length > 0) return selectorsInclude(event.to, self);
  if (event.replyTo && event.replyToSenderId === self.participantId) return true;
  return false;
}

export function resolveShouldRespond(input: ResolveShouldRespondInput): ShouldRespondDecision {
  const { event, self, policy } = input;
  const conversationPolicy = input.conversationPolicy ?? "directed";

  if (event.senderParticipantId === self.participantId) {
    return { respond: false, reason: "own message" };
  }

  // Explicit direction excluding self is a hard no for every policy.
  if (event.to && event.to.length > 0 && !selectorsInclude(event.to, self)) {
    return { respond: false, reason: "message directed elsewhere (to)" };
  }

  const addressed = explicitlyAddressed(input);
  const senderIsAgent = event.senderKind === "agent";

  // Loop breaker: refuse past the hop cap even when explicitly addressed.
  if (senderIsAgent) {
    const hops = event.agentHops ?? 1;
    const limit = input.agentHopLimit ?? DEFAULT_AGENT_HOP_LIMIT;
    if (hops >= limit) {
      return { respond: false, reason: `agent hop limit reached (${hops}/${limit})` };
    }
  }

  if (conversationPolicy === "moderated" && !addressed) {
    return { respond: false, reason: "moderated channel: not explicitly addressed" };
  }

  // Agents don't pile onto other agents unless explicitly addressed
  // (or the channel deliberately runs an open swarm).
  if (senderIsAgent && conversationPolicy === "directed" && !addressed) {
    return { respond: false, reason: "agent sender, not addressed (directed channel)" };
  }

  if (policy === "all") {
    return { respond: true, reason: "policy all" };
  }

  if (policy === "from-participants") {
    const allowed = (input.respondFrom ?? []).includes(event.senderParticipantId);
    return allowed
      ? { respond: true, reason: "sender in respondFrom allow-list" }
      : { respond: false, reason: "sender not in respondFrom allow-list" };
  }

  if (addressed) {
    return { respond: true, reason: "explicitly addressed" };
  }

  if (policy === "mentioned-strict") {
    return { respond: false, reason: "mentioned-strict: not addressed" };
  }

  if (policy === "mentioned-or-followup") {
    return input.lastCompletedSender === self.participantId
      ? { respond: true, reason: "followup: self sent last completed message" }
      : { respond: false, reason: "not addressed and not a followup" };
  }

  // Default "mentioned" policy: also respond when self is the only other
  // participant besides the sender (a plain two-party conversation).
  const others = input.participantIds.filter((id) => id !== event.senderParticipantId);
  if (others.length === 1 && others[0] === self.participantId) {
    return { respond: true, reason: "only other participant" };
  }
  return { respond: false, reason: "not addressed (mentioned policy)" };
}
