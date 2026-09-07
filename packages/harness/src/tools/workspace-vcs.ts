/** Compact agent workflow over the canonical semantic VCS methods. */

import { Type } from "@sinclair/typebox";
import { canonicalJson, sha256HexSyncText } from "@vibestudio/content-addressing";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";
import type {
  VcsBlameInput,
  VcsCommitResult,
  VcsCompareInput,
  VcsDiscardResult,
  VcsMergeSource,
  VcsSemanticNodeRef,
  VcsStatusResult,
  VcsWorkingMutationResult,
} from "@vibestudio/service-schemas/vcs";
import { driveMerge, renderCompareReview, renderMergeReview } from "../merge-driver.js";
import { resolveToolFile } from "../semantic-file-resolution.js";
import { base64ToBytes } from "./portable-bytes.js";
import {
  AgentReferenceUnavailableError,
  agentReferenceSchema,
  createMemoryAgentReferenceStore,
  isAgentReference,
  loadAgentReference,
  type AgentReferenceStore,
} from "./agent-pagination.js";
import {
  loadProvenanceReference,
  putProvenanceReference,
} from "./provenance-reference.js";
import { PROVENANCE_REF_FOOTER } from "./render-budget.js";
import {
  resolveToolWorkingState,
  toVcsPath,
  toolCommandId,
  toolContextId,
  type ToolVcs,
  type ToolMutationContext,
} from "./tool-vcs.js";

const coordinateSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("file"), id: Type.String({ minLength: 1 }) },
    { additionalProperties: false }
  ),
  Type.Object(
    { kind: Type.Literal("repository"), id: Type.String({ minLength: 1 }) },
    { additionalProperties: false }
  ),
]);

const workspaceVcsSchema = Type.Union([
  Type.Object({ operation: Type.Literal("status") }, { additionalProperties: false }),
  Type.Object(
    {
      operation: Type.Literal("compare"),
      contextId: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Exact retained workspace context returned by another operation; omit to use the current task context.",
        })
      ),
      source: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Incoming committed event, external delta, or compact semantic @ref; omit when view is local.",
        })
      ),
      view: Type.Optional(
        Type.Literal("local", {
          description:
            "Compare the complete current working state, including uncommitted applications, against protected main; omit when source is present.",
        })
      ),
      status: Type.Optional(Type.Literal("conflict")),
      ref: Type.Optional(agentReferenceSchema),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      operation: Type.Literal("merge"),
      contextId: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Exact retained workspace context returned by another operation; omit to use the current task context.",
        })
      ),
      source: Type.String({
        minLength: 1,
        description: "Incoming committed event, external delta, or compact semantic @ref.",
      }),
      coordinates: Type.Optional(Type.Array(coordinateSchema, { maxItems: 500 })),
      resolutions: Type.Optional(
        Type.Union([
          Type.Array(
            Type.Object(
              {
                coordinate: coordinateSchema,
                resolution: Type.Union([
                  Type.Literal("composed"),
                  Type.Literal("theirs"),
                  Type.Literal("ours"),
                  Type.Literal("current"),
                ]),
                rationale: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
              },
              { additionalProperties: false }
            ),
            { maxItems: 500 }
          ),
          Type.Object(
            {
              allRemaining: Type.Object(
                {
                  resolution: Type.Union([Type.Literal("ours"), Type.Literal("current")]),
                  rationale: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
                },
                { additionalProperties: false }
              ),
            },
            { additionalProperties: false }
          ),
        ])
      ),
      intent: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      operation: Type.Literal("revert"),
      changeIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 200 }),
      intent: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      operation: Type.Literal("commit"),
      message: Type.String({
        minLength: 1,
        description: "Durable intent summary for the one atomic workspace event.",
      }),
      intent: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false }
  ),
  Type.Object({ operation: Type.Literal("discard") }, { additionalProperties: false }),
  Type.Object(
    {
      operation: Type.Literal("blame"),
      path: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Managed file path. Required to start blame; omit when ref is present.",
        })
      ),
      start: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "Zero-based UTF-16 content offset (byte offset for binary); omit start and end to blame the full file. This is not a line number.",
        })
      ),
      end: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "Exclusive zero-based UTF-16 content offset (byte offset for binary); omit start and end to blame the full file. This is not a line number.",
        })
      ),
      ref: Type.Optional(agentReferenceSchema),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    },
    { additionalProperties: false }
  ),
  Type.Object({ operation: Type.Literal("push") }, { additionalProperties: false }),
]);

