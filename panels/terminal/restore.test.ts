import { describe, expect, it, vi } from "vitest";
import { defaultTerminalState } from "./terminalState.js";
import { restoreTerminalState } from "./restore.js";
import type { SessionInfo, ShellApi, TerminalState } from "./types.js";
import { VSCODE_SHELL_INTEGRATION_META_KEY } from "./vscodeShellIntegrationMeta.js";

describe("terminal restore", () => {
  it("remaps focused pane to the corresponding newly opened session", async () => {
    const shell = makeShell();
    const state = { ...stateWithTree("old-b"), scrollbackBytes: 1024 * 1024 };

    const result = await restoreTerminalState(shell, state);

    expect(shell.open).toHaveBeenNthCalledWith(1, { cwd: "/repo/a", label: "Restored shell (restarted)" });
    expect(shell.open).toHaveBeenNthCalledWith(2, { cwd: "/repo/b", label: "Restored shell (restarted)" });
    expect(shell.setScrollbackLimit).toHaveBeenCalledWith("new-1", 1024 * 1024);
    expect(shell.setScrollbackLimit).toHaveBeenCalledWith("new-2", 1024 * 1024);
    expect(result.tree).toMatchObject({
      kind: "split",
      a: { kind: "leaf", sessionId: "new-1" },
      b: { kind: "leaf", sessionId: "new-2" },
    });
    expect(result.focusedSessionId).toBe("new-2");
    expect(result.perSession["new-2"]).toMatchObject({
      cwd: "/repo/b",
      label: "Restored shell (restarted)",
      readCursor: 22,
      originalArgv: ["pnpm", "dev"],
    });
    expect(shell.dispose).toHaveBeenCalledWith("old-a");
    expect(shell.dispose).toHaveBeenCalledWith("old-b");
  });

  it("reattaches live server sessions without restarting or disposing them", async () => {
    const shell = makeShell({ retainOldSessions: true });
    const result = await restoreTerminalState(shell, stateWithTree("old-b"));

    expect(shell.open).not.toHaveBeenCalled();
    expect(shell.dispose).not.toHaveBeenCalled();
    expect(result.focusedSessionId).toBe("old-b");
    expect(result.tree).toMatchObject({
      a: { sessionId: "old-a" },
      b: { sessionId: "old-b" },
    });
  });

  it("prunes leaves that fail to reopen and falls back to the first restored pane", async () => {
    const shell = makeShell({ failCwd: "/repo/b" });
    const state = stateWithTree("old-b");

    const result = await restoreTerminalState(shell, state);

    expect(result.tree).toEqual({ kind: "leaf", sessionId: "new-1" });
    expect(result.focusedSessionId).toBe("new-1");
    expect(shell.dispose).toHaveBeenCalledWith("old-a");
    expect(shell.dispose).toHaveBeenCalledWith("old-b");
  });

  it("disposes newly opened restore sessions when post-open setup fails", async () => {
    const shell = makeShell({ failGetSessionId: "new-2" });
    const state = stateWithTree("old-b");

    const result = await restoreTerminalState(shell, state);

    expect(result.tree).toEqual({ kind: "leaf", sessionId: "new-1" });
    expect(shell.dispose).toHaveBeenCalledWith("new-2");
    expect(shell.dispose).toHaveBeenCalledWith("old-b");
  });

});

function stateWithTree(focusedSessionId: string): TerminalState {
  return {
    ...defaultTerminalState(),
    focusedSessionId,
    tree: {
      kind: "split",
      direction: "row",
      ratio: 0.5,
      a: { kind: "leaf", sessionId: "old-a" },
      b: { kind: "leaf", sessionId: "old-b" },
    },
    perSession: {
      "old-a": { cwd: "/repo/a", label: "Alpha", originalArgv: ["node"], readCursor: 11, lastSeenAt: 1 },
      "old-b": { cwd: "/repo/b", label: "Beta", originalArgv: ["pnpm", "dev"], readCursor: 22, lastSeenAt: 2 },
    },
  };
}

function makeShell(opts: { failCwd?: string; failGetSessionId?: string; retainOldSessions?: boolean } = {}): ShellApi {
  let nextId = 1;
  const sessions = new Map<string, SessionInfo>();
  if (opts.retainOldSessions) {
    sessions.set("old-a", session("old-a", "/repo/a", "Alpha"));
    sessions.set("old-b", session("old-b", "/repo/b", "Beta"));
  }
  return {
    open: vi.fn(async (req: { cwd?: string; label?: string }) => {
      if (req.cwd === opts.failCwd) throw new Error("denied");
      const sessionId = `new-${nextId++}`;
      sessions.set(sessionId, session(sessionId, req.cwd ?? ".", req.label));
      return { sessionId };
    }),
    get: vi.fn(async (sessionId: string) => {
      if (sessionId === opts.failGetSessionId) throw new Error("get failed");
      const info = sessions.get(sessionId);
      if (!info) throw new Error("missing");
      return info;
    }),
    exec: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    list: vi.fn(),
    getSessionInfo: vi.fn(),
    watchSessionInfo: vi.fn(),
    attach: vi.fn(),
    awaitExit: vi.fn(),
    getScrollback: vi.fn(),
    setScrollbackLimit: vi.fn(),
    dispose: vi.fn(async () => undefined),
  } as unknown as ShellApi;
}

function session(sessionId: string, cwd: string, label = sessionId, liveCwd?: string): SessionInfo {
  return {
    sessionId,
    label,
    command: { argv: ["/bin/sh"], cwd },
    cols: 80,
    rows: 24,
    alive: true,
    detectedPorts: [],
    detectedUrls: [],
    lastActivityAt: Date.now(),
    bytesOut: 0,
    meta: liveCwd ? {
      [VSCODE_SHELL_INTEGRATION_META_KEY]: {
        status: "vscode",
        cwd: liveCwd,
        commandRunning: false,
        updatedAt: 1,
      },
    } : {},
  };
}
