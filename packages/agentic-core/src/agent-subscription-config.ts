export type AgentThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AgentApprovalLevel = 0 | 1 | 2;
export type AgentFallbackScope = "unattended" | "all-turns";
export type AgentRespondPolicy =
  | "all"
  | "mentioned"
  | "mentioned-strict"
  | "mentioned-or-followup"
  | "from-participants";
export type AgentSystemPromptMode = "append" | "replace" | "replace-vibestudio";
/**
 * When the agent WAKES to run a turn on a channel. "every-envelope" (default,
 * current behavior) = every inbound envelope wakes it. "explicit" = retain the
 * channel stream without turning ordinary output into prompts, and wake only for
 * an explicit `saliency:"say"` message or direct address. "manual" = never
 * auto-wake; the agent pulls channel envelopes on its own (e.g. via
 * `read_subagent`). RESOLVED in the vessel (addressing) — declared here as the
 * pinned literal union only.
 */
export type AgentWakePolicy = "every-envelope" | "explicit" | "manual";

export interface AgentObservationConfig {
  /** Exact non-agentic channel payload kinds that may wake this subscription. */
  payloadKinds: string[];
}

/**
 * A stable resource attached to one channel relationship. Workers interpret
 * only resource kinds they own; launchers may compose bindings without the
 * runtime host learning worker-specific state shapes.
 */
export interface AgentResourceBinding {
  kind: string;
  id: string;
}

/** One model tool selected from the worker's checked-in tool registry. */
export interface AgentToolBinding {
  kind: string;
  /** Optional key in `resources`; required by tools that act on a resource. */
  resource?: string;
}

/**
 * Composable channel behavior. This deliberately contains registry keys and
 * resource references, never RPC method names or executable callbacks.
 */
export interface AgentChannelFeatures {
  resources?: Record<string, AgentResourceBinding>;
  tools?: AgentToolBinding[];
}

/**
 * The per-agent BEHAVIOR settings. These are PER-AGENT: seeded into the agent's
 * creation `stateArgs.agentConfig` and persisted in its settings record. They must
 * NEVER ride a channel subscription — a channel subscription is membership +
 * presentation, not behavior (an agent carries the same behavior across channels).
 */
export interface AgentConfig {
  /** Model in "provider:modelId" form. */
  model?: string;
  /** Effort level for the model. */
  thinkingLevel?: AgentThinkingLevel;
  /** Request the provider's accelerated service tier when the model supports it. */
  fastMode?: boolean;
  /** Optional model used for one journaled failover attempt. */
  fallbackModel?: string;
  /** Effort used only by the fallback request. */
  fallbackThinkingLevel?: AgentThinkingLevel;
  /** Model failure codes that may activate the fallback. */
  fallbackOn?: string[];
  /** Whether failover is limited to background turns or also covers user turns. */
  fallbackScope?: AgentFallbackScope;
  /** 0=manual, 1=auto-safe, 2=full-auto. */
  approvalLevel?: AgentApprovalLevel;
  /** Chattiness: who the agent responds to. */
  respondPolicy?: AgentRespondPolicy;
  respondFrom?: string[];
}

/**
 * The behavior-setting keys — the single source of truth for stripping settings
 * off a subscription (`toSubscriptionConfig`) and for the `never` guard below.
 */
export const AGENT_SETTING_KEYS = [
  "model",
  "thinkingLevel",
  "fastMode",
  "fallbackModel",
  "fallbackThinkingLevel",
  "fallbackOn",
  "fallbackScope",
  "approvalLevel",
  "respondPolicy",
  "respondFrom",
] as const satisfies ReadonlyArray<keyof AgentConfig>;
export type AgentSettingKey = (typeof AGENT_SETTING_KEYS)[number];

/**
 * The full per-agent SETUP config: behavior settings + channel presentation +
 * worker-specific extras. Produced by the panel UI, a worker manifest's
 * `defaultConfig`, or headless `extraConfig`. It is the source for BOTH the
 * per-agent seed (the settings) AND the channel subscription (presentation +
 * extras, settings stripped via `toSubscriptionConfig`).
 */
export interface AgentSubscriptionConfig extends AgentConfig {
  /** Override or append to the workspace system prompt (channel presentation). */
  systemPrompt?: string;
  systemPromptMode?: AgentSystemPromptMode;
  /** Participant handle + display name (channel presentation). */
  handle?: string;
  name?: string;
  /** Per-channel wake discipline (channel presentation, NOT a behavior setting —
   *  intentionally excluded from AGENT_SETTING_KEYS so it rides the subscription).
   *  Resolved in the vessel. Absent ⇒ "every-envelope". */
  wakePolicy?: AgentWakePolicy;
  /** Structured non-chat channel payloads exposed to the model on this channel. */
  observations?: AgentObservationConfig;
  /** Channel-scoped tools and resource bindings selected from the worker registry. */
  features?: AgentChannelFeatures;
  /** Worker-specific extras (e.g. the test-agent's deterministic-mode keys). */
  [key: string]: unknown;
}

/**
 * The CHANNEL SUBSCRIPTION config: presentation + worker extras, with the
 * per-agent behavior settings FORBIDDEN at the type level (`?: never`). Typing the
 * subscription store/read paths as this makes the compiler reject any attempt to
 * put — or read — a behavior setting on a subscription. Build one ONLY via
 * `toSubscriptionConfig` (the single sanctioned producer).
 */
export type ChannelSubscriptionConfig = AgentSubscriptionConfig & {
  [K in AgentSettingKey]?: never;
};

/**
 * Derive a channel subscription from a setup config: strip the per-agent behavior
 * settings, PRESERVING channel presentation (handle/name/systemPrompt) AND
 * worker-specific extras (e.g. the test-agent's `deterministicResponse`/`code`).
 * The only sanctioned way to produce a `ChannelSubscriptionConfig`.
 */
export function toSubscriptionConfig(
  config: AgentSubscriptionConfig | Record<string, unknown> | undefined
): ChannelSubscriptionConfig {
  const settings = new Set<string>(AGENT_SETTING_KEYS);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!settings.has(key)) out[key] = value;
  }
  return out as ChannelSubscriptionConfig;
}

const MAX_AGENT_OBSERVATION_PAYLOAD_KINDS = 32;
const RESERVED_AGENT_OBSERVATION_PAYLOAD_KINDS = new Set([
  "agentic.trajectory.v1/event",
  "presence",
]);

/**
 * Resolve the optional observation block at the runtime boundary. Invalid input
 * fails closed so a malformed subscription never broadens what reaches a model.
 */
export function resolveAgentObservationConfig(
  value: unknown
): { payloadKinds: ReadonlySet<string> } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payloadKinds = (value as Record<string, unknown>)["payloadKinds"];
  if (
    !Array.isArray(payloadKinds) ||
    payloadKinds.length === 0 ||
    payloadKinds.length > MAX_AGENT_OBSERVATION_PAYLOAD_KINDS
  ) {
    return null;
  }

  const normalized = new Set<string>();
  for (const kind of payloadKinds) {
    if (
      typeof kind !== "string" ||
      kind.length === 0 ||
      RESERVED_AGENT_OBSERVATION_PAYLOAD_KINDS.has(kind)
    ) {
      return null;
    }
    normalized.add(kind);
  }
  return { payloadKinds: normalized };
}
