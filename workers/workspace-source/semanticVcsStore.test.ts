// Builtin semantic-authority tests.
import { describe, expect, it } from "vitest";
import { createInMemorySql } from "@vibestudio/durable/test-utils";
import { contextMaterializationCommand } from "@vibestudio/shared/vcs/workspaceProjection";
import {
  NORMALIZATION_PROTOCOL,
  SEMANTIC_PROTOCOL,
  type StateNodeRef,
} from "@workspace/vcs-engine";
import { createSemanticVcsSchema } from "./semanticVcsSchema.js";
import {
  SemanticVcsError,
  SemanticVcsStore,
  applicationIdentity,
  workUnitIdentity,
  type ApplicationPersistencePlan,
} from "./semanticVcsStore.js";

const timestamp = "2026-07-15T00:00:00.000Z";

describe("SemanticVcsError", () => {
  it("exposes its typed detail through the RPC error-data contract", () => {
    const error = new SemanticVcsError("CoupledGroupIncomplete", "incomplete", {
      group: "merge-group:files",
      coordinates: [{ kind: "file", id: "file:later" }],
    });

    expect(error.errorData).toEqual({
      code: "CoupledGroupIncomplete",
      group: "merge-group:files",
      coordinates: [{ kind: "file", id: "file:later" }],
    });
  });
});

function noEffectApplication(input: {
  contextId: string;
  commandId: string;
  basis: StateNodeRef;
  workspaceFactRootId: string;
  externalSnapshot?: {
    sourceKind: "git" | "archive" | "filesystem" | "upload" | "generated";
    sourceUri: string;
    snapshotRevision: string;
    snapshotDigest: string;
    targetRepositoryIds: readonly string[];
  };
}): ApplicationPersistencePlan {
  const externalSnapshot = input.externalSnapshot ?? null;
  const kind = externalSnapshot ? ("import" as const) : ("edit" as const);
  const contentClass = externalSnapshot ? ("external" as const) : ("internal" as const);
  const externalKeys = externalSnapshot
    ? [`repo:${externalSnapshot.sourceUri}@${externalSnapshot.snapshotRevision}`]
    : [];
  const evidence = { authorContextId: input.contextId, triggerEvidence: null };
  const workUnitId = workUnitIdentity({
    commandId: input.commandId,
    kind,
    intentSummary: null,
    ...evidence,
    externalSnapshot,
    contentClass,
    externalKeys,
  });
  const applicationId = applicationIdentity({
    workUnitId,
    basis: input.basis,
    resultWorkspaceFactRootId: input.workspaceFactRootId,
    semanticProtocol: SEMANTIC_PROTOCOL,
    changes: [],
  });
  return {
    contextId: input.contextId,
    expectedWorkingHead: input.basis,
    workUnit: {
      workUnitId,
      commandId: input.commandId,
      kind,
      authoredChangeIds: [],
      intentSummary: null,
      ...evidence,
      externalSnapshot,
      contentClass,
      externalKeys,
      normalizationProtocol: NORMALIZATION_PROTOCOL,
      createdAt: timestamp,
    },
    changes: [],
    application: {
      applicationId,
      workUnitId,
      basis: input.basis,
      appliedChangeIds: [],
      resultWorkspaceFactRootId: input.workspaceFactRootId,
      semanticProtocol: SEMANTIC_PROTOCOL,
    },
    appliedChanges: [],
    contentEdges: [],
    decisions: [],
    workspaceFacts: null,
    newRepositories: [],
    newFiles: [],
  };
}

