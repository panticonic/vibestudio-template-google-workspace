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
const hash = (text: string) => sha256Hex(new TextEncoder().encode(text));

describe("SemanticWorkspace hunk composition", () => {
  it("reads exact host bytes, composes disjoint edits, and maps content to both parents", async () => {
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
        const savepoint = `content_merge_${transactionOrdinal++}`;
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
      if (result.kind !== "effects-pending") throw new Error("expected a pending host effect");
      return result.result as T;
    };
    const acknowledgeMaterialization = (result: SemanticDispatchResult): void => {
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
    const editText = (result: SemanticDispatchResult, baseText: string): SemanticDispatchResult => {
      if (result.kind !== "effects-pending") throw new Error("text edit did not request bytes");
      const observation = result.effects.find((candidate) => candidate.kind === "observe-content");
      if (!observation) throw new Error("text edit has no observation");
      return semantic.acknowledgeEffect({
        effectId: observation.effectId,
        payloadDigest: observation.payloadDigest,
        receipt: { files: [{ contentHash: hash(baseText), base64: btoa(baseText) }] },
      });
    };

    const baseText = "top\nmiddle\nbottom\n";
    const oursText = "ours\nmiddle\nbottom\n";
    const theirsText = "top\nmiddle\ntheirs\n";
    const composedText = "ours\nmiddle\ntheirs\n";
    const initial = store.initializeWorkspace("context:source", "command:genesis");
    const baseDispatch = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:source",
        commandId: "command:base",
        expectedWorkingHead: initial.working.ref,
        changes: [
          {
            kind: "repository-create",
            repoPath: "packages/fixture",
            files: [{ path: "index.ts", content: { kind: "text", text: baseText }, mode: 0o644 }],
          },
        ],
      },
    });
    const baseWorking = pending<{ workingHead: { kind: "application"; applicationId: string } }>(
      baseDispatch
    );
    acknowledgeMaterialization(baseDispatch);
    const baseCommitDispatch = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:source",
        commandId: "command:base-commit",
        expectedWorkingHead: baseWorking.workingHead,
        message: "Base",
      },
    });
    const base = pending<{ event: { kind: "event"; eventId: string } }>(baseCommitDispatch);
    acknowledgeMaterialization(baseCommitDispatch);
    store.forkContext("context:source", "context:target");
    store.forkContext("context:source", "context:mixed");
    store.forkContext("context:source", "context:conflict");
    const baseRoot = store.stateRoot(base.event);
    const repository = store.facts.repositoryAtPath(baseRoot, "packages/fixture");
    if (!repository || repository.presence !== "present") throw new Error("missing repository");
    const file = store.facts.fileAtPath(baseRoot, repository.repositoryId, "index.ts");
    if (!file || file.state.presence !== "placed") throw new Error("missing file");

    const sourceObservation = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:source",
        commandId: "command:source-edit",
        expectedWorkingHead: base.event,
        intentSummary: "Change the footer behavior",
        changes: [
          {
            kind: "text-edit",
            repositoryId: repository.repositoryId,
            fileId: file.state.fileId,
            edits: [{ start: 11, end: 17, text: "theirs" }],
          },
        ],
      },
    });
    const sourceEditDispatch = editText(sourceObservation, baseText);
    const sourceEdit = pending<{
      workingHead: { kind: "application"; applicationId: string };
      changeIds: string[];
    }>(sourceEditDispatch);
    acknowledgeMaterialization(sourceEditDispatch);
    const sourceCommitDispatch = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:source",
        commandId: "command:source-commit",
        expectedWorkingHead: sourceEdit.workingHead,
        message: "Source footer",
      },
    });
    const sourceCommit = pending<{ event: { kind: "event"; eventId: string } }>(
      sourceCommitDispatch
    );
    acknowledgeMaterialization(sourceCommitDispatch);

    const targetObservation = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:target",
        commandId: "command:target-edit",
        expectedWorkingHead: base.event,
        intentSummary: "Change the header behavior",
        changes: [
          {
            kind: "text-edit",
            repositoryId: repository.repositoryId,
            fileId: file.state.fileId,
            edits: [{ start: 0, end: 3, text: "ours" }],
          },
        ],
      },
    });
    const targetEditDispatch = editText(targetObservation, baseText);
    const targetEdit = pending<{
      workingHead: { kind: "application"; applicationId: string };
      changeIds: string[];
    }>(targetEditDispatch);
    acknowledgeMaterialization(targetEditDispatch);

    const compareRead = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: targetEdit.workingHead,
        source: { kind: "event", eventId: sourceCommit.event.eventId },
        limit: 100,
      },
    });
    if (compareRead.kind !== "host-read") throw new Error("compare did not request exact content");
    expect(compareRead.request).toMatchObject({ kind: "read-merge-content", operation: "compare" });
    const bytes = new Map([
      [hash(baseText), baseText],
      [hash(oursText), oursText],
      [hash(theirsText), theirsText],
    ]);
    const comparison = semantic.acknowledgeHostRead({
      request: compareRead.request,
      files: (compareRead.request["contentHashes"] as string[]).map((contentHash) => ({
        contentHash,
        text: bytes.get(contentHash)!,
      })),
    });
    expect(comparison).toMatchObject({
      kind: "complete",
      result: { counts: { composed: 1, conflict: 0 }, coordinates: [{ status: "composed" }] },
    });

    const mergeRead = await semantic.dispatch("merge", {
      ingress,
      input: {
        contextId: "context:target",
        commandId: "command:merge",
        expectedWorkingHead: targetEdit.workingHead,
        source: { kind: "event", eventId: sourceCommit.event.eventId },
        resolutions: [
          {
            coordinate: {
              kind: "file",
              id: file.state.fileId,
            },
            resolution: "composed",
          },
        ],
        intentSummary: "Compose the reviewed header and footer intents",
      },
    });
    if (mergeRead.kind !== "host-read") throw new Error("merge did not request exact content");
    const mergedDispatch = semantic.acknowledgeHostRead({
      request: mergeRead.request,
      files: (mergeRead.request["contentHashes"] as string[]).map((contentHash) => ({
        contentHash,
        text: bytes.get(contentHash)!,
      })),
    });
    const merged = pending<{
      applicationId: string;
      decisionId: string;
      workingHead: { kind: "application"; applicationId: string };
      composed: unknown[];
    }>(mergedDispatch);
    expect(merged.composed).toHaveLength(1);
    expect(
      store.facts.file(store.stateRoot(merged.workingHead), file.state.fileId)?.state
    ).toMatchObject({
      contentHash: hash(composedText),
      coordinateExtent: composedText.length,
    });
    expect(
      sql
        .exec(
          `SELECT edge.relation FROM gad_content_edges edge
          JOIN gad_applied_changes applied ON applied.applied_change_id = edge.child_applied_change_id
         WHERE applied.application_id = ? ORDER BY edge.parent_applied_change_id`,
          merged.applicationId
        )
        .toArray()
    ).toEqual([{ relation: "incorporates" }, { relation: "incorporates" }]);
    expect(
      sql
        .exec(
          `SELECT resolution, result_change_id FROM gad_merge_decision_entries WHERE decision_id = ?`,
          merged.decisionId
        )
        .toArray()[0]
    ).toMatchObject({
      resolution: "composed",
      result_change_id: expect.stringMatching(/^change:/u),
    });

    acknowledgeMaterialization(mergedDispatch);
    const commitDispatch = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:target",
        commandId: "command:commit-composed",
        expectedWorkingHead: merged.workingHead,
        message: "Commit composed content",
      },
    });
    const committed = pending<{ event: { kind: "event"; eventId: string } }>(commitDispatch);
    acknowledgeMaterialization(commitDispatch);
    const laterComparison = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: base.event,
        source: { kind: "event", eventId: committed.event.eventId },
        limit: 100,
      },
    });
    if (laterComparison.kind !== "complete") throw new Error("later comparison did not complete");
    const attributed = (
      laterComparison.result as {
        coordinates: Array<{ attribution: { theirs: Array<{ changeId: string }> } }>;
      }
    ).coordinates[0]!.attribution.theirs.map((entry) => entry.changeId);
    expect(attributed).toEqual(
      expect.arrayContaining([sourceEdit.changeIds[0], targetEdit.changeIds[0]])
    );
    expect(attributed).toHaveLength(3);

    const offSpineComparison = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: sourceCommit.event,
        source: { kind: "event", eventId: committed.event.eventId },
        limit: 100,
      },
    });
    if (offSpineComparison.kind !== "complete") {
      throw new Error("off-spine comparison did not complete");
    }
    const offSpineAttribution = (
      offSpineComparison.result as {
        coordinates: Array<{
          coordinate: { id: string };
          attribution: { theirs: Array<{ changeId: string }> };
        }>;
      }
    ).coordinates.find((coordinate) => coordinate.coordinate.id === file.state.fileId)?.attribution
      .theirs;
    expect(offSpineAttribution?.map((entry) => entry.changeId)).toEqual(
      expect.arrayContaining([sourceEdit.changeIds[0], targetEdit.changeIds[0]])
    );

    const localMoveDispatch = await semantic.dispatch("move", {
      ingress,
      input: {
        contextId: "context:mixed",
        commandId: "command:mixed-local-move",
        expectedWorkingHead: base.event,
        moves: [
          {
            kind: "file",
            repositoryId: repository.repositoryId,
            fileId: file.state.fileId,
            destinationRepositoryId: repository.repositoryId,
            destinationPath: "renamed.ts",
          },
        ],
      },
    });
    const localMove = pending<{
      workingHead: { kind: "application"; applicationId: string };
      changeIds: string[];
    }>(localMoveDispatch);
    acknowledgeMaterialization(localMoveDispatch);
    const mixedComparison = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: localMove.workingHead,
        source: { kind: "event", eventId: sourceCommit.event.eventId },
        limit: 100,
      },
    });
    if (mixedComparison.kind !== "complete") throw new Error("mixed compare did not complete");
    expect(mixedComparison.result).toMatchObject({
      counts: { composed: 1, conflict: 0 },
      coordinates: [{ status: "composed" }],
    });
    const mixedMergeDispatch = await semantic.dispatch("merge", {
      ingress,
      input: {
        contextId: "context:mixed",
        commandId: "command:mixed-merge",
        expectedWorkingHead: localMove.workingHead,
        source: { kind: "event", eventId: sourceCommit.event.eventId },
      },
    });
    const mixedMerge = pending<{
      applicationId: string;
      decisionId: string;
      workingHead: { kind: "application"; applicationId: string };
      composed: unknown[];
    }>(mixedMergeDispatch);
    expect(mixedMerge.composed).toHaveLength(1);
    expect(
      sql
        .exec(
          `SELECT resolution FROM gad_merge_decision_entries
          WHERE decision_id = ? AND coordinate_kind = 'file' AND coordinate_id = ?`,
          mixedMerge.decisionId,
          file.state.fileId
        )
        .toArray()[0]
    ).toEqual({ resolution: "composed" });
    expect(
      sql
        .exec(
          `SELECT parent.change_id
           FROM gad_content_edges edge
           JOIN gad_applied_changes child
             ON child.applied_change_id = edge.child_applied_change_id
           JOIN gad_applied_changes parent
             ON parent.applied_change_id = edge.parent_applied_change_id
          WHERE child.application_id = ?`,
          mixedMerge.applicationId
        )
        .toArray()
    ).toEqual([{ change_id: sourceEdit.changeIds[0] }]);
    acknowledgeMaterialization(mixedMergeDispatch);

    const laterModeDispatch = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:mixed",
        commandId: "command:mixed-later-mode",
        expectedWorkingHead: mixedMerge.workingHead,
        intentSummary: "Make the merged file executable",
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
    const laterMode = pending<{
      workingHead: { kind: "application"; applicationId: string };
      changeIds: string[];
    }>(laterModeDispatch);
    acknowledgeMaterialization(laterModeDispatch);
    const resolvedComparison = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: laterMode.workingHead,
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
          attribution: { ours: Array<{ changeId: string }> };
        }>;
      }
    ).coordinates.find((coordinate) => coordinate.coordinate.id === file.state.fileId);
    expect(resolvedFile?.status).toBe("resolved");
    expect(resolvedFile?.attribution.ours.map(({ changeId }) => changeId)).toEqual([
      localMove.changeIds[0],
      laterMode.changeIds[0],
    ]);

    const conflictMoveDispatch = await semantic.dispatch("move", {
      ingress,
      input: {
        contextId: "context:conflict",
        commandId: "command:conflict-local-move",
        expectedWorkingHead: base.event,
        moves: [
          {
            kind: "file",
            repositoryId: repository.repositoryId,
            fileId: file.state.fileId,
            destinationRepositoryId: repository.repositoryId,
            destinationPath: "conflict.ts",
          },
        ],
      },
    });
    const conflictMove = pending<{
      workingHead: { kind: "application"; applicationId: string };
    }>(conflictMoveDispatch);
    acknowledgeMaterialization(conflictMoveDispatch);
    const conflictObservation = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:conflict",
        commandId: "command:conflict-local-content",
        expectedWorkingHead: conflictMove.workingHead,
        changes: [
          {
            kind: "text-edit",
            repositoryId: repository.repositoryId,
            fileId: file.state.fileId,
            edits: [{ start: 11, end: 17, text: "local" }],
          },
        ],
      },
    });
    const conflictEditDispatch = editText(conflictObservation, baseText);
    const conflictEdit = pending<{
      workingHead: { kind: "application"; applicationId: string };
    }>(conflictEditDispatch);
    acknowledgeMaterialization(conflictEditDispatch);
    const localConflictText = "top\nmiddle\nlocal\n";
    const conflictBytes = new Map([
      [hash(baseText), baseText],
      [hash(localConflictText), localConflictText],
      [hash(theirsText), theirsText],
    ]);
    const conflictCompareRead = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: conflictEdit.workingHead,
        source: { kind: "event", eventId: sourceCommit.event.eventId },
        limit: 100,
      },
    });
    if (conflictCompareRead.kind !== "host-read") {
      throw new Error("conflict compare did not request exact content");
    }
    const conflictComparison = semantic.acknowledgeHostRead({
      request: conflictCompareRead.request,
      files: (conflictCompareRead.request["contentHashes"] as string[]).map((contentHash) => ({
        contentHash,
        text: conflictBytes.get(contentHash)!,
      })),
    });
    expect(conflictComparison).toMatchObject({
      kind: "complete",
      result: { coordinates: [{ status: "conflict" }] },
    });
    store.forkContext("context:conflict", "context:decision-only");
    const decisionOnlyRead = await semantic.dispatch("merge", {
      ingress,
      input: {
        contextId: "context:decision-only",
        commandId: "command:record-conflict-conclusion",
        expectedWorkingHead: conflictEdit.workingHead,
        source: { kind: "event", eventId: sourceCommit.event.eventId },
      },
    });
    if (decisionOnlyRead.kind !== "host-read") {
      throw new Error("conflict-only merge did not request exact content");
    }
    const decisionOnlyDispatch = semantic.acknowledgeHostRead({
      request: decisionOnlyRead.request,
      files: (decisionOnlyRead.request["contentHashes"] as string[]).map((contentHash) => ({
        contentHash,
        text: conflictBytes.get(contentHash)!,
      })),
    });
    const decisionOnly = pending<{
      workingHead: { kind: "application"; applicationId: string };
      changeCount: number;
    }>(decisionOnlyDispatch);
    expect(decisionOnly.changeCount).toBe(0);
    const repeatedDecisionRead = await semantic.dispatch("merge", {
      ingress,
      input: {
        contextId: "context:decision-only",
        commandId: "command:reject-repeated-conflict-conclusion",
        expectedWorkingHead: decisionOnly.workingHead,
        source: { kind: "event", eventId: sourceCommit.event.eventId },
      },
    });
    if (repeatedDecisionRead.kind !== "host-read") {
      throw new Error("repeated conflict-only merge did not request exact content");
    }
    const repeatedConflict = semantic.acknowledgeHostRead({
      request: repeatedDecisionRead.request,
      files: (repeatedDecisionRead.request["contentHashes"] as string[]).map((contentHash) => ({
        contentHash,
        text: conflictBytes.get(contentHash)!,
      })),
    });
    expect(repeatedConflict).toMatchObject({
      kind: "complete",
      result: { status: "unchanged", resolution: { complete: false, concluded: true } },
    });
    const conflictMergeRead = await semantic.dispatch("merge", {
      ingress,
      input: {
        contextId: "context:conflict",
        commandId: "command:conflict-decline-remainder",
        expectedWorkingHead: conflictEdit.workingHead,
        source: { kind: "event", eventId: sourceCommit.event.eventId },
        resolutions: { allRemaining: { resolution: "ours" } },
      },
    });
    if (conflictMergeRead.kind !== "host-read") {
      throw new Error("conflict merge did not request exact content");
    }
    const conflictMergedDispatch = semantic.acknowledgeHostRead({
      request: conflictMergeRead.request,
      files: (conflictMergeRead.request["contentHashes"] as string[]).map((contentHash) => ({
        contentHash,
        text: conflictBytes.get(contentHash)!,
      })),
    });
    const conflictMerged = pending<{
      workingHead: { kind: "application"; applicationId: string };
    }>(conflictMergedDispatch);
    const conflictResult = store.facts.file(
      store.stateRoot(conflictMerged.workingHead),
      file.state.fileId
    );
    expect(conflictResult?.state).toMatchObject({
      path: "conflict.ts",
      contentHash: hash(localConflictText),
    });
  });
});
