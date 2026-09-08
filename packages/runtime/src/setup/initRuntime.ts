import { injectedPanelEnvironment } from "../panel/injectedEnvironment.js";
import { bindDefaultStateArgs } from "../panel/stateArgs.js";
/**
 * Runtime initialization for panels.
 *
 * Panels run in WebContentsView with browser environment.
 */

import { createRuntime } from "./createRuntime.js";
import { getInjectedConfig, type InjectedConfig } from "../shared/globals.js";
import { assertPanelPrincipalId } from "@vibestudio/shared/principalIds";
import type { RuntimeFs } from "../types.js";
import type { EnvelopeRpcTransport } from "@vibestudio/rpc";

export interface InitRuntimeOptions {
  onRecovery?: import("@vibestudio/rpc").RpcClientRecoveryOptions["onRecovery"];
  /** Function to create the RPC transport */
  createTransport: (lifetime: AbortSignal) => EnvelopeRpcTransport;
  /** Optional function to set up globals before runtime initialization */
}

export interface InitRuntimeResult {
  /** The initialized runtime */
  runtime: ReturnType<typeof createRuntime>;
  /** The parsed configuration from injected globals */
  config: InjectedConfig;
  /** The filesystem (resolved from provider) */
  fs: RuntimeFs;
}

/**
 * Initialize the runtime with common logic for both panels and workers.
 */
export function initRuntime(options: InitRuntimeOptions): InitRuntimeResult {
  const config = getInjectedConfig();

  // Apply globals setup if provided
  if (config.kind === "panel") {
    assertPanelPrincipalId(config.entityId);
  }

  const runtime = createRuntime({
    environment: injectedPanelEnvironment(),
    selfId: config.entityId,
    createTransport: options.createTransport,
    onRecovery: options.onRecovery,
    entityId: config.entityId,
    slotId: config.slotId,
    contextId: config.contextId,
    parentId: config.parentId,
    parentEntityId: config.parentEntityId,
    initialTheme: config.initialTheme,
    gatewayConfig: config.gatewayConfig,
    effectiveVersion: config.effectiveVersion,
  });

  bindDefaultStateArgs(runtime.stateArgs);
  return {
    runtime,
    config,
    fs: runtime.fs,
  };
}
