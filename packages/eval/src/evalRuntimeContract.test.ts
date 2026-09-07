import { describe, expect, it } from "vitest";
import type { RpcClient } from "@vibestudio/rpc";
import { executeSandbox } from "./sandbox.js";
import { createHostedRuntime, type RuntimeHost } from "@workspace/runtime/hosted";
import * as portableHelpers from "@workspace/runtime/portable";
import {
  evalImportableSurface,
  EVAL_AMBIENT_ONLY,
} from "@vibestudio/service-schemas/runtime/runtimeSurface.eval";

/**
 * Surface contract the EvalDO depends on: the eval engine resolves
 * `import {…} from "@workspace/runtime"` to the SAME `createHostedRuntime` object
 * injected ambiently, rejects importing the ambient-only names, and resolves
 * `@workspace/cdp-client`. This is the unit-level proxy for the live e2e — it
 * exercises the real engine + the real hosted runtime, just not inside a running
 * workerd DO.
 */

function fakeHost(): RuntimeHost {
  const rpc = {
    selfId: "do:test:EvalDO:k",
    call: async () => null,
    stream: async () => new Response(),
    emit: async () => {},
    on: () => () => {},
    expose: () => {},
    exposeAll: () => {},
    exposeStreaming: () => {},
    peer: () => ({}) as never,
    status: () => "connected" as const,
    ready: async () => {},
    onStatusChange: () => () => {},
  } as unknown as RpcClient;
  return {
    id: "do:test:EvalDO:k",
    contextId: "ctx-1",
    rpc,
    fs: {} as never,
    gatewayConfig: { serverUrl: "http://gw.test", token: "T" },
    gatewayFetch: async () => new Response(),
    panelRuntime: {
      createPanelSlot: async () => ({}) as never,
      openPanel: async () => ({}) as never,
      getPanelHandle: () => ({}) as never,
      panelTree: {} as never,
    },
    workers: {} as never,
    openExternal: async () => ({}) as never,
    resolveParent: () => null,
  };
}

class FakeCdpConnection {}

/** Mirror EvalDO.runLocked: rt seeded into the per-object module map + ambient bindings. */
function evalEnv() {
  const rt = createHostedRuntime(fakeHost());
  const moduleMap: Record<string, unknown> = {
    // Eval's `@workspace/runtime` = hosted instance + pure authoring helpers
    // (mirrors EvalDO.runLocked, so panel/worker/eval expose the same helpers).
    "@workspace/runtime": { ...rt, ...portableHelpers },
    "@workspace/cdp-client": { CdpConnection: FakeCdpConnection },
  };
  const bindings: Record<string, unknown> = {
    ...rt,
    services: {},
    scope: {},
    scopes: {},
    db: { exec: () => [], run: () => {} },
    ctx: { contextId: "ctx-1", objectKey: "k" },
    help: () => undefined,
  };
  return { rt, moduleMap, bindings };
}

function run(code: string, env = evalEnv()) {
  return executeSandbox(code, {
    syntax: "typescript",
    bindings: env.bindings,
    moduleMap: env.moduleMap,
    require: (id: string) => {
      if (id in env.moduleMap) return env.moduleMap[id];
      throw new Error(`Module not found: ${id}`);
    },
  });
}

describe("eval runtime surface contract", () => {
  it("createHostedRuntime's keys are exactly the eval importable surface", () => {
    const { rt } = evalEnv();
    expect(new Set(Object.keys(rt))).toEqual(new Set(Object.keys(evalImportableSurface.exports)));
    for (const ambient of EVAL_AMBIENT_ONLY) {
      expect(ambient in rt).toBe(false);
    }
  });

  it("import { openPanel } resolves to a function === the ambient binding", async () => {
    const result = await run(
      `import { openPanel as imp } from "@workspace/runtime";
       return typeof imp === "function" && imp === openPanel;`
    );
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(true);
  });

  it("rejects importing an ambient-only name (db is PRE_INJECTED)", async () => {
    const result = await run(`import { db } from "@workspace/runtime"; return db;`);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/injected|ambient|pre-inject/i);
  });

  it("the ambient-only globals are present", async () => {
    const result = await run(
      `return [typeof db, typeof scope, typeof scopes, typeof services, ctx?.objectKey].join(",");`
    );
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe("object,object,object,object,k");
  });

  it("resolves import { CdpConnection } from @workspace/cdp-client", async () => {
    const result = await run(
      `import { CdpConnection } from "@workspace/cdp-client"; return typeof CdpConnection;`
    );
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe("function");
  });

  it("imported gad === ambient gad (one shared surface, not a copy)", async () => {
    const result = await run(
      `import { gad as importedGad } from "@workspace/runtime"; return importedGad === gad;`
    );
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(true);
  });

  it("imports the pure authoring helpers (z/defineContract/journal) like panel/worker", async () => {
    const result = await run(
      `import { z, defineContract, journal } from "@workspace/runtime";
       return [typeof z?.string, typeof defineContract, typeof journal?.Journal].join(",");`
    );
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe("function,function,function");
  });
});
