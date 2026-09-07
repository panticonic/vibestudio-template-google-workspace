/**
 * Model settings service — the single authority on what a model IS
 * (journaled `modelSpec`) and whether it is USABLE right now (`availability`).
 *
 * Catalog = pi-ai registry entries (static, cached) + local-models extension
 * entries (live, per snapshot). Availability is computed here and shared by
 * every consumer — picker, agent config, fallback logic, CLI — replacing the
 * old panel-side connection heuristic (design
 * docs/local-models-extension-design.md §6.1/§7.1/§8).
 */

import { DurableObjectBase, rpc } from "@workspace/runtime/worker/kernel";
import type { WorkspaceConfig } from "@workspace/runtime/worker";
import {
  DEFAULT_AGENT_MODEL_REF,
  LOCAL_DEFAULT_MODEL_REF,
  LOCAL_FALLBACK_MODEL_REF,
  LOCAL_MODELS_EXTENSION_ID,
  LOCAL_PROVIDER_ID,
  WORKSPACE_DEFAULT_AGENT_CONFIG_FIELD,
  defaultFastModeForModel,
  isModelUsable,
  piModelToSpec,
  type AgentThinkingLevel,
  type DefaultAgentConfig,
  type ModelAvailability,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelCatalogProvider,
  type ModelSettingsSnapshot,
  type PiModelInput,
} from "@workspace/model-catalog/catalog";
import {
  isTemplatedBaseUrl,
  modelIsConnectable,
  providerIsConnectable,
} from "@workspace/model-catalog/providerConnect";
import { pickRecommendedModelId } from "@workspace/model-catalog/modelRecommendations";
import type { LocalModelEntry } from "@workspace/model-catalog/localModels";
import {
  getBuiltinModels,
  getBuiltinProviders,
  getSupportedThinkingLevels,
} from "@workspace/model-catalog/builtinCatalog";
import { findMatchingUrlAudience } from "@vibestudio/credential-client/urlAudience";
import {
  isStoredCredentialUsable,
  type StoredCredentialSummary,
} from "@vibestudio/credential-client";

const AGENT_THINKING_LEVELS = new Set<string>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** llama-server quirks (design §6.4); mirrors agentic-do's model-spec.ts. */
const LLAMA_SERVER_COMPAT: Record<string, unknown> = {
  supportsReasoningEffort: false,
};

let cachedCatalog: Promise<ModelCatalog> | null = null;

export function getModelCatalog(): Promise<ModelCatalog> {
  if (!cachedCatalog) {
    const catalogPromise = buildModelCatalog();
    cachedCatalog = catalogPromise;
    catalogPromise.catch(() => {
      if (cachedCatalog === catalogPromise) cachedCatalog = null;
    });
  }
  return cachedCatalog;
}

type PiModelLike = PiModelInput;

function providerLabel(providerId: string): string {
  if (providerId === "openai-codex") return "GPT Codex";
  return providerId;
}

/** Static pi-ai registry projection. Availability here is a placeholder —
 *  the snapshot overlay (applyCloudAvailability) is authoritative. */
