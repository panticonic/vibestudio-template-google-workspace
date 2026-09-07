// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatHostCommands } from "./ChatPaletteCommands";

const host = vi.hoisted(() => ({
  commands: [] as Array<{ id: string; label: string; description?: string; group: string }>,
  run: null as ((id: string) => void) | null,
}));

vi.mock("@workspace/react", () => ({
  useHostCommands: (
    commands: Array<{ id: string; label: string; description?: string; group: string }>,
    onRun: (id: string) => void
  ) => {
    host.commands = commands;
    host.run = onRun;
  },
}));
vi.mock("../context/ChatContext", () => ({
  useChatContext: () => ({
    onNewConversation: vi.fn(),
    messages: [],
    selfId: "user:self",
    participants: {},
    agentBusy: false,
    pendingSendCount: 0,
    flushOutboxAndInterrupt: vi.fn(),
    cancelPendingMessage: vi.fn(),
    undoableAction: undefined,
    undoLastAction: undefined,
  }),
}));
vi.mock("./ChatNativeActionsDialog", () => ({
  ChatNativeActionsDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="native-conversation-actions" /> : null,
}));

afterEach(() => {
  host.commands = [];
  host.run = null;
  Reflect.deleteProperty(globalThis, "__vibestudioHostPlatform");
});

describe("ChatHostCommands native presentation", () => {
  it("keeps the native-only conversation entry out of the desktop palette", () => {
    render(<ChatHostCommands />);
    expect(host.commands.map((command) => command.id)).not.toContain("chat-conversation-actions");
  });

  it("opens touch-oriented conversation controls from the contributed command", () => {
    Object.assign(globalThis, { __vibestudioHostPlatform: "mobile" });
    const view = render(<ChatHostCommands />);
    expect(host.commands).toContainEqual({
      id: "chat-conversation-actions",
      label: "Conversation actions",
      description: "People, agents, branches, and autonomy",
      group: "Chat",
    });

    act(() => host.run?.("chat-conversation-actions"));
    expect(view.getByTestId("native-conversation-actions")).toBeTruthy();
  });
});
