import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export interface TestRunRequest {
  target: string;
  suite: string;
  contextId?: string;
  fileFilter?: string;
  testName?: string;
  artifactKey: string;
  executionDigest: string;
}

export interface TestRunResult {
  runtime: "native";
  artifactKey: string;
  executionDigest: string;
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

interface ExtensionContextLike {
  workspace: {
    getInfo(): Promise<{ path: string; contextProjectionsPath: string }>;
  };
  fs: { ensureMaterialized(scope: string | string[] | "all"): Promise<void> };
  invocation: {
    current(): {
      caller: { callerId: string; callerKind?: string; contextId?: string };
      chainCaller?: { contextId?: string };
    } | null;
  };
  log: { info(message: string, fields?: Record<string, unknown>): void };
}

interface JsonReport {
  numPassedTests?: number;
  numFailedTests?: number;
  numTotalTests?: number;
  testResults?: Array<{
    name: string;
    status: string;
    startTime?: number;
    endTime?: number;
    message?: string;
    assertionResults?: Array<{ failureMessages?: string[] }>;
  }>;
}

const WORKSPACE_ROOTS = new Set([
  "about",
  "apps",
  "extensions",
  "packages",
  "panels",
  "projects",
  "skills",
  "templates",
  "workers",
]);

function assertContextId(value: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value)) {
    throw new Error(`Invalid context ID: ${value}`);
  }
}

function assertTarget(value: string): void {
  const normalized = value.replace(/\\/gu, "/");
  const root = normalized.split("/")[0];
  if (
    !value ||
    path.isAbsolute(value) ||
    normalized.split("/").includes("..") ||
    !root ||
    !WORKSPACE_ROOTS.has(root)
  ) {
    throw new Error(`Target must be a contained workspace unit path: ${value}`);
  }
}

function within(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  const remainder = path.relative(root, resolved);
  if (remainder.startsWith("..") || path.isAbsolute(remainder)) {
    throw new Error(`Path escapes test root: ${relative}`);
  }
  return resolved;
}

function declaredNativeSuite(targetPath: string, name: string): string[] {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(targetPath, "package.json"), "utf8"),
  ) as {
    vibestudio?: {
      tests?: Array<{ name?: unknown; runtime?: unknown; include?: unknown }>;
    };
  };
  const suite = pkg.vibestudio?.tests?.find(
    (candidate) => candidate.name === name,
  );
  if (!suite)
    throw new Error(`Unknown declared test suite ${JSON.stringify(name)}`);
  if (suite.runtime !== "native") {
    throw new Error(
      `Native adapter refuses ${String(suite.runtime)} suite ${JSON.stringify(name)}; fallback is forbidden`,
    );
  }
  if (
    !Array.isArray(suite.include) ||
    !suite.include.every((value) => typeof value === "string")
  ) {
    throw new Error(
      `Native suite ${JSON.stringify(name)} has invalid include patterns`,
    );
  }
  return suite.include as string[];
}

function nodeModulesRoot(file: string): string {
  let cursor = path.dirname(file);
  while (path.dirname(cursor) !== cursor) {
    if (path.basename(cursor) === "node_modules") return cursor;
    cursor = path.dirname(cursor);
  }
  throw new Error(`Could not locate dependency root for ${file}`);
}

function nativeRunnerSource(input: {
  vitestNodeUrl: string;
  root: string;
  pattern: string;
  include: string[];
  testName?: string;
  reportPath: string;
}): string {
  return `
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startVitest } from ${JSON.stringify(input.vitestNodeUrl)};
const root = ${JSON.stringify(input.root)};
const vitest = await startVitest("test", [${JSON.stringify(input.pattern)}], {
  root,
  run: true,
  pool: "threads",
  config: false,
  include: ${JSON.stringify(input.include)},
  exclude: ["**/node_modules/**", "**/dist/**"],
  testNamePattern: ${JSON.stringify(input.testName)},
  passWithNoTests: true,
  reporters: [],
  silent: true,
}, { server: { host: "127.0.0.1" } });
const report = { numPassedTests: 0, numFailedTests: 0, numTotalTests: 0, testResults: [] };
for (const module of vitest.state.getTestModules()) {
    const errors = module.errors().map((error) => error?.stack ?? error?.message ?? String(error));
    let passed = 0;
    let failed = 0;
    for (const test of module.children.allTests()) {
      const result = test.result();
      if (result.state === "passed") passed += 1;
      if (result.state === "failed") {
        failed += 1;
        for (const error of result.errors ?? []) errors.push(test.fullName + ": " + (error?.message ?? String(error)));
      }
    }
    if (module.state() === "failed" && failed === 0) failed = 1;
    report.numPassedTests += passed;
    report.numFailedTests += failed;
    report.numTotalTests += passed + failed;
    const moduleId = module.moduleId.startsWith("file:") ? fileURLToPath(module.moduleId) : module.moduleId;
    report.testResults.push({
      name: moduleId,
      status: module.state() === "failed" ? "failed" : module.state() === "passed" ? "passed" : "skipped",
      startTime: 0,
      endTime: module.diagnostic().duration,
      assertionResults: errors.length ? [{ failureMessages: errors }] : [],
    });
}
fs.writeFileSync(${JSON.stringify(input.reportPath)}, JSON.stringify(report));
await vitest.close();
if (report.numFailedTests > 0) process.exitCode = 1;
`;
}

