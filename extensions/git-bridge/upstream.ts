import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { stableSha256Hex } from "@vibestudio/content-addressing";
import { GitAuthError, GitClient, GitPushRejectedError } from "@vibestudio/git";
import {
  getDeclaredRemoteForRepo,
  getDeclaredUpstreamForRepo,
  listDeclaredUpstreams,
  normalizeWorkspaceRepoPath,
  removeDeclaredRemoteFromConfig,
  removeDeclaredUpstreamFromConfig,
  setDeclaredRemoteInConfig,
  setDeclaredUpstreamInConfig,
  validateWorkspaceGitRemote,
  validateWorkspaceGitUpstream,
  validateWorkspaceGitRemoteBranch,
  validateWorkspaceGitRemoteName,
  type ResolvedWorkspaceGitUpstream,
} from "@vibestudio/workspace/remotes";
import {
  WORKSPACE_IMPORT_PARENT_DIRS,
  isSupportedImportRepoPath,
} from "@vibestudio/workspace/pathPolicy";
import { workspaceConfigDigest } from "@vibestudio/workspace/preparedConfig";
import type {
  GitCommitMappingRow,
  GitDetachUpstreamResult,
  GitImportedWorkspaceRepo,
  GitImportProjectRequest,
  GitOverwritePreview,
  GitPublishRepoInput,
  GitPublishRepoResult,
  GitPullUpstreamResult,
  GitPushUpstreamResult,
  GitUpstreamRelationship,
  GitUpstreamState,
  GitUpstreamStatusOptions,
  GitUpstreamStatusRow,
  GitSharedRemotes,
  GitUpstreams,
} from "@vibestudio/service-schemas/gitInterop";
import type {
  WorkspaceConfig,
  WorkspaceGitRemoteConfig,
  WorkspaceGitUpstreamConfig,
} from "@vibestudio/workspace-contracts/types";
import { resolveGitHubPublishOperation } from "@workspace/integrations/github";
import { getRemoteProvider } from "@workspace/integrations/remoteProviders";
import {
  GitBridge,
  PendingImportCandidateError,
  type ExportResult,
  type ImportResult,
} from "./bridge.js";
import type { ExtensionContextLike } from "./context.js";
import { withRepoLock } from "./repoLocks.js";

const STATE_FILE = "state/upstream-state.json";
const DEFAULT_BRANCH = "main";
const OVERWRITE_PREVIEW_LIMIT = 20;
const TRANSIENT_BACKOFF_MIN_MS = 30_000;
const TRANSIENT_BACKOFF_MAX_MS = 15 * 60_000;

interface StoredRepoState {
  configFingerprint: string;
  lastPushedSha?: string;
  lastPushedAt?: number;
  lastSuccessfulObservationAt?: number;
  status?: StoredUpstreamState;
  lastError?: string;
  /** When the most recent background failure was recorded (ms epoch). */
  lastFailureAt?: number;
}
type StoredUpstreamState = Exclude<
  GitUpstreamState,
  | "exporting"
  | "pushing"
  | "local-only"
  | "not-materialized"
  | "fetch-failed"
  | "empty"
  | "integration-required"
>;
type StoredRepoStatePatch = Partial<Omit<StoredRepoState, "configFingerprint">>;

interface StoredState {
  version: 2;
  repos: Record<string, StoredRepoState>;
}

interface RuntimeRepoState {
  configFingerprint?: string;
  credentialIdOverride?: string | null;
  running?: "exporting" | "pushing";
  backoffMs?: number;
  retryAt?: number;
  debounceTimer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
}

interface RepoOperationScope {
  upstream: ResolvedWorkspaceGitUpstream;
  remote: WorkspaceGitRemoteConfig;
  credential: GitCredentialSelection;
  fingerprint: string;
  stored: StoredRepoState;
  transportRemote: string;
}

type GitCredentialSelection =
  | { credentialId: string | null }
  | { logicalCredential: { name: string; remoteUrl: string } };

type SyncResult =
  | GitPushUpstreamResult
  | (ExportResult & {
      outcome: "exported-only";
    });

export class UpstreamEngine {
  private runtime = new Map<string, RuntimeRepoState>();
  private stateWrite = Promise.resolve();

  constructor(
    private readonly ctx: ExtensionContextLike,
    private readonly bridge: GitBridge
  ) {}

  async activate(): Promise<void> {
    try {
      await this.readConfig();
    } catch (error) {
      // Provider activation must not depend on workspace RPC readiness. The
      // build smoke intentionally supplies no live config, and a real server
      // can also activate extensions while workspace services are converging.
      // Every provider operation reads the current config on demand; main-head
      // notifications enqueue affected repos once the workspace is live.
      this.ctx.log.warn?.("git upstream startup deferred until workspace config is available", {
        error: errorMessage(error),
      });
    }
    await this.reportHealth();
  }

  reconcileUpstreams(
    entries: Array<{ repoPath: string; credentialIdOverride?: string | null }>
  ): void {
    for (const entry of entries) this.enqueue(entry.repoPath, 2_000, entry.credentialIdOverride);
  }

  async pushUpstream(
    repoPath: string,
    opts: { force?: boolean; credentialIdOverride?: string | null } = {}
  ): Promise<GitPushUpstreamResult> {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    return withRepoLock(repo, async () => {
      let scope: RepoOperationScope | null = null;
      try {
        scope = await this.resolveRepoScope(repo, {
          credentialIdOverride: opts.credentialIdOverride,
        });
        const result = await this.syncLocked(repo, scope, { push: true, force: opts.force });
        if (result.outcome === "exported-only") {
          throw new Error("Manual upstream push stopped after export without observing the remote");
        }
        return result;
      } catch (err) {
        if (scope && !(err instanceof PendingImportCandidateError)) {
          await this.handlePushFailure(repo, scope, err, opts.force === true);
        }
        throw err;
      } finally {
        await this.reportHealth();
      }
    });
  }

