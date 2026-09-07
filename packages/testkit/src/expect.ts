/**
 * Minimal assertion library for in-system tests.
 *
 * Failures throw TestAssertionError carrying serializable expected/actual so
 * results survive the eval boundary and render compactly in reports.
 */

export class TestAssertionError extends Error {
  readonly expected?: unknown;
  readonly actual?: unknown;

  constructor(message: string, opts?: { expected?: unknown; actual?: unknown }) {
    super(message);
    this.name = "TestAssertionError";
    this.expected = opts?.expected;
    this.actual = opts?.actual;
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
}

interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toBeNull(): void;
  toContain(item: unknown): void;
  toMatch(pattern: RegExp | string): void;
  toHaveLength(length: number): void;
  toBeGreaterThan(n: number): void;
  toBeGreaterThanOrEqual(n: number): void;
  toBeLessThan(n: number): void;
  toBeLessThanOrEqual(n: number): void;
  readonly not: Matchers;
}

function makeMatchers(actual: unknown, negated: boolean, label?: string): Matchers {
  const prefix = label ? `${label}: ` : "";
  const fail = (description: string, expected?: unknown): never => {
    throw new TestAssertionError(
      `${prefix}expected ${truncate(stringify(actual))}${negated ? " not" : ""} ${description}`,
      { expected, actual }
    );
  };
  const check = (pass: boolean, description: string, expected?: unknown): void => {
    if (pass === negated) fail(description, expected);
  };

  return {
    toBe: (expected) => check(Object.is(actual, expected), `to be ${stringify(expected)}`, expected),
    toEqual: (expected) =>
      check(deepEqual(actual, expected), `to equal ${truncate(stringify(expected))}`, expected),
    toBeTruthy: () => check(Boolean(actual), "to be truthy"),
    toBeFalsy: () => check(!actual, "to be falsy"),
    toBeDefined: () => check(actual !== undefined, "to be defined"),
    toBeUndefined: () => check(actual === undefined, "to be undefined"),
    toBeNull: () => check(actual === null, "to be null"),
    toContain: (item) => {
      const pass = Array.isArray(actual)
        ? actual.some((entry) => deepEqual(entry, item))
        : typeof actual === "string" && typeof item === "string"
          ? actual.includes(item)
          : false;
      check(pass, `to contain ${stringify(item)}`, item);
    },
    toMatch: (pattern) => {
      const text = String(actual);
      const pass = typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
      check(pass, `to match ${String(pattern)}`, String(pattern));
    },
    toHaveLength: (length) => {
      const actualLength = (actual as { length?: number } | null)?.length;
      check(actualLength === length, `to have length ${length} (got ${actualLength})`, length);
    },
    toBeGreaterThan: (n) => check((actual as number) > n, `to be > ${n}`, n),
    toBeGreaterThanOrEqual: (n) => check((actual as number) >= n, `to be >= ${n}`, n),
    toBeLessThan: (n) => check((actual as number) < n, `to be < ${n}`, n),
    toBeLessThanOrEqual: (n) => check((actual as number) <= n, `to be <= ${n}`, n),
    get not() {
      return makeMatchers(actual, !negated, label);
    },
  };
}

/** `expect(value).toBe(...)` — optional label improves failure messages. */
export function expect(actual: unknown, label?: string): Matchers {
  return makeMatchers(actual, false, label);
}

/** Unconditional failure with a serializable error. */
export function fail(message: string): never {
  throw new TestAssertionError(message);
}
