import type {
  ActorRef,
  AgenticEvent,
  DiagnosticBlockMetadata,
  EventKind,
  MessageBlockInput,
  MessageEditPayload,
  MessageModelPayload,
  MessageReceiptPayload,
  MessageRetractPayload,
  ParticipantRef,
  ParticipantSelector,
  SandboxSourcePayload,
  UsagePayload,
} from "./events.js";
import type { AgentToolFailure } from "./tool-failure.js";
import type { ApprovalId, InvocationId, MessageId, TaskId, TurnId } from "./ids.js";
import type { InvocationOutcome, MessageOutcome, MessageTier } from "./constants.js";

export type MessageStatus = "started" | "streaming" | "completed" | "failed";
export type InvocationStatus =
  | "started"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "abandoned";
export type ApprovalStatus = "requested" | "granted" | "denied";
export type TaskStatus =
  | "started"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "abandoned";

/** Escalation intent carried on a `notify` message payload (`metadata.notify`). */
export interface MessageNotifyIntent {
  alert: "none" | "inbox" | "interrupt";
  title?: string;
}

/** Read `metadata.notify` off a message payload; absent or malformed ⇒ undefined. */
export function readMessageNotifyIntent(metadata: unknown): MessageNotifyIntent | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const notify = (metadata as { notify?: unknown }).notify;
  if (!notify || typeof notify !== "object") return undefined;
  const alert = (notify as { alert?: unknown }).alert;
  if (alert !== "none" && alert !== "inbox" && alert !== "interrupt") return undefined;
  const title = (notify as { title?: unknown }).title;
  return { alert, ...(typeof title === "string" && title ? { title } : {}) };
}

export interface ProjectedMessage {
  messageId: MessageId;
  actor: ActorRef;
  turnId?: TurnId;
  role: string;
  blocks?: MessageBlockInput[];
  mentions?: string[];
  replyTo?: MessageId;
  status: MessageStatus;
  outcome?: MessageOutcome;
  /** Salience tier declared by the sender; absent ⇒ treated as "primary". */
  tier?: MessageTier;
  /** Envelope seq at which this message first appeared (message.started, or
   *  message.completed for user messages). The fork-point locus: a fork rooted
   *  here uses `seq` (or `seq−1` for an edit-fork). */
  seq?: number;
  /** Marks an explicit supervisor `say`. */
  saliency?: "say";
  /** The `notify` tool's declared escalation (messaging plan §4.3): what the
   *  sender asked addressed people to experience. Projected from the message
   *  payload's `metadata.notify` so the envelope stays the one record. */
  notify?: MessageNotifyIntent;
  /** Edit-fork provenance: the parent message this supersedes. */
  replaces?: { messageId: string; seq: number };
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  failureReason?: string;
  failureCode?: string;
  failureResetAt?: string;
  failureRetryAfterMs?: number;
  failureRecoverable?: boolean;
  updatedAt?: string;
  usage?: UsagePayload;
  model?: MessageModelPayload;
  /** Explicit recipient selectors declared by the sender at send time. */
  to?: ParticipantSelector[];
  /** Recipients that accepted the message into inbound work, keyed by
   *  `participantKey(actor)`. Monotone. */
  receivedBy?: Record<string, { at: string }>;
  /** Recipients that consumed the message into a model turn, keyed by
   *  `participantKey(actor)`. Monotone; `read` implies `received`. */
  readBy?: Record<string, { at: string; turnId?: string }>;
  /** The original author canceled this (still-unread) message. */
  retracted?: boolean;
  retractedAt?: string;
  /** Edit count — bumped by each applied `message.edited`. */
  revision?: number;
  editedAt?: string;
  /** Envelope seq of the last content-bearing event (started/delta/completed/
   *  edited). Drives the stale-edit guard. */
  lastContentSeq?: number;
}

export interface ProjectedInvocation {
  invocationId: InvocationId;
  transportCallId?: string;
  actor: ActorRef;
  turnId?: TurnId;
  name?: string;
  status: InvocationStatus;
  request?: unknown;
  result?: unknown;
  outputs: unknown[];
  progress: Array<{
    at: string;
    message?: string;
    progress?: number;
    data?: unknown;
  }>;
  requiresApproval?: boolean;
  userVisible?: boolean;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  terminalReason?: string;
  terminalOutcome?: InvocationOutcome;
  terminalReasonCode?: string;
  failure?: AgentToolFailure;
}

