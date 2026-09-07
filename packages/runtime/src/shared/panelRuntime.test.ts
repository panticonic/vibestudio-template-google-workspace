import { describe, expect, it, vi } from "vitest";
import { ledgerTest } from "../../../../tests/helpers/ledgerTest.js";
import { createPanelRuntime } from "./panelRuntime.js";

function readyHostReport() {
  return {
    version: { epoch: "test", counter: 1 },
    attempt: {
      epoch: "test",
      attemptId: "attempt:panel:nav-new",
      slotId: "panel:tree/new",
      runtimeEntityId: "panel:nav-new",
      phase: "ready" as const,
      revision: 1,
      reporter: "renderer" as const,
      updatedAt: 1,
    },
    route: {
      reachable: true,
      connectionId: "route",
      holderLabel: "Headless",
      platform: "headless" as const,
      supportsCdp: true,
      view: { url: "http://panel.test/", loading: false },
    },
  };
}

function detail(entityId = "panel:nav-new", source = "panels/new") {
  return {
    slot: { parent_slot_id: null, current_entity_title: "New" },
    currentHistory: {
      source,
      context_id: "ctx:test",
      state_args: "{}",
      options: '{"ref":"main"}',
    },
    entity: {
      id: entityId,
      source: { effectiveVersion: "ev-new" },
      activeBuildKey: "build-new",
    },
  };
}

