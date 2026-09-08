export type SandboxTestRuntime = "browser" | "workerd";

export interface TestExecutionRequest {
  protocol: "workspace-test-execution-request.v1";
  artifactKey: string;
  executionDigest: string;
  testName?: string;
  limits: { timeoutMs: number; memoryMb: number };
}

export interface TestExecutionResult {
  protocol: "workspace-test-execution-result.v1";
  artifactKey: string;
  executionDigest: string;
  runtime: SandboxTestRuntime;
  status:
    | "passed"
    | "failed"
    | "no-tests"
    | "cancelled"
    | "infrastructure-error";
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  files: Array<{
    file: string;
    status: "pass" | "fail" | "skip";
    duration?: number;
    errors?: string[];
  }>;
}

type TestFunction = () => unknown | Promise<unknown>;
type HookKind = "beforeAll" | "afterAll" | "beforeEach" | "afterEach";
interface Suite {
  name: string;
  parent: Suite | null;
  hooks: Record<HookKind, TestFunction[]>;
}
interface TestCase {
  name: string;
  file: string;
  suite: Suite;
  fn: TestFunction;
  mode: "run" | "skip" | "only";
}

const root: Suite = {
  name: "",
  parent: null,
  hooks: { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] },
};
let currentSuite = root;
let currentFile = "unknown";
const cases: TestCase[] = [];

export function setCurrentTestFile(file: string): void {
  currentFile = file;
}

type Registrar = ((name: string, fn: TestFunction) => void) & {
  skip(name: string, fn: TestFunction): void;
  only(name: string, fn: TestFunction): void;
  each<T>(
    values: readonly T[],
  ): (name: string, fn: (value: T) => unknown) => void;
};
const registrar = ((name: string, fn: TestFunction): void => {
  cases.push({
    name,
    file: currentFile,
    suite: currentSuite,
    fn,
    mode: "run",
  });
}) as Registrar;
registrar.skip = (name, fn) =>
  cases.push({
    name,
    file: currentFile,
    suite: currentSuite,
    fn,
    mode: "skip",
  });
registrar.only = (name, fn) =>
  cases.push({
    name,
    file: currentFile,
    suite: currentSuite,
    fn,
    mode: "only",
  });
registrar.each = (values) => (name, fn) =>
  values.forEach((value, index) =>
    cases.push({
      name: `${name} [${index}]`,
      file: currentFile,
      suite: currentSuite,
      fn: () => fn(value),
      mode: "run",
    }),
  );
export const it = registrar;
export const test = registrar;

export function describe(name: string, body: () => void): void {
  const parent = currentSuite;
  currentSuite = {
    name,
    parent,
    hooks: { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] },
  };
  try {
    body();
  } finally {
    currentSuite = parent;
  }
}

const hook = (kind: HookKind, fn: TestFunction) =>
  currentSuite.hooks[kind].push(fn);
export const beforeAll = (fn: TestFunction) => hook("beforeAll", fn);
export const afterAll = (fn: TestFunction) => hook("afterAll", fn);
export const beforeEach = (fn: TestFunction) => hook("beforeEach", fn);
export const afterEach = (fn: TestFunction) => hook("afterEach", fn);

