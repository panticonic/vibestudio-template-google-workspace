/**
 * Shared wire-event → ChatMessage merge logic.
 *
 * Consumed by both `useChannelMessages` (React) and `HeadlessSession`. Before
 * this module, each consumer re-implemented the same merge with the same
 * latent bugs (append-vs-replace, invocation card parsing, etc). Centralizing
 * here keeps the two paths in lockstep.
 *
 * Wire-level shapes are minimally typed — consumers may pass their richer raw
 * event objects; extra fields are ignored.
 */

import type {
  ActionBarPayload,
  ApprovalCardPayload,
  AutomationActivitySnapshot,
  ChatMessage,
  CustomMessageCardPayload,
  DiagnosticNotice,
  InlineUiCardPayload,
  LifecycleNotice,
  MessageTypeDefinition,
  SandboxSource,
} from "./derived-types.js";
import type {
  ChannelViewState,
  ForkProjection,
  ProjectedExternalPublication,
  MessageTier,
  ProjectedApproval,
  ProjectedCustomMessage,
  ProjectedInvocation,
  ProjectedMessage,
  ProjectedTask,
  ProjectedSystemNotice,
  ProjectedTurn,
} from "@workspace/agentic-protocol";
import {
  assertNoStoredValueRefs,
  isLifecycleMessageReasonCode,
  isStoredValueRef,
  isTurnReasonCode,
  messageDisplayText,
  readDiagnosticMetadata,
  summarizeMessageBlocks,
} from "@workspace/agentic-protocol";
import type { InvocationCardPayload } from "./invocation-card-payload.js";
import type { SubagentRunState, TaskCardPayload } from "./task-card-payload.js";

// The shared projection is part of the public boundary consumed by the
// platform-neutral Quickfire projection. Re-exporting the wire-shaped result
// type keeps that consumer on the same canonical merge contract instead of
// making it reach into this package's private derived-types module.
export type { ChatMessage } from "./derived-types.js";
import { extractResultImages } from "./result-images.js";

type StoredValueRefPreview = { preview?: string };

export function chatMessagesFromChannelView(state: ChannelViewState): ChatMessage[] {
  assertNoStoredValueRefs(state, "chat message projection input");
  const messages = Object.values(state.messages).flatMap((message) =>
    projectedMessageToChatMessages(
      message,
      state.intendedRecipientsByMessage?.[message.messageId] ?? []
    )
  );
  const invocations = Object.values(state.invocations).map(projectedInvocationToChatMessage);
  const tasks = Object.values(state.tasks).map(projectedTaskToChatMessage);
  const approvals = Object.values(state.approvals).map(projectedApprovalToChatMessage);
  const terminalAssistantMessageTurnIds = new Set(
    Object.values(state.messages)
      .filter(
        (message) =>
          message.turnId &&
          (message.role === "assistant" || message.actor.kind === "agent") &&
          (message.status === "completed" ||
            (message.status === "failed" && !isSuppressedAssistantFailure(message)))
      )
      .map((message) => message.turnId as string)
  );
  const turnIdsWithInlineUi = new Set(
    Object.values(state.inlineUi)
      .flatMap((map) => Object.values(map))
      .filter((item) => item.turnId)
      .map((item) => item.turnId as string)
  );
  const turnIdsWithInvocations = new Set(
    Object.values(state.invocations)
      .filter((invocation) => invocation.turnId)
      .map((invocation) => invocation.turnId as string)
  );
  // The open-turn typing pill stays visible for the WHOLE open turn — including while an assistant
  // message streams — so the "agent is working" signal is stable instead of flickering off every time
  // the agent emits a message bubble. It sorts to the bottom (by turn.updatedAt), beneath the stream.
  const turns = Object.values(state.turns).flatMap(projectedTurnToTypingMessage);
  const waitingTurns = Object.values(state.turns).flatMap(projectedWaitingTurnMessage);
  const automationTurns = Object.values(state.turns).flatMap(projectedAutomationTurnMessage);
  const automationInstitutions = Object.values(state.automationInstitutions ?? {}).map(
    projectedAutomationInstitutionToChatMessage
  );
  const silentClosedTurns = Object.values(state.turns).flatMap((turn) =>
    projectedClosedTurnWithoutResponseMessage(turn, {
      hasAssistantMessage:
        terminalAssistantMessageTurnIds.has(turn.turnId) || turnIdsWithInlineUi.has(turn.turnId),
      hasInvocation: turnIdsWithInvocations.has(turn.turnId),
    })
  );
  const inlineUi = Object.entries(state.inlineUi).flatMap(([participantId, map]) =>
    Object.values(map).flatMap((item) =>
      isStoredValueRef(item.source)
        ? []
        : [
            projectedInlineUiToChatMessage(
              participantId,
              item as Parameters<typeof projectedInlineUiToChatMessage>[1]
            ),
          ]
    )
  );
  const custom = Object.values(state.customMessages).flatMap((item) =>
    projectedCustomMessageToChatMessage(item, state.messageTypes[item.typeId ?? ""])
  );
  const systemNotices = Object.values(state.systemNotices ?? {}).map(
    projectedSystemNoticeToChatMessage
  );
  // Inline fork-annotation rows, positioned just after the message at their
  // fork point. `createdAtSeq` is when the annotation was announced on the
  // parent log; `forkPointId` is the transcript anchor.
  const seqTimes = Object.values(state.messages)
    .filter((message) => message.seq !== undefined)
    .map((message) => ({
      seq: message.seq as number,
      time: Date.parse(message.updatedAt ?? message.completedAt ?? message.startedAt ?? "") || 0,
    }))
    .sort((a, b) => a.seq - b.seq);
  const forkAnchorTime = (forkPointId: number): number => {
    let time = 0;
    for (const entry of seqTimes) {
      if (entry.seq > forkPointId) break;
      time = entry.time;
    }
    return time;
  };
  const forks = (state.forks ?? []).map((fork) =>
    projectedForkToChatMessage(fork, forkAnchorTime(fork.forkPointId))
  );
  const crossChannel = Object.values(state.externalPublications ?? {}).map((publication) =>
    projectedPublicationToChatMessage(publication)
  );
  const credentialRequests = Object.values(state.credentialRequests ?? {}).map(
    (request): ChatMessage & { sortTime: number } => ({
      id: `credential:${request.credKey}`,
      senderId: request.participantId,
      content: `Model credential required (${request.providerId})`,
      contentType: "credential-connect",
      kind: "system",
      complete: false,
      credentialRequest: {
        credKey: request.credKey,
        providerId: request.providerId,
        connectSpec: request.connectSpec,
        modelBaseUrl: request.modelBaseUrl,
        reason: request.reason,
        failureCode: request.failureCode,
        expiresAt: request.expiresAt,
        agentParticipantId: request.participantId,
      },
      sortTime: Date.parse(request.publishedAt ?? "") || 0,
    })
  );
  return [
    ...messages,
    ...invocations,
    ...tasks,
    ...approvals,
    ...turns,
    ...waitingTurns,
    ...automationTurns,
    ...automationInstitutions,
    ...silentClosedTurns,
    ...inlineUi,
    ...custom,
    ...systemNotices,
    ...forks,
    ...crossChannel,
    ...credentialRequests,
  ]
    .sort(
      (a, b) =>
        Number((a as ChatMessage & { sortTime?: number }).sortTime ?? 0) -
          Number((b as ChatMessage & { sortTime?: number }).sortTime ?? 0) ||
        a.id.localeCompare(b.id)
    )
    .map((message) => {
      const { sortTime: _sortTime, ...rest } = message as ChatMessage & { sortTime?: number };
      return rest;
    });
}

