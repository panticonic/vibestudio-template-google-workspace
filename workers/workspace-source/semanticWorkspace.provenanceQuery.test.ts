// Builtin semantic-authority tests for the agent-facing query surface.
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@vibestudio/content-addressing";
import { createInMemorySql } from "@vibestudio/durable/test-utils";
import {
  vcsQueryResultSchema,
  vcsSearchResultSchema,
  vcsWalkResultSchema,
  type VcsQueryResult,
  type VcsSearchResult,
  type VcsWalkResult,
} from "@vibestudio/service-schemas/vcs";
import {
  createSemanticVcsSchema,
  createTrajectoryMirrorSchema,
} from "./semanticVcsSchema.js";
import { PROV_CATALOG } from "./provenanceViews.js";
import {
  SemanticWorkspace,
  type SemanticDispatchRequest,
  type SemanticDispatchResult,
} from "./semanticWorkspace.js";
import { SemanticVcsStore } from "./semanticVcsStore.js";

const timestamp = "2026-08-14T00:00:00.000Z";
const ingress: SemanticDispatchRequest["ingress"] = {
  causalParent: {
    kind: "trajectory-invocation",
    logId: "trajectory:test",
    head: "main",
    invocationId: "invocation:test",
  },
  contextIntegrity: { class: "internal", externalKeys: [] },
};

function pending<T>(result: SemanticDispatchResult): T {
  if (result.kind !== "effects-pending") throw new Error("expected a materialization effect");
  return result.result as T;
}

function complete<T>(result: SemanticDispatchResult): T {
  if (result.kind !== "complete") throw new Error(`expected a complete result, got ${result.kind}`);
  return result.result as T;
}

/**
 * One fixture with the shape every canonical question needs: a stated human
 * request, work under it, a commit, and a rejection of that work.
 */
