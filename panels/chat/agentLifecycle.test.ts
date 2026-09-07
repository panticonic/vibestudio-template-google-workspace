/**
 * Panel-rpc harness: drives createAndSubscribeAgent against a mocked
 * `@workspace/runtime` rpc and asserts the per-agent config seeds into the
 * entity's creation stateArgs while the subscription stays presentation-only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProvisionalAgentLifecycle,
  type AgentLaunchRpc,
  type ProvisionalAgentIntent,
} from "@workspace/agentic-core";

const mocks = vi.hoisted(() => ({
  waitForApprovalResolution: vi.fn(async () => undefined),
  getStateArgs: vi.fn(),
  setStateArgs: vi.fn(),
  call: vi.fn(async (_target: string, method: string, args: unknown[]) => {
    if (method === "runtime.createEntity") {
      const spec = args[0] as { key: string; contextId?: string };
      const id = `do:workers/agent-worker:AiChatWorker:${spec.key}`;
      return { id, targetId: id, contextId: spec.contextId };
    }
    return { ok: true, participantId: "p-1" };
  }),
}));

vi.mock("@workspace/runtime", () => ({
  rpc: { call: mocks.call },
  panel: { stateArgs: { get: mocks.getStateArgs, set: mocks.setStateArgs } },
}));
vi.mock("@workspace/pubsub", () => ({
  waitForApprovalResolution: mocks.waitForApprovalResolution,
}));

import { createAndSubscribeAgent, persistInstalledAgent } from "./agentLifecycle.js";

function callsFor(method: string): unknown[][] {
  return mocks.call.mock.calls.filter((c) => c[1] === method).map((c) => c[2] as unknown[]);
}

describe("createAndSubscribeAgent (panel-rpc harness)", () => {
  beforeEach(() => {
    mocks.call.mockClear();
    mocks.waitForApprovalResolution.mockClear();
  });

  it("seeds per-agent settings into creation stateArgs; subscription is presentation-only", async () => {
    const result = await createAndSubscribeAgent({
      source: "workers/agent-worker",
      className: "AiChatWorker",
      key: "k",
      channelId: "ch-1",
      channelContextId: "ctx-1",
      config: {
        model: "openai:gpt-5.3",
        approvalLevel: 1,
        respondPolicy: "mentioned-or-followup",
        handle: "bot",
        systemPrompt: "be terse",
      },
    });
    expect(result).toEqual({ ok: true, participantId: "p-1" });

    // createEntity seeds the FULL config (vessel sanitizes to the 7) under stateArgs.
    const createSpec = callsFor("runtime.createEntity")[0]![0] as {
      kind: string;
      stateArgs: { agentConfig: Record<string, unknown> };
    };
    expect(createSpec.kind).toBe("do");
    expect(createSpec.stateArgs.agentConfig).toMatchObject({
      model: "openai:gpt-5.3",
      approvalLevel: 1,
      respondPolicy: "mentioned-or-followup",
    });

    // The subscription carries presentation only — no behavior settings leak.
    const subConfig = (callsFor("subscribeChannel")[0]![0] as { config: Record<string, unknown> })
      .config;
    expect(subConfig).toEqual({ handle: "bot", systemPrompt: "be terse" });
    expect(subConfig).not.toHaveProperty("model");
    expect(subConfig).not.toHaveProperty("approvalLevel");
    expect(subConfig).not.toHaveProperty("respondPolicy");
  });

  it("preserves worker-specific extras on the subscription (e.g. test-agent deterministic keys)", async () => {
    await createAndSubscribeAgent({
      source: "workers/test-agent",
      className: "TestAgentWorker",
      key: "k",
      channelId: "ch-1",
      channelContextId: "ctx-1",
      config: {
        model: "openai:gpt-5.3", // a setting — must be stripped
        deterministicResponse: true, // worker extras — must survive
        responseText: "hi",
        code: "read('a')",
        handle: "test-agent",
      },
    });
    const subConfig = (callsFor("subscribeChannel")[0]![0] as { config: Record<string, unknown> })
      .config;
    expect(subConfig).toEqual({
      deterministicResponse: true,
      responseText: "hi",
      code: "read('a')",
      handle: "test-agent",
    });
    expect(subConfig).not.toHaveProperty("model");
    // The settings still seed the agent's creation config:
    const createSpec = callsFor("runtime.createEntity")[0]![0] as {
      stateArgs: { agentConfig: Record<string, unknown> };
    };
    expect(createSpec.stateArgs.agentConfig).toMatchObject({ model: "openai:gpt-5.3" });
  });

  it("creates the entity before subscribing, on the channel's context", async () => {
    await createAndSubscribeAgent({
      source: "workers/agent-worker",
      className: "AiChatWorker",
      key: "k",
      channelId: "ch-1",
      channelContextId: "ctx-1",
    });
    const order = mocks.call.mock.calls.map((c) => c[1]);
    expect(order).toEqual(["runtime.createEntity", "subscribeChannel"]);
    const createSpec = callsFor("runtime.createEntity")[0]![0] as { contextId: string };
    expect(createSpec.contextId).toBe("ctx-1");
  });

  it("keeps activation pending across the exact workspace review", async () => {
    let subscriptionAttempts = 0;
    mocks.call.mockImplementation(async (_target: string, method: string, args: unknown[]) => {
      if (method === "runtime.createEntity") {
        const spec = args[0] as { key: string; contextId?: string };
        const id = `do:workers/agent-worker:AiChatWorker:${spec.key}`;
        return { id, targetId: id, contextId: spec.contextId };
      }
      subscriptionAttempts += 1;
      if (subscriptionAttempts === 1) {
        throw Object.assign(new Error("Waiting for workspace review"), {
          code: "EREVIEWPENDING",
          errorData: {
            authorityFailure: {
              remediation: {
                review: {
                  approvalId: "review-welcome",
                  title: "Welcome — here's what's in your workspace",
                },
              },
            },
          },
        });
      }
      return { ok: true, participantId: "p-1" };
    });

    await expect(
      createAndSubscribeAgent({
        source: "workers/agent-worker",
        className: "AiChatWorker",
        key: "k",
        channelId: "ch-1",
        channelContextId: "ctx-1",
      })
    ).resolves.toEqual({ ok: true, participantId: "p-1" });

    expect(mocks.waitForApprovalResolution).toHaveBeenCalledWith(
      expect.objectContaining({ call: mocks.call }),
      "review-welcome"
    );
    expect(subscriptionAttempts).toBe(2);
  });

  it("refuses to subscribe without a context id", async () => {
    await expect(
      createAndSubscribeAgent({
        source: "workers/agent-worker",
        className: "AiChatWorker",
        key: "k",
        channelId: "ch-1",
        channelContextId: "",
      })
    ).rejects.toThrow(/context ID/);
    expect(mocks.call).not.toHaveBeenCalled();
  });
});

function provisionalIntent(model: string): ProvisionalAgentIntent {
  return {
    source: "workers/agent-worker",
    className: "AiChatWorker",
    channelId: "ch-1",
    channelContextId: "ctx-1",
    handleBase: "ai-chat",
    config: { model, approvalLevel: 2, handle: "ai-chat" },
    persistedConfig: { model, approvalLevel: 2 },
    replay: true,
  };
}

function lifecycleRpc(): AgentLaunchRpc & { call: ReturnType<typeof vi.fn> } {
  const rpc = {
    call: vi.fn(async (_target: string, method: string, args: unknown[]) => {
      if (method === "runtime.createEntity") {
        const spec = args[0] as { key: string; contextId: string };
        const id = `do:workers/agent-worker:AiChatWorker:${spec.key}`;
        return { id, targetId: id, contextId: spec.contextId };
      }
      return { ok: true, participantId: "participant-1" };
    }),
  };
  return rpc as unknown as AgentLaunchRpc & { call: typeof rpc.call };
}

describe("ProvisionalAgentLifecycle", () => {
  it("activates without subscribing, then claims the same warm entity", async () => {
    const rpc = lifecycleRpc();
    const uuids = ["aaaa1111", "bbbb2222"];
    const lifecycle = new ProvisionalAgentLifecycle(rpc, () => uuids.shift()!);
    const intent = provisionalIntent("openai:gpt-5.3");

    await lifecycle.prepare(intent);
    expect(rpc.call.mock.calls.map((call) => call[1])).toEqual(["runtime.createEntity"]);

    const claimed = await lifecycle.claim(intent);

    expect(rpc.call.mock.calls.map((call) => call[1])).toEqual([
      "runtime.createEntity",
      "subscribeChannel",
    ]);
    expect(claimed).toMatchObject({
      key: "ai-chat-aaaa-bbbb2222",
      handle: "ai-chat-aaaa",
      persistedConfig: { model: "openai:gpt-5.3", approvalLevel: 2 },
    });
    expect(rpc.call).toHaveBeenLastCalledWith(
      "do:workers/agent-worker:AiChatWorker:ai-chat-aaaa-bbbb2222",
      "subscribeChannel",
      [
        expect.objectContaining({
          channelId: "ch-1",
          contextId: "ctx-1",
          config: { handle: "ai-chat-aaaa" },
        }),
      ]
    );
  });

  it("waits for an open review instead of failing the provisional claim", async () => {
    const rpc = lifecycleRpc();
    let attempts = 0;
    rpc.call.mockImplementation(async (_target, method, args) => {
      if (method === "runtime.createEntity") {
        const spec = args[0] as { key: string; contextId: string };
        const id = `do:workers/agent-worker:AiChatWorker:${spec.key}`;
        return { id, targetId: id, contextId: spec.contextId };
      }
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("Waiting for workspace review"), {
          code: "EREVIEWPENDING",
          errorData: {
            authorityFailure: {
              remediation: {
                review: { approvalId: "review-welcome", title: "Welcome" },
              },
            },
          },
        });
      }
      return { ok: true, participantId: "participant-1" };
    });
    const waitForReview = vi.fn(async () => undefined);
    const lifecycle = new ProvisionalAgentLifecycle(rpc, () => "aaaaaaaa", waitForReview);
    const intent = provisionalIntent("openai:gpt-5.3");

    await lifecycle.prepare(intent);
    await expect(lifecycle.claim(intent)).resolves.toMatchObject({
      subscription: { ok: true, participantId: "participant-1" },
    });

    expect(waitForReview).toHaveBeenCalledWith("review-welcome");
    expect(attempts).toBe(2);
  });

  it("retires a mismatched provisional entity before warming the new draft", async () => {
    const rpc = lifecycleRpc();
    const uuids = ["aaaa1111", "bbbb2222", "cccc3333", "dddd4444"];
    const lifecycle = new ProvisionalAgentLifecycle(rpc, () => uuids.shift()!);

    await lifecycle.prepare(provisionalIntent("openai:gpt-5.3"));
    await lifecycle.prepare(provisionalIntent("anthropic:claude-sonnet-4-6"));

    expect(rpc.call.mock.calls.map((call) => call[1])).toEqual([
      "runtime.createEntity",
      "runtime.retireEntity",
      "runtime.createEntity",
    ]);
    expect(rpc.call.mock.calls[1]).toEqual([
      "main",
      "runtime.retireEntity",
      [{ id: "do:workers/agent-worker:AiChatWorker:ai-chat-aaaa-bbbb2222" }],
    ]);
    const replacementSpec = rpc.call.mock.calls[2]?.[2]?.[0] as {
      stateArgs: { agentConfig: Record<string, unknown> };
    };
    expect(replacementSpec.stateArgs.agentConfig).toMatchObject({
      model: "anthropic:claude-sonnet-4-6",
      handle: "ai-chat-cccc",
    });
  });

  it("retires an unclaimed warm entity when the panel closes", async () => {
    const rpc = lifecycleRpc();
    const uuids = ["aaaa1111", "bbbb2222"];
    const lifecycle = new ProvisionalAgentLifecycle(rpc, () => uuids.shift()!);

    await lifecycle.prepare(provisionalIntent("openai:gpt-5.3"));
    await lifecycle.dispose();

    expect(rpc.call.mock.calls.map((call) => call[1])).toEqual([
      "runtime.createEntity",
      "runtime.retireEntity",
    ]);
  });
});

describe("claimed agent persistence", () => {
  beforeEach(() => {
    mocks.waitForApprovalResolution.mockReset().mockResolvedValue(undefined);
    mocks.getStateArgs.mockReset().mockReturnValue({ installedAgents: [] });
    mocks.setStateArgs.mockReset();
  });
  it("waits for review then persists the same agent without repeating its launch or losing concurrent records", async () => {
    const agent = {
      agentId: "AiChatWorker",
      source: "workers/agent-worker",
      className: "AiChatWorker",
      handle: "first",
      key: "claimed-key",
    };
    const concurrent = { ...agent, handle: "second", key: "concurrent-key" };
    let resolveReview!: () => void;
    mocks.waitForApprovalResolution.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveReview = () => resolve(undefined);
        }),
    );
    mocks.getStateArgs.mockReturnValue({ installedAgents: [] });
    mocks.setStateArgs
      .mockRejectedValueOnce(
        Object.assign(new Error("Waiting for review"), {
          code: "EREVIEWPENDING",
          errorData: {
            authorityFailure: {
              remediation: {
                review: { approvalId: "review-welcome", title: "Welcome" },
              },
            },
          },
        }),
      )
      .mockResolvedValue(undefined);
    mocks.call.mockClear();
    const pending = persistInstalledAgent(agent);
    await vi.waitFor(() =>
      expect(mocks.waitForApprovalResolution).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        "review-welcome",
      ),
    );
    expect(mocks.setStateArgs).toHaveBeenCalledTimes(1);
    mocks.getStateArgs.mockReturnValue({ installedAgents: [concurrent] });
    resolveReview();
    await pending;
    expect(mocks.setStateArgs).toHaveBeenLastCalledWith({
      installedAgents: [concurrent, agent],
    });
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("propagates ordinary persistence errors without waiting on approval", async () => {
    mocks.setStateArgs.mockRejectedValue(new Error("storage unavailable"));
    await expect(
      persistInstalledAgent({
        agentId: "AiChatWorker",
        source: "workers/agent-worker",
        className: "AiChatWorker",
        handle: "first",
        key: "claimed-key",
      }),
    ).rejects.toThrow("storage unavailable");
    expect(mocks.waitForApprovalResolution).not.toHaveBeenCalled();
  });
});
