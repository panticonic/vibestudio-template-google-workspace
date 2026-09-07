/**
 * Types for the PubSub client.
 */

import type { SandboxSource } from "./tracker-types.js";
import type { ChannelInvite as WorkspaceChannelInvite } from "@vibestudio/shared/channelInvites";
import type { ParticipantRef } from "@workspace/agentic-protocol";

/**
 * Channel configuration persisted with the channel.
 * Set when the channel is created, readable by all participants.
 *
 * Note: contextId is NOT part of ChannelConfig. The server sends contextId
 * as a separate top-level field in the ready message. Access it via client.contextId.
 */
export interface ChannelConfig {
  title?: string;
  /** True when the title came from an explicit title command. */
  titleExplicit?: boolean;
  approvalLevel?: 0 | 1 | 2; // 0=Ask All, 1=Auto-Safe, 2=Full Auto (default)
  /** Multi-agent conversation policy: "open" | "directed" | "moderated". */
  conversationPolicy?: "open" | "directed" | "moderated";
  /** Cap on consecutive agent-to-agent replies in one causal chain. */
  agentHopLimit?: number;
}

/** Event-sequence decision context carried by one durable channel delivery.
 * It is derived beside recipient selection, so admission never consults newer
 * channel state or performs a serialized channel read. */
export interface ChannelAgenticContext {
  version: 1;
  relationships: Array<{
    participantId: string;
    metadata: Record<string, unknown>;
    applicationConfig: { version: number; value: unknown } | null;
  }>;
  channelConfig: ChannelConfig;
  conversation: {
    lastCompletedSender: string | null;
    lastCompletedMessageId: string | null;
    lastCompletedSeq: number | null;
    previousCompletedSender: string | null;
    previousCompletedMessageId: string | null;
    previousCompletedSeq: number | null;
    agentStreak: number;
  };
  replyToSenderId: string | null;
}

/**
 * Input for sending a binary attachment (ID assigned by server).
 * Use this when publishing messages with attachments.
 */
export interface AttachmentInput {
  /** Binary data */
  data: Uint8Array;
  /** MIME type (e.g., "image/png", "application/octet-stream") */
  mimeType: string;
  /** Optional filename */
  name?: string;
}

/**
 * A binary attachment with server-assigned metadata.
 * This is what you receive in messages - the server assigns the ID.
 */
export interface Attachment extends AttachmentInput {
  /** Server-assigned unique ID (e.g., "img_1", "img_2") */
  id: string;
}

export type LogRootKind = "chat" | "method" | "presence" | "system";

export interface StoredChannelAttachment {
  id: string;
  type?: string;
  data: string;
  mimeType: string;
  filename?: string;
  size: number;
}

export interface ServerLogEvent<T = unknown> {
  id: number;
  messageId: string;
  type: string;
  payload: T;
  senderId: string;
  senderMetadata?: Record<string, unknown>;
  /** Host-attested content provenance preserved across live delivery and replay. */
  contentClass?: "internal" | "external";
  /** Exact outside-content lineage at publication time. */
  externalKeys?: string[];
  contentType?: string;
  ts: number;
  attachments?: StoredChannelAttachment[];
  /** Durable envelope annotations used by channel policy folds. */
  annotations?: Record<string, unknown>;
}

/** Canonical durable channel event shared by the service and agent runtime. */
export type ChannelEvent<T = unknown> = ServerLogEvent<T>;

/** Options accepted by the Durable Object channel publication boundary. */
export interface SendMessageOptions {
  contentType?: string;
  senderMetadata?: Record<string, unknown>;
  replyTo?: string;
  idempotencyKey?: string;
  attachments?: Array<{ data: string; mimeType: string }>;
}

export interface ParticipantSnapshot {
  id: string;
  /** Canonical identity assigned by the channel, never reconstructed by consumers. */
  ref: ParticipantRef;
  metadata: Record<string, unknown>;
}

export type BootstrapSnapshot =
  | {
      kind: "roster-snapshot";
      participants: ParticipantSnapshot[];
      ts: number;
    }
  | {
      /** Durable receipt projection, emitted after replayed log events so it
       * never creates receipt traffic or mailbox work of its own. */
      kind: "receipt-snapshot";
      events: ServerLogEvent[];
      ts: number;
    };

export interface ReplayReady {
  contextId?: string;
  channelConfig?: ChannelConfig;
  totalCount: number;
  envelopeCount: number;
  firstEnvelopeSeq?: number;
  replayFromId?: number;
  replayToId?: number;
  /** Stable high-water mark captured by the first forward page. */
  snapshotLastSeq?: number;
  hasMoreBefore?: boolean;
  hasMoreAfter?: boolean;
}

/** Every replay RPC returns at most one bounded page. */
export const DEFAULT_CHANNEL_REPLAY_PAGE_LIMIT = 500;
export const MAX_CHANNEL_REPLAY_PAGE_LIMIT = 500;

/** One bounded, stable forward-replay page. Follow `ready.hasMoreAfter` with
 * `after=ready.replayToId` and the same `throughSeq=ready.snapshotLastSeq`. */
export interface ChannelReplayAfterRequest {
  after: number;
  limit?: number;
  throughSeq?: number;
}

export interface ChannelReplayEnvelope {
  mode: "initial" | "after" | "before";
  logEvents: ServerLogEvent[];
  snapshots: BootstrapSnapshot[];
  ready: ReplayReady;
}

export interface ChannelMember {
  userId: string;
  memberId: string;
  handle: string;
  addedBy: string;
  addedAt: number;
}

export type ChannelInvite = WorkspaceChannelInvite;

export type ChannelPresenceStatus = "online" | "idle" | "away" | "offline";

