/**
 * The provenance eval catalog: the balance is measured, not asserted.
 *
 * Each canonical question has a normative budget — tool calls and rendered
 * provenance tokens — that the redesign claims to hit. This module is the
 * machine-readable statement of those claims plus the fixture shape each
 * scenario needs. There is still no runner that measures the *budgets*
 * (`packages/eval` is the JavaScript execution sandbox, not an agent eval
 * suite), so the token and call economics remain unmeasured.
 *
 * What does exist is correctness coverage on a real workspace authority:
 * `skills/system-testing/tests/provenance-questions.ts` runs headless agents
 * against the deployed engine. That distinction matters more than it looks.
 * Every unit test below runs on the sql.js fallback and against mocked host
 * dispatch, and both instruments stayed green while `vcs.walk`, `vcs.query`,
 * and `vcs.search` were unreachable end-to-end and while the catalog view
 * exceeded the deployed SQLite compound-SELECT limit. A `covered-by-unit-test`
 * status is evidence about the mechanism, never about the surface.
 *
 * Status values say exactly how far each scenario got:
 *  - `scaffolded`: fixture shape and budget recorded here; no runner yet.
 *  - `covered-by-unit-test`: the mechanism's behavior is asserted by a named
 *    deterministic test, though not its token/call economics.
 *  - `covered-by-system-test`: a headless agent exercises the surface end to
 *    end on a real workspace authority; still not the budget.
 */

export type ProvenanceScenarioStatus =
  | "scaffolded"
  | "covered-by-unit-test"
  | "covered-by-system-test";

export interface ProvenanceEvalScenario {
  /** Canonical question identifier from the redesign (Q1–Q7). */
  readonly question: string;
  readonly summary: string;
  /** Normative budget: the whole point of the redesign. */
  readonly budget: { readonly toolCalls: number; readonly renderedTokens: number };
  /** The mechanism the agent is expected to reach for. */
  readonly mechanism: string;
  /** What the seeded workspace must contain for the question to be real. */
  readonly fixture: readonly string[];
  /** What counts as a correct recovered answer. */
  readonly grading: readonly string[];
  readonly status: ProvenanceScenarioStatus;
  /** Deterministic test that already covers the mechanism, when any. */
  readonly coveringTest?: string;
}

