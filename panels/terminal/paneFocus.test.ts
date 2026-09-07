import { describe, expect, it } from "vitest";
import { findDirectionalPane } from "./paneFocus.js";
import type { SplitNode } from "./types.js";

describe("pane directional focus", () => {
  it("selects the nearest geometric neighbor in each direction", () => {
    const tree: SplitNode = {
      kind: "split",
      direction: "row",
      ratio: 0.5,
      a: {
        kind: "split",
        direction: "column",
        ratio: 0.5,
        a: { kind: "leaf", sessionId: "top-left" },
        b: { kind: "leaf", sessionId: "bottom-left" },
      },
      b: {
        kind: "split",
        direction: "column",
        ratio: 0.5,
        a: { kind: "leaf", sessionId: "top-right" },
        b: { kind: "leaf", sessionId: "bottom-right" },
      },
    };

    expect(findDirectionalPane(tree, "top-left", "right")).toBe("top-right");
    expect(findDirectionalPane(tree, "top-left", "down")).toBe("bottom-left");
    expect(findDirectionalPane(tree, "bottom-right", "left")).toBe("bottom-left");
    expect(findDirectionalPane(tree, "bottom-right", "up")).toBe("top-right");
  });

  it("prefers overlapping candidates over merely center-near diagonal panes", () => {
    const tree: SplitNode = {
      kind: "split",
      direction: "row",
      ratio: 0.5,
      a: { kind: "leaf", sessionId: "left" },
      b: {
        kind: "split",
        direction: "column",
        ratio: 0.2,
        a: { kind: "leaf", sessionId: "right-top" },
        b: { kind: "leaf", sessionId: "right-bottom" },
      },
    };

    expect(findDirectionalPane(tree, "left", "right")).toBe("right-bottom");
    expect(findDirectionalPane(tree, "right-top", "left")).toBe("left");
  });

  it("returns undefined when there is no pane in that direction", () => {
    const tree: SplitNode = {
      kind: "split",
      direction: "row",
      ratio: 0.5,
      a: { kind: "leaf", sessionId: "left" },
      b: { kind: "leaf", sessionId: "right" },
    };

    expect(findDirectionalPane(tree, "left", "left")).toBeUndefined();
    expect(findDirectionalPane(tree, "missing", "right")).toBeUndefined();
  });
});
