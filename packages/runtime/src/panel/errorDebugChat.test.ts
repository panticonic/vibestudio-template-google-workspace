import { beforeEach, describe, expect, it, vi } from "vitest";

function readyObservation(panelId: string, source: string) {
  return {
    panelId,
    title: "Agentic Chat",
    source,
    kind: "workspace" as const,
    parentId: "spectrolite",
    contextId: "ctx-vault",
    requestedRef: "main",
    runtimeEntityId: `panel:${panelId}-entity`,
    attemptId: `panel:${panelId}-entity@build-chat`,
    effectiveVersion: "ev-chat",
    buildKey: "build-chat",
    phase: "ready" as const,
    updatedAt: 1,
  };
}

function readyAttempt(slotId: string, runtimeEntityId: string) {
  return {
    epoch: "test",
    attemptId: `attempt:${runtimeEntityId}`,
    slotId,
    runtimeEntityId,
    phase: "ready" as const,
    revision: 1,
    reporter: "renderer" as const,
    updatedAt: 1,
  };
}

function createRpcCall() {
  let createdTitle = "Agentic Chat";
  const runtimeEntity = {
    id: "panel:nav-debug-chat-entity",
    kind: "panel",
    key: "debug-chat",
    contextId: "ctx-vault",
    source: { effectiveVersion: "ev-chat" },
    buildKey: "build-chat",
  };
  return vi.fn(async (_target: string, method: string, args: unknown[]) => {
    switch (method) {
      case "panelTree.metadata":
        return {
          id: args[0],
          title: "Spectrolite",
          source: "panels/spectrolite",
          kind: "workspace",
          parentId: null,
          contextId: "ctx-vault",
          runtimeEntityId: "panel:spectrolite-entity",
          effectiveVersion: "ev-spectrolite",
        };
      case "panelTree.getStateArgs":
        return {
          repoRoot: "/workspace/docs",
          apiToken: "super-secret-token",
        };
      case "panelCdp.consoleHistory":
        return {
          entries: [
            {
              timestamp: 1,
              level: "error",
              message: "Fetch failed with Bearer abcdefghijklmnop",
              line: 10,
              sourceId: "index.tsx",
              url: "http://localhost/panels/spectrolite",
            },
          ],
          errors: [],
          dropped: { entries: 0, errors: 0 },
          capacity: { entries: 1000, errors: 500 },
        };
      case "panelTree.diagnose":
        return {
          observation: {
            ...readyObservation("spectrolite", "panels/spectrolite"),
            title: "Spectrolite",
            parentId: null,
          },
          consoleHistory: {
            entries: [
              {
                timestamp: 1,
                level: "error",
                message: "Fetch failed with Bearer abcdefghijklmnop",
                line: 10,
                sourceId: "index.tsx",
                url: "http://localhost/panels/spectrolite",
              },
            ],
            errors: [],
            dropped: { entries: 0, errors: 0 },
            capacity: { entries: 1000, errors: 500 },
          },
        };
      case "build.getPanelMetadata":
        return { title: "Agentic Chat", stateArgs: undefined };
      case "workers.resolveService":
        return { kind: "durable-object", targetId: "do:workspace-state" };
      case "titlesForSlots":
        return Object.fromEntries(
          (args[0] as string[]).map((slotId) => [
            slotId,
            slotId === "panel:tree/spectrolite" ? "Spectrolite" : createdTitle,
          ]),
        );
      case "bindSlot":
      case "indexPanel":
      case "incrementAccess":
      case "rebuildIndex":
      case "removeSlots":
        return undefined;
      case "updatePanelTitle":
        createdTitle = String(args[2]);
        return undefined;
      case "runtime.reserveEntity":
      case "runtime.activateReservedEntity":
        return runtimeEntity;
      case "workspace-state.slot.create":
        return undefined;
      case "panelRuntime.ensureSlot":
        return {
          status: "assigned",
          lease: null,
          attempt: readyAttempt(String(args[0]), String(args[1])),
        };
      case "workspace-state.panelTree.detail":
        if (args[0] === "panel:tree/spectrolite") {
          return {
            slot: {
              slot_id: "spectrolite",
              parent_slot_id: null,
            },
            entity: {
              id: "panel:nav-spectrolite-entity",
              source: { effectiveVersion: "ev-spectrolite" },
              activeBuildKey: "build-spectrolite",
            },
            currentHistory: {
              source: "panels/spectrolite",
              context_id: "ctx-vault",
              state_args: JSON.stringify({
                repoRoot: "/workspace/docs",
                apiToken: "super-secret-token",
              }),
              options: null,
            },
          };
        }
        return {
          slot: {
            slot_id: "debug-chat",
            parent_slot_id: "panel:tree/spectrolite",
          },
          entity: {
            id: runtimeEntity.id,
            source: { effectiveVersion: "ev-chat" },
            activeBuildKey: "build-chat",
          },
          currentHistory: {
            source: "panels/chat",
            context_id: "ctx-vault",
            state_args: null,
            options: null,
          },
        };
      case "panelRuntime.observeSlot":
        return {
          version: { epoch: "test", counter: 1 },
          attempt: readyAttempt(String(args[0]), runtimeEntity.id),
          route: {
            reachable: true,
            connectionId: `route:${String(args[0])}`,
            holderLabel: "test",
            platform: "headless",
            supportsCdp: false,
            view: { url: "http://test/panels/chat", loading: false },
          },
        };
      case "panelTree.create":
        return {
          id: "debug-chat",
          title: "Agentic Chat",
          kind: "workspace",
          runtimeEntityId: "panel:debug-chat-entity",
          effectiveVersion: "ev-chat",
          observation: readyObservation("debug-chat", "panels/chat"),
        };
      default:
        return undefined;
    }
  });
}

describe("panel error diagnostic chat launcher", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("opens a child chat with a redacted agent debugging prompt", async () => {
    const rpcCall = createRpcCall();
    const { _initPanelHandleBridge } = await import("./handle.js");
    const { openPanelErrorDiagnosticChat } =
      await import("./errorDebugChat.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never, {
      selfId: "panel:tree/spectrolite",
      selfRpcTargetId: "panel:nav-spectrolite-entity",
    });

    const result = await openPanelErrorDiagnosticChat(
      {
        surfaceName: "Spectrolite panel",
        errorName: "Error",
        errorMessage: "Maximum update depth exceeded",
        componentStack: "at SessionGate",
        locationHref: "http://localhost/panels/spectrolite",
        userAgent: "vitest",
        timestamp: "2026-06-15T00:00:00.000Z",
      },
      { slotId: "panel:tree/spectrolite", contextId: "ctx-fallback" },
    );

    expect(result).toMatchObject({
      panelId: expect.any(String),
      title: "Panel error debug",
    });
    expect(rpcCall).toHaveBeenCalledWith("main", "runtime.reserveEntity", [
      expect.objectContaining({
        kind: "panel",
        execution: { surface: "code", source: "panels/chat" },
        contextId: "ctx-vault",
        stateArgs: expect.objectContaining({
          initialPrompt: expect.stringContaining(
            "Maximum update depth exceeded",
          ),
        }),
      }),
    ]);
    expect(result.prompt).toContain("Inspect the failing panel source");
    expect(result.prompt).toContain("panels/spectrolite");
    expect(result.prompt).toContain('"apiToken": "[redacted]"');
    expect(result.prompt).toContain("Bearer [redacted]");
    expect(result.prompt).not.toContain("super-secret-token");
    expect(result.prompt).not.toContain("abcdefghijklmnop");
  });
});
