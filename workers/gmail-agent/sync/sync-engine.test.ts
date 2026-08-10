import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GmailAttentionDecision } from "@workspace/gmail/card-types";
import type { SqlStorage } from "@workspace/runtime/worker";
import { SyncEngine } from "./sync-engine.js";

/**
 * Fake SqlStorage that returns no rows for any query, simulating a thread that
 * is not in the local cache. Records executed statements so we can assert no
 * UPDATE ran when the row is missing.
 */
function emptySql(): { sql: SqlStorage; queries: string[] } {
  const queries: string[] = [];
  const sql: SqlStorage = {
    exec: (query: string) => {
      queries.push(query);
      return { toArray: () => [], one: () => ({}) };
    },
  };
  return { sql, queries };
}

function makeEngine(sql: SqlStorage): SyncEngine {
  return new SyncEngine({
    sql,
    gmailFor: () => ({}) as never,
    triage: {} as never,
    store: {} as never,
    people: {} as never,
    cards: { updateThread: vi.fn(async () => undefined) } as never,
    getChannelState: () => ({}) as never,
    saveChannelState: () => undefined,
    publishSetup: async () => undefined,
    now: () => 123,
  });
}

const DECISION: GmailAttentionDecision = {
  wake: true,
  directiveId: "triage",
  directiveName: "Triage: surfaced",
  reason: "matched",
  actions: ["surface"],
};

describe("SyncEngine.applyTriageDecision", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs and does not UPDATE when the thread row is missing (no silent drop)", async () => {
    const { sql, queries } = emptySql();
    const engine = makeEngine(sql);

    await engine.applyTriageDecision("ch-1", "thr-missing", DECISION);

    // The only statement run is the SELECT lookup; no UPDATE on a missing row.
    expect(queries.some((q) => q.includes("UPDATE gmail_threads"))).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("no cached thread row"));
  });
});
