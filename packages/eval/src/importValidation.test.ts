import { describe, expect, it } from "vitest";
import {
  parseStaticImports,
  assertNoPreInjectedImports,
  assertNamedExportsExist,
} from "./importValidation.js";

describe("parseStaticImports", () => {
  it("parses named, default, namespace, and inline-type clauses", () => {
    const code = `
      import { a, b as c, type D } from "mod-a";
      import def from "mod-b";
      import def2, { e } from "mod-c";
      import * as ns from "mod-d";
      import type { Erased } from "mod-e";
      import "side-effect";
    `;
    const imports = parseStaticImports(code);
    const bySpec = Object.fromEntries(imports.map((i) => [i.specifier, i]));

    expect(bySpec["mod-a"]?.named).toEqual(["a", "b"]); // imported names, inline type skipped
    expect(bySpec["mod-b"]?.hasDefault).toBe(true);
    expect(bySpec["mod-c"]).toMatchObject({ hasDefault: true, named: ["e"] });
    expect(bySpec["mod-d"]?.hasNamespace).toBe(true);
    expect(bySpec["mod-e"]).toBeUndefined(); // whole-statement `import type` ignored
  });

  it("parses re-export declarations with named runtime exports", () => {
    const imports = parseStaticImports(`
      export { reportStage as report } from "@workspace-skills/system-testing";
      export type { Erased } from "@workspace-skills/types";
      export * from "@workspace-skills/all";
    `);

    expect(imports).toEqual([
      {
        specifier: "@workspace-skills/system-testing",
        named: ["reportStage"],
        hasDefault: false,
        hasNamespace: false,
      },
      {
        specifier: "@workspace-skills/all",
        named: [],
        hasDefault: false,
        hasNamespace: false,
      },
    ]);
  });

  it("ignores import-looking text in comments, strings, and templates", () => {
    const imports = parseStaticImports(`
      // import { scope } from "@workspace/runtime";
      /* import { missing } from "@workspace-skills/system-testing"; */
      const a = 'import { chat } from "@workspace/runtime"';
      const b = \`export { nope } from "@workspace/nope"\`;
      import { contextId } from "@workspace/runtime";
    `);

    expect(imports.map((imp) => imp.specifier)).toEqual(["@workspace/runtime"]);
    expect(imports[0]?.named).toEqual(["contextId"]);
  });

  it("ignores dynamic import and import.meta", () => {
    const imports = parseStaticImports(`
      await import("@workspace/runtime");
      console.log(import.meta.url);
      import { rpc } from "@workspace/runtime";
    `);

    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ specifier: "@workspace/runtime", named: ["rpc"] });
  });
});

describe("assertNoPreInjectedImports (#1)", () => {
  it("throws when a pre-injected global is imported from @workspace/runtime", () => {
    expect(() =>
      assertNoPreInjectedImports(`import { scopes } from "@workspace/runtime";`)
    ).toThrow(/pre-injected/i);
    expect(() =>
      assertNoPreInjectedImports(`import { contextId, scope } from "@workspace/runtime";`)
    ).toThrow(/scope/);
  });

  it("allows an ambient compatibility import when the live runtime module exports it", () => {
    expect(() =>
      assertNoPreInjectedImports(`import { help } from "@workspace/runtime";`, {
        help: async () => ({}),
      })
    ).not.toThrow();
  });

  it("allows legitimate runtime imports and ambient usage", () => {
    expect(() =>
      assertNoPreInjectedImports(
        `import { contextId, rpc } from "@workspace/runtime";\nawait scopes.push();`
      )
    ).not.toThrow();
    // type-only import of a same-named symbol is erased, not an offender
    expect(() =>
      assertNoPreInjectedImports(`import type { scope } from "@workspace/runtime";`)
    ).not.toThrow();
  });

  it("does not reject code samples mentioning pre-injected imports", () => {
    expect(() =>
      assertNoPreInjectedImports(`
      // import { scopes } from "@workspace/runtime";
      const docs = "import { scope } from '@workspace/runtime'";
      await scopes.push();
    `)
    ).not.toThrow();
  });
});

describe("assertNamedExportsExist (#2)", () => {
  const resolve = (spec: string) =>
    spec === "@workspace-skills/system-testing"
      ? { allTests: () => [], reportStage: () => {}, default: {} }
      : spec === "@workspace/runtime"
        ? { contextId: "x", rpc: {} }
        : undefined;

  it("throws with the available list when a workspace export is missing", () => {
    expect(() =>
      assertNamedExportsExist(
        `import { allTest } from "@workspace-skills/system-testing";`,
        resolve
      )
    ).toThrow(/not exported.*Available: allTests, reportStage/s);
  });

  it("passes when all named imports exist", () => {
    expect(() =>
      assertNamedExportsExist(
        `import { allTests, reportStage } from "@workspace-skills/system-testing";`,
        resolve
      )
    ).not.toThrow();
  });

  it("skips non-workspace specifiers and unresolved/namespace imports", () => {
    expect(() =>
      assertNamedExportsExist(`import { whatever } from "lodash";`, resolve)
    ).not.toThrow();
    expect(() =>
      assertNamedExportsExist(`import * as st from "@workspace-skills/system-testing";`, resolve)
    ).not.toThrow();
    expect(() =>
      assertNamedExportsExist(`import { x } from "@workspace/not-loaded";`, resolve)
    ).not.toThrow();
  });
});
