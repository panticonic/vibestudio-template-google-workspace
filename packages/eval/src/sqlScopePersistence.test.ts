import { describe, expect, it } from "vitest";
import { ScopeManager } from "./scope.js";
import { SqlScopePersistence, SqlScopeRowBackend } from "./sqlScopePersistence.js";

interface FakeScopeRow {
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

class FakeSql {
  readonly queries: string[] = [];
  readonly rows = new Map<string, FakeScopeRow>();

  exec(query: string, ...bindings: unknown[]) {
    const q = query.replace(/\s+/g, " ").trim();
    this.queries.push(q);
    const result = (rows: unknown[]) => ({ toArray: () => rows });

    if (q.startsWith("CREATE TABLE IF NOT EXISTS repl_scopes")) return result([]);
    if (q.startsWith("CREATE INDEX IF NOT EXISTS idx_scopes_")) return result([]);

    if (q.startsWith("INSERT OR REPLACE INTO repl_scopes")) {
      const [
        id,
        channelId,
        panelId,
        data,
        serializedKeys,
        droppedPaths,
        volatileKeys,
        blobRefs,
        createdAt,
      ] = bindings as [string, string, string, string, string, string, string, string, number];
      this.rows.set(id, {
        id,
        channel_id: channelId,
        panel_id: panelId,
        data,
        serialized_keys: serializedKeys,
        dropped_paths: droppedPaths,
        volatile_keys: volatileKeys,
        blob_refs: blobRefs,
        created_at: createdAt,
      });
      return result([]);
    }

    if (q.startsWith("SELECT * FROM repl_scopes WHERE channel_id = ?")) {
      const [channelId, panelId] = bindings as [string, string];
      return result(
        [...this.rows.values()]
          .filter((row) => row.channel_id === channelId && row.panel_id === panelId)
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, 1)
      );
    }

    if (q.startsWith("SELECT * FROM repl_scopes WHERE id = ?")) {
      return result([this.rows.get(String(bindings[0]))].filter(Boolean));
    }

    if (q.startsWith("SELECT id, serialized_keys, volatile_keys, created_at FROM repl_scopes")) {
      const [channelId] = bindings as [string];
      return result(
        [...this.rows.values()]
          .filter((row) => row.channel_id === channelId)
          .sort((a, b) => a.created_at - b.created_at)
          .map((row) => ({
            id: row.id,
            serialized_keys: row.serialized_keys,
            volatile_keys: row.volatile_keys,
            created_at: row.created_at,
          }))
      );
    }

    throw new Error(`unexpected SQL query: ${q}`);
  }
}

function blobBackend() {
  const blobs = new Map<string, string>();
  let counter = 0;
  return {
    blobs,
    backend: {
      async putText(valueJson: string) {
        const digest = `test-digest-${++counter}`;
        blobs.set(digest, valueJson);
        return { digest, size: valueJson.length };
      },
      async getText(digest: string) {
        return blobs.get(digest) ?? null;
      },
    },
  };
}

describe("SqlScopePersistence", () => {
  it("supports operation-scoped persistence without retaining it as a default", async () => {
    const sql = new FakeSql();
    const { backend } = blobBackend();
    const persistence = new SqlScopePersistence(sql as never, backend);
    const manager = new ScopeManager({ channelId: "c", panelId: "eval" });

    await expect(manager.hydrate()).rejects.toThrow(/explicit persistence capability/);
    expect(() => manager.api).toThrow(/explicit persistence capability/);

    await expect(manager.hydrate(persistence)).resolves.toEqual({ restored: [], lost: [] });
    manager.current["value"] = 42;
    await manager.apiFor(persistence).save();
    expect([...sql.rows.values()][0]?.data).toContain("42");

    const restarted = new ScopeManager({ channelId: "c", panelId: "eval" });
    await expect(restarted.hydrate(persistence)).resolves.toEqual({
      restored: ["value"],
      lost: [],
    });
    expect(restarted.current["value"]).toBe(42);

    const secondSql = new FakeSql();
    const secondPersistence = new SqlScopePersistence(secondSql as never, blobBackend().backend);
    let activePersistence = persistence;
    const retainedApi = manager.apiFrom(() => activePersistence);
    activePersistence = secondPersistence;
    manager.current["value"] = 84;
    await retainedApi.save();
    expect([...secondSql.rows.values()][0]?.data).toContain("84");

    await expect(manager.persist()).rejects.toThrow(/explicit persistence capability/);
    manager.current["unsaved"] = true;
    expect(() => manager.dispose()).toThrow(/explicit persistence capability/);
  });

  it("creates only the scope row schema", () => {
    const sql = new FakeSql();
    new SqlScopeRowBackend(sql as never);

    expect(sql.queries.some((query) => query.includes("scope_blobs"))).toBe(false);
    expect(sql.queries.some((query) => query.startsWith("PRAGMA "))).toBe(false);
    expect(sql.queries.some((query) => query.startsWith("ALTER TABLE "))).toBe(false);
  });

  it("keeps large spill bytes out of SQLite and hydrates them through the blob backend", async () => {
    const sql = new FakeSql();
    const { backend, blobs } = blobBackend();
    const persistence = new SqlScopePersistence(sql as never, backend);
    const large = "z".repeat(300 * 1024);

    const writer = new ScopeManager({ channelId: "c", panelId: "eval", persistence });
    writer.current["large"] = large;
    writer.current["small"] = { ok: true };
    await writer.api.save();

    expect(blobs.size).toBe(1);
    const row = [...sql.rows.values()][0]!;
    expect(row.data.length).toBeLessThan(64 * 1024);
    expect(JSON.parse(row.blob_refs)).toHaveLength(1);
    expect(sql.queries.some((query) => query.includes("scope_blobs"))).toBe(false);

    const reader = new ScopeManager({ channelId: "c", panelId: "eval", persistence });
    const result = await reader.hydrate();

    expect(result.restored).toEqual(expect.arrayContaining(["large", "small"]));
    expect(reader.current["large"]).toBe(large);
    expect(reader.current["small"]).toEqual({ ok: true });
  });
});
