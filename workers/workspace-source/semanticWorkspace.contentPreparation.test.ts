import { describe, expect, it } from "vitest";
import { sha256Hex } from "@vibestudio/content-addressing";
import { createInMemorySql } from "@vibestudio/durable/test-utils";
import { createSemanticVcsSchema } from "./semanticVcsSchema.js";
import { SemanticVcsStore } from "./semanticVcsStore.js";
import {
  SemanticWorkspace,
  type SemanticDispatchRequest,
  type SemanticDispatchResult,
} from "./semanticWorkspace.js";

const ingress: SemanticDispatchRequest["ingress"] = {
  causalParent: null,
  contextIntegrity: { class: "internal", externalKeys: [] },
};
const timestamp = "2026-09-08T00:00:00Z";
async function fixture() {
  const raw = await createInMemorySql();
  const sql = {
    exec(
      query: string,
      ...values: Parameters<typeof raw.exec> extends [string, ...infer B] ? B : never
    ) {
      if (values.some((value) => typeof value === "string" && value.length > 1_000_000)) {
        throw new Error("SQLITE_TOOBIG: oversized durable cell");
      }
      return raw.exec(query, ...values);
    },
  };
  createSemanticVcsSchema(sql);
  const store = new SemanticVcsStore(sql, () => timestamp);
  let serial = 0;
  const semantic = new SemanticWorkspace({
    workspaceId: "workspace:test",
    sql,
    store,
    now: () => timestamp,
    transaction<T>(fn: () => T): T {
      const name = `prepare_${serial++}`;
      sql.exec(`SAVEPOINT ${name}`);
      try {
        const value = fn();
        sql.exec(`RELEASE ${name}`);
        return value;
      } catch (error) {
        sql.exec(`ROLLBACK TO ${name}`);
        sql.exec(`RELEASE ${name}`);
        throw error;
      }
    },
  });
  const initial = store.initializeWorkspace("context:test", "command:genesis");
  const request = (
    commandId: string,
    changes: unknown[],
    expectedWorkingHead = initial.working.ref
  ): SemanticDispatchRequest => ({
    ingress,
    input: {
      contextId: "context:test",
      commandId,
      expectedWorkingHead,
      changes,
    },
  });
  const prepare = (result: SemanticDispatchResult) => {
    if (result.kind !== "host-content") throw new Error(`expected preparation, got ${result.kind}`);
    const blobs = result.request["blobs"] as Array<{
      contentHash: string;
      base64: string;
    }>;
    for (const blob of blobs)
      expect(sha256Hex(Uint8Array.from(atob(blob.base64), (c) => c.charCodeAt(0)))).toBe(
        blob.contentHash
      );
    return {
      request: result.request,
      contentHashes: blobs.map((b) => b.contentHash),
    };
  };
  const large = btoa("image-bytes".repeat(220_000));
  const create = (base64 = large) => [
    {
      kind: "repository-create",
      repoPath: "projects/art",
      files: [
        { path: "scene.png", mode: 0o644, content: { kind: "bytes", base64 } },
        {
          path: "story.txt",
          mode: 0o644,
          content: { kind: "text", text: "moon gate\n" },
        },
      ],
    },
  ];
  return { sql, store, semantic, initial, request, prepare, large, create };
}

