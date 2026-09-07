/**
 * RPC-based PubSub client.
 *
 * Implements PubSubClient<T> using RPC calls to the manifest-declared channel
 * service DO. Used by panels that communicate through the Electron RPC bridge.
 */

import type {
  ParticipantMetadata,
  Participant,
  RosterUpdate,
  Attachment,
  AttachmentInput,
  ChannelConfig,
  PublishOptions,
  UpdateMetadataOptions,
  PubSubMessage,
  LeaveReason,
  ChannelReplayEnvelope,
  ChannelReplayAfterRequest,
  ServerLogEvent,
  BootstrapSnapshot,
  MessageTypeDefinition,
  RegisterMessageTypeInput,
  ChannelMember,
  ChannelInvite,
  ChannelPresenceEntry,
} from "./types.js";
import { DEFAULT_CHANNEL_REPLAY_PAGE_LIMIT } from "./types.js";
import type { RpcChannelMessage } from "./protocol-wire.js";
import { PubSubError } from "./types.js";
import type {
  IncomingEvent,
  IncomingErrorMessage,
  IncomingSignalEvent,
  IncomingInvocationCallEvent,
  IncomingPresenceEventWithType,
  IncomingAgenticEvent,
  IncomingAgentDebugEvent,
  EventStreamItem,
  EventStreamOptions,
  MethodCallHandle,
  MethodResultChunk,
  MethodResultValue,
  MethodDefinitionLike,
  MethodAdvertisement,
  JsonSchema,
  MethodExecutionContext,
} from "./protocol-types.js";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  CREDENTIAL_CONNECT_PAYLOAD_KIND,
  hydrateStoredValueRefs,
  type AgenticEvent,
  type MessageBlockInput,
  type MessageId,
  type MessageTier,
  type ParticipantRef,
} from "@workspace/agentic-protocol";
import { AgenticError } from "./protocol-types.js";
import { ErrorMessageSchema, SignalMessageSchema } from "./protocol.js";
import { createFanout } from "./async-queue.js";
import { base64ToUint8Array } from "./image-utils.js";
import { zodToJsonSchema as convertZodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { pendingReviewNotice } from "@vibestudio/shared/authority/reviewPending";
import type { PubSubClient } from "./client.js";
import type { RecoveryCoordinator } from "@vibestudio/shell-core/recoveryCoordinator";
import { iterateChannelReplayAfterPages } from "./channel-replay.js";
import { readChannelSubscriptionRecords } from "@vibestudio/service-schemas/channel";
import { Validator } from "@cfworker/json-schema";
import { draft7MetaSchema } from "./json-schema-draft-07.js";
import { waitForApprovalResolution } from "./review-readiness.js";
import type {
  ResidentSessionRegistrar,
  ResidentSessionRegistration,
  ResidentSessionTransport,
} from "@vibestudio/shared/residentSession";

const DEFAULT_CHANNEL_SERVICE_PROTOCOL = "vibestudio.channel.v1";
const METHOD_START_REDRIVE_BASE_DELAY_MS = 100;
const METHOD_START_REDRIVE_MAX_DELAY_MS = 5_000;

const methodSchemaValidator = new Validator(draft7MetaSchema, "7", false);

/**
 * Method advertisements cross the model-tool boundary, whose schemas use JSON
 * Schema semantics. OpenAPI 3.0 represents exclusive numeric bounds as a
 * boolean plus `minimum`; JSON Schema draft 7 represents the bound itself as a
 * number. Emitting the OpenAPI form makes otherwise-valid client methods fail
 * strict provider validation before inference begins.
 */
function methodJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const converted = convertZodToJsonSchema(schema, {
    target: "jsonSchema7",
  }) as JsonSchema;
  const { $schema: _dialect, ...advertised } = converted;
  return advertised;
}

function assertValidMethodSchema(
  methodName: string,
  field: "parameters" | "returns",
  schema: JsonSchema
): void {
  const result = methodSchemaValidator.validate(schema);
  if (result.valid) return;
  const details = result.errors
    .map((error) => `${error.instanceLocation || "schema"} ${error.error}`)
    .join("; ");
  throw new Error(
    `Invalid JSON Schema advertised for method ${JSON.stringify(methodName)} ${field}: ${details}`
  );
}

/**
 * A remote access/application rejection proves the channel refused the start.
 * Every other failure can occur after the request crossed the boundary but
 * before its acknowledgement returned, so it cannot authoritatively terminate
 * a journal-before-dispatch method call.
 */
function isAmbiguousMethodStartFailure(error: unknown): boolean {
  const kind = (error as { errorKind?: unknown } | null)?.errorKind;
  return kind !== "access" && kind !== "application";
}

/**
 * Keep the PubSub category separate from an RPC/service error code. The former
 * drives PubSub recovery; the latter is what lets consumers explain a typed
 * server outcome such as a review that is waiting on the user.
 */
function toPubSubError(error: unknown, fallbackCode: "connection" | "server"): PubSubError {
  if (error instanceof PubSubError) return error;
  const source = (typeof error === "object" && error !== null ? error : {}) as {
    cause?: unknown;
    code?: unknown;
    errorCode?: unknown;
    errorData?: unknown;
  };
  const errorCode =
    typeof source.errorCode === "string"
      ? source.errorCode
      : typeof source.code === "string"
        ? source.code
        : undefined;
  return new PubSubError(error instanceof Error ? error.message : String(error), fallbackCode, {
    cause: error instanceof Error ? error : source.cause,
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(source.errorData !== undefined ? { errorData: source.errorData } : {}),
  });
}

/** Wire attachment shape — base64 data string, not Uint8Array. */
interface WireAttachment {
  id: string;
  data: string; // base64
  mimeType: string;
  filename?: string;
  name?: string;
  size: number;
  type?: string;
}

interface ClientIngressMessage {
  stream: "log" | "signal" | "control" | "error";
  phase?: "replay" | "live";
  controlType?: "ready";
  id?: number;
  type?: string;
  payload?: unknown;
  senderId?: string;
  ts?: number;
  ref?: number;
  error?: string;
  attachments?: WireAttachment[];
  senderMetadata?: Record<string, unknown>;
  contentClass?: "internal" | "external";
  externalKeys?: string[];
  contextId?: string;
  channelConfig?: ChannelConfig;
  totalCount?: number;
  envelopeCount?: number;
  firstEnvelopeSeq?: number;
  hasMoreBefore?: boolean;
}

interface SubscribeResult {
  ok?: boolean;
  participantId: string;
  revision?: number;
  channelConfig?: ChannelConfig;
  envelope?: ChannelReplayEnvelope;
}

interface ResolvedService {
  kind: "durable-object" | "worker";
  targetId?: string;
}

export const CHANNEL_CLOSE_TIMEOUT_MS = 15_000;

export interface RpcChannelTargetOptions {
  /** Transport used for the context-bound service resolution call. */
  rpc: Pick<RpcConnectOptions["rpc"], "call">;
  /** Stable host transport that carries workspace review events. */
  reviewRpc: Pick<RpcConnectOptions["rpc"], "stream">;
  channel: string;
  protocol?: string;
  signal?: AbortSignal;
  /** Bound for one service-resolution RPC. Explicit review waiting is not
   * charged against this operation deadline. */
  resolutionTimeoutMs?: number;
}

/**
 * Resolve the channel service's concrete target without charging time spent in
 * a human workspace review against channel activation. Callers that impose a
 * replay deadline can await this boundary first, then start that deadline for
 * the actual subscription and replay work.
 */
export async function resolveRpcChannelTarget({
  rpc,
  reviewRpc,
  channel,
  protocol = DEFAULT_CHANNEL_SERVICE_PROTOCOL,
  signal,
  resolutionTimeoutMs,
}: RpcChannelTargetOptions): Promise<string> {
  while (true) {
    try {
      const service = await rpc.call<ResolvedService>("main", "workers.resolveService", [
        protocol,
        channel,
      ], {
        ...(signal ? { signal } : {}),
        ...(resolutionTimeoutMs !== undefined ? { timeoutMs: resolutionTimeoutMs } : {}),
      });
      if (service.kind !== "durable-object" || !service.targetId) {
        throw new Error("Channel service must resolve to a Durable Object service");
      }
      return service.targetId;
    } catch (error) {
      const review = pendingReviewNotice(error);
      if (!review) throw error;
      await waitForApprovalResolution(reviewRpc, review.approvalId, signal);
    }
  }
}

/** Convert wire-format attachments (base64) to client Attachment[] (Uint8Array). */
function convertWireAttachments(wireAtts: WireAttachment[] | undefined): Attachment[] | undefined {
  if (!wireAtts || wireAtts.length === 0) return undefined;
  return wireAtts.map((att) => ({
    id: att.id ?? "",
    data:
      typeof att.data === "string"
        ? base64ToUint8Array(att.data)
        : (att.data as unknown as Uint8Array),
    mimeType: att.mimeType,
    name: att.filename ?? att.name,
    size: att.size,
  }));
}

function eventToClientIngress(
  event: ServerLogEvent,
  phase: "replay" | "live"
): ClientIngressMessage {
  return {
    stream: "log",
    phase,
    id: event.id,
    type: event.type,
    payload: event.payload,
    senderId: event.senderId,
    ts: event.ts,
    senderMetadata: event.senderMetadata,
    contentClass: event.contentClass,
    externalKeys: event.externalKeys ? [...event.externalKeys] : undefined,
    attachments: event.attachments as WireAttachment[] | undefined,
  };
}

type PresenceAction = "join" | "leave" | "update";

interface PresencePayload {
  action?: PresenceAction;
  ref: ParticipantRef;
  metadata?: Record<string, unknown>;
  leaveReason?: LeaveReason;
}

export interface RpcConnectOptions<T extends ParticipantMetadata = ParticipantMetadata> {
  rpc: {
    call<R = unknown>(
      targetId: string,
      method: string,
      args: unknown[],
      options?: { signal?: AbortSignal; timeoutMs?: number }
    ): Promise<R>;
    stream(
      targetId: string,
      method: string,
      args: unknown[],
      options?: { signal?: AbortSignal; bodyIdleTimeoutMs?: number | null }
    ): Promise<Response>;
    selfId: string;
    registerResidentSession?: ResidentSessionRegistrar["registerResidentSession"];
  };
  channel: string;
  /** Exact channel entity returned by lifecycle creation. Supplying it avoids
   * rediscovering the same context-bound service through a different caller. */
  channelTargetId?: string;
  contextId?: string;
  channelConfig?: ChannelConfig;
  sinceId?: number;
  replayMessageLimit?: number;
  metadata?: T;
  protocol?: string;
  /** Stable participant id. Panel callers should pass runtime `slotId`, not `rpc.selfId`. */
  clientId?: string;
  name?: string;
  type?: string;
  handle?: string;
  replayMode?: "collect" | "stream" | "skip";
  /** Finite channel-to-owner delivery for an explicitly resident DO operation. */
  deliveryMode?: "stream" | "resident";
  /** Application-owned finite handler. Resident delivery is acknowledged only
   * after this handler accepts the hydrated event. */
  residentEventHandler?: (event: IncomingEvent) => void | Promise<void>;
  methods?: Record<string, MethodDefinitionLike>;
  /**
   * The sole automatic recovery owner. Without a coordinator this client is a
   * one-generation response resource and remains disconnected after terminal
   * transport loss.
   */
  recoveryCoordinator?: Pick<
    RecoveryCoordinator,
    "registerResubscribeHandler" | "registerColdRecoverHandler"
  > &
    Partial<Pick<RecoveryCoordinator, "run">>;
}

