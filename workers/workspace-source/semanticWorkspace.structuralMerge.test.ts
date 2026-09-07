import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@vibestudio/content-addressing";
import { createInMemorySql } from "@vibestudio/durable/test-utils";
import { createSemanticVcsSchema } from "./semanticVcsSchema.js";
import {
  SemanticWorkspace,
  type SemanticDispatchRequest,
  type SemanticDispatchResult,
} from "./semanticWorkspace.js";
import { SemanticVcsStore } from "./semanticVcsStore.js";

const timestamp = "2026-07-15T00:00:00.000Z";
const ingress: SemanticDispatchRequest["ingress"] = {
  causalParent: null,
  contextIntegrity: { class: "internal", externalKeys: [] },
};

describe("SemanticWorkspace structural merge planning", () => {
  it("groups a source-created repository with the file placed inside it", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    const store = new SemanticVcsStore(sql, () => timestamp);
    let transactionOrdinal = 0;
    const semantic = new SemanticWorkspace({
      workspaceId: "workspace:test",
      sql,
      store,
      now: () => timestamp,
      transaction: <T>(fn: () => T): T => {
        const savepoint = `structural_merge_${transactionOrdinal++}`;
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
    const pending = <T>(result: SemanticDispatchResult): T => {
      if (result.kind !== "effects-pending") throw new Error("expected a host effect");
      return result.result as T;
    };
    const acknowledge = (result: SemanticDispatchResult): void => {
      if (result.kind !== "effects-pending") throw new Error("expected materialization");
      const effect = result.effects.find((candidate) => candidate.kind === "materialize-context");
      if (!effect) return;
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
    };

    const initial = store.initializeWorkspace("context:source", "command:genesis");
    store.forkContext("context:source", "context:target");
    const authoredDispatch = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:source",
        commandId: "command:create-package",
        expectedWorkingHead: initial.working.ref,
        intentSummary: "Create the package and its required entry point as one unit",
        changes: [
          {
            kind: "repository-create",
            repoPath: "packages/created",
            files: [
              { path: "index.ts", content: { kind: "text", text: "export {}\n" }, mode: 0o644 },
            ],
          },
        ],
      },
    });
    const authored = pending<{ workingHead: { kind: "application"; applicationId: string } }>(
      authoredDispatch
    );
    acknowledge(authoredDispatch);
    const committedDispatch = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:source",
        commandId: "command:commit-package",
        expectedWorkingHead: authored.workingHead,
        message: "Create package",
      },
    });
    const committed = pending<{ event: { kind: "event"; eventId: string } }>(committedDispatch);
    acknowledge(committedDispatch);

    const fullWorkspaceScan = vi.spyOn(store.facts, "entries");
    const compared = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: initial.working.ref,
        source: { kind: "event", eventId: committed.event.eventId },
        limit: 100,
      },
    });
    if (compared.kind !== "complete") throw new Error("compare did not complete");
    expect(fullWorkspaceScan).not.toHaveBeenCalled();
    const coordinates = (
      compared.result as {
        coordinates: Array<{
          coordinate: { kind: "file" | "repository"; id: string };
          group?: string;
        }>;
      }
    ).coordinates;
    expect(coordinates).toHaveLength(2);
    expect(coordinates[0]?.group).toEqual(expect.any(String));
    expect(coordinates[1]?.group).toBe(coordinates[0]?.group);
    const file = coordinates.find((coordinate) => coordinate.coordinate.kind === "file");
    if (!file) throw new Error("missing file coordinate");

    await expect(
      semantic.dispatch("merge", {
        ingress,
        input: {
          contextId: "context:target",
          commandId: "command:split-group",
          expectedWorkingHead: initial.working.ref,
          source: { kind: "event", eventId: committed.event.eventId },
          coordinates: [{ kind: file.coordinate.kind, id: file.coordinate.id }],
        },
      })
    ).rejects.toMatchObject({
      code: "CoupledGroupIncomplete",
      errorData: {
        group: coordinates[0]?.group,
        coordinates: expect.arrayContaining(
          coordinates.map(({ coordinate }) => ({ kind: coordinate.kind, id: coordinate.id }))
        ),
      },
    });

    const mergedDispatch = await semantic.dispatch("merge", {
      ingress,
      input: {
        contextId: "context:target",
        commandId: "command:merge-group",
        expectedWorkingHead: initial.working.ref,
        source: { kind: "event", eventId: committed.event.eventId },
        resolutions: [
          {
            coordinate: { kind: file.coordinate.kind, id: file.coordinate.id },
            resolution: "theirs",
          },
        ],
      },
    });
    const merged = pending<{
      workingHead: { kind: "application"; applicationId: string };
      outcomes: unknown[];
      resolution: { complete: boolean; concluded: boolean };
    }>(mergedDispatch);
    acknowledge(mergedDispatch);
    expect(merged.outcomes).toHaveLength(2);
    expect(merged.resolution).toMatchObject({ complete: true, concluded: true });
  });

  it("treats a file swap as one vacancy-dependent operation", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    const store = new SemanticVcsStore(sql, () => timestamp);
    let transactionOrdinal = 0;
    const semantic = new SemanticWorkspace({
      workspaceId: "workspace:swap",
      sql,
      store,
      now: () => timestamp,
      transaction: <T>(fn: () => T): T => {
        const savepoint = `swap_merge_${transactionOrdinal++}`;
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
    const pending = <T>(result: SemanticDispatchResult): T => {
      if (result.kind !== "effects-pending") throw new Error("expected a host effect");
      return result.result as T;
    };
    const acknowledge = (result: SemanticDispatchResult): void => {
      if (result.kind !== "effects-pending") throw new Error("expected materialization");
      const effect = result.effects.find((candidate) => candidate.kind === "materialize-context");
      if (!effect) return;
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
    };

    const initial = store.initializeWorkspace("context:swap-source", "command:swap-genesis");
    const createDispatch = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:swap-source",
        commandId: "command:swap-base",
        expectedWorkingHead: initial.working.ref,
        changes: [
          {
            kind: "repository-create",
            repoPath: "packages/swap",
            files: [
              { path: "a.ts", content: { kind: "text", text: "a\n" }, mode: 0o644 },
              { path: "b.ts", content: { kind: "text", text: "b\n" }, mode: 0o644 },
            ],
          },
        ],
      },
    });
    const created = pending<{ workingHead: { kind: "application"; applicationId: string } }>(
      createDispatch
    );
    acknowledge(createDispatch);
    const baseCommitDispatch = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:swap-source",
        commandId: "command:swap-base-commit",
        expectedWorkingHead: created.workingHead,
        message: "Create swap fixture",
      },
    });
    const base = pending<{ event: { kind: "event"; eventId: string } }>(baseCommitDispatch);
    acknowledge(baseCommitDispatch);
    store.forkContext("context:swap-source", "context:swap-target");
    store.forkContext("context:swap-source", "context:collision-source");
    store.forkContext("context:swap-source", "context:collision-target");
    const baseRoot = store.stateRoot(base.event);
    const repository = store.facts.repositoryAtPath(baseRoot, "packages/swap");
    if (!repository || repository.presence !== "present") throw new Error("missing repository");
    const a = store.facts.fileAtPath(baseRoot, repository.repositoryId, "a.ts");
    const b = store.facts.fileAtPath(baseRoot, repository.repositoryId, "b.ts");
    if (!a || a.state.presence !== "placed" || !b || b.state.presence !== "placed") {
      throw new Error("missing swap files");
    }

    const moveDispatch = await semantic.dispatch("move", {
      ingress,
      input: {
        contextId: "context:swap-source",
        commandId: "command:swap-files",
        expectedWorkingHead: base.event,
        moves: [
          {
            kind: "file",
            repositoryId: repository.repositoryId,
            fileId: a.state.fileId,
            destinationRepositoryId: repository.repositoryId,
            destinationPath: "b.ts",
          },
          {
            kind: "file",
            repositoryId: repository.repositoryId,
            fileId: b.state.fileId,
            destinationRepositoryId: repository.repositoryId,
            destinationPath: "a.ts",
          },
        ],
      },
    });
    const moved = pending<{ workingHead: { kind: "application"; applicationId: string } }>(
      moveDispatch
    );
    acknowledge(moveDispatch);
    const sourceCommitDispatch = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:swap-source",
        commandId: "command:swap-source-commit",
        expectedWorkingHead: moved.workingHead,
        message: "Swap files",
      },
    });
    const source = pending<{ event: { kind: "event"; eventId: string } }>(sourceCommitDispatch);
    acknowledge(sourceCommitDispatch);

    const compared = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: base.event,
        source: { kind: "event", eventId: source.event.eventId },
        limit: 100,
      },
    });
    if (compared.kind !== "complete") throw new Error("compare did not complete");
    const coordinates = (
      compared.result as {
        coordinates: Array<{
          coordinate: { kind: "file" | "repository"; id: string };
          group?: string;
        }>;
      }
    ).coordinates;
    expect(coordinates).toHaveLength(2);
    expect(coordinates[0]?.group).toEqual(expect.any(String));
    expect(coordinates[1]?.group).toBe(coordinates[0]?.group);

    await expect(
      semantic.dispatch("merge", {
        ingress,
        input: {
          contextId: "context:swap-target",
          commandId: "command:partial-swap",
          expectedWorkingHead: base.event,
          source: { kind: "event", eventId: source.event.eventId },
          coordinates: [
            {
              kind: coordinates[0]!.coordinate.kind,
              id: coordinates[0]!.coordinate.id,
            },
          ],
        },
      })
    ).rejects.toMatchObject({ code: "CoupledGroupIncomplete" });

    const mergedDispatch = await semantic.dispatch("merge", {
      ingress,
      input: {
        contextId: "context:swap-target",
        commandId: "command:complete-swap",
        expectedWorkingHead: base.event,
        source: { kind: "event", eventId: source.event.eventId },
      },
    });
    const merged = pending<{ workingHead: { kind: "application"; applicationId: string } }>(
      mergedDispatch
    );
    acknowledge(mergedDispatch);
    const mergedRoot = store.stateRoot(merged.workingHead);
    expect(store.facts.fileAtPath(mergedRoot, repository.repositoryId, "a.ts")?.state.fileId).toBe(
      b.state.fileId
    );
    expect(store.facts.fileAtPath(mergedRoot, repository.repositoryId, "b.ts")?.state.fileId).toBe(
      a.state.fileId
    );

    const copyToCollision = async (
      contextId: string,
      commandId: string
    ): Promise<{
      dispatch: SemanticDispatchResult;
      workingHead: { kind: "application"; applicationId: string };
      fileId: string;
    }> => {
      const dispatch = await semantic.dispatch("copy", {
        ingress,
        input: {
          contextId,
          commandId,
          expectedWorkingHead: base.event,
          copies: [
            {
              source: {
                state: base.event,
                repositoryId: repository.repositoryId,
                fileId: a.state.fileId,
              },
              destination: { repositoryId: repository.repositoryId, path: "collision.ts" },
            },
          ],
        },
      });
      const result = pending<{ workingHead: { kind: "application"; applicationId: string } }>(
        dispatch
      );
      acknowledge(dispatch);
      const point = store.facts.fileAtPath(
        store.stateRoot(result.workingHead),
        repository.repositoryId,
        "collision.ts"
      );
      if (!point || point.state.presence !== "placed") throw new Error("copy did not materialize");
      return { dispatch, workingHead: result.workingHead, fileId: point.state.fileId };
    };
    const collisionSource = await copyToCollision(
      "context:collision-source",
      "command:collision-source-copy"
    );
    const collisionCommitDispatch = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:collision-source",
        commandId: "command:collision-source-commit",
        expectedWorkingHead: collisionSource.workingHead,
        message: "Create source collision identity",
      },
    });
    const collisionCommit = pending<{ event: { kind: "event"; eventId: string } }>(
      collisionCommitDispatch
    );
    acknowledge(collisionCommitDispatch);
    const collisionTarget = await copyToCollision(
      "context:collision-target",
      "command:collision-target-copy"
    );

    const collisionComparison = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: collisionTarget.workingHead,
        source: { kind: "event", eventId: collisionCommit.event.eventId },
        limit: 100,
      },
    });
    if (collisionComparison.kind !== "complete")
      throw new Error("collision compare did not complete");
    const collisionCoordinates = (
      collisionComparison.result as {
        coordinates: Array<{
          coordinate: { kind: "file" | "repository"; id: string };
          status: string;
          group?: string;
          structuralConflicts?: Array<{ kind: "file" | "repository"; id: string }>;
          aspects: Array<{ aspect: string; theirs: unknown }>;
        }>;
      }
    ).coordinates;
    expect(collisionCoordinates).toHaveLength(2);
    expect(collisionCoordinates.every((coordinate) => coordinate.status === "conflict")).toBe(true);
    expect(collisionCoordinates[0]?.group).toEqual(expect.any(String));
    expect(collisionCoordinates[1]?.group).toBe(collisionCoordinates[0]?.group);
    for (const coordinate of collisionCoordinates) {
      const peerId =
        coordinate.coordinate.id === collisionSource.fileId
          ? collisionTarget.fileId
          : collisionSource.fileId;
      expect(coordinate.structuralConflicts).toEqual([{ kind: "file", id: peerId }]);
      const placement = coordinate.aspects.find((aspect) => aspect.aspect === "placement");
      expect(placement?.theirs).toEqual(
        coordinate.coordinate.id === collisionSource.fileId
          ? { repositoryId: repository.repositoryId, path: "collision.ts" }
          : null
      );
    }

    const collisionMergeDispatch = await semantic.dispatch("merge", {
      ingress,
      input: {
        contextId: "context:collision-target",
        commandId: "command:resolve-collision-theirs",
        expectedWorkingHead: collisionTarget.workingHead,
        source: { kind: "event", eventId: collisionCommit.event.eventId },
        resolutions: collisionCoordinates.map(({ coordinate }) => ({
          coordinate: { kind: coordinate.kind, id: coordinate.id },
          resolution: "theirs" as const,
        })),
      },
    });
    const collisionMerge = pending<{
      workingHead: { kind: "application"; applicationId: string };
    }>(collisionMergeDispatch);
    acknowledge(collisionMergeDispatch);
    const collisionRoot = store.stateRoot(collisionMerge.workingHead);
    expect(
      store.facts.fileAtPath(collisionRoot, repository.repositoryId, "collision.ts")?.state.fileId
    ).toBe(collisionSource.fileId);
    expect(store.facts.file(collisionRoot, collisionTarget.fileId)?.state.presence).toBe("deleted");
  });
});
