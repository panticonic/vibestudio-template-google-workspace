import { describe, it, expect, vi } from "vitest";
import { createFindTool } from "../find.js";
import { StubFs } from "./stub-fs.js";

const CWD = "/work/ctx";

describe("createFindTool", () => {
  it("returns actionable guidance when the pattern is omitted", async () => {
    const tool = createFindTool(CWD, new StubFs());
    const result = await tool.execute("call-1", {});
    expect((result.content[0] as { text: string }).text).toContain("No find pattern supplied");
  });

  it("finds files matching a glob", async () => {
    const fs = new StubFs({
      files: {
        [`${CWD}/a.ts`]: "x",
        [`${CWD}/b.md`]: "x",
        [`${CWD}/sub/c.ts`]: "x",
      },
    });
    const tool = createFindTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "**/*.ts" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("a.ts");
    expect(text).toContain("sub/c.ts");
    expect(text).not.toContain("b.md");
  });

  it("returns 'No files found' when nothing matches", async () => {
    const fs = new StubFs({ files: { [`${CWD}/a.ts`]: "x" } });
    const tool = createFindTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "*.md" });
    expect((result.content[0] as { text: string }).text).toBe("No files found matching pattern");
  });

  it("returns a diagnostic empty result for a missing exploratory search root", async () => {
    const tool = createFindTool(CWD, new StubFs({ files: {} }));
    const result = await tool.execute("call-1", {
      path: "packages/missing",
      pattern: "*.ts",
    });

    expect((result.content[0] as { text: string }).text).toContain(
      "No files found matching pattern (search path does not exist: packages/missing)"
    );
    expect(result.details).toMatchObject({
      engine: "runtime-fs",
      missingSearchPath: "packages/missing",
    });
  });

  it("includes hidden (dot) files", async () => {
    const fs = new StubFs({
      files: { [`${CWD}/.hidden`]: "x", [`${CWD}/visible`]: "x" },
    });
    const tool = createFindTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "*" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(".hidden");
  });

  it("respects nested ignore files and can include ignored files explicitly", async () => {
    const fs = new StubFs({
      files: {
        [`${CWD}/.gitignore`]: "ignored.ts\n",
        [`${CWD}/ignored.ts`]: "x",
        [`${CWD}/visible.ts`]: "x",
        [`${CWD}/nested/.ignore`]: "local.ts\n",
        [`${CWD}/nested/local.ts`]: "x",
      },
    });
    const tool = createFindTool(CWD, fs);

    const normal = await tool.execute("call-1", { pattern: "**/*.ts" });
    expect((normal.content[0] as { text: string }).text).toBe("visible.ts");
    const complete = await tool.execute("call-2", {
      pattern: "**/*.ts",
      includeIgnored: true,
    });
    expect((complete.content[0] as { text: string }).text).toBe(
      "ignored.ts\nnested/local.ts\nvisible.ts"
    );
  });

  it("uses the context-scoped host glob when RPC is available", async () => {
    const fs = new StubFs({ files: { [`${CWD}/src/a.ts`]: "x" } });
    const stat = vi.spyOn(fs, "stat");
    const rpc = {
      call: vi.fn().mockResolvedValue({
        files: [`${CWD}/src/a.ts`],
        truncated: false,
      }),
      stream: vi.fn(async () => new Response()),
    };
    const tool = createFindTool(CWD, fs, { rpc });

    const result = await tool.execute("call-1", { pattern: "**/*.ts", path: ".", limit: 10 });

    expect((result.content[0] as { text: string }).text).toBe("src/a.ts");
    expect(rpc.call).toHaveBeenCalledWith(
      "main",
      "fs.glob",
      ["**/*.ts", { path: CWD, limit: 10 }],
      undefined
    );
    expect(stat).not.toHaveBeenCalled();
  });

  it("bounds host glob results without issuing per-directory RPC calls", async () => {
    const fs = new StubFs({ files: { [`${CWD}/src/a.ts`]: "x" } });
    const rpc = {
      call: vi.fn().mockResolvedValue({
        files: [`${CWD}/src/a.ts`, `${CWD}/src/b.ts`],
        truncated: true,
        nextCursor: `${CWD}/src/b.ts`,
      }),
    };
    const tool = createFindTool(CWD, fs, { rpc: rpc as never });

    const result = await tool.execute("call-1", { pattern: "**/*.ts", limit: 2 });

    expect((result.content[0] as { text: string }).text).toContain("src/a.ts");
    expect((result.content[0] as { text: string }).text).toContain("src/b.ts");
    expect((result.content[0] as { text: string }).text).not.toContain("src/c.ts");
    expect(result.details).toMatchObject({
      engine: "fs-service",
      resultLimitReached: 2,
      nextCursor: "src/b.ts",
    });
    expect(rpc.call).toHaveBeenCalledTimes(1);
  });

  it("returns a diagnostic empty result when the host search root is a file", async () => {
    const rpc = {
      call: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("not a directory"), { code: "ENOTDIR" })),
    };
    const tool = createFindTool(CWD, new StubFs({ files: {} }), { rpc: rpc as never });

    const result = await tool.execute("call-1", {
      pattern: "handle.close",
      path: "packages/runtime/src/shared/rpcFs.test.ts",
      limit: 20,
    });

    expect((result.content[0] as { text: string }).text).toContain(
      "search path is not a directory: packages/runtime/src/shared/rpcFs.test.ts"
    );
    expect(result.details).toMatchObject({
      engine: "fs-service",
      nonDirectorySearchPath: "packages/runtime/src/shared/rpcFs.test.ts",
    });
  });

  it("propagates host authorization and infrastructure failures", async () => {
    const rpc = {
      call: vi.fn().mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" })),
    };
    const tool = createFindTool(CWD, new StubFs({ files: {} }), { rpc: rpc as never });

    await expect(tool.execute("call-1", { pattern: "*.ts" })).rejects.toMatchObject({
      code: "EACCES",
    });
  });
});
