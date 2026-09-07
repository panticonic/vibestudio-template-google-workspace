import type { AgentSubscriptionConfig, AvailableAgent, ModelCatalog } from "@workspace/agentic-core";
import {
  defaultFastModeForModel,
  type DefaultAgentConfig,
} from "@workspace/model-catalog/catalog";
import type { AgentConfigDraft } from "./AgentConfigForm";

/**
 * Shared agent-config-draft helpers used by both the modal `AgentDialog` and the
 * inline first-agent setup (`AgentSetupInline`). Kept framework-free (no hooks)
 * so they're trivially unit-testable and reusable across surfaces.
 */

/**
 * Resolve a sensible default model ref (design §7.2): prefer the explicit
 * workspace default, then availability order — recommended+ready, any ready,
 * recommended+startable, any startable — then any recommended model, then the
 * first model in the catalog. Availability is the worker-computed truth on
 * every entry; no panel-side credential heuristics.
 */
export function pickDefaultModel(
  catalog: ModelCatalog | null,
  defaultModelRef?: string | null
): string {
  const models = catalog?.models ?? [];
  const state = (m: (typeof models)[number]) => m.availability?.state ?? "needs-setup";
  return (
    (defaultModelRef && models.some((m) => m.ref === defaultModelRef) ? defaultModelRef : null) ??
    models.find((m) => m.recommended && state(m) === "ready")?.ref ??
    models.find((m) => state(m) === "ready")?.ref ??
    models.find((m) => m.recommended && state(m) === "startable")?.ref ??
    models.find((m) => state(m) === "startable")?.ref ??
    models.find((m) => m.recommended)?.ref ??
    models[0]?.ref ??
    ""
  );
}

/** Project a UI draft into the wire-level subscription config (drops empties). */
export function draftToConfig(draft: AgentConfigDraft): AgentSubscriptionConfig {
  const config: AgentSubscriptionConfig = {};
  if (draft.model) config.model = draft.model;
  if (draft.thinkingLevel) config.thinkingLevel = draft.thinkingLevel;
  if (draft.fastMode !== undefined) config.fastMode = draft.fastMode;
  if (draft.approvalLevel !== undefined) config.approvalLevel = draft.approvalLevel;
  if (draft.respondPolicy) config.respondPolicy = draft.respondPolicy;
  if (draft.respondFrom && draft.respondFrom.length > 0) config.respondFrom = draft.respondFrom;
  if (draft.handle) config["handle"] = draft.handle;
  if (draft.systemPrompt) config.systemPrompt = draft.systemPrompt;
  return config;
}

/**
 * Seed a fresh draft for an agent type. Effective host defaults (workspace
 * defaults with any panel override already applied) layer over generic worker
 * manifest defaults; the catalog is only a final model fallback.
 * `showReactiveness` decides whether a default respondPolicy is seeded (only
 * meaningful in multi-agent channels).
 */
export function draftForAgent(
  agent: AvailableAgent | undefined,
  opts: {
    modelCatalog: ModelCatalog | null;
    defaultModelRef?: string | null;
    /** Effective host defaults — saved workspace defaults plus any panel-level
     *  override. These layer over generic agent manifest defaults so a fresh
     *  draft matches what the host will launch. */
    defaultAgentConfig?: DefaultAgentConfig | null;
    showReactiveness?: boolean;
  }
): AgentConfigDraft {
  const defaults = agent?.defaultConfig ?? {};
  const ws = opts.defaultAgentConfig;
  const workerModel =
    typeof defaults.model === "string" && defaults.model ? defaults.model : undefined;
  const model =
    ws?.model || workerModel || pickDefaultModel(opts.modelCatalog, opts.defaultModelRef);
  const modelEntry = opts.modelCatalog?.models.find((entry) => entry.ref === model);
  const defaultHandle =
    typeof defaults["handle"] === "string" ? defaults["handle"] : agent?.proposedHandle;
  return {
    model,
    thinkingLevel: ws?.thinkingLevel ?? defaults.thinkingLevel ?? "medium",
    fastMode:
      ws?.fastMode ?? defaults.fastMode ?? defaultFastModeForModel(modelEntry),
    approvalLevel: ws?.approvalLevel ?? defaults.approvalLevel,
    respondPolicy: defaults.respondPolicy ?? (opts.showReactiveness ? "mentioned" : undefined),
    respondFrom: defaults.respondFrom,
    handle: defaultHandle,
    systemPrompt: defaults.systemPrompt,
  };
}
