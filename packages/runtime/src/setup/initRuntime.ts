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
import { _initFsWithRpc } from "../panel/fs.js";

export interface InitRuntimeOptions {
  /** Function to create the RPC transport */
  createTransport: () => EnvelopeRpcTransport;
  /** Filesystem implementation (RPC-backed proxy) */
  fs: RuntimeFs;
  /** Optional function to set up globals before runtime initialization */
  setupGlobals?: () => void;
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
  options.setupGlobals?.();
  if (config.kind === "panel") {
    assertPanelPrincipalId(config.entityId);
  }

  const runtime = createRuntime({
    selfId: config.entityId,
    createTransport: options.createTransport,
    entityId: config.entityId,
    slotId: config.slotId,
    contextId: config.contextId,
    parentId: config.parentId,
    parentEntityId: config.parentEntityId,
    initialTheme: config.initialTheme,
    fs: options.fs,
    setupGlobals: options.setupGlobals,
    gatewayConfig: config.gatewayConfig,
    effectiveVersion: config.effectiveVersion,
  });

  // Initialize RPC-backed fs with the runtime's RPC bridge
  _initFsWithRpc(runtime.rpc);

  return {
    runtime,
    config,
    fs: runtime.fs,
  };
}
