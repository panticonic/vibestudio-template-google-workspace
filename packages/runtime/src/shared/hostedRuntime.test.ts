import { describe, expect, it } from "vitest";
import type { RpcClient } from "@vibestudio/rpc";
import {
  createHostedRuntime,
  createServicesProxy,
  createAttachedHostsApi,
  type RuntimeHost,
  type WorkspaceRuntime,
} from "./hostedRuntime.js";
import { createWorkerdClient } from "./workerd.js";
import { BLOBSTORE_MEMBERS } from "./blobstore.js";
import {
  portableExports,
  PORTABLE_KEYS,
} from "@vibestudio/service-schemas/runtime/runtimeSurface.portable";

/**
 * Identity/wiring assertions for the ONE shared runtime assembly: prove the
 * derived features are real (not stubs) and wired to `host.rpc`.
 */

const WORKSPACE_RUNTIME_KEYS: Array<keyof WorkspaceRuntime> = [
  "id",
  "contextId",
  "rpc",
  "fs",
  "gad",
  "blobstore",
  "workspace",
  "credentials",
  "browserData",
  "git",
  "vcs",
  "webhooks",
  "extensions",
  "notifications",
  "workers",
  "doTargetId",
  "createDurableObjectServiceClient",
  "gatewayConfig",
  "gatewayFetch",
  "openExternal",
  "createPanelSlot",
  "openPanel",
  "getPanelHandle",
  "panelTree",
];

function recordingHost() {
  const onEvents: string[] = [];
  const calls: Array<{ target: string; method: string; args: unknown[] }> = [];
  const rpc = {
    selfId: "test",
    call: async (target: string, method: string, args: unknown[]) => {
      calls.push({ target, method, args });
      if (method === "blobstore.putBase64") {
        return { digest: "a".repeat(64), size: 1 };
      }
      if (method === "blobstore.getBase64") {
        return args[0] === "b".repeat(64) ? null : "AP+AECpj";
      }
      if (method === "vcs.status") {
        return {
          contextId: "context:test",
          committed: { kind: "event", eventId: "event:committed" },
          workingHead: { kind: "event", eventId: "event:committed" },
          clean: true,
          mainEventId: "event:committed",
          mainRelation: "at",
          workingCounts: { applications: 0, workUnits: 0, changes: 0 },
          integrating: [],
        };
      }
      if (method === "extensions.invokeProvider") return [];
      return undefined;
    },
    stream: async () => new Response(),
    emit: async () => {},
    on: (event: string) => {
      onEvents.push(event);
      return () => {};
    },
    expose: () => {},
    exposeAll: () => {},
    exposeStreaming: () => {},
    peer: () => ({}) as never,
    status: () => "connected" as const,
    ready: async () => {},
    onStatusChange: () => () => {},
  } as unknown as RpcClient;
  const openPanel = async () => ({}) as never;
  const createPanelSlot = async () => ({}) as never;
  const host: RuntimeHost = {
    id: "host-id",
    contextId: "ctx-1",
    rpc,
    fs: {} as never,
    gatewayConfig: { serverUrl: "http://gw.test", token: "T" },
    gatewayFetch: async () => new Response(),
    panelRuntime: {
      createPanelSlot,
      openPanel,
      getPanelHandle: () => ({}) as never,
      panelTree: {} as never,
    },
    // A REAL workers client so its bound namespace members are the actual ones
    // (the parity test below diffs them against the declared WORKERS_MEMBERS).
    workers: createWorkerdClient(rpc),
    openExternal: async () => ({}) as never,
    resolveParent: () => null,
  };
  return { host, onEvents, calls };
}

