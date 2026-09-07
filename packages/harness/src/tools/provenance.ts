/** Friendly graph-walking tool over the canonical `vcs.neighbors` primitive. */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import { vcsSemanticNodeRefSchema, type VcsSemanticNodeRef } from "@vibestudio/service-schemas/vcs";
import { splitRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import type { ToolVcs } from "./tool-vcs.js";
import { resolveToolFile } from "../semantic-file-resolution.js";
import {
  AgentReferenceUnavailableError,
  createMemoryAgentReferenceStore,
  isAgentReference,
  type AgentReferenceStore,
} from "./agent-pagination.js";
import {
  loadProvenanceReference,
  putProvenanceReference,
} from "./provenance-reference.js";
import { resolveToolWorkingState, toVcsPath } from "./tool-vcs.js";
import {
  provenancePageStreams,
  renderInspectionBatch,
  renderProvenanceBlock,
  renderQueryBlock,
  renderSearchBlock,
  renderWalkBlock,
  type CanonicalProvenanceHistory,
  type CanonicalProvenanceInspection,
  type CanonicalProvenanceResult,
  type NodeReference,
} from "./provenance-format.js";

const ORIENTATION_EDGE_LIMIT = 5;
/** Default page sizes for the question-shaped surfaces. */
const WALK_ENTRY_LIMIT = 50;
const QUERY_ROW_LIMIT = 50;
const SEARCH_HIT_LIMIT = 10;

class InvalidProvenanceTargetError extends Error {}

const provenanceSchema = Type.Object(
  {
    target: Type.Optional(
      Type.String({
        description:
          'Friendly selector: an existing managed file path (not an intermediate directory), exact repository root, "session", a returned compact @ref, "search: some words" to find subjects by their recorded prose, or a semantic shorthand such as "workspace-event:...", "change:...", or "decision:...". A service, tool, package name, or general topic is not a target.',
      })
    ),
    targets: Type.Optional(
      Type.Array(Type.String(), {
        maxItems: 10,
        description:
          "Up to ten returned @refs to expand together under one header. Use this instead of ten separate calls.",
      })
    ),
    walk: Type.Optional(
      Type.Union(
        [Type.Literal("cause"), Type.Literal("cohort"), Type.Literal("rejections")],
        {
          description:
            'Named multi-hop traversal. "cause": from this subject up to the originating human statement. "cohort": everything else the same work touched. "rejections": what was tried here and undone, and why.',
        }
      )
    ),
    scope: Type.Optional(
      Type.Union(
        [Type.Literal("work-unit"), Type.Literal("command"), Type.Literal("turn")],
        {
          description:
            'Cohort breadth; defaults to "turn", the unit that matches one request. Narrow to "command" or "work-unit" when the turn is too broad.',
        }
      )
    ),
    query: Type.Optional(
      Type.String({
        description:
          "One read-only SELECT over the prov_* views. Start from `SELECT relation, meaning, columns FROM prov_schema` — one row per relation, so the whole contract arrives in a single page. A returned @ref may be used as a value; trusted code binds it to the exact identity.",
      })
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Preferred entries per page. Values above the surface bound are safely clamped. Omit it when following a returned reference because the reference retains the page geometry.",
      })
    ),
  },
  {
    additionalProperties: false,
    description:
      "Name your question, then use its mechanism: walk for causes, cohorts, and rejections; query for set-shaped questions; a search: target when you cannot name the subject; a bare target to inspect one subject. Pass returned compact @refs back through target or targets. A continuation ref is complete: do not add a cursor or page.",
  }
);

export type ProvenanceToolInput = Static<typeof provenanceSchema>;
export interface ProvenanceToolDetails {
  target: string;
  ref: string;
  subjectKind: VcsSemanticNodeRef["kind"];
  adjacencyCount?: number;
  historyCount?: number;
  walk?: "cause" | "cohort" | "rejections";
  entryCount?: number;
  rowCount?: number;
  hitCount?: number;
  inspectedCount?: number;
  refused?: string | null;
  limit: number;
  continuations: Array<
    { target: string; kind: "adjacency" | "file-history" }
  >;
}

export interface ProvenanceInvalidTargetDiagnostic {
  diagnostic: "invalid-target";
  target: string;
  acceptedTargets: readonly [
    "session",
    "managed repository or file path",
    "event/application/applied-change/work-unit/change/decision/command identity",
    "compact ref returned by provenance",
  ];
}

