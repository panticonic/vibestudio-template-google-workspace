import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "@vibestudio/rpc";
import { createTestDirectAuthority } from "./durable-test-utils.js";

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

describe("PanelDurableObjectBase panelTree handles", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
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

    const [{ PanelDurableObjectBase }, { createTestDO }] = await Promise.all([
      import("./panel-durable-base.js"),
      import("./durable-test-utils.js"),
    ]);

    class PanelTreeProbeDO extends PanelDurableObjectBase {
      protected createTables(): void {}

      @rpc({
        principals: ["host", "user", "code"],
        effect: { kind: "open" },
        tier: "open",
        sensitivity: "read",
      })
      async probePanelTree(): Promise<{
        title: string | undefined;
        source: string | undefined;
        kind: "workspace" | "browser";
        parentId: string | null;
      }> {
        const handle = this.panelTree.get("panel:tree/slot-a");
        await handle.call["ping"]?.();
        await handle.emit("ready", { ok: true });
        return {
          title: handle.title,
          source: handle.source,
          kind: handle.kind,
          parentId: handle.parentId,
        };
      }
    }

    const { call } = await createTestDO(PanelTreeProbeDO, {
      GATEWAY_URL: "http://server.test",
    });

    await expect(call("probePanelTree")).resolves.toEqual({
      title: "Panel A",
      source: "panels/a",
      kind: "workspace",
      parentId: "root",
    });

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
        // Strip the opaque transport requestId/idempotencyKey; these tests assert routing.
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

    const [{ PanelDurableObjectBase }, { createTestDO }] = await Promise.all([
      import("./panel-durable-base.js"),
      import("./durable-test-utils.js"),
    ]);

    class PanelTreeProbeDO extends PanelDurableObjectBase {
      protected createTables(): void {}

      @rpc({
        principals: ["host", "user", "code"],
        effect: { kind: "open" },
        tier: "open",
        sensitivity: "read",
      })
      async probePanelTree(): Promise<boolean> {
        return (
          (await this.panelTree.get("panel:tree/slot-a").observe()).phase ===
          "ready"
        );
      }
    }

    const { call } = await createTestDO(PanelTreeProbeDO, {
      GATEWAY_URL: "http://server.test",
    });

    await expect(call("probePanelTree")).resolves.toBe(true);

    expect(calls.map(({ method }) => method)).toEqual([
      "workspace-state.panelTree.detail",
      "panelRuntime.observeSlot",
    ]);
  });

  it("lists, hydrates children, and opens panels through the server panelTree service", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> =
      [];
    globalThis.fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = parseReq(init);
        // Strip the opaque transport requestId/idempotencyKey; these tests assert routing.
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
        if (body.method === "workspace-state.panelTree.detail")
          return respond(
            init,
            workspaceDetailFor(String(body.args[0]), "panels/new"),
          );
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

    const [{ PanelDurableObjectBase }, { createTestDO }] = await Promise.all([
      import("./panel-durable-base.js"),
      import("./durable-test-utils.js"),
    ]);

    class PanelTreeProbeDO extends PanelDurableObjectBase {
      protected createTables(): void {}

      @rpc({
        principals: ["host", "user", "code"],
        effect: { kind: "open" },
        tier: "open",
        sensitivity: "read",
      })
      async probePanelTree(): Promise<{
        allIds: string[];
        childParentId: string | null | undefined;
        createdId: string;
        createdParentId: string | null;
      }> {
        const roots = await this.panelTree.page({
          group: { kind: "roots", ownerUserId: null },
          limit: 50,
        });
        const children = await this.panelTree.page({
          group: { kind: "children", parentSlotId: "root-slot" },
          limit: 50,
        });
        const created = await this.openPanel("panels/new");
        return {
          allIds: [
            ...roots.entries.map(({ handle }) => handle.id),
            ...children.entries.map(({ handle }) => handle.id),
          ],
          childParentId: children.entries[0]?.handle.parent()?.id,
          createdId: created.id,
          createdParentId: created.parentId,
        };
      }
    }

    const { call } = await createTestDO(PanelTreeProbeDO, {
      GATEWAY_URL: "http://server.test",
    });

    await expect(call("probePanelTree")).resolves.toEqual({
      allIds: ["root-slot", "child-slot"],
      childParentId: "root-slot",
      createdId: expect.stringMatching(/^panel:tree\/panels~new\//),
      createdParentId: null,
    });

    expect(calls.map(({ method }) => method)).toContain(
      "runtime.reserveEntity",
    );
    expect(calls.map(({ method }) => method)).toContain(
      "workspace-state.slot.create",
    );
    expect(calls.map(({ method }) => method)).not.toContain("panelTree.create");
  });

  it("exposes openPanel/getPanelHandle aliases on PanelDurableObjectBase", async () => {
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
        if (body.method === "workspace-state.panelTree.detail")
          return respond(
            init,
            workspaceDetailFor(String(body.args[0]), "panels/new"),
          );
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

    const [{ PanelDurableObjectBase }, { createTestDO }] = await Promise.all([
      import("./panel-durable-base.js"),
      import("./durable-test-utils.js"),
    ]);

    class PanelAliasProbeDO extends PanelDurableObjectBase {
      protected createTables(): void {}

      @rpc({
        principals: ["host", "user", "code"],
        effect: { kind: "open" },
        tier: "open",
        sensitivity: "read",
      })
      async probePanelAliases(): Promise<{
        createdId: string;
        knownId: string;
      }> {
        const created = await this.openPanel("panels/new", { focus: true });
        const known = this.getPanelHandle("panel:tree/known-slot");
        return { createdId: created.id, knownId: known.id };
      }
    }

    const { call } = await createTestDO(PanelAliasProbeDO, {
      GATEWAY_URL: "http://server.test",
    });

    await expect(call("probePanelAliases")).resolves.toEqual({
      createdId: expect.stringMatching(/^panel:tree\/panels~new\//),
      knownId: "panel:tree/known-slot",
    });
    expect(calls.map(({ method }) => method)).not.toContain("panelTree.create");
    expect(calls.map(({ method }) => method)).toContain(
      "workspace-state.slot.create",
    );
  });

  it("builds a panel parent handle with entity-scoped RPC and slot-scoped CDP", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> =
      [];
    globalThis.fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = parseReq(init);
        // Strip the opaque transport requestId/idempotencyKey; these tests assert routing.
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

    const [{ PanelDurableObjectBase }, { createTestDO }] = await Promise.all([
      import("./panel-durable-base.js"),
      import("./durable-test-utils.js"),
    ]);

    class ParentProbeDO extends PanelDurableObjectBase {
      protected createTables(): void {}

      @rpc({
        principals: ["host", "user", "code"],
        effect: { kind: "open" },
        tier: "open",
        sensitivity: "read",
      })
      async probeParent(): Promise<{
        id: string;
        title: string | undefined;
        cdpEndpoint: unknown;
      } | null> {
        const parent = this.getParent();
        if (!parent) return null;
        await parent.call["ping"]?.();
        const cdpEndpoint = await parent.cdp.getCdpEndpoint();
        await parent.reload();
        await parent.rebuild();
        return { id: parent.id, title: parent.title, cdpEndpoint };
      }
    }

    const { instance } = await createTestDO(ParentProbeDO, {
      GATEWAY_URL: "http://server.test",
    });
    const fetchable = instance as unknown as {
      fetch(request: Request): Promise<Response>;
    };
    // Converged inbound dispatch: caller attribution rides in the envelope's
    // delivery.caller (POSTed to __rpc), not X-vibestudio-Rpc-Caller-* headers.
    const caller = {
      callerId: "panel:nav-parent-entity",
      callerKind: "panel",
      callerPanelId: "panel:tree/parent-slot",
      authorization: createTestDirectAuthority({
        callerKind: "panel",
        method: "probeParent",
        source: "test",
        className: "TestDO",
      }),
    };
    const response = await fetchable.fetch(
      new Request("http://test/test-key/__rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: caller.callerId,
          target: "do:test:ParentProbeDO:test-key",
          delivery: { caller },
          provenance: [caller],
          message: {
            type: "request",
            requestId: "r-probe",
            fromId: caller.callerId,
            method: "probeParent",
            args: [],
          },
        }),
      }),
    );

    const responseEnvelope = (await response.json()) as {
      message: { result?: unknown; error?: string };
    };
    expect(responseEnvelope.message.error).toBeUndefined();
    expect(responseEnvelope.message.result).toEqual({
      id: "panel:tree/parent-slot",
      title: "Panel A",
      cdpEndpoint: { wsEndpoint: "ws://cdp.test" },
    });
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
