import {
  clampThinkingLevel,
  type Api,
  type GoogleApiThinkingLevel,
  type Model,
  type ProviderStreamOptions,
  type ThinkingBudgets,
} from "@workspace/pi-ai";
import type { ThinkingLevel as AgentThinkingLevel } from "@workspace/agent-loop";

export type RawThinkingModel = Omit<
  Pick<
    Model<Api>,
    | "api"
    | "compat"
    | "id"
    | "maxTokens"
    | "name"
    | "reasoning"
    | "thinkingLevelMap"
  >,
  "thinkingLevelMap"
> & {
  thinkingLevelMap?: Partial<Record<AgentThinkingLevel, string | null>>;
};

type EnabledThinkingLevel = Exclude<
  ReturnType<typeof clampThinkingLevel>,
  "off"
>;

const DEFAULT_THINKING_BUDGETS: Required<ThinkingBudgets> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
};

/**
 * Vibestudio drives pi-ai's raw `stream()` API so Codex/OpenAI Responses can
 * request live reasoning summaries. Raw providers do not read the
 * provider-agnostic `reasoning` option uniformly, so this adapter mirrors
 * pi-ai's streamSimple mapping at our raw-stream boundary.
 */
export function buildRawThinkingOptions(
  model: RawThinkingModel,
  requestedLevel: AgentThinkingLevel,
): ProviderStreamOptions {
  if (!model.reasoning) return {};

  const clamped = clampThinkingLevel(model as Model<Api>, requestedLevel);
  if (clamped === "off") return {};
  const level: EnabledThinkingLevel = clamped;

  switch (model.api) {
    case "anthropic-messages":
      return buildAnthropicThinkingOptions(model, level);
    case "bedrock-converse-stream":
      return buildBedrockThinkingOptions(model, level);
    case "google-generative-ai":
    case "google-vertex":
      return { thinking: buildGoogleThinkingOption(model, level) };
    case "mistral-conversations":
      return buildMistralThinkingOptions(model, level);
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return {
        reasoningEffort: level,
        reasoningSummary: "auto",
      };
    case "openai-completions":
      return { reasoningEffort: level };
    default:
      return { reasoningEffort: level };
  }
}

function buildAnthropicThinkingOptions(
  model: RawThinkingModel,
  level: EnabledThinkingLevel,
): ProviderStreamOptions {
  if (hasForcedAdaptiveThinking(model)) {
    return {
      thinkingEnabled: true,
      effort: mapAnthropicThinkingLevelToEffort(model, level),
    };
  }

  const adjusted = adjustMaxTokensForThinking(
    undefined,
    model.maxTokens,
    level,
  );
  return {
    maxTokens: adjusted.maxTokens,
    thinkingEnabled: true,
    thinkingBudgetTokens: adjusted.thinkingBudget,
  };
}

function buildBedrockThinkingOptions(
  model: RawThinkingModel,
  level: EnabledThinkingLevel,
): ProviderStreamOptions {
  if (!isAnthropicClaudeModel(model) || supportsAdaptiveThinking(model)) {
    return { reasoning: level };
  }

  const adjusted = adjustMaxTokensForThinking(
    undefined,
    model.maxTokens,
    level,
  );
  const budgetLevel = level === "xhigh" || level === "max" ? "high" : level;
  return {
    maxTokens: adjusted.maxTokens,
    reasoning: level,
    thinkingBudgets: {
      [budgetLevel]: adjusted.thinkingBudget,
    },
  };
}

function buildGoogleThinkingOption(
  model: RawThinkingModel,
  level: EnabledThinkingLevel,
): { enabled: true; budgetTokens?: number; level?: GoogleApiThinkingLevel } {
  const googleLevel = level === "xhigh" || level === "max" ? "high" : level;
  if (
    isGemini3ProModel(model) ||
    isGemini3FlashModel(model) ||
    (model.api === "google-generative-ai" && isGemma4Model(model))
  ) {
    return {
      enabled: true,
      level: getGoogleThinkingLevel(model, googleLevel),
    };
  }

  return {
    enabled: true,
    budgetTokens: getGoogleBudget(model, googleLevel),
  };
}

function buildMistralThinkingOptions(
  model: RawThinkingModel,
  level: EnabledThinkingLevel,
): ProviderStreamOptions {
  if (usesMistralReasoningEffort(model)) {
    return { reasoningEffort: model.thinkingLevelMap?.[level] ?? "high" };
  }
  return { promptMode: "reasoning" };
}

