/**
 * scope — Core ScopeManager for REPL-style eval.
 *
 * Proxy handles in-memory state + reactivity. Persistence is decoupled
 * via the ScopePersistence interface.
 */

import type { ScopePersistence, ScopeListEntry } from "./scopePersistence.js";
import {
  serializeScope,
  deserializeScope,
  deserializeScopeValue,
  isScopeBlobRef,
  SCOPE_BLOB_REF,
} from "./scopeSerialize.js";

/** Sentinel: a referenced spill blob could not be read (missing/corrupt). Surfaced as a lost key. */
const BLOB_RESOLVE_FAILED = Symbol("blobResolveFailed");

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface ScopesApi {
  /** Current scope's durable ID */
  readonly currentId: string;

  /**
   * Archive current scope and start a new one (inherits serializable values).
   * Returns the new scope's ID. Old scope accessible via get(oldId).
   */
  push(): Promise<string>;

  /**
   * Get an archived scope by its durable ID.
   * Returns a read-only plain object from persistence.
   */
  get(id: string): Promise<Record<string, unknown> | null>;

  /** List all scope entries for this channel, sorted by creation time. */
  list(): Promise<ScopeListEntry[]>;

  /** Force-persist current scope now. */
  save(): Promise<void>;
}

export interface HydrateResult {
  restored: string[];
  lost: string[];
}

// ---------------------------------------------------------------------------
// ScopeManager
// ---------------------------------------------------------------------------

export class ScopeManager {
  private backing: Map<string, unknown>;
  private proxy: Record<string, unknown>;
  private changeListeners = new Set<() => void>();
  private persistence: ScopePersistence | undefined;
  private channelId: string;
  private panelId: string;
  private currentScopeId: string;
  private currentCreatedAt: number;
  private evalInProgress = false;
  private dirty = false;
  private disposed = false;

  constructor(opts: { channelId: string; panelId: string; persistence?: ScopePersistence }) {
    this.channelId = opts.channelId;
    this.panelId = opts.panelId;
    this.persistence = opts.persistence;
    this.currentScopeId = crypto.randomUUID();
    this.currentCreatedAt = Date.now();
    this.backing = new Map();
    this.proxy = this.createProxy();
  }

  // -------------------------------------------------------------------------
  // Proxy
  // -------------------------------------------------------------------------