  /**
   * The one export→push sequence, shared by manual pushes and auto jobs.
   * Callers hold the repo lock and own failure classification. Pushes the
   * checkout's ACTUAL branch (imported repos may not be on `main`) to the
   * declared upstream branch. Every explicit push observes the authoritative
   * remote before deciding whether a wire push is required.
   */
  private async syncLocked(
    repo: string,
    scope: RepoOperationScope,
    opts: { push: boolean; force?: boolean }
  ): Promise<SyncResult> {
    const { upstream, remote, fingerprint, transportRemote } = scope;
    const git = this.gitClient(scope.credential);
    const dir = await this.bridge.repoGitDir(repo);
    let exported: ExportResult;
    this.setRunning(repo, fingerprint, "exporting");
    try {
      exported = await this.bridge.exportLockedInner(repo, {
        authorEmail: upstream.authorEmail,
        authorName: upstream.authorName,
      });
    } finally {
      this.clearRunning(repo, fingerprint);
    }
    if (!opts.push) {
      return { ...exported, outcome: "exported-only" };
    }
    if (!exported.headCommit) {
      return { ...exported, headCommit: null, outcome: "empty" };
    }
    const fetched = await git.fetch({
      dir,
      url: remote.url,
      remote: transportRemote,
      ref: upstream.branch,
    });
    const observedAt = Date.now();
    const remoteRef = `refs/remotes/${transportRemote}/${upstream.branch}`;
    const remoteHead = fetched.remoteRefExists ? await git.resolveRef(dir, remoteRef) : null;
    if (fetched.remoteRefExists && !remoteHead) {
      throw new Error(`Fetched remote branch ${upstream.branch} could not be resolved`);
    }
    await this.updateRepoState(repo, fingerprint, { lastSuccessfulObservationAt: observedAt });
    if (remoteHead === exported.headCommit) {
      await this.updateRepoState(repo, fingerprint, { status: "in-sync" });
      this.clearBackoff(repo, fingerprint);
      return { ...exported, outcome: "already-at-remote" };
    }
    const comparison = remoteHead === null ? null : await git.compareRefs(dir, "HEAD", remoteRef);
    if (!opts.force && remoteHead !== null) {
      const remoteAdvanced = comparison === null || comparison.behind > 0 || comparison.diverged;
      if (remoteAdvanced) {
        const relationship =
          comparison === null ? "unrelated" : comparison.diverged ? "diverged" : "behind";
        await this.updateRepoState(repo, fingerprint, {
          status: relationship === "unrelated" ? "diverged" : relationship,
        });
        return {
          ...exported,
          outcome: "remote-advanced",
          remoteHead,
          relationship,
          ...(comparison ? { aheadBy: comparison.ahead, behindBy: comparison.behind } : {}),
        };
      }
    }
    let overwrites: GitOverwritePreview | undefined;
    if (opts.force) {
      overwrites = await this.previewOverwrites(git, dir, remoteRef, remoteHead, comparison);
    }
    const localRef = (await git.getCurrentBranch(dir)) ?? DEFAULT_BRANCH;
    this.setRunning(repo, fingerprint, "pushing");
    try {
      const pushGit = opts.force
        ? this.gitClient(scope.credential, { force: true, overwrites })
        : git;
      try {
        await pushGit.push({
          dir,
          url: remote.url,
          remote: transportRemote,
          ref: localRef,
          remoteRef: `refs/heads/${upstream.branch}`,
          force: opts.force ?? false,
        });
      } catch (error) {
        if (!opts.force && error instanceof GitPushRejectedError) {
          const refreshed = await git.fetch({
            dir,
            url: remote.url,
            remote: transportRemote,
            ref: upstream.branch,
          });
          const refreshedHead = refreshed.remoteRefExists
            ? await git.resolveRef(dir, remoteRef)
            : null;
          if (refreshedHead) {
            const refreshedComparison = await git.compareRefs(dir, "HEAD", remoteRef);
            if (
              refreshedComparison !== null &&
              refreshedComparison.behind === 0 &&
              !refreshedComparison.diverged
            ) {
              throw error;
            }
            const relationship =
              refreshedComparison === null
                ? "unrelated"
                : refreshedComparison.diverged
                  ? "diverged"
                  : "behind";
            await this.updateRepoState(repo, fingerprint, {
              status: relationship === "unrelated" ? "diverged" : relationship,
              lastSuccessfulObservationAt: Date.now(),
            });
            return {
              ...exported,
              outcome: "remote-advanced",
              remoteHead: refreshedHead,
              relationship,
              ...(refreshedComparison
                ? {
                    aheadBy: refreshedComparison.ahead,
                    behindBy: refreshedComparison.behind,
                  }
                : {}),
            };
          }
        }
        throw error;
      }
    } finally {
      this.clearRunning(repo, fingerprint);
    }
    await this.updateRepoState(repo, fingerprint, {
      status: "in-sync",
      lastPushedSha: exported.headCommit,
      lastPushedAt: Date.now(),
    });
    this.clearBackoff(repo, fingerprint);
    return {
      ...exported,
      outcome: remoteHead === null ? "remote-missing-created" : "pushed",
      ...(overwrites ? { overwrites } : {}),
    };
  }

  async pullUpstream(
    repoPath: string,
    opts: { dryRun?: boolean; credentialIdOverride?: string | null } = {}
  ): Promise<GitPullUpstreamResult & { imported?: ImportResult }> {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    return withRepoLock(repo, async () => {
      let scope: RepoOperationScope | null = null;
      try {
        scope = await this.resolveRepoScope(repo, {
          persistState: opts.dryRun !== true,
          credentialIdOverride: opts.credentialIdOverride,
        });
        const { upstream, remote, fingerprint, transportRemote } = scope;
        const git = this.gitClient(scope.credential);
        if (opts.dryRun) {
          return await this.bridge.withProtectedExportPreviewLocked(
            repo,
            {
              authorEmail: upstream.authorEmail,
              authorName: upstream.authorName,
            },
            async ({ dir }) => {
              const fetched = await git.fetch({
                dir,
                url: remote.url,
                remote: transportRemote,
                ref: upstream.branch,
              });
              if (!fetched.remoteRefExists) {
                return {
                  remote: upstream.remote,
                  branch: upstream.branch,
                  observedCommit: null,
                  changed: false,
                  behindBy: 0,
                  aheadBy: 0,
                  remoteBranchExists: false,
                  incoming: [],
                };
              }
              const remoteRef = `refs/remotes/${transportRemote}/${upstream.branch}`;
              const remoteHead = await git.resolveRef(dir, remoteRef);
              if (!remoteHead) {
                return {
                  remote: upstream.remote,
                  branch: upstream.branch,
                  observedCommit: null,
                  changed: false,
                  behindBy: 0,
                  aheadBy: 0,
                  remoteBranchExists: false,
                  incoming: [],
                };
              }
              const tracking = (await git.compareRefs(dir, "HEAD", remoteRef)) ?? {
                ahead: 1,
                behind: 1,
                diverged: true,
              };
              return {
                remote: upstream.remote,
                branch: upstream.branch,
                observedCommit: remoteHead,
                changed: false,
                behindBy: tracking.behind,
                aheadBy: tracking.ahead,
                remoteBranchExists: true,
                incoming: await this.commitSummaries(git, dir, remoteRef, tracking.behind),
              };
            }
          );
        }
        const dir = await this.bridge.repoGitDir(repo);
        // Export FIRST: the divergence judgment below must compare the remote
        // against gad main's exported tip, not a stale checkout. Without this,
        // a pull right after `vcs push` classifies as a clean fast-forward and
        // silently overwrites the just-pushed content.
        const exported = await this.bridge.exportLockedInner(repo, {
          authorEmail: upstream.authorEmail,
          authorName: upstream.authorName,
        });
        const clobbered =
          exported.clobberedLocalEdits.length > 0
            ? { clobberedLocalEdits: exported.clobberedLocalEdits }
            : {};
        const fetched = await git.fetch({
          dir,
          url: remote.url,
          remote: transportRemote,
          ref: upstream.branch,
        });
        const remoteRef = `refs/remotes/${transportRemote}/${upstream.branch}`;
        const remoteHead = fetched.remoteRefExists ? await git.resolveRef(dir, remoteRef) : null;
        if (!fetched.remoteRefExists || !remoteHead) {
          // The tracked remote branch does not exist yet — nothing to pull,
          // and nothing to fabricate: report the state explicitly.
          await this.updateRepoState(repo, fingerprint, {
            status: exported.headCommit ? "ahead" : undefined,
          });
          this.clearBackoff(repo, fingerprint);
          return {
            remote: upstream.remote,
            branch: upstream.branch,
            observedCommit: null,
            changed: false,
            behindBy: 0,
            aheadBy: 0,
            remoteBranchExists: false,
            incoming: [],
            ...clobbered,
          };
        }
        const tracking = (await git.compareRefs(dir, "HEAD", remoteRef)) ?? {
          ahead: 1,
          behind: 1,
          diverged: true,
        };
        const incoming = await this.commitSummaries(git, dir, remoteRef, tracking.behind);
        if (tracking.behind === 0) {
          await this.updateRepoState(repo, fingerprint, {
            status: statusFromCounts(tracking.ahead, tracking.behind, tracking.diverged),
          });
          this.clearBackoff(repo, fingerprint);
          return {
            remote: upstream.remote,
            branch: upstream.branch,
            observedCommit: remoteHead,
            changed: false,
            behindBy: 0,
            aheadBy: tracking.ahead,
            remoteBranchExists: true,
            incoming,
            ...clobbered,
          };
        }
        const localRef = (await git.getCurrentBranch(dir)) ?? DEFAULT_BRANCH;
        if (tracking.diverged) {
          // Git is an interchange projection, not Vibestudio's integration
          // authority. Materialize the exact remote snapshot on the local
          // projection branch; importSnapshot records the observed Git state
          // as a candidate and the semantic VCS decides how it relates to
          // workspace history.
          // Never create a git-side merge commit.
          await git.checkout(dir, remoteHead, { force: true });
          await git.deleteBranch(dir, localRef);
          await git.createBranch({
            dir,
            name: localRef,
            startPoint: remoteHead,
            checkout: true,
          });
        } else {
          await git.fastForward({
            dir,
            url: remote.url,
            remote: transportRemote,
            ref: localRef,
            remoteRef: upstream.branch,
          });
        }
        const head = await git.getCurrentCommit(dir);
        const imported = await this.bridge.importLockedInner(repo, {
          summary: `Pull ${upstream.remote}/${upstream.branch}${head ? ` @ ${head.slice(0, 7)}` : ""}`,
          sourceUri: remote.url,
        });
        const postPull = await this.aheadBehind(repo, scope, { fetch: false }).catch(() => null);
        await this.updateRepoState(repo, fingerprint, {
          status: postPull
            ? statusFromCounts(postPull.aheadBy, postPull.behindBy, postPull.diverged)
            : "in-sync",
        });
        this.clearBackoff(repo, fingerprint);
        return {
          remote: upstream.remote,
          branch: upstream.branch,
          observedCommit: remoteHead,
          changed: imported.changed,
          behindBy: tracking.behind,
          aheadBy: tracking.ahead,
          remoteBranchExists: true,
          incoming,
          imported,
          ...clobbered,
        };
      } catch (err) {
        if (scope && !(err instanceof PendingImportCandidateError)) {
          await this.handlePullFailure(repo, scope, err);
        }
        throw err;
      } finally {
        await this.reportHealth();
      }
    });
  }