export interface ProjectedTask {
  taskId: TaskId;
  actor: ActorRef;
  taskType?: string;
  title?: string;
  summary?: string;
  details?: unknown;
  status: TaskStatus;
  result?: unknown;
  progress: Array<{
    at: string;
    message?: string;
    progress?: number;
    data?: unknown;
  }>;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  terminalReason?: string;
  terminalOutcome?: InvocationOutcome;
}

export interface ProjectedApproval {
  approvalId: ApprovalId;
  invocationId?: InvocationId;
  actor: ActorRef;
  status: ApprovalStatus;
  question?: string;
  granted?: boolean;
  reason?: string;
  requestedAt?: string;
  resolvedAt?: string;
  updatedAt?: string;
}

export interface ProjectedInlineUi {
  id: string;
  turnId?: TurnId;
  actor: ActorRef;
  source: SandboxSourcePayload;
  imports?: Record<string, string>;
  props?: Record<string, unknown>;
  renderedAt: string;
}

export interface ProjectedActionBar {
  id?: string;
  actor: ActorRef;
  source?: SandboxSourcePayload;
  imports?: Record<string, string>;
  props?: Record<string, unknown>;
  maxHeight?: number;
  cleared?: boolean;
  result?: { ok: boolean; error?: string };
  updatedAt: string;
}

export interface ProjectedTurn {
  turnId: TurnId;
  actor: ActorRef;
  status: "open" | "waiting" | "closed";
  openedAt: string;
  closedAt?: string;
  updatedAt?: string;
  summary?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  /** Highest envelope seq applied to this turn's status — the monotonicity guard
   *  that stops an out-of-order/replayed event from resurrecting a closed turn. */
  lastSeq?: number;
}

export type MessageMap = Record<string, ProjectedMessage>;
export type InvocationMap = Record<string, ProjectedInvocation>;
export type TaskMap = Record<string, ProjectedTask>;
export type ApprovalMap = Record<string, ProjectedApproval>;
export type InlineUiMap = Record<string, ProjectedInlineUi>;
export type TurnMap = Record<string, ProjectedTurn>;

function isTerminalInvocationStatus(status: InvocationStatus | undefined): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "abandoned"
  );
}

function requireMessageId(event: AgenticEvent): MessageId {
  const messageId = event.causality?.messageId;
  if (!messageId) throw new Error(`${event.kind} requires causality.messageId`);
  return messageId;
}

function requireInvocationId(event: AgenticEvent): InvocationId {
  const invocationId = event.causality?.invocationId;
  if (!invocationId) throw new Error(`${event.kind} requires causality.invocationId`);
  return invocationId;
}

function requireApprovalId(event: AgenticEvent): ApprovalId {
  const approvalId = event.causality?.approvalId;
  if (!approvalId) throw new Error(`${event.kind} requires causality.approvalId`);
  return approvalId;
}

function diagnosticBlock(
  blockId: string,
  content: string,
  metadata: DiagnosticBlockMetadata
): MessageBlockInput {
  return {
    blockId: blockId as never,
    type: "diagnostic",
    content,
    metadata: { ...metadata },
  };
}

function blocksWithDiagnostic(
  blocks: MessageBlockInput[] | undefined,
  diagnostic: MessageBlockInput
): MessageBlockInput[] {
  const existing = blocks ?? [];
  if (existing.some((block) => block.blockId === diagnostic.blockId)) return existing;
  return [...existing, diagnostic];
}

function upsertContentBlock(
  blocks: MessageBlockInput[] | undefined,
  blockId: string,
  type: "text" | "thinking" | "toolcall-progress",
  text: string,
  replace: boolean | undefined
): MessageBlockInput[] {
  const existing = blocks ?? [];
  const index = existing.findIndex((block) => block.blockId === blockId);
  if (index === -1) {
    return [...existing, { blockId: blockId as never, type, content: text }];
  }
  return existing.map((block, blockIndex) =>
    blockIndex === index
      ? { ...block, content: replace ? text : `${block.content ?? ""}${text}` }
      : block
  );
}

