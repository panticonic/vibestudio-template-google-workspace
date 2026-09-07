import type {
  VcsCompareResult,
  VcsMergeCoordinateRef,
  VcsMergeInput,
  VcsMergeResult,
  VcsMergeSource,
  VcsStateNodeRef,
} from "@vibestudio/service-schemas/vcs";
import type { ToolVcs } from "./tools/tool-vcs.js";

export interface MergeReview {
  headline: string;
  sourceHeadline?: string;
  resolution: VcsMergeResult["resolution"];
  counts: VcsMergeResult["counts"];
  intents: VcsMergeResult["intents"];
  intentsTruncated: boolean;
  composed: Extract<VcsMergeResult, { status: "working" }>["composed"];
  conflicts: VcsMergeResult["conflicts"];
  nextConflictCursor: string | null;
}

export interface DriveMergeInput {
  vcs: Pick<ToolVcs, "merge" | "compare">;
  contextId: string;
  expectedWorkingHead: VcsStateNodeRef;
  source: VcsMergeSource;
  coordinates?: VcsMergeCoordinateRef[];
  resolutions?: VcsMergeInput["resolutions"];
  intentSummary?: string;
  headline?: string;
  commandIdForPage: (page: { expectedWorkingHead: VcsStateNodeRef }) => string;
  policy?: "merge-clean" | "require-conflict-free";
}

export interface DriveMergeResult {
  status: "working" | "unchanged" | "needs-decision";
  initialWorkingHead: VcsStateNodeRef;
  workingHead: VcsStateNodeRef;
  merges: VcsMergeResult[];
  review: MergeReview;
}

export class MergeDriverError extends Error {
  readonly code = "MergeDriverError";
  readonly errorData: {
    code: "MergeDriverError";
    merges: VcsMergeResult[];
    review: MergeReview | null;
  };

  constructor(
    message: string,
    merges: VcsMergeResult[],
    review: MergeReview | null,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = "MergeDriverError";
    this.errorData = { code: "MergeDriverError", merges, review };
  }
}

const sameState = (left: VcsStateNodeRef, right: VcsStateNodeRef): boolean =>
  left.kind === right.kind &&
  (left.kind === "event"
    ? left.eventId === (right as Extract<VcsStateNodeRef, { kind: "event" }>).eventId
    : left.applicationId ===
      (right as Extract<VcsStateNodeRef, { kind: "application" }>).applicationId);

const sourceLabel = (source: VcsCompareResult["source"]): string =>
  source.kind === "event"
    ? source.eventId
    : source.kind === "application"
      ? source.applicationId
      : source.deltaId;

function sourceHeadline(intents: VcsMergeResult["intents"]): string | undefined {
  return intents.find((entry) => entry.side === "theirs" && entry.intent.tier === "trigger")?.intent
    .text;
}

function reviewFromResult(
  result: VcsMergeResult,
  composed: MergeReview["composed"],
  headline: string
): MergeReview {
  return {
    headline,
    ...(sourceHeadline(result.intents) ? { sourceHeadline: sourceHeadline(result.intents) } : {}),
    resolution: result.resolution,
    counts: result.counts,
    intents: result.intents,
    intentsTruncated: result.intentsTruncated,
    composed,
    conflicts: result.conflicts,
    nextConflictCursor: result.nextConflictCursor,
  };
}

function reviewFromCompare(result: VcsCompareResult, headline: string): MergeReview {
  return {
    headline,
    resolution: result.resolution,
    counts: result.counts,
    intents: result.intents,
    intentsTruncated: result.intentsTruncated,
    composed: [],
    conflicts: result.coordinates,
    nextConflictCursor: result.nextCursor,
  };
}

export async function driveMerge(input: DriveMergeInput): Promise<DriveMergeResult> {
  const startedAt = performance.now();
  const policy = input.policy ?? "merge-clean";
  const headline = input.headline ?? `Merge ${sourceLabel(input.source)}`;
  const merges: VcsMergeResult[] = [];
  const composed = new Map<string, MergeReview["composed"][number]>();
  let head = input.expectedWorkingHead;
  let review: MergeReview | null = null;
  let compareCalls = 0;

  try {
    if (policy === "require-conflict-free") {
      compareCalls += 1;
      const preflight = await input.vcs.compare({
        target: head,
        source: input.source,
        statusFilter: "conflict",
        limit: 500,
      });
      if (preflight.counts.conflict > 0) {
        review = reviewFromCompare(preflight, headline);
        throw new MergeDriverError(
          renderMergeReview(review),
          merges,
          review
        );
      }
    }

    for (;;) {
      const blanket = input.resolutions && !Array.isArray(input.resolutions);
      const result = await input.vcs.merge({
        contextId: input.contextId,
        expectedWorkingHead: head,
        commandId: input.commandIdForPage({ expectedWorkingHead: head }),
        source: input.source,
        ...(input.coordinates ? { coordinates: input.coordinates } : {}),
        ...(input.resolutions && (merges.length === 0 || blanket)
          ? { resolutions: input.resolutions }
          : {}),
        ...(input.intentSummary ? { intentSummary: input.intentSummary } : {}),
      });
      merges.push(result);
      if (result.status === "working") {
        for (const entry of result.composed) {
          composed.set(`${entry.coordinate.kind}:${entry.coordinate.id}`, entry);
        }
      }
      review = reviewFromResult(result, [...composed.values()], headline);
      const nextHead = result.workingHead;
      const mergeable = result.counts.adopt + result.counts.composed + result.counts.convergent;

      if (input.coordinates) {
        return {
          status: result.resolution.complete
            ? result.status
            : mergeable === 0
              ? "needs-decision"
              : result.status,
          initialWorkingHead: input.expectedWorkingHead,
          workingHead: nextHead,
          merges,
          review,
        };
      }
      if (result.resolution.complete) {
        return {
          status: sameState(input.expectedWorkingHead, nextHead) ? "unchanged" : "working",
          initialWorkingHead: input.expectedWorkingHead,
          workingHead: nextHead,
          merges,
          review,
        };
      }
      if (mergeable === 0) {
        return {
          status: "needs-decision",
          initialWorkingHead: input.expectedWorkingHead,
          workingHead: nextHead,
          merges,
          review,
        };
      }
      if (result.status !== "working" || sameState(head, nextHead)) {
        throw new Error("Merge made no progress while mergeable coordinates remain");
      }
      head = nextHead;
    }
  } catch (error) {
    if (error instanceof MergeDriverError) throw error;
    throw new MergeDriverError(
      error instanceof Error ? error.message : String(error),
      merges,
      review,
      error
    );
  } finally {
    const totalMs = performance.now() - startedAt;
    if (totalMs >= 100) {
      console.info("[MergeDriverProfile] merge procedure", {
        policy,
        totalMs,
        mergeCalls: merges.length,
        compareCalls,
      });
    }
  }
}

