import { describe, expect, it } from "vitest";

import {
  composePersistentRadix,
  emptyPersistentRadixRoot,
  persistentRadixEntryAt,
  type PersistentRadixNode,
} from "./persistentRadix.js";

describe("persistent radix mutation proofs", () => {
  it("retain only created nodes reachable from the final root", () => {
    const empty = emptyPersistentRadixRoot("test-index", "hashed");
    const proof = composePersistentRadix({
      basis: empty.root,
      updates: ["alpha", "bravo", "charlie", "delta"].map((key) => ({
        key,
        expectedValue: null,
        resultValue: `value:${key}`,
      })),
      readNode: (_kind, _route, nodeId) => (nodeId === empty.node.nodeId ? empty.node : null),
    });
    const created = new Map(proof.createdNodes.map((node) => [node.nodeId, node] as const));
    const reachable = new Set<string>();
    const pending = [proof.resultRoot.rootNodeId];
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (reachable.has(nodeId)) continue;
      const node = created.get(nodeId);
      if (!node) continue;
      reachable.add(nodeId);
      if (node.shape.kind === "branch") {
        for (const child of node.shape.children) pending.push(child.childNodeId);
      }
    }

    expect([...created.keys()].sort()).toEqual([...reachable].sort());
    const nodes = new Map<string, PersistentRadixNode>([[empty.node.nodeId, empty.node]]);
    for (const node of proof.createdNodes) nodes.set(node.nodeId, node);
    for (const key of ["alpha", "bravo", "charlie", "delta"]) {
      expect(
        persistentRadixEntryAt({
          root: proof.resultRoot,
          key,
          readNode: (_kind, _route, nodeId) => nodes.get(nodeId) ?? null,
        })
      ).toEqual({ key, value: `value:${key}` });
    }
  });

  it.each(["hashed", "utf16"] as const)(
    "constructs the same canonical %s root in bulk as successive point mutations",
    (routeStrategy) => {
      const empty = emptyPersistentRadixRoot("test-index", routeStrategy);
      const entries = Array.from({ length: 200 }, (_, index) => ({
        key: `key-${index.toString().padStart(3, "0")}`,
        expectedValue: null,
        resultValue: `value:${index}`,
      }));
      const bulk = composePersistentRadix({
        basis: empty.root,
        updates: entries,
        readNode: (_kind, _route, nodeId) => (nodeId === empty.node.nodeId ? empty.node : null),
      });

      const incrementalNodes = new Map<string, PersistentRadixNode>([
        [empty.node.nodeId, empty.node],
      ]);
      let incrementalRoot = empty.root;
      for (const update of [...entries].reverse()) {
        const proof = composePersistentRadix({
          basis: incrementalRoot,
          updates: [update],
          readNode: (_kind, _route, nodeId) => incrementalNodes.get(nodeId) ?? null,
        });
        for (const node of proof.createdNodes) incrementalNodes.set(node.nodeId, node);
        incrementalRoot = proof.resultRoot;
      }

      expect(bulk.resultRoot).toEqual(incrementalRoot);
    }
  );
});
