/** Pure primitives for provenance-directed, net-effect workspace merges.
 *
 * The durable workspace owns state and provenance.  This module owns only the
 * deterministic algebra used after those facts have been projected into
 * stable coordinates.
 */

export type MergeCoordinateRef = { kind: "file"; id: string } | { kind: "repository"; id: string };

export type MergeAspect = "content" | "placement" | "mode" | "presence" | "path";

export interface MergeAspectInput {
  aspect: MergeAspect;
  base: unknown;
  ours: unknown;
  theirs: unknown;
  /** Values of disagreeing maximal bases. Presence forces a conflict. */
  baseValues?: readonly { eventId: string; value: unknown }[];
}

export type MergeAspectStatus = "adopt" | "convergent" | "composed" | "conflict" | "ours";

export interface TextMergeMapping {
  childStart: number;
  childEnd: number;
  parentStart: number;
  parentEnd: number;
}

export type ThreeWayTextMergeResult =
  | {
      kind: "composed";
      text: string;
      oursMappings: readonly TextMergeMapping[];
      theirsMappings: readonly TextMergeMapping[];
    }
  | { kind: "conflict" }
  | { kind: "too-large" };

interface Line {
  text: string;
  start: number;
  end: number;
}

interface LineHunk {
  baseStart: number;
  baseEnd: number;
  replacement: readonly Line[];
}

// Four million cells is 16 MiB for the Uint32Array.  Text outside this bound
// remains mergeable through an explicit resolution without risking an
// unbounded allocation in a durable workspace request.
const MAX_LCS_CELLS = 4_000_000;

const lines = (text: string): Line[] => {
  const result: Line[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    result.push({ text: text.slice(start, index + 1), start, end: index + 1 });
    start = index + 1;
  }
  if (start < text.length) result.push({ text: text.slice(start), start, end: text.length });
  return result;
};

const lcsMatrix = (
  left: readonly Line[],
  right: readonly Line[]
): { width: number; scores: Uint32Array } | null => {
  const width = right.length + 1;
  const cells = (left.length + 1) * width;
  if (!Number.isSafeInteger(cells) || cells > MAX_LCS_CELLS) return null;
  const scores = new Uint32Array(cells);
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      scores[leftIndex * width + rightIndex] =
        left[leftIndex]!.text === right[rightIndex]!.text
          ? 1 + scores[(leftIndex + 1) * width + rightIndex + 1]!
          : Math.max(
              scores[(leftIndex + 1) * width + rightIndex]!,
              scores[leftIndex * width + rightIndex + 1]!
            );
    }
  }
  return { width, scores };
};

/** Deterministic LCS edit script. Equal-score ties consume the base first. */
const hunks = (base: readonly Line[], side: readonly Line[]): LineHunk[] | null => {
  const matrix = lcsMatrix(base, side);
  if (!matrix) return null;
  const { width, scores: lcs } = matrix;
  const result: LineHunk[] = [];
  let left = 0;
  let right = 0;
  let pendingBaseStart: number | null = null;
  let pendingBaseEnd = 0;
  let replacement: Line[] = [];
  const flush = () => {
    if (pendingBaseStart === null) return;
    result.push({ baseStart: pendingBaseStart, baseEnd: pendingBaseEnd, replacement });
    pendingBaseStart = null;
    replacement = [];
  };
  while (left < base.length || right < side.length) {
    if (left < base.length && right < side.length && base[left]!.text === side[right]!.text) {
      flush();
      left += 1;
      right += 1;
      continue;
    }
    if (
      right < side.length &&
      (left === base.length || lcs[left * width + right + 1]! > lcs[(left + 1) * width + right]!)
    ) {
      pendingBaseStart ??= left;
      pendingBaseEnd = left;
      replacement.push(side[right]!);
      right += 1;
    } else {
      pendingBaseStart ??= left;
      left += 1;
      pendingBaseEnd = left;
    }
  }
  flush();
  return result;
};

const overlaps = (left: LineHunk, right: LineHunk): boolean => {
  const leftInsertion = left.baseStart === left.baseEnd;
  const rightInsertion = right.baseStart === right.baseEnd;
  if (leftInsertion && rightInsertion) return left.baseStart === right.baseStart;
  if (leftInsertion) return left.baseStart > right.baseStart && left.baseStart < right.baseEnd;
  if (rightInsertion) return right.baseStart > left.baseStart && right.baseStart < left.baseEnd;
  return left.baseStart < right.baseEnd && right.baseStart < left.baseEnd;
};

const pushMapping = (
  mappings: TextMergeMapping[],
  childStart: number,
  childEnd: number,
  parentStart: number,
  parentEnd: number
) => {
  if (childStart === childEnd || parentStart === parentEnd) return;
  const previous = mappings.at(-1);
  if (previous && previous.childEnd === childStart && previous.parentEnd === parentStart) {
    previous.childEnd = childEnd;
    previous.parentEnd = parentEnd;
  } else {
    mappings.push({ childStart, childEnd, parentStart, parentEnd });
  }
};

