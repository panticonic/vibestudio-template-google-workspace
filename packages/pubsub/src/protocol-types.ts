/**
 * Agentic messaging protocol types.
 *
 * Core types for the agentic messaging protocol including participants,
 * messages, events, and methods.
 */

import type {
  Participant,
  ParticipantMetadata,
  RosterUpdate,
  RosterChange,
  LeaveReason,
  Attachment,
  AttachmentInput,
  ChannelConfig,
  ChannelReplayEnvelope,
} from "./types.js";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  CREDENTIAL_CONNECT_PAYLOAD_KIND,
  type AgenticEvent,
} from "@workspace/agentic-protocol";
import type { z } from "zod";

export interface AgentBuildError {
  message: string;
  agentId?: string;
  agentName?: string;
  handle?: string;
  type?: string;
  code?: string;
  stack?: string;
  details?: unknown;
}

// Re-export types from pubsub for convenience
export type { Attachment, AttachmentInput, ChannelConfig, RosterUpdate, RosterChange, LeaveReason };

/** JSON Schema representation for method parameters/returns. */
export type JsonSchema = Record<string, unknown>;

/**
 * Participant metadata for agentic messaging.
 * Extends base pubsub metadata with name, type, handle, and optional method advertisements.
 *
 * Use the role-based predicates `isAgentParticipantType` /
 * `isClientParticipantType` from `tracker-types.ts` to classify participants.
 */
export interface AgenticParticipantMetadata extends ParticipantMetadata {
  /** Display name for this participant */
  name: string;
  /**
   * Participant type. Canonical values are `"panel"`, `"headless"`, `"agent"`,
   * and `"observer"` (see `ChatParticipantMetadata.type`); kept as `string`
   * here for transport flexibility.
   */
  type: string;
  /**
   * Unique channel handle for non-human providers (agents/headless tools).
   * Human handles are account profiles resolved by participant id and are not
   * client-supplied participant metadata.
   */
  handle?: string;
  /** Methods this participant provides (auto-populated from ConnectOptions.methods) */
  methods?: MethodAdvertisement[];
}

/**
 * Method advertisement in participant metadata.
 * Describes a method that can be invoked on this participant.
 */
export interface MethodAdvertisement {
  /** Method name (unique within this provider) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** JSON Schema for method arguments */
  parameters: JsonSchema;
  /** JSON Schema for return value */
  returns?: JsonSchema;
  /** Whether this method can stream partial results */
  streaming?: boolean;
  /** Whether to show this method in participant menu UI */
  menu?: boolean;
}

/**
 * Error codes for agentic operations.
 */
export type AgenticErrorCode =
  | "method-not-found"
  | "provider-not-found"
  | "provider-offline"
  | "execution-error"
  | "cancelled"
  | "validation-error"
  | "connection-error"
  | "handle-conflict";

/**
 * Error class for agentic messaging operations.
 * Includes a machine-readable error code for programmatic handling.
 */
export class AgenticError extends Error {
  constructor(
    message: string,
    public readonly code: AgenticErrorCode,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "AgenticError";
  }
}

/**
 * Error thrown when message validation fails.
 * Includes direction (send/receive) and validation details.
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly direction: "send" | "receive",
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Union type for all incoming message types.
 */
export type IncomingMessage = IncomingErrorMessage;

/**
 * Union type for all incoming event types.
 * Use the `type` field to discriminate between event types.
 */
export type IncomingEvent =
  | IncomingErrorMessage
  | IncomingSignalEvent
  | IncomingInvocationCallEvent
  | IncomingPresenceEventWithType
  | IncomingAgenticEvent
  | IncomingCredentialConnectEvent
  | IncomingAgentDebugEvent;

export interface IncomingAgenticEvent extends IncomingBase {
  type: typeof AGENTIC_EVENT_PAYLOAD_KIND;
  payload: AgenticEvent;
  /** Host-attested content provenance from the durable channel envelope. */
  contentClass: "internal" | "external";
  externalKeys: string[];
}

/** Model credential connect card published by an agent (opaque payload —
 *  the chat UI reduces it into its credential-request view). */
