// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../types";

const hookState = vi.hoisted(() => {
  const scrollListeners = new Set<() => void>();
  let layoutItems: Array<{
    id: string;
    top: number;
    height: number;
  }> = [];
  const makeLayoutElement = (item: { id: string; top: number; height: number }) => ({
    getAttribute(name: string) {
      return name === "data-scroll-anchor-id" ? item.id : null;
    },
    offsetTop: item.top,
    offsetHeight: item.height,
    getBoundingClientRect() {
      return { top: item.top, bottom: item.top + item.height, height: item.height };
    },
  });
  const scrollElement = {
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    addEventListener(event: string, listener: () => void) {
      if (event === "scroll") scrollListeners.add(listener);
    },
    removeEventListener(event: string, listener: () => void) {
      if (event === "scroll") scrollListeners.delete(listener);
    },
  };
  const contentElement = {
    querySelectorAll() {
      return layoutItems.map(makeLayoutElement);
    },
    getBoundingClientRect() {
      return { top: 0, bottom: 0, height: 0 };
    },
  };
  const scrollRef = Object.assign((_node: unknown) => {}, { current: scrollElement });
  const contentRef = Object.assign((_node: unknown) => {}, { current: contentElement });
  return {
    contentElement,
    contentRef,
    isAtBottom: true,
    scrollElement,
    scrollListeners,
    scrollRef,
    scrollToBottom: vi.fn(() => true),
    setLayoutItems(nextItems: typeof layoutItems) {
      layoutItems = nextItems;
    },
  };
});

vi.mock("../hooks/useStickToBottom.js", () => ({
  useStickToBottom: () => ({
    scrollRef: hookState.scrollRef,
    contentRef: hookState.contentRef,
    scrollToBottom: hookState.scrollToBottom,
    isAtBottom: hookState.isAtBottom,
    // Live getter so tests that flip hookState.isAtBottom between renders are
    // reflected synchronously, mirroring the real hook's ref.
    isAtBottomRef: {
      get current() {
        return hookState.isAtBottom;
      },
    },
  }),
}));

import { MessageList } from "./MessageList.js";

function makeMessage(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    senderId: "agent-1",
    content: id,
    kind: "message" as const,
    complete: true,
    ...overrides,
  };
}

