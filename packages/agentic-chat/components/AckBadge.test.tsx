// @vitest-environment jsdom

import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Theme } from "@radix-ui/themes";
import type { Participant } from "@workspace/pubsub";
import { AckBadge } from "./AckBadge";
import type { ChatMessage, ChatParticipantMetadata } from "../types";

function renderWithTheme(ui: React.ReactElement) {
  return render(<Theme>{ui}</Theme>);
}

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

describe("AckBadge", () => {
  it("single recipient renders one badge with an aria-label spelling out state", () => {
    renderWithTheme(
      <AckBadge receipts={receipts({ "agent:alice": "read" })} participants={participants} />
    );
    // Agents are framed as "taken into account", not "read".
    const label = screen.getByLabelText(/Alice: taken into account/i);
    expect(label).toBeTruthy();
  });

  it("pending and received states use distinct (non-color-only) shapes", () => {
    const { rerender } = renderWithTheme(
      <AckBadge receipts={receipts({ "agent:alice": "pending" })} participants={participants} />
    );
    expect(screen.getByLabelText(/Alice: pending/i)).toBeTruthy();
    rerender(
      <Theme>
        <AckBadge receipts={receipts({ "agent:alice": "received" })} participants={participants} />
      </Theme>
    );
    expect(screen.getByLabelText(/Alice: received/i)).toBeTruthy();
  });

  it("multi-recipient compact shows participant faces and an aggregate aria-label", () => {
    renderWithTheme(
      <AckBadge
        receipts={receipts({
          "agent:alice": "read",
          "agent:bob": "received",
          "agent:carol": "pending",
        })}
        participants={participants}
        touch
      />
    );
    // Aggregate label is "partial" — one read of three, spelled out for a11y.
    const trigger = screen.getByLabelText(/1 read, 1 received, 1 pending of 3/i);
    expect(trigger).toBeTruthy();
    // Avatar faces (initials) are shown in the compact cluster so you see WHO.
    expect(screen.getAllByText(/^[A-Z]{1,2}$/).length).toBeGreaterThanOrEqual(1);
    // The detail surface trigger is a focusable button (opens HoverCard/Popover).
    expect(trigger.tagName).toBe("BUTTON");
  });

  it("detailed mode renders per-recipient chips inline (no extra surface)", () => {
    renderWithTheme(
      <AckBadge
        receipts={receipts({ "agent:alice": "read", "agent:bob": "pending" })}
        participants={participants}
        mode="detailed"
      />
    );
    const group = screen.getByRole("group", { name: /1 read, 1 pending of 2/i });
    expect(within(group).getByText("Alice")).toBeTruthy();
    expect(within(group).getByText("Bob")).toBeTruthy();
  });

  it("marks a still-unread recipient absent from the roster as offline", () => {
    // `participants` has alice/bob/carol; "agent:ghost" is not present → offline.
    renderWithTheme(
      <AckBadge receipts={receipts({ "agent:ghost": "pending" })} participants={participants} />
    );
    expect(screen.getByLabelText(/offline — delivers on return/i)).toBeTruthy();
  });

  it("a present recipient is not marked offline", () => {
    renderWithTheme(
      <AckBadge receipts={receipts({ "agent:alice": "pending" })} participants={participants} />
    );
    expect(screen.queryByLabelText(/offline/i)).toBeNull();
    expect(screen.getByLabelText(/Alice: pending/i)).toBeTruthy();
  });

  it("renders nothing when there are no recipients", () => {
    const { container } = renderWithTheme(
      <AckBadge receipts={{ byParticipant: {}, aggregate: "pending" }} participants={participants} />
    );
    expect(container.querySelector(".ack-badge-compact")).toBeNull();
  });
});
