/** First-class, context-exact build and test verification for coding agents. */
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";
import type { UnitBuildReportWire } from "@vibestudio/service-schemas/build";
import { sha256Hex } from "@vibestudio/content-addressing";
import type { AgentToolFailure } from "@workspace/agentic-protocol";
import type {
  TestExecutionResultV1,
  WorkspaceTestArtifactV1,
  WorkspaceTestPlan,
} from "@vibestudio/service-schemas/build";
import { encodeUtf8 } from "./portable-bytes.js";

const buildVerificationSchema = Type.Object(
  {
    operation: Type.Literal("build"),
    target: Type.String({
      minLength: 1,
      description:
        "Workspace unit name or path, for example packages/parser or panels/editor.",
    }),
  },
  { additionalProperties: false },
);

const testVerificationSchema = Type.Object(
  {
    operation: Type.Literal("test"),
    target: Type.String({
      minLength: 1,
      description: "Workspace unit path containing the tests.",
    }),
    file: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Optional test file path relative to target.",
      }),
    ),
    testName: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Optional Vitest test-name pattern.",
      }),
    ),
    suite: Type.Optional(
      Type.String({ minLength: 1, description: "Declared test-suite name." }),
    ),
  },
  { additionalProperties: false },
);

export const verifySchema = Type.Union([
  buildVerificationSchema,
  testVerificationSchema,
]);
export type VerifyToolInput =
  | { operation: "build"; target: string }
  | {
      operation: "test";
      target: string;
      suite?: string;
      file?: string;
      testName?: string;
    };

interface TestRunResult {
  runtime: "browser" | "workerd" | "native";
  artifactKey?: string;
  executionDigest?: string;
  summary: string;
  passed: number;
  failed: number;
  total: number;
  contextId: string;
  target: string;
  pattern: string;
  details: Array<{
    file: string;
    status: "pass" | "fail" | "skip";
    duration?: number;
    errors?: string[];
  }>;
}

export type VerifyToolDetails =
  | {
      operation: "build" | "test";
      target: string;
      status: "running";
    }
  | {
      operation: "build";
      target: string;
      status: UnitBuildReportWire["status"];
      report: UnitBuildReportWire;
      receipt: UnitVerificationReceiptV1;
      provenance: {
        ref: string;
        scope: "context-candidate";
        publication: "unchanged";
        liveRuntime: "unchanged";
      };
      truncatedDiagnostics: number;
      truncatedDiagnosticText: number;
      failure?: AgentToolFailure;
    }
  | {
      operation: "test";
      target: string;
      status: "passed" | "failed" | "no-tests";
      report: TestRunResult;
      receipt: UnitVerificationReceiptV1;
      truncatedFiles: number;
      truncatedErrors: number;
      failure?: AgentToolFailure;
    };

export interface UnitVerificationReceiptV1 {
  protocol: "unit-verification-receipt.v1";
  operation: "build" | "test";
  target: string;
  contextId: string;
  ref: string;
  stateHash: string;
  reportDigest: string;
  suite?: string;
  runtime?: "browser" | "workerd" | "native";
  artifactKey?: string | null;
  executionDigest?: string | null;
  reportRequest?: {
    method: "build.getBuildReport";
    args: [target: string, ref: string];
  };
  unit?: {
    repoPath: string;
    unitName?: string;
    kind: string;
  };
  status?: string;
  builds?: Array<{
    target: UnitBuildReportWire["builds"][number]["target"];
    buildKey: string | null;
  }>;
  diagnostics?: { total: number; retained: number; truncated: number };
}

const MAX_DIAGNOSTICS = 40;
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 2_000;
const MAX_DIAGNOSTIC_CONTEXT_CHARS = 1_000;
const MAX_TEST_FILES = 100;
const MAX_ERRORS_PER_FILE = 20;
const MAX_ERROR_CHARS = 4_000;