describe("semantic authored content preparation", () => {
  it("persists large binary content before advancing semantic state and keeps bytes out of durable cells", async () => {
    const f = await fixture();
    const command = f.request("command:paint", f.create());
    const prepared = f.prepare(await f.semantic.dispatch("edit", command));
    expect(f.store.command("command:paint")).toBeNull();
    expect(f.store.context("context:test")?.working.ref).toEqual(f.initial.working.ref);
    expect(f.store.pendingEffects()).toEqual([]);
    const committed = f.semantic.acknowledgeContent(prepared);
    expect(committed.kind).toBe("effects-pending");
    expect(JSON.stringify(f.store.pendingEffects())).not.toContain("base64");
    expect(JSON.stringify(f.store.pendingEffects()).length).toBeLessThan(10_000);
    expect(await f.semantic.dispatch("edit", command)).toEqual(committed);
    expect(f.semantic.acknowledgeContent(prepared)).toEqual(committed);
    const roots = f.semantic.contentGcRoots();
    for (const digest of prepared.contentHashes) expect(roots.contentHashes).toContain(digest);
  });

  it("refuses mismatched or duplicate content receipts without recording a command", async () => {
    const f = await fixture();
    const prepared = f.prepare(
      await f.semantic.dispatch("edit", f.request("command:paint", f.create()))
    );
    expect(() => f.semantic.acknowledgeContent({ ...prepared, contentHashes: [] })).toThrow(
      "Prepared content"
    );
    expect(() =>
      f.semantic.acknowledgeContent({
        ...prepared,
        contentHashes: [...prepared.contentHashes, prepared.contentHashes[0]!],
      })
    ).toThrow("Prepared content");
    expect(f.store.command("command:paint")).toBeNull();
  });

  it("rejects a stale preparation after another command advances the head", async () => {
    const f = await fixture();
    const prepared = f.prepare(
      await f.semantic.dispatch("edit", f.request("command:paint", f.create()))
    );
    const other = f.prepare(
      await f.semantic.dispatch("edit", f.request("command:other", f.create(btoa("other"))))
    );
    f.semantic.acknowledgeContent(other);
    expect(() => f.semantic.acknowledgeContent(prepared)).toThrow();
    expect(f.store.command("command:paint")).toBeNull();
  });
  it("prepares mixed large text and binary edits without journaling request bodies", async () => {
    const f = await fixture();
    f.semantic.acknowledgeContent(f.prepare(await f.semantic.dispatch("edit", f.request("command:seed", f.create(btoa("initial"))))));
    const head = f.store.context("context:test")!.working.ref;
    const root = f.store.stateRoot(head);
    const repository = f.store.facts.repositoryAtPath(root, "projects/art")!;
    const textFile = f.store.facts.fileAtPath(root, repository.repositoryId, "story.txt")!;
    const binaryFile = f.store.facts.fileAtPath(root, repository.repositoryId, "scene.png")!;
    const inserted = "stars ".repeat(400_000);
    const command = f.request("command:mixed", [
      { kind: "text-edit", repositoryId: repository.repositoryId, fileId: textFile.state.fileId,
        edits: [{ start: 0, end: 4, text: inserted }] },
      { kind: "binary-replace", repositoryId: repository.repositoryId, fileId: binaryFile.state.fileId, base64: f.large },
    ], head);
    const observation = await f.semantic.dispatch("edit", command);
    expect(observation.kind).toBe("host-read");
    if (observation.kind !== "host-read") throw new Error("expected transient observation");
    expect(f.store.command("command:mixed")).toBeNull();
    const prepared = f.prepare(f.semantic.acknowledgeHostRead({ request: observation.request,
      files: [{ contentHash: sha256Hex(new TextEncoder().encode("moon gate\n")), text: "moon gate\n" }],
    }));
    expect(f.store.command("command:mixed")).toBeNull();
    const committed = f.semantic.acknowledgeContent(prepared);
    expect(committed.kind).toBe("effects-pending");
    const payloads = f.sql.exec("SELECT payload_json FROM gad_changes WHERE kind = 'text'").toArray();
    expect(payloads).toHaveLength(1);
    expect(JSON.parse(String(payloads[0]!["payload_json"]))).toEqual({ edits: [{ start: 0, end: 4, insertedExtent: inserted.length }] });
    expect(JSON.stringify(f.store.pendingEffects())).not.toContain("base64");
    expect(JSON.stringify(f.store.pendingEffects())).not.toContain(inserted);
    expect(f.sql.exec("SELECT count(*) AS n FROM gad_content_edges").toArray()[0]!["n"]).toBeGreaterThan(0);
  });

  it("keeps semantic-only content durable without creating a projection effect", async () => {
    const f = await fixture();
    const coordinate = f.semantic.ensureContextCoordinate({ contextId: "context:semantic", commandId: "command:semantic" }, ingress);
    expect(coordinate.kind).toBe("complete");
    const head = f.store.context("context:semantic")!.working.ref;
    const request = { ingress, input: { contextId: "context:semantic", commandId: "command:semantic-paint", expectedWorkingHead: head, changes: f.create() } };
    const prepared = f.prepare(await f.semantic.dispatch("edit", request));
    const committed = f.semantic.acknowledgeContent(prepared);
    expect(committed.kind).toBe("complete");
    expect(f.store.pendingEffects()).toEqual([]);
    for (const digest of prepared.contentHashes) expect(f.semantic.contentGcRoots().contentHashes).toContain(digest);
  });

});
