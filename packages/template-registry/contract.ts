const FULL_OID = /^[0-9a-f]{40}$/u;
const SNAPSHOT_DIGEST = /^v1-sha256:[0-9a-f]{64}$/u;
const STABLE_ID = /^[a-z0-9][a-z0-9-]*$/u;
const CANONICAL_REF = /^refs\/(?:heads|tags)\/[^\s~^:?*[\]\\]+$/u;
const REVISION = /^\d{4}-\d{2}-\d{2}\.\d+$/u;

export interface TemplateRegistryCoordinates {
  url: string;
  ref: string;
  commit: string;
  snapshot: string;
}

export interface TemplateRegistrySource {
  url: string;
  ref: string;
  credential?: string;
}

export interface PromotedTemplatePin {
  ref: string;
  commit: string;
  snapshot: string;
}

export interface TemplateRegistryEntry {
  id: string;
  name: string;
  description: string;
  tags: readonly string[];
  recommended: boolean;
  url: string;
  promoted: PromotedTemplatePin;
}

export interface TemplateRegistry {
  version: 1;
  revision: string;
  systemEpoch: number;
  entries: readonly TemplateRegistryEntry[];
}

export interface TemplateCatalogSnapshot extends TemplateRegistry {
  coordinates: TemplateRegistryCoordinates;
  source: "verified" | "cache";
  stale: boolean;
  verifiedAt: string;
  refreshError?: string;
}

export interface TemplateRegistrySelection {
  catalogId: string;
  registryCommit: string;
  registrySnapshot: string;
}

export interface ResolvedTemplateRegistrySelection {
  catalogId: string;
  registryCommit: string;
  registrySnapshot: string;
  name: string;
  url: string;
  promoted: PromotedTemplatePin;
}

export class TemplateRegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateRegistryValidationError";
  }
}

export class TemplateRegistrySelectionError extends Error {
  constructor() {
    super("The template catalog changed after it was shown; refresh and review it again");
    this.name = "TemplateRegistrySelectionError";
  }
}

export class TemplateRegistryEpochError extends Error {
  readonly registryEpoch: number;
  readonly systemEpoch: number;

