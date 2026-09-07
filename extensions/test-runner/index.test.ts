import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activate } from "./index.js";

const cleanup: string[] = [];
const identity = {
  artifactKey: "native:test-artifact",
  executionDigest: "a".repeat(64),
};

function fixture(runtime: "browser" | "native" = "native") {
  const projections = fs.mkdtempSync(
    path.join(os.tmpdir(), "native-test-adapter-"),
  );
  cleanup.push(projections);
  const target = path.join(projections, "ctx-1", "packages", "fixture");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(target, "package.json"),
    JSON.stringify({
      name: "@workspace/fixture",
      vibestudio: {
        tests: [{ name: "unit", runtime, include: ["**/*.test.ts"] }],
      },
    }),
  );
  const ensureMaterialized = vi.fn(async () => undefined);
  return {
    target,
    ensureMaterialized,
    ctx: {
      workspace: {
        getInfo: async () => ({
          path: projections,
          contextProjectionsPath: projections,
        }),
      },
      fs: { ensureMaterialized },
      invocation: {
        current: () => ({ caller: { callerId: "agent", contextId: "ctx-1" } }),
      },
      log: { info: vi.fn() },
    },
  };
}

afterEach(() => {
  for (const directory of cleanup.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("native test adapter boundary", () => {
  it("rejects traversal before materialization", async () => {
    const { ctx, ensureMaterialized } = fixture();
    const api = await activate(ctx);
    await expect(
      api.runNative({ target: "../outside", suite: "unit", ...identity }),
    ).rejects.toThrow("contained workspace unit path");
    expect(ensureMaterialized).not.toHaveBeenCalled();
  });

  it("refuses a browser suite instead of falling back", async () => {
    const { ctx } = fixture("browser");
    const api = await activate(ctx);
    await expect(
      api.runNative({ target: "packages/fixture", suite: "unit", ...identity }),
    ).rejects.toThrow("fallback is forbidden");
  });

  it("requires the named suite to be declared", async () => {
    const { ctx } = fixture();
    const api = await activate(ctx);
    await expect(
      api.runNative({ target: "packages/fixture", suite: "missing", ...identity }),
    ).rejects.toThrow("Unknown declared test suite");
  });

  it("executes selected modules in a child using the installed test-engine dependencies", async () => {
    const { ctx, target } = fixture();
    fs.writeFileSync(
      path.join(target, "simple.test.ts"),
      'import { expect, it } from "vitest"; it("passes", () => expect(2 + 2).toBe(4));\n',
    );
    fs.writeFileSync(
      path.join(target, "unselected.test.ts"),
      'throw new Error("Unselected module must not execute");\n',
    );
    const api = await activate(ctx);
    const result = await api.runNative({
      target: "packages/fixture",
      suite: "unit",
      ...identity,
      fileFilter: "simple.test.ts",
    });
    expect(result).toMatchObject({ passed: 1, failed: 0, total: 1 });
  });
});
