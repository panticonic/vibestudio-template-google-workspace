/**
 * Compact serializers + run persistence.
 *
 * Eval convention: `scope.testkitRun = result; return summarize(result);`
 * Full runs are persisted to context fs under /.testkit/runs/ for the
 * testbench panel's history view.
 */
import type { SuiteRunResult, TestCaseResult } from "./run.js";

// Lazy: keeps summarize() importable outside a live runtime (vitest).
async function getFs() {
  const runtime = await import("@workspace/runtime");
  return runtime.fs;
}

const RUNS_DIR = "/.testkit/runs";

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  duration: number;
  failures: Array<{
    suite: string;
    name: string;
    status: TestCaseResult["status"];
    error?: string;
    logsTail?: string[];
  }>;
}

export function summarize(result: SuiteRunResult, opts?: { maxFailures?: number }): RunSummary {
  const failures = result.results
    .filter((r) => r.status !== "passed" && r.status !== "skipped")
    .slice(0, opts?.maxFailures ?? 10)
    .map((r) => ({
      suite: r.suite,
      name: r.name,
      status: r.status,
      error: r.error?.message.slice(0, 400),
      logsTail: r.logs.length > 0 ? r.logs.slice(-3) : undefined,
    }));
  return {
    total: result.total,
    passed: result.passed,
    failed: result.failed,
    errored: result.errored,
    skipped: result.skipped,
    duration: result.duration,
    failures,
  };
}

export interface SavedRunRef {
  path: string;
  savedAt: number;
  summary: RunSummary;
  label?: string;
}

export async function saveRun(result: SuiteRunResult, opts?: { label?: string }): Promise<SavedRunRef> {
  const fs = await getFs();
  await fs.mkdir(RUNS_DIR, { recursive: true });
  const savedAt = Date.now();
  const path = `${RUNS_DIR}/${new Date(savedAt).toISOString().replace(/[:.]/g, "-")}.json`;
  const ref: SavedRunRef = { path, savedAt, summary: summarize(result), label: opts?.label };
  await fs.writeFile(path, JSON.stringify({ ...ref, result }, null, 2));
  return ref;
}

export async function listRuns(): Promise<SavedRunRef[]> {
  const fs = await getFs();
  let files: string[];
  try {
    files = await fs.readdir(RUNS_DIR);
  } catch {
    return [];
  }
  const refs: SavedRunRef[] = [];
  for (const file of files.filter((name) => name.endsWith(".json")).sort().reverse()) {
    try {
      const raw = (await fs.readFile(`${RUNS_DIR}/${file}`, "utf8")) as string;
      const parsed = JSON.parse(raw) as SavedRunRef;
      refs.push({ path: parsed.path, savedAt: parsed.savedAt, summary: parsed.summary, label: parsed.label });
    } catch {
      // Skip corrupt entries rather than failing the listing.
    }
  }
  return refs;
}

export async function loadRun(path: string): Promise<SuiteRunResult> {
  const fs = await getFs();
  const raw = (await fs.readFile(path, "utf8")) as string;
  const parsed = JSON.parse(raw) as { result: SuiteRunResult };
  return parsed.result;
}
