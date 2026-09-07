/**
 * Test fixtures for the model catalog. Non-production: keeps every
 * ModelCatalogEntry construction site out of test files so the entry shape
 * can evolve without fixture churn.
 */

import type { ModelCatalogEntry, PiModelSpec } from "./catalog.js";

type RequiredFixtureFields = Pick<
  ModelCatalogEntry,
  "ref" | "id" | "name" | "provider" | "baseUrl"
>;

export function makeTestCatalogEntry(
  fields: RequiredFixtureFields & Partial<ModelCatalogEntry>
): ModelCatalogEntry {
  const modelSpec: PiModelSpec = {
    id: fields.id,
    name: fields.name,
    api: "openai-completions",
    provider: fields.provider,
    baseUrl: fields.baseUrl,
    reasoning: fields.reasoning ?? false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: fields.contextWindow ?? 128000,
    maxTokens: fields.maxTokens ?? 16000,
  };
  return {
    reasoning: false,
    vision: false,
    contextWindow: 128000,
    maxTokens: 16000,
    thinkingLevels: [],
    templatedBaseUrl: false,
    connectable: true,
    recommended: false,
    auth: "url-bound",
    availability: { state: "ready", detail: "credentialed" },
    modelSpec,
    capabilities: { tools: true },
    ...fields,
  };
}
