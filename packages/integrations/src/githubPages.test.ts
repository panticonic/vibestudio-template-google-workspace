import { describe, expect, it, vi } from "vitest";
import type { CredentialClient } from "@vibestudio/credential-client";
import { createGitHubClient, GitHubApiError } from "./github.js";

const site = { html_url: "https://owner.github.io/app/", status: "built", public: true,
  build_type: "legacy", source: { branch: "main", path: "/docs" } };
function fixture(responses: Response[]) {
  const fetch = vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected GitHub request");
    return response;
  });
  const forAudience = vi.fn(async () => ({ credentialId: "chosen-account", fetch }));
  const client = createGitHubClient({ forAudience } as unknown as CredentialClient, { credentialId: "chosen-account" });
  return { client, fetch, forAudience };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe("GitHub Pages integration", () => {
  it("binds Pages access to the exact selected repository and account", async () => {
    const f = fixture([json(site), json({ status: "built", commit: "reviewed-commit" })]);
    await f.client.getPages("owner", "app");
    await f.client.getLatestPagesBuild("owner", "app");
    expect(f.forAudience).toHaveBeenCalledOnce();
    expect(f.forAudience).toHaveBeenCalledWith({ credentialId: "chosen-account", label: "GitHub Pages: owner/app",
      audiences: [{ url: "https://api.github.com/repos/owner/app/pages", match: "exact" },
        { url: "https://api.github.com/repos/owner/app/pages/", match: "path-prefix" }] });
    expect(f.fetch.mock.calls.map(call => (call as unknown[])[0])).toEqual([
      "https://api.github.com/repos/owner/app/pages", "https://api.github.com/repos/owner/app/pages/builds/latest",
    ]);
  });

  it("creates /docs publication and reconciles a concurrent successful creation", async () => {
    const f = fixture([json({}, 404), json({}, 409), json(site)]);
    await expect(f.client.ensurePagesSource("owner", "app", { branch: "main", path: "/docs" })).resolves.toEqual(site);
    const request = f.fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(request[1].method).toBe("POST");
    expect(JSON.parse(request[1].body as string)).toEqual({ build_type: "legacy", source: { branch: "main", path: "/docs" } });
  });

  it.each([
    { ...site, build_type: "workflow" },
    { ...site, source: { branch: "published", path: "/" } },
  ])("does not replace an existing publication owner", async existing => {
    const f = fixture([json(existing)]);
    await expect(f.client.ensurePagesSource("owner", "app", { branch: "main", path: "/docs" })).rejects.toThrow(/different Pages publication/);
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("returns a bounded permission repair choice without broadening account access", async () => {
    const f = fixture([json({ message: "Resource not accessible by personal access token" }, 403)]);
    const error = await f.client.getPages("owner", "app").catch(value => value);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error.repair).toEqual({ provider: "github", accessLevel: "publish-pages", owner: "owner", repository: "app" });
    expect(f.forAudience).toHaveBeenCalledOnce();
  });

  it("rejects path injection before resolving any credential", async () => {
    const f = fixture([]);
    await expect(f.client.getPages("owner", "../other")).rejects.toThrow(/exact GitHub owner/);
    expect(f.forAudience).not.toHaveBeenCalled();
  });
});
