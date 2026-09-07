/**
 * The fold (WS1 §1.2): one pure reducer over trajectory log envelopes.
 * Same log prefix → same state, forever (P4). No wall clock, no randomness,
 * no I/O. Events not handled fold to `state` unchanged except the universal
 * lastSeq/lastHash advance.
 */

import type {
  ActorRef,
  AgentToolFailure,
  LogEnvelope,
  ParticipantRef,
} from "@workspace/agentic-protocol";
import {
  participantKey,
  participantRefFromActor,
} from "@workspace/agentic-protocol";
import type {
  AgentState,
  AgentTurnMetadata,
  DeferredPrompt,
  ModelRequestDescriptor,
  OpenTurn,
  PendingInvocation,
  SessionEntry,
} from "./state.js";

function payloadRecord(envelope: LogEnvelope): Record<string, unknown> {
  const payload = envelope.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function metadataFromPayload(
  payload: Record<string, unknown>,
): AgentTurnMetadata | undefined {
  const metadata = payload["metadata"];
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as AgentTurnMetadata)
    : undefined;
}

/** Sender's canonical message id, carried on the recv payload IN ADDITION to
 *  the private recv envelope id. The read-ack / edit / retract correlation key. */
function sourceMessageIdFromPayload(
  payload: Record<string, unknown>,
): string | undefined {
  const value = payload["sourceMessageId"];
  return typeof value === "string" && value ? value : undefined;
}

function resumeOpenTurn(
  turn: OpenTurn,
  request: ModelRequestDescriptor,
): OpenTurn {
  const { waitingAtSeq: _waitingAtSeq, ...resumed } = turn;
  return {
    ...resumed,
    modelCallCount: turn.modelCallCount + 1,
    activeModelRequest: request,
    // A new model call consumes any soft flush intent.
    ...(turn.pendingFlush ? { pendingFlush: undefined } : {}),
    ...(turn.lastFailedModelRequest
      ? { lastFailedModelRequest: undefined }
      : {}),
  };
}

/** The ORIGINAL sender, carried on the recv payload — the private recv
 *  envelope's actor is the agent (driver-stamped), so the fold cannot use it
 *  for the edit/retract author guard. */
function senderRefFromPayload(
  payload: Record<string, unknown>,
  fallback: ActorRef,
): ParticipantRef {
  const value = payload["senderRef"];
  return value && typeof value === "object" && !Array.isArray(value)
    ? participantRefFromActor(value as ActorRef)
    : participantRefFromActor(fallback);
}

/** Is the message still un-consumed (un-read) — present in a live queue? Once a
 *  message has only an `entries` copy (consumed into a model context) it is
 *  read, and edits/retracts no-op ("read wins"). */
function liveSenderRef(
  state: AgentState,
  sourceMessageId: string,
): ParticipantRef | undefined {
  for (const entry of state.steeringQueue) {
    if (entry.sourceMessageId === sourceMessageId) return entry.senderRef;
  }
  if (state.pendingPrompt?.sourceMessageId === sourceMessageId) {
    return state.pendingPrompt.senderRef;
  }
  for (const deferred of state.deferredPostTurnQueue) {
    if (deferred.sourceMessageId === sourceMessageId) return deferred.senderRef;
  }
  return undefined;
}

/** Replace a user entry/queue item's content blocks in place (edit before read). */
function withEditedBlocks(content: unknown, blocks: unknown): unknown {
  const base =
    content && typeof content === "object" && !Array.isArray(content)
      ? content
      : {};
  return { ...(base as Record<string, unknown>), blocks };
}

function withAdvance(state: AgentState, envelope: LogEnvelope): AgentState {
  return { ...state, lastSeq: envelope.seq, lastHash: envelope.hash };
}