export interface IncomingCredentialConnectEvent extends IncomingBase {
  type: typeof CREDENTIAL_CONNECT_PAYLOAD_KIND;
  payload: unknown;
}

/**
 * Invocation start event derived from a typed agentic envelope.
 */
export interface IncomingInvocationCallEvent extends IncomingInvocationCall {
  type: "invocation-call";
}

/**
 * Presence event with discriminant type field.
 */
export interface IncomingPresenceEventWithType extends IncomingPresenceEvent {
  type: "presence";
}

/**
 * Agent debug event payload - discriminated by debugType.
 */
export type AgentDebugPayload =
  | {
      debugType: "output";
      agentId: string;
      handle: string;
      stream: "stdout" | "stderr";
      content: string;
    }
  | {
      debugType: "lifecycle";
      agentId: string;
      handle: string;
      event: "spawning" | "started" | "stopped" | "woken" | "warning";
      reason?: "explicit" | "crash" | "idle" | "dirty-repo";
      /** Additional details for warning events (e.g., dirty repo state) */
      details?: unknown;
    }
  | {
      debugType: "spawn-error";
      agentId: string;
      handle: string;
      error?: string;
      buildError?: AgentBuildError;
    }
  | {
      debugType: "log";
      agentId: string;
      handle: string;
      level: "debug" | "info" | "warn" | "error";
      message: string;
      stack?: string;
    };

/**
 * An incoming agent debug signal. Uses the message type system for filtering
 * (like "error", "message", etc.)
 */
export interface IncomingAgentDebugEvent extends IncomingBase {
  type: "agent-debug";
  payload: AgentDebugPayload;
}

/**
 * Options for filtering events in the events() iterator.
 */
export interface EventFilterOptions {
  /**
   * Only yield message events where `at` includes this client's ID, or `at` is undefined (broadcast).
   * When false/undefined, all events are yielded regardless of `at`.
   * Note: Non-message events are always yielded.
   */
  targetedOnly?: boolean;
  /**
   * When targetedOnly is true, also yield non-targeted messages if this client
   * is the only non-panel participant in the channel.
   * Useful for agents that should respond when they're the sole responder.
   */
  respondWhenSolo?: boolean;
  /**
   * Callback invoked for events that are filtered out.
   * Useful for logging or debugging filtered events.
   */
  onFiltered?: (event: IncomingEvent) => void;
}

/**
 * Base properties shared by all incoming messages.
 */
export interface IncomingBase {
  /** Transport stream that produced the event. */
  delivery: "log" | "signal";
  /** Log phase, present only for durable log events. */
  phase?: "replay" | "live";
  /** ID of the sender */
  senderId: string;
  /** Timestamp in milliseconds */
  ts: number;
  /** Binary attachments (optional) */
  attachments?: Attachment[];
  /** Server-assigned ID for checkpointing */
  pubsubId?: number;
  /** Sender metadata snapshot (if available) */
  senderMetadata?: {
    name?: string;
    type?: string;
    handle?: string;
  };
}

/**
 * An error marker for a message.
 */
export interface IncomingErrorMessage extends IncomingBase {
  type: "error";
  /** ID of the message that errored */
  id: string;
  /** Error message */
  error: string;
  /** Machine-readable error code */
  code?: string;
}

export interface IncomingSignalEvent extends IncomingBase {
  type: "signal";
  delivery: "signal";
  content: string;
  contentType?: string;
}

/**
 * Presence event actions.
 */
export type PresenceAction = "join" | "leave" | "update";

/**
 * An incoming presence event (join/leave/update).
 * These events are persisted and replayed to reconstruct participant history.
 */
export interface IncomingPresenceEvent {
  /** Transport stream that produced the event. */
  delivery: "log" | "signal";
  /** Log phase, present only for durable log events. */
  phase?: "replay" | "live";
  /** ID of the participant */
  senderId: string;
  /** Timestamp */
  ts: number;
  /** Server-assigned ID for checkpointing */
  pubsubId?: number;
  /** Sender metadata snapshot (if available) */
  senderMetadata?: {
    name?: string;
    type?: string;
    handle?: string;
  };
  /** The action */
  action: PresenceAction;
  /** Reason for leave (only present when action === "leave") */
  leaveReason?: LeaveReason;
  /** Participant metadata at the time of the event */
  metadata: ParticipantMetadata;
}

