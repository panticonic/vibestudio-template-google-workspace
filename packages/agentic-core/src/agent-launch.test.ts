import { describe, expect, it, vi } from "vitest";
import { CreateEntitySpecSchema } from "@vibestudio/service-schemas/runtime";
import {
  buildAgentEntityCreateSpec,
  buildAgentTaskSeedEvent,
  createSubagentContext,
  initAgentFromTrajectoryFork,
  launchAgentIntoChannel,
  publishAgentTaskSeed,
  subscribeAgentToChannel,
  unsubscribeAgentFromChannel,
} from "./agent-launch.js";
import type { AgentLaunchRpc } from "./agent-launch.js";

function makeRpc(
  impl?: (target: string, method: string, args: unknown[]) => Promise<unknown>
): AgentLaunchRpc & { call: ReturnType<typeof vi.fn> } {
  const rpc = {
    call: vi.fn(async (target: string, method: string, args: unknown[]) => {
      if (impl) return impl(target, method, args);
      if (target === "main" && method === "runtime.createEntity") {
        const spec = args[0] as { contextId?: string };
        return { id: "entity-1", targetId: "target-1", contextId: spec.contextId ?? "ctx-minted" };
      }
      return { ok: true, participantId: "participant-1" };
    }),
  };
  return rpc as unknown as AgentLaunchRpc & { call: typeof rpc.call };
}

