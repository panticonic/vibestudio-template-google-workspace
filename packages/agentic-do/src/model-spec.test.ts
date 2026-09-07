import { describe, expect, it } from "vitest";
import {
  LOCAL_FALLBACK_MODEL_REF,
  materializeModel,
  type LocalModelDescriptor,
} from "./model-spec.js";

describe("local model materialization", () => {
  it("uses the bundled model's real 128K window before catalog refresh", () => {
    expect(LOCAL_FALLBACK_MODEL_REF).toBe("local:lfm2.5-2.6b");
    expect(materializeModel("local", "lfm2.5-2.6b", null)?.spec).toMatchObject({
      contextWindow: 128_000,
      maxTokens: 128_000,
      streamIdleTimeoutMs: 60_000,
    });
  });

  it("uses imported model metadata without imposing a smaller default", () => {
    const entry: LocalModelDescriptor = {
      slug: "custom-model",
      displayName: "Custom model",
      baseUrl: "http://127.0.0.1:1234/v1",
      contextWindow: 131_072,
      maxTokens: 8192,
      toolsCapable: true,
      reasoningCapable: false,
    };

    expect(materializeModel("local", entry.slug, entry)?.spec).toMatchObject({
      contextWindow: 131_072,
      maxTokens: 8192,
      streamIdleTimeoutMs: 60_000,
    });
  });

  it("preserves GGUF-declared reasoning support", () => {
    const entry: LocalModelDescriptor = {
      slug: "reasoning-model",
      displayName: "Reasoning model",
      baseUrl: "http://127.0.0.1:1234/v1",
      contextWindow: 262_144,
      maxTokens: 65_536,
      toolsCapable: true,
      reasoningCapable: true,
    };

    expect(materializeModel("local", entry.slug, entry)?.spec.reasoning).toBe(
      true,
    );
  });

  it("does not invent metadata for an unknown local model", () => {
    expect(materializeModel("local", "custom-model", null)).toBeNull();
  });
});

describe("Codex service-tier materialization", () => {
  it("materializes GPT-6 Astra for API-key and Codex providers", () => {
    const expected = {
      contextWindow: 272_000,
      maxTokens: 128_000,
      cost: {
        input: 10,
        output: 50,
        cacheRead: 1,
        cacheWrite: 12.5,
      },
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
    };

    expect(materializeModel("openai", "gpt-6-astra", null)?.spec).toMatchObject(
      expected,
    );
    expect(
      materializeModel("openai-codex", "gpt-6-astra", null)?.spec,
    ).toMatchObject({
      ...expected,
      serviceTiers: ["priority"],
    });
  });

  it("advertises priority only for models supported by Fast mode", () => {
    expect(
      materializeModel("openai-codex", "gpt-5.6-sol", null)?.spec.serviceTiers,
    ).toEqual(["priority"]);
    expect(
      materializeModel("openai-codex", "gpt-5.3-codex-spark", null)?.spec
        .serviceTiers,
    ).toBeUndefined();
    expect(
      materializeModel("openai-codex", "gpt-5.4-mini", null)?.spec.serviceTiers,
    ).toBeUndefined();
  });
});
