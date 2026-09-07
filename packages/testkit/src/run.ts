/**
 * Deterministic test runner that works inside eval blocks and panels — no
 * vitest, no module-global registry (safe to re-run the same eval repeatedly).
 *
 * Convention for eval callers: stash the full SuiteRunResult in `scope`
 * (e.g. scope.testkitRun) and return report.summarize(result).
 */
import { Supervisor, type SupervisionReport } from "./supervise.js";
import { TestAssertionError } from "./expect.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface TestContext {
  /** Aborted when the test times out; helpers use this for cooperative stop. */
  signal: AbortSignal;
  /** Register LIFO cleanup that always runs, pass or fail. */
  defer(fn: () => Promise<void> | void): void;
  /** Auto-created supervisor; panels opened via testkit helpers are auto-watched. */
  supervisor: Supervisor;
  /** Captured into the test result. */
  log(message: string): void;
}

export interface TestOptions {
  timeoutMs?: number;
  skip?: boolean;
  only?: boolean;
}

interface TestEntry {
  name: string;
  fn: (t: TestContext) => Promise<void> | void;
  options: TestOptions;
}

export interface SuiteOptions {
  timeoutMs?: number;
  /** Fail tests when supervision observes error-level findings (default true). */
  failOnSupervision?: boolean;
  /** This suite opens or drives a workspace panel through the panel runtime. */
  usesPanelAutomation?: boolean;
}

export class Suite {
  readonly tests: TestEntry[] = [];
  readonly beforeEachFns: Array<(t: TestContext) => Promise<void> | void> = [];
  readonly afterEachFns: Array<(t: TestContext) => Promise<void> | void> = [];

  constructor(
    readonly name: string,
    readonly options: SuiteOptions = {}
  ) {}

  test(name: string, fn: (t: TestContext) => Promise<void> | void, options: TestOptions = {}): this {
    this.tests.push({ name, fn, options });
    return this;
  }

  beforeEach(fn: (t: TestContext) => Promise<void> | void): this {
    this.beforeEachFns.push(fn);
    return this;
  }

  afterEach(fn: (t: TestContext) => Promise<void> | void): this {
    this.afterEachFns.push(fn);
    return this;
  }
}

export function suite(name: string, options?: SuiteOptions): Suite {
  return new Suite(name, options);
}

export interface TestCaseResult {
  suite: string;
  name: string;
  status: "passed" | "failed" | "errored" | "skipped" | "timeout";
  durationMs: number;
  error?: { message: string; stack?: string; expected?: unknown; actual?: unknown };
  logs: string[];
  supervision?: SupervisionReport;
}

export interface SuiteRunResult {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  duration: number;
  results: TestCaseResult[];
}

export interface RunOptions {
  filter?: { suite?: string | RegExp; test?: string | RegExp };
  bail?: boolean;
  onTestEnd?: (result: TestCaseResult) => void;
}

// Ambient current context so testkit helpers (openPanel etc.) can auto-register
// opened panels with the running test's supervisor. Tests run serially, so a
// single slot is sufficient and deterministic.
let currentContext: TestContext | null = null;

export function activeTestContext(): TestContext | null {
  return currentContext;
}

function matches(filter: string | RegExp | undefined, value: string): boolean {
  if (filter === undefined) return true;
  return typeof filter === "string" ? value.includes(filter) : filter.test(value);
}

