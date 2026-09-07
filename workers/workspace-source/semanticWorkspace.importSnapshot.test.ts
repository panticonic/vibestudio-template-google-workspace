// Builtin semantic-authority tests.
import { describe, expect, it } from "vitest";
import { canonicalSnapshotDigest, sha256Hex } from "@vibestudio/content-addressing";
import {
  vcsInspectResultSchema,
  vcsNeighborsResultSchema,
  type VcsProvenanceEdge,
  type VcsSemanticNodeRef,
} from "@vibestudio/service-schemas/vcs";
import { createInMemorySql } from "@vibestudio/durable/test-utils";
import { compactId } from "@workspace/vcs-engine";
import { createSemanticVcsSchema } from "./semanticVcsSchema.js";
import {
  SemanticWorkspace,
  type SemanticDispatchRequest,
  type SemanticDispatchResult,
} from "./semanticWorkspace.js";
import { SemanticVcsStore } from "./semanticVcsStore.js";

const timestamp = "2026-07-15T00:00:00.000Z";

async function authorityFixture() {
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
  sql.exec(
    `INSERT INTO trajectory_invocations
     (log_id, head, invocation_id, status, updated_at)
     VALUES ('trajectory:test', 'main', 'invocation:test', 'active', ?)`,
    timestamp
  );
  const store = new SemanticVcsStore(sql, () => timestamp);
  let transactionOrdinal = 0;
  const createSemantic = (querySql = sql) =>
    new SemanticWorkspace({
      workspaceId: "workspace:test",
      sql: querySql,
      store,
      now: () => timestamp,
      transaction: <T>(fn: () => T): T => {
        const savepoint = `import_snapshot_test_${transactionOrdinal++}`;
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
  const semantic = createSemantic();
  const initial = store.initializeWorkspace("context:test", "command:genesis");
  return { semantic, restart: createSemantic, sql, store, initial };
}

const textFile = (path: string, text: string, mode = 0o644) => {
  const bytes = new TextEncoder().encode(text);
  return {
    bytes,
    descriptor: {
      path,
      contentHash: sha256Hex(bytes),
      mode,
    },
  };
};

const intrinsicDescriptor = (bytes: Uint8Array) => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      contentKind: "text" as const,
      byteLength: bytes.length,
      coordinateExtent: text.length,
    };
  } catch {
    return {
      contentKind: "bytes" as const,
      byteLength: bytes.length,
      coordinateExtent: bytes.length,
    };
  }
};

function acknowledgeImportObservation(
  semantic: SemanticWorkspace,
  dispatch: SemanticDispatchResult,
  bytesByHash: ReadonlyMap<string, Uint8Array>
): SemanticDispatchResult {
  if (dispatch.kind !== "effects-pending") throw new Error("import did not request observation");
  const effect = dispatch.effects[0]!;
  expect(effect.kind).toBe("observe-content");
  const files = effect.payload["files"] as Array<{ contentHash: string }>;
  expect(new Set(files.map((file) => file.contentHash)).size).toBe(files.length);
  return semantic.acknowledgeEffect({
    effectId: effect.effectId,
    payloadDigest: effect.payloadDigest,
    receipt: {
      files: files.map((file) => {
        const bytes = bytesByHash.get(file.contentHash);
        if (!bytes) throw new Error(`fixture lacks ${file.contentHash}`);
        return { contentHash: file.contentHash, ...intrinsicDescriptor(bytes) };
      }),
    },
  });
}

function acknowledgeMaterialization(
  semantic: SemanticWorkspace,
  dispatch: SemanticDispatchResult,
  contentRoot = `state:${"0".repeat(64)}`
): void {
  if (dispatch.kind !== "effects-pending") throw new Error("mutation did not request projection");
  const effect = dispatch.effects[0]!;
  expect(effect.kind).toBe("materialize-context");
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
          contentRoot,
        })),
      payloadDigest: effect.payload["payloadDigest"],
    },
  });
}

async function completeImport(
  semantic: SemanticWorkspace,
  request: SemanticDispatchRequest,
  bytesByHash: ReadonlyMap<string, Uint8Array>
): Promise<{
  contextId: string;
  eventId: string;
  workUnitId: string;
  applicationId: string;
  externalSnapshot: {
    sourceKind: "git" | "archive" | "filesystem" | "upload" | "generated";
    sourceUri: string;
    snapshotRevision: string;
    snapshotDigest: string;
    targetRepositoryIds: string[];
  };
  importedRepositoryIds: string[];
}> {
  const observation = await semantic.dispatch("importSnapshot", request);
  const projection = acknowledgeImportObservation(semantic, observation, bytesByHash);
  if (projection.kind !== "effects-pending") throw new Error("import did not complete");
  const result = projection.result as {
    contextId: string;
    eventId: string;
    workUnitId: string;
    applicationId: string;
    externalSnapshot: {
      sourceKind: "git" | "archive" | "filesystem" | "upload" | "generated";
      sourceUri: string;
      snapshotRevision: string;
      snapshotDigest: string;
      targetRepositoryIds: string[];
    };
    importedRepositoryIds: string[];
  };
  acknowledgeMaterialization(semantic, projection);
  return result;
}

async function inspectAuthoredChanges(
  semantic: SemanticWorkspace,
  ingress: SemanticDispatchRequest["ingress"],
  workUnitId: string
) {
  const workInspection = await semantic.dispatch("inspect", {
    ingress,
    input: { node: { kind: "work-unit", workUnitId }, edgeLimit: 20 },
  });
  if (workInspection.kind !== "complete") throw new Error("work inspection did not complete");
  const changeIds = (workInspection.result as { node: { value: { authoredChangeIds: string[] } } })
    .node.value.authoredChangeIds;
  return Promise.all(
    changeIds.map(async (changeId) => {
      const inspected = await semantic.dispatch("inspect", {
        ingress,
        input: { node: { kind: "change", changeId }, edgeLimit: 20 },
      });
      if (inspected.kind !== "complete") throw new Error("change inspection did not complete");
      return inspected.result as {
        node: {
          value: {
            changeId: string;
            kind: string;
            effects: Array<Record<string, unknown>>;
          };
        };
        edges: Array<Record<string, unknown>>;
      };
    })
  );
}

