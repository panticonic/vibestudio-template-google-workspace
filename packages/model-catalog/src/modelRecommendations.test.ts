import { describe, expect, it } from "vitest";

import { pickRecommendedModelId } from "./modelRecommendations";

describe("modelRecommendations", () => {
  it("prefers flagship provider families over smaller variants", () => {
    expect(
      pickRecommendedModelId("anthropic", [
        { id: "claude-3-5-haiku-latest" },
        { id: "claude-3-5-sonnet-20241022" },
      ])
    ).toBe("claude-3-5-sonnet-20241022");

    expect(
      pickRecommendedModelId("google", [{ id: "gemini-2.5-flash" }, { id: "gemini-2.5-pro" }])
    ).toBe("gemini-2.5-pro");
  });

  it("selects Sol from the Codex 5.6 flagship variants", () => {
    expect(
      pickRecommendedModelId("openai-codex", [
        { id: "gpt-5.6-luna" },
        { id: "gpt-5.6-terra" },
        { id: "gpt-5.5-codex" },
        { id: "gpt-5.6-sol" },
      ])
    ).toBe("gpt-5.6-sol");
  });
});