export interface ChannelPresenceEntry {
  participantId: string;
  userId: string;
  status: ChannelPresenceStatus;
  lastActiveAt: number | null;
  lastSeenAt: number | null;
  sessionCount: number;
}

export type CustomMessageDisplayMode = "inline" | "row";

export interface MessageTypeDefinition {
  typeId: string;
  displayMode: CustomMessageDisplayMode;
  source: SandboxSource;
  imports?: Record<string, string>;
  stateSchema?: Record<string, unknown>;
  updateSchema?: Record<string, unknown>;
  registeredBy?: {
    kind: string;
    id: string;
    displayName?: string;
    metadata?: Record<string, unknown>;
  };
  updatedAtSeq: number;
  clearedAtSeq?: number;
}

export interface RegisterMessageTypeInput {
  typeId: string;
  displayMode: CustomMessageDisplayMode;
  source: SandboxSource;
  imports?: Record<string, string>;
  /** JSON Schema for the card's full state. */
  stateSchema?: Record<string, unknown>;
  /** JSON Schema for incremental updates (when the module exports `reduce`). */
  updateSchema?: Record<string, unknown>;
}

/**
 * Error codes for PubSub operations.
 */
export type PubSubErrorCode = "auth" | "validation" | "connection" | "server";

export interface PubSubErrorOptions {
  /** The error from the lower transport/RPC layer, when one exists. */
  cause?: unknown;
  /** A machine-readable code carried by the lower layer. */
  errorCode?: string;
  /** Structured details carried by the lower layer. */
  errorData?: unknown;
}

/**
 * Typed error for PubSub operations.
 * Allows programmatic distinction between different error types.
 */
export class PubSubError extends Error {
  constructor(
    message: string,
    public readonly code: PubSubErrorCode,
    options?: PubSubErrorOptions,
  ) {
    super(message);
    this.name = "PubSubError";
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: options.cause,
        writable: true,
      });
    }
    if (options?.errorCode !== undefined) this.errorCode = options.errorCode;
    if (options?.errorData !== undefined) this.errorData = options.errorData;
  }

  readonly errorCode?: string;
  readonly errorData?: unknown;
}

/**
 * A message received from the PubSub server.
 */
export interface PubSubMessage<T = unknown> {
  /** Transport stream that produced the message. */
  delivery: "log" | "signal";
  /** Log phase, present only for durable log messages. */
  phase?: "replay" | "live";
  /** Message ID (only present for durable log messages) */
  id?: number;
  /** User-defined message type */
  type: string;
  /** Message payload (JSON-serializable value) */
  payload: T;
  /** ID of the sender */
  senderId: string;
  /** Timestamp in milliseconds */
  ts: number;
  /** Binary attachments (separate from JSON payload) */
  attachments?: Attachment[];
  /** Sender metadata snapshot (if available) */
  senderMetadata?: Record<string, unknown>;
  /** Present on durable log messages; absent on ephemeral signals. */
  contentClass?: "internal" | "external";
  externalKeys?: string[];
}

/**
 * Stream marker emitted after replay completes.
 */
export interface ReadyMessage {
  kind: "ready";
  /** Total message count for pagination */
  totalCount?: number;
  /** Count of replayable channel envelopes. */
  envelopeCount?: number;
  /** First replayable channel-envelope sequence. */
  firstEnvelopeSeq?: number;
  /** Whether older envelopes exist before the replayed window. */
  hasMoreBefore?: boolean;
}

export type Message<T = unknown> = PubSubMessage<T> | ReadyMessage;

/**
 * Participant metadata - arbitrary key-value data associated with a connected client.
 */
export type ParticipantMetadata = Record<string, unknown>;

/**
 * A participant in a channel with their metadata.
 */
export interface Participant<
  T extends ParticipantMetadata = ParticipantMetadata,
> {
  /** The client's unique ID */
  id: string;
  /** Canonical identity assigned by the channel. */
  ref: ParticipantRef;
  /** Arbitrary metadata provided by the client on connection */
  metadata: T;
}

/**
 * Reason a participant left the channel.
 * - "graceful": Clean shutdown (e.g., idle timeout, explicit stop)
 * - "disconnect": Unexpected disconnection (crash, network loss)
 * - "replaced": Same participant ID was rebound to a new client session
 */
export type LeaveReason = "graceful" | "disconnect" | "replaced";

/**
 * Describes what triggered a roster update.
 * Present on roster updates caused by a single presence event.
 */
export interface RosterChange {
  /** The type of change */
  type: "join" | "leave" | "update";
  /** The participant ID that changed */
  participantId: string;
  /** Participant metadata at the time of the change */
  metadata?: Record<string, unknown>;
  /** Why the participant left (only present for leave events) */
  leaveReason?: LeaveReason;
}

/**
 * Roster update from the server.
 * Sent whenever a client joins or leaves the channel.
 * This is idempotent - it contains the complete current state.
 */
export interface RosterUpdate<
  T extends ParticipantMetadata = ParticipantMetadata,
> {
  /** Map of client ID to participant info (including metadata) */
  participants: Record<string, Participant<T>>;
  /** Timestamp of the update */
  ts: number;
  /** What triggered this update (absent during initial catch-up emit on handler registration) */
  change?: RosterChange;
  /** Participants that left in this update, with reason (only present on leave events) */
  leaves?: Record<string, { leaveReason?: LeaveReason }>;
}

/**
 * Options for publishing a message.
 */
export interface PublishOptions {
  /** Binary attachments to send alongside JSON payload (server assigns IDs) */
  attachments?: AttachmentInput[];
  /** Caller-provided idempotency key for dedup on retry. Must be stable across retries. */
  idempotencyKey?: string;
}

/**
 * Options for updating participant metadata.
 */
export interface UpdateMetadataOptions {}