function adjustMaxTokensForThinking(
  baseMaxTokens: number | undefined,
  modelMaxTokens: number,
  level: EnabledThinkingLevel,
): { maxTokens: number; thinkingBudget: number } {
  const budgetLevel = level === "xhigh" || level === "max" ? "high" : level;
  let thinkingBudget = DEFAULT_THINKING_BUDGETS[budgetLevel];
  const maxTokens =
    baseMaxTokens === undefined
      ? modelMaxTokens
      : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);
  const minOutputTokens = 1024;
  if (maxTokens <= thinkingBudget) {
    thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
  }
  return { maxTokens, thinkingBudget };
}

function mapAnthropicThinkingLevelToEffort(
  model: RawThinkingModel,
  level: EnabledThinkingLevel,
): string {
  const mapped = model.thinkingLevelMap?.[level];
  if (typeof mapped === "string") return mapped;
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
  }
}

function isAnthropicClaudeModel(model: RawThinkingModel): boolean {
  return getModelMatchCandidates(model).some(
    (candidate) =>
      candidate.includes("anthropic.claude") ||
      candidate.includes("anthropic/claude") ||
      candidate.includes("claude"),
  );
}

function supportsAdaptiveThinking(model: RawThinkingModel): boolean {
  return getModelMatchCandidates(model).some(
    (candidate) =>
      candidate.includes("opus-4-6") ||
      candidate.includes("opus-4-7") ||
      candidate.includes("opus-4-8") ||
      candidate.includes("sonnet-4-6") ||
      candidate.includes("sonnet-5") ||
      candidate.includes("fable-5"),
  );
}

function hasForcedAdaptiveThinking(model: RawThinkingModel): boolean {
  return (
    (model.compat as { forceAdaptiveThinking?: boolean } | undefined)
      ?.forceAdaptiveThinking === true
  );
}

function getModelMatchCandidates(model: RawThinkingModel): string[] {
  return [model.id, model.name].flatMap((value) => {
    const lower = value.toLowerCase();
    return [lower, lower.replace(/[\s_.:]+/g, "-")];
  });
}

function isGemma4Model(model: RawThinkingModel): boolean {
  return /gemma-?4/.test(model.id.toLowerCase());
}

function isGemini3ProModel(model: RawThinkingModel): boolean {
  return /gemini-3(?:\.\d+)?-pro/.test(model.id.toLowerCase());
}

function isGemini3FlashModel(model: RawThinkingModel): boolean {
  return /gemini-3(?:\.\d+)?-flash/.test(model.id.toLowerCase());
}

function getGoogleThinkingLevel(
  model: RawThinkingModel,
  level: EnabledThinkingLevel,
): GoogleApiThinkingLevel {
  if (isGemini3ProModel(model)) {
    switch (level) {
      case "minimal":
      case "low":
        return "LOW";
      case "medium":
      case "high":
      case "xhigh":
      case "max":
        return "HIGH";
    }
  }
  if (isGemma4Model(model)) {
    switch (level) {
      case "minimal":
      case "low":
        return "MINIMAL";
      case "medium":
      case "high":
      case "xhigh":
      case "max":
        return "HIGH";
    }
  }
  switch (level) {
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    case "high":
    case "xhigh":
    case "max":
      return "HIGH";
  }
}

function getGoogleBudget(
  model: RawThinkingModel,
  level: EnabledThinkingLevel,
): number {
  if (model.id.includes("2.5-pro")) {
    const budgets = {
      minimal: 128,
      low: 2048,
      medium: 8192,
      high: 32768,
      xhigh: 32768,
      max: 32768,
    };
    return budgets[level];
  }
  if (model.id.includes("2.5-flash-lite")) {
    const budgets = {
      minimal: 512,
      low: 2048,
      medium: 8192,
      high: 24576,
      xhigh: 24576,
      max: 24576,
    };
    return budgets[level];
  }
  if (model.id.includes("2.5-flash")) {
    const budgets = {
      minimal: 128,
      low: 2048,
      medium: 8192,
      high: 24576,
      xhigh: 24576,
      max: 24576,
    };
    return budgets[level];
  }
  return -1;
}

function usesMistralReasoningEffort(model: RawThinkingModel): boolean {
  return (
    model.id === "mistral-small-2603" ||
    model.id === "mistral-small-latest" ||
    model.id === "mistral-medium-3.5"
  );
}
