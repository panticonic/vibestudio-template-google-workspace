/**
 * Effect taxonomy (WS1 §1.4) + derivePendingEffects + outcomeEvents.
 *
 * Reconstructibility invariant (P1/P2, normative): every descriptor is a pure
 * function of the logged intention event. The outbox's descriptor_json is a
 * denormalized copy only; `derivePendingEffects(fold(log))` is the authority.
 */

import {
  AGENTIC_PROTOCOL_VERSION,
  agentToolFailureFromUnknown,
  invocationCompletedPayload,
  invocationFailedPayload,
  type EventKind,
  type LogEventCausality,
  type ParticipantRef,
} from "@workspace/agentic-protocol";
import type { AgentToolFailure } from "@workspace/agentic-protocol";
import { ids } from "./ids.js";
import { classifyModelFailure, type ModelFailureInfo } from "./model-errors.js";
import type {
  AgentLoopConfig,
  AgentState,
  InFlightModelCall,
  ModelRequestDescriptor,
  PendingApproval,
  PendingCredentialWait,
  PendingInvocation,
  PendingPromptPreparation,
} from "./state.js";

export type EffectKind =
  | "prompt_artifacts"
  | "model_call"
  | "local_tool"
  | "channel_call"
  | "http_call"
  | "credential_wait"
  | "record_receipt";

export interface EffectDescriptorBase {
  /** deterministic (§1.5); == outbox PK. */
  effectId: string;
  kind: EffectKind;
  channelId: string;
  /** invocationId for invocation effects; attemptId for model calls. */
  idempotencyKey: string;
}

export interface ModelCallEffect extends EffectDescriptorBase {
  kind: "model_call";
  messageId: string;
  turnId: string;
  request: ModelRequestDescriptor;
}

export interface PromptArtifactsEffect extends EffectDescriptorBase {
  kind: "prompt_artifacts";
  triggerEnvelopeId: string;
  requestedAtSeq: number;
}

export interface LocalToolEffect extends EffectDescriptorBase {
  kind: "local_tool";
  invocationId: string;
  turnId: string;
  /** Source order of invocation.started within the durable trajectory. */
  invocationSeq: number;
  /** Per-tool ordering contract captured when the invocation was journaled. */
  executionMode: "sequential" | "parallel";
  cancellationMode: "interruptible" | "settle";
  tool: string;
  args: unknown;
}

export interface ChannelCallEffect extends EffectDescriptorBase {
  kind: "channel_call";
  invocationId: string;
  turnId: string;
  transportCallId: string;
  target: ParticipantRef;
  method: string;
  args: unknown;
  timeoutMs?: number;
  /** approval-form / ask-user calls map their outcome to approval.resolved. */
  purpose?: "tool" | "approval-form" | "ask-user";
  approvalId?: string;
  /** Present when this call came from a model tool invocation. */
  invocationSeq?: number;
  executionMode?: "sequential" | "parallel";
}

export interface HttpCallEffect extends EffectDescriptorBase {
  kind: "http_call";
  invocationId: string;
  turnId: string;
  targetUrl?: string;
  target?: { service: string; method: string };
  request: unknown;
  invocationSeq: number;
  executionMode: "sequential" | "parallel";
}

export interface CredentialWaitEffect extends EffectDescriptorBase {
  kind: "credential_wait";
  credKey: string;
  /** Seq of the wait_started envelope — the occurrence discriminator for
   *  resolution/expiry envelope ids (a later wait for the same credKey must
   *  not collide with an earlier occurrence). */
  startedAtSeq: number;
  providerId: string;
  turnId: string;
  connectSpec: Record<string, unknown>;
  modelBaseUrl?: string;
  waitReason?: "model_credential_required" | "model_credential_reconnect_required";
  reason?: string;
  failureCode?: string;
  expiresAt: string;
}

export interface RecordReceiptEffect extends EffectDescriptorBase {
  kind: "record_receipt";
  messageId: string;
  turnId: string;
}

export type EffectDescriptor =
  | PromptArtifactsEffect
  | ModelCallEffect
  | LocalToolEffect
  | ChannelCallEffect
  | HttpCallEffect
  | CredentialWaitEffect
  | RecordReceiptEffect;

// ---------------------------------------------------------------------------
// derivePendingEffects (§1.7) — the dispatch-cache derivation
// ---------------------------------------------------------------------------

export function modelCallEffect(state: AgentState, call: InFlightModelCall): ModelCallEffect {
  return {
    effectId: ids.modelEffect(call.messageId),
    kind: "model_call",
    channelId: state.channelId,
    idempotencyKey: call.attemptId,
    messageId: call.messageId,
    turnId: state.openTurn?.turnId ?? "",
    request: call.request,
  };
}

