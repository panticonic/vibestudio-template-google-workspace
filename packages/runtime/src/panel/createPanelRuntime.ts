import {
  createRuntime,
  type RuntimeDeps,
  type Runtime,
} from "../setup/createRuntime.js";
import type { GatewayConfig } from "../shared/globals.js";
import { helpfulNamespace } from "../shared/helpfulNamespace.js";
import { createGatewayFetch } from "../shared/gatewayFetch.js";
import {
  createHostedRuntime,
  type RuntimeHost,
} from "../shared/hostedRuntime.js";
import { createPanelSelfNavigation } from "./selfNavigation.js";
import { createAdBlockApi } from "./adblock.js";
import type {
  ShellSurfaceKind,
  ShellSurfaceTarget,
} from "@vibestudio/shared/shellSurface";
export interface PanelApiConfig {
  entityId: string;
  slotId?: string;
  env?: Record<string, string>;
  gatewayConfig?: GatewayConfig | null;
}
/** The complete panel API; identical for installed panels and connected websites. */
export function createPanelApi(
  bootstrapRuntime: Runtime,
  config: PanelApiConfig,
) {
  const _entityId = config.entityId;
  const _slotId = config.slotId ?? config.entityId;
  const _env = config.env;
  const id = config.entityId;
  const gatewayConfig = config.gatewayConfig ?? null;
  const gatewayFetch = createGatewayFetch({
    rpc: bootstrapRuntime.rpc,
    serverUrl: gatewayConfig?.serverUrl,
  });

  const { parentId: runtimeParentId, rpc, fs, contextId } = bootstrapRuntime;

  // The factory owns one handle runtime for parent access and all panel operations.

  const {
    openExternal: _hostOpenExternal,
    openPanel: _hostOpenPanel,
    createPanelSlot: _hostCreatePanelSlot,
    getPanelHandle: _hostGetPanelHandle,
    panelTree: _hostPanelTree,
    onChildCreated: _onChildCreated,
    onChildCreationError: _onChildCreationError,
  } = bootstrapRuntime.panelRuntime;

  // --- The portable runtime surface — derived ONCE here (identical to worker +
  // eval) from the panel's host ports. ---
  const _panelHost: RuntimeHost = {
    id,
    contextId,
    rpc,
    fs,
    gatewayConfig,
    gatewayFetch,
    panelRuntime: {
      createPanelSlot: _hostCreatePanelSlot,
      openPanel: _hostOpenPanel,
      getPanelHandle: _hostGetPanelHandle,
      panelTree: _hostPanelTree,
    },
    workers: bootstrapRuntime.workers,
    openExternal: _hostOpenExternal,
    resolveParent: bootstrapRuntime.resolveParent,
  };
  const _core = createHostedRuntime(_panelHost);

  // Portable top-level surface (callMain/parent/getParent/getParentWithContract +
  // every rpc-mediated namespace + panel-tree affordances) — sourced from _core so
  // panel ≡ worker ≡ eval.
  const {
    callMain,
    parent,
    getParent,
    getParentWithContract,
    gad,
    blobstore,
    images,
    workspace,
    workspaces,
    runtime,
    credentials,
    browserData,
    git,
    vcs,
    webhooks,
    extensions,
    templates,
    notifications,
    services,
    hosts,
    doTargetId,
    createDurableObjectServiceClient,
    openExternal,
    createPanelSlot,
    openPanel,
    getPanelHandle,
    panelTree,
  } = _core;

  const workers = helpfulNamespace("workers", _core.workers);

  const { reopen, switchContext } = createPanelSelfNavigation({
    rpc,
    slotId: _slotId,
    navigatePanel: (slotId, source, options) =>
      _hostPanelTree.navigate(slotId, source, options),
  });

  const panel = helpfulNamespace("panel", {
    entityId: _entityId,
    slotId: _slotId,
    parentId: runtimeParentId,
    contextId,
    env: _env,
    setTitle: (
      title: string | null,
      options?: {
        /** Preserve this user-chosen title across inferred document-title updates. */
        explicit?: boolean;
      },
    ) => callMain<void>("runtime.setTitle", title, options),
    /**
     * Hand the user to the agent that sees this panel: open the shell's command
     * overlay bound to this panel's slot, optionally with the compose box
     * pre-filled. Nothing is sent on the panel's behalf — the user presses send.
     * Rejects on hosts without a command overlay (headless, some clients).
     */
    /**
     * Open a shell-owned surface: an About page, the command overlay about any
     * panel, a panel's contributed host command, or management chrome. The host
     * validates the target and rejects kinds it cannot open — check
     * `describeShellSurfaces()` first to offer only what works on this host.
     * `createShellSurfaceLink` from `@vibestudio/shared/shellSurface` builds the
     * matching `vibestudio://…` deep link for the same target.
     */
    openShellSurface: (target: ShellSurfaceTarget) =>
      callMain<void>("app.openShellSurface", target),
    describeShellSurfaces: () =>
      callMain<{ surfaces: ShellSurfaceKind[] }>("app.describeShellSurfaces"),
    openCommandAgent: (options?: {
      /** Pre-filled compose text; implies the `/` conversation surface. */
      prompt?: string;
      mode?: "all" | "commands" | "goto" | "quickfire";
    }) =>
      callMain<void>("app.openShellSurface", {
        kind: "command-agent",
        panelId: _slotId,
        ...(options?.mode ? { mode: options.mode } : {}),
        ...(options?.prompt ? { prompt: options.prompt } : {}),
      }),
    getInfo: bootstrapRuntime.getInfo,
    focusPanel: bootstrapRuntime.focusPanel,
    getTheme: bootstrapRuntime.getTheme,
    onThemeChange: bootstrapRuntime.onThemeChange,
    getThemeConfig: bootstrapRuntime.getThemeConfig,
    onThemeConfigChange: bootstrapRuntime.onThemeConfigChange,
    registerHostCommands: bootstrapRuntime.registerHostCommands,
    unregisterHostCommands: bootstrapRuntime.unregisterHostCommands,
    onHostCommandRun: bootstrapRuntime.onHostCommandRun,
    onFocus: bootstrapRuntime.onFocus,
    onConnectionError: bootstrapRuntime.onConnectionError,
    onChildCreated: _onChildCreated,
    onChildCreationError: _onChildCreationError,
    reopen,
    switchContext,
    stateArgs: helpfulNamespace("panel.stateArgs", {
      get: bootstrapRuntime.stateArgs.get,
      set: bootstrapRuntime.stateArgs.set,
      setForPanel: bootstrapRuntime.stateArgs.setForPanel,
    }),
  });

  const agentApi = bootstrapRuntime.agentApi;
  const adblock = helpfulNamespace("adblock", createAdBlockApi(rpc));
  return {
    id,
    contextId,
    rpc,
    fs,
    gatewayConfig,
    gatewayFetch,
    callMain,
    parent,
    getParent,
    getParentWithContract,
    gad,
    blobstore,
    images,
    workspace,
    workspaces,
    runtime,
    credentials,
    browserData,
    git,
    vcs,
    webhooks,
    extensions,
    templates,
    notifications,
    services,
    hosts,
    doTargetId,
    createDurableObjectServiceClient,
    openExternal,
    createPanelSlot,
    openPanel,
    getPanelHandle,
    panelTree,
    workers,
    panel,
    agentApi,
    adblock,
    destroy: bootstrapRuntime.destroy,
  };
}
export function createPanelRuntime(
  deps: RuntimeDeps & { env?: Record<string, string> },
) {
  return createPanelApi(createRuntime(deps), deps);
}
export type PanelApi = ReturnType<typeof createPanelApi>;
