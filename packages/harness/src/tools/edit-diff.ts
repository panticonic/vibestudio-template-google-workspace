/**
 * Shared diff computation utilities for the edit tool.
 *
 * Ported from pi-coding-agent's `dist/core/tools/edit-diff.js`. Pure logic.
 * The `computeEditDiff` helper is omitted because it required `fs/promises`
 * directly — the workerd port reads through `RuntimeFs` instead and the
 * preview path simply re-runs `fuzzyFindText` + `generateDiffString`.
 */

import * as Diff from "diff";

export type LineEnding = "\r\n" | "\n";

export function detectLineEnding(content: string): LineEnding {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: LineEnding): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Strips trailing whitespace per line and
 * normalises smart quotes / dashes / unicode spaces to ASCII equivalents so
 * the LLM doesn't fail edits over invisible character substitutions.
 */
export function normalizeForFuzzyMatch(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

export interface FuzzyMatchResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
  contentForReplacement: string;
}

export interface UniqueTextMatch {
  found: boolean;
  ambiguous: boolean;
  index: number;
  matchLength: number;
  matchMode?: "exact" | "normalized";
  matchCount: number;
  candidateLines: number[];
  contentForReplacement: string;
}

interface NormalizedMatchSpace {
  text: string;
  /** Original UTF-16 start/end for every UTF-16 code unit in `text`. */
  starts: number[];
  ends: number[];
}

function normalizeMatchCharacter(value: string): string {
  if (/[\u2018\u2019\u201A\u201B]/u.test(value)) return "'";
  if (/[\u201C\u201D\u201E\u201F]/u.test(value)) return '"';
  if (/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/u.test(value)) return "-";
  if (/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/u.test(value)) return " ";
  return value;
}

/**
 * Build the forgiving comparison space together with an exact mapping back to
 * the caller's original UTF-16 coordinates. Normalization is only an index;
 * the normalized text must never become the base of a write.
 */
function normalizedMatchSpace(value: string): NormalizedMatchSpace {
  const text: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    let lineEnd = cursor;
    while (lineEnd < value.length && value[lineEnd] !== "\r" && value[lineEnd] !== "\n") {
      lineEnd += 1;
    }
    let keptEnd = lineEnd;
    while (keptEnd > cursor && /\s/u.test(value[keptEnd - 1]!)) keptEnd -= 1;
    for (let index = cursor; index < keptEnd; index += 1) {
      text.push(normalizeMatchCharacter(value[index]!));
      starts.push(index);
      ends.push(index + 1);
    }
    if (lineEnd >= value.length) break;
    const newlineEnd =
      value[lineEnd] === "\r" && value[lineEnd + 1] === "\n" ? lineEnd + 2 : lineEnd + 1;
    text.push("\n");
    starts.push(lineEnd);
    ends.push(newlineEnd);
    cursor = newlineEnd;
  }
  return { text: text.join(""), starts, ends };
}

/**
 * Try an exact match first; if that fails, fall back to a fuzzy match in
 * the normalised character space. A fuzzy result is mapped back to the exact
 * original coordinates; `contentForReplacement` is always the original input.
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  if (oldText.length === 0) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  const fuzzyContent = normalizedMatchSpace(content);
  const fuzzyOldText = normalizedMatchSpace(oldText).text;
  const fuzzyIndex = fuzzyContent.text.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  const originalStart = fuzzyContent.starts[fuzzyIndex];
  const originalEnd = fuzzyContent.ends[fuzzyIndex + fuzzyOldText.length - 1];
  if (originalStart === undefined || originalEnd === undefined) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }
  return {
    found: true,
    index: originalStart,
    matchLength: originalEnd - originalStart,
    usedFuzzyMatch: true,
    contentForReplacement: content,
  };
}

function occurrenceIndexes(content: string, query: string): number[] {
  if (!query) return [];
  const indexes: number[] = [];
  for (let at = content.indexOf(query); at >= 0; ) {
    indexes.push(at);
    at = content.indexOf(query, at + Math.max(1, query.length));
  }
  return indexes;
}

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/**
 * Resolve one deterministic edit span. Exact bytes win when they identify one
 * site. Only when no exact site exists do we compare normalized line endings,
 * trailing whitespace, smart punctuation, and Unicode spaces. Normalization is
 * an index only: the returned coordinates always address the original text.
 */