function printable(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left as object).sort();
  const rightKeys = Object.keys(right as object).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        deepEqual(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

interface MatcherApi {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toMatchObject(expected: Record<string, unknown>): void;
  toBeNull(): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toContain(expected: unknown): void;
  toHaveLength(expected: number): void;
  toBeGreaterThan(expected: number): void;
  toHaveBeenCalledTimes(expected: number): void;
  toHaveBeenCalledWith(...expected: unknown[]): void;
  toThrow(expected?: string | RegExp): void;
  readonly not: MatcherApi;
}

function matcherSet(actual: unknown, inverted = false): MatcherApi {
  const verify = (condition: boolean, message: string) =>
    assert(
      inverted ? !condition : condition,
      inverted ? `Not: ${message}` : message,
    );
  const matchers = {
    toBe(expected: unknown) {
      verify(
        Object.is(actual, expected),
        `Expected ${printable(actual)} to be ${printable(expected)}`,
      );
    },
    toEqual(expected: unknown) {
      verify(
        deepEqual(actual, expected),
        `Expected ${printable(actual)} to equal ${printable(expected)}`,
      );
    },
    toMatchObject(expected: Record<string, unknown>) {
      const matches =
        Boolean(actual) &&
        typeof actual === "object" &&
        Object.entries(expected).every(([key, value]) =>
          deepEqual((actual as Record<string, unknown>)[key], value),
        );
      verify(
        matches,
        `Expected ${printable(actual)} to match ${printable(expected)}`,
      );
    },
    toBeNull() {
      verify(actual === null, `Expected ${printable(actual)} to be null`);
    },
    toBeDefined() {
      verify(actual !== undefined, "Expected value to be defined");
    },
    toBeUndefined() {
      verify(
        actual === undefined,
        `Expected ${printable(actual)} to be undefined`,
      );
    },
    toBeTruthy() {
      verify(Boolean(actual), `Expected ${printable(actual)} to be truthy`);
    },
    toBeFalsy() {
      verify(!actual, `Expected ${printable(actual)} to be falsy`);
    },
    toContain(expected: unknown) {
      const found =
        typeof actual === "string"
          ? actual.includes(String(expected))
          : Array.isArray(actual) &&
            actual.some((value) => deepEqual(value, expected));
      verify(
        found,
        `Expected ${printable(actual)} to contain ${printable(expected)}`,
      );
    },
    toHaveLength(expected: number) {
      const length = (actual as { length?: unknown } | null)?.length;
      verify(
        length === expected,
        `Expected length ${printable(length)} to be ${expected}`,
      );
    },
    toBeGreaterThan(expected: number) {
      verify(
        typeof actual === "number" && actual > expected,
        `Expected ${printable(actual)} to be greater than ${expected}`,
      );
    },
    toHaveBeenCalledTimes(expected: number) {
      const calls = (actual as MockFunction | undefined)?.mock?.calls;
      verify(
        Array.isArray(calls) && calls.length === expected,
        `Expected mock to be called ${expected} times, received ${calls?.length ?? "a non-mock"}`,
      );
    },
    toHaveBeenCalledWith(...expected: unknown[]) {
      const calls = (actual as MockFunction | undefined)?.mock?.calls;
      verify(
        Boolean(calls?.some((call) => deepEqual(call, expected))),
        `Expected mock calls ${printable(calls)} to contain ${printable(expected)}`,
      );
    },
    toThrow(expected?: string | RegExp) {
      assert(typeof actual === "function", "toThrow expects a function");
      let thrown: unknown;
      try {
        (actual as () => unknown)();
      } catch (error) {
        thrown = error;
      }
      verify(thrown !== undefined, "Expected function to throw");
      if (thrown === undefined || inverted) return;
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      if (typeof expected === "string")
        verify(
          message.includes(expected),
          `Expected ${message} to contain ${expected}`,
        );
      if (expected instanceof RegExp)
        verify(
          expected.test(message),
          `Expected ${message} to match ${expected}`,
        );
    },
  };
  return Object.defineProperty(matchers, "not", {
    enumerable: true,
    get: () => matcherSet(actual, !inverted),
  }) as typeof matchers & { readonly not: MatcherApi };
}

function asyncMatcherSet(actual: unknown, mode: "resolves" | "rejects") {
  const value = Promise.resolve(actual).then(
    (resolved) => {
      if (mode === "rejects") throw new Error("Expected promise to reject");
      return resolved;
    },
    (error) => {
      if (mode === "resolves") throw error;
      return error instanceof Error
        ? () => {
            throw error;
          }
        : () => {
            throw new Error(String(error));
          };
    },
  );
  return {
    async toBe(expected: unknown) {
      matcherSet(await value).toBe(expected);
    },
    async toEqual(expected: unknown) {
      matcherSet(await value).toEqual(expected);
    },
    async toThrow(expected?: string | RegExp) {
      matcherSet(await value).toThrow(expected);
    },
  };
}

export function expect(actual: unknown) {
  const matchers = matcherSet(actual);
  Object.defineProperties(matchers, {
    resolves: {
      enumerable: true,
      get: () => asyncMatcherSet(actual, "resolves"),
    },
    rejects: {
      enumerable: true,
      get: () => asyncMatcherSet(actual, "rejects"),
    },
  });
  return matchers as typeof matchers & {
    readonly resolves: ReturnType<typeof asyncMatcherSet>;
    readonly rejects: ReturnType<typeof asyncMatcherSet>;
  };
}

export interface MockFunction extends Function {
  (...args: unknown[]): unknown;
  mock: {
    calls: unknown[][];
    results: Array<{ type: "return" | "throw"; value: unknown }>;
  };
  mockClear(): MockFunction;
  mockImplementation(
    implementation: (...args: unknown[]) => unknown,
  ): MockFunction;
  mockReturnValue(value: unknown): MockFunction;
  mockRestore(): void;
}

const mocks = new Set<MockFunction>();

function createMock(
  implementation: (...args: unknown[]) => unknown = () => undefined,
  restore: () => void = () => undefined,
): MockFunction {
  let current = implementation;
  const mock = function (this: unknown, ...args: unknown[]) {
    mock.mock.calls.push(args);
    try {
      const value = current.apply(this, args);
      mock.mock.results.push({ type: "return", value });
      return value;
    } catch (error) {
      mock.mock.results.push({ type: "throw", value: error });
      throw error;
    }
  } as MockFunction;
  mock.mock = { calls: [], results: [] };
  mock.mockClear = () => {
    mock.mock.calls.length = 0;
    mock.mock.results.length = 0;
    return mock;
  };
  mock.mockImplementation = (next) => {
    current = next;
    return mock;
  };
  mock.mockReturnValue = (value) => {
    current = () => value;
    return mock;
  };
  mock.mockRestore = () => {
    restore();
    mocks.delete(mock);
  };
  mocks.add(mock);
  return mock;
}

export const vi = {
  fn: (implementation?: (...args: unknown[]) => unknown) =>
    createMock(implementation),
  spyOn<T extends object, K extends keyof T>(object: T, key: K): MockFunction {
    const original = object[key];
    assert(
      typeof original === "function",
      `Cannot spy on non-function ${String(key)}`,
    );
    const mock = createMock(original as (...args: unknown[]) => unknown, () => {
      object[key] = original;
    });
    object[key] = mock as T[K];
    return mock;
  },
  clearAllMocks: () => {
    for (const mock of mocks) mock.mockClear();
  },
  restoreAllMocks: () => {
    for (const mock of [...mocks]) mock.mockRestore();
  },
};

function chain(suite: Suite): Suite[] {
  const result: Suite[] = [];
  for (let cursor: Suite | null = suite; cursor; cursor = cursor.parent)
    result.unshift(cursor);
  return result;
}

async function timed(fn: TestFunction, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Test timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const fullName = (entry: TestCase) =>
  [
    ...chain(entry.suite)
      .map((suite) => suite.name)
      .filter(Boolean),
    entry.name,
  ].join(" > ");

export async function runTests(
  request: TestExecutionRequest,
  runtime: SandboxTestRuntime,
): Promise<TestExecutionResult> {
  const started = performance.now();
  const selected = cases.filter(
    (entry) => !request.testName || fullName(entry).includes(request.testName),
  );
  const only = selected.some((entry) => entry.mode === "only");
  const runnable = selected.filter(
    (entry) => entry.mode !== "skip" && (!only || entry.mode === "only"),
  );
  const initialized = new Set<Suite>();
  const results = new Map<
    string,
    {
      passed: number;
      failed: number;
      skipped: number;
      duration: number;
      errors: string[];
    }
  >();
  const resultFor = (file: string) => {
    const found = results.get(file) ?? {
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      errors: [],
    };
    results.set(file, found);
    return found;
  };
  selected
    .filter((entry) => !runnable.includes(entry))
    .forEach((entry) => resultFor(entry.file).skipped++);
  for (const entry of runnable) {
    const result = resultFor(entry.file);
    const began = performance.now();
    const suites = chain(entry.suite);
    try {
      for (const suite of suites) {
        if (!initialized.has(suite)) {
          for (const fn of suite.hooks.beforeAll)
            await timed(fn, request.limits.timeoutMs);
          initialized.add(suite);
        }
      }
      for (const suite of suites)
        for (const fn of suite.hooks.beforeEach)
          await timed(fn, request.limits.timeoutMs);
      await timed(entry.fn, request.limits.timeoutMs);
      result.passed++;
    } catch (error) {
      result.failed++;
      result.errors.push(
        `${fullName(entry)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      try {
        for (const suite of [...suites].reverse()) {
          for (const fn of suite.hooks.afterEach)
            await timed(fn, request.limits.timeoutMs);
        }
      } catch (error) {
        if (result.passed > 0) result.passed--;
        result.failed++;
        result.errors.push(
          `${fullName(entry)} afterEach: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        vi.restoreAllMocks();
      }
      result.duration += performance.now() - began;
    }
  }
  for (const suite of [...initialized].reverse())
    for (const fn of suite.hooks.afterAll)
      await timed(fn, request.limits.timeoutMs);
  const files = [...results].map(([file, result]) => ({
    file,
    status: result.failed
      ? ("fail" as const)
      : result.passed
        ? ("pass" as const)
        : ("skip" as const),
    duration: result.duration,
    ...(result.errors.length
      ? {
          errors: result.errors
            .slice(0, 20)
            .map((error) => error.slice(0, 4_000)),
        }
      : {}),
  }));
  const passed = [...results.values()].reduce(
    (sum, result) => sum + result.passed,
    0,
  );
  const failed = [...results.values()].reduce(
    (sum, result) => sum + result.failed,
    0,
  );
  const skipped = [...results.values()].reduce(
    (sum, result) => sum + result.skipped,
    0,
  );
  return {
    protocol: "workspace-test-execution-result.v1",
    artifactKey: request.artifactKey,
    executionDigest: request.executionDigest,
    runtime,
    status: selected.length === 0 ? "no-tests" : failed ? "failed" : "passed",
    passed,
    failed,
    skipped,
    durationMs: performance.now() - started,
    files,
  };
}
