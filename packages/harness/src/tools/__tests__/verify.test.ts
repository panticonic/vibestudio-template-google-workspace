import { describe, expect, it, vi } from "vitest";
import type { UnitBuildReportWire } from "@vibestudio/service-schemas/build";
import { createVerifyTool } from "../verify.js";

function rpcResult<T>(value: T) {
  const calls = vi.fn();
  return {
    calls,
    callMain: async <R>(
      method: string,
      args: unknown[],
      signal?: AbortSignal,
    ) => {
      calls(method, args, signal);
      return value as unknown as R;
    },
  };
}

describe("context-exact verify tool", () => {
  it("builds the current semantic context and reports success", async () => {
    const { callMain, calls } = rpcResult({
      stateHash: `state:${"b".repeat(64)}`,
      repoPath: "packages/parser",
      unitName: "@workspace/parser",
      kind: "package",
      status: "ok" as const,
      diagnostics: [],
      builds: [
        {
          target: "library:worker" as const,
          buildKey: "a".repeat(64),
          diagnosticIndexes: [],
        },
      ],
    });
    const controller = new AbortController();
    const tool = createVerifyTool(callMain, () => "context-7");

    const result = await tool.execute(
      "call-build",
      { operation: "build", target: "packages/parser" },
      controller.signal,
    );

    expect(calls).toHaveBeenCalledWith(
      "build.getBuildReport",
      ["packages/parser", "ctx:context-7"],
      controller.signal,
    );
    expect(result.isError).toBe(false);
    expect(result.details).toMatchObject({
      operation: "build",
      status: "ok",
      receipt: {
        protocol: "unit-verification-receipt.v1",
        operation: "build",
        stateHash: `state:${"b".repeat(64)}`,
        target: "packages/parser",
        contextId: "context-7",
        ref: "ctx:context-7",
        reportRequest: {
          method: "build.getBuildReport",
          args: ["packages/parser", "ctx:context-7"],
        },
        reportDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        unit: {
          repoPath: "packages/parser",
          unitName: "@workspace/parser",
          kind: "package",
        },
        status: "ok",
        builds: [{ target: "library:worker", buildKey: "a".repeat(64) }],
        diagnostics: { total: 0, retained: 0, truncated: 0 },
      },
      provenance: {
        ref: "ctx:context-7",
        scope: "context-candidate",
        publication: "unchanged",
        liveRuntime: "unchanged",
      },
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        "protected main and every live runtime remain unchanged",
      ),
    });
  });

  it("publishes an immediate running update before waiting for verification", async () => {
    let release!: (value: UnitBuildReportWire) => void;
    const pending = new Promise<UnitBuildReportWire>((resolve) => {
      release = resolve;
    });
    const callMain = async <T>(): Promise<T> => (await pending) as T;
    const updates: unknown[] = [];
    const execution = createVerifyTool(callMain, () => "context-7").execute(
      "call-progress",
      { operation: "build", target: "packages/example" },
      undefined,
      (update) => updates.push(update),
    );

    expect(updates).toEqual([
      {
        content: [{ type: "text", text: "Building packages/example…" }],
        details: {
          operation: "build",
          target: "packages/example",
          status: "running",
        },
      },
    ]);

    release({
      stateHash: `state:${"b".repeat(64)}`,
      repoPath: "packages/example",
      kind: "package",
      status: "ok",
      diagnostics: [],
      builds: [],
    });
    await expect(execution).resolves.toMatchObject({ isError: false });
  });

  it("keeps structured build diagnostics while marking a failed build as an error", async () => {
    const { callMain } = rpcResult({
      stateHash: `state:${"b".repeat(64)}`,
      repoPath: "panels/editor",
      kind: "panel",
      status: "failed" as const,
      diagnostics: [
        {
          source: "tsc" as const,
          severity: "error" as const,
          file: "panels/editor/index.tsx",
          line: 4,
          column: 9,
          message: "Cannot find name 'missing'",
        },
      ],
      builds: [{ target: "runtime" as const, diagnosticIndexes: [0] }],
    });
    const result = await createVerifyTool(callMain, () => "context-7").execute(
      "call-build",
      {
        operation: "build",
        target: "panels/editor",
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("1 diagnostic"),
    });
    expect((result.content[0] as { text: string }).text).not.toContain(
      "Cannot find name",
    );
    expect((result.content[0] as { text: string }).text).toContain(
      "Do not rerun this unchanged build.",
    );
    expect(result.details).toMatchObject({
      operation: "build",
      report: { diagnostics: [{ source: "tsc", severity: "error" }] },
      failure: {
        protocol: "agent-tool-failure.v1",
        code: "build_verification_failed",
        kind: "domain",
        message: "Build failed for panels/editor with 1 diagnostic.",
        operation: "tool.verify",
        recovery: { action: "repair-source" },
      },
    });
    const failure = (result.details as { failure?: Record<string, unknown> })
      .failure;
    expect(failure).not.toHaveProperty("data");
    expect(failure).not.toHaveProperty("report");
    expect(failure).not.toHaveProperty("receipt");
    expect(JSON.stringify(result)).not.toContain("[object Object]");
  });

  it("passes host-derived structured repairs through the diagnostic bounds untouched", async () => {
    const repair = {
      code: "missing-authority-request",
      file: "panels/editor/package.json",
      field: "vibestudio.authority.requests",
      request: {
        capability: "workspace-service:notes",
        resource: { kind: "exact", key: "do:workers/notes:NotesDO:main" },
        tier: "gated",
        evidence: "exact",
      },
      docsId: "workspace:notes",
    };
    const { callMain } = rpcResult({
      stateHash: `state:${"b".repeat(64)}`,
      repoPath: "panels/editor",
      kind: "panel",
      status: "failed" as const,
      diagnostics: [
        {
          source: "authority" as const,
          severity: "error" as const,
          file: "panels/editor/index.tsx",
          line: 4,
          column: 9,
          message:
            "Calling notes.delete requires 'workspace-service:notes' at gated tier",
          repair,
        } as never,
      ],
      builds: [{ target: "runtime" as const, diagnosticIndexes: [0] }],
    });
    const result = await createVerifyTool(callMain, () => "context-7").execute(
      "call-build",
      {
        operation: "build",
        target: "panels/editor",
      },
    );

    const report = (
      result.details as { report: { diagnostics: Array<{ repair?: unknown }> } }
    ).report;
    expect(report.diagnostics[0]!.repair).toEqual(repair);
  });

  it("classifies a skipped content target as a correctable request", async () => {
    const { callMain } = rpcResult({
      stateHash: `state:${"b".repeat(64)}`,
      repoPath: "packages/docs",
      kind: "content",
      status: "skipped" as const,
      diagnostics: [],
      builds: [],
    });

    const result = await createVerifyTool(callMain, () => "context-7").execute(
      "call-build",
      {
        operation: "build",
        target: "packages/docs",
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Build skipped for packages/docs"),
    });
    expect(result.details).toMatchObject({
      status: "skipped",
      failure: {
        code: "build_target_not_buildable",
        kind: "domain",
        retry: { policy: "correct-input" },
        recovery: { action: "correct-request" },
      },
    });
  });

  it("bounds the one canonical diagnostic array and remaps target references", async () => {
    const diagnostics = Array.from({ length: 45 }, (_, index) => ({
      source: "tsc" as const,
      severity: "error" as const,
      file: `panels/editor/file-${index}.ts`,
      line: index + 1,
      column: 1,
      message: index === 0 ? "x".repeat(3_000) : `failure ${index}`,
    }));
    const { callMain } = rpcResult({
      stateHash: `state:${"b".repeat(64)}`,
      repoPath: "panels/editor",
      kind: "panel",
      status: "failed" as const,
      diagnostics,
      builds: [
        { target: "runtime" as const, diagnosticIndexes: [0, 39, 40, 44] },
      ],
    });

    const result = await createVerifyTool(callMain, () => "context-7").execute(
      "call-build",
      {
        operation: "build",
        target: "panels/editor",
      },
    );

    expect(result.details).toMatchObject({
      truncatedDiagnostics: 5,
      truncatedDiagnosticText: 1_000,
      receipt: {
        diagnostics: { total: 45, retained: 40, truncated: 5 },
      },
      report: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringMatching(/\[truncated\]$/u),
          }),
        ]),
        builds: [{ target: "runtime", diagnosticIndexes: [0, 39] }],
      },
    });
    expect(
      (result.details as { report: UnitBuildReportWire }).report.diagnostics,
    ).toHaveLength(40);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("45 diagnostics; 40 retained"),
    });
  });

  it("runs one focused browser selection without reaching the native extension", async () => {
    const calls = vi.fn();
    const callMain = async <T>(method: string, args: unknown[]) => {
      calls(method, args);
      if (method === "build.resolveTestSuite") {
        return {
          protocol: "workspace-test-plan.v1",
          target: "packages/parser",
          suite: "unit",
          runtime: "browser",
          stateHash: `state:${"a".repeat(64)}`,
        } as T;
      }
      return {
        protocol: "workspace-test-artifact.v1",
        artifactKey: "b".repeat(64),
        target: "packages/parser",
        suite: "unit",
        runtime: "browser",
        selectedFiles: ["parser.test.ts"],
        bundle: "",
        format: "async-cjs",
        execution: { executionDigest: "c".repeat(64) },
      } as T;
    };
    const executeSandboxTest = vi.fn(async () => ({
      protocol: "workspace-test-execution-result.v1" as const,
      artifactKey: "b".repeat(64),
      executionDigest: "c".repeat(64),
      runtime: "browser" as const,
      status: "passed" as const,
      passed: 1,
      failed: 0,
      skipped: 0,
      durationMs: 2,
      files: [{ file: "parser.test.ts", status: "pass" as const }],
    }));
    const result = await createVerifyTool(
      callMain,
      () => "context-7",
      executeSandboxTest,
    ).execute("call-test", {
      operation: "test",
      target: "packages/parser",
      file: "parser.test.ts",
      testName: "parses empty input",
    });

    expect(calls).toHaveBeenCalledWith("build.resolveTestSuite", [
      "packages/parser",
      "ctx:context-7",
      undefined,
    ]);
    expect(calls).toHaveBeenCalledWith("build.getTestArtifact", [
      "packages/parser",
      "ctx:context-7",
      { suite: "unit", file: "parser.test.ts" },
    ]);
    expect(
      calls.mock.calls.some(([method]) => method === "extensions.invoke"),
    ).toBe(false);
    expect(executeSandboxTest).toHaveBeenCalledOnce();
    expect(result.isError).toBe(false);
    expect(result.details).toMatchObject({
      operation: "test",
      status: "passed",
    });
  });

  it("does not present zero discovered tests as successful verification", async () => {
    const callMain = async <T>(method: string) =>
      (method === "build.resolveTestSuite"
        ? {
            protocol: "workspace-test-plan.v1",
            target: "packages/parser",
            suite: "unit",
            runtime: "workerd",
            stateHash: `state:${"a".repeat(64)}`,
          }
        : {
            protocol: "workspace-test-artifact.v1",
            artifactKey: "b".repeat(64),
            target: "packages/parser",
            suite: "unit",
            runtime: "workerd",
            selectedFiles: ["parser.test.ts"],
            bundle: "",
            format: "async-cjs",
            execution: { executionDigest: "c".repeat(64) },
          }) as T;
    const result = await createVerifyTool(
      callMain,
      () => "context-7",
      async () => ({
        protocol: "workspace-test-execution-result.v1",
        artifactKey: "b".repeat(64),
        executionDigest: "c".repeat(64),
        runtime: "workerd",
        status: "no-tests",
        passed: 0,
        failed: 0,
        skipped: 0,
        durationMs: 1,
        files: [],
      }),
    ).execute("call-test", { operation: "test", target: "packages/parser" });

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      operation: "test",
      status: "no-tests",
      failure: {
        code: "no_tests_discovered",
        kind: "domain",
        retry: { policy: "correct-input" },
        recovery: { action: "correct-request" },
      },
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("verification did not pass"),
    });
  });
});
