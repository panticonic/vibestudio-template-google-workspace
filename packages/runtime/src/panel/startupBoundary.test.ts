import { build } from "esbuild";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN_EAGER_INPUTS = [
  "/ajv/",
  "packages/shared/src/stateArgsValidator.ts",
  "packages/shell-core/src/panelManager.ts",
  "packages/service-schemas/src/runtime.ts",
  "packages/service-schemas/src/workspace.ts",
  "packages/service-schemas/src/workspaceSource.ts",
  "node_modules/buffer/index.js",
] as const;

/** Follow only static edges; deferred chunks are intentionally outside startup. */
function staticInputs(
  inputs: NonNullable<Awaited<ReturnType<typeof build>>["metafile"]>["inputs"],
  entry: string,
): Set<string> {
  const found = new Set<string>();
  const visit = (input: string) => {
    if (found.has(input)) return;
    found.add(input);
    for (const dependency of inputs[input]?.imports ?? []) {
      if (!dependency.external && dependency.kind !== "dynamic-import")
        visit(dependency.path);
    }
  };
  visit(entry);
  return found;
}

describe("panel runtime startup boundary", () => {
  it("keeps host-only implementations and deferred validators out of every panel startup", async () => {
    const repositoryRoot = process.env["VIBESTUDIO_HOST_ROOT"];
    if (!repositoryRoot)
      throw new Error("VIBESTUDIO_HOST_ROOT is required for exact-pair tests");
    const projectedNodeModules =
      process.env["VIBESTUDIO_USERLAND_NODE_MODULES"];
    if (!projectedNodeModules) {
      throw new Error(
        "VIBESTUDIO_USERLAND_NODE_MODULES is required for exact-pair tests",
      );
    }
    const entryPoint = new URL("./index.ts", import.meta.url).pathname;
    const result = await build({
      absWorkingDir: repositoryRoot,
      entryPoints: [entryPoint],
      bundle: true,
      splitting: true,
      write: false,
      metafile: true,
      outdir: "/virtual-panel-runtime-build",
      format: "esm",
      platform: "browser",
      target: "es2022",
      conditions: ["vibestudio-panel", "browser", "import", "default"],
      alias: {
        "@workspace/agentic-protocol/stored-values": path.join(
          process.env["VIBESTUDIO_USERLAND_ROOT"]!,
          "packages/agentic-protocol/src/stored-values.ts",
        ),
      },
      nodePaths: [
        path.join(repositoryRoot, "node_modules"),
        projectedNodeModules,
      ],
      external: ["fs", "path", "crypto", "node:*"],
    });
    const entry = Object.values(result.metafile!.outputs)
      .map((output) => output.entryPoint)
      .find(
        (candidate) =>
          candidate !== undefined &&
          path.resolve(repositoryRoot, candidate) === entryPoint,
      );
    expect(entry).toBeDefined();
    const eager = [...staticInputs(result.metafile!.inputs, entry!)];
    for (const forbidden of FORBIDDEN_EAGER_INPUTS) {
      expect(
        eager.filter((input) => input.includes(forbidden)),
        forbidden,
      ).toEqual([]);
    }
  });
});
