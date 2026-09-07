import { describe, it, expect, afterEach } from "vitest";
import { execute, defaultCompileFunction, type CompileFunction } from "./execute.js";

/**
 * The realm seam: realms where `new Function` is blocked (the workerd EvalDO kernel)
 * inject a compiler — via `ExecuteOptions.compileFunction` or the `__vibestudioCompileFunction__`
 * global. The default stays native `new Function` so panels/CLI are unaffected.
 */
describe("compileFunction seam", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)["__vibestudioCompileFunction__"];
  });

  it("execute() routes through an injected compileFunction", () => {
    let captured: { argNames: string[]; body: string } | null = null;
    const compileFunction: CompileFunction = (argNames, body) => {
      captured = { argNames, body };
      // eslint-disable-next-line no-new-func
      return new Function(...argNames, body) as (...a: unknown[]) => unknown;
    };
    const result = execute("return 1 + 1;", { require: () => ({}), compileFunction });
    expect(result.returnValue).toBe(2);
    expect(captured).not.toBeNull();
    expect(captured!.argNames.slice(0, 4)).toEqual(["require", "exports", "module", "console"]);
    expect(captured!.body).toContain("return 1 + 1;");
  });

  it("defaultCompileFunction honors the __vibestudioCompileFunction__ global override", () => {
    let used = false;
    const override: CompileFunction = (argNames, body) => {
      used = true;
      // eslint-disable-next-line no-new-func
      return new Function(...argNames, body) as (...a: unknown[]) => unknown;
    };
    (globalThis as Record<string, unknown>)["__vibestudioCompileFunction__"] = override;
    const fn = defaultCompileFunction(["a"], "return a * 3;");
    expect(fn(7)).toBe(21);
    expect(used).toBe(true);
  });

  it("defaultCompileFunction falls back to native new Function without an override", () => {
    const fn = defaultCompileFunction(["a", "b"], "return a + b;");
    expect(fn(2, 3)).toBe(5);
  });
});