describe("createHostedRuntime", () => {
  it("exposes every WorkspaceRuntime field, all defined", () => {
    const { host } = recordingHost();
    const core = createHostedRuntime(host);
    for (const key of WORKSPACE_RUNTIME_KEYS) {
      expect(core[key], String(key)).toBeDefined();
    }
  });

  it("passes the host's panel ports through by identity", () => {
    const { host } = recordingHost();
    const core = createHostedRuntime(host);
    expect(core.createPanelSlot).toBe(host.panelRuntime.createPanelSlot);
    expect(core.openPanel).toBe(host.panelRuntime.openPanel);
    expect(core.getPanelHandle).toBe(host.panelRuntime.getPanelHandle);
    expect(core.panelTree).toBe(host.panelRuntime.panelTree);
    expect(core.workers).toBe(host.workers);
    expect(core.openExternal).toBe(host.openExternal);
    expect(core.gatewayFetch).toBe(host.gatewayFetch);
  });

  it("derives a real credential client with forAudience", () => {
    const { host } = recordingHost();
    const core = createHostedRuntime(host);
    expect(typeof core.credentials.forAudience).toBe("function");
    expect(typeof core.credentials.connect).toBe("function");
  });

  it("routes imported and live browser data through the main extension-provider service", async () => {
    const { host, calls } = recordingHost();
    const core = createHostedRuntime(host);

    await core.browserData.listImportJobs();
    await core.browserData.getHistory({ limit: 60 });

    expect(calls).toContainEqual({
      target: "main",
      method: "extensions.invokeProvider",
      args: ["browserData", "listImportJobs", []],
    });
    expect(calls).toContainEqual({
      target: "main",
      method: "extensions.invokeProvider",
      args: ["browserData", "getHistory", [{ limit: 60 }]],
    });
  });

  it("exposes a blobstore client that forwards to the main blobstore service", async () => {
    const { host, calls } = recordingHost();
    const core = createHostedRuntime(host);

    // The agent's instinct in eval: persist a screenshot via services.blobstore.
    // This must reach the `blobstore` RPC service (which admits `do` callers),
    // not be undefined.
    expect(typeof core.blobstore.putBase64).toBe("function");
    await core.blobstore.putBase64("aGVsbG8=");

    expect(calls).toContainEqual({
      target: "main",
      method: "blobstore.putBase64",
      args: ["aGVsbG8="],
    });
  });

  it("putBytes forwards only the visible Uint8Array bytes and accepts ArrayBuffer", async () => {
    const { host, calls } = recordingHost();
    const core = createHostedRuntime(host);

    expect(new Set(Object.keys(core.blobstore))).toEqual(new Set(BLOBSTORE_MEMBERS));
    expect(new Set(Object.keys(core.blobstore))).toEqual(
      new Set(portableExports["blobstore"]?.members ?? [])
    );

    const backing = new Uint8Array([9, 0, 255, 8]);
    await core.blobstore.putBytes(backing.subarray(1, 3));

    const arrayBuffer = new ArrayBuffer(3);
    new Uint8Array(arrayBuffer).set([1, 2, 3]);
    await core.blobstore.putBytes(arrayBuffer);

    expect(calls).toContainEqual({
      target: "main",
      method: "blobstore.putBase64",
      args: ["AP8="],
    });
    expect(calls).toContainEqual({
      target: "main",
      method: "blobstore.putBase64",
      args: ["AQID"],
    });
  });

  it("getBytes decodes the full base64 blob and preserves missing blobs", async () => {
    const { host, calls } = recordingHost();
    const core = createHostedRuntime(host);

    const digest = "a".repeat(64);
    await expect(core.blobstore.getBytes(digest)).resolves.toEqual(
      new Uint8Array([0, 255, 128, 16, 42, 99])
    );
    await expect(core.blobstore.getBytes("b".repeat(64))).resolves.toBeNull();

    expect(calls).toContainEqual({
      target: "main",
      method: "blobstore.getBase64",
      args: [digest],
    });
  });

  it("putBytes rejects extra metadata instead of silently dropping it", async () => {
    const { host, calls } = recordingHost();
    const core = createHostedRuntime(host);
    const untypedPutBytes = core.blobstore.putBytes as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;

    await expect(
      untypedPutBytes(new Uint8Array([1]), { contentType: "image/png" })
    ).rejects.toThrow(/accepts exactly one.*MIME metadata is not stored/);
    expect(calls).not.toContainEqual(expect.objectContaining({ method: "blobstore.putBase64" }));
  });

  it("vcs.status dispatches the canonical semantic request through host.rpc", async () => {
    const { host, calls } = recordingHost();
    const core = createHostedRuntime(host);

    await core.vcs.status({ contextId: host.contextId });

    expect(calls).toContainEqual({
      target: "main",
      method: "vcs.status",
      args: [{ contextId: host.contextId }],
    });
  });
});

/**
 * (a) Cross-target binding parity + declared-vs-bound surface drift.
 *
 * The runtime binding key-set is identical across panel/worker/eval BECAUSE all
 * three call this ONE `createHostedRuntime` — so asserting its `Object.keys`
 * equals the declared portable surface (`runtimeSurface.portable.ts`) proves
 * parity for every target at once, AND fails if the manifest and the real bound
 * surface drift in EITHER direction (a key declared-but-not-bound, or
 * bound-but-not-declared).
 */