async function fixture() {
  const sql = await createInMemorySql();
  createSemanticVcsSchema(sql);
  createTrajectoryMirrorSchema(sql);
  sql.exec(`
    CREATE TABLE log_events (
      log_id TEXT NOT NULL, head TEXT NOT NULL, envelope_id TEXT NOT NULL,
      actor_json TEXT NOT NULL, payload_ref_json TEXT NOT NULL,
      PRIMARY KEY (log_id, head, envelope_id)
    )
  `);
  sql.exec(
    `INSERT INTO log_events (log_id, head, envelope_id, actor_json, payload_ref_json)
     VALUES ('trajectory:test', 'main', 'trajectory-event:prompt', ?, ?)`,
    JSON.stringify({ kind: "agent", id: "agent:test" }),
    JSON.stringify({
      role: "user",
      senderRef: { kind: "user", id: "user:alice" },
      blocks: [
        {
          blockId: "message-block:prompt",
          type: "text",
          content: "Cap the retry backoff at 30 seconds",
        },
      ],
    })
  );
  sql.exec(
    `INSERT INTO trajectory_messages
       (log_id, head, message_id, turn_id, role, status, started_event_id,
        completed_event_id, updated_at)
     VALUES ('trajectory:test', 'main', 'message:trigger', 'turn:test', 'user', 'completed',
             NULL, 'trajectory-event:prompt', ?)`,
    timestamp
  );
  sql.exec(
    `INSERT INTO trajectory_turns
       (log_id, head, turn_id, opened_at, closed_at, summary, ordinal, trigger_message_id)
     VALUES ('trajectory:test', 'main', 'turn:test', ?, NULL, 'Cap the backoff', 0,
             'message:trigger')`,
    timestamp
  );
  sql.exec(
    `INSERT INTO trajectory_invocations
       (log_id, head, invocation_id, turn_id, kind, status, terminal_outcome,
        request_ref_json, started_event_id, completed_event_id, updated_at)
     VALUES ('trajectory:test', 'main', 'invocation:test', 'turn:test', 'edit', 'active',
             NULL, NULL, NULL, NULL, ?)`,
    timestamp
  );
  const store = new SemanticVcsStore(sql, () => timestamp);
  let ordinal = 0;
  const semantic = new SemanticWorkspace({
    workspaceId: "workspace:test",
    sql,
    store,
    now: () => timestamp,
    transaction: <T>(fn: () => T): T => {
      const savepoint = `prov_test_${ordinal++}`;
      sql.exec(`SAVEPOINT ${savepoint}`);
      try {
        const value = fn();
        sql.exec(`RELEASE ${savepoint}`);
        return value;
      } catch (error) {
        sql.exec(`ROLLBACK TO ${savepoint}`);
        sql.exec(`RELEASE ${savepoint}`);
        throw error;
      }
    },
  });
  const acknowledge = (dispatch: SemanticDispatchResult): void => {
    if (dispatch.kind !== "effects-pending") throw new Error("mutation has no effect");
    for (const effect of dispatch.effects) {
      if (effect.kind !== "materialize-context") continue;
      const repositories = effect.payload["repositories"] as Array<{
        repositoryId: string;
        repoPath: string;
        presence: "present" | "deleted";
        source: { kind: "content-root"; contentRoot: string } | { kind: "delta" | "snapshot" };
      }>;
      semantic.acknowledgeEffect({
        effectId: effect.effectId,
        payloadDigest: effect.payloadDigest,
        receipt: {
          materializationId: effect.effectId,
          contextId: effect.payload["contextId"],
          targetState: effect.payload["targetState"],
          repositories: repositories
            .filter((repository) => repository.presence === "present")
            .map((repository) => ({
              repositoryId: repository.repositoryId,
              repoPath: repository.repoPath,
              contentRoot:
                repository.source.kind === "content-root"
                  ? repository.source.contentRoot
                  : `state:${sha256Hex(new TextEncoder().encode(JSON.stringify(repository)))}`,
            })),
          payloadDigest: effect.payloadDigest,
        },
      });
    }
  };

  const initial = store.initializeWorkspace("context:test", "command:genesis");
  const createDispatch = await semantic.dispatch("edit", {
    ingress,
    input: {
      contextId: "context:test",
      commandId: "command:create",
      expectedWorkingHead: initial.working.ref,
      changes: [
        {
          kind: "repository-create",
          repoPath: "packages/fixture",
          files: [
            {
              path: "retry.ts",
              content: { kind: "text", text: "export const backoffMs = 5_000;\n" },
              mode: 0o644,
            },
          ],
        },
      ],
    },
  });
  const created = pending<{
    workingHead: { kind: "application"; applicationId: string };
    changeIds: string[];
  }>(createDispatch);
  acknowledge(createDispatch);
  const commitDispatch = await semantic.dispatch("commit", {
    ingress,
    input: {
      contextId: "context:test",
      commandId: "command:commit",
      expectedWorkingHead: created.workingHead,
      message: "Add the retry module",
    },
  });
  const committed = pending<{ event: { kind: "event"; eventId: string } }>(commitDispatch);
  acknowledge(commitDispatch);

  const root = store.stateRoot(committed.event);
  const repository = store.facts.entries(root, "repository")[0]!;
  const repositoryId = repository.key;
  const file = store.facts.fileAtPath(root, repositoryId, "retry.ts")!;

  const capDispatch = await semantic.dispatch("edit", {
    ingress,
    input: {
      contextId: "context:test",
      commandId: "command:cap",
      expectedWorkingHead: committed.event,
      intentSummary: "Cap the retry backoff at 30 seconds",
      changes: [
        {
          kind: "text-edit",
          repositoryId,
          fileId: file.state.fileId,
          edits: [{ start: 25, end: 30, text: "30_000" }],
        },
      ],
    },
  });
  const observedCapDispatch = ((): SemanticDispatchResult => {
    if (capDispatch.kind !== "effects-pending") throw new Error("text edit did not request bytes");
    const observation = capDispatch.effects.find((effect) => effect.kind === "observe-content");
    if (!observation) return capDispatch;
    const baseText = "export const backoffMs = 5_000;\n";
    return semantic.acknowledgeEffect({
      effectId: observation.effectId,
      payloadDigest: observation.payloadDigest,
      receipt: {
        files: [
          {
            contentHash: sha256Hex(new TextEncoder().encode(baseText)),
            base64: btoa(baseText),
          },
        ],
      },
    });
  })();
  const capped = pending<{
    workingHead: { kind: "application"; applicationId: string };
    changeIds: string[];
    workUnitId: string;
  }>(observedCapDispatch);
  acknowledge(observedCapDispatch);
  const capCommitDispatch = await semantic.dispatch("commit", {
    ingress,
    input: {
      contextId: "context:test",
      commandId: "command:cap-commit",
      expectedWorkingHead: capped.workingHead,
      message: "Cap the backoff",
    },
  });
  const capCommit = pending<{ event: { kind: "event"; eventId: string } }>(capCommitDispatch);
  acknowledge(capCommitDispatch);

  const revertDispatch = await semantic.dispatch("revert", {
    ingress,
    input: {
      contextId: "context:test",
      commandId: "command:revert-cap",
      expectedWorkingHead: capCommit.event,
      changeIds: capped.changeIds,
      intentSummary: "This deploy target kills long-lived connections; do not cap the backoff",
    },
  });
  const reverted = pending<{
    workingHead: { kind: "application"; applicationId: string };
    workUnitId: string;
  }>(revertDispatch);
  acknowledge(revertDispatch);

  return {
    sql,
    store,
    semantic,
    repositoryId,
    fileId: file.state.fileId,
    capped,
    reverted,
    workingHead: reverted.workingHead,
  };
}

