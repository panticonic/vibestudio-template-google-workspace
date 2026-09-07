/**
 * step(state, incoming, ctx) → { append, effects } (WS1 §1.3). Pure: wall
 * clock and randomness arrive only via ctx; effects MUST be a subset of
 * derivePendingEffects(fold(state ⊕ append)) — the driver may discard them
 * and run the reconcile instead.
 */

import {
  AGENTIC_PROTOCOL_VERSION,
  type AgenticEvent,
  type ParticipantRef,
} from "@workspace/agentic-protocol";
import type { Command, Incoming, StepContext } from "./commands.js";
import {
  derivePendingEffects,
  invocationEffect,
  modelCallEffect,
  type AppendItem,
  type EffectDescriptor,
  type ModelCallEffect,
  type RecordReceiptEffect,
} from "./effects.js";
import type { DeferredPrompt } from "./state.js";
import { applyEvent } from "./fold.js";
import { ids } from "./ids.js";
import { classifyModelFailure, type ModelFailureInfo } from "./model-errors.js";
import type {
  AgentLoopConfig,
  AgentModelSpec,
  AgentState,
  AgentTurnMetadata,
  ModelAuthMode,
  ModelRequestDescriptor,
  OpenTurn,
  SessionEntry,
} from "./state.js";
import type { LogEnvelope } from "@workspace/agentic-protocol";

export interface StepOutput {
  append: AppendItem[];
  effects: EffectDescriptor[];
}

export type StepFn = (state: AgentState, incoming: Incoming, ctx: StepContext) => StepOutput;

const EMPTY: StepOutput = { append: [], effects: [] };
const FALLBACK_NOTICE_KIND = "model.fallback_continued";
const CONSECUTIVE_TOOL_INFRASTRUCTURE_FAILURE_LIMIT = 3;

const PROVIDER_LEVEL_FAILURE_CODES = new Set<ModelFailureInfo["code"]>([
  "usage_limit_terminal",
  "quota_exhausted_terminal",
  "rate_limited_retryable",
  "provider_overloaded_retryable",
  "auth_or_credentials",
  "circuit_breaker_open_retryable",
  "unknown_retryable",
]);

export interface EphemeralSignal {
  kind: "signal-event";
  channelId: string;
  event: AgenticEvent;
}

function parseModel(model: string): { provider: string; model: string } {
  const idx = model.indexOf(":");
  if (idx === -1) return { provider: "anthropic", model };
  return { provider: model.slice(0, idx), model: model.slice(idx + 1) };
}

function isProviderLevelFailureCode(code: unknown): code is ModelFailureInfo["code"] {
  return (
    typeof code === "string" && PROVIDER_LEVEL_FAILURE_CODES.has(code as ModelFailureInfo["code"])
  );
}

function participantId(ref: ParticipantRef): string {
  return ref.participantId ?? ref.id;
}

function latestUserParticipantId(state: AgentState): string | undefined {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (entry?.kind === "user" && entry.senderRef) {
      return participantId(entry.senderRef);
    }
  }
  return undefined;
}

function channelToolOwnersFor(
  roster: AgentLoopConfig["roster"],
  preferredParticipantId?: string,
  selfId?: string
): Record<string, ParticipantRef> {
  const owners: Record<string, ParticipantRef> = {};
  const participants = selfId
    ? roster.participants.filter(
        (participant) =>
          participant.participantId !== selfId && participantId(participant.ref) !== selfId
      )
    : roster.participants;
  const preferred = preferredParticipantId
    ? participants.find((participant) => participantId(participant.ref) === preferredParticipantId)
    : undefined;
  const ordered = preferred
    ? [preferred, ...participants.filter((participant) => participant !== preferred)]
    : participants;
  for (const participant of ordered) {
    for (const method of participant.methods) {
      owners[method.name] ??= participant.ref;
    }
  }
  return owners;
}

/** Build the next assistant message.started + its model_call effect.
 *  `itemsBefore` = number of append items that precede the message.started in
 *  the same batch (their seqs are part of the context snapshot). */
function modelStartItems(
  state: AgentState,
  turnId: string,
  modelCallCount: number,
  itemsBefore: number,
  override?: {
    modelRef: string;
    modelSpec: AgentModelSpec;
    auth: ModelAuthMode;
    thinkingLevel?: AgentLoopConfig["thinkingLevel"];
  }
): { item: AppendItem; effect: ModelCallEffect } {
  const messageId = ids.messageId(turnId, modelCallCount);
  const attemptId = ids.attemptId(messageId);
  const config = state.config;
  const { provider, model } = parseModel(override?.modelRef ?? config.model);
  const modelSpec = override?.modelSpec ?? config.modelSpec;
  const auth = override?.auth ?? config.modelAuth;
  const request: ModelRequestDescriptor = {
    provider,
    model,
    // Journaled materialization (design §6.2/§6.3): the vessel resolved these
    // at the impure edge; copying them here is what makes replay independent
    // of the installed model registry.
    modelSpec,
    ...(auth ? { auth } : {}),
    thinkingLevel: override?.thinkingLevel ?? config.thinkingLevel,
    ...(config.fastMode && modelSpec.serviceTiers?.includes("priority")
      ? { serviceTier: "priority" as const }
      : {}),
    systemPromptHash: config.systemPromptHash,
    ...(config.skillIndexHash ? { skillIndexHash: config.skillIndexHash } : {}),
    ...(config.toolSchemasHash ? { toolSchemasHash: config.toolSchemasHash } : {}),
    activeToolNames: config.activeToolNames,
    channelToolOwners: channelToolOwnersFor(
      config.roster,
      latestUserParticipantId(state),
      state.selfId
    ),
    askUserParticipants: config.roster.participants
      .filter((participant) => participant.ref.kind === "user")
      .map((participant) => ({
        participantId: participant.participantId,
        ref: participant.ref,
        ...(participant.handle ? { handle: participant.handle } : {}),
      })),
    contextThroughSeq: state.lastSeq + itemsBefore,
    attemptId,
    ...(state.openTurn?.metadata ? { turnMetadata: state.openTurn.metadata } : {}),
  };
  const item: AppendItem = {
    envelopeId: ids.messageStarted(messageId),
    payloadKind: "message.started",
    payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant", modelRequest: request },
    causality: { messageId: messageId as never, turnId },
    publish: shouldPublishTurnLifecycle(state.openTurn?.metadata),
  };
  return {
    item,
    effect: {
      effectId: ids.modelEffect(messageId),
      kind: "model_call",
      channelId: state.channelId,
      idempotencyKey: attemptId,
      messageId,
      turnId,
      request,
    },
  };
}

function turnMetadata(
  command: Extract<Command, { kind: "prompt" | "prompt-failed" | "steer" }>
): AgentTurnMetadata | undefined {
  return command.metadata;
}

function shouldPublishTurnLifecycle(metadata?: AgentTurnMetadata): boolean {
  return metadata?.delivery !== "none";
}

function recvItem(
  command: Extract<Command, { kind: "prompt" | "prompt-failed" | "steer" }>
): AppendItem {
  return {
    envelopeId: ids.recvUserMessage(command.channelId, command.source.envelopeId),
    payloadKind: "message.completed",
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      role: "user",
      blocks: Array.isArray(command.content)
        ? command.content
        : [{ type: "text", content: String(command.content ?? "") }],
      outcome: "completed",
      turnTriggerEnvelopeId: command.source.envelopeId,
      ...(command.structuredInput !== undefined
        ? { structuredInput: command.structuredInput }
        : {}),
      ...(command.metadata ? { metadata: command.metadata } : {}),
      // Sender's canonical id, carried IN ADDITION to the private recv envelope
      // id so the fold can correlate read acks / edits / retracts.
      ...(command.sourceMessageId ? { sourceMessageId: command.sourceMessageId } : {}),
      // The REAL sender — the private recv envelope's actor is the agent (driver
      // stamps it), so the fold must read the original author from here for the
      // edit/retract author guard.
      senderRef: command.senderRef,
    },
    causality: {
      messageId: ids.recvUserMessage(command.channelId, command.source.envelopeId) as never,
      ...(command.agentHops !== undefined ? { agentHops: command.agentHops } : {}),
    },
    // The user's message already lives in the channel log; the trajectory
    // copy is private context (no republish).
    publish: false,
  };
}

function promptArtifactsRequestedItem(command: Extract<Command, { kind: "prompt" | "steer" }>) {
  const triggerEnvelopeId = ids.recvUserMessage(command.channelId, command.source.envelopeId);
  return {
    envelopeId: ids.promptArtifactsRequested(triggerEnvelopeId),
    payloadKind: "system.event" as const,
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      kind: "prompt.artifacts_requested",
      triggerEnvelopeId,
      turnTriggerEnvelopeId: command.source.envelopeId,
      details: {
        kind: "prompt.artifacts_requested",
        triggerEnvelopeId,
        turnTriggerEnvelopeId: command.source.envelopeId,
      },
    },
    publish: false,
  };
}

/** Re-establish the same durable prerequisite before a post-tool/model
 * continuation when an activated or migrated fold has lost its prompt hash.
 * A fresh trigger id makes this a real new effect instead of colliding with
 * the already-settled ingress preparation. */
