import type {
  VcsHistoryResult,
  VcsReadMemoryEpisode,
  VcsReadMemoryResult,
  VcsSemanticNodeRef,
} from "@vibestudio/service-schemas/vcs";
import {
  PROVENANCE_REF_FOOTER,
  PROVENANCE_RENDER_BUDGET,
  PROVENANCE_TRUNCATION_MARKER,
  compactText,
} from "./render-budget.js";

type AttachedReadMemory = Extract<VcsReadMemoryResult, { status: "attached" }>;
type HistoryEntry = VcsHistoryResult["entries"][number];

/** Hard attention budget for the ubiquitous read attachment; shared with
 *  every other provenance surface so they all degrade the same way. */
export const READ_MEMORY_RENDER_BUDGET = PROVENANCE_RENDER_BUDGET;

const compact = compactText;
const quoted = (value: string): string => JSON.stringify(compact(value));
type ReferenceSemanticRoot = (value: VcsSemanticNodeRef) => string;
/** A subject renders as its kind and a ref; identities stay in trusted code. */
const root = (value: VcsSemanticNodeRef, reference?: ReferenceSemanticRoot): string =>
  reference ? `${value.kind} ${reference(value)}` : value.kind;

function lineAt(
  content: string,
  offset: number,
  contentStart: number,
  contentStartLine: number
): number {
  let line = contentStartLine;
  const localOffset = Math.max(0, offset - contentStart);
  for (let index = 0; index < Math.min(localOffset, content.length); index += 1) {
    if (content.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function renderedRanges(
  content: string,
  episode: VcsReadMemoryEpisode,
  contentStart: number,
  contentStartLine: number
): string {
  return episode.ranges
    .map(({ start, end }) => {
      const first = lineAt(content, start, contentStart, contentStartLine);
      const last = lineAt(content, Math.max(start, end - 1), contentStart, contentStartLine);
      return first === last ? `${first}` : `${first}-${last}`;
    })
    .join(", ");
}

function salience(episode: VcsReadMemoryEpisode, readingContextId: string): number {
  if (episode.authorContextId === readingContextId) return 4;
  if (episode.arrival) return 0;
  if (episode.stop === "import-boundary" || episode.counteractsChangeIds.length > 0) return 1;
  return episode.intent.tier === "mechanical" ? 3 : 2;
}

interface RenderableEpisode {
  episode: VcsReadMemoryEpisode;
  base: string[];
  composedSecondIntent?: string;
  sourceHeadline?: string;
  rationale?: string;
  commitMessage?: string;
}

function prepareEpisode(
  content: string,
  episode: VcsReadMemoryEpisode,
  readingContextId: string,
  contentStart: number,
  contentStartLine: number,
  reference?: ReferenceSemanticRoot
): RenderableEpisode {
  const range = `● lines ${renderedRanges(content, episode, contentStart, contentStartLine)}`;
  const work = `work unit ${root(episode.workUnit, reference)}`;
  const change = `change ${root(episode.change, reference)}`;
  const why = `${episode.intent.tier}: ${quoted(episode.intent.text)}`;
  if (episode.authorContextId === readingContextId) {
    return { episode, base: [range, "yours", why, work, change] };
  }
  const arrival = episode.arrival;
  const sourceParent = arrival?.parentIntents.find((parent) => parent.role === "source");
  const currentParent = arrival?.parentIntents.find((parent) => parent.role === "current");
  return {
    episode,
    base: [
      range,
      arrival
        ? arrival.mode === "arrived"
          ? `arrived via merge ${root(arrival.decision, reference)}`
          : `accepted as merged truth by ${root(arrival.decision, reference)}`
        : episode.stop === "import-boundary"
          ? "imported from outside workspace history"
          : "authored here",
      why,
      work,
      change,
      ...(episode.counteractsChangeIds.length > 0
        ? [
            `counteracts ${episode.counteractsChangeIds
              .map((changeId) => root({ kind: "change", changeId }, reference))
              .join(", ")}`,
          ]
        : []),
    ],
    ...(currentParent
      ? {
          composedSecondIntent: `composed with yours ${currentParent.intent.tier}: ${quoted(currentParent.intent.text)}`,
        }
      : {}),
    ...(sourceParent
      ? {
          sourceHeadline: `source ${sourceParent.intent.tier}: ${quoted(sourceParent.intent.text)}`,
        }
      : {}),
    ...(arrival?.rationale ? { rationale: `rationale ${quoted(arrival.rationale)}` } : {}),
    ...(episode.commit?.message
      ? { commitMessage: `committed as ${quoted(episode.commit.message)}` }
      : {}),
  };
}

function episodeText(value: RenderableEpisode): string {
  return [
    ...value.base,
    value.composedSecondIntent,
    value.sourceHeadline,
    value.rationale,
    value.commitMessage,
  ]
    .filter((field): field is string => Boolean(field))
    .join(" · ");
}

function historyText(entry: HistoryEntry, reference?: ReferenceSemanticRoot): string {
  const intent = entry.intent ? ` · ${entry.intent.tier}: ${quoted(entry.intent.text)}` : "";
  const decision = entry.viaDecisionId
    ? ` · via ${root({ kind: "decision", decisionId: entry.viaDecisionId }, reference)}`
    : "";
  return `- ${quoted(entry.summary)}${intent}${decision} · ${root(entry.node, reference)}`;
}

export function renderReadMemoryBlock(input: {
  label: string;
  content: string;
  contentStart?: number;
  contentStartLine?: number;
  readingContextId: string;
  startLine: number;
  endLine: number;
  result: AttachedReadMemory;
  reference?: ReferenceSemanticRoot;
}): string | null {
  if (input.result.episodes.length === 0 && input.result.history.length === 0) return null;
  const header =
    `workspace memory · why ${input.label} lines ${input.startLine}-${input.endLine} exist · ` +
    "verified against this exact content";
  const fileRoot: Extract<VcsSemanticNodeRef, { kind: "file" }> = {
    kind: "file",
    state: input.result.state,
    repositoryId: input.result.repositoryId,
    fileId: input.result.fileId,
  };
  const target = input.reference ? input.reference(fileRoot) : input.label;
  const footer = input.reference
    ? `dig deeper · provenance({"target":"${target}","walk":"cause"}) · ${PROVENANCE_REF_FOOTER}`
    : `dig deeper · provenance({"target":"${target}","walk":"cause"})`;
  // Negative evidence only when there is some: an unconditional hint is noise
  // that teaches agents to skip the line, which is the opposite of the point.
  const rejections =
    input.result.rejectionCount > 0
      ? `${input.result.rejectionCount} earlier attempt${
          input.result.rejectionCount === 1 ? " at this file was" : "s at this file were"
        } undone · provenance({"target":"${target}","walk":"rejections"})`
      : null;
  const episodes = input.result.episodes
    .map((episode) =>
      prepareEpisode(
        input.content,
        episode,
        input.readingContextId,
        input.contentStart ?? 0,
        input.contentStartLine ?? 1,
        input.reference
      )
    )
    .sort(
      (left, right) =>
        salience(left.episode, input.readingContextId) -
          salience(right.episode, input.readingContextId) ||
        left.episode.ranges[0]!.start - right.episode.ranges[0]!.start
    );
  let dropped = input.result.truncated;
  const render = (): string =>
    [
      header,
      ...episodes.map(episodeText),
      ...(input.result.history.length > 0
        ? [
            "earlier file history",
            ...input.result.history.map((entry) => historyText(entry, input.reference)),
          ]
        : []),
      ...(rejections ? [rejections] : []),
      ...(dropped ? [PROVENANCE_TRUNCATION_MARKER] : []),
      footer,
    ].join("\n");
  for (const field of [
    "composedSecondIntent",
    "sourceHeadline",
    "rationale",
    "commitMessage",
  ] as const) {
    for (
      let index = episodes.length - 1;
      render().length > READ_MEMORY_RENDER_BUDGET && index >= 0;
      index -= 1
    ) {
      if (episodes[index]![field]) {
        delete episodes[index]![field];
        dropped = true;
      }
    }
  }
  while (render().length > READ_MEMORY_RENDER_BUDGET && episodes.length > 1) {
    episodes.pop();
    dropped = true;
  }
  return render();
}