const walk = async (
  semantic: SemanticWorkspace,
  input: Record<string, unknown>
): Promise<VcsWalkResult> =>
  vcsWalkResultSchema.parse(complete(await semantic.dispatch("walk", { ingress, input })));

const query = async (
  semantic: SemanticWorkspace,
  input: Record<string, unknown>
): Promise<VcsQueryResult> =>
  vcsQueryResultSchema.parse(complete(await semantic.dispatch("query", { ingress, input })));

const search = async (
  semantic: SemanticWorkspace,
  input: Record<string, unknown>
): Promise<VcsSearchResult> =>
  vcsSearchResultSchema.parse(complete(await semantic.dispatch("search", { ingress, input })));

const column = (result: VcsQueryResult, name: string): Array<string | number | boolean | null> => {
  const index = result.columns.indexOf(name);
  return index === -1 ? [] : result.rows.map((row) => row[index] ?? null);
};

describe("provenance walks", () => {
  it("answers Q2 with one causal spine from an artifact to the human statement", async () => {
    const { semantic, fileId, repositoryId, workingHead } = await fixture();
    const result = await walk(semantic, {
      contextId: "context:test",
      walk: "cause",
      subject: { kind: "file", state: workingHead, repositoryId, fileId },
      visibilityContextIds: ["context:test"],
    });
    const labels = result.entries.map((entry) => entry.label);
    expect(labels.some((label) => label.startsWith("work unit"))).toBe(true);
    expect(labels.some((label) => label.startsWith("command"))).toBe(true);
    expect(labels.some((label) => label.startsWith("tool invocation"))).toBe(true);
    expect(labels.some((label) => label.startsWith("message"))).toBe(true);
    const terminal = result.entries.at(-1)!;
    expect(terminal.boundary).toBe("human-statement");
    // The statement is the answer the walk exists to deliver, so it travels as
    // prose the renderer will show in full, not as a compacted incidental
    // detail. Q2 previously reached this entry and then truncated the request.
    expect(terminal.statement).toEqual({
      text: "Cap the retry backoff at 30 seconds",
      sender: "user",
    });
    const intents = result.entries.flatMap((entry) => (entry.intent ? [entry.intent] : []));
    expect(intents[0]).toMatchObject({ tier: "stated" });
  });

  it("carries the requester's words beside an author's summary", async () => {
    const { semantic, capped } = await fixture();
    const result = await walk(semantic, {
      contextId: "context:test",
      walk: "cause",
      subject: { kind: "work-unit", workUnitId: capped.workUnitId },
      visibilityContextIds: ["context:test"],
    });
    // The resolved rung stays `stated` — the ladder is untouched — but the
    // statement that summary interpreted is no longer discarded at write time.
    const work = result.entries.find((entry) => entry.label.startsWith("work unit"))!;
    expect(work.intent).toMatchObject({ tier: "stated" });
    expect(work.statement?.text).toContain("Cap the retry backoff");
  });

  it("answers Q3 with the cohort of everything the same command touched", async () => {
    const { semantic, capped } = await fixture();
    const result = await walk(semantic, {
      contextId: "context:test",
      walk: "cohort",
      scope: "command",
      subject: { kind: "work-unit", workUnitId: capped.workUnitId },
      visibilityContextIds: ["context:test"],
    });
    expect(result.scope).toBe("command");
    expect(result.entries.some((entry) => entry.group === "work")).toBe(true);
    expect(
      result.entries.some((entry) => entry.group === "coordinates" && entry.label.includes("retry.ts"))
    ).toBe(true);
    expect(result.entries.some((entry) => entry.group === "commits")).toBe(true);
  });

  it("answers Q6 with the rejection and the intent that explains it", async () => {
    const { semantic, fileId, repositoryId, workingHead } = await fixture();
    const result = await walk(semantic, {
      contextId: "context:test",
      walk: "rejections",
      subject: { kind: "file", state: workingHead, repositoryId, fileId },
      visibilityContextIds: ["context:test"],
    });
    const counteraction = result.entries.find((entry) => entry.group === "counteractions");
    expect(counteraction).toBeTruthy();
    expect(counteraction?.intent?.text).toContain("kills long-lived connections");
    expect(counteraction?.detail).toContain("Cap the retry backoff at 30 seconds");
    expect(result.entries.some((entry) => entry.group === "reverts")).toBe(true);
  });

  it("renders a labeled boundary instead of crossing the caller's visibility basis", async () => {
    const { semantic, fileId, repositoryId, workingHead } = await fixture();
    const result = await walk(semantic, {
      contextId: "context:test",
      walk: "cause",
      subject: { kind: "file", state: workingHead, repositoryId, fileId },
      visibilityContextIds: [],
    });
    expect(result.entries.at(-1)?.boundary).toBe("outside-visibility");
  });

  it("never renders a raw content-addressed identity in a label, detail, or note", async () => {
    const { semantic, fileId, repositoryId, workingHead, capped } = await fixture();
    const results = [
      await walk(semantic, {
        contextId: "context:test",
        walk: "cause",
        subject: { kind: "file", state: workingHead, repositoryId, fileId },
        visibilityContextIds: ["context:test"],
      }),
      await walk(semantic, {
        contextId: "context:test",
        walk: "cohort",
        subject: { kind: "work-unit", workUnitId: capped.workUnitId },
        visibilityContextIds: ["context:test"],
      }),
      await walk(semantic, {
        contextId: "context:test",
        walk: "rejections",
        subject: { kind: "file", state: workingHead, repositoryId, fileId },
        visibilityContextIds: ["context:test"],
      }),
    ];
    for (const result of results) {
      for (const entry of result.entries) {
        for (const text of [entry.label, entry.detail ?? "", entry.intent?.text ?? ""]) {
          expect(text).not.toMatch(/[0-9a-f]{32}/u);
        }
      }
      for (const note of result.notes) expect(note).not.toMatch(/[0-9a-f]{32}/u);
    }
  });
});

