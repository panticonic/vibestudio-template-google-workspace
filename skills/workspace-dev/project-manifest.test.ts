import { describe, expect, it } from "vitest";

import {
  ProjectPreflightError,
  buildProjectManifest,
  preflightProjectFiles,
} from "./project-manifest.js";

function workerFiles(
  source: string,
  options: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    testSource?: string;
  } = {}
): Record<string, string> {
  return {
    "package.json": `${JSON.stringify(
      buildProjectManifest({
        projectType: "worker",
        name: "example",
        title: "Example",
        entry: "index.ts",
        durableClasses: ["ExampleWorker"],
        dependencies: options.dependencies,
        devDependencies: options.devDependencies,
      }),
      null,
      2
    )}\n`,
    "index.ts": source,
    ...(options.testSource === undefined ? {} : { "index.test.ts": options.testSource }),
  };
}

describe("project dependency preflight", () => {
  it("returns file-level structured remediation for a missing production dependency", () => {
    const failure = (() => {
      try {
        preflightProjectFiles({
          projectType: "worker",
          name: "example",
          files: workerFiles('import { rpcErrorDataOf } from "@vibestudio/rpc";'),
        });
      } catch (error) {
        return error;
      }
      return null;
    })();

    expect(failure).toBeInstanceOf(ProjectPreflightError);
    expect((failure as ProjectPreflightError).errorData).toMatchObject({
      code: "project_preflight_failed",
      stage: "dependency-contract",
      projectType: "worker",
      projectName: "example",
      issues: [
        {
          code: "dependency_missing",
          coordinate: "@vibestudio/rpc",
          expectedField: "dependencies",
          declaredField: null,
          occurrences: [
            {
              file: "index.ts",
              specifier: "@vibestudio/rpc",
              kind: "value",
              syntax: "import",
              line: 1,
            },
          ],
        },
      ],
    });
  });

  it("distinguishes production dependencies from test-only dependencies", () => {
    expect(() =>
      preflightProjectFiles({
        projectType: "worker",
        name: "example",
        files: workerFiles('import "production-package";', {
          dependencies: { "production-package": "^1.0.0" },
          devDependencies: { vitest: "^3.2.2" },
          testSource: 'import { describe } from "vitest"; void describe;',
        }),
      })
    ).not.toThrow();

    expect(() =>
      preflightProjectFiles({
        projectType: "worker",
        name: "example",
        files: workerFiles('import "production-package";', {
          devDependencies: { "production-package": "^1.0.0" },
        }),
      })
    ).toThrowError(
      expect.objectContaining({
        errorData: expect.objectContaining({
          issues: [
            expect.objectContaining({
              code: "dependency_wrong_field",
              expectedField: "dependencies",
              declaredField: "devDependencies",
            }),
          ],
        }),
      })
    );
  });

  it("accepts DefinitelyTyped declarations for type-only imports and ignores built-ins", () => {
    expect(() =>
      preflightProjectFiles({
        projectType: "worker",
        name: "example",
        files: workerFiles(
          [
            'import type { Root } from "mdast";',
            'import { readFile } from "node:fs/promises";',
            'import { join } from "path";',
            "void readFile; void join;",
          ].join("\n"),
          { dependencies: { "@types/mdast": "^4.0.4" } }
        ),
      })
    ).not.toThrow();
  });

  it("does not treat embedded source examples as dependency declarations", () => {
    const report = preflightProjectFiles({
      projectType: "worker",
      name: "example",
      files: workerFiles(
        [
          'const example = "import fake from \\"not-a-package\\"";',
          'const template = `require("also-not-a-package")`;',
          "void example; void template;",
        ].join("\n")
      ),
    });

    expect(report.importedPackages).toEqual([]);
  });

  it("parses Svelte script regions and ignores non-module repository text", () => {
    const files = workerFiles('import "production-package";', {
      dependencies: {
        "production-package": "^1.0.0",
        "svelte-package": "^1.0.0",
      },
    });
    files["Component.svelte"] = [
      '<script lang="ts">',
      '  import value from "svelte-package";',
      "  const count: number = 1;",
      "</script>",
      "<div>{count} {value}</div>",
    ].join("\n");
    files["README.md"] = 'Documentation can say import fake from "not-a-package".';
    files["style.css"] = '@import "also-not-a-package";';

    const report = preflightProjectFiles({
      projectType: "worker",
      name: "example",
      files,
    });

    expect(report.importedPackages).toEqual(["production-package", "svelte-package"]);
  });

  it("rejects undeclared dependencies imported from template interpolation", () => {
    expect(() =>
      preflightProjectFiles({
        projectType: "worker",
        name: "example",
        files: workerFiles(
          'const loaded = `module: ${import("interpolated-package")}`; void loaded;'
        ),
      })
    ).toThrowError(
      expect.objectContaining({
        errorData: expect.objectContaining({
          issues: [
            expect.objectContaining({
              code: "dependency_missing",
              coordinate: "interpolated-package",
              expectedField: "dependencies",
            }),
          ],
        }),
      })
    );
  });
});
