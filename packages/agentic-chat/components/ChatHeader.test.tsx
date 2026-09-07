// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Theme } from "@radix-ui/themes";
import { ChatHeader } from "./ChatHeader";

const chatContext = {
  channelId: "channel-1",
  channelTitle: "Deep work",
  connected: true,
  status: "Connected",
  messages: [],
  participants: {},
  pendingAgents: new Map(),
  toolApproval: undefined,
  onCallMethod: undefined,
  onDebugConsoleChange: undefined,
  onRemoveAgent: undefined,
  onAddAgent: undefined,
  onReplaceAgent: undefined,
  onOpenClaudeCode: undefined,
  deferredAgent: undefined,
  chat: {},
  clientRef: { current: null },
};

vi.mock("../context/ChatContext", () => ({
  useChatContext: () => chatContext,
}));
vi.mock("../hooks/useAccountProfiles", () => ({
  useAccountProfiles: () => new Map(),
}));
vi.mock("./ParticipantBadgeMenu", () => ({ ParticipantBadgeMenu: () => null }));
vi.mock("./PendingAgentBadge", () => ({ PendingAgentBadge: () => null }));
vi.mock("./ToolPermissionsDropdown", () => ({ ToolPermissionsDropdown: () => null }));
vi.mock("./LazyAgentDialog", () => ({ LazyAgentDialog: () => null }));
vi.mock("./ForkSwitcher", () => ({ ForkSwitcher: () => null }));
vi.mock("./ChannelPeopleMenu", () => ({ ChannelPeopleMenu: () => null }));

afterEach(() => {
  Reflect.deleteProperty(globalThis, "__vibestudioHostPlatform");
});

function renderHeader() {
  return render(
    <Theme>
      <ChatHeader />
    </Theme>
  );
}

describe("ChatHeader hosted chrome", () => {
  it("keeps the conversation title when the panel owns its chrome", () => {
    const view = renderHeader();
    expect(view.getAllByText("Deep work").length).toBeGreaterThan(0);
  });

  it("leaves the entire chrome row to the native shell", () => {
    Object.assign(globalThis, { __vibestudioHostPlatform: "mobile" });
    const view = renderHeader();
    expect(view.queryByText("Deep work")).toBeNull();
    expect(view.queryByLabelText("Chat menu")).toBeNull();
    expect(view.container.querySelector('[data-part="chat-header"]')).toBeNull();
  });
});
