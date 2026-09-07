import {
  ScopePersistenceAdapter,
  type ScopeBlobBackend,
  type ScopeEntry,
  type ScopeListEntry,
  type ScopeRowBackend,
} from "@workspace/eval";

const STORAGE_PREFIX = "vibestudio:agentic-chat:scope:v1";
const ENTRY_PREFIX = `${STORAGE_PREFIX}:entry:`;

function entryKey(id: string): string {
  return `${ENTRY_PREFIX}${id}`;
}

function getStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function parseEntry(raw: string | null): ScopeEntry | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record["id"] !== "string" ||
      typeof record["channelId"] !== "string" ||
      typeof record["panelId"] !== "string" ||
      typeof record["data"] !== "string" ||
      typeof record["createdAt"] !== "number" ||
      !Array.isArray(record["serializedKeys"]) ||
      !Array.isArray(record["droppedPaths"]) ||
      !Array.isArray(record["volatileKeys"])
    ) {
      return null;
    }
    const entry: ScopeEntry = {
      id: record["id"],
      channelId: record["channelId"],
      panelId: record["panelId"],
      data: record["data"],
      serializedKeys: record["serializedKeys"].filter(
        (item): item is string => typeof item === "string"
      ),
      droppedPaths: record["droppedPaths"].filter(
        (item): item is { path: string; reason: string } =>
          !!item &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>)["path"] === "string" &&
          typeof (item as Record<string, unknown>)["reason"] === "string"
      ),
      volatileKeys: record["volatileKeys"].filter(
        (item): item is string => typeof item === "string"
      ),
      createdAt: record["createdAt"],
    };
    if (Array.isArray(record["blobRefs"])) {
      entry.blobRefs = record["blobRefs"].filter(
        (item): item is string => typeof item === "string"
      );
    }
    return entry;
  } catch {
    return null;
  }
}

/**
 * Browser-local scope row storage. Rows live in the panel's localStorage partition; large spilled
 * values go through the shared workspace blobstore via ScopePersistenceAdapter.
 */
class LocalStorageScopeRowBackend implements ScopeRowBackend {
  async upsert(entry: ScopeEntry): Promise<void> {
    const storage = getStorage();
    if (!storage) return;
    storage.setItem(entryKey(entry.id), JSON.stringify(entry));
  }

  async loadCurrent(channelId: string, panelId: string): Promise<ScopeEntry | null> {
    const entries = this.entries().filter(
      (entry) => entry.channelId === channelId && entry.panelId === panelId
    );
    entries.sort((a, b) => b.createdAt - a.createdAt);
    return entries[0] ?? null;
  }

  async get(id: string): Promise<ScopeEntry | null> {
    return parseEntry(getStorage()?.getItem(entryKey(id)) ?? null);
  }

  async list(channelId: string): Promise<ScopeListEntry[]> {
    return this.entries()
      .filter((entry) => entry.channelId === channelId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((entry) => ({
        id: entry.id,
        createdAt: entry.createdAt,
        keys: [...entry.serializedKeys],
        volatile: [...entry.volatileKeys],
      }));
  }

  private entries(): ScopeEntry[] {
    const storage = getStorage();
    if (!storage) return [];
    const entries: ScopeEntry[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key?.startsWith(ENTRY_PREFIX)) continue;
      const entry = parseEntry(storage.getItem(key));
      if (entry) entries.push(entry);
    }
    return entries;
  }
}

export class LocalStorageScopePersistence extends ScopePersistenceAdapter {
  constructor(blobs: ScopeBlobBackend) {
    super(new LocalStorageScopeRowBackend(), blobs);
  }
}

export function panelLocalScopeChannelId(channelId: string, panelId: string): string {
  return JSON.stringify(["panel-ui", channelId, panelId]);
}
