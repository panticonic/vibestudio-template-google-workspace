// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, it, expect, vi } from "vitest";
import type { InlineItem } from "./InlineGroup.js";

beforeAll(async () => {
  // These are deliberately lazy in production. Load their real modules before
  // individual MDX assertions start so full-suite CPU contention cannot turn a
  // module-load delay into a query timeout.
  await Promise.all([import("@mdx-js/mdx"), import("rehype-highlight")]);
});

const hookState = vi.hoisted(() => {
  const scrollElement = {
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    addEventListener() {},
    removeEventListener() {},
  };
  const contentElement = {};
  const scrollRef = Object.assign((_node: unknown) => {}, { current: scrollElement });
  const contentRef = Object.assign((_node: unknown) => {}, { current: contentElement });
  return {
    scrollRef,
    contentRef,
    scrollToBottom: vi.fn(() => true),
  };
});

vi.mock("../hooks/useStickToBottom.js", () => ({
  useStickToBottom: () => ({
    scrollRef: hookState.scrollRef,
    contentRef: hookState.contentRef,
    scrollToBottom: hookState.scrollToBottom,
    isAtBottom: true,
    isAtBottomRef: { current: true },
  }),
}));

import type { ChatMessage, TaskCardPayload } from "@workspace/agentic-core";
import { LOCAL_FALLBACK_MODEL_REF } from "@workspace/model-catalog/catalog";
import { ChatMessageActionsContext } from "../context/ChatContext.js";
import { MessageList } from "./MessageList.js";
import { latestSubagentActivities, SubagentRunCard } from "./SubagentRunCard.js";
import { SubagentTranscriptContent } from "./SubagentTranscript.js";

function makeMessage(overrides: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    senderId: "agent-1",
    content: "",
    kind: "message",
    complete: false,
    ...overrides,
  };
}

function makeParticipant(id: string, metadata: Record<string, unknown>) {
  return {
    [id]: { id, metadata: { name: "AI Chat", type: "agent", handle: "agent", ...metadata } },
  };
}

