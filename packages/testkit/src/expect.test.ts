import { describe, it, expect as vexpect } from "vitest";
import { expect, fail, deepEqual, TestAssertionError } from "./expect.js";

describe("testkit expect", () => {
  it("passes matching assertions", () => {
    expect(1).toBe(1);
    expect({ a: [1, 2] }).toEqual({ a: [1, 2] });
    expect("hello world").toContain("world");
    expect("hello").toMatch(/^he/);
    expect([1, 2, 3]).toHaveLength(3);
    expect(5).toBeGreaterThan(4);
    expect(undefined).toBeUndefined();
    expect(null).toBeNull();
    expect(2).not.toBe(3);
    expect([{ a: 1 }]).toContain({ a: 1 });
  });

  it("throws TestAssertionError with expected/actual on mismatch", () => {
    try {
      expect(1, "answer").toBe(2);
      throw new Error("should have thrown");
    } catch (error) {
      vexpect(error).toBeInstanceOf(TestAssertionError);
      const assertion = error as TestAssertionError;
      vexpect(assertion.message).toContain("answer");
      vexpect(assertion.expected).toBe(2);
      vexpect(assertion.actual).toBe(1);
    }
  });

  it("negation flips outcomes", () => {
    vexpect(() => expect(1).not.toBe(1)).toThrow(TestAssertionError);
    vexpect(() => expect("abc").not.toContain("z")).not.toThrow();
  });

  it("fail() always throws", () => {
    vexpect(() => fail("nope")).toThrow("nope");
  });

  it("deepEqual handles nested structures and mismatched shapes", () => {
    vexpect(deepEqual({ a: { b: [1] } }, { a: { b: [1] } })).toBe(true);
    vexpect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    vexpect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
    vexpect(deepEqual(NaN, NaN)).toBe(true);
  });
});
