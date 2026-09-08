import { describe, expect, it } from "vitest";
import { sha256Hex } from "@vibestudio/content-addressing";
import { createInMemorySql } from "@vibestudio/durable/test-utils";
import { createSemanticVcsSchema } from "./semanticVcsSchema.js";
import {
  SemanticWorkspace,
  type SemanticDispatchRequest,
  type SemanticDispatchResult,
} from "./semanticWorkspace.testHost.js";
import { SemanticVcsStore } from "./semanticVcsStore.js";

const timestamp = "2026-09-08T00:00:00.000Z";
const ingress: SemanticDispatchRequest["ingress"] = {
  causalParent: null,
  contextIntegrity: { class: "internal", externalKeys: [] },
};
const contentHash = (text: string) => sha256Hex(new TextEncoder().encode(text));

describe("SemanticWorkspace shared merge attribution", () => {
  it("compares sibling integrations whose shared application follows their event base", async () => {
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
        const savepoint = `shared_merge_${transactionOrdinal++}`;
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
      if (result.kind !== "effects-pending")
        throw new Error("expected pending effects");
      return result.result as T;
    };
    const texts = new Map([
      [contentHash("base\n"), "base\n"],
      [contentHash("ours\n"), "ours\n"],
      [contentHash("theirs\n"), "theirs\n"],
    ]);
    const acknowledgeRead = (
      result: SemanticDispatchResult,
    ): SemanticDispatchResult => {
      if (result.kind !== "host-read") return result;
      return semantic.acknowledgeHostRead({
        request: result.request,
        files: (result.request["contentHashes"] as string[]).map((hash) => ({
          contentHash: hash,
          text: texts.get(hash)!,
        })),
      });
    };
    const acknowledge = (result: SemanticDispatchResult): void => {
      if (result.kind !== "effects-pending") return;
      const effect = result.effects.find(
        (candidate) => candidate.kind === "materialize-context",
      );
      if (!effect) return;
      const repositories = effect.payload["repositories"] as Array<{
        repositoryId: string;
        repoPath: string;
        presence: "present" | "deleted";
        source:
          | { kind: "content-root"; contentRoot: string }
          | { kind: "delta" | "snapshot" };
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
    const commit = async (
      contextId: string,
      commandId: string,
      head: { kind: "application"; applicationId: string },
      message: string,
    ): Promise<{ kind: "event"; eventId: string }> => {
      const dispatch = await semantic.dispatch("commit", {
        ingress,
        input: { contextId, commandId, expectedWorkingHead: head, message },
      });
      const result = pending<{ event: { kind: "event"; eventId: string } }>(
        dispatch,
      );
      acknowledge(dispatch);
      return result.event;
    };

    const initial = store.initializeWorkspace(
      "context:source",
      "command:genesis",
    );
    const createdDispatch = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:source",
        commandId: "command:create",
        expectedWorkingHead: initial.working.ref,
        changes: [
          {
            kind: "repository-create",
            repoPath: "packages/fixture",
            files: [
              {
                path: "index.ts",
                content: { kind: "text", text: "base\n" },
                mode: 0o644,
              },
            ],
          },
        ],
      },
    });
    const created = pending<{
      workingHead: { kind: "application"; applicationId: string };
    }>(createdDispatch);
    acknowledge(createdDispatch);
    const base = await commit(
      "context:source",
      "command:base",
      created.workingHead,
      "Base",
    );
    store.forkContext("context:source", "context:target");
    const baseRoot = store.stateRoot(base);
    const repository = store.facts.repositoryAtPath(
      baseRoot,
      "packages/fixture",
    );
    if (!repository || repository.presence !== "present")
      throw new Error("missing repository");
    const file = store.facts.fileAtPath(
      baseRoot,
      repository.repositoryId,
      "index.ts",
    );
    if (!file || file.state.presence !== "placed")
      throw new Error("missing file");

    const sourceDispatch = acknowledgeRead(
      await semantic.dispatch("edit", {
        ingress,
        input: {
          contextId: "context:source",
          commandId: "command:source",
          expectedWorkingHead: base,
          changes: [
            {
              kind: "text-edit",
              repositoryId: repository.repositoryId,
              fileId: file.state.fileId,
              edits: [{ start: 0, end: 4, text: "theirs" }],
            },
          ],
        },
      }),
    );
    const sourceEdit = pending<{
      workingHead: { kind: "application"; applicationId: string };
      changeIds: string[];
    }>(sourceDispatch);
    acknowledge(sourceDispatch);
    const source = await commit(
      "context:source",
      "command:source-commit",
      sourceEdit.workingHead,
      "Source",
    );

    const targetDispatch = acknowledgeRead(
      await semantic.dispatch("edit", {
        ingress,
        input: {
          contextId: "context:target",
          commandId: "command:target",
          expectedWorkingHead: base,
          changes: [
            {
              kind: "text-edit",
              repositoryId: repository.repositoryId,
              fileId: file.state.fileId,
              edits: [{ start: 0, end: 4, text: "ours" }],
            },
          ],
        },
      }),
    );
    const sharedTarget = pending<{
      workingHead: { kind: "application"; applicationId: string };
      changeIds: string[];
    }>(targetDispatch);
    acknowledge(targetDispatch);
    store.forkContext("context:target", "context:target-theirs");

    const merge = async (
      contextId: string,
      commandId: string,
      resolution: "ours" | "theirs",
    ): Promise<{
      event: { kind: "event"; eventId: string };
      workingHead: { kind: "application"; applicationId: string };
    }> => {
      const dispatch = acknowledgeRead(
        await semantic.dispatch("merge", {
          ingress,
          input: {
            contextId,
            commandId,
            expectedWorkingHead: sharedTarget.workingHead,
            source: { kind: "event", eventId: source.eventId },
            resolutions: [
              {
                coordinate: { kind: "file", id: file.state.fileId },
                resolution,
              },
            ],
          },
        }),
      );
      const result = pending<{
        workingHead: { kind: "application"; applicationId: string };
      }>(dispatch);
      acknowledge(dispatch);
      return {
        event: await commit(
          contextId,
          `${commandId}-commit`,
          result.workingHead,
          resolution,
        ),
        workingHead: result.workingHead,
      };
    };
    const ours = await merge("context:target", "command:merge-ours", "ours");
    const theirs = await merge(
      "context:target-theirs",
      "command:merge-theirs",
      "theirs",
    );
    const oursFile = store.facts.file(
      store.stateRoot(ours.event),
      file.state.fileId,
    );
    const theirsFile = store.facts.file(
      store.stateRoot(theirs.event),
      file.state.fileId,
    );
    if (!oursFile || oursFile.state.presence !== "placed")
      throw new Error("missing ours file");
    if (!theirsFile || theirsFile.state.presence !== "placed")
      throw new Error("missing theirs file");
    expect(oursFile.state.contentHash).toBe(contentHash("ours\n"));
    expect(theirsFile.state.contentHash).toBe(contentHash("theirs\n"));
    const forward = acknowledgeRead(
      await semantic.dispatch("compare", {
        ingress,
        input: {
          target: ours.event,
          source: {
            kind: "application",
            applicationId: theirs.workingHead.applicationId,
          },
          limit: 100,
        },
      }),
    );
    expect(forward).toMatchObject({
      kind: "complete",
      result: {
        counts: { conflict: 1 },
        coordinates: [{ coordinate: { kind: "file", id: file.state.fileId } }],
      },
    });
    const reverse = acknowledgeRead(
      await semantic.dispatch("compare", {
        ingress,
        input: {
          target: theirs.event,
          source: {
            kind: "application",
            applicationId: ours.workingHead.applicationId,
          },
          limit: 100,
        },
      }),
    );
    expect(reverse).toMatchObject({
      kind: "complete",
      result: {
        counts: { conflict: 1 },
        coordinates: [{ coordinate: { kind: "file", id: file.state.fileId } }],
      },
    });

    store.forkContext("context:target", "context:review");
    const eventMerge = acknowledgeRead(
      await semantic.dispatch("merge", {
        ingress,
        input: {
          contextId: "context:review",
          commandId: "command:merge-integrations",
          expectedWorkingHead: ours.event,
          source: { kind: "event", eventId: theirs.event.eventId },
        },
      }),
    );
    const integrated = pending<{
      status: "working";
      workingHead: { kind: "application"; applicationId: string };
    }>(eventMerge);
    const integratedFile = store.facts.file(
      store.stateRoot(integrated.workingHead),
      file.state.fileId,
    );
    if (!integratedFile || integratedFile.state.presence !== "placed") {
      throw new Error("missing integrated file");
    }
    expect(integratedFile.state.contentHash).toBe(contentHash("ours\n"));
    const integratedComparison = acknowledgeRead(
      await semantic.dispatch("compare", {
        ingress,
        input: {
          target: base,
          source: {
            kind: "application",
            applicationId: integrated.workingHead.applicationId,
          },
          limit: 100,
        },
      }),
    );
    expect(integratedComparison).toMatchObject({
      kind: "complete",
      result: {
        coordinates: [
          {
            attribution: {
              theirs: [
                expect.objectContaining({
                  changeId: sharedTarget.changeIds[0],
                }),
              ],
            },
          },
        ],
      },
    });
    acknowledge(eventMerge);
  });
});
