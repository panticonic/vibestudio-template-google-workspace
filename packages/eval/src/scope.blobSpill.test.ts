import { describe, expect, it } from "vitest";
import { ScopeManager } from "./scope.js";
import { ScopePersistenceAdapter } from "./scopePersistenceAdapter.js";
import { SCOPE_BLOB_REF } from "./scopeSerialize.js";
import type { ScopeEntry } from "./scopePersistence.js";
import type { ScopeBlobBackend, ScopeRowBackend } from "./scopePersistenceAdapter.js";

function memPersistence() {
  const rows = new Map<string, ScopeEntry>();
  const blobs = new Map<string, string>();
  const digest = (s: string) => {
    let h = 5381;
    for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return `h${h.toString(16)}-${s.length}`;
  };
  const rowBackend: ScopeRowBackend = {
    async upsert(e) {
      rows.set(e.id, { ...e, blobRefs: [...(e.blobRefs ?? [])] });
    },
    async loadCurrent(channelId, panelId) {
      return (
        [...rows.values()]
          .filter((row) => row.channelId === channelId && row.panelId === panelId)
          .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
      );
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async list(channelId) {
      return [...rows.values()]
        .filter((row) => row.channelId === channelId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          keys: row.serializedKeys,
          volatile: row.volatileKeys,
        }));
    },
  };
  const blobBackend: ScopeBlobBackend = {
    async putText(json) {
      const d = digest(json);
      blobs.set(d, json);
      return { digest: d, size: json.length };
    },
    async getText(d) {
      return blobs.get(d) ?? null;
    },
    async sweep() {
      const live = new Set<string>();
      for (const e of rows.values()) for (const d of e.blobRefs ?? []) live.add(d);
      for (const d of [...blobs.keys()]) if (!live.has(d)) blobs.delete(d);
    },
  };
  return Object.assign(new ScopePersistenceAdapter(rowBackend, blobBackend), {
    storedRows: rows,
    storedBlobs: blobs,
  });
}

const set = (m: ScopeManager, k: string, v: unknown) => {
  (m.current as Record<string, unknown>)[k] = v;
};
const get = (m: ScopeManager, k: string) => (m.current as Record<string, unknown>)[k];

