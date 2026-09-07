import type {
  CredentialBinding,
  CredentialGrantResourceHint,
  CredentialInjection,
  UrlAudience,
} from "@vibestudio/credential-client";

export interface UrlCredentialDescriptor {
  id: string;
  displayName: string;
  credentialId?: string;
  audiences: UrlAudience[];
  bindings: CredentialBinding[];
  upstreamScopes?: string[];
}

export interface BindingAudienceDescriptor {
  audiences: UrlAudience[];
  credentialId?: string;
  label?: string;
}

export const bearerTokenInjection: CredentialInjection = {
  type: "header",
  name: "authorization",
  valueTemplate: "Bearer {token}",
  stripIncoming: ["authorization"],
};

export const githubGitHttpInjection: CredentialInjection = {
  type: "basic-auth",
  usernameTemplate: "x-access-token",
  passwordTemplate: "{token}",
  stripIncoming: ["authorization"],
};

export const GITHUB_FINE_GRAINED_BROAD_PERMISSIONS = {
  metadata: "read",
  contents: "write",
  issues: "write",
  pull_requests: "write",
  actions: "write",
  workflows: "write",
  statuses: "write",
  deployments: "write",
  discussions: "write",
} as const;

export const GITHUB_CLASSIC_BROAD_SCOPES = [
  "repo",
  "workflow",
  "read:user",
  "user:email",
  "gist",
] as const;

const repoResource: CredentialGrantResourceHint = {
  type: "url-path-prefix",
  segmentCount: 3,
};

export const githubBindings = {
  user: {
    id: "github-user",
    label: "GitHub profile and repositories",
    use: "fetch",
    audience: [
      { url: "https://api.github.com/user", match: "path-prefix" },
      { url: "https://api.github.com/user/repos", match: "path-prefix" },
    ],
    injection: bearerTokenInjection,
    grantResource: { type: "url-path-prefix", segmentCount: 1 },
  },
  organizations: {
    id: "github-organizations",
    label: "GitHub organization repositories",
    use: "fetch",
    audience: [{ url: "https://api.github.com/orgs/", match: "path-prefix" }],
    injection: bearerTokenInjection,
    grantResource: { type: "url-path-prefix", segmentCount: 2 },
  },
  repos: {
    id: "github-repos",
    label: "GitHub repositories",
    use: "fetch",
    audience: [{ url: "https://api.github.com/repos/", match: "path-prefix" }],
    injection: bearerTokenInjection,
    grantResource: repoResource,
  },
  uploads: {
    id: "github-uploads",
    label: "GitHub release uploads",
    use: "fetch",
    audience: [{ url: "https://uploads.github.com/repos/", match: "path-prefix" }],
    injection: bearerTokenInjection,
    grantResource: repoResource,
  },
  gitHttp: {
    id: "github-git-http",
    label: "GitHub git over HTTPS",
    use: "git-http",
    audience: [{ url: "https://github.com/", match: "origin" }],
    injection: githubGitHttpInjection,
    grantResource: { type: "url-path-prefix", segmentCount: 2 },
  },
} satisfies Record<string, CredentialBinding>;

export const githubCredential: UrlCredentialDescriptor = {
  id: "github",
  displayName: "GitHub",
  audiences: audiencesFromBindings([
    githubBindings.user,
    githubBindings.organizations,
    githubBindings.repos,
    githubBindings.uploads,
  ]),
  bindings: Object.values(githubBindings),
  upstreamScopes: [...GITHUB_CLASSIC_BROAD_SCOPES],
};

export const providers = {
  githubCredential,
};

export function audiencesFromBindings(bindings: readonly CredentialBinding[]): UrlAudience[] {
  const byKey = new Map<string, UrlAudience>();
  for (const binding of bindings) {
    for (const audience of binding.audience) {
      byKey.set(`${audience.match}\0${audience.url}`, audience);
    }
  }
  return Array.from(byKey.values());
}

export function bindingAudience(
  descriptor: UrlCredentialDescriptor,
  bindingId: string,
  opts: { credentialId?: string } = {}
): BindingAudienceDescriptor {
  const binding = descriptor.bindings.find((candidate) => candidate.id === bindingId);
  if (!binding) {
    throw new Error(`Unknown credential binding ${bindingId} for ${descriptor.id}`);
  }
  return {
    audiences: binding.audience,
    label: binding.label ?? descriptor.displayName,
    ...(opts.credentialId ? { credentialId: opts.credentialId } : {}),
  };
}
