/**
 * Per-agent config: seeding from creation stateArgs (sanitized to the 7 known
 * settings), respondFrom handle→id resolution, and multi-channel invalidation
 * when config changes (config is per-AGENT, so a change applies to every channel).
 */
import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { ParticipantDescriptor } from "@workspace/harness";
import {
  AgentVesselBase,
  deriveSubagentParticipantHandle,
  resolveRespondFromHandles,
  subagentFirstTaskPrompt,
  subagentRuntimePrompt,
} from "./agent-vessel.js";

/** Minimal concrete vessel + test handles onto the protected managers. */
class TestAgentVessel extends AgentVesselBase {
  protected getParticipantInfo(): ParticipantDescriptor {
    return { type: "agent", name: "Test", handle: "test" } as ParticipantDescriptor;
  }
  participantForTest(config?: unknown): ParticipantDescriptor {
    return this.getEffectiveParticipantInfo("ch-1", config);
  }
  promptForTest(channelId = "ch-1"): Promise<string> {
    return this.composePrompt(channelId);
  }
  driverForTest(): { dropLoop: (channelId: string) => void } {
    return this.driver as unknown as { dropLoop: (channelId: string) => void };
  }
  subscriptionsForTest(): { listChannelIds: () => string[] } {
    return this.subscriptions as unknown as { listChannelIds: () => string[] };
  }
}

async function makeVessel(env?: Record<string, unknown>): Promise<TestAgentVessel> {
  const { instance } = await createTestDO(TestAgentVessel, { __objectKey: "agent-key", ...env });
  return instance;
}

describe("resolveRespondFromHandles", () => {
  it("maps handles to this channel's participant ids and keeps non-matches as-is", () => {
    const resolved = resolveRespondFromHandles(
      ["@alice", "p-bob", "@nobody"],
      [
        { participantId: "p-alice", metadata: { handle: "@alice" } },
        { participantId: "p-bob", metadata: {} },
      ]
    );
    expect(resolved).toEqual(["p-alice", "p-bob", "@nobody"]);
  });

  it("is a no-op on an empty allowlist", () => {
    expect(
      resolveRespondFromHandles([], [{ participantId: "p", metadata: { handle: "@p" } }])
    ).toEqual([]);
  });
});

describe("subagent participant handles", () => {
  it("uses the child object key as the handle when it is already valid", async () => {
    const vessel = await makeVessel({
      __objectKey: "ai-chat-6cdc-3f10f1ed",
      STATE_ARGS: {
        subagent: {
          runId:
            "call_pvAoQf2smkmA9mfbqmPt4i3H|fc_068771be153a5f7a016a48f4f3fb4c81978442476a01b8a1a5",
          task: "Inspect the assigned package.",
          parentRef: "do:workers/agent-worker:AiChatWorker:ai-chat",
          parentChannelId: "ch-parent",
          taskChannelId: "ch-task",
          parentParticipantId: "do:workers/agent-worker:AiChatWorker:ai-chat",
        },
      },
    });

    expect(vessel.participantForTest().handle).toBe("ai-chat-6cdc-3f10f1ed");
  });

  it("honors an explicit subscription handle for subagents", async () => {
    const vessel = await makeVessel({
      __objectKey: "ai-chat-6cdc-3f10f1ed",
      STATE_ARGS: {
        subagent: {
          runId: "run-1",
          task: "Inspect the assigned package.",
          parentRef: "do:workers/agent-worker:AiChatWorker:ai-chat",
          parentChannelId: "ch-parent",
          taskChannelId: "ch-task",
          parentParticipantId: "do:workers/agent-worker:AiChatWorker:ai-chat",
        },
      },
    });

    expect(vessel.participantForTest({ handle: "pdf-pilot" }).handle).toBe("pdf-pilot");
  });

  it("synthesizes a schema-valid handle when the object key is not a valid handle", () => {
    const handle = deriveSubagentParticipantHandle("ai-chat", "call:bad|run", "subagent:bad|run");

    expect(handle).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
    expect(handle).toContain("ai-chat");
    expect(handle).not.toBe("ai-chat");
  });
});

