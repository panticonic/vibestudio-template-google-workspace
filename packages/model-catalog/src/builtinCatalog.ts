import catalogData from "./builtinCatalog.generated.json";
import type { PiModelInput } from "./catalog";

type BuiltinCatalogData = {
  generatedFrom: string;
  providers: Record<string, PiModelInput[]>;
};

const catalog = catalogData as BuiltinCatalogData;

/** Package/version that produced the committed catalog snapshot. */
export const BUILTIN_MODEL_CATALOG_SOURCE = catalog.generatedFrom;

/** Secret-free provider ids in the committed model metadata snapshot. */
export function getBuiltinProviders(): string[] {
  return Object.keys(catalog.providers);
}

/** Secret-free model specifications for one built-in provider. */
export function getBuiltinModels(provider: string): PiModelInput[] {
  return catalog.providers[provider] ?? [];
}

const EXTENDED_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Thinking levels admitted by the model's registry metadata. */
export function getSupportedThinkingLevels(model: PiModelInput): string[] {
  if (!model.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    return (level !== "xhigh" && level !== "max") || mapped !== undefined;
  }).filter((level) => model.thinkingLevelMap?.[level] !== null);
}