describe("agent launch primitive", () => {
  it("builds a DO create spec with full per-agent config in stateArgs", () => {
    expect(
      buildAgentEntityCreateSpec({
        source: "workers/agent-worker",
        className: "AiChatWorker",
        key: "agent-1",
        contextId: "ctx-1",
        config: {
          model: "openai:gpt-5.3",
          approvalLevel: 2,
          handle: "agent",
        },
        stateArgs: { subagent: { runId: "run-1" } },
      })
    ).toEqual({
      kind: "do",
      execution: {
        surface: "code",
        source: "workers/agent-worker",
      },
      className: "AiChatWorker",
      key: "agent-1",
      contextId: "ctx-1",
      stateArgs: {
        subagent: { runId: "run-1" },
        agentConfig: {
          model: "openai:gpt-5.3",
          approvalLevel: 2,
          handle: "agent",
        },
      },
    });
  });

  it("builds an agent entity request accepted by the runtime wire schema", () => {
    const spec = buildAgentEntityCreateSpec({
      source: "workers/agent-worker",
      ref: "ctx:ctx-1",
      className: "AiChatWorker",
      key: "agent-1",
      contextId: "ctx-1",
      config: { model: "openai:gpt-5.3" },
      agentChannelId: "chat-1",
    });

    expect(CreateEntitySpecSchema.parse(spec)).toEqual(spec);
  });

  it("launches by creating before subscribing, stripping behavior settings from subscription config", async () => {
    const rpc = makeRpc();

    const out = await launchAgentIntoChannel(rpc, {
      source: "workers/agent-worker",
      className: "AiChatWorker",
      key: "agent-1",
      channelId: "ch-1",
      contextId: "ctx-1",
      config: {
        model: "openai:gpt-5.3",
        approvalLevel: 1,
        handle: "agent",
        systemPrompt: "be direct",
        deterministicResponse: true,
      },
      replay: true,
    });

    expect(out).toMatchObject({
      handle: { id: "entity-1", targetId: "target-1" },
      subscription: { ok: true, participantId: "participant-1" },
      contextId: "ctx-1",
    });
    expect(rpc.call).toHaveBeenNthCalledWith(1, "main", "runtime.createEntity", [
      expect.objectContaining({
        agentChannelId: "ch-1",
        stateArgs: expect.objectContaining({
          agentConfig: expect.objectContaining({
            model: "openai:gpt-5.3",
            approvalLevel: 1,
          }),
        }),
      }),
    ]);
    expect(rpc.call).toHaveBeenNthCalledWith(2, "target-1", "subscribeChannel", [
      {
        channelId: "ch-1",
        contextId: "ctx-1",
        config: {
          handle: "agent",
          systemPrompt: "be direct",
          deterministicResponse: true,
        },
        replay: true,
      },
    ]);
  });

  it("keeps an external relay binding disjoint from self-agent channel identity", async () => {
    const rpc = makeRpc();

    await launchAgentIntoChannel(rpc, {
      source: "workers/linked-agent",
      className: "LinkedAgentVessel",
      key: "linked:session-1",
      channelId: "ch-1",
      contextId: "ctx-1",
      agentBinding: { entityId: "session-1", channelId: "ch-1" },
    });

    expect(rpc.call).toHaveBeenNthCalledWith(1, "main", "runtime.createEntity", [
      expect.objectContaining({
        agentBinding: { entityId: "session-1", channelId: "ch-1" },
      }),
    ]);
    const spec = (rpc.call.mock.calls[0]?.[2] as Array<Record<string, unknown>>)[0]!;
    expect(spec).not.toHaveProperty("agentChannelId");
    expect(rpc.call).toHaveBeenNthCalledWith(2, "target-1", "subscribeChannel", [
      expect.objectContaining({
        channelId: "ch-1",
        contextId: "ctx-1",
      }),
    ]);
  });

  it("retires an isolated entity when subscribe fails after creation", async () => {
    const rpc = makeRpc(async (_target, method) => {
      if (method === "runtime.createEntity") {
        return { id: "entity-1", targetId: "target-1", contextId: "ctx-1" };
      }
      if (method === "subscribeChannel") throw new Error("subscribe failed");
      return undefined;
    });

    await expect(
      launchAgentIntoChannel(rpc, {
        source: "workers/agent-worker",
        className: "AiChatWorker",
        key: "agent-1",
        channelId: "ch-1",
        retireEntityOnSubscribeFailure: true,
      })
    ).rejects.toThrow("subscribe failed");

    expect(rpc.call).toHaveBeenLastCalledWith("main", "runtime.retireEntity", [{ id: "entity-1" }]);
  });

  it("refuses to subscribe an existing active agent into a different channel context", async () => {
    const rpc = makeRpc(async (_target, method) => {
      if (method === "runtime.createEntity") {
        return { id: "entity-1", targetId: "target-1", contextId: "ctx-original" };
      }
      return { ok: true, participantId: "participant-1" };
    });

    await expect(
      launchAgentIntoChannel(rpc, {
        source: "workers/agent-worker",
        className: "AiChatWorker",
        key: "agent-1",
        channelId: "ch-fork",
        contextId: "ctx-fork",
      })
    ).rejects.toThrow(/existing agent entity-1 in context ctx-original.*channel ch-fork.*ctx-fork/);

    expect(rpc.call).toHaveBeenCalledTimes(1);
  });

  it("initializes trajectory forks through the same stripped subscription config contract", async () => {
    const rpc = makeRpc();

    await initAgentFromTrajectoryFork(rpc, "target-1", {
      parentLogId: "log-parent",
      seq: 42,
      taskChannelId: "task-1",
      contextId: "ctx-child",
      config: {
        model: "openai:gpt-5.3",
        handle: "child",
        wakePolicy: "explicit",
      },
    });

    expect(rpc.call).toHaveBeenCalledWith("target-1", "initFromTrajectoryFork", [
      {
        parentLogId: "log-parent",
        seq: 42,
        taskChannelId: "task-1",
        contextId: "ctx-child",
        config: { handle: "child", wakePolicy: "explicit" },
      },
    ]);
  });

  it.each([
    [
      "subscribeChannel",
      () =>
        subscribeAgentToChannel(
          makeRpc(async () => ({ ok: true })),
          "target-1",
          {
            channelId: "ch-1",
            contextId: "ctx-1",
          }
        ),
    ],
    [
      "initFromTrajectoryFork",
      () =>
        initAgentFromTrajectoryFork(
          makeRpc(async () => ({ ok: true, participantId: "" })),
          "target-1",
          {
            parentLogId: "log-parent",
            seq: 42,
            taskChannelId: "task-1",
            contextId: "ctx-child",
          }
        ),
    ],
  ])("rejects %s results without a participant identity", async (operation, invoke) => {
    await expect(invoke()).rejects.toThrow(`${operation} returned no participant identity`);
  });

  it("unsubscribes through the deterministic target without resolving or reactivating it", async () => {
    const rpc = makeRpc();

    await expect(
      unsubscribeAgentFromChannel(rpc, {
        source: "workers/agent-worker",
        className: "AiChatWorker",
        key: "agent-1",
        channelId: "ch-1",
      })
    ).resolves.toEqual({ ok: true, participantId: "participant-1" });

    expect(rpc.call).toHaveBeenCalledOnce();
    expect(rpc.call).toHaveBeenCalledWith(
      "do:workers/agent-worker:AiChatWorker:agent-1",
      "unsubscribeChannel",
      ["ch-1"]
    );
    expect(rpc.call).not.toHaveBeenCalledWith(
      "main",
      "workers.resolveDurableObject",
      expect.anything()
    );
  });

  it("creates subagent contexts through runtime.createSubagentContext", async () => {
    const rpc = makeRpc(async () => ({ contextId: "ctx-child" }));

    await expect(
      createSubagentContext(rpc, {
        parentContextId: "ctx-parent",
        ownerEntityId: "do:agent:parent",
        targetKey: "subagent:run-1",
      })
    ).resolves.toEqual({ contextId: "ctx-child" });

    expect(rpc.call).toHaveBeenCalledWith("main", "runtime.createSubagentContext", [
      {
        parentContextId: "ctx-parent",
        ownerEntityId: "do:agent:parent",
        targetKey: "subagent:run-1",
      },
    ]);
  });

  it("builds and publishes addressed user-style task seeds", async () => {
    const event = buildAgentTaskSeedEvent({
      senderParticipantId: "parent-participant",
      childParticipantId: "child-participant",
      messageId: "subagent-seed:run-1",
      task: "audit this",
      senderMetadata: { type: "headless", name: "Subagent task" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(event).toMatchObject({
      kind: "message.completed",
      actor: { kind: "user", id: "parent-participant", displayName: "Subagent task" },
      payload: {
        role: "user",
        blocks: [{ type: "text", content: "audit this" }],
        to: [{ kind: "participant", participantId: "child-participant" }],
        metadata: { origin: "agent-initiated" },
      },
    });

    const channel = {
      publishAgenticEvent: vi.fn(async () => ({ id: 7 })),
    };
    await expect(
      publishAgentTaskSeed(channel, {
        senderParticipantId: "parent-participant",
        childParticipantId: "child-participant",
        messageId: "subagent-seed:run-1",
        task: "audit this",
        senderMetadata: { type: "headless", name: "Subagent task" },
        createdAt: "2026-01-01T00:00:00.000Z",
      })
    ).resolves.toEqual({ id: 7 });

    expect(channel.publishAgenticEvent).toHaveBeenCalledWith("parent-participant", event, {
      idempotencyKey: "subagent-seed:run-1",
      senderMetadata: { type: "headless", name: "Subagent task" },
    });
  });

  it("refuses to build an unaddressed agent task seed", () => {
    expect(() =>
      buildAgentTaskSeedEvent({
        senderParticipantId: "parent-participant",
        childParticipantId: "",
        messageId: "subagent-seed:run-1",
        task: "audit this",
      })
    ).toThrow("Agent task seed requires a child participant identity");
  });

  it("subscribes a handle target directly", async () => {
    const rpc = makeRpc();

    await subscribeAgentToChannel(
      rpc,
      { targetId: "target-1" },
      {
        channelId: "ch-1",
        contextId: "ctx-1",
        config: { model: "openai:gpt-5.3", handle: "agent" },
      }
    );

    expect(rpc.call).toHaveBeenCalledWith("target-1", "subscribeChannel", [
      {
        channelId: "ch-1",
        contextId: "ctx-1",
        config: { handle: "agent" },
        replay: undefined,
      },
    ]);
  });
});