export type WorkspaceVcsToolInput =
  | { operation: "status" }
  | {
      operation: "compare";
      contextId?: string;
      source?: string;
      view?: "local";
      status?: "conflict";
      ref?: string;
      limit?: number;
    }
  | {
      operation: "merge";
      contextId?: string;
      source: string;
      coordinates?: Array<{ kind: "file" | "repository"; id: string }>;
      resolutions?:
        | Array<{
            coordinate: { kind: "file" | "repository"; id: string };
            resolution: "composed" | "theirs" | "ours" | "current";
            rationale?: string;
          }>
        | { allRemaining: { resolution: "ours" | "current"; rationale?: string } };
      intent?: string;
    }
  | { operation: "revert"; changeIds: string[]; intent?: string }
  | { operation: "commit"; message: string; intent?: string }
  | { operation: "discard" }
  | {
      operation: "blame";
      path?: string;
      start?: number;
      end?: number;
      ref?: string;
      limit?: number;
    }
  | { operation: "push" };

export interface WorkspaceVcsToolDetails {
  operation: WorkspaceVcsToolInput["operation"];
  result: unknown;
  status?: VcsStatusResult;
  roots?: VcsSemanticNodeRef[];
}

export type ToolWorkflowVcs = Pick<
  ToolVcs,
  | "status"
  | "compare"
  | "merge"
  | "revert"
  | "commit"
  | "discard"
  | "blame"
  | "push"
  | "resolveRepository"
  | "readFile"
>;

/**
 * Mutation results name their subjects with compact refs, never with the
 * content-addressed identities the model would have to transcribe. The refs
 * are the same ones `provenance` issues, so either tool accepts them back.
 */
function mutationText(
  verb: string,
  result: VcsWorkingMutationResult,
  references: AgentReferenceStore
): string {
  const changeRefs = (ids: readonly string[]): string =>
    ids
      .slice(0, 10)
      .map((changeId) => putProvenanceReference(references, { kind: "change", changeId }, 5))
      .join(" ");
  return (
    `${verb} · work unit ${putProvenanceReference(references, { kind: "work-unit", workUnitId: result.workUnitId }, 5)} · ` +
    `${result.changeCount} authored and ${result.incorporatedChangeCount} incorporated changes ` +
    `(${result.changeIds.length} authored and ${result.incorporatedChangeIds.length} incorporated in preview).` +
    (result.changeIds.length > 0 ? ` Authored: ${changeRefs(result.changeIds)}.` : "") +
    (result.incorporatedChangeIds.length > 0
      ? ` Incorporated: ${changeRefs(result.incorporatedChangeIds)}.`
      : "") +
    `\n${PROVENANCE_REF_FOOTER}`
  );
}

/** A change selector is either a compact ref or an exact identity. */
function resolveChangeSelector(selector: string, references: AgentReferenceStore): string {
  if (!isAgentReference(selector)) return selector;
  const root = loadProvenanceReference(references, selector).root;
  if (root.kind !== "change") {
    throw new Error(`Reference ${selector} is a ${root.kind}, not a change`);
  }
  return root.changeId;
}

interface VcsCompareReference {
  basis: Omit<VcsCompareInput, "cursor">;
  page: number;
  cursor: string;
}

interface VcsBlameReference {
  basis: VcsBlameInput;
  page: number;
  cursor: string;
}

function publicCompareResult(
  result: Awaited<ReturnType<ToolWorkflowVcs["compare"]>>,
  page: number,
  continuationRef: string | null
) {
  return {
    page,
    resolution: result.resolution,
    counts: result.counts,
    intentCounts: result.intentCounts,
    coordinateCount: result.coordinates.length,
    intentsTruncated: result.intentsTruncated,
    continuation: continuationRef
      ? { operation: "compare" as const, ref: continuationRef }
      : null,
  };
}

function publicBlameResult(
  result: Awaited<ReturnType<ToolWorkflowVcs["blame"]>>,
  page: number,
  continuationRef: string | null
) {
  return {
    page,
    coordinateKind: result.coordinateKind,
    spanCount: result.spans.length,
    continuation: continuationRef ? { operation: "blame" as const, ref: continuationRef } : null,
  };
}

