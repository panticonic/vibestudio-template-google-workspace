import { createPanelTransport } from "./transport.js";
import { fs } from "./fs.js"; // RPC-backed fs (server-side per-context folders)
import { initRuntime } from "../setup/initRuntime.js";
import { helpfulNamespace } from "../shared/helpfulNamespace.js";
import { createGatewayFetch } from "../shared/gatewayFetch.js";
import { createHostedRuntime, type RuntimeHost } from "../shared/hostedRuntime.js";

// --- Portable authoring helpers (z, defineContract, Rpc, path/context helpers,
// buildPanelLink, createGatewayFetch) — identical on panel · worker · eval. ---
export * from "../shared/portable.js";
export { FORM_FILL_TYPES } from "@vibestudio/browser-data/form-fill-types";
export type { FormFillType } from "@vibestudio/browser-data/form-fill-types";

// --- Type re-exports ---
export type {
  ThemeAppearance,
  ThemeConfig,
  HostCommand,
  RuntimeFs,
  FileStats,
  MkdirOptions,
  RmOptions,
} from "../types.js";
export type {
  DurableObjectServiceClient,
  ResolvedWorkspaceService,
  WorkspaceServiceInfo,
  WorkerSourceInfo,
} from "../shared/workerd.js";
export type {
  CreatePanelSlotOptions,
  OpenPanelOptions,
  PanelRuntimeTree,
} from "../shared/panelRuntime.js";
export type * from "../shared/gad.js";
export type * from "../core/types.js";
export type { Runtime } from "../setup/createRuntime.js";

// Initialize runtime with panel-specific providers (side effects: stateArgs
// bridge, agentApi registration, transport bring-up).
const { runtime: bootstrapRuntime, config } = initRuntime({
  createTransport: createPanelTransport,
  fs,
});

const _entityId = config.entityId;
const _slotId = config.slotId ?? config.entityId;
const _env = config.env;
export const id = config.entityId;
const gatewayConfig = config.gatewayConfig;
const gatewayFetch = createGatewayFetch(
  { ...gatewayConfig, relativeOnly: true },
  {
    // Stream gateway fetches over the panel's RPC client; it falls back to the
    // duplex stream-frame envelope path when the host bridge has no first-class
    // stream() (mobile and desktop), so gatewayFetch no longer hard-requires one.
    // `body` is the §1.6 upload stream — passed through so a body-capable
    // transport pumps it on the bulk channel (others throw, fail-loud).
    rpcStream: (target, method, args, options) =>
      bootstrapRuntime.rpc.stream(target, method, args, {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.body ? { body: options.body } : {}),
      }),
  }
);
const {
  parentId: runtimeParentId,
  parentEntityId: runtimeParentEntityId,
  rpc,
  contextId,
} = bootstrapRuntime;

// --- Panel handle bridge: openPanel/getPanelHandle/panelTree/
// openExternal/onChildCreated all resolve through this singleton. ---
import { _initPanelHandleBridge } from "./handle.js";
import type { ShellSurfaceKind, ShellSurfaceTarget } from "@vibestudio/shared/shellSurface";
_initPanelHandleBridge(rpc, {
  selfId: _slotId,
  selfRpcTargetId: _entityId,
  parentId: runtimeParentId,
  parentRpcTargetId: runtimeParentEntityId,
  effectiveVersion: config.effectiveVersion,
});
import {
  openExternal as _hostOpenExternal,
  openPanel as _hostOpenPanel,
  createPanelSlot as _hostCreatePanelSlot,
  getPanelHandle as _hostGetPanelHandle,
  panelTree as _hostPanelTree,
  onChildCreated as _onChildCreated,
  onChildCreationError as _onChildCreationError,
} from "./handle.js";
export type { PanelHandle } from "./handle.js";

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

// Credentials still seeds the `@workspace/runtime/panel/credentials` singleton.
import { initPanelCredentials } from "./credentials.js";
initPanelCredentials(rpc);

// Portable top-level surface (callMain/parent/getParent/getParentWithContract +
// every rpc-mediated namespace + panel-tree affordances) — sourced from _core so
// panel ≡ worker ≡ eval.
export const {
  callMain,
  parent,
  getParent,
  getParentWithContract,
  gad,
  blobstore,
  workspace,
  runtime,
  credentials,
  browserData,
  git,
  vcs,
  webhooks,
  extensions,
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
export { rpc, fs, contextId, gatewayConfig, gatewayFetch };
export const workers = helpfulNamespace("workers", _core.workers);

// --- Namespace type re-exports (unchanged) ---
export type { WorkspaceClient, WorkspaceEntry, WorkspaceConfig } from "../shared/workspace.js";
export type {
  ClientConfigStatus,
  ConfigureClientRequest,
  ConnectCredentialRequest,
  CredentialClient,
  CredentialAccessGrantSummary,
  CredentialAccessSubjectSummary,
  CredentialStoreSummary,
  ManagedCredentialSummary,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
  GrantUrlBoundCredentialRequest,
  ResolveUrlBoundCredentialRequest,
  DeleteClientConfigRequest,
  GetClientConfigStatusRequest,
  RequestCredentialInputRequest,
  GitHttpClient,
} from "../shared/credentials.js";
export type * from "../shared/git.js";
export type * from "../shared/vcsClient.js";
export type {
  CreateWebhookIngressSubscriptionRequest,
  RotateWebhookIngressSecretRequest,
  RotateWebhookIngressSecretResult,
  WebhookDeliveredPayload,
  WebhookDeliveryConfig,
  WebhookDeliveryEvent,
  WebhookIngressClient,
  WebhookIngressSubscriptionSummary,
  WebhookPayloadFormat,
  WebhookReplayConfig,
  WebhookResponsePolicy,
  WebhookTarget,
  WebhookVerifierConfig,
} from "../shared/webhooks.js";
export type {
  Disposable,
  ExtensionName,
  ExtensionSource,
  ExtensionsClient,
  RegistryEntry,
  WorkspaceExtensions,
} from "../shared/extensions.js";
export type { NotificationClient } from "./notifications.js";
export type { CdpAutomation, CdpEndpoint } from "./cdpAutomation.js";

// --- Panel-only affordances under the `panel` namespace (panel target only) ---
import { getStateArgs, setStateArgs, setStateArgsForPanel } from "./stateArgs.js";
import { createPanelSelfNavigation } from "./selfNavigation.js";

const { reopen, switchContext } = createPanelSelfNavigation({
  rpc,
  slotId: _slotId,
  navigatePanel: (slotId, source, options) => _hostPanelTree.navigate(slotId, source, options),
});

export const panel = helpfulNamespace("panel", {
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
    }
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
    get: getStateArgs,
    set: setStateArgs,
    setForPanel: setStateArgsForPanel,
  }),
});

// `journal` (panel-operation journaling) is now a portable barrel helper, exported
// via `export * from "../shared/portable.js"` above — available on panel · worker · eval.

// --- Domain namespaces kept top-level (coherent single objects) ---
export { agentApi } from "./agentApi.js";
import { createAdBlockApi } from "./adblock.js";
export type { AdBlockStats, AdBlockApi } from "./adblock.js";
export const adblock = helpfulNamespace("adblock", createAdBlockApi(rpc));

// --- Internal-only diagnostics (NOT part of the public runtime surface) ---
// Wire the panel error-boundary launcher as a side effect; the diagnostic
// helpers themselves live behind `@workspace/runtime/internal/diagnostics`.
import { installPanelErrorDiagnosticLauncher } from "./errorDebugChat.js";
installPanelErrorDiagnosticLauncher({ slotId: _slotId, contextId });
