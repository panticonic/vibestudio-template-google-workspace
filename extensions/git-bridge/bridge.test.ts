import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { sha256Hex, sha256HexSyncText } from "@vibestudio/content-addressing";
import type { GitCommitTreeEntry } from "@vibestudio/git";
import { GitBridge, provenanceGitUri, type BridgeHost } from "./bridge.js";

function commitBlob(
  filePath: string,
  content: string | Buffer,
  mode: 0o100644 | 0o100755 = 0o100644
): GitCommitTreeEntry {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return {
    path: filePath,
    type: "blob",
    mode,
    oid: "f".repeat(40),
    bytes,
  };
}

function eventInspection(eventId: string, applicationId = "application:1") {
  return {
    root: { kind: "event" as const, eventId },
    node: {
      kind: "event" as const,
      value: {
        eventId,
        workspaceId: "workspace:test",
        commandId: `command:${eventId}`,
        kind: "commit" as const,
        workspaceFactRootId: `facts:${eventId}`,
        parentEventIds: ["event:parent"],
        applicationIds: [applicationId],
        decisionIds: [],
        message: "Semantic snapshot",
        semanticProtocol: "semantic-v1",
        createdAt: new Date(0).toISOString(),
      },
    },
    edges: [],
    hasMoreEdges: false,
  };
}

function repositoryInspection(state: { kind: "event"; eventId: string }, repoPath: string) {
  return {
    root: {
      kind: "repository" as const,
      state,
      repositoryId: `repository:${repoPath}`,
    },
    node: {
      kind: "repository" as const,
      state,
      value: {
        kind: "present" as const,
        repositoryId: `repository:${repoPath}`,
        repoPath,
        manifestId: `manifest:${repoPath}`,
      },
    },
    edges: [],
    hasMoreEdges: false,
  };
}

function applicationInspection(applicationId = "application:1", workUnitId = "work:import") {
  return {
    root: { kind: "application" as const, applicationId },
    node: {
      kind: "application" as const,
      value: {
        applicationId,
        workUnitId,
        basis: { kind: "event" as const, eventId: "event:parent" },
        appliedChangeCount: 1,
        appliedChanges: [],
        resultWorkspaceFactRootId: "facts:import",
        semanticProtocol: "semantic-v1",
      },
    },
    edges: [],
    hasMoreEdges: false,
  };
}

function importWorkUnitInspection(revision: string, sourceUri: string, workUnitId = "work:import") {
  return {
    root: { kind: "work-unit" as const, workUnitId },
    node: {
      kind: "work-unit" as const,
      value: {
        workUnitId,
        commandId: "command:import",
        kind: "import" as const,
        authoredChangeCount: 1,
        authoredChangeIds: ["change:import"],
        incorporatedChangeCount: 0,
        incorporatedChangeIds: [],
        decisionCount: 0,
        decisionIds: [],
        intent: { text: "Import snapshot", tier: "stated" as const },
        intentSummary: "Import snapshot",
        authorContextId: "context:import",
        triggerEvidence: null,
        externalSnapshot: {
          sourceKind: "git" as const,
          sourceUri,
          snapshotRevision: revision,
          sourceSubdir: null,
          canonicalSnapshot: `v1-sha256:${"c".repeat(64)}`,
          snapshotDigest: "a".repeat(64),
          targetRepositoryIds: ["repository:projects/demo"],
        },
        contentClass: "external" as const,
        externalKeys: [`repo:${sourceUri}@${revision}`],
        normalizationProtocol: "semantic-v1",
        createdAt: new Date(0).toISOString(),
      },
    },
    edges: [],
    hasMoreEdges: false,
  };
}

function importSnapshotResult(input: {
  eventId: string;
  applicationId: string;
  workUnitId: string;
  sourceUri: string;
  revision: string;
  repositoryId: string;
}) {
  return {
    contextId: "ctx:import",
    eventId: input.eventId,
    applicationId: input.applicationId,
    workUnitId: input.workUnitId,
    externalSnapshot: {
      sourceKind: "git" as const,
      sourceUri: input.sourceUri,
      snapshotRevision: input.revision,
      sourceSubdir: null,
      canonicalSnapshot: `v1-sha256:${"c".repeat(64)}`,
      snapshotDigest: "a".repeat(64),
      targetRepositoryIds: [input.repositoryId],
    },
    importedRepositoryIds: [input.repositoryId],
  };
}

