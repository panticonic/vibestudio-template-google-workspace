import { createGitHubClient } from "./github.js";
import type { CredentialClient } from "@vibestudio/credential-client";

export interface RemoteCreateRepoParams {
  name: string;
  organization?: string;
  private: boolean;
  description?: string;
  /** Credential selected by the caller; never sent to the remote API. */
  credentialId?: string;
}

export interface RemoteCreateRepoResult {
  cloneUrl: string;
  webUrl: string;
  owner: string;
}

export interface RemoteRepositoryIdentity {
  provider: string;
  owner: string;
  name: string;
}

export interface RemoteResolveOrCreateRepoParams {
  destination: RemoteRepositoryIdentity;
  creation: {
    private: boolean;
    description?: string;
  };
  /** Credential selected by the caller; never part of repository identity. */
  credentialId?: string;
}

export interface RemoteResolveOrCreateRepoResult {
  destination: RemoteRepositoryIdentity;
  cloneUrl: string;
  webUrl: string;
  created: boolean;
}

export interface RemoteWebUrls {
  webUrl: string;
  ownerUrl: string;
  issuesUrl: string;
  pullRequestsUrl: string;
  actionsUrl: string;
}

export interface RemoteProvider {
  id: string;
  displayName: string;
  matches(idOrUrl: string): boolean;
  createRepo(
    credentials: CredentialClient,
    params: RemoteCreateRepoParams
  ): Promise<RemoteCreateRepoResult>;
  resolveOrCreateRepo(
    credentials: CredentialClient,
    params: RemoteResolveOrCreateRepoParams
  ): Promise<RemoteResolveOrCreateRepoResult>;
  webUrls(remoteUrl: string): RemoteWebUrls | null;
}

interface ParsedGitHubRemote {
  owner: string;
  repo: string;
}

const providers = new Map<string, RemoteProvider>();

export function registerRemoteProvider(provider: RemoteProvider): RemoteProvider {
  const id = provider.id.trim().toLowerCase();
  if (!id) {
    throw new Error("Remote provider id is required");
  }
  providers.set(id, provider);
  return provider;
}

export function getRemoteProvider(idOrUrl: string): RemoteProvider | undefined {
  const input = idOrUrl.trim();
  const providerById = providers.get(input.toLowerCase());
  if (providerById) {
    return providerById;
  }

  for (const provider of providers.values()) {
    if (provider.matches(input)) {
      return provider;
    }
  }
  return undefined;
}

export const githubRemoteProvider: RemoteProvider = {
  id: "github",
  displayName: "GitHub",
  matches: (idOrUrl) => parseGitHubHttpsRemote(idOrUrl) !== null,
  createRepo: (credentials, params) => {
    const { credentialId, ...repoParams } = params;
    return createGitHubClient(credentials, { credentialId }).createRepo(repoParams);
  },
  resolveOrCreateRepo: async (credentials, params) => {
    if (params.destination.provider !== "github") {
      throw new Error(
        `GitHub provider cannot resolve destination provider ${params.destination.provider}`
      );
    }
    const github = createGitHubClient(credentials, { credentialId: params.credentialId });
    const resolved = await github.resolveOrCreateRepo({
      owner: params.destination.owner,
      name: params.destination.name,
      private: params.creation.private,
      description: params.creation.description,
    });
    return {
      destination: {
        provider: "github",
        owner: resolved.owner,
        name: resolved.name,
      },
      cloneUrl: resolved.cloneUrl,
      webUrl: resolved.webUrl,
      created: resolved.created,
    };
  },
  webUrls(remoteUrl) {
    const parsed = parseGitHubHttpsRemote(remoteUrl);
    if (!parsed) {
      return null;
    }

    const owner = encodeURIComponent(parsed.owner);
    const repo = encodeURIComponent(parsed.repo);
    const webUrl = `https://github.com/${owner}/${repo}`;
    return {
      webUrl,
      ownerUrl: `https://github.com/${owner}`,
      issuesUrl: `${webUrl}/issues`,
      pullRequestsUrl: `${webUrl}/pulls`,
      actionsUrl: `${webUrl}/actions`,
    };
  },
};

registerRemoteProvider(githubRemoteProvider);

function parseGitHubHttpsRemote(remoteUrl: string): ParsedGitHubRemote | null {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  const owner = safeDecodeURIComponent(segments[0]!);
  const repo = stripGitSuffix(safeDecodeURIComponent(segments[1]!));
  if (!owner || !repo) {
    return null;
  }

  return { owner, repo };
}

function stripGitSuffix(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