export type ProvenanceToolDiagnostic = ProvenanceInvalidTargetDiagnostic;

export interface WorkspacePathProvenanceDeps {
  vcs: Pick<ToolVcs, "status" | "resolveRepository" | "neighbors" | "inspect" | "readFile">;
  contextId: string | (() => string);
  session: { logId: string; head: string };
}

export interface ProvenanceToolDeps {
  vcs: Pick<
    ToolVcs,
    | "status"
    | "resolveRepository"
    | "neighbors"
    | "inspect"
    | "readFile"
    | "history"
    | "walk"
    | "query"
    | "search"
  >;
  contextId: string | (() => string);
  session: { logId: string; head: string };
}

/** The one identity a node carries, for binding `@ref`s into query text. */
function nodeIdentity(node: VcsSemanticNodeRef): string | null {
  switch (node.kind) {
    case "work-unit":
      return node.workUnitId;
    case "change":
      return node.changeId;
    case "applied-change":
      return node.appliedChangeId;
    case "application":
      return node.applicationId;
    case "event":
      return node.eventId;
    case "decision":
      return node.decisionId;
    case "command":
      return node.commandId;
    case "external-delta":
      return node.deltaId;
    case "file":
      return node.fileId;
    case "repository":
      return node.repositoryId;
    case "trajectory-message":
      return node.messageId;
    case "trajectory-turn":
      return node.turnId;
    case "trajectory-invocation":
      return node.invocationId;
    case "trajectory":
      return node.logId;
  }
}

const IDENTITY_COLUMN_NODES: Record<string, (value: string) => VcsSemanticNodeRef> = {
  work_unit_id: (workUnitId) => ({ kind: "work-unit", workUnitId }),
  change_id: (changeId) => ({ kind: "change", changeId }),
  counteracted_change_id: (changeId) => ({ kind: "change", changeId }),
  result_change_id: (changeId) => ({ kind: "change", changeId }),
  last_change_id: (changeId) => ({ kind: "change", changeId }),
  applied_change_id: (appliedChangeId) => ({ kind: "applied-change", appliedChangeId }),
  child_applied_change_id: (appliedChangeId) => ({ kind: "applied-change", appliedChangeId }),
  parent_applied_change_id: (appliedChangeId) => ({ kind: "applied-change", appliedChangeId }),
  application_id: (applicationId) => ({ kind: "application", applicationId }),
  event_id: (eventId) => ({ kind: "event", eventId }),
  parent_event_id: (eventId) => ({ kind: "event", eventId }),
  source_event_id: (eventId) => ({ kind: "event", eventId }),
  decision_id: (decisionId) => ({ kind: "decision", decisionId }),
  command_id: (commandId) => ({ kind: "command", commandId }),
  delta_id: (deltaId) => ({ kind: "external-delta", deltaId }),
  source_delta_id: (deltaId) => ({ kind: "external-delta", deltaId }),
};

const POLYMORPHIC_IDENTITY_NODES: Partial<
  Record<VcsSemanticNodeRef["kind"], (value: string) => VcsSemanticNodeRef>
> = {
  "work-unit": (workUnitId) => ({ kind: "work-unit", workUnitId }),
  change: (changeId) => ({ kind: "change", changeId }),
  "applied-change": (appliedChangeId) => ({ kind: "applied-change", appliedChangeId }),
  application: (applicationId) => ({ kind: "application", applicationId }),
  event: (eventId) => ({ kind: "event", eventId }),
  decision: (decisionId) => ({ kind: "decision", decisionId }),
  command: (commandId) => ({ kind: "command", commandId }),
  "external-delta": (deltaId) => ({ kind: "external-delta", deltaId }),
};

const SELF_CONTAINED_IDENTITY_PREFIXES: ReadonlyArray<
  readonly [string, (value: string) => VcsSemanticNodeRef]
> = [
  ["workspace-event:", (eventId) => ({ kind: "event", eventId })],
  ["event:", (eventId) => ({ kind: "event", eventId })],
  ["external-delta:", (deltaId) => ({ kind: "external-delta", deltaId })],
  ["applied-change:", (appliedChangeId) => ({ kind: "applied-change", appliedChangeId })],
  ["application:", (applicationId) => ({ kind: "application", applicationId })],
  ["work-unit:", (workUnitId) => ({ kind: "work-unit", workUnitId })],
  ["change:", (changeId) => ({ kind: "change", changeId })],
  ["decision:", (decisionId) => ({ kind: "decision", decisionId })],
];

