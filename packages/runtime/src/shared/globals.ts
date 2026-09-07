/**
 * Unified injected globals for panels and workers.
 *
 * Both environments receive the same global names.
 */

import type { PanelEntityId, PanelSlotId } from "@vibestudio/shared/panel/idValues";

export interface GatewayConfig {
  serverUrl: string;
  token: string;
  aliases?: readonly string[];
  /** Selected logical workspace when it cannot be inferred from serverUrl. */
  workspace?: string;
}

/**
 * Injected globals available in both panel and worker environments.
 */
declare global {
  /** Runtime entity ID for this panel or worker */
  var __vibestudioEntityId: string | undefined;
  /** Stable workspace slot id for panel tree operations. */
  var __vibestudioSlotId: string | undefined;
  /** Context ID for storage partition (format: {mode}_{type}_{identifier}) */
  var __vibestudioContextId: string | undefined;
  /** Environment kind: "panel" or "shell" */
  var __vibestudioKind: "panel" | "shell" | undefined;
  /** Parent panel ID if this is a child panel/worker */
  var __vibestudioParentId: string | null | undefined;
  /** Runtime entity ID for the parent panel, used for child-to-parent RPC. */
  var __vibestudioParentEntityId: string | null | undefined;
  /** Initial theme appearance */
  var __vibestudioInitialTheme: "light" | "dark" | undefined;
  /** Single gateway configuration for HTTP and RPC-derived clients. */
  var __vibestudioGatewayConfig: GatewayConfig | undefined;
  /** Source repo path for this endpoint */
  var __vibestudioSourceRepo: string | undefined;
  /** Exact effective version for the source currently running. */
  var __vibestudioEffectiveVersion: string | null | undefined;
  var __vibestudioBuildKey: string | null | undefined;
  var __vibestudioPanelBoot:
    | {
        phase: "loading" | "booting" | "ready" | "failed";
        startedAt: number;
        updatedAt: number;
        runtimeEntityId?: string | null;
        source?: string | null;
        contextId?: string | null;
        effectiveVersion?: string | null;
        buildKey?: string | null;
        error?: { name: string; message: string; stack?: string };
      }
    | undefined;
  /** Published by the host loader and called by the generated entry after mount. */
  var __vibestudioPanelMarkReady: (() => void) | undefined;
  /** Environment variables */
  var __vibestudioEnv: Record<string, string> | undefined;
}

export interface InjectedConfig {
  entityId: PanelEntityId;
  slotId?: PanelSlotId;
  contextId: string;
  kind: "panel" | "shell";
  parentId: PanelSlotId | null;
  parentEntityId: PanelEntityId | null;
  initialTheme: "light" | "dark";
  gatewayConfig: GatewayConfig;
  env: Record<string, string>;
  effectiveVersion: string | null;
}

// Access globals via globalThis to support VM sandbox environments
// where globals are set on the context object
const g = globalThis as unknown as {
  __vibestudioEntityId?: string;
  __vibestudioSlotId?: string;
  __vibestudioContextId?: string;
  __vibestudioKind?: "panel" | "shell";
  __vibestudioParentId?: string | null;
  __vibestudioParentEntityId?: string | null;
  __vibestudioInitialTheme?: "light" | "dark";
  __vibestudioGatewayConfig?: GatewayConfig;
  __vibestudioSourceRepo?: string;
  __vibestudioEffectiveVersion?: string | null;
  __vibestudioBuildKey?: string | null;
  __vibestudioEnv?: Record<string, string>;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function normalizeGatewayConfigForBrowser(config: GatewayConfig): GatewayConfig {
  const location = (globalThis as { location?: { origin?: string } }).location;
  if (!location?.origin) return config;

  try {
    const injectedUrl = new URL(config.serverUrl);
    const pageUrl = new URL(location.origin);
    const sameLoopbackPort =
      injectedUrl.protocol === pageUrl.protocol &&
      injectedUrl.port === pageUrl.port &&
      LOOPBACK_HOSTS.has(injectedUrl.hostname) &&
      LOOPBACK_HOSTS.has(pageUrl.hostname);
    if (!sameLoopbackPort || injectedUrl.origin === pageUrl.origin) return config;

    const rewritten = new URL(config.serverUrl);
    rewritten.protocol = pageUrl.protocol;
    rewritten.host = pageUrl.host;
    const aliases = Array.from(new Set([...(config.aliases ?? []), config.serverUrl]));
    return { ...config, serverUrl: rewritten.toString().replace(/\/$/, ""), aliases };
  } catch {
    return config;
  }
}

/**
 * Get the injected configuration from globals.
 */
export function getInjectedConfig(): InjectedConfig {
  const entityId = g.__vibestudioEntityId;
  if (typeof entityId === "undefined" || !entityId) {
    throw new Error(
      "Vibestudio runtime globals not found. Expected __vibestudioEntityId to be defined."
    );
  }
  if (!g.__vibestudioGatewayConfig?.serverUrl || !g.__vibestudioGatewayConfig?.token) {
    throw new Error(
      "Vibestudio runtime globals not found. Expected __vibestudioGatewayConfig with serverUrl and token."
    );
  }

  const effectiveVersion =
    g.__vibestudioEffectiveVersion ?? g.__vibestudioEnv?.["__VIBESTUDIO_EFFECTIVE_VERSION"] ?? null;
  const gatewayConfig = normalizeGatewayConfigForBrowser(g.__vibestudioGatewayConfig);

  return {
    entityId: entityId as PanelEntityId,
    slotId: g.__vibestudioSlotId as PanelSlotId | undefined,
    contextId: g.__vibestudioContextId ?? "",
    kind: g.__vibestudioKind ?? "panel",
    parentId:
      typeof g.__vibestudioParentId === "string" && g.__vibestudioParentId.length > 0
        ? (g.__vibestudioParentId as PanelSlotId)
        : null,
    parentEntityId:
      typeof g.__vibestudioParentEntityId === "string" && g.__vibestudioParentEntityId.length > 0
        ? (g.__vibestudioParentEntityId as PanelEntityId)
        : null,
    initialTheme: g.__vibestudioInitialTheme === "dark" ? "dark" : "light",
    gatewayConfig,
    env: g.__vibestudioEnv ?? {},
    effectiveVersion,
  };
}