export function findUniqueText(content: string, oldText: string): UniqueTextMatch {
  if (!oldText) {
    return {
      found: false,
      ambiguous: false,
      index: -1,
      matchLength: 0,
      matchCount: 0,
      candidateLines: [],
      contentForReplacement: content,
    };
  }

  const exact = occurrenceIndexes(content, oldText);
  if (exact.length === 1) {
    return {
      found: true,
      ambiguous: false,
      index: exact[0]!,
      matchLength: oldText.length,
      matchMode: "exact",
      matchCount: 1,
      candidateLines: [lineAt(content, exact[0]!)],
      contentForReplacement: content,
    };
  }
  if (exact.length > 1) {
    return {
      found: false,
      ambiguous: true,
      index: -1,
      matchLength: 0,
      matchMode: "exact",
      matchCount: exact.length,
      candidateLines: exact.slice(0, 20).map((index) => lineAt(content, index)),
      contentForReplacement: content,
    };
  }

  const normalizedContent = normalizedMatchSpace(content);
  const normalizedOldText = normalizedMatchSpace(oldText).text;
  const normalized = occurrenceIndexes(normalizedContent.text, normalizedOldText);
  if (normalized.length !== 1) {
    return {
      found: false,
      ambiguous: normalized.length > 1,
      index: -1,
      matchLength: 0,
      ...(normalized.length > 1 ? { matchMode: "normalized" as const } : {}),
      matchCount: normalized.length,
      candidateLines: normalized
        .slice(0, 20)
        .map((index) => lineAt(content, normalizedContent.starts[index] ?? 0)),
      contentForReplacement: content,
    };
  }

  const normalizedIndex = normalized[0]!;
  const originalStart = normalizedContent.starts[normalizedIndex];
  const originalEnd = normalizedContent.ends[normalizedIndex + normalizedOldText.length - 1];
  if (originalStart === undefined || originalEnd === undefined) {
    return {
      found: false,
      ambiguous: false,
      index: -1,
      matchLength: 0,
      matchCount: 0,
      candidateLines: [],
      contentForReplacement: content,
    };
  }
  return {
    found: true,
    ambiguous: false,
    index: originalStart,
    matchLength: originalEnd - originalStart,
    matchMode: "normalized",
    matchCount: 1,
    candidateLines: [lineAt(content, originalStart)],
    contentForReplacement: content,
  };
}

/** Strip a UTF-8 BOM if present, returning the BOM and the rest. */
export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

export interface DiffResult {
  diff: string;
  firstChangedLine: number | undefined;
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * Express the actual differing UTF-16 ranges between two texts.
 *
 * An agent may include unchanged surrounding lines in oldText/newText to make
 * a match unique. Those anchors are selection context, not authored content.
 * Emitting only changed character runs keeps their existing provenance.
 */
export function differingTextEdits(oldContent: string, newContent: string): TextEdit[] {
  const edits: TextEdit[] = [];
  let oldOffset = 0;
  let pending: { start: number; oldText: string; newText: string } | null = null;
  const flush = () => {
    if (!pending) return;
    let prefix = 0;
    while (
      prefix < pending.oldText.length &&
      prefix < pending.newText.length &&
      pending.oldText[prefix] === pending.newText[prefix]
    ) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < pending.oldText.length - prefix &&
      suffix < pending.newText.length - prefix &&
      pending.oldText[pending.oldText.length - 1 - suffix] ===
        pending.newText[pending.newText.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    edits.push({
      start: pending.start + prefix,
      end: pending.start + pending.oldText.length - suffix,
      text: pending.newText.slice(prefix, pending.newText.length - suffix),
    });
    pending = null;
  };

  for (const part of Diff.diffLines(oldContent, newContent)) {
    if (!part.added && !part.removed) {
      flush();
      oldOffset += part.value.length;
      continue;
    }
    pending ??= { start: oldOffset, oldText: "", newText: "" };
    if (part.removed) {
      pending.oldText += part.value;
      oldOffset += part.value.length;
    } else {
      pending.newText += part.value;
    }
  }
  flush();
  return edits;
}

/**
 * Build a unified-style diff with right-padded line numbers and a small
 * amount of context around each change. Returns the diff and the new-file
 * line number of the first change so the chat UI can deep-link to it.
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4
): DiffResult {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") {
      raw.pop();
    }
    if (part.added || part.removed) {
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum;
      }
      for (const line of raw) {
        if (part.added) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
          output.push(`+${lineNum} ${line}`);
          newLineNum++;
        } else {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(`-${lineNum} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      const nextPartIsChange =
        i < parts.length - 1 && (parts[i + 1]!.added || parts[i + 1]!.removed);
      if (lastWasChange || nextPartIsChange) {
        let linesToShow = raw;
        let skipStart = 0;
        let skipEnd = 0;
        if (!lastWasChange) {
          skipStart = Math.max(0, raw.length - contextLines);
          linesToShow = raw.slice(skipStart);
        }
        if (!nextPartIsChange && linesToShow.length > contextLines) {
          skipEnd = linesToShow.length - contextLines;
          linesToShow = linesToShow.slice(0, contextLines);
        }
        if (skipStart > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skipStart;
          newLineNum += skipStart;
        }
        for (const line of linesToShow) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
        if (skipEnd > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skipEnd;
          newLineNum += skipEnd;
        }
      } else {
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }
      lastWasChange = false;
    }
  }

  return { diff: output.join("\n"), firstChangedLine };
}