  async upstreamStatus(
    repoPaths: string[],
    options: GitUpstreamStatusOptions = {}
  ): Promise<GitUpstreamStatusRow[]> {
    const listedConfig = await this.readConfig();
    const repos = repoPaths.length
      ? repoPaths.map((repo) => normalizeWorkspaceRepoPath(repo))
      : listDeclaredUpstreams(listedConfig).map((entry) => entry.repoPath);
    const rows = await Promise.all(
      repos.map((repo) =>
        withRepoLock(repo, async () => {
          const config = await this.readConfig();
          let resolved: ResolvedWorkspaceGitUpstream | null = null;
          let remote: WorkspaceGitRemoteConfig | null = null;
          try {
            resolved = getDeclaredUpstreamForRepo(config, repo);
            if (resolved) remote = this.requireRemote(config, repo, resolved.remote);
          } catch (err) {
            await this.clearRepoState(repo);
            return {
              repoPath: repo,
              autoPush: false,
              state: "error" as const,
              error: errorMessage(err),
            };
          }
          if (!resolved) {
            await this.clearRepoState(repo);
            return {
              repoPath: repo,
              autoPush: false,
              state: "local-only" as const,
            };
          }
          let stored = await this.reconcileRepoState(repo, resolved, remote!);
          const runtime = this.runtime.get(repo);
          // Status-only remote/branch/credential overrides are observational.
          // Persisted push/failure state remains scoped to the declared config.
          const observesDeclaredTarget =
            options.remote === undefined &&
            options.branch === undefined &&
            options.credentialIdOverride === undefined;
          resolved = this.applyStatusOptions(config, repo, resolved, options);
          const operationalRemote = this.requireRemote(config, repo, resolved.remote);
          const operationalFingerprint = upstreamConfigFingerprint(
            repo,
            resolved,
            operationalRemote
          );
          const transportRemote = transportRemoteForFingerprint(operationalFingerprint);
          const operationScope: RepoOperationScope = {
            upstream: resolved,
            remote: operationalRemote,
            credential: this.credentialFor(
              resolved,
              operationalRemote,
              options.credentialIdOverride
            ),
            fingerprint: operationalFingerprint,
            stored,
            transportRemote,
          };
          const dir = await this.bridge.repoGitDir(repo);
          // Declared-but-never-cloned is its OWN state with its own fix-it
          // command, never a generic `error` row.
          if (!(await this.bridge.checkoutExists(repo))) {
            return {
              repoPath: repo,
              remote: resolved.remote,
              branch: resolved.branch,
              autoPush: resolved.autoPush,
              state: "not-materialized" as const,
              error:
                `Declared upstream has no operational checkout. If ${repo} is already present ` +
              `in protected main, run \`vibestudio vcs git push --repo ${repo}\` to rebuild ` +
              `the checkout from semantic state and synchronize it. Otherwise import the absent repository explicitly.`,
            };
          }
          // A semantic candidate blocks publication, never observation. The
          // remote remains the authority for current upstream facts, so keep
          // the candidate aside and attach it to the completed observation.
          const candidate = await this.bridge.pendingImportCandidate(repo);
          const git = this.gitClient(operationScope.credential);
          let fetched: Awaited<ReturnType<GitClient["fetch"]>>;
          try {
            fetched = await git.fetch({
              dir,
              url: operationalRemote.url,
              remote: transportRemote,
              ref: resolved.branch,
            });
          } catch (err) {
            const declaredRuntime =
              observesDeclaredTarget && runtime?.configFingerprint === stored.configFingerprint
                ? runtime
                : undefined;
            return {
              repoPath: repo,
              remote: resolved.remote,
              branch: resolved.branch,
              autoPush: resolved.autoPush,
              state:
                err instanceof GitAuthError ? ("auth-failed" as const) : ("fetch-failed" as const),
              error: errorMessage(err),
              lastSuccessfulObservationAt: observesDeclaredTarget
                ? stored.lastSuccessfulObservationAt
                : undefined,
              lastSuccessfulPushCommit: observesDeclaredTarget ? stored.lastPushedSha : undefined,
              lastSuccessfulPushAt: observesDeclaredTarget ? stored.lastPushedAt : undefined,
              lastFailureReason: observesDeclaredTarget ? stored.lastError : undefined,
              lastFailureAt: observesDeclaredTarget ? stored.lastFailureAt : undefined,
              nextRetryAt: declaredRuntime?.retryAt,
              ...(candidate ? { candidate } : {}),
            };
          }
          const observedAt = Date.now();
          const remoteBranchExists = fetched.remoteRefExists;
          const remoteRef = `refs/remotes/${transportRemote}/${resolved.branch}`;
          const remoteHead = remoteBranchExists ? await git.resolveRef(dir, remoteRef) : null;
          let relationship: GitUpstreamRelationship | undefined;
          let counts: { aheadBy: number; behindBy: number } | undefined;
          let computed: GitUpstreamState;
          if (remoteBranchExists && !remoteHead) {
            return {
              repoPath: repo,
              remote: resolved.remote,
              branch: resolved.branch,
              autoPush: resolved.autoPush,
              state: "error" as const,
              error: `Fetched remote branch ${resolved.branch} could not be resolved`,
              lastSuccessfulObservationAt: observesDeclaredTarget
                ? stored.lastSuccessfulObservationAt
                : undefined,
              lastSuccessfulPushCommit: observesDeclaredTarget ? stored.lastPushedSha : undefined,
              lastSuccessfulPushAt: observesDeclaredTarget ? stored.lastPushedAt : undefined,
              lastFailureReason: observesDeclaredTarget ? stored.lastError : undefined,
              lastFailureAt: observesDeclaredTarget ? stored.lastFailureAt : undefined,
            };
          }
          if (!remoteBranchExists) {
            computed = (await git.getCurrentCommit(dir)) ? "ahead" : "empty";
          } else {
            const compared = await git.compareRefs(dir, "HEAD", remoteRef);
            if (!compared) {
              relationship = "diverged";
              computed = "diverged";
            } else {
              relationship = statusFromCounts(compared.ahead, compared.behind, compared.diverged);
              counts = { aheadBy: compared.ahead, behindBy: compared.behind };
              computed = relationship;
            }
          }
          if (observesDeclaredTarget) {
            await this.updateRepoState(repo, stored.configFingerprint, {
              status: computed === "empty" ? undefined : (computed as StoredUpstreamState),
              lastSuccessfulObservationAt: observedAt,
            });
            stored = { ...stored, lastSuccessfulObservationAt: observedAt };
          }
          const declaredRuntime =
            observesDeclaredTarget && runtime?.configFingerprint === stored.configFingerprint
              ? runtime
              : undefined;
          return {
            repoPath: repo,
            remote: resolved.remote,
            branch: resolved.branch,
            autoPush: resolved.autoPush,
            state: candidate ? ("integration-required" as const) : computed,
            relationship,
            ...counts,
            remoteBranchExists,
            observedAt,
            lastSuccessfulObservationAt: observesDeclaredTarget
              ? stored.lastSuccessfulObservationAt
              : undefined,
            lastSuccessfulPushCommit: observesDeclaredTarget ? stored.lastPushedSha : undefined,
            lastSuccessfulPushAt: observesDeclaredTarget ? stored.lastPushedAt : undefined,
            lastFailureReason: observesDeclaredTarget ? stored.lastError : undefined,
            // Auto-push visibility: an agent must see queued work, the last
            // background failure, and the retry schedule without log access.
            autoPushRequired: !candidate && resolved.autoPush && computed === "ahead",
            lastFailureAt: observesDeclaredTarget ? stored.lastFailureAt : undefined,
            nextRetryAt: declaredRuntime?.retryAt,
            ...(candidate ? { candidate } : {}),
          };
        })
      )
    );
    await this.reportHealth();
    return rows;
  }

