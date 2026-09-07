// @vitest-environment jsdom

import { Theme } from "@radix-ui/themes";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Participant } from "@workspace/pubsub";
import type { ChatParticipantMetadata } from "../types";

import { ParticipantBadgeMenu } from "./ParticipantBadgeMenu";

// AgentDialog (rendered for agent participants) reads ChatContext; stub it so the
// badge can be tested in isolation without a full <ChatProvider>.
vi.mock("./AgentDialog", () => ({ AgentDialog: () => null }));

function participant(
  metadata: Partial<ChatParticipantMetadata>
): Participant<ChatParticipantMetadata> {
  return {
    id: "do:linked:1",
    ref: { kind: "agent", id: "do:linked:1", participantId: "do:linked:1" },
    metadata: {
      name: "Claude Code",
      type: "agent",
      handle: "claude-code",
      ...metadata,
    } as ChatParticipantMetadata,
  };
}

describe("ParticipantBadgeMenu — linked agent", () => {
  it("shows durable presence directly on a canonical human badge", () => {
    render(
      <Theme>
        <ParticipantBadgeMenu
          participant={{
            id: "user:usr_alice",
            ref: { kind: "user", id: "user:usr_alice", participantId: "user:usr_alice" },
            metadata: { name: "Workspace member", type: "user" },
          }}
          profile={{
            userId: "usr_alice",
            handle: "alice",
            displayName: "Alice",
          }}
          presenceStatus="idle"
          hasActiveMessage={false}
          onCallMethod={vi.fn()}
        />
      </Theme>
    );
    expect(screen.getByText(/@alice/)).toBeTruthy();
    expect(screen.getByLabelText("idle")).toBeTruthy();
    expect(screen.getByTitle("Alice — idle")).toBeTruthy();
  });

  it("renders a Claude Code kind badge for a linked agent participant", () => {
    render(
      <Theme>
        <ParticipantBadgeMenu
          participant={participant({ agentKind: "claude-code", linkedAttachment: "attached" })}
          hasActiveMessage={false}
          onCallMethod={vi.fn()}
        />
      </Theme>
    );
    expect(screen.getByText("Claude Code")).toBeTruthy();
    // Attached → the badge advertises the online state via its title.
    expect(screen.getByTitle(/online \(attached\)/i)).toBeTruthy();
  });

  it("marks a detached linked agent as offline", () => {
    render(
      <Theme>
        <ParticipantBadgeMenu
          participant={participant({ linkedAgent: true, linkedAttachment: "detached" })}
          hasActiveMessage={false}
          onCallMethod={vi.fn()}
        />
      </Theme>
    );
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByTitle(/offline \(detached\)/i)).toBeTruthy();
  });

  it("renders no kind badge for an ordinary agent participant", () => {
    render(
      <Theme>
        <ParticipantBadgeMenu
          participant={participant({ handle: "pi", name: "Pi" })}
          hasActiveMessage={false}
          onCallMethod={vi.fn()}
        />
      </Theme>
    );
    expect(screen.queryByText("Claude Code")).toBeNull();
  });
});