describe("createHostedRuntime ⟷ portable surface parity", () => {
  it("top-level bound keys are EXACTLY the declared portable surface (drift fails either way)", () => {
    const { host } = recordingHost();
    const bound = new Set(Object.keys(createHostedRuntime(host)));
    const declared = new Set(PORTABLE_KEYS);
    // Symmetric: a key added to the runtime but not the manifest (or vice versa) fails.
    expect(bound).toEqual(declared);
  });

  it("every declared namespace member is actually bound on its live client (no advertised-but-absent member)", () => {
    const { host } = recordingHost();
    const rt = createHostedRuntime(host) as unknown as Record<string, unknown>;
    // The few namespaces whose live client is host-supplied as a stub here
    // (panelTree comes from host.panelRuntime) can't be reflected from this
    // assembly — skip those; `workers` is a REAL client (see recordingHost).
    const hostPortNamespaces = new Set(["panelTree"]);
    for (const [name, entry] of Object.entries(portableExports)) {
      if (entry.kind !== "namespace" || hostPortNamespaces.has(name)) continue;
      const live = rt[name];
      expect(live, `${name} should be a bound object`).toBeTypeOf("object");
      const liveKeys = new Set(Object.keys(live as object));
      for (const member of entry.members ?? []) {
        // A declared member MUST exist on the real client — otherwise `help()`
        // and the manifest advertise a method that isn't there (the member-level
        // analogue of the old `services.blobstore === undefined` gap).
        expect(
          liveKeys.has(member),
          `${name}.${member} is declared in runtimeSurface.portable.ts but not bound on the live client`
        ).toBe(true);
      }
    }
  });

  it("the fully-curated namespaces match their declared members EXACTLY (no silent client drift)", () => {
    const { host } = recordingHost();
    const rt = createHostedRuntime(host) as unknown as Record<string, unknown>;
    // These clients are 1:1 with their manifest (unlike vcs/gad/workspace, which
    // curate a documentation subset of a larger live surface). Exact equality here
    // catches a member added to/removed from the client without a manifest update.
    const exactNamespaces = [
      "workers",
      "credentials",
      "browserData",
      "git",
      "blobstore",
      "webhooks",
      "extensions",
      "notifications",
    ];
    for (const name of exactNamespaces) {
      const declared = new Set(portableExports[name]?.members ?? []);
      const live = new Set(Object.keys(rt[name] as object));
      expect(live, `${name} live members ⟷ declared`).toEqual(declared);
    }
  });
});

/**
 * createServicesProxy — rich runtime clients override by identity; all
 * non-colliding service names use a dynamic callMain proxy. No hand-curated list.
 */
describe("createServicesProxy", () => {
  it("returns the SAME rich client object for a name present on the runtime (ergonomic override)", () => {
    const { host } = recordingHost();
    const rt = createHostedRuntime(host);
    const services = createServicesProxy(rt);
    // services.vcs === the bare vcs (and `import { vcs }`): one shared client, no copy.
    expect(services["vcs"]).toBe(rt.vcs);
    expect(services["blobstore"]).toBe(rt.blobstore);
    expect(services["fs"]).toBe(rt.fs);
    expect(services["workers"]).toBe(rt.workers);
  });

  it("dynamically reaches ANY other service via callMain (no curated list, no gap)", async () => {
    const { host, calls } = recordingHost();
    const rt = createHostedRuntime(host);
    const services = createServicesProxy(rt) as Record<
      string,
      Record<string, (...a: unknown[]) => Promise<unknown>>
    >;
    // `audit` is a real server service with NO rich runtime client — it must STILL
    // be reachable by name, dispatching through callMain → rpc.call("main", …).
    await services["audit"]!["query"]!({ limit: 5 });
    expect(calls).toContainEqual({
      target: "main",
      method: "audit.query",
      args: [{ limit: 5 }],
    });
  });

  it("caches fallback clients so repeated access is stable (===)", () => {
    const { host } = recordingHost();
    const services = createServicesProxy(createHostedRuntime(host)) as Record<string, unknown>;
    expect(services["someUnknownService"]).toBe(services["someUnknownService"]);
  });
});

describe("createAttachedHostsApi", () => {
  it("attaches once and routes arbitrary ordinary child service methods", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const hosts = createAttachedHostsApi({
      async callMain<T>(method: string, ...args: unknown[]): Promise<T> {
        calls.push({ method, args });
        if (method === "attachedHosts.attachClient") {
          return {
            sessionId: "attached-one",
            developmentRunId: "development-one",
            childHostId: "child-one",
            childGenerationId: "1".repeat(32),
            authorityCeilingDigest: "a".repeat(64),
            expiresAt: Date.now() + 60_000,
          } as T;
        }
        return { status: "running" } as T;
      },
    });
    const child = await hosts.attach("attached-one");
    await expect(child.services["eval"]!["get"]!({ runId: "eval-one" })).resolves.toEqual({
      status: "running",
    });
    expect(calls).toEqual([
      {
        method: "attachedHosts.attachClient",
        args: [{ sessionId: "attached-one" }],
      },
      {
        method: "attachedHosts.invokeAttached",
        args: [
          {
            sessionId: "attached-one",
            service: "eval",
            method: "get",
            args: [{ runId: "eval-one" }],
          },
        ],
      },
    ]);
  });
});
