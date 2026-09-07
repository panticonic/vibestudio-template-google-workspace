import { describe, expect, it, vi } from "vitest";
import type { ChannelEvent } from "@workspace/pubsub";
import { broadcast, loadBroadcastParticipants } from "./broadcast.js";

function channelEvent(senderId: string): ChannelEvent {
  return {
    id: 1,
    messageId: "message-1",
    type: "agentic.trajectory.v1/event",
    payload: { kind: "message.read" },
    senderId,
    ts: Date.now(),
  };
}

describe("activation-local broadcast", () => {
  it("delivers only to activation-local external participants", () => {
    const deliverParticipant = vi.fn();
    broadcast(
      {
        objectKey: "channel-1",
        participants: () => [{ id: "panel:sender" }, { id: "panel:reader" }],
        deliverParticipant,
      },
      channelEvent("panel:sender"),
      { kind: "log", phase: "live" },
      "panel:sender"
    );

    expect(deliverParticipant).toHaveBeenCalledTimes(2);
    expect(deliverParticipant).toHaveBeenCalledWith(
      "panel:reader",
      expect.objectContaining({ channelId: "channel-1" })
    );
  });

  it("loads the external-session roster without transport policy metadata", () => {
    const exec = vi.fn(() => ({
      toArray: () => [{ id: "panel:one" }, { id: "headless:two" }],
    }));

    expect(loadBroadcastParticipants({ exec } as never)).toEqual([
      { id: "panel:one" },
      { id: "headless:two" },
    ]);
    expect(exec).toHaveBeenCalledWith("SELECT id FROM participants");
  });
});
