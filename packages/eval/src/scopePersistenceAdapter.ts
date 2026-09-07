import type { ScopeEntry, ScopeListEntry, ScopePersistence } from "./scopePersistence.js";

export interface ScopeRowBackend {
  upsert(entry: ScopeEntry): Promise<void>;
  loadCurrent(channelId: string, panelId: string): Promise<ScopeEntry | null>;
  get(id: string): Promise<ScopeEntry | null>;
  list(channelId: string): Promise<ScopeListEntry[]>;
}

export interface ScopeBlobBackend {
  putText(valueJson: string): Promise<{ digest: string; size?: number }>;
  getText(digest: string): Promise<string | null>;
  /**
   * Optional only for backends that own their blob lifecycle. The workspace blobstore is global
   * content-addressed storage, so callers normally leave GC to its own admin/prune path.
   */
  sweep?(): Promise<void>;
}

/**
 * Shared ScopePersistence composition: ScopeManager persists rows through one backend and spills
 * large serialized values through a blobstore-shaped backend. Browser UI and EvalDO differ only in
 * their row backend; spill semantics stay here.
 */
export class ScopePersistenceAdapter implements ScopePersistence {
  constructor(
    private readonly rows: ScopeRowBackend,
    private readonly blobs: ScopeBlobBackend
  ) {}

  upsert(entry: ScopeEntry): Promise<void> {
    return this.rows.upsert(entry);
  }

  loadCurrent(channelId: string, panelId: string): Promise<ScopeEntry | null> {
    return this.rows.loadCurrent(channelId, panelId);
  }

  get(id: string): Promise<ScopeEntry | null> {
    return this.rows.get(id);
  }

  list(channelId: string): Promise<ScopeListEntry[]> {
    return this.rows.list(channelId);
  }

  async putBlob(valueJson: string): Promise<string> {
    const result = await this.blobs.putText(valueJson);
    if (!result.digest) {
      throw new Error("scope persistence blob backend did not return a digest");
    }
    return result.digest;
  }

  getBlob(digest: string): Promise<string | null> {
    return this.blobs.getText(digest);
  }

  async sweepBlobs(): Promise<void> {
    await this.blobs.sweep?.();
  }
}
