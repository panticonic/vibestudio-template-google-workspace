import type { RpcCaller } from "@vibestudio/rpc";
import {
  createCredentialClient,
  type StoredCredentialSummary,
} from "@workspace/runtime/credentials";
import { createGitHubClient, resolveGitHubPublishOperation } from "./github.js";

/**
 * Build a mock RPC caller that:
 *   - Resolves any audience to a single stub credential (so
 *     `forAudience` succeeds the first time it's called).
 *   - Routes proxyFetch through a recorded fetcher that returns
 *     whatever `respond(url, init)` decides.
 *
 * Also tracks how many times each method is called so we can assert
 * the per-context memoization of the credential handle.
 */
function makeMockEnv(
  respond: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string }
  ) => Response
) {
  const stats = {
    resolveCalls: 0,
    resolveDescriptors: [] as unknown[],
    fetchCalls: [] as Array<{ url: string; method: string; body?: string }>,
  };
  const credential: StoredCredentialSummary = {
    id: "cred-mock",
    label: "Mock",
    providerId: "mock",
    accountIdentity: { providerUserId: "mock" },
    audience: [],
    injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
    bindings: [
      { id: "github-user", use: "fetch", audience: [], injection: credentialInjection() },
      { id: "github-git-http", use: "git-http", audience: [], injection: credentialInjection() },
    ],
    scopes: ["metadata:read", "contents:write", "administration:write"],
    lifecycle: { state: "active", canRefresh: false },
    metadata: {
      providerId: "github",
      providerKind: "fine-grained-pat",
      targetName: "acme",
    },
    createdAt: Date.now(),
  } as unknown as StoredCredentialSummary;

  const rpc: RpcCaller = {
    call: (async <T = unknown>(_targetId: string, method: string, args: unknown[]): Promise<T> => {
      if (method === "credentials.resolveCredential") {
        stats.resolveCalls++;
        stats.resolveDescriptors.push(args[0]);
        return credential as unknown as T;
      }
      if (method === "credentials.listStoredCredentials") {
        return [credential] as unknown as T;
      }
      throw new Error(`unexpected method: ${method}`);
    }) as RpcCaller["call"],
    stream: async (_target: string, method: string, args: unknown[]) => {
      if (method !== "credentials.proxyFetch") {
        throw new Error(`unexpected stream method: ${method}`);
      }
      const params = args[0] as {
        url: string;
        method: string;
        headers?: Record<string, string>;
        body?: string;
      };
      stats.fetchCalls.push({
        url: params.url,
        method: params.method,
        ...(params.body !== undefined ? { body: params.body } : {}),
      });
      return respond(params.url, params);
    },
  };
  const credentials = createCredentialClient(rpc);
  return { credentials, stats };
}

