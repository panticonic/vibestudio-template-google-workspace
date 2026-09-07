// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Theme } from "@radix-ui/themes";

// jsdom does not implement matchMedia; the responsive hooks need it.
beforeAll(() => {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList
  );
});
import type { Participant } from "@workspace/pubsub";
import {
  Outbox,
  deriveOutboxMessages,
  deriveActiveOutbox,
  hasOfflinePendingRecipient,
} from "./Outbox";
import { ChatContext } from "../context/ChatContext";
import type { ChatContextValue, ChatMessage, ChatParticipantMetadata } from "../types";

const SELF = "panel:user";

function selfMessage(id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    senderId: SELF,
    content,
    kind: "message",
    complete: true,
    ...extra,
  };
}

const participants: Record<string, Participant<ChatParticipantMetadata>> = {
  "agent:alice": {
    id: "agent:alice",
    ref: { kind: "agent", id: "agent:alice", participantId: "agent:alice" },
    metadata: { name: "Alice", type: "agent", handle: "alice" },
  },
};

function makeContext(
  messages: ChatMessage[],
  overrides: Partial<ChatContextValue> = {}
): ChatContextValue {
  return {
    connected: true,
    messages,
    selfId: SELF,
    allParticipants: participants,
    participants,
    agentBusy: false,
    editPendingMessage: vi.fn(async () => {}),
    cancelPendingMessage: vi.fn(async () => {}),
    flushOutboxAndInterrupt: vi.fn(async () => {}),
    primaryActionIntent: "send",
    pendingSendCount: 0,
    afterTurnMessageIds: new Set<string>(),
    ...overrides,
  } as unknown as ChatContextValue;
}

function renderOutbox(ctx: ChatContextValue) {
  return render(
    <Theme>
      <ChatContext.Provider value={ctx}>
        <Outbox />
      </ChatContext.Provider>
    </Theme>
  );
}

describe("deriveOutboxMessages", () => {
  it("includes only self-authored zero-read real messages", () => {
    const messages: ChatMessage[] = [
      selfMessage("a", "pending one"),
      selfMessage("b", "read one", {
        receipts: { byParticipant: { "agent:alice": "read" }, aggregate: "read" },
      }),
      selfMessage("c", "errored", { error: "boom" }),
      selfMessage("d", "retracted", { retracted: true }),
      {
        id: "e",
        senderId: "agent:alice",
        content: "agent says hi",
        kind: "message",
        complete: true,
      },
      selfMessage("f", "received only", {
        receipts: { byParticipant: { "agent:alice": "received" }, aggregate: "pending" },
      }),
    ];
    const result = deriveOutboxMessages(messages, SELF).map((m) => m.id);
    expect(result).toEqual(["a", "f"]);
  });

  it("an item leaves the outbox on first read (partial/read aggregate)", () => {
    const before = [
      selfMessage("a", "queued", {
        receipts: { byParticipant: { "agent:alice": "pending" }, aggregate: "pending" },
      }),
    ];
    expect(deriveOutboxMessages(before, SELF).map((m) => m.id)).toEqual(["a"]);

    const after = [
      selfMessage("a", "queued", {
        receipts: {
          byParticipant: { "agent:alice": "read", "agent:bob": "pending" },
          aggregate: "partial",
        },
      }),
    ];
    expect(deriveOutboxMessages(after, SELF)).toEqual([]);
  });
});

describe("deriveActiveOutbox / hasOfflinePendingRecipient (presence)", () => {
  const ROSTER = { "agent:alice": {} };
  const pendingTo = (id: string, key: string) =>
    selfMessage(id, "msg", {
      receipts: { byParticipant: { [key]: "pending" }, aggregate: "pending" },
    });

  it("treats a pending recipient absent from the live roster as offline", () => {
    expect(hasOfflinePendingRecipient(pendingTo("a", "agent:alice"), ROSTER)).toBe(false);
    expect(hasOfflinePendingRecipient(pendingTo("b", "agent:ghost"), ROSTER)).toBe(true);
  });

  it("excludes the user's own method invocations (e.g. pause / 'send now')", () => {
    // A user-fired `pause` is projected as a self-authored kind:"message" row with
    // contentType:"invocation" and no receipts — it must NOT pollute the queue.
    const invocation = selfMessage("inv", JSON.stringify({ name: "pause" }), {
      contentType: "invocation",
    });
    const realMsg = selfMessage("real", "actual queued text");
    expect(deriveOutboxMessages([invocation, realMsg], SELF).map((m) => m.id)).toEqual(["real"]);
  });

  it("a read recipient, or a no-receipts message, is never offline", () => {
    const read = selfMessage("a", "x", {
      receipts: { byParticipant: { "agent:ghost": "read" }, aggregate: "read" },
    });
    expect(hasOfflinePendingRecipient(read, ROSTER)).toBe(false);
    expect(hasOfflinePendingRecipient(selfMessage("b", "y"), ROSTER)).toBe(false);
  });

  it("an optimistic send goes to the queue iff the roster has a recipient (else transcript)", () => {
    const optimistic = selfMessage("o", "no receipts yet");
    // No recipient present → not deliverable → stays in the transcript, not the queue.
    expect(deriveActiveOutbox([optimistic], SELF, {}).map((m) => m.id)).toEqual([]);
    // A recipient present → straight to the queue (no transcript flash → no flicker).
    expect(deriveActiveOutbox([optimistic], SELF, ROSTER).map((m) => m.id)).toEqual(["o"]);
  });

  it("active outbox excludes offline-recipient messages (they go to the transcript)", () => {
    const messages = [
      pendingTo("online", "agent:alice"),
      pendingTo("offline", "agent:ghost"),
      selfMessage("optimistic", "no receipts yet"),
    ];
    expect(deriveActiveOutbox(messages, SELF, ROSTER).map((m) => m.id)).toEqual([
      "online",
      "optimistic",
    ]);
  });
});

