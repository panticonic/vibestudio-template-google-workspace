import { describe, expect, it } from "vitest";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  CREDENTIAL_CONNECT_PAYLOAD_KIND,
  agentToolFailureFromUnknown,
  brandId,
  createInitialChannelViewState,
  reduceChannelView,
  type AgenticEvent,
  type ApprovalId,
  type BlockId,
  type ChannelEnvelope,
  type ChannelId,
  type EnvelopeId,
  type InvocationId,
  type MessageId,
  type MessageRole,
  type TaskId,
  type TurnId,
} from "@workspace/agentic-protocol";

function toolFailure(operation: string, message: string) {
  return agentToolFailureFromUnknown({ message }, { operation, stage: "test" });
}
import {
  actionBarPayloadFromChannelView,
  chatMessagesFromChannelView,
  messageTypeDefinitionsFromChannelView,
} from "./channel-chat-merge.js";

const agent = {
  kind: "agent" as const,
  id: "agent-1",
  displayName: "Agent One",
};
const participant = { ...agent, participantId: "participant-agent-1" };

function envelope(payload: AgenticEvent, seq: number): ChannelEnvelope<AgenticEvent> {
  return {
    envelopeId: brandId<EnvelopeId>(`env-${seq}`),
    channelId: brandId<ChannelId>("channel-1"),
    seq,
    from: participant,
    payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
    payload,
    contentClass: "internal",
    externalKeys: [],
    publishedAt: payload.createdAt,
  };
}

function textPayload(messageId: string, role: MessageRole, content: string) {
  return {
    protocol: AGENTIC_PROTOCOL_VERSION,
    role,
    blocks: [
      {
        blockId: brandId<BlockId>(`${messageId}:block:0`),
        type: "text" as const,
        content,
      },
    ],
    outcome: "completed" as const,
  };
}