export function applyEvent(
  prev: AgentState,
  envelope: LogEnvelope,
): AgentState {
  const state = withAdvance(prev, envelope);
  const kind = envelope.payloadKind;
  const payload = payloadRecord(envelope);
  const causality = (envelope.causality ?? {}) as Record<string, unknown>;
  const turnId =
    typeof causality["turnId"] === "string"
      ? (causality["turnId"] as string)
      : undefined;

  // Only THIS agent's turn lifecycle drives its loop state. The shared channel log carries
  // every participant's events; a foreign-authored turn/message advances the fold position
  // (withAdvance, above) but must NEVER make us adopt their open turn / model call as our
  // own — that's how an agent ends up continuing another agent's turn → GAD id-collision.
  const foreignAuthor = envelope.actor.id !== state.selfId;

  switch (true) {
    case kind === "message.delta":
      // Deltas are signal-only and never in the log (§2.4.1).
      throw new Error(
        "message.delta must never be appended to a trajectory log",
      );

    case kind === "turn.opened": {
      if (!turnId || foreignAuthor) return state;
      return {
        ...state,
        openTurn: {
          turnId,
          openedAtSeq: envelope.seq,
          reason:
            typeof payload["reason"] === "string"
              ? (payload["reason"] as string)
              : undefined,
          modelCallCount: 0,
          consecutiveModelFailureCount: 0,
          interrupted: false,
          waitingCount: 0,
          ...(metadataFromPayload(payload)
            ? { metadata: metadataFromPayload(payload) }
            : {}),
        },
        pendingPrompt: null,
      };
    }

    case kind === "turn.closed": {
      if (foreignAuthor) return state;
      if (state.openTurn && turnId && state.openTurn.turnId !== turnId)
        return state;
      return { ...state, openTurn: null, inFlightModelCall: null };
    }

    case kind === "turn.waiting": {
      if (foreignAuthor || !state.openTurn) return state;
      return {
        ...state,
        openTurn: {
          ...state.openTurn,
          waitingCount: state.openTurn.waitingCount + 1,
          waitingAtSeq: envelope.seq,
        },
      };
    }

    case kind === "message.started": {
      const role = payload["role"];
      if (role !== "assistant" || foreignAuthor) return state;
      const messageId = String(causality["messageId"] ?? "");
      const request = payload["modelRequest"] as
        | ModelRequestDescriptor
        | undefined;
      if (!request) {
        throw new Error(
          `assistant message.started ${messageId} lacks a modelRequest descriptor`,
        );
      }
      if (!request.modelSpec || typeof request.modelSpec !== "object") {
        throw new Error(
          `assistant message.started ${messageId} lacks the required journaled modelSpec`,
        );
      }
      const contextThroughSeq = request.contextThroughSeq;
      return {
        ...state,
        inFlightModelCall: {
          messageId,
          attemptId: request.attemptId,
          contextThroughSeq,
          request,
        },
        openTurn: state.openTurn
          ? resumeOpenTurn(state.openTurn, request)
          : state.openTurn,
        // Steered messages covered by this call's context snapshot are consumed.
        steeringQueue: state.steeringQueue.filter(
          (entry) => entry.seq > contextThroughSeq,
        ),
      };
    }

    case kind === "message.completed": {
      const role = payload["role"];
      const messageId = String(causality["messageId"] ?? "");
      if (role === "assistant") {
        if (
          !foreignAuthor &&
          state.inFlightModelCall &&
          state.inFlightModelCall.messageId !== messageId
        ) {
          return state; // stale terminal for an older attempt — fold ignores
        }
        const modelRequest = foreignAuthor
          ? undefined
          : state.inFlightModelCall?.request;
        const entry: SessionEntry = {
          kind: "assistant",
          seq: envelope.seq,
          messageId,
          senderRef: participantRefFromActor(envelope.actor),
          blocks: Array.isArray(payload["blocks"])
            ? (payload["blocks"] as unknown[])
            : [],
          outcome:
            typeof payload["outcome"] === "string"
              ? (payload["outcome"] as string)
              : undefined,
          ...(modelRequest
            ? {
                model: {
                  provider: modelRequest.provider,
                  api: modelRequest.modelSpec.api,
                  model: modelRequest.model,
                },
              }
            : {}),
        };
        if (foreignAuthor) {
          return {
            ...state,
            entries: [...state.entries, entry],
          };
        }
        return {
          ...state,
          inFlightModelCall: null,
          openTurn: state.openTurn
            ? { ...state.openTurn, consecutiveModelFailureCount: 0 }
            : state.openTurn,
          entries: [...state.entries, entry],
        };
      }
      // user (or panel) message — row 3
      const metadata = metadataFromPayload(payload);
      const structuredInput = payload["structuredInput"];
      const sourceMessageId = sourceMessageIdFromPayload(payload);
      const senderRef = senderRefFromPayload(payload, envelope.actor);
      const artifactsReady = payload["promptArtifactsReady"] === true;
      const turnTriggerEnvelopeId = String(
        payload["turnTriggerEnvelopeId"] ?? "",
      );
      if (!turnTriggerEnvelopeId) {
        throw new Error(
          `user trajectory event ${String(envelope.envelopeId)} lacks turnTriggerEnvelopeId`,
        );
      }
      const agentHops =
        typeof causality["agentHops"] === "number"
          ? (causality["agentHops"] as number)
          : undefined;

      // Send-after-turn: while a turn is open, hold the message in the deferred
      // queue ONLY. Skipping `entries` is exactly what keeps it out of the
      // current turn's context (context is built from entries up to
      // contextThroughSeq).
      if (
        metadata?.deliverAfterTurn &&
        state.openTurn &&
        state.openTurn.waitingAtSeq === undefined
      ) {
        const deferred: DeferredPrompt = {
          sourceMessageId: sourceMessageId ?? String(envelope.envelopeId),
          envelopeId: String(envelope.envelopeId),
          turnTriggerEnvelopeId,
          seq: envelope.seq,
          senderRef,
          content: payload,
          ...(metadata ? { metadata } : {}),
          ...(agentHops !== undefined ? { agentHops } : {}),
          ...(artifactsReady ? { artifactsReady: true } : {}),
        };
        return {
          ...state,
          deferredPostTurnQueue: [...state.deferredPostTurnQueue, deferred],
        };
      }

      // A promoted after-turn recv carries the same sourceMessageId as its
      // deferred entry — drop that entry from the queue as it enters context.
      const deferredPostTurnQueue = sourceMessageId
        ? state.deferredPostTurnQueue.filter(
            (d) => d.sourceMessageId !== sourceMessageId,
          )
        : state.deferredPostTurnQueue;

      const entry: SessionEntry = {
        kind: "user",
        seq: envelope.seq,
        envelopeId: String(envelope.envelopeId),
        ...(sourceMessageId ? { sourceMessageId } : {}),
        senderRef,
        content: payload,
        ...(structuredInput !== undefined ? { structuredInput } : {}),
        ...(metadata ? { metadata } : {}),
        ...(artifactsReady ? { artifactsReady: true } : {}),
      };
      const steering = {
        envelopeId: String(envelope.envelopeId),
        turnTriggerEnvelopeId,
        seq: envelope.seq,
        ...(sourceMessageId ? { sourceMessageId } : {}),
        senderRef,
        content: payload,
        ...(metadata ? { metadata } : {}),
        ...(artifactsReady ? { artifactsReady: true } : {}),
      };
      if (state.openTurn) {
        return {
          ...state,
          deferredPostTurnQueue,
          entries: [...state.entries, entry],
          steeringQueue: [...state.steeringQueue, steering],
        };
      }
      return {
        ...state,
        deferredPostTurnQueue,
        entries: [...state.entries, entry],
        pendingPrompt: {
          envelopeId: String(envelope.envelopeId),
          turnTriggerEnvelopeId,
          seq: envelope.seq,
          ...(sourceMessageId ? { sourceMessageId } : {}),
          senderRef,
          content: payload,
          ...(metadata ? { metadata } : {}),
          agentHops,
          ...(artifactsReady ? { artifactsReady: true } : {}),
        },
      };
    }

    case kind === "message.edited": {
      const sourceMessageId = String(causality["messageId"] ?? "");
      if (!sourceMessageId) return state;
      // Read wins: if no live (un-consumed) entry exists, the message was
      // already folded into a model context — no-op.
      const sender = liveSenderRef(state, sourceMessageId);
      if (!sender) return state;
      // Author guard: the private append actor is the agent, so the original
      // author rides on payload.by; it must match the stored sender.
      const by = payload["by"] as ParticipantRef | undefined;
      if (by && participantKey(by) !== participantKey(sender)) return state;
      const blocks = Array.isArray(payload["blocks"])
        ? (payload["blocks"] as unknown[])
        : [];
      return {
        ...state,
        steeringQueue: state.steeringQueue.map((entry) =>
          entry.sourceMessageId === sourceMessageId
            ? { ...entry, content: withEditedBlocks(entry.content, blocks) }
            : entry,
        ),
        pendingPrompt:
          state.pendingPrompt?.sourceMessageId === sourceMessageId
            ? {
                ...state.pendingPrompt,
                content: withEditedBlocks(state.pendingPrompt.content, blocks),
              }
            : state.pendingPrompt,
        deferredPostTurnQueue: state.deferredPostTurnQueue.map((deferred) =>
          deferred.sourceMessageId === sourceMessageId
            ? {
                ...deferred,
                content: withEditedBlocks(deferred.content, blocks),
              }
            : deferred,
        ),
        entries: state.entries.map((entry) =>
          entry.kind === "user" && entry.sourceMessageId === sourceMessageId
            ? { ...entry, content: withEditedBlocks(entry.content, blocks) }
            : entry,
        ),
      };
    }

    case kind === "message.retracted": {
      const sourceMessageId = String(causality["messageId"] ?? "");
      if (!sourceMessageId) return state;
      const sender = liveSenderRef(state, sourceMessageId);
      if (!sender) return state; // read wins — already consumed
      const by = payload["by"] as ParticipantRef | undefined;
      if (by && participantKey(by) !== participantKey(sender)) return state;
      return {
        ...state,
        steeringQueue: state.steeringQueue.filter(
          (entry) => entry.sourceMessageId !== sourceMessageId,
        ),
        pendingPrompt:
          state.pendingPrompt?.sourceMessageId === sourceMessageId
            ? null
            : state.pendingPrompt,
        deferredPostTurnQueue: state.deferredPostTurnQueue.filter(
          (deferred) => deferred.sourceMessageId !== sourceMessageId,
        ),
        entries: state.entries.filter(
          (entry) =>
            !(
              entry.kind === "user" && entry.sourceMessageId === sourceMessageId
            ),
        ),
      };
    }

    case kind === "message.failed": {
      if (foreignAuthor) return state;
      const messageId = String(causality["messageId"] ?? "");
      if (
        state.inFlightModelCall &&
        state.inFlightModelCall.messageId !== messageId
      )
        return state;
      const failedRequest = state.inFlightModelCall?.request;
      return {
        ...state,
        inFlightModelCall: null,
        openTurn:
          state.openTurn && failedRequest
            ? {
                ...state.openTurn,
                lastFailedModelRequest: failedRequest,
                consecutiveModelFailureCount:
                  state.openTurn.consecutiveModelFailureCount + 1,
              }
            : state.openTurn,
      };
    }

    case kind === "invocation.started": {
      if (foreignAuthor) return state;
      const invocationId = String(causality["invocationId"] ?? "");
      if (!invocationId) return state;
      const transport = payload["transport"] as
        | PendingInvocation["transport"]
        | undefined;
      if (!transport) {
        throw new Error(
          `invocation.started ${invocationId} lacks a transport (WS1 §1.9)`,
        );
      }
      const pending: PendingInvocation = {
        invocationId,
        turnId: turnId ?? state.openTurn?.turnId ?? "",
        startedAtSeq: envelope.seq,
        attemptId:
          typeof causality["attemptId"] === "string"
            ? (causality["attemptId"] as string)
            : undefined,
        name: String(payload["name"] ?? "unknown"),
        transport,
        executionMode:
          payload["executionMode"] === "parallel" ? "parallel" : "sequential",
        ...(Array.isArray(payload["askUserTargets"])
          ? { askUserTargets: payload["askUserTargets"] as ParticipantRef[] }
          : {}),
        request: payload["request"],
        requiresApproval: payload["requiresApproval"] === true,
        approvalState: payload["requiresApproval"] === true ? "none" : "none",
      };
      return {
        ...state,
        pendingInvocations: {
          ...state.pendingInvocations,
          [invocationId]: pending,
        },
      };
    }

    case kind === "invocation.completed" ||
      kind === "invocation.failed" ||
      kind === "invocation.cancelled" ||
      kind === "invocation.abandoned": {
      if (foreignAuthor) return state;
      const invocationId = String(causality["invocationId"] ?? "");
      const pending = state.pendingInvocations[invocationId];
      if (!pending) return state;
      const { [invocationId]: _removed, ...rest } = state.pendingInvocations;
      const entry: SessionEntry =
        kind === "invocation.completed"
          ? {
              kind: "tool-result",
              seq: envelope.seq,
              invocationId,
              turnId: pending.turnId,
              ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
              name: pending.name,
              result: payload["result"],
              isError: false,
              ...(payload["turnControl"] &&
              typeof payload["turnControl"] === "object" &&
              (payload["turnControl"] as Record<string, unknown>)["kind"] ===
                "terminate"
                ? { terminate: true }
                : {}),
            }
          : {
              kind: "tool-result",
              seq: envelope.seq,
              invocationId,
              turnId: pending.turnId,
              ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
              name: pending.name,
              result:
                kind === "invocation.abandoned"
                  ? `abandoned: ${String(payload["reason"] ?? "abandoned")}`
                  : (payload["error"] ?? payload["reason"] ?? "failed"),
              isError: true,
              ...(payload["terminalOutcome"] === "tool_error" ||
              payload["terminalOutcome"] === "infrastructure_error" ||
              payload["terminalOutcome"] === "cancelled" ||
              payload["terminalOutcome"] === "stale_dispatch" ||
              payload["terminalOutcome"] === "abandoned"
                ? { terminalOutcome: payload["terminalOutcome"] }
                : {}),
              ...(typeof payload["terminalReasonCode"] === "string"
                ? { terminalReasonCode: payload["terminalReasonCode"] }
                : {}),
              ...(payload["failure"] && typeof payload["failure"] === "object"
                ? {
                    failureRecovery: (payload["failure"] as AgentToolFailure)
                      .recovery,
                    failure: payload["failure"] as AgentToolFailure,
                  }
                : {}),
            };
      return {
        ...state,
        pendingInvocations: rest,
        entries: [...state.entries, entry],
      };
    }

    case kind === "approval.requested": {
      if (foreignAuthor) return state;
      const approvalId = String(causality["approvalId"] ?? "");
      const invocationId = String(causality["invocationId"] ?? "");
      if (!approvalId) return state;
      const details = (payload["details"] ?? {}) as {
        toolName?: string;
        input?: unknown;
      };
      const invocation = state.pendingInvocations[invocationId];
      return {
        ...state,
        pendingApprovals: {
          ...state.pendingApprovals,
          [approvalId]: {
            approvalId,
            invocationId,
            turnId: turnId ?? state.openTurn?.turnId ?? "",
            startedAtSeq: envelope.seq,
            question: String(payload["question"] ?? "Allow tool call?"),
            details: { toolName: details.toolName ?? "", input: details.input },
          },
        },
        pendingInvocations: invocation
          ? {
              ...state.pendingInvocations,
              [invocationId]: {
                ...invocation,
                approvalState: "pending",
                approvalId,
              },
            }
          : state.pendingInvocations,
      };
    }

    case kind === "approval.resolved": {
      if (foreignAuthor) return state;
      const approvalId = String(causality["approvalId"] ?? "");
      const approval = state.pendingApprovals[approvalId];
      if (!approval) return state;
      const { [approvalId]: _removedApproval, ...restApprovals } =
        state.pendingApprovals;
      const invocation = state.pendingInvocations[approval.invocationId];
      const granted = payload["granted"] === true;
      return {
        ...state,
        pendingApprovals: restApprovals,
        pendingInvocations:
          invocation && granted
            ? {
                ...state.pendingInvocations,
                [approval.invocationId]: {
                  ...invocation,
                  approvalState: "granted",
                },
              }
            : state.pendingInvocations,
        // denied: invocation stays pending until step appends its
        // invocation.failed (D-deny).
      };
    }

    case kind === "system.compaction_recorded": {
      const replacement = payload["replacement"];
      return {
        ...state,
        entries: Array.isArray(replacement)
          ? (replacement as SessionEntry[])
          : state.entries,
      };
    }

    case kind === "system.event": {
      const details = (payload["details"] ?? {}) as Record<string, unknown>;
      const detailKind = String(details["kind"] ?? payload["kind"] ?? "");
      if (detailKind === "prompt.artifacts_requested") {
        const triggerEnvelopeId = String(
          payload["triggerEnvelopeId"] ?? details["triggerEnvelopeId"] ?? "",
        );
        if (!triggerEnvelopeId) return state;
        const turnTriggerEnvelopeId = String(
          payload["turnTriggerEnvelopeId"] ??
            details["turnTriggerEnvelopeId"] ??
            "",
        );
        if (!turnTriggerEnvelopeId) {
          throw new Error(
            `prompt artifact request ${String(envelope.envelopeId)} lacks turnTriggerEnvelopeId`,
          );
        }
        return {
          ...state,
          pendingPromptPreparations: {
            ...state.pendingPromptPreparations,
            [triggerEnvelopeId]: {
              triggerEnvelopeId,
              turnTriggerEnvelopeId,
              requestedAtSeq: envelope.seq,
            },
          },
        };
      }
      if (
        detailKind === "prompt.artifacts_ready" ||
        detailKind === "prompt.artifacts_failed"
      ) {
        const triggerEnvelopeId = String(
          payload["triggerEnvelopeId"] ?? details["triggerEnvelopeId"] ?? "",
        );
        if (!triggerEnvelopeId) return state;
        const {
          [triggerEnvelopeId]: _removedPreparation,
          ...pendingPromptPreparations
        } = state.pendingPromptPreparations;
        if (detailKind === "prompt.artifacts_failed") {
          return {
            ...state,
            pendingPromptPreparations,
            pendingPrompt:
              state.pendingPrompt?.envelopeId === triggerEnvelopeId
                ? null
                : state.pendingPrompt,
            steeringQueue: state.steeringQueue.filter(
              (entry) => entry.envelopeId !== triggerEnvelopeId,
            ),
            deferredPostTurnQueue: state.deferredPostTurnQueue.filter(
              (entry) => entry.envelopeId !== triggerEnvelopeId,
            ),
            entries: state.entries.filter(
              (entry) =>
                entry.kind !== "user" || entry.envelopeId !== triggerEnvelopeId,
            ),
          };
        }
        const patch = (payload["patch"] ?? details["patch"] ?? {}) as Record<
          string,
          unknown
        >;
        return {
          ...state,
          config: { ...state.config, ...patch },
          pendingPromptPreparations,
          pendingPrompt:
            state.pendingPrompt?.envelopeId === triggerEnvelopeId
              ? { ...state.pendingPrompt, artifactsReady: true }
              : state.pendingPrompt,
          steeringQueue: state.steeringQueue.map((entry) =>
            entry.envelopeId === triggerEnvelopeId
              ? { ...entry, artifactsReady: true }
              : entry,
          ),
          deferredPostTurnQueue: state.deferredPostTurnQueue.map((entry) =>
            entry.envelopeId === triggerEnvelopeId
              ? { ...entry, artifactsReady: true }
              : entry,
          ),
        };
      }
      if (detailKind === "credential.wait_started") {
        // Payload-first: emitters mirror fold-critical fields at the payload
        // top level so an (oversized-details) blob spill can't blind the fold.
        const credKey = String(payload["credKey"] ?? details["credKey"] ?? "");
        const modelBaseUrl = payload["modelBaseUrl"] ?? details["modelBaseUrl"];
        const waitReason = payload["waitReason"] ?? details["waitReason"];
        const reason = payload["reason"] ?? details["reason"];
        const failureCode = payload["failureCode"] ?? details["failureCode"];
        const messageId = String(
          payload["messageId"] ??
            details["messageId"] ??
            causality["messageId"] ??
            "",
        );
        const next: AgentState = {
          ...state,
          pendingCredentialWaits: {
            ...state.pendingCredentialWaits,
            [credKey]: {
              credKey,
              providerId: String(
                payload["providerId"] ?? details["providerId"] ?? "",
              ),
              turnId: turnId ?? state.openTurn?.turnId ?? "",
              startedAtSeq: envelope.seq,
              connectSpec: (details["connectSpec"] ?? {}) as Record<
                string,
                unknown
              >,
              modelBaseUrl:
                typeof modelBaseUrl === "string" ? modelBaseUrl : undefined,
              waitReason:
                waitReason === "model_credential_reconnect_required" ||
                waitReason === "model_credential_required"
                  ? waitReason
                  : undefined,
              reason: typeof reason === "string" ? reason : undefined,
              failureCode:
                typeof failureCode === "string" ? failureCode : undefined,
              expiresAt: String(
                payload["expiresAt"] ?? details["expiresAt"] ?? "",
              ),
            },
          },
        };
        if (messageId && next.inFlightModelCall?.messageId === messageId) {
          return { ...next, inFlightModelCall: null };
        }
        return next;
      }
      if (
        detailKind === "credential.wait_resolved" ||
        detailKind === "credential.wait_expired"
      ) {
        const credKey = String(payload["credKey"] ?? details["credKey"] ?? "");
        if (!(credKey in state.pendingCredentialWaits)) return state;
        const { [credKey]: _removedWait, ...restWaits } =
          state.pendingCredentialWaits;
        return { ...state, pendingCredentialWaits: restWaits };
      }
      if (detailKind === "roster.snapshot") {
        return {
          ...state,
          config: {
            ...state.config,
            roster: (details["roster"] ?? {
              participants: [],
            }) as AgentState["config"]["roster"],
          },
        };
      }
      if (detailKind === "config.changed") {
        return {
          ...state,
          config: {
            ...state.config,
            ...(details["patch"] as Record<string, unknown>),
          },
        };
      }
      if (detailKind === "interrupt") {
        return state.openTurn
          ? { ...state, openTurn: { ...state.openTurn, interrupted: true } }
          : state;
      }
      if (detailKind === "flush_steers") {
        // Soft flush: keep the turn open but mark it so the aborted model's
        // interrupted terminal continues (consumes queued steers) instead of
        // closing. Does NOT set `interrupted`.
        return state.openTurn
          ? {
              ...state,
              openTurn: { ...state.openTurn, pendingFlush: "steers" },
            }
          : state;
      }
      if (
        detailKind === "model.fallback_continued" ||
        detailKind === "model.local_fallback_continued"
      ) {
        return state.openTurn
          ? {
              ...state,
              openTurn: { ...state.openTurn, failedOverToFallback: true },
            }
          : state;
      }
      return state;
    }

    default:
      return state;
  }
}

export function foldEvents(
  initial: AgentState,
  envelopes: LogEnvelope[],
): AgentState {
  let state = initial;
  for (const envelope of envelopes) state = applyEvent(state, envelope);
  return state;
}
