import { describe, expect, it } from "vitest";
import { PROVENANCE_EVAL_SCENARIOS } from "../provenance-eval-scenarios.js";

describe("provenance eval catalog", () => {
  it("covers every canonical question with a normative budget", () => {
    const questions = PROVENANCE_EVAL_SCENARIOS.map((scenario) => scenario.question);
    for (const question of ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "abduction"]) {
      expect(questions).toContain(question);
    }
    for (const scenario of PROVENANCE_EVAL_SCENARIOS) {
      expect(scenario.budget.toolCalls, scenario.question).toBeLessThanOrEqual(4);
      expect(scenario.grading.length, scenario.question).toBeGreaterThan(0);
      expect(scenario.fixture.length, scenario.question).toBeGreaterThan(0);
    }
  });

  it("keeps the per-question call budgets the redesign committed to", () => {
    const budgetOf = (question: string): number =>
      PROVENANCE_EVAL_SCENARIOS.find((scenario) => scenario.question === question)!.budget
        .toolCalls;
    expect(budgetOf("Q1")).toBe(0);
    expect(budgetOf("Q2")).toBe(1);
    expect(budgetOf("Q3")).toBeLessThanOrEqual(2);
    expect(budgetOf("Q4")).toBeLessThanOrEqual(3);
    expect(budgetOf("Q5")).toBeLessThanOrEqual(2);
    expect(budgetOf("Q6")).toBe(1);
    expect(budgetOf("Q7")).toBe(1);
  });

  it("names a real covering test wherever it claims one", () => {
    for (const scenario of PROVENANCE_EVAL_SCENARIOS) {
      if (scenario.status === "scaffolded") {
        expect(scenario.coveringTest, scenario.question).toBeUndefined();
        continue;
      }
      // A unit test is named by its file; a system test is named by its
      // declaring suite and case, because the case is the unit that runs.
      expect(scenario.coveringTest, scenario.question).toMatch(
        scenario.status === "covered-by-unit-test"
          ? /\.test\.ts/u
          : /^skills\/system-testing\/tests\/[\w-]+\.ts › [\w-]+$/u
      );
    }
  });
});