export function applyMessageEvent(
  messages: MessageMap,
  event: AgenticEvent<Extract<EventKind, `message.${string}`>>,
  /** Envelope seq; drives `lastContentSeq` and the stale-edit guard. Absent for
   *  ephemeral (signal) deltas, which never carry a seq. */
  seq?: number
): MessageMap {
  const messageId = requireMessageId(event);
  const existing = messages[messageId] ?? {
    messageId,
    actor: event.actor,
    role: event.actor.kind,
    status: "started" as const,
  };

  if (event.kind === "message.received") {
    // A receipt for an already-retracted message is ignored — a tombstone can
    // never gain receipts.
    if (existing.retracted) return messages;
    const key = participantKey(event.actor);
    if (existing.receivedBy?.[key]) return messages; // monotone: no re-set
    return {
      ...messages,
      [messageId]: {
        ...existing,
        receivedBy: { ...(existing.receivedBy ?? {}), [key]: { at: event.createdAt } },
        updatedAt: event.createdAt,
      },
    };
  }

  if (event.kind === "message.read") {
    // A racing read landing after a retract must not resurrect readBy on a
    // tombstone (mirror the received-after-retract guard).
    if (existing.retracted) return messages;
    const key = participantKey(event.actor);
    const payload = event.payload as MessageReceiptPayload;
    const turnId = payload.turnId;
    if (existing.readBy?.[key]) return messages; // monotone: read cannot downgrade
    return {
      ...messages,
      [messageId]: {
        ...existing,
        // read implies received — backfill if the received ack never arrived.
        receivedBy: {
          ...(existing.receivedBy ?? {}),
          [key]: existing.receivedBy?.[key] ?? { at: event.createdAt },
        },
        readBy: {
          ...(existing.readBy ?? {}),
          [key]: { at: event.createdAt, ...(turnId ? { turnId } : {}) },
        },
        updatedAt: event.createdAt,
      },
    };
  }

  if (event.kind === "message.edited") {
    const payload = event.payload as MessageEditPayload;
    // Author guard: payload.by must equal event.actor (the private-fold replay
    // carries `by` even though its envelope actor is the agent).
    if (participantKey(payload.by) !== participantKey(event.actor)) return messages;
    // Only the original author may edit, and only before any read.
    if (participantKey(existing.actor) !== participantKey(event.actor)) return messages;
    if (existing.retracted) return messages;
    if (existing.readBy && Object.keys(existing.readBy).length > 0) return messages;
    // Stale-edit guard: drop an edit that precedes the last content event.
    if (
      seq !== undefined &&
      existing.lastContentSeq !== undefined &&
      seq < existing.lastContentSeq
    ) {
      return messages;
    }
    return {
      ...messages,
      [messageId]: {
        ...existing,
        blocks: payload.blocks,
        revision: (existing.revision ?? 0) + 1,
        editedAt: event.createdAt,
        updatedAt: event.createdAt,
        ...(seq !== undefined ? { lastContentSeq: seq } : {}),
      },
    };
  }

  if (event.kind === "message.retracted") {
    const payload = event.payload as MessageRetractPayload;
    if (participantKey(payload.by) !== participantKey(event.actor)) return messages;
    if (participantKey(existing.actor) !== participantKey(event.actor)) return messages;
    if (existing.retracted) return messages; // idempotent
    // Read wins: a message folded into a turn cannot be un-read.
    if (existing.readBy && Object.keys(existing.readBy).length > 0) return messages;
    return {
      ...messages,
      [messageId]: {
        ...existing,
        retracted: true,
        retractedAt: event.createdAt,
        updatedAt: event.createdAt,
      },
    };
  }

  if (event.kind === "message.started") {
    const payload = event.payload;
    const role = ("role" in payload ? payload.role : undefined) ?? existing.role;
    const blocks = "blocks" in payload ? payload.blocks : existing.blocks;
    const mentions = "mentions" in payload ? payload.mentions : existing.mentions;
    const replyTo = "replyTo" in payload ? payload.replyTo : existing.replyTo;
    const tier = "tier" in payload ? payload.tier : existing.tier;
    const to = "to" in payload ? payload.to : existing.to;
    const saliency = "saliency" in payload ? payload.saliency : existing.saliency;
    const replaces = "replaces" in payload ? payload.replaces : existing.replaces;
    const notify =
      ("metadata" in payload ? readMessageNotifyIntent(payload.metadata) : undefined) ??
      existing.notify;
    return {
      ...messages,
      [messageId]: {
        ...existing,
        actor: event.actor,
        turnId: existing.turnId ?? event.turnId,
        role,
        blocks,
        mentions,
        replyTo,
        tier,
        ...(to !== undefined ? { to } : {}),
        ...(saliency !== undefined ? { saliency } : {}),
        ...(replaces !== undefined ? { replaces } : {}),
        ...(notify !== undefined ? { notify } : {}),
        status: "started",
        startedAt: event.createdAt,
        updatedAt: event.createdAt,
        seq: existing.seq ?? seq,
        ...(seq !== undefined ? { lastContentSeq: seq } : {}),
      },
    };
  }

  if (event.kind === "message.delta") {
    // Terminal guard: ephemeral deltas travel an unordered path (signals) and
    // can race in AFTER the durable terminal. Applying one would append
    // duplicate text and flip the message back to "streaming" permanently
    // (which is what the typing indicator ultimately derives from).
    if (existing.status === "completed" || existing.status === "failed") {
      return messages;
    }
    const payload = event.payload;
    const blockId = "blockId" in payload ? String(payload.blockId) : "";
    const type = "type" in payload ? payload.type : "text";
    const text = "text" in payload && typeof payload.text === "string" ? payload.text : "";
    const replace = "replace" in payload ? payload.replace : undefined;
    return {
      ...messages,
      [messageId]: {
        ...existing,
        actor: event.actor,
        turnId: existing.turnId ?? event.turnId,
        blocks: upsertContentBlock(existing.blocks, blockId, type, text, replace),
        status: "streaming",
        // Signals can overtake the durable message.started envelope. Anchor a
        // provisional stream at its first observed delta so transcript order
        // is stable until the authoritative lifecycle event arrives.
        startedAt: existing.startedAt ?? event.createdAt,
        updatedAt: event.createdAt,
        ...(seq !== undefined ? { lastContentSeq: seq } : {}),
      },
    };
  }

  if (event.kind === "message.completed") {
    const payload = event.payload;
    const role = ("role" in payload ? payload.role : undefined) ?? existing.role;
    const outcome = "outcome" in payload ? payload.outcome : existing.outcome;
    let blocks = "blocks" in payload ? payload.blocks : existing.blocks;
    if (outcome === "empty") {
      blocks = blocksWithDiagnostic(
        blocks,
        diagnosticBlock(
          `${messageId}:diagnostic:empty`,
          "Assistant message had no visible content.",
          {
            code: "message_empty",
            severity: "warning",
            reason: "empty",
          }
        )
      );
    }
    const mentions = "mentions" in payload ? payload.mentions : existing.mentions;
    const replyTo = "replyTo" in payload ? payload.replyTo : existing.replyTo;
    const tier = "tier" in payload ? payload.tier : existing.tier;
    const to = "to" in payload ? payload.to : existing.to;
    const saliency = "saliency" in payload ? payload.saliency : existing.saliency;
    const replaces = "replaces" in payload ? payload.replaces : existing.replaces;
    const model = "model" in payload ? payload.model : existing.model;
    const notify =
      ("metadata" in payload ? readMessageNotifyIntent(payload.metadata) : undefined) ??
      existing.notify;
    return {
      ...messages,
      [messageId]: {
        ...existing,
        actor: event.actor,
        turnId: existing.turnId ?? event.turnId,
        role,
        blocks,
        mentions,
        replyTo,
        tier,
        ...(to !== undefined ? { to } : {}),
        ...(saliency !== undefined ? { saliency } : {}),
        ...(replaces !== undefined ? { replaces } : {}),
        ...(notify !== undefined ? { notify } : {}),
        status: "completed",
        outcome,
        completedAt: event.createdAt,
        updatedAt: event.createdAt,
        usage: "usage" in payload ? payload.usage : existing.usage,
        ...(model !== undefined ? { model } : {}),
        seq: existing.seq ?? seq,
        ...(seq !== undefined ? { lastContentSeq: seq } : {}),
      },
    };
  }

  return {
    ...messages,
    [messageId]: {
      ...existing,
      actor: event.actor,
      turnId: existing.turnId ?? event.turnId,
      status: "failed",
      blocks: blocksWithDiagnostic(
        existing.blocks,
        diagnosticBlock(
          `${messageId}:diagnostic:failed`,
          "reason" in event.payload && typeof event.payload.reason === "string"
            ? event.payload.reason
            : "Assistant message failed.",
          {
            code: "message_failed",
            severity: "error",
            reason: "reason" in event.payload ? event.payload.reason : undefined,
            recoverable: "recoverable" in event.payload ? event.payload.recoverable : undefined,
            failureCode: "code" in event.payload ? event.payload.code : undefined,
            resetAt: "resetAt" in event.payload ? event.payload.resetAt : undefined,
            retryAfterMs: "retryAfterMs" in event.payload ? event.payload.retryAfterMs : undefined,
          }
        )
      ),
      failedAt: event.createdAt,
      failureReason: "reason" in event.payload ? event.payload.reason : existing.failureReason,
      failureCode: "code" in event.payload ? event.payload.code : existing.failureCode,
      failureResetAt: "resetAt" in event.payload ? event.payload.resetAt : existing.failureResetAt,
      failureRetryAfterMs:
        "retryAfterMs" in event.payload ? event.payload.retryAfterMs : existing.failureRetryAfterMs,
      failureRecoverable:
        "recoverable" in event.payload ? event.payload.recoverable : existing.failureRecoverable,
      updatedAt: event.createdAt,
    },
  };
}