describe("ScopeManager — blob-spilled large values", () => {
  it("keeps live objects across cells and uses serialization only for cold recovery", async () => {
    class LivePage {
      readonly connectionId = crypto.randomUUID();
      title(): string {
        return "still connected";
      }
    }

    const persistence = memPersistence();
    const warm = new ScopeManager({
      channelId: "notebook",
      panelId: "eval",
      persistence,
    });
    const page = new LivePage();

    warm.enterEval();
    set(warm, "page", page);
    set(warm, "panelId", "panel:one");
    await warm.exitEval();

    warm.enterEval();
    expect(get(warm, "page")).toBe(page);
    expect((get(warm, "page") as LivePage).title()).toBe("still connected");
    await warm.exitEval();

    const cold = new ScopeManager({
      channelId: "notebook",
      panelId: "eval",
      persistence,
    });
    const hydration = await cold.hydrate();

    expect(get(cold, "panelId")).toBe("panel:one");
    expect("page" in cold.current).toBe(false);
    expect(hydration.restored).toContain("panelId");
    expect(hydration.lost).toContain("page");
  });

  it("never cold-hydrates a plain live handle as a methodless data projection", async () => {
    const persistence = memPersistence();
    const warm = new ScopeManager({
      channelId: "notebook",
      panelId: "eval",
      persistence,
    });
    const handle = {
      id: "panel:one",
      cdp: { page: async () => ({ title: () => "live" }) },
      observe: async () => ({ phase: "ready" }),
    };

    set(warm, "handle", handle);
    set(warm, "panelId", handle.id);
    await warm.api.save();
    expect(get(warm, "handle")).toBe(handle);
    expect(typeof (get(warm, "handle") as typeof handle).cdp.page).toBe("function");

    const cold = new ScopeManager({
      channelId: "notebook",
      panelId: "eval",
      persistence,
    });
    const hydration = await cold.hydrate();

    expect("handle" in cold.current).toBe(false);
    expect(get(cold, "panelId")).toBe("panel:one");
    expect(hydration.lost).toContain("handle");
  });

  it("persists + hydrates a large value losslessly via the blob store", async () => {
    const p = memPersistence();
    const big = "x".repeat(512 * 1024);
    const m1 = new ScopeManager({ channelId: "c", panelId: "pn", persistence: p });
    set(m1, "results", big);
    set(m1, "small", { ok: 1 });
    await m1.api.save();

    expect(p.storedBlobs.size).toBe(1); // `results` spilled, `small` inline
    const row = [...p.storedRows.values()][0]!;
    expect(row.data.length).toBeLessThan(64 * 1024); // inline row stays tiny
    expect(row.blobRefs).toHaveLength(1);

    const m2 = new ScopeManager({ channelId: "c", panelId: "pn", persistence: p });
    await m2.hydrate();
    expect(get(m2, "results")).toBe(big); // full value back — nothing lost
    expect(get(m2, "small")).toEqual({ ok: 1 });
  });

  it("sweeps the orphaned blob when a spilled value is overwritten with a small one", async () => {
    const p = memPersistence();
    const m = new ScopeManager({ channelId: "c", panelId: "pn", persistence: p });
    set(m, "results", "x".repeat(512 * 1024));
    await m.api.save();
    expect(p.storedBlobs.size).toBe(1);

    set(m, "results", "now small");
    await m.api.save();
    expect(p.storedBlobs.size).toBe(0); // old blob no longer referenced -> GC'd
  });

  it("does NOT misinterpret user data that mimics the spill marker (no collision)", async () => {
    const p = memPersistence();
    const fake = { [SCOPE_BLOB_REF]: "not-a-real-digest", note: "user data" };
    const m1 = new ScopeManager({ channelId: "c", panelId: "pn", persistence: p });
    set(m1, "fake", fake);
    await m1.api.save();
    expect(p.storedBlobs.size).toBe(0); // a small object — nothing actually spilled

    const m2 = new ScopeManager({ channelId: "c", panelId: "pn", persistence: p });
    await m2.hydrate();
    expect(get(m2, "fake")).toEqual(fake); // round-trips intact, not resolved as a blob ref
  });

  it("surfaces a missing/corrupt spilled blob as a lost key (no brick, no silent undefined)", async () => {
    const p = memPersistence();
    const m1 = new ScopeManager({ channelId: "c", panelId: "pn", persistence: p });
    set(m1, "results", "x".repeat(300 * 1024));
    set(m1, "keep", 7);
    await m1.api.save();
    expect(p.storedBlobs.size).toBe(1);
    p.storedBlobs.clear(); // simulate the referenced blob going missing/corrupt

    const m2 = new ScopeManager({ channelId: "c", panelId: "pn", persistence: p });
    const result = await m2.hydrate();

    expect(get(m2, "keep")).toBe(7); // the rest of the scope still loads — no brick
    expect("results" in (m2.current as object)).toBe(false); // absent, not silently set to undefined
    expect(result.lost).toContain("results"); // surfaced, not swallowed
    expect(result.restored).not.toContain("results");
  });

  it("dedupes identical spilled content (content-addressed)", async () => {
    const p = memPersistence();
    const m = new ScopeManager({ channelId: "c", panelId: "pn", persistence: p });
    const big = "y".repeat(300 * 1024);
    set(m, "a", big);
    set(m, "b", big);
    await m.api.save();

    expect(p.storedBlobs.size).toBe(1); // same content -> one blob
    expect(new Set([...p.storedRows.values()][0]!.blobRefs)).toEqual(new Set(p.storedBlobs.keys()));
  });
});