function credentialInjection() {
  return { type: "header", name: "authorization", valueTemplate: "Bearer {token}" } as const;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("createGitHubClient", () => {
  it("preflights and resolves the credential owner for publishing", async () => {
    const { credentials } = makeMockEnv((url) => {
      if (url.endsWith("/user")) return jsonResponse({ login: "octocat", id: 1 });
      return jsonResponse({}, { status: 404 });
    });

    await expect(resolveGitHubPublishOperation(credentials)).resolves.toMatchObject({
      credentialId: "cred-mock",
      credentialLabel: "Mock",
      login: "octocat",
      targetName: "acme",
      destinationOwner: "acme",
      ownerSource: "credential-target",
      organization: "acme",
    });
  });

  it("memoizes the credential handle across method calls", async () => {
    const { credentials, stats } = makeMockEnv((url) => {
      if (url.endsWith("/user")) return jsonResponse({ login: "octocat", id: 1 });
      if (url.endsWith("/user/repos"))
        return jsonResponse([{ id: 1, name: "spoon-knife", full_name: "octocat/spoon-knife" }]);
      return jsonResponse({}, { status: 404 });
    });
    const github = createGitHubClient(credentials);

    const user = await github.getUser();
    const repos = await github.listRepos();

    expect(user.login).toBe("octocat");
    expect(repos).toHaveLength(1);
    // Credential resolution happened exactly once even though two
    // methods were called — that's the memoization promise.
    expect(stats.resolveCalls).toBe(1);
  });

  it("constructs the right paths for issue methods", async () => {
    const { credentials, stats } = makeMockEnv(() =>
      jsonResponse({ number: 7, title: "test", state: "open", html_url: "x", id: 1 })
    );
    const github = createGitHubClient(credentials);

    await github.getIssue("owner", "repo", 7);
    await github.updateIssue("owner", "repo", 7, { state: "closed" });
    await github.createIssue("owner", "repo", { title: "new" });

    const paths = stats.fetchCalls.map((c) => c.url);
    expect(paths).toEqual([
      "https://api.github.com/repos/owner/repo/issues/7",
      "https://api.github.com/repos/owner/repo/issues/7",
      "https://api.github.com/repos/owner/repo/issues",
    ]);
    expect(stats.fetchCalls.map((c) => c.method)).toEqual(["GET", "PATCH", "POST"]);
  });

  it("creates repositories through the GitHub user repos API", async () => {
    const { credentials, stats } = makeMockEnv(() =>
      jsonResponse({
        id: 1,
        name: "demo",
        full_name: "octocat/demo",
        private: true,
        html_url: "https://github.com/octocat/demo",
        clone_url: "https://github.com/octocat/demo.git",
        owner: { id: 1, login: "octocat", avatar_url: "", html_url: "", type: "User" },
      })
    );
    const github = createGitHubClient(credentials);

    const repo = await github.createRepo({
      name: "demo",
      private: true,
      description: "Demo repo",
    });

    expect(repo).toEqual({
      cloneUrl: "https://github.com/octocat/demo.git",
      webUrl: "https://github.com/octocat/demo",
      owner: "octocat",
    });
    expect(stats.fetchCalls).toEqual([
      {
        url: "https://api.github.com/user/repos",
        method: "POST",
        body: JSON.stringify({ name: "demo", private: true, description: "Demo repo" }),
      },
    ]);
  });

  it("creates repositories through the GitHub organization repos API", async () => {
    const { credentials, stats } = makeMockEnv(() =>
      jsonResponse({
        id: 2,
        name: "demo",
        full_name: "acme/demo",
        private: true,
        html_url: "https://github.com/acme/demo",
        clone_url: "https://github.com/acme/demo.git",
        owner: { id: 2, login: "acme", avatar_url: "", html_url: "", type: "Organization" },
      })
    );
    const github = createGitHubClient(credentials);

    await github.createRepo({
      name: "demo",
      organization: "acme",
      private: true,
    });

    expect(stats.fetchCalls).toEqual([
      {
        url: "https://api.github.com/orgs/acme/repos",
        method: "POST",
        body: JSON.stringify({ name: "demo", private: true }),
      },
    ]);
  });

  it("resolves an existing repository without attempting creation", async () => {
    const { credentials, stats } = makeMockEnv((url) => {
      if (url.endsWith("/repos/acme/demo")) {
        return jsonResponse({
          id: 2,
          name: "demo",
          full_name: "acme/demo",
          private: true,
          html_url: "https://github.com/acme/demo",
          clone_url: "https://github.com/acme/demo.git",
          owner: { id: 2, login: "acme", type: "Organization" },
        });
      }
      return jsonResponse({}, { status: 404 });
    });

    await expect(
      createGitHubClient(credentials).resolveOrCreateRepo({
        owner: "acme",
        name: "demo",
        private: true,
      })
    ).resolves.toEqual({
      cloneUrl: "https://github.com/acme/demo.git",
      webUrl: "https://github.com/acme/demo",
      owner: "acme",
      name: "demo",
      created: false,
    });
    expect(stats.fetchCalls.map(({ method }) => method)).toEqual(["GET"]);
  });

  it("creates an absent repository under the explicit owner", async () => {
    const { credentials, stats } = makeMockEnv((url, init) => {
      if (url.endsWith("/repos/acme/demo")) return jsonResponse({}, { status: 404 });
      if (url.endsWith("/user")) return jsonResponse({ login: "acme", id: 1 });
      if (url.endsWith("/user/repos") && init?.method === "POST") {
        return jsonResponse({
          id: 3,
          name: "demo",
          full_name: "acme/demo",
          private: false,
          html_url: "https://github.com/acme/demo",
          clone_url: "https://github.com/acme/demo.git",
          owner: { id: 1, login: "acme", type: "User" },
        });
      }
      return jsonResponse({}, { status: 404 });
    });

    await expect(
      createGitHubClient(credentials).resolveOrCreateRepo({
        owner: "acme",
        name: "demo",
        private: false,
        description: "Demo",
      })
    ).resolves.toMatchObject({ owner: "acme", name: "demo", created: true });
    expect(stats.fetchCalls).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo",
        method: "GET",
      },
      {
        url: "https://api.github.com/user",
        method: "GET",
      },
      {
        url: "https://api.github.com/user/repos",
        method: "POST",
        body: JSON.stringify({ name: "demo", private: false, description: "Demo" }),
      },
    ]);
  });

  it("resolves the winner of a concurrent repository-creation race", async () => {
    let reads = 0;
    const { credentials } = makeMockEnv((url, init) => {
      if (url.endsWith("/repos/acme/demo")) {
        reads += 1;
        if (reads === 1) return jsonResponse({}, { status: 404 });
        return jsonResponse({
          id: 4,
          name: "demo",
          full_name: "acme/demo",
          private: true,
          html_url: "https://github.com/acme/demo",
          clone_url: "https://github.com/acme/demo.git",
          owner: { id: 1, login: "acme", type: "User" },
        });
      }
      if (url.endsWith("/user")) return jsonResponse({ login: "acme", id: 1 });
      if (url.endsWith("/user/repos") && init?.method === "POST") {
        return jsonResponse(
          { message: "already exists" },
          { status: 422, statusText: "Unprocessable Content" }
        );
      }
      return jsonResponse({}, { status: 404 });
    });

    await expect(
      createGitHubClient(credentials).resolveOrCreateRepo({
        owner: "acme",
        name: "demo",
        private: true,
      })
    ).resolves.toMatchObject({ created: false, owner: "acme", name: "demo" });
  });

  it("routes repository creation through the explicitly selected credential", async () => {
    const { credentials, stats } = makeMockEnv(() =>
      jsonResponse({
        id: 3,
        name: "demo",
        full_name: "acme/demo",
        private: true,
        html_url: "https://github.com/acme/demo",
        clone_url: "https://github.com/acme/demo.git",
        owner: { id: 3, login: "acme", avatar_url: "", html_url: "", type: "Organization" },
      })
    );
    const github = createGitHubClient(credentials, { credentialId: "github-org-token" });

    await github.createRepo({ name: "demo", organization: "acme", private: true });

    expect(stats.resolveDescriptors).toEqual([
      expect.objectContaining({ credentialId: "github-org-token" }),
    ]);
  });

  it("adds repository-creation context without guessing the cause of a GitHub rejection", async () => {
    const { credentials } = makeMockEnv(
      () =>
        new Response(
          JSON.stringify({
            message: "Resource not accessible by personal access token",
            documentation_url:
              "https://docs.github.com/rest/repos/repos#create-a-repository-for-the-authenticated-user",
          }),
          {
            status: 403,
            statusText: "Forbidden",
          }
        )
    );
    const github = createGitHubClient(credentials);

    await expect(github.createRepo({ name: "demo", private: true })).rejects.toThrow(
      /GitHub repository creation failed \(403 Forbidden\): Resource not accessible by personal access token.*Review the connected credential and any GitHub account or organization restrictions/iu
    );
  });

  it("adds repository-creation context to non-permission API failures too", async () => {
    const { credentials } = makeMockEnv(
      () =>
        new Response('{"message":"Repository creation failed: name already exists"}', {
          status: 422,
          statusText: "Unprocessable Content",
        })
    );
    const github = createGitHubClient(credentials);

    await expect(github.createRepo({ name: "demo", private: true })).rejects.toThrow(
      /GitHub repository creation failed \(422 Unprocessable Content\): Repository creation failed: name already exists/iu
    );
  });

  it("throws a typed error on non-2xx responses", async () => {
    const { credentials } = makeMockEnv(
      () => new Response("forbidden", { status: 403, statusText: "Forbidden" })
    );
    const github = createGitHubClient(credentials);

    await expect(github.getUser()).rejects.toThrow(/GitHub API request failed: 403 Forbidden/);
  });
});