export function applyInvocationEvent(
  invocations: InvocationMap,
  event: AgenticEvent<Extract<EventKind, `invocation.${string}`>>
): InvocationMap {
  const invocationId = requireInvocationId(event);
  const existing = invocations[invocationId] ?? {
    invocationId,
    actor: event.actor,
    status: "started" as const,
    outputs: [],
    progress: [],
  };

  if (event.kind === "invocation.started") {
    if (isTerminalInvocationStatus(existing.status)) return invocations;
    const payload = event.payload;
    return {
      ...invocations,
      [invocationId]: {
        ...existing,
        transportCallId: existing.transportCallId ?? event.causality?.transportCallId,
        actor: existing.actor ?? event.actor,
        turnId: existing.turnId ?? event.turnId,
        name: existing.name ?? ("name" in payload ? payload.name : undefined),
        request: existing.request ?? ("request" in payload ? payload.request : undefined),
        requiresApproval:
          existing.requiresApproval ??
          ("requiresApproval" in payload ? payload.requiresApproval : undefined),
        userVisible:
          existing.userVisible === true
            ? true
            : "userVisible" in payload
              ? payload.userVisible
              : existing.userVisible,
        status: "started",
        startedAt: existing.startedAt ?? event.createdAt,
        updatedAt: event.createdAt,
      },
    };
  }

  if (event.kind === "invocation.progress") {
    if (isTerminalInvocationStatus(existing.status)) return invocations;
    const payload = event.payload;
    return {
      ...invocations,
      [invocationId]: {
        ...existing,
        transportCallId: existing.transportCallId ?? event.causality?.transportCallId,
        actor: event.actor,
        turnId: existing.turnId ?? event.turnId,
        status: "running",
        updatedAt: event.createdAt,
        progress: [
          ...existing.progress,
          {
            at: event.createdAt,
            message: "message" in payload ? payload.message : undefined,
            progress: "progress" in payload ? payload.progress : undefined,
            data: "data" in payload ? payload.data : undefined,
          },
        ],
      },
    };
  }

  if (event.kind === "invocation.output") {
    if (isTerminalInvocationStatus(existing.status)) return invocations;
    const payload = event.payload;
    return {
      ...invocations,
      [invocationId]: {
        ...existing,
        transportCallId: existing.transportCallId ?? event.causality?.transportCallId,
        actor: event.actor,
        turnId: existing.turnId ?? event.turnId,
        status: "running",
        updatedAt: event.createdAt,
        outputs: [...existing.outputs, "output" in payload ? payload.output : payload],
      },
    };
  }

  if (event.kind === "invocation.completed") {
    if (isTerminalInvocationStatus(existing.status)) return invocations;
    const payload = event.payload;
    const result = "result" in payload ? payload.result : undefined;
    const inferred = inferInvocationMetadata(result);
    return {
      ...invocations,
      [invocationId]: {
        ...existing,
        transportCallId: existing.transportCallId ?? event.causality?.transportCallId,
        actor: existing.actor ?? event.actor,
        turnId: existing.turnId ?? event.turnId,
        name: existing.name ?? inferred.name,
        request: existing.request ?? inferred.request,
        status: "completed",
        result,
        terminalReason: "summary" in payload ? payload.summary : existing.terminalReason,
        terminalOutcome:
          "terminalOutcome" in payload ? payload.terminalOutcome : existing.terminalOutcome,
        terminalReasonCode:
          "terminalReasonCode" in payload
            ? payload.terminalReasonCode
            : existing.terminalReasonCode,
        completedAt: event.createdAt,
        updatedAt: event.createdAt,
      },
    };
  }

  const payload = event.payload;
  if (isTerminalInvocationStatus(existing.status)) return invocations;
  const result = "error" in payload ? payload.error : undefined;
  const inferred = inferInvocationMetadata(result);
  return {
    ...invocations,
    [invocationId]: {
      ...existing,
      transportCallId: existing.transportCallId ?? event.causality?.transportCallId,
      actor: existing.actor ?? event.actor,
      turnId: existing.turnId ?? event.turnId,
      name: existing.name ?? inferred.name,
      request: existing.request ?? inferred.request,
      status: event.kind.replace("invocation.", "") as InvocationStatus,
      completedAt: event.createdAt,
      updatedAt: event.createdAt,
      result,
      terminalReason: "reason" in payload ? payload.reason : undefined,
      terminalOutcome:
        "terminalOutcome" in payload ? payload.terminalOutcome : existing.terminalOutcome,
      terminalReasonCode:
        "terminalReasonCode" in payload ? payload.terminalReasonCode : existing.terminalReasonCode,
      failure: "failure" in payload ? payload.failure : existing.failure,
    },
  };
}