export async function buildModelCatalog(): Promise<ModelCatalog> {
  const providerIds = getBuiltinProviders();
  const providers: ModelCatalogProvider[] = [];
  const models: ModelCatalogEntry[] = [];
  const recommendedRefs = new Set<string>();

  for (const providerId of providerIds) {
    const provModels = getBuiltinModels(providerId);
    const recommendedId = pickRecommendedModelId(providerId, provModels);
    if (recommendedId) recommendedRefs.add(`${providerId}:${recommendedId}`);
  }

  for (const providerId of providerIds) {
    const provModels = getBuiltinModels(providerId);
    const baseUrls = Array.from(
      new Set(provModels.map((model) => model.baseUrl)),
    );
    const recommendedModelId = pickRecommendedModelId(providerId, provModels);
    providers.push({
      id: providerId,
      label: providerLabel(providerId),
      baseUrls,
      recommendedModelRef: recommendedModelId
        ? `${providerId}:${recommendedModelId}`
        : null,
      connectable:
        providerIsConnectable(providerId) &&
        baseUrls.some((url) => !isTemplatedBaseUrl(url)),
    });

    for (const model of provModels) {
      const ref = `${providerId}:${model.id}`;
      const thinkingLevels = model.reasoning
        ? (getSupportedThinkingLevels(model).filter((level) =>
            AGENT_THINKING_LEVELS.has(level),
          ) as AgentThinkingLevel[])
        : [];
      const connectable = modelIsConnectable(providerId, model.baseUrl);
      models.push({
        ref,
        id: model.id,
        name: model.name,
        provider: providerId,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        vision: model.input.includes("image"),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        thinkingLevels,
        templatedBaseUrl: isTemplatedBaseUrl(model.baseUrl),
        connectable,
        recommended: recommendedRefs.has(ref),
        auth: "url-bound",
        availability: {
          state: "needs-setup",
          detail: connectable ? "no-credential" : "not-installed",
        },
        modelSpec: piModelToSpec(model as unknown as PiModelLike),
        capabilities: { tools: true },
      });
    }
  }

  return { providers, models };
}

export function localEntryToCatalogEntry(
  entry: LocalModelEntry,
): ModelCatalogEntry {
  return {
    ref: `${LOCAL_PROVIDER_ID}:${entry.slug}`,
    id: entry.slug,
    name: entry.displayName,
    provider: LOCAL_PROVIDER_ID,
    baseUrl: entry.baseUrl,
    reasoning: entry.reasoningCapable,
    vision: false,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    tokensPerSec: entry.measuredTokensPerSec ?? null,
    thinkingLevels: [],
    templatedBaseUrl: false,
    // Local models are never "connectable" — no credential flow exists for
    // them; availability comes from live server state (design §6.3/§7.1).
    connectable: false,
    recommended: `${LOCAL_PROVIDER_ID}:${entry.slug}` === LOCAL_DEFAULT_MODEL_REF,
    auth: "loopback",
    availability: localAvailability(entry),
    modelSpec: {
      id: entry.slug,
      name: entry.displayName,
      api: "openai-completions",
      provider: LOCAL_PROVIDER_ID,
      baseUrl: entry.baseUrl,
      reasoning: entry.reasoningCapable,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      compat: { ...LLAMA_SERVER_COMPAT },
    },
    capabilities: { tools: entry.toolsCapable },
  };
}

function localAvailability(entry: LocalModelEntry): ModelAvailability {
  switch (entry.state) {
    case "ready":
      return { state: "ready", detail: "running" };
    case "startable":
      return { state: "startable", detail: "will-load-on-use" };
    case "not-installed":
      return { state: "needs-setup", detail: "not-installed" };
    case "starting":
      return { state: "starting" };
    case "downloading":
      return {
        state: "downloading",
        progress: entry.download?.progress ?? 0,
        phase: entry.download?.phase ?? "queued",
        receivedBytes: entry.download?.receivedBytes ?? 0,
        totalBytes: entry.download?.totalBytes ?? null,
      };
    case "error":
      return {
        state: "error",
        message: entry.errorMessage ?? "local server error",
      };
  }
}

export function applyCloudAvailability(
  entry: ModelCatalogEntry,
  credentials: readonly StoredCredentialSummary[],
  executionMode: "provider-credentials" | "deterministic-test",
): ModelCatalogEntry {
  if (entry.auth !== "url-bound") return entry;
  if (executionMode === "deterministic-test") {
    return {
      ...entry,
      availability: { state: "ready", detail: "deterministic-test" },
    };
  }
  // The credential owner projects expiry and refresh capability into each
  // secret-free summary. A stored credential is not enough: it must be active
  // or carry persisted material that can renew it.
  const matching = credentials.filter((credential) => {
    try {
      return (
        findMatchingUrlAudience(entry.baseUrl, credential.audience) !== null
      );
    } catch {
      return false;
    }
  });
  const matchedUsable = matching.some(isStoredCredentialUsable);
  const matchedExpired = matching.some(
    (credential) =>
      credential.lifecycle.state === "expired" &&
      !credential.lifecycle.canRefresh,
  );
  const availability: ModelAvailability = matchedUsable
    ? { state: "ready", detail: "credentialed" }
    : {
        state: "needs-setup",
        detail: matchedExpired
          ? "credential-expired"
          : entry.connectable
            ? "no-credential"
            : "not-installed",
      };
  return { ...entry, availability };
}

