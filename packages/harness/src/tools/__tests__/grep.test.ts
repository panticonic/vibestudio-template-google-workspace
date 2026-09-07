import { describe, it, expect, vi } from "vitest";
import { createGrepTool, shouldWarnRe2Fallback } from "../grep.js";
import { StubFs } from "./stub-fs.js";

const CWD = "/work/ctx";

class CountingFs extends StubFs {
  readonly readPaths: string[] = [];

  override async readFile(path: string, encoding?: BufferEncoding) {
    this.readPaths.push(path);
    return super.readFile(path, encoding);
  }
}

describe("createGrepTool", () => {
  it("returns actionable guidance when the pattern is omitted", async () => {
    const tool = createGrepTool(CWD, new StubFs());
    const result = await tool.execute("call-1", {});
    expect((result.content[0] as { text: string }).text).toContain("No grep pattern supplied");
  });

  it("finds a literal pattern across multiple files", async () => {
    const fs = new StubFs({
      files: {
        [`${CWD}/a.ts`]: "const foo = 1;\nconst bar = 2;",
        [`${CWD}/b.ts`]: "const baz = 3;\nfoo() // call",
      },
    });
    const tool = createGrepTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "foo", literal: true });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("a.ts:1");
    expect(text).toContain("b.ts:2");
  });

  it("regex search matches groups", async () => {
    const fs = new StubFs({
      files: { [`${CWD}/a.ts`]: "let x = 10;\nlet y = 20;\nconst z = 30;" },
    });
    const tool = createGrepTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "let \\w+ = \\d+", literal: false });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("a.ts:1");
    expect(text).toContain("a.ts:2");
    expect(text).not.toContain("a.ts:3");
  });

  it("defaults to literal search for regex-looking snippets", async () => {
    const fs = new StubFs({
      files: { [`${CWD}/a.ts`]: "eval({ path: 'tmp/demo.ts' });" },
    });
    const tool = createGrepTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "eval({ path" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("a.ts:1");
  });

  it("rejects an invalid explicitly requested regex", async () => {
    const fs = new StubFs({ files: { [`${CWD}/a.ts`]: "open();" } });
    const tool = createGrepTool(CWD, fs);
    await expect(tool.execute("call-1", { pattern: "open(", literal: false })).rejects.toThrow(
      /regular expression|unterminated/iu
    );
  });

  it("does not reinterpret unrelated arguments as a missing pattern", async () => {
    const fs = new StubFs({ files: { [`${CWD}/a.ts`]: "readFile(path);" } });
    const tool = createGrepTool(CWD, fs);
    const result = await tool.execute("call-1", {
      path: ".",
      recallKeywords: "readFile bytes base64",
    } as never);

    expect((result.content[0] as { text: string }).text).toContain("No grep pattern supplied");
  });

  it("uses the host fs service before walking files", async () => {
    const calls: Array<{ target: string; method: string }> = [];
    const rpc = {
      async call(target: string, method: string) {
        calls.push({ target, method });
        if (method === "fs.grep") {
          return {
            matches: [
              {
                file: "src/a.ts",
                lineNumber: 2,
                line: "open();",
                before: ["before"],
                after: ["after"],
              },
            ],
            matchCount: 1,
            truncated: false,
          };
        }
        throw Object.assign(new Error("Extension is not installed"), { code: "ENOEXT" });
      },
    };
    const tool = createGrepTool(CWD, new StubFs({ files: {} }), { rpc: rpc as never });
    const result = await tool.execute("call-1", { pattern: "open(" });

    expect((result.content[0] as { text: string }).text).toContain("src/a.ts:2: open();");
    expect(result.details).toMatchObject({ engine: "fs-service" });
    expect(calls).toContainEqual({ target: "main", method: "fs.grep" });
  });

  it("routes directly through the host fs service without invoking an extension", async () => {
    const rpc = {
      call: vi.fn().mockImplementation((_target: string, method: string) => {
        if (method === "extensions.invoke") return new Promise(() => {});
        if (method === "fs.grep") {
          return Promise.resolve({
            matches: [
              {
                file: "src/a.ts",
                lineNumber: 1,
                line: "open();",
                before: [],
                after: [],
              },
            ],
            matchCount: 1,
            truncated: false,
          });
        }
        return Promise.reject(new Error(`Unexpected method: ${method}`));
      }),
    };
    const tool = createGrepTool(CWD, new StubFs({ files: {} }), { rpc: rpc as never });

    const result = await tool.execute("call-1", { pattern: "open(" });

    expect((result.content[0] as { text: string }).text).toContain("src/a.ts:1: open();");
    expect(result.details).toMatchObject({ engine: "fs-service" });
    expect(rpc.call).not.toHaveBeenCalledWith(
      expect.anything(),
      "extensions.invoke",
      expect.anything()
    );
  });

  it("propagates host failures instead of reporting a false empty search", async () => {
    const rpc = {
      call: vi.fn().mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" })),
    };
    const tool = createGrepTool(CWD, new StubFs({ files: {} }), { rpc: rpc as never });

    await expect(tool.execute("call-1", { pattern: "needle" })).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("passes cancellation and useful context ranges to the bounded host search", async () => {
    const rpc = {
      call: vi.fn().mockResolvedValue({ matches: [], matchCount: 0, truncated: false }),
    };
    const tool = createGrepTool(CWD, new StubFs({ files: {} }), { rpc: rpc as never });
    const controller = new AbortController();

    await tool.execute(
      "call-1",
      { pattern: "needle", limit: 7, context: 20, includeIgnored: true },
      controller.signal
    );

    expect(rpc.call).toHaveBeenCalledWith(
      "main",
      "fs.grep",
      ["needle", expect.objectContaining({ maxMatches: 7, contextLines: 20, includeIgnored: true })],
      { signal: controller.signal }
    );
  });

  it("returns 'No matches found' when nothing matches", async () => {
    const fs = new StubFs({ files: { [`${CWD}/a.ts`]: "abc" } });
    const tool = createGrepTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "xyz" });
    expect((result.content[0] as { text: string }).text).toBe("No matches found");
  });

  it("returns a diagnostic empty result for a missing exploratory search root", async () => {
    const tool = createGrepTool(CWD, new StubFs({ files: {} }));
    const result = await tool.execute("call-1", {
      path: "packages/missing",
      pattern: "needle",
    });

    expect((result.content[0] as { text: string }).text).toContain(
      "No matches found (search path does not exist: packages/missing)"
    );
    expect(result.details).toMatchObject({
      engine: "runtime-fs",
      missingSearchPath: "packages/missing",
    });
  });

  it("filters files by glob", async () => {
    const fs = new StubFs({
      files: {
        [`${CWD}/a.ts`]: "match",
        [`${CWD}/b.md`]: "match",
      },
    });
    const tool = createGrepTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "match", glob: "*.ts" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("a.ts");
    expect(text).not.toContain("b.md");
  });

  it("does not read files excluded by glob", async () => {
    const fs = new CountingFs({
      files: {
        [`${CWD}/a.ts`]: "match",
        [`${CWD}/b.md`]: "match",
      },
    });
    const tool = createGrepTool(CWD, fs);
    await tool.execute("call-1", { pattern: "match", glob: "*.ts" });
    expect(fs.readPaths.filter((file) => !/\.(?:gitignore|ignore)$/u.test(file))).toEqual([
      `${CWD}/a.ts`,
    ]);
  });

  it("respects ignore files in the RuntimeFs backend", async () => {
    const fs = new StubFs({
      files: {
        [`${CWD}/.gitignore`]: "ignored.ts\n",
        [`${CWD}/ignored.ts`]: "needle",
        [`${CWD}/visible.ts`]: "needle",
      },
    });
    const tool = createGrepTool(CWD, fs);

    const normal = await tool.execute("call-1", { pattern: "needle" });
    expect((normal.content[0] as { text: string }).text).toContain("visible.ts");
    expect((normal.content[0] as { text: string }).text).not.toContain("ignored.ts:1");
    const complete = await tool.execute("call-2", { pattern: "needle", includeIgnored: true });
    expect((complete.content[0] as { text: string }).text).toContain("ignored.ts:1");
  });

  it("emits progress updates during large searches", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 251; i++) {
      files[`${CWD}/f${i}.ts`] = "nope";
    }
    const fs = new StubFs({ files });
    const tool = createGrepTool(CWD, fs);
    const updates: unknown[] = [];

    await tool.execute("call-1", { pattern: "missing", glob: "**/*.ts" }, undefined, (update) =>
      updates.push(update.details)
    );

    expect(updates).toContainEqual({
      type: "console",
      content: "grep scanned 250/251 candidate files...",
    });
  });

  it("counts limit by matches, not context output lines", async () => {
    const fs = new StubFs({
      files: {
        [`${CWD}/a.ts`]: "before\nmatch one\nafter\nmatch two\nend",
      },
    });
    const tool = createGrepTool(CWD, fs);
    const result = await tool.execute("call-1", {
      pattern: "match",
      context: 1,
      limit: 1,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("a.ts-1- before");
    expect(text).toContain("a.ts:2: match one");
    expect(text).toContain("a.ts-3- after");
    expect(text).not.toContain("match two");
  });

  it("respects ignoreCase", async () => {
    const fs = new StubFs({ files: { [`${CWD}/a.ts`]: "Hello World" } });
    const tool = createGrepTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "hello", ignoreCase: true });
    expect((result.content[0] as { text: string }).text).toContain("a.ts:1");
  });

  it("aborts when signal is already aborted", async () => {
    const fs = new StubFs({ files: { [`${CWD}/a.ts`]: "x" } });
    const tool = createGrepTool(CWD, fs);
    const ac = new AbortController();
    ac.abort();
    await expect(tool.execute("call-1", { pattern: "x" }, ac.signal)).rejects.toThrow(/abort/i);
  });

  it("does not warn about missing native RE2 in workerd-like runtimes", () => {
    expect(
      shouldWarnRe2Fallback({
        process: { versions: { node: "22.0.0" } },
        navigator: { userAgent: "Cloudflare-Workers" },
      })
    ).toBe(false);
    expect(
      shouldWarnRe2Fallback({
        process: { versions: { node: "22.0.0" } },
        WebSocketPair: function WebSocketPair() {},
      })
    ).toBe(false);
  });

  it("warns about missing native RE2 in regular Node runtimes", () => {
    expect(
      shouldWarnRe2Fallback({
        process: { versions: { node: "22.0.0" } },
        navigator: { userAgent: "Node.js/22" },
      })
    ).toBe(true);
  });
});
