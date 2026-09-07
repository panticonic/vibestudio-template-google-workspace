import { HostTerminal } from "./HostTerminal.js";
import { Box, Button, Flex, Text, Theme } from "@radix-ui/themes";
import { ShortcutsHelp, type ShortcutGroup } from "@workspace/ui/command";
import { EmptyState } from "@workspace/ui/feedback";
import { useIsMobile, useHostCommands, usePanelTheme, usePanelThemeConfig } from "@workspace/react";
import { rpc, panel, notifications, runtime, callMain } from "@workspace/runtime";
import type { RuntimeSupervisionDescription } from "@vibestudio/service-schemas/runtime";
import { isReviewPending } from "@vibestudio/shared/authority/reviewPending";

// Top-level `expose` was removed from @workspace/runtime; this is the same
// arg-spreading wrapper over the portable `rpc.expose`, kept local to the panel.
const expose = (method: string, handler: (...args: any[]) => unknown | Promise<unknown>) =>
  rpc.expose(method, (request) => handler(...request.args));
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandLauncher } from "./CommandLauncher.js";
import { ContextPicker, type CreatedContext, type PickedContextOptions } from "./ContextPicker.js";
import { deriveContextOptions, type ContextOption, type LiveEntity } from "./contextPicker.js";
import { documentTitleForPanel } from "./documentTitle.js";
import { NotificationCenter } from "./NotificationCenter.js";
import { ScratchOverlay } from "./ScratchOverlay.js";
import { SCRATCH_BUFFER_MAX_COUNT } from "./terminalState.js";
import { Settings } from "./Settings.js";
import { SessionStore, sessionIdsConnectKey, useAllSessions } from "./SessionStore.js";
import { SplitTree } from "./SplitTree.js";
import { Toast, useToast } from "./Toast.js";
import { parseApprovedOpenUrl } from "./approvedOpenUrl.js";
import { type CommandRunTarget } from "./commandLauncherModel.js";
import {
  isPlainEscapeEvent,
  actionLabel,
  defaultKeybindings,
  displayChord,
  type KeybindingAction,
} from "./keybindings.js";
import { loadTerminalState } from "./terminalState.js";
import { findDirectionalPane, type PaneFocusDirection } from "./paneFocus.js";
import { openPort, openUrl } from "./portClick.js";
import { restoreTerminalState } from "./restore.js";
import { settingsToastMessage } from "./settingsFeedback.js";
import { terminalStartupDetail, terminalStartupPendingLabel } from "./startupModel.js";
import {
  containsSession,
  splitLeaf,
  updateSplitRatio,
  usePanelActions,
} from "./usePanelActions.js";
import { useKeybindings } from "./useKeybindings.js";
import { useShellExtension } from "./useShellExtension.js";
import { liveSessionCwd } from "./vscodeShellIntegrationMeta.js";
import type { ScratchBuffer, SessionInfo, SplitNode, TerminalState } from "./types.js";

declare global {
  interface Window {
    __vibestudioTerminalTestApi?: {
      openSession(args?: { command?: string }): Promise<{ sessionId: string | undefined }>;
      splitPane(args?: {
        direction?: "right" | "down";
        command?: string;
      }): Promise<{ sessionId: string | undefined }>;
      sendText(args: { sessionId: string; text: string }): Promise<void>;
      getScrollback(args: {
        sessionId: string;
        maxBytes?: number;
      }): Promise<{ text: string; cursor: string }>;
      getRenderedText(args: { sessionId: string }): Promise<string>;
      focusSession(args: { sessionId: string }): Promise<void>;
      runCommand(args: {
        command: string;
        target?: CommandRunTarget;
      }): Promise<{ sessionId: string | undefined }>;
      getMeta(args: { sessionId: string; key?: string }): Promise<unknown>;
      listSessions(): Promise<SessionInfo[]>;
    };
  }
}

