import { describe, expect, it } from "vitest";
import { isChatMethodResult, unwrapChatMethodResult } from "./invocation-result.js";

describe("chat method results", () => {
  it("unwraps the pubsub invocation result envelope to the provider payload", () => {
    const result = {
      content: { resumed: true },
      contentType: "application/json",
    };

    expect(isChatMethodResult(result)).toBe(true);
    expect(unwrapChatMethodResult(result)).toEqual({ resumed: true });
  });

  it("unwraps exactly one envelope layer", () => {
    const result = {
      content: { content: "provider payload" },
    };

    expect(unwrapChatMethodResult(result)).toEqual({ content: "provider payload" });
  });

  it("does not treat arbitrary values as invocation result envelopes", () => {
    expect(isChatMethodResult(null)).toBe(false);
    expect(isChatMethodResult({ resumed: true })).toBe(false);
  });
});