describe("Outbox", () => {
  it("renders an item list with the queued message and its edit/cancel controls", () => {
    renderOutbox(makeContext([selfMessage("a", "hello agent")]));
    const list = screen.getByRole("list", { name: /Outbox/i });
    expect(within(list).getByText("hello agent")).toBeTruthy();
    expect(within(list).getByLabelText("Edit message")).toBeTruthy();
    expect(within(list).getByLabelText("Cancel message")).toBeTruthy();
    // Delivery order is server-owned; the queue exposes only real edit/cancel actions.
    expect(within(list).queryByTestId("outbox-drag-handle")).toBeNull();
  });

  it("renders nothing when there are no unsent messages", () => {
    const { container } = renderOutbox(
      makeContext([
        selfMessage("b", "already read", {
          receipts: { byParticipant: { "agent:alice": "read" }, aggregate: "read" },
        }),
      ])
    );
    expect(container.querySelector('[data-testid="outbox"]')).toBeNull();
  });

  it("renders nothing until connected (no queue flash during initial replay)", () => {
    const { container } = renderOutbox(makeContext([selfMessage("a", "hi")], { connected: false }));
    expect(container.querySelector('[data-testid="outbox"]')).toBeNull();
  });

  it("clicking cancel calls cancelPendingMessage with the message id", () => {
    const cancelPendingMessage = vi.fn(async () => {});
    renderOutbox(makeContext([selfMessage("a", "cancel me")], { cancelPendingMessage }));
    const list = screen.getByRole("list", { name: /Outbox/i });
    fireEvent.click(within(list).getByLabelText("Cancel message"));
    expect(cancelPendingMessage).toHaveBeenCalledWith("a");
  });

  it("after-turn messages get the 'After this turn' lane treatment", () => {
    renderOutbox(
      makeContext([selfMessage("a", "later please")], {
        agentBusy: true,
        afterTurnMessageIds: new Set(["a"]),
      })
    );
    expect(screen.getByText("After this turn")).toBeTruthy();
  });

  it("queued steers get the 'Lands this turn' lane treatment when the agent is busy", () => {
    renderOutbox(makeContext([selfMessage("a", "steer it")], { agentBusy: true }));
    expect(screen.getByText("Lands this turn")).toBeTruthy();
  });

  it("an idle optimistic send is reported as awaiting delivery", () => {
    renderOutbox(makeContext([selfMessage("a", "please read this")], { agentBusy: false }));
    expect(screen.getByText("Awaiting delivery")).toBeTruthy();
    expect(screen.queryByText("Lands this turn")).toBeNull();
  });

  it("an acknowledged idle send distinguishes delivery from agent read", () => {
    renderOutbox(
      makeContext(
        [
          selfMessage("a", "please read this", {
            receipts: {
              byParticipant: { "agent:alice": "received" },
              aggregate: "pending",
            },
          }),
        ],
        { agentBusy: false }
      )
    );
    expect(screen.getByText("Delivered · awaiting agent")).toBeTruthy();
    expect(screen.queryByText("Awaiting delivery")).toBeNull();
  });

  it("inline edit calls editPendingMessage with the new text", () => {
    const editPendingMessage = vi.fn(async () => {});
    renderOutbox(makeContext([selfMessage("a", "old text")], { editPendingMessage }));
    const list = screen.getByRole("list", { name: /Outbox/i });
    fireEvent.click(within(list).getByLabelText("Edit message"));
    const textarea = list.querySelector("textarea");
    expect(textarea).toBeTruthy();
    fireEvent.change(textarea!, { target: { value: "new text" } });
    fireEvent.keyDown(textarea!, { key: "Enter" });
    expect(editPendingMessage).toHaveBeenCalledWith("a", "new text");
  });

  it("the foot-of-queue flush names its effect: 'Send now & interrupt' while busy", () => {
    const flushOutboxAndInterrupt = vi.fn(async () => {});
    renderOutbox(
      makeContext([selfMessage("a", "x")], { agentBusy: true, flushOutboxAndInterrupt })
    );
    fireEvent.click(screen.getByText("Send now & interrupt").closest("button")!);
    expect(flushOutboxAndInterrupt).toHaveBeenCalledTimes(1);
  });

  it("the flush reads plain 'Send now' when no agent is busy", () => {
    renderOutbox(makeContext([selfMessage("a", "x")], { agentBusy: false }));
    expect(screen.getByText("Send now")).toBeTruthy();
    expect(screen.queryByText("Send now & interrupt")).toBeNull();
  });
});
