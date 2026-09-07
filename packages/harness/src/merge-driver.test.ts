import { describe, expect, it, vi } from "vitest";
import type { VcsMergeResult, VcsStateNodeRef } from "@vibestudio/service-schemas/vcs";
import {
  driveMerge,
  MergeDriverError,
  renderCompareReview,
  renderMergeReview,
} from "./merge-driver.js";

const event = (eventId: string): VcsStateNodeRef => ({ kind: "event", eventId });
const application = (applicationId: string): VcsStateNodeRef => ({
  kind: "application",
  applicationId,
});
const counts = (adopt = 0, conflict = 0) => ({
  adopt,
  convergent: 0,
  composed: 0,
  conflict,
  resolved: 0,
});

function mergeResult(input: {
  commandId?: string;
  head: VcsStateNodeRef;
  remaining: number;
  adopt?: number;
  conflict?: number;
  status?: "working" | "unchanged";
}): VcsMergeResult {
  const review = {
    resolution: {
      complete: input.remaining === 0,
      remainingCoordinateCount: input.remaining,
      concluded: true,
    },
    counts: counts(input.adopt, input.conflict),
    intents: [],
    intentsTruncated: false,
    conflicts: [],
    nextConflictCursor: null,
  };
  if (input.status === "unchanged") {
    return { status: "unchanged", contextId: "ctx", workingHead: input.head, ...review };
  }
  return {
    status: "working",
    commandId: input.commandId ?? "command",
    contextId: "ctx",
    workUnitId: "work",
    applicationId:
      input.head.kind === "application" ? input.head.applicationId : "application:unexpected",
    changeCount: 0,
    changeIds: [],
    incorporatedChangeCount: 0,
    incorporatedChangeIds: [],
    decisionIds: ["decision"],
    workingHead: input.head,
    decisionId: "decision",
    outcomes: [],
    composed: [],
    ...review,
  };
}