/**
 * An incoming invocation call (for providers).
 */
export interface IncomingInvocationCall {
  /** Transport stream that produced the event. */
  delivery: "log" | "signal";
  /** Log phase, present only for durable log events. */
  phase?: "replay" | "live";
  /** ID of the caller */
  senderId: string;
  /** Timestamp */
  ts: number;
  /** Server-assigned ID for checkpointing */
  pubsubId?: number;
  /** Sender metadata snapshot (if available) */
  senderMetadata?: {
    name?: string;
    type?: string;
    handle?: string;
  };
  /** Unique call ID for correlation */
  callId: string;
  /** Canonical invocation ID for transcript/provenance correlation */
  invocationId: string;
  /** Transport-level dispatch ID for routing/abort correlation */
  transportCallId: string;
  /** Owning turn ID, when this invocation belongs to an agent turn */
  turnId?: string;
  /** Name of the method being called */
  methodName: string;
  /** Target provider ID (this client) */
  providerId: string;
  /** Method arguments */
  args: unknown;
  /** Journaled call deadline (epoch ms) — THE clock for this call's
   *  lifetime. The executing client derives its abort budget from it; the
   *  channel expires and redelivers from the same value. Absent when the
   *  caller passed no timeout. */
  deadlineAt?: number;
}

/**
 * Final value from a method call.
 */
export interface MethodResultValue {
  /** Result content (JSON-serializable) */
  content: unknown;
  /** Binary attachments */
  attachments?: Attachment[];
}

/**
 * A chunk from a streaming method result.
 */
export interface MethodResultChunk extends MethodResultValue {
  /** Whether this is the final chunk */
  complete: boolean;
  /** Whether this chunk represents an error */
  isError: boolean;
}

/**
 * Handle for an in-flight method call.
 * Provides access to the result, streaming chunks, and cancellation.
 */
export interface MethodCallHandle {
  /** Unique call ID */
  readonly callId: string;
  /** Canonical invocation ID used by transcript/provenance reducers */
  readonly invocationId: string;
  /** Transport-level dispatch ID used by the channel router */
  readonly transportCallId: string;
  /** Promise that resolves with the final result */
  readonly result: Promise<MethodResultValue>;
  /** Async iterator for streaming chunks */
  readonly stream: AsyncIterable<MethodResultChunk>;
  /** Cancel the method call */
  cancel(): Promise<void>;
  /** Whether the call has completed */
  readonly complete: boolean;
  /** Whether the call resulted in an error */
  readonly isError: boolean;
}

/**
 * A discovered method from the roster.
 * Contains all information needed to invoke the method.
 */
export interface DiscoveredMethod {
  /** Provider's client ID */
  providerId: string;
  /** Provider's display name */
  providerName: string;
  /** Method name */
  name: string;
  /** Method description */
  description?: string;
  /** JSON Schema for arguments */
  parameters: JsonSchema;
  /** JSON Schema for return value */
  returns?: JsonSchema;
  /** Whether method supports streaming */
  streaming: boolean;
  /** Whether this method should only appear in menus, not be used as an AI tool */
  menu?: boolean;
}

/**
 * Context provided to method execute functions.
 * Includes utilities for streaming results and cancellation.
 */
export interface MethodExecutionContext {
  /** Unique call ID */
  callId: string;
  /** Canonical invocation ID used by transcript/provenance reducers */
  invocationId: string;
  /** Transport-level dispatch ID used by the channel router */
  transportCallId: string;
  /** Caller's client ID */
  callerId: string;
  /** Abort signal (aborted when caller cancels) */
  signal: AbortSignal;
  /** Stream a partial result */
  stream(content: unknown): Promise<void>;
  /** Stream a partial result with binary attachments */
  streamWithAttachments(content: unknown, attachments: AttachmentInput[]): Promise<void>;
  /** Create a final result with binary attachments */
  resultWithAttachments<T>(
    content: T,
    attachments: AttachmentInput[]
  ): MethodResultWithAttachments<T>;
}

/**
 * A method result with attached binary payloads.
 * Returned from context.resultWithAttachments().
 */