  constructor(registryEpoch: number, systemEpoch: number) {
    super(
      `Template registry system epoch ${registryEpoch} does not match workspace system epoch ${systemEpoch}; a workspace-source upgrade is required`
    );
    this.name = "TemplateRegistryEpochError";
    this.registryEpoch = registryEpoch;
    this.systemEpoch = systemEpoch;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TemplateRegistryValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    throw new TemplateRegistryValidationError(
      `${label} contains unknown fields: ${unexpected.sort().join(", ")}`
    );
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TemplateRegistryValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function canonicalGitUrl(value: unknown, label: string): string {
  const input = nonEmptyString(value, label);
  const transport = input.startsWith("git+") ? input.slice(4) : input;
  let url: URL;
  try {
    url = new URL(transport);
  } catch {
    throw new TemplateRegistryValidationError(`${label} must be a Git HTTP(S) URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TemplateRegistryValidationError(`${label} must be a Git HTTP(S) URL`);
  }
  url.hash = "";
  url.search = "";
  return `git+${url.toString()}`;
}

function pin(value: unknown, label: string): PromotedTemplatePin {
  const source = record(value, label);
  exactKeys(source, ["ref", "commit", "snapshot"], label);
  const ref = nonEmptyString(source["ref"], `${label}.ref`);
  const commit = nonEmptyString(source["commit"], `${label}.commit`);
  const snapshot = nonEmptyString(source["snapshot"], `${label}.snapshot`);
  if (!CANONICAL_REF.test(ref)) {
    throw new TemplateRegistryValidationError(`${label}.ref must be a canonical branch or tag ref`);
  }
  if (!FULL_OID.test(commit)) {
    throw new TemplateRegistryValidationError(
      `${label}.commit must be one full lowercase Git object id`
    );
  }
  if (!SNAPSHOT_DIGEST.test(snapshot)) {
    throw new TemplateRegistryValidationError(`${label}.snapshot must be a canonical digest`);
  }
  return Object.freeze({ ref, commit, snapshot });
}

function entry(value: unknown, index: number): TemplateRegistryEntry {
  const label = `entries[${index}]`;
  const source = record(value, label);
  exactKeys(source, ["id", "name", "description", "tags", "recommended", "url", "promoted"], label);
  const id = nonEmptyString(source["id"], `${label}.id`);
  if (!STABLE_ID.test(id)) {
    throw new TemplateRegistryValidationError(`${label}.id must be a stable lowercase id`);
  }
  const tags = source["tags"];
  if (
    !Array.isArray(tags) ||
    tags.length === 0 ||
    tags.some((tag) => typeof tag !== "string" || !tag.trim())
  ) {
    throw new TemplateRegistryValidationError(`${label}.tags must contain non-empty strings`);
  }
  if (typeof source["recommended"] !== "boolean") {
    throw new TemplateRegistryValidationError(`${label}.recommended must be a boolean`);
  }
  return Object.freeze({
    id,
    name: nonEmptyString(source["name"], `${label}.name`),
    description: nonEmptyString(source["description"], `${label}.description`),
    tags: Object.freeze([...tags]),
    recommended: source["recommended"],
    url: canonicalGitUrl(source["url"], `${label}.url`),
    promoted: pin(source["promoted"], `${label}.promoted`),
  });
}

export function parseTemplateRegistry(value: unknown): TemplateRegistry {
  const source = record(value, "registry");
  exactKeys(source, ["version", "revision", "systemEpoch", "entries"], "registry");
  if (source["version"] !== 1) {
    throw new TemplateRegistryValidationError("registry.version must be 1");
  }
  const revision = nonEmptyString(source["revision"], "registry.revision");
  if (!REVISION.test(revision)) {
    throw new TemplateRegistryValidationError(
      "registry.revision must use the YYYY-MM-DD.N promotion format"
    );
  }
  if (!Number.isSafeInteger(source["systemEpoch"]) || (source["systemEpoch"] as number) < 0) {
    throw new TemplateRegistryValidationError(
      "registry.systemEpoch must be a non-negative integer"
    );
  }
  if (!Array.isArray(source["entries"])) {
    throw new TemplateRegistryValidationError("registry.entries must be an array");
  }
  const entries = source["entries"].map(entry);
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const candidate of entries) {
    if (ids.has(candidate.id)) {
      throw new TemplateRegistryValidationError(`Duplicate template registry id: ${candidate.id}`);
    }
    if (urls.has(candidate.url)) {
      throw new TemplateRegistryValidationError(
        `Duplicate template registry URL: ${candidate.url}`
      );
    }
    ids.add(candidate.id);
    urls.add(candidate.url);
  }
  return Object.freeze({
    version: 1,
    revision,
    systemEpoch: source["systemEpoch"] as number,
    entries: Object.freeze(entries),
  });
}

export function assertTemplateRegistryEpoch(
  registry: Pick<TemplateRegistry, "systemEpoch">,
  systemEpoch: number
): void {
  if (registry.systemEpoch !== systemEpoch) {
    throw new TemplateRegistryEpochError(registry.systemEpoch, systemEpoch);
  }
}

export function resolveTemplateRegistrySelection(
  registry: TemplateRegistry,
  selection: TemplateRegistrySelection,
  coordinates: TemplateRegistryCoordinates,
  systemEpoch?: number
): ResolvedTemplateRegistrySelection {
  if (
    selection.registryCommit !== coordinates.commit ||
    selection.registrySnapshot !== coordinates.snapshot
  ) {
    throw new TemplateRegistrySelectionError();
  }
  if (systemEpoch !== undefined) assertTemplateRegistryEpoch(registry, systemEpoch);
  const selected = registry.entries.find((candidate) => candidate.id === selection.catalogId);
  if (!selected) {
    throw new TemplateRegistryValidationError(
      `Unknown or retired template registry entry: ${selection.catalogId}`
    );
  }
  return {
    catalogId: selected.id,
    registryCommit: coordinates.commit,
    registrySnapshot: coordinates.snapshot,
    name: selected.name,
    url: selected.url,
    promoted: selected.promoted,
  };
}

export function parseTemplateRegistryCoordinates(value: unknown): TemplateRegistryCoordinates {
  const source = record(value, "registry coordinates");
  exactKeys(source, ["url", "ref", "commit", "snapshot"], "registry coordinates");
  const promoted = pin(
    {
      ref: source["ref"],
      commit: source["commit"],
      snapshot: source["snapshot"],
    },
    "registry coordinates"
  );
  return Object.freeze({
    url: canonicalGitUrl(source["url"], "registry coordinates.url"),
    ...promoted,
  });
}

export function parseTemplateRegistrySource(value: unknown): TemplateRegistrySource {
  const source = record(value, "registry source");
  exactKeys(source, ["url", "ref", "credential"], "registry source");
  const ref = nonEmptyString(source["ref"], "registry source.ref");
  if (!CANONICAL_REF.test(ref)) {
    throw new TemplateRegistryValidationError(
      "registry source.ref must be a canonical branch or tag ref"
    );
  }
  const credential =
    source["credential"] === undefined
      ? undefined
      : nonEmptyString(source["credential"], "registry source.credential");
  return Object.freeze({
    url: canonicalGitUrl(source["url"], "registry source.url"),
    ref,
    ...(credential ? { credential } : {}),
  });
}