function projectedAutomationInstitutionToChatMessage(
  institution: import("@workspace/agentic-protocol").ProjectedAutomationInstitution
): ChatMessage & { sortTime: number } {
  return {
    id: `automation:instituted:${institution.definition.missionId}`,
    senderId: institution.actor.id,
    content: institution.definition.name,
    contentType: "automation",
    kind: "system",
    complete: true,
    automationDefinition: {
      snapshot: institution.definition,
      institutedAt: institution.createdAt,
    },
    senderMetadata: {
      name: institution.actor.displayName ?? institution.actor.id,
      type: institution.actor.kind,
      handle: institution.actor.id,
    },
    seq: institution.seq,
    sortTime: Date.parse(institution.createdAt) || 0,
  };
}

function projectedSystemNoticeToChatMessage(
  notice: ProjectedSystemNotice
): ChatMessage & { sortTime: number } {
  const title =
    notice.kind === "model.local_fallback_continued"
      ? "Continued on local fallback"
      : notice.kind === "model.fallback_continued"
        ? "Continued on fallback model"
        : notice.summary;
  return {
    id: `system:${notice.noticeId}`,
    senderId: notice.actor.id,
    content: notice.detail ?? notice.summary,
    contentType: "diagnostic",
    kind: "system",
    complete: true,
    diagnostic: {
      code: notice.kind,
      severity: "info",
      title,
      detail: notice.detail ?? notice.summary,
    },
    senderMetadata: {
      name: notice.actor.displayName ?? notice.actor.id,
      type: notice.actor.kind,
      handle: notice.actor.id,
    },
    sortTime: Date.parse(notice.createdAt) || 0,
  };
}

export function messageTypeDefinitionsFromChannelView(
  state: ChannelViewState
): MessageTypeDefinition[] {
  return Object.values(state.messageTypes).flatMap((item) => {
    const isCleared = item.updatedAtSeq <= (item.clearedAtSeq ?? -1);
    if (!isCleared && (!item.source || !item.displayMode)) return [];
    if (!isCleared && isStoredValueRef(item.source)) return [];
    const source = item.source as SandboxSource;
    const definition: MessageTypeDefinition = isCleared
      ? {
          typeId: item.typeId,
          updatedAtSeq: item.updatedAtSeq,
          clearedAtSeq: item.clearedAtSeq ?? -1,
          cleared: true,
        }
      : {
          typeId: item.typeId,
          displayMode: item.displayMode!,
          source,
          updatedAtSeq: item.updatedAtSeq,
          cleared: false,
        };
    if (item.displayMode !== undefined && definition.cleared)
      definition.displayMode = item.displayMode;
    if (item.source !== undefined && definition.cleared && !isStoredValueRef(item.source))
      definition.source = item.source;
    if (item.imports !== undefined) definition.imports = item.imports;
    if (item.stateSchema !== undefined) definition.stateSchema = item.stateSchema;
    if (item.updateSchema !== undefined) definition.updateSchema = item.updateSchema;
    if (item.registeredBy !== undefined) definition.registeredBy = item.registeredBy;
    if (item.clearedAtSeq !== undefined) definition.clearedAtSeq = item.clearedAtSeq;
    return [definition];
  });
}

export function actionBarPayloadFromChannelView(state: ChannelViewState): ActionBarPayload | null {
  const latest = Object.values(state.actionBars)
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  const latestItem = latest[latest.length - 1];
  if (
    !latestItem ||
    latestItem.cleared ||
    !latestItem.source ||
    isStoredValueRef(latestItem.source)
  )
    return null;
  const payload: ActionBarPayload = {
    source: latestItem.source,
  };
  if (latestItem.id !== undefined) payload.id = latestItem.id;
  if (latestItem.imports !== undefined) payload.imports = latestItem.imports;
  if (latestItem.props !== undefined) payload.props = latestItem.props;
  if (latestItem.maxHeight !== undefined) payload.maxHeight = latestItem.maxHeight;
  if (latestItem.result !== undefined) payload.result = latestItem.result;
  return payload;
}

function projectedTurnToTypingMessage(turn: ProjectedTurn): ChatMessage[] {
  if (turn.status !== "open") return [];
  return [
    {
      id: `turn:${turn.turnId}`,
      senderId: turn.actor.id,
      content: "",
      contentType: "typing",
      kind: "message",
      complete: false,
      senderMetadata: {
        name: turn.actor.displayName ?? turn.actor.id,
        type: turn.actor.kind,
        handle: turn.actor.id,
      },
      sortTime: Date.parse(turn.updatedAt ?? turn.openedAt) || 0,
    } as ChatMessage & { sortTime: number },
  ];
}

function projectedAutomationTurnMessage(turn: ProjectedTurn): ChatMessage[] {
  const automation = automationSnapshot(turn.metadata?.["automation"]);
  if (!automation) return [];
  const failed =
    turn.status === "closed" && Boolean(turn.reason && turn.reason !== "tool_terminated");
  return [
    {
      id: `automation:${automation.runId}`,
      senderId: turn.actor.id,
      content: automation.name,
      contentType: "automation",
      kind: "system",
      complete: turn.status === "closed",
      automation: {
        snapshot: automation,
        status: turn.status === "closed" ? (failed ? "failed" : "succeeded") : "running",
        openedAt: turn.openedAt,
        ...(turn.closedAt ? { closedAt: turn.closedAt } : {}),
        ...(turn.summary ? { summary: turn.summary } : {}),
        ...(turn.reason ? { reason: turn.reason } : {}),
      },
      senderMetadata: {
        name: turn.actor.displayName ?? turn.actor.id,
        type: turn.actor.kind,
        handle: turn.actor.id,
      },
      sortTime: Date.parse(turn.openedAt) || 0,
    } as ChatMessage & { sortTime: number },
  ];
}

