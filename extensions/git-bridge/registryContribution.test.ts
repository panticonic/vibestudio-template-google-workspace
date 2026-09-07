import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitClient } from "@vibestudio/git";
import { RegistryContributionEngine } from "./registryContribution.js";

const roots: string[] = [];
const STOP = new Error("stop after credential selection");

function fixture(credential?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-contribution-"));
  roots.push(root);
  const gitHttp = vi.fn(() => ({ request: vi.fn() }));
  const rpc = {
    call: vi.fn(async <T>(_target: string, method: string): Promise<T> => {
      if (method === "runtime.createContext" || method === "vcs.edit" || method === "vcs.commit") {
        return undefined as T;
      }
      if (method === "vcs.status") {
        return {
          clean: true,
          workingHead: { kind: "event", eventId: "event:main" },
          committed: { kind: "event", eventId: "event:main" },
        } as T;
      }
      if (method === "vcs.resolveRepository") {
        return { repositoryId: "repository:meta", repoPath: "meta" } as T;
      }
      if (method === "vcs.readFile") return null as T;
      throw new Error(`unexpected RPC ${method}`);
    }),
  };
  const engine = new RegistryContributionEngine({
    storage: { root: path.join(root, "state") },
    workspace: {
      getInfo: vi.fn(async () => ({
        path: root,
        statePath: path.join(root, "state"),
        id: "workspace:1",
        name: "test",
      })),
    },
    credentials: { gitHttp },
    rpc,
  } as never);
  return {
    engine,
    gitHttp,
    input: {
      operationId: "promote-google-workspace",
      registryUrl: "git+https://github.com/panticonic/vibestudio-template-registry.git",
      baseCommit: "a".repeat(40),
      baseSnapshot: `v1-sha256:${"b".repeat(64)}`,
      registryDocument: "version: 1\n",
      entryId: "google-workspace",
      ...(credential ? { credential } : {}),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("RegistryContributionEngine credentials", () => {
  it("uses automatic URL-bound credential resolution for registry writes by default", async () => {
    vi.spyOn(GitClient.prototype, "clone").mockRejectedValue(STOP);
    const fx = fixture();

    await expect(fx.engine.suggest(fx.input)).rejects.toBe(STOP);

    expect(fx.gitHttp).toHaveBeenCalledWith(undefined);
  });

  it("honors an explicitly named registry credential", async () => {
    vi.spyOn(GitClient.prototype, "clone").mockRejectedValue(STOP);
    const fx = fixture("company-git");

    await expect(fx.engine.suggest(fx.input)).rejects.toBe(STOP);

    expect(fx.gitHttp).toHaveBeenCalledWith({
      logicalCredential: {
        name: "company-git",
        remoteUrl: "https://github.com/panticonic/vibestudio-template-registry.git",
      },
    });
  });
});