export interface MethodResultWithAttachments<T> {
  content: T;
  attachments: AttachmentInput[];
}

/**
 * Definition for a method this client provides.
 * Methods are registered at connection time via ConnectOptions.methods.
 * Parameters and returns are Zod schemas for local execution.
 */
export interface MethodDefinition<TArgs extends z.ZodTypeAny = z.ZodTypeAny, TResult = unknown> {
  /** Human-readable description */
  description?: string;
  /** Zod schema for argument validation */
  parameters: TArgs;
  /** Zod schema for result validation (optional) */
  returns?: z.ZodTypeAny;
  /** Whether this method streams partial results */
  streaming?: boolean;
  /** Whether to show this method in participant menu UI */
  menu?: boolean;
  /** Internal methods are callable via callMethod() but not advertised
   *  in participant metadata — they won't appear in discoverMethods()
   *  and won't be exposed as AI model tools. */
  internal?: boolean;
  /** Execute the method. Automatically called when method is invoked. */
  execute(args: z.infer<TArgs>, context: MethodExecutionContext): Promise<TResult>;
}

/** Definition for a method whose parameter contract is already JSON Schema. */
export interface JsonSchemaMethodDefinition<TResult = unknown> {
  description?: string;
  parameters: JsonSchema;
  returns?: JsonSchema;
  streaming?: boolean;
  menu?: boolean;
  internal?: boolean;
  execute(args: unknown, context: MethodExecutionContext): Promise<TResult>;
}

/** Method definitions accepted by transports that advertise or execute methods. */
export type MethodDefinitionLike = MethodDefinition | JsonSchemaMethodDefinition;

/**
 * Options for connecting to an agentic messaging channel.
 */
export interface AgenticConnectOptions {
  /** Pubsub server URL */
  serverUrl: string;
  /** Authentication token */
  token: string;
  /** Channel name to connect to */
  channel: string;
  /**
   * Context ID for channel creation. Required for channel creators (workers).
   * Joiners (panels) get contextId from server's ready message via client.contextId.
   */
  contextId?: string;

  /** Unique handle for @-mentions */
  handle: string;
  /** Display name */
  name: string;
  /** Participant type */
  type: string;

  /** Additional metadata (optional) */
  extraMetadata?: Record<string, unknown>;

  /** Channel config to set when creating a new channel */
  channelConfig?: ChannelConfig;

  /** Methods this participant provides. Automatically executed when called. */
  methods?: Record<string, MethodDefinitionLike>;

  /** Enable auto-reconnection. Pass true for defaults, or a config object. */
  reconnect?: boolean | { delayMs?: number; maxDelayMs?: number; maxAttempts?: number };

  /** Replay behavior: collect (default), stream, or skip */
  replayMode?: "collect" | "stream" | "skip";

  /**
   * Resume replay from a specific pubsub message ID (for checkpoint-based recovery).
   *
   * When provided (and replayMode !== "skip"), the server replays messages starting
   * from this ID instead of from the beginning. This enables agents to store their
   * last processed pubsub ID and resume without full replay on restart.
   *
   * - undefined: Full replay from beginning (default for "collect"/"stream" modes)
   * - number: Resume from this checkpoint (server sends messages with id > replaySinceId)
   */
  replaySinceId?: number;

  /** Limit initial replay to the N most recent chat messages (server computes anchor). Only applies when replayMode is not "skip". */
  replayMessageLimit?: number;

  /** This client's ID (for skipOwnMessages filtering) */
  clientId?: string;
  /** Skip messages sent by this client (echo suppression) */
  skipOwnMessages?: boolean;
}

export interface SendResult {
  /** UUID for message correlation */
  messageId: string;
  /** Server-assigned ID for checkpointing */
  pubsubId: number | undefined;
}

export interface EventStreamOptions extends EventFilterOptions {
  includeReplay?: boolean;
  includeSignals?: boolean;
}

export type EventStreamItem = IncomingEvent;

/**
 * Agentic messaging client.
 * Provides messaging, tool discovery, and tool invocation APIs.
 */
export interface AgenticClient<T extends AgenticParticipantMetadata = AgenticParticipantMetadata> {
  // === Identity ===
  readonly handle: string;
  readonly clientId: string | null;