function automationSnapshot(value: unknown): AutomationActivitySnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<AutomationActivitySnapshot>;
  if (
    typeof candidate.missionId !== "string" ||
    typeof candidate.runId !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.revision !== "number" ||
    (candidate.action !== "prompt" &&
      candidate.action !== "eval" &&
      candidate.action !== "method") ||
    (candidate.trigger !== "manual" && candidate.trigger !== "scheduled") ||
    typeof candidate.startedAt !== "number" ||
    typeof candidate.createdAt !== "number"
  ) {
    return null;
  }
  if (candidate.schedule !== null) {
    if (typeof candidate.schedule !== "object") return null;
    const schedule = candidate.schedule as Record<string, unknown>;
    if (schedule["kind"] === "cron") {
      if (typeof schedule["expression"] !== "string" || typeof schedule["timezone"] !== "string") {
        return null;
      }
    } else if (schedule["kind"] !== undefined && schedule["kind"] !== "interval") {
      return null;
    } else if (typeof schedule["everyMs"] !== "number") {
      return null;
    }
    if (schedule["untilAt"] !== undefined && typeof schedule["untilAt"] !== "number") return null;
    if (schedule["maxRuns"] !== undefined && typeof schedule["maxRuns"] !== "number") return null;
  }
  if (candidate.runNumber !== undefined && typeof candidate.runNumber !== "number") return null;
  return candidate as AutomationActivitySnapshot;
}

/**
 * A turn parked on an out-of-band condition projects to a first-class waiting
 * lifecycle notice. The reason distinguishes work continuing elsewhere from a
 * genuine request for user action; presentation must not guess that distinction
 * from the mere fact that the turn is parked.
 */
function projectedWaitingTurnMessage(turn: ProjectedTurn): ChatMessage[] {
  if (turn.status !== "waiting") return [];
  if (turn.actor.kind !== "agent") return [];
  const title = turn.summary ?? "Waiting";
  const lifecycle: LifecycleNotice = {
    status: "waiting",
    title,
    ...(turn.reason ? { reason: lifecycleReasonValue(turn.reason) } : {}),
  };
  return [
    {
      id: `turn:${turn.turnId}:waiting`,
      senderId: turn.actor.id,
      content: title,
      contentType: "lifecycle",
      kind: "system",
      turnId: turn.turnId,
      complete: false,
      lifecycle,
      senderMetadata: {
        name: turn.actor.displayName ?? turn.actor.id,
        type: turn.actor.kind,
        handle: turn.actor.id,
      },
      sortTime: Date.parse(turn.updatedAt ?? turn.openedAt) || 0,
    } as ChatMessage & { sortTime: number },
  ];
}

function projectedClosedTurnWithoutResponseMessage(
  turn: ProjectedTurn,
  opts: { hasAssistantMessage: boolean; hasInvocation: boolean }
): ChatMessage[] {
  if (turn.status !== "closed") return [];
  if (turn.actor.kind !== "agent") return [];
  if (opts.hasAssistantMessage) return [];
  if (isExpectedNoAssistantClose(turn)) return [];
  if (!opts.hasInvocation && !turn.summary) return [];
  if (isRunnerRestartClose(turn)) {
    const lifecycle: LifecycleNotice = {
      status: "recovered",
      title: "Recovered after restart",
      detail: "The turn closed cleanly, but there was no assistant response to show.",
      reason: lifecycleReasonValue(turn.reason),
    };
    return [
      {
        id: `turn:${turn.turnId}:recovered`,
        senderId: turn.actor.id,
        content: lifecycle.detail ?? lifecycle.title,
        contentType: "lifecycle",
        kind: "system",
        complete: true,
        lifecycle,
        senderMetadata: {
          name: turn.actor.displayName ?? turn.actor.id,
          type: turn.actor.kind,
          handle: turn.actor.id,
        },
        sortTime: Date.parse(turn.closedAt ?? turn.updatedAt ?? turn.openedAt) || 0,
      } as ChatMessage & { sortTime: number },
    ];
  }
  const detail = turn.summary ? ` ${turn.summary}` : "";
  return [
    {
      id: `turn:${turn.turnId}:no-response`,
      senderId: turn.actor.id,
      content: `Agent turn closed without an assistant response.${detail}`,
      kind: "message",
      complete: true,
      error: "Agent turn closed without an assistant response",
      senderMetadata: {
        name: turn.actor.displayName ?? turn.actor.id,
        type: turn.actor.kind,
        handle: turn.actor.id,
      },
      sortTime: Date.parse(turn.closedAt ?? turn.updatedAt ?? turn.openedAt) || 0,
    } as ChatMessage & { sortTime: number },
  ];
}

function isRunnerRestartClose(turn: ProjectedTurn): boolean {
  return turn.reason === "runner_restarted";
}

function isExpectedNoAssistantClose(turn: ProjectedTurn): boolean {
  return (
    turn.reason === "forked" ||
    turn.reason === "user_interrupted" ||
    turn.reason === "channel_unsubscribe" ||
    turn.reason === "turn_superseded" ||
    turn.reason === "model_credential_required" ||
    turn.reason === "model_credential_reconnect_required"
  );
}

/** Senders stamp salience explicitly. Missing values use the protocol default;
 * content shape is never reinterpreted as an older tiering convention. */
function messageTier(message: ProjectedMessage): MessageTier {
  return message.tier ?? "primary";
}

/**
 * Per-recipient delivery state from the intended-recipient snapshot plus the
 * received/read ack maps. Tracked set = snapshot ∪ actual ackers, so an ack
 * always shows even when the roster was empty at send time, while the snapshot
 * keeps unacked recipients visible (aggregate stays `partial`/`pending` instead
 * of prematurely `read`).
 */
