import { describe, it, expect } from "vitest";
import { resolveToCwd, expandPath } from "../path-utils.js";

describe("path-utils", () => {
  it("resolveToCwd: relative path joined with cwd", () => {
    expect(resolveToCwd("foo.txt", "/work/ctx")).toBe("/work/ctx/foo.txt");
    expect(resolveToCwd("./sub/bar", "/work/ctx")).toBe("/work/ctx/sub/bar");
  });

  it("resolveToCwd: absolute-looking paths are scoped to the virtual workspace", () => {
    expect(resolveToCwd("/abs/path.md", "/work/ctx")).toBe("/work/ctx/abs/path.md");
    expect(resolveToCwd("/workspace", "/work/ctx")).toBe("/work/ctx");
    expect(resolveToCwd("/workspace/packages/runtime", "/work/ctx")).toBe(
      "/work/ctx/packages/runtime",
    );
    expect(resolveToCwd("workspace", "/work/ctx")).toBe("/work/ctx");
    expect(resolveToCwd("workspace/packages/runtime", "/work/ctx")).toBe(
      "/work/ctx/packages/runtime",
    );
    expect(resolveToCwd("/work/ctx/already-resolved", "/work/ctx")).toBe(
      "/work/ctx/already-resolved",
    );
  });

  it("resolveToCwd: strips @ prefix", () => {
    expect(resolveToCwd("@foo.txt", "/work/ctx")).toBe("/work/ctx/foo.txt");
  });

  it("expandPath: normalises unicode whitespace", () => {
    // U+00A0 NBSP between words should become a regular space.
    const input = "foo\u00A0bar.txt";
    expect(expandPath(input)).toBe("foo bar.txt");
  });
});
