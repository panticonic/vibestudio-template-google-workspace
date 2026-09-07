import { compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import { compactId } from "./identity.js";
import {
  composePersistentRadix,
  emptyPersistentRadixRoot,
  persistentRadixEntryAt,
  persistentRadixRootIdentity,
  type PersistentRadixMutationProof,
  type PersistentRadixNode,
  type PersistentRadixNodeReader,
  type PersistentRadixRoot,
  type PersistentRadixUpdate,
} from "./persistentRadix.js";

const WORKSPACE_FACT_INDEX = "workspace-fact";
const MANIFEST_PATH_INDEX = "manifest-path";

type WorkspaceFactKind = "repository" | "live-path" | "file";

const factKey = (kind: WorkspaceFactKind, identity: string): string => {
  if (!identity) throw new WorkspaceFactError("InvalidUpdate", "fact identity is empty");
  return `${kind}:${identity}`;
};

export interface WorkspaceFactRoot {
  workspaceFactRootId: string;
  rootNodeId: string;
  entryCount: number;
  repositoryCount: number;
  livePathCount: number;
  fileCount: number;
}

export interface WorkspaceRepositoryFactUpdate {
  repositoryId: string;
  expectedRepositoryStateId: string | null;
  resultRepositoryStateId: string;
  expectedRepoPath: string | null;
  resultRepoPath: string | null;
}

export interface WorkspaceFileUpdate {
  fileId: string;
  expectedFileStateId: string | null;
  resultFileStateId: string;
}

export interface WorkspaceFactIndexUpdate {
  repositoryUpdates: readonly WorkspaceRepositoryFactUpdate[];
  fileUpdates: readonly WorkspaceFileUpdate[];
}

export interface WorkspaceFactMutation {
  basisWorkspaceFactRootId: string;
  resultRoot: WorkspaceFactRoot;
  update: WorkspaceFactIndexUpdate;
  createdNodes: readonly PersistentRadixNode[];
  reusedNodeIds: readonly string[];
}

export class WorkspaceFactError extends Error {
  constructor(
    readonly code:
      | "InvalidRoot"
      | "InvalidUpdate"
      | "ExpectedMemberMismatch"
      | "DestinationOccupied",
    message: string,
    readonly handles: readonly string[] = []
  ) {
    super(message);
    this.name = "WorkspaceFactError";
  }
}

export function workspaceFactRootIdentity(input: {
  rootNodeId: string;
  entryCount: number;
  repositoryCount: number;
  livePathCount: number;
  fileCount: number;
}): WorkspaceFactRoot {
  if (
    !input.rootNodeId ||
    !Number.isSafeInteger(input.entryCount) ||
    input.entryCount < 0 ||
    !Number.isSafeInteger(input.repositoryCount) ||
    input.repositoryCount < 0 ||
    !Number.isSafeInteger(input.livePathCount) ||
    input.livePathCount < 0 ||
    !Number.isSafeInteger(input.fileCount) ||
    input.fileCount < 0 ||
    input.entryCount !== input.repositoryCount + input.livePathCount + input.fileCount
  ) {
    throw new WorkspaceFactError("InvalidRoot", "workspace fact root is invalid");
  }
  const payload = {
    rootNodeId: input.rootNodeId,
    entryCount: input.entryCount,
    repositoryCount: input.repositoryCount,
    livePathCount: input.livePathCount,
    fileCount: input.fileCount,
  };
  return { workspaceFactRootId: compactId("workspace-facts", payload), ...payload };
}

export function authenticateWorkspaceFactRoot(root: WorkspaceFactRoot): void {
  const exact = workspaceFactRootIdentity(root);
  if (exact.workspaceFactRootId !== root.workspaceFactRootId) {
    throw new WorkspaceFactError(
      "InvalidRoot",
      `workspace fact root ${root.workspaceFactRootId} failed authentication`,
      [root.workspaceFactRootId]
    );
  }
}

export function workspaceFactRadixRoot(root: WorkspaceFactRoot): PersistentRadixRoot {
  authenticateWorkspaceFactRoot(root);
  return persistentRadixRootIdentity({
    indexKind: WORKSPACE_FACT_INDEX,
    routeStrategy: "utf16",
    rootNodeId: root.rootNodeId,
    entryCount: root.entryCount,
  });
}

export function emptyWorkspaceFactRoot(): {
  root: WorkspaceFactRoot;
  nodes: readonly [PersistentRadixNode];
} {
  const empty = emptyPersistentRadixRoot(WORKSPACE_FACT_INDEX, "utf16");
  return {
    root: workspaceFactRootIdentity({
      rootNodeId: empty.node.nodeId,
      entryCount: 0,
      repositoryCount: 0,
      livePathCount: 0,
      fileCount: 0,
    }),
    nodes: [empty.node],
  };
}

const canonicalRepositoryUpdates = (
  updates: readonly WorkspaceRepositoryFactUpdate[]
): WorkspaceRepositoryFactUpdate[] =>
  [...updates]
    .map((update) => ({ ...update }))
    .sort((left, right) => compareUtf16CodeUnits(left.repositoryId, right.repositoryId));

const canonicalFileUpdates = (updates: readonly WorkspaceFileUpdate[]): WorkspaceFileUpdate[] =>
  [...updates]
    .map((update) => ({ ...update }))
    .sort((left, right) => compareUtf16CodeUnits(left.fileId, right.fileId));

function pathUpdatesForRepositories(
  updates: readonly WorkspaceRepositoryFactUpdate[]
): PersistentRadixUpdate[] {
  const paths = new Map<string, PersistentRadixUpdate>();
  for (const update of updates) {
    if (update.expectedRepoPath) {
      const key = factKey("live-path", update.expectedRepoPath);
      const current = paths.get(key);
      if (current && current.expectedValue !== update.repositoryId) {
        throw new WorkspaceFactError(
          "ExpectedMemberMismatch",
          `repository path ${update.expectedRepoPath} has conflicting expected owners`
        );
      }
      paths.set(key, {
        key,
        expectedValue: update.repositoryId,
        resultValue: current?.resultValue ?? null,
      });
    }
    if (update.resultRepoPath) {
      const key = factKey("live-path", update.resultRepoPath);
      const current = paths.get(key);
      if (current?.resultValue && current.resultValue !== update.repositoryId) {
        throw new WorkspaceFactError(
          "DestinationOccupied",
          `repository path ${update.resultRepoPath} has multiple result owners`
        );
      }
      paths.set(key, {
        key,
        expectedValue: current?.expectedValue ?? null,
        resultValue: update.repositoryId,
      });
    }
  }
  return [...paths.values()].filter((update) => update.expectedValue !== update.resultValue);
}

export function composeWorkspaceFacts(input: {
  basis: WorkspaceFactRoot;
  update: WorkspaceFactIndexUpdate;
  readNode: PersistentRadixNodeReader;
}): WorkspaceFactMutation {
  authenticateWorkspaceFactRoot(input.basis);
  const repositoryUpdates = canonicalRepositoryUpdates(input.update.repositoryUpdates);
  const fileUpdates = canonicalFileUpdates(input.update.fileUpdates);
  if (
    (repositoryUpdates.length === 0 && fileUpdates.length === 0) ||
    repositoryUpdates.some(
      (update, index) =>
        !update.repositoryId ||
        !update.resultRepositoryStateId ||
        update.expectedRepositoryStateId === update.resultRepositoryStateId ||
        (index > 0 && repositoryUpdates[index - 1]!.repositoryId === update.repositoryId)
    ) ||
    fileUpdates.some(
      (update, index) =>
        !update.fileId ||
        !update.resultFileStateId ||
        update.expectedFileStateId === update.resultFileStateId ||
        (index > 0 && fileUpdates[index - 1]!.fileId === update.fileId)
    )
  ) {
    throw new WorkspaceFactError(
      "InvalidUpdate",
      "workspace fact update is empty, duplicate, incomplete, or effect-free"
    );
  }

  const pathUpdates = pathUpdatesForRepositories(repositoryUpdates);
  const updates: PersistentRadixUpdate[] = [
    ...repositoryUpdates.map((update) => ({
      key: factKey("repository", update.repositoryId),
      expectedValue: update.expectedRepositoryStateId,
      resultValue: update.resultRepositoryStateId,
    })),
    ...pathUpdates,
    ...fileUpdates.map((update) => ({
      key: factKey("file", update.fileId),
      expectedValue: update.expectedFileStateId,
      resultValue: update.resultFileStateId,
    })),
  ];
  const proof: PersistentRadixMutationProof = composePersistentRadix({
    basis: workspaceFactRadixRoot(input.basis),
    updates,
    readNode: input.readNode,
  });

  const resultRoot = workspaceFactRootIdentity({
    rootNodeId: proof.resultRoot.rootNodeId,
    entryCount: proof.resultRoot.entryCount,
    repositoryCount:
      input.basis.repositoryCount +
      repositoryUpdates.filter((update) => update.expectedRepositoryStateId === null).length,
    livePathCount:
      input.basis.livePathCount +
      pathUpdates.reduce(
        (count, update) =>
          count + (update.expectedValue === null ? 1 : 0) - (update.resultValue === null ? 1 : 0),
        0
      ),
    fileCount:
      input.basis.fileCount +
      fileUpdates.filter((update) => update.expectedFileStateId === null).length,
  });
  return {
    basisWorkspaceFactRootId: input.basis.workspaceFactRootId,
    resultRoot,
    update: { repositoryUpdates, fileUpdates },
    createdNodes: proof.createdNodes,
    reusedNodeIds: proof.reusedNodeIds,
  };
}

function factEntry(input: {
  root: WorkspaceFactRoot;
  kind: WorkspaceFactKind;
  identity: string;
  readNode: PersistentRadixNodeReader;
}) {
  return persistentRadixEntryAt({
    root: workspaceFactRadixRoot(input.root),
    key: factKey(input.kind, input.identity),
    readNode: input.readNode,
  });
}

export function workspaceFactRepositoryEntryAt(input: {
  root: WorkspaceFactRoot;
  repositoryId: string;
  readNode: PersistentRadixNodeReader;
}): { repositoryId: string; repositoryStateId: string } | null {
  const entry = factEntry({ ...input, kind: "repository", identity: input.repositoryId });
  return entry ? { repositoryId: input.repositoryId, repositoryStateId: entry.value } : null;
}

export function workspaceFactRepositoryAtPath(input: {
  root: WorkspaceFactRoot;
  repoPath: string;
  readNode: PersistentRadixNodeReader;
}): string | null {
  return factEntry({ ...input, kind: "live-path", identity: input.repoPath })?.value ?? null;
}

export function workspaceFactFileEntryAt(input: {
  root: WorkspaceFactRoot;
  fileId: string;
  readNode: PersistentRadixNodeReader;
}): { fileId: string; fileStateId: string } | null {
  const entry = factEntry({ ...input, kind: "file", identity: input.fileId });
  return entry ? { fileId: input.fileId, fileStateId: entry.value } : null;
}

export interface PersistentFileManifest {
  fileManifestId: string;
  repositoryId: string;
  pathRootNodeId: string;
  entryCount: number;
}

export interface FileManifestPathUpdate {
  fileId: string;
  expectedPath: string | null;
  resultPath: string | null;
}

export interface FileManifestMutationProof {
  basisFileManifestId: string;
  resultManifest: PersistentFileManifest;
  updates: readonly FileManifestPathUpdate[];
  createdNodes: readonly PersistentRadixNode[];
  reusedNodeIds: readonly string[];
}

export function fileManifestIdentity(input: {
  repositoryId: string;
  pathRootNodeId: string;
  entryCount: number;
}): PersistentFileManifest {
  if (
    !input.repositoryId ||
    !input.pathRootNodeId ||
    !Number.isSafeInteger(input.entryCount) ||
    input.entryCount < 0
  ) {
    throw new WorkspaceFactError("InvalidRoot", "file manifest root is invalid");
  }
  const payload = {
    repositoryId: input.repositoryId,
    pathRootNodeId: input.pathRootNodeId,
    entryCount: input.entryCount,
  };
  return { fileManifestId: compactId("file-manifest", payload), ...payload };
}

export function authenticateFileManifest(manifest: PersistentFileManifest): void {
  if (fileManifestIdentity(manifest).fileManifestId !== manifest.fileManifestId) {
    throw new WorkspaceFactError(
      "InvalidRoot",
      `file manifest ${manifest.fileManifestId} failed authentication`,
      [manifest.fileManifestId]
    );
  }
}

function manifestRoot(manifest: PersistentFileManifest): PersistentRadixRoot {
  authenticateFileManifest(manifest);
  return persistentRadixRootIdentity({
    indexKind: MANIFEST_PATH_INDEX,
    routeStrategy: "utf16",
    rootNodeId: manifest.pathRootNodeId,
    entryCount: manifest.entryCount,
  });
}

export function emptyFileManifest(repositoryId: string): {
  manifest: PersistentFileManifest;
  node: PersistentRadixNode;
} {
  const empty = emptyPersistentRadixRoot(MANIFEST_PATH_INDEX, "utf16");
  return {
    manifest: fileManifestIdentity({
      repositoryId,
      pathRootNodeId: empty.node.nodeId,
      entryCount: 0,
    }),
    node: empty.node,
  };
}

const canonicalManifestUpdates = (
  updates: readonly FileManifestPathUpdate[]
): FileManifestPathUpdate[] =>
  [...updates]
    .map((update) => ({ ...update }))
    .sort((left, right) => compareUtf16CodeUnits(left.fileId, right.fileId));

function manifestRadixUpdates(updates: readonly FileManifestPathUpdate[]): PersistentRadixUpdate[] {
  const paths = new Map<string, PersistentRadixUpdate>();
  for (const update of updates) {
    if (update.expectedPath) {
      const current = paths.get(update.expectedPath);
      if (
        current?.expectedValue !== null &&
        current?.expectedValue !== undefined &&
        current.expectedValue !== update.fileId
      ) {
        throw new WorkspaceFactError(
          "ExpectedMemberMismatch",
          `manifest path ${update.expectedPath} has conflicting expected owners`
        );
      }
      paths.set(update.expectedPath, {
        key: update.expectedPath,
        expectedValue: update.fileId,
        resultValue: current?.resultValue ?? null,
      });
    }
    if (update.resultPath) {
      const current = paths.get(update.resultPath);
      if (current?.resultValue && current.resultValue !== update.fileId) {
        throw new WorkspaceFactError(
          "DestinationOccupied",
          `manifest path ${update.resultPath} has multiple result owners`
        );
      }
      paths.set(update.resultPath, {
        key: update.resultPath,
        expectedValue: current?.expectedValue ?? null,
        resultValue: update.fileId,
      });
    }
  }
  return [...paths.values()].filter((update) => update.expectedValue !== update.resultValue);
}

export function composeFileManifest(input: {
  basis: PersistentFileManifest;
  updates: readonly FileManifestPathUpdate[];
  readNode: PersistentRadixNodeReader;
}): FileManifestMutationProof {
  authenticateFileManifest(input.basis);
  const updates = canonicalManifestUpdates(input.updates);
  if (updates.length === 0) {
    throw new WorkspaceFactError("InvalidUpdate", "file manifest update is empty");
  }
  for (const [index, update] of updates.entries()) {
    if (!update.fileId) {
      throw new WorkspaceFactError("InvalidUpdate", "file manifest update has no file identity");
    }
    if (index > 0 && updates[index - 1]!.fileId === update.fileId) {
      throw new WorkspaceFactError(
        "InvalidUpdate",
        `file manifest updates duplicate ${update.fileId}`,
        [update.fileId]
      );
    }
    if (update.expectedPath === update.resultPath) {
      throw new WorkspaceFactError(
        "InvalidUpdate",
        `file manifest update for ${update.fileId} has no effect`,
        [update.fileId]
      );
    }
  }
  const proof = composePersistentRadix({
    basis: manifestRoot(input.basis),
    updates: manifestRadixUpdates(updates),
    readNode: input.readNode,
  });
  return {
    basisFileManifestId: input.basis.fileManifestId,
    resultManifest: fileManifestIdentity({
      repositoryId: input.basis.repositoryId,
      pathRootNodeId: proof.resultRoot.rootNodeId,
      entryCount: proof.resultRoot.entryCount,
    }),
    updates,
    createdNodes: proof.createdNodes,
    reusedNodeIds: proof.reusedNodeIds,
  };
}

export function fileManifestEntryAt(input: {
  manifest: PersistentFileManifest;
  path: string;
  readNode: PersistentRadixNodeReader;
}): { path: string; fileId: string } | null {
  const entry = persistentRadixEntryAt({
    root: manifestRoot(input.manifest),
    key: input.path,
    readNode: input.readNode,
  });
  return entry ? { path: entry.key, fileId: entry.value } : null;
}
