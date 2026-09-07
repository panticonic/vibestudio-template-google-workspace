import { describe, it, expect } from "vitest";
import { deriveContextOptions, type LiveEntity } from "./contextPicker.js";

describe("deriveContextOptions", () => {
  it("dedups by contextId, labels with the best hint, and sorts by label", () => {
    const entities: LiveEntity[] = [
      { id: "a", kind: "session", source: "terminal", contextId: "ctx-b", title: "Beta work", createdAt: 2 },
      { id: "b", kind: "panel", source: "panels/chat", contextId: "ctx-b", createdAt: 1 },
      { id: "c", kind: "session", source: "agent-cli", contextId: "ctx-a", createdAt: 3 },
    ];
    expect(deriveContextOptions(entities)).toEqual([
      { contextId: "ctx-a", label: "agent-cli" },
      { contextId: "ctx-b", label: "Beta work" },
    ]);
  });

  it("skips entities without a contextId and falls back to the id when unlabeled", () => {
    const entities: LiveEntity[] = [
      { id: "a", kind: "session", source: "", contextId: "" },
      { id: "b", kind: "do", source: "", contextId: "ctx-x" },
    ];
    expect(deriveContextOptions(entities)).toEqual([{ contextId: "ctx-x", label: "ctx-x" }]);
  });
});