describe("chatMessagesFromChannelView", () => {
  it("projects cleared message type definitions so registry consumers can invalidate compiled modules", () => {
    const registered: AgenticEvent<"messageType.registered"> = {
      kind: "messageType.registered",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        typeId: "weather",
        displayMode: "inline",
        source: {
          type: "code",
          code: "export default function Weather() { return null; }",
        },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const cleared: AgenticEvent<"messageType.cleared"> = {
      kind: "messageType.cleared",
      actor: agent,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, typeId: "weather" },
      createdAt: "2026-05-20T12:00:02.000Z",
    };

    const state = [envelope(registered, 1), envelope(cleared, 2)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );

    expect(messageTypeDefinitionsFromChannelView(state)).toEqual([
      expect.objectContaining({
        typeId: "weather",
        cleared: true,
        updatedAtSeq: 1,
        clearedAtSeq: 2,
      }),
    ]);
  });

  it("projects typed channel events into transcript chat messages", () => {
    const message: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      causality: { messageId: brandId<MessageId>("msg-1") },
      payload: textPayload("msg-1", "assistant", "done"),
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-1") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "read_file",
        request: { path: "README.md" },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const completed: AgenticEvent<"invocation.completed"> = {
      kind: "invocation.completed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-1") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        result: "contents",
        terminalOutcome: "success",
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };

    const state = [envelope(message, 1), envelope(started, 2), envelope(completed, 3)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );

    const chatMessages = chatMessagesFromChannelView(state);
    expect(chatMessages.map((chatMessage) => chatMessage.id)).toEqual([
      "msg-1",
      "invocation:inv-1",
    ]);
    expect(chatMessages[0]).toMatchObject({
      senderId: "agent-1",
      content: "done",
      complete: true,
    });
    expect(chatMessages[1]).toMatchObject({
      contentType: "invocation",
      complete: true,
      invocation: {
        id: "inv-1",
        name: "read_file",
        arguments: { path: "README.md" },
        execution: { status: "complete", result: "contents" },
      },
    });
  });

  it("projects a notify's escalation onto the message, with the people it addressed", () => {
    const message: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      causality: { messageId: brandId<MessageId>("say:call-1") },
      payload: {
        ...textPayload("say:call-1", "assistant", "Briefing ready"),
        saliency: "say",
        to: [
          { kind: "participant", participantId: "user:gabriel" },
          { kind: "participant", participantId: "do:scribe" },
        ],
        metadata: { notify: { alert: "inbox", title: "Briefing" } },
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const state = [envelope(message, 1)].reduce(reduceChannelView, createInitialChannelViewState());
    const [chatMessage] = chatMessagesFromChannelView(state);
    expect(chatMessage).toMatchObject({
      id: "say:call-1",
      // Only people count as escalation targets; the agent addressee does not.
      escalation: {
        alert: "inbox",
        title: "Briefing",
        users: ["user:gabriel"],
      },
    });
  });

  it("projects assistant model provenance onto chat messages", () => {
    const message: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      causality: { messageId: brandId<MessageId>("msg-model") },
      payload: {
        ...textPayload("msg-model", "assistant", "done"),
        model: {
          ref: "local:lfm2.5-2.6b",
          provider: "local",
          displayName: "LFM2.5 2.6B",
        },
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };

    const state = [envelope(message, 1)].reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      id: "msg-model",
      model: {
        ref: "local:lfm2.5-2.6b",
        provider: "local",
        displayName: "LFM2.5 2.6B",
      },
    });
  });

  it("anchors fork annotation rows at forkPointId instead of creation seq", () => {
    const first: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      causality: { messageId: brandId<MessageId>("msg-1") },
      payload: textPayload("msg-1", "assistant", "first"),
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const second: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      causality: { messageId: brandId<MessageId>("msg-2") },
      payload: textPayload("msg-2", "assistant", "second"),
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const fork: AgenticEvent<"channel.forked"> = {
      kind: "channel.forked",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        parentChannelId: "channel-1",
        forkId: "fork-1",
        forkedChannelId: "fork-1",
        forkedContextId: "ctx-fork",
        forkPointId: 10,
        headSeq: 10,
        label: "Fork",
        reason: "fork",
        actor: agent,
      },
      createdAt: "2026-05-20T12:00:03.000Z",
    };

    const state = [envelope(first, 10), envelope(second, 20), envelope(fork, 30)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );

    expect(chatMessagesFromChannelView(state).map((message) => message.id)).toEqual([
      "msg-1",
      "fork:fork-1",
      "msg-2",
    ]);
  });

  it("does not project an inherited parent fork announcement as a child fork", () => {
    const inherited: AgenticEvent<"channel.forked"> = {
      kind: "channel.forked",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        parentChannelId: "parent-channel",
        forkId: "sibling-fork",
        forkedChannelId: "sibling-channel",
        forkedContextId: "sibling-context",
        forkPointId: 8,
        headSeq: 8,
        label: "Sibling",
        reason: "fork",
        actor: agent,
      },
      createdAt: "2026-05-20T12:00:03.000Z",
    };
    const state = reduceChannelView(createInitialChannelViewState(), envelope(inherited, 9));
    expect(state.forks).toEqual([]);
    expect(chatMessagesFromChannelView(state)).toEqual([]);
  });

  it("recovers docs_open name + args from a catalog-entry result when the tool name is lost", () => {
    // Model tool-calls for docs_* arrive nameless/argless in the invocation event.
    // The catalog shape of result.details lets the projection recover a useful pill
    // ("Docs open · blobstore.getText") instead of a bare "invocation".
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-docs") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "invocation",
        request: {},
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const completed: AgenticEvent<"invocation.completed"> = {
      kind: "invocation.completed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-docs") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        result: {
          content: [{ type: "text", text: "# blobstore.getText  (service)" }],
          details: {
            id: "service:blobstore.getText",
            surface: "service",
            qualifiedName: "blobstore.getText",
            title: "blobstore.getText",
            description: "Full UTF-8 text of a blob, or null if absent.",
          },
        },
        terminalOutcome: "success",
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const state = [envelope(started, 1), envelope(completed, 2)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );
    expect(chatMessagesFromChannelView(state)[0]?.invocation).toMatchObject({
      name: "docs_open",
      arguments: { id: "service:blobstore.getText" },
    });
  });

  it("recovers docs_search name from a catalog-hit array result", () => {
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-search") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "invocation",
        request: {},
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const completed: AgenticEvent<"invocation.completed"> = {
      kind: "invocation.completed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-search") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        result: {
          content: [{ type: "text", text: "2 results" }],
          details: [
            {
              id: "service:blobstore.putText",
              surface: "service",
              qualifiedName: "blobstore.putText",
              title: "blobstore.putText",
            },
            {
              id: "service:blobstore.getText",
              surface: "service",
              qualifiedName: "blobstore.getText",
              title: "blobstore.getText",
            },
          ],
        },
        terminalOutcome: "success",
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const state = [envelope(started, 1), envelope(completed, 2)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );
    expect(chatMessagesFromChannelView(state)[0]?.invocation).toMatchObject({
      name: "docs_search",
    });
  });

  it("recovers docs_search name from an empty catalog-hit result", () => {
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-empty-search") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "invocation",
        request: {},
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const completed: AgenticEvent<"invocation.completed"> = {
      kind: "invocation.completed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-empty-search") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        result: {
          content: [
            {
              type: "text",
              text: 'No catalog matches for "zz-nope". Try broader keywords, or a different surface.',
            },
          ],
          details: [],
        },
        terminalOutcome: "success",
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const state = [envelope(started, 1), envelope(completed, 2)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );
    expect(chatMessagesFromChannelView(state)[0]?.invocation).toMatchObject({
      name: "docs_search",
    });
  });

  it("projects failed invocation error payloads into copyable expanded error data", () => {
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-grep") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "grep",
        request: {
          path: "packages workers panels",
          pattern: "console",
          glob: "*diagnostic*",
        },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const failed: AgenticEvent<"invocation.failed"> = {
      kind: "invocation.failed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-grep") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason:
          "[extensions.invoke] Extension @workspace-extensions/file-tools.grep invocation failed",
        error: {
          text: "Path not found: /packages workers panels. The `path` argument accepts one directory or file.",
          content: [
            {
              type: "text",
              text: "Path not found: /packages workers panels. The `path` argument accepts one directory or file.",
            },
          ],
        },
        terminalOutcome: "tool_error",
        failure: toolFailure("grep", "Path not found"),
        terminalReasonCode: "method_failed",
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };

    const state = [envelope(started, 1), envelope(failed, 2)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );

    const invocation = chatMessagesFromChannelView(state)[0]?.invocation;
    expect(invocation).toMatchObject({
      name: "grep",
      arguments: {
        path: "packages workers panels",
        pattern: "console",
        glob: "*diagnostic*",
      },
      execution: {
        status: "error",
        description:
          "[extensions.invoke] Extension @workspace-extensions/file-tools.grep invocation failed",
        result: {
          text: "Path not found: /packages workers panels. The `path` argument accepts one directory or file.",
        },
      },
    });
  });

  it("projects credential reconnect metadata into credential request cards", () => {
    const state = reduceChannelView(createInitialChannelViewState(), {
      envelopeId: brandId<EnvelopeId>("env-credential-reconnect"),
      channelId: brandId<ChannelId>("channel-1"),
      seq: 1,
      from: participant,
      payloadKind: CREDENTIAL_CONNECT_PAYLOAD_KIND,
      payload: {
        credKey: "cred-openai-codex",
        providerId: "openai-codex",
        connectSpec: { modelRef: "openai-codex:gpt-5.1-codex" },
        modelBaseUrl: "https://chatgpt.com/backend-api/codex",
        reason: "Provided authentication token is expired. Please try signing in again.",
        failureCode: "auth_or_credentials",
        expiresAt: "2026-06-18T13:21:18.000Z",
      },
      contentClass: "internal",
      externalKeys: [],
      publishedAt: "2026-06-18T13:11:18.000Z",
    } satisfies ChannelEnvelope);

    expect(chatMessagesFromChannelView(state)).toEqual([
      expect.objectContaining({
        id: "credential:cred-openai-codex",
        contentType: "credential-connect",
        credentialRequest: expect.objectContaining({
          providerId: "openai-codex",
          modelBaseUrl: "https://chatgpt.com/backend-api/codex",
          reason: "Provided authentication token is expired. Please try signing in again.",
          failureCode: "auth_or_credentials",
        }),
      }),
    ]);
  });

  it("projects UI method invocations with user-facing descriptions", () => {
    const inlineStarted: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-inline") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "inline_ui",
        request: { path: "skills/setup/Panel.tsx", props: { step: "connect" } },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const inlineCompleted: AgenticEvent<"invocation.completed"> = {
      kind: "invocation.completed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-inline") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        result: { ok: true, id: "ui-1" },
        terminalOutcome: "success",
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const feedbackStarted: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-feedback") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "feedback_custom",
        request: {
          title: "Choose deployment target",
          path: "skills/deploy/Picker.tsx",
        },
      },
      createdAt: "2026-05-20T12:00:03.000Z",
    };
    const promptStarted: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-prompt") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "ui_prompt",
        request: { kind: "confirm", title: "Allow extension action?" },
      },
      createdAt: "2026-05-20T12:00:04.000Z",
    };

    const state = [
      envelope(inlineStarted, 1),
      envelope(inlineCompleted, 2),
      envelope(feedbackStarted, 3),
      envelope(promptStarted, 4),
    ].reduce(reduceChannelView, createInitialChannelViewState());

    const descriptions = Object.fromEntries(
      chatMessagesFromChannelView(state).flatMap((message) =>
        message.invocation
          ? [[message.invocation.id, message.invocation.execution.description] as const]
          : []
      )
    );
    expect(descriptions).toMatchObject({
      "inv-inline": "Rendered inline UI (ui-1)",
      "inv-feedback": "Waiting for custom feedback: Choose deployment target",
      "inv-prompt": "Waiting for confirm prompt: Allow extension action?",
    });
  });

  it("projects assistant thinking blocks as inline thinking messages", () => {
    const message: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      causality: { messageId: brandId<MessageId>("msg-thinking") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [
          {
            blockId: brandId<BlockId>("msg-thinking:block:0"),
            type: "thinking",
            content: "I should inspect the repo first.",
          },
          {
            blockId: brandId<BlockId>("msg-thinking:block:1"),
            type: "text",
            content: "Final answer",
          },
        ],
        outcome: "completed",
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };

    const state = [envelope(message, 1)].reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)).toEqual([
      expect.objectContaining({
        id: "thinking:msg-thinking:msg-thinking:block:0",
        contentType: "thinking",
        content: "I should inspect the repo first.",
        complete: true,
      }),
      expect.objectContaining({
        id: "msg-thinking",
        content: "Final answer",
        complete: true,
      }),
    ]);
  });

  it("does not render an empty standalone row for a thinking-only assistant message", () => {
    // Thinking renders via its own inline path; a thinking-only message must not
    // also produce a standalone row with empty display text.
    const message: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      causality: { messageId: brandId<MessageId>("msg-thinking-only") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [
          {
            blockId: brandId<BlockId>("msg-thinking-only:block:0"),
            type: "thinking",
            content: "Just reasoning, no final text.",
          },
        ],
        outcome: "completed",
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };

    const state = [envelope(message, 1)].reduce(reduceChannelView, createInitialChannelViewState());
    const projected = chatMessagesFromChannelView(state);

    expect(projected).toEqual([
      expect.objectContaining({
        id: "thinking:msg-thinking-only:msg-thinking-only:block:0",
        contentType: "thinking",
        content: "Just reasoning, no final text.",
      }),
    ]);
    // No standalone row keyed on the message id (would render an empty bubble).
    expect(projected.some((msg) => msg.id === "msg-thinking-only")).toBe(false);
  });

  it("uses text blocks as visible assistant content when top-level content is empty", () => {
    const message: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      causality: { messageId: brandId<MessageId>("msg-block-text") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [
          {
            blockId: brandId<BlockId>("msg-block-text:block:0"),
            type: "text",
            content: "I found the relevant code path.",
          },
        ],
        outcome: "completed",
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };

    const state = [envelope(message, 1)].reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)).toEqual([
      expect.objectContaining({
        id: "msg-block-text",
        content: "I found the relevant code path.",
        complete: true,
      }),
    ]);
  });

  it("carries an explicit message tier through the projection, overriding the fallback", () => {
    // Text-only assistant message — the fallback would call this primary, but an
    // explicit tier on the wire (stamped by the sender) must win.
    const message: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      causality: { messageId: brandId<MessageId>("msg-explicit") },
      payload: {
        ...textPayload("msg-explicit", "assistant", "noted"),
        tier: "secondary",
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const state = [envelope(message, 1)].reduce(reduceChannelView, createInitialChannelViewState());
    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      id: "msg-explicit",
      tier: "secondary",
    });
  });

  it("defaults an unstamped text-only assistant answer to the primary tier", () => {
    const message: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      causality: { messageId: brandId<MessageId>("msg-primary") },
      payload: textPayload("msg-primary", "assistant", "the answer"),
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const state = [envelope(message, 1)].reduce(reduceChannelView, createInitialChannelViewState());
    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      tier: "primary",
    });
  });

  it("does not infer a secondary tier from unstamped assistant content", () => {
    const message: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      causality: { messageId: brandId<MessageId>("msg-unstamped") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [
          {
            blockId: brandId<BlockId>("msg-unstamped:block:0"),
            type: "text",
            content: "let me check",
          },
          { type: "toolCall", id: "tc-9", name: "read" } as never,
        ],
        outcome: "completed",
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const state = [envelope(message, 1)].reduce(reduceChannelView, createInitialChannelViewState());
    const standalone = chatMessagesFromChannelView(state).find((m) => m.id === "msg-unstamped");
    expect(standalone).toMatchObject({ tier: "primary" });
  });

  it("uses the invocation card instead of a blank assistant card for known invocation-only messages", () => {
    const message: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      causality: { messageId: brandId<MessageId>("msg-tool-only") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [
          {
            blockId: brandId<BlockId>("msg-tool-only:block:0"),
            type: "invocation",
            invocationId: brandId<InvocationId>("call-1"),
          },
        ],
        outcome: "tool_calls_only",
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const invocation: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("call-1") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "eval",
        request: { code: "1 + 1" },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [message, invocation]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state).map((chatMessage) => chatMessage.id)).toEqual([
      "invocation:call-1",
    ]);
  });

  it("suppresses standalone text for unknown invocation-only assistant messages", () => {
    const message: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      causality: { messageId: brandId<MessageId>("msg-unknown-tool-only") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [
          {
            blockId: brandId<BlockId>("msg-unknown-tool-only:block:0"),
            type: "invocation",
            invocationId: brandId<InvocationId>("missing-call"),
          },
        ],
        outcome: "tool_calls_only",
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };

    const state = [envelope(message, 1)].reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)).toEqual([]);
  });

  it("projects published message.failed reasons as visible transcript errors", () => {
    const messageId = brandId<MessageId>("msg-provider-failed");
    const completed: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      causality: { messageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [],
        outcome: "empty",
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const failed: AgenticEvent<"message.failed"> = {
      kind: "message.failed",
      actor: agent,
      causality: { messageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "provider stream failed",
        recoverable: true,
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [envelope(completed, 1), envelope(failed, 2)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );

    expect(chatMessagesFromChannelView(state)).toEqual([
      expect.objectContaining({
        id: "diagnostic:msg-provider-failed",
        content: "provider stream failed",
        contentType: "diagnostic",
        error: "provider stream failed",
        complete: true,
      }),
    ]);
  });

  it("projects reset-aware model failures with scheduling metadata", () => {
    const messageId = brandId<MessageId>("msg-usage-limit");
    const failed: AgenticEvent<"message.failed"> = {
      kind: "message.failed",
      actor: agent,
      causality: { messageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason:
          "The usage limit has been reached for GPT-5.3-Codex-Spark. Try again after Jun 15, 2026 at 6:35 PM UTC.",
        recoverable: false,
        code: "usage_limit_terminal",
        resetAt: "2026-06-15T18:35:01.000Z",
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [envelope(failed, 1)].reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)).toEqual([
      expect.objectContaining({
        id: "diagnostic:msg-usage-limit",
        contentType: "diagnostic",
        diagnostic: expect.objectContaining({
          messageId: "msg-usage-limit",
          title: "Model usage limit reached",
          failureCode: "usage_limit_terminal",
          resetAt: "2026-06-15T18:35:01.000Z",
          recoverable: false,
        }),
      }),
    ]);
  });

  it("projects context overflow model failures with a specific title", () => {
    const messageId = brandId<MessageId>("msg-local-overflow");
    const failed: AgenticEvent<"message.failed"> = {
      kind: "message.failed",
      actor: agent,
      causality: { messageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason:
          "400 request (18364 tokens) exceeds the available context size (16384 tokens), try increasing it",
        recoverable: false,
        code: "context_overflow_terminal",
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [envelope(failed, 1)].reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)).toEqual([
      expect.objectContaining({
        id: "diagnostic:msg-local-overflow",
        contentType: "diagnostic",
        diagnostic: expect.objectContaining({
          messageId: "msg-local-overflow",
          title: "Context window exceeded",
          failureCode: "context_overflow_terminal",
          recoverable: false,
        }),
      }),
    ]);
  });

  it("replaces typing with a visible diagnostic for terminal tool-schema failures", () => {
    const turnId = brandId<TurnId>("turn-invalid-tool-schema");
    const messageId = brandId<MessageId>("msg-invalid-tool-schema");
    const reason =
      "Codex error: Invalid schema for function 'client_eval': True is not of type 'number'.";
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const failed: AgenticEvent<"message.failed"> = {
      kind: "message.failed",
      actor: agent,
      turnId,
      causality: { messageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason,
        recoverable: false,
        code: "request_invalid_terminal",
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const closed: AgenticEvent<"turn.closed"> = {
      kind: "turn.closed",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, reason: "work_failed" },
      createdAt: "2026-05-20T12:00:02.000Z",
    };

    const state = [opened, failed, closed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());
    const messages = chatMessagesFromChannelView(state);

    expect(messages).toEqual([
      expect.objectContaining({
        id: "diagnostic:msg-invalid-tool-schema",
        contentType: "diagnostic",
        complete: true,
        diagnostic: expect.objectContaining({
          title: "Invalid model request",
          failureCode: "request_invalid_terminal",
          detail: reason,
          recoverable: false,
        }),
      }),
    ]);
    expect(messages.some((message) => message.contentType === "typing")).toBe(false);
  });

  it("distinguishes internal infrastructure failures from invalid model requests", () => {
    const turnId = brandId<TurnId>("turn-internal-setup");
    const messageId = brandId<MessageId>("msg-internal-setup");
    const failed: AgenticEvent<"message.failed"> = {
      kind: "message.failed",
      actor: agent,
      turnId,
      causality: { messageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "Vibestudio model setup invariant failed",
        recoverable: false,
        code: "infrastructure_terminal",
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const state = [failed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)).toEqual([
      expect.objectContaining({
        id: "diagnostic:msg-internal-setup",
        diagnostic: expect.objectContaining({
          title: "Vibestudio service failed",
          failureCode: "infrastructure_terminal",
        }),
      }),
    ]);
  });

  it("projects exhausted model retries with a specific title and code", () => {
    const messageId = brandId<MessageId>("diag-model-retries");
    const detail =
      "Model retry limit reached for t:chan-1:env-1: 3 consecutive model failures occurred.";
    const completed: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      causality: { messageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [
          {
            blockId: brandId<BlockId>("diag-model-retries:block:0"),
            type: "diagnostic",
            content: detail,
            metadata: {
              code: "model_retry_limit_exceeded",
              severity: "error",
              limit: 3,
              consecutiveModelFailureCount: 3,
              turnId: "t:chan-1:env-1",
            },
          },
        ],
        outcome: "completed",
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };

    const state = [envelope(completed, 1)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );

    expect(chatMessagesFromChannelView(state)).toEqual([
      expect.objectContaining({
        id: "diagnostic:diag-model-retries",
        content: detail,
        contentType: "diagnostic",
        diagnostic: expect.objectContaining({
          code: "model_retry_limit_exceeded",
          severity: "error",
          title: "Model retry limit reached",
        }),
        error: detail,
      }),
    ]);
  });

  it("surfaces runner-restart no-response turns as lifecycle notices", () => {
    const turnId = brandId<TurnId>("turn-no-response");
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      turnId,
      causality: { invocationId: brandId<InvocationId>("inv-stalled") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "eval",
        request: { code: "run()" },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const abandoned: AgenticEvent<"invocation.abandoned"> = {
      kind: "invocation.abandoned",
      actor: agent,
      turnId,
      causality: { invocationId: brandId<InvocationId>("inv-stalled") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "Runner restarted before invocation completed",
        terminalOutcome: "abandoned",
        terminalReasonCode: "runner_restarted_before_invocation_completed",
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const closed: AgenticEvent<"turn.closed"> = {
      kind: "turn.closed",
      actor: agent,
      turnId,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "runner_restarted",
      },
      createdAt: "2026-05-20T12:00:03.000Z",
    };

    const state = [opened, started, abandoned, closed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state).map((message) => message.id)).toEqual([
      "invocation:inv-stalled",
      "turn:turn-no-response:recovered",
    ]);
    expect(chatMessagesFromChannelView(state)[1]).toMatchObject({
      contentType: "lifecycle",
      kind: "system",
      lifecycle: {
        status: "recovered",
        title: "Recovered after restart",
        detail: "The turn closed cleanly, but there was no assistant response to show.",
      },
      complete: true,
    });
  });

  it("renders restart-aborted tool dispatch as a visible interrupted invocation", () => {
    const turnId = brandId<TurnId>("turn-restart-aborted-tool");
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      turnId,
      causality: {
        invocationId: brandId<InvocationId>("inv-aborted-dispatch"),
      },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "eval",
        request: { code: "run()" },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const cancelled: AgenticEvent<"invocation.cancelled"> = {
      kind: "invocation.cancelled",
      actor: agent,
      turnId,
      causality: {
        invocationId: brandId<InvocationId>("inv-aborted-dispatch"),
      },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "Agent turn was interrupted before tool dispatch.",
        recoverable: true,
        terminalOutcome: "stale_dispatch",
        terminalReasonCode: "aborted_before_dispatch",
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const closed: AgenticEvent<"turn.closed"> = {
      kind: "turn.closed",
      actor: agent,
      turnId,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "runner_restarted",
      },
      createdAt: "2026-05-20T12:00:03.000Z",
    };

    const state = [opened, started, cancelled, closed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state).map((message) => message.id)).toEqual([
      "invocation:inv-aborted-dispatch",
      "turn:turn-restart-aborted-tool:recovered",
    ]);
    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      contentType: "invocation",
      complete: true,
      invocation: {
        id: "inv-aborted-dispatch",
        execution: {
          status: "cancelled",
          terminalOutcome: "stale_dispatch",
          terminalReasonCode: "aborted_before_dispatch",
          isError: false,
        },
      },
    });
  });

  it("projects restart diagnostics as lifecycle notices", () => {
    const message: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: {
        ...agent,
        metadata: {
          vibestudioDiagnostic: {
            type: "lifecycle_recovery",
            status: "interrupted",
            title: "Restart interrupted the response",
            detail:
              "The partial response was discarded because replay is not enabled for this agent.",
            reason: "runner_restarted_mid_model",
          },
        },
      },
      causality: { messageId: brandId<MessageId>("msg-restart") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [
          {
            blockId: brandId<BlockId>("msg-restart:block:0"),
            type: "text",
            content: "Agent turn was interrupted during model generation.",
          },
        ],
        outcome: "completed",
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };

    const state = [envelope(message, 1)].reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      id: "msg-restart",
      contentType: "lifecycle",
      kind: "system",
      lifecycle: {
        status: "interrupted",
        title: "Restart interrupted the response",
        reason: "runner_restarted_mid_model",
      },
    });
  });

  it("suppresses recoverable restart cleanup failures while the retry remains active", () => {
    const turnId = brandId<TurnId>("turn-restart-retry-active");
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const started: AgenticEvent<"message.started"> = {
      kind: "message.started",
      actor: agent,
      turnId,
      causality: { messageId: brandId<MessageId>("msg-before-restart") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant" },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const failed: AgenticEvent<"message.failed"> = {
      kind: "message.failed",
      actor: agent,
      turnId,
      causality: { messageId: brandId<MessageId>("msg-before-restart") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "interrupted by restart",
        recoverable: true,
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const retryStarted: AgenticEvent<"message.started"> = {
      kind: "message.started",
      actor: agent,
      turnId,
      causality: { messageId: brandId<MessageId>("msg-after-restart") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant" },
      createdAt: "2026-05-20T12:00:03.000Z",
    };

    const state = [opened, started, failed, retryStarted]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    const messages = chatMessagesFromChannelView(state);
    expect(messages.map((message) => message.id)).toEqual(["turn:turn-restart-retry-active"]);
    expect(messages[0]).toMatchObject({
      contentType: "typing",
      complete: false,
    });
    expect(messages[0]?.error).toBeUndefined();
  });

  it("surfaces completed turns whose only assistant message is empty", () => {
    const turnId = brandId<TurnId>("turn-empty-assistant");
    const messageId = brandId<MessageId>("msg-empty-assistant");
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const completed: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      turnId,
      causality: { messageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [],
        outcome: "empty",
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const closed: AgenticEvent<"turn.closed"> = {
      kind: "turn.closed",
      actor: agent,
      turnId,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        summary: "Agent turn completed",
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };

    const state = [opened, completed, closed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state).map((message) => message.id)).toEqual([
      "diagnostic:msg-empty-assistant",
    ]);
    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      content: "Assistant message had no visible content.",
      contentType: "diagnostic",
    });
  });

  it("renders empty failed assistant messages by failure reason instead of no-response", () => {
    const turnId = brandId<TurnId>("turn-empty-failed-assistant");
    const messageId = brandId<MessageId>("msg-empty-failed-assistant");
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const failed: AgenticEvent<"message.failed"> = {
      kind: "message.failed",
      actor: agent,
      turnId,
      causality: { messageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "provider stream failed",
        recoverable: true,
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const closed: AgenticEvent<"turn.closed"> = {
      kind: "turn.closed",
      actor: agent,
      turnId,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        summary: "Agent turn completed",
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };

    const state = [opened, failed, closed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state).map((message) => message.id)).toEqual([
      "diagnostic:msg-empty-failed-assistant",
    ]);
    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      content: "provider stream failed",
      contentType: "diagnostic",
      error: "provider stream failed",
    });
  });

  it("does not add a no-response error when the turn produced inline UI", () => {
    const turnId = brandId<TurnId>("turn-inline-ui");
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const inline: AgenticEvent<"ui.inline_rendered"> = {
      kind: "ui.inline_rendered",
      actor: agent,
      turnId,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "inline",
        id: "credential-refresh",
        source: {
          type: "code",
          code: "export default function CredentialRefresh() { return null; }",
        },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const closed: AgenticEvent<"turn.closed"> = {
      kind: "turn.closed",
      actor: agent,
      turnId,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        summary: "Agent turn completed",
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };

    const state = [opened, inline, closed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state).map((message) => message.id)).toEqual([
      "inline-ui:participant-agent-1:credential-refresh",
    ]);
  });

  it("does not add a no-response error for turns waiting on model credentials", () => {
    const turnId = brandId<TurnId>("turn-model-credential");
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const waiting: AgenticEvent<"turn.waiting"> = {
      kind: "turn.waiting",
      actor: agent,
      turnId,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "model_credential_required",
        summary: "Waiting for model credential connection",
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const closed: AgenticEvent<"turn.closed"> = {
      kind: "turn.closed",
      actor: agent,
      turnId,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        summary: "Agent turn completed",
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };

    const state = [opened, waiting, closed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)).toEqual([]);
  });

  it("projects a waiting (parked) turn as a first-class 'Waiting' lifecycle notice", () => {
    const turnId = brandId<TurnId>("turn-waiting-credential");
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const waiting: AgenticEvent<"turn.waiting"> = {
      kind: "turn.waiting",
      actor: agent,
      turnId,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "model_credential_required",
        summary: "Waiting for model credential approval",
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [opened, waiting]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    const card = chatMessagesFromChannelView(state).find(
      (m) => m.id === "turn:turn-waiting-credential:waiting"
    );
    expect(card).toMatchObject({
      contentType: "lifecycle",
      content: "Waiting for model credential approval",
      turnId,
      lifecycle: {
        status: "waiting",
        title: "Waiting for model credential approval",
      },
    });
    // It is a waiting indicator, not an error.
    expect(card?.error).toBeUndefined();
  });

  it("suppresses credential-suspension message failures in favor of the waiting card", () => {
    const turnId = brandId<TurnId>("turn-credential-suspended");
    const messageId = brandId<MessageId>("msg-credential-suspended");
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const started: AgenticEvent<"message.started"> = {
      kind: "message.started",
      actor: agent,
      turnId,
      causality: { messageId },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant" },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const failed: AgenticEvent<"message.failed"> = {
      kind: "message.failed",
      actor: agent,
      turnId,
      causality: { messageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "model_credential_required",
        recoverable: true,
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const waiting: AgenticEvent<"turn.waiting"> = {
      kind: "turn.waiting",
      actor: agent,
      turnId,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "model_credential_required",
        summary: "Waiting for model credential approval",
      },
      createdAt: "2026-05-20T12:00:03.000Z",
    };

    const state = [opened, started, failed, waiting]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state).map((message) => message.id)).toEqual([
      "turn:turn-credential-suspended:waiting",
    ]);
  });

  it("clears a credential waiting notice when the same turn becomes active again", () => {
    const turnId = brandId<TurnId>("turn-resumed-same-credential");
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const waiting: AgenticEvent<"turn.waiting"> = {
      kind: "turn.waiting",
      actor: agent,
      turnId,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "model_credential_required",
        summary: "Waiting for model credential approval",
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const resumed: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:03.000Z",
    };

    const waitingState = [opened, waiting]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());
    expect(chatMessagesFromChannelView(waitingState).map((message) => message.id)).toEqual([
      "turn:turn-resumed-same-credential:waiting",
    ]);

    const resumedState = [opened, waiting, resumed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());
    expect(chatMessagesFromChannelView(resumedState).map((message) => message.id)).toEqual([
      "turn:turn-resumed-same-credential",
    ]);
    expect(chatMessagesFromChannelView(resumedState)[0]).toMatchObject({
      contentType: "typing",
      complete: false,
    });
  });

  it("shows typing when a credential wait resumes with a new model call", () => {
    const turnId = brandId<TurnId>("turn-resumed-credential-model-call");
    const credKey = "cred:channel-1:openai-codex";
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const waiting: AgenticEvent<"turn.waiting"> = {
      kind: "turn.waiting",
      actor: agent,
      turnId,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "model_credential_reconnect_required",
        summary: "Waiting for model credential reconnect",
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const resolved: AgenticEvent<"system.event"> = {
      kind: "system.event",
      actor: agent,
      turnId,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        kind: "credential.wait_resolved",
        details: {
          kind: "credential.wait_resolved",
          credKey,
          providerId: "openai-codex",
          resolved: true,
        },
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const resumed: AgenticEvent<"message.started"> = {
      kind: "message.started",
      actor: agent,
      turnId,
      causality: { messageId: brandId<MessageId>("msg-resumed-model-call") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant" },
      createdAt: "2026-05-20T12:00:03.000Z",
    };

    const state = [opened, waiting, resolved, resumed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state).map((message) => message.id)).toEqual([
      "turn:turn-resumed-credential-model-call",
    ]);
    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      contentType: "typing",
      complete: false,
    });
  });

  it("does not surface user-interrupted agent turns as no-response errors", () => {
    const turnId = brandId<TurnId>("turn-interrupted");
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      turnId,
      causality: { invocationId: brandId<InvocationId>("inv-cancelled") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "eval",
        request: { code: "run()" },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const cancelled: AgenticEvent<"invocation.cancelled"> = {
      kind: "invocation.cancelled",
      actor: agent,
      turnId,
      causality: { invocationId: brandId<InvocationId>("inv-cancelled") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "User interrupted execution",
        terminalOutcome: "cancelled",
        terminalReasonCode: "user_interrupted",
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const closed: AgenticEvent<"turn.closed"> = {
      kind: "turn.closed",
      actor: agent,
      turnId,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        summary: "Turn closed after user interruption",
        reason: "user_interrupted",
      },
      createdAt: "2026-05-20T12:00:03.000Z",
    };

    const state = [opened, started, cancelled, closed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());
    const messages = chatMessagesFromChannelView(state);

    expect(messages.map((message) => message.id)).toEqual(["invocation:inv-cancelled"]);
    expect(messages[0]?.invocation?.execution.status).toBe("cancelled");
    expect(messages[0]?.complete).toBe(true);
  });

  it("does not surface fork-cleanup turns as no-response errors", () => {
    const turnId = brandId<TurnId>("turn-forked");
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      turnId,
      causality: { invocationId: brandId<InvocationId>("inv-forked") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, name: "spawn_subagent" },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const abandoned: AgenticEvent<"invocation.abandoned"> = {
      kind: "invocation.abandoned",
      actor: agent,
      turnId,
      causality: { invocationId: brandId<InvocationId>("inv-forked") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "forked",
        terminalOutcome: "abandoned",
        terminalReasonCode: "forked",
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const closed: AgenticEvent<"turn.closed"> = {
      kind: "turn.closed",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, reason: "forked" },
      createdAt: "2026-05-20T12:00:03.000Z",
    };

    const state = [opened, started, abandoned, closed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());
    const messages = chatMessagesFromChannelView(state);

    expect(messages.map((message) => message.id)).toEqual(["invocation:inv-forked"]);
    expect(messages[0]?.invocation?.execution.status).toBe("abandoned");
    expect(messages[0]?.complete).toBe(true);
  });

  it("preserves invocation name and arguments when only completion is projected", () => {
    const completed: AgenticEvent<"invocation.completed"> = {
      kind: "invocation.completed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("call-1") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        result: {
          toolCallId: "call-1",
          toolName: "eval",
          details: { input: { code: "1 + 1" } },
          content: [{ type: "text", text: "2" }],
        },
        summary: "2",
        terminalOutcome: "success",
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };

    const state = [envelope(completed, 1)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );

    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      contentType: "invocation",
      invocation: {
        id: "call-1",
        name: "eval",
        arguments: { code: "1 + 1" },
        execution: { status: "complete" },
      },
    });
  });

  it("rejects stored refs before semantic chat projection", () => {
    const storedResult = {
      protocol: "vibestudio.blob-ref.v1" as const,
      digest: "digest-result",
      size: 1024,
      encoding: "json" as const,
      originalBytes: 1024,
    };
    const storedRequest = {
      protocol: "vibestudio.blob-ref.v1" as const,
      digest: "digest-request",
      size: 512,
      encoding: "json" as const,
      originalBytes: 512,
    };
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("call-stored") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "eval",
        request: storedRequest,
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const completed: AgenticEvent<"invocation.completed"> = {
      kind: "invocation.completed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("call-stored") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        result: storedResult,
        terminalOutcome: "success",
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };

    expect(() =>
      [envelope(started, 1), envelope(completed, 2)].reduce(
        reduceChannelView,
        createInitialChannelViewState()
      )
    ).toThrow(/contains unresolved stored value refs/);
  });

  it("projects invocation progress, output, and errors without losing the exact invocation name", () => {
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-error") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "shell.exec",
        request: { cmd: "pnpm test" },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const progress: AgenticEvent<"invocation.progress"> = {
      kind: "invocation.progress",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-error") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        message: "Running tests",
        progress: 0.5,
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const output: AgenticEvent<"invocation.output"> = {
      kind: "invocation.output",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-error") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, output: "stderr line" },
      createdAt: "2026-05-20T12:00:03.000Z",
    };
    const failed: AgenticEvent<"invocation.failed"> = {
      kind: "invocation.failed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-error") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "exit code 1",
        terminalOutcome: "tool_error",
        terminalReasonCode: "eval_exception",
        failure: toolFailure("eval", "exit code 1"),
      },
      createdAt: "2026-05-20T12:00:04.000Z",
    };

    const state = [started, progress, output, failed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(state.invocations["inv-error"]?.progress).toEqual([
      expect.objectContaining({ message: "Running tests", progress: 0.5 }),
    ]);
    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      contentType: "invocation",
      complete: true,
      invocation: {
        id: "inv-error",
        name: "shell.exec",
        arguments: { cmd: "pnpm test" },
        execution: {
          status: "error",
          description: "exit code 1",
          consoleOutput: "stderr line",
          isError: true,
        },
      },
    });
  });

  it("renders structured console stream output as log lines instead of raw JSON", () => {
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-console") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "eval",
        request: { code: 'console.log("hello")' },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const outputs: Array<AgenticEvent<"invocation.output">> = [
      {
        kind: "invocation.output",
        actor: agent,
        causality: { invocationId: brandId<InvocationId>("inv-console") },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          output: { type: "console", content: "hello world" },
        },
        createdAt: "2026-05-20T12:00:02.000Z",
      },
      {
        kind: "invocation.output",
        actor: agent,
        causality: { invocationId: brandId<InvocationId>("inv-console") },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          output: { type: "console", level: "warn", content: "careful" },
        },
        createdAt: "2026-05-20T12:00:03.000Z",
      },
      {
        kind: "invocation.output",
        actor: agent,
        causality: { invocationId: brandId<InvocationId>("inv-console") },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          output: { type: "console", level: "error", content: "boom" },
        },
        createdAt: "2026-05-20T12:00:04.000Z",
      },
    ];
    const completed: AgenticEvent<"invocation.completed"> = {
      kind: "invocation.completed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-console") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        result: { content: [{ type: "text", text: "[eval] (no output)" }] },
        terminalOutcome: "success",
      },
      createdAt: "2026-05-20T12:00:05.000Z",
    };

    const state = [started, ...outputs, completed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      contentType: "invocation",
      invocation: {
        id: "inv-console",
        execution: {
          consoleOutput: "hello world\n[WARN] careful\n[ERROR] boom",
        },
      },
    });
  });

  it("preserves provider method names and streamed output across cross-participant invocation events", () => {
    const provider = {
      kind: "panel" as const,
      id: "provider-1",
      displayName: "Provider",
    };
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-provider") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "mcp__workspace__ListDirectory",
        request: { path: "src" },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const output: AgenticEvent<"invocation.output"> = {
      kind: "invocation.output",
      actor: provider,
      causality: { invocationId: brandId<InvocationId>("inv-provider") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        output: "src/index.ts",
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const completed: AgenticEvent<"invocation.completed"> = {
      kind: "invocation.completed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-provider") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        result: {
          toolCallId: "inv-provider",
          toolName: "mcp__workspace__ListDirectory",
          details: { input: { path: "src" } },
          content: [{ type: "text", text: "src/index.ts" }],
        },
        terminalOutcome: "success",
      },
      createdAt: "2026-05-20T12:00:03.000Z",
    };

    const providerEnvelope = {
      ...envelope(output, 2),
      from: { ...provider, participantId: "provider-1" },
    };
    const state = [envelope(started, 1), providerEnvelope, envelope(completed, 3)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );

    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      contentType: "invocation",
      invocation: {
        id: "inv-provider",
        name: "mcp__workspace__ListDirectory",
        arguments: { path: "src" },
        execution: {
          status: "complete",
          consoleOutput: "src/index.ts",
        },
      },
    });
  });

  it("projects a started subagent card without progress as running", () => {
    const started: AgenticEvent<"task.started"> = {
      kind: "task.started",
      actor: agent,
      causality: { taskId: brandId<TaskId>("inv-subagent-started") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        taskType: "subagent",
        title: "background fork",
        details: {
          subagent: {
            runId: "inv-subagent-started",
            mode: "fork",
            taskChannelId: "task-inv-subagent-started",
            contextId: "ctx-inv-subagent-started",
            parentContextId: "ctx-parent",
            childParticipantId: "participant-subagent-started",
            label: "background fork",
          },
        },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [envelope(started, 1)].reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      contentType: "task",
      task: {
        id: "inv-subagent-started",
        execution: { status: "running" },
        subagent: { parentContextId: "ctx-parent" },
      },
    });
  });

  it.each([undefined, "", "   "])(
    "does not project unbound subagent details for participant identity %j",
    (childParticipantId) => {
      const started = {
        kind: "task.started",
        actor: agent,
        causality: { taskId: brandId<TaskId>("inv-unbound-subagent") },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          taskType: "subagent",
          title: "unbound child",
          details: {
            subagent: {
              runId: "inv-unbound-subagent",
              taskChannelId: "task-inv-unbound-subagent",
              ...(childParticipantId === undefined ? {} : { childParticipantId }),
            },
          },
        },
        createdAt: "2026-05-20T12:00:01.000Z",
      } as unknown as AgenticEvent<"task.started">;

      const state = [envelope(started, 1)].reduce(
        reduceChannelView,
        createInitialChannelViewState(),
      );

      expect(chatMessagesFromChannelView(state)[0]?.task?.subagent).toBeUndefined();
    },
  );

  it("uses the actor display name for a terminal-only task", () => {
    const completed: AgenticEvent<"task.completed"> = {
      kind: "task.completed",
      actor: { ...agent, displayName: "Subagent" },
      causality: { taskId: brandId<TaskId>("terminal-only") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        terminalOutcome: "success",
        summary: "Finished the assigned work.",
        result: { protocolContent: [{ type: "text", text: "Finished the assigned work." }] },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [envelope(completed, 1)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );

    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      contentType: "task",
      task: {
        title: "Subagent",
        execution: {
          status: "complete",
          description: "Finished the assigned work.",
        },
      },
    });
  });

  it("keeps the completed spawn invocation separate from the running child task", () => {
    const invocationId = brandId<InvocationId>("spawn-separated");
    const taskId = brandId<TaskId>("spawn-separated");
    const events: AgenticEvent[] = [
      {
        kind: "invocation.started",
        actor: agent,
        causality: { invocationId },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          name: "spawn_subagent",
          request: { task: "audit the repo" },
        },
        createdAt: "2026-05-20T12:00:01.000Z",
      },
      {
        kind: "task.started",
        actor: agent,
        causality: { taskId, invocationId },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          taskType: "subagent",
          title: "repo audit",
          details: {
            subagent: {
              runId: "spawn-separated",
              mode: "fresh",
              taskChannelId: "task-spawn-separated",
              contextId: "ctx-spawn-separated",
              childParticipantId: "participant-spawn-separated",
              label: "repo audit",
            },
          },
        },
        createdAt: "2026-05-20T12:00:02.000Z",
      },
      {
        kind: "invocation.completed",
        actor: agent,
        causality: { invocationId },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          result: { details: { runId: "spawn-separated", status: "running" } },
          terminalOutcome: "success",
        },
        createdAt: "2026-05-20T12:00:03.000Z",
      },
    ];
    const state = events
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());
    const messages = chatMessagesFromChannelView(state);

    expect(messages.find((message) => message.contentType === "invocation")).toMatchObject({
      complete: true,
      invocation: { id: "spawn-separated", execution: { status: "complete" } },
    });
    expect(messages.find((message) => message.contentType === "task")).toMatchObject({
      complete: false,
      task: {
        id: "spawn-separated",
        taskType: "subagent",
        execution: { status: "running" },
      },
    });
  });

  it("keeps one canonical invocation card across duplicate channel starts and late terminal output", () => {
    const startedByModel: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("tool-1") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "eval",
        request: { code: "await work()" },
        userVisible: true,
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const startedByChannel: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: { kind: "system", id: "system" },
      causality: {
        invocationId: brandId<InvocationId>("tool-1"),
        transportCallId: "transport-1",
      },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "unknown",
        request: {},
        userVisible: false,
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const cancelled: AgenticEvent<"invocation.cancelled"> = {
      kind: "invocation.cancelled",
      actor: { kind: "system", id: "system" },
      causality: {
        invocationId: brandId<InvocationId>("tool-1"),
        transportCallId: "transport-1",
      },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "cancelled",
        terminalOutcome: "cancelled",
        terminalReasonCode: "cancelled",
      },
      createdAt: "2026-05-20T12:00:03.000Z",
    };
    const lateCompleted: AgenticEvent<"invocation.completed"> = {
      kind: "invocation.completed",
      actor: agent,
      causality: {
        invocationId: brandId<InvocationId>("tool-1"),
        transportCallId: "transport-1",
      },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        result: { ok: true },
        terminalOutcome: "success",
      },
      createdAt: "2026-05-20T12:00:04.000Z",
    };

    const state = [startedByModel, startedByChannel, cancelled, lateCompleted]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      contentType: "invocation",
      invocation: {
        id: "tool-1",
        name: "eval",
        arguments: { code: "await work()" },
        execution: {
          status: "cancelled",
          description: "cancelled",
        },
      },
    });
  });

  it("projects durable open turns into typing transcript items and removes them when closed", () => {
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "started" },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const closed: AgenticEvent<"turn.closed"> = {
      kind: "turn.closed",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "done" },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const openState = [envelope(opened, 1)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );
    expect(chatMessagesFromChannelView(openState)[0]).toMatchObject({
      id: "turn:turn-1",
      contentType: "typing",
      complete: false,
      senderId: "agent-1",
    });

    const closedState = [envelope(opened, 1), envelope(closed, 2)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );
    expect(
      chatMessagesFromChannelView(closedState).some((msg) => msg.contentType === "typing")
    ).toBe(false);
  });

  it("projects scheduled automation provenance into a durable inspectable history row", () => {
    const automation = {
      missionId: "mission-daily",
      runId: "run-42",
      name: "Daily check",
      revision: 3,
      action: "eval" as const,
      trigger: "scheduled" as const,
      startedAt: Date.parse("2026-05-20T12:00:00.000Z"),
      createdAt: Date.parse("2026-05-01T09:00:00.000Z"),
      activatedAt: Date.parse("2026-05-02T09:00:00.000Z"),
      runNumber: 7,
      schedule: {
        kind: "cron" as const,
        expression: "5 5 * * THU",
        timezone: "America/New_York",
        untilAt: Date.parse("2027-01-01T05:00:00.000Z"),
        maxRuns: 12,
      },
    };
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId: brandId<TurnId>("turn-automation"),
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        metadata: { origin: "scheduled", automation },
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const closed: AgenticEvent<"turn.closed"> = {
      kind: "turn.closed",
      actor: agent,
      turnId: brandId<TurnId>("turn-automation"),
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        summary: "42 checks passed",
        metadata: { origin: "scheduled", automation },
      },
      createdAt: "2026-05-20T12:00:03.000Z",
    };

    const state = [opened, closed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)).toContainEqual(
      expect.objectContaining({
        id: "automation:run-42",
        contentType: "automation",
        automation: {
          snapshot: automation,
          status: "succeeded",
          openedAt: "2026-05-20T12:00:00.000Z",
          closedAt: "2026-05-20T12:00:03.000Z",
          summary: "42 checks passed",
        },
      })
    );
  });

  it("projects a running automation at institution time before any run exists", () => {
    const instituted: AgenticEvent<"automation.instituted"> = {
      kind: "automation.instituted",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        definition: {
          missionId: "mission-weekly",
          name: "Weekly review",
          summary: "Review the project every Thursday.",
          revision: 1,
          action: "prompt",
          state: "active",
          createdAt: Date.parse("2026-05-20T12:00:00.000Z"),
          schedule: {
            kind: "cron",
            expression: "5 5 * * THU",
            timezone: "America/New_York",
          },
        },
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const state = reduceChannelView(createInitialChannelViewState(), envelope(instituted, 7));

    expect(chatMessagesFromChannelView(state)).toContainEqual(
      expect.objectContaining({
        id: "automation:instituted:mission-weekly",
        seq: 7,
        contentType: "automation",
        complete: true,
        automationDefinition: {
          snapshot: instituted.payload.definition,
          institutedAt: instituted.createdAt,
        },
      })
    );
  });

  it("orders open turn typing by the latest event in that turn", () => {
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "started" },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const olderMessage: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: { kind: "user", id: "user-1", displayName: "User One" },
      causality: { messageId: brandId<MessageId>("msg-1") },
      payload: textPayload("msg-1", "user", "hi"),
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const invocation: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      causality: { invocationId: brandId<InvocationId>("inv-1") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "read",
        request: { path: "skills/onboarding/SKILL.md" },
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };

    const state = [opened, olderMessage, invocation]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state).map((message) => message.id)).toEqual([
      "msg-1",
      "invocation:inv-1",
      "turn:turn-1",
    ]);
  });

  it("keeps the open-turn typing pill visible while an assistant message is streaming in that turn", () => {
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "started" },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const started: AgenticEvent<"message.started"> = {
      kind: "message.started",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      causality: { messageId: brandId<MessageId>("msg-1") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [
          {
            blockId: brandId<BlockId>("msg-1:block:0"),
            type: "text",
            content: "partial",
          },
        ],
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [opened, started]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    const result = chatMessagesFromChannelView(state);
    // The streaming assistant message renders...
    expect(result.find((message) => message.id === "msg-1")).toMatchObject({
      content: "partial",
      complete: false,
    });
    // ...AND the open-turn typing pill stays visible alongside it — it is no longer suppressed during
    // streaming, so the "agent is working" signal doesn't flicker off every time a bubble streams.
    expect(result.some((message) => message.contentType === "typing")).toBe(true);
  });

  it("uses failure payload metadata when only a terminal invocation failure is available", () => {
    const failed: AgenticEvent<"invocation.failed"> = {
      kind: "invocation.failed",
      actor: agent,
      causality: {
        invocationId: brandId<InvocationId>("inv-terminal-failure"),
      },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "permission denied",
        error: {
          toolName: "write_file",
          details: { input: { path: "src/app.ts", content: "updated" } },
        },
        terminalOutcome: "tool_error",
        terminalReasonCode: "method_failed",
        failure: toolFailure("write_file", "permission denied"),
      },
      createdAt: "2026-05-20T12:00:04.000Z",
    } as AgenticEvent<"invocation.failed">;

    const state = [envelope(failed, 1)].reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      contentType: "invocation",
      invocation: {
        id: "inv-terminal-failure",
        name: "write_file",
        arguments: { path: "src/app.ts", content: "updated" },
        execution: {
          status: "error",
          description: "permission denied",
          isError: true,
        },
      },
    });
  });

  it("projects typed inline UI events into inline UI chat messages", () => {
    const rendered: AgenticEvent<"ui.inline_rendered"> = {
      kind: "ui.inline_rendered",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "inline",
        id: "ui-1",
        source: { type: "file", path: "skills/setup/Panel.tsx" },
        imports: { react: "19.0.0" },
        props: { step: "connect" },
      },
      createdAt: "2026-05-20T12:00:03.000Z",
    };

    const state = [envelope(rendered, 1)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );

    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      id: "inline-ui:participant-agent-1:ui-1",
      contentType: "inline_ui",
      inlineUi: {
        id: "ui-1",
        source: { type: "file", path: "skills/setup/Panel.tsx" },
        imports: { react: "19.0.0" },
        props: { step: "connect" },
      },
    });
  });

  it("replaces a stable inline UI id and sorts it by the latest render", () => {
    const first: AgenticEvent<"ui.inline_rendered"> = {
      kind: "ui.inline_rendered",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "inline",
        id: "setup-overview",
        source: { type: "file", path: "skills/onboarding/SetupHub.tsx" },
        props: { revision: 1 },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const middle: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      causality: { messageId: brandId<MessageId>("between") },
      payload: textPayload("between", "assistant", "Refresh setup"),
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const updated: AgenticEvent<"ui.inline_rendered"> = {
      ...first,
      payload: { ...first.payload, props: { revision: 2 } },
      createdAt: "2026-05-20T12:00:03.000Z",
    };

    const state = [first, middle, updated]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());
    const messages = chatMessagesFromChannelView(state);

    expect(messages.map((message) => message.id)).toEqual([
      "between",
      "inline-ui:participant-agent-1:setup-overview",
    ]);
    expect(messages[1]?.inlineUi?.props).toEqual({ revision: 2 });
    expect(messages[1]?.inlineUi?.renderedAt).toBe("2026-05-20T12:00:03.000Z");
  });

  it("projects typed approval events into approval chat messages", () => {
    const requested: AgenticEvent<"approval.requested"> = {
      kind: "approval.requested",
      actor: agent,
      causality: {
        approvalId: brandId<ApprovalId>("approval-1"),
        invocationId: brandId<InvocationId>("inv-approval"),
      },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        question: "Allow tool call?",
        details: { toolName: "write" },
      },
      createdAt: "2026-05-20T12:00:04.000Z",
    };
    const resolved: AgenticEvent<"approval.resolved"> = {
      kind: "approval.resolved",
      actor: agent,
      causality: {
        approvalId: brandId<ApprovalId>("approval-1"),
        invocationId: brandId<InvocationId>("inv-approval"),
      },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        granted: false,
        resolvedBy: agent,
        reason: "User denied tool call",
      },
      createdAt: "2026-05-20T12:00:05.000Z",
    };

    const state = [envelope(requested, 1), envelope(resolved, 2)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );

    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      id: "approval:approval-1",
      contentType: "approval",
      complete: true,
      approval: {
        id: "approval-1",
        invocationId: "inv-approval",
        question: "Allow tool call?",
        status: "denied",
        granted: false,
        reason: "User denied tool call",
      },
    });
  });

  it("projects latest typed action bar event into the action bar view model", () => {
    const loaded: AgenticEvent<"ui.action_bar.updated"> = {
      kind: "ui.action_bar.updated",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "action_bar",
        id: "bar-1",
        source: { type: "file", path: "skills/test/ActionBar.tsx" },
        props: { compact: true },
        maxHeight: 180,
        result: { ok: true },
      },
      createdAt: "2026-05-20T12:00:03.000Z",
    };

    const state = [envelope(loaded, 1)].reduce(reduceChannelView, createInitialChannelViewState());

    expect(actionBarPayloadFromChannelView(state)).toEqual({
      id: "bar-1",
      source: { type: "file", path: "skills/test/ActionBar.tsx" },
      props: { compact: true },
      maxHeight: 180,
      result: { ok: true },
    });
  });

  it("rejects sync UI executable sources that still contain stored refs", () => {
    const storedSource = {
      protocol: "vibestudio.blob-ref.v1",
      digest: "ui-source-digest",
      size: 1024,
      encoding: "json",
      originalBytes: 1024,
      preview: '{"type":"code","code":"export default function App(){}"}',
    };
    const inline: AgenticEvent<"ui.inline_rendered"> = {
      kind: "ui.inline_rendered",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "inline",
        id: "ui-stored",
        source: storedSource as never,
      },
      createdAt: "2026-05-20T12:00:03.000Z",
    };
    const actionBar: AgenticEvent<"ui.action_bar.updated"> = {
      kind: "ui.action_bar.updated",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "action_bar",
        id: "bar-stored",
        source: storedSource as never,
      },
      createdAt: "2026-05-20T12:00:04.000Z",
    };
    const messageType: AgenticEvent<"messageType.registered"> = {
      kind: "messageType.registered",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        typeId: "stored-ui",
        displayMode: "row",
        source: storedSource as never,
      },
      createdAt: "2026-05-20T12:00:05.000Z",
    };

    expect(() =>
      [envelope(inline, 1), envelope(actionBar, 2), envelope(messageType, 3)].reduce(
        reduceChannelView,
        createInitialChannelViewState()
      )
    ).toThrow(/contains unresolved stored value refs/);
  });

  it("projects multi-recipient receipts and aggregates partial when only some read", () => {
    const user = {
      kind: "user" as const,
      id: "user-1",
      participantId: "participant-user-1",
    };
    const agentA = { kind: "agent" as const, id: "a", participantId: "pa" };
    const agentB = { kind: "agent" as const, id: "b", participantId: "pb" };
    const id = brandId<MessageId>("u-receipts");
    const make = (kind: AgenticEvent["kind"], actor: typeof user | typeof agentA, extra = {}) =>
      ({
        kind,
        actor,
        causality: { messageId: id },
        payload: { protocol: AGENTIC_PROTOCOL_VERSION, ...extra },
        createdAt: "2026-05-20T12:00:05.000Z",
      }) as AgenticEvent;
    const sent: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: user,
      causality: { messageId: id },
      payload: textPayload(id, "user", "hello team"),
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const events = [
      sent,
      make("message.received", agentA),
      make("message.received", agentB),
      make("message.read", agentA, { turnId: "t-1" }),
    ];
    const state = events
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());
    const chat = chatMessagesFromChannelView(state).find((message) => message.id === id);
    expect(chat?.receipts?.aggregate).toBe("partial");
    expect(chat?.receipts?.byParticipant).toMatchObject({
      pa: "read",
      pb: "received",
    });
  });

  it("marks a retracted message and drops it from no further ack", () => {
    const user = {
      kind: "user" as const,
      id: "user-1",
      participantId: "participant-user-1",
    };
    const id = brandId<MessageId>("u-retract");
    const sent: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: user,
      causality: { messageId: id },
      payload: textPayload(id, "user", "oops"),
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const retract = {
      kind: "message.retracted" as const,
      actor: user,
      causality: { messageId: id },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, by: user },
      createdAt: "2026-05-20T12:00:01.000Z",
    } as AgenticEvent;
    const state = [sent, retract]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());
    const chat = chatMessagesFromChannelView(state).find((message) => message.id === id);
    expect(chat?.retracted).toBe(true);
  });
});