function continuationPromptArtifactsRequestedItem(state: AgentState) {
  const turnId = state.openTurn!.turnId;
  const triggerEnvelopeId = `prompt-artifacts:continuation:${turnId}:${state.lastSeq}`;
  return {
    envelopeId: ids.promptArtifactsRequested(triggerEnvelopeId),
    payloadKind: "system.event" as const,
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      kind: "prompt.artifacts_requested",
      triggerEnvelopeId,
      turnTriggerEnvelopeId: triggerEnvelopeId,
      details: {
        kind: "prompt.artifacts_requested",
        triggerEnvelopeId,
        turnTriggerEnvelopeId: triggerEnvelopeId,
        reason: "continuation-prompt-artifact-missing",
      },
    },
    publish: false,
  };
}

function turnOpenedItem(
  turnId: string,
  metadata?: AgentTurnMetadata,
  triggerMessageId?: string
): AppendItem {
  return {
    envelopeId: ids.turnOpened(turnId),
    payloadKind: "turn.opened",
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      ...(metadata ? { metadata } : {}),
    },
    causality: {
      turnId,
      ...(triggerMessageId ? { messageId: triggerMessageId as never } : {}),
    },
    publish: shouldPublishTurnLifecycle(metadata),
  };
}

/** A monotone read-projection update. It never appends a receipt message. */
function readAckEffect(
  channelId: string,
  sourceMessageId: string,
  turnId: string,
  _ctx: StepContext
): RecordReceiptEffect {
  return {
    effectId: `read:${sourceMessageId}:${turnId}`,
    kind: "record_receipt",
    channelId,
    idempotencyKey: `read:${sourceMessageId}:${turnId}`,
    messageId: sourceMessageId,
    turnId,
  };
}

/**
 * Read acks for every sourceMessageId NEWLY consumed by an upcoming model call.
 * Consumed = the steering entries this call's contextThroughSeq will prune
 * (fold.ts) PLUS any fresh recv/promoted prompt appended in the SAME batch
 * (passed explicitly — it is not yet a folded steering entry). Must be called
 * with the EXACT contextThroughSeq the `message.started` builder embedded.
 */
function readAckEffects(opts: {
  state: AgentState;
  contextThroughSeq: number;
  freshSourceMessageIds: string[];
  turnId: string;
  ctx: StepContext;
}): RecordReceiptEffect[] {
  const consumed = new Set<string>(opts.freshSourceMessageIds.filter(Boolean));
  for (const entry of opts.state.steeringQueue) {
    if (entry.seq <= opts.contextThroughSeq && entry.sourceMessageId) {
      consumed.add(entry.sourceMessageId);
    }
  }
  return [...consumed].map((sourceMessageId) =>
    readAckEffect(opts.state.channelId, sourceMessageId, opts.turnId, opts.ctx)
  );
}

function compactSessionEntries(entries: SessionEntry[], keepCount = 8): SessionEntry[] {
  const start = Math.max(0, entries.length - keepCount);
  const keep = new Set<number>();
  const toolCallOwner = new Map<string, number>();
  const toolResultIndexes = new Map<string, number[]>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (index >= start) keep.add(index);
    if (entry.kind === "assistant") {
      for (const block of entry.blocks) {
        const id = toolCallIdFromBlock(block);
        if (id) toolCallOwner.set(id, index);
      }
      continue;
    }
    if (entry.kind === "tool-result") {
      const indexes = toolResultIndexes.get(entry.invocationId) ?? [];
      indexes.push(index);
      toolResultIndexes.set(entry.invocationId, indexes);
    }
  }

  for (let changed = true; changed; ) {
    changed = false;
    for (const index of [...keep]) {
      const entry = entries[index]!;
      if (entry.kind === "tool-result") {
        const owner = toolCallOwner.get(entry.invocationId);
        if (owner !== undefined && !keep.has(owner)) {
          keep.add(owner);
          changed = true;
        }
        continue;
      }
      if (entry.kind === "assistant") {
        for (const block of entry.blocks) {
          const id = toolCallIdFromBlock(block);
          if (!id) continue;
          for (const resultIndex of toolResultIndexes.get(id) ?? []) {
            if (!keep.has(resultIndex)) {
              keep.add(resultIndex);
              changed = true;
            }
          }
        }
      }
    }
  }
  return entries.filter((_entry, index) => keep.has(index));
}

function toolCallIdFromBlock(block: unknown): string | null {
  if (!block || typeof block !== "object") return null;
  const record = block as Record<string, unknown>;
  const type = record["type"];
  if (type !== "toolCall" && type !== "tool_call") return null;
  const id = record["id"] ?? record["toolCallId"] ?? record["call_id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

function assistantBelongsToTurn(entry: SessionEntry, turnId: string): boolean {
  return entry.kind === "assistant" && entry.messageId.startsWith(`m:${turnId}:`);
}

/** Mint a fresh private recv copy for a promoted after-turn message. A NEW
 *  deterministic envelopeId (not the arrival id) so dedup never rejects it;
 *  only sourceMessageId + content carry over, and deliverAfterTurn is stripped
 *  so the promotion is never re-deferred. */
function promotedRecvItem(head: DeferredPrompt, promotionSeq: number): AppendItem {
  const content =
    head.content && typeof head.content === "object" && !Array.isArray(head.content)
      ? (head.content as Record<string, unknown>)
      : {};
  const metadata = head.metadata ? { ...head.metadata, deliverAfterTurn: undefined } : undefined;
  const envelopeId = ids.recvPromoted(head.sourceMessageId, promotionSeq);
  return {
    envelopeId,
    payloadKind: "message.completed",
    payload: {
      ...content,
      protocol: AGENTIC_PROTOCOL_VERSION,
      role: "user",
      outcome: "completed",
      sourceMessageId: head.sourceMessageId,
      senderRef: head.senderRef,
      promptArtifactsReady: true,
      turnTriggerEnvelopeId: envelopeId,
      ...(metadata ? { metadata } : {}),
    },
    causality: {
      messageId: ids.recvPromoted(head.sourceMessageId, promotionSeq) as never,
      ...(head.agentHops !== undefined ? { agentHops: head.agentHops } : {}),
    },
    publish: false,
  };
}

/**
 * Open the next turn for a pending prompt and fire its first model call. Shared
 * by the C-prompt wake path and the turn-close after-turn promotion. `state`
 * must already reflect `precedingAppend` folded (pendingPrompt set, no open
 * turn). `precedingAppend` are the items that precede `turn.opened` in the same
 * batch (the orphan-cleanup append, or the promoted recv).
 */
function promotePendingPrompt(
  state: AgentState,
  ctx: StepContext,
  precedingAppend: AppendItem[]
): StepOutput {
  const prompt = state.pendingPrompt!;
  if (!prompt.artifactsReady || Object.keys(state.pendingPromptPreparations).length > 0) {
    return EMPTY;
  }
  const turnId = ids.turnId(state.channelId, prompt.turnTriggerEnvelopeId, ctx.selfRef.id);
  const opened = turnOpenedItem(turnId, prompt.metadata, prompt.envelopeId);
  const afterOpened: AgentState = {
    ...state,
    openTurn: {
      turnId,
      openedAtSeq: state.lastSeq + 1,
      modelCallCount: 0,
      consecutiveModelFailureCount: 0,
      interrupted: false,
      waitingCount: 0,
      ...(prompt.metadata ? { metadata: prompt.metadata } : {}),
    },
  };
  const { item, effect } = modelStartItems(afterOpened, turnId, 0, 1);
  const readAcks = readAckEffects({
    state: afterOpened,
    contextThroughSeq: effect.request.contextThroughSeq,
    freshSourceMessageIds: prompt.sourceMessageId ? [prompt.sourceMessageId] : [],
    turnId,
    ctx,
  });
  return { append: [...precedingAppend, opened, item], effects: [effect, ...readAcks] };
}

/**
 * Open a fresh turn that folds the queued steers when NO turn is open. Used when
 * a blocked turn (waiting on a pending invocation, e.g. a feedback form, or
 * already interrupted) was force-closed by a flush: steers can't inject
 * mid-turn, so they bootstrap their own turn. The steer recvs are already in
 * `entries`; the model call folds + read-acks them via contextThroughSeq.
 */
function promoteSteersAsTurn(state: AgentState, ctx: StepContext): StepOutput {
  if (
    Object.keys(state.pendingPromptPreparations).length > 0 ||
    state.steeringQueue.some((entry) => !entry.artifactsReady)
  ) {
    return EMPTY;
  }
  const head = state.steeringQueue[0]!;
  const turnId = ids.turnId(state.channelId, head.turnTriggerEnvelopeId, ctx.selfRef.id);
  const opened = turnOpenedItem(turnId, head.metadata, head.envelopeId);
  const afterOpened: AgentState = {
    ...state,
    openTurn: {
      turnId,
      openedAtSeq: state.lastSeq + 1,
      modelCallCount: 0,
      consecutiveModelFailureCount: 0,
      interrupted: false,
      waitingCount: 0,
      ...(head.metadata ? { metadata: head.metadata } : {}),
    },
  };
  const { item, effect } = modelStartItems(afterOpened, turnId, 0, 1);
  const readAcks = readAckEffects({
    state: afterOpened,
    contextThroughSeq: effect.request.contextThroughSeq,
    freshSourceMessageIds: [],
    turnId,
    ctx,
  });
  return { append: [opened, item], effects: [effect, ...readAcks] };
}

function promoteDeferredHead(state: AgentState, ctx: StepContext): StepOutput {
  const head = state.deferredPostTurnQueue[0];
  if (!head?.artifactsReady || Object.keys(state.pendingPromptPreparations).length > 0) {
    return EMPTY;
  }
  const recv = promotedRecvItem(head, state.lastSeq);
  const afterRecv = projectAppend(state, [recv], ctx.now);
  return promotePendingPrompt(afterRecv, ctx, [recv]);
}

function turnClosedItem(
  turn: Pick<OpenTurn, "turnId" | "metadata"> | string,
  opts: { reason?: string; summary?: string } = {}
): AppendItem {
  const turnId = typeof turn === "string" ? turn : turn.turnId;
  const metadata = typeof turn === "string" ? undefined : turn.metadata;
  return {
    envelopeId: ids.turnClosed(turnId),
    payloadKind: "turn.closed",
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.summary ? { summary: opts.summary } : {}),
      ...(metadata ? { metadata } : {}),
    },
    causality: { turnId },
    publish: true,
  };
}

