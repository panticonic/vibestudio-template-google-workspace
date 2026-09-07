import { describe, expect, it } from "vitest";

import { pruneAfterTurnIds, shouldAutoSendInitialPrompt, titleFromFirstUserMessage } from "./useChatCore";
import type { ChatMessage } from "../../types";

const SELF = "panel:user";
const selfMsg = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, senderId: SELF, content: "x", kind: "message", complete: true, ...extra }) as ChatMessage;

describe("titleFromFirstUserMessage", () => {
  it("uses the first message text as the default title", () => {
    expect(titleFromFirstUserMessage("Build me a todo app")).toBe("Build me a todo app");
  });

  it("normalizes whitespace", () => {
    expect(titleFromFirstUserMessage("  Build\n\nme\t\ta todo app  ")).toBe(
      "Build me a todo app"
    );
  });

  it("truncates long messages", () => {
    expect(
      titleFromFirstUserMessage(
        "Summarize this repository and identify the most important architectural risks"
      )
    ).toBe("Summarize this repository and identify the most important arc...");
  });

  it("ignores empty text", () => {
    expect(titleFromFirstUserMessage("   ")).toBeNull();
  });
});

describe("pruneAfterTurnIds", () => {
  it("drops read / retracted / errored, keeps still-pending AND not-yet-projected ids", () => {
    const ids = new Set(["pending", "read", "retracted", "errored", "inflight"]);
    const messages = [
      selfMsg("pending"), // no receipts → still pending → kept
      selfMsg("read", { receipts: { byParticipant: { a: "read" }, aggregate: "read" } }),
      selfMsg("retracted", { retracted: true }),
      selfMsg("errored", { error: "boom" }),
      // "inflight" is absent from the transcript (its echo hasn't landed yet) →
      // KEPT, so a concurrent update can't prune its tag before its message
      // arrives.
    ];
    expect([...pruneAfterTurnIds(ids, messages, SELF)]).toEqual(["pending", "inflight"]);
  });

  it("returns the same set instance when nothing drops (effect-safe)", () => {
    const ids = new Set(["a"]);
    const messages = [selfMsg("a")];
    expect(pruneAfterTurnIds(ids, messages, SELF)).toBe(ids);
  });

  it("is a no-op on an empty set", () => {
    const empty = new Set<string>();
    expect(pruneAfterTurnIds(empty, [], SELF)).toBe(empty);
  });
});

describe("shouldAutoSendInitialPrompt", () => {
  it("allows a prompt that arrives after the initial render", () => {
    expect(shouldAutoSendInitialPrompt({
      prompt: undefined,
      connected: true,
      alreadySent: false,
      hasPriorMessages: false,
    })).toBe(false);
    expect(shouldAutoSendInitialPrompt({
      prompt: "Read the docs first",
      connected: true,
      alreadySent: false,
      hasPriorMessages: false,
    })).toBe(true);
  });

  it("does not resend after the channel has history or the prompt was sent", () => {
    expect(shouldAutoSendInitialPrompt({
      prompt: "Read the docs first",
      connected: true,
      alreadySent: false,
      hasPriorMessages: true,
    })).toBe(false);
    expect(shouldAutoSendInitialPrompt({
      prompt: "Read the docs first",
      connected: true,
      alreadySent: true,
      hasPriorMessages: false,
    })).toBe(false);
  });
});
