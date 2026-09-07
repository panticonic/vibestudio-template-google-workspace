import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  agentToolFailureFromUnknown,
  invocationAbandonedPayload,
  invocationCancelledPayload,
  invocationCompletedPayload,
  invocationFailedPayload,
  type AgenticEvent,
  type InvocationId,
  type TurnId,
} from "@workspace/agentic-protocol";
import type {
  ChannelCallDescriptor,
  ChannelCallEventBuilders,
  ChannelCallTerminalInput,
  ChannelPolicy,
  PolicyAppendDraft,
  PolicyEnvelopeView,
} from "./index.js";

/** Wire shape of `getPolicyState("agentic.conversation.v1").state`. */
export interface ConversationStateV1 {
  lastCompletedSender: string | null;
  lastCompletedMessageId: string | null;
  lastCompletedSeq: number | null;
  /** = envelope.appendedAt of the last completed message — never wall clock. */
  lastCompletedAt: string | null;
  previousCompletedSender: string | null;
  previousCompletedMessageId: string | null;
  previousCompletedSeq: number | null;
  agentStreak: number;
}

function completedMessageFrom(envelope: PolicyEnvelopeView): AgenticEvent | null {
  if (envelope.payloadKind !== AGENTIC_EVENT_PAYLOAD_KIND) return null;
  const payload = envelope.payload as AgenticEvent | null;
  if (!payload || typeof payload !== "object") return null;
  if ((payload as { kind?: string }).kind !== "message.completed") return null;
  return payload;
}

function isAgentAuthoredCompleted(draft: PolicyAppendDraft): AgenticEvent | null {
  if (draft.payloadKind !== AGENTIC_EVENT_PAYLOAD_KIND) return null;
  const payload = draft.payload as AgenticEvent | null;
  if (!payload || typeof payload !== "object") return null;
  if ((payload as { kind?: string }).kind !== "message.completed") return null;
  if ((payload as { actor?: { kind?: string } }).actor?.kind !== "agent") return null;
  return payload;
}

function callerAudience(descriptor: Pick<ChannelCallDescriptor, "caller">) {
  return [
    {
      kind: "participant" as const,
      participantId: descriptor.caller.participantId ?? descriptor.caller.id,
    },
  ];
}

const callEventPayload: ChannelCallEventBuilders = {
  started(input: ChannelCallDescriptor): AgenticEvent {
    return {
      kind: "invocation.started",
      actor: input.caller,
      ...(input.turnId ? { turnId: input.turnId as TurnId } : {}),
      causality: {
        invocationId: input.invocationId as InvocationId,
        transportCallId: input.transportCallId,
      },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: input.method,
        invocationType: "panel",
        request: input.args,
        transport: {
          kind: "channel",
          channelId: input.channelId as never,
          target: input.target,
          transportCallId: input.transportCallId,
          ...(input.deadlineAt != null ? { deadlineAt: input.deadlineAt } : {}),
        },
        to: [
          {
            kind: "participant",
            participantId: input.target.participantId ?? input.target.id,
          },
        ],
        userVisible: false,
      },
      createdAt: input.createdAt,
    } as AgenticEvent;
  },

  terminal(input: ChannelCallTerminalInput): AgenticEvent {
    const { descriptor, result, isError, terminalOutcome, terminalReasonCode } = input;
    const reason = typeof result === "string" && result ? result : "method failed";
    const to = callerAudience(descriptor);
    const base = {
      actor: descriptor.caller,
      ...(descriptor.turnId ? { turnId: descriptor.turnId as TurnId } : {}),
      causality: {
        invocationId: descriptor.invocationId as InvocationId,
        ...(descriptor.transportCallId ? { transportCallId: descriptor.transportCallId } : {}),
      },
      createdAt: input.createdAt,
    };
    if (terminalOutcome === "cancelled" || terminalOutcome === "stale_dispatch") {
      return {
        kind: "invocation.cancelled",
        ...base,
        payload: invocationCancelledPayload(terminalOutcome, reason, {
          to,
          ...(typeof result === "string" ? {} : { error: result }),
          ...(terminalReasonCode ? { terminalReasonCode } : {}),
        }),
      } as AgenticEvent;
    }
    if (terminalOutcome === "abandoned") {
      return {
        kind: "invocation.abandoned",
        ...base,
        payload: invocationAbandonedPayload(reason, {
          to,
          ...(typeof result === "string" ? {} : { error: result }),
          ...(terminalReasonCode ? { terminalReasonCode } : {}),
        }),
      } as AgenticEvent;
    }
    const failedOutcome =
      terminalOutcome === "infrastructure_error" ? "infrastructure_error" : "tool_error";
    return {
      kind: isError ? "invocation.failed" : "invocation.completed",
      ...base,
      payload: isError
        ? invocationFailedPayload(failedOutcome, "method failed", {
            to,
            error: result,
            terminalReasonCode: terminalReasonCode ?? "method_failed",
            failure: agentToolFailureFromUnknown(result, {
              operation: descriptor.method,
              stage: "remote-call",
              causal: { invocationId: descriptor.invocationId },
              kind: failedOutcome === "infrastructure_error" ? "infrastructure" : undefined,
            }),
          })
        : invocationCompletedPayload({ result, to }),
    } as AgenticEvent;
  },

  output(input): AgenticEvent {
    const { descriptor } = input;
    return {
      kind: "invocation.output",
      actor: descriptor.caller,
      ...(descriptor.turnId ? { turnId: descriptor.turnId as TurnId } : {}),
      causality: {
        invocationId: descriptor.invocationId as InvocationId,
        ...(descriptor.transportCallId ? { transportCallId: descriptor.transportCallId } : {}),
      },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        output: input.output,
        to: callerAudience(descriptor),
      },
      createdAt: input.createdAt,
    } as AgenticEvent;
  },

  cancelled(input): AgenticEvent {
    const { descriptor } = input;
    return {
      kind: "invocation.cancelled",
      actor: input.actor,
      ...(descriptor.turnId ? { turnId: descriptor.turnId as TurnId } : {}),
      causality: {
        invocationId: descriptor.invocationId as InvocationId,
        ...(descriptor.transportCallId ? { transportCallId: descriptor.transportCallId } : {}),
      },
      payload: invocationCancelledPayload("cancelled", input.reason, {
        terminalReasonCode: "cancelled",
        to: callerAudience(descriptor),
      }),
      createdAt: input.createdAt,
    } as AgenticEvent;
  },
};