export function invocationEffect(
  state: AgentState,
  invocation: PendingInvocation
): LocalToolEffect | ChannelCallEffect | HttpCallEffect {
  const base = {
    effectId: ids.invocationEffect(invocation.invocationId),
    channelId: state.channelId,
    idempotencyKey: invocation.invocationId,
    invocationId: invocation.invocationId,
    turnId: invocation.turnId,
  };
  const transport = invocation.transport;
  if (transport.kind === "local") {
    return {
      ...base,
      kind: "local_tool",
      invocationSeq: invocation.startedAtSeq,
      executionMode: invocation.executionMode,
      cancellationMode:
        state.config.localToolCancellationModes?.[invocation.name] === "settle"
          ? "settle"
          : "interruptible",
      tool: invocation.name,
      args: invocation.request,
    };
  }
  if (transport.kind === "channel") {
    return {
      ...base,
      kind: "channel_call",
      idempotencyKey: transport.transportCallId ?? ids.transportCallId(invocation.invocationId),
      transportCallId: transport.transportCallId ?? ids.transportCallId(invocation.invocationId),
      target: transport.target,
      method: invocation.name,
      args: invocation.request,
      invocationSeq: invocation.startedAtSeq,
      executionMode: invocation.executionMode,
      ...(invocation.approvalId
        ? { purpose: "tool" as const, approvalId: invocation.approvalId }
        : {}),
    };
  }
  return {
    ...base,
    kind: "http_call",
    targetUrl: transport.targetUrl,
    idempotencyKey: transport.idempotencyKey,
    request: invocation.request,
    invocationSeq: invocation.startedAtSeq,
    executionMode: invocation.executionMode,
  };
}

function participantTargetId(target: ParticipantRef): string {
  return target.participantId ?? target.id;
}

/** Deterministic coordinates for non-primary ask_user fan-out calls. */
export function askUserFanoutCallId(invocationId: string, target: ParticipantRef): string {
  return ids.transportCallId(`${invocationId}#${participantTargetId(target)}`);
}

export function askUserFanoutEffectId(invocationId: string, target: ParticipantRef): string {
  return `${ids.invocationEffect(invocationId)}#${participantTargetId(target)}`;
}

/** Reconstruct every independently dispatchable ask_user call from the logged
 * invocation. No secondary target exists only in an interceptor/outbox cache. */
export function invocationEffects(
  state: AgentState,
  invocation: PendingInvocation
): Array<LocalToolEffect | ChannelCallEffect | HttpCallEffect> {
  const primary = invocationEffect(state, invocation);
  const targets = invocation.askUserTargets;
  if (primary.kind !== "channel_call" || !targets?.length) return [primary];
  return targets.map((target, index) => {
    const callId =
      index === 0 ? primary.transportCallId : askUserFanoutCallId(invocation.invocationId, target);
    return {
      ...primary,
      effectId:
        index === 0 ? primary.effectId : askUserFanoutEffectId(invocation.invocationId, target),
      idempotencyKey: callId,
      transportCallId: callId,
      target,
      purpose: "ask-user",
    };
  });
}

export function approvalFormEffect(
  state: AgentState,
  approval: PendingApproval
): ChannelCallEffect | null {
  const target = state.config.roster?.participants?.find(
    (participant) => participant.type === "panel" || participant.ref.kind === "user"
  )?.ref;
  // Park the durable approval until a real prompting participant joins. A
  // phantom user target makes delivery fail and incorrectly turns "nobody is
  // viewing this chat" into a denial.
  if (!target) return null;
  return {
    effectId: ids.approvalFormEffect(approval.approvalId),
    kind: "channel_call",
    channelId: state.channelId,
    idempotencyKey: approval.approvalId,
    invocationId: approval.invocationId,
    turnId: approval.turnId,
    transportCallId: ids.transportCallId(approval.approvalId),
    target,
    method: "confirm",
    args: { question: approval.question, details: approval.details },
    purpose: "approval-form",
    approvalId: approval.approvalId,
  };
}

export function credentialWaitEffect(
  state: AgentState,
  wait: PendingCredentialWait
): CredentialWaitEffect {
  return {
    effectId: ids.credentialWaitEffect(wait.credKey),
    kind: "credential_wait",
    channelId: state.channelId,
    idempotencyKey: wait.credKey,
    credKey: wait.credKey,
    startedAtSeq: wait.startedAtSeq,
    providerId: wait.providerId,
    turnId: wait.turnId,
    connectSpec: wait.connectSpec,
    ...(wait.modelBaseUrl ? { modelBaseUrl: wait.modelBaseUrl } : {}),
    ...(wait.waitReason ? { waitReason: wait.waitReason } : {}),
    ...(wait.reason ? { reason: wait.reason } : {}),
    ...(wait.failureCode ? { failureCode: wait.failureCode } : {}),
    expiresAt: wait.expiresAt,
  };
}

