import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { createMemoryAgentReferenceStore } from "../agent-pagination.js";
import { putProvenanceReference } from "../provenance-reference.js";
import {
  createProvenanceTool,
  type ProvenanceToolDeps,
  type ProvenanceToolDetails,
  type ProvenanceToolDiagnostic,
} from "../provenance.js";

const working = { kind: "event" as const, eventId: "event:working" };

function detailsOf(result: {
  details: ProvenanceToolDetails | ProvenanceToolDiagnostic;
}): ProvenanceToolDetails {
  if ("diagnostic" in result.details) {
    throw new Error(`Expected provenance details, received ${result.details.diagnostic}`);
  }
  return result.details;
}

function fixture() {
  const status = vi.fn(async () => ({
    contextId: "context:1",
    committed: working,
    workingHead: working,
    clean: true,
    mainEventId: "event:main",
    mainRelation: "at" as const,
    workingCounts: { applications: 0, workUnits: 0, changes: 0 },
    integrating: [],
  }));
  const neighbors = vi.fn(async (input: Parameters<ProvenanceToolDeps["vcs"]["neighbors"]>[0]) => {
    if (input.root.kind === "event") {
      return {
        root: input.root,
        edges: [
          {
            kind: "contains-repository" as const,
            from: input.root,
            to: {
              kind: "repository" as const,
              state: input.root,
              repositoryId: "repository:packages/foo",
            },
          },
        ],
        nextCursor: null,
      };
    }
    if (input.root.kind === "work-unit") {
      return {
        root: input.root,
        edges: [
          {
            kind: "authored-change" as const,
            from: input.root,
            to: { kind: "change" as const, changeId: "change:1" },
          },
        ],
        nextCursor: "cursor:next",
      };
    }
    if (input.root.kind === "applied-change") {
      return {
        root: input.root,
        edges: [
          {
            kind: "realizes-change" as const,
            from: input.root,
            to: { kind: "change" as const, changeId: "change:1" },
          },
        ],
        nextCursor: null,
      };
    }
    if (input.root.kind === "command") {
      if (input.root.commandId === "command:direct") {
        return { root: input.root, edges: [], nextCursor: null };
      }
      return {
        root: input.root,
        edges: [
          {
            kind: "caused-by" as const,
            from: input.root,
            to: {
              kind: "trajectory-invocation" as const,
              logId: "log:1",
              head: "head:1",
              invocationId: "invocation:1",
            },
          },
        ],
        nextCursor: null,
      };
    }
    if (input.root.kind === "trajectory-invocation") {
      return {
        root: input.root,
        edges: [
          {
            kind: "part-of-turn" as const,
            from: input.root,
            to: {
              kind: "trajectory-turn" as const,
              logId: input.root.logId,
              head: input.root.head,
              turnId: "turn:1",
            },
          },
          {
            kind: "part-of-trajectory" as const,
            from: input.root,
            to: { kind: "trajectory" as const, logId: input.root.logId, head: input.root.head },
          },
        ],
        nextCursor: null,
      };
    }
    if (input.root.kind === "trajectory-turn") {
      return {
        root: input.root,
        edges: [
          {
            kind: "triggered-by" as const,
            from: input.root,
            to: {
              kind: "trajectory-message" as const,
              logId: input.root.logId,
              head: input.root.head,
              messageId: "message:prompt",
            },
          },
        ],
        nextCursor: null,
      };
    }
    if (input.root.kind === "trajectory-message") {
      return {
        root: input.root,
        edges: [
          {
            kind: "triggered-by" as const,
            from: {
              kind: "trajectory-turn" as const,
              logId: input.root.logId,
              head: input.root.head,
              turnId: "turn:1",
            },
            to: input.root,
          },
        ],
        nextCursor: null,
      };
    }
    return {
      root: input.root,
      edges: [
        {
          kind: "caused-by" as const,
          from: input.root,
          to: { kind: "command" as const, commandId: "command:1" },
        },
      ],
      nextCursor: "cursor:next",
    };
  });
  const inspect = vi.fn(
    async (
      input: Parameters<ProvenanceToolDeps["vcs"]["inspect"]>[0]
    ): ReturnType<ProvenanceToolDeps["vcs"]["inspect"]> => {
      const common = { root: input.node, edges: [], hasMoreEdges: false };
      switch (input.node.kind) {
        case "external-delta":
          return {
            ...common,
            node: {
              kind: "external-delta" as const,
              value: {
                deltaId: input.node.deltaId,
                workUnitId: "work-unit:external",
                repositoryId: "repository:foo",
                repoPath: "packages/foo",
                oldSnapshot: `snapshot:${"1".repeat(64)}`,
                newSnapshot: `snapshot:${"2".repeat(64)}`,
                changeCount: 1,
                changeIds: ["change:external"],
                status: "active" as const,
              },
            },
          };
        case "repository":
          return {
            ...common,
            node: {
              kind: "repository" as const,
              state: input.node.state,
              value: {
                kind: "present" as const,
                repositoryId: input.node.repositoryId,
                repoPath: "packages/foo",
                manifestId: "manifest:1",
              },
            },
          };
        case "file":
          return {
            ...common,
            node: {
              kind: "file" as const,
              state: input.node.state,
              value: {
                kind: "placed" as const,
                fileId: input.node.fileId,
                repositoryId: input.node.repositoryId,
                path: "bar.ts",
                contentHash: "blob:1",
                mode: 0o644,
                contentKind: "text" as const,
                byteLength: 7,
                coordinateExtent: 7,
              },
            },
          };
        case "trajectory":
          return { ...common, node: { kind: "trajectory" as const, value: input.node } };
        case "work-unit":
          return {
            ...common,
            node: {
              kind: "work-unit" as const,
              value: {
                workUnitId: input.node.workUnitId,
                commandId: "command:1",
                kind: "edit" as const,
                authoredChangeCount: 1,
                authoredChangeIds: ["change:1"],
                incorporatedChangeCount: 0,
                incorporatedChangeIds: [],
                decisionCount: 0,
                decisionIds: [],
                intent: { text: "Rename the public entry point", tier: "stated" as const },
                intentSummary: "Rename the public entry point",
                authorContextId: "context:1",
                triggerEvidence: null,
                externalSnapshot: null,
                contentClass: "internal" as const,
                externalKeys: [],
                normalizationProtocol: "normalization:1",
                createdAt: "2026-07-15T10:00:00.000Z",
              },
            },
          };
        case "command":
          return {
            ...common,
            node: {
              kind: "command" as const,
              value: {
                commandId: input.node.commandId,
                workspaceId: "workspace:1",
                contextId: "context:1",
                method: "vcs.edit",
                status: "complete" as const,
                result: { kind: "work-unit" as const, workUnitId: "work-unit:1" },
                createdAt: "2026-07-15T10:00:00.000Z",
                completedAt: "2026-07-15T10:00:01.000Z",
              },
            },
          };
        case "trajectory-invocation":
          return {
            ...common,
            node: {
              kind: "trajectory-invocation" as const,
              value: {
                logId: input.node.logId,
                head: input.node.head,
                invocationId: input.node.invocationId,
                turnId: "turn:1",
                name: "provenance",
                status: "complete",
                terminalOutcome: "success",
                requestRef: {
                  protocol: "vibestudio.blob-ref.v1",
                  digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  size: 48,
                  encoding: "json",
                  originalBytes: 48,
                },
                startedEventId: "trajectory-event:start",
                completedEventId: "trajectory-event:complete",
              },
            },
          };
        case "trajectory-turn":
          return {
            ...common,
            node: {
              kind: "trajectory-turn" as const,
              value: {
                logId: input.node.logId,
                head: input.node.head,
                turnId: input.node.turnId,
                triggerMessageId: "message:prompt",
                openedAt: "2026-07-15T10:00:00.000Z",
                closedAt: "2026-07-15T10:00:01.000Z",
                summary: "Move the parser without losing its identity",
                ordinal: 1,
              },
            },
          };
        case "trajectory-message":
          return {
            ...common,
            node: {
              kind: "trajectory-message" as const,
              value: {
                logId: input.node.logId,
                head: input.node.head,
                messageId: input.node.messageId,
                turnId: "turn:1",
                role: "user",
                status: "completed",
                startedEventId: null,
                completedEventId: "trajectory-event:prompt",
                sourceMessageId: "channel-message:prompt",
                senderRef: { kind: "user", id: "user:alice", participantId: "user:alice" },
                textBlocks: [{ blockId: "block:prompt", content: "Move the parser" }],
              },
            },
          };
        case "change":
          return {
            ...common,
            node: {
              kind: "change" as const,
              value: {
                changeId: input.node.changeId,
                authoredByWorkUnitId: "work-unit:1",
                operation: 0,
                kind: "text-edit" as const,
                effects: [
                  {
                    kind: "content" as const,
                    fileId: "file:bar",
                    beforeContentHash: "blob:before",
                    afterContentHash: "blob:after",
                  },
                ],
                counteractsChangeIds: [],
                effectDigest: "digest:1",
                normalizationProtocol: "normalization:1",
              },
            },
          };
        case "applied-change":
          return {
            ...common,
            node: {
              kind: "applied-change" as const,
              value: {
                appliedChangeId: input.node.appliedChangeId,
                applicationId: "application:1",
                changeId: "change:1",
                ordinal: 0,
                appliedEffects: [
                  {
                    kind: "content" as const,
                    fileId: "file:bar",
                    beforeContentHash: "blob:before",
                    afterContentHash: "blob:after",
                  },
                ],
                resultPredicate: null,
              },
            },
          };
        case "decision":
          return {
            ...common,
            node: {
              kind: "decision" as const,
              value: {
                decisionId: input.node.decisionId,
                intent: { text: "Keep the current implementation", tier: "stated" as const },
                sourceIntents: [],
                sourceState: working,
                targetBasis: working,
                entries: [
                  {
                    coordinate: { kind: "file" as const, id: "file:source" },
                    resolution: "ours" as const,
                    accountedSourceChangeIds: ["change:source"],
                    rationale: "Not relevant to this context",
                  },
                ],
              },
            },
          };
        case "event":
        case "application":
          throw new Error(`unused ${input.node.kind} inspection fixture`);
      }
    }
  );
  const readFile = vi.fn(async () => ({
    repositoryId: "repository:packages/foo",
    fileId: "file:bar",
    repoPath: "packages/foo",
    path: "bar.ts",
    contentHash: "blob:1",
    authoredChangeId: "change:1",
    authoredByWorkUnitId: "work:1",
    contentClass: "internal" as const,
    externalKeys: [],
    mode: 0o644,
    content: { kind: "text" as const, text: "content" },
  }));
  const resolveRepository = vi.fn(
    async (input: Parameters<ProvenanceToolDeps["vcs"]["resolveRepository"]>[0]) => ({
      state: input.state,
      repositoryId: "repository:packages/foo",
      repoPath: "packages/foo",
    })
  );
  const history = vi.fn(
    async (
      input: Parameters<ProvenanceToolDeps["vcs"]["history"]>[0]
    ): ReturnType<ProvenanceToolDeps["vcs"]["history"]> => ({
      root: input.root,
      entries: [
        {
          node: { kind: "change" as const, changeId: "change:file-edit" },
          createdAt: "2026-07-15T10:00:00.000Z",
          summary: "Explain the public entry point",
        },
      ],
      nextCursor: "cursor:history",
    })
  );
  const walk = vi.fn(
    async (
      input: Parameters<ProvenanceToolDeps["vcs"]["walk"]>[0]
    ): ReturnType<ProvenanceToolDeps["vcs"]["walk"]> => ({
      walk: input.walk,
      scope: input.walk === "cohort" ? (input.scope ?? "command") : null,
      subject: input.subject,
      entries: [
        {
          node: { kind: "work-unit", workUnitId: "work-unit:1" },
          label: "work unit · edit",
          depth: 0,
          intent: { tier: "stated", text: "Cap the retry backoff at 30 seconds" },
        },
        {
          node: { kind: "trajectory-message", logId: "log:1", head: "head:1", messageId: "m:1" },
          label: "message · user from user",
          depth: 3,
          detail: "Cap the retry backoff at 30 seconds",
          boundary: "human-statement",
        },
      ],
      omitted: [{ label: "sibling applications", count: 3 }],
      notes: [],
      nextCursor: "cursor:walk",
    })
  );
  const query = vi.fn(
    async (
      _input: Parameters<ProvenanceToolDeps["vcs"]["query"]>[0]
    ): ReturnType<ProvenanceToolDeps["vcs"]["query"]> => ({
      schemaVersion: 1,
      columns: ["work_unit_id", "intent_tier"],
      rows: [["work-unit:1", "stated"]],
      rowsRead: 1,
      truncated: false,
      refusal: null,
    })
  );
  const search = vi.fn(
    async (
      input: Parameters<ProvenanceToolDeps["vcs"]["search"]>[0]
    ): ReturnType<ProvenanceToolDeps["vcs"]["search"]> => ({
      text: input.text,
      indexMode: "fts",
      hits: [
        {
          node: { kind: "work-unit", workUnitId: "work-unit:1" },
          subjectKind: "work-unit",
          label: "work unit",
          excerpt: "cap the retry backoff",
          intent: { tier: "stated", text: "Cap the retry backoff at 30 seconds" },
        },
      ],
      truncated: false,
    })
  );
  const value: ProvenanceToolDeps = {
    vcs: { status, resolveRepository, neighbors, inspect, readFile, history, walk, query, search },
    contextId: "context:1",
    session: { logId: "log:1", head: "head:1" },
  };
  return {
    value,
    status,
    resolveRepository,
    neighbors,
    inspect,
    readFile,
    history,
    walk,
    query,
    search,
  };
}