function computeReceipts(
  message: ProjectedMessage,
  intendedRecipients: string[]
): ChatMessage["receipts"] | undefined {
  const receivedBy = message.receivedBy ?? {};
  const readBy = message.readBy ?? {};
  const tracked = new Set<string>([
    ...intendedRecipients,
    ...Object.keys(receivedBy),
    ...Object.keys(readBy),
  ]);
  if (tracked.size === 0) return undefined;
  const byParticipant: Record<string, "pending" | "received" | "read"> = {};
  for (const key of tracked) {
    byParticipant[key] = readBy[key] ? "read" : receivedBy[key] ? "received" : "pending";
  }
  const states = Object.values(byParticipant);
  const readCount = states.filter((state) => state === "read").length;
  const aggregate = readCount === 0 ? "pending" : readCount === states.length ? "read" : "partial";
  return { byParticipant, aggregate };
}

function deliveryFields(
  message: ProjectedMessage,
  intendedRecipients: string[]
): Partial<ChatMessage> {
  const receipts = computeReceipts(message, intendedRecipients);
  return {
    ...(receipts ? { receipts } : {}),
    ...(message.retracted ? { retracted: true } : {}),
    ...(message.revision !== undefined ? { revision: message.revision } : {}),
    ...(message.editedAt !== undefined ? { editedAt: message.editedAt } : {}),
  };
}

/** Project one direct-child fork into an inline "conversation forked" system
 *  row. `anchorTime` interleaves it with the transcript at its fork point. */
/**
 * Outgoing cross-channel dispatch row (messaging plan §4.10.3).
 *
 * Agent-side, lifecycle-weight marginalia: it is the agent's own speech, but it
 * is *aside* from this conversation — the utterance itself lives in the target
 * channel. Consecutive dispatches to the same channel are grouped by the UI,
 * so a chatty agent cannot bury a human's conversation.
 */
function projectedPublicationToChatMessage(
  publication: ProjectedExternalPublication
): ChatMessage & { sortTime: number } {
  const handle = (publication.from.metadata as { handle?: unknown } | undefined)?.handle;
  return {
    id: `cross-channel:${publication.key}`,
    senderId: publication.from.id,
    content: publication.summary ?? "sent a message to another conversation",
    contentType: "cross-channel-sent",
    kind: "message",
    complete: true,
    crossChannel: {
      channelId: publication.channelId,
      envelopeId: publication.envelopeId,
      ...(publication.summary ? { summary: publication.summary } : {}),
      from: {
        kind: publication.from.kind,
        id: publication.from.id,
        ...(publication.from.displayName ? { displayName: publication.from.displayName } : {}),
        ...(typeof handle === "string" ? { handle } : {}),
      },
      publishedAt: publication.publishedAt,
    },
    senderMetadata: {
      name: publication.from.displayName ?? publication.from.id,
      type: publication.from.kind,
      ...(typeof handle === "string" ? { handle } : {}),
    },
    sortTime: Date.parse(publication.publishedAt) || 0,
  } as ChatMessage & { sortTime: number };
}

function projectedForkToChatMessage(
  fork: ForkProjection,
  anchorTime: number
): ChatMessage & { sortTime: number } {
  return {
    id: `fork:${fork.forkId}`,
    senderId: fork.actor.id,
    content: fork.label || fork.reason || "forked this conversation",
    contentType: "fork",
    kind: "system",
    complete: true,
    fork: {
      forkId: fork.forkId,
      forkedChannelId: fork.forkedChannelId,
      forkedContextId: fork.forkedContextId,
      forkPointId: fork.forkPointId,
      label: fork.label,
      reason: fork.reason,
      actor: {
        kind: fork.actor.kind,
        id: fork.actor.id,
        ...(fork.actor.displayName ? { displayName: fork.actor.displayName } : {}),
      },
      createdAtSeq: fork.createdAtSeq,
      headSeq: fork.headSeq,
      archived: fork.archived,
    },
    senderMetadata: {
      name: fork.actor.displayName ?? fork.actor.id,
      type: fork.actor.kind,
      handle: fork.actor.id,
    },
    // A tiny epsilon on the anchor keeps the row just below its fork-point message.
    sortTime: anchorTime + 0.25,
  } as ChatMessage & { sortTime: number };
}

