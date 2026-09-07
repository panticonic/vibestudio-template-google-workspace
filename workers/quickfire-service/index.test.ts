import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { QuickfireSessionsDO } from "./index.js";

class TestQuickfireSessionsDO extends QuickfireSessionsDO {
  readonly calls: Array<{ target: string; method: string; args: unknown[] }> =
    [];

  protected override get rpc(): never {
    return {
      call: async (target: string, method: string, args: unknown[]) => {
        this.calls.push({ target, method, args });
        if (method === "workspace-state.panelTree.detail") {
          return {
            slot: {
              parent_slot_id: "slot-root",
              current_entity_title: "Build log",
            },
            currentHistory: {
              context_id: "ctx-panel",
              source: "panels/build-log",
            },
          };
        }
        if (method === "workspace-state.entity.resolveActive")
          return { status: "active" };
        if (method === "runtime.createEntity") {
          const spec = args[0] as {
            className?: string;
            key?: string;
            contextId?: string;
            resourceBindings?: unknown[];
          };
          if (spec.className === "AiChatWorker") {
            return {
              id: `do:workers/agent-worker:AiChatWorker:${spec.key}`,
              targetId: `do:workers/agent-worker:AiChatWorker:${spec.key}`,
              contextId: spec.resourceBindings ? "ctx-panel" : spec.contextId,
            };
          }
          return {
            id: "channel-entity",
            targetId: "channel-target",
            contextId: spec.resourceBindings ? "ctx-panel" : spec.contextId,
          };
        }
        if (method === "subscribeChannel")
          return { ok: true, participantId: "agent:quickfire" };
        if (method === "getReplayAfter")
          return { ready: { snapshotLastSeq: 0 } };
        if (
          method === "runtime.replaceResourceBindings" ||
          method === "runtime.releaseResourceBindings" ||
          method === "runtime.retireEntity" ||
          method === "interruptChannel" ||
          method === "unsubscribeChannel"
        ) {
          return undefined;
        }
        throw new Error(`unexpected rpc ${target}.${method}`);
      },
    } as never;
  }
}

