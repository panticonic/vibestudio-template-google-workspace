import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvelopeRpcTransport, RpcEnvelope } from "@vibestudio/rpc";
import { initRuntime } from "./initRuntime.js";
import { setStateArgs } from "../panel/stateArgs.js";
import { DEFAULT_THEME_CONFIG } from "../types.js";
import {
  HOST_COMMAND_CONTRIBUTION_EVENT,
  HOST_COMMAND_RUN_EVENT,
} from "@vibestudio/shared/hostCommands";

const g = globalThis as typeof globalThis & {
  __vibestudioEntityId?: string;
  __vibestudioSlotId?: string;
  __vibestudioContextId?: string;
  __vibestudioKind?: "panel" | "shell";
  __vibestudioParentId?: string | null;
  __vibestudioParentEntityId?: string | null;
  __vibestudioInitialTheme?: "light" | "dark";
  __vibestudioGatewayConfig?: { serverUrl: string; token: string };
  __vibestudioEnv?: Record<string, string>;
  __vibestudioShell?: Record<string, unknown>;
  __vibestudioStateArgs?: Record<string, unknown>;
};
const WORKSPACE_STATE_TARGET = "main";

function createTransport(options?: {
  onSend?: (
    envelope: RpcEnvelope,
    deliver: (envelope: RpcEnvelope) => void,
  ) => void | Promise<void>;
}): EnvelopeRpcTransport {
  let messageHandler: ((envelope: RpcEnvelope) => void) | null = null;
  return {
    send: vi.fn(async (envelope) => {
      if (
        envelope.target === "main" &&
        envelope.message.type === "request" &&
        envelope.message.method === "view.getThemeConfig"
      ) {
        messageHandler?.(responseFor(envelope, DEFAULT_THEME_CONFIG));
        return;
      }
      await options?.onSend?.(envelope, (inboundEnvelope) => {
        messageHandler?.(inboundEnvelope);
      });
    }),
    onMessage: vi.fn((handler) => {
      messageHandler = handler;
      return vi.fn();
    }),
  };
}

function responseFor(envelope: RpcEnvelope, result: unknown): RpcEnvelope {
  if (envelope.message.type !== "request") {
    throw new Error("responseFor expects a request envelope");
  }
  return {
    from: envelope.target,
    target: envelope.from,
    delivery: { caller: { callerId: envelope.target, callerKind: "server" } },
    provenance: envelope.provenance,
    message: {
      type: "response",
      requestId: envelope.message.requestId,
      result,
    },
  };
}

function stubPanelWindow(): EventTarget & {
  __vibestudioStateArgs?: Record<string, unknown>;
} {
  const panelWindow = new EventTarget() as EventTarget & {
    __vibestudioStateArgs?: Record<string, unknown>;
  };
  vi.stubGlobal("window", panelWindow);
  if (typeof CustomEvent === "undefined") {
    vi.stubGlobal(
      "CustomEvent",
      class<T> extends Event {
        detail: T;
        constructor(type: string, init?: CustomEventInit<T>) {
          super(type);
          this.detail = init?.detail as T;
        }
      },
    );
  }
  return panelWindow;
}