  async publishRepo(input: GitPublishRepoInput): Promise<GitPublishRepoResult> {
    const repo = normalizeWorkspaceRepoPath(input.repoPath);
    const providerId = input.provider ?? "github";
    const provider = getRemoteProvider(providerId);
    if (!provider) throw new Error(`Unknown remote provider: ${providerId}`);
    if (input.name?.includes("/")) {
      throw new Error(
        `Repository name "${input.name}" must not contain "/" — pass the repository name ` +
          `separately from the optional organization`
      );
    }
    let organization = input.organization?.trim();
    if (input.organization !== undefined && !organization) {
      throw new Error("Organization must be a non-empty GitHub organization name");
    }
    let credentialId = input.credentialId?.trim() || undefined;
    let credentialLogin: string | undefined;
    let credentialTarget: string | undefined;
    let credentialOwnerSource: "explicit" | "credential-target" | "authenticated-user" | undefined;
    if (providerId === "github") {
      const operation = await resolveGitHubPublishOperation(this.ctx.credentials, {
        ...(credentialId ? { credentialId } : {}),
        ...(organization ? { organization } : {}),
      });
      credentialId = operation.credentialId;
      credentialLogin = operation.login;
      credentialTarget = operation.targetName;
      credentialOwnerSource = operation.ownerSource;
      organization = operation.organization;
    }
    const repoName = input.name ?? repo.split("/").at(-1) ?? repo;
    const remoteName = input.remote ? validateWorkspaceGitRemoteName(input.remote) : "origin";
    const branch = input.branch ? validateWorkspaceGitRemoteBranch(input.branch) : DEFAULT_BRANCH;
    const created = await provider.createRepo(this.ctx.credentials, {
      name: repoName,
      ...(organization ? { organization } : {}),
      private: input.private ?? true,
      description: input.description,
      ...(credentialId ? { credentialId } : {}),
    });
    try {
      await this.applyConfigMutation(
        (current) =>
          setDeclaredUpstreamInConfig(
            setDeclaredRemoteInConfig(current, repo, {
              name: remoteName,
              url: created.cloneUrl,
              branch,
            }),
            repo,
            {
              remote: remoteName,
              branch,
              autoPush: input.autoPush ?? false,
              ...(input.authorEmail ? { authorEmail: input.authorEmail } : {}),
              ...(input.authorName ? { authorName: input.authorName } : {}),
            }
          ),
        `record published Git repository ${repo}`
      );
      await this.clearRepoState(repo);
      await this.reportHealth();
    } catch (err) {
      // The provider repo ALREADY exists; a lost URL here strands the caller.
      // Name it and the exact commands that finish the job.
      throw new Error(
        `Created ${created.webUrl}, but recording its remote/upstream config was refused: ` +
          `${errorMessage(err)}. Finish with ` +
          `\`vibestudio vcs git remote set --repo ${repo} --url ${created.cloneUrl}\` and ` +
          `\`vibestudio vcs git enable --repo ${repo} --branch ${branch}\`, then ` +
          `\`vibestudio vcs git push --repo ${repo}\`.`
      );
    }
    let pushed;
    try {
      pushed = await this.pushUpstream(repo, {
        force: input.force,
        credentialIdOverride: credentialId,
      });
    } catch (err) {
      // The remote repo and the remote/upstream config all exist at this
      // point — don't unwind them; tell the caller how to finish.
      throw new Error(
        `Created ${created.webUrl} and configured ${repo}, but the first push failed: ` +
          `${errorMessage(err)}. Retry with \`vibestudio vcs git push --repo ${repo}\`.`
      );
    }
    return {
      repoPath: repo,
      provider: provider.id,
      remote: remoteName,
      branch,
      remoteUrl: created.cloneUrl,
      webUrl: created.webUrl,
      owner: created.owner,
      ...(credentialId ? { credentialId } : {}),
      ...(credentialLogin ? { credentialLogin } : {}),
      ...(credentialTarget ? { credentialTarget } : {}),
      ...(credentialOwnerSource ? { credentialOwnerSource } : {}),
      exported: pushed.exported,
      headCommit: pushed.headCommit,
      pushed: pushed.outcome === "pushed" || pushed.outcome === "remote-missing-created",
    };
  }

  async importProject(request: GitImportProjectRequest): Promise<GitImportedWorkspaceRepo> {
    const repo = normalizeWorkspaceRepoPath(request.path);
    if (!isSupportedImportRepoPath(repo)) {
      throw new Error(`Imports must target one of: ${WORKSPACE_IMPORT_PARENT_DIRS.join(", ")}`);
    }
    let remote = validateWorkspaceGitRemote(request.remote);
    const before = await this.readConfig();
    const existingRemote = getDeclaredRemoteForRepo(before, repo, remote.name);
    let existingUpstream: ResolvedWorkspaceGitUpstream | null = null;
    try {
      existingUpstream = getDeclaredUpstreamForRepo(before, repo);
    } catch {
      existingUpstream = null;
    }
    if (
      existingRemote &&
      (existingRemote.url !== remote.url ||
        (remote.branch !== undefined &&
          existingRemote.branch !== undefined &&
          existingRemote.branch !== remote.branch))
    ) {
      throw new Error(`Import declaration for ${repo} conflicts with its existing remote`);
    }
    if (existingUpstream && existingUpstream.remote !== remote.name) {
      throw new Error(`Import declaration for ${repo} conflicts with its existing upstream`);
    }
    if (!remote.branch) {
      const discovered = await this.remoteDefaultBranch({
        url: remote.url,
        credentialIdOverride: request.credentialIdOverride,
      });
      if (!discovered.branch) {
        throw new Error(
          `Remote ${remote.url} does not advertise a default branch; specify remote.branch explicitly`
        );
      }
      remote = { ...remote, branch: discovered.branch };
    }
    if (!existingRemote || !existingUpstream) {
      await this.applyConfigMutation(
        (current) =>
          setDeclaredUpstreamInConfig(
            existingRemote ? current : setDeclaredRemoteInConfig(current, repo, remote),
            repo,
            { remote: remote.name, branch: remote.branch, autoPush: false }
          ),
        `record Git import ${repo} from ${remote.url}`
      );
    }
    try {
      const candidate = await this.cloneRepo({
        repoPath: repo,
        credentialIdOverride: request.credentialIdOverride,
      });
      return { path: repo, remote, candidate };
    } catch (error) {
      if (!existingRemote || !existingUpstream) {
        try {
          await this.applyConfigMutation(
            (current) => {
              const withoutUpstream = existingUpstream
                ? setDeclaredUpstreamInConfig(
                    current,
                    repo,
                    declaredUpstreamConfig(existingUpstream)
                  )
                : removeDeclaredUpstreamFromConfig(current, repo);
              return existingRemote
                ? setDeclaredRemoteInConfig(withoutUpstream, repo, existingRemote)
                : removeDeclaredRemoteFromConfig(withoutUpstream, repo, remote.name);
            },
            `roll back failed Git import ${repo}`
          );
        } catch (cleanupError) {
          throw attachGitCleanupFailure(error, cleanupError, "restore-import-config");
        }
      }
      throw error;
    }
  }

