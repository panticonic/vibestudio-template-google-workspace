import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import { canonicalJson, sha256Hex, sha256HexSyncText } from "@vibestudio/content-addressing";
import {
  GitClient,
  GitPushRejectedError,
  readExactGitSnapshot,
  withTemporaryGitCheckout,
} from "@vibestudio/git";
import {
  normalizeTemplateGitUrl,
  templateGitTransportUrl,
} from "@vibestudio/workspace/templateCoordinates";
import type { ExtensionContextLike } from "./context.js";
import { ensureExternalSemanticIntent } from "./semanticIntent.js";

const FULL_OID = /^[0-9a-f]{40}$/u;
const SNAPSHOT = /^v1-sha256:[0-9a-f]{64}$/u;
const REGISTRY_PATH = "registry.yml";
const REMOTE = "vibestudio-registry-contribution";
const OPERATION_TRAILER = "Vibestudio-Registry-Operation:";
const REQUEST_TRAILER = "Vibestudio-Registry-Request:";

export interface RegistryContributionInput {
  operationId: string;
  registryUrl: string;
  baseCommit: string;
  baseSnapshot: string;
  registryDocument: string;
  entryId: string;
  credential?: string;
}

export interface RegistryContributionResult {
  outcome: "pushed" | "already-at-remote" | "nothing-to-suggest";
  registryUrl: string;
  baseCommit: string;
  branch: string | null;
  headCommit: string | null;
}

function trailer(message: string, name: string): string | null {
  const prefix = `${name} `;
  return (
    message
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.startsWith(prefix))
      ?.slice(prefix.length)
      .trim() ?? null
  );
}

function validate(input: RegistryContributionInput): RegistryContributionInput {
  if (!input.operationId.trim()) throw new Error("Registry contribution operationId is required");
  if (!FULL_OID.test(input.baseCommit)) {
    throw new Error("Registry contribution baseCommit must be one full lowercase Git object id");
  }
  if (!SNAPSHOT.test(input.baseSnapshot)) {
    throw new Error("Registry contribution baseSnapshot must be a canonical digest");
  }
  if (!input.registryDocument.endsWith("\n")) {
    throw new Error("Registry contribution document must end with a newline");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(input.entryId)) {
    throw new Error("Registry contribution entryId must be a stable lowercase id");
  }
  return { ...input, registryUrl: normalizeTemplateGitUrl(input.registryUrl) };
}

