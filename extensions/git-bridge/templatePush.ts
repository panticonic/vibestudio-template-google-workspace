import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  canonicalJson,
  compareUtf16CodeUnits,
  sha256Hex,
  sha256HexSyncText,
  type CanonicalSnapshotDigest,
} from "@vibestudio/content-addressing";
import {
  GitClient,
  GitPushRejectedError,
  withTemporaryGitCheckout,
  type GitCommitTreeEntry,
} from "@vibestudio/git";
import { normalizeWorkspaceRepoPath } from "@vibestudio/workspace/remotes";
import {
  normalizeTemplateGitUrl,
  templateGitTransportUrl,
} from "@vibestudio/workspace/templateCoordinates";
import { GitBridge, type ProtectedRepositorySnapshot } from "./bridge.js";
import type { ExtensionContextLike } from "./context.js";
import { ensureExternalSemanticIntent } from "./semanticIntent.js";

const FULL_OID = /^[0-9a-f]{40}$/u;
const NODE_ID = /^t-[0-9a-f]+$/u;
const INTENT_FILE = "template-suggestion-intent.json";
const INTENT_CONTEXT_PREFIX = "context-template-suggestion-";
const TRANSPORT_REMOTE = "vibestudio-template-contribution";

interface TemplatePushPart {
  repoPath: string;
  subdir: string;
}

export interface TemplatePushInput {
  operationId: string;
  nodeId: string;
  alias: string;
  url: string;
  baseCommit: string;
  expectedMainEventId: string;
  parts: TemplatePushPart[];
  credential?: string;
}

export interface TemplatePushResult {
  outcome: "pushed" | "already-at-remote" | "nothing-to-suggest";
  operationId: string;
  branch: string | null;
  /** A forge-owned contribution URL, when a provider can prove one. */
  url?: string;
  headCommit: string | null;
  commits: number;
  parts: string[];
}

interface SnapshotPart {
  part: TemplatePushPart;
  value: ProtectedRepositorySnapshot;
}

interface SuggestionSourceIntent {
  repoPath: string;
  subdir: string;
  repositoryId: string;
  eventId: string;
  treeDigest: CanonicalSnapshotDigest;
}

interface SuggestionIntent {
  version: 1;
  requestFingerprint: string;
  workspaceId: string;
  operationId: string;
  nodeId: string;
  alias: string;
  url: string;
  credential: string | null;
  baseCommit: string;
  expectedMainEventId: string;
  sources: SuggestionSourceIntent[];
}