  // === Channel Info ===
  /** Context ID for this channel (from server ready message, authoritative) */
  readonly contextId: string | undefined;
  /** Channel name */
  readonly channel: string;

  // === Session State (undefined if contextId not available from server) ===
  /** Whether session persistence is enabled and operational */
  readonly sessionEnabled: boolean;
  readonly sessionKey: string | undefined;
  readonly checkpoint: number | undefined;
  readonly sdkSessionId: string | undefined;
  readonly status: "active" | "interrupted" | undefined;

  // === Events ===
  events(options?: EventStreamOptions): AsyncIterableIterator<EventStreamItem>;

  // === Two-Phase Commit ===
  commitCheckpoint(pubsubId: number): Promise<void>;
  updateSdkSession(sessionId: string): Promise<void>;
  clearSdkSession(): Promise<void>;

  // === Messaging ===
  send(
    content: string,
    options?: {
      replyTo?: string;
      attachments?: AttachmentInput[];
      contentType?: string;
      /** IDs of intended recipients (omit for broadcast to all) */
      mentions?: string[];
      /** Resolve @handle mentions to participant IDs */
      resolveHandles?: boolean;
    }
  ): Promise<SendResult>;

  error(id: string, error: string, code?: string): Promise<number | undefined>;

  // === Settings Persistence ===
  updateSettings(settings: Record<string, unknown>): Promise<void>;
  getSettings<T = Record<string, unknown>>(): Promise<T | null>;

  // === Method Discovery & Invocation ===
  discoverMethodDefs(): DiscoveredMethod[];
  discoverMethodDefsFrom(providerId: string): DiscoveredMethod[];
  callMethod(
    providerId: string,
    methodName: string,
    args: unknown,
    options?: {
      signal?: AbortSignal;
      validateArgs?: z.ZodTypeAny;
      invocationId?: string;
      transportCallId?: string;
      turnId?: string;
      timeoutMs?: number;
    }
  ): MethodCallHandle;
  cancelMethodCall(callId: string): Promise<void>;

  // === Roster ===
  readonly roster: Record<string, Participant<T>>;
  resolveHandles(handles: string[]): string[];
  getParticipantByHandle(handle: string): string | undefined;
  onRoster(handler: (roster: RosterUpdate<T>) => void): () => void;

  // === Channel Config ===
  /** Channel config (from server ready message) */
  readonly channelConfig: ChannelConfig | undefined;

  // === Channel Title ===
  /** Set the channel title (updates channel config) */
  setChannelTitle(title: string): Promise<void>;
  /** Subscribe to title changes (via channel config updates) */
  onTitleChange(handler: (title: string) => void): () => void;

  // === Pagination ===
  /** Total message count (from server ready message, for pagination) */
  readonly totalMessageCount: number | undefined;
  /** Count of replayable channel envelopes. */
  readonly envelopeCount: number | undefined;
  /** Sequence of the first replayable channel envelope. */
  readonly firstEnvelopeSeq: number | undefined;
  /** Whether the server reported older envelopes before the initial replay window. */
  readonly hasMoreBefore: boolean | undefined;
  /** Get older channel envelopes before a sequence. */
  getReplayBefore(beforeSeq: number, limit?: number): Promise<ChannelReplayEnvelope>;

  // === Lifecycle ===
  readonly connected: boolean;
  readonly reconnecting: boolean;
  close(): Promise<void>;
  onError(handler: (error: Error) => void): () => void;
  onDisconnect(handler: () => void): () => void;
  onReconnect(handler: () => void): () => void;
  /** Register ready handler (called on every ready message, including reconnects). Returns unsubscribe function. */
  onReady(handler: () => void): () => void;

  // === Metadata ===
  /** Update this participant's metadata */
  updateMetadata(metadata: T): Promise<void>;

  // === Low-level ===
  /** Publish a custom event to the channel */
  publish(
    eventType: string,
    payload: unknown,
    options?: { idempotencyKey?: string }
  ): Promise<void>;
}

/**
 * Status of an execution pause.
 */
export type PauseStatus = "paused" | "resumed" | "cancelled";
