import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import nodePty from "node-pty";
import { nodeSetInterval, nodeSetTimeout } from "./nodeTimers.js";
import { createDetectionState, scanChunk, type DetectionState } from "./portDetector.js";
import type { OpenRequest, ScrollCursor, SessionInfo, SessionInfoEvent } from "./types.js";

type PtyProcess = {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
};

type Listener = (chunk: Uint8Array | null) => void;

interface Session {
  id: string;
  ownerCallerId: string;
  ownerKind: string;
  label: string;
  command: { argv: string[]; cwd: string };
  contextId?: string;
  revisionLabel?: string;
  pid: number;
  cols: number;
  rows: number;
  startedAt: number;
  lastActivityAt: number;
  alive: boolean;
  exit?: { code: number | null; signal?: string; at: number };
  pty?: PtyProcess;
  chunks: Array<{ start: number; end: number; bytes: Uint8Array }>;
  cursor: number;
  scrollbackLimit: number;
  bytesOut: number;
  detection: DetectionState;
  meta: Record<string, unknown>;
  listeners: Set<Listener>;
  exitWaiters: Array<(value: { exitCode: number | null; signal?: string }) => void>;
  unacknowledgedChars: number;
  flowPaused: boolean;
}

export interface SessionManagerHooks {
  onExit?(sessionId: string): void;
  onDispose?(sessionId: string): void;
}

export interface SessionManagerOptions {
  janitorIntervalMs?: number;
  exitedSessionTtlMs?: number;
  watchAllHeartbeatMs?: number;
  /**
   * Resolve display-only `detectedAgent` metadata from structured argv.
   * Omitted ⇒ no agent tagging.
   */
  detectAgent?: (argv: string[]) => { kind: string; title?: string } | undefined;
  /** Resolve a context's exact semantic-state label. Non-context sessions
   * retain a best-effort local Git branch label. */
  resolveContextRevision?: (contextId: string) => Promise<string | undefined>;
}

const SCROLLBACK_BYTES = 256 * 1024;
const MAX_SCROLLBACK_BYTES = 8 * 1024 * 1024;
const META_BYTES = 16 * 1024;
const EXITED_SESSION_TTL_MS = 60 * 60_000;
const JANITOR_INTERVAL_MS = 30 * 60_000;
const WATCH_ALL_HEARTBEAT_MS = 15_000;
const CLEAR_SCREEN = new TextEncoder().encode("\x1b[2J\x1b[H");
const FLOW_CONTROL_HIGH_WATERMARK_CHARS = 100000;
const FLOW_CONTROL_LOW_WATERMARK_CHARS = 5000;

type Watcher = {
  ownerCallerId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat?: NodeJS.Timeout;
};

type PendingSnapshot = {
  session: Session;
  timer: NodeJS.Timeout;
};