export const conversationV1Policy: ChannelPolicy<ConversationStateV1> = {
  name: "agentic.conversation.v1",
  version: 1,

  init(): ConversationStateV1 {
    return {
      lastCompletedSender: null,
      lastCompletedMessageId: null,
      lastCompletedSeq: null,
      lastCompletedAt: null,
      previousCompletedSender: null,
      previousCompletedMessageId: null,
      previousCompletedSeq: null,
      agentStreak: 0,
    };
  },

  reduce(state, envelope): ConversationStateV1 {
    const completed = completedMessageFrom(envelope);
    if (!completed) return state;
    const actorKind = (completed as { actor?: { kind?: string } }).actor?.kind;
    const causality = ((completed as { causality?: Record<string, unknown> }).causality ??
      {}) as Record<string, unknown>;
    const messageId = typeof causality["messageId"] === "string" ? causality["messageId"] : null;
    return {
      previousCompletedSender: state.lastCompletedSender,
      previousCompletedMessageId: state.lastCompletedMessageId,
      previousCompletedSeq: state.lastCompletedSeq,
      lastCompletedSender: envelope.senderId,
      lastCompletedMessageId: messageId,
      lastCompletedSeq: envelope.seq,
      lastCompletedAt: envelope.appendedAt,
      // Count agent→agent conversation HOPS (author alternations), NOT raw messages.
      // A single turn emits a `message.completed` per model-call round (messageId =
      // `m:${turnId}:${modelCallCount}`), so counting every message let ONE multi-step
      // agent turn (heavy tool use) trip the agent-hop breaker (DEFAULT_AGENT_HOP_LIMIT)
      // even with no actual back-and-forth. A real hop is "a different author replied",
      // so only increment when the sender changed from the last completed message; a human
      // message resets it.
      agentStreak:
        actorKind !== "agent"
          ? 0
          : envelope.senderId === state.lastCompletedSender
            ? state.agentStreak
            : state.agentStreak + 1,
    };
  },

  annotate(state, draft): Record<string, unknown> | null {
    const completed = isAgentAuthoredCompleted(draft);
    if (!completed) return null;
    const explicit = (completed as { causality?: { agentHops?: number } }).causality?.agentHops;
    // Caller-computed hop counts win (copied to annotations — the payload is
    // never mutated by the transport). Otherwise mirror the reduce: a continuation of
    // the same author's own turn is NOT a new hop (only an author change is).
    return {
      agentHops:
        explicit ??
        (draft.senderId === state.lastCompletedSender ? state.agentStreak : state.agentStreak + 1),
    };
  },

  callEventPayload,
};
