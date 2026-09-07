/**
 * Commands + incoming union (WS1 §1.3). Commands are the only way external
 * intent enters the loop; everything else arrives as appended events or
 * effect failures.
 */

import type { LogEnvelope, MessageBlockInput, ParticipantRef } from "@workspace/agentic-protocol";
import type { AgentLoopConfig, AgentTurnMetadata, RosterSnapshot } from "./state.js";
import type { EffectKind } from "./effects.js";

export interface SerializedError {
  message: string;
  name?: string;
  stack?: string;
}

export type UserContent = unknown;

export type Command =
  | {
      kind: "prompt";
      channelId: string;
      /** the triggering channel envelope. */
      source: { envelopeId: string };
      /** Sender's canonical message identity (`agentic.causality.messageId`),
       *  threaded explicitly — NOT derived from `ids.recvUserMessage`. Read
       *  acks, edits and retracts all key on this. */
      sourceMessageId?: string;
      content: UserContent;
      structuredInput?: unknown;
      senderRef: ParticipantRef;
      agentHops?: number;
      metadata?: AgentTurnMetadata;
    }
  | {
      /** Terminal infrastructure rejection before a model effect can be created. */
      kind: "prompt-failed";
      channelId: string;
      source: { envelopeId: string };
      sourceMessageId?: string;
      content: UserContent;
      structuredInput?: unknown;
      senderRef: ParticipantRef;
      agentHops?: number;
      metadata?: AgentTurnMetadata;
      reason: string;
      code: string;
    }
  | {
      kind: "steer";
      channelId: string;
      source: { envelopeId: string };
      sourceMessageId?: string;
      content: UserContent;
      structuredInput?: unknown;
      senderRef: ParticipantRef;
      agentHops?: number;
      metadata?: AgentTurnMetadata;
    }
  | {
      /** Journal and execute one exact local tool call without a model request. */
      kind: "invoke";
      channelId: string;
      source: { envelopeId: string };
      tool: string;
      args: unknown;
      metadata?: AgentTurnMetadata;
    }
  | { kind: "interrupt"; flushDeferred?: boolean }
  | { kind: "abort"; reason?: string }
  | { kind: "edit"; sourceMessageId: string; blocks: MessageBlockInput[]; by: ParticipantRef }
  | { kind: "retract"; sourceMessageId: string; by: ParticipantRef }
  | { kind: "setConfig"; patch: Partial<AgentLoopConfig> }
  | { kind: "setRoster"; roster: RosterSnapshot }
  | { kind: "compact" }
  | { kind: "resumeAfterReset"; messageId: string; resetAt: string }
  | { kind: "wake" };

export type Incoming =
  | { type: "command"; command: Command }
  | { type: "event-appended"; envelope: LogEnvelope }
  | {
      type: "effect-failed";
      effectId: string;
      kind: EffectKind;
      error: SerializedError;
      attempts: number;
    };

export interface StepContext {
  /** ISO timestamp chosen by the driver; logged via appendedAt (P4). */
  now: string;
  /** seeded/recorded randomness; only for envelope-less turn salts. */
  random: () => string;
  selfRef: ParticipantRef;
}