function cursorFrom(value: ScrollCursor | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private allWatchers = new Set<Watcher>();
  private lastSnapshotAt = new Map<string, number>();
  private pendingSnapshots = new Map<string, PendingSnapshot>();
  private readonly pty = nodePty as {
    spawn: (file: string, args: string[], opts: unknown) => PtyProcess;
  };
  private janitor: NodeJS.Timeout;
  private exitedSessionTtlMs: number;
  private watchAllHeartbeatMs: number;
  private readonly detectAgent?: (argv: string[]) => { kind: string; title?: string } | undefined;
  private readonly resolveContextRevision?: (contextId: string) => Promise<string | undefined>;

  constructor(
    private readonly hooks: SessionManagerHooks = {},
    opts: SessionManagerOptions = {}
  ) {
    this.exitedSessionTtlMs = opts.exitedSessionTtlMs ?? EXITED_SESSION_TTL_MS;
    this.watchAllHeartbeatMs = opts.watchAllHeartbeatMs ?? WATCH_ALL_HEARTBEAT_MS;
    this.detectAgent = opts.detectAgent;
    this.resolveContextRevision = opts.resolveContextRevision;
    this.janitor = nodeSetInterval(
      () => this.sweepExitedSessions(),
      opts.janitorIntervalMs ?? JANITOR_INTERVAL_MS
    );
    this.janitor.unref?.();
  }

  get ptyAvailable(): boolean {
    return !!this.pty;
  }

  open(
    req: Omit<OpenRequest, "cwd" | "env"> & {
      cwd: string;
      env: NodeJS.ProcessEnv;
      contextId?: string;
    },
    owner: { callerId: string; callerKind: string }
  ): { sessionId: string } {
    const id = randomUUID();
    const command = req.command ?? process.env["SHELL"] ?? "/bin/bash";
    const args = req.args ?? [];
    const label = req.label ?? [command, ...args].join(" ");
    const session: Session = {
      id,
      ownerCallerId: owner.callerId,
      ownerKind: owner.callerKind,
      label,
      command: { argv: [command, ...args], cwd: req.cwd },
      ...(req.contextId ? { contextId: req.contextId } : {}),
      pid: -1,
      cols: req.cols,
      rows: req.rows,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      alive: true,
      chunks: [],
      cursor: 0,
      scrollbackLimit: SCROLLBACK_BYTES,
      bytesOut: 0,
      detection: createDetectionState(),
      meta: {},
      listeners: new Set(),
      exitWaiters: [],
      unacknowledgedChars: 0,
      flowPaused: false,
    };

    const pty = this.pty.spawn(command, args, {
      name: "xterm-256color",
      cols: req.cols,
      rows: req.rows,
      cwd: req.cwd,
      env: req.env,
    });
    session.pid = pty.pid;
    session.pty = pty;
    pty.onData((data) => this.record(session, Buffer.from(data)));
    pty.onExit((event) =>
      this.markExit(session, event.exitCode, event.signal ? `SIG${event.signal}` : undefined)
    );
    this.sessions.set(id, session);
    this.emitToOwner(session.ownerCallerId, {
      type: "opened",
      sessionId: id,
      info: this.info(session),
    });
    this.refreshRevisionLabel(session);
    return { sessionId: id };
  }

  requireOwner(sessionId: string, ownerCallerId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw Object.assign(new Error("Unknown session"), { code: "ENOENT" });
    if (session.ownerCallerId !== ownerCallerId) {
      throw Object.assign(new Error("Not the session owner"), { code: "EACCES" });
    }
    return session;
  }

  list(ownerCallerId: string): SessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((session) => session.ownerCallerId === ownerCallerId)
      .map((session) => this.info(session));
  }

  info(session: Session): SessionInfo {
    const detectedAgent = this.detectAgent?.(session.command.argv);
    return {
      sessionId: session.id,
      ownerCallerId: session.ownerCallerId,
      label: session.label,
      command: session.command,
      ...(session.contextId ? { contextId: session.contextId } : {}),
      ...(session.revisionLabel ? { revisionLabel: session.revisionLabel } : {}),
      pid: session.pid,
      pgid: session.pid,
      cols: session.cols,
      rows: session.rows,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      alive: session.alive,
      ...(session.exit ? { exit: session.exit } : {}),
      processTree: [],
      listeningPorts: [],
      detectedPorts: session.detection.detectedPorts,
      detectedUrls: session.detection.detectedUrls,
      bytesOut: session.bytesOut,
      meta: session.meta,
      ...(detectedAgent ? { detectedAgent } : {}),
    };
  }

  dispose(session: Session): void {
    this.clearPendingSnapshot(session.id);
    session.pty?.kill("SIGTERM");
    for (const listener of session.listeners) listener(null);
    session.listeners.clear();
    for (const waiter of session.exitWaiters.splice(0)) {
      waiter({ exitCode: session.exit?.code ?? null, signal: session.exit?.signal });
    }
    this.sessions.delete(session.id);
    this.lastSnapshotAt.delete(session.id);
    this.hooks.onDispose?.(session.id);
    this.emitToOwner(session.ownerCallerId, { type: "disposed", sessionId: session.id });
  }

  ownerOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.ownerCallerId;
  }

  ownerFor(sessionId: string): { callerId: string; callerKind: string } | undefined {
    const session = this.sessions.get(sessionId);
    return session ? { callerId: session.ownerCallerId, callerKind: session.ownerKind } : undefined;
  }

  cwdOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.command.cwd;
  }

  contextIdOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.contextId;
  }

  setLabel(session: Session, label: string): void {
    session.label = label.slice(0, 80);
    this.emitSnapshot(session);
  }

  restart(
    session: Session,
    req: { env: NodeJS.ProcessEnv; cols?: number; rows?: number; command?: string; args?: string[] }
  ): { sessionId: string } {
    const [originalCommand, ...originalArgs] = session.command.argv;
    const command = req.command ?? originalCommand;
    const args = req.args ?? originalArgs;
    return this.open(
      {
        command,
        args,
        cwd: session.command.cwd,
        env: req.env,
        cols: req.cols ?? session.cols,
        rows: req.rows ?? session.rows,
        label: session.label,
        ...(session.contextId ? { contextId: session.contextId } : {}),
      },
      { callerId: session.ownerCallerId, callerKind: session.ownerKind }
    );
  }

  write(session: Session, data: string): void {
    session.pty?.write(data);
  }

  resize(session: Session, cols: number, rows: number): void {
    session.cols = cols;
    session.rows = rows;
    session.pty?.resize(cols, rows);
    this.emitSnapshot(session);
  }

  kill(session: Session, signal: NodeJS.Signals = "SIGTERM"): void {
    session.pty?.kill(signal);
  }

  getScrollback(
    session: Session,
    maxBytes = session.scrollbackLimit
  ): { text: string; cursor: ScrollCursor } {
    const boundedMaxBytes = Math.min(MAX_SCROLLBACK_BYTES, Math.max(1024, maxBytes));
    const start = Math.max(0, session.cursor - boundedMaxBytes);
    const parts = session.chunks
      .filter((chunk) => chunk.end > start)
      .map((chunk) =>
        chunk.start < start ? chunk.bytes.subarray(start - chunk.start) : chunk.bytes
      );
    return {
      text: Buffer.concat(parts.map((part) => Buffer.from(part))).toString("utf8"),
      cursor: String(session.cursor),
    };
  }

  setScrollbackLimit(session: Session, maxBytes: number): void {
    session.scrollbackLimit = Math.min(MAX_SCROLLBACK_BYTES, Math.max(1024, Math.floor(maxBytes)));
    this.trimScrollback(session);
    this.emitSnapshot(session);
  }

  clearScrollback(session: Session): void {
    session.chunks = [];
    session.cursor = 0;
    for (const listener of session.listeners) listener(CLEAR_SCREEN);
    this.emitSnapshot(session);
  }

  attach(session: Session, opts?: { after?: ScrollCursor }): Response {
    const after = cursorFrom(opts?.after);
    const startCursor = after ?? session.cursor;
    const replay = session.chunks
      .filter((chunk) => chunk.end > startCursor)
      .map((chunk) =>
        chunk.start < startCursor ? chunk.bytes.subarray(startCursor - chunk.start) : chunk.bytes
      );
    let listener: Listener | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.resetFlowControl(session);
        for (const bytes of replay) controller.enqueue(bytes);
        if (!session.alive) {
          controller.close();
          return;
        }
        listener = (chunk) => {
          if (chunk) {
            this.noteAttachedOutput(session, chunk.byteLength);
            controller.enqueue(chunk);
          } else {
            controller.close();
          }
        };
        session.listeners.add(listener);
      },
      cancel: () => {
        if (listener) session.listeners.delete(listener);
        if (session.listeners.size === 0) this.resetFlowControl(session);
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/octet-stream" },
    });
  }

  acknowledgeDataEvent(session: Session, charCount: number): void {
    if (!Number.isFinite(charCount) || charCount <= 0) return;
    session.unacknowledgedChars = Math.max(0, session.unacknowledgedChars - Math.floor(charCount));
    if (session.flowPaused && session.unacknowledgedChars <= FLOW_CONTROL_LOW_WATERMARK_CHARS) {
      session.flowPaused = false;
      session.pty?.resume();
    }
  }

  awaitExit(session: Session): Promise<{ exitCode: number | null; signal?: string }> {
    if (!session.alive)
      return Promise.resolve({
        exitCode: session.exit?.code ?? null,
        signal: session.exit?.signal,
      });
    return new Promise((resolve) => session.exitWaiters.push(resolve));
  }

  watchInfo(session: Session): Response {
    const encoder = new TextEncoder();
    let timer: NodeJS.Timeout | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = () =>
          controller.enqueue(encoder.encode(`${JSON.stringify(this.info(session))}\n`));
        send();
        timer = nodeSetInterval(send, 1000);
      },
      cancel: () => {
        if (timer) clearInterval(timer);
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
  }

  watchAllInfo(ownerCallerId: string): Response {
    let watcher: Watcher | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        watcher = {
          ownerCallerId,
          controller,
        };
        this.allWatchers.add(watcher);
        this.sendToWatcher(watcher, { type: "snapshot-batch", sessions: this.list(ownerCallerId) });
      },
      cancel: () => {
        if (!watcher) return;
        if (watcher.heartbeat) clearTimeout(watcher.heartbeat);
        this.allWatchers.delete(watcher);
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
  }

  setMeta(session: Session, key: string, value: unknown): void {
    const next = { ...session.meta, [key]: value };
    this.assertMetaSize(next);
    session.meta = next;
    this.emitSnapshot(session);
  }

  getMeta(session: Session, key?: string): unknown {
    return key ? session.meta[key] : session.meta;
  }

  deleteMeta(session: Session, key: string): void {
    if (!(key in session.meta)) return;
    const next = { ...session.meta };
    delete next[key];
    session.meta = next;
    this.emitSnapshot(session);
  }

  setMetaById(sessionId: string, key: string, value: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw Object.assign(new Error("Unknown session"), { code: "ENOENT" });
    this.setMeta(session, key, value);
  }

  getMetaById(sessionId: string, key?: string): unknown {
    const session = this.sessions.get(sessionId);
    if (!session) throw Object.assign(new Error("Unknown session"), { code: "ENOENT" });
    return this.getMeta(session, key);
  }

  deleteMetaById(sessionId: string, key: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw Object.assign(new Error("Unknown session"), { code: "ENOENT" });
    this.deleteMeta(session, key);
  }

  setLabelById(sessionId: string, label: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw Object.assign(new Error("Unknown session"), { code: "ENOENT" });
    this.setLabel(session, label);
  }

  writeById(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw Object.assign(new Error("Unknown session"), { code: "ENOENT" });
    this.write(session, text);
  }

  sweepExitedSessionsForTest(): void {
    this.sweepExitedSessions();
  }

  private refreshRevisionLabel(session: Session): void {
    // Context sessions display their exact semantic working head. Only
    // non-context sessions probe a local `.git` checkout.
    const probe =
      session.contextId && this.resolveContextRevision
        ? this.resolveContextRevision(session.contextId)
        : readGitBranch(session.command.cwd);
    void probe.then((branch) => {
      if (!branch) return;
      const current = this.sessions.get(session.id);
      if (current !== session) return;
      session.revisionLabel = branch;
      this.emitSnapshot(session);
    });
  }

  private record(session: Session, bytes: Uint8Array): void {
    const chunk = new Uint8Array(bytes);
    const start = session.cursor;
    session.cursor += chunk.byteLength;
    session.bytesOut += chunk.byteLength;
    session.lastActivityAt = Date.now();
    session.chunks.push({ start, end: session.cursor, bytes: chunk });
    this.trimScrollback(session);
    scanChunk(session.detection, chunk);
    for (const listener of session.listeners) listener(chunk);
    this.emitSnapshot(session);
  }

  private noteAttachedOutput(session: Session, charCount: number): void {
    if (!session.listeners.size || session.flowPaused) return;
    session.unacknowledgedChars += charCount;
    if (session.unacknowledgedChars <= FLOW_CONTROL_HIGH_WATERMARK_CHARS) return;
    session.flowPaused = true;
    session.pty?.pause();
  }

  private resetFlowControl(session: Session): void {
    session.unacknowledgedChars = 0;
    if (!session.flowPaused) return;
    session.flowPaused = false;
    session.pty?.resume();
  }

  private markExit(session: Session, code: number | null, signal?: string): void {
    this.clearPendingSnapshot(session.id);
    session.alive = false;
    session.exit = { code, ...(signal ? { signal } : {}), at: Date.now() };
    for (const waiter of session.exitWaiters.splice(0)) waiter({ exitCode: code, signal });
    for (const listener of session.listeners) listener(null);
    session.listeners.clear();
    this.hooks.onExit?.(session.id);
    this.emitToOwner(session.ownerCallerId, {
      type: "exit",
      sessionId: session.id,
      exit: session.exit,
    });
    this.emitSnapshotNow(session);
  }

  private trimScrollback(session: Session): void {
    const start = Math.max(0, session.cursor - session.scrollbackLimit);
    while (session.chunks.length && session.chunks[0]!.end <= start) {
      session.chunks.shift();
    }
    const first = session.chunks[0];
    if (first && first.start < start) {
      const offset = start - first.start;
      session.chunks[0] = { start, end: first.end, bytes: first.bytes.subarray(offset) };
    }
  }

  private emitSnapshot(session: Session): void {
    const now = Date.now();
    const last = this.lastSnapshotAt.get(session.id) ?? 0;
    const elapsed = now - last;
    if (elapsed >= 1000) {
      this.emitSnapshotNow(session);
      return;
    }
    if (this.pendingSnapshots.has(session.id)) return;
    const timer = nodeSetTimeout(() => {
      this.pendingSnapshots.delete(session.id);
      if (this.sessions.has(session.id)) this.emitSnapshotNow(session);
    }, 1000 - elapsed);
    timer.unref?.();
    this.pendingSnapshots.set(session.id, { session, timer });
  }

  private emitSnapshotNow(session: Session): void {
    this.lastSnapshotAt.set(session.id, Date.now());
    this.emitToOwner(session.ownerCallerId, {
      type: "snapshot",
      sessionId: session.id,
      info: this.info(session),
    });
  }

  private clearPendingSnapshot(sessionId: string): void {
    const pending = this.pendingSnapshots.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingSnapshots.delete(sessionId);
  }

  private emitToOwner(ownerCallerId: string, event: SessionInfoEvent): void {
    for (const watcher of this.allWatchers) {
      if (watcher.ownerCallerId !== ownerCallerId) continue;
      try {
        this.sendToWatcher(watcher, event);
      } catch {
        if (watcher.heartbeat) clearTimeout(watcher.heartbeat);
        this.allWatchers.delete(watcher);
      }
    }
  }

  private sendToWatcher(watcher: Watcher, event: SessionInfoEvent): void {
    watcher.controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
    if (watcher.heartbeat) clearTimeout(watcher.heartbeat);
    watcher.heartbeat = nodeSetTimeout(() => {
      try {
        this.sendToWatcher(watcher, { type: "heartbeat", at: Date.now() });
      } catch {
        if (watcher.heartbeat) clearTimeout(watcher.heartbeat);
        this.allWatchers.delete(watcher);
      }
    }, this.watchAllHeartbeatMs);
    watcher.heartbeat.unref?.();
  }

  private sweepExitedSessions(): void {
    const cutoff = Date.now() - this.exitedSessionTtlMs;
    for (const session of this.sessions.values()) {
      if (!session.alive && session.lastActivityAt < cutoff && session.listeners.size === 0) {
        this.dispose(session);
      }
    }
  }

  private assertMetaSize(meta: Record<string, unknown>): void {
    const bytes = Buffer.byteLength(JSON.stringify(meta), "utf8");
    if (bytes > META_BYTES) {
      throw Object.assign(new Error("Session metadata exceeds 16KB"), { code: "E2BIG" });
    }
  }
}

function readGitBranch(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (branch?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(branch);
    };
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      finish();
    }, 500);
    try {
      child = spawn("git", ["-C", cwd, "branch", "--show-current"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < 1024) stdout += chunk.toString("utf8");
      });
      child.on("error", () => finish());
      child.on("close", (code) => {
        const branch = stdout.trim();
        finish(code === 0 && branch ? branch.slice(0, 120) : undefined);
      });
    } catch {
      // Branch context is a UI affordance only; session startup should not fail if git is unavailable.
      finish();
    }
  });
}