function projectedMessageToChatMessages(
  message: ProjectedMessage,
  intendedRecipients: string[] = []
): ChatMessage[] {
  // Receipt-only updates may advance updatedAt long after replies exist. Keep
  // transcript order anchored to the message lifecycle, not acknowledgments.
  const sortTime = Date.parse(message.completedAt ?? message.startedAt ?? "") || 0;
  const lifecycle = lifecycleNoticeFromMessage(message);
  const actorMetadata = message.actor.metadata as
    | {
        handle?: unknown;
        origin?: { channelId?: unknown; participantId?: unknown; envelopeId?: unknown };
      }
    | undefined;
  const senderMetadata = {
    name: message.actor.displayName ?? message.actor.id,
    type: message.actor.kind,
    handle:
      typeof actorMetadata?.handle === "string" ? actorMetadata.handle : message.actor.id,
  };
  // A guest envelope (messaging plan §4.10.4) is an ORDINARY message here — it
  // is someone talking — and differs only by the origin its metadata earns it.
  const origin =
    typeof actorMetadata?.origin?.channelId === "string" &&
    typeof actorMetadata.origin.participantId === "string"
      ? {
          channelId: actorMetadata.origin.channelId,
          participantId: actorMetadata.origin.participantId,
          ...(typeof actorMetadata.origin.envelopeId === "string"
            ? { envelopeId: actorMetadata.origin.envelopeId }
            : {}),
        }
      : undefined;
  const complete = message.status === "completed" || message.status === "failed";
  const thinking = (message.blocks ?? []).flatMap((block, index) => {
    if (block.type !== "thinking") return [];
    // Reasoning summaries stream as live deltas, so a contentless thinking
    // block is pure noise (e.g. a reasoning phase whose summary never
    // arrived) — drop it rather than rendering an empty pill.
    const content = typeof block.content === "string" ? block.content : "";
    if (!content) return [];
    return [
      {
        id: `thinking:${message.messageId}:${block.blockId ?? index}`,
        senderId: message.actor.id,
        content,
        contentType: "thinking",
        kind: "message",
        complete,
        senderMetadata,
        sortTime: sortTime - 0.5 + index / 1000,
      } as ChatMessage & { sortTime: number },
    ];
  });
  // Ephemeral tool-call generation status (arguments still streaming from the
  // model). Only meaningful while the message is live — the authoritative
  // terminal blocks never carry these, so a completed message has none anyway.
  const toolCallProgress = complete
    ? []
    : (message.blocks ?? []).flatMap((block, index) => {
        if (block.type !== "toolcall-progress") return [];
        const content = typeof block.content === "string" ? block.content : "";
        if (!content) return [];
        return [
          {
            id: `toolcall-progress:${message.messageId}:${block.blockId ?? index}`,
            senderId: message.actor.id,
            content,
            contentType: "toolcall-progress",
            kind: "message",
            complete: false,
            senderMetadata,
            sortTime: sortTime - 0.4 + index / 1000,
          } as ChatMessage & { sortTime: number },
        ];
      });
  const preamble = [...thinking, ...toolCallProgress];
  const failureReason = message.status === "failed" ? message.failureReason : undefined;
  if (isSuppressedAssistantFailure(message)) return preamble;
  const content = messageDisplayText(message.blocks);
  const diagnostic = diagnosticNoticeFromMessage(message);
  if (diagnostic) {
    return [
      ...preamble,
      {
        id: `diagnostic:${message.messageId}`,
        senderId: message.actor.id,
        content: diagnostic.detail ?? diagnostic.title,
        contentType: "diagnostic",
        kind: "system",
        complete: true,
        diagnostic,
        error:
          diagnostic.severity === "error" ? (diagnostic.detail ?? diagnostic.title) : undefined,
        senderMetadata,
        sortTime,
      } as ChatMessage & { sortTime: number },
    ];
  }
  if (!messageShouldRenderStandalone(message)) return preamble;
  if (lifecycle) {
    return [
      ...preamble,
      {
        id: message.messageId,
        senderId: message.actor.id,
        content,
        contentType: "lifecycle",
        kind: "system",
        complete: true,
        lifecycle,
        senderMetadata,
        sortTime,
      } as ChatMessage & { sortTime: number },
    ];
  }
  return [
    ...preamble,
    {
      id: message.messageId,
      senderId: message.actor.id,
      content,
      kind: "message",
      complete,
      ...(message.turnId ? { turnId: message.turnId } : {}),
      replyTo: message.replyTo,
      mentions: message.mentions,
      tier: messageTier(message),
      ...(message.role === "assistant" && message.model ? { model: message.model } : {}),
      ...(message.seq !== undefined ? { seq: message.seq } : {}),
      ...(message.saliency ? { saliency: message.saliency } : {}),
      ...(message.replaces ? { replaces: message.replaces } : {}),
      ...(message.notify
        ? {
            escalation: {
              alert: message.notify.alert,
              ...(message.notify.title ? { title: message.notify.title } : {}),
              users: (message.to ?? [])
                .filter(
                  (selector) =>
                    selector.kind === "participant" &&
                    typeof selector.participantId === "string" &&
                    selector.participantId.startsWith("user:")
                )
                .map((selector) => selector.participantId as string),
            },
          }
        : {}),
      error:
        message.status === "failed"
          ? (failureReason ?? "Message failed")
          : message.outcome === "interrupted"
            ? "Interrupted"
            : undefined,
      ...deliveryFields(message, intendedRecipients),
      ...(origin ? { origin } : {}),
      senderMetadata,
      sortTime,
    } as ChatMessage & { sortTime: number },
  ];
}

// A standalone row renders the message's display text (and inline attachments).
// Thinking, invocations, and diagnostics each own their render path, so row
// existence is purely content-driven; `outcome` only decorates the row (e.g. the
// "Interrupted" marker / failure error). Empty and failed-without-content messages
// are handled earlier by `diagnosticNoticeFromMessage`.
function messageShouldRenderStandalone(message: ProjectedMessage): boolean {
  const summary = summarizeMessageBlocks(message.blocks);
  return summary.hasText || summary.hasAttachmentOrData;
}

function isCredentialSuspensionReason(reason: string | undefined): boolean {
  return reason === "model_credential_required" || reason === "model_credential_reconnect_required";
}

function isRecoverableRestartCleanup(message: ProjectedMessage): boolean {
  return (
    message.status === "failed" &&
    message.failureRecoverable === true &&
    message.failureReason === "interrupted by restart" &&
    (message.role === "assistant" || message.actor.kind === "agent")
  );
}

function isSuppressedAssistantFailure(message: ProjectedMessage): boolean {
  const failureReason = message.status === "failed" ? message.failureReason : undefined;
  return isCredentialSuspensionReason(failureReason) || isRecoverableRestartCleanup(message);
}

