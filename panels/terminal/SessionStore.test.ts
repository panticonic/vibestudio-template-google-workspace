import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore, sessionIdsConnectKey } from "./SessionStore.js";
import type { SessionInfo, ShellApi } from "./types.js";

describe("SessionStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a stable snapshot between mutations", () => {
    const store = new SessionStore();
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    store.set(makeSession("s1"));
    const first = store.getSnapshot();
    expect(first["s1"]?.sessionId).toBe("s1");
    expect(store.getSnapshot()).toBe(first);
  });

  it("builds stable connection keys from unordered session ids", () => {
    expect(sessionIdsConnectKey(["s2", "s1", "s2"])).toBe(sessionIdsConnectKey(["s1", "s2"]));
  });

  it("notifies global and session listeners on replace", () => {
    const store = new SessionStore();
    const global = vi.fn();
    const s1 = vi.fn();
    const s2 = vi.fn();
    store.subscribe(global);
    store.subscribeSession("s1", s1);
    store.subscribeSession("s2", s2);

    store.replace({ s1: makeSession("s1") });
    expect(global).toHaveBeenCalled();
    expect(s1).toHaveBeenCalled();
    expect(s2).not.toHaveBeenCalled();

    s1.mockClear();
    s2.mockClear();
    store.replace({ s2: makeSession("s2") });
    expect(s1).toHaveBeenCalled();
    expect(s2).toHaveBeenCalled();
  });

  it("notifies session listeners when replace updates existing session metadata", () => {
    const store = new SessionStore();
    const s1 = vi.fn();
    store.replace({ s1: makeSession("s1", "before") });
    store.subscribeSession("s1", s1);

    store.replace({ s1: makeSession("s1", "after") });

    expect(s1).toHaveBeenCalledTimes(1);
    expect(store.getSessionSnapshot("s1")?.label).toBe("after");
  });

  it("does not notify or churn identity for unchanged session snapshots", () => {
    const store = new SessionStore();
    const global = vi.fn();
    const s1 = vi.fn();
    store.replace({ s1: makeSession("s1", "same") });
    const initialSession = store.getSessionSnapshot("s1");
    const initialSnapshot = store.getSnapshot();
    store.subscribe(global);
    store.subscribeSession("s1", s1);

    store.set(makeSession("s1", "same"));
    store.replace({ s1: makeSession("s1", "same") });

    expect(global).not.toHaveBeenCalled();
    expect(s1).not.toHaveBeenCalled();
    expect(store.getSessionSnapshot("s1")).toBe(initialSession);
    expect(store.getSnapshot()).toBe(initialSnapshot);
  });

  it("reconnects per-session fallback streams when the session id set changes", () => {
    const store = new SessionStore();
    const shell = {
      watchSessionInfo: vi.fn(async () => new Response(new ReadableStream<Uint8Array>())),
    } as unknown as ShellApi;

    store.connect(shell, ["s1"]);
    store.connect(shell, ["s1"]);
    store.connect(shell, ["s1", "s2"]);

    expect(shell.watchSessionInfo).toHaveBeenCalledTimes(3);
    expect(shell.watchSessionInfo).toHaveBeenNthCalledWith(1, "s1");
    expect(shell.watchSessionInfo).toHaveBeenNthCalledWith(2, "s1");
    expect(shell.watchSessionInfo).toHaveBeenNthCalledWith(3, "s2");
    store.disconnect();
  });

  it("keeps an active stream when cleaning up a duplicate connect call", async () => {
    const store = new SessionStore();
    const shell = {
      watchAllSessionInfo: vi.fn(async () => new Response(new ReadableStream<Uint8Array>())),
    } as unknown as ShellApi;

    const cleanup = store.connect(shell);
    const duplicateCleanup = store.connect(shell);
    duplicateCleanup();

    store.connect(shell);

    expect(shell.watchAllSessionInfo).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("retries ended per-session fallback streams until disconnected", async () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    const shell = {
      watchSessionInfo: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }))),
    } as unknown as ShellApi;

    store.connect(shell, ["s1"]);
    await vi.waitFor(() => expect(shell.watchSessionInfo).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(shell.watchSessionInfo).toHaveBeenCalledTimes(2));

    store.disconnect();
    await vi.advanceTimersByTimeAsync(2000);
    expect(shell.watchSessionInfo).toHaveBeenCalledTimes(2);
  });
});

function makeSession(sessionId: string, label = sessionId): SessionInfo {
  return {
    sessionId,
    label,
    command: { argv: ["/bin/bash"], cwd: "/tmp" },
    cols: 80,
    rows: 24,
    alive: true,
    detectedPorts: [],
    detectedUrls: [],
    lastActivityAt: 1,
    bytesOut: 0,
    meta: {},
  };
}
