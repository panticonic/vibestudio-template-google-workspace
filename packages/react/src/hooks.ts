/**
 * React hooks for Vibestudio panel development.
 * Provides declarative, idiomatic React APIs for panel features.
 */

import { useState, useEffect, useMemo, useRef } from "react";
import * as runtime from "@workspace/runtime";
import { Rpc } from "@workspace/runtime";
import type { HostCommand, PanelHandle } from "@workspace/runtime";

/**
 * Get the panel API object.
 * This is the same as importing from @workspace/runtime directly, but as a hook for consistency.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const panel = usePanel();
 *   const handleFocus = (panelId: string) => panel.focusPanel(panelId);
 *   return <button onClick={() => handleFocus(panel.id)}>Focus</button>;
 * }
 * ```
 */
export function usePanel() {
  return runtime;
}

/**
 * Contribute commands to the owning application shell and handle a selection.
 * Each host presents the commands idiomatically (for example, a desktop
 * command palette or native mobile action sheet).
 *
 * @example
 * ```tsx
 * useHostCommands(
 *   [{ id: "new", label: "New pane", group: "Terminal" }],
 *   (id) => { if (id === "new") openPane(); }
 * );
 * ```
 */
export function useHostCommands(commands: HostCommand[], onRun: (commandId: string) => void): void {
  // Keep the latest handler in a ref so re-registration only tracks `commands`.
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  // Re-register whenever the command set's identity changes.
  const key = useMemo(
    () => JSON.stringify(commands.map((c) => [c.id, c.label, c.description, c.group])),
    [commands]
  );

  useEffect(() => {
    // Registration must never crash a host that lacks host-command support
    // (headless runtimes or tests rendering a panel without a
    // connected bridge). The runtime's own calls are already fire-and-forget;
    // this guards the access path itself.
    let unsubscribe: () => void = () => {};
    try {
      runtime.panel.registerHostCommands(commands);
      unsubscribe = runtime.panel.onHostCommandRun((commandId) => onRunRef.current(commandId));
    } catch {
      // No command-capable host — contribute nothing, silently.
    }
    return () => {
      try {
        unsubscribe();
        runtime.panel.unregisterHostCommands();
      } catch {
        // ignore teardown on a host without host-command support
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/**
 * Get the panel's ID.
 * This is a static value, so it's memoized.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const panelId = usePanelId();
 *   return <div>My ID: {panelId}</div>;
 * }
 * ```
 */
export function usePanelId(): string {
  return runtime.id;
}

/**
 * Get the panel's context ID.
 * Context ID format: {mode}_{type}_{identifier}
 * - mode: "safe" | "unsafe" - security context
 * - type: "auto" | "named" - auto = tree-derived, named = explicit
 * - identifier: tree path or random string
 *
 * Panels/workers with the same context share filesystem and storage state.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const contextId = useContextId();
 *   return <div>Context: {contextId}</div>;
 * }
 * ```
 */
export function useContextId(): string {
  return runtime.contextId;
}

/**
 * Get the panel's partition name.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const partition = usePanelPartition();
 *   return <div>Storage partition: {partition ?? "loading..."}</div>;
 * }
 * ```
 */
export function usePanelPartition(): string | null {
  const [partition, setPartition] = useState<string | null>(null);

  useEffect(() => {
    runtime.panel
      .getInfo()
      .then((info) => setPartition(info.partition))
      .catch(console.error);
  }, []);

  return partition;
}

/**
 * Subscribe to global RPC events from any panel.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const [events, setEvents] = useState<Array<{ from: string; data: any }>>([]);
 *
 *   usePanelRpcGlobalEvent("status-update", (fromPanelId, payload) => {
 *     setEvents(prev => [...prev, { from: fromPanelId, data: payload }]);
 *   });
 *
 *   return <div>Events: {events.length}</div>;
 * }
 * ```
 */
export function usePanelRpcGlobalEvent<T = unknown>(
  eventName: string,
  handler: (fromPanelId: string, payload: T) => void
): void {
  useEffect(() => {
    const unsubscribe = runtime.rpc.on(eventName, (event) => {
      handler(event.caller.callerId, event.payload as T);
    });
    return unsubscribe;
  }, [eventName, handler]);
}

// =============================================================================
// Parent PanelHandle Hooks
// =============================================================================

/**
 * Get a typed handle for communicating with the parent panel.
 * Returns null if this panel has no parent (is root).
 *
 * @typeParam T - RPC methods the parent exposes
 * @typeParam E - RPC event map for typed events from parent
 *
 * @example
 * ```tsx
 * interface ParentApi {
 *   notifyReady(): Promise<void>;
 *   reportStatus(status: string): Promise<void>;
 * }
 *
 * function MyPanel() {
 *   const parent = usePanelParent<ParentApi>();
 *
 *   useEffect(() => {
 *     if (parent) {
 *       parent.call.notifyReady();
 *     }
 *   }, [parent]);
 *
 *   return <div>Has parent: {parent ? "Yes" : "No"}</div>;
 * }
 * ```
 */
export function usePanelParent<
  T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
  E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
>(): PanelHandle<T, E> | null {
  // getParent() returns a cached handle, so useMemo is for React stability
  return useMemo(() => runtime.getParent<T, E>(), []);
}

/**
 * Track focus state of the panel.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const isFocused = usePanelFocus();
 *   return (
 *     <div style={{ opacity: isFocused ? 1 : 0.5 }}>
 *       {isFocused ? "Focused" : "Not focused"}
 *     </div>
 *   );
 * }
 * ```
 */
export function usePanelFocus(): boolean {
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    const unsubscribe = runtime.panel.onFocus(() => {
      setIsFocused(true);
    });

    // Reset focus state on blur
    const handleBlur = () => setIsFocused(false);
    window.addEventListener("blur", handleBlur);

    return () => {
      unsubscribe();
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  return isFocused;
}

// =============================================================================
// Connection Error Hook
// =============================================================================

/**
 * Subscribe to connection errors (terminal WebSocket auth failures).
 * Returns null when connected, or an error object with code and reason.
 *
 * This fires when the WS transport encounters a terminal auth failure
 * (e.g., invalid token, bad handshake). The panel is non-functional at
 * this point since all RPC goes through the WebSocket.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const connError = useConnectionError();
 *   if (connError) {
 *     return <div>Disconnected: {connError.reason} ({connError.code})</div>;
 *   }
 *   return <div>Panel content</div>;
 * }
 * ```
 */
export function useConnectionError(): { code: number; reason: string } | null {
  const [error, setError] = useState<{ code: number; reason: string } | null>(null);

  useEffect(() => {
    return runtime.panel.onConnectionError((err) => {
      setError(err);
    });
  }, []);

  return error;
}

// =============================================================================
// Agent State Introspection
// =============================================================================

/**
 * Expose a slice of this panel's state to debugging agents under `key`.
 *
 * Agents read it from the host via `handle.state()` (which calls the
 * `_agent.state` method). Without this, `handle.state()` returns `{}` because
 * React component state is not otherwise reachable from outside the renderer.
 *
 * The latest `value` is always reported — the registered provider reads a ref,
 * so re-renders update what agents see without re-registering. Pass a unique
 * `key` per slice; the registration is removed automatically on unmount.
 *
 * @example
 * ```tsx
 * function Editor() {
 *   const [doc, setDoc] = useState(initialDoc);
 *   const [dirty, setDirty] = useState(false);
 *   useAgentState("editor", { path: doc.path, dirty, length: doc.text.length });
 *   // An agent debugging this panel: await parent.state()
 *   // => { editor: { path: "Welcome.mdx", dirty: true, length: 1280 } }
 *   return <textarea value={doc.text} onChange={...} />;
 * }
 * ```
 */
export function useAgentState(key: string, value: unknown): void {
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    const register = runtime.agentApi?.registerStateProvider;
    if (!register) return;
    const unregister = register(key, () => valueRef.current);
    return () => {
      unregister();
    };
  }, [key]);
}

// =============================================================================
// State Args Hook
// =============================================================================

/**
 * Reactively read this panel's state args, re-rendering whenever they change.
 *
 * Initializes from the synchronous snapshot (`runtime.panel.stateArgs.get()`,
 * which reads `window.__vibestudioStateArgs`) and then subscribes to the
 * host-published `"vibestudio:stateArgsChanged"` window event, whose `detail`
 * carries the new args. Use this React hook in place of the one-shot
 * `runtime.panel.stateArgs.get()` when the panel must follow live updates made
 * via `runtime.panel.stateArgs.set()` (or by another panel).
 *
 * This is the React-bound replacement for the former
 * `runtime.panel.stateArgs.use` / `@workspace/runtime` `useStateArgs`, which was
 * moved here to keep `@workspace/runtime` framework-neutral. The non-reactive
 * `get`/`set` helpers remain in `@workspace/runtime`.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const args = useStateArgs<{ vaultId: string }>();
 *   return <div>Vault: {args.vaultId}</div>;
 * }
 * ```
 */
export function useStateArgs<T = Record<string, unknown>>(): T {
  const [args, setArgs] = useState<T>(() => runtime.panel.stateArgs.get<T>());

  useEffect(() => {
    const handler = (event: CustomEvent<Record<string, unknown>>) => {
      setArgs(event.detail as T);
    };
    window.addEventListener("vibestudio:stateArgsChanged", handler as EventListener);
    return () =>
      window.removeEventListener("vibestudio:stateArgsChanged", handler as EventListener);
  }, []);

  return args;
}
