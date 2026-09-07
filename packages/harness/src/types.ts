/**
 * Channel boundary types still used by `@workspace/agentic-do` and the
 * worker DO base. Everything harness-protocol-related has been deleted —
 * Pi runs in-process now.
 */

/** Usage metrics returned after a completed turn. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

import type { StoredChannelAttachment } from "@workspace/pubsub";

export type {
  ChannelEvent,
  SendMessageOptions,
  StoredChannelAttachment as Attachment,
} from "@workspace/pubsub";

/** Input for starting a new agent turn. */
export interface TurnInput {
  content: string;
  senderId: string;
  context?: string;
  attachments?: StoredChannelAttachment[];
}

/** Channel participant identity — returned by subscribeChannel(). */
export interface ParticipantDescriptor {
  /** Stable, unique-within-channel handle. */
  handle: string;
  name: string;
  type: string;
  metadata?: Record<string, unknown>;
  methods?: Array<{
    name: string;
    description: string;
    parameters?: unknown;
  }>;
}

/** Result from unsubscribing a channel. */
export interface UnsubscribeResult {
  ok: true;
}