function canonicalTree(tree: Awaited<ReturnType<GitClient["readCommitTree"]>>): string {
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

async function exactSnapshot(
  ctx: ExtensionContextLike,
  git: GitClient,
  dir: string,
  commit: string
) {
  return readExactGitSnapshot({
    git,
    dir,
    commit,
    label: "template registry contribution base",
    sink: {
      put: async (bytes) =>
        ctx.rpc.call<{ digest: string; size: number }>(
          "main",
          "blobstore.putBase64",
          Buffer.from(bytes).toString("base64")
        ),
    },
    reservedPaths: "exclude",
  });
}

export class RegistryContributionEngine {
  constructor(private readonly ctx: ExtensionContextLike) {}

  async suggest(rawInput: RegistryContributionInput): Promise<RegistryContributionResult> {
    const input = validate(rawInput);
    const requestFingerprint = `v1-sha256:${sha256HexSyncText(
      canonicalJson({
        protocol: "vibestudio-template-registry-contribution/v1",
        operationId: input.operationId,
        registryUrl: input.registryUrl,
        baseCommit: input.baseCommit,
        baseSnapshot: input.baseSnapshot,
        entryId: input.entryId,
        registryDocument: input.registryDocument,
      })
    )}`;
    await ensureExternalSemanticIntent({
      ctx: this.ctx,
      contextId: `context-template-registry-${sha256HexSyncText(input.operationId).slice(0, 32)}`,
      fileName: "template-registry-contribution-intent.json",
      intent: {
        version: 1,
        operationId: input.operationId,
        requestFingerprint,
        registryUrl: input.registryUrl,
        baseCommit: input.baseCommit,
        baseSnapshot: input.baseSnapshot,
        entryId: input.entryId,
      },
      operationLabel: `template registry contribution ${input.operationId}`,
    });
    const branch = `vibestudio/registry/${input.entryId}/${requestFingerprint.slice(-24)}`;
    const transportUrl = templateGitTransportUrl(input.registryUrl);
    const git = new GitClient(fsp, {
      http: this.ctx.credentials.gitHttp(
        input.credential
          ? { logicalCredential: { name: input.credential, remoteUrl: transportUrl } }
          : undefined
      ),
    });
    return withTemporaryGitCheckout(
      fsp,
      path.join(this.ctx.storage.root, "git-checkouts", "_template-registry-contributions"),
      requestFingerprint,
      async (checkout) => {
        await git.clone({
          url: transportUrl,
          dir: checkout,
          ref: input.baseCommit,
          singleBranch: false,
          fullHistory: true,
        });
        const observed = await exactSnapshot(this.ctx, git, checkout, input.baseCommit);
        if (observed.commit !== input.baseCommit || observed.snapshot !== input.baseSnapshot) {
          throw new Error("The registry contribution base does not match the reviewed snapshot");
        }
        const current = await fsp.readFile(path.join(checkout, REGISTRY_PATH), "utf8");
        if (current === input.registryDocument) {
          return {
            outcome: "nothing-to-suggest",
            registryUrl: input.registryUrl,
            baseCommit: input.baseCommit,
            branch: null,
            headCommit: null,
          };
        }
        await git.createBranch({
          dir: checkout,
          name: branch,
          startPoint: input.baseCommit,
          checkout: true,
        });
        await fsp.writeFile(path.join(checkout, REGISTRY_PATH), input.registryDocument, "utf8");
        await git.addAll(checkout);
        const headCommit = await git.commit({
          dir: checkout,
          message:
            `Suggest template registry entry ${input.entryId}\n\n` +
            `${OPERATION_TRAILER} ${input.operationId}\n` +
            `${REQUEST_TRAILER} ${requestFingerprint}`,
          author: { name: "Vibestudio", email: "vibestudio@local" },
        });
        const validateRemote = async (remoteHead: string) => {
          const [remoteTree, localTree, history] = await Promise.all([
            git.readCommitTree(checkout, remoteHead),
            git.readCommitTree(checkout, headCommit),
            git.log(checkout, { ref: remoteHead, depth: 2 }),
          ]);
          if (canonicalTree(remoteTree) !== canonicalTree(localTree)) {
            throw new Error(
              "Registry contribution branch has a different exact tree at the remote"
            );
          }
          const commit = history[0];
          if (
            !commit ||
            commit.parentOids.length !== 1 ||
            commit.parentOids[0] !== input.baseCommit ||
            trailer(commit.message, OPERATION_TRAILER) !== input.operationId ||
            trailer(commit.message, REQUEST_TRAILER) !== requestFingerprint
          ) {
            throw new Error(
              "Registry contribution branch does not match its exact reviewed intent"
            );
          }
        };
        const fetched = await git.fetch({
          dir: checkout,
          url: transportUrl,
          remote: REMOTE,
          ref: branch,
        });
        if (fetched.remoteRefExists) {
          const remoteHead = await git.resolveRef(checkout, `refs/remotes/${REMOTE}/${branch}`);
          if (!remoteHead) throw new Error(`Cannot resolve remote registry branch ${branch}`);
          await validateRemote(remoteHead);
          return {
            outcome: "already-at-remote",
            registryUrl: input.registryUrl,
            baseCommit: input.baseCommit,
            branch,
            headCommit: remoteHead,
          };
        }
        try {
          await git.push({
            dir: checkout,
            url: transportUrl,
            remote: REMOTE,
            ref: branch,
            remoteRef: `refs/heads/${branch}`,
          });
          return {
            outcome: "pushed",
            registryUrl: input.registryUrl,
            baseCommit: input.baseCommit,
            branch,
            headCommit,
          };
        } catch (error) {
          if (!(error instanceof GitPushRejectedError)) throw error;
          const raced = await git.fetch({
            dir: checkout,
            url: transportUrl,
            remote: REMOTE,
            ref: branch,
          });
          const remoteHead = raced.remoteRefExists
            ? await git.resolveRef(checkout, `refs/remotes/${REMOTE}/${branch}`)
            : null;
          if (!remoteHead) throw error;
          await validateRemote(remoteHead);
          return {
            outcome: "already-at-remote",
            registryUrl: input.registryUrl,
            baseCommit: input.baseCommit,
            branch,
            headCommit: remoteHead,
          };
        }
      }
    );
  }
}