describe("createProvenanceTool", () => {
  it("exposes only friendly targets and compact refs as selectors", () => {
    const tool = createProvenanceTool("/", fixture().value);
    const root = {
      kind: "file",
      state: working,
      repositoryId: "repository:packages/foo",
      fileId: "file:bar",
    };

    expect(
      Value.Check(tool.parameters, {
        target: "packages/foo/bar.ts",
        limit: 3,
      })
    ).toBe(true);
    expect(Value.Check(tool.parameters, { target: "@r1-abcd" })).toBe(true);
    expect(Value.Check(tool.parameters, { target: "@r1-abcd", historyPage: 2 })).toBe(false);
    expect(Value.Check(tool.parameters, { root, historyPage: 2 })).toBe(false);
    expect(Value.Check(tool.parameters, { target: root, historyPage: 2 })).toBe(false);
    expect(Value.Check(tool.parameters, { root: { ...root, historyPage: 2 } })).toBe(false);
  });

  it("accepts an ordinary subject ref as an idempotent first-page read", async () => {
    const f = fixture();
    const references = createMemoryAgentReferenceStore();
    const tool = createProvenanceTool("/", f.value, references);
    const root = { kind: "change" as const, changeId: "change:1" };

    const result = await tool.execute("call:first-page", {
      target: putProvenanceReference(references, root, 5),
    });

    expect(f.neighbors).toHaveBeenCalledWith({ root, limit: 5 });
    expect(result.details).toMatchObject({ subjectKind: "change", adjacencyCount: 1 });
  });

  it("resolves a friendly repository path to its typed repository node", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    const result = await tool.execute("call:repository", { target: "packages/foo" });

    expect(f.resolveRepository).toHaveBeenCalledWith({
      state: working,
      repoPath: "packages/foo",
    });
    expect(f.neighbors).toHaveBeenLastCalledWith({
      root: {
        kind: "repository",
        state: working,
        repositoryId: "repository:packages/foo",
      },
      limit: 5,
    });
    expect(f.inspect).toHaveBeenCalledWith({
      node: {
        kind: "repository",
        state: working,
        repositoryId: "repository:packages/foo",
      },
      edgeLimit: 1,
    });
    expect(f.readFile).not.toHaveBeenCalled();
    expect(f.history).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      target: "packages/foo",
      subjectKind: "repository",
    });
  });

  it("resolves a friendly file path to a typed file node and pages neighbors", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    const result = await tool.execute("call:1", { target: "packages/foo/bar.ts" });

    expect(f.neighbors).toHaveBeenLastCalledWith({
      root: {
        kind: "file",
        state: working,
        repositoryId: "repository:packages/foo",
        fileId: "file:bar",
      },
      limit: 5,
    });
    expect(result.details).toMatchObject({
      target: "packages/foo/bar.ts",
      subjectKind: "file",
      adjacencyCount: 1,
    });
    expect(f.inspect).toHaveBeenCalledWith({
      node: {
        kind: "file",
        state: working,
        repositoryId: "repository:packages/foo",
        fileId: "file:bar",
      },
      edgeLimit: 1,
    });
    expect(f.history).toHaveBeenCalledWith({
      root: {
        kind: "file",
        state: working,
        repositoryId: "repository:packages/foo",
        fileId: "file:bar",
      },
      direction: "past",
      limit: 5,
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toMatch(
      /past · "Explain the public entry point" · change @r[0-9a-z]+-[0-9a-f]{4}/u
    );
    expect(text).toMatch(
      /more file history → @r[0-9a-z]+-[0-9a-f]{4}/u
    );
    expect(text).not.toContain("cursor:history");
    expect(text).not.toContain("cursor:next");
    expect(result.details).toMatchObject({
      historyCount: 1,
      continuations: [
        { target: expect.stringMatching(/^@r/u), kind: "adjacency" },
        { target: expect.stringMatching(/^@r/u), kind: "file-history" },
      ],
    });
  });

  it("carries the exact file-history page and cursor inside one continuation ref", async () => {
    const f = fixture();
    const references = createMemoryAgentReferenceStore();
    const tool = createProvenanceTool("/", f.value, references);
    const target = {
      kind: "file" as const,
      state: working,
      repositoryId: "repository:packages/foo",
      fileId: "file:bar",
    };

    const ref = putProvenanceReference(references, target, 2, {
      stream: "file-history",
      page: 2,
      cursor: "cursor:history",
    });
    const result = await tool.execute("call:history-page", {
      target: ref,
    });

    expect(f.neighbors).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.history).toHaveBeenCalledOnce();
    expect(f.history).toHaveBeenCalledWith({
      root: target,
      direction: "past",
      cursor: "cursor:history",
      limit: 2,
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("file history page 2");
    expect(text).toMatch(
      /more file history → @r[0-9a-z]+-[0-9a-f]{4}/u
    );
    expect(text.indexOf("more file history")).toBeLessThan(text.indexOf("past ·"));
    expect(text).not.toContain("node ·");
    expect(text).not.toContain("—caused-by→");
    expect(result.details).toMatchObject({
      historyCount: 1,
      continuations: [{ target: expect.stringMatching(/^@r/u), kind: "file-history" }],
    });
    expect(result.details).not.toHaveProperty("adjacencyCount");
  });

  it("fetches only the advertised adjacency stream for an adjacency continuation", async () => {
    const f = fixture();
    const references = createMemoryAgentReferenceStore();
    const tool = createProvenanceTool("/", f.value, references);
    const target = {
      kind: "file" as const,
      state: working,
      repositoryId: "repository:packages/foo",
      fileId: "file:bar",
    };

    await tool.execute("call:adjacency-page", {
      target: putProvenanceReference(references, target, 3, {
        stream: "adjacency",
        page: 2,
        cursor: "cursor:next",
      }),
    });

    expect(f.neighbors).toHaveBeenCalledWith({
      root: target,
      cursor: "cursor:next",
      limit: 3,
    });
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.history).not.toHaveBeenCalled();
  });

  it("clamps an oversized page preference instead of rejecting the turn", async () => {
    const f = fixture();
    const references = createMemoryAgentReferenceStore();
    const tool = createProvenanceTool("/", f.value, references);
    const target = {
      kind: "file" as const,
      state: working,
      repositoryId: "repository:packages/foo",
      fileId: "file:bar",
    };

    await tool.execute("call:clamped-limit", {
      target: putProvenanceReference(references, target, 5, {
        stream: "file-history",
        page: 2,
        cursor: "cursor:history",
      }),
      limit: 50,
    });

    expect(f.history).toHaveBeenNthCalledWith(1, {
      root: target,
      direction: "past",
      cursor: "cursor:history",
      limit: 5,
    });
  });

  it("returns a normal empty page when an advertised continuation reaches the stream end", async () => {
    const f = fixture();
    f.history.mockResolvedValueOnce({
      root: {
        kind: "file",
        state: working,
        repositoryId: "repository:packages/foo",
        fileId: "file:bar",
      },
      entries: [],
      nextCursor: null,
    });
    const references = createMemoryAgentReferenceStore();
    const tool = createProvenanceTool("/", f.value, references);
    const target = {
      kind: "file" as const,
      state: working,
      repositoryId: "repository:packages/foo",
      fileId: "file:bar",
    };

    const result = await tool.execute("call:history-unavailable", {
      target: putProvenanceReference(references, target, 5, {
        stream: "file-history",
        page: 2,
        cursor: "cursor:history",
      }),
    });

    expect(result.details).toMatchObject({
      target: expect.stringMatching(/^@r/u),
      subjectKind: "file",
      historyCount: 0,
      continuations: [],
    });
  });

  it("returns a normal diagnostic for a nonexistent friendly repository path", async () => {
    const f = fixture();
    f.value.vcs.resolveRepository = vi.fn(async () => null);
    const tool = createProvenanceTool("/", f.value);

    const result = await tool.execute("call:missing-repository", {
      target: "projects/missing-history",
      limit: 1,
    });

    expect(result.details).toMatchObject({
      diagnostic: "invalid-target",
      target: "projects/missing-history",
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("is not present in the working state"),
    });
  });

  it("resolves a repository-root path without pretending it is a file", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    const result = await tool.execute("call:repo", { target: "packages/foo" });

    const root = {
      kind: "repository" as const,
      state: working,
      repositoryId: "repository:packages/foo",
    };
    expect(f.resolveRepository).toHaveBeenCalledWith({
      state: working,
      repoPath: "packages/foo",
    });
    expect(f.neighbors).toHaveBeenLastCalledWith({ root, limit: 5 });
    expect(f.inspect).toHaveBeenCalledWith({ node: root, edgeLimit: 1 });
    expect(f.readFile).not.toHaveBeenCalled();
    expect(f.history).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      target: "packages/foo",
      subjectKind: "repository",
    });
  });

  it("walks the exact session trajectory node", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    await tool.execute("call:2", { target: "session" });
    expect(f.neighbors).toHaveBeenCalledWith({
      root: { kind: "trajectory", logId: "log:1", head: "head:1" },
      limit: 5,
    });
  });

  it("accepts the canonical workspace-event identity returned by VCS status", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);

    await expect(
      tool.execute("call:workspace-event", {
        target: "workspace-event:abc123",
      })
    ).rejects.toThrow("unused event inspection fixture");

    expect(f.value.vcs.inspect).toHaveBeenCalledWith({
      node: { kind: "event", eventId: "workspace-event:abc123" },
      edgeLimit: 1,
    });
  });

  it("converts a supported semantic shorthand", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    await tool.execute("call:3", { target: "change:42" });
    expect(f.neighbors).toHaveBeenCalledWith({
      root: { kind: "change", changeId: "change:42" },
      limit: 5,
    });
    await tool.execute("call:applied", { target: "applied-change:42" });
    expect(f.neighbors).toHaveBeenCalledWith({
      root: { kind: "applied-change", appliedChangeId: "applied-change:42" },
      limit: 5,
    });
  });

  it("passes an exact typed node through unchanged while carrying its cursor internally", async () => {
    const f = fixture();
    const references = createMemoryAgentReferenceStore();
    const tool = createProvenanceTool("/", f.value, references);
    const root = { kind: "decision" as const, decisionId: "decision:1" };
    await tool.execute("call:4", {
      target: putProvenanceReference(references, root, 5, {
        stream: "adjacency",
        page: 2,
        cursor: "cursor:next",
      }),
    });
    expect(f.neighbors).toHaveBeenCalledOnce();
    expect(f.neighbors).toHaveBeenLastCalledWith({
      root,
      limit: 5,
      cursor: "cursor:next",
    });
  });

  it("renders work-unit intent before exact adjacency and retains its endpoints", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    const result = await tool.execute("call:work", { target: "work-unit:1" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain(
      'node · work-unit · edit · stated: "Rename the public entry point" · command @r'
    );
    expect(text).toMatch(
      /work-unit @r[0-9a-z]+-[0-9a-f]{4} —authored-change→ change @r[0-9a-z]+-[0-9a-f]{4}/u
    );
    expect(text.indexOf("node ·")).toBeLessThan(text.indexOf("—authored-change→"));
    expect(detailsOf(result)).toMatchObject({ subjectKind: "work-unit", adjacencyCount: 1 });
  });

  it("renders command state and trajectory-invocation metadata", async () => {
    const f = fixture();
    const references = createMemoryAgentReferenceStore();
    const tool = createProvenanceTool("/", f.value, references);
    const command = await tool.execute("call:command", { target: "command:1" });
    const invocationRoot = {
      kind: "trajectory-invocation" as const,
      logId: "log:1",
      head: "head:1",
      invocationId: "invocation:1",
    };
    const invocation = await tool.execute("call:invocation", {
      target: putProvenanceReference(references, invocationRoot, 5),
    });
    const commandText = command.content[0]?.type === "text" ? command.content[0].text : "";
    const invocationText = invocation.content[0]?.type === "text" ? invocation.content[0].text : "";

    expect(commandText).toContain("node · command · vcs.edit · complete");
    expect(invocationText).toContain(
      'node · trajectory-invocation · name "provenance" · status complete · outcome success'
    );
    expect(invocationText).toContain(
      'request aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa · json · 48 bytes · read services.blobstore.getText("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")'
    );
    expect(invocationText).toMatch(
      /trajectory-invocation @r[0-9a-z]+-[0-9a-f]{4} —part-of-trajectory→ trajectory @r[0-9a-z]+-[0-9a-f]{4}/u
    );
    expect(invocationText.indexOf("node ·")).toBeLessThan(
      invocationText.indexOf("—part-of-trajectory→")
    );
  });

  it("renders a direct command as an honest causal endpoint", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    const result = await tool.execute("call:direct", { target: "command:direct" });
    const details = detailsOf(result);
    const rendered = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(rendered).toContain("node · command · vcs.edit · complete");
    expect(details).toMatchObject({ subjectKind: "command", adjacencyCount: 0 });
    expect(rendered).not.toContain("trajectory-invocation");
  });

  it("renders the exact intent-bearing turn and triggering message", async () => {
    const f = fixture();
    const references = createMemoryAgentReferenceStore();
    const tool = createProvenanceTool("/", f.value, references);
    const turnRoot = {
      kind: "trajectory-turn" as const,
      logId: "log:1",
      head: "head:1",
      turnId: "turn:1",
    };
    const messageRoot = {
      kind: "trajectory-message" as const,
      logId: "log:1",
      head: "head:1",
      messageId: "message:prompt",
    };
    const turn = await tool.execute("call:turn", {
      target: putProvenanceReference(references, turnRoot, 5),
    });
    const message = await tool.execute("call:message", {
      target: putProvenanceReference(references, messageRoot, 5),
    });
    const turnDetails = detailsOf(turn);
    const turnText = turn.content[0]?.type === "text" ? turn.content[0].text : "";
    const messageText = message.content[0]?.type === "text" ? message.content[0].text : "";

    expect(turnText).toContain(
      "node · trajectory-turn · ordinal 1 · summary"
    );
    expect(messageText).toContain(
      'node · trajectory-message · role user · status completed · sender user · text "Move the parser"'
    );
    expect(turnDetails).toMatchObject({ subjectKind: "trajectory-turn", adjacencyCount: 1 });
  });

  it("returns a corrective diagnostic for non-target vocabulary", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    await expect(tool.execute("call:5", { target: "outcome:42" })).resolves.toMatchObject({
      details: {
        diagnostic: "invalid-target",
        target: "outcome:42",
      },
    });
    await expect(tool.execute("call:service", { target: "vcs" })).resolves.toMatchObject({
      details: {
        diagnostic: "invalid-target",
        target: "vcs",
      },
    });
  });

  it("guides ambiguous trajectory labels toward returned compact refs", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    const result = await tool.execute("call:trajectory-label", {
      target: "trajectory-message:message:prompt",
    });
    expect(result).toMatchObject({
      details: {
        diagnostic: "invalid-target",
        target: "trajectory-message:message:prompt",
      },
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Trajectory subnodes require the compact ref");
  });
});

