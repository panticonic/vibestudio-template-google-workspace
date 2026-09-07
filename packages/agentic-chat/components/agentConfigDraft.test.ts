import { describe, expect, it } from "vitest";
import type { AvailableAgent, ModelCatalog } from "@workspace/agentic-core";
import { makeTestCatalogEntry } from "@workspace/model-catalog/testing";
import { draftForAgent } from "./agentConfigDraft.js";

const CATALOG_DEFAULT = "openai-codex:gpt-5.6-sol";
const EFFECTIVE_DEFAULT = "openai-codex:gpt-5.3-codex-spark";
const WORKER_DEFAULT = "anthropic:claude-sonnet-4-6";

const catalogDefault = makeTestCatalogEntry({
  ref: CATALOG_DEFAULT,
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
});
catalogDefault.modelSpec.serviceTiers = ["priority"];

const CATALOG: ModelCatalog = {
  providers: [],
  models: [
    catalogDefault,
    makeTestCatalogEntry({
      ref: EFFECTIVE_DEFAULT,
      id: "gpt-5.3-codex-spark",
      name: "GPT-5.3 Codex Spark",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
    }),
  ],
};

const AGENT: AvailableAgent = {
  id: "workers/agent-worker",
  className: "AiChatWorker",
  name: "AI Chat",
  proposedHandle: "ai-chat",
};

describe("draftForAgent", () => {
  it("uses the effective host model before the catalog default", () => {
    const draft = draftForAgent(AGENT, {
      modelCatalog: CATALOG,
      defaultModelRef: CATALOG_DEFAULT,
      defaultAgentConfig: { model: EFFECTIVE_DEFAULT },
    });

    expect(draft.model).toBe(EFFECTIVE_DEFAULT);
  });

  it("layers effective host defaults over generic worker defaults", () => {
    const draft = draftForAgent(
      {
        ...AGENT,
        defaultConfig: {
          model: WORKER_DEFAULT,
          thinkingLevel: "low",
          approvalLevel: 0,
        },
      },
      {
        modelCatalog: CATALOG,
        defaultModelRef: CATALOG_DEFAULT,
        defaultAgentConfig: {
          model: EFFECTIVE_DEFAULT,
          thinkingLevel: "high",
          approvalLevel: 2,
        },
      }
    );

    expect(draft).toMatchObject({
      model: EFFECTIVE_DEFAULT,
      thinkingLevel: "high",
      approvalLevel: 2,
    });
  });

  it("uses a worker model default before the catalog fallback when no host default exists", () => {
    const draft = draftForAgent(
      {
        ...AGENT,
        defaultConfig: { model: WORKER_DEFAULT },
      },
      {
        modelCatalog: CATALOG,
        defaultModelRef: CATALOG_DEFAULT,
        defaultAgentConfig: null,
      }
    );

    expect(draft.model).toBe(WORKER_DEFAULT);
  });

  it("falls back to the catalog default when no configured model exists", () => {
    const draft = draftForAgent(AGENT, {
      modelCatalog: CATALOG,
      defaultModelRef: CATALOG_DEFAULT,
      defaultAgentConfig: null,
    });

    expect(draft.model).toBe(CATALOG_DEFAULT);
    expect(draft.thinkingLevel).toBe("medium");
    expect(draft.fastMode).toBe(true);
  });

  it("preserves an explicit Fast mode opt-out for a supported Codex model", () => {
    const draft = draftForAgent(AGENT, {
      modelCatalog: CATALOG,
      defaultModelRef: CATALOG_DEFAULT,
      defaultAgentConfig: { model: CATALOG_DEFAULT, fastMode: false },
    });

    expect(draft.fastMode).toBe(false);
  });
});
