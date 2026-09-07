import { describe, expect, it } from "vitest";
import { createAgentReferenceStore, loadAgentReference } from "../agent-pagination.js";

describe("agent reference store", () => {
  it("survives reconstruction and resolves only inside its purpose domain", () => {
    const state = new Map<string, string>();
    const persistence = {
      get: (key: string) => state.get(key) ?? null,
      set: (key: string, value: string) => state.set(key, value),
      delete: (key: string) => state.delete(key),
    };
    const first = createAgentReferenceStore(persistence);
    const exact = {
      kind: "file",
      state: { kind: "event", eventId: `workspace-event:${"a".repeat(64)}` },
      repositoryId: `repository:${"b".repeat(64)}`,
      fileId: `file:${"c".repeat(64)}`,
    };

    const ref = first.put("provenance-root", exact);
    const reconstructed = createAgentReferenceStore(persistence);

    expect(ref).toMatch(/^@r[0-9a-z]+-[0-9a-f]{4}$/u);
    expect(loadAgentReference(reconstructed, "provenance-root", ref)).toEqual(exact);
    expect(() => loadAgentReference(reconstructed, "vcs-compare", ref)).toThrow(/unavailable/u);
  });

  it("recovers deterministically from corrupt sequence metadata", () => {
    const values = new Map<string, string>([["sequence", "not-a-number"]]);
    const store = createAgentReferenceStore({
      get: (key) => values.get(key) ?? null,
      set: (key, value) => values.set(key, value),
      delete: (key) => values.delete(key),
    });

    expect(store.put("test", { value: 1 })).toMatch(/^@r1-/u);
  });

  it("deduplicates the same exact basis without exposing it in the ref", () => {
    const state = new Map<string, string>();
    const store = createAgentReferenceStore({
      get: (key) => state.get(key) ?? null,
      set: (key, value) => state.set(key, value),
      delete: (key) => state.delete(key),
    });
    const basis = { source: `workspace-event:${"d".repeat(64)}`, cursor: "opaque" };

    const first = store.put("vcs-compare", basis);
    const second = store.put("vcs-compare", basis);

    expect(second).toBe(first);
    expect(first).not.toContain("workspace-event");
    expect(first).not.toContain("opaque");
  });
});
