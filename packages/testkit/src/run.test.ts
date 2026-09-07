import { describe, it, expect as vexpect } from "vitest";
import { suite, runSuites } from "./run.js";
import { expect } from "./expect.js";
import { summarize } from "./report.js";

describe("testkit runner", () => {
  it("runs tests and classifies pass/fail/error/skip", async () => {
    const s = suite("demo", { failOnSupervision: false })
      .test("passes", () => {
        expect(1).toBe(1);
      })
      .test("fails", () => {
        expect(1).toBe(2);
      })
      .test("errors", () => {
        throw new Error("boom");
      })
      .test("skipped", () => undefined, { skip: true });

    const result = await runSuites(s);
    vexpect(result.total).toBe(4);
    vexpect(result.passed).toBe(1);
    vexpect(result.failed).toBe(1);
    vexpect(result.errored).toBe(1);
    vexpect(result.skipped).toBe(1);
    const failed = result.results.find((r) => r.name === "fails");
    vexpect(failed?.error?.expected).toBe(2);
  });

  it("enforces timeouts", async () => {
    const s = suite("slow", { failOnSupervision: false }).test(
      "hangs",
      () => new Promise(() => undefined),
      { timeoutMs: 50 }
    );
    const result = await runSuites(s);
    vexpect(result.results[0]?.status).toBe("timeout");
    vexpect(result.failed).toBe(1);
  });

  it("aborts timed-out tests and stops before later tests", async () => {
    const events: string[] = [];
    const s = suite("slow", { failOnSupervision: false })
      .test(
        "times out",
        async (t) => {
          t.signal.addEventListener("abort", () => events.push("aborted"), { once: true });
          await new Promise((resolve) => setTimeout(resolve, 100));
          t.defer(() => {
            events.push("late-cleanup");
          });
        },
        { timeoutMs: 20 }
      )
      .test("must not run", () => {
        events.push("next-test");
      });

    const result = await runSuites(s);
    vexpect(result.total).toBe(1);
    vexpect(result.results[0]?.status).toBe("timeout");
    vexpect(events).toContain("aborted");
    vexpect(events).not.toContain("next-test");

    await new Promise((resolve) => setTimeout(resolve, 120));
    vexpect(events).toContain("late-cleanup");
    vexpect(events).not.toContain("next-test");
  });

  it("runs deferred cleanup LIFO even on failure", async () => {
    const order: string[] = [];
    const s = suite("cleanup", { failOnSupervision: false }).test("fails after defers", (t) => {
      t.defer(() => {
        order.push("first-registered");
      });
      t.defer(() => {
        order.push("second-registered");
      });
      throw new Error("boom");
    });
    await runSuites(s);
    vexpect(order).toEqual(["second-registered", "first-registered"]);
  });

  it("supports filters, bail and onTestEnd", async () => {
    const ran: string[] = [];
    const a = suite("alpha", { failOnSupervision: false })
      .test("one", () => {
        ran.push("one");
      })
      .test("two", () => {
        throw new Error("boom");
      })
      .test("three", () => {
        ran.push("three");
      });
    const names: string[] = [];
    const result = await runSuites([a], {
      bail: true,
      onTestEnd: (r) => names.push(`${r.name}:${r.status}`),
    });
    vexpect(result.total).toBe(2); // bailed before "three"
    vexpect(names).toEqual(["one:passed", "two:errored"]);

    ran.length = 0;
    const filtered = await runSuites([a], { filter: { test: "three" } });
    vexpect(filtered.total).toBe(1);
    vexpect(ran).toEqual(["three"]);
  });

  it("only-tests exclude the rest", async () => {
    const s = suite("only", { failOnSupervision: false })
      .test("a", () => undefined)
      .test("b", () => undefined, { only: true });
    const result = await runSuites(s);
    vexpect(result.results.find((r) => r.name === "a")?.status).toBe("skipped");
    vexpect(result.results.find((r) => r.name === "b")?.status).toBe("passed");
  });

  it("beforeEach/afterEach wrap each test", async () => {
    const calls: string[] = [];
    const s = suite("hooks", { failOnSupervision: false })
      .beforeEach(() => {
        calls.push("before");
      })
      .afterEach(() => {
        calls.push("after");
      })
      .test("t1", () => {
        calls.push("t1");
      })
      .test("t2", () => {
        calls.push("t2");
      });
    await runSuites(s);
    vexpect(calls).toEqual(["before", "t1", "after", "before", "t2", "after"]);
  });

  it("summarize produces a bounded failure packet", async () => {
    const s = suite("sum", { failOnSupervision: false })
      .test("ok", () => undefined)
      .test("bad", (t) => {
        t.log("some context");
        throw new Error("x".repeat(1000));
      });
    const summary = summarize(await runSuites(s));
    vexpect(summary.passed).toBe(1);
    vexpect(summary.failures).toHaveLength(1);
    vexpect(summary.failures[0]?.error?.length).toBeLessThanOrEqual(400);
    vexpect(summary.failures[0]?.logsTail).toEqual(["some context"]);
  });
});