export function promptArtifactsEffect(
  state: AgentState,
  preparation: PendingPromptPreparation
): PromptArtifactsEffect {
  return {
    effectId: ids.promptArtifactsEffect(preparation.triggerEnvelopeId),
    kind: "prompt_artifacts",
    channelId: state.channelId,
    idempotencyKey: ids.promptArtifactsEffect(preparation.triggerEnvelopeId),
    triggerEnvelopeId: preparation.triggerEnvelopeId,
    requestedAtSeq: preparation.requestedAtSeq,
  };
}

/** Pending effect ⟺ logged intention without logged outcome (P2). */
export function derivePendingEffects(state: AgentState): EffectDescriptor[] {
  const out: EffectDescriptor[] = [];
  const nextPromptPreparation = Object.values(state.pendingPromptPreparations).sort(
    (a, b) =>
      a.requestedAtSeq - b.requestedAtSeq || a.triggerEnvelopeId.localeCompare(b.triggerEnvelopeId)
  )[0];
  if (nextPromptPreparation) out.push(promptArtifactsEffect(state, nextPromptPreparation));
  if (state.inFlightModelCall) {
    out.push(modelCallEffect(state, state.inFlightModelCall));
    const turnId = state.openTurn?.turnId ?? "";
    const consumed = new Set<string>();
    for (const entry of state.entries) {
      if (
        entry.seq <= state.inFlightModelCall.request.contextThroughSeq &&
        "sourceMessageId" in entry &&
        entry.sourceMessageId
      ) {
        consumed.add(entry.sourceMessageId);
      }
    }
    for (const messageId of consumed) {
      out.push({
        effectId: `read:${messageId}:${turnId}`,
        kind: "record_receipt",
        channelId: state.channelId,
        idempotencyKey: `read:${messageId}:${turnId}`,
        messageId,
        turnId,
      });
    }
  }
  for (const invocation of Object.values(state.pendingInvocations)) {
    if (invocation.requiresApproval && invocation.approvalState !== "granted") continue; // gated
    out.push(...invocationEffects(state, invocation));
  }
  for (const approval of Object.values(state.pendingApprovals)) {
    const effect = approvalFormEffect(state, approval);
    if (effect) out.push(effect);
  }
  for (const wait of Object.values(state.pendingCredentialWaits)) {
    out.push(credentialWaitEffect(state, wait));
  }
  return out;
}

// ---------------------------------------------------------------------------
// outcomeEvents (§1.8) — pure mapping executor outcome → terminal AppendItems
// ---------------------------------------------------------------------------

export interface AppendItem {
  envelopeId: string;
  payloadKind: EventKind;
  payload: unknown;
  causality?: LogEventCausality;
  /** publish to the loop's channel on append. */
  publish?: boolean;
}

export type EffectOutcome =
  | {
      kind: "prompt-artifacts";
      patch: Partial<AgentLoopConfig>;
    }
  | {
      kind: "model";
      blocks: unknown[];
      stopReason: "completed" | "aborted" | "error";
      outcome?: "completed" | "interrupted" | "empty" | "tool_calls_only";
      usage?: Record<string, unknown>;
      errorReason?: string;
      recoverable?: boolean;
      failure?: ModelFailureInfo;
    }
  | {
      kind: "retry";
      reason: string;
      retryAfterMs?: number;
      code?: string;
    }
  | {
      kind: "model-suspended";
      reason: "credential";
      providerId: string;
      modelBaseUrl?: string;
      waitReason?: "model_credential_required" | "model_credential_reconnect_required";
      diagnosticReason?: string;
      failureCode?: string;
    }
  | {
      kind: "tool";
      result: unknown;
      summary?: string;
      isError: boolean;
      reason?: string;
      /**
       * Distinguishes an ordinary tool-domain failure (which the model may
       * correct) from a terminal failure of the execution infrastructure.
       * Successful outcomes ignore this field.
       */
      terminalOutcome?: "tool_error" | "infrastructure_error";
      /** Stable typed reason preserved from the tool/service boundary. */
      terminalReasonCode?: string;
      turnControl?:
        | {
            kind: "suspend";
            reason: string;
            summary: string;
          }
        | {
            kind: "terminate";
          };
      /** Canonical failure envelope preserved unchanged into the terminal
       * invocation event. */
      failure?: AgentToolFailure;
    }
  | { kind: "approval"; granted: boolean; resolvedBy: ParticipantRef; reason?: string }
  | { kind: "credential"; resolved: boolean; reason?: string };

