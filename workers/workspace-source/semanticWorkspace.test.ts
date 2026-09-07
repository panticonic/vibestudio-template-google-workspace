// Builtin semantic-authority tests.
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@vibestudio/content-addressing";
import { createInMemorySql } from "@vibestudio/durable/test-utils";
import {
  vcsBlameResultSchema,
  vcsHistoryResultSchema,
  vcsInspectResultSchema,
  vcsNeighborsResultSchema,
  vcsProvenanceRelationRegistry,
  type VcsBlameResult,
  type VcsProvenanceEdge,
  type VcsSemanticNodeRef,
} from "@vibestudio/service-schemas/vcs";
import { createSemanticVcsSchema } from "./semanticVcsSchema.js";
import {
  SemanticWorkspace,
  type SemanticDispatchRequest,
  type SemanticDispatchResult,
} from "./semanticWorkspace.js";
import { SemanticVcsStore } from "./semanticVcsStore.js";

const timestamp = "2026-07-15T00:00:00.000Z";
const nonAsciiText = "a😀éz";
const nonAsciiBytes = new TextEncoder().encode(nonAsciiText);
const nonAsciiContentHash = sha256Hex(nonAsciiBytes);
const ingress: SemanticDispatchRequest["ingress"] = {
  causalParent: {
    kind: "trajectory-invocation",
    logId: "trajectory:test",
    head: "main",
    invocationId: "invocation:test",
  },
  contextIntegrity: { class: "internal", externalKeys: [] },
};

const completedResult = <T>(dispatch: SemanticDispatchResult): T => {
  if (dispatch.kind !== "effects-pending") {
    throw new Error(`expected effects-pending, received ${dispatch.kind}`);
  }
  return dispatch.result as T;
};

