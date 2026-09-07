import { describe, expect, it } from "vitest";
import {
  allAdded,
  allRemoved,
  DiffTooLargeError,
  diffLines,
  MAX_RENDERED_DIFF_LINES,
  splitLines,
} from "@vibestudio/shared/lineDiff";

describe("splitLines", () => {
  it("drops the trailing-newline empty element", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
  });
  it("treats an empty file as a single empty line", () => {
    expect(splitLines("")).toEqual([""]);
  });
});

describe("diffLines", () => {
  it("marks a changed middle line as one removal + one addition, keeping context", () => {
    const { rows, insertions, deletions } = diffLines("a\nb\nc\n", "a\nB\nc\n");
    expect(insertions).toBe(1);
    expect(deletions).toBe(1);
    expect(rows.map((r) => [r.type, r.text])).toEqual([
      ["context", "a"],
      ["removed", "b"],
      ["added", "B"],
      ["context", "c"],
    ]);
  });

  it("assigns old/new line numbers on each side", () => {
    const { rows } = diffLines("a\nb\nc\n", "a\nB\nc\n");
    const removed = rows.find((r) => r.type === "removed");
    const added = rows.find((r) => r.type === "added");
    expect(removed?.oldLineNo).toBe(2);
    expect(removed?.newLineNo).toBeUndefined();
    expect(added?.newLineNo).toBe(2);
    expect(added?.oldLineNo).toBeUndefined();
  });

  it("handles a pure insertion", () => {
    const { rows, insertions, deletions } = diffLines("a\nc\n", "a\nb\nc\n");
    expect(insertions).toBe(1);
    expect(deletions).toBe(0);
    expect(rows.filter((r) => r.type === "added").map((r) => r.text)).toEqual(["b"]);
  });

  it("returns all-context for identical inputs", () => {
    const { rows, insertions, deletions } = diffLines("x\ny\n", "x\ny\n");
    expect(insertions).toBe(0);
    expect(deletions).toBe(0);
    expect(rows.every((r) => r.type === "context")).toBe(true);
  });

  it("counts an empty→empty diff as 0/0", () => {
    const { insertions, deletions } = diffLines("", "");
    expect(insertions).toBe(0);
    expect(deletions).toBe(0);
  });

  it("counts an empty→content diff as +1/0 with only the added row", () => {
    const { rows, insertions, deletions } = diffLines("", "hello");
    expect(insertions).toBe(1);
    expect(deletions).toBe(0);
    expect(rows.map((r) => [r.type, r.text])).toEqual([["added", "hello"]]);
  });

  it("counts a content→empty diff as 0/-1 with only the removed row", () => {
    const { rows, insertions, deletions } = diffLines("hello", "");
    expect(insertions).toBe(0);
    expect(deletions).toBe(1);
    expect(rows.map((r) => [r.type, r.text])).toEqual([["removed", "hello"]]);
  });

  it("rejects dense diffs that would allocate an oversized LCS matrix", () => {
    const oldText = Array.from({ length: 2_001 }, (_, index) => `old ${index}`).join("\n");
    const newText = Array.from({ length: 2_001 }, (_, index) => `new ${index}`).join("\n");

    expect(() => diffLines(oldText, newText)).toThrow(DiffTooLargeError);
  });
});

describe("single-blob helpers", () => {
  it("allAdded marks every line added", () => {
    const { rows, insertions, deletions } = allAdded("a\nb\n");
    expect(insertions).toBe(2);
    expect(deletions).toBe(0);
    expect(rows.every((r) => r.type === "added")).toBe(true);
  });
  it("allRemoved marks every line removed", () => {
    const { rows, insertions, deletions } = allRemoved("a\nb\n");
    expect(insertions).toBe(0);
    expect(deletions).toBe(2);
    expect(rows.every((r) => r.type === "removed")).toBe(true);
  });

  it("counts an empty added file as +0 while keeping the blank row", () => {
    const { rows, insertions, deletions } = allAdded("");
    expect(insertions).toBe(0);
    expect(deletions).toBe(0);
    expect(rows.map((r) => [r.type, r.text])).toEqual([["added", ""]]);
  });
  it("counts an empty removed file as -0 while keeping the blank row", () => {
    const { rows, insertions, deletions } = allRemoved("");
    expect(insertions).toBe(0);
    expect(deletions).toBe(0);
    expect(rows.map((r) => [r.type, r.text])).toEqual([["removed", ""]]);
  });

  it("rejects added or removed blobs above the rendered row limit", () => {
    const tooManyRows = Array.from({ length: MAX_RENDERED_DIFF_LINES + 1 }, (_, index) =>
      String(index)
    ).join("\n");

    expect(() => allAdded(tooManyRows)).toThrow(DiffTooLargeError);
    expect(() => allRemoved(tooManyRows)).toThrow(DiffTooLargeError);
  });
});