describe("MessageList scroll behavior", () => {
  beforeEach(() => {
    hookState.isAtBottom = true;
    hookState.scrollElement.scrollTop = 0;
    hookState.scrollElement.scrollHeight = 0;
    hookState.scrollElement.clientHeight = 0;
    hookState.scrollListeners.clear();
    hookState.scrollToBottom.mockClear();
    hookState.setLayoutItems([]);
  });

  it("does not re-trigger history loading on message append while already near the top", async () => {
    hookState.isAtBottom = false;
    hookState.scrollElement.scrollTop = 100;

    const onLoadEarlierMessages = vi.fn();
    const { rerender } = render(
      <MessageList
        messages={[makeMessage("m1")]}
        participants={{}}
        selfId={null}
        allParticipants={{}}
        hasMoreHistory={true}
        loadingMore={false}
        onLoadEarlierMessages={onLoadEarlierMessages}
      />
    );

    await waitFor(() => expect(onLoadEarlierMessages).toHaveBeenCalledTimes(1));

    rerender(
      <MessageList
        messages={[makeMessage("m1"), makeMessage("m2")]}
        participants={{}}
        selfId={null}
        allParticipants={{}}
        hasMoreHistory={true}
        loadingMore={false}
        onLoadEarlierMessages={onLoadEarlierMessages}
      />
    );

    expect(onLoadEarlierMessages).toHaveBeenCalledTimes(1);
  });

  it("reveals locally buffered history before offering another server page", () => {
    hookState.scrollElement.scrollTop = 300;
    const messages = Array.from({ length: 201 }, (_, index) => makeMessage(`m${index}`));
    const onLoadEarlierMessages = vi.fn();
    render(
      <MessageList
        messages={messages}
        participants={{}}
        selfId={null}
        allParticipants={{}}
        hasMoreHistory={true}
        loadingMore={false}
        onLoadEarlierMessages={onLoadEarlierMessages}
      />
    );

    expect(screen.queryByText("m0")).toBeNull();
    expect(screen.queryByText("Load earlier messages")).toBeNull();
    fireEvent.click(screen.getByText("Show 1 earlier messages"));
    expect(screen.getByText("m0")).toBeTruthy();
    expect(screen.getByText("Load earlier messages")).toBeTruthy();
    expect(onLoadEarlierMessages).not.toHaveBeenCalled();
  });

  it("makes a prepended server history page visible immediately", async () => {
    hookState.scrollElement.scrollTop = 300;
    const current = Array.from({ length: 200 }, (_, index) => makeMessage(`m${index}`));
    const onLoadEarlierMessages = vi.fn(async () => {});
    const { rerender } = render(
      <MessageList
        messages={current}
        participants={{}}
        selfId={null}
        allParticipants={{}}
        hasMoreHistory={true}
        loadingMore={false}
        onLoadEarlierMessages={onLoadEarlierMessages}
      />
    );

    fireEvent.click(screen.getByText("Load earlier messages"));
    expect(onLoadEarlierMessages).toHaveBeenCalledOnce();
    rerender(
      <MessageList
        messages={[makeMessage("older"), ...current]}
        participants={{}}
        selfId={null}
        allParticipants={{}}
        hasMoreHistory={false}
        loadingMore={false}
        onLoadEarlierMessages={onLoadEarlierMessages}
      />
    );

    await waitFor(() => expect(screen.getByText("older")).toBeTruthy());
  });

  it("preserves the visible position when older messages are prepended away from bottom", () => {
    hookState.isAtBottom = false;
    hookState.scrollElement.scrollTop = 120;
    hookState.scrollElement.scrollHeight = 400;

    const { rerender } = render(
      <MessageList
        messages={[makeMessage("m2"), makeMessage("m3")]}
        participants={{}}
        selfId={null}
        allParticipants={{}}
      />
    );

    hookState.scrollElement.scrollHeight = 550;

    rerender(
      <MessageList
        messages={[makeMessage("m1"), makeMessage("m2"), makeMessage("m3")]}
        participants={{}}
        selfId={null}
        allParticipants={{}}
      />
    );

    expect(hookState.scrollElement.scrollTop).toBe(270);
    expect(screen.queryByText("New messages")).toBeNull();
  });

  it("shows the new content indicator for appended messages away from bottom and scrolls on click", () => {
    hookState.isAtBottom = false;

    const { rerender } = render(
      <MessageList
        messages={[makeMessage("m1")]}
        participants={{}}
        selfId={null}
        allParticipants={{}}
      />
    );

    rerender(
      <MessageList
        messages={[makeMessage("m1"), makeMessage("m2")]}
        participants={{}}
        selfId={null}
        allParticipants={{}}
      />
    );

    fireEvent.click(screen.getByText("New messages"));

    expect(hookState.scrollToBottom).toHaveBeenCalledWith({ animation: "instant" });
    expect(screen.queryByText("New messages")).toBeNull();
  });

  it("does not show the new content indicator for appended messages while pinned at bottom", () => {
    hookState.isAtBottom = true;

    const { rerender } = render(
      <MessageList
        messages={[makeMessage("m1")]}
        participants={{}}
        selfId={null}
        allParticipants={{}}
      />
    );

    rerender(
      <MessageList
        messages={[makeMessage("m1"), makeMessage("m2")]}
        participants={{}}
        selfId={null}
        allParticipants={{}}
      />
    );

    expect(screen.queryByText("New messages")).toBeNull();
  });

  it("rerenders only the changed row during a streaming tail update", () => {
    const participants = {};
    const first = makeMessage("m1");
    const streaming = makeMessage("m2", { complete: false, content: "a" });
    const renderMessage = vi.fn((message: ChatMessage) => <span>{message.content}</span>);
    const { rerender } = render(
      <MessageList
        messages={[first, streaming]}
        participants={participants}
        selfId={null}
        allParticipants={participants}
        renderMessage={renderMessage}
      />
    );
    expect(renderMessage).toHaveBeenCalledTimes(2);

    rerender(
      <MessageList
        messages={[first, { ...streaming, content: "ab" }]}
        participants={participants}
        selfId={null}
        allParticipants={participants}
        renderMessage={renderMessage}
      />
    );

    expect(renderMessage).toHaveBeenCalledTimes(3);
    expect(screen.getByText("ab")).toBeTruthy();
  });

  it("shows the new content indicator when an item below the viewport updates", () => {
    hookState.isAtBottom = false;
    hookState.scrollElement.scrollTop = 0;
    hookState.scrollElement.clientHeight = 100;
    hookState.scrollElement.scrollHeight = 300;
    hookState.setLayoutItems([
      { id: "m1", top: 0, height: 100 },
      { id: "m2", top: 150, height: 100 },
    ]);

    const { rerender } = render(
      <MessageList
        messages={[makeMessage("m1"), makeMessage("m2")]}
        participants={{}}
        selfId={null}
        allParticipants={{}}
      />
    );

    rerender(
      <MessageList
        messages={[makeMessage("m1"), makeMessage("m2", { content: "updated below" })]}
        participants={{}}
        selfId={null}
        allParticipants={{}}
      />
    );

    expect(screen.getByText("New messages")).toBeTruthy();
  });

  it("preserves the anchored item when an earlier message expands", () => {
    hookState.isAtBottom = false;
    hookState.scrollElement.scrollTop = 150;
    hookState.scrollElement.scrollHeight = 300;
    hookState.setLayoutItems([
      { id: "m1", top: 0, height: 100 },
      { id: "m2", top: 100, height: 100 },
      { id: "m3", top: 200, height: 100 },
    ]);

    const { rerender } = render(
      <MessageList
        messages={[makeMessage("m1"), makeMessage("m2"), makeMessage("m3")]}
        participants={{}}
        selfId={null}
        allParticipants={{}}
      />
    );

    hookState.scrollElement.scrollHeight = 350;
    hookState.setLayoutItems([
      { id: "m1", top: 0, height: 150 },
      { id: "m2", top: 150, height: 100 },
      { id: "m3", top: 250, height: 100 },
    ]);

    rerender(
      <MessageList
        messages={[
          makeMessage("m1", { content: "expanded" }),
          makeMessage("m2"),
          makeMessage("m3"),
        ]}
        participants={{}}
        selfId={null}
        allParticipants={{}}
      />
    );

    expect(hookState.scrollElement.scrollTop).toBe(200);
    expect(screen.queryByText("New messages")).toBeNull();
  });

  it("preserves the anchored item when sort order changes", () => {
    hookState.isAtBottom = false;
    hookState.scrollElement.scrollTop = 150;
    hookState.scrollElement.scrollHeight = 300;
    hookState.setLayoutItems([
      { id: "m1", top: 0, height: 100 },
      { id: "m2", top: 100, height: 100 },
      { id: "m3", top: 200, height: 100 },
    ]);

    const { rerender } = render(
      <MessageList
        messages={[makeMessage("m1"), makeMessage("m2"), makeMessage("m3")]}
        participants={{}}
        selfId={null}
        allParticipants={{}}
      />
    );

    hookState.setLayoutItems([
      { id: "m1", top: 0, height: 100 },
      { id: "m3", top: 100, height: 100 },
      { id: "m2", top: 200, height: 100 },
    ]);

    rerender(
      <MessageList
        messages={[makeMessage("m1"), makeMessage("m3"), makeMessage("m2")]}
        participants={{}}
        selfId={null}
        allParticipants={{}}
      />
    );

    expect(hookState.scrollElement.scrollTop).toBe(250);
    expect(screen.queryByText("New messages")).toBeNull();
  });
});