describe("cross-channel traffic", () => {
  const guest = {
    kind: "agent" as const,
    id: "do:news",
    participantId: "do:news",
    displayName: "News",
    metadata: {
      handle: "news",
      origin: { channelId: "channel-news", participantId: "do:news" },
    },
  };

  function published(
    publications: Array<{
      channelId: string;
      envelopeId: string;
      summary?: string;
    }>,
    createdAt: string
  ): AgenticEvent<"external.envelope_published"> {
    return {
      kind: "external.envelope_published",
      actor: { ...agent, metadata: { handle: "scribe" } },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        publications: publications.map((entry) => ({
          channelId: brandId<ChannelId>(entry.channelId),
          envelopeId: brandId<EnvelopeId>(entry.envelopeId),
          payloadKind: "message.completed",
          ...(entry.summary ? { summary: entry.summary } : {}),
        })),
      },
      createdAt,
    };
  }

  it("records a reference to what was said elsewhere, never a copy of it", () => {
    const state = [
      envelope(
        published(
          [
            {
              channelId: "channel-mail",
              envelopeId: "say:call-1:channel-mail",
              summary: "Can you extract the newsletter senders?",
            },
          ],
          "2026-05-20T12:00:00.000Z"
        ),
        1
      ),
    ].reduce(reduceChannelView, createInitialChannelViewState());

    const rows = chatMessagesFromChannelView(state);
    const dispatches = rows.filter((row) => row.contentType === "cross-channel-sent");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      crossChannel: {
        channelId: "channel-mail",
        envelopeId: "say:call-1:channel-mail",
        summary: "Can you extract the newsletter senders?",
        from: { handle: "scribe" },
      },
    });
    // The utterance itself lives once, in the target channel's log. A row here
    // carrying it as ordinary content would make the foreign conversation look
    // like it happened in this one.
    expect(rows.some((row) => row.kind === "message" && row.contentType === undefined)).toBe(false);
  });

  it("keeps references from two channels apart when they share an envelope id", () => {
    const state = [
      envelope(
        published(
          [
            {
              channelId: "channel-a",
              envelopeId: "say:call-1",
              summary: "for a",
            },
            {
              channelId: "channel-b",
              envelopeId: "say:call-1",
              summary: "for b",
            },
          ],
          "2026-05-20T12:00:00.000Z"
        ),
        1
      ),
    ].reduce(reduceChannelView, createInitialChannelViewState());

    // Identity is the (channel, envelope) pair; two channels routinely mint the
    // same message id, and collapsing them would lose one dispatch entirely.
    expect(Object.keys(state.externalPublications)).toHaveLength(2);
    const dispatches = chatMessagesFromChannelView(state).filter(
      (row) => row.contentType === "cross-channel-sent"
    );
    expect(dispatches.map((row) => row.crossChannel?.channelId).sort()).toEqual([
      "channel-a",
      "channel-b",
    ]);
  });

  it("renders an arriving guest as an ordinary message carrying where it came from", () => {
    const message: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: guest,
      causality: { messageId: brandId<MessageId>("say:call-9:channel-mail") },
      payload: textPayload("say:call-9:channel-mail", "assistant", "Can you extract the senders?"),
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const observed: AgenticEvent<"external.envelope_observed"> = {
      kind: "external.envelope_observed",
      actor: guest,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        channelId: brandId<ChannelId>("channel-news"),
        envelopeId: brandId<EnvelopeId>("say:call-9:channel-mail"),
        from: guest,
        payloadKind: "message.completed",
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [envelope(message, 1), envelope(observed, 2)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );

    const row = chatMessagesFromChannelView(state).find(
      (entry) => entry.id === "say:call-9:channel-mail"
    );
    // A guest envelope IS an ordinary message here — someone talking — and must
    // not be demoted to a system row, or the conversation stops reading like one.
    expect(row).toMatchObject({
      kind: "message",
      content: "Can you extract the senders?",
      origin: { channelId: "channel-news", participantId: "do:news" },
      senderMetadata: { handle: "news" },
    });
    expect(row?.contentType).toBeUndefined();

    // The back-pointer to the authoring context is what makes the reverse walk
    // (and the "from #channel" affordance) resolvable.
    expect(Object.values(state.externalObservations)).toEqual([
      expect.objectContaining({
        channelId: "channel-news",
        envelopeId: "say:call-9:channel-mail",
      }),
    ]);
  });

  it("emits one dispatch row per message sent to the same target", () => {
    const events = [1, 2, 3].map((index) =>
      envelope(
        published(
          [
            {
              channelId: "channel-mail",
              envelopeId: `say:call-${index}:channel-mail`,
              summary: `message ${index}`,
            },
          ],
          `2026-05-20T12:00:0${index}.000Z`
        ),
        index
      )
    );
    const state = events.reduce(reduceChannelView, createInitialChannelViewState());

    // Three rows today. Grouping consecutive dispatches to one target into a
    // single counted row is specified but not built; when it lands, this count
    // is the assertion that has to change deliberately rather than silently.
    expect(
      chatMessagesFromChannelView(state).filter((row) => row.contentType === "cross-channel-sent")
    ).toHaveLength(3);
  });
});
