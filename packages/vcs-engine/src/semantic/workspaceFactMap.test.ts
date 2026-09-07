import { describe, expect, it } from "vitest";
import {
  authenticateWorkspaceFactRoot,
  composeFileManifest,
  composeWorkspaceFacts,
  emptyFileManifest,
  emptyWorkspaceFactRoot,
  fileManifestEntryAt,
  workspaceFactRootIdentity,
  workspaceFactFileEntryAt,
  workspaceFactRepositoryAtPath,
  workspaceFactRepositoryEntryAt,
} from "./workspaceFactMap.js";
import {
  persistentRadixNodeIdentity,
  type PersistentRadixNode,
  type PersistentRadixNodeReader,
} from "./persistentRadix.js";

function memoryReader(nodes: Map<string, PersistentRadixNode>): PersistentRadixNodeReader {
  return (_kind, _route, nodeId) => nodes.get(nodeId) ?? null;
}

describe("workspace fact root", () => {
  it("updates repository, live-path, and file facts atomically in one radix", () => {
    const empty = emptyWorkspaceFactRoot();
    const nodes = new Map(empty.nodes.map((node) => [node.nodeId, node]));
    const proof = composeWorkspaceFacts({
      basis: empty.root,
      update: {
        repositoryUpdates: [
          {
            repositoryId: "repo-1",
            expectedRepositoryStateId: null,
            resultRepositoryStateId: "repository-state-1",
            expectedRepoPath: null,
            resultRepoPath: "packages/core",
          },
        ],
        fileUpdates: [
          {
            fileId: "file-1",
            expectedFileStateId: null,
            resultFileStateId: "file-state-1",
          },
        ],
      },
      readNode: memoryReader(nodes),
    });
    for (const node of proof.createdNodes) nodes.set(node.nodeId, node);

    expect(proof.resultRoot.entryCount).toBe(3);
    expect(proof.resultRoot).toMatchObject({
      repositoryCount: 1,
      livePathCount: 1,
      fileCount: 1,
    });
    expect(proof.createdNodes.every((node) => node.routeStrategy === "utf16")).toBe(true);
    expect(
      workspaceFactRepositoryEntryAt({
        root: proof.resultRoot,
        repositoryId: "repo-1",
        readNode: memoryReader(nodes),
      })
    ).toEqual({ repositoryId: "repo-1", repositoryStateId: "repository-state-1" });
    expect(
      workspaceFactRepositoryAtPath({
        root: proof.resultRoot,
        repoPath: "packages/core",
        readNode: memoryReader(nodes),
      })
    ).toBe("repo-1");
    expect(
      workspaceFactFileEntryAt({
        root: proof.resultRoot,
        fileId: "file-1",
        readNode: memoryReader(nodes),
      })
    ).toEqual({ fileId: "file-1", fileStateId: "file-state-1" });
  });

  it("moves a live repository path without creating a second aggregate root", () => {
    const empty = emptyWorkspaceFactRoot();
    const nodes = new Map(empty.nodes.map((node) => [node.nodeId, node]));
    const first = composeWorkspaceFacts({
      basis: empty.root,
      update: {
        repositoryUpdates: [
          {
            repositoryId: "repo-1",
            expectedRepositoryStateId: null,
            resultRepositoryStateId: "repository-state-1",
            expectedRepoPath: null,
            resultRepoPath: "old",
          },
        ],
        fileUpdates: [],
      },
      readNode: memoryReader(nodes),
    });
    for (const node of first.createdNodes) nodes.set(node.nodeId, node);
    const moved = composeWorkspaceFacts({
      basis: first.resultRoot,
      update: {
        repositoryUpdates: [
          {
            repositoryId: "repo-1",
            expectedRepositoryStateId: "repository-state-1",
            resultRepositoryStateId: "repository-state-2",
            expectedRepoPath: "old",
            resultRepoPath: "new",
          },
        ],
        fileUpdates: [],
      },
      readNode: memoryReader(nodes),
    });
    for (const node of moved.createdNodes) nodes.set(node.nodeId, node);

    expect(
      workspaceFactRepositoryAtPath({
        root: moved.resultRoot,
        repoPath: "old",
        readNode: memoryReader(nodes),
      })
    ).toBeNull();
    expect(
      workspaceFactRepositoryAtPath({
        root: moved.resultRoot,
        repoPath: "new",
        readNode: memoryReader(nodes),
      })
    ).toBe("repo-1");
    expect(moved.resultRoot.entryCount).toBe(2);
  });

  it("stores file identity, not file-state identity, in path manifests", () => {
    const empty = emptyFileManifest("repo-1");
    const nodes = new Map([[empty.node.nodeId, empty.node]]);
    const proof = composeFileManifest({
      basis: empty.manifest,
      updates: [{ fileId: "file-1", expectedPath: null, resultPath: "src/a.ts" }],
      readNode: memoryReader(nodes),
    });
    for (const node of proof.createdNodes) nodes.set(node.nodeId, node);
    expect(
      fileManifestEntryAt({
        manifest: proof.resultManifest,
        path: "src/a.ts",
        readNode: memoryReader(nodes),
      })
    ).toEqual({ path: "src/a.ts", fileId: "file-1" });
  });

  it("swaps two manifest owners atomically", () => {
    const empty = emptyFileManifest("repo-1");
    const nodes = new Map([[empty.node.nodeId, empty.node]]);
    const initial = composeFileManifest({
      basis: empty.manifest,
      updates: [
        { fileId: "file-a", expectedPath: null, resultPath: "a.ts" },
        { fileId: "file-b", expectedPath: null, resultPath: "b.ts" },
      ],
      readNode: memoryReader(nodes),
    });
    for (const node of initial.createdNodes) nodes.set(node.nodeId, node);
    const swapped = composeFileManifest({
      basis: initial.resultManifest,
      updates: [
        { fileId: "file-a", expectedPath: "a.ts", resultPath: "b.ts" },
        { fileId: "file-b", expectedPath: "b.ts", resultPath: "a.ts" },
      ],
      readNode: memoryReader(nodes),
    });
    for (const node of swapped.createdNodes) nodes.set(node.nodeId, node);

    expect(
      fileManifestEntryAt({
        manifest: swapped.resultManifest,
        path: "a.ts",
        readNode: memoryReader(nodes),
      })
    ).toEqual({ path: "a.ts", fileId: "file-b" });
    expect(
      fileManifestEntryAt({
        manifest: swapped.resultManifest,
        path: "b.ts",
        readNode: memoryReader(nodes),
      })
    ).toEqual({ path: "b.ts", fileId: "file-a" });
  });

  it("authenticates roots using their identity without a duplicate digest", () => {
    const { root } = emptyWorkspaceFactRoot();
    expect(() => authenticateWorkspaceFactRoot(root)).not.toThrow();
    expect(() => authenticateWorkspaceFactRoot({ ...root, entryCount: 1 })).toThrow();
  });

  it("makes the lexical aggregate distribution part of the pre-release root identity", () => {
    const empty = emptyWorkspaceFactRoot();
    const nodes = new Map(empty.nodes.map((node) => [node.nodeId, node]));
    const proof = composeWorkspaceFacts({
      basis: empty.root,
      update: {
        repositoryUpdates: [
          {
            repositoryId: "repo-1",
            expectedRepositoryStateId: null,
            resultRepositoryStateId: "repository-state-1",
            expectedRepoPath: null,
            resultRepoPath: null,
          },
        ],
        fileUpdates: [],
      },
      readNode: memoryReader(nodes),
    });
    const redistributed = workspaceFactRootIdentity({
      ...proof.resultRoot,
      repositoryCount: 0,
      fileCount: 1,
    });

    expect(redistributed.workspaceFactRootId).not.toBe(proof.resultRoot.workspaceFactRootId);
  });

  it("makes the generic radix route strategy part of node identity", () => {
    const hashed = persistentRadixNodeIdentity("example", "hashed", { kind: "empty" });
    const lexical = persistentRadixNodeIdentity("example", "utf16", { kind: "empty" });
    expect(hashed.nodeId).not.toBe(lexical.nodeId);
  });
});
