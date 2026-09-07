import { describe, it, expect } from "vitest";
import { summarizeToolResult, truncateResult } from "./action-data.js";

describe("summarizeToolResult", () => {
  it("returns string result truncated to 300 chars", () => {
    const short = "hello world";
    expect(summarizeToolResult(short)).toBe(short);

    const long = "x".repeat(500);
    expect(summarizeToolResult(long)).toBe("x".repeat(300));
  });

  it('returns "Done" for null/undefined', () => {
    expect(summarizeToolResult(null)).toBe("Done");
    expect(summarizeToolResult(undefined)).toBe("Done");
  });

  it("extracts text from array of content blocks", () => {
    const blocks = [
      { type: "text", text: "file contents here" },
      { type: "text", text: "more text" },
    ];
    expect(summarizeToolResult(blocks)).toBe("file contents here; more text");
  });

  it("extracts text from { content: [...] } object shape", () => {
    const result = {
      content: [{ type: "text", text: "inner text" }],
      details: { some: "meta" },
    };
    expect(summarizeToolResult(result)).toBe("inner text");
  });

  it("handles image blocks", () => {
    const blocks = [{ type: "image", mimeType: "image/png" }];
    expect(summarizeToolResult(blocks)).toBe("Image (image/png)");
  });

  it("handles mixed content", () => {
    const blocks = [
      { type: "text", text: "screenshot attached" },
      { type: "image", mimeType: "image/jpeg" },
    ];
    expect(summarizeToolResult(blocks)).toBe("screenshot attached; Image (image/jpeg)");
  });

  it("falls back to stringified JSON for other objects", () => {
    const result = { foo: "bar" };
    expect(summarizeToolResult(result)).toBe('{"foo":"bar"}');
  });
});

describe("truncateResult", () => {
  it("passes through null/undefined", () => {
    expect(truncateResult(null)).toEqual({ value: null, truncated: false });
    expect(truncateResult(undefined)).toEqual({ value: undefined, truncated: false });
  });

  it("passes through small results", () => {
    const result = { data: "hello" };
    expect(truncateResult(result)).toEqual({ value: result, truncated: false });
  });

  it("passes through small string results", () => {
    const result = "short string";
    expect(truncateResult(result)).toEqual({ value: result, truncated: false });
  });

  it("truncates large string results preserving a useful prefix", () => {
    const result = "x".repeat(50_000);
    const { value, truncated } = truncateResult(result);
    expect(truncated).toBe(true);
    expect(typeof value).toBe("string");
    // Should keep 8000 chars + truncation notice, not collapse to 300-char summary
    expect((value as string).length).toBeGreaterThan(1000);
    expect((value as string)).toContain("truncated");
  });

  it("preserves structure for large objects with long strings", () => {
    const result = { data: "x".repeat(50_000), meta: { count: 42 } };
    const { value, truncated } = truncateResult(result);
    expect(truncated).toBe(true);
    // Should preserve object structure, not collapse to summary string
    expect(typeof value).toBe("object");
    const obj = value as Record<string, unknown>;
    expect(obj["meta"]).toEqual({ count: 42 });
    expect(typeof obj["data"]).toBe("string");
    expect((obj["data"] as string)).toContain("truncated");
  });

  it("passes through results under 32KB", () => {
    const result = { data: "x".repeat(20_000) };
    const { value, truncated } = truncateResult(result);
    expect(truncated).toBe(false);
    expect(value).toBe(result); // same reference
  });

  it("handles non-serializable results (circular refs) without throwing", () => {
    const circular: Record<string, unknown> = { name: "test" };
    circular["self"] = circular;
    const { value, truncated } = truncateResult(circular);
    expect(truncated).toBe(true);
    expect(typeof value).toBe("string");
  });
});

describe("summarizeToolResult edge cases", () => {
  it("handles non-serializable results without throwing", () => {
    const circular: Record<string, unknown> = { name: "test" };
    circular["self"] = circular;
    const result = summarizeToolResult(circular);
    expect(typeof result).toBe("string");
  });
});