function isTerminalTaskStatus(status: TaskStatus | undefined): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "abandoned"
  );
}

export function applyTaskEvent(
  tasks: TaskMap,
  event: AgenticEvent<Extract<EventKind, `task.${string}`>>
): TaskMap {
  const taskId = event.causality?.taskId;
  if (!taskId) throw new Error(`${event.kind} requires taskId`);
  const existing = tasks[taskId] ?? {
    taskId,
    actor: event.actor,
    status: "started" as const,
    progress: [],
  };
  if (isTerminalTaskStatus(existing.status)) return tasks;
  const payload = event.payload;

  if (event.kind === "task.started") {
    return {
      ...tasks,
      [taskId]: {
        ...existing,
        actor: event.actor,
        taskType: "taskType" in payload ? payload.taskType : existing.taskType,
        title: "title" in payload ? payload.title : existing.title,
        summary: "summary" in payload ? payload.summary : existing.summary,
        details: "details" in payload ? payload.details : existing.details,
        status: "started",
        startedAt: existing.startedAt ?? event.createdAt,
        updatedAt: event.createdAt,
      },
    };
  }

  if (event.kind === "task.completed") {
    return {
      ...tasks,
      [taskId]: {
        ...existing,
        status: "completed",
        result: "result" in payload ? payload.result : undefined,
        summary: "summary" in payload ? payload.summary : existing.summary,
        terminalOutcome: "success",
        completedAt: event.createdAt,
        updatedAt: event.createdAt,
      },
    };
  }

  return {
    ...tasks,
    [taskId]: {
      ...existing,
      status: event.kind.replace("task.", "") as TaskStatus,
      terminalReason: "reason" in payload ? payload.reason : undefined,
      terminalOutcome: "terminalOutcome" in payload ? payload.terminalOutcome : undefined,
      completedAt: event.createdAt,
      updatedAt: event.createdAt,
    },
  };
}

