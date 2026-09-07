import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { WorkspaceConfig } from "@workspace/runtime/worker";
import {
  DEFAULT_AGENT_MODEL_REF,
  LOCAL_DEFAULT_MODEL_REF,
  LOCAL_FALLBACK_MODEL_REF,
  type DefaultAgentConfig,
  type ModelCatalog,
} from "@workspace/model-catalog/catalog";
import type { LocalModelEntry } from "@workspace/model-catalog/localModels";
import { makeTestCatalogEntry } from "@workspace/model-catalog/testing";
import type { StoredCredentialSummary } from "@vibestudio/credential-client";
import { getModelCatalog, localEntryToCatalogEntry, ModelSettingsDO } from "./index.js";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";

const BASE_CONFIG = { id: "test", systemEpoch: WORKSPACE_SYSTEM_EPOCH } as const;

function localEntry(fields: Partial<LocalModelEntry> = {}): LocalModelEntry {
  return {
    slug: "lfm2.5-2.6b",
    displayName: "LFM2.5 2.6B",
    baseUrl: "http://127.0.0.1:0/v1",
    server: "utility",
    contextWindow: 32_768,
    maxTokens: 32_768,
    measuredTokensPerSec: null,
    toolsCapable: true,
    reasoningCapable: false,
    fit: {
      fit: "cpu-only",
      estTokensPerSec: null,
      contextLength: 32_768,
      gpuLayers: 0,
      notes: [],
    },
    state: "not-installed",
    download: null,
    errorMessage: null,
    ...fields,
  };
}

function storedCredential(
  id: string,
  url: string,
  lifecycle: StoredCredentialSummary["lifecycle"] = { state: "active", canRefresh: false }
): StoredCredentialSummary {
  return {
    id,
    label: id,
    audience: [{ url, match: "origin" }],
    injection: {
      type: "header",
      name: "authorization",
      valueTemplate: "Bearer {token}",
    },
    scopes: [],
    lifecycle,
  };
}

const CATALOG: ModelCatalog = {
  providers: [
    {
      id: "openai",
      label: "openai",
      baseUrls: ["https://api.openai.com/v1"],
      recommendedModelRef: "openai:gpt-5",
      connectable: true,
    },
    {
      id: "anthropic",
      label: "anthropic",
      baseUrls: ["https://api.anthropic.com/v1"],
      recommendedModelRef: "anthropic:claude-opus-4-1",
      connectable: true,
    },
  ],
  models: [
    makeTestCatalogEntry({
      ref: "openai:gpt-5",
      id: "gpt-5",
      name: "GPT-5",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      vision: true,
      contextWindow: 128000,
      maxTokens: 16000,
      thinkingLevels: ["minimal", "low", "medium", "high"],
      recommended: true,
    }),
    makeTestCatalogEntry({
      ref: "anthropic:claude-opus-4-1",
      id: "claude-opus-4-1",
      name: "Claude Opus 4.1",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      reasoning: true,
      vision: true,
      contextWindow: 200000,
      maxTokens: 32000,
      thinkingLevels: ["low", "medium", "high"],
      recommended: true,
    }),
  ],
};

const CODEX_CATALOG_ENTRY = makeTestCatalogEntry({
  ref: "openai-codex:gpt-5.6-sol",
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  recommended: true,
});
CODEX_CATALOG_ENTRY.modelSpec.serviceTiers = ["priority"];
const CODEX_CATALOG: ModelCatalog = {
  providers: [],
  models: [CODEX_CATALOG_ENTRY],
};

class TestModelSettingsDO extends ModelSettingsDO {
  static config: WorkspaceConfig = { ...BASE_CONFIG };
  static writes: Array<{ key: string; value: unknown }> = [];

  protected getCatalog(): Promise<ModelCatalog> {
    return Promise.resolve(CATALOG);
  }

  // Both fixture providers count as usable — availability is a worker overlay
  // now (design §7.1), so the seam is lifecycle summaries, not entry fields.
  protected storedCredentials(): Promise<StoredCredentialSummary[]> {
    return Promise.resolve([
      storedCredential("openai", "https://api.openai.com/v1"),
      storedCredential("anthropic", "https://api.anthropic.com/v1"),
    ]);
  }

  // No local-models extension in the unit harness.
  protected fetchLocalModels(): Promise<LocalModelEntry[]> {
    return Promise.resolve([]);
  }

  protected getWorkspaceConfig(): Promise<WorkspaceConfig> {
    return Promise.resolve(TestModelSettingsDO.config);
  }

  protected setWorkspaceConfigField(key: string, value: unknown): Promise<void> {
    TestModelSettingsDO.writes.push({ key, value });
    TestModelSettingsDO.config = {
      ...TestModelSettingsDO.config,
      [key]: value,
    };
    return Promise.resolve();
  }
}

