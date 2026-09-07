/**
 * Panel runtime factory — extends createBaseRuntime with panel-specific features.
 *
 * Adds: stateArgs bridge, unified panel handles, panel lifecycle methods.
 */

import type { EnvelopeRpcTransport } from "@vibestudio/rpc";
import { createBaseRuntime } from "./createBaseRuntime.js";
import type { EndpointInfo } from "../core/index.js";
import type { GatewayConfig } from "../shared/globals.js";
import { createParentHandleApi } from "../shared/handles.js";
import { createPanelRuntime } from "../shared/panelRuntime.js";
import type { RuntimeFs, ThemeAppearance } from "../types.js";
import { _applyStateArgsFromHost, _initStateArgsRuntime } from "../panel/stateArgs.js";
import { exposeAgentApi } from "../panel/agentApi.js";
import { createPanelBootReporter } from "../panel/bootReporter.js";
import type { PanelEntityId, PanelSlotId } from "@vibestudio/shared/panel/idValues";
import type { PanelBootObservation } from "@vibestudio/shared/panel/observation";

export interface RuntimeDeps {
  selfId: PanelEntityId;
  createTransport: () => EnvelopeRpcTransport;
  entityId: PanelEntityId;
  id?: PanelEntityId;
  slotId?: PanelSlotId;
  contextId: string;
  parentId: PanelSlotId | null;
  parentEntityId?: PanelEntityId | null;
  initialTheme: ThemeAppearance;
  fs: RuntimeFs;
  setupGlobals?: () => void;
  gatewayConfig?: GatewayConfig | null;
  effectiveVersion?: string | null;
}

export function createRuntime(deps: RuntimeDeps) {
  const entityId = deps.entityId;
  const slotId = deps.slotId ?? (entityId as unknown as PanelSlotId);
  const parentRuntimeId = deps.parentEntityId ?? deps.parentId ?? null;
  const base = createBaseRuntime({ ...deps, id: entityId });
  const shell = (globalThis as any).__vibestudioShell;

  const bootReporter = createPanelBootReporter({
    rpc: base.rpc,
    observeView: (boot) => ({
      url: globalThis.location?.href ?? "",
      loading: globalThis.document?.readyState === "loading",
      boot,
    }),
    onError: (error, observation) => {
      console.warn("[panelRuntime] Failed to publish renderer boot evidence", {
        phase: observation.boot.observation.phase,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const initialBoot = globalThis.__vibestudioPanelBoot;
  if (initialBoot) {
    shell?.reportPanelBoot?.(initialBoot);
    bootReporter.publish(initialBoot);
  }
  const onPanelBoot = (event: Event): void => {
    const boot = (event as CustomEvent<PanelBootObservation>).detail;
    if (boot) {
      shell?.reportPanelBoot?.(boot);
      bootReporter.publish(boot);
    }
  };
  globalThis.addEventListener?.("vibestudio:panel-boot", onPanelBoot);

  _initStateArgsRuntime(slotId, (service, method, args) => base.rpc.call(service, method, args));
  exposeAgentApi(base.expose);
  if (typeof shell?.addEventListener === "function") {
    shell.addEventListener((event: string, payload: unknown) => {
      if (event === "runtime:stateArgsChanged") {
        _applyStateArgsFromHost((payload ?? {}) as Record<string, unknown>);
      }
    });
  }

  const parentSlotId = parentRuntimeId ? (deps.parentId ?? parentRuntimeId) : null;
  const panelRuntime = createPanelRuntime({
    rpc: base.rpc,
    ...(typeof shell?.focusPanel === "function"
      ? { focusPanel: (panelId, focusOptions) => shell.focusPanel(panelId, focusOptions) }
      : {}),
    selfId: slotId,
    selfRpcTargetId: entityId,
    parentId: deps.parentId,
    defaultOpenParentId: slotId,
    requesterPanelId: slotId,
    effectiveVersion: deps.effectiveVersion ?? null,
    initialMetadata: parentSlotId
      ? [
          {
            id: parentSlotId,
            title: parentSlotId,
            source: parentSlotId,
            kind: "workspace",
            parentId: null,
            rpcTargetId: parentRuntimeId,
          },
        ]
      : [],
  });

  const parentHandleOrNull = parentSlotId ? panelRuntime.getPanelHandle(parentSlotId) : null;
  // The barrel feeds this resolver to the host so `createHostedRuntime` derives
  // the portable `parent`/`getParent`/`getParentWithContract`. The same handles
  // are also exposed here for the panel runtime's own (non-barrel) consumers.
  const resolveParent = () => parentHandleOrNull;
  const parentApi = createParentHandleApi(resolveParent);

  return {
    id: base.id,
    entityId: base.id,
    slotId,
    parentId: deps.parentId,
    parentEntityId: deps.parentEntityId ?? null,

    rpc: base.rpc,
    callMain: base.callMain,
    fs: base.fs,
    workers: base.workers,

    resolveParent,
    parent: parentApi.parent,
    getParent: parentApi.getParent,
    getParentWithContract: parentApi.getParentWithContract,

    onConnectionError: base.onConnectionError,

    getInfo: () => shell.getInfo() as Promise<EndpointInfo>,
    focusPanel: (panelId: string) => shell.focusPanel(panelId),

    getTheme: base.getTheme,
    onThemeChange: base.onThemeChange,
    getThemeConfig: base.getThemeConfig,
    onThemeConfigChange: base.onThemeConfigChange,

    registerHostCommands: base.registerHostCommands,
    unregisterHostCommands: base.unregisterHostCommands,
    onHostCommandRun: base.onHostCommandRun,

    onFocus: base.onFocus,

    expose: base.expose,

    contextId: base.contextId,
    destroy: () => {
      globalThis.removeEventListener?.("vibestudio:panel-boot", onPanelBoot);
      bootReporter.dispose();
      base.destroy();
    },
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