describe("subagent prompt contract", () => {
  it("keeps the immutable child contract in the stable system prompt", async () => {
    const vessel = await makeVessel({
      STATE_ARGS: {
        subagent: {
          runId: "run-1",
          task: "Review the inherited implementation.",
          mode: "fork",
          parentRef: "do:workers/agent-worker:AiChatWorker:ai-chat",
          parentChannelId: "ch-parent",
          taskChannelId: "ch-task",
          parentContextId: "ctx-parent",
          parentParticipantId: "agent:parent",
          depth: 1,
        },
      },
    });

    const prompt = await vessel.promptForTest();
    expect(prompt).toContain("## Subagent Operating Contract");
    expect(prompt).toContain("## Forked Subagent Scope");
    expect(prompt).toContain("Run id: run-1");
    expect(prompt).toContain("context window cache is shared");
    expect(prompt).toContain("focus narrowly on the particular task the parent gave you");
    expect(prompt).toContain("complete({ report, outcome })");
    expect(prompt).toContain(
      "Idle, turn closure, and a normal final assistant message are not terminal"
    );
  });

  it("does not inject the child contract for top-level agents", async () => {
    const vessel = await makeVessel();

    await expect(vessel.promptForTest()).resolves.not.toContain("## Subagent Operating Contract");
  });

  it("keeps the standalone subagent runtime prompt focused on terminal semantics", () => {
    const prompt = subagentRuntimePrompt({
      runId: "run-2",
      task: "Implement the assigned fixture and verify it.",
      parentRef: "parent",
      parentChannelId: "ch-parent",
      taskChannelId: "ch-task",
      parentContextId: "ctx-parent",
      parentParticipantId: "agent:parent",
      depth: 2,
    });

    expect(prompt).toContain("Use `notify` sparingly");
    expect(prompt).toContain("## Durable Assigned Task");
    expect(prompt).toContain("Implement the assigned fixture and verify it.");
    expect(prompt).toContain("Do not search for a different task");
    expect(prompt).toContain("You own execution of the assigned task");
    expect(prompt).toContain("do not hand the parent a plan or code block to copy");
    expect(prompt).toContain("Finish exactly once");
    expect(prompt).toContain("Only `complete` ends this subagent run");
    expect(prompt).not.toContain("## Forked Subagent Scope");
  });

  it("adds a narrow-scope prefix for forked subagents", () => {
    const prompt = subagentRuntimePrompt({
      runId: "run-3",
      task: "Review the inherited implementation for one concrete defect.",
      parentRef: "parent",
      parentChannelId: "ch-parent",
      taskChannelId: "ch-task",
      parentContextId: "ctx-parent",
      parentParticipantId: "agent:parent",
      depth: 2,
      mode: "fork",
    });

    expect(prompt).toContain("## Forked Subagent Scope");
    expect(prompt).toContain("context window cache is shared");
    expect(prompt).toContain("Assume the parent agent owns the main line of work");
    expect(prompt).toContain("durable assigned task below is your authoritative current instruction");
    expect(prompt).toContain("Earlier parent and user messages are inherited context");
    expect(prompt).toContain("Do not broaden scope");
    expect(prompt).toContain("spawn more subagents unless your assigned child task explicitly");
  });

  it("renders an explicit assignment boundary in a fork's first task prompt", () => {
    const prompt = subagentFirstTaskPrompt({
      mode: "fork",
      task: "Review the inherited implementation for one concrete defect.",
    });

    expect(prompt).toContain("## Fork Assignment Boundary");
    expect(prompt).toContain("not a continuation of the parent agent's plan");
    expect(prompt).toContain("inherited parent trajectory is reference context only");
    expect(prompt).toContain("Do not reproduce the parent's orchestration");
    expect(prompt).toContain(
      "<assigned_task>\nReview the inherited implementation for one concrete defect.\n</assigned_task>"
    );
  });

  it("keeps a fresh child's first task prompt literal", () => {
    expect(
      subagentFirstTaskPrompt({
        mode: "fresh",
        task: "Inspect one package.",
      })
    ).toBe("Inspect one package.");
  });

  it("uses the typed launcher result for a supervised external subagent", () => {
    const prompt = subagentRuntimePrompt(
      {
        runId: "run-external",
        task: "Audit the subagent documentation without editing files.",
        parentRef: "parent",
        parentChannelId: "ch-parent",
        taskChannelId: "ch-task",
        parentContextId: "ctx-parent",
        parentParticipantId: "agent:parent",
        depth: 2,
      },
      { completionMode: "supervised-process" }
    );
    expect(prompt).toContain("typed terminal result");
    expect(prompt).toContain("Do not print or imitate tool-call syntax");
    expect(prompt).not.toContain("Only `complete` ends");
  });
});

