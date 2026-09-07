import { describe, expect, it } from "vitest";
import {
  getRemoteProvider,
  githubRemoteProvider,
  registerRemoteProvider,
  type RemoteProvider,
} from "./remoteProviders.js";

describe("remote provider registry", () => {
  it("resolves providers by id and matcher", () => {
    const provider: RemoteProvider = {
      id: "example",
      displayName: "Example",
      matches: (idOrUrl) => idOrUrl.startsWith("https://git.example.com/"),
      createRepo: async () => ({
        cloneUrl: "https://git.example.com/acme/demo.git",
        webUrl: "https://git.example.com/acme/demo",
        owner: "acme",
      }),
      resolveOrCreateRepo: async (_credentials, params) => ({
        destination: params.destination,
        cloneUrl: "https://git.example.com/acme/demo.git",
        webUrl: "https://git.example.com/acme/demo",
        created: false,
      }),
      webUrls: () => ({
        webUrl: "https://git.example.com/acme/demo",
        ownerUrl: "https://git.example.com/acme",
        issuesUrl: "https://git.example.com/acme/demo/issues",
        pullRequestsUrl: "https://git.example.com/acme/demo/pulls",
        actionsUrl: "https://git.example.com/acme/demo/actions",
      }),
    };

    registerRemoteProvider(provider);

    expect(getRemoteProvider("example")).toBe(provider);
    expect(getRemoteProvider("https://git.example.com/acme/demo.git")).toBe(provider);
  });

  it("matches GitHub HTTPS remotes and builds web URLs", () => {
    expect(getRemoteProvider("github")).toBe(githubRemoteProvider);
    expect(getRemoteProvider("https://github.com/octocat/spoon-knife.git")).toBe(
      githubRemoteProvider
    );
    expect(getRemoteProvider("git@github.com:octocat/spoon-knife.git")).toBeUndefined();

    expect(githubRemoteProvider.webUrls("https://github.com/octocat/spoon-knife.git")).toEqual({
      webUrl: "https://github.com/octocat/spoon-knife",
      ownerUrl: "https://github.com/octocat",
      issuesUrl: "https://github.com/octocat/spoon-knife/issues",
      pullRequestsUrl: "https://github.com/octocat/spoon-knife/pulls",
      actionsUrl: "https://github.com/octocat/spoon-knife/actions",
    });
  });
});
