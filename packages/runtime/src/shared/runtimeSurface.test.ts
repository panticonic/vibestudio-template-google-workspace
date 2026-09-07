import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { RpcClient } from "@vibestudio/rpc";
import { helpfulNamespace } from "./helpfulNamespace.js";
import { createHostedRuntime, type RuntimeHost } from "./hostedRuntime.js";
import { createWorkerRuntime } from "../worker/index.js";
import { panelRuntimeSurface } from "@vibestudio/service-schemas/runtime/runtimeSurface.panel";
import { workerRuntimeSurface } from "@vibestudio/service-schemas/runtime/runtimeSurface.worker";
import { coreRuntimeSurface } from "@vibestudio/service-schemas/runtime/runtimeSurface.core";
import {
  EVAL_AMBIENT_ONLY,
  evalImportableSurface,
} from "@vibestudio/service-schemas/runtime/runtimeSurface.eval";
import { PORTABLE_KEYS } from "@vibestudio/service-schemas/runtime/runtimeSurface.portable";

/**
 * Execution-based cross-target parity gates. Instead of grepping source, we
 * EXECUTE the one shared `createHostedRuntime` and each target's assembly, then
 * diff `Object.keys()` against the manifests. This proves panel ≡ worker ≡ eval
 * derive the identical core surface directly — a tighter guarantee than the old
 * per-entry source-greps.
 */

// A stub RpcClient — the feature-client factories only wrap it (no I/O at build).
function stubRpc(): RpcClient {
  const noop = () => {};
  return {
    selfId: "test",
    expose: noop,
    exposeAll: noop,
    exposeStreaming: noop,
    call: async () => undefined,
    stream: async () => new Response(),
    emit: async () => {},
    on: () => noop,
    peer: () => ({}) as never,
    status: () => "connected",
    ready: async () => {},
    onStatusChange: () => noop,
  } as unknown as RpcClient;
}

function fakeHost(): RuntimeHost {
  const rpc = stubRpc();
  const panelRuntime = {
    createPanelSlot: async () => ({}) as never,
    openPanel: async () => ({}) as never,
    getPanelHandle: () => ({}) as never,
    panelTree: {} as never,
  };
  return {
    id: "id",
    contextId: "ctx",
    rpc,
    fs: {} as never,
    gatewayConfig: { serverUrl: "http://x", token: "t" },
    gatewayFetch: async () => new Response(),
    panelRuntime,
    workers: {} as never,
    openExternal: async () => ({}) as never,
    resolveParent: () => null,
  };
}