describe("SemanticWorkspace snapshot import", () => {
  it("reads protected main directly without any context creation or semantic write", async () => {
    const { semantic, sql, initial } = await authorityFixture();
    const before = sql.exec("SELECT total_changes() AS writes").toArray();
    const result = await semantic.dispatch("mainState", {
      input: undefined,
      ingress: { causalParent: null, contextIntegrity: { class: "internal", externalKeys: [] } },
    });
    expect(result).toEqual({ kind: "complete", result: initial.committed.ref });
    expect(sql.exec("SELECT total_changes() AS writes").toArray()).toEqual(before);
  });

  it("attaches a runtime context without requesting a filesystem projection", async () => {
    const { semantic, store } = await authorityFixture();

    const attached = semantic.ensureContextCoordinate(
      {
        contextId: "context:runtime",
        commandId: "command:attach-runtime",
      },
      { causalParent: null, contextIntegrity: { class: "internal", externalKeys: [] } }
    );

    expect(attached).toEqual({
      kind: "complete",
      result: {
        ...store.context("context:runtime"),
      },
    });
    expect(store.pendingEffects("command:attach-runtime")).toEqual([]);
  });

  it("keeps semantic mutations projection-free until a filesystem consumer upgrades them", async () => {
    const { semantic, store } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: null,
      contextIntegrity: { class: "internal", externalKeys: [] },
    };
    semantic.ensureContextCoordinate(
      {
        contextId: "context:semantic-only",
        commandId: "command:attach-semantic-only",
      },
      ingress
    );
    const working = store.contextRequired("context:semantic-only").working.ref;

    const operationRecordText = '{"operationId":"template-add-google-workspace"}\n';
    const operationRecordHash = sha256Hex(new TextEncoder().encode(operationRecordText));
    const edited = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:semantic-only",
        commandId: "command:semantic-edit",
        expectedWorkingHead: working,
        intentSummary: "Record a resumable semantic-only operation",
        changes: [
          {
            kind: "repository-create",
            repoPath: "meta",
            files: [
              {
                path: "template-operations/record.json",
                content: { kind: "text", text: operationRecordText },
                mode: 0o644,
              },
            ],
          },
        ],
      },
    });
    expect(edited).toMatchObject({
      kind: "effects-pending",
      effects: [
        {
          kind: "materialize-context",
          payload: {
            version: 1,
            mode: "content-only",
            contextId: "context:semantic-only",
            blobs: [
              {
                contentHash: operationRecordHash,
              },
            ],
          },
        },
      ],
    });
    if (edited.kind !== "effects-pending") throw new Error("semantic edit did not persist content");
    const persistence = edited.effects[0]!;
    const persisted = semantic.acknowledgeEffect({
      effectId: persistence.effectId,
      payloadDigest: persistence.payloadDigest,
      receipt: {
        version: 1,
        contentHashes: [operationRecordHash],
      },
    });
    expect(persisted).toMatchObject({ kind: "complete" });
    expect(semantic.contentGcRoots().contentHashes).toContain(operationRecordHash);
    const editedWorking = store.contextRequired("context:semantic-only").working.ref;

    const discarded = await semantic.dispatch("discard", {
      ingress,
      input: {
        contextId: "context:semantic-only",
        commandId: "command:semantic-discard",
        expectedWorkingHead: editedWorking,
      },
    });

    expect(discarded).toMatchObject({ kind: "complete" });
    expect(store.pendingEffects("command:semantic-discard")).toEqual([]);
    expect(store.contextProjectionRequired("context:semantic-only")).toBe(false);

    semantic.ensureContext(
      {
        contextId: "context:semantic-only",
        commandId: "command:require-projection",
      },
      ingress
    );
    expect(store.contextProjectionRequired("context:semantic-only")).toBe(true);
  });

  it("does not initialize a forked context again when a runtime attaches to it", async () => {
    const { semantic, store, initial } = await authorityFixture();
    const forked = semantic.forkContext(
      {
        sourceContextId: "context:test",
        targetContextId: "context:subagent",
        commandId: "command:fork-subagent",
      },
      { causalParent: null, contextIntegrity: { class: "internal", externalKeys: [] } }
    );
    expect(forked).toMatchObject({ kind: "effects-pending" });
    acknowledgeMaterialization(semantic, forked);

    const attached = semantic.ensureContext(
      {
        contextId: "context:subagent",
        commandId: "command:attach-subagent-runtime",
      },
      { causalParent: null, contextIntegrity: { class: "internal", externalKeys: [] } }
    );

    expect(attached).toEqual({
      kind: "complete",
      result: {
        ...store.context("context:subagent"),
      },
    });
    expect(store.pendingEffects("command:attach-subagent-runtime")).toEqual([]);
    expect(store.context("context:subagent")?.working.ref).toEqual(initial.working.ref);
  });

  it("stops honestly at the exact import boundary without a parallel external graph", async () => {
    const { semantic, restart, store, initial } = await authorityFixture();
    const sourceFile = textFile("src/index.ts", "hello");
    const sourceSnapshot = canonicalSnapshotDigest([
      {
        path: sourceFile.descriptor.path,
        mode: 0o100644,
        size: sourceFile.bytes.byteLength,
        contentHash: sourceFile.descriptor.contentHash,
      },
    ]);
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
      contextIntegrity: { class: "internal", externalKeys: [] },
    };
    const observationDispatch = await semantic.dispatch("importSnapshot", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:git-import",
        expectedWorkingHead: initial.working.ref,
        intentSummary: "Bring in the upstream project",
        source: {
          kind: "git",
          url: "https://example.test/project.git",
          commit: "a".repeat(40),
          snapshot: sourceSnapshot,
        },
        repositories: [
          {
            repoPath: "projects/imported",
            files: [sourceFile.descriptor],
          },
        ],
      },
    });
    const importedDispatch = acknowledgeImportObservation(
      semantic,
      observationDispatch,
      new Map([[sourceFile.descriptor.contentHash, sourceFile.bytes]])
    );
    if (importedDispatch.kind !== "effects-pending") throw new Error("import did not complete");
    const imported = importedDispatch.result as {
      eventId: string;
      workUnitId: string;
      applicationId: string;
      externalSnapshot: {
        sourceKind: string;
        sourceUri: string;
        snapshotRevision: string;
        snapshotDigest: string;
        targetRepositoryIds: string[];
      };
      importedRepositoryIds: string[];
    };
    const state = { kind: "event" as const, eventId: imported.eventId };
    const root = store.stateRoot(state);
    const repositoryId = imported.importedRepositoryIds[0]!;
    expect(imported.applicationId).toMatch(/^application:/);
    expect(imported.externalSnapshot).toEqual({
      sourceKind: "git",
      sourceUri: "https://example.test/project.git",
      snapshotRevision: "a".repeat(40),
      sourceSubdir: null,
      canonicalSnapshot: sourceSnapshot,
      snapshotDigest: expect.any(String),
      targetRepositoryIds: [repositoryId],
    });
    const file = store.facts.fileAtPath(root, repositoryId, "src/index.ts")?.state;
    if (!file || file.presence !== "placed") throw new Error("imported file is absent");

    const restarted = restart();
    await expect(
      restarted.dispatch("resolveRepository", {
        ingress,
        input: { state, repoPath: "projects/imported" },
      })
    ).resolves.toEqual({
      kind: "complete",
      result: { state, repositoryId, repoPath: "projects/imported" },
    });
    await expect(
      restarted.dispatch("resolveRepository", {
        ingress,
        input: { state, repoPath: "projects/missing" },
      })
    ).resolves.toEqual({ kind: "complete", result: null });
    const workInspection = await restarted.dispatch("inspect", {
      ingress,
      input: {
        node: { kind: "work-unit", workUnitId: imported.workUnitId },
        edgeLimit: 20,
      },
    });
    if (workInspection.kind !== "complete") throw new Error("work inspection did not complete");
    const inspectedWork = (
      workInspection.result as {
        node: {
          value: {
            authoredChangeCount: number;
            authoredChangeIds: string[];
            externalSnapshot: Record<string, unknown>;
            contentClass: "internal" | "external";
            externalKeys: string[];
          };
        };
      }
    ).node.value;
    expect(inspectedWork).toMatchObject({
      authoredChangeCount: 2,
      contentClass: "external",
      externalKeys: [`repo:https://example.test/project.git@${"a".repeat(40)}`],
      externalSnapshot: {
        sourceKind: "git",
        sourceUri: "https://example.test/project.git",
        snapshotRevision: "a".repeat(40),
        sourceSubdir: null,
        canonicalSnapshot: sourceSnapshot,
        snapshotDigest: compactId("snapshot", [
          {
            repoPath: "projects/imported",
            files: [
              {
                ...sourceFile.descriptor,
                ...intrinsicDescriptor(sourceFile.bytes),
              },
            ],
          },
        ]),
        targetRepositoryIds: [repositoryId],
      },
    });
    const read = await restarted.dispatch("readFile", {
      ingress,
      input: {
        state,
        repositoryId,
        file: { kind: "id", fileId: file.fileId },
      },
    });
    expect(read).toMatchObject({
      kind: "host-read",
      request: {
        authoredByWorkUnitId: imported.workUnitId,
        contentClass: "external",
        externalKeys: [`repo:https://example.test/project.git@${"a".repeat(40)}`],
      },
    });
    const listed = await restarted.dispatch("listFiles", {
      ingress,
      input: {
        state,
        repositoryId,
        limit: 500,
      },
    });
    expect(listed).toMatchObject({
      kind: "complete",
      result: {
        files: [
          {
            fileId: file.fileId,
            authoredByWorkUnitId: imported.workUnitId,
            contentClass: "external",
            externalKeys: [`repo:https://example.test/project.git@${"a".repeat(40)}`],
          },
        ],
      },
    });
    const authoredChangeIds = inspectedWork.authoredChangeIds;
    const inspectedChanges = await Promise.all(
      authoredChangeIds.map(async (changeId) => {
        const inspected = await restarted.dispatch("inspect", {
          ingress,
          input: { node: { kind: "change", changeId }, edgeLimit: 20 },
        });
        if (inspected.kind !== "complete") throw new Error("change inspection did not complete");
        return inspected.result as {
          node: {
            value: {
              changeId: string;
              kind: string;
              effects: Array<Record<string, unknown>>;
            };
          };
          edges: Array<Record<string, unknown>>;
        };
      })
    );
    expect(inspectedChanges.map((entry) => entry.node.value.kind)).toEqual([
      "repository-create",
      "file-create",
    ]);
    const fileCreate = inspectedChanges[1]!;
    expect(fileCreate.node.value.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "content",
          fileId: file.fileId,
          beforeContentHash: null,
          afterContentHash: sourceFile.descriptor.contentHash,
        }),
      ])
    );
    expect(fileCreate.edges).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "imports-snapshot" })])
    );

    const blame = await restarted.dispatch("blame", {
      ingress,
      input: {
        state,
        repositoryId,
        fileId: file.fileId,
        range: { start: 0, end: 5 },
        limit: 20,
      },
    });
    expect(blame).toMatchObject({
      kind: "complete",
      result: {
        coordinateKind: "utf16",
        spans: [
          {
            start: 0,
            end: 5,
            change: { kind: "change", changeId: fileCreate.node.value.changeId },
            workUnit: { kind: "work-unit", workUnitId: imported.workUnitId },
            stop: "import-boundary",
            path: [],
          },
        ],
      },
    });
  });

  it("rejects Git descriptors that do not match their declared canonical snapshot", async () => {
    const { semantic, initial } = await authorityFixture();
    const sourceFile = textFile("src/index.ts", "hello");
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
      contextIntegrity: { class: "internal", externalKeys: [] },
    };
    const observation = await semantic.dispatch("importSnapshot", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:git-import-wrong-snapshot",
        expectedWorkingHead: initial.working.ref,
        source: {
          kind: "git",
          url: "https://example.test/project.git",
          commit: "c".repeat(40),
          snapshot: `v1-sha256:${"0".repeat(64)}`,
        },
        repositories: [{ repoPath: "projects/imported", files: [sourceFile.descriptor] }],
      },
    });
    expect(() =>
      acknowledgeImportObservation(
        semantic,
        observation,
        new Map([[sourceFile.descriptor.contentHash, sourceFile.bytes]])
      )
    ).toThrow("declared canonical snapshot");
  });

  it("registers, compares, integrates, commits, finalizes, and releases an external delta", async () => {
    const { semantic, sql, store, initial } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
      contextIntegrity: { class: "internal", externalKeys: [] },
    };
    const oldFile = textFile("index.ts", "old");
    const newFile = textFile("index.ts", "new");
    const imported = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:delta-basis",
          expectedWorkingHead: initial.working.ref,
          source: {
            kind: "generated",
            uri: "fixture://delta-basis",
            snapshotRevision: "v1",
          },
          repositories: [{ repoPath: "projects/delta", files: [oldFile.descriptor] }],
        },
      },
      new Map([[oldFile.descriptor.contentHash, oldFile.bytes]])
    );
    const repositoryId = imported.importedRepositoryIds[0]!;
    const snapshot = (file: ReturnType<typeof textFile>) =>
      canonicalSnapshotDigest([
        {
          path: file.descriptor.path,
          mode: 0o100644,
          size: file.bytes.byteLength,
          contentHash: file.descriptor.contentHash,
        },
      ]);
    const deltaInput = {
      contextId: "context:test",
      commandId: "command:register-delta",
      expectedWorkingHead: { kind: "event" as const, eventId: imported.eventId },
      intentSummary: "Update the generated template from v1 to v2",
      repositoryId,
      repoPath: "projects/delta",
      oldSource: {
        kind: "generated" as const,
        uri: "fixture://template/v1",
        snapshotRevision: "v1",
        snapshot: snapshot(oldFile),
      },
      newSource: {
        kind: "generated" as const,
        uri: "fixture://template/v2",
        snapshotRevision: "v2",
        snapshot: snapshot(newFile),
      },
      oldFiles: [oldFile.descriptor],
      newFiles: [newFile.descriptor],
    };
    const observedContent = new Map([
      [oldFile.descriptor.contentHash, oldFile.bytes],
      [newFile.descriptor.contentHash, newFile.bytes],
    ]);
    const registered = await semantic.dispatch("registerExternalDelta", {
      ingress,
      input: deltaInput,
    });
    const registration = acknowledgeImportObservation(semantic, registered, observedContent);
    if (registration.kind !== "complete") throw new Error("delta registration did not complete");
    const delta = registration.result as { deltaId: string; changeIds: string[] };
    const retried = await semantic.dispatch("registerExternalDelta", {
      ingress,
      input: { ...deltaInput, commandId: "command:register-delta-retry" },
    });
    const retry = acknowledgeImportObservation(semantic, retried, observedContent);
    expect(retry).toMatchObject({ kind: "complete", result: { deltaId: delta.deltaId } });
    expect(store.application(delta.deltaId)).toBeNull();
    expect(
      sql
        .exec(
          `SELECT application.application_id, COUNT(applied.applied_change_id) AS applied_change_count
           FROM gad_work_unit_applications application
           LEFT JOIN gad_applied_changes applied ON applied.application_id = application.application_id
          WHERE application.work_unit_id = (
            SELECT work_unit_id FROM gad_external_deltas WHERE delta_id = ?
          )
          GROUP BY application.application_id`,
          delta.deltaId
        )
        .toArray()
    ).toEqual([
      {
        application_id: expect.stringMatching(/^application:/u),
        applied_change_count: delta.changeIds.length,
      },
    ]);
    expect(semantic.contentGcRoots().contentHashes).toContain(newFile.descriptor.contentHash);

    const foreign = store.forkContext("context:test", "context:foreign");
    await expect(
      semantic.dispatch("merge", {
        ingress,
        input: {
          contextId: "context:foreign",
          commandId: "command:merge-foreign-delta",
          expectedWorkingHead: foreign.working.ref,
          source: { kind: "external-delta", deltaId: delta.deltaId },
        },
      })
    ).rejects.toMatchObject({ code: "InvalidReference" });

    const compared = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: { kind: "event", eventId: imported.eventId },
        source: { kind: "external-delta", deltaId: delta.deltaId },
        limit: 100,
      },
    });
    if (compared.kind !== "complete") throw new Error("delta compare did not complete");
    expect(compared.result).toMatchObject({
      source: { kind: "external-delta", deltaId: delta.deltaId },
      resolution: { complete: false, remainingCoordinateCount: 1, concluded: false },
      intentCounts: { pending: 1 },
      intents: [{ side: "theirs", state: "pending", intent: { tier: "stated" } }],
    });

    const integrated = await semantic.dispatch("merge", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:merge-delta",
        expectedWorkingHead: { kind: "event", eventId: imported.eventId },
        source: { kind: "external-delta", deltaId: delta.deltaId },
      },
    });
    acknowledgeMaterialization(semantic, integrated);
    if (integrated.kind !== "effects-pending")
      throw new Error("delta integration did not complete");
    const integratedResult = integrated.result as {
      workingHead: { kind: "application"; applicationId: string };
    };
    const committed = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:commit-delta",
        expectedWorkingHead: integratedResult.workingHead,
      },
    });
    acknowledgeMaterialization(semantic, committed);
    if (committed.kind !== "effects-pending") throw new Error("delta commit did not complete");
    const committedResult = committed.result as { event: { kind: "event"; eventId: string } };
    const finalized = await semantic.dispatch("finalizeExternalDelta", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:finalize-delta",
        expectedWorkingHead: committedResult.event,
        deltaId: delta.deltaId,
      },
    });
    expect(finalized).toMatchObject({ kind: "complete", result: { status: "finalized" } });
    const finalizedRetry = await semantic.dispatch("finalizeExternalDelta", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:finalize-delta-retry",
        expectedWorkingHead: committedResult.event,
        deltaId: delta.deltaId,
      },
    });
    expect(finalizedRetry).toMatchObject({
      kind: "complete",
      result: { deltaId: delta.deltaId, status: "finalized" },
    });
    const publishIntegratedDelta = await semantic.dispatch("push", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:publish-integrated-delta",
        expectedCommittedEventId: committedResult.event.eventId,
        expectedMainEventId: initial.committed.ref.eventId,
      },
    });
    expect(publishIntegratedDelta.kind).toBe("effects-pending");

    const noopRegistration = await semantic.dispatch("registerExternalDelta", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:register-noop-delta",
        expectedWorkingHead: committedResult.event,
        repositoryId,
        repoPath: "projects/delta",
        oldSource: {
          kind: "generated",
          uri: "fixture://template/v2",
          snapshotRevision: "v2",
          snapshot: snapshot(newFile),
        },
        newSource: {
          kind: "generated",
          uri: "fixture://template/v2-copy",
          snapshotRevision: "v2-copy",
          snapshot: snapshot(newFile),
        },
        oldFiles: [newFile.descriptor],
        newFiles: [newFile.descriptor],
      },
    });
    const noop = acknowledgeImportObservation(
      semantic,
      noopRegistration,
      new Map([[newFile.descriptor.contentHash, newFile.bytes]])
    );
    if (noop.kind !== "complete") throw new Error("noop delta registration did not complete");
    const noopDelta = noop.result as { deltaId: string };
    await expect(
      semantic.dispatch("supersedeExternalDelta", {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:supersede-noop-delta",
          expectedWorkingHead: committedResult.event,
          deltaId: noopDelta.deltaId,
        },
      })
    ).resolves.toMatchObject({ kind: "complete", result: { status: "superseded" } });
  });

  it("registers an external create that is already present as a convergent delta", async () => {
    const { semantic, initial } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: null,
      contextIntegrity: { class: "internal", externalKeys: [] },
    };
    const file = textFile("index.ts", "already here\n");
    const imported = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:convergent-create-basis",
          expectedWorkingHead: initial.working.ref,
          source: {
            kind: "generated",
            uri: "fixture://convergent-create-basis",
            snapshotRevision: "v1",
          },
          repositories: [{ repoPath: "projects/convergent-create", files: [file.descriptor] }],
        },
      },
      new Map([[file.descriptor.contentHash, file.bytes]])
    );
    const repositoryId = imported.importedRepositoryIds[0]!;
    const emptySnapshot = canonicalSnapshotDigest([]);
    const fileSnapshot = canonicalSnapshotDigest([
      {
        path: file.descriptor.path,
        mode: 0o100644,
        size: file.bytes.byteLength,
        contentHash: file.descriptor.contentHash,
      },
    ]);
    const target = { kind: "event" as const, eventId: imported.eventId };
    const registration = await semantic.dispatch("registerExternalDelta", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:register-convergent-create",
        expectedWorkingHead: target,
        repositoryId,
        repoPath: "projects/convergent-create",
        oldSource: {
          kind: "generated",
          uri: "fixture://convergent-create/empty",
          snapshotRevision: "empty",
          snapshot: emptySnapshot,
        },
        newSource: {
          kind: "generated",
          uri: "fixture://convergent-create/v1",
          snapshotRevision: "v1",
          snapshot: fileSnapshot,
        },
        oldFiles: [],
        newFiles: [file.descriptor],
      },
    });
    const registered = acknowledgeImportObservation(
      semantic,
      registration,
      new Map([[file.descriptor.contentHash, file.bytes]])
    );
    if (registered.kind !== "complete") throw new Error("delta registration did not complete");
    const deltaId = (registered.result as { deltaId: string }).deltaId;

    await expect(
      semantic.dispatch("compare", {
        ingress,
        input: { target, source: { kind: "external-delta", deltaId } },
      })
    ).resolves.toMatchObject({
      kind: "complete",
      result: {
        counts: { convergent: 1, conflict: 0 },
        resolution: { complete: true, concluded: false },
      },
    });
  });

  it("merges an external content update against its authored base without reverting a local mode", async () => {
    const { semantic, store, initial } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
      contextIntegrity: { class: "internal", externalKeys: [] },
    };
    const oldFile = textFile("index.ts", "old\n");
    const newFile = textFile("index.ts", "new\n");
    const imported = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:external-local-basis",
          expectedWorkingHead: initial.working.ref,
          source: {
            kind: "generated",
            uri: "fixture://external-local-basis",
            snapshotRevision: "v1",
          },
          repositories: [{ repoPath: "projects/external-local", files: [oldFile.descriptor] }],
        },
      },
      new Map([[oldFile.descriptor.contentHash, oldFile.bytes]])
    );
    const repositoryId = imported.importedRepositoryIds[0]!;
    const importedRoot = store.stateRoot({ kind: "event", eventId: imported.eventId });
    const file = store.facts.fileAtPath(importedRoot, repositoryId, oldFile.descriptor.path);
    if (!file || file.state.presence !== "placed") throw new Error("missing imported file");
    const localMode = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:external-local-mode",
        expectedWorkingHead: { kind: "event", eventId: imported.eventId },
        changes: [{ kind: "file-mode", repositoryId, fileId: file.state.fileId, mode: 0o755 }],
      },
    });
    if (localMode.kind !== "effects-pending") throw new Error("local mode did not complete");
    const localHead = (
      localMode.result as { workingHead: { kind: "application"; applicationId: string } }
    ).workingHead;
    acknowledgeMaterialization(semantic, localMode);
    const snapshot = (candidate: ReturnType<typeof textFile>) =>
      canonicalSnapshotDigest([
        {
          path: candidate.descriptor.path,
          mode: 0o100644,
          size: candidate.bytes.byteLength,
          contentHash: candidate.descriptor.contentHash,
        },
      ]);
    const registration = await semantic.dispatch("registerExternalDelta", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:external-local-register",
        expectedWorkingHead: localHead,
        repositoryId,
        repoPath: "projects/external-local",
        oldSource: {
          kind: "generated",
          uri: "fixture://external-local/v1",
          snapshotRevision: "v1",
          snapshot: snapshot(oldFile),
        },
        newSource: {
          kind: "generated",
          uri: "fixture://external-local/v2",
          snapshotRevision: "v2",
          snapshot: snapshot(newFile),
        },
        oldFiles: [oldFile.descriptor],
        newFiles: [newFile.descriptor],
      },
    });
    const registered = acknowledgeImportObservation(
      semantic,
      registration,
      new Map([
        [oldFile.descriptor.contentHash, oldFile.bytes],
        [newFile.descriptor.contentHash, newFile.bytes],
      ])
    );
    if (registered.kind !== "complete") throw new Error("delta registration did not complete");
    const deltaId = (registered.result as { deltaId: string }).deltaId;
    const compared = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: localHead,
        source: { kind: "external-delta", deltaId },
        limit: 100,
      },
    });
    if (compared.kind !== "complete") throw new Error("delta comparison did not complete");
    expect(compared.result).toMatchObject({ counts: { composed: 1, conflict: 0 } });
    const [coordinate] = (
      compared.result as {
        coordinates: Array<{
          status: string;
          aspects: Array<{ aspect: string; status: string }>;
        }>;
      }
    ).coordinates;
    expect(coordinate?.status).toBe("composed");
    expect(coordinate?.aspects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ aspect: "content", status: "adopt" }),
        expect.objectContaining({ aspect: "mode", status: "ours" }),
      ])
    );
    const merge = await semantic.dispatch("merge", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:external-local-merge",
        expectedWorkingHead: localHead,
        source: { kind: "external-delta", deltaId },
      },
    });
    if (merge.kind !== "effects-pending") throw new Error("delta merge did not complete");
    const mergedHead = (
      merge.result as { workingHead: { kind: "application"; applicationId: string } }
    ).workingHead;
    acknowledgeMaterialization(semantic, merge);
    expect(store.facts.file(store.stateRoot(mergedHead), file.state.fileId)?.state).toMatchObject({
      contentHash: newFile.descriptor.contentHash,
      mode: 0o755,
    });
  });

  it("accepts an external deletion when the same path is already locally absent", async () => {
    const { semantic, store, initial } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: null,
      contextIntegrity: { class: "internal", externalKeys: [] },
    };
    const oldFile = textFile("obsolete.ts", "obsolete\n");
    const imported = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:external-delete-basis",
          expectedWorkingHead: initial.working.ref,
          source: {
            kind: "generated",
            uri: "fixture://external-delete-basis",
            snapshotRevision: "v1",
          },
          repositories: [{ repoPath: "projects/external-delete", files: [oldFile.descriptor] }],
        },
      },
      new Map([[oldFile.descriptor.contentHash, oldFile.bytes]])
    );
    const repositoryId = imported.importedRepositoryIds[0]!;
    const importedRoot = store.stateRoot({ kind: "event", eventId: imported.eventId });
    const file = store.facts.fileAtPath(importedRoot, repositoryId, oldFile.descriptor.path);
    if (!file || file.state.presence !== "placed") throw new Error("missing imported file");
    const deletion = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:local-delete-before-external",
        expectedWorkingHead: { kind: "event", eventId: imported.eventId },
        changes: [{ kind: "file-delete", repositoryId, fileId: file.state.fileId }],
      },
    });
    if (deletion.kind !== "effects-pending") throw new Error("local deletion did not complete");
    const localHead = (
      deletion.result as { workingHead: { kind: "application"; applicationId: string } }
    ).workingHead;
    acknowledgeMaterialization(semantic, deletion);
    const oldSnapshot = canonicalSnapshotDigest([
      {
        path: oldFile.descriptor.path,
        mode: 0o100644,
        size: oldFile.bytes.byteLength,
        contentHash: oldFile.descriptor.contentHash,
      },
    ]);
    const emptySnapshot = canonicalSnapshotDigest([]);
    const registration = await semantic.dispatch("registerExternalDelta", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:register-already-absent-delete",
        expectedWorkingHead: localHead,
        repositoryId,
        repoPath: "projects/external-delete",
        oldSource: {
          kind: "generated",
          uri: "fixture://external-delete/v1",
          snapshotRevision: "v1",
          snapshot: oldSnapshot,
        },
        newSource: {
          kind: "generated",
          uri: "fixture://external-delete/v2",
          snapshotRevision: "v2",
          snapshot: emptySnapshot,
        },
        oldFiles: [oldFile.descriptor],
        newFiles: [],
      },
    });
    const registered = acknowledgeImportObservation(
      semantic,
      registration,
      new Map([[oldFile.descriptor.contentHash, oldFile.bytes]])
    );
    if (registered.kind !== "complete") throw new Error("delta registration did not complete");
    const deltaId = (registered.result as { deltaId: string }).deltaId;
    await expect(
      semantic.dispatch("compare", {
        ingress,
        input: {
          target: localHead,
          source: { kind: "external-delta", deltaId },
          limit: 100,
        },
      })
    ).resolves.toMatchObject({
      kind: "complete",
      result: { counts: { convergent: 1, conflict: 0 } },
    });
  });

  it("reserves merge capacity for an explicit resolution before selecting clean coordinates", async () => {
    const { semantic, store, initial } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
      contextIntegrity: { class: "internal", externalKeys: [] },
    };
    const files = Array.from({ length: 501 }, (_, index) =>
      textFile(
        `file-${String(index).padStart(3, "0")}.ts`,
        `export const value${index} = ${index};\n`
      )
    );
    const imported = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:merge-page-basis",
          expectedWorkingHead: initial.working.ref,
          source: {
            kind: "generated",
            uri: "fixture://merge-page-basis",
            snapshotRevision: "v1",
          },
          repositories: [
            { repoPath: "projects/merge-page", files: files.map((file) => file.descriptor) },
          ],
        },
      },
      new Map(files.map((file) => [file.descriptor.contentHash, file.bytes]))
    );
    const repositoryId = imported.importedRepositoryIds[0]!;
    store.forkContext("context:test", "context:target");
    const root = store.stateRoot({ kind: "event", eventId: imported.eventId });
    const repository = store.facts.member(root, repositoryId);
    if (!repository || repository.presence !== "present") {
      throw new Error("missing imported repository");
    }
    const manifestFiles = store.facts.pageManifest(repository.fileManifestId, {
      limit: files.length,
    });
    if (manifestFiles.next !== null || manifestFiles.values.length !== files.length) {
      throw new Error("incomplete imported manifest");
    }
    const fileIdByPath = new Map(
      manifestFiles.values.map((entry) => [entry.path, entry.fileId] as const)
    );
    const fileIds = files.map((file) => {
      const fileId = fileIdByPath.get(file.descriptor.path);
      if (!fileId) throw new Error("missing imported file");
      return fileId;
    });

    let sourceHead:
      | { kind: "event"; eventId: string }
      | {
          kind: "application";
          applicationId: string;
        } = { kind: "event", eventId: imported.eventId };
    for (let offset = 0; offset < fileIds.length; offset += 200) {
      const sourceEdit = await semantic.dispatch("edit", {
        ingress,
        input: {
          contextId: "context:test",
          commandId: `command:source-mode-page-${offset / 200}`,
          expectedWorkingHead: sourceHead,
          changes: fileIds.slice(offset, offset + 200).map((fileId) => ({
            kind: "file-mode" as const,
            repositoryId,
            fileId,
            mode: 0o755,
          })),
        },
      });
      if (sourceEdit.kind !== "effects-pending") throw new Error("source edit did not complete");
      sourceHead = (sourceEdit.result as { workingHead: typeof sourceHead }).workingHead;
      acknowledgeMaterialization(semantic, sourceEdit);
    }
    const sourceCommit = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:commit-merge-page-source",
        expectedWorkingHead: sourceHead,
      },
    });
    if (sourceCommit.kind !== "effects-pending") throw new Error("source commit did not complete");
    const sourceEvent = (sourceCommit.result as { event: { kind: "event"; eventId: string } })
      .event;
    acknowledgeMaterialization(semantic, sourceCommit);

    const targetEdit = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:target",
        commandId: "command:target-mode-conflict",
        expectedWorkingHead: { kind: "event", eventId: imported.eventId },
        changes: [{ kind: "file-mode", repositoryId, fileId: fileIds[0]!, mode: 0o600 }],
      },
    });
    if (targetEdit.kind !== "effects-pending") throw new Error("target edit did not complete");
    const targetHead = (
      targetEdit.result as { workingHead: { kind: "application"; applicationId: string } }
    ).workingHead;
    acknowledgeMaterialization(semantic, targetEdit);

    const merge = await semantic.dispatch("merge", {
      ingress,
      input: {
        contextId: "context:target",
        commandId: "command:resolve-before-clean-page",
        expectedWorkingHead: targetHead,
        source: { kind: "event", eventId: sourceEvent.eventId },
        resolutions: [
          {
            coordinate: { kind: "file", id: fileIds[0]! },
            resolution: "theirs",
          },
        ],
      },
    });
    if (merge.kind !== "effects-pending") throw new Error("merge did not complete");
    const result = merge.result as {
      workingHead: { kind: "application"; applicationId: string };
      outcomes: unknown[];
      resolution: { complete: boolean; remainingCoordinateCount: number };
    };
    acknowledgeMaterialization(semantic, merge);
    expect(result.outcomes).toHaveLength(500);
    expect(result.resolution).toMatchObject({ complete: false, remainingCoordinateCount: 1 });
    expect(store.facts.file(store.stateRoot(result.workingHead), fileIds[0]!)?.state).toMatchObject(
      {
        mode: 0o755,
      }
    );
  }, 30_000);

  it("rejects invalid host-observed intrinsic descriptors atomically", async () => {
    const source = textFile("src/index.ts", "a😀éz");
    const cases = [
      {
        name: "coordinate extent",
        receipt: { contentKind: "text", byteLength: source.bytes.length, coordinateExtent: 99 },
      },
      {
        name: "binary extent",
        receipt: { contentKind: "bytes", byteLength: source.bytes.length, coordinateExtent: 1 },
      },
    ] as const;

    for (const testCase of cases) {
      const { semantic, store, initial } = await authorityFixture();
      const commandId = `command:invalid-import-${testCase.name.replace(" ", "-")}`;
      const observation = await semantic.dispatch("importSnapshot", {
        ingress: {
          causalParent: {
            kind: "trajectory-invocation",
            logId: "trajectory:test",
            head: "main",
            invocationId: "invocation:test",
          },
          contextIntegrity: { class: "internal", externalKeys: [] },
        },
        input: {
          contextId: "context:test",
          commandId,
          expectedWorkingHead: initial.working.ref,
          source: {
            kind: "generated",
            uri: `fixture://invalid-${testCase.name.replace(" ", "-")}`,
            snapshotRevision: "fixture:invalid",
          },
          repositories: [{ repoPath: "projects/invalid", files: [source.descriptor] }],
        },
      });
      if (observation.kind !== "effects-pending") {
        throw new Error("invalid import did not request observation");
      }
      const effect = observation.effects[0]!;
      expect(effect.kind).toBe("observe-content");
      const requested = effect.payload["files"] as Array<{ contentHash: string }>;
      let failure: unknown;
      try {
        semantic.acknowledgeEffect({
          effectId: effect.effectId,
          payloadDigest: effect.payloadDigest,
          receipt: {
            files: requested.map((file) => ({
              contentHash: file.contentHash,
              ...testCase.receipt,
            })),
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "IntegrityFailure",
        detail: { internalDiagnostic: "EffectMismatch" },
      });
      expect(store.contextRequired("context:test").working.ref).toEqual(initial.working.ref);
      expect(store.facts.entries(store.stateRoot(initial.working.ref), "repository")).toEqual([]);
      expect(store.pendingEffects(commandId)).toEqual([
        expect.objectContaining({ effectId: effect.effectId, kind: "observe-content" }),
      ]);
    }
  });

  it("preserves unchanged provenance and gives changed external bytes a new boundary", async () => {
    const { semantic, store, initial } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
      contextIntegrity: { class: "internal", externalKeys: [] },
    };
    const unchanged = textFile("src/unchanged.ts", "same");
    const beforeChange = textFile("src/changed.ts", "old");
    const afterChange = textFile("src/changed.ts", "new");
    const v1 = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:import-v1",
          expectedWorkingHead: initial.working.ref,
          source: {
            kind: "generated",
            uri: "fixture://repeated-import",
            snapshotRevision: "fixture:v1",
          },
          repositories: [
            {
              repoPath: "projects/repeated",
              files: [beforeChange.descriptor, unchanged.descriptor],
            },
          ],
        },
      },
      new Map([
        [unchanged.descriptor.contentHash, unchanged.bytes],
        [beforeChange.descriptor.contentHash, beforeChange.bytes],
      ])
    );
    const repositoryId = v1.importedRepositoryIds[0]!;
    const v1State = { kind: "event" as const, eventId: v1.eventId };
    const v1Root = store.stateRoot(v1State);
    const unchangedV1 = store.facts.fileAtPath(
      v1Root,
      repositoryId,
      unchanged.descriptor.path
    )?.state;
    const changedV1 = store.facts.fileAtPath(
      v1Root,
      repositoryId,
      beforeChange.descriptor.path
    )?.state;
    if (unchangedV1?.presence !== "placed" || changedV1?.presence !== "placed") {
      throw new Error("initial files are absent");
    }

    const v2 = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:import-v2",
          expectedWorkingHead: v1State,
          source: {
            kind: "generated",
            uri: "fixture://repeated-import",
            snapshotRevision: "fixture:v2",
          },
          repositories: [
            {
              repositoryId,
              repoPath: "projects/repeated",
              files: [afterChange.descriptor, unchanged.descriptor],
            },
          ],
        },
      },
      new Map([
        [unchanged.descriptor.contentHash, unchanged.bytes],
        [afterChange.descriptor.contentHash, afterChange.bytes],
      ])
    );
    const v2State = { kind: "event" as const, eventId: v2.eventId };
    const v2Root = store.stateRoot(v2State);
    const unchangedV2 = store.facts.fileAtPath(
      v2Root,
      repositoryId,
      unchanged.descriptor.path
    )?.state;
    const changedV2 = store.facts.fileAtPath(
      v2Root,
      repositoryId,
      afterChange.descriptor.path
    )?.state;
    if (unchangedV2?.presence !== "placed" || changedV2?.presence !== "placed") {
      throw new Error("replacement files are absent");
    }
    expect(unchangedV2.fileStateId).toBe(unchangedV1.fileStateId);
    expect(changedV2.fileId).toBe(changedV1.fileId);
    expect(changedV2.fileStateId).not.toBe(changedV1.fileStateId);

    const v1Changes = await inspectAuthoredChanges(semantic, ingress, v1.workUnitId);
    const v2Changes = await inspectAuthoredChanges(semantic, ingress, v2.workUnitId);
    expect(v1Changes.map((change) => change.node.value.kind)).toEqual([
      "repository-create",
      "file-create",
      "file-create",
    ]);
    expect(v2Changes.map((change) => change.node.value.kind)).toEqual(["content-replace"]);
    const v1UnchangedCreateId = v1Changes[2]!.node.value.changeId;
    const v2ReplacementId = v2Changes[0]!.node.value.changeId;

    const unchangedBlame = await semantic.dispatch("blame", {
      ingress,
      input: {
        state: v2State,
        repositoryId,
        fileId: unchangedV2.fileId,
        range: { start: 0, end: unchangedV2.coordinateExtent },
        limit: 20,
      },
    });
    expect(unchangedBlame).toMatchObject({
      kind: "complete",
      result: {
        spans: [
          {
            change: { kind: "change", changeId: v1UnchangedCreateId },
            command: { kind: "command", commandId: "command:import-v1" },
            stop: "import-boundary",
            path: [],
          },
        ],
      },
    });
    const changedBlame = await semantic.dispatch("blame", {
      ingress,
      input: {
        state: v2State,
        repositoryId,
        fileId: changedV2.fileId,
        range: { start: 0, end: changedV2.coordinateExtent },
        limit: 20,
      },
    });
    expect(changedBlame).toMatchObject({
      kind: "complete",
      result: {
        spans: [
          {
            change: { kind: "change", changeId: v2ReplacementId },
            command: { kind: "command", commandId: "command:import-v2" },
            stop: "import-boundary",
            path: [],
          },
        ],
      },
    });

    const v3 = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:import-v3-identical",
          expectedWorkingHead: v2State,
          source: {
            kind: "generated",
            uri: "fixture://repeated-import",
            snapshotRevision: "fixture:v3-identical",
          },
          repositories: [
            {
              repositoryId,
              repoPath: "projects/repeated",
              files: [afterChange.descriptor, unchanged.descriptor],
            },
          ],
        },
      },
      new Map([
        [unchanged.descriptor.contentHash, unchanged.bytes],
        [afterChange.descriptor.contentHash, afterChange.bytes],
      ])
    );
    const v3State = { kind: "event" as const, eventId: v3.eventId };
    expect(store.stateRoot(v3State)).toBe(v2Root);
    expect(
      (await inspectAuthoredChanges(semantic, ingress, v3.workUnitId)).map(
        (change) => change.node.value.kind
      )
    ).toEqual([]);
    const v3Work = await semantic.dispatch("inspect", {
      ingress,
      input: { node: { kind: "work-unit", workUnitId: v3.workUnitId }, edgeLimit: 20 },
    });
    expect(v3Work).toMatchObject({
      kind: "complete",
      result: {
        node: {
          value: {
            authoredChangeCount: 0,
            externalSnapshot: {
              snapshotRevision: "fixture:v3-identical",
              targetRepositoryIds: [repositoryId],
            },
          },
        },
        edges: expect.arrayContaining([
          {
            kind: "imports-repository",
            from: { kind: "work-unit", workUnitId: v3.workUnitId },
            to: {
              kind: "repository",
              state: expect.objectContaining({ kind: "application" }),
              repositoryId,
            },
          },
        ]),
      },
    });
    const changedAfterIdentical = await semantic.dispatch("blame", {
      ingress,
      input: {
        state: v3State,
        repositoryId,
        fileId: changedV2.fileId,
        range: { start: 0, end: changedV2.coordinateExtent },
        limit: 20,
      },
    });
    expect(changedAfterIdentical).toMatchObject({
      kind: "complete",
      result: {
        spans: [
          {
            change: { kind: "change", changeId: v2ReplacementId },
            command: { kind: "command", commandId: "command:import-v2" },
            stop: "import-boundary",
            path: [],
          },
        ],
      },
    });
  });

  it("represents a mode-only reimport as an explicit preserving step", async () => {
    const { semantic, store, initial } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
      contextIntegrity: { class: "internal", externalKeys: [] },
    };
    const before = textFile("src/script.ts", "echo", 0o644);
    const after = textFile("src/script.ts", "echo", 0o755);
    const bytes = new Map([[before.descriptor.contentHash, before.bytes]]);
    const v1 = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:mode-v1",
          expectedWorkingHead: initial.working.ref,
          source: {
            kind: "generated",
            uri: "fixture://mode-import",
            snapshotRevision: "fixture:mode-v1",
          },
          repositories: [{ repoPath: "projects/mode", files: [before.descriptor] }],
        },
      },
      bytes
    );
    const repositoryId = v1.importedRepositoryIds[0]!;
    const v1State = { kind: "event" as const, eventId: v1.eventId };
    const v1File = store.facts.fileAtPath(
      store.stateRoot(v1State),
      repositoryId,
      before.descriptor.path
    )?.state;
    if (v1File?.presence !== "placed") throw new Error("initial mode file is absent");
    const v2 = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:mode-v2",
          expectedWorkingHead: v1State,
          source: {
            kind: "generated",
            uri: "fixture://mode-import",
            snapshotRevision: "fixture:mode-v2",
          },
          repositories: [
            {
              repositoryId,
              repoPath: "projects/mode",
              files: [after.descriptor],
            },
          ],
        },
      },
      bytes
    );
    const v2State = { kind: "event" as const, eventId: v2.eventId };
    const v2File = store.facts.fileAtPath(
      store.stateRoot(v2State),
      repositoryId,
      after.descriptor.path
    )?.state;
    if (v2File?.presence !== "placed") throw new Error("updated mode file is absent");
    expect(v2File).toMatchObject({
      fileId: v1File.fileId,
      contentHash: v1File.contentHash,
      coordinateExtent: v1File.coordinateExtent,
      mode: 0o755,
    });
    expect(v2File.fileStateId).not.toBe(v1File.fileStateId);

    const v1Changes = await inspectAuthoredChanges(semantic, ingress, v1.workUnitId);
    const v2Changes = await inspectAuthoredChanges(semantic, ingress, v2.workUnitId);
    expect(v1Changes.map((change) => change.node.value.kind)).toEqual([
      "repository-create",
      "file-create",
    ]);
    expect(v2Changes.map((change) => change.node.value.kind)).toEqual(["file-mode"]);
    const v1CreateId = v1Changes[1]!.node.value.changeId;
    const modeChange = v2Changes[0]!;
    expect(modeChange.node.value.effects).toEqual([
      {
        kind: "mode",
        fileId: v1File.fileId,
        beforeMode: 0o644,
        afterMode: 0o755,
      },
    ]);
    const blame = await semantic.dispatch("blame", {
      ingress,
      input: {
        state: v2State,
        repositoryId,
        fileId: v2File.fileId,
        range: { start: 0, end: v2File.coordinateExtent },
        limit: 20,
      },
    });
    expect(blame).toMatchObject({
      kind: "complete",
      result: {
        spans: [
          {
            change: { kind: "change", changeId: v1CreateId },
            command: { kind: "command", commandId: "command:mode-v1" },
            stop: "import-boundary",
            path: [
              {
                kind: "preserves-content",
                from: {
                  kind: "applied-change",
                  appliedChangeId: expect.stringMatching(/^applied-change:/),
                },
                to: {
                  kind: "applied-change",
                  appliedChangeId: expect.stringMatching(/^applied-change:/),
                },
              },
            ],
          },
        ],
      },
    });
  });

  it("imports an empty repository as an exact snapshot", async () => {
    const { semantic, store, initial } = await authorityFixture();
    const request = {
      ingress: {
        causalParent: {
          kind: "trajectory-invocation",
          logId: "trajectory:test",
          head: "main",
          invocationId: "invocation:test",
        },
        contextIntegrity: { class: "internal", externalKeys: [] },
      },
      input: {
        contextId: "context:test",
        commandId: "command:import-empty",
        expectedWorkingHead: initial.working.ref,
        source: {
          kind: "filesystem",
          uri: "fixture://workspace",
          snapshotRevision: "fixture:empty",
        },
        repositories: [
          {
            repoPath: "projects/empty",
            files: [],
          },
        ],
      },
    } satisfies SemanticDispatchRequest;

    const observation = await semantic.dispatch("importSnapshot", request);
    const result = acknowledgeImportObservation(semantic, observation, new Map());

    expect(result.kind).toBe("effects-pending");
    if (result.kind !== "effects-pending") throw new Error("snapshot import did not complete");
    const imported = result.result as { eventId: string; importedRepositoryIds: string[] };
    const repositoryId = imported.importedRepositoryIds[0]!;
    const root = store.stateRoot({ kind: "event", eventId: imported.eventId });
    const repository = store.facts.member(root, repositoryId);
    expect(repository).toMatchObject({
      repositoryId,
      presence: "present",
      repoPath: "projects/empty",
    });
    if (repository?.presence !== "present") throw new Error("empty repository is absent");
    expect(store.facts.manifest(repository.fileManifestId)).toMatchObject({
      repositoryId,
      entryCount: 0,
    });
    expect(store.facts.pageManifest(repository.fileManifestId, { limit: 1 }).values).toEqual([]);
  });

  it("admits a workspace with more than the former repository-count bound", async () => {
    const { semantic, initial } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
      contextIntegrity: { class: "internal", externalKeys: [] },
    };
    const repositoryCount = 104;
    const imported = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:many-repositories",
          expectedWorkingHead: initial.working.ref,
          source: {
            kind: "filesystem",
            uri: "fixture://many-repositories",
            snapshotRevision: "fixture:many-v1",
          },
          repositories: Array.from({ length: repositoryCount }, (_, index) => ({
            repoPath: `projects/many-${String(index).padStart(3, "0")}`,
            files: [],
          })),
        },
      },
      new Map()
    );

    expect(imported.importedRepositoryIds).toHaveLength(repositoryCount);
    const edited = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:edit-one-of-many",
        expectedWorkingHead: { kind: "event", eventId: imported.eventId },
        changes: [
          {
            kind: "file-create",
            repositoryId: imported.importedRepositoryIds[57]!,
            path: "only-this-repository.txt",
            content: { kind: "text", text: "local\n" },
          },
        ],
      },
    });
    if (edited.kind !== "effects-pending") throw new Error("edit did not materialize");
    expect(edited.effects[0]?.payload).toMatchObject({
      mode: "patch",
      repositories: [
        {
          repositoryId: imported.importedRepositoryIds[57],
          presence: "present",
          source: { kind: "delta" },
        },
      ],
    });
  });

  it("admits paths through the shared predicate before queuing observation", async () => {
    const { semantic, store, initial } = await authorityFixture();
    const file = textFile("dist/index.js", "built\n");
    const requestFor = (commandId: string, filePath: string): SemanticDispatchRequest => ({
      ingress: { causalParent: null, contextIntegrity: { class: "internal", externalKeys: [] } },
      input: {
        contextId: "context:test",
        commandId,
        expectedWorkingHead: initial.working.ref,
        source: {
          kind: "generated",
          uri: "fixture://path-admission",
          snapshotRevision: "fixture:path-admission-v1",
        },
        repositories: [
          {
            repoPath: "projects/path-admission",
            files: [{ ...file.descriptor, path: filePath }],
          },
        ],
      },
    });

    await expect(
      semantic.dispatch("importSnapshot", requestFor("command:reserved-path", ".git/config"))
    ).rejects.toThrow(/admissible canonical repository-relative file path/u);
    expect(store.pendingEffects()).toEqual([]);

    const admitted = await semantic.dispatch(
      "importSnapshot",
      requestFor("command:ordinary-output", "dist/index.js")
    );
    expect(admitted).toMatchObject({
      kind: "effects-pending",
      effects: [{ kind: "observe-content" }],
    });
  });

  it("does not hide repository moves or resurrection inside an import operation", async () => {
    const { semantic, initial } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
      contextIntegrity: { class: "internal", externalKeys: [] },
    };
    const observationDispatch = await semantic.dispatch("importSnapshot", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:import-stable-repository",
        expectedWorkingHead: initial.working.ref,
        source: {
          kind: "generated",
          uri: "fixture://stable-repository",
          snapshotRevision: "fixture:stable-v1",
        },
        repositories: [{ repoPath: "projects/stable", files: [] }],
      },
    });
    const importedDispatch = acknowledgeImportObservation(semantic, observationDispatch, new Map());
    if (importedDispatch.kind !== "effects-pending") throw new Error("import did not complete");
    const imported = importedDispatch.result as {
      eventId: string;
      importedRepositoryIds: string[];
    };
    const repositoryId = imported.importedRepositoryIds[0]!;
    const state = { kind: "event" as const, eventId: imported.eventId };
    acknowledgeMaterialization(semantic, importedDispatch);

    await expect(
      semantic.dispatch("importSnapshot", {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:import-hidden-move",
          expectedWorkingHead: state,
          source: {
            kind: "generated",
            uri: "fixture://stable-repository",
            snapshotRevision: "fixture:stable-v2",
          },
          repositories: [{ repositoryId, repoPath: "projects/moved", files: [] }],
        },
      })
    ).rejects.toMatchObject({ code: "InvalidReference" });

    await expect(
      semantic.dispatch("importSnapshot", {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:import-unknown-repository",
          expectedWorkingHead: state,
          source: {
            kind: "generated",
            uri: "fixture://stable-repository",
            snapshotRevision: "fixture:stable-v2",
          },
          repositories: [
            { repositoryId: "repository:unknown", repoPath: "projects/unknown", files: [] },
          ],
        },
      })
    ).rejects.toMatchObject({ code: "InvalidReference" });
  });

  it("integrates an imported snapshot as ordinary local incremental changes", async () => {
    const { semantic, store, initial } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
      contextIntegrity: { class: "internal", externalKeys: [] },
    };
    const sourceFile = textFile("src/index.ts", "hello");
    const source = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:integration-source-import",
          expectedWorkingHead: initial.working.ref,
          source: {
            kind: "git",
            url: "https://example.test/incremental.git",
            commit: "b".repeat(40),
            snapshot: canonicalSnapshotDigest([
              {
                path: sourceFile.descriptor.path,
                mode: 0o100644,
                size: sourceFile.bytes.byteLength,
                contentHash: sourceFile.descriptor.contentHash,
              },
            ]),
          },
          repositories: [{ repoPath: "projects/incremental", files: [sourceFile.descriptor] }],
        },
      },
      new Map([[sourceFile.descriptor.contentHash, sourceFile.bytes]])
    );
    const target = store.initializeWorkspace(
      "context:integration-target",
      "command:integration-target-genesis"
    );
    const compared = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: target.working.ref,
        source: { kind: "event", eventId: source.eventId },
        limit: 20,
      },
    });
    if (compared.kind !== "complete") throw new Error("comparison did not complete");
    const preview = compared.result as {
      coordinates: Array<{ coordinate: { kind: string; id: string }; group?: string }>;
      resolution: { remainingCoordinateCount: number; concluded: boolean };
    };
    expect(preview.coordinates.map((row) => row.coordinate.kind).sort()).toEqual([
      "file",
      "repository",
    ]);
    expect(preview.resolution).toMatchObject({ remainingCoordinateCount: 2, concluded: false });

    const merged = await semantic.dispatch("merge", {
      ingress,
      input: {
        contextId: "context:integration-target",
        commandId: "command:merge-imported-project",
        expectedWorkingHead: target.working.ref,
        source: { kind: "event", eventId: source.eventId },
        intentSummary: "Merge the imported repository and its file as one reviewed state",
      },
    });
    if (merged.kind !== "effects-pending") throw new Error("merge did not materialize");
    acknowledgeMaterialization(semantic, merged);
    const fileHead = (
      merged.result as {
        workingHead: { kind: "application"; applicationId: string };
        resolution: { complete: boolean; concluded: boolean };
        outcomes: unknown[];
      }
    ).workingHead;
    expect(merged.result).toMatchObject({
      resolution: { complete: true, remainingCoordinateCount: 0, concluded: true },
    });

    const committed = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:integration-target",
        commandId: "command:commit-incremental-import",
        expectedWorkingHead: fileHead,
        message: "Integrate imported project incrementally",
      },
    });
    if (committed.kind !== "effects-pending")
      throw new Error("integration commit did not complete");
    acknowledgeMaterialization(semantic, committed);
    const committedEventId = (committed.result as { event: { eventId: string } }).event.eventId;
    expect(store.event(committedEventId)?.parentEventIds).toEqual([
      target.committed.ref.eventId,
      source.eventId,
    ]);
  });

  it("projects a shipped-workspace-sized import atomically and one later mutation by changed paths", async () => {
    const { semantic, sql, store, initial } = await authorityFixture();
    const repeatedContent = textFile("unused", "a");
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
      contextIntegrity: { class: "internal", externalKeys: [] },
    };
    const files = Array.from({ length: 1_658 }, (_, index) => ({
      path: `src/file-${String(index).padStart(4, "0")}.ts`,
      contentHash: repeatedContent.descriptor.contentHash,
      mode: 0o644,
    }));
    const observationDispatch = await semantic.dispatch("importSnapshot", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:large-import",
        expectedWorkingHead: initial.working.ref,
        source: {
          kind: "filesystem",
          uri: "fixture://large-workspace",
          snapshotRevision: "fixture:large-v1",
        },
        repositories: [
          {
            repoPath: "packages/large",
            files,
          },
        ],
      },
    });
    if (observationDispatch.kind !== "effects-pending") {
      throw new Error("large import did not request observation");
    }
    expect(observationDispatch.effects[0]?.kind).toBe("observe-content");
    expect(observationDispatch.effects[0]?.payload["files"]).toHaveLength(1);
    const importedDispatch = acknowledgeImportObservation(
      semantic,
      observationDispatch,
      new Map([[repeatedContent.descriptor.contentHash, repeatedContent.bytes]])
    );
    if (importedDispatch.kind !== "effects-pending") {
      throw new Error("large import did not queue materialization");
    }
    expect(
      sql
        .exec(
          `SELECT payload_json, receipt_json, receipt_digest, status
             FROM gad_effect_intents WHERE effect_id = ?`,
          observationDispatch.effects[0]!.effectId
        )
        .toArray()[0]
    ).toMatchObject({
      payload_json: "{}",
      receipt_json: null,
      receipt_digest: expect.any(String),
      status: "applied",
    });
    const imported = importedDispatch.result as {
      eventId: string;
      workUnitId: string;
      importedRepositoryIds: string[];
    };
    const repositoryId = imported.importedRepositoryIds[0]!;
    const inspectedWork = await semantic.dispatch("inspect", {
      ingress,
      input: {
        node: { kind: "work-unit", workUnitId: imported.workUnitId },
        edgeLimit: 20,
      },
    });
    expect(inspectedWork).toMatchObject({
      kind: "complete",
      result: {
        node: {
          kind: "work-unit",
          value: {
            authoredChangeCount: 1_659,
            authoredChangeIds: expect.any(Array),
          },
        },
      },
    });
    if (inspectedWork.kind !== "complete") throw new Error("work inspection did not complete");
    expect(
      (inspectedWork.result as { node: { value: { authoredChangeIds: string[] } } }).node.value
        .authoredChangeIds
    ).toHaveLength(200);
    const authoredNeighbors = await semantic.dispatch("neighbors", {
      ingress,
      input: {
        root: { kind: "work-unit", workUnitId: imported.workUnitId },
        limit: 20,
      },
    });
    expect(authoredNeighbors).toMatchObject({
      kind: "complete",
      result: {
        edges: expect.arrayContaining([expect.objectContaining({ kind: "authored-change" })]),
        nextCursor: expect.any(String),
      },
    });
    const importEffect = importedDispatch.effects[0]!;
    const importCommand = importEffect.payload as {
      effectId: string;
      contextId: string;
      targetState: { kind: "event"; eventId: string };
      payloadDigest: string;
      repositories: Array<{ repoPath: string; source: { kind: string } }>;
    };
    expect(importCommand.repositories[0]?.source.kind).toBe("snapshot");
    const contentRoot = `state:${"b".repeat(64)}`;
    semantic.acknowledgeEffect({
      effectId: importEffect.effectId,
      payloadDigest: importEffect.payloadDigest,
      receipt: {
        materializationId: importEffect.effectId,
        contextId: importCommand.contextId,
        targetState: importCommand.targetState,
        repositories: [{ repositoryId, repoPath: "packages/large", contentRoot }],
        payloadDigest: importCommand.payloadDigest,
      },
    });

    const pushDispatch = await semantic.dispatch("push", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:large-push",
        expectedCommittedEventId: imported.eventId,
        expectedMainEventId: initial.committed.ref.eventId,
      },
    });
    if (pushDispatch.kind !== "effects-pending") throw new Error("push did not queue an effect");
    expect(
      (
        pushDispatch.effects[0]!.payload["repositories"] as Array<{
          source: { kind: string };
        }>
      )[0]?.source.kind
    ).toBe("content-root");
    expect(() =>
      semantic.acknowledgeEffect({
        effectId: pushDispatch.effects[0]!.effectId,
        payloadDigest: pushDispatch.effects[0]!.payloadDigest,
        receipt: {
          applied: true,
          appliedAt: timestamp,
          approvalId: null,
          buildReceiptId: null,
        },
      })
    ).toThrowError(
      expect.objectContaining({
        code: "IntegrityFailure",
        detail: expect.objectContaining({ internalDiagnostic: "EffectMismatch" }),
      })
    );
    semantic.acknowledgeEffect({
      effectId: pushDispatch.effects[0]!.effectId,
      payloadDigest: pushDispatch.effects[0]!.payloadDigest,
      receipt: {
        applied: true,
        appliedAt: timestamp,
      },
    });

    const ensured = semantic.ensureContext(
      { contextId: "context:fresh", commandId: "command:ensure-fresh" },
      ingress
    );
    if (ensured.kind !== "effects-pending") throw new Error("ensure did not queue an effect");
    const ensureEffect = ensured.effects[0]!;
    const ensurePayload = ensureEffect.payload as {
      contextId: string;
      targetState: { kind: "event"; eventId: string };
      payloadDigest: string;
      repositories: Array<{ source: { kind: string; contentRoot?: string } }>;
    };
    expect(ensurePayload.repositories[0]?.source).toEqual({
      kind: "content-root",
      contentRoot,
    });
    expect(JSON.stringify(ensurePayload).length).toBeLessThan(2_000);
    semantic.acknowledgeEffect({
      effectId: ensureEffect.effectId,
      payloadDigest: ensureEffect.payloadDigest,
      receipt: {
        materializationId: ensureEffect.effectId,
        contextId: ensurePayload.contextId,
        targetState: ensurePayload.targetState,
        repositories: [{ repositoryId, repoPath: "packages/large", contentRoot }],
        payloadDigest: ensurePayload.payloadDigest,
      },
    });
    const replayedEnsure = semantic.ensureContext(
      { contextId: "context:fresh", commandId: "command:ensure-fresh" },
      ingress
    );
    expect(replayedEnsure).toMatchObject({ kind: "complete" });
    expect(
      semantic.contextMaterializationCommand("context:fresh", ensurePayload.targetState)
    ).toMatchObject({
      mode: "replace",
      previousState: ensurePayload.targetState,
      targetState: ensurePayload.targetState,
      repositories: ensurePayload.repositories,
    });

    const importedRoot = store.stateRoot({ kind: "event", eventId: imported.eventId });
    const repository = store.facts.member(importedRoot, repositoryId);
    if (repository?.presence !== "present") throw new Error("large repository is absent");
    const firstFileId = store.facts.pageManifest(repository.fileManifestId, { limit: 1 }).values[0]!
      .fileId;
    const moved = await semantic.dispatch("move", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:move-one",
        expectedWorkingHead: { kind: "event", eventId: imported.eventId },
        moves: [
          {
            kind: "file",
            repositoryId,
            fileId: firstFileId,
            destinationRepositoryId: repositoryId,
            destinationPath: "src/moved.ts",
          },
        ],
      },
    });
    if (moved.kind !== "effects-pending") throw new Error("move did not queue an effect");
    const movedPayload = moved.effects[0]!.payload as {
      repositories: Array<{
        source: { kind: string; changes?: unknown[] };
      }>;
    };
    expect(movedPayload.repositories[0]?.source.kind).toBe("delta");
    expect(movedPayload.repositories[0]?.source.changes).toHaveLength(2);
    expect(JSON.stringify(movedPayload).length).toBeLessThan(4_000);
    acknowledgeMaterialization(semantic, moved, `state:${"c".repeat(64)}`);

    const movedHead = (
      moved.result as { workingHead: { kind: "application"; applicationId: string } }
    ).workingHead;
    const expanded = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:add-over-import-bound",
        expectedWorkingHead: movedHead,
        changes: [
          {
            kind: "file-create",
            repositoryId,
            path: "src/extra.ts",
            content: { kind: "text", text: "extra\n" },
          },
        ],
      },
    });
    if (expanded.kind !== "effects-pending") throw new Error("edit did not queue an effect");
    acknowledgeMaterialization(semantic, expanded);
    const expandedHead = (
      expanded.result as { workingHead: { kind: "application"; applicationId: string } }
    ).workingHead;
    const committed = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:commit-over-import-bound",
        expectedWorkingHead: expandedHead,
      },
    });
    if (committed.kind !== "effects-pending") throw new Error("commit did not queue an effect");
    acknowledgeMaterialization(semantic, committed);
    const expandedEvent = (committed.result as { event: { eventId: string } }).event.eventId;

    const replaced = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:replace-large-workspace",
          expectedWorkingHead: { kind: "event", eventId: expandedEvent },
          source: {
            kind: "filesystem",
            uri: "fixture://large-workspace",
            snapshotRevision: "fixture:large-v2",
          },
          repositories: [
            {
              repositoryId,
              repoPath: "packages/large",
              files: [],
            },
          ],
        },
      },
      new Map()
    );
    expect(replaced.eventId).not.toBe(expandedEvent);
    expect(store.pendingEffects()).toEqual([]);
  }, 60_000);

  it("walks imports larger than SQLite's compound-select ceiling through bounded pages", async () => {
    const { semantic, initial } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
      contextIntegrity: { class: "internal", externalKeys: [] },
    };
    const repositoryCount = 520;
    const imported = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:wide-import",
          expectedWorkingHead: initial.working.ref,
          intentSummary: "Import a workspace whose provenance must remain walkable",
          source: {
            kind: "generated",
            uri: "fixture://wide-workspace",
            snapshotRevision: "fixture:wide-v1",
          },
          repositories: Array.from({ length: repositoryCount }, (_, index) => ({
            repoPath: `projects/wide-${index.toString().padStart(4, "0")}`,
            files: [],
          })),
        },
      },
      new Map()
    );

    const work = { kind: "work-unit" as const, workUnitId: imported.workUnitId };
    const inspected = await semantic.dispatch("inspect", {
      ingress,
      input: { node: work, edgeLimit: 500 },
    });
    if (inspected.kind !== "complete") throw new Error("work inspection did not complete");
    const inspection = vcsInspectResultSchema.parse(inspected.result);
    expect(inspection).toMatchObject({
      node: {
        kind: "work-unit",
        value: {
          authoredChangeCount: repositoryCount,
        },
      },
      hasMoreEdges: true,
    });
    expect(inspection.edges).toHaveLength(500);
    if (inspection.node.kind !== "work-unit" || !inspection.node.value.externalSnapshot) {
      throw new Error("wide import inspection lost its external snapshot");
    }
    expect(inspection.node.value.externalSnapshot.targetRepositoryIds).toHaveLength(
      repositoryCount
    );

    const collectEdges = async (root: VcsSemanticNodeRef): Promise<VcsProvenanceEdge[]> => {
      const edges: VcsProvenanceEdge[] = [];
      let cursor: string | undefined;
      do {
        const dispatch = await semantic.dispatch("neighbors", {
          ingress,
          input: { root, limit: 137, ...(cursor ? { cursor } : {}) },
        });
        if (dispatch.kind !== "complete") throw new Error("neighbor walk did not complete");
        const page = vcsNeighborsResultSchema.parse(dispatch.result);
        edges.push(...page.edges);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return edges;
    };

    const workEdges = await collectEdges(work);
    expect(workEdges.filter((edge) => edge.kind === "authored-change")).toHaveLength(
      repositoryCount
    );
    expect(workEdges.filter((edge) => edge.kind === "imports-repository")).toHaveLength(
      repositoryCount
    );
    expect(workEdges).toHaveLength(repositoryCount * 2 + 2);

    const applicationEdge = workEdges.find((edge) => edge.kind === "applies-work");
    if (!applicationEdge || applicationEdge.from.kind !== "application") {
      throw new Error("wide import has no application edge");
    }
    const stateEdges = await collectEdges(applicationEdge.from);
    const repositoryIds = stateEdges.flatMap((edge) =>
      edge.kind === "contains-repository" && edge.to.kind === "repository"
        ? [edge.to.repositoryId]
        : []
    );
    expect(repositoryIds).toHaveLength(repositoryCount);
    expect(new Set(repositoryIds).size).toBe(repositoryCount);
  }, 30_000);

  it("inspects and exactly pages every change adjacency phase within the deployment SQL limit", async () => {
    const { initial, restart, sql } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
      contextIntegrity: { class: "internal", externalKeys: [] },
    };
    const source = textFile("src/source.ts", "export const source = true;\n");
    const imported = await completeImport(
      restart(),
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:change-adjacency-import",
          expectedWorkingHead: initial.working.ref,
          source: {
            kind: "generated",
            uri: "fixture://change-adjacency",
            snapshotRevision: "fixture:v1",
          },
          repositories: [
            {
              repoPath: "packages/source",
              files: [source.descriptor],
            },
          ],
        },
      },
      new Map([[source.descriptor.contentHash, source.bytes]])
    );
    const change = sql
      .exec(
        `SELECT * FROM gad_changes
          WHERE work_unit_id = ? AND kind = 'file-create'`,
        imported.workUnitId
      )
      .toArray()[0] as Record<string, unknown> | undefined;
    if (!change) throw new Error("fixture import did not author a file change");
    const changeId = String(change["change_id"]);

    const relatedChangeIds = [
      "change:counteracted-a",
      "change:counteracted-b",
      "change:counteracting-a",
      "change:counteracting-b",
    ];
    relatedChangeIds.forEach((relatedChangeId, index) => {
      sql.exec(
        `INSERT INTO gad_changes
         (change_id, work_unit_id, operation, ordinal, kind, base_json, result_json,
          payload_json, effect_digest)
         SELECT ?, work_unit_id, ?, 0, kind, base_json, result_json,
                payload_json, effect_digest
           FROM gad_changes WHERE change_id = ?`,
        relatedChangeId,
        100 + index,
        changeId
      );
    });
    sql.exec(
      `INSERT INTO gad_change_counteractions
       (change_id, ordinal, counteracted_change_id)
       VALUES (?, 0, ?), (?, 1, ?), (?, 0, ?), (?, 0, ?)`,
      changeId,
      relatedChangeIds[0],
      changeId,
      relatedChangeIds[1],
      relatedChangeIds[2],
      changeId,
      relatedChangeIds[3],
      changeId
    );
    sql.exec(
      `INSERT INTO gad_integration_decisions
       (decision_id, target_state_kind, target_state_id, source_event_id,
        work_unit_id, created_at, source_delta_id)
       VALUES ('decision:change-adjacency', 'event', ?, ?, ?, ?, NULL)`,
      imported.eventId,
      imported.eventId,
      imported.workUnitId,
      timestamp
    );
    sql.exec(
      `INSERT INTO gad_merge_decision_entries
       (decision_id, coordinate_kind, coordinate_id, resolution, result_change_id, rationale)
       VALUES ('decision:change-adjacency', 'file', 'file:adjacency', 'adopt', ?, NULL)`,
      changeId
    );
    sql.exec(
      `INSERT INTO gad_decision_source_changes
       (decision_id, coordinate_kind, coordinate_id, change_id)
       VALUES ('decision:change-adjacency', 'file', 'file:adjacency', ?)`,
      changeId
    );
    // Workerd rejects compound SELECTs with more than five terms. Keep this
    // boundary in the regression so a future adjacency UNION cannot pass only
    // because the host SQLite build has a higher compile-time limit.
    const deploymentSql = new Proxy(sql, {
      get(target, property, receiver) {
        if (property !== "exec") return Reflect.get(target, property, receiver);
        return (statement: string, ...bindings: unknown[]) => {
          const terms = 1 + (statement.match(/\bUNION(?:\s+ALL)?\b/giu)?.length ?? 0);
          if (terms > 5) throw new Error("too many terms in compound SELECT");
          return target.exec(statement, ...bindings);
        };
      },
    });
    const semantic = restart(deploymentSql);
    const node = { kind: "change" as const, changeId };
    const inspected = await semantic.dispatch("inspect", {
      ingress,
      input: { node, edgeLimit: 20 },
    });
    if (inspected.kind !== "complete") throw new Error("change inspection did not complete");
    expect(vcsInspectResultSchema.parse(inspected.result)).toMatchObject({
      root: node,
      hasMoreEdges: false,
      edges: expect.any(Array),
    });

    const collect = async (limit: number): Promise<VcsProvenanceEdge[]> => {
      const edges: VcsProvenanceEdge[] = [];
      let cursor: string | undefined;
      do {
        const dispatched = await semantic.dispatch("neighbors", {
          ingress,
          input: { root: node, limit, ...(cursor ? { cursor } : {}) },
        });
        if (dispatched.kind !== "complete") throw new Error("change walk did not complete");
        const page = vcsNeighborsResultSchema.parse(dispatched.result);
        edges.push(...page.edges);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return edges;
    };
    const completePage = await collect(20);
    const singleEdgePages = await collect(1);
    expect(singleEdgePages).toEqual(completePage);
    expect(singleEdgePages.map((edge) => edge.kind)).toEqual([
      "authored-change",
      "realizes-change",
      "decides-change",
      "incorporates-change",
      "counteracts",
      "counteracts",
      "counteracts",
      "counteracts",
    ]);
    expect(new Set(singleEdgePages.map((edge) => JSON.stringify(edge))).size).toBe(
      singleEdgePages.length
    );
  });
});
