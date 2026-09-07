/** Stable-identity file move/copy tools over the canonical VCS commands. */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";
import type { VcsSemanticNodeRef, VcsStateNodeRef } from "@vibestudio/service-schemas/vcs";
import {
  canonicalizeWorkspaceFilePath,
  splitRepoPath,
} from "@vibestudio/shared/runtime/entitySpec";
import {
  resolveToolWorkingState,
  toVcsPath,
  toolCommandId,
  toolContextId,
  type ToolFileTransferVcs,
  type ToolMutationContext,
} from "./tool-vcs.js";
import {
  resolveToolFile,
  resolveToolRepository,
  type ToolFileResolution,
} from "../semantic-file-resolution.js";
import type { RuntimeFs } from "./runtime-fs.js";

const fileTransferSchema = Type.Object(
  {
    source: Type.String({
      description: "Current path of a managed workspace file or context-local .tmp file.",
    }),
    destination: Type.String({
      description:
        "Unoccupied destination path. Managed files preserve semantic identity/provenance; .tmp paths use context-local scratch storage.",
    }),
    intent: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Optional purpose when it is not already clear from the request; preserved as stated provenance.",
      })
    ),
  },
  { additionalProperties: false }
);

export type FileTransferToolInput = Static<typeof fileTransferSchema>;

interface FileDetails {
  repositoryId: string;
  fileId: string;
  repoPath: string;
  path: string;
  workspacePath: string;
  state: VcsStateNodeRef;
  root: Extract<VcsSemanticNodeRef, { kind: "file" }>;
}

export interface FileTransferToolDetails {
  operation: "moved" | "copied";
  storage: "vcs" | "scratch" | "none";
  source: FileDetails | { path: string };
  destination: FileDetails | { path: string };
  commandId?: string;
  workUnitId?: string;
  applicationId?: string;
  changeId?: string;
  diagnostic?: "cross-storage-transfer";
}

