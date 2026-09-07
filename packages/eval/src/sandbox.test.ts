import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tameRealmCodegen } from "@vibestudio/shared/evalConfinement";
import { executeSandbox } from "./sandbox";
import type { AsyncTrackingAPI } from "./asyncTracking";

describe("executeSandbox", () => {
  let originalModuleMap: unknown;
  let originalRequire: unknown;
  let originalAsyncRequire: unknown;
  let originalPreload: unknown;
  let originalModuleLoaders: unknown;
  let originalNativeImportSpecifiers: unknown;
  let originalLoadImport: unknown;
  let originalAsyncTracking: unknown;

  beforeEach(() => {
    originalModuleMap = (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"];
    originalRequire = (globalThis as Record<string, unknown>)["__vibestudioRequire__"];
    originalAsyncRequire = (globalThis as Record<string, unknown>)["__vibestudioRequireAsync__"];
    originalPreload = (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"];
    originalModuleLoaders = (globalThis as Record<string, unknown>)["__vibestudioModuleLoaders__"];
    originalNativeImportSpecifiers = (globalThis as Record<string, unknown>)[
      "__vibestudioNativeImportSpecifiers__"
    ];
    originalLoadImport = (globalThis as Record<string, unknown>)["__vibestudioLoadImport__"];
    originalAsyncTracking = (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"];

    const moduleMap: Record<string, unknown> = {};
    (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"] = moduleMap;
    (globalThis as Record<string, unknown>)["__vibestudioRequire__"] = (id: string) => {
      if (id in moduleMap) return moduleMap[id];
      throw new Error(`Module not found: ${id}`);
    };
    delete (globalThis as Record<string, unknown>)["__vibestudioRequireAsync__"];
    (globalThis as Record<string, unknown>)["__vibestudioModuleLoaders__"] = {};
    (globalThis as Record<string, unknown>)["__vibestudioNativeImportSpecifiers__"] = new Set();
    (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"] = async (
      ids: string[]
    ) =>
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
    if (originalAsyncRequire === undefined)
      delete (globalThis as Record<string, unknown>)["__vibestudioRequireAsync__"];
    else
      (globalThis as Record<string, unknown>)["__vibestudioRequireAsync__"] = originalAsyncRequire;
    if (originalPreload === undefined)
      delete (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"];
    else (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"] = originalPreload;
    if (originalModuleLoaders === undefined)
      delete (globalThis as Record<string, unknown>)["__vibestudioModuleLoaders__"];
    else
      (globalThis as Record<string, unknown>)["__vibestudioModuleLoaders__"] =
        originalModuleLoaders;
    if (originalNativeImportSpecifiers === undefined)
      delete (globalThis as Record<string, unknown>)["__vibestudioNativeImportSpecifiers__"];
    else
      (globalThis as Record<string, unknown>)["__vibestudioNativeImportSpecifiers__"] =
        originalNativeImportSpecifiers;
    if (originalLoadImport === undefined)
      delete (globalThis as Record<string, unknown>)["__vibestudioLoadImport__"];
    else (globalThis as Record<string, unknown>)["__vibestudioLoadImport__"] = originalLoadImport;
    if (originalAsyncTracking === undefined)
      delete (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"];
    else
      (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"] =
        originalAsyncTracking;
  });

  it("settles a rejected top-level result without waiting on unrelated tracked work", async () => {
    const context = { id: 1, promises: new Set<Promise<unknown>>(), pauseCount: 0 };
    const tracking: AsyncTrackingAPI = {
      start: () => context,
      enter: () => undefined,
      exit: () => undefined,
      stop: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      ignore: <T>(value: T) => value,
      waitAll: () => new Promise<void>(() => undefined),
      pending: () => 0,
      activeContexts: () => [context.id],
    };
    (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"] = tracking;

    await expect(
      executeSandbox('await Promise.resolve(); throw new Error("terminal eval failure");', {
        syntax: "typescript",
      })
    ).resolves.toMatchObject({ success: false, error: "terminal eval failure" });
  });

  it("settles a pending async eval when its signal is aborted", async () => {
    const controller = new AbortController();
    const pending = executeSandbox("return await new Promise(() => {});", {
      syntax: "typescript",
      signal: controller.signal,
    });

    controller.abort("User interrupted execution");

    await expect(pending).resolves.toMatchObject({
      success: false,
      error: "User interrupted execution",
    });
  });

  it("fails fast when the signal is already aborted before execution", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeSandbox("return 21 + 21;", {
      syntax: "typescript",
      signal: controller.signal,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("completes normally when an unaborted signal is provided", async () => {
    const controller = new AbortController();
    const result = await executeSandbox("return 1 + 2;", {
      syntax: "typescript",
      signal: controller.signal,
    });
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(3);
  });

  it("propagates private-global confinement through the transformed sandbox", async () => {
    // Confinement requires a realm that cannot compile code; node:vm stands in
    // for the codegen-free evaluator isolate.
    const guestContext = vm.createContext({});
    tameRealmCodegen(vm.runInContext("globalThis", guestContext) as Record<string, unknown>);
    const result = await executeSandbox(
      `return { processType: typeof process, fetchType: typeof fetch, answer: seed + 1 };`,
      {
        syntax: "typescript",
        bindings: { seed: 41 },
        confinement: "private-global",
        compileFunction: (argNames, body) =>
          vm.runInContext(`(function (${argNames.join(", ")}) {\n${body}\n})`, guestContext) as (
            ...args: unknown[]
          ) => unknown,
      }
    );

    expect(result).toMatchObject({
      success: true,
      returnValue: { processType: "undefined", fetchType: "undefined", answer: 42 },
    });
  });

  it("confines and freezes relative source module namespaces before publishing their exports", async () => {
    const guestContext = vm.createContext({ evaluatorSecret: "LEAKED" });
    tameRealmCodegen(vm.runInContext("globalThis", guestContext) as Record<string, unknown>);
    const moduleMap: Record<string, unknown> = {};
    const freezeModuleNamespace = vi.fn(<T>(value: T): T => {
      if ((typeof value === "object" && value !== null) || typeof value === "function") {
        Object.freeze(value);
      }
      return value;
    });
    const result = await executeSandbox(
      `import { observedSecret } from "./helper"; return observedSecret;`,
      {
        syntax: "typescript",
        sourcePath: "src/main.ts",
        sourceFiles: {
          "src/main.ts": `import { observedSecret } from "./helper"; return observedSecret;`,
          "src/helper.ts": `export const observedSecret = typeof evaluatorSecret;`,
        },
        moduleMap,
        require: (id) => {
          if (id in moduleMap) return moduleMap[id];
          throw new Error(`Module not found: ${id}`);
        },
        confinement: "private-global",
        compileFunction: (argNames, body) =>
          vm.runInContext(`(function (${argNames.join(", ")}) {\n${body}\n})`, guestContext) as (
            ...args: unknown[]
          ) => unknown,
        freezeModuleNamespace,
      }
    );

    expect(result).toMatchObject({ success: true, returnValue: "undefined" });
    expect(freezeModuleNamespace).toHaveBeenCalled();
    expect(Object.isFrozen(moduleMap["src/helper.ts"])).toBe(true);
  });

  it("settles synchronous loops at an explicit cooperative deadline", async () => {
    const timeoutMs = 5;
    const result = await executeSandbox("while (true) {}", {
      syntax: "typescript",
      deadline: { atMs: Date.now() + timeoutMs, timeoutMs },
    });

    expect(result).toMatchObject({
      success: false,
      error: `eval timed out after ${timeoutMs}ms`,
    });
  });

  it("settles synchronous recursion at an explicit cooperative deadline", async () => {
    const timeoutMs = 5;
    const result = await executeSandbox(
      "function recurse() { return recurse(); } return recurse();",
      {
        syntax: "typescript",
        deadline: { atMs: Date.now(), timeoutMs },
      }
    );

    expect(result).toMatchObject({
      success: false,
      error: `eval timed out after ${timeoutMs}ms`,
    });
  });

  it("does not instrument synchronous code when no deadline is supplied", async () => {
    const result = await executeSandbox(
      "let n = 0; while (n < 3) n += 1; const f = (x) => x + 1; return f(n);",
      { syntax: "typescript" }
    );

    expect(result).toMatchObject({ success: true, returnValue: 4 });
  });

  it("deactivates checkpoints captured by functions that outlive a bounded run", async () => {
    const holder: { fn?: () => number } = {};
    const result = await executeSandbox("holder.fn = () => 42; return 'stored';", {
      syntax: "typescript",
      bindings: { holder },
      deadline: { atMs: Date.now() + 50, timeoutMs: 50 },
    });
    expect(result).toMatchObject({ success: true, returnValue: "stored" });

    await new Promise((resolve) => setTimeout(resolve, 55));
    expect(holder.fn?.()).toBe(42);
  });

  it("awaits a trailing async IIFE as the eval result", async () => {
    const result = await executeSandbox(
      "(async () => { await Promise.resolve(); return 42; })();",
      { syntax: "typescript" }
    );

    expect(result).toMatchObject({ success: true, returnValue: 42 });
  });

  it("returns a trailing object literal like a notebook REPL", async () => {
    const result = await executeSandbox(
      "const path = 'probe.txt';\nconst actorId = 'agent:1';\n{ path, actorId, turnId: 'turn:1' }",
      { syntax: "typescript" }
    );

    expect(result).toMatchObject({
      success: true,
      returnValue: { path: "probe.txt", actorId: "agent:1", turnId: "turn:1" },
    });
  });

  it("returns any trailing expression like a notebook REPL", async () => {
    const result = await executeSandbox(
      "function factorial(n: number): number { return n <= 1 ? 1 : n * factorial(n - 1); }\nconst value = factorial(5);\nvalue;",
      { syntax: "typescript" }
    );

    expect(result).toMatchObject({ success: true, returnValue: 120 });
  });

  it("does not replace an explicit return with an earlier expression", async () => {
    const result = await executeSandbox("const value = 6 * 7;\nvalue;\nreturn 'explicit';", {
      syntax: "typescript",
    });

    expect(result).toMatchObject({ success: true, returnValue: "explicit" });
  });

  it("repairs transport-escaped whitespace outside literals", async () => {
    const result = await executeSandbox(
      String.raw`return { first: 1,\n second: 2, text: "keep,\\n literal" };`,
      { syntax: "typescript" }
    );

    expect(result).toMatchObject({
      success: true,
      returnValue: { first: 1, second: 2, text: "keep,\\n literal" },
    });
  });

  it("repairs a missing call parenthesis before a line-ending semicolon", async () => {
    const result = await executeSandbox(
      "const list = [{repoPath: 'demo'}];\nconsole.log(JSON.stringify({count:list.length, repos:list.map(s=>s.repoPath)});\nreturn list.length;",
      { syntax: "typescript" }
    );

    expect(result).toMatchObject({ success: true, returnValue: 1 });
  });

  it("repairs a missing outer call parenthesis after a multiline nested expression", async () => {
    const result = await executeSandbox(
      `const page = { evaluate: (fn: () => unknown) => fn() };
       const data = await page.evaluate(() => [{title: "List"}].map((list, listIndex) => ({
         title: list.title,
         position: listIndex,
         cards: [{title: "Card"}].map((card, cardIndex) => {
           return {title: card.title, position: cardIndex};
         })
       }));
       return data;`,
      { syntax: "typescript" }
    );

    expect(result).toMatchObject({
      success: true,
      returnValue: [{ title: "List", position: 0, cards: [{ title: "Card", position: 0 }] }],
    });
  });

  it("does not treat parentheses inside a regular-expression literal as unmatched calls", async () => {
    const result = await executeSandbox('const value = /\\(/.test("("); return value;', {
      syntax: "typescript",
    });

    expect(result).toMatchObject({ success: true, returnValue: true });
  });

  it("repairs a leaked tool-call JSON suffix after otherwise complete code", async () => {
    const result = await executeSandbox('const value = 41;\nreturn value + 1;\n"}', {
      syntax: "typescript",
    });

    expect(result).toMatchObject({ success: true, returnValue: 42 });
  });

  it("lifts direct node:fs sync calls to awaited portable operations", async () => {
    const files = new Map<string, string | Uint8Array>();
    const nodeFs = {
      async writeFile(path: string, data: string | Uint8Array) {
        files.set(path, data);
      },
      async readFile(path: string) {
        return files.get(path);
      },
      async unlink(path: string) {
        files.delete(path);
      },
    };
    (nodeFs as Record<string, unknown>)["default"] = nodeFs;
    const moduleMap = { "node:fs": nodeFs };

    const result = await executeSandbox(
      "import fs from 'node:fs';\nfs.writeFileSync('/tmp/a', 'hello');\nconst text = fs.readFileSync('/tmp/a');\nfs.unlinkSync('/tmp/a');\nreturn { text, gone: !files.has('/tmp/a') };",
      {
        syntax: "typescript",
        bindings: { files },
        moduleMap,
        require: (id) => moduleMap[id as keyof typeof moduleMap],
      }
    );

    expect(result.success, result.error).toBe(true);
    expect(result.returnValue).toEqual({ text: "hello", gone: true });
  });

  it("never injects await into a nested synchronous helper while lifting outer fs calls", async () => {
    const files = new Map<string, string>();
    const links = new Map<string, string>();
    const nodeFs = {
      async writeFile(path: string, data: string) {
        files.set(path, data);
      },
      async symlink(target: string, path: string) {
        links.set(path, target);
      },
      async readFile(path: string) {
        return files.get(links.get(path) ?? path);
      },
    };
    (nodeFs as Record<string, unknown>)["default"] = nodeFs;
    const moduleMap = { "node:fs": nodeFs };

    const result = await executeSandbox(
      `import fs from "node:fs";
function cleanup(path: string) {
  try { if (fs.existsSync(path)) fs.unlinkSync(path); } catch {}
}
cleanup("/tmp/link");
fs.writeFileSync("/tmp/target", "ok");
fs.symlinkSync("/tmp/target", "/tmp/link", "file");
return fs.readFileSync("/tmp/link");`,
      {
        syntax: "typescript",
        moduleMap,
        require: (id) => moduleMap[id as keyof typeof moduleMap],
      }
    );

    expect(result.success, result.error).toBe(true);
    expect(result.returnValue).toBe("ok");
  });

  it("never injects await into an expression-bodied synchronous arrow", async () => {
    const nodeFs = {
      async writeFile() {},
    };
    (nodeFs as Record<string, unknown>)["default"] = nodeFs;
    const moduleMap = { "node:fs": nodeFs };

    const result = await executeSandbox(
      `import fs from "node:fs";
const write = () => fs.writeFileSync("/tmp/value", "ok");
return typeof write;`,
      {
        syntax: "typescript",
        moduleMap,
        require: (id) => moduleMap[id as keyof typeof moduleMap],
      }
    );

    expect(result.success, result.error).toBe(true);
    expect(result.returnValue).toBe("function");
  });

  it("accepts JavaScript syntax and lifts bare require('fs') calls", async () => {
    const files = new Map<string, string>();
    const fsModule = {
      async writeFile(path: string, data: string) {
        files.set(path, data);
      },
      async readFile(path: string) {
        return files.get(path);
      },
    };
    const moduleMap = { fs: fsModule };
    const result = await executeSandbox(
      `const fs = require("fs");
fs.writeFileSync("/tmp/a", "ok");
return fs.readFileSync("/tmp/a");`,
      {
        syntax: "javascript",
        moduleMap,
        require: (id) => moduleMap[id as keyof typeof moduleMap],
      }
    );

    expect(result.success, result.error).toBe(true);
    expect(result.returnValue).toBe("ok");
  });

  it("does not alter semicolons in a valid for header", async () => {
    const result = await executeSandbox(
      "let total = 0; for (let i = 0; i < 3; i++) total += i; return total;",
      { syntax: "typescript" }
    );

    expect(result).toMatchObject({ success: true, returnValue: 3 });
  });

  it("does not suggest npm imports for unavailable Node built-ins", async () => {
    const result = await executeSandbox(
      'import { spawn } from "node:child_process"; return spawn;',
      {
        syntax: "typescript",
      }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Node built-in module "node:child_process" is not available');
    expect(result.error).toContain("@workspace/runtime");
    expect(result.error).not.toContain("npm:latest");
    expect(result).toMatchObject({
      failureKind: "user-code",
      failureCode: "unsupported_node_module",
    });
  });

  it("classifies package build/link failures as infrastructure failures", async () => {
    const result = await executeSandbox(
      'import { answer } from "@workspace/broken"; return answer;',
      {
        syntax: "typescript",
        imports: { "@workspace/broken": "workspace:*" },
        loadImport: async () => {
          throw new Error("worker export uses an unsupported module feature");
        },
      }
    );

    expect(result).toMatchObject({
      success: false,
      error: "worker export uses an unsupported module feature",
      failureKind: "infrastructure",
      failureCode: "package_load_failed",
    });
  });

  it("keeps an invalid workspace build selector caller-correctable", async () => {
    const result = await executeSandbox(
      'import { answer } from "@workspace/example"; return answer;',
      {
        syntax: "typescript",
        imports: { "@workspace/example": "./packages/example/src/index.ts" },
        loadImport: async () => {
          throw Object.assign(new Error("Invalid build ref"), {
            errorKind: "application",
            code: "invalid_build_ref",
            errorData: {
              code: "invalid_build_ref",
              ref: "./packages/example/src/index.ts",
            },
          });
        },
      }
    );

    expect(result).toMatchObject({
      success: false,
      error: "Invalid build ref",
      failureKind: "user-code",
      failureCode: "invalid_build_ref",
      errorData: {
        code: "invalid_build_ref",
        ref: "./packages/example/src/index.ts",
      },
    });
  });

  it("keeps an unexpected managed-test package prompt caller-correctable", async () => {
    const result = await executeSandbox('import "typescript"; return "unreachable";', {
      syntax: "typescript",
      imports: { typescript: "npm:latest" },
      loadImport: async () => {
        throw Object.assign(new Error("Unexpected authority prompt in system test"), {
          errorKind: "application",
          code: "EUNEXPECTEDTESTPROMPT",
          errorData: {
            code: "EUNEXPECTEDTESTPROMPT",
            failureKind: "user-code",
          },
        });
      },
    });

    expect(result).toMatchObject({
      success: false,
      error: "Unexpected authority prompt in system test",
      failureKind: "user-code",
      failureCode: "EUNEXPECTEDTESTPROMPT",
    });
  });

  it("keeps a conflicting retained module execution caller-correctable", async () => {
    const result = await executeSandbox(
      'import { answer } from "@workspace/example"; return answer;',
      {
        syntax: "typescript",
        imports: { "@workspace/example": "workspace:packages/example/src/index.ts" },
        loadImport: async () => {
          throw Object.assign(new Error("Module is retained at another execution"), {
            errorKind: "application",
            code: "eval_module_execution_conflict",
            errorData: {
              code: "eval_module_execution_conflict",
              moduleSpecifier: "@workspace/example",
              failureKind: "user-code",
            },
          });
        },
      }
    );

    expect(result).toMatchObject({
      success: false,
      error: "Module is retained at another execution",
      failureKind: "user-code",
      failureCode: "eval_module_execution_conflict",
      errorData: {
        code: "eval_module_execution_conflict",
        moduleSpecifier: "@workspace/example",
        failureKind: "user-code",
      },
    });
  });

  it("loads a lazy panel-exposed module before workspace build fallback", async () => {
    const globals = globalThis as Record<string, unknown>;
    const moduleMap = globals["__vibestudioModuleMap__"] as Record<string, unknown>;
    const loaders = globals["__vibestudioModuleLoaders__"] as Record<
      string,
      () => Promise<unknown>
    >;
    const jsxRuntime = { marker: "host jsx runtime" };
    loaders["react/jsx-runtime"] = async () => {
      moduleMap["react/jsx-runtime"] = jsxRuntime;
      return jsxRuntime;
    };
    globals["__vibestudioRequireAsync__"] = async (id: string) => {
      const loaded = moduleMap[id] ?? (await loaders[id]?.());
      if (loaded === undefined) throw new Error(`Module "${id}" has no generated loader`);
      moduleMap[id] = loaded;
      return loaded;
    };
    const loadImport = vi.fn();

    const result = await executeSandbox(
      'import * as runtime from "react/jsx-runtime"; return runtime.marker;',
      {
        syntax: "typescript",
        imports: { "react/jsx-runtime": "latest" },
        loadImport,
      }
    );

    expect(result).toMatchObject({ success: true, returnValue: "host jsx runtime" });
    expect(loadImport).not.toHaveBeenCalled();
  });

  it("tracks build-loaded refs independently in each module registry", async () => {
    const firstModuleMap: Record<string, unknown> = {};
    const secondModuleMap: Record<string, unknown> = {};
    const loadImport = vi.fn(async (_specifier: string, ref: string | undefined) => ({
      bundle: `module.exports = { label: ${JSON.stringify(ref ?? "latest")} };`,
      format: "cjs" as const,
    }));
    const runWithRef = (moduleMap: Record<string, unknown>, ref: string) =>
      executeSandbox('import { label } from "versioned-lib"; return label;', {
        syntax: "typescript",
        imports: { "versioned-lib": ref },
        moduleMap,
        require: (id) => {
          if (id in moduleMap) return moduleMap[id];
          throw new Error(`Module not found: ${id}`);
        },
        loadImport,
      });

    await expect(runWithRef(firstModuleMap, "npm:1")).resolves.toMatchObject({
      success: true,
      returnValue: "npm:1",
    });
    await expect(runWithRef(secondModuleMap, "npm:2")).resolves.toMatchObject({
      success: true,
      returnValue: "npm:2",
    });
    await expect(runWithRef(firstModuleMap, "npm:2")).resolves.toMatchObject({
      success: true,
      returnValue: "npm:2",
    });
    await expect(runWithRef(firstModuleMap, "npm:2")).resolves.toMatchObject({
      success: true,
      returnValue: "npm:2",
    });
    expect(loadImport.mock.calls.map(([, ref]) => ref)).toEqual(["npm:1", "npm:2", "npm:2"]);
  });

  it("does not mask a lazy exposed-chunk failure with build fallback", async () => {
    const globals = globalThis as Record<string, unknown>;
    const loaders = globals["__vibestudioModuleLoaders__"] as Record<
      string,
      () => Promise<unknown>
    >;
    loaders["react/jsx-runtime"] = async () => {
      throw new Error("exposed module chunk failed");
    };
    globals["__vibestudioRequireAsync__"] = (id: string) => loaders[id]!();
    const loadImport = vi.fn();

    const result = await executeSandbox('import "react/jsx-runtime"; return "unreachable";', {
      syntax: "typescript",
      imports: { "react/jsx-runtime": "latest" },
      loadImport,
    });

    expect(result).toMatchObject({
      success: false,
      error: "exposed module chunk failed",
      failureKind: "infrastructure",
      failureCode: "package_load_failed",
    });
    expect(loadImport).not.toHaveBeenCalled();
  });

  it("classifies an acquired package's initialization error as correctable user code", async () => {
    const result = await executeSandbox('import "@workspace/panel-only"; return "unreachable";', {
      syntax: "typescript",
      imports: { "@workspace/panel-only": "workspace:*" },
      loadImport: async () => ({
        format: "cjs",
        bundle:
          'throw new Error("This package requires a panel runtime global that is unavailable here");',
      }),
    });

    expect(result).toMatchObject({
      success: false,
      error: "This package requires a panel runtime global that is unavailable here",
      failureKind: "user-code",
      failureCode: "guest_execution_failed",
    });
  });

  it("keeps a structured invalid package subpath correctable", async () => {
    const result = await executeSandbox(
      'import panel from "@workspace/runtime/panel"; return panel;',
      {
        syntax: "typescript",
        imports: { "@workspace/runtime/panel": "workspace:*" },
        loadImport: async () => {
          throw Object.assign(new Error("No export ./panel found for @workspace/runtime"), {
            errorData: {
              code: "package_export_not_found",
              packageName: "@workspace/runtime",
              subpath: "./panel",
              conditions: ["worker", "workerd", "default"],
            },
          });
        },
      }
    );

    expect(result).toMatchObject({
      success: false,
      error: "No export ./panel found for @workspace/runtime",
      failureKind: "user-code",
      failureCode: "package_export_not_found",
    });
  });

  it("keeps guest exceptions distinct from infrastructure failures", async () => {
    const result = await executeSandbox('throw new Error("authored boom")', {
      syntax: "typescript",
    });

    expect(result).toMatchObject({
      success: false,
      error: "authored boom",
      failureKind: "user-code",
      failureCode: "guest_execution_failed",
    });
  });

  it("classifies guest TypeErrors as correctable code failures", async () => {
    const result = await executeSandbox("const cdp: any = {}; return cdp.evaluate();", {
      syntax: "typescript",
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("is not a function"),
      failureKind: "user-code",
      failureCode: "guest_type_error",
    });
  });

  it("classifies structured Durable Object schema refusals as infrastructure", async () => {
    const result = await executeSandbox(
      `const error = new Error("ExampleStore cannot open persisted schema v1 with build schema v2");
       error.code = "DO_SCHEMA_INCOMPATIBLE";
       error.errorKind = "service";
       error.errorData = {
         reason: "migration-missing",
         persistedVersion: 1,
         targetVersion: 2,
         safeActions: ["add-migration", "reset-storage"]
       };
       throw error;`,
      { syntax: "typescript" }
    );

    expect(result).toMatchObject({
      success: false,
      failureKind: "infrastructure",
      failureCode: "DO_SCHEMA_INCOMPATIBLE",
      errorData: {
        reason: "migration-missing",
        persistedVersion: 1,
        targetVersion: 2,
      },
    });
  });

  it("preserves structured guest failure data for agent-facing diagnostics", async () => {
    const result = await executeSandbox(
      `const error = new Error("publication failed");
       error.errorData = {
         code: "scaffold_publication_failed",
         stage: "push",
         committedEventId: "event:committed",
         published: false
       };
       throw error;`,
      { syntax: "typescript" }
    );

    expect(result).toMatchObject({
      success: false,
      error: "publication failed",
      failureKind: "user-code",
      failureCode: "scaffold_publication_failed",
      errorData: {
        code: "scaffold_publication_failed",
        stage: "push",
        committedEventId: "event:committed",
        published: false,
      },
    });
    expect(result.consoleOutput).not.toContain("[eval] Error stack:");
  });

  it("retains stacks for unstructured guest exceptions", async () => {
    const result = await executeSandbox('throw new Error("authored boom")', {
      syntax: "typescript",
    });

    expect(result.consoleOutput).toContain("[eval] Error stack:");
  });

  it("honors a structured failure's declared cross-tool classification", async () => {
    const result = await executeSandbox(
      `const error = new Error("target connection closed");
       error.errorData = {
         code: "cdp_target_closed",
         failureKind: "infrastructure",
         recovery: "reacquire-page"
       };
       throw error;`,
      { syntax: "typescript" }
    );

    expect(result).toMatchObject({
      success: false,
      failureKind: "infrastructure",
      failureCode: "cdp_target_closed",
      errorData: {
        recovery: "reacquire-page",
      },
    });
  });

  it("classifies a generated scaffold build-gate failure as infrastructure", async () => {
    const result = await executeSandbox(
      `const error = new Error("publication failed");
       error.errorData = {
         code: "scaffold_publication_failed",
         stage: "push",
         committedEventId: "event:committed",
         published: false,
         vcsError: { code: "BuildGateFailed", errorData: { diagnostics: [] } }
       };
       throw error;`,
      { syntax: "typescript" }
    );

    expect(result).toMatchObject({
      success: false,
      failureKind: "infrastructure",
      failureCode: "scaffold_publication_failed",
    });
  });

  it("classifies a closed scaffold approval rendezvous as infrastructure", async () => {
    const result = await executeSandbox(
      `const error = new Error("publication approval failed");
       error.errorData = {
         code: "scaffold_publication_failed",
         stage: "push",
         published: false,
         vcsError: {
           code: "EACQUIRE",
           errorData: {
             acquisition: { acquisitionId: "acq:1", pending: false },
             authorityFailure: { reasonCode: "approval-required" }
           }
         }
       };
       throw error;`,
      { syntax: "typescript" }
    );

    expect(result).toMatchObject({
      success: false,
      failureKind: "infrastructure",
      failureCode: "scaffold_publication_failed",
    });
  });

  it("exposes a lazy import loader to runtime helpers during eval", async () => {
    const result = await executeSandbox(
      "const loaded = await globalThis.__vibestudioLoadImport__('lazy-package', 'latest'); return loaded.answer;",
      {
        syntax: "typescript",
        loadImport: async (specifier, ref, externals) => {
          expect(specifier).toBe("lazy-package");
          expect(ref).toBeUndefined();
          expect(externals).toEqual([]);
          return { bundle: "module.exports = { answer: 42 };", format: "cjs" as const };
        },
      }
    );

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(42);
    expect((globalThis as Record<string, unknown>)["__vibestudioLoadImport__"]).toBeUndefined();
  });

  it("auto-loads an unscoped manifest-declared workspace unit", async () => {
    const resolveWorkspaceImport = vi.fn(async (specifier: string) => specifier === "local-worker");
    const loadImport = Object.assign(
      vi.fn(async (specifier: string, ref: string | undefined) => {
        expect(specifier).toBe("local-worker");
        expect(ref).toBeUndefined();
        return { bundle: "module.exports = { answer: 42 };", format: "cjs" as const };
      }),
      { resolveWorkspaceImport }
    );

    const result = await executeSandbox('import { answer } from "local-worker"; return answer;', {
      syntax: "typescript",
      loadImport,
    });

    expect(result).toMatchObject({ success: true, returnValue: 42 });
    expect(resolveWorkspaceImport).toHaveBeenCalledWith("local-worker");
    expect(loadImport).toHaveBeenCalledOnce();
  });

  it("keeps unknown npm packages on the explicit npm import path", async () => {
    const resolveWorkspaceImport = vi.fn(async () => false);
    const loadImport = Object.assign(vi.fn(), { resolveWorkspaceImport });

    const result = await executeSandbox('import pad from "left-pad"; return pad;', {
      syntax: "typescript",
      loadImport,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Module "left-pad" not available');
    expect(result.error).toContain('"left-pad":"npm:latest"');
    expect(result).toMatchObject({
      failureKind: "user-code",
      failureCode: "module_not_available",
    });
    expect(loadImport).not.toHaveBeenCalled();
  });

  it("maps a flat workspace alias to an already preloaded canonical module", async () => {
    const canonical = { answer: 42 };
    const moduleMap = { "@workspace/runtime": canonical };
    const loadImport = vi.fn();

    const result = await executeSandbox(
      'import { answer } from "@workspace-runtime"; return answer;',
      {
        syntax: "typescript",
        imports: { "@workspace-runtime": "workspace-runtime" },
        moduleMap,
        loadImport,
        require: (id) => moduleMap[id as keyof typeof moduleMap],
      }
    );

    expect(result).toMatchObject({ success: true, returnValue: 42 });
    expect(moduleMap["@workspace-runtime" as keyof typeof moduleMap]).toBe(canonical);
    expect(loadImport).not.toHaveBeenCalled();
  });
});