export function createVerifyTool(
  callMain: <T>(
    method: string,
    args: unknown[],
    signal?: AbortSignal,
  ) => Promise<T>,
  contextId: () => string,
  executeSandboxTest?: (
    artifact: WorkspaceTestArtifactV1,
    testName: string | undefined,
    signal?: AbortSignal,
  ) => Promise<TestExecutionResultV1>,
): AgentTool<typeof verifySchema, VerifyToolDetails> {
  return {
    name: "verify",
    label: "verify",
    description:
      'Build or test one workspace unit against this conversation\'s exact semantic working state. Use { operation:"build", target } for compiler/bundler diagnostics and { operation:"test", target, suite?, file?, testName? } for a manifest-declared browser, workerd, or native suite. A successful build verifies only a context candidate: it does not publish source or update a live panel, worker, or Durable Object. Browser and workerd code stays sandboxed; only an explicitly native suite can request native approval. This boundary materializes the exact context, returns bounded evidence, and never treats zero discovered tests as success.',
    parameters: verifySchema,
    execute: async (
      _toolCallId,
      input,
      signal,
      onUpdate,
    ): Promise<AgentToolResult<VerifyToolDetails>> => {
      if (signal?.aborted)
        throw signal.reason ?? new Error("Operation aborted");
      const command = input as VerifyToolInput;
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `${command.operation === "build" ? "Building" : "Testing"} ${command.target}…`,
          },
        ],
        details: {
          operation: command.operation,
          target: command.target,
          status: "running",
        },
      });
      if (command.operation === "build") {
        const exactContextId = contextId();
        const report = await callMain<UnitBuildReportWire>(
          "build.getBuildReport",
          [command.target, `ctx:${exactContextId}`],
          signal,
        );
        const bounded = boundBuildReport(report);
        const failed = report.status !== "ok";
        const receipt = buildVerificationReceipt(
          command.target,
          exactContextId,
          report,
          bounded,
        );
        const failure =
          report.status === "failed"
            ? verificationFailure({
                code: "build_verification_failed",
                message: `Build failed for ${command.target} with ${report.diagnostics.length} ${report.diagnostics.length === 1 ? "diagnostic" : "diagnostics"}.`,
                recovery: {
                  action: "repair-source",
                  instruction:
                    "This receipt already proves the current failure; do not rerun unchanged. Inspect details.report.diagnostics, or use details.receipt.reportRequest once when omitted diagnostics are required. Repair the source or dependencies, then rerun verify once with the same target.",
                },
              })
            : report.status === "skipped"
              ? verificationFailure({
                  code: "build_target_not_buildable",
                  message: `Build skipped for ${command.target} because it resolves to ${report.kind} content with no build targets.`,
                  retryPolicy: "correct-input",
                  recovery: {
                    action: "correct-request",
                    instruction:
                      "Use details.receipt.unit.repoPath to identify the requested content, then select the owning buildable unit before retrying.",
                  },
                })
              : undefined;
        return {
          content: [
            {
              type: "text",
              text: renderBuild(
                command.target,
                bounded.report,
                receipt.diagnostics!,
              ),
            },
          ],
          details: {
            operation: "build",
            target: command.target,
            status: report.status,
            report: bounded.report,
            receipt,
            provenance: {
              ref: `ctx:${exactContextId}`,
              scope: "context-candidate",
              publication: "unchanged",
              liveRuntime: "unchanged",
            },
            truncatedDiagnostics: bounded.truncatedDiagnostics,
            truncatedDiagnosticText: bounded.truncatedDiagnosticText,
            ...(failure ? { failure } : {}),
          },
          isError: failed,
        };
      }

      const exactContextId = contextId();
      const ref = `ctx:${exactContextId}`;
      const plan = await callMain<WorkspaceTestPlan>(
        "build.resolveTestSuite",
        [command.target, ref, command.suite],
        signal,
      );
      let report: TestRunResult;
      let artifactKey: string;
      let executionDigest: string;
      if (plan.runtime === "native") {
        executionDigest = sha256Hex(
          encodeUtf8(
            JSON.stringify({
              protocol: "native-test-execution.v1",
              stateHash: plan.stateHash,
              target: command.target,
              suite: plan.suite,
              file: command.file ?? null,
            }),
          ),
        );
        artifactKey = `native:${executionDigest}`;
        report = await callMain<TestRunResult>(
          "extensions.invoke",
          [
            "@workspace-extensions/test-runner",
            "runNative",
            [
              {
                target: command.target,
                suite: plan.suite,
                contextId: exactContextId,
                artifactKey,
                executionDigest,
                ...(command.file ? { fileFilter: command.file } : {}),
                ...(command.testName ? { testName: command.testName } : {}),
              },
            ],
          ],
          signal,
        );
        if (
          report.artifactKey !== artifactKey ||
          report.executionDigest !== executionDigest
        ) {
          throw new Error(
            "Native test adapter returned a mismatched execution identity",
          );
        }
      } else {
        if (!executeSandboxTest) {
          throw new Error(
            `No ${plan.runtime} test executor is installed for verify`,
          );
        }
        const artifact = await callMain<WorkspaceTestArtifactV1>(
          "build.getTestArtifact",
          [
            command.target,
            ref,
            {
              suite: plan.suite,
              ...(command.file ? { file: command.file } : {}),
            },
          ],
          signal,
        );
        const result = await executeSandboxTest(
          artifact,
          command.testName,
          signal,
        );
        artifactKey = artifact.artifactKey;
        executionDigest = artifact.execution.executionDigest;
        report = {
          runtime: plan.runtime,
          summary:
            result.status === "no-tests"
              ? "No tests matched the execution filter"
              : result.failed > 0
                ? `${result.failed} of ${result.passed + result.failed} tests failed`
                : `${result.passed} tests passed`,
          passed: result.passed,
          failed: result.failed,
          total: result.passed + result.failed,
          contextId: exactContextId,
          target: command.target,
          pattern: `${plan.suite} (${plan.runtime})`,
          details: result.files,
        };
      }
      const status =
        report.total === 0
          ? "no-tests"
          : report.failed > 0
            ? "failed"
            : "passed";
      const bounded = boundTestReport(report);
      const receipt: UnitVerificationReceiptV1 = {
        protocol: "unit-verification-receipt.v1",
        operation: "test",
        target: command.target,
        contextId: exactContextId,
        ref,
        stateHash: plan.stateHash,
        reportDigest: sha256Hex(encodeUtf8(JSON.stringify(report))),
        suite: plan.suite,
        runtime: plan.runtime,
        artifactKey,
        executionDigest,
        status,
      };
      const failure =
        status === "failed"
          ? verificationFailure({
              code: "test_verification_failed",
              message: `Tests failed for ${command.target}: ${report.failed} of ${report.total} failed.`,
              recovery: {
                action: "repair-source",
                instruction:
                  "Inspect details.report.details, repair the failing source or tests, then rerun verify once.",
              },
            })
          : status === "no-tests"
            ? verificationFailure({
                code: "no_tests_discovered",
                message: `No tests were discovered for ${command.target}.`,
                retryPolicy: "correct-input",
                recovery: {
                  action: "correct-request",
                  instruction:
                    "Inspect the unit's test files and correct target, file, or testName before retrying.",
                },
              })
            : undefined;
      return {
        content: [
          {
            type: "text",
            text: renderTests(command.target, bounded.report, status),
          },
        ],
        details: {
          operation: "test",
          target: command.target,
          status,
          report: bounded.report,
          receipt,
          truncatedFiles: bounded.truncatedFiles,
          truncatedErrors: bounded.truncatedErrors,
          ...(failure ? { failure } : {}),
        },
        isError: status !== "passed",
      };
    },
  };
}

