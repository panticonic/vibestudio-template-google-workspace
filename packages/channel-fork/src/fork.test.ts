import { describe, it, expect } from "vitest";
import { forkConversation } from "./fork.js";
import type { RpcCaller } from "@vibestudio/rpc";

// The saga itself now lives in the parent channel DO (`PubSubChannel.fork`);
// this package is only the thin client helper. We assert it resolves the
// channel service and forwards the fork opts to the DO's `fork` RPC verbatim.

interface RpcCall {
  targetId: string;
  method: string;
  args: unknown[];
  options?: { idempotencyKey?: string };
}

function createMockRpc(forkResult: unknown) {
  const calls: RpcCall[] = [];
  const rpc = {
    async call<T>(
      targetId: string,
      method: string,
      args: unknown[],
      options?: { idempotencyKey?: string }
    ): Promise<T> {
      calls.push({ targetId, method, args, options });
      if (targetId === "main" && method === "workers.resolveService") {
        return {
          kind: "durable-object",
          source: "workers/pubsub-channel",
          className: "PubSubChannel",
          objectKey: args[1],
          targetId: `do:workers/pubsub-channel:PubSubChannel:${args[1]}`,
        } as T;
      }
      if (method === "fork") return forkResult as T;
      return undefined as T;
    },
    stream: async () => new Response(),
  } as unknown as RpcCaller;
  return { rpc, calls };
}

describe("forkConversation()", () => {
  it("resolves the parent channel and forwards the fork opts to its DO RPC", async () => {
    const result = {
      forkId: "fork-1",
      forkedChannelId: "fork:chan-1:a",
      forkedContextId: "fork-ctx-1",
      clonedParticipants: [],
      clonedAgents: [],
    };
    const { rpc, calls } = createMockRpc(result);

    const out = await forkConversation(rpc, {
      channelId: "chan-1",
      locus: { kind: "head" },
      reason: "deep-dive",
    });

    expect(out).toEqual(result);

    const resolve = calls.find((c) => c.method === "workers.resolveService");
    expect(resolve?.args).toEqual(["vibestudio.channel.v1", "chan-1"]);

    const forkCall = calls.find((c) => c.method === "fork");
    expect(forkCall?.targetId).toBe("do:workers/pubsub-channel:PubSubChannel:chan-1");
    expect(forkCall?.args[0]).toEqual({
      operationId: expect.any(String),
      locus: { kind: "head" },
      reason: "deep-dive",
    });
    expect(forkCall?.options?.idempotencyKey).toBe(
      `channel-fork:${(forkCall?.args[0] as { operationId: string }).operationId}`
    );
  });

  it("threads seed / label / include through to the DO", async () => {
    const { rpc, calls } = createMockRpc({
      forkId: "fork-2",
      forkedChannelId: "fork:chan-1:b",
      forkedContextId: "fork-ctx-2",
      clonedParticipants: [],
      clonedAgents: [],
      seededMessageId: "fork-seed:fork-2",
    });

    await forkConversation(rpc, {
      channelId: "chan-1",
      locus: { kind: "before-message", messageId: "msg-7" },
      reason: "edit",
      label: "My branch",
      seed: { blocks: [{ type: "text", content: "hi" }] },
      include: ["do:workers/agent:AiChatWorker:a1"],
    });

    const forkCall = calls.find((c) => c.method === "fork");
    expect(forkCall?.args[0]).toEqual({
      operationId: expect.any(String),
      locus: { kind: "before-message", messageId: "msg-7" },
      seed: { blocks: [{ type: "text", content: "hi" }] },
      label: "My branch",
      reason: "edit",
      include: ["do:workers/agent:AiChatWorker:a1"],
    });
  });
});
