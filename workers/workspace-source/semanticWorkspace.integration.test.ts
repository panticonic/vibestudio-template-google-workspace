import { describe, expect, it } from "vitest";
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

function pending<T>(result: SemanticDispatchResult): T {
  if (result.kind !== "effects-pending") throw new Error("expected a materialization effect");
  return result.result as T;
}

describe("SemanticWorkspace net-effect merge", () => {
  it("merges each stable coordinate once while retaining its complete source attribution", async () => {
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
        const savepoint = `net_merge_${transactionOrdinal++}`;
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

    const sourceInitial = store.initializeWorkspace("context:source", "command:source-genesis");
    const baseEditDispatch = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:source",
        commandId: "command:base",
        expectedWorkingHead: sourceInitial.working.ref,
        intentSummary: "Create the fixture coordinate",
        changes: [
          {
            kind: "repository-create",
            repoPath: "packages/fixture",
            files: [{ path: "index.ts", content: { kind: "text", text: "base\n" }, mode: 0o644 }],
          },
        ],
      },
    });
    const baseEdit = pending<{ workingHead: { kind: "application"; applicationId: string } }>(
      baseEditDispatch
    );
    acknowledge(baseEditDispatch);
    const baseCommitDispatch = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:source",
        commandId: "command:base-commit",
        expectedWorkingHead: baseEdit.workingHead,
        message: "Base fixture",
      },
    });
    const baseCommit = pending<{ event: { kind: "event"; eventId: string } }>(baseCommitDispatch);
    acknowledge(baseCommitDispatch);

    store.initializeWorkspace("context:target", "command:target-genesis");
    sql.exec(
      `UPDATE vcs_contexts SET committed_event_id = ?, working_head_application_id = NULL
        WHERE context_id = 'context:target'`,
      baseCommit.event.eventId
    );
    const baseRoot = store.stateRoot(baseCommit.event);
    const repository = store.facts.repositoryAtPath(baseRoot, "packages/fixture");
    if (!repository || repository.presence !== "present") throw new Error("missing fixture repo");
    const file = store.facts.fileAtPath(baseRoot, repository.repositoryId, "index.ts");
    if (!file || file.state.presence !== "placed") throw new Error("missing fixture file");

    const firstDispatch = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:source",
        commandId: "command:first-mode",
        expectedWorkingHead: baseCommit.event,
        intentSummary: "Make the fixture executable while evaluating deployment",
        changes: [
          {
            kind: "file-mode",
            repositoryId: repository.repositoryId,
            fileId: file.state.fileId,
            mode: 0o755,
          },
        ],
      },
    });
    const first = pending<{
      workingHead: { kind: "application"; applicationId: string };
      changeIds: string[];
    }>(firstDispatch);
    acknowledge(firstDispatch);
    const secondDispatch = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:source",
        commandId: "command:second-mode",
        expectedWorkingHead: first.workingHead,
        intentSummary: "Set the final restricted deployment mode",
        changes: [
          {
            kind: "file-mode",
            repositoryId: repository.repositoryId,
            fileId: file.state.fileId,
            mode: 0o600,
          },
        ],
      },
    });
    const second = pending<{
      workingHead: { kind: "application"; applicationId: string };
      changeIds: string[];
    }>(secondDispatch);
    acknowledge(secondDispatch);
    const moveDispatch = await semantic.dispatch("move", {
      ingress,
      input: {
        contextId: "context:source",
        commandId: "command:move-repository",
        expectedWorkingHead: second.workingHead,
        intentSummary: "Move the fixture under its final package name",
        moves: [
          {
            kind: "repository",
            repositoryId: repository.repositoryId,
            destinationPath: "packages/final-fixture",
          },
        ],
      },
    });
    const moved = pending<{
      workingHead: { kind: "application"; applicationId: string };
      changeIds: string[];
    }>(moveDispatch);
    acknowledge(moveDispatch);
    const workingComparison = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: baseCommit.event,
        source: moved.workingHead,
        limit: 100,
      },
    });
    if (workingComparison.kind !== "complete") {
      throw new Error("working-state compare did not complete");
    }
    expect(workingComparison.result).toMatchObject({
      source: moved.workingHead,
      resolution: { complete: false, remainingCoordinateCount: 2, concluded: false },
      counts: { adopt: 2, conflict: 0 },
      intentCounts: { pending: 3 },
    });
    const sourceCommitDispatch = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:source",
        commandId: "command:source-commit",
        expectedWorkingHead: moved.workingHead,
        message: "Finish source work",
      },
    });
    const sourceCommit = pending<{ event: { kind: "event"; eventId: string } }>(
      sourceCommitDispatch
    );
    acknowledge(sourceCommitDispatch);

    const queriedApplicationIds: string[][] = [];
    const comparisonInternals = semantic as unknown as {
      changesInApplications(applicationIds: string[]): unknown;
    };
    const changesInApplications = comparisonInternals.changesInApplications.bind(semantic);
    comparisonInternals.changesInApplications = (applicationIds) => {
      queriedApplicationIds.push([...applicationIds]);
      return changesInApplications(applicationIds);
    };

    const compared = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: baseCommit.event,
        source: { kind: "event", eventId: sourceCommit.event.eventId },
        limit: 100,
      },
    });
    if (compared.kind !== "complete") throw new Error("compare did not complete");
    expect(queriedApplicationIds).toHaveLength(2);
    expect(queriedApplicationIds[0]).not.toContain(baseEdit.workingHead.applicationId);
    expect(queriedApplicationIds[1]).toEqual([]);
    expect(compared.result).toMatchObject({
      resolution: { complete: false, remainingCoordinateCount: 2, concluded: false },
      counts: { adopt: 2, conflict: 0 },
      intentCounts: { merged: 0, settled: 0, split: 0, contested: 0, pending: 3 },
    });
    const firstUnfilteredPage = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: baseCommit.event,
        source: { kind: "event", eventId: sourceCommit.event.eventId },
        limit: 1,
      },
    });
    if (firstUnfilteredPage.kind !== "complete") throw new Error("compare did not complete");
    const unfilteredCursor = (firstUnfilteredPage.result as { nextCursor: string | null })
      .nextCursor;
    expect(unfilteredCursor).toEqual(expect.any(String));
    const conflictOnly = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: baseCommit.event,
        source: { kind: "event", eventId: sourceCommit.event.eventId },
        statusFilter: "conflict",
        limit: 1,
      },
    });
    expect(conflictOnly).toMatchObject({
      kind: "complete",
      result: { counts: { adopt: 2, conflict: 0 }, coordinates: [], nextCursor: null },
    });
    await expect(
      semantic.dispatch("compare", {
        ingress,
        input: {
          target: baseCommit.event,
          source: { kind: "event", eventId: sourceCommit.event.eventId },
          statusFilter: "conflict",
          cursor: unfilteredCursor!,
          limit: 1,
        },
      })
    ).rejects.toMatchObject({ code: "InvalidReference" });
    expect(
      (compared.result as { intents: Array<{ side: string; state?: string }> }).intents
        .filter((intent) => intent.side === "theirs")
        .map((intent) => intent.state)
    ).toEqual(["pending", "pending", "pending"]);
    const coordinates = (
      compared.result as {
        coordinates: Array<{
          coordinate: { id: string };
          attribution: { theirs: Array<{ changeId: string }> };
        }>;
      }
    ).coordinates;
    expect(coordinates.every((coordinate) => !("group" in coordinate))).toBe(true);
    expect(
      coordinates.find((row) => row.coordinate.id === file.state.fileId)?.attribution.theirs
    ).toEqual([
      { changeId: first.changeIds[0], workUnitId: expect.any(String), undone: true },
      { changeId: second.changeIds[0], workUnitId: expect.any(String) },
    ]);

    const mergeDispatch = await semantic.dispatch("merge", {
      ingress,
      input: {
        contextId: "context:target",
        commandId: "command:merge-source",
        expectedWorkingHead: baseCommit.event,
        source: { kind: "event", eventId: sourceCommit.event.eventId },
        intentSummary: "Merge the reviewed source coordinates",
      },
    });
    const merged = pending<{
      workingHead: { kind: "application"; applicationId: string };
      decisionId: string;
      resolution: { complete: boolean; concluded: boolean };
      outcomes: unknown[];
    }>(mergeDispatch);
    acknowledge(mergeDispatch);
    expect(merged.outcomes).toHaveLength(2);
    expect(merged.resolution).toEqual({
      complete: true,
      remainingCoordinateCount: 0,
      concluded: true,
    });
    expect(
      (merged as unknown as { intents: Array<{ side: string; state?: string }> }).intents
        .filter((intent) => intent.side === "theirs")
        .map((intent) => intent.state)
    ).toEqual(["merged", "merged", "merged"]);
    const mergedRoot = store.stateRoot(merged.workingHead);
    expect(store.facts.file(mergedRoot, file.state.fileId)?.state).toMatchObject({ mode: 0o600 });
    expect(store.facts.member(mergedRoot, repository.repositoryId)).toMatchObject({
      repoPath: "packages/final-fixture",
    });
    expect(
      sql
        .exec(
          `SELECT coordinate_kind, coordinate_id FROM gad_merge_decision_entries WHERE decision_id = ? ORDER BY coordinate_kind, coordinate_id`,
          merged.decisionId
        )
        .toArray()
    ).toEqual([
      { coordinate_kind: "file", coordinate_id: file.state.fileId },
      { coordinate_kind: "repository", coordinate_id: repository.repositoryId },
    ]);

    const resolvedComparison = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: merged.workingHead,
        source: { kind: "event", eventId: sourceCommit.event.eventId },
        limit: 100,
      },
    });
    if (resolvedComparison.kind !== "complete")
      throw new Error("resolved compare did not complete");
    const resolvedFile = (
      resolvedComparison.result as {
        coordinates: Array<{
          coordinate: { id: string };
          status: string;
          attribution: { ours: unknown[]; theirs: Array<{ changeId: string }> };
        }>;
      }
    ).coordinates.find((coordinate) => coordinate.coordinate.id === file.state.fileId);
    expect(resolvedFile).toMatchObject({
      status: "resolved",
      attribution: {
        ours: [],
        theirs: [
          { changeId: first.changeIds[0], workUnitId: expect.any(String), undone: true },
          { changeId: second.changeIds[0], workUnitId: expect.any(String) },
        ],
      },
    });

    await expect(
      semantic.dispatch("merge", {
        ingress,
        input: {
          contextId: "context:target",
          commandId: "command:repeat-resolved-coordinate",
          expectedWorkingHead: merged.workingHead,
          source: { kind: "event", eventId: sourceCommit.event.eventId },
          coordinates: [{ kind: "file", id: file.state.fileId }],
        },
      })
    ).rejects.toMatchObject({ code: "InvalidReference" });

    const integrationCommitDispatch = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:target",
        commandId: "command:integration-commit",
        expectedWorkingHead: merged.workingHead,
        message: "Commit reviewed merge",
      },
    });
    const integrationCommit = pending<{ event: { kind: "event"; eventId: string } }>(
      integrationCommitDispatch
    );
    acknowledge(integrationCommitDispatch);
    expect(store.event(integrationCommit.event.eventId)?.parentEventIds).toEqual([
      baseCommit.event.eventId,
      sourceCommit.event.eventId,
    ]);

    sql.exec(`DELETE FROM gad_merge_decision_entries WHERE decision_id = ?`, merged.decisionId);
    await expect(
      semantic.dispatch("push", {
        ingress,
        input: {
          contextId: "context:target",
          commandId: "command:reject-corrupt-integration",
          expectedCommittedEventId: integrationCommit.event.eventId,
          expectedMainEventId: store.mainEventId(),
        },
      })
    ).rejects.toMatchObject({ code: "IntegrityFailure" });
  });

  it("records a decision-only merge when the source chain has zero net effect", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    const store = new SemanticVcsStore(sql, () => timestamp);
    let transactionOrdinal = 0;
    const semantic = new SemanticWorkspace({
      workspaceId: "workspace:zero-effect",
      sql,
      store,
      now: () => timestamp,
      transaction: <T>(fn: () => T): T => {
        const savepoint = `zero_effect_${transactionOrdinal++}`;
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

    const initial = store.initializeWorkspace("context:source-zero", "command:zero-genesis");
    const createdDispatch = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:source-zero",
        commandId: "command:zero-base",
        expectedWorkingHead: initial.working.ref,
        changes: [
          {
            kind: "repository-create",
            repoPath: "packages/zero",
            files: [{ path: "index.ts", content: { kind: "text", text: "base\n" }, mode: 0o644 }],
          },
        ],
      },
    });
    const created = pending<{ workingHead: { kind: "application"; applicationId: string } }>(
      createdDispatch
    );
    acknowledge(createdDispatch);
    const baseCommitDispatch = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:source-zero",
        commandId: "command:zero-base-commit",
        expectedWorkingHead: created.workingHead,
        message: "Zero-effect base",
      },
    });
    const base = pending<{ event: { kind: "event"; eventId: string } }>(baseCommitDispatch);
    acknowledge(baseCommitDispatch);
    store.forkContext("context:source-zero", "context:target-zero");
    const baseRoot = store.stateRoot(base.event);
    const repository = store.facts.repositoryAtPath(baseRoot, "packages/zero");
    if (!repository || repository.presence !== "present") throw new Error("missing repository");
    const file = store.facts.fileAtPath(baseRoot, repository.repositoryId, "index.ts");
    if (!file || file.state.presence !== "placed") throw new Error("missing file");

    const changedDispatch = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:source-zero",
        commandId: "command:zero-change",
        expectedWorkingHead: base.event,
        changes: [
          {
            kind: "file-mode",
            repositoryId: repository.repositoryId,
            fileId: file.state.fileId,
            mode: 0o755,
          },
        ],
      },
    });
    const changed = pending<{ workingHead: { kind: "application"; applicationId: string } }>(
      changedDispatch
    );
    acknowledge(changedDispatch);
    const restoredDispatch = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:source-zero",
        commandId: "command:zero-restore",
        expectedWorkingHead: changed.workingHead,
        changes: [
          {
            kind: "file-mode",
            repositoryId: repository.repositoryId,
            fileId: file.state.fileId,
            mode: 0o644,
          },
        ],
      },
    });
    const restored = pending<{ workingHead: { kind: "application"; applicationId: string } }>(
      restoredDispatch
    );
    acknowledge(restoredDispatch);
    const sourceCommitDispatch = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:source-zero",
        commandId: "command:zero-source-commit",
        expectedWorkingHead: restored.workingHead,
        message: "Source with zero net effect",
      },
    });
    const source = pending<{ event: { kind: "event"; eventId: string } }>(sourceCommitDispatch);
    acknowledge(sourceCommitDispatch);

    const targetDispatch = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:target-zero",
        commandId: "command:zero-target-change",
        expectedWorkingHead: base.event,
        changes: [
          {
            kind: "file-mode",
            repositoryId: repository.repositoryId,
            fileId: file.state.fileId,
            mode: 0o600,
          },
        ],
      },
    });
    const target = pending<{ workingHead: { kind: "application"; applicationId: string } }>(
      targetDispatch
    );
    acknowledge(targetDispatch);

    const comparison = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: target.workingHead,
        source: { kind: "event", eventId: source.event.eventId },
        limit: 100,
      },
    });
    expect(comparison).toMatchObject({
      kind: "complete",
      result: {
        coordinates: [],
        resolution: { complete: true, remainingCoordinateCount: 0, concluded: false },
      },
    });

    const mergeDispatch = await semantic.dispatch("merge", {
      ingress,
      input: {
        contextId: "context:target-zero",
        commandId: "command:zero-merge",
        expectedWorkingHead: target.workingHead,
        source: { kind: "event", eventId: source.event.eventId },
      },
    });
    const merged = pending<{
      workingHead: { kind: "application"; applicationId: string };
      changeCount: number;
      resolution: { concluded: boolean };
    }>(mergeDispatch);
    acknowledge(mergeDispatch);
    expect(merged).toMatchObject({ changeCount: 0, resolution: { concluded: true } });

    const repeated = await semantic.dispatch("merge", {
      ingress,
      input: {
        contextId: "context:target-zero",
        commandId: "command:repeat-zero-merge",
        expectedWorkingHead: merged.workingHead,
        source: { kind: "event", eventId: source.event.eventId },
      },
    });
    expect(repeated).toMatchObject({
      kind: "complete",
      result: { status: "unchanged", workingHead: merged.workingHead },
    });
    // Driver re-entry derives the identical command id (same head, source, and
    // resolutions), so an unchanged merge must be replayable under the SAME id
    // rather than leaving its command pending.
    const replayedSameCommand = await semantic.dispatch("merge", {
      ingress,
      input: {
        contextId: "context:target-zero",
        commandId: "command:repeat-zero-merge",
        expectedWorkingHead: merged.workingHead,
        source: { kind: "event", eventId: source.event.eventId },
      },
    });
    expect(replayedSameCommand).toMatchObject({
      kind: "complete",
      result: { status: "unchanged", workingHead: merged.workingHead },
    });
    const integratingStatus = await semantic.dispatch("status", {
      ingress,
      input: { contextId: "context:target-zero" },
    });
    expect(integratingStatus).toMatchObject({
      kind: "complete",
      result: {
        integrating: [
          {
            source: { kind: "event", eventId: source.event.eventId },
            remainingCoordinateCount: 0,
            concluded: true,
            stale: false,
          },
        ],
      },
    });

    const unrelatedEditDispatch = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:target-zero",
        commandId: "command:unrelated-after-integration",
        expectedWorkingHead: merged.workingHead,
        changes: [
          {
            kind: "repository-create",
            repoPath: "packages/unrelated",
            files: [{ path: "README.md", content: { kind: "text", text: "ok\n" } }],
          },
        ],
      },
    });
    const unrelatedEdit = pending<{
      workingHead: { kind: "application"; applicationId: string };
    }>(unrelatedEditDispatch);
    acknowledge(unrelatedEditDispatch);
    const staleStatus = await semantic.dispatch("status", {
      ingress,
      input: { contextId: "context:target-zero" },
    });
    expect(staleStatus).toMatchObject({
      kind: "complete",
      result: { integrating: [{ stale: true, asOfWorkingHead: merged.workingHead }] },
    });

    const committedDispatch = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:target-zero",
        commandId: "command:zero-integration-commit",
        expectedWorkingHead: unrelatedEdit.workingHead,
        message: "Record reviewed zero-effect source",
      },
    });
    const committed = pending<{ event: { kind: "event"; eventId: string } }>(committedDispatch);
    acknowledge(committedDispatch);
    const committedStatus = await semantic.dispatch("status", {
      ingress,
      input: { contextId: "context:target-zero" },
    });
    expect(committedStatus).toMatchObject({
      kind: "complete",
      result: { integrating: [] },
    });
    expect(store.event(committed.event.eventId)?.parentEventIds).toEqual([
      base.event.eventId,
      source.event.eventId,
    ]);
  });
});