describe("driveMerge", () => {
  it("drains clean pages without wrapper compares", async () => {
    const merge = vi
      .fn()
      .mockResolvedValueOnce(mergeResult({ head: application("a1"), remaining: 1, adopt: 1 }))
      .mockResolvedValueOnce(mergeResult({ head: application("a2"), remaining: 0 }));
    const compare = vi.fn();
    const result = await driveMerge({
      vcs: { merge, compare } as never,
      contextId: "ctx",
      expectedWorkingHead: event("base"),
      source: { kind: "event", eventId: "source" },
      commandIdForPage: ({ expectedWorkingHead }) => JSON.stringify(expectedWorkingHead),
    });
    expect(result.status).toBe("working");
    expect(merge).toHaveBeenCalledTimes(2);
    expect(compare).not.toHaveBeenCalled();
  });

  it("returns needs-decision for an unchanged concluded conflict", async () => {
    const head = application("a1");
    const merge = vi
      .fn()
      .mockResolvedValue(mergeResult({ head, remaining: 1, conflict: 1, status: "unchanged" }));
    const result = await driveMerge({
      vcs: { merge, compare: vi.fn() } as never,
      contextId: "ctx",
      expectedWorkingHead: head,
      source: { kind: "event", eventId: "source" },
      commandIdForPage: () => "command",
    });
    expect(result.status).toBe("needs-decision");
  });

  it("returns an already-concluded source as one unchanged merge", async () => {
    const head = event("source");
    const merge = vi
      .fn()
      .mockResolvedValue(mergeResult({ head, remaining: 0, status: "unchanged" }));
    const compare = vi.fn();
    const result = await driveMerge({
      vcs: { merge, compare } as never,
      contextId: "ctx",
      expectedWorkingHead: head,
      source: { kind: "event", eventId: "source" },
      commandIdForPage: () => "command",
    });
    expect(result.status).toBe("unchanged");
    expect(merge).toHaveBeenCalledTimes(1);
    expect(compare).not.toHaveBeenCalled();
  });

  it("stops after one explicitly selected coordinate page", async () => {
    const merge = vi
      .fn()
      .mockResolvedValue(mergeResult({ head: application("a1"), remaining: 8, adopt: 8 }));
    await driveMerge({
      vcs: { merge, compare: vi.fn() } as never,
      contextId: "ctx",
      expectedWorkingHead: event("base"),
      source: { kind: "event", eventId: "source" },
      coordinates: [{ kind: "file", id: "file:selected" }],
      commandIdForPage: () => "command",
    });
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it("preflights protected integration and never mutates when conflicts exist", async () => {
    const compare = vi.fn().mockResolvedValue({
      target: event("base"),
      source: { kind: "event", eventId: "source" },
      base: event("base"),
      resolution: { complete: false, remainingCoordinateCount: 1, concluded: false },
      counts: counts(0, 1),
      intentCounts: { merged: 0, settled: 0, split: 0, contested: 1, pending: 0 },
      coordinates: [],
      intents: [],
      intentsTruncated: false,
      nextCursor: null,
    });
    const merge = vi.fn();
    await expect(
      driveMerge({
        vcs: { merge, compare } as never,
        contextId: "ctx",
        expectedWorkingHead: event("base"),
        source: { kind: "event", eventId: "source" },
        policy: "require-conflict-free",
        commandIdForPage: () => "command",
      })
    ).rejects.toBeInstanceOf(MergeDriverError);
    expect(compare).toHaveBeenCalledWith(expect.objectContaining({ statusFilter: "conflict" }));
    expect(merge).not.toHaveBeenCalled();
  });

  it("uses one protected preflight before draining a clean source", async () => {
    const compare = vi.fn().mockResolvedValue({
      target: event("base"),
      source: { kind: "event", eventId: "source" },
      base: event("base"),
      resolution: { complete: false, remainingCoordinateCount: 2, concluded: false },
      counts: counts(2, 0),
      intentCounts: { merged: 0, settled: 0, split: 0, contested: 0, pending: 1 },
      coordinates: [],
      intents: [],
      intentsTruncated: false,
      nextCursor: null,
    });
    const merge = vi
      .fn()
      .mockResolvedValueOnce(mergeResult({ head: application("a1"), remaining: 1, adopt: 1 }))
      .mockResolvedValueOnce(mergeResult({ head: application("a2"), remaining: 0 }));
    await driveMerge({
      vcs: { merge, compare } as never,
      contextId: "ctx",
      expectedWorkingHead: event("base"),
      source: { kind: "event", eventId: "source" },
      policy: "require-conflict-free",
      commandIdForPage: () => "command",
    });
    expect(compare).toHaveBeenCalledTimes(1);
    expect(merge).toHaveBeenCalledTimes(2);
  });

  it("performs exactly one merge for an explicit coordinate page", async () => {
    const merge = vi
      .fn()
      .mockResolvedValue(mergeResult({ head: application("a1"), remaining: 3, adopt: 3 }));
    const result = await driveMerge({
      vcs: { merge, compare: vi.fn() } as never,
      contextId: "ctx",
      expectedWorkingHead: event("base"),
      source: { kind: "event", eventId: "source" },
      coordinates: [{ kind: "file", id: "file:one" }],
      commandIdForPage: () => "command",
    });
    // Global mergeable work remains, but the caller selected one page — the
    // driver must never continue into unrequested coordinates.
    expect(merge).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("working");
  });

  it("derives identical per-page command ids across a retry after partial progress", async () => {
    const pageIds: string[] = [];
    const commandIdForPage = ({ expectedWorkingHead }: { expectedWorkingHead: VcsStateNodeRef }) =>
      JSON.stringify(expectedWorkingHead);
    const failingMerge = vi
      .fn()
      .mockResolvedValueOnce(mergeResult({ head: application("a1"), remaining: 1, adopt: 1 }))
      .mockRejectedValueOnce(new Error("page two failed"));
    await expect(
      driveMerge({
        vcs: { merge: failingMerge, compare: vi.fn() } as never,
        contextId: "ctx",
        expectedWorkingHead: event("base"),
        source: { kind: "event", eventId: "source" },
        commandIdForPage: (page) => {
          const id = commandIdForPage(page);
          pageIds.push(id);
          return id;
        },
      })
    ).rejects.toBeInstanceOf(MergeDriverError);
    const retryIds: string[] = [];
    const retryMerge = vi
      .fn()
      .mockResolvedValueOnce(mergeResult({ head: application("a1"), remaining: 1, adopt: 1 }))
      .mockResolvedValueOnce(mergeResult({ head: application("a2"), remaining: 0 }));
    await driveMerge({
      vcs: { merge: retryMerge, compare: vi.fn() } as never,
      contextId: "ctx",
      expectedWorkingHead: event("base"),
      source: { kind: "event", eventId: "source" },
      commandIdForPage: (page) => {
        const id = commandIdForPage(page);
        retryIds.push(id);
        return id;
      },
    });
    // The retry replays the identical page identities (no attempt counter),
    // so already-landed durable decisions replay instead of forking.
    expect(retryIds.slice(0, pageIds.length)).toEqual(pageIds);
  });

  it("preserves completed pages through JSON serialization of the driver error", async () => {
    const merge = vi
      .fn()
      .mockResolvedValueOnce(mergeResult({ head: application("a1"), remaining: 1, adopt: 1 }))
      .mockRejectedValueOnce(new Error("page two failed"));
    const error = await driveMerge({
      vcs: { merge, compare: vi.fn() } as never,
      contextId: "ctx",
      expectedWorkingHead: event("base"),
      source: { kind: "event", eventId: "source" },
      commandIdForPage: () => "command",
    }).then(
      () => null,
      (thrown: MergeDriverError) => thrown
    );
    expect(error).toBeInstanceOf(MergeDriverError);
    // Tool boundaries serialize errorData as plain JSON; the completed page and
    // last review must survive that round-trip for the model to see them.
    const serialized = JSON.parse(
      JSON.stringify(error!.errorData)
    ) as MergeDriverError["errorData"];
    expect(serialized.code).toBe("MergeDriverError");
    expect(serialized.merges).toHaveLength(1);
    expect(serialized.merges[0]).toMatchObject({
      status: "working",
      workingHead: { kind: "application", applicationId: "a1" },
    });
    expect(serialized.review).toMatchObject({
      resolution: { remainingCoordinateCount: 1 },
    });
  });

  it("repeats a blanket resolution on every page", async () => {
    const merge = vi
      .fn()
      .mockResolvedValueOnce(mergeResult({ head: application("a1"), remaining: 1, adopt: 1 }))
      .mockResolvedValueOnce(mergeResult({ head: application("a2"), remaining: 0 }));
    const resolutions = { allRemaining: { resolution: "ours" as const } };
    await driveMerge({
      vcs: { merge, compare: vi.fn() } as never,
      contextId: "ctx",
      expectedWorkingHead: event("base"),
      source: { kind: "event", eventId: "source" },
      resolutions,
      commandIdForPage: () => "command",
    });
    expect(merge.mock.calls.map(([input]) => input.resolutions)).toEqual([
      resolutions,
      resolutions,
    ]);
  });

  it("sends coordinate resolutions once and intent on every page", async () => {
    const merge = vi
      .fn()
      .mockResolvedValueOnce(mergeResult({ head: application("a1"), remaining: 1, adopt: 1 }))
      .mockResolvedValueOnce(mergeResult({ head: application("a2"), remaining: 0 }));
    const resolutions = [
      { coordinate: { kind: "file" as const, id: "file:one" }, resolution: "ours" as const },
    ];
    await driveMerge({
      vcs: { merge, compare: vi.fn() } as never,
      contextId: "ctx",
      expectedWorkingHead: event("base"),
      source: { kind: "event", eventId: "source" },
      resolutions,
      intentSummary: "Integrate the reviewed source",
      commandIdForPage: () => "command",
    });
    expect(merge.mock.calls.map(([input]) => input.resolutions)).toEqual([resolutions, undefined]);
    expect(merge.mock.calls.map(([input]) => input.intentSummary)).toEqual([
      "Integrate the reviewed source",
      "Integrate the reviewed source",
    ]);
  });

  it("preserves completed pages and the last review when a later page fails", async () => {
    const merge = vi
      .fn()
      .mockResolvedValueOnce(mergeResult({ head: application("a1"), remaining: 1, adopt: 1 }))
      .mockRejectedValueOnce(new Error("second page unavailable"));
    await expect(
      driveMerge({
        vcs: { merge, compare: vi.fn() } as never,
        contextId: "ctx",
        expectedWorkingHead: event("base"),
        source: { kind: "event", eventId: "source" },
        commandIdForPage: () => "command",
      })
    ).rejects.toMatchObject({
      name: "MergeDriverError",
      errorData: {
        code: "MergeDriverError",
        merges: [expect.objectContaining({ workingHead: application("a1") })],
        review: expect.objectContaining({
          resolution: expect.objectContaining({ remainingCoordinateCount: 1 }),
        }),
      },
    });
  });

  it("fails when a working page leaves the head unmoved", async () => {
    const head = application("a1");
    const merge = vi.fn().mockResolvedValue(mergeResult({ head, remaining: 1, adopt: 1 }));
    await expect(
      driveMerge({
        vcs: { merge, compare: vi.fn() } as never,
        contextId: "ctx",
        expectedWorkingHead: head,
        source: { kind: "event", eventId: "source" },
        commandIdForPage: () => "command",
      })
    ).rejects.toMatchObject({
      name: "MergeDriverError",
      message: "Merge made no progress while mergeable coordinates remain",
    });
  });
});

describe("renderMergeReview", () => {
  it("deduplicates exact intent evidence without hiding side or state", () => {
    const text = renderMergeReview({
      headline: "Merge child",
      resolution: { complete: true, remainingCoordinateCount: 0, concluded: true },
      counts: counts(),
      intents: [
        {
          workUnitId: "work:one",
          side: "ours",
          state: "settled",
          intent: { tier: "trigger", text: "Build the task app" },
          coordinates: [],
        },
        {
          workUnitId: "work:two",
          side: "theirs",
          state: "merged",
          intent: { tier: "trigger", text: "Build the task app" },
          coordinates: [],
        },
        {
          workUnitId: "work:three",
          side: "ours",
          state: "settled",
          intent: { tier: "trigger", text: "Build the task app" },
          coordinates: [],
        },
      ],
      intentsTruncated: false,
      composed: [],
      conflicts: [],
      nextConflictCursor: null,
    });

    expect(text.match(/Build the task app/g)).toHaveLength(2);
    expect(text).toContain("Intent: ours/settled · trigger · Build the task app");
    expect(text).toContain("Intent: theirs/merged · trigger · Build the task app");
    expect(text).toContain("Integration: semantically complete");
    expect(text).toContain("remain local until the parent commits them");
  });
});

describe("renderCompareReview", () => {
  it("renders bounded coordinates and deduplicated intent evidence for every caller", () => {
    const text = renderCompareReview({
      target: event("target"),
      source: { kind: "event", eventId: "source" },
      base: event("base"),
      resolution: { complete: false, remainingCoordinateCount: 1, concluded: false },
      counts: counts(1),
      intentCounts: { merged: 0, settled: 0, split: 0, contested: 0, pending: 2 },
      coordinates: [
        {
          coordinate: {
            kind: "file",
            id: "file:one",
            paths: { theirs: "packages/example/index.ts" },
          },
          status: "adopt",
          aspects: [],
          attribution: { ours: [], theirs: [] },
          resolutions: ["theirs", "ours", "current"],
          summary: "adopt file packages/example/index.ts",
        },
      ],
      intents: [
        {
          workUnitId: "work:one",
          side: "theirs",
          state: "pending",
          intent: { tier: "stated", text: "Add the example" },
          coordinates: [{ kind: "file", id: "file:one" }],
        },
        {
          workUnitId: "work:two",
          side: "theirs",
          state: "pending",
          intent: { tier: "stated", text: "Add the example" },
          coordinates: [{ kind: "file", id: "file:one" }],
        },
      ],
      intentsTruncated: false,
      nextCursor: "cursor:next",
    });

    expect(text.match(/Intent: theirs\/pending · stated · Add the example/g)).toHaveLength(1);
    expect(text).toContain("Coordinate: file:file:one · adopt");
    expect(text).toContain("nextCursor=cursor:next");
  });
});
