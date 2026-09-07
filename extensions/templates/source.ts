import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import { findMatchingUrlAudience } from "@vibestudio/credential-client/urlAudience";
import {
  discoverDefaultGitSnapshot,
  GitClient,
  readExactGitSnapshot,
  readThroughImmutableGitCheckout,
  withTemporaryGitCheckout,
  type ExactGitSnapshot,
  type SnapshotContentSink,
} from "@vibestudio/git";
import { gitCheckoutsPath } from "@vibestudio/workspace/gitCheckouts";
import type { WorkspaceTemplateDeclaration, WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import { normalizeTemplateGitUrl } from "@vibestudio/workspace/templateCoordinates";
import {
  ExactGitRegistryAcquirer,
  FileTemplateRegistryCache,
  TemplateRegistryClient,
  parseTemplateRegistrySource,
  type TemplateCatalogSnapshot,
  type TemplateRegistryClientOptions,
  type TemplateRegistrySource,
} from "@workspace/template-registry";
import type { ExtensionContextLike } from "./context.js";

function transportUrl(url: string): string {
  return url.startsWith("git+") ? url.slice(4) : url;
}

function credentialFor(
  source: Pick<TemplateRegistrySource, "url" | "credential">
): { credentialId: null } | { logicalCredential: { name: string; remoteUrl: string } } {
  return source.credential
    ? {
        logicalCredential: {
          name: source.credential,
          remoteUrl: transportUrl(source.url),
        },
      }
    : { credentialId: null };
}

export class TemplateCredentialRequired extends Error {
  readonly errorData: {
    code: "CredentialRequirementUnsatisfied";
    name: string;
    use: "git-http";
    url: string;
    provider: string;
  };

  constructor(readonly requirement: { name: string; remoteUrl: string; provider: string }) {
    super(`Connect credential ${JSON.stringify(requirement.name)} for ${requirement.remoteUrl}`);
    this.name = "TemplateCredentialRequired";
    this.errorData = {
      code: "CredentialRequirementUnsatisfied",
      name: requirement.name,
      use: "git-http",
      url: requirement.remoteUrl,
      provider: requirement.provider,
    };
  }
}

export async function missingTemplateCredential(
  ctx: ExtensionContextLike,
  source: Pick<TemplateRegistrySource, "url" | "credential">
): Promise<TemplateCredentialRequired | null> {
  if (!source.credential) return null;
  const remoteUrl = transportUrl(source.url);
  const target = new URL(remoteUrl);
  const stored = await ctx.credentials.listStoredCredentials();
  const found = stored.some(
    (credential) =>
      credential.lifecycle.state !== "revoked" &&
      credential.label === source.credential &&
      credential.bindings?.some(
        (binding) =>
          binding.use === "git-http" && !!findMatchingUrlAudience(target, binding.audience)
      )
  );
  return found
    ? null
    : new TemplateCredentialRequired({
        name: source.credential,
        remoteUrl,
        provider: target.hostname,
      });
}

async function requireTemplateCredential(
  ctx: ExtensionContextLike,
  source: Pick<TemplateRegistrySource, "url" | "credential">
): Promise<void> {
  const missing = await missingTemplateCredential(ctx, source);
  if (missing) throw missing;
}

function contentSink(ctx: ExtensionContextLike): SnapshotContentSink {
  return {
    async put(bytes) {
      return ctx.rpc.call("main", "blobstore.putBase64", Buffer.from(bytes).toString("base64"));
    },
  };
}

function gitClient(
  ctx: ExtensionContextLike,
  source: Pick<TemplateRegistrySource, "url" | "credential">
): GitClient {
  return new GitClient(fsp, {
    http: ctx.credentials.gitHttp(credentialFor(source)),
  });
}

export async function createRegistryClient(
  ctx: ExtensionContextLike,
  input: {
    statePath: string;
    systemEpoch: number;
    registry: unknown;
  }
): Promise<TemplateRegistryClient> {
  const source = parseTemplateRegistrySource(input.registry);
  await requireTemplateCredential(ctx, source);
  const checkoutRoot = path.join(gitCheckoutsPath(input.statePath), "_template-registry");
  const options: TemplateRegistryClientOptions = {
    source,
    systemEpoch: input.systemEpoch,
    acquirer: new ExactGitRegistryAcquirer({
      git: gitClient(ctx, source),
      checkoutRoot,
      sink: contentSink(ctx),
    }),
    cache: new FileTemplateRegistryCache(
      path.join(
        input.statePath,
        "template-registry",
        `cache-v1-epoch-${input.systemEpoch}.json`,
      ),
    ),
  };
  return new TemplateRegistryClient(options);
}

/**
 * Exact immutable acquisition. The ref is used only to fetch the repository;
 * a moving branch is allowed to have advanced after the state was written.
 * Identity and integrity come from the operation's selected commit and snapshot.
 */
export async function acquireTemplateSnapshot(
  ctx: ExtensionContextLike,
  statePath: string,
  pin: WorkspaceTemplatePin,
  nodeId: string
): Promise<ExactGitSnapshot> {
  if (!/^t-[0-9a-f]+$/u.test(nodeId)) {
    throw new Error(`Invalid canonical template node id: ${nodeId}`);
  }
  const checkout = path.join(
    gitCheckoutsPath(statePath),
    "_templates",
    nodeId,
    `${pin.commit}-${pin.snapshot.slice("v1-sha256:".length)}`
  );
  const source = { url: pin.url, credential: pin.credential };
  await requireTemplateCredential(ctx, source);
  const git = gitClient(ctx, source);
  const read = (directory: string) =>
    readExactGitSnapshot({
      git,
      dir: directory,
      commit: pin.commit,
      label: `template ${nodeId}`,
      sink: contentSink(ctx),
      expectedSnapshot: pin.snapshot,
      reservedPaths: "exclude",
    });
  return readThroughImmutableGitCheckout({
    fs: fsp,
    target: checkout,
    label: "acquire",
    read,
    async prepare(directory) {
      await git.clone({
        url: transportUrl(pin.url),
        dir: directory,
        ref: pin.ref,
        singleBranch: false,
        fullHistory: true,
      });
      await git.checkout(directory, pin.commit, { force: true });
      return read(directory);
    },
  });
}

/**
 * Resolve one direct user-authored URL exactly once. The returned pin is the
 * durable intent; installation and resume paths consume only those frozen
 * coordinates and never rediscover a moving default branch.
 */
export async function discoverDirectTemplatePin(
  ctx: ExtensionContextLike,
  statePath: string,
  declaration: WorkspaceTemplateDeclaration
): Promise<WorkspaceTemplatePin> {
  const url = normalizeTemplateGitUrl(declaration.url);
  const source = { url, credential: declaration.credential };
  await requireTemplateCredential(ctx, source);
  const snapshot = await withTemporaryGitCheckout(
    fsp,
    path.join(gitCheckoutsPath(statePath), "_template-discovery"),
    "direct-template",
    (directory) =>
      discoverDefaultGitSnapshot({
        git: gitClient(ctx, source),
        dir: directory,
        url: transportUrl(url),
        label: `template ${url}`,
        sink: contentSink(ctx),
        reservedPaths: "exclude",
      })
  );
  return WorkspaceTemplatePinSchema.parse({
    url,
    ...(declaration.credential ? { credential: declaration.credential } : {}),
    ref: snapshot.ref,
    commit: snapshot.commit,
    snapshot: snapshot.snapshot,
  });
}

export function catalogPin(
  catalog: TemplateCatalogSnapshot,
  catalogId: string,
  registryCommit: string,
  registrySnapshot: string
): WorkspaceTemplatePin {
  if (
    catalog.coordinates.commit !== registryCommit ||
    catalog.coordinates.snapshot !== registrySnapshot
  ) {
    throw new Error("The template catalog changed after it was shown; refresh and review it again");
  }
  const entry = catalog.entries.find((candidate) => candidate.id === catalogId);
  if (!entry) throw new Error(`Unknown or retired template registry entry: ${catalogId}`);
  return WorkspaceTemplatePinSchema.parse({ url: entry.url, ...entry.promoted });
}
