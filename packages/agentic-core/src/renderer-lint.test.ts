import { describe, expect, it } from "vitest";
import { lintRendererSource } from "./renderer-lint.js";

describe("lintRendererSource", () => {
  it("accepts host modules, declared imports, relative and type-only imports", () => {
    const code = `
import { Flex } from "@radix-ui/themes";
import { useState } from "react";
import dayjs from "dayjs";
import type { CardState } from "@workspace/example-card/reducer";
import { type A, type B } from "@workspace/example-card/types";
import { helper } from "./helper";
// import { ghost } from "commented-out";
export default function Card() { return null; }
`;
    expect(lintRendererSource(code, { imports: { dayjs: "npm:^1" } })).toEqual([]);
  });

  it("flags value imports of undeclared workspace packages", () => {
    const code = `import { reduce } from "@workspace/example-card/reducer";`;
    const issues = lintRendererSource(code);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.specifier).toBe("@workspace/example-card/reducer");
    expect(issues[0]!.message).toMatch(/build-service round trip/);
  });

  it("flags bare npm imports not in the registration imports", () => {
    const issues = lintRendererSource(`import lodash from "lodash";`);
    expect(issues.map((issue) => issue.specifier)).toEqual(["lodash"]);
  });

  it("does not confuse expression code containing a 'from' key with imports", () => {
    const code = `
import { Flex } from "@radix-ui/themes";
export default function Card() {
  const rule = { field: "from", op: "contains", value: "alice" };
  const exportable = [{ from: "x" }];
  return null;
}
`;
    expect(lintRendererSource(code)).toEqual([]);
  });

  it("flags re-export sources too", () => {
    const issues = lintRendererSource(`export { reduce } from "@workspace/other/mod";`);
    expect(issues.map((issue) => issue.specifier)).toEqual(["@workspace/other/mod"]);
  });

  it("flags dynamic relative imports that the file loader cannot bundle", () => {
    const issues = lintRendererSource(`const helper = await import("./helper");`);
    expect(issues).toEqual([
      {
        specifier: "./helper",
        message:
          'Dynamic relative import "./helper" is not supported by file-loaded sandbox renderers. ' +
          "Use a static relative import so the local module is bundled before render.",
      },
    ]);
  });
});
