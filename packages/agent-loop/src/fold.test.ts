import { describe, expect, it } from "vitest";
import type { LogEnvelope } from "@workspace/agentic-protocol";
import { applyEvent } from "./fold.js";
import { buildModelContext } from "./context.js";
import {
  initialAgentState,
  normalizeForkControlState,
  type AgentLoopConfig,
  type AgentState,
  type ModelRequestDescriptor,
} from "./state.js";

const modelSpec = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 64_000,
} satisfies AgentLoopConfig["modelSpec"];

const config: AgentLoopConfig = {
  model: "anthropic:claude-sonnet-4-6",
  modelSpec,
  thinkingLevel: "medium",
  fastMode: false,
  approvalLevel: 2,
  respondPolicy: "all",
  systemPromptHash: "blob:sys",
  activeToolNames: ["read"],
  roster: { participants: [] },
};

function turnOpened(actorId: string, turnId: string, seq: number): LogEnvelope {
  return envelope(
    actorId,
    "turn.opened",
    {},
    { turnId },
    seq,
    `turn:${turnId}:opened`,
  );
}

function envelope(
  actorId: string,
  payloadKind: string,
  payload: Record<string, unknown>,
  causality: Record<string, unknown>,
  seq: number,
  envelopeId = `${payloadKind}:${seq}`,
): LogEnvelope {
  return {
    logId: "branch:channel:c",
    head: "branch:channel:c",
    seq,
    envelopeId,
    actor: { kind: "agent", id: actorId, participantId: actorId },
    payloadKind,
    payload,
    causality,
    appendedAt: `2026-05-20T12:00:0${seq}.000Z`,
    prevHash: "p",
    hash: `h${seq}`,
  } as unknown as LogEnvelope;
}

function request(contextThroughSeq: number): ModelRequestDescriptor {
  return {
    provider: "test",
    model: "m",
    modelSpec,
    thinkingLevel: "medium",
    systemPromptHash: "blob:sys",
    activeToolNames: ["read"],
    contextThroughSeq,
    attemptId: "attempt-own",
  };
}

