import { describe, expect, it } from "vitest";
import {
  renderProvenanceBlock,
  type CanonicalProvenanceInspection,
  type CanonicalProvenanceResult,
} from "../provenance-format.js";

/** Refs are the only identity the model ever sees, so tests render with one. */
function render(inspection: CanonicalProvenanceInspection): string {
  const result: CanonicalProvenanceResult = {
    root: inspection.root,
    edges: [],
    nextCursor: null,
  };
  let sequence = 0;
  return (
    renderProvenanceBlock({
      label: "inspection",
      inspection,
      result,
      reference: () => `@r${(sequence += 1).toString(36)}-0000`,
    }) ?? ""
  );
}

/** No rendered block may contain a raw content-addressed identity. */
function expectNoRawIdentity(rendered: string, identities: readonly string[]): void {
  for (const identity of identities) {
    if (rendered.includes(identity)) {
      throw new Error(`rendered block leaked the identity ${identity}`);
    }
  }
}

describe("provenance formatting", () => {
  it("makes a sole event application directly inspectable", () => {
    const root = { kind: "event" as const, eventId: "event:import" };
    const rendered = render({
      root,
      node: {
        kind: "event",
        value: {
          eventId: root.eventId,
          workspaceId: "workspace:test",
          commandId: "command:import",
          parentEventIds: ["event:base"],
          applicationIds: ["application:import"],
          decisionIds: [],
          kind: "commit",
          message: "Import project",
          createdAt: "2026-07-15T10:00:00.000Z",
          semanticProtocol: "semantic:test",
          workspaceFactRootId: "workspace-facts:import",
        },
      },
      edges: [],
      hasMoreEdges: false,
    });

    expect(rendered).toMatch(/inspect sole application → @r[0-9a-z]+-0000/u);
    expectNoRawIdentity(rendered, ["application:import", "command:import"]);
  });

  it("makes exact external evidence visible on its owning import work unit", () => {
    const root = { kind: "work-unit" as const, workUnitId: "work:import" };
    const rendered = render({
      root,
      node: {
        kind: "work-unit",
        value: {
          workUnitId: root.workUnitId,
          commandId: "command:import",
          kind: "import",
          authoredChangeCount: 243,
          authoredChangeIds: ["change:repo", "change:file"],
          incorporatedChangeCount: 0,
          incorporatedChangeIds: [],
          decisionCount: 0,
          decisionIds: [],
          intent: { text: "import external snapshot", tier: "mechanical" },
          intentSummary: null,
          authorContextId: "context:import",
          triggerEvidence: null,
          externalSnapshot: {
            sourceKind: "git",
            sourceUri: "https://example.test/owner/project.git",
            snapshotRevision: "0123456789abcdef",
            sourceSubdir: null,
            canonicalSnapshot: `v1-sha256:${"c".repeat(64)}`,
            snapshotDigest: "snapshot:derived",
            targetRepositoryIds: ["repository:one", "repository:two"],
          },
          contentClass: "external",
          externalKeys: ["repo:https://example.test/owner/project.git@0123456789abcdef"],
          normalizationProtocol: "normalization:test",
          createdAt: "2026-07-15T10:00:00.000Z",
        },
      },
      edges: [],
      hasMoreEdges: false,
    });

    expect(rendered).toContain("243 authored changes (2 in preview)");
    expect(rendered).toContain("2 target repositories");
    expect(rendered).toContain("https://example.test/owner/project.git");
    expect(rendered).toContain("0123456789abcdef");
    expect(rendered).toContain("pre-import coordinate authorship unknown");
    expect(rendered).toMatch(/command @r[0-9a-z]+-0000/u);
    expectNoRawIdentity(rendered, [
      "work:import",
      "command:import",
      "snapshot:derived",
      "repository:one",
    ]);
  });

  it("renders an imported file as an ordinary change without duplicating snapshot evidence", () => {
    const root = { kind: "change" as const, changeId: "change:imported-file" };
    const rendered = render({
      root,
      node: {
        kind: "change",
        value: {
          changeId: root.changeId,
          authoredByWorkUnitId: "work:import",
          operation: 0,
          kind: "content-replace",
          effects: [
            {
              kind: "content",
              fileId: "file:readme",
              beforeContentHash: "blob:before",
              afterContentHash: "blob:after",
            },
          ],
          counteractsChangeIds: [],
          effectDigest: "effect:imported-file",
          normalizationProtocol: "normalization:test",
        },
      },
      edges: [],
      hasMoreEdges: false,
    });

    expect(rendered).toMatch(/change · content-replace · work-unit @r[0-9a-z]+-0000/u);
    expect(rendered).not.toContain("external snapshot");
    expectNoRawIdentity(rendered, ["work:import", "change:imported-file", "effect:imported-file"]);
  });

  it("uses exact totals while naming the bounded application preview", () => {
    const root = { kind: "application" as const, applicationId: "application:import" };
    const rendered = render({
      root,
      node: {
        kind: "application",
        value: {
          applicationId: root.applicationId,
          workUnitId: "work:import",
          basis: { kind: "event", eventId: "event:base" },
          appliedChangeCount: 243,
          appliedChanges: [],
          resultWorkspaceFactRootId: "projection:result",
          semanticProtocol: "semantic:test",
        },
      },
      edges: [],
      hasMoreEdges: false,
    });

    expect(rendered).toContain("243 applied changes (0 in preview)");
    expect(rendered).toMatch(/inspect owning work → @r[0-9a-z]+-0000/u);
    expectNoRawIdentity(rendered, ["work:import", "application:import", "event:base"]);
  });

  it("renders an applied change as a reusable basis-specific graph node", () => {
    const root = {
      kind: "applied-change" as const,
      appliedChangeId: "applied-change:target",
    };
    const rendered = render({
      root,
      node: {
        kind: "applied-change",
        value: {
          appliedChangeId: root.appliedChangeId,
          applicationId: "application:target",
          changeId: "change:source",
          ordinal: 2,
          appliedEffects: [
            {
              kind: "mode",
              fileId: "file:readme",
              beforeMode: 0o644,
              afterMode: 0o755,
            },
          ],
          resultPredicate: null,
        },
      },
      edges: [],
      hasMoreEdges: false,
    });

    expect(rendered).toMatch(
      /applied-change · application @r[0-9a-z]+-0000 · change @r[0-9a-z]+-0000 · ordinal 2 · 1 effect/u
    );
    expectNoRawIdentity(rendered, ["application:target", "change:source", "applied-change:target"]);
  });
});