describe("initRuntime", () => {
  afterEach(() => {
    delete g.__vibestudioEntityId;
    delete g.__vibestudioSlotId;
    delete g.__vibestudioContextId;
    delete g.__vibestudioKind;
    delete g.__vibestudioParentId;
    delete g.__vibestudioParentEntityId;
    delete g.__vibestudioInitialTheme;
    delete g.__vibestudioGatewayConfig;
    delete g.__vibestudioEnv;
    delete g.__vibestudioShell;
    delete g.__vibestudioStateArgs;
    vi.unstubAllGlobals();
  });

  it("uses the injected canonical panel id as the RPC self id", () => {
    g.__vibestudioEntityId = "panel:panel-1";
    g.__vibestudioSlotId = "panel:tree/slot-1";
    g.__vibestudioContextId = "ctx-1";
    g.__vibestudioKind = "panel";
    g.__vibestudioGatewayConfig = {
      serverUrl: "http://127.0.0.1:3000",
      token: "token",
    };
    g.__vibestudioShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime, config } = initRuntime({
      createTransport,
      fs: {} as never,
    });

    expect(config.entityId).toBe("panel:panel-1");
    expect(config.slotId).toBe("panel:tree/slot-1");
    expect(runtime.rpc.selfId).toBe("panel:panel-1");
  });

  it("preserves call delivery metadata through the runtime transport envelope", async () => {
    const sent: RpcEnvelope[] = [];
    g.__vibestudioEntityId = "panel:panel-1";
    g.__vibestudioSlotId = "panel:tree/slot-1";
    g.__vibestudioContextId = "ctx-1";
    g.__vibestudioKind = "panel";
    g.__vibestudioGatewayConfig = {
      serverUrl: "http://127.0.0.1:3000",
      token: "token",
    };
    g.__vibestudioShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime } = initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (envelope, deliver) => {
            const message = envelope.message;
            if (message.type !== "request") return;
            sent.push(envelope);
            deliver(responseFor(envelope, "ok"));
          },
        }),
      fs: {} as never,
    });

    await expect(
      runtime.rpc.call("main", "fs.writeFile", ["/tmp/x", "y"], {
        idempotencyKey: "idem-1",
        readOnly: true,
      }),
    ).resolves.toBe("ok");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      target: "main",
      delivery: { idempotencyKey: "idem-1", readOnly: true },
      message: {
        type: "request",
        method: "fs.writeFile",
      },
    });
    expect(sent[0]!.message).not.toHaveProperty("idempotencyKey");
    expect(sent[0]!.message).not.toHaveProperty("readOnly");
  });

  it("uses the stable slot id and applies returned current-panel state args locally", async () => {
    const panelTreeSetStateArgsMock = vi.fn();
    const stateArgsChanged = vi.fn();
    const panelWindow = stubPanelWindow();
    g.__vibestudioEntityId = "panel:entity-1";
    g.__vibestudioSlotId = "panel:tree/slot-1";
    g.__vibestudioContextId = "ctx-1";
    g.__vibestudioKind = "panel";
    g.__vibestudioGatewayConfig = {
      serverUrl: "http://127.0.0.1:3000",
      token: "token",
    };
    g.__vibestudioShell = {
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };
    panelWindow.addEventListener(
      "vibestudio:stateArgsChanged",
      stateArgsChanged,
    );

    initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (envelope, deliver) => {
            const message = envelope.message;
            if (message.type !== "request") return;
            panelTreeSetStateArgsMock(message.method, message.args);
            deliver(
              responseFor(
                envelope,
                message.method === "workers.resolveService"
                  ? { kind: "durable-object", targetId: WORKSPACE_STATE_TARGET }
                  : message.method === "workspace-state.panelTree.detail"
                    ? {
                        currentHistory: { state_args: '{"fromHost":true}' },
                        entity: {},
                      }
                    : undefined,
              ),
            );
          },
        }),
      fs: {} as never,
    });

    await setStateArgs({ mode: "live" });

    expect(panelTreeSetStateArgsMock).toHaveBeenCalledWith(
      "workspace-state.slot.updateCurrentStateArgs",
      ["panel:tree/slot-1", { mode: "live", fromHost: true }],
    );
    expect(panelWindow.__vibestudioStateArgs).toEqual({
      mode: "live",
      fromHost: true,
    });
    expect(stateArgsChanged).toHaveBeenCalledTimes(1);
    expect((stateArgsChanged.mock.calls[0]?.[0] as CustomEvent).detail).toEqual(
      {
        mode: "live",
        fromHost: true,
      },
    );
  });

  it("applies host-published state args for non-caller updates", () => {
    const panelWindow = stubPanelWindow();
    const stateArgsChanged = vi.fn();
    const shellListeners: Array<(event: string, payload: unknown) => void> = [];
    g.__vibestudioEntityId = "panel:panel-1";
    g.__vibestudioSlotId = "panel:tree/slot-1";
    g.__vibestudioContextId = "ctx-1";
    g.__vibestudioKind = "panel";
    g.__vibestudioGatewayConfig = {
      serverUrl: "http://127.0.0.1:3000",
      token: "token",
    };
    g.__vibestudioShell = {
      addEventListener: vi.fn(
        (listener: (event: string, payload: unknown) => void) => {
          shellListeners.push(listener);
          return 1;
        },
      ),
      removeEventListener: vi.fn(),
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };
    panelWindow.addEventListener(
      "vibestudio:stateArgsChanged",
      stateArgsChanged,
    );

    initRuntime({
      createTransport,
      fs: {} as never,
    });
    expect(shellListeners).toHaveLength(2);
    for (const listener of shellListeners) {
      listener("runtime:stateArgsChanged", { mode: "external" });
    }

    expect(panelWindow.__vibestudioStateArgs).toEqual({ mode: "external" });
    expect(stateArgsChanged).toHaveBeenCalledTimes(1);
    expect((stateArgsChanged.mock.calls[0]?.[0] as CustomEvent).detail).toEqual(
      {
        mode: "external",
      },
    );
  });

  it("normalizes loopback gateway URLs to the panel page origin", () => {
    vi.stubGlobal("location", { origin: "http://localhost:3000" });
    g.__vibestudioEntityId = "panel:panel-1";
    g.__vibestudioSlotId = "panel:tree/slot-1";
    g.__vibestudioContextId = "ctx-1";
    g.__vibestudioKind = "panel";
    g.__vibestudioGatewayConfig = {
      serverUrl: "http://127.0.0.1:3000",
      token: "token",
    };
    g.__vibestudioShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { config } = initRuntime({
      createTransport,
      fs: {} as never,
    });

    expect(config.gatewayConfig.serverUrl).toBe("http://localhost:3000");
    expect(config.gatewayConfig.aliases).toContain("http://127.0.0.1:3000");
  });

  it("does not normalize non-equivalent gateway origins", () => {
    vi.stubGlobal("location", { origin: "http://localhost:3000" });
    g.__vibestudioEntityId = "panel:panel-1";
    g.__vibestudioSlotId = "panel:tree/slot-1";
    g.__vibestudioContextId = "ctx-1";
    g.__vibestudioKind = "panel";
    g.__vibestudioGatewayConfig = {
      serverUrl: "http://127.0.0.1:4000",
      token: "token",
    };
    g.__vibestudioShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { config } = initRuntime({
      createTransport,
      fs: {} as never,
    });

    expect(config.gatewayConfig.serverUrl).toBe("http://127.0.0.1:4000");
    expect(config.gatewayConfig.aliases).toBeUndefined();
  });

  it("uses the parent slot id for handle identity/control and the parent entity id for RPC", async () => {
    const sends: Array<{ targetId: string; method: string; args: unknown[] }> =
      [];
    g.__vibestudioEntityId = "panel:child-entity";
    g.__vibestudioSlotId = "child-slot";
    g.__vibestudioContextId = "ctx-1";
    g.__vibestudioKind = "panel";
    g.__vibestudioParentId = "panel:tree/parent-slot";
    g.__vibestudioParentEntityId = "panel:nav-parent-entity";
    g.__vibestudioGatewayConfig = {
      serverUrl: "http://127.0.0.1:3000",
      token: "token",
    };
    g.__vibestudioShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime, config } = initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (envelope, deliver) => {
            const message = envelope.message;
            if (message.type !== "request") return;
            sends.push({
              targetId: envelope.target,
              method: message.method,
              args: message.args,
            });
            if (message.method === "workspace-state.panelTree.detail") {
              deliver(
                responseFor(envelope, {
                  slot: {
                    parent_slot_id: null,
                    current_entity_title: "Parent",
                  },
                  currentHistory: {
                    source: "panels/parent",
                    context_id: "ctx-1",
                    options: null,
                  },
                  entity: {
                    id: "panel:nav-parent-entity",
                    source: { effectiveVersion: "ev-parent" },
                  },
                }),
              );
              return;
            }
            if (message.method === "panelRuntime.ensureSlot") {
              deliver(
                responseFor(envelope, {
                  status: "assigned",
                  lease: null,
                  attempt: {
                    epoch: "test",
                    attemptId: "attempt:parent",
                    slotId: "panel:tree/parent-slot",
                    runtimeEntityId: "panel:nav-parent-entity",
                    phase: "ready",
                    revision: 1,
                    reporter: "renderer",
                    updatedAt: 1,
                  },
                }),
              );
              return;
            }
            if (message.method === "panelRuntime.observeSlot") {
              deliver(
                responseFor(envelope, {
                  version: { epoch: "test", counter: 1 },
                  attempt: {
                    epoch: "test",
                    attemptId: "attempt:parent",
                    slotId: "panel:tree/parent-slot",
                    runtimeEntityId: "panel:nav-parent-entity",
                    phase: "ready",
                    revision: 1,
                    reporter: "renderer",
                    updatedAt: 1,
                  },
                  route: {
                    reachable: true,
                    connectionId: "route:parent",
                    holderLabel: "Test host",
                    platform: "headless",
                    supportsCdp: true,
                    view: { url: "http://panel.test/", loading: false },
                  },
                }),
              );
              return;
            }
            deliver(
              responseFor(envelope, {
                wsEndpoint: "ws://server/cdp/panel:tree/parent-slot",
                token: "t",
              }),
            );
          },
        }),
      fs: {} as never,
    });

    expect(config.parentId).toBe("panel:tree/parent-slot");
    expect(config.parentEntityId).toBe("panel:nav-parent-entity");
    expect(runtime.parentId).toBe("panel:tree/parent-slot");
    expect(runtime.parentEntityId).toBe("panel:nav-parent-entity");
    expect(runtime.getParent()?.id).toBe("panel:tree/parent-slot");
    expect(runtime.getParent()).toMatchObject({
      id: "panel:tree/parent-slot",
      parentId: null,
    });

    await runtime.getParent()?.call["ping"]?.();
    await expect(runtime.getParent()?.cdp.getCdpEndpoint()).resolves.toEqual({
      wsEndpoint: "ws://server/cdp/panel:tree/parent-slot",
      token: "t",
    });

    expect(sends).toContainEqual(
      { targetId: "panel:nav-parent-entity", method: "ping", args: [] },
    );
    expect(sends).toContainEqual(
      {
        targetId: "main",
        method: "panelCdp.getCdpEndpoint",
        args: ["panel:tree/parent-slot"],
      },
    );
  });

  it("exposes panel lifecycle and state operations on the unified parent handle", async () => {
    const sends: Array<{ targetId: string; method: string; args: unknown[] }> =
      [];
    g.__vibestudioEntityId = "panel:child-entity";
    g.__vibestudioSlotId = "child-slot";
    g.__vibestudioContextId = "ctx-1";
    g.__vibestudioKind = "panel";
    g.__vibestudioParentId = "panel:tree/parent-slot";
    g.__vibestudioParentEntityId = "panel:nav-parent-entity";
    g.__vibestudioGatewayConfig = {
      serverUrl: "http://127.0.0.1:3000",
      token: "token",
    };
    g.__vibestudioShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime } = initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (envelope, deliver) => {
            const message = envelope.message;
            if (message.type !== "request") return;
            sends.push({
              targetId: envelope.target,
              method: message.method,
              args: message.args,
            });
            const navigation =
              message.method === "panelTree.navigate"
                ? {
                    panelId: "panel:tree/parent-slot",
                    title: "Next",
                    source: "panels/next",
                    kind: "workspace",
                    parentId: null,
                    contextId: "ctx-next",
                    requestedRef: "main",
                    runtimeEntityId: "panel:nav-next-entity",
                    attemptId: `panel:nav-next-entity@${"b".repeat(64)}`,
                    effectiveVersion: "e".repeat(64),
                    buildKey: "b".repeat(64),
                    phase: "ready",
                    updatedAt: 1,
                  }
                : undefined;
            deliver(
              responseFor(
                envelope,
                message.method === "workers.resolveService"
                  ? { kind: "durable-object", targetId: WORKSPACE_STATE_TARGET }
                  : message.method === "titlesForSlots"
                    ? Object.fromEntries(
                        (message.args[0] as string[]).map((slotId) => [
                          slotId,
                          slotId === "panel:tree/parent-slot"
                            ? "Parent"
                            : "Next",
                        ]),
                      )
                    : message.method === "build.getPanelMetadata"
                      ? { title: "Next", stateArgs: undefined }
                      : message.method === "runtime.createEntity"
                        ? {
                            id: "panel:nav-next-entity",
                            contextId: "ctx-next",
                            source: { effectiveVersion: "ev-next" },
                            buildKey: "build-next",
                          }
                        : message.method === "workspace-state.slot.close"
                          ? { closeId: "close-1", closedCount: 1 }
                          : message.method ===
                              "workspace-state.slot.closeCleanupPage"
                            ? { items: [], nextCursor: null }
                            : message.method ===
                                "workspace-state.panelTree.detail"
                              ? {
                                  slot: {
                                    slot_id: "panel:tree/parent-slot",
                                    parent_slot_id: null,
                                  },
                                  currentHistory: {
                                    source: "panels/current",
                                    context_id: "ctx-1",
                                    state_args: null,
                                    options: null,
                                  },
                                  entity: {
                                    id: "panel:nav-parent-entity",
                                    source: { effectiveVersion: "ev-current" },
                                    activeBuildKey: "build-current",
                                  },
                                }
                              : message.method ===
                                  "workspace-state.slot.commitPreparedNavigation"
                                ? {
                                    previousEntityId: "panel:nav-parent-entity",
                                    currentEntityId: "panel:nav-next-entity",
                                  }
                                : message.method === "panelRuntime.ensureSlot"
                                  ? {
                                      status: "assigned",
                                      lease: null,
                                      attempt: {
                                        epoch: "test",
                                        attemptId: `attempt:${String(message.args[1])}`,
                                        slotId: String(message.args[0]),
                                        runtimeEntityId: String(
                                          message.args[1],
                                        ),
                                        phase: "ready",
                                        revision: 1,
                                        reporter: "renderer",
                                        updatedAt: 1,
                                      },
                                    }
                                  : message.method ===
                                      "panelRuntime.observeSlot"
                                    ? {
                                        version: { epoch: "test", counter: 1 },
                                        attempt: {
                                          epoch: "test",
                                          attemptId:
                                            "attempt:panel:nav-parent-entity",
                                          slotId: String(message.args[0]),
                                          runtimeEntityId:
                                            "panel:nav-parent-entity",
                                          phase: "ready",
                                          revision: 1,
                                          reporter: "renderer",
                                          updatedAt: 1,
                                        },
                                        route: {
                                          reachable: true,
                                          connectionId: "route:parent",
                                          holderLabel: "test",
                                          platform: "headless",
                                          supportsCdp: false,
                                          view: {
                                            url: "http://test/panels/next",
                                            loading: false,
                                          },
                                        },
                                      }
                                    : message.method === "panelTree.page"
                                      ? {
                                          revision: 1,
                                          group: (
                                            message.args[0] as {
                                              group: unknown;
                                            }
                                          ).group,
                                          nodes: [
                                            {
                                              slotId: "sibling-slot",
                                              ownerUserId: null,
                                              title: "Sibling",
                                              source: "panels/sibling",
                                              kind: "workspace",
                                              parentSlotId:
                                                "panel:tree/parent-slot",
                                              runtimeEntityId:
                                                "panel:sibling-entity",
                                              createdAt: 1,
                                              childCount: 0,
                                            },
                                          ],
                                          nextCursor: null,
                                        }
                                      : navigation
                                        ? {
                                            ...navigation,
                                            observation: navigation,
                                          }
                                        : undefined,
              ),
            );
          },
        }),
      fs: {} as never,
    });

    const parent = runtime.parent;
    await parent.archive();
    await parent.navigate("panels/next", { contextId: "ctx-next" });
    await parent.stateArgs.set({ mode: "fixture" });

    expect(sends).toEqual(
      expect.arrayContaining([
        {
          targetId: WORKSPACE_STATE_TARGET,
          method: "workspace-state.slot.close",
          args: ["panel:tree/parent-slot"],
        },
        expect.objectContaining({
          targetId: WORKSPACE_STATE_TARGET,
          method: "workspace-state.slot.commitPreparedNavigation",
          args: [
            expect.objectContaining({
              slotId: "panel:tree/parent-slot",
              expectedCurrentEntityId: "panel:nav-parent-entity",
              mutation: expect.objectContaining({
                kind: "append",
                entry: expect.objectContaining({
                  source: "panels/next",
                  contextId: "ctx-next",
                  entityId: "panel:nav-next-entity",
                }),
              }),
            }),
          ],
        }),
        {
          targetId: WORKSPACE_STATE_TARGET,
          method: "workspace-state.slot.updateCurrentStateArgs",
          args: ["panel:tree/parent-slot", { mode: "fixture" }],
        },
      ]),
    );
    expect(sends.map(({ method }) => method)).not.toContain("panelTree.close");
    expect(sends.map(({ method }) => method)).not.toContain(
      "panelTree.navigate",
    );
  });

  it("launches workers through runtime.createEntity (server derives the parent)", async () => {
    const sends: Array<{ targetId: string; method: string; args: unknown[] }> =
      [];
    g.__vibestudioEntityId = "panel:child-entity";
    g.__vibestudioSlotId = "child-slot";
    g.__vibestudioContextId = "ctx-1";
    g.__vibestudioKind = "panel";
    g.__vibestudioGatewayConfig = {
      serverUrl: "http://127.0.0.1:3000",
      token: "token",
    };
    g.__vibestudioShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime } = initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (envelope, deliver) => {
            const message = envelope.message;
            if (message.type !== "request") return;
            sends.push({
              targetId: envelope.target,
              method: message.method,
              args: message.args,
            });
            deliver(
              responseFor(envelope, {
                id: "worker:workers/agent:agent",
                kind: "worker",
                source: { repoPath: "workers/agent", effectiveVersion: "ev-1" },
                contextId: "ctx-1",
                targetId: "worker:workers/agent:agent",
              }),
            );
          },
        }),
      fs: {} as never,
    });

    // The panel-side client no longer injects parent metadata — the worker entity
    // is created through the unified runtime path, where the SERVER derives the
    // launch parent from the verified caller.
    await runtime.callMain("runtime.createEntity", {
      kind: "worker",
      execution: { surface: "code", source: "workers/agent" },
      key: "agent",
      contextId: "ctx-1",
    });

    expect(sends).toEqual([
      {
        targetId: "main",
        method: "runtime.createEntity",
        args: [
          {
            kind: "worker",
            execution: { surface: "code", source: "workers/agent" },
            key: "agent",
            contextId: "ctx-1",
          },
        ],
      },
    ]);
  });

  it("keeps command-palette contributions on attributed panel-to-shell events", async () => {
    const sent: RpcEnvelope[] = [];
    let deliverInbound: ((envelope: RpcEnvelope) => void) | null = null;
    g.__vibestudioEntityId = "panel:panel-1";
    g.__vibestudioSlotId = "panel:tree/slot-1";
    g.__vibestudioContextId = "ctx-1";
    g.__vibestudioKind = "panel";
    g.__vibestudioGatewayConfig = {
      serverUrl: "http://127.0.0.1:3000",
      token: "token",
    };
    g.__vibestudioShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime } = initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (envelope, deliver) => {
            sent.push(envelope);
            deliverInbound = deliver;
          },
        }),
      fs: {} as never,
    });
    const onRun = vi.fn();
    runtime.onHostCommandRun(onRun);

    runtime.registerHostCommands([{ id: "open", label: "Open" }]);
    await vi.waitFor(() => {
      expect(
        sent.some(
          (envelope) =>
            envelope.target === "shell" &&
            envelope.message.type === "event" &&
            envelope.message.event === HOST_COMMAND_CONTRIBUTION_EVENT &&
            JSON.stringify(envelope.message.payload) ===
              JSON.stringify({ commands: [{ id: "open", label: "Open" }] }),
        ),
      ).toBe(true);
    });

    (deliverInbound as ((envelope: RpcEnvelope) => void) | null)?.({
      from: "shell",
      target: "panel:panel-1",
      delivery: { caller: { callerId: "shell", callerKind: "shell" } },
      provenance: [],
      message: {
        type: "event",
        fromId: "shell",
        event: HOST_COMMAND_RUN_EVENT,
        payload: { commandId: "open" },
      },
    });
    expect(onRun).toHaveBeenCalledWith("open");

    runtime.unregisterHostCommands();
    await vi.waitFor(() => {
      expect(
        sent.some(
          (envelope) =>
            envelope.target === "shell" &&
            envelope.message.type === "event" &&
            envelope.message.event === HOST_COMMAND_CONTRIBUTION_EVENT &&
            JSON.stringify(envelope.message.payload) ===
              JSON.stringify({ commands: [] }),
        ),
      ).toBe(true);
    });
  });
});
