import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Envelope-native /rpc: the mock receives an RpcEnvelope and must reply with a
// response envelope echoing the requestId (else the connectionless client never
// settles). parseReq reconstructs the legacy recorded {type,targetId,method,args}
// shape; respond wraps a result into a response envelope.
function parseReq(init?: RequestInit) {
  const envelope = JSON.parse(String(init?.body ?? "{}")) as {
    from?: string;
    target?: string;
    message?: {
      type?: string;
      requestId?: string;
      method?: string;
      args?: unknown[];
      event?: string;
      payload?: unknown;
    };
  };
  const msg = envelope.message ?? {};
  return {
    type: msg.type === "event" ? "emit" : "call",
    targetId: envelope.target ?? "",
    method: msg.method ?? msg.event ?? "",
    args: msg.args ?? (msg.payload !== undefined ? [msg.payload] : []),
  } as { type: string; targetId: string; method: string; args: unknown[] };
}
function respond(init: RequestInit | undefined, result: unknown) {
  const envelope = JSON.parse(String(init?.body ?? "{}")) as {
    from?: string;
    target?: string;
    message?: { requestId?: string };
  };
  return new Response(
    JSON.stringify({
      from: envelope.target,
      target: envelope.from,
      delivery: { caller: { callerId: "main", callerKind: "server" } },
      provenance: [],
      message: {
        type: "response",
        requestId: envelope.message?.requestId,
        result,
      },
    }),
  );
}

function respondToWorkspacePresentation(
  init: RequestInit | undefined,
  request: ReturnType<typeof parseReq>,
): Response | null {
  if (
    request.method === "workers.resolveService" &&
    request.args[0] === "workspace.presentation"
  ) {
    return respond(init, { kind: "durable-object", targetId: "main" });
  }
  if (request.method === "titlesForSlots") {
    return respond(
      init,
      Object.fromEntries(
        (request.args[0] as string[]).map((slotId) => [
          slotId,
          slotId === "panel:tree/slot-a" || slotId === "panel:tree/parent-slot"
            ? "Panel A"
            : slotId,
        ]),
      ),
    );
  }
  if (
    [
      "bindSlot",
      "indexPanel",
      "updatePanelTitle",
      "incrementAccess",
      "rebuildIndex",
      "removeSlots",
    ].includes(request.method)
  ) {
    return respond(init, undefined);
  }
  return null;
}