describe("the prov_* relational contract", () => {
  it("returns work units with the persisted resolved intent", async () => {
    const { semantic } = await fixture();
    const result = await query(semantic, {
      contextId: "context:test",
      query:
        "SELECT work_unit_id, kind, intent_tier, intent_text, resolver_protocol FROM prov_work_units",
      visibilityContextIds: ["context:test"],
    });
    expect(result.refusal).toBeNull();
    expect(result.rows.length).toBeGreaterThan(0);
    expect(column(result, "intent_text")).toContain("Cap the retry backoff at 30 seconds");
    expect(new Set(column(result, "resolver_protocol"))).toEqual(new Set(["intent-ladder/v1"]));
    expect(new Set(column(result, "intent_tier"))).not.toContain(null);
  });

  it("makes every relation it advertises selectable", async () => {
    const { semantic } = await fixture();
    const catalog = await query(semantic, {
      contextId: "context:test",
      query: "SELECT DISTINCT relation FROM prov_schema",
      visibilityContextIds: ["context:test"],
    });
    const relations = column(catalog, "relation").map(String);
    expect(relations.length).toBeGreaterThan(15);
    for (const relation of relations) {
      const result = await query(semantic, {
        contextId: "context:test",
        query: `SELECT * FROM ${relation}`,
        visibilityContextIds: ["context:test"],
      });
      expect(result.refusal, relation).toBeNull();
    }
  });

  it("pins file coordinates to the caller's visible basis", async () => {
    const { semantic } = await fixture();
    const result = await query(semantic, {
      contextId: "context:test",
      query: "SELECT path, presence FROM prov_files",
      visibilityContextIds: ["context:test"],
    });
    expect(result.refusal).toBeNull();
    expect(column(result, "path")).toContain("retry.ts");
    expect(column(result, "presence")).toContain("placed");
  });

  it("reaches the trajectory mirror through the same visibility basis", async () => {
    const { semantic } = await fixture();
    const result = await query(semantic, {
      contextId: "context:test",
      query: `SELECT message.role AS role, message.sender_kind AS sender_kind,
                     message.text_excerpt AS excerpt
                FROM prov_messages message`,
      visibilityContextIds: ["context:test"],
    });
    expect(result.refusal).toBeNull();
    expect(column(result, "excerpt")).toContain("Cap the retry backoff at 30 seconds");
    expect(column(result, "sender_kind")).toContain("user");
  });

  it("describes itself through the catalog view", async () => {
    const { semantic } = await fixture();
    const result = await query(semantic, {
      contextId: "context:test",
      query: "SELECT relation, meaning, columns FROM prov_schema WHERE relation = 'prov_changes'",
      visibilityContextIds: ["context:test"],
    });
    expect(result.refusal).toBeNull();
    expect(String(column(result, "columns")[0])).toContain("effect_digest");
  });

  it("fits the whole contract in one default page, or it is not discoverable", async () => {
    const { semantic } = await fixture();
    // The taught first move must complete. A catalog that overflows the page it
    // is read with teaches an agent only its alphabetically-first relations.
    const result = await query(semantic, {
      contextId: "context:test",
      query: "SELECT relation, meaning, column_count FROM prov_schema",
      visibilityContextIds: ["context:test"],
    });
    expect(result.refusal).toBeNull();
    expect(result.truncated).toBe(false);
    expect(result.rows.length).toBe(PROV_CATALOG.length);
  });

  it("does not refuse a statement whose plan is legitimately empty", async () => {
    const { semantic } = await fixture();
    // The catalog scans no table at all. Treating "no plan rows" as "no plan"
    // refused the cheapest queries in the contract.
    const result = await query(semantic, {
      contextId: "context:test",
      query: "SELECT version FROM prov_schema_version",
      visibilityContextIds: ["context:test"],
    });
    expect(result.refusal).toBeNull();
    expect(result.rows.length).toBe(1);
  });

  it("joins the record as a database: rejected coordinates by intent tier", async () => {
    const { semantic } = await fixture();
    const result = await query(semantic, {
      contextId: "context:test",
      query: `SELECT work.intent_tier AS tier, count(*) AS rejected
                FROM prov_counteractions counteraction
                JOIN prov_changes change ON change.change_id = counteraction.change_id
                JOIN prov_work_units work ON work.work_unit_id = change.work_unit_id
               GROUP BY work.intent_tier`,
      visibilityContextIds: ["context:test"],
    });
    expect(result.refusal).toBeNull();
    expect(result.rows.length).toBe(1);
    expect(column(result, "tier")).toEqual(["stated"]);
  });

  it("scopes every row to the caller's visibility basis", async () => {
    const { semantic } = await fixture();
    const visible = await query(semantic, {
      contextId: "context:test",
      query: "SELECT work_unit_id FROM prov_work_units",
      visibilityContextIds: ["context:test"],
    });
    const invisible = await query(semantic, {
      contextId: "context:test",
      query: "SELECT work_unit_id FROM prov_work_units",
      visibilityContextIds: [],
    });
    expect(visible.rows.length).toBeGreaterThan(0);
    expect(invisible.rows).toEqual([]);
  });

  it("holds the visibility parity property in both directions", async () => {
    const { semantic, capped } = await fixture();
    for (const contextIds of [["context:test"], []]) {
      const rows = await query(semantic, {
        contextId: "context:test",
        query: `SELECT work_unit_id FROM prov_work_units WHERE work_unit_id = '${capped.workUnitId}'`,
        visibilityContextIds: contextIds,
      });
      const walked = await walk(semantic, {
        contextId: "context:test",
        walk: "cause",
        subject: { kind: "work-unit", workUnitId: capped.workUnitId },
        visibilityContextIds: contextIds,
      });
      const walkReachable = walked.entries.every((entry) => entry.boundary !== "outside-visibility");
      expect(rows.rows.length > 0).toBe(walkReachable);
    }
  });

  it("refuses a statement that is not one SELECT before it runs", async () => {
    const { semantic } = await fixture();
    const result = await query(semantic, {
      contextId: "context:test",
      query: "DELETE FROM prov_work_units",
      visibilityContextIds: ["context:test"],
    });
    expect(result.refusal).toMatchObject({ stage: "validation", code: "not-a-select" });
    expect(result.rows).toEqual([]);
  });

  it("refuses a canonical table by name and points at the catalog", async () => {
    const { semantic } = await fixture();
    const result = await query(semantic, {
      contextId: "context:test",
      query: "SELECT * FROM gad_work_units",
      visibilityContextIds: ["context:test"],
    });
    expect(result.refusal).toMatchObject({
      stage: "validation",
      code: "unknown-relation",
      term: "gad_work_units",
    });
    expect(result.refusal?.message).toContain("prov_schema");
  });

  it("refuses a private object in any syntactic position, not only after FROM", async () => {
    const { semantic } = await fixture();
    for (const attempt of [
      "SELECT * FROM prov_events, gad_work_units",
      "SELECT * FROM prov_events event, vcs_command_journal command WHERE command.command_id = event.event_id",
      "SELECT * FROM prov_events, prov_search_index",
      "SELECT * FROM prov_events WHERE event_id IN (SELECT event_id FROM prov_vis_events)",
    ]) {
      const result = await query(semantic, {
        contextId: "context:test",
        query: attempt,
        visibilityContextIds: ["context:test"],
      });
      expect(result.refusal).toMatchObject({ stage: "validation", code: "unknown-relation" });
      expect(result.rows).toEqual([]);
    }
    const prose = await query(semantic, {
      contextId: "context:test",
      query: "SELECT event_id FROM prov_events WHERE message = 'gad_work_units'",
      visibilityContextIds: ["context:test"],
    });
    expect(prose.refusal).toBeNull();
  });

  it("refuses recursion, which is what walks are for", async () => {
    const { semantic } = await fixture();
    const result = await query(semantic, {
      contextId: "context:test",
      query:
        "WITH RECURSIVE chain(id) AS (SELECT work_unit_id FROM prov_work_units) SELECT * FROM chain",
      visibilityContextIds: ["context:test"],
    });
    expect(result.refusal).toMatchObject({ stage: "validation", code: "recursive-cte" });
  });

  it("refuses a second statement smuggled after a semicolon", async () => {
    const { semantic } = await fixture();
    const result = await query(semantic, {
      contextId: "context:test",
      query: "SELECT work_unit_id FROM prov_work_units; DROP TABLE gad_work_units",
      visibilityContextIds: ["context:test"],
    });
    expect(result.refusal).toMatchObject({ stage: "validation", code: "not-a-select" });
  });

  it("survives a canonical-table refactor that preserves view semantics", async () => {
    const { semantic, sql } = await fixture();
    const before = await query(semantic, {
      contextId: "context:test",
      query: "SELECT work_unit_id, intent_tier FROM prov_work_units ORDER BY work_unit_id",
      visibilityContextIds: ["context:test"],
    });
    // A private refactor: the resolved-intent columns move to a side table and
    // the view re-projects them. Every agent surface must be unaffected.
    sql.exec(
      `CREATE TABLE gad_work_unit_intents AS
         SELECT work_unit_id, resolved_intent_text, resolved_intent_tier, resolver_protocol
           FROM gad_work_units`
    );
    sql.exec(`DROP VIEW prov_work_units`);
    sql.exec(`
      CREATE VIEW prov_work_units AS
        SELECT work.work_unit_id AS work_unit_id, work.kind AS kind,
               intent.resolved_intent_tier AS intent_tier,
               intent.resolved_intent_text AS intent_text,
               intent.resolver_protocol AS resolver_protocol,
               work.author_context_id AS author_context_id,
               work.command_id AS command_id, work.created_at AS created_at,
               work.content_class AS content_class
          FROM gad_work_units work
          JOIN gad_work_unit_intents intent ON intent.work_unit_id = work.work_unit_id
          JOIN gad_work_unit_applications app ON app.work_unit_id = work.work_unit_id
          JOIN prov_vis_applications vis ON vis.application_id = app.application_id
    `);
    const after = await query(semantic, {
      contextId: "context:test",
      query: "SELECT work_unit_id, intent_tier FROM prov_work_units ORDER BY work_unit_id",
      visibilityContextIds: ["context:test"],
    });
    expect(after.rows).toEqual(before.rows);
  });
});