describe("MessageList typing indicators (roster-based)", () => {
  it("shows typing indicator when participant metadata has typing=true", () => {
    render(
      React.createElement(MessageList, {
        messages: [],
        participants: makeParticipant("agent-1", { typing: true }),
        selfId: "user-1",
        allParticipants: {},
      } as never)
    );

    expect(screen.getByText("AI Chat typing")).toBeTruthy();
  });

  it("does not show typing for participants with typing=false", () => {
    render(
      React.createElement(MessageList, {
        messages: [],
        participants: makeParticipant("agent-1", { typing: false }),
        selfId: "user-1",
        allParticipants: {},
      } as never)
    );

    expect(screen.queryByText("AI Chat typing")).toBeNull();
  });

  it("does not show own typing indicator", () => {
    render(
      React.createElement(MessageList, {
        messages: [],
        participants: makeParticipant("user-1", { typing: true, name: "User", type: "panel" }),
        selfId: "user-1",
        allParticipants: {},
      } as never)
    );

    expect(screen.queryByText("User typing")).toBeNull();
  });

  it("gives tier-2 messages the slight styling hook and leaves tier-1 alone", () => {
    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({ content: "intermediate step", complete: true, tier: "secondary" }),
          makeMessage({ content: "final answer", complete: true, tier: "primary" }),
        ],
        participants: {},
        selfId: null,
        allParticipants: {},
      } as never)
    );

    const secondary = document.body.querySelector('[data-message-tier="secondary"]');
    expect(secondary).toBeTruthy();
    expect(secondary?.querySelector(".message-card-tier2")).toBeTruthy();
    expect(secondary?.textContent).toContain("intermediate step");

    const primary = document.body.querySelector('[data-message-tier="primary"]');
    expect(primary).toBeTruthy();
    expect(primary?.querySelector(".message-card-tier2")).toBeNull();
  });

  it("renders invocation beads in inline groups", () => {
    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "action-1",
            contentType: "invocation",
            content: "",
            invocation: {
              id: "tool-1",
              name: "Read",
              arguments: { file_path: "src/app.ts" },
              execution: { status: "complete", description: "Read src/app.ts" },
            },
            complete: true,
          }),
          makeMessage({
            id: "action-2",
            contentType: "invocation",
            content: "",
            invocation: {
              id: "tool-2",
              name: "Edit",
              arguments: { file_path: "src/config.ts" },
              execution: { status: "complete", description: "Edit src/config.ts" },
            },
            complete: true,
          }),
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: {},
      } as never)
    );

    expect(screen.getByText("Read src/app.ts")).toBeTruthy();
    expect(screen.getByText("Edit src/config.ts")).toBeTruthy();
  });

  it("renders expanded thinking details as markdown", async () => {
    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "thinking-1",
            contentType: "thinking",
            content: "**Check:**\n\n- read files\n- run tests",
            complete: true,
          }),
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: {},
      } as never)
    );

    fireEvent.click(screen.getByLabelText("Thinking: **Check:** - read files - run tests"));

    expect(document.body.textContent).toContain("Check:");
    await waitFor(() => expect(document.body.querySelectorAll("li")).toHaveLength(2));
  });

  it("renders compact thinking previews as markdown", async () => {
    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "thinking-1",
            contentType: "thinking",
            content: "Check **repo** state",
            complete: true,
          }),
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: {},
      } as never)
    );

    await waitFor(() =>
      expect(document.body.querySelector(".rt-r-weight-bold")?.textContent).toBe("repo")
    );
  });

  it("renders lifecycle recovery notices as compact system status", () => {
    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "recovery-1",
            senderId: "agent-1",
            contentType: "lifecycle",
            kind: "system",
            content:
              "The partial response was discarded because replay is not enabled for this agent.",
            complete: true,
            lifecycle: {
              status: "interrupted",
              title: "Restart interrupted the response",
              detail:
                "The partial response was discarded because replay is not enabled for this agent.",
            },
          }),
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: makeParticipant("agent-1", { handle: "ai-chat" }),
      } as never)
    );

    expect(screen.getByText("Interrupted")).toBeTruthy();
    expect(screen.getByText("Restart interrupted the response")).toBeTruthy();
    expect(
      screen.getByText(
        "The partial response was discarded because replay is not enabled for this agent."
      )
    ).toBeTruthy();
    expect(document.body.querySelector(".message-card-lifecycle")).toBeTruthy();
  });

  it("offers scheduling for reset-aware model failures", async () => {
    const callMethod = vi.fn().mockResolvedValue({ scheduled: true });
    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "diagnostic:msg-usage-limit",
            senderId: "agent-1",
            contentType: "diagnostic",
            kind: "system",
            content:
              "The usage limit has been reached for GPT-5.3-Codex-Spark. Try again after Jun 15, 2026 at 6:35 PM UTC.",
            complete: true,
            diagnostic: {
              messageId: "msg-usage-limit",
              code: "message_failed",
              failureCode: "usage_limit_terminal",
              severity: "error",
              title: "Model usage limit reached",
              detail:
                "The usage limit has been reached for GPT-5.3-Codex-Spark. Try again after Jun 15, 2026 at 6:35 PM UTC.",
              resetAt: "2026-06-15T18:35:01.000Z",
            },
          }),
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: makeParticipant("agent-1", { handle: "ai-chat" }),
        chat: { callMethod },
      } as never)
    );

    fireEvent.click(screen.getByRole("button", { name: /resume at reset/i }));

    await waitFor(() => {
      expect(callMethod).toHaveBeenCalledWith("agent-1", "scheduleResumeAtReset", {
        messageId: "msg-usage-limit",
        resetAt: "2026-06-15T18:35:01.000Z",
      });
    });
    expect(await screen.findByText("Scheduled")).toBeTruthy();
  });

  it("switches the live agent to the local model before persisting and sending retry", async () => {
    const calls: Array<{ participantId: string; method: string; args: unknown }> = [];
    const callMethod = vi.fn(async (participantId: string, method: string, args: unknown) => {
      calls.push({ participantId, method, args });
      if (method === "getAgentSettings") return { model: "openai-codex:gpt-5.3" };
      return { ok: true };
    });
    const send = vi.fn(async () => undefined);
    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "diagnostic:msg-provider-failed",
            senderId: "agent-1",
            contentType: "diagnostic",
            kind: "system",
            content: "The provider failed.",
            complete: true,
            diagnostic: {
              messageId: "msg-provider-failed",
              code: "message_failed",
              failureCode: "provider_overloaded_retryable",
              severity: "error",
              title: "Provider overloaded",
              detail: "The provider failed.",
            },
          }),
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: makeParticipant("agent-1", { handle: "ai-chat" }),
        chat: { callMethod, send },
      } as never)
    );

    const retryButton = await screen.findByRole("button", { name: /retry with local model/i });
    calls.length = 0;

    fireEvent.click(retryButton);

    await waitFor(() => expect(send).toHaveBeenCalledWith("retry", { tier: "primary" }));
    expect(calls.map((call) => [call.participantId, call.method])).toEqual([
      ["agent-1", "getAgentSettings"],
      ["agent-1", "setModel"],
      ["user-1", "persist_agent_model"],
    ]);
    expect(calls[1]?.args).toEqual({ model: LOCAL_FALLBACK_MODEL_REF });
    expect(calls[2]?.args).toEqual({
      participantId: "agent-1",
      model: LOCAL_FALLBACK_MODEL_REF,
    });
  });

  it.each(["model_stream_stalled_retryable", "unknown_retryable"])(
    "retries a %s failure with the current model",
    async (failureCode) => {
      const callMethod = vi.fn(async () => ({ model: "openai-codex:gpt-5.3" }));
      const send = vi.fn(async () => undefined);
      render(
        React.createElement(MessageList, {
          messages: [
            makeMessage({
              id: "diagnostic:msg-stream-stalled",
              senderId: "agent-1",
              contentType: "diagnostic",
              kind: "system",
              content: "Model stream made no semantic progress for 60000ms",
              complete: true,
              diagnostic: {
                messageId: "msg-stream-stalled",
                code: "message_failed",
                failureCode,
                severity: "error",
                title: "Message failed",
                detail: "Model stream made no semantic progress for 60000ms",
              },
            }),
          ],
          participants: {},
          selfId: "user-1",
          allParticipants: makeParticipant("agent-1", { handle: "ai-chat" }),
          chat: { callMethod, send },
        } as never)
      );

      fireEvent.click(await screen.findByRole("button", { name: /^retry$/i }));

      await waitFor(() => expect(send).toHaveBeenCalledWith("retry", { tier: "primary" }));
      expect(callMethod).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /retry with local model/i })).toBeNull();
    }
  );

  it("does not mark local retry ready or send retry when live model switching fails", async () => {
    const calls: Array<{ participantId: string; method: string; args: unknown }> = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const callMethod = vi.fn(async (participantId: string, method: string, args: unknown) => {
      calls.push({ participantId, method, args });
      if (method === "getAgentSettings") return { model: "openai-codex:gpt-5.3" };
      if (method === "setModel") throw new Error("switch failed");
      return { ok: true };
    });
    const send = vi.fn(async () => undefined);
    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "diagnostic:msg-provider-failed-setmodel",
            senderId: "agent-1",
            contentType: "diagnostic",
            kind: "system",
            content: "The provider failed.",
            complete: true,
            diagnostic: {
              messageId: "msg-provider-failed-setmodel",
              code: "message_failed",
              failureCode: "provider_overloaded_retryable",
              severity: "error",
              title: "Provider overloaded",
              detail: "The provider failed.",
            },
          }),
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: makeParticipant("agent-1", { handle: "ai-chat" }),
        chat: { callMethod, send },
      } as never)
    );

    const retryButton = await screen.findByRole("button", { name: /retry with local model/i });
    calls.length = 0;

    fireEvent.click(retryButton);

    expect(await screen.findByRole("button", { name: /retry local failed/i })).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === "persist_agent_model")).toBe(false);
    expect(screen.queryByText("Retry ready")).toBeNull();
    warn.mockRestore();
  });

  it("opens a clean chat with the same local model after context overflow", async () => {
    const callMethod = vi.fn(async (_participantId: string, method: string) => {
      if (method === "getAgentSettings") {
        return {
          model: { value: "local:lfm2.5-350m" },
          thinkingLevel: { value: "low" },
          approvalLevel: { value: 1 },
          respondPolicy: { value: "mentioned" },
          respondFrom: { value: ["user-1"] },
        };
      }
      return { ok: true };
    });
    const onNewConversation = vi.fn(async () => undefined);

    render(
      React.createElement(
        ChatMessageActionsContext.Provider,
        { value: { onNewConversation } as never },
        React.createElement(MessageList, {
          messages: [
            makeMessage({
              id: "diagnostic:msg-local-overflow",
              senderId: "agent-1",
              contentType: "diagnostic",
              kind: "system",
              content:
                "400 request (18364 tokens) exceeds the available context size (16384 tokens), try increasing it",
              complete: true,
              diagnostic: {
                messageId: "msg-local-overflow",
                code: "message_failed",
                failureCode: "context_overflow_terminal",
                severity: "error",
                title: "Context window exceeded",
                detail:
                  "400 request (18364 tokens) exceeds the available context size (16384 tokens), try increasing it",
              },
            }),
          ],
          participants: {},
          selfId: "user-1",
          allParticipants: makeParticipant("agent-1", { handle: "ai-chat" }),
          chat: { callMethod },
        } as never)
      )
    );

    const startButton = await screen.findByRole("button", { name: /new chat without history/i });
    fireEvent.click(startButton);

    await waitFor(() => expect(onNewConversation).toHaveBeenCalledTimes(1));
    expect(onNewConversation).toHaveBeenCalledWith({
      agentConfig: {
        model: "local:lfm2.5-350m",
        thinkingLevel: "low",
        approvalLevel: 1,
        respondPolicy: "mentioned",
        respondFrom: ["user-1"],
      },
    });
  });

  it("shows a cancel control for a pending channel-method invocation (transportCallId)", () => {
    const onCancelInvocation = vi.fn();
    const invocation = {
      id: "tool-1",
      transportCallId: "transport-1",
      name: "set_title",
      arguments: { title: "x" },
      execution: { status: "pending", description: "" },
    };
    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "action-1",
            senderId: "agent-1",
            contentType: "invocation",
            content: "",
            invocation,
            complete: false,
          }),
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: makeParticipant("agent-1", { handle: "ai-chat" }),
        onCancelInvocation,
      } as never)
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel pending tool call" }));

    // The whole invocation + its sender (the owning agent) are passed so the
    // handler can route an eval cancel to the agent vs. abort a panel/channel call.
    expect(onCancelInvocation).toHaveBeenCalledWith(invocation, "agent-1");
  });

  it("shows a cancel control for a pending eval pill that has NO transportCallId (server-side run)", () => {
    const onCancelInvocation = vi.fn();
    const invocation = {
      id: "eval-run-1",
      // No transportCallId: an eval runs server-side, keyed by its own id.
      name: "eval",
      arguments: { code: "await work()" },
      execution: { status: "pending", description: "" },
    };
    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "action-2",
            senderId: "agent-1",
            contentType: "invocation",
            content: "",
            invocation,
            complete: false,
          }),
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: makeParticipant("agent-1", { handle: "ai-chat" }),
        onCancelInvocation,
      } as never)
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel pending tool call" }));

    expect(onCancelInvocation).toHaveBeenCalledWith(invocation, "agent-1");
  });

  it("uses the invocation description as the collapsed pill preview", () => {
    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "action-1",
            senderId: "agent-1",
            contentType: "invocation",
            content: "",
            invocation: {
              id: "tool-1",
              name: "mcp__workspace__ListDirectory",
              arguments: { path: "packages/agentic-chat", recursive: true },
              execution: { status: "complete", description: "Listed agentic-chat package files" },
            },
            complete: true,
          }),
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: {},
      } as never)
    );

    const pill = screen.getByTestId("invocation-pill");

    expect(pill.textContent).toContain("List Directory");
    expect(pill.textContent).toContain("Listed agentic-chat package files");
    expect(pill.textContent).not.toContain("recursive");
  });

  it("expands invocation details with full code arguments and flags unhydrated stored results", async () => {
    const longCode = "const answer = 42;\n".repeat(40);
    const storedResult = {
      protocol: "vibestudio.blob-ref.v1",
      digest: "result-digest",
      size: 2048,
      encoding: "json",
      originalBytes: 2048,
    };
    const rpcCall = vi.fn();
    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "action-1",
            contentType: "invocation",
            content: "",
            invocation: {
              id: "tool-1",
              name: "eval",
              arguments: { code: longCode },
              execution: { status: "complete", result: storedResult },
            },
            complete: true,
          }),
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: {},
        chat: { rpc: { call: rpcCall } },
      } as never)
    );

    fireEvent.click(screen.getByTestId("invocation-pill"));

    expect(document.body.textContent).toContain(longCode);
    expect(screen.getAllByRole("button", { name: "Copy" }).length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain("Stored value reached transcript UI");
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("expands failed invocation details with full copyable error payloads", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "action-err",
            contentType: "invocation",
            content: "",
            invocation: {
              id: "tool-err",
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
                isError: true,
                result: {
                  text: "Path not found: /packages workers panels. The `path` argument accepts one directory or file, not a space-separated list.",
                  content: [
                    {
                      type: "text",
                      text: "Path not found: /packages workers panels. The `path` argument accepts one directory or file, not a space-separated list.",
                    },
                  ],
                },
              },
            },
            complete: true,
          }),
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: {},
      } as never)
    );

    fireEvent.click(screen.getByTestId("invocation-pill"));

    expect(document.body.textContent).toContain("packages workers panels");
    expect(document.body.textContent).toContain("not a space-separated list");
    expect(screen.getAllByRole("button", { name: "Copy" }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Copy invocation details" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining('"path": "packages workers panels"')
      );
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("not a space-separated list"));
    });
  });

  it("renders durable typing indicators in their own inline row", () => {
    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "action-1",
            contentType: "invocation",
            content: "",
            invocation: {
              id: "tool-1",
              name: "Read",
              arguments: { file_path: "src/app.ts" },
              execution: { status: "pending", description: "Read src/app.ts" },
            },
            complete: false,
          }),
          makeMessage({
            id: "typing-1",
            contentType: "typing",
            senderMetadata: { name: "Agent One", type: "agent", handle: "agent-1" },
            complete: false,
          }),
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: {},
        renderInlineGroup: (items: InlineItem[]) =>
          React.createElement(
            "div",
            { "data-testid": "inline-group" },
            items.map((item) => item.type).join(",")
          ),
      } as never)
    );

    expect(screen.getAllByTestId("inline-group").map((node) => node.textContent)).toEqual([
      "invocation",
      "typing",
    ]);
  });

  it("lets group and message overrides delegate to their complete stock renderers", () => {
    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "message-1",
            content: "Captain's log",
            complete: true,
          }),
          makeMessage({
            id: "action-1",
            contentType: "invocation",
            content: "",
            invocation: {
              id: "tool-1",
              name: "commit_order",
              arguments: { order: "burn-clear" },
              execution: { status: "complete", description: "Committed burn" },
            },
            complete: true,
          }),
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: {},
        renderMessage: (_message: ChatMessage, _sender: unknown, defaultContent: React.ReactNode) =>
          React.createElement("section", { "data-testid": "message-wrapper" }, defaultContent),
        renderInlineGroup: (_items: InlineItem[], defaultContent: React.ReactNode) =>
          React.createElement("section", { "data-testid": "group-wrapper" }, defaultContent),
        renderInvocation: () =>
          React.createElement("span", { "data-testid": "custom-invocation" }, "BRIDGE ORDER"),
      } as never)
    );

    expect(screen.getByTestId("message-wrapper").textContent).toContain("Captain's log");
    expect(
      screen.getByTestId("group-wrapper").contains(screen.getByTestId("custom-invocation"))
    ).toBe(true);
  });

  it("does not synthesize generic invocation UI for malformed invocation messages", () => {
    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "action-without-payload",
            contentType: "invocation",
            content: "",
            complete: false,
          }),
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: {},
      } as never)
    );

    expect(screen.queryByText("Invocation")).toBeNull();
    expect(screen.queryByText("Tool")).toBeNull();
    expect(document.body.querySelector('[data-testid="invocation-pill"]')).toBeNull();
  });

  it("renders durable approval cards", () => {
    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "approval-1",
            contentType: "approval",
            content: "",
            approval: {
              id: "approval-1",
              invocationId: "call-1",
              question: "Allow tool call?",
              status: "requested",
            },
            complete: false,
          }),
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: {},
      } as never)
    );

    expect(screen.getByText("Approval requested")).toBeTruthy();
    expect(screen.getByText("Allow tool call?")).toBeTruthy();
    expect(screen.queryByText("call-1")).toBeNull();
  });

  it("wires MDX ActionButton to publish a follow-up message", async () => {
    const publishMessage = vi.fn();
    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "mdx-1",
            content: '<ActionButton message="Refresh the data">Refresh</ActionButton>',
            complete: true,
          }),
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: {},
        mdxActions: { publishMessage },
      } as never)
    );

    const button = await waitFor(() => screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(button);

    expect(publishMessage).toHaveBeenCalledWith("Refresh the data");
  });

  it("renders feedback-form title MDX from transcript messages", async () => {
    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "feedback-title-1",
            content: "<FeedbackFormTitle>System test feedback</FeedbackFormTitle>",
            complete: true,
          }),
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: {},
      } as never)
    );

    expect(await screen.findByRole("heading", { name: "System test feedback" })).toBeTruthy();
  });

  it("renders the documented OpenInNewWindow MDX icon", async () => {
    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "open-icon-1",
            content: '<Icons.OpenInNewWindowIcon data-testid="open-icon" />',
            complete: true,
          }),
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: {},
      } as never)
    );

    await waitFor(() => {
      expect(screen.getByTestId("open-icon")).toBeTruthy();
    });
  });

  it("falls back to plain text when MDX rendering throws", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      render(
        React.createElement(MessageList, {
          messages: [
            makeMessage({
              id: "missing-mdx-1",
              content: "<MissingTranscriptWidget>Fallback copy</MissingTranscriptWidget>",
              complete: true,
            }),
          ],
          participants: {},
          selfId: "user-1",
          allParticipants: {},
        } as never)
      );

      await waitFor(() => {
        expect(
          debugSpy.mock.calls.some(([message]) => String(message).includes("MDX render failed"))
        ).toBe(true);
      });

      expect(document.body.textContent).toContain(
        "<MissingTranscriptWidget>Fallback copy</MissingTranscriptWidget>"
      );
    } finally {
      debugSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe("SubagentRunCard", () => {
  function subagentMessage(overrides: {
    id: string;
    execution: TaskCardPayload["execution"];
    subagent: NonNullable<TaskCardPayload["subagent"]>;
    complete: boolean;
  }): ChatMessage {
    return {
      id: `subagent-${overrides.id}`,
      senderId: "agent-1",
      content: "",
      contentType: "task",
      kind: "message",
      complete: overrides.complete,
      task: {
        id: overrides.id,
        taskType: "subagent",
        title: overrides.subagent.label ?? "Subagent",
        execution: overrides.execution,
        subagent: overrides.subagent,
      },
    };
  }

  it("renders markdown in collapsed description previews", () => {
    render(
      React.createElement(SubagentRunCard, {
        msg: subagentMessage({
          id: "run-description",
          execution: {
            status: "complete",
            description: "**Final report** uses `inline code` and [a link](https://example.com).",
          },
          subagent: {
            runId: "run-description",
            mode: "fresh",
            taskChannelId: "task-run-description",
            contextId: "ctx-run-description",
            childEntityId: "do:workers/agent-worker:AiChatWorker:subagent-run-description",
            childParticipantId: "participant-run-description",
            label: "Report renderer",
          },
          complete: true,
        }),
      })
    );

    const preview = document.body.querySelector(".subagent-update-preview");
    expect(preview).toBeTruthy();
    expect(preview?.textContent).toContain("Final report");
    expect(preview?.querySelector(".markdown-preview-strong")).toBeTruthy();
    expect(preview?.querySelector(".markdown-preview-code")).toBeTruthy();
    expect(preview?.querySelector(".markdown-preview-link")).toBeTruthy();
    expect(preview?.querySelector("a, button, input")).toBeNull();
  });

  it("shows useful expanded details before the child has a summary", () => {
    render(
      React.createElement(SubagentRunCard, {
        msg: subagentMessage({
          id: "run-2",
          execution: { status: "pending", description: "" },
          subagent: {
            runId: "run-2",
            mode: "fresh",
            taskChannelId: "task-run-2",
            contextId: "ctx-run-2",
            childEntityId: "do:workers/agent-worker:AiChatWorker:subagent-run-2",
            childParticipantId: "participant-run-2",
            label: "Drive helper fix",
          },
          complete: false,
        }),
      })
    );

    expect(screen.getByText("Starting")).toBeTruthy();
    expect(screen.getByText("No child activity recorded yet")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Expand run details"));

    fireEvent.click(screen.getByLabelText("Run identifiers"));
    expect(screen.getByText("run-2")).toBeTruthy();
    expect(screen.getByText("task-run-2")).toBeTruthy();
    expect(screen.getByText("ctx-run-2")).toBeTruthy();
  });

  it("projects the latest child-authored tool activity without mistaking steering for progress", () => {
    const messages: ChatMessage[] = [
      makeMessage({
        id: "task-seed",
        senderId: "parent-participant",
        senderMetadata: { type: "headless", name: "Subagent task" },
        content: "Implement the storage layer",
        complete: true,
      }) as ChatMessage,
      makeMessage({
        id: "child-thinking",
        senderId: "child-participant",
        senderMetadata: { type: "agent", name: "Subagent" },
        contentType: "thinking",
        content: "I should inspect the schema migration contract first.",
        complete: true,
      }) as ChatMessage,
      makeMessage({
        id: "child-verify",
        senderId: "child-participant",
        senderMetadata: { type: "agent", name: "Subagent" },
        contentType: "invocation",
        content: "",
        invocation: {
          id: "verify-storage",
          name: "verify",
          arguments: { operation: "build", target: "workers/rich-storage" },
          execution: { status: "running", description: "" },
        },
        complete: false,
      }) as ChatMessage,
      makeMessage({
        id: "parent-steer",
        senderId: "parent-participant",
        senderMetadata: { type: "agent", name: "Supervisor" },
        content: "Remember to preserve imported labels.",
        complete: true,
      }) as ChatMessage,
    ];

    expect(
      latestSubagentActivities(messages, "child-participant")
    ).toEqual([
      {
        prefix: "Using",
        content: "Verify · operation: build, target: rich-storage",
      },
      {
        prefix: "Thinking",
        content: "I should inspect the schema migration contract first.",
      },
    ]);
  });

  it("compacts child narration into a bounded live update", () => {
    expect(
      latestSubagentActivities(
        [
          makeMessage({
            id: "child-update",
            senderId: "child-participant",
            senderMetadata: { type: "agent", name: "Subagent" },
            saliency: "say",
            content: `Found the migration boundary. ${"detail ".repeat(40)}`,
            complete: true,
          }) as ChatMessage,
        ],
        "child-participant"
      )
    ).toEqual([
      {
        prefix: "Update",
        content: expect.stringMatching(/^Found the migration boundary\..*…$/),
      },
    ]);
  });
});

describe("ordinary task presentation", () => {
  it("renders a terminal task as a structured card instead of serialized protocol JSON", async () => {
    const task: TaskCardPayload = {
      id: "call-terminal",
      taskType: "task",
      title: "Subagent",
      execution: {
        status: "complete",
        description: "Committed the Flowboard UX upgrade.",
        result: {
          protocolContent: [
            { type: "text", text: "Committed the Flowboard UX upgrade." },
          ],
          details: { sourceEventId: "workspace-event:abc123" },
        },
        isError: false,
      },
    };
    const serialized = JSON.stringify(task);

    render(
      React.createElement(MessageList, {
        messages: [
          makeMessage({
            id: "task-call-terminal",
            content: serialized,
            contentType: "task",
            complete: true,
            task,
          }) as ChatMessage,
        ],
        participants: {},
        selfId: "user-1",
        allParticipants: {},
      } as never)
    );

    expect(screen.getByTestId("task-run-card")).toBeTruthy();
    expect(screen.getByText("Subagent")).toBeTruthy();
    expect(screen.getByText("Complete")).toBeTruthy();
    expect(screen.getByText("Committed the Flowboard UX upgrade.")).toBeTruthy();
    expect(document.body.textContent).not.toContain(serialized);

    fireEvent.click(screen.getByText("Result details"));
    expect(screen.getByText("Task result")).toBeTruthy();
    await waitFor(() => {
      expect(document.body.textContent).toContain("workspace-event:abc123");
    });
  });
});

describe("SubagentTranscriptContent", () => {
  it("exposes retained history pagination inside the embedded transcript", () => {
    const loadEarlierMessages = vi.fn();
    render(
      React.createElement(SubagentTranscriptContent, {
        transcript: {
          messages: [
            makeMessage({
              id: "child-history-tail",
              content: "Most recent retained child message.",
              complete: true,
            }) as ChatMessage,
          ],
          participants: {},
          selfId: null,
          loading: false,
          error: null,
          hasMoreHistory: true,
          loadingMore: false,
          loadEarlierMessages,
          retry: vi.fn(),
        },
      })
    );

    loadEarlierMessages.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    expect(loadEarlierMessages).toHaveBeenCalledOnce();
  });

  it("keeps loaded child history visible when live refresh fails", () => {
    const retry = vi.fn();
    render(
      React.createElement(SubagentTranscriptContent, {
        transcript: {
          messages: [
            makeMessage({
              id: "child-history-1",
              content: "Loaded child history remains readable.",
              complete: true,
            }) as ChatMessage,
          ],
          participants: {},
          selfId: null,
          loading: false,
          error: "connection interrupted",
          hasMoreHistory: false,
          loadingMore: false,
          loadEarlierMessages: vi.fn(),
          retry,
        },
      })
    );

    expect(screen.getByText("Loaded child history remains readable.")).toBeTruthy();
    expect(screen.getByText(/loaded history is preserved/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("offers a retry instead of an endless loader after a terminal connection error", () => {
    const retry = vi.fn();
    render(
      React.createElement(SubagentTranscriptContent, {
        transcript: {
          messages: [],
          participants: {},
          selfId: null,
          loading: false,
          error: "channel replay timed out",
          hasMoreHistory: false,
          loadingMore: false,
          loadEarlierMessages: vi.fn(),
          retry,
        },
      })
    );

    expect(screen.queryByText(/Loading the child/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry transcript" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