function infrastructureFailureDiagnostic(
  turn: OpenTurn,
  invocationId: string,
  code: string,
  reason: "explicit-stop" | "circuit-open"
): AppendItem {
  const messageId = `diag:${turn.turnId}:infrastructure:${invocationId}`;
  return {
    envelopeId: messageId,
    payloadKind: "message.completed",
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      role: "assistant",
      blocks: [
        {
          type: "diagnostic",
          content:
            reason === "circuit-open"
              ? "I paused after the same tool encountered three consecutive infrastructure failures. " +
                "This prevents an automatic retry loop; send “continue” after the underlying service changes."
              : "I paused because the tool explicitly reported that continuing this turn is unsafe. " +
                "Send “continue” after the reported recovery condition has been resolved.",
          metadata: {
            code,
            severity: "error",
            invocationId,
            recoverableByNewTurn: true,
          },
        },
      ],
      outcome: "completed",
    },
    causality: { messageId: messageId as never, turnId: turn.turnId },
    publish: true,
  };
}

function recoveryActionFromFailurePayload(payload: Record<string, unknown>): string | undefined {
  const failure = payload["failure"];
  if (!failure || typeof failure !== "object") return undefined;
  const recovery = (failure as Record<string, unknown>)["recovery"];
  if (!recovery || typeof recovery !== "object") return undefined;
  const action = (recovery as Record<string, unknown>)["action"];
  return typeof action === "string" ? action : undefined;
}

function infrastructureFailureTerminatesTurn(payload: Record<string, unknown>): boolean {
  if (payload["terminalOutcome"] !== "infrastructure_error") return false;
  const action = recoveryActionFromFailurePayload(payload);
  return action === "stop";
}

function consecutiveToolInfrastructureFailureCount(
  state: AgentState,
  turn: OpenTurn,
  invocationId: string,
  payload: Record<string, unknown>
): number {
  if (payload["terminalOutcome"] !== "infrastructure_error") return 0;
  const foldedCurrent = [...state.entries]
    .reverse()
    .find(
      (entry): entry is Extract<SessionEntry, { kind: "tool-result" }> =>
        entry.kind === "tool-result" && entry.invocationId === invocationId
    );
  const name = foldedCurrent?.name ?? state.pendingInvocations[invocationId]?.name ?? "unknown";
  let count = foldedCurrent ? 0 : 1;
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (!entry || entry.seq < turn.openedAtSeq) break;
    if (entry.kind !== "tool-result") continue;
    if (entry.terminalOutcome !== "infrastructure_error" || entry.name !== name) {
      break;
    }
    count += 1;
  }
  return count;
}

function turnWaitingItem(
  turnId: string,
  waitingCount: number,
  opts: {
    reason: string;
    summary?: string;
  }
): AppendItem {
  return {
    envelopeId: ids.turnWaiting(turnId, waitingCount),
    payloadKind: "turn.waiting",
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      reason: opts.reason,
      ...(opts.summary ? { summary: opts.summary } : {}),
    },
    causality: { turnId },
    publish: true,
  };
}

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

/** Terminal cleanup for an interrupted/aborted turn (E-after-interrupt). */
function interruptCleanupItems(state: AgentState, reason: string): AppendItem[] {
  const items: AppendItem[] = [];
  for (const invocation of Object.values(state.pendingInvocations)) {
    // Carry the transportCallId (the on-the-wire id the PROVIDER knows — its
    // internal invocationId is never sent to them) so consumers can correlate
    // the cancellation. Without it a panel feedback form, keyed by the
    // transportCallId it received, can't tell its invocation was cancelled and
    // lingers on screen after an interrupt/flush. Mirror the dispatch's id.
    const transportCallId =
      (invocation.transport as { transportCallId?: string } | null | undefined)?.transportCallId ??
      ids.transportCallId(invocation.invocationId);
    items.push({
      envelopeId: ids.invocationTerminal(invocation.invocationId),
      payloadKind: "invocation.cancelled",
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason,
        terminalOutcome: "cancelled",
        terminalReasonCode: reason,
      },
      causality: {
        invocationId: invocation.invocationId as never,
        transportCallId: transportCallId as never,
        turnId: invocation.turnId,
      },
      publish: true,
    });
  }
  for (const approval of Object.values(state.pendingApprovals)) {
    items.push({
      envelopeId: ids.approvalResolved(approval.approvalId),
      payloadKind: "approval.resolved",
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        granted: false,
        resolvedBy: { kind: "system", id: "agent-loop" },
        reason,
      },
      causality: {
        approvalId: approval.approvalId as never,
        invocationId: approval.invocationId as never,
        turnId: approval.turnId,
      },
      publish: true,
    });
  }
  for (const wait of Object.values(state.pendingCredentialWaits)) {
    items.push({
      envelopeId: ids.systemEvent(wait.credKey, "resolved", wait.startedAtSeq),
      payloadKind: "system.event",
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        kind: "credential.wait_resolved",
        credKey: wait.credKey,
        details: {
          kind: "credential.wait_resolved",
          credKey: wait.credKey,
          providerId: wait.providerId,
          resolved: false,
          reason,
        },
      },
      causality: { turnId: wait.turnId },
      publish: true,
    });
  }
  if (state.openTurn) {
    items.push(
      turnClosedItem(state.openTurn, {
        reason: reason === "forked" ? "forked" : "user_interrupted",
      })
    );
  }
  return items;
}

/** E-model-terminal expansion: journal one invocation.started per tool call
 *  and emit the matching dispatch effects. Also used by C-wake recovery for
 *  unprocessed tool calls (deterministic ids make re-expansion idempotent). */
/** Local tools dispatch in-process; any roster participant advertising the
 *  method becomes a channel_call target (the panel's eval/UI tools). Unknown
 *  names stay local so the local executor reports "unknown tool". */
function transportForToolCall(
  state: AgentState,
  channelToolOwners: Record<string, ParticipantRef>,
  name: string,
  invocationId: string
):
  | { kind: "local"; awaiterId: string }
  | { kind: "channel"; channelId: string; target: unknown; transportCallId: string } {
  if (state.config.activeToolNames.includes(name)) {
    return { kind: "local", awaiterId: invocationId };
  }
  const owner = channelToolOwners[name];
  if (owner) {
    return {
      kind: "channel",
      channelId: state.channelId,
      target: owner,
      transportCallId: ids.transportCallId(invocationId),
    };
  }
  return { kind: "local", awaiterId: invocationId };
}

function expandToolCalls(
  state: AgentState,
  toolCalls: ToolCallBlock[],
  messageId: string,
  turnId: string,
  ctx: StepContext
): StepOutput {
  const append: AppendItem[] = [];
  const effects: EffectDescriptor[] = [];
  const attemptId = messageId ? ids.attemptId(messageId) : "";
  const channelToolOwners =
    state.openTurn?.activeModelRequest?.channelToolOwners ??
    channelToolOwnersFor(state.config.roster, latestUserParticipantId(state), state.selfId);
  let projected = state;
  for (const block of toolCalls) {
    const invocationId = block.id;
    const item: AppendItem = {
      envelopeId: ids.invocationStart(invocationId),
      payloadKind: "invocation.started",
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: block.name,
        invocationType: "tool",
        request: block.arguments,
        transport: transportForToolCall(state, channelToolOwners, block.name, invocationId),
        executionMode:
          state.config.localToolExecutionModes?.[block.name] === "parallel"
            ? "parallel"
            : "sequential",
        userVisible: true,
      },
      causality: {
        ...(messageId ? { messageId: messageId as never } : {}),
        invocationId: invocationId as never,
        modelToolCallId: invocationId,
        attemptId,
        turnId,
      },
      publish: true,
    };
    append.push(item);
    projected = projectAppend(projected, [item], ctx.now);
    effects.push(invocationEffect(projected, projected.pendingInvocations[invocationId]!));
  }
  return { append, effects };
}

/** Project the post-append state (fold over synthetic envelopes — pure). */
export function projectAppend(state: AgentState, append: AppendItem[], now: string): AgentState {
  let next = state;
  let seq = state.lastSeq;
  const actor = { kind: "agent" as const, id: state.selfId ?? "self" };
  for (const item of append) {
    seq += 1;
    const envelope = {
      logId: state.logId,
      head: state.head,
      seq,
      envelopeId: item.envelopeId,
      actor,
      payloadKind: item.payloadKind,
      payload: item.payload,
      causality: item.causality,
      appendedAt: now,
      prevHash: next.lastHash,
      hash: `projected:${seq}`,
    } as unknown as LogEnvelope;
    next = applyEvent(next, envelope);
  }
  return next;
}