describe("SemanticWorkspace repository counteractions", () => {
  it("reverts selected repository work as one deletion and can counteract that deletion", async () => {
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
      )
    `);
    sql.exec(`
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
      )
    `);
    sql.exec(`
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
    sql.exec(`
      CREATE TABLE log_events (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        envelope_id TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        payload_ref_json TEXT NOT NULL,
        PRIMARY KEY (log_id, head, envelope_id)
      )
    `);
    sql.exec(
      `INSERT INTO log_events (log_id, head, envelope_id, actor_json, payload_ref_json)
       VALUES ('trajectory:test', 'main', 'trajectory-event:prompt', ?, ?)`,
      JSON.stringify({ kind: "agent", id: "agent:test", participantId: "agent:test" }),
      JSON.stringify({
        role: "user",
        sourceMessageId: "channel-message:prompt",
        senderRef: {
          kind: "user",
          id: "user:alice",
          participantId: "user:alice",
          displayName: "Alice",
          metadata: { handle: "alice", privateAccountId: "must-not-project" },
        },
        blocks: [
          {
            blockId: "message-block:prompt",
            type: "text",
            content: "Move the parser without changing its behavior",
          },
        ],
      })
    );
    sql.exec(
      `INSERT INTO trajectory_messages
       (log_id, head, message_id, turn_id, role, status, started_event_id,
        completed_event_id, updated_at)
       VALUES ('trajectory:test', 'main', 'message:trigger', NULL, 'user', 'completed',
               NULL, 'trajectory-event:prompt', ?),
              ('trajectory:test', 'main', 'message:assistant', 'turn:test', 'assistant',
               'completed', NULL, NULL, ?)`,
      timestamp,
      timestamp
    );
    sql.exec(
      `INSERT INTO trajectory_turns
       (log_id, head, turn_id, opened_at, closed_at, summary, ordinal, trigger_message_id)
       VALUES ('trajectory:test', 'main', 'turn:test', ?, NULL, 'Move the parser', 0,
               'message:trigger')`,
      timestamp
    );
    sql.exec(
      `INSERT INTO trajectory_invocations
       (log_id, head, invocation_id, turn_id, kind, status, terminal_outcome,
        request_ref_json, started_event_id, completed_event_id, updated_at)
       VALUES ('trajectory:test', 'main', 'invocation:test', 'turn:test', 'vcs-tool',
               'active', NULL, ?, 'trajectory-event:start', NULL, ?)`,
      JSON.stringify({
        protocol: "vibestudio.blob-ref.v1",
        digest: "a".repeat(64),
        size: 96,
        encoding: "json",
        originalBytes: 2_000_000,
      }),
      timestamp
    );
    const store = new SemanticVcsStore(sql, () => timestamp);
    let transactionOrdinal = 0;
    const transaction = <T>(fn: () => T): T => {
      const savepoint = `authority_test_${transactionOrdinal++}`;
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
    };
    const semantic = new SemanticWorkspace({
      workspaceId: "workspace:test",
      sql,
      store,
      now: () => timestamp,
      transaction,
    });
    const acknowledgeMaterialization = (dispatch: SemanticDispatchResult): void => {
      if (dispatch.kind !== "effects-pending") return;
      const effect = dispatch.effects[0]!;
      const repositories = effect.payload["repositories"] as Array<{
        repositoryId: string;
        repoPath: string;
        presence: "present" | "deleted";
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
              contentRoot: `state:${"0".repeat(64)}`,
            })),
          payloadDigest: effect.payloadDigest,
        },
      });
    };
    const initial = store.initializeWorkspace("context:test", "command:genesis");

    const importRequest = {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:import",
        expectedWorkingHead: initial.working.ref,
        source: {
          kind: "generated",
          uri: "fixture://repository",
          snapshotRevision: "fixture:v1",
        },
        repositories: [
          {
            repoPath: "packages/fixture",
            files: [
              {
                path: "src/index.ts",
                contentHash: nonAsciiContentHash,
                mode: 0o644,
              },
            ],
          },
        ],
      },
    } satisfies SemanticDispatchRequest;
    const prepare = store.facts.prepare.bind(store.facts);
    vi.spyOn(store.facts, "prepare")
      .mockImplementationOnce(() => {
        throw new Error("injected fact composition failure");
      })
      .mockImplementation(prepare);
    const observationDispatch = await semantic.dispatch("importSnapshot", importRequest);
    if (observationDispatch.kind !== "effects-pending") {
      throw new Error("import did not request content observation");
    }
    const importObservation = observationDispatch.effects[0]!;
    const observationReceipt = {
      effectId: importObservation.effectId,
      payloadDigest: importObservation.payloadDigest,
      receipt: {
        files: [
          {
            contentHash: nonAsciiContentHash,
            contentKind: "text",
            byteLength: nonAsciiBytes.byteLength,
            coordinateExtent: nonAsciiText.length,
          },
        ],
      },
    };
    expect(() => semantic.acknowledgeEffect(observationReceipt)).toThrow(
      "injected fact composition failure"
    );
    expect(store.pendingEffects("command:import")).toMatchObject([
      { effectId: importObservation.effectId, status: "pending" },
    ]);

    const importedDispatch = semantic.acknowledgeEffect(observationReceipt);
    const imported = completedResult<{
      eventId: string;
      workUnitId: string;
      importedRepositoryIds: string[];
    }>(importedDispatch);
    acknowledgeMaterialization(importedDispatch);
    const repositoryId = imported.importedRepositoryIds[0]!;
    const capturedEvidence = sql
      .exec(
        `SELECT author_context_id, trigger_excerpt, trigger_sender_json
           FROM gad_work_units WHERE work_unit_id = ?`,
        imported.workUnitId
      )
      .toArray()[0];
    expect(capturedEvidence).toMatchObject({
      author_context_id: "context:test",
      trigger_excerpt: "Move the parser without changing its behavior",
    });
    expect(JSON.parse(String(capturedEvidence?.["trigger_sender_json"]))).toEqual({
      kind: "user",
      id: "user:alice",
      participantId: "user:alice",
    });
    sql.exec(`SAVEPOINT captured_intent_survives_command_cleanup`);
    sql.exec(`DELETE FROM vcs_command_journal WHERE command_id = 'command:import'`);
    const capturedIntent = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: initial.working.ref,
        source: { kind: "event", eventId: imported.eventId },
        limit: 100,
      },
    });
    expect(capturedIntent).toMatchObject({
      kind: "complete",
      result: {
        intents: [
          {
            side: "theirs",
            intent: {
              tier: "trigger",
              text: "asked by user:alice: Move the parser without changing its behavior",
            },
          },
        ],
      },
    });
    sql.exec(`ROLLBACK TO captured_intent_survives_command_cleanup`);
    sql.exec(`RELEASE captured_intent_survives_command_cleanup`);
    const importedChangeIds = (
      sql
        .exec(
          `SELECT change_id FROM gad_changes
            WHERE work_unit_id = ? ORDER BY operation, ordinal`,
          imported.workUnitId
        )
        .toArray() as Array<{ change_id: string }>
    ).map((row) => row.change_id);
    expect(
      (
        sql
          .exec(
            `SELECT kind FROM gad_changes
              WHERE work_unit_id = ? ORDER BY operation, ordinal`,
            imported.workUnitId
          )
          .toArray() as Array<{ kind: string }>
      ).map((row) => row.kind)
    ).toEqual(["repo-add", "file-create"]);

    const inspect = async (node: VcsSemanticNodeRef) => {
      const dispatch = await semantic.dispatch("inspect", {
        ingress,
        input: { node, edgeLimit: 20 },
      });
      if (dispatch.kind !== "complete") throw new Error("inspect did not complete");
      return vcsInspectResultSchema.parse(dispatch.result);
    };
    const importedEvent = store.event(imported.eventId)!;
    const importedRoot = store.stateRoot({ kind: "event", eventId: imported.eventId });
    const importedFileId = store.facts.entries(importedRoot, "file")[0]!.key;
    await expect(
      semantic.dispatch("readFile", {
        ingress,
        input: {
          state: { kind: "event", eventId: imported.eventId },
          repositoryId: "repository:wrong",
          file: { kind: "id", fileId: importedFileId },
        },
      })
    ).resolves.toEqual({ kind: "complete", result: null });
    await expect(inspect({ kind: "event", eventId: imported.eventId })).resolves.toBeTruthy();
    await expect(
      inspect({ kind: "application", applicationId: importedEvent.applicationIds[0]! })
    ).resolves.toBeTruthy();
    await expect(
      inspect({ kind: "work-unit", workUnitId: imported.workUnitId })
    ).resolves.toMatchObject({
      node: {
        kind: "work-unit",
        value: {
          authoredChangeCount: 2,
          authoredChangeIds: importedChangeIds,
          externalSnapshot: {
            sourceKind: "generated",
            snapshotRevision: "fixture:v1",
            targetRepositoryIds: [repositoryId],
          },
        },
      },
    });
    for (const changeId of importedChangeIds) {
      await expect(inspect({ kind: "change", changeId })).resolves.toBeTruthy();
    }
    await expect(inspect({ kind: "command", commandId: "command:import" })).resolves.toBeTruthy();
    await expect(
      inspect({
        kind: "repository",
        state: { kind: "event", eventId: imported.eventId },
        repositoryId,
      })
    ).resolves.toBeTruthy();
    await expect(
      inspect({
        kind: "file",
        state: { kind: "event", eventId: imported.eventId },
        repositoryId,
        fileId: importedFileId,
      })
    ).resolves.toBeTruthy();

    const commandNeighbors = await semantic.dispatch("neighbors", {
      ingress,
      input: {
        root: { kind: "command", commandId: "command:import" },
        limit: 20,
      },
    });
    expect(commandNeighbors).toMatchObject({
      kind: "complete",
      result: {
        edges: expect.arrayContaining([
          expect.objectContaining({
            kind: "caused-by",
            to: {
              kind: "trajectory-invocation",
              logId: "trajectory:test",
              head: "main",
              invocationId: "invocation:test",
            },
          }),
        ]),
      },
    });

    const stateNeighbors = await semantic.dispatch("neighbors", {
      ingress,
      input: {
        root: { kind: "event", eventId: imported.eventId },
        limit: 20,
      },
    });
    expect(stateNeighbors).toMatchObject({
      kind: "complete",
      result: {
        root: { kind: "event", eventId: imported.eventId },
        edges: expect.arrayContaining([
          {
            kind: "contains-repository",
            from: { kind: "event", eventId: imported.eventId },
            to: {
              kind: "repository",
              state: { kind: "event", eventId: imported.eventId },
              repositoryId,
            },
          },
        ]),
      },
    });

    const pagedStateEdges: VcsProvenanceEdge[] = [];
    let stateCursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const dispatch = await semantic.dispatch("neighbors", {
        ingress,
        input: {
          root: { kind: "event", eventId: imported.eventId },
          limit: 1,
          ...(stateCursor ? { cursor: stateCursor } : {}),
        },
      });
      if (dispatch.kind !== "complete") throw new Error("neighbors did not complete");
      const page = vcsNeighborsResultSchema.parse(dispatch.result);
      pagedStateEdges.push(...page.edges);
      if (!page.nextCursor) break;
      expect(page.nextCursor).toMatch(/^semantic-page-v2\./);
      stateCursor = page.nextCursor;
    }
    if (stateNeighbors.kind !== "complete") throw new Error("neighbors did not complete");
    expect(pagedStateEdges).toEqual(vcsNeighborsResultSchema.parse(stateNeighbors.result).edges);
    expect(pagedStateEdges).toEqual(
      expect.arrayContaining([
        {
          kind: "places-file",
          from: { kind: "event", eventId: imported.eventId },
          to: {
            kind: "file",
            state: { kind: "event", eventId: imported.eventId },
            repositoryId,
            fileId: importedFileId,
          },
        },
      ])
    );
    await expect(
      semantic.dispatch("neighbors", {
        ingress,
        input: {
          root: { kind: "application", applicationId: importedEvent.applicationIds[0]! },
          limit: 1,
          cursor: stateCursor!,
        },
      })
    ).rejects.toThrow(/cursor does not match its exact basis/u);

    const applicationRoot = {
      kind: "application" as const,
      applicationId: importedEvent.applicationIds[0]!,
    };
    const allApplicationNeighbors = await semantic.dispatch("neighbors", {
      ingress,
      input: { root: applicationRoot, limit: 20 },
    });
    if (allApplicationNeighbors.kind !== "complete") {
      throw new Error("neighbors did not complete");
    }
    const expectedApplicationEdges = vcsNeighborsResultSchema.parse(
      allApplicationNeighbors.result
    ).edges;
    const pagedApplicationEdges: VcsProvenanceEdge[] = [];
    let applicationCursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const dispatch = await semantic.dispatch("neighbors", {
        ingress,
        input: {
          root: applicationRoot,
          limit: 1,
          ...(applicationCursor ? { cursor: applicationCursor } : {}),
        },
      });
      if (dispatch.kind !== "complete") throw new Error("neighbors did not complete");
      const page = vcsNeighborsResultSchema.parse(dispatch.result);
      pagedApplicationEdges.push(...page.edges);
      if (!page.nextCursor) break;
      applicationCursor = page.nextCursor;
    }
    expect(pagedApplicationEdges).toEqual(expectedApplicationEdges);
    expect(pagedApplicationEdges).toEqual(
      expect.arrayContaining([
        {
          kind: "places-file",
          from: applicationRoot,
          to: {
            kind: "file",
            state: applicationRoot,
            repositoryId,
            fileId: importedFileId,
          },
        },
      ])
    );

    await expect(
      semantic.dispatch("revert", {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:reject-repository-only-revert",
          expectedWorkingHead: { kind: "event", eventId: imported.eventId },
          changeIds: [importedChangeIds[0]!],
        },
      })
    ).rejects.toMatchObject({
      code: "InvalidReference",
      detail: { referenceKind: "change", reference: importedChangeIds[0] },
    });

    store.forkContext("context:test", "context:later-file");
    const laterFileDispatch = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:later-file",
        commandId: "command:add-later-file",
        expectedWorkingHead: { kind: "event", eventId: imported.eventId },
        changes: [
          {
            kind: "file-create",
            repositoryId,
            path: "src/later.ts",
            content: { kind: "text", text: "later" },
            mode: 0o644,
          },
        ],
      },
    });
    const laterFile = completedResult<{
      workingHead: { kind: "application"; applicationId: string };
      changeIds: string[];
    }>(laterFileDispatch);
    acknowledgeMaterialization(laterFileDispatch);
    const laterCommitDispatch = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:later-file",
        commandId: "command:commit-later-file",
        expectedWorkingHead: laterFile.workingHead,
        message: "Add unrelated later file",
      },
    });
    const laterCommit = completedResult<{ event: { kind: "event"; eventId: string } }>(
      laterCommitDispatch
    );
    acknowledgeMaterialization(laterCommitDispatch);
    await expect(
      semantic.dispatch("revert", {
        ingress,
        input: {
          contextId: "context:later-file",
          commandId: "command:reject-import-revert-over-later-file",
          expectedWorkingHead: laterCommit.event,
          changeIds: importedChangeIds,
        },
      })
    ).rejects.toMatchObject({
      code: "InvalidReference",
      detail: { referenceKind: "change", reference: importedChangeIds[0] },
    });
    const laterRoot = store.stateRoot(laterCommit.event);
    expect(store.facts.fileAtPath(laterRoot, repositoryId, "src/later.ts")?.state.presence).toBe(
      "placed"
    );

    const revertedDispatch = await semantic.dispatch("revert", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:revert-import",
        expectedWorkingHead: { kind: "event", eventId: imported.eventId },
        changeIds: importedChangeIds,
      },
    });
    const reverted = completedResult<{
      workingHead: { kind: "application"; applicationId: string };
      changeIds: string[];
    }>(revertedDispatch);
    acknowledgeMaterialization(revertedDispatch);
    expect(reverted.changeIds).toHaveLength(2);
    const counteractions = sql
      .exec(
        `SELECT change_id, kind, payload_json FROM gad_changes
          WHERE change_id IN (?, ?) ORDER BY operation`,
        ...reverted.changeIds
      )
      .toArray() as Array<{ change_id: string; kind: string; payload_json: string }>;
    expect(counteractions.map((change) => change.kind)).toEqual(["file-delete", "repo-delete"]);
    const repositoryDeletion = counteractions[1]!;
    expect(JSON.parse(repositoryDeletion.payload_json)).toEqual({
      counteractsChangeIds: [importedChangeIds[0]],
    });

    const deletedRoot = store.stateRoot(reverted.workingHead);
    expect(store.facts.member(deletedRoot, repositoryId)?.presence).toBe("deleted");
    const deletedFile = store.facts.entries(deletedRoot, "file")[0];
    expect(deletedFile).toBeTruthy();
    expect(store.facts.file(deletedRoot, deletedFile!.key)?.state.presence).toBe("deleted");
    expect(store.facts.fileAtPath(deletedRoot, repositoryId, "src/index.ts")).toBeNull();
    expect(
      sql
        .exec(`SELECT COUNT(*) AS count FROM vcs_file_states WHERE presence = 'deleted'`)
        .toArray()[0]
    ).toMatchObject({ count: 1 });
    expect(() => store.facts.assertIndexParity(deletedRoot)).not.toThrow();

    const deletedCommitDispatch = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:commit-deleted-import",
        expectedWorkingHead: reverted.workingHead,
        message: "Counteract imported repository",
      },
    });
    const deletedCommit = completedResult<{ event: { kind: "event"; eventId: string } }>(
      deletedCommitDispatch
    );
    acknowledgeMaterialization(deletedCommitDispatch);
    const emptyTarget = store.initializeWorkspace("context:empty-target", "command:target-genesis");
    const deletedComparisonDispatch = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: emptyTarget.working.ref,
        source: { kind: "event", eventId: deletedCommit.event.eventId },
        limit: 100,
      },
    });
    if (deletedComparisonDispatch.kind !== "complete") {
      throw new Error("deleted comparison did not complete");
    }
    expect(deletedComparisonDispatch.result).toMatchObject({
      resolution: { complete: true, remainingCoordinateCount: 0, concluded: false },
      coordinates: [],
    });

    await expect(
      semantic.dispatch("revert", {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:reject-repository-only-restore",
          expectedWorkingHead: deletedCommit.event,
          changeIds: [reverted.changeIds[1]!],
        },
      })
    ).rejects.toMatchObject({
      code: "InvalidReference",
      detail: { referenceKind: "change", reference: reverted.changeIds[1] },
    });

    const restoredDispatch = await semantic.dispatch("revert", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:restore-import",
        expectedWorkingHead: deletedCommit.event,
        changeIds: reverted.changeIds,
      },
    });
    const restored = completedResult<{
      workingHead: { kind: "application"; applicationId: string };
      changeIds: string[];
    }>(restoredDispatch);
    acknowledgeMaterialization(restoredDispatch);
    const restoredRoot = store.stateRoot(restored.workingHead);
    expect(store.facts.member(restoredRoot, repositoryId)).toMatchObject({
      presence: "present",
      repoPath: "packages/fixture",
    });
    expect(store.facts.fileAtPath(restoredRoot, repositoryId, "src/index.ts")?.state).toMatchObject(
      {
        presence: "placed",
        contentHash: nonAsciiContentHash,
      }
    );
    expect(() => store.facts.assertIndexParity(restoredRoot)).not.toThrow();

    const restoredCommitDispatch = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:commit-restored-import",
        expectedWorkingHead: restored.workingHead,
        message: "Restore imported repository",
      },
    });
    const restoredCommit = completedResult<{ event: { kind: "event"; eventId: string } }>(
      restoredCommitDispatch
    );
    acknowledgeMaterialization(restoredCommitDispatch);
    const comparisonDispatch = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: emptyTarget.working.ref,
        source: { kind: "event", eventId: restoredCommit.event.eventId },
        limit: 100,
      },
    });
    if (comparisonDispatch.kind !== "complete") throw new Error("compare did not complete");
    expect(comparisonDispatch.result).toMatchObject({
      resolution: { complete: false, remainingCoordinateCount: 2, concluded: false },
      counts: { adopt: 2, conflict: 0 },
    });

    store.forkContext("context:test", "context:copy-integration");
    const copyDispatch = await semantic.dispatch("copy", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:copy-imported-file",
        expectedWorkingHead: restoredCommit.event,
        copies: [
          {
            source: {
              state: restoredCommit.event,
              repositoryId,
              fileId: importedFileId,
            },
            destination: { repositoryId, path: "src/copied.ts" },
          },
        ],
      },
    });
    const copied = completedResult<{
      workingHead: { kind: "application"; applicationId: string };
      applicationId: string;
      changeIds: string[];
    }>(copyDispatch);
    acknowledgeMaterialization(copyDispatch);
    const copiedRoot = store.stateRoot(copied.workingHead);
    const copiedFileId = store.facts.fileAtPath(copiedRoot, repositoryId, "src/copied.ts")?.state
      .fileId;
    if (!copiedFileId) throw new Error("copy did not create a file identity");
    const copyLineage = sql
      .exec(
        `SELECT edge.child_applied_change_id, edge.parent_applied_change_id, edge.relation,
                mapping.coordinate_kind, mapping.child_start, mapping.child_end,
                mapping.parent_start, mapping.parent_end
           FROM gad_content_edges edge
           JOIN gad_content_edge_mappings mapping
             ON mapping.content_edge_id = edge.content_edge_id
           JOIN gad_applied_changes child
             ON child.applied_change_id = edge.child_applied_change_id
          WHERE child.application_id = ? AND child.change_id = ?`,
        copied.applicationId,
        copied.changeIds[0]
      )
      .toArray();
    expect(copyLineage).toEqual([
      expect.objectContaining({
        relation: "copies",
        coordinate_kind: "utf16",
        child_start: 0,
        child_end: nonAsciiText.length,
        parent_start: 0,
        parent_end: nonAsciiText.length,
      }),
    ]);
    const copyAppliedChangeId = String(copyLineage[0]?.["child_applied_change_id"]);
    const sourceAppliedChangeId = String(copyLineage[0]?.["parent_applied_change_id"]);
    const copyNeighbors = await semantic.dispatch("neighbors", {
      ingress,
      input: {
        root: { kind: "applied-change", appliedChangeId: copyAppliedChangeId },
        limit: 20,
      },
    });
    expect(copyNeighbors).toMatchObject({
      kind: "complete",
      result: {
        edges: expect.arrayContaining([
          {
            kind: "copies-content",
            from: { kind: "applied-change", appliedChangeId: copyAppliedChangeId },
            to: { kind: "applied-change", appliedChangeId: sourceAppliedChangeId },
          },
        ]),
      },
    });
    const authoredCopySourceEdge = {
      kind: "authored-copy-source" as const,
      from: { kind: "change" as const, changeId: copied.changeIds[0]! },
      to: {
        kind: "file" as const,
        state: restoredCommit.event,
        repositoryId,
        fileId: importedFileId,
      },
    };
    for (const root of [authoredCopySourceEdge.from, authoredCopySourceEdge.to]) {
      const dispatched = await semantic.dispatch("neighbors", {
        ingress,
        input: { root, limit: 20 },
      });
      if (dispatched.kind !== "complete") throw new Error("copy provenance walk failed");
      expect(vcsNeighborsResultSchema.parse(dispatched.result).edges).toContainEqual(
        authoredCopySourceEdge
      );
    }
    expect(
      sql
        .exec(
          `SELECT source_json, payload_json FROM gad_changes WHERE change_id = ?`,
          copied.changeIds[0]
        )
        .toArray()[0]
    ).toMatchObject({
      source_json: expect.stringContaining(`\"fileId\":\"${importedFileId}\"`),
      payload_json: expect.not.stringContaining('"source"'),
    });

    store.forkContext("context:test", "context:copy-revert");
    const copyCommitDispatch = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:commit-copy",
        expectedWorkingHead: copied.workingHead,
        message: "Copy imported file",
      },
    });
    const copyCommit = completedResult<{ event: { kind: "event"; eventId: string } }>(
      copyCommitDispatch
    );
    acknowledgeMaterialization(copyCommitDispatch);
    const adoptedCopyDispatch = await semantic.dispatch("merge", {
      ingress,
      input: {
        contextId: "context:copy-integration",
        commandId: "command:adopt-copy",
        expectedWorkingHead: restoredCommit.event,
        source: { kind: "event", eventId: copyCommit.event.eventId },
      },
    });
    const adoptedCopy = completedResult<{
      workingHead: { kind: "application"; applicationId: string };
      applicationId: string;
    }>(adoptedCopyDispatch);
    acknowledgeMaterialization(adoptedCopyDispatch);
    expect(
      sql
        .exec(
          `SELECT edge.relation
             FROM gad_content_edges edge
             JOIN gad_applied_changes child
               ON child.applied_change_id = edge.child_applied_change_id
            WHERE child.application_id = ?`,
          adoptedCopy.applicationId
        )
        .toArray()
    ).toEqual([{ relation: "copies" }]);
    const adoptedCopyBlame = await semantic.dispatch("blame", {
      ingress,
      input: {
        state: adoptedCopy.workingHead,
        repositoryId,
        fileId: copiedFileId,
        range: { start: 0, end: nonAsciiText.length },
        limit: 20,
      },
    });
    expect(adoptedCopyBlame).toMatchObject({
      kind: "complete",
      result: {
        spans: [
          {
            stop: "import-boundary",
            path: expect.arrayContaining([expect.objectContaining({ kind: "copies-content" })]),
          },
        ],
      },
    });

    const revertedCopyDispatch = await semantic.dispatch("revert", {
      ingress,
      input: {
        contextId: "context:copy-revert",
        commandId: "command:revert-copy",
        expectedWorkingHead: copied.workingHead,
        changeIds: copied.changeIds,
      },
    });
    const revertedCopy = completedResult<{
      workingHead: { kind: "application"; applicationId: string };
    }>(revertedCopyDispatch);
    acknowledgeMaterialization(revertedCopyDispatch);
    const revertedCopyRoot = store.stateRoot(revertedCopy.workingHead);
    expect(store.facts.fileAtPath(revertedCopyRoot, repositoryId, "src/copied.ts")).toBeNull();
    expect(
      store.facts.fileAtPath(revertedCopyRoot, repositoryId, "src/index.ts")?.state.fileId
    ).toBe(importedFileId);

    const moveCopyDispatch = await semantic.dispatch("move", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:move-copied-file",
        expectedWorkingHead: copyCommit.event,
        moves: [
          {
            kind: "file",
            repositoryId,
            fileId: copiedFileId,
            destinationRepositoryId: repositoryId,
            destinationPath: "src/moved-copy.ts",
          },
        ],
      },
    });
    const movedCopy = completedResult<{
      workingHead: { kind: "application"; applicationId: string };
    }>(moveCopyDispatch);
    acknowledgeMaterialization(moveCopyDispatch);
    const blameDispatch = await semantic.dispatch("blame", {
      ingress,
      input: {
        state: movedCopy.workingHead,
        repositoryId,
        fileId: copiedFileId,
        range: { start: 0, end: nonAsciiText.length },
        limit: 20,
      },
    });
    if (blameDispatch.kind !== "complete") throw new Error("blame did not complete");
    expect(blameDispatch.result).toMatchObject({
      coordinateKind: "utf16",
      spans: [
        {
          start: 0,
          end: nonAsciiText.length,
          stop: "import-boundary",
          path: expect.arrayContaining([
            expect.objectContaining({ kind: "preserves-content" }),
            expect.objectContaining({ kind: "copies-content" }),
          ]),
        },
      ],
    });

    const editDispatch = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:edit-non-ascii-copy",
        expectedWorkingHead: movedCopy.workingHead,
        changes: [
          {
            kind: "text-edit",
            repositoryId,
            fileId: copiedFileId,
            edits: [{ start: 3, end: 4, text: "X" }],
            mode: 0o755,
          },
        ],
      },
    });
    if (editDispatch.kind !== "effects-pending") throw new Error("edit did not request content");
    expect(editDispatch.effects).toHaveLength(1);
    expect(editDispatch.effects[0]).toMatchObject({ kind: "observe-content" });
    const observation = editDispatch.effects[0]!;
    const resumed = semantic.acknowledgeEffect({
      effectId: observation.effectId,
      payloadDigest: observation.payloadDigest,
      receipt: {
        files: [
          {
            contentHash: nonAsciiContentHash,
            base64: btoa(String.fromCharCode(...nonAsciiBytes)),
          },
        ],
      },
    });
    const edited = completedResult<{
      workingHead: { kind: "application"; applicationId: string };
      workUnitId: string;
      changeIds: string[];
      applicationId: string;
    }>(resumed);
    acknowledgeMaterialization(resumed);
    const editChangeId = edited.changeIds[0]!;
    const editedRoot = store.stateRoot(edited.workingHead);
    expect(store.facts.file(editedRoot, copiedFileId)?.state).toMatchObject({
      presence: "placed",
      mode: 0o755,
    });

    expect(
      sql
        .exec(
          `SELECT edge.relation, mapping.ordinal, mapping.coordinate_kind,
                  mapping.child_start, mapping.child_end,
                  mapping.parent_start, mapping.parent_end
             FROM gad_content_edges edge
             JOIN gad_content_edge_mappings mapping
               ON mapping.content_edge_id = edge.content_edge_id
             JOIN gad_applied_changes applied
               ON applied.applied_change_id = edge.child_applied_change_id
            WHERE applied.application_id = ? AND applied.change_id = ?
            ORDER BY mapping.ordinal`,
          edited.applicationId,
          editChangeId
        )
        .toArray()
    ).toEqual([
      {
        relation: "incorporates",
        ordinal: 0,
        coordinate_kind: "utf16",
        child_start: 0,
        child_end: 3,
        parent_start: 0,
        parent_end: 3,
      },
      {
        relation: "incorporates",
        ordinal: 1,
        coordinate_kind: "utf16",
        child_start: 4,
        child_end: 5,
        parent_start: 4,
        parent_end: 5,
      },
    ]);

    store.forkContext("context:test", "context:text-revert");
    const revertedTextDispatch = await semantic.dispatch("revert", {
      ingress,
      input: {
        contextId: "context:text-revert",
        commandId: "command:revert-text-edit",
        expectedWorkingHead: edited.workingHead,
        changeIds: [editChangeId],
      },
    });
    const revertedText = completedResult<{
      workingHead: { kind: "application"; applicationId: string };
      applicationId: string;
      changeIds: string[];
    }>(revertedTextDispatch);
    acknowledgeMaterialization(revertedTextDispatch);
    expect(
      store.facts.file(store.stateRoot(revertedText.workingHead), copiedFileId)?.state
    ).toMatchObject({ contentHash: nonAsciiContentHash });
    expect(
      sql
        .exec(
          `SELECT edge.relation, mapping.coordinate_kind,
                  mapping.child_start, mapping.child_end,
                  mapping.parent_start, mapping.parent_end
             FROM gad_content_edges edge
             JOIN gad_content_edge_mappings mapping
               ON mapping.content_edge_id = edge.content_edge_id
             JOIN gad_applied_changes applied
               ON applied.applied_change_id = edge.child_applied_change_id
            WHERE applied.application_id = ?
            ORDER BY mapping.ordinal`,
          revertedText.applicationId
        )
        .toArray()
    ).toEqual([
      {
        relation: "incorporates",
        coordinate_kind: "utf16",
        child_start: 0,
        child_end: 3,
        parent_start: 0,
        parent_end: 3,
      },
      {
        relation: "incorporates",
        coordinate_kind: "utf16",
        child_start: 4,
        child_end: 5,
        parent_start: 4,
        parent_end: 5,
      },
    ]);

    const editedBlameDispatch = await semantic.dispatch("blame", {
      ingress,
      input: {
        state: edited.workingHead,
        repositoryId,
        fileId: copiedFileId,
        range: { start: 0, end: nonAsciiText.length },
        limit: 20,
      },
    });
    if (editedBlameDispatch.kind !== "complete") throw new Error("blame did not complete");
    expect(editedBlameDispatch.result).toMatchObject({
      coordinateKind: "utf16",
      spans: [
        {
          start: 0,
          end: 3,
          stop: "import-boundary",
          path: expect.arrayContaining([expect.objectContaining({ kind: "incorporates-content" })]),
        },
        {
          start: 3,
          end: 4,
          stop: "authored",
          change: { kind: "change", changeId: editChangeId },
          workUnitId: edited.workUnitId,
          tier: "trigger",
          command: { kind: "command", commandId: "command:edit-non-ascii-copy" },
          path: [],
        },
        {
          start: 4,
          end: 5,
          stop: "import-boundary",
          path: expect.arrayContaining([expect.objectContaining({ kind: "incorporates-content" })]),
        },
      ],
    });
    const editedBlame = vcsBlameResultSchema.parse(editedBlameDispatch.result);
    for (const span of editedBlame.spans) {
      expect(span.appliedChange.appliedChangeId).toMatch(/^applied-change:/);
      const inspectedApplied = await inspect(span.appliedChange);
      expect(inspectedApplied.node).toMatchObject({
        kind: "applied-change",
        value: {
          appliedChangeId: span.appliedChange.appliedChangeId,
          changeId: span.change.changeId,
        },
      });
      for (const edge of span.path) {
        expect(edge.from.kind).toBe("applied-change");
        expect(edge.to.kind).toBe("applied-change");
      }
    }

    const pagedBlameSpans: VcsBlameResult["spans"] = [];
    let blameCursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
      const dispatch = await semantic.dispatch("blame", {
        ingress,
        input: {
          state: edited.workingHead,
          repositoryId,
          fileId: copiedFileId,
          range: { start: 0, end: nonAsciiText.length },
          limit: 1,
          ...(blameCursor ? { cursor: blameCursor } : {}),
        },
      });
      if (dispatch.kind !== "complete") throw new Error("blame page did not complete");
      const page = vcsBlameResultSchema.parse(dispatch.result);
      pagedBlameSpans.push(...page.spans);
      if (!page.nextCursor) break;
      expect(page.nextCursor).toMatch(/^semantic-page-v2\./u);
      blameCursor = page.nextCursor;
    }
    expect(pagedBlameSpans).toEqual(vcsBlameResultSchema.parse(editedBlameDispatch.result).spans);

    const fileHistory = await semantic.dispatch("history", {
      ingress,
      input: {
        root: {
          kind: "file",
          state: edited.workingHead,
          repositoryId,
          fileId: copiedFileId,
        },
        direction: "past",
        limit: 20,
      },
    });
    expect(fileHistory).toMatchObject({
      kind: "complete",
      result: {
        entries: [
          {
            node: { kind: "change", changeId: editChangeId },
            summary: "text",
            intent: {
              tier: "trigger",
              text: "asked by user:alice: Move the parser without changing its behavior",
            },
          },
          expect.objectContaining({ summary: "file-move" }),
          expect.objectContaining({ summary: "file-copy" }),
        ],
      },
    });

    const changeNeighbors = await semantic.dispatch("neighbors", {
      ingress,
      input: { root: { kind: "change", changeId: editChangeId }, limit: 20 },
    });
    expect(changeNeighbors).toMatchObject({
      kind: "complete",
      result: {
        edges: expect.arrayContaining([
          {
            kind: "authored-change",
            from: { kind: "work-unit", workUnitId: edited.workUnitId },
            to: { kind: "change", changeId: editChangeId },
          },
        ]),
      },
    });
    const workNeighbors = await semantic.dispatch("neighbors", {
      ingress,
      input: { root: { kind: "work-unit", workUnitId: edited.workUnitId }, limit: 20 },
    });
    expect(workNeighbors).toMatchObject({
      kind: "complete",
      result: {
        edges: expect.arrayContaining([
          {
            kind: "caused-by",
            from: { kind: "work-unit", workUnitId: edited.workUnitId },
            to: { kind: "command", commandId: "command:edit-non-ascii-copy" },
          },
        ]),
      },
    });
    const editCommandNeighbors = await semantic.dispatch("neighbors", {
      ingress,
      input: {
        root: { kind: "command", commandId: "command:edit-non-ascii-copy" },
        limit: 20,
      },
    });
    expect(editCommandNeighbors).toMatchObject({
      kind: "complete",
      result: {
        edges: expect.arrayContaining([
          {
            kind: "caused-by",
            from: { kind: "command", commandId: "command:edit-non-ascii-copy" },
            to: {
              kind: "trajectory-invocation",
              logId: "trajectory:test",
              head: "main",
              invocationId: "invocation:test",
            },
          },
        ]),
      },
    });
    const invocation = {
      kind: "trajectory-invocation" as const,
      logId: "trajectory:test",
      head: "main",
      invocationId: "invocation:test",
    };
    await expect(inspect(invocation)).resolves.toMatchObject({
      node: {
        kind: "trajectory-invocation",
        value: {
          logId: invocation.logId,
          head: invocation.head,
          invocationId: invocation.invocationId,
          turnId: "turn:test",
          name: "vcs-tool",
          status: "active",
          terminalOutcome: null,
          requestRef: {
            protocol: "vibestudio.blob-ref.v1",
            digest: "a".repeat(64),
            size: 96,
            encoding: "json",
            originalBytes: 2_000_000,
          },
          startedEventId: "trajectory-event:start",
          completedEventId: null,
        },
      },
    });
    const invocationNeighbors = await semantic.dispatch("neighbors", {
      ingress,
      input: { root: invocation, limit: 100 },
    });
    expect(invocationNeighbors).toMatchObject({
      kind: "complete",
      result: {
        edges: expect.arrayContaining([
          {
            kind: "caused-by",
            from: { kind: "command", commandId: "command:edit-non-ascii-copy" },
            to: invocation,
          },
          {
            kind: "part-of-turn",
            from: invocation,
            to: {
              kind: "trajectory-turn",
              logId: "trajectory:test",
              head: "main",
              turnId: "turn:test",
            },
          },
        ]),
      },
    });
    const turn = {
      kind: "trajectory-turn" as const,
      logId: "trajectory:test",
      head: "main",
      turnId: "turn:test",
    };
    await expect(inspect(turn)).resolves.toMatchObject({
      node: {
        kind: "trajectory-turn",
        value: {
          turnId: "turn:test",
          triggerMessageId: "message:trigger",
          summary: "Move the parser",
        },
      },
    });
    const turnNeighbors = await semantic.dispatch("neighbors", {
      ingress,
      input: { root: turn, limit: 100 },
    });
    expect(turnNeighbors).toMatchObject({
      kind: "complete",
      result: {
        edges: expect.arrayContaining([
          {
            kind: "triggered-by",
            from: turn,
            to: {
              kind: "trajectory-message",
              logId: "trajectory:test",
              head: "main",
              messageId: "message:trigger",
            },
          },
        ]),
      },
    });
    const message = {
      kind: "trajectory-message" as const,
      logId: "trajectory:test",
      head: "main",
      messageId: "message:trigger",
    };
    await expect(inspect(message)).resolves.toMatchObject({
      node: {
        kind: "trajectory-message",
        value: {
          messageId: "message:trigger",
          role: "user",
          status: "completed",
          completedEventId: "trajectory-event:prompt",
          sourceMessageId: "channel-message:prompt",
          senderRef: { kind: "user", id: "user:alice", participantId: "user:alice" },
          textBlocks: [
            {
              blockId: "message-block:prompt",
              content: "Move the parser without changing its behavior",
            },
          ],
        },
      },
    });
    const editedContentHash = sha256Hex(new TextEncoder().encode("a😀Xz"));
    const readMemoryDispatch = await semantic.dispatch("readMemory", {
      ingress,
      input: {
        contextId: "context:test",
        path: "packages/fixture/src/moved-copy.ts",
        expectedContentHash: editedContentHash,
        range: { start: 3, end: 4 },
        episodeLimit: 4,
        historyLimit: 3,
      },
    });
    expect(readMemoryDispatch).toMatchObject({
      kind: "complete",
      result: {
        status: "attached",
        contentHash: editedContentHash,
        range: { start: 3, end: 4 },
        coordinateKind: "utf16",
        episodes: [
          {
            ranges: [{ start: 3, end: 4 }],
            stop: "authored",
            change: { kind: "change", changeId: editChangeId },
            workUnit: { kind: "work-unit", workUnitId: edited.workUnitId },
            intent: {
              tier: "trigger",
              text: "asked by user:alice: Move the parser without changing its behavior",
            },
            authorContextId: "context:test",
            command: { kind: "command", commandId: "command:edit-non-ascii-copy" },
            arrival: null,
          },
        ],
      },
    });
    await expect(
      semantic.dispatch("readMemory", {
        ingress,
        input: {
          contextId: "context:test",
          path: "packages/fixture/src/moved-copy.ts",
          expectedContentHash: nonAsciiContentHash,
          range: { start: 3, end: 4 },
          episodeLimit: 4,
          historyLimit: 3,
        },
      })
    ).resolves.toMatchObject({
      kind: "complete",
      result: {
        status: "stale",
        expectedContentHash: nonAsciiContentHash,
        currentContentHash: editedContentHash,
      },
    });
    const messageNeighbors = await semantic.dispatch("neighbors", {
      ingress,
      input: { root: message, limit: 100 },
    });
    expect(messageNeighbors).toMatchObject({
      kind: "complete",
      result: {
        edges: expect.arrayContaining([
          {
            kind: "triggered-by",
            from: turn,
            to: message,
          },
        ]),
      },
    });

    const collectNeighborPages = async (root: VcsSemanticNodeRef) => {
      const edges: VcsProvenanceEdge[] = [];
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const dispatch = await semantic.dispatch("neighbors", {
          ingress,
          input: { root, limit: 1, ...(cursor ? { cursor } : {}) },
        });
        if (dispatch.kind !== "complete") throw new Error("neighbors did not complete");
        const page = vcsNeighborsResultSchema.parse(dispatch.result);
        edges.push(...page.edges);
        if (!page.nextCursor) return edges;
        expect(page.nextCursor).toMatch(/^semantic-page-v2\./);
        cursor = page.nextCursor;
      }
      throw new Error("neighbor paging did not terminate");
    };
    const expectedNeighborEdges = (dispatch: SemanticDispatchResult) => {
      if (dispatch.kind !== "complete") throw new Error("neighbors did not complete");
      return vcsNeighborsResultSchema.parse(dispatch.result).edges;
    };
    const trajectory = {
      kind: "trajectory" as const,
      logId: "trajectory:test",
      head: "main",
    };
    const trajectoryNeighbors = await semantic.dispatch("neighbors", {
      ingress,
      input: { root: trajectory, limit: 100 },
    });
    const originalChangeNeighbors = await semantic.dispatch("neighbors", {
      ingress,
      input: { root: { kind: "change", changeId: importedChangeIds[1]! }, limit: 100 },
    });
    const counteractionNeighbors = await semantic.dispatch("neighbors", {
      ingress,
      input: { root: { kind: "change", changeId: reverted.changeIds[0]! }, limit: 100 },
    });
    const counteractionEdge = {
      kind: "counteracts",
      from: { kind: "change", changeId: reverted.changeIds[0]! },
      to: { kind: "change", changeId: importedChangeIds[1]! },
    };
    expect(expectedNeighborEdges(originalChangeNeighbors)).toContainEqual(counteractionEdge);
    expect(expectedNeighborEdges(counteractionNeighbors)).toContainEqual(counteractionEdge);
    for (const [root, dispatch] of [
      [{ kind: "change" as const, changeId: editChangeId }, changeNeighbors],
      [{ kind: "change" as const, changeId: importedChangeIds[1]! }, originalChangeNeighbors],
      [{ kind: "change" as const, changeId: reverted.changeIds[0]! }, counteractionNeighbors],
      [{ kind: "work-unit" as const, workUnitId: edited.workUnitId }, workNeighbors],
      [
        { kind: "command" as const, commandId: "command:edit-non-ascii-copy" },
        editCommandNeighbors,
      ],
      [invocation, invocationNeighbors],
      [turn, turnNeighbors],
      [message, messageNeighbors],
      [trajectory, trajectoryNeighbors],
    ] satisfies ReadonlyArray<readonly [VcsSemanticNodeRef, SemanticDispatchResult]>) {
      const expected = expectedNeighborEdges(dispatch);
      expect(expected.length).toBeGreaterThan(1);
      await expect(collectNeighborPages(root)).resolves.toEqual(expected);
    }

    const nodeKey = (node: VcsSemanticNodeRef) => JSON.stringify(node);
    const edgeKey = (edge: VcsProvenanceEdge) => JSON.stringify(edge);
    const queued = new Set<string>();
    const queue: VcsSemanticNodeRef[] = [edited.workingHead];
    const adjacency = new Map<string, Set<string>>();
    const observedRelations = new Set<string>();
    while (queue.length > 0) {
      const root = queue.shift()!;
      const rootKey = nodeKey(root);
      if (queued.has(rootKey)) continue;
      queued.add(rootKey);
      if (queued.size > 5_000) throw new Error("provenance fixture did not remain bounded");
      const edges = await collectNeighborPages(root);
      adjacency.set(rootKey, new Set(edges.map(edgeKey)));
      for (const edge of edges) {
        observedRelations.add(`${edge.kind}:${edge.from.kind}:${edge.to.kind}`);
        for (const endpoint of [edge.from, edge.to]) {
          if (!queued.has(nodeKey(endpoint))) queue.push(endpoint);
        }
      }
    }
    for (const edges of adjacency.values()) {
      for (const serialized of edges) {
        const edge = JSON.parse(serialized) as VcsProvenanceEdge;
        expect(adjacency.get(nodeKey(edge.from)), serialized).toContain(serialized);
        expect(adjacency.get(nodeKey(edge.to)), serialized).toContain(serialized);
      }
    }
    const normalizedRelations = Object.entries(vcsProvenanceRelationRegistry).flatMap(
      ([kind, variants]) => variants.map((variant) => `${kind}:${variant.from}:${variant.to}`)
    );
    expect([...observedRelations].sort()).toEqual([...normalizedRelations].sort());

    const collectHistoryPages = async (
      root:
        | { kind: "event"; eventId: string }
        | {
            kind: "file";
            state: { kind: "application"; applicationId: string };
            repositoryId: string;
            fileId: string;
          }
    ) => {
      const entries: unknown[] = [];
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const dispatch = await semantic.dispatch("history", {
          ingress,
          input: { root, direction: "past", limit: 1, ...(cursor ? { cursor } : {}) },
        });
        if (dispatch.kind !== "complete") throw new Error("history did not complete");
        const page = vcsHistoryResultSchema.parse(dispatch.result);
        entries.push(...page.entries);
        if (!page.nextCursor) return entries;
        expect(page.nextCursor).toMatch(/^semantic-page-v2\./);
        expect(page.nextCursor.length).toBeLessThan(512);
        cursor = page.nextCursor;
      }
      throw new Error("history paging did not terminate");
    };
    if (fileHistory.kind !== "complete") throw new Error("history did not complete");
    const expectedFileHistory = vcsHistoryResultSchema.parse(fileHistory.result).entries;
    const fileHistoryRoot = {
      kind: "file" as const,
      state: edited.workingHead,
      repositoryId,
      fileId: copiedFileId,
    };
    const firstFileHistoryPage = await semantic.dispatch("history", {
      ingress,
      input: { root: fileHistoryRoot, direction: "past", limit: 1 },
    });
    if (firstFileHistoryPage.kind !== "complete") throw new Error("history did not complete");
    const exactHistoryCursor = vcsHistoryResultSchema.parse(firstFileHistoryPage.result).nextCursor;
    expect(exactHistoryCursor).toMatch(/^semantic-page-v2\./);
    expect(exactHistoryCursor!.length).toBeLessThan(512);
    const corruptedHistoryCursor = `${exactHistoryCursor!.slice(0, -1)}${exactHistoryCursor!.endsWith("A") ? "B" : "A"}`;
    await expect(
      semantic.dispatch("history", {
        ingress,
        input: {
          root: fileHistoryRoot,
          direction: "past",
          limit: 1,
          cursor: corruptedHistoryCursor,
        },
      })
    ).rejects.toThrow(/cursor does not match its exact basis/u);
    await expect(
      semantic.dispatch("history", {
        ingress,
        input: {
          root: { ...fileHistoryRoot, fileId: importedFileId },
          direction: "past",
          limit: 1,
          cursor: exactHistoryCursor!,
        },
      })
    ).rejects.toThrow(/cursor does not match its exact basis/u);
    await expect(collectHistoryPages(fileHistoryRoot)).resolves.toEqual(expectedFileHistory);

    const eventHistory = await semantic.dispatch("history", {
      ingress,
      input: {
        root: { kind: "event", eventId: imported.eventId },
        direction: "past",
        limit: 100,
      },
    });
    if (eventHistory.kind !== "complete") throw new Error("history did not complete");
    const expectedEventHistory = vcsHistoryResultSchema.parse(eventHistory.result).entries;
    expect(expectedEventHistory.length).toBeGreaterThan(1);
    expect(expectedEventHistory.every((entry) => entry.intent === undefined)).toBe(true);
    await expect(
      collectHistoryPages({ kind: "event", eventId: imported.eventId })
    ).resolves.toEqual(expectedEventHistory);
  });
});
