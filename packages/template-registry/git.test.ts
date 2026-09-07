import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitClient } from "@vibestudio/git";
import { ExactGitRegistryAcquirer } from "./git.js";

const COMMIT = "d".repeat(40);
const roots: string[] = [];
const document = new TextEncoder().encode("version: 1\nrevision: test\n");

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(GitClient.prototype, "clone").mockResolvedValue();
  vi.spyOn(GitClient.prototype, "resolveCommit").mockResolvedValue(COMMIT);
  vi.spyOn(GitClient.prototype, "getCurrentCommit").mockResolvedValue(COMMIT);
  vi.spyOn(GitClient.prototype, "statusMatrix").mockResolvedValue([["registry.yml", 1, 1, 1]]);
  vi.spyOn(GitClient.prototype, "readCommitTree").mockResolvedValue([
    {
      path: "registry.yml",
      type: "blob",
      mode: 0o100644,
      oid: "e".repeat(40),
      bytes: document,
    },
  ]);
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("ExactGitRegistryAcquirer", () => {
  it("observes each refresh in an isolated checkout and retains only the snapshot bytes", async () => {
    const checkoutRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "template-registry-"));
    roots.push(checkoutRoot);
    const git = new GitClient(fsp, { http: {} as never });
    const acquirer = new ExactGitRegistryAcquirer({
      git,
      checkoutRoot,
      sink: {
        async put(bytes) {
          return {
            digest: createHash("sha256").update(bytes).digest("hex"),
            size: bytes.byteLength,
          };
        },
      },
    });
    const source = {
      url: "git+https://example.test/template-registry.git",
      ref: "refs/heads/promoted",
    };

    const [first, second] = await Promise.all([
      acquirer.discover(source),
      acquirer.discover(source),
    ]);

    expect(first.commit).toBe(COMMIT);
    expect(second.snapshot).toBe(first.snapshot);
    expect(first.readFile("registry.yml")).toEqual(document);
    const directories = vi
      .mocked(GitClient.prototype.clone)
      .mock.calls.map(([options]) => options.dir);
    expect(new Set(directories).size).toBe(2);
    expect(directories.every((directory) => directory !== path.join(checkoutRoot, "current"))).toBe(
      true
    );
    expect(await fsp.readdir(checkoutRoot)).toEqual([]);
  });
});
