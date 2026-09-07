// Builtin semantic-authority implementation.
import {
  canonicalJson,
  canonicalSnapshotDigest,
  compareUtf16CodeUnits,
  sha256Hex,
} from "@vibestudio/content-addressing";
import {
  parseVcsSemanticRequest,
  vcsProvenanceEdgeSchema,
  vcsTrajectoryRequestRefSchema,
  vcsTrajectorySenderRefSchema,
  type VcsBlameInput,
  type VcsCompareInput,
  type VcsCopyInput,
  type VcsDiscardInput,
  type VcsEditInput,
  type VcsExternalSnapshot,
  type VcsHistoryInput,
  type VcsImportSnapshotInput,
  type VcsInspectInput,
  type VcsMergeInput,
  type VcsRegisterExternalDeltaInput,
  type VcsExternalDeltaLifecycleInput,
  type VcsListDirectoryInput,
  type VcsListDirectoryResult,
  type VcsListFilesInput,
  type VcsSemanticMethodName,
  type VcsMoveInput,
  type VcsNeighborsInput,
  type VcsPushInput,
  type VcsQueryInput,
  type VcsSearchInput,
  type VcsWalkInput,
  type VcsReadFileInput,
  type VcsReadMemoryInput,
  type VcsResolveRepositoryInput,
  type VcsResolveRepositoryResult,
  type VcsRevertInput,
  type VcsStateNodeRef,
  type VcsStatusInput,
} from "@vibestudio/service-schemas/vcs";
import {
  NORMALIZATION_PROTOCOL,
  SEMANTIC_PROTOCOL,
  compactId,
  composeFileManifest,
  contentMappingDigest,
  emptyFileManifest,
  fileManifestEntryAt,
  planWorkspaceFactChangeSet,
  threeWayTextMerge,
  resolveIntent,
  workspaceFileStateIdentity,
  workspaceRepositoryStateIdentity,
  type ContentMapping,
  type PersistentRadixNode,
  type StateNodeRef,
  type WorkspaceFactChangeSet,
  type WorkspaceFileState,
  type WorkspaceRepositoryMember,
} from "@workspace/vcs-engine";
import type { SqlStorage } from "@vibestudio/durable";
import {
  contextMaterializationCommand,
  contextMaterializationReceiptProves,
  type ContextMaterializationCommand,
  type ContextMaterializationReceipt,
  type WorkspaceMaterializationChange,
  type WorkspaceMaterializationRepository,
} from "@vibestudio/shared/vcs/workspaceProjection";
import { assertSemanticVcsPathAdmissible } from "@vibestudio/shared/vcs/pathAdmission";
import { splitRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import {
  SemanticVcsError,
  appliedChangeIdentity,
  applicationIdentity,
  changeIdentity,
  contentEdgeIdentity,
  decisionIdentity,
  internalSemanticIntegrityFailure,
  stateNodeKey,
  workUnitIdentity,
  type ApplicationPersistencePlan,
  type ApplicationRecord,
  type AppliedChangeRecord,
  type AuthoredCopySourceEndpoint,
  type CausalCommandRef,
  type ChangeRecord,
  type ContentEdgeRecord,
  type IntegrationDecisionRecord,
  type SemanticEffect,
  type SemanticVcsStore,
  type StatePredicateRecord,
  type WorkUnitRecord,
  type ExternalDeltaRecord,
} from "./semanticVcsStore.js";
import { contentMappingFromRow } from "./semanticVcsContentMappingCodec.js";
import { execBatchedInsert } from "./sqlBatch.js";
import { executeProvenanceQuery } from "./provenanceQuery.js";
import { PROV_RESOLVER_PROTOCOL, provenanceSearchIndexMode } from "./provenanceViews.js";

type Row = Record<string, unknown>;
type PlacedFileState = Extract<WorkspaceFileState, { presence: "placed" }>;
type PresentRepositoryState = Extract<WorkspaceRepositoryMember, { presence: "present" }>;
type ContentEndpoint = {
  fileId: string;
  contentHash: string;
  coordinateKind: "utf16" | "byte";
  coordinateExtent: number;
};
type LatestAppliedFileChange = {
  fileId: string;
  appliedChangeId: string;
  changeId: string;
  workUnitId: string;
  commandId: string;
  kind: string;
  contentClass: "internal" | "external";
  externalKeys: string[];
  content: ContentEndpoint | null;
};

const MAX_WORKING_APPLICATIONS = 10_000;
const MAX_ANCESTRY_EDGES = 100_000;
/** Walk bounds are query shapes, not policies: they are fixed server-side. */
const MAX_CAUSE_MESSAGE_HOPS = 8;
const MAX_REJECTION_ROWS = 200;
const MAX_INDEXED_MESSAGES = 5_000;

type WalkPage = { entries: Row[]; omitted: Row[]; notes: string[] };

const walkCursorOffset = (cursor: string | undefined, basis: Row): number => {
  const position = parseSemanticCursor(cursor, "walk", basis);
  if (!position) return 0;
  const offset = Number(position["offset"]);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new SemanticVcsError("InvalidReference", "Invalid walk cursor position");
  }
  return offset;
};

/**
 * FTS5 query syntax is a real language and an agent's plain phrase is not one.
 * Quote each term so a hunch never becomes a syntax error the caller cannot
 * diagnose; ranking still comes from the index.
 */
const ftsMatchExpression = (text: string): string =>
  text
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length > 0)
    .map((term) => `"${term.replaceAll('"', "")}"`)
    .join(" OR ") || '""';
const stateFileKey = (state: StateNodeRef, fileId: string): string =>
  `${stateNodeKey(state)}\0${fileId}`;

const boundedMemoryText = (value: string, maximum: number): string | null => {
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
};

const trajectorySenderRef = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Row;
  const parsed = vcsTrajectorySenderRefSchema.safeParse({
    kind: candidate["kind"],
    id: candidate["id"],
    participantId:
      typeof candidate["participantId"] === "string" ? candidate["participantId"] : null,
  });
  return parsed.success ? parsed.data : null;
};

const trajectoryRequestRef = (value: unknown) => {
  const parsed = vcsTrajectoryRequestRefSchema.safeParse(value);
  if (!parsed.success) {
    throw new SemanticVcsError(
      "IntegrityFailure",
      "Invalid canonical invocation request reference"
    );
  }
  return parsed.data;
};

export interface SemanticDispatchRequest {
  input: unknown;
  /** Exact trajectory edge, when this command came from an agent tool call. */
  ingress: {
    causalParent: {
      kind: "trajectory-invocation";
      logId: string;
      head: string;
      invocationId: string;
    } | null;
    contextIntegrity: {
      class: "internal" | "external";
      externalKeys: readonly string[];
    };
  };
}

export type SemanticDispatchResult =
  | { kind: "complete"; result: unknown }
  | {
      kind: "effects-pending";
      result: unknown;
      effects: readonly SemanticEffect[];
    }
  | { kind: "host-read"; request: Row };

export interface SemanticEffectAcknowledgement {
  effectId: string;
  payloadDigest: string;
  receipt: Row;
}

interface SemanticWorkspaceDeps {
  workspaceId: string;
  sql: SqlStorage;
  store: SemanticVcsStore;
  now(): string;
  transaction<T>(fn: () => T): T;
}

interface FileTransition {
  fileId: string;
  expected: WorkspaceFileState | null;
  result: WorkspaceFileState;
  changeId: string;
  /** This work authors the global file identity, not merely a placement in this state. */
  newFile: boolean;
}

interface RepositoryTransition {
  repositoryId: string;
  expected: WorkspaceRepositoryMember | null;
  /** `undefined` preserves the member while files change; `null` deletes it. */
  resultPath: string | null | undefined;
  changeId: string | null;
  tombstoneChangeId: string | null;
  /** This work authors the global repository identity, not merely membership in this state. */
  newRepository: boolean;
}

type DraftChangeRef =
  | { kind: "authored"; ordinal: number }
  | { kind: "existing"; changeId: string };

interface MutationDraft {
  kind: WorkUnitRecord["kind"];
  intentSummary: string | null;
  externalSnapshot?: {
    sourceKind: VcsImportSnapshotInput["source"]["kind"];
    sourceUri: string;
    snapshotRevision: string;
    sourceSubdir?: string | null;
    canonicalSnapshot?: string;
    snapshotDigest: string;
    targetRepositoryIds: readonly string[];
  };
  incorporatedChangeIds: string[];
  changes: Array<
    Omit<ChangeRecord, "changeId" | "workUnitId" | "effectDigest" | "source"> & {
      source?: AuthoredCopySourceEndpoint;
    }
  >;
  fileResults: Array<{
    fileId: string;
    expected: WorkspaceFileState | null;
    result:
      | Omit<Extract<WorkspaceFileState, { presence: "placed" }>, "fileStateId">
      | {
          fileId: string;
          presence: "deleted";
          priorFileStateId: string;
        };
    /** This work authors the global identity; adopted source identities are never new here. */
    newFile: boolean;
    changeRef: DraftChangeRef;
  }>;
  repositoryResults: Array<{
    repositoryId: string;
    expected: WorkspaceRepositoryMember | null;
    resultPath: string | null;
    /** This work authors the global identity; adopted source identities are never new here. */
    newRepository: boolean;
    changeRef: DraftChangeRef | null;
  }>;
  appliedSourceChanges?: ChangeRecord[];
  contentEdges?: ContentEdgeRecord[];
  contentDerivations?: Array<{
    childChangeRef: DraftChangeRef;
    parent:
      | { kind: "applied"; appliedChangeId: string }
      | { kind: "change"; changeRef: DraftChangeRef };
    mappings: ContentMapping[];
  }>;
  decisions?: Array<
    Omit<IntegrationDecisionRecord, "decisionId" | "workUnitId" | "createdAt" | "entries"> & {
      entries: Array<
        Omit<IntegrationDecisionRecord["entries"][number], "resultChangeId"> & {
          resultChangeRef?: DraftChangeRef;
        }
      >;
    }
  >;
  blobs?: Array<{ contentHash: string; base64: string }>;
}

type MergeCoordinate = { kind: "file" | "repository"; id: string };
type MergeAspectName = "content" | "placement" | "mode" | "presence" | "path";
interface MergeAttributionEntry {
  changeId: string;
  workUnitId: string;
  undone?: true;
}
interface NetMergeAspect {
  aspect: MergeAspectName;
  base: unknown;
  ours: unknown;
  theirs: unknown;
  baseValues?: Array<{ eventId: string; value: unknown }>;
  status: "adopt" | "convergent" | "composed" | "conflict" | "ours";
  composedText?: string;
  composedMappings?: {
    ours: Array<{ childStart: number; childEnd: number; parentStart: number; parentEnd: number }>;
    theirs: Array<{ childStart: number; childEnd: number; parentStart: number; parentEnd: number }>;
  };
}
interface NetMergeCoordinate {
  coordinate: MergeCoordinate;
  paths: { base?: string; ours?: string; theirs?: string };
  status: "adopt" | "convergent" | "composed" | "conflict" | "resolved";
  aspects: NetMergeAspect[];
  attribution: { ours: MergeAttributionEntry[]; theirs: MergeAttributionEntry[] };
  group?: string;
  structuralConflicts?: MergeCoordinate[];
  resolutions: Array<"composed" | "theirs" | "ours" | "current">;
  decisionId?: string;
  summary: string;
}
interface NetMergeComparison {
  targetState: StateNodeRef;
  source:
    | { kind: "event"; eventId: string }
    | { kind: "application"; applicationId: string }
    | { kind: "external-delta"; deltaId: string };
  sourceEventId: string | null;
  sourceDeltaId: string | null;
  base: StateNodeRef;
  bases: StateNodeRef[];
  coordinates: NetMergeCoordinate[];
  concluded: boolean;
}

const asState = (value: VcsStateNodeRef): StateNodeRef =>
  value.kind === "event"
    ? { kind: "event", eventId: value.eventId }
    : { kind: "application", applicationId: value.applicationId };

const bytesFromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const base64FromBytes = (value: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < value.length; index += chunk) {
    binary += String.fromCharCode(...value.subarray(index, index + chunk));
  }
  return btoa(binary);
};

const contentBytes = (value: { kind: "text"; text: string } | { kind: "bytes"; base64: string }) =>
  value.kind === "text" ? new TextEncoder().encode(value.text) : bytesFromBase64(value.base64);

const contentDescriptor = (
  value: { kind: "text"; text: string } | { kind: "bytes"; base64: string },
  bytes: Uint8Array
): Pick<PlacedFileState, "contentKind" | "byteLength" | "coordinateExtent"> =>
  value.kind === "text"
    ? { contentKind: "text", byteLength: bytes.length, coordinateExtent: value.text.length }
    : { contentKind: "bytes", byteLength: bytes.length, coordinateExtent: bytes.length };

const coordinateKindForFile = (state: { contentKind: "text" | "bytes" }): "utf16" | "byte" =>
  state.contentKind === "text" ? "utf16" : "byte";

const contentDescriptorFromEndpoint = (
  endpoint: Row
): Pick<PlacedFileState, "contentKind" | "byteLength" | "coordinateExtent"> => {
  const contentKind = endpoint["contentKind"];
  const byteLength = endpoint["byteLength"];
  const coordinateExtent = endpoint["coordinateExtent"];
  if (
    (contentKind !== "text" && contentKind !== "bytes") ||
    !Number.isSafeInteger(byteLength) ||
    Number(byteLength) < 0 ||
    !Number.isSafeInteger(coordinateExtent) ||
    Number(coordinateExtent) < 0 ||
    (contentKind === "bytes" && coordinateExtent !== byteLength)
  ) {
    throw new SemanticVcsError("IntegrityFailure", "File endpoint has invalid coordinate metadata");
  }
  return {
    contentKind,
    byteLength: Number(byteLength),
    coordinateExtent: Number(coordinateExtent),
  };
};

const endpointForFile = (
  state: PlacedFileState,
  repository: Extract<WorkspaceRepositoryMember, { presence: "present" }>
): Row => ({
  kind: "file",
  fileId: state.fileId,
  repositoryId: state.repositoryId,
  repoPath: repository.repoPath,
  path: state.path,
  contentHash: state.contentHash,
  mode: state.mode,
  contentKind: state.contentKind,
  byteLength: state.byteLength,
  coordinateExtent: state.coordinateExtent,
});

const missingEndpoint = (
  state: Pick<PlacedFileState, "fileId" | "repositoryId" | "path">,
  repoPath: string
): Row => ({
  kind: "missing",
  fileId: state.fileId,
  repositoryId: state.repositoryId,
  repoPath,
  path: state.path,
});

const contentMapping = (value: Omit<ContentMapping, "digest">): ContentMapping => ({
  ...value,
  digest: contentMappingDigest(value),
});

const mappingForWholeFile = (input: {
  childContentHash: string;
  parentContentHash: string;
  coordinateKind: "utf16" | "byte";
  coordinateExtent: number;
}): ContentMapping => {
  return contentMapping({
    coordinateKind: input.coordinateKind,
    childContentHash: input.childContentHash,
    childStart: 0,
    childEnd: input.coordinateExtent,
    parentContentHash: input.parentContentHash,
    parentStart: 0,
    parentEnd: input.coordinateExtent,
  });
};

const mappingsForTextEdits = (input: {
  childContentHash: string;
  childExtent: number;
  parentContentHash: string;
  parentExtent: number;
  edits: unknown;
}): ContentMapping[] => {
  if (!Array.isArray(input.edits)) {
    throw new SemanticVcsError("IntegrityFailure", "Text change has no exact edit spans");
  }
  const mappings: ContentMapping[] = [];
  let parentCursor = 0;
  let childCursor = 0;
  for (const candidate of input.edits) {
    if (typeof candidate !== "object" || candidate === null) {
      throw new SemanticVcsError("IntegrityFailure", "Text change has an invalid edit span");
    }
    const edit = candidate as { start?: unknown; end?: unknown; text?: unknown };
    if (
      !Number.isSafeInteger(edit.start) ||
      !Number.isSafeInteger(edit.end) ||
      typeof edit.text !== "string" ||
      Number(edit.start) < parentCursor ||
      Number(edit.end) < Number(edit.start) ||
      Number(edit.end) > input.parentExtent
    ) {
      throw new SemanticVcsError("IntegrityFailure", "Text change has an invalid edit span");
    }
    const start = Number(edit.start);
    const end = Number(edit.end);
    const unchangedLength = start - parentCursor;
    if (unchangedLength > 0) {
      mappings.push(
        contentMapping({
          coordinateKind: "utf16",
          childContentHash: input.childContentHash,
          childStart: childCursor,
          childEnd: childCursor + unchangedLength,
          parentContentHash: input.parentContentHash,
          parentStart: parentCursor,
          parentEnd: start,
        })
      );
    }
    childCursor += unchangedLength + edit.text.length;
    parentCursor = end;
  }
  const tailLength = input.parentExtent - parentCursor;
  if (tailLength > 0) {
    mappings.push(
      contentMapping({
        coordinateKind: "utf16",
        childContentHash: input.childContentHash,
        childStart: childCursor,
        childEnd: childCursor + tailLength,
        parentContentHash: input.parentContentHash,
        parentStart: parentCursor,
        parentEnd: input.parentExtent,
      })
    );
    childCursor += tailLength;
  }
  if (childCursor !== input.childExtent) {
    throw new SemanticVcsError("IntegrityFailure", "Text edit mappings do not cover the result");
  }
  return mappings;
};

const predicateForState = (state: WorkspaceFileState): StatePredicateRecord =>
  state.presence === "placed"
    ? { kind: "file-content", fileId: state.fileId, contentHash: state.contentHash }
    : { kind: "file-absent", fileId: state.fileId };

const inverseChangeKind = (kind: string): string | null => {
  switch (kind) {
    case "file-create":
    case "file-copy":
    case "file-restore":
      return "file-delete";
    case "file-delete":
      return "file-restore";
    case "repo-add":
    case "repo-restore":
      return "repo-delete";
    case "repo-delete":
      return "repo-restore";
    case "text":
    case "file-move":
    case "file-mode":
    case "content-replace":
    case "repo-move":
      return kind;
    default:
      return null;
  }
};

const publicChangeKind = (kind: string): string => {
  switch (kind) {
    case "text":
      return "text-edit";
    case "repo-add":
      return "repository-create";
    case "repo-delete":
      return "repository-delete";
    case "repo-restore":
      return "repository-restore";
    case "repo-move":
      return "repository-move";
    default:
      return kind;
  }
};

type ObservedContentDescriptor = {
  contentKind: "text" | "bytes";
  byteLength: number;
  coordinateExtent: number;
};

const importedSnapshotDigest = (
  repositories: VcsImportSnapshotInput["repositories"],
  observed: ReadonlyMap<string, ObservedContentDescriptor>
): string =>
  compactId(
    "snapshot",
    repositories
      .map((repository) => ({
        repoPath: repository.repoPath,
        files: repository.files
          .map((file) => {
            const descriptor = observed.get(file.contentHash);
            if (!descriptor) {
              throw internalSemanticIntegrityFailure(
                "EffectMismatch",
                `Content observation lacks ${file.contentHash}`,
                { contentHash: file.contentHash, contract: "import-observation" }
              );
            }
            return {
              path: file.path,
              contentHash: file.contentHash,
              mode: file.mode,
              ...descriptor,
            };
          })
          .sort((left, right) => compareUtf16CodeUnits(left.path, right.path)),
      }))
      .sort((left, right) => compareUtf16CodeUnits(left.repoPath, right.repoPath))
  );

const importedRepositories = (input: VcsImportSnapshotInput) =>
  input.repositories.map((repository, ordinal) => ({
    input: repository,
    repositoryId:
      repository.repositoryId ??
      compactId("repository", {
        commandId: input.commandId,
        ordinal,
        repoPath: repository.repoPath,
      }),
  }));

const changeEffects = (change: Pick<ChangeRecord, "kind" | "base" | "result" | "payload">) => {
  const base = change.base;
  const result = change.result;
  const fileId =
    typeof result?.["fileId"] === "string"
      ? result["fileId"]
      : typeof base?.["fileId"] === "string"
        ? base["fileId"]
        : null;
  if (fileId) {
    const effects: Row[] = [];
    const beforeContentHash =
      base?.["kind"] === "file" && typeof base["contentHash"] === "string"
        ? base["contentHash"]
        : null;
    const afterContentHash =
      result?.["kind"] === "file" && typeof result["contentHash"] === "string"
        ? result["contentHash"]
        : null;
    if (beforeContentHash !== afterContentHash) {
      effects.push({ kind: "content", fileId, beforeContentHash, afterContentHash });
    }
    const placement = (value: Row | null) =>
      value?.["kind"] === "file" &&
      typeof value["repositoryId"] === "string" &&
      typeof value["path"] === "string"
        ? { repositoryId: value["repositoryId"], path: value["path"] }
        : null;
    const before = placement(base);
    const after = placement(result);
    if (canonicalJson(before) !== canonicalJson(after)) {
      effects.push({ kind: "placement", fileId, before, after });
    }
    const beforeMode = base?.["kind"] === "file" ? Number(base["mode"]) : null;
    const afterMode = result?.["kind"] === "file" ? Number(result["mode"]) : null;
    if (beforeMode !== afterMode) {
      effects.push({ kind: "mode", fileId, beforeMode, afterMode });
    }
    if (effects.length > 0) return effects;
  }
  const repositoryId =
    typeof result?.["repositoryId"] === "string"
      ? result["repositoryId"]
      : typeof base?.["repositoryId"] === "string"
        ? base["repositoryId"]
        : null;
  if (repositoryId) {
    return [
      {
        kind: "repository-placement",
        repositoryId,
        beforePath:
          base?.["kind"] === "repository" && typeof base["repoPath"] === "string"
            ? base["repoPath"]
            : null,
        afterPath:
          result?.["kind"] === "repository" && typeof result["repoPath"] === "string"
            ? result["repoPath"]
            : null,
      },
    ];
  }
  throw new SemanticVcsError("IntegrityFailure", `Change ${change.kind} has no public effect`);
};

type SemanticCursorPayload = Readonly<{
  kind: string;
  position: Row;
}>;

const base64UrlFromBytes = (value: Uint8Array): string =>
  base64FromBytes(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

const bytesFromBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new Error("invalid base64url");
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  return bytesFromBase64(`${value.replaceAll("-", "+").replaceAll("_", "/")}${padding}`);
};

const semanticCursor = (kind: string, basis: Row, position: Row): string => {
  // The resumable position must cross the tool boundary, but the often-large
  // typed basis need not. Bind that exact basis into the digest so a compact
  // cursor still fails closed when either the request or token changes.
  const payload = { kind, position } satisfies SemanticCursorPayload;
  const payloadBytes = new TextEncoder().encode(canonicalJson(payload));
  const digest = sha256Hex(new TextEncoder().encode(canonicalJson({ basis, ...payload })));
  return `semantic-page-v2.${digest}.${base64UrlFromBytes(payloadBytes)}`;
};

const parseSemanticCursor = (cursor: string | undefined, kind: string, basis: Row): Row | null => {
  if (!cursor) return null;
  const match = /^semantic-page-v2\.([0-9a-f]{64})\.([A-Za-z0-9_-]+)$/u.exec(cursor);
  if (!match) {
    throw new SemanticVcsError("InvalidReference", `Invalid ${kind} cursor`);
  }
  try {
    const payloadBytes = bytesFromBase64Url(match[2]!);
    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes)) as
      | SemanticCursorPayload
      | undefined;
    if (
      !payload ||
      payload.kind !== kind ||
      !payload.position ||
      typeof payload.position !== "object"
    ) {
      throw new Error("basis mismatch");
    }
    const canonicalPayload = base64UrlFromBytes(
      new TextEncoder().encode(canonicalJson({ kind: payload.kind, position: payload.position }))
    );
    if (canonicalPayload !== match[2]) throw new Error("non-canonical payload");
    const digest = sha256Hex(
      new TextEncoder().encode(
        canonicalJson({ basis, kind: payload.kind, position: payload.position })
      )
    );
    if (digest !== match[1]) throw new Error("digest mismatch");
    return payload.position;
  } catch {
    throw new SemanticVcsError("InvalidReference", `${kind} cursor does not match its exact basis`);
  }
};

const cursorOffset = (cursor: string | undefined, basis: Row): number => {
  const position = parseSemanticCursor(cursor, "compare", basis);
  if (!position) return 0;
  const value = position["offset"];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new SemanticVcsError("InvalidReference", "Invalid compare cursor position");
  }
  return Number(value);
};

type NeighborPosition = Readonly<{ phase: number; key: string }>;
type PositionedNeighborEdge = Readonly<{ position: NeighborPosition; edge: Row }>;
type PositionedHistoryEntry = Readonly<{ position: NeighborPosition; entry: Row }>;
type NeighborPhaseQuery = Readonly<{
  phase: number;
  edgeKind?: string;
  sql: string;
  params: readonly unknown[];
}>;

const parseNeighborCursor = (
  cursor: string | undefined,
  basis: Row
): Readonly<{ phase: number; key: string | null }> => {
  const position = parseSemanticCursor(cursor, "neighbors", basis);
  if (!position) return { phase: 0, key: null };
  const phase = Number(position["phase"]);
  const key = position["key"];
  if (!Number.isSafeInteger(phase) || phase < 0 || phase > 100) {
    throw new SemanticVcsError("InvalidReference", "Invalid neighbor cursor");
  }
  if (typeof key !== "string")
    throw new SemanticVcsError("InvalidReference", "Invalid neighbor cursor");
  return { phase, key };
};

const neighborCursor = ({ phase, key }: NeighborPosition, basis: Row): string =>
  semanticCursor("neighbors", basis, { phase, key });

const exactProvenanceEdge = (value: Row): Row => {
  const parsed = vcsProvenanceEdgeSchema.safeParse(value);
  if (!parsed.success) {
    throw new SemanticVcsError("IntegrityFailure", "Normalized provenance relation is invalid", {
      relation: value["kind"],
      from: (value["from"] as Row | undefined)?.["kind"],
      to: (value["to"] as Row | undefined)?.["kind"],
    });
  }
  return parsed.data;
};

const parseHistoryCursor = (
  cursor: string | undefined,
  basis: Row
): Readonly<{ phase: number; key: string | null }> => {
  const position = parseSemanticCursor(cursor, "history", basis);
  if (!position) return { phase: 0, key: null };
  const phase = Number(position["phase"]);
  const key = position["key"];
  if (!Number.isSafeInteger(phase) || phase < 0 || phase > MAX_ANCESTRY_EDGES) {
    throw new SemanticVcsError("InvalidReference", "Invalid history cursor");
  }
  if (typeof key !== "string")
    throw new SemanticVcsError("InvalidReference", "Invalid history cursor");
  return { phase, key };
};

const historyCursor = ({ phase, key }: NeighborPosition, basis: Row): string =>
  semanticCursor("history", basis, { phase, key });

const parseBlameCursor = (
  cursor: string | undefined,
  range: { start: number; end: number },
  basis: Row
): number => {
  const position = parseSemanticCursor(cursor, "blame", basis);
  if (!position) return range.start;
  const nextStart = Number(position["nextStart"]);
  if (!Number.isSafeInteger(nextStart) || nextStart! < range.start || nextStart! >= range.end) {
    throw new SemanticVcsError("InvalidReference", "Blame cursor does not match the exact range");
  }
  return nextStart!;
};

const blameCursor = (basis: Row, nextStart: number): string =>
  semanticCursor("blame", basis, { nextStart });

const causalCommandRef = (ingress: SemanticDispatchRequest["ingress"]): CausalCommandRef => ({
  parent: ingress.causalParent
    ? {
        logId: ingress.causalParent.logId,
        head: ingress.causalParent.head,
        invocationId: ingress.causalParent.invocationId,
      }
    : null,
});

const persistedEffectIntegrity = (
  payload: Row
): SemanticDispatchRequest["ingress"]["contextIntegrity"] => {
  const value = payload["contextIntegrity"];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SemanticVcsError(
      "IntegrityFailure",
      "Pending semantic content observation has no persisted context-integrity fact"
    );
  }
  const record = value as Row;
  const externalKeys = record["externalKeys"];
  if (
    (record["class"] !== "internal" && record["class"] !== "external") ||
    !Array.isArray(externalKeys) ||
    !externalKeys.every((key) => typeof key === "string" && key.length > 0) ||
    (record["class"] === "internal" && externalKeys.length > 0)
  ) {
    throw new SemanticVcsError(
      "IntegrityFailure",
      "Pending semantic content observation has an invalid context-integrity fact"
    );
  }
  return {
    class: record["class"],
    externalKeys: externalKeys as string[],
  };
};

export class SemanticWorkspace {
  constructor(private readonly deps: SemanticWorkspaceDeps) {}

  listContexts(prefix?: string): string[] {
    return this.deps.store.listContexts(prefix);
  }

  isStateDescendant(ancestor: StateNodeRef, descendant: StateNodeRef, maxEdges: number): boolean {
    return this.deps.store.isStateAncestor(ancestor, descendant, maxEdges);
  }

  pendingEffects(): SemanticEffect[] {
    return this.deps.store.pendingEffects();
  }

  contentGcRoots(): { contentRoots: string[]; contentHashes: string[] } {
    const contentRoots = new Set<string>();
    const contentHashes = new Set<string>();
    for (const row of this.deps.sql
      .exec(`SELECT DISTINCT content_root FROM gad_materialized_repository_states`)
      .toArray() as Row[]) {
      contentRoots.add(String(row["content_root"]));
    }
    for (const row of this.deps.sql
      .exec(`SELECT DISTINCT content_hash FROM vcs_file_states WHERE content_hash IS NOT NULL`)
      .toArray() as Row[]) {
      contentHashes.add(String(row["content_hash"]));
    }
    for (const row of this.deps.sql
      .exec(
        `SELECT change.base_json, change.result_json
           FROM gad_external_deltas delta
           JOIN gad_changes change ON change.work_unit_id = delta.work_unit_id
          WHERE delta.status = 'active'`
      )
      .toArray() as Row[]) {
      for (const column of ["base_json", "result_json"] as const) {
        if (row[column] == null) continue;
        const endpoint = JSON.parse(String(row[column])) as Row;
        if (typeof endpoint["contentHash"] === "string") {
          contentHashes.add(endpoint["contentHash"]);
        }
      }
    }
    // Pending effects are durable semantic roots too. Their self-contained
    // payloads may name content before the corresponding state is receipted.
    const visit = (value: unknown): void => {
      if (typeof value === "string") {
        if (/^state:[0-9a-f]{64}$/u.test(value)) contentRoots.add(value);
        else if (/^[0-9a-f]{64}$/u.test(value)) contentHashes.add(value);
      } else if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else if (value && typeof value === "object") {
        for (const item of Object.values(value)) visit(item);
      }
    };
    for (const effect of this.deps.store.pendingEffects()) visit(effect.payload);
    return {
      contentRoots: [...contentRoots].sort(compareUtf16CodeUnits),
      contentHashes: [...contentHashes].sort(compareUtf16CodeUnits),
    };
  }

  referencesReachable(
    contextIds: readonly string[],
    references: readonly { kind: string; value: unknown }[]
  ): boolean {
    if (contextIds.length === 0) return false;
    return references.every((reference) => {
      if (reference.kind === "state-node") {
        return this.referenceStateReachable(contextIds, reference.value);
      }
      if (reference.kind === "event" && typeof reference.value === "string") {
        return this.referenceStateReachable(contextIds, {
          kind: "event",
          eventId: reference.value,
        });
      }
      if (reference.kind === "external-delta" && typeof reference.value === "string") {
        const delta = this.deps.store.externalDelta(reference.value);
        return delta !== null && this.referenceStateReachable(contextIds, delta.targetState);
      }
      if (reference.kind === "node" && reference.value && typeof reference.value === "object") {
        const node = reference.value as Row;
        if (node["kind"] === "event" || node["kind"] === "application") {
          return this.referenceStateReachable(contextIds, node);
        }
        if (node["kind"] === "repository" || node["kind"] === "file") {
          return this.referenceStateReachable(contextIds, node["state"]);
        }
        return this.provenanceNodeReachable(contextIds, node);
      }
      return true;
    });
  }

  private referenceStateReachable(contextIds: readonly string[], value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const state = value as Row;
    const readableEventRoots = new Set<string>();
    for (const contextId of contextIds) {
      const context = this.deps.store.context(contextId);
      if (!context) continue;
      readableEventRoots.add(context.committed.ref.eventId);
      // An integration decision is a deliberate causal edge from this
      // context's live working chain to its source event. Keep that source
      // readable through the target context even after a supervised child is
      // safely closed; otherwise an exact commit-source confirmation can be
      // rejected immediately before commit despite the same service deriving
      // that source from the recorded decision.
      const workingChain = this.deps.store.workingChain(contextId, MAX_WORKING_APPLICATIONS);
      for (const sourceEventId of this.integrationSourceEventIds(workingChain.applicationIds)) {
        readableEventRoots.add(sourceEventId);
      }
      const workingApplicationId =
        context.working.ref.kind === "application" ? context.working.ref.applicationId : null;
      if (state["kind"] === "application" && typeof state["applicationId"] === "string") {
        const applicationId = state["applicationId"];
        if (workingApplicationId) {
          const inWorkingChain = this.deps.sql
            .exec(
              `WITH RECURSIVE chain(application_id, basis_kind, basis_id) AS (
                 SELECT application_id, basis_kind, basis_id
                   FROM gad_work_unit_applications WHERE application_id = ?
                 UNION
                 SELECT parent.application_id, parent.basis_kind, parent.basis_id
                   FROM chain child
                   JOIN gad_work_unit_applications parent
                     ON child.basis_kind = 'application' AND parent.application_id = child.basis_id
               ) SELECT 1 FROM chain WHERE application_id = ? LIMIT 1`,
              workingApplicationId,
              applicationId
            )
            .toArray();
          if (inWorkingChain.length > 0) return true;
        }
      }
    }
    if (readableEventRoots.size === 0) return false;

    // Protected main is the shared collaboration boundary. Publishing makes
    // that exact event and its semantic ancestry readable to every valid
    // context, while unpublished sibling branches remain private. Without
    // this root, status can disclose that main advanced but the caller cannot
    // compare, incrementally integrate, publish against, or walk the history
    // it was explicitly told to reconcile.
    const mainEventId = this.deps.store.mainEventId();
    if (mainEventId) readableEventRoots.add(mainEventId);

    if (state["kind"] === "application" && typeof state["applicationId"] === "string") {
      const committedBy = this.deps.sql
        .exec(
          `SELECT event_id FROM gad_workspace_event_applications WHERE application_id = ?`,
          state["applicationId"]
        )
        .toArray() as Row[];
      return committedBy.some((row) =>
        [...readableEventRoots].some((rootEventId) =>
          this.deps.store.isEventAncestor(String(row["event_id"]), rootEventId, MAX_ANCESTRY_EDGES)
        )
      );
    }
    if (state["kind"] === "event" && typeof state["eventId"] === "string") {
      return [...readableEventRoots].some((rootEventId) =>
        this.deps.store.isEventAncestor(state["eventId"] as string, rootEventId, MAX_ANCESTRY_EDGES)
      );
    }
    return false;
  }

  private provenanceNodeReachable(contextIds: readonly string[], node: Row): boolean {
    const kind = String(node["kind"] ?? "");
    let applicationIds: string[] = [];
    if (kind === "work-unit" && typeof node["workUnitId"] === "string") {
      applicationIds = (
        this.deps.sql
          .exec(
            `SELECT application_id FROM gad_work_unit_applications WHERE work_unit_id = ?`,
            node["workUnitId"]
          )
          .toArray() as Row[]
      ).map((row) => String(row["application_id"]));
    } else if (kind === "change" && typeof node["changeId"] === "string") {
      applicationIds = (
        this.deps.sql
          .exec(
            `SELECT app.application_id FROM gad_changes change
             JOIN gad_work_unit_applications app ON app.work_unit_id = change.work_unit_id
            WHERE change.change_id = ?`,
            node["changeId"]
          )
          .toArray() as Row[]
      ).map((row) => String(row["application_id"]));
    } else if (kind === "applied-change" && typeof node["appliedChangeId"] === "string") {
      applicationIds = (
        this.deps.sql
          .exec(
            `SELECT application_id FROM gad_applied_changes WHERE applied_change_id = ?`,
            node["appliedChangeId"]
          )
          .toArray() as Row[]
      ).map((row) => String(row["application_id"]));
    } else if (kind === "decision" && typeof node["decisionId"] === "string") {
      applicationIds = (
        this.deps.sql
          .exec(
            `SELECT app.application_id FROM gad_integration_decisions decision
             JOIN gad_work_unit_applications app ON app.work_unit_id = decision.work_unit_id
            WHERE decision.decision_id = ?`,
            node["decisionId"]
          )
          .toArray() as Row[]
      ).map((row) => String(row["application_id"]));
    } else if (kind === "command" && typeof node["commandId"] === "string") {
      return this.commandReachable(contextIds, node["commandId"]);
    } else if (
      kind === "trajectory" &&
      typeof node["logId"] === "string" &&
      typeof node["head"] === "string"
    ) {
      const commands = this.deps.sql
        .exec(
          `SELECT command_id FROM vcs_command_journal
            WHERE cause_log_id = ? AND cause_head = ?`,
          node["logId"],
          node["head"]
        )
        .toArray() as Row[];
      return commands.some((row) => this.commandReachable(contextIds, String(row["command_id"])));
    } else if (
      kind === "trajectory-invocation" &&
      typeof node["logId"] === "string" &&
      typeof node["head"] === "string" &&
      typeof node["invocationId"] === "string"
    ) {
      const commands = this.deps.sql
        .exec(
          `SELECT command.command_id
             FROM vcs_command_journal command
             JOIN trajectory_invocations invocation
               ON invocation.log_id = command.cause_log_id
              AND invocation.head = command.cause_head
              AND invocation.invocation_id = command.cause_invocation_id
            WHERE invocation.log_id = ? AND invocation.head = ?
              AND invocation.invocation_id = ?`,
          node["logId"],
          node["head"],
          node["invocationId"]
        )
        .toArray() as Row[];
      return commands.some((row) => this.commandReachable(contextIds, String(row["command_id"])));
    } else if (
      kind === "trajectory-turn" &&
      typeof node["logId"] === "string" &&
      typeof node["head"] === "string" &&
      typeof node["turnId"] === "string"
    ) {
      const commands = this.deps.sql
        .exec(
          `SELECT command.command_id
             FROM vcs_command_journal command
             JOIN trajectory_invocations invocation
               ON invocation.log_id = command.cause_log_id
              AND invocation.head = command.cause_head
              AND invocation.invocation_id = command.cause_invocation_id
             JOIN trajectory_turns turn
               ON turn.log_id = invocation.log_id
              AND turn.head = invocation.head
              AND turn.turn_id = invocation.turn_id
            WHERE turn.log_id = ? AND turn.head = ? AND turn.turn_id = ?`,
          node["logId"],
          node["head"],
          node["turnId"]
        )
        .toArray() as Row[];
      return commands.some((row) => this.commandReachable(contextIds, String(row["command_id"])));
    } else if (
      kind === "trajectory-message" &&
      typeof node["logId"] === "string" &&
      typeof node["head"] === "string" &&
      typeof node["messageId"] === "string"
    ) {
      const commands = this.deps.sql
        .exec(
          `SELECT command.command_id
             FROM vcs_command_journal command
             JOIN trajectory_invocations invocation
               ON invocation.log_id = command.cause_log_id
              AND invocation.head = command.cause_head
              AND invocation.invocation_id = command.cause_invocation_id
             JOIN trajectory_turns turn
               ON turn.log_id = invocation.log_id
              AND turn.head = invocation.head
              AND turn.turn_id = invocation.turn_id
             JOIN trajectory_messages message
               ON message.log_id = turn.log_id
              AND message.head = turn.head
              AND message.message_id = turn.trigger_message_id
            WHERE message.log_id = ? AND message.head = ? AND message.message_id = ?`,
          node["logId"],
          node["head"],
          node["messageId"]
        )
        .toArray() as Row[];
      return commands.some((row) => this.commandReachable(contextIds, String(row["command_id"])));
    } else {
      // Trajectory and command roots have their own service authorization;
      // semantic leaf ids without a state association are never accepted as
      // an exact-state authorization root here.
      return false;
    }
    return applicationIds.some((applicationId) =>
      this.referenceStateReachable(contextIds, { kind: "application", applicationId })
    );
  }

  private commandReachable(contextIds: readonly string[], commandId: string): boolean {
    const journal = this.deps.sql
      .exec(`SELECT scope_kind, scope_id FROM vcs_command_journal WHERE command_id = ?`, commandId)
      .toArray()[0] as Row | undefined;
    if (journal?.["scope_kind"] === "context" && contextIds.includes(String(journal["scope_id"]))) {
      return true;
    }
    const events = this.deps.sql
      .exec(`SELECT event_id FROM gad_workspace_events WHERE command_id = ?`, commandId)
      .toArray() as Row[];
    if (
      events.some((row) =>
        this.referenceStateReachable(contextIds, { kind: "event", eventId: row["event_id"] })
      )
    )
      return true;
    const applications = this.deps.sql
      .exec(
        `SELECT app.application_id FROM gad_work_units work
           JOIN gad_work_unit_applications app ON app.work_unit_id = work.work_unit_id
          WHERE work.command_id = ?`,
        commandId
      )
      .toArray() as Row[];
    return applications.some((row) =>
      this.referenceStateReachable(contextIds, {
        kind: "application",
        applicationId: row["application_id"],
      })
    );
  }

  async dispatch(
    method: string,
    request: SemanticDispatchRequest
  ): Promise<SemanticDispatchResult> {
    const canonical = method.startsWith("vcs")
      ? `${method.slice(3, 4).toLowerCase()}${method.slice(4)}`
      : method;
    if (!(canonical in this.publicMethods())) {
      throw new SemanticVcsError("InvalidReference", `Unsupported VCS method ${method}`);
    }
    const name = canonical as VcsSemanticMethodName;
    const parsed = parseVcsSemanticRequest(name, request.input).input;
    switch (name) {
      case "edit":
        return this.edit(parsed as VcsEditInput, request);
      case "move":
        return this.move(parsed as VcsMoveInput, request);
      case "copy":
        return this.copy(parsed as VcsCopyInput, request);
      case "merge":
        return this.merge(parsed as VcsMergeInput, request);
      case "revert":
        return this.revert(parsed as VcsRevertInput, request);
      case "commit":
        return this.commit(
          parsed as import("@vibestudio/service-schemas/vcs").VcsCommitInput,
          request
        );
      case "discard":
        return this.discard(parsed as VcsDiscardInput, request);
      case "importSnapshot":
        return this.importSnapshot(parsed as VcsImportSnapshotInput, request);
      case "registerExternalDelta":
        return this.registerExternalDelta(parsed as VcsRegisterExternalDeltaInput, request);
      case "supersedeExternalDelta":
        return this.externalDeltaLifecycle(
          "supersedeExternalDelta",
          parsed as VcsExternalDeltaLifecycleInput,
          request
        );
      case "finalizeExternalDelta":
        return this.externalDeltaLifecycle(
          "finalizeExternalDelta",
          parsed as VcsExternalDeltaLifecycleInput,
          request
        );
      case "push":
        return this.push(parsed as VcsPushInput, request);
      case "status":
        return { kind: "complete", result: this.status(parsed as VcsStatusInput) };
      case "mainState": {
        const eventId = this.deps.store.mainEventId();
        if (!eventId) throw new SemanticVcsError("InvalidReference", "Workspace main is not initialized");
        return { kind: "complete", result: { kind: "event", eventId } };
      }
      case "compare":
        return this.compare(parsed as VcsCompareInput, request);
      case "inspect":
        return { kind: "complete", result: this.inspect(parsed as VcsInspectInput) };
      case "neighbors":
        return { kind: "complete", result: this.neighbors(parsed as VcsNeighborsInput) };
      case "history":
        return { kind: "complete", result: this.history(parsed as VcsHistoryInput) };
      case "blame":
        return { kind: "complete", result: this.blame(parsed as VcsBlameInput) };
      case "walk":
        return { kind: "complete", result: this.walk(parsed as VcsWalkInput) };
      case "query":
        return { kind: "complete", result: this.query(parsed as VcsQueryInput) };
      case "search":
        return { kind: "complete", result: this.search(parsed as VcsSearchInput) };
      case "readMemory":
        return {
          kind: "complete",
          result: this.readMemory(parsed as VcsReadMemoryInput),
        };
      case "resolveRepository":
        return {
          kind: "complete",
          result: this.resolveRepository(parsed as VcsResolveRepositoryInput),
        };
      case "readFile":
        return this.readFile(parsed as VcsReadFileInput);
      case "listDirectory":
        return {
          kind: "complete",
          result: this.listDirectory(parsed as VcsListDirectoryInput),
        };
      case "listFiles":
        return { kind: "complete", result: this.listFiles(parsed as VcsListFilesInput) };
    }
  }

  acknowledgeEffect(input: SemanticEffectAcknowledgement): SemanticDispatchResult {
    const pending = this.deps.store
      .pendingEffects()
      .find((effect) => effect.effectId === input.effectId);
    if (!pending) {
      throw new SemanticVcsError("InvalidReference", `Unknown pending effect ${input.effectId}`);
    }
    if (pending.kind === "observe-content") {
      return this.deps.transaction(() => {
        this.deps.store.acknowledgeEffect({
          ...input,
          deferCommandCompletion: true,
        });
        const method = String(pending.payload["method"]);
        const commandInput = pending.payload["input"] as Row;
        if (method === "importSnapshot") {
          const profileStartedAt = Date.now();
          const importInput = parseVcsSemanticRequest("importSnapshot", commandInput)
            .input as VcsImportSnapshotInput;
          const parseCompletedAt = Date.now();
          const planned = this.planImportSnapshot(importInput, input.receipt);
          const planCompletedAt = Date.now();
          const working = this.persistWorkingMutation(
            importInput,
            planned.draft,
            pending.commandId,
            persistedEffectIntegrity(pending.payload)
          );
          const persistCompletedAt = Date.now();
          const committed = this.deps.store.commit({
            contextId: importInput.contextId,
            expectedWorkingHead: working.workingHead,
            commandId: pending.commandId,
            message:
              importInput.message ??
              `Import ${
                importInput.source.kind === "git"
                  ? importInput.source.commit
                  : importInput.source.snapshotRevision
              }`,
            integratesEventIds: [],
            maxApplications: MAX_WORKING_APPLICATIONS,
          });
          this.indexEventMessage(committed.event.eventId, committed.event.message ?? null);
          const commitCompletedAt = Date.now();
          const result = {
            contextId: importInput.contextId,
            eventId: committed.event.eventId,
            workUnitId: working.workUnitId,
            applicationId: working.applicationId,
            externalSnapshot: planned.externalSnapshot,
            importedRepositoryIds: planned.importedRepositoryIds,
          };
          const projection = pending.payload["projection"];
          if (projection !== "required" && projection !== "deferred") {
            throw internalSemanticIntegrityFailure(
              "EffectMismatch",
              `Snapshot import has invalid projection policy ${String(projection)}`,
              { contract: "import-observation" }
            );
          }
          const materialization =
            projection === "required"
              ? this.queueRealization(
                  importInput.contextId,
                  pending.commandId,
                  asState(importInput.expectedWorkingHead),
                  committed.context.working.ref,
                  [],
                  planned.draft
                )
              : null;
          const materializationPlanCompletedAt = Date.now();
          this.deps.store.updatePendingCommandResult({
            scopeKind: "context",
            scopeId: importInput.contextId,
            commandId: pending.commandId,
            result,
          });
          this.deps.store.compactAppliedObservation(pending.effectId);
          if (!materialization) {
            this.deps.store.finishEffectPendingCommand({
              scopeKind: "context",
              scopeId: importInput.contextId,
              commandId: pending.commandId,
            });
          }
          const journalCompletedAt = Date.now();
          const totalMs = journalCompletedAt - profileStartedAt;
          if (totalMs >= 100) {
            console.info("[VcsProfile] import snapshot acknowledgement", {
              repositories: importInput.repositories.length,
              files: importInput.repositories.reduce(
                (count, repository) => count + repository.files.length,
                0
              ),
              parseMs: parseCompletedAt - profileStartedAt,
              planMs: planCompletedAt - parseCompletedAt,
              persistMs: persistCompletedAt - planCompletedAt,
              commitMs: commitCompletedAt - persistCompletedAt,
              materializationPlanMs: materializationPlanCompletedAt - commitCompletedAt,
              journalMs: journalCompletedAt - materializationPlanCompletedAt,
              totalMs,
            });
          }
          return materialization
            ? { kind: "effects-pending", result, effects: [materialization] }
            : { kind: "complete", result };
        }
        if (method === "registerExternalDelta") {
          const deltaInput = parseVcsSemanticRequest("registerExternalDelta", commandInput)
            .input as VcsRegisterExternalDeltaInput;
          const result = this.persistExternalDelta(deltaInput, input.receipt);
          this.deps.store.updatePendingCommandResult({
            scopeKind: "context",
            scopeId: deltaInput.contextId,
            commandId: pending.commandId,
            result,
          });
          this.deps.store.compactAppliedObservation(pending.effectId);
          this.deps.store.finishEffectPendingCommand({
            scopeKind: "context",
            scopeId: deltaInput.contextId,
            commandId: pending.commandId,
          });
          return { kind: "complete", result };
        }
        const draft =
          method === "edit"
            ? this.planEdit(commandInput as unknown as VcsEditInput, input.receipt)
            : null;
        if (!draft) {
          throw new SemanticVcsError("IntegrityFailure", `Observation cannot resume ${method}`);
        }
        const result = this.persistWorkingMutation(
          commandInput as unknown as VcsEditInput,
          draft,
          pending.commandId,
          persistedEffectIntegrity(pending.payload)
        );
        const projection = this.queueRealization(
          commandInput["contextId"] as string,
          pending.commandId,
          asState((commandInput as unknown as VcsEditInput).expectedWorkingHead),
          result.workingHead as StateNodeRef,
          draft.blobs ?? [],
          draft
        );
        this.deps.store.updatePendingCommandResult({
          scopeKind: "context",
          scopeId: String(commandInput["contextId"]),
          commandId: pending.commandId,
          result,
        });
        this.deps.store.compactAppliedObservation(pending.effectId);
        if (!projection) {
          this.deps.store.finishEffectPendingCommand({
            scopeKind: "context",
            scopeId: String(commandInput["contextId"]),
            commandId: pending.commandId,
          });
          return { kind: "complete", result };
        }
        return { kind: "effects-pending", result, effects: [projection] };
      });
    }
    const contentOnlyMaterialization =
      pending.kind === "materialize-context" && pending.payload["mode"] === "content-only";
    if (contentOnlyMaterialization) {
      const payloadBlobs = pending.payload["blobs"];
      const receiptVersion = input.receipt["version"];
      const receiptHashes = input.receipt["contentHashes"];
      if (!Array.isArray(payloadBlobs) || payloadBlobs.length === 0) {
        throw internalSemanticIntegrityFailure(
          "EffectMismatch",
          "Content persistence effect lacks blobs",
          { effectId: pending.effectId, contract: "content-persistence-receipt" }
        );
      }
      const expected = payloadBlobs
        .map((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return "";
          return String((value as Row)["contentHash"] ?? "");
        })
        .sort(compareUtf16CodeUnits);
      const received = Array.isArray(receiptHashes)
        ? receiptHashes.map(String).sort(compareUtf16CodeUnits)
        : [];
      if (
        receiptVersion !== 1 ||
        expected.some((contentHash) => !/^[0-9a-f]{64}$/u.test(contentHash)) ||
        new Set(expected).size !== expected.length ||
        canonicalJson(received) !== canonicalJson(expected)
      ) {
        throw internalSemanticIntegrityFailure(
          "EffectMismatch",
          `Receipt does not prove content persistence effect ${pending.effectId}`,
          { effectId: pending.effectId, contract: "content-persistence-receipt" }
        );
      }
    }
    if (
      pending.kind === "materialize-context" &&
      !contentOnlyMaterialization &&
      !contextMaterializationReceiptProves(
        pending.payload as unknown as ContextMaterializationCommand,
        input.receipt as unknown as ContextMaterializationReceipt
      )
    ) {
      throw internalSemanticIntegrityFailure(
        "EffectMismatch",
        `Receipt does not prove materialization effect ${pending.effectId}`,
        { effectId: pending.effectId, contract: "materialization-receipt" }
      );
    }
    const applied = this.deps.transaction(() => {
      if (pending.kind === "publish-main") {
        const appliedAt = input.receipt["appliedAt"];
        if (typeof appliedAt !== "string" || !appliedAt) {
          throw internalSemanticIntegrityFailure(
            "EffectMismatch",
            "Publication receipt lacks its host application time",
            { effectId: pending.effectId, contract: "publication-applied-at" }
          );
        }
        this.deps.store.updatePendingCommandResult({
          scopeKind: pending.scopeKind,
          scopeId: pending.scopeId,
          commandId: pending.commandId,
          result: {
            contextId: pending.payload["contextId"],
            eventId: pending.payload["publishedEventId"],
            mainEventId: pending.payload["publishedEventId"],
            effectId: pending.effectId,
            appliedAt,
          },
        });
      }
      return this.deps.store.acknowledgeEffect(input);
    });
    const command = this.deps.store.command(applied.commandId);
    return {
      kind: "complete",
      result: command?.result ?? { effectId: applied.effectId, receipt: input.receipt },
    };
  }

  acknowledgeHostRead(input: {
    request: Row;
    files: Array<{ contentHash: string; text: string }>;
  }): SemanticDispatchResult {
    if (input.request["kind"] !== "read-merge-content") {
      throw new SemanticVcsError(
        "InvalidReference",
        "Unsupported semantic host-read acknowledgement"
      );
    }
    const operation = input.request["operation"];
    if (operation !== "compare" && operation !== "merge") {
      throw new SemanticVcsError("InvalidReference", "Unknown merge-content operation");
    }
    const expected = new Set(
      Array.isArray(input.request["contentHashes"])
        ? input.request["contentHashes"].map(String)
        : []
    );
    const observed = new Map<string, string>();
    for (const file of input.files) {
      if (!expected.has(file.contentHash) || observed.has(file.contentHash)) {
        throw internalSemanticIntegrityFailure(
          "EffectMismatch",
          `Merge observation contains unexpected or duplicate content ${file.contentHash}`,
          { contract: "merge-content-observation", contentHash: file.contentHash }
        );
      }
      const bytes = new TextEncoder().encode(file.text);
      if (sha256Hex(bytes) !== file.contentHash) {
        throw internalSemanticIntegrityFailure(
          "EffectMismatch",
          `Merge observation does not match ${file.contentHash}`,
          { contract: "merge-content-observation", contentHash: file.contentHash }
        );
      }
      observed.set(file.contentHash, file.text);
    }
    if (observed.size !== expected.size) {
      throw internalSemanticIntegrityFailure(
        "EffectMismatch",
        "Merge content observation is incomplete",
        { contract: "merge-content-observation" }
      );
    }
    const request = {
      input: input.request["input"],
      ingress: input.request["ingress"],
    } as SemanticDispatchRequest;
    if (operation === "compare") {
      const parsed = parseVcsSemanticRequest("compare", request.input).input as VcsCompareInput;
      return this.compare(parsed, request, observed);
    }
    const parsed = parseVcsSemanticRequest("merge", request.input).input as VcsMergeInput;
    return this.merge(parsed, request, observed);
  }

  ensureContext(
    input: { contextId: string; commandId: string },
    ingress: SemanticDispatchRequest["ingress"]
  ): SemanticDispatchResult {
    return this.ensureContextWithProjection(input, ingress, "required");
  }

  /**
   * Establish the durable context frontier without requesting disposable host
   * projection bytes. Runtime entities use this attachment boundary; the first
   * filesystem consumer later calls the projected ensure path above.
   */
  ensureContextCoordinate(
    input: { contextId: string; commandId: string },
    ingress: SemanticDispatchRequest["ingress"]
  ): SemanticDispatchResult {
    return this.ensureContextWithProjection(input, ingress, "deferred");
  }

  /**
   * Import into a coordinate-only bootstrap context. Exact workspace-source
   * initialization publishes the result immediately and already owns the
   * identical checked-out bytes, so projecting this private context would
   * write the complete workspace a second time before readiness.
   */
  importSnapshotCoordinate(
    input: VcsImportSnapshotInput,
    ingress: SemanticDispatchRequest["ingress"]
  ): SemanticDispatchResult {
    const parsed = parseVcsSemanticRequest("importSnapshot", input).input;
    return this.importSnapshot(
      parsed as VcsImportSnapshotInput,
      { input: parsed as Row, ingress },
      "deferred"
    );
  }

  private ensureContextWithProjection(
    input: { contextId: string; commandId: string },
    ingress: SemanticDispatchRequest["ingress"],
    projection: "required" | "deferred"
  ): SemanticDispatchResult {
    return this.deps.transaction(() => {
      const existing = this.deps.store.beginCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        method: projection === "required" ? "ensure-context" : "ensure-context-coordinate",
        requestDigest: compactId(
          projection === "required"
            ? "ensure-context-request"
            : "ensure-context-coordinate-request",
          input
        ),
        cause: causalCommandRef(ingress),
      });
      if (existing) {
        const context = this.deps.store.context(input.contextId);
        if (!context) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Initialized context ${input.contextId} is missing`
          );
        }
        const effects = this.deps.store.pendingEffects(input.commandId);
        return effects.length > 0
          ? { kind: "effects-pending", result: context, effects }
          : { kind: "complete", result: context };
      }
      // `ensureContext` is also the attachment path for runtime entities. A
      // context may therefore already exist because a lifecycle operation
      // (notably fork/clone/subagent creation) created and materialized its
      // exact frontier first. In that case there is no semantic transition to
      // project: the host verifies the recorded projection after this dispatch
      // and derives an exact-basis repair if the disposable bytes are missing.
      // Queuing another initialize effect here would falsely claim an absent
      // materialization basis and collide with the fork's valid projection.
      const existingContext = this.deps.store.context(input.contextId);
      const context =
        existingContext ?? this.deps.store.ensureContext(input.contextId, input.commandId);
      if (!existingContext || projection === "required") {
        this.deps.store.setContextProjection(input.contextId, projection);
      }
      if (existingContext || projection === "deferred") {
        this.deps.store.finishCommand({
          scopeKind: "context",
          scopeId: input.contextId,
          commandId: input.commandId,
          result: context,
          effectPending: false,
        });
        return { kind: "complete", result: context };
      }
      const effect = this.queueRealization(
        input.contextId,
        input.commandId,
        null,
        context.working.ref,
        []
      );
      if (!effect) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Required context ${input.contextId} did not request materialization`
        );
      }
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result: context,
        effectPending: true,
      });
      return { kind: "effects-pending", result: context, effects: [effect] };
    });
  }

  contextMaterializationCommand(
    contextId: string,
    materializedState: StateNodeRef | null
  ): ContextMaterializationCommand {
    const context = this.deps.store.context(contextId);
    if (!context) throw new SemanticVcsError("InvalidReference", `Unknown context ${contextId}`);
    const commandId = compactId("context-materialization-repair", {
      contextId,
      materializedState,
      targetState: context.working.ref,
    });
    return this.buildMaterializationCommand(
      contextId,
      commandId,
      "replace",
      materializedState,
      context.working.ref,
      []
    );
  }

  forkContext(
    input: { sourceContextId: string; targetContextId: string; commandId: string },
    ingress: SemanticDispatchRequest["ingress"]
  ): SemanticDispatchResult {
    return this.deps.transaction(() => {
      const existing = this.deps.store.beginCommand({
        scopeKind: "context",
        scopeId: input.targetContextId,
        commandId: input.commandId,
        method: "fork-context",
        requestDigest: compactId("fork-context-request", input),
        cause: causalCommandRef(ingress),
      });
      if (existing) {
        const effects = this.deps.store.pendingEffects(input.commandId);
        return effects.length > 0
          ? { kind: "effects-pending", result: existing.result, effects }
          : { kind: "complete", result: existing.result };
      }
      const context = this.deps.store.forkContext(input.sourceContextId, input.targetContextId);
      const effect = this.queueRealization(
        input.targetContextId,
        input.commandId,
        null,
        context.working.ref,
        []
      );
      if (!effect) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Forked context ${input.targetContextId} did not request materialization`
        );
      }
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.targetContextId,
        commandId: input.commandId,
        result: context,
        effectPending: true,
      });
      return { kind: "effects-pending", result: context, effects: [effect] };
    });
  }

  private publicMethods(): Record<VcsSemanticMethodName, true> {
    return {
      edit: true,
      move: true,
      copy: true,
      merge: true,
      revert: true,
      commit: true,
      discard: true,
      importSnapshot: true,
      registerExternalDelta: true,
      supersedeExternalDelta: true,
      finalizeExternalDelta: true,
      push: true,
      status: true,
      mainState: true,
      compare: true,
      inspect: true,
      neighbors: true,
      history: true,
      blame: true,
      walk: true,
      query: true,
      search: true,
      readMemory: true,
      resolveRepository: true,
      readFile: true,
      listDirectory: true,
      listFiles: true,
    };
  }

  private mutationReplay<T extends { commandId: string; contextId: string }>(
    method: string,
    input: T,
    request: SemanticDispatchRequest
  ): SemanticDispatchResult | null {
    const requestDigest = compactId(`${method}-request`, input);
    const cause = causalCommandRef(request.ingress);
    if (cause.parent) {
      const invocation = this.deps.sql
        .exec(
          `SELECT 1 FROM trajectory_invocations
            WHERE log_id = ? AND head = ? AND invocation_id = ? LIMIT 1`,
          cause.parent.logId,
          cause.parent.head,
          cause.parent.invocationId
        )
        .toArray()[0];
      if (!invocation) {
        throw new SemanticVcsError(
          "InvalidReference",
          "Semantic mutation cause is not an exact trajectory invocation"
        );
      }
    }
    const existing = this.deps.store.beginCommand({
      scopeKind: "context",
      scopeId: input.contextId,
      commandId: input.commandId,
      method,
      requestDigest,
      cause,
    });
    if (!existing) return null;
    if (existing.status === "pending") {
      throw internalSemanticIntegrityFailure(
        "CommandInProgress",
        `Command ${input.commandId} is pending`,
        { commandId: input.commandId, expectedStatus: "effect-pending-or-complete" }
      );
    }
    const effects = this.deps.store.pendingEffects(input.commandId);
    return effects.length > 0
      ? { kind: "effects-pending", result: existing.result, effects }
      : { kind: "complete", result: existing.result };
  }

  /** Command admission and semantic mutation are one rollback boundary. */
  private runMutation<T extends { commandId: string; contextId: string }>(
    method: string,
    input: T,
    request: SemanticDispatchRequest,
    apply: () => SemanticDispatchResult
  ): SemanticDispatchResult {
    return this.deps.transaction(() => {
      const replay = this.mutationReplay(method, input, request);
      return replay ?? apply();
    });
  }

  private edit(input: VcsEditInput, request: SemanticDispatchRequest): SemanticDispatchResult {
    return this.runMutation("edit", input, request, () => {
      this.deps.store.assertExpectedWorking(input.contextId, asState(input.expectedWorkingHead));
      const textFiles = input.changes.filter(
        (change): change is Extract<VcsEditInput["changes"][number], { kind: "text-edit" }> =>
          change.kind === "text-edit"
      );
      if (textFiles.length > 0) {
        const root = this.deps.store.stateRoot(asState(input.expectedWorkingHead));
        const contentHashes = new Set<string>();
        for (const change of textFiles) {
          const point = this.deps.store.facts.file(root, change.fileId);
          if (!point || point.state.presence !== "placed") {
            throw new SemanticVcsError("InvalidReference", `Unknown file ${change.fileId}`);
          }
          contentHashes.add(point.state.contentHash);
        }
        const effect = this.deps.store.queueEffect({
          scopeKind: "context",
          scopeId: input.contextId,
          commandId: input.commandId,
          kind: "observe-content",
          payload: {
            method: "edit",
            representation: "bytes",
            input: input as unknown as Row,
            contextIntegrity: request.ingress.contextIntegrity as unknown as Row,
            files: [...contentHashes]
              .sort(compareUtf16CodeUnits)
              .map((contentHash) => ({ contentHash })),
          },
        });
        const result = { contextId: input.contextId, workingHead: input.expectedWorkingHead };
        this.deps.store.finishCommand({
          scopeKind: "context",
          scopeId: input.contextId,
          commandId: input.commandId,
          result,
          effectPending: true,
        });
        return { kind: "effects-pending", result, effects: [effect] };
      }
      const draft = this.planEdit(input, null);
      const result = this.persistWorkingMutation(
        input,
        draft,
        input.commandId,
        request.ingress.contextIntegrity
      );
      const effect = this.queueRealization(
        input.contextId,
        input.commandId,
        asState(input.expectedWorkingHead),
        result.workingHead,
        draft.blobs ?? [],
        draft
      );
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result,
        effectPending: effect !== null,
      });
      return effect
        ? { kind: "effects-pending", result, effects: [effect] }
        : { kind: "complete", result };
    });
  }

  private planEdit(input: VcsEditInput, receipt: Row | null): MutationDraft {
    const root = this.deps.store.stateRoot(asState(input.expectedWorkingHead));
    const observed = new Map<string, Uint8Array>();
    if (receipt) {
      const expectedContentHashes = new Set(
        input.changes
          .filter(
            (change): change is Extract<VcsEditInput["changes"][number], { kind: "text-edit" }> =>
              change.kind === "text-edit"
          )
          .map((change) => {
            const point = this.deps.store.facts.file(root, change.fileId);
            if (!point || point.state.presence !== "placed") {
              throw new SemanticVcsError("InvalidReference", `Unknown file ${change.fileId}`);
            }
            return point.state.contentHash;
          })
      );
      const rows = receipt["files"];
      if (!Array.isArray(rows)) {
        throw internalSemanticIntegrityFailure(
          "EffectMismatch",
          "Content observation lacks files",
          { contract: "edit-observation" }
        );
      }
      for (const value of rows) {
        if (!value || typeof value !== "object") {
          throw internalSemanticIntegrityFailure(
            "EffectMismatch",
            "Content observation contains an invalid file",
            { contract: "edit-observation" }
          );
        }
        const record = value as Row;
        const contentHash = String(record["contentHash"] ?? "");
        if (!expectedContentHashes.has(contentHash) || observed.has(contentHash)) {
          throw internalSemanticIntegrityFailure(
            "EffectMismatch",
            `Content observation contains an unexpected or duplicate digest ${contentHash}`,
            { contentHash, contract: "edit-observation" }
          );
        }
        const base64 = String(record["base64"] ?? "");
        const bytes = bytesFromBase64(base64);
        if (sha256Hex(bytes) !== contentHash) {
          throw internalSemanticIntegrityFailure(
            "EffectMismatch",
            `Observed content differs for ${contentHash}`,
            { contentHash, contract: "edit-observation" }
          );
        }
        observed.set(contentHash, bytes);
      }
      if (observed.size !== expectedContentHashes.size) {
        throw internalSemanticIntegrityFailure(
          "EffectMismatch",
          "Content observation is incomplete",
          { contract: "edit-observation" }
        );
      }
    }

    const changes: MutationDraft["changes"] = [];
    const fileResults: MutationDraft["fileResults"] = [];
    const repositoryResults: MutationDraft["repositoryResults"] = [];
    const blobs: NonNullable<MutationDraft["blobs"]> = [];
    const touched = new Set<string>();
    input.changes.forEach((change, operation) => {
      if (change.kind === "repository-create") {
        const occupied = this.deps.store.facts.repositoryAtPath(root, change.repoPath);
        if (occupied) {
          throw new SemanticVcsError(
            "DestinationOccupied",
            `Repository destination ${change.repoPath} is occupied`,
            { repositoryId: occupied.repositoryId, path: change.repoPath }
          );
        }
        const repositoryId = compactId("repository", {
          commandId: input.commandId,
          operation,
          repoPath: change.repoPath,
        });
        const repositoryChangeIndex = changes.length;
        changes.push({
          operation,
          ordinal: 0,
          kind: "repo-add",
          base: null,
          result: {
            kind: "repository",
            repositoryId,
            repoPath: change.repoPath,
          },
          payload: { repoPath: change.repoPath },
        });
        repositoryResults.push({
          repositoryId,
          expected: null,
          resultPath: change.repoPath,
          newRepository: true,
          changeRef: { kind: "authored", ordinal: repositoryChangeIndex },
        });
        change.files.forEach((file, fileIndex) => {
          assertSemanticVcsPathAdmissible(file.path);
          const bytes = contentBytes(file.content);
          const contentHash = sha256Hex(bytes);
          const fileId = compactId("file", {
            commandId: input.commandId,
            operation,
            repositoryId,
            path: file.path,
          });
          const result = {
            fileId,
            presence: "placed" as const,
            repositoryId,
            path: file.path,
            contentHash,
            mode: file.mode,
            ...contentDescriptor(file.content, bytes),
          };
          const fileChangeIndex = changes.length;
          changes.push({
            operation,
            ordinal: fileIndex + 1,
            kind: "file-create",
            base: missingEndpoint(result, change.repoPath),
            result: { kind: "file", ...result, repoPath: change.repoPath },
            payload: { path: file.path, mode: file.mode },
          });
          fileResults.push({
            fileId,
            expected: null,
            result,
            newFile: true,
            changeRef: { kind: "authored", ordinal: fileChangeIndex },
          });
          blobs.push({ contentHash, base64: base64FromBytes(bytes) });
        });
        return;
      }
      if ("fileId" in change && touched.has(change.fileId)) {
        throw new SemanticVcsError("RevisionChanged", `File ${change.fileId} is edited twice`);
      }
      if ("fileId" in change) touched.add(change.fileId);
      const repository = this.presentRepository(root, change.repositoryId);
      if (change.kind === "file-create") {
        assertSemanticVcsPathAdmissible(change.path);
        if (this.deps.store.facts.fileAtPath(root, change.repositoryId, change.path)) {
          throw new SemanticVcsError(
            "DestinationOccupied",
            `Destination ${change.path} is occupied`,
            { repositoryId: change.repositoryId, path: change.path }
          );
        }
        const bytes = contentBytes(change.content);
        const contentHash = sha256Hex(bytes);
        const fileId = compactId("file", {
          commandId: input.commandId,
          operation,
          repositoryId: change.repositoryId,
          path: change.path,
        });
        const result = {
          fileId,
          presence: "placed" as const,
          repositoryId: change.repositoryId,
          path: change.path,
          contentHash,
          mode: change.mode,
          ...contentDescriptor(change.content, bytes),
        };
        const resultEndpoint: Row = {
          kind: "file",
          ...result,
          repoPath: repository.repoPath,
        };
        changes.push({
          operation,
          ordinal: 0,
          kind: "file-create",
          base: missingEndpoint(result, repository.repoPath),
          result: resultEndpoint,
          payload: change as unknown as Row,
        });
        fileResults.push({
          fileId,
          expected: null,
          result,
          newFile: true,
          changeRef: { kind: "authored", ordinal: operation },
        });
        blobs.push({ contentHash, base64: base64FromBytes(bytes) });
        return;
      }
      const point = this.placedFile(root, change.repositoryId, change.fileId);
      const base = endpointForFile(point.state, point.repository);
      if (change.kind === "file-delete") {
        changes.push({
          operation,
          ordinal: 0,
          kind: "file-delete",
          base,
          result: missingEndpoint(point.state, repository.repoPath),
          payload: change as unknown as Row,
        });
        fileResults.push({
          fileId: change.fileId,
          expected: point.state,
          result: {
            fileId: change.fileId,
            presence: "deleted",
            priorFileStateId: point.state.fileStateId,
          },
          newFile: false,
          changeRef: { kind: "authored", ordinal: operation },
        });
        return;
      }
      let bytes: Uint8Array | null = null;
      let result: Omit<PlacedFileState, "fileStateId">;
      const { fileStateId: _priorFileStateId, ...prior } = point.state;
      if (change.kind === "file-mode") {
        result = { ...prior, mode: change.mode };
      } else if (change.kind === "binary-replace") {
        bytes = bytesFromBase64(change.base64);
        result = {
          ...prior,
          contentHash: sha256Hex(bytes),
          contentKind: "bytes",
          byteLength: bytes.length,
          coordinateExtent: bytes.length,
          ...(change.mode !== undefined ? { mode: change.mode } : {}),
        };
      } else {
        if (point.state.contentKind !== "text") {
          throw new SemanticVcsError(
            "RevisionChanged",
            `Text edit requires text content for ${change.fileId}`
          );
        }
        const before = observed.get(point.state.contentHash);
        if (!before)
          throw internalSemanticIntegrityFailure(
            "EffectMismatch",
            `Missing content for ${change.fileId}`,
            { fileId: change.fileId, contract: "edit-observation" }
          );
        const text = new TextDecoder("utf-8", { fatal: true }).decode(before);
        const edits = [...change.edits].sort((left, right) => left.start - right.start);
        let cursor = 0;
        let next = "";
        for (const edit of edits) {
          if (edit.start < cursor || edit.end > text.length) {
            throw new SemanticVcsError("RevisionChanged", `Invalid edit span for ${change.fileId}`);
          }
          next += text.slice(cursor, edit.start) + edit.text;
          cursor = edit.end;
        }
        next += text.slice(cursor);
        bytes = new TextEncoder().encode(next);
        result = {
          ...prior,
          contentHash: sha256Hex(bytes),
          contentKind: "text",
          byteLength: bytes.length,
          coordinateExtent: next.length,
          ...(change.mode !== undefined ? { mode: change.mode } : {}),
        };
      }
      const resultEndpoint = endpointForFile(
        { ...result, fileStateId: "planned" },
        point.repository
      );
      changes.push({
        operation,
        ordinal: 0,
        kind:
          change.kind === "text-edit"
            ? "text"
            : change.kind === "binary-replace"
              ? "content-replace"
              : change.kind,
        base,
        result: resultEndpoint,
        payload: change as unknown as Row,
      });
      fileResults.push({
        fileId: change.fileId,
        expected: point.state,
        result,
        newFile: false,
        changeRef: { kind: "authored", ordinal: operation },
      });
      if (bytes) blobs.push({ contentHash: result.contentHash, base64: base64FromBytes(bytes) });
    });
    return {
      kind: input.changes.some((change) => change.kind === "repository-create")
        ? "lifecycle"
        : "edit",
      intentSummary: input.intentSummary ?? null,
      incorporatedChangeIds: [],
      changes,
      fileResults,
      repositoryResults,
      blobs,
    };
  }

  private move(input: VcsMoveInput, request: SemanticDispatchRequest): SemanticDispatchResult {
    return this.runMutation("move", input, request, () => {
      const root = this.deps.store.stateRoot(asState(input.expectedWorkingHead));
      const changes: MutationDraft["changes"] = [];
      const fileResults: MutationDraft["fileResults"] = [];
      const repositoryResults: MutationDraft["repositoryResults"] = [];
      const movingFileIds = new Set<string>();
      const movingRepositoryIds = new Set<string>();
      const fileDestinations = new Set<string>();
      const repositoryDestinations = new Set<string>();
      const plannedRepositoryPaths = new Map<string, string>();
      for (const move of input.moves) {
        if (move.kind === "file") {
          if (movingFileIds.has(move.fileId)) {
            throw new SemanticVcsError(
              "InvalidReference",
              `File ${move.fileId} is moved more than once`
            );
          }
          movingFileIds.add(move.fileId);
          const destination = `${move.destinationRepositoryId}:${move.destinationPath}`;
          if (fileDestinations.has(destination)) {
            throw new SemanticVcsError(
              "DestinationOccupied",
              `Multiple files target ${move.destinationPath}`,
              {
                repositoryId: move.destinationRepositoryId,
                path: move.destinationPath,
              }
            );
          }
          fileDestinations.add(destination);
        } else {
          if (movingRepositoryIds.has(move.repositoryId)) {
            throw new SemanticVcsError(
              "InvalidReference",
              `Repository ${move.repositoryId} is moved more than once`
            );
          }
          movingRepositoryIds.add(move.repositoryId);
          if (repositoryDestinations.has(move.destinationPath)) {
            throw new SemanticVcsError(
              "DestinationOccupied",
              `Multiple repositories target ${move.destinationPath}`,
              { path: move.destinationPath }
            );
          }
          repositoryDestinations.add(move.destinationPath);
          plannedRepositoryPaths.set(move.repositoryId, move.destinationPath);
        }
      }
      input.moves.forEach((move, operation) => {
        if (move.kind === "file") {
          const point = this.placedFile(root, move.repositoryId, move.fileId);
          const destination = this.presentRepository(root, move.destinationRepositoryId);
          if (
            point.state.repositoryId === move.destinationRepositoryId &&
            point.state.path === move.destinationPath
          ) {
            throw new SemanticVcsError(
              "InvalidReference",
              `File ${move.fileId} is already at ${move.destinationPath}`
            );
          }
          const occupied = this.deps.store.facts.fileAtPath(
            root,
            move.destinationRepositoryId,
            move.destinationPath
          );
          if (occupied?.state.presence === "placed" && !movingFileIds.has(occupied.state.fileId)) {
            throw new SemanticVcsError(
              "DestinationOccupied",
              `Destination ${move.destinationPath} is occupied`,
              {
                repositoryId: move.destinationRepositoryId,
                path: move.destinationPath,
              }
            );
          }
          const { fileStateId: _priorFileStateId, ...prior } = point.state;
          const result = {
            ...prior,
            repositoryId: move.destinationRepositoryId,
            path: move.destinationPath,
          };
          changes.push({
            operation,
            ordinal: 0,
            kind: "file-move",
            base: endpointForFile(point.state, point.repository),
            result: endpointForFile(
              { ...result, fileStateId: "planned" },
              {
                ...destination,
                repoPath:
                  plannedRepositoryPaths.get(move.destinationRepositoryId) ?? destination.repoPath,
              }
            ),
            payload: move as unknown as Row,
          });
          fileResults.push({
            fileId: move.fileId,
            expected: point.state,
            result,
            newFile: false,
            changeRef: { kind: "authored", ordinal: operation },
          });
        } else {
          const repository = this.presentRepository(root, move.repositoryId);
          const occupied = this.deps.store.facts.repositoryAtPath(root, move.destinationPath);
          if (repository.repoPath === move.destinationPath) {
            throw new SemanticVcsError(
              "InvalidReference",
              `Repository ${move.repositoryId} is already at ${move.destinationPath}`
            );
          }
          if (occupied && !movingRepositoryIds.has(occupied.repositoryId)) {
            throw new SemanticVcsError(
              "DestinationOccupied",
              `Repository path ${move.destinationPath} is occupied`,
              { repositoryId: occupied.repositoryId, path: move.destinationPath }
            );
          }
          changes.push({
            operation,
            ordinal: 0,
            kind: "repo-move",
            base: {
              kind: "repository",
              repositoryId: move.repositoryId,
              repoPath: repository.repoPath,
            },
            result: {
              kind: "repository",
              repositoryId: move.repositoryId,
              repoPath: move.destinationPath,
            },
            payload: move as unknown as Row,
          });
          repositoryResults.push({
            repositoryId: move.repositoryId,
            expected: repository,
            resultPath: move.destinationPath,
            newRepository: false,
            changeRef: { kind: "authored", ordinal: operation },
          });
        }
      });
      const draft: MutationDraft = {
        kind: "file-transfer",
        intentSummary: input.intentSummary ?? null,
        incorporatedChangeIds: [],
        changes,
        fileResults,
        repositoryResults,
      };
      const result = this.persistWorkingMutation(
        input,
        draft,
        input.commandId,
        request.ingress.contextIntegrity
      );
      const effect = this.queueRealization(
        input.contextId,
        input.commandId,
        asState(input.expectedWorkingHead),
        result.workingHead,
        [],
        draft
      );
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result,
        effectPending: effect !== null,
      });
      return effect
        ? { kind: "effects-pending", result, effects: [effect] }
        : { kind: "complete", result };
    });
  }

  private copy(input: VcsCopyInput, request: SemanticDispatchRequest): SemanticDispatchResult {
    return this.runMutation("copy", input, request, () => {
      const targetRoot = this.deps.store.stateRoot(asState(input.expectedWorkingHead));
      const changes: MutationDraft["changes"] = [];
      const fileResults: MutationDraft["fileResults"] = [];
      input.copies.forEach((copy, operation) => {
        const sourceState = asState(copy.source.state);
        const sourceRoot = this.deps.store.stateRoot(sourceState);
        const source = this.placedFile(sourceRoot, copy.source.repositoryId, copy.source.fileId);
        const destination = this.presentRepository(targetRoot, copy.destination.repositoryId);
        if (
          this.deps.store.facts.fileAtPath(
            targetRoot,
            copy.destination.repositoryId,
            copy.destination.path
          )
        ) {
          throw new SemanticVcsError(
            "DestinationOccupied",
            `Destination ${copy.destination.path} is occupied`,
            {
              repositoryId: copy.destination.repositoryId,
              path: copy.destination.path,
            }
          );
        }
        const fileId = compactId("file", {
          commandId: input.commandId,
          operation,
          sourceFileId: copy.source.fileId,
          destination: copy.destination,
        });
        const result = {
          fileId,
          presence: "placed" as const,
          repositoryId: copy.destination.repositoryId,
          path: copy.destination.path,
          contentHash: source.state.contentHash,
          mode: source.state.mode,
          contentKind: source.state.contentKind,
          byteLength: source.state.byteLength,
          coordinateExtent: source.state.coordinateExtent,
        };
        changes.push({
          operation,
          ordinal: 0,
          kind: "file-copy",
          source: {
            kind: "file",
            state: sourceState,
            repositoryId: copy.source.repositoryId,
            repoPath: source.repository.repoPath,
            fileId: copy.source.fileId,
            path: source.state.path,
            contentHash: source.state.contentHash,
            mode: source.state.mode,
            contentKind: source.state.contentKind,
            byteLength: source.state.byteLength,
            coordinateExtent: source.state.coordinateExtent,
          },
          base: missingEndpoint(result, destination.repoPath),
          result: endpointForFile({ ...result, fileStateId: "planned" }, destination),
          payload: { destination: copy.destination },
        });
        fileResults.push({
          fileId,
          expected: null,
          result,
          newFile: true,
          changeRef: { kind: "authored", ordinal: operation },
        });
      });
      const draft: MutationDraft = {
        kind: "file-transfer",
        intentSummary: input.intentSummary ?? null,
        incorporatedChangeIds: [],
        changes,
        fileResults,
        repositoryResults: [],
      };
      const result = this.persistWorkingMutation(
        input,
        draft,
        input.commandId,
        request.ingress.contextIntegrity
      );
      const effect = this.queueRealization(
        input.contextId,
        input.commandId,
        asState(input.expectedWorkingHead),
        result.workingHead,
        [],
        draft
      );
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result,
        effectPending: effect !== null,
      });
      return effect
        ? { kind: "effects-pending", result, effects: [effect] }
        : { kind: "complete", result };
    });
  }

  private merge(
    input: VcsMergeInput,
    request: SemanticDispatchRequest,
    observed?: ReadonlyMap<string, string>
  ): SemanticDispatchResult {
    const apply = (): SemanticDispatchResult => {
      const mergeStartedAt = performance.now();
      const source =
        input.source.kind === "event"
          ? { kind: "event" as const, eventId: input.source.eventId }
          : { kind: "external-delta" as const, deltaId: input.source.deltaId };
      const delta =
        source.kind === "external-delta" ? this.deps.store.externalDelta(source.deltaId) : null;
      if (source.kind === "external-delta" && (!delta || delta.status !== "active")) {
        throw new SemanticVcsError(
          "InvalidReference",
          `External delta ${source.deltaId} is not active`
        );
      }
      if (delta && delta.ownerContextId !== input.contextId) {
        throw new SemanticVcsError(
          "InvalidReference",
          `External delta ${source.deltaId} belongs to another context`
        );
      }
      const comparison = this.mergeComparison(
        asState(input.expectedWorkingHead),
        source,
        observed ?? new Map()
      );
      const planningCompletedAt = performance.now();
      if (!observed) {
        const contentHashes = this.mergeTextContentHashes(comparison);
        if (contentHashes.length > 0) {
          return {
            kind: "host-read",
            request: {
              kind: "read-merge-content",
              operation: "merge",
              input: input as unknown as Row,
              ingress: request.ingress as unknown as Row,
              contentHashes,
            },
          };
        }
      }
      const byKey = new Map(
        comparison.coordinates.map((coordinate) => [
          `${coordinate.coordinate.kind}:${coordinate.coordinate.id}`,
          coordinate,
        ])
      );
      const coordinateResolutions = Array.isArray(input.resolutions) ? input.resolutions : [];
      const blanket =
        input.resolutions && !Array.isArray(input.resolutions)
          ? input.resolutions.allRemaining
          : null;
      const resolutions = new Map<string, (typeof coordinateResolutions)[number]>();
      for (const resolution of coordinateResolutions) {
        const key = `${resolution.coordinate.kind}:${resolution.coordinate.id}`;
        if (resolutions.has(key)) {
          throw new SemanticVcsError(
            "InvalidReference",
            `Resolution coordinate ${key} is duplicated`
          );
        }
        resolutions.set(key, resolution);
      }
      const selected: NetMergeCoordinate[] = [];
      const selectedKeys = new Set<string>();
      for (const coordinate of input.coordinates ?? []) {
        const key = `${coordinate.kind}:${coordinate.id}`;
        const row = byKey.get(key);
        if (!row || row.status === "resolved") {
          throw new SemanticVcsError("InvalidReference", `Coordinate ${key} is not pending`);
        }
        if (selectedKeys.has(key)) {
          throw new SemanticVcsError("InvalidReference", `Coordinate ${key} is duplicated`);
        }
        selectedKeys.add(key);
        selected.push(row);
      }
      for (const resolution of coordinateResolutions) {
        const key = `${resolution.coordinate.kind}:${resolution.coordinate.id}`;
        const row = byKey.get(key);
        if (!row || row.status === "resolved") {
          throw new SemanticVcsError(
            "InvalidReference",
            `Resolution coordinate ${key} is not pending`
          );
        }
        if (!row.resolutions.includes(resolution.resolution)) {
          throw new SemanticVcsError(
            "InvalidReference",
            `Resolution ${resolution.resolution} is not available for coordinate ${key}`
          );
        }
        if (!selectedKeys.has(key)) {
          selectedKeys.add(key);
          selected.push(row);
        }
      }
      if (!input.coordinates && !blanket) {
        for (let index = 0; index < selected.length; index += 1) {
          const coordinate = selected[index]!;
          if (!coordinate.group) continue;
          const group = comparison.coordinates.filter(
            (candidate) => candidate.group === coordinate.group && candidate.status !== "resolved"
          );
          const missingCount = group.filter(
            (member) => !selectedKeys.has(`${member.coordinate.kind}:${member.coordinate.id}`)
          ).length;
          if (group.length > 500 || selected.length + missingCount > 500) {
            throw new SemanticVcsError(
              "ScopeTooLarge",
              `Coupled merge group ${coordinate.group} exceeds one merge operation`,
              { maximum: 500 }
            );
          }
          for (const member of group) {
            const memberKey = `${member.coordinate.kind}:${member.coordinate.id}`;
            if (selectedKeys.has(memberKey)) continue;
            selectedKeys.add(memberKey);
            selected.push(member);
          }
        }
      }
      if (!input.coordinates && blanket) {
        const seenGroups = new Set<string>();
        for (const coordinate of comparison.coordinates) {
          if (coordinate.status === "resolved") continue;
          const groupKey =
            coordinate.group ?? `${coordinate.coordinate.kind}:${coordinate.coordinate.id}`;
          if (seenGroups.has(groupKey)) continue;
          seenGroups.add(groupKey);
          const group = coordinate.group
            ? comparison.coordinates.filter(
                (candidate) =>
                  candidate.group === coordinate.group && candidate.status !== "resolved"
              )
            : [coordinate];
          if (group.length > 500) {
            throw new SemanticVcsError(
              "ScopeTooLarge",
              `Coupled merge group ${coordinate.group} exceeds one page`,
              { maximum: 500 }
            );
          }
          if (selected.length + group.length > 500) break;
          for (const member of group) {
            const memberKey = `${member.coordinate.kind}:${member.coordinate.id}`;
            selectedKeys.add(memberKey);
            selected.push(member);
            resolutions.set(memberKey, {
              coordinate: member.coordinate,
              resolution: blanket.resolution,
              ...(blanket.rationale ? { rationale: blanket.rationale } : {}),
            });
          }
        }
      }
      if (!input.coordinates && !blanket) {
        for (const coordinate of comparison.coordinates) {
          const key = `${coordinate.coordinate.kind}:${coordinate.coordinate.id}`;
          if (
            selectedKeys.has(key) ||
            coordinate.status === "conflict" ||
            coordinate.status === "resolved"
          )
            continue;
          const group = coordinate.group
            ? comparison.coordinates.filter(
                (candidate) =>
                  candidate.group === coordinate.group && candidate.status !== "resolved"
              )
            : [coordinate];
          if (group.length > 500) {
            throw new SemanticVcsError(
              "ScopeTooLarge",
              `Coupled merge group ${coordinate.group} exceeds one page`,
              {
                maximum: 500,
              }
            );
          }
          if (group.some((candidate) => candidate.status === "conflict")) continue;
          if (selected.length + group.length > 500) break;
          for (const member of group) {
            const memberKey = `${member.coordinate.kind}:${member.coordinate.id}`;
            if (selectedKeys.has(memberKey)) continue;
            selectedKeys.add(memberKey);
            selected.push(member);
          }
        }
      }
      if (selected.length > 500) {
        throw new SemanticVcsError(
          "ScopeTooLarge",
          "A merge may select at most 500 distinct coordinates",
          {
            maximum: 500,
          }
        );
      }
      for (const coordinate of selected) {
        if (!coordinate.group) continue;
        const group = comparison.coordinates.filter(
          (candidate) => candidate.group === coordinate.group && candidate.status !== "resolved"
        );
        const missing = group.filter(
          (member) => !selectedKeys.has(`${member.coordinate.kind}:${member.coordinate.id}`)
        );
        if (missing.length > 0) {
          throw new SemanticVcsError(
            "CoupledGroupIncomplete",
            `Merge selection splits coupled group ${coordinate.group}`,
            {
              group: coordinate.group,
              coordinates: group.map((member) => member.coordinate),
            }
          );
        }
      }
      const explicitConflicts = selected.filter(
        (coordinate) =>
          coordinate.status === "conflict" &&
          !resolutions.has(`${coordinate.coordinate.kind}:${coordinate.coordinate.id}`)
      );
      if (explicitConflicts.length) {
        throw new SemanticVcsError("ConflictPresent", "Selected coordinates require a resolution", {
          coordinates: explicitConflicts.map((coordinate) =>
            this.publicMergeCoordinate(coordinate)
          ),
        });
      }
      if (selected.length === 0 && comparison.concluded) {
        const review = this.mergeReviewProjection(
          comparison,
          asState(input.expectedWorkingHead),
          source
        );
        const totalMs = performance.now() - mergeStartedAt;
        if (totalMs >= 100) {
          console.info("[VcsProfile] merge comparison", {
            planningComparisonMs: planningCompletedAt - mergeStartedAt,
            postMergeComparisonMs: 0,
            totalMs,
            selectedCoordinateCount: 0,
          });
        }
        const unchangedResult = {
          status: "unchanged",
          contextId: input.contextId,
          workingHead: input.expectedWorkingHead,
          ...review,
        };
        this.deps.store.finishCommand({
          scopeKind: "context",
          scopeId: input.contextId,
          commandId: input.commandId,
          result: unchangedResult,
          effectPending: false,
        });
        return { kind: "complete", result: unchangedResult };
      }
      const root = this.deps.store.stateRoot(asState(input.expectedWorkingHead));
      const sourceRoot =
        source.kind === "event"
          ? this.deps.store.stateRoot({ kind: "event", eventId: source.eventId })
          : this.deps.store.stateRoot(this.externalDeltaState(delta!));
      const draft: MutationDraft = {
        kind: "merge",
        intentSummary: input.intentSummary ?? null,
        incorporatedChangeIds: [],
        changes: [],
        fileResults: [],
        repositoryResults: [],
        appliedSourceChanges: [],
        blobs: [],
      };
      const entries: NonNullable<MutationDraft["decisions"]>[number]["entries"] = [];
      for (const coordinate of selected) {
        const key = `${coordinate.coordinate.kind}:${coordinate.coordinate.id}`;
        const requested = resolutions.get(key);
        const resolution =
          requested?.resolution ?? (coordinate.status === "convergent" ? "theirs" : "theirs");
        const accounted = [
          ...new Set(coordinate.attribution.theirs.map((entry) => entry.changeId)),
        ];
        draft.incorporatedChangeIds.push(...accounted);
        if (
          resolution === "ours" ||
          resolution === "current" ||
          coordinate.status === "convergent"
        ) {
          entries.push({
            coordinate: coordinate.coordinate,
            resolution:
              resolution === "current" ? "current" : resolution === "ours" ? "ours" : "convergent",
            accountedSourceChangeIds: accounted,
            rationale: requested?.rationale ?? null,
          });
          continue;
        }
        const oursEndpoint = this.coordinateEndpoint(root, coordinate.coordinate);
        let resultEndpoint = this.coordinateEndpoint(sourceRoot, coordinate.coordinate);
        if (source.kind === "external-delta") {
          const sourceChanges = this.sourceChangesForDelta(delta!);
          resultEndpoint =
            [...sourceChanges].reverse().find((change) => {
              const value = this.mergeChangeCoordinate(change);
              return (
                value?.kind === coordinate.coordinate.kind && value.id === coordinate.coordinate.id
              );
            })?.result ?? resultEndpoint;
        }
        const theirsEndpoint = resultEndpoint;
        const forceTheirs = requested?.resolution === "theirs";
        const terminalId = coordinate.attribution.theirs.at(-1)?.changeId;
        const terminal = terminalId ? this.changeRequired(terminalId) : null;
        const authored = forceTheirs
          ? !this.sameCoordinateEndpoint(
              coordinate.coordinate,
              terminal?.result ?? null,
              theirsEndpoint
            )
          : coordinate.status === "composed";
        const contentDerivations: NonNullable<MutationDraft["contentDerivations"]> = [];
        let changeRef: DraftChangeRef;
        if (!authored) {
          if (!terminalId || !terminal) {
            throw new SemanticVcsError(
              "IntegrityFailure",
              `Coordinate ${key} has no terminal source change`
            );
          }
          draft.appliedSourceChanges!.push(terminal);
          changeRef = { kind: "existing", changeId: terminalId };
        } else {
          let merged = forceTheirs ? { ...theirsEndpoint } : { ...oursEndpoint };
          for (const aspect of forceTheirs ? [] : coordinate.aspects) {
            if (aspect.status === "ours" || aspect.status === "convergent") continue;
            if (aspect.aspect === "content" && aspect.composedText !== undefined) {
              const bytes = new TextEncoder().encode(aspect.composedText);
              merged["contentHash"] = sha256Hex(bytes);
              merged["contentKind"] = "text";
              merged["byteLength"] = bytes.length;
              merged["coordinateExtent"] = aspect.composedText.length;
              draft.blobs!.push({
                contentHash: String(merged["contentHash"]),
                base64: base64FromBytes(bytes),
              });
              if (aspect.composedMappings) {
                const oursParent = this.latestAppliedChangeForFile(
                  asState(input.expectedWorkingHead),
                  coordinate.coordinate.id
                );
                const theirsParent = this.latestAppliedChangeForFile(
                  source.kind === "event"
                    ? { kind: "event", eventId: source.eventId }
                    : this.externalDeltaState(delta!),
                  coordinate.coordinate.id
                );
                if (!oursParent || !theirsParent) {
                  throw new SemanticVcsError(
                    "IntegrityFailure",
                    `Composed file ${coordinate.coordinate.id} lacks a parent content application`
                  );
                }
                const childContentHash = String(merged["contentHash"]);
                const mapped = (
                  mappings: NonNullable<NetMergeAspect["composedMappings"]>["ours"],
                  parentContentHash: string
                ) =>
                  mappings.map((mapping) =>
                    contentMapping({
                      coordinateKind: "utf16",
                      childContentHash,
                      childStart: mapping.childStart,
                      childEnd: mapping.childEnd,
                      parentContentHash,
                      parentStart: mapping.parentStart,
                      parentEnd: mapping.parentEnd,
                    })
                  );
                contentDerivations.push(
                  {
                    childChangeRef: { kind: "authored", ordinal: draft.changes.length },
                    parent: { kind: "applied", appliedChangeId: oursParent.appliedChangeId },
                    mappings: mapped(
                      aspect.composedMappings.ours,
                      String((aspect.ours as Row)["hash"])
                    ),
                  },
                  {
                    childChangeRef: { kind: "authored", ordinal: draft.changes.length },
                    parent: { kind: "applied", appliedChangeId: theirsParent.appliedChangeId },
                    mappings: mapped(
                      aspect.composedMappings.theirs,
                      String((aspect.theirs as Row)["hash"])
                    ),
                  }
                );
              }
            } else if (aspect.status === "adopt" || aspect.status === "conflict") {
              if (
                aspect.aspect === "content" &&
                aspect.theirs &&
                typeof aspect.theirs === "object"
              ) {
                merged["contentHash"] = (aspect.theirs as Row)["hash"];
                merged["contentKind"] = (aspect.theirs as Row)["kind"];
                merged["byteLength"] = (aspect.theirs as Row)["byteLength"];
                merged["coordinateExtent"] = (aspect.theirs as Row)["coordinateExtent"];
              } else if (
                aspect.aspect === "placement" &&
                aspect.theirs &&
                typeof aspect.theirs === "object"
              ) {
                merged["repositoryId"] = (aspect.theirs as Row)["repositoryId"];
                merged["path"] = (aspect.theirs as Row)["path"];
              } else if (aspect.aspect === "mode") merged["mode"] = aspect.theirs;
              else if (aspect.aspect === "path") merged["repoPath"] = aspect.theirs;
              else if (aspect.aspect === "presence") merged = { ...theirsEndpoint };
            }
          }
          resultEndpoint = merged;
          const ordinal = draft.changes.length;
          draft.changes.push({
            operation: ordinal,
            ordinal: 0,
            kind: "merge",
            base: oursEndpoint,
            result: resultEndpoint,
            payload: {
              mergesChangeIds: [
                ...new Set(
                  [...coordinate.attribution.ours, ...coordinate.attribution.theirs].map(
                    (entry) => entry.changeId
                  )
                ),
              ],
            },
          });
          changeRef = { kind: "authored", ordinal };
          const resultContent = this.contentEndpoint(resultEndpoint);
          const sourceContent = this.contentEndpoint(theirsEndpoint);
          if (
            contentDerivations.length === 0 &&
            resultContent &&
            sourceContent &&
            resultContent.contentHash === sourceContent.contentHash &&
            resultContent.coordinateKind === sourceContent.coordinateKind &&
            resultContent.coordinateExtent === sourceContent.coordinateExtent
          ) {
            const sourceParent = this.latestAppliedChangeForFile(
              source.kind === "event"
                ? { kind: "event", eventId: source.eventId }
                : this.externalDeltaState(delta!),
              coordinate.coordinate.id
            );
            if (!sourceParent) {
              throw new SemanticVcsError(
                "IntegrityFailure",
                `Merged file ${coordinate.coordinate.id} lacks its source content application`
              );
            }
            const parentContent = this.appliedContentEndpoint(sourceParent.appliedChangeId);
            if (
              !parentContent ||
              parentContent.contentHash !== sourceContent.contentHash ||
              parentContent.coordinateKind !== sourceContent.coordinateKind ||
              parentContent.coordinateExtent !== sourceContent.coordinateExtent
            ) {
              throw new SemanticVcsError(
                "IntegrityFailure",
                `Merged file ${coordinate.coordinate.id} source content lineage is inconsistent`
              );
            }
            contentDerivations.push({
              childChangeRef: changeRef,
              parent: { kind: "applied", appliedChangeId: sourceParent.appliedChangeId },
              mappings: [
                mappingForWholeFile({
                  childContentHash: resultContent.contentHash,
                  parentContentHash: parentContent.contentHash,
                  coordinateKind: resultContent.coordinateKind,
                  coordinateExtent: resultContent.coordinateExtent,
                }),
              ],
            });
          }
          draft.contentDerivations ??= [];
          draft.contentDerivations.push(...contentDerivations);
        }
        if (coordinate.coordinate.kind === "file") {
          const current = this.deps.store.facts.file(root, coordinate.coordinate.id);
          if (resultEndpoint["kind"] === "missing") {
            if (!current || current.state.presence !== "placed")
              throw new SemanticVcsError(
                "RevisionChanged",
                `File ${coordinate.coordinate.id} is no longer placed`
              );
            draft.fileResults.push({
              fileId: coordinate.coordinate.id,
              expected: current.state,
              result: {
                fileId: coordinate.coordinate.id,
                presence: "deleted",
                priorFileStateId: current.state.fileStateId,
              },
              newFile: false,
              changeRef,
            });
          } else {
            draft.fileResults.push({
              fileId: coordinate.coordinate.id,
              expected: current?.state ?? null,
              result: {
                fileId: coordinate.coordinate.id,
                presence: "placed",
                repositoryId: String(resultEndpoint["repositoryId"]),
                path: String(resultEndpoint["path"]),
                contentHash: String(resultEndpoint["contentHash"]),
                mode: Number(resultEndpoint["mode"]),
                ...contentDescriptorFromEndpoint(resultEndpoint),
              },
              newFile: false,
              changeRef,
            });
          }
        } else {
          const current = this.deps.store.facts.member(root, coordinate.coordinate.id);
          draft.repositoryResults.push({
            repositoryId: coordinate.coordinate.id,
            expected: current,
            resultPath:
              resultEndpoint["presence"] === "deleted" || resultEndpoint["presence"] === "absent"
                ? null
                : String(resultEndpoint["repoPath"]),
            newRepository: false,
            changeRef,
          });
        }
        entries.push({
          coordinate: coordinate.coordinate,
          resolution: forceTheirs ? "adopt" : authored ? "composed" : "adopt",
          accountedSourceChangeIds: accounted,
          resultChangeRef: changeRef,
          rationale: requested?.rationale ?? null,
        });
      }
      draft.decisions = [
        {
          targetState: asState(input.expectedWorkingHead),
          sourceEventId: source.kind === "event" ? source.eventId : null,
          sourceDeltaId: source.kind === "external-delta" ? source.deltaId : null,
          entries,
        },
      ];
      const result = this.persistWorkingMutation(
        input,
        draft,
        input.commandId,
        request.ingress.contextIntegrity
      );
      const decisionIdValue = result.decisionIds[0];
      if (!decisionIdValue)
        throw new SemanticVcsError("IntegrityFailure", "Merge did not persist its decision");
      const postComparisonStartedAt = performance.now();
      const after = this.mergeComparison(result.workingHead, source);
      const postComparisonCompletedAt = performance.now();
      this.persistIntegrationProjection(input.contextId, source, result.workingHead, after);
      const publicResult = {
        ...result,
        status: "working" as const,
        decisionId: decisionIdValue,
        outcomes: selected.map((coordinate) => this.publicMergeCoordinate(coordinate)),
        ...this.mergeReviewProjection(after, result.workingHead, source),
        composed: selected
          .filter((coordinate) => coordinate.status === "composed")
          .map((coordinate) => ({
            coordinate: coordinate.coordinate,
            ours: this.intentForWorkUnit(
              coordinate.attribution.ours.filter((entry) => !entry.undone).at(-1)?.workUnitId ??
                result.workUnitId
            ),
            theirs: this.intentForWorkUnit(
              coordinate.attribution.theirs.filter((entry) => !entry.undone).at(-1)?.workUnitId ??
                result.workUnitId
            ),
          })),
      };
      const totalMs = performance.now() - mergeStartedAt;
      if (totalMs >= 100) {
        console.info("[VcsProfile] merge comparison", {
          planningComparisonMs: planningCompletedAt - mergeStartedAt,
          postMergeComparisonMs: postComparisonCompletedAt - postComparisonStartedAt,
          totalMs,
          selectedCoordinateCount: selected.length,
        });
      }
      const effect = this.queueRealization(
        input.contextId,
        input.commandId,
        asState(input.expectedWorkingHead),
        result.workingHead,
        draft.blobs ?? [],
        draft
      );
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result: publicResult,
        effectPending: effect !== null,
      });
      return effect
        ? { kind: "effects-pending", result: publicResult, effects: [effect] }
        : { kind: "complete", result: publicResult };
    };
    if (observed) {
      return this.deps.transaction(() => {
        const command = this.deps.store.command(input.commandId);
        if (command?.status === "pending") {
          const requestDigest = compactId("merge-request", input);
          const cause = causalCommandRef(request.ingress);
          if (
            command.scopeKind !== "context" ||
            command.scopeId !== input.contextId ||
            command.method !== "merge" ||
            command.requestDigest !== requestDigest ||
            canonicalJson(command.cause) !== canonicalJson(cause)
          ) {
            throw new SemanticVcsError(
              "CommandIdReuse",
              `Command ${input.commandId} was reused for different merge content`,
              { commandId: input.commandId }
            );
          }
          return apply();
        }
        const replay = this.mutationReplay("merge", input, request);
        return replay ?? apply();
      });
    }
    return this.runMutation("merge", input, request, apply);
  }

  private revert(input: VcsRevertInput, request: SemanticDispatchRequest): SemanticDispatchResult {
    return this.runMutation("revert", input, request, () => {
      const root = this.deps.store.stateRoot(asState(input.expectedWorkingHead));
      const changes: MutationDraft["changes"] = [];
      const fileResults: MutationDraft["fileResults"] = [];
      const repositoryResults: MutationDraft["repositoryResults"] = [];
      const originals = [...new Set(input.changeIds)].map((changeId) =>
        this.changeRequired(changeId)
      );
      const repositoryDeletes = new Map<
        string,
        { causes: Set<string>; requiresSelectedFileRemoval: boolean }
      >();
      const addRepositoryDelete = (
        repositoryId: string,
        changeId: string,
        requiresSelectedFileRemoval: boolean
      ) => {
        const planned = repositoryDeletes.get(repositoryId) ?? {
          causes: new Set<string>(),
          requiresSelectedFileRemoval: false,
        };
        planned.causes.add(changeId);
        planned.requiresSelectedFileRemoval ||= requiresSelectedFileRemoval;
        repositoryDeletes.set(repositoryId, planned);
      };
      for (const original of originals) {
        if (original.kind === "repo-add" || original.kind === "repo-restore") {
          const repositoryId = original.result?.["repositoryId"];
          if (typeof repositoryId !== "string") {
            throw new SemanticVcsError(
              "IntegrityFailure",
              `Repository change ${original.changeId} has no repository identity`
            );
          }
          addRepositoryDelete(repositoryId, original.changeId, original.kind === "repo-add");
        }
      }

      for (const original of originals) {
        const changeId = original.changeId;
        if (original.kind === "repo-add" || original.kind === "repo-restore") {
          continue;
        }
        const currentResult = original.result;
        const inverseResult = original.base;
        if (
          currentResult &&
          !this.endpointHolds(asState(input.expectedWorkingHead), currentResult)
        ) {
          const blockers = this.revertBlockingChangeIds(
            asState(input.expectedWorkingHead),
            original
          );
          if (blockers.length > 0) {
            throw new SemanticVcsError(
              "InvalidReference",
              `Change ${changeId} is not a live counteraction frontier`,
              { referenceKind: "change", reference: changeId }
            );
          }
        }
        const inverseKind = inverseChangeKind(original.kind);
        if (!inverseKind) {
          throw new SemanticVcsError(
            "InvalidReference",
            `Change ${changeId} has no mechanical counteraction`
          );
        }
        if (currentResult?.["kind"] === "repository") {
          const repositoryId = String(currentResult["repositoryId"] ?? "");
          const current = this.deps.store.facts.member(root, repositoryId);
          if (!repositoryId || !current) {
            throw new SemanticVcsError(
              "InvalidReference",
              `Repository change ${changeId} is not present at the target state`
            );
          }
          const operation = changes.length;
          if (inverseKind === "repo-restore") {
            if (current.presence !== "deleted") {
              throw new SemanticVcsError("RevisionChanged", `Change ${changeId} no longer holds`);
            }
            const prior = this.deps.store.facts.memberByStateId(current.priorRepositoryStateId);
            if (!prior || prior.presence !== "present") {
              throw new SemanticVcsError(
                "IntegrityFailure",
                `Repository tombstone ${current.repositoryStateId} has no prior state`
              );
            }
            const priorManifestId = inverseResult?.["fileManifestId"];
            if (typeof priorManifestId !== "string") {
              throw new SemanticVcsError(
                "IntegrityFailure",
                `Repository deletion ${changeId} has no prior manifest coordinate`
              );
            }
            const priorFiles = this.deps.store.facts.pageManifest(priorManifestId, {
              limit: 100_000,
            });
            if (priorFiles.next !== null) {
              throw new SemanticVcsError(
                "ScopeTooLarge",
                `Repository ${repositoryId} exceeds the exact revert dependency bound`
              );
            }
            const selectedRestores = new Set(
              fileResults
                .filter(
                  (result) =>
                    result.result.presence === "placed" &&
                    result.result.repositoryId === repositoryId
                )
                .map((result) => result.fileId)
            );
            const blockers = priorFiles.values
              .filter((entry) => !selectedRestores.has(entry.fileId))
              .flatMap((entry) => {
                const blocking = this.latestAppliedChangeForFile(
                  asState(input.expectedWorkingHead),
                  entry.fileId
                );
                return blocking ? [blocking.changeId] : [];
              });
            if (blockers.length > 0) {
              throw new SemanticVcsError(
                "InvalidReference",
                `Repository change ${changeId} is not a live counteraction frontier`,
                { referenceKind: "change", reference: changeId }
              );
            }
            if (selectedRestores.size < priorFiles.values.length) {
              throw new SemanticVcsError(
                "IntegrityFailure",
                `Repository ${repositoryId} has a contained file without a provenance dependency`
              );
            }
            const restoredPath = String(inverseResult?.["repoPath"] ?? prior.repoPath);
            repositoryResults.push({
              repositoryId,
              expected: current,
              resultPath: restoredPath,
              newRepository: false,
              changeRef: { kind: "authored", ordinal: operation },
            });
          } else if (inverseKind === "repo-move") {
            if (
              current.presence !== "present" ||
              current.repoPath !== currentResult["repoPath"] ||
              typeof inverseResult?.["repoPath"] !== "string"
            ) {
              throw new SemanticVcsError("RevisionChanged", `Change ${changeId} no longer holds`);
            }
            repositoryResults.push({
              repositoryId,
              expected: current,
              resultPath: inverseResult["repoPath"],
              newRepository: false,
              changeRef: { kind: "authored", ordinal: operation },
            });
          } else {
            throw new SemanticVcsError(
              "IntegrityFailure",
              `Repository counteraction ${inverseKind} was not normalized`
            );
          }
          changes.push({
            operation,
            ordinal: 0,
            kind: inverseKind,
            base: currentResult,
            result: inverseResult,
            payload: { counteractsChangeIds: [changeId] },
          });
          continue;
        }

        if (!currentResult || typeof currentResult["fileId"] !== "string") {
          throw new SemanticVcsError(
            "InvalidReference",
            `Change ${changeId} has no counteractable state coordinate`
          );
        }
        const current = this.deps.store.facts.file(root, String(currentResult["fileId"]));
        if (!current) {
          throw new SemanticVcsError(
            "InvalidReference",
            `File change ${changeId} is not present at the target state`
          );
        }
        if (currentResult["kind"] === "file") {
          if (
            current.state.presence !== "placed" ||
            current.state.contentHash !== currentResult["contentHash"] ||
            current.state.path !== currentResult["path"]
          ) {
            throw new SemanticVcsError("RevisionChanged", `Change ${changeId} no longer holds`);
          }
        } else if (currentResult["kind"] === "missing" && current.state.presence !== "deleted") {
          throw new SemanticVcsError("RevisionChanged", `Change ${changeId} no longer holds`);
        }
        const operation = changes.length;
        changes.push({
          operation,
          ordinal: 0,
          kind: inverseKind,
          base: currentResult,
          result: inverseResult,
          payload: { counteractsChangeIds: [changeId] },
        });
        if (!inverseResult || inverseResult["kind"] === "missing") {
          if (current.state.presence !== "placed") {
            throw new SemanticVcsError("RevisionChanged", `Change ${changeId} no longer holds`);
          }
          fileResults.push({
            fileId: current.state.fileId,
            expected: current.state,
            result: {
              fileId: current.state.fileId,
              presence: "deleted",
              priorFileStateId: current.state.fileStateId,
            },
            newFile: false,
            changeRef: { kind: "authored", ordinal: operation },
          });
        } else if (inverseResult["kind"] === "file") {
          fileResults.push({
            fileId: String(inverseResult["fileId"]),
            expected: current?.state ?? null,
            result: {
              fileId: String(inverseResult["fileId"]),
              presence: "placed",
              repositoryId: String(inverseResult["repositoryId"]),
              path: String(inverseResult["path"]),
              contentHash: String(inverseResult["contentHash"]),
              mode: Number(inverseResult["mode"]),
              ...contentDescriptorFromEndpoint(inverseResult),
            },
            newFile: false,
            changeRef: { kind: "authored", ordinal: operation },
          });
        }
      }

      for (const [repositoryId, planned] of [...repositoryDeletes].sort(([left], [right]) =>
        compareUtf16CodeUnits(left, right)
      )) {
        const repository = this.deps.store.facts.member(root, repositoryId);
        if (!repository || repository.presence !== "present") {
          throw new SemanticVcsError(
            "RevisionChanged",
            `Repository ${repositoryId} no longer has the imported result`
          );
        }
        if (planned.requiresSelectedFileRemoval) {
          const page = this.deps.store.facts.pageManifest(repository.fileManifestId, {
            limit: 100_000,
          });
          if (page.next !== null) {
            throw new SemanticVcsError(
              "ScopeTooLarge",
              `Repository ${repositoryId} exceeds the exact revert dependency bound`
            );
          }
          const selectedRemovals = new Set(
            fileResults
              .filter(
                (result) =>
                  result.expected?.presence === "placed" &&
                  result.expected.repositoryId === repositoryId &&
                  result.result.presence === "deleted"
              )
              .map((result) => result.fileId)
          );
          const blockers = page.values
            .filter((entry) => !selectedRemovals.has(entry.fileId))
            .flatMap((entry) => {
              const change = this.latestAppliedChangeForFile(
                asState(input.expectedWorkingHead),
                entry.fileId
              );
              return change ? [change.changeId] : [];
            });
          if (blockers.length > 0) {
            const causeId = [...planned.causes].sort(compareUtf16CodeUnits)[0]!;
            throw new SemanticVcsError(
              "InvalidReference",
              `Repository change ${causeId} is not a live counteraction frontier`,
              { referenceKind: "change", reference: causeId }
            );
          }
          if (selectedRemovals.size !== page.values.length) {
            throw new SemanticVcsError(
              "IntegrityFailure",
              `Repository ${repositoryId} has a contained file without a provenance dependency`
            );
          }
        }
        const operation = changes.length;
        changes.push({
          operation,
          ordinal: 0,
          kind: "repo-delete",
          base: {
            kind: "repository",
            repositoryId,
            repoPath: repository.repoPath,
            fileManifestId: repository.fileManifestId,
          },
          result: { kind: "repository", repositoryId, presence: "deleted" },
          payload: {
            counteractsChangeIds: [...planned.causes].sort(),
          },
        });
        repositoryResults.push({
          repositoryId,
          expected: repository,
          resultPath: null,
          newRepository: false,
          changeRef: { kind: "authored", ordinal: operation },
        });
      }
      const draft: MutationDraft = {
        kind: "revert",
        intentSummary: input.intentSummary ?? null,
        incorporatedChangeIds: [],
        changes,
        fileResults,
        repositoryResults,
      };
      const result = this.persistWorkingMutation(
        input,
        draft,
        input.commandId,
        request.ingress.contextIntegrity
      );
      const effect = this.queueRealization(
        input.contextId,
        input.commandId,
        asState(input.expectedWorkingHead),
        result.workingHead,
        [],
        draft
      );
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result,
        effectPending: effect !== null,
      });
      return effect
        ? { kind: "effects-pending", result, effects: [effect] }
        : { kind: "complete", result };
    });
  }

  private commit(
    input: import("@vibestudio/service-schemas/vcs").VcsCommitInput,
    request: SemanticDispatchRequest
  ): SemanticDispatchResult {
    return this.runMutation("commit", input, request, () => {
      const before = this.deps.store.workingChain(input.contextId, MAX_WORKING_APPLICATIONS);
      const derivedSources = this.integrationSourceEventIds(before.applicationIds);
      const derivedDeltaSources = this.integrationSourceDeltaIds(before.applicationIds);
      const integrationSourceEventIds = derivedSources;
      for (const sourceEventId of integrationSourceEventIds) {
        const comparison = this.mergeComparison(asState(input.expectedWorkingHead), {
          kind: "event",
          eventId: sourceEventId,
        });
        const remaining = comparison.coordinates
          .filter(
            (coordinate) => coordinate.status !== "resolved" && coordinate.status !== "convergent"
          )
          .map((coordinate) => coordinate.coordinate);
        if (remaining.length) {
          throw new SemanticVcsError(
            "IntegrationIncomplete",
            `Integration of ${sourceEventId} has unaccounted effective changes`,
            {
              source: { kind: "event", eventId: sourceEventId },
              unaccountedCoordinates: remaining,
              recovery: {
                operation: "merge",
                sourceEventId,
                resolutions: {
                  allRemaining: {
                    resolution: "ours",
                    rationale: "Explicitly decline the remaining source coordinates",
                  },
                },
              },
            }
          );
        }
      }
      for (const deltaId of derivedDeltaSources) {
        const delta = this.deps.store.externalDelta(deltaId);
        if (!delta || delta.status !== "active") {
          throw new SemanticVcsError("InvalidReference", `External delta ${deltaId} is not active`);
        }
        const comparison = this.mergeComparison(asState(input.expectedWorkingHead), {
          kind: "external-delta",
          deltaId,
        });
        const remaining = comparison.coordinates
          .filter(
            (coordinate) => coordinate.status !== "resolved" && coordinate.status !== "convergent"
          )
          .map((coordinate) => coordinate.coordinate);
        if (remaining.length) {
          throw new SemanticVcsError(
            "IntegrationIncomplete",
            `Integration of external delta ${deltaId} is incomplete`,
            {
              source: { kind: "external-delta", deltaId },
              unaccountedCoordinates: remaining,
            }
          );
        }
      }
      const committed = this.deps.store.commit({
        contextId: input.contextId,
        expectedWorkingHead: asState(input.expectedWorkingHead),
        commandId: input.commandId,
        message: input.message ?? null,
        integratesEventIds: integrationSourceEventIds,
        integratesDeltaIds: derivedDeltaSources,
        maxApplications: MAX_WORKING_APPLICATIONS,
      });
      this.indexEventMessage(committed.event.eventId, input.message ?? null);
      for (const sourceEventId of integrationSourceEventIds) {
        this.deps.sql.exec(
          `DELETE FROM gad_integration_projection
            WHERE context_id = ? AND source_kind = 'event' AND source_id = ?`,
          input.contextId,
          sourceEventId
        );
      }
      for (const sourceDeltaId of derivedDeltaSources) {
        this.deps.sql.exec(
          `DELETE FROM gad_integration_projection
            WHERE context_id = ? AND source_kind = 'external-delta' AND source_id = ?`,
          input.contextId,
          sourceDeltaId
        );
      }
      const result = {
        contextId: input.contextId,
        event: { kind: "event", eventId: committed.event.eventId },
        committedApplicationIds: before.applicationIds,
        integrationSourceEventIds,
        integrationSourceDeltaIds: derivedDeltaSources,
      };
      const effect = this.queueRealization(
        input.contextId,
        input.commandId,
        asState(input.expectedWorkingHead),
        committed.context.working.ref,
        []
      );
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result,
        effectPending: effect !== null,
      });
      return effect
        ? { kind: "effects-pending", result, effects: [effect] }
        : { kind: "complete", result };
    });
  }

  private discard(
    input: VcsDiscardInput,
    request: SemanticDispatchRequest
  ): SemanticDispatchResult {
    return this.runMutation("discard", input, request, () => {
      const chain = this.deps.store.workingChain(input.contextId, MAX_WORKING_APPLICATIONS);
      const context = this.deps.store.discard(input.contextId, asState(input.expectedWorkingHead));
      this.deps.sql.exec(
        `DELETE FROM gad_integration_projection WHERE context_id = ?`,
        input.contextId
      );
      const result = {
        contextId: input.contextId,
        workingHead: context.working.ref,
        discardedApplicationIds: chain.applicationIds,
      };
      const effect = this.queueRealization(
        input.contextId,
        input.commandId,
        asState(input.expectedWorkingHead),
        context.working.ref,
        [],
        undefined,
        this.deps.store.affectedRepositoryIds(chain.applicationIds)
      );
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result,
        effectPending: effect !== null,
      });
      return effect
        ? { kind: "effects-pending", result, effects: [effect] }
        : { kind: "complete", result };
    });
  }

  private importSnapshot(
    input: VcsImportSnapshotInput,
    request: SemanticDispatchRequest,
    projection: "required" | "deferred" = "required"
  ): SemanticDispatchResult {
    return this.runMutation("importSnapshot", input, request, () => {
      if (input.expectedWorkingHead.kind !== "event") {
        throw new SemanticVcsError("RevisionChanged", "Snapshot import requires a clean context");
      }
      this.deps.store.assertExpectedWorking(input.contextId, asState(input.expectedWorkingHead));
      for (const repository of input.repositories) {
        for (const file of repository.files) assertSemanticVcsPathAdmissible(file.path);
      }
      this.assertImportRepositoryTargets(input);
      const repositories = importedRepositories(input);
      const importedRepositoryIds = repositories.map(({ repositoryId }) => repositoryId);
      const contentHashes = [
        ...new Set(
          input.repositories.flatMap((repository) =>
            repository.files.map((file) => file.contentHash)
          )
        ),
      ].sort(compareUtf16CodeUnits);
      const effect = this.deps.store.queueEffect({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        kind: "observe-content",
        payload: {
          method: "importSnapshot",
          representation: "descriptor",
          projection,
          input: input as unknown as Row,
          contextIntegrity: request.ingress.contextIntegrity as unknown as Row,
          files: contentHashes.map((contentHash) => ({ contentHash })),
        },
      });
      const result = { contextId: input.contextId, importedRepositoryIds };
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result,
        effectPending: true,
      });
      return { kind: "effects-pending", result, effects: [effect] };
    });
  }

  private registerExternalDelta(
    input: VcsRegisterExternalDeltaInput,
    request: SemanticDispatchRequest
  ): SemanticDispatchResult {
    return this.runMutation("registerExternalDelta", input, request, () => {
      this.deps.store.assertExpectedWorking(input.contextId, asState(input.expectedWorkingHead));
      const root = this.deps.store.stateRoot(asState(input.expectedWorkingHead));
      const repository = this.deps.store.facts.member(root, input.repositoryId);
      if (repository?.presence !== "present" || repository.repoPath !== input.repoPath) {
        throw new SemanticVcsError(
          "InvalidReference",
          `External delta target ${input.repositoryId} is not ${input.repoPath}`
        );
      }
      for (const file of [...input.oldFiles, ...input.newFiles]) {
        assertSemanticVcsPathAdmissible(file.path);
      }
      const hashes = [
        ...new Set([...input.oldFiles, ...input.newFiles].map((file) => file.contentHash)),
      ].sort(compareUtf16CodeUnits);
      const effect = this.deps.store.queueEffect({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        kind: "observe-content",
        payload: {
          method: "registerExternalDelta",
          representation: "descriptor",
          input: input as unknown as Row,
          contextIntegrity: request.ingress.contextIntegrity as unknown as Row,
          files: hashes.map((contentHash) => ({ contentHash })),
        },
      });
      const result = { contextId: input.contextId };
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result,
        effectPending: true,
      });
      return { kind: "effects-pending", result, effects: [effect] };
    });
  }

  private externalDeltaLifecycle(
    method: "supersedeExternalDelta" | "finalizeExternalDelta",
    input: VcsExternalDeltaLifecycleInput,
    request: SemanticDispatchRequest
  ): SemanticDispatchResult {
    return this.runMutation(method, input, request, () => {
      this.deps.store.assertExpectedWorking(input.contextId, asState(input.expectedWorkingHead));
      const delta = this.deps.store.externalDelta(input.deltaId);
      if (!delta) throw new SemanticVcsError("InvalidReference", `Unknown delta ${input.deltaId}`);
      if (delta.ownerContextId !== input.contextId) {
        throw new SemanticVcsError(
          "InvalidReference",
          `External delta ${input.deltaId} belongs to context ${delta.ownerContextId}`
        );
      }
      const targetStatus =
        method === "finalizeExternalDelta" ? ("finalized" as const) : ("superseded" as const);
      if (delta.status === targetStatus) {
        const result = this.publicExternalDelta(delta);
        this.deps.store.finishCommand({
          scopeKind: "context",
          scopeId: input.contextId,
          commandId: input.commandId,
          result,
          effectPending: false,
        });
        return { kind: "complete", result };
      }
      if (delta.status !== "active") {
        throw new SemanticVcsError(
          "InvalidReference",
          `External delta ${input.deltaId} is already ${delta.status}`
        );
      }
      if (method === "finalizeExternalDelta") {
        const comparison = this.mergeComparison(asState(input.expectedWorkingHead), {
          kind: "external-delta",
          deltaId: input.deltaId,
        });
        const remaining = comparison.coordinates
          .filter(
            (coordinate) => coordinate.status !== "resolved" && coordinate.status !== "convergent"
          )
          .map((coordinate) => coordinate.coordinate);
        if (remaining.length) {
          throw new SemanticVcsError(
            "IntegrationIncomplete",
            `External delta ${input.deltaId} still has undecided changes`,
            {
              source: { kind: "external-delta", deltaId: input.deltaId },
              unaccountedCoordinates: remaining,
            }
          );
        }
      }
      const updated = this.deps.store.setExternalDeltaStatus(input.deltaId, "active", targetStatus);
      const result = this.publicExternalDelta(updated);
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result,
        effectPending: false,
      });
      return { kind: "complete", result };
    });
  }

  private planImportSnapshot(
    input: VcsImportSnapshotInput,
    receipt: Row
  ): {
    draft: MutationDraft;
    importedRepositoryIds: string[];
    externalSnapshot: VcsExternalSnapshot;
  } {
    const rows = receipt["files"];
    if (!Array.isArray(rows)) {
      throw internalSemanticIntegrityFailure("EffectMismatch", "Content observation lacks files", {
        contract: "import-observation",
      });
    }
    const expectedContentHashes = new Set(
      input.repositories.flatMap((repository) => repository.files.map((file) => file.contentHash))
    );
    const observed = new Map<string, ObservedContentDescriptor>();
    for (const value of rows) {
      if (!value || typeof value !== "object") {
        throw internalSemanticIntegrityFailure(
          "EffectMismatch",
          "Content observation contains an invalid file",
          { contract: "import-observation" }
        );
      }
      const record = value as Row;
      const contentHash = String(record["contentHash"] ?? "");
      if (!expectedContentHashes.has(contentHash) || observed.has(contentHash)) {
        throw internalSemanticIntegrityFailure(
          "EffectMismatch",
          `Content observation contains an unexpected or duplicate digest ${contentHash}`,
          { contentHash, contract: "import-observation" }
        );
      }
      const contentKind = record["contentKind"];
      const byteLength = record["byteLength"];
      const coordinateExtent = record["coordinateExtent"];
      if (
        (contentKind !== "text" && contentKind !== "bytes") ||
        !Number.isSafeInteger(byteLength) ||
        Number(byteLength) < 0 ||
        !Number.isSafeInteger(coordinateExtent) ||
        Number(coordinateExtent) < 0 ||
        (contentKind === "bytes" && coordinateExtent !== byteLength) ||
        (contentKind === "text" && Number(coordinateExtent) > Number(byteLength))
      ) {
        throw internalSemanticIntegrityFailure(
          "EffectMismatch",
          `Content observation has an invalid intrinsic descriptor for ${contentHash}`,
          { contentHash, contract: "import-observation" }
        );
      }
      observed.set(contentHash, {
        contentKind,
        byteLength: Number(byteLength),
        coordinateExtent: Number(coordinateExtent),
      });
    }
    if (observed.size !== expectedContentHashes.size) {
      throw internalSemanticIntegrityFailure(
        "EffectMismatch",
        "Content observation is incomplete",
        { contract: "import-observation" }
      );
    }
    const declaredCanonicalSnapshot = input.source.snapshot;
    if (declaredCanonicalSnapshot) {
      const repository = input.repositories[0];
      if (!repository || input.repositories.length !== 1) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          "Canonical external snapshot verification requires exactly one repository"
        );
      }
      const computedCanonicalSnapshot = canonicalSnapshotDigest(
        repository.files.map((file) => {
          const descriptor = observed.get(file.contentHash);
          if (!descriptor) {
            throw internalSemanticIntegrityFailure(
              "EffectMismatch",
              `Content observation lacks ${file.contentHash}`,
              { contentHash: file.contentHash, contract: "import-observation" }
            );
          }
          return {
            path: file.path,
            mode: file.mode === 0o755 ? 0o100755 : 0o100644,
            size: descriptor.byteLength,
            contentHash: file.contentHash,
          };
        })
      );
      if (computedCanonicalSnapshot !== declaredCanonicalSnapshot) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          "Imported descriptors do not match the declared canonical snapshot",
          {
            declaredCanonicalSnapshot,
            computedCanonicalSnapshot,
          }
        );
      }
    }
    const root = this.deps.store.stateRoot(asState(input.expectedWorkingHead));
    const changes: MutationDraft["changes"] = [];
    const fileResults: MutationDraft["fileResults"] = [];
    const repositoryResults: MutationDraft["repositoryResults"] = [];
    const repositories = importedRepositories(input);
    const existingFiles = this.importExistingFiles(input, root);
    const importedRepositoryIds = repositories.map(({ repositoryId }) => repositoryId);
    const snapshotDigest = importedSnapshotDigest(input.repositories, observed);
    for (const { input: repositoryInput, repositoryId } of repositories) {
      const existing = repositoryInput.repositoryId
        ? this.deps.store.facts.member(root, repositoryId)
        : null;
      if (existing == null) {
        const changeIndex = changes.length;
        changes.push({
          operation: changeIndex,
          ordinal: 0,
          kind: "repo-add",
          base: null,
          result: {
            kind: "repository",
            repositoryId,
            repoPath: repositoryInput.repoPath,
          },
          payload: {},
        });
        repositoryResults.push({
          repositoryId,
          expected: null,
          resultPath: repositoryInput.repoPath,
          newRepository: true,
          changeRef: { kind: "authored", ordinal: changeIndex },
        });
      }
      const expectedByPath = existingFiles.get(repositoryId) ?? new Map<string, PlacedFileState>();
      const importedPaths = new Set(repositoryInput.files.map((file) => file.path));
      for (const [path, prior] of expectedByPath) {
        if (importedPaths.has(path)) continue;
        if (!existing || existing.presence !== "present") {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Imported deletion has no present repository ${repositoryId}`
          );
        }
        const changeIndex = changes.length;
        changes.push({
          operation: changeIndex,
          ordinal: 0,
          kind: "file-delete",
          base: endpointForFile(prior, existing),
          result: missingEndpoint(prior, existing.repoPath),
          payload: {},
        });
        fileResults.push({
          fileId: prior.fileId,
          expected: prior,
          result: {
            fileId: prior.fileId,
            presence: "deleted",
            priorFileStateId: prior.fileStateId,
          },
          newFile: false,
          changeRef: { kind: "authored", ordinal: changeIndex },
        });
      }
      for (const file of repositoryInput.files) {
        const descriptor = observed.get(file.contentHash);
        if (!descriptor) {
          throw internalSemanticIntegrityFailure(
            "EffectMismatch",
            `Content observation lacks ${file.contentHash}`,
            { contentHash: file.contentHash, contract: "import-observation" }
          );
        }
        const prior = expectedByPath.get(file.path) ?? null;
        if (
          prior &&
          prior.contentHash === file.contentHash &&
          prior.mode === file.mode &&
          prior.contentKind === descriptor.contentKind &&
          prior.byteLength === descriptor.byteLength &&
          prior.coordinateExtent === descriptor.coordinateExtent
        ) {
          continue;
        }
        const fileId =
          prior?.fileId ??
          compactId("file", { commandId: input.commandId, repositoryId, path: file.path });
        const result = {
          fileId,
          presence: "placed" as const,
          repositoryId,
          path: file.path,
          contentHash: file.contentHash,
          mode: file.mode,
          ...descriptor,
        };
        const changeIndex = changes.length;
        const resultEndpoint: Row = {
          kind: "file",
          ...result,
          repoPath: repositoryInput.repoPath,
        };
        if (prior) {
          if (!existing || existing.presence !== "present") {
            throw new SemanticVcsError(
              "IntegrityFailure",
              `Imported replacement has no present repository ${repositoryId}`
            );
          }
          const contentUnchanged =
            prior.contentHash === file.contentHash &&
            prior.contentKind === descriptor.contentKind &&
            prior.byteLength === descriptor.byteLength &&
            prior.coordinateExtent === descriptor.coordinateExtent;
          changes.push({
            operation: changeIndex,
            ordinal: 0,
            kind: contentUnchanged ? "file-mode" : "content-replace",
            base: endpointForFile(prior, existing),
            result: resultEndpoint,
            payload: contentUnchanged ? { mode: file.mode } : {},
          });
        } else {
          changes.push({
            operation: changeIndex,
            ordinal: 0,
            kind: "file-create",
            base: missingEndpoint(result, repositoryInput.repoPath),
            result: resultEndpoint,
            payload: {},
          });
        }
        fileResults.push({
          fileId,
          expected: prior,
          result,
          newFile: prior == null,
          changeRef: { kind: "authored", ordinal: changeIndex },
        });
      }
    }
    const externalSnapshot: VcsExternalSnapshot = {
      sourceKind: input.source.kind,
      sourceUri: input.source.kind === "git" ? input.source.url : input.source.uri,
      snapshotRevision:
        input.source.kind === "git" ? input.source.commit : input.source.snapshotRevision,
      ...(input.source.kind === "git"
        ? {
            sourceSubdir: input.source.subdir ?? null,
            canonicalSnapshot: input.source.snapshot,
          }
        : input.source.snapshot
          ? { canonicalSnapshot: input.source.snapshot }
          : {}),
      snapshotDigest,
      targetRepositoryIds: [...new Set(importedRepositoryIds)].sort(compareUtf16CodeUnits),
    };
    const draft: MutationDraft = {
      kind: "import",
      intentSummary: input.intentSummary ?? input.message ?? null,
      externalSnapshot,
      incorporatedChangeIds: [],
      changes,
      fileResults,
      repositoryResults,
    };
    return { draft, importedRepositoryIds, externalSnapshot };
  }

  private persistExternalDelta(input: VcsRegisterExternalDeltaInput, receipt: Row): Row {
    const rows = receipt["files"];
    if (!Array.isArray(rows)) {
      throw internalSemanticIntegrityFailure("EffectMismatch", "Delta observation lacks files");
    }
    const observed = new Map<string, ObservedContentDescriptor>();
    for (const value of rows) {
      const row = value as Row;
      const contentHash = String(row["contentHash"] ?? "");
      observed.set(contentHash, {
        contentKind: row["contentKind"] as "text" | "bytes",
        byteLength: Number(row["byteLength"]),
        coordinateExtent: Number(row["coordinateExtent"]),
      });
    }
    const digestFor = (files: typeof input.oldFiles) =>
      canonicalSnapshotDigest(
        files.map((file) => {
          const descriptor = observed.get(file.contentHash);
          if (!descriptor) {
            throw internalSemanticIntegrityFailure(
              "EffectMismatch",
              `Delta observation lacks ${file.contentHash}`
            );
          }
          return {
            path: file.path,
            mode: file.mode === 0o755 ? 0o100755 : 0o100644,
            size: descriptor.byteLength,
            contentHash: file.contentHash,
          };
        })
      );
    const oldSnapshot = digestFor(input.oldFiles);
    const newSnapshot = digestFor(input.newFiles);
    if (oldSnapshot !== input.oldSource.snapshot || newSnapshot !== input.newSource.snapshot) {
      throw new SemanticVcsError(
        "IntegrityFailure",
        "External delta descriptors do not match their declared snapshots"
      );
    }
    const deltaId = compactId("external-delta:v1", {
      ownerContextId: input.contextId,
      repositoryId: input.repositoryId,
      oldSnapshot,
      newSnapshot,
    });
    const externalKeys = [
      `repo:${this.externalSourceIdentity(input.oldSource)}`,
      `repo:${this.externalSourceIdentity(input.newSource)}`,
    ].sort(compareUtf16CodeUnits);
    const evidence = this.workUnitEvidence(input.contextId, input.commandId);
    const workUnitIdValue = workUnitIdentity({
      commandId: input.commandId,
      kind: "external-unapplied",
      intentSummary: input.intentSummary ?? null,
      ...evidence,
      externalSnapshot: null,
      contentClass: "external",
      externalKeys,
    });
    const oldByPath = new Map(input.oldFiles.map((file) => [file.path, file]));
    const newByPath = new Map(input.newFiles.map((file) => [file.path, file]));
    const paths = [...new Set([...oldByPath.keys(), ...newByPath.keys()])].sort(
      compareUtf16CodeUnits
    );
    const root = this.deps.store.stateRoot(asState(input.expectedWorkingHead));
    const changes: ChangeRecord[] = [];
    const newFileIds = new Set<string>();
    for (const [operation, path] of paths.entries()) {
      const oldFile = oldByPath.get(path);
      const newFile = newByPath.get(path);
      if (
        oldFile &&
        newFile &&
        oldFile.contentHash === newFile.contentHash &&
        oldFile.mode === newFile.mode
      ) {
        continue;
      }
      const point = this.deps.store.facts.fileAtPath(root, input.repositoryId, path);
      const fileId =
        point?.state.fileId ??
        compactId("external-file", { deltaId, repositoryId: input.repositoryId, path });
      if (!point) newFileIds.add(fileId);
      const endpoint = (file: typeof oldFile): Row | null => {
        if (!file) return null;
        const descriptor = observed.get(file.contentHash)!;
        return {
          kind: "file",
          fileId,
          repositoryId: input.repositoryId,
          repoPath: input.repoPath,
          path,
          contentHash: file.contentHash,
          mode: file.mode,
          ...descriptor,
        };
      };
      const base = oldFile
        ? endpoint(oldFile)
        : {
            kind: "missing",
            fileId,
            repositoryId: input.repositoryId,
            repoPath: input.repoPath,
            path,
          };
      const result = newFile
        ? endpoint(newFile)
        : {
            kind: "missing",
            fileId,
            repositoryId: input.repositoryId,
            repoPath: input.repoPath,
            path,
          };
      const kind = !oldFile
        ? "file-create"
        : !newFile
          ? "file-delete"
          : oldFile.contentHash === newFile.contentHash
            ? "file-mode"
            : "content-replace";
      const withoutIdentity = {
        workUnitId: workUnitIdValue,
        operation,
        ordinal: 0,
        kind,
        source: null,
        base,
        result,
        payload: kind === "file-mode" ? { mode: newFile!.mode } : {},
      };
      const changeId = changeIdentity(withoutIdentity);
      changes.push({
        ...withoutIdentity,
        changeId,
        effectDigest: compactId("change-effect", {
          kind,
          base,
          result,
          payload: withoutIdentity.payload,
        }),
      });
    }
    const createdAt = this.deps.now();
    const workUnit: WorkUnitRecord = {
      workUnitId: workUnitIdValue,
      commandId: input.commandId,
      kind: "external-unapplied",
      authoredChangeIds: changes.map((change) => change.changeId),
      intentSummary: input.intentSummary ?? null,
      ...evidence,
      externalSnapshot: null,
      contentClass: "external",
      externalKeys,
      normalizationProtocol: NORMALIZATION_PROTOCOL,
      createdAt,
    };
    const fileTransitions: FileTransition[] = changes.flatMap((change) => {
      const endpoint = change.result;
      const fileId = String(endpoint?.["fileId"] ?? change.base?.["fileId"] ?? "");
      if (!fileId) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `External delta change ${change.changeId} has no file coordinate`
        );
      }
      const existing = this.deps.store.facts.file(root, fileId)?.state ?? null;
      let result: WorkspaceFileState;
      if (endpoint?.["kind"] === "file") {
        result = workspaceFileStateIdentity({
          fileId,
          presence: "placed",
          repositoryId: String(endpoint["repositoryId"]),
          path: String(endpoint["path"]),
          contentHash: String(endpoint["contentHash"]),
          mode: Number(endpoint["mode"]),
          ...contentDescriptorFromEndpoint(endpoint),
        });
        if (existing?.fileStateId === result.fileStateId) return [];
      } else {
        if (existing?.presence !== "placed") return [];
        result = workspaceFileStateIdentity({
          fileId,
          presence: "deleted",
          priorFileStateId: existing.fileStateId,
          tombstoneChangeId: change.changeId,
        });
      }
      return [
        {
          fileId,
          expected: existing,
          result,
          changeId: change.changeId,
          newFile: existing === null,
        },
      ];
    });
    const workspaceChangeSet = fileTransitions.length
      ? this.planWorkspaceFacts(root, fileTransitions, [])
      : null;
    const workspaceFacts = workspaceChangeSet
      ? this.deps.store.facts.prepare(workspaceChangeSet)
      : null;
    const resultRoot = workspaceFacts
      ? workspaceFacts.persistence.resultRoot.workspaceFactRootId
      : root;
    const transitionByChangeId = new Map(
      fileTransitions.map((transition) => [transition.changeId, transition])
    );
    const appliedDrafts = changes.map((change, ordinal) => {
      const transition = transitionByChangeId.get(change.changeId);
      const fileId = String(change.result?.["fileId"] ?? change.base?.["fileId"] ?? "");
      return {
        changeId: change.changeId,
        ordinal,
        appliedBase: change.base,
        appliedResult: change.result,
        resultPredicates: transition
          ? [predicateForState(transition.result)]
          : [{ kind: "file-absent", fileId }],
      };
    });
    const applicationIdValue = applicationIdentity({
      workUnitId: workUnitIdValue,
      basis: asState(input.expectedWorkingHead),
      resultWorkspaceFactRootId: resultRoot,
      semanticProtocol: SEMANTIC_PROTOCOL,
      changes: appliedDrafts,
    });
    const appliedChanges: AppliedChangeRecord[] = appliedDrafts.map((value) => {
      const withoutIdentity = { ...value, applicationId: applicationIdValue };
      return { ...withoutIdentity, appliedChangeId: appliedChangeIdentity(withoutIdentity) };
    });
    const candidate: ApplicationPersistencePlan = {
      contextId: input.contextId,
      expectedWorkingHead: asState(input.expectedWorkingHead),
      workUnit,
      changes,
      application: {
        applicationId: applicationIdValue,
        workUnitId: workUnitIdValue,
        basis: asState(input.expectedWorkingHead),
        appliedChangeIds: appliedChanges.map((change) => change.appliedChangeId),
        resultWorkspaceFactRootId: resultRoot,
        semanticProtocol: SEMANTIC_PROTOCOL,
      },
      appliedChanges,
      contentEdges: [],
      decisions: [],
      workspaceFacts,
      newRepositories: [],
      newFiles: [...newFileIds].map((fileId) => {
        const change = changes.find(
          (candidate) =>
            String(candidate.result?.["fileId"] ?? candidate.base?.["fileId"]) === fileId
        )!;
        const endpoint = change.result?.["kind"] === "file" ? change.result : change.base!;
        return {
          fileId,
          repositoryId: String(endpoint["repositoryId"]),
          changeId: change.changeId,
        };
      }),
    };
    const record: ExternalDeltaRecord = {
      deltaId,
      workUnitId: workUnitIdValue,
      ownerContextId: input.contextId,
      repositoryId: input.repositoryId,
      repoPath: input.repoPath,
      targetState: asState(input.expectedWorkingHead),
      oldSource: input.oldSource as unknown as Row,
      newSource: input.newSource as unknown as Row,
      oldSnapshot,
      newSnapshot,
      inputDigest: compactId("external-delta-input", {
        repositoryId: input.repositoryId,
        repoPath: input.repoPath,
        oldSource: input.oldSource,
        newSource: input.newSource,
        oldFiles: input.oldFiles,
        newFiles: input.newFiles,
        supersedesDeltaId: input.supersedesDeltaId ?? null,
      }),
      status: "active",
      supersededByDeltaId: null,
      createdAt,
    };
    const existing = this.deps.store.externalDelta(deltaId);
    if (existing) {
      return this.publicExternalDelta(this.deps.store.registerExternalDelta(record, candidate));
    }
    if (input.supersedesDeltaId) {
      const superseded = this.deps.store.externalDelta(input.supersedesDeltaId);
      if (!superseded || superseded.ownerContextId !== input.contextId) {
        throw new SemanticVcsError(
          "InvalidReference",
          `External delta ${input.supersedesDeltaId} is not owned by context ${input.contextId}`
        );
      }
      this.deps.store.setExternalDeltaStatus(
        input.supersedesDeltaId,
        "active",
        "superseded",
        deltaId
      );
    }
    const registered = this.deps.store.registerExternalDelta(record, candidate);
    this.recordDerivedWorkUnitIndex(record.workUnitId);
    return this.publicExternalDelta(registered);
  }

  private externalSourceIdentity(source: VcsRegisterExternalDeltaInput["oldSource"]): string {
    return source.kind === "git"
      ? `${source.url}@${source.commit}${source.subdir ? `:${source.subdir}` : ""}`
      : `${source.uri}@${source.snapshotRevision}`;
  }

  private publicExternalDelta(delta: ExternalDeltaRecord): Row {
    const changeIds = (
      this.deps.sql
        .exec(
          `SELECT change_id FROM gad_changes WHERE work_unit_id = ?
           ORDER BY operation, ordinal`,
          delta.workUnitId
        )
        .toArray() as Row[]
    ).map((row) => String(row["change_id"]));
    return {
      deltaId: delta.deltaId,
      workUnitId: delta.workUnitId,
      repositoryId: delta.repositoryId,
      repoPath: delta.repoPath,
      oldSnapshot: delta.oldSnapshot,
      newSnapshot: delta.newSnapshot,
      changeCount: changeIds.length,
      changeIds: changeIds.slice(0, 200),
      status: delta.status,
    };
  }

  private assertImportRepositoryTargets(input: VcsImportSnapshotInput): void {
    const root = this.deps.store.stateRoot(asState(input.expectedWorkingHead));
    for (const { input: repositoryInput, repositoryId } of importedRepositories(input)) {
      if (!repositoryInput.repositoryId) continue;
      const existing = this.deps.store.facts.member(root, repositoryId);
      if (!existing || existing.presence !== "present") {
        throw new SemanticVcsError(
          "InvalidReference",
          `Snapshot replacement requires a present repository ${repositoryId}`
        );
      }
      if (existing.repoPath !== repositoryInput.repoPath) {
        throw new SemanticVcsError(
          "InvalidReference",
          `Snapshot import cannot move repository ${repositoryId}; use vcs.move first`
        );
      }
    }
  }

  /** Collect the exact replacement basis through the manifest's bounded paging API. */
  private importExistingFiles(
    input: VcsImportSnapshotInput,
    root: string
  ): Map<string, Map<string, PlacedFileState>> {
    const byRepository = new Map<string, Map<string, PlacedFileState>>();
    for (const { input: repositoryInput, repositoryId } of importedRepositories(input)) {
      if (!repositoryInput.repositoryId) continue;
      const existing = this.deps.store.facts.member(root, repositoryId);
      if (!existing || existing.presence !== "present") {
        throw new SemanticVcsError(
          "InvalidReference",
          `Snapshot replacement requires a present repository ${repositoryId}`
        );
      }
      if (existing.repoPath !== repositoryInput.repoPath) {
        throw new SemanticVcsError(
          "InvalidReference",
          `Snapshot import cannot move repository ${repositoryId}; use vcs.move first`
        );
      }
      const files = new Map<string, PlacedFileState>();
      const entries: Array<{ path: string; fileId: string }> = [];
      let afterPath: string | undefined;
      do {
        const page = this.deps.store.facts.pageManifest(existing.fileManifestId, {
          ...(afterPath ? { afterPath } : {}),
          limit: 500,
        });
        entries.push(...page.values);
        afterPath = page.next ?? undefined;
      } while (afterPath !== undefined);
      const states = this.deps.store.facts.fileStatesAt(
        root,
        entries.map((entry) => entry.fileId)
      );
      for (const entry of entries) {
        const state = states.get(entry.fileId);
        if (
          !state ||
          state.presence !== "placed" ||
          state.repositoryId !== repositoryId ||
          state.path !== entry.path
        ) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Repository ${repositoryId} manifest references an absent file ${entry.fileId}`
          );
        }
        files.set(entry.path, state);
      }
      byRepository.set(repositoryId, files);
    }
    return byRepository;
  }

  private push(input: VcsPushInput, request: SemanticDispatchRequest): SemanticDispatchResult {
    return this.runMutation(
      "push",
      { ...input, expectedWorkingHead: { kind: "event", eventId: input.expectedCommittedEventId } },
      request,
      () => {
        const context = this.deps.store.contextRequired(input.contextId);
        if (
          context.workingHeadApplicationId ||
          context.committed.ref.eventId !== input.expectedCommittedEventId
        ) {
          throw new SemanticVcsError(
            "RevisionChanged",
            "Push requires the exact clean committed event"
          );
        }
        const main = this.deps.store.mainEventId();
        if (main !== input.expectedMainEventId) {
          throw new SemanticVcsError("RevisionChanged", "Protected main changed");
        }
        if (
          !this.deps.store.isEventAncestor(
            input.expectedMainEventId,
            input.expectedCommittedEventId,
            MAX_ANCESTRY_EDGES
          )
        ) {
          throw new SemanticVcsError("RevisionChanged", "Push is not a semantic fast-forward");
        }
        this.assertIntegrationHistoryValid(
          input.expectedMainEventId,
          input.expectedCommittedEventId
        );
        const effect = this.deps.store.queueEffect({
          scopeKind: "context",
          scopeId: input.contextId,
          commandId: input.commandId,
          kind: "publish-main",
          payload: {
            contextId: input.contextId,
            previousEventId: input.expectedMainEventId,
            publishedEventId: input.expectedCommittedEventId,
            // Protected publication deliberately carries a complete immutable
            // repository snapshot; context working-tree effects are patches.
            repositories: this.publicationRepositories(
              context.committed.workspaceFactRootId
            ) as unknown as Row[],
          },
        });
        const result = {
          contextId: input.contextId,
          eventId: input.expectedCommittedEventId,
          effectId: effect.effectId,
        };
        this.deps.store.finishCommand({
          scopeKind: "context",
          scopeId: input.contextId,
          commandId: input.commandId,
          result,
          effectPending: true,
        });
        return { kind: "effects-pending", result, effects: [effect] };
      }
    );
  }

  private status(input: VcsStatusInput): Row {
    const context = this.deps.store.contextRequired(input.contextId);
    const chain = this.deps.store.workingChain(input.contextId, MAX_WORKING_APPLICATIONS);
    const workUnits = new Set(
      chain.applicationIds.map((id) => this.deps.store.application(id)?.workUnitId).filter(Boolean)
    );
    const changes = chain.applicationIds.reduce(
      (count, id) => count + (this.deps.store.application(id)?.appliedChangeIds.length ?? 0),
      0
    );
    const main = this.deps.store.mainEventId();
    const integrating = this.deps.sql
      .exec(
        `SELECT source_kind, source_id, remaining_coordinate_count,
                mergeable_coordinate_count, conflict_coordinate_count, concluded,
                as_of_working_head_kind, as_of_working_head_id
           FROM gad_integration_projection
          WHERE context_id = ? ORDER BY source_kind, source_id`,
        input.contextId
      )
      .toArray()
      .map((row) => {
        const value = row as Row;
        const source =
          value["source_kind"] === "event"
            ? { kind: "event" as const, eventId: String(value["source_id"]) }
            : { kind: "external-delta" as const, deltaId: String(value["source_id"]) };
        const asOfWorkingHead =
          value["as_of_working_head_kind"] === "event"
            ? { kind: "event" as const, eventId: String(value["as_of_working_head_id"]) }
            : {
                kind: "application" as const,
                applicationId: String(value["as_of_working_head_id"]),
              };
        return {
          source,
          remainingCoordinateCount: Number(value["remaining_coordinate_count"]),
          mergeableCoordinateCount: Number(value["mergeable_coordinate_count"]),
          conflictCoordinateCount: Number(value["conflict_coordinate_count"]),
          concluded: Number(value["concluded"]) === 1,
          asOfWorkingHead,
          stale: stateNodeKey(asOfWorkingHead) !== stateNodeKey(context.working.ref),
        };
      });
    return {
      contextId: input.contextId,
      committed: context.committed.ref,
      workingHead: context.working.ref,
      clean: context.workingHeadApplicationId === null,
      mainEventId: main,
      mainRelation:
        main === context.committed.ref.eventId
          ? "at"
          : main &&
              this.deps.store.isEventAncestor(
                main,
                context.committed.ref.eventId,
                MAX_ANCESTRY_EDGES
              )
            ? "ahead"
            : main &&
                this.deps.store.isEventAncestor(
                  context.committed.ref.eventId,
                  main,
                  MAX_ANCESTRY_EDGES
                )
              ? "behind"
              : "diverged",
      workingCounts: {
        applications: chain.applicationIds.length,
        workUnits: workUnits.size,
        changes,
      },
      integrating,
    };
  }

  private intentForWorkUnit(workUnitId: string): {
    text: string;
    tier: "stated" | "trigger" | "mechanical";
  } {
    const row = this.deps.sql
      .exec(
        `SELECT kind, intent_summary, trigger_excerpt, trigger_sender_json
           FROM gad_work_units WHERE work_unit_id = ?`,
        workUnitId
      )
      .toArray()[0] as Row | undefined;
    if (!row) throw new SemanticVcsError("IntegrityFailure", `Missing work unit ${workUnitId}`);
    const storedSender =
      row["trigger_sender_json"] == null
        ? null
        : trajectorySenderRef(JSON.parse(String(row["trigger_sender_json"])));
    return resolveIntent({
      stated: row["intent_summary"] == null ? null : String(row["intent_summary"]),
      trigger:
        row["trigger_excerpt"] != null && storedSender
          ? { text: String(row["trigger_excerpt"]), sender: storedSender.id }
          : null,
      mechanical: this.mechanicalIntentForWorkUnit(workUnitId, String(row["kind"])),
    });
  }

  /**
   * The requester's captured words for a work unit, independent of which rung
   * the ladder resolved to. When the author stated an intent the resolved text
   * is that summary; the statement it summarized is what abduction needs.
   */
  private statementForWorkUnit(
    workUnitId: string
  ): { text: string; sender: string } | null {
    const row = this.deps.sql
      .exec(
        `SELECT trigger_excerpt, trigger_sender_json
           FROM gad_work_units WHERE work_unit_id = ? LIMIT 1`,
        workUnitId
      )
      .toArray()[0] as Row | undefined;
    if (!row || row["trigger_excerpt"] == null || row["trigger_sender_json"] == null) return null;
    const sender = trajectorySenderRef(JSON.parse(String(row["trigger_sender_json"])));
    const text = boundedMemoryText(String(row["trigger_excerpt"]), 2_000);
    return text && sender ? { text, sender: sender.id } : null;
  }

  private workUnitEvidence(
    contextId: string,
    commandId: string
  ): Pick<WorkUnitRecord, "authorContextId" | "triggerEvidence"> {
    // Trigger evidence is captured whether or not the author stated an intent.
    // Resolution is unaffected — `resolveIntent` still prefers the stated rung,
    // so the ladder and the persisted resolved columns are bit-identical. What
    // changes is that the requester's own words survive: an author's summary is
    // an interpretation, and discarding the statement it interpreted destroys
    // the only evidence abduction can actually run on.
    const cause = this.readMemoryCause(commandId);
    const text =
      cause?.["triggerText"] == null
        ? null
        : boundedMemoryText(String(cause["triggerText"]), 1_200);
    const sender = trajectorySenderRef(cause?.["sender"]);
    return {
      authorContextId: contextId,
      triggerEvidence: text && sender ? { text, sender } : null,
    };
  }

  private mechanicalIntentForWorkUnit(workUnitId: string, workKind: string): string {
    const changes = (
      this.deps.sql
        .exec(
          `SELECT change_id FROM gad_changes
          WHERE work_unit_id = ? ORDER BY operation, ordinal, change_id`,
          workUnitId
        )
        .toArray() as Row[]
    ).map((entry) => this.changeRequired(String(entry["change_id"])));
    if (changes.length === 0) return `${workKind} decision with no fact transition`;
    const summaries = changes.map((change) => {
      const endpoint = change.result ?? change.base ?? {};
      const subject =
        this.coordinatePath(endpoint) ??
        (typeof endpoint["fileId"] === "string"
          ? String(endpoint["fileId"])
          : typeof endpoint["repositoryId"] === "string"
            ? String(endpoint["repositoryId"])
            : "workspace coordinate");
      return `${publicChangeKind(change.kind)} ${subject}`;
    });
    const unique = [...new Set(summaries)];
    const visible = unique.slice(0, 12).join("; ");
    return unique.length > 12 ? `${visible}; and ${unique.length - 12} more effects` : visible;
  }

  private intentProjection(comparison: NetMergeComparison): {
    intents: Row[];
    intentCounts: Record<"merged" | "settled" | "split" | "contested" | "pending", number>;
    truncated: boolean;
  } {
    const decisionIds = [
      ...new Set(
        comparison.coordinates.flatMap((coordinate) =>
          coordinate.decisionId ? [coordinate.decisionId] : []
        )
      ),
    ];
    const decisionResolutions = new Map<string, string>();
    if (decisionIds.length > 0) {
      const rows = this.deps.sql
        .exec(
          `SELECT decision_id, coordinate_kind, coordinate_id, resolution
             FROM gad_merge_decision_entries
            WHERE decision_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
          canonicalJson(decisionIds)
        )
        .toArray() as Row[];
      for (const row of rows) {
        decisionResolutions.set(
          `${row["decision_id"]}:${row["coordinate_kind"]}:${row["coordinate_id"]}`,
          String(row["resolution"])
        );
      }
    }
    const groups = new Map<
      string,
      { side: "ours" | "theirs"; coordinates: Map<string, NetMergeCoordinate> }
    >();
    for (const coordinate of comparison.coordinates) {
      for (const side of ["ours", "theirs"] as const) {
        for (const attribution of coordinate.attribution[side]) {
          const key = `${side}:${attribution.workUnitId}`;
          const group = groups.get(key) ?? { side, coordinates: new Map() };
          group.coordinates.set(
            `${coordinate.coordinate.kind}:${coordinate.coordinate.id}`,
            coordinate
          );
          groups.set(key, group);
        }
      }
    }
    const counts = { merged: 0, settled: 0, split: 0, contested: 0, pending: 0 };
    const priority = { split: 0, contested: 1, pending: 2, merged: 3, settled: 4 } as const;
    const rows = [...groups.entries()].map(([key, group]) => {
      const workUnitId = key.slice(key.indexOf(":") + 1);
      const coordinates = [...group.coordinates.values()];
      let state: keyof typeof counts | undefined;
      if (group.side === "theirs") {
        const dispositions = coordinates.map((coordinate) => {
          if (coordinate.status !== "resolved") return coordinate.status;
          const resolution = decisionResolutions.get(
            `${coordinate.decisionId}:${coordinate.coordinate.kind}:${coordinate.coordinate.id}`
          );
          if (!resolution) {
            throw new SemanticVcsError(
              "IntegrityFailure",
              `Resolved coordinate ${coordinate.coordinate.kind}:${coordinate.coordinate.id} has no decision entry`
            );
          }
          return resolution === "ours" || resolution === "current" ? "settled" : "merged";
        });
        const contested = dispositions.filter((value) => value === "conflict").length;
        if (contested > 0 && contested < dispositions.length) state = "split";
        else if (contested === dispositions.length) state = "contested";
        else if (dispositions.some((value) => value === "adopt" || value === "composed"))
          state = "pending";
        else if (dispositions.some((value) => value === "settled")) state = "settled";
        else state = "merged";
        counts[state] += 1;
      }
      return {
        workUnitId,
        side: group.side,
        intent: this.intentForWorkUnit(workUnitId),
        coordinates: coordinates.map((coordinate) => coordinate.coordinate),
        ...(state ? { state } : {}),
      };
    });
    rows.sort((left, right) => {
      if (left.side !== right.side) return left.side === "theirs" ? -1 : 1;
      const leftPriority = left.state ? priority[left.state] : 5;
      const rightPriority = right.state ? priority[right.state] : 5;
      return (
        leftPriority - rightPriority || compareUtf16CodeUnits(left.workUnitId, right.workUnitId)
      );
    });
    return { intents: rows.slice(0, 500), intentCounts: counts, truncated: rows.length > 500 };
  }

  private publicMergeCoordinate(coordinate: NetMergeCoordinate): Row {
    return {
      coordinate: { ...coordinate.coordinate, paths: coordinate.paths },
      status: coordinate.status,
      aspects: coordinate.aspects.map(
        ({ composedText: _composedText, composedMappings: _composedMappings, ...aspect }) => aspect
      ),
      attribution: coordinate.attribution,
      ...(coordinate.group ? { group: coordinate.group } : {}),
      ...(coordinate.structuralConflicts
        ? { structuralConflicts: coordinate.structuralConflicts }
        : {}),
      resolutions: coordinate.resolutions,
      ...(coordinate.decisionId ? { decisionId: coordinate.decisionId } : {}),
      summary: coordinate.summary,
    };
  }

  private comparisonResolution(comparison: NetMergeComparison) {
    const remainingCoordinateCount = comparison.coordinates.filter(
      (coordinate) => coordinate.status !== "resolved" && coordinate.status !== "convergent"
    ).length;
    return {
      complete: remainingCoordinateCount === 0,
      remainingCoordinateCount,
      concluded: comparison.concluded,
    };
  }

  private mergeReviewProjection(
    comparison: NetMergeComparison,
    target: StateNodeRef,
    source: VcsMergeInput["source"]
  ) {
    const intent = this.intentProjection(comparison);
    const counts = { adopt: 0, convergent: 0, composed: 0, conflict: 0, resolved: 0 };
    for (const coordinate of comparison.coordinates) counts[coordinate.status] += 1;
    const conflicts = comparison.coordinates.filter(
      (coordinate) => coordinate.status === "conflict"
    );
    const cursorBasis = { target, source, statusFilter: "conflict" };
    return {
      resolution: this.comparisonResolution(comparison),
      counts,
      intents: intent.intents,
      intentsTruncated: intent.truncated,
      conflicts: conflicts
        .slice(0, 500)
        .map((coordinate) => this.publicMergeCoordinate(coordinate)),
      nextConflictCursor:
        conflicts.length > 500 ? semanticCursor("compare", cursorBasis, { offset: 500 }) : null,
    };
  }

  private persistIntegrationProjection(
    contextId: string,
    source: VcsMergeInput["source"],
    workingHead: StateNodeRef,
    comparison: NetMergeComparison
  ): void {
    const remaining = comparison.coordinates.filter(
      (coordinate) => coordinate.status !== "resolved" && coordinate.status !== "convergent"
    );
    const mergeableCoordinateCount = comparison.coordinates.filter(
      (coordinate) =>
        coordinate.status === "adopt" ||
        coordinate.status === "composed" ||
        (coordinate.status === "convergent" && !comparison.concluded)
    ).length;
    const sourceId = source.kind === "event" ? source.eventId : source.deltaId;
    const headId = workingHead.kind === "event" ? workingHead.eventId : workingHead.applicationId;
    this.deps.sql.exec(
      `INSERT INTO gad_integration_projection
       (context_id, source_kind, source_id, remaining_coordinate_count,
        mergeable_coordinate_count, conflict_coordinate_count, concluded,
        as_of_working_head_kind, as_of_working_head_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(context_id, source_kind, source_id) DO UPDATE SET
         remaining_coordinate_count = excluded.remaining_coordinate_count,
         mergeable_coordinate_count = excluded.mergeable_coordinate_count,
         conflict_coordinate_count = excluded.conflict_coordinate_count,
         concluded = excluded.concluded,
         as_of_working_head_kind = excluded.as_of_working_head_kind,
         as_of_working_head_id = excluded.as_of_working_head_id`,
      contextId,
      source.kind,
      sourceId,
      remaining.length,
      mergeableCoordinateCount,
      comparison.coordinates.filter((coordinate) => coordinate.status === "conflict").length,
      comparison.concluded ? 1 : 0,
      workingHead.kind,
      headId
    );
  }

  private compare(
    input: VcsCompareInput,
    request: SemanticDispatchRequest,
    observed?: ReadonlyMap<string, string>
  ): SemanticDispatchResult {
    const source =
      input.source.kind === "event"
        ? { kind: "event" as const, eventId: input.source.eventId }
        : input.source.kind === "application"
          ? { kind: "application" as const, applicationId: input.source.applicationId }
          : { kind: "external-delta" as const, deltaId: input.source.deltaId };
    const comparison = this.mergeComparison(asState(input.target), source, observed ?? new Map());
    if (!observed) {
      const contentHashes = this.mergeTextContentHashes(comparison);
      if (contentHashes.length > 0) {
        return {
          kind: "host-read",
          request: {
            kind: "read-merge-content",
            operation: "compare",
            input: input as unknown as Row,
            ingress: request.ingress as unknown as Row,
            contentHashes,
          },
        };
      }
    }
    const intent = this.intentProjection(comparison);
    const counts = { adopt: 0, convergent: 0, composed: 0, conflict: 0, resolved: 0 };
    for (const coordinate of comparison.coordinates) counts[coordinate.status] += 1;
    const cursorBasis = {
      target: input.target,
      source: input.source,
      ...(input.statusFilter ? { statusFilter: input.statusFilter } : {}),
    };
    const offset = cursorOffset(input.cursor, cursorBasis);
    const pageCoordinates = input.statusFilter
      ? comparison.coordinates.filter((coordinate) => coordinate.status === input.statusFilter)
      : comparison.coordinates;
    return {
      kind: "complete",
      result: {
        target: input.target,
        source: input.source,
        base: comparison.base,
        ...(comparison.bases.length > 1 ? { bases: comparison.bases } : {}),
        resolution: this.comparisonResolution(comparison),
        counts,
        intentCounts: intent.intentCounts,
        coordinates: pageCoordinates
          .slice(offset, offset + input.limit)
          .map((coordinate) => this.publicMergeCoordinate(coordinate)),
        intents: intent.intents,
        intentsTruncated: intent.truncated,
        nextCursor:
          offset + input.limit < pageCoordinates.length
            ? semanticCursor("compare", cursorBasis, { offset: offset + input.limit })
            : null,
      },
    };
  }

  private inspect(input: VcsInspectInput): Row {
    const value = this.inspectNode(input.node as Row);
    const page = this.neighborEdges(input.node as Row, undefined, input.edgeLimit + 1);
    return {
      root: input.node,
      node: value,
      edges: page.slice(0, input.edgeLimit).map(({ edge }) => exactProvenanceEdge(edge)),
      hasMoreEdges: page.length > input.edgeLimit,
    };
  }

  private neighbors(input: VcsNeighborsInput): Row {
    const cursorBasis = { root: input.root };
    const edges = this.neighborEdges(input.root as Row, input.cursor, input.limit + 1);
    return {
      root: input.root,
      edges: edges.slice(0, input.limit).map(({ edge }) => exactProvenanceEdge(edge)),
      nextCursor:
        edges.length > input.limit
          ? neighborCursor(edges[input.limit - 1]!.position, cursorBasis)
          : null,
    };
  }

  private history(input: VcsHistoryInput): Row {
    const cursorBasis = { root: input.root, direction: input.direction };
    const entries = this.historyEntries(
      input.root as Row,
      input.direction,
      input.cursor,
      input.limit + 1
    );
    return {
      root: input.root,
      entries: entries.slice(0, input.limit).map(({ entry }) => entry),
      nextCursor:
        entries.length > input.limit
          ? historyCursor(entries[input.limit - 1]!.position, cursorBasis)
          : null,
    };
  }

  private blame(input: VcsBlameInput): Row {
    const root = this.deps.store.stateRoot(asState(input.state));
    const point = this.deps.store.facts.file(root, input.fileId);
    if (
      !point ||
      point.state.presence !== "placed" ||
      point.state.repositoryId !== input.repositoryId
    ) {
      throw new SemanticVcsError("InvalidReference", `Unknown file ${input.fileId}`);
    }
    if (input.range.end > point.state.coordinateExtent) {
      throw new SemanticVcsError("InvalidReference", "Blame range exceeds the exact file extent");
    }
    if (input.range.start === input.range.end) {
      return {
        state: input.state,
        fileId: input.fileId,
        coordinateKind: coordinateKindForFile(point.state),
        spans: [],
        nextCursor: null,
      };
    }
    const coordinateKind = coordinateKindForFile(point.state);
    const terminal = this.latestAppliedChangeForFile(asState(input.state), input.fileId);
    if (!terminal) {
      throw new SemanticVcsError(
        "IntegrityFailure",
        `Placed file ${input.fileId} has no originating applied change`
      );
    }
    const cursorBasis = {
      state: input.state,
      repositoryId: input.repositoryId,
      fileId: input.fileId,
      range: input.range,
    };
    const traceStart = parseBlameCursor(input.cursor, input.range, cursorBasis);
    const spans = this.traceBlameRange(
      terminal.appliedChangeId,
      {
        rootStart: traceStart,
        rootEnd: input.range.end,
        currentStart: traceStart,
        currentEnd: input.range.end,
        coordinateKind,
        path: [],
        visited: new Set(),
      },
      input.limit + 1
    );
    const ordered = spans.sort(
      (left, right) =>
        Number(left["start"]) - Number(right["start"]) || Number(left["end"]) - Number(right["end"])
    );
    const page = ordered.slice(0, input.limit).map((span) => {
      const workUnitId = String((span["workUnit"] as Row)["workUnitId"]);
      return {
        ...span,
        workUnitId,
        tier: this.intentForWorkUnit(workUnitId).tier,
      };
    });
    const next = ordered[input.limit];
    return {
      state: input.state,
      fileId: input.fileId,
      coordinateKind,
      spans: page,
      nextCursor: next ? blameCursor(cursorBasis, Number(next["start"])) : null,
    };
  }

  // -------------------------------------------------------------------------
  // Named walks, the relational contract, and entry by content.
  //
  // These three surfaces are sized to the questions agents actually ask: what
  // was attempted (cause), what else happened under that intent (cohort), and
  // what was tried and rejected (rejections); plus set-oriented access through
  // the `prov_*` views and content entry through the derived search index.
  // Every one of them derives from the same immediate edges at read time and
  // is scoped by the caller's visibility basis, so nothing here can return a
  // row the caller could not have reached by a legal hand-built walk.
  // -------------------------------------------------------------------------

  /**
   * Materialize the caller's readable basis once per operation.
   *
   * This is the exact closure `referenceStateReachable` walks per reference —
   * the event ancestry of the caller's committed heads, published main, and
   * recorded integration sources, plus the caller-reachable working chains —
   * computed once instead of per reference. Views join through it, so
   * "query-reachable" and "walk-reachable" are the same predicate by
   * construction rather than by two implementations agreeing.
   */
  private materializeVisibilityBasis(contextIds: readonly string[]): void {
    this.deps.sql.exec(`DELETE FROM prov_vis_events`);
    this.deps.sql.exec(`DELETE FROM prov_vis_applications`);
    this.deps.sql.exec(`DELETE FROM prov_vis_commands`);
    if (contextIds.length === 0) return;

    const eventRoots = new Set<string>();
    const workingApplications = new Set<string>();
    for (const contextId of contextIds) {
      const context = this.deps.store.context(contextId);
      if (!context) continue;
      eventRoots.add(context.committed.ref.eventId);
      const chain = this.deps.store.workingChain(contextId, MAX_WORKING_APPLICATIONS);
      for (const applicationId of chain.applicationIds) workingApplications.add(applicationId);
      for (const sourceEventId of this.integrationSourceEventIds(chain.applicationIds)) {
        eventRoots.add(sourceEventId);
      }
    }
    const mainEventId = this.deps.store.mainEventId();
    if (mainEventId) eventRoots.add(mainEventId);

    const events = new Set<string>();
    for (const rootEventId of eventRoots) {
      for (const eventId of this.eventAncestors(rootEventId)) events.add(eventId);
    }
    execBatchedInsert(
      this.deps.sql,
      `INSERT OR IGNORE INTO prov_vis_events (event_id)`,
      1,
      [...events].map((eventId) => [eventId])
    );
    execBatchedInsert(
      this.deps.sql,
      `INSERT OR IGNORE INTO prov_vis_applications (application_id)`,
      1,
      [...workingApplications].map((applicationId) => [applicationId])
    );
    this.deps.sql.exec(
      `INSERT OR IGNORE INTO prov_vis_applications (application_id)
         SELECT link.application_id FROM gad_workspace_event_applications link
           JOIN prov_vis_events vis ON vis.event_id = link.event_id`
    );
    this.deps.sql.exec(
      `INSERT OR IGNORE INTO prov_vis_commands (command_id)
         SELECT event.command_id FROM gad_workspace_events event
           JOIN prov_vis_events vis ON vis.event_id = event.event_id`
    );
    this.deps.sql.exec(
      `INSERT OR IGNORE INTO prov_vis_commands (command_id)
         SELECT work.command_id FROM gad_work_units work
           JOIN gad_work_unit_applications app ON app.work_unit_id = work.work_unit_id
           JOIN prov_vis_applications vis ON vis.application_id = app.application_id`
    );
    this.deps.sql.exec(
      `INSERT OR IGNORE INTO prov_vis_commands (command_id)
         SELECT command_id FROM vcs_command_journal
          WHERE scope_kind = 'context'
            AND scope_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
      canonicalJson([...contextIds])
    );
  }

  private visibleWorkUnitIds(workUnitIds: readonly string[]): Set<string> {
    if (workUnitIds.length === 0) return new Set();
    const rows = this.deps.sql
      .exec(
        `SELECT work_unit_id FROM prov_work_units
          WHERE work_unit_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
        canonicalJson([...workUnitIds])
      )
      .toArray() as Row[];
    return new Set(rows.map((row) => String(row["work_unit_id"])));
  }

  private visibleCommand(commandId: string): boolean {
    return (
      this.deps.sql
        .exec(`SELECT 1 FROM prov_vis_commands WHERE command_id = ? LIMIT 1`, commandId)
        .toArray().length > 0
    );
  }

  private walk(input: VcsWalkInput): Row {
    this.materializeVisibilityBasis(input.visibilityContextIds ?? []);
    const subject = input.subject as Row;
    const basis = { walk: input.walk, subject: input.subject, scope: input.scope };
    const offset = walkCursorOffset(input.cursor, basis);
    const page =
      input.walk === "cause"
        ? this.causeWalk(subject)
        : input.walk === "cohort"
          ? this.cohortWalk(subject, input.scope)
          : this.rejectionsWalk(subject);
    const entries = page.entries.slice(offset, offset + input.limit);
    return {
      walk: input.walk,
      scope: input.walk === "cohort" ? input.scope : null,
      subject: input.subject,
      entries,
      omitted: page.omitted,
      notes: page.notes,
      nextCursor:
        offset + input.limit < page.entries.length
          ? semanticCursor("walk", basis, { offset: offset + input.limit })
          : null,
    };
  }

  /**
   * Resolve any subject to the authored work unit that explains it. The walk
   * never fabricates a work unit: a subject with no authored origin returns
   * null and the caller renders that as a boundary.
   */
  private walkOriginWorkUnit(subject: Row): { workUnitId: string; via: Row[] } | null {
    const kind = String(subject["kind"] ?? "");
    const via: Row[] = [];
    let changeId: string | null = null;
    if (kind === "work-unit") return { workUnitId: String(subject["workUnitId"]), via };
    if (kind === "change") changeId = String(subject["changeId"]);
    if (kind === "applied-change") {
      const row = this.deps.sql
        .exec(
          `SELECT change_id FROM gad_applied_changes WHERE applied_change_id = ?`,
          String(subject["appliedChangeId"])
        )
        .toArray()[0] as Row | undefined;
      if (!row) return null;
      changeId = String(row["change_id"]);
      via.push({ kind: "change", changeId });
    }
    if (kind === "file") {
      const terminal = this.latestAppliedChangeForFile(
        asState(subject["state"] as StateNodeRef),
        String(subject["fileId"])
      );
      if (!terminal) return null;
      via.push({ kind: "applied-change", appliedChangeId: terminal.appliedChangeId });
      via.push({ kind: "change", changeId: terminal.changeId });
      return { workUnitId: terminal.workUnitId, via };
    }
    if (kind === "application") {
      const row = this.deps.sql
        .exec(
          `SELECT work_unit_id FROM gad_work_unit_applications WHERE application_id = ?`,
          String(subject["applicationId"])
        )
        .toArray()[0] as Row | undefined;
      return row ? { workUnitId: String(row["work_unit_id"]), via } : null;
    }
    if (kind === "decision") {
      const row = this.deps.sql
        .exec(
          `SELECT work_unit_id FROM gad_integration_decisions WHERE decision_id = ?`,
          String(subject["decisionId"])
        )
        .toArray()[0] as Row | undefined;
      return row ? { workUnitId: String(row["work_unit_id"]), via } : null;
    }
    if (kind === "external-delta") {
      const row = this.deps.sql
        .exec(
          `SELECT work_unit_id FROM gad_external_deltas WHERE delta_id = ?`,
          String(subject["deltaId"])
        )
        .toArray()[0] as Row | undefined;
      return row ? { workUnitId: String(row["work_unit_id"]), via } : null;
    }
    if (kind === "event") {
      const row = this.deps.sql
        .exec(
          `SELECT app.work_unit_id AS work_unit_id
             FROM gad_workspace_event_applications link
             JOIN gad_work_unit_applications app ON app.application_id = link.application_id
            WHERE link.event_id = ? ORDER BY link.ordinal DESC LIMIT 1`,
          String(subject["eventId"])
        )
        .toArray()[0] as Row | undefined;
      return row ? { workUnitId: String(row["work_unit_id"]), via } : null;
    }
    if (changeId === null) return null;
    const row = this.deps.sql
      .exec(`SELECT work_unit_id FROM gad_changes WHERE change_id = ?`, changeId)
      .toArray()[0] as Row | undefined;
    return row ? { workUnitId: String(row["work_unit_id"]), via } : null;
  }

  private changeLabel(changeId: string): string {
    const row = this.deps.sql
      .exec(
        `SELECT change.kind AS kind, coalesce(result.path, base.path) AS path
           FROM gad_changes change
           LEFT JOIN gad_change_coordinates base
                  ON base.change_id = change.change_id AND base.role = 'base'
           LEFT JOIN gad_change_coordinates result
                  ON result.change_id = change.change_id AND result.role = 'result'
          WHERE change.change_id = ? LIMIT 1`,
        changeId
      )
      .toArray()[0] as Row | undefined;
    if (!row) return "change";
    const path = row["path"] == null ? null : String(row["path"]);
    return `${publicChangeKind(String(row["kind"]))}${path ? ` ${path}` : ""}`;
  }

  private messageExcerpt(logId: string, head: string, messageId: string): Row | null {
    try {
      return this.inspectNode({ kind: "trajectory-message", logId, head, messageId })[
        "value"
      ] as Row;
    } catch {
      return null;
    }
  }

  /**
   * Q2 — what was actually being attempted. One indented causal narrative from
   * any subject up to the originating human statement, stopping at whatever
   * evidence boundary it actually reaches instead of inventing continuity.
   */
  private causeWalk(subject: Row): WalkPage {
    const entries: Row[] = [];
    const notes: string[] = [];
    const origin = this.walkOriginWorkUnit(subject);
    if (!origin) {
      return {
        entries: [
          {
            node: subject,
            label: `${String(subject["kind"])} has no authored origin in the record`,
            depth: 0,
            boundary: "no-recorded-cause",
          },
        ],
        omitted: [],
        notes,
      };
    }
    let depth = 0;
    for (const node of origin.via) {
      entries.push({
        node,
        label:
          node["kind"] === "change"
            ? this.changeLabel(String(node["changeId"]))
            : "applied change",
        depth,
      });
      depth += 1;
    }
    if (this.visibleWorkUnitIds([origin.workUnitId]).size === 0) {
      entries.push({
        node: { kind: "work-unit", workUnitId: origin.workUnitId },
        label: "authoring work is outside your visible basis",
        depth,
        boundary: "outside-visibility",
      });
      return { entries, omitted: [], notes };
    }
    const work = this.deps.sql
      .exec(
        `SELECT kind, command_id, external_snapshot_json, content_class
           FROM gad_work_units WHERE work_unit_id = ? LIMIT 1`,
        origin.workUnitId
      )
      .toArray()[0] as Row | undefined;
    if (!work) return { entries, omitted: [], notes };
    const workKind = String(work["kind"]);
    const workIntent = this.intentForWorkUnit(origin.workUnitId);
    const workStatement = this.statementForWorkUnit(origin.workUnitId);
    entries.push({
      node: { kind: "work-unit", workUnitId: origin.workUnitId },
      label: `work unit · ${workKind}`,
      depth,
      intent: workIntent,
      // Only when it adds evidence: at trigger tier the resolved text already
      // is the statement, so repeating it would be rent without information.
      ...(workStatement && workIntent.tier !== "trigger"
        ? { statement: workStatement }
        : {}),
      ...(workKind === "import" ? { boundary: "import-snapshot" as const } : {}),
      ...(workKind === "external-unapplied" ? { boundary: "external-delta" as const } : {}),
    });
    depth += 1;
    if (workKind === "import" || workKind === "external-unapplied") {
      notes.push(
        workKind === "import"
          ? "Authorship before this import boundary is outside workspace history."
          : "This work declares a change made outside the workspace."
      );
      return { entries, omitted: [], notes };
    }
    const commandId = String(work["command_id"]);
    if (!this.visibleCommand(commandId)) {
      entries.push({
        node: { kind: "command", commandId },
        label: "originating command is outside your visible basis",
        depth,
        boundary: "outside-visibility",
      });
      return { entries, omitted: [], notes };
    }
    const command = this.deps.sql
      .exec(`SELECT method, status FROM vcs_command_journal WHERE command_id = ? LIMIT 1`, commandId)
      .toArray()[0] as Row | undefined;
    entries.push({
      node: { kind: "command", commandId },
      label: `command · ${command ? String(command["method"]) : "unknown method"}`,
      depth,
    });
    depth += 1;
    const cause = this.readMemoryCause(commandId);
    if (!cause) {
      entries[entries.length - 1] = {
        ...entries[entries.length - 1]!,
        boundary: "no-recorded-cause",
      };
      notes.push("This command records no causing tool invocation.");
      return { entries, omitted: [], notes };
    }
    const invocation = cause["invocation"] as Row;
    entries.push({
      node: invocation,
      label: `tool invocation · ${cause["toolName"] == null ? "unnamed" : String(cause["toolName"])}`,
      depth,
      ...(cause["terminalOutcome"] == null
        ? {}
        : { detail: `outcome ${String(cause["terminalOutcome"])}` }),
    });
    depth += 1;
    const turn = cause["turn"] as Row | null;
    if (turn) {
      entries.push({
        node: turn,
        label: "turn",
        depth,
        ...(cause["turnSummary"] == null
          ? {}
          : { detail: boundedMemoryText(String(cause["turnSummary"]), 300) ?? "" }),
      });
      depth += 1;
    }
    let message = cause["message"] as Row | null;
    const seen = new Set<string>();
    for (let hop = 0; message && hop < MAX_CAUSE_MESSAGE_HOPS; hop += 1) {
      const logId = String(message["logId"]);
      const head = String(message["head"]);
      const messageId = String(message["messageId"]);
      if (seen.has(messageId)) break;
      seen.add(messageId);
      const value = this.messageExcerpt(logId, head, messageId);
      if (!value) break;
      const sender = value["senderRef"] as Row | null;
      const senderKind = sender ? String(sender["kind"]) : null;
      const role = String(value["role"] ?? "");
      const text = (Array.isArray(value["textBlocks"]) ? (value["textBlocks"] as Row[]) : [])
        .map((block) => String(block["content"] ?? ""))
        .join("\n");
      const human = senderKind === "user" || (senderKind === null && role === "user");
      const statementText = human ? boundedMemoryText(text, 2_000) : null;
      entries.push({
        node: message,
        label: `message · ${role}${senderKind ? ` from ${senderKind}` : ""}`,
        depth,
        ...(!human && boundedMemoryText(text, 600)
          ? { detail: boundedMemoryText(text, 600)! }
          : {}),
        // The originating statement is the answer this walk exists to deliver,
        // not an incidental mention, so it travels as a statement rather than
        // as a compacted detail.
        ...(statementText
          ? { statement: { text: statementText, sender: senderKind ?? role ?? "requester" } }
          : {}),
        ...(human
          ? { boundary: "human-statement" as const }
          : senderKind === "agent"
            ? { boundary: "subagent-brief" as const }
            : {}),
      });
      depth += 1;
      if (human || senderKind === "agent") break;
      const sourceMessageId =
        typeof value["sourceMessageId"] === "string" ? value["sourceMessageId"] : null;
      message = sourceMessageId
        ? { kind: "trajectory-message", logId, head, messageId: sourceMessageId }
        : null;
      if (!message) {
        notes.push("The chain ends at a message with no recorded source.");
      }
    }
    return { entries, omitted: [], notes };
  }

  /**
   * Q3 — what else happened under that intent. Axioms are imputed from
   * patterns across a cohort, not from single edits, so this renders the whole
   * neighborhood of one scope as a grouped manifest.
   */
  /**
   * Work units a subject scopes directly, or null when the subject is an
   * ordinary artifact that must be resolved through its authoring work unit.
   */
  private cohortScopeSeed(subject: Row): string[] | null {
    const kind = String(subject["kind"] ?? "");
    if (kind === "event") {
      return (
        this.deps.sql
          .exec(
            `SELECT DISTINCT app.work_unit_id AS work_unit_id
               FROM gad_workspace_event_applications link
               JOIN gad_work_unit_applications app ON app.application_id = link.application_id
              WHERE link.event_id = ?`,
            String(subject["eventId"])
          )
          .toArray() as Row[]
      ).map((row) => String(row["work_unit_id"]));
    }
    if (kind === "trajectory-turn") {
      return (
        this.deps.sql
          .exec(
            `SELECT DISTINCT work.work_unit_id AS work_unit_id
               FROM trajectory_invocations invocation
               JOIN vcs_command_journal command
                 ON command.cause_log_id = invocation.log_id
                AND command.cause_head = invocation.head
                AND command.cause_invocation_id = invocation.invocation_id
               JOIN gad_work_units work ON work.command_id = command.command_id
              WHERE invocation.log_id = ? AND invocation.head = ? AND invocation.turn_id = ?`,
            String(subject["logId"]),
            String(subject["head"]),
            String(subject["turnId"])
          )
          .toArray() as Row[]
      ).map((row) => String(row["work_unit_id"]));
    }
    if (kind === "command") {
      return (
        this.deps.sql
          .exec(
            `SELECT work_unit_id FROM gad_work_units WHERE command_id = ?`,
            String(subject["commandId"])
          )
          .toArray() as Row[]
      ).map((row) => String(row["work_unit_id"]));
    }
    return null;
  }

  private cohortWalk(subject: Row, scope: "work-unit" | "command" | "turn"): WalkPage {
    const notes: string[] = [];
    // A cohort subject may itself *be* a scope. A commit event carries a whole
    // application chain and a turn carries a whole request, so resolving either
    // through one representative work unit answers a narrower question than the
    // caller asked. Seed directly from the scope when the subject names one.
    const seeded = this.cohortScopeSeed(subject);
    if (seeded) {
      if (seeded.length === 0) {
        notes.push("This subject carries no authored work in your visible basis.");
      }
      return this.cohortManifest(seeded, notes);
    }
    const origin = this.walkOriginWorkUnit(subject);
    if (!origin) {
      return {
        entries: [
          {
            node: subject,
            label: `${String(subject["kind"])} has no authored origin in the record`,
            depth: 0,
            boundary: "no-recorded-cause",
          },
        ],
        omitted: [],
        notes: [],
      };
    }
    let workUnitIds = [origin.workUnitId];
    if (scope !== "work-unit") {
      const commandRow = this.deps.sql
        .exec(`SELECT command_id FROM gad_work_units WHERE work_unit_id = ?`, origin.workUnitId)
        .toArray()[0] as Row | undefined;
      const commandId = commandRow ? String(commandRow["command_id"]) : null;
      if (commandId) {
        if (scope === "command") {
          workUnitIds = (
            this.deps.sql
              .exec(`SELECT work_unit_id FROM gad_work_units WHERE command_id = ?`, commandId)
              .toArray() as Row[]
          ).map((row) => String(row["work_unit_id"]));
        } else {
          const rows = this.deps.sql
            .exec(
              `SELECT work.work_unit_id AS work_unit_id
                 FROM vcs_command_journal origin
                 JOIN trajectory_invocations originInvocation
                   ON originInvocation.log_id = origin.cause_log_id
                  AND originInvocation.head = origin.cause_head
                  AND originInvocation.invocation_id = origin.cause_invocation_id
                 JOIN trajectory_invocations sibling
                   ON sibling.log_id = originInvocation.log_id
                  AND sibling.head = originInvocation.head
                  AND sibling.turn_id = originInvocation.turn_id
                 JOIN vcs_command_journal command
                   ON command.cause_log_id = sibling.log_id
                  AND command.cause_head = sibling.head
                  AND command.cause_invocation_id = sibling.invocation_id
                 JOIN gad_work_units work ON work.command_id = command.command_id
                WHERE origin.command_id = ?`,
              commandId
            )
            .toArray() as Row[];
          workUnitIds = rows.map((row) => String(row["work_unit_id"]));
          if (workUnitIds.length === 0) {
            workUnitIds = [origin.workUnitId];
            notes.push("This work has no recorded turn; the cohort fell back to its work unit.");
          }
        }
      }
    }
    return this.cohortManifest(workUnitIds, notes);
  }

  /** The grouped manifest one scope's work units produce, whatever seeded them. */
  private cohortManifest(workUnitIds: readonly string[], notes: string[]): WalkPage {
    const visible = this.visibleWorkUnitIds(workUnitIds);
    const omitted: Row[] = [];
    if (visible.size < workUnitIds.length) {
      omitted.push({
        label: "work units outside your visible basis",
        count: workUnitIds.length - visible.size,
      });
    }
    const scopedWorkUnitIds = [...visible].sort(compareUtf16CodeUnits);
    const entries: Row[] = [];
    for (const workUnitId of scopedWorkUnitIds) {
      const row = this.deps.sql
        .exec(`SELECT kind FROM gad_work_units WHERE work_unit_id = ?`, workUnitId)
        .toArray()[0] as Row | undefined;
      entries.push({
        node: { kind: "work-unit", workUnitId },
        label: `work unit · ${row ? String(row["kind"]) : "unknown"}`,
        depth: 0,
        group: "work",
        intent: this.intentForWorkUnit(workUnitId),
      });
    }
    if (scopedWorkUnitIds.length === 0) return { entries, omitted, notes };
    const scopedJson = canonicalJson(scopedWorkUnitIds);
    const coordinates = this.deps.sql
      .exec(
        `SELECT coalesce(result.path, base.path) AS path,
                count(*) AS change_count,
                min(change.change_id) AS sample_change_id
           FROM gad_changes change
           LEFT JOIN gad_change_coordinates base
                  ON base.change_id = change.change_id AND base.role = 'base'
           LEFT JOIN gad_change_coordinates result
                  ON result.change_id = change.change_id AND result.role = 'result'
          WHERE change.work_unit_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          GROUP BY coalesce(result.path, base.path)
          ORDER BY change_count DESC, path`,
        scopedJson
      )
      .toArray() as Row[];
    for (const row of coordinates) {
      const count = Number(row["change_count"]);
      entries.push({
        node: { kind: "change", changeId: String(row["sample_change_id"]) },
        label: `${row["path"] == null ? "workspace coordinate" : String(row["path"])} · ${count} change${count === 1 ? "" : "s"}`,
        depth: 0,
        group: "coordinates",
      });
    }
    const decisions = this.deps.sql
      .exec(
        `SELECT decision_id FROM gad_integration_decisions
          WHERE work_unit_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          ORDER BY created_at DESC, decision_id`,
        scopedJson
      )
      .toArray() as Row[];
    for (const row of decisions) {
      entries.push({
        node: { kind: "decision", decisionId: String(row["decision_id"]) },
        label: "integration decision",
        depth: 0,
        group: "decisions",
      });
    }
    const commits = this.deps.sql
      .exec(
        `SELECT DISTINCT event.event_id AS event_id, event.message AS message,
                event.created_at AS created_at
           FROM gad_work_units work
           JOIN gad_work_unit_applications app ON app.work_unit_id = work.work_unit_id
           JOIN gad_workspace_event_applications link
             ON link.application_id = app.application_id
           JOIN gad_workspace_events event ON event.event_id = link.event_id
           JOIN prov_vis_events vis ON vis.event_id = event.event_id
          WHERE work.work_unit_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          ORDER BY event.created_at DESC, event.event_id`,
        scopedJson
      )
      .toArray() as Row[];
    for (const row of commits) {
      entries.push({
        node: { kind: "event", eventId: String(row["event_id"]) },
        label: `commit · ${row["message"] == null ? "no message" : boundedMemoryText(String(row["message"]), 200)}`,
        depth: 0,
        group: "commits",
      });
    }
    return { entries, omitted, notes };
  }

  /**
   * Q6 — what was tried and rejected here. For theory update a rejection is
   * worth ten confirmations, so counteractions, reverts, superseded external
   * deltas, and `ours`/`current` merge resolutions are collected in one place
   * with the intent that explains *why* the work was undone.
   */
  private rejectionsWalk(subject: Row): WalkPage {
    const kind = String(subject["kind"] ?? "");
    let fileId: string | null = null;
    let repositoryId: string | null = null;
    if (kind === "file") {
      fileId = String(subject["fileId"]);
      repositoryId = String(subject["repositoryId"]);
    } else {
      const origin = this.walkOriginWorkUnit(subject);
      const changeId = origin?.via.find((node) => node["kind"] === "change")?.["changeId"];
      if (typeof changeId === "string") {
        const row = this.deps.sql
          .exec(
            `SELECT file_id, repository_id FROM gad_change_coordinates
              WHERE change_id = ? ORDER BY role LIMIT 1`,
            changeId
          )
          .toArray()[0] as Row | undefined;
        fileId = row?.["file_id"] == null ? null : String(row["file_id"]);
        repositoryId = row?.["repository_id"] == null ? null : String(row["repository_id"]);
      }
    }
    const notes: string[] = [];
    const entries: Row[] = [];
    if (fileId === null && repositoryId === null) {
      notes.push("This subject has no file or repository coordinate to collect rejections for.");
      return { entries, omitted: [], notes };
    }
    const counteractions = this.deps.sql
      .exec(
        `SELECT counteraction.change_id AS counteracting_change_id,
                counteraction.counteracted_change_id AS counteracted_change_id,
                counteracting.work_unit_id AS counteracting_work_unit_id,
                counteracted.work_unit_id AS counteracted_work_unit_id,
                work.created_at AS created_at
           FROM gad_change_coordinates coordinate
           JOIN gad_change_counteractions counteraction
             ON counteraction.counteracted_change_id = coordinate.change_id
           JOIN gad_changes counteracted ON counteracted.change_id = coordinate.change_id
           JOIN gad_changes counteracting ON counteracting.change_id = counteraction.change_id
           JOIN gad_work_units work ON work.work_unit_id = counteracting.work_unit_id
          WHERE coordinate.file_id = ?
          ORDER BY work.created_at DESC, counteraction.change_id
          LIMIT ?`,
        fileId,
        MAX_REJECTION_ROWS
      )
      .toArray() as Row[];
    const visible = this.visibleWorkUnitIds([
      ...counteractions.map((row) => String(row["counteracting_work_unit_id"])),
      ...counteractions.map((row) => String(row["counteracted_work_unit_id"])),
    ]);
    let hidden = 0;
    for (const row of counteractions) {
      const counteractingWorkUnitId = String(row["counteracting_work_unit_id"]);
      const counteractedWorkUnitId = String(row["counteracted_work_unit_id"]);
      if (!visible.has(counteractingWorkUnitId) || !visible.has(counteractedWorkUnitId)) {
        hidden += 1;
        continue;
      }
      const attempted = this.intentForWorkUnit(counteractedWorkUnitId);
      entries.push({
        node: { kind: "work-unit", workUnitId: counteractingWorkUnitId },
        label: `undone · ${this.changeLabel(String(row["counteracted_change_id"]))}`,
        depth: 0,
        group: "counteractions",
        intent: this.intentForWorkUnit(counteractingWorkUnitId),
        detail: `attempted (${attempted.tier}): ${boundedMemoryText(attempted.text, 300) ?? ""}`,
      });
    }
    const reverts = this.deps.sql
      .exec(
        `SELECT DISTINCT work.work_unit_id AS work_unit_id, work.created_at AS created_at
           FROM gad_work_units work
           JOIN gad_changes change ON change.work_unit_id = work.work_unit_id
           JOIN gad_change_coordinates coordinate ON coordinate.change_id = change.change_id
          WHERE work.kind = 'revert' AND coordinate.file_id = ?
          ORDER BY work.created_at DESC, work.work_unit_id
          LIMIT ?`,
        fileId,
        MAX_REJECTION_ROWS
      )
      .toArray() as Row[];
    const visibleReverts = this.visibleWorkUnitIds(
      reverts.map((row) => String(row["work_unit_id"]))
    );
    for (const row of reverts) {
      const workUnitId = String(row["work_unit_id"]);
      if (!visibleReverts.has(workUnitId)) {
        hidden += 1;
        continue;
      }
      entries.push({
        node: { kind: "work-unit", workUnitId },
        label: "revert",
        depth: 0,
        group: "reverts",
        intent: this.intentForWorkUnit(workUnitId),
      });
    }
    if (repositoryId !== null) {
      const superseded = this.deps.sql
        .exec(
          `SELECT delta.delta_id AS delta_id, delta.work_unit_id AS work_unit_id,
                  delta.repo_path AS repo_path, delta.created_at AS created_at
             FROM gad_external_deltas delta
            WHERE delta.repository_id = ? AND delta.status = 'superseded'
            ORDER BY delta.created_at DESC, delta.delta_id
            LIMIT ?`,
          repositoryId,
          MAX_REJECTION_ROWS
        )
        .toArray() as Row[];
      const visibleDeltas = this.visibleWorkUnitIds(
        superseded.map((row) => String(row["work_unit_id"]))
      );
      for (const row of superseded) {
        const workUnitId = String(row["work_unit_id"]);
        if (!visibleDeltas.has(workUnitId)) {
          hidden += 1;
          continue;
        }
        entries.push({
          node: { kind: "external-delta", deltaId: String(row["delta_id"]) },
          label: `superseded external delta · ${String(row["repo_path"])}`,
          depth: 0,
          group: "external",
          intent: this.intentForWorkUnit(workUnitId),
        });
      }
    }
    if (fileId !== null) {
      const declined = this.deps.sql
        .exec(
          `SELECT entry.decision_id AS decision_id, entry.resolution AS resolution,
                  entry.rationale AS rationale, decision.work_unit_id AS work_unit_id,
                  decision.created_at AS created_at
             FROM gad_merge_decision_entries entry
             JOIN gad_integration_decisions decision ON decision.decision_id = entry.decision_id
            WHERE entry.coordinate_kind = 'file' AND entry.coordinate_id = ?
              AND entry.resolution IN ('ours', 'current')
            ORDER BY decision.created_at DESC, entry.decision_id
            LIMIT ?`,
          fileId,
          MAX_REJECTION_ROWS
        )
        .toArray() as Row[];
      const visibleDecisions = this.visibleWorkUnitIds(
        declined.map((row) => String(row["work_unit_id"]))
      );
      for (const row of declined) {
        const workUnitId = String(row["work_unit_id"]);
        if (!visibleDecisions.has(workUnitId)) {
          hidden += 1;
          continue;
        }
        entries.push({
          node: { kind: "decision", decisionId: String(row["decision_id"]) },
          label: `incoming change declined · resolved ${String(row["resolution"])}`,
          depth: 0,
          group: "merge",
          intent: this.intentForWorkUnit(workUnitId),
          ...(row["rationale"] == null
            ? {}
            : { detail: `rationale: ${boundedMemoryText(String(row["rationale"]), 300)}` }),
        });
      }
    }
    if (entries.length === 0) {
      notes.push("Nothing has been rejected at this coordinate in your visible basis.");
    }
    return {
      entries,
      omitted: hidden > 0 ? [{ label: "rejections outside your visible basis", count: hidden }] : [],
      notes,
    };
  }

  private query(input: VcsQueryInput): Row {
    this.materializeVisibilityBasis(input.visibilityContextIds ?? []);
    return executeProvenanceQuery(this.deps.sql, {
      query: input.query,
      limit: input.limit,
    }) as unknown as Row;
  }

  /**
   * Q7 — find the subject you cannot name. Without content entry every
   * question that starts from a hunch instead of an identity is unaskable, and
   * the abduction loop starts from hunches.
   */
  private search(input: VcsSearchInput): Row {
    this.materializeVisibilityBasis(input.visibilityContextIds ?? []);
    const limit = Math.min(input.limit, 50);
    /**
     * The unranked fallback matches every term rather than the whole phrase.
     * A literal substring match means "relay payload limits" finds nothing
     * while "relay" finds everything — degrading *results*, not just ranking,
     * which is the one thing the fallback is not allowed to do.
     */
    const terms = input.text
      .split(/\s+/u)
      .map((term) => term.trim())
      .filter((term) => term.length > 0)
      .slice(0, 8);
    const scan = (): Row[] => {
      const predicate = (terms.length > 0 ? terms : [input.text])
        .map(() => `lower(text) LIKE '%' || lower(?) || '%'`)
        .join(" AND ");
      return this.deps.sql
        .exec(
          `SELECT subject_kind, subject_id, log_id, head, label,
                  substr(text, 1, 400) AS excerpt
             FROM prov_search
            WHERE ${predicate}
            LIMIT ?`,
          ...(terms.length > 0 ? terms : [input.text]),
          limit + 1
        )
        .toArray() as Row[];
    };
    /**
     * Ranked search reads the index directly, because `MATCH`, `bm25`, and
     * `snippet` all need the FTS table by name — not a view over it, and not
     * an alias for it — and re-derives visibility by existence in `prov_search`
     * rather than restating the predicate, so there stays one definition of
     * what a caller may see, as §2.2.2 requires.
     */
    const ranked = (): Row[] =>
      this.deps.sql
        .exec(
          `SELECT prov_search_index.subject_kind AS subject_kind,
                  prov_search_index.subject_id AS subject_id,
                  prov_search_index.log_id AS log_id,
                  prov_search_index.head AS head,
                  prov_search_index.label AS label,
                  snippet(prov_search_index, 0, '', '', '…', 24) AS excerpt
             FROM prov_search_index
            WHERE prov_search_index MATCH ?
              AND EXISTS (
                SELECT 1 FROM prov_search visible
                 WHERE visible.subject_kind = prov_search_index.subject_kind
                   AND visible.subject_id = prov_search_index.subject_id
                   AND visible.log_id IS prov_search_index.log_id
                   AND visible.head IS prov_search_index.head
              )
            ORDER BY bm25(prov_search_index)
            LIMIT ?`,
          ftsMatchExpression(input.text),
          limit + 1
        )
        .toArray() as Row[];
    let mode = provenanceSearchIndexMode(this.deps.sql) ?? "plain";
    let rows: Row[];
    if (mode === "fts") {
      try {
        rows = ranked();
      } catch (error) {
        // Ranking is an optimization; entry by content is the capability. A
        // ranked path that fails on the deployed engine must degrade to the
        // scan and say so, not make the question unanswerable.
        console.warn("[ProvenanceSearch] ranked search unavailable; falling back to scan", {
          message: error instanceof Error ? error.message : String(error),
        });
        mode = "plain";
        rows = scan();
      }
    } else {
      rows = scan();
    }
    const hits = rows.slice(0, limit).map((row) => {
      const subjectKind = String(row["subject_kind"]);
      const subjectId = String(row["subject_id"]);
      const node =
        subjectKind === "work-unit"
          ? { kind: "work-unit", workUnitId: subjectId }
          : subjectKind === "decision"
            ? { kind: "decision", decisionId: subjectId }
            : subjectKind === "event"
              ? { kind: "event", eventId: subjectId }
              : subjectKind === "external-delta"
                ? { kind: "external-delta", deltaId: subjectId }
                : {
                    kind: "trajectory-message",
                    logId: String(row["log_id"]),
                    head: String(row["head"]),
                    messageId: subjectId,
                  };
      return {
        node,
        subjectKind,
        label: row["label"] == null ? subjectKind : String(row["label"]),
        excerpt: boundedMemoryText(String(row["excerpt"] ?? ""), 600) ?? subjectKind,
        ...(subjectKind === "work-unit"
          ? { intent: this.intentForWorkUnit(subjectId) }
          : {}),
      };
    });
    return {
      text: input.text,
      indexMode: mode === "fts" ? "fts" : "scan",
      hits,
      truncated: rows.length > limit,
    };
  }

  /**
   * Freeze the one loader's output onto the work-unit row and index its prose.
   *
   * SQL views evaluate at query time and cannot call the TypeScript loader, so
   * a view expression carrying the ladder would be a second resolver
   * implementation. Persisting the loader's own output instead keeps exactly
   * one implementation of the ladder in the system.
   */
  private recordDerivedWorkUnitIndex(workUnitId: string): void {
    const intent = this.intentForWorkUnit(workUnitId);
    this.deps.sql.exec(
      `UPDATE gad_work_units
          SET resolved_intent_text = ?, resolved_intent_tier = ?, resolver_protocol = ?
        WHERE work_unit_id = ?`,
      intent.text,
      intent.tier,
      PROV_RESOLVER_PROTOCOL,
      workUnitId
    );
    const trigger = this.deps.sql
      .exec(`SELECT trigger_excerpt FROM gad_work_units WHERE work_unit_id = ?`, workUnitId)
      .toArray()[0] as Row | undefined;
    this.indexSearchSubject("work-unit", workUnitId, null, null, `work unit`, [
      intent.text,
      trigger?.["trigger_excerpt"] == null ? "" : String(trigger["trigger_excerpt"]),
    ]);
    const decisions = this.deps.sql
      .exec(
        `SELECT decision.decision_id AS decision_id, entry.rationale AS rationale
           FROM gad_integration_decisions decision
           LEFT JOIN gad_merge_decision_entries entry ON entry.decision_id = decision.decision_id
          WHERE decision.work_unit_id = ?`,
        workUnitId
      )
      .toArray() as Row[];
    const rationales = new Map<string, string[]>();
    for (const row of decisions) {
      const decisionId = String(row["decision_id"]);
      const bucket = rationales.get(decisionId) ?? [];
      if (row["rationale"] != null) bucket.push(String(row["rationale"]));
      rationales.set(decisionId, bucket);
    }
    for (const [decisionId, texts] of rationales) {
      this.indexSearchSubject("decision", decisionId, null, null, "integration decision", texts);
    }
    const delta = this.deps.sql
      .exec(`SELECT delta_id, repo_path FROM gad_external_deltas WHERE work_unit_id = ?`, workUnitId)
      .toArray()[0] as Row | undefined;
    if (delta) {
      this.indexSearchSubject(
        "external-delta",
        String(delta["delta_id"]),
        null,
        null,
        `external delta · ${String(delta["repo_path"])}`,
        [intent.text]
      );
    }
  }

  /** Index one commit message; events are written outside the mutation path. */
  private indexEventMessage(eventId: string, message: string | null): void {
    if (!message) return;
    this.indexSearchSubject("event", eventId, null, null, "commit", [message]);
  }

  private indexSearchSubject(
    subjectKind: string,
    subjectId: string,
    logId: string | null,
    head: string | null,
    label: string,
    texts: readonly string[]
  ): void {
    const text = texts
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .join("\n");
    this.deps.sql.exec(
      `DELETE FROM prov_search_index WHERE subject_kind = ? AND subject_id = ?`,
      subjectKind,
      subjectId
    );
    if (!text) return;
    this.deps.sql.exec(
      `INSERT INTO prov_search_index (text, subject_kind, subject_id, log_id, head, label)
       VALUES (?, ?, ?, ?, ?, ?)`,
      boundedMemoryText(text, 4_000) ?? text,
      subjectKind,
      subjectId,
      logId,
      head,
      label
    );
  }

  /**
   * Rebuild the derived index from the canonical rows. The index is derived
   * and rebuildable by construction; nothing reads it as an authority.
   */
  rebuildProvenanceSearchIndex(): { indexed: number } {
    this.deps.sql.exec(`DELETE FROM prov_search_index`);
    const workUnits = this.deps.sql
      .exec(`SELECT work_unit_id FROM gad_work_units`)
      .toArray() as Row[];
    for (const row of workUnits) this.recordDerivedWorkUnitIndex(String(row["work_unit_id"]));
    const events = this.deps.sql
      .exec(`SELECT event_id, message FROM gad_workspace_events WHERE message IS NOT NULL`)
      .toArray() as Row[];
    for (const row of events) {
      this.indexEventMessage(String(row["event_id"]), String(row["message"]));
    }
    const messages = this.deps.sql
      .exec(
        `SELECT log_id, head, message_id, role FROM trajectory_messages
          ORDER BY log_id, head, message_id LIMIT ?`,
        MAX_INDEXED_MESSAGES
      )
      .toArray() as Row[];
    for (const row of messages) {
      const logId = String(row["log_id"]);
      const head = String(row["head"]);
      const messageId = String(row["message_id"]);
      const value = this.messageExcerpt(logId, head, messageId);
      if (!value) continue;
      const text = (Array.isArray(value["textBlocks"]) ? (value["textBlocks"] as Row[]) : [])
        .map((block) => String(block["content"] ?? ""))
        .join("\n");
      this.indexSearchSubject(
        "trajectory-message",
        messageId,
        logId,
        head,
        `message · ${String(row["role"])}`,
        [text]
      );
    }
    return {
      indexed: Number(
        (this.deps.sql.exec(`SELECT count(*) AS n FROM prov_search_index`).toArray()[0] as Row)["n"]
      ),
    };
  }

  /**
   * Recompute every persisted resolved intent through the one loader. This is
   * the migration a resolver-protocol change ships with; it never reimplements
   * the ladder.
   */
  recomputeResolvedIntents(): { recomputed: number } {
    const rows = this.deps.sql.exec(`SELECT work_unit_id FROM gad_work_units`).toArray() as Row[];
    for (const row of rows) this.recordDerivedWorkUnitIndex(String(row["work_unit_id"]));
    return { recomputed: rows.length };
  }

  /**
   * Compact read-time memory derived entirely from the canonical semantic graph.
   *
   * This is a projection, not another provenance store: blame selects the
   * exact authored work for the bytes the caller actually read, and the
   * normalized command/trajectory/event tables hydrate the bounded context a
   * future agent needs to understand that work.
   */
  private readMemory(input: VcsReadMemoryInput): Row {
    const context = this.deps.store.context(input.contextId);
    if (!context) {
      throw new SemanticVcsError("InvalidReference", `Unknown context ${input.contextId}`);
    }
    const split = splitRepoPath(input.path);
    if (!split?.repoRelPath) {
      return { status: "unmanaged", path: input.path };
    }
    const state = context.working.ref;
    const repository = this.resolveRepository({ state, repoPath: split.repoPath });
    if (!repository) return { status: "unmanaged", path: input.path };
    const root = this.deps.store.stateRoot(asState(state));
    const point = this.deps.store.facts.fileAtPath(
      root,
      repository.repositoryId,
      split.repoRelPath
    );
    if (!point || point.state.presence !== "placed") {
      return { status: "unmanaged", path: input.path };
    }
    if (point.state.contentHash !== input.expectedContentHash) {
      return {
        status: "stale",
        path: input.path,
        expectedContentHash: input.expectedContentHash,
        currentContentHash: point.state.contentHash,
      };
    }
    if (point.state.contentKind !== "text") {
      return { status: "unsupported", path: input.path, reason: "non-text" };
    }
    if (input.range.end > point.state.coordinateExtent) {
      throw new SemanticVcsError(
        "InvalidReference",
        "Read-memory range exceeds the exact file extent"
      );
    }

    const blamed = this.blame({
      state,
      repositoryId: repository.repositoryId,
      fileId: point.state.fileId,
      range: input.range,
      limit: 500,
    });
    const rawSpans = Array.isArray(blamed["spans"]) ? (blamed["spans"] as Row[]) : [];
    const grouped = new Map<
      string,
      {
        span: Row;
        ranges: Array<{ start: number; end: number }>;
      }
    >();
    for (const span of rawSpans) {
      const change = span["change"] as Row;
      const appliedChange = span["appliedChange"] as Row;
      const key = `${String(change["changeId"])}\u0000${String(appliedChange["appliedChangeId"])}`;
      const existing = grouped.get(key);
      const range = { start: Number(span["start"]), end: Number(span["end"]) };
      if (existing) existing.ranges.push(range);
      else grouped.set(key, { span, ranges: [range] });
    }

    // Blame spans do not overlap. Choosing the widest episodes first therefore
    // maximizes coverage of the displayed range before presentation salience
    // reorders the bounded sample in the harness.
    const episodes = [...grouped.values()]
      .sort((left, right) => {
        const covered = (value: typeof left) =>
          value.ranges.reduce((total, range) => total + range.end - range.start, 0);
        return (
          covered(right) - covered(left) ||
          left.ranges[0]!.start - right.ranges[0]!.start ||
          left.ranges[0]!.end - right.ranges[0]!.end
        );
      })
      .slice(0, input.episodeLimit)
      .map(({ span, ranges }) => this.readMemoryEpisode(span, ranges, input.contextId));

    const fileRoot = {
      kind: "file",
      state,
      repositoryId: repository.repositoryId,
      fileId: point.state.fileId,
    } as const;
    const historyRows =
      input.historyLimit === 0
        ? []
        : this.historyEntries(fileRoot, "past", undefined, input.historyLimit + 1);
    return {
      status: "attached",
      state,
      repositoryId: repository.repositoryId,
      fileId: point.state.fileId,
      path: input.path,
      contentHash: point.state.contentHash,
      range: input.range,
      coordinateKind: "utf16",
      episodes,
      history: historyRows.slice(0, input.historyLimit).map(({ entry }) => entry),
      rejectionCount: this.rejectionCountForFile(input.contextId, point.state.fileId),
      truncated:
        blamed["nextCursor"] != null ||
        grouped.size > input.episodeLimit ||
        historyRows.length > input.historyLimit,
    };
  }

  /**
   * How much rejected work this coordinate carries, for the caller.
   *
   * A rejection is the strongest axiom evidence the record holds and the
   * hardest to reach: an agent has to suspect it exists before it can ask. It
   * is cheap to count here, on the path every reader already takes, so the
   * suspicion arrives with the bytes rather than having to precede them.
   */
  private rejectionCountForFile(contextId: string, fileId: string): number {
    // Almost every coordinate carries no rejected work, and this runs on the
    // ordinary read path, so the indexed existence check comes first: only a
    // coordinate that actually has counteractions pays for the visibility basis
    // the parity invariant requires.
    const any = this.deps.sql
      .exec(
        `SELECT 1
           FROM gad_change_coordinates coordinate
           JOIN gad_change_counteractions counteraction
             ON counteraction.counteracted_change_id = coordinate.change_id
          WHERE coordinate.file_id = ? LIMIT 1`,
        fileId
      )
      .toArray();
    if (any.length === 0) return 0;
    this.materializeVisibilityBasis([contextId]);
    const rows = this.deps.sql
      .exec(
        `SELECT counteracting.work_unit_id AS counteracting_work_unit_id
           FROM gad_change_coordinates coordinate
           JOIN gad_change_counteractions counteraction
             ON counteraction.counteracted_change_id = coordinate.change_id
           JOIN gad_changes counteracting ON counteracting.change_id = counteraction.change_id
          WHERE coordinate.file_id = ?
          LIMIT ?`,
        fileId,
        MAX_REJECTION_ROWS
      )
      .toArray() as Row[];
    const visible = this.visibleWorkUnitIds(
      rows.map((row) => String(row["counteracting_work_unit_id"]))
    );
    return rows.filter((row) => visible.has(String(row["counteracting_work_unit_id"]))).length;
  }

  private readMemoryEpisode(
    span: Row,
    ranges: Array<{ start: number; end: number }>,
    contextId: string
  ): Row {
    const changeRef = span["change"] as Row;
    const appliedChangeRef = span["appliedChange"] as Row;
    const workUnitRef = span["workUnit"] as Row;
    const commandRef = span["command"] as Row;
    const changeNode = this.inspectNode(changeRef);
    const workUnitNode = this.inspectNode(workUnitRef);
    const change = changeNode["value"] as Row;
    const workUnit = workUnitNode["value"] as Row;
    const workUnitId = String(workUnitRef["workUnitId"]);

    const commitRow = this.deps.sql
      .exec(
        `SELECT event.event_id, event.message, event.created_at
           FROM gad_work_unit_applications application
           JOIN gad_workspace_event_applications event_application
             ON event_application.application_id = application.application_id
           JOIN gad_workspace_events event
             ON event.event_id = event_application.event_id
          WHERE application.work_unit_id = ?
          ORDER BY event.created_at, event.event_id
          LIMIT 1`,
        workUnitId
      )
      .toArray()[0] as Row | undefined;

    const arrival = this.readMemoryArrival(span, contextId);

    return {
      ranges,
      stop: span["stop"],
      change: changeRef,
      appliedChange: appliedChangeRef,
      workUnit: workUnitRef,
      command: commandRef,
      changeKind: change["kind"],
      counteractsChangeIds: change["counteractsChangeIds"],
      intent: this.intentForWorkUnit(workUnitId),
      authorContextId: String(workUnit["authorContextId"]),
      createdAt: workUnit["createdAt"],
      externalSnapshot: workUnit["externalSnapshot"],
      commit: commitRow
        ? {
            event: { kind: "event", eventId: String(commitRow["event_id"]) },
            message: commitRow["message"] == null ? null : String(commitRow["message"]),
            createdAt: String(commitRow["created_at"]),
          }
        : null,
      arrival,
    };
  }

  private readMemoryArrival(span: Row, contextId: string): Row | null {
    const appliedChangeId = String((span["appliedChange"] as Row)["appliedChangeId"]);
    const path = Array.isArray(span["path"]) ? (span["path"] as Row[]) : [];
    const incorporation = path.find((edge) => edge["kind"] === "incorporates-content");
    const anchorAppliedChangeId = incorporation
      ? String((incorporation["from"] as Row)["appliedChangeId"] ?? "")
      : appliedChangeId;
    const authored = this.appliedChangeMetadata(appliedChangeId);
    const row = this.deps.sql
      .exec(
        `SELECT decision.decision_id, entry.coordinate_id, entry.resolution, entry.rationale
           FROM gad_applied_changes applied
           JOIN gad_work_unit_applications application
             ON application.application_id = applied.application_id
           JOIN gad_integration_decisions decision
             ON decision.work_unit_id = application.work_unit_id
           JOIN gad_merge_decision_entries entry
             ON entry.decision_id = decision.decision_id
            AND entry.coordinate_kind = 'file'
           JOIN gad_change_coordinates coordinate
             ON coordinate.change_id = ? AND coordinate.file_id = entry.coordinate_id
          WHERE applied.applied_change_id = ?
          ORDER BY decision.created_at, decision.decision_id
          LIMIT 1`,
        authored.changeId,
        anchorAppliedChangeId
      )
      .toArray()[0] as Row | undefined;
    if (!row) return null;
    const decisionId = String(row["decision_id"]);
    if (!this.provenanceNodeReachable([contextId], { kind: "decision", decisionId })) return null;
    const parentRows = (
      incorporation
        ? this.deps.sql.exec(
            `SELECT DISTINCT change.work_unit_id,
                    CASE WHEN EXISTS (
                      SELECT 1 FROM gad_decision_source_changes source
                       WHERE source.decision_id = ? AND source.change_id = change.change_id
                    ) THEN 'source' ELSE 'current' END AS role
               FROM gad_content_edges edge
               JOIN gad_applied_changes parent
                 ON parent.applied_change_id = edge.parent_applied_change_id
               JOIN gad_changes change ON change.change_id = parent.change_id
              WHERE edge.child_applied_change_id = ? AND edge.relation = 'incorporates'
              ORDER BY role DESC, change.work_unit_id LIMIT 2`,
            decisionId,
            anchorAppliedChangeId
          )
        : this.deps.sql.exec(
            `SELECT DISTINCT change.work_unit_id, 'source' AS role
               FROM gad_decision_source_changes source
               JOIN gad_changes change ON change.change_id = source.change_id
              WHERE source.decision_id = ?
                AND source.coordinate_kind = 'file'
                AND source.coordinate_id = ?
              ORDER BY change.work_unit_id LIMIT 2`,
            decisionId,
            String(row["coordinate_id"])
          )
    ).toArray() as Row[];
    return {
      decision: { kind: "decision", decisionId },
      resolution: String(row["resolution"]),
      mode: incorporation ? "arrived" : "accepted",
      rationale: row["rationale"] == null ? null : String(row["rationale"]),
      parentIntents: parentRows.map((parent) => {
        const workUnitId = String(parent["work_unit_id"]);
        return {
          workUnitId,
          role: String(parent["role"]),
          intent: this.intentForWorkUnit(workUnitId),
        };
      }),
    };
  }

  private readMemoryCause(commandId: string): Row | null {
    const command = this.deps.sql
      .exec(
        `SELECT cause_log_id, cause_head, cause_invocation_id
           FROM vcs_command_journal WHERE command_id = ?`,
        commandId
      )
      .toArray()[0] as Row | undefined;
    if (
      !command ||
      command["cause_log_id"] == null ||
      command["cause_head"] == null ||
      command["cause_invocation_id"] == null
    ) {
      return null;
    }
    const row = this.deps.sql
      .exec(
        `SELECT command.cause_log_id, command.cause_head, command.cause_invocation_id,
                invocation.turn_id, invocation.kind AS tool_name,
                invocation.terminal_outcome, invocation.request_ref_json,
                turn.summary AS turn_summary, turn.trigger_message_id
           FROM vcs_command_journal command
           LEFT JOIN trajectory_invocations invocation
             ON invocation.log_id = command.cause_log_id
            AND invocation.head = command.cause_head
            AND invocation.invocation_id = command.cause_invocation_id
           LEFT JOIN trajectory_turns turn
             ON turn.log_id = invocation.log_id
            AND turn.head = invocation.head
            AND turn.turn_id = invocation.turn_id
          WHERE command.command_id = ?
          LIMIT 1`,
        commandId
      )
      .toArray()[0] as Row | undefined;
    if (!row) {
      return null;
    }
    const logId = String(row["cause_log_id"]);
    const head = String(row["cause_head"]);
    const invocationId = String(row["cause_invocation_id"]);
    const turnId = row["turn_id"] == null ? null : String(row["turn_id"]);
    const messageId = row["trigger_message_id"] == null ? null : String(row["trigger_message_id"]);
    let triggerText: string | null = null;
    let sender: unknown = null;
    if (messageId) {
      const message = this.inspectNode({
        kind: "trajectory-message",
        logId,
        head,
        messageId,
      })["value"] as Row;
      const blocks = Array.isArray(message["textBlocks"]) ? (message["textBlocks"] as Row[]) : [];
      triggerText = boundedMemoryText(
        blocks.map((block) => String(block["content"] ?? "")).join("\n"),
        1_200
      );
      sender = message["senderRef"] ?? null;
    }
    return {
      invocation: { kind: "trajectory-invocation", logId, head, invocationId },
      turn: turnId ? { kind: "trajectory-turn", logId, head, turnId } : null,
      message: messageId ? { kind: "trajectory-message", logId, head, messageId } : null,
      toolName: row["tool_name"] == null ? null : String(row["tool_name"]),
      terminalOutcome: row["terminal_outcome"] == null ? null : String(row["terminal_outcome"]),
      requestRef:
        row["request_ref_json"] == null
          ? null
          : trajectoryRequestRef(JSON.parse(String(row["request_ref_json"]))),
      turnSummary: boundedMemoryText(
        row["turn_summary"] == null ? "" : String(row["turn_summary"]),
        600
      ),
      triggerText,
      sender,
    };
  }

  private resolveRepository(input: VcsResolveRepositoryInput): VcsResolveRepositoryResult {
    const root = this.deps.store.stateRoot(asState(input.state));
    const repository = this.deps.store.facts.repositoryAtPath(root, input.repoPath);
    if (!repository || repository.presence !== "present") return null;
    return {
      state: input.state,
      repositoryId: repository.repositoryId,
      repoPath: repository.repoPath,
    };
  }

  private readFile(input: VcsReadFileInput): SemanticDispatchResult {
    const root = this.deps.store.stateRoot(asState(input.state));
    const point =
      input.file.kind === "id"
        ? this.deps.store.facts.file(root, input.file.fileId)
        : this.deps.store.facts.fileAtPath(root, input.repositoryId, input.file.path);
    if (
      !point ||
      point.state.presence !== "placed" ||
      point.state.repositoryId !== input.repositoryId ||
      point.repository.presence !== "present" ||
      point.repository.repositoryId !== input.repositoryId
    ) {
      return { kind: "complete", result: null };
    }
    const lineage = this.fileLineageAt(asState(input.state), point.state.fileId);
    return {
      kind: "host-read",
      request: {
        kind: "read-semantic-blob",
        state: input.state,
        repositoryId: input.repositoryId,
        fileId: point.state.fileId,
        repoPath: point.repository.repoPath,
        path: point.state.path,
        contentHash: point.state.contentHash,
        ...lineage,
        mode: point.state.mode,
      },
    };
  }

  private repositoryLineages(repositoryIds: readonly string[]): Map<
    string,
    {
      authoredChangeId: null;
      authoredByWorkUnitId: string;
      contentClass: "internal" | "external";
      externalKeys: string[];
    }
  > {
    if (repositoryIds.length === 0) return new Map();
    const rows = this.deps.sql
      .exec(
        `SELECT repository.repository_id, repository.created_work_unit_id,
                work.content_class, work.external_lineage_json
           FROM vcs_repositories repository
           JOIN gad_work_units work
             ON work.work_unit_id = repository.created_work_unit_id
           JOIN json_each(?) selected
             ON CAST(selected.value AS TEXT) = repository.repository_id`,
        canonicalJson([...new Set(repositoryIds)])
      )
      .toArray() as Row[];
    const result = new Map<
      string,
      {
        authoredChangeId: null;
        authoredByWorkUnitId: string;
        contentClass: "internal" | "external";
        externalKeys: string[];
      }
    >();
    for (const row of rows) {
      const repositoryId = String(row["repository_id"]);
      const contentClass = row["content_class"];
      const externalKeys = JSON.parse(String(row["external_lineage_json"]));
      if (
        (contentClass !== "internal" && contentClass !== "external") ||
        !Array.isArray(externalKeys) ||
        !externalKeys.every((key) => typeof key === "string")
      ) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Repository ${repositoryId} has invalid persisted authoring lineage`
        );
      }
      result.set(repositoryId, {
        authoredChangeId: null,
        authoredByWorkUnitId: String(row["created_work_unit_id"]),
        contentClass,
        externalKeys,
      });
    }
    return result;
  }

  /**
   * Return only names visible at one directory boundary.
   *
   * Repository paths come from the workspace's lexical live-path index. File
   * names come from the repository manifest radix. When a manifest child is a
   * directory, the first live file below that child is its exact existence
   * witness and the radix cursor jumps to the lexical successor of the whole
   * subtree. Consequently listing a directory performs work proportional to
   * visible children, never to descendant files.
   */
  private listDirectory(input: VcsListDirectoryInput): VcsListDirectoryResult {
    const state = asState(input.state);
    const root = this.deps.store.stateRoot(state);
    const normalizedPath = input.path.replace(/^\/+|\/+$/gu, "");
    if (normalizedPath !== input.path) {
      throw new SemanticVcsError("InvalidReference", "Directory path is not canonical");
    }
    const cursorBasis = { state: input.state, path: normalizedPath };
    const cursorPosition = parseSemanticCursor(input.cursor, "list-directory", cursorBasis);
    const afterName = cursorPosition?.["name"];
    const afterKind = cursorPosition?.["kind"];
    if (
      (afterName !== undefined && typeof afterName !== "string") ||
      (afterKind !== undefined && afterKind !== "file" && afterKind !== "directory")
    ) {
      throw new SemanticVcsError("InvalidReference", "Invalid list-directory cursor position");
    }

    const repositories: PresentRepositoryState[] = [];
    let afterRepoPath: string | undefined;
    do {
      const page = this.deps.store.facts.page(root, "live-path", {
        ...(afterRepoPath ? { afterKey: afterRepoPath } : {}),
        limit: 500,
      });
      for (const { key: repoPath, value: repositoryId } of page.values) {
        const repository = this.deps.store.facts.member(root, repositoryId);
        if (!repository || repository.presence !== "present" || repository.repoPath !== repoPath) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Live repository path ${repoPath} has no exact present member`
          );
        }
        repositories.push(repository);
      }
      afterRepoPath = page.next ?? undefined;
    } while (afterRepoPath);

    const containingRepository = repositories
      .filter(
        (repository) =>
          normalizedPath === repository.repoPath ||
          normalizedPath.startsWith(`${repository.repoPath}/`)
      )
      .sort((left, right) => right.repoPath.length - left.repoPath.length)[0];

    type VisibleCandidate = {
      name: string;
      path: string;
      kind: "file" | "directory";
      identity: string;
      repositoryId: string;
      repositoryRoot: boolean;
      fileId: string | null;
      witnessFileId?: string;
    };
    let candidates: VisibleCandidate[] = [];

    if (containingRepository) {
      const relativeDirectory =
        normalizedPath === containingRepository.repoPath
          ? ""
          : normalizedPath.slice(containingRepository.repoPath.length + 1);
      const prefix = relativeDirectory ? `${relativeDirectory}/` : "";
      let afterPath =
        typeof afterName === "string"
          ? afterKind === "directory"
            ? undefined
            : `${prefix}${afterName}`
          : undefined;
      let atOrAfterPath =
        typeof afterName === "string" && afterKind === "directory"
          ? `${prefix}${afterName}0`
          : undefined;
      while (candidates.length <= input.limit) {
        const page = this.deps.store.facts.pageManifest(containingRepository.fileManifestId, {
          ...(afterPath ? { afterPath } : {}),
          ...(atOrAfterPath ? { atOrAfterPath } : {}),
          ...(prefix ? { prefix } : {}),
          limit: 1,
        });
        const manifestEntry = page.values[0];
        if (!manifestEntry) break;
        const remainder = manifestEntry.path.slice(prefix.length);
        const slash = remainder.indexOf("/");
        const name = slash === -1 ? remainder : remainder.slice(0, slash);
        const entryPath = normalizedPath ? `${normalizedPath}/${name}` : name;
        const isDirectory = slash !== -1;
        candidates.push({
          name,
          path: entryPath,
          kind: isDirectory ? "directory" : "file",
          identity: isDirectory
            ? compactId("directory", {
                repositoryId: containingRepository.repositoryId,
                path: manifestEntry.path.slice(0, prefix.length + name.length),
              })
            : `file:${manifestEntry.fileId}`,
          repositoryId: containingRepository.repositoryId,
          repositoryRoot: false,
          fileId: isDirectory ? null : manifestEntry.fileId,
          witnessFileId: manifestEntry.fileId,
        });
        if (isDirectory) {
          afterPath = undefined;
          atOrAfterPath = `${prefix}${name}0`;
        } else {
          afterPath = manifestEntry.path;
          atOrAfterPath = undefined;
        }
      }
    } else {
      const prefix = normalizedPath ? `${normalizedPath}/` : "";
      const grouped = new Map<string, PresentRepositoryState>();
      for (const repository of repositories) {
        if (!repository.repoPath.startsWith(prefix)) continue;
        const remainder = repository.repoPath.slice(prefix.length);
        const name = remainder.split("/")[0];
        if (!name || (afterName !== undefined && compareUtf16CodeUnits(name, afterName) <= 0)) {
          continue;
        }
        if (!grouped.has(name)) grouped.set(name, repository);
      }
      candidates = [...grouped.entries()]
        .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
        .slice(0, input.limit + 1)
        .map(([name, repository]) => {
          const entryPath = normalizedPath ? `${normalizedPath}/${name}` : name;
          return {
            name,
            path: entryPath,
            kind: "directory",
            identity: compactId("directory", { path: entryPath }),
            repositoryId: repository.repositoryId,
            repositoryRoot: entryPath === repository.repoPath,
            fileId: null,
          };
        });
      if (candidates.length === 0 && normalizedPath !== "") return null;
    }

    if (
      candidates.length === 0 &&
      containingRepository &&
      normalizedPath !== containingRepository.repoPath
    ) {
      return null;
    }
    const fileWitnesses = candidates.flatMap((candidate) =>
      candidate.witnessFileId ? [candidate.witnessFileId] : []
    );
    const fileLineages = this.fileLineagesAt(state, fileWitnesses);
    const repositoryLineages = this.repositoryLineages(
      candidates
        .filter((candidate) => !candidate.witnessFileId)
        .map((candidate) => candidate.repositoryId)
    );
    const page = candidates.slice(0, input.limit);
    const entries = page.map((candidate) => {
      const fileLineage = candidate.witnessFileId
        ? fileLineages.get(candidate.witnessFileId)
        : undefined;
      const lineage = fileLineage ?? repositoryLineages.get(candidate.repositoryId);
      if (!lineage) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Visible entry ${candidate.path} has no authoring lineage`
        );
      }
      return {
        name: candidate.name,
        path: candidate.path,
        kind: candidate.kind,
        identity: candidate.identity,
        repositoryId: candidate.repositoryId,
        repositoryRoot: candidate.repositoryRoot,
        fileId: candidate.fileId,
        lineage: {
          authoredChangeId: fileLineage?.authoredChangeId ?? null,
          authoredByWorkUnitId: lineage.authoredByWorkUnitId,
          contentClass: lineage.contentClass,
          externalKeys: lineage.externalKeys,
        },
      };
    });
    const last = page.at(-1);
    return {
      state: input.state,
      path: normalizedPath,
      entries,
      nextCursor:
        candidates.length > input.limit && last
          ? semanticCursor("list-directory", cursorBasis, {
              name: last.name,
              kind: last.kind,
            })
          : null,
    };
  }

  private fileLineageAt(
    state: StateNodeRef,
    fileId: string
  ): {
    authoredChangeId: string;
    authoredByWorkUnitId: string;
    contentClass: "internal" | "external";
    externalKeys: string[];
  } {
    const lineage = this.fileLineagesAt(state, [fileId]).get(fileId);
    if (!lineage) {
      throw new SemanticVcsError("IntegrityFailure", `File ${fileId} has no authoring work unit`);
    }
    return lineage;
  }

  /** Resolve page provenance through the shared batched ancestry projection. */
  private fileLineagesAt(
    state: StateNodeRef,
    fileIds: readonly string[]
  ): Map<
    string,
    {
      authoredChangeId: string;
      authoredByWorkUnitId: string;
      contentClass: "internal" | "external";
      externalKeys: string[];
    }
  > {
    const result = new Map<
      string,
      {
        authoredChangeId: string;
        authoredByWorkUnitId: string;
        contentClass: "internal" | "external";
        externalKeys: string[];
      }
    >();
    for (const [fileId, latest] of this.latestAppliedChangesForFiles(state, fileIds)) {
      result.set(fileId, {
        authoredChangeId: latest.changeId,
        authoredByWorkUnitId: latest.workUnitId,
        contentClass: latest.contentClass,
        externalKeys: latest.externalKeys,
      });
    }
    return result;
  }

  private listFiles(input: VcsListFilesInput): Row {
    const root = this.deps.store.stateRoot(asState(input.state));
    const repository = this.presentRepository(root, input.repositoryId);
    const cursorBasis = {
      state: input.state,
      repositoryId: input.repositoryId,
      prefix: input.prefix ?? null,
    };
    const cursorPosition = parseSemanticCursor(input.cursor, "list-files", cursorBasis);
    const afterPath = cursorPosition?.["path"];
    if (afterPath !== undefined && typeof afterPath !== "string") {
      throw new SemanticVcsError("InvalidReference", "Invalid list-files cursor position");
    }
    const page = this.deps.store.facts.pageManifest(repository.fileManifestId, {
      afterPath,
      limit: input.limit,
    });
    const states = page.values
      .filter((value) => !input.prefix || value.path.startsWith(input.prefix))
      .map(({ fileId }) => this.deps.store.facts.file(root, fileId)?.state)
      .filter((state): state is PlacedFileState => state?.presence === "placed");
    const lineages = this.fileLineagesAt(
      asState(input.state),
      states.map((state) => state.fileId)
    );
    const files = states.map((state) => {
      const lineage = lineages.get(state.fileId);
      if (!lineage) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `File ${state.fileId} has no authoring work unit`
        );
      }
      return {
        fileId: state.fileId,
        path: state.path,
        contentHash: state.contentHash,
        ...lineage,
        mode: state.mode,
        contentKind: state.contentKind,
        byteLength: state.byteLength,
        coordinateExtent: state.coordinateExtent,
      };
    });
    return {
      state: input.state,
      repositoryId: input.repositoryId,
      files,
      nextCursor: page.next ? semanticCursor("list-files", cursorBasis, { path: page.next }) : null,
    };
  }

  /** Fold the authoring session and every exact content input into one durable class. */
  private contentIntegrityForMutation(
    basis: StateNodeRef,
    draft: MutationDraft,
    ingress: SemanticDispatchRequest["ingress"]["contextIntegrity"]
  ): {
    class: "internal" | "external";
    externalKeys: string[];
    latestFileChanges: Map<string, LatestAppliedFileChange>;
  } {
    const externalKeys = new Set<string>(ingress.class === "external" ? ingress.externalKeys : []);
    const workUnitIds = new Set<string>();
    const latestFileChanges = new Map<string, LatestAppliedFileChange>();
    const filesByState = new Map<string, { state: StateNodeRef; fileIds: Set<string> }>();
    const includeFile = (state: StateNodeRef, fileId: unknown): void => {
      if (typeof fileId !== "string" || fileId.length === 0) return;
      const key = stateNodeKey(state);
      let selection = filesByState.get(key);
      if (!selection) {
        selection = { state, fileIds: new Set() };
        filesByState.set(key, selection);
      }
      selection.fileIds.add(fileId);
    };
    for (const change of draft.changes) {
      includeFile(basis, change.base?.["fileId"]);
      if (change.source) includeFile(asState(change.source.state), change.source.fileId);
    }
    for (const selection of filesByState.values()) {
      for (const [fileId, source] of this.latestAppliedChangesForFiles(selection.state, [
        ...selection.fileIds,
      ])) {
        latestFileChanges.set(stateFileKey(selection.state, fileId), source);
        workUnitIds.add(source.workUnitId);
      }
    }
    for (const changeId of draft.incorporatedChangeIds) {
      const row = this.deps.sql
        .exec(`SELECT work_unit_id FROM gad_changes WHERE change_id = ?`, changeId)
        .toArray()[0] as Row | undefined;
      if (!row) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Incorporated change ${changeId} has no authoring work unit`
        );
      }
      workUnitIds.add(String(row["work_unit_id"]));
    }
    for (const workUnitId of workUnitIds) {
      const row = this.deps.sql
        .exec(
          `SELECT content_class, external_lineage_json FROM gad_work_units WHERE work_unit_id = ?`,
          workUnitId
        )
        .toArray()[0] as Row | undefined;
      if (!row) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Input work unit ${workUnitId} has no persisted content class`
        );
      }
      if (row["content_class"] === "external") {
        const keys = JSON.parse(String(row["external_lineage_json"]));
        if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Input work unit ${workUnitId} has invalid external lineage`
          );
        }
        for (const key of keys) externalKeys.add(key);
      } else if (row["content_class"] !== "internal") {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Input work unit ${workUnitId} has an unknown content class`
        );
      }
    }
    if (draft.externalSnapshot) {
      externalKeys.add(
        `repo:${draft.externalSnapshot.sourceUri}@${draft.externalSnapshot.snapshotRevision}`
      );
    }
    if (externalKeys.size > 256) {
      throw new SemanticVcsError(
        "ScopeTooLarge",
        "A semantic mutation cannot persist more than 256 external lineage keys"
      );
    }
    const sorted = [...externalKeys].sort(compareUtf16CodeUnits);
    return {
      class: sorted.length > 0 ? "external" : "internal",
      externalKeys: sorted,
      latestFileChanges,
    };
  }

  private persistWorkingMutation(
    input: { contextId: string; expectedWorkingHead: VcsStateNodeRef; commandId: string },
    draft: MutationDraft,
    commandId: string,
    contextIntegrity: SemanticDispatchRequest["ingress"]["contextIntegrity"]
  ): {
    commandId: string;
    contextId: string;
    workUnitId: string;
    applicationId: string;
    changeCount: number;
    changeIds: string[];
    incorporatedChangeCount: number;
    incorporatedChangeIds: string[];
    workingHead: StateNodeRef;
    decisionIds: string[];
  } {
    const profileStartedAt = Date.now();
    const basis = asState(input.expectedWorkingHead);
    const basisRoot = this.deps.store.stateRoot(basis);
    const createdAt = this.deps.now();
    const contentIntegrity = this.contentIntegrityForMutation(basis, draft, contextIntegrity);
    const evidence = this.workUnitEvidence(input.contextId, commandId);
    const workUnitIdValue = workUnitIdentity({
      commandId,
      kind: draft.kind,
      intentSummary: draft.intentSummary,
      ...evidence,
      externalSnapshot: draft.externalSnapshot ?? null,
      contentClass: contentIntegrity.class,
      externalKeys: contentIntegrity.externalKeys,
    });
    const setupCompletedAt = Date.now();
    const changes: ChangeRecord[] = draft.changes.map((change) => {
      const withoutIdentity = {
        ...change,
        source: change.source ?? null,
        workUnitId: workUnitIdValue,
      };
      const changeId = changeIdentity(withoutIdentity);
      return {
        ...withoutIdentity,
        changeId,
        effectDigest: compactId("change-effect", {
          kind: change.kind,
          source: change.source ?? null,
          base: change.base,
          result: change.result,
          payload: change.payload,
        }),
      };
    });
    const changesCompletedAt = Date.now();
    const changeIdAt = (ordinal: number): string => {
      const value = changes[ordinal]?.changeId;
      if (!value)
        throw new SemanticVcsError("IntegrityFailure", `Missing change ordinal ${ordinal}`);
      return value;
    };
    const changeIdFor = (ref: DraftChangeRef): string =>
      ref.kind === "existing" ? ref.changeId : changeIdAt(ref.ordinal);
    const fileTransitions: FileTransition[] = draft.fileResults.map((value) => ({
      fileId: value.fileId,
      expected: value.expected,
      result:
        value.result.presence === "placed"
          ? workspaceFileStateIdentity(value.result)
          : workspaceFileStateIdentity({
              fileId: value.result.fileId,
              presence: "deleted",
              priorFileStateId: value.result.priorFileStateId,
              tombstoneChangeId: changeIdFor(value.changeRef),
            }),
      changeId: changeIdFor(value.changeRef),
      newFile: value.newFile,
    }));
    const repoTransitions: RepositoryTransition[] = draft.repositoryResults.map((value) => ({
      repositoryId: value.repositoryId,
      expected: value.expected,
      resultPath: value.resultPath,
      changeId: value.changeRef === null ? null : changeIdFor(value.changeRef),
      tombstoneChangeId:
        value.resultPath === null && value.changeRef !== null ? changeIdFor(value.changeRef) : null,
      newRepository: value.newRepository,
    }));
    const transitionsCompletedAt = Date.now();
    const workspaceChangeSet =
      fileTransitions.length || repoTransitions.length
        ? this.planWorkspaceFacts(basisRoot, fileTransitions, repoTransitions)
        : null;
    const workspacePlanCompletedAt = Date.now();
    const workspaceFacts = workspaceChangeSet
      ? this.deps.store.facts.prepare(workspaceChangeSet)
      : null;
    const workspaceProofCompletedAt = Date.now();
    const resultRoot = workspaceFacts
      ? workspaceFacts.persistence.resultRoot.workspaceFactRootId
      : basisRoot;
    const appliedChangeSources = [...changes, ...(draft.appliedSourceChanges ?? [])];
    const predicatesByChangeId = new Map<string, StatePredicateRecord[]>();
    const predicatesFor = (changeId: string): StatePredicateRecord[] => {
      let predicates = predicatesByChangeId.get(changeId);
      if (!predicates) {
        predicates = [];
        predicatesByChangeId.set(changeId, predicates);
      }
      return predicates;
    };
    for (const file of fileTransitions) {
      predicatesFor(file.changeId).push(predicateForState(file.result));
    }
    for (const repository of repoTransitions) {
      if (repository.tombstoneChangeId) {
        predicatesFor(repository.tombstoneChangeId).push({
          kind: "repository-absent",
          repositoryId: repository.repositoryId,
        });
      }
      if (repository.changeId && typeof repository.resultPath === "string") {
        predicatesFor(repository.changeId).push({
          kind: "repository-present",
          repositoryId: repository.repositoryId,
          repoPath: repository.resultPath,
        });
      }
    }
    const appliedDrafts = appliedChangeSources.map((change, ordinal) => {
      return {
        changeId: change.changeId,
        ordinal,
        appliedBase: change.base,
        appliedResult: change.result,
        resultPredicates: predicatesByChangeId.get(change.changeId) ?? [],
      };
    });
    const applicationIdValue = applicationIdentity({
      workUnitId: workUnitIdValue,
      basis,
      resultWorkspaceFactRootId: resultRoot,
      semanticProtocol: SEMANTIC_PROTOCOL,
      changes: appliedDrafts,
    });
    const appliedChanges: AppliedChangeRecord[] = appliedDrafts.map((value) => {
      const withoutIdentity = { ...value, applicationId: applicationIdValue };
      return { ...withoutIdentity, appliedChangeId: appliedChangeIdentity(withoutIdentity) };
    });
    const application: ApplicationRecord = {
      applicationId: applicationIdValue,
      workUnitId: workUnitIdValue,
      basis,
      appliedChangeIds: appliedChanges.map((value) => value.appliedChangeId),
      resultWorkspaceFactRootId: resultRoot,
      semanticProtocol: SEMANTIC_PROTOCOL,
    };
    const applicationIdentityCompletedAt = Date.now();
    const newFileChangeIds = new Set(
      fileTransitions
        .filter((transition) => transition.newFile)
        .map((transition) => transition.changeId)
    );
    const contentParentsByState = new Map<string, { state: StateNodeRef; fileIds: Set<string> }>();
    const selectContentParent = (state: StateNodeRef, fileId: string): void => {
      const key = stateNodeKey(state);
      let selection = contentParentsByState.get(key);
      if (!selection) {
        selection = { state, fileIds: new Set() };
        contentParentsByState.set(key, selection);
      }
      selection.fileIds.add(fileId);
    };
    for (const change of appliedChangeSources) {
      const child = this.contentEndpoint(change.result) ?? this.contentEndpoint(change.base);
      if (!child) continue;
      if (change.kind === "file-copy") {
        if (change.source) {
          selectContentParent(asState(change.source.state), change.source.fileId);
        }
      } else if (!newFileChangeIds.has(change.changeId)) {
        selectContentParent(basis, child.fileId);
      }
    }
    const contentParents = new Map(contentIntegrity.latestFileChanges);
    for (const selection of contentParentsByState.values()) {
      const missingFileIds = [...selection.fileIds].filter(
        (fileId) => !contentParents.has(stateFileKey(selection.state, fileId))
      );
      for (const [fileId, parent] of this.latestAppliedChangesForFiles(
        selection.state,
        missingFileIds
      )) {
        contentParents.set(stateFileKey(selection.state, fileId), parent);
      }
    }
    const derivedContentEdges = appliedChanges.flatMap((appliedChange, ordinal) => {
      const change = appliedChangeSources[ordinal];
      if (!change) return [];
      const child = this.contentEndpoint(change.result) ?? this.contentEndpoint(change.base);
      if (!child) {
        if (change.kind === "file-copy") {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Copy change ${change.changeId} has no content endpoint`
          );
        }
        return [];
      }
      const copySource = change.kind === "file-copy" ? change.source : null;
      if (change.kind === "file-copy" && !copySource) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Copy change ${change.changeId} has no exact source coordinate`
        );
      }
      if (change.kind !== "file-copy" && newFileChangeIds.has(change.changeId)) return [];
      const parentState = copySource ? copySource.state : basis;
      const parentFileId = copySource ? copySource.fileId : child.fileId;
      const parent = contentParents.get(stateFileKey(parentState, parentFileId)) ?? null;
      if (!parent) {
        if (copySource) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Copy change ${change.changeId} reaches no applied source change`
          );
        }
        return [];
      }
      const parentEndpoint = parent.content;
      if (!parentEndpoint) {
        if (copySource) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Copy change ${change.changeId} reaches source without content coordinates`
          );
        }
        return [];
      }
      let relation: ContentEdgeRecord["relation"];
      let mappings: ContentMapping[];
      if (copySource) {
        if (
          child.contentHash !== copySource.contentHash ||
          parentEndpoint.fileId !== copySource.fileId ||
          parentEndpoint.contentHash !== copySource.contentHash ||
          parentEndpoint.coordinateKind !== child.coordinateKind ||
          parentEndpoint.coordinateExtent !== child.coordinateExtent
        ) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Copy change ${change.changeId} does not match its exact source content`
          );
        }
        relation = "copies";
        mappings = [
          mappingForWholeFile({
            childContentHash: child.contentHash,
            parentContentHash: parentEndpoint.contentHash,
            coordinateKind: child.coordinateKind,
            coordinateExtent: child.coordinateExtent,
          }),
        ];
      } else if (
        parentEndpoint.contentHash === child.contentHash &&
        parentEndpoint.coordinateKind === child.coordinateKind &&
        parentEndpoint.coordinateExtent === child.coordinateExtent
      ) {
        relation = "preserves";
        mappings = [
          mappingForWholeFile({
            childContentHash: child.contentHash,
            parentContentHash: parentEndpoint.contentHash,
            coordinateKind: child.coordinateKind,
            coordinateExtent: child.coordinateExtent,
          }),
        ];
      } else if (change.kind === "text") {
        const base = this.contentEndpoint(change.base);
        if (
          !base ||
          base.coordinateKind !== "utf16" ||
          child.coordinateKind !== "utf16" ||
          parentEndpoint.contentHash !== base.contentHash ||
          parentEndpoint.coordinateKind !== base.coordinateKind ||
          parentEndpoint.coordinateExtent !== base.coordinateExtent
        ) {
          return [];
        }
        relation = "incorporates";
        const counteractedChangeIds = this.counteractedChangeIds(change);
        mappings =
          counteractedChangeIds.length > 0
            ? this.invertedCounteractionMappings(counteractedChangeIds, child, parentEndpoint)
            : mappingsForTextEdits({
                childContentHash: child.contentHash,
                childExtent: child.coordinateExtent,
                parentContentHash: parentEndpoint.contentHash,
                parentExtent: parentEndpoint.coordinateExtent,
                edits: change.payload["edits"],
              });
      } else {
        return [];
      }
      const withoutIdentity: Omit<ContentEdgeRecord, "contentEdgeId"> = {
        childAppliedChangeId: appliedChange.appliedChangeId,
        parentAppliedChangeId: parent.appliedChangeId,
        relation,
        mappings,
      };
      return [{ ...withoutIdentity, contentEdgeId: contentEdgeIdentity(withoutIdentity) }];
    });
    const composedContentEdges = (draft.contentDerivations ?? []).map((derivation) => {
      const childChangeId = changeIdFor(derivation.childChangeRef);
      const child = appliedChanges.find((applied) => applied.changeId === childChangeId);
      if (!child) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Composed content child ${childChangeId} was not applied`
        );
      }
      const parentAppliedChangeId =
        derivation.parent.kind === "applied"
          ? derivation.parent.appliedChangeId
          : (() => {
              const parentChangeId = changeIdFor(derivation.parent.changeRef);
              const parent = appliedChanges.find((applied) => applied.changeId === parentChangeId);
              if (!parent) {
                throw new SemanticVcsError(
                  "IntegrityFailure",
                  `Composed content parent ${parentChangeId} was not applied`
                );
              }
              return parent.appliedChangeId;
            })();
      const withoutIdentity: Omit<ContentEdgeRecord, "contentEdgeId"> = {
        childAppliedChangeId: child.appliedChangeId,
        parentAppliedChangeId,
        relation: "incorporates",
        mappings: derivation.mappings,
      };
      return { ...withoutIdentity, contentEdgeId: contentEdgeIdentity(withoutIdentity) };
    });
    const contentEdges = [
      ...(draft.contentEdges ?? []),
      ...derivedContentEdges,
      ...composedContentEdges,
    ].filter(
      (edge, index, values) =>
        values.findIndex((candidate) => candidate.contentEdgeId === edge.contentEdgeId) === index
    );
    const contentEdgesCompletedAt = Date.now();
    const decisions: IntegrationDecisionRecord[] = (draft.decisions ?? []).map((decision) => {
      const complete: Omit<IntegrationDecisionRecord, "decisionId"> = {
        ...decision,
        entries: decision.entries.map(({ resultChangeRef, ...entry }) => ({
          ...entry,
          resultChangeId: resultChangeRef ? changeIdFor(resultChangeRef) : null,
        })),
        workUnitId: workUnitIdValue,
        createdAt,
      };
      return { ...complete, decisionId: decisionIdentity(complete) };
    });
    const workUnit: WorkUnitRecord = {
      workUnitId: workUnitIdValue,
      commandId,
      kind: draft.kind,
      authoredChangeIds: changes.map((value) => value.changeId),
      intentSummary: draft.intentSummary,
      ...evidence,
      externalSnapshot: draft.externalSnapshot ?? null,
      contentClass: contentIntegrity.class,
      externalKeys: contentIntegrity.externalKeys,
      normalizationProtocol: NORMALIZATION_PROTOCOL,
      createdAt,
    };
    const plan: ApplicationPersistencePlan = {
      contextId: input.contextId,
      expectedWorkingHead: basis,
      workUnit,
      changes,
      application,
      appliedChanges,
      contentEdges,
      decisions,
      workspaceFacts,
      newRepositories: repoTransitions
        .filter((value) => value.newRepository)
        .map(({ repositoryId }) => ({ repositoryId })),
      newFiles: fileTransitions
        .filter((value) => value.newFile)
        .map((value) => ({
          fileId: value.fileId,
          repositoryId: value.result.presence === "placed" ? value.result.repositoryId : "",
          changeId: value.changeId,
        })),
    };
    const applicationPersistenceStartedAt = Date.now();
    const context = this.deps.store.applyApplication(plan);
    // Derived-but-frozen intent and the search index are written in the same
    // transaction as the rows they describe, by the one loader.
    this.recordDerivedWorkUnitIndex(workUnitIdValue);
    const profileCompletedAt = Date.now();
    const totalMs = profileCompletedAt - profileStartedAt;
    if (totalMs >= 100) {
      console.info("[VcsProfile] working mutation persistence", {
        changes: changes.length,
        repositories: repoTransitions.length,
        files: fileTransitions.length,
        setupMs: setupCompletedAt - profileStartedAt,
        changeIdentitiesMs: changesCompletedAt - setupCompletedAt,
        transitionsMs: transitionsCompletedAt - changesCompletedAt,
        workspacePlanMs: workspacePlanCompletedAt - transitionsCompletedAt,
        workspaceProofMs: workspaceProofCompletedAt - workspacePlanCompletedAt,
        applicationIdentitiesMs: applicationIdentityCompletedAt - workspaceProofCompletedAt,
        contentEdgesMs: contentEdgesCompletedAt - applicationIdentityCompletedAt,
        planAssemblyMs: applicationPersistenceStartedAt - contentEdgesCompletedAt,
        prepareMs: applicationPersistenceStartedAt - profileStartedAt,
        applicationPersistenceMs: profileCompletedAt - applicationPersistenceStartedAt,
        totalMs,
      });
    }
    return {
      commandId,
      contextId: input.contextId,
      workUnitId: workUnitIdValue,
      applicationId: applicationIdValue,
      changeCount: changes.length,
      changeIds: changes.slice(0, 200).map((value) => value.changeId),
      incorporatedChangeCount: draft.incorporatedChangeIds.length,
      incorporatedChangeIds: draft.incorporatedChangeIds.slice(0, 200),
      workingHead: context.working.ref,
      decisionIds: decisions.map((value) => value.decisionId),
    };
  }

  private planWorkspaceFacts(
    basisRoot: string,
    files: readonly FileTransition[],
    repositories: readonly RepositoryTransition[]
  ): WorkspaceFactChangeSet {
    const repoById = new Map<string, RepositoryTransition>();
    for (const transition of repositories) repoById.set(transition.repositoryId, transition);
    const paths = new Map<
      string,
      Array<{ fileId: string; expectedPath: string | null; resultPath: string | null }>
    >();
    const ensureRepo = (repositoryId: string) => {
      if (!repoById.has(repositoryId)) {
        repoById.set(repositoryId, {
          repositoryId,
          expected: this.deps.store.facts.member(basisRoot, repositoryId),
          resultPath: undefined,
          changeId: null,
          tombstoneChangeId: null,
          newRepository: false,
        });
      }
    };
    for (const file of files) {
      let manifestExpected = file.expected?.presence === "placed" ? file.expected : null;
      if (
        manifestExpected === null &&
        file.expected?.presence === "deleted" &&
        file.result.presence === "placed"
      ) {
        const repositoryTransition = repoById.get(file.result.repositoryId);
        if (
          repositoryTransition?.expected?.presence === "deleted" &&
          repositoryTransition.resultPath !== null &&
          repositoryTransition.resultPath !== undefined
        ) {
          const priorFile = this.deps.store.facts.fileStateById(file.expected.priorFileStateId);
          const priorRepository = this.deps.store.facts.memberByStateId(
            repositoryTransition.expected.priorRepositoryStateId
          );
          if (
            priorFile?.presence === "placed" &&
            priorFile.repositoryId === file.result.repositoryId &&
            priorRepository?.presence === "present"
          ) {
            const entry = fileManifestEntryAt({
              manifest: this.deps.store.facts.manifest(priorRepository.fileManifestId),
              path: priorFile.path,
              readNode: (kind, route, nodeId, prefix) =>
                this.deps.store.facts.node(kind, route, nodeId, prefix),
            });
            if (entry?.fileId === file.fileId) manifestExpected = priorFile;
          }
        }
      }
      const placementUnchanged =
        manifestExpected !== null &&
        file.result.presence === "placed" &&
        manifestExpected.repositoryId === file.result.repositoryId &&
        manifestExpected.path === file.result.path;
      if (manifestExpected !== null && !placementUnchanged) {
        ensureRepo(manifestExpected.repositoryId);
        const values = paths.get(manifestExpected.repositoryId) ?? [];
        values.push({
          fileId: file.fileId,
          expectedPath: manifestExpected.path,
          resultPath:
            file.result.presence === "placed" &&
            file.result.repositoryId === manifestExpected.repositoryId
              ? file.result.path
              : null,
        });
        paths.set(manifestExpected.repositoryId, values);
      }
      if (
        file.result.presence === "placed" &&
        (manifestExpected === null || manifestExpected.repositoryId !== file.result.repositoryId)
      ) {
        ensureRepo(file.result.repositoryId);
        const values = paths.get(file.result.repositoryId) ?? [];
        values.push({ fileId: file.fileId, expectedPath: null, resultPath: file.result.path });
        paths.set(file.result.repositoryId, values);
      }
    }
    const transient = new Map<string, PersistentRadixNode>();
    const manifestUpdates: Array<WorkspaceFactChangeSet["manifestUpdates"][number]> = [];
    const repositoryUpdates: Array<WorkspaceFactChangeSet["repositoryUpdates"][number]> = [];
    for (const transition of [...repoById.values()].sort((a, b) =>
      compareUtf16CodeUnits(a.repositoryId, b.repositoryId)
    )) {
      const expected = transition.expected;
      const currentPath = expected?.presence === "present" ? expected.repoPath : null;
      const desiredPath = transition.resultPath === undefined ? currentPath : transition.resultPath;
      const pathUpdates = paths.get(transition.repositoryId) ?? [];
      const priorPresent =
        expected?.presence === "deleted"
          ? this.deps.store.facts.memberByStateId(expected.priorRepositoryStateId)
          : null;
      if (priorPresent && priorPresent.presence !== "present") {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Repository tombstone ${expected!.repositoryStateId} has no prior manifest`
        );
      }
      let fileManifestId =
        expected?.presence === "present"
          ? expected.fileManifestId
          : priorPresent?.presence === "present"
            ? priorPresent.fileManifestId
            : null;
      if (desiredPath !== null && (pathUpdates.length > 0 || fileManifestId === null)) {
        const empty = fileManifestId ? null : emptyFileManifest(transition.repositoryId);
        if (empty) transient.set(empty.node.nodeId, empty.node);
        const basis = fileManifestId
          ? this.deps.store.facts.manifest(fileManifestId)
          : empty!.manifest;
        const proof =
          pathUpdates.length === 0
            ? null
            : composeFileManifest({
                basis,
                updates: pathUpdates,
                readNode: (kind, route, nodeId, prefix) =>
                  transient.get(nodeId) ?? this.deps.store.facts.node(kind, route, nodeId, prefix),
              });
        proof?.createdNodes.forEach((node) => transient.set(node.nodeId, node));
        const resultManifest = proof?.resultManifest ?? basis;
        fileManifestId = resultManifest.fileManifestId;
        manifestUpdates.push({
          repositoryId: transition.repositoryId,
          expectedFileManifestId: expected?.presence === "present" ? expected.fileManifestId : null,
          resultManifest,
          pathUpdates: proof?.updates ?? [],
        });
      }
      const result = desiredPath
        ? workspaceRepositoryStateIdentity({
            repositoryId: transition.repositoryId,
            presence: "present",
            repoPath: desiredPath,
            fileManifestId: fileManifestId!,
          })
        : workspaceRepositoryStateIdentity({
            repositoryId: transition.repositoryId,
            presence: "deleted",
            priorRepositoryStateId: expected!.repositoryStateId,
            tombstoneChangeId: transition.tombstoneChangeId!,
          });
      repositoryUpdates.push({ repositoryId: transition.repositoryId, expected, result });
    }
    const planned = planWorkspaceFactChangeSet({
      basisWorkspaceFactRootId: basisRoot,
      repositoryUpdates,
      manifestUpdates,
      fileUpdates: files.map((file) => ({
        fileId: file.fileId,
        expected: file.expected,
        result: file.result,
      })),
    });
    if (planned.kind === "refused") {
      throw new SemanticVcsError("IntegrityFailure", planned.failure.message, {
        handles: planned.failure.handles,
      });
    }
    return planned.changeSet;
  }

  private queueRealization(
    contextId: string,
    commandId: string,
    previousState: StateNodeRef | null,
    targetState: StateNodeRef,
    blobs: readonly { contentHash: string; base64: string }[],
    draft?: MutationDraft,
    affectedRepositoryIds?: readonly string[]
  ): SemanticEffect | null {
    if (!this.deps.store.contextProjectionRequired(contextId)) {
      if (blobs.length === 0) return null;
      return this.deps.store.queueEffect({
        scopeKind: "context",
        scopeId: contextId,
        commandId,
        kind: "materialize-context",
        payload: {
          version: 1,
          mode: "content-only",
          contextId,
          targetState,
          blobs: [...blobs],
        },
      });
    }
    const command = this.buildMaterializationCommand(
      contextId,
      commandId,
      previousState === null ? "initialize" : "patch",
      previousState,
      targetState,
      blobs,
      draft,
      affectedRepositoryIds
    );
    return this.deps.store.queueEffect({
      scopeKind: "context",
      scopeId: contextId,
      commandId,
      kind: "materialize-context",
      effectId: command.materializationId,
      payloadDigest: command.payloadDigest,
      payload: command as unknown as Row,
    });
  }

  private buildMaterializationCommand(
    contextId: string,
    commandId: string,
    mode: ContextMaterializationCommand["mode"],
    previousState: StateNodeRef | null,
    targetState: StateNodeRef,
    blobs: readonly { contentHash: string; base64: string }[],
    draft?: MutationDraft,
    affectedRepositoryIds?: readonly string[]
  ): ContextMaterializationCommand {
    const root = this.deps.store.stateRoot(targetState);
    const previousRoot = previousState ? this.deps.store.stateRoot(previousState) : null;
    const repositories = this.contextMaterializationRepositories(
      root,
      previousRoot,
      draft,
      affectedRepositoryIds,
      mode !== "patch"
    );
    return contextMaterializationCommand({
      contextId,
      commandId,
      mode,
      previousState,
      targetState,
      repositories,
      blobs,
    });
  }

  private contextMaterializationRepositories(
    root: string,
    previousRoot: string | null,
    draft?: MutationDraft,
    explicitlyAffected?: readonly string[],
    fullReplacement = previousRoot === null
  ): WorkspaceMaterializationRepository[] {
    const repositoryIds = fullReplacement
      ? this.deps.store.facts.entries(root, "repository").map(({ key }) => key)
      : explicitlyAffected
        ? [...new Set(explicitlyAffected)]
        : draft
          ? this.materializationDraftRepositoryIds(draft)
          : [];
    if (fullReplacement) {
      const present = repositoryIds
        .sort(compareUtf16CodeUnits)
        .map((repositoryId) => this.deps.store.facts.member(root, repositoryId))
        .filter(
          (
            repository
          ): repository is Extract<WorkspaceRepositoryMember, { presence: "present" }> =>
            repository?.presence === "present"
        );
      const contentRoots = new Map(
        present.flatMap((repository) => {
          const contentRoot = this.deps.store.materializedRepositoryContentRoot(
            root,
            repository.repositoryId
          );
          return contentRoot ? [[repository.repositoryId, contentRoot] as const] : [];
        })
      );
      const snapshots = this.deps.store.facts.materializationSnapshotsAt(
        root,
        present.filter((repository) => !contentRoots.has(repository.repositoryId))
      );
      return present.map((repository) => {
        const contentRoot = contentRoots.get(repository.repositoryId);
        return {
          repositoryId: repository.repositoryId,
          presence: "present" as const,
          repoPath: repository.repoPath,
          fileManifestId: repository.fileManifestId,
          source: contentRoot
            ? ({ kind: "content-root", contentRoot } as const)
            : ({
                kind: "snapshot",
                files: snapshots.get(repository.repositoryId) ?? [],
              } as const),
        };
      });
    }
    return repositoryIds
      .sort(compareUtf16CodeUnits)
      .flatMap((key): WorkspaceMaterializationRepository[] => {
        const member = this.deps.store.facts.member(root, key);
        const previous = previousRoot ? this.deps.store.facts.member(previousRoot, key) : null;
        if (!member) {
          if (previousRoot !== null && previous?.presence === "present") {
            return [
              {
                repositoryId: key,
                presence: "deleted",
                repoPath: previous.repoPath,
              },
            ];
          }
          if (previousRoot !== null && previous?.presence === "deleted") return [];
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Materialization repository ${key} is absent from target facts`
          );
        }
        if (member.presence === "present") {
          const exactRoot = this.deps.store.materializedRepositoryContentRoot(root, key);
          if (exactRoot) {
            return [
              {
                repositoryId: key,
                presence: "present",
                repoPath: member.repoPath,
                fileManifestId: member.fileManifestId,
                source: { kind: "content-root", contentRoot: exactRoot },
              },
            ];
          }
          if (previous?.presence === "present" && previousRoot !== null && draft) {
            const basisRoot = this.deps.store.materializedRepositoryContentRoot(previousRoot, key);
            if (basisRoot) {
              const changes = this.materializationChanges(draft, key);
              return [
                {
                  repositoryId: key,
                  presence: "present",
                  repoPath: member.repoPath,
                  fileManifestId: member.fileManifestId,
                  source:
                    changes.length === 0
                      ? { kind: "content-root", contentRoot: basisRoot }
                      : { kind: "delta", basisContentRoot: basisRoot, changes },
                },
              ];
            }
          }
          return [
            {
              repositoryId: key,
              presence: "present",
              repoPath: member.repoPath,
              fileManifestId: member.fileManifestId,
              source: {
                kind: "snapshot",
                files: this.materializationSnapshotAt(root, member),
              },
            },
          ];
        }
        if (previousRoot === null) return [];
        return [
          {
            repositoryId: key,
            presence: "deleted",
            repoPath: this.lastRepositoryPath(member.priorRepositoryStateId),
          },
        ];
      });
  }

  private materializationDraftRepositoryIds(draft: MutationDraft): string[] {
    const repositoryIds = new Set(draft.repositoryResults.map(({ repositoryId }) => repositoryId));
    for (const file of draft.fileResults) {
      if (file.expected?.presence === "placed") repositoryIds.add(file.expected.repositoryId);
      if (file.result.presence === "placed") repositoryIds.add(file.result.repositoryId);
    }
    return [...repositoryIds];
  }

  private publicationRepositories(root: string): WorkspaceMaterializationRepository[] {
    return this.contextMaterializationRepositories(root, null);
  }

  private materializationChanges(
    draft: MutationDraft,
    repositoryId: string
  ): WorkspaceMaterializationChange[] {
    const changes = new Map<string, WorkspaceMaterializationChange>();
    for (const file of draft.fileResults) {
      if (file.expected?.presence === "placed" && file.expected.repositoryId === repositoryId) {
        const existing = changes.get(file.expected.path);
        changes.set(file.expected.path, {
          path: file.expected.path,
          expected: existing?.expected ?? {
            contentHash: file.expected.contentHash,
            mode: file.expected.mode,
          },
          result: existing?.result ?? null,
        });
      }
      if (file.result.presence === "placed" && file.result.repositoryId === repositoryId) {
        const existing = changes.get(file.result.path);
        changes.set(file.result.path, {
          path: file.result.path,
          expected: existing?.expected ?? null,
          result: {
            contentHash: file.result.contentHash,
            mode: file.result.mode,
          },
        });
      }
    }
    return [...changes.values()]
      .filter((change) => canonicalJson(change.expected) !== canonicalJson(change.result))
      .sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
  }

  /** Exact, paged repository snapshot used only when no sparse host receipt is
   * available for a reusable target or delta basis. This keeps ordinary edits
   * incremental without multiplying receipt rows by every unaffected repo. */
  private materializationSnapshotAt(
    root: string,
    repository: PresentRepositoryState
  ): Array<{ path: string; contentHash: string; mode: number }> {
    const entries: Array<{ path: string; fileId: string }> = [];
    let afterPath: string | undefined;
    do {
      const page = this.deps.store.facts.pageManifest(repository.fileManifestId, {
        ...(afterPath ? { afterPath } : {}),
        limit: 500,
      });
      entries.push(...page.values);
      afterPath = page.next ?? undefined;
    } while (afterPath !== undefined);
    const states = this.deps.store.facts.fileStatesAt(
      root,
      entries.map(({ fileId }) => fileId)
    );
    return entries.map(({ fileId, path }) => {
      const state = states.get(fileId);
      if (
        !state ||
        state.presence !== "placed" ||
        state.repositoryId !== repository.repositoryId ||
        state.path !== path
      ) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Manifest ${repository.fileManifestId} has no exact file state for ${fileId}`
        );
      }
      return { path, contentHash: state.contentHash, mode: state.mode };
    });
  }

  private lastRepositoryPath(repositoryStateId: string): string {
    const row = this.deps.sql
      .exec(
        `WITH RECURSIVE history(repository_state_id, presence, repo_path,
                                prior_repository_state_id, depth) AS (
           SELECT repository_state_id, presence, repo_path,
                  prior_repository_state_id, 0
             FROM vcs_repository_states WHERE repository_state_id = ?
           UNION ALL
           SELECT prior.repository_state_id, prior.presence, prior.repo_path,
                  prior.prior_repository_state_id, history.depth + 1
             FROM history
             JOIN vcs_repository_states prior
               ON prior.repository_state_id = history.prior_repository_state_id
            WHERE history.depth < ?
         )
         SELECT repo_path FROM history
          WHERE presence = 'present' ORDER BY depth LIMIT 1`,
        repositoryStateId,
        MAX_WORKING_APPLICATIONS
      )
      .toArray()[0] as Row | undefined;
    if (!row || typeof row["repo_path"] !== "string") {
      throw new SemanticVcsError(
        "IntegrityFailure",
        `Deleted repository state ${repositoryStateId} has no prior path`
      );
    }
    return row["repo_path"];
  }

  private presentRepository(root: string, repositoryId: string) {
    const repository = this.deps.store.facts.member(root, repositoryId);
    if (!repository || repository.presence !== "present") {
      throw new SemanticVcsError("InvalidReference", `Unknown repository ${repositoryId}`);
    }
    return repository;
  }

  private placedFile(root: string, repositoryId: string, fileId: string) {
    const point = this.deps.store.facts.file(root, fileId);
    if (
      !point ||
      point.state.presence !== "placed" ||
      point.state.repositoryId !== repositoryId ||
      point.repository.presence !== "present"
    ) {
      throw new SemanticVcsError("InvalidReference", `Unknown file ${fileId}`);
    }
    return { state: point.state, repository: point.repository };
  }

  private changeRequired(changeId: string): ChangeRecord {
    const row = this.deps.sql
      .exec(`SELECT * FROM gad_changes WHERE change_id = ?`, changeId)
      .toArray()[0] as Row | undefined;
    if (!row) throw new SemanticVcsError("InvalidReference", `Unknown change ${changeId}`);
    return {
      changeId,
      workUnitId: String(row["work_unit_id"]),
      operation: Number(row["operation"]),
      ordinal: Number(row["ordinal"]),
      kind: String(row["kind"]),
      source:
        row["source_json"] == null
          ? null
          : (JSON.parse(String(row["source_json"])) as AuthoredCopySourceEndpoint),
      base: row["base_json"] == null ? null : JSON.parse(String(row["base_json"])),
      result: row["result_json"] == null ? null : JSON.parse(String(row["result_json"])),
      payload: JSON.parse(String(row["payload_json"])),
      effectDigest: String(row["effect_digest"]),
    };
  }

  private publicChange(change: ChangeRecord): Row {
    const counteracts = change.payload["counteractsChangeIds"];
    return {
      changeId: change.changeId,
      authoredByWorkUnitId: change.workUnitId,
      operation: change.operation,
      kind: publicChangeKind(change.kind),
      effects: changeEffects(change),
      counteractsChangeIds: Array.isArray(counteracts)
        ? counteracts.filter((value): value is string => typeof value === "string")
        : [],
      effectDigest: change.effectDigest,
      normalizationProtocol: NORMALIZATION_PROTOCOL,
    };
  }

  private publicDecision(row: Row): Row {
    const decisionId = String(row["decision_id"]);
    const entries = (
      this.deps.sql
        .exec(
          `SELECT coordinate_kind, coordinate_id, resolution, result_change_id, rationale
           FROM gad_merge_decision_entries WHERE decision_id = ?
          ORDER BY coordinate_kind, coordinate_id`,
          decisionId
        )
        .toArray() as Row[]
    ).map((entry) => ({
      coordinate: { kind: String(entry["coordinate_kind"]), id: String(entry["coordinate_id"]) },
      resolution: String(entry["resolution"]),
      accountedSourceChangeIds: (
        this.deps.sql
          .exec(
            `SELECT change_id FROM gad_decision_source_changes
              WHERE decision_id = ? AND coordinate_kind = ? AND coordinate_id = ?
              ORDER BY change_id`,
            decisionId,
            entry["coordinate_kind"],
            entry["coordinate_id"]
          )
          .toArray() as Row[]
      ).map((change) => String(change["change_id"])),
      ...(entry["result_change_id"] == null
        ? {}
        : { resultChangeId: String(entry["result_change_id"]) }),
      ...(entry["rationale"] == null ? {} : { rationale: String(entry["rationale"]) }),
    }));
    return {
      decisionId,
      intent: this.intentForWorkUnit(String(row["work_unit_id"])),
      sourceIntents: [
        ...new Set(
          entries.flatMap((entry) =>
            entry.accountedSourceChangeIds.map(
              (changeId) => this.changeRequired(changeId).workUnitId
            )
          )
        ),
      ]
        .slice(0, 500)
        .map((workUnitId) => ({ workUnitId, intent: this.intentForWorkUnit(workUnitId) })),
      sourceState:
        row["source_delta_id"] == null
          ? { kind: "event", eventId: String(row["source_event_id"]) }
          : { kind: "external-delta", deltaId: String(row["source_delta_id"]) },
      targetBasis:
        row["target_state_kind"] === "event"
          ? { kind: "event", eventId: String(row["target_state_id"]) }
          : { kind: "application", applicationId: String(row["target_state_id"]) },
      entries,
    };
  }

  private sameValue(left: unknown, right: unknown): boolean {
    return canonicalJson(left) === canonicalJson(right);
  }

  private sameAspectValue(aspect: MergeAspectName, left: unknown, right: unknown): boolean {
    if (
      aspect === "presence" &&
      (left === "absent" || left === "deleted") &&
      (right === "absent" || right === "deleted")
    ) {
      return true;
    }
    return this.sameValue(left, right);
  }

  private sameCoordinateEndpoint(
    coordinate: MergeCoordinate,
    left: Row | null,
    right: Row
  ): boolean {
    if (!left) return false;
    const aspects: MergeAspectName[] =
      coordinate.kind === "file"
        ? ["presence", "content", "placement", "mode"]
        : ["presence", "path"];
    return aspects.every((aspect) =>
      this.sameAspectValue(aspect, this.aspectValue(left, aspect), this.aspectValue(right, aspect))
    );
  }

  private eventAncestorGraph(eventId: string): Map<string, string[]> {
    const rows = this.deps.sql
      .exec(
        `WITH RECURSIVE ancestry(event_id) AS (
           SELECT ?
           UNION
           SELECT parent.parent_event_id
             FROM ancestry
             JOIN gad_workspace_event_parents parent ON parent.event_id = ancestry.event_id
            LIMIT ?
         )
         SELECT event.event_id, parent.parent_event_id
           FROM ancestry
           JOIN gad_workspace_events event ON event.event_id = ancestry.event_id
           LEFT JOIN gad_workspace_event_parents parent ON parent.event_id = event.event_id
          ORDER BY event.event_id, parent.ordinal
          LIMIT ?`,
        eventId,
        MAX_ANCESTRY_EDGES + 1,
        MAX_ANCESTRY_EDGES + 1
      )
      .toArray() as Row[];
    if (rows.length >= MAX_ANCESTRY_EDGES + 1) {
      throw new SemanticVcsError("ScopeTooLarge", "Merge ancestry exceeds its row bound", {
        maximum: MAX_ANCESTRY_EDGES,
      });
    }
    const graph = new Map<string, string[]>();
    for (const row of rows) {
      const current = String(row["event_id"]);
      const parents = graph.get(current) ?? [];
      if (row["parent_event_id"] != null) parents.push(String(row["parent_event_id"]));
      graph.set(current, parents);
    }
    if (!graph.has(eventId)) {
      throw new SemanticVcsError("IntegrityFailure", `Missing event ${eventId}`);
    }
    for (const parents of graph.values()) {
      for (const parentEventId of parents) {
        if (!graph.has(parentEventId)) {
          throw new SemanticVcsError("IntegrityFailure", `Missing event ${parentEventId}`);
        }
      }
    }
    return graph;
  }

  private eventAncestors(eventId: string): Set<string> {
    return new Set(this.eventAncestorGraph(eventId).keys());
  }

  private stateEvent(state: StateNodeRef): string {
    const events = this.firstParentLineage(state).eventIds;
    const eventId = events.at(-1);
    if (!eventId) throw new SemanticVcsError("IntegrityFailure", "State has no committed basis");
    return eventId;
  }

  private maximalMergeBases(target: StateNodeRef, sourceEventId: string): string[] {
    const targetAncestors = this.eventAncestorGraph(this.stateEvent(target));
    const sourceAncestors = this.eventAncestorGraph(sourceEventId);
    const common = [...sourceAncestors.keys()].filter((eventId) => targetAncestors.has(eventId));
    const commonSet = new Set(common);
    const nonmaximal = new Set<string>();
    let traversedEdges = 0;
    for (const eventId of common) {
      const parentEventIds = sourceAncestors.get(eventId)!;
      traversedEdges += parentEventIds.length;
      if (traversedEdges > MAX_ANCESTRY_EDGES) {
        throw new SemanticVcsError("ScopeTooLarge", "Merge-base analysis exceeds its edge bound", {
          maximum: MAX_ANCESTRY_EDGES,
        });
      }
      for (const parentEventId of parentEventIds) {
        if (commonSet.has(parentEventId)) nonmaximal.add(parentEventId);
      }
    }
    const maximal = common.filter((candidate) => !nonmaximal.has(candidate));
    if (maximal.length === 0) {
      throw new SemanticVcsError("IntegrityFailure", "Merge histories have no common ancestor");
    }
    const generation = new Map<string, number>();
    const visit = (rootEventId: string): number => {
      const stack: Array<{ eventId: string; expanded: boolean }> = [
        { eventId: rootEventId, expanded: false },
      ];
      const visiting = new Set<string>();
      let generationEdges = 0;
      while (stack.length > 0) {
        const frame = stack.pop()!;
        if (generation.has(frame.eventId)) continue;
        const parentEventIds = sourceAncestors.get(frame.eventId);
        if (!parentEventIds) {
          throw new SemanticVcsError("IntegrityFailure", `Missing event ${frame.eventId}`);
        }
        if (frame.expanded) {
          let parentGeneration = -1;
          for (const parentEventId of parentEventIds) {
            const value = generation.get(parentEventId);
            if (value === undefined) {
              throw new SemanticVcsError(
                "IntegrityFailure",
                `Event generation is incomplete at ${frame.eventId}`
              );
            }
            parentGeneration = Math.max(parentGeneration, value);
          }
          generation.set(frame.eventId, parentGeneration >= 0 ? parentGeneration + 1 : 0);
          visiting.delete(frame.eventId);
          continue;
        }
        if (visiting.has(frame.eventId)) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Workspace event ancestry contains a cycle at ${frame.eventId}`
          );
        }
        visiting.add(frame.eventId);
        generationEdges += parentEventIds.length;
        if (generationEdges > MAX_ANCESTRY_EDGES) {
          throw new SemanticVcsError(
            "ScopeTooLarge",
            "Merge-base generation analysis exceeds its edge bound",
            { maximum: MAX_ANCESTRY_EDGES }
          );
        }
        stack.push({ eventId: frame.eventId, expanded: true });
        for (let index = parentEventIds.length - 1; index >= 0; index -= 1) {
          const parentEventId = parentEventIds[index]!;
          if (!generation.has(parentEventId)) {
            stack.push({ eventId: parentEventId, expanded: false });
          }
        }
      }
      return generation.get(rootEventId)!;
    };
    return maximal.sort(
      (left, right) => visit(right) - visit(left) || compareUtf16CodeUnits(left, right)
    );
  }

  private coordinateEndpoint(root: string, coordinate: MergeCoordinate): Row {
    if (coordinate.kind === "repository") {
      const member = this.deps.store.facts.member(root, coordinate.id);
      return !member
        ? { kind: "repository", repositoryId: coordinate.id, presence: "absent" }
        : member.presence === "present"
          ? {
              kind: "repository",
              repositoryId: coordinate.id,
              presence: "present",
              repoPath: member.repoPath,
            }
          : { kind: "repository", repositoryId: coordinate.id, presence: "deleted" };
    }
    const point = this.deps.store.facts.file(root, coordinate.id);
    if (!point) return { kind: "missing", fileId: coordinate.id, presence: "absent" };
    if (point.state.presence === "deleted") {
      return { kind: "missing", fileId: coordinate.id, presence: "deleted" };
    }
    return point.repository.presence === "present"
      ? endpointForFile(point.state, point.repository)
      : {
          kind: "file",
          fileId: point.state.fileId,
          repositoryId: point.state.repositoryId,
          repoPath: "",
          path: point.state.path,
          contentHash: point.state.contentHash,
          mode: point.state.mode,
          contentKind: point.state.contentKind,
          byteLength: point.state.byteLength,
          coordinateExtent: point.state.coordinateExtent,
        };
  }

  private coordinateEndpoints(
    root: string,
    coordinates: readonly MergeCoordinate[]
  ): Map<string, Row> {
    const fileIds = coordinates.flatMap((coordinate) =>
      coordinate.kind === "file" ? [coordinate.id] : []
    );
    const fileStates = this.deps.store.facts.fileStatesAt(root, fileIds);
    const repositoryIds = new Set(
      coordinates.flatMap((coordinate) => (coordinate.kind === "repository" ? [coordinate.id] : []))
    );
    for (const state of fileStates.values()) {
      if (state.presence === "placed") repositoryIds.add(state.repositoryId);
    }
    const repositories = new Map(
      [...repositoryIds].map((repositoryId) => [
        repositoryId,
        this.deps.store.facts.member(root, repositoryId),
      ])
    );
    return new Map(
      coordinates.map((coordinate) => {
        const key = `${coordinate.kind}:${coordinate.id}`;
        if (coordinate.kind === "repository") {
          const member = repositories.get(coordinate.id) ?? null;
          return [
            key,
            !member
              ? { kind: "repository", repositoryId: coordinate.id, presence: "absent" }
              : member.presence === "present"
                ? {
                    kind: "repository",
                    repositoryId: coordinate.id,
                    presence: "present",
                    repoPath: member.repoPath,
                  }
                : { kind: "repository", repositoryId: coordinate.id, presence: "deleted" },
          ];
        }
        const state = fileStates.get(coordinate.id);
        if (!state) {
          return [key, { kind: "missing", fileId: coordinate.id, presence: "absent" }];
        }
        // Tombstones additionally authenticate their prior placed state in the
        // point reader. They are uncommon in broad comparisons and retain that
        // full validation instead of weakening the batch path.
        if (state.presence === "deleted") return [key, this.coordinateEndpoint(root, coordinate)];
        const repository = repositories.get(state.repositoryId);
        if (!repository) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Workspace file ${coordinate.id} references missing repository ${state.repositoryId}`
          );
        }
        return [
          key,
          repository.presence === "present"
            ? endpointForFile(state, repository)
            : {
                kind: "file",
                fileId: state.fileId,
                repositoryId: state.repositoryId,
                repoPath: "",
                path: state.path,
                contentHash: state.contentHash,
                mode: state.mode,
                contentKind: state.contentKind,
                byteLength: state.byteLength,
                coordinateExtent: state.coordinateExtent,
              },
        ];
      })
    );
  }

  private aspectValue(endpoint: Row, aspect: MergeAspectName): unknown {
    const kind = endpoint["kind"];
    if (aspect === "presence") {
      if (kind === "file") return "present";
      if (kind === "missing") return endpoint["presence"] === "absent" ? "absent" : "deleted";
      return endpoint["presence"] ?? (endpoint["repoPath"] == null ? "deleted" : "present");
    }
    const present = kind === "file" || (kind === "repository" && endpoint["repoPath"] != null);
    if (!present) return null;
    if (aspect === "content") {
      return kind === "file"
        ? {
            hash: endpoint["contentHash"],
            kind: endpoint["contentKind"],
            byteLength: endpoint["byteLength"],
            coordinateExtent: endpoint["coordinateExtent"],
          }
        : null;
    }
    if (aspect === "placement") {
      return kind === "file"
        ? { repositoryId: endpoint["repositoryId"], path: endpoint["path"] }
        : null;
    }
    if (aspect === "mode") return kind === "file" ? endpoint["mode"] : null;
    return kind === "repository" ? endpoint["repoPath"] : null;
  }

  private coordinatePath(endpoint: Row): string | undefined {
    if (endpoint["kind"] === "repository" && typeof endpoint["repoPath"] === "string") {
      return endpoint["repoPath"];
    }
    if (
      endpoint["kind"] === "file" &&
      typeof endpoint["repoPath"] === "string" &&
      typeof endpoint["path"] === "string"
    ) {
      return `${endpoint["repoPath"]}/${endpoint["path"]}`;
    }
    return undefined;
  }

  private mergeChangeCoordinate(change: ChangeRecord): MergeCoordinate | null {
    const endpoint = change.result ?? change.base;
    if (!endpoint) return null;
    if (endpoint["kind"] === "repository" && typeof endpoint["repositoryId"] === "string") {
      return { kind: "repository", id: endpoint["repositoryId"] };
    }
    if (
      (endpoint["kind"] === "file" || endpoint["kind"] === "missing") &&
      typeof endpoint["fileId"] === "string"
    ) {
      return { kind: "file", id: endpoint["fileId"] };
    }
    return null;
  }

  private changesByMergeCoordinate(changes: readonly ChangeRecord[]): Map<string, ChangeRecord[]> {
    const result = new Map<string, ChangeRecord[]>();
    for (const change of changes) {
      const coordinate = this.mergeChangeCoordinate(change);
      if (!coordinate) continue;
      const key = `${coordinate.kind}:${coordinate.id}`;
      const values = result.get(key) ?? [];
      values.push(change);
      result.set(key, values);
    }
    return result;
  }

  private coordinateAttribution(
    changes: readonly ChangeRecord[],
    coordinate: MergeCoordinate,
    base: Row,
    final: Row
  ): MergeAttributionEntry[] {
    const touching = changes.filter((change) => {
      const value = this.mergeChangeCoordinate(change);
      return value?.kind === coordinate.kind && value.id === coordinate.id;
    });
    const aspects: MergeAspectName[] =
      coordinate.kind === "file"
        ? ["presence", "content", "placement", "mode"]
        : ["presence", "path"];
    let first = touching.length;
    for (const aspect of aspects) {
      if (
        this.sameAspectValue(
          aspect,
          this.aspectValue(base, aspect),
          this.aspectValue(final, aspect)
        )
      )
        continue;
      let current = this.aspectValue(base, aspect);
      let start = -1;
      for (let index = 0; index < touching.length; index += 1) {
        const change = touching[index]!;
        const before = this.aspectValue(change.base ?? {}, aspect);
        const after = this.aspectValue(change.result ?? {}, aspect);
        if (this.sameAspectValue(aspect, before, after)) continue;
        if (start < 0) {
          const equivalentMissingPresence =
            aspect === "presence" &&
            (before === "absent" || before === "deleted") &&
            (current === "absent" || current === "deleted");
          if (!this.sameAspectValue(aspect, before, current) && !equivalentMissingPresence) {
            if (!this.isDecisionAccountedIntroduction(change, coordinate, aspect, current)) {
              continue;
            }
          }
          start = index;
        } else if (!this.sameAspectValue(aspect, before, current)) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Provenance discontinuity at ${coordinate.kind} ${coordinate.id}/${aspect}`,
            { coordinates: [coordinate] }
          );
        }
        current = after;
      }
      if (start < 0 || !this.sameAspectValue(aspect, current, this.aspectValue(final, aspect))) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `State difference is not covered at ${coordinate.kind} ${coordinate.id}/${aspect}`,
          { coordinates: [coordinate] }
        );
      }
      first = Math.min(first, start);
    }
    const attributed = this.expandMergeAttribution(touching.slice(first));
    const attributedActive = this.attributionActiveChangeIds(attributed);
    return attributed.map((change) => ({
      changeId: change.changeId,
      workUnitId: change.workUnitId,
      ...(!attributedActive.has(change.changeId) ? { undone: true as const } : {}),
    }));
  }

  private isDecisionAccountedIntroduction(
    change: ChangeRecord,
    coordinate: MergeCoordinate,
    aspect: MergeAspectName,
    expectedSourceValue: unknown
  ): boolean {
    const rows = this.deps.sql
      .exec(
        `SELECT source.change_id
           FROM gad_merge_decision_entries entry
           JOIN gad_decision_source_changes source
             ON source.decision_id = entry.decision_id
            AND source.coordinate_kind = entry.coordinate_kind
            AND source.coordinate_id = entry.coordinate_id
          WHERE entry.result_change_id = ?
            AND entry.coordinate_kind = ?
            AND entry.coordinate_id = ?
          ORDER BY source.change_id
          LIMIT 10001`,
        change.changeId,
        coordinate.kind,
        coordinate.id
      )
      .toArray() as Row[];
    if (rows.length > 10_000) {
      throw new SemanticVcsError(
        "ScopeTooLarge",
        `Merge decision attribution for ${coordinate.kind} ${coordinate.id} exceeds its bound`,
        { maximum: 10_000 }
      );
    }
    return rows.some((row) => {
      const source = this.changeRequired(String(row["change_id"]));
      const value = this.aspectValue(source.result ?? {}, aspect);
      if (this.sameAspectValue(aspect, value, expectedSourceValue)) return true;
      return (
        aspect === "presence" &&
        (value === "absent" || value === "deleted") &&
        (expectedSourceValue === "absent" || expectedSourceValue === "deleted")
      );
    });
  }

  private expandMergeAttribution(changes: readonly ChangeRecord[]): ChangeRecord[] {
    const result: ChangeRecord[] = [];
    const emitted = new Set<string>();
    const visiting = new Set<string>();
    const visit = (change: ChangeRecord): void => {
      if (emitted.has(change.changeId)) return;
      if (visiting.has(change.changeId)) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Merge attribution contains a cycle at ${change.changeId}`
        );
      }
      visiting.add(change.changeId);
      const contributors = change.payload["mergesChangeIds"];
      if (Array.isArray(contributors)) {
        for (const contributorId of contributors) {
          if (typeof contributorId !== "string") {
            throw new SemanticVcsError(
              "IntegrityFailure",
              `Merge attribution ${change.changeId} contains an invalid contributor`
            );
          }
          visit(this.changeRequired(contributorId));
        }
      }
      visiting.delete(change.changeId);
      emitted.add(change.changeId);
      result.push(change);
      if (result.length > 10_000) {
        throw new SemanticVcsError("ScopeTooLarge", "Merge attribution exceeds its change bound", {
          maximum: 10_000,
        });
      }
    };
    for (const change of changes) visit(change);
    return result;
  }

  private sourceChangesForDelta(delta: ExternalDeltaRecord): ChangeRecord[] {
    return (
      this.deps.sql
        .exec(
          `SELECT change_id FROM gad_changes WHERE work_unit_id = ? ORDER BY operation, ordinal`,
          delta.workUnitId
        )
        .toArray() as Row[]
    ).map((row) => this.changeRequired(String(row["change_id"])));
  }

  private externalDeltaState(delta: ExternalDeltaRecord): StateNodeRef {
    const row = this.deps.sql
      .exec(
        `SELECT application_id FROM gad_work_unit_applications
          WHERE work_unit_id = ? ORDER BY application_id LIMIT 1`,
        delta.workUnitId
      )
      .toArray()[0] as Row | undefined;
    if (!row) {
      throw new SemanticVcsError(
        "IntegrityFailure",
        `External delta ${delta.deltaId} has no candidate application`
      );
    }
    return { kind: "application", applicationId: String(row["application_id"]) };
  }

  private reachableCoordinateDecisions(
    applicationIds: readonly string[],
    source: VcsMergeInput["source"]
  ): Map<string, string> {
    if (!applicationIds.length) return new Map();
    const rows = this.deps.sql
      .exec(
        `SELECT entry.coordinate_kind, entry.coordinate_id, decision.decision_id
           FROM gad_integration_decisions decision
           JOIN gad_merge_decision_entries entry ON entry.decision_id = decision.decision_id
          WHERE decision.work_unit_id IN (
            SELECT application.work_unit_id FROM gad_work_unit_applications application
            JOIN json_each(?) selected ON application.application_id = CAST(selected.value AS TEXT)
          ) AND ${source.kind === "event" ? "decision.source_event_id" : "decision.source_delta_id"} = ?
          ORDER BY decision.created_at DESC, decision.decision_id`,
        canonicalJson(applicationIds),
        source.kind === "event" ? source.eventId : source.deltaId
      )
      .toArray() as Row[];
    const result = new Map<string, string>();
    for (const row of rows) {
      const key = `${row["coordinate_kind"]}:${row["coordinate_id"]}`;
      if (!result.has(key)) result.set(key, String(row["decision_id"]));
    }
    return result;
  }

  private mergeComparison(
    targetState: StateNodeRef,
    source: NetMergeComparison["source"],
    observed: ReadonlyMap<string, string> = new Map()
  ): NetMergeComparison {
    const targetLine = this.firstParentLineage(targetState);
    let baseStates: StateNodeRef[];
    let sourceRoot: string;
    let sourceChanges: ChangeRecord[];
    let sourceApplicationIds: string[] | null = null;
    let sourceEventId: string | null = null;
    let sourceDeltaId: string | null = null;
    if (source.kind === "event") {
      if (!this.deps.store.event(source.eventId)) {
        throw new SemanticVcsError("InvalidReference", `Unknown event ${source.eventId}`);
      }
      sourceEventId = source.eventId;
      baseStates = this.maximalMergeBases(targetState, source.eventId).map((eventId) => ({
        kind: "event" as const,
        eventId,
      }));
      sourceRoot = this.deps.store.stateRoot({ kind: "event", eventId: source.eventId });
      sourceApplicationIds = this.firstParentLineage({
        kind: "event",
        eventId: source.eventId,
      }).applicationIds;
      sourceChanges = [];
    } else if (source.kind === "application") {
      if (!this.deps.store.application(source.applicationId)) {
        throw new SemanticVcsError(
          "InvalidReference",
          `Unknown application ${source.applicationId}`
        );
      }
      const sourceState = { kind: "application" as const, applicationId: source.applicationId };
      baseStates = this.maximalMergeBases(targetState, this.stateEvent(sourceState)).map(
        (eventId) => ({ kind: "event" as const, eventId })
      );
      sourceRoot = this.deps.store.stateRoot(sourceState);
      sourceApplicationIds = this.firstParentLineage(sourceState).applicationIds;
      sourceChanges = [];
    } else {
      const delta = this.deps.store.externalDelta(source.deltaId);
      if (!delta)
        throw new SemanticVcsError("InvalidReference", `Unknown external delta ${source.deltaId}`);
      sourceDeltaId = source.deltaId;
      baseStates = [delta.targetState];
      sourceRoot = this.deps.store.stateRoot(this.externalDeltaState(delta));
      sourceChanges = this.sourceChangesForDelta(delta);
    }
    const base = baseStates[0]!;
    let targetComparisonApplicationIds = targetLine.applicationIds;
    if (sourceApplicationIds) {
      // Exact applications present on both first-parent lines are shared
      // history, regardless of whether the graph has one or several maximal
      // merge bases. Remove that intersection before expanding changes so
      // comparison cost follows the branch delta rather than the imported
      // workspace. This reuses the two already-bounded lineage walks.
      const targetApplicationIds = new Set(targetComparisonApplicationIds);
      const sharedApplicationIds = new Set(
        sourceApplicationIds.filter((applicationId) => targetApplicationIds.has(applicationId))
      );
      sourceApplicationIds = sourceApplicationIds.filter(
        (applicationId) => !sharedApplicationIds.has(applicationId)
      );
      targetComparisonApplicationIds = targetComparisonApplicationIds.filter(
        (applicationId) => !sharedApplicationIds.has(applicationId)
      );
      sourceChanges = this.changesInApplications(sourceApplicationIds);
    }
    const baseRoot = this.deps.store.stateRoot(base);
    const targetRoot = this.deps.store.stateRoot(targetState);
    const decisions =
      source.kind === "application"
        ? new Map<string, string>()
        : this.reachableCoordinateDecisions(targetLine.applicationIds, source);
    const sourceCoordinates = new Map<string, MergeCoordinate>();
    for (const change of sourceChanges) {
      const coordinate = this.mergeChangeCoordinate(change);
      if (coordinate) sourceCoordinates.set(`${coordinate.kind}:${coordinate.id}`, coordinate);
    }
    if (sourceCoordinates.size > 10_000) {
      throw new SemanticVcsError("ScopeTooLarge", "Merge comparison exceeds its coordinate bound", {
        maximum: 10_000,
      });
    }
    const targetChanges = this.changesInApplications(targetComparisonApplicationIds);
    const sourceChangesByCoordinate = this.changesByMergeCoordinate(sourceChanges);
    const targetChangesByCoordinate = this.changesByMergeCoordinate(targetChanges);
    const initialCoordinates = [...sourceCoordinates.values()];
    const initialSourceEndpoints = this.coordinateEndpoints(sourceRoot, initialCoordinates);
    const initialTargetEndpoints = this.coordinateEndpoints(targetRoot, initialCoordinates);
    // Structural conflicts are coordinate-set conflicts. If a source result
    // occupies a path held by a target-only identity, that target identity must
    // participate too; otherwise "theirs" cannot vacate the destination.
    const structuralPeerKeys = new Set<string>();
    for (const coordinate of [...sourceCoordinates.values()]) {
      const key = `${coordinate.kind}:${coordinate.id}`;
      const endpoint = initialSourceEndpoints.get(key)!;
      let peer: MergeCoordinate | null = null;
      if (coordinate.kind === "file" && endpoint["kind"] === "file") {
        const targetEndpoint = initialTargetEndpoints.get(key)!;
        const placementAlreadyOwned =
          targetEndpoint["kind"] === "file" &&
          targetEndpoint["repositoryId"] === endpoint["repositoryId"] &&
          targetEndpoint["path"] === endpoint["path"];
        if (!placementAlreadyOwned) {
          const occupied = this.deps.store.facts.fileAtPath(
            targetRoot,
            String(endpoint["repositoryId"]),
            String(endpoint["path"])
          );
          if (occupied && occupied.state.fileId !== coordinate.id) {
            peer = { kind: "file", id: occupied.state.fileId };
          }
        }
      } else if (
        coordinate.kind === "repository" &&
        endpoint["presence"] === "present" &&
        typeof endpoint["repoPath"] === "string"
      ) {
        const occupied = this.deps.store.facts.repositoryAtPath(targetRoot, endpoint["repoPath"]);
        if (occupied && occupied.repositoryId !== coordinate.id) {
          peer = { kind: "repository", id: occupied.repositoryId };
        }
      }
      if (!peer) continue;
      const peerKey = `${peer.kind}:${peer.id}`;
      if (!sourceCoordinates.has(peerKey)) {
        sourceCoordinates.set(peerKey, peer);
        structuralPeerKeys.add(peerKey);
      }
    }
    if (sourceCoordinates.size > 10_000) {
      throw new SemanticVcsError("ScopeTooLarge", "Merge comparison exceeds its coordinate bound", {
        maximum: 10_000,
      });
    }
    const decisionTargets = new Map<
      string,
      {
        root: string;
        changesByCoordinate: Map<string, ChangeRecord[]>;
        resultRoot: string;
        laterChangesByCoordinate: Map<string, ChangeRecord[]>;
      }
    >();
    const coordinates: NetMergeCoordinate[] = [];
    const comparisonBaseEndpoints = new Map<string, Row>();
    const sourceEndpoints = new Map<string, Row>();
    const comparisonCoordinates = [...sourceCoordinates.values()];
    const targetEndpoints = this.coordinateEndpoints(targetRoot, comparisonCoordinates);
    const sourceRootEndpoints = this.coordinateEndpoints(sourceRoot, comparisonCoordinates);
    const baseEndpointMaps = new Map(
      baseStates.map((state) => {
        const root = this.deps.store.stateRoot(state);
        return [
          stateNodeKey(state),
          this.coordinateEndpoints(root, comparisonCoordinates),
        ] as const;
      })
    );
    for (const [key, coordinate] of [...sourceCoordinates].sort(([left], [right]) =>
      compareUtf16CodeUnits(left, right)
    )) {
      const coordinateSourceChanges = sourceChangesByCoordinate.get(key) ?? [];
      const authoredExternalBase =
        source.kind === "external-delta"
          ? coordinateSourceChanges.find((change) => change.base !== null)?.base
          : null;
      const baseEndpoints = authoredExternalBase
        ? [{ eventId: this.stateEvent(base), endpoint: authoredExternalBase }]
        : baseStates.map((state) => ({
            eventId: state.kind === "event" ? state.eventId : this.stateEvent(state),
            endpoint: baseEndpointMaps.get(stateNodeKey(state))!.get(key)!,
          }));
      const baseEndpoint = baseEndpoints[0]!.endpoint;
      comparisonBaseEndpoints.set(key, baseEndpoint);
      const oursEndpoint = targetEndpoints.get(key)!;
      let theirsEndpoint = sourceRootEndpoints.get(key)!;
      if (source.kind === "external-delta") {
        const last = [...sourceChanges].reverse().find((change) => {
          const value = this.mergeChangeCoordinate(change);
          return value?.kind === coordinate.kind && value.id === coordinate.id;
        });
        if (last?.result) theirsEndpoint = last.result;
      }
      const aspectNames: MergeAspectName[] =
        coordinate.kind === "file"
          ? ["presence", "content", "placement", "mode"]
          : ["presence", "path"];
      const sourceDiffersFromBase = aspectNames.some((aspect) =>
        baseEndpoints.some(
          ({ endpoint }) =>
            !this.sameAspectValue(
              aspect,
              this.aspectValue(endpoint, aspect),
              this.aspectValue(theirsEndpoint, aspect)
            )
        )
      );
      if (!sourceDiffersFromBase && !structuralPeerKeys.has(key)) continue;
      sourceEndpoints.set(key, theirsEndpoint);
      const aspects: NetMergeAspect[] = [];
      for (const aspect of aspectNames) {
        const baseValue = this.aspectValue(baseEndpoint, aspect);
        const oursValue = this.aspectValue(oursEndpoint, aspect);
        const theirsValue = this.aspectValue(theirsEndpoint, aspect);
        const theirsChanged = !this.sameAspectValue(aspect, baseValue, theirsValue);
        const oursChanged = !this.sameAspectValue(aspect, baseValue, oursValue);
        if (!theirsChanged && !oursChanged) continue;
        const baseValues = baseEndpoints.map(({ eventId, endpoint }) => ({
          eventId,
          value: this.aspectValue(endpoint, aspect),
        }));
        const ambiguous = baseValues.some(
          (value) => !this.sameAspectValue(aspect, value.value, baseValues[0]!.value)
        );
        let status: NetMergeAspect["status"];
        let composedText: string | undefined;
        let composedMappings: NetMergeAspect["composedMappings"];
        if (ambiguous) status = "conflict";
        else if (!theirsChanged) status = "ours";
        else if (!oursChanged) status = "adopt";
        else if (this.sameAspectValue(aspect, oursValue, theirsValue)) status = "convergent";
        else if (aspect === "content") {
          const hashes = [baseValue, oursValue, theirsValue].map((value) =>
            value && typeof value === "object" ? String((value as Row)["hash"] ?? "") : ""
          );
          const texts = hashes.map((hash) => observed.get(hash));
          if (texts.every((text): text is string => text !== undefined)) {
            const merged = threeWayTextMerge(texts[0]!, texts[1]!, texts[2]!);
            if (merged.kind === "too-large") {
              throw new SemanticVcsError(
                "ScopeTooLarge",
                `Text merge analysis exceeds its LCS bound for ${coordinate.kind} ${coordinate.id}`,
                { coordinates: [coordinate] }
              );
            }
            if (merged.kind === "composed") {
              status = "composed";
              composedText = merged.text;
              composedMappings = {
                ours: [...merged.oursMappings],
                theirs: [...merged.theirsMappings],
              };
            } else status = "conflict";
          } else status = "conflict";
        } else status = "conflict";
        aspects.push({
          aspect,
          base: baseValue,
          ours: oursValue,
          theirs: theirsValue,
          ...(ambiguous ? { baseValues } : {}),
          status,
          ...(composedText !== undefined ? { composedText } : {}),
          ...(composedMappings ? { composedMappings } : {}),
        });
      }
      if (!aspects.length) continue;
      const decisionId = decisions.get(key);
      const sourceAttribution = decisionId
        ? this.decisionCoordinateAttribution(decisionId, coordinate, sourceChanges)
        : this.coordinateAttribution(
            coordinateSourceChanges,
            coordinate,
            baseEndpoint,
            theirsEndpoint
          );
      let oursAttribution: MergeAttributionEntry[] = [];
      if (
        aspects.some((aspect) => !this.sameAspectValue(aspect.aspect, aspect.base, aspect.ours))
      ) {
        if (decisionId) {
          let cached = decisionTargets.get(decisionId);
          if (!cached) {
            const decisionTarget = this.decisionTargetState(decisionId);
            const decisionResult = this.decisionResultState(decisionId, targetLine.applicationIds);
            const decisionApplicationIndex = targetLine.applicationIds.indexOf(
              decisionResult.applicationId
            );
            if (decisionApplicationIndex < 0) {
              throw new SemanticVcsError(
                "IntegrityFailure",
                `Merge decision ${decisionId} result is not in the target lineage`
              );
            }
            cached = {
              root: this.deps.store.stateRoot(decisionTarget),
              changesByCoordinate: this.changesByMergeCoordinate(
                this.changesInApplications(this.firstParentLineage(decisionTarget).applicationIds)
              ),
              resultRoot: this.deps.store.stateRoot(decisionResult),
              laterChangesByCoordinate: this.changesByMergeCoordinate(
                this.changesInApplications(
                  targetLine.applicationIds.slice(decisionApplicationIndex + 1)
                )
              ),
            };
            decisionTargets.set(decisionId, cached);
          }
          const decisionTargetEndpoint = this.coordinateEndpoint(cached.root, coordinate);
          const beforeDecision = this.coordinateAttribution(
            cached.changesByCoordinate.get(key) ?? [],
            coordinate,
            baseEndpoint,
            decisionTargetEndpoint
          );
          const afterDecision = this.coordinateAttribution(
            cached.laterChangesByCoordinate.get(key) ?? [],
            coordinate,
            this.coordinateEndpoint(cached.resultRoot, coordinate),
            oursEndpoint
          );
          const unique = new Map<string, MergeAttributionEntry>();
          for (const entry of [...beforeDecision, ...afterDecision]) {
            unique.set(entry.changeId, entry);
          }
          oursAttribution = [...unique.values()];
        } else {
          const targetCoordinateChanges = targetChangesByCoordinate.get(key) ?? [];
          const externalPathIsLocallyAbsent =
            source.kind === "external-delta" &&
            coordinate.kind === "file" &&
            oursEndpoint["kind"] === "missing" &&
            targetCoordinateChanges.length === 0;
          oursAttribution = externalPathIsLocallyAbsent
            ? []
            : this.coordinateAttribution(
                targetCoordinateChanges,
                coordinate,
                baseEndpoint,
                oursEndpoint
              );
        }
      }
      let status: NetMergeCoordinate["status"];
      if (decisionId) status = "resolved";
      else if (aspects.some((aspect) => aspect.status === "conflict")) status = "conflict";
      else if (
        aspects.some((aspect) => aspect.status === "composed") ||
        (aspects.some((aspect) => aspect.status === "adopt") &&
          aspects.some((aspect) => aspect.status === "ours"))
      )
        status = "composed";
      else if (aspects.some((aspect) => aspect.status === "adopt")) status = "adopt";
      else status = "convergent";
      coordinates.push({
        coordinate,
        paths: {
          ...(this.coordinatePath(baseEndpoint) ? { base: this.coordinatePath(baseEndpoint) } : {}),
          ...(this.coordinatePath(oursEndpoint) ? { ours: this.coordinatePath(oursEndpoint) } : {}),
          ...(this.coordinatePath(theirsEndpoint)
            ? { theirs: this.coordinatePath(theirsEndpoint) }
            : {}),
        },
        status,
        aspects,
        attribution: { ours: oursAttribution, theirs: sourceAttribution },
        resolutions: decisionId
          ? []
          : status === "composed"
            ? ["composed", "theirs", "ours", "current"]
            : ["theirs", "ours", "current"],
        ...(decisionId ? { decisionId } : {}),
        summary: `${status} ${coordinate.kind} ${this.coordinatePath(theirsEndpoint) ?? coordinate.id}`,
      });
    }
    const sourceAlreadyAncestor =
      source.kind === "event" &&
      this.eventAncestors(this.stateEvent(targetState)).has(source.eventId);
    const applicationAlreadyAncestor =
      source.kind === "application" && targetLine.applicationIds.includes(source.applicationId);
    const concluded =
      sourceAlreadyAncestor ||
      applicationAlreadyAncestor ||
      (source.kind !== "application" &&
        targetLine.applicationIds.length > 0 &&
        this.integrationDecisionForSource(targetLine.applicationIds, source) !== null);
    this.applyStructuralMergeConstraints(
      coordinates,
      targetRoot,
      baseRoot,
      comparisonBaseEndpoints,
      sourceEndpoints
    );
    return {
      targetState,
      source,
      sourceEventId,
      sourceDeltaId,
      base,
      bases: baseStates,
      coordinates,
      concluded,
    };
  }

  private applyStructuralMergeConstraints(
    coordinates: NetMergeCoordinate[],
    targetRoot: string,
    baseRoot: string,
    baseEndpoints: ReadonlyMap<string, Row>,
    sourceEndpoints: ReadonlyMap<string, Row>
  ): void {
    if (coordinates.length > 10_000) {
      throw new SemanticVcsError("ScopeTooLarge", "Merge comparison exceeds its coordinate bound", {
        maximum: 10_000,
      });
    }
    const keyFor = (coordinate: MergeCoordinate) => `${coordinate.kind}:${coordinate.id}`;
    const touched = new Map(
      coordinates.map((coordinate) => [keyFor(coordinate.coordinate), coordinate])
    );
    // Structural validity depends on the touched coordinates, their destination
    // occupants, and their repository containers—not on every coordinate in
    // the workspace. Destination occupants were added to the comparison above,
    // so keep this pass proportional to the merge neighborhood. Repository
    // containers are resolved lazily when a touched file references one.
    const targetEndpointByKey = this.coordinateEndpoints(
      targetRoot,
      coordinates.map((coordinate) => coordinate.coordinate)
    );
    const targetEndpoint = (coordinate: MergeCoordinate): Row => {
      const key = keyFor(coordinate);
      const cached = targetEndpointByKey.get(key);
      if (cached) return cached;
      const endpoint = this.coordinateEndpoint(targetRoot, coordinate);
      targetEndpointByKey.set(key, endpoint);
      return endpoint;
    };
    const endpoints = new Map<string, Row>();
    for (const coordinate of coordinates) {
      const ours = targetEndpoint(coordinate.coordinate);
      const theirs = sourceEndpoints.get(keyFor(coordinate.coordinate));
      if (!theirs) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Merge source endpoint is missing for ${keyFor(coordinate.coordinate)}`,
          { coordinate: coordinate.coordinate }
        );
      }
      if (coordinate.status === "conflict" || coordinate.status === "resolved") {
        endpoints.set(keyFor(coordinate.coordinate), ours);
        continue;
      }
      let result = { ...ours };
      for (const aspect of coordinate.aspects) {
        if (aspect.status === "ours" || aspect.status === "conflict") continue;
        if (aspect.aspect === "presence") {
          result = { ...theirs };
        } else if (
          aspect.aspect === "placement" &&
          aspect.theirs &&
          typeof aspect.theirs === "object"
        ) {
          result["repositoryId"] = (aspect.theirs as Row)["repositoryId"];
          result["path"] = (aspect.theirs as Row)["path"];
          result["repoPath"] = theirs["repoPath"];
        } else if (aspect.aspect === "path") {
          result["repoPath"] = aspect.theirs;
        }
      }
      endpoints.set(keyFor(coordinate.coordinate), result);
    }

    const repositoryOwners = new Map<string, MergeCoordinate[]>();
    const fileOwners = new Map<string, MergeCoordinate[]>();
    const targetRepositoryOccupants = new Map<string, MergeCoordinate>();
    const targetFileOccupants = new Map<string, MergeCoordinate>();
    const addOwner = (
      map: Map<string, MergeCoordinate[]>,
      path: string,
      coordinate: MergeCoordinate
    ) => map.set(path, [...(map.get(path) ?? []), coordinate]);
    for (const coordinate of coordinates.filter((row) => row.coordinate.kind === "repository")) {
      const current = targetEndpoint(coordinate.coordinate);
      if (current["presence"] === "present" && typeof current["repoPath"] === "string") {
        targetRepositoryOccupants.set(String(current["repoPath"]), coordinate.coordinate);
      }
      const endpoint = endpoints.get(keyFor(coordinate.coordinate))!;
      if (endpoint["presence"] === "present" && typeof endpoint["repoPath"] === "string") {
        addOwner(repositoryOwners, String(endpoint["repoPath"]), coordinate.coordinate);
      }
    }
    for (const coordinate of coordinates.filter((row) => row.coordinate.kind === "file")) {
      const current = targetEndpoint(coordinate.coordinate);
      if (current["kind"] === "file") {
        targetFileOccupants.set(
          `${current["repositoryId"]}:${current["path"]}`,
          coordinate.coordinate
        );
      }
      const endpoint = endpoints.get(keyFor(coordinate.coordinate))!;
      if (endpoint["kind"] === "file") {
        addOwner(
          fileOwners,
          `${endpoint["repositoryId"]}:${endpoint["path"]}`,
          coordinate.coordinate
        );
      }
    }

    const graph = new Map<string, Set<string>>();
    const connect = (left: MergeCoordinate, right: MergeCoordinate) => {
      const leftKey = keyFor(left);
      const rightKey = keyFor(right);
      if (!touched.has(leftKey) || !touched.has(rightKey) || leftKey === rightKey) return;
      (graph.get(leftKey) ?? graph.set(leftKey, new Set()).get(leftKey)!).add(rightKey);
      (graph.get(rightKey) ?? graph.set(rightKey, new Set()).get(rightKey)!).add(leftKey);
    };
    const markStructuralConflict = (
      coordinate: MergeCoordinate,
      aspect: "placement" | "path" | "presence",
      peers: MergeCoordinate[],
      path: string
    ) => {
      const row = touched.get(keyFor(coordinate));
      if (!row || row.status === "resolved") return;
      const current = row.aspects.find((candidate) => candidate.aspect === aspect);
      const source = sourceEndpoints.get(keyFor(coordinate));
      if (!source) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Structural conflict source endpoint is missing for ${keyFor(coordinate)}`
        );
      }
      if (current) {
        current.status = "conflict";
      } else {
        row.aspects.push({
          aspect,
          base: this.aspectValue(
            baseEndpoints.get(keyFor(coordinate)) ?? this.coordinateEndpoint(baseRoot, coordinate),
            aspect
          ),
          ours: this.aspectValue(targetEndpoint(coordinate), aspect),
          theirs: this.aspectValue(source, aspect),
          status: "conflict",
        });
      }
      const conflicts = new Map(
        (row.structuralConflicts ?? []).map((peer) => [keyFor(peer), peer])
      );
      for (const peer of peers) conflicts.set(keyFor(peer), peer);
      row.structuralConflicts = [...conflicts.values()].sort((left, right) =>
        compareUtf16CodeUnits(keyFor(left), keyFor(right))
      );
      row.status = "conflict";
      row.summary = `structural conflict at ${path} with ${row.structuralConflicts
        .map(keyFor)
        .join(", ")}`;
    };
    for (const [path, owners] of repositoryOwners) {
      if (owners.length < 2) continue;
      for (const owner of owners) {
        markStructuralConflict(
          owner,
          "path",
          owners.filter((peer) => keyFor(peer) !== keyFor(owner)),
          path
        );
        for (const peer of owners) connect(owner, peer);
      }
    }
    for (const [path, owners] of fileOwners) {
      if (owners.length < 2) continue;
      for (const owner of owners) {
        markStructuralConflict(
          owner,
          "placement",
          owners.filter((peer) => keyFor(peer) !== keyFor(owner)),
          path
        );
        for (const peer of owners) connect(owner, peer);
      }
    }
    // A destination is not actually available until its current owner moves or
    // disappears.  Model that dependency explicitly so swaps and move chains
    // are selected as one atomic structural operation.
    for (const coordinate of coordinates) {
      const endpoint = endpoints.get(keyFor(coordinate.coordinate))!;
      const destination =
        coordinate.coordinate.kind === "file" && endpoint["kind"] === "file"
          ? `${endpoint["repositoryId"]}:${endpoint["path"]}`
          : coordinate.coordinate.kind === "repository" && endpoint["presence"] === "present"
            ? String(endpoint["repoPath"])
            : null;
      if (destination === null) continue;
      const occupant =
        coordinate.coordinate.kind === "file"
          ? targetFileOccupants.get(destination)
          : targetRepositoryOccupants.get(destination);
      if (!occupant || keyFor(occupant) === keyFor(coordinate.coordinate)) continue;
      const occupantResult = endpoints.get(keyFor(occupant));
      if (!occupantResult) continue;
      const occupantDestination =
        occupant.kind === "file" && occupantResult["kind"] === "file"
          ? `${occupantResult["repositoryId"]}:${occupantResult["path"]}`
          : occupant.kind === "repository" && occupantResult["presence"] === "present"
            ? String(occupantResult["repoPath"])
            : null;
      if (occupantDestination !== destination) connect(coordinate.coordinate, occupant);
    }
    for (const coordinate of coordinates.filter((row) => row.coordinate.kind === "file")) {
      const endpoint = endpoints.get(keyFor(coordinate.coordinate))!;
      if (endpoint["kind"] !== "file") continue;
      const repository = { kind: "repository" as const, id: String(endpoint["repositoryId"]) };
      const repositoryEndpoint = endpoints.get(keyFor(repository)) ?? targetEndpoint(repository);
      const targetRepositoryEndpoint = targetEndpoint(repository);
      if (
        targetRepositoryEndpoint["presence"] !== "present" &&
        repositoryEndpoint["presence"] === "present"
      ) {
        connect(coordinate.coordinate, repository);
      }
      if (repositoryEndpoint["presence"] !== "present") {
        markStructuralConflict(
          coordinate.coordinate,
          "presence",
          [repository],
          `${endpoint["repositoryId"]}:${endpoint["path"]}`
        );
      }
    }

    const visited = new Set<string>();
    for (const key of [...graph.keys()].sort(compareUtf16CodeUnits)) {
      if (visited.has(key)) continue;
      const component: string[] = [];
      const stack = [key];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (visited.has(current)) continue;
        visited.add(current);
        component.push(current);
        stack.push(...(graph.get(current) ?? []));
      }
      if (component.length < 2) continue;
      component.sort(compareUtf16CodeUnits);
      const group = compactId("merge-group", component);
      for (const member of component) touched.get(member)!.group = group;
    }
  }

  private decisionCoordinateAttribution(
    decisionId: string,
    coordinate: MergeCoordinate,
    knownSourceChanges?: readonly ChangeRecord[]
  ): MergeAttributionEntry[] {
    const decision = this.deps.sql
      .exec(
        `SELECT source_event_id, source_delta_id FROM gad_integration_decisions
          WHERE decision_id = ?`,
        decisionId
      )
      .toArray()[0] as Row | undefined;
    if (!decision) {
      throw new SemanticVcsError("IntegrityFailure", `Missing merge decision ${decisionId}`);
    }
    const accounted = new Set(
      (
        this.deps.sql
          .exec(
            `SELECT change_id FROM gad_decision_source_changes
            WHERE decision_id = ? AND coordinate_kind = ? AND coordinate_id = ?`,
            decisionId,
            coordinate.kind,
            coordinate.id
          )
          .toArray() as Row[]
      ).map((row) => String(row["change_id"]))
    );
    const sourceChanges =
      knownSourceChanges ??
      (decision["source_event_id"] != null
        ? this.changesInApplications(
            this.firstParentLineage({
              kind: "event",
              eventId: String(decision["source_event_id"]),
            }).applicationIds
          )
        : this.sourceChangesForDelta(
            this.deps.store.externalDelta(String(decision["source_delta_id"])) ??
              (() => {
                throw new SemanticVcsError(
                  "IntegrityFailure",
                  `Decision ${decisionId} references a missing external delta`
                );
              })()
          ));
    const selected = this.expandMergeAttribution(
      sourceChanges.filter((change) => accounted.has(change.changeId))
    );
    const active = this.attributionActiveChangeIds(selected);
    return selected.map((change) => ({
      changeId: change.changeId,
      workUnitId: change.workUnitId,
      ...(!active.has(change.changeId) ? { undone: true as const } : {}),
    }));
  }

  private decisionTargetState(decisionId: string): StateNodeRef {
    const row = this.deps.sql
      .exec(
        `SELECT target_state_kind, target_state_id
           FROM gad_integration_decisions WHERE decision_id = ?`,
        decisionId
      )
      .toArray()[0] as Row | undefined;
    if (!row) {
      throw new SemanticVcsError("IntegrityFailure", `Missing merge decision ${decisionId}`);
    }
    return row["target_state_kind"] === "event"
      ? { kind: "event", eventId: String(row["target_state_id"]) }
      : { kind: "application", applicationId: String(row["target_state_id"]) };
  }

  private decisionResultState(
    decisionId: string,
    lineageApplicationIds: readonly string[]
  ): { kind: "application"; applicationId: string } {
    const row = this.deps.sql
      .exec(
        `SELECT application.application_id
           FROM gad_integration_decisions decision
           JOIN gad_work_unit_applications application
             ON application.work_unit_id = decision.work_unit_id
           JOIN json_each(?) lineage
             ON application.application_id = CAST(lineage.value AS TEXT)
          WHERE decision.decision_id = ?
          ORDER BY CAST(lineage.key AS INTEGER)
          LIMIT 1`,
        canonicalJson(lineageApplicationIds),
        decisionId
      )
      .toArray()[0] as Row | undefined;
    if (!row) {
      throw new SemanticVcsError(
        "IntegrityFailure",
        `Merge decision ${decisionId} has no application in the target lineage`
      );
    }
    return { kind: "application", applicationId: String(row["application_id"]) };
  }

  private mergeTextContentHashes(comparison: NetMergeComparison): string[] {
    const hashes = new Set<string>();
    for (const coordinate of comparison.coordinates) {
      for (const aspect of coordinate.aspects) {
        if (aspect.aspect !== "content" || aspect.status !== "conflict" || aspect.baseValues) {
          continue;
        }
        const values = [aspect.base, aspect.ours, aspect.theirs];
        if (
          !values.every(
            (value): value is Row =>
              value !== null &&
              typeof value === "object" &&
              (value as Row)["kind"] === "text" &&
              typeof (value as Row)["hash"] === "string"
          )
        ) {
          continue;
        }
        for (const value of values) hashes.add(String(value["hash"]));
      }
    }
    return [...hashes].sort(compareUtf16CodeUnits);
  }

  private integrationDecisionForSource(
    applicationIds: readonly string[],
    source: VcsMergeInput["source"]
  ): string | null {
    if (!applicationIds.length) return null;
    const row = this.deps.sql
      .exec(
        `SELECT decision.decision_id
           FROM gad_integration_decisions decision
           JOIN gad_work_unit_applications application ON application.work_unit_id = decision.work_unit_id
           JOIN json_each(?) selected ON application.application_id = CAST(selected.value AS TEXT)
          WHERE ${source.kind === "event" ? "decision.source_event_id" : "decision.source_delta_id"} = ?
          ORDER BY decision.created_at DESC, decision.decision_id LIMIT 1`,
        canonicalJson(applicationIds),
        source.kind === "event" ? source.eventId : source.deltaId
      )
      .toArray()[0] as Row | undefined;
    return row ? String(row["decision_id"]) : null;
  }

  private assertIntegrationHistoryValid(mainEventId: string, publishedEventId: string): void {
    const stack = [publishedEventId];
    const seen = new Set<string>();
    let traversedEdges = 0;
    while (stack.length > 0) {
      const eventId = stack.pop()!;
      if (seen.has(eventId) || eventId === mainEventId) continue;
      seen.add(eventId);
      const event = this.deps.store.event(eventId);
      if (!event) throw new SemanticVcsError("IntegrityFailure", `Missing event ${eventId}`);
      if (event.kind === "integration-commit") {
        const sourceEventIds = event.parentEventIds.slice(1);
        const sourceDeltaIds = event.externalDeltaIds ?? [];
        if (sourceEventIds.length === 0 && sourceDeltaIds.length === 0) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Integration event ${eventId} has no source`
          );
        }
        const resultApplicationId = event.applicationIds.at(-1);
        if (!resultApplicationId) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Integration event ${eventId} has no merge application`
          );
        }
        const resultState = {
          kind: "application" as const,
          applicationId: resultApplicationId,
        };
        for (const sourceEventId of sourceEventIds) {
          const comparison = this.mergeComparison(resultState, {
            kind: "event",
            eventId: sourceEventId,
          });
          const remaining = comparison.coordinates
            .filter(
              (coordinate) => coordinate.status !== "resolved" && coordinate.status !== "convergent"
            )
            .map((coordinate) => coordinate.coordinate);
          if (remaining.length > 0) {
            throw new SemanticVcsError(
              "IntegrationIncomplete",
              `Integration event ${eventId} no longer validates source ${sourceEventId}`,
              {
                source: { kind: "event", eventId: sourceEventId },
                unaccountedCoordinates: remaining,
              }
            );
          }
        }
        for (const sourceDeltaId of sourceDeltaIds) {
          const delta = this.deps.store.externalDelta(sourceDeltaId);
          if (!delta) {
            throw new SemanticVcsError(
              "IntegrityFailure",
              `Integration event ${eventId} references missing external delta ${sourceDeltaId}`
            );
          }
          const comparison = this.mergeComparison(resultState, {
            kind: "external-delta",
            deltaId: sourceDeltaId,
          });
          const remaining = comparison.coordinates
            .filter(
              (coordinate) => coordinate.status !== "resolved" && coordinate.status !== "convergent"
            )
            .map((coordinate) => coordinate.coordinate);
          if (remaining.length > 0) {
            throw new SemanticVcsError(
              "IntegrationIncomplete",
              `Integration event ${eventId} no longer validates external delta ${sourceDeltaId}`,
              {
                source: { kind: "external-delta", deltaId: sourceDeltaId },
                unaccountedCoordinates: remaining,
              }
            );
          }
        }
      }
      traversedEdges += event.parentEventIds.length;
      if (traversedEdges > MAX_ANCESTRY_EDGES) {
        throw new SemanticVcsError("ScopeTooLarge", "Publication history exceeds its edge bound", {
          maximum: MAX_ANCESTRY_EDGES,
        });
      }
      stack.push(...event.parentEventIds);
    }
  }

  private firstParentLineage(state: StateNodeRef): {
    eventIds: string[];
    workingApplicationIds: string[];
    applicationIds: string[];
  } {
    const workingApplicationIds =
      state.kind === "application"
        ? readApplicationChain(this.deps.sql, state.applicationId, MAX_WORKING_APPLICATIONS)
        : [];
    let eventId = state.kind === "event" ? state.eventId : null;
    if (!eventId) {
      const first = workingApplicationIds[0];
      const basis = first
        ? (this.deps.sql
            .exec(
              `SELECT basis_kind, basis_id FROM gad_work_unit_applications
                WHERE application_id = ?`,
              first
            )
            .toArray()[0] as Row | undefined)
        : undefined;
      if (!basis || basis["basis_kind"] !== "event") {
        throw new SemanticVcsError("IntegrityFailure", "Working chain has no event basis");
      }
      eventId = String(basis["basis_id"]);
    }
    const reverse: string[] = [];
    while (eventId) {
      if (reverse.length >= MAX_ANCESTRY_EDGES) {
        throw new SemanticVcsError("ScopeTooLarge", "First-parent history exceeds its bound", {
          maximum: MAX_ANCESTRY_EDGES,
        });
      }
      const event = this.deps.store.event(eventId);
      if (!event) throw new SemanticVcsError("IntegrityFailure", `Missing event ${eventId}`);
      reverse.push(eventId);
      eventId = event.parentEventIds[0] ?? null;
    }
    const eventIds = reverse.reverse();
    const applicationIds = [
      ...eventIds.flatMap((id) => this.deps.store.event(id)?.applicationIds ?? []),
      ...workingApplicationIds,
    ];
    if (applicationIds.length > MAX_WORKING_APPLICATIONS) {
      throw new SemanticVcsError("ScopeTooLarge", "State history exceeds its application bound", {
        maximum: MAX_WORKING_APPLICATIONS,
      });
    }
    return { eventIds, workingApplicationIds, applicationIds };
  }

  private changesInApplications(applicationIds: readonly string[]): ChangeRecord[] {
    if (applicationIds.length === 0) return [];
    const rows = this.deps.sql
      .exec(
        `SELECT change.change_id
           FROM json_each(?) selected
           JOIN gad_applied_changes applied
             ON applied.application_id = CAST(selected.value AS TEXT)
           JOIN gad_changes change ON change.change_id = applied.change_id
          ORDER BY CAST(selected.key AS INTEGER), applied.ordinal, change.change_id`,
        canonicalJson(applicationIds)
      )
      .toArray() as Row[];
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      const changeId = String(row["change_id"]);
      if (seen.has(changeId)) return [];
      seen.add(changeId);
      return [this.changeRequired(changeId)];
    });
  }

  private decisionIdsInApplications(applicationIds: readonly string[]): string[] {
    if (applicationIds.length === 0) return [];
    return (
      this.deps.sql
        .exec(
          `SELECT DISTINCT decision.decision_id
             FROM gad_integration_decisions decision
             JOIN gad_work_unit_applications application
               ON application.work_unit_id = decision.work_unit_id
             JOIN json_each(?) selected
               ON application.application_id = CAST(selected.value AS TEXT)
            ORDER BY decision.decision_id`,
          canonicalJson(applicationIds)
        )
        .toArray() as Row[]
    ).map((row) => String(row["decision_id"]));
  }

  private integrationSourceEventIds(applicationIds: readonly string[]): string[] {
    if (applicationIds.length === 0) return [];
    return (
      this.deps.sql
        .exec(
          `SELECT DISTINCT decision.source_event_id
             FROM gad_integration_decisions decision
             JOIN gad_work_unit_applications application
               ON application.work_unit_id = decision.work_unit_id
             JOIN json_each(?) selected
               ON application.application_id = CAST(selected.value AS TEXT)
            WHERE decision.source_event_id IS NOT NULL
            ORDER BY decision.source_event_id`,
          canonicalJson(applicationIds)
        )
        .toArray() as Row[]
    ).map((row) => String(row["source_event_id"]));
  }

  private integrationSourceDeltaIds(applicationIds: readonly string[]): string[] {
    if (applicationIds.length === 0) return [];
    return (
      this.deps.sql
        .exec(
          `SELECT DISTINCT decision.source_delta_id
             FROM gad_integration_decisions decision
             JOIN gad_work_unit_applications application
               ON application.work_unit_id = decision.work_unit_id
             JOIN json_each(?) selected
               ON application.application_id = CAST(selected.value AS TEXT)
            WHERE decision.source_delta_id IS NOT NULL
            ORDER BY decision.source_delta_id`,
          canonicalJson(applicationIds)
        )
        .toArray() as Row[]
    ).map((row) => String(row["source_delta_id"]));
  }

  private counteractedChangeIds(change: ChangeRecord): string[] {
    const values = change.payload["counteractsChangeIds"];
    return Array.isArray(values)
      ? values.filter((value): value is string => typeof value === "string")
      : [];
  }

  /** Derive the live semantic changes at one exact first-parent state.
   *
   * Counteractions are ordinary changes and can themselves be counteracted.
   * Walking backwards means only a counteraction that is still live suppresses
   * its targets. This is deliberately a projection over the application chain,
   * never a stored dependency/counteraction closure. */
  private activeChangeIds(changes: readonly ChangeRecord[]): Set<string> {
    const active = new Set<string>();
    const suppressed = new Set<string>();
    for (let index = changes.length - 1; index >= 0; index -= 1) {
      const change = changes[index]!;
      if (suppressed.has(change.changeId)) continue;
      active.add(change.changeId);
      for (const counteractedId of this.counteractedChangeIds(change)) {
        suppressed.add(counteractedId);
      }
    }
    return active;
  }

  /** Return the changes whose authored contribution still reaches the final
   * attributed state. Explicit counteractions suppress changes first; ordinary
   * later changes then supersede the exact aspects whose result they consume.
   * Merge changes preserve their contributors while their result is live. */
  private attributionActiveChangeIds(changes: readonly ChangeRecord[]): Set<string> {
    const counteractionActive = this.activeChangeIds(changes);
    const liveAspects = new Map<string, Set<MergeAspectName>>();
    const authoredAspects = new Map<string, Set<MergeAspectName>>();
    const coordinateKeys = new Map<string, string>();
    const changesById = new Map(changes.map((change) => [change.changeId, change]));
    const aspectsFor = (change: ChangeRecord): MergeAspectName[] => {
      const coordinate = this.mergeChangeCoordinate(change);
      if (!coordinate) return [];
      const aspects: MergeAspectName[] =
        coordinate.kind === "file"
          ? ["presence", "content", "placement", "mode"]
          : ["presence", "path"];
      return aspects.filter(
        (aspect) =>
          !this.sameAspectValue(
            aspect,
            this.aspectValue(change.base ?? {}, aspect),
            this.aspectValue(change.result ?? {}, aspect)
          )
      );
    };
    for (const change of changes) {
      const coordinate = this.mergeChangeCoordinate(change);
      if (!coordinate) continue;
      const aspects = new Set(aspectsFor(change));
      authoredAspects.set(change.changeId, new Set(aspects));
      if (!counteractionActive.has(change.changeId)) continue;
      coordinateKeys.set(change.changeId, `${coordinate.kind}:${coordinate.id}`);
      liveAspects.set(change.changeId, aspects);
    }
    for (let index = 0; index < changes.length; index += 1) {
      const change = changes[index]!;
      if (!counteractionActive.has(change.changeId) || change.kind === "merge") continue;
      const coordinateKey = coordinateKeys.get(change.changeId);
      if (!coordinateKey) continue;
      for (const aspect of aspectsFor(change)) {
        const before = this.aspectValue(change.base ?? {}, aspect);
        for (let previous = index - 1; previous >= 0; previous -= 1) {
          const candidate = changes[previous]!;
          if (
            coordinateKeys.get(candidate.changeId) !== coordinateKey ||
            !liveAspects.get(candidate.changeId)?.has(aspect)
          ) {
            continue;
          }
          const candidateResult = this.aspectValue(candidate.result ?? {}, aspect);
          if (!this.sameAspectValue(aspect, candidateResult, before)) continue;
          liveAspects.get(candidate.changeId)!.delete(aspect);
          break;
        }
      }
    }
    const deactivateContributorAspects = (
      change: ChangeRecord,
      aspects: ReadonlySet<MergeAspectName>,
      visiting: Set<string>
    ): void => {
      if (visiting.has(change.changeId)) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Merge attribution contains a cycle at ${change.changeId}`
        );
      }
      visiting.add(change.changeId);
      const contributors = change.payload["mergesChangeIds"];
      if (Array.isArray(contributors)) {
        for (const contributorId of contributors) {
          if (typeof contributorId !== "string") continue;
          const contributorAspects = liveAspects.get(contributorId);
          for (const aspect of aspects) contributorAspects?.delete(aspect);
          const contributor = changesById.get(contributorId);
          if (contributor) deactivateContributorAspects(contributor, aspects, visiting);
        }
      }
      visiting.delete(change.changeId);
    };
    for (const change of changes) {
      if (change.kind !== "merge") continue;
      const authored = authoredAspects.get(change.changeId) ?? new Set<MergeAspectName>();
      const live = liveAspects.get(change.changeId) ?? new Set<MergeAspectName>();
      const superseded = new Set(
        [...authored].filter(
          (aspect) => !counteractionActive.has(change.changeId) || !live.has(aspect)
        )
      );
      if (superseded.size > 0) {
        deactivateContributorAspects(change, superseded, new Set());
      }
    }
    return new Set(
      [...liveAspects.entries()]
        .filter(([, aspects]) => aspects.size > 0)
        .map(([changeId]) => changeId)
    );
  }

  private changeCoordinate(change: ChangeRecord): string | null {
    const endpoint = change.result ?? change.base;
    if (typeof endpoint?.["fileId"] === "string") return `file:${endpoint["fileId"]}`;
    if (typeof endpoint?.["repositoryId"] === "string") {
      return `repository:${endpoint["repositoryId"]}`;
    }
    return null;
  }

  private changeResultHolds(state: StateNodeRef, change: ChangeRecord): boolean {
    return !!change.result && this.endpointHolds(state, change.result);
  }

  private revertBlockingChangeIds(state: StateNodeRef, original: ChangeRecord): string[] {
    const changes = this.changesInApplications(this.firstParentLineage(state).applicationIds);
    const originalIndex = changes.findIndex((change) => change.changeId === original.changeId);
    const coordinate = this.changeCoordinate(original);
    if (originalIndex < 0 || !coordinate) return [];
    return changes
      .slice(originalIndex + 1)
      .filter(
        (change) =>
          this.changeCoordinate(change) === coordinate && this.changeResultHolds(state, change)
      )
      .map((change) => change.changeId)
      .sort(compareUtf16CodeUnits);
  }

  private endpointHolds(state: StateNodeRef, endpoint: Row): boolean {
    const root = this.deps.store.stateRoot(state);
    if (endpoint["kind"] === "file" && typeof endpoint["fileId"] === "string") {
      const point = this.deps.store.facts.file(root, endpoint["fileId"]);
      if (!point || point.state.presence !== "placed") return false;
      const expected = endpoint;
      const repository = this.deps.store.facts.member(root, point.state.repositoryId);
      return (
        repository?.presence === "present" &&
        point.state.repositoryId === expected["repositoryId"] &&
        point.state.path === expected["path"] &&
        point.state.contentHash === expected["contentHash"] &&
        point.state.mode === expected["mode"] &&
        point.state.contentKind === expected["contentKind"] &&
        point.state.byteLength === expected["byteLength"] &&
        point.state.coordinateExtent === expected["coordinateExtent"]
      );
    }
    if (endpoint["kind"] === "missing" && typeof endpoint["fileId"] === "string") {
      const point = this.deps.store.facts.file(root, endpoint["fileId"]);
      return !point || point.state.presence === "deleted";
    }
    if (endpoint["kind"] === "repository" && typeof endpoint["repositoryId"] === "string") {
      const member = this.deps.store.facts.member(root, endpoint["repositoryId"]);
      if (endpoint["presence"] === "deleted") return !member || member.presence === "deleted";
      return (
        member?.presence === "present" &&
        (typeof endpoint["repoPath"] !== "string" || member.repoPath === endpoint["repoPath"])
      );
    }
    return false;
  }

  private publicAppliedChange(row: Row): Row {
    const appliedChangeId = String(row["applied_change_id"]);
    const change = this.changeRequired(String(row["change_id"]));
    const predicates = this.deps.sql
      .exec(
        `SELECT predicate_json FROM gad_applied_change_predicates
          WHERE applied_change_id = ? ORDER BY ordinal`,
        appliedChangeId
      )
      .toArray() as Row[];
    return {
      appliedChangeId,
      applicationId: String(row["application_id"]),
      changeId: change.changeId,
      ordinal: Number(row["ordinal"]),
      appliedEffects: changeEffects({
        ...change,
        base:
          row["applied_base_json"] == null
            ? null
            : (JSON.parse(String(row["applied_base_json"])) as Row),
        result:
          row["applied_result_json"] == null
            ? null
            : (JSON.parse(String(row["applied_result_json"])) as Row),
      }),
      resultPredicate:
        predicates.length === 0
          ? null
          : (JSON.parse(String(predicates[0]!["predicate_json"])) as Row),
    };
  }

  private inspectNode(node: Row): Row {
    switch (node["kind"]) {
      case "event": {
        const event = this.deps.store.event(String(node["eventId"]));
        if (!event) throw new SemanticVcsError("InvalidReference", "Unknown event");
        return {
          kind: "event",
          value: {
            eventId: event.eventId,
            workspaceId: this.deps.workspaceId,
            commandId: event.commandId,
            kind: event.kind,
            workspaceFactRootId: event.resultWorkspaceFactRootId,
            parentEventIds: event.parentEventIds,
            externalDeltaIds: event.externalDeltaIds ?? [],
            applicationIds: event.applicationIds,
            decisionIds: this.decisionIdsInApplications(event.applicationIds),
            message: event.message,
            semanticProtocol: SEMANTIC_PROTOCOL,
            createdAt: event.createdAt,
          },
        };
      }
      case "external-delta": {
        const delta = this.deps.store.externalDelta(String(node["deltaId"]));
        if (!delta) throw new SemanticVcsError("InvalidReference", "Unknown external delta");
        return { kind: "external-delta", value: this.publicExternalDelta(delta) };
      }
      case "application": {
        const application = this.deps.store.application(String(node["applicationId"]));
        if (!application) throw new SemanticVcsError("InvalidReference", "Unknown application");
        const appliedChanges = (
          this.deps.sql
            .exec(
              `SELECT * FROM gad_applied_changes
                WHERE application_id = ? ORDER BY ordinal LIMIT 200`,
              application.applicationId
            )
            .toArray() as Row[]
        ).map((row) => this.publicAppliedChange(row));
        return {
          kind: "application",
          value: {
            applicationId: application.applicationId,
            workUnitId: application.workUnitId,
            basis: application.basis,
            appliedChangeCount: application.appliedChangeIds.length,
            appliedChanges,
            resultWorkspaceFactRootId: application.resultWorkspaceFactRootId,
            semanticProtocol: application.semanticProtocol,
          },
        };
      }
      case "applied-change": {
        const row = this.deps.sql
          .exec(
            `SELECT * FROM gad_applied_changes WHERE applied_change_id = ?`,
            String(node["appliedChangeId"])
          )
          .toArray()[0] as Row | undefined;
        if (!row) throw new SemanticVcsError("InvalidReference", "Unknown applied change");
        return { kind: "applied-change", value: this.publicAppliedChange(row) };
      }
      case "change":
        return {
          kind: "change",
          value: this.publicChange(this.changeRequired(String(node["changeId"]))),
        };
      case "work-unit": {
        const row = this.deps.sql
          .exec(`SELECT * FROM gad_work_units WHERE work_unit_id = ?`, String(node["workUnitId"]))
          .toArray()[0] as Row | undefined;
        if (!row) throw new SemanticVcsError("InvalidReference", "Unknown work unit");
        const workUnitId = String(row["work_unit_id"]);
        const ids = (sql: string): string[] =>
          (this.deps.sql.exec(sql, workUnitId).toArray() as Row[]).map((value) =>
            String(value["id"])
          );
        const count = (table: string): number =>
          Number(
            (
              this.deps.sql
                .exec(`SELECT COUNT(*) AS count FROM ${table} WHERE work_unit_id = ?`, workUnitId)
                .toArray()[0] as Row
            )["count"]
          );
        const storedExternalSnapshot =
          row["external_snapshot_json"] == null
            ? null
            : (JSON.parse(String(row["external_snapshot_json"])) as Row);
        const targetRepositoryIds = Array.isArray(storedExternalSnapshot?.["targetRepositoryIds"])
          ? storedExternalSnapshot["targetRepositoryIds"].filter(
              (value): value is string => typeof value === "string"
            )
          : [];
        return {
          kind: "work-unit",
          value: {
            workUnitId,
            commandId: String(row["command_id"]),
            kind: String(row["kind"]),
            authoredChangeCount: count("gad_changes"),
            authoredChangeIds: ids(
              `SELECT change_id AS id FROM gad_changes
                WHERE work_unit_id = ? ORDER BY operation, ordinal LIMIT 200`
            ),
            incorporatedChangeCount: Number(
              (
                this.deps.sql
                  .exec(
                    `SELECT COUNT(*) AS count
                       FROM gad_integration_decisions decision
                       JOIN gad_decision_source_changes source
                         ON source.decision_id = decision.decision_id
                      WHERE decision.work_unit_id = ?`,
                    workUnitId
                  )
                  .toArray()[0] as Row
              )["count"]
            ),
            incorporatedChangeIds: ids(
              `SELECT source.change_id AS id
                 FROM gad_integration_decisions decision
                 JOIN gad_decision_source_changes source
                   ON source.decision_id = decision.decision_id
                WHERE decision.work_unit_id = ?
                ORDER BY source.change_id LIMIT 200`
            ),
            decisionCount: count("gad_integration_decisions"),
            decisionIds: ids(
              `SELECT decision_id AS id FROM gad_integration_decisions
                WHERE work_unit_id = ? ORDER BY created_at, decision_id LIMIT 200`
            ),
            intent: this.intentForWorkUnit(workUnitId),
            intentSummary: row["intent_summary"] == null ? null : String(row["intent_summary"]),
            authorContextId: String(row["author_context_id"]),
            triggerEvidence:
              row["trigger_excerpt"] == null || row["trigger_sender_json"] == null
                ? null
                : {
                    text: String(row["trigger_excerpt"]),
                    sender: JSON.parse(String(row["trigger_sender_json"])),
                  },
            externalSnapshot:
              storedExternalSnapshot == null
                ? null
                : {
                    sourceKind: storedExternalSnapshot["sourceKind"],
                    sourceUri: storedExternalSnapshot["sourceUri"],
                    snapshotRevision: storedExternalSnapshot["snapshotRevision"],
                    ...(typeof storedExternalSnapshot["sourceSubdir"] === "string" ||
                    storedExternalSnapshot["sourceSubdir"] === null
                      ? { sourceSubdir: storedExternalSnapshot["sourceSubdir"] }
                      : {}),
                    ...(typeof storedExternalSnapshot["canonicalSnapshot"] === "string"
                      ? { canonicalSnapshot: storedExternalSnapshot["canonicalSnapshot"] }
                      : {}),
                    snapshotDigest: storedExternalSnapshot["snapshotDigest"],
                    targetRepositoryIds,
                  },
            contentClass: String(row["content_class"]),
            externalKeys: JSON.parse(String(row["external_lineage_json"])),
            normalizationProtocol: String(row["normalization_protocol"]),
            createdAt: String(row["created_at"]),
          },
        };
      }
      case "decision": {
        const row = this.deps.sql
          .exec(
            `SELECT * FROM gad_integration_decisions WHERE decision_id = ?`,
            String(node["decisionId"])
          )
          .toArray()[0] as Row | undefined;
        if (!row) throw new SemanticVcsError("InvalidReference", "Unknown decision");
        return { kind: "decision", value: this.publicDecision(row) };
      }
      case "command": {
        const row = this.deps.sql
          .exec(
            `SELECT * FROM vcs_command_journal WHERE command_id = ? LIMIT 2`,
            String(node["commandId"])
          )
          .toArray()[0] as Row | undefined;
        if (!row) throw new SemanticVcsError("InvalidReference", "Unknown command");
        const result = row["result_json"] == null ? null : JSON.parse(String(row["result_json"]));
        const resultNode =
          result && typeof result === "object" && typeof result["workUnitId"] === "string"
            ? { kind: "work-unit", workUnitId: result["workUnitId"] }
            : result && typeof result === "object" && typeof result["eventId"] === "string"
              ? { kind: "event", eventId: result["eventId"] }
              : null;
        return {
          kind: "command",
          value: {
            commandId: String(row["command_id"]),
            workspaceId: this.deps.workspaceId,
            contextId: row["scope_kind"] === "context" ? String(row["scope_id"]) : null,
            method: String(row["method"]),
            status:
              row["status"] === "pending"
                ? "applying"
                : row["status"] === "effect-pending"
                  ? "effect-pending"
                  : row["status"],
            result: resultNode,
            createdAt: String(row["created_at"]),
            completedAt: row["completed_at"] == null ? null : String(row["completed_at"]),
          },
        };
      }
      case "file": {
        const state = node["state"] as StateNodeRef;
        const point = this.deps.store.facts.file(
          this.deps.store.stateRoot(state),
          String(node["fileId"])
        );
        if (!point) throw new SemanticVcsError("InvalidReference", "Unknown file");
        return {
          kind: "file",
          state,
          value:
            point.state.presence === "placed"
              ? {
                  kind: "placed",
                  fileId: point.state.fileId,
                  repositoryId: point.state.repositoryId,
                  path: point.state.path,
                  contentHash: point.state.contentHash,
                  mode: point.state.mode,
                  contentKind: point.state.contentKind,
                  byteLength: point.state.byteLength,
                  coordinateExtent: point.state.coordinateExtent,
                }
              : {
                  kind: "tombstone",
                  fileId: point.state.fileId,
                  priorPlacedStateId: point.state.priorFileStateId,
                  tombstoneChangeId: point.state.tombstoneChangeId,
                },
        };
      }
      case "repository": {
        const state = node["state"] as StateNodeRef;
        const value = this.deps.store.facts.member(
          this.deps.store.stateRoot(state),
          String(node["repositoryId"])
        );
        if (!value) throw new SemanticVcsError("InvalidReference", "Unknown repository");
        return {
          kind: "repository",
          state,
          value:
            value.presence === "present"
              ? {
                  kind: "present",
                  repositoryId: value.repositoryId,
                  repoPath: value.repoPath,
                  manifestId: value.fileManifestId,
                }
              : {
                  kind: "tombstone",
                  repositoryId: value.repositoryId,
                  priorPresentStateId: value.priorRepositoryStateId,
                  tombstoneChangeId: value.tombstoneChangeId,
                },
        };
      }
      case "trajectory":
        return { kind: "trajectory", value: node };
      case "trajectory-invocation": {
        const row = this.deps.sql
          .exec(
            `SELECT turn_id, kind, status, terminal_outcome, request_ref_json,
                    started_event_id, completed_event_id
               FROM trajectory_invocations
              WHERE log_id = ? AND head = ? AND invocation_id = ? LIMIT 1`,
            String(node["logId"]),
            String(node["head"]),
            String(node["invocationId"])
          )
          .toArray()[0];
        if (!row) throw new SemanticVcsError("InvalidReference", "Unknown trajectory invocation");
        return {
          kind: "trajectory-invocation",
          value: {
            logId: String(node["logId"]),
            head: String(node["head"]),
            invocationId: String(node["invocationId"]),
            turnId: row["turn_id"] == null ? null : String(row["turn_id"]),
            name: row["kind"] == null ? null : String(row["kind"]),
            status: String(row["status"]),
            terminalOutcome:
              row["terminal_outcome"] == null ? null : String(row["terminal_outcome"]),
            requestRef:
              row["request_ref_json"] == null
                ? null
                : trajectoryRequestRef(JSON.parse(String(row["request_ref_json"]))),
            startedEventId:
              row["started_event_id"] == null ? null : String(row["started_event_id"]),
            completedEventId:
              row["completed_event_id"] == null ? null : String(row["completed_event_id"]),
          },
        };
      }
      case "trajectory-turn": {
        const row = this.deps.sql
          .exec(
            `SELECT trigger_message_id, opened_at, closed_at, summary, ordinal
               FROM trajectory_turns
              WHERE log_id = ? AND head = ? AND turn_id = ? LIMIT 1`,
            String(node["logId"]),
            String(node["head"]),
            String(node["turnId"])
          )
          .toArray()[0];
        if (!row) throw new SemanticVcsError("InvalidReference", "Unknown trajectory turn");
        return {
          kind: "trajectory-turn",
          value: {
            logId: String(node["logId"]),
            head: String(node["head"]),
            turnId: String(node["turnId"]),
            triggerMessageId:
              row["trigger_message_id"] == null ? null : String(row["trigger_message_id"]),
            openedAt: row["opened_at"] == null ? null : String(row["opened_at"]),
            closedAt: row["closed_at"] == null ? null : String(row["closed_at"]),
            summary: row["summary"] == null ? null : String(row["summary"]),
            ordinal: row["ordinal"] == null ? null : Number(row["ordinal"]),
          },
        };
      }
      case "trajectory-message": {
        const row = this.deps.sql
          .exec(
            `SELECT turn_id, role, status, started_event_id, completed_event_id
               FROM trajectory_messages
              WHERE log_id = ? AND head = ? AND message_id = ? LIMIT 1`,
            String(node["logId"]),
            String(node["head"]),
            String(node["messageId"])
          )
          .toArray()[0];
        if (!row) throw new SemanticVcsError("InvalidReference", "Unknown trajectory message");
        const payloadEventId = row["completed_event_id"] ?? row["started_event_id"];
        const payloadRow =
          payloadEventId == null
            ? undefined
            : this.deps.sql
                .exec(
                  `SELECT actor_json, payload_ref_json FROM log_events
                    WHERE log_id = ? AND head = ? AND envelope_id = ? LIMIT 1`,
                  String(node["logId"]),
                  String(node["head"]),
                  String(payloadEventId)
                )
                .toArray()[0];
        const payload = payloadRow
          ? (JSON.parse(String(payloadRow["payload_ref_json"])) as Row)
          : {};
        const eventActor = payloadRow ? JSON.parse(String(payloadRow["actor_json"])) : null;
        const senderRef = trajectorySenderRef(payload["senderRef"] ?? eventActor);
        const textBlocks = (Array.isArray(payload["blocks"]) ? payload["blocks"] : []).flatMap(
          (value, index) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return [];
            const block = value as Row;
            if (block["type"] !== "text" || typeof block["content"] !== "string") return [];
            return [
              {
                blockId:
                  typeof block["blockId"] === "string"
                    ? block["blockId"]
                    : `${String(node["messageId"])}:block:${index}`,
                content: block["content"],
              },
            ];
          }
        );
        return {
          kind: "trajectory-message",
          value: {
            logId: String(node["logId"]),
            head: String(node["head"]),
            messageId: String(node["messageId"]),
            turnId: row["turn_id"] == null ? null : String(row["turn_id"]),
            role: String(row["role"]),
            status: String(row["status"]),
            startedEventId:
              row["started_event_id"] == null ? null : String(row["started_event_id"]),
            completedEventId:
              row["completed_event_id"] == null ? null : String(row["completed_event_id"]),
            sourceMessageId:
              typeof payload["sourceMessageId"] === "string" ? payload["sourceMessageId"] : null,
            senderRef,
            textBlocks,
          },
        };
      }
      default:
        throw new SemanticVcsError("InvalidReference", `Unknown node kind ${String(node["kind"])}`);
    }
  }

  private eventNeighborEdges(
    node: Row,
    after: Readonly<{ phase: number; key: string | null }>,
    limit: number
  ): PositionedNeighborEdge[] {
    const eventId = String(node["eventId"]);
    const event = this.deps.sql
      .exec(`SELECT 1 FROM gad_workspace_events WHERE event_id = ?`, eventId)
      .toArray()[0];
    if (!event) throw new SemanticVcsError("InvalidReference", `Unknown event ${eventId}`);
    const rows = this.pageNeighborPhases(after, limit, [
      {
        phase: 0,
        edgeKind: "caused-by",
        sql: `SELECT '' AS sort_key, command_id AS target_id
                FROM gad_workspace_events
               WHERE event_id = ? AND (? IS NULL OR '' > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [eventId],
      },
      {
        phase: 1,
        edgeKind: "parent-out",
        sql: `SELECT printf('%020d:', ordinal) || parent_event_id AS sort_key,
                     parent_event_id AS target_id
                FROM gad_workspace_event_parents
               WHERE event_id = ?
                 AND (? IS NULL OR printf('%020d:', ordinal) || parent_event_id > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [eventId],
      },
      {
        phase: 2,
        edgeKind: "parent-in",
        sql: `SELECT event_id AS sort_key, event_id AS target_id
                FROM gad_workspace_event_parents
               WHERE parent_event_id = ? AND (? IS NULL OR event_id > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [eventId],
      },
      {
        phase: 3,
        edgeKind: "committed-by",
        sql: `SELECT printf('%020d:', ordinal) || application_id AS sort_key,
                     application_id AS target_id
                FROM gad_workspace_event_applications
               WHERE event_id = ?
                 AND (? IS NULL OR printf('%020d:', ordinal) || application_id > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [eventId],
      },
      {
        phase: 4,
        edgeKind: "basis-state",
        sql: `SELECT application_id AS sort_key, application_id AS target_id
                FROM gad_work_unit_applications
               WHERE basis_kind = 'event' AND basis_id = ?
                 AND (? IS NULL OR application_id > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [eventId],
      },
    ]);
    const state = { kind: "event", eventId } as const;
    const edges = rows.map((row): PositionedNeighborEdge => {
      const edgeKind = String(row["edge_kind"]);
      const targetId = String(row["target_id"]);
      return {
        position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
        edge:
          edgeKind === "caused-by"
            ? {
                kind: edgeKind,
                from: state,
                to: { kind: "command", commandId: targetId },
              }
            : edgeKind === "parent-out"
              ? {
                  kind: "parent-event",
                  from: state,
                  to: { kind: "event", eventId: targetId },
                }
              : edgeKind === "parent-in"
                ? {
                    kind: "parent-event",
                    from: { kind: "event", eventId: targetId },
                    to: state,
                  }
                : edgeKind === "committed-by"
                  ? {
                      kind: "committed-by",
                      from: state,
                      to: { kind: "application", applicationId: targetId },
                    }
                  : {
                      kind: "basis-state",
                      from: { kind: "application", applicationId: targetId },
                      to: state,
                    },
      };
    });
    return this.appendStateMemberEdges(
      state,
      this.deps.store.stateRoot(state),
      after,
      5,
      6,
      limit,
      edges
    );
  }

  /**
   * Pages typed adjacency as the graph models it: one independently keyset-paged
   * query per ordered edge phase. A node may grow new edge kinds without turning
   * its adjacency into one deployment-limited compound SELECT.
   *
   * Every phase query returns `sort_key` plus its edge-specific columns and
   * accepts `(afterKey, afterKey, remainingLimit)` after its declared params.
   */
  private pageNeighborPhases(
    after: Readonly<{ phase: number; key: string | null }>,
    limit: number,
    phases: readonly NeighborPhaseQuery[]
  ): Row[] {
    const rows: Row[] = [];
    for (const phase of phases) {
      if (rows.length >= limit) break;
      if (after.phase > phase.phase) continue;
      const afterKey = after.phase === phase.phase ? after.key : null;
      const phaseRows = this.deps.sql
        .exec(phase.sql, ...phase.params, afterKey, afterKey, limit - rows.length)
        .toArray() as Row[];
      rows.push(
        ...phaseRows.map((row) => ({
          ...row,
          edge_group: phase.phase,
          ...(phase.edgeKind === undefined ? {} : { edge_kind: phase.edgeKind }),
        }))
      );
    }
    return rows;
  }

  private applicationNeighborEdges(
    node: Row,
    after: Readonly<{ phase: number; key: string | null }>,
    limit: number
  ): PositionedNeighborEdge[] {
    const applicationId = String(node["applicationId"]);
    const application = this.deps.sql
      .exec(`SELECT 1 FROM gad_work_unit_applications WHERE application_id = ?`, applicationId)
      .toArray()[0];
    if (!application) {
      throw new SemanticVcsError("InvalidReference", `Unknown application ${applicationId}`);
    }
    const rows = this.pageNeighborPhases(after, limit, [
      {
        phase: 0,
        edgeKind: "basis-state",
        sql: `SELECT '' AS sort_key, basis_kind AS target_kind, basis_id AS target_id
                FROM gad_work_unit_applications
               WHERE application_id = ? AND (? IS NULL OR '' > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [applicationId],
      },
      {
        phase: 1,
        edgeKind: "basis-state-in",
        sql: `SELECT application_id AS sort_key, 'application' AS target_kind,
                     application_id AS target_id
                FROM gad_work_unit_applications
               WHERE basis_kind = 'application' AND basis_id = ?
                 AND (? IS NULL OR application_id > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [applicationId],
      },
      {
        phase: 2,
        edgeKind: "committed-by",
        sql: `SELECT event_id AS sort_key, 'event' AS target_kind, event_id AS target_id
                FROM gad_workspace_event_applications
               WHERE application_id = ? AND (? IS NULL OR event_id > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [applicationId],
      },
      {
        phase: 3,
        edgeKind: "applies-work",
        sql: `SELECT '' AS sort_key, 'work-unit' AS target_kind, work_unit_id AS target_id
                FROM gad_work_unit_applications
               WHERE application_id = ? AND (? IS NULL OR '' > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [applicationId],
      },
      {
        phase: 4,
        edgeKind: "applies-change",
        sql: `SELECT printf('%020d:', ordinal) || applied_change_id AS sort_key,
                     'applied-change' AS target_kind, applied_change_id AS target_id
                FROM gad_applied_changes
               WHERE application_id = ?
                 AND (? IS NULL OR printf('%020d:', ordinal) || applied_change_id > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [applicationId],
      },
    ]);
    const state = { kind: "application", applicationId } as const;
    const edges = rows.map((row): PositionedNeighborEdge => {
      const edgeKind = String(row["edge_kind"]);
      const targetId = String(row["target_id"]);
      return {
        position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
        edge:
          edgeKind === "basis-state"
            ? {
                kind: edgeKind,
                from: state,
                to:
                  row["target_kind"] === "event"
                    ? { kind: "event", eventId: targetId }
                    : { kind: "application", applicationId: targetId },
              }
            : edgeKind === "basis-state-in"
              ? {
                  kind: "basis-state",
                  from: { kind: "application", applicationId: targetId },
                  to: state,
                }
              : edgeKind === "committed-by"
                ? {
                    kind: edgeKind,
                    from: { kind: "event", eventId: targetId },
                    to: state,
                  }
                : edgeKind === "applies-work"
                  ? {
                      kind: edgeKind,
                      from: state,
                      to: { kind: "work-unit", workUnitId: targetId },
                    }
                  : {
                      kind: "applies-change",
                      from: state,
                      to: { kind: "applied-change", appliedChangeId: targetId },
                    },
      };
    });
    return this.appendStateMemberEdges(
      state,
      this.deps.store.stateRoot(state),
      after,
      5,
      6,
      limit,
      edges
    );
  }

  private appendStateMemberEdges(
    state: StateNodeRef,
    root: string,
    phase: Readonly<{ phase: number; key: string | null }>,
    repositoryPhase: number,
    filePhase: number,
    limit: number,
    edges: PositionedNeighborEdge[]
  ): PositionedNeighborEdge[] {
    const result = [...edges];
    if (result.length < limit && phase.phase <= repositoryPhase) {
      const repositories = this.deps.store.facts.page(root, "repository", {
        ...(phase.phase === repositoryPhase && phase.key !== null ? { afterKey: phase.key } : {}),
        limit: limit - result.length,
      });
      result.push(
        ...repositories.values.map(({ key: repositoryId }) => ({
          position: { phase: repositoryPhase, key: repositoryId },
          edge: {
            kind: "contains-repository",
            from: state,
            to: { kind: "repository", state, repositoryId },
          },
        }))
      );
    }
    if (result.length >= limit || phase.phase > filePhase) return result;

    let afterFileId = phase.phase === filePhase ? (phase.key ?? undefined) : undefined;
    while (result.length < limit) {
      const files = this.deps.store.facts.page(root, "file", {
        ...(afterFileId ? { afterKey: afterFileId } : {}),
        limit: Math.max(limit - result.length, 100),
      });
      for (const { key: fileId } of files.values) {
        const point = this.deps.store.facts.file(root, fileId);
        if (!point || point.state.presence !== "placed") continue;
        result.push({
          position: { phase: filePhase, key: fileId },
          edge: {
            kind: "places-file",
            from: state,
            to: { kind: "file", state, repositoryId: point.state.repositoryId, fileId },
          },
        });
        if (result.length >= limit) break;
      }
      if (result.length >= limit || files.next === null) break;
      afterFileId = files.next;
    }
    return result;
  }

  private appliedChangeNeighborEdges(
    node: Row,
    after: Readonly<{ phase: number; key: string | null }>,
    limit: number
  ): PositionedNeighborEdge[] {
    const appliedChangeId = String(node["appliedChangeId"]);
    const exists = this.deps.sql
      .exec(`SELECT 1 FROM gad_applied_changes WHERE applied_change_id = ?`, appliedChangeId)
      .toArray()[0];
    if (!exists) {
      throw new SemanticVcsError("InvalidReference", `Unknown applied change ${appliedChangeId}`);
    }
    const rows = this.deps.sql
      .exec(
        `SELECT edge_group, sort_key, edge_kind, source_id, target_id FROM (
           SELECT 0 AS edge_group, '' AS sort_key, 'applies-change' AS edge_kind,
                  application_id AS source_id, applied_change_id AS target_id
             FROM gad_applied_changes WHERE applied_change_id = ?
           UNION ALL
           SELECT 1, '', 'realizes-change', applied_change_id, change_id
             FROM gad_applied_changes WHERE applied_change_id = ?
           UNION ALL
           SELECT 2, content_edge_id,
                  CASE relation
                    WHEN 'incorporates' THEN 'incorporates-content'
                    WHEN 'copies' THEN 'copies-content'
                    ELSE 'preserves-content'
                  END,
                  child_applied_change_id, parent_applied_change_id
             FROM gad_content_edges
            WHERE child_applied_change_id = ? OR parent_applied_change_id = ?
         ) adjacency
         WHERE edge_group > ?
            OR (edge_group = ? AND (? IS NULL OR sort_key > ?))
         ORDER BY edge_group, sort_key, target_id
         LIMIT ?`,
        appliedChangeId,
        appliedChangeId,
        appliedChangeId,
        appliedChangeId,
        after.phase,
        after.phase,
        after.key,
        after.key,
        limit
      )
      .toArray() as Row[];
    return rows.map((row) => {
      const edgeKind = String(row["edge_kind"]);
      const sourceId = String(row["source_id"]);
      const targetId = String(row["target_id"]);
      return {
        position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
        edge:
          edgeKind === "applies-change"
            ? {
                kind: edgeKind,
                from: { kind: "application", applicationId: sourceId },
                to: { kind: "applied-change", appliedChangeId: targetId },
              }
            : edgeKind === "realizes-change"
              ? {
                  kind: edgeKind,
                  from: { kind: "applied-change", appliedChangeId: sourceId },
                  to: { kind: "change", changeId: targetId },
                }
              : {
                  kind: edgeKind,
                  from: { kind: "applied-change", appliedChangeId: sourceId },
                  to: { kind: "applied-change", appliedChangeId: targetId },
                },
      };
    });
  }

  private neighborEdges(
    node: Row,
    cursor: string | undefined,
    limit: number
  ): PositionedNeighborEdge[] {
    const kind = String(node["kind"]);
    const after = parseNeighborCursor(cursor, { root: node });
    if (kind === "external-delta") {
      const delta = this.deps.store.externalDelta(String(node["deltaId"]));
      if (!delta) throw new SemanticVcsError("InvalidReference", "Unknown external delta");
      return [];
    }
    if (kind === "event") return this.eventNeighborEdges(node, after, limit);
    if (kind === "application") return this.applicationNeighborEdges(node, after, limit);
    if (kind === "applied-change") return this.appliedChangeNeighborEdges(node, after, limit);
    if (kind === "work-unit") {
      const workUnitId = String(node["workUnitId"]);
      const exists = this.deps.sql
        .exec(`SELECT 1 FROM gad_work_units WHERE work_unit_id = ?`, workUnitId)
        .toArray();
      if (exists.length === 0) {
        throw new SemanticVcsError("InvalidReference", `Unknown work unit ${workUnitId}`);
      }
      const rows = this.pageNeighborPhases(after, limit, [
        {
          phase: 0,
          edgeKind: "caused-by",
          sql: `SELECT '' AS sort_key, command_id AS target_id, NULL AS state_id
                  FROM gad_work_units
                 WHERE work_unit_id = ? AND (? IS NULL OR '' > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [workUnitId],
        },
        {
          phase: 1,
          edgeKind: "applies-work",
          sql: `SELECT application_id AS sort_key, application_id AS target_id, NULL AS state_id
                  FROM gad_work_unit_applications
                 WHERE work_unit_id = ? AND (? IS NULL OR application_id > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [workUnitId],
        },
        {
          phase: 2,
          edgeKind: "authored-change",
          sql: `SELECT printf('%020d:%020d', operation, ordinal) AS sort_key,
                       change_id AS target_id, NULL AS state_id
                  FROM gad_changes
                 WHERE work_unit_id = ?
                   AND (? IS NULL OR printf('%020d:%020d', operation, ordinal) > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [workUnitId],
        },
        {
          phase: 3,
          edgeKind: "incorporates-change",
          sql: `SELECT source.change_id AS sort_key,
                       source.change_id AS target_id, NULL AS state_id
                  FROM gad_integration_decisions decision
                  JOIN gad_decision_source_changes source
                    ON source.decision_id = decision.decision_id
                 WHERE decision.work_unit_id = ? AND (? IS NULL OR source.change_id > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [workUnitId],
        },
        {
          phase: 4,
          edgeKind: "records-decision",
          sql: `SELECT created_at || ':' || decision_id AS sort_key,
                       decision_id AS target_id, NULL AS state_id
                  FROM gad_integration_decisions
                 WHERE work_unit_id = ?
                   AND (? IS NULL OR created_at || ':' || decision_id > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [workUnitId],
        },
        {
          phase: 5,
          edgeKind: "imports-repository",
          sql: `SELECT application.application_id || ':' || CAST(target.key AS TEXT) AS sort_key,
                       CAST(target.value AS TEXT) AS target_id,
                       application.application_id AS state_id
                  FROM gad_work_units work
                  JOIN gad_work_unit_applications application
                    ON application.work_unit_id = work.work_unit_id
                  JOIN json_each(work.external_snapshot_json, '$.targetRepositoryIds') target
                 WHERE work.work_unit_id = ?
                   AND (? IS NULL OR application.application_id || ':' || CAST(target.key AS TEXT) > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [workUnitId],
        },
      ]);
      const workUnitEdges = rows.map((row) => {
        const edgeKind = String(row["edge_kind"]);
        const targetId = String(row["target_id"]);
        if (edgeKind === "caused-by") {
          return {
            kind: edgeKind,
            from: { kind: "work-unit", workUnitId },
            to: { kind: "command", commandId: targetId },
          };
        }
        if (edgeKind === "applies-work") {
          return {
            kind: edgeKind,
            from: { kind: "application", applicationId: targetId },
            to: { kind: "work-unit", workUnitId },
          };
        }
        if (edgeKind === "authored-change" || edgeKind === "incorporates-change") {
          return {
            kind: edgeKind,
            from: { kind: "work-unit", workUnitId },
            to: { kind: "change", changeId: targetId },
          };
        }
        if (edgeKind === "imports-repository") {
          return {
            kind: edgeKind,
            from: { kind: "work-unit", workUnitId },
            to: {
              kind: "repository",
              state: { kind: "application", applicationId: String(row["state_id"]) },
              repositoryId: targetId,
            },
          };
        }
        return {
          kind: "records-decision",
          from: { kind: "work-unit", workUnitId },
          to: { kind: "decision", decisionId: targetId },
        };
      });
      return workUnitEdges.map((edge, index) => ({
        position: {
          phase: Number(rows[index]!["edge_group"]),
          key: String(rows[index]!["sort_key"]),
        },
        edge,
      }));
    } else if (kind === "change") {
      const changeId = String(node["changeId"]);
      const change = this.changeRequired(changeId);
      const rows = this.pageNeighborPhases(after, limit, [
        {
          phase: 0,
          edgeKind: "authored-change",
          sql: `SELECT '' AS sort_key, work_unit_id AS source_id, change_id AS target_id,
                       NULL AS source_state_kind, NULL AS source_state_id,
                       NULL AS source_repository_id, NULL AS source_file_id
                  FROM gad_changes
                 WHERE change_id = ? AND (? IS NULL OR '' > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [changeId],
        },
        {
          phase: 1,
          edgeKind: "realizes-change",
          sql: `SELECT applied_change_id AS sort_key, applied_change_id AS source_id,
                       change_id AS target_id, NULL AS source_state_kind,
                       NULL AS source_state_id, NULL AS source_repository_id,
                       NULL AS source_file_id
                  FROM gad_applied_changes
                 WHERE change_id = ? AND (? IS NULL OR applied_change_id > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [changeId],
        },
        {
          phase: 2,
          edgeKind: "decides-change",
          sql: `SELECT decision_id AS sort_key, decision_id AS source_id,
                       change_id AS target_id, NULL AS source_state_kind,
                       NULL AS source_state_id, NULL AS source_repository_id,
                       NULL AS source_file_id
                  FROM gad_decision_source_changes
                 WHERE change_id = ? AND (? IS NULL OR decision_id > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [changeId],
        },
        {
          phase: 3,
          edgeKind: "incorporates-change",
          sql: `SELECT decision.work_unit_id AS sort_key,
                       decision.work_unit_id AS source_id, source.change_id AS target_id,
                       NULL AS source_json
                  FROM gad_decision_source_changes source
                  JOIN gad_integration_decisions decision
                    ON decision.decision_id = source.decision_id
                 WHERE source.change_id = ?
                   AND (? IS NULL OR decision.work_unit_id > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [changeId],
        },
        {
          phase: 4,
          edgeKind: "counteracts",
          sql: `SELECT counteracted_change_id AS sort_key, change_id AS source_id,
                       counteracted_change_id AS target_id, NULL AS source_state_kind,
                       NULL AS source_state_id, NULL AS source_repository_id,
                       NULL AS source_file_id
                  FROM gad_change_counteractions
                 WHERE change_id = ? AND (? IS NULL OR counteracted_change_id > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [changeId],
        },
        {
          phase: 5,
          edgeKind: "counteracts",
          sql: `SELECT change_id AS sort_key, change_id AS source_id, ? AS target_id,
                       NULL AS source_state_kind, NULL AS source_state_id,
                       NULL AS source_repository_id, NULL AS source_file_id
                  FROM gad_change_counteractions
                 WHERE counteracted_change_id = ? AND (? IS NULL OR change_id > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [changeId, changeId],
        },
        {
          phase: 6,
          edgeKind: "authored-copy-source",
          sql: `SELECT '' AS sort_key, change_id AS source_id,
                       change_id AS target_id, source_json
                  FROM gad_changes
                 WHERE change_id = ? AND source_json IS NOT NULL
                   AND (? IS NULL OR '' > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [changeId],
        },
      ]);
      return rows.map((row) => {
        const edgeKind = String(row["edge_kind"]);
        const sourceId = String(row["source_id"]);
        const targetId = String(row["target_id"]);
        const edge: Row =
          edgeKind === "authored-change"
            ? {
                kind: edgeKind,
                from: { kind: "work-unit", workUnitId: change.workUnitId },
                to: { kind: "change", changeId },
              }
            : edgeKind === "realizes-change"
              ? {
                  kind: edgeKind,
                  from: { kind: "applied-change", appliedChangeId: sourceId },
                  to: { kind: "change", changeId },
                }
              : edgeKind === "decides-change"
                ? {
                    kind: edgeKind,
                    from: { kind: "decision", decisionId: sourceId },
                    to: { kind: "change", changeId },
                  }
                : edgeKind === "incorporates-change"
                  ? {
                      kind: edgeKind,
                      from: { kind: "work-unit", workUnitId: sourceId },
                      to: { kind: "change", changeId },
                    }
                  : edgeKind === "authored-copy-source"
                    ? (() => {
                        const source = JSON.parse(
                          String(row["source_json"])
                        ) as AuthoredCopySourceEndpoint;
                        return {
                          kind: edgeKind,
                          from: { kind: "change", changeId },
                          to: {
                            kind: "file",
                            state: source.state,
                            repositoryId: source.repositoryId,
                            fileId: source.fileId,
                          },
                        };
                      })()
                    : {
                        kind: edgeKind,
                        from: { kind: "change", changeId: sourceId },
                        to: { kind: "change", changeId: targetId },
                      };
        return {
          position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
          edge,
        };
      });
    } else if (kind === "decision") {
      const decisionId = String(node["decisionId"]);
      const decision = this.deps.sql
        .exec(
          `SELECT work_unit_id FROM gad_integration_decisions WHERE decision_id = ?`,
          decisionId
        )
        .toArray()[0] as Row | undefined;
      if (!decision) {
        throw new SemanticVcsError("InvalidReference", `Unknown decision ${decisionId}`);
      }
      const rows = this.deps.sql
        .exec(
          `SELECT edge_group, sort_key, edge_kind, target_id FROM (
             SELECT 0 AS edge_group, '' AS sort_key, 'records-decision' AS edge_kind,
                    work_unit_id AS target_id
               FROM gad_integration_decisions WHERE decision_id = ?
             UNION ALL
             SELECT 1, change_id, 'decides-change', change_id
               FROM gad_decision_source_changes WHERE decision_id = ?
           ) adjacency
           WHERE edge_group > ?
              OR (edge_group = ? AND (? IS NULL OR sort_key > ?))
           ORDER BY edge_group, sort_key, target_id LIMIT ?`,
          decisionId,
          decisionId,
          after.phase,
          after.phase,
          after.key,
          after.key,
          limit
        )
        .toArray() as Row[];
      return rows.map((row) => {
        const edgeKind = String(row["edge_kind"]);
        const targetId = String(row["target_id"]);
        return {
          position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
          edge:
            edgeKind === "records-decision"
              ? {
                  kind: edgeKind,
                  from: { kind: "work-unit", workUnitId: targetId },
                  to: { kind: "decision", decisionId },
                }
              : {
                  kind: edgeKind,
                  from: { kind: "decision", decisionId },
                  to: { kind: "change", changeId: targetId },
                },
        };
      });
    } else if (kind === "command") {
      const commandId = String(node["commandId"]);
      const command = this.deps.sql
        .exec(
          `SELECT cause_log_id, cause_head, cause_invocation_id
             FROM vcs_command_journal WHERE command_id = ? LIMIT 1`,
          commandId
        )
        .toArray()[0] as Row | undefined;
      if (!command) throw new SemanticVcsError("InvalidReference", `Unknown command ${commandId}`);
      const rows = this.deps.sql
        .exec(
          `SELECT edge_group, sort_key, edge_kind, target_id,
                  cause_log_id, cause_head, cause_invocation_id FROM (
             SELECT 0 AS edge_group, work_unit_id AS sort_key, 'work-unit' AS edge_kind,
                    work_unit_id AS target_id, NULL AS cause_log_id, NULL AS cause_head,
                    NULL AS cause_invocation_id
               FROM gad_work_units WHERE command_id = ?
             UNION ALL
             SELECT 1, event_id, 'event', event_id, NULL, NULL, NULL
               FROM gad_workspace_events WHERE command_id = ?
             UNION ALL
             SELECT 2, cause_log_id || ':' || cause_head || ':' || cause_invocation_id,
                    'trajectory-invocation', cause_invocation_id,
                    cause_log_id, cause_head, cause_invocation_id
               FROM vcs_command_journal
              WHERE command_id = ? AND cause_invocation_id IS NOT NULL
           ) adjacency
           WHERE edge_group > ?
              OR (edge_group = ? AND (? IS NULL OR sort_key > ?))
           ORDER BY edge_group, sort_key, target_id LIMIT ?`,
          commandId,
          commandId,
          commandId,
          after.phase,
          after.phase,
          after.key,
          after.key,
          limit
        )
        .toArray() as Row[];
      return rows.map((row) => {
        const targetKind = String(row["edge_kind"]);
        const targetId = String(row["target_id"]);
        return {
          position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
          edge:
            targetKind === "work-unit"
              ? {
                  kind: "caused-by",
                  from: { kind: "work-unit", workUnitId: targetId },
                  to: { kind: "command", commandId },
                }
              : targetKind === "event"
                ? {
                    kind: "caused-by",
                    from: { kind: "event", eventId: targetId },
                    to: { kind: "command", commandId },
                  }
                : {
                    kind: "caused-by",
                    from: { kind: "command", commandId },
                    to: {
                      kind: "trajectory-invocation",
                      logId: String(row["cause_log_id"]),
                      head: String(row["cause_head"]),
                      invocationId: String(row["cause_invocation_id"]),
                    },
                  },
        };
      });
    } else if (kind === "trajectory-invocation") {
      const invocation = {
        kind: "trajectory-invocation",
        logId: node["logId"],
        head: node["head"],
        invocationId: node["invocationId"],
      };
      const invocationRow = this.deps.sql
        .exec(
          `SELECT turn_id FROM trajectory_invocations
            WHERE log_id = ? AND head = ? AND invocation_id = ? LIMIT 1`,
          String(node["logId"]),
          String(node["head"]),
          String(node["invocationId"])
        )
        .toArray()[0] as Row | undefined;
      if (!invocationRow) {
        throw new SemanticVcsError("InvalidReference", "Unknown trajectory invocation");
      }
      const rows = this.deps.sql
        .exec(
          `SELECT edge_group, sort_key, edge_kind, target_id FROM (
             SELECT 0 AS edge_group, '' AS sort_key, 'part-of-trajectory' AS edge_kind,
                    invocation_id AS target_id
               FROM trajectory_invocations
              WHERE log_id = ? AND head = ? AND invocation_id = ?
             UNION ALL
             SELECT 1, turn_id, 'part-of-turn', turn_id
               FROM trajectory_invocations
              WHERE log_id = ? AND head = ? AND invocation_id = ? AND turn_id IS NOT NULL
             UNION ALL
             SELECT 2, command_id, 'caused-by', command_id
               FROM vcs_command_journal
              WHERE cause_log_id = ? AND cause_head = ? AND cause_invocation_id = ?
           ) adjacency
           WHERE edge_group > ?
              OR (edge_group = ? AND (? IS NULL OR sort_key > ?))
           ORDER BY edge_group, sort_key, target_id LIMIT ?`,
          String(node["logId"]),
          String(node["head"]),
          String(node["invocationId"]),
          String(node["logId"]),
          String(node["head"]),
          String(node["invocationId"]),
          String(node["logId"]),
          String(node["head"]),
          String(node["invocationId"]),
          after.phase,
          after.phase,
          after.key,
          after.key,
          limit
        )
        .toArray() as Row[];
      return rows.map((row) => {
        const edgeKind = String(row["edge_kind"]);
        const targetId = String(row["target_id"]);
        return {
          position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
          edge:
            edgeKind === "part-of-trajectory"
              ? {
                  kind: edgeKind,
                  from: invocation,
                  to: { kind: "trajectory", logId: node["logId"], head: node["head"] },
                }
              : edgeKind === "part-of-turn"
                ? {
                    kind: edgeKind,
                    from: invocation,
                    to: {
                      kind: "trajectory-turn",
                      logId: node["logId"],
                      head: node["head"],
                      turnId: targetId,
                    },
                  }
                : {
                    kind: edgeKind,
                    from: { kind: "command", commandId: targetId },
                    to: invocation,
                  },
        };
      });
    } else if (kind === "trajectory-turn") {
      const turn = {
        kind: "trajectory-turn",
        logId: node["logId"],
        head: node["head"],
        turnId: node["turnId"],
      };
      const turnRow = this.deps.sql
        .exec(
          `SELECT trigger_message_id FROM trajectory_turns
            WHERE log_id = ? AND head = ? AND turn_id = ? LIMIT 1`,
          String(node["logId"]),
          String(node["head"]),
          String(node["turnId"])
        )
        .toArray()[0] as Row | undefined;
      if (!turnRow) throw new SemanticVcsError("InvalidReference", "Unknown trajectory turn");
      const rows = this.deps.sql
        .exec(
          `SELECT edge_group, sort_key, edge_kind, target_id FROM (
             SELECT 0 AS edge_group, '' AS sort_key, 'part-of-trajectory' AS edge_kind,
                    turn_id AS target_id
               FROM trajectory_turns WHERE log_id = ? AND head = ? AND turn_id = ?
             UNION ALL
             SELECT 1, trigger_message_id, 'triggered-by', trigger_message_id
               FROM trajectory_turns
              WHERE log_id = ? AND head = ? AND turn_id = ? AND trigger_message_id IS NOT NULL
             UNION ALL
             SELECT 2, invocation_id, 'part-of-turn', invocation_id
               FROM trajectory_invocations WHERE log_id = ? AND head = ? AND turn_id = ?
             UNION ALL
             SELECT 3, message_id, 'turn-message', message_id
               FROM trajectory_messages WHERE log_id = ? AND head = ? AND turn_id = ?
           ) adjacency
           WHERE edge_group > ?
              OR (edge_group = ? AND (? IS NULL OR sort_key > ?))
           ORDER BY edge_group, sort_key, target_id LIMIT ?`,
          String(node["logId"]),
          String(node["head"]),
          String(node["turnId"]),
          String(node["logId"]),
          String(node["head"]),
          String(node["turnId"]),
          String(node["logId"]),
          String(node["head"]),
          String(node["turnId"]),
          String(node["logId"]),
          String(node["head"]),
          String(node["turnId"]),
          after.phase,
          after.phase,
          after.key,
          after.key,
          limit
        )
        .toArray() as Row[];
      return rows.map((row) => {
        const edgeKind = String(row["edge_kind"]);
        const targetId = String(row["target_id"]);
        return {
          position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
          edge:
            edgeKind === "part-of-trajectory"
              ? {
                  kind: edgeKind,
                  from: turn,
                  to: { kind: "trajectory", logId: node["logId"], head: node["head"] },
                }
              : edgeKind === "triggered-by"
                ? {
                    kind: edgeKind,
                    from: turn,
                    to: {
                      kind: "trajectory-message",
                      logId: node["logId"],
                      head: node["head"],
                      messageId: targetId,
                    },
                  }
                : edgeKind === "part-of-turn"
                  ? {
                      kind: edgeKind,
                      from: {
                        kind: "trajectory-invocation",
                        logId: node["logId"],
                        head: node["head"],
                        invocationId: targetId,
                      },
                      to: turn,
                    }
                  : {
                      kind: "part-of-turn",
                      from: {
                        kind: "trajectory-message",
                        logId: node["logId"],
                        head: node["head"],
                        messageId: targetId,
                      },
                      to: turn,
                    },
        };
      });
    } else if (kind === "trajectory-message") {
      const message = {
        kind: "trajectory-message",
        logId: node["logId"],
        head: node["head"],
        messageId: node["messageId"],
      };
      const messageRow = this.deps.sql
        .exec(
          `SELECT turn_id FROM trajectory_messages
            WHERE log_id = ? AND head = ? AND message_id = ? LIMIT 1`,
          String(node["logId"]),
          String(node["head"]),
          String(node["messageId"])
        )
        .toArray()[0] as Row | undefined;
      if (!messageRow) {
        throw new SemanticVcsError("InvalidReference", "Unknown trajectory message");
      }
      const rows = this.deps.sql
        .exec(
          `SELECT edge_group, sort_key, edge_kind, target_id FROM (
             SELECT 0 AS edge_group, '' AS sort_key, 'part-of-trajectory' AS edge_kind,
                    message_id AS target_id
               FROM trajectory_messages WHERE log_id = ? AND head = ? AND message_id = ?
             UNION ALL
             SELECT 1, turn_id, 'part-of-turn', turn_id
               FROM trajectory_messages
              WHERE log_id = ? AND head = ? AND message_id = ? AND turn_id IS NOT NULL
             UNION ALL
             SELECT 2, turn_id, 'triggered-by', turn_id
               FROM trajectory_turns
              WHERE log_id = ? AND head = ? AND trigger_message_id = ?
           ) adjacency
           WHERE edge_group > ?
              OR (edge_group = ? AND (? IS NULL OR sort_key > ?))
           ORDER BY edge_group, sort_key, target_id LIMIT ?`,
          String(node["logId"]),
          String(node["head"]),
          String(node["messageId"]),
          String(node["logId"]),
          String(node["head"]),
          String(node["messageId"]),
          String(node["logId"]),
          String(node["head"]),
          String(node["messageId"]),
          after.phase,
          after.phase,
          after.key,
          after.key,
          limit
        )
        .toArray() as Row[];
      return rows.map((row) => {
        const edgeKind = String(row["edge_kind"]);
        const targetId = String(row["target_id"]);
        return {
          position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
          edge:
            edgeKind === "part-of-trajectory"
              ? {
                  kind: edgeKind,
                  from: message,
                  to: { kind: "trajectory", logId: node["logId"], head: node["head"] },
                }
              : edgeKind === "part-of-turn"
                ? {
                    kind: edgeKind,
                    from: message,
                    to: {
                      kind: "trajectory-turn",
                      logId: node["logId"],
                      head: node["head"],
                      turnId: targetId,
                    },
                  }
                : {
                    kind: edgeKind,
                    from: {
                      kind: "trajectory-turn",
                      logId: node["logId"],
                      head: node["head"],
                      turnId: targetId,
                    },
                    to: message,
                  },
        };
      });
    } else if (kind === "trajectory") {
      const trajectory = { kind: "trajectory", logId: node["logId"], head: node["head"] };
      const members = this.deps.sql
        .exec(
          `SELECT edge_group, sort_key, member_kind, member_id FROM (
             SELECT 0 AS edge_group, invocation_id AS sort_key,
                    'trajectory-invocation' AS member_kind, invocation_id AS member_id
               FROM trajectory_invocations WHERE log_id = ? AND head = ?
             UNION ALL
             SELECT 1, message_id, 'trajectory-message', message_id
               FROM trajectory_messages WHERE log_id = ? AND head = ?
             UNION ALL
             SELECT 2, turn_id, 'trajectory-turn', turn_id
               FROM trajectory_turns WHERE log_id = ? AND head = ?
           ) adjacency
           WHERE edge_group > ?
              OR (edge_group = ? AND (? IS NULL OR sort_key > ?))
           ORDER BY edge_group, sort_key, member_id LIMIT ?`,
          String(node["logId"]),
          String(node["head"]),
          String(node["logId"]),
          String(node["head"]),
          String(node["logId"]),
          String(node["head"]),
          after.phase,
          after.phase,
          after.key,
          after.key,
          limit
        )
        .toArray() as Row[];
      return members.map((row) => ({
        position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
        edge: {
          kind: "part-of-trajectory",
          from:
            row["member_kind"] === "trajectory-invocation"
              ? {
                  kind: "trajectory-invocation",
                  logId: node["logId"],
                  head: node["head"],
                  invocationId: String(row["member_id"]),
                }
              : row["member_kind"] === "trajectory-message"
                ? {
                    kind: "trajectory-message",
                    logId: node["logId"],
                    head: node["head"],
                    messageId: String(row["member_id"]),
                  }
                : {
                    kind: "trajectory-turn",
                    logId: node["logId"],
                    head: node["head"],
                    turnId: String(row["member_id"]),
                  },
          to: trajectory,
        },
      }));
    } else if (kind === "file") {
      const state = node["state"] as StateNodeRef;
      const fileId = String(node["fileId"]);
      const point = this.deps.store.facts.file(this.deps.store.stateRoot(state), fileId);
      if (!point) throw new SemanticVcsError("InvalidReference", `Unknown file ${fileId}`);
      const repositoryId = String(node["repositoryId"]);
      if (point.repository.repositoryId !== repositoryId) {
        throw new SemanticVcsError("InvalidReference", `File ${fileId} is not in ${repositoryId}`);
      }
      const file = { kind: "file", state, repositoryId, fileId } as const;
      const edges: PositionedNeighborEdge[] = [];
      if (point.state.presence === "placed" && after.phase === 0 && after.key === null) {
        edges.push({
          position: { phase: 0, key: "" },
          edge: { kind: "places-file", from: state, to: file },
        });
      }
      if (edges.length >= limit || after.phase > 1) return edges;
      const [stateKind, stateId] =
        state.kind === "event"
          ? (["event", state.eventId] as const)
          : (["application", state.applicationId] as const);
      const rows = this.deps.sql
        .exec(
          `SELECT change_id AS sort_key, change_id
             FROM gad_changes
            WHERE source_json IS NOT NULL
              AND json_extract(source_json, '$.state.kind') = ?
              AND coalesce(
                    json_extract(source_json, '$.state.eventId'),
                    json_extract(source_json, '$.state.applicationId')
                  ) = ?
              AND json_extract(source_json, '$.repositoryId') = ?
              AND json_extract(source_json, '$.fileId') = ?
              AND (? IS NULL OR change_id > ?)
            ORDER BY sort_key, change_id LIMIT ?`,
          stateKind,
          stateId,
          repositoryId,
          fileId,
          after.phase === 1 ? after.key : null,
          after.phase === 1 ? after.key : null,
          limit - edges.length
        )
        .toArray() as Row[];
      edges.push(
        ...rows.map((row) => ({
          position: { phase: 1, key: String(row["sort_key"]) },
          edge: {
            kind: "authored-copy-source",
            from: { kind: "change", changeId: String(row["change_id"]) },
            to: file,
          },
        }))
      );
      return edges;
    } else if (kind === "repository") {
      const state = node["state"] as StateNodeRef;
      const repositoryId = String(node["repositoryId"]);
      const member = this.deps.store.facts.member(this.deps.store.stateRoot(state), repositoryId);
      if (!member) {
        throw new SemanticVcsError("InvalidReference", `Unknown repository ${repositoryId}`);
      }
      const repository = { kind: "repository", state, repositoryId } as const;
      const edges: PositionedNeighborEdge[] = [];
      if (after.phase === 0 && after.key === null) {
        edges.push({
          position: { phase: 0, key: "" },
          edge: { kind: "contains-repository", from: state, to: repository },
        });
      }
      if (edges.length >= limit || after.phase > 1 || state.kind !== "application") return edges;
      const rows = this.deps.sql
        .exec(
          `SELECT work.work_unit_id AS sort_key, work.work_unit_id
             FROM gad_work_unit_applications application
             JOIN gad_work_units work ON work.work_unit_id = application.work_unit_id
             JOIN json_each(work.external_snapshot_json, '$.targetRepositoryIds') target
            WHERE application.application_id = ?
              AND CAST(target.value AS TEXT) = ?
              AND (? IS NULL OR work.work_unit_id > ?)
            ORDER BY sort_key, work.work_unit_id LIMIT ?`,
          state.applicationId,
          repositoryId,
          after.phase === 1 ? after.key : null,
          after.phase === 1 ? after.key : null,
          limit - edges.length
        )
        .toArray() as Row[];
      edges.push(
        ...rows.map((row) => ({
          position: { phase: 1, key: String(row["sort_key"]) },
          edge: {
            kind: "imports-repository",
            from: { kind: "work-unit", workUnitId: String(row["work_unit_id"]) },
            to: repository,
          },
        }))
      );
      return edges;
    }
    throw new SemanticVcsError("InvalidReference", `Unknown node kind ${kind}`);
  }

  private historyEntries(
    node: Row,
    direction: "past" | "future",
    cursor: string | undefined,
    limit: number
  ): PositionedHistoryEntry[] {
    const after = parseHistoryCursor(cursor, { root: node, direction });
    if (node["kind"] === "file") {
      if (direction !== "past") {
        throw new SemanticVcsError("InvalidReference", "File history is defined toward its past");
      }
      const state = node["state"] as StateNodeRef;
      const fileId = String(node["fileId"]);
      const point = this.deps.store.facts.file(this.deps.store.stateRoot(state), fileId);
      if (!point) throw new SemanticVcsError("InvalidReference", `Unknown file ${fileId}`);
      const rows = this.deps.sql
        .exec(
          `WITH RECURSIVE state_chain(state_kind, state_id, depth) AS (
             SELECT ?, ?, 0
             UNION ALL
             SELECT application.basis_kind, application.basis_id, state_chain.depth + 1
               FROM state_chain
               JOIN gad_work_unit_applications application
                 ON state_chain.state_kind = 'application'
                AND application.application_id = state_chain.state_id
              WHERE state_chain.depth < ?
             UNION ALL
             SELECT 'event', parent.parent_event_id, state_chain.depth + 1
               FROM state_chain
               JOIN gad_workspace_event_parents parent
                 ON state_chain.state_kind = 'event'
                AND parent.event_id = state_chain.state_id
                AND parent.ordinal = 0
              WHERE state_chain.depth < ?
           ), lineage_applications(depth, application_ordinal, application_id) AS (
             SELECT depth, 0, state_id FROM state_chain WHERE state_kind = 'application'
             UNION ALL
             SELECT state_chain.depth, event_application.ordinal,
                    event_application.application_id
               FROM state_chain
               JOIN gad_workspace_event_applications event_application
                 ON state_chain.state_kind = 'event'
                AND event_application.event_id = state_chain.state_id
           ), candidates AS (
             SELECT change.change_id, change.kind, change.work_unit_id, work.created_at,
                    lineage.depth,
                    (SELECT decision.decision_id
                       FROM gad_decision_source_changes source
                       JOIN gad_integration_decisions decision
                         ON decision.decision_id = source.decision_id
                       JOIN gad_work_unit_applications merge_application
                         ON merge_application.work_unit_id = decision.work_unit_id
                      WHERE source.change_id = change.change_id
                        AND merge_application.application_id = lineage.application_id
                      ORDER BY decision.created_at, decision.decision_id
                      LIMIT 1) AS via_decision_id,
                    printf('%020d:%020d:',
                      9223372036854775807 - lineage.application_ordinal,
                      9223372036854775807 - applied.ordinal) || change.change_id AS sort_key,
                    ROW_NUMBER() OVER (
                      PARTITION BY change.change_id
                      ORDER BY lineage.depth, lineage.application_ordinal DESC,
                               applied.ordinal DESC, change.change_id
                    ) AS occurrence
               FROM lineage_applications lineage
               JOIN gad_applied_changes applied
                 ON applied.application_id = lineage.application_id
               JOIN gad_changes change ON change.change_id = applied.change_id
               JOIN gad_change_coordinates coordinate
                 ON coordinate.change_id = change.change_id AND coordinate.file_id = ?
               JOIN gad_work_units work ON work.work_unit_id = change.work_unit_id
           )
           SELECT change_id, kind, work_unit_id, created_at, depth, sort_key, via_decision_id
             FROM candidates
            WHERE occurrence = 1
              AND (depth > ? OR (depth = ? AND (? IS NULL OR sort_key > ?)))
            ORDER BY depth, sort_key
            LIMIT ?`,
          state.kind,
          state.kind === "event" ? state.eventId : state.applicationId,
          MAX_ANCESTRY_EDGES,
          MAX_ANCESTRY_EDGES,
          fileId,
          after.phase,
          after.phase,
          after.key,
          after.key,
          limit
        )
        .toArray() as Row[];
      return rows.map((row) => {
        const changeId = String(row["change_id"]);
        return {
          position: { phase: Number(row["depth"]), key: String(row["sort_key"]) },
          entry: {
            node: { kind: "change", changeId },
            createdAt: String(row["created_at"]),
            summary: String(row["kind"]),
            intent: this.intentForWorkUnit(String(row["work_unit_id"])),
            ...(row["via_decision_id"] == null
              ? {}
              : { viaDecisionId: String(row["via_decision_id"]) }),
          },
        };
      });
    }
    if (node["kind"] !== "event") {
      throw new SemanticVcsError("InvalidReference", "History requires an event or file root");
    }
    const eventId = String(node["eventId"]);
    if (!this.deps.store.event(eventId)) {
      throw new SemanticVcsError("InvalidReference", `Unknown event ${eventId}`);
    }
    const rows = this.deps.sql
      .exec(
        direction === "past"
          ? `WITH RECURSIVE history(event_id, depth) AS (
               SELECT ?, 0
               UNION
               SELECT parent.parent_event_id, history.depth + 1
                 FROM history
                 JOIN gad_workspace_event_parents parent
                   ON parent.event_id = history.event_id
                WHERE history.depth < ?
             ), nearest(event_id, depth) AS (
               SELECT event_id, MIN(depth) FROM history GROUP BY event_id
             )
             SELECT event.event_id, nearest.depth, event.created_at, event.message, event.kind
               FROM nearest JOIN gad_workspace_events event ON event.event_id = nearest.event_id
              WHERE nearest.depth > ?
                 OR (nearest.depth = ? AND (? IS NULL OR nearest.event_id > ?))
              ORDER BY nearest.depth, nearest.event_id LIMIT ?`
          : `WITH RECURSIVE history(event_id, depth) AS (
               SELECT ?, 0
               UNION
               SELECT child.event_id, history.depth + 1
                 FROM history
                 JOIN gad_workspace_event_parents child
                   ON child.parent_event_id = history.event_id
                WHERE history.depth < ?
             ), nearest(event_id, depth) AS (
               SELECT event_id, MIN(depth) FROM history GROUP BY event_id
             )
             SELECT event.event_id, nearest.depth, event.created_at, event.message, event.kind
               FROM nearest JOIN gad_workspace_events event ON event.event_id = nearest.event_id
              WHERE nearest.depth > ?
                 OR (nearest.depth = ? AND (? IS NULL OR nearest.event_id > ?))
              ORDER BY nearest.depth, nearest.event_id LIMIT ?`,
        eventId,
        MAX_ANCESTRY_EDGES,
        after.phase,
        after.phase,
        after.key,
        after.key,
        limit
      )
      .toArray() as Row[];
    return rows.map((row) => ({
      position: { phase: Number(row["depth"]), key: String(row["event_id"]) },
      entry: {
        node: { kind: "event", eventId: String(row["event_id"]) },
        createdAt: String(row["created_at"]),
        summary: row["message"] == null ? String(row["kind"]) : String(row["message"]),
      },
    }));
  }

  private traceBlameRange(
    appliedChangeId: string,
    segment: {
      rootStart: number;
      rootEnd: number;
      currentStart: number;
      currentEnd: number;
      coordinateKind: "utf16" | "byte";
      path: Row[];
      visited: Set<string>;
    },
    maximumSpans: number
  ): Row[] {
    if (maximumSpans <= 0) return [];
    if (segment.path.length >= 200) {
      throw new SemanticVcsError("ScopeTooLarge", "Blame lineage exceeds its edge bound", {
        maximum: 200,
      });
    }
    const visit = `${appliedChangeId}:${segment.currentStart}:${segment.currentEnd}`;
    if (segment.visited.has(visit)) {
      throw new SemanticVcsError("IntegrityFailure", "Content lineage contains a cycle");
    }
    const visited = new Set(segment.visited).add(visit);
    const current = this.appliedChangeMetadata(appliedChangeId);
    const routes: Array<{
      relation: "preserves-content" | "copies-content" | "incorporates-content";
      parentAppliedChangeId: string;
      mappings: ContentMapping[];
    }> = [];
    const contentEdges = this.deps.sql
      .exec(
        `SELECT content_edge_id, parent_applied_change_id, relation
           FROM gad_content_edges
          WHERE child_applied_change_id = ?
          ORDER BY content_edge_id`,
        appliedChangeId
      )
      .toArray() as Row[];
    for (const edge of contentEdges) {
      routes.push({
        relation:
          edge["relation"] === "incorporates"
            ? "incorporates-content"
            : edge["relation"] === "copies"
              ? "copies-content"
              : "preserves-content",
        parentAppliedChangeId: String(edge["parent_applied_change_id"]),
        mappings: this.contentMappings(String(edge["content_edge_id"])),
      });
    }

    const routed: Array<{
      childStart: number;
      childEnd: number;
      parentStart: number;
      parentEnd: number;
      route: (typeof routes)[number];
    }> = [];
    for (const route of routes) {
      for (const mapping of route.mappings) {
        if (mapping.coordinateKind !== segment.coordinateKind) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Content mapping ${mapping.digest} uses the wrong coordinate space`
          );
        }
        const childStart = Math.max(segment.currentStart, mapping.childStart);
        const childEnd = Math.min(segment.currentEnd, mapping.childEnd);
        if (childStart >= childEnd) continue;
        if (mapping.childEnd - mapping.childStart !== mapping.parentEnd - mapping.parentStart) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Content mapping ${mapping.digest} changes coordinate length`
          );
        }
        const parentStart = mapping.parentStart + childStart - mapping.childStart;
        routed.push({
          childStart,
          childEnd,
          parentStart,
          parentEnd: parentStart + childEnd - childStart,
          route,
        });
      }
    }
    routed.sort(
      (left, right) => left.childStart - right.childStart || left.childEnd - right.childEnd
    );
    for (let index = 1; index < routed.length; index += 1) {
      if (routed[index]!.childStart < routed[index - 1]!.childEnd) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Applied change ${appliedChangeId} has overlapping blame routes`
        );
      }
    }
    const importTerminal = current.workKind === "import";
    const terminal = (start: number, end: number): Row => ({
      start: segment.rootStart + (start - segment.currentStart),
      end: segment.rootStart + (end - segment.currentStart),
      change: { kind: "change", changeId: current.changeId },
      appliedChange: {
        kind: "applied-change",
        appliedChangeId: current.appliedChangeId,
      },
      workUnit: { kind: "work-unit", workUnitId: current.workUnitId },
      command: { kind: "command", commandId: current.commandId },
      path: segment.path,
      stop: importTerminal ? "import-boundary" : "authored",
    });
    if (routed.length === 0) return [terminal(segment.currentStart, segment.currentEnd)];
    const result: Row[] = [];
    let cursor = segment.currentStart;
    for (const route of routed) {
      if (cursor < route.childStart) {
        result.push(terminal(cursor, route.childStart));
        if (result.length >= maximumSpans) return result;
      }
      const parent = this.appliedChangeMetadata(route.route.parentAppliedChangeId);
      const rootStart = segment.rootStart + route.childStart - segment.currentStart;
      result.push(
        ...this.traceBlameRange(
          route.route.parentAppliedChangeId,
          {
            rootStart,
            rootEnd: rootStart + route.childEnd - route.childStart,
            currentStart: route.parentStart,
            currentEnd: route.parentEnd,
            coordinateKind: segment.coordinateKind,
            path: [
              ...segment.path,
              {
                kind: route.route.relation,
                from: {
                  kind: "applied-change",
                  appliedChangeId: current.appliedChangeId,
                },
                to: {
                  kind: "applied-change",
                  appliedChangeId: parent.appliedChangeId,
                },
              },
            ],
            visited,
          },
          maximumSpans - result.length
        )
      );
      if (result.length >= maximumSpans) return result;
      cursor = route.childEnd;
    }
    if (cursor < segment.currentEnd && result.length < maximumSpans) {
      result.push(terminal(cursor, segment.currentEnd));
    }
    return result;
  }

  private appliedChangeMetadata(appliedChangeId: string): {
    appliedChangeId: string;
    changeId: string;
    workUnitId: string;
    commandId: string;
    kind: string;
    workKind: string;
  } {
    const row = this.deps.sql
      .exec(
        `SELECT applied.applied_change_id, change.change_id, change.kind,
                change.work_unit_id, work.command_id, work.kind AS work_kind
           FROM gad_applied_changes applied
           JOIN gad_changes change ON change.change_id = applied.change_id
           JOIN gad_work_units work ON work.work_unit_id = change.work_unit_id
          WHERE applied.applied_change_id = ?`,
        appliedChangeId
      )
      .toArray()[0] as Row | undefined;
    if (!row) {
      throw new SemanticVcsError(
        "IntegrityFailure",
        `Content lineage reaches missing applied change ${appliedChangeId}`
      );
    }
    return {
      appliedChangeId,
      changeId: String(row["change_id"]),
      workUnitId: String(row["work_unit_id"]),
      commandId: String(row["command_id"]),
      kind: String(row["kind"]),
      workKind: String(row["work_kind"]),
    };
  }

  private contentEndpoint(endpoint: Row | null): ContentEndpoint | null {
    if (
      endpoint?.["kind"] !== "file" ||
      typeof endpoint["fileId"] !== "string" ||
      typeof endpoint["contentHash"] !== "string" ||
      (endpoint["contentKind"] !== "text" && endpoint["contentKind"] !== "bytes") ||
      typeof endpoint["coordinateExtent"] !== "number"
    ) {
      return null;
    }
    return {
      fileId: endpoint["fileId"],
      contentHash: endpoint["contentHash"],
      coordinateKind: endpoint["contentKind"] === "text" ? "utf16" : "byte",
      coordinateExtent: endpoint["coordinateExtent"],
    };
  }

  private appliedContentEndpoint(appliedChangeId: string): ContentEndpoint | null {
    const row = this.deps.sql
      .exec(
        `SELECT applied_base_json, applied_result_json
           FROM gad_applied_changes WHERE applied_change_id = ?`,
        appliedChangeId
      )
      .toArray()[0] as Row | undefined;
    if (!row) {
      throw new SemanticVcsError(
        "IntegrityFailure",
        `Missing applied change ${appliedChangeId} while deriving content lineage`
      );
    }
    const result =
      row["applied_result_json"] == null
        ? null
        : (JSON.parse(String(row["applied_result_json"])) as Row);
    const base =
      row["applied_base_json"] == null
        ? null
        : (JSON.parse(String(row["applied_base_json"])) as Row);
    return this.contentEndpoint(result) ?? this.contentEndpoint(base);
  }

  private contentMappings(contentEdgeId: string): ContentMapping[] {
    return (
      this.deps.sql
        .exec(
          `SELECT coordinate_kind, child_content_hash, child_start, child_end,
                  parent_content_hash, parent_start, parent_end, digest
             FROM gad_content_edge_mappings WHERE content_edge_id = ? ORDER BY ordinal`,
          contentEdgeId
        )
        .toArray() as Row[]
    ).map(contentMappingFromRow);
  }

  /** A text counteraction restores the original base bytes, so its exact
   * unchanged-coordinate lineage is the original text edge in reverse. The
   * original edge is durable semantic evidence; reconstructing edit text or
   * diffing blobs here would create a second, weaker source of truth. */
  private invertedCounteractionMappings(
    counteractedChangeIds: readonly string[],
    child: {
      contentHash: string;
      coordinateKind: "utf16" | "byte";
      coordinateExtent: number;
    },
    parent: {
      contentHash: string;
      coordinateKind: "utf16" | "byte";
      coordinateExtent: number;
    }
  ): ContentMapping[] {
    if (counteractedChangeIds.length !== 1) {
      throw new SemanticVcsError(
        "IntegrityFailure",
        "A text counteraction must name exactly one original change"
      );
    }
    const row = this.deps.sql
      .exec(
        `SELECT edge.content_edge_id
           FROM gad_content_edges edge
           JOIN gad_applied_changes applied
             ON applied.applied_change_id = edge.child_applied_change_id
          WHERE applied.change_id = ?
            AND edge.relation = 'incorporates'
            AND json_extract(applied.applied_result_json, '$.contentHash') = ?
            AND json_extract(applied.applied_base_json, '$.contentHash') = ?
          ORDER BY edge.content_edge_id
          LIMIT 1`,
        counteractedChangeIds[0],
        parent.contentHash,
        child.contentHash
      )
      .toArray()[0] as Row | undefined;
    if (!row) {
      throw new SemanticVcsError(
        "IntegrityFailure",
        `Counteracted text change ${counteractedChangeIds[0]} has no exact content lineage`
      );
    }
    return this.contentMappings(String(row["content_edge_id"])).map((mapping) => {
      if (
        mapping.coordinateKind !== child.coordinateKind ||
        mapping.coordinateKind !== parent.coordinateKind ||
        mapping.childContentHash !== parent.contentHash ||
        mapping.parentContentHash !== child.contentHash
      ) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Counteracted text change ${counteractedChangeIds[0]} has mismatched content lineage`
        );
      }
      return contentMapping({
        coordinateKind: mapping.coordinateKind,
        childContentHash: mapping.parentContentHash,
        childStart: mapping.parentStart,
        childEnd: mapping.parentEnd,
        parentContentHash: mapping.childContentHash,
        parentStart: mapping.childStart,
        parentEnd: mapping.childEnd,
      });
    });
  }

  /**
   * Resolve the latest exact applied change for a file set in one ancestry
   * query. Semantic mutations use the same result for integrity classification
   * and content-parent derivation, avoiding thousands of serialized SQL calls.
   * Ordering is unchanged: newest application, then newest applied change
   * within that application.
   */
  private latestAppliedChangesForFiles(
    state: StateNodeRef,
    fileIds: readonly string[]
  ): Map<string, LatestAppliedFileChange> {
    if (fileIds.length === 0) return new Map();
    const applications = this.firstParentLineage(state).applicationIds;
    const rows = this.deps.sql
      .exec(
        `WITH selected_applications AS (
           SELECT CAST(key AS INTEGER) AS application_ordinal,
                  CAST(value AS TEXT) AS application_id
             FROM json_each(?)
         ),
         selected_files AS (
           SELECT CAST(value AS TEXT) AS file_id FROM json_each(?)
         ),
         candidates AS (
           SELECT coordinate.file_id, applied.applied_change_id,
                  applied.applied_base_json, applied.applied_result_json, applied.ordinal,
                  selected.application_ordinal, change.change_id, change.kind,
                  change.work_unit_id, work.command_id, work.content_class,
                  work.external_lineage_json
             FROM selected_applications selected
             JOIN gad_applied_changes applied
               ON applied.application_id = selected.application_id
             JOIN gad_changes change ON change.change_id = applied.change_id
             JOIN gad_work_units work ON work.work_unit_id = change.work_unit_id
             JOIN gad_change_coordinates coordinate ON coordinate.change_id = change.change_id
             JOIN selected_files file ON file.file_id = coordinate.file_id
           UNION
           SELECT CAST(json_extract(predicate.predicate_json, '$.fileId') AS TEXT),
                  applied.applied_change_id, applied.applied_base_json,
                  applied.applied_result_json, applied.ordinal,
                  selected.application_ordinal, change.change_id, change.kind,
                  change.work_unit_id, work.command_id, work.content_class,
                  work.external_lineage_json
             FROM selected_applications selected
             JOIN gad_applied_changes applied
               ON applied.application_id = selected.application_id
             JOIN gad_changes change ON change.change_id = applied.change_id
             JOIN gad_work_units work ON work.work_unit_id = change.work_unit_id
             JOIN gad_applied_change_predicates predicate
               ON predicate.applied_change_id = applied.applied_change_id
             JOIN selected_files file
               ON file.file_id =
                  CAST(json_extract(predicate.predicate_json, '$.fileId') AS TEXT)
         ),
         ranked AS (
           SELECT *,
                  ROW_NUMBER() OVER (
                    PARTITION BY file_id
                    ORDER BY application_ordinal DESC, ordinal DESC
                  ) AS lineage_rank
             FROM candidates
         )
         SELECT file_id, applied_change_id, applied_base_json, applied_result_json,
                change_id, kind, work_unit_id, command_id, content_class,
                external_lineage_json
           FROM ranked
          WHERE lineage_rank = 1`,
        canonicalJson(applications),
        canonicalJson([...new Set(fileIds)])
      )
      .toArray() as Row[];
    const result = new Map<string, LatestAppliedFileChange>();
    for (const row of rows) {
      const fileId = String(row["file_id"]);
      const contentClass = row["content_class"];
      if (contentClass !== "internal" && contentClass !== "external") {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `File ${fileId} has no valid persisted content class`
        );
      }
      const externalKeys = JSON.parse(String(row["external_lineage_json"]));
      if (!Array.isArray(externalKeys) || !externalKeys.every((key) => typeof key === "string")) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `File ${fileId} has invalid persisted external lineage`
        );
      }
      const appliedResult =
        row["applied_result_json"] == null
          ? null
          : (JSON.parse(String(row["applied_result_json"])) as Row);
      const appliedBase =
        row["applied_base_json"] == null
          ? null
          : (JSON.parse(String(row["applied_base_json"])) as Row);
      result.set(fileId, {
        fileId,
        appliedChangeId: String(row["applied_change_id"]),
        changeId: String(row["change_id"]),
        workUnitId: String(row["work_unit_id"]),
        commandId: String(row["command_id"]),
        kind: String(row["kind"]),
        contentClass,
        externalKeys,
        content: this.contentEndpoint(appliedResult) ?? this.contentEndpoint(appliedBase),
      });
    }
    return result;
  }

  private latestAppliedChangeForFile(
    state: StateNodeRef,
    fileId: string
  ): LatestAppliedFileChange | null {
    return this.latestAppliedChangesForFiles(state, [fileId]).get(fileId) ?? null;
  }
}

function readApplicationChain(sql: SqlStorage, tail: string, max: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let current: string | null = tail;
  while (current) {
    if (result.length >= max)
      throw new SemanticVcsError("ScopeTooLarge", "Application chain is too large");
    if (seen.has(current))
      throw new SemanticVcsError("IntegrityFailure", "Application chain is cyclic");
    seen.add(current);
    result.push(current);
    const row = sql
      .exec(
        `SELECT basis_kind, basis_id FROM gad_work_unit_applications WHERE application_id = ?`,
        current
      )
      .toArray()[0] as Row | undefined;
    if (!row) throw new SemanticVcsError("IntegrityFailure", `Missing application ${current}`);
    current = row["basis_kind"] === "application" ? String(row["basis_id"]) : null;
  }
  return result.reverse();
}