describe("question-shaped provenance surfaces", () => {
  const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
    result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";

  it("renders a cause walk as a spine with intents leading and refs, not identities", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    const result = await tool.execute("call:cause", {
      target: "work-unit:1",
      walk: "cause",
    });
    const text = textOf(result);

    expect(f.walk).toHaveBeenCalledWith(
      expect.objectContaining({
        contextId: "context:1",
        walk: "cause",
        subject: { kind: "work-unit", workUnitId: "work-unit:1" },
      })
    );
    expect(text).toContain("prov cause · work-unit:1 · what was being attempted");
    expect(text).toContain('stated: "Cap the retry backoff at 30 seconds" · work unit · edit');
    expect(text).toContain("← the originating human statement");
    expect(text).toContain("… and 3 sibling applications");
    expect(text).toContain("continue: pass any @ref back as target");
    // Only the caller's own echoed target may name a subject; the body never does.
    for (const line of text.split("\n").slice(1)) {
      expect(line).not.toContain("work-unit:1");
      expect(line).not.toContain("log:1");
    }
    expect(detailsOf(result)).toMatchObject({ walk: "cause", entryCount: 2 });
  });

  it("resumes a walk from the ref it advertised, without re-stating the walk", async () => {
    const f = fixture();
    const references = createMemoryAgentReferenceStore();
    const tool = createProvenanceTool("/", f.value, references);
    const first = await tool.execute("call:cohort", {
      target: "work-unit:1",
      walk: "cohort",
      scope: "turn",
    });
    const continuation = /more → (@r[0-9a-z]+-[0-9a-f]{4})/u.exec(textOf(first))?.[1];
    expect(continuation).toBeTruthy();
    await tool.execute("call:cohort-next", { target: continuation! });
    expect(f.walk).toHaveBeenLastCalledWith(
      expect.objectContaining({ walk: "cohort", scope: "turn", cursor: "cursor:walk" })
    );
  });

  it("renders query results as a table with refs in the identity columns", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    const result = await tool.execute("call:query", {
      query: "SELECT work_unit_id, intent_tier FROM prov_work_units",
    });
    const text = textOf(result);

    expect(text).toContain("| work_unit_id | intent_tier |");
    expect(text).toMatch(/\| @r[0-9a-z]+-[0-9a-f]{4} \| stated \|/u);
    expect(text).not.toContain("work-unit:1");
    expect(detailsOf(result)).toMatchObject({ rowCount: 1, refused: null });
  });

  it("renders polymorphic query identities as refs without requiring a kind column", async () => {
    const f = fixture();
    const workUnitId = `work-unit:${"a".repeat(64)}`;
    f.query.mockResolvedValueOnce({
      schemaVersion: 1,
      columns: ["subject_id", "text"],
      rows: [[workUnitId, "Create the fixture"]],
      rowsRead: 1,
      truncated: false,
      refusal: null,
    });
    const tool = createProvenanceTool("/", f.value);
    const result = await tool.execute("call:polymorphic-query", {
      query: "SELECT subject_kind, subject_id, text FROM prov_search",
    });
    const text = textOf(result);

    expect(text).toContain("| subject_id | text |");
    expect(text).toMatch(/\| @r[0-9a-z]+-[0-9a-f]{4} \| Create the fixture \|/u);
    expect(text).not.toContain(workUnitId);
  });

  it("binds a returned ref inside query text to its exact identity", async () => {
    const f = fixture();
    const references = createMemoryAgentReferenceStore();
    const tool = createProvenanceTool("/", f.value, references);
    const ref = putProvenanceReference(
      references,
      { kind: "work-unit", workUnitId: "work-unit:1" },
      5
    );
    await tool.execute("call:bound-query", {
      query: `SELECT change_id FROM prov_changes WHERE work_unit_id = '${ref}'`,
    });
    expect(f.query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "SELECT change_id FROM prov_changes WHERE work_unit_id = 'work-unit:1'",
      })
    );
  });

  it("renders a plan-stage refusal with the offending term instead of rows", async () => {
    const f = fixture();
    f.query.mockResolvedValueOnce({
      schemaVersion: 1,
      columns: [],
      rows: [],
      rowsRead: 0,
      truncated: false,
      refusal: {
        stage: "plan",
        code: "full-scan",
        message: "The plan scans every row of a relation backing `gad_changes` (500000 rows).",
        term: "gad_changes",
      },
    });
    const tool = createProvenanceTool("/", f.value);
    const text = textOf(
      await tool.execute("call:refused", { query: "SELECT change_id FROM prov_changes" })
    );
    expect(text).toContain("prov query · refused at plan · gad_changes");
  });

  it("enters by content when the subject cannot be named", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    const text = textOf(await tool.execute("call:search", { target: "search: retries backoff" }));

    expect(f.search).toHaveBeenCalledWith(
      expect.objectContaining({ contextId: "context:1", text: "retries backoff" })
    );
    expect(text).toContain("prov search");
    expect(text).toMatch(
      /work-unit · stated: "Cap the retry backoff at 30 seconds" · @r[0-9a-z]+-[0-9a-f]{4}/u
    );
  });

  it("expands several agenda items in one call instead of one call each", async () => {
    const f = fixture();
    const references = createMemoryAgentReferenceStore();
    const tool = createProvenanceTool("/", f.value, references);
    const refs = [
      putProvenanceReference(references, { kind: "work-unit", workUnitId: "work-unit:1" }, 5),
      putProvenanceReference(references, { kind: "change", changeId: "change:1" }, 5),
    ];
    const result = await tool.execute("call:batch", { targets: refs });
    const text = textOf(result);

    expect(f.inspect).toHaveBeenCalledTimes(2);
    expect(text).toContain("prov · 2 subjects");
    expect(detailsOf(result)).toMatchObject({ inspectedCount: 2 });
    expect(text).not.toContain("work-unit:1 ·");
  });

  it("accepts the new question-shaped parameters and still refuses invented ones", () => {
    const tool = createProvenanceTool("/", fixture().value);
    expect(Value.Check(tool.parameters, { target: "packages/foo/bar.ts", walk: "cause" })).toBe(
      true
    );
    expect(Value.Check(tool.parameters, { walk: "cohort", scope: "turn" })).toBe(true);
    expect(Value.Check(tool.parameters, { query: "SELECT 1 FROM prov_events" })).toBe(true);
    expect(Value.Check(tool.parameters, { targets: ["@r1-abcd", "@r2-abcd"] })).toBe(true);
    expect(Value.Check(tool.parameters, { walk: "drift" })).toBe(false);
    expect(Value.Check(tool.parameters, { sql: "SELECT 1" })).toBe(false);
  });
});