describe("persisted resolved intent", () => {
  it("equals the one loader's output for every work unit", async () => {
    const { semantic, sql } = await fixture();
    const persisted = sql
      .exec(
        `SELECT work_unit_id, resolved_intent_text, resolved_intent_tier FROM gad_work_units`
      )
      .toArray() as Array<Record<string, unknown>>;
    expect(persisted.length).toBeGreaterThan(0);
    for (const row of persisted) {
      const dispatch = await semantic.dispatch("inspect", {
        ingress,
        input: { node: { kind: "work-unit", workUnitId: String(row["work_unit_id"]) }, edgeLimit: 1 },
      });
      const loaded = (complete<Record<string, unknown>>(dispatch)["node"] as Record<string, unknown>)[
        "value"
      ] as { intent: { text: string; tier: string } };
      expect(row["resolved_intent_text"]).toBe(loaded.intent.text);
      expect(row["resolved_intent_tier"]).toBe(loaded.intent.tier);
    }
  });

  it("is restored by the recompute migration a resolver-protocol change ships with", async () => {
    const { semantic, sql } = await fixture();
    const before = sql
      .exec(`SELECT work_unit_id, resolved_intent_text FROM gad_work_units ORDER BY work_unit_id`)
      .toArray();
    sql.exec(
      `UPDATE gad_work_units
          SET resolved_intent_text = 'stale from protocol v0',
              resolved_intent_tier = 'mechanical',
              resolver_protocol = 'intent-ladder/v0'`
    );
    const stale = await query(semantic, {
      contextId: "context:test",
      query: "SELECT DISTINCT resolver_protocol FROM prov_work_units",
      visibilityContextIds: ["context:test"],
    });
    expect(column(stale, "resolver_protocol")).toEqual(["intent-ladder/v0"]);
    expect(semantic.recomputeResolvedIntents().recomputed).toBe(before.length);
    const after = sql
      .exec(`SELECT work_unit_id, resolved_intent_text FROM gad_work_units ORDER BY work_unit_id`)
      .toArray();
    expect(after).toEqual(before);
    const restored = await query(semantic, {
      contextId: "context:test",
      query: "SELECT DISTINCT resolver_protocol FROM prov_work_units",
      visibilityContextIds: ["context:test"],
    });
    expect(column(restored, "resolver_protocol")).toEqual(["intent-ladder/v1"]);
  });
});