function missingSource(operation: "move_file" | "copy_file", path: string): NodeJS.ErrnoException {
  const error = new Error(`${operation}: source file not found: ${path}`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  error.path = path;
  error.syscall = operation;
  return error;
}

function transferIntegrityFailure(
  operation: "move_file" | "copy_file",
  source: ToolFileResolution,
  destination: ToolFileResolution
): Error {
  const message =
    operation === "move_file"
      ? `Move changed file identity from ${source.fileId} to ${destination.fileId}`
      : `Copy reused source file identity ${source.fileId}`;
  return Object.assign(new Error(message), {
    code: "IntegrityFailure",
    errorData: {
      code: "IntegrityFailure",
      message,
      stage: "file-transfer-identity",
      operation,
      sourceFileId: source.fileId,
      destinationFileId: destination.fileId,
    },
  });
}

function details(file: ToolFileResolution): FileDetails {
  const root = {
    kind: "file" as const,
    state: file.state,
    repositoryId: file.repositoryId,
    fileId: file.fileId,
  };
  return {
    repositoryId: file.repositoryId,
    fileId: file.fileId,
    repoPath: file.repoPath,
    path: file.path,
    workspacePath: `${file.repoPath}/${file.path}`,
    state: file.state,
    root,
  };
}

function createFileTransferTool(
  kind: "move" | "copy",
  cwd: string,
  vcs: ToolFileTransferVcs,
  context: ToolMutationContext,
  fs?: Pick<RuntimeFs, "copyFile" | "rename">
): AgentTool<typeof fileTransferSchema, FileTransferToolDetails> {
  const operation = kind === "move" ? "move_file" : "copy_file";
  return {
    name: operation,
    label: operation,
    description:
      kind === "move"
        ? "Move a file atomically. Managed workspace files preserve stable identity and history; .tmp files move within context-local scratch storage. Never emulate a managed move with write/delete."
        : "Copy a file atomically. Managed workspace files mint distinct identity with explicit copy provenance; .tmp files copy within context-local scratch storage. Never emulate a managed copy with read/write.",
    parameters: fileTransferSchema,
    cancellationMode: "settle",
    execute: async (
      _toolCallId,
      input,
      signal
    ): Promise<AgentToolResult<FileTransferToolDetails>> => {
      if (signal?.aborted) throw new Error("Operation aborted");
      if (typeof input.source !== "string" || typeof input.destination !== "string") {
        throw new Error(`${operation} requires source and destination paths`);
      }
      const sourcePath = canonicalizeWorkspaceFilePath(toVcsPath(input.source, cwd));
      const destinationPath = canonicalizeWorkspaceFilePath(toVcsPath(input.destination, cwd));
      const sourceRoute = splitRepoPath(sourcePath);
      const destinationRoute = splitRepoPath(destinationPath);

      if (!sourceRoute && !destinationRoute && fs) {
        if (kind === "move") await fs.rename(sourcePath, destinationPath);
        else await fs.copyFile(sourcePath, destinationPath);
        return {
          content: [
            {
              type: "text",
              text: `${kind === "move" ? "Moved" : "Copied"} scratch file ${sourcePath} to ${destinationPath}.`,
            },
          ],
          details: {
            operation: kind === "move" ? "moved" : "copied",
            storage: "scratch",
            source: { path: sourcePath },
            destination: { path: destinationPath },
          },
        };
      }

      if (!sourceRoute?.repoRelPath || !destinationRoute?.repoRelPath) {
        return {
          content: [
            {
              type: "text",
              text: "No file transferred: source and destination must both be managed workspace files or both be context-local scratch paths.",
            },
          ],
          details: {
            operation: kind === "move" ? "moved" : "copied",
            storage: "none",
            source: { path: sourcePath },
            destination: { path: destinationPath },
            diagnostic: "cross-storage-transfer",
          },
        };
      }

      const workingHead = await resolveToolWorkingState(vcs, context);
      const [source, destinationRepository] = await Promise.all([
        resolveToolFile(vcs, workingHead, sourcePath),
        resolveToolRepository(vcs, workingHead, destinationRoute.repoPath),
      ]);
      if (!source) throw missingSource(operation, input.source);
      if (signal?.aborted) throw new Error("Operation aborted");

      const commandId = toolCommandId(context);
      const destination = {
        repositoryId: destinationRepository.repositoryId,
        path: destinationRoute.repoRelPath,
      };
      const intentSummary = input.intent?.trim();
      const result =
        kind === "move"
          ? await vcs.move({
              contextId: toolContextId(context),
              expectedWorkingHead: workingHead,
              commandId,
              ...(intentSummary ? { intentSummary } : {}),
              moves: [
                {
                  kind: "file",
                  repositoryId: source.repositoryId,
                  fileId: source.fileId,
                  destinationRepositoryId: destination.repositoryId,
                  destinationPath: destination.path,
                },
              ],
            })
          : await vcs.copy({
              contextId: toolContextId(context),
              expectedWorkingHead: workingHead,
              commandId,
              ...(intentSummary ? { intentSummary } : {}),
              copies: [
                {
                  source: {
                    state: source.state,
                    repositoryId: source.repositoryId,
                    fileId: source.fileId,
                  },
                  destination,
                },
              ],
            });
      const produced = await resolveToolFile(vcs, result.workingHead, destinationPath);
      if (!produced) throw new Error(`${operation} did not produce ${destinationPath}`);
      if (
        (kind === "move" && produced.fileId !== source.fileId) ||
        (kind === "copy" && produced.fileId === source.fileId)
      ) {
        throw transferIntegrityFailure(operation, source, produced);
      }
      const changeId = result.changeIds[0];
      if (!changeId) throw new Error(`${operation} returned no semantic change`);
      const sourceDetails = details(source);
      const destinationDetails = details(produced);

      return {
        content: [
          {
            type: "text",
            text:
              `${kind === "move" ? "Moved" : "Copied"} ${sourcePath} to ${destinationPath}. ` +
              `${kind === "move" ? "Preserved" : "Minted"} file identity ${produced.fileId}; ` +
              `semantic change ${changeId}. Inspect the exact destination with ` +
              `provenance({ target: ${JSON.stringify(destinationPath)} }).`,
          },
        ],
        details: {
          operation: kind === "move" ? "moved" : "copied",
          storage: "vcs",
          source: sourceDetails,
          destination: destinationDetails,
          commandId,
          workUnitId: result.workUnitId,
          applicationId: result.applicationId,
          changeId,
        },
      };
    },
  };
}

export function createMoveFileTool(
  cwd: string,
  vcs: ToolFileTransferVcs,
  context: ToolMutationContext,
  fs?: Pick<RuntimeFs, "copyFile" | "rename">
) {
  return createFileTransferTool("move", cwd, vcs, context, fs);
}

export function createCopyFileTool(
  cwd: string,
  vcs: ToolFileTransferVcs,
  context: ToolMutationContext,
  fs?: Pick<RuntimeFs, "copyFile" | "rename">
) {
  return createFileTransferTool("copy", cwd, vcs, context, fs);
}
