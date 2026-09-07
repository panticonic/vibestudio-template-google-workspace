import { describe, expect, it } from "vitest";
// Mistral's provider pulls in its SDK lazily. Preload the real API module during
// test collection so the payload assertion itself is not timed by SDK startup
// under full-suite load.
import "@workspace/pi-ai/api/mistral-conversations";
import { stream } from "@workspace/pi-ai/compat";
import type { Api, Context, Model, ProviderStreamOptions } from "@workspace/pi-ai";
import type { ThinkingLevel } from "@workspace/agent-loop";
import { buildRawThinkingOptions, type RawThinkingModel } from "./pi-raw-thinking-options.js";

const context: Context = {
  systemPrompt: "Be concise.",
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: 0,
    },
  ],
};

function model(
  api: Api,
  id: string,
  overrides: Partial<Omit<Model<Api>, "thinkingLevelMap">> & {
    thinkingLevelMap?: RawThinkingModel["thinkingLevelMap"];
  } = {}
): Model<Api> & RawThinkingModel {
  return {
    id,
    name: id,
    api,
    provider: providerFor(api),
    baseUrl: baseUrlFor(api),
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
    ...overrides,
  } as Model<Api> & RawThinkingModel;
}

function providerFor(api: Api): string {
  switch (api) {
    case "anthropic-messages":
      return "anthropic";
    case "bedrock-converse-stream":
      return "amazon-bedrock";
    case "google-generative-ai":
      return "google";
    case "mistral-conversations":
      return "mistral";
    case "openai-codex-responses":
      return "openai-codex";
    default:
      return "openai";
  }
}

function baseUrlFor(api: Api): string {
  switch (api) {
    case "anthropic-messages":
      return "https://api.anthropic.com";
    case "bedrock-converse-stream":
      return "https://bedrock-runtime.us-east-1.amazonaws.com";
    case "google-generative-ai":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "mistral-conversations":
      return "https://api.mistral.ai";
    case "openai-codex-responses":
      return "https://chatgpt.com/backend-api";
    default:
      return "https://api.openai.com/v1";
  }
}

function rawThinkingOptions(
  rawModel: RawThinkingModel,
  level: ThinkingLevel = "medium"
): Record<string, unknown> {
  return buildRawThinkingOptions(rawModel, level) as Record<string, unknown>;
}

function fakeCodexJwt(): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" },
    })
  ).toString("base64");
  return `header.${payload}.signature`;
}

async function capturePayload(
  rawModel: Model<Api> & RawThinkingModel,
  options: ProviderStreamOptions = {},
  level: ThinkingLevel = "medium"
): Promise<Record<string, unknown>> {
  let captured: unknown;
  const streamResult = stream(rawModel, context, {
    apiKey: rawModel.api === "openai-codex-responses" ? fakeCodexJwt() : "test-key",
    bearerToken: "test-bedrock-bearer",
    ...options,
    ...buildRawThinkingOptions(rawModel, level),
    onPayload(payload) {
      captured = payload;
      throw new Error("captured payload");
    },
  });

  await streamResult.result();
  expect(captured).toBeDefined();
  return captured as Record<string, unknown>;
}

describe("buildRawThinkingOptions", () => {
  it("maps OpenAI Responses/Codex thinking to raw reasoning options", () => {
    expect(rawThinkingOptions(model("openai-codex-responses", "gpt-5-codex"))).toEqual({
      reasoningEffort: "medium",
      reasoningSummary: "auto",
    });
  });

  it("preserves max effort for Codex models that advertise it", () => {
    expect(
      rawThinkingOptions(
        model("openai-codex-responses", "gpt-5.6-sol", {
          thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
        }),
        "max"
      )
    ).toEqual({
      reasoningEffort: "max",
      reasoningSummary: "auto",
    });
  });

  it("maps Anthropic thinking to raw budget-based options", () => {
    expect(rawThinkingOptions(model("anthropic-messages", "claude-sonnet-4-20250514"))).toEqual({
      maxTokens: 64_000,
      thinkingEnabled: true,
      thinkingBudgetTokens: 8192,
    });
  });

  it("maps Anthropic adaptive thinking for models that require it", () => {
    expect(
      rawThinkingOptions(
        model("anthropic-messages", "claude-opus-4-7", {
          compat: { forceAdaptiveThinking: true } as never,
        })
      )
    ).toEqual({
      thinkingEnabled: true,
      effort: "medium",
    });
  });

  it("maps Google thinking to raw thinking config options", () => {
    expect(rawThinkingOptions(model("google-generative-ai", "gemini-2.5-pro"))).toEqual({
      thinking: { enabled: true, budgetTokens: 8192 },
    });
  });

  it("maps Bedrock Claude thinking to raw reasoning and thinking budget options", () => {
    expect(
      rawThinkingOptions(
        model("bedrock-converse-stream", "anthropic.claude-3-7-sonnet-20250219-v1:0")
      )
    ).toEqual({
      maxTokens: 64_000,
      reasoning: "medium",
      thinkingBudgets: { medium: 8192 },
    });
  });

  it("maps Mistral thinking to raw reasoning effort where required", () => {
    expect(rawThinkingOptions(model("mistral-conversations", "mistral-small-latest"))).toEqual({
      reasoningEffort: "high",
    });
  });
});

describe("raw provider thinking payloads", () => {
  it("turns on OpenAI Codex Responses reasoning summaries and encrypted content", async () => {
    const payload = await capturePayload(model("openai-codex-responses", "gpt-5-codex"));

    expect(payload).toMatchObject({
      reasoning: { effort: "medium", summary: "auto" },
      include: ["reasoning.encrypted_content"],
    });
  });

  it("sends max effort in the OpenAI Codex Responses payload", async () => {
    const payload = await capturePayload(
      model("openai-codex-responses", "gpt-5.6-sol", {
        thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
      }),
      {},
      "max"
    );

    expect(payload).toMatchObject({
      reasoning: { effort: "max", summary: "auto" },
      include: ["reasoning.encrypted_content"],
    });
  });

  it("turns on Anthropic budget-based thinking", async () => {
    const payload = await capturePayload(model("anthropic-messages", "claude-sonnet-4-20250514"));

    expect(payload).toMatchObject({
      max_tokens: 64_000,
      thinking: { type: "enabled", budget_tokens: 8192, display: "summarized" },
    });
  });

  it("turns on Google thinking thoughts with the requested budget", async () => {
    const payload = await capturePayload(model("google-generative-ai", "gemini-2.5-pro"));

    expect(payload).toMatchObject({
      config: {
        thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 },
      },
    });
  });

  it("turns on Bedrock Claude thinking with the requested budget", async () => {
    const payload = await capturePayload(
      model("bedrock-converse-stream", "anthropic.claude-3-7-sonnet-20250219-v1:0")
    );

    expect(payload).toMatchObject({
      inferenceConfig: { maxTokens: 64_000 },
      additionalModelRequestFields: {
        thinking: { type: "enabled", budget_tokens: 8192, display: "summarized" },
      },
    });
  });

  it("turns on Mistral reasoning effort", async () => {
    const payload = await capturePayload(model("mistral-conversations", "mistral-small-latest"));

    expect(payload).toMatchObject({
      reasoningEffort: "high",
    });
  }, 30_000);
});