describe("per-agent settings seeding from STATE_ARGS.agentConfig", () => {
  it("seeds the valid settings and ignores invalid/unknown/presentation keys", async () => {
    const vessel = await makeVessel({
      STATE_ARGS: {
        agentConfig: {
          model: "openai:gpt-5.3",
          thinkingLevel: "max",
          fastMode: true,
          fallbackModel: "openai-codex:gpt-5.6-luna",
          fallbackThinkingLevel: "minimal",
          fallbackOn: ["usage_limit_terminal"],
          fallbackScope: "all-turns",
          approvalLevel: 1,
          // invalid + non-settings keys must be dropped by the sanitizer:
          thinkingLevelTypo: "ultra",
          approvalLevelBad: 99,
          handle: "presentation-not-a-setting",
          bogus: { nested: true },
        },
      },
    });

    const settings = vessel.getAgentSettings();
    expect(settings.model).toBe("openai:gpt-5.3");
    expect(settings.thinkingLevel).toBe("max");
    expect(settings.fastMode).toBe(true);
    expect(settings.approvalLevel).toBe(1);
    expect(settings).toMatchObject({
      fallbackModel: "openai-codex:gpt-5.6-luna",
      fallbackThinkingLevel: "minimal",
      fallbackOn: ["usage_limit_terminal"],
      fallbackScope: "all-turns",
    });
    // getAgentSettings only returns known behavior settings — never presentation/junk.
    expect(settings).not.toHaveProperty("handle");
    expect(settings).not.toHaveProperty("bogus");
  });

  it("falls back to defaults when no creation config is present", async () => {
    const vessel = await makeVessel();
    const settings = vessel.getAgentSettings();
    expect(typeof settings.model).toBe("string");
    expect(settings.model.length).toBeGreaterThan(0);
    expect([0, 1, 2]).toContain(settings.approvalLevel);
  });

  it("rejects an invalid model in the seed (falls back to the default model)", async () => {
    const seeded = await makeVessel({ STATE_ARGS: { agentConfig: { model: "openai:gpt-5.3" } } });
    const bad = await makeVessel({ STATE_ARGS: { agentConfig: { model: 42 } } });
    expect(seeded.getAgentSettings().model).toBe("openai:gpt-5.3");
    expect(bad.getAgentSettings().model).not.toBe(42);
    expect(typeof bad.getAgentSettings().model).toBe("string");
  });
});

describe("per-agent config invalidation spans all the agent's channels", () => {
  it("dropping config drops the cached loop for EVERY subscribed channel", async () => {
    const vessel = await makeVessel();
    vi.spyOn(vessel.subscriptionsForTest(), "listChannelIds").mockReturnValue(["ch-a", "ch-b"]);
    const dropLoop = vi.spyOn(vessel.driverForTest(), "dropLoop");

    vessel.configureAgent({ model: "anthropic:claude-sonnet-4-6" });
    vessel.configureAgent({ thinkingLevel: "xhigh" });
    expect(vessel.getAgentSettings().thinkingLevel).toBe("xhigh");
    vessel.configureAgent({ thinkingLevel: "max" });
    expect(vessel.getAgentSettings().thinkingLevel).toBe("max");
    vessel.configureAgent({ fastMode: true });
    expect(vessel.getAgentSettings().fastMode).toBe(true);

    expect(dropLoop).toHaveBeenCalledWith("ch-a");
    expect(dropLoop).toHaveBeenCalledWith("ch-b");
  });
});
