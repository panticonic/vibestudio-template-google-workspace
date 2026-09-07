import { bindingAudience, githubCredential } from "./providers.js";
import type {
  CredentialClient,
  StoredCredentialSummary,
  UrlCredentialHandle,
} from "@vibestudio/credential-client";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_ORIGIN = GITHUB_API_BASE;
const GITHUB_ACCEPT_HEADER = "application/vnd.github+json";

export const manifest = {
  scopes: {
    github: ["repo", "read_user"],
  },
  endpoints: {
    github: [
      { url: "https://api.github.com/user", methods: ["GET"] },
      { url: "https://api.github.com/user/repos", methods: ["GET", "POST"] },
      { url: "https://api.github.com/orgs/*/repos", methods: ["POST"] },
      { url: "https://api.github.com/repos/*", methods: ["GET"] },
      { url: "https://api.github.com/repos/*/issues", methods: ["GET", "POST"] },
      { url: "https://api.github.com/repos/*/issues/*", methods: ["GET", "PATCH"] },
      { url: "https://api.github.com/repos/*/pulls", methods: ["GET"] },
      { url: "https://api.github.com/repos/*/pulls/*", methods: ["GET"] },
    ],
  },
  webhooks: {
    github: [
      { event: "issues", deliver: "onIssue" },
      { event: "pull_request", deliver: "onPullRequest" },
    ],
  },
} as const;

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
  html_url: string;
  type: string;
  name?: string | null;
  email?: string | null;
  [key: string]: unknown;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  owner: GitHubUser;
  html_url: string;
  clone_url?: string;
  description?: string | null;
  default_branch?: string;
  [key: string]: unknown;
}

export interface GitHubLabel {
  id: number;
  name: string;
  color: string;
  description?: string | null;
  [key: string]: unknown;
}

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
  body?: string | null;
  user?: GitHubUser;
  assignees?: GitHubUser[];
  labels?: Array<GitHubLabel | string>;
  repository_url?: string;
  /** Present on issue payloads that are actually pull requests. */
  pull_request?: unknown;
  [key: string]: unknown;
}

export interface GitHubPullRequest {
  id: number;
  number: number;
  state: string;
  html_url: string;
  title: string;
  body?: string | null;
  user?: GitHubUser;
  [key: string]: unknown;
}

export interface ListReposOptions {
  visibility?: "all" | "public" | "private";
  affiliation?: string;
  type?: "all" | "owner" | "member";
  sort?: "created" | "updated" | "pushed" | "full_name";
  direction?: "asc" | "desc";
  per_page?: number;
  page?: number;
}

export interface ListIssuesOptions {
  milestone?: string;
  state?: "open" | "closed" | "all";
  assignee?: string;
  creator?: string;
  mentioned?: string;
  labels?: string | string[];
  sort?: "created" | "updated" | "comments";
  direction?: "asc" | "desc";
  since?: string;
  per_page?: number;
  page?: number;
}

export interface CreateIssueParams {
  title: string;
  body?: string;
  assignees?: string[];
  milestone?: number;
  labels?: string[];
}

export interface CreateRepoParams {
  name: string;
  organization?: string;
  private: boolean;
  description?: string;
}

export interface CreateRepoResult {
  cloneUrl: string;
  webUrl: string;
  owner: string;
}

export interface ResolveOrCreateRepoParams {
  owner: string;
  name: string;
  private: boolean;
  description?: string;
}

export interface ResolveOrCreateRepoResult extends CreateRepoResult {
  name: string;
  created: boolean;
}

export type GitHubPublishOwnerSource = "explicit" | "credential-target" | "authenticated-user";

export interface GitHubPublishOperationResolution {
  credentialId: string;
  credentialLabel: string;
  login: string;
  destinationOwner: string;
  ownerSource: GitHubPublishOwnerSource;
  targetName?: string;
  organization?: string;
  requiredCapabilities: readonly ["github-api", "github-repository-create", "github-git-push"];
}