function queryIdentityNode(
  column: string,
  value: string,
  row: readonly (string | number | boolean | null)[],
  columns: readonly string[]
): VcsSemanticNodeRef | null {
  const fixed = IDENTITY_COLUMN_NODES[column];
  if (fixed) return fixed(value);

  const inferred = SELF_CONTAINED_IDENTITY_PREFIXES.find(
    ([prefix]) =>
      value.startsWith(prefix) && /^[0-9a-f]{32,}$/u.test(value.slice(prefix.length))
  );
  if (inferred) return inferred[1](value);
  if (!column.endsWith("_id")) return null;

  const kindColumn = `${column.slice(0, -"_id".length)}_kind`;
  const kindIndex = columns.indexOf(kindColumn);
  const kind = kindIndex >= 0 ? row[kindIndex] : null;
  if (typeof kind !== "string") return null;
  return POLYMORPHIC_IDENTITY_NODES[kind as VcsSemanticNodeRef["kind"]]?.(value) ?? null;
}

/**
 * Bind compact refs inside query text to their exact identities. The model
 * never transcribes a content-addressed identity in either direction: it pastes
 * back a ref it was given, and trusted code resolves it.
 */
export function bindQueryReferences(query: string, references: AgentReferenceStore): string {
  return query.replaceAll(/@r[0-9a-z]+-[0-9a-f]{4}/gu, (ref) => {
    const basis = loadProvenanceReference(references, ref);
    const identity = nodeIdentity(parseRoot(basis.root));
    if (identity === null) {
      throw new AgentReferenceUnavailableError(ref);
    }
    return identity;
  });
}

function contextIdOf(deps: WorkspacePathProvenanceDeps): string {
  return typeof deps.contextId === "function" ? deps.contextId() : deps.contextId;
}

function semanticRootForTarget(
  target: string,
  session: WorkspacePathProvenanceDeps["session"]
): VcsSemanticNodeRef {
  if (target.startsWith("event:") || target.startsWith("workspace-event:")) {
    return { kind: "event", eventId: target };
  }
  if (target.startsWith("application:")) return { kind: "application", applicationId: target };
  if (target.startsWith("applied-change:")) {
    return { kind: "applied-change", appliedChangeId: target };
  }
  if (target.startsWith("work-unit:")) return { kind: "work-unit", workUnitId: target };
  if (target.startsWith("change:")) return { kind: "change", changeId: target };
  if (target.startsWith("decision:")) return { kind: "decision", decisionId: target };
  if (target.startsWith("command:")) return { kind: "command", commandId: target };
  if (target === "session") return { kind: "trajectory", ...session };
  if (target.startsWith("trajectory")) {
    throw new Error(
      "Trajectory subnodes require the compact ref advertised by a preceding provenance result; do not reconstruct their composite identity"
    );
  }
  throw new Error(
    `Provenance target must be a workspace path, session, or event/application/applied-change/work-unit/change/decision/command identity; received ${target}`
  );
}

function invalidTargetResult(target: string, message: string) {
  const acceptedTargets = [
    "session",
    "managed repository or file path",
    "event/application/applied-change/work-unit/change/decision/command identity",
    "compact ref returned by provenance",
  ] as const;
  return {
    content: [
      {
        type: "text" as const,
        text: `${message}\nUse "session", an existing managed repository/file path, a semantic identity, or a compact ref returned by provenance. Service and tool names are not provenance targets.`,
      },
    ],
    details: {
      diagnostic: "invalid-target" as const,
      target,
      acceptedTargets,
    },
  };
}

function parseRoot(input: unknown): VcsSemanticNodeRef {
  const parsed = vcsSemanticNodeRefSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new Error(`Invalid typed semantic root: ${parsed.error.issues[0]?.message ?? "unknown"}`);
}

