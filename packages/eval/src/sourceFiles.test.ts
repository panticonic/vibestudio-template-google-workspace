import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileComponent, executeSandbox, loadSourceFileBundle } from "./index";

function missing(path: string): Error & { code: string } {
  return Object.assign(new Error(`Missing ${path}`), { code: "ENOENT" });
}

function filesystemError(path: string, code: "EISDIR" | "ENOTDIR"): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

describe("source file bundles", () => {
  let originalModuleMap: unknown;
  let originalRequire: unknown;
  let originalPreload: unknown;

  beforeEach(() => {
    originalModuleMap = (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"];
    originalRequire = (globalThis as Record<string, unknown>)["__vibestudioRequire__"];
    originalPreload = (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"];

    const moduleMap: Record<string, unknown> = {};
    (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"] = moduleMap;
    (globalThis as Record<string, unknown>)["__vibestudioRequire__"] = (id: string) => {
      if (id in moduleMap) return moduleMap[id];
      throw new Error(`Module not found: ${id}`);
    };
    (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"] = async (ids: string[]) =>
      ids.map((id) => {
        if (id in moduleMap) return moduleMap[id];
        throw new Error(`Module not found: ${id}`);
      });
  });

  afterEach(() => {
    if (originalModuleMap === undefined)
      delete (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"];
    else (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"] = originalModuleMap;
    if (originalRequire === undefined)
      delete (globalThis as Record<string, unknown>)["__vibestudioRequire__"];
    else (globalThis as Record<string, unknown>)["__vibestudioRequire__"] = originalRequire;
    if (originalPreload === undefined)
      delete (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"];
    else (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"] = originalPreload;
  });

  it("loads an entry file and nested relative imports", async () => {
    const files: Record<string, string> = {
      "src/main.ts": `import { double } from "./math"; export default double(21);`,
      "src/math.ts": `import { base } from "./nested/base"; export const double = (n: number) => n * base;`,
      "src/nested/base.ts": `export const base = 2;`,
    };

    const bundle = await loadSourceFileBundle("src/main.ts", async (path) => {
      const code = files[path];
      if (code === undefined) throw missing(path);
      return code;
    });

    expect(bundle.entryPath).toBe("src/main.ts");
    expect(Object.keys(bundle.files).sort()).toEqual([
      "src/main.ts",
      "src/math.ts",
      "src/nested/base.ts",
    ]);
  });

  it("stops relative candidate search on a structured transport failure", async () => {
    const lost = Object.assign(new Error("Workspace session closed"), {
      errorKind: "transport",
      code: "CONNECTION_LOST",
      errorData: { reconnectable: true },
    });
    const calls: string[] = [];
    await expect(
      loadSourceFileBundle(
        "src/main.ts",
        async (path) => {
          calls.push(path);
          if (path === "src/main.ts") {
            return `import { label } from "./catalog"; export default label;`;
          }
          if (path === "src/catalog") throw missing(path);
          throw lost;
        },
      ),
    ).rejects.toBe(lost);
    expect(calls).toEqual(["src/main.ts", "src/catalog", "src/catalog.tsx"]);
  });

  it("resolves a directory import through its index after file candidates", async () => {
    const files: Record<string, string> = {
      "src/main.ts": `import { label } from "./catalog"; export default label;`,
      "src/catalog/index.ts": `export const label = "ready";`,
    };
    const bundle = await loadSourceFileBundle("src/main.ts", async (path) => {
      if (path === "src/catalog") throw filesystemError(path, "EISDIR");
      const code = files[path];
      if (code === undefined) throw missing(path);
      return code;
    });
    expect(bundle.resolutions["src/main.ts\n./catalog"]).toBe("src/catalog/index.ts");
  });

  it("continues after an ENOTDIR candidate failure", async () => {
    const code = `import { label } from "./catalog"; export default label;`;
    const bundle = await loadSourceFileBundle("src/main.ts", async (path) => {
      if (path === "src/main.ts") return code;
      if (path === "src/catalog") throw filesystemError(path, "ENOTDIR");
      if (path === "src/catalog.tsx") return `export const label = "ready";`;
      throw missing(path);
    });
    expect(bundle.resolutions["src/main.ts\n./catalog"]).toBe("src/catalog.tsx");
  });

  it("preserves structured import failures in compile results", async () => {
    const lost = Object.assign(new Error("Workspace session closed"), {
      errorKind: "transport",
      code: "CONNECTION_LOST",
      errorData: { reconnectable: true },
    });
    const code = `import { label } from "./catalog"; export default function App() { return label; }`;
    const result = await compileComponent(code, {
      sourcePath: "src/App.tsx",
      loadSourceFile: async (path) => {
        if (path === "src/App.tsx") return code;
        throw lost;
      },
    });
    expect(result).toMatchObject({
      success: false,
      error: "Workspace session closed",
      errorKind: "transport",
      code: "CONNECTION_LOST",
      errorData: { reconnectable: true },
    });
  });

  it("executes eval files with relative imports", async () => {
    const code = `import { double } from "./math"; return double(input);`;
    const result = await executeSandbox(code, {
      syntax: "typescript",
      sourcePath: "src/main.ts",
      sourceFiles: {
        "src/main.ts": code,
        "src/math.ts": `export const double = (n: number) => n * 2;`,
      },
      bindings: { input: 21 },
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(42);
  });

  it("infers bare npm imports from the nearest package.json", async () => {
    const code = `import { double } from "math-lib"; return double(input);`;
    const loadCalls: Array<{ specifier: string; ref: string | undefined }> = [];
    const result = await executeSandbox(code, {
      syntax: "typescript",
      sourcePath: "packages/app/src/main.ts",
      loadSourceFile: async (path) => {
        if (path === "packages/app/src/main.ts") return code;
        if (path === "packages/app/package.json") {
          return JSON.stringify({ dependencies: { "math-lib": "^1.2.3" } });
        }
        throw missing(path);
      },
      loadImport: async (specifier, ref) => {
        loadCalls.push({ specifier, ref });
        return { bundle: `module.exports = { double: (n) => n * 2 };`, format: "cjs" as const };
      },
      bindings: { input: 21 },
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(42);
    expect(loadCalls).toEqual([{ specifier: "math-lib", ref: "npm:^1.2.3" }]);
  });

  it("uses explicit imports over package.json inference, including subpaths", async () => {
    const code = `import { double } from "math-lib/subpath"; return double(input);`;
    const loadCalls: Array<{ specifier: string; ref: string | undefined }> = [];
    const result = await executeSandbox(code, {
      syntax: "typescript",
      sourcePath: "packages/app/src/main.ts",
      imports: { "math-lib": "npm:9" },
      loadSourceFile: async (path) => {
        if (path === "packages/app/src/main.ts") return code;
        if (path === "packages/app/package.json") {
          return JSON.stringify({ dependencies: { "math-lib": "^1.2.3" } });
        }
        throw missing(path);
      },
      loadImport: async (specifier, ref) => {
        loadCalls.push({ specifier, ref });
        return { bundle: `module.exports = { double: (n) => n * 2 };`, format: "cjs" as const };
      },
      bindings: { input: 21 },
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(42);
    expect(loadCalls).toEqual([
      { specifier: "math-lib", ref: "npm:9" },
      { specifier: "math-lib/subpath", ref: "npm:9" },
    ]);
  });

  it("reports missing package declarations clearly for file-loaded sources", async () => {
    const code = `import { double } from "missing-lib"; return double(input);`;
    const result = await executeSandbox(code, {
      syntax: "typescript",
      sourcePath: "packages/app/src/main.ts",
      loadSourceFile: async (path) => {
        if (path === "packages/app/src/main.ts") return code;
        if (path === "packages/app/package.json") {
          return JSON.stringify({ dependencies: {} });
        }
        throw missing(path);
      },
      loadImport: async () => {
        throw new Error("should not be called");
      },
      bindings: { input: 21 },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not declared");
    expect(result.error).toContain("packages/app/package.json");
  });

  it("does not suggest npm imports for Node built-ins from file-loaded helpers", async () => {
    const code = `import { run } from "./helper"; return run;`;
    const result = await executeSandbox(code, {
      syntax: "typescript",
      sourcePath: "packages/app/src/main.ts",
      sourceFiles: {
        "packages/app/src/main.ts": code,
        "packages/app/src/helper.ts": `import { spawn } from "node:child_process"; export const run = spawn;`,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Node built-in module "node:child_process" is not available');
    expect(result.error).toContain("@workspace/runtime");
    expect(result.error).not.toContain("npm:latest");
  });

  it("does not infer eval imports from devDependencies", async () => {
    const code = `import { describe } from "vitest"; return typeof describe;`;
    const loadCalls: Array<{ specifier: string; ref: string | undefined }> = [];
    const result = await executeSandbox(code, {
      syntax: "typescript",
      sourcePath: "packages/app/src/main.ts",
      loadSourceFile: async (path) => {
        if (path === "packages/app/src/main.ts") return code;
        if (path === "packages/app/package.json") {
          return JSON.stringify({ devDependencies: { vitest: "^3.2.4" } });
        }
        throw missing(path);
      },
      loadImport: async (specifier, ref) => {
        loadCalls.push({ specifier, ref });
        return { bundle: `module.exports = {};`, format: "cjs" as const };
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not declared");
    expect(result.error).toContain("packages/app/package.json");
    expect(loadCalls).toEqual([]);
  });

  it("resolves package.json imports aliases to source files", async () => {
    const code = `import { label } from "#labels"; return label;`;
    const result = await executeSandbox(code, {
      syntax: "typescript",
      sourcePath: "packages/app/src/main.ts",
      loadSourceFile: async (path) => {
        if (path === "packages/app/src/main.ts") return code;
        if (path === "packages/app/src/labels.ts") return `export const label = "ready";`;
        if (path === "packages/app/package.json") {
          return JSON.stringify({ imports: { "#labels": "./src/labels.ts" } });
        }
        throw missing(path);
      },
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe("ready");
  });

  it("resolves tsconfig paths aliases to source files", async () => {
    const code = `import { label } from "@/labels"; return label;`;
    const result = await executeSandbox(code, {
      syntax: "typescript",
      sourcePath: "packages/app/src/main.ts",
      loadSourceFile: async (path) => {
        if (path === "packages/app/src/main.ts") return code;
        if (path === "packages/app/src/labels.ts") return `export const label = "ready";`;
        if (path === "packages/app/tsconfig.json") {
          return JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } });
        }
        throw missing(path);
      },
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe("ready");
  });

  it("compiles components with relative imports", async () => {
    const code = `import { label } from "./labels"; export default function App() { return label; }`;
    const result = await compileComponent<() => string>(code, {
      sourcePath: "ui/App.tsx",
      sourceFiles: {
        "ui/App.tsx": code,
        "ui/labels.ts": `export const label = "ready";`,
      },
    });

    expect(result.success).toBe(true);
    expect(result.Component?.()).toBe("ready");
  });

  it("resolves a .js specifier to its .ts/.tsx source sibling", async () => {
    const code = `import { label } from "./labels.js"; export default function App() { return label; }`;
    const result = await compileComponent<() => string>(code, {
      sourcePath: "ui/App.tsx",
      sourceFiles: {
        "ui/App.tsx": code,
        "ui/labels.ts": `export const label = "ready";`,
      },
    });

    expect(result.success).toBe(true);
    expect(result.Component?.()).toBe("ready");
  });

  it("ignores type-only relative imports (erased, never fetched)", async () => {
    const code = `import type { Label } from "./types.js";
const label: Label = "ready";
export default function App() { return label; }`;
    // Note: "ui/types.ts" is intentionally absent from sourceFiles — a type-only
    // import must not be fetched, so compilation should still succeed.
    const result = await compileComponent<() => string>(code, {
      sourcePath: "ui/App.tsx",
      sourceFiles: { "ui/App.tsx": code },
    });

    expect(result.success).toBe(true);
    expect(result.Component?.()).toBe("ready");
  });

  it("compiles file components with package.json inferred imports", async () => {
    const code = `import { label } from "label-lib"; export default function App() { return label; }`;
    const loadCalls: Array<{ specifier: string; ref: string | undefined }> = [];
    const result = await compileComponent<() => string>(code, {
      sourcePath: "packages/app/ui/App.tsx",
      loadSourceFile: async (path) => {
        if (path === "packages/app/ui/App.tsx") return code;
        if (path === "packages/app/package.json") {
          return JSON.stringify({ dependencies: { "label-lib": "2" } });
        }
        throw missing(path);
      },
      loadImport: async (specifier, ref) => {
        loadCalls.push({ specifier, ref });
        return { bundle: `module.exports = { label: "ready" };`, format: "cjs" as const };
      },
    });

    expect(result.success).toBe(true);
    expect(result.Component?.()).toBe("ready");
    expect(loadCalls).toEqual([{ specifier: "label-lib", ref: "npm:2" }]);
  });
});
