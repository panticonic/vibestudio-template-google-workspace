import type { DefaultAgentConfig } from "@workspace/model-catalog/catalog";

/**
 * Return the host-bound panel context and reject any channel/UI claim that
 * disagrees with it. State args never select a workspace branch.
 */
export function requireChatContextId(
  runtimeContextId: string | undefined,
  claimedContextId?: string
): string {
  const runtime = runtimeContextId?.trim();
  if (!runtime) throw new Error("Chat panel runtime has no workspace context");
  const claimed = claimedContextId?.trim();
  if (claimed && claimed !== runtime) {
    throw new Error(
      `Chat channel context ${claimed} does not match panel workspace context ${runtime}`
    );
  }
  return runtime;
}

/** Per-agent record persisted into `stateArgs.installedAgents`. */
export interface InstalledAgentRecord {
  agentId: string;
  handle: string;
  key: string;
  source: string;
  className: string;
  /** Per-agent config (model/effort/approval/respondPolicy/…) used to (re)create
   *  the agent — seeded into its creation stateArgs, NOT the subscription. */
  config?: Record<string, unknown>;
}

/** Coerce a proposed handle into the channel participant-handle rule
 *  (`/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/`): replace invalid chars with `-`, drop a
 *  leading non-letter run, and cap length (leaving room for a `-xxxx` suffix).
 *  Guarantees a valid base handle regardless of the agent's manifest metadata. */
export function sanitizeHandle(raw: string, fallback = "ai-chat"): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^[^a-zA-Z]+/, "");
  return cleaned.slice(0, 50) || fallback;
}

/** Append a newly-added agent to the existing installedAgents list. Pure helper
 *  used by handleAddAgent so the persistence shape is unit-testable. */
export function appendInstalledAgent(
  existing: InstalledAgentRecord[] | undefined,
  agent: InstalledAgentRecord
): InstalledAgentRecord[] {
  return [...(existing ?? []), agent];
}

export interface BuildAgentSubscriptionConfigOptions {
  handle: string;
  workspaceDefaultAgentConfig: DefaultAgentConfig;
  globalConfig?: Record<string, unknown>;
  perAgentConfig?: Record<string, unknown>;
  systemPrompt?: string;
  systemPromptMode?: "append" | "replace-vibestudio" | "replace";
}

/**
 * Build the config used to create/subscribe an agent. Workspace defaults are the
 * base, panel-level agentConfig overrides them, explicit per-agent config wins,
 * and handle is always derived by the panel.
 */
export function buildAgentSubscriptionConfig({
  handle,
  workspaceDefaultAgentConfig,
  globalConfig,
  perAgentConfig,
  systemPrompt,
  systemPromptMode,
}: BuildAgentSubscriptionConfigOptions): {
  subscribeConfig: Record<string, unknown>;
  perAgent: Record<string, unknown>;
} {
  const perAgent: Record<string, unknown> = { ...(perAgentConfig ?? {}) };
  delete perAgent["handle"];

  const workspaceDefaults: Record<string, unknown> = {
    model: workspaceDefaultAgentConfig.model,
    ...(workspaceDefaultAgentConfig.thinkingLevel
      ? { thinkingLevel: workspaceDefaultAgentConfig.thinkingLevel }
      : {}),
    ...(workspaceDefaultAgentConfig.fastMode !== undefined
      ? { fastMode: workspaceDefaultAgentConfig.fastMode }
      : {}),
    ...(workspaceDefaultAgentConfig.approvalLevel !== undefined
      ? { approvalLevel: workspaceDefaultAgentConfig.approvalLevel }
      : {}),
  };

  const subscribeConfig: Record<string, unknown> = {
    ...workspaceDefaults,
    ...(globalConfig ?? {}),
    ...perAgent,
    handle,
  };

  for (const key of ["model", "thinkingLevel", "approvalLevel"] as const) {
    if (perAgent[key] === undefined && subscribeConfig[key] !== undefined) {
      perAgent[key] = subscribeConfig[key];
    }
  }

  if (systemPrompt && subscribeConfig["systemPrompt"] === undefined) {
    subscribeConfig["systemPrompt"] = systemPrompt;
  }
  if (systemPromptMode && subscribeConfig["systemPromptMode"] === undefined) {
    subscribeConfig["systemPromptMode"] = systemPromptMode;
  }

  return { subscribeConfig, perAgent };
}
