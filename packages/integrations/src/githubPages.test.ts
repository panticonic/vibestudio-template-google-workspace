import { describe, expect, it, vi } from "vitest";
import type { CredentialClient } from "@vibestudio/credential-client";
import { createGitHubClient, GitHubApiError } from "./github.js";

const site = {
  html_url: "https://owner.github.io/app/",
  status: "built",
  public: true,
  build_type: "legacy",
  source: { branch: "main", path: "/docs" },
} as const;
function fixture(responses: Response[]) {
  const fetch = vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected GitHub request");
    return response;
  });
  const forAudience = vi.fn(async () => ({
    credentialId: "chosen-account",
    fetch,
  }));
  const client = createGitHubClient(
    { forAudience } as unknown as CredentialClient,
    { credentialId: "chosen-account" },
  );
  return { client, fetch, forAudience };
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

describe("GitHub Pages integration", () => {
  it("binds Pages access to the exact selected repository and account", async () => {
    const f = fixture([
      json(site),
      json({ status: "built", commit: "reviewed-commit" }),
    ]);
    await f.client.getPages("owner", "app");
    await f.client.getLatestPagesBuild("owner", "app");
    expect(f.forAudience).toHaveBeenCalledOnce();
    expect(f.forAudience).toHaveBeenCalledWith({
      credentialId: "chosen-account",
      label: "GitHub Pages: owner/app",
      audiences: [
        { url: "https://api.github.com/repos/owner/app/pages", match: "exact" },
        {
          url: "https://api.github.com/repos/owner/app/pages/",
          match: "path-prefix",
        },
      ],
    });
    expect(f.fetch.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      "https://api.github.com/repos/owner/app/pages",
      "https://api.github.com/repos/owner/app/pages/builds/latest",
    ]);
  });

  it("creates /docs publication and reconciles a concurrent successful creation", async () => {
    const f = fixture([json({}, 404), json({}, 409), json(site)]);
    await expect(
      f.client.ensurePagesSource("owner", "app", {
        branch: "main",
        path: "/docs",
      }),
    ).resolves.toEqual(site);
    const request = f.fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(request[1].method).toBe("POST");
    expect(JSON.parse(request[1].body as string)).toEqual({
      build_type: "legacy",
      source: { branch: "main", path: "/docs" },
    });
  });

  it.each([
    { ...site, build_type: "workflow" },
    { ...site, source: { branch: "published", path: "/" } },
  ])("does not replace an existing publication owner", async (existing) => {
    const f = fixture([json(existing)]);
    await expect(
      f.client.ensurePagesSource("owner", "app", {
        branch: "main",
        path: "/docs",
      }),
    ).rejects.toThrow(/different Pages publication/);
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("returns a bounded permission repair choice without broadening account access", async () => {
    const f = fixture([
      json(
        { message: "Resource not accessible by personal access token" },
        403,
      ),
    ]);
    const error = await f.client
      .getPages("owner", "app")
      .catch((value) => value);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error.repair).toEqual({
      provider: "github",
      accessLevel: "publish-pages",
      owner: "owner",
      repository: "app",
    });
    expect(f.forAudience).toHaveBeenCalledOnce();
  });

  it("rejects path injection before resolving any credential", async () => {
    const f = fixture([]);
    await expect(f.client.getPages("owner", "../other")).rejects.toThrow(
      /exact GitHub owner/,
    );
    expect(f.forAudience).not.toHaveBeenCalled();
  });
});

it("verifies the exact served build and every reviewed file under the project prefix", async () => {
  const { createHash } = await import("node:crypto");
  const { observeGitHubPagesPublication } = await import("./github.js");
  const hash = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  const files: Record<string, string> = {
    ".nojekyll": "",
    "index.html": "<h1>Reviewed site</h1>",
    "site.js": "console.log('reviewed')",
  };
  const manifest = {
    version: 1,
    sdk: { version: "locked", sha256: "a".repeat(64) },
    source: {},
    files: Object.fromEntries(
      Object.entries(files).map(([file, content]) => [file, hash(content)]),
    ),
  };
  const buildId = hash(JSON.stringify(manifest));
  const commit = "b".repeat(40);
  const github = {
    getPages: vi.fn(async () => site as import("./github.js").GitHubPagesSite),
    getLatestPagesBuild: vi.fn(
      async () =>
        ({ commit, status: "built" }) as import("./github.js").GitHubPagesBuild,
    ),
  };
  const read = vi.fn(async (url: string) => {
    expect(url.startsWith("https://owner.github.io/app/")).toBe(true);
    const name = url.split("/").at(-1)!;
    return name === "vibestudio-build.json"
      ? json({ ...manifest, buildId })
      : new Response(files[name]);
  });
  const input = {
    owner: "owner",
    repository: "app",
    branch: "main",
    commit,
    buildId,
  };
  await expect(
    observeGitHubPagesPublication(github, input, read),
  ).resolves.toMatchObject({ state: "deployed", commit, buildId, files: 3 });
  files["site.js"] = "unreviewed replacement";
  await expect(
    observeGitHubPagesPublication(github, input, read),
  ).resolves.toMatchObject({
    state: "unverified",
    reason: expect.stringContaining("site.js differs"),
  });
  const copiedIdentity = vi.fn(async () =>
    json({ ...manifest, files: { "index.html": hash("other") }, buildId }),
  );
  await expect(
    observeGitHubPagesPublication(github, input, copiedIdentity),
  ).resolves.toMatchObject({
    state: "unverified",
    reason: expect.stringContaining("manifest does not match"),
  });
  expect(copiedIdentity).toHaveBeenCalledOnce();
  github.getLatestPagesBuild.mockResolvedValue({
    commit: "c".repeat(40),
    status: "built",
  } as import("./github.js").GitHubPagesBuild);
  read.mockClear();
  await expect(
    observeGitHubPagesPublication(github, input, read),
  ).resolves.toMatchObject({
    state: "building",
    observedCommit: "c".repeat(40),
  });
  expect(read).not.toHaveBeenCalled();
});

describe("reviewed Pages configuration workflow", () => {
  it("validates the publication before allowing configuration", async () => {
    const { configureGitHubPagesPublication } = await import("./github.js");
    const github = {
      ensurePagesSource: vi.fn(),
      getPages: vi.fn(),
      getLatestPagesBuild: vi.fn(),
    };
    await expect(
      configureGitHubPagesPublication(
        github,
        {
          owner: "owner",
          repository: "app",
          branch: "main",
          commit: "unreviewed",
          buildId: "b".repeat(64),
        },
        vi.fn(),
      ),
    ).rejects.toThrow("exact reviewed commit");
    expect(github.ensurePagesSource).not.toHaveBeenCalled();
  });

  it("configures /docs and reports pending publication without claiming deployment", async () => {
    const { configureGitHubPagesPublication } = await import("./github.js");
    const publication = {
      owner: "owner",
      repository: "app",
      branch: "main",
      commit: "a".repeat(40),
      buildId: "b".repeat(64),
    };
    const github = {
      ensurePagesSource: vi.fn(async () => site),
      getPages: vi.fn(async () => site),
      getLatestPagesBuild: vi.fn(async () => null),
    };
    const readPublic = vi.fn();
    await expect(
      configureGitHubPagesPublication(github, publication, readPublic),
    ).resolves.toMatchObject({ state: "building" });
    expect(github.ensurePagesSource).toHaveBeenCalledWith("owner", "app", {
      branch: "main",
      path: "/docs",
    });
    expect(readPublic).not.toHaveBeenCalled();
  });
});