export const PROVENANCE_EVAL_SCENARIOS: readonly ProvenanceEvalScenario[] = [
  {
    question: "Q1",
    summary: "Why do these bytes exist?",
    budget: { toolCalls: 0, renderedTokens: 1_500 },
    mechanism: "read-memory attachment (unchanged by this redesign)",
    fixture: ["one managed file whose lines were authored under a stated intent"],
    grading: ["the answer is present without any provenance call"],
    status: "covered-by-unit-test",
    coveringTest: "packages/harness/src/tools/__tests__/read-memory.generated.test.ts",
  },
  {
    question: "Q2",
    summary: "What was actually being attempted?",
    budget: { toolCalls: 1, renderedTokens: 1_500 },
    mechanism: 'provenance({ target, walk: "cause" })',
    fixture: [
      "a human turn stating a request",
      "an invocation and command caused by that turn",
      "a work unit and applied change under that command",
    ],
    grading: [
      "the recovered answer quotes the originating human statement",
      "the terminal entry is labeled as a human-statement boundary",
      "no content-addressed identity appears in the rendered block",
    ],
    status: "covered-by-system-test",
    coveringTest:
      "skills/system-testing/tests/provenance-questions.ts › provenance-recovers-the-originating-request",
  },
  {
    question: "Q3",
    summary: "What else happened under that intent?",
    budget: { toolCalls: 2, renderedTokens: 1_500 },
    mechanism: 'provenance({ target, walk: "cohort" }) or one prov_* query',
    fixture: ["one command touching several coordinates", "a commit carrying that work"],
    grading: [
      "every touched coordinate is named once, grouped, with a count",
      "the cohort is reachable in at most two calls from a cold start",
    ],
    status: "covered-by-system-test",
    coveringTest:
      "skills/system-testing/tests/provenance-questions.ts › provenance-recovers-the-cohort-of-one-request",
  },
  {
    question: "Q4",
    summary: "How are these two things related?",
    budget: { toolCalls: 3, renderedTokens: 1_500 },
    mechanism: "cause-walk both subjects and intersect, or one prov_changes self-join",
    fixture: ["two files touched by one command", "two files with no common cause"],
    grading: [
      "the related pair is connected within budget",
      "the unrelated pair is reported as unrelated rather than guessed",
      "records the verdict on whether a dedicated `connect` walk is warranted",
    ],
    status: "scaffolded",
  },
  {
    question: "Q5",
    summary: "What has this coordinate been for, over time?",
    budget: { toolCalls: 2, renderedTokens: 1_500 },
    mechanism: "intent-annotated history plus the taught reading, or one prov_* query",
    fixture: ["one coordinate edited under three different stated intents"],
    grading: [
      "the drift is described with tiers intact",
      "records the verdict on whether a dedicated `drift` walk is warranted",
    ],
    status: "scaffolded",
  },
  {
    question: "Q6",
    summary: "What was tried and rejected here?",
    budget: { toolCalls: 1, renderedTokens: 1_500 },
    mechanism: 'provenance({ target, walk: "rejections" })',
    fixture: [
      "a change counteracted by a revert whose intent states the reason",
      "a merge coordinate resolved `ours`",
    ],
    grading: [
      "the rejection and the intent that explains it are both recovered",
      "the agent consults rejections before repeating rejected work",
    ],
    status: "covered-by-system-test",
    coveringTest:
      "skills/system-testing/tests/provenance-questions.ts › provenance-consults-rejections-before-repeating-them",
  },
  {
    question: "Q7",
    summary: "Which subjects match a description?",
    budget: { toolCalls: 1, renderedTokens: 1_500 },
    mechanism: 'provenance({ target: "search: …" })',
    fixture: ["prose recorded in an intent, a rationale, and a commit message"],
    grading: [
      "the subject is found from a hunch rather than an identity",
      "a search hit is a valid walk target (search → cause in two calls)",
    ],
    status: "covered-by-system-test",
    coveringTest:
      "skills/system-testing/tests/provenance-questions.ts › provenance-finds-a-subject-by-its-prose",
  },
  {
    question: "abduction",
    summary:
      "Flagship: three requests and two rejections downstream of one unstated axiom; the agent is asked to do something that violates it.",
    budget: { toolCalls: 4, renderedTokens: 4_000 },
    mechanism: "cause + cohort + rejections, then a stated-intent note edit",
    fixture: [
      "three user requests consistent with one unstated axiom",
      "two rejections of work that violated it",
      "a task that would violate it again",
    ],
    grading: [
      "the axiom is recovered before acting",
      "the recovered axiom is written as ordinary prose in a tracked file",
      "an inherited note is treated as a prior and revised when contradicted",
      "no phase regresses this scenario",
    ],
    status: "scaffolded",
  },
  {
    question: "adversarial/plan-gate",
    summary: "A query whose plan is pathological is refused pre-execution.",
    budget: { toolCalls: 1, renderedTokens: 300 },
    mechanism: "provenance({ query })",
    fixture: ["a relation large enough to exceed the full-scan threshold"],
    grading: ["the refusal is typed, names the offending term, and returns no rows"],
    status: "covered-by-unit-test",
    coveringTest: "workers/workspace-source/provenanceQuery.test.ts › the plan gate",
  },
  {
    question: "adversarial/mid-flight-abort",
    summary: "A streaming query that breaches the scan budget returns a partial with a refusal.",
    budget: { toolCalls: 1, renderedTokens: 500 },
    mechanism: "provenance({ query })",
    fixture: ["a cursor whose rowsRead exceeds the budget mid-stream"],
    grading: ["the refusal is distinct from the plan-gate refusal and carries the partial rows"],
    status: "covered-by-unit-test",
    coveringTest: "workers/workspace-source/provenanceQuery.test.ts › streamed execution",
  },
  {
    question: "adversarial/visibility-parity",
    summary: "Query-reachable ⇔ walk-reachable, per caller, in both directions.",
    budget: { toolCalls: 2, renderedTokens: 500 },
    mechanism: "provenance({ query }) and provenance({ walk })",
    fixture: ["a subject inside and a subject outside the caller's visible basis"],
    grading: ["the walk renders a labeled boundary exactly when the query returns no row"],
    status: "covered-by-unit-test",
    coveringTest:
      "workers/workspace-source/semanticWorkspace.provenanceQuery.test.ts › holds the visibility parity property",
  },
  {
    question: "adversarial/id-hygiene",
    summary:
      "On a deliberately less capable model, no surface requires transcribing a content-addressed identity.",
    budget: { toolCalls: 3, renderedTokens: 2_000 },
    mechanism: "every provenance and vcs surface",
    fixture: ["a subject reachable through walk, query, search, blame, and read memory"],
    grading: [
      "no rendered block contains a content-addressed identity",
      "a mangled @ref fails with a recovery hint, never a silent wrong answer",
    ],
    status: "covered-by-unit-test",
    coveringTest:
      "workers/workspace-source/semanticWorkspace.provenanceQuery.test.ts › never renders a raw content-addressed identity",
  },
];