function status(contextId: string, eventId: string) {
  return {
    contextId,
    committed: { kind: "event" as const, eventId },
    workingHead: { kind: "event" as const, eventId },
    clean: true,
    mainEventId: eventId,
    mainRelation: "at" as const,
    workingCounts: { applications: 0, workUnits: 0, changes: 0 },
    integrating: [],
  };
}

const INTERNAL_LIST_LINEAGE = {
  authoredChangeId: "change:index",
  authoredByWorkUnitId: "work:index",
  contentClass: "internal" as const,
  externalKeys: [],
};

function baseHost(root: string) {
  const unreachable = () =>
    vi.fn(async (): Promise<never> => {
      throw new Error("unexpected VCS call");
    });
  const host: BridgeHost = {
    checkoutRoot: async () => root,
    ensureContext: vi.fn(async () => undefined),
    blobstore: {
      putBase64: vi.fn(async (bytesBase64: string) => {
        const bytes = Buffer.from(bytesBase64, "base64");
        return { digest: sha256Hex(bytes), size: bytes.byteLength };
      }),
    },
    vcs: {
      status: unreachable(),
      neighbors: unreachable(),
      inspect: unreachable(),
      resolveRepository: vi.fn(async () => null),
      listFiles: unreachable(),
      readFile: unreachable(),
      importSnapshot: unreachable(),
    },
  };
  return { host };
}