export function TerminalApp() {
  const panelAppearance = usePanelTheme();
  const isMobile = useIsMobile();
  const shell = useShellExtension();
  const sessionStore = useMemo(() => new SessionStore(), []);
  const sessions = useAllSessions(sessionStore);
  const [state, setState] = useState<TerminalState>(() =>
    loadTerminalState(panel.stateArgs.get<TerminalState>())
  );
  const [hostTerminalFocused, setHostTerminalFocused] = useState(false);
  const [executionPlatform, setExecutionPlatform] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void callMain<{ platform: string }>("developmentNative.describeHost").then(
      (host) => {
        if (active) setExecutionPlatform(host.platform);
      },
      (error) =>
        console.error(
          "Cannot determine workspace host terminal permissions",
          error
        )
    );
    return () => {
      active = false;
    };
  }, []);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [restored, setRestored] = useState(false);

  // Contribute terminal actions to the owning host.
  // `runBuiltin` is a hoisted function declaration, safe to reference here.
  const hostCommands = useMemo(
    () => [
      { id: "palette", label: "Terminal command launcher…", group: "Terminal" },
      { id: "newPane", label: "New pane", group: "Terminal" },
      { id: "splitRight", label: "Split right", group: "Terminal" },
      { id: "splitDown", label: "Split down", group: "Terminal" },
      { id: "clear", label: "Clear scrollback", group: "Terminal" },
      { id: "toggleFind", label: "Find in terminal", group: "Terminal" },
    ],
    []
  );
  useHostCommands(hostCommands, (id) => {
    if (id === "palette") setPaletteOpen(true);
    else runBuiltin(id);
  });
  const [initialOpenStatus, setInitialOpenStatus] = useState<
    "idle" | "opening" | "waitingApproval" | "failed"
  >("idle");
  const [initialOpenError, setInitialOpenError] = useState<string | null>(null);
  const [initialOpenStartedAt, setInitialOpenStartedAt] = useState<number | null>(null);
  const [sessionOpenPending, setSessionOpenPending] = useState(false);
  const [sessionOpenStartedAt, setSessionOpenStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [shellUnit, setShellUnit] = useState<ShellUnitStatus | null>(null);
  const [resizeKey, setResizeKey] = useState(0);
  const initialOpenPendingRef = useRef(!state.tree);
  const initialOpenInFlightRef = useRef(false);
  const initialOpenHintTimerRef = useRef<number | null>(null);
  const interactiveOpenInFlightRef = useRef(false);
  const pendingStatePersistenceRef = useRef<Record<string, unknown> | null>(null);
  const statePersistenceInFlightRef = useRef<Promise<void> | null>(null);
  const approvedOpenUrlIdsRef = useRef(new Set<string>());
  const latestStateRef = useRef(state);
  const prevScratchOpenRef = useRef(state.scratchOpen);
  const { toast, showToast, dismissToast } = useToast();
  const lastZoomEscapeRef = useRef(0);

  const appearance = state.themeOverride === "auto" ? panelAppearance : state.themeOverride;
  const appTheme = usePanelThemeConfig();
  const focusedSessionId = state.focusedSessionId;
  const focusedSession = focusedSessionId ? sessions[focusedSessionId] : undefined;
  const visibleTree: SplitNode | undefined =
    state.zoomedSessionId && containsSession(state.tree, state.zoomedSessionId)
      ? { kind: "leaf", sessionId: state.zoomedSessionId }
      : state.tree;
  const sessionIds = useMemo(() => Object.keys(sessions), [sessions]);
  const sessionIdsKey = sessionIdsConnectKey(sessionIds);
  const initialOpenBusy =
    initialOpenStatus === "opening" || initialOpenStatus === "waitingApproval";
  const anyOpenPending = sessionOpenPending || initialOpenBusy;
  const pendingStartedAt = sessionOpenStartedAt ?? initialOpenStartedAt;
  const sessionOpenElapsedSeconds = pendingStartedAt
    ? Math.max(0, Math.floor((now - pendingStartedAt) / 1000))
    : 0;
  const sessionOpenPendingLabel = terminalStartupPendingLabel({
    pending: anyOpenPending,
    elapsedSeconds: sessionOpenElapsedSeconds,
    shellUnit,
  });
  const setSessions = useCallback(
    (updater: (sessions: Record<string, SessionInfo>) => Record<string, SessionInfo>) => {
      sessionStore.replace(updater(sessionStore.getSnapshot()));
    },
    [sessionStore]
  );
  const actions = usePanelActions({ shell, state, sessions, setState, setSessions });
  const refreshShellUnit = useCallback(async (): Promise<ShellUnitStatus | null> => {
    const units = await runtime.supervision.list({ kind: "extension" });
    const match = units.find(
      (unit) =>
        unit.identity.entityId === "@workspace-extensions/shell" ||
        unit.source === "extensions/shell" ||
        unit.source.endsWith("/extensions/shell")
    );
    const next = match ?? null;
    setShellUnit(next);
    return next;
  }, []);

  const openScratch = useCallback(() => {
    setState((prev) => {
      const now = Date.now();
      const activeId = prev.scratchActiveBufferId;
      const active = activeId
        ? prev.scratchBuffers.find((buffer) => buffer.bufferId === activeId)
        : undefined;
      // Drop empty stale buffers from prior opens (keep the currently active one).
      const cleaned = prev.scratchBuffers.filter(
        (buffer) => buffer.text !== "" || buffer.bufferId === activeId
      );
      if (active && active.text === "") {
        return {
          ...prev,
          scratchBuffers: cleaned,
          scratchActiveBufferId: active.bufferId,
          scratchOpen: true,
        };
      }
      const fresh: ScratchBuffer = {
        bufferId: crypto.randomUUID(),
        text: "",
        createdAt: now,
        updatedAt: now,
      };
      return {
        ...prev,
        scratchBuffers: [fresh, ...cleaned].slice(0, SCRATCH_BUFFER_MAX_COUNT),
        scratchActiveBufferId: fresh.bufferId,
        scratchOpen: true,
      };
    });
  }, []);

  const setScratchOpen = useCallback(
    (open: boolean) => {
      if (open) {
        openScratch();
        return;
      }
      setState((prev) => ({ ...prev, scratchOpen: false }));
    },
    [openScratch]
  );

  const newScratchBuffer = useCallback(() => {
    setState((prev) => {
      const now = Date.now();
      const fresh: ScratchBuffer = {
        bufferId: crypto.randomUUID(),
        text: "",
        createdAt: now,
        updatedAt: now,
      };
      return {
        ...prev,
        scratchBuffers: [fresh, ...prev.scratchBuffers].slice(0, SCRATCH_BUFFER_MAX_COUNT),
        scratchActiveBufferId: fresh.bufferId,
      };
    });
  }, []);

  const selectScratchBuffer = useCallback((bufferId: string) => {
    setState((prev) => ({ ...prev, scratchActiveBufferId: bufferId }));
  }, []);

  const ejectScratchBuffer = useCallback((bufferId: string) => {
    setState((prev) => {
      const index = prev.scratchBuffers.findIndex((buffer) => buffer.bufferId === bufferId);
      if (index === -1) return prev;
      const remaining = [
        ...prev.scratchBuffers.slice(0, index),
        ...prev.scratchBuffers.slice(index + 1),
      ];
      if (prev.scratchActiveBufferId !== bufferId) {
        return { ...prev, scratchBuffers: remaining };
      }
      if (remaining.length > 0) {
        // Pick the buffer that took the ejected slot, else the one before it.
        const nextIndex = Math.min(index, remaining.length - 1);
        return {
          ...prev,
          scratchBuffers: remaining,
          scratchActiveBufferId: remaining[nextIndex]!.bufferId,
        };
      }
      const now = Date.now();
      const fresh: ScratchBuffer = {
        bufferId: crypto.randomUUID(),
        text: "",
        createdAt: now,
        updatedAt: now,
      };
      return {
        ...prev,
        scratchBuffers: [fresh],
        scratchActiveBufferId: fresh.bufferId,
      };
    });
  }, []);

  const commitScratchText = useCallback((bufferId: string, text: string) => {
    setState((prev) => {
      let changed = false;
      const next = prev.scratchBuffers.map((buffer) => {
        if (buffer.bufferId !== bufferId) return buffer;
        if (buffer.text === text) return buffer;
        changed = true;
        return { ...buffer, text, updatedAt: Date.now() };
      });
      if (!changed) return prev;
      return { ...prev, scratchBuffers: next };
    });
  }, []);

  const pasteScratch = useCallback(
    (bufferId: string, text: string, run: boolean) => {
      const targetSessionId = latestStateRef.current.focusedSessionId;
      if (!targetSessionId) {
        showToast("Open a terminal first");
        return;
      }
      commitScratchText(bufferId, text);
      const payload = run ? (text.endsWith("\n") ? text : `${text}\n`) : text;
      void actions.sendText(targetSessionId, payload).catch((err) => {
        void notifications.show({
          type: "error",
          title: "Paste failed",
          message: err instanceof Error ? err.message : String(err),
        });
      });
      setState((prev) => ({ ...prev, scratchOpen: false }));
    },
    [actions, commitScratchText, showToast]
  );

  useEffect(() => {
    document.title = documentTitleForPanel(state.panelTitle);
  }, [state.panelTitle]);

  useEffect(() => {
    latestStateRef.current = state;
  }, [shell, state]);

  useEffect(
    () => sessionStore.connect(shell, sessionIdsKey ? sessionIdsKey.split("\0") : []),
    [sessionIdsKey, sessionStore, shell]
  );

  const persistLatestState = useCallback(
    (nextState: Record<string, unknown>) => {
      pendingStatePersistenceRef.current = nextState;
      if (statePersistenceInFlightRef.current) return;

      const persist = async (): Promise<void> => {
        while (pendingStatePersistenceRef.current) {
          const snapshot = pendingStatePersistenceRef.current;
          pendingStatePersistenceRef.current = null;
          try {
            await panel.stateArgs.set(snapshot);
          } catch (error) {
            // A launch/install review can temporarily gate the workspace-state
            // service. That is expected while the user is deciding; the latest
            // snapshot remains queued for the next state change and ordinary
            // failures are surfaced without creating an unhandled rejection.
            if (!isReviewPending(error)) {
              console.warn(
                "[TerminalApp] Failed to persist terminal state:",
                error instanceof Error ? error.message : String(error)
              );
            }
          }
        }
      };

      const inFlight = persist().finally(() => {
        if (statePersistenceInFlightRef.current === inFlight) {
          statePersistenceInFlightRef.current = null;
        }
      });
      statePersistenceInFlightRef.current = inFlight;
    },
    [panel]
  );

  useEffect(() => {
    persistLatestState(state as unknown as Record<string, unknown>);
  }, [persistLatestState, state]);

  useEffect(() => {
    const prev = prevScratchOpenRef.current;
    prevScratchOpenRef.current = state.scratchOpen;
    if (prev && !state.scratchOpen) {
      window.dispatchEvent(new Event("terminal:refocus"));
    }
  }, [state.scratchOpen]);

  const openInitialSession = useCallback(
    async (force = false): Promise<string | undefined> => {
      if (force) initialOpenPendingRef.current = true;
      if (initialOpenInFlightRef.current || !initialOpenPendingRef.current) return undefined;
      initialOpenInFlightRef.current = true;
      setInitialOpenStartedAt(Date.now());
      setInitialOpenStatus("opening");
      setInitialOpenError(null);
      try {
        const unit = await refreshShellUnit();
        if (unit?.status !== "running") {
          initialOpenPendingRef.current = true;
          setInitialOpenStatus("waitingApproval");
          return undefined;
        }
        if (initialOpenHintTimerRef.current) window.clearTimeout(initialOpenHintTimerRef.current);
        initialOpenHintTimerRef.current = window.setTimeout(() => {
          setInitialOpenStatus("waitingApproval");
        }, 1000);
        const sessionId = await actions.openSession();
        initialOpenPendingRef.current = false;
        setInitialOpenStatus("idle");
        setInitialOpenStartedAt(null);
        return sessionId;
      } catch (err) {
        if (isReviewPending(err)) {
          // A review-pending result is a recoverable workspace state, not a
          // failed terminal. Keep the initial request eligible for the quiet
          // approval-change retry below so resolving the review brings this
          // same panel to life without requiring a second click.
          initialOpenPendingRef.current = true;
          setInitialOpenError(null);
          setInitialOpenStatus("waitingApproval");
        } else {
          setInitialOpenError(
            err instanceof Error ? err.message : "Terminal session failed to start"
          );
          initialOpenPendingRef.current = false;
          setInitialOpenStatus("failed");
        }
        setInitialOpenStartedAt(null);
        return undefined;
      } finally {
        if (initialOpenHintTimerRef.current) {
          window.clearTimeout(initialOpenHintTimerRef.current);
          initialOpenHintTimerRef.current = null;
        }
        initialOpenInFlightRef.current = false;
      }
    },
    [actions, refreshShellUnit]
  );

  const runInteractiveOpen = useCallback(
    async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
      if (interactiveOpenInFlightRef.current || initialOpenInFlightRef.current) {
        showToast(sessionOpenPendingLabel ?? "Terminal request already in progress");
        return undefined;
      }
      interactiveOpenInFlightRef.current = true;
      setSessionOpenPending(true);
      setSessionOpenStartedAt(Date.now());
      try {
        return await operation();
      } catch (err) {
        void notifications.show({
          type: "error",
          title: "Terminal failed to start",
          message: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      } finally {
        interactiveOpenInFlightRef.current = false;
        setSessionOpenPending(false);
        setSessionOpenStartedAt(null);
      }
    },
    [sessionOpenPendingLabel, showToast]
  );

  const openDefaultPane = useCallback(async (): Promise<string | undefined> => {
    if (
      !state.tree ||
      initialOpenInFlightRef.current ||
      initialOpenStatus === "opening" ||
      initialOpenStatus === "waitingApproval" ||
      initialOpenStatus === "failed"
    ) {
      return openInitialSession(initialOpenStatus === "failed");
    }
    return runInteractiveOpen(() => actions.splitFocused("row"));
  }, [actions, initialOpenStatus, openInitialSession, runInteractiveOpen, state.tree]);

  // Context picker (§4.1): list live contexts, create fresh session contexts,
  // and open a terminal placed in a chosen context (or the workspace root).
  const loadContexts = useCallback(async (): Promise<ContextOption[]> => {
    const entities = await callMain<LiveEntity[]>("runtime.listEntities", {});
    return deriveContextOptions(entities ?? []);
  }, []);
  const createSessionContext = useCallback(
    async (): Promise<CreatedContext> => shell.createContext({ title: "Terminal context" }),
    [shell]
  );
  const openTerminalInContext = useCallback(
    (contextId?: string, contextOpts?: PickedContextOptions) => {
      const opts = contextId
        ? {
            contextId,
            ...(contextOpts?.contextAttachToken
              ? { contextAttachToken: contextOpts.contextAttachToken }
              : {}),
          }
        : undefined;
      if (!state.tree) {
        void runInteractiveOpen(() => actions.openSession(undefined, opts));
      } else {
        void runInteractiveOpen(() => actions.splitFocused("row", undefined, opts));
      }
    },
    [actions, runInteractiveOpen, state.tree]
  );

  useEffect(
    () => () => {
      if (initialOpenHintTimerRef.current) window.clearTimeout(initialOpenHintTimerRef.current);
    },
    []
  );

  useEffect(() => {
    if (!anyOpenPending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [anyOpenPending]);

  useEffect(() => {
    void refreshShellUnit()
      .catch((error) => console.warn("[TerminalApp] Failed to load shell unit status:", error));
  }, [refreshShellUnit]);

  useEffect(() => {
    for (const session of Object.values(sessions)) {
      if (containsSession(state.tree, session.sessionId)) continue;
      const spawn = parseSnugSpawn(session.meta["snugSpawn"]);
      if (!spawn || !containsSession(state.tree, spawn.parentSessionId)) continue;
      setState((prev) => ({
        ...prev,
        tree: prev.tree
          ? splitLeaf(prev.tree, spawn.parentSessionId, spawn.direction, session.sessionId)
          : { kind: "leaf", sessionId: session.sessionId },
        focusedSessionId: session.sessionId,
        perSession: {
          ...prev.perSession,
          [session.sessionId]: {
            cwd: liveSessionCwd(session) ?? session.command.cwd,
            originalArgv: session.command.argv,
            readCursor: 0,
            lastSeenAt: Date.now(),
          },
        },
      }));
    }
  }, [sessions, state.tree]);

  useEffect(() => {
    for (const session of Object.values(sessions)) {
      const approved = parseApprovedOpenUrl(session.meta["snugOpenUrl"]);
      if (!approved || approvedOpenUrlIdsRef.current.has(approved.id)) continue;
      approvedOpenUrlIdsRef.current.add(approved.id);
      void openUrl(approved.url);
      void actions
        .deleteMeta(session.sessionId, "snugOpenUrl")
        .catch((error) => console.warn("[TerminalApp] Failed to clear consumed open URL:", error));
      setState((prev) => ({
        ...prev,
        notifications: [
          {
            notifId: crypto.randomUUID(),
            sessionId: session.sessionId,
            severity: "info",
            title: "Open URL",
            message: approved.url,
            timestamp: approved.requestedAt,
            read: false,
            source: "snug",
          },
          ...prev.notifications,
        ],
      }));
    }
  }, [actions, sessions]);

  useEffect(() => {
    let cancelled = false;
    async function restore() {
      if (restored) return;
      setRestored(true);
      if (!state.tree) {
        await openInitialSession();
        return;
      }
      initialOpenPendingRef.current = false;
      const result = await restoreTerminalState(shell, state);
      if (cancelled) return;
      setSessions((prev) => ({ ...prev, ...result.sessions }));
      setState((prev) => ({
        ...prev,
        tree: result.tree,
        focusedSessionId: result.focusedSessionId,
        perSession: result.perSession,
      }));
      if (!result.tree) {
        initialOpenPendingRef.current = true;
        await openInitialSession();
      }
    }
    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (state.tree) return;
    let cancelled = false;
    const retryOpen = async () => {
      if (initialOpenStatus === "failed") return;
      if (cancelled || initialOpenInFlightRef.current) return;
      initialOpenPendingRef.current = true;
      await openInitialSession();
    };
    const timer = setInterval(() => void retryOpen(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [initialOpenStatus, openInitialSession, state.tree]);

  useKeybindings(state.keybindings, {
    palette: () => setPaletteOpen(true),
    newPane: () => void openDefaultPane(),
    splitRight: () => void runInteractiveOpen(() => actions.splitFocused("row")),
    splitDown: () => void runInteractiveOpen(() => actions.splitFocused("column")),
    closePane: closeFocusedPane,
    toggleNotifications: () =>
      setState((prev) => ({ ...prev, notificationCenterOpen: !prev.notificationCenterOpen })),
    settings: () => setSettingsOpen((open) => !open),
    shortcuts: () => setShortcutsOpen((open) => !open),
    find: () => window.dispatchEvent(new CustomEvent("terminal:find")),
    findNext: () => window.dispatchEvent(new CustomEvent("terminal:find-next")),
    findPrev: () => window.dispatchEvent(new CustomEvent("terminal:find-previous")),
    copy: () => window.dispatchEvent(new CustomEvent("terminal:copy")),
    paste: () => window.dispatchEvent(new CustomEvent("terminal:paste")),
    clear: () => focusedSessionId && void actions.clearScrollback(focusedSessionId),
    zoom: () =>
      setState((prev) => ({
        ...prev,
        zoomedSessionId: prev.zoomedSessionId ? undefined : prev.focusedSessionId,
      })),
    focusUp: () => focusPaneByDirection("up"),
    focusDown: () => focusPaneByDirection("down"),
    focusLeft: () => focusPaneByDirection("left"),
    focusRight: () => focusPaneByDirection("right"),
    jumpToLatestUnread: () => focusUnreadSession("latest"),
    nextUnread: () => focusUnreadSession("next"),
    fontUp: () =>
      setState((prev) => {
        const fontSize = Math.min(24, prev.fontSize + 1);
        showToast(`Font ${fontSize}px`);
        return { ...prev, fontSize };
      }),
    fontDown: () =>
      setState((prev) => {
        const fontSize = Math.max(9, prev.fontSize - 1);
        showToast(`Font ${fontSize}px`);
        return { ...prev, fontSize };
      }),
    fontReset: () => {
      showToast("Font 13px");
      setState((prev) => ({ ...prev, fontSize: 13 }));
    },
    openScratch: () => {
      if (latestStateRef.current.scratchOpen) {
        setState((prev) => ({ ...prev, scratchOpen: false }));
      } else {
        openScratch();
      }
    },
  }, !hostTerminalFocused);

  useEffect(() => {
    if (!state.zoomedSessionId || hostTerminalFocused) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPlainEscapeEvent(event)) return;
      const now = Date.now();
      if (now - lastZoomEscapeRef.current > 600) {
        lastZoomEscapeRef.current = now;
        return;
      }
      lastZoomEscapeRef.current = 0;
      event.preventDefault();
      event.stopPropagation();
      setState((prev) => ({ ...prev, zoomedSessionId: undefined }));
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [state.zoomedSessionId, hostTerminalFocused]);

  useEffect(() => {
    const terminalApi = {
      openSession: async (args?: { command?: string }) => ({
        sessionId: args?.command
          ? await runInteractiveOpen(() => actions.splitFocused("row", args.command))
          : await openDefaultPane(),
      }),
      splitPane: async (args?: { direction?: "right" | "down"; command?: string }) => {
        const direction = args?.direction === "down" ? "column" : "row";
        return {
          sessionId: await runInteractiveOpen(() => actions.splitFocused(direction, args?.command)),
        };
      },
      sendText: async (args: { sessionId: string; text: string }) =>
        actions.sendText(args.sessionId, args.text),
      getScrollback: async (args: { sessionId: string; maxBytes?: number }) =>
        shell.getScrollback(args.sessionId, args.maxBytes),
      getRenderedText: async (args: { sessionId: string }) =>
        window.__vibestudioTerminalPaneTestRegistry?.[args.sessionId]?.serialize() ?? "",
      focusSession: async (args: { sessionId: string }) => actions.focusSession(args.sessionId),
      runCommand: async (args: { command: string; target?: CommandRunTarget }) => ({
        sessionId: await runCommand(args.command, args.target ?? "splitRight"),
      }),
      getMeta: async (args: { sessionId: string; key?: string }) =>
        actions.getMeta(args.sessionId, args.key),
      listSessions: async () => Object.values(sessions),
    };

    expose("terminal.openSession", terminalApi.openSession);
    expose("terminal.splitPane", terminalApi.splitPane);
    expose("terminal.sendText", terminalApi.sendText);
    expose("terminal.getScrollback", terminalApi.getScrollback);
    expose("terminal.getRenderedText", terminalApi.getRenderedText);
    expose("terminal.focusSession", terminalApi.focusSession);
    expose("terminal.runCommand", terminalApi.runCommand);
    expose("terminal.listSessions", terminalApi.listSessions);
    expose("terminal.getMeta", async (args: { sessionId: string; key?: string }) =>
      actions.getMeta(args.sessionId, args.key)
    );
    expose("terminal.setMeta", async (args: { sessionId: string; key: string; value: unknown }) =>
      actions.setMeta(args.sessionId, args.key, args.value)
    );
    expose("terminal.deleteMeta", async (args: { sessionId: string; key: string }) =>
      actions.deleteMeta(args.sessionId, args.key)
    );
    window.__vibestudioTerminalTestApi = terminalApi;
    return () => {
      if (window.__vibestudioTerminalTestApi === terminalApi) {
        delete window.__vibestudioTerminalTestApi;
      }
    };
  }, [actions, openDefaultPane, runInteractiveOpen, sessions]);

  async function runCommand(
    commandLine: string,
    target: CommandRunTarget
  ): Promise<string | undefined> {
    setState((prev) => ({
      ...prev,
      paletteHistory: [
        commandLine,
        ...prev.paletteHistory.filter((item) => item !== commandLine),
      ].slice(0, 20),
    }));
    if (target === "here") {
      if (!focusedSessionId) return undefined;
      await actions.sendText(
        focusedSessionId,
        commandLine.endsWith("\n") ? commandLine : `${commandLine}\n`
      );
      return focusedSessionId;
    }
    return runInteractiveOpen(() =>
      actions.splitFocused(target === "splitDown" ? "column" : "row", commandLine)
    );
  }

  function runBuiltin(action: string) {
    if (action === "newPane") void openDefaultPane();
    else if (action === "splitRight") void runInteractiveOpen(() => actions.splitFocused("row"));
    else if (action === "splitDown") void runInteractiveOpen(() => actions.splitFocused("column"));
    else if (action === "clear" && focusedSessionId) void actions.clearScrollback(focusedSessionId);
    else if (action === "toggleFind") window.dispatchEvent(new CustomEvent("terminal:find"));
    else if (action === "toggleNotifications")
      setState((prev) => ({ ...prev, notificationCenterOpen: !prev.notificationCenterOpen }));
  }

  function closeFocusedPane() {
    if (!focusedSessionId) return;
    const session = sessions[focusedSessionId];
    if (session?.alive && !window.confirm("Close this running terminal?")) return;
    actions.closeSession(focusedSessionId);
  }

  function focusPaneByDirection(direction: PaneFocusDirection) {
    if (!state.tree || !focusedSessionId) return;
    const nextSessionId = findDirectionalPane(state.tree, focusedSessionId, direction);
    if (!nextSessionId) return;
    setState((prev) => ({ ...prev, focusedSessionId: nextSessionId }));
  }

  function focusUnreadSession(mode: "latest" | "next") {
    const unread = state.notifications
      .filter((item) => !item.read && containsSession(state.tree, item.sessionId))
      .sort((a, b) => b.timestamp - a.timestamp);
    if (unread.length === 0) return;
    const target =
      mode === "next" && focusedSessionId
        ? (unread[
            (unread.findIndex((item) => item.sessionId === focusedSessionId) + 1 + unread.length) %
              unread.length
          ] ?? unread[0])
        : unread[0];
    if (!target) return;
    setState((prev) =>
      markSessionRead({ ...prev, focusedSessionId: target.sessionId }, target.sessionId)
    );
  }

  const notificationCenter = (
    <NotificationCenter
      notifications={state.notifications}
      sessions={sessions}
      filter={state.notificationFilter}
      onFilterChange={(filter) => setState((prev) => ({ ...prev, notificationFilter: filter }))}
      onJump={(sessionId) => {
        if (containsSession(state.tree, sessionId)) {
          setState((prev) => markSessionRead({ ...prev, focusedSessionId: sessionId }, sessionId));
        }
        if (isMobile) setState((prev) => ({ ...prev, notificationCenterOpen: false }));
      }}
      onMarkRead={(notifId) =>
        setState((prev) => ({
          ...prev,
          notifications: prev.notifications.map((item) =>
            item.notifId === notifId ? { ...item, read: true } : item
          ),
        }))
      }
      onDismiss={(notifId) =>
        setState((prev) => ({
          ...prev,
          notifications: prev.notifications.filter((item) => item.notifId !== notifId),
        }))
      }
      onMarkAllRead={() =>
        setState((prev) => ({
          ...prev,
          notifications: prev.notifications.map((item) => ({ ...item, read: true })),
        }))
      }
      onClearAll={() => setState((prev) => ({ ...prev, notifications: [] }))}
    />
  );

  const settingsControl = (
    <Settings
      open={settingsOpen}
      panelTitle={state.panelTitle}
      fontSize={state.fontSize}
      fontFamily={state.fontFamily}
      scrollbackBytes={state.scrollbackBytes}
      themeOverride={state.themeOverride}
      pasteMode={state.pasteMode}
      imagePasteRelative={state.imagePasteRelative}
      keybindings={state.keybindings}
      onOpenChange={setSettingsOpen}
      onChange={(next) => {
        const message = settingsToastMessage(next);
        if (message) showToast(message);
        setState((prev) => ({ ...prev, ...next }));
        if (next.panelTitle !== undefined) {
          const title = documentTitleForPanel(next.panelTitle);
          void panel
            .setTitle(title, { explicit: true })
            .catch((error: unknown) =>
              console.warn(
                `Failed to save panel name: ${
                  error instanceof Error ? error.message : String(error)
                }`
              )
            );
        }
        if (next.scrollbackBytes) {
          for (const sessionId of Object.keys(sessions))
            void shell.setScrollbackLimit?.(sessionId, next.scrollbackBytes);
        }
      }}
    />
  );

  // Build the shortcuts cheat-sheet from the live keymap (defaults + overrides).
  const mergedKeymap = { ...defaultKeybindings, ...state.keybindings };
  const chordFor = (action: KeybindingAction) =>
    displayChord(mergedKeymap[action] ?? defaultKeybindings[action]);
  const SHORTCUT_SECTIONS: { title: string; actions: KeybindingAction[] }[] = [
    { title: "Panes", actions: ["newPane", "splitRight", "splitDown", "closePane", "zoom"] },
    {
      title: "Navigation",
      actions: [
        "focusUp",
        "focusDown",
        "focusLeft",
        "focusRight",
        "jumpToLatestUnread",
        "nextUnread",
      ],
    },
    { title: "Search", actions: ["find", "findNext", "findPrev"] },
    { title: "View", actions: ["fontUp", "fontDown", "fontReset", "clear", "toggleNotifications"] },
    { title: "App", actions: ["palette", "openScratch", "settings", "shortcuts"] },
  ];
  const shortcutGroups: ShortcutGroup[] = SHORTCUT_SECTIONS.map((section) => ({
    title: section.title,
    entries: section.actions.map((action) => ({
      label: actionLabel(action),
      keys: chordFor(action),
    })),
  }));

  return (
    <Theme appearance={appearance} {...appTheme}>
      <Flex
        height="100dvh"
        width="100%"
        direction="column"
        style={{
          overflow: "hidden",
          background: "var(--color-page-background)",
          position: "relative",
        }}
      >
        <HostTerminal
          executionPlatform={executionPlatform}
          appearance={appearance}
          fontFamily={state.fontFamily}
          fontSize={state.fontSize}
          onFocusChange={setHostTerminalFocused}
        />
        {state.zoomedSessionId ? (
          <Box
            position="absolute"
            top="2"
            left="50%"
            style={{ transform: "translateX(-50%)", zIndex: 20 }}
          >
            <Button
              size="1"
              variant="solid"
              onClick={() => setState((prev) => ({ ...prev, zoomedSessionId: undefined }))}
            >
              Zoomed — Esc Esc to restore
            </Button>
          </Box>
        ) : null}
        <Box
          p="1"
          style={{
            display: "flex",
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            height: "100%",
            overflow: "hidden",
          }}
        >
          {visibleTree ? (
            <SplitTree
              node={visibleTree}
              sessions={sessions}
              notifications={state.notifications}
              focusedSessionId={focusedSessionId}
              shell={shell}
              fontSize={state.fontSize}
              fontFamily={state.fontFamily}
              appearance={appearance}
              pasteMode={state.pasteMode}
              imagePasteRelative={state.imagePasteRelative}
              resizeKey={resizeKey}
              settingsControl={settingsControl}
              onFocus={(sessionId) =>
                setState((prev) => ({ ...prev, focusedSessionId: sessionId }))
              }
              onClose={(sessionId) => {
                const session = sessions[sessionId];
                if (session?.alive && !window.confirm("Close this running terminal?")) return;
                actions.closeSession(sessionId);
              }}
              onSplit={(sessionId, direction) => {
                void runInteractiveOpen(() => actions.splitSession(sessionId, direction));
              }}
              onOpenPort={(sessionId, port) =>
                void openPort(port, sessions[sessionId]?.detectedUrls)
              }
              onOpenUrl={(_sessionId, url) => void openUrl(url)}
              onClear={(sessionId) => void actions.clearScrollback(sessionId)}
              onDuplicate={(sessionId) =>
                void runInteractiveOpen(() => actions.splitSession(sessionId, "row"))
              }
              onRestart={(sessionId) => void actions.restart(sessionId)}
              onRestartCommand={(sessionId) => void actions.restartCommand(sessionId)}
              onFind={(sessionId) => {
                setState((prev) => ({ ...prev, focusedSessionId: sessionId }));
                window.dispatchEvent(new CustomEvent("terminal:find"));
              }}
              onZoom={(sessionId) =>
                setState((prev) => ({
                  ...prev,
                  focusedSessionId: sessionId,
                  zoomedSessionId: prev.zoomedSessionId === sessionId ? undefined : sessionId,
                }))
              }
              onOpenScratch={openScratch}
              onRatioChange={(path, ratio) => {
                setState((prev) => ({
                  ...prev,
                  tree: prev.tree ? updateSplitRatio(prev.tree, path, ratio) : prev.tree,
                }));
                setResizeKey((value) => value + 1);
              }}
              onNotification={(sessionId, notification) => {
                setState((prev) => ({
                  ...prev,
                  notifications: [
                    {
                      notifId: crypto.randomUUID(),
                      sessionId,
                      severity: notification.severity,
                      title: notification.title,
                      message: notification.message,
                      timestamp: Date.now(),
                      read: false,
                      source: notification.source,
                    },
                    ...prev.notifications,
                  ],
                }));
              }}
            />
          ) : (
            <EmptyTerminalState
              status={initialOpenStatus}
              error={initialOpenError}
              shellUnit={shellUnit}
              elapsedSeconds={
                initialOpenStartedAt
                  ? Math.max(0, Math.floor((now - initialOpenStartedAt) / 1000))
                  : 0
              }
              onOpen={() => void openDefaultPane()}
              onPickContext={openTerminalInContext}
              loadContexts={loadContexts}
              createContext={createSessionContext}
            />
          )}
        </Box>
        {sessionOpenPendingLabel && visibleTree ? (
          <Box
            role="status"
            aria-live="polite"
            px="2"
            py="1"
            style={{
              position: "absolute",
              left: "50%",
              bottom: "0.5rem",
              transform: "translateX(-50%)",
              zIndex: 7,
              borderRadius: "var(--radius-2)",
              background: "var(--gray-3)",
              boxShadow: "var(--shadow-2)",
            }}
          >
            <Text size="1" color="gray">
              {sessionOpenPendingLabel}
            </Text>
          </Box>
        ) : null}
        <Toast toast={toast} onDismiss={dismissToast} />
        {state.notificationCenterOpen ? (
          isMobile ? (
            <Box
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 20,
                display: "flex",
                justifyContent: "flex-end",
                background: "rgba(0, 0, 0, 0.34)",
              }}
              onClick={() => setState((prev) => ({ ...prev, notificationCenterOpen: false }))}
            >
              <Box
                style={{ height: "100%", maxWidth: "calc(100vw - 40px)" }}
                onClick={(event) => event.stopPropagation()}
              >
                {notificationCenter}
              </Box>
            </Box>
          ) : (
            notificationCenter
          )
        ) : null}
      </Flex>
      <CommandLauncher
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        cwd={focusedSession ? liveSessionCwd(focusedSession) : undefined}
        history={state.paletteHistory}
        onRun={async (command, target) => {
          await runCommand(command, target);
        }}
        onBuiltin={runBuiltin}
      />
      <ScratchOverlay
        open={state.scratchOpen}
        buffers={state.scratchBuffers}
        activeBufferId={state.scratchActiveBufferId}
        fontFamily={state.fontFamily}
        hasFocusedSession={!!focusedSessionId}
        onOpenChange={setScratchOpen}
        onNewBuffer={newScratchBuffer}
        onSelectBuffer={selectScratchBuffer}
        onEjectBuffer={ejectScratchBuffer}
        onCommitText={commitScratchText}
        onPaste={(bufferId, text) => pasteScratch(bufferId, text, false)}
        onPasteAndRun={(bufferId, text) => pasteScratch(bufferId, text, true)}
      />
      <ShortcutsHelp open={shortcutsOpen} onOpenChange={setShortcutsOpen} groups={shortcutGroups} />
    </Theme>
  );
}

function EmptyTerminalState(props: {
  status: "idle" | "opening" | "waitingApproval" | "failed";
  error: string | null;
  shellUnit: ShellUnitStatus | null;
  elapsedSeconds: number;
  onOpen(): void;
  onPickContext(contextId?: string, opts?: PickedContextOptions): void;
  loadContexts(): Promise<ContextOption[]>;
  createContext(): Promise<CreatedContext>;
}) {
  const isBusy = props.status === "opening" || props.status === "waitingApproval";
  const copy = terminalStartupDetail({
    status: props.status,
    elapsedSeconds: props.elapsedSeconds,
    shellUnit: props.shellUnit,
    error: props.error,
  });
  const elapsed = props.elapsedSeconds >= 1 ? `Waiting ${props.elapsedSeconds}s` : undefined;

  return (
    <EmptyState
      title={copy.title}
      description={
        <>
          {copy.detail}
          {elapsed ? (
            <Text as="div" size="1" color="gray" mt="2" role="status" aria-live="polite">
              {elapsed}
            </Text>
          ) : null}
        </>
      }
      actions={
        <Flex gap="2" align="center" justify="center">
          <Button onClick={props.onOpen} disabled={isBusy}>
            {isBusy ? "Waiting..." : props.status === "failed" ? "Retry" : "Open terminal"}
          </Button>
          <ContextPicker
            disabled={isBusy}
            onPick={props.onPickContext}
            loadContexts={props.loadContexts}
            createContext={props.createContext}
          />
        </Flex>
      }
    />
  );
}

type ShellUnitStatus = {
  status: RuntimeSupervisionDescription["status"] | "pending-approval" | "building" | "available";
  pendingApproval?: { kind: string; submittedAt: number } | null;
};

function markSessionRead(state: TerminalState, sessionId: string): TerminalState {
  const now = Date.now();
  return {
    ...state,
    notifications: state.notifications.map((item) =>
      item.sessionId === sessionId ? { ...item, read: true } : item
    ),
    perSession: {
      ...state.perSession,
      [sessionId]: {
        ...(state.perSession[sessionId] ?? { cwd: "", readCursor: 0, lastSeenAt: 0 }),
        readCursor: now,
        lastSeenAt: now,
      },
    },
  };
}

function parseSnugSpawn(
  value: unknown
): { parentSessionId: string; direction: "row" | "column" } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return typeof record["parentSessionId"] === "string" &&
    (record["direction"] === "row" || record["direction"] === "column")
    ? { parentSessionId: record["parentSessionId"], direction: record["direction"] }
    : undefined;
}