function inferInvocationMetadata(value: unknown): { name?: string; request?: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const name =
    typeof record["toolName"] === "string"
      ? record["toolName"]
      : typeof record["name"] === "string"
        ? record["name"]
        : undefined;
  let request: unknown;
  const details = record["details"];
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const detailsRecord = details as Record<string, unknown>;
    request = detailsRecord["input"] ?? detailsRecord["args"] ?? detailsRecord["arguments"];
  }
  return { name, request };
}

export function applyApprovalEvent(
  approvals: ApprovalMap,
  event: AgenticEvent<Extract<EventKind, `approval.${string}`>>
): ApprovalMap {
  const approvalId = requireApprovalId(event);
  const existing = approvals[approvalId] ?? {
    approvalId,
    invocationId: event.causality?.invocationId,
    actor: event.actor,
    status: "requested" as const,
  };

  if (event.kind === "approval.requested") {
    const payload = event.payload;
    return {
      ...approvals,
      [approvalId]: {
        ...existing,
        actor: event.actor,
        question: "question" in payload ? payload.question : existing.question,
        status: "requested",
        requestedAt: event.createdAt,
        updatedAt: event.createdAt,
      },
    };
  }

  const payload = event.payload;
  const granted = "granted" in payload ? payload.granted : false;
  return {
    ...approvals,
    [approvalId]: {
      ...existing,
      actor: event.actor,
      granted,
      status: granted ? "granted" : "denied",
      reason: "reason" in payload ? payload.reason : undefined,
      resolvedAt: event.createdAt,
      updatedAt: event.createdAt,
    },
  };
}