describe("factory client retry semantics", () => {
  it("retries credential resolution after a failed first call", async () => {
    // Mid-session credential registration: first call fails (no
    // credential), user registers one, next call should succeed.
    let credentialRegistered = false;
    const credential: StoredCredentialSummary = {
      id: "later",
      label: "Later",
      providerId: "test",
      accountIdentity: { providerUserId: "x" },
      audience: [],
      injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
      bindings: [],
      scopes: [],
      metadata: {},
      createdAt: Date.now(),
    } as unknown as StoredCredentialSummary;

    const rpc: RpcCaller = {
      call: (async <T = unknown>(_t: string, method: string): Promise<T> => {
        if (method === "credentials.resolveCredential") {
          return (credentialRegistered ? credential : null) as unknown as T;
        }
        throw new Error(`unexpected method: ${method}`);
      }) as RpcCaller["call"],
      stream: async () => jsonResponse({ login: "u", id: 1 }),
    };
    const github = createGitHubClient(createCredentialClient(rpc));

    // First call rejects.
    await expect(github.getUser()).rejects.toThrow(/No URL-bound credential found/);

    // Register credential mid-session.
    credentialRegistered = true;

    // Second call must succeed — the factory must NOT cache the
    // rejected promise from the first attempt.
    const user = await github.getUser();
    expect(user.login).toBe("u");
  });
});