export async function neighborsForWorkspacePath(
  cwd: string,
  deps: WorkspacePathProvenanceDeps,
  rawPath: string,
  options: { cursor?: string; limit?: number } = {}
): Promise<{
  label: string;
  root: Extract<VcsSemanticNodeRef, { kind: "file" | "repository" }>;
  result: CanonicalProvenanceResult;
}> {
  const workspacePath = toVcsPath(rawPath, cwd);
  const workingHead = await resolveToolWorkingState(deps.vcs, {
    contextId: () => contextIdOf(deps),
  });
  const split = splitRepoPath(workspacePath);
  if (!split) throw new Error(`${workspacePath} is not inside a workspace repository`);
  if (!split.repoRelPath) {
    const repository = await deps.vcs.resolveRepository({
      state: workingHead,
      repoPath: split.repoPath,
    });
    if (!repository) {
      throw new InvalidProvenanceTargetError(
        `Repository ${split.repoPath} is not present in the working state`
      );
    }
    const root: Extract<VcsSemanticNodeRef, { kind: "repository" }> = {
      kind: "repository",
      state: workingHead,
      repositoryId: repository.repositoryId,
    };
    const result = await deps.vcs.neighbors({
      root,
      limit: options.limit ?? 10,
      ...(options.cursor ? { cursor: options.cursor } : {}),
    });
    return { label: workspacePath, root, result };
  }
  const file = await resolveToolFile(deps.vcs, workingHead, workspacePath);
  if (!file) {
    throw new InvalidProvenanceTargetError(
      `No file identity at ${workspacePath} in the working state. Provenance paths must name an existing managed file or an exact repository root; use ls for intermediate directories.`
    );
  }
  const root: Extract<VcsSemanticNodeRef, { kind: "file" }> = {
    kind: "file",
    state: workingHead,
    repositoryId: file.repositoryId,
    fileId: file.fileId,
  };
  const result = await deps.vcs.neighbors({
    root,
    limit: options.limit ?? 10,
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });
  return { label: workspacePath, root, result };
}

function toolResult(
  target: string,
  root: VcsSemanticNodeRef,
  inspection: CanonicalProvenanceInspection | undefined,
  result: CanonicalProvenanceResult,
  history: CanonicalProvenanceHistory | undefined,
  pages: { adjacency: number; fileHistory: number; limit: number },
  references: AgentReferenceStore
) {
  const streams = provenancePageStreams(pages);
  const ref = putProvenanceReference(references, root, pages.limit);
  const details: ProvenanceToolDetails = {
    target,
    ref,
    subjectKind: root.kind,
    limit: pages.limit,
    ...(streams.adjacency ? { adjacencyCount: result.edges.length } : {}),
    ...(streams.fileHistory && history ? { historyCount: history.entries.length } : {}),
    continuations: [
      ...(streams.adjacency && result.nextCursor
        ? [{
            target: putProvenanceReference(references, root, pages.limit, {
              stream: "adjacency",
              page: pages.adjacency + 1,
              cursor: result.nextCursor,
            }),
            kind: "adjacency" as const,
          }]
        : []),
      ...(streams.fileHistory && history?.nextCursor
        ? [{
            target: putProvenanceReference(references, root, pages.limit, {
              stream: "file-history",
              page: pages.fileHistory + 1,
              cursor: history.nextCursor,
            }),
            kind: "file-history" as const,
          }]
        : []),
    ],
  };
  return {
    content: [
      {
        type: "text" as const,
        text:
          renderProvenanceBlock({
            label: target,
            inspection,
            history,
            result,
            pages,
            reference: (root, continuation) =>
              putProvenanceReference(references, root, pages.limit, continuation),
          }) ?? `prov · ${target} · unavailable`,
      },
    ],
    details,
  };
}

async function loadProvenancePages(
  deps: ProvenanceToolDeps,
  root: VcsSemanticNodeRef,
  pages: { adjacency: number; fileHistory: number; limit: number },
  continuation?: { stream: "adjacency" | "file-history"; cursor: string },
  firstNeighbors?: CanonicalProvenanceResult
): Promise<{
  inspection: CanonicalProvenanceInspection | undefined;
  neighbors: CanonicalProvenanceResult;
  history: CanonicalProvenanceHistory | undefined;
}> {
  const fileRoot = root.kind === "file" ? root : undefined;
  const streams = provenancePageStreams(pages);
  const [inspection, neighbors, history] = await Promise.all([
    streams.inspection
      ? deps.vcs.inspect({ node: root, edgeLimit: 1 })
      : Promise.resolve(undefined),
    streams.adjacency
      ? firstNeighbors
        ? Promise.resolve(firstNeighbors)
        : deps.vcs.neighbors({
            root,
            limit: pages.limit,
            ...(continuation?.stream === "adjacency"
              ? { cursor: continuation.cursor }
              : {}),
          })
      : Promise.resolve({ root, edges: [], nextCursor: null }),
    streams.fileHistory && fileRoot
      ? deps.vcs.history({
          root: fileRoot,
          direction: "past",
          limit: pages.limit,
          ...(continuation?.stream === "file-history"
            ? { cursor: continuation.cursor }
            : {}),
        })
      : Promise.resolve(undefined),
  ]);
  return { inspection, neighbors, history };
}