function diagnosticNoticeFromMessage(message: ProjectedMessage): DiagnosticNotice | null {
  const blocks = message.blocks ?? [];
  const diagnosticBlocks = blocks.filter((block) => block.type === "diagnostic");
  if (diagnosticBlocks.length === 0) return null;
  const summary = summarizeMessageBlocks(blocks.filter((block) => block.type !== "diagnostic"));
  if (!summary.isEmpty) return null;
  const block =
    diagnosticBlocks.find((item) => readDiagnosticMetadata(item.metadata).severity === "error") ??
    diagnosticBlocks[0]!;
  const metadata = readDiagnosticMetadata(block.metadata);
  const content = block.content?.trim() || "Assistant message had no visible content.";
  return {
    messageId: message.messageId as string,
    code: metadata.code,
    failureCode: metadata.failureCode,
    severity: metadata.severity,
    title:
      metadata.code === "model_retry_limit_exceeded"
        ? "Model retry limit reached"
        : metadata.failureCode === "usage_limit_terminal"
          ? "Model usage limit reached"
          : metadata.failureCode === "context_overflow_terminal"
            ? "Context window exceeded"
            : metadata.failureCode === "request_invalid_terminal"
              ? "Invalid model request"
              : metadata.failureCode === "infrastructure_terminal"
                ? "Vibestudio service failed"
                : metadata.severity === "error"
                  ? "Message failed"
                  : "No assistant response",
    detail: content,
    reason: metadata.reason,
    recoverable: metadata.recoverable,
    resetAt: metadata.resetAt,
    retryAfterMs: metadata.retryAfterMs,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function lifecycleReasonValue(value: unknown): LifecycleNotice["reason"] | undefined {
  return isLifecycleMessageReasonCode(value) || isTurnReasonCode(value) ? value : undefined;
}

function lifecycleNoticeFromMessage(message: ProjectedMessage): LifecycleNotice | null {
  const diagnostic = record(record(message.actor.metadata)["vibestudioDiagnostic"]);
  if (diagnostic["type"] === "lifecycle_recovery") {
    const status = diagnostic["status"];
    if (status === "recovered" || status === "interrupted" || status === "failed") {
      return {
        status,
        title: stringValue(diagnostic["title"]) ?? lifecycleTitleForStatus(status),
        detail: stringValue(diagnostic["detail"]) ?? messageDisplayText(message.blocks),
        reason: lifecycleReasonValue(diagnostic["reason"]),
      };
    }
  }
  return null;
}

function lifecycleTitleForStatus(status: LifecycleNotice["status"]): string {
  if (status === "recovered") return "Recovered after restart";
  if (status === "failed") return "Recovery failed";
  return "Restart interrupted the turn";
}

function projectedApprovalToChatMessage(approval: ProjectedApproval): ChatMessage {
  const payload: ApprovalCardPayload = {
    id: approval.approvalId,
    status: approval.status,
  };
  if (approval.invocationId !== undefined) payload.invocationId = approval.invocationId;
  if (approval.question !== undefined) payload.question = approval.question;
  if (approval.granted !== undefined) payload.granted = approval.granted;
  if (approval.reason !== undefined) payload.reason = approval.reason;
  return {
    id: `approval:${approval.approvalId}`,
    senderId: approval.actor.id,
    content: JSON.stringify(payload),
    contentType: "approval",
    kind: "message",
    complete: approval.status !== "requested",
    approval: payload,
    senderMetadata: {
      name: approval.actor.displayName ?? approval.actor.id,
      type: approval.actor.kind,
      handle: approval.actor.id,
    },
    sortTime:
      Date.parse(approval.updatedAt ?? approval.resolvedAt ?? approval.requestedAt ?? "") || 0,
  } as ChatMessage & { sortTime: number };
}

function projectedInvocationToChatMessage(invocation: ProjectedInvocation): ChatMessage {
  const status = invocationCardStatus(invocation);
  const inferred = inferInvocationDisplay(invocation.result);
  const name =
    meaningfulInvocationName(invocation.name) ??
    meaningfulInvocationName(inferred.name) ??
    "invocation";
  // Prefer the recorded tool-call request; fall back to the inferred request when the
  // recorded one is absent OR empty (docs_* model tool-calls arrive argless, so `{}`
  // would otherwise win over the request recovered from the result).
  const request =
    invocation.request &&
    typeof invocation.request === "object" &&
    Object.keys(invocation.request as Record<string, unknown>).length > 0
      ? invocation.request
      : (inferred.request ?? invocation.request);
  const resultImages = extractResultImages(invocation.result ?? invocation.outputs);
  const payload: InvocationCardPayload = {
    id: invocation.invocationId,
    ...(invocation.transportCallId ? { transportCallId: invocation.transportCallId } : {}),
    name,
    arguments: recordOrEmpty(request),
    execution: {
      status,
      ...(invocation.terminalOutcome ? { terminalOutcome: invocation.terminalOutcome } : {}),
      ...(invocation.terminalReasonCode
        ? { terminalReasonCode: invocation.terminalReasonCode }
        : {}),
      description: invocationDescription(invocation, inferred.summary),
      result: displayStoredValue(
        invocation.result === undefined && status === "error"
          ? invocation.terminalReason
          : invocation.result
      ),
      isError: status === "error",
      consoleOutput:
        invocation.outputs.length > 0
          ? invocation.outputs.map((output) => stringifyOutput(output)).join("\n")
          : undefined,
      // Images a tool returned, lifted out of the result so they render as
      // pictures instead of as an elided base64 field inside a JSON dump.
      ...(resultImages.length > 0 ? { resultImages } : {}),
    },
  };
  return {
    id: `invocation:${invocation.invocationId}`,
    senderId: invocation.actor.id,
    content: JSON.stringify(payload),
    contentType: "invocation",
    kind: "message",
    complete: status !== "pending" && status !== "running",
    invocation: payload,
    senderMetadata: {
      name: invocation.actor.displayName ?? invocation.actor.id,
      type: invocation.actor.kind,
      handle: invocation.actor.id,
    },
    sortTime:
      Date.parse(invocation.updatedAt ?? invocation.completedAt ?? invocation.startedAt ?? "") || 0,
  } as ChatMessage & { sortTime: number };
}

function invocationCardStatus(
  invocation: ProjectedInvocation
): InvocationCardPayload["execution"]["status"] {
  switch (invocation.terminalOutcome) {
    case "success":
      return "complete";
    case "tool_error":
    case "infrastructure_error":
      return "error";
    case "cancelled":
    case "stale_dispatch":
      return "cancelled";
    case "abandoned":
      return "abandoned";
    default:
      if (invocation.status === "failed") return "error";
      if (invocation.status === "cancelled" || invocation.status === "abandoned") {
        return invocation.status;
      }
      if (invocation.status === "completed") return "complete";
      if (invocation.status === "running") return "running";
      return "pending";
  }
}

function subagentDetails(value: unknown): SubagentRunState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)["subagent"];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const record = candidate as Record<string, unknown>;
  if (
    typeof record["runId"] !== "string" ||
    typeof record["childParticipantId"] !== "string" ||
    !record["childParticipantId"].trim()
  ) {
    return undefined;
  }
  return {
    runId: record["runId"],
    childParticipantId: record["childParticipantId"],
    ...(record["mode"] === "fresh" || record["mode"] === "fork"
      ? { mode: record["mode"] }
      : {}),
    ...(typeof record["taskChannelId"] === "string"
      ? { taskChannelId: record["taskChannelId"] }
      : {}),
    ...(typeof record["contextId"] === "string" ? { contextId: record["contextId"] } : {}),
    ...(typeof record["parentContextId"] === "string" || record["parentContextId"] === null
      ? { parentContextId: record["parentContextId"] }
      : {}),
    ...(typeof record["childEntityId"] === "string"
      ? { childEntityId: record["childEntityId"] }
      : {}),
    ...(typeof record["label"] === "string" ? { label: record["label"] } : {}),
    ...(typeof record["agentKind"] === "string" ? { agentKind: record["agentKind"] } : {}),
    ...(record["launchConfig"] &&
    typeof record["launchConfig"] === "object" &&
    !Array.isArray(record["launchConfig"])
      ? { launchConfig: record["launchConfig"] as Record<string, unknown> }
      : record["launchConfig"] === null
        ? { launchConfig: null }
        : {}),
  };
}