function isClassicGitHubCredential(credential: StoredCredentialSummary): boolean {
  return credential.metadata?.["providerKind"] === "classic-pat";
}

function targetNameForCredential(credential: StoredCredentialSummary): string | undefined {
  const targetName = credential.metadata?.["targetName"]?.trim();
  return targetName || undefined;
}

function isGitHubStoredCredential(credential: StoredCredentialSummary): boolean {
  if (credential.metadata?.["providerId"] === "github") return true;
  return credential.audience.some((audience) => {
    try {
      return new URL(audience.url).origin === GITHUB_API_ORIGIN;
    } catch {
      return false;
    }
  });
}

export function validateGitHubPublishCredential(credential: StoredCredentialSummary): void {
  if (credential.lifecycle.state !== "active") {
    throw new Error(
      `GitHub publish preflight failed for credential "${credential.label}": ` +
        `the credential is ${credential.lifecycle.state}. Reconnect GitHub and retry.`
    );
  }
  const bindingIds = new Set((credential.bindings ?? []).map((binding) => binding.id));
  const missingBindings = ["github-user", "github-git-http"].filter(
    (bindingId) => credential.bindings && !bindingIds.has(bindingId)
  );
  if (missingBindings.length) {
    throw new Error(
      `GitHub publish preflight failed for credential "${credential.label}": ` +
        `it is missing ${missingBindings.join(" and ")} access. Reconnect with "Publish repositories" access.`
    );
  }
  if (!isClassicGitHubCredential(credential)) {
    const scopes = new Set(credential.scopes);
    const missingScopes = ["contents:write", "administration:write"].filter(
      (scope) => !scopes.has(scope)
    );
    if (missingScopes.length) {
      throw new Error(
        `GitHub publish preflight failed for credential "${credential.label}": ` +
          `missing ${missingScopes.join(" and ")} permission${missingScopes.length === 1 ? "" : "s"}. ` +
          `Reconnect with "Publish repositories" access.`
      );
    }
  }
}

export async function resolveGitHubPublishOperation(
  credentials: CredentialClient,
  opts: { credentialId?: string; organization?: string; owner?: string } = {}
): Promise<GitHubPublishOperationResolution> {
  if (opts.organization && opts.owner) {
    throw new Error("Choose one explicit GitHub owner field");
  }
  const requestedOwner = opts.owner?.trim() || opts.organization?.trim() || undefined;
  const candidates = (await credentials.listStoredCredentials()).filter(isGitHubStoredCredential);
  const activeCandidates = candidates.filter((candidate) => candidate.lifecycle.state === "active");
  const credential = opts.credentialId
    ? candidates.find((candidate) => candidate.id === opts.credentialId)
    : activeCandidates.length === 1
      ? activeCandidates[0]
      : undefined;
  if (!credential) {
    const available = activeCandidates
      .map((candidate) => `${candidate.label} (${candidate.id})`)
      .join(", ");
    throw new Error(
      opts.credentialId
        ? `GitHub credential "${opts.credentialId}" was not found. ` +
            "Reconnect GitHub or choose one of the connected GitHub credentials."
        : activeCandidates.length > 1
          ? `Multiple active GitHub credentials are available (${available}). ` +
            "Pass credentialId explicitly; Vibestudio will not guess."
          : "No active GitHub credential is available. Connect GitHub with Publish repositories access."
    );
  }
  validateGitHubPublishCredential(credential);
  const targetName = targetNameForCredential(credential);
  if (requestedOwner && targetName && requestedOwner !== targetName) {
    throw new Error(
      `GitHub owner "${requestedOwner}" does not match the connected token owner ` +
        `"${targetName}" for credential "${credential.label}". ` +
        "Use the matching owner or reconnect with a token targeted to it."
    );
  }
  const github = createGitHubClient(credentials, { credentialId: credential.id });
  let user: GitHubUser;
  try {
    user = await github.getUser();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `GitHub credential "${credential.label}" failed live verification: ${message}. ` +
        "Reconnect GitHub or choose a different credential.",
      { cause: error }
    );
  }
  if (!user.login?.trim()) {
    throw new Error(
      `GitHub credential "${credential.label}" passed the API check but returned no account login. ` +
        "Reconnect GitHub and retry."
    );
  }
  const ownerSource: GitHubPublishOwnerSource = requestedOwner
    ? "explicit"
    : targetName
      ? "credential-target"
      : "authenticated-user";
  const destinationOwner = requestedOwner ?? targetName ?? user.login;
  return {
    credentialId: credential.id,
    credentialLabel: credential.label,
    login: user.login,
    destinationOwner,
    ownerSource,
    ...(targetName ? { targetName } : {}),
    ...(destinationOwner.toLowerCase() !== user.login.toLowerCase()
      ? { organization: destinationOwner }
      : {}),
    requiredCapabilities: ["github-api", "github-repository-create", "github-git-push"],
  };
}

