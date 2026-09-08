import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import { findMatchingUrlAudience } from "@vibestudio/credential-client/urlAudience";
import {
  discoverDefaultGitSnapshot,
  GitClient,
  withTemporaryGitCheckout,
  type SnapshotContentSink,
} from "@vibestudio/git";
import { gitCheckoutsPath } from "@vibestudio/workspace/gitCheckouts";
import type {
  WorkspaceTemplateDeclaration,
  WorkspaceTemplatePin,
} from "@vibestudio/workspace-contracts/types";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import { normalizeTemplateGitUrl } from "@vibestudio/workspace/templateCoordinates";
import type { ExtensionContextLike } from "./context.js";

type TemplateSource = Pick<WorkspaceTemplateDeclaration, "url" | "credential">;

function transportUrl(url: string): string {
  return url.startsWith("git+") ? url.slice(4) : url;
}

function credentialFor(
  source: TemplateSource,
):
  | { credentialId: null }
  | { logicalCredential: { name: string; remoteUrl: string } } {
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

  constructor(
    readonly requirement: { name: string; remoteUrl: string; provider: string },
  ) {
    super(
      `Connect credential ${JSON.stringify(requirement.name)} for ${requirement.remoteUrl}`,
    );
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
  source: TemplateSource,
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
          binding.use === "git-http" &&
          !!findMatchingUrlAudience(target, binding.audience),
      ),
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
  source: TemplateSource,
): Promise<void> {
  const missing = await missingTemplateCredential(ctx, source);
  if (missing) throw missing;
}

function contentSink(ctx: ExtensionContextLike): SnapshotContentSink {
  return {
    async put(bytes) {
      return ctx.rpc.call(
        "main",
        "blobstore.putBase64",
        Buffer.from(bytes).toString("base64"),
      );
    },
  };
}

function gitClient(
  ctx: ExtensionContextLike,
  source: TemplateSource,
): GitClient {
  return new GitClient(fsp, {
    http: ctx.credentials.gitHttp(credentialFor(source)),
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
  declaration: WorkspaceTemplateDeclaration,
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
      }),
  );
  return WorkspaceTemplatePinSchema.parse({
    url,
    ...(declaration.credential ? { credential: declaration.credential } : {}),
    ref: snapshot.ref,
    commit: snapshot.commit,
    snapshot: snapshot.snapshot,
  });
}