function runtimeHarness(
  options: {
    hostAvailable?: boolean;
    browserReady?: boolean;
    browserUrl?: string;
    browserSource?: string;
    observeError?: Error;
    alwaysLoading?: boolean;
    unknownAttempt?: boolean;
    activateError?: Error;
    slotCreateError?: Error;
    replaceEntityOnAgentFailure?: boolean;
    disconnectAgentTarget?: boolean;
    recoverStoppedRoute?: boolean;
    onCreateSlotTiming?: NonNullable<
      Parameters<typeof createPanelRuntime>[0]["onCreateSlotTiming"]
    >;
  } = {},
) {
  let currentSlotId = "panel:tree/new";
  let currentEntityId = "panel:nav-new";
  let currentSource = options.browserReady
    ? (options.browserSource ?? "browser:data:text/html,<p>ready</p>")
    : "panels/new";
  let agentCalls = 0;
  let ensureSlotCalls = 0;
  let observeSlotCalls = 0;
  const call = vi.fn(
    async <T>(
      _target: string,
      method: string,
      args: unknown[],
      callOptions?: { signal?: AbortSignal },
    ): Promise<T> => {
      if (method.startsWith("_agent.")) {
        agentCalls += 1;
        if (agentCalls === 1 && options.replaceEntityOnAgentFailure) {
          currentEntityId = "panel:nav-replacement";
          throw Object.assign(new Error(`Target not reachable: ${_target}`), {
            code: "TARGET_NOT_REACHABLE",
          });
        }
        if (options.disconnectAgentTarget) {
          throw Object.assign(new Error(`Target not reachable: ${_target}`), {
            code: "TARGET_NOT_REACHABLE",
          });
        }
      }
      switch (method) {
        case "_agent.snapshot": {
          return {
            kind: "synth",
            text: `snapshot:${_target}`,
            structure: {},
          } as T;
        }
        case "_agent.tree":
          return { target: _target } as T;
        case "tests.run":
          return { target: _target } as T;
        case "build.getPanelMetadata":
          return { title: "New" } as T;
        case "workspace-state.panel.index":
        case "workspace-state.panel.updateTitle":
          return undefined as T;
        case "workspace-state.panel.sourceUsage":
          return [
            {
              source: "panels/terminal",
              accessCount: 12,
              lastAccessedAt: 1234,
            },
          ] as T;
        case "workspace-state.panelTree.search":
          return { results: [], nextCursor: null } as T;
        case "runtime.reserveEntity":
          return {
            id: currentEntityId,
            contextId: "ctx:test",
            source: { effectiveVersion: "" },
          } as T;
        case "runtime.activateReservedEntity":
          if (options.activateError) throw options.activateError;
          return {
            id: currentEntityId,
            contextId: "ctx:test",
            source: { effectiveVersion: "ev-new" },
            buildKey: "build-new",
          } as T;
        case "runtime.createEntity": {
          const spec = args[0] as { key: string; contextId?: string };
          currentEntityId =
            method === "runtime.createEntity"
              ? `panel:${spec.key}`
              : currentEntityId;
          return {
            id: currentEntityId,
            contextId: spec.contextId ?? "ctx:test",
            source: { effectiveVersion: "ev-new" },
            buildKey: "build-new",
          } as T;
        }
        case "workspace-state.slot.create": {
          if (options.slotCreateError) throw options.slotCreateError;
          const input = args[0] as {
            slotId: string;
            initialEntry?: { source: string };
          };
          currentSlotId = input.slotId;
          if (input.initialEntry) currentSource = input.initialEntry.source;
          return undefined as T;
        }
        case "workspace-state.slot.commitPreparedNavigation": {
          const input = args[0] as {
            mutation: { entry: { entityId: string } };
            expectedCurrentEntityId: string;
          };
          const previousEntityId = input.expectedCurrentEntityId;
          currentEntityId = input.mutation.entry.entityId;
          return {
            previousEntityId,
            currentEntityId,
            currentEntryKey: "nav-current",
            cursor: 1,
            lease: null,
          } as T;
        }
        case "workspace-state.panelTree.detail":
          return detail(currentEntityId, currentSource) as T;
        case "panelRuntime.ensureSlot":
          ensureSlotCalls += 1;
          if (options.recoverStoppedRoute && ensureSlotCalls > 1) {
            currentEntityId = "panel:nav-replacement";
          }
          return {
            status:
              options.hostAvailable === false ? "unavailable" : "assigned",
            lease:
              options.hostAvailable === false
                ? null
                : {
                    holderLabel: "Headless",
                    platform: "headless",
                    supportsCdp: true,
                  },
            attempt: {
              epoch: "test",
              attemptId: `attempt:${currentEntityId}`,
              slotId: currentSlotId,
              runtimeEntityId: currentEntityId,
              phase: options.alwaysLoading ? "loading" : "ready",
              revision: 1,
              reporter: "renderer",
              updatedAt: 1,
            },
          } as T;
        case "panelRuntime.observeSlot":
          observeSlotCalls += 1;
          if (options.observeError) throw options.observeError;
          if (options.hostAvailable === false) {
            return {
              version: { epoch: "test", counter: 1 },
              attempt: null,
              route: { reachable: false },
            } as T;
          }
          if (options.alwaysLoading) {
            return {
              version: { epoch: "test", counter: 1 },
              attempt: {
                epoch: "test",
                attemptId: `attempt:${currentEntityId}`,
                slotId: currentSlotId,
                runtimeEntityId: currentEntityId,
                phase: "loading",
                revision: 1,
                reporter: "renderer",
                updatedAt: 1,
              },
              route: {
                reachable: true,
                connectionId: "route",
                holderLabel: "Headless",
                platform: "headless" as const,
                supportsCdp: true,
                view: { url: "http://panel.test/", loading: true },
              },
            } as T;
          }
          if (options.recoverStoppedRoute) {
            const replacement = currentEntityId === "panel:nav-replacement";
            return {
              version: { epoch: "test", counter: observeSlotCalls },
              attempt: {
                epoch: "test",
                attemptId: replacement
                  ? "attempt:panel:nav-replacement"
                  : "attempt:panel:nav-new",
                slotId: currentSlotId,
                runtimeEntityId: currentEntityId,
                phase: observeSlotCalls === 2 ? "stopped" : "ready",
                ...(observeSlotCalls === 2 ? { stopReason: "host-lost" } : {}),
                revision: 1,
                reporter: observeSlotCalls === 2 ? "coordinator" : "renderer",
                updatedAt: observeSlotCalls,
              },
              route: {
                reachable: replacement,
                ...(replacement
                  ? {
                      connectionId: "replacement-route",
                      holderLabel: "Headless",
                      platform: "headless" as const,
                      supportsCdp: true,
                      view: { url: "http://panel.test/", loading: false },
                    }
                  : {}),
              },
            } as T;
          }
          return (
            options.browserReady
              ? {
                  version: { epoch: "test", counter: 1 },
                  attempt: {
                    epoch: "test",
                    attemptId: `attempt:${currentEntityId}`,
                    slotId: currentSlotId,
                    runtimeEntityId: currentEntityId,
                    phase:
                      options.browserUrl === "about:blank"
                        ? "pending"
                        : "ready",
                    revision: 1,
                    reporter: "host",
                    updatedAt: 1,
                  },
                  route: {
                    reachable: true,
                    connectionId: "route",
                    holderLabel: "Headless",
                    platform: "headless" as const,
                    supportsCdp: true,
                    view: {
                      url: options.browserUrl ?? "data:text/html,<p>ready</p>",
                      loading: false,
                    },
                  },
                }
              : {
                  ...readyHostReport(),
                  attempt: {
                    ...readyHostReport().attempt,
                    attemptId: `attempt:${currentEntityId}`,
                    runtimeEntityId: currentEntityId,
                  },
                }
          ) as T;
        case "panelRuntime.getAttempt":
          if (options.unknownAttempt) {
            return { kind: "unknown-attempt", ref: args[0] } as T;
          }
          return {
            kind: "report",
            attempt: {
              epoch: "test",
              attemptId: `attempt:${currentEntityId}`,
              slotId: currentSlotId,
              runtimeEntityId: currentEntityId,
              phase: options.alwaysLoading ? "loading" : "ready",
              revision: 1,
              reporter: "renderer",
              updatedAt: 1,
            },
          } as T;
        case "panelRuntime.awaitAttempt":
          if (options.unknownAttempt) {
            return { kind: "unknown-attempt", ref: args[0] } as T;
          }
          return (await new Promise((_, reject) => {
            const signal = callOptions?.signal;
            if (signal?.aborted) reject(signal.reason);
            else
              signal?.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
          })) as T;
        case "runtime.retireEntity":
        case "view.focusPanel":
          return undefined as T;
        case "panelRuntime.unloadSlot":
          return {
            panelId: String(args[0]),
            operation: "unload",
            status: "unloaded",
            loaded: false,
            rebuilt: false,
            reloaded: false,
          } as T;
        case "runtime.supervision.restart":
          return undefined as T;
        case "workspace-state.panelTree.page": {
          const input = args[0] as { group: { parentSlotId: string } };
          return {
            revision: 17,
            group: input.group,
            nodes: [
              {
                slotId: "browser",
                title: "Example",
                kind: "browser",
                source: "browser:https://example.com/",
                parentSlotId: input.group.parentSlotId,
                ownerUserId: null,
                contextId: "ctx:browser",
                createdAt: 1,
                childCount: 0,
              },
            ],
            nextCursor: null,
          } as T;
        }
        case "workspace-state.panelTree.rootsForCaller":
          return {
            revision: 17,
            group: { kind: "roots", ownerUserId: "usr-current" },
            nodes: [
              {
                slotId: "current-root",
                title: "Current root",
                kind: "workspace",
                source: "panels/current",
                parentSlotId: null,
                ownerUserId: "usr-current",
                contextId: "ctx:current",
                createdAt: 1,
                childCount: 0,
              },
            ],
            nextCursor: null,
          } as T;
        case "workspace-state.panelTree.path":
          return {
            revision: 17,
            nodes: [
              {
                slotId: "root",
                title: "Research",
                kind: "workspace",
                source: "about/collection",
                parentSlotId: null,
                ownerUserId: null,
                contextId: "ctx:root",
                createdAt: 1,
                childCount: 1,
              },
            ],
          } as T;
        default:
          throw new Error(
            `Unexpected RPC method: ${method} for ${currentSlotId}`,
          );
      }
    },
  );
  return {
    call,
    runtime: createPanelRuntime({
      rpc: { call, emit: vi.fn(), on: vi.fn() } as never,
      defaultOpenParentId: null,
      createCdp: () => ({}) as never,
      onCreateSlotTiming: options.onCreateSlotTiming,
    }),
  };
}

