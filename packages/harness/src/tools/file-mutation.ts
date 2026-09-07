/** Shared semantic file-mutation engine for write, edit, and apply_patch. */

import type { VcsEditChange, VcsWorkingMutationResult } from "@vibestudio/service-schemas/vcs";
import { sha256Hex } from "@vibestudio/content-addressing";
import {
  canonicalizeWorkspaceFilePath,
  splitRepoPath,
} from "@vibestudio/shared/runtime/entitySpec";
import { semanticVcsPathAdmission } from "@vibestudio/shared/vcs/pathAdmission";
import { resolveToolFileInRepository, resolveToolRepository } from "../semantic-file-resolution.js";
import {
  detectLineEnding,
  differingTextEdits,
  findUniqueText,
  generateDiffString,
  normalizeToLF,
  restoreLineEndings,
} from "./edit-diff.js";
import {
  base64ToBytes,
  canonicalBase64Bytes,
  decodeUtf8,
  encodeUtf8,
  encodeUtf8Base64,
  utf8ByteLength,
} from "./portable-bytes.js";
import {
  resolveToolWorkingState,
  toVcsPath,
  toolCommandId,
  toolContextId,
  type ToolEditingVcs,
  type ToolMutationContext,
} from "./tool-vcs.js";
import type { WorkspaceFileObservationStore } from "./file-observations.js";
import type { RuntimeFs } from "./runtime-fs.js";

export type SemanticFileMutationOperation =
  | {
      kind: "replace";
      path: string;
      mode?: number;
      replacements: Array<{ oldText: string; newText: string }>;
    }
  | {
      kind: "write";
      path: string;
      createOnly?: boolean;
      mode?: number;
      content: string;
    }
  | {
      kind: "write_binary";
      path: string;
      createOnly?: boolean;
      mode?: number;
      base64: string;
    }
  | { kind: "delete"; path: string }
  | { kind: "chmod"; path: string; mode: number };

export type FileMutationConflictReason =
  | "missing-file"
  | "binary-file"
  | "not-found"
  | "ambiguous"
  | "content-changed"
  | "file-missing"
  | "file-exists"
  | "repository-not-present";

export interface FileMutationExcerpt {
  startLine: number;
  endLine: number;
  text: string;
}

export interface FileMutationConflict {
  operation: number;
  path: string;
  reason: FileMutationConflictReason;
  message: string;
  replacement?: number;
  matchMode?: "exact" | "normalized";
  matchCount?: number;
  candidateLines?: number[];
  requestedText?: string;
  closestCurrentExcerpts?: FileMutationExcerpt[];
  suggestedScratchPath?: string;
  recovery: {
    action: "reobserve";
    instruction: string;
  };
}

export interface FileMutationOperationResult {
  operation: number;
  path: string;
  kind: SemanticFileMutationOperation["kind"];
  status: "created" | "changed" | "deleted" | "unchanged";
  bytesWritten?: number;
  firstChangedLine?: number;
  diff?: string;
  diffTruncated?: boolean;
  diffOriginalChars?: number;
  matches?: Array<{
    replacement: number;
    mode: "exact" | "normalized";
    line: number;
  }>;
}

export interface SemanticFileMutationDetails {
  protocol: "file-mutation.v1";
  status: "applied" | "unchanged" | "conflict";
  storage: "vcs" | "scratch";
  intent?: string;
  operations: FileMutationOperationResult[];
  conflicts: FileMutationConflict[];
  vcsResult?: VcsWorkingMutationResult;
}

export interface SemanticFileMutationInput {
  operations: SemanticFileMutationOperation[];
  intent?: string;
}

const RESULT_DIFF_BUDGET_CHARS = 24_000;

interface DiffBudget {
  remaining: number;
}

function consumeDiff(
  result: { diff: string; firstChangedLine: number | undefined },
  budget: DiffBudget
): Pick<
  FileMutationOperationResult,
  "diff" | "diffTruncated" | "diffOriginalChars" | "firstChangedLine"
