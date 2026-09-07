// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountProfile } from "../hooks/useAccountProfiles";
import {
  type ConversationActionsController,
  useConversationActions,
} from "./useConversationActions";

const chatContext = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock("../context/ChatContext", () => ({
  useChatContext: () => chatContext.value,
}));

let controller: ConversationActionsController | null = null;

function Harness({
  participants,
  accountProfiles,
  onRemoveAgent,
  onDebugConsoleChange,
}: {
  participants: Record<string, never>;
  accountProfiles: Map<string, AccountProfile>;
  onRemoveAgent: (handle: string) => void;
  onDebugConsoleChange: (handle: string | null) => void;
}) {
  controller = useConversationActions({
    participants,
    accountProfiles,
    onRemoveAgent,
    onDebugConsoleChange,
  });
  return null;
}

afterEach(() => {
  controller = null;
  vi.restoreAllMocks();
});

describe("shared conversation action model", () => {
  it("derives handles and agent actions once for both renderers", () => {
    const onReplaceAgent = vi.fn();
    const onOpenClaudeCode = vi.fn(async () => undefined);
    const onRemoveAgent = vi.fn();
    const onDebugConsoleChange = vi.fn();
    chatContext.value = {
      channelId: "channel:one",
      messages: [],
      deferredAgent: { active: false },
      onReplaceAgent,
      onOpenClaudeCode,
    };
    const participants = {
      "user:one": {
        id: "user:one",
        metadata: { type: "human", handle: "stale-human" },
      },
      "agent:one": {
        id: "agent:one",
        metadata: { type: "agent", handle: "helper" },
      },
    } as unknown as Record<string, never>;
    const accountProfiles = new Map<string, AccountProfile>([
      ["user:one", { userId: "one", handle: "current-human", displayName: "Current Human" }],
    ]);

    render(
      <Harness
        participants={participants}
        accountProfiles={accountProfiles}
        onRemoveAgent={onRemoveAgent}
        onDebugConsoleChange={onDebugConsoleChange}
      />
    );

    expect(controller?.participants.map(({ handle }) => handle)).toEqual([
      "current-human",
      "helper",
    ]);
    expect(controller?.agents.map(({ handle }) => handle)).toEqual(["helper"]);
    expect(controller?.agentActionLabel).toBe("Switch agent");
    expect(controller?.canOpenClaudeCode).toBe(true);

    act(() => controller?.openAddAgent());
    expect(controller?.addAgentOpen).toBe(true);
    act(() => controller?.openAgentSettings("agent:one"));
    expect(controller?.settingsParticipantId).toBe("agent:one");
    act(() => controller?.openDebugConsole("helper"));
    expect(onDebugConsoleChange).toHaveBeenCalledWith("helper");

    vi.spyOn(window, "confirm").mockReturnValue(true);
    expect(controller?.requestRemoveAgent("helper")).toBe(true);
    expect(onRemoveAgent).toHaveBeenCalledWith("helper");
    controller?.openClaudeCode();
    expect(onOpenClaudeCode).toHaveBeenCalledWith("channel:one");
  });
});
