/**
 * Panel runtime factory — extends createBaseRuntime with panel-specific features.
 *
 * Adds: stateArgs bridge, unified panel handles, panel lifecycle methods.
 */

import type { EnvelopeRpcTransport } from "@vibestudio/rpc";
import { createBaseRuntime } from "./createBaseRuntime.js";
import type { GatewayConfig } from "../shared/globals.js";
import { createParentHandleApi } from "../shared/handles.js";
import { createPanelHandleApi } from "../panel/handle.js";
import type { ThemeAppearance } from "../types.js";
import { createStateArgsRuntime } from "../panel/stateArgs.js";
import { createAgentApi, exposeAgentApi } from "../panel/agentApi.js";
import { createPanelBootReporter } from "../panel/bootReporter.js";
import type {
  PanelEntityId,
  PanelSlotId,
} from "@vibestudio/shared/panel/idValues";
import type { PanelBootObservation } from "@vibestudio/shared/panel/observation";

export interface RuntimeDeps {
  onRecovery?: import("@vibestudio/rpc").RpcClientRecoveryOptions["onRecovery"];
  selfId: PanelEntityId;
  environment?: import("../panel/runtimeEnvironment.js").PanelRuntimeEnvironment;
  createTransport: (lifetime: AbortSignal) => EnvelopeRpcTransport;
  entityId: PanelEntityId;
  id?: PanelEntityId;
  slotId?: PanelSlotId;
  contextId: string;
  parentId: PanelSlotId | null;
  parentEntityId?: PanelEntityId | null;
  initialTheme: ThemeAppearance;
  gatewayConfig?: GatewayConfig | null;
  effectiveVersion?: string | null;
}

export function createRuntime(deps: RuntimeDeps) {
  const entityId = deps.entityId;
  const slotId = deps.slotId ?? (entityId as unknown as PanelSlotId);
  const parentRuntimeId = deps.parentEntityId ?? deps.parentId ?? null;
  const base = createBaseRuntime({ ...deps, id: entityId });
  const environment = deps.environment;

  const bootReporter = createPanelBootReporter({
    rpc: base.rpc,
    observeView: (boot) => ({
      url: environment?.location?.href ?? "",
      loading: environment?.document?.readyState === "loading",
      boot,
    }),
    onError: (error, observation) => {
      console.warn("[panelRuntime] Failed to publish renderer boot evidence", {
        phase: observation.boot.observation.phase,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const publishBoot = (boot: PanelBootObservation) => {
    environment?.boot?.report?.(boot);
    bootReporter.publish(boot);
  };
  if (environment?.boot?.initial) publishBoot(environment.boot.initial);
  const stopBoot = environment?.boot?.subscribe(publishBoot);
  const stateArgs = createStateArgsRuntime({
    slotId,
    call: (service, method, args) => base.rpc.call(service, method, args),
    initial: environment?.stateArgs?.initial,
    changed: environment?.stateArgs?.changed,
  });
  const agentApi = createAgentApi(environment);
  exposeAgentApi(agentApi, base.expose);
  const stopStateArgs = environment?.events?.subscribe((event, payload) => {
    if (event === "runtime:stateArgsChanged")
      stateArgs.apply((payload ?? {}) as Record<string, unknown>);
  });

  const parentSlotId = parentRuntimeId
    ? (deps.parentId ?? parentRuntimeId)
    : null;
  const panelRuntime = createPanelHandleApi(base.rpc, {
    selfId: slotId,
    selfRpcTargetId: entityId,
    parentId: parentSlotId,
    parentRpcTargetId: parentRuntimeId,
    effectiveVersion: deps.effectiveVersion ?? null,
  });

  const parentHandleOrNull = parentSlotId
    ? panelRuntime.getPanelHandle(parentSlotId)
    : null;
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

    panelRuntime,
    resolveParent,
    parent: parentApi.parent,
    getParent: parentApi.getParent,
    getParentWithContract: parentApi.getParentWithContract,

    onConnectionError: base.onConnectionError,

    getInfo: () =>
      environment?.getInfo?.() ??
      Promise.reject(new Error("Host information is unavailable")),
    focusPanel: (panelId: string) =>
      environment?.focusPanel?.(panelId) ??
      Promise.reject(new Error("Panel focus is unavailable")),
    stateArgs,
    agentApi,

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
      stopStateArgs?.();
      stopBoot?.();
      bootReporter.dispose();
      panelRuntime.destroy();
      base.destroy();
    },
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
