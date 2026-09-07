// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { ChatMessage } from "../types";
import { ChatMessageArea } from "./ChatMessageArea";

const recordReadReceipt = vi.fn(() => Promise.resolve());
const chatContext = {
  connected: true,
  messages: [] as ChatMessage[],
  participants: {},
  selfId: null as string | null,
  allParticipants: {},
  inlineUiComponents: new Map(),
  messageTypeComponents: new Map(),
  hasMoreHistory: false,
  loadingMore: false,
  onLoadEarlierMessages: undefined,
  onInterrupt: undefined,
  onCancelInvocation: undefined,
  onFocusPanel: undefined,
  onReloadPanel: undefined,
  chat: { send: vi.fn() },
  browserHandoffCaller: undefined,
  clientRef: { current: { recordReadReceipt } },
  deferredAgent: undefined,
  connectionError: undefined,
};

vi.mock("../context/ChatContext", () => ({
  useChatContext: () => chatContext,
}));
vi.mock("../context/ChatInputContext", () => ({
  useChatInputActions: () => ({ setReplyTo: vi.fn() }),
}));
vi.mock("./FirstRunCard", () => ({
  FirstRunCard: () => <div data-testid="stock-empty-state">Stock first run</div>,
}));
vi.mock("./MessageList", () => ({
  MessageList: ({ emptyState }: { emptyState?: ReactNode }) => (
    <div data-testid="message-list">{emptyState}</div>
  ),
}));
vi.mock("./SignalPills", () => ({ SignalPills: () => null }));
vi.mock("./Outbox", () => ({ deriveActiveOutbox: () => [] }));

describe("ChatMessageArea empty transcript", () => {
  beforeEach(() => {
    chatContext.messages = [];
    chatContext.connected = true;
    recordReadReceipt.mockClear();
  });

  it("lets products delegate to the complete stock empty state", () => {
    const renderEmptyState = vi.fn((defaultContent: ReactNode) => (
      <section data-testid="product-empty-state">{defaultContent}</section>
    ));

    render(
      <ChatMessageArea
        features={{ feedback: false, inlineUi: false, actionBar: false, clientEval: false }}
        renderEmptyState={renderEmptyState}
      />
    );

    expect(renderEmptyState).toHaveBeenCalledOnce();
    expect(renderEmptyState).toHaveBeenCalledWith(
      expect.anything(),
      { phase: "ready" },
    );
    expect(
      screen
        .getByTestId("product-empty-state")
        .contains(screen.getByTestId("stock-empty-state"))
    ).toBe(true);
  });

  it("lets a product preserve operational startup feedback", () => {
    chatContext.connected = false;
    const renderEmptyState = vi.fn(
      (defaultContent: ReactNode, state: { phase: string }) =>
        state.phase === "ready" ? <p>Product greeting</p> : defaultContent,
    );

    render(
      <ChatMessageArea
        features={{ feedback: false, inlineUi: false, actionBar: false, clientEval: false }}
        renderEmptyState={renderEmptyState}
      />,
    );

    expect(renderEmptyState).toHaveBeenCalledWith(
      expect.anything(),
      { phase: "connecting" },
    );
    expect(screen.queryByText("Product greeting")).toBeNull();
  });

  it("does not infer read or inbox acknowledgement from a mounted visible transcript", () => {
    chatContext.selfId = "user:owner";
    chatContext.messages = [
      {
        id: "message-1",
        senderId: "agent:helper",
        content: "A meaningful background result",
        escalation: {
          alert: "inbox",
          users: ["user:owner"],
        },
      },
    ];

    render(
      <ChatMessageArea
        features={{ feedback: false, inlineUi: false, actionBar: false, clientEval: false }}
      />
    );

    expect(recordReadReceipt).not.toHaveBeenCalled();
  });
});