/** The C-wake duplicate-dispatch guard (plan WS1.4): never start a new model
 *  call while any invocation from a FAILED attempt is non-terminal. */
function wakeGuardSatisfied(state: AgentState): boolean {
  if (hasCurrentTurnPromptPreparation(state)) return false;
  if (state.inFlightModelCall) return false;
  const currentAttempts = new Set<string>();
  // every pending invocation belongs to some attempt; with no in-flight call
  // any non-terminal invocation blocks a fresh model call
  for (const invocation of Object.values(state.pendingInvocations)) {
    currentAttempts.add(invocation.attemptId ?? "");
  }
  return currentAttempts.size === 0;
}

/**
 * Prompt artifacts for a send-after-turn message belong to its future turn.
 * Preparing them eagerly is useful, but that preparation must not become a
 * dependency of the currently open turn. Steering messages are different:
 * they enter the current context, so their artifacts must be ready before the
 * next model call is composed.
 */
function hasCurrentTurnPromptPreparation(state: AgentState): boolean {
  const deferredEnvelopeIds = new Set(
    state.deferredPostTurnQueue.map((prompt) => prompt.envelopeId)
  );
  return Object.keys(state.pendingPromptPreparations).some(
    (triggerEnvelopeId) => !deferredEnvelopeIds.has(triggerEnvelopeId)
  );
}

function suspendTurnFromInvocationPayload(
  payload: Record<string, unknown>
): { reason: string; summary: string } | null {
  const turnControl =
    payload["turnControl"] && typeof payload["turnControl"] === "object"
      ? (payload["turnControl"] as Record<string, unknown>)
      : null;
  if (turnControl?.["kind"] !== "suspend") return null;
  const reason =
    typeof turnControl["reason"] === "string" && turnControl["reason"].trim()
      ? turnControl["reason"].trim()
      : "no_foreground_work";
  return {
    reason,
    summary:
      (typeof turnControl["summary"] === "string" && turnControl["summary"].trim()
        ? turnControl["summary"].trim()
        : undefined) ??
      (reason === "waiting_for_background"
        ? "Suspended until background work or user input arrives"
        : "Suspended until new relevant input arrives"),
  };
}

/** Match the tool runtime's batch termination contract after durable folding:
 * early termination is valid only when every finalized tool result from this
 * model attempt requested it. Mixed batches continue through the model. */
function completedToolBatchTerminates(state: AgentState, invocationId: string): boolean {
  const current = [...state.entries]
    .reverse()
    .find((entry) => entry.kind === "tool-result" && entry.invocationId === invocationId);
  if (current?.kind !== "tool-result" || !current.attemptId) return false;
  const batch = state.entries.filter(
    (entry): entry is Extract<SessionEntry, { kind: "tool-result" }> =>
      entry.kind === "tool-result" && entry.attemptId === current.attemptId
  );
  return batch.length > 0 && batch.every((entry) => entry.terminate === true);
}

function hasFreshInput(state: AgentState): boolean {
  if (state.steeringQueue.length > 0) return true;
  // A parked turn resumes only for transcript input appended after its
  // turn.waiting boundary. In particular, the suspend_turn tool result is
  // older than that boundary and must not stimulate its own recovery wake.
  const lastEntry = state.entries[state.entries.length - 1];
  if (lastEntry?.kind !== "tool-result") return false;
  return state.openTurn?.waitingAtSeq === undefined || lastEntry.seq > state.openTurn.waitingAtSeq;
}

export const DEFAULT_MAX_CONSECUTIVE_MODEL_FAILURES = 3;

function modelRetryLimitExceeded(turn: OpenTurn): boolean {
  return turn.consecutiveModelFailureCount >= DEFAULT_MAX_CONSECUTIVE_MODEL_FAILURES;
}

function modelRetryLimitItems(turn: OpenTurn): AppendItem[] {
  const count = turn.consecutiveModelFailureCount;
  return [
    {
      envelopeId: `diag:${turn.turnId}:model-retry-limit-exceeded`,
      payloadKind: "message.completed",
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [
          {
            type: "diagnostic",
            content:
              `Model retry limit reached for ${turn.turnId}: ` +
              `${count} consecutive model failure(s) occurred, so this turn was stopped ` +
              "to avoid an automatic retry loop.",
            metadata: {
              code: "model_retry_limit_exceeded",
              severity: "error",
              limit: DEFAULT_MAX_CONSECUTIVE_MODEL_FAILURES,
              consecutiveModelFailureCount: count,
              turnId: turn.turnId,
            },
          },
        ],
        outcome: "completed",
      },
      causality: {
        messageId: `diag:${turn.turnId}:model-retry-limit-exceeded` as never,
        turnId: turn.turnId,
      },
      publish: true,
    },
    turnClosedItem(turn, { reason: "model_retry_limit_exceeded" }),
  ];
}

function nextModelCall(
  state: AgentState,
  itemsBefore: number,
  ctx: StepContext,
  freshSourceMessageIds: string[] = []
): StepOutput {
  if (hasCurrentTurnPromptPreparation(state)) return EMPTY;
  const turn = state.openTurn!;
  if (!state.config.systemPromptHash) {
    return {
      append: [continuationPromptArtifactsRequestedItem(state)],
      effects: [],
    };
  }
  if (modelRetryLimitExceeded(turn)) {
    return {
      append: modelRetryLimitItems(turn),
      effects: [],
    };
  }
  const activeFallback =
    turn.failedOverToFallback && turn.activeModelRequest
      ? {
          modelRef: `${turn.activeModelRequest.provider}:${turn.activeModelRequest.model}`,
          modelSpec: turn.activeModelRequest.modelSpec,
          auth: turn.activeModelRequest.auth ?? state.config.fallbackModelAuth ?? "loopback",
          thinkingLevel: turn.activeModelRequest.thinkingLevel,
        }
      : undefined;
  const { item, effect } = modelStartItems(
    state,
    turn.turnId,
    turn.modelCallCount,
    itemsBefore,
    activeFallback
  );
  const readAcks = readAckEffects({
    state,
    contextThroughSeq: effect.request.contextThroughSeq,
    freshSourceMessageIds,
    turnId: turn.turnId,
    ctx,
  });
  return { append: [item], effects: [effect, ...readAcks] };
}

function isUnattendedTurn(turn: OpenTurn): boolean {
  return turn.metadata?.origin === "scheduled";
}

function fallbackNoticeItem(
  state: AgentState,
  turn: OpenTurn,
  failedMessageId: string,
  fallbackModelRef: string,
  failureCode: string,
  fallbackThinkingLevel: AgentLoopConfig["thinkingLevel"]
): AppendItem {
  const failedRequest = turn.lastFailedModelRequest;
  const failedModelRef = failedRequest
    ? `${failedRequest.provider}:${failedRequest.model}`
    : state.config.model;
  const summary = `continued on ${fallbackModelRef} after ${failureCode}`;
  return {
    envelopeId: ids.systemEvent(turn.turnId, "model-fallback", state.lastSeq),
    payloadKind: "system.event",
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      kind: FALLBACK_NOTICE_KIND,
      summary,
      details: {
        kind: FALLBACK_NOTICE_KIND,
        failedMessageId,
        failedModelRef,
        failureCode,
        fallbackModelRef,
        fallbackThinkingLevel,
        summary,
      },
    },
    causality: { turnId: turn.turnId, messageId: failedMessageId as never },
    publish: true,
  };
}

function shouldFailOverToFallback(
  state: AgentState,
  turn: OpenTurn,
  payload: Record<string, unknown>
): { fallbackModelRef: string; fallbackModelSpec: AgentModelSpec } | null {
  if (state.config.fallbackScope !== "all-turns" && !isUnattendedTurn(turn)) return null;
  if (turn.failedOverToFallback) return null;
  const code = payload["code"];
  const configuredCodes = state.config.fallbackFailureCodes;
  if (
    configuredCodes
      ? typeof code !== "string" || !configuredCodes.includes(code)
      : !isProviderLevelFailureCode(code)
  ) {
    return null;
  }
  const fallbackModelRef = state.config.fallbackModelRef;
  const fallbackModelSpec = state.config.fallbackModelSpec;
  if (!fallbackModelRef || !fallbackModelSpec) return null;
  const fallbackRequest = parseModel(fallbackModelRef);
  if (
    turn.lastFailedModelRequest?.provider === fallbackRequest.provider &&
    turn.lastFailedModelRequest.model === fallbackRequest.model
  ) {
    return null;
  }
  return { fallbackModelRef, fallbackModelSpec };
}

function fallbackModelCall(
  state: AgentState,
  ctx: StepContext,
  turn: OpenTurn,
  failedMessageId: string,
  failureCode: string,
  fallback: { fallbackModelRef: string; fallbackModelSpec: AgentModelSpec }
): StepOutput {
  const fallbackThinkingLevel = state.config.fallbackThinkingLevel ?? state.config.thinkingLevel;
  const notice = fallbackNoticeItem(
    state,
    turn,
    failedMessageId,
    fallback.fallbackModelRef,
    failureCode,
    fallbackThinkingLevel
  );
  const { item, effect } = modelStartItems(state, turn.turnId, turn.modelCallCount, 1, {
    modelRef: fallback.fallbackModelRef,
    modelSpec: fallback.fallbackModelSpec,
    auth: state.config.fallbackModelAuth ?? "loopback",
    thinkingLevel: fallbackThinkingLevel,
  });
  const readAcks = readAckEffects({
    state,
    contextThroughSeq: effect.request.contextThroughSeq,
    freshSourceMessageIds: [],
    turnId: turn.turnId,
    ctx,
  });
  return { append: [notice, item], effects: [effect, ...readAcks] };
}