export function connectViaRpc<T extends ParticipantMetadata = ParticipantMetadata>(
  opts: RpcConnectOptions<T>
): PubSubClient<T> {
  const { rpc, channel, replayMode = "stream", methods: providedMethods } = opts;
  const hasSubscriptionRecovery = typeof opts.recoveryCoordinator?.run === "function";
  let residentRegistration: ResidentSessionRegistration | null = null;
  const sessionTransport = (): ResidentSessionTransport => residentRegistration?.transport ?? rpc;
  const protocol = opts.protocol ?? DEFAULT_CHANNEL_SERVICE_PROTOCOL;
  const deliveryId = opts.clientId ?? rpc.selfId;
  // The subscribe ACK replaces this with the channel's authoritative actor id
  // (`user:<verifiedUserId>` for humans). Delivery still targets deliveryId.
  let pid = deliveryId;
  let doTargetPromise: Promise<string> | null = opts.channelTargetId
    ? Promise.resolve(opts.channelTargetId)
    : null;
  const resolveDoTarget = (signal?: AbortSignal): Promise<string> =>
    resolveRpcChannelTarget({
      rpc: sessionTransport(),
      reviewRpc: rpc,
      channel,
      protocol,
      signal,
    });
  const getDoTarget = (signal?: AbortSignal): Promise<string> => {
    if (doTargetPromise) return doTargetPromise;
    const request = resolveDoTarget(signal);
    doTargetPromise = request;
    void request.catch(() => {
      // A transport failure or an aborted initial subscription must not poison
      // every later operation. Successful resolution remains sticky.
      if (doTargetPromise === request) doTargetPromise = null;
    });
    return request;
  };
  const callChannel = async <R = unknown>(method: string, ...args: unknown[]): Promise<R> =>
    sessionTransport().call<R>(await getDoTarget(), method, args);

  async function forEachReplayAfterPage(
    request: ChannelReplayAfterRequest,
    visit: (page: ChannelReplayEnvelope) => void | Promise<void>
  ): Promise<void> {
    for await (const page of iterateChannelReplayAfterPages(
      (pageRequest) => callChannel<ChannelReplayEnvelope>("getReplayAfter", pageRequest),
      request
    )) {
      await visit(page);
    }
  }

  const storedValueReads = new Map<string, Promise<string | null>>();
  const readStoredValueText = (digest: string): Promise<string | null> => {
    const active = storedValueReads.get(digest);
    if (active) return active;
    const pending = sessionTransport().call<string | null>("main", "blobstore.getText", [digest]);
    storedValueReads.set(digest, pending);
    void pending.then(
      () => {
        if (storedValueReads.get(digest) === pending) storedValueReads.delete(digest);
      },
      () => {
        if (storedValueReads.get(digest) === pending) storedValueReads.delete(digest);
      }
    );
    return pending;
  };
  const hydrateStoredTransportValue = async (value: unknown): Promise<unknown> =>
    hydrateStoredValueRefs(value, {
      getText: async (digest) => {
        const text = await readStoredValueText(digest);
        if (text === null) throw new Error(`Stored transport blob is missing: ${digest}`);
        return text;
      },
    });

  // Convert MethodDefinitions to MethodAdvertisements
  function toMethodAdvertisements(
    methods: Record<string, MethodDefinitionLike>
  ): MethodAdvertisement[] {
    return Object.entries(methods)
      .filter(([, def]) => !def.internal)
      .map(([methodName, def]) => {
        const parameters =
          def.parameters && typeof def.parameters === "object" && !("_def" in def.parameters)
            ? (def.parameters as JsonSchema)
            : methodJsonSchema(def.parameters as z.ZodTypeAny);
        const returns = def.returns
          ? def.returns && typeof def.returns === "object" && !("_def" in def.returns)
            ? (def.returns as JsonSchema)
            : methodJsonSchema(def.returns as z.ZodTypeAny)
          : undefined;
        assertValidMethodSchema(methodName, "parameters", parameters);
        if (returns) assertValidMethodSchema(methodName, "returns", returns);
        return {
          name: methodName,
          description: def.description,
          parameters,
          returns,
          streaming: def.streaming,
          menu: def.menu,
        };
      });
  }

  const methodAdvertisements =
    providedMethods && Object.keys(providedMethods).length > 0
      ? toMethodAdvertisements(providedMethods)
      : undefined;

  // State
  let closed = false;
  let serverContextId: string | undefined;
  let serverChannelConfig: ChannelConfig | undefined;
  let serverTotalCount: number | undefined;
  let serverEnvelopeCount: number | undefined;
  let serverFirstEnvelopeSeq: number | undefined;
  let serverHasMoreBefore: boolean | undefined;
  let currentRoster: Record<string, Participant<T>> = {};
  let streamedReplayLogEvents: ServerLogEvent[] = [];
  let streamedReplaySnapshots: BootstrapSnapshot[] = [];

  // Ready promise
  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  readyPromise.catch((err) => {
    if (closed) return;
    console.warn("[PubSubClient] Ready promise rejected:", err);
  });
  let subscribeAckResolve: (() => void) | null = null;
  let subscribeAckReject: ((error: Error) => void) | null = null;
  const subscribeAckPromise = new Promise<void>((resolve, reject) => {
    subscribeAckResolve = resolve;
    subscribeAckReject = reject;
  });
  subscribeAckPromise.catch(() => {});

  function resolveReady(): void {
    readyResolve?.();
    readyResolve = null;
    readyReject = null;
  }

  function rejectReady(error: Error): void {
    readyReject?.(error);
    readyResolve = null;
    readyReject = null;
  }

  // Handler sets
  const errorHandlers = new Set<(error: Error) => void>();
  const disconnectHandlers = new Set<() => void>();
  const reconnectHandlers = new Set<() => void>();
  const readyHandlers = new Set<() => void>();
  const rosterHandlers = new Set<(roster: RosterUpdate<T>) => void>();
  const configChangeHandlers = new Set<(config: ChannelConfig) => void>();

  // Events fanout
  const eventsFanout = createFanout<IncomingEvent>();

  // Replay buffering
  let bufferingReplay = replayMode !== "skip";
  let replayComplete = false;
  let emitRecoveryReplay = false;
  let replayCatchupPromise: Promise<void> | null = null;
  const replayEvents: IncomingEvent[] = [];
  const replayLiveBuffer: ClientIngressMessage[] = [];
  const replayMessageKeys = new Set<string>();
  const MAX_REPLAY_MESSAGE_KEYS = 2000;

  // Roster dedup
  const rosterOpIds = new Set<number>();
  const MAX_ROSTER_OP_IDS = 1000;

  // Method auto-execution
  const registeredMethods: Record<string, MethodDefinitionLike> = {
    ...(providedMethods ?? {}),
  };

  // Track AbortControllers (+ start time) for methods we're executing, keyed by callId. When a caller
  // cancels, we abort the controller so the handler sees signal.aborted; duplicate durable delivery
  // is ignored while the exact call is already running.
  const executingMethods = new Map<string, { controller: AbortController; startedAt: number }>();
  // Admission begins before the channel claim RPC. Without this reservation,
  // a resubscription delivery can replace the first claim and then be dropped
  // locally as a duplicate, fencing out the only running execution's result.
  const admittingMethods = new Map<string, number>();
  // Cancellation is allowed to arrive before the provider claim round-trip
  // returns (and direct cancellation can precede mailbox start delivery). Keep
  // that terminal intent long enough to fence every delayed/duplicate start.
  const cancelledMethodTransportCallIds = new Set<string>();
  const providerInstanceId = crypto.randomUUID();
  // A duplicate is worth logging only when the existing handler looks genuinely wedged.
  const STILL_EXECUTING_WARN_MS = 30_000;
  const submittedMethodTransportCallIds = new Set<string>();
  const MAX_SUBMITTED_METHOD_TRANSPORT_CALL_IDS = 2000;

  function rememberCancelledMethodTransportCall(transportCallId: string): void {
    cancelledMethodTransportCallIds.add(transportCallId);
    if (cancelledMethodTransportCallIds.size <= MAX_SUBMITTED_METHOD_TRANSPORT_CALL_IDS) return;
    const overflow = cancelledMethodTransportCallIds.size - MAX_SUBMITTED_METHOD_TRANSPORT_CALL_IDS;
    const iter = cancelledMethodTransportCallIds.values();
    for (let i = 0; i < overflow; i++) {
      const { value } = iter.next();
      if (value !== undefined) cancelledMethodTransportCallIds.delete(value);
    }
  }

  function rememberSubmittedMethodTransportCall(transportCallId: string): void {
    submittedMethodTransportCallIds.add(transportCallId);
    if (submittedMethodTransportCallIds.size <= MAX_SUBMITTED_METHOD_TRANSPORT_CALL_IDS) return;
    const overflow = submittedMethodTransportCallIds.size - MAX_SUBMITTED_METHOD_TRANSPORT_CALL_IDS;
    const iter = submittedMethodTransportCallIds.values();
    for (let i = 0; i < overflow; i++) {
      const { value } = iter.next();
      if (value !== undefined) submittedMethodTransportCallIds.delete(value);
    }
  }

  // Method call tracking
  interface MethodCallState {
    readonly callId: string;
    readonly invocationId: string;
    readonly transportCallId: string;
    readonly stream: ReturnType<typeof createFanout<MethodResultChunk>>;
    readonly resolve: (value: MethodResultValue) => void;
    readonly reject: (error: Error) => void;
    complete: boolean;
    isError: boolean;
  }
  const methodCallStates = new Map<string, MethodCallState>();
  function deleteMethodCallState(state: MethodCallState): void {
    for (const [key, candidate] of methodCallStates) {
      if (candidate === state) methodCallStates.delete(key);
    }
  }
  const methodResultChains = new Map<string, Promise<void>>();

  function handleError(error: PubSubError): void {
    for (const handler of errorHandlers) handler(error);
  }

  function normalizeSenderMetadata(
    meta: Record<string, unknown> | undefined
  ): { name?: string; type?: string; handle?: string } | undefined {
    if (!meta) return undefined;
    const result: { name?: string; type?: string; handle?: string } = {};
    if (typeof meta["name"] === "string") result.name = meta["name"] as string;
    if (typeof meta["type"] === "string") result.type = meta["type"] as string;
    if (typeof meta["handle"] === "string") result.handle = meta["handle"] as string;
    return Object.keys(result).length > 0 ? result : undefined;
  }

  function parseIncoming(pubsubMsg: PubSubMessage): IncomingEvent | null {
    const {
      type: msgType,
      payload,
      attachments: msgAttachments,
      senderId,
      ts,
      delivery,
      phase,
      id: pubsubId,
      senderMetadata,
      contentClass,
      externalKeys,
    } = pubsubMsg;
    const normalizedSender = normalizeSenderMetadata(senderMetadata);

    if (msgType === "error") {
      const parsed = ErrorMessageSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        type: "error",
        delivery,
        phase,
        senderId,
        ts,
        attachments: msgAttachments,
        pubsubId,
        senderMetadata: normalizedSender,
        id: parsed.data.id,
        error: parsed.data.error,
        code: parsed.data.code,
      } as IncomingErrorMessage;
    }

    if (msgType === "signal") {
      const parsed = SignalMessageSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        type: "signal",
        delivery,
        phase,
        senderId,
        ts,
        attachments: msgAttachments,
        pubsubId,
        senderMetadata: normalizedSender,
        content: parsed.data.content,
        contentType: parsed.data.contentType,
      } as IncomingSignalEvent;
    }

    if (msgType === AGENTIC_EVENT_PAYLOAD_KIND) {
      const event = payload as AgenticEvent | undefined;
      if (!event || typeof event !== "object") return null;
      return {
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        delivery,
        phase,
        senderId,
        ts,
        attachments: msgAttachments,
        pubsubId,
        senderMetadata: normalizedSender,
        contentClass,
        externalKeys,
        payload: event,
      } as IncomingAgenticEvent;
    }

    if (msgType === CREDENTIAL_CONNECT_PAYLOAD_KIND) {
      if (!payload || typeof payload !== "object") return null;
      return {
        type: CREDENTIAL_CONNECT_PAYLOAD_KIND,
        delivery,
        phase,
        senderId,
        ts,
        attachments: msgAttachments,
        pubsubId,
        senderMetadata: normalizedSender,
        payload,
      } as IncomingEvent;
    }

    if (msgType === "presence") {
      const presencePayload = payload as {
        action?: string;
        metadata?: Record<string, unknown>;
        leaveReason?: string;
      };
      if (!presencePayload.action || !presencePayload.metadata) return null;
      return {
        type: "presence",
        delivery,
        phase,
        senderId,
        ts,
        pubsubId,
        senderMetadata: normalizedSender,
        action: presencePayload.action,
        leaveReason: presencePayload.leaveReason,
        metadata: presencePayload.metadata,
      } as IncomingPresenceEventWithType;
    }

    if (msgType === "agent-debug") {
      return {
        type: "agent-debug",
        delivery,
        phase,
        senderId,
        ts,
        pubsubId,
        senderMetadata: normalizedSender,
        payload,
      } as unknown as IncomingAgentDebugEvent;
    }

    return null;
  }

  function invocationCallFromAgenticEvent(
    event: IncomingAgenticEvent
  ): IncomingInvocationCallEvent | null {
    const payload = event.payload;
    if (payload.kind !== "invocation.started") return null;
    const invocationId = payload.causality?.invocationId;
    if (typeof invocationId !== "string" || invocationId.length === 0) return null;
    const invocationPayload = (payload as AgenticEvent<"invocation.started">).payload;
    if (!("name" in invocationPayload)) return null;
    const transport = invocationPayload.transport;
    if (!transport || transport.kind !== "channel") return null;
    const transportCallId =
      transport.transportCallId ?? payload.causality?.transportCallId ?? invocationId;
    const providerId = transport.target.participantId ?? transport.target.id;
    return {
      type: "invocation-call",
      delivery: event.delivery,
      phase: event.phase,
      senderId: event.senderId,
      ts: event.ts,
      pubsubId: event.pubsubId,
      senderMetadata: event.senderMetadata,
      callId: transportCallId,
      invocationId,
      transportCallId,
      turnId: payload.turnId,
      methodName: invocationPayload.name,
      providerId,
      args: invocationPayload.request,
      ...(typeof (transport as { deadlineAt?: unknown }).deadlineAt === "number"
        ? { deadlineAt: (transport as { deadlineAt: number }).deadlineAt }
        : {}),
    } as IncomingInvocationCallEvent;
  }

  function replayDedupeKey(msg: ClientIngressMessage): string | null {
    if (msg.stream !== "log" || msg.phase !== "replay") return null;
    if (msg.id !== undefined) {
      return `${msg.id}:${msg.type ?? ""}:${msg.senderId ?? ""}`;
    }
    if (msg.type === "presence" && msg.senderId) {
      return `snapshot:${msg.type}:${msg.senderId}`;
    }
    return null;
  }

  function replayMessageWasHandled(msg: ClientIngressMessage): boolean {
    const key = replayDedupeKey(msg);
    return key !== null && replayMessageKeys.has(key);
  }

  function rememberReplayMessage(msg: ClientIngressMessage): void {
    const key = replayDedupeKey(msg);
    if (!key) return;
    replayMessageKeys.add(key);
    if (replayMessageKeys.size > MAX_REPLAY_MESSAGE_KEYS) {
      const toRemove = replayMessageKeys.size - (MAX_REPLAY_MESSAGE_KEYS - 400);
      const iter = replayMessageKeys.values();
      for (let i = 0; i < toRemove; i++) {
        const { value } = iter.next();
        if (value !== undefined) replayMessageKeys.delete(value);
      }
    }
  }

  async function handleServerMessage(
    msg: ClientIngressMessage,
    providerSubscriptionGeneration?: number
  ): Promise<void> {
    if (replayMessageWasHandled(msg)) return;

    if (msg.stream === "log" && msg.type === AGENTIC_EVENT_PAYLOAD_KIND) {
      if (
        (msg.contentClass !== "internal" && msg.contentClass !== "external") ||
        !Array.isArray(msg.externalKeys) ||
        !msg.externalKeys.every((key) => typeof key === "string") ||
        (msg.contentClass === "internal" && msg.externalKeys.length > 0)
      ) {
        throw Object.assign(
          new Error("Agentic channel event is missing sealed content provenance"),
          { code: "PermanentChannelDelivery" }
        );
      }
      try {
        msg = {
          ...msg,
          payload: await hydrateStoredTransportValue(msg.payload),
        };
      } catch (error) {
        if (error instanceof Error && /Stored transport blob is missing/.test(error.message)) {
          throw Object.assign(error, { code: "PermanentChannelDelivery" });
        }
        throw error;
      }
    }

    switch (msg.stream) {
      case "control": {
        if (msg.controlType !== "ready") break;
        if (typeof msg.contextId === "string") serverContextId = msg.contextId;
        if (msg.channelConfig) serverChannelConfig = msg.channelConfig;
        if (typeof msg.totalCount === "number") serverTotalCount = msg.totalCount;
        if (typeof msg.envelopeCount === "number") serverEnvelopeCount = msg.envelopeCount;
        if (typeof msg.firstEnvelopeSeq === "number") {
          serverFirstEnvelopeSeq = msg.firstEnvelopeSeq;
        } else {
          serverFirstEnvelopeSeq = undefined;
        }
        serverHasMoreBefore =
          typeof msg.hasMoreBefore === "boolean" ? msg.hasMoreBefore : undefined;

        if (replayComplete) {
          break;
        }

        bufferingReplay = false;
        replayComplete = true;
        emitRecoveryReplay = false;

        resolveReady();
        for (const handler of readyHandlers) handler();
        break;
      }

      case "error": {
        const errorMsg = msg.error || "unknown server error";
        const error = new PubSubError(errorMsg, "server");
        if (!replayComplete) rejectReady(error);
        handleError(error);
        break;
      }

      case "log":
      case "signal": {
        if (msg.id !== undefined && msg.id > 0) {
          lastSeenSeq = Math.max(lastSeenSeq ?? 0, msg.id);
        }

        // Method lifecycle (caller settle / provider abort) runs first, before
        // the replayMode:skip short-circuit — a cold reconnect must still settle
        // in-flight calls from replayed invocation.* events.
        if (msg.stream === "log" && msg.type === AGENTIC_EVENT_PAYLOAD_KIND) {
          handleInvocationLifecycle(msg.payload, convertWireAttachments(msg.attachments));
        }

        if (msg.stream === "log" && msg.phase === "replay" && replayMode === "skip") {
          break;
        }

        const isPresence = msg.type === "presence";
        if (msg.type === "config-update" && msg.payload && typeof msg.payload === "object") {
          serverChannelConfig = msg.payload as ChannelConfig;
          for (const handler of configChangeHandlers) handler(serverChannelConfig);
        }

        // Roster dedup
        if (isPresence && msg.id !== undefined) {
          if (rosterOpIds.has(msg.id)) {
            rememberReplayMessage(msg);
            return;
          }
          rosterOpIds.add(msg.id);
          if (rosterOpIds.size > MAX_ROSTER_OP_IDS) {
            const toRemove = rosterOpIds.size - (MAX_ROSTER_OP_IDS - 200);
            const iter = rosterOpIds.values();
            for (let i = 0; i < toRemove; i++) {
              const { value } = iter.next();
              if (value !== undefined) rosterOpIds.delete(value);
            }
          }
        }

        if (isPresence) {
          const payload = msg.payload as PresencePayload;
          const presenceAction = payload?.action;

          if (presenceAction === "join" || presenceAction === "update") {
            if (payload?.metadata && payload.ref) {
              currentRoster = {
                ...currentRoster,
                [msg.senderId!]: {
                  id: msg.senderId!,
                  ref: payload.ref,
                  metadata: payload.metadata as T,
                },
              };
            }
          } else if (presenceAction === "leave") {
            const { [msg.senderId!]: _removed, ...rest } = currentRoster;
            currentRoster = rest;
          }

          if (presenceAction) {
            const rosterUpdate: RosterUpdate<T> = {
              participants: currentRoster,
              ts: msg.ts ?? Date.now(),
              change: {
                type: presenceAction,
                participantId: msg.senderId!,
                metadata: payload?.metadata,
                ...(presenceAction === "leave" &&
                  payload?.leaveReason && { leaveReason: payload.leaveReason }),
              },
              ...(presenceAction === "leave" &&
                msg.senderId && {
                  leaves: {
                    [msg.senderId]: { leaveReason: payload?.leaveReason },
                  },
                }),
            };
            for (const handler of rosterHandlers) handler(rosterUpdate);
          }
        }

        // Build PubSubMessage for events infrastructure.
        // Convert wire-format attachments (base64) to client format (Uint8Array).
        const pubsubMsg: PubSubMessage = {
          delivery: msg.stream,
          phase: msg.phase,
          id: msg.id,
          type: msg.type!,
          payload: msg.payload,
          senderId: msg.senderId!,
          ts: msg.ts!,
          attachments: convertWireAttachments(msg.attachments),
          senderMetadata: msg.senderMetadata,
          contentClass: msg.contentClass,
          externalKeys: msg.externalKeys,
        };

        const event = parseIncoming(pubsubMsg);
        if (event) {
          if (opts.deliveryMode === "resident" && opts.residentEventHandler) {
            await opts.residentEventHandler(event);
          }
          const invocationCallEvent =
            event.type === AGENTIC_EVENT_PAYLOAD_KIND
              ? invocationCallFromAgenticEvent(event)
              : null;

          // Auto-execute method calls targeting this client
          if (invocationCallEvent && event.phase !== "replay") {
            // Provider admission is its own durable operation. A transient
            // claim RPC must not terminate or head-of-line block the channel
            // response reader; the exact invocation coordinates are redriven
            // independently below.
            void beginMethodCallExec(invocationCallEvent, providerSubscriptionGeneration);
          }

          // Buffer replay events until the initial ready boundary. If ready was
          // resolved from the subscribe acknowledgment because the ready event
          // was not delivered, late replay events are surfaced directly instead
          // of being stranded in a replay buffer with no future ready boundary.
          if (event.phase === "replay") {
            if (replayComplete) {
              if (replayMode !== "skip") replayEvents.push(event);
              eventsFanout.emit(event);
            } else if (replayMode !== "skip") {
              if (!bufferingReplay) {
                bufferingReplay = true;
              }
              replayEvents.push(event);
              if (emitRecoveryReplay) eventsFanout.emit(event);
            }
          } else {
            // Emit live events
            eventsFanout.emit(event);
          }
        }

        break;
      }
    }
    // A replay key acknowledges completed processing. Registering it before
    // hydration/handlers would turn a transient throw into permanent loss on
    // the next attempt.
    rememberReplayMessage(msg);
  }

  function applyRosterSnapshot(snapshot: BootstrapSnapshot): void {
    if (snapshot.kind !== "roster-snapshot") return;
    currentRoster = {};
    for (const participant of snapshot.participants) {
      currentRoster[participant.id] = {
        id: participant.id,
        ref: participant.ref,
        metadata: participant.metadata as T,
      };
    }
    for (const handler of rosterHandlers) {
      handler({ participants: currentRoster, ts: snapshot.ts });
    }
  }

  async function applyReceiptSnapshot(snapshot: BootstrapSnapshot): Promise<void> {
    if (snapshot.kind !== "receipt-snapshot") return;
    for (const event of snapshot.events) {
      await handleServerMessage(eventToClientIngress(event, "replay"));
    }
  }

  async function ingestReplayEnvelope(
    envelope: ChannelReplayEnvelope,
    _source: "stream" | "ack"
  ): Promise<void> {
    if (replayComplete) return;
    if (replayCatchupPromise) return replayCatchupPromise;
    replayCatchupPromise = (async () => {
      const ingestPage = async (page: ChannelReplayEnvelope): Promise<void> => {
        if (replayMode !== "skip") {
          for (const event of page.logEvents) {
            await handleServerMessage(eventToClientIngress(event, "replay"));
          }
          for (const snapshot of page.snapshots) {
            applyRosterSnapshot(snapshot);
            await applyReceiptSnapshot(snapshot);
          }
        } else {
          // Skip drops user-facing replay, but still settles in-flight method
          // calls from replayed invocation lifecycle events.
          for (const event of page.logEvents) {
            if (isInvocationLifecycleEvent(event)) {
              await handleServerMessage(eventToClientIngress(event, "replay"));
            }
          }
        }
      };

      await ingestPage(envelope);
      let terminalPage = envelope;
      if (envelope.mode === "after" && envelope.ready.hasMoreAfter) {
        const after = envelope.ready.replayToId;
        const throughSeq = envelope.ready.snapshotLastSeq;
        if (after === undefined || throughSeq === undefined) {
          throw new Error("subscription replay claims more history without a stable cursor");
        }
        await forEachReplayAfterPage({ after, throughSeq }, async (page) => {
          terminalPage = page;
          await ingestPage(page);
        });
      }

      await handleServerMessage({
        stream: "control",
        controlType: "ready",
        contextId: terminalPage.ready.contextId ?? envelope.ready.contextId,
        channelConfig: terminalPage.ready.channelConfig ?? envelope.ready.channelConfig,
        totalCount: terminalPage.ready.totalCount,
        envelopeCount: terminalPage.ready.envelopeCount,
        firstEnvelopeSeq: terminalPage.ready.firstEnvelopeSeq,
        hasMoreBefore: envelope.ready.hasMoreBefore,
      });
      streamedReplayLogEvents = [];
      streamedReplaySnapshots = [];
      const buffered = replayLiveBuffer.splice(0);
      for (const message of buffered) await handleServerMessage(message);
    })();
    try {
      await replayCatchupPromise;
    } finally {
      replayCatchupPromise = null;
    }
  }

  async function applySubscribeAckFallback(result: SubscribeResult | undefined): Promise<void> {
    if (result?.participantId) pid = result.participantId;
    if (!result?.envelope || replayComplete) return;
    await ingestReplayEnvelope(result.envelope, "ack");
  }

  /** True for the durable method-lifecycle events the channel emits. */
  function isInvocationLifecycleEvent(event: ServerLogEvent): boolean {
    if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) return false;
    const kind = (event.payload as { kind?: string } | undefined)?.kind;
    return (
      kind === "invocation.output" ||
      kind === "invocation.completed" ||
      kind === "invocation.failed" ||
      kind === "invocation.cancelled" ||
      kind === "invocation.abandoned"
    );
  }

  /**
   * Settle a pending `callMethod` (caller role) or abort an executing method
   * (provider role) from a durable `invocation.*` log event. This replaces the
   * removed method-`*` wire transports. The feedback-cancel UX is handled
   * separately by observing `invocation.cancelled` on the events stream (see
   * useChatFeedback).
   */
  function handleInvocationLifecycle(
    payload: unknown,
    attachments: Attachment[] | undefined
  ): void {
    const ev = payload as
      | {
          kind?: string;
          causality?: { invocationId?: string; transportCallId?: string };
          payload?: Record<string, unknown>;
        }
      | undefined;
    if (!ev || typeof ev !== "object") return;
    const kind = ev.kind;
    const callId =
      (ev.causality?.transportCallId && methodCallStates.has(ev.causality.transportCallId)
        ? ev.causality.transportCallId
        : ev.causality?.invocationId) ?? ev.causality?.transportCallId;
    if (!callId) return;
    const body = ev.payload ?? {};

    // Caller: settle / stream a pending callMethod.
    if (methodCallStates.has(callId)) {
      if (kind === "invocation.output") {
        void enqueueMethodResultChunk({
          callId,
          content: body["output"],
          complete: false,
          isError: false,
          ...(attachments ? { attachments } : {}),
        });
      } else if (
        kind === "invocation.completed" ||
        kind === "invocation.failed" ||
        kind === "invocation.cancelled" ||
        kind === "invocation.abandoned"
      ) {
        const isError = kind !== "invocation.completed";
        const content = isError ? (body["error"] ?? body["reason"]) : body["result"];
        void enqueueMethodResultChunk({
          callId,
          content,
          complete: true,
          isError,
          ...(attachments ? { attachments } : {}),
        });
      }
    }

    // Provider: abort the executing method on cancel/abandon (completion facts
    // are not abort commands). Methods that ignore ctx.signal (e.g. feedback)
    // are resolved by their own observation of invocation.cancelled.
    // Execution state is keyed by transportCallId; the caller-oriented callId
    // above may have resolved to invocationId when no caller state exists —
    // which is exactly the provider case.
    const providerCallId = ev.causality?.transportCallId ?? callId;
    if (
      (kind === "invocation.cancelled" || kind === "invocation.abandoned") &&
      executingMethods.has(providerCallId)
    ) {
      abortExecutingMethod(providerCallId);
    }
  }

  async function applyMethodResultChunk(result: {
    callId: string;
    content: unknown;
    complete: boolean;
    isError: boolean;
    attachments?: Attachment[];
  }): Promise<void> {
    const state = methodCallStates.get(result.callId);
    if (!state) return;

    let content: unknown;
    try {
      content = await hydrateStoredTransportValue(result.content);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      state.complete = true;
      state.isError = true;
      state.stream.close(error);
      state.reject(new AgenticError(error.message, "execution-error", error));
      deleteMethodCallState(state);
      return;
    }

    const chunk: MethodResultChunk = {
      content,
      ...(result.attachments ? { attachments: result.attachments } : {}),
      complete: result.complete,
      isError: result.isError,
    };

    state.stream.emit(chunk);

    if (!chunk.complete) return;

    state.complete = true;
    state.isError = chunk.isError;
    state.stream.close();

    if (chunk.isError) {
      const content = chunk.content;
      let errorMsg = "method execution failed";
      if (
        content &&
        typeof content === "object" &&
        typeof (content as Record<string, unknown>)["error"] === "string"
      ) {
        errorMsg = (content as Record<string, unknown>)["error"] as string;
      } else if (typeof content === "string" && content.length > 0) {
        errorMsg = content;
      }
      state.reject(new AgenticError(errorMsg, "execution-error", content));
    } else {
      state.resolve({
        content: chunk.content,
        ...(chunk.attachments ? { attachments: chunk.attachments } : {}),
      });
    }
    deleteMethodCallState(state);
  }

  function enqueueMethodResultChunk(
    result: Parameters<typeof applyMethodResultChunk>[0]
  ): Promise<void> {
    const previous = methodResultChains.get(result.callId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => applyMethodResultChunk(result));
    methodResultChains.set(result.callId, next);
    void next
      .catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        console.warn(
          `[PubSubClient] Failed to apply method result chunk for ${result.callId}:`,
          error
        );
      })
      .finally(() => {
        if (methodResultChains.get(result.callId) === next) {
          methodResultChains.delete(result.callId);
        }
      });
    return next;
  }

  async function submitMethodResult(
    invocationId: string,
    transportCallId: string,
    content: unknown,
    isError: boolean,
    opts?: {
      callerId?: string;
      turnId?: string;
      terminalOutcome?: string;
      terminalReasonCode?: string;
      attachments?: AttachmentInput[];
      providerClaimGeneration?: number;
    }
  ): Promise<boolean> {
    if (!pid) {
      throw new Error(
        `Cannot submit result for invocation ${invocationId}: pubsub client is disconnected`
      );
    }
    const response = await callChannel<{ id?: number } | undefined>(
      "submitMethodResult",
      pid,
      transportCallId,
      content,
      isError,
      {
        invocationId,
        ...(opts?.callerId ? { callerId: opts.callerId } : {}),
        ...(opts?.turnId ? { turnId: opts.turnId } : {}),
        ...(opts?.terminalOutcome ? { terminalOutcome: opts.terminalOutcome } : {}),
        ...(opts?.terminalReasonCode ? { terminalReasonCode: opts.terminalReasonCode } : {}),
        ...(opts?.attachments ? { attachments: toStoredAttachments(opts.attachments) } : {}),
        ...(opts?.providerClaimGeneration
          ? { providerClaimGeneration: opts.providerClaimGeneration }
          : {}),
      }
    );
    return typeof response?.id === "number";
  }

  async function submitMethodProgress(
    invocationId: string,
    transportCallId: string,
    content: unknown,
    opts?: {
      turnId?: string;
      attachments?: AttachmentInput[];
      providerClaimGeneration?: number;
    }
  ): Promise<void> {
    if (!pid) {
      throw new Error(
        `Cannot submit progress for invocation ${invocationId}: pubsub client is disconnected`
      );
    }
    await callChannel("submitMethodProgress", pid, transportCallId, content, {
      invocationId,
      ...(opts?.turnId ? { turnId: opts.turnId } : {}),
      ...(opts?.attachments ? { attachments: toStoredAttachments(opts.attachments) } : {}),
      ...(opts?.providerClaimGeneration
        ? { providerClaimGeneration: opts.providerClaimGeneration }
        : {}),
    });
  }

  async function beginMethodCallExec(
    event: IncomingInvocationCallEvent,
    subscriptionGeneration?: number
  ): Promise<void> {
    if (
      !pid ||
      event.providerId !== pid ||
      closed ||
      cancelledMethodTransportCallIds.has(event.transportCallId)
    ) {
      return;
    }
    const existingStartedAt =
      executingMethods.get(event.transportCallId)?.startedAt ??
      admittingMethods.get(event.transportCallId);
    if (
      existingStartedAt !== undefined ||
      submittedMethodTransportCallIds.has(event.transportCallId)
    ) {
      if (
        existingStartedAt !== undefined &&
        Date.now() - existingStartedAt > STILL_EXECUTING_WARN_MS
      ) {
        console.warn(
          `[PubSub] Method ${event.methodName} (${event.transportCallId}) still executing after ` +
            `${Math.round((Date.now() - existingStartedAt) / 1000)}s — possible hung handler; ` +
            `skipping duplicate delivery`
        );
      }
      return;
    }

    admittingMethods.set(event.transportCallId, Date.now());
    let executionOwnsReservation = false;
    try {
      let failures = 0;
      while (
        !closed &&
        !cancelledMethodTransportCallIds.has(event.transportCallId) &&
        admittingMethods.has(event.transportCallId)
      ) {
        let claim: { claimed: boolean; generation?: number };
        try {
          claim = await callChannel<{ claimed: boolean; generation?: number }>(
            "claimMethodCall",
            pid,
            event.transportCallId,
            `${providerInstanceId}:${subscriptionGeneration ?? 0}`
          );
        } catch (error) {
          const failure = toPubSubError(error, "connection");
          handleError(failure);
          if (!isAmbiguousMethodStartFailure(error)) return;
          const delayMs = Math.min(
            METHOD_START_REDRIVE_BASE_DELAY_MS * 2 ** Math.min(failures, 6),
            METHOD_START_REDRIVE_MAX_DELAY_MS
          );
          failures += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        if (!claim.claimed || !claim.generation) return;
        if (closed || cancelledMethodTransportCallIds.has(event.transportCallId)) return;
        executionOwnsReservation = true;
        void handleMethodCallExec(event, claim.generation)
          .catch((err) => console.error(`[RpcPubSubClient] Method execution failed:`, err))
          .finally(() => admittingMethods.delete(event.transportCallId));
        return;
      }
    } finally {
      // Once execution starts, handleMethodCallExec owns this reservation
      // until its terminal path. Otherwise release it for future delivery.
      if (!executionOwnsReservation) {
        admittingMethods.delete(event.transportCallId);
      }
    }
  }

  async function handleMethodCallExec(
    event: IncomingInvocationCallEvent,
    providerClaimGeneration: number
  ): Promise<void> {
    if (!pid || event.providerId !== pid) return;

    // Single-clock discipline (CH-3): only a journaled deadlineAt can impose
    // a call lifetime. Calls without a deadline can legitimately wait on a
    // human or a long-running agentic continuation.
    const remainingMs = typeof event.deadlineAt === "number" ? event.deadlineAt - Date.now() : null;
    if (remainingMs !== null && remainingMs <= 1_000) {
      // Redelivered at/after its deadline: executing now can't beat the
      // channel's own expiry; let the channel settle it.
      console.warn(
        `[PubSub] Skipping method call ${event.methodName} (${event.transportCallId}): ` +
          `journaled deadline already ${remainingMs <= 0 ? "passed" : "imminent"}`
      );
      admittingMethods.delete(event.transportCallId);
      return;
    }

    const abortController = new AbortController();
    const executionMark = await callChannel<{ accepted: boolean }>(
      "markMethodCallExecutionStarted",
      pid,
      event.transportCallId,
      providerClaimGeneration
    );
    if (!executionMark.accepted) return;
    if (
      closed ||
      abortController.signal.aborted ||
      cancelledMethodTransportCallIds.has(event.transportCallId)
    ) {
      return;
    }
    executingMethods.set(event.transportCallId, {
      controller: abortController,
      startedAt: Date.now(),
    });
    const methodDef = registeredMethods[event.methodName];
    if (!methodDef) {
      try {
        const accepted = await submitMethodResult(
          event.invocationId,
          event.transportCallId,
          `Method "${event.methodName}" not registered on this client`,
          true,
          {
            callerId: event.senderId,
            turnId: event.turnId,
            terminalOutcome: "tool_error",
            terminalReasonCode: "method_not_registered",
            providerClaimGeneration,
          }
        );
        if (accepted) rememberSubmittedMethodTransportCall(event.transportCallId);
      } catch {
        /* best effort */
      } finally {
        executingMethods.delete(event.transportCallId);
      }
      return;
    }
    let terminalSubmitted = false;
    const pendingStreamSubmissions = new Set<Promise<void>>();
    const trackStreamSubmission = (promise: Promise<void>): Promise<void> => {
      pendingStreamSubmissions.add(promise);
      void promise.catch(() => undefined).finally(() => pendingStreamSubmissions.delete(promise));
      return promise;
    };
    const drainStreamSubmissions = async (): Promise<void> => {
      while (pendingStreamSubmissions.size > 0) {
        const batch = [...pendingStreamSubmissions];
        const results = await Promise.allSettled(batch);
        for (const result of results) {
          if (result.status === "rejected") {
            console.warn(
              `[PubSub] Failed to submit method progress for ${event.methodName} ` +
                `(${event.transportCallId}):`,
              result.reason
            );
          }
        }
      }
    };
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    if (remainingMs !== null) {
      watchdog = setTimeout(() => {
        if (terminalSubmitted) return;
        console.warn(
          `[PubSub] Method ${event.methodName} (${event.transportCallId}) did not settle ` +
            `before its journaled deadline — aborting and reporting timeout to the channel`
        );
        abortController.abort();
        void submitMethodResult(
          event.invocationId,
          event.transportCallId,
          `Method "${event.methodName}" reached its journaled deadline`,
          true,
          {
            callerId: event.senderId,
            turnId: event.turnId,
            terminalOutcome: "tool_error",
            terminalReasonCode: "method_execution_timeout",
            providerClaimGeneration,
          }
        )
          .then((accepted) => {
            terminalSubmitted = accepted;
            if (accepted) rememberSubmittedMethodTransportCall(event.transportCallId);
          })
          .catch((e) =>
            console.error(
              `[PubSub] Failed to submit watchdog timeout for ${event.methodName} ` +
                `(${event.transportCallId}); the channel deadline remains authoritative:`,
              e
            )
          )
          .finally(() => {
            executingMethods.delete(event.transportCallId);
          });
      }, remainingMs);
    }
    const ctx: MethodExecutionContext = {
      callId: event.callId,
      invocationId: event.invocationId,
      transportCallId: event.transportCallId,
      callerId: event.senderId,
      signal: abortController.signal,
      stream: async (content: unknown) => {
        await trackStreamSubmission(
          submitMethodProgress(event.invocationId, event.transportCallId, content, {
            turnId: event.turnId,
            providerClaimGeneration,
          })
        );
      },
      streamWithAttachments: async (content: unknown, attachments: AttachmentInput[]) => {
        await trackStreamSubmission(
          submitMethodProgress(event.invocationId, event.transportCallId, content, {
            turnId: event.turnId,
            attachments,
            providerClaimGeneration,
          })
        );
      },
      resultWithAttachments: <R>(content: R, attachments: AttachmentInput[]) => ({
        content,
        attachments,
      }),
    };

    try {
      let args = await hydrateStoredTransportValue(event.args);
      if (methodDef.parameters && "_def" in methodDef.parameters) {
        args = (methodDef.parameters as z.ZodTypeAny).parse(args);
      }

      // Argument hydration may cross an external blob boundary. Cancellation
      // received during that await is terminal intent, so never enter the
      // provider after it, even if the provider ignores AbortSignal.
      if (
        closed ||
        abortController.signal.aborted ||
        cancelledMethodTransportCallIds.has(event.transportCallId)
      ) {
        return;
      }

      const result = await methodDef.execute(args, ctx);
      await drainStreamSubmissions();
      if (abortController.signal.aborted) {
        terminalSubmitted = await submitMethodResult(
          event.invocationId,
          event.transportCallId,
          "cancelled",
          true,
          {
            callerId: event.senderId,
            turnId: event.turnId,
            terminalOutcome: "cancelled",
            terminalReasonCode: "cancelled",
            providerClaimGeneration,
          }
        );
        return;
      }

      if (
        result &&
        typeof result === "object" &&
        "attachments" in (result as Record<string, unknown>) &&
        "content" in (result as Record<string, unknown>)
      ) {
        const withAttachments = result as {
          content: unknown;
          attachments: AttachmentInput[];
        };
        terminalSubmitted = await submitMethodResult(
          event.invocationId,
          event.transportCallId,
          withAttachments.content,
          false,
          {
            callerId: event.senderId,
            turnId: event.turnId,
            attachments: withAttachments.attachments,
            providerClaimGeneration,
          }
        );
      } else {
        terminalSubmitted = await submitMethodResult(
          event.invocationId,
          event.transportCallId,
          result,
          false,
          {
            callerId: event.senderId,
            turnId: event.turnId,
            providerClaimGeneration,
          }
        );
      }
    } catch (err) {
      await drainStreamSubmissions();
      const errorMsg = err instanceof Error ? err.message : String(err);
      const aborted = abortController.signal.aborted;
      await submitMethodResult(
        event.invocationId,
        event.transportCallId,
        errorMsg || (aborted ? "cancelled" : "method execution failed"),
        true,
        {
          callerId: event.senderId,
          turnId: event.turnId,
          terminalOutcome: aborted ? "cancelled" : "tool_error",
          terminalReasonCode: aborted ? "cancelled" : "eval_exception",
          providerClaimGeneration,
        }
      )
        .then((accepted) => {
          terminalSubmitted = accepted;
        })
        .catch((e) =>
          // If even this fallback terminal cannot be submitted, the caller's
          // pending call would be stranded. The channel settles it on its side
          // when the event is malformed; log with enough context to trace a
          // transport-level failure here.
          console.error(
            `[PubSub] Failed to publish auto-execution error for ` +
              `method=${event.methodName} transportCallId=${event.transportCallId}:`,
            e
          )
        );
    } finally {
      if (watchdog) clearTimeout(watchdog);
      executingMethods.delete(event.transportCallId);
      if (terminalSubmitted) rememberSubmittedMethodTransportCall(event.transportCallId);
    }
  }

  function toStoredAttachments(attachments: AttachmentInput[]): Array<{
    id: string;
    data: string;
    mimeType: string;
    name?: string;
    size: number;
  }> {
    return attachments.map((a, i) => ({
      id: `att_${i}`,
      data: uint8ArrayToBase64(a.data),
      mimeType: a.mimeType,
      name: a.name,
      size: a.data.length,
    }));
  }

  function uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    return btoa(binary);
  }

  // Phase 2C: Gap detection state
  let lastSeenSeq: number | undefined = opts.sinceId;
  let repairingGap = false;
  const gapBuffer: ClientIngressMessage[] = [];

  async function handleSubscriptionPayload(payload: unknown, generation?: number): Promise<void> {
    if (closed) return;
    if (
      generation !== undefined &&
      generation !== activeSubscription?.generation &&
      activeSubscription?.acknowledged
    ) {
      return;
    }
    const data = payload as {
      channelId?: string;
      message?: RpcChannelMessage;
      cancellation?: { transportCallId?: string };
    };
    if (data.channelId !== channel) return;
    if (typeof data.cancellation?.transportCallId === "string") {
      abortExecutingMethod(data.cancellation.transportCallId);
      return;
    }
    if (data.message) {
      const raw = data.message;
      if (raw.kind === "control" && raw.type === "ready" && raw.ready) {
        if (!replayComplete) {
          await ingestReplayEnvelope(
            {
              mode: opts.sinceId && opts.sinceId > 0 ? "after" : "initial",
              logEvents: streamedReplayLogEvents,
              snapshots: streamedReplaySnapshots,
              ready: raw.ready,
            },
            "stream"
          ).catch((error) => {
            const failure = toPubSubError(error, "server");
            rejectReady(failure);
            handleError(failure);
            throw failure;
          });
        } else {
          await handleServerMessage(
            {
              stream: "control",
              controlType: "ready",
              contextId: raw.ready.contextId,
              channelConfig: raw.ready.channelConfig,
              totalCount: raw.ready.totalCount,
              envelopeCount: raw.ready.envelopeCount,
              firstEnvelopeSeq: raw.ready.firstEnvelopeSeq,
              hasMoreBefore: raw.ready.hasMoreBefore,
            },
            generation
          );
        }
        return;
      }
      if (raw.kind === "control" && raw.type === "roster-snapshot") {
        const snapshot: BootstrapSnapshot = {
          kind: "roster-snapshot",
          participants: raw.participants ?? [],
          ts: raw.ts ?? Date.now(),
        };
        if (replayMode === "skip" && !replayComplete) return;
        if (!replayComplete) {
          streamedReplaySnapshots.push(snapshot);
        } else {
          applyRosterSnapshot(snapshot);
        }
        return;
      }
      if (raw.kind === "log" && raw.phase === "replay" && raw.event && !replayComplete) {
        if (replayMode === "skip") {
          // Skip drops user-facing replay, but still settle in-flight method
          // calls from replayed invocation.* lifecycle events.
          if (isInvocationLifecycleEvent(raw.event)) {
            await handleServerMessage(eventToClientIngress(raw.event, "replay"), generation);
          }
          return;
        }
        streamedReplayLogEvents.push(raw.event);
        return;
      }
      const msg: ClientIngressMessage | null =
        raw.kind === "log" && raw.event
          ? eventToClientIngress(raw.event, raw.phase === "replay" ? "replay" : "live")
          : raw.kind === "signal"
            ? {
                stream: "signal",
                type: raw.type,
                payload: raw.payload,
                senderId: raw.senderId,
                ts: raw.ts,
              }
            : null;
      if (!msg) return;

      // The first bounded replay page establishes a stable watermark. Live
      // appends that arrive while continuation pages are loading are released
      // only after that snapshot is complete.
      if (!replayComplete && msg.stream === "log" && msg.phase === "live") {
        if (opts.deliveryMode === "resident") {
          throw Object.assign(
            new Error("Resident delivery arrived while replay was still being applied"),
            { code: "ResidentReplayInProgress" }
          );
        }
        replayLiveBuffer.push(msg);
        return;
      }

      // Buffer events that arrive during gap repair — process them after the gap is filled
      if (repairingGap) {
        gapBuffer.push(msg);
        return;
      }

      // Response streams carry the channel's contiguous log and repair a
      // missing sequence from the durable cursor. Resident delivery carries a
      // participant-specific mailbox: self-authored and unaddressed events are
      // deliberately absent, so a global sequence gap is not evidence of
      // loss. The channel's ordered durable lane is the completeness proof.
      if (
        opts.deliveryMode !== "resident" &&
        msg.id !== undefined &&
        msg.id > 0 &&
        lastSeenSeq !== undefined
      ) {
        if (msg.id > lastSeenSeq + 1) {
          repairingGap = true;
          const repairAfter = lastSeenSeq;
          try {
            await forEachReplayAfterPage(
              { after: repairAfter, throughSeq: msg.id - 1 },
              async (envelope) => {
                for (const evt of envelope.logEvents) {
                  if (evt.id !== undefined && lastSeenSeq !== undefined && evt.id <= lastSeenSeq) {
                    continue;
                  }
                  await handleServerMessage(eventToClientIngress(evt, "live"), generation);
                }
              }
            );
          } finally {
            repairingGap = false;
          }
          // Process the triggering message, then any buffered events.
          await handleServerMessage(msg, generation);
          const buffered = gapBuffer.splice(0);
          for (const bufferedMsg of buffered) await handleServerMessage(bufferedMsg, generation);
          return;
        }
      }
      if (msg.id !== undefined && msg.id > 0) {
        lastSeenSeq = Math.max(lastSeenSeq ?? 0, msg.id);
      }
      await handleServerMessage(msg, generation);
    }
  }

  // Subscribe to channel
  const subscribeMetadata: Record<string, unknown> = {
    ...(opts.metadata ? opts.metadata : {}),
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.type !== undefined ? { type: opts.type } : {}),
    ...(opts.handle !== undefined ? { handle: opts.handle } : {}),
    contextId: opts.contextId,
    channelConfig: opts.channelConfig ? opts.channelConfig : undefined,
    replay: replayMode !== "skip",
    replayMessageLimit: opts.replayMessageLimit ?? DEFAULT_CHANNEL_REPLAY_PAGE_LIMIT,
    sinceId: opts.sinceId,
  };
  if (methodAdvertisements) subscribeMetadata["methods"] = methodAdvertisements;

  interface ActiveSubscription {
    generation: number;
    subscriptionId: string;
    controller: AbortController;
    terminal: Promise<void>;
    acknowledged: boolean;
  }

  let subscriptionGeneration = 0;
  let activeSubscription: ActiveSubscription | null = null;
  let recovering = false;
  let recoveryRequested = false;
  let recoveryRunScheduled = false;
  let residentRelationshipRevision = 0;

  function requestSubscriptionRecovery(): void {
    if (closed || !opts.recoveryCoordinator) return;
    recoveryRequested = true;
    const run = opts.recoveryCoordinator.run;
    if (recovering || recoveryRunScheduled || !run) return;
    recoveryRunScheduled = true;
    void run.call(opts.recoveryCoordinator, "resubscribe").finally(() => {
      recoveryRunScheduled = false;
      if (recoveryRequested && !recovering && !closed) requestSubscriptionRecovery();
    });
  }

  function resetReplayProjectionForRecovery(): void {
    currentRoster = {};
    rosterOpIds.clear();
    replayMessageKeys.clear();
    replayEvents.length = 0;
    replayLiveBuffer.length = 0;
    replayCatchupPromise = null;
    bufferingReplay = replayMode !== "skip";
    replayComplete = false;
    emitRecoveryReplay = true;
  }

  async function openSubscription(
    metadata: Record<string, unknown>,
    options: { resetOnAck?: boolean } = {}
  ): Promise<void> {
    const previous = activeSubscription;
    const generation = ++subscriptionGeneration;
    const subscriptionId = crypto.randomUUID();
    const controller = new AbortController();

    let resolveAck!: () => void;
    let rejectAck!: (error: Error) => void;
    const ack = new Promise<void>((resolve, reject) => {
      resolveAck = resolve;
      rejectAck = reject;
    });
    let acknowledged = false;

    const subscription: ActiveSubscription = {
      generation,
      subscriptionId,
      controller,
      terminal: Promise.resolve(),
      acknowledged: false,
    };
    const terminal = (async () => {
      let unregisterResident: (() => void | Promise<void>) | null = null;
      let ownedResidentRegistration: ResidentSessionRegistration | null = null;
      try {
        if (opts.deliveryMode === "resident") {
          previous?.controller.abort();
          await previous?.terminal.catch(() => undefined);
          if (!rpc.registerResidentSession) {
            throw new Error(
              "Resident channel delivery requires the owning Durable Object registrar"
            );
          }
          const residentReceiver = ((payload: unknown) => {
            return handleSubscriptionPayload(
              payload as { channelId?: string; message?: RpcChannelMessage },
              generation
            );
          }) as import("@vibestudio/shared/residentSession").ResidentSessionReceiver;
          residentReceiver.abortAll = () => {
            for (const [callId] of executingMethods) abortExecutingMethod(callId);
            for (const [callId] of admittingMethods) abortExecutingMethod(callId);
          };
          const channelTargetId = await getDoTarget(controller.signal);
          residentRegistration = rpc.registerResidentSession(channel, residentReceiver, {
            targetId: channelTargetId,
          });
          const registration = residentRegistration;
          ownedResidentRegistration = registration;
          unregisterResident = () => registration.close();
          const state = await callChannel<{ revision: number }>("relationshipState", deliveryId);
          residentRelationshipRevision = state.revision + 1;
          const result = await callChannel<SubscribeResult>("join", {
            participantId: deliveryId,
            revision: residentRelationshipRevision,
            contextId: String(opts.contextId ?? ""),
            metadata,
            delivery: "all",
            endpoint: {
              kind: "entity",
              entityId: deliveryId,
              invocation: "mailbox",
            },
            applicationConfig: null,
            replay: replayMode !== "skip",
          });
          residentRelationshipRevision = result.revision ?? residentRelationshipRevision;
          acknowledged = true;
          subscription.acknowledged = true;
          // The join itself is the ACK. Settle its promise before replay
          // hydration, whose failures belong to the subscription terminal and
          // recovery path rather than leaving the opener pending forever.
          resolveAck();
          if (options.resetOnAck) resetReplayProjectionForRecovery();
          await applySubscribeAckFallback(result);
          await new Promise<void>((resolve) => {
            if (controller.signal.aborted) return resolve();
            controller.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return;
        }
        const response = await rpc.stream(
          await getDoTarget(controller.signal),
          "subscribe",
          [deliveryId, metadata, subscriptionId],
          { signal: controller.signal }
        );
        for await (const record of readChannelSubscriptionRecords<
          SubscribeResult,
          { channelId?: string; message?: RpcChannelMessage }
        >(response)) {
          // A superseded reader remains valid until the channel atomically
          // installs and ACKs its replacement. Continue consuming it during
          // that overlap; replay/event idempotency collapses duplicates. An
          // eager break cancels the old response and recreates the exact
          // zero-subscription race this overlap is meant to prevent.
          if (record.kind === "subscribed") {
            if (acknowledged) throw new Error("Channel subscription sent more than one ACK");
            acknowledged = true;
            subscription.acknowledged = true;
            resolveAck();
            if (options.resetOnAck) resetReplayProjectionForRecovery();
            await applySubscribeAckFallback(record.result);
            continue;
          }
          if (!acknowledged) throw new Error("Channel subscription delivered data before its ACK");
          await handleSubscriptionPayload(record.payload, generation);
        }
        if (!acknowledged) throw new Error("Channel subscription closed before its ACK");
        if (
          !closed &&
          !controller.signal.aborted &&
          generation === activeSubscription?.generation
        ) {
          throw new Error("Channel subscription closed unexpectedly");
        }
      } catch (error) {
        const failure = toPubSubError(error, "connection");
        if (!acknowledged) rejectAck(failure);
        if (
          !closed &&
          !controller.signal.aborted &&
          generation === activeSubscription?.generation
        ) {
          replayComplete = false;
          // Before the first ACK, a coordinator-owned client still has a
          // viable connection surface: the replacement subscription is the
          // same resource lifecycle. Do not permanently poison ready() for a
          // transient first-generation failure.
          if (acknowledged || !hasSubscriptionRecovery) rejectReady(failure);
          handleError(failure);
          for (const handler of disconnectHandlers) handler();
          // A response-owned channel subscription can end even while its host
          // transport remains usable (for example, after the channel's
          // activation is replaced). Recover that resource from its durable
          // cursor instead of waiting for an unrelated host reconnect signal.
          // A pre-ACK opener owns its failure and schedules/retries recovery
          // from its rejection path. Post-ACK termination has no awaiting
          // opener, so the reader must request replacement itself.
          if (acknowledged) requestSubscriptionRecovery();
        }
        throw failure;
      } finally {
        await unregisterResident?.();
        if (residentRegistration === ownedResidentRegistration) {
          residentRegistration = null;
        }
      }
    })();
    terminal.catch(() => {});
    subscription.terminal = terminal;
    activeSubscription = subscription;
    try {
      // The channel replaces the response resource atomically under this
      // client's stable delivery identity. Keep the previous response alive
      // until the replacement ACK proves that the new resource exists; then
      // close the obsolete client-side reader. This prevents a recovery from
      // manufacturing a zero-subscription leave/join gap.
      await ack;
      previous?.controller.abort();
    } catch (error) {
      controller.abort();
      if (activeSubscription === subscription) activeSubscription = previous;
      throw error;
    }
  }

  async function recoverSubscription(): Promise<void> {
    if (closed) return;
    if (recovering) {
      recoveryRequested = true;
      return;
    }
    recovering = true;
    try {
      do {
        recoveryRequested = false;
        try {
          // Replacing the stream generation cancels the exact old resource.
          // The durable replay cursor catches this generation up without a
          // liveness lease, timer, or best-effort unary cleanup call.
          const resubMeta = {
            ...subscribeMetadata,
            sinceId: lastSeenSeq,
            replay: true,
          };
          await openSubscription(resubMeta, { resetOnAck: true });
          subscribeAckResolve?.();
          subscribeAckResolve = null;
          subscribeAckReject = null;
          // In-flight method calls are recovered from replayed invocation.*
          // events, not a settled-results read-back.
          for (const handler of reconnectHandlers) handler();
        } catch (error) {
          // A terminal from the replacement can arrive while its opener is
          // still awaited. The terminal path records recoveryRequested; loop
          // here so that request cannot disappear behind the recovering flag.
          if (!recoveryRequested || closed) throw error;
        }
      } while (recoveryRequested && !closed);
    } finally {
      recovering = false;
    }
  }

  const unregisterResubscribe = opts.recoveryCoordinator?.registerResubscribeHandler(
    `pubsub:${channel}:${pid}`,
    recoverSubscription,
    // connectViaRpc opens its initial channel response itself. Replaying the
    // shell transport's already-completed initial generation would create a
    // redundant replacement subscription during bootstrap.
    { includeCurrentGeneration: false }
  );
  const unregisterColdRecover = opts.recoveryCoordinator?.registerColdRecoverHandler(
    `pubsub:${channel}:${pid}`,
    recoverSubscription
  );

  // Opening the stream creates the subscription resource. Its first record is
  // the replay ACK; all subsequent records are live delivery on that resource.
  openSubscription(subscribeMetadata)
    .then(() => {
      subscribeAckResolve?.();
      subscribeAckResolve = null;
      subscribeAckReject = null;
    })
    .catch((err: unknown) => {
      const pubsubError = toPubSubError(err, "connection");
      if (!hasSubscriptionRecovery) {
        subscribeAckReject?.(pubsubError);
        subscribeAckResolve = null;
        subscribeAckReject = null;
        rejectReady(pubsubError);
      } else {
        requestSubscriptionRecovery();
      }
      handleError(pubsubError);
    });

  // ── Public API ──────────────────────────────────────────────────────────

  async function ready(signal?: AbortSignal): Promise<void> {
    if (closed) throw new PubSubError("connection closed before ready", "connection");
    const fullyReady = Promise.all([readyPromise, subscribeAckPromise]).then(() => undefined);
    if (!signal) return fullyReady;
    if (signal.aborted) throw new PubSubError("ready aborted", "connection");

    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new PubSubError("ready aborted", "connection"));
      signal.addEventListener("abort", onAbort, { once: true });
      fullyReady.then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  async function publish<P>(
    type: string,
    payload: P,
    publishOptions: PublishOptions = {}
  ): Promise<number | undefined> {
    if (closed) throw new PubSubError("not connected", "connection");
    const { attachments, idempotencyKey } = publishOptions;

    const result = await callChannel<{ id?: number }>("publish", pid, type, payload, {
      ref: undefined,
      senderMetadata: undefined,
      attachments: attachments ? toStoredAttachments(attachments) : undefined,
      idempotencyKey,
    });
    return result?.id;
  }

  async function updateMetadata(
    newMetadata: Partial<T>,
    _updateOptions: UpdateMetadataOptions = {}
  ): Promise<void> {
    await callChannel("updateMetadata", pid, newMetadata);
  }

  async function setTyping(active: boolean): Promise<void> {
    await callChannel("setTypingState", pid, active);
  }

  async function updateChannelConfig(config: Partial<ChannelConfig>): Promise<ChannelConfig> {
    const newConfig = await callChannel<ChannelConfig>("updateConfig", config);
    serverChannelConfig = newConfig;
    return newConfig;
  }

  async function addMember(userId: string): Promise<ChannelMember & { alreadyMember: boolean }> {
    return callChannel("addMember", { userId });
  }

  async function removeMember(userId: string): Promise<{ removed: boolean }> {
    return callChannel("removeMember", { userId });
  }

  async function listMembers(): Promise<ChannelMember[]> {
    const result = await callChannel<{ members: ChannelMember[] }>("listMembers");
    return result.members;
  }

  async function listInvitesForMe(): Promise<ChannelInvite[]> {
    const result = await callChannel<{ invites: ChannelInvite[] }>("listInvitesForMe");
    return result.invites;
  }

  async function acknowledgeInvite(): Promise<boolean> {
    const result = await callChannel<{ acknowledged: boolean }>("acknowledgeInvite");
    return result.acknowledged;
  }

  async function getChannelPresence(): Promise<{
    entries: ChannelPresenceEntry[];
    generatedAt: number;
  }> {
    return callChannel("getChannelPresence");
  }

  /** Record that this participant has read a message in the channel. Durable
   * inbox disposition is deliberately separate and requires a user action. */
  async function recordReadReceipt(messageId: string): Promise<void> {
    await callChannel("recordReceipt", pid, messageId, "read", {});
  }

  async function sendMessage(
    content: string,
    sendOptions?: {
      replyTo?: string;
      attachments?: AttachmentInput[];
      contentType?: string;
      mentions?: string[];
      /** Explicit direction: only the selected participants should respond. */
      to?: Array<{
        kind: "all" | "role" | "participant";
        role?: string;
        participantId?: string;
      }>;
      metadata?: Record<string, unknown>;
      idempotencyKey?: string;
      /** Salience tier stamped onto the message; absent ⇒ "primary". */
      tier?: MessageTier;
    }
  ): Promise<{ messageId: string; pubsubId: number | undefined }> {
    const id = crypto.randomUUID();
    const event: AgenticEvent = {
      kind: "message.completed",
      actor: {
        kind: "user",
        id: pid,
        displayName:
          typeof subscribeMetadata["name"] === "string" ? subscribeMetadata["name"] : pid,
        metadata: subscribeMetadata,
      },
      causality: { messageId: id as never },
      payload: {
        protocol: "agentic.trajectory.v1",
        role: "user",
        blocks: [
          { blockId: `${id}:block:0` as never, type: "text", content },
          ...(sendOptions?.attachments?.map((attachment, index) => ({
            blockId: `${id}:block:${index + 1}` as never,
            type: "attachment" as const,
            metadata: {
              mimeType: attachment.mimeType,
              filename: "filename" in attachment ? attachment.filename : undefined,
            },
          })) ?? []),
        ],
        outcome: "completed",
        mentions: sendOptions?.mentions,
        replyTo: sendOptions?.replyTo as never,
        to: sendOptions?.to,
        ...(sendOptions?.tier ? { tier: sendOptions.tier } : {}),
        // Send intent (e.g. deliverAfterTurn) rides on payload.metadata; the
        // agent loop lifts it into its queue entries via metadataFromPayload.
        ...(sendOptions?.metadata ? { metadata: sendOptions.metadata } : {}),
      },
      createdAt: new Date().toISOString(),
    };
    const pubsubId = await publish(AGENTIC_EVENT_PAYLOAD_KIND, event, {
      attachments: sendOptions?.attachments,
      idempotencyKey: sendOptions?.idempotencyKey,
    });
    return { messageId: id, pubsubId };
  }

  /** The author's participant ref — actor and `payload.by` for mutations. */
  function selfActor(): AgenticEvent["actor"] {
    return {
      kind: "user",
      id: pid,
      displayName: typeof subscribeMetadata["name"] === "string" ? subscribeMetadata["name"] : pid,
      metadata: subscribeMetadata,
    };
  }

  /** Revise an unread message's blocks (publishes `message.edited`). The
   *  channel reducer enforces the author guard and the read-wins cutoff. */
  async function editMessage(
    messageId: string,
    blocks: MessageBlockInput[],
    options?: { idempotencyKey?: string; revision?: number }
  ): Promise<{ pubsubId: number | undefined }> {
    const by = selfActor();
    const event: AgenticEvent = {
      kind: "message.edited",
      actor: by,
      causality: { messageId: messageId as never },
      payload: { protocol: "agentic.trajectory.v1", by, blocks },
      createdAt: new Date().toISOString(),
    };
    const pubsubId = await publish(AGENTIC_EVENT_PAYLOAD_KIND, event, {
      idempotencyKey: options?.idempotencyKey ?? `edit:${messageId}:${options?.revision ?? 0}`,
    });
    return { pubsubId };
  }

  /** Cancel an unread message (publishes `message.retracted`). No-op after a
   *  recipient has read it. */
  async function retractMessage(
    messageId: string,
    options?: { reason?: string; idempotencyKey?: string }
  ): Promise<{ pubsubId: number | undefined }> {
    const by = selfActor();
    const event: AgenticEvent = {
      kind: "message.retracted",
      actor: by,
      causality: { messageId: messageId as never },
      payload: {
        protocol: "agentic.trajectory.v1",
        by,
        ...(options?.reason ? { reason: options.reason } : {}),
      },
      createdAt: new Date().toISOString(),
    };
    const pubsubId = await publish(AGENTIC_EVENT_PAYLOAD_KIND, event, {
      idempotencyKey: options?.idempotencyKey ?? `retract:${messageId}`,
    });
    return { pubsubId };
  }

  async function errorMessage(
    id: string,
    errorMsg: string,
    code?: string
  ): Promise<number | undefined> {
    const payload: Record<string, unknown> = { id, error: errorMsg };
    if (code) payload["code"] = code;
    return await publish("error", payload);
  }

  function callMethod(
    providerId: string,
    methodName: string,
    args?: unknown,
    callOptions?: {
      signal?: AbortSignal;
      invocationId?: string;
      transportCallId?: string;
      turnId?: string;
      timeoutMs?: number;
    }
  ): MethodCallHandle {
    const transportCallId = callOptions?.transportCallId ?? crypto.randomUUID();
    const invocationId = callOptions?.invocationId ?? transportCallId;
    const callId = transportCallId;

    let resolveResult!: (value: MethodResultValue) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<MethodResultValue>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    const stream = createFanout<MethodResultChunk>();
    const state: MethodCallState = {
      callId,
      invocationId,
      transportCallId,
      stream,
      resolve: resolveResult,
      reject: rejectResult,
      complete: false,
      isError: false,
    };
    methodCallStates.set(callId, state);
    methodCallStates.set(invocationId, state);

    const startRecoveryController = new AbortController();
    void result.then(
      () => startRecoveryController.abort(),
      () => startRecoveryController.abort()
    );

    const rejectMethodStart = (error: unknown): void => {
      if (state.complete) return;
      const err = error instanceof Error ? error : new Error(String(error));
      state.complete = true;
      state.isError = true;
      stream.close(err);
      rejectResult(new AgenticError(err.message, "connection-error", err));
      deleteMethodCallState(state);
    };

    const waitForMethodStartRedrive = async (delayMs: number): Promise<void> => {
      if (startRecoveryController.signal.aborted) return;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          startRecoveryController.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, delayMs);
        startRecoveryController.signal.addEventListener("abort", finish, {
          once: true,
        });
      });
    };

    const cancelCall = (notifyProvider: boolean, waitForProvider: boolean): Promise<void> => {
      if (state.complete) return Promise.resolve();
      state.complete = true;
      state.isError = true;
      stream.close();
      rejectResult(new AgenticError("cancelled", "cancelled"));
      deleteMethodCallState(state);
      if (!notifyProvider) {
        return Promise.resolve();
      }
      const cancelPromise = callChannel("cancelMethodCall", pid, transportCallId).then(
        () => undefined
      );
      if (waitForProvider) return cancelPromise;
      void cancelPromise.catch((err) => {
        console.warn(
          `[PubSubClient] Failed to notify provider about cancellation for ${transportCallId}:`,
          err
        );
      });
      return Promise.resolve();
    };

    if (callOptions?.signal) {
      if (callOptions.signal.aborted) {
        void cancelCall(false, false);
      } else {
        const abort = () => {
          void cancelCall(true, false);
        };
        callOptions.signal.addEventListener("abort", abort, { once: true });
        result.then(
          () => callOptions.signal?.removeEventListener("abort", abort),
          () => callOptions.signal?.removeEventListener("abort", abort)
        );
      }
    }

    if (!state.complete) {
      const callArgs = [
        pid,
        providerId,
        transportCallId,
        methodName,
        args ?? {},
        {
          invocationId,
          transportCallId,
          ...(callOptions?.timeoutMs ? { timeoutMs: callOptions.timeoutMs } : {}),
          ...(callOptions?.turnId ? { turnId: callOptions.turnId } : {}),
        },
      ] as const;

      // Channel method starts are journal-before-dispatch. An internal,
      // protocol, service, or transport failure is therefore an ambiguous ACK:
      // the durable start (and even its terminal) may already exist. Keep the
      // local result pending and re-drive the exact same coordinates until the
      // channel accepts them or a durable terminal/cancel/close settles state.
      // ChannelDO deduplicates both the start and terminal by those identities.
      void (async () => {
        let failures = 0;
        while (!state.complete) {
          try {
            await callChannel("callMethod", ...callArgs);
            return;
          } catch (error) {
            if (state.complete) return;
            if (!isAmbiguousMethodStartFailure(error)) {
              rejectMethodStart(error);
              return;
            }
            const delayMs = Math.min(
              METHOD_START_REDRIVE_BASE_DELAY_MS * 2 ** Math.min(failures, 6),
              METHOD_START_REDRIVE_MAX_DELAY_MS
            );
            failures += 1;
            await waitForMethodStartRedrive(delayMs);
          }
        }
      })();
    }

    return {
      callId,
      invocationId,
      transportCallId,
      result,
      stream: stream.subscribe(),
      cancel: async () => {
        await cancelCall(true, true);
      },
      get complete() {
        return state.complete;
      },
      get isError() {
        return state.isError;
      },
    };
  }

  async function cancelMethodCall(callId: string): Promise<void> {
    await callChannel("cancelMethodCall", pid, callId);
  }

  // Abort a method THIS client is executing, synchronously and in-process.
  // The executing method (e.g. an eval running in this panel) was handed
  // `ctx.signal` from the controller stored in `executingMethods` keyed by the
  // inbound transport call id (see handleMethodCallExec). Firing it here stops
  // the local execution immediately; the method's abort path submits a
  // terminal invocation result, which settles the caller's pending result.
  function abortExecutingMethod(callId: string): boolean {
    rememberCancelledMethodTransportCall(callId);
    const executing = executingMethods.get(callId);
    if (!executing) return admittingMethods.has(callId);
    executing.controller.abort();
    executingMethods.delete(callId);
    return true;
  }

  function events(evtOptions?: EventStreamOptions): AsyncIterableIterator<EventStreamItem> {
    const source = eventsFanout.subscribe();
    const includeReplay = evtOptions?.includeReplay ?? false;
    const includeSignals = evtOptions?.includeSignals ?? false;

    return (async function* () {
      if (includeReplay && replayMode !== "skip") {
        if (!replayComplete) {
          try {
            await readyPromise;
          } catch {
            // ready() failures are surfaced through close/error handling below.
          }
        }
        for (const item of replayEvents) {
          if (!includeSignals && item.delivery === "signal") continue;
          yield item;
        }
      }

      for await (const event of source) {
        if (!includeSignals && event.delivery === "signal") continue;
        if (!includeReplay && event.phase === "replay") continue;
        yield event;
      }
    })();
  }

  let closePromise: Promise<void> | null = null;

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    unregisterResubscribe?.();
    unregisterColdRecover?.();
    rejectReady(new PubSubError("connection closed before ready", "connection"));
    eventsFanout.close();
    // Reject all pending method calls so callers don't hang
    for (const [callId, state] of methodCallStates) {
      if (!state.complete) {
        state.complete = true;
        state.isError = true;
        state.stream.close();
        state.reject(new Error("Channel closed"));
      }
      methodCallStates.delete(callId);
    }
    // Abort all executing methods so handlers see signal.aborted
    for (const [, executing] of executingMethods) {
      executing.controller.abort();
    }
    executingMethods.clear();
    for (const callId of admittingMethods.keys()) rememberCancelledMethodTransportCall(callId);
    for (const handler of disconnectHandlers) handler();

    const subscription = activeSubscription;
    closePromise = (async () => {
      let leaveError: unknown;
      try {
        // Before the subscribe ACK there is no admitted participant to leave;
        // cancelling that pending resource is complete cleanup. After the ACK,
        // self-leave is the one cooperative terminal: the channel drains the
        // participant's accepted delivery lane before removing its authority
        // anchor and closing the response stream.
        if (subscription?.acknowledged) {
          if (opts.deliveryMode === "resident") {
            const relationship = await callChannel<{
              revision: number;
              active: boolean;
            }>("relationshipState", pid);
            if (!relationship.active) {
              await residentRegistration?.relationshipEnded?.();
              return;
            }
            await callChannel("leave", {
              participantId: pid,
              revision: relationship.revision + 1,
            });
            await residentRegistration?.relationshipEnded?.();
          } else {
            await rpc.call(await getDoTarget(), "unsubscribe", [
              pid,
              subscription.subscriptionId,
            ], { timeoutMs: CHANNEL_CLOSE_TIMEOUT_MS });
          }
        }
      } catch (error) {
        leaveError = error;
      } finally {
        subscription?.controller.abort();
        await subscription?.terminal.catch(() => undefined);
        if (activeSubscription === subscription) activeSubscription = null;
      }
      if (leaveError !== undefined) throw leaveError;
    })();
    return closePromise;
  }

  async function sendRaw(_message: Record<string, unknown>): Promise<void> {
    // No-op for RPC transport
  }

  function localActor() {
    return {
      kind:
        opts.type === "agent" ||
        opts.type === "system" ||
        opts.type === "panel" ||
        opts.type === "external"
          ? opts.type
          : "user",
      id: pid,
      displayName: opts.name ?? pid,
      metadata: subscribeMetadata,
    } as const;
  }

  async function getMessageTypes(): Promise<MessageTypeDefinition[]> {
    return callChannel<MessageTypeDefinition[]>("getMessageTypes");
  }

  async function getEnvelope(envelopeId: string): Promise<unknown | null> {
    return callChannel<unknown | null>("getEnvelope", envelopeId);
  }

  async function getMessageType(typeId: string): Promise<MessageTypeDefinition | null> {
    return callChannel<MessageTypeDefinition | null>("getMessageType", typeId);
  }

  async function registerMessageType(
    input: RegisterMessageTypeInput,
    options?: { idempotencyKey?: string }
  ): Promise<number | undefined> {
    const event: AgenticEvent<"messageType.registered"> = {
      kind: "messageType.registered",
      actor: localActor(),
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        typeId: input.typeId,
        displayMode: input.displayMode,
        source: input.source,
        registeredBy: localActor(),
      },
      createdAt: new Date().toISOString(),
    };
    if (input.imports !== undefined) event.payload.imports = input.imports;
    if (input.stateSchema !== undefined) event.payload.stateSchema = input.stateSchema;
    if (input.updateSchema !== undefined) event.payload.updateSchema = input.updateSchema;
    return publish(
      AGENTIC_EVENT_PAYLOAD_KIND,
      event,
      options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined
    );
  }

  async function clearMessageType(
    typeId: string,
    options?: { idempotencyKey?: string }
  ): Promise<number | undefined> {
    const event: AgenticEvent<"messageType.cleared"> = {
      kind: "messageType.cleared",
      actor: localActor(),
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, typeId },
      createdAt: new Date().toISOString(),
    };
    return publish(
      AGENTIC_EVENT_PAYLOAD_KIND,
      event,
      options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined
    );
  }

  async function publishCustomMessage(
    input: {
      typeId: string;
      initialState?: unknown;
      displayMode?: "inline" | "row";
    },
    options?: { idempotencyKey?: string }
  ): Promise<{ messageId: string; pubsubId: number | undefined }> {
    const messageId = crypto.randomUUID();
    const event: AgenticEvent<"custom.started"> = {
      kind: "custom.started",
      actor: localActor(),
      causality: { messageId: messageId as MessageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        messageId: messageId as MessageId,
        typeId: input.typeId,
        by: localActor(),
      },
      createdAt: new Date().toISOString(),
    };
    if (input.displayMode !== undefined) event.payload.displayMode = input.displayMode;
    if (input.initialState !== undefined) event.payload.initialState = input.initialState;
    const pubsubId = await publish(AGENTIC_EVENT_PAYLOAD_KIND, event, {
      idempotencyKey: options?.idempotencyKey ?? `custom:start:${messageId}`,
    });
    return { messageId, pubsubId };
  }

  async function updateCustomMessage(
    messageId: string,
    update: unknown,
    options?: {
      idempotencyKey?: string;
      status?: "failed";
      error?: { message: string; details?: unknown };
    }
  ): Promise<number | undefined> {
    const event: AgenticEvent<"custom.updated"> = {
      kind: "custom.updated",
      actor: localActor(),
      causality: { messageId: messageId as MessageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        messageId: messageId as MessageId,
        update,
      },
      createdAt: new Date().toISOString(),
    };
    if (options?.status !== undefined) event.payload.status = options.status;
    if (options?.error !== undefined) event.payload.error = options.error;
    return publish(AGENTIC_EVENT_PAYLOAD_KIND, event, {
      idempotencyKey:
        options?.idempotencyKey ?? `custom:update:${messageId}:${crypto.randomUUID()}`,
    });
  }

  return {
    publish,
    updateMetadata,
    setTyping,
    ready,
    close,
    sendRaw,
    events,
    send: sendMessage,
    editMessage,
    retractMessage,
    error: errorMessage,
    callMethod,
    cancelMethodCall,
    abortExecutingMethod,
    getMessageTypes,
    getMessageType,
    getEnvelope,
    registerMessageType,
    clearMessageType,
    publishCustomMessage,
    updateCustomMessage,
    get clientId() {
      return pid;
    },
    get channelId() {
      return channel;
    },
    get connected() {
      return !closed && replayComplete;
    },
    get reconnecting() {
      return recovering;
    },
    get contextId() {
      return serverContextId;
    },
    get channelConfig() {
      return serverChannelConfig;
    },
    onError: (handler: (error: Error) => void) => {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
    onDisconnect: (handler: () => void) => {
      disconnectHandlers.add(handler);
      return () => disconnectHandlers.delete(handler);
    },
    onReconnect: (handler: () => void) => {
      reconnectHandlers.add(handler);
      return () => reconnectHandlers.delete(handler);
    },
    onReady: (handler: () => void) => {
      readyHandlers.add(handler);
      return () => readyHandlers.delete(handler);
    },
    onRoster: (handler: (roster: RosterUpdate<T>) => void) => {
      rosterHandlers.add(handler);
      if (Object.keys(currentRoster).length > 0) {
        handler({ participants: { ...currentRoster }, ts: Date.now() });
      }
      return () => rosterHandlers.delete(handler);
    },
    updateChannelConfig,
    addMember,
    removeMember,
    listMembers,
    listInvitesForMe,
    acknowledgeInvite,
    getChannelPresence,
    recordReadReceipt,
    onConfigChange: (handler: (config: ChannelConfig) => void) => {
      configChangeHandlers.add(handler);
      if (serverChannelConfig) handler(serverChannelConfig);
      return () => configChangeHandlers.delete(handler);
    },
    get roster() {
      return { ...currentRoster };
    },
    get totalMessageCount() {
      return serverTotalCount;
    },
    get envelopeCount() {
      return serverEnvelopeCount;
    },
    get firstEnvelopeSeq() {
      return serverFirstEnvelopeSeq;
    },
    get hasMoreBefore() {
      return serverHasMoreBefore;
    },
    async getReplayBefore(beforeSeq: number, limit = 100) {
      return callChannel<ChannelReplayEnvelope>("getReplayBefore", beforeSeq, limit);
    },
    async getReplayAfter(request: ChannelReplayAfterRequest) {
      return callChannel<ChannelReplayEnvelope>("getReplayAfter", request);
    },
  };
}