export function pickFallbackModel(catalog: ModelCatalog): {
  ref: string;
  reason?: "missing" | "unavailable";
} {
  const byRef = (ref: string) =>
    catalog.models.find((model) => model.ref === ref);
  const preferred = byRef(DEFAULT_AGENT_MODEL_REF);
  const preferredRef = preferred?.ref;
  if (preferred && isModelUsable(preferred)) return { ref: preferred.ref };
  const recommended = catalog.models.find(
    (model) => model.recommended && isModelUsable(model),
  );
  if (recommended) return { ref: recommended.ref };
  // Prefer the local floor once the user has explicitly installed it.
  const localFloor = byRef(LOCAL_FALLBACK_MODEL_REF);
  if (localFloor && isModelUsable(localFloor)) return { ref: localFloor.ref };
  const anyUsable = catalog.models.find(isModelUsable);
  if (anyUsable) return { ref: anyUsable.ref };
  // Nothing usable at all — keep the old static preference so the connect
  // flow has a sensible target.
  return { ref: preferredRef ?? catalog.models[0]?.ref ?? "" };
}

export class ModelSettingsDO extends DurableObjectBase {
  protected createTables(): void {}

  @rpc({
    principals: ["host", "user", "code", "session", "mission"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async listCatalog(): Promise<ModelCatalog> {
    return this.assembleCatalog();
  }

  @rpc({
    principals: ["host", "user", "code", "session", "mission"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async getSettings(): Promise<ModelSettingsSnapshot> {
    const [catalog, config] = await Promise.all([
      this.assembleCatalog(),
      this.getWorkspaceConfig(),
    ]);
    return this.resolveSettings(catalog, config);
  }

  @rpc({
    principals: ["host", "user", "code", "session", "mission"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async getDefaultModel(): Promise<ModelSettingsSnapshot> {
    return this.getSettings();
  }

  @rpc({
    principals: ["host", "user", "code", "session", "mission"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async inspectModels(refs: string[]): Promise<{
    defaultModel: string;
    models: Array<{ ref: string; availability: ModelAvailability }>;
  }> {
    const uniqueRefs = [...new Set(refs)];
    const settings = await this.getSettings();
    return {
      defaultModel: settings.defaultModel,
      models: uniqueRefs.map((ref) => {
        const model = settings.catalog.models.find(
          (entry) => entry.ref === ref,
        );
        return {
          ref,
          availability: model?.availability ?? {
            state: "error",
            message: "Unknown model ref",
          },
        };
      }),
    };
  }

  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async setDefaultAgentConfig(
    input: DefaultAgentConfig,
  ): Promise<ModelSettingsSnapshot> {
    const requested = parseDefaultAgentConfig(input, true);
    const catalog = await this.assembleCatalog();
    const model = catalog.models.find((entry) => entry.ref === requested.model);
    if (!model) {
      throw new Error(`Unknown model ref: ${requested.model}`);
    }
    const config: DefaultAgentConfig = {
      model: model.ref,
      ...(requested.thinkingLevel
        ? { thinkingLevel: requested.thinkingLevel }
        : {}),
      ...(requested.fastMode !== undefined
        ? { fastMode: requested.fastMode }
        : { fastMode: defaultFastModeForModel(model) }),
      ...(requested.approvalLevel !== undefined
        ? { approvalLevel: requested.approvalLevel }
        : {}),
    };
    await this.setWorkspaceConfigField(
      WORKSPACE_DEFAULT_AGENT_CONFIG_FIELD,
      config,
    );
    return {
      catalog,
      defaultModel: model.ref,
      defaultModelSource: "workspace",
      defaultAgentConfig: config,
    };
  }

  /** Static pi projection — overridable seam for tests. */
  protected getCatalog(): Promise<ModelCatalog> {
    return getModelCatalog();
  }

  /** Static pi catalog + live availability overlay + live local entries. */
  protected async assembleCatalog(): Promise<ModelCatalog> {
    const [base, credentials, localEntries] = await Promise.all([
      this.getCatalog(),
      this.storedCredentials(),
      this.fetchLocalModels(),
    ]);
    const executionMode =
      this.env["VIBESTUDIO_TEST_MODE"] === "1"
        ? ("deterministic-test" as const)
        : ("provider-credentials" as const);
    const models = [
      ...base.models.map((entry) =>
        applyCloudAvailability(entry, credentials, executionMode),
      ),
      ...localEntries.map(localEntryToCatalogEntry),
    ];
    const recommendedLocalModelRef = localEntries.some(
      (entry) => `${LOCAL_PROVIDER_ID}:${entry.slug}` === LOCAL_DEFAULT_MODEL_REF
    )
      ? LOCAL_DEFAULT_MODEL_REF
      : localEntries.some(
            (entry) => `${LOCAL_PROVIDER_ID}:${entry.slug}` === LOCAL_FALLBACK_MODEL_REF
          )
        ? LOCAL_FALLBACK_MODEL_REF
        : null;
    const providers: ModelCatalogProvider[] = localEntries.length
      ? [
          ...base.providers,
          {
            id: LOCAL_PROVIDER_ID,
            label: "Local inference (experimental)",
            baseUrls: Array.from(new Set(localEntries.map((entry) => entry.baseUrl))),
            recommendedModelRef: recommendedLocalModelRef,
            connectable: false,
          },
        ]
      : [...base.providers];
    return { providers, models };
  }

  /** Secret-free stored-credential lifecycle summaries (design §7.1).
   *  Failure degrades to "nothing credentialed", never an error snapshot. */
  protected async storedCredentials(): Promise<StoredCredentialSummary[]> {
    try {
      const credentials = await this.rpc.call<StoredCredentialSummary[]>(
        "main",
        "credentials.listStoredCredentials",
        [],
      );
      return Array.isArray(credentials) ? credentials : [];
    } catch (err) {
      console.warn("[model-settings] credential status lookup failed:", err);
      return [];
    }
  }

  /** Live local-models extension entries. Absent extension ⇒ no local models. */
  protected async fetchLocalModels(): Promise<LocalModelEntry[]> {
    try {
      const entries = await this.rpc.call<LocalModelEntry[]>(
        "main",
        "extensions.invoke",
        [LOCAL_MODELS_EXTENSION_ID, "listModels", []],
      );
      return Array.isArray(entries) ? entries : [];
    } catch {
      return [];
    }
  }

  protected getWorkspaceConfig(): Promise<WorkspaceConfig> {
    return this.rpc.call<WorkspaceConfig>("main", "workspace.getConfig", []);
  }

  protected setWorkspaceConfigField(
    key: string,
    value: unknown,
  ): Promise<void> {
    return this.rpc.call<void>("main", "workspace.setConfigField", [
      key,
      value,
    ]);
  }

  private resolveSettings(
    catalog: ModelCatalog,
    config: WorkspaceConfig,
  ): ModelSettingsSnapshot {
    const stored = parseDefaultAgentConfig(config.defaultAgentConfig);
    const behaviorFor = (entry: ModelCatalogEntry | undefined) => ({
      ...(stored.thinkingLevel ? { thinkingLevel: stored.thinkingLevel } : {}),
      ...(stored.fastMode !== undefined
        ? { fastMode: stored.fastMode }
        : defaultFastModeForModel(entry)
          ? { fastMode: true }
          : {}),
      ...(stored.approvalLevel !== undefined
        ? { approvalLevel: stored.approvalLevel }
        : {}),
    });
    const storedEntry = stored.model
      ? catalog.models.find((model) => model.ref === stored.model)
      : undefined;
    // A configured model is an explicit workspace preference, not an
    // availability heuristic. Keep it selected while it needs setup so the
    // first-agent preflight can guide the user through connecting that provider.
    // Availability only chooses a fallback when no valid preference exists.
    if (storedEntry) {
      return {
        catalog,
        defaultModel: storedEntry.ref,
        defaultModelSource: "workspace",
        defaultAgentConfig: { model: storedEntry.ref, ...behaviorFor(storedEntry) },
      };
    }
    const fallback = pickFallbackModel(catalog);
    const fallbackEntry = catalog.models.find((model) => model.ref === fallback.ref);
    return {
      catalog,
      defaultModel: fallback.ref,
      defaultModelSource: "fallback",
      ...(stored.model
        ? {
            defaultModelFallbackReason: "missing",
            invalidDefaultModel: stored.model,
          }
        : {}),
      defaultAgentConfig: { model: fallback.ref, ...behaviorFor(fallbackEntry) },
    };
  }
}

/** Parse the one current default-agent configuration shape. */
function parseDefaultAgentConfig(
  value: unknown,
  required = false,
): {
  model: string | null;
  thinkingLevel?: AgentThinkingLevel;
  fastMode?: boolean;
  approvalLevel?: 0 | 1 | 2;
} {
  if (value === undefined || value === null) {
    if (required) throw new Error("defaultAgentConfig is required");
    return { model: null };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("defaultAgentConfig must be an object");
  }
  const v = value as Record<string, unknown>;
  const unknownKeys = Object.keys(v).filter(
    (key) =>
      key !== "model" &&
      key !== "thinkingLevel" &&
      key !== "fastMode" &&
      key !== "approvalLevel",
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `defaultAgentConfig has unknown field(s): ${unknownKeys.join(", ")}`,
    );
  }
  const rawModel = v["model"];
  if (typeof rawModel !== "string" || rawModel.trim().length === 0) {
    throw new Error("defaultAgentConfig.model must be a non-empty string");
  }
  const model = rawModel.trim();
  const rawThinking = v["thinkingLevel"];
  if (
    rawThinking !== undefined &&
    !AGENT_THINKING_LEVELS.has(rawThinking as string)
  ) {
    throw new Error(
      `Invalid defaultAgentConfig.thinkingLevel: ${String(rawThinking)}`,
    );
  }
  const thinkingLevel = rawThinking as AgentThinkingLevel | undefined;
  const rawFastMode = v["fastMode"];
  if (rawFastMode !== undefined && typeof rawFastMode !== "boolean") {
    throw new Error(
      `Invalid defaultAgentConfig.fastMode: ${String(rawFastMode)}`,
    );
  }
  const rawApproval = v["approvalLevel"];
  if (
    rawApproval !== undefined &&
    rawApproval !== 0 &&
    rawApproval !== 1 &&
    rawApproval !== 2
  ) {
    throw new Error(
      `Invalid defaultAgentConfig.approvalLevel: ${String(rawApproval)}`,
    );
  }
  const approvalLevel = rawApproval as 0 | 1 | 2 | undefined;
  return {
    model,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(rawFastMode !== undefined ? { fastMode: rawFastMode } : {}),
    ...(approvalLevel !== undefined ? { approvalLevel } : {}),
  };
}

export default {
  async fetch() {
    return new Response(
      "Model Settings service.\nMethods: listCatalog, getSettings, getDefaultModel, inspectModels, setDefaultAgentConfig.\n",
      { headers: { "Content-Type": "text/plain" } },
    );
  },
};