/**
 * One incremental flush step (an `Esc` / "Send now"): advance the pipeline by
 * exactly one step. Priority: queued steers first (deliver them within the open
 * turn, leaving the deferred queue untouched), else promote exactly ONE deferred
 * head. Returns null to fall through to a plain interrupt. The driver still
 * aborts any in-flight executor (the vessel calls abortChannel around this).
 */
function flushStep(state: AgentState, ctx: StepContext): StepOutput | null {
  // Priority 1: deliver queued steers within the current open turn.
  if (state.steeringQueue.length > 0) {
    if (!state.openTurn) {
      // No open turn (a prior flush force-closed it): steers can't inject
      // mid-turn — bootstrap a fresh turn that folds them.
      return promoteSteersAsTurn(state, ctx);
    }
    if (state.inFlightModelCall) {
      // Soft flush: the driver aborts the model, but the turn must CONTINUE.
      // The marker sets openTurn.pendingFlush; the interrupted terminal re-runs
      // the model with the queued steers consumed. Appended BEFORE the abort
      // (vessel ordering) so the flag is folded before the terminal lands.
      return {
        append: [
          {
            envelopeId: ids.systemEvent(state.openTurn.turnId, "flush-steers", state.lastSeq),
            payloadKind: "system.event",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              kind: "flush_steers",
              details: { kind: "flush_steers" },
            },
            causality: { turnId: state.openTurn.turnId },
            publish: true,
          },
        ],
        effects: [],
      };
    }
    if (!state.openTurn.interrupted && wakeGuardSatisfied(state)) {
      return nextModelCall(state, 0, ctx);
    }
    // Blocked: the turn is interrupted, or waiting on a pending invocation (e.g.
    // a feedback form). "Send now" means abandon the wait — interruptCleanupItems
    // cancels every pending invocation (a valid cancelled tool-result) and closes
    // the turn; the turn.closed cascade then opens a fresh turn folding the steers.
    return { append: interruptCleanupItems(state, "user_interrupted"), effects: [] };
  }

  // Priority 2: promote exactly ONE deferred head.
  if (state.deferredPostTurnQueue.length > 0) {
    if (state.openTurn) {
      if (state.inFlightModelCall) {
        // Hard interrupt: abort + close. The turn-close cascade promotes the
        // head into a fresh turn (one-per-turn cadence preserved under flush).
        return {
          append: [
            {
              envelopeId: ids.interruptEvent(state.openTurn.turnId, "user_interrupted"),
              payloadKind: "system.event",
              payload: {
                protocol: AGENTIC_PROTOCOL_VERSION,
                kind: "interrupt",
                details: { kind: "interrupt", reason: "user_interrupted" },
              },
              causality: { turnId: state.openTurn.turnId },
              publish: true,
            },
          ],
          effects: [],
        };
      }
      // Idle open turn: close it now; the turn.closed cascade promotes the head.
      return { append: interruptCleanupItems(state, "user_interrupted"), effects: [] };
    }
    // No open turn: promote the head directly.
    const head = state.deferredPostTurnQueue[0]!;
    const recv = promotedRecvItem(head, state.lastSeq);
    const afterRecv = projectAppend(state, [recv], ctx.now);
    return promotePendingPrompt(afterRecv, ctx, [recv]);
  }

  return null;
}

export function coreStep(state: AgentState, incoming: Incoming, ctx: StepContext): StepOutput {
  if (incoming.type === "command") return commandStep(state, incoming.command, ctx);
  if (incoming.type === "event-appended") return eventStep(state, incoming.envelope, ctx);
  return effectFailedStep(state, incoming, ctx);
}

/** A channel may redeliver the same event (retry, resubscribe, channel DO
 *  restart). The recv envelope id is deterministic from the source envelope,
 *  so "this prompt/steer was already folded" is exactly "its recv id is in
 *  state". Without this guard a redelivery re-emits the whole prompt batch,
 *  whose replayed prefix is no longer at head once the turn progressed — the
 *  gad store rejects the append and the delivery wedges in a retry loop. */
function alreadyIngested(state: AgentState, recvEnvelopeId: string): boolean {
  return (
    state.pendingPrompt?.envelopeId === recvEnvelopeId ||
    state.steeringQueue.some((entry) => entry.envelopeId === recvEnvelopeId) ||
    state.deferredPostTurnQueue.some((entry) => entry.envelopeId === recvEnvelopeId) ||
    state.entries.some((entry) => entry.kind === "user" && entry.envelopeId === recvEnvelopeId)
  );
}