function unavailableReferenceResult(
  operation: "compare" | "blame",
  ref: string
): AgentToolResult<WorkspaceVcsToolDetails> {
  return resultOf(
    operation,
    `${operation} reference ${ref} is unavailable, expired, or belongs to another operation. Start again with the ordinary ${operation} selectors.`,
    { status: "reference-unavailable", ref }
  );
}

function sourceFromSelector(
  references: AgentReferenceStore,
  selector: string
): VcsMergeSource | null {
  if (isAgentReference(selector)) {
    try {
      const root = loadProvenanceReference(references, selector).root;
      if (root.kind === "event") return { kind: "event", eventId: root.eventId };
      if (root.kind === "external-delta") {
        return { kind: "external-delta", deltaId: root.deltaId };
      }
      return null;
    } catch (error) {
      if (error instanceof AgentReferenceUnavailableError) return null;
      throw error;
    }
  }
  if (selector.startsWith("event:") || selector.startsWith("workspace-event:")) {
    return { kind: "event", eventId: selector };
  }
  if (selector.startsWith("external-delta:")) {
    return { kind: "external-delta", deltaId: selector };
  }
  return null;
}

function invalidSourceResult(operation: "compare" | "merge", source: string) {
  return resultOf(
    operation,
    `Source ${source} is not an available event or external delta. Pass an exact returned identity or compact semantic @ref unchanged.`,
    { status: "invalid-source", source }
  );
}

function invalidRequestResult(
  operation: "compare" | "blame" | "commit",
  message: string,
  recovery: Record<string, unknown>
) {
  return resultOf(operation, message, { status: "invalid-request", recovery });
}

