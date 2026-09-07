/**
 * Shared WS wire protocol types — used by both the PubSub channel DO
 * (server) and the PubSub client. Single source of truth to prevent drift.
 */

import type {
  BootstrapSnapshot,
  ParticipantSnapshot,
  ReplayReady,
  ServerLogEvent,
} from "./types.js";

// ── Event messages (channel events with transport metadata) ──────────────

export interface RpcLogMessage {
  kind: "log";
  phase: "replay" | "live";
  event: ServerLogEvent;
  ref?: number;
}

export interface RpcRosterSnapshotMessage {
  kind: "control";
  type: "roster-snapshot";
  participants: ParticipantSnapshot[];
  ts: number;
}

export interface RpcReadyMessage {
  kind: "control";
  type: "ready";
  ready: ReplayReady;
}

export interface RpcErrorMessage {
  kind: "control";
  type: "error";
  error: string;
  ref?: number;
}

export interface RpcSignalMessage {
  kind: "signal";
  messageId: string;
  type: string;
  payload: unknown;
  senderId?: string;
  ts: number;
  ref?: number;
}

export type RpcChannelMessage =
  | RpcLogMessage
  | RpcRosterSnapshotMessage
  | RpcReadyMessage
  | RpcErrorMessage
  | RpcSignalMessage;

export function snapshotToRpcControl(
  snapshot: Extract<BootstrapSnapshot, { kind: "roster-snapshot" }>
): RpcRosterSnapshotMessage {
  return {
    kind: "control",
    type: "roster-snapshot",
    participants: snapshot.participants,
    ts: snapshot.ts,
  };
}