function commandStep(state: AgentState, command: Command, ctx: StepContext): StepOutput {
  switch (command.kind) {
    case "invoke": {
      if (state.openTurn) {
        throw new Error("Cannot start a direct invocation while another turn is open");
      }
      const turnId = ids.turnId(state.channelId, command.source.envelopeId, ctx.selfRef.id);
      const messageId = ids.messageId(turnId, 0);
      const invocationId = `direct:${turnId}:${command.tool}`;
      const opened = turnOpenedItem(turnId, command.metadata);
      const message: AppendItem = {
        envelopeId: ids.messageTerminal(messageId),
        payloadKind: "message.completed",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          role: "assistant",
          blocks: [
            {
              type: "toolCall",
              id: invocationId,
              name: command.tool,
              arguments: command.args,
            },
          ],
          outcome: "tool_calls_only",
          tier: "secondary",
        },
        causality: { messageId: messageId as never, turnId },
        publish: true,
      };
      // The ordinary message.completed cascade owns invocation.started and
      // effect dispatch. Direct turns only bypass the model call; they do not
      // create a second tool lifecycle.
      return { append: [opened, message], effects: [] };
    }

    case "prompt-failed": {
      const recvEnvelopeId = ids.recvUserMessage(command.channelId, command.source.envelopeId);
      if (alreadyIngested(state, recvEnvelopeId)) return EMPTY;
      const recv = recvItem(command);
      const turnId = ids.turnId(command.channelId, command.source.envelopeId, ctx.selfRef.id);
      const messageId = `m:${turnId}:prompt-infrastructure-failure`;
      return {
        append: [
          recv,
          turnOpenedItem(turnId, turnMetadata(command), recv.envelopeId),
          {
            envelopeId: ids.messageTerminal(messageId),
            payloadKind: "message.failed",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              reason: command.reason,
              recoverable: false,
              code: command.code,
            },
            causality: { messageId: messageId as never, turnId },
            publish: true,
          },
          {
            envelopeId: ids.turnClosed(turnId),
            payloadKind: "turn.closed",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              reason: "work_failed",
              summary: "Agent prompt infrastructure failed before model execution.",
              ...(turnMetadata(command) ? { metadata: turnMetadata(command) } : {}),
            },
            causality: { turnId },
            publish: shouldPublishTurnLifecycle(turnMetadata(command)),
          },
        ],
        effects: [],
      };
    }

    case "prompt": {
      if (
        alreadyIngested(state, ids.recvUserMessage(command.channelId, command.source.envelopeId))
      ) {
        return EMPTY;
      }
      // Send-after-turn while a turn is open: append the recv (the fold stashes
      // it in deferredPostTurnQueue) but do NOT fire a model call — degrading to
      // steer would otherwise reach nextModelCall and fire a redundant call.
      if (
        command.metadata?.deliverAfterTurn &&
        state.openTurn &&
        state.openTurn.waitingAtSeq === undefined
      ) {
        return {
          append: [recvItem(command), promptArtifactsRequestedItem(command)],
          effects: [],
        };
      }
      if (state.openTurn) {
        return {
          append: [recvItem(command), promptArtifactsRequestedItem(command)],
          effects: [],
        };
      }
      const recv = recvItem(command);
      return {
        append: [recv, promptArtifactsRequestedItem(command)],
        effects: [],
      };
    }

    case "steer": {
      const recv = recvItem(command);
      if (alreadyIngested(state, recv.envelopeId)) return EMPTY;
      return {
        append: [recv, promptArtifactsRequestedItem(command)],
        effects: [],
      };
    }

    case "edit": {
      // Private trajectory copy of an edit mutation; the fold enforces the
      // author guard and the read-wins cutoff. publish:false — the public
      // channel already carries the client's message.edited.
      return {
        append: [
          {
            envelopeId: ids.messageEdited(command.sourceMessageId, state.lastSeq),
            payloadKind: "message.edited",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              by: command.by,
              blocks: command.blocks,
            },
            causality: { messageId: command.sourceMessageId as never },
            publish: false,
          },
        ],
        effects: [],
      };
    }

    case "retract": {
      return {
        append: [
          {
            envelopeId: ids.messageRetracted(command.sourceMessageId, state.lastSeq),
            payloadKind: "message.retracted",
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, by: command.by },
            causality: { messageId: command.sourceMessageId as never },
            publish: false,
          },
        ],
        effects: [],
      };
    }

    case "interrupt":
    case "abort": {
      // Incremental flush (one Esc = one step): steers first, else promote one
      // deferred head, else plain interrupt. The steer-vs-deferred decision is
      // loop-side (reads the authoritative queues); the client only triggers
      // interrupt + flushDeferred.
      if (command.kind === "interrupt" && command.flushDeferred) {
        const flushed = flushStep(state, ctx);
        if (flushed) return flushed;
      }
      if (!state.openTurn) return EMPTY;
      const reason =
        command.kind === "abort" ? (command.reason ?? "work_failed") : "user_interrupted";
      const marker: AppendItem = {
        envelopeId: ids.interruptEvent(state.openTurn.turnId, reason),
        payloadKind: "system.event",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          kind: "interrupt",
          details: { kind: "interrupt", reason },
        },
        causality: { turnId: state.openTurn.turnId },
        publish: true,
      };
      if (state.inFlightModelCall) {
        // The driver aborts the model executor; cleanup happens when its
        // interrupted terminal lands (E-model-terminal interrupted path).
        return { append: [marker], effects: [] };
      }
      const interrupted = projectAppend(state, [marker], ctx.now);
      return { append: [marker, ...interruptCleanupItems(interrupted, reason)], effects: [] };
    }

    case "setConfig": {
      return {
        append: [
          {
            envelopeId: ids.configChange(
              patchHashOf(command.patch),
              state.lastSeq // monotone disambiguator
            ),
            payloadKind: "system.event",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              kind: "config.changed",
              details: { kind: "config.changed", patch: command.patch },
            },
            publish: true,
          },
        ],
        effects: [],
      };
    }

    case "setRoster": {
      return {
        append: [
          {
            envelopeId: ids.systemEvent(
              `${state.channelId}:${state.selfId}:${state.lastSeq}:${patchHashOf(command.roster)}`,
              "roster"
            ),
            payloadKind: "system.event",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              kind: "roster.snapshot",
              details: { kind: "roster.snapshot", roster: command.roster },
            },
          },
        ],
        effects: [],
      };
    }

    case "compact": {
      // Exact-entry compaction (model-summarized compaction is a follow-on).
      if (state.entries.length === 0) return EMPTY;
      const keep = compactSessionEntries(state.entries);
      const turnId = state.openTurn?.turnId ?? "idle";
      return {
        append: [
          {
            envelopeId: ids.compaction(turnId, state.lastSeq),
            payloadKind: "system.compaction_recorded",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              summary: `compacted ${state.entries.length - keep.length} entries`,
              rangeStart: String(state.entries[0]?.seq ?? 0) as never,
              rangeEnd: String(keep[0]?.seq ?? 0) as never,
              replacement: keep,
            },
            publish: false,
          },
        ],
        effects: [],
      };
    }

    case "wake": {
      const append: AppendItem[] = [];
      // 1. orphan message.started: wake implies no executor is running
      if (state.inFlightModelCall) {
        append.push({
          envelopeId: ids.messageTerminal(state.inFlightModelCall.messageId),
          payloadKind: "message.failed",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            reason: "interrupted by restart",
            recoverable: true,
          },
          causality: { messageId: state.inFlightModelCall.messageId as never },
          publish: true,
        });
      }
      const afterOrphan = projectAppend(state, append, ctx.now);
      if (
        afterOrphan.openTurn &&
        afterOrphan.openTurn.interrupted &&
        !afterOrphan.inFlightModelCall
      ) {
        return {
          append: [...append, ...interruptCleanupItems(afterOrphan, "user_interrupted")],
          effects: [],
        };
      }
      // 2a. crash between model terminal and tool expansion: the last assistant
      // entry carries toolCall blocks with neither a pending invocation nor a
      // tool-result — re-expand them (idempotent via deterministic ids).
      if (
        afterOrphan.openTurn &&
        !afterOrphan.openTurn.interrupted &&
        !afterOrphan.inFlightModelCall
      ) {
        const turnId = afterOrphan.openTurn.turnId;
        const lastAssistant = [...afterOrphan.entries]
          .reverse()
          .find((entry) => assistantBelongsToTurn(entry, turnId));
        if (lastAssistant && lastAssistant.kind === "assistant") {
          const settled = new Set(
            afterOrphan.entries
              .filter((entry) => entry.kind === "tool-result")
              .map((entry) => (entry as { invocationId: string }).invocationId)
          );
          const unprocessed = lastAssistant.blocks
            .filter(isToolCallBlock)
            .filter(
              (block) => !(block.id in afterOrphan.pendingInvocations) && !settled.has(block.id)
            );
          if (unprocessed.length > 0) {
            const expansion = expandToolCalls(
              afterOrphan,
              unprocessed,
              lastAssistant.messageId,
              afterOrphan.openTurn.turnId,
              ctx
            );
            return { append: [...append, ...expansion.append], effects: expansion.effects };
          }
        }
      }
      // 2+3. open turn + fresh input + guard → next model call
      if (
        afterOrphan.openTurn &&
        !afterOrphan.openTurn.interrupted &&
        wakeGuardSatisfied(afterOrphan) &&
        (hasFreshInput(afterOrphan) ||
          afterOrphan.openTurn.modelCallCount === 0 ||
          append.length > 0)
      ) {
        const next = nextModelCall(afterOrphan, append.length, ctx);
        return { append: [...append, ...next.append], effects: next.effects };
      }
      // 4. no open turn + pendingPrompt → C-prompt path (shared promotion).
      if (!afterOrphan.openTurn && afterOrphan.pendingPrompt) {
        return promotePendingPrompt(afterOrphan, ctx, append);
      }
      return { append, effects: [] };
    }

    case "resumeAfterReset": {
      const turn = state.openTurn;
      if (!turn || turn.interrupted || state.inFlightModelCall) return EMPTY;
      if (!command.messageId.startsWith(`m:${turn.turnId}:`)) return EMPTY;
      const resetAtMs = Date.parse(command.resetAt);
      const nowMs = Date.parse(ctx.now);
      if (Number.isFinite(resetAtMs) && Number.isFinite(nowMs) && resetAtMs > nowMs + 1000) {
        return EMPTY;
      }
      if (!wakeGuardSatisfied(state)) return EMPTY;
      const marker: AppendItem = {
        envelopeId: ids.systemEvent(command.messageId, "model-limit-resume-due", state.lastSeq),
        payloadKind: "system.event",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          kind: "model.limit_resume_due",
          messageId: command.messageId,
          resetAt: command.resetAt,
          details: {
            kind: "model.limit_resume_due",
            messageId: command.messageId,
            resetAt: command.resetAt,
          },
        },
        causality: { turnId: turn.turnId, messageId: command.messageId as never },
        publish: true,
      };
      const next = nextModelCall(state, 1, ctx);
      return { append: [marker, ...next.append], effects: next.effects };
    }
  }
}

