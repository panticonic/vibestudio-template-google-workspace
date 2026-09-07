/**
 * Rendering economics, at the points where measurement showed the plan's own
 * laws were not actually applied.
 */
import { describe, expect, it } from "vitest";
import type { VcsWalkResult } from "@vibestudio/service-schemas/vcs";
import {
  renderProvenanceBlock,
  renderWalkBlock,
  type CanonicalProvenanceResult,
} from "../provenance-format.js";

let sequence = 0;
const reference = (): string => `@r${(sequence += 1).toString(36)}-0000`;

const REQUEST =
  "Please cap the export batch size at 64. The Pelagic relay drops any export payload above " +
  "512 KiB, and each record is roughly eight kilobytes once serialized, so anything larger " +
  "silently loses the tail of the batch instead of failing loudly. Keep it below that ceiling " +
  "even if throughput suffers, and say so in a comment so the next person does not raise it.";

function causeWalk(): VcsWalkResult {
  return {
    walk: "cause",
    scope: null,
    subject: { kind: "work-unit", workUnitId: "work-unit:1" },
    entries: [
      {
        node: { kind: "work-unit", workUnitId: "work-unit:1" },
        label: "work unit · edit",
        depth: 0,
        intent: { tier: "stated", text: "Add export batch size constant" },
        statement: { text: REQUEST, sender: "user" },
      },
      {
        node: {
          kind: "trajectory-message",
          logId: "trajectory:1",
          head: "main",
          messageId: "message:1",
        },
        label: "message · user from user",
        depth: 1,
        statement: { text: REQUEST, sender: "user" },
        boundary: "human-statement",
      },
    ],
    omitted: [],
    notes: [],
    nextCursor: null,
  };
}

describe("walk rendering", () => {
  it("renders the originating statement in full rather than as a mention", () => {
    const rendered = renderWalkBlock({ label: "src/export-batching.ts", result: causeWalk(), reference });
    // The reason lives past the 160 characters an incidental mention gets, which
    // is exactly why Q2 could reach the human statement and still not answer it.
    expect(rendered).toContain("512 KiB");
    expect(rendered).toContain("silently loses the tail");
    expect(rendered).toContain("← the originating human statement");
  });

  it("keeps the requester's words beside an author's summary", () => {
    const rendered = renderWalkBlock({ label: "work", result: causeWalk(), reference });
    expect(rendered).toContain('stated: "Add export batch size constant"');
    expect(rendered).toContain("asked by user:");
  });
});

describe("adjacency rendering", () => {
  it("counts a repeated relation instead of listing every target", () => {
    const edges: CanonicalProvenanceResult["edges"] = Array.from({ length: 9 }, (_, index) => ({
      kind: "contains-repository" as const,
      from: { kind: "event" as const, eventId: "event:commit" },
      to: {
        kind: "repository" as const,
        repositoryId: `repository:${index}`,
        state: { kind: "event" as const, eventId: "event:commit" },
      },
    }));
    const rendered =
      renderProvenanceBlock({
        label: "commit",
        result: { root: { kind: "event", eventId: "event:commit" }, edges, nextCursor: null },
        reference,
      }) ?? "";
    const listed = rendered.split("\n").filter((line) => line.includes("—contains-repository→"));
    expect(listed.length).toBeLessThanOrEqual(3);
    expect(rendered).toContain("and 7 more —contains-repository→ repository");
  });

  it("still lists a relation with only one target", () => {
    const rendered =
      renderProvenanceBlock({
        label: "commit",
        result: {
          root: { kind: "event", eventId: "event:commit" },
          edges: [
            {
              kind: "caused-by",
              from: { kind: "event", eventId: "event:commit" },
              to: { kind: "command", commandId: "command:1" },
            },
          ],
          nextCursor: null,
        },
        reference,
      }) ?? "";
    expect(rendered).toContain("—caused-by→");
    expect(rendered).not.toContain("more —caused-by→");
  });
});

describe("rejection rendering", () => {
  const rejections = {
    walk: "rejections" as const,
    scope: null,
    subject: { kind: "file" as const, state: { kind: "event" as const, eventId: "event:1" }, repositoryId: "repository:1", fileId: "file:1" },
    entries: [
      {
        node: { kind: "work-unit" as const, workUnitId: "work-unit:undo" },
        label: "undone · edit src/retry-policy.ts",
        depth: 0,
        group: "counteractions",
        intent: { tier: "stated" as const, text: "staging cut the link before the retry fired" },
      },
    ],
    omitted: [],
    notes: [],
    nextCursor: null,
  };

  it("carries the reading rule with the evidence, since the skill teaching it is rarely open", () => {
    const rendered = renderWalkBlock({ label: "src/retry-policy.ts", result: rejections, reference });
    expect(rendered).toContain("a rejection is evidence about a property, not about a coordinate");
  });

  it("says nothing when there is nothing rejected to misread", () => {
    const rendered = renderWalkBlock({
      label: "src/retry-policy.ts",
      result: { ...rejections, entries: [], notes: ["Nothing has been rejected at this coordinate in your visible basis."] },
      reference,
    });
    expect(rendered).not.toContain("a rejection is evidence about a property");
  });
});
