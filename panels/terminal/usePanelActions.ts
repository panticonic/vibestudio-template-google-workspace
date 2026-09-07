import { useMemo } from "react";
import type { SessionInfo, ShellApi, SplitNode, TerminalState } from "./types.js";
import { liveSessionCwd } from "./vscodeShellIntegrationMeta.js";

type SetState = (updater: (state: TerminalState) => TerminalState) => void;
type SetSessions = (
  updater: (sessions: Record<string, SessionInfo>) => Record<string, SessionInfo>
) => void;
type ContextOpenOptions = { contextId?: string; contextAttachToken?: string };

export interface PanelActions {
  openSession(command?: string, opts?: ContextOpenOptions): Promise<string>;
  closeSession(sessionId: string): void;
  splitFocused(
    direction: "row" | "column",
    command?: string,
    opts?: ContextOpenOptions
  ): Promise<string | undefined>;
  splitSession(
    sessionId: string,
    direction: "row" | "column",
    command?: string,
    opts?: ContextOpenOptions
  ): Promise<string | undefined>;
  focusSession(sessionId: string): void;
  sendText(sessionId: string, text: string): Promise<void>;
  runCommand(command: string): Promise<string | undefined>;
  restart(sessionId: string): Promise<string | undefined>;
  restartCommand(sessionId: string): Promise<string | undefined>;
  dispose(sessionId: string): Promise<void>;
  clearScrollback(sessionId: string): Promise<void>;
  setMeta(sessionId: string, key: string, value: unknown): Promise<void>;
  getMeta(sessionId: string, key?: string): Promise<unknown>;
  deleteMeta(sessionId: string, key: string): Promise<void>;
}

export function usePanelActions(args: {
  shell: ShellApi;
  state: TerminalState;
  sessions: Record<string, SessionInfo>;
  setState: SetState;
  setSessions: SetSessions;
}): PanelActions {
  return useMemo(
    () => createPanelActions(args),
    [args.shell, args.state, args.sessions, args.setState, args.setSessions]
  );
}