function workspaceDetailFor(panelId: string, source = "panels/a") {
  const entityKey = panelId.replace(/^panel:tree\//, "");
  return {
    slot: { parent_slot_id: null, current_entity_title: "Panel A" },
    currentHistory: {
      source,
      context_id: "ctx",
      state_args: "{}",
      options: '{"ref":"main"}',
    },
    entity: {
      id: `panel:nav-${entityKey}-current-entity`,
      source: { effectiveVersion: "ev-a" },
      activeBuildKey: "build-a",
    },
  };
}

function readyRuntimeSlot(panelId: string) {
  const entityKey = panelId.replace(/^panel:tree\//, "");
  const runtimeEntityId = `panel:nav-${entityKey}-current-entity`;
  return {
    version: { epoch: "test", counter: 1 },
    attempt: {
      epoch: "test",
      attemptId: `attempt:${runtimeEntityId}`,
      slotId: panelId,
      runtimeEntityId,
      phase: "ready" as const,
      revision: 1,
      reporter: "renderer" as const,
      updatedAt: 1,
    },
    route: {
      reachable: true,
      connectionId: `route:${panelId}`,
      holderLabel: "Headless",
      platform: "headless",
      supportsCdp: true,
      view: { url: "http://panel.test/", loading: false },
    },
  };
}

function assignedRuntimeSlot(panelId: string, runtimeEntityId: string) {
  return {
    status: "assigned",
    lease: null,
    attempt: {
      epoch: "test",
      attemptId: `attempt:${runtimeEntityId}`,
      slotId: panelId,
      runtimeEntityId,
      phase: "ready" as const,
      revision: 1,
      reporter: "renderer" as const,
      updatedAt: 1,
    },
  };
}

describe("worker panelTree handles", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("exports panel-shared pure runtime helpers from the worker entrypoint", async () => {
    const runtimeModule = await import("./index.js");

    expect(runtimeModule.Rpc).toBeDefined();
    expect(runtimeModule.z.object).toBeTypeOf("function");
    expect(runtimeModule.defineContract).toBeTypeOf("function");
    expect(runtimeModule.buildPanelLink("panels/editor")).toBe(
      "/panels/editor/",
    );
    expect(runtimeModule.parseContextId("ctx_project")).toEqual({
      instanceId: "project",
    });
    expect(runtimeModule.isValidContextId("ctx_project")).toBe(true);
    expect(runtimeModule.getInstanceId("ctx_project")).toBe("project");
    expect(runtimeModule.normalizePath("path\\to/mixed\\slashes")).toBe(
      "path/to/mixed/slashes",
    );
    expect(runtimeModule.getFileName("path/to/file.txt")).toBe("file.txt");
    expect(runtimeModule.resolvePath("/root", "child")).toBe("/root/child");
  });

  it("uses the exact source-qualified sealed worker identity for outbound RPC", async () => {
    let runtimeHeader: string | null = null;
    let envelopeFrom: string | undefined;
    globalThis.fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        runtimeHeader = new Headers(init?.headers).get(
          "x-vibestudio-runtime-id",
        );
        envelopeFrom = JSON.parse(String(init?.body ?? "{}"))?.from;
        return respond(init, { ok: true });
      },
    ) as typeof fetch;

    const { createWorkerRuntime } = await import("./index.js");
    const runtime = createWorkerRuntime({
      WORKER_ID: "probe",
      WORKER_SOURCE: "workers/identity-probe",
      RPC_AUTH_TOKEN: "token",
      CONTEXT_ID: "ctx",
      GATEWAY_URL: "http://server.test",
    });
    await runtime.rpc.call("main", "probe.read", []);
    runtime.destroy();

    expect(runtimeHeader).toBe("worker:workers/identity-probe:probe");
    expect(envelopeFrom).toBe("worker:workers/identity-probe:probe");
  });

  it("routes bare handle RPC events through the refreshed runtime entity id", async () => {
    const calls: Array<{
      type?: string;
      targetId: string;
      method: string;
      args: unknown[];
    }> = [];
    globalThis.fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = parseReq(init);
        calls.push({
          type: body.type,
          targetId: body.targetId,
          method: body.method,
          args: body.args,
        });
        const presentationResponse = respondToWorkspacePresentation(init, body);
        if (presentationResponse) return presentationResponse;
        if (body.method === "workers.resolveService") {
          return respond(init, {
            kind: "durable-object",
            targetId: "main",
          });
        }
        if (body.method === "workspace-state.panelTree.detail") {
          return respond(init, {
            slot: {
              parent_slot_id: "root",
              current_entity_title: "Panel A",
            },
            currentHistory: {
              source: "panels/a",
              context_id: "ctx",
              options: null,
            },
            entity: {
              id: "panel:nav-slot-a-current-entity",
              source: { effectiveVersion: "ev-a" },
            },
          });
        }
        if (body.method === "panelRuntime.ensureSlot")
          return respond(
            init,
            assignedRuntimeSlot(String(body.args[0]), String(body.args[1])),
          );
        if (body.method === "panelRuntime.observeSlot")
          return respond(init, readyRuntimeSlot(String(body.args[0])));
        return respond(init, "ok");
      },
    ) as typeof fetch;

    const { createWorkerRuntime } = await import("./index.js");
    const runtime = createWorkerRuntime({
      WORKER_ID: "agent",
      WORKER_SOURCE: "workers/agent",
      RPC_AUTH_TOKEN: "token",
      CONTEXT_ID: "ctx",
      GATEWAY_URL: "http://server.test",
    });

    const handle = runtime.panelTree.get("panel:tree/slot-a");
    await handle.call["ping"]?.();
    expect(handle.title).toBe("Panel A");
    expect(handle.source).toBe("panels/a");
    expect(handle.kind).toBe("workspace");
    expect(handle.parentId).toBe("root");
    await handle.emit("ready", { ok: true });
    runtime.destroy();

    expect(calls).toContainEqual({
      type: "call",
      targetId: "main",
      method: "panelRuntime.ensureSlot",
      args: ["panel:tree/slot-a", "panel:nav-slot-a-current-entity"],
    });
    expect(calls).toContainEqual({
      type: "call",
      targetId: "panel:nav-slot-a-current-entity",
      method: "ping",
      args: [],
    });
    expect(calls).toContainEqual({
      type: "emit",
      targetId: "panel:nav-slot-a-current-entity",
      method: "ready",
      args: [{ ok: true }],
    });
  });

  it("reads canonical boot readiness from observe", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> =
      [];
    globalThis.fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = parseReq(init);
        delete (body as Record<string, unknown>)["requestId"];
        delete (body as Record<string, unknown>)["idempotencyKey"];
        calls.push(body);
        const presentationResponse = respondToWorkspacePresentation(init, body);
        if (presentationResponse) return presentationResponse;
        if (body.method === "workers.resolveService")
          return respond(init, {
            kind: "durable-object",
            targetId: "main",
          });
        if (body.method === "workspace-state.panelTree.detail")
          return respond(init, workspaceDetailFor("panel:tree/slot-a"));
        if (body.method === "panelRuntime.observeSlot")
          return respond(init, readyRuntimeSlot(String(body.args[0])));
        return respond(init, null);
      },
    ) as typeof fetch;

    const { createWorkerRuntime } = await import("./index.js");
    const runtime = createWorkerRuntime({
      WORKER_ID: "agent",
      WORKER_SOURCE: "workers/agent",
      RPC_AUTH_TOKEN: "token",
      CONTEXT_ID: "ctx",
      GATEWAY_URL: "http://server.test",
    });

    await expect(
      runtime.panelTree.get("panel:tree/slot-a").observe(),
    ).resolves.toMatchObject({
      phase: "ready",
    });
    runtime.destroy();

    expect(calls.map(({ method }) => method)).toEqual([
      "workspace-state.panelTree.detail",
      "panelRuntime.observeSlot",
    ]);
  });

  it("binds arbitrary handles to the runtime entity reported by observe", async () => {
    const calls: Array<{
      type?: string;
      targetId: string;
      method: string;
      args: unknown[];
    }> = [];
    globalThis.fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = parseReq(init);
        calls.push({
          type: body.type,
          targetId: body.targetId,
          method: body.method,
          args: body.args,
        });
        if (body.method === "workers.resolveService")
          return respond(init, {
            kind: "durable-object",
            targetId: "main",
          });
        if (body.method === "workspace-state.panelTree.detail")
          return respond(init, workspaceDetailFor("panel:tree/slot-a"));
        if (body.method === "panelRuntime.observeSlot")
          return respond(init, readyRuntimeSlot(String(body.args[0])));
        if (body.method === "panelRuntime.ensureSlot")
          return respond(
            init,
            assignedRuntimeSlot(String(body.args[0]), String(body.args[1])),
          );
        return respond(init, { loaded: true });
      },
    ) as typeof fetch;

    const { createWorkerRuntime } = await import("./index.js");
    const runtime = createWorkerRuntime({
      WORKER_ID: "agent",
      WORKER_SOURCE: "workers/agent",
      RPC_AUTH_TOKEN: "token",
      CONTEXT_ID: "ctx",
      GATEWAY_URL: "http://server.test",
    });

    const handle = runtime.panelTree.get("panel:tree/slot-a");
    await handle.observe();
    await handle.call["ping"]?.();
    runtime.destroy();

    expect(calls.at(-1)).toEqual({
      type: "call",
      targetId: "panel:nav-slot-a-current-entity",
      method: "ping",
      args: [],
    });
  });

  it("lists, hydrates children, and opens panels through the server panelTree service", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> =
      [];
    globalThis.fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = parseReq(init);
        delete (body as Record<string, unknown>)["requestId"];
        delete (body as Record<string, unknown>)["idempotencyKey"];
        calls.push(body);
        const presentationResponse = respondToWorkspacePresentation(init, body);
        if (presentationResponse) return presentationResponse;
        if (body.method === "workers.resolveService") {
          return respond(init, {
            kind: "durable-object",
            targetId: "main",
          });
        }
        if (body.method === "workspace-state.panelTree.rootGroups") {
          return respond(init, {
            revision: 1,
            groups: [{ ownerUserId: null, rootCount: 1 }],
            nextCursor: null,
          });
        }
        if (body.method === "workspace-state.panelTree.page") {
          const group = (
            body.args[0] as { group: { kind: string; parentSlotId?: string } }
          ).group;
          const nodes =
            group.kind === "roots"
              ? [
                  {
                    slotId: "root-slot",
                    title: "Root",
                    source: "panels/root",
                    kind: "workspace",
                    parentSlotId: null,
                    ownerUserId: null,
                    contextId: "ctx-root",
                    runtimeEntityId: "panel:root-entity",
                    createdAt: 1,
                    childCount: 1,
                  },
                ]
              : group.parentSlotId === "root-slot"
                ? [
                    {
                      slotId: "child-slot",
                      title: "Child",
                      source: "panels/child",
                      kind: "workspace",
                      parentSlotId: "root-slot",
                      ownerUserId: null,
                      contextId: "ctx-child",
                      runtimeEntityId: "panel:child-entity",
                      createdAt: 1,
                      childCount: 0,
                    },
                  ]
                : [];
          return respond(init, { revision: 1, group, nodes, nextCursor: null });
        }
        if (
          body.method === "runtime.reserveEntity" ||
          body.method === "runtime.activateReservedEntity"
        ) {
          const spec = body.args[0] as { key: string; contextId?: string };
          return respond(init, {
            id: `panel:nav-${spec.key}`,
            contextId: spec.contextId ?? "ctx-created",
            source: {
              effectiveVersion:
                body.method === "runtime.reserveEntity" ? "" : "ev-created",
            },
            ...(body.method === "runtime.reserveEntity"
              ? {}
              : { buildKey: "build-created" }),
          });
        }
        if (body.method === "build.getPanelMetadata")
          return respond(init, { title: "Created" });
        if (body.method === "workspace-state.panelTree.detail") {
          const panelId = String(body.args[0]);
          const detail = workspaceDetailFor(panelId, "panels/new");
          return respond(init, {
            ...detail,
            slot: {
              ...detail.slot,
              parent_slot_id: panelId.startsWith("panel:tree/parent-slot/")
                ? "panel:tree/parent-slot"
                : null,
            },
          });
        }
        if (body.method === "panelRuntime.ensureSlot")
          return respond(
            init,
            assignedRuntimeSlot(String(body.args[0]), String(body.args[1])),
          );
        if (body.method === "panelRuntime.observeSlot")
          return respond(init, readyRuntimeSlot(String(body.args[0])));
        return respond(init, "ok");
      },
    ) as typeof fetch;

    const { createWorkerRuntime } = await import("./index.js");
    const runtime = createWorkerRuntime({
      WORKER_ID: "agent",
      WORKER_SOURCE: "workers/agent",
      RPC_AUTH_TOKEN: "token",
      CONTEXT_ID: "ctx",
      GATEWAY_URL: "http://server.test",
      PARENT_ID: "panel:tree/parent-slot",
      PARENT_KIND: "panel",
    });

    const roots = await runtime.panelTree.page({
      group: { kind: "roots", ownerUserId: null },
      limit: 50,
    });
    const children = await runtime.panelTree.page({
      group: { kind: "children", parentSlotId: "root-slot" },
      limit: 50,
    });
    const created = await runtime.openPanel("panels/new");
    runtime.destroy();

    expect(roots.entries.map(({ handle }) => handle.id)).toEqual(["root-slot"]);
    expect(children.entries.map(({ handle }) => handle.id)).toEqual([
      "child-slot",
    ]);
    expect(children.entries[0]?.handle.parent()?.id).toBe("root-slot");
    expect(created.id).toMatch(/^panel:tree\/parent-slot\/panels~new\//);
    expect(created.parentId).toBe("panel:tree/parent-slot");
    expect(calls.map(({ method }) => method)).toContain(
      "runtime.reserveEntity",
    );
    expect(calls.map(({ method }) => method)).toContain(
      "workspace-state.slot.create",
    );
    expect(calls.map(({ method }) => method)).not.toContain("panelTree.create");
  });

  it("exposes openPanel/getPanelHandle on the worker runtime", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> =
      [];
    globalThis.fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = parseReq(init);
        delete (body as Record<string, unknown>)["requestId"];
        delete (body as Record<string, unknown>)["idempotencyKey"];
        calls.push(body);
        const presentationResponse = respondToWorkspacePresentation(init, body);
        if (presentationResponse) return presentationResponse;
        if (body.method === "workers.resolveService") {
          return respond(init, {
            kind: "durable-object",
            targetId: "main",
          });
        }
        if (body.method === "workspace-state.panelTree.rootGroups") {
          return respond(init, { revision: 1, groups: [], nextCursor: null });
        }
        if (
          body.method === "runtime.reserveEntity" ||
          body.method === "runtime.activateReservedEntity"
        ) {
          const spec = body.args[0] as { key: string; contextId?: string };
          return respond(init, {
            id: `panel:nav-${spec.key}`,
            contextId: spec.contextId ?? "ctx-created",
            source: {
              effectiveVersion:
                body.method === "runtime.reserveEntity" ? "" : "ev-created",
            },
            ...(body.method === "runtime.reserveEntity"
              ? {}
              : { buildKey: "build-created" }),
          });
        }
        if (body.method === "build.getPanelMetadata")
          return respond(init, { title: "Created" });
        if (body.method === "workspace-state.panelTree.detail") {
          const panelId = String(body.args[0]);
          return respond(
            init,
            workspaceDetailFor(
              panelId,
              panelId === "panel:tree/browser-slot"
                ? "browser:https://example.com"
                : "panels/direct",
            ),
          );
        }
        if (body.method === "panelRuntime.ensureSlot")
          return respond(
            init,
            assignedRuntimeSlot(String(body.args[0]), String(body.args[1])),
          );
        if (body.method === "panelRuntime.observeSlot")
          return respond(init, readyRuntimeSlot(String(body.args[0])));
        return respond(init, null);
      },
    ) as typeof fetch;

    const { createWorkerRuntime } = await import("./index.js");
    const runtime = createWorkerRuntime({
      WORKER_ID: "agent",
      WORKER_SOURCE: "workers/agent",
      RPC_AUTH_TOKEN: "token",
      CONTEXT_ID: "ctx",
      GATEWAY_URL: "http://server.test",
      PARENT_ID: "panel:tree/parent-slot",
      PARENT_KIND: "panel",
    });

    const direct = await runtime.openPanel("panels/direct", {
      focus: true,
      placement: { disposition: "side", preferredWidth: 640 },
    });
    const browser = runtime.getPanelHandle(
      "panel:tree/browser-slot",
      "browser",
    );
    await browser.focus({ placement: { disposition: "split-below" } });
    runtime.destroy();

    expect(direct.id).toMatch(/^panel:tree\/parent-slot\/panels~direct\//);
    expect(browser.kind).toBe("browser");
    expect(browser.source).toBe("https://example.com");
    expect(calls.map(({ method }) => method)).not.toContain("panelTree.create");
    // Worker runtimes do not own a native presentation host, so focusing a
    // handle only waits for readiness. The desktop shell supplies
    // `focusPanel` when one exists; this worker client must not fabricate a
    // `view.focusPanel` call.
    expect(calls.map(({ method }) => method)).not.toContain("view.focusPanel");
  });

  it("builds panel parent handles with entity-scoped RPC and slot-scoped CDP", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> =
      [];
    globalThis.fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = parseReq(init);
        delete (body as Record<string, unknown>)["requestId"];
        delete (body as Record<string, unknown>)["idempotencyKey"];
        calls.push(body);
        const presentationResponse = respondToWorkspacePresentation(init, body);
        if (presentationResponse) return presentationResponse;
        if (body.method === "panelCdp.getCdpEndpoint") {
          return respond(init, { wsEndpoint: "ws://cdp.test" });
        }
        if (body.method === "workers.resolveService")
          return respond(init, {
            kind: "durable-object",
            targetId: "main",
          });
        if (body.method === "workspace-state.panelTree.detail")
          return respond(
            init,
            workspaceDetailFor("panel:tree/parent-slot", "panels/parent"),
          );
        if (body.method === "panelRuntime.observeSlot")
          return respond(init, readyRuntimeSlot(String(body.args[0])));
        if (body.method === "build.getPanelMetadata")
          return respond(init, { title: "Parent" });
        if (body.method === "runtime.createEntity") {
          const spec = body.args[0] as { key: string };
          return respond(init, {
            id: `panel:nav-${spec.key}`,
            contextId: "ctx",
            source: { effectiveVersion: "ev-a" },
            buildKey: "build-a",
          });
        }
        if (body.method === "workspace-state.slot.commitPreparedNavigation") {
          const input = body.args[0] as {
            expectedCurrentEntityId: string;
            mutation: { entry: { entityId: string } };
          };
          return respond(init, {
            previousEntityId: input.expectedCurrentEntityId,
            currentEntityId: input.mutation.entry.entityId,
          });
        }
        if (body.method === "panelRuntime.ensureSlot")
          return respond(
            init,
            assignedRuntimeSlot(String(body.args[0]), String(body.args[1])),
          );
        return respond(init, undefined);
      },
    ) as typeof fetch;

    const { createWorkerRuntime } = await import("./index.js");
    const runtime = createWorkerRuntime({
      WORKER_ID: "agent",
      WORKER_SOURCE: "workers/agent",
      RPC_AUTH_TOKEN: "token",
      CONTEXT_ID: "ctx",
      GATEWAY_URL: "http://server.test",
      PARENT_ID: "panel:tree/parent-slot",
      PARENT_ENTITY_ID: "panel:nav-parent-entity",
      PARENT_KIND: "panel",
    });

    const parent = runtime.getParent();
    expect(runtime.parent.id).toBe("panel:tree/parent-slot");
    expect(parent?.id).toBe("panel:tree/parent-slot");
    expect(runtime.getParentWithContract({ source: "panels/child" })?.id).toBe(
      "panel:tree/parent-slot",
    );
    expect(parent).toMatchObject({
      id: "panel:tree/parent-slot",
      parentId: null,
    });
    await parent?.call["ping"]?.();
    await expect(parent?.cdp.getCdpEndpoint()).resolves.toEqual({
      wsEndpoint: "ws://cdp.test",
    });
    await parent?.reload();
    await parent?.rebuild();
    runtime.destroy();

    expect(calls).toContainEqual({
      type: "call",
      targetId: "panel:nav-parent-slot-current-entity",
      method: "ping",
      args: [],
    });
    expect(calls).toContainEqual({
      type: "call",
      targetId: "main",
      method: "panelCdp.getCdpEndpoint",
      args: ["panel:tree/parent-slot"],
    });
    expect(calls.map(({ method }) => method)).toContain(
      "runtime.supervision.restart",
    );
    expect(calls.map(({ method }) => method)).toContain(
      "workspace-state.slot.commitPreparedNavigation",
    );
    expect(calls.map(({ method }) => method)).not.toContain("panelTree.reload");
    expect(calls.map(({ method }) => method)).not.toContain(
      "panelTree.rebuildPanel",
    );
  });
});