function verificationFailure(input: {
  code: string;
  message: string;
  retryPolicy?: AgentToolFailure["retry"]["policy"];
  recovery: NonNullable<AgentToolFailure["recovery"]>;
}): AgentToolFailure {
  return {
    protocol: "agent-tool-failure.v1",
    code: input.code,
    kind: "domain",
    message: input.message,
    operation: "tool.verify",
    stage: "execute",
    retry: {
      policy: input.retryPolicy ?? "none",
      commandIdPolicy: "not-applicable",
    },
    recovery: input.recovery,
    causes: [{ role: "primary", code: input.code, message: input.message }],
  };
}

function buildVerificationReceipt(
  target: string,
  contextId: string,
  report: UnitBuildReportWire,
  bounded: ReturnType<typeof boundBuildReport>,
): UnitVerificationReceiptV1 {
  return {
    protocol: "unit-verification-receipt.v1",
    operation: "build",
    target,
    contextId,
    ref: `ctx:${contextId}`,
    stateHash: report.stateHash,
    reportRequest: {
      method: "build.getBuildReport",
      args: [target, `ctx:${contextId}`],
    },
    reportDigest: sha256Hex(encodeUtf8(JSON.stringify(report))),
    unit: {
      repoPath: report.repoPath,
      ...(report.unitName ? { unitName: report.unitName } : {}),
      kind: report.kind,
    },
    status: report.status,
    builds: report.builds.map((build) => ({
      target: build.target,
      buildKey: build.buildKey ?? null,
    })),
    diagnostics: {
      total: report.diagnostics.length,
      retained: bounded.report.diagnostics.length,
      truncated: bounded.truncatedDiagnostics,
    },
  };
}