function toErrorInfo(error: unknown): NonNullable<TestCaseResult["error"]> {
  if (error instanceof TestAssertionError) {
    return {
      message: error.message,
      stack: error.stack,
      expected: error.expected,
      actual: error.actual,
    };
  }
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  return { message: String(error) };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: (error: TimeoutError) => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new TimeoutError(`${label} timed out after ${timeoutMs}ms`);
          onTimeout?.(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class TimeoutError extends Error {}

async function runTest(suiteDef: Suite, entry: TestEntry): Promise<TestCaseResult> {
  const logs: string[] = [];
  const deferred: Array<() => Promise<void> | void> = [];
  const supervisor = new Supervisor();
  const abortController = new AbortController();
  let cleanupStarted = false;
  const context: TestContext = {
    signal: abortController.signal,
    defer: (fn) => {
      if (cleanupStarted || abortController.signal.aborted) {
        void Promise.resolve()
          .then(fn)
          .catch((cleanupError) => {
            logs.push(
              `late cleanup failed: ${
                cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
              }`
            );
          });
        return;
      }
      deferred.push(fn);
    },
    supervisor,
    log: (message) => logs.push(message),
  };
  const timeoutMs = entry.options.timeoutMs ?? suiteDef.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  let status: TestCaseResult["status"] = "passed";
  let error: TestCaseResult["error"];

  currentContext = context;
  try {
    await withTimeout(
      (async () => {
        for (const fn of suiteDef.beforeEachFns) await fn(context);
        await entry.fn(context);
        for (const fn of suiteDef.afterEachFns) await fn(context);
      })(),
      timeoutMs,
      `${suiteDef.name} > ${entry.name}`,
      (timeoutError) => abortController.abort(timeoutError)
    );
  } catch (caught) {
    status = caught instanceof TimeoutError ? "timeout" : caught instanceof TestAssertionError ? "failed" : "errored";
    error = toErrorInfo(caught);
    if (caught instanceof TimeoutError && !abortController.signal.aborted) {
      abortController.abort(caught);
    }
  } finally {
    cleanupStarted = true;
    currentContext = null;
    for (const fn of deferred.reverse()) {
      try {
        await fn();
      } catch (cleanupError) {
        logs.push(
          `cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        );
      }
    }
    supervisor.stop();
  }

  let supervision: SupervisionReport | undefined;
  try {
    supervision = await supervisor.collect();
  } catch {
    supervision = undefined;
  }
  if (
    status === "passed" &&
    (suiteDef.options.failOnSupervision ?? true) &&
    supervision &&
    supervision.errors > 0
  ) {
    status = "failed";
    error = {
      message: `supervision found ${supervision.errors} error finding(s): ${supervision.findings
        .filter((finding) => finding.kind !== "console-warn")
        .slice(0, 3)
        .map((finding) => `[${finding.target}] ${finding.message.slice(0, 160)}`)
        .join("; ")}`,
    };
  }

  return {
    suite: suiteDef.name,
    name: entry.name,
    status,
    durationMs: Date.now() - started,
    error,
    logs,
    supervision: supervision && supervision.findings.length > 0 ? supervision : undefined,
  };
}

export async function runSuites(
  suites: Suite | Suite[],
  options: RunOptions = {}
): Promise<SuiteRunResult> {
  const suiteList = Array.isArray(suites) ? suites : [suites];
  const started = Date.now();
  const results: TestCaseResult[] = [];

  const hasOnly = suiteList.some((suiteDef) => suiteDef.tests.some((test) => test.options.only));

  outer: for (const suiteDef of suiteList) {
    if (!matches(options.filter?.suite, suiteDef.name)) continue;
    for (const entry of suiteDef.tests) {
      if (!matches(options.filter?.test, entry.name)) continue;
      if (entry.options.skip || (hasOnly && !entry.options.only)) {
        const result: TestCaseResult = {
          suite: suiteDef.name,
          name: entry.name,
          status: "skipped",
          durationMs: 0,
          logs: [],
        };
        results.push(result);
        options.onTestEnd?.(result);
        continue;
      }
      const result = await runTest(suiteDef, entry);
      results.push(result);
      options.onTestEnd?.(result);
      // Timed-out test bodies cannot be forcibly killed in-process. Abort the
      // active context and stop scheduling later tests so a late continuation
      // cannot interfere with another test's panels or workspace state.
      if (result.status === "timeout") break outer;
      if (options.bail && (result.status === "failed" || result.status === "errored")) {
        break outer;
      }
    }
  }

  return {
    total: results.length,
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed" || result.status === "timeout")
      .length,
    errored: results.filter((result) => result.status === "errored").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    duration: Date.now() - started,
    results,
  };
}
