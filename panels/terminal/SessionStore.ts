import { useSyncExternalStore } from "react";
import type { SessionInfo, SessionInfoEvent, ShellApi } from "./types.js";

type Listener = () => void;

export class SessionStore {
  private sessions = new Map<string, SessionInfo>();
  private snapshot: Record<string, SessionInfo> = {};
  private snapshotDirty = false;
  private listeners = new Set<Listener>();
  private sessionListeners = new Map<string, Set<Listener>>();
  private abort?: AbortController;
  private shell?: ShellApi;
  private connectKey?: string;

  getSnapshot = (): Record<string, SessionInfo> => {
    if (this.snapshotDirty) {
      this.snapshot = Object.fromEntries(this.sessions);
      this.snapshotDirty = false;
    }
    return this.snapshot;
  };

  getSessionSnapshot = (sessionId: string): SessionInfo | undefined => this.sessions.get(sessionId);

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeSession = (sessionId: string, listener: Listener): (() => void) => {
    const listeners = this.sessionListeners.get(sessionId) ?? new Set<Listener>();
    listeners.add(listener);
    this.sessionListeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.sessionListeners.delete(sessionId);
    };
  };

  set(session: SessionInfo): void {
    const previous = this.sessions.get(session.sessionId);
    if (previous && sessionInfoEqual(previous, session)) return;
    this.sessions.set(session.sessionId, session);
    this.emit(session.sessionId);
  }

  replace(sessions: Record<string, SessionInfo>): void {
    const previous = this.sessions;
    const previousIds = new Set(previous.keys());
    const nextIds = Object.keys(sessions);
    let globalChanged = previousIds.size !== nextIds.length;
    this.sessions = new Map();
    for (const [sessionId, next] of Object.entries(sessions)) {
      const previousSession = previous.get(sessionId);
      const session = previousSession && sessionInfoEqual(previousSession, next) ? previousSession : next;
      this.sessions.set(sessionId, session);
      if (!previousSession || previousSession !== session) globalChanged = true;
    }
    if (globalChanged) this.emitGlobal();
    for (const sessionId of previousIds) {
      if (!this.sessions.has(sessionId)) this.emit(sessionId);
    }
    for (const sessionId of nextIds) {
      if (!previousIds.has(sessionId) || previous.get(sessionId) !== this.sessions.get(sessionId)) this.emit(sessionId);
    }
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.emit(sessionId);
  }

  connect(shell: ShellApi, fallbackSessionIds: string[] = []): () => void {
    const hasBulk = typeof shell.watchAllSessionInfo === "function";
    const nextKey = hasBulk ? "bulk" : `per-session:${sessionIdsConnectKey(fallbackSessionIds)}`;
    if (this.shell === shell && this.abort && this.connectKey === nextKey) return () => {};
    this.disconnect();
    this.shell = shell;
    this.connectKey = nextKey;
    this.abort = new AbortController();
    if (hasBulk) {
      void this.readBulk(shell, this.abort.signal);
    } else {
      void this.readPerSession(shell, fallbackSessionIds, this.abort.signal);
    }
    return () => this.disconnect();
  }

  disconnect(): void {
    this.abort?.abort();
    this.abort = undefined;
    this.shell = undefined;
    this.connectKey = undefined;
  }

  private async readBulk(shell: ShellApi, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const response = await shell.watchAllSessionInfo!();
        await readNdjson<SessionInfoEvent>(response, signal, (event) => this.applyEvent(event));
      } catch {
        if (!signal.aborted) await delay(1000);
      }
    }
  }

  private async readPerSession(shell: ShellApi, sessionIds: string[], signal: AbortSignal): Promise<void> {
    await Promise.all([...new Set(sessionIds)].map((sessionId) => this.readSingleSession(shell, sessionId, signal)));
  }

  private async readSingleSession(shell: ShellApi, sessionId: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const response = await shell.watchSessionInfo(sessionId);
        await readNdjson<SessionInfo>(response, signal, (info) => this.set(info));
      } catch {
        // Metadata streams are best-effort.
      }
      if (!signal.aborted) await delay(1000);
    }
  }

  private applyEvent(event: SessionInfoEvent): void {
    if (event.type === "snapshot-batch") {
      this.replace(Object.fromEntries(event.sessions.map((session) => [session.sessionId, session])));
    } else if (event.type === "snapshot" || event.type === "opened") {
      this.set(event.info);
    } else if (event.type === "exit") {
      const existing = this.sessions.get(event.sessionId);
      if (existing) this.set({ ...existing, alive: false, exit: event.exit });
    } else if (event.type === "disposed") {
      this.delete(event.sessionId);
    }
  }

  private emit(sessionId?: string): void {
    this.emitGlobal();
    if (!sessionId) {
      for (const listeners of this.sessionListeners.values()) for (const listener of listeners) listener();
      return;
    }
    for (const listener of this.sessionListeners.get(sessionId) ?? []) listener();
  }

  private emitGlobal(): void {
    this.snapshotDirty = true;
    for (const listener of this.listeners) listener();
  }
}

export function sessionIdsConnectKey(sessionIds: string[]): string {
  return [...new Set(sessionIds)].sort().join("\0");
}

export function useAllSessions(store: SessionStore): Record<string, SessionInfo> {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useSession(store: SessionStore, sessionId: string): SessionInfo | undefined {
  return useSyncExternalStore(
    (listener) => store.subscribeSession(sessionId, listener),
    () => store.getSessionSnapshot(sessionId),
    () => store.getSessionSnapshot(sessionId),
  );
}

async function readNdjson<T>(response: Response, signal: AbortSignal, onValue: (value: T) => void): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) onValue(JSON.parse(line) as T);
        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionInfoEqual(a: SessionInfo, b: SessionInfo): boolean {
  return a.sessionId === b.sessionId
    && a.label === b.label
    && a.revisionLabel === b.revisionLabel
    && a.cols === b.cols
    && a.rows === b.rows
    && a.alive === b.alive
    && a.lastActivityAt === b.lastActivityAt
    && a.bytesOut === b.bytesOut
    && arrayEqual(a.command.argv, b.command.argv)
    && a.command.cwd === b.command.cwd
    && arrayEqual(a.detectedPorts, b.detectedPorts)
    && arrayEqual(a.detectedUrls, b.detectedUrls)
    && JSON.stringify(a.exit ?? null) === JSON.stringify(b.exit ?? null)
    && JSON.stringify(a.detectedAgent ?? null) === JSON.stringify(b.detectedAgent ?? null)
    && JSON.stringify(a.meta) === JSON.stringify(b.meta);
}

function arrayEqual<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