export function renderMergeReview(review: MergeReview): string {
  const lines = [
    review.headline,
    `Resolution: complete=${review.resolution.complete}; concluded=${review.resolution.concluded}; remaining=${review.resolution.remainingCoordinateCount}.`,
    `Coordinates: ${review.counts.adopt} adopt, ${review.counts.convergent} convergent, ${review.counts.composed} composed, ${review.counts.conflict} conflict, ${review.counts.resolved} resolved.`,
  ];
  if (review.sourceHeadline) lines.push(`Source: ${review.sourceHeadline}`);
  const renderedIntents = new Set<string>();
  for (const intent of review.intents) {
    if (
      intent.side === "theirs" &&
      intent.intent.tier === "trigger" &&
      intent.intent.text === review.sourceHeadline
    )
      continue;
    const key = `${intent.side}\u0000${intent.state ?? ""}\u0000${intent.intent.tier}\u0000${intent.intent.text}`;
    if (renderedIntents.has(key)) continue;
    renderedIntents.add(key);
    lines.push(
      `Intent: ${intent.side}${intent.state ? `/${intent.state}` : ""} · ${intent.intent.tier} · ${intent.intent.text}`
    );
  }
  if (review.intentsTruncated)
    lines.push("Intent projection is truncated; structured details contain the bounded projection.");
  for (const entry of review.composed) {
    lines.push(
      `Composed: ${entry.coordinate.kind}:${entry.coordinate.id} · ours: ${entry.ours.text} · theirs: ${entry.theirs.text}`
    );
  }
  for (const conflict of review.conflicts) {
    lines.push(
      `Conflict: ${conflict.coordinate.kind}:${conflict.coordinate.id} · ${conflict.summary} · resolutions: ${conflict.resolutions.join("/")}`
    );
  }
  if (review.nextConflictCursor) {
    lines.push(
      `More conflicts: nextConflictCursor=${review.nextConflictCursor}; continue compare with the same source and this cursor.`
    );
  }
  if (review.resolution.complete && review.resolution.concluded) {
    lines.push(
      "Integration: semantically complete. The parent workspace may still be dirty because integrated changes remain local until the parent commits them."
    );
  }
  return lines.join("\n");
}

/** One intent-aware presentation for every semantic comparison surface. */
export function renderCompareReview(result: VcsCompareResult): string {
  const counts = result.counts;
  const lines = [
    result.resolution.complete
      ? `Comparison is complete${result.resolution.concluded ? " and semantically concluded" : " but has not been concluded by a merge decision"}.`
      : `Comparison has ${result.resolution.remainingCoordinateCount} remaining coordinate${result.resolution.remainingCoordinateCount === 1 ? "" : "s"}.`,
    `Source ${sourceLabel(result.source)}: ${counts.adopt} adopt, ${counts.convergent} convergent, ${counts.composed} composed, ${counts.conflict} conflict, ${counts.resolved} resolved.`,
  ];
  const renderedIntents = new Set<string>();
  for (const intent of result.intents) {
    const key = `${intent.side}\u0000${intent.state ?? ""}\u0000${intent.intent.tier}\u0000${intent.intent.text}`;
    if (renderedIntents.has(key)) continue;
    renderedIntents.add(key);
    lines.push(
      `Intent: ${intent.side}${intent.state ? `/${intent.state}` : ""} · ${intent.intent.tier} · ${intent.intent.text}`
    );
  }
  if (result.intentsTruncated) {
    lines.push(
      "Intent projection is truncated; structured details contain the bounded projection."
    );
  }
  for (const coordinate of result.coordinates) {
    lines.push(
      `Coordinate: ${coordinate.coordinate.kind}:${coordinate.coordinate.id} · ${coordinate.status} · ${coordinate.summary}`
    );
  }
  if (result.nextCursor) {
    lines.push(
      `More coordinates: nextCursor=${result.nextCursor}; continue compare with the same source and this cursor.`
    );
  }
  return lines.join("\n");
}
