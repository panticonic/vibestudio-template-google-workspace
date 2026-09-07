import { compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import { assertSemanticVcsPathAdmissible } from "@vibestudio/shared/vcs/pathAdmission";
import { compactId } from "./identity.js";
import type { ContentDescriptor } from "./model.js";
import {
  authenticateFileManifest,
  type FileManifestPathUpdate,
  type PersistentFileManifest,
} from "./workspaceFactMap.js";

export type WorkspaceRepositoryMember =
  | {
      repositoryStateId: string;
      repositoryId: string;
      presence: "present";
      repoPath: string;
      fileManifestId: string;
    }
  | {
      repositoryStateId: string;
      repositoryId: string;
      presence: "deleted";
      priorRepositoryStateId: string;
      tombstoneChangeId: string;
    };

export function workspaceRepositoryStateIdentity(
  input:
    | Omit<Extract<WorkspaceRepositoryMember, { presence: "present" }>, "repositoryStateId">
    | Omit<Extract<WorkspaceRepositoryMember, { presence: "deleted" }>, "repositoryStateId">
): WorkspaceRepositoryMember {
  const value = {
    repositoryStateId: compactId("workspace-repository-state", input),
    ...input,
  } as WorkspaceRepositoryMember;
  authenticateWorkspaceRepositoryMember(value);
  return value;
}

export function authenticateWorkspaceRepositoryMember(
  member: WorkspaceRepositoryMember
): WorkspaceRepositoryMember {
  if (
    !member.repositoryId ||
    repositoryStateId(member) !== member.repositoryStateId ||
    (member.presence === "present"
      ? !validPath(member.repoPath) || !member.fileManifestId
      : !member.priorRepositoryStateId || !member.tombstoneChangeId)
  ) {
    throw new Error("workspace repository state failed authentication");
  }
  return { ...member };
}

const repositoryStateId = (member: WorkspaceRepositoryMember): string => {
  const { repositoryStateId: _identity, ...payload } = member;
  return compactId("workspace-repository-state", payload);
};

export interface WorkspaceFile extends ContentDescriptor {
  fileId: string;
  path: string;
  contentHash: string;
  mode: number;
}

export type WorkspaceFileState =
  | ({
      fileStateId: string;
      fileId: string;
      presence: "placed";
      repositoryId: string;
      path: string;
      contentHash: string;
      mode: number;
    } & ContentDescriptor)
  | {
      fileStateId: string;
      fileId: string;
      presence: "deleted";
      priorFileStateId: string;
      tombstoneChangeId: string;
    };

export function workspaceFileStateIdentity(
  input:
    | Omit<Extract<WorkspaceFileState, { presence: "placed" }>, "fileStateId">
    | Omit<Extract<WorkspaceFileState, { presence: "deleted" }>, "fileStateId">
): WorkspaceFileState {
  const value = {
    fileStateId: compactId("workspace-file-state", input),
    ...input,
  } as WorkspaceFileState;
  authenticateWorkspaceFileState(value);
  return value;
}

export function authenticateWorkspaceFileState(state: WorkspaceFileState): WorkspaceFileState {
  const { fileStateId: _identity, ...payload } = state;
  if (
    !state.fileId ||
    compactId("workspace-file-state", payload) !== state.fileStateId ||
    (state.presence === "placed"
      ? !state.repositoryId ||
        !validPath(state.path) ||
        !state.contentHash ||
        !Number.isSafeInteger(state.mode) ||
        state.mode < 0 ||
        (state.contentKind !== "text" && state.contentKind !== "bytes") ||
        !Number.isSafeInteger(state.byteLength) ||
        state.byteLength < 0 ||
        !Number.isSafeInteger(state.coordinateExtent) ||
        state.coordinateExtent < 0 ||
        (state.contentKind === "bytes" && state.coordinateExtent !== state.byteLength)
      : !state.priorFileStateId || !state.tombstoneChangeId)
  ) {
    throw new Error("workspace file state failed authentication");
  }
  return { ...state };
}

export interface WorkspaceFileChange {
  fileId: string;
  expected: WorkspaceFile | null;
  result: WorkspaceFile | null;
}

export interface WorkspaceFileObservation {
  repositoryId: string;
  file: WorkspaceFile | null;
}

export interface WorkspaceRepositoryChange {
  repositoryId: string;
  expected: WorkspaceRepositoryMember | null;
  result: WorkspaceRepositoryMember;
}

export interface WorkspaceFileStateChange {
  fileId: string;
  expected: WorkspaceFileState | null;
  result: WorkspaceFileState;
}

export interface WorkspaceManifestChange {
  repositoryId: string;
  expectedFileManifestId: string | null;
  resultManifest: PersistentFileManifest;
  pathUpdates: readonly FileManifestPathUpdate[];
}

/** The only workspace-state mutation value. It is an ephemeral exact patch
 * over one authenticated fact root; the resulting root is the commitment. */
export interface WorkspaceFactChangeSet {
  basisWorkspaceFactRootId: string;
  repositoryUpdates: readonly WorkspaceRepositoryChange[];
  manifestUpdates: readonly WorkspaceManifestChange[];
  fileUpdates: readonly WorkspaceFileStateChange[];
}

export type WorkspaceFactFailureCode =
  | "InvalidBasis"
  | "EmptyChangeSet"
  | "DuplicateRepository"
  | "InvalidRepositoryMember"
  | "DuplicateFile"
  | "InvalidFile"
  | "NoEffect"
  | "ResultCoverageInvalid"
  | "NonCanonical";

export interface WorkspaceFactFailure {
  code: WorkspaceFactFailureCode;
  message: string;
  handles: readonly string[];
}

export type WorkspaceFactChangeSetResult =
  | { kind: "planned"; changeSet: WorkspaceFactChangeSet }
  | { kind: "refused"; failure: WorkspaceFactFailure };

const validPath = (path: string): boolean => {
  try {
    assertSemanticVcsPathAdmissible(path);
    return path.length > 0;
  } catch {
    return false;
  }
};

const refusal = (
  code: WorkspaceFactFailureCode,
  message: string,
  handles: readonly string[] = []
): WorkspaceFactChangeSetResult => ({
  kind: "refused",
  failure: {
    code,
    message,
    handles: [...new Set(handles)].sort(compareUtf16CodeUnits),
  },
});

const validRepository = (member: WorkspaceRepositoryMember | null): boolean => {
  if (!member) return true;
  try {
    authenticateWorkspaceRepositoryMember(member);
    return true;
  } catch {
    return false;
  }
};

const validFile = (state: WorkspaceFileState | null): boolean => {
  if (!state) return true;
  try {
    authenticateWorkspaceFileState(state);
    return true;
  } catch {
    return false;
  }
};

const canonicalRepositories = (
  updates: readonly WorkspaceRepositoryChange[]
): WorkspaceRepositoryChange[] =>
  [...updates]
    .map((update) => ({
      repositoryId: update.repositoryId,
      expected: update.expected ? { ...update.expected } : null,
      result: { ...update.result },
    }))
    .sort((left, right) => compareUtf16CodeUnits(left.repositoryId, right.repositoryId));

const canonicalFiles = (updates: readonly WorkspaceFileStateChange[]): WorkspaceFileStateChange[] =>
  [...updates]
    .map((update) => ({
      fileId: update.fileId,
      expected: update.expected ? { ...update.expected } : null,
      result: { ...update.result },
    }))
    .sort((left, right) => compareUtf16CodeUnits(left.fileId, right.fileId));

const canonicalManifests = (
  updates: readonly WorkspaceManifestChange[]
): WorkspaceManifestChange[] =>
  [...updates]
    .map((update) => ({
      repositoryId: update.repositoryId,
      expectedFileManifestId: update.expectedFileManifestId,
      resultManifest: { ...update.resultManifest },
      pathUpdates: [...update.pathUpdates]
        .map((pathUpdate) => ({ ...pathUpdate }))
        .sort((left, right) => compareUtf16CodeUnits(left.fileId, right.fileId)),
    }))
    .sort((left, right) => compareUtf16CodeUnits(left.repositoryId, right.repositoryId));

export function planWorkspaceFactChangeSet(
  input: WorkspaceFactChangeSet
): WorkspaceFactChangeSetResult {
  if (!input.basisWorkspaceFactRootId) {
    return refusal("InvalidBasis", "workspace fact basis is empty");
  }
  if (input.repositoryUpdates.length === 0 && input.fileUpdates.length === 0) {
    return refusal("EmptyChangeSet", "workspace fact change set is empty");
  }
  const repositoryUpdates = canonicalRepositories(input.repositoryUpdates);
  const fileUpdates = canonicalFiles(input.fileUpdates);
  const manifestUpdates = canonicalManifests(input.manifestUpdates);
  if (
    new Set(repositoryUpdates.map((update) => update.repositoryId)).size !==
      repositoryUpdates.length ||
    repositoryUpdates.some(
      (update) =>
        !update.repositoryId ||
        !validRepository(update.expected) ||
        !validRepository(update.result) ||
        update.result.repositoryId !== update.repositoryId ||
        (update.expected?.repositoryId !== undefined &&
          update.expected.repositoryId !== update.repositoryId) ||
        update.expected?.repositoryStateId === update.result.repositoryStateId
    )
  ) {
    return refusal(
      "InvalidRepositoryMember",
      "workspace fact change contains a duplicate, invalid, or unchanged repository state"
    );
  }
  if (
    new Set(fileUpdates.map((update) => update.fileId)).size !== fileUpdates.length ||
    fileUpdates.some(
      (update) =>
        !update.fileId ||
        !validFile(update.expected) ||
        !validFile(update.result) ||
        update.result.fileId !== update.fileId ||
        (update.expected?.fileId !== undefined && update.expected.fileId !== update.fileId) ||
        update.expected?.fileStateId === update.result.fileStateId
    )
  ) {
    return refusal(
      "InvalidFile",
      "workspace fact change contains a duplicate, invalid, or unchanged file state"
    );
  }
  if (
    new Set(manifestUpdates.map((update) => update.repositoryId)).size !== manifestUpdates.length ||
    manifestUpdates.some((update) => {
      try {
        authenticateFileManifest(update.resultManifest);
      } catch {
        return true;
      }
      const result = repositoryUpdates.find(
        (candidate) => candidate.repositoryId === update.repositoryId
      )?.result;
      return (
        !result ||
        result.presence !== "present" ||
        result.fileManifestId !== update.resultManifest.fileManifestId ||
        update.resultManifest.repositoryId !== update.repositoryId ||
        new Set(update.pathUpdates.map((pathUpdate) => pathUpdate.fileId)).size !==
          update.pathUpdates.length
      );
    })
  ) {
    return refusal(
      "ResultCoverageInvalid",
      "manifest changes do not exactly match their repository results"
    );
  }
  return {
    kind: "planned",
    changeSet: {
      basisWorkspaceFactRootId: input.basisWorkspaceFactRootId,
      repositoryUpdates,
      manifestUpdates,
      fileUpdates,
    },
  };
}

export function validateWorkspaceFactChangeSet(
  value: WorkspaceFactChangeSet
): { kind: "valid" } | { kind: "invalid"; failure: WorkspaceFactFailure } {
  const planned = planWorkspaceFactChangeSet(value);
  if (planned.kind === "refused") return { kind: "invalid", failure: planned.failure };
  if (JSON.stringify(planned.changeSet) !== JSON.stringify(value)) {
    return {
      kind: "invalid",
      failure: {
        code: "NonCanonical",
        message: "workspace fact change set is not canonical",
        handles: [value.basisWorkspaceFactRootId],
      },
    };
  }
  return { kind: "valid" };
}