function boundBuildReport(report: UnitBuildReportWire): {
  report: UnitBuildReportWire;
  truncatedDiagnostics: number;
  truncatedDiagnosticText: number;
} {
  let truncatedDiagnosticText = 0;
  const clamp = (
    value: string | undefined,
    limit: number,
  ): string | undefined => {
    if (value === undefined || value.length <= limit) return value;
    truncatedDiagnosticText += value.length - limit;
    return `${value.slice(0, limit)}… [truncated]`;
  };
  const diagnostics = report.diagnostics
    .slice(0, MAX_DIAGNOSTICS)
    .map((diagnostic) => {
      // Host-derived structured repairs are bounded by construction; the size
      // valve only guards a malformed oversized payload. Never rewrite repair
      // contents — a truncated edit instruction is worse than none.
      const repair = (diagnostic as { repair?: unknown }).repair;
      const repairOversized =
        repair !== undefined &&
        JSON.stringify(repair).length > MAX_DIAGNOSTIC_CONTEXT_CHARS;
      if (repairOversized)
        truncatedDiagnosticText += JSON.stringify(repair).length;
      return {
        ...diagnostic,
        message: clamp(diagnostic.message, MAX_DIAGNOSTIC_MESSAGE_CHARS)!,
        ...(diagnostic.lineText === undefined
          ? {}
          : {
              lineText: clamp(
                diagnostic.lineText,
                MAX_DIAGNOSTIC_CONTEXT_CHARS,
              ),
            }),
        ...(diagnostic.suggestion === undefined
          ? {}
          : {
              suggestion: clamp(
                diagnostic.suggestion,
                MAX_DIAGNOSTIC_CONTEXT_CHARS,
              ),
            }),
        ...(repairOversized ? { repair: undefined } : {}),
      };
    });
  const builds = report.builds.map((build) => ({
    ...build,
    diagnosticIndexes: build.diagnosticIndexes.filter(
      (index) => index < diagnostics.length,
    ),
  }));
  return {
    report: { ...report, diagnostics, builds },
    truncatedDiagnostics: Math.max(
      0,
      report.diagnostics.length - MAX_DIAGNOSTICS,
    ),
    truncatedDiagnosticText,
  };
}

function boundTestReport(report: TestRunResult): {
  report: TestRunResult;
  truncatedFiles: number;
  truncatedErrors: number;
} {
  let truncatedErrors = 0;
  const details = report.details.slice(0, MAX_TEST_FILES).map((file) => {
    const errors = file.errors ?? [];
    truncatedErrors += Math.max(0, errors.length - MAX_ERRORS_PER_FILE);
    return {
      ...file,
      ...(file.errors
        ? {
            errors: errors
              .slice(0, MAX_ERRORS_PER_FILE)
              .map((error) =>
                error.length <= MAX_ERROR_CHARS
                  ? error
                  : `${error.slice(0, MAX_ERROR_CHARS)}… [truncated]`,
              ),
          }
        : {}),
    };
  });
  return {
    report: { ...report, details },
    truncatedFiles: Math.max(0, report.details.length - MAX_TEST_FILES),
    truncatedErrors,
  };
}

function renderBuild(
  target: string,
  report: UnitBuildReportWire,
  diagnostics: NonNullable<UnitVerificationReceiptV1["diagnostics"]>,
): string {
  const diagnosticSummary =
    diagnostics.total === diagnostics.retained
      ? `${diagnostics.total} diagnostic${diagnostics.total === 1 ? "" : "s"}`
      : `${diagnostics.total} diagnostics; ${diagnostics.retained} retained`;
  return (
    `Build ${report.status} for ${target} (${report.kind}; ` +
    `${report.builds.length} target${report.builds.length === 1 ? "" : "s"}; ` +
    `${diagnosticSummary}). ` +
    "This verifies a context candidate only; protected main and every live runtime remain unchanged. " +
    "Structured diagnostics are in details.report.diagnostics; exact reusable evidence and the full-report request are in details.receipt." +
    (report.status === "failed" ? " Do not rerun this unchanged build." : "")
  );
}

function renderTests(
  target: string,
  report: TestRunResult,
  status: "passed" | "failed" | "no-tests",
): string {
  const errors = report.details.flatMap((file) =>
    (file.errors ?? []).map((error) => `${file.file}: ${error}`),
  );
  return [
    status === "no-tests"
      ? `No tests were discovered for ${target}; verification did not pass.`
      : `Tests ${status} for ${target} in ${report.runtime}: ${report.passed} passed, ${report.failed} failed, ${report.total} total.`,
    ...errors,
  ].join("\n");
}