/** Map only text that is byte-for-byte inherited from a parent. */
const preservedLineMappings = (
  child: readonly Line[],
  parent: readonly Line[]
): TextMergeMapping[] | null => {
  const matrix = lcsMatrix(child, parent);
  if (!matrix) return null;
  const { width, scores: lcs } = matrix;
  const mappings: TextMergeMapping[] = [];
  let childIndex = 0;
  let parentIndex = 0;
  while (childIndex < child.length && parentIndex < parent.length) {
    if (child[childIndex]!.text === parent[parentIndex]!.text) {
      pushMapping(
        mappings,
        child[childIndex]!.start,
        child[childIndex]!.end,
        parent[parentIndex]!.start,
        parent[parentIndex]!.end
      );
      childIndex += 1;
      parentIndex += 1;
    } else if (
      lcs[childIndex * width + parentIndex + 1]! > lcs[(childIndex + 1) * width + parentIndex]!
    ) {
      parentIndex += 1;
    } else {
      childIndex += 1;
    }
  }
  return mappings;
};

/** Compose non-overlapping line edits. Overlap is deliberately conservative. */
export function threeWayTextMerge(
  baseText: string,
  oursText: string,
  theirsText: string
): ThreeWayTextMergeResult {
  if (oursText === theirsText) {
    const extent = oursText.length;
    return {
      kind: "composed",
      text: oursText,
      oursMappings: extent
        ? [{ childStart: 0, childEnd: extent, parentStart: 0, parentEnd: extent }]
        : [],
      theirsMappings: extent
        ? [{ childStart: 0, childEnd: extent, parentStart: 0, parentEnd: extent }]
        : [],
    };
  }
  if (oursText === baseText) {
    const extent = theirsText.length;
    return {
      kind: "composed",
      text: theirsText,
      oursMappings: [],
      theirsMappings: extent
        ? [{ childStart: 0, childEnd: extent, parentStart: 0, parentEnd: extent }]
        : [],
    };
  }
  if (theirsText === baseText) {
    const extent = oursText.length;
    return {
      kind: "composed",
      text: oursText,
      oursMappings: extent
        ? [{ childStart: 0, childEnd: extent, parentStart: 0, parentEnd: extent }]
        : [],
      theirsMappings: [],
    };
  }
  const base = lines(baseText);
  const ours = lines(oursText);
  const theirs = lines(theirsText);
  const oursHunks = hunks(base, ours);
  const theirsHunks = hunks(base, theirs);
  if (!oursHunks || !theirsHunks) return { kind: "too-large" };
  for (const oursHunk of oursHunks) {
    for (const theirsHunk of theirsHunks) {
      if (!overlaps(oursHunk, theirsHunk)) continue;
      if (
        oursHunk.baseStart === theirsHunk.baseStart &&
        oursHunk.baseEnd === theirsHunk.baseEnd &&
        oursHunk.replacement.map((line) => line.text).join("") ===
          theirsHunk.replacement.map((line) => line.text).join("")
      ) {
        continue;
      }
      return { kind: "conflict" };
    }
  }

  const all = [
    ...oursHunks.map((hunk) => ({ ...hunk, side: "ours" as const })),
    ...theirsHunks.map((hunk) => ({ ...hunk, side: "theirs" as const })),
  ].sort(
    (left, right) =>
      left.baseStart - right.baseStart ||
      left.baseEnd - right.baseEnd ||
      (left.side === right.side ? 0 : left.side === "ours" ? -1 : 1)
  );
  const deduped = all.filter(
    (hunk, index) =>
      !all
        .slice(0, index)
        .some(
          (prior) =>
            prior.baseStart === hunk.baseStart &&
            prior.baseEnd === hunk.baseEnd &&
            prior.replacement.map((line) => line.text).join("") ===
              hunk.replacement.map((line) => line.text).join("")
        )
  );
  let baseCursor = 0;
  let text = "";
  for (const hunk of deduped) {
    const unchanged = base
      .slice(baseCursor, hunk.baseStart)
      .map((line) => line.text)
      .join("");
    text += unchanged;
    const replacement = hunk.replacement.map((line) => line.text).join("");
    text += replacement;
    baseCursor = hunk.baseEnd;
  }
  const tail = base
    .slice(baseCursor)
    .map((line) => line.text)
    .join("");
  text += tail;
  const child = lines(text);
  const oursMappings = preservedLineMappings(child, ours);
  const theirsMappings = preservedLineMappings(child, theirs);
  if (!oursMappings || !theirsMappings) return { kind: "too-large" };
  return { kind: "composed", text, oursMappings, theirsMappings };
}

export function classifyMergeAspect(
  input: MergeAspectInput,
  contentMerge?: ThreeWayTextMergeResult
): MergeAspectStatus {
  if (input.baseValues && input.baseValues.length > 1) return "conflict";
  const oursChanged = !Object.is(input.base, input.ours);
  const theirsChanged = !Object.is(input.base, input.theirs);
  if (!theirsChanged) return "ours";
  if (!oursChanged) return "adopt";
  if (Object.is(input.ours, input.theirs)) return "convergent";
  if (input.aspect === "content" && contentMerge?.kind === "composed") return "composed";
  return "conflict";
}
