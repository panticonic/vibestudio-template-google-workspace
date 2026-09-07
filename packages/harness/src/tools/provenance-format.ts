/** Renderer for the agent-facing provenance surfaces.
 *
 * Identifier hygiene is a law here, not a preference: a raw content-addressed
 * identity is never rendered to the model. Every subject renders as a short
 * human label plus a compact `@ref`; exact typed roots live only behind the
 * reference store. The model is never asked to copy, compare, or construct an
 * identity, because one mistyped identity fails closed with a refusal it
 * cannot diagnose.
 */

import type {
  VcsQueryResult,
  VcsSearchResult,
  VcsSemanticNodeRef,
  VcsWalkResult,
} from "@vibestudio/service-schemas/vcs";
import type { ToolVcs } from "./tool-vcs.js";
import {
  PROVENANCE_REF_FOOTER,
  compactText,
  renderWithinBudget,
} from "./render-budget.js";

export type CanonicalProvenanceResult = Awaited<ReturnType<ToolVcs["neighbors"]>>;
export type CanonicalProvenanceInspection = Awaited<ReturnType<ToolVcs["inspect"]>>;
export type CanonicalProvenanceHistory = Awaited<ReturnType<ToolVcs["history"]>>;

export interface ProvenancePages {
  adjacency: number;
  fileHistory: number;
  limit: number;
}

export type NodeReference = (
  root: VcsSemanticNodeRef,
  continuation?: { stream: "adjacency" | "file-history"; page: number; cursor: string }
) => string;

export function provenancePageStreams(pages: ProvenancePages): {
  inspection: boolean;
  adjacency: boolean;
  fileHistory: boolean;
} {
  return {
    inspection: pages.adjacency === 1 && pages.fileHistory === 1,
    adjacency: pages.adjacency > 1 || pages.fileHistory === 1,
    fileHistory: pages.fileHistory > 1 || pages.adjacency === 1,
  };
}

export interface ProvenanceBlockInput {
  label: string;
  inspection?: CanonicalProvenanceInspection;
  history?: CanonicalProvenanceHistory;
  result: CanonicalProvenanceResult;
  pages?: ProvenancePages;
  reference?: NodeReference;
}

const quoted = (value: string): string => JSON.stringify(compactText(value, 160));

/**
 * An incidental mention of prose is rent, so it compacts hard. The prose a
 * surface was *asked for* — the originating statement, an inspected message —
 * is the answer, and compacting it to a mention is how a walk can reach the
 * right subject and still fail the question. The shared render budget remains
 * the real ceiling.
 */
const PROSE_LIMIT = 1_200;
const prose = (value: string): string => JSON.stringify(compactText(value, PROSE_LIMIT));

function countedPreview(total: number, preview: number, label: string): string {
  const plural = label.endsWith("y") ? `${label.slice(0, -1)}ies` : `${label}s`;
  return `${total} ${total === 1 ? label : plural} (${preview} in preview)`;
}

/** A subject renders as its kind and a ref — never as its identity. */
export function subjectLabel(node: VcsSemanticNodeRef, reference?: NodeReference): string {
  return reference ? `${node.kind} ${reference(node)}` : node.kind;
}

/** Refs for a bounded list of subjects, counted rather than enumerated. */
function referencedList(
  kind: VcsSemanticNodeRef["kind"],
  ids: readonly string[],
  build: (id: string) => VcsSemanticNodeRef,
  reference: NodeReference | undefined,
  maximum = 3
): string | null {
  if (ids.length === 0) return null;
  const shown = ids.slice(0, maximum);
  const refs = reference ? shown.map((id) => reference(build(id))).join(" ") : "";
  const remainder = ids.length > shown.length ? ` and ${ids.length - shown.length} more` : "";
  return `${kind}${ids.length === 1 ? "" : "s"}${refs ? ` ${refs}` : ""}${remainder}`;
}

