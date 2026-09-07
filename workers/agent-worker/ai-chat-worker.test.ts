import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { rpcExposedMethodNames, rpcMethodAuthority } from "@vibestudio/rpc";
import { PROVIDER_CREDENTIAL_SETUPS, DEFAULT_MODEL } from "@workspace/agentic-do";
import { AGENTIC_EVENT_PAYLOAD_KIND, AGENTIC_PROTOCOL_VERSION } from "@workspace/agentic-protocol";
import type { ChannelReplayEnvelope } from "@workspace/pubsub";

import { AiChatWorker } from "./ai-chat-worker.js";

class TestableAiChatWorker extends AiChatWorker {
  // Tests invoke onMethodCall directly (not through the relay) to exercise the
  // standard-agent-method logic; present as the server caller so the channel-delivery
  // gate (assertChannelDeliveryCaller) admits them.
  protected override get rpcCallerKind(): string | null {
    return "server";
  }
  readonly blobs = new Map<string, string>();
  readonly published: Array<{ participantId: string; event: unknown; opts?: unknown }> = [];
  readonly lifecycleLeaseCalls: Array<{ method: string; input: unknown }> = [];
  readonly driverHandleIncoming = vi.fn(async () => undefined);
  readonly driverWake = vi.fn(async () => undefined);
  readonly fakeDriver = {
    handleIncoming: this.driverHandleIncoming,
    wake: this.driverWake,
    activateChannel: vi.fn(),
    abortChannel: vi.fn(),
    dropLoop: vi.fn(),
    deliverEffectOutcome: vi.fn(async () => undefined),
    scheduleResumeAtReset: vi.fn(async () => ({ scheduled: true })),
    getDebugState: vi.fn(async () => ({})),
    loop: vi.fn(async () => ({
      state: {
        logId: "log:agent-test",
        head: "event:agent-test",
        lastSeq: 0,
      },
    })),
    foldCache: { delete: vi.fn() },
  };
  subscribeEnvelope: ChannelReplayEnvelope = {
    mode: "initial",
    logEvents: [],
    snapshots: [],
    ready: { totalCount: 0, envelopeCount: 0 },
  };
  workspaceAgentsMd: unknown = "WORKSPACE AGENTS";
  workspaceSkills: unknown = [
    {
      name: "onboarding",
      description: "Onboarding skill",
      dirPath: "skills/onboarding",
      skillPath: "skills/onboarding/SKILL.md",
    },
  ];

  readonly rpcCall = vi.fn(async (target: string, method: string, args: unknown[]) => {
    if (target === "main" && method === "workspace.getAgentsMd") {
      return this.workspaceAgentsMd;
    }
    if (target === "main" && method === "workspace.listSkills") {
      return this.workspaceSkills;
    }
    if (target === "main" && method === "blobstore.putText") {
      const value = String(args[0] ?? "");
      const digest = (this.blobs.size + 1).toString(16).padStart(64, "0");
      this.blobs.set(digest, value);
      return { digest, size: value.length };
    }
    if (
      target === "main" &&
      (method === "workspace-state.lifecycleLeaseUpsert" ||
        method === "workspace-state.lifecycleLeaseClear")
    ) {
      this.lifecycleLeaseCalls.push({ method, input: args[0] });
      return undefined;
    }
    if (target === "main" && method === "contextIntegrity.ingest") {
      return { class: "internal", latchEpoch: 0, externalKeys: [] };
    }
    throw new Error(`unexpected rpc ${target}.${method}`);
  });

  protected override get rpc(): never {
    return {
      call: this.rpcCall,
    } as never;
  }

  protected override async callGad<T>(method: string, ...args: unknown[]): Promise<T> {
    if (method === "appendLogEvent") {
      const input = (args[0] ?? {}) as { events?: Array<{ envelopeId: string }> };
      return {
        envelopes: (input.events ?? []).map((event, index) => ({
          envelopeId: event.envelopeId,
          seq: index + 1,
        })),
      } as T;
    }
    return super.callGad<T>(method, ...args);
  }

  protected override get driver(): never {
    return this.fakeDriver as never;
  }

  protected override createChannelClient() {
    return {
      publishAgenticEvent: async (participantId: string, event: unknown, opts?: unknown) => {
        this.published.push({ participantId, event, opts });
        return { id: this.published.length };
      },
      relationshipState: async () => ({ revision: 0, active: false }),
      join: async (input: { participantId: string; revision: number }) => ({
        ok: true,
        participantId: input.participantId,
        revision: input.revision,
        channelConfig: undefined,
        envelope: this.subscribeEnvelope,
      }),
      leave: async () => ({ ok: true }),
      getParticipants: async () => [],
    } as never;
  }

  credentialSetup(providerId: string) {
    return this.getModelCredentialSetupProps(providerId);
  }