function modelFailurePayload(
  failure: ModelFailureInfo,
  recoverableOverride: boolean | undefined
): Record<string, unknown> {
  const recoverable = failure.recoverable && (recoverableOverride ?? true);
  return {
    protocol: AGENTIC_PROTOCOL_VERSION,
    reason: failure.reason,
    recoverable,
    code: failure.code,
    ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
    ...(failure.resetAt ? { resetAt: failure.resetAt } : {}),
  };
}

function classifyModelOutcome(
  outcome: Extract<EffectOutcome, { kind: "model" }>
): "completed" | "interrupted" | "empty" | "tool_calls_only" {
  if (outcome.outcome) return outcome.outcome;
  if (outcome.stopReason === "aborted") return "interrupted";
  const blocks = outcome.blocks ?? [];
  if (blocks.length === 0) return "empty";
  const hasContent = blocks.some(
    (block) =>
      !!block &&
      typeof block === "object" &&
      ((block as { type?: string }).type === "text" ||
        (block as { type?: string }).type === "thinking")
  );
  if (!hasContent) return "tool_calls_only";
  return "completed";
}

/** Whether a model output carries tool calls — the signal that the turn will
 *  continue after the tools run (mirrors isToolCallBlock in step.ts). */
function messageHasToolCalls(blocks: unknown): boolean {
  if (!Array.isArray(blocks)) return false;
  return blocks.some((block) => {
    if (!block || typeof block !== "object") return false;
    const type = (block as { type?: unknown }).type;
    return type === "toolCall" || type === "tool_call";
  });
}

