import { parse } from "yaml";
import {
  assertTemplateRegistryEpoch,
  parseTemplateRegistry,
  resolveTemplateRegistrySelection,
  type TemplateCatalogSnapshot,
  type TemplateRegistry,
  type TemplateRegistryCoordinates,
  type TemplateRegistrySource,
  type TemplateRegistrySelection,
  type ResolvedTemplateRegistrySelection,
} from "./contract.js";

export interface AcquiredRegistrySnapshot {
  commit: string;
  snapshot: string;
  readFile(path: string): Uint8Array | null;
}

export interface TemplateRegistryAcquirer {
  discover(source: TemplateRegistrySource): Promise<AcquiredRegistrySnapshot>;
}

export interface TemplateRegistryCacheRecord {
  version: 1;
  coordinates: TemplateRegistryCoordinates;
  registry: TemplateRegistry;
  verifiedAt: string;
}

export interface TemplateRegistryCache {
  read(): Promise<TemplateRegistryCacheRecord | null>;
  write(record: TemplateRegistryCacheRecord): Promise<void>;
}

export class MemoryTemplateRegistryCache implements TemplateRegistryCache {
  private value: TemplateRegistryCacheRecord | null = null;

  async read(): Promise<TemplateRegistryCacheRecord | null> {
    return this.value;
  }

  async write(record: TemplateRegistryCacheRecord): Promise<void> {
    this.value = record;
  }
}

export class TemplateRegistryUnavailableError extends Error {
  constructor(message = "No verified template registry is cached; refresh the registry first") {
    super(message);
    this.name = "TemplateRegistryUnavailableError";
  }
}

export interface TemplateRegistryClientOptions {
  source: TemplateRegistrySource;
  systemEpoch: number;
  acquirer: TemplateRegistryAcquirer;
  cache: TemplateRegistryCache;
  registryPath?: string;
  now?: () => Date;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TemplateRegistryClient {
  private readonly registryPath: string;

  constructor(private readonly options: TemplateRegistryClientOptions) {
    this.registryPath = options.registryPath ?? "registry.yml";
  }

  private async cachedRecord(): Promise<TemplateRegistryCacheRecord | null> {
    const raw = await this.options.cache.read();
    if (!raw) return null;
    const registry = parseTemplateRegistry(raw.registry);
    assertTemplateRegistryEpoch(registry, this.options.systemEpoch);
    if (
      raw.coordinates.url !== this.options.source.url ||
      raw.coordinates.ref !== this.options.source.ref
    ) {
      return null;
    }
    return { ...raw, registry };
  }

  /** Cache-only by design. Catalog rendering never performs implicit network work. */
  async catalog(): Promise<TemplateCatalogSnapshot> {
    const cached = await this.cachedRecord();
    if (!cached) throw new TemplateRegistryUnavailableError();
    return {
      ...cached.registry,
      coordinates: cached.coordinates,
      source: "cache",
      stale: true,
      verifiedAt: cached.verifiedAt,
    };
  }

  /**
   * The only network path. A failed refresh retains and returns the last
   * verified registry with a stale marker; no unverified bytes enter the cache.
   */
  async refresh(): Promise<TemplateCatalogSnapshot> {
    try {
      const snapshot = await this.options.acquirer.discover(this.options.source);
      const bytes = snapshot.readFile(this.registryPath);
      if (!bytes) {
        throw new Error(`Verified registry snapshot does not contain ${this.registryPath}`);
      }
      const registry = parseTemplateRegistry(parse(new TextDecoder().decode(bytes)));
      assertTemplateRegistryEpoch(registry, this.options.systemEpoch);
      const verifiedAt = (this.options.now?.() ?? new Date()).toISOString();
      await this.options.cache.write({
        version: 1,
        coordinates: {
          url: this.options.source.url,
          ref: this.options.source.ref,
          commit: snapshot.commit,
          snapshot: snapshot.snapshot,
        },
        registry,
        verifiedAt,
      });
      return {
        ...registry,
        coordinates: {
          url: this.options.source.url,
          ref: this.options.source.ref,
          commit: snapshot.commit,
          snapshot: snapshot.snapshot,
        },
        source: "verified",
        stale: false,
        verifiedAt,
      };
    } catch (error) {
      const cached = await this.cachedRecord();
      if (!cached) throw error;
      return {
        ...cached.registry,
        coordinates: cached.coordinates,
        source: "cache",
        stale: true,
        verifiedAt: cached.verifiedAt,
        refreshError: errorMessage(error),
      };
    }
  }

  async resolve(selection: TemplateRegistrySelection): Promise<ResolvedTemplateRegistrySelection> {
    const cached = await this.cachedRecord();
    if (!cached) throw new TemplateRegistryUnavailableError();
    return resolveTemplateRegistrySelection(
      cached.registry,
      selection,
      cached.coordinates,
      this.options.systemEpoch
    );
  }
}
