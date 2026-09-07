// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { snapshotDocument } from "./agentApi.js";

describe("snapshotDocument", () => {
  it("bounds both text and structural traversal", () => {
    const wide = document.createElement("main");
    for (let index = 0; index < 600; index += 1) {
      const child = document.createElement("span");
      child.textContent = `item-${index} ${"x".repeat(200)}`;
      wide.appendChild(child);
    }
    document.body.replaceChildren(wide);

    const snapshot = snapshotDocument(document);
    expect(snapshot.text.length).toBeLessThanOrEqual(snapshot.limits.textCharacters);
    expect(snapshot.observed.structureNodes).toBeLessThanOrEqual(snapshot.limits.structureNodes);
    expect(snapshot.truncated).toBe(true);
    expect((snapshot.structure as { children: unknown[] }).children).toHaveLength(1);
  });

  it("marks a depth-limited tree as truncated", () => {
    let parent: Element = document.body;
    document.body.replaceChildren();
    for (let depth = 0; depth < 12; depth += 1) {
      const child = document.createElement("div");
      parent.appendChild(child);
      parent = child;
    }

    const snapshot = snapshotDocument(document);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.observed.structureNodes).toBe(snapshot.limits.depth + 1);
  });
});
