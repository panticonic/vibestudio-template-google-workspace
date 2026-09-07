import { describe, expect, it } from "vitest";
import { classifyMergeAspect, threeWayTextMerge } from "./netEffectMerge.js";

describe("threeWayTextMerge", () => {
  it("composes deterministic non-overlapping line edits", () => {
    const merged = threeWayTextMerge("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n");
    expect(merged.kind).toBe("composed");
    if (merged.kind === "composed") expect(merged.text).toBe("A\nb\nC\n");
    expect(threeWayTextMerge("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n")).toEqual(merged);
  });

  it("rejects overlapping edits", () => {
    expect(threeWayTextMerge("a\nb\n", "a\nours\n", "a\ntheirs\n")).toEqual({
      kind: "conflict",
    });
  });

  it("maps preserved lines to their shifted offsets in each parent", () => {
    const merged = threeWayTextMerge("a\nb\nc\n", "inserted\na\nb\nc\n", "a\nb\nchanged\n");
    expect(merged.kind).toBe("composed");
    if (merged.kind !== "composed") return;
    expect(merged.text).toBe("inserted\na\nb\nchanged\n");
    expect(merged.oursMappings).toContainEqual({
      childStart: 0,
      childEnd: 13,
      parentStart: 0,
      parentEnd: 13,
    });
    expect(merged.theirsMappings).toContainEqual({
      childStart: 9,
      childEnd: 21,
      parentStart: 0,
      parentEnd: 12,
    });
  });

  it("reports its analysis bound instead of fabricating a content conflict", () => {
    const base = Array.from({ length: 2_000 }, (_, index) => `base-${index}\n`).join("");
    const ours = `ours\n${base}`;
    const theirs = `${base}theirs\n`;
    expect(threeWayTextMerge(base, ours, theirs)).toEqual({ kind: "too-large" });
  });
});

describe("classifyMergeAspect", () => {
  it("never resolves a disagreeing maximal base silently", () => {
    expect(
      classifyMergeAspect({
        aspect: "mode",
        base: 0o644,
        ours: 0o644,
        theirs: 0o755,
        baseValues: [
          { eventId: "event:a", value: 0o644 },
          { eventId: "event:b", value: 0o755 },
        ],
      })
    ).toBe("conflict");
  });
});
