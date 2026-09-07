export interface RecommendableModel {
  id: string;
}

interface FlagshipRule {
  provider: string;
  prefer: RegExp[];
  exclude?: RegExp[];
}

// Flagship-newest curation. The pi catalog does not expose release-date/rank,
// so this keeps the family/tier policy in one place and uses version comparison
// to auto-promote within a family when newer aliases appear.
const FLAGSHIP_RULES: FlagshipRule[] = [
  {
    provider: "openai-codex",
    prefer: [/-sol$/i, /codex/i, /gpt-5/i],
    exclude: [/\bmini\b|\bnano\b/i],
  },
  { provider: "anthropic", prefer: [/opus/i, /sonnet/i] },
  {
    provider: "openai",
    prefer: [/gpt-5/i, /gpt-4\.1/i, /gpt-4/i],
    exclude: [/\bmini\b|\bnano\b|\bcodex\b|\bchat\b|\bpro\b/i],
  },
  { provider: "google", prefer: [/gemini.*pro/i, /gemini/i], exclude: [/\bflash\b|\blite\b/i] },
  { provider: "xai", prefer: [/grok/i], exclude: [/\bmini\b|\bfast\b|\breasoning\b/i] },
  { provider: "openrouter", prefer: [/gpt-5/i, /claude.*opus/i], exclude: [/\bmini\b|\bnano\b/i] },
];

function versionVector(id: string): number[] {
  return (id.match(/\d+/g) ?? [])
    .filter((tok) => tok.length <= 4)
    .map((tok) => Number.parseInt(tok, 10));
}

export function compareModelVersions(aId: string, bId: string): number {
  const a = versionVector(aId);
  const b = versionVector(bId);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return bId.length - aId.length;
}

function ruleForProvider(providerId: string): FlagshipRule | null {
  return FLAGSHIP_RULES.find((rule) => rule.provider === providerId) ?? null;
}

export function modelRecommendationScore(providerId: string, modelId: string): number {
  const rule = ruleForProvider(providerId);
  if (!rule) return compareModelVersions(modelId, "");
  const preferredIndex = rule.prefer.findIndex((re) => re.test(modelId));
  const preferredScore = preferredIndex >= 0 ? 1_000 - preferredIndex * 100 : 0;
  const excludedScore = (rule.exclude ?? []).some((re) => re.test(modelId)) ? -1_000 : 0;
  return preferredScore + excludedScore + compareModelVersions(modelId, "");
}

export function pickRecommendedModelId(
  providerId: string,
  models: readonly RecommendableModel[]
): string | null {
  if (models.length === 0) return null;
  return models.reduce((best, model) =>
    modelRecommendationScore(providerId, model.id) > modelRecommendationScore(providerId, best.id)
      ? model
      : best
  ).id;
}