interface GitHubCreatedRepo extends GitHubRepo {
  clone_url: string;
  html_url: string;
  owner: GitHubUser;
}

export interface GitHubIssueWebhookEvent {
  action?: string;
  issue?: GitHubIssue;
  repository?: GitHubRepo;
  sender?: GitHubUser;
  [key: string]: unknown;
}

export interface GitHubPullRequestWebhookEvent {
  action?: string;
  number?: number;
  pull_request?: GitHubPullRequest;
  repository?: GitHubRepo;
  sender?: GitHubUser;
  [key: string]: unknown;
}

function toQueryParams(params?: object): string {
  if (!params) {
    return "";
  }

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (typeof value === "undefined" || value === null) {
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number") {
      continue;
    }
    search.set(key, String(value));
  }

  const query = search.toString();
  return query ? `?${query}` : "";
}

/**
 * Per-context GitHub API client. Build one with `createGitHubClient`
 * (see below) from a `CredentialClient` — the constructor resolves
 * URL-bound credentials lazily, then methods call the handles'
 * `fetch` directly. No per-method `auth` parameter.
 */
export interface UpdateIssueParams {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  labels?: string[];
  assignees?: string[];
}

export interface GitHubClient {
  /** The underlying URL-credential handle (exposed for `credentialId` access in push correlation). */
  handle(): Promise<UrlCredentialHandle>;
  getUser(): Promise<GitHubUser>;
  listRepos(opts?: ListReposOptions): Promise<GitHubRepo[]>;
  createRepo(params: CreateRepoParams): Promise<CreateRepoResult>;
  resolveOrCreateRepo(params: ResolveOrCreateRepoParams): Promise<ResolveOrCreateRepoResult>;
  getRepo(owner: string, repo: string): Promise<GitHubRepo>;
  listIssues(owner: string, repo: string, opts?: ListIssuesOptions): Promise<GitHubIssue[]>;
  createIssue(owner: string, repo: string, params: CreateIssueParams): Promise<GitHubIssue>;
  getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue>;
  updateIssue(
    owner: string,
    repo: string,
    number: number,
    params: UpdateIssueParams
  ): Promise<GitHubIssue>;
}

class GitHubApiError extends Error {
  readonly detail: string;

  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly responseBody: string
  ) {
    const detail = githubApiErrorDetail(responseBody);
    super(`GitHub API request failed: ${status} ${statusText}${detail ? ` - ${detail}` : ""}`);
    this.name = "GitHubApiError";
    this.detail = detail;
  }
}

function githubApiErrorDetail(responseBody: string): string {
  if (!responseBody.trim()) return "";
  try {
    const payload = JSON.parse(responseBody) as {
      message?: unknown;
      documentation_url?: unknown;
    };
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    const documentationUrl =
      typeof payload.documentation_url === "string" ? payload.documentation_url.trim() : "";
    return [message, documentationUrl].filter(Boolean).join(" — ");
  } catch {
    return responseBody.trim();
  }
}

