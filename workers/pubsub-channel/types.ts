/**
 * Types for the PubSub Channel DO.
 */

import { z } from "zod";
import type {
  ChannelEvent,
  ChannelReplayEnvelope,
  SendMessageOptions,
} from "@workspace/pubsub";
import { MAX_CHANNEL_REPLAY_PAGE_LIMIT } from "@workspace/pubsub";

const METHOD_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const RESERVED_METHOD_NAMES = new Set([
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

/** Subscribe-time participant metadata validation (WS2 §8.4). Unknown metadata
 * keys pass through, while every advertised method uses the canonical shape. */
export const participantMetadataSchema = z
  .object({
    name: z.string().optional(),
    type: z.string().optional(),
    handle: z.string().regex(METHOD_NAME_PATTERN).optional(),
    roles: z.array(z.string()).optional(),
    methods: z
      .array(
        z
          .object({
            name: z
              .string()
              .regex(METHOD_NAME_PATTERN, {
                message:
                  "method names must match /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/",
              })
              .refine((name) => !RESERVED_METHOD_NAMES.has(name), {
                message:
                  "method name collides with a built-in tool name (read, edit, write, grep, find, ls)",
              }),
          })
          .passthrough(),
      )
      .optional(),
    contextId: z.string().optional(),
    channelConfig: z.record(z.string(), z.unknown()).optional(),
    replay: z.boolean().optional(),
    sinceId: z.number().int().nonnegative().optional(),
    replayMessageLimit: z
      .number()
      .int()
      .positive()
      .max(MAX_CHANNEL_REPLAY_PAGE_LIMIT)
      .optional(),
  })
  .passthrough();

/** Result from subscribing a DO participant. */
export interface SubscribeResult {
  ok: boolean;
  /** Authoritative channel actor id. Human callers are canonicalized to
   * `user:<verifiedUserId>` regardless of their delivery endpoint. */
  participantId: string;
  revision?: number;
  channelConfig?: Record<string, unknown>;
  envelope?: ChannelReplayEnvelope;
}

export type DeliveryEndpoint =
  | { kind: "entity"; entityId: string; invocation: "direct" | "mailbox" }
  | { kind: "session" };

export interface VersionedApplicationConfig {
  version: number;
  value: unknown;
}

export interface ChannelJoinInput {
  participantId: string;
  revision: number;
  contextId: string;
  metadata: Record<string, unknown>;
  delivery: "all" | "addressed" | "none";
  endpoint: DeliveryEndpoint;
  applicationConfig: VersionedApplicationConfig | null;
  replay: boolean;
}

export interface ChannelRelationshipPayload {
  participantId: string;
  revision: number;
  delivery?: "all" | "addressed" | "none";
  endpoint?: DeliveryEndpoint;
  metadata?: Record<string, unknown>;
  applicationConfig?: VersionedApplicationConfig | null;
  detachAfterSequence?: number;
}

/** Participant info stored in the participants table. */
export interface ParticipantInfo {
  id: string;
  metadata: Record<string, unknown>;
  transport: "rpc" | "do";
  connectedAt: number;
}

/**
 * An authorization boundary independent of the live roster. Exact participant
 * identities are fixed by a host-owned initialization operation; subscribing
 * still requires each participant to prove that identity.
 */
export interface LockedChannelMembershipPolicy {
  kind: "locked";
  participants: string[];
}

/** Channel config (mirrors PubSub client ChannelConfig). */
export interface ChannelConfig {
  title?: string;
  /** True when the title came from an explicit title command. */
  titleExplicit?: boolean;
  approvalLevel?: number;
  /** Multi-agent conversation policy: "open" | "directed" | "moderated". */
  conversationPolicy?: string;
  /** Cap on consecutive agent-to-agent replies in one causal chain. */
  agentHopLimit?: number;
  /** Named channel policies (fixed registry); default agentic.conversation.v1. */
  policies?: string[];
  /** Optional host-owned authorization boundary for private channels. */
  membershipPolicy?: LockedChannelMembershipPolicy;
  [key: string]: unknown;
}

/** Presence event payload stored in messages table. */
export interface PresencePayload {
  action: "join" | "leave" | "update";
  ref: import("@workspace/agentic-protocol").ParticipantRef;
  metadata: Record<string, unknown>;
  leaveReason?: "graceful" | "disconnect" | "replaced";
}

/** Metadata passed alongside a ChannelEvent to broadcast(). */
export interface BroadcastEnvelope {
  kind: "log" | "signal";
  phase?: "replay" | "live";
  ref?: number;
}

/** Attachment stored in messages table (JSON). */
export interface StoredAttachment {
  id: string;
  data: string; // base64
  mimeType: string;
  name?: string;
  size: number;
}

/** Event delivered to agent DOs via callDoTarget. Same as ChannelEvent from harness/types. */
export type { ChannelEvent, SendMessageOptions };
