/**
 * Git interchange over the semantic workspace VCS.
 *
 * Git owns a checkout and remote transport. The semantic VCS owns repository
 * identity, workspace history, provenance, and protected main. Export writes
 * one exact protected-main snapshot to Git. Import records one exact checkout
 * snapshot as a semantic candidate. There is no mirrored Git
 * DAG, revision resolver, merge session, or alternate provenance model.
 */

import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonicalSnapshotDigest,
  compareUtf16CodeUnits,
  sha256Hex,
  sha256HexSyncText,
  type CanonicalSnapshotDigest,
} from "@vibestudio/content-addressing";
import { GitClient, readExactGitSnapshot } from "@vibestudio/git";
import { blobstoreMethods } from "@vibestudio/service-schemas/blobstore";
import {
  vcsMethods,
  type VcsExternalSnapshot,
  type VcsListFilesResult,
  type VcsStateNodeRef,
} from "@vibestudio/service-schemas/vcs";
import type { TypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { normalizeWorkspaceRepoPath } from "@vibestudio/workspace/remotes";
import { withRepoLock } from "./repoLocks.js";

type CanonicalVcs = TypedServiceClient<typeof vcsMethods>;
type CanonicalBlobstore = TypedServiceClient<typeof blobstoreMethods>;

const PAGE_LIMIT = 500;
export interface BridgeHost {
  checkoutRoot(): Promise<string>;
  ensureContext(contextId: string): Promise<void>;
  blobstore: Pick<CanonicalBlobstore, "putBase64">;
  vcs: Pick<
    CanonicalVcs,
    | "status"
    | "neighbors"
    | "inspect"
    | "resolveRepository"
    | "listFiles"
    | "readFile"
    | "importSnapshot"
  >;
}

export interface ExportResult {
  exported: 0 | 1;
  headCommit: string | null;
  clobberedLocalEdits: string[];
}

export interface ProtectedRepositorySnapshot {
  repositoryId: string;
  repoPath: string;
  eventId: string;
  treeDigest: CanonicalSnapshotDigest;
  files: Array<{
    path: string;
    contentHash: string;
    size: number;
    mode: number;
    bytes: Uint8Array;
  }>;
}

export interface ImportResult {
  contextId: string;
  eventId: string;
  changed: boolean;
  semanticEvidence: {
    applicationId: string;
    workUnitId: string;
    externalSnapshot: VcsExternalSnapshot;
  };
}

export interface PendingImportCandidate {
  contextId: string;
  eventId: string;
}

export class PendingImportCandidateError extends Error {
  constructor(readonly candidate: PendingImportCandidate) {
    super(
      `External snapshot candidate ${candidate.eventId} in context ${candidate.contextId} ` +
        `must be compared and incrementally integrated before exporting protected main`
    );
    this.name = "PendingImportCandidateError";
  }
}

type CheckoutMap = Record<string, { contentHash: string; mode: number; regular: boolean }>;

interface ImportedFile {
  path: string;
  contentHash: string;
  size: number;
  mode: number;
}

interface MaterializeResult {
  tracked: CheckoutMap;
  stagePaths: string[];
  removePaths: string[];
}

interface RepositoryAtState {
  repositoryId: string;
  repoPath: string;
}

type ListedRepositoryFile = VcsListFilesResult["files"][number];

function sameCheckoutTree(tracked: CheckoutMap, files: ListedRepositoryFile[]): boolean {
  if (Object.keys(tracked).length !== files.length) return false;
  return files.every(
    (file) =>
      tracked[file.path]?.contentHash === file.contentHash &&
      tracked[file.path]?.mode === file.mode &&
      tracked[file.path]?.regular === true
  );
}

function commandId(kind: string): string {
  return `git-bridge:${kind}:${randomUUID()}`;
}

function contextForRepository(repoPath: string): string {
  return `git-bridge-${sha256HexSyncText(repoPath).slice(0, 24)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeCheckoutJoin(dir: string, relPath: string): string {
  const resolved = path.resolve(path.join(dir, ...relPath.split("/")));
  const base = path.resolve(dir);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`git bridge path escapes checkout: ${relPath}`);
  }
  return resolved;
}

function sameState(left: VcsStateNodeRef, right: VcsStateNodeRef): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "event"
      ? right.kind === "event" && left.eventId === right.eventId
      : right.kind === "application" && left.applicationId === right.applicationId)
  );
}

/**
 * Turn an operational Git remote into durable provenance without persisting
 * transport credentials, signed parameters, or machine-local paths.
 */
export function provenanceGitUri(remote: string): string {
  const value = remote.trim();
  const windowsDrivePath = /^[A-Za-z]:/u.test(value);
  const scp = windowsDrivePath ? null : /^(?:[^@/:]+@)?([^/:]+):(.+)$/u.exec(value);
  if (scp && !value.includes("://")) {
    return `ssh://${scp[1]}/${scp[2]!.replace(/^\/+/, "")}`;
  }
  try {
    const parsed = new URL(value);
    if (["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) {
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
  } catch {
    // A local or relative Git remote is still an exact source identity, but
    // its host path is private and meaningless outside this machine.
  }
  return `git-local://sha256/${sha256HexSyncText(value)}`;
}

export class GitBridge {
  readonly git = new GitClient();
  traceEnabled = false;

  constructor(private readonly host: BridgeHost) {}

  private trace(message: string, details: Record<string, unknown>): void {
    if (this.traceEnabled) console.info(`[git-bridge] ${message}`, details);
  }

  async repoGitDir(repoPath: string): Promise<string> {
    return path.join(await this.host.checkoutRoot(), normalizeWorkspaceRepoPath(repoPath));
  }

  async checkoutExists(repoPath: string): Promise<boolean> {
    try {
      await fsp.access(path.join(await this.repoGitDir(repoPath), ".git"));
      return true;
    } catch {
      return false;
    }
  }

  async exportProtectedRepository(
    repoPath: string,
    opts: { authorName?: string; authorEmail?: string } = {}
  ): Promise<ExportResult> {
    return withRepoLock(repoPath, (repo) => this.exportLockedInner(repo, opts));
  }

  /**
   * Read one repository from protected main for a non-per-repository Git
   * projection, such as a workspace-template contribution branch. This is the
   * sole semantic-to-Git snapshot reader: callers choose layout and commit
   * granularity, but cannot observe a checkout as source truth.
   */
  async readProtectedRepository(
    repoPath: string,
    mainEventId: string
  ): Promise<ProtectedRepositorySnapshot> {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    const pending = await this.pendingImportCandidate(repo);
    if (pending) throw new PendingImportCandidateError(pending);
    const contextId = contextForRepository(repo);
    await this.host.ensureContext(contextId);
    const status = await this.host.vcs.status({ contextId });
    if (status.mainEventId !== mainEventId) {
      throw new Error(
        `Protected main changed from ${mainEventId} to ${status.mainEventId} before template export`
      );
    }
    return this.readRepositoryAtEvent(repo, mainEventId);
  }

  /**
   * Read a complete multi-repository publication from one exact protected-main
   * event. Publication is one reviewed workspace operation, so it owns one
   * stable observation context rather than acquiring one context boundary per
   * source repository. Unpublished import candidates do not alter the exact
   * protected-main event and are intentionally outside this projection.
   */
  async readProtectedRepositories(
    repoPaths: readonly string[],
    mainEventId: string,
    operationId: string
  ): Promise<ProtectedRepositorySnapshot[]> {
    if (!operationId.trim()) throw new Error("Template publication operationId is required");
    const repos = repoPaths.map(normalizeWorkspaceRepoPath);
    if (new Set(repos).size !== repos.length) {
      throw new Error("Template publication contains duplicate repositories");
    }
    const contextId = `git-bridge-template-publication-${sha256HexSyncText(operationId).slice(0, 24)}`;
    await this.host.ensureContext(contextId);
    const status = await this.host.vcs.status({ contextId });
    if (status.mainEventId !== mainEventId) {
      throw new Error(
        `Protected main changed from ${mainEventId} to ${status.mainEventId} before template export`
      );
    }
    const snapshots: ProtectedRepositorySnapshot[] = [];
    for (const repo of repos) {
      // A base template can contain the whole workspace. Keep the semantic
      // snapshot stream bounded instead of opening one concurrent Durable
      // Object request graph per repository.
      snapshots.push(await this.readRepositoryAtEvent(repo, mainEventId));
    }
    return snapshots;
  }

  private async readRepositoryAtEvent(
    repo: string,
    mainEventId: string
  ): Promise<ProtectedRepositorySnapshot> {
    const state = { kind: "event" as const, eventId: mainEventId };
    const repository = await this.findRepository(state, repo);
    if (!repository) throw new Error(`Cannot export absent repository '${repo}'`);
    const listed = await this.listRepositoryFiles(state, repository.repositoryId);
    const files: ProtectedRepositorySnapshot["files"] = [];
    for (const file of listed) {
      const content = await this.host.vcs.readFile({
        state,
        repositoryId: repository.repositoryId,
        file: { kind: "id", fileId: file.fileId },
      });
      if (!content) throw new Error(`Semantic state lost ${file.path} during Git export`);
      const bytes =
        content.content.kind === "text"
          ? Buffer.from(content.content.text, "utf8")
          : Buffer.from(content.content.base64, "base64");
      files.push({
        path: file.path,
        contentHash: file.contentHash,
        size: bytes.byteLength,
        mode: file.mode,
        bytes,
      });
    }
    files.sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
    return {
      repositoryId: repository.repositoryId,
      repoPath: repo,
      eventId: mainEventId,
      treeDigest: canonicalSnapshotDigest(
        files.map(({ path: filePath, contentHash, size, mode }) => ({
          path: filePath,
          contentHash,
          size,
          mode: mode === 0o755 ? 0o100755 : 0o100644,
        }))
      ),
      files,
    };
  }

  async exportLockedInner(
    repoPath: string,
    opts: { authorName?: string; authorEmail?: string }
  ): Promise<ExportResult> {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    const pending = await this.pendingImportCandidate(repo);
    if (pending) throw new PendingImportCandidateError(pending);
    const gitDir = await this.repoGitDir(repo);
    return this.exportProtectedStateToDirectory(repo, gitDir, opts, true);
  }

  async withProtectedExportPreviewLocked<T>(
    repoPath: string,
    opts: { authorName?: string; authorEmail?: string },
    inspect: (preview: { dir: string; exported: ExportResult }) => Promise<T>
  ): Promise<T> {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    const pending = await this.pendingImportCandidate(repo);
    if (pending) throw new PendingImportCandidateError(pending);
    const previewRoot = await fsp.mkdtemp(path.join(tmpdir(), "vibestudio-git-preview-"));
    const previewDir = path.join(previewRoot, "repo");
    try {
      await fsp.mkdir(previewDir, { recursive: true });
      const checkoutDir = await this.repoGitDir(repo);
      try {
        await fsp.cp(path.join(checkoutDir, ".git"), path.join(previewDir, ".git"), {
          recursive: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const exported = await this.exportProtectedStateToDirectory(repo, previewDir, opts, false);
      return await inspect({ dir: previewDir, exported });
    } finally {
      await fsp.rm(previewRoot, { recursive: true, force: true });
    }
  }

  private async exportProtectedStateToDirectory(
    repo: string,
    gitDir: string,
    opts: { authorName?: string; authorEmail?: string },
    detectLocalEdits: boolean
  ): Promise<ExportResult> {
    try {
      await fsp.access(path.join(gitDir, ".git"));
    } catch {
      await fsp.mkdir(gitDir, { recursive: true });
      await this.git.init(gitDir, "main");
    }

    const contextId = contextForRepository(repo);
    await this.host.ensureContext(contextId);
    const status = await this.host.vcs.status({ contextId });
    const state = { kind: "event" as const, eventId: status.mainEventId };
    const repository = await this.findRepository(state, repo);
    if (!repository) throw new Error(`Cannot export absent repository '${repo}'`);

    const inspected = await this.host.vcs.inspect({ node: state, edgeLimit: 1 });
    if (inspected.node.kind !== "event") {
      throw new Error(`Protected main ${status.mainEventId} is not an event`);
    }
    const event = inspected.node.value;
    const targetFiles = await this.listRepositoryFiles(state, repository.repositoryId);
    const checkout = await this.checkoutHead(gitDir);
    const tracked = checkout.files;
    const clobberedLocalEdits = detectLocalEdits
      ? await this.detectLocalDrift(gitDir, tracked)
      : [];
    if (checkout.eventId === event.eventId && sameCheckoutTree(tracked, targetFiles)) {
      return { exported: 0, headCommit: checkout.commitSha, clobberedLocalEdits };
    }
    const materialized = await this.materializeState(
      state,
      repository.repositoryId,
      gitDir,
      tracked,
      targetFiles
    );
    await this.stageMaterializedChanges(gitDir, materialized);
    const message =
      `${event.message ?? "Vibestudio workspace snapshot"}\n\n` +
      [
        `Vibestudio-Repository: ${repository.repositoryId}`,
        `Vibestudio-State: ${event.eventId}`,
        `Vibestudio-Event: ${event.eventId}`,
      ].join("\n");
    const headCommit = await this.git.commit({
      dir: gitDir,
      message,
      author: {
        name: opts.authorName ?? "Vibestudio",
        email: opts.authorEmail ?? "vibestudio@local",
      },
    });
    if (!headCommit) throw new Error(`Git did not create a commit for ${event.eventId}`);

    this.trace("export complete", { repo, eventId: event.eventId, headCommit });
    return { exported: 1, headCommit, clobberedLocalEdits };
  }

  async commitMapping(
    repoPath: string,
    opts: { limit?: number } = {}
  ): Promise<Array<{ gitSha: string; eventId: string; summary: string }>> {
    return withRepoLock(repoPath, async (repo) => {
      const commits = await this.git.log(await this.repoGitDir(repo), { depth: opts.limit ?? 100 });
      return commits.flatMap((commit) => {
        const eventId = /^Vibestudio-Event: (\S+)$/mu.exec(commit.message)?.[1];
        return eventId
          ? [
              {
                gitSha: commit.oid,
                eventId,
                summary: commit.message.split(/\r?\n/u, 1)[0] ?? "",
              },
            ]
          : [];
      });
    });
  }

  async importRepoTree(
    repoPath: string,
    opts: { summary?: string; sourceUri?: string } = {}
  ): Promise<ImportResult> {
    return withRepoLock(repoPath, (repo) => this.importLockedInner(repo, opts));
  }

  async pendingImportCandidate(repoPath: string): Promise<PendingImportCandidate | null> {
    const contextId = contextForRepository(normalizeWorkspaceRepoPath(repoPath));
    await this.host.ensureContext(contextId);
    const status = await this.host.vcs.status({ contextId });
    if (status.mainRelation !== "ahead" && status.mainRelation !== "diverged") return null;
    return status.committed.kind === "event"
      ? { contextId, eventId: status.committed.eventId }
      : null;
  }

  async importLockedInner(
    repoPath: string,
    opts: { summary?: string; sourceUri?: string }
  ): Promise<ImportResult> {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    const contextId = contextForRepository(repo);
    const gitDir = await this.repoGitDir(repo);
    await this.host.ensureContext(contextId);
    const status = await this.host.vcs.status({ contextId });
    if (!status.clean) {
      throw new Error(`Cannot import ${repo}: import context has uncommitted semantic work`);
    }
    const gitCommit = await this.git.getCurrentCommit(gitDir);
    if (!gitCommit) {
      throw new Error(`Cannot import ${repo}: checkout has no exact Git HEAD revision`);
    }
    const snapshot = await readExactGitSnapshot({
      git: this.git,
      dir: gitDir,
      commit: gitCommit,
      label: repo,
      sink: {
        put: async (bytes) => this.host.blobstore.putBase64(Buffer.from(bytes).toString("base64")),
      },
    }).catch((error) => {
      throw new Error(
        `Cannot import ${repo}: could not read exact Git commit ${gitCommit}: ${errorMessage(error)}`
      );
    });
    const files: ImportedFile[] = snapshot.files;
    const currentRepo = await this.findRepository(status.workingHead, repo);
    const currentFiles = currentRepo
      ? await this.listRepositoryFiles(status.workingHead, currentRepo.repositoryId)
      : [];
    const remotes = opts.sourceUri ? [] : await this.git.listRemotes(gitDir);
    const observedRemote =
      opts.sourceUri ??
      remotes.find((remote) => remote.remote === "origin")?.url ??
      (remotes.length === 1 ? remotes[0]!.url : null);
    if (!observedRemote) {
      throw new Error(
        `Cannot import ${repo}: the exact Git source remote is ambiguous; provide sourceUri`
      );
    }
    const sourceUri = provenanceGitUri(observedRemote);
    const priorEvidence =
      status.committed.kind === "event"
        ? await this.importEvidenceAtEvent(status.committed.eventId, sourceUri)
        : null;
    const priorRevision = priorEvidence?.externalSnapshot.snapshotRevision ?? null;
    if (
      priorEvidence !== null &&
      priorRevision === gitCommit &&
      currentRepo &&
      currentFiles.length === files.length &&
      files.every((file) =>
        currentFiles.some(
          (current) =>
            current.path === file.path &&
            current.contentHash === file.contentHash &&
            current.mode === file.mode
        )
      )
    ) {
      return {
        contextId,
        eventId:
          status.committed.kind === "event"
            ? status.committed.eventId
            : (() => {
                throw new Error("clean import context has no committed event");
              })(),
        changed: false,
        semanticEvidence: priorEvidence,
      };
    }

    const summary = opts.summary ?? `Import ${repo} @ ${gitCommit.slice(0, 7)}`;
    const imported = await this.host.vcs.importSnapshot({
      commandId: commandId("import-snapshot"),
      contextId,
      expectedWorkingHead: status.workingHead,
      intentSummary: summary,
      source: {
        kind: "git",
        url: sourceUri,
        commit: gitCommit,
        snapshot: snapshot.snapshot,
      },
      repositories: [
        {
          ...(currentRepo ? { repositoryId: currentRepo.repositoryId } : {}),
          repoPath: repo,
          files: files.map(({ path, contentHash, mode }) => ({ path, contentHash, mode })),
        },
      ],
      message: summary,
    });
    return {
      contextId,
      eventId: imported.eventId,
      changed: true,
      semanticEvidence: {
        applicationId: imported.applicationId,
        workUnitId: imported.workUnitId,
        externalSnapshot: imported.externalSnapshot,
      },
    };
  }

  private async importEvidenceAtEvent(
    eventId: string,
    sourceUri: string,
    expectedWorkUnitId?: string
  ): Promise<ImportResult["semanticEvidence"] | null> {
    const event = await this.host.vcs.inspect({
      node: { kind: "event", eventId },
      edgeLimit: 1,
    });
    if (event.node.kind !== "event") return null;
    for (const applicationId of [...event.node.value.applicationIds].reverse()) {
      const application = await this.host.vcs.inspect({
        node: { kind: "application", applicationId },
        edgeLimit: 1,
      });
      if (application.node.kind !== "application") continue;
      const workUnit = await this.host.vcs.inspect({
        node: { kind: "work-unit", workUnitId: application.node.value.workUnitId },
        edgeLimit: 1,
      });
      if (
        workUnit.node.kind === "work-unit" &&
        workUnit.node.value.kind === "import" &&
        (!expectedWorkUnitId || workUnit.node.value.workUnitId === expectedWorkUnitId) &&
        workUnit.node.value.externalSnapshot?.sourceKind === "git" &&
        workUnit.node.value.externalSnapshot.sourceUri === sourceUri
      ) {
        return {
          applicationId: application.node.value.applicationId,
          workUnitId: workUnit.node.value.workUnitId,
          externalSnapshot: workUnit.node.value.externalSnapshot,
        };
      }
    }
    return null;
  }

  private async findRepository(
    state: VcsStateNodeRef,
    repoPath: string
  ): Promise<RepositoryAtState | null> {
    const repository = await this.host.vcs.resolveRepository({ state, repoPath });
    return repository ? { repositoryId: repository.repositoryId, repoPath } : null;
  }

  private async listRepositoryFiles(
    state: VcsStateNodeRef,
    repositoryId: string
  ): Promise<ListedRepositoryFile[]> {
    const files: ListedRepositoryFile[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.host.vcs.listFiles({
        state,
        repositoryId,
        limit: PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      if (!sameState(page.state, state)) {
        throw new Error("Repository listing changed semantic state while paging");
      }
      files.push(...page.files);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return files;
  }

  private async materializeState(
    state: VcsStateNodeRef,
    repositoryId: string,
    gitDir: string,
    tracked: CheckoutMap,
    files: ListedRepositoryFile[]
  ): Promise<MaterializeResult> {
    const target = new Set(files.map((file) => file.path));
    const removePaths = Object.keys(tracked).filter((file) => !target.has(file));
    for (const file of removePaths) {
      await fsp.rm(safeCheckoutJoin(gitDir, file), { recursive: true, force: true });
    }

    const next: CheckoutMap = {};
    const stagePaths: string[] = [];
    for (const file of files) {
      next[file.path] = { contentHash: file.contentHash, mode: file.mode, regular: true };
      if (
        tracked[file.path]?.regular === true &&
        tracked[file.path]?.contentHash === file.contentHash &&
        tracked[file.path]?.mode === file.mode
      ) {
        continue;
      }
      const content = await this.host.vcs.readFile({
        state,
        repositoryId,
        file: { kind: "id", fileId: file.fileId },
      });
      if (!content) throw new Error(`Semantic state lost ${file.path} during Git export`);
      const bytes =
        content.content.kind === "text"
          ? Buffer.from(content.content.text, "utf8")
          : Buffer.from(content.content.base64, "base64");
      const absolute = safeCheckoutJoin(gitDir, file.path);
      if (tracked[file.path]?.regular === false) {
        await fsp.rm(absolute, { recursive: true, force: true });
      }
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      await fsp.writeFile(absolute, bytes);
      await fsp.chmod(absolute, file.mode & 0o111 ? 0o755 : 0o644);
      stagePaths.push(file.path);
    }
    return { tracked: next, stagePaths, removePaths };
  }

  private async checkoutHead(
    gitDir: string
  ): Promise<{ commitSha: string | null; eventId: string | null; files: CheckoutMap }> {
    const commitSha = await this.git.getCurrentCommit(gitDir);
    if (!commitSha) return { commitSha: null, eventId: null, files: {} };
    const entries = await this.git.readCommitTree(gitDir, commitSha);
    const files: CheckoutMap = {};
    for (const entry of entries) {
      const regular = entry.type === "blob" && (entry.mode === 0o100644 || entry.mode === 0o100755);
      files[entry.path] = {
        contentHash:
          entry.type === "blob"
            ? sha256Hex(entry.bytes)
            : sha256Hex(Buffer.from(`${entry.type}:${entry.oid}`, "utf8")),
        mode: regular ? (entry.mode === 0o100755 ? 0o755 : 0o644) : entry.mode,
        regular,
      };
    }
    const [head] = await this.git.log(gitDir, { ref: commitSha, depth: 1 });
    return {
      commitSha,
      eventId: head ? (/^Vibestudio-Event: (\S+)$/mu.exec(head.message)?.[1] ?? null) : null,
      files,
    };
  }

  private async stageMaterializedChanges(gitDir: string, result: MaterializeResult): Promise<void> {
    for (const relPath of new Set([...result.removePaths, ...result.stagePaths])) {
      await this.git.add(gitDir, relPath);
    }
  }

  private async detectLocalDrift(gitDir: string, tracked: CheckoutMap): Promise<string[]> {
    const drifted: string[] = [];
    for (const [relPath, expected] of Object.entries(tracked)) {
      try {
        const absolute = safeCheckoutJoin(gitDir, relPath);
        const bytes = await fsp.readFile(absolute);
        const stat = await fsp.stat(absolute);
        const mode = stat.mode & 0o111 ? 0o755 : 0o644;
        if (sha256Hex(bytes) !== expected.contentHash || mode !== expected.mode) {
          drifted.push(relPath);
        }
      } catch {
        drifted.push(relPath);
      }
    }
    return drifted.sort();
  }
}
