import { describe, expect, it, vi } from "vitest";
import { gitInteropMethods } from "@vibestudio/service-schemas/gitInterop";
import { createGitClient } from "./git.js";

const SEMANTIC_EVIDENCE = {
  applicationId: "application:import",
  workUnitId: "work-unit:import",
  externalSnapshot: {
    sourceKind: "git" as const,
    sourceUri: "https://github.com/octo/demo.git",
    snapshotRevision: "a".repeat(40),
    sourceSubdir: null,
    canonicalSnapshot: `v1-sha256:${"c".repeat(64)}`,
    snapshotDigest: `snapshot:${"b".repeat(64)}`,
    targetRepositoryIds: ["repository:demo"],
  },
};

describe("runtime Git client", () => {
  it("is exactly the canonical gitInterop service surface", () => {
    const rpc = { call: vi.fn() };
    const client = createGitClient(rpc as never);

    expect(Object.keys(client)).toEqual(Object.keys(gitInteropMethods));
  });

  it("routes every method through gitInterop with unchanged arguments and results", async () => {
    const results: Record<string, unknown> = {
      setSharedRemote: {},
      removeSharedRemote: {},
      setUpstream: {},
      removeUpstream: {},
      setAutoPush: {},
      upstreamStatus: [],
      pushUpstream: {
        exported: 0,
        headCommit: null,
        outcome: "already-at-remote",
      },
      pullUpstream: {
        remote: "origin",
        branch: "main",
        observedCommit: null,
        changed: false,
        behindBy: 0,
        aheadBy: 0,
        remoteBranchExists: false,
        incoming: [],
      },
      publishRepo: {
        repoPath: "projects/demo",
        provider: "github",
        remote: "origin",
        branch: "main",
        remoteUrl: "https://github.com/octo/demo.git",
        webUrl: "https://github.com/octo/demo",
        owner: "octo",
        exported: 0,
        headCommit: null,
        pushed: true,
      },
      importProject: {
        path: "projects/demo",
        remote: { name: "origin", url: "https://github.com/octo/demo.git" },
        candidate: {
          contextId: "context:git-import",
          eventId: "event:git-import",
          changed: true,
          semanticEvidence: SEMANTIC_EVIDENCE,
        },
      },
    };
    const rpc = {
      call: vi.fn(async (_target: string, method: string, payload: unknown[]) => {
        expect(method).toBe("extensions.invokeProvider");
        const name = payload[1] as string;
        return results[name];
      }),
    };
    const client = createGitClient(rpc as never) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const invocations: Array<[string, unknown[]]> = [
      [
        "setSharedRemote",
        ["projects/demo", { name: "origin", url: "https://github.com/octo/demo.git" }],
      ],
      ["removeSharedRemote", ["projects/demo", "origin"]],
      ["setUpstream", ["projects/demo", { remote: "origin", autoPush: true }]],
      ["removeUpstream", ["projects/demo"]],
      ["setAutoPush", ["projects/demo", false]],
      ["upstreamStatus", [["projects/demo"]]],
      ["pushUpstream", ["projects/demo", { force: true }]],
      ["pullUpstream", ["projects/demo", { dryRun: true }]],
      ["publishRepo", [{ repoPath: "projects/demo", provider: "github", autoPush: true }]],
      [
        "importProject",
        [
          {
            path: "projects/demo",
            remote: { name: "origin", url: "https://github.com/octo/demo.git" },
          },
        ],
      ],
    ];

    for (const [method, args] of invocations) {
      await expect(client[method]!(...args)).resolves.toEqual(results[method]);
      expect(rpc.call).toHaveBeenLastCalledWith("main", "extensions.invokeProvider", [
        "gitInterop",
        method,
        args,
      ]);
    }
  });

  it("preserves the canonical status row array and one-object publish shape", async () => {
    const statusRows = [
      {
        repoPath: "projects/demo",
        autoPush: false,
        state: "behind",
        aheadBy: 0,
        behindBy: 2,
      },
    ];
    const publishInput = {
      repoPath: "projects/demo",
      provider: "github",
      name: "demo",
      autoPush: true,
    };
    const rpc = {
      call: vi.fn().mockResolvedValueOnce(statusRows).mockResolvedValueOnce({
        repoPath: "projects/demo",
        provider: "github",
        remote: "origin",
        branch: "main",
        remoteUrl: "https://github.com/octo/demo.git",
        webUrl: "https://github.com/octo/demo",
        owner: "octo",
        exported: 1,
        headCommit: "abc123",
        pushed: true,
      }),
    };
    const client = createGitClient(rpc as never);

    await expect(client.upstreamStatus(["projects/demo"])).resolves.toEqual(statusRows);
    await client.publishRepo(publishInput);

    expect(rpc.call).toHaveBeenNthCalledWith(1, "main", "extensions.invokeProvider", [
      "gitInterop",
      "upstreamStatus",
      [["projects/demo"]],
    ]);
    expect(rpc.call).toHaveBeenNthCalledWith(2, "main", "extensions.invokeProvider", [
      "gitInterop",
      "publishRepo",
      [publishInput],
    ]);
  });
});