describe("fold: an agent only owns turns it authored", () => {
  it("keeps inherited context but never executes a pre-cut parent prompt", () => {
    const parentId = "agent:parent";
    const childId = "agent:child";
    let state = initialAgentState({
      channelId: "task",
      config,
      selfId: childId,
      forkSeq: 3,
    });
    state = applyEvent(
      state,
      envelope(
        parentId,
        "message.completed",
        {
          role: "user",
          blocks: [{ type: "text", content: "Parent request" }],
          outcome: "completed",
          turnTriggerEnvelopeId: "parent-message",
          senderRef: { kind: "user", id: "user:1", participantId: "user:1" },
        },
        { messageId: "parent-message" },
        1,
      ),
    );
    state = applyEvent(state, turnOpened(parentId, "parent-turn", 2));

    expect(state.pendingPrompt?.seq).toBe(1);
    const normalized = normalizeForkControlState(state);

    expect(normalized.pendingPrompt).toBeNull();
    expect(normalized.entries).toEqual(state.entries);
    expect(buildModelContext(normalized)).toEqual(buildModelContext(state));
  });

  it("carries a stable UI interaction from ingress metadata into model context", () => {
    const selfId = "agent:self";
    const interaction = {
      source: "onboarding-setup-hub",
      kind: "onboarding-capability",
      action: "setup",
      targetId: "connection.github",
    };
    const payload = {
      role: "user",
      blocks: [{ type: "text", content: "Set up GitHub" }],
      outcome: "completed",
      turnTriggerEnvelopeId: "channel-message-1",
      metadata: { interaction },
      senderRef: { kind: "user", id: "user:1", participantId: "user:1" },
    };
    const state = applyEvent(
      initialAgentState({ channelId: "c", config, selfId }),
      envelope(
        selfId,
        "message.completed",
        payload,
        { messageId: "recv:1" },
        1,
      ),
    );

    expect(state.entries[0]).toMatchObject({
      kind: "user",
      metadata: { interaction },
    });
    expect(buildModelContext(state)[0]).toEqual({
      role: "user",
      content: {
        message: payload,
        instruction:
          "Act on this structured UI interaction now. Treat the interaction payload as authoritative; do not rediscover its target from visible labels or repository search.",
        interaction,
      },
    });
  });

  it("reconstructs structured prompt input from the private trajectory event", () => {
    const selfId = "agent:self";
    const structuredInput = {
      kind: "channel-observation",
      version: 1,
      source: { payloadKind: "application.incident.v1" },
      payload: { incidentId: "inc-7" },
    };
    const persisted = envelope(
      selfId,
      "message.completed",
      {
        role: "user",
        blocks: [
          {
            type: "text",
            content: "Channel observation: application.incident.v1",
          },
        ],
        outcome: "completed",
        turnTriggerEnvelopeId: "custom-envelope-7",
        structuredInput,
        senderRef: { kind: "external", id: "service:incidents" },
      },
      { messageId: "recv:observation-7" },
      1,
    );

    const state = applyEvent(
      initialAgentState({ channelId: "c", config, selfId }),
      persisted,
    );

    expect(state.entries[0]).toMatchObject({ kind: "user", structuredInput });
    expect(buildModelContext(state)).toEqual([
      {
        role: "user",
        content: {
          message: "Channel observation: application.incident.v1",
          structuredInput,
        },
      },
    ]);
  });

  it("rejects descriptor-less model requests instead of replaying pre-materialization events", () => {
    const selfId = "agent:self";
    const turnId = "t:c:trigger:agent:self";
    const { modelSpec: _modelSpec, ...descriptorWithoutSpec } = request(1);
    void _modelSpec;
    let state = initialAgentState({ channelId: "c", config, selfId });
    state = applyEvent(state, turnOpened(selfId, turnId, 1));

    expect(() =>
      applyEvent(
        state,
        envelope(
          selfId,
          "message.started",
          { role: "assistant", modelRequest: descriptorWithoutSpec },
          { messageId: "m:missing-spec", turnId },
          2,
        ),
      ),
    ).toThrow(/lacks the required journaled modelSpec/u);
  });

  it("ignores another participant's turn.opened but adopts its own (selfId filter)", () => {
    const selfId = "agent:self";
    let state: AgentState = initialAgentState({
      channelId: "c",
      config,
      selfId,
    });

    // A DIFFERENT agent's turn.opened (from the shared channel log) must NOT become ours —
    // otherwise we'd continue its turn under its turnId → GAD id-collision.
    state = applyEvent(
      state,
      turnOpened("agent:other", "t:c:trig:agent:other", 1),
    );
    expect(state.openTurn).toBeNull();
    expect(state.lastSeq).toBe(1); // ...but the fold position still advances over it.

    // Our OWN turn.opened is adopted.
    state = applyEvent(state, turnOpened(selfId, "t:c:trig:agent:self", 2));
    expect(state.openTurn?.turnId).toBe("t:c:trig:agent:self");
  });

  it("keeps another agent's assistant completion as context without settling our in-flight call", () => {
    const selfId = "agent:self";
    const ownRequest = request(3);
    let state: AgentState = {
      ...initialAgentState({ channelId: "c", config, selfId }),
      inFlightModelCall: {
        messageId: "m:own",
        attemptId: "attempt-own",
        contextThroughSeq: 3,
        request: ownRequest,
      },
    };

    state = applyEvent(
      state,
      envelope(
        "agent:other",
        "message.completed",
        {
          role: "assistant",
          blocks: [{ type: "text", content: "other agent result" }],
        },
        { messageId: "m:foreign" },
        1,
      ),
    );

    expect(state.inFlightModelCall?.messageId).toBe("m:own");
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({
      kind: "assistant",
      messageId: "m:foreign",
      senderRef: { id: "agent:other" },
    });
  });

  it("folds the exact producing model identity from message.started into its completion", () => {
    const selfId = "agent:self";
    const modelRequest = request(1);
    let state = initialAgentState({ channelId: "c", config, selfId });
    state = applyEvent(state, turnOpened(selfId, "turn:model-identity", 1));
    state = applyEvent(
      state,
      envelope(
        selfId,
        "message.started",
        { role: "assistant", modelRequest },
        { messageId: "m:model-identity", turnId: "turn:model-identity" },
        2,
      ),
    );
    state = applyEvent(
      state,
      envelope(
        selfId,
        "message.completed",
        {
          role: "assistant",
          blocks: [{ type: "thinking", content: "durable reasoning" }],
          outcome: "completed",
        },
        { messageId: "m:model-identity", turnId: "turn:model-identity" },
        3,
      ),
    );

    expect(state.entries.at(-1)).toMatchObject({
      kind: "assistant",
      messageId: "m:model-identity",
      model: {
        provider: modelRequest.provider,
        api: modelRequest.modelSpec.api,
        model: modelRequest.model,
      },
    });
  });

  it("ignores another agent's invocation lifecycle state", () => {
    const selfId = "agent:self";
    let state: AgentState = initialAgentState({
      channelId: "c",
      config,
      selfId,
    });

    state = applyEvent(
      state,
      envelope(
        "agent:other",
        "invocation.started",
        {
          name: "read",
          transport: { kind: "local", awaiterId: "inv-foreign" },
          request: { path: "/x" },
        },
        { invocationId: "inv-foreign", turnId: "t:other" },
        1,
      ),
    );
    expect(state.pendingInvocations).toEqual({});
    expect(state.lastSeq).toBe(1);

    state = applyEvent(
      state,
      envelope(
        "agent:other",
        "invocation.completed",
        { result: "foreign result" },
        { invocationId: "inv-foreign", turnId: "t:other" },
        2,
      ),
    );
    expect(state.pendingInvocations).toEqual({});
    expect(state.entries).toEqual([]);
    expect(state.lastSeq).toBe(2);
  });
});
