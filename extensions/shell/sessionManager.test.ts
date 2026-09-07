import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "./sessionManager.js";

describe("SessionManager janitor", () => {
  it("returns JSON-safe session info when no terminal agent is detected", async () => {
    const manager = new SessionManager({}, { janitorIntervalMs: 60 * 60_000 });
    const root = await mkdtemp(join(tmpdir(), "session-manager-test-"));
    const owner = { callerId: "panel:test", callerKind: "panel" };
    const opened = manager.open(
      {
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 5000)"],
        cwd: root,
        env: {},
        cols: 80,
        rows: 24,
      },
      owner
    );
    const session = manager.requireOwner(opened.sessionId, owner.callerId);

    const info = manager.info(session);

    expect(Object.hasOwn(info, "detectedAgent")).toBe(false);
    expect(JSON.parse(JSON.stringify(info))).toEqual(info);
    manager.dispose(session);
  });

  it("emits watch-all heartbeats only after an idle interval", async () => {
    vi.useFakeTimers();
    const manager = new SessionManager(
      {},
      { janitorIntervalMs: 60 * 60_000, watchAllHeartbeatMs: 40 }
    );
    const fakePty = new FakePty();
    (
      manager as unknown as {
        pty: { spawn: () => FakePty };
      }
    ).pty = { spawn: () => fakePty };
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      const response = manager.watchAllInfo("panel:test");
      reader = response.body!.getReader();

      await expect(readEvent(reader)).resolves.toMatchObject({
        type: "snapshot-batch",
        sessions: [],
      });

      await vi.advanceTimersByTimeAsync(20);
      const root = await mkdtemp(join(tmpdir(), "session-manager-test-"));
      const opened = manager.open(
        {
          command: process.execPath,
          args: ["-e", "setTimeout(() => {}, 5000)"],
          cwd: root,
          env: {},
          cols: 80,
          rows: 24,
        },
        { callerId: "panel:test", callerKind: "panel" }
      );
      await expect(readEvent(reader)).resolves.toMatchObject({
        type: "opened",
        sessionId: opened.sessionId,
      });

      const heartbeat = readEvent(reader, 100);
      const onHeartbeat = vi.fn();
      heartbeat.then(onHeartbeat, onHeartbeat);
      await vi.advanceTimersByTimeAsync(39);
      expect(onHeartbeat).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(heartbeat).resolves.toMatchObject({ type: "heartbeat" });

      manager.dispose(manager.requireOwner(opened.sessionId, "panel:test"));
    } finally {
      await reader?.cancel();
      vi.useRealTimers();
    }
  });

  it("disposes exited, old, listenerless sessions and preserves live sessions", async () => {
    const onDispose = vi.fn();
    const manager = new SessionManager({ onDispose }, { janitorIntervalMs: 60 * 60_000, exitedSessionTtlMs: 0 });
    const root = await mkdtemp(join(tmpdir(), "session-manager-test-"));
    const owner = { callerId: "panel:test", callerKind: "panel" };
    const live = manager.open({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"], cwd: root, env: {}, cols: 80, rows: 24 }, owner);
    const exited = manager.open({ command: process.execPath, args: ["-e", ""], cwd: root, env: {}, cols: 80, rows: 24 }, owner);

    await manager.awaitExit(manager.requireOwner(exited.sessionId, owner.callerId));
    manager.sweepExitedSessionsForTest();

    expect(onDispose).toHaveBeenCalledWith(exited.sessionId);
    expect(() => manager.requireOwner(exited.sessionId, owner.callerId)).toThrow("Unknown session");
    expect(manager.requireOwner(live.sessionId, owner.callerId)).toBeTruthy();
    manager.dispose(manager.requireOwner(live.sessionId, owner.callerId));
  });

  it("preserves recently exited sessions until the TTL expires", async () => {
    const onDispose = vi.fn();
    const manager = new SessionManager({ onDispose }, { janitorIntervalMs: 60 * 60_000, exitedSessionTtlMs: 60_000 });
    const root = await mkdtemp(join(tmpdir(), "session-manager-test-"));
    const owner = { callerId: "panel:test", callerKind: "panel" };
    const opened = manager.open({ command: process.execPath, args: ["-e", ""], cwd: root, env: {}, cols: 80, rows: 24 }, owner);
    const session = manager.requireOwner(opened.sessionId, owner.callerId);

    await manager.awaitExit(session);
    manager.sweepExitedSessionsForTest();

    expect(onDispose).not.toHaveBeenCalledWith(opened.sessionId);
    expect(manager.requireOwner(opened.sessionId, owner.callerId)).toBeTruthy();
    manager.dispose(session);
  });

  it("sends a terminal clear marker to attached readers when scrollback is cleared", async () => {
    const manager = new SessionManager({}, { janitorIntervalMs: 60 * 60_000 });
    const root = await mkdtemp(join(tmpdir(), "session-manager-test-"));
    const owner = { callerId: "panel:test", callerKind: "panel" };
    const opened = manager.open({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"], cwd: root, env: {}, cols: 80, rows: 24 }, owner);
    const session = manager.requireOwner(opened.sessionId, owner.callerId);
    const response = manager.attach(session);
    const reader = response.body!.getReader();

    manager.clearScrollback(session);
    const next = await reader.read();

    expect(new TextDecoder().decode(next.value)).toBe("\x1b[2J\x1b[H");
    await reader.cancel();
    manager.dispose(session);
  });

  it("pauses attached PTY output until the frontend acknowledges parsed data", async () => {
    const manager = new SessionManager({}, { janitorIntervalMs: 60 * 60_000 });
    const fakePty = new FakePty();
    (
      manager as unknown as {
        pty: { spawn: () => FakePty };
      }
    ).pty = { spawn: () => fakePty };
    const root = await mkdtemp(join(tmpdir(), "session-manager-test-"));
    const owner = { callerId: "panel:test", callerKind: "panel" };
    const opened = manager.open({
      command: process.execPath,
      args: [],
      cwd: root,
      env: {},
      cols: 80,
      rows: 24,
    }, owner);
    const session = manager.requireOwner(opened.sessionId, owner.callerId);
    const response = manager.attach(session);
    const reader = response.body!.getReader();

    fakePty.emitData("x".repeat(100001));

    expect(fakePty.pause).toHaveBeenCalledTimes(1);

    manager.acknowledgeDataEvent(session, 95001);

    expect(fakePty.resume).toHaveBeenCalledTimes(1);

    await reader.cancel();
    manager.dispose(session);
  });

  it("emits coalesced watch-all snapshots for plain output activity and resize changes", async () => {
    const manager = new SessionManager({}, { janitorIntervalMs: 60 * 60_000 });
    const response = manager.watchAllInfo("panel:test");
    const reader = response.body!.getReader();
    await expect(readEvent(reader)).resolves.toMatchObject({ type: "snapshot-batch", sessions: [] });

    const root = await mkdtemp(join(tmpdir(), "session-manager-test-"));
    const owner = { callerId: "panel:test", callerKind: "panel" };
    const opened = manager.open({
      command: process.execPath,
      args: ["-e", "process.stdout.write('plain output'); setTimeout(() => {}, 5000)"],
      cwd: root,
      env: {},
      cols: 80,
      rows: 24,
    }, owner);
    await expect(readEvent(reader)).resolves.toMatchObject({ type: "opened", sessionId: opened.sessionId });

    await expect(readEvent(reader)).resolves.toMatchObject({
      type: "snapshot",
      sessionId: opened.sessionId,
      info: expect.objectContaining({ bytesOut: expect.any(Number), lastActivityAt: expect.any(Number) }),
    });

    const session = manager.requireOwner(opened.sessionId, owner.callerId);
    manager.resize(session, 100, 30);
    await expect(readEvent(reader, 1200)).resolves.toMatchObject({
      type: "snapshot",
      sessionId: opened.sessionId,
      info: expect.objectContaining({ cols: 100, rows: 30 }),
    });

    await reader.cancel();
    manager.dispose(session);
  });

  it("trims stored scrollback when the per-session limit is lowered", async () => {
    const manager = new SessionManager({}, { janitorIntervalMs: 60 * 60_000 });
    const root = await mkdtemp(join(tmpdir(), "session-manager-test-"));
    const owner = { callerId: "panel:test", callerKind: "panel" };
    const opened = manager.open({
      command: process.execPath,
      args: ["-e", "process.stdout.write('a'.repeat(2048) + 'tail')"],
      cwd: root,
      env: {},
      cols: 80,
      rows: 24,
    }, owner);
    const session = manager.requireOwner(opened.sessionId, owner.callerId);

    await manager.awaitExit(session);
    manager.setScrollbackLimit(session, 1024);

    const scrollback = manager.getScrollback(session);
    expect(scrollback.text.length).toBeLessThanOrEqual(1024);
    expect(scrollback.text).toMatch(/a*tail$/);
    manager.dispose(session);
  });
});

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 1000): Promise<unknown> {
  const decoder = new TextDecoder();
  const next = await Promise.race([
    reader.read(),
    delay(timeoutMs).then(() => {
      throw new Error("timed out");
    }),
  ]);
  if (!next.value) return undefined;
  return JSON.parse(decoder.decode(next.value).trim());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakePty {
  pid = 123;
  private dataHandler: ((data: string) => void) | undefined;
  private exitHandler: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  pause = vi.fn();
  resume = vi.fn();
  write = vi.fn();
  resize = vi.fn();
  kill = vi.fn();

  onData(cb: (data: string) => void): void {
    this.dataHandler = cb;
  }

  onExit(cb: (event: { exitCode: number; signal?: number }) => void): void {
    this.exitHandler = cb;
  }

  emitData(data: string): void {
    this.dataHandler?.(data);
  }

  emitExit(exitCode = 0): void {
    this.exitHandler?.({ exitCode });
  }
}
