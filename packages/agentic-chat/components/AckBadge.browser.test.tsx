import { render, screen, within, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Theme } from "@radix-ui/themes";
import type { Participant } from "@workspace/pubsub";
import { AckBadge } from "./AckBadge";
import type { ChatMessage, ChatParticipantMetadata } from "../types";

// Real-browser test (vitest.browser.config.ts): the touch Popover actually opens.

afterEach(cleanup);

const participants: Record<string, Participant<ChatParticipantMetadata>> = {
  "agent:alice": {
    id: "agent:alice",
    ref: { kind: "agent", id: "agent:alice", participantId: "agent:alice" },
    metadata: { name: "Alice", type: "agent", handle: "alice" },
  },
  "agent:bob": {
    id: "agent:bob",
    ref: { kind: "agent", id: "agent:bob", participantId: "agent:bob" },
    metadata: { name: "Bob", type: "agent", handle: "bob" },
  },
  "agent:carol": {
    id: "agent:carol",
    ref: { kind: "agent", id: "agent:carol", participantId: "agent:carol" },
    metadata: { name: "Carol", type: "agent", handle: "carol" },
  },
};

function receipts(
  byParticipant: Record<string, "pending" | "received" | "read">
): NonNullable<ChatMessage["receipts"]> {
  const states = Object.values(byParticipant);
  const readCount = states.filter((s) => s === "read").length;
  const aggregate = readCount === 0 ? "pending" : readCount === states.length ? "read" : "partial";
  return { byParticipant, aggregate };
}

describe("AckBadge (browser)", () => {
  it("opens the touch popover to reveal per-recipient rows", async () => {
    render(
      <Theme>
        <AckBadge
          receipts={receipts({ "agent:alice": "read", "agent:bob": "received", "agent:carol": "pending" })}
          participants={participants}
          touch
        />
      </Theme>
    );
    // Collapsed cluster shows initials only — full names live in the surface.
    expect(screen.queryByText("Alice")).toBeNull();
    fireEvent.click(screen.getByLabelText(/1 read, 1 received, 1 pending of 3/i));
    const list = await screen.findByRole("list", { name: /per-recipient delivery state/i });
    expect(within(list).getByText("Alice")).toBeTruthy();
    expect(within(list).getByText("Bob")).toBeTruthy();
    expect(within(list).getByText("Carol")).toBeTruthy();
  });
});