function safeJoin(root: string, relative: string): string {
  const target = path.resolve(root, ...relative.split("/"));
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Template export path escapes checkout: ${relative}`);
  }
  return target;
}

function canonicalSubdir(value: string): string {
  const normalized = normalizeWorkspaceRepoPath(value);
  if (normalized !== value) {
    throw new Error(`Template contribution subdir must be canonical: ${value}`);
  }
  return normalized;
}

function branchComponent(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized || "workspace";
}

function validateInput(input: TemplatePushInput): TemplatePushInput {
  if (!input.operationId.trim()) throw new Error("Template push operationId is required");
  if (!NODE_ID.test(input.nodeId)) throw new Error(`Invalid template node id ${input.nodeId}`);
  if (!FULL_OID.test(input.baseCommit)) {
    throw new Error("Template push baseCommit must be one full lowercase Git object id");
  }
  if (!input.expectedMainEventId.trim()) {
    throw new Error("Template push expectedMainEventId is required");
  }
  const url = normalizeTemplateGitUrl(input.url);
  const seenRepositories = new Set<string>();
  const parts = input.parts
    .map((part) => ({
      repoPath: normalizeWorkspaceRepoPath(part.repoPath),
      subdir: canonicalSubdir(part.subdir),
    }))
    .sort((left, right) => compareUtf16CodeUnits(left.repoPath, right.repoPath));
  for (const part of parts) {
    if (seenRepositories.has(part.repoPath)) {
      throw new Error(`Duplicate template push part ${part.repoPath}`);
    }
    seenRepositories.add(part.repoPath);
  }
  for (let left = 0; left < parts.length; left += 1) {
    for (let right = left + 1; right < parts.length; right += 1) {
      const a = parts[left]!.subdir;
      const b = parts[right]!.subdir;
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        throw new Error(`Template contribution subdirectories overlap: ${a} and ${b}`);
      }
    }
  }
  return { ...input, url, parts };
}

function createIntent(
  input: TemplatePushInput,
  workspaceId: string,
  snapshots: readonly SnapshotPart[]
): SuggestionIntent {
  const sources = snapshots.map(({ part, value }) => ({
    repoPath: part.repoPath,
    subdir: part.subdir,
    repositoryId: value.repositoryId,
    eventId: value.eventId,
    treeDigest: value.treeDigest,
  }));
  const fingerprintBody = {
    protocol: "vibestudio-template-suggestion-v2",
    workspaceId,
    operationId: input.operationId,
    nodeId: input.nodeId,
    alias: input.alias,
    url: input.url,
    credential: input.credential ?? null,
    baseCommit: input.baseCommit,
    expectedMainEventId: input.expectedMainEventId,
    sources,
  };
  return {
    version: 1,
    requestFingerprint: `request:${sha256HexSyncText(canonicalJson(fingerprintBody))}`,
    workspaceId,
    operationId: input.operationId,
    nodeId: input.nodeId,
    alias: input.alias,
    url: input.url,
    credential: input.credential ?? null,
    baseCommit: input.baseCommit,
    expectedMainEventId: input.expectedMainEventId,
    sources,
  };
}

function contextId(intent: SuggestionIntent): string {
  return `${INTENT_CONTEXT_PREFIX}${sha256HexSyncText(
    canonicalJson({ workspaceId: intent.workspaceId, operationId: intent.operationId })
  ).slice(0, 32)}`;
}

function contributionBranch(intent: SuggestionIntent): string {
  return `vibestudio/${branchComponent(intent.workspaceId)}/${intent.requestFingerprint.slice(
    "request:".length,
    "request:".length + 24
  )}`;
}

async function ensureSemanticIntent(
  ctx: ExtensionContextLike,
  intent: SuggestionIntent
): Promise<void> {
  const id = contextId(intent);
  await ensureExternalSemanticIntent({
    ctx,
    contextId: id,
    fileName: INTENT_FILE,
    intent,
    operationLabel: `template push ${intent.operationId}`,
  });
}

function subtreeMatchesSnapshot(
  tree: readonly GitCommitTreeEntry[],
  subdir: string,
  snapshot: ProtectedRepositorySnapshot
): boolean {
  const prefix = `${subdir}/`;
  const actual = tree
    .filter((entry) => entry.path.startsWith(prefix))
    .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }))
    .sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
  const expectedFiles = [...snapshot.files].sort((left, right) =>
    compareUtf16CodeUnits(left.path, right.path)
  );
  if (actual.length !== expectedFiles.length) return false;
  return actual.every((entry, index) => {
    const expected = expectedFiles[index];
    return (
      expected !== undefined &&
      entry.type === "blob" &&
      entry.path === expected.path &&
      (entry.mode === 0o100755 ? 0o755 : 0o644) === expected.mode &&
      sha256Hex(entry.bytes) === expected.contentHash
    );
  });
}

function canonicalTree(tree: readonly GitCommitTreeEntry[]): string {
  return canonicalJson(
    tree.map((entry) =>
      entry.type === "blob"
        ? {
            path: entry.path,
            type: entry.type,
            mode: entry.mode,
            contentHash: sha256Hex(entry.bytes),
          }
        : { path: entry.path, type: entry.type, mode: entry.mode, oid: entry.oid }
    )
  );
}

function contributionTrailer(intent: SuggestionIntent, source: SuggestionSourceIntent): string {
  return [
    `Vibestudio-Template-Operation: ${intent.operationId}`,
    `Vibestudio-Template-Request: ${intent.requestFingerprint}`,
    `Vibestudio-Event: ${source.eventId}`,
    `Vibestudio-Repository: ${source.repositoryId}`,
    `Vibestudio-State: ${source.eventId}`,
    `Vibestudio-Template-Subtree: ${source.subdir}`,
  ].join("\n");
}

async function validateRemoteContribution(input: {
  git: GitClient;
  checkout: string;
  remoteHead: string;
  localHead: string;
  intent: SuggestionIntent;
  changed: readonly SnapshotPart[];
}): Promise<void> {
  const [remoteTree, localTree, history] = await Promise.all([
    input.git.readCommitTree(input.checkout, input.remoteHead),
    input.git.readCommitTree(input.checkout, input.localHead),
    input.git.log(input.checkout, {
      ref: input.remoteHead,
      depth: input.changed.length + 1,
    }),
  ]);
  if (canonicalTree(remoteTree) !== canonicalTree(localTree)) {
    throw new Error("Template contribution branch has a different exact tree at the remote");
  }
  const base = history[input.changed.length];
  if (!base || base.oid !== input.intent.baseCommit) {
    throw new Error("Template contribution branch does not descend directly from its exact base");
  }
  for (let index = 0; index < input.changed.length; index += 1) {
    const entry = history[index];
    const next = history[index + 1];
    if (!entry || !next || entry.parentOids.length !== 1 || entry.parentOids[0] !== next.oid) {
      throw new Error("Template contribution branch has non-linear or unexpected history");
    }
  }
  const expectedTrailers = new Set(
    input.changed.map(({ part }) => {
      const source = input.intent.sources.find((candidate) => candidate.repoPath === part.repoPath);
      if (!source) throw new Error(`Missing exact intent for ${part.repoPath}`);
      return contributionTrailer(input.intent, source);
    })
  );
  for (const entry of history.slice(0, input.changed.length)) {
    const matched = [...expectedTrailers].find((trailer) => entry.message.includes(trailer));
    if (!matched) {
      throw new Error("Template contribution branch contains a commit outside its exact intent");
    }
    expectedTrailers.delete(matched);
  }
  if (expectedTrailers.size > 0) {
    throw new Error("Template contribution branch is missing exact semantic source commits");
  }
}

/**
 * Build a contribution from protected semantic snapshots in a disposable
 * checkout. The semantic context records immutable command intent; the remote
 * branch is the sole publication journal. No mutable checkout, JSON phase
 * journal, process mutex, or host-owned export frontier participates.
 */
export class TemplatePushEngine {
  constructor(
    private readonly ctx: ExtensionContextLike,
    private readonly bridge: GitBridge
  ) {}

  async push(rawInput: TemplatePushInput): Promise<TemplatePushResult> {
    const input = validateInput(rawInput);
    const info = await this.ctx.workspace.getInfo();
    const snapshots: SnapshotPart[] = [];
    for (const part of input.parts) {
      snapshots.push({
        part,
        value: await this.bridge.readProtectedRepository(part.repoPath, input.expectedMainEventId),
      });
    }
    const intent = createIntent(input, info.id, snapshots);
    await ensureSemanticIntent(this.ctx, intent);
    const branch = contributionBranch(intent);
    const git = this.gitClient(
      input.credential
        ? {
            logicalCredential: {
              name: input.credential,
              remoteUrl: templateGitTransportUrl(input.url),
            },
          }
        : { credentialId: null }
    );
    return withTemporaryGitCheckout(
      fsp,
      path.join(this.ctx.storage.root, "git-checkouts", "_template-contributions"),
      input.nodeId,
      async (checkout) => {
        const transportUrl = templateGitTransportUrl(input.url);
        await git.clone({
          url: transportUrl,
          dir: checkout,
          ref: input.baseCommit,
          singleBranch: false,
          fullHistory: true,
        });
        const baseTree = await git.readCommitTree(checkout, input.baseCommit);
        const changed = snapshots.filter(
          ({ part, value }) => !subtreeMatchesSnapshot(baseTree, part.subdir, value)
        );
        if (changed.length === 0) {
          return {
            outcome: "nothing-to-suggest",
            operationId: input.operationId,
            branch: null,
            headCommit: null,
            commits: 0,
            parts: [],
          };
        }

        await git.createBranch({
          dir: checkout,
          name: branch,
          startPoint: input.baseCommit,
          checkout: true,
        });
        for (const { part, value } of changed) {
          await this.materialize(checkout, part.subdir, value);
          await git.addAll(checkout);
          const source = intent.sources.find((candidate) => candidate.repoPath === part.repoPath);
          if (!source) throw new Error(`Missing exact intent for ${part.repoPath}`);
          await git.commit({
            dir: checkout,
            message:
              `Suggest ${part.repoPath} from ${input.alias}\n\n` +
              contributionTrailer(intent, source),
            author: { name: "Vibestudio", email: "vibestudio@local" },
          });
        }
        const localHead = await git.getCurrentCommit(checkout);
        if (!localHead) throw new Error("Template contribution produced no Git commit");

        const fetched = await git.fetch({
          dir: checkout,
          url: transportUrl,
          remote: TRANSPORT_REMOTE,
          ref: branch,
        });
        if (fetched.remoteRefExists) {
          const remoteHead = await git.resolveRef(
            checkout,
            `refs/remotes/${TRANSPORT_REMOTE}/${branch}`
          );
          if (!remoteHead) throw new Error(`Cannot resolve remote contribution branch ${branch}`);
          await validateRemoteContribution({
            git,
            checkout,
            remoteHead,
            localHead,
            intent,
            changed,
          });
          return {
            outcome: "already-at-remote",
            operationId: input.operationId,
            branch,
            headCommit: remoteHead,
            commits: changed.length,
            parts: changed.map(({ part }) => part.repoPath),
          };
        }

        try {
          await git.push({
            dir: checkout,
            url: transportUrl,
            remote: TRANSPORT_REMOTE,
            ref: branch,
            remoteRef: `refs/heads/${branch}`,
          });
          return {
            outcome: "pushed",
            operationId: input.operationId,
            branch,
            headCommit: localHead,
            commits: changed.length,
            parts: changed.map(({ part }) => part.repoPath),
          };
        } catch (error) {
          if (!(error instanceof GitPushRejectedError)) throw error;
          const raced = await git.fetch({
            dir: checkout,
            url: transportUrl,
            remote: TRANSPORT_REMOTE,
            ref: branch,
          });
          const remoteHead = raced.remoteRefExists
            ? await git.resolveRef(checkout, `refs/remotes/${TRANSPORT_REMOTE}/${branch}`)
            : null;
          if (!remoteHead) throw error;
          await validateRemoteContribution({
            git,
            checkout,
            remoteHead,
            localHead,
            intent,
            changed,
          });
          return {
            outcome: "already-at-remote",
            operationId: input.operationId,
            branch,
            headCommit: remoteHead,
            commits: changed.length,
            parts: changed.map(({ part }) => part.repoPath),
          };
        }
      }
    );
  }

  private async materialize(
    checkout: string,
    subdir: string,
    snapshot: ProtectedRepositorySnapshot
  ): Promise<void> {
    const root = safeJoin(checkout, subdir);
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.mkdir(root, { recursive: true });
    for (const file of snapshot.files) {
      const destination = safeJoin(root, file.path);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.writeFile(destination, file.bytes);
      await fsp.chmod(destination, file.mode & 0o111 ? 0o755 : 0o644);
    }
  }

  private gitClient(
    credential:
      | { credentialId: string | null }
      | { logicalCredential: { name: string; remoteUrl: string } }
  ): GitClient {
    return new GitClient(fsp, {
      http: this.ctx.credentials.gitHttp(credential),
    });
  }
}
