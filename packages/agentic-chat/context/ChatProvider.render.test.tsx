// @vitest-environment jsdom

import { memo } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatContextValue, ChatInputContextValue, ChatMessage } from "../types";
import {
  useChatComposerRuntime,
  useChatContext,
  useOptionalChatMessageActions,
} from "./ChatContext";
import { ChatProvider } from "./ChatProvider";

const ROW_COUNT = 200;
const contentRendered = vi.hoisted(() => vi.fn());

vi.mock("../components/MessageContent", () => ({
  MessageContent: ({ content }: { content: string }) => {
    contentRendered(content);
    return <span>{content}</span>;
  },
}));

import { MessageList } from "../components/MessageList";

const MessageActionProbe = memo(function MessageActionProbe({
  rendered,
}: {
  rendered: () => void;
}) {
  rendered();
  useOptionalChatMessageActions();
  return null;
});

const ComposerRuntimeProbe = memo(function ComposerRuntimeProbe({
  rendered,
}: {
  rendered: () => void;
}) {
  rendered();
  useChatComposerRuntime();
  return null;
});

const FullContextProbe = memo(function FullContextProbe({ rendered }: { rendered: () => void }) {
  rendered();
  useChatContext();
  return null;
});

function contextValue(): ChatContextValue {
  return {
    agentBusy: false,
    allParticipants: {},
    chat: {},
    connected: true,
    editPendingMessage: vi.fn(async () => {}),
    flushOutboxAndInterrupt: vi.fn(async () => {}),
    hasOpenTurn: false,
    messages: [],
    modelCatalog: null,
    onCallMethodResult: vi.fn(async () => undefined),
    onNewConversation: vi.fn(),
    participants: {},
    pendingSendCount: 0,
    primaryActionIntent: "send",
    selfId: null,
  } as unknown as ChatContextValue;
}

const inputValue = {
  input: "",
  pendingImages: [],
  replyTo: null,
  replyToMessage: null,
} as unknown as ChatInputContextValue;

describe("ChatProvider render slices", () => {
  beforeEach(() => {
    contentRendered.mockClear();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("keeps resident message rows and the composer asleep during a streaming update", () => {
    const messageRowsRendered = vi.fn();
    const composerRendered = vi.fn();
    const fullContextRendered = vi.fn();
    const value = contextValue();
    const probes = (
      <>
        {Array.from({ length: ROW_COUNT }, (_, index) => (
          <MessageActionProbe key={index} rendered={messageRowsRendered} />
        ))}
        <ComposerRuntimeProbe rendered={composerRendered} />
        <FullContextProbe rendered={fullContextRendered} />
      </>
    );
    const { rerender } = render(
      <ChatProvider value={value} inputValue={inputValue}>
        {probes}
      </ChatProvider>
    );
    expect(messageRowsRendered).toHaveBeenCalledTimes(ROW_COUNT);
    expect(composerRendered).toHaveBeenCalledTimes(1);
    expect(fullContextRendered).toHaveBeenCalledTimes(1);

    const streamingMessage = {
      id: "assistant-1",
      senderId: "agent-1",
      content: "streaming",
      kind: "message",
      complete: false,
    } as ChatMessage;
    rerender(
      <ChatProvider value={{ ...value, messages: [streamingMessage] }} inputValue={inputValue}>
        {probes}
      </ChatProvider>
    );

    expect(messageRowsRendered).toHaveBeenCalledTimes(ROW_COUNT);
    expect(composerRendered).toHaveBeenCalledTimes(1);
    expect(fullContextRendered).toHaveBeenCalledTimes(2);
  });

  it("rerenders only the changed card across a 200-row streaming transcript", () => {
    const messages = Array.from(
      { length: ROW_COUNT },
      (_, index) =>
        ({
          id: `message-${index}`,
          senderId: "agent-1",
          content: `content-${index}`,
          kind: "message",
          complete: true,
        }) as ChatMessage
    );
    const value = { ...contextValue(), messages };
    const sharedParticipants = {};
    const { rerender } = render(
      <ChatProvider value={value} inputValue={inputValue}>
        <MessageList
          messages={messages}
          participants={sharedParticipants}
          allParticipants={sharedParticipants}
          selfId={null}
          chat={value.chat as unknown as Record<string, unknown>}
        />
      </ChatProvider>
    );
    expect(contentRendered).toHaveBeenCalledTimes(ROW_COUNT);

    const streamingMessages = messages.slice();
    streamingMessages[ROW_COUNT - 1] = {
      ...streamingMessages[ROW_COUNT - 1]!,
      content: "streamed tail",
      complete: false,
    };
    rerender(
      <ChatProvider value={{ ...value, messages: streamingMessages }} inputValue={inputValue}>
        <MessageList
          messages={streamingMessages}
          participants={sharedParticipants}
          allParticipants={sharedParticipants}
          selfId={null}
          chat={value.chat as unknown as Record<string, unknown>}
        />
      </ChatProvider>
    );

    expect(contentRendered).toHaveBeenCalledTimes(ROW_COUNT + 1);

    rerender(
      <ChatProvider
        value={{ ...value, messages: streamingMessages }}
        inputValue={{ ...inputValue, input: "draft" }}
      >
        <MessageList
          messages={streamingMessages}
          participants={sharedParticipants}
          allParticipants={sharedParticipants}
          selfId={null}
          chat={value.chat as unknown as Record<string, unknown>}
        />
      </ChatProvider>
    );

    expect(contentRendered).toHaveBeenCalledTimes(ROW_COUNT + 1);
  });
});