export function createPanelActions(args: {
  shell: ShellApi;
  state: TerminalState;
  sessions: Record<string, SessionInfo>;
  setState: SetState;
  setSessions: SetSessions;
}): PanelActions {
  const { shell, state, sessions, setState, setSessions } = args;
  const rememberSession = (info: SessionInfo) => {
    setSessions((prev) => ({ ...prev, [info.sessionId]: info }));
    setState((prev) => ({
      ...prev,
      perSession: {
        ...prev.perSession,
        [info.sessionId]: {
          cwd: info.command.cwd,
          originalArgv: info.command.argv,
          readCursor: prev.perSession[info.sessionId]?.readCursor ?? 0,
          lastSeenAt: Date.now(),
          label: prev.perSession[info.sessionId]?.label ?? info.label,
        },
      },
    }));
  };

  const applyScrollbackLimit = async (sessionId: string) => {
    await shell.setScrollbackLimit?.(sessionId, state.scrollbackBytes);
  };

  const forgetSession = (sessionId: string) => {
    setSessions((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setState((prev) => {
      const { [sessionId]: _removed, ...perSession } = prev.perSession;
      return { ...prev, perSession };
    });
  };

  const disposeReplacedSession = async (sessionId: string) => {
    forgetSession(sessionId);
    await shell
      .dispose?.(sessionId)
      .catch((error) => console.warn("[terminal] Failed to dispose replaced session:", error));
  };

  const openSession = async (command?: string, opts?: ContextOpenOptions): Promise<string> => {
    const base = command ? { command: "/bin/sh", args: ["-c", command], label: command } : {};
    // Context placement (§4.1): a chosen contextId confines the session to the
    // context's materialized VCS working folder.
    const req = opts?.contextId
      ? {
          ...base,
          contextId: opts.contextId,
          ...(opts.contextAttachToken ? { contextAttachToken: opts.contextAttachToken } : {}),
        }
      : base;
    const { sessionId } = await shell.open(req);
    const info = await shell.get(sessionId);
    await applyScrollbackLimit(sessionId);
    rememberSession(info);
    setState((prev) => ({
      ...prev,
      tree: { kind: "leaf", sessionId },
      focusedSessionId: sessionId,
    }));
    return sessionId;
  };

  const focusSession = (sessionId: string) => {
    setState((prev) => ({
      ...prev,
      focusedSessionId: containsSession(prev.tree, sessionId) ? sessionId : prev.focusedSessionId,
    }));
  };

  const closeSession = (sessionId: string) => {
    if (sessions[sessionId]?.alive) {
      void shell
        .kill(sessionId)
        .catch((error) => console.warn("[terminal] Failed to stop session:", error));
    }
    void shell
      .dispose?.(sessionId)
      .catch((error) => console.warn("[terminal] Failed to dispose session:", error));
    forgetSession(sessionId);
    setState((prev) => {
      const tree = prev.tree ? removeLeaf(prev.tree, sessionId) : undefined;
      const focusedSessionId =
        prev.focusedSessionId === sessionId ? firstLeaf(tree) : prev.focusedSessionId;
      return {
        ...prev,
        tree,
        focusedSessionId:
          focusedSessionId && containsSession(tree, focusedSessionId)
            ? focusedSessionId
            : firstLeaf(tree),
        zoomedSessionId: prev.zoomedSessionId === sessionId ? undefined : prev.zoomedSessionId,
      };
    });
  };

  const splitSession = async (
    targetSessionId: string,
    direction: "row" | "column",
    command?: string,
    opts?: ContextOpenOptions
  ): Promise<string | undefined> => {
    if (!containsSession(state.tree, targetSessionId))
      return state.tree ? undefined : openSession(command, opts);
    const focusedInfo = sessions[targetSessionId];
    const cwd = liveSessionCwd(focusedInfo);
    // Split inherits the parent session's context (§4.1) so a context terminal
    // splits into the same context folder — unless an explicit contextId is
    // chosen (opening a new terminal into a different context).
    const contextId = opts?.contextId ?? focusedInfo?.contextId;
    // Only inherit the parent's cwd when the new session stays in the parent's
    // context (or workspace root). A different chosen context folder makes the
    // parent's absolute cwd meaningless — default to that folder's root.
    const inheritCwd = (opts?.contextId ?? focusedInfo?.contextId) === focusedInfo?.contextId;
    const req = {
      ...(command ? { command: "/bin/sh", args: ["-c", command], label: command } : {}),
      ...(inheritCwd && cwd ? { cwd } : {}),
      ...(contextId ? { contextId } : {}),
      ...(opts?.contextAttachToken ? { contextAttachToken: opts.contextAttachToken } : {}),
    };
    const { sessionId } = await shell.open(req);
    const info = await shell.get(sessionId);
    await applyScrollbackLimit(sessionId);
    rememberSession(info);
    setState((prev) => ({
      ...prev,
      tree: prev.tree
        ? splitLeaf(prev.tree, targetSessionId, direction, sessionId)
        : { kind: "leaf", sessionId },
      focusedSessionId: sessionId,
    }));
    return sessionId;
  };

  const splitFocused = async (
    direction: "row" | "column",
    command?: string,
    opts?: ContextOpenOptions
  ): Promise<string | undefined> => {
    if (!state.tree || !state.focusedSessionId) return openSession(command, opts);
    return splitSession(state.focusedSessionId, direction, command, opts);
  };

  const runCommand = async (command: string): Promise<string | undefined> =>
    splitFocused("row", command);

  const replaceSessionWithOpen = async (
    sessionId: string,
    req: Parameters<ShellApi["open"]>[0]
  ): Promise<string | undefined> => {
    const { sessionId: nextSessionId } = await shell.open(req);
    const info = await shell.get(nextSessionId);
    await applyScrollbackLimit(nextSessionId);
    rememberSession(info);
    setState((prev) => ({
      ...prev,
      tree: prev.tree
        ? replaceLeaf(prev.tree, sessionId, nextSessionId)
        : { kind: "leaf", sessionId: nextSessionId },
      focusedSessionId: nextSessionId,
    }));
    await disposeReplacedSession(sessionId);
    return nextSessionId;
  };

  return {
    openSession,
    closeSession,
    splitFocused,
    splitSession,
    focusSession,
    sendText: (sessionId, text) => shell.write(sessionId, text),
    runCommand,
    restart: async (sessionId) => {
      const result = await shell.restart?.(sessionId);
      if (!result) return undefined;
      const info = await shell.get(result.sessionId);
      await applyScrollbackLimit(result.sessionId);
      rememberSession(info);
      setState((prev) => ({
        ...prev,
        tree: prev.tree
          ? replaceLeaf(prev.tree, sessionId, result.sessionId)
          : { kind: "leaf", sessionId: result.sessionId },
        focusedSessionId: result.sessionId,
      }));
      await disposeReplacedSession(sessionId);
      return result.sessionId;
    },
    restartCommand: async (sessionId) => {
      const saved = state.perSession[sessionId];
      const argv = saved?.originalArgv;
      if (!argv?.length) return undefined;
      const [command, ...args] = argv;
      if (!command) return undefined;
      const cwd =
        liveSessionCwd(sessions[sessionId]) || saved?.cwd || sessions[sessionId]?.command.cwd;
      return replaceSessionWithOpen(sessionId, {
        command,
        args,
        cwd,
        label: argv.join(" "),
      });
    },
    dispose: async (sessionId) => {
      await shell.dispose?.(sessionId);
    },
    clearScrollback: async (sessionId) => {
      await shell.clearScrollback?.(sessionId);
    },
    setMeta: async (sessionId, key, value) => {
      await shell.setMeta?.(sessionId, key, value);
    },
    getMeta: async (sessionId, key) => shell.getMeta?.(sessionId, key),
    deleteMeta: async (sessionId, key) => {
      await shell.deleteMeta?.(sessionId, key);
    },
  };
}

export function containsSession(node: SplitNode | undefined, sessionId: string): boolean {
  if (!node) return false;
  if (node.kind === "leaf") return node.sessionId === sessionId;
  return containsSession(node.a, sessionId) || containsSession(node.b, sessionId);
}

export function splitLeaf(
  node: SplitNode,
  targetSessionId: string,
  direction: "row" | "column",
  newSessionId: string
): SplitNode {
  if (node.kind === "leaf") {
    return node.sessionId === targetSessionId
      ? {
          kind: "split",
          direction,
          ratio: 0.5,
          a: node,
          b: { kind: "leaf", sessionId: newSessionId },
        }
      : node;
  }
  return {
    ...node,
    a: splitLeaf(node.a, targetSessionId, direction, newSessionId),
    b: splitLeaf(node.b, targetSessionId, direction, newSessionId),
  };
}

export function replaceLeaf(
  node: SplitNode,
  oldSessionId: string,
  newSessionId: string
): SplitNode {
  if (node.kind === "leaf")
    return node.sessionId === oldSessionId ? { kind: "leaf", sessionId: newSessionId } : node;
  return {
    ...node,
    a: replaceLeaf(node.a, oldSessionId, newSessionId),
    b: replaceLeaf(node.b, oldSessionId, newSessionId),
  };
}

export function updateSplitRatio(
  node: SplitNode,
  path: Array<"a" | "b">,
  ratio: number
): SplitNode {
  if (path.length === 0) return node.kind === "split" ? { ...node, ratio } : node;
  if (node.kind === "leaf") return node;
  const [head, ...rest] = path;
  if (!head) return node;
  return { ...node, [head]: updateSplitRatio(node[head], rest, ratio) };
}

function removeLeaf(node: SplitNode, sessionId: string): SplitNode | undefined {
  if (node.kind === "leaf") return node.sessionId === sessionId ? undefined : node;
  const a = removeLeaf(node.a, sessionId);
  const b = removeLeaf(node.b, sessionId);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

function firstLeaf(node: SplitNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.kind === "leaf") return node.sessionId;
  return firstLeaf(node.a) ?? firstLeaf(node.b);
}
