import type { KeybindingOverrides } from "./keybindings.js";

// The shell extension's public API is the single source of truth; the terminal
// panel consumes it under the local `ShellApi` name.
export type { Api as ShellApi } from "@workspace-extensions/shell";

export interface SessionInfo {
  sessionId: string;
  label: string;
  command: { argv: string[]; cwd: string };
  /** Set for context-scoped sessions (placed inside a VCS context folder). */
  contextId?: string;
  revisionLabel?: string;
  cols: number;
  rows: number;
  alive: boolean;
  exit?: { code: number | null; signal?: string; at: number };
  detectedAgent?: { kind: string; title?: string };
  detectedPorts: number[];
  detectedUrls: string[];
  lastActivityAt: number;
  bytesOut: number;
  meta: Record<string, unknown>;
}

export type SessionInfoEvent =
  | { type: "snapshot-batch"; sessions: SessionInfo[] }
  | { type: "snapshot"; sessionId: string; info: SessionInfo }
  | { type: "opened"; sessionId: string; info: SessionInfo }
  | { type: "exit"; sessionId: string; exit: { code: number | null; signal?: string; at: number } }
  | { type: "disposed"; sessionId: string }
  | { type: "heartbeat"; at: number };

export type SplitNode =
  | { kind: "leaf"; sessionId: string }
  | { kind: "split"; direction: "row" | "column"; ratio: number; a: SplitNode; b: SplitNode };

export type NotificationSeverity = "info" | "done" | "waiting" | "approval" | "failure";

export interface TerminalNotification {
  notifId: string;
  sessionId: string;
  severity: NotificationSeverity;
  title?: string;
  message: string;
  timestamp: number;
  read: boolean;
  source?: "osc" | "snug" | "system";
}

export interface PerSessionState {
  label?: string;
  cwd: string;
  originalArgv?: string[];
  readCursor: number;
  lastSeenAt: number;
}

export interface ScratchBuffer {
  bufferId: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

export interface TerminalState {
  /** Stable panel-list title. Session titles and working directories are pane-local metadata. */
  panelTitle: string;
  tree?: SplitNode;
  focusedSessionId?: string;
  zoomedSessionId?: string;
  notifications: TerminalNotification[];
  paletteHistory: string[];
  fontSize: number;
  fontFamily: string;
  scrollbackBytes: number;
  themeOverride: "auto" | "light" | "dark";
  notificationCenterOpen: boolean;
  notificationFilter?: "all" | "approval" | "failure" | "waiting" | "done";
  perSession: Record<string, PerSessionState>;
  pasteMode: "path" | "dataUri" | "both";
  imagePasteRelative: boolean;
  keybindings: KeybindingOverrides;
  scratchBuffers: ScratchBuffer[];
  scratchActiveBufferId?: string;
  scratchOpen: boolean;
  schemaVersion: number;
}