  private createProxy(): Record<string, unknown> {
    return new Proxy({} as Record<string, unknown>, {
      get: (_target, prop: string) => this.backing.get(prop),
      set: (_target, prop: string, value) => {
        this.backing.set(prop, value);
        this.dirty = true;
        if (!this.evalInProgress) {
          this.notifyChangeListeners();
        }
        return true;
      },
      deleteProperty: (_target, prop: string) => {
        this.backing.delete(prop);
        this.dirty = true;
        if (!this.evalInProgress) {
          this.notifyChangeListeners();
        }
        return true;
      },
      has: (_target, prop: string) => this.backing.has(prop),
      ownKeys: () => Array.from(this.backing.keys()),
      getOwnPropertyDescriptor: (_target, prop: string) => {
        if (!this.backing.has(prop)) return undefined;
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: this.backing.get(prop),
        };
      },
    });
  }

  // -------------------------------------------------------------------------
  // Public accessors
  // -------------------------------------------------------------------------

  /** The current scope Proxy (pre-injected as `scope` binding) */
  get current(): Record<string, unknown> {
    return this.proxy;
  }

  /** Whether scope has unsaved mutations since last persist */
  get isDirty(): boolean {
    return this.dirty;
  }

  /** The scopes API (pre-injected as `scopes` binding) */
  get api(): ScopesApi {
    return this.apiFor(this.requirePersistence());
  }

  /**
   * Bind the public scopes API to one explicit persistence capability.
   * Long-lived managers may therefore keep state without retaining the
   * authority of whichever operation happened to construct them.
   */
  apiFor(persistence: ScopePersistence): ScopesApi {
    return this.apiFrom(() => persistence);
  }

  /**
   * Bind the public API to an operation-time capability resolver. Runtime
   * facades retained across eval cells can therefore use the invoking cell's
   * admission without retaining the cell that created the facade.
   */
  apiFrom(resolvePersistence: () => ScopePersistence): ScopesApi {
    const readCurrentId = () => this.currentScopeId;
    return {
      get currentId() {
        return readCurrentId();
      },
      push: () => this.push(resolvePersistence()),
      get: (id: string) => this.getScope(id, resolvePersistence()),
      list: () => this.listScopes(resolvePersistence()),
      save: () => this.persist(resolvePersistence()),
    };
  }

  private requirePersistence(override?: ScopePersistence): ScopePersistence {
    const persistence = override ?? this.persistence;
    if (!persistence) {
      throw new Error("ScopeManager operation requires an explicit persistence capability");
    }
    return persistence;
  }

  // -------------------------------------------------------------------------
  // Hydration
  // -------------------------------------------------------------------------

  /** Hydrate from persistence on init. Async — call once on mount. */
  async hydrate(persistence?: ScopePersistence): Promise<HydrateResult> {
    const p = this.requirePersistence(persistence);
    const entry = await p.loadCurrent(this.channelId, this.panelId);
    if (!entry) {
      return { restored: [], lost: [] };
    }

    // Restore scope ID and timestamp from persisted state
    this.currentScopeId = entry.id;
    this.currentCreatedAt = entry.createdAt;

    const restoredMap = deserializeScope(entry.data);
    const validDigests = new Set(entry.blobRefs ?? []);
    const blobFailures: string[] = [];
    for (const [key, value] of restoredMap) {
      const resolved = await this.resolveBlobRef(value, validDigests, p);
      if (resolved === BLOB_RESOLVE_FAILED) {
        // A referenced blob was missing/corrupt — surface it as lost rather than silently
        // setting `undefined`, and don't brick the rest of the scope.
        blobFailures.push(key);
        continue;
      }
      this.backing.set(key, resolved);
    }

    return {
      restored: entry.serializedKeys.filter((k) => !blobFailures.includes(k)),
      // `volatileKeys` is the complete top-level recovery authority.
      // `droppedPaths` is deliberately bounded and diagnostic-only.
      lost: [...new Set([...entry.volatileKeys, ...blobFailures])],
    };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /** Persist current state. Called by save triggers. */
  async persist(persistence?: ScopePersistence): Promise<void> {
    if (this.disposed) return;
    // Snapshot dirty before the await — if a mutation arrives during the
    // upsert, dirty will be re-set to true and we must not clear it.
    this.dirty = false;
    const { serialized, spills, serializedKeys, droppedPaths, volatileKeys } = serializeScope(
      this.backing
    );
    const p = this.requirePersistence(persistence);
    const blobRefs: string[] = [];
    if (spills.length > 0) {
      // Spill large values to the content-addressed blob store (lossless), stamping each
      // placeholder with its digest. Persistence implementations must provide this store;
      // a save is never allowed to silently discard an oversized value.
      for (const spill of spills) {
        const digest = await p.putBlob(spill.valueJson);
        spill.placeholder[SCOPE_BLOB_REF] = digest;
        blobRefs.push(digest);
      }
    }
    await p.upsert({
      id: this.currentScopeId,
      channelId: this.channelId,
      panelId: this.panelId,
      data: JSON.stringify(serialized),
      serializedKeys,
      droppedPaths,
      volatileKeys,
      blobRefs,
      createdAt: this.currentCreatedAt,
    });
    // Backends that own blob lifecycle may clean up overwritten/cleared spills here. The shared
    // workspace blobstore leaves this as a no-op and relies on its admin/prune path.
    if (p.sweepBlobs) await p.sweepBlobs();
  }

  // -------------------------------------------------------------------------
  // Eval lifecycle
  // -------------------------------------------------------------------------

  /** Mark eval start — suppress component reactivity notifications */
  enterEval(): void {
    this.evalInProgress = true;
  }

  /** Mark eval end — trigger one batched reactivity notification + persist */
  async exitEval(persistence?: ScopePersistence): Promise<void> {
    this.evalInProgress = false;
    this.notifyChangeListeners();
    await this.persist(persistence);
  }

  // -------------------------------------------------------------------------
  // Scope history
  // -------------------------------------------------------------------------

  private async push(persistence: ScopePersistence): Promise<string> {
    // Persist current scope first
    await this.persist(persistence);

    // Create new scope inheriting serializable values
    this.currentScopeId = crypto.randomUUID();
    this.currentCreatedAt = Date.now();

    // Persist the new scope immediately (inherits current backing data)
    await this.persist(persistence);

    return this.currentScopeId;
  }

  private async getScope(
    id: string,
    persistence: ScopePersistence
  ): Promise<Record<string, unknown> | null> {
    const entry = await persistence.get(id);
    if (!entry) return null;
    const map = deserializeScope(entry.data);
    const validDigests = new Set(entry.blobRefs ?? []);
    const obj: Record<string, unknown> = {};
    for (const [key, value] of map) {
      const resolved = await this.resolveBlobRef(value, validDigests, persistence);
      if (resolved !== BLOB_RESOLVE_FAILED) obj[key] = resolved; // omit a key whose blob is unreadable
    }
    return obj;
  }

  /**
   * Hydrate a spilled-value placeholder from the blob store; pass everything else through unchanged.
   * Only digests this scope actually spilled (`validDigests`) are resolved — so a user value that
   * merely *looks* like a placeholder is left untouched (no collision). A missing or corrupt blob
   * returns `BLOB_RESOLVE_FAILED` (the caller surfaces it as a lost key) rather than throwing or
   * silently substituting `undefined`, so one bad blob neither bricks the load nor hides the problem.
   */
  private async resolveBlobRef(
    value: unknown,
    validDigests: Set<string>,
    persistence: ScopePersistence
  ): Promise<unknown | typeof BLOB_RESOLVE_FAILED> {
    if (!isScopeBlobRef(value)) return value;
    const digest = value[SCOPE_BLOB_REF] as string;
    if (!validDigests.has(digest) || !persistence.getBlob) return value;
    let blobJson: string | null;
    try {
      blobJson = await persistence.getBlob(digest);
    } catch {
      return BLOB_RESOLVE_FAILED; // store read failed
    }
    if (blobJson == null) return BLOB_RESOLVE_FAILED; // referenced blob missing
    try {
      return deserializeScopeValue(blobJson);
    } catch {
      return BLOB_RESOLVE_FAILED; // corrupt blob content
    }
  }

  private async listScopes(persistence: ScopePersistence): Promise<ScopeListEntry[]> {
    return persistence.list(this.channelId);
  }

  // -------------------------------------------------------------------------
  // Change listeners (component reactivity)
  // -------------------------------------------------------------------------

  /** Subscribe to scope changes. Notifications suppressed during eval. */
  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => {
      this.changeListeners.delete(cb);
    };
  }

  private notifyChangeListeners(): void {
    for (const cb of this.changeListeners) {
      try {
        cb();
      } catch (err) {
        console.warn("[ScopeManager] Change listener error:", err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  dispose(persistence?: ScopePersistence): void {
    if (this.dirty) {
      const p = this.requirePersistence(persistence);
      this.persist(p).catch((err) => console.warn("[ScopeManager] Dispose persist failed:", err));
    }
    this.disposed = true;
    this.changeListeners.clear();
  }
}