export function applyUiEvent(
  inlineUi: InlineUiMap,
  actionBar: ProjectedActionBar | undefined,
  event: AgenticEvent<"ui.inline_rendered" | "ui.action_bar.updated">
): { inlineUi: InlineUiMap; actionBar?: ProjectedActionBar } {
  const payload = event.payload;
  if (event.kind === "ui.inline_rendered" && payload.uiType === "inline") {
    const item: ProjectedInlineUi = {
      id: payload.id,
      turnId: event.turnId,
      actor: event.actor,
      source: payload.source,
      renderedAt: event.createdAt,
    };
    if (payload.imports !== undefined) item.imports = payload.imports;
    if (payload.props !== undefined) item.props = payload.props;
    return {
      inlineUi: {
        ...inlineUi,
        [payload.id]: item,
      },
      actionBar,
    };
  }
  if (event.kind === "ui.action_bar.updated" && payload.uiType === "action_bar") {
    const nextActionBar: ProjectedActionBar = {
      actor: event.actor,
      updatedAt: event.createdAt,
    };
    if (payload.id !== undefined) nextActionBar.id = payload.id;
    if (payload.source !== undefined) nextActionBar.source = payload.source;
    if (payload.imports !== undefined) nextActionBar.imports = payload.imports;
    if (payload.props !== undefined) nextActionBar.props = payload.props;
    if (payload.maxHeight !== undefined) nextActionBar.maxHeight = payload.maxHeight;
    if (payload.cleared !== undefined) nextActionBar.cleared = payload.cleared;
    if (payload.result !== undefined) nextActionBar.result = payload.result;
    return {
      inlineUi,
      actionBar: nextActionBar,
    };
  }
  return { inlineUi, actionBar };
}

export function participantKey(participant: ParticipantRef | ActorRef): string {
  return "participantId" in participant && participant.participantId
    ? participant.participantId
    : `${participant.kind}:${participant.id}`;
}

/** A roster entry as the intended-recipient resolver needs it. */
export interface RecipientRosterEntry {
  participant: ActorRef | ParticipantRef;
  roles?: string[];
}

/**
 * Resolve a message's intended recipients into a concrete set of participant
 * keys AT SEND TIME, to be STORED as a snapshot (callers persist the result so
 * a later join/leave never retroactively changes a message's recipient set).
 *
 * Precedence: explicit `to` selectors → mentions that resolve to roster
 * participants → all agent participants in the roster. The sender is always
 * excluded.
 */
export function resolveIntendedRecipients(opts: {
  to?: ParticipantSelector[];
  mentions?: string[];
  roster: RecipientRosterEntry[];
  senderKey: string;
}): string[] {
  const { to, mentions, roster, senderKey } = opts;
  const result = new Set<string>();
  const add = (key: string) => {
    if (key && key !== senderKey) result.add(key);
  };

  if (to && to.length > 0) {
    for (const selector of to) {
      if (selector.kind === "all") {
        for (const entry of roster) add(participantKey(entry.participant));
      } else if (selector.kind === "role" && selector.role) {
        for (const entry of roster) {
          if ((entry.roles ?? []).includes(selector.role)) add(participantKey(entry.participant));
        }
      } else if (selector.kind === "participant" && selector.participantId) {
        add(selector.participantId);
      }
    }
    return [...result];
  }

  if (mentions && mentions.length > 0) {
    for (const mention of mentions) {
      const handle = mention.startsWith("@") ? mention.slice(1) : mention;
      for (const entry of roster) {
        const participant = entry.participant;
        if (
          participant.id === handle ||
          ("participantId" in participant && participant.participantId === handle) ||
          participant.displayName === handle
        ) {
          add(participantKey(participant));
        }
      }
    }
    if (result.size > 0) return [...result];
  }

  for (const entry of roster) {
    if (entry.participant.kind === "agent") add(participantKey(entry.participant));
  }
  return [...result];
}