  seedSubscriptionConfig(channelId: string, config: Record<string, unknown>) {
    this.sql.exec(
      `INSERT OR REPLACE INTO subscriptions
         (channel_id, context_id, revision, subscribed_at, config, relationship_json, participant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      channelId,
      "ctx-1",
      1,
      Date.now(),
      JSON.stringify(config),
      "{}",
      `participant:${channelId}`
    );
  }

  async materializedPrompt(channelId: string): Promise<string> {
    await this.ensurePromptArtifacts(channelId);
    const digest = this.getStateValue(`agent:promptHash:${channelId}`);
    if (!digest) throw new Error("missing prompt digest");
    const value = this.blobs.get(digest);
    if (value === undefined) throw new Error(`missing prompt blob ${digest}`);
    return value;
  }

  promptResourceCallCount(method: "workspace.getAgentsMd" | "workspace.listSkills") {
    return this.rpcCall.mock.calls.filter((call) => call[0] === "main" && call[1] === method)
      .length;
  }
}

async function makeWorker() {
  const { instance } = await createTestDO(TestableAiChatWorker, { __objectKey: "agent-1" });
  return instance as TestableAiChatWorker;
}

describe("AiChatWorker", () => {
  it("inherits the finite channel-delivery RPC authority declaration", async () => {
    const worker = await makeWorker();
    expect(rpcExposedMethodNames(worker).has("acceptChannelDelivery")).toBe(true);
    expect(rpcMethodAuthority(worker, "acceptChannelDelivery")).toMatchObject({
      principals: ["host"],
      effect: { kind: "open" },
      tier: "open",
      sensitivity: "write",
    });
  });

  it("inherits the base agent schema epoch", () => {
    expect(TestableAiChatWorker.schemaVersion).toBe(AiChatWorker.schemaVersion);
  });

  it("reconstructs over its complete sealed durable schema", async () => {
    const first = await createTestDO(TestableAiChatWorker, { __objectKey: "agent-replay" });
    await expect(
      createTestDO(TestableAiChatWorker, { __objectKey: "agent-replay" }, { db: first.db })
    ).resolves.toMatchObject({ instance: expect.any(TestableAiChatWorker) });
  });

  it("exposes the shared provider connect presets to the credential flow", async () => {
    const worker = await makeWorker();
    for (const providerId of Object.keys(PROVIDER_CREDENTIAL_SETUPS)) {
      expect(worker.credentialSetup(providerId)).toEqual(PROVIDER_CREDENTIAL_SETUPS[providerId]);
    }
    expect(worker.credentialSetup("nope")).toBeNull();
  });

  it("ingests finite subscription replay and wakes the loop without a residency lease", async () => {
    const worker = await makeWorker();
    worker.subscribeEnvelope = {
      mode: "initial",
      logEvents: [
        {
          id: 1,
          messageId: "msg-1",
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          senderId: "user-1",
          senderMetadata: { type: "panel", name: "User" },
          ts: Date.parse("2026-06-17T12:00:00.000Z"),
          payload: {
            kind: "message.completed",
            actor: { kind: "panel", id: "user-1", displayName: "User" },
            causality: { messageId: "msg-1" },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              role: "user",
              blocks: [{ type: "text", content: "hello" }],
              outcome: "completed",
            },
            createdAt: "2026-06-17T12:00:00.000Z",
          },
        },
      ],
      snapshots: [],
      ready: { totalCount: 1, envelopeCount: 1 },
    };

    await worker.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1", replay: true });

    expect(worker.lifecycleLeaseCalls).toEqual([]);
    expect(worker.driverHandleIncoming).toHaveBeenCalledWith(
      "ch-1",
      expect.objectContaining({
        type: "command",
        command: expect.objectContaining({
          kind: "prompt",
          channelId: "ch-1",
          source: { envelopeId: "msg-1" },
        }),
      })
    );
    expect(worker.driverWake).toHaveBeenCalledWith("ch-1");
  });

  it("materializes workspace, skill, and subscription prompts into the model prompt artifact", async () => {
    const worker = await makeWorker();
    worker.seedSubscriptionConfig("ch-1", {
      systemPrompt: "CHANNEL CUSTOM",
      systemPromptMode: "append",
    });

    const prompt = await worker.materializedPrompt("ch-1");

    expect(prompt).toContain("Vibestudio is a local workspace");
    expect(prompt).toContain("WORKSPACE AGENTS");
    expect(prompt).toContain("onboarding");
    expect(prompt).toContain("CHANNEL CUSTOM");
    expect(prompt.indexOf("WORKSPACE AGENTS")).toBeLessThan(prompt.indexOf("onboarding"));
    expect(prompt.indexOf("onboarding")).toBeLessThan(prompt.indexOf("CHANNEL CUSTOM"));
  });

  it("honors a full replacement subscription prompt", async () => {
    const worker = await makeWorker();
    worker.seedSubscriptionConfig("ch-1", {
      systemPrompt: "CHANNEL ONLY",
      systemPromptMode: "replace",
    });

    await expect(worker.materializedPrompt("ch-1")).resolves.toBe("CHANNEL ONLY");
  });

  it("caches workspace prompt resources and refreshes them on request", async () => {
    const worker = await makeWorker();
    worker.seedSubscriptionConfig("ch-1", {});

    await worker.materializedPrompt("ch-1");
    await worker.materializedPrompt("ch-1");
    expect(worker.promptResourceCallCount("workspace.getAgentsMd")).toBe(1);
    expect(worker.promptResourceCallCount("workspace.listSkills")).toBe(1);

    worker.workspaceAgentsMd = "UPDATED WORKSPACE AGENTS";
    const refresh = await worker.onMethodCall("ch-1", "tc-refresh", "refreshPromptArtifacts", {});

    expect(refresh).toMatchObject({ result: { refreshed: true } });
    expect(worker.promptResourceCallCount("workspace.getAgentsMd")).toBe(2);
    expect(worker.promptResourceCallCount("workspace.listSkills")).toBe(2);
    await expect(worker.materializedPrompt("ch-1")).resolves.toContain("UPDATED WORKSPACE AGENTS");
  });

  it("fails prompt preparation closed without publishing outside the durable loop", async () => {
    const worker = await makeWorker();
    worker.seedSubscriptionConfig("ch-1", {});
    worker.workspaceSkills = { not: "a skill list" };

    await expect(worker.materializedPrompt("ch-1")).rejects.toThrow(
      "workspace.listSkills returned invalid resource shape"
    );

    // Preparation is an executor boundary. Its caller journals the failure and
    // the loop publishes the one deterministic diagnostic; the vessel must not
    // create a second, non-journaled side channel.
    expect(worker.published).toHaveLength(0);
    expect(worker.driverHandleIncoming).not.toHaveBeenCalled();

    await expect(worker.materializedPrompt("ch-1")).rejects.toThrow(
      "workspace.listSkills returned invalid resource shape"
    );
    expect(worker.published).toHaveLength(0);
  });

  it("persists live setting changes through the standard agent methods", async () => {
    const worker = await makeWorker();
    const before = await worker.onMethodCall("ch-1", "tc-1", "getAgentSettings", {});
    expect((before.result as { model: string }).model).toBe(DEFAULT_MODEL);

    const switched = await worker.onMethodCall("ch-1", "tc-2", "setModel", {
      model: "anthropic:claude-sonnet-4-6",
    });
    expect((switched.result as { model: string }).model).toBe("anthropic:claude-sonnet-4-6");

    // settings survive re-read (Ref-kind KV)
    const after = await worker.onMethodCall("ch-1", "tc-3", "getAgentSettings", {});
    expect((after.result as { model: string }).model).toBe("anthropic:claude-sonnet-4-6");
    const effort = await worker.onMethodCall("ch-1", "tc-effort", "setThinkingLevel", {
      level: "max",
    });
    expect((effort.result as { thinkingLevel: string }).thinkingLevel).toBe("max");
    // config is per-AGENT, not per-channel: a sibling channel of the same agent sees the change
    const other = await worker.onMethodCall("ch-2", "tc-4", "getAgentSettings", {});
    expect((other.result as { model: string }).model).toBe("anthropic:claude-sonnet-4-6");
    expect((other.result as { thinkingLevel: string }).thinkingLevel).toBe("max");
  });

  it("validates standard method arguments", async () => {
    const worker = await makeWorker();
    expect((await worker.onMethodCall("ch-1", "tc-1", "setModel", {})).isError).toBe(true);
    expect(
      (await worker.onMethodCall("ch-1", "tc-2", "setThinkingLevel", { level: "extreme" })).isError
    ).toBe(true);
    expect(
      (await worker.onMethodCall("ch-1", "tc-3", "setApprovalLevel", { level: 9 })).isError
    ).toBe(true);
    expect(
      (await worker.onMethodCall("ch-1", "tc-4", "setRespondPolicy", { policy: "sometimes" }))
        .isError
    ).toBe(true);
    expect((await worker.onMethodCall("ch-1", "tc-5", "unknownMethod", {})).isError).toBe(true);
  });

  it("applies respond policy with an allow-list", async () => {
    const worker = await makeWorker();
    const result = await worker.onMethodCall("ch-1", "tc-1", "setRespondPolicy", {
      policy: "from-participants",
      from: ["panel:alice", 42, "panel:bob"],
    });
    expect(result.result).toMatchObject({
      respondPolicy: "from-participants",
      respondFrom: ["panel:alice", "panel:bob"],
    });
  });
});