function eventStep(state: AgentState, envelope: LogEnvelope, ctx: StepContext): StepOutput {
  const kind = envelope.payloadKind;
  const payload =
    envelope.payload && typeof envelope.payload === "object"
      ? (envelope.payload as Record<string, unknown>)
      : {};
  const causality = (envelope.causality ?? {}) as Record<string, unknown>;
  // NOTE: `state` here is post-fold (the driver folds the envelope first).

  // E-model-terminal
  if (kind === "message.completed" && payload["role"] === "assistant") {
    const turn = state.openTurn;
    if (!turn) return EMPTY;
    const outcome = String(payload["outcome"] ?? "completed");
    if (outcome === "interrupted" || turn.interrupted) {
      // Soft "flush steers": the model was aborted to deliver queued steers
      // sooner — CONTINUE the turn (re-run the model with the steers consumed)
      // instead of closing, unless this was a hard interrupt.
      if (
        turn.pendingFlush === "steers" &&
        !turn.interrupted &&
        state.steeringQueue.length > 0 &&
        wakeGuardSatisfied(state)
      ) {
        return nextModelCall(state, 0, ctx);
      }
      return { append: interruptCleanupItems(state, "user_interrupted"), effects: [] };
    }
    const blocks = Array.isArray(payload["blocks"]) ? (payload["blocks"] as unknown[]) : [];
    const toolCalls = blocks.filter(isToolCallBlock);
    if (toolCalls.length > 0) {
      return expandToolCalls(
        state,
        toolCalls,
        String(causality["messageId"] ?? ""),
        turn.turnId,
        ctx
      );
    }
    // no tool calls
    if (state.steeringQueue.length > 0) return nextModelCall(state, 0, ctx);
    return { append: [turnClosedItem(turn)], effects: [] };
  }

  // After-turn promotion: a closed turn drains exactly ONE deferred head into a
  // fresh turn of its own (shared with the flush path). Fires on EVERY close —
  // natural or flush-induced — keeping the one-turn-per-message cadence.
  if (kind === "turn.closed") {
    if (state.openTurn) return EMPTY;
    // Steers orphaned by a forced close (flush against a blocked turn) take
    // priority — matching the flush ordering (steers first, then deferred) —
    // and bootstrap a fresh turn of their own.
    if (state.steeringQueue.length > 0) return promoteSteersAsTurn(state, ctx);
    if (state.deferredPostTurnQueue.length === 0) return EMPTY;
    return promoteDeferredHead(state, ctx);
  }

  // recoverable model failure → fresh attempt (multi-attempt rule)
  if (kind === "message.failed") {
    const turn = state.openTurn;
    if (!turn || turn.interrupted) return EMPTY;
    const failedMessageId = String(causality["messageId"] ?? "");
    const fallback = shouldFailOverToFallback(state, turn, payload);
    if (fallback) {
      return fallbackModelCall(
        state,
        ctx,
        turn,
        failedMessageId,
        String(payload["code"] ?? "model_failure"),
        fallback
      );
    }
    if (turn.failedOverToFallback && isProviderLevelFailureCode(payload["code"])) {
      return { append: [turnClosedItem(turn, { reason: "work_failed" })], effects: [] };
    }
    if (typeof payload["resetAt"] === "string" && payload["resetAt"].trim()) {
      return {
        append: [
          turnWaitingItem(turn.turnId, turn.waitingCount, {
            reason: "model_usage_limit_reset",
            summary: "Waiting for model usage limit reset",
          }),
        ],
        effects: [],
      };
    }
    if (payload["recoverable"] !== true) {
      return { append: [turnClosedItem(turn, { reason: "work_failed" })], effects: [] };
    }
    if (!wakeGuardSatisfied(state)) return EMPTY; // guard: invocations first
    return nextModelCall(state, 0, ctx);
  }

  // E-invocation-terminal
  if (
    kind === "invocation.completed" ||
    kind === "invocation.failed" ||
    kind === "invocation.cancelled" ||
    kind === "invocation.abandoned"
  ) {
    const turn = state.openTurn;
    if (!turn || turn.interrupted) return EMPTY;
    if (state.inFlightModelCall) return EMPTY;
    if (Object.keys(state.pendingInvocations).length > 0) return EMPTY; // not last yet
    if (Object.keys(state.pendingApprovals).length > 0) return EMPTY;
    if (Object.keys(state.pendingCredentialWaits).length > 0) return EMPTY;
    if (turn.metadata?.completion === "after-invocation") {
      const succeeded = kind === "invocation.completed";
      return {
        append: [
          turnClosedItem(turn, {
            ...(succeeded ? {} : { reason: "work_failed" }),
            summary: directInvocationSummary(kind, payload),
          }),
        ],
        effects: [],
      };
    }
    if (kind === "invocation.completed") {
      const suspension = suspendTurnFromInvocationPayload(payload);
      if (suspension) {
        // A send-after-turn prompt may have arrived while the model was
        // deciding to suspend. Treat the oldest ready deferred prompt exactly
        // like input delivered to an already parked turn: promote it into the
        // current turn and continue the model. Closing here would make a
        // response waiter observe a response-less terminal turn before the
        // promoted input could be synthesized.
        const deferred = state.deferredPostTurnQueue[0];
        if (deferred?.artifactsReady && Object.keys(state.pendingPromptPreparations).length === 0) {
          const recv = promotedRecvItem(deferred, state.lastSeq);
          const afterRecv = projectAppend(state, [recv], ctx.now);
          const next = nextModelCall(afterRecv, 1, ctx, [deferred.sourceMessageId]);
          return {
            append: [recv, ...next.append],
            effects: next.effects,
          };
        }
        return {
          append: [
            turnWaitingItem(turn.turnId, turn.waitingCount, {
              reason: suspension.reason,
              summary: suspension.summary,
            }),
          ],
          effects: [],
        };
      }
      if (completedToolBatchTerminates(state, String(causality["invocationId"] ?? ""))) {
        return {
          append: [turnClosedItem(turn, { reason: "tool_terminated" })],
          effects: [],
        };
      }
    }
    // Origin and recoverability are independent. A typed recovery action can
    // make an infrastructure-origin failure actionable inside this turn
    // (repair source, reacquire a handle, reobserve, or retry). Only failures
    // with an explicit stop action terminate immediately. Legacy/malformed
    // failures without recovery metadata get another reasoning step instead
    // of silently turning missing metadata into a stop instruction.
    const currentInvocationId = String(causality["invocationId"] ?? "");
    const priorInfrastructureFailure = [...state.entries]
      .reverse()
      .find(
        (entry) =>
          entry.seq >= turn.openedAtSeq &&
          entry.kind === "tool-result" &&
          entry.terminalOutcome === "infrastructure_error" &&
          entry.failureRecovery?.action === "stop"
      );
    const currentInfrastructureFailure =
      kind === "invocation.failed" && payload["terminalOutcome"] === "infrastructure_error";
    const repeatedInfrastructureFailure =
      currentInfrastructureFailure &&
      consecutiveToolInfrastructureFailureCount(state, turn, currentInvocationId, payload) >=
        CONSECUTIVE_TOOL_INFRASTRUCTURE_FAILURE_LIMIT;
    const infrastructureFailure =
      currentInfrastructureFailure &&
      (infrastructureFailureTerminatesTurn(payload) || repeatedInfrastructureFailure)
        ? {
            invocationId: currentInvocationId,
            code:
              typeof payload["terminalReasonCode"] === "string"
                ? payload["terminalReasonCode"]
                : "infrastructure_error",
            reason: infrastructureFailureTerminatesTurn(payload)
              ? ("explicit-stop" as const)
              : ("circuit-open" as const),
          }
        : priorInfrastructureFailure?.kind === "tool-result"
          ? {
              invocationId: priorInfrastructureFailure.invocationId,
              code: priorInfrastructureFailure.terminalReasonCode ?? "infrastructure_error",
              reason: "explicit-stop" as const,
            }
          : null;
    if (infrastructureFailure) {
      return {
        append: [
          infrastructureFailureDiagnostic(
            turn,
            infrastructureFailure.invocationId,
            infrastructureFailure.code,
            infrastructureFailure.reason
          ),
          turnClosedItem(turn, { reason: "work_failed" }),
        ],
        effects: [],
      };
    }
    return nextModelCall(state, 0, ctx);
  }

  // E-approval-resolved
  if (kind === "approval.resolved") {
    const invocationId = String(causality["invocationId"] ?? "");
    const invocation = state.pendingInvocations[invocationId];
    if (payload["granted"] === true) {
      if (!invocation) return EMPTY;
      // the invocation.started already exists; only the dispatch effect is new
      return { append: [], effects: [invocationEffect(state, invocation)] };
    }
    // D-deny
    if (!invocation) return EMPTY;
    return {
      append: [
        {
          envelopeId: ids.invocationTerminal(invocationId),
          payloadKind: "invocation.failed",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            reason: "approval denied",
            terminalOutcome: "tool_error",
            terminalReasonCode: "approval_denied",
          },
          causality: { invocationId: invocationId as never, turnId: invocation.turnId },
          publish: true,
        },
      ],
      effects: [],
    };
  }

  // interrupt marker with no in-flight call → immediate cleanup
  if (kind === "system.event") {
    const details = (payload["details"] ?? {}) as Record<string, unknown>;
    if (details["kind"] === "prompt.artifacts_ready") {
      if (!state.openTurn) {
        if (state.pendingPrompt?.artifactsReady) return promotePendingPrompt(state, ctx, []);
        if (state.steeringQueue.length > 0) return promoteSteersAsTurn(state, ctx);
        return promoteDeferredHead(state, ctx);
      }
      const deferred = state.deferredPostTurnQueue[0];
      if (
        state.openTurn.waitingAtSeq !== undefined &&
        !state.openTurn.interrupted &&
        deferred?.artifactsReady &&
        Object.keys(state.pendingPromptPreparations).length === 0 &&
        Object.keys(state.pendingInvocations).length === 0 &&
        wakeGuardSatisfied(state)
      ) {
        const recv = promotedRecvItem(deferred, state.lastSeq);
        const afterRecv = projectAppend(state, [recv], ctx.now);
        const next = nextModelCall(afterRecv, 1, ctx, [deferred.sourceMessageId]);
        return { append: [recv, ...next.append], effects: next.effects };
      }
      if (
        !state.openTurn.interrupted &&
        state.steeringQueue.length > 0 &&
        wakeGuardSatisfied(state) &&
        Object.keys(state.pendingInvocations).length === 0
      ) {
        return nextModelCall(state, 0, ctx);
      }
      if (
        !state.openTurn.interrupted &&
        state.deferredPostTurnQueue.length === 0 &&
        state.steeringQueue.length === 0 &&
        Object.keys(state.pendingPromptPreparations).length === 0 &&
        Object.keys(state.pendingInvocations).length === 0 &&
        wakeGuardSatisfied(state)
      ) {
        return nextModelCall(state, 0, ctx);
      }
      return EMPTY;
    }
    if (details["kind"] === "prompt.artifacts_failed") {
      const triggerEnvelopeId = String(
        payload["triggerEnvelopeId"] ?? details["triggerEnvelopeId"] ?? "unknown"
      );
      const turnTriggerEnvelopeId = String(
        payload["turnTriggerEnvelopeId"] ?? details["turnTriggerEnvelopeId"] ?? triggerEnvelopeId
      );
      const reason = String(payload["reason"] ?? details["reason"] ?? "prompt setup failed");
      const metadata =
        payload["metadata"] && typeof payload["metadata"] === "object"
          ? (payload["metadata"] as AgentTurnMetadata)
          : undefined;
      const turnId =
        state.openTurn?.turnId ??
        ids.turnId(state.channelId, turnTriggerEnvelopeId, ctx.selfRef.id);
      const messageId = `diag:${turnId}:prompt-artifacts`;
      const diagnostic: AppendItem = {
        envelopeId: ids.messageTerminal(messageId),
        payloadKind: "message.completed",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          role: "assistant",
          blocks: [
            {
              type: "diagnostic",
              content: "Agent prompt setup failed. The input was not sent to a model.",
              metadata: {
                code: "prompt_artifact_load_failed",
                severity: "error",
                reason,
              },
            },
          ],
          outcome: "completed",
        },
        causality: { messageId: messageId as never, turnId },
        publish: true,
      };
      if (state.openTurn) return { append: [diagnostic], effects: [] };
      return {
        append: [
          turnOpenedItem(turnId, metadata, triggerEnvelopeId),
          diagnostic,
          turnClosedItem({ turnId, metadata }, { reason: "work_failed" }),
        ],
        effects: [],
      };
    }
    if (details["kind"] === "interrupt" && state.openTurn && !state.inFlightModelCall) {
      return {
        append: interruptCleanupItems(state, String(details["reason"] ?? "user_interrupted")),
        effects: [],
      };
    }
    if (
      (details["kind"] === "credential.wait_resolved" && details["resolved"] === true) ||
      details["kind"] === "credential.resolved"
    ) {
      // resume after credential connect: next model call if the turn is idle
      if (
        state.openTurn &&
        !state.openTurn.interrupted &&
        wakeGuardSatisfied(state) &&
        Object.keys(state.pendingInvocations).length === 0
      ) {
        return nextModelCall(state, 0, ctx);
      }
    }
  }

  return EMPTY;
}