describe("entry by content", () => {
  it("finds a work unit by its recorded prose and hands back a walkable subject", async () => {
    const { semantic } = await fixture();
    const result = await search(semantic, {
      contextId: "context:test",
      text: "backoff",
      visibilityContextIds: ["context:test"],
    });
    expect(result.hits.length).toBeGreaterThan(0);
    const hit = result.hits.find((candidate) => candidate.subjectKind === "work-unit");
    expect(hit).toBeTruthy();
    const walked = await walk(semantic, {
      contextId: "context:test",
      walk: "cause",
      subject: hit!.node,
      visibilityContextIds: ["context:test"],
    });
    expect(walked.entries.length).toBeGreaterThan(0);
  });

  it("scopes hits to the caller's visibility basis", async () => {
    const { semantic } = await fixture();
    const result = await search(semantic, {
      contextId: "context:test",
      text: "backoff",
      visibilityContextIds: [],
    });
    expect(result.hits).toEqual([]);
  });

  it("round-trips a rebuild of the derived index", async () => {
    const { semantic, sql } = await fixture();
    const before = await search(semantic, {
      contextId: "context:test",
      text: "connections",
      visibilityContextIds: ["context:test"],
    });
    expect(before.hits.length).toBeGreaterThan(0);
    sql.exec(`DELETE FROM prov_search_index`);
    const empty = await search(semantic, {
      contextId: "context:test",
      text: "connections",
      visibilityContextIds: ["context:test"],
    });
    expect(empty.hits).toEqual([]);
    expect(semantic.rebuildProvenanceSearchIndex().indexed).toBeGreaterThan(0);
    const after = await search(semantic, {
      contextId: "context:test",
      text: "connections",
      visibilityContextIds: ["context:test"],
    });
    expect(after.hits.map((hit) => hit.node)).toEqual(before.hits.map((hit) => hit.node));
  });

  it("finds a commit message and the human statement that caused the work", async () => {
    const { semantic } = await fixture();
    const commits = await search(semantic, {
      contextId: "context:test",
      text: "retry module",
      visibilityContextIds: ["context:test"],
    });
    expect(commits.hits.some((hit) => hit.subjectKind === "event")).toBe(true);
  });
});