function projectedTaskToChatMessage(task: ProjectedTask): ChatMessage & { sortTime: number } {
  const subagent = task.taskType === "subagent" ? subagentDetails(task.details) : undefined;
  const status: TaskCardPayload["execution"]["status"] =
    task.status === "completed"
      ? "complete"
      : task.status === "failed"
        ? "error"
        : task.status === "cancelled" || task.status === "abandoned"
          ? task.status
          : task.status === "started" || task.status === "running"
            ? "running"
            : "pending";
  const payload: TaskCardPayload = {
    id: task.taskId,
    taskType: task.taskType ?? "task",
    title: task.title ?? task.actor.displayName ?? "Background task",
    execution: {
      status,
      ...(task.terminalOutcome ? { terminalOutcome: task.terminalOutcome } : {}),
      description: task.terminalReason ?? task.summary ?? "",
      ...(task.result !== undefined ? { result: displayStoredValue(task.result) } : {}),
      isError: status === "error",
    },
    ...(subagent ? { subagent } : {}),
  };
  return {
    id: `task:${task.taskId}`,
    senderId: task.actor.id,
    content: JSON.stringify(payload),
    contentType: "task",
    kind: "message",
    complete: status !== "pending" && status !== "running",
    task: payload,
    senderMetadata: {
      name: task.actor.displayName ?? task.actor.id,
      type: task.actor.kind,
      handle: task.actor.id,
    },
    sortTime: Date.parse(task.updatedAt ?? task.completedAt ?? task.startedAt ?? "") || 0,
  };
}

function invocationDescription(invocation: ProjectedInvocation, inferredSummary?: string): string {
  if (invocation.terminalReason) return invocation.terminalReason;
  const uiDescription = uiInvocationDescription(invocation);
  if (uiDescription) return uiDescription;
  return invocation.status === "completed" ? "" : (inferredSummary ?? "");
}

function uiInvocationDescription(invocation: ProjectedInvocation): string | undefined {
  switch (invocation.name) {
    case "inline_ui":
      return inlineUiInvocationDescription(invocation);
    case "load_action_bar":
      return actionBarInvocationDescription(invocation);
    case "feedback_form":
      return feedbackInvocationDescription(invocation, "feedback");
    case "feedback_custom":
      return feedbackInvocationDescription(invocation, "custom feedback");
    case "ui_prompt":
      return uiPromptInvocationDescription(invocation);
    case "inspect_card":
      return inspectCardInvocationDescription(invocation);
    default:
      return undefined;
  }
}

function inlineUiInvocationDescription(invocation: ProjectedInvocation): string {
  const request = recordOrEmpty(invocation.request);
  const result = recordOrEmpty(invocation.result);
  const source = uiSourceLabel(request);
  const error = methodError(result);
  if (error) return `Inline UI failed: ${error}`;
  if (invocation.status === "completed") {
    const id = stringValue(result["id"]);
    return id
      ? `Rendered inline UI (${id})`
      : `Rendered inline UI${source ? ` from ${source}` : ""}`;
  }
  return `Rendering inline UI${source ? ` from ${source}` : ""}`;
}

function actionBarInvocationDescription(invocation: ProjectedInvocation): string {
  const request = recordOrEmpty(invocation.request);
  const result = recordOrEmpty(invocation.result);
  const clear = request["clear"] === true || result["cleared"] === true;
  const error = methodError(result);
  if (error) return `Action bar failed: ${error}`;
  if (clear)
    return invocation.status === "completed" ? "Cleared action bar" : "Clearing action bar";
  const source = uiSourceLabel(request);
  return invocation.status === "completed"
    ? `Loaded action bar${source ? ` from ${source}` : ""}`
    : `Loading action bar${source ? ` from ${source}` : ""}`;
}

function feedbackInvocationDescription(
  invocation: ProjectedInvocation,
  label: "feedback" | "custom feedback"
): string {
  const request = recordOrEmpty(invocation.request);
  const result = recordOrEmpty(invocation.result);
  const title = feedbackTitle(request, label);
  if (invocation.status !== "completed") return `Waiting for ${label}: ${title}`;
  return completedFeedbackDescription(result, title);
}

function uiPromptInvocationDescription(invocation: ProjectedInvocation): string {
  const request = recordOrEmpty(invocation.request);
  const title = stringValue(request["title"]) ?? "prompt";
  const kind = stringValue(request["kind"]);
  if (invocation.status !== "completed") {
    return `Waiting for ${kind ? `${kind} ` : ""}prompt: ${title}`;
  }
  return `Prompt answered: ${title}`;
}

function inspectCardInvocationDescription(invocation: ProjectedInvocation): string {
  const request = recordOrEmpty(invocation.request);
  const result = recordOrEmpty(invocation.result);
  const messageId = stringValue(request["messageId"]);
  const suffix = messageId ? ` ${messageId}` : "";
  const error = methodError(result);
  if (error) return `Custom message inspection failed: ${error}`;
  return invocation.status === "completed"
    ? `Inspected custom message${suffix}`
    : `Inspecting custom message${suffix}`;
}

function completedFeedbackDescription(result: Record<string, unknown>, title: string): string {
  const type = stringValue(result["type"]);
  if (type === "submit") return `Feedback submitted: ${title}`;
  if (type === "cancel") return `Feedback cancelled: ${title}`;
  if (type === "error") {
    return `Feedback error: ${stringValue(result["message"]) ?? title}`;
  }
  return `Feedback completed: ${title}`;
}

function feedbackTitle(request: Record<string, unknown>, fallback: string): string {
  return stringValue(request["title"]) ?? uiSourceLabel(request) ?? fallback;
}

function uiSourceLabel(request: Record<string, unknown>): string | undefined {
  const path = stringValue(request["path"]);
  if (path) return path;
  return stringValue(request["code"]) ? "inline code" : undefined;
}

function methodError(result: Record<string, unknown>): string | undefined {
  if (result["ok"] !== false && stringValue(result["type"]) !== "error") return undefined;
  return stringValue(result["error"]) ?? stringValue(result["message"]) ?? "Unknown error";
}

function projectedInlineUiToChatMessage(
  participantId: string,
  inlineUi: {
    id: string;
    actor: { id: string; kind: string; displayName?: string };
    turnId?: string;
    source: InlineUiCardPayload["source"];
    imports?: Record<string, string>;
    props?: Record<string, unknown>;
    renderedAt: string;
  }
): ChatMessage {
  const payload: InlineUiCardPayload = {
    id: inlineUi.id,
    source: inlineUi.source,
    renderedAt: inlineUi.renderedAt,
  };
  if (inlineUi.imports !== undefined) payload.imports = inlineUi.imports;
  if (inlineUi.props !== undefined) payload.props = inlineUi.props;
  return {
    id: `inline-ui:${participantId}:${inlineUi.id}`,
    senderId: inlineUi.actor.id,
    content: JSON.stringify(payload),
    contentType: "inline_ui",
    kind: "message",
    complete: true,
    inlineUi: payload,
    senderMetadata: {
      name: inlineUi.actor.displayName ?? inlineUi.actor.id,
      type: inlineUi.actor.kind,
      handle: inlineUi.actor.id,
    },
    sortTime: Date.parse(inlineUi.renderedAt) || 0,
  } as ChatMessage & { sortTime: number };
}

