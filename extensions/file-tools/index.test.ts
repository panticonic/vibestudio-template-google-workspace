import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { platform } from "node:process";
import { activate } from "./index.js";

const tempRoots: string[] = [];

interface TextToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: { engine?: string };
}

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "vibestudio-file-tools-"),
  );
  tempRoots.push(root);
  return root;
}

function nativeFs(root: string) {
  return {
    realpath: async (input: string) => fs.realpath(path.join(root, input)),
    nativeRoots: async () => {
      const source = path.join(root, ".source");
      await fs.mkdir(source, { recursive: true });
      return { source, scratch: root };
    },
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("@workspace-extensions/file-tools", () => {
  it("searches a context workspace with glob and context lines", async () => {
    const workspaceRoot = await makeTempRoot();
    const contextProjectionsPath = path.join(
      workspaceRoot,
      ".context-projections",
      "v5",
    );
    const contextRoot = path.join(contextProjectionsPath, "ctx-test");
    await fs.mkdir(path.join(contextRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(contextRoot, "src", "entities.ts"),
      [
        "const before = true;",
        "export const entity = createEntity({ id: 'a' });",
        "const after = true;",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(contextRoot, "src", "notes.md"),
      "createEntity should not match this file\n",
    );

    const api = await activate({
      workspace: {
        getInfo: async () => ({ path: workspaceRoot, contextProjectionsPath }),
      },
      fs: nativeFs(contextRoot),
      log: { info: vi.fn() },
      health: { healthy: vi.fn(), degraded: vi.fn() },
    });

    const result = (await api.grep({
      pattern: "createEntity",
      path: ".",
      glob: "**/*.ts",
      context: 1,
      limit: 100,
    })) as TextToolResult;

    const text =
      result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("src/entities.ts-1- const before = true;");
    expect(text).toContain(
      "src/entities.ts:2: export const entity = createEntity({ id: 'a' });",
    );
    expect(text).toContain("src/entities.ts-3- const after = true;");
    expect(text).not.toContain("notes.md");
    expect(result.details?.engine).toBe("ripgrep");
  });

  it("reports no matches without details", async () => {
    const workspaceRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(workspaceRoot, "file.ts"),
      "export const value = 1;\n",
    );

    const api = await activate({
      workspace: {
        getInfo: async () => ({
          path: workspaceRoot,
          contextProjectionsPath: path.join(
            workspaceRoot,
            ".context-projections",
            "v5",
          ),
        }),
      },
      fs: nativeFs(workspaceRoot),
      log: { info: vi.fn() },
    });

    const result = (await api.grep({
      pattern: "createEntity",
      path: ".",
      glob: "**/*.ts",
    })) as TextToolResult;

    expect(result.content).toEqual([
      { type: "text", text: "No matches found" },
    ]);
    expect(result.details).toBeUndefined();
  });

  it("defaults grep to literal matching for regex-looking snippets", async () => {
    const workspaceRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(workspaceRoot, "script.ts"),
      "eval({ path: 'tmp/demo.ts' });\n",
    );

    const api = await activate({
      workspace: {
        getInfo: async () => ({
          path: workspaceRoot,
          contextProjectionsPath: path.join(
            workspaceRoot,
            ".context-projections",
            "v5",
          ),
        }),
      },
      fs: nativeFs(workspaceRoot),
      log: { info: vi.fn() },
    });

    const result = (await api.grep({
      pattern: "eval({ path",
      path: ".",
    })) as TextToolResult;
    const text =
      result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("script.ts:1:");
  });

  it("searches literal multiline fragments without exposing ripgrep flags", async () => {
    const workspaceRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(workspaceRoot, "meta.yml"),
      "services:\n  - source: workers/notes\n    name: notes\n",
    );
    const api = await activate({
      workspace: {
        getInfo: async () => ({
          path: workspaceRoot,
          contextProjectionsPath: path.join(
            workspaceRoot,
            ".context-projections",
            "v5",
          ),
        }),
      },
      fs: nativeFs(workspaceRoot),
      log: { info: vi.fn() },
    });

    const result = (await api.grep({
      pattern: "services:\n  - source: workers/notes",
      path: ".",
    })) as TextToolResult;
    const text =
      result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("meta.yml:1: services:");
  });

  it("treats leading-dash patterns as source text rather than ripgrep flags", async () => {
    const workspaceRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(workspaceRoot, "meta.yml"),
      "services:\n  - source: workers/pubsub-channel\n",
    );
    const api = await activate({
      workspace: {
        getInfo: async () => ({
          path: workspaceRoot,
          contextProjectionsPath: path.join(
            workspaceRoot,
            ".context-projections",
            "v5",
          ),
        }),
      },
      fs: nativeFs(workspaceRoot),
      log: { info: vi.fn() },
    });

    const result = (await api.grep({
      pattern: "- source: workers/pubsub-channel",
      path: ".",
    })) as TextToolResult;
    const text =
      result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("meta.yml:2:");
  });

  it("reports an invalid glob instead of rewriting the request", async () => {
    const workspaceRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(workspaceRoot, "script.ts"),
      "const marker = 'glob-repair';\n",
    );
    const api = await activate({
      workspace: {
        getInfo: async () => ({
          path: workspaceRoot,
          contextProjectionsPath: path.join(
            workspaceRoot,
            ".context-projections",
            "v5",
          ),
        }),
      },
      fs: nativeFs(workspaceRoot),
      log: { info: vi.fn() },
    });

    await expect(
      api.grep({
        pattern: "glob-repair",
        path: ".",
        glob: "**/*.{ts,tsx,md",
      }),
    ).rejects.toThrow(
      /invalid glob|error parsing glob|unclosed alternate group/i,
    );
  });

  it("accepts relative workspace as the virtual-root alias", async () => {
    const workspaceRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(workspaceRoot, "script.ts"),
      "const marker = 'root-alias';\n",
    );
    const api = await activate({
      workspace: {
        getInfo: async () => ({
          path: workspaceRoot,
          contextProjectionsPath: path.join(
            workspaceRoot,
            ".context-projections",
            "v5",
          ),
        }),
      },
      fs: nativeFs(workspaceRoot),
      log: { info: vi.fn() },
    });

    const result = (await api.grep({
      pattern: "root-alias",
      path: "workspace",
    })) as TextToolResult;

    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(result.content[0]!.text).toContain("script.ts:1:");
  });

  it("reports invalid requested regexes instead of changing their meaning", async () => {
    const workspaceRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(workspaceRoot, "script.ts"),
      "openPanel('panels/chat');\n",
    );

    const api = await activate({
      workspace: {
        getInfo: async () => ({
          path: workspaceRoot,
          contextProjectionsPath: path.join(
            workspaceRoot,
            ".context-projections",
            "v5",
          ),
        }),
      },
      fs: nativeFs(workspaceRoot),
      log: { info: vi.fn() },
    });

    await expect(
      api.grep({
        pattern: "openPanel(",
        path: ".",
        literal: false,
      }),
    ).rejects.toThrow(/invalid grep regex pattern/i);
  });

  it("rejects a missing grep path with an actionable diagnostic", async () => {
    const workspaceRoot = await makeTempRoot();
    const api = await activate({
      workspace: {
        getInfo: async () => ({
          path: workspaceRoot,
          contextProjectionsPath: path.join(
            workspaceRoot,
            ".context-projections",
            "v5",
          ),
        }),
      },
      fs: nativeFs(workspaceRoot),
      log: { info: vi.fn() },
    });

    await expect(
      api.grep({
        pattern: "console",
        path: "packages workers panels",
        glob: "*diagnostic*",
      }),
    ).rejects.toThrow(/path not found.*not a space-separated list/i);
  });

  it("finds files with ripgrep file listing", async () => {
    const workspaceRoot = await makeTempRoot();
    const contextProjectionsPath = path.join(
      workspaceRoot,
      ".context-projections",
      "v5",
    );
    const contextRoot = path.join(contextProjectionsPath, "ctx-test");
    await fs.mkdir(path.join(contextRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(contextRoot, "src", "a.ts"),
      "export const a = 1;\n",
    );
    await fs.writeFile(path.join(contextRoot, "src", "b.md"), "# b\n");

    const api = await activate({
      workspace: {
        getInfo: async () => ({ path: workspaceRoot, contextProjectionsPath }),
      },
      fs: nativeFs(contextRoot),
      log: { info: vi.fn() },
    });

    const result = (await api.find({
      pattern: "**/*.ts",
      path: ".",
      limit: 100,
    })) as TextToolResult;

    expect(result.content[0]).toEqual({ type: "text", text: "src/a.ts" });
    expect(result.details?.engine).toBe("ripgrep");
  });

  it("reports invalid find globs and missing search paths", async () => {
    const workspaceRoot = await makeTempRoot();
    const api = await activate({
      workspace: {
        getInfo: async () => ({
          path: workspaceRoot,
          contextProjectionsPath: path.join(
            workspaceRoot,
            ".context-projections",
            "v5",
          ),
        }),
      },
      fs: nativeFs(workspaceRoot),
      log: { info: vi.fn() },
    });

    await expect(
      api.find({ pattern: "**/*.{ts,tsx", path: "." }),
    ).rejects.toThrow(/invalid find glob pattern/i);
    await expect(
      api.find({ pattern: "**/*.ts", path: "missing" }),
    ).rejects.toThrow(/path not found/i);
  });

  it("streams text reads with offset and limit", async () => {
    const workspaceRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(workspaceRoot, "big.txt"),
      Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"),
    );

    const api = await activate({
      workspace: {
        getInfo: async () => ({
          path: workspaceRoot,
          contextProjectionsPath: path.join(
            workspaceRoot,
            ".context-projections",
            "v5",
          ),
        }),
      },
      fs: nativeFs(workspaceRoot),
      log: { info: vi.fn() },
    });

    const result = (await api.read({
      path: "big.txt",
      offset: 3,
      limit: 2,
    })) as TextToolResult;

    const text =
      result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("line 3\nline 4");
    expect(text).toContain("Use offset=5");
    expect(text).not.toContain("line 5\n");
    expect(result.details?.engine).toBe("node-file");
  });

  it("returns empty content when reading an empty file without an offset", async () => {
    const workspaceRoot = await makeTempRoot();
    await fs.writeFile(path.join(workspaceRoot, "empty.txt"), "");

    const api = await activate({
      workspace: {
        getInfo: async () => ({
          path: workspaceRoot,
          contextProjectionsPath: path.join(
            workspaceRoot,
            ".context-projections",
            "v5",
          ),
        }),
      },
      fs: nativeFs(workspaceRoot),
      log: { info: vi.fn() },
    });

    const result = (await api.read({ path: "empty.txt" })) as TextToolResult;
    expect(result.content).toEqual([{ type: "text", text: "" }]);
    expect(result.details?.engine).toBe("node-file");
  });

  it("rejects symlinked roots that escape the scoped context", async () => {
    if (platform === "win32") return;
    const workspaceRoot = await makeTempRoot();
    const outsideRoot = await makeTempRoot();
    await fs.writeFile(path.join(outsideRoot, "secret.txt"), "outside\n");
    await fs.symlink(outsideRoot, path.join(workspaceRoot, "outside"));

    const api = await activate({
      workspace: {
        getInfo: async () => ({
          path: workspaceRoot,
          contextProjectionsPath: path.join(
            workspaceRoot,
            ".context-projections",
            "v5",
          ),
        }),
      },
      fs: nativeFs(workspaceRoot),
      log: { info: vi.fn() },
    });

    await expect(api.read({ path: "outside/secret.txt" })).rejects.toThrow(
      /escapes search root/i,
    );
  });
});
