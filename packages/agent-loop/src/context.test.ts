import { describe, expect, it } from "vitest";
import { buildModelContext } from "./context.js";
import {
  initialAgentState,
  type AgentLoopConfig,
  type AgentState,
  type SessionEntry,
} from "./state.js";

const config = {
  model: "anthropic:claude-sonnet-4-6",
  thinkingLevel: "medium",
  approvalLevel: 2,
  respondPolicy: "all",
  systemPromptHash: "blob:sys",
  activeToolNames: ["read"],
  roster: { participants: [] },
} as unknown as AgentLoopConfig;

describe("buildModelContext: multi-agent attribution", () => {
  it("presents another agent's message as an attributed user turn, own as assistant", () => {
    const selfId = "agent:self";
    const entries: SessionEntry[] = [
      {
        kind: "assistant",
        seq: 1,
        messageId: "m1",
        senderRef: {
          kind: "agent",
          id: "agent:other",
          metadata: { handle: "ai-chat" },
        },
        blocks: [
          { type: "thinking", content: "hidden reasoning" },
          { type: "text", content: "I added the explorer" },
        ],
      },
      {
        kind: "assistant",
        seq: 2,
        messageId: "m2",
        senderRef: { kind: "agent", id: selfId },
        blocks: [{ type: "text", content: "my own turn" }],
        model: {
          provider: "anthropic",
          api: "anthropic-messages",
          model: "claude-sonnet-4-6",
        },
      },
    ];
    const state: AgentState = {
      ...initialAgentState({ channelId: "c", config, selfId }),
      entries,
    };

    const msgs = buildModelContext(state);
    // ai-chat's message is NOT the explorer's own voice — it's attributed user context.
    expect(msgs[0]).toEqual({
      role: "user",
      content: "[ai-chat]: I added the explorer",
    });
    // the explorer's own message stays assistant.
    expect(msgs[1]).toEqual({
      role: "assistant",
      blocks: [{ type: "text", content: "my own turn" }],
      model: {
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-sonnet-4-6",
      },
    });
  });

  it("preserves pre-fork parent tool protocol as inherited model history", () => {
    const parentId = "agent:parent";
    const entries: SessionEntry[] = [
      {
        kind: "assistant",
        seq: 4,
        messageId: "m-parent",
        senderRef: { kind: "agent", id: parentId },
        blocks: [
          {
            type: "toolCall",
            id: "call-read",
            name: "read",
            arguments: { path: "SKILL.md" },
          },
        ],
      },
      {
        kind: "tool-result",
        seq: 5,
        invocationId: "call-read",
        turnId: "turn-parent",
        name: "read",
        result: "skill contents",
        isError: false,
      },
      {
        kind: "assistant",
        seq: 7,
        messageId: "m-parent-after-cut",
        senderRef: { kind: "agent", id: parentId },
        blocks: [{ type: "text", content: "later parent message" }],
      },
    ];
    const state: AgentState = {
      ...initialAgentState({
        channelId: "child",
        config,
        selfId: "agent:child",
        forkSeq: 5,
        lineageSelfIds: [parentId],
      }),
      entries,
    };

    expect(buildModelContext(state)).toEqual([
      {
        role: "assistant",
        blocks: [
          {
            type: "toolCall",
            id: "call-read",
            name: "read",
            arguments: { path: "SKILL.md" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-read",
        toolName: "read",
        content: "skill contents",
        isError: false,
      },
      { role: "user", content: `[${parentId}]: later parent message` },
    ]);
  });

  it("exposes structured UI interaction metadata beside readable message text", () => {
    const interaction = {
      source: "onboarding-setup-hub",
      kind: "onboarding-capability",
      action: "setup",
      targetId: "connection.github",
    };
    const entries: SessionEntry[] = [
      {
        kind: "user",
        seq: 1,
        envelopeId: "e1",
        content: "Set up GitHub",
        metadata: { interaction },
      },
    ];
    const state: AgentState = {
      ...initialAgentState({ channelId: "c", config, selfId: "agent:self" }),
      entries,
    };

    expect(buildModelContext(state)).toEqual([
      {
        role: "user",
        content: {
          message: "Set up GitHub",
          instruction:
            "Act on this structured UI interaction now. Treat the interaction payload as authoritative; do not rediscover its target from visible labels or repository search.",
          interaction,
        },
      },
    ]);
  });

  it("pairs a structured prompt sidecar with readable text", () => {
    const structuredInput = {
      kind: "channel-observation",
      version: 1,
      payload: { incidentId: "inc-7", severity: "high" },
    };
    const entries: SessionEntry[] = [
      {
        kind: "user",
        seq: 1,
        envelopeId: "e-observation",
        content: {
          role: "user",
          blocks: [
            {
              type: "text",
              content: "Channel observation: application.incident.v1",
            },
          ],
        },
        structuredInput,
      },
    ];
    const state: AgentState = {
      ...initialAgentState({ channelId: "c", config, selfId: "agent:self" }),
      entries,
    };

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

  it("keeps ordinary strings and block arrays unchanged", () => {
    const blocks = [{ type: "text", content: "hello" }];
    const entries: SessionEntry[] = [
      { kind: "user", seq: 1, envelopeId: "e-string", content: "hello" },
      { kind: "user", seq: 2, envelopeId: "e-blocks", content: blocks },
    ];
    const state: AgentState = {
      ...initialAgentState({ channelId: "c", config, selfId: "agent:self" }),
      entries,
    };

    expect(buildModelContext(state)).toEqual([
      { role: "user", content: "hello" },
      { role: "user", content: blocks },
    ]);
  });
});