function directInvocationSummary(kind: string, payload: Record<string, unknown>): string {
  const value =
    kind === "invocation.completed"
      ? payload["result"]
      : (payload["reason"] ?? payload["error"] ?? "Direct invocation failed");
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length <= 24_000 ? text : `${text.slice(0, 24_000)}\n…`;
}

function effectFailedStep(
  state: AgentState,
  incoming: Extract<Incoming, { type: "effect-failed" }>,
  _ctx: StepContext
): StepOutput {
  const turn = state.openTurn;
  if (incoming.kind === "prompt_artifacts") {
    const preparation = Object.values(state.pendingPromptPreparations).find(
      (candidate) => ids.promptArtifactsEffect(candidate.triggerEnvelopeId) === incoming.effectId
    );
    if (!preparation) return EMPTY;
    const promptMetadata =
      state.pendingPrompt?.envelopeId === preparation.triggerEnvelopeId
        ? state.pendingPrompt.metadata
        : (state.steeringQueue.find((entry) => entry.envelopeId === preparation.triggerEnvelopeId)
            ?.metadata ??
          state.deferredPostTurnQueue.find(
            (entry) => entry.envelopeId === preparation.triggerEnvelopeId
          )?.metadata);
    return {
      append: [
        {
          envelopeId: ids.promptArtifactsTerminal(preparation.triggerEnvelopeId),
          payloadKind: "system.event",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            kind: "prompt.artifacts_failed",
            triggerEnvelopeId: preparation.triggerEnvelopeId,
            turnTriggerEnvelopeId: preparation.turnTriggerEnvelopeId,
            reason: incoming.error.message,
            ...(promptMetadata ? { metadata: promptMetadata } : {}),
            details: {
              kind: "prompt.artifacts_failed",
              triggerEnvelopeId: preparation.triggerEnvelopeId,
              turnTriggerEnvelopeId: preparation.turnTriggerEnvelopeId,
              reason: incoming.error.message,
              ...(promptMetadata ? { metadata: promptMetadata } : {}),
            },
          },
          publish: false,
        },
      ],
      effects: [],
    };
  }

  if (incoming.kind === "model_call") {
    const failure = classifyModelFailure({
      provider: state.inFlightModelCall?.request.provider,
      model: state.inFlightModelCall?.request.model,
      rawReason: incoming.error.message,
      message: incoming.error.message,
      now: _ctx.now,
    });
    const messageId = state.inFlightModelCall?.messageId;
    const append: AppendItem[] = [];
    if (messageId) {
      append.push({
        envelopeId: ids.messageTerminal(messageId),
        payloadKind: "message.failed",
        payload: modelFailurePayload(failure, false),
        causality: { messageId: messageId as never },
        publish: true,
      });
    }
    if (turn && !failure.resetAt) {
      // published diagnostic (replaces agent_turn_outbox emit_diagnostic)
      append.push({
        envelopeId: `diag:${turn.turnId}:${incoming.effectId}`,
        payloadKind: "message.completed",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          role: "assistant",
          blocks: [
            {
              type: "diagnostic",
              content: `Turn failed: ${failure.reason}`,
              metadata: { code: "work_failed", severity: "error" },
            },
          ],
          outcome: "completed",
        },
        causality: {
          messageId: `diag:${turn.turnId}:${incoming.effectId}` as never,
          turnId: turn.turnId,
        },
        publish: true,
      });
      append.push(turnClosedItem(turn, { reason: "work_failed" }));
    }
    return { append, effects: [] };
  }

  if (incoming.kind === "credential_wait") {
    const wait = Object.values(state.pendingCredentialWaits).find(
      (candidate) => ids.credentialWaitEffect(candidate.credKey) === incoming.effectId
    );
    const append: AppendItem[] = [];
    if (wait) {
      append.push({
        envelopeId: ids.systemEvent(wait.credKey, "expired", wait.startedAtSeq),
        payloadKind: "system.event",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          kind: "credential.wait_expired",
          credKey: wait.credKey,
          details: {
            kind: "credential.wait_expired",
            credKey: wait.credKey,
            providerId: wait.providerId,
          },
        },
        causality: { turnId: wait.turnId },
        publish: true,
      });
    }
    if (turn) append.push(turnClosedItem(turn, { reason: "work_failed" }));
    return { append, effects: [] };
  }

  if (incoming.kind === "record_receipt") {
    return EMPTY;
  }

  // Exhaustiveness guard: after the model_call/credential_wait/record_receipt
  // branches above, the only remaining effect kinds are the invocation-style
  // ones, dispatched by effect-id prefix below (form: approval / inv:
  // tool-or-channel-or-http). If a new EffectKind is ever added to effects.ts
  // without a branch here, this assignment fails to compile — preventing the
  // AL-7 class of silently-unmapped effect that returns EMPTY and wedges the
  // driver in a re-dispatch loop.
  const _invocationKind: "local_tool" | "channel_call" | "http_call" = incoming.kind;
  void _invocationKind;

  if (incoming.effectId.startsWith("form:")) {
    const approvalId = incoming.effectId.slice(5);
    const approval = state.pendingApprovals[approvalId];
    if (!approval) return EMPTY;
    return {
      append: [
        {
          envelopeId: ids.approvalResolved(approvalId),
          payloadKind: "approval.resolved",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            granted: false,
            resolvedBy: { kind: "system", id: "delivery-failed" },
            reason: incoming.error.message || "delivery-failed",
          },
          causality: {
            approvalId: approvalId as never,
            invocationId: approval.invocationId as never,
            turnId: approval.turnId,
          },
          publish: true,
        },
      ],
      effects: [],
    };
  }

  if (!incoming.effectId.startsWith("inv:")) {
    const append: AppendItem[] = [];
    if (turn) {
      const messageId = `diag:${turn.turnId}:unknown-effect:${incoming.effectId}`;
      append.push({
        envelopeId: messageId,
        payloadKind: "message.completed",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          role: "assistant",
          blocks: [
            {
              type: "diagnostic",
              content: `Turn failed: unmapped effect failure ${incoming.effectId}`,
              metadata: { code: "unmapped_effect_failure", severity: "error" },
            },
          ],
          outcome: "completed",
        },
        causality: { messageId: messageId as never, turnId: turn.turnId },
        publish: true,
      });
      append.push(turnClosedItem(turn, { reason: "work_failed" }));
    }
    return { append, effects: [] };
  }

  // local_tool / channel_call / http_call
  const invocationId = incoming.effectId.slice(4);
  if (!state.pendingInvocations[invocationId]) return EMPTY;
  return {
    append: [
      {
        envelopeId: ids.invocationTerminal(invocationId),
        payloadKind: "invocation.failed",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          reason: incoming.error.message,
          terminalOutcome: "infrastructure_error",
          terminalReasonCode: "dispatch_failed",
        },
        causality: {
          invocationId: invocationId as never,
          turnId: state.pendingInvocations[invocationId]!.turnId,
        },
        publish: true,
      },
    ],
    effects: [],
  };
}

interface ToolCallBlock {
  type: string;
  id: string;
  name: string;
  arguments: unknown;
}

function isToolCallBlock(block: unknown): block is ToolCallBlock {
  if (!block || typeof block !== "object") return false;
  const record = block as Record<string, unknown>;
  return (
    (record["type"] === "toolCall" || record["type"] === "tool_call") &&
    typeof record["id"] === "string" &&
    typeof record["name"] === "string"
  );
}

import { patchHash } from "./ids.js";
function patchHashOf(patch: unknown): string {
  return patchHash(patch);
}

// ---------------------------------------------------------------------------
// Policy composition (§1.6)
// ---------------------------------------------------------------------------

export interface StepPolicy {
  name: string;
  intercept(args: {
    state: AgentState;
    incoming: Incoming;
    ctx: StepContext;
    output: StepOutput;
  }): StepOutput;
  /** Optional pass over driver-side appends that bypass step (effect outcome
   *  events) — e.g. the silent policy's publication filter. */
  transformAppend?(args: { state: AgentState; items: AppendItem[] }): AppendItem[];
  /** Optional pass over executor-side signal events that bypass the durable log. */
  filterEphemeral?(args: {
    state: AgentState;
    emit: EphemeralSignal;
  }): EphemeralSignal | null | undefined;
}

export function composeStep(policies: StepPolicy[]): StepFn {
  return (state, incoming, ctx) => {
    let output = coreStep(state, incoming, ctx);
    for (const policy of policies) {
      output = policy.intercept({ state, incoming, ctx, output });
    }
    return output;
  };
}

export { derivePendingEffects, modelCallEffect };