function runtimeFocusHarness() {
  const harness = runtimeHarness();
  const focusPanel = vi.fn(
    async (_id: string, _options?: unknown): Promise<void> => {},
  );
  return {
    call: harness.call,
    focusPanel,
    runtime: createPanelRuntime({
      rpc: { call: harness.call, emit: vi.fn(), on: vi.fn() } as never,
      focusPanel,
      defaultOpenParentId: null,
      createCdp: () => ({}) as never,
    }),
  };
}

describe("panel runtime topology composition", () => {
  ledgerTest("execution.panel", async () => {
    const { runtime, call } = runtimeHarness();

    await expect(
      runtime.openPanel("panels/new", { slug: "new", focus: false }),
    ).resolves.toMatchObject({
      id: "panel:tree/new",
      source: "panels/new",
    });

    const methods = call.mock.calls.map((entry) => entry[1]);
    expect(methods).toEqual(
      expect.arrayContaining([
        "runtime.reserveEntity",
        "workspace-state.slot.create",
        "runtime.activateReservedEntity",
        "panelRuntime.observeSlot",
      ]),
    );
    expect(methods).not.toContain("panelTree.create");
    expect(methods).not.toContain("panelTree.observe");
  });

  it("reserves a panel from an exact sealed artifact when requested", async () => {
    const { runtime, call } = runtimeHarness();
    const artifact = {
      buildKey: "build-test-panel",
      executionDigest: "a".repeat(64),
    };

    await runtime.openPanel("panels/new", {
      operationId: "exact-test-panel",
      artifact,
      focus: false,
    });

    expect(call).toHaveBeenCalledWith("main", "runtime.reserveEntity", [
      expect.objectContaining({
        execution: {
          surface: "code",
          source: "panels/new",
          artifact,
        },
      }),
    ]);
    expect(call).toHaveBeenCalledWith("main", "workspace-state.slot.create", [
      expect.objectContaining({
        initialEntry: expect.objectContaining({
          options: expect.objectContaining({ artifact }),
        }),
      }),
    ]);
  });

  it("reports an unassigned presentation as explicit pending state", async () => {
    const { runtime } = runtimeHarness({ hostAvailable: false });

    await expect(
      runtime.getPanelHandle("panel:tree/new").observe(),
    ).resolves.toMatchObject({
      phase: "pending",
      runtimeEntityId: "panel:nav-new",
    });
  });

  it("rejects a readiness request immediately when no inspection host is available", async () => {
    const { runtime } = runtimeHarness({ hostAvailable: false });

    await expect(
      runtime.openPanel("panels/new", { slug: "new", focus: false }),
    ).rejects.toMatchObject({
      failure: { code: "host_unavailable", stage: "host" },
    });
  });

  it("identifies the committed panel when readiness observation fails", async () => {
    const { runtime } = runtimeHarness({
      observeError: new Error("invalid observation"),
    });

    await expect(
      runtime.openPanel("panels/new", { slug: "new", focus: false }),
    ).rejects.toMatchObject({
      code: "PANEL_OPERATION_FAILED",
      failure: {
        code: "unknown_failure",
        stage: "runtime",
        provenance: {
          panelId: "panel:tree/new",
          runtimeEntityId: "panel:nav-new",
          source: "panels/new",
        },
        details: { slotCommitted: true },
      },
    });
  });

  it("focuses an opened panel through one readiness observation", async () => {
    const { runtime, focusPanel, call } = runtimeFocusHarness();

    await expect(
      runtime.openPanel("panels/new", { slug: "new" }),
    ).resolves.toMatchObject({
      id: "panel:tree/new",
    });

    expect(focusPanel).toHaveBeenCalledOnce();
    expect(focusPanel).toHaveBeenCalledWith("panel:tree/new", {});
    expect(
      call.mock.calls.filter(
        (entry) => entry[1] === "panelRuntime.observeSlot",
      ),
    ).toHaveLength(1);
  });

  it("routes exposed panel calls through the ready presentation target", async () => {
    const { runtime, call } = runtimeHarness();
    const panel = await runtime.openPanel("panels/new", {
      operationId: "run-tests",
    });

    await expect(panel.call["tests.run"]!({})).resolves.toEqual({
      target: "panel:nav-new",
    });
    expect(
      call.mock.calls.filter((entry) => entry[1] === "panelRuntime.ensureSlot"),
    ).toHaveLength(2);
  });

  it("returns a committed slot receipt without observing application readiness", async () => {
    const { runtime, call } = runtimeHarness({
      observeError: new Error("invalid observation"),
    });

    await expect(
      runtime.createPanelSlot("panels/new", { slug: "new" }),
    ).resolves.toMatchObject({
      id: "panel:tree/new",
      source: "panels/new",
    });
    expect(call.mock.calls.map((entry) => entry[1])).not.toContain(
      "panelRuntime.observeSlot",
    );
  });

  it("reuses the exact slot and entity identity for one logical open operation", async () => {
    const { runtime, call } = runtimeHarness();

    const first = await runtime.createPanelSlot("panels/new", {
      contextId: "feature",
      operationId: "invocation:open-taskflow",
    });
    const second = await runtime.createPanelSlot("panels/new", {
      contextId: "feature",
      operationId: "invocation:open-taskflow",
    });

    expect(second.id).toBe(first.id);
    const reservations = call.mock.calls
      .filter((entry) => entry[1] === "runtime.reserveEntity")
      .map((entry) => entry[2][0] as { key: string });
    expect(reservations).toHaveLength(2);
    expect(reservations[1]?.key).toBe(reservations[0]?.key);
    expect(call).toHaveBeenCalledWith("main", "build.getPanelMetadata", [
      "panels/new",
      "ctx:feature",
    ]);
  });

  it("scopes operation identity by source, explicit context, and parent", async () => {
    const { runtime, call } = runtimeHarness();

    const first = await runtime.createPanelSlot("panels/new", {
      operationId: "invocation:shared",
      contextId: "ctx-a",
      parentId: null,
    });
    const otherSource = await runtime.createPanelSlot("panels/other", {
      operationId: "invocation:shared",
      contextId: "ctx-a",
      parentId: null,
    });
    const otherContext = await runtime.createPanelSlot("panels/new", {
      operationId: "invocation:shared",
      contextId: "ctx-b",
      parentId: null,
    });
    const otherRef = await runtime.createPanelSlot("panels/new", {
      operationId: "invocation:shared",
      contextId: "ctx-a",
      parentId: null,
      ref: "feature",
    });

    expect(
      new Set([first.id, otherSource.id, otherContext.id, otherRef.id]).size,
    ).toBe(4);
    const keys = call.mock.calls
      .filter((entry) => entry[1] === "runtime.reserveEntity")
      .map((entry) => (entry[2][0] as { key: string }).key);
    expect(new Set(keys).size).toBe(4);
  });

  it("rejects competing stable identity mechanisms", async () => {
    const { runtime } = runtimeHarness();
    await expect(
      runtime.createPanelSlot("panels/new", {
        slug: "stable",
        operationId: "invocation:stable",
      }),
    ).rejects.toThrow(/either slug or operationId/);
  });

  it("rejects malformed placement before creating runtime or workspace state", async () => {
    const { runtime, call } = runtimeHarness();

    await expect(
      runtime.openPanel("https://example.com/", {
        placement: "replace" as never,
      }),
    ).rejects.toThrow(/placement must be an object/);
    expect(call).not.toHaveBeenCalled();
  });

  it("persists only the canonical placement fields", async () => {
    const { runtime, call } = runtimeHarness();

    await runtime.createPanelSlot("panels/new", {
      slug: "new",
      placement: {
        disposition: "side",
        preferredWidth: 640,
        ignored: true,
      } as never,
    });

    const createCall = call.mock.calls.find(
      (entry) => entry[1] === "workspace-state.slot.create",
    );
    expect(createCall?.[2][0]).toMatchObject({
      initialEntry: {
        options: {
          placement: { disposition: "side", preferredWidth: 640 },
        },
      },
    });
  });

  it("never retires a reservation when slot creation has an ambiguous failure", async () => {
    const { runtime, call } = runtimeHarness({
      slotCreateError: new Error("transport closed after dispatch"),
    });

    await expect(
      runtime.createPanelSlot("panels/new", {
        operationId: "invocation:ambiguous",
      }),
    ).rejects.toThrow(/transport closed after dispatch/);
    expect(call.mock.calls.map((entry) => entry[1])).not.toContain(
      "runtime.retireEntity",
    );
  });

  it("waits on lifecycle state without a fixed readiness deadline and supports explicit cancellation", async () => {
    const { runtime } = runtimeHarness({ alwaysLoading: true });
    const controller = new AbortController();
    const opening = runtime.openPanel("panels/new", {
      slug: "new",
      focus: false,
      signal: controller.signal,
    });

    controller.abort(new Error("caller stopped observing"));
    await expect(opening).rejects.toThrow(/caller stopped observing/);
  });

  it("surfaces a stale exact attempt as a typed infrastructure failure", async () => {
    const { runtime } = runtimeHarness({
      alwaysLoading: true,
      unknownAttempt: true,
    });

    await expect(
      runtime.openPanel("panels/new", { slug: "new", focus: false }),
    ).rejects.toMatchObject({
      code: "PANEL_OPERATION_FAILED",
      failure: {
        code: "host_unavailable",
        stage: "runtime",
        details: {
          failureKind: "infrastructure",
          reason: "unknown-attempt",
        },
      },
    });
  });

  it("subscribes once while a host remains loading", async () => {
    const { runtime, call } = runtimeHarness({ alwaysLoading: true });
    const controller = new AbortController();
    const opening = runtime.openPanel("panels/new", {
      slug: "new",
      focus: false,
      signal: controller.signal,
    });

    await vi.waitFor(() => {
      expect(
        call.mock.calls.some(
          (entry) => entry[1] === "panelRuntime.awaitAttempt",
        ),
      ).toBe(true);
    });
    controller.abort(new Error("observation complete"));
    await expect(opening).rejects.toThrow(/observation complete/);
    expect(
      call.mock.calls.filter(
        (entry) => entry[1] === "panelRuntime.observeSlot",
      ),
    ).toHaveLength(1);
    expect(
      call.mock.calls.filter(
        (entry) => entry[1] === "panelRuntime.awaitAttempt",
      ),
    ).toHaveLength(1);
  });

  it("threads explicit cancellation through every readiness-waiting handle operation", async () => {
    const operations = [
      (
        runtime: ReturnType<typeof runtimeHarness>["runtime"],
        signal: AbortSignal,
      ) => runtime.getPanelHandle("panel:tree/new").focus({ signal }),
      (
        runtime: ReturnType<typeof runtimeHarness>["runtime"],
        signal: AbortSignal,
      ) => runtime.getPanelHandle("panel:tree/new").reload({ signal }),
      (
        runtime: ReturnType<typeof runtimeHarness>["runtime"],
        signal: AbortSignal,
      ) => runtime.getPanelHandle("panel:tree/new").snapshot({ signal }),
      (
        runtime: ReturnType<typeof runtimeHarness>["runtime"],
        signal: AbortSignal,
      ) =>
        runtime
          .getPanelHandle("panel:tree/new")
          .navigate("panels/next", { signal }),
      (
        runtime: ReturnType<typeof runtimeHarness>["runtime"],
        signal: AbortSignal,
      ) => runtime.getPanelHandle("panel:tree/new").rebuild({ signal }),
    ];

    for (const operation of operations) {
      const { runtime } = runtimeHarness({ alwaysLoading: true });
      const controller = new AbortController();
      controller.abort(new Error("caller stopped waiting"));
      await expect(operation(runtime, controller.signal)).rejects.toThrow(
        /caller stopped waiting/,
      );
    }
  });

  it("resolves one proven slot replacement between readiness and snapshot invocation", async () => {
    const { runtime, call } = runtimeHarness({
      replaceEntityOnAgentFailure: true,
    });

    await expect(
      runtime.getPanelHandle("panel:tree/new").snapshot(),
    ).resolves.toMatchObject({
      panelId: "panel:tree/new",
      runtimeEntityId: "panel:nav-replacement",
      document: { text: "snapshot:panel:nav-replacement" },
    });

    const snapshotTargets = call.mock.calls
      .filter((entry) => entry[1] === "_agent.snapshot")
      .map((entry) => entry[0]);
    expect(snapshotTargets).toEqual(["panel:nav-new", "panel:nav-replacement"]);
  });

  it("actively rematerializes a durable slot when its ready route stops", async () => {
    const { runtime, call } = runtimeHarness({ recoverStoppedRoute: true });

    await expect(
      runtime.getPanelHandle("panel:tree/new").snapshot(),
    ).resolves.toMatchObject({
      panelId: "panel:tree/new",
      runtimeEntityId: "panel:nav-replacement",
      document: { text: "snapshot:panel:nav-replacement" },
    });
    expect(
      call.mock.calls.filter((entry) => entry[1] === "panelRuntime.ensureSlot"),
    ).toHaveLength(2);
  });

  it("returns structured lifecycle evidence when the same ready runtime route is absent", async () => {
    const { runtime, call } = runtimeHarness({ disconnectAgentTarget: true });

    await expect(
      runtime.getPanelHandle("panel:tree/new").snapshot(),
    ).rejects.toMatchObject({
      code: "PANEL_OPERATION_FAILED",
      failure: {
        code: "host_unavailable",
        stage: "runtime",
        provenance: {
          panelId: "panel:tree/new",
          runtimeEntityId: "panel:nav-new",
          attemptId: "attempt:panel:nav-new",
        },
        details: {
          routeFailureCode: "TARGET_NOT_REACHABLE",
          expectedRuntimeEntityId: "panel:nav-new",
          currentRuntimeEntityId: "panel:nav-new",
          recovery: "not-attempted-same-runtime",
        },
      },
    });
    expect(
      call.mock.calls.filter((entry) => entry[1] === "_agent.snapshot"),
    ).toHaveLength(1);
  });

  it("applies the same proven replacement rule to ordinary panel agent calls", async () => {
    const { runtime, call } = runtimeHarness({
      replaceEntityOnAgentFailure: true,
    });

    await expect(
      runtime.getPanelHandle("panel:tree/new").tree(),
    ).resolves.toEqual({
      target: "panel:nav-replacement",
    });
    expect(
      call.mock.calls
        .filter((entry) => entry[1] === "_agent.tree")
        .map((entry) => entry[0]),
    ).toEqual(["panel:nav-new", "panel:nav-replacement"]);
  });

  it("returns a code slot at durable commit without waiting for activation", async () => {
    const onCreateSlotTiming = vi.fn();
    const { runtime, call } = runtimeHarness({ onCreateSlotTiming });

    await runtime.createPanelSlot("panels/new", { slug: "new" });

    const methods = call.mock.calls.map((entry) => entry[1]);
    expect(methods.indexOf("runtime.reserveEntity")).toBeLessThan(
      methods.indexOf("workspace-state.slot.create"),
    );
    expect(methods).not.toContain("runtime.activateReservedEntity");
    expect(onCreateSlotTiming.mock.calls.map(([event]) => event.stage)).toEqual(
      ["runtime.reserveEntity", "workspace-state.slot.create", "panel.index"],
    );
  });

  it("does not make background activation failure part of the slot receipt", async () => {
    const { runtime, call } = runtimeHarness({
      activateError: new Error("build unavailable"),
    });

    await expect(
      runtime.createPanelSlot("panels/new", { slug: "new" }),
    ).resolves.toMatchObject({
      id: "panel:tree/new",
      kind: "workspace",
    });

    const methods = call.mock.calls.map((entry) => entry[1]);
    expect(methods).not.toContain("runtime.activateReservedEntity");
    expect(methods).not.toContain("runtime.retireEntity");
  });

  it("joins activation for boot-ready open and preserves the committed slot on failure", async () => {
    const { runtime, call } = runtimeHarness({
      activateError: new Error("build unavailable"),
    });

    await expect(
      runtime.openPanel("panels/new", { slug: "new" }),
    ).rejects.toMatchObject({
      code: "PANEL_OPERATION_FAILED",
      failure: {
        stage: "runtime",
        details: { slotCommitted: true },
      },
    });

    const methods = call.mock.calls.map((entry) => entry[1]);
    expect(methods).toContain("runtime.activateReservedEntity");
    expect(methods).not.toContain("runtime.retireEntity");
  });

  it("registers the panel principal before assigning a presentation host", async () => {
    const { runtime, call } = runtimeHarness();

    await runtime.openPanel("panels/new", { slug: "new", focus: false });

    const methods = call.mock.calls.map((entry) => entry[1]);
    expect(methods.indexOf("runtime.activateReservedEntity")).toBeLessThan(
      methods.indexOf("panelRuntime.ensureSlot"),
    );
  });

  it("creates a deferred external browser slot without waiting for navigation", async () => {
    const { runtime, call } = runtimeHarness({
      observeError: new Error("navigation pending"),
    });

    await expect(
      runtime.createPanelSlot("https://example.com/"),
    ).resolves.toMatchObject({
      kind: "browser",
      source: "https://example.com/",
    });
    expect(call.mock.calls.map((entry) => entry[1])).not.toContain(
      "panelRuntime.observeSlot",
    );
    expect(call).toHaveBeenCalledWith("main", "workspace-state.panel.index", [
      {
        id: expect.any(String),
        title: "example.com",
        path: "browser:https://example.com/",
      },
    ]);
    expect(call.mock.calls.map((entry) => entry[1])).not.toContain(
      "workers.resolveService",
    );
  });

  it("reports each durable external-slot creation stage", async () => {
    const onCreateSlotTiming = vi.fn();
    const { runtime } = runtimeHarness({ onCreateSlotTiming });

    await runtime.createPanelSlot("https://example.com/");

    expect(onCreateSlotTiming.mock.calls.map(([event]) => event.stage)).toEqual(
      ["runtime.createEntity", "workspace-state.slot.create", "panel.index"],
    );
    expect(
      onCreateSlotTiming.mock.calls.every(([event]) => event.outcome === "ok"),
    ).toBe(true);
  });

  it("treats a loaded external browser document as ready without managed boot", async () => {
    const { runtime } = runtimeHarness({ browserReady: true });

    const handle = await runtime.openPanel("data:text/html,<p>ready</p>", {
      focus: false,
    });

    expect(handle.kind).toBe("browser");
    await expect(handle.observe()).resolves.toMatchObject({
      kind: "browser",
      phase: "ready",
      host: {
        view: { exists: true, loading: false },
        boot: { kind: "observed" as const, observation: { phase: "ready" } },
      },
    });
  });

  it("does not treat a pre-navigation browser view as ready", async () => {
    const { runtime } = runtimeHarness({
      browserReady: true,
      browserUrl: "about:blank",
    });

    await expect(
      runtime.getPanelHandle("panel:tree/new").observe(),
    ).resolves.toMatchObject({
      kind: "browser",
      phase: "pending",
      host: { view: { url: "about:blank", loading: false } },
    });
  });

  it("accepts a same-site browser redirect as the requested document", async () => {
    const { runtime } = runtimeHarness({
      browserReady: true,
      browserSource: "browser:http://example.com/start",
      browserUrl: "https://example.com/login",
    });

    await expect(
      runtime.getPanelHandle("panel:tree/new").observe(),
    ).resolves.toMatchObject({
      kind: "browser",
      phase: "ready",
      host: { view: { url: "https://example.com/login", loading: false } },
    });
  });

  it("does not route server-side focus through the desktop-only view service", async () => {
    const { runtime, call } = runtimeHarness();

    await expect(
      runtime.getPanelHandle("panel:tree/new").focus(),
    ).resolves.toMatchObject({
      phase: "ready",
      host: { view: { url: "http://panel.test/" } },
    });
    expect(call.mock.calls.map((entry) => entry[1])).not.toContain(
      "view.focusPanel",
    );
    expect(call.mock.calls.map((entry) => entry[1])).toContain(
      "panelRuntime.ensureSlot",
    );
  });

  it("re-materializes a panel after an explicit unload", async () => {
    const { runtime, call } = runtimeHarness();
    const handle = runtime.getPanelHandle("panel:tree/new");

    await handle.focus();
    await handle.unload();
    await handle.focus();

    expect(
      call.mock.calls.filter((entry) => entry[1] === "panelRuntime.ensureSlot"),
    ).toHaveLength(2);
  });

  it("delegates focus to a native presentation host when one is available", async () => {
    const { runtime, focusPanel } = runtimeFocusHarness();

    await runtime
      .getPanelHandle("panel:tree/new")
      .focus({ anchorPanelId: "panel:tree/root" });
    expect(focusPanel).toHaveBeenCalledWith("panel:tree/new", {
      anchorPanelId: "panel:tree/root",
    });
  });

  it("navigates through runtime creation and one durable semantic commit", async () => {
    const { runtime, call } = runtimeHarness();

    await expect(
      runtime.panelTree.get("panel:tree/new").navigate("panels/next", {
        contextId: "ctx:test",
      }),
    ).resolves.toMatchObject({ panelId: "panel:tree/new", phase: "ready" });

    const methods = call.mock.calls.map((entry) => entry[1]);
    expect(methods).toEqual(
      expect.arrayContaining([
        "runtime.createEntity",
        "workspace-state.slot.commitPreparedNavigation",
      ]),
    );
    expect(methods).not.toContain("panelTree.navigate");
  });

  it("hydrates bounded builtin pages and paths with live handles", async () => {
    const { runtime } = runtimeHarness();

    const page = await runtime.panelTree.page({
      group: { kind: "children", parentSlotId: "group" },
      limit: 50,
    });
    expect(page).toMatchObject({
      revision: 17,
      entries: [
        { handle: { id: "browser", kind: "browser", parentId: "group" } },
      ],
    });
    await expect(
      runtime.panelTree.path("panel:tree/root"),
    ).resolves.toMatchObject({
      revision: 17,
      entries: [{ handle: { id: "root" } }],
    });
  });

  it("reads the current caller's roots without exposing an ownership key", async () => {
    const { runtime, call } = runtimeHarness();

    await expect(runtime.panelTree.roots({ limit: 25 })).resolves.toMatchObject(
      {
        group: { kind: "roots", ownerUserId: "usr-current" },
        entries: [{ handle: { id: "current-root" } }],
      },
    );
    expect(call).toHaveBeenCalledWith(
      "main",
      "workspace-state.panelTree.rootsForCaller",
      [{ limit: 25 }],
    );

    await runtime.panelTree.rootsForOwner("usr-other", { limit: 10 });
    expect(call).toHaveBeenCalledWith(
      "main",
      "workspace-state.panelTree.page",
      [{ group: { kind: "roots", ownerUserId: "usr-other" }, limit: 10 }],
    );
  });

  it("reads bounded durable source usage through the panel tree", async () => {
    const { runtime, call } = runtimeHarness();

    await expect(runtime.panelTree.sourceUsage(25)).resolves.toEqual([
      { source: "panels/terminal", accessCount: 12, lastAccessedAt: 1234 },
    ]);
    expect(call).toHaveBeenCalledWith(
      "main",
      "workspace-state.panel.sourceUsage",
      [25],
    );
  });

  it("renames an arbitrary slot directly on the builtin topology owner", async () => {
    const { runtime, call } = runtimeHarness();
    const handle = runtime.panelTree.get("panel:tree/browser", "browser");

    await handle.setTitle("Support inbox", { explicit: true });

    expect(call).toHaveBeenCalledWith(
      "main",
      "workspace-state.panel.updateTitle",
      ["panel:tree/browser", "Support inbox", { explicit: true }],
    );
    expect(handle.title).toBe("Support inbox");
  });
});
