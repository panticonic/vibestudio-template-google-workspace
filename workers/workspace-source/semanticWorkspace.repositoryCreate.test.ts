// Builtin semantic-authority tests.
import { describe, expect, it } from "vitest";
import { createInMemorySql } from "@vibestudio/durable/test-utils";
import {
  createSemanticVcsSchema,
  createTrajectoryMirrorSchema,
} from "./semanticVcsSchema.js";
import { SemanticWorkspace, type SemanticDispatchRequest } from "./semanticWorkspace.js";
import { SemanticVcsStore } from "./semanticVcsStore.js";

const timestamp = "2026-07-16T00:00:00.000Z";
const ingress: SemanticDispatchRequest["ingress"] = {
  causalParent: {
    kind: "trajectory-invocation",
    logId: "trajectory:test",
    head: "main",
    invocationId: "invocation:test",
  },
  contextIntegrity: { class: "internal", externalKeys: [] },
};

describe("SemanticWorkspace repository creation", () => {
  it("authors the repository identity and all initial files in one lifecycle work unit", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    createTrajectoryMirrorSchema(sql);
    sql.exec(
      `INSERT INTO trajectory_invocations
       (log_id, head, invocation_id, status, updated_at)
       VALUES ('trajectory:test', 'main', 'invocation:test', 'active', ?)`,
      timestamp
    );
    const store = new SemanticVcsStore(sql, () => timestamp);
    let transactionOrdinal = 0;
    const semantic = new SemanticWorkspace({
      workspaceId: "workspace:test",
      sql,
      store,
      now: () => timestamp,
      transaction: <T>(fn: () => T): T => {
        const savepoint = `repository_create_${transactionOrdinal++}`;
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
    const initial = store.initializeWorkspace("context:test", "command:genesis");

    const dispatch = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:create-project",
        expectedWorkingHead: initial.working.ref,
        intentSummary: "Scaffold notes",
        changes: [
          {
            kind: "repository-create",
            repoPath: "projects/notes",
            files: [
              {
                path: "README.md",
                content: { kind: "text", text: "# Notes\n" },
                mode: 0o644,
              },
              {
                path: "icon.bin",
                content: { kind: "bytes", base64: "AQID" },
                mode: 0o644,
              },
            ],
          },
        ],
      },
    });
    if (dispatch.kind !== "effects-pending") throw new Error("repository edit has no effect");
    const result = dispatch.result as {
      workUnitId: string;
      workingHead: { kind: "application"; applicationId: string };
    };
    const root = store.stateRoot(result.workingHead);
    const repository = store.facts.repositoryAtPath(root, "projects/notes");
    expect(repository).toMatchObject({ presence: "present", repoPath: "projects/notes" });
    if (!repository || repository.presence !== "present") throw new Error("repository is absent");
    const manifest = store.facts.pageManifest(repository.fileManifestId, { limit: 10 });
    expect(manifest.values.map((file) => file.path)).toEqual(["README.md", "icon.bin"]);
    expect(manifest.values.map((file) => store.facts.file(root, file.fileId)?.state)).toMatchObject(
      [
        { presence: "placed", contentKind: "text", coordinateExtent: 8 },
        { presence: "placed", contentKind: "bytes", byteLength: 3, coordinateExtent: 3 },
      ]
    );
    expect(
      sql
        .exec(
          `SELECT kind FROM gad_changes WHERE work_unit_id = ? ORDER BY operation, ordinal`,
          result.workUnitId
        )
        .toArray()
    ).toEqual([{ kind: "repo-add" }, { kind: "file-create" }, { kind: "file-create" }]);
    expect(
      sql.exec(`SELECT kind FROM gad_work_units WHERE work_unit_id = ?`, result.workUnitId).one()
    ).toEqual({ kind: "lifecycle" });

    await expect(
      semantic.dispatch("edit", {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:create-project-again",
          expectedWorkingHead: result.workingHead,
          changes: [
            {
              kind: "repository-create",
              repoPath: "projects/notes",
              files: [
                {
                  path: "other.txt",
                  content: { kind: "text", text: "other\n" },
                  mode: 0o644,
                },
              ],
            },
          ],
        },
      })
    ).rejects.toMatchObject({
      code: "DestinationOccupied",
      errorData: {
        code: "DestinationOccupied",
        repositoryId: repository.repositoryId,
        path: "projects/notes",
      },
    });
  });
});