/** Resolve any accepted target form to an exact typed root. */
async function rootForTarget(
  cwd: string,
  deps: ProvenanceToolDeps,
  references: AgentReferenceStore,
  target: string
): Promise<{ label: string; root: VcsSemanticNodeRef }> {
  if (isAgentReference(target)) {
    return { label: target, root: parseRoot(loadProvenanceReference(references, target).root) };
  }
  const path = target.startsWith("file:") ? target.slice(5) : target;
  if (splitRepoPath(path)) {
    const resolved = await neighborsForWorkspacePath(cwd, deps, path, { limit: 1 });
    return { label: resolved.label, root: resolved.root };
  }
  return { label: target, root: semanticRootForTarget(target, deps.session) };
}

export function createProvenanceTool(
  cwd: string,
  deps: ProvenanceToolDeps,
  references: AgentReferenceStore = createMemoryAgentReferenceStore()
): AgentTool<typeof provenanceSchema, ProvenanceToolDetails | ProvenanceToolDiagnostic> {
  const contextId = () => contextIdOf(deps);
  const reference: NodeReference = (root, continuation) =>
    putProvenanceReference(references, root, ORIENTATION_EDGE_LIMIT, continuation);
  return {
    name: "provenance",
    label: "provenance",
    executionMode: "parallel",
    description:
      'Answer a provenance question at the granularity of the question. walk: "cause" recovers what was being attempted, "cohort" what else happened under that intent, "rejections" what was tried here and undone. query runs one read-only SELECT over the prov_* views for set-shaped questions. A "search: words" target finds subjects you cannot name. A bare target inspects one subject and its immediate edges; targets expands up to ten refs at once. Exact roots, page geometry, and cursors stay inside trusted code — pass back the compact @refs you were given.',
    parameters: provenanceSchema,
    execute: async (_toolCallId, input) => {
      const pages = { adjacency: 1, fileHistory: 1, limit: Math.min(input.limit ?? ORIENTATION_EDGE_LIMIT, 20) };
      let targetLabel = "session";
      try {
        if (input.query) {
          const result = await deps.vcs.query({
            contextId: contextId(),
            query: bindQueryReferences(input.query, references),
            limit: Math.min(input.limit ?? QUERY_ROW_LIMIT, 200),
          });
          return {
            content: [
              {
                type: "text" as const,
                text: renderQueryBlock({
                  result,
                  identityColumns: (column, value, row, columns) => {
                    const node = queryIdentityNode(column, value, row, columns);
                    return node ? reference(node) : null;
                  },
                }),
              },
            ],
            details: {
              target: "query",
              ref: "",
              subjectKind: "command" as const,
              limit: pages.limit,
              rowCount: result.rows.length,
              refused: result.refusal?.code ?? null,
              continuations: [],
            },
          };
        }
        if (input.targets && input.targets.length > 0) {
          const inspections = await Promise.all(
            input.targets.slice(0, 10).map(async (candidate) => {
              const resolved = await rootForTarget(cwd, deps, references, candidate.trim());
              return {
                target: resolved.label,
                inspection: await deps.vcs.inspect({ node: resolved.root, edgeLimit: 1 }),
              };
            })
          );
          return {
            content: [
              { type: "text" as const, text: renderInspectionBatch({ inspections, reference }) },
            ],
            details: {
              target: input.targets.join(" "),
              ref: "",
              subjectKind: inspections[0]?.inspection.root.kind ?? ("command" as const),
              limit: pages.limit,
              inspectedCount: inspections.length,
              continuations: [],
            },
          };
        }
        const requestedTarget = String(input.target ?? "session").trim() || "session";
        if (/^search\s*:/iu.test(requestedTarget)) {
          const text = requestedTarget.replace(/^search\s*:/iu, "").trim();
          if (!text) {
            return invalidTargetResult(requestedTarget, "A search target needs words to look for");
          }
          const result = await deps.vcs.search({
            contextId: contextId(),
            text,
            limit: Math.min(input.limit ?? SEARCH_HIT_LIMIT, 50),
          });
          return {
            content: [
              { type: "text" as const, text: renderSearchBlock({ result, reference }) },
            ],
            details: {
              target: requestedTarget,
              ref: "",
              subjectKind: "command" as const,
              limit: pages.limit,
              hitCount: result.hits.length,
              continuations: [],
            },
          };
        }
        const walkBasis = isAgentReference(requestedTarget)
          ? loadProvenanceReference(references, requestedTarget).walk
          : undefined;
        const walkKind = input.walk ?? walkBasis?.walk;
        if (walkKind) {
          const resolved = await rootForTarget(cwd, deps, references, requestedTarget);
          targetLabel = resolved.label;
          const scope = input.scope ?? walkBasis?.scope;
          const result = await deps.vcs.walk({
            contextId: contextId(),
            walk: walkKind,
            subject: resolved.root,
            // The contract owns the default breadth; restating it here silently
            // pinned every cohort to one tool call's worth of work.
            scope: scope ?? "turn",
            ...(walkBasis?.cursor ? { cursor: walkBasis.cursor } : {}),
            limit: Math.min(input.limit ?? WALK_ENTRY_LIMIT, 200),
          });
          return {
            content: [
              {
                type: "text" as const,
                text: renderWalkBlock({
                  label: targetLabel,
                  result,
                  reference,
                  continuation: (cursor) =>
                    putProvenanceReference(references, resolved.root, pages.limit, undefined, {
                      walk: walkKind,
                      cursor,
                      ...(scope ? { scope } : {}),
                    }),
                }),
              },
            ],
            details: {
              target: targetLabel,
              ref: reference(resolved.root),
              subjectKind: resolved.root.kind,
              limit: pages.limit,
              walk: walkKind,
              entryCount: result.entries.length,
              continuations: [],
            },
          };
        }
        if (isAgentReference(requestedTarget)) {
          const basis = loadProvenanceReference(references, requestedTarget);
          const root = parseRoot(basis.root);
          pages.limit = basis.limit;
          if (basis.stream === "adjacency" && basis.page) pages.adjacency = basis.page;
          if (basis.stream === "file-history" && basis.page) pages.fileHistory = basis.page;
          targetLabel = requestedTarget;
          const loaded = await loadProvenancePages(
            deps,
            root,
            pages,
            basis.stream && basis.cursor
              ? { stream: basis.stream, cursor: basis.cursor }
              : undefined
          );
          return toolResult(
            targetLabel,
            root,
            loaded.inspection,
            loaded.neighbors,
            loaded.history,
            pages,
            references
          );
        }
        const target = requestedTarget;
        targetLabel = target;
        const path = target.startsWith("file:") ? target.slice(5) : target;
        if (splitRepoPath(path)) {
          const firstPage = await neighborsForWorkspacePath(cwd, deps, path, {
            limit: pages.limit,
          });
          targetLabel = firstPage.label;
          const loaded = await loadProvenancePages(
            deps,
            firstPage.root,
            pages,
            undefined,
            firstPage.result
          );
          return toolResult(
            targetLabel,
            firstPage.root,
            loaded.inspection,
            loaded.neighbors,
            loaded.history,
            pages,
            references
          );
        }

        let root: VcsSemanticNodeRef;
        try {
          root = semanticRootForTarget(target, deps.session);
        } catch (error) {
          return invalidTargetResult(
            target,
            error instanceof Error ? error.message : `Invalid provenance target: ${target}`
          );
        }
        const loaded = await loadProvenancePages(deps, root, pages);
        return toolResult(
          target,
          root,
          loaded.inspection,
          loaded.neighbors,
          loaded.history,
          pages,
          references
        );
      } catch (error) {
        if (error instanceof InvalidProvenanceTargetError) {
          return invalidTargetResult(targetLabel, error.message);
        }
        if (error instanceof AgentReferenceUnavailableError) {
          return invalidTargetResult(
            error.ref,
            `Provenance reference ${error.ref} is unavailable or expired. Start again from a friendly target.`
          );
        }
        throw error;
      }
    },
  };
}
