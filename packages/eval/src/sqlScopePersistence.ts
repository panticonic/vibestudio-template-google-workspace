import type { ScopeEntry, ScopeListEntry } from "./scopePersistence.js";
import {
  ScopePersistenceAdapter,
  type ScopeBlobBackend,
  type ScopeRowBackend,
} from "./scopePersistenceAdapter.js";

/**
 * Minimal synchronous SQL handle — matches a Durable Object's `ctx.storage.sql`
 * (`exec(query, ...bindings)` returning a cursor with `toArray()`). Declared locally
 * so `@workspace/eval` keeps no dependency on `@vibestudio/durable`/`@workspace/runtime`.
 */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

interface ScopeRow {
  id: string;
  channel_id: string;
  panel_id: string;
  data: string;
  serialized_keys: string;
  dropped_paths: string;
  volatile_keys: string;
  blob_refs: string;
  created_at: number;
}

/** The scope table name — reserved; the EvalDO `db` binding must refuse DDL/DML on it. */
export const SCOPE_TABLE = "repl_scopes";

/**
 * Scope row storage backed directly by a synchronous in-DO SQLite handle. The EvalDO keeps only
 * row metadata in SQLite; spilled scope values go through the supplied blob backend.
 */
export class SqlScopeRowBackend implements ScopeRowBackend {
  constructor(private readonly sql: SqlLike) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ${SCOPE_TABLE} (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        panel_id TEXT NOT NULL,
        data TEXT NOT NULL,
        serialized_keys TEXT NOT NULL,
        dropped_paths TEXT NOT NULL,
        volatile_keys TEXT NOT NULL,
        blob_refs TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_scopes_current ON ${SCOPE_TABLE}(channel_id, panel_id, created_at DESC)`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_scopes_channel ON ${SCOPE_TABLE}(channel_id, created_at)`
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async upsert(entry: ScopeEntry): Promise<void> {
    this.sql.exec(
      `INSERT OR REPLACE INTO ${SCOPE_TABLE}
        (id, channel_id, panel_id, data, serialized_keys, dropped_paths, volatile_keys, blob_refs, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      entry.channelId,
      entry.panelId,
      entry.data,
      JSON.stringify(entry.serializedKeys),
      JSON.stringify(entry.droppedPaths),
      JSON.stringify(entry.volatileKeys),
      JSON.stringify(entry.blobRefs ?? []),
      entry.createdAt
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async loadCurrent(channelId: string, panelId: string): Promise<ScopeEntry | null> {
    const row = this.sql
      .exec(
        `SELECT * FROM ${SCOPE_TABLE} WHERE channel_id = ? AND panel_id = ? ORDER BY created_at DESC LIMIT 1`,
        channelId,
        panelId
      )
      .toArray()[0] as ScopeRow | undefined;
    return row ? fromRow(row) : null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(id: string): Promise<ScopeEntry | null> {
    const row = this.sql.exec(`SELECT * FROM ${SCOPE_TABLE} WHERE id = ?`, id).toArray()[0] as
      | ScopeRow
      | undefined;
    return row ? fromRow(row) : null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async list(channelId: string): Promise<ScopeListEntry[]> {
    const rows = this.sql
      .exec(
        `SELECT id, serialized_keys, volatile_keys, created_at FROM ${SCOPE_TABLE} WHERE channel_id = ? ORDER BY created_at ASC`,
        channelId
      )
      .toArray() as Array<{
      id: string;
      serialized_keys: string;
      volatile_keys: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      keys: JSON.parse(row.serialized_keys) as string[],
      volatile: JSON.parse(row.volatile_keys) as string[],
    }));
  }
}

export class SqlScopePersistence extends ScopePersistenceAdapter {
  constructor(sql: SqlLike, blobs: ScopeBlobBackend) {
    super(new SqlScopeRowBackend(sql), blobs);
  }
}

function fromRow(row: ScopeRow): ScopeEntry {
  return {
    id: row.id,
    channelId: row.channel_id,
    panelId: row.panel_id,
    data: row.data,
    serializedKeys: JSON.parse(row.serialized_keys) as string[],
    droppedPaths: JSON.parse(row.dropped_paths) as Array<{ path: string; reason: string }>,
    volatileKeys: JSON.parse(row.volatile_keys) as string[],
    blobRefs: JSON.parse(row.blob_refs || "[]") as string[],
    createdAt: row.created_at,
  };
}
