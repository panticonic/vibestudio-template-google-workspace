import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { defaultPolicies, type AgentState } from "@workspace/agent-loop";

import { SilentAgentWorker } from "./index.js";

class TestSilentAgentWorker extends SilentAgentWorker {
  publishPolicy(): "all" | "turn-final" | "notify-only" | "say-only" | undefined {
    return this.getPublishPolicy("ch-1");
  }
}

describe("SilentAgentWorker", () => {
  it("selects the notify-only publish policy", async () => {
    const { instance } = await createTestDO(TestSilentAgentWorker);
    const worker = instance as TestSilentAgentWorker;
    expect(worker.publishPolicy()).toBe("notify-only");
  });

  it("suppresses normal trajectory chatter under notify-only, keeping turn boundaries", () => {
    // The silent agent migrates onto the config-level `publishPolicy` StepPolicy
    // (WS-4). With config.publishPolicy = "notify-only" it flips `publish` off
    // for everything but turn open/close — the old `silentPolicy()` behavior.
    const policy = defaultPolicies().find((p) => p.name === "publish-policy");
    expect(policy).toBeDefined();
    const state = { config: { publishPolicy: "notify-only" } } as unknown as AgentState;
    const items = [
      { envelopeId: "a", payloadKind: "turn.opened" as const, payload: {}, publish: true },
      { envelopeId: "b", payloadKind: "message.completed" as const, payload: {}, publish: true },
      { envelopeId: "c", payloadKind: "turn.closed" as const, payload: {}, publish: true },
    ];
    const filtered = policy!.transformAppend!({ state, items });
    expect(filtered.map((item) => [item.payloadKind, item.publish])).toEqual([
      ["turn.opened", true],
      ["message.completed", false],
      ["turn.closed", true],
    ]);
  });
});

describe("publishPolicy alias", () => {
  it('still honours the frozen "say-only" spelling in checked-in configs', () => {
    // The rename is vocabulary only; a template manifest written before it must
    // keep silencing its agent (plan §4.3).
    const policy = defaultPolicies().find((p) => p.name === "publish-policy");
    const state = { config: { publishPolicy: "say-only" } } as unknown as AgentState;
    const filtered = policy!.transformAppend!({
      state,
      items: [
        { envelopeId: "a", payloadKind: "turn.opened" as const, payload: {}, publish: true },
        { envelopeId: "b", payloadKind: "message.completed" as const, payload: {}, publish: true },
      ],
    });
    expect(filtered.map((item) => item.publish)).toEqual([true, false]);
  });
});