describe("GitBridge semantic snapshot boundary", () => {
  it.each([
    String.raw`C:\Users\alice\demo.git`,
    "C:/Users/alice/demo.git",
    String.raw`C:relative\demo.git`,
  ])("keeps the Windows-local remote %s private", (remote) => {
    expect(provenanceGitUri(remote)).toBe(`git-local://sha256/${sha256HexSyncText(remote)}`);
  });

  it("preserves SCP-style remote identity", () => {
    expect(provenanceGitUri("git@example.test:owner/demo.git")).toBe(
      "ssh://example.test/owner/demo.git"
    );
  });

  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "git-bridge-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("roots operational checkouts below host state rather than semantic source", async () => {
    const checkoutRoot = path.join(root, "state", "git-checkouts");
    const sourceRoot = path.join(root, "source");
    const { host } = baseHost(checkoutRoot);
    const bridge = new GitBridge(host);

    expect(await bridge.repoGitDir("projects/demo")).toBe(
      path.join(checkoutRoot, "projects", "demo")
    );
    expect(await bridge.repoGitDir("projects/demo")).not.toBe(
      path.join(sourceRoot, "projects", "demo")
    );
  });

  it("imports one exact checkout snapshot as a semantic candidate", async () => {
    const repoPath = "projects/demo";
    const dir = path.join(root, repoPath);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, "index.ts"), "export const value = 1;\n");
    writeFileSync(path.join(dir, "binary.dat"), Buffer.from([0xff, 0xfe]));
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, "event:main"));
    host.vcs.inspect = vi.fn(async ({ node }) => {
      if (node.kind === "event" && node.eventId === "event:imported") {
        return eventInspection(node.eventId, "application:imported");
      }
      if (node.kind === "application") {
        return applicationInspection(node.applicationId, "work:imported");
      }
      if (node.kind === "work-unit") {
        return importWorkUnitInspection(
          "a".repeat(40),
          "https://example.test/owner/demo.git",
          node.workUnitId
        );
      }
      const inspected = eventInspection("event:main");
      inspected.node.value.applicationIds = [];
      return inspected;
    });
    host.vcs.importSnapshot = vi.fn(async () =>
      importSnapshotResult({
        eventId: "event:imported",
        applicationId: "application:imported",
        workUnitId: "work:imported",
        sourceUri: "https://example.test/owner/demo.git",
        revision: "a".repeat(40),
        repositoryId: "repository:projects/demo",
      })
    );
    const bridge = new GitBridge(host);
    vi.spyOn(bridge.git, "getCurrentCommit").mockResolvedValue("a".repeat(40));
    vi.spyOn(bridge.git, "readCommitTree").mockResolvedValue([
      commitBlob("binary.dat", Buffer.from([0xff, 0xfe])),
      commitBlob("index.ts", "export const value = 1;\n"),
    ]);
    vi.spyOn(bridge.git, "statusMatrix").mockResolvedValue([
      ["binary.dat", 1, 1, 1],
      ["index.ts", 1, 1, 1],
    ]);

    await expect(
      bridge.importLockedInner(repoPath, {
        sourceUri: "https://token@example.test/owner/demo.git?signature=secret",
      })
    ).resolves.toEqual({
      contextId: expect.stringMatching(/^git-bridge-/),
      eventId: "event:imported",
      changed: true,
      semanticEvidence: {
        applicationId: "application:imported",
        workUnitId: "work:imported",
        externalSnapshot: expect.objectContaining({
          sourceUri: "https://example.test/owner/demo.git",
          snapshotRevision: "a".repeat(40),
        }),
      },
    });
    expect(host.ensureContext).toHaveBeenCalledWith(expect.stringMatching(/^git-bridge-/));
    expect(host.vcs.importSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        contextId: expect.stringMatching(/^git-bridge-/),
        expectedWorkingHead: { kind: "event", eventId: "event:main" },
        source: expect.objectContaining({
          kind: "git",
          url: "https://example.test/owner/demo.git",
          commit: "a".repeat(40),
          snapshot: expect.stringMatching(/^v1-sha256:/),
        }),
        repositories: [
          expect.objectContaining({
            repoPath,
            files: expect.arrayContaining([
              expect.objectContaining({
                path: "binary.dat",
                contentHash: sha256Hex(Buffer.from([0xff, 0xfe])),
                mode: 0o644,
              }),
              expect.objectContaining({
                path: "index.ts",
                contentHash: sha256Hex(Buffer.from("export const value = 1;\n")),
                mode: 0o644,
              }),
            ]),
          }),
        ],
      })
    );
    expect(host.vcs.resolveRepository).toHaveBeenCalledOnce();
    expect(host.vcs.resolveRepository).toHaveBeenCalledWith({
      state: { kind: "event", eventId: "event:main" },
      repoPath,
    });
    expect(host.vcs.neighbors).not.toHaveBeenCalled();
    expect(host.vcs.inspect).not.toHaveBeenCalledWith(
      expect.objectContaining({ node: { kind: "event", eventId: "event:imported" } })
    );
    expect(host.blobstore.putBase64).toHaveBeenCalledTimes(2);
    expect(host.blobstore.putBase64).toHaveBeenCalledWith(
      Buffer.from([0xff, 0xfe]).toString("base64")
    );
    expect(host.blobstore.putBase64).toHaveBeenCalledWith(
      Buffer.from("export const value = 1;\n").toString("base64")
    );
  });

  it("imports an actual resolved commit tree and stores duplicate content once", async () => {
    const repoPath = "projects/real-tree";
    const dir = path.join(root, repoPath);
    mkdirSync(dir, { recursive: true });
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, "event:main"));
    host.vcs.importSnapshot = vi.fn(async () =>
      importSnapshotResult({
        eventId: "event:real-import",
        applicationId: "application:real-import",
        workUnitId: "work:real-import",
        sourceUri: "https://example.test/real-tree.git",
        revision: commitOid,
        repositoryId: "repository:projects/real-tree",
      })
    );
    host.vcs.inspect = vi.fn(async ({ node }) => {
      if (node.kind === "event") {
        return eventInspection(node.eventId, "application:real-import");
      }
      if (node.kind === "application") {
        return applicationInspection(node.applicationId, "work:real-import");
      }
      if (node.kind === "work-unit") {
        return importWorkUnitInspection(
          commitOid,
          "https://example.test/real-tree.git",
          node.workUnitId
        );
      }
      return repositoryInspection({ kind: "event", eventId: "event:main" }, repoPath);
    });
    const bridge = new GitBridge(host);
    await bridge.git.init(dir, "main");
    writeFileSync(path.join(dir, "one.txt"), "shared bytes\n");
    writeFileSync(path.join(dir, "two.txt"), "shared bytes\n");
    writeFileSync(path.join(dir, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await bridge.git.add(dir, "one.txt");
    await bridge.git.add(dir, "two.txt");
    await bridge.git.add(dir, "run.sh");
    const commitOid = await bridge.git.commit({
      dir,
      message: "Committed snapshot",
      author: { name: "Test", email: "test@example.com" },
    });

    await expect(
      bridge.importLockedInner(repoPath, { sourceUri: "https://example.test/real-tree.git" })
    ).resolves.toEqual({
      contextId: expect.stringMatching(/^git-bridge-/),
      eventId: "event:real-import",
      changed: true,
      semanticEvidence: {
        applicationId: "application:real-import",
        workUnitId: "work:real-import",
        externalSnapshot: expect.objectContaining({
          sourceUri: "https://example.test/real-tree.git",
          snapshotRevision: commitOid,
        }),
      },
    });

    expect(host.vcs.importSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ commit: commitOid }),
        repositories: [
          expect.objectContaining({
            files: [
              expect.objectContaining({ path: "one.txt", mode: 0o644 }),
              expect.objectContaining({ path: "run.sh", mode: 0o755 }),
              expect.objectContaining({ path: "two.txt", mode: 0o644 }),
            ],
          }),
        ],
      })
    );
    expect(host.blobstore.putBase64).toHaveBeenCalledTimes(2);
  });

  it("skips import when the exact Git revision and snapshot already match", async () => {
    const repoPath = "projects/demo";
    const dir = path.join(root, repoPath);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, "index.ts"), "same\n");
    const main = { kind: "event" as const, eventId: "event:main" };
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, main.eventId));
    host.vcs.resolveRepository = vi.fn(async ({ state, repoPath: resolvedPath }) => ({
      state,
      repositoryId: `repository:${resolvedPath}`,
      repoPath: resolvedPath,
    }));
    host.vcs.inspect = vi.fn(async ({ node }) => {
      if (node.kind === "repository") return repositoryInspection(main, repoPath);
      if (node.kind === "application") return applicationInspection(node.applicationId);
      if (node.kind === "work-unit") {
        return importWorkUnitInspection("a".repeat(40), "https://example.test/demo.git");
      }
      return eventInspection(main.eventId);
    });
    host.vcs.listFiles = vi.fn(async () => ({
      state: main,
      repositoryId: "repository:projects/demo",
      files: [
        {
          fileId: "file:index",
          path: "index.ts",
          contentHash: sha256Hex(Buffer.from("same\n")),
          ...INTERNAL_LIST_LINEAGE,
          mode: 0o644,
          contentKind: "text" as const,
          byteLength: 5,
          coordinateExtent: 5,
        },
      ],
      nextCursor: null,
    }));
    const bridge = new GitBridge(host);
    const getCurrentCommit = vi
      .spyOn(bridge.git, "getCurrentCommit")
      .mockResolvedValue("a".repeat(40));
    vi.spyOn(bridge.git, "readCommitTree").mockResolvedValue([commitBlob("index.ts", "same\n")]);
    const statusMatrix = vi
      .spyOn(bridge.git, "statusMatrix")
      .mockResolvedValue([["index.ts", 1, 1, 1]]);

    await expect(
      bridge.importLockedInner(repoPath, { sourceUri: "https://example.test/demo.git" })
    ).resolves.toEqual({
      contextId: expect.stringMatching(/^git-bridge-/),
      eventId: main.eventId,
      changed: false,
      semanticEvidence: {
        applicationId: "application:1",
        workUnitId: "work:import",
        externalSnapshot: expect.objectContaining({
          sourceUri: "https://example.test/demo.git",
          snapshotRevision: "a".repeat(40),
        }),
      },
    });
    expect(getCurrentCommit).toHaveBeenCalledTimes(2);
    expect(statusMatrix).not.toHaveBeenCalled();
    expect(host.vcs.resolveRepository).toHaveBeenCalledOnce();
    expect(host.vcs.resolveRepository).toHaveBeenCalledWith({ state: main, repoPath });
    expect(host.vcs.neighbors).not.toHaveBeenCalled();
    expect(host.vcs.inspect).not.toHaveBeenCalledWith(
      expect.objectContaining({
        node: expect.objectContaining({ kind: "repository" }),
      })
    );
    expect(host.vcs.importSnapshot).not.toHaveBeenCalled();
  });

  it("records a new import boundary when Git revision changes without a tree change", async () => {
    const repoPath = "projects/demo";
    const dir = path.join(root, repoPath);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, "index.ts"), "same\n");
    const main = { kind: "event" as const, eventId: "event:main" };
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, main.eventId));
    host.vcs.resolveRepository = vi.fn(async ({ state, repoPath: resolvedPath }) => ({
      state,
      repositoryId: `repository:${resolvedPath}`,
      repoPath: resolvedPath,
    }));
    host.vcs.inspect = vi.fn(async ({ node }) => {
      if (node.kind === "repository") return repositoryInspection(main, repoPath);
      if (node.kind === "application") {
        return node.applicationId === "application:new"
          ? applicationInspection(node.applicationId, "work:imported")
          : applicationInspection(node.applicationId, "work:import");
      }
      if (node.kind === "work-unit") {
        return node.workUnitId === "work:imported"
          ? importWorkUnitInspection(
              "b".repeat(40),
              "https://example.test/owner/demo.git",
              node.workUnitId
            )
          : importWorkUnitInspection(
              "a".repeat(40),
              "https://example.test/owner/demo.git",
              node.workUnitId
            );
      }
      return node.kind === "event" && node.eventId === "event:imported"
        ? eventInspection(node.eventId, "application:new")
        : eventInspection(main.eventId, "application:old");
    });
    host.vcs.listFiles = vi.fn(async () => ({
      state: main,
      repositoryId: "repository:projects/demo",
      files: [
        {
          fileId: "file:index",
          path: "index.ts",
          contentHash: sha256Hex(Buffer.from("same\n")),
          ...INTERNAL_LIST_LINEAGE,
          mode: 0o644,
          contentKind: "text" as const,
          byteLength: 5,
          coordinateExtent: 5,
        },
      ],
      nextCursor: null,
    }));
    host.vcs.importSnapshot = vi.fn(async () =>
      importSnapshotResult({
        eventId: "event:imported",
        applicationId: "application:new",
        workUnitId: "work:imported",
        sourceUri: "https://example.test/owner/demo.git",
        revision: "b".repeat(40),
        repositoryId: "repository:projects/demo",
      })
    );
    const bridge = new GitBridge(host);
    vi.spyOn(bridge.git, "getCurrentCommit").mockResolvedValue("b".repeat(40));
    vi.spyOn(bridge.git, "readCommitTree").mockResolvedValue([commitBlob("index.ts", "same\n")]);
    vi.spyOn(bridge.git, "statusMatrix").mockResolvedValue([["index.ts", 1, 1, 1]]);

    await expect(
      bridge.importLockedInner(repoPath, { sourceUri: "https://example.test/owner/demo.git" })
    ).resolves.toEqual({
      contextId: expect.stringMatching(/^git-bridge-/),
      eventId: "event:imported",
      changed: true,
      semanticEvidence: {
        applicationId: "application:new",
        workUnitId: "work:imported",
        externalSnapshot: expect.objectContaining({
          sourceUri: "https://example.test/owner/demo.git",
          snapshotRevision: "b".repeat(40),
        }),
      },
    });
    expect(host.vcs.importSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ commit: "b".repeat(40) }),
      })
    );
  });

  it("refuses an inconsistent content-store receipt before semantic import", async () => {
    const repoPath = "projects/demo";
    const dir = path.join(root, repoPath);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, "index.ts"), "captured\n");
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, "event:main"));
    host.vcs.inspect = vi.fn(async () => {
      const inspected = eventInspection("event:main");
      inspected.node.value.applicationIds = [];
      return inspected;
    });
    host.blobstore.putBase64 = vi.fn(async () => ({
      digest: "0".repeat(64),
      size: 999,
    }));
    const bridge = new GitBridge(host);
    vi.spyOn(bridge.git, "getCurrentCommit").mockResolvedValue("a".repeat(40));
    vi.spyOn(bridge.git, "readCommitTree").mockResolvedValue([
      commitBlob("index.ts", "captured\n"),
    ]);
    vi.spyOn(bridge.git, "statusMatrix").mockResolvedValue([["index.ts", 1, 1, 1]]);

    await expect(
      bridge.importLockedInner(repoPath, { sourceUri: "https://example.test/owner/demo.git" })
    ).rejects.toThrow(/content store integrity mismatch for index\.ts/);
    expect(host.blobstore.putBase64).toHaveBeenCalledWith(
      Buffer.from("captured\n").toString("base64")
    );
    expect(host.vcs.importSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a tracked path excluded from semantic snapshots before the no-op shortcut", async () => {
    const repoPath = "projects/demo";
    const dir = path.join(root, repoPath);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, "index.ts"), "same\n");
    writeFileSync(path.join(dir, ".env"), "SECRET=not-imported\n");
    const main = { kind: "event" as const, eventId: "event:main" };
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, main.eventId));
    host.vcs.resolveRepository = vi.fn(async ({ state, repoPath: resolvedPath }) => ({
      state,
      repositoryId: `repository:${resolvedPath}`,
      repoPath: resolvedPath,
    }));
    host.vcs.inspect = vi.fn(async () => repositoryInspection(main, repoPath));
    host.vcs.listFiles = vi.fn(async () => ({
      state: main,
      repositoryId: "repository:projects/demo",
      files: [
        {
          fileId: "file:index",
          path: "index.ts",
          contentHash: sha256Hex(Buffer.from("same\n")),
          ...INTERNAL_LIST_LINEAGE,
          mode: 0o644,
          contentKind: "text" as const,
          byteLength: 5,
          coordinateExtent: 5,
        },
      ],
      nextCursor: null,
    }));
    const bridge = new GitBridge(host);
    vi.spyOn(bridge.git, "getCurrentCommit").mockResolvedValue("a".repeat(40));
    vi.spyOn(bridge.git, "readCommitTree").mockResolvedValue([
      commitBlob(".env", "SECRET=not-imported\n"),
      commitBlob("index.ts", "same\n"),
    ]);
    vi.spyOn(bridge.git, "statusMatrix").mockResolvedValue([
      [".env", 1, 1, 1],
      ["index.ts", 1, 1, 1],
    ]);

    await expect(bridge.importLockedInner(repoPath, {})).rejects.toThrow(
      /Git commit tracks paths excluded from the semantic snapshot \(\.env\)/
    );
    expect(host.vcs.importSnapshot).not.toHaveBeenCalled();
  });

  it("rejects symlinks and other tracked entry kinds the semantic snapshot cannot represent", async () => {
    const repoPath = "projects/demo";
    const dir = path.join(root, repoPath);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, "event:main"));
    const bridge = new GitBridge(host);
    const statusMatrix = vi.spyOn(bridge.git, "statusMatrix");
    vi.spyOn(bridge.git, "getCurrentCommit").mockResolvedValue("a".repeat(40));
    vi.spyOn(bridge.git, "readCommitTree").mockResolvedValue([
      {
        path: "link",
        type: "blob",
        mode: 0o120000,
        oid: "f".repeat(40),
        bytes: Buffer.from("target"),
      },
    ]);

    await expect(bridge.importLockedInner(repoPath, {})).rejects.toThrow(
      /link \(blob, mode 120000\).*only regular files and executable files are importable/
    );
    expect(statusMatrix).not.toHaveBeenCalled();
    expect(host.vcs.importSnapshot).not.toHaveBeenCalled();
  });

  it("imports the immutable commit tree without consulting mutable checkout content", async () => {
    const repoPath = "projects/demo";
    const dir = path.join(root, repoPath);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, "index.ts"), "dirty\n");
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, "event:main"));
    host.vcs.inspect = vi.fn(async ({ node }) => {
      if (node.kind !== "event") throw new Error("unexpected non-event inspection");
      const inspection = eventInspection(node.eventId);
      inspection.node.value.applicationIds = [];
      return inspection;
    });
    host.vcs.importSnapshot = vi.fn(async () =>
      importSnapshotResult({
        eventId: "event:imported",
        applicationId: "application:imported",
        workUnitId: "work:imported",
        sourceUri: "https://example.test/demo.git",
        revision: "b".repeat(40),
        repositoryId: "repository:projects/demo",
      })
    );
    const bridge = new GitBridge(host);
    vi.spyOn(bridge.git, "getCurrentCommit").mockResolvedValue("b".repeat(40));
    vi.spyOn(bridge.git, "readCommitTree").mockResolvedValue([
      commitBlob("index.ts", "committed\n"),
    ]);
    const statusMatrix = vi
      .spyOn(bridge.git, "statusMatrix")
      .mockResolvedValue([["index.ts", 1, 2, 2]]);

    await expect(
      bridge.importLockedInner(repoPath, { sourceUri: "https://example.test/demo.git" })
    ).resolves.toMatchObject({ changed: true });
    expect(host.vcs.importSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ commit: "b".repeat(40) }),
        repositories: [
          expect.objectContaining({
            files: [expect.objectContaining({ path: "index.ts" })],
          }),
        ],
      })
    );
    expect(statusMatrix).not.toHaveBeenCalled();
  });

  it("rejects when HEAD advances after the immutable revision was resolved", async () => {
    const repoPath = "projects/demo";
    const dir = path.join(root, repoPath);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, "event:main"));
    const bridge = new GitBridge(host);
    vi.spyOn(bridge.git, "getCurrentCommit")
      .mockResolvedValueOnce("a".repeat(40))
      .mockResolvedValueOnce("b".repeat(40));
    vi.spyOn(bridge.git, "readCommitTree").mockResolvedValue([
      commitBlob("index.ts", "committed\n"),
    ]);
    vi.spyOn(bridge.git, "statusMatrix").mockResolvedValue([["index.ts", 1, 1, 1]]);

    await expect(bridge.importLockedInner(repoPath, {})).rejects.toThrow(
      /Git HEAD advanced while resolving the snapshot/
    );
    expect(host.vcs.importSnapshot).not.toHaveBeenCalled();
  });

  it("exports one protected-main event snapshot and then observes it as up to date", async () => {
    const repoPath = "projects/demo";
    const dir = path.join(root, repoPath);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    const main = { kind: "event" as const, eventId: "event:main" };
    const repositoryRef = {
      kind: "repository" as const,
      state: main,
      repositoryId: "repository:projects/demo",
    };
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, main.eventId));
    host.vcs.resolveRepository = vi.fn(async ({ state, repoPath: resolvedPath }) => ({
      state,
      repositoryId: repositoryRef.repositoryId,
      repoPath: resolvedPath,
    }));
    host.vcs.inspect = vi.fn(async ({ node }) =>
      node.kind === "repository"
        ? repositoryInspection(main, repoPath)
        : eventInspection(main.eventId)
    );
    host.vcs.listFiles = vi.fn(async () => ({
      state: main,
      repositoryId: repositoryRef.repositoryId,
      files: [
        {
          fileId: "file:index",
          path: "index.ts",
          contentHash: sha256Hex(Buffer.from("exported\n")),
          ...INTERNAL_LIST_LINEAGE,
          mode: 0o755,
          contentKind: "text" as const,
          byteLength: 9,
          coordinateExtent: 9,
        },
      ],
      nextCursor: null,
    }));
    host.vcs.readFile = vi.fn(async () => ({
      repositoryId: repositoryRef.repositoryId,
      fileId: "file:index",
      repoPath,
      path: "index.ts",
      contentHash: sha256Hex(Buffer.from("exported\n")),
      authoredChangeId: "change:exported",
      authoredByWorkUnitId: "work:exported",
      contentClass: "internal" as const,
      externalKeys: [],
      mode: 0o755,
      content: { kind: "text" as const, text: "exported\n" },
    }));
    const bridge = new GitBridge(host);
    vi.spyOn(bridge.git, "getCurrentCommit")
      .mockResolvedValueOnce(null)
      .mockResolvedValue("git:main");
    vi.spyOn(bridge.git, "readCommitTree").mockResolvedValue([
      commitBlob("index.ts", "exported\n", 0o100755),
    ]);
    vi.spyOn(bridge.git, "log").mockResolvedValue([
      {
        oid: "git:main",
        message: `Semantic snapshot\n\nVibestudio-Event: ${main.eventId}`,
        parentOids: [],
        author: { name: "Vibestudio", email: "vibestudio@local", timestamp: 0 },
      },
    ]);
    vi.spyOn(bridge.git, "add").mockResolvedValue(undefined);
    vi.spyOn(bridge.git, "commit").mockResolvedValue("git:main");

    await expect(bridge.exportProtectedRepository(repoPath)).resolves.toEqual({
      exported: 1,
      headCommit: "git:main",
      clobberedLocalEdits: [],
    });
    expect(readFileSync(path.join(dir, "index.ts"), "utf8")).toBe("exported\n");
    await expect(bridge.exportProtectedRepository(repoPath)).resolves.toEqual({
      exported: 0,
      headCommit: "git:main",
      clobberedLocalEdits: [],
    });
    expect(host.vcs.resolveRepository).toHaveBeenCalledTimes(2);
    expect(host.vcs.resolveRepository).toHaveBeenNthCalledWith(1, { state: main, repoPath });
    expect(host.vcs.resolveRepository).toHaveBeenNthCalledWith(2, { state: main, repoPath });
    expect(host.vcs.neighbors).not.toHaveBeenCalled();
    expect(bridge.git.commit).toHaveBeenCalledTimes(1);

    writeFileSync(path.join(dir, "index.ts"), "checkout-only edit\n");
    let previewDir = "";
    await expect(
      bridge.withProtectedExportPreviewLocked(repoPath, {}, async (preview) => {
        previewDir = preview.dir;
        expect(preview.dir).not.toBe(dir);
        return preview.exported;
      })
    ).resolves.toEqual({
      exported: 0,
      headCommit: "git:main",
      clobberedLocalEdits: [],
    });
    expect(readFileSync(path.join(dir, "index.ts"), "utf8")).toBe("checkout-only edit\n");
    expect(() => readFileSync(path.join(previewDir, ".git", "HEAD"), "utf8")).toThrow();
  });

  it("rejects a template source event that is not the current protected main", async () => {
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, "event:main"));
    const bridge = new GitBridge(host);

    await expect(
      bridge.readProtectedRepository("projects/demo", "event:unpublished")
    ).rejects.toThrow(
      "Protected main changed from event:unpublished to event:main before template export"
    );
    expect(host.vcs.resolveRepository).not.toHaveBeenCalled();
  });

  it("reads a multi-repository template publication through one reviewed context", async () => {
    const { host } = baseHost(root);
    let activeRepositoryReads = 0;
    let maximumActiveRepositoryReads = 0;
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, "event:main"));
    host.vcs.resolveRepository = vi.fn(async ({ state, repoPath }) => {
      activeRepositoryReads += 1;
      maximumActiveRepositoryReads = Math.max(maximumActiveRepositoryReads, activeRepositoryReads);
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeRepositoryReads -= 1;
      return {
        state,
        repositoryId: `repository:${repoPath}`,
        repoPath,
      };
    });
    host.vcs.listFiles = vi.fn(async ({ state, repositoryId }) => ({
      state,
      repositoryId,
      files: [],
      nextCursor: null,
    }));
    const bridge = new GitBridge(host);

    await expect(
      bridge.readProtectedRepositories(
        ["panels/news", "workers/news-agent"],
        "event:main",
        "publish-news-v1"
      )
    ).resolves.toEqual([
      expect.objectContaining({ repoPath: "panels/news", eventId: "event:main" }),
      expect.objectContaining({ repoPath: "workers/news-agent", eventId: "event:main" }),
    ]);
    expect(host.ensureContext).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^git-bridge-template-publication-/u)
    );
    expect(host.vcs.status).toHaveBeenCalledTimes(1);
    expect(maximumActiveRepositoryReads).toBe(1);
  });

  it("refuses to export over an unresolved external candidate", async () => {
    const repoPath = "projects/demo";
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => ({
      ...status(contextId, "event:main"),
      committed: { kind: "event" as const, eventId: "event:external-candidate" },
      workingHead: { kind: "event" as const, eventId: "event:external-candidate" },
      mainRelation: "ahead" as const,
    }));
    const bridge = new GitBridge(host);

    await expect(bridge.exportProtectedRepository(repoPath)).rejects.toThrow(
      /candidate event:external-candidate.*git-bridge-.*incrementally integrated/
    );
    expect(host.vcs.inspect).not.toHaveBeenCalled();
  });
});