/**
 * Build a GitHub client bound to the given `CredentialClient`. The
 * credential handles are resolved on first use and memoized — methods
 * don't repeat audience lookup. The harness never sees the
 * underlying token; auth is injected by the credentialed fetcher.
 */
export function createGitHubClient(
  credentials: CredentialClient,
  opts: { credentialId?: string } = {}
): GitHubClient {
  const memoizeHandle = (
    resolveDescriptor: () => Parameters<CredentialClient["forAudience"]>[0]
  ) => {
    let handlePromise: Promise<UrlCredentialHandle> | null = null;
    return (): Promise<UrlCredentialHandle> => {
      if (!handlePromise) {
        const p = credentials.forAudience(resolveDescriptor());
        // Cache resolved success; clear the cache on rejection so a
        // later call can retry after the user (e.g.) registers a
        // credential mid-session.
        p.catch(() => {
          if (handlePromise === p) handlePromise = null;
        });
        handlePromise = p;
      }
      return handlePromise;
    };
  };
  const handle = memoizeHandle(() => ({
    ...githubCredential,
    label: githubCredential.displayName,
    ...(opts.credentialId ? { credentialId: opts.credentialId } : {}),
  }));
  const userHandle = memoizeHandle(() => bindingAudience(githubCredential, "github-user", opts));

  const apiFetch = async <T>(
    path: string,
    init?: RequestInit,
    credentialHandle: () => Promise<UrlCredentialHandle> = handle
  ): Promise<T> => {
    const auth = await credentialHandle();
    const headers = new Headers(init?.headers);
    headers.set("Accept", GITHUB_ACCEPT_HEADER);
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const response = await auth.fetch(`${GITHUB_API_BASE}${path}`, { ...init, headers });
    if (!response.ok) {
      const bodyText = await response.text();
      throw new GitHubApiError(response.status, response.statusText, bodyText);
    }
    return (await response.json()) as T;
  };

  const enc = encodeURIComponent;
  const resolvedRepository = (
    repo: GitHubRepo,
    expected: { owner: string; name: string },
    created: boolean
  ): ResolveOrCreateRepoResult => {
    const owner = repo.owner.login?.trim();
    const name = repo.name?.trim();
    if (
      !owner ||
      !name ||
      owner.toLowerCase() !== expected.owner.toLowerCase() ||
      name.toLowerCase() !== expected.name.toLowerCase()
    ) {
      throw new Error(
        `GitHub resolved ${repo.full_name || "<unknown repository>"} while ` +
          `${expected.owner}/${expected.name} was requested`
      );
    }
    if (!repo.clone_url || !repo.html_url) {
      throw new Error(`GitHub repository ${owner}/${name} has no canonical HTTPS URLs`);
    }
    return {
      cloneUrl: repo.clone_url,
      webUrl: repo.html_url,
      owner,
      name,
      created,
    };
  };

  return {
    handle,
    getUser: () => apiFetch<GitHubUser>("/user", undefined, userHandle),
    listRepos: (opts) =>
      apiFetch<GitHubRepo[]>(`/user/repos${toQueryParams(opts)}`, undefined, userHandle),
    getRepo: (owner, repo) => apiFetch<GitHubRepo>(`/repos/${enc(owner)}/${enc(repo)}`),
    listIssues: (owner, repo, opts) => {
      const labels = Array.isArray(opts?.labels) ? opts.labels.join(",") : opts?.labels;
      return apiFetch<GitHubIssue[]>(
        `/repos/${enc(owner)}/${enc(repo)}/issues${toQueryParams({ ...opts, labels })}`
      );
    },
    createIssue: (owner, repo, params) =>
      apiFetch<GitHubIssue>(`/repos/${enc(owner)}/${enc(repo)}/issues`, {
        method: "POST",
        body: JSON.stringify(params),
      }),
    createRepo: async (params) => {
      let repo: GitHubCreatedRepo;
      const { organization, ...repositoryParams } = params;
      const endpoint = organization ? `/orgs/${enc(organization)}/repos` : "/user/repos";
      try {
        repo = await apiFetch<GitHubCreatedRepo>(
          endpoint,
          {
            method: "POST",
            body: JSON.stringify(repositoryParams),
          },
          userHandle
        );
      } catch (error) {
        if (error instanceof GitHubApiError) {
          throw new Error(
            `GitHub repository creation failed (${error.status} ${error.statusText})` +
              `${error.detail ? `: ${error.detail}` : "."} ` +
              "Review the connected credential and any GitHub account or organization restrictions, then retry.",
            { cause: error }
          );
        }
        throw error;
      }
      return {
        cloneUrl: repo.clone_url,
        webUrl: repo.html_url,
        owner: repo.owner.login,
      };
    },
    resolveOrCreateRepo: async (params) => {
      const owner = params.owner.trim();
      const name = params.name.trim();
      if (!owner || !name || owner.includes("/") || name.includes("/")) {
        throw new Error("GitHub repository owner and name must be single non-empty path segments");
      }
      try {
        const existing = await apiFetch<GitHubRepo>(`/repos/${enc(owner)}/${enc(name)}`);
        return resolvedRepository(existing, { owner, name }, false);
      } catch (error) {
        if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
      }

      const user = await apiFetch<GitHubUser>("/user", undefined, userHandle);
      const endpoint =
        user.login.toLowerCase() === owner.toLowerCase()
          ? "/user/repos"
          : `/orgs/${enc(owner)}/repos`;
      let created: GitHubRepo;
      try {
        created = await apiFetch<GitHubCreatedRepo>(
          endpoint,
          {
            method: "POST",
            body: JSON.stringify({
              name,
              private: params.private,
              ...(params.description === undefined ? {} : { description: params.description }),
            }),
          },
          userHandle
        );
      } catch (error) {
        // A concurrent publisher may win the create race. Resolve the identity
        // again; every other creation failure remains visible.
        if (error instanceof GitHubApiError && error.status === 422) {
          try {
            const existing = await apiFetch<GitHubRepo>(`/repos/${enc(owner)}/${enc(name)}`);
            return resolvedRepository(existing, { owner, name }, false);
          } catch {
            // Preserve the original create failure below.
          }
        }
        if (error instanceof GitHubApiError) {
          throw new Error(
            `GitHub repository creation failed (${error.status} ${error.statusText})` +
              `${error.detail ? `: ${error.detail}` : "."} ` +
              "Review the connected credential and any GitHub account or organization restrictions, then retry.",
            { cause: error }
          );
        }
        throw error;
      }
      return resolvedRepository(created, { owner, name }, true);
    },
    getIssue: (owner, repo, number) =>
      apiFetch<GitHubIssue>(`/repos/${enc(owner)}/${enc(repo)}/issues/${number}`),
    updateIssue: (owner, repo, number, params) =>
      apiFetch<GitHubIssue>(`/repos/${enc(owner)}/${enc(repo)}/issues/${number}`, {
        method: "PATCH",
        body: JSON.stringify(params),
      }),
  };
}

export function onIssue(event: GitHubIssueWebhookEvent) {
  return {
    type: "issues" as const,
    action: event.action ?? null,
    issue: event.issue ?? null,
    repository: event.repository ?? null,
    sender: event.sender ?? null,
    raw: event,
  };
}

export function onPullRequest(event: GitHubPullRequestWebhookEvent) {
  return {
    type: "pull_request" as const,
    action: event.action ?? null,
    number: event.number ?? event.pull_request?.number ?? null,
    pullRequest: event.pull_request ?? null,
    repository: event.repository ?? null,
    sender: event.sender ?? null,
    raw: event,
  };
}
