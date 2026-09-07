import { describe, expect, it } from "vitest";
import { clampSplitRatio, splitRatioFromDrag, splitRatioFromKey } from "./splitPaneModel.js";

describe("split pane model", () => {
  it("clamps split ratios to keep both panes usable", () => {
    expect(clampSplitRatio(-1)).toBe(0.1);
    expect(clampSplitRatio(0.5)).toBe(0.5);
    expect(clampSplitRatio(2)).toBe(0.9);
  });

  it("converts drag deltas into bounded ratios", () => {
    expect(splitRatioFromDrag(0.5, 100, 1000)).toBeCloseTo(0.6);
    expect(splitRatioFromDrag(0.5, -1000, 1000)).toBe(0.1);
    expect(splitRatioFromDrag(0.5, 100, 0)).toBe(0.5);
  });

  it("supports keyboard resizing for accessible gutters", () => {
    expect(splitRatioFromKey(0.5, "ArrowRight")).toBeCloseTo(0.53);
    expect(splitRatioFromKey(0.5, "ArrowLeft")).toBeCloseTo(0.47);
    expect(splitRatioFromKey(0.5, "ArrowDown", true)).toBeCloseTo(0.6);
    expect(splitRatioFromKey(0.5, "Home")).toBe(0.1);
    expect(splitRatioFromKey(0.5, "End")).toBe(0.9);
    expect(splitRatioFromKey(0.7, "Enter")).toBe(0.5);
    expect(splitRatioFromKey(0.5, "Escape")).toBeUndefined();
  });
});