function projectedCustomMessageToChatMessage(
  custom: ProjectedCustomMessage,
  registeredType: ChannelViewState["messageTypes"][string] | undefined
): ChatMessage[] {
  if (!custom.typeId) return [];
  const typeIsReady =
    registeredType?.source && registeredType.updatedAtSeq > (registeredType.clearedAtSeq ?? -1);
  const displayMode =
    custom.displayMode ?? (typeIsReady ? registeredType.displayMode : undefined) ?? "row";
  const payload: CustomMessageCardPayload = {
    messageId: custom.messageId,
    typeId: custom.typeId,
    displayMode,
    initialState: custom.initialState,
    updates: custom.updates,
    lastSeq: custom.lastSeq,
  };
  if (custom.by) {
    payload.by = {
      kind: custom.by.kind,
      id: custom.by.id,
      ...(custom.by.participantId ? { participantId: custom.by.participantId } : {}),
      ...(custom.by.displayName ? { displayName: custom.by.displayName } : {}),
    };
  }
  if (custom.failed) {
    payload.failed = true;
    payload.error = custom.error ?? { message: "card failed" };
  }
  return [
    {
      id: `custom:${custom.messageId}`,
      senderId: custom.by?.id ?? custom.typeId,
      content: JSON.stringify(payload),
      contentType: "custom",
      kind: "message",
      complete: true,
      custom: payload,
      senderMetadata: custom.by
        ? {
            name: custom.by.displayName ?? custom.by.id,
            type: custom.by.kind,
            handle: custom.by.id,
          }
        : undefined,
      sortTime: Date.parse(custom.updatedAt ?? custom.startedAt ?? "") || custom.lastSeq,
    } as ChatMessage & { sortTime: number },
  ];
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  if (isStoredValueRef(value)) return {};
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function parseStoredJsonPreview(value: unknown): unknown {
  if (!isStoredValueRef(value) || value.encoding !== "json") return undefined;
  const preview = (value as StoredValueRefPreview).preview;
  if (typeof preview !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(preview);
  } catch {
    return undefined;
  }
}

function storedValuePreview(value: unknown): string | undefined {
  return isStoredValueRef(value) ? (value as StoredValueRefPreview).preview : undefined;
}

function meaningfulInvocationName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed !== "unknown" && trimmed !== "invocation" ? trimmed : undefined;
}

/**
 * Recover a display for the `docs_search` / `docs_open` tools. Their model
 * tool-call name + args don't survive into the invocation event (so the generic
 * projection shows a nameless "invocation" pill with no args). Detect them by the
 * catalog shape of `result.details` — a hit array or a single entry, both carrying
 * `surface` + `qualifiedName` — and synthesize a name/summary/request.
 */
function inferDocsResultDisplay(
  details: unknown,
  content?: unknown
): { name: string; summary?: string; request?: unknown } | undefined {
  const isCatalogShape = (v: unknown): v is Record<string, unknown> =>
    !!v &&
    typeof v === "object" &&
    typeof (v as Record<string, unknown>)["surface"] === "string" &&
    typeof (v as Record<string, unknown>)["qualifiedName"] === "string";
  if (Array.isArray(details)) {
    if (details.length === 0 && contentLooksLikeEmptyDocsSearch(content)) {
      return { name: "docs_search", summary: "0 results" };
    }
    return isCatalogShape(details[0])
      ? {
          name: "docs_search",
          summary: `${details.length} result${details.length === 1 ? "" : "s"}`,
        }
      : undefined;
  }
  if (isCatalogShape(details)) {
    return {
      name: "docs_open",
      summary: String(details["qualifiedName"]),
      ...(typeof details["id"] === "string" ? { request: { id: details["id"] } } : {}),
    };
  }
  return undefined;
}

function contentLooksLikeEmptyDocsSearch(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const block = raw as Record<string, unknown>;
    return (
      block["type"] === "text" &&
      typeof block["text"] === "string" &&
      block["text"].startsWith("No catalog matches for ")
    );
  });
}

function inferInvocationDisplay(value: unknown): {
  name?: string;
  request?: unknown;
  summary?: string;
} {
  if (isStoredValueRef(value)) {
    const parsed = parseStoredJsonPreview(value);
    if (parsed !== undefined) return inferInvocationDisplay(parsed);
    return { summary: storedValuePreview(value) ?? `${value.encoding} blob ${value.digest}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const name =
    meaningfulInvocationName(record["toolName"]) ?? meaningfulInvocationName(record["name"]);
  const summary = typeof record["summary"] === "string" ? record["summary"] : undefined;
  const details = record["details"];
  const docs = inferDocsResultDisplay(details, record["content"]);
  if (docs) {
    return {
      name: name ?? docs.name,
      summary: summary ?? docs.summary,
      ...(docs.request !== undefined ? { request: docs.request } : {}),
    };
  }
  if (!details || typeof details !== "object" || Array.isArray(details)) return { name, summary };
  const detailRecord = details as Record<string, unknown>;
  return {
    name,
    summary,
    request: detailRecord["input"] ?? detailRecord["args"] ?? detailRecord["arguments"],
  };
}

function stringifyOutput(value: unknown): string {
  if (isStoredValueRef(value)) {
    return storedValuePreview(value) ?? `[stored ${value.encoding} blob ${value.digest}]`;
  }
  if (typeof value === "string") return value;
  const consoleLine = formatConsoleStreamOutput(value);
  if (consoleLine !== undefined) return consoleLine;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatConsoleStreamOutput(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record["type"] !== "console") return undefined;

  const content = record["content"];
  const text =
    typeof content === "string" ? content : content == null ? "" : stringifyOutput(content);
  const level = typeof record["level"] === "string" ? record["level"].toLowerCase() : "";
  if (!level || level === "log") return text;
  return `[${level.toUpperCase()}] ${text}`;
}

function displayStoredValue(value: unknown): unknown {
  if (!isStoredValueRef(value)) return value;
  return {
    stored: true,
    digest: value.digest,
    size: value.size,
    encoding: value.encoding,
    preview: storedValuePreview(value),
  };
}
