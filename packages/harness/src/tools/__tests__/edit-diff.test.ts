import { describe, it, expect } from "vitest";
import {
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  normalizeForFuzzyMatch,
  fuzzyFindText,
  stripBom,
  differingTextEdits,
  generateDiffString,
  findUniqueText,
} from "../edit-diff.js";

describe("edit-diff", () => {
  describe("detectLineEnding", () => {
    it("returns LF for files with only \\n", () => {
      expect(detectLineEnding("a\nb\nc")).toBe("\n");
    });

    it("returns CRLF when CR comes before LF", () => {
      expect(detectLineEnding("a\r\nb")).toBe("\r\n");
    });
  });

  describe("normalize / restore line endings", () => {
    it("round-trips through LF and CRLF", () => {
      const original = "a\r\nb\r\nc";
      const lf = normalizeToLF(original);
      expect(lf).toBe("a\nb\nc");
      expect(restoreLineEndings(lf, "\r\n")).toBe(original);
    });
  });

  describe("normalizeForFuzzyMatch", () => {
    it("strips trailing whitespace per line", () => {
      expect(normalizeForFuzzyMatch("foo  \nbar")).toBe("foo\nbar");
    });

    it("normalises smart quotes / dashes / NBSPs", () => {
      const input = "It\u2019s a \u2014 test\u00A0case"; // curly apostrophe, em-dash, NBSP
      expect(normalizeForFuzzyMatch(input)).toBe("It's a - test case");
    });
  });

  describe("fuzzyFindText", () => {
    it("returns exact match when present", () => {
      const result = fuzzyFindText("foo bar baz", "bar");
      expect(result.found).toBe(true);
      expect(result.usedFuzzyMatch).toBe(false);
      expect(result.index).toBe(4);
    });

    it("falls back to fuzzy match", () => {
      const content = "say \u201chello\u201d world"; // smart quotes
      const result = fuzzyFindText(content, '"hello"');
      expect(result.found).toBe(true);
      expect(result.usedFuzzyMatch).toBe(true);
      expect(result.contentForReplacement).toBe(content);
      expect(content.slice(result.index, result.index + result.matchLength)).toBe(
        "\u201chello\u201d"
      );
    });

    it("maps a multiline fuzzy match back across stripped trailing whitespace", () => {
      const content = "before\nfirst  \r\nsecond\nafter";
      const result = fuzzyFindText(content, "first\nsecond");
      expect(result).toMatchObject({ found: true, usedFuzzyMatch: true, index: 7 });
      expect(content.slice(result.index, result.index + result.matchLength)).toBe(
        "first  \r\nsecond"
      );
    });

    it("rejects an empty old string instead of inventing insertion coordinates", () => {
      expect(fuzzyFindText("content", "")).toMatchObject({ found: false, index: -1 });
    });

    it("returns not-found when no match", () => {
      const result = fuzzyFindText("foo bar", "xyz");
      expect(result.found).toBe(false);
    });
  });

  describe("findUniqueText", () => {
    it("prefers a unique exact match over other normalized equivalents", () => {
      const content = 'first: “value”\nsecond: "value"\n';
      expect(findUniqueText(content, 'second: "value"')).toMatchObject({
        found: true,
        ambiguous: false,
        matchMode: "exact",
        candidateLines: [2],
      });
    });

    it("reports exact ambiguity with bounded candidate locations", () => {
      expect(findUniqueText("same\nother\nsame\n", "same")).toMatchObject({
        found: false,
        ambiguous: true,
        matchMode: "exact",
        matchCount: 2,
        candidateLines: [1, 3],
      });
    });

    it("maps one normalized match back to the untouched source coordinates", () => {
      const content = "before\r\nStatus: “before”  \r\nafter\r\n";
      const result = findUniqueText(content, 'Status: "before"');
      expect(result).toMatchObject({
        found: true,
        ambiguous: false,
        matchMode: "normalized",
        candidateLines: [2],
      });
      expect(content.slice(result.index, result.index + result.matchLength)).toBe(
        "Status: “before”"
      );
    });

    it("refuses ambiguous normalized matches", () => {
      expect(findUniqueText('“same”\n"same"  \n', "'same'")).toMatchObject({
        found: false,
        ambiguous: false,
        matchCount: 0,
      });
      expect(findUniqueText("“same”\n“same”\n", '"same"')).toMatchObject({
        found: false,
        ambiguous: true,
        matchMode: "normalized",
        matchCount: 2,
        candidateLines: [1, 2],
      });
    });
  });

  describe("stripBom", () => {
    it("strips a leading BOM", () => {
      const r = stripBom("\uFEFFhello");
      expect(r.bom).toBe("\uFEFF");
      expect(r.text).toBe("hello");
    });

    it("returns empty bom when not present", () => {
      const r = stripBom("hello");
      expect(r.bom).toBe("");
      expect(r.text).toBe("hello");
    });
  });

  describe("generateDiffString", () => {
    it("emits +/- markers for added and removed lines", () => {
      const diff = generateDiffString("a\nb\nc", "a\nB\nc");
      expect(diff.diff).toContain("-");
      expect(diff.diff).toContain("+");
      expect(diff.firstChangedLine).toBe(2);
    });
  });

  describe("differingTextEdits", () => {
    it("keeps unchanged selection context out of authored edit ranges", () => {
      expect(
        differingTextEdits(
          'export const value = "baseline";\nexport const neighbor = "untouched";\n',
          'export const value = "edited";\nexport const neighbor = "untouched";\n'
        )
      ).toEqual([{ start: 22, end: 30, text: "edited" }]);
    });

    it("emits separate edits when unchanged content separates changes", () => {
      expect(differingTextEdits("alpha\nmiddle\nomega\n", "ALPHA\nmiddle\nOMEGA\n")).toEqual([
        { start: 0, end: 5, text: "ALPHA" },
        { start: 13, end: 18, text: "OMEGA" },
      ]);
    });
  });
});
