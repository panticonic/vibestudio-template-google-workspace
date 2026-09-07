import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { MethodDefinition } from "@workspace/pubsub";
import {
  FULL_AGENTIC_CHAT_FEATURES,
  composeAgenticChatMethods,
  resolveAgenticChatFeatures,
  selectAgenticChatTranscriptMessages,
} from "./features";

function method(name: string): MethodDefinition {
  return {
    description: name,
    parameters: z.object({}),
    execute: async () => ({ ok: true }),
  };
}

describe("agentic chat features", () => {
  it("resolves the explicit full capability preset", () => {
    expect(resolveAgenticChatFeatures(FULL_AGENTIC_CHAT_FEATURES)).toEqual({
      feedback: true,
      inlineUi: true,
      actionBar: true,
      clientEval: true,
    });
  });

  it("selects every capability independently", () => {
    expect(resolveAgenticChatFeatures([])).toEqual({
      feedback: false,
      inlineUi: false,
      actionBar: false,
      clientEval: false,
    });
    expect(resolveAgenticChatFeatures(["feedback", "client-eval"])).toEqual({
      feedback: true,
      inlineUi: false,
      actionBar: false,
      clientEval: true,
    });
  });

  it("composes independently owned method groups", () => {
    expect(
      Object.keys(
        composeAgenticChatMethods({ inspect_card: method("inspect_card") }, undefined, {
          inline_ui: method("inline_ui"),
        })
      )
    ).toEqual(["inspect_card", "inline_ui"]);
  });

  it("rejects duplicate method ownership", () => {
    expect(() =>
      composeAgenticChatMethods(
        { inline_ui: method("inline_ui") },
        { inline_ui: method("custom inline_ui") }
      )
    ).toThrow('AgenticChat method "inline_ui" has multiple owners');
  });

  it("omits historical inline UI only from stock presentation", () => {
    const messages = [
      { id: "text", senderId: "agent", kind: "message" as const, content: "hello" },
      {
        id: "inline",
        senderId: "agent",
        kind: "message" as const,
        content: "{}",
        contentType: "inline_ui" as const,
      },
    ];

    expect(
      selectAgenticChatTranscriptMessages(messages, resolveAgenticChatFeatures([])).map(
        (message) => message.id
      )
    ).toEqual(["text"]);
    expect(
      selectAgenticChatTranscriptMessages(
        messages,
        resolveAgenticChatFeatures(FULL_AGENTIC_CHAT_FEATURES)
      )
    ).toBe(messages);
  });
});
