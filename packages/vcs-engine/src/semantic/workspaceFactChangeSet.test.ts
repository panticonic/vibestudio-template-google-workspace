import { describe, expect, it } from "vitest";
import {
  planWorkspaceFactChangeSet,
  validateWorkspaceFactChangeSet,
  workspaceFileStateIdentity,
  workspaceRepositoryStateIdentity,
} from "./workspaceFactChangeSet.js";
import { emptyFileManifest } from "./workspaceFactMap.js";

describe("workspace fact change set", () => {
  it("is the sole exact ephemeral mutation value", () => {
    const manifest = emptyFileManifest("repo-1").manifest;
    const repository = workspaceRepositoryStateIdentity({
      repositoryId: "repo-1",
      presence: "present",
      repoPath: "packages/core",
      fileManifestId: manifest.fileManifestId,
    });
    const file = workspaceFileStateIdentity({
      fileId: "file-1",
      presence: "placed",
      repositoryId: "repo-1",
      path: "src/index.ts",
      contentHash: "blob-1",
      mode: 0o100644,
      contentKind: "text",
      byteLength: 8,
      coordinateExtent: 5,
    });
    const result = planWorkspaceFactChangeSet({
      basisWorkspaceFactRootId: "workspace-root-0",
      repositoryUpdates: [{ repositoryId: "repo-1", expected: null, result: repository }],
      manifestUpdates: [
        {
          repositoryId: "repo-1",
          expectedFileManifestId: null,
          resultManifest: manifest,
          pathUpdates: [{ fileId: "file-1", expectedPath: null, resultPath: "src/index.ts" }],
        },
      ],
      fileUpdates: [{ fileId: "file-1", expected: null, result: file }],
    });
    expect(result.kind).toBe("planned");
    if (result.kind === "planned") {
      expect(validateWorkspaceFactChangeSet(result.changeSet)).toEqual({ kind: "valid" });
      expect(result.changeSet).not.toHaveProperty("intentDigest");
      expect(result.changeSet).not.toHaveProperty("deltaDigest");
    }
  });

  it("models tombstones as a prior immutable state edge plus producing change", () => {
    const manifest = emptyFileManifest("repo-1").manifest;
    const presentRepository = workspaceRepositoryStateIdentity({
      repositoryId: "repo-1",
      presence: "present",
      repoPath: "packages/core",
      fileManifestId: manifest.fileManifestId,
    });
    const deletedRepository = workspaceRepositoryStateIdentity({
      repositoryId: "repo-1",
      presence: "deleted",
      priorRepositoryStateId: presentRepository.repositoryStateId,
      tombstoneChangeId: "change-delete-repo",
    });
    const placedFile = workspaceFileStateIdentity({
      fileId: "file-1",
      presence: "placed",
      repositoryId: "repo-1",
      path: "src/index.ts",
      contentHash: "blob-1",
      mode: 0o100644,
      contentKind: "text",
      byteLength: 8,
      coordinateExtent: 5,
    });
    const deletedFile = workspaceFileStateIdentity({
      fileId: "file-1",
      presence: "deleted",
      priorFileStateId: placedFile.fileStateId,
      tombstoneChangeId: "change-delete-file",
    });

    expect(deletedRepository).toEqual(
      expect.objectContaining({
        priorRepositoryStateId: presentRepository.repositoryStateId,
        tombstoneChangeId: "change-delete-repo",
      })
    );
    expect(deletedFile).toEqual(
      expect.objectContaining({
        priorFileStateId: placedFile.fileStateId,
        tombstoneChangeId: "change-delete-file",
      })
    );
    expect(deletedRepository).not.toHaveProperty("lastRepoPath");
    expect(deletedFile).not.toHaveProperty("lastPath");
    expect(deletedFile).not.toHaveProperty("lastRepositoryId");
  });

  it("makes the provenance coordinate extent intrinsic to content state", () => {
    const text = workspaceFileStateIdentity({
      fileId: "file-text",
      presence: "placed",
      repositoryId: "repo-1",
      path: "unicode.txt",
      contentHash: "blob-unicode",
      mode: 0o100644,
      contentKind: "text",
      byteLength: new TextEncoder().encode("a😀éz").byteLength,
      coordinateExtent: "a😀éz".length,
    });
    expect(text).toMatchObject({
      contentKind: "text",
      byteLength: 8,
      coordinateExtent: 5,
    });

    expect(() =>
      workspaceFileStateIdentity({
        fileId: "file-bytes",
        presence: "placed",
        repositoryId: "repo-1",
        path: "asset.bin",
        contentHash: "blob-bytes",
        mode: 0o100644,
        contentKind: "bytes",
        byteLength: 8,
        coordinateExtent: 5,
      })
    ).toThrow("workspace file state failed authentication");
  });

  it("rejects noncanonical change ordering instead of hashing a second representation", () => {
    const manifestA = emptyFileManifest("repo-a").manifest;
    const manifestB = emptyFileManifest("repo-b").manifest;
    const repositoryA = workspaceRepositoryStateIdentity({
      repositoryId: "repo-a",
      presence: "present",
      repoPath: "a",
      fileManifestId: manifestA.fileManifestId,
    });
    const repositoryB = workspaceRepositoryStateIdentity({
      repositoryId: "repo-b",
      presence: "present",
      repoPath: "b",
      fileManifestId: manifestB.fileManifestId,
    });
    const noncanonical = {
      basisWorkspaceFactRootId: "workspace-root-0",
      repositoryUpdates: [
        { repositoryId: "repo-b", expected: null, result: repositoryB },
        { repositoryId: "repo-a", expected: null, result: repositoryA },
      ],
      manifestUpdates: [
        {
          repositoryId: "repo-b",
          expectedFileManifestId: null,
          resultManifest: manifestB,
          pathUpdates: [],
        },
        {
          repositoryId: "repo-a",
          expectedFileManifestId: null,
          resultManifest: manifestA,
          pathUpdates: [],
        },
      ],
      fileUpdates: [],
    };
    expect(validateWorkspaceFactChangeSet(noncanonical)).toMatchObject({
      kind: "invalid",
      failure: { code: "NonCanonical" },
    });
  });
});
