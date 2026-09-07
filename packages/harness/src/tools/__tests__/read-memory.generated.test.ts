import { describe, expect, it } from "vitest";
import type { VcsReadMemoryEpisode, VcsReadMemoryResult } from "@vibestudio/service-schemas/vcs";
import { READ_MEMORY_RENDER_BUDGET, renderReadMemoryBlock } from "../read-memory.js";

const HASH = "a".repeat(64);

function episode(
  index: number,
  overrides: Partial<VcsReadMemoryEpisode> = {}
): VcsReadMemoryEpisode {
  const start = index * 17;
  return {
    ranges: [{ start, end: start + 9 }],
    stop: "authored",
    change: { kind: "change", changeId: `change:${index}` },
    appliedChange: { kind: "applied-change", appliedChangeId: `applied-change:${index}` },
    workUnit: { kind: "work-unit", workUnitId: `work-unit:${index}` },
    command: { kind: "command", commandId: `command:${index}` },
    changeKind: "text-edit",
    counteractsChangeIds: [],
    intent: { text: `Keep invariant ${index} owned by its caller`, tier: "stated" },
    authorContextId: `context:${index}`,
    createdAt: `2026-07-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
    externalSnapshot: null,
    commit: null,
    arrival: null,
    ...overrides,
  };
}

function attached(overrides: Partial<Extract<VcsReadMemoryResult, { status: "attached" }>> = {}) {
  return {
    status: "attached" as const,
    state: { kind: "event" as const, eventId: "event:read" },
    repositoryId: "repository:fixture",
    fileId: "file:fixture",
    path: "packages/fixture/src/memory.ts",
    contentHash: HASH,
    range: { start: 0, end: 120 },
    coordinateKind: "utf16" as const,
    episodes: [],
    history: [],
    rejectionCount: 0,
    truncated: false,
    ...overrides,
  } satisfies Extract<VcsReadMemoryResult, { status: "attached" }>;
}

function render(result: Extract<VcsReadMemoryResult, { status: "attached" }>): string | null {
  return renderReadMemoryBlock({
    label: "packages/fixture/src/memory.ts",
    content: Array.from({ length: 220 }, (_, index) => `line ${index + 1}`).join("\n"),
    readingContextId: "context:reader",
    startLine: 4,
    endLine: 9,
    result,
  });
}

describe("generated read-memory renderer corpus", () => {
  it("renders a deterministic, compact corpus of authored and imported blame episodes", () => {
    const episodes = Array.from({ length: 12 }, (_, index) =>
      episode(index, {
        ranges:
          index === 2
            ? [
                { start: 34, end: 36 },
                // UTF-16 positions deliberately straddle a surrogate-pair-sized gap.
                { start: 38, end: 43 },
              ]
            : [{ start: index * 17, end: index * 17 + 9 }],
        stop: index % 3 === 0 ? "import-boundary" : "authored",
        intent: {
          tier: "stated",
          text:
            index === 5
              ? `  Preserve   a whitespace-normalized invariant ${"x".repeat(400)}  `
              : `Keep generated invariant ${index} intact`,
        },
        counteractsChangeIds: index % 4 === 0 ? [`change:prior:${index}`] : [],
        commit:
          index % 2 === 0
            ? {
                event: { kind: "event", eventId: `event:commit:${index}` },
                message: `Commit preserves invariant ${index}`,
                createdAt: "2026-07-22T10:01:00.000Z",
              }
            : null,
        arrival:
          index % 3 === 1
            ? {
                decision: { kind: "decision", decisionId: `decision:${index}` },
                resolution: "composed",
                rationale: `Reconcile generated branch ${index}`,
                mode: "arrived",
                parentIntents:
                  index === 1
                    ? [
                        {
                          workUnitId: "work-unit:source",
                          role: "source",
                          intent: { text: "Tighten retry behavior", tier: "trigger" },
                        },
                        {
                          workUnitId: "work-unit:current",
                          role: "current",
                          intent: { text: "Migrate configuration", tier: "stated" },
                        },
                      ]
                    : [],
              }
            : null,
        externalSnapshot:
          index % 3 === 0
            ? {
                sourceKind: "git",
                sourceUri: `https://example.test/library-${index}.git`,
                snapshotRevision: `revision-${index}`,
                sourceSubdir: null,
                canonicalSnapshot: `v1-sha256:${"c".repeat(64)}`,
                snapshotDigest: `snapshot:${index}`,
                targetRepositoryIds: ["repository:fixture"],
              }
            : null,
      })
    );
    const result = attached({
      episodes,
      history: Array.from({ length: 8 }, (_, index) => ({
        node: { kind: "event" as const, eventId: `event:history:${index}` },
        createdAt: "2026-07-23T10:00:00.000Z",
        summary: `History ${index}`,
      })),
      truncated: true,
    });

    const first = render(result);
    const second = render(result);

    expect(first).toBe(second);
    expect(first!.length).toBeLessThanOrEqual(READ_MEMORY_RENDER_BUDGET);
    expect(first).toContain(
      "why packages/fixture/src/memory.ts lines 4-9 exist · verified against this exact content"
    );
    expect(first).toContain("● lines ");
    expect(first).toContain("imported from outside workspace history");
    expect(first).toContain("counteracts change");
    expect(first).not.toContain("change:prior:0");
    expect(first).toContain('committed as "Commit preserves invariant 0"');
    expect(first).toContain("arrived via merge decision");
    expect(first).not.toContain("decision:1");
    expect(first).toContain('source trigger: "Tighten retry behavior"');
    expect(first).toContain('composed with yours stated: "Migrate configuration"');
    expect(first).toContain("earlier file history");
    expect(first).toContain("truncated to the render budget");
    expect(first).toContain(
      'dig deeper · provenance({"target":"packages/fixture/src/memory.ts","walk":"cause"})'
    );
    expect(first).toContain("…");
    expect(first).not.toContain("  Preserve   a whitespace");

    const lines = first?.split("\n") ?? [];
    expect(lines.filter((line) => line.startsWith("● lines ")).length).toBeGreaterThan(0);
    expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(8);
    expect(first!.match(/dig deeper/gu)).toHaveLength(1);
  });

  it("keeps intent and commit evidence in separate labeled slots", () => {
    const output = render(
      attached({
        episodes: [
          episode(1, {
            intent: { text: "edit fixture.ts", tier: "mechanical" },
            commit: {
              event: { kind: "event", eventId: "event:commit" },
              message: "Commit message is the semantic fallback",
              createdAt: "2026-07-22T10:01:00.000Z",
            },
          }),
          episode(2, {
            intent: { text: "asked by user: update the fixture", tier: "trigger" },
            commit: null,
          }),
          episode(3, {
            intent: { text: "edit fixture.ts", tier: "mechanical" },
            commit: null,
          }),
        ],
      })
    );

    expect(output).toContain('mechanical: "edit fixture.ts"');
    expect(output).toContain('committed as "Commit message is the semantic fallback"');
    expect(output).toContain('trigger: "asked by user: update the fixture"');
    expect(output).not.toContain('stated: "Commit message is the semantic fallback"');
    expect(output).not.toContain("committed as null");
    expect(output).not.toContain("original request null");
  });

  it("does not create an empty provenance block, but preserves history-only memory", () => {
    expect(render(attached())).toBeNull();

    const historyOnly = render(
      attached({
        history: [
          {
            node: { kind: "event", eventId: "event:history-only" },
            createdAt: null,
            summary: "A prior commit still explains this file",
          },
        ],
      })
    );
    expect(historyOnly).toContain("verified against this exact content");
    expect(historyOnly).toContain("A prior commit still explains this file");
    expect(historyOnly).not.toContain("inspect deeper with provenance");
  });

  it("renders compact provenance refs when the caller retains exact roots", () => {
    const byKind = new Map<string, number>();
    const output = renderReadMemoryBlock({
      label: "packages/fixture/src/memory.ts",
      content: "one\ntwo\nthree",
      readingContextId: "context:reader",
      startLine: 1,
      endLine: 3,
      result: attached({ episodes: [episode(0)] }),
      reference: (value) => {
        const ordinal = (byKind.get(value.kind) ?? 0) + 1;
        byKind.set(value.kind, ordinal);
        return `@r${ordinal}-${value.kind.slice(0, 4).padEnd(4, "0")}`;
      },
    });

    expect(output).toContain("work unit work-unit @r1-work");
    expect(output).toContain("change change @r1-chan");
    expect(output).toContain('dig deeper · provenance({"target":"@r1-file","walk":"cause"})');
    expect(output).toContain("continue: pass any @ref back as target");
    expect(output).not.toContain('"workUnitId"');
    expect(output).not.toContain('"fileId"');
  });

  it("collapses the reading context's own episode without dropping its intent", () => {
    const output = renderReadMemoryBlock({
      label: "packages/fixture/src/memory.ts",
      content: "one\ntwo\nthree",
      readingContextId: "context:self",
      startLine: 1,
      endLine: 3,
      result: attached({
        episodes: [
          episode(0, {
            authorContextId: "context:self",
            intent: { text: "Keep the invariant explicit", tier: "stated" },
            counteractsChangeIds: ["change:old"],
            commit: {
              event: { kind: "event", eventId: "event:self" },
              message: "implementation detail",
              createdAt: "2026-07-22T10:01:00.000Z",
            },
          }),
        ],
      }),
    });
    expect(output).toContain('yours · stated: "Keep the invariant explicit"');
    expect(output).not.toContain("counteracts");
    expect(output).not.toContain("committed as");
  });
});

describe("negative evidence on the ordinary read path", () => {
  const episodes = [
    episode(0, {
      ranges: [{ start: 0, end: 9 }],
      intent: { tier: "stated", text: "Cap the export batch size at 64" },
    }),
  ];

  it("says so when the coordinate carries rejected work, with the move to make", () => {
    // An agent has to suspect a rejection exists before it can ask for one, so
    // the suspicion travels with the bytes it is already reading.
    const rendered = render(attached({ episodes, rejectionCount: 2 })) ?? "";
    expect(rendered).toContain("2 earlier attempts at this file were undone");
    expect(rendered).toContain('"walk":"rejections"');
  });

  it("stays silent when there is nothing to warn about", () => {
    // An unconditional hint is noise, and noise teaches agents to skip the line.
    const rendered = render(attached({ episodes, rejectionCount: 0 })) ?? "";
    expect(rendered).not.toContain("undone");
    expect(rendered).not.toContain('"walk":"rejections"');
  });
});
