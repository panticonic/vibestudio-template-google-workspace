import { describe, it, expect } from "vitest";
import {
  formatSize,
  truncateHead,
  truncateTail,
  truncateLine,
  GREP_MAX_LINE_LENGTH,
} from "../truncate.js";

describe("truncate", () => {
  describe("formatSize", () => {
    it("formats bytes / KB / MB", () => {
      expect(formatSize(512)).toBe("512B");
      expect(formatSize(2048)).toBe("2.0KB");
      expect(formatSize(2 * 1024 * 1024)).toBe("2.0MB");
    });
  });

  describe("truncateHead", () => {
    it("returns full content when within limits", () => {
      const r = truncateHead("a\nb\nc");
      expect(r.truncated).toBe(false);
      expect(r.content).toBe("a\nb\nc");
    });

    it("truncates by line count", () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
      const r = truncateHead(lines, { maxLines: 3 });
      expect(r.truncated).toBe(true);
      expect(r.truncatedBy).toBe("lines");
      expect(r.outputLines).toBe(3);
    });

    it("truncates by byte count", () => {
      const r = truncateHead("a\nbb\nccc", { maxBytes: 4 });
      expect(r.truncated).toBe(true);
      expect(r.truncatedBy).toBe("bytes");
    });

    it("flags first-line-exceeds-limit", () => {
      const r = truncateHead("very long single line here", { maxBytes: 5 });
      expect(r.firstLineExceedsLimit).toBe(true);
      expect(r.content).toBe("");
    });
  });

  describe("truncateTail", () => {
    it("keeps the tail of content", () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
      const r = truncateTail(lines, { maxLines: 3 });
      expect(r.outputLines).toBe(3);
      expect(r.content.endsWith("line 9")).toBe(true);
    });
  });

  describe("truncateLine", () => {
    it("returns input unchanged when below limit", () => {
      expect(truncateLine("hello").wasTruncated).toBe(false);
    });

    it("truncates with [truncated] suffix when over limit", () => {
      const long = "x".repeat(GREP_MAX_LINE_LENGTH + 100);
      const r = truncateLine(long);
      expect(r.wasTruncated).toBe(true);
      expect(r.text.endsWith("... [truncated]")).toBe(true);
    });
  });
});