describe("runtimeSurface manifests", () => {
  it("helpfulNamespace throws a helpful error for missing namespace members", () => {
    const wrapped = helpfulNamespace("workspace", { list: async () => [] });
    expect(() => (wrapped as Record<string, unknown>)["listSources"]).toThrow(
      "workspace.listSources is not available. Known members on workspace: list. Call `await help()` for the live surface."
    );
  });

  it("createHostedRuntime produces exactly the eval-importable surface (panel ≡ worker ≡ eval core)", () => {
    const rt = createHostedRuntime(fakeHost());
    expect(new Set(Object.keys(rt))).toEqual(new Set(Object.keys(evalImportableSurface.exports)));
  });

  it("createHostedRuntime, eval, panel, and worker all agree on the portable surface", () => {
    const rt = createHostedRuntime(fakeHost());
    const portable = new Set(PORTABLE_KEYS);
    // createHostedRuntime output === the portable key set === eval importable keys.
    expect(new Set(Object.keys(rt))).toEqual(portable);
    expect(new Set(Object.keys(evalImportableSurface.exports))).toEqual(portable);
    // panel & worker manifests each CONTAIN the full portable surface (panel adds
    // helpers + the panel/journal namespaces; worker adds handleRpcPost/destroy).
    for (const key of PORTABLE_KEYS) {
      expect(panelRuntimeSurface.exports[key], `panel missing portable ${key}`).toBeDefined();
      expect(workerRuntimeSurface.exports[key], `worker missing portable ${key}`).toBeDefined();
    }
  });

  it("expose and the approval-trio aliases are gone from every surface", () => {
    for (const surface of [evalImportableSurface, panelRuntimeSurface, workerRuntimeSurface]) {
      for (const gone of ["expose", "requestApproval", "revokeApproval", "listApprovals"]) {
        expect(surface.exports[gone], `${gone} should be removed`).toBeUndefined();
      }
    }
  });

  it("no eval ambient-only name is an importable key (rpc is importable, not ambient-only)", () => {
    const importable = new Set(Object.keys(evalImportableSurface.exports));
    for (const name of EVAL_AMBIENT_ONLY) {
      expect(importable.has(name)).toBe(false);
    }
    expect(importable.has("rpc")).toBe(true);
  });

  it("the worker runtime's real exports match its manifest", () => {
    const runtime = createWorkerRuntime({
      WORKER_ID: "surface-test",
      WORKER_SOURCE: "workers/surface-test",
      RPC_AUTH_TOKEN: "token",
      CONTEXT_ID: "ctx",
      GATEWAY_URL: "http://server.test",
    });
    expect(new Set(Object.keys(runtime))).toEqual(
      new Set(Object.keys(workerRuntimeSurface.exports))
    );
    runtime.destroy();
  });

  describe("panel barrel execution", () => {
    const G = globalThis as Record<string, unknown>;
    const saved: Record<string, unknown> = {};
    const PANEL_GLOBALS = {
      __vibestudioEntityId: "panel:test-entity",
      __vibestudioSlotId: "panel:test-slot",
      __vibestudioContextId: "ctx_test",
      __vibestudioKind: "panel",
      __vibestudioInitialTheme: "light",
      __vibestudioEnv: {},
      __vibestudioGatewayConfig: { serverUrl: "http://server.test", token: "tok" },
      // Minimal shell bridge so createPanelTransport() doesn't throw on import.
      __vibestudioShell: {
        postEnvelope: async () => {},
        onEnvelope: () => () => {},
        onRecovery: () => () => {},
      },
    };

    beforeEach(() => {
      vi.resetModules();
      for (const [k, v] of Object.entries(PANEL_GLOBALS)) {
        saved[k] = G[k];
        G[k] = v;
      }
    });
    afterEach(() => {
      for (const k of Object.keys(PANEL_GLOBALS)) {
        if (saved[k] === undefined) delete G[k];
        else G[k] = saved[k];
      }
    });

    it("the panel barrel's real value exports match its manifest", async () => {
      const panel = (await import("../panel/index.js")) as Record<string, unknown>;
      // Module-namespace keys are the runtime VALUE exports (type-only re-exports
      // are erased), so this is the same execution-based guarantee the worker test
      // gives — drift between the panel's real exports and its manifest fails here.
      const realExports = new Set(Object.keys(panel));
      // `default` is never a documented surface member; ignore if a tool injects one.
      realExports.delete("default");
      expect(realExports).toEqual(new Set(Object.keys(panelRuntimeSurface.exports)));
    });
  });

  it("the panel & worker manifests share coreRuntimeSurface byte-for-byte", () => {
    for (const [key, entry] of Object.entries(coreRuntimeSurface)) {
      expect(panelRuntimeSurface.exports[key], `panel.${key}`).toEqual(entry);
      expect(workerRuntimeSurface.exports[key], `worker.${key}`).toEqual(entry);
    }
  });

  it("credentials carries forAudience on every target surface", () => {
    for (const surface of [panelRuntimeSurface, workerRuntimeSurface, evalImportableSurface]) {
      expect(surface.exports["credentials"]?.members).toContain("forAudience");
    }
  });

  it("exposes only the provider-agnostic credential connection API", () => {
    for (const surface of [panelRuntimeSurface, workerRuntimeSurface]) {
      const members = surface.exports["credentials"]?.members ?? [];
      expect(members).toEqual(
        expect.arrayContaining([
          "connect",
          "configureClient",
          "getClientConfigStatus",
          "deleteClientConfig",
        ])
      );
    }
  });
});
