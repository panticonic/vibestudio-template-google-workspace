import { describe, expect, it } from "vitest";
import { githubBindings } from "./providers.js";

describe("provider credential catalogs", () => {
  it("scopes GitHub API grants to the requested repository", () => {
    expect(githubBindings.repos).toMatchObject({
      id: "github-repos",
      audience: [{ url: "https://api.github.com/repos/", match: "path-prefix" }],
      grantResource: { type: "url-path-prefix", segmentCount: 3 },
    });
  });

  it("scopes GitHub git HTTP grants to the requested repository", () => {
    expect(githubBindings.gitHttp).toMatchObject({
      id: "github-git-http",
      audience: [{ url: "https://github.com/", match: "origin" }],
      grantResource: { type: "url-path-prefix", segmentCount: 2 },
    });
  });
});