/** Map an executor outcome to its terminal append items. Pure. */
export function outcomeEvents(
  descriptor: EffectDescriptor,
  outcome: EffectOutcome,
  ctx: { now: string }
): AppendItem[] {
  if (descriptor.kind === "prompt_artifacts") {
    if (outcome.kind !== "prompt-artifacts") {
      throw new Error("prompt_artifacts expects a prompt-artifacts outcome");
    }
    return [
      {
        envelopeId: ids.promptArtifactsTerminal(descriptor.triggerEnvelopeId),
        payloadKind: "system.event",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          kind: "prompt.artifacts_ready",
          triggerEnvelopeId: descriptor.triggerEnvelopeId,
          patch: outcome.patch,
          details: {
            kind: "prompt.artifacts_ready",
            triggerEnvelopeId: descriptor.triggerEnvelopeId,
            patch: outcome.patch,
          },
        },
        publish: false,
      },
    ];
  }

  if (descriptor.kind === "model_call") {
    if (outcome.kind === "model-suspended") return []; // §1.4.5 events come from step
    if (outcome.kind === "retry") return []; // driver reschedules the same effect row
    if (outcome.kind !== "model") throw new Error("model_call expects a model outcome");
    if (outcome.stopReason === "error") {
      const failure =
        outcome.failure ??
        classifyModelFailure({
          provider: descriptor.request.provider,
          model: descriptor.request.model,
          rawReason: outcome.errorReason,
          message: outcome.errorReason,
          now: ctx.now,
        });
      return [
        {
          envelopeId: ids.messageTerminal(descriptor.messageId),
          payloadKind: "message.failed",
          payload: modelFailurePayload(failure, outcome.recoverable),
          causality: {
            messageId: descriptor.messageId as never,
            turnId: descriptor.turnId,
          },
          publish: shouldPublishModelOutcome(descriptor.request, []),
        },
      ];
    }
    const publish = shouldPublishModelOutcome(descriptor.request, outcome.blocks);
    const messageOutcome = classifyModelOutcome(outcome);
    // Salience tier travels on the wire so every surface (and replay) agrees on
    // the turn's "final vs preceding" split. A message that carries tool calls
    // is an intermediate step — the turn continues after the tools run, so it's
    // tier 2; a text-only completion ends the turn and is the headline answer
    // (tier 1). This mirrors the exact turn-continues test the loop uses to
    // decide closure (step.ts: blocks.filter(isToolCallBlock)). An interrupted
    // turn's terminal message stays tier 1.
    const tier =
      messageOutcome !== "interrupted" && messageHasToolCalls(outcome.blocks)
        ? "secondary"
        : "primary";
    return [
      {
        envelopeId: ids.messageTerminal(descriptor.messageId),
        payloadKind: "message.completed",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          role: "assistant",
          blocks: outcome.blocks,
          outcome: messageOutcome,
          tier,
          ...(outcome.usage ? { usage: outcome.usage } : {}),
        },
        causality: {
          messageId: descriptor.messageId as never,
          turnId: descriptor.turnId,
        },
        publish,
      },
    ];
  }

  if (
    descriptor.kind === "local_tool" ||
    descriptor.kind === "http_call" ||
    (descriptor.kind === "channel_call" && descriptor.purpose !== "approval-form")
  ) {
    if (outcome.kind !== "tool") throw new Error(`${descriptor.kind} expects a tool outcome`);
    const causality: LogEventCausality = {
      invocationId: descriptor.invocationId as never,
      ...(descriptor.kind === "channel_call"
        ? { transportCallId: descriptor.transportCallId }
        : {}),
      turnId: descriptor.turnId,
    };
    return [
      {
        envelopeId: ids.invocationTerminal(descriptor.invocationId),
        payloadKind: outcome.isError ? "invocation.failed" : "invocation.completed",
        payload: outcome.isError
          ? invocationFailedPayload(
              outcome.terminalOutcome ?? "tool_error",
              outcome.reason ?? "tool failed",
              {
                error: outcome.result,
                ...(outcome.terminalReasonCode
                  ? { terminalReasonCode: outcome.terminalReasonCode }
                  : {}),
                failure:
                  outcome.failure ??
                  agentToolFailureFromUnknown(outcome.result, {
                    operation: descriptor.kind,
                    stage: "execute",
                    causal: { invocationId: descriptor.invocationId },
                    kind:
                      outcome.terminalOutcome === "infrastructure_error"
                        ? "infrastructure"
                        : undefined,
                  }),
              }
            )
          : invocationCompletedPayload({
              result: outcome.result,
              ...(outcome.summary ? { summary: outcome.summary } : {}),
              ...(outcome.turnControl ? { turnControl: outcome.turnControl } : {}),
            }),
        causality,
        publish: true,
      },
    ];
  }

  if (descriptor.kind === "channel_call" && descriptor.purpose === "approval-form") {
    if (outcome.kind !== "approval") throw new Error("approval form expects an approval outcome");
    return [
      {
        envelopeId: ids.approvalResolved(descriptor.approvalId!),
        payloadKind: "approval.resolved",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          granted: outcome.granted,
          resolvedBy: outcome.resolvedBy,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        },
        causality: {
          approvalId: descriptor.approvalId as never,
          invocationId: descriptor.invocationId as never,
          turnId: descriptor.turnId,
        },
        publish: true,
      },
    ];
  }

  if (descriptor.kind === "credential_wait") {
    if (outcome.kind !== "credential") throw new Error("credential_wait expects credential");
    return [
      {
        envelopeId: ids.systemEvent(descriptor.credKey, "resolved", descriptor.startedAtSeq),
        payloadKind: "system.event",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          kind: "credential.wait_resolved",
          credKey: descriptor.credKey,
          details: {
            kind: "credential.wait_resolved",
            credKey: descriptor.credKey,
            providerId: descriptor.providerId,
            resolved: outcome.resolved,
            ...(outcome.reason ? { reason: outcome.reason } : {}),
          },
        },
        causality: { turnId: descriptor.turnId },
        publish: true,
      },
    ];
  }

  return []; // record_receipt: projection update, no trajectory outcome event
}

function shouldPublishModelOutcome(request: ModelRequestDescriptor, blocks: unknown[]): boolean {
  const metadata = request.turnMetadata;
  if (!metadata) return true;
  if (metadata.delivery === "none") return false;
  if (metadata.silentOk && blocksLookSuccessful(blocks)) return false;
  if (metadata.ackToken && blocksContainText(blocks, metadata.ackToken)) return false;
  return true;
}

function blocksLookSuccessful(blocks: unknown[]): boolean {
  const text = blocks
    .map((block) =>
      block &&
      typeof block === "object" &&
      typeof (block as { content?: unknown }).content === "string"
        ? (block as { content: string }).content.toLowerCase()
        : ""
    )
    .join("\n");
  return !/\b(error|failed|failure|blocked|unable|cannot)\b/u.test(text);
}

function blocksContainText(blocks: unknown[], needle: string): boolean {
  if (!needle) return false;
  return blocks.some((block) => {
    if (!block || typeof block !== "object") return false;
    const content = (block as { content?: unknown }).content;
    return typeof content === "string" && content.includes(needle);
  });
}
