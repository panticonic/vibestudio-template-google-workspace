import type { VcsResolveRepositoryResult, VcsStateNodeRef } from "@vibestudio/service-schemas/vcs";
import { splitRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import type { ToolVcs } from "./tools/tool-vcs.js";

export type PresentToolRepository = NonNullable<VcsResolveRepositoryResult>;

const stateNodeLabel = (state: VcsStateNodeRef): string =>
  state.kind === "event" ? state.eventId : state.applicationId;

export async function resolveToolRepository(
  vcs: Pick<ToolVcs, "resolveRepository">,
  state: VcsStateNodeRef,
  repoPath: string
): Promise<PresentToolRepository> {
  if (repoPath.length === 0) {
    const message = "The workspace root is not a repository. Pass one exact repository path.";
    throw Object.assign(new Error(message), {
      code: "InvalidReference",
      errorData: {
        code: "InvalidReference",
        message,
        referenceKind: "repository-path",
        reference: repoPath,
      },
    });
  }
  const repository = await vcs.resolveRepository({ state, repoPath });
  if (repository) return repository;
  const message = `Repository ${repoPath} is not present at ${stateNodeLabel(state)}. Re-list the containing directory and use the exact repository path it returns.`;
  throw Object.assign(new Error(message), {
    code: "InvalidReference",
    errorData: {
      code: "InvalidReference",
      message,
      referenceKind: "repository-path",
      reference: repoPath,
    },
  });
}

export interface ToolFileResolution {
  state: VcsStateNodeRef;
  repositoryId: string;
  repoPath: string;
  fileId: string;
  path: string;
  contentHash: string;
  mode: number;
  content: { kind: "text"; text: string } | { kind: "bytes"; base64: string };
}

export async function resolveToolFile(
  vcs: Pick<ToolVcs, "resolveRepository" | "readFile">,
  state: VcsStateNodeRef,
  workspacePath: string
): Promise<ToolFileResolution | null> {
  const split = splitRepoPath(workspacePath);
  if (!split?.repoRelPath) throw new Error(`${workspacePath} is not a file in a workspace repo`);
  const repository = await resolveToolRepository(vcs, state, split.repoPath);
  return resolveToolFileInRepository(vcs, state, repository, split.repoRelPath);
}

export async function resolveToolFileInRepository(
  vcs: Pick<ToolVcs, "readFile">,
  state: VcsStateNodeRef,
  repository: PresentToolRepository,
  repoRelativePath: string
): Promise<ToolFileResolution | null> {
  const file = await vcs.readFile({
    state,
    repositoryId: repository.repositoryId,
    file: { kind: "path", path: repoRelativePath },
  });
  if (!file || !file.repositoryId || !file.fileId) return null;
  return {
    state,
    repositoryId: file.repositoryId,
    repoPath: file.repoPath,
    fileId: file.fileId,
    path: file.path,
    contentHash: file.contentHash,
    mode: file.mode,
    content: file.content,
  };
}