function inspectedNodeSummary(
  inspection: CanonicalProvenanceInspection,
  reference?: NodeReference
): string {
  const node = inspection.node;
  switch (node.kind) {
    case "event": {
      const value = node.value;
      return [
        "event",
        value.kind,
        value.message ? `message ${quoted(value.message)}` : null,
        `${value.applicationIds.length} application${value.applicationIds.length === 1 ? "" : "s"}`,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "external-delta": {
      const value = node.value;
      return [
        "external-delta",
        value.status,
        value.repoPath,
        `${value.changeCount} change${value.changeCount === 1 ? "" : "s"}`,
      ].join(" · ");
    }
    case "application": {
      const value = node.value;
      return [
        "application",
        referencedList(
          "work-unit",
          [value.workUnitId],
          (workUnitId) => ({ kind: "work-unit", workUnitId }),
          reference
        ),
        `basis ${subjectLabel(value.basis, reference)}`,
        countedPreview(value.appliedChangeCount, value.appliedChanges.length, "applied change"),
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "applied-change": {
      const value = node.value;
      return [
        "applied-change",
        referencedList(
          "application",
          [value.applicationId],
          (applicationId) => ({ kind: "application", applicationId }),
          reference
        ),
        referencedList(
          "change",
          [value.changeId],
          (changeId) => ({ kind: "change", changeId }),
          reference
        ),
        `ordinal ${value.ordinal}`,
        `${value.appliedEffects.length} effect${value.appliedEffects.length === 1 ? "" : "s"}`,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "work-unit": {
      const value = node.value;
      const externalSnapshot = value.externalSnapshot;
      return [
        "work-unit",
        value.kind,
        `${value.intent.tier}: ${quoted(value.intent.text)}`,
        referencedList(
          "command",
          [value.commandId],
          (commandId) => ({ kind: "command", commandId }),
          reference
        ),
        countedPreview(
          value.authoredChangeCount,
          value.authoredChangeIds.length,
          "authored change"
        ),
        countedPreview(
          value.incorporatedChangeCount,
          value.incorporatedChangeIds.length,
          "incorporated change"
        ),
        countedPreview(value.decisionCount, value.decisionIds.length, "decision"),
        externalSnapshot
          ? `external snapshot ${externalSnapshot.sourceKind}:${quoted(externalSnapshot.sourceUri)} @ ${quoted(externalSnapshot.snapshotRevision)} · ${countedPreview(externalSnapshot.targetRepositoryIds.length, externalSnapshot.targetRepositoryIds.length, "target repository")} · pre-import coordinate authorship unknown`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "change": {
      const value = node.value;
      return [
        "change",
        value.kind,
        referencedList(
          "work-unit",
          [value.authoredByWorkUnitId],
          (workUnitId) => ({ kind: "work-unit", workUnitId }),
          reference
        ),
        `${value.effects.length} effect${value.effects.length === 1 ? "" : "s"}`,
        referencedList(
          "change",
          value.counteractsChangeIds,
          (changeId) => ({ kind: "change", changeId }),
          reference
        )
          ? `counteracts ${referencedList(
              "change",
              value.counteractsChangeIds,
              (changeId) => ({ kind: "change", changeId }),
              reference
            )}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "decision": {
      const value = node.value;
      return [
        "decision",
        `${value.intent.tier}: ${quoted(value.intent.text)}`,
        ...value.sourceIntents.map(
          (source) => `source ${source.intent.tier}: ${quoted(source.intent.text)}`
        ),
        `${value.entries.length} coordinate entr${value.entries.length === 1 ? "y" : "ies"}`,
        `${value.entries.reduce((count, entry) => count + entry.accountedSourceChangeIds.length, 0)} accounted source changes`,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "command": {
      const value = node.value;
      return ["command", value.method, value.status].join(" · ");
    }
    case "file": {
      const value = node.value;
      return value.kind === "placed"
        ? [
            "file",
            value.path,
            value.contentKind,
            `${value.byteLength} bytes`,
            `${value.coordinateExtent} ${value.contentKind === "text" ? "UTF-16 units" : "byte coordinates"}`,
          ].join(" · ")
        : "file · tombstone";
    }
    case "repository": {
      const value = node.value;
      return value.kind === "present"
        ? `repository · ${value.repoPath}`
        : "repository · tombstone";
    }
    case "trajectory":
      return "trajectory · this session";
    case "trajectory-invocation": {
      const value = node.value;
      return [
        "trajectory-invocation",
        value.name ? `name ${quoted(value.name)}` : null,
        `status ${value.status}`,
        value.terminalOutcome ? `outcome ${value.terminalOutcome}` : null,
        // A blob digest is not a graph subject and has no ref: it is the exact
        // argument of the read the agent is being told to make. Identifier
        // hygiene governs subject identities, not this one call argument.
        value.requestRef
          ? `request ${value.requestRef.digest} · ${value.requestRef.encoding} · ${value.requestRef.originalBytes} bytes · read services.blobstore.getText(${JSON.stringify(value.requestRef.digest)})`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "trajectory-turn": {
      const value = node.value;
      return [
        "trajectory-turn",
        value.ordinal === null ? null : `ordinal ${value.ordinal}`,
        value.summary ? `summary ${quoted(value.summary)}` : null,
        value.openedAt ? `opened ${value.openedAt}` : null,
        value.closedAt ? `closed ${value.closedAt}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "trajectory-message": {
      const value = node.value;
      const text = value.textBlocks.map((block) => block.content).join("\n");
      return [
        "trajectory-message",
        `role ${value.role}`,
        `status ${value.status}`,
        value.senderRef ? `sender ${value.senderRef.kind}` : null,
        text ? `text ${prose(text)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }
  }
}

function inspectionContinuation(
  inspection: CanonicalProvenanceInspection
): { label: string; root: VcsSemanticNodeRef } | null {
  const node = inspection.node;
  if (node.kind === "event" && node.value.applicationIds.length === 1) {
    return {
      label: "sole application",
      root: { kind: "application", applicationId: node.value.applicationIds[0]! },
    };
  }
  if (node.kind === "application") {
    return {
      label: "owning work",
      root: { kind: "work-unit", workUnitId: node.value.workUnitId },
    };
  }
  if (node.kind === "change") {
    return {
      label: "authoring work",
      root: { kind: "work-unit", workUnitId: node.value.authoredByWorkUnitId },
    };
  }
  if (node.kind === "applied-change") {
    return {
      label: "owning application",
      root: { kind: "application", applicationId: node.value.applicationId },
    };
  }
  return null;
}

export function renderProvenanceBlock(input: ProvenanceBlockInput): string | null {
  if (!input.inspection && !input.history && input.result.edges.length === 0) return null;
  const pages = input.pages ?? { adjacency: 1, fileHistory: 1, limit: 5 };
  const streams = provenancePageStreams(pages);
  const pageLabel =
    streams.fileHistory && !streams.adjacency
      ? `file history page ${pages.fileHistory}`
      : streams.adjacency && !streams.fileHistory
        ? `adjacency page ${pages.adjacency}`
        : `${input.result.edges.length} edge${input.result.edges.length === 1 ? "" : "s"}`;
  const lines: string[] = [];
  if (streams.inspection && input.inspection) {
    lines.push(`  node · ${inspectedNodeSummary(input.inspection, input.reference)}`);
    const next = inspectionContinuation(input.inspection);
    if (next && input.reference) {
      lines.push(`  inspect ${next.label} → ${input.reference(next.root)}`);
    }
  }
  if (streams.fileHistory && input.history?.nextCursor && input.reference) {
    lines.push(
      `  more file history → ${input.reference(input.history.root, {
        stream: "file-history",
        page: pages.fileHistory + 1,
        cursor: input.history.nextCursor,
      })}`
    );
  }
  if (streams.fileHistory) {
    for (const entry of input.history?.entries ?? []) {
      lines.push(
        `  past · ${quoted(entry.summary)}${
          entry.intent ? ` · ${entry.intent.tier}: ${quoted(entry.intent.text)}` : ""
        }${entry.viaDecisionId && input.reference ? ` · via decision ${input.reference({ kind: "decision", decisionId: entry.viaDecisionId })}` : ""} · ${subjectLabel(entry.node, input.reference)}`
      );
    }
  }
  if (streams.adjacency && input.result.nextCursor && input.reference) {
    lines.push(
      `  more → ${input.reference(input.result.root, {
        stream: "adjacency",
        page: pages.adjacency + 1,
        cursor: input.result.nextCursor,
      })}`
    );
  }
  if (streams.adjacency) lines.push(...renderAdjacency(input.result.edges, input.reference));
  return renderWithinBudget({
    header: `prov · ${input.label} · ${pageLabel}`,
    lines,
    footer: input.reference ? PROVENANCE_REF_FOOTER : undefined,
  });
}

/**
 * §2.4's law — edges not on the spine are counted, not listed — applied to the
 * single-hop fallback, which was exempt from it. A commit event neighbours every
 * repository in the workspace, so an agent that lands there pages through dozens
 * of identical `contains-repository` lines, none of which is ever the answer.
 * A relation with several targets renders once with a count and one ref to
 * follow; a relation with a single target still renders in full.
 */
const ADJACENCY_PREVIEW = 2;

function renderAdjacency(
  edges: CanonicalProvenanceResult["edges"],
  reference?: NodeReference
): string[] {
  const byKind = new Map<string, CanonicalProvenanceResult["edges"][number][]>();
  for (const edge of edges) byKind.set(edge.kind, [...(byKind.get(edge.kind) ?? []), edge]);
  return [...byKind].flatMap(([kind, group]) => {
    const shown = group.slice(0, group.length > ADJACENCY_PREVIEW + 1 ? ADJACENCY_PREVIEW : group.length);
    const lines = shown.map(
      (edge) =>
        `  ${subjectLabel(edge.from, reference)} —${kind}→ ${subjectLabel(edge.to, reference)}`
    );
    const remainder = group.length - shown.length;
    return remainder > 0
      ? [...lines, `  … and ${remainder} more —${kind}→ ${group[0]!.to.kind}`]
      : lines;
  });
}

const WALK_HEADLINE: Record<VcsWalkResult["walk"], string> = {
  cause: "what was being attempted",
  cohort: "what else happened under this intent",
  rejections: "what was tried and rejected here",
};

const BOUNDARY_NOTE: Record<string, string> = {
  "human-statement": "← the originating human statement",
  "subagent-brief": "← assignment from a parent task",
  "external-delta": "← declared external delta",
  "import-snapshot": "← import boundary; earlier authorship is outside this workspace",
  "outside-visibility": "← boundary: outside your visible basis",
  "no-recorded-cause": "← no recorded cause",
};

/** Walks render as a spine: intents lead, mechanics trail, edges are counted. */
export function renderWalkBlock(input: {
  label: string;
  result: VcsWalkResult;
  reference: NodeReference;
  continuation?: (cursor: string) => string;
}): string {
  const { result } = input;
  const grouped = new Map<string, typeof result.entries>();
  for (const entry of result.entries) {
    const key = entry.group ?? "";
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }
  const lines: string[] = [];
  for (const [group, entries] of grouped) {
    if (group) lines.push(`  ${group} (${entries.length})`);
    for (const entry of entries) {
      const indent = "  ".repeat(1 + (group ? 1 : entry.depth));
      const intent = entry.intent
        ? `${entry.intent.tier}: ${quoted(entry.intent.text)} · `
        : "";
      const detail = entry.detail ? ` · ${quoted(entry.detail)}` : "";
      const boundary = entry.boundary ? ` ${BOUNDARY_NOTE[entry.boundary] ?? ""}` : "";
      lines.push(
        `${indent}${intent}${entry.label}${detail} · ${input.reference(entry.node)}${boundary}`
      );
      if (entry.statement) {
        lines.push(`${indent}  asked by ${entry.statement.sender}: ${prose(entry.statement.text)}`);
      }
    }
  }
  for (const omission of result.omitted) {
    lines.push(`  … and ${omission.count} ${omission.label}`);
  }
  for (const note of result.notes) lines.push(`  note · ${note}`);
  // Measured abduction failure: agents reach the rejections, read each one as a
  // fact about the coordinate it was recorded at, and repeat the rejected work
  // under another name. The orientation skill teaches otherwise, but an agent
  // doing ordinary work never opens it — so the reading rule travels with the
  // evidence. This is a fixed line, not an interpretation of it.
  if (result.walk === "rejections" && result.entries.length > 0) {
    lines.push(
      "  reading · a rejection is evidence about a property, not about a coordinate — " +
        "ask what your change shares with what was undone here before repeating it"
    );
  }
  if (result.nextCursor && input.continuation) {
    lines.push(`  more → ${input.continuation(result.nextCursor)}`);
  }
  return renderWithinBudget({
    header: `prov ${result.walk} · ${input.label} · ${WALK_HEADLINE[result.walk]}`,
    lines,
    footer: PROVENANCE_REF_FOOTER,
  });
}

const tableCell = (value: string | number | boolean | null): string =>
  value === null ? "" : String(value).replaceAll("|", "\\|").replaceAll("\n", " ");

/** Sets render as tables; narrative prose is reserved for causal chains. */
export function renderQueryBlock(input: {
  result: VcsQueryResult;
  identityColumns?: (
    column: string,
    value: string,
    row: VcsQueryResult["rows"][number],
    columns: VcsQueryResult["columns"]
  ) => string | null;
}): string {
  const { result } = input;
  if (result.refusal) {
    return renderWithinBudget({
      header: `prov query · refused at ${result.refusal.stage}${result.refusal.term ? ` · ${result.refusal.term}` : ""}`,
      lines: [
        `  ${result.refusal.message}`,
        ...(result.rows.length > 0 ? [`  ${result.rows.length} partial rows follow`] : []),
        ...(result.rows.length > 0
          ? renderRows(result, input.identityColumns)
          : []),
      ],
    });
  }
  return renderWithinBudget({
    header: `prov query · ${result.rows.length} row${result.rows.length === 1 ? "" : "s"}${result.truncated ? " (truncated)" : ""} · contract v${result.schemaVersion}`,
    lines: renderRows(result, input.identityColumns),
    footer: PROVENANCE_REF_FOOTER,
    truncated: result.truncated,
  });
}

function renderRows(
  result: VcsQueryResult,
  identityColumns?: (
    column: string,
    value: string,
    row: VcsQueryResult["rows"][number],
    columns: VcsQueryResult["columns"]
  ) => string | null
): string[] {
  if (result.columns.length === 0) return ["  (no columns)"];
  const header = `| ${result.columns.join(" | ")} |`;
  const divider = `| ${result.columns.map(() => "---").join(" | ")} |`;
  const rows = result.rows.map((row) => {
    const cells = row.map((value, index) => {
      const column = result.columns[index]!;
      const replaced =
        typeof value === "string"
          ? (identityColumns?.(column, value, row, result.columns) ?? null)
          : null;
      return tableCell(replaced ?? value);
    });
    return `| ${cells.join(" | ")} |`;
  });
  return [header, divider, ...rows];
}

/** Search hits are one line each: kind, resolved intent or excerpt, and a ref. */
export function renderSearchBlock(input: {
  result: VcsSearchResult;
  reference: NodeReference;
}): string {
  const lines = input.result.hits.map((hit) => {
    const intent = hit.intent ? `${hit.intent.tier}: ${quoted(hit.intent.text)}` : quoted(hit.excerpt);
    return `  ${hit.subjectKind} · ${intent} · ${input.reference(hit.node)}`;
  });
  return renderWithinBudget({
    header: `prov search · ${quoted(input.result.text)} · ${input.result.hits.length} hit${
      input.result.hits.length === 1 ? "" : "s"
    }${input.result.indexMode === "scan" ? " (unranked scan)" : ""}`,
    lines: lines.length > 0 ? lines : ["  no subject in your visible basis mentions that"],
    footer: PROVENANCE_REF_FOOTER,
    truncated: input.result.truncated,
  });
}

/** Batch inspection: expand several agenda items under one header. */
export function renderInspectionBatch(input: {
  inspections: readonly { target: string; inspection: CanonicalProvenanceInspection }[];
  reference: NodeReference;
}): string {
  return renderWithinBudget({
    header: `prov · ${input.inspections.length} subject${input.inspections.length === 1 ? "" : "s"}`,
    lines: input.inspections.map(
      ({ target, inspection }) =>
        `  ${target} · ${inspectedNodeSummary(inspection, input.reference)}`
    ),
    footer: PROVENANCE_REF_FOOTER,
  });
}