export function createWorkspaceVcsTool(
  cwd: string,
  vcs: ToolWorkflowVcs,
  context: ToolMutationContext,
  references: AgentReferenceStore = createMemoryAgentReferenceStore()
): AgentTool<typeof workspaceVcsSchema, WorkspaceVcsToolDetails> {
  return {
    name: "vcs",
    label: "vcs",
    description:
      "Review and change semantic workspace state: status, compare intent and coordinate net effects (use compare view:'local' for working state relative to protected main), merge, revert, commit, discard, blame, or push. Use provenance for semantic roots and graph adjacency. Start compare and blame with ordinary selectors; continue by copying the complete advertised call containing only operation and ref. Exact selectors, page geometry, and opaque VCS cursors stay internal. Browse and edit ordinary paths with the dedicated filesystem tools.",
    parameters: workspaceVcsSchema,
    cancellationMode: "settle",
    execute: async (
      _toolCallId,
      input,
      signal
    ): Promise<AgentToolResult<WorkspaceVcsToolDetails>> => {
      if (signal?.aborted) throw new Error("Operation aborted");
      const contextId = toolContextId(context);
      // AgentTool invokes execute only after validating the TypeBox union.
      const command = input as WorkspaceVcsToolInput;

      if (command.operation === "status") {
        const result = await vcs.status({ contextId });
        const integrationText = result.integrating
          .map((entry) => {
            const source =
              entry.source.kind === "event" ? entry.source.eventId : entry.source.deltaId;
            const state =
              entry.remainingCoordinateCount === 0 && entry.concluded
                ? "complete"
                : entry.mergeableCoordinateCount > 0
                  ? "integrating"
                  : "needs-decision";
            const consequence = entry.stale
              ? "snapshot is stale; commit will revalidate exactly"
              : state === "complete"
                ? "ready to commit"
                : "commit will refuse until complete";
            return `${state} ${entry.source.kind}:${source} — ${entry.remainingCoordinateCount} coordinates unaccounted, ${entry.conflictCoordinateCount} conflicts; ${consequence}`;
          })
          .join("\n");
        return resultOf(
          command.operation,
          `Context ${contextId} is ${result.clean ? "clean" : "dirty"}; ` +
            `${result.mainRelation} main at ${result.mainEventId}; committed ${stateLabel(result.committed)}; ` +
            `working ${stateLabel(result.workingHead)} (${result.workingCounts.applications} applications, ` +
            `${result.workingCounts.changes} changes).` +
            (integrationText ? `\n${integrationText}` : ""),
          result
        );
      }

      if (command.operation === "compare") {
        const suppliedSelectorCount =
          Number(command.view === "local") + Number(command.source !== undefined);
        if (command.ref && suppliedSelectorCount > 0) {
          return resultOf(
            command.operation,
            "Compare continuation accepts the advertised ref alone; do not repeat source selectors.",
            { status: "invalid-request", recovery: { operation: "compare", ref: command.ref } }
          );
        }
        let basis: Omit<VcsCompareInput, "cursor">;
        let page = 1;
        let cursor: string | undefined;
        if (command.ref) {
          if (
            command.contextId !== undefined ||
            command.status !== undefined ||
            command.limit !== undefined
          ) {
            return resultOf(
              command.operation,
              "Compare continuation accepts the advertised ref alone; do not repeat context, filters, or limits.",
              { status: "invalid-request", recovery: { operation: "compare", ref: command.ref } }
            );
          }
          try {
            const retained = loadAgentReference<VcsCompareReference>(
              references,
              "vcs-compare",
              command.ref
            );
            basis = retained.basis;
            page = retained.page;
            cursor = retained.cursor;
          } catch (error) {
            if (error instanceof AgentReferenceUnavailableError) {
              return unavailableReferenceResult(command.operation, command.ref);
            }
            throw error;
          }
        } else {
          if (suppliedSelectorCount !== 1) {
            return invalidRequestResult(
              command.operation,
              "Compare requires exactly one starting selector: view:'local' or source. Continue only with the advertised ref.",
              { operation: "compare", selectors: ["view", "source", "ref"] }
            );
          }
          const selectedContextId = command.contextId ?? contextId;
          const localView = command.view === "local";
          const status = localView ? await vcs.status({ contextId: selectedContextId }) : null;
          const target = localView
            ? ({ kind: "event", eventId: status!.mainEventId } as const)
            : await resolveToolWorkingState(vcs, { contextId: selectedContextId });
          const source = command.source
            ? sourceFromSelector(references, command.source)
            : status!.workingHead;
          if (!source) return invalidSourceResult(command.operation, command.source!);
          basis = {
            target,
            source,
            ...(command.status ? { statusFilter: command.status } : {}),
            limit: command.limit ?? 100,
          };
        }
        {
          const result = await vcs.compare({ ...basis, ...(cursor ? { cursor } : {}) });
          const review = renderCompareReview({ ...result, nextCursor: null });
          const continuationRef = result.nextCursor
            ? references.put("vcs-compare", {
                basis,
                page: page + 1,
                cursor: result.nextCursor,
              } satisfies VcsCompareReference)
            : null;
          const continuation = continuationRef
            ? `\nMore coordinates: vcs({"operation":"compare","ref":"${continuationRef}"}).`
            : "";
          return resultOf(
            command.operation,
            `${command.view === "local" ? "Local working state relative to protected main.\n" : ""}${review}${continuation}`,
            publicCompareResult(result, page, continuationRef)
          );
        }
      }

      if (command.operation === "merge") {
        const selectedContextId = command.contextId ?? contextId;
        const source = sourceFromSelector(references, command.source);
        if (!source) return invalidSourceResult(command.operation, command.source);
        const expectedWorkingHead = await resolveToolWorkingState(vcs, {
          contextId: selectedContextId,
        });
        const baseCommandId = toolCommandId(context);
        const driven = await driveMerge({
          vcs,
          contextId: selectedContextId,
          expectedWorkingHead,
          source,
          ...(command.coordinates ? { coordinates: command.coordinates } : {}),
          ...(command.resolutions ? { resolutions: command.resolutions } : {}),
          ...(command.intent ? { intentSummary: command.intent } : {}),
          headline: `Merge ${command.source}`,
          commandIdForPage: ({ expectedWorkingHead: pageHead }) =>
            `${baseCommandId}:merge:${sha256HexSyncText(canonicalJson({ contextId: selectedContextId, expectedWorkingHead: pageHead, source, coordinates: command.coordinates, resolutions: command.resolutions, intentSummary: command.intent }))}`,
        });
        const publicReview = { ...driven.review, nextConflictCursor: null };
        const compareRef = driven.review.nextConflictCursor
          ? references.put("vcs-compare", {
              basis: {
                target: driven.workingHead,
                source,
                statusFilter: "conflict",
                limit: 100,
              },
              page: 2,
              cursor: driven.review.nextConflictCursor,
            } satisfies VcsCompareReference)
          : null;
        const continuation = compareRef
          ? `\nMore conflicts: vcs({"operation":"compare","ref":"${compareRef}"}).`
          : "";
        return resultOf(command.operation, `${renderMergeReview(publicReview)}${continuation}`, {
          status: driven.status,
          resolution: publicReview.resolution,
          counts: publicReview.counts,
          intentCount: publicReview.intents.length,
          intentsTruncated: publicReview.intentsTruncated,
          composedCount: publicReview.composed.length,
          conflictCount: publicReview.conflicts.length,
          continuation: compareRef ? { operation: "compare", ref: compareRef } : null,
        });
      }

      if (command.operation === "revert") {
        const expectedWorkingHead = await resolveToolWorkingState(vcs, context);
        const result = await vcs.revert({
          contextId,
          expectedWorkingHead,
          commandId: toolCommandId(context),
          changeIds: command.changeIds.map((selector) =>
            resolveChangeSelector(selector, references)
          ),
          ...(command.intent ? { intentSummary: command.intent } : {}),
        });
        return resultOf(
          command.operation,
          mutationText("Reverted semantic changes", result, references),
          result
        );
      }

      if (command.operation === "commit") {
        const message = command.message.trim();
        if (!message) {
          return invalidRequestResult(
            command.operation,
            "Commit requires a non-empty durable intent summary.",
            { operation: "commit", field: "message" }
          );
        }
        const expectedWorkingHead = await resolveToolWorkingState(vcs, context);
        let result: VcsCommitResult;
        try {
          result = await vcs.commit({
            contextId,
            expectedWorkingHead,
            commandId: toolCommandId(context),
            message,
            ...(command.intent ? { intentSummary: command.intent } : {}),
          });
        } catch (error) {
          const failure = error as {
            code?: unknown;
            errorData?: { code?: unknown; source?: { kind?: unknown; eventId?: unknown } };
          };
          const source = failure.errorData?.source;
          if (
            (failure.code === "IntegrationIncomplete" ||
              failure.errorData?.code === "IntegrationIncomplete") &&
            source?.kind === "event" &&
            typeof source.eventId === "string"
          ) {
            const run = context.integrationSourceResolver?.(source.eventId);
            if (run) {
              const message =
                `Integration of subagent ${run.runId} is incomplete. ` +
                `Call merge_subagent({runId:"${run.runId}", resolutions:{allRemaining:{resolution:"ours"}}}) to decline the remainder, ` +
                `or merge_subagent({runId:"${run.runId}", resolutions:{allRemaining:{resolution:"current", rationale:"…"}}}) after reviewing the combined parent state.`;
              throw Object.assign(new Error(message), {
                code: "IntegrationIncomplete",
                errorData: {
                  ...failure.errorData,
                  code: "IntegrationIncomplete",
                  runId: run.runId,
                  recoveryTool: "merge_subagent",
                },
              });
            }
          }
          throw error;
        }
        if (result.event.kind !== "event") throw new Error("vcs commit returned a non-event state");
        const status = await vcs.status({ contextId });
        if (
          !status.clean ||
          status.committed.kind !== "event" ||
          status.committed.eventId !== result.event.eventId ||
          status.workingHead.kind !== "event" ||
          status.workingHead.eventId !== result.event.eventId
        ) {
          throw new Error("vcs commit did not leave the context clean at the committed event");
        }
        context.onIntegrationSourcesCommitted?.(result);
        return {
          content: [
            {
              type: "text",
              text:
                `Committed workspace event ${result.event.eventId} locally with ` +
                `${result.committedApplicationIds.length} application${result.committedApplicationIds.length === 1 ? "" : "s"}; ` +
                "the context is clean at that event. Protected main was not changed; publication is a separate vcs push operation.",
            },
          ],
          details: { operation: command.operation, result, status },
        };
      }

      if (command.operation === "discard") {
        const expectedWorkingHead = await resolveToolWorkingState(vcs, context);
        const result: VcsDiscardResult = await vcs.discard({
          contextId,
          expectedWorkingHead,
          commandId: toolCommandId(context),
        });
        return resultOf(
          command.operation,
          `Discarded ${result.discardedApplicationIds.length} local application${result.discardedApplicationIds.length === 1 ? "" : "s"}; working state is now ${stateLabel(result.workingHead)}.`,
          result
        );
      }

      if (command.operation === "blame") {
        if (
          command.ref &&
          (command.path !== undefined ||
            command.start !== undefined ||
            command.end !== undefined ||
            command.limit !== undefined)
        ) {
          return resultOf(
            command.operation,
            "Blame continuation accepts the advertised ref alone; do not repeat the path, range, or limit.",
            { status: "invalid-request", recovery: { operation: "blame", ref: command.ref } }
          );
        }
        let basis: VcsBlameInput;
        let page = 1;
        let cursor: string | undefined;
        if (command.ref) {
          try {
            const retained = loadAgentReference<VcsBlameReference>(
              references,
              "vcs-blame",
              command.ref
            );
            basis = retained.basis;
            page = retained.page;
            cursor = retained.cursor;
          } catch (error) {
            if (error instanceof AgentReferenceUnavailableError) {
              return unavailableReferenceResult(command.operation, command.ref);
            }
            throw error;
          }
        } else {
          if (!command.path) {
            return invalidRequestResult(
              command.operation,
              "Blame requires a managed path to start, or the complete ref advertised by an earlier blame page.",
              { operation: "blame", field: "path" }
            );
          }
          const state = await resolveToolWorkingState(vcs, context);
          const workspacePath = toVcsPath(command.path, cwd);
          const file = await resolveToolFile(vcs, state, workspacePath);
          if (!file) {
            return invalidRequestResult(
              command.operation,
              `No managed file exists at ${command.path}.`,
              { operation: "blame", field: "path", path: command.path }
            );
          }
          const contentLength =
            file.content.kind === "text"
              ? file.content.text.length
              : base64ToBytes(file.content.base64).byteLength;
          const start = command.start ?? 0;
          const end = command.end ?? contentLength;
          if (end < start || end > contentLength) {
            return invalidRequestResult(
              command.operation,
              `Blame range ${start}..${end} is outside 0..${contentLength}.`,
              { operation: "blame", range: { start: 0, end: contentLength } }
            );
          }
          basis = {
            state,
            repositoryId: file.repositoryId,
            fileId: file.fileId,
            range: { start, end },
            limit: command.limit ?? 100,
          };
        }
        {
          const result = await vcs.blame({ ...basis, ...(cursor ? { cursor } : {}) });
          const lines = result.spans.map((span) => {
            const changeRef = putProvenanceReference(references, span.change, 5);
            const appliedChangeRef = putProvenanceReference(references, span.appliedChange, 5);
            const workRef = putProvenanceReference(references, span.workUnit, 5);
            const commandRef = putProvenanceReference(references, span.command, 5);
            return (
              `${span.start}..${span.end} · ${span.stop} · ${span.tier} · ` +
              `change ${changeRef} · applied ${appliedChangeRef} · ` +
              `work ${workRef} · command ${commandRef}` +
              (span.stop === "import-boundary"
                ? " · import boundary: the owning import work carries the external snapshot; earlier coordinate authorship is unknown"
                : "")
            );
          });
          const continuationRef = result.nextCursor
            ? references.put("vcs-blame", {
                basis,
                page: page + 1,
                cursor: result.nextCursor,
              } satisfies VcsBlameReference)
            : null;
          if (continuationRef) lines.push(`more spans → ${continuationRef}`);
          if (lines.length > 0) lines.push(PROVENANCE_REF_FOOTER);
          return resultOf(
            command.operation,
            lines.join("\n") || "No blame spans for the requested range",
            publicBlameResult(result, page, continuationRef)
          );
        }
      }

      if (command.operation !== "push") {
        throw new Error("Unsupported vcs operation");
      }
      const status = await vcs.status({ contextId });
      if (status.committed.kind !== "event") throw new Error("Committed state is not an event");
      const result = await vcs.push({
        commandId: toolCommandId(context),
        contextId,
        expectedCommittedEventId: status.committed.eventId,
        expectedMainEventId: status.mainEventId,
      });
      return resultOf(
        command.operation,
        `Published ${result.eventId} as protected main ${result.mainEventId}.`,
        result
      );
    },
  };
}

function stateLabel(
  state: { kind: "event"; eventId: string } | { kind: "application"; applicationId: string }
) {
  return state.kind === "event" ? state.eventId : state.applicationId;
}

function resultOf(
  operation: WorkspaceVcsToolInput["operation"],
  text: string,
  result: unknown
): AgentToolResult<WorkspaceVcsToolDetails> {
  return {
    content: [{ type: "text", text }],
    details: { operation, result },
  };
}