/** No credentials at all + a live local fallback — the offline first-run shape. */
class OfflineModelSettingsDO extends TestModelSettingsDO {
  protected override storedCredentials(): Promise<StoredCredentialSummary[]> {
    return Promise.resolve([]);
  }

  protected override fetchLocalModels() {
    return Promise.resolve([
      localEntry({
        baseUrl: "http://127.0.0.1:43117/v1",
        measuredTokensPerSec: 18.4,
        state: "ready" as const,
      }),
    ]);
  }
}

class ExpiredModelSettingsDO extends TestModelSettingsDO {
  static lifecycle: StoredCredentialSummary["lifecycle"] = {
    state: "expired",
    canRefresh: false,
  };

  protected override storedCredentials(): Promise<StoredCredentialSummary[]> {
    return Promise.resolve([
      storedCredential("openai", "https://api.openai.com/v1", ExpiredModelSettingsDO.lifecycle),
    ]);
  }
}

class CodexModelSettingsDO extends TestModelSettingsDO {
  protected override getCatalog(): Promise<ModelCatalog> {
    return Promise.resolve(CODEX_CATALOG);
  }
}

describe("ModelSettingsDO", () => {
  it("treats an absent local model as setup-required", () => {
    expect(
      localEntryToCatalogEntry(
        localEntry({
          state: "not-installed",
        })
      ).availability
    ).toEqual({ state: "needs-setup", detail: "not-installed" });
  });

  it("preserves local download phase and byte progress in the catalog", () => {
    expect(
      localEntryToCatalogEntry(
        localEntry({
          state: "downloading",
          download: {
            progress: 0.4,
            phase: "paused",
            receivedBytes: 280_000_000,
            totalBytes: 700_000_000,
          },
        })
      ).availability
    ).toEqual({
      state: "downloading",
      progress: 0.4,
      phase: "paused",
      receivedBytes: 280_000_000,
      totalBytes: 700_000_000,
    });
  });

  it("keeps local models unavailable while the runtime is being prepared", () => {
    expect(
      localEntryToCatalogEntry(
        localEntry({
          state: "starting",
        })
      ).availability
    ).toEqual({ state: "starting" });
  });

  it("recommends Qwen3.8 while keeping the compact model as fallback only", () => {
    expect(
      localEntryToCatalogEntry(
        localEntry({
          slug: "qwen3.8-27b",
          displayName: "Qwen3.8 27B",
          server: "main",
          reasoningCapable: true,
        })
      ).recommended
    ).toBe(true);
    expect(localEntryToCatalogEntry(localEntry()).recommended).toBe(false);
    expect(LOCAL_DEFAULT_MODEL_REF).toBe("local:qwen3.8-27b");
    expect(LOCAL_FALLBACK_MODEL_REF).toBe("local:lfm2.5-2.6b");
  });

  it("projects local reasoning capability into the pi model spec", () => {
    expect(localEntryToCatalogEntry(localEntry({ reasoningCapable: true }))).toMatchObject({
      reasoning: true,
      modelSpec: { reasoning: true },
    });
  });

  it("projects the Codex 5.6 Sol registry entry and all enabled effort levels", async () => {
    const catalog = await getModelCatalog();
    const sol = catalog.models.find((model) => model.ref === DEFAULT_AGENT_MODEL_REF);

    expect(DEFAULT_AGENT_MODEL_REF).toBe("openai-codex:gpt-5.6-sol");
    expect(catalog.providers.find((provider) => provider.id === "openai-codex")?.label).toBe(
      "GPT Codex"
    );
    expect(sol).toMatchObject({
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      contextWindow: 272_000,
      thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"],
      modelSpec: {
        serviceTiers: ["priority"],
        thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
      },
    });
  }, 30_000);

  it("reads the configured workspace default agent config (model + behavior)", async () => {
    TestModelSettingsDO.config = {
      ...BASE_CONFIG,
      defaultAgentConfig: {
        model: "anthropic:claude-opus-4-1",
        thinkingLevel: "high",
        approvalLevel: 1,
      },
    };
    const { call } = await createTestDO(TestModelSettingsDO);

    await expect(call("getSettings")).resolves.toMatchObject({
      defaultModel: "anthropic:claude-opus-4-1",
      defaultModelSource: "workspace",
      defaultAgentConfig: {
        model: "anthropic:claude-opus-4-1",
        thinkingLevel: "high",
        approvalLevel: 1,
      },
    });
  });

  it("defaults supported Codex models to Fast mode without overriding an opt-out", async () => {
    TestModelSettingsDO.config = { ...BASE_CONFIG };
    const { call } = await createTestDO(CodexModelSettingsDO);

    await expect(call("getSettings")).resolves.toMatchObject({
      defaultAgentConfig: {
        model: "openai-codex:gpt-5.6-sol",
        fastMode: true,
      },
    });

    TestModelSettingsDO.config = {
      ...BASE_CONFIG,
      defaultAgentConfig: {
        model: "openai-codex:gpt-5.6-sol",
        fastMode: false,
      },
    };
    await expect(call("getSettings")).resolves.toMatchObject({
      defaultAgentConfig: {
        model: "openai-codex:gpt-5.6-sol",
        fastMode: false,
      },
    });
  });

  it("returns the same resolved Fast mode that a subsequent settings read observes", async () => {
    TestModelSettingsDO.config = { ...BASE_CONFIG };
    TestModelSettingsDO.writes = [];
    const { call } = await createTestDO(CodexModelSettingsDO);

    await expect(
      call("setDefaultAgentConfig", { model: "openai-codex:gpt-5.6-sol" })
    ).resolves.toMatchObject({
      defaultAgentConfig: {
        model: "openai-codex:gpt-5.6-sol",
        fastMode: true,
      },
    });
    expect(TestModelSettingsDO.writes.at(-1)?.value).toEqual({
      model: "openai-codex:gpt-5.6-sol",
      fastMode: true,
    });

    TestModelSettingsDO.config = {
      ...BASE_CONFIG,
      defaultAgentConfig: TestModelSettingsDO.writes.at(-1)?.value as DefaultAgentConfig,
    };
    await expect(call("getSettings")).resolves.toMatchObject({
      defaultAgentConfig: {
        model: "openai-codex:gpt-5.6-sol",
        fastMode: true,
      },
    });
  });

  it("inspects only requested model availability without transporting the catalog", async () => {
    TestModelSettingsDO.config = { ...BASE_CONFIG };
    const { call } = await createTestDO(TestModelSettingsDO);

    await expect(
      call("inspectModels", ["openai:gpt-5", "missing:model", "openai:gpt-5"])
    ).resolves.toEqual({
      defaultModel: "openai:gpt-5",
      models: [
        {
          ref: "openai:gpt-5",
          availability: { state: "ready", detail: "credentialed" },
        },
        {
          ref: "missing:model",
          availability: { state: "error", message: "Unknown model ref" },
        },
      ],
    });
  });

  it("falls back when the configured model is missing, keeping valid behavior", async () => {
    TestModelSettingsDO.config = {
      ...BASE_CONFIG,
      defaultAgentConfig: { model: "missing:model", thinkingLevel: "low" },
    };
    const { call } = await createTestDO(TestModelSettingsDO);

    await expect(call("getSettings")).resolves.toMatchObject({
      defaultModel: "openai:gpt-5",
      defaultModelSource: "fallback",
      invalidDefaultModel: "missing:model",
      defaultAgentConfig: { model: "openai:gpt-5", thinkingLevel: "low" },
    });
  });

  it("keeps an unavailable configured model selected for provider setup", async () => {
    TestModelSettingsDO.config = {
      ...BASE_CONFIG,
      defaultAgentConfig: { model: "openai:gpt-5", thinkingLevel: "low" },
    };
    const { call } = await createTestDO(OfflineModelSettingsDO);

    await expect(call("getSettings")).resolves.toMatchObject({
      defaultModel: "openai:gpt-5",
      defaultModelSource: "workspace",
      defaultAgentConfig: { model: "openai:gpt-5", thinkingLevel: "low" },
      catalog: {
        models: expect.arrayContaining([
          expect.objectContaining({
            ref: "openai:gpt-5",
            availability: { state: "needs-setup", detail: "no-credential" },
          }),
        ]),
      },
    });
  });

  it("falls back to the local floor when nothing is credentialed (offline first-run)", async () => {
    TestModelSettingsDO.config = { ...BASE_CONFIG };
    const { call } = await createTestDO(OfflineModelSettingsDO);

    const snapshot = await call("getSettings");
    expect(snapshot).toMatchObject({
      defaultModel: "local:lfm2.5-2.6b",
      defaultModelSource: "fallback",
    });
    const catalog = (snapshot as { catalog: ModelCatalog }).catalog;
    expect(catalog.providers.find((provider) => provider.id === "local")?.label).toBe(
      "Local inference (experimental)"
    );
    const local = catalog.models.find((m) => m.ref === "local:lfm2.5-2.6b");
    expect(local).toMatchObject({
      auth: "loopback",
      availability: { state: "ready" },
      tokensPerSec: 18.4,
      capabilities: { tools: true },
    });
    // Cloud entries degrade to needs-setup without credentials.
    const cloud = catalog.models.find((m) => m.ref === "openai:gpt-5");
    expect(cloud?.availability).toMatchObject({ state: "needs-setup" });
    // The journaled spec is secret-free by construction.
    expect(JSON.stringify(local?.modelSpec)).not.toMatch(/authorization|api[-_]?key/iu);
  });

  it("reports the deterministic inference runtime as usable without a fake credential", async () => {
    TestModelSettingsDO.config = { ...BASE_CONFIG };
    const { call } = await createTestDO(OfflineModelSettingsDO, {
      VIBESTUDIO_TEST_MODE: "1",
    });

    const snapshot = await call("getSettings");
    expect(snapshot).toMatchObject({
      defaultModel: "openai:gpt-5",
      defaultModelSource: "fallback",
    });
    const catalog = (snapshot as { catalog: ModelCatalog }).catalog;
    expect(catalog.models.find((model) => model.ref === "openai:gpt-5")?.availability).toEqual({
      state: "ready",
      detail: "deterministic-test",
    });
  });

  it("does not report an expired credential without persisted refresh material as ready", async () => {
    TestModelSettingsDO.config = { ...BASE_CONFIG };
    ExpiredModelSettingsDO.lifecycle = { state: "expired", canRefresh: false };
    const { call } = await createTestDO(ExpiredModelSettingsDO);

    const snapshot = (await call("getSettings")) as { catalog: ModelCatalog };
    expect(snapshot.catalog.models.find((model) => model.ref === "openai:gpt-5")).toMatchObject({
      availability: { state: "needs-setup", detail: "credential-expired" },
    });
  });

  it("keeps an expired credential ready when persisted material can renew it", async () => {
    TestModelSettingsDO.config = { ...BASE_CONFIG };
    ExpiredModelSettingsDO.lifecycle = { state: "expired", canRefresh: true };
    const { call } = await createTestDO(ExpiredModelSettingsDO);

    const snapshot = (await call("getSettings")) as { catalog: ModelCatalog };
    expect(snapshot.catalog.models.find((model) => model.ref === "openai:gpt-5")).toMatchObject({
      availability: { state: "ready", detail: "credentialed" },
    });
  });

  it("persists a validated default agent config to workspace config", async () => {
    TestModelSettingsDO.config = { ...BASE_CONFIG };
    TestModelSettingsDO.writes = [];
    const { call } = await createTestDO(TestModelSettingsDO);

    await expect(
      call("setDefaultAgentConfig", {
        model: "anthropic:claude-opus-4-1",
        thinkingLevel: "high",
        fastMode: true,
        approvalLevel: 2,
      })
    ).resolves.toMatchObject({
      defaultModel: "anthropic:claude-opus-4-1",
      defaultModelSource: "workspace",
      defaultAgentConfig: {
        model: "anthropic:claude-opus-4-1",
        thinkingLevel: "high",
        fastMode: true,
        approvalLevel: 2,
      },
    });
    expect(TestModelSettingsDO.writes).toEqual([
      {
        key: "defaultAgentConfig",
        value: {
          model: "anthropic:claude-opus-4-1",
          thinkingLevel: "high",
          fastMode: true,
          approvalLevel: 2,
        },
      },
    ]);
  });

  it("persists extended effort levels", async () => {
    TestModelSettingsDO.config = { ...BASE_CONFIG };
    TestModelSettingsDO.writes = [];
    const { call } = await createTestDO(TestModelSettingsDO);

    await call("setDefaultAgentConfig", {
      model: "openai:gpt-5",
      thinkingLevel: "max",
      approvalLevel: 2,
    });

    expect(TestModelSettingsDO.writes).toEqual([
      {
        key: "defaultAgentConfig",
        value: {
          model: "openai:gpt-5",
          thinkingLevel: "max",
          fastMode: false,
          approvalLevel: 2,
        },
      },
    ]);
  });

  it("rejects invalid behavior fields instead of silently dropping them", async () => {
    TestModelSettingsDO.config = { ...BASE_CONFIG };
    TestModelSettingsDO.writes = [];
    const { call } = await createTestDO(TestModelSettingsDO);

    await expect(
      call("setDefaultAgentConfig", {
        model: "openai:gpt-5",
        thinkingLevel: "bogus",
        approvalLevel: 9,
      })
    ).rejects.toThrow(/thinkingLevel/);
    expect(TestModelSettingsDO.writes).toEqual([]);
  });

  it("rejects malformed stored configuration instead of normalizing it", async () => {
    TestModelSettingsDO.config = {
      ...BASE_CONFIG,
      defaultAgentConfig: { model: "openai:gpt-5", retiredField: true },
    } as never;
    const { call } = await createTestDO(TestModelSettingsDO);
    await expect(call("getSettings")).rejects.toThrow(/unknown field/);
  });

  it("rejects unknown default model refs", async () => {
    TestModelSettingsDO.config = { ...BASE_CONFIG };
    const { call } = await createTestDO(TestModelSettingsDO);

    await expect(call("setDefaultAgentConfig", { model: "missing:model" })).rejects.toThrow(
      "Unknown model ref: missing:model"
    );
  });
});