  async cloneRepo(input: {
    repoPath: string;
    credentialIdOverride?: string | null;
  }): Promise<ImportResult> {
    const repo = normalizeWorkspaceRepoPath(input.repoPath);
    return withRepoLock(repo, async () => {
      const config = await this.readConfig();
      const upstream = getDeclaredUpstreamForRepo(config, repo);
      if (!upstream) throw new Error(`No approved upstream is declared for ${repo}`);
      const remote = getDeclaredRemoteForRepo(config, repo, upstream.remote);
      if (!remote) throw new Error(`No approved remote ${upstream.remote} is declared for ${repo}`);
      const absolutePath = await this.bridge.repoGitDir(repo);
      if (!isSupportedImportRepoPath(repo)) {
        throw new Error(`Imports must target one of: ${WORKSPACE_IMPORT_PARENT_DIRS.join(", ")}`);
      }
      try {
        await fsp.access(absolutePath);
        throw new Error(`Path already exists: ${repo}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
      const git = this.gitClient(this.credentialFor(upstream, remote, input.credentialIdOverride));
      const cloneRef = upstream.branch ?? remote.branch;
      try {
        await git.clone({
          url: remote.url,
          dir: absolutePath,
          ref: cloneRef,
        });
        if (remote.name !== "origin") {
          await git.addRemote(absolutePath, remote.name, remote.url).catch(() => undefined);
        }
        return await this.bridge.importLockedInner(repo, {
          summary: `Import ${repo} from ${displayRemote(remote.url)}`,
          sourceUri: remote.url,
        });
      } catch (err) {
        await fsp.rm(absolutePath, { recursive: true, force: true }).catch(() => undefined);
        // When the requested branch was a default-assumption (not user-declared
        // config we can trust), name the remote's ACTUAL default branch in the
        // error instead of leaving a bare git failure.
        if (cloneRef) {
          const actualDefault = await git.getRemoteDefaultBranch(remote.url).catch(() => null);
          if (actualDefault && actualDefault !== cloneRef) {
            throw new Error(
              `Clone of ${displayRemote(remote.url)} branch "${cloneRef}" failed ` +
                `(${errorMessage(err)}). The remote's default branch is "${actualDefault}" — ` +
                `re-import with --branch ${actualDefault}.`
            );
          }
        }
        throw err;
      }
    });
  }

  async commitMapping(
    repoPath: string,
    opts: { limit?: number } = {}
  ): Promise<GitCommitMappingRow[]> {
    return this.bridge.commitMapping(normalizeWorkspaceRepoPath(repoPath), opts);
  }

  async remoteDefaultBranch(input: {
    url: string;
    credentialIdOverride?: string | null;
  }): Promise<{ branch: string | null }> {
    const git = this.gitClient({ credentialId: input.credentialIdOverride ?? null });
    return { branch: await git.getRemoteDefaultBranch(input.url) };
  }

  async setUpstream(
    repoPath: string,
    config: WorkspaceGitUpstreamConfig
  ): Promise<GitUpstreams> {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    const normalized = validateWorkspaceGitUpstream(config);
    const result = await this.applyConfigMutation(
      (current) => {
        if (!getDeclaredRemoteForRepo(current, repo, normalized.remote)) {
          throw new Error(`Upstream remote "${normalized.remote}" is not declared for ${repo}`);
        }
        return setDeclaredUpstreamInConfig(current, repo, normalized);
      },
      `set Git upstream for ${repo}`
    );
    await this.clearRepoState(repo);
    await this.reportHealth();
    return result.config.git?.upstreams ?? {};
  }

  async setRemote(
    repoPath: string,
    remote: WorkspaceGitRemoteConfig
  ): Promise<GitSharedRemotes> {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    const normalized = validateWorkspaceGitRemote(remote);
    const result = await this.applyConfigMutation(
      (current) => setDeclaredRemoteInConfig(current, repo, normalized),
      `set Git remote ${normalized.name} for ${repo}`
    );
    return result.config.git?.remotes ?? {};
  }

  async removeRemote(repoPath: string, remoteName: string): Promise<GitSharedRemotes> {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    const name = validateWorkspaceGitRemoteName(remoteName);
    const result = await this.applyConfigMutation(
      (current) => {
        const withoutRemote = removeDeclaredRemoteFromConfig(current, repo, name);
        let upstream: WorkspaceGitUpstreamConfig | null = null;
        try {
          upstream = getDeclaredUpstreamForRepo(current, repo);
        } catch {
          upstream = null;
        }
        return upstream?.remote === name
          ? removeDeclaredUpstreamFromConfig(withoutRemote, repo)
          : withoutRemote;
      },
      `remove Git remote ${name} from ${repo}`
    );
    return result.config.git?.remotes ?? {};
  }

  async removeUpstream(repoPath: string): Promise<GitUpstreams> {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    const result = await this.applyConfigMutation(
      (current) => removeDeclaredUpstreamFromConfig(current, repo),
      `remove Git upstream from ${repo}`
    );
    await this.clearRepoState(repo);
    await this.reportHealth();
    return result.config.git?.upstreams ?? {};
  }

  async setAutoPush(repoPath: string, enabled: boolean): Promise<GitUpstreams> {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    const result = await this.applyConfigMutation(
      (current) => {
        const upstream = getDeclaredUpstreamForRepo(current, repo);
        if (!upstream) throw new Error(`No upstream tracking is declared for ${repo}`);
        return setDeclaredUpstreamInConfig(current, repo, {
          ...declaredUpstreamConfig(upstream),
          autoPush: enabled,
        });
      },
      `${enabled ? "enable" : "disable"} automatic Git push for ${repo}`
    );
    await this.clearRepoState(repo);
    await this.reportHealth();
    return result.config.git?.upstreams ?? {};
  }

  async detachUpstream(
    repoPath: string,
    options: { forgetRemote?: boolean; remote?: string } = {}
  ): Promise<GitDetachUpstreamResult> {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    const current = await this.readConfig();
    let upstream: WorkspaceGitUpstreamConfig | null = null;
    try {
      upstream = getDeclaredUpstreamForRepo(current, repo);
    } catch {
      upstream = null;
    }
    const remoteName =
      options.forgetRemote === true
        ? validateWorkspaceGitRemoteName(options.remote ?? upstream?.remote ?? "origin")
        : null;
    const result = await this.applyConfigMutation(
      (config) => {
        const withoutUpstream = removeDeclaredUpstreamFromConfig(config, repo);
        return remoteName
          ? removeDeclaredRemoteFromConfig(withoutUpstream, repo, remoteName)
          : withoutUpstream;
      },
      `disconnect Git upstream from ${repo}${remoteName ? ` and remove ${remoteName}` : ""}`
    );
    await this.clearRepoState(repo);
    await this.reportHealth();
    return {
      upstreams: result.config.git?.upstreams ?? {},
      remotes: result.config.git?.remotes ?? {},
      removedRemote: remoteName,
    };
  }

  private async applyConfigMutation(
    mutate: (current: WorkspaceConfig) => WorkspaceConfig,
    summary: string
  ): Promise<{ changed: boolean; resultDigest: string; config: WorkspaceConfig }> {
    const current = await this.readConfig();
    const nextState = mutate(current);
    return this.ctx.rpc.call("main", "workspace.applyPreparedConfig", {
      expectedBaseDigest: workspaceConfigDigest(current),
      nextState,
      resultDigest: workspaceConfigDigest(nextState),
      allowedPathScope: ["git.remotes", "git.upstreams"],
      summary,
    });
  }

  async openGitTab(repoPath?: string): Promise<{
    opened: false;
    repoPath?: string;
    openPanel: { source: string; stateArgs?: Record<string, unknown>; name?: string };
  }> {
    const normalized = repoPath ? normalizeWorkspaceRepoPath(repoPath) : undefined;
    return {
      opened: false,
      ...(normalized ? { repoPath: normalized } : {}),
      openPanel: {
        source: "about/workspace-history",
        name: "Git upstreams",
        ...(normalized ? { stateArgs: { gitRepo: normalized } } : { stateArgs: { gitRepo: "" } }),
      },
    };
  }

  private enqueue(repoPath: string, delayMs = 2_000, credentialIdOverride?: string | null): void {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    const runtime = this.runtime.get(repo) ?? {};
    if (runtime.debounceTimer) clearTimeout(runtime.debounceTimer);
    if (credentialIdOverride !== undefined) runtime.credentialIdOverride = credentialIdOverride;
    runtime.debounceTimer = setTimeout(() => {
      const current = this.runtime.get(repo);
      if (current) delete current.debounceTimer;
      void this.runAutoJob(repo).catch((err) => {
        this.ctx.log.warn?.("git upstream auto job failed", {
          repo,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, delayMs);
    this.runtime.set(repo, runtime);
  }

  private scheduleRetry(repo: string, fingerprint: string, delayMs: number): void {
    const runtime = this.runtime.get(repo);
    if (!runtime || runtime.configFingerprint !== fingerprint) return;
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = setTimeout(() => {
      const current = this.runtime.get(repo);
      if (current?.configFingerprint !== fingerprint) return;
      delete current.retryTimer;
      void this.runAutoJob(repo).catch((err) => {
        this.ctx.log.warn?.("git upstream retry failed", {
          repo,
          error: errorMessage(err),
        });
      });
    }, delayMs);
  }

  private async runAutoJob(repo: string): Promise<void> {
    await withRepoLock(repo, async () => {
      // A freshly approved import is declared in workspace config before the
      // provider clones it. Extension activation observes that declaration
      // immediately. Do not let the normal export reconciler materialize the
      // destination first: cloneRepo uses the directory's absence as its
      // create-target safety invariant, and an eager export would turn a
      // valid import into "Path already exists". Once cloning has created the
      // checkout, the shared repo lock serializes any later reconciliation
      // behind it and normal export/push behavior resumes.
      if (!(await this.bridge.checkoutExists(repo))) {
        await this.clearRepoState(repo);
        return;
      }
      if (await this.bridge.pendingImportCandidate(repo)) return;
      let scope: RepoOperationScope | null = null;
      try {
        scope = await this.resolveRepoScope(repo, {
          credentialIdOverride: this.runtime.get(repo)?.credentialIdOverride,
        });
        const runtime = this.runtime.get(repo);
        if (
          runtime?.configFingerprint === scope.fingerprint &&
          runtime.retryAt &&
          Date.now() < runtime.retryAt
        ) {
          this.scheduleRetry(repo, scope.fingerprint, runtime.retryAt - Date.now());
          return;
        }
        // Tracking always exports (local-only, keeps the checkout current).
        // Divergence/auth failures pause only the wire push, never the export.
        const paused =
          scope.stored.status === "behind" ||
          scope.stored.status === "diverged" ||
          scope.stored.status === "auth-failed";
        const result = await this.syncLocked(repo, scope, {
          push: scope.upstream.autoPush && !paused,
        });
        if (result.outcome === "remote-advanced") {
          await this.showFailureNotification(
            repo,
            scope.upstream,
            `The remote branch advanced (${result.relationship}); pull and review its incoming changes before pushing.`
          );
        }
      } catch (err) {
        if (scope) {
          await this.handleAutoFailure(repo, scope, scope.upstream, err);
          return;
        }
        // A missing/broken declaration has no operational state. Clearing it
        // also detaches any timer/backoff from the previous configuration.
        await this.clearRepoState(repo);
      }
    });
    await this.reportHealth();
  }

  /**
   * Classify a push/pull failure into a stored state patch. POLICY (pausing
   * auto-push via `auth-failed`/`diverged`) is decided ONLY by typed errors or
   * a deterministic re-check against the remote — never by regex over error
   * prose (which once classified "Invalid author email" as an auth failure).
   * Everything else is a retryable `error`.
   */
  private async classifyFailure(
    repo: string,
    scope: RepoOperationScope,
    err: unknown
  ): Promise<StoredRepoStatePatch> {
    const message = errorMessage(err);
    const lastFailureAt = Date.now();
    if (err instanceof GitAuthError) {
      return { status: "auth-failed", lastError: message, lastFailureAt };
    }
    if (err instanceof GitPushRejectedError) {
      // Confirm divergence deterministically before pausing pushes on it.
      const counts = await this.aheadBehind(repo, scope, { fetch: true }).catch(() => null);
      if (counts?.diverged) {
        return { status: "diverged", lastError: message, lastFailureAt };
      }
      if (counts && counts.behindBy > 0) {
        return { status: "behind", lastError: message, lastFailureAt };
      }
      return { status: "error", lastError: message, lastFailureAt };
    }
    return { status: "error", lastError: message, lastFailureAt };
  }

  private async handlePushFailure(
    repo: string,
    scope: RepoOperationScope,
    err: unknown,
    force: boolean
  ): Promise<void> {
    const patch = await this.classifyFailure(repo, scope, err);
    // A forced push that still failed is never a divergence pause — the caller
    // explicitly chose to overwrite; keep it retryable.
    if (force && patch.status === "diverged") {
      patch.status = "error";
    }
    await this.updateRepoState(repo, scope.fingerprint, patch);
  }

  private async handlePullFailure(
    repo: string,
    scope: RepoOperationScope,
    err: unknown
  ): Promise<void> {
    await this.updateRepoState(
      repo,
      scope.fingerprint,
      await this.classifyFailure(repo, scope, err)
    );
  }

  private async handleAutoFailure(
    repo: string,
    scope: RepoOperationScope,
    upstream: ResolvedWorkspaceGitUpstream,
    err: unknown
  ): Promise<void> {
    const fingerprint = scope.fingerprint;
    const patch = await this.classifyFailure(repo, scope, err);
    if (
      patch.status === "auth-failed" ||
      patch.status === "behind" ||
      patch.status === "diverged"
    ) {
      if (await this.updateRepoState(repo, fingerprint, patch)) {
        await this.showFailureNotification(repo, upstream, patch.lastError ?? errorMessage(err));
      }
      return;
    }
    const runtime = this.runtime.get(repo);
    if (!runtime || runtime.configFingerprint !== fingerprint) return;
    const nextBackoff = Math.min(
      runtime.backoffMs ? runtime.backoffMs * 2 : TRANSIENT_BACKOFF_MIN_MS,
      TRANSIENT_BACKOFF_MAX_MS
    );
    if (await this.updateRepoState(repo, fingerprint, patch)) {
      runtime.backoffMs = nextBackoff;
      runtime.retryAt = Date.now() + nextBackoff;
      this.scheduleRetry(repo, fingerprint, nextBackoff);
    }
  }

  private async showFailureNotification(
    repo: string,
    upstream: ResolvedWorkspaceGitUpstream,
    reason: string
  ): Promise<void> {
    const remote = `${upstream.remote}/${upstream.branch}`;
    await this.ctx.notifications.show({
      type: "warning",
      title: `Push to ${remote} failed`,
      message: reason,
      actions: [
        {
          id: "retry",
          label: "Retry",
          invoke: {
            kind: "extension",
            extension: this.ctx.name,
            method: "retryUpstreamPush",
            args: [repo],
          },
        },
        {
          id: "open-git-tab",
          label: "Open Git tab",
          invoke: {
            kind: "extension",
            extension: this.ctx.name,
            method: "openGitTab",
            args: [repo],
          },
        },
        {
          id: "pause-auto-push",
          label: "Pause auto-push",
          invoke: {
            kind: "extension",
            extension: this.ctx.name,
            method: "pauseAutoPush",
            args: [repo],
          },
        },
      ],
    });
  }

  private async previewOverwrites(
    git: GitClient,
    dir: string,
    remoteRef: string,
    remoteHead: string | null,
    counts: { ahead: number; behind: number; diverged: boolean } | null
  ): Promise<GitOverwritePreview | undefined> {
    if (!remoteHead) return undefined;
    if (!counts) {
      const remoteCommits = await this.commitSummaries(
        git,
        dir,
        remoteRef,
        OVERWRITE_PREVIEW_LIMIT + 1
      );
      return {
        relationship: "unrelated",
        count: null,
        commits: remoteCommits.slice(0, OVERWRITE_PREVIEW_LIMIT),
        truncated: remoteCommits.length > OVERWRITE_PREVIEW_LIMIT,
      };
    }
    const count = counts.behind;
    if (count === 0) return undefined;
    return {
      relationship: "related",
      count,
      commits: await this.commitSummaries(
        git,
        dir,
        remoteRef,
        Math.min(count, OVERWRITE_PREVIEW_LIMIT)
      ),
      truncated: count > OVERWRITE_PREVIEW_LIMIT,
    };
  }

  private async commitSummaries(
    git: GitClient,
    dir: string,
    ref: string,
    limit: number
  ): Promise<Array<{ sha: string; summary: string }>> {
    if (limit <= 0) return [];
    const commits = await git.log(dir, { ref, depth: limit });
    return commits.map((commit) => ({
      sha: commit.oid,
      summary: firstLine(commit.message),
    }));
  }

  /** Compare the local checkout with its remote-tracking ref.
   *
   * Callers that need wire truth fetch explicitly before reaching this helper.
   * Other internal callers intentionally compare an already-observed ref.
   */
  private async aheadBehind(
    repo: string,
    scope: RepoOperationScope,
    options: { fetch?: boolean } = {}
  ): Promise<{ aheadBy: number; behindBy: number; diverged: boolean }> {
    const dir = await this.bridge.repoGitDir(repo);
    const git = this.gitClient(scope.credential);
    if (options.fetch === true) {
      const fetched = await git.fetch({
        dir,
        url: scope.remote.url,
        remote: scope.transportRemote,
        ref: scope.upstream.branch,
      });
      if (!fetched.remoteRefExists) {
        return { aheadBy: 1, behindBy: 0, diverged: false };
      }
    }
    const remoteRef = `refs/remotes/${scope.transportRemote}/${scope.upstream.branch}`;
    const remoteHead = await git.resolveRef(dir, remoteRef);
    if (!remoteHead) {
      // Nothing known upstream (never fetched, or the branch doesn't exist
      // yet): everything local is ahead — NOT diverged.
      return { aheadBy: 1, behindBy: 0, diverged: false };
    }
    const counts = await git.compareRefs(dir, "HEAD", remoteRef);
    // Both refs exist but share no merge base: genuinely unrelated histories.
    if (!counts) return { aheadBy: 1, behindBy: 1, diverged: true };
    return { aheadBy: counts.ahead, behindBy: counts.behind, diverged: counts.diverged };
  }

  private setRunning(repo: string, fingerprint: string, state: "exporting" | "pushing"): void {
    const runtime = this.runtime.get(repo);
    if (!runtime || runtime.configFingerprint !== fingerprint) return;
    runtime.running = state;
  }

  private clearRunning(repo: string, fingerprint: string): void {
    const runtime = this.runtime.get(repo);
    if (runtime?.configFingerprint === fingerprint) delete runtime.running;
  }

  private clearBackoff(repo: string, fingerprint: string): void {
    const runtime = this.runtime.get(repo);
    if (!runtime || runtime.configFingerprint !== fingerprint) return;
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    delete runtime.retryTimer;
    delete runtime.backoffMs;
    delete runtime.retryAt;
  }

  private resetRuntimeScope(repo: string, fingerprint: string): void {
    const runtime = this.runtime.get(repo);
    if (runtime?.configFingerprint === fingerprint) return;
    if (runtime?.retryTimer) clearTimeout(runtime.retryTimer);
    this.runtime.set(repo, {
      configFingerprint: fingerprint,
      ...(runtime && "credentialIdOverride" in runtime
        ? { credentialIdOverride: runtime.credentialIdOverride }
        : {}),
      ...(runtime?.debounceTimer ? { debounceTimer: runtime.debounceTimer } : {}),
    });
  }

  private async resolveRepoScope(
    repo: string,
    options: { persistState?: boolean; credentialIdOverride?: string | null } = {}
  ): Promise<RepoOperationScope> {
    const config = await this.readConfig();
    const upstream = this.requireUpstream(config, repo);
    const remote = this.requireRemote(config, repo, upstream.remote);
    const configFingerprint = upstreamConfigFingerprint(repo, upstream, remote);
    let stored: StoredRepoState;
    if (options.persistState === false) {
      const current = (await this.readState()).repos[repo];
      stored =
        current?.configFingerprint === configFingerprint ? { ...current } : { configFingerprint };
    } else {
      stored = await this.reconcileRepoState(repo, upstream, remote);
    }
    return {
      upstream,
      remote,
      credential: this.credentialFor(upstream, remote, options.credentialIdOverride),
      fingerprint: configFingerprint,
      stored,
      transportRemote: transportRemoteForFingerprint(configFingerprint),
    };
  }

  private requireUpstream(config: WorkspaceConfig, repo: string): ResolvedWorkspaceGitUpstream {
    const upstream = getDeclaredUpstreamForRepo(config, repo);
    if (!upstream) throw new Error(`No upstream is configured for ${repo}`);
    return upstream;
  }

  private requireRemote(
    config: WorkspaceConfig,
    repo: string,
    remoteName: string
  ): WorkspaceGitRemoteConfig {
    const remote = getDeclaredRemoteForRepo(config, repo, remoteName);
    if (!remote) throw new Error(`No approved remote ${remoteName} is declared for ${repo}`);
    return remote;
  }

  private applyStatusOptions(
    config: WorkspaceConfig,
    repo: string,
    upstream: ResolvedWorkspaceGitUpstream,
    options: GitUpstreamStatusOptions
  ): ResolvedWorkspaceGitUpstream {
    const remoteName = options.remote
      ? validateWorkspaceGitRemoteName(options.remote)
      : upstream.remote;
    const remote = this.requireRemote(config, repo, remoteName);
    const branch = options.branch
      ? validateWorkspaceGitRemoteBranch(options.branch)
      : remoteName === upstream.remote
        ? upstream.branch
        : (remote.branch ?? DEFAULT_BRANCH);
    return {
      ...upstream,
      remote: remoteName,
      branch,
    };
  }

  private credentialFor(
    upstream: ResolvedWorkspaceGitUpstream,
    remote: WorkspaceGitRemoteConfig,
    credentialIdOverride: string | null | undefined
  ): GitCredentialSelection {
    if (credentialIdOverride !== undefined) return { credentialId: credentialIdOverride };
    if (upstream.credential) {
      return {
        logicalCredential: {
          name: upstream.credential,
          remoteUrl: remote.url,
        },
      };
    }
    return { credentialId: null };
  }

  private async readConfig(): Promise<WorkspaceConfig> {
    const config = await this.ctx.rpc.call<WorkspaceConfig | null>("main", "workspace.getConfig");
    if (!config) throw new Error("Workspace config is unavailable");
    return config;
  }

  private gitClient(
    credential: GitCredentialSelection = { credentialId: null },
    gitIntent?: { force: boolean; overwrites?: GitOverwritePreview }
  ): GitClient {
    return new GitClient(fsp, {
      http: this.gitHttp(credential, gitIntent),
    });
  }

  private gitHttp(
    credential: GitCredentialSelection,
    gitIntent?: { force: boolean; overwrites?: GitOverwritePreview }
  ) {
    return this.ctx.credentials.gitHttp({
      ...credential,
      ...(gitIntent ? { gitIntent } : {}),
    });
  }

  private async readState(): Promise<StoredState> {
    try {
      const raw = await this.ctx.storage.readFile(STATE_FILE, "utf8");
      const parsed: unknown = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
      return parseStoredState(parsed) ?? emptyStoredState();
    } catch {
      return emptyStoredState();
    }
  }

  /** Serializes the WHOLE state transaction: concurrent per-repo jobs share
   *  one state file, so an unserialized read would clobber sibling repos. */
  private stateTransaction<T>(
    transact: (state: StoredState) => { result: T; changed: boolean }
  ): Promise<T> {
    const run = this.stateWrite.then(async () => {
      const state = await this.readState();
      const outcome = transact(state);
      if (outcome.changed) {
        await this.ctx.storage.mkdir("state", { recursive: true });
        await this.ctx.storage.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
      }
      return outcome.result;
    });
    this.stateWrite = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async reconcileRepoState(
    repo: string,
    upstream: ResolvedWorkspaceGitUpstream,
    remote: WorkspaceGitRemoteConfig
  ): Promise<StoredRepoState> {
    const configFingerprint = upstreamConfigFingerprint(repo, upstream, remote);
    const stored = await this.stateTransaction((state) => {
      const current = state.repos[repo];
      if (current?.configFingerprint === configFingerprint) {
        return { result: { ...current }, changed: false };
      }
      const next: StoredRepoState = { configFingerprint };
      state.repos[repo] = next;
      return { result: { ...next }, changed: true };
    });
    this.resetRuntimeScope(repo, configFingerprint);
    return stored;
  }

  private async clearRepoState(repo: string): Promise<void> {
    await this.stateTransaction((state) => {
      if (!(repo in state.repos)) return { result: undefined, changed: false };
      delete state.repos[repo];
      return { result: undefined, changed: true };
    });
    const runtime = this.runtime.get(repo);
    if (runtime?.debounceTimer) clearTimeout(runtime.debounceTimer);
    if (runtime?.retryTimer) clearTimeout(runtime.retryTimer);
    this.runtime.delete(repo);
  }

  private updateRepoState(
    repo: string,
    fingerprint: string,
    patch: StoredRepoStatePatch
  ): Promise<boolean> {
    return this.stateTransaction((state) => {
      const current = state.repos[repo];
      // This is a configuration-token compare-and-set. A completion from an
      // operation started under config A can never mutate config B's state.
      if (current?.configFingerprint !== fingerprint) {
        return { result: false, changed: false };
      }
      const next = { ...current, ...patch };
      if (patch.status === undefined) delete next.status;
      if (patch.lastError === undefined) delete next.lastError;
      if (patch.lastFailureAt === undefined) delete next.lastFailureAt;
      state.repos[repo] = next;
      return { result: true, changed: true };
    });
  }

  private async reportHealth(): Promise<void> {
    if (!this.ctx.health) return;
    await this.stateWrite;
    const state = await this.readState();
    const degraded = Object.entries(state.repos)
      .filter(
        ([, repo]) =>
          repo.status === "auth-failed" || repo.status === "behind" || repo.status === "diverged"
      )
      .map(([repo, status]) => `${repo}: ${status.status}`);
    if (degraded.length === 0) {
      this.ctx.health.healthy({ summary: "git upstream healthy" });
      return;
    }
    this.ctx.health.report("degraded", {
      summary: "git upstream attention required",
      reasons: degraded,
    });
  }
}

function statusFromCounts(
  aheadBy: number,
  behindBy: number,
  diverged = aheadBy > 0 && behindBy > 0
): GitUpstreamRelationship {
  if (diverged) return "diverged";
  if (aheadBy > 0) return "ahead";
  if (behindBy > 0) return "behind";
  return "in-sync";
}

function firstLine(message: string): string {
  return message.split(/\r?\n/, 1)[0]?.trim() || "(no summary)";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function attachGitCleanupFailure(
  primary: unknown,
  cleanup: unknown,
  stage: "restore-import-config"
): Error {
  const error = primary instanceof Error ? primary : new Error(String(primary));
  const existing =
    isRecord(error) && isRecord(error["errorData"])
      ? error["errorData"]
      : {};
  const errorData = {
    ...existing,
    cleanupFailures: [
      {
        stage,
        message: errorMessage(cleanup),
      },
    ],
  };
  try {
    Object.defineProperty(error, "errorData", {
      value: errorData,
      writable: true,
      configurable: true,
    });
    return error;
  } catch {
    const wrapped = new Error(error.message, { cause: error });
    Object.defineProperty(wrapped, "errorData", {
      value: errorData,
      writable: true,
      configurable: true,
    });
    return wrapped;
  }
}

function declaredUpstreamConfig(
  upstream: ResolvedWorkspaceGitUpstream
): WorkspaceGitUpstreamConfig {
  return {
    remote: upstream.remote,
    branch: upstream.branch,
    autoPush: upstream.autoPush,
    ...(upstream.credential !== undefined ? { credential: upstream.credential } : {}),
    ...(upstream.authorEmail !== undefined ? { authorEmail: upstream.authorEmail } : {}),
    ...(upstream.authorName !== undefined ? { authorName: upstream.authorName } : {}),
  };
}

function displayRemote(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname.replace(/\.git$/, "")}`;
  } catch {
    return url;
  }
}

function upstreamConfigFingerprint(
  repo: string,
  upstream: ResolvedWorkspaceGitUpstream,
  remote: WorkspaceGitRemoteConfig
): string {
  const identity = {
    repoPath: repo,
    upstream: {
      remote: upstream.remote,
      branch: upstream.branch,
      autoPush: upstream.autoPush,
      credentialSelection:
        upstream.credential === undefined
          ? { mode: "anonymous" }
          : { mode: "logical", name: upstream.credential },
      authorEmail: upstream.authorEmail ?? null,
      authorName: upstream.authorName ?? null,
    },
    remote: {
      name: remote.name,
      url: remote.url,
      branch: remote.branch ?? null,
    },
  };
  return stableSha256Hex(identity);
}

function transportRemoteForFingerprint(fingerprint: string): string {
  return `vibestudio-${fingerprint.slice(0, 24)}`;
}

function emptyStoredState(): StoredState {
  return { version: 2, repos: {} };
}

const STORED_UPSTREAM_STATES = new Set<StoredUpstreamState>([
  "in-sync",
  "ahead",
  "behind",
  "diverged",
  "auth-failed",
  "error",
]);

function parseStoredState(value: unknown): StoredState | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "repos"])) return null;
  const version = value["version"];
  const repoValues = value["repos"];
  if (version !== 2 || !isRecord(repoValues)) return null;
  const repos: Record<string, StoredRepoState> = {};
  for (const [repo, candidate] of Object.entries(repoValues)) {
    try {
      if (normalizeWorkspaceRepoPath(repo) !== repo) return null;
    } catch {
      return null;
    }
    if (!isRecord(candidate)) return null;
    const configFingerprint = candidate["configFingerprint"];
    const lastPushedSha = candidate["lastPushedSha"];
    const lastPushedAt = candidate["lastPushedAt"];
    const lastSuccessfulObservationAt = candidate["lastSuccessfulObservationAt"];
    const status = candidate["status"];
    const lastError = candidate["lastError"];
    const lastFailureAt = candidate["lastFailureAt"];
    if (
      !hasOnlyKeys(candidate, [
        "configFingerprint",
        "lastPushedSha",
        "lastPushedAt",
        "lastSuccessfulObservationAt",
        "status",
        "lastError",
        "lastFailureAt",
      ]) ||
      typeof configFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(configFingerprint) ||
      (lastPushedSha !== undefined &&
        (typeof lastPushedSha !== "string" || lastPushedSha.length === 0)) ||
      (lastPushedAt !== undefined &&
        (typeof lastPushedAt !== "number" ||
          !Number.isInteger(lastPushedAt) ||
          lastPushedAt < 0)) ||
      (lastSuccessfulObservationAt !== undefined &&
        (typeof lastSuccessfulObservationAt !== "number" ||
          !Number.isInteger(lastSuccessfulObservationAt) ||
          lastSuccessfulObservationAt < 0)) ||
      (status !== undefined &&
        (typeof status !== "string" ||
          !STORED_UPSTREAM_STATES.has(status as StoredUpstreamState))) ||
      (lastError !== undefined && typeof lastError !== "string") ||
      (lastFailureAt !== undefined &&
        (typeof lastFailureAt !== "number" ||
          !Number.isInteger(lastFailureAt) ||
          lastFailureAt < 0))
    ) {
      return null;
    }
    repos[repo] = {
      configFingerprint,
      ...(lastPushedSha !== undefined ? { lastPushedSha } : {}),
      ...(lastPushedAt !== undefined ? { lastPushedAt } : {}),
      ...(lastSuccessfulObservationAt !== undefined ? { lastSuccessfulObservationAt } : {}),
      ...(status !== undefined ? { status: status as StoredUpstreamState } : {}),
      ...(lastError !== undefined ? { lastError } : {}),
      ...(lastFailureAt !== undefined ? { lastFailureAt } : {}),
    };
  }
  return { version: 2, repos };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
