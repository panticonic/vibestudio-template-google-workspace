// Builtin semantic-authority tests.
import { describe, expect, it } from "vitest";
import { createInMemorySql } from "@vibestudio/durable/test-utils";
import { createSemanticVcsSchema } from "./semanticVcsSchema.js";
import { SemanticVcsStore } from "./semanticVcsStore.js";
import { SemanticWorkspace } from "./semanticWorkspace.js";

const timestamp = "2026-07-16T00:00:00.000Z";

describe("SemanticWorkspace causal provenance reachability", () => {
  it("finds a maximal merge base across deep shared history without recursive JS or pairwise ancestry scans", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    const store = new SemanticVcsStore(sql, () => timestamp);
    const initial = store.initializeWorkspace("context:deep", "command:deep-genesis");
    const genesisEventId = initial.committed.ref.eventId;
    const root = store.stateRoot(initial.committed.ref);
    const depth = 6_000;
    sql.exec(
      `WITH RECURSIVE sequence(n) AS (
         SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
       )
       INSERT INTO gad_workspace_events
       (event_id, command_id, kind, result_workspace_fact_root_id, message, created_at)
       SELECT 'event:deep:' || printf('%05d', n),
              'command:deep:' || printf('%05d', n),
              'commit', ?, NULL, ?
         FROM sequence`,
      depth,
      root,
      timestamp
    );
    sql.exec(
      `WITH RECURSIVE sequence(n) AS (
         SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
       )
       INSERT INTO gad_workspace_event_parents (event_id, ordinal, parent_event_id)
       SELECT 'event:deep:' || printf('%05d', n), 0,
              CASE WHEN n = 1 THEN ? ELSE 'event:deep:' || printf('%05d', n - 1) END
         FROM sequence`,
      depth,
      genesisEventId
    );
    const sharedTip = `event:deep:${String(depth).padStart(5, "0")}`;
    for (const eventId of ["event:deep:target", "event:deep:source"]) {
      sql.exec(
        `INSERT INTO gad_workspace_events
         (event_id, command_id, kind, result_workspace_fact_root_id, message, created_at)
         VALUES (?, ?, 'commit', ?, NULL, ?)`,
        eventId,
        `command:${eventId}`,
        root,
        timestamp
      );
      sql.exec(
        `INSERT INTO gad_workspace_event_parents (event_id, ordinal, parent_event_id)
         VALUES (?, 0, ?)`,
        eventId,
        sharedTip
      );
    }
    const semantic = new SemanticWorkspace({
      workspaceId: "workspace:deep",
      sql,
      store,
      now: () => timestamp,
      transaction: <T>(fn: () => T): T => fn(),
    });
    const comparison = await semantic.dispatch("compare", {
      ingress: {
        causalParent: null,
        contextIntegrity: { class: "internal", externalKeys: [] },
      },
      input: {
        target: { kind: "event", eventId: "event:deep:target" },
        source: { kind: "event", eventId: "event:deep:source" },
        limit: 1,
      },
    });
    expect(comparison).toMatchObject({
      kind: "complete",
      result: {
        base: { kind: "event", eventId: sharedTip },
        coordinates: [],
      },
    });
  });

  it("shares protected-main history without exposing unpublished sibling branches", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    const store = new SemanticVcsStore(sql, () => timestamp);
    const initial = store.initializeWorkspace("context:own", "command:genesis");
    const genesisEventId = initial.committed.ref.eventId;
    const root = store.stateRoot(initial.committed.ref);

    for (const [eventId, commandId] of [
      ["event:own-private", "command:own-private"],
      ["event:published", "command:published"],
      ["event:foreign-private", "command:foreign-private"],
    ]) {
      sql.exec(
        `INSERT INTO gad_workspace_events
         (event_id, command_id, kind, result_workspace_fact_root_id, message, created_at)
         VALUES (?, ?, 'commit', ?, NULL, ?)`,
        eventId,
        commandId,
        root,
        timestamp
      );
      sql.exec(
        `INSERT INTO gad_workspace_event_parents (event_id, ordinal, parent_event_id)
         VALUES (?, 0, ?)`,
        eventId,
        genesisEventId
      );
    }
    sql.exec(
      `UPDATE vcs_contexts SET committed_event_id = ?, updated_at = ? WHERE context_id = ?`,
      "event:own-private",
      timestamp,
      "context:own"
    );
    sql.exec(
      `UPDATE vcs_workspace_heads SET event_id = ?, updated_at = ? WHERE head = 'main'`,
      "event:published",
      timestamp
    );
    for (const [applicationId, workUnitId, eventId] of [
      ["application:published", "work-unit:published", "event:published"],
      ["application:foreign-private", "work-unit:foreign-private", "event:foreign-private"],
    ]) {
      sql.exec(
        `INSERT INTO gad_work_unit_applications
         (application_id, work_unit_id, basis_kind, basis_id,
          result_workspace_fact_root_id, semantic_protocol)
         VALUES (?, ?, 'event', ?, ?, 'semantic:test')`,
        applicationId,
        workUnitId,
        genesisEventId,
        root
      );
      sql.exec(
        `INSERT INTO gad_workspace_event_applications (event_id, ordinal, application_id)
         VALUES (?, 0, ?)`,
        eventId,
        applicationId
      );
    }

    const semantic = new SemanticWorkspace({
      workspaceId: "workspace:test",
      sql,
      store,
      now: () => timestamp,
      transaction: <T>(fn: () => T): T => fn(),
    });
    const reachable = (eventId: string, contextIds = ["context:own"]) =>
      semantic.referencesReachable(contextIds, [{ kind: "event", value: eventId }]);

    expect(reachable("event:own-private")).toBe(true);
    expect(reachable("event:published")).toBe(true);
    expect(reachable(genesisEventId)).toBe(true);
    expect(reachable("event:foreign-private")).toBe(false);
    expect(reachable("event:published", ["context:missing"])).toBe(false);
    expect(
      semantic.referencesReachable(
        ["context:own"],
        [
          {
            kind: "node",
            value: { kind: "work-unit", workUnitId: "work-unit:published" },
          },
        ]
      )
    ).toBe(true);
    expect(
      semantic.referencesReachable(
        ["context:own"],
        [
          {
            kind: "node",
            value: { kind: "work-unit", workUnitId: "work-unit:foreign-private" },
          },
        ]
      )
    ).toBe(false);

    sql.exec(
      `INSERT INTO gad_work_unit_applications
       (application_id, work_unit_id, basis_kind, basis_id,
        result_workspace_fact_root_id, semantic_protocol)
       VALUES ('application:integration', 'work-unit:integration', 'event', ?,
               ?, 'semantic:test')`,
      "event:own-private",
      root
    );
    sql.exec(
      `INSERT INTO gad_integration_decisions
       (decision_id, target_state_kind, target_state_id, source_event_id,
        work_unit_id, created_at, source_delta_id)
       VALUES ('decision:integration', 'event', ?, 'event:foreign-private',
               'work-unit:integration', ?, NULL)`,
      "event:own-private",
      timestamp
    );
    sql.exec(
      `UPDATE vcs_contexts
          SET working_head_application_id = ?, updated_at = ?
        WHERE context_id = ?`,
      "application:integration",
      timestamp,
      "context:own"
    );
    expect(reachable("event:foreign-private")).toBe(true);
    expect(
      semantic.referencesReachable(
        ["context:own"],
        [
          {
            kind: "node",
            value: { kind: "work-unit", workUnitId: "work-unit:foreign-private" },
          },
        ]
      )
    ).toBe(true);
  });

  it("follows only normalized command-to-invocation, turn, and trigger-message edges", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    sql.exec(`
      CREATE TABLE trajectory_invocations (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        turn_id TEXT,
        kind TEXT,
        status TEXT NOT NULL,
        terminal_outcome TEXT,
        request_ref_json TEXT,
        started_event_id TEXT,
        completed_event_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, invocation_id)
      );
      CREATE TABLE trajectory_turns (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        opened_at TEXT,
        closed_at TEXT,
        summary TEXT,
        ordinal INTEGER,
        trigger_message_id TEXT,
        PRIMARY KEY (log_id, head, turn_id)
      );
      CREATE TABLE trajectory_messages (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        message_id TEXT NOT NULL,
        turn_id TEXT,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        started_event_id TEXT,
        completed_event_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, message_id)
      )
    `);

    const store = new SemanticVcsStore(sql, () => timestamp);
    const initial = store.initializeWorkspace("context:own", "command:genesis");
    const basis = initial.working.ref;
    if (basis.kind !== "event") throw new Error("genesis did not produce an event basis");
    const root = store.stateRoot(basis);

    sql.exec(
      `INSERT INTO trajectory_turns
       (log_id, head, turn_id, opened_at, closed_at, summary, ordinal, trigger_message_id)
       VALUES
       ('trajectory:own', 'main', 'turn:causal', ?, NULL, 'Causal intent', 0, 'message:causal'),
       ('trajectory:own', 'main', 'turn:sibling', ?, NULL, 'Unrelated intent', 1, 'message:sibling')`,
      timestamp,
      timestamp
    );
    sql.exec(
      `INSERT INTO trajectory_messages
       (log_id, head, message_id, turn_id, role, status, started_event_id,
        completed_event_id, updated_at)
       VALUES
       ('trajectory:own', 'main', 'message:causal', NULL, 'user', 'completed', NULL, NULL, ?),
       ('trajectory:own', 'main', 'message:sibling', NULL, 'user', 'completed', NULL, NULL, ?)`,
      timestamp,
      timestamp
    );
    sql.exec(
      `INSERT INTO trajectory_invocations
       (log_id, head, invocation_id, turn_id, kind, status, terminal_outcome,
        request_ref_json, started_event_id, completed_event_id, updated_at)
       VALUES
       ('trajectory:own', 'main', 'invocation:causal', 'turn:causal', 'vcs', 'completed',
        'completed', NULL, NULL, NULL, ?),
       ('trajectory:own', 'main', 'invocation:sibling', 'turn:sibling', 'vcs', 'completed',
        'completed', NULL, NULL, NULL, ?)`,
      timestamp,
      timestamp
    );
    sql.exec(
      `INSERT INTO vcs_command_journal
       (command_id, scope_kind, scope_id, method, request_digest,
        cause_log_id, cause_head, cause_invocation_id, status, result_json,
        created_at, completed_at)
       VALUES ('command:causal', 'context', 'context:own', 'edit', 'request:digest',
               'trajectory:own', 'main', 'invocation:causal', 'complete',
               '{"workUnitId":"work-unit:causal"}', ?, ?)`,
      timestamp,
      timestamp
    );
    sql.exec(
      `INSERT INTO gad_work_units
       (work_unit_id, command_id, kind, intent_summary, author_context_id,
        trigger_excerpt, trigger_sender_json, external_snapshot_json, content_class,
        external_lineage_json, normalization_protocol, created_at)
       VALUES ('work-unit:causal', 'command:causal', 'edit', 'Apply the causal intent',
               'context:own', NULL, NULL, NULL, 'internal', '[]', 'normalization:test', ?)`,
      timestamp
    );
    sql.exec(
      `INSERT INTO gad_work_unit_applications
       (application_id, work_unit_id, basis_kind, basis_id,
        result_workspace_fact_root_id, semantic_protocol)
       VALUES ('application:causal', 'work-unit:causal', 'event', ?, ?, 'semantic:test')`,
      basis.eventId,
      root
    );
    sql.exec(
      `INSERT INTO gad_changes
       (change_id, work_unit_id, operation, ordinal, kind, base_json, result_json,
        payload_json, effect_digest)
       VALUES ('change:causal', 'work-unit:causal', 0, 0, 'repo-add', NULL,
               '{"kind":"repository","repositoryId":"repository:test","repoPath":"packages/test"}',
               '{}', 'effect:digest')`
    );
    sql.exec(
      `UPDATE vcs_contexts SET working_head_application_id = ?, updated_at = ?
        WHERE context_id = ?`,
      "application:causal",
      timestamp,
      "context:own"
    );

    let transactionOrdinal = 0;
    const semantic = new SemanticWorkspace({
      workspaceId: "workspace:test",
      sql,
      store,
      now: () => timestamp,
      transaction: <T>(fn: () => T): T => {
        const savepoint = `reachability_test_${transactionOrdinal++}`;
        sql.exec(`SAVEPOINT ${savepoint}`);
        try {
          const result = fn();
          sql.exec(`RELEASE ${savepoint}`);
          return result;
        } catch (error) {
          sql.exec(`ROLLBACK TO ${savepoint}`);
          sql.exec(`RELEASE ${savepoint}`);
          throw error;
        }
      },
    });
    const reachable = (value: Record<string, unknown>, contextIds = ["context:own"]) =>
      semantic.referencesReachable(contextIds, [{ kind: "node", value }]);

    expect(reachable({ kind: "change", changeId: "change:causal" })).toBe(true);
    expect(reachable({ kind: "work-unit", workUnitId: "work-unit:causal" })).toBe(true);
    expect(reachable({ kind: "command", commandId: "command:causal" })).toBe(true);
    expect(
      reachable({
        kind: "trajectory-invocation",
        logId: "trajectory:own",
        head: "main",
        invocationId: "invocation:causal",
      })
    ).toBe(true);
    expect(
      reachable({
        kind: "trajectory-turn",
        logId: "trajectory:own",
        head: "main",
        turnId: "turn:causal",
      })
    ).toBe(true);
    expect(
      reachable({
        kind: "trajectory-message",
        logId: "trajectory:own",
        head: "main",
        messageId: "message:causal",
      })
    ).toBe(true);

    expect(
      reachable({
        kind: "trajectory-invocation",
        logId: "trajectory:own",
        head: "main",
        invocationId: "invocation:sibling",
      })
    ).toBe(false);
    expect(
      reachable({
        kind: "trajectory-turn",
        logId: "trajectory:own",
        head: "main",
        turnId: "turn:sibling",
      })
    ).toBe(false);
    expect(
      reachable({
        kind: "trajectory-message",
        logId: "trajectory:own",
        head: "main",
        messageId: "message:sibling",
      })
    ).toBe(false);
    expect(reachable({ kind: "change", changeId: "change:causal" }, ["context:foreign"])).toBe(
      false
    );
  });
});