describe("QuickfireSessionsDO", () => {
  it("launches an ordinary AI chat agent with declarative prompt, tools, and panel binding", async () => {
    const { instance } = await createTestDO(TestQuickfireSessionsDO);
    const session = await instance.sessionFor({ slotId: "slot-a" });
    const create = instance.calls.find(
      ({ method, args }) =>
        method === "runtime.createEntity" &&
        (args[0] as { className?: string }).className === "AiChatWorker",
    );
    const spec = create?.args[0] as {
      stateArgs: { agentConfig: Record<string, unknown> };
      resourceBindings: unknown[];
    };
    const channelCreate = instance.calls.find(
      ({ method, args }) =>
        method === "runtime.createEntity" &&
        (args[0] as { className?: string }).className === "PubSubChannel",
    );

    expect(session).toMatchObject({
      slotId: "slot-a",
      contextId: "ctx-panel",
      state: "fresh",
    });
    expect(spec.stateArgs.agentConfig).toMatchObject({
      model: "openai-codex:gpt-5.6-luna",
      thinkingLevel: "high",
      systemPromptMode: "append",
      features: {
        resources: { subject: { kind: "panel-slot", id: "slot-a" } },
        tools: expect.arrayContaining([{ kind: "standard" }]),
      },
    });
    expect(spec.stateArgs.agentConfig["systemPrompt"]).toContain(
      "<initial-panel-context>",
    );
    expect(spec.stateArgs.agentConfig["systemPrompt"]).toContain(
      "title: Build log",
    );
    expect(spec.stateArgs.agentConfig).not.toHaveProperty("approvalLevel");
    expect(spec.resourceBindings).toEqual([
      {
        resource: { kind: "panel-slot", id: "slot-a" },
        capabilities: ["panel.inspect"],
        scope: { kind: "agent-channel", channelId: session.channelId },
      },
      {
        resource: { kind: "workspace-diagnostics", id: "server-logs" },
        capabilities: ["server-logs.read"],
        scope: { kind: "agent-channel", channelId: session.channelId },
      },
    ]);
    expect(channelCreate?.args[0]).toMatchObject({
      resourceBindings: [
        {
          resource: { kind: "panel-slot", id: "slot-a" },
          capabilities: [],
          scope: { kind: "entity" },
        },
      ],
    });
    expect(channelCreate?.args[0]).not.toHaveProperty("contextId");
    expect(create?.args[0]).not.toHaveProperty("contextId");
  });

  it("resumes the durable session without launching a second agent", async () => {
    const { instance } = await createTestDO(TestQuickfireSessionsDO);
    const first = await instance.sessionFor({ slotId: "slot-a" });
    const resumed = await instance.sessionFor({ slotId: "slot-a" });

    expect(resumed).toMatchObject({
      channelId: first.channelId,
      state: "resumed",
    });
    expect(
      instance.calls.filter(
        ({ method, args }) =>
          method === "runtime.createEntity" &&
          (args[0] as { className?: string }).className === "AiChatWorker",
      ),
    ).toHaveLength(1);
    expect(instance.calls).toContainEqual({
      target: "main",
      method: "runtime.replaceResourceBindings",
      args: [
        {
          id: resumed.agentEntityId,
          bindings: [
            {
              resource: { kind: "panel-slot", id: "slot-a" },
              capabilities: ["panel.inspect"],
              scope: { kind: "agent-channel", channelId: first.channelId },
            },
            {
              resource: { kind: "workspace-diagnostics", id: "server-logs" },
              capabilities: ["server-logs.read"],
              scope: { kind: "agent-channel", channelId: first.channelId },
            },
          ],
        },
      ],
    });
  });

  it("promotion detaches the panel relationship and keeps the same ordinary agent/channel", async () => {
    const { instance } = await createTestDO(TestQuickfireSessionsDO);
    const session = await instance.sessionFor({ slotId: "slot-a" });
    const promoted = await instance.promote({ slotId: "slot-a" });

    expect(promoted).toMatchObject({
      channelId: session.channelId,
      state: "promoted",
    });
    expect(instance.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "main",
          method: "runtime.releaseResourceBindings",
          args: [{ id: session.agentEntityId }],
        }),
        expect.objectContaining({
          target: "main",
          method: "runtime.releaseResourceBindings",
          args: [
            {
              id: `do:workers/pubsub-channel:PubSubChannel:${session.channelId}`,
            },
          ],
        }),
      ]),
    );
    expect(
      instance.calls.filter(({ method }) => method === "subscribeChannel"),
    ).toHaveLength(1);
    expect(
      instance.calls.some(({ method }) => method === "runtime.retireEntity"),
    ).toBe(false);
  });

  it("clear retires an unpromoted agent", async () => {
    const { instance } = await createTestDO(TestQuickfireSessionsDO);
    const session = await instance.sessionFor({ slotId: "slot-a" });

    await expect(instance.clear({ slotId: "slot-a" })).resolves.toEqual({
      cleared: true,
    });
    expect(instance.calls).toContainEqual({
      target: "main",
      method: "runtime.retireEntity",
      args: [{ id: session.agentEntityId, removeContext: false }],
    });
    expect(instance.calls).toContainEqual({
      target: "main",
      method: "runtime.retireEntity",
      args: [
        {
          id: `do:workers/pubsub-channel:PubSubChannel:${session.channelId}`,
          removeContext: false,
        },
      ],
    });
  });

  it("starting fresh after promotion never retires the transferred agent", async () => {
    const { instance } = await createTestDO(TestQuickfireSessionsDO);
    const original = await instance.sessionFor({ slotId: "slot-a" });
    await instance.promote({ slotId: "slot-a" });
    const fresh = await instance.sessionFor({ slotId: "slot-a", fresh: true });

    expect(fresh.channelId).not.toBe(original.channelId);
    expect(
      instance.calls.some(
        ({ method, args }) =>
          method === "runtime.retireEntity" &&
          (args[0] as { id?: string }).id === original.agentEntityId,
      ),
    ).toBe(false);
  });
});