> {
  if (!result.diff) return {};
  const retainedChars = Math.min(result.diff.length, budget.remaining);
  budget.remaining -= retainedChars;
  const truncated = retainedChars < result.diff.length;
  return {
    ...(retainedChars > 0
      ? {
          diff: truncated
            ? `${result.diff.slice(0, Math.max(0, retainedChars - 1))}…`
            : result.diff,
        }
      : {}),
    ...(result.firstChangedLine !== undefined ? { firstChangedLine: result.firstChangedLine } : {}),
    ...(truncated ? { diffTruncated: true, diffOriginalChars: result.diff.length } : {}),
  };
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function closestCurrentExcerpts(content: string, requested: string): FileMutationExcerpt[] {
  const tokens = new Set(
    (requested.match(/[A-Za-z0-9_-]{4,}/gu) ?? []).map((token) => token.toLowerCase())
  );
  const lines = content.split("\n");
  if (tokens.size === 0) {
    return content.length === 0
      ? []
      : [
          {
            startLine: 1,
            endLine: Math.min(3, lines.length),
            text: boundedText(lines.slice(0, 3).join("\n"), 800),
          },
        ];
  }
  return lines
    .map((_line, index) => {
      const endIndex = Math.min(lines.length, index + 3);
      const text = lines.slice(index, endIndex).join("\n");
      const found = new Set(
        (text.match(/[A-Za-z0-9_-]{4,}/gu) ?? []).map((token) => token.toLowerCase())
      );
      const score = [...tokens].reduce((count, token) => count + (found.has(token) ? 1 : 0), 0);
      return { score, startLine: index + 1, endLine: endIndex, text: boundedText(text, 800) };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.startLine - right.startLine)
    .filter(
      (candidate, index, candidates) =>
        candidates.findIndex((other) => Math.abs(other.startLine - candidate.startLine) <= 2) ===
        index
    )
    .slice(0, 3)
    .map(({ startLine, endLine, text }) => ({ startLine, endLine, text }));
}

function observationConflict(
  operation: number,
  path: string,
  observedContentHash: string,
  file: {
    contentHash: string;
    content: { kind: "text"; text: string } | { kind: "bytes"; base64: string };
  } | null,
  anchors: string[]
): FileMutationConflict | null {
  if (file?.contentHash === observedContentHash) return null;
  const reason: FileMutationConflictReason = file ? "content-changed" : "file-missing";
  const message =
    reason === "file-missing"
      ? `File no longer exists after it was read: ${path}.`
      : `File changed after it was read: ${path}.`;
  return {
    operation,
    path,
    reason,
    message,
    ...(file?.content.kind === "text"
      ? { closestCurrentExcerpts: closestCurrentExcerpts(file.content.text, anchors.join("\n")) }
      : {}),
    recovery: {
      action: "reobserve",
      instruction: "Read the current file, then form a new exact operation from its current text.",
    },
  };
}

function canonicalBase64(value: string, path: string): string {
  let normalized: string;
  try {
    normalized = canonicalBase64Bytes(value).base64;
  } catch {
    throw Object.assign(new Error(`Invalid base64 content for ${path}`), {
      code: "InvalidFileMutation",
      errorData: { code: "InvalidFileMutation", path, reason: "invalid-base64" },
    });
  }
  if (value.replace(/=+$/u, "") !== normalized.replace(/=+$/u, "")) {
    throw Object.assign(new Error(`Invalid base64 content for ${path}`), {
      code: "InvalidFileMutation",
      errorData: { code: "InvalidFileMutation", path, reason: "invalid-base64" },
    });
  }
  return normalized;
}

interface TextReplacementPlan {
  next: string;
  matches: Array<{ replacement: number; mode: "exact" | "normalized"; line: number }>;
}

function planTextReplacements(
  source: string,
  replacements: Array<{ oldText: string; newText: string }>,
  operation: number,
  path: string
): { plan: TextReplacementPlan } | { conflict: FileMutationConflict } {
  let next = source;
  const matches: TextReplacementPlan["matches"] = [];
  for (const [replacementIndex, replacement] of replacements.entries()) {
    const match = findUniqueText(next, replacement.oldText);
    if (!match.found && !match.ambiguous) {
      return {
        conflict: {
          operation,
          path,
          reason: "not-found",
          replacement: replacementIndex,
          message: `The requested text was not found in ${path}.`,
          requestedText: boundedText(replacement.oldText, 500),
          closestCurrentExcerpts: closestCurrentExcerpts(next, replacement.oldText),
          recovery: {
            action: "reobserve",
            instruction:
              "Read the current file, then retry with current text including whitespace.",
          },
        },
      };
    }
    if (match.ambiguous) {
      return {
        conflict: {
          operation,
          path,
          reason: "ambiguous",
          replacement: replacementIndex,
          matchMode: match.matchMode,
          matchCount: match.matchCount,
          candidateLines: match.candidateLines,
          message: `The requested text occurs ${match.matchCount} times in ${path}.`,
          requestedText: boundedText(replacement.oldText, 500),
          recovery: {
            action: "reobserve",
            instruction:
              "Include enough unchanged surrounding text to identify exactly one occurrence.",
          },
        },
      };
    }
    const matchedText = next.slice(match.index, match.index + match.matchLength);
    const nearbyText = matchedText || next.slice(0, match.index) || next.slice(match.index);
    const replacementText = restoreLineEndings(
      normalizeToLF(replacement.newText),
      detectLineEnding(nearbyText)
    );
    next =
      next.slice(0, match.index) + replacementText + next.slice(match.index + match.matchLength);
    matches.push({
      replacement: replacementIndex,
      mode: match.matchMode!,
      line: match.candidateLines[0]!,
    });
  }
  return { plan: { next, matches } };
}

export function mutationResultText(details: SemanticFileMutationDetails): string {
  if (details.status === "conflict") {
    const first = details.conflicts[0];
    return first
      ? `No files changed: ${first.message} ${first.recovery.instruction}`
      : "No files changed because a file precondition did not hold.";
  }
  if (details.status === "unchanged") {
    return details.operations.length === 1
      ? `${details.operations[0]!.path} already matches the requested state.`
      : "All requested files already match the requested state.";
  }
  const changed = details.operations.filter((operation) => operation.status !== "unchanged");
  return changed.length === 1
    ? `${changed[0]!.status === "created" ? "Created" : "Updated"} ${changed[0]!.path}.`
    : `Applied ${changed.length} semantic file changes atomically.`;
}

/**
 * Resolve, validate, and admit one atomic managed-file mutation. Expected
 * file-state mismatches are returned as structured conflicts; malformed input,
 * unavailable repositories, and VCS faults remain real tool errors.
 */
export async function mutateSemanticFiles(
  cwd: string,
  vcs: ToolEditingVcs,
  context: ToolMutationContext,
  input: SemanticFileMutationInput,
  signal?: AbortSignal,
  observations?: WorkspaceFileObservationStore
): Promise<SemanticFileMutationDetails> {
  if (signal?.aborted) throw new Error("Operation aborted");
  const intent = input.intent?.trim() || undefined;
  const workingHead = await resolveToolWorkingState(vcs, context);
  const seen = new Set<string>();
  const resolved = await Promise.all(
    input.operations.map(async (operation, index) => {
      const canonicalPath = canonicalizeWorkspaceFilePath(toVcsPath(operation.path, cwd));
      if (seen.has(canonicalPath)) {
        throw Object.assign(new Error(`Mutation contains ${canonicalPath} more than once`), {
          code: "InvalidFileMutation",
          errorData: { code: "InvalidFileMutation", path: canonicalPath, reason: "duplicate-path" },
        });
      }
      seen.add(canonicalPath);
      const admission = semanticVcsPathAdmission(canonicalPath);
      if (!admission.admissible) {
        throw Object.assign(new Error(admission.message), {
          code: "InvalidFileMutation",
          errorData: { code: "InvalidFileMutation", path: canonicalPath, reason: admission.reason },
        });
      }
      const route = splitRepoPath(canonicalPath);
      if (!route?.repoRelPath) {
        throw Object.assign(
          new Error(`${canonicalPath} is not a managed file inside a workspace repository`),
          {
            code: "InvalidFileMutation",
            errorData: { code: "InvalidFileMutation", path: canonicalPath, reason: "not-managed" },
          }
        );
      }
      let repository;
      try {
        repository = await resolveToolRepository(vcs, workingHead, route.repoPath);
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          (error as { code?: unknown }).code !== "InvalidReference"
        ) {
          throw error;
        }
        const basename = canonicalPath.split("/").at(-1) ?? "output.txt";
        return {
          operation,
          operationIndex: index,
          canonicalPath,
          route,
          repository: null,
          file: null,
          resolutionConflict: {
            operation: index,
            path: canonicalPath,
            reason: "repository-not-present" as const,
            message: `Cannot author ${canonicalPath} because repository ${route.repoPath} is not present.`,
            suggestedScratchPath: `.tmp/${basename}`,
            recovery: {
              action: "reobserve" as const,
              instruction:
                "List the workspace repositories and choose a current managed path, or use the suggested .tmp path for context-local data.",
            },
          },
        };
      }
      const file = await resolveToolFileInRepository(
        vcs,
        workingHead,
        repository,
        route.repoRelPath
      );
      return {
        operation,
        operationIndex: index,
        canonicalPath,
        route,
        repository,
        file,
        resolutionConflict: null,
      };
    })
  );
  if (signal?.aborted) throw new Error("Operation aborted");

  const resolutionConflicts = resolved.flatMap((item) =>
    item.resolutionConflict ? [item.resolutionConflict] : []
  );
  if (resolutionConflicts.length > 0) {
    return {
      protocol: "file-mutation.v1",
      status: "conflict",
      storage: "vcs",
      ...(intent ? { intent } : {}),
      operations: [],
      conflicts: resolutionConflicts,
    };
  }
  const ready = resolved as Array<
    (typeof resolved)[number] & {
      repository: NonNullable<(typeof resolved)[number]["repository"]>;
      resolutionConflict: null;
    }
  >;

  const conflicts: FileMutationConflict[] = [];
  const replacementPlans = new Map<
    number,
    {
      next: string;
      matches: Array<{ replacement: number; mode: "exact" | "normalized"; line: number }>;
    }
  >();
  for (const item of ready) {
    const { operation, operationIndex, canonicalPath, file } = item;
    const observedContentHash = observations?.get(canonicalPath);
    if (observedContentHash) {
      const conflict = observationConflict(
        operationIndex,
        canonicalPath,
        observedContentHash,
        file,
        operation.kind === "replace"
          ? operation.replacements.map((replacement) => replacement.oldText)
          : []
      );
      if (conflict) {
        conflicts.push(conflict);
        continue;
      }
    }
    if (
      (operation.kind === "write" || operation.kind === "write_binary") &&
      operation.createOnly &&
      file
    ) {
      conflicts.push({
        operation: operationIndex,
        path: canonicalPath,
        reason: "file-exists",
        message: `Cannot create ${canonicalPath} because it already exists.`,
        recovery: {
          action: "reobserve",
          instruction: "Read the current file, then decide whether an overwrite is intended.",
        },
      });
      continue;
    }
    if (operation.kind === "replace") {
      if (!file) {
        conflicts.push({
          operation: operationIndex,
          path: canonicalPath,
          reason: "missing-file",
          message: `Cannot edit missing file ${canonicalPath}.`,
          recovery: {
            action: "reobserve",
            instruction:
              "Create the file with write, or read/list the parent and use the current path.",
          },
        });
        continue;
      }
      if (file.content.kind !== "text") {
        conflicts.push({
          operation: operationIndex,
          path: canonicalPath,
          reason: "binary-file",
          message: `Cannot text-edit binary file ${canonicalPath}.`,
          recovery: {
            action: "reobserve",
            instruction:
              "Use a binary replacement operation only when replacing the complete file is intended.",
          },
        });
        continue;
      }
      const planned = planTextReplacements(
        file.content.text,
        operation.replacements,
        operationIndex,
        canonicalPath
      );
      if ("conflict" in planned) conflicts.push(planned.conflict);
      else replacementPlans.set(operationIndex, planned.plan);
    } else if ((operation.kind === "delete" || operation.kind === "chmod") && !file) {
      conflicts.push({
        operation: operationIndex,
        path: canonicalPath,
        reason: "missing-file",
        message: `${canonicalPath} does not exist.`,
        recovery: {
          action: "reobserve",
          instruction:
            "List or read the current path and retry only if the operation is still needed.",
        },
      });
    }
  }
  if (conflicts.length > 0) {
    return {
      protocol: "file-mutation.v1",
      status: "conflict",
      storage: "vcs",
      ...(intent ? { intent } : {}),
      operations: [],
      conflicts,
    };
  }

  const changes: VcsEditChange[] = [];
  const operationResults: FileMutationOperationResult[] = [];
  const resultingContentHashes = new Map<string, string | null>();
  const diffBudget: DiffBudget = { remaining: RESULT_DIFF_BUDGET_CHARS };
  for (const item of ready) {
    const { operation, operationIndex, canonicalPath, route, repository, file } = item;
    if (operation.kind === "replace") {
      const source = file!.content.kind === "text" ? file!.content.text : "";
      const plan = replacementPlans.get(operationIndex)!;
      const next = plan.next;
      resultingContentHashes.set(canonicalPath, sha256Hex(encodeUtf8(next)));
      const diffResult = generateDiffString(source, next);
      if (next !== source) {
        changes.push({
          kind: "text-edit",
          repositoryId: file!.repositoryId,
          fileId: file!.fileId,
          edits: differingTextEdits(source, next),
          ...(operation.mode !== undefined && operation.mode !== file!.mode
            ? { mode: operation.mode }
            : {}),
        });
      } else if (operation.mode !== undefined && operation.mode !== file!.mode) {
        changes.push({
          kind: "file-mode",
          repositoryId: file!.repositoryId,
          fileId: file!.fileId,
          mode: operation.mode,
        });
      }
      operationResults.push({
        operation: operationIndex,
        path: canonicalPath,
        kind: operation.kind,
        status:
          next !== source || (operation.mode !== undefined && operation.mode !== file!.mode)
            ? "changed"
            : "unchanged",
        ...consumeDiff(diffResult, diffBudget),
        matches: plan.matches,
      });
      continue;
    }
    if (operation.kind === "write" || operation.kind === "write_binary") {
      const content =
        operation.kind === "write"
          ? ({ kind: "text", text: operation.content } as const)
          : ({ kind: "bytes", base64: canonicalBase64(operation.base64, canonicalPath) } as const);
      const bytesWritten =
        content.kind === "text"
          ? utf8ByteLength(content.text)
          : base64ToBytes(content.base64).byteLength;
      resultingContentHashes.set(
        canonicalPath,
        content.kind === "text"
          ? sha256Hex(encodeUtf8(content.text))
          : sha256Hex(base64ToBytes(content.base64))
      );
      let status: FileMutationOperationResult["status"];
      let diffResult: ReturnType<typeof generateDiffString> | undefined;
      if (!file) {
        changes.push({
          kind: "file-create",
          repositoryId: repository.repositoryId,
          path: route.repoRelPath,
          content,
          mode: operation.mode ?? 0o644,
        });
        status = "created";
      } else {
        const sameContent =
          file.content.kind === content.kind &&
          (content.kind === "text"
            ? file.content.kind === "text" && file.content.text === content.text
            : file.content.kind === "bytes" && file.content.base64 === content.base64);
        const modeChanged = operation.mode !== undefined && operation.mode !== file.mode;
        if (!sameContent) {
          changes.push(
            content.kind === "text" && file.content.kind === "text"
              ? {
                  kind: "text-edit",
                  repositoryId: file.repositoryId,
                  fileId: file.fileId,
                  edits: differingTextEdits(file.content.text, content.text),
                  ...(modeChanged ? { mode: operation.mode } : {}),
                }
              : {
                  kind: "binary-replace",
                  repositoryId: file.repositoryId,
                  fileId: file.fileId,
                  base64: content.kind === "text" ? encodeUtf8Base64(content.text) : content.base64,
                  ...(modeChanged ? { mode: operation.mode } : {}),
                }
          );
          if (content.kind === "text" && file.content.kind === "text") {
            diffResult = generateDiffString(file.content.text, content.text);
          }
        } else if (modeChanged) {
          changes.push({
            kind: "file-mode",
            repositoryId: file.repositoryId,
            fileId: file.fileId,
            mode: operation.mode!,
          });
        }
        status = !sameContent || modeChanged ? "changed" : "unchanged";
      }
      operationResults.push({
        operation: operationIndex,
        path: canonicalPath,
        kind: operation.kind,
        status,
        bytesWritten,
        ...(diffResult ? consumeDiff(diffResult, diffBudget) : {}),
      });
      continue;
    }
    if (operation.kind === "delete") {
      resultingContentHashes.set(canonicalPath, null);
      changes.push({ kind: "file-delete", repositoryId: file!.repositoryId, fileId: file!.fileId });
      operationResults.push({
        operation: operationIndex,
        path: canonicalPath,
        kind: operation.kind,
        status: "deleted",
      });
      continue;
    }
    const changed = operation.mode !== file!.mode;
    resultingContentHashes.set(canonicalPath, file!.contentHash);
    if (changed) {
      changes.push({
        kind: "file-mode",
        repositoryId: file!.repositoryId,
        fileId: file!.fileId,
        mode: operation.mode,
      });
    }
    operationResults.push({
      operation: operationIndex,
      path: canonicalPath,
      kind: operation.kind,
      status: changed ? "changed" : "unchanged",
    });
  }

  if (changes.length === 0) {
    applyResultingObservations(observations, resultingContentHashes);
    return {
      protocol: "file-mutation.v1",
      status: "unchanged",
      storage: "vcs",
      ...(intent ? { intent } : {}),
      operations: operationResults,
      conflicts: [],
    };
  }
  if (signal?.aborted) throw new Error("Operation aborted");
  const vcsResult = await vcs.edit({
    contextId: toolContextId(context),
    expectedWorkingHead: workingHead,
    commandId: toolCommandId(context),
    ...(intent ? { intentSummary: intent } : {}),
    changes,
  });
  applyResultingObservations(observations, resultingContentHashes);
  return {
    protocol: "file-mutation.v1",
    status: "applied",
    storage: "vcs",
    ...(intent ? { intent } : {}),
    operations: operationResults,
    conflicts: [],
    vcsResult,
  };
}

function applyResultingObservations(
  observations: WorkspaceFileObservationStore | undefined,
  resultingContentHashes: ReadonlyMap<string, string | null>
): void {
  if (!observations) return;
  for (const [path, contentHash] of resultingContentHashes) {
    if (contentHash === null) observations.forget(path);
    else observations.record(path, contentHash);
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Canonical front door for file authoring. Managed paths use the atomic
 * semantic VCS engine above. A single .tmp operation uses context-local scratch
 * storage while retaining the same matching, conflict, and presentation
 * contract; scratch results never claim VCS provenance.
 */
export async function mutateFiles(
  cwd: string,
  vcs: ToolEditingVcs,
  context: ToolMutationContext,
  input: SemanticFileMutationInput,
  signal?: AbortSignal,
  fs?: Pick<RuntimeFs, "readFile" | "writeFile">,
  observations?: WorkspaceFileObservationStore
): Promise<SemanticFileMutationDetails> {
  const canonicalPaths = input.operations.map((operation) =>
    canonicalizeWorkspaceFilePath(toVcsPath(operation.path, cwd))
  );
  const managed = canonicalPaths.map((path) => Boolean(splitRepoPath(path)?.repoRelPath));
  if (managed.every(Boolean)) {
    return mutateSemanticFiles(cwd, vcs, context, input, signal, observations);
  }
  if (managed.some(Boolean) || input.operations.length !== 1) {
    throw Object.assign(new Error("One mutation cannot mix managed VCS files with scratch files"), {
      code: "InvalidFileMutation",
      errorData: {
        code: "InvalidFileMutation",
        reason: "cross-storage-transaction",
        paths: canonicalPaths,
      },
    });
  }
  const path = canonicalPaths[0]!;
  if (!path.startsWith(".tmp/") || !fs) {
    const basename = path.split("/").filter(Boolean).at(-1) ?? "output.txt";
    throw Object.assign(
      new Error(`${path} is neither a managed repository file nor a context-local .tmp file`),
      {
        code: "InvalidFileMutation",
        errorData: {
          code: "InvalidFileMutation",
          reason: "not-managed",
          path,
          suggestedScratchPath: `.tmp/${basename}`,
        },
      }
    );
  }
  if (signal?.aborted) throw new Error("Operation aborted");
  const intent = input.intent?.trim() || undefined;
  const operation = input.operations[0]!;
  if ("mode" in operation && operation.mode !== undefined) {
    throw Object.assign(new Error("Scratch-file chmod is not part of semantic file authoring"), {
      code: "InvalidFileMutation",
      errorData: { code: "InvalidFileMutation", reason: "scratch-mode", path },
    });
  }
  let source: string | null = null;
  try {
    const raw = await fs.readFile(path, "utf8");
    source = typeof raw === "string" ? raw : decodeUtf8(raw);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  const syntheticFile =
    source === null
      ? null
      : {
          contentHash: sha256Hex(encodeUtf8(source)),
          content: { kind: "text" as const, text: source },
        };
  const observedContentHash = observations?.get(path);
  if (observedContentHash) {
    const conflict = observationConflict(
      0,
      path,
      observedContentHash,
      syntheticFile,
      operation.kind === "replace"
        ? operation.replacements.map((replacement) => replacement.oldText)
        : []
    );
    if (conflict) {
      return {
        protocol: "file-mutation.v1",
        status: "conflict",
        storage: "scratch",
        ...(intent ? { intent } : {}),
        operations: [],
        conflicts: [conflict],
      };
    }
  }
  if (
    (operation.kind === "write" || operation.kind === "write_binary") &&
    operation.createOnly &&
    source !== null
  ) {
    return {
      protocol: "file-mutation.v1",
      status: "conflict",
      storage: "scratch",
      ...(intent ? { intent } : {}),
      operations: [],
      conflicts: [
        {
          operation: 0,
          path,
          reason: "file-exists",
          message: `Cannot create ${path} because it already exists.`,
          recovery: {
            action: "reobserve",
            instruction:
              "Read the current scratch file, then decide whether an overwrite is intended.",
          },
        },
      ],
    };
  }
  if (operation.kind === "write") {
    const status =
      source === null ? "created" : source === operation.content ? "unchanged" : "changed";
    if (status !== "unchanged") {
      if (signal?.aborted) throw new Error("Operation aborted");
      await fs.writeFile(path, operation.content);
    }
    observations?.record(path, sha256Hex(encodeUtf8(operation.content)));
    const diffResult =
      source !== null && source !== operation.content
        ? generateDiffString(source, operation.content)
        : undefined;
    return {
      protocol: "file-mutation.v1",
      status: status === "unchanged" ? "unchanged" : "applied",
      storage: "scratch",
      ...(intent ? { intent } : {}),
      operations: [
        {
          operation: 0,
          path,
          kind: "write",
          status,
          bytesWritten: utf8ByteLength(operation.content),
          ...(diffResult ? consumeDiff(diffResult, { remaining: RESULT_DIFF_BUDGET_CHARS }) : {}),
        },
      ],
      conflicts: [],
    };
  }
  if (operation.kind === "replace") {
    if (source === null) {
      return {
        protocol: "file-mutation.v1",
        status: "conflict",
        storage: "scratch",
        ...(intent ? { intent } : {}),
        operations: [],
        conflicts: [
          {
            operation: 0,
            path,
            reason: "missing-file",
            message: `Cannot edit missing file ${path}.`,
            recovery: {
              action: "reobserve",
              instruction: "Create the scratch file with write, or use its current path.",
            },
          },
        ],
      };
    }
    const planned = planTextReplacements(source, operation.replacements, 0, path);
    if ("conflict" in planned) {
      return {
        protocol: "file-mutation.v1",
        status: "conflict",
        storage: "scratch",
        ...(intent ? { intent } : {}),
        operations: [],
        conflicts: [planned.conflict],
      };
    }
    const diff = generateDiffString(source, planned.plan.next);
    const status = source === planned.plan.next ? "unchanged" : "changed";
    if (status === "changed") {
      if (signal?.aborted) throw new Error("Operation aborted");
      await fs.writeFile(path, planned.plan.next);
    }
    observations?.record(path, sha256Hex(encodeUtf8(planned.plan.next)));
    return {
      protocol: "file-mutation.v1",
      status: status === "unchanged" ? "unchanged" : "applied",
      storage: "scratch",
      ...(intent ? { intent } : {}),
      operations: [
        {
          operation: 0,
          path,
          kind: "replace",
          status,
          ...consumeDiff(diff, { remaining: RESULT_DIFF_BUDGET_CHARS }),
          matches: planned.plan.matches,
        },
      ],
      conflicts: [],
    };
  }
  throw Object.assign(
    new Error(`${operation.kind} is unavailable for context-local scratch files`),
    {
      code: "InvalidFileMutation",
      errorData: { code: "InvalidFileMutation", reason: "unsupported-scratch-operation", path },
    }
  );
}