describe("SemanticVcsStore reduced spine", () => {
  it("enumerates durable contexts by exact prefix in stable order", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    const store = new SemanticVcsStore(sql, () => timestamp);
    store.initializeWorkspace("main", "command:main");
    store.initializeWorkspace("template-composer-operation-z", "command:z");
    store.initializeWorkspace("template-composer-operation-a", "command:a");
    store.initializeWorkspace("system:other", "command:other");

    expect(store.listContexts("template-composer-operation-")).toEqual([
      "template-composer-operation-a",
      "template-composer-operation-z",
    ]);
    expect(store.listContexts()).toEqual([
      "main",
      "system:other",
      "template-composer-operation-a",
      "template-composer-operation-z",
    ]);
  });

  it("proves exact event and application ancestry with a hard traversal bound", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    const store = new SemanticVcsStore(sql, () => timestamp);
    const initial = store.initializeWorkspace("context:lineage", "command:genesis");
    const genesis = initial.committed.ref;
    const root = store.stateRoot(genesis);
    sql.exec(
      `INSERT INTO gad_work_unit_applications
       (application_id, work_unit_id, basis_kind, basis_id,
        result_workspace_fact_root_id, semantic_protocol)
       VALUES ('application:first', 'work-unit:first', 'event', ?, ?, ?)`,
      genesis.eventId,
      root,
      SEMANTIC_PROTOCOL
    );
    sql.exec(
      `INSERT INTO gad_workspace_events
       (event_id, command_id, kind, result_workspace_fact_root_id, message, created_at)
       VALUES ('event:committed', 'command:commit', 'commit', ?, NULL, ?)`,
      root,
      timestamp
    );
    sql.exec(
      `INSERT INTO gad_workspace_event_parents (event_id, ordinal, parent_event_id)
       VALUES ('event:committed', 0, ?)`,
      genesis.eventId
    );
    sql.exec(
      `INSERT INTO gad_workspace_event_applications (event_id, ordinal, application_id)
       VALUES ('event:committed', 0, 'application:first')`
    );
    sql.exec(
      `INSERT INTO gad_work_unit_applications
       (application_id, work_unit_id, basis_kind, basis_id,
        result_workspace_fact_root_id, semantic_protocol)
       VALUES ('application:second', 'work-unit:second', 'event', 'event:committed', ?, ?)`,
      root,
      SEMANTIC_PROTOCOL
    );
    const first = { kind: "application" as const, applicationId: "application:first" };
    const committed = { kind: "event" as const, eventId: "event:committed" };
    const second = { kind: "application" as const, applicationId: "application:second" };

    expect(store.isStateAncestor(genesis, second, 3)).toBe(true);
    expect(store.isStateAncestor(first, committed, 1)).toBe(true);
    expect(store.isStateAncestor(committed, second, 1)).toBe(true);
    expect(store.isStateAncestor(second, first, 3)).toBe(false);
    expect(() => store.isStateAncestor(first, second, 1)).toThrowError(
      expect.objectContaining({ code: "ScopeTooLarge" })
    );
  });

  it("deduplicates merged ancestry by event instead of enumerating every path", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    const store = new SemanticVcsStore(sql, () => timestamp);
    const initial = store.initializeWorkspace("context:diamonds", "command:genesis");
    const genesis = initial.committed.ref.eventId;
    const root = store.stateRoot(initial.committed.ref);
    let previous = genesis;

    // Eighteen diamonds contain only 55 distinct events but 2^18 paths back
    // to genesis. The ancestry query must scale with facts, not path count.
    for (let level = 0; level < 18; level += 1) {
      const left = `event:diamond:${level}:left`;
      const right = `event:diamond:${level}:right`;
      const merged = `event:diamond:${level}:merged`;
      for (const eventId of [left, right, merged]) {
        sql.exec(
          `INSERT INTO gad_workspace_events
           (event_id, command_id, kind, result_workspace_fact_root_id, message, created_at)
           VALUES (?, ?, 'commit', ?, NULL, ?)`,
          eventId,
          `command:${eventId}`,
          root,
          timestamp
        );
      }
      sql.exec(
        `INSERT INTO gad_workspace_event_parents (event_id, ordinal, parent_event_id)
         VALUES (?, 0, ?), (?, 0, ?), (?, 0, ?), (?, 1, ?)`,
        left,
        previous,
        right,
        previous,
        merged,
        left,
        merged,
        right
      );
      previous = merged;
    }
    sql.exec(
      `INSERT INTO gad_workspace_events
       (event_id, command_id, kind, result_workspace_fact_root_id, message, created_at)
       VALUES ('event:unrelated', 'command:unrelated', 'commit', ?, NULL, ?)`,
      root,
      timestamp
    );

    expect(store.isEventAncestor(genesis, previous, 100)).toBe(true);
    expect(store.isEventAncestor("event:unrelated", previous, 100)).toBe(false);
    expect(() => store.isEventAncestor("event:unrelated", previous, 10)).toThrowError(
      expect.objectContaining({ code: "ScopeTooLarge" })
    );
  });

  it("stores intrinsic content coordinates and has no applied-change mapping side table", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);

    const columns = sql.exec(`PRAGMA table_info(vcs_file_states)`).toArray();
    expect(columns.map((row) => row["name"])).toEqual([
      "file_state_id",
      "file_id",
      "presence",
      "repository_id",
      "path",
      "content_hash",
      "mode",
      "content_kind",
      "byte_length",
      "coordinate_extent",
      "prior_file_state_id",
      "tombstone_change_id",
    ]);
    expect(
      sql
        .exec(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = 'gad_applied_change_mappings'`
        )
        .toArray()
    ).toEqual([]);
    for (const derivedProjection of [
      "gad_work_unit_incorporated_changes",
      "gad_decision_result_applied_changes",
      "gad_decision_content_edges",
      "gad_decision_supersedes",
    ]) {
      expect(
        sql
          .exec(
            `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name = ?`,
            derivedProjection
          )
          .toArray()
      ).toEqual([]);
    }
    expect(
      sql
        .exec(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = 'gad_copy_source_mappings'`
        )
        .toArray()
    ).toEqual([]);
    expect(
      sql
        .exec(`PRAGMA table_info(gad_content_edge_mappings)`)
        .toArray()
        .map((row) => row["name"])
    ).toContain("coordinate_kind");
    sql.exec(
      `INSERT INTO gad_content_edges
       (content_edge_id, child_applied_change_id, parent_applied_change_id, relation)
       VALUES ('content-edge:copies', 'applied-change:child', 'applied-change:parent', 'copies')`
    );
    expect(() =>
      sql.exec(
        `INSERT INTO gad_content_edges
         (content_edge_id, child_applied_change_id, parent_applied_change_id, relation)
         VALUES ('content-edge:legacy', 'applied-change:child',
                 'applied-change:parent', 'derived-from')`
      )
    ).toThrow();
    sql.exec(
      `INSERT INTO gad_work_unit_applications
       (application_id, work_unit_id, basis_kind, basis_id,
        result_workspace_fact_root_id, semantic_protocol)
       VALUES ('application:one', 'work-unit:one', 'event', 'event:one',
               'workspace-root:one', 'semantic:test')`
    );
    expect(() =>
      sql.exec(
        `INSERT INTO gad_work_unit_applications
         (application_id, work_unit_id, basis_kind, basis_id,
          result_workspace_fact_root_id, semantic_protocol)
         VALUES ('application:two', 'work-unit:one', 'event', 'event:one',
                 'workspace-root:one', 'semantic:test')`
      )
    ).toThrow();
    sql.exec(
      `INSERT INTO gad_integration_decisions
       (decision_id, target_state_kind, target_state_id, source_event_id,
        work_unit_id, created_at, source_delta_id)
       VALUES ('decision:one', 'event', 'event:one', 'event:source',
               'work-unit:integration', ?, NULL)`,
      timestamp
    );
    expect(() =>
      sql.exec(
        `INSERT INTO gad_integration_decisions
         (decision_id, target_state_kind, target_state_id, source_event_id,
          work_unit_id, created_at, source_delta_id)
         VALUES ('decision:two', 'event', 'event:one', 'event:source',
                 'work-unit:integration', ?, NULL)`,
        timestamp
      )
    ).toThrow();
    expect(
      sql
        .exec(`PRAGMA table_info(gad_work_units)`)
        .toArray()
        .map((row) => row["name"])
    ).toContain("external_snapshot_json");
    expect(() =>
      sql.exec(
        `INSERT INTO vcs_file_states
         (file_state_id, file_id, presence, repository_id, path, content_hash, mode,
          content_kind, byte_length, coordinate_extent,
          prior_file_state_id, tombstone_change_id)
         VALUES ('state:invalid', 'file:invalid', 'placed', 'repo:one', 'binary.dat',
                 'hash:one', 33188, 'bytes', 4, 3, NULL, NULL)`
      )
    ).toThrow();
  });

  it("makes the exact external snapshot part of work-unit identity and storage", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    const store = new SemanticVcsStore(sql, () => timestamp);
    const initial = store.initializeWorkspace("context:one", "command:genesis");
    const externalSnapshot = {
      sourceKind: "git" as const,
      sourceUri: "https://example.invalid/repository.git",
      snapshotRevision: "abc123",
      snapshotDigest: `snapshot:${"d".repeat(64)}`,
      targetRepositoryIds: ["repository:one"],
    };
    const plan = noEffectApplication({
      contextId: initial.contextId,
      commandId: "command:import",
      basis: initial.working.ref,
      workspaceFactRootId: initial.working.workspaceFactRootId,
      externalSnapshot,
    });

    expect(plan.workUnit.workUnitId).not.toBe(
      workUnitIdentity({
        commandId: "command:import",
        kind: "import",
        intentSummary: null,
        authorContextId: initial.contextId,
        triggerEvidence: null,
        externalSnapshot: null,
        contentClass: "internal",
        externalKeys: [],
      })
    );
    store.applyApplication(plan);

    const row = sql
      .exec(
        `SELECT external_snapshot_json FROM gad_work_units WHERE work_unit_id = ?`,
        plan.workUnit.workUnitId
      )
      .toArray()[0];
    expect(JSON.parse(String(row?.["external_snapshot_json"]))).toEqual(externalSnapshot);
    expect(() =>
      sql.exec(
        `INSERT INTO gad_work_units
         (work_unit_id, command_id, kind, intent_summary, external_snapshot_json,
          normalization_protocol, created_at)
         VALUES ('work:invalid-edit', 'command:invalid-edit', 'edit', NULL, '{}',
                 'normalization:test', ?)`,
        timestamp
      )
    ).toThrow();
    expect(() =>
      sql.exec(
        `INSERT INTO gad_work_units
         (work_unit_id, command_id, kind, intent_summary, external_snapshot_json,
          normalization_protocol, created_at)
         VALUES ('work:invalid-import', 'command:invalid-import', 'import', NULL, NULL,
                 'normalization:test', ?)`,
        timestamp
      )
    ).toThrow();
    expect(() =>
      sql.exec(
        `INSERT INTO gad_work_units
         (work_unit_id, command_id, kind, intent_summary, external_snapshot_json,
          normalization_protocol, created_at)
         VALUES ('work:invalid-targets', 'command:invalid-targets', 'import', NULL, '{}',
                 'normalization:test', ?)`,
        timestamp
      )
    ).toThrow();
  });

  it("accumulates local applications and commits the exact chain as one event", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    const store = new SemanticVcsStore(sql, () => timestamp);
    const initial = store.initializeWorkspace("context:one", "command:genesis");

    const first = noEffectApplication({
      contextId: initial.contextId,
      commandId: "command:first",
      basis: initial.working.ref,
      workspaceFactRootId: initial.working.workspaceFactRootId,
    });
    const afterFirst = store.applyApplication(first);
    const second = noEffectApplication({
      contextId: initial.contextId,
      commandId: "command:second",
      basis: afterFirst.working.ref,
      workspaceFactRootId: afterFirst.working.workspaceFactRootId,
    });
    const working = store.applyApplication(second);

    expect(store.workingChain(initial.contextId, 10).applicationIds).toEqual([
      first.application.applicationId,
      second.application.applicationId,
    ]);

    const committed = store.commit({
      contextId: initial.contextId,
      expectedWorkingHead: working.working.ref,
      commandId: "command:commit",
      message: "two local steps",
      integratesEventIds: [],
      maxApplications: 10,
    });

    expect(committed.event.applicationIds).toEqual([
      first.application.applicationId,
      second.application.applicationId,
    ]);
    expect(committed.context.working.ref).toEqual({
      kind: "event",
      eventId: committed.event.eventId,
    });
    expect(() => store.assertIntegrity()).not.toThrow();
  });

  it("commits multiple integration sources as ordered semantic parents", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    const store = new SemanticVcsStore(sql, () => timestamp);
    const target = store.initializeWorkspace("context:target", "command:target-genesis");
    const left = store.initializeWorkspace("context:left", "command:left-genesis");
    const right = store.initializeWorkspace("context:right", "command:right-genesis");

    const local = noEffectApplication({
      contextId: target.contextId,
      commandId: "command:target-local",
      basis: target.working.ref,
      workspaceFactRootId: target.working.workspaceFactRootId,
    });
    const working = store.applyApplication(local);
    const committed = store.commit({
      contextId: target.contextId,
      expectedWorkingHead: working.working.ref,
      commandId: "command:octopus-integration",
      message: "integrate two child contexts",
      integratesEventIds: [left.committed.ref.eventId, right.committed.ref.eventId],
      maxApplications: 10,
    });

    expect(committed.event.kind).toBe("integration-commit");
    expect(committed.event.parentEventIds).toEqual([
      target.committed.ref.eventId,
      left.committed.ref.eventId,
      right.committed.ref.eventId,
    ]);
    expect(() => store.assertIntegrity()).not.toThrow();
  });

  it("journals an exact invocation edge and completes only after the effect receipt", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    const store = new SemanticVcsStore(sql, () => timestamp);
    const initial = store.initializeWorkspace("context:one", "command:genesis");
    const cause = {
      parent: { logId: "trajectory:one", head: "main", invocationId: "invocation:tool" },
    };

    expect(
      store.beginCommand({
        scopeKind: "context",
        scopeId: "context:one",
        commandId: "command:edit",
        method: "edit",
        requestDigest: "request-digest",
        cause,
      })
    ).toBeNull();
    const materialization = contextMaterializationCommand({
      contextId: "context:one",
      commandId: "command:edit",
      mode: "initialize",
      previousState: null,
      targetState: initial.working.ref,
      repositories: [],
      blobs: [],
    });
    const effect = store.queueEffect({
      scopeKind: "context",
      scopeId: "context:one",
      commandId: "command:edit",
      kind: "materialize-context",
      effectId: materialization.materializationId,
      payloadDigest: materialization.payloadDigest,
      payload: materialization as unknown as Record<string, unknown>,
    });
    store.finishCommand({
      scopeKind: "context",
      scopeId: "context:one",
      commandId: "command:edit",
      result: { ok: true },
      effectPending: true,
    });

    expect(store.command("command:edit")).toMatchObject({
      cause,
      status: "effect-pending",
    });
    store.acknowledgeEffect({
      effectId: effect.effectId,
      payloadDigest: effect.payloadDigest,
      receipt: {
        materializationId: effect.effectId,
        contextId: "context:one",
        targetState: initial.working.ref,
        repositories: [],
        payloadDigest: effect.payloadDigest,
      },
    });
    expect(store.command("command:edit")?.status).toBe("complete");
  });

  it("drops context-owned operational state so the context identity can be reused", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    const store = new SemanticVcsStore(sql, () => timestamp);
    const initial = store.initializeWorkspace("context:one", "command:genesis");
    expect(
      store.beginCommand({
        scopeKind: "context",
        scopeId: "context:one",
        commandId: "command:ensure",
        method: "ensure-context",
        requestDigest: "request-digest",
        cause: { parent: null },
      })
    ).toBeNull();
    const materialization = contextMaterializationCommand({
      contextId: "context:one",
      commandId: "command:ensure",
      mode: "initialize",
      previousState: null,
      targetState: initial.working.ref,
      repositories: [],
      blobs: [],
    });
    store.queueEffect({
      scopeKind: "context",
      scopeId: "context:one",
      commandId: "command:ensure",
      kind: "materialize-context",
      effectId: materialization.materializationId,
      payloadDigest: materialization.payloadDigest,
      payload: materialization as unknown as Record<string, unknown>,
    });
    store.finishCommand({
      scopeKind: "context",
      scopeId: "context:one",
      commandId: "command:ensure",
      result: initial,
      effectPending: true,
    });

    expect(store.dropContext("context:one")).toBe(true);
    expect(store.context("context:one")).toBeNull();
    expect(store.command("command:ensure")).toBeNull();
    expect(store.pendingEffects()).toEqual([]);
    expect(
      store.beginCommand({
        scopeKind: "context",
        scopeId: "context:one",
        commandId: "command:ensure",
        method: "ensure-context",
        requestDigest: "request-digest",
        cause: { parent: null },
      })
    ).toBeNull();
  });

  it("digests transient content observations without journaling blob bytes", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    const store = new SemanticVcsStore(sql, () => timestamp);
    store.initializeWorkspace("context:one", "command:genesis");
    store.beginCommand({
      scopeKind: "context",
      scopeId: "context:one",
      commandId: "command:observe",
      method: "importSnapshot",
      requestDigest: "request-digest",
      cause: { parent: null },
    });
    const effect = store.queueEffect({
      scopeKind: "context",
      scopeId: "context:one",
      commandId: "command:observe",
      kind: "observe-content",
      payload: { files: [{ contentHash: "blob:one" }] },
    });
    store.finishCommand({
      scopeKind: "context",
      scopeId: "context:one",
      commandId: "command:observe",
      result: { ok: true },
      effectPending: true,
    });
    const receipt = { files: [{ contentHash: "blob:one", base64: "A".repeat(2_000_000) }] };

    expect(
      store.acknowledgeEffect({
        effectId: effect.effectId,
        payloadDigest: effect.payloadDigest,
        receipt,
      })
    ).toMatchObject({ status: "applied", receipt });
    expect(
      sql
        .exec(
          `SELECT status, receipt_json, receipt_digest
             FROM gad_effect_intents WHERE effect_id = ?`,
          effect.effectId
        )
        .toArray()[0]
    ).toMatchObject({
      status: "applied",
      receipt_json: null,
      receipt_digest: expect.any(String),
    });
  });

  it("normalizes materialization receipts and indexes exact semantic repository states", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    const store = new SemanticVcsStore(sql, () => timestamp);
    const initial = store.initializeWorkspace("context:one", "command:genesis");
    const workspaceFactRootId = initial.working.workspaceFactRootId;
    store.beginCommand({
      scopeKind: "context",
      scopeId: "context:one",
      commandId: "command:materialize",
      method: "edit",
      requestDigest: "request:materialize",
      cause: { parent: null },
    });
    const repositoryId = "repository:one";
    const fileManifestId = "file-manifest:one";
    const contentRoot = `state:${"a".repeat(64)}`;
    const materialization = contextMaterializationCommand({
      contextId: "context:one",
      commandId: "command:materialize",
      mode: "initialize",
      previousState: null,
      targetState: initial.working.ref,
      repositories: [
        {
          repositoryId,
          repoPath: "projects/one",
          presence: "present",
          fileManifestId,
          source: { kind: "snapshot", files: [] },
        },
      ],
      blobs: [],
    });
    const effect = store.queueEffect({
      scopeKind: "context",
      scopeId: "context:one",
      commandId: "command:materialize",
      kind: "materialize-context",
      effectId: materialization.materializationId,
      payloadDigest: materialization.payloadDigest,
      payload: materialization as unknown as Record<string, unknown>,
    });
    store.finishCommand({
      scopeKind: "context",
      scopeId: "context:one",
      commandId: "command:materialize",
      result: { ok: true },
      effectPending: true,
    });
    const exactReceipt = {
      materializationId: effect.effectId,
      contextId: "context:one",
      targetState: initial.working.ref,
      repositories: [{ repositoryId, repoPath: "projects/one", contentRoot }],
      payloadDigest: effect.payloadDigest,
    };

    expect(() =>
      store.acknowledgeEffect({
        effectId: effect.effectId,
        payloadDigest: effect.payloadDigest,
        receipt: { ...exactReceipt, authorship: { actor: "smuggled" } },
      })
    ).toThrowError(
      expect.objectContaining({
        code: "IntegrityFailure",
        detail: expect.objectContaining({ internalDiagnostic: "EffectMismatch" }),
      })
    );
    expect(() =>
      store.acknowledgeEffect({
        effectId: effect.effectId,
        payloadDigest: effect.payloadDigest,
        receipt: {} as never,
      })
    ).toThrowError(
      expect.objectContaining({
        code: "IntegrityFailure",
        detail: expect.objectContaining({ internalDiagnostic: "EffectMismatch" }),
      })
    );

    store.acknowledgeEffect({
      effectId: effect.effectId,
      payloadDigest: effect.payloadDigest,
      receipt: exactReceipt,
    });
    expect(store.materializedRepositoryContentRoot(workspaceFactRootId, repositoryId)).toBe(
      contentRoot
    );
    expect(sql.exec(`SELECT * FROM gad_materialized_repository_states`).toArray()).toEqual([
      {
        workspace_fact_root_id: workspaceFactRootId,
        repository_id: repositoryId,
        content_root: contentRoot,
        receipt_effect_id: effect.effectId,
      },
    ]);

    sql.exec(
      `UPDATE gad_effect_intents SET payload_json = '{}', receipt_json = '{}'
        WHERE effect_id = ?`,
      effect.effectId
    );
    expect(store.materializedRepositoryContentRoot(workspaceFactRootId, repositoryId)).toBe(
      contentRoot
    );
  });

  it("admits a command id exactly once across every scope and causal root", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    const store = new SemanticVcsStore(sql, () => timestamp);
    const first = {
      scopeKind: "context" as const,
      scopeId: "context:one",
      commandId: "command:global",
      method: "edit",
      requestDigest: "request-digest",
      cause: {
        parent: { logId: "trajectory:one", head: "main", invocationId: "invocation:one" },
      },
    };

    expect(store.beginCommand(first)).toBeNull();
    expect(store.beginCommand(first)).toMatchObject({ commandId: "command:global" });
    expect(() => store.beginCommand({ ...first, scopeId: "context:two" })).toThrow(
      /different scope, input, or cause/
    );
    expect(() =>
      store.beginCommand({
        ...first,
        cause: {
          parent: { logId: "trajectory:one", head: "main", invocationId: "invocation:two" },
        },
      })
    ).toThrow(/different scope, input, or cause/);

    store.finishCommand({
      scopeKind: first.scopeKind,
      scopeId: first.scopeId,
      commandId: first.commandId,
      result: { ok: true },
      effectPending: false,
    });
    expect(() =>
      store.finishCommand({
        scopeKind: first.scopeKind,
        scopeId: first.scopeId,
        commandId: first.commandId,
        result: { ok: true },
        effectPending: false,
      })
    ).toThrowError(
      expect.objectContaining({
        code: "IntegrityFailure",
        detail: expect.objectContaining({ internalDiagnostic: "CommandInProgress" }),
      })
    );

    const primaryKey = sql
      .exec(`PRAGMA table_info(vcs_command_journal)`)
      .toArray()
      .filter((row) => Number(row["pk"]) > 0)
      .map((row) => row["name"]);
    expect(primaryKey).toEqual(["command_id"]);
  });
});
