// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Participant } from "@workspace/pubsub";
import { useMentionAutocomplete } from "./useMentionAutocomplete";
import type { ChatParticipantMetadata } from "../types";
import { getMentionsFromInput } from "../context/ChatInputContext";

const roster = {
  "panel:user": { id: "panel:user", metadata: { name: "Chat Panel", type: "panel", handle: "alice" } },
  "agent:ai": { id: "agent:ai", metadata: { name: "AI Chat", type: "agent", handle: "ai-chat" } },
} as unknown as Record<string, Participant<ChatParticipantMetadata>>;

describe("useMentionAutocomplete", () => {
  it("excludes the client's own participant (you can't @-mention the chat panel itself)", () => {
    const { result } = renderHook(() => useMentionAutocomplete(roster, "panel:user"));
    expect(result.current.candidates.map((c) => c.handle)).toEqual(["ai-chat"]);
  });

  it("includes everyone when no selfId is given", () => {
    const { result } = renderHook(() => useMentionAutocomplete(roster));
    expect(result.current.candidates.map((c) => c.handle).sort()).toEqual(["ai-chat", "alice"]);
  });

  it("uses live account profiles for canonical humans whose roster metadata has no handle", () => {
    const canonical = {
      "user:usr_alice": {
        id: "user:usr_alice",
        metadata: { kind: "user", type: "user" },
      },
    } as unknown as Record<string, Participant<ChatParticipantMetadata>>;
    const profiles = new Map([
      [
        "user:usr_alice",
        { userId: "usr_alice", handle: "alice", displayName: "Alice" },
      ],
    ]);
    const { result } = renderHook(() =>
      useMentionAutocomplete(canonical, null, profiles)
    );

    expect(result.current.candidates).toEqual([
      {
        participantId: "user:usr_alice",
        handle: "alice",
        name: "Alice",
        type: "user",
      },
    ]);
    expect(getMentionsFromInput("Please ask @alice", canonical, undefined, profiles)).toEqual([
      "user:usr_alice",
    ]);
  });
});