async function runChild(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid!, "SIGKILL");
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 128_000)
        stderr += chunk.toString("utf8", 0, 128_000 - stderr.length);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 128_000)
        stdout += chunk.toString("utf8", 0, 128_000 - stdout.length);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
  });
}

export type Api = Awaited<ReturnType<typeof activate>>;

export async function activate(ctx: ExtensionContextLike) {
  ctx.log.info("native test adapter activating");
  return {
    async runNative(request: TestRunRequest): Promise<TestRunResult> {
      assertTarget(request.target);
      if (!request.artifactKey || !/^[0-9a-f]{64}$/u.test(request.executionDigest)) {
        throw new Error("runNative requires a sealed execution identity");
      }
      const info = await ctx.workspace.getInfo();
      const invocation = ctx.invocation.current();
      const contextId =
        request.contextId ??
        invocation?.chainCaller?.contextId ??
        invocation?.caller.contextId;
      if (!contextId)
        throw new Error("test-runner.runNative requires a contextId");
      assertContextId(contextId);
      await ctx.fs.ensureMaterialized(request.target);
      const root = path.join(info.contextProjectionsPath, contextId);
      const targetPath = within(root, request.target);
      const suiteIncludes = declaredNativeSuite(targetPath, request.suite);
      if (request.fileFilter) within(targetPath, request.fileFilter);

      const scratch = fs.mkdtempSync(
        path.join(os.tmpdir(), "vibestudio-native-tests-"),
      );
      try {
        const reportPath = path.join(scratch, "report.json");
        const runnerPath = path.join(scratch, "runner.mjs");
        const include = suiteIncludes;
        const filePattern = request.fileFilter
          ? within(targetPath, request.fileFilter)
          : targetPath;
        const vitestNode = createRequire(import.meta.url).resolve("vitest/node");
        fs.writeFileSync(
          runnerPath,
          nativeRunnerSource({
            vitestNodeUrl: pathToFileURL(vitestNode).href,
            root,
            pattern: filePattern,
            include,
            testName: request.testName,
            reportPath,
          }),
        );
        const dependencyRoot = nodeModulesRoot(vitestNode);
        // The extension and its child execute in the same workspace native
        // domain: MXC resource admission on Unix, normal host-user execution
        // on Windows. Tests are not a separate filesystem security domain.
        // Dependency resolution follows the installed closure, including
        // package-manager links; it does not define another permission list.
        const outcome = await runChild(
          [runnerPath],
          root,
          {
            NODE_ENV: "test",
            FORCE_COLOR: "0",
            // The test engine belongs to the host-created dependency realm,
            // not to the materialized workspace projection. Expose that one
            // exact realm to code executed by Vitest so nested, declared test
            // runs and runtime imports resolve the same engine consistently.
            NODE_PATH: dependencyRoot,
            TMPDIR: scratch,
            TMP: scratch,
            TEMP: scratch,
          },
          120_000,
        );
        if (!fs.existsSync(reportPath)) {
          throw new Error(
            `Native test child exited ${outcome.code ?? "without a code"} without a report${outcome.stderr || outcome.stdout ? `: ${outcome.stderr}${outcome.stdout}` : ""}`,
          );
        }
        const report = JSON.parse(
          fs.readFileSync(reportPath, "utf8"),
        ) as JsonReport;
        const details = (report.testResults ?? []).map((file) => ({
          file: path.relative(root, file.name),
          status:
            file.status === "failed"
              ? ("fail" as const)
              : file.status === "passed"
                ? ("pass" as const)
                : ("skip" as const),
          ...(file.startTime !== undefined && file.endTime !== undefined
            ? { duration: Math.max(0, file.endTime - file.startTime) }
            : {}),
          ...(file.status === "failed"
            ? {
                errors: [
                  ...(file.message ? [file.message] : []),
                  ...(file.assertionResults ?? []).flatMap(
                    (result) => result.failureMessages ?? [],
                  ),
                ].slice(0, 20),
              }
            : {}),
        }));
        const passed = report.numPassedTests ?? 0;
        const failed = report.numFailedTests ?? 0;
        const total = report.numTotalTests ?? passed + failed;
        if (total === 0) {
          throw new Error(
            `Native suite ${JSON.stringify(request.suite)} discovered no tests${outcome.stdout ? `: ${outcome.stdout}` : ""}`,
          );
        }
        return {
          runtime: "native",
          artifactKey: request.artifactKey,
          executionDigest: request.executionDigest,
          summary:
            failed
                ? `${failed} of ${total} tests failed`
                : `${passed} tests passed`,
          passed,
          failed,
          total,
          contextId,
          target: request.target,
          pattern: `${request.suite} (native)`,
          details,
        };
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    },
  };
}
