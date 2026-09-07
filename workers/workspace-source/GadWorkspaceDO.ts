/**
 * Workspace-owned semantic authority.
 *
 * The flattened workspace manifest owns its logical singleton coordinate.
 * The host recognizes only the workspace-source protocol and seals this
 * worker's receiver authority into the exact activated build.
 */
import { rpc, schemaRpc } from "@vibestudio/rpc";
import type { MethodSchema } from "@vibestudio/shared/typedServiceClient";
import type { DoAlarmSchedule } from "@vibestudio/shared/doDispatcher";
import type {
  ClaimRequest,
  ClaimSettlement,
  DurableWorkQueue,
  SettleRequest,
  WorkClaim,
} from "@vibestudio/shared/durableWork";
import {
  gadWireMethods,
  StoredRegistryMutationInputSchema,
} from "@vibestudio/service-schemas/workspaceSource";
import {
  channelIdFromTrajectoryLog,
  logIdForChannel,
} from "@vibestudio/trajectory-identity";
import { DurableObjectBase } from "@vibestudio/durable";
import type {
  ChannelInvite,
  ChannelMembershipCleanupPlan,
  DeleteChannelInviteInput,
  DeleteChannelMembershipInput,
  PutChannelMembershipInput,
} from "@vibestudio/shared/channelInvites";
import { parseLineageKey } from "@vibestudio/shared/authority/contextIntegrity";
import {
  channelEnvelopePageInfo,
  normalizeChannelEnvelopePageRequest,
  type ChannelEnvelopePage,
  type ChannelEnvelopePageRequest,
} from "@vibestudio/shared/channelEnvelopePaging";
import type {
  AgentDirectoryEntry,
  AgentDirectoryListing,
  ChannelDescription,
  DescribeChannelsInput,
  ListAgentDirectoryInput,
  SearchAgentDirectoryInput,
  AgentHealthInspection,
  ChannelEnvelopeInspection,
  StoredChannelMessageTypeDefinition,
  ChannelRosterInspection,
  EnvelopeLineage,
  InvocationStateInspection,
  InvocationDiagnosticPacket,
  DiagnoseInvocationInput,
  InspectAgentHealthInput,
  InspectChannelRosterInput,
  InspectInvocationStateInput,
  InspectPublicationIntegrityInput,
  InspectStorageDiagnosticsInput,
  InspectTurnStateInput,
  PrivateLineageForPublishedEnvelope,
  PublicationIntegrityInspection,
  PublishedArtifact,
  StoredRegistryMutationInput,
  TurnStateInspection,
  GadJsonRecord,
} from "@vibestudio/service-schemas/workspaceSource";
export type {
  AgentDirectoryEntry,
  AgentDirectoryListing,
  ChannelDescription,
  DescribeChannelsInput,
  ListAgentDirectoryInput,
  SearchAgentDirectoryInput,
  AgentHealthInspection,
  ChannelEnvelopeInspection,
  StoredChannelMessageTypeDefinition,
  ChannelPublication,
  ChannelRosterInspection,
  EnvelopeLineage,
  InvocationStateInspection,
  InvocationDiagnosticPacket,
  DiagnoseInvocationInput,
  InspectAgentHealthInput,
  InspectChannelRosterInput,
  InspectInvocationStateInput,
  InspectPublicationIntegrityInput,
  InspectStorageDiagnosticsInput,
  InspectTurnStateInput,
  PrivateLineageForPublishedEnvelope,
  PublicationIntegrityInspection,
  PublishedArtifact,
  StoredRegistryMutationInput,
  TurnStateInspection,
} from "@vibestudio/service-schemas/workspaceSource";
import {
  CHANNEL_INVITE_NOTIFICATION_KIND,
  channelInviteFromNotification,
  channelInviteNotification,
  channelInviteNotificationId,
  type PutUserNotificationInput,
  type UserNotification,
  type UserNotificationAcknowledgementResult,
  type UserNotificationListResult,
} from "@vibestudio/shared/userNotifications";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  GENESIS_EVENT_HASH,
  assertAgenticEventStoredValuesEncoded,
  brandId,
  collectStoredValueRefs,
  isStoredValueRef,
  publicActorRef,
  publicParticipantMetadata,
  publicParticipantRef,
  sanitizeAgenticEventParticipantRefs,
  storedAgenticEventSchema,
  type ActorRef,
  type AgenticEvent,
  type ChannelEnvelope,
  type ChannelId,
  type EnvelopeId,
  type LogEnvelope,
  type LogEventCausality,
  type LogKind,
  type ParticipantRef,
  type ParticipantSelector,
  type TrajectoryEvent,
} from "@workspace/agentic-protocol";
import {
  gadAppendErrorMessage,
  logEnvelopeHashPreimage,
  logEnvelopeSemantic,
  type AppendIdempotency,
  type LogEnvelopeSemanticInput,
} from "@workspace/agentic-protocol";
import {
  buildWorktreeManifest,
  sha256HexSyncText,
  sortForCanonicalJson,
  canonicalJson,
  stateHashForRoot,
} from "@vibestudio/content-addressing";
import {
  createSemanticVcsSchema,
  createTrajectoryMirrorSchema,
  SEMANTIC_VCS_REQUIRED_TABLES,
} from "./semanticVcsSchema.js";
import { SemanticVcsError, SemanticVcsStore } from "./semanticVcsStore.js";
import {
  SemanticWorkspace,
  type SemanticDispatchRequest,
  type SemanticEffectAcknowledgement,
} from "./semanticWorkspace.js";
import type {
  InitializeExactWorkspaceSnapshotInput,
  WorkspaceSourceEffect,
  WorkspaceSourceInitializationInspection,
  WorkspaceSourceInitializationReceipt,
} from "@vibestudio/workspace-contracts/workspaceSource";

type JsonPrimitive = null | string | number | boolean;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;
type SqlBinding = null | string | number | boolean | Uint8Array;
type PublicationIntegrityIssue = PublicationIntegrityInspection["rows"][number];
type ChannelStoredValueRef = ChannelEnvelopeInspection["storedRefs"][number];
type TurnStateRow = TurnStateInspection["rows"][number];
type InvocationStateRow = InvocationStateInspection["rows"][number];
type InvocationDiagnostic = NonNullable<
  InvocationDiagnosticPacket["invocation"]
>;
type TurnDiagnostic = NonNullable<InvocationDiagnosticPacket["turn"]>;
type CommandDiagnostic = InvocationDiagnosticPacket["commands"][number];
type ChannelRosterRow = ChannelRosterInspection["rows"][number];
type StorageDiagnostic = AgentHealthInspection["storage"]["rows"][number];

/** First supported production schema for the semantic workspace authority. */
const GAD_WORKSPACE_SCHEMA_VERSION = 65;

const PUBLICATION_RETRY_BASE_MS = 250;
const PUBLICATION_RETRY_MAX_MS = 30_000;

const utf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const CHANNEL_LOG_HEAD = "main";

function createWorkspaceSourceInitializationTable(sql: {
  exec(query: string, ...bindings: SqlBinding[]): unknown;
}): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS workspace_source_initializations (
      command_id TEXT PRIMARY KEY,
      request_digest TEXT NOT NULL,
      pin_json TEXT NOT NULL CHECK (json_valid(pin_json) = 1),
      repositories_json TEXT NOT NULL CHECK (json_valid(repositories_json) = 1),
      phase TEXT NOT NULL CHECK (
        phase IN ('context', 'imports', 'publish', 'ready', 'failed')
      ),
      next_repository INTEGER NOT NULL CHECK (next_repository >= 0),
      context_id TEXT NOT NULL,
      genesis_event_id TEXT,
      receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json) = 1),
      failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json) = 1),
      updated_at TEXT NOT NULL
    )
  `);
}

function createPublicationDeliveryOutbox(sql: {
  exec(query: string, ...bindings: SqlBinding[]): unknown;
}): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS publication_delivery_outbox (
      item_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      envelope_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      lease_owner TEXT,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_attempt_at INTEGER,
      disposition TEXT NOT NULL DEFAULT 'ready'
        CHECK (disposition IN ('ready', 'leased', 'retrying')),
      UNIQUE(channel_id, envelope_id)
    )
  `);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_publication_delivery_claim
       ON publication_delivery_outbox(disposition, next_attempt_at, created_at)`,
  );
}

function createMemoryIndex(sql: {
  exec(query: string, ...bindings: SqlBinding[]): unknown;
}): "fts" | "plain" {
  try {
    sql.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS gad_memory_fts USING fts5(
         text, kind UNINDEXED, log_id UNINDEXED, head UNINDEXED,
         event_id UNINDEXED, path UNINDEXED, content_hash UNINDEXED,
         anchor_json UNINDEXED
       )`,
    );
    return "fts";
  } catch {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS gad_memory_fts (
         text TEXT NOT NULL, kind TEXT NOT NULL, log_id TEXT, head TEXT,
         event_id TEXT, path TEXT, content_hash TEXT, anchor_json TEXT
       )`,
    );
    return "plain";
  }
}

/**
 * The agent directory (messaging plan §4.4) — a projection, not a new source of
 * truth. Every row is derived from presence, turn, and message events this DO
 * already ingests.
 *
 * **Identity is a (worker, channel) pair**, keyed `"<handle>@<channelId>"`,
 * which is also the addressee grammar: what `discover_agents` prints is
 * literally what `notify` accepts. A worker agent sitting in three channels is
 * three rows sharing a `worker_id` — correct, because "message the gmail agent"
 * is meaningless without saying *where*, and the three rows carry genuinely
 * different status. `worker_id` and `run_id` are indexed lookup columns, never
 * the key: "all instances of this worker" is a query, not an identity.
 */
function createAgentDirectory(sql: {
  exec(query: string, ...bindings: SqlBinding[]): unknown;
}): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS agent_directory (
      instance_id       TEXT PRIMARY KEY,
      channel_id        TEXT NOT NULL,
      participant_id    TEXT NOT NULL,
      kind              TEXT,
      handle            TEXT,
      display_name      TEXT,
      description       TEXT,
      parent_instance_id TEXT,
      run_id            TEXT,
      worker_id         TEXT,
      owner_user_id     TEXT,
      status            TEXT NOT NULL DEFAULT 'idle'
        CHECK (status IN ('running', 'idle', 'terminal')),
      status_event_id   TEXT,
      last_activity_at  INTEGER,
      summary           TEXT
    )
  `);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_agent_directory_channel
       ON agent_directory (channel_id, status)`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_agent_directory_worker ON agent_directory (worker_id)`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_agent_directory_run ON agent_directory (run_id)`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_agent_directory_participant
       ON agent_directory (channel_id, participant_id)`,
  );
}

/** FTS mirror of the directory's prose columns, with the same virtual-table /
 *  plain-table fallback as `gad_memory_fts` — FTS5 is absent under the sql.js
 *  test harness and present under workerd, and that difference has bitten this
 *  file before. Same write and read logic either way. */
function createAgentDirectoryIndex(sql: {
  exec(query: string, ...bindings: SqlBinding[]): unknown;
}): "fts" | "plain" {
  try {
    sql.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS gad_agent_directory_fts USING fts5(
         text, instance_id UNINDEXED, channel_id UNINDEXED, status UNINDEXED
       )`,
    );
    return "fts";
  } catch {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS gad_agent_directory_fts (
         text TEXT NOT NULL, instance_id TEXT NOT NULL,
         channel_id TEXT, status TEXT
       )`,
    );
    return "plain";
  }
}

function existingAgentDirectoryIndexMode(sql: {
  exec(
    query: string,
    ...bindings: SqlBinding[]
  ): { toArray(): Record<string, unknown>[] };
}): "fts" | "plain" | null {
  const row = sql
    .exec(
      `SELECT sql FROM sqlite_master WHERE name = 'gad_agent_directory_fts' LIMIT 1`,
    )
    .toArray()[0];
  if (!row) return null;
  return /\bCREATE\s+VIRTUAL\s+TABLE\b/iu.test(String(row["sql"] ?? ""))
    ? "fts"
    : "plain";
}

function existingMemoryIndexMode(sql: {
  exec(
    query: string,
    ...bindings: SqlBinding[]
  ): { toArray(): Record<string, unknown>[] };
}): "fts" | "plain" | null {
  const row = sql
    .exec(`SELECT sql FROM sqlite_master WHERE name = 'gad_memory_fts' LIMIT 1`)
    .toArray()[0];
  if (!row) return null;
  return /\bCREATE\s+VIRTUAL\s+TABLE\b/iu.test(String(row["sql"] ?? ""))
    ? "fts"
    : "plain";
}

/** Valid log/event actor kinds. Actor provenance can be semantic participants
 *  (`agent`, `user`) or runtime principals (`do`, `worker`, `server`, etc.). */
const ACTOR_KINDS = new Set([
  "user",
  "agent",
  "system",
  "external",
  "panel",
  "app",
  "worker",
  "do",
  "shell",
  "server",
  "extension",
]);

/** Tables that must exist before a schema version is recorded as ready
 *  (validated by DurableObjectBase after every createTables()). Lazily
 *  created tables (memory index) are deliberately absent. */
const GAD_REQUIRED_TABLES = [
  "log_heads",
  "log_events",
  "log_blob_refs",
  "refs",
  "ref_log",
  "trajectory_turns",
  "trajectory_messages",
  "trajectory_message_blocks",
  "trajectory_invocations",
  "trajectory_invocation_outputs",
  "trajectory_approvals",
  "trajectory_usage_rollups",
  "trajectory_checkpoints",
  "channel_message_types",
  "channel_roster",
  "user_notifications",
  "channel_membership_index",
  "channel_membership_revisions",
  "agent_directory",
  "gad_blobs",
  "workspace_source_initializations",
  "publication_delivery_outbox",
  ...SEMANTIC_VCS_REQUIRED_TABLES,
] as const;

/** Log kinds whose events are full agentic trajectory events (validated and
 *  projected). `log_kind` stays metadata for append/fork/replay/integrity —
 *  this set only gates content validation and projection dispatch. */
const AGENTIC_LOG_KINDS = new Set<string>(["trajectory"]);

const TERMINAL_INVOCATION_KINDS = new Set([
  "invocation.completed",
  "invocation.failed",
  "invocation.cancelled",
  "invocation.abandoned",
]);

export interface LogAppendEventInput {
  envelopeId?: string | null;
  actor: ActorRef;
  to?: ParticipantRef[] | ParticipantSelector | null;
  payloadKind: string;
  payload: unknown;
  causality?: LogEventCausality | null;
  annotations?: Record<string, unknown> | null;
  appendedAt?: string | null;
  publish?: {
    channels: Array<{ channelId: string; audience?: unknown }>;
  } | null;
}

export interface AppendLogEventInput {
  logId: string;
  head: string;
  logKind: LogKind | string;
  owner?: ActorRef | null;
  expectedHeadHash?: string | null;
  /** Append idempotency intent — see AppendIdempotency in agentic-protocol.
   *  Default "exact": same-id-different-content is a hard integrity error.
   *  "idempotent-by-id" (client publish paths only): first write wins; the
   *  journaled original is returned in `envelopes` as a replay. */
  idempotency?: AppendIdempotency | null;
  events: LogAppendEventInput[];
}

export interface AppendLogEventResult {
  logId: string;
  head: string;
  headSeq: number;
  headHash: string;
  envelopes: LogEnvelope[];
  published: Array<{
    originEnvelopeId: string;
    channelId: string;
    envelopeId: string;
  }>;
}

export interface ForkLogInput {
  fromLogId: string;
  fromHead: string;
  toLogId: string;
  toHead: string;
  atSeq?: number | null;
  owner?: { kind: string; id: string } | null;
}

export interface ForkLogResult {
  fromLogId: string;
  fromHead: string;
  toLogId: string;
  toHead: string;
  forkSeq: number;
  forkHash: string;
  inherited: number;
}

export interface ReadLogInput {
  logId: string;
  head: string;
  afterSeq?: number | null;
  beforeSeq?: number | null;
  limit?: number | null;
  payloadKind?: string | null;
}

export interface LogHeadInfo {
  logId: string;
  head: string;
  logKind: string;
  seq: number;
  hash: string;
  envelopeId: string | null;
  forkSeq: number | null;
  forkHash: string | null;
  parentLogId: string | null;
  parentHead: string | null;
}

export interface RefRecord {
  refName: string;
  kind: string;
  target: unknown;
  updatedAt: string;
}

export interface ForkTrajectoryBranchInput {
  fromTrajectoryId: string;
  fromBranchId: string;
  toTrajectoryId: string;
  toBranchId: string;
  throughSeq?: number | null;
  throughEventHash?: string | null;
  throughPublishedChannelId?: string | null;
  throughPublishedChannelSeq?: number | null;
  toPublishedChannelId?: string | null;
  owner?: { kind: "agent"; id: string } | null;
}

export interface ForkTrajectoryBranchResult {
  fromTrajectoryId: string;
  fromBranchId: string;
  toTrajectoryId: string;
  toBranchId: string;
  copied: number;
  headEventId: string | null;
  headEventHash: string | null;
  lineage: Array<{
    sourceEventId: string;
    forkEventId: string;
    sourceSeq: number;
    forkSeq: number;
    sourceEventHash: string;
    forkEventHash: string;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function json(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** WP5 §5 — the acting/resolving ACCOUNT (userId+handle) as it rides in an
 *  approval actor's `metadata`. The account lives in `metadata`, NEVER in
 *  `actor.kind` (that kind stays the semantic role — "agent"/"user"-authored —
 *  not an account handle); this reads it back out so the provenance projection
 *  can carry WHO resolved without conflating the two. Returns null when no
 *  account is stamped (system-authored or pre-multi-user resolutions). */
function accountFromActorMetadata(
  metadata: unknown,
): { userId: string; handle?: string } | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return null;
  const record = metadata as Record<string, unknown>;
  const userId = asString(record["userId"]);
  if (!userId) return null;
  const handle = asString(record["handle"]);
  return handle ? { userId, handle } : { userId };
}

/** Serialize the canonical approval provenance actor shape. Every non-null row
 *  carries `kind`, `id`, and an explicit `account` (`null` for system actors),
 *  so readers never need to infer which schema generation produced it. */
function approvalActorJson(
  actor: unknown,
  resolutionMetadata?: unknown,
): string | null {
  if (actor == null) return null;
  if (typeof actor !== "object" || Array.isArray(actor)) {
    throw new Error("approval actor must be an object");
  }
  const record = actor as Record<string, unknown>;
  if (!asString(record["kind"]) || !asString(record["id"])) {
    throw new Error("approval actor requires kind and id");
  }
  const account =
    accountFromActorMetadata(record["metadata"]) ??
    accountFromActorMetadata(resolutionMetadata);
  return JSON.stringify({ ...record, account });
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  return JSON.parse(value) as unknown;
}

function parseRecord(value: string | null | undefined): JsonRecord {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as JsonRecord)
    : {};
}

function stringPrefixUpperBound(prefix: string): string | null {
  const codePoints = Array.from(prefix);
  for (let index = codePoints.length - 1; index >= 0; index -= 1) {
    const value = codePoints[index]!.codePointAt(0)!;
    if (value < 0x10ffff) {
      return `${codePoints.slice(0, index).join("")}${String.fromCodePoint(value + 1)}`;
    }
  }
  return null;
}

/** Quote each term so user input can't inject FTS5 query syntax. */
function ftsQuery(terms: readonly string[], operator: " " | " OR "): string {
  return terms.map((term) => `"${term}"`).join(operator);
}

/** Split raw text into whitespace-separated word tokens (≤ `cap`), quotes and
 *  blanks stripped. Shared by the FTS and plain-mode recall query builders so
 *  steering keywords are tokenized exactly like the base query. */
function recallTokens(
  values: readonly string[] | null | undefined,
  cap = 8,
): string[] {
  if (!values || values.length === 0) return [];
  return values
    .flatMap((value) => value.split(/\s+/u))
    .map((term) => term.replace(/"/gu, "").trim())
    .filter(Boolean)
    .slice(0, cap);
}

/** Short context window around the first query-term hit. */
function snippetAround(text: string, query: string, radius = 160): string {
  const firstTerm = query.split(/\s+/u).find((term) => term.length > 0) ?? "";
  const index = firstTerm
    ? text.toLowerCase().indexOf(firstTerm.toLowerCase())
    : -1;
  if (index < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + firstTerm.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function summarizeJsonForInspection(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > 240
      ? { type: "string", chars: value.length, preview: value.slice(0, 240) }
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const sample = value
      .slice(0, 20)
      .map((item) => summarizeJsonForInspection(item, depth + 1));
    return value.length > sample.length
      ? [...sample, { omittedItems: value.length - sample.length }]
      : sample;
  }
  if (typeof value === "object") {
    if (depth >= 4) return { type: "object" };
    const entries = Object.entries(value as Record<string, unknown>);
    const sample = entries
      .slice(0, 40)
      .map(([key, child]) => [
        key,
        summarizeJsonForInspection(child, depth + 1),
      ]);
    const out = Object.fromEntries(sample) as Record<string, unknown>;
    if (entries.length > sample.length)
      out["omittedKeys"] = entries.length - sample.length;
    return out;
  }
  return String(value);
}

function isActorRefLike(value: unknown): value is ActorRef {
  const kind =
    !!value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)["kind"]
      : undefined;
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ACTOR_KINDS.has(String(kind)) &&
    typeof (value as Record<string, unknown>)["id"] === "string"
  );
}

function sanitizeRegistryMutation(
  mutation: StoredRegistryMutationInput,
): StoredRegistryMutationInput {
  if (mutation.kind !== "upsertMessageType") return mutation;
  const registeredBy = mutation.row.registeredBy;
  return StoredRegistryMutationInputSchema.parse({
    ...mutation,
    row: {
      ...mutation.row,
      ...(isActorRefLike(registeredBy)
        ? { registeredBy: publicActorRef(registeredBy) }
        : registeredBy !== undefined
          ? { registeredBy: publicParticipantMetadata(registeredBy) }
          : {}),
    },
  });
}

function findPrivateParticipantMetadataPath(
  value: unknown,
  path = "$",
): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findPrivateParticipantMetadataPath(
        value[index],
        `${path}[${index}]`,
      );
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if ("methods" in record && Array.isArray(record["methods"])) {
    for (const [index, method] of (record["methods"] as unknown[]).entries()) {
      if (!method || typeof method !== "object" || Array.isArray(method))
        continue;
      const methodRecord = method as Record<string, unknown>;
      if (
        "parameters" in methodRecord ||
        "returns" in methodRecord ||
        "description" in methodRecord
      ) {
        return `${path}.methods[${index}]`;
      }
    }
  }
  for (const key of Object.keys(record)) {
    if (key === "parameters" || key === "returns" || key === "description")
      continue;
    const found = findPrivateParticipantMetadataPath(
      record[key],
      `${path}.${key}`,
    );
    if (found) return found;
  }
  return null;
}

function sanitizeRosterMethodSummaries(methods: unknown): unknown[] {
  const publicMethods = publicParticipantMetadata({ methods })?.methods;
  return publicMethods ?? [];
}

function sanitizeRosterSnapshotPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return payload;
  const record = payload as Record<string, unknown>;
  const details = record["details"];
  if (!details || typeof details !== "object" || Array.isArray(details))
    return payload;
  const detailsRecord = details as Record<string, unknown>;
  if (
    detailsRecord["kind"] !== "roster.snapshot" &&
    record["kind"] !== "roster.snapshot"
  ) {
    return payload;
  }
  const roster = detailsRecord["roster"];
  if (!roster || typeof roster !== "object" || Array.isArray(roster))
    return payload;
  const rosterRecord = roster as Record<string, unknown>;
  if (!Array.isArray(rosterRecord["participants"])) return payload;

  return {
    ...record,
    details: {
      ...detailsRecord,
      roster: {
        ...rosterRecord,
        participants: rosterRecord["participants"].map((participant) => {
          if (
            !participant ||
            typeof participant !== "object" ||
            Array.isArray(participant)
          ) {
            return participant;
          }
          const participantRecord = participant as Record<string, unknown>;
          const ref = participantRecord["ref"];
          return {
            ...participantRecord,
            ...(ref && typeof ref === "object" && !Array.isArray(ref)
              ? { ref: publicParticipantRef(ref as ParticipantRef) }
              : {}),
            methods: sanitizeRosterMethodSummaries(
              participantRecord["methods"],
            ),
          };
        }),
      },
    },
  };
}

function sanitizeAudience(
  audience: ParticipantRef[] | ParticipantSelector | null | undefined,
): ParticipantRef[] | ParticipantSelector | undefined {
  if (audience == null) return undefined;
  if (!Array.isArray(audience)) return audience;
  return audience.map((participant) => publicParticipantRef(participant));
}

function isAgenticEventPayload(payload: unknown): payload is AgenticEvent {
  return (
    !!payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof (payload as Record<string, unknown>)["kind"] === "string" &&
    typeof (payload as Record<string, unknown>)["actor"] === "object" &&
    typeof (payload as Record<string, unknown>)["createdAt"] === "string"
  );
}

/** Strip cross-log/turn keys so the remaining causality matches the agentic
 *  trajectory causality shape. */
function agenticCausality(
  causality: LogEventCausality | null | undefined,
): Record<string, unknown> | undefined {
  if (!causality) return undefined;
  const {
    originLogId: _originLogId,
    originHead: _originHead,
    originEnvelopeId: _originEnvelopeId,
    turnId: _turnId,
    ...rest
  } = causality as Record<string, unknown>;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** Rebuild the semantic agentic event from a unified log envelope. */
function agenticEventFromEnvelope(
  envelope: LogEnvelope,
): Record<string, unknown> {
  const causality = agenticCausality(envelope.causality);
  const turnId = envelope.causality?.turnId;
  return {
    kind: envelope.payloadKind,
    actor: envelope.actor,
    ...(turnId ? { turnId } : {}),
    ...(causality ? { causality } : {}),
    payload: envelope.payload,
    createdAt: envelope.appendedAt,
  };
}

function terminalInvocationSignatureFromEnvelope(
  envelope: LogEnvelope,
): string {
  const causality = (envelope.causality ?? {}) as Record<string, unknown>;
  return canonicalJson({
    actor: envelope.actor,
    kind: envelope.payloadKind,
    turnId: causality["turnId"],
    causality: {
      invocationId: causality["invocationId"],
      modelToolCallId: causality["modelToolCallId"],
      transportCallId: causality["transportCallId"],
    },
    payload: envelope.payload,
  });
}

interface PreparedLogEvent {
  envelopeId: string;
  /** Whether the caller supplied appendedAt (idempotent replays of implicit-
   *  timestamp appends compare against the stored timestamp instead). */
  appendedAtExplicit: boolean;
  actor: ActorRef;
  to?: ParticipantRef[] | ParticipantSelector;
  payloadKind: string;
  payload: unknown;
  annotations?: Record<string, unknown>;
  causality?: LogEventCausality;
  appendedAt: string;
  publish: Array<{ channelId: string; audience?: unknown }>;
}

interface LineageSegment {
  logId: string;
  head: string;
  /** Highest seq visible from the descendant's perspective (Infinity for self). */
  throughSeq: number;
}

interface LineageEventStats {
  count: number;
  firstSeq?: number;
  lastSeq?: number;
}

interface ProjectionKey {
  logId: string;
  head: string;
}

export class GadWorkspaceDO extends DurableObjectBase {
  static override rpcMethods = gadWireMethods;
  static override schemaVersion = GAD_WORKSPACE_SCHEMA_VERSION;

  protected override rpcSchemaCodeSource(
    _method: string,
    wireMethod: MethodSchema,
  ): string | null {
    return wireMethod.capability === "workspace-service:gad.workspace"
      ? "vibestudio/internal"
      : null;
  }

  protected createTables(): void {
    this.createFreshSchema();
  }

  protected override requiredTables(): readonly string[] {
    return GAD_REQUIRED_TABLES;
  }

  protected override durableWorkQueues(): readonly DurableWorkQueue[] {
    return ["workspace-publication"];
  }

  protected override releaseDurableWorkClaims(
    previousWorkerId: string | null,
    _nextWorkerId: string,
  ): void {
    if (!previousWorkerId) return;
    this.sql.exec(
      `UPDATE publication_delivery_outbox
          SET disposition = 'ready', lease_owner = NULL, next_attempt_at = ?
        WHERE disposition = 'leased' AND lease_owner = ?`,
      Date.now(),
      previousWorkerId,
    );
  }

  private hasReadyPublicationDelivery(now: number): boolean {
    return (
      this.sql
        .exec(
          `SELECT 1 FROM publication_delivery_outbox
            WHERE disposition IN ('ready', 'retrying') AND next_attempt_at <= ?
            LIMIT 1`,
          now,
        )
        .toArray().length > 0
    );
  }

  private nextPublicationRecoveryAt(): number | null {
    const value = this.sql
      .exec(
        `SELECT MIN(next_attempt_at) AS due
           FROM publication_delivery_outbox
          WHERE disposition = 'retrying'`,
      )
      .toArray()[0]?.["due"];
    return typeof value === "number" ? value : null;
  }

  override async alarm(): Promise<DoAlarmSchedule | null> {
    await super.alarm();
    if (this.hasReadyPublicationDelivery(Date.now())) {
      this.markWorkReady("workspace-publication");
    }
    const recoveryAt = this.nextPublicationRecoveryAt();
    return recoveryAt === null
      ? null
      : { wakeAt: Math.max(recoveryAt, Date.now() + 100) };
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  adoptDurableWorkWorker(workerId: string): {
    adopted: boolean;
    previousWorkerId: string | null;
  } {
    return this.adoptDurableWorkWorkerGeneration(workerId);
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  claimReadyWork(queue: DurableWorkQueue, input: ClaimRequest): WorkClaim[] {
    if (queue !== "workspace-publication") return [];
    if (!input.workerId || input.limit < 1) {
      throw new Error("claimReadyWork: invalid publication claim request");
    }
    this.adoptDurableWorkWorkerGeneration(input.workerId);
    const claims = this.ctx.storage.transactionSync(() => {
      const rows = this.sql
        .exec(
          `SELECT * FROM publication_delivery_outbox
            WHERE disposition IN ('ready', 'retrying') AND next_attempt_at <= ?
            ORDER BY created_at, item_id
            LIMIT ?`,
          input.now,
          input.limit,
        )
        .toArray();
      return rows.map((row) => {
        const itemId = String(row["item_id"]);
        const generation = Number(row["lease_generation"] ?? 0) + 1;
        this.sql.exec(
          `UPDATE publication_delivery_outbox
              SET disposition = 'leased', lease_owner = ?, lease_generation = ?,
                  last_attempt_at = ?
            WHERE item_id = ?`,
          input.workerId,
          generation,
          input.now,
          itemId,
        );
        const channelId = String(row["channel_id"]);
        return {
          itemId,
          generation,
          idempotencyKey: String(row["idempotency_key"]),
          createdAt: Number(row["created_at"]),
          attempt: Number(row["attempts"] ?? 0) + 1,
          payload: {
            laneKey: channelId,
            target: {
              source: "workers/pubsub-channel",
              className: "PubSubChannel",
              objectKey: channelId,
            },
            envelopeIds: [String(row["envelope_id"])],
          },
        } satisfies WorkClaim;
      });
    });
    if (!this.hasReadyPublicationDelivery(input.now)) {
      this.acknowledgeDurableWorkReady("workspace-publication");
    }
    return claims;
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  settleReadyWork(
    queue: DurableWorkQueue,
    request: SettleRequest<{ broadcasted: number }>,
  ): ClaimSettlement {
    if (queue !== "workspace-publication") return "stale";
    return this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec(
          `SELECT lease_owner, lease_generation, disposition
             FROM publication_delivery_outbox WHERE item_id = ?`,
          request.itemId,
        )
        .toArray()[0];
      if (!row) return "duplicate";
      if (
        row["lease_owner"] !== request.workerId ||
        Number(row["lease_generation"]) !== request.generation ||
        row["disposition"] !== "leased"
      ) {
        return "stale";
      }
      if (!request.outcome || request.outcome.broadcasted !== 1) {
        throw new Error(
          "settleReadyWork: publication was not broadcast exactly once",
        );
      }
      this.sql.exec(
        `DELETE FROM publication_delivery_outbox WHERE item_id = ?`,
        request.itemId,
      );
      return "accepted";
    });
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  failReadyWork(
    queue: DurableWorkQueue,
    request: { workerId: string; itemId: string; generation: number },
  ): { retryAt: number } | "stale" {
    if (queue !== "workspace-publication") return "stale";
    const result = this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec(
          `SELECT attempts FROM publication_delivery_outbox
            WHERE item_id = ? AND lease_owner = ? AND lease_generation = ?
              AND disposition = 'leased'`,
          request.itemId,
          request.workerId,
          request.generation,
        )
        .toArray()[0];
      if (!row) return "stale";
      const attempts = Number(row["attempts"] ?? 0) + 1;
      const retryAt =
        Date.now() +
        Math.min(
          PUBLICATION_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 7),
          PUBLICATION_RETRY_MAX_MS,
        );
      this.sql.exec(
        `UPDATE publication_delivery_outbox
            SET attempts = ?, disposition = 'retrying', next_attempt_at = ?, lease_owner = NULL
          WHERE item_id = ? AND lease_owner = ? AND lease_generation = ?`,
        attempts,
        retryAt,
        request.itemId,
        request.workerId,
        request.generation,
      );
      return { retryAt };
    });
    if (result !== "stale") this.setAlarmAt(result.retryAt);
    return result;
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  durableWorkStatus(): {
    readyQueues: DurableWorkQueue[];
    nextRecoveryAt: number | null;
  } {
    const now = Date.now();
    const ready = this.hasReadyPublicationDelivery(now);
    return {
      readyQueues: ready ? ["workspace-publication"] : [],
      nextRecoveryAt: this.nextPublicationRecoveryAt(),
    };
  }

  private createFreshSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS log_heads (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        log_kind TEXT NOT NULL,
        owner_json TEXT,
        parent_log_id TEXT,
        parent_head TEXT,
        fork_seq INTEGER,
        fork_hash TEXT,
        current_seq INTEGER NOT NULL DEFAULT 0,
        current_hash TEXT NOT NULL DEFAULT '${GENESIS_EVENT_HASH}',
        current_envelope_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS log_events (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        seq INTEGER NOT NULL,
        envelope_id TEXT NOT NULL,
        payload_kind TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        to_json TEXT,
        causality_json TEXT,
        annotations_json TEXT,
        payload_ref_json TEXT NOT NULL,
        appended_at TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        prev_hash TEXT NOT NULL,
        origin_log_id TEXT,
        origin_head TEXT,
        origin_envelope_id TEXT,
        turn_id TEXT,
        PRIMARY KEY (log_id, head, seq),
        UNIQUE (log_id, head, envelope_id)
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_log_events_kind ON log_events(payload_kind, log_id, head, seq)`,
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_log_events_origin ON log_events(origin_envelope_id)`,
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_log_events_envelope ON log_events(envelope_id)`,
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_log_events_turn ON log_events(turn_id)`,
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS log_blob_refs (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        envelope_id TEXT NOT NULL,
        field_path TEXT NOT NULL,
        digest TEXT NOT NULL,
        purpose TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, envelope_id, field_path)
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_log_blob_refs_digest ON log_blob_refs(digest)`,
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS refs (
        ref_name TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        target_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ref_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ref_name TEXT NOT NULL,
        old_target_json TEXT,
        new_target_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_ref_log_name ON ref_log(ref_name, id)`,
    );
    createTrajectoryMirrorSchema(this.sql);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_invocation_outputs (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        chunk_ref_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, invocation_id, seq)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_approvals (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        approval_id TEXT NOT NULL,
        invocation_id TEXT,
        status TEXT NOT NULL,
        requested_by_json TEXT,
        resolved_by_json TEXT,
        requested_event_id TEXT,
        resolved_event_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, approval_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_usage_rollups (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (log_id, head, turn_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_checkpoints (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        anchor_event_hash TEXT NOT NULL,
        materialized_blob_json TEXT NOT NULL,
        materializer_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, anchor_event_hash)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_message_types (
        channel_id TEXT NOT NULL,
        type_id TEXT NOT NULL,
        display_mode TEXT,
        source_json TEXT,
        imports_json TEXT,
        schema_json TEXT,
        registered_by_json TEXT,
        updated_at_seq INTEGER NOT NULL DEFAULT -1,
        cleared_at_seq INTEGER,
        PRIMARY KEY (channel_id, type_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_roster (
        channel_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        left_at TEXT,
        roles_json TEXT,
        PRIMARY KEY (channel_id, participant_id, joined_at)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS user_notifications (
        user_id         TEXT NOT NULL,
        notification_id TEXT NOT NULL,
        kind            TEXT NOT NULL,
        title           TEXT NOT NULL,
        message         TEXT,
        data_json       TEXT,
        created_at      INTEGER NOT NULL,
        producer_revision INTEGER NOT NULL,
        acknowledged_at INTEGER,
        PRIMARY KEY (user_id, notification_id)
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_user_notifications_user_created
        ON user_notifications (user_id, acknowledged_at, created_at DESC, notification_id)
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_membership_index (
        user_id    TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        member_id  TEXT NOT NULL,
        handle     TEXT NOT NULL,
        added_by   TEXT NOT NULL,
        added_at   INTEGER NOT NULL,
        PRIMARY KEY (user_id, channel_id)
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_channel_membership_index_user
        ON channel_membership_index (user_id, channel_id)
    `);
    // The last applied membership mutation survives a delete. This tombstone is
    // the ordering authority for the two materialized projections above.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_membership_revisions (
        user_id    TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        revision   INTEGER NOT NULL CHECK (revision > 0),
        action     TEXT NOT NULL CHECK (action IN ('put', 'delete')),
        PRIMARY KEY (user_id, channel_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_blobs (
        hash TEXT PRIMARY KEY,
        size INTEGER NOT NULL DEFAULT 0,
        mime_type TEXT,
        policy_id TEXT,
        created_at TEXT NOT NULL
      )
    `);
    createWorkspaceSourceInitializationTable(this.sql);
    createPublicationDeliveryOutbox(this.sql);
    createSemanticVcsSchema(this.sql);
    // The recall contents are disposable, but the index table is part of the
    // exact database shape. Lazy creation changed sqlite_master after schema
    // identity was sealed, so the next activation rejected its own database.
    createMemoryIndex(this.sql);
    createAgentDirectory(this.sql);
    createAgentDirectoryIndex(this.sql);
    // Provenance is compiled from normalized point tables. We intentionally do
    // not create union views or persisted traversal continuations: callers
    // inspect a node and keyset-page its immediate indexed edges.
    this.ensureEmptyState();
  }

  @schemaRpc()
  ensureBlob(hash: string, size = 0, mimeType?: string | null): void {
    this.ensureReady();
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_blobs (hash, size, mime_type, created_at) VALUES (?, ?, ?, ?)`,
      hash,
      size,
      mimeType ?? null,
      nowIso(),
    );
  }

  private semanticVcsStore(): SemanticVcsStore {
    return new SemanticVcsStore(this.sql, nowIso);
  }

  private semanticWorkspace(): SemanticWorkspace {
    return new SemanticWorkspace({
      workspaceId: this.semanticWorkspaceId(),
      sql: this.sql,
      store: this.semanticVcsStore(),
      now: nowIso,
      transaction: (fn) => this.transaction(fn),
    });
  }

  private semanticWorkspaceId(): string {
    const configured = this.env["WORKSPACE_ID"];
    if (typeof configured !== "string" || configured.length === 0) {
      throw new Error(
        "GadWorkspaceDO requires the topology-owned WORKSPACE_ID binding",
      );
    }
    return configured;
  }

  @schemaRpc()
  async workspaceSourceInitializeExactSnapshot(
    input: InitializeExactWorkspaceSnapshotInput,
  ): Promise<WorkspaceSourceInitializationInspection> {
    this.ensureReady();
    const requestDigest = sha256HexSyncText(
      canonicalJson({ pin: input.pin, repositories: input.repositories }),
    );
    const existing = this.workspaceSourceInitializationRow();
    if (existing && String(existing["command_id"]) !== input.commandId) {
      throw new Error(
        `Workspace source was already initialized by ${String(existing["command_id"])}`,
      );
    }
    if (existing && String(existing["request_digest"]) !== requestDigest) {
      throw new Error(
        `Workspace source initialization command ${input.commandId} was reused`,
      );
    }
    if (!existing) {
      const repoPaths = new Set<string>();
      for (const repository of input.repositories) {
        if (repoPaths.has(repository.repoPath)) {
          throw new Error(
            `Workspace source snapshot repeats ${repository.repoPath}`,
          );
        }
        repoPaths.add(repository.repoPath);
        const contentRoot = buildWorktreeManifest(
          repository.files.map((file) => ({
            path: file.path,
            contentHash: file.contentHash,
            mode:
              file.mode === 0o755 || file.mode === 0o100755
                ? 0o100755
                : 0o100644,
          })),
        ).stateHash;
        if (contentRoot !== repository.contentRoot) {
          throw new Error(
            `Workspace source content root for ${repository.repoPath} does not match its exact snapshot`,
          );
        }
      }
      if (!repoPaths.has("meta")) {
        throw new Error("Workspace source snapshot has no meta repository");
      }
      this.sql.exec(
        `INSERT INTO workspace_source_initializations
         (command_id, request_digest, pin_json, repositories_json, phase,
          next_repository, context_id, genesis_event_id, receipt_json, failure_json, updated_at)
         VALUES (?, ?, ?, ?, 'context', 0, ?, NULL, NULL, NULL, ?)`,
        input.commandId,
        requestDigest,
        canonicalJson(input.pin),
        canonicalJson(input.repositories),
        `workspace-initialization:${this.objectKey}`,
        nowIso(),
      );
    }

    const ready = this.workspaceSourceInitializationInspection();
    if (ready.state === "ready" || ready.state === "failed") return ready;

    const workspace = this.semanticWorkspace();
    if (input.acknowledgement) {
      const pending = workspace
        .pendingEffects()
        .find(
          (effect) =>
            effect.effectId === input.acknowledgement?.effectId &&
            effect.payloadDigest === input.acknowledgement.payloadDigest,
        );
      if (!pending || !pending.commandId.startsWith(`${input.commandId}:`)) {
        throw new Error(
          `Initialization acknowledgement does not match a pending effect for ${input.commandId}`,
        );
      }
      const acknowledged = workspace.acknowledgeEffect(
        input.acknowledgement as SemanticEffectAcknowledgement,
      );
      if (acknowledged.kind === "effects-pending") {
        return this.workspaceSourcePendingInspection(
          input.commandId,
          acknowledged.effects[0],
        );
      }
      if (acknowledged.kind === "host-read") {
        throw new Error(
          "Workspace initialization emitted an unsupported host read",
        );
      }
    }

    for (let step = 0; step < input.repositories.length + 4; step += 1) {
      const pending = workspace
        .pendingEffects()
        .find((effect) => effect.commandId.startsWith(`${input.commandId}:`));
      if (pending)
        return this.workspaceSourcePendingInspection(input.commandId, pending);

      const row = this.workspaceSourceInitializationRow();
      if (!row)
        throw new Error("Workspace source initialization record disappeared");
      const phase = String(row["phase"]);
      const contextId = String(row["context_id"]);
      const store = this.semanticVcsStore();

      if (phase === "context") {
        // This context is private staging for one immediate protected-main
        // publication. The exact checkout already exists at the workspace
        // root, so initialization needs the semantic coordinate, not a second
        // disposable filesystem projection of the same snapshot.
        const ensured = workspace.ensureContextCoordinate(
          {
            contextId,
            commandId: `${input.commandId}:context`,
          },
          {
            causalParent: null,
            contextIntegrity: { class: "internal", externalKeys: [] },
          },
        );
        if (ensured.kind !== "complete") {
          if (ensured.kind === "host-read") {
            throw new Error(
              "Workspace initialization emitted an unsupported host read",
            );
          }
          return this.workspaceSourcePendingInspection(
            input.commandId,
            ensured.effects[0],
          );
        }
        const context = store.contextRequired(contextId);
        if (context.committed.ref.kind !== "event") {
          throw new Error(
            "Workspace source initialization context is not at an event",
          );
        }
        this.sql.exec(
          `UPDATE workspace_source_initializations
              SET phase = 'imports', genesis_event_id = ?, updated_at = ?
            WHERE command_id = ?`,
          context.committed.ref.eventId,
          nowIso(),
          input.commandId,
        );
        continue;
      }

      if (phase === "imports") {
        const importCommandId = `${input.commandId}:import`;
        const command = this.sql
          .exec(
            `SELECT status FROM vcs_command_journal WHERE command_id = ?`,
            importCommandId,
          )
          .toArray()[0] as JsonRecord | undefined;
        if (command?.["status"] === "complete") {
          const context = store.contextRequired(contextId);
          store.recordInitializedRepositoryContentRoots({
            workspaceFactRootId: context.committed.workspaceFactRootId,
            provenanceId: `workspace-source:${input.commandId}`,
            repositories: input.repositories.map((repository) => ({
              repoPath: repository.repoPath,
              contentRoot: repository.contentRoot,
            })),
          });
          this.sql.exec(
            `UPDATE workspace_source_initializations
                SET phase = 'publish', updated_at = ? WHERE command_id = ?`,
            nowIso(),
            input.commandId,
          );
          continue;
        }
        const context = store.contextRequired(contextId);
        const dispatched = workspace.importSnapshotCoordinate(
          {
            contextId,
            commandId: importCommandId,
            expectedWorkingHead: context.working.ref,
            intentSummary: "Initialize the exact semantic workspace source",
            source: {
              kind: "generated",
              uri: "vibestudio://workspace/root-template",
              snapshotRevision: `${input.pin.commit}:${input.pin.snapshot}`,
            },
            repositories: input.repositories.map((repository) => ({
              repoPath: repository.repoPath,
              files: repository.files.map((file) => ({ ...file })),
            })),
            message: "Initialize exact workspace source",
          },
          {
            causalParent: null,
            contextIntegrity: { class: "internal", externalKeys: [] },
          },
        );
        if (dispatched.kind === "host-read") {
          throw new Error(
            "Workspace initialization emitted an unsupported host read",
          );
        }
        if (dispatched.kind === "effects-pending") {
          return this.workspaceSourcePendingInspection(
            input.commandId,
            dispatched.effects[0],
          );
        }
        continue;
      }

      if (phase === "publish") {
        const pushCommandId = `${input.commandId}:publish`;
        const command = this.sql
          .exec(
            `SELECT status FROM vcs_command_journal WHERE command_id = ?`,
            pushCommandId,
          )
          .toArray()[0] as JsonRecord | undefined;
        if (command?.["status"] === "complete") {
          const context = store.contextRequired(contextId);
          if (context.committed.ref.kind !== "event") {
            throw new Error("Initialized workspace source is not committed");
          }
          const receipt: WorkspaceSourceInitializationReceipt = {
            commandId: input.commandId,
            pin: input.pin,
            initializedEventId: context.committed.ref.eventId,
            initializedStateHash: stateHashForRoot(
              context.committed.workspaceFactRootId,
            ),
          };
          this.sql.exec(
            `UPDATE workspace_source_initializations
                SET phase = 'ready', receipt_json = ?, updated_at = ?
              WHERE command_id = ?`,
            canonicalJson(receipt),
            nowIso(),
            input.commandId,
          );
          return { state: "ready", commandId: input.commandId, receipt };
        }
        const context = store.contextRequired(contextId);
        const genesisEventId = String(row["genesis_event_id"] ?? "");
        const dispatched = await workspace.dispatch("vcsPush", {
          input: {
            contextId,
            commandId: pushCommandId,
            expectedCommittedEventId: context.committed.ref.eventId,
            expectedMainEventId: genesisEventId,
          },
          ingress: {
            causalParent: null,
            contextIntegrity: { class: "internal", externalKeys: [] },
          },
        });
        if (dispatched.kind === "host-read") {
          throw new Error(
            "Workspace initialization emitted an unsupported host read",
          );
        }
        if (dispatched.kind === "effects-pending") {
          return this.workspaceSourcePendingInspection(
            input.commandId,
            dispatched.effects[0],
          );
        }
        continue;
      }

      if (phase === "ready")
        return this.workspaceSourceInitializationInspection();
      throw new Error(`Unknown workspace source initialization phase ${phase}`);
    }
    throw new Error("Workspace source initialization made no progress");
  }

  @schemaRpc()
  workspaceSourceResolve(input: { ref: string }): { stateHash: string } {
    const current = this.workspaceSourceCurrent();
    if (!current) throw new Error("Workspace source is not initialized");
    if (input.ref !== "main" && input.ref !== current.stateHash) {
      throw new Error(`Unknown workspace source reference ${input.ref}`);
    }
    return current;
  }

  @schemaRpc()
  workspaceSourceCurrent(): { stateHash: string } | null {
    this.ensureReady();
    const mainEventId = this.semanticVcsStore().mainEventId();
    if (!mainEventId) return null;
    return {
      stateHash: stateHashForRoot(
        this.semanticVcsStore().stateRoot({
          kind: "event",
          eventId: mainEventId,
        }),
      ),
    };
  }

  @schemaRpc()
  workspaceSourceInspectInitialization(): WorkspaceSourceInitializationInspection {
    this.ensureReady();
    return this.workspaceSourceInitializationInspection();
  }

  @schemaRpc()
  workspaceSourceHealth(): {
    ok: true;
    protocol: "vibestudio.workspace-source.v1";
  } {
    this.ensureReady();
    return { ok: true, protocol: "vibestudio.workspace-source.v1" };
  }

  private workspaceSourceInitializationRow(): JsonRecord | undefined {
    return this.sql
      .exec(
        `SELECT command_id, request_digest, pin_json, repositories_json, phase,
                next_repository, context_id, genesis_event_id, receipt_json,
                failure_json, updated_at
           FROM workspace_source_initializations
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .toArray()[0] as JsonRecord | undefined;
  }

  private workspaceSourceInitializationInspection(): WorkspaceSourceInitializationInspection {
    const row = this.workspaceSourceInitializationRow();
    if (!row) return { state: "empty" };
    const commandId = String(row["command_id"]);
    const phase = String(row["phase"]);
    if (phase === "ready") {
      return {
        state: "ready",
        commandId,
        receipt: JSON.parse(
          String(row["receipt_json"]),
        ) as WorkspaceSourceInitializationReceipt,
      };
    }
    if (phase === "failed") {
      return {
        state: "failed",
        commandId,
        failure: JSON.parse(String(row["failure_json"])) as {
          message: string;
          retryable: boolean;
        },
      };
    }
    const pending = this.semanticWorkspace()
      .pendingEffects()
      .find((effect) => effect.commandId.startsWith(`${commandId}:`));
    return pending
      ? this.workspaceSourcePendingInspection(commandId, pending)
      : { state: "initializing", commandId };
  }

  private workspaceSourcePendingInspection(
    commandId: string,
    effect:
      | {
          effectId: string;
          scopeKind: "context" | "workspace";
          scopeId: string;
          commandId: string;
          kind: "observe-content" | "materialize-context" | "publish-main";
          payload: Record<string, unknown>;
          payloadDigest: string;
        }
      | undefined,
  ): WorkspaceSourceInitializationInspection {
    if (!effect)
      throw new Error(
        "Workspace source initialization reported no pending effect",
      );
    const pendingEffect: WorkspaceSourceEffect = {
      effectId: effect.effectId,
      scopeKind: effect.scopeKind,
      scopeId: effect.scopeId,
      commandId: effect.commandId,
      kind: effect.kind,
      payload: effect.payload,
      payloadDigest: effect.payloadDigest,
      status: "pending",
    };
    return { state: "initializing", commandId, pendingEffect };
  }

  private vcsSemantic(
    method: import("@vibestudio/service-schemas/vcs").VcsSemanticMethodName,
    request: SemanticDispatchRequest,
  ): Promise<unknown> {
    this.ensureReady();
    return this.semanticWorkspace().dispatch(method, request);
  }

  @schemaRpc()
  vcsEdit(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("edit", request);
  }

  @schemaRpc()
  vcsMove(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("move", request);
  }

  @schemaRpc()
  vcsCopy(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("copy", request);
  }

  @schemaRpc()
  vcsMerge(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("merge", request);
  }

  @schemaRpc()
  vcsRevert(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("revert", request);
  }

  @schemaRpc()
  vcsCommit(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("commit", request);
  }

  @schemaRpc()
  vcsDiscard(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("discard", request);
  }

  @schemaRpc()
  vcsImportSnapshot(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("importSnapshot", request);
  }

  @schemaRpc()
  vcsRegisterExternalDelta(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("registerExternalDelta", request);
  }

  @schemaRpc()
  vcsSupersedeExternalDelta(
    request: SemanticDispatchRequest,
  ): Promise<unknown> {
    return this.vcsSemantic("supersedeExternalDelta", request);
  }

  @schemaRpc()
  vcsFinalizeExternalDelta(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("finalizeExternalDelta", request);
  }

  @schemaRpc()
  vcsPush(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("push", request);
  }

  @schemaRpc()
  vcsStatus(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("status", request);
  }

  @schemaRpc()
  vcsMainState(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("mainState", request);
  }

  @schemaRpc()
  vcsCompare(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("compare", request);
  }

  @schemaRpc()
  vcsInspect(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("inspect", request);
  }

  @schemaRpc()
  vcsNeighbors(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("neighbors", request);
  }

  @schemaRpc()
  vcsHistory(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("history", request);
  }

  @schemaRpc()
  vcsBlame(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("blame", request);
  }

  @schemaRpc()
  vcsWalk(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("walk", request);
  }

  @schemaRpc()
  vcsQuery(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("query", request);
  }

  @schemaRpc()
  vcsSearch(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("search", request);
  }

  @schemaRpc()
  vcsReadMemory(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("readMemory", request);
  }

  @schemaRpc()
  vcsResolveRepository(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("resolveRepository", request);
  }

  @schemaRpc()
  vcsReadFile(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("readFile", request);
  }

  @schemaRpc()
  vcsListDirectory(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("listDirectory", request);
  }

  @schemaRpc()
  vcsListFiles(request: SemanticDispatchRequest): Promise<unknown> {
    return this.vcsSemantic("listFiles", request);
  }

  @schemaRpc()
  vcsSemanticEffectAck(input: {
    acknowledgement: SemanticEffectAcknowledgement;
  }): unknown {
    this.ensureReady();
    return this.semanticWorkspace().acknowledgeEffect(input.acknowledgement);
  }

  @schemaRpc()
  vcsSemanticHostReadAck(input: {
    acknowledgement: {
      request: GadJsonRecord;
      files: Array<{ contentHash: string; text: string }>;
    };
  }): unknown {
    this.ensureReady();
    return this.semanticWorkspace().acknowledgeHostRead(input.acknowledgement);
  }

  @schemaRpc()
  vcsPendingSemanticEffects(): unknown {
    this.ensureReady();
    return this.semanticWorkspace().pendingEffects();
  }

  @schemaRpc()
  vcsContentGcRoots(): unknown {
    this.ensureReady();
    return this.semanticWorkspace().contentGcRoots();
  }

  @schemaRpc()
  vcsListContexts(input: { prefix?: string }): string[] {
    this.ensureReady();
    return this.semanticWorkspace().listContexts(input.prefix);
  }

  @schemaRpc()
  vcsReferencesReachable(input: {
    contextIds: string[];
    references: Array<{ kind: string; value: unknown }>;
  }): unknown {
    this.ensureReady();
    return this.semanticWorkspace().referencesReachable(
      input.contextIds,
      input.references,
    );
  }

  @schemaRpc()
  vcsIsStateDescendant(input: {
    ancestor: import("@vibestudio/service-schemas/vcs").VcsStateNodeRef;
    descendant: import("@vibestudio/service-schemas/vcs").VcsStateNodeRef;
    maxEdges: number;
  }): boolean {
    this.ensureReady();
    return this.semanticWorkspace().isStateDescendant(
      input.ancestor as import("@workspace/vcs-engine").StateNodeRef,
      input.descendant as import("@workspace/vcs-engine").StateNodeRef,
      input.maxEdges,
    );
  }

  @schemaRpc()
  vcsEnsureContext(input: {
    contextId: string;
    commandId: string;
    projection?: "required" | "deferred";
    ingress: SemanticDispatchRequest["ingress"];
  }): unknown {
    this.ensureReady();
    return input.projection === "deferred"
      ? this.semanticWorkspace().ensureContextCoordinate(input, input.ingress)
      : this.semanticWorkspace().ensureContext(input, input.ingress);
  }

  @schemaRpc()
  vcsContextMaterializationCommand(input: {
    contextId: string;
    materializedState:
      | import("@vibestudio/shared/vcs/workspaceProjection").WorkspaceStateRef
      | null;
  }): unknown {
    this.ensureReady();
    return this.semanticWorkspace().contextMaterializationCommand(
      input.contextId,
      input.materializedState,
    );
  }

  @schemaRpc()
  vcsForkContext(input: {
    sourceContextId: string;
    targetContextId: string;
    commandId: string;
    ingress: SemanticDispatchRequest["ingress"];
  }): unknown {
    this.ensureReady();
    return this.semanticWorkspace().forkContext(input, input.ingress);
  }

  @schemaRpc()
  vcsDropContext(input: { contextId: string }): { dropped: boolean } {
    this.ensureReady();
    return {
      dropped: this.transaction(() =>
        this.semanticVcsStore().dropContext(input.contextId),
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Generic refs — tag-style mutable pointers. VCS heads do not live here.
  // -------------------------------------------------------------------------

  @schemaRpc()
  resolveRef(input: { refName: string }): RefRecord | null {
    this.ensureReady();
    const row = this.sql
      .exec(`SELECT * FROM refs WHERE ref_name = ?`, input.refName)
      .toArray()[0] as JsonRecord | undefined;
    if (!row) return null;
    return {
      refName: String(row["ref_name"]),
      kind: String(row["kind"]),
      target: parseJson(asString(row["target_json"])),
      updatedAt: String(row["updated_at"]),
    };
  }

  @schemaRpc()
  updateRef(input: {
    refName: string;
    kind: string;
    target: unknown;
    expected?: unknown;
  }): RefRecord {
    this.ensureReady();
    return this.updateRefInternal(input);
  }

  private updateRefInternal(input: {
    refName: string;
    kind: string;
    target: unknown;
    expected?: unknown;
  }): RefRecord {
    const existing = this.resolveRef({ refName: input.refName });
    if ("expected" in input) {
      const expected = input.expected ?? null;
      const current = existing?.target ?? null;
      if (canonicalJson(expected) !== canonicalJson(current)) {
        throw new Error(`ref CAS conflict: ${input.refName}`);
      }
    }
    const now = nowIso();
    const targetJson = JSON.stringify(input.target);
    this.sql.exec(
      `INSERT INTO refs (ref_name, kind, target_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(ref_name) DO UPDATE SET
         kind = excluded.kind,
         target_json = excluded.target_json,
         updated_at = excluded.updated_at`,
      input.refName,
      input.kind,
      targetJson,
      now,
    );
    this.sql.exec(
      `INSERT INTO ref_log (ref_name, old_target_json, new_target_json, updated_at)
       VALUES (?, ?, ?, ?)`,
      input.refName,
      existing ? JSON.stringify(existing.target) : null,
      targetJson,
      now,
    );
    return {
      refName: input.refName,
      kind: input.kind,
      target: input.target,
      updatedAt: now,
    };
  }

  @schemaRpc()
  deleteRef(input: { refName: string }): { deleted: number } {
    this.ensureReady();
    const existed = this.resolveRef({ refName: input.refName }) != null;
    this.sql.exec(`DELETE FROM refs WHERE ref_name = ?`, input.refName);
    return { deleted: existed ? 1 : 0 };
  }

  /**
   * Fully retire a log head: delete its own post-fork events and head row.
   * Inherited immutable events remain owned by the parent. Semantic contexts
   * have an independent typed lifecycle and are never hidden in log refs.
   * Atomic and idempotent.
   */
  @schemaRpc()
  deleteLogHead(input: { logId: string; head: string }): { deleted: boolean } {
    this.ensureReady();
    return this.transaction(() => {
      const existed = this.logHeadRow(input.logId, input.head) != null;
      // This head's OWN events (post-fork; inherited ones live on the parent).
      this.sql.exec(
        `DELETE FROM log_events WHERE log_id = ? AND head = ?`,
        input.logId,
        input.head,
      );
      this.sql.exec(
        `DELETE FROM log_heads WHERE log_id = ? AND head = ?`,
        input.logId,
        input.head,
      );
      return { deleted: existed };
    });
  }

  @schemaRpc()
  listRefs(
    input: { kind?: string | null; prefix?: string | null } = {},
  ): RefRecord[] {
    this.ensureReady();
    const clauses: string[] = [];
    const bindings: SqlBinding[] = [];
    if (input.kind) {
      clauses.push("kind = ?");
      bindings.push(input.kind);
    }
    if (input.prefix) {
      const upper = stringPrefixUpperBound(input.prefix);
      clauses.push(
        upper ? "(ref_name >= ? AND ref_name < ?)" : "ref_name >= ?",
      );
      bindings.push(input.prefix);
      if (upper) bindings.push(upper);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (
      this.sql
        .exec(`SELECT * FROM refs ${where} ORDER BY ref_name ASC`, ...bindings)
        .toArray() as JsonRecord[]
    ).map((row) => ({
      refName: String(row["ref_name"]),
      kind: String(row["kind"]),
      target: parseJson(asString(row["target_json"])),
      updatedAt: String(row["updated_at"]),
    }));
  }

  @schemaRpc()
  listRefLog(input: { refName: string; limit?: number | null }): JsonRecord[] {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    return this.sql
      .exec(
        `SELECT * FROM ref_log WHERE ref_name = ? ORDER BY id ASC LIMIT ?`,
        input.refName,
        limit,
      )
      .toArray() as JsonRecord[];
  }

  // -------------------------------------------------------------------------
  // Unified log core (one code path for every log kind — P5)
  // -------------------------------------------------------------------------

  @schemaRpc()
  getLogHead(input: { logId: string; head: string }): LogHeadInfo | null {
    this.ensureReady();
    const row = this.logHeadRow(input.logId, input.head);
    if (!row) return null;
    const pointer = this.headPointer(input.logId, input.head, row);
    return {
      logId: input.logId,
      head: input.head,
      logKind: String(row["log_kind"]),
      seq: pointer.seq,
      hash: pointer.hash,
      envelopeId: pointer.envelopeId,
      forkSeq: row["fork_seq"] == null ? null : asNumber(row["fork_seq"]),
      forkHash: asString(row["fork_hash"]),
      parentLogId: asString(row["parent_log_id"]),
      parentHead: asString(row["parent_head"]),
    };
  }

  /**
   * The fork lineage recorded on a `log_heads` row: its parent log and the
   * `(seq, hash)` it forked at (all null for a root / un-forked head). A pure
   * read of the `parent_log_id`/`fork_seq`/`fork_hash` columns {@link forkLog}
   * populates — the LOG lineage surface (trajectory-fork provenance), distinct
   * from the state-DAG merge base a context fork shares. `head` defaults to the
   * log's primary head.
   */
  @schemaRpc()
  getLogLineage(input: { logId: string; head?: string }): {
    parentLogId: string | null;
    forkSeq: number | null;
    forkHash: string | null;
  } {
    this.ensureReady();
    const row = this.logHeadRow(input.logId, input.head ?? CHANNEL_LOG_HEAD);
    return {
      parentLogId: row ? asString(row["parent_log_id"]) : null,
      forkSeq:
        row && row["fork_seq"] != null ? asNumber(row["fork_seq"]) : null,
      forkHash: row ? asString(row["fork_hash"]) : null,
    };
  }

  private logHeadRow(logId: string, head: string): JsonRecord | null {
    return (
      (this.sql
        .exec(
          `SELECT * FROM log_heads WHERE log_id = ? AND head = ?`,
          logId,
          head,
        )
        .toArray()[0] as JsonRecord | undefined) ?? null
    );
  }

  /** Current head pointer: ref target when present, else the fork point /
   *  genesis baseline. */
  private headPointer(
    logId: string,
    head: string,
    headRow?: JsonRecord | null,
  ): { seq: number; hash: string; envelopeId: string | null } {
    const row = headRow ?? this.logHeadRow(logId, head);
    if (row) {
      return {
        seq: asNumber(row["current_seq"]),
        hash: asString(row["current_hash"]) ?? GENESIS_EVENT_HASH,
        envelopeId: asString(row["current_envelope_id"]),
      };
    }
    return { seq: 0, hash: GENESIS_EVENT_HASH, envelopeId: null };
  }

  /** Lineage segments, self first, each capped at the seq visible from the
   *  descendant chain. Cycle-guarded. */
  private logLineage(logId: string, head: string): LineageSegment[] {
    const segments: LineageSegment[] = [];
    const seen = new Set<string>();
    let currentLogId = logId;
    let currentHead = head;
    let cap = Number.POSITIVE_INFINITY;
    for (;;) {
      const key = `${currentLogId}\u0000${currentHead}`;
      if (seen.has(key))
        throw new Error(`log lineage cycle at ${currentLogId}:${currentHead}`);
      seen.add(key);
      segments.push({
        logId: currentLogId,
        head: currentHead,
        throughSeq: cap,
      });
      const row = this.logHeadRow(currentLogId, currentHead);
      if (!row) break;
      const parentLogId = asString(row["parent_log_id"]);
      const parentHead = asString(row["parent_head"]);
      if (!parentLogId || !parentHead || row["fork_seq"] == null) break;
      cap = Math.min(cap, asNumber(row["fork_seq"]));
      currentLogId = parentLogId;
      currentHead = parentHead;
    }
    return segments;
  }

  /** Sync twin of the protocol's computeLogEnvelopeHash — same preimage
   *  builder, sync sha256 (workerd has no sync crypto and hashes are needed
   *  inside SQL transactions). */
  private computeEnvelopeHash(
    logId: string,
    head: string,
    seq: number,
    prevHash: string,
    semantic: Record<string, unknown>,
  ): string {
    return sha256HexSyncText(
      logEnvelopeHashPreimage({ prevHash, logId, head, seq, semantic }),
    );
  }

  /** The hash-covered slice — the protocol's logEnvelopeSemantic. */
  private semanticSlice(
    event: LogEnvelopeSemanticInput,
  ): Record<string, unknown> {
    return logEnvelopeSemantic(event);
  }

  /**
   * Field-level diff of two semantic slices — names which compared field(s)
   * diverge (and for `payload`, which sub-keys), with values truncated. Turns a
   * generic "id-collision: different content" into an actionable diagnostic:
   * an idempotent re-append (retry/redelivery) of the SAME envelope id must have
   * byte-identical semantic content, so any difference points at a non-deterministic
   * field leaking into the journal.
   */
  private describeSemanticDivergence(
    incoming: Record<string, unknown>,
    stored: Record<string, unknown>,
  ): string {
    const isObj = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v);
    const trunc = (v: unknown): string => {
      const s = canonicalJson(v) ?? "undefined";
      return s.length > 160 ? `${s.slice(0, 160)}…(${s.length}b)` : s;
    };
    const parts: string[] = [];
    for (const key of new Set([
      ...Object.keys(incoming),
      ...Object.keys(stored),
    ])) {
      if (canonicalJson(incoming[key]) === canonicalJson(stored[key])) continue;
      if (key === "payload" && isObj(incoming[key]) && isObj(stored[key])) {
        const a = incoming[key] as Record<string, unknown>;
        const b = stored[key] as Record<string, unknown>;
        for (const pk of new Set([...Object.keys(a), ...Object.keys(b)])) {
          if (canonicalJson(a[pk]) === canonicalJson(b[pk])) continue;
          parts.push(
            `payload.${pk} (incoming=${trunc(a[pk])} stored=${trunc(b[pk])})`,
          );
        }
      } else {
        parts.push(
          `${key} (incoming=${trunc(incoming[key])} stored=${trunc(stored[key])})`,
        );
      }
    }
    return parts.length > 0
      ? parts.join(", ")
      : "(no field-level diff — likely appendedAt handling or stored-value encoding)";
  }

  private mapLogEnvelope(row: JsonRecord): LogEnvelope {
    return {
      logId: String(row["log_id"]),
      head: String(row["head"]),
      seq: asNumber(row["seq"]),
      envelopeId: brandId<EnvelopeId>(String(row["envelope_id"])),
      actor: parseRecord(asString(row["actor_json"])) as unknown as ActorRef,
      ...(row["to_json"]
        ? { to: parseJson(asString(row["to_json"])) as LogEnvelope["to"] }
        : {}),
      payloadKind: String(row["payload_kind"]),
      payload: parseJson(asString(row["payload_ref_json"])),
      ...(row["annotations_json"]
        ? { annotations: parseRecord(asString(row["annotations_json"])) }
        : {}),
      ...(row["causality_json"]
        ? {
            causality: parseRecord(
              asString(row["causality_json"]),
            ) as LogEventCausality,
          }
        : {}),
      appendedAt: String(row["appended_at"]),
      prevHash: String(row["prev_hash"]),
      hash: String(row["hash"]),
    };
  }

  private logEventWhereForSegment(
    segment: LineageSegment,
    input: Pick<ReadLogInput, "afterSeq" | "beforeSeq" | "payloadKind">,
  ): { where: string; bindings: SqlBinding[] } {
    const clauses = ["log_id = ?", "head = ?", "seq > ?"];
    const bindings: SqlBinding[] = [
      segment.logId,
      segment.head,
      input.afterSeq ?? 0,
    ];
    if (Number.isFinite(segment.throughSeq)) {
      clauses.push("seq <= ?");
      bindings.push(segment.throughSeq);
    }
    if (Number.isFinite(input.beforeSeq ?? Number.POSITIVE_INFINITY)) {
      clauses.push("seq < ?");
      bindings.push(input.beforeSeq ?? Number.POSITIVE_INFINITY);
    }
    if (input.payloadKind) {
      clauses.push("payload_kind = ?");
      bindings.push(input.payloadKind);
    }
    return { where: clauses.join(" AND "), bindings };
  }

  private lineageEventStats(input: ReadLogInput): LineageEventStats {
    let count = 0;
    let firstSeq: number | undefined;
    let lastSeq: number | undefined;
    for (const segment of this.logLineage(input.logId, input.head)) {
      const { where, bindings } = this.logEventWhereForSegment(segment, input);
      const row = this.sql
        .exec(
          `SELECT COUNT(*) AS cnt, MIN(seq) AS first_seq, MAX(seq) AS last_seq
           FROM log_events WHERE ${where}`,
          ...bindings,
        )
        .one();
      const segmentCount = asNumber(row["cnt"]);
      count += segmentCount;
      if (segmentCount > 0) {
        const segmentFirst = asNumber(row["first_seq"]);
        const segmentLast = asNumber(row["last_seq"]);
        firstSeq =
          firstSeq === undefined
            ? segmentFirst
            : Math.min(firstSeq, segmentFirst);
        lastSeq =
          lastSeq === undefined ? segmentLast : Math.max(lastSeq, segmentLast);
      }
    }
    return {
      count,
      ...(firstSeq !== undefined ? { firstSeq } : {}),
      ...(lastSeq !== undefined ? { lastSeq } : {}),
    };
  }

  @schemaRpc()
  readLog(input: ReadLogInput): LogEnvelope[] {
    this.ensureReady();
    const limit =
      input.limit == null ? null : Math.max(Math.trunc(input.limit), 0);
    if (limit === 0) return [];
    const segments = this.logLineage(input.logId, input.head);
    const collected: LogEnvelope[] = [];
    // Ancestors hold the lowest seqs: walk root-first.
    for (const segment of [...segments].reverse()) {
      const remaining = limit != null ? limit - collected.length : null;
      if (remaining != null && remaining <= 0) return collected;
      const { where, bindings } = this.logEventWhereForSegment(segment, input);
      const rows = this.sql
        .exec(
          `SELECT * FROM log_events WHERE ${where} ORDER BY seq ASC${
            remaining != null ? " LIMIT ?" : ""
          }`,
          ...(remaining != null ? [...bindings, remaining] : bindings),
        )
        .toArray() as JsonRecord[];
      for (const row of rows) {
        collected.push(this.mapLogEnvelope(row));
      }
    }
    return collected;
  }

  private readLogTail(input: ReadLogInput): LogEnvelope[] {
    this.ensureReady();
    const limit =
      input.limit == null ? null : Math.max(Math.trunc(input.limit), 0);
    if (limit === 0) return [];
    if (limit == null) return this.readLog(input);
    const collected: JsonRecord[] = [];
    for (const segment of this.logLineage(input.logId, input.head)) {
      const remaining = limit - collected.length;
      if (remaining <= 0) break;
      const { where, bindings } = this.logEventWhereForSegment(segment, input);
      const rows = this.sql
        .exec(
          `SELECT * FROM log_events WHERE ${where} ORDER BY seq DESC LIMIT ?`,
          ...bindings,
          remaining,
        )
        .toArray() as JsonRecord[];
      collected.push(...rows);
    }
    return collected.reverse().map((row) => this.mapLogEnvelope(row));
  }

  @schemaRpc()
  getLogEvent(input: {
    logId: string;
    head: string;
    envelopeId: string;
  }): LogEnvelope | null {
    this.ensureReady();
    const row = this.lineageEventRow(input.logId, input.head, input.envelopeId);
    return row ? this.mapLogEnvelope(row) : null;
  }

  @schemaRpc()
  hasLogEvents(input: {
    logId: string;
    head: string;
    envelopeIds: string[];
  }): string[] {
    this.ensureReady();
    const requested = Array.from(
      new Set(
        (Array.isArray(input.envelopeIds) ? input.envelopeIds : []).filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        ),
      ),
    );
    if (requested.length === 0) return [];

    const found = new Set<string>();
    for (const segment of this.logLineage(input.logId, input.head)) {
      const missing = requested.filter((id) => !found.has(id));
      if (missing.length === 0) break;
      for (let offset = 0; offset < missing.length; offset += 450) {
        const chunk = missing.slice(offset, offset + 450);
        const clauses = [
          "log_id = ?",
          "head = ?",
          `envelope_id IN (${chunk.map(() => "?").join(", ")})`,
        ];
        const bindings: SqlBinding[] = [segment.logId, segment.head, ...chunk];
        if (Number.isFinite(segment.throughSeq)) {
          clauses.push("seq <= ?");
          bindings.push(segment.throughSeq);
        }
        const rows = this.sql
          .exec(
            `SELECT envelope_id FROM log_events WHERE ${clauses.join(" AND ")}`,
            ...bindings,
          )
          .toArray() as JsonRecord[];
        for (const row of rows) found.add(String(row["envelope_id"]));
      }
    }
    return requested.filter((id) => found.has(id));
  }

  private lineageEventRow(
    logId: string,
    head: string,
    envelopeId: string,
  ): JsonRecord | null {
    for (const segment of this.logLineage(logId, head)) {
      const clauses = ["log_id = ?", "head = ?", "envelope_id = ?"];
      const bindings: SqlBinding[] = [segment.logId, segment.head, envelopeId];
      if (Number.isFinite(segment.throughSeq)) {
        clauses.push("seq <= ?");
        bindings.push(segment.throughSeq);
      }
      const row = this.sql
        .exec(
          `SELECT * FROM log_events WHERE ${clauses.join(" AND ")} LIMIT 1`,
          ...bindings,
        )
        .toArray()[0] as JsonRecord | undefined;
      if (row) return row;
    }
    return null;
  }
  private lineageEventBySeq(
    logId: string,
    head: string,
    seq: number,
  ): JsonRecord | null {
    for (const segment of this.logLineage(logId, head)) {
      if (Number.isFinite(segment.throughSeq) && seq > segment.throughSeq)
        continue;
      const row = this.sql
        .exec(
          `SELECT * FROM log_events WHERE log_id = ? AND head = ? AND seq = ? LIMIT 1`,
          segment.logId,
          segment.head,
          seq,
        )
        .toArray()[0] as JsonRecord | undefined;
      if (row) return row;
    }
    return null;
  }

  private lineageEventCountThrough(
    logId: string,
    head: string,
    throughSeq: number,
  ): number {
    let count = 0;
    for (const segment of this.logLineage(logId, head)) {
      const cap = Number.isFinite(segment.throughSeq)
        ? Math.min(segment.throughSeq, throughSeq)
        : throughSeq;
      count += asNumber(
        this.sql
          .exec(
            `SELECT COUNT(*) AS cnt FROM log_events WHERE log_id = ? AND head = ? AND seq <= ?`,
            segment.logId,
            segment.head,
            cap,
          )
          .one()["cnt"],
      );
    }
    return count;
  }

  @schemaRpc()
  async appendLogEvent(
    input: AppendLogEventInput,
  ): Promise<AppendLogEventResult> {
    this.ensureReady();
    const publicationWasReady = this.hasReadyPublicationDelivery(Date.now());
    const result = this.transaction(() => this.appendLogEventInTxn(input));
    if (!publicationWasReady && this.hasReadyPublicationDelivery(Date.now())) {
      this.markWorkReady("workspace-publication");
    }
    return result;
  }

  private appendLogEventInTxn(
    input: AppendLogEventInput,
  ): AppendLogEventResult {
    if (!input.logId) throw new Error("appendLogEvent requires logId");
    if (!input.head) throw new Error("appendLogEvent requires head");
    if (!input.events.length)
      throw new Error("appendLogEvent requires at least one event");

    const existingHead = this.logHeadRow(input.logId, input.head);
    if (
      existingHead &&
      String(existingHead["log_kind"]) !== String(input.logKind)
    ) {
      throw new Error(
        `log kind mismatch for ${input.logId}:${input.head}: ` +
          `${String(existingHead["log_kind"])} != ${String(input.logKind)}`,
      );
    }
    const logKind = existingHead
      ? String(existingHead["log_kind"])
      : String(input.logKind);

    const prepared = input.events.map((event) =>
      this.prepareLogEvent(
        logKind,
        logKind === "channel"
          ? this.stampChannelContent(input.logId, event)
          : event,
      ),
    );

    // Lineage-scoped idempotent replay: skip the longest already-applied prefix.
    const replayed: LogEnvelope[] = [];
    for (const event of prepared) {
      const existing = existingHead
        ? this.lineageEventRow(input.logId, input.head, event.envelopeId)
        : null;
      if (!existing) break;
      const stored = this.mapLogEnvelope(existing);
      const incomingSemantic = this.semanticSlice({
        ...event,
        appendedAt: event.appendedAtExplicit
          ? event.appendedAt
          : stored.appendedAt,
      });
      const storedSemantic = this.semanticSlice(stored);
      if (canonicalJson(incomingSemantic) !== canonicalJson(storedSemantic)) {
        if (input.idempotency === "idempotent-by-id") {
          // Client retry with a stable id and volatile payload fields:
          // first write wins, the journaled original is the result.
          replayed.push(stored);
          continue;
        }
        const divergence = this.describeSemanticDivergence(
          incomingSemantic,
          storedSemantic,
        );
        throw new Error(
          gadAppendErrorMessage(
            "id-collision",
            `log envelope id collision with different content: ${event.envelopeId} ` +
              `[log=${input.logId} head=${input.head}] diverged at → ${divergence}`,
          ),
        );
      }
      replayed.push(stored);
    }
    // Mid-batch replay: an at-least-once redelivery can compose a batch where
    // an already-journaled event follows genuinely-new ones (multi-writer task
    // logs: parent + subagent + channel redelivery both write spawn/seed
    // events). When the stored copy is semantically IDENTICAL the log is truth
    // and the duplicate is skipped (loudly, via warn). Same id with DIFFERENT
    // content remains a hard replay-mismatch failure — that is a genuine
    // causality/ordering bug, never benign redelivery.
    const midBatchReplayed: LogEnvelope[] = [];
    const remaining: typeof prepared = [];
    for (const [suffixIndex, event] of prepared
      .slice(replayed.length)
      .entries()) {
      // The prefix scan stopped precisely because this first suffix event did
      // not exist. No writes have occurred since, so querying it again in the
      // mid-batch pass cannot reveal different state.
      const existing =
        suffixIndex === 0 || !existingHead
          ? null
          : this.lineageEventRow(input.logId, input.head, event.envelopeId);
      if (!existing) {
        remaining.push(event);
        continue;
      }
      const stored = this.mapLogEnvelope(existing);
      const incomingSemantic = this.semanticSlice({
        ...event,
        appendedAt: event.appendedAtExplicit
          ? event.appendedAt
          : stored.appendedAt,
      });
      const storedSemantic = this.semanticSlice(stored);
      if (canonicalJson(incomingSemantic) !== canonicalJson(storedSemantic)) {
        const divergence = this.describeSemanticDivergence(
          incomingSemantic,
          storedSemantic,
        );
        throw new Error(
          gadAppendErrorMessage(
            "replay-mismatch",
            `log append replay has a DIVERGENT already-applied event after a new suffix ` +
              `[log=${input.logId} head=${input.head} alreadyApplied=${event.envelopeId} ` +
              `replayedPrefix=${replayed.length}/${prepared.length}] diverged at → ${divergence}`,
          ),
        );
      }
      console.warn(
        `[SemanticControlPlane] skipped already-journaled duplicate in mid-batch replay ` +
          `[log=${input.logId} head=${input.head} envelopeId=${event.envelopeId}]`,
      );
      midBatchReplayed.push(stored);
    }

    if (!existingHead) {
      this.sql.exec(
        `INSERT INTO log_heads (log_id, head, log_kind, owner_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        input.logId,
        input.head,
        logKind,
        json(input.owner ? publicActorRef(input.owner) : null),
        nowIso(),
      );
    }

    // `existingHead` is the authoritative pointer snapshot for this synchronous
    // transaction. Re-reading the row here and again after our own UPDATE adds
    // two SQLite round trips to every append without observing any state that
    // can change independently inside the transaction.
    const pointer = existingHead
      ? this.headPointer(input.logId, input.head, existingHead)
      : { seq: 0, hash: GENESIS_EVENT_HASH, envelopeId: null };
    if (
      replayed.length === 0 &&
      "expectedHeadHash" in input &&
      (input.expectedHeadHash ?? GENESIS_EVENT_HASH) !== pointer.hash
    ) {
      throw new Error(
        gadAppendErrorMessage(
          "head-conflict",
          `log head conflict for ${input.logId}:${input.head}`,
        ),
      );
    }
    if (remaining.length > 0 && replayed.length > 0) {
      const lastReplayed = replayed[replayed.length - 1]!;
      if (lastReplayed.hash !== pointer.hash) {
        throw new Error(
          gadAppendErrorMessage(
            "replay-mismatch",
            "log append replay prefix is not the current head",
          ),
        );
      }
    }

    const published: AppendLogEventResult["published"] = [];
    // Recover the publication list for replayed events from the causality edges.
    for (const envelope of [...replayed, ...midBatchReplayed]) {
      for (const publication of this.publicationsForOrigin(
        input.logId,
        input.head,
        String(envelope.envelopeId),
      )) {
        published.push(publication);
      }
    }

    const appended: LogEnvelope[] = [];
    let seq = pointer.seq;
    let prevHash = pointer.hash;
    for (const event of remaining) {
      if (
        AGENTIC_LOG_KINDS.has(logKind) &&
        event.payloadKind === "turn.opened" &&
        event.causality?.turnId
      ) {
        this.assertTurnNotOpened(
          input.logId,
          input.head,
          event.causality.turnId,
          appended,
        );
      }
      seq += 1;
      const semantic = this.semanticSlice(event);
      const hash = this.computeEnvelopeHash(
        input.logId,
        input.head,
        seq,
        prevHash,
        semantic,
      );
      const envelope: LogEnvelope = {
        logId: input.logId,
        head: input.head,
        seq,
        envelopeId: brandId<EnvelopeId>(event.envelopeId),
        actor: event.actor,
        ...(event.to !== undefined ? { to: event.to } : {}),
        payloadKind: event.payloadKind,
        payload: event.payload,
        ...(event.annotations !== undefined
          ? { annotations: event.annotations }
          : {}),
        ...(event.causality !== undefined
          ? { causality: event.causality }
          : {}),
        appendedAt: event.appendedAt,
        prevHash,
        hash,
      };
      this.insertLogEvent(envelope);
      this.applyProjections(logKind, envelope);
      prevHash = hash;
      appended.push(envelope);

      for (const target of event.publish) {
        const pubEnvelopeId = `pub:${event.envelopeId}:${target.channelId}`;
        const result = this.appendLogEventInTxn({
          logId: target.channelId,
          head: CHANNEL_LOG_HEAD,
          logKind: "channel",
          events: [
            {
              envelopeId: pubEnvelopeId,
              actor: event.actor,
              to: (target.audience ?? null) as LogAppendEventInput["to"],
              payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
              payload: agenticEventFromEnvelope(envelope),
              causality: {
                originLogId: input.logId,
                originHead: input.head,
                originEnvelopeId: event.envelopeId,
              },
              appendedAt: event.appendedAt,
            },
          ],
        });
        void result;
        published.push({
          originEnvelopeId: event.envelopeId,
          channelId: target.channelId,
          envelopeId: pubEnvelopeId,
        });
        const createdAt = Date.now();
        const itemId = JSON.stringify([target.channelId, pubEnvelopeId]);
        this.sql.exec(
          `INSERT OR IGNORE INTO publication_delivery_outbox (
             item_id, channel_id, envelope_id, idempotency_key, attempts,
             next_attempt_at, lease_generation, created_at, disposition
           ) VALUES (?, ?, ?, ?, 0, ?, 0, ?, 'ready')`,
          itemId,
          target.channelId,
          pubEnvelopeId,
          `workspace-publication:${target.channelId}:${pubEnvelopeId}`,
          createdAt,
          createdAt,
        );
      }
    }

    if (appended.length > 0) {
      const last = appended[appended.length - 1]!;
      this.sql.exec(
        `UPDATE log_heads
            SET current_seq = ?, current_hash = ?, current_envelope_id = ?
          WHERE log_id = ? AND head = ?`,
        last.seq,
        last.hash,
        String(last.envelopeId),
        input.logId,
        input.head,
      );
    }

    const lastAppended = appended[appended.length - 1];
    const finalPointer = lastAppended
      ? {
          seq: lastAppended.seq,
          hash: lastAppended.hash,
          envelopeId: String(lastAppended.envelopeId),
        }
      : pointer;
    return {
      logId: input.logId,
      head: input.head,
      headSeq: finalPointer.seq,
      headHash: finalPointer.hash,
      envelopes: [...replayed, ...midBatchReplayed, ...appended],
      published,
    };
  }

  private publicationsForOrigin(
    originLogId: string,
    originHead: string,
    originEnvelopeId: string,
  ): AppendLogEventResult["published"] {
    const rows = this.sql
      .exec(
        `SELECT log_id, envelope_id FROM log_events
         WHERE origin_log_id = ? AND origin_head = ? AND origin_envelope_id = ?
         ORDER BY log_id ASC, seq ASC`,
        originLogId,
        originHead,
        originEnvelopeId,
      )
      .toArray() as JsonRecord[];
    return rows.map((row) => ({
      originEnvelopeId,
      channelId: String(row["log_id"]),
      envelopeId: String(row["envelope_id"]),
    }));
  }

  private assertTurnNotOpened(
    logId: string,
    head: string,
    turnId: string,
    pendingBatch: LogEnvelope[],
  ): void {
    for (const envelope of pendingBatch) {
      if (
        envelope.payloadKind === "turn.opened" &&
        envelope.causality?.turnId === turnId
      ) {
        throw new Error(`duplicate turn.opened for turn ${turnId}`);
      }
    }
    for (const segment of this.logLineage(logId, head)) {
      const clauses = [
        "log_id = ?",
        "head = ?",
        "payload_kind = 'turn.opened'",
        "turn_id = ?",
      ];
      const bindings: SqlBinding[] = [segment.logId, segment.head, turnId];
      if (Number.isFinite(segment.throughSeq)) {
        clauses.push("seq <= ?");
        bindings.push(segment.throughSeq);
      }
      const exists = this.sql
        .exec(
          `SELECT 1 AS ok FROM log_events WHERE ${clauses.join(" AND ")} LIMIT 1`,
          ...bindings,
        )
        .toArray()[0];
      if (exists) throw new Error(`duplicate turn.opened for turn ${turnId}`);
    }
  }

  /** Validate + sanitize one append input into its storable form. */
  private prepareLogEvent(
    logKind: string,
    input: LogAppendEventInput,
  ): PreparedLogEvent {
    if (!input.payloadKind)
      throw new Error("appendLogEvent requires payloadKind");
    const envelopeId = input.envelopeId ?? crypto.randomUUID();
    const appendedAtExplicit = input.appendedAt != null;
    const appendedAt = input.appendedAt ?? nowIso();
    const actor = publicActorRef(input.actor) as ActorRef;
    const to = sanitizeAudience(input.to ?? undefined);
    let payload = input.payload;
    const causality = input.causality ?? undefined;
    let annotations = input.annotations ?? undefined;
    if (
      annotations &&
      "metadata" in annotations &&
      annotations["metadata"] != null
    ) {
      annotations = {
        ...annotations,
        metadata: publicParticipantMetadata(
          annotations["metadata"] as Record<string, unknown>,
        ),
      };
    }

    const agenticKind =
      AGENTIC_LOG_KINDS.has(logKind) && isStoredEventKind(input.payloadKind);
    if (agenticKind) {
      const causalityForEvent = agenticCausality(causality);
      const reconstructed = storedAgenticEventSchema.parse({
        kind: input.payloadKind,
        actor: input.actor,
        ...(causality?.turnId ? { turnId: causality.turnId } : {}),
        ...(causalityForEvent ? { causality: causalityForEvent } : {}),
        payload,
        createdAt: appendedAt,
      }) as AgenticEvent;
      const sanitized = sanitizeAgenticEventParticipantRefs(reconstructed);
      assertAgenticEventStoredValuesEncoded(sanitized);
      payload = sanitizeRosterSnapshotPayload(sanitized.payload);
    } else if (input.payloadKind === AGENTIC_EVENT_PAYLOAD_KIND) {
      if (!isAgenticEventPayload(payload)) {
        throw new Error(
          "agentic channel payload must be a stored agentic event",
        );
      }
      const parsed = storedAgenticEventSchema.parse(payload) as AgenticEvent;
      const sanitized = sanitizeAgenticEventParticipantRefs(parsed);
      assertAgenticEventStoredValuesEncoded(sanitized);
      payload = {
        ...sanitized,
        payload: sanitizeRosterSnapshotPayload(sanitized.payload),
      };
    }

    return {
      envelopeId,
      appendedAtExplicit,
      actor,
      ...(to !== undefined ? { to } : {}),
      payloadKind: input.payloadKind,
      payload,
      ...(annotations !== undefined ? { annotations } : {}),
      ...(causality !== undefined ? { causality } : {}),
      appendedAt,
      publish: input.publish?.channels ?? [],
    };
  }

  private insertLogEvent(envelope: LogEnvelope): void {
    this.sql.exec(
      `INSERT INTO log_events (
         log_id, head, seq, envelope_id, payload_kind, actor_json, to_json,
         causality_json, annotations_json, payload_ref_json, appended_at,
         hash, prev_hash, origin_log_id, origin_head, origin_envelope_id, turn_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      envelope.logId,
      envelope.head,
      envelope.seq,
      String(envelope.envelopeId),
      envelope.payloadKind,
      JSON.stringify(envelope.actor),
      envelope.to !== undefined ? JSON.stringify(envelope.to) : null,
      json(envelope.causality),
      json(envelope.annotations),
      JSON.stringify(envelope.payload),
      envelope.appendedAt,
      envelope.hash,
      envelope.prevHash,
      envelope.causality?.originLogId ?? null,
      envelope.causality?.originHead ?? null,
      envelope.causality?.originEnvelopeId ?? null,
      envelope.causality?.turnId ?? null,
    );
    for (const { path, ref } of collectStoredValueRefs(envelope.payload)) {
      this.sql.exec(
        `INSERT OR REPLACE INTO log_blob_refs (
           log_id, head, envelope_id, field_path, digest, purpose, size, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        envelope.logId,
        envelope.head,
        String(envelope.envelopeId),
        path,
        ref.digest,
        "payload",
        ref.size,
        nowIso(),
      );
      this.ensureBlob(
        ref.digest,
        ref.size,
        ref.encoding === "json" ? "application/json" : "text/plain",
      );
    }
  }

  @schemaRpc()
  forkLog(input: ForkLogInput): ForkLogResult {
    this.ensureReady();
    return this.transaction(() => {
      if (!input.fromLogId || !input.fromHead)
        throw new Error("forkLog requires a source");
      if (!input.toLogId || !input.toHead)
        throw new Error("forkLog requires a target");
      if (
        input.fromLogId === input.toLogId &&
        input.fromHead === input.toHead
      ) {
        throw new Error("forkLog requires distinct source and target");
      }
      const sourceRow = this.logHeadRow(input.fromLogId, input.fromHead);
      if (!sourceRow) {
        throw new Error(
          `forkLog source does not exist: ${input.fromLogId}:${input.fromHead}`,
        );
      }
      const sourcePointer = this.headPointer(
        input.fromLogId,
        input.fromHead,
        sourceRow,
      );
      const forkSeq = input.atSeq ?? sourcePointer.seq;
      if (forkSeq > sourcePointer.seq) {
        throw new Error(
          `forkLog atSeq ${forkSeq} is beyond the source head ${sourcePointer.seq}`,
        );
      }
      let forkHash = GENESIS_EVENT_HASH;
      let forkEnvelopeId: string | null = null;
      if (forkSeq > 0) {
        const eventRow = this.lineageEventBySeq(
          input.fromLogId,
          input.fromHead,
          forkSeq,
        );
        if (!eventRow)
          throw new Error(
            `forkLog atSeq ${forkSeq} not found in source lineage`,
          );
        forkHash = String(eventRow["hash"]);
        forkEnvelopeId = String(eventRow["envelope_id"]);
      }

      const existing = this.logHeadRow(input.toLogId, input.toHead);
      if (existing) {
        if (
          asString(existing["parent_log_id"]) !== input.fromLogId ||
          asString(existing["parent_head"]) !== input.fromHead ||
          asNumber(existing["fork_seq"]) !== forkSeq ||
          asString(existing["fork_hash"]) !== forkHash
        ) {
          throw new Error(
            `target log already exists with different fork lineage: ${input.toLogId}:${input.toHead}`,
          );
        }
        return {
          fromLogId: input.fromLogId,
          fromHead: input.fromHead,
          toLogId: input.toLogId,
          toHead: input.toHead,
          forkSeq,
          forkHash,
          inherited: this.lineageEventCountThrough(
            input.toLogId,
            input.toHead,
            forkSeq,
          ),
        };
      }

      const logKind = String(sourceRow["log_kind"]);
      this.sql.exec(
        `INSERT INTO log_heads (
           log_id, head, log_kind, owner_json, parent_log_id, parent_head,
           fork_seq, fork_hash, current_seq, current_hash, current_envelope_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.toLogId,
        input.toHead,
        logKind,
        json(input.owner ?? parseJson(asString(sourceRow["owner_json"]))),
        input.fromLogId,
        input.fromHead,
        forkSeq,
        forkHash,
        forkSeq,
        forkHash,
        forkEnvelopeId,
        nowIso(),
      );

      // Seed the child's projection caches (P1: caches, rebuildable) by folding
      // the inherited lineage view under the child key. No log rows are copied.
      const inherited = this.readLog({
        logId: input.toLogId,
        head: input.toHead,
      });
      for (const envelope of inherited) {
        this.applyProjections(logKind, {
          ...envelope,
          logId: input.toLogId,
          head: input.toHead,
        });
      }

      return {
        fromLogId: input.fromLogId,
        fromHead: input.fromHead,
        toLogId: input.toLogId,
        toHead: input.toHead,
        forkSeq,
        forkHash,
        inherited: inherited.length,
      };
    });
  }

  @schemaRpc()
  async checkLogIntegrity(
    input: { logId?: string | null; head?: string | null } = {},
  ): Promise<{ ok: boolean; errors: JsonRecord[] }> {
    this.ensureReady();
    const errors: JsonRecord[] = [];
    const clauses: string[] = [];
    const bindings: SqlBinding[] = [];
    if (input.logId) {
      clauses.push("log_id = ?");
      bindings.push(input.logId);
    }
    if (input.head) {
      clauses.push("head = ?");
      bindings.push(input.head);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const heads = this.sql
      .exec(
        `SELECT * FROM log_heads ${where} ORDER BY log_id, head`,
        ...bindings,
      )
      .toArray() as JsonRecord[];
    for (const headRow of heads) {
      const logId = String(headRow["log_id"]);
      const head = String(headRow["head"]);
      const startSeq =
        headRow["fork_seq"] == null ? 0 : asNumber(headRow["fork_seq"]);
      const startHash = asString(headRow["fork_hash"]) ?? GENESIS_EVENT_HASH;
      const rows = this.sql
        .exec(
          `SELECT * FROM log_events WHERE log_id = ? AND head = ? ORDER BY seq ASC`,
          logId,
          head,
        )
        .toArray() as JsonRecord[];
      let expectedSeq = startSeq;
      let prevHash = startHash;
      for (const row of rows) {
        const envelope = this.mapLogEnvelope(row);
        expectedSeq += 1;
        if (envelope.seq !== expectedSeq) {
          errors.push({
            type: "log-chain",
            message: `log ${logId}:${head} seq gap: expected ${expectedSeq}, found ${envelope.seq}`,
            logId,
            head,
            envelopeId: String(envelope.envelopeId),
          });
          expectedSeq = envelope.seq;
        }
        if (envelope.prevHash !== prevHash) {
          errors.push({
            type: "log-chain",
            message: `log ${logId}:${head} seq ${envelope.seq} prevHash does not link`,
            logId,
            head,
            envelopeId: String(envelope.envelopeId),
          });
        }
        const recomputed = this.computeEnvelopeHash(
          logId,
          head,
          envelope.seq,
          envelope.prevHash,
          this.semanticSlice(envelope),
        );
        if (recomputed !== envelope.hash) {
          errors.push({
            type: "log-hash",
            message: `log ${logId}:${head} seq ${envelope.seq} hash mismatch (${String(envelope.envelopeId)})`,
            logId,
            head,
            envelopeId: String(envelope.envelopeId),
          });
        }
        prevHash = envelope.hash;
      }
      const pointer = this.headPointer(logId, head, headRow);
      const lastSeq =
        rows.length > 0 ? asNumber(rows[rows.length - 1]!["seq"]) : startSeq;
      const lastHash =
        rows.length > 0 ? String(rows[rows.length - 1]!["hash"]) : startHash;
      if (pointer.seq !== lastSeq || pointer.hash !== lastHash) {
        errors.push({
          type: "log-head-pointer",
          message: `log head pointer disagrees with the stored chain for ${logId}:${head}`,
          logId,
          head,
        });
      }
    }
    return { ok: errors.length === 0, errors };
  }

  // -------------------------------------------------------------------------
  // Projections (caches over the log — P1; rebuildable at any time — P3)
  // -------------------------------------------------------------------------

  private applyProjections(logKind: string, envelope: LogEnvelope): void {
    // Roster and directory (messaging plan §4.4) are projected from the DURABLE
    // relationship facts the channel appends — subscription opened / revised /
    // ended / detached. Presence itself is a disposable presentation signal the
    // channel never appends; accepting `payloadKind:"presence"` here remains for
    // direct callers (tests, tooling) that describe a roster change that way.
    if (envelope.payloadKind === "presence") {
      this.applyChannelRosterProjection(envelope);
      return;
    }
    const rosterAction = rosterActionForPayloadKind(envelope.payloadKind);
    if (rosterAction) {
      this.applyChannelRosterProjection(envelope, rosterAction);
      return;
    }
    if (envelope.payloadKind === AGENTIC_EVENT_PAYLOAD_KIND) {
      this.projectMessageTypeEvent(envelope);
      return;
    }
    if (
      !AGENTIC_LOG_KINDS.has(logKind) ||
      !isStoredEventKind(envelope.payloadKind)
    )
      return;
    const kind = envelope.payloadKind;
    if (kind === "turn.opened" || kind === "turn.closed") {
      this.projectTurn(envelope);
      this.projectAgentDirectoryActivity(
        envelope,
        kind === "turn.opened" ? "running" : "idle",
      );
      return;
    }
    if (kind.startsWith("message.")) {
      this.projectMessage(envelope);
      return;
    }
    if (kind.startsWith("invocation.")) {
      this.projectInvocation(envelope);
      return;
    }
    if (kind.startsWith("approval.")) {
      this.projectApproval(envelope);
      return;
    }
  }

  private projectTurn(envelope: LogEnvelope): void {
    const turnId = envelope.causality?.turnId;
    if (!turnId) return;
    const payload = envelope.payload as JsonRecord;
    if (envelope.payloadKind === "turn.opened") {
      // §6.3 turn-decay basis: stamp the per-branch ordinal = count of prior
      // turns on this (log_id, head). Fork-fold seeds inherited turns first (via
      // copyProjectionKey), so ordinals stay monotone along the branch chain.
      const priorTurns = asNumber(
        this.sql
          .exec(
            `SELECT COUNT(*) AS n FROM trajectory_turns WHERE log_id = ? AND head = ?`,
            envelope.logId,
            envelope.head,
          )
          .one()["n"],
      );
      this.sql.exec(
        `INSERT OR IGNORE INTO trajectory_turns
           (log_id, head, turn_id, opened_at, summary, ordinal, trigger_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        envelope.logId,
        envelope.head,
        turnId,
        envelope.appendedAt,
        asString(payload["summary"]),
        priorTurns,
        envelope.causality?.messageId ?? null,
      );
      return;
    }
    this.sql.exec(
      `INSERT INTO trajectory_turns (log_id, head, turn_id, closed_at, summary)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(log_id, head, turn_id) DO UPDATE SET
         closed_at = excluded.closed_at,
         summary = COALESCE(excluded.summary, trajectory_turns.summary)`,
      envelope.logId,
      envelope.head,
      turnId,
      envelope.appendedAt,
      asString(payload["summary"]),
    );
  }

  private projectMessage(envelope: LogEnvelope): void {
    const messageId = envelope.causality?.messageId;
    if (!messageId) return;
    const payload = envelope.payload as JsonRecord;
    const kind = envelope.payloadKind;
    const existing = this.sql
      .exec(
        `SELECT role FROM trajectory_messages WHERE log_id = ? AND head = ? AND message_id = ?`,
        envelope.logId,
        envelope.head,
        messageId,
      )
      .toArray()[0] as JsonRecord | undefined;
    const status =
      kind === "message.completed"
        ? "completed"
        : kind === "message.failed"
          ? "failed"
          : kind === "message.delta"
            ? "streaming"
            : "started";
    this.sql.exec(
      `INSERT INTO trajectory_messages (
         log_id, head, message_id, turn_id, role, status, started_event_id, completed_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(log_id, head, message_id) DO UPDATE SET
         turn_id = COALESCE(trajectory_messages.turn_id, excluded.turn_id),
         role = COALESCE(excluded.role, trajectory_messages.role),
         status = excluded.status,
         started_event_id = COALESCE(trajectory_messages.started_event_id, excluded.started_event_id),
         completed_event_id = COALESCE(excluded.completed_event_id, trajectory_messages.completed_event_id),
         updated_at = excluded.updated_at`,
      envelope.logId,
      envelope.head,
      messageId,
      envelope.causality?.turnId ?? null,
      asString(payload["role"]) ??
        asString(existing?.["role"]) ??
        envelope.actor.kind,
      status,
      kind === "message.started" ? String(envelope.envelopeId) : null,
      kind === "message.completed" || kind === "message.failed"
        ? String(envelope.envelopeId)
        : null,
      nowIso(),
    );

    const blocks = Array.isArray(payload["blocks"]) ? payload["blocks"] : [];
    const memoryTexts: string[] = [];
    blocks.forEach((block, index) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return;
      const record = block as JsonRecord;
      const blockId =
        asString(record["blockId"]) ?? `${messageId}:block:${index}`;
      this.sql.exec(
        `INSERT OR REPLACE INTO trajectory_message_blocks (
           log_id, head, block_id, message_id, block_index, block_type, invocation_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        envelope.logId,
        envelope.head,
        blockId,
        messageId,
        index,
        asString(record["type"]) ?? "data",
        asString(record["invocationId"]),
      );
      if (record["type"] === "text" && typeof record["content"] === "string") {
        memoryTexts.push(record["content"]);
      }
    });
    // Memory index (WS4): completed message text becomes searchable.
    if (kind === "message.completed" && memoryTexts.length > 0) {
      this.indexMemoryRow({
        text: memoryTexts.join("\n"),
        kind: "message",
        logId: envelope.logId,
        head: envelope.head,
        eventId: String(envelope.envelopeId),
        anchor: { messageId, turnId: envelope.causality?.turnId ?? null },
      });
    }
    // A deliberate `notify` (wire saliency "say") is the instance's own account
    // of what it is doing, so it refreshes the directory summary. Ordinary turn
    // narration deliberately does not.
    if (
      kind === "message.completed" &&
      payload["saliency"] === "say" &&
      memoryTexts.length > 0
    ) {
      this.projectAgentDirectorySummary(envelope, memoryTexts.join("\n"));
    }
  }

  private projectInvocation(envelope: LogEnvelope): void {
    const invocationId = envelope.causality?.invocationId;
    if (!invocationId) return;
    const kind = envelope.payloadKind;
    const existing = this.sql
      .exec(
        `SELECT * FROM trajectory_invocations WHERE log_id = ? AND head = ? AND invocation_id = ?`,
        envelope.logId,
        envelope.head,
        invocationId,
      )
      .toArray()[0] as JsonRecord | undefined;
    if (
      TERMINAL_INVOCATION_KINDS.has(kind) &&
      existing &&
      TERMINAL_INVOCATION_KINDS.has(`invocation.${String(existing["status"])}`)
    ) {
      if (
        this.matchesExistingTerminalInvocation(envelope, existing) ||
        this.matchesExistingTerminalProjection(envelope, existing)
      ) {
        return;
      }
      throw new Error(
        `duplicate terminal invocation event for ${invocationId}`,
      );
    }
    const payload = envelope.payload as JsonRecord;
    if (kind === "invocation.output" || kind === "invocation.progress") {
      this.sql.exec(
        `INSERT OR IGNORE INTO trajectory_invocation_outputs (
           log_id, head, invocation_id, seq, chunk_ref_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        envelope.logId,
        envelope.head,
        invocationId,
        envelope.seq,
        JSON.stringify(payload),
        envelope.appendedAt,
      );
    }
    this.sql.exec(
      `INSERT INTO trajectory_invocations (
         log_id, head, invocation_id, turn_id, transport_call_id, kind, status, terminal_outcome,
         terminal_reason_code, request_ref_json, result_ref_json, started_event_id, completed_event_id,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(log_id, head, invocation_id) DO UPDATE SET
         turn_id = COALESCE(trajectory_invocations.turn_id, excluded.turn_id),
         transport_call_id = COALESCE(excluded.transport_call_id, trajectory_invocations.transport_call_id),
         kind = COALESCE(excluded.kind, trajectory_invocations.kind),
         status = excluded.status,
         terminal_outcome = COALESCE(excluded.terminal_outcome, trajectory_invocations.terminal_outcome),
         terminal_reason_code = COALESCE(excluded.terminal_reason_code, trajectory_invocations.terminal_reason_code),
         request_ref_json = COALESCE(excluded.request_ref_json, trajectory_invocations.request_ref_json),
         result_ref_json = COALESCE(excluded.result_ref_json, trajectory_invocations.result_ref_json),
         started_event_id = COALESCE(trajectory_invocations.started_event_id, excluded.started_event_id),
         completed_event_id = COALESCE(excluded.completed_event_id, trajectory_invocations.completed_event_id),
         updated_at = excluded.updated_at`,
      envelope.logId,
      envelope.head,
      invocationId,
      envelope.causality?.turnId ?? null,
      envelope.causality?.transportCallId ?? null,
      asString(payload["name"]),
      kind.replace("invocation.", ""),
      asString(payload["terminalOutcome"]),
      asString(payload["terminalReasonCode"]),
      kind === "invocation.started" ? json(payload["request"]) : null,
      kind === "invocation.completed" ? json(payload["result"]) : null,
      kind === "invocation.started" ? String(envelope.envelopeId) : null,
      TERMINAL_INVOCATION_KINDS.has(kind) ? String(envelope.envelopeId) : null,
      nowIso(),
    );
  }

  private matchesExistingTerminalInvocation(
    envelope: LogEnvelope,
    existing: JsonRecord,
  ): boolean {
    const completedEventId = asString(existing["completed_event_id"]);
    if (!completedEventId) return false;
    const priorRow = this.lineageEventRow(
      envelope.logId,
      envelope.head,
      completedEventId,
    );
    if (!priorRow) return false;
    const prior = this.mapLogEnvelope(priorRow);
    return (
      terminalInvocationSignatureFromEnvelope(prior) ===
      terminalInvocationSignatureFromEnvelope(envelope)
    );
  }

  private matchesExistingTerminalProjection(
    envelope: LogEnvelope,
    existing: JsonRecord,
  ): boolean {
    const payload = envelope.payload as JsonRecord;
    const nextStatus = envelope.payloadKind.replace("invocation.", "");
    if (asString(existing["status"]) !== nextStatus) return false;
    if (
      asString(existing["terminal_outcome"]) !==
      asString(payload["terminalOutcome"])
    ) {
      return false;
    }
    // The first terminal event owns the projection. Later terminals with the
    // same status/outcome can be replays from runner recovery; preserve the
    // first row, keep the raw duplicate in the log.
    return true;
  }

  private projectApproval(envelope: LogEnvelope): void {
    const approvalId = envelope.causality?.approvalId;
    if (!approvalId) return;
    const payload = envelope.payload as JsonRecord;
    const kind = envelope.payloadKind;
    const status =
      kind === "approval.resolved"
        ? payload["granted"] === true
          ? "granted"
          : "denied"
        : "requested";
    // Approvals resolve once: reject a second terminal against an already
    // granted/denied approval so a duplicate cannot overwrite the decision.
    if (kind === "approval.resolved") {
      const existing = this.sql
        .exec(
          `SELECT status FROM trajectory_approvals WHERE log_id = ? AND head = ? AND approval_id = ?`,
          envelope.logId,
          envelope.head,
          approvalId,
        )
        .toArray()[0] as JsonRecord | undefined;
      const existingStatus = existing ? String(existing["status"]) : null;
      if (existingStatus === "granted" || existingStatus === "denied") {
        throw new Error(`duplicate terminal approval event for ${approvalId}`);
      }
    }
    this.sql.exec(
      `INSERT INTO trajectory_approvals (
         log_id, head, approval_id, invocation_id, status, requested_by_json, resolved_by_json,
         requested_event_id, resolved_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(log_id, head, approval_id) DO UPDATE SET
         status = excluded.status,
         resolved_by_json = COALESCE(excluded.resolved_by_json, trajectory_approvals.resolved_by_json),
         resolved_event_id = COALESCE(excluded.resolved_event_id, trajectory_approvals.resolved_event_id),
         updated_at = excluded.updated_at`,
      envelope.logId,
      envelope.head,
      approvalId,
      envelope.causality?.invocationId ?? null,
      status,
      // WP5 §5 — provenance rows carry the acting/resolving ACCOUNT (userId+
      // handle) hoisted from actor metadata; actor.kind stays semantic, never
      // rewritten to "user". The resolved path falls back to the envelope actor
      // when payload.resolvedBy itself did not carry the account.
      kind === "approval.requested" ? approvalActorJson(envelope.actor) : null,
      kind === "approval.resolved"
        ? approvalActorJson(payload["resolvedBy"], envelope.actor?.metadata)
        : null,
      kind === "approval.requested" ? String(envelope.envelopeId) : null,
      kind === "approval.resolved" ? String(envelope.envelopeId) : null,
      nowIso(),
    );
  }

  private applyChannelRosterProjection(
    envelope: LogEnvelope,
    impliedAction?: "join" | "update" | "leave",
  ): void {
    const payload =
      envelope.payload && typeof envelope.payload === "object"
        ? (envelope.payload as JsonRecord)
        : {};
    const action = impliedAction ?? asString(payload["action"]);
    if (action !== "join" && action !== "update" && action !== "leave") return;
    const actor = envelope.actor as unknown as JsonRecord;
    const participantId =
      asString(payload["participantId"]) ??
      asString(actor["participantId"]) ??
      asString(actor["id"]);
    if (!participantId) return;
    const channelId = envelope.logId;
    const metadata = parseRecord(
      JSON.stringify(
        payload["metadata"] ??
          envelope.annotations?.["metadata"] ??
          actor["metadata"] ??
          null,
      ),
    );
    const rolesJson =
      Object.keys(metadata).length > 0
        ? JSON.stringify(sortForCanonicalJson(metadata))
        : null;
    const openRow = this.sql
      .exec(
        `SELECT joined_at FROM channel_roster
         WHERE channel_id = ? AND participant_id = ? AND left_at IS NULL
         ORDER BY joined_at DESC
         LIMIT 1`,
        channelId,
        participantId,
      )
      .toArray()[0] as JsonRecord | undefined;

    this.projectAgentDirectoryPresence(envelope, {
      action,
      channelId,
      participantId,
      metadata,
    });

    if (action === "join") {
      if (openRow) {
        if (rolesJson) {
          this.sql.exec(
            `UPDATE channel_roster
             SET roles_json = ?
             WHERE channel_id = ? AND participant_id = ? AND joined_at = ?`,
            rolesJson,
            channelId,
            participantId,
            String(openRow["joined_at"]),
          );
        }
        return;
      }
      this.sql.exec(
        `INSERT OR IGNORE INTO channel_roster (channel_id, participant_id, joined_at, roles_json)
         VALUES (?, ?, ?, ?)`,
        channelId,
        participantId,
        envelope.appendedAt,
        rolesJson,
      );
      return;
    }

    if (!openRow) return;
    if (action === "update") {
      if (rolesJson) {
        this.sql.exec(
          `UPDATE channel_roster
           SET roles_json = ?
           WHERE channel_id = ? AND participant_id = ? AND joined_at = ?`,
          rolesJson,
          channelId,
          participantId,
          String(openRow["joined_at"]),
        );
      }
      return;
    }

    this.sql.exec(
      `UPDATE channel_roster
       SET left_at = COALESCE(left_at, ?),
           roles_json = COALESCE(?, roles_json)
       WHERE channel_id = ? AND participant_id = ? AND joined_at = ?`,
      envelope.appendedAt,
      rolesJson,
      channelId,
      participantId,
      String(openRow["joined_at"]),
    );
  }

  // -------------------------------------------------------------------------
  // Agent directory (messaging plan §4.4) — the discovery projection
  // -------------------------------------------------------------------------

  /**
   * One-time backfill. Until 2026-08-17 the roster/directory projection was
   * fed only by `payloadKind:"presence"` envelopes, which the channel never
   * appends (presence is a disposable signal); the durable relationship facts
   * — `channel.subscription.*` — were ignored. Existing workspaces therefore
   * hold every join in their channel logs and nothing in the projection.
   * Replay just those facts once, in log order, and remember that it happened.
   */
  private static readonly ROSTER_BACKFILL_MARKER =
    "roster-projection:subscription-facts:v1";

  protected override afterSchemaReady(): void {
    super.afterSchemaReady();
    if (this.getStateValue(GadWorkspaceDO.ROSTER_BACKFILL_MARKER)) return;
    const rows = this.sql
      .exec(
        `SELECT * FROM log_events
          WHERE payload_kind IN (
            'channel.subscription.opened', 'channel.subscription.revised',
            'channel.subscription.ended', 'channel.subscription.detached')
          ORDER BY log_id ASC, head ASC, seq ASC`,
      )
      .toArray() as JsonRecord[];
    for (const row of rows) {
      const envelope = this.mapLogEnvelope(row);
      const action = rosterActionForPayloadKind(envelope.payloadKind);
      if (action) this.applyChannelRosterProjection(envelope, action);
    }
    this.setStateValue(
      GadWorkspaceDO.ROSTER_BACKFILL_MARKER,
      new Date().toISOString(),
    );
  }

  private agentDirectoryIndexMode: "fts" | "plain" | null = null;

  private ensureAgentDirectoryIndex(): "fts" | "plain" {
    if (this.agentDirectoryIndexMode) return this.agentDirectoryIndexMode;
    // createTables() runs from the base constructor before subclass field
    // initializers, so this cache cannot be seeded there.
    this.agentDirectoryIndexMode =
      existingAgentDirectoryIndexMode(this.sql) ??
      createAgentDirectoryIndex(this.sql);
    return this.agentDirectoryIndexMode;
  }

  /** Keep the searchable text for one instance in step with its row. */
  private indexAgentDirectoryRow(row: {
    instanceId: string;
    channelId: string;
    status: string;
    text: string;
  }): void {
    this.ensureAgentDirectoryIndex();
    this.sql.exec(
      `DELETE FROM gad_agent_directory_fts WHERE instance_id = ?`,
      row.instanceId,
    );
    if (!row.text.trim()) return;
    this.sql.exec(
      `INSERT INTO gad_agent_directory_fts (text, instance_id, channel_id, status)
       VALUES (?, ?, ?, ?)`,
      row.text,
      row.instanceId,
      row.channelId,
      row.status,
    );
  }

  private reindexAgentDirectoryInstance(instanceId: string): void {
    const row = this.sql
      .exec(
        `SELECT channel_id, status, handle, display_name, description, summary
           FROM agent_directory WHERE instance_id = ?`,
        instanceId,
      )
      .toArray()[0] as JsonRecord | undefined;
    if (!row) return;
    this.indexAgentDirectoryRow({
      instanceId,
      channelId: String(row["channel_id"]),
      status: String(row["status"]),
      text: [
        row["handle"],
        row["display_name"],
        row["description"],
        row["summary"],
      ]
        .map((value) => asString(value) ?? "")
        .filter(Boolean)
        .join(" — "),
    });
  }

  /**
   * Presence is the identity writer: a join names the handle, kind, and
   * description, and a leave is the only *fact* that an instance is done with a
   * channel. Terminal rows are kept, not deleted — a historical agent whose
   * channel is durable is exactly the "agent to wake up" catalog.
   */
  private projectAgentDirectoryPresence(
    envelope: LogEnvelope,
    input: {
      action: string;
      channelId: string;
      participantId: string;
      metadata: JsonRecord;
    },
  ): void {
    const type = asString(input.metadata["type"]);
    // Humans and panels are addressable, but they are not agent *instances*;
    // the roster projection already answers "who is on this channel".
    if (type !== "agent" && type !== "headless") return;
    const handle = asString(input.metadata["handle"]) ?? input.participantId;
    const instanceId = `${handle}@${input.channelId}`;
    const subagent = parseRecord(
      JSON.stringify(input.metadata["subagent"] ?? null),
    );
    const subagentRunId =
      asString(subagent["runId"]) ??
      asString(input.metadata["subagentRunId"]) ??
      null;
    const status = input.action === "leave" ? "terminal" : "idle";
    this.sql.exec(
      `INSERT INTO agent_directory
         (instance_id, channel_id, participant_id, kind, handle, display_name, description,
          parent_instance_id, run_id, worker_id, owner_user_id, status, status_event_id,
          last_activity_at, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(instance_id) DO UPDATE SET
         participant_id = excluded.participant_id,
         kind = COALESCE(excluded.kind, agent_directory.kind),
         display_name = COALESCE(excluded.display_name, agent_directory.display_name),
         description = COALESCE(excluded.description, agent_directory.description),
         parent_instance_id = COALESCE(excluded.parent_instance_id, agent_directory.parent_instance_id),
         run_id = COALESCE(excluded.run_id, agent_directory.run_id),
         worker_id = excluded.worker_id,
         owner_user_id = COALESCE(excluded.owner_user_id, agent_directory.owner_user_id),
         status = excluded.status,
         status_event_id = excluded.status_event_id,
         last_activity_at = excluded.last_activity_at`,
      instanceId,
      input.channelId,
      input.participantId,
      subagentRunId
        ? "subagent"
        : (asString(input.metadata["kind"]) ?? "worker-agent"),
      handle,
      asString(input.metadata["name"]),
      asString(input.metadata["description"]),
      asString(subagent["parentInstanceId"]),
      subagentRunId,
      input.participantId,
      asString(input.metadata["ownerUserId"]),
      status,
      envelope.envelopeId,
      Date.parse(envelope.appendedAt ?? "") || null,
    );
    this.reindexAgentDirectoryInstance(instanceId);
  }

  /**
   * Status flips on *events*, never on elapsed time: a turn opening is the fact
   * that this instance is running, a turn closing that it is idle. There is no
   * clock-driven "went quiet" transition anywhere in this projection —
   * `last_activity_at` is informational and gates nothing.
   */
  private projectAgentDirectoryActivity(
    envelope: LogEnvelope,
    status: "running" | "idle",
  ): void {
    const channelId = channelIdFromTrajectoryLog(envelope.logId);
    if (!channelId) return;
    const actor = envelope.actor as unknown as JsonRecord;
    const participantId =
      asString(actor["participantId"]) ?? asString(actor["id"]);
    if (!participantId) return;
    this.sql.exec(
      `UPDATE agent_directory
          SET status = CASE WHEN status = 'terminal' THEN status ELSE ? END,
              status_event_id = ?,
              last_activity_at = ?
        WHERE channel_id = ? AND participant_id = ?`,
      status,
      envelope.envelopeId,
      Date.parse(envelope.appendedAt ?? "") || null,
      channelId,
      participantId,
    );
  }

  /** A deliberate utterance is the best self-description an instance produces,
   *  so it is what `discover_agents` searches — not a transcript dump. */
  private projectAgentDirectorySummary(
    envelope: LogEnvelope,
    summary: string,
  ): void {
    const channelId = channelIdFromTrajectoryLog(envelope.logId);
    if (!channelId) return;
    const actor = envelope.actor as unknown as JsonRecord;
    const participantId =
      asString(actor["participantId"]) ?? asString(actor["id"]);
    if (!participantId) return;
    const trimmed = summary.trim().slice(0, 400);
    if (!trimmed) return;
    this.sql.exec(
      `UPDATE agent_directory SET summary = ?, last_activity_at = ?
        WHERE channel_id = ? AND participant_id = ?`,
      trimmed,
      Date.parse(envelope.appendedAt ?? "") || null,
      channelId,
      participantId,
    );
    const row = this.sql
      .exec(
        `SELECT instance_id FROM agent_directory WHERE channel_id = ? AND participant_id = ?`,
        channelId,
        participantId,
      )
      .toArray()[0] as JsonRecord | undefined;
    if (row) this.reindexAgentDirectoryInstance(String(row["instance_id"]));
  }

  // -------------------------------------------------------------------------
  // Memory (WS4) — FTS index over messages/files/commits + provenance recall
  // -------------------------------------------------------------------------

  /** "fts" under workerd SQLite; "plain" (LIKE search) where FTS5 is absent
   *  (the sql.js test harness). Same write/read logic either way. */
  private memoryIndexMode: "fts" | "plain" | null = null;

  private ensureMemoryIndex(): "fts" | "plain" {
    if (this.memoryIndexMode) return this.memoryIndexMode;
    // createTables() runs from the base constructor before subclass field
    // initializers, so its selected fallback mode cannot safely live only in
    // this field. Re-derive it from the sealed schema on first use.
    this.memoryIndexMode =
      existingMemoryIndexMode(this.sql) ?? createMemoryIndex(this.sql);
    return this.memoryIndexMode;
  }

  /** Reconcile searchable commit documents from the semantic event DAG. The
   * recall index is disposable; workspace events and their authored work-unit
   * intents remain the authority. */
  private ensureCommitMemoryIndex(): void {
    this.ensureMemoryIndex();

    // Commit memory originally indexed only the event message. Rebuild that
    // disposable projection once so existing workspaces gain the authored
    // intent terms as well; subsequent calls only project newly committed
    // events. This marker is deliberately internal rather than part of the
    // public file-index marker namespace.
    const projectionVersionKey = "memory:commit-projection-version";
    const projectionVersion = "2";
    if (this.getStateValue(projectionVersionKey) !== projectionVersion) {
      this.sql.exec(
        `DELETE FROM gad_memory_fts
          WHERE kind = 'commit'
            AND event_id IN (SELECT event_id FROM gad_workspace_events)`,
      );
    }

    const missing = this.sql
      .exec(
        `SELECT e.event_id,
                e.result_workspace_fact_root_id,
                e.message,
                (
                  SELECT GROUP_CONCAT(intent_summary, CHAR(10))
                    FROM (
                      SELECT DISTINCT TRIM(w.intent_summary) AS intent_summary
                        FROM gad_workspace_event_applications ea
                        JOIN gad_work_unit_applications a
                          ON a.application_id = ea.application_id
                        JOIN gad_work_units w
                          ON w.work_unit_id = a.work_unit_id
                       WHERE ea.event_id = e.event_id
                         AND TRIM(COALESCE(w.intent_summary, '')) <> ''
                       ORDER BY ea.ordinal
                    )
                ) AS intent_summaries
           FROM gad_workspace_events e
          WHERE e.kind <> 'genesis'
            AND NOT EXISTS (
              SELECT 1 FROM gad_memory_fts m
               WHERE m.kind = 'commit'
                 AND m.event_id = e.event_id
            )`,
      )
      .toArray() as JsonRecord[];
    for (const row of missing) {
      const message = asString(row["message"])?.trim();
      const intentSummaries = asString(row["intent_summaries"])?.trim();
      const summary = [message, intentSummaries]
        .filter((part): part is string => Boolean(part))
        .filter((part, index, parts) => parts.indexOf(part) === index)
        .join("\n");
      const eventId = asString(row["event_id"]);
      const workspaceFactRootId = asString(
        row["result_workspace_fact_root_id"],
      );
      if (!summary || !eventId || !workspaceFactRootId) continue;
      this.indexMemoryRow({
        text: summary,
        kind: "commit",
        eventId,
        anchor: { workspaceEventId: eventId, workspaceFactRootId },
      });
    }
    this.setStateValue(projectionVersionKey, projectionVersion);
  }

  private indexMemoryRow(row: {
    text: string;
    kind: "message" | "file" | "commit";
    logId?: string | null;
    head?: string | null;
    eventId?: string | null;
    path?: string | null;
    contentHash?: string | null;
    anchor?: Record<string, unknown> | null;
  }): void {
    this.ensureMemoryIndex();
    const text = row.text.slice(0, 64_000);
    if (!text.trim()) return;
    // Event rows index once per (event, log, head) — idempotent replay; files
    // keep only their latest content.
    if (row.eventId) {
      this.sql.exec(
        `DELETE FROM gad_memory_fts
          WHERE event_id = ?
            AND COALESCE(log_id, '') = COALESCE(?, '')
            AND COALESCE(head, '') = COALESCE(?, '')`,
        row.eventId,
        row.logId ?? null,
        row.head ?? null,
      );
    } else if (row.path) {
      this.sql.exec(
        `DELETE FROM gad_memory_fts WHERE path = ? AND kind = 'file'`,
        row.path,
      );
    }
    this.sql.exec(
      `INSERT INTO gad_memory_fts (text, kind, log_id, head, event_id, path, content_hash, anchor_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      text,
      row.kind,
      row.logId ?? null,
      row.head ?? null,
      row.eventId ?? null,
      row.path ?? null,
      row.contentHash ?? null,
      row.anchor ? JSON.stringify(row.anchor) : null,
    );
  }

  /** Batch file-text indexing (the server pushes changed file text — bytes
   *  live in the filesystem CAS, not in this DO). */
  @schemaRpc()
  indexMemoryFiles(input: {
    files: Array<{ path: string; contentHash: string; text: string }>;
    removedPaths?: string[] | null;
  }): { indexed: number } {
    this.ensureReady();
    this.ensureMemoryIndex();
    for (const removed of input.removedPaths ?? []) {
      this.sql.exec(
        `DELETE FROM gad_memory_fts WHERE path = ? AND kind = 'file'`,
        removed,
      );
    }
    for (const file of input.files) {
      this.indexMemoryRow({
        text: file.text,
        kind: "file",
        path: file.path,
        contentHash: file.contentHash,
      });
    }
    return { indexed: input.files.length };
  }

  /** Index marker (P1 cache pointer): which state the file index reflects. */
  @schemaRpc()
  getMemoryIndexMarker(input: { key: string }): { value: string | null } {
    this.ensureReady();
    return { value: this.getStateValue(`memidx:${input.key}`) };
  }

  @schemaRpc()
  setMemoryIndexMarker(input: { key: string; value: string }): void {
    this.ensureReady();
    this.setStateValue(`memidx:${input.key}`, input.value);
  }

  /**
   * Search the memory index. Results carry provenance: the matching row's
   * anchor plus (for event-anchored rows) the event's actor and timestamp,
   * and (for file rows) the current content hash.
   */
  @schemaRpc()
  recallMemory(input: {
    query: string;
    kinds?: string[] | null;
    limit?: number | null;
    /** Workspace-relative repo path prefixes to scope file results to. A row is
     *  kept when its `path` is null (non-file entries: messages/commits)
     *  or falls under one of these prefixes. Applied IN the query so `limit`
     *  bounds the scoped result set, not an unfiltered page scoping then
     *  decimates. */
    pathPrefixes?: string[] | null;
    /** Steering keywords OR-appended to the query's FTS match to widen recall
     *  (§7.1/§6, C6). A bonus signal, never load-bearing: they broaden what
     *  matches, never filter it out, and never outrank the base query. */
    recallKeywords?: string[] | null;
  }): {
    results: Array<{
      kind: string;
      snippet: string;
      score: number | null;
      logId: string | null;
      head: string | null;
      eventId: string | null;
      path: string | null;
      contentHash: string | null;
      anchor: Record<string, unknown> | null;
      actor: unknown;
      appendedAt: string | null;
    }>;
  } {
    this.ensureReady();
    const mode = this.ensureMemoryIndex();
    const limit = Math.min(input.limit ?? 10, 50);
    // Over-fetch so published/fork copies (the same logical item indexed under
    // several (log,head) pairs) can be collapsed BEFORE the page is sliced —
    // otherwise duplicates eat slots and the caller's page under-fills (§8.1/C6).
    const fetchLimit = Math.min(limit * 3, 150);
    const kinds = input.kinds && input.kinds.length > 0 ? input.kinds : null;
    if (kinds === null || kinds.includes("commit"))
      this.ensureCommitMemoryIndex();
    const pathPrefixes =
      input.pathPrefixes && input.pathPrefixes.length > 0
        ? input.pathPrefixes
        : null;
    // (path IS NULL OR path = pre OR path LIKE 'pre/%') for each prefix, OR-ed.
    const pathFilter = pathPrefixes
      ? ` AND (path IS NULL OR ${pathPrefixes
          .map(() => `(path = ? OR path LIKE ? ESCAPE '\\')`)
          .join(" OR ")})`
      : "";
    const pathBindings = pathPrefixes
      ? pathPrefixes.flatMap((pre) => [
          pre,
          `${pre.replace(/[%_\\]/gu, "\\$&")}/%`,
        ])
      : [];
    let rows: JsonRecord[];
    if (mode === "fts") {
      const queryTerms = recallTokens([input.query]);
      const baseMatch = ftsQuery(queryTerms, " ");
      // Keyword steering only WIDENS: OR the base query with the keyword terms so
      // recall matches either — never AND-ed (would narrow), never load-bearing.
      const keywordMatch = recallTokens(input.recallKeywords)
        .map((term) => `"${term}"`)
        .join(" OR ");
      const match = keywordMatch
        ? baseMatch
          ? `(${baseMatch}) OR ${keywordMatch}`
          : keywordMatch
        : baseMatch;
      if (!match) return { results: [] };
      const kindFilter = kinds
        ? ` AND kind IN (${kinds.map(() => "?").join(",")})`
        : "";
      const queryRows = (candidateMatch: string): JsonRecord[] =>
        this.sql
          .exec(
            `SELECT text, kind, log_id, head, event_id, path, content_hash, anchor_json,
                  bm25(gad_memory_fts) AS score
             FROM gad_memory_fts
            WHERE gad_memory_fts MATCH ?${kindFilter}${pathFilter}
            ORDER BY score LIMIT ?`,
            candidateMatch,
            ...(kinds ?? []),
            ...pathBindings,
            fetchLimit,
          )
          .toArray() as JsonRecord[];
      rows = queryRows(match);
      // Natural recall queries often mix a repository/path hint with the
      // distinctive remembered phrase. Preserve precise all-term matching
      // first, then widen only an empty page instead of making callers learn
      // FTS query syntax or repeatedly guess which term the index retained.
      if (rows.length === 0 && queryTerms.length > 1) {
        const broadBase = ftsQuery(queryTerms, " OR ");
        const broadMatch = keywordMatch
          ? `(${broadBase}) OR ${keywordMatch}`
          : broadBase;
        rows = queryRows(broadMatch);
      }
    } else {
      const queryTerms = recallTokens([input.query]);
      const keywordTerms = recallTokens(input.recallKeywords);
      if (queryTerms.length === 0 && keywordTerms.length === 0)
        return { results: [] };
      const kindFilter = kinds
        ? ` AND kind IN (${kinds.map(() => "?").join(",")})`
        : "";
      const queryRows = (operator: " AND " | " OR "): JsonRecord[] => {
        const likeBindings: string[] = [];
        const likeOf = (term: string): string => {
          likeBindings.push(`%${term.replace(/[%_\\]/gu, "\\$&")}%`);
          return `text LIKE ? ESCAPE '\\'`;
        };
        const baseClause = queryTerms.length
          ? `(${queryTerms.map(likeOf).join(operator)})`
          : "";
        const keywordClause = keywordTerms.length
          ? keywordTerms.map(likeOf).join(" OR ")
          : "";
        const matchClause =
          baseClause && keywordClause
            ? `(${baseClause} OR ${keywordClause})`
            : baseClause || keywordClause;
        return this.sql
          .exec(
            `SELECT text, kind, log_id, head, event_id, path, content_hash, anchor_json,
                  NULL AS score
             FROM gad_memory_fts
            WHERE ${matchClause}${kindFilter}${pathFilter}
            LIMIT ?`,
            ...likeBindings,
            ...(kinds ?? []),
            ...pathBindings,
            fetchLimit,
          )
          .toArray() as JsonRecord[];
      };
      rows = queryRows(" AND ");
      if (rows.length === 0 && queryTerms.length > 1) rows = queryRows(" OR ");
    }

    const pageRows = this.dedupRecallRows(rows, limit);
    const results = pageRows.map((row) => {
      const eventId = asString(row["event_id"]);
      const logId = asString(row["log_id"]);
      const head = asString(row["head"]);
      let actor: unknown = null;
      let appendedAt: string | null = null;
      if (eventId && logId && head) {
        const event = this.getLogEvent({ logId, head, envelopeId: eventId });
        if (event) {
          actor = event.actor;
          appendedAt = event.appendedAt;
        }
      }
      const text = String(row["text"]);
      return {
        kind: String(row["kind"]),
        snippet: snippetAround(text, input.query),
        score: row["score"] == null ? null : asNumber(row["score"]),
        logId,
        head,
        eventId,
        path: asString(row["path"]),
        contentHash: asString(row["content_hash"]),
        anchor: parseJson(asString(row["anchor_json"])) as Record<
          string,
          unknown
        > | null,
        actor,
        appendedAt,
      };
    });
    return { results };
  }

  /**
   * Collapse published/fork copies of the same logical memory item before the
   * page is sliced (§8.1/C6). A `message.completed` published to a channel, and
   * every projection copied into a fork head by `copyProjectionKey`, produce
   * distinct FTS rows that share (kind, event_id) but differ in (log_id, head).
   * Dedup by (kind, event_id) — or (kind, text) for entries with no event id
   * (files) — keeping the trajectory-log copy over a channel republish, then
   * slice to the caller's limit. Rows arrive best-first (fts bm25 order), so the
   * first occurrence holds the ranking slot; a later trajectory copy only swaps
   * its metadata in.
   */
  private dedupRecallRows(rows: JsonRecord[], limit: number): JsonRecord[] {
    const trajectoryLogs = this.trajectoryLogIds(rows);
    const isTrajectory = (row: JsonRecord): boolean => {
      const logId = asString(row["log_id"]);
      return logId != null && trajectoryLogs.has(logId);
    };
    const slotByKey = new Map<string, number>();
    const kept: JsonRecord[] = [];
    for (const row of rows) {
      const kind = String(row["kind"]);
      const eventId = asString(row["event_id"]);
      const key = `${kind}\u0001${eventId ?? `t:${String(row["text"])}`}`;
      const slot = slotByKey.get(key);
      if (slot === undefined) {
        slotByKey.set(key, kept.length);
        kept.push(row);
      } else if (!isTrajectory(kept[slot]!) && isTrajectory(row)) {
        kept[slot] = row;
      }
    }
    return kept.slice(0, limit);
  }

  /** The subset of the rows' `log_id`s that belong to trajectory logs — used to
   *  prefer a trajectory copy over a channel republish during recall dedup. One
   *  batched lookup over `log_heads`; a `log_id`'s kind is stable across heads. */
  private trajectoryLogIds(rows: JsonRecord[]): Set<string> {
    const logIds = [
      ...new Set(
        rows
          .map((row) => asString(row["log_id"]))
          .filter((v): v is string => v != null),
      ),
    ];
    if (logIds.length === 0) return new Set();
    const placeholders = logIds.map(() => "?").join(",");
    const found = this.sql
      .exec(
        `SELECT DISTINCT log_id FROM log_heads WHERE log_kind = 'trajectory' AND log_id IN (${placeholders})`,
        ...logIds,
      )
      .toArray() as JsonRecord[];
    return new Set(found.map((row) => String(row["log_id"])));
  }

  // -------------------------------------------------------------------------
  // Projection replay (cache amnesia recovery — P3)
  // -------------------------------------------------------------------------

  async replayTrajectoryProjections(): Promise<{ replayed: number }> {
    this.ensureReady();
    return this.transaction(() => {
      this.clearProjections();
      let replayed = 0;
      const prefixCache = new Map<string, ProjectionKey | null>();
      const temporaryKeys: ProjectionKey[] = [];
      const heads = this.sql
        .exec(
          `SELECT * FROM log_heads ORDER BY created_at ASC, log_id ASC, head ASC`,
        )
        .toArray() as JsonRecord[];

      const materializePrefix = (
        logId: string,
        head: string,
        throughSeq: number,
      ): ProjectionKey | null => {
        if (throughSeq <= 0) return null;
        const cacheKey = `${logId}\u0000${head}\u0000${throughSeq}`;
        if (prefixCache.has(cacheKey)) return prefixCache.get(cacheKey) ?? null;
        const headRow = this.logHeadRow(logId, head);
        if (!headRow)
          throw new Error(`projection replay source missing: ${logId}:${head}`);
        const logKind = String(headRow["log_kind"]);
        const key: ProjectionKey = {
          logId,
          head: `__projection_prefix:${sha256HexSyncText(cacheKey).slice(0, 32)}`,
        };
        temporaryKeys.push(key);
        const parentLogId = asString(headRow["parent_log_id"]);
        const parentHead = asString(headRow["parent_head"]);
        const forkSeq =
          headRow["fork_seq"] == null ? 0 : asNumber(headRow["fork_seq"]);
        if (parentLogId && parentHead && forkSeq > 0) {
          // Cap the parent at min(forkSeq, throughSeq): when the requested
          // prefix ends BELOW this node's own fork point (a descendant forked
          // inside the inherited region), seeding the full parent-through-fork
          // prefix would over-project the parent events in (throughSeq, forkSeq].
          const parentPrefix = materializePrefix(
            parentLogId,
            parentHead,
            Math.min(forkSeq, throughSeq),
          );
          if (parentPrefix) this.copyProjectionKey(parentPrefix, key);
        }
        // Own events live above forkSeq; when throughSeq < forkSeq this range
        // is empty (the requested prefix is entirely within the inherited part).
        const afterSeq = parentLogId && parentHead ? forkSeq : 0;
        for (const envelope of this.readOwnLogRange({
          logId,
          head,
          afterSeq,
          throughSeq,
        })) {
          this.applyProjections(logKind, {
            ...envelope,
            logId: key.logId,
            head: key.head,
          });
          replayed += 1;
        }
        prefixCache.set(cacheKey, key);
        return key;
      };

      for (const headRow of heads) {
        const logId = String(headRow["log_id"]);
        const head = String(headRow["head"]);
        const logKind = String(headRow["log_kind"]);
        const parentLogId = asString(headRow["parent_log_id"]);
        const parentHead = asString(headRow["parent_head"]);
        const forkSeq =
          headRow["fork_seq"] == null ? 0 : asNumber(headRow["fork_seq"]);
        if (parentLogId && parentHead && forkSeq > 0) {
          const parentPrefix = materializePrefix(
            parentLogId,
            parentHead,
            forkSeq,
          );
          if (parentPrefix)
            this.copyProjectionKey(parentPrefix, { logId, head });
        }
        const pointer = this.headPointer(logId, head, headRow);
        const afterSeq = parentLogId && parentHead ? forkSeq : 0;
        for (const envelope of this.readOwnLogRange({
          logId,
          head,
          afterSeq,
          throughSeq: pointer.seq,
        })) {
          this.applyProjections(logKind, envelope);
          replayed += 1;
        }
      }
      for (const key of temporaryKeys) this.deleteProjectionKey(key);
      return { replayed };
    });
  }

  private readOwnLogRange(input: {
    logId: string;
    head: string;
    afterSeq: number;
    throughSeq: number;
  }): LogEnvelope[] {
    const clauses = ["log_id = ?", "head = ?", "seq > ?"];
    const bindings: SqlBinding[] = [input.logId, input.head, input.afterSeq];
    if (Number.isFinite(input.throughSeq)) {
      clauses.push("seq <= ?");
      bindings.push(input.throughSeq);
    }
    const rows = this.sql
      .exec(
        `SELECT * FROM log_events WHERE ${clauses.join(" AND ")} ORDER BY seq ASC`,
        ...bindings,
      )
      .toArray() as JsonRecord[];
    return rows.map((row) => this.mapLogEnvelope(row));
  }

  private copyProjectionKey(from: ProjectionKey, to: ProjectionKey): void {
    this.copyProjectionRows(
      "trajectory_turns",
      "turn_id, opened_at, closed_at, summary, ordinal",
      from,
      to,
    );
    this.copyProjectionRows(
      "trajectory_messages",
      "message_id, turn_id, role, status, started_event_id, completed_event_id, updated_at",
      from,
      to,
    );
    this.copyProjectionRows(
      "trajectory_message_blocks",
      "block_id, message_id, block_index, block_type, invocation_id",
      from,
      to,
    );
    this.copyProjectionRows(
      "trajectory_invocations",
      "invocation_id, turn_id, transport_call_id, kind, status, terminal_outcome, terminal_reason_code, request_ref_json, result_ref_json, started_event_id, completed_event_id, updated_at",
      from,
      to,
    );
    this.copyProjectionRows(
      "trajectory_invocation_outputs",
      "invocation_id, seq, chunk_ref_json, created_at",
      from,
      to,
    );
    this.copyProjectionRows(
      "trajectory_approvals",
      "approval_id, invocation_id, status, requested_by_json, resolved_by_json, requested_event_id, resolved_event_id, updated_at",
      from,
      to,
    );
    this.copyProjectionRows(
      "trajectory_usage_rollups",
      "turn_id, input_tokens, output_tokens, total_tokens, cost_usd",
      from,
      to,
    );
    this.copyProjectionRows(
      "trajectory_checkpoints",
      "anchor_event_hash, materialized_blob_json, materializer_version, created_at",
      from,
      to,
    );
    this.sql.exec(
      `INSERT INTO gad_memory_fts (text, kind, log_id, head, event_id, path, content_hash, anchor_json)
       SELECT text, kind, ?, ?, event_id, path, content_hash, anchor_json
         FROM gad_memory_fts
        WHERE log_id = ? AND head = ?`,
      to.logId,
      to.head,
      from.logId,
      from.head,
    );
  }

  private copyProjectionRows(
    table: string,
    columns: string,
    from: ProjectionKey,
    to: ProjectionKey,
  ): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO ${table} (log_id, head, ${columns})
       SELECT ?, ?, ${columns} FROM ${table} WHERE log_id = ? AND head = ?`,
      to.logId,
      to.head,
      from.logId,
      from.head,
    );
  }

  private deleteProjectionKey(key: ProjectionKey): void {
    for (const table of [
      "trajectory_turns",
      "trajectory_messages",
      "trajectory_message_blocks",
      "trajectory_invocations",
      "trajectory_invocation_outputs",
      "trajectory_approvals",
      "trajectory_usage_rollups",
      "trajectory_checkpoints",
    ]) {
      this.sql.exec(
        `DELETE FROM ${table} WHERE log_id = ? AND head = ?`,
        key.logId,
        key.head,
      );
    }
    this.sql.exec(
      `DELETE FROM gad_memory_fts WHERE log_id = ? AND head = ?`,
      key.logId,
      key.head,
    );
  }

  @schemaRpc()
  rebuildTrajectoryProjections(): Promise<{ replayed: number }> {
    return this.replayTrajectoryProjections();
  }

  private clearProjections(): void {
    // Memory rows are projections too and are rebuilt from canonical events.
    this.ensureMemoryIndex();
    this.sql.exec(`DELETE FROM gad_memory_fts`);
    this.sql.exec(`DELETE FROM state WHERE key LIKE 'memidx:%'`);
    for (const table of [
      "trajectory_turns",
      "trajectory_messages",
      "trajectory_message_blocks",
      "trajectory_invocations",
      "trajectory_invocation_outputs",
      "trajectory_approvals",
      "trajectory_usage_rollups",
      "channel_roster",
      "agent_directory",
    ]) {
      this.sql.exec(`DELETE FROM ${table}`);
    }
    this.ensureAgentDirectoryIndex();
    this.sql.exec(`DELETE FROM gad_agent_directory_fts`);
  }

  // -------------------------------------------------------------------------
  // Typed projections over the canonical unified log
  // -------------------------------------------------------------------------

  private trajectoryEventView(
    envelope: LogEnvelope,
    override?: { trajectoryId: string; branchId: string },
  ): TrajectoryEvent {
    const causality = agenticCausality(envelope.causality);
    const turnId = envelope.causality?.turnId;
    return {
      eventId: String(envelope.envelopeId),
      trajectoryId: override?.trajectoryId ?? envelope.logId,
      branchId: override?.branchId ?? envelope.head,
      seq: envelope.seq,
      prevEventHash: envelope.prevHash,
      eventHash: envelope.hash,
      kind: envelope.payloadKind,
      actor: envelope.actor,
      ...(turnId ? { turnId } : {}),
      ...(causality ? { causality } : {}),
      payload: envelope.payload,
      createdAt: envelope.appendedAt,
    } as unknown as TrajectoryEvent;
  }

  private channelEnvelopeView(
    envelope: LogEnvelope,
    channelId?: string,
  ): ChannelEnvelope {
    const annotations = envelope.annotations ?? {};
    const {
      metadata: _viewMetadata,
      attachments: _viewAttachments,
      contentClass: _viewContentClass,
      externalKeys: _viewExternalKeys,
      ...policyAnnotations
    } = annotations;
    const contentIntegrity = this.channelContentIntegrity(annotations);
    return {
      envelopeId: envelope.envelopeId,
      channelId: brandId<ChannelId>(channelId ?? envelope.logId),
      seq: envelope.seq,
      from: envelope.actor,
      ...(envelope.to !== undefined ? { to: envelope.to } : {}),
      payload: envelope.payload,
      ...(envelope.payloadKind !== "opaque"
        ? { payloadKind: envelope.payloadKind }
        : {}),
      ...(annotations["metadata"] !== undefined
        ? { metadata: annotations["metadata"] as Record<string, unknown> }
        : {}),
      ...(annotations["attachments"] !== undefined
        ? { attachments: annotations["attachments"] as unknown[] }
        : {}),
      ...contentIntegrity,
      ...(Object.keys(policyAnnotations).length > 0
        ? { annotations: policyAnnotations }
        : {}),
      publishedAt: envelope.appendedAt,
    };
  }

  private stampChannelContent(
    channelId: string,
    event: LogAppendEventInput,
  ): LogAppendEventInput {
    const annotations = { ...(event.annotations ?? {}) };
    const callerIsOwningChannel =
      this.authorization?.authorizingOrigin.kind === "code" &&
      this.caller?.callerId ===
        `do:workers/pubsub-channel:PubSubChannel:${channelId}`;

    if (callerIsOwningChannel) {
      // PubSubChannel derives these fields from its inbound host-sealed
      // attestation. The GAD receiver guard accepts the stamp only from the
      // exact owning channel object, never from arbitrary workspace code.
      this.channelContentIntegrity(annotations);
    } else {
      delete annotations["contentClass"];
      delete annotations["externalKeys"];
      const fact = this.authorization?.contextIntegrity;
      annotations["contentClass"] =
        fact?.class === "external" ? "external" : "internal";
      annotations["externalKeys"] =
        fact?.class === "external"
          ? [...new Set(fact.externalKeys.map(String))]
          : [];
    }
    return { ...event, annotations };
  }

  private channelContentIntegrity(annotations: Record<string, unknown>): {
    contentClass: "internal" | "external";
    externalKeys: string[];
  } {
    const contentClass = annotations["contentClass"];
    const keys = annotations["externalKeys"];
    if (
      (contentClass !== "internal" && contentClass !== "external") ||
      !Array.isArray(keys) ||
      !keys.every((key) => typeof key === "string") ||
      (contentClass === "internal" && keys.length > 0)
    ) {
      throw new Error(
        "Channel append requires a valid host-attested content class",
      );
    }
    const externalKeys = keys.map((key) => parseLineageKey(key));
    return { contentClass, externalKeys: [...new Set(externalKeys)] };
  }

  @schemaRpc()
  listTrajectoryEvents(input: {
    trajectoryId?: string | null;
    branchId: string;
    cursor?: number | null;
    limit?: number | null;
  }): TrajectoryEvent[] {
    this.ensureReady();
    const logId = input.trajectoryId ?? this.findLogIdForHead(input.branchId);
    if (!logId) return [];
    const limit = input.limit ?? 500;
    const envelopes = this.readLog({
      logId,
      head: input.branchId,
      afterSeq: input.cursor ?? 0,
      limit: limit <= 0 ? 0 : limit,
    });
    return envelopes.map((envelope) =>
      this.trajectoryEventView(envelope, {
        trajectoryId: logId,
        branchId: input.branchId,
      }),
    );
  }

  @schemaRpc()
  listTrajectoryBranches(input: { limit?: number | null } = {}): JsonRecord[] {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
    return this.sql
      .exec(
        `SELECT log_id AS trajectory_id,
                head AS branch_id,
                owner_json,
                current_seq AS seq,
                current_hash AS head_event_hash,
                current_envelope_id AS head_event_id,
                parent_head AS parent_branch_id,
                created_at,
                created_at AS updated_at
           FROM log_heads
          WHERE log_kind = 'trajectory'
          ORDER BY created_at DESC
          LIMIT ?`,
        limit,
      )
      .toArray() as JsonRecord[];
  }

  @schemaRpc()
  listTrajectoryInvocations(input: {
    branchId: string;
    limit?: number | null;
  }): JsonRecord[] {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
    return this.sql
      .exec(
        `SELECT * FROM trajectory_invocations
          WHERE head = ?
          ORDER BY updated_at DESC
          LIMIT ?`,
        input.branchId,
        limit,
      )
      .toArray() as JsonRecord[];
  }

  @schemaRpc()
  listTrajectoryApprovals(input: { limit?: number | null } = {}): JsonRecord[] {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
    return this.sql
      .exec(
        `SELECT approval_id, invocation_id, status, requested_by_json, resolved_by_json,
                log_id, head, requested_event_id, resolved_event_id, updated_at
           FROM trajectory_approvals
          ORDER BY updated_at DESC
          LIMIT ?`,
        limit,
      )
      .toArray() as JsonRecord[];
  }

  @schemaRpc()
  listChannelEnvelopes(input: { limit?: number | null } = {}): JsonRecord[] {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
    return this.sql
      .exec(
        `SELECT log_id AS channel_id,
                head,
                seq,
                envelope_id,
                actor_json,
                to_json,
                payload_kind,
                payload_ref_json,
                annotations_json,
                appended_at AS created_at
           FROM log_events
          WHERE log_id IN (
            SELECT log_id FROM log_heads WHERE log_kind = 'channel'
          )
          ORDER BY log_id, head, seq
          LIMIT ?`,
        limit,
      )
      .toArray() as JsonRecord[];
  }

  private findLogIdForHead(head: string): string | null {
    const row = this.sql
      .exec(`SELECT log_id FROM log_heads WHERE head = ? LIMIT 1`, head)
      .toArray()[0] as JsonRecord | undefined;
    return row ? String(row["log_id"]) : null;
  }

  @schemaRpc()
  getTrajectoryEvent(input: { eventId: string }): TrajectoryEvent | null {
    this.ensureReady();
    const row = this.sql
      .exec(
        `SELECT * FROM log_events WHERE envelope_id = ? LIMIT 1`,
        input.eventId,
      )
      .toArray()[0] as JsonRecord | undefined;
    return row ? this.trajectoryEventView(this.mapLogEnvelope(row)) : null;
  }

  @schemaRpc()
  getTrajectoryBranchHead(input: {
    trajectoryId: string;
    branchId: string;
  }): JsonRecord | null {
    this.ensureReady();
    const row = this.logHeadRow(input.trajectoryId, input.branchId);
    if (!row) return null;
    const pointer = this.headPointer(input.trajectoryId, input.branchId, row);
    return {
      trajectory_id: input.trajectoryId,
      branch_id: input.branchId,
      owner_json: (row["owner_json"] ?? null) as JsonValue,
      head_event_id: pointer.envelopeId,
      head_event_hash: pointer.seq > 0 ? pointer.hash : null,
      parent_branch_id: (row["parent_head"] ?? null) as JsonValue,
      fork_event_id: null,
      created_at: row["created_at"] as JsonValue,
      updated_at: row["created_at"] as JsonValue,
    };
  }

  @schemaRpc()
  async forkTrajectoryBranch(
    input: ForkTrajectoryBranchInput,
  ): Promise<ForkTrajectoryBranchResult> {
    this.ensureReady();
    let atSeq: number | null = input.throughSeq ?? null;
    if (input.throughEventHash) {
      const row = this.sql
        .exec(
          `SELECT seq FROM log_events WHERE hash = ? LIMIT 1`,
          input.throughEventHash,
        )
        .toArray()[0] as JsonRecord | undefined;
      if (!row)
        throw new Error("forkTrajectoryBranch throughEventHash not found");
      atSeq = asNumber(row["seq"]);
    }
    if (
      input.throughPublishedChannelId &&
      input.throughPublishedChannelSeq != null
    ) {
      const row = this.sql
        .exec(
          `SELECT MAX(o.seq) AS seq
           FROM log_events ch
           JOIN log_events o
             ON o.log_id = ch.origin_log_id
            AND o.head = ch.origin_head
            AND o.envelope_id = ch.origin_envelope_id
           WHERE ch.log_id = ?
             AND ch.seq <= ?
             AND ch.origin_log_id = ?
             AND ch.origin_head = ?`,
          input.throughPublishedChannelId,
          input.throughPublishedChannelSeq,
          input.fromTrajectoryId,
          input.fromBranchId,
        )
        .toArray()[0] as JsonRecord | undefined;
      atSeq = row?.["seq"] == null ? 0 : asNumber(row["seq"]);
    }

    const fork = this.forkLog({
      fromLogId: input.fromTrajectoryId,
      fromHead: input.fromBranchId,
      toLogId: input.toTrajectoryId,
      toHead: input.toBranchId,
      atSeq,
      owner: input.owner ?? null,
    });
    const pointer = this.headPointer(input.toTrajectoryId, input.toBranchId);
    return {
      fromTrajectoryId: input.fromTrajectoryId,
      fromBranchId: input.fromBranchId,
      toTrajectoryId: input.toTrajectoryId,
      toBranchId: input.toBranchId,
      copied: fork.inherited,
      headEventId: pointer.envelopeId,
      headEventHash: pointer.seq > 0 ? pointer.hash : null,
      lineage: [],
    };
  }

  // --- Channel projections ---------------------------------------------------

  @schemaRpc()
  async appendChannelEnvelope(
    input: Omit<
      ChannelEnvelope,
      "seq" | "envelopeId" | "publishedAt" | "contentClass" | "externalKeys"
    > & {
      envelopeId?: string | null;
      publishedAt?: string | null;
    },
  ): Promise<ChannelEnvelope> {
    this.ensureReady();
    const result = await this.appendLogEvent({
      logId: String(input.channelId),
      head: CHANNEL_LOG_HEAD,
      logKind: "channel",
      events: [this.channelEnvelopeEventInput(input)],
    });
    const envelope = result.envelopes[result.envelopes.length - 1]!;
    return this.channelEnvelopeView(envelope, String(input.channelId));
  }

  private channelEnvelopeEventInput(
    input: Omit<
      ChannelEnvelope,
      "seq" | "envelopeId" | "publishedAt" | "contentClass" | "externalKeys"
    > & {
      envelopeId?: string | null;
      publishedAt?: string | null;
    },
  ): LogAppendEventInput {
    const annotations: Record<string, unknown> = {};
    if (input.metadata !== undefined) annotations["metadata"] = input.metadata;
    if (input.attachments !== undefined)
      annotations["attachments"] = input.attachments;
    const fact = this.authorization?.contextIntegrity;
    annotations["contentClass"] =
      fact?.class === "external" ? "external" : "internal";
    annotations["externalKeys"] =
      fact?.class === "external"
        ? [...new Set(fact.externalKeys.map(String))]
        : [];
    return {
      envelopeId: input.envelopeId ?? null,
      actor: input.from,
      ...(input.to !== undefined ? { to: input.to } : {}),
      payloadKind: input.payloadKind ?? "opaque",
      payload: input.payload,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      ...(input.publishedAt ? { appendedAt: input.publishedAt } : {}),
    };
  }

  @schemaRpc()
  getChannelEnvelope(input: {
    envelopeId: string;
    channelId?: string | null;
  }): ChannelEnvelope | null {
    this.ensureReady();
    if (input.channelId) {
      const envelope = this.getLogEvent({
        logId: input.channelId,
        head: CHANNEL_LOG_HEAD,
        envelopeId: input.envelopeId,
      });
      return envelope
        ? this.channelEnvelopeView(envelope, input.channelId)
        : null;
    }
    const row = this.sql
      .exec(
        `SELECT * FROM log_events WHERE envelope_id = ? LIMIT 1`,
        input.envelopeId,
      )
      .toArray()[0] as JsonRecord | undefined;
    return row ? this.channelEnvelopeView(this.mapLogEnvelope(row)) : null;
  }

  @schemaRpc()
  readChannelEnvelopes(
    input: ChannelEnvelopePageRequest,
  ): ChannelEnvelopePage<ChannelEnvelope> {
    this.ensureReady();
    const request = normalizeChannelEnvelopePageRequest(input);
    const stats = this.lineageEventStats({
      logId: request.channelId,
      head: CHANNEL_LOG_HEAD,
      payloadKind: request.payloadKind,
    });
    let rows: LogEnvelope[];
    if (request.limit === 0) {
      rows = [];
    } else if (request.window.kind === "after") {
      rows = this.readLog({
        logId: request.channelId,
        head: CHANNEL_LOG_HEAD,
        afterSeq: request.window.seq,
        ...(request.window.throughSeq !== undefined
          ? { beforeSeq: request.window.throughSeq + 1 }
          : {}),
        limit: request.limit,
        payloadKind: request.payloadKind,
      });
    } else if (request.window.kind === "before") {
      rows = this.readLogTail({
        logId: request.channelId,
        head: CHANNEL_LOG_HEAD,
        beforeSeq: request.window.seq,
        limit: request.limit,
        payloadKind: request.payloadKind,
      });
    } else {
      rows = this.readLogTail({
        logId: request.channelId,
        head: CHANNEL_LOG_HEAD,
        limit: request.limit,
        payloadKind: request.payloadKind,
      });
    }
    return {
      items: rows.map((envelope) =>
        this.channelEnvelopeView(envelope, request.channelId),
      ),
      pageInfo: channelEnvelopePageInfo(
        request,
        {
          totalCount: stats.count,
          firstSeq: stats.firstSeq,
          lastSeq: stats.lastSeq,
        },
        rows.map((envelope) => envelope.seq),
      ),
    };
  }

  @schemaRpc()
  inspectChannelEnvelopes(
    input: ChannelEnvelopePageRequest,
  ): ChannelEnvelopePage<ChannelEnvelopeInspection> {
    const page = this.readChannelEnvelopes(input);
    return {
      pageInfo: page.pageInfo,
      items: page.items.map((envelope) => {
        const refs = this.sql
          .exec(
            `SELECT field_path, digest, purpose, size, created_at
             FROM log_blob_refs WHERE envelope_id = ?
             ORDER BY field_path ASC`,
            String(envelope.envelopeId),
          )
          .toArray() as unknown as ChannelStoredValueRef[];
        const payloadText = JSON.stringify(envelope.payload ?? null);
        return {
          envelopeId: String(envelope.envelopeId),
          channelId: input.channelId,
          seq: envelope.seq,
          payloadKind: envelope.payloadKind,
          from: summarizeJsonForInspection(envelope.from) as JsonRecord,
          ...(envelope.metadata !== undefined
            ? {
                metadata: summarizeJsonForInspection(
                  envelope.metadata,
                ) as JsonRecord,
              }
            : {}),
          bytes: {
            from: utf8Bytes(JSON.stringify(envelope.from)),
            to: utf8Bytes(
              envelope.to !== undefined ? JSON.stringify(envelope.to) : "",
            ),
            payload: utf8Bytes(payloadText),
            metadata: utf8Bytes(
              envelope.metadata !== undefined
                ? JSON.stringify(envelope.metadata)
                : "",
            ),
            attachments: utf8Bytes(
              envelope.attachments !== undefined
                ? JSON.stringify(envelope.attachments)
                : "",
            ),
          },
          payloadSummary: summarizeJsonForInspection(envelope.payload),
          storedRefs: refs,
          publishedAt: envelope.publishedAt,
        };
      }),
    };
  }

  @schemaRpc()
  listMessageTypes(input: {
    channelId: string;
  }): StoredChannelMessageTypeDefinition[] {
    this.ensureReady();
    const rows = this.sql
      .exec(
        `SELECT * FROM channel_message_types
         WHERE channel_id = ? AND source_json IS NOT NULL
           AND updated_at_seq > COALESCE(cleared_at_seq, -1)
         ORDER BY type_id ASC`,
        input.channelId,
      )
      .toArray() as JsonRecord[];
    return rows.map((row) => this.mapMessageType(row));
  }

  @schemaRpc()
  getMessageType(input: {
    channelId: string;
    typeId: string;
  }): StoredChannelMessageTypeDefinition | null {
    this.ensureReady();
    const row = this.sql
      .exec(
        `SELECT * FROM channel_message_types
         WHERE channel_id = ? AND type_id = ?
           AND source_json IS NOT NULL
           AND updated_at_seq > COALESCE(cleared_at_seq, -1)
         LIMIT 1`,
        input.channelId,
        input.typeId,
      )
      .toArray()[0] as JsonRecord | undefined;
    return row ? this.mapMessageType(row) : null;
  }

  /** WS2: registry mutations are a projection of published `messageType.*`
   *  events — validated and applied inside the same append txn. Malformed
   *  registrations REJECT the append (replacing the channel-side
   *  `Invalid registry payload` throw). Idempotent under fork-seed/replay via
   *  the monotone seq guards in applyRegistryMutation. */
  private projectMessageTypeEvent(envelope: LogEnvelope): void {
    const event = envelope.payload as Record<string, unknown> | null;
    if (!event || typeof event !== "object") return;
    const kind = asString(event["kind"]);
    if (kind !== "messageType.registered" && kind !== "messageType.cleared")
      return;
    const payload =
      event["payload"] &&
      typeof event["payload"] === "object" &&
      !Array.isArray(event["payload"])
        ? (event["payload"] as Record<string, unknown>)
        : {};
    const typeId = asString(payload["typeId"]);
    if (!typeId) {
      throw new Error(
        `${kind} payload invalid: typeId must be a non-empty string`,
      );
    }
    if (kind === "messageType.cleared") {
      this.applyRegistryMutation(envelope.logId, envelope.seq, {
        kind: "clearMessageType",
        typeId,
      });
      return;
    }
    const displayMode = payload["displayMode"];
    if (displayMode !== "inline" && displayMode !== "row") {
      throw new Error(
        `messageType.registered payload invalid: displayMode must be "inline" or "row"`,
      );
    }
    const source = payload["source"];
    if (!isStoredValueRef(source)) {
      throw new Error(
        `messageType.registered payload invalid: source must be stored by reference`,
      );
    }
    if (
      payload["imports"] !== undefined &&
      !isStoredValueRef(payload["imports"])
    ) {
      throw new Error(
        `messageType.registered payload invalid: imports must be stored by reference`,
      );
    }
    for (const field of ["stateSchema", "updateSchema"] as const) {
      const value = payload[field];
      if (
        value !== undefined &&
        (typeof value !== "object" || Array.isArray(value))
      ) {
        throw new Error(
          `messageType.registered payload invalid: ${field} must be an object`,
        );
      }
    }
    const registeredBy = payload["registeredBy"] ?? event["actor"];
    this.applyRegistryMutation(
      envelope.logId,
      envelope.seq,
      sanitizeRegistryMutation(
        StoredRegistryMutationInputSchema.parse({
          kind: "upsertMessageType",
          typeId,
          row: {
            displayMode: displayMode as "inline" | "row",
            source,
            ...(payload["imports"] ? { imports: payload["imports"] } : {}),
            ...(payload["stateSchema"]
              ? {
                  stateSchema: payload["stateSchema"] as Record<
                    string,
                    unknown
                  >,
                }
              : {}),
            ...(payload["updateSchema"]
              ? {
                  updateSchema: payload["updateSchema"] as Record<
                    string,
                    unknown
                  >,
                }
              : {}),
            ...(registeredBy ? { registeredBy } : {}),
          },
        }),
      ),
    );
  }

  private applyRegistryMutation(
    channelId: string,
    seq: number,
    mutation: StoredRegistryMutationInput,
  ): void {
    if (mutation.kind === "upsertMessageType") {
      this.sql.exec(
        `INSERT INTO channel_message_types (
           channel_id, type_id, display_mode, source_json, imports_json, schema_json,
           registered_by_json, updated_at_seq, cleared_at_seq
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(channel_id, type_id) DO UPDATE SET
           display_mode = excluded.display_mode,
           source_json = excluded.source_json,
           imports_json = excluded.imports_json,
           schema_json = excluded.schema_json,
           registered_by_json = excluded.registered_by_json,
           updated_at_seq = excluded.updated_at_seq,
           cleared_at_seq = CASE
             WHEN channel_message_types.cleared_at_seq IS NOT NULL
              AND channel_message_types.cleared_at_seq > excluded.updated_at_seq
             THEN channel_message_types.cleared_at_seq
             ELSE NULL
           END
         WHERE excluded.updated_at_seq > channel_message_types.updated_at_seq
           AND excluded.updated_at_seq > COALESCE(channel_message_types.cleared_at_seq, -1)`,
        channelId,
        mutation.typeId,
        mutation.row.displayMode,
        JSON.stringify(mutation.row.source),
        mutation.row.imports ? JSON.stringify(mutation.row.imports) : null,
        // schema_json holds both JSON Schema documents for the type.
        mutation.row.stateSchema !== undefined ||
          mutation.row.updateSchema !== undefined
          ? JSON.stringify({
              stateSchema: mutation.row.stateSchema,
              updateSchema: mutation.row.updateSchema,
            })
          : null,
        mutation.row.registeredBy
          ? JSON.stringify(mutation.row.registeredBy)
          : null,
        seq,
      );
      return;
    }

    this.sql.exec(
      `INSERT INTO channel_message_types (
         channel_id, type_id, updated_at_seq, cleared_at_seq
       ) VALUES (?, ?, -1, ?)
       ON CONFLICT(channel_id, type_id) DO UPDATE SET
         cleared_at_seq = MAX(COALESCE(channel_message_types.cleared_at_seq, -1), excluded.cleared_at_seq)`,
      channelId,
      mutation.typeId,
      seq,
    );
  }

  private mapMessageType(row: JsonRecord): StoredChannelMessageTypeDefinition {
    const result: StoredChannelMessageTypeDefinition = {
      typeId: String(row["type_id"]),
      displayMode: String(row["display_mode"]) === "inline" ? "inline" : "row",
      source: parseRecord(
        asString(row["source_json"]),
      ) as StoredChannelMessageTypeDefinition["source"],
      updatedAtSeq: asNumber(row["updated_at_seq"]),
    };
    if (row["imports_json"])
      result.imports = parseRecord(
        asString(row["imports_json"]),
      ) as StoredChannelMessageTypeDefinition["imports"];
    if (row["schema_json"]) {
      const schemas = parseJson(asString(row["schema_json"])) as {
        stateSchema?: Record<string, unknown>;
        updateSchema?: Record<string, unknown>;
      } | null;
      if (schemas && typeof schemas === "object") {
        if (schemas.stateSchema)
          result.stateSchema = schemas.stateSchema as GadJsonRecord;
        if (schemas.updateSchema)
          result.updateSchema = schemas.updateSchema as GadJsonRecord;
      }
    }
    if (row["registered_by_json"])
      result.registeredBy = parseRecord(asString(row["registered_by_json"]));
    if (row["cleared_at_seq"] !== null && row["cleared_at_seq"] !== undefined) {
      result.clearedAtSeq = asNumber(row["cleared_at_seq"]);
    }
    return result;
  }

  // --- Lineage queries over causality edges ----------------------------------

  private originRowForChannelRow(channelRow: JsonRecord): JsonRecord | null {
    const originLogId = asString(channelRow["origin_log_id"]);
    const originHead = asString(channelRow["origin_head"]);
    const originEnvelopeId = asString(channelRow["origin_envelope_id"]);
    if (!originLogId || !originHead || !originEnvelopeId) return null;
    return this.lineageEventRow(originLogId, originHead, originEnvelopeId);
  }

  private lineageForChannelRow(channelRow: JsonRecord): EnvelopeLineage | null {
    const originRow = this.originRowForChannelRow(channelRow);
    if (!originRow) return null;
    const channelEnvelope = this.mapLogEnvelope(channelRow);
    const originEnvelope = this.mapLogEnvelope(originRow);
    return {
      publication: {
        eventId: String(originEnvelope.envelopeId),
        trajectoryId: String(channelRow["origin_log_id"]),
        branchId: String(channelRow["origin_head"]),
        channelId: channelEnvelope.logId,
        channelSeq: channelEnvelope.seq,
        envelopeId: String(channelEnvelope.envelopeId),
        publishedAt: channelEnvelope.appendedAt,
      },
      envelope: this.channelEnvelopeView(channelEnvelope),
      trajectoryEvent: this.trajectoryEventView(originEnvelope, {
        trajectoryId: String(channelRow["origin_log_id"]),
        branchId: String(channelRow["origin_head"]),
      }),
    };
  }

  @schemaRpc()
  getTrajectoryForEnvelope(input: {
    envelopeId: string;
  }): EnvelopeLineage | null {
    this.ensureReady();
    const channelRow = this.sql
      .exec(
        `SELECT * FROM log_events WHERE envelope_id = ? AND origin_envelope_id IS NOT NULL LIMIT 1`,
        input.envelopeId,
      )
      .toArray()[0] as JsonRecord | undefined;
    if (!channelRow) return null;
    return this.lineageForChannelRow(channelRow);
  }

  @schemaRpc()
  resolveTrajectoryForkPoint(input: {
    trajectoryId: string;
    branchId: string;
    channelId: string;
    channelSeq: number;
  }): { seq: number } {
    this.ensureReady();
    const row = this.sql
      .exec(
        `SELECT MAX(origin.seq) AS seq
           FROM log_events AS channel
           JOIN log_events AS origin
             ON origin.log_id = channel.origin_log_id
            AND origin.head = channel.origin_head
            AND origin.envelope_id = channel.origin_envelope_id
          WHERE channel.log_id = ?
            AND channel.seq <= ?
            AND channel.origin_log_id = ?
            AND channel.origin_head = ?`,
        input.channelId,
        input.channelSeq,
        input.trajectoryId,
        input.branchId,
      )
      .one() as JsonRecord;
    const seq = row["seq"];
    return { seq: seq == null ? 0 : asNumber(seq) };
  }

  @schemaRpc()
  listPublishedEnvelopesForTrajectory(input: {
    trajectoryId?: string | null;
    branchId?: string | null;
    eventId?: string | null;
    turnId?: string | null;
    channelId?: string | null;
    limit?: number | null;
  }): EnvelopeLineage[] {
    this.ensureReady();
    const clauses: string[] = ["ch.origin_envelope_id IS NOT NULL"];
    const bindings: SqlBinding[] = [];
    if (input.trajectoryId) {
      clauses.push("ch.origin_log_id = ?");
      bindings.push(input.trajectoryId);
    }
    if (input.branchId) {
      clauses.push("ch.origin_head = ?");
      bindings.push(input.branchId);
    }
    if (input.eventId) {
      clauses.push("ch.origin_envelope_id = ?");
      bindings.push(input.eventId);
    }
    if (input.channelId) {
      clauses.push("ch.log_id = ?");
      bindings.push(input.channelId);
    }
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 1000);
    const rows = this.sql
      .exec(
        `SELECT ch.* FROM log_events ch
         WHERE ${clauses.join(" AND ")}
         ORDER BY ch.log_id ASC, ch.seq ASC
         LIMIT ?`,
        ...bindings,
        limit,
      )
      .toArray() as JsonRecord[];
    const lineages: EnvelopeLineage[] = [];
    for (const row of rows) {
      const lineage = this.lineageForChannelRow(row);
      if (!lineage) continue;
      if (input.turnId && lineage.trajectoryEvent.turnId !== input.turnId)
        continue;
      lineages.push(lineage);
    }
    return lineages;
  }

  @schemaRpc()
  getEnvelopesForTrajectory(input: {
    trajectoryId?: string | null;
    branchId?: string | null;
    eventId?: string | null;
    turnId?: string | null;
    channelId?: string | null;
    limit?: number | null;
  }): EnvelopeLineage[] {
    return this.listPublishedEnvelopesForTrajectory(input);
  }

  @schemaRpc()
  getPublishedArtifactsForTurn(input: {
    branchId?: string | null;
    turnId: string;
    channelId?: string | null;
    limit?: number | null;
  }): PublishedArtifact[] {
    return this.listPublishedEnvelopesForTrajectory({
      branchId: input.branchId,
      turnId: input.turnId,
      channelId: input.channelId,
      limit: input.limit,
    }).map((lineage) => ({ lineage }));
  }

  @schemaRpc()
  getPrivateLineageForPublishedEnvelope(input: {
    envelopeId: string;
  }): PrivateLineageForPublishedEnvelope | null {
    this.ensureReady();
    const lineage = this.getTrajectoryForEnvelope(input);
    if (!lineage) return null;
    const trajectoryId = lineage.publication.trajectoryId;
    const branchId = lineage.publication.branchId;
    const events = this.readLog({ logId: trajectoryId, head: branchId }).filter(
      (envelope) => envelope.seq <= lineage.trajectoryEvent.seq,
    );
    return {
      lineage,
      branchEvents: events.map((envelope) =>
        this.trajectoryEventView(envelope, { trajectoryId, branchId }),
      ),
    };
  }

  @schemaRpc()
  getDownstreamConsumers(input: {
    envelopeId: string;
    limit?: number | null;
  }): TrajectoryEvent[] {
    this.ensureReady();
    const needle = input.envelopeId;
    const rows = this.sql
      .exec(
        `SELECT * FROM log_events
         WHERE (causality_json LIKE ? OR payload_ref_json LIKE ?)
           AND envelope_id != ?
           AND origin_envelope_id IS NULL
         ORDER BY appended_at ASC, log_id ASC, head ASC, seq ASC
         LIMIT ?`,
        `%${needle}%`,
        `%${needle}%`,
        needle,
        Math.min(Math.max(input.limit ?? 500, 1), 1000),
      )
      .toArray() as JsonRecord[];
    return rows.map((row) =>
      this.trajectoryEventView(this.mapLogEnvelope(row)),
    );
  }

  // --- Inspection / maintenance ----------------------------------------------

  @schemaRpc()
  inspectPublicationIntegrity(
    input: InspectPublicationIntegrityInput = {},
  ): PublicationIntegrityInspection {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const clauses: string[] = ["origin_envelope_id IS NOT NULL"];
    const bindings: SqlBinding[] = [];
    if (input.channelId) {
      clauses.push("log_id = ?");
      bindings.push(input.channelId);
    }
    if (input.branchId) {
      clauses.push("origin_head = ?");
      bindings.push(input.branchId);
    }
    const publicationRows = this.sql
      .exec(
        `SELECT * FROM log_events WHERE ${clauses.join(" AND ")} ORDER BY log_id, seq`,
        ...bindings,
      )
      .toArray() as JsonRecord[];
    const rows: PublicationIntegrityIssue[] = [];
    let orphanMappings = 0;
    for (const row of publicationRows) {
      const origin = this.originRowForChannelRow(row);
      if (!origin) {
        orphanMappings += 1;
        if (rows.length < limit) {
          rows.push({
            type: "orphan-mapping",
            envelopeId: String(row["envelope_id"]),
            channelId: String(row["log_id"]),
            originLogId: String(row["origin_log_id"]),
            originEnvelopeId: String(row["origin_envelope_id"]),
          });
        }
      }
    }
    const channelOriginAgenticEnvelopes = asNumber(
      this.sql
        .exec(
          `SELECT COUNT(*) AS count FROM log_events
           WHERE payload_kind = ? AND origin_envelope_id IS NULL
           ${input.channelId ? "AND log_id = ?" : ""}`,
          ...(input.channelId
            ? [AGENTIC_EVENT_PAYLOAD_KIND, input.channelId]
            : [AGENTIC_EVENT_PAYLOAD_KIND]),
        )
        .one()["count"],
    );
    return {
      summary: {
        expectedMappings: publicationRows.length,
        missingMappings: 0,
        orphanMappings,
        missingPublicationEvents: orphanMappings,
        missingPublicationEnvelopes: 0,
        sequenceMismatches: 0,
        channelOriginAgenticEnvelopes,
      },
      rows,
    };
  }

  @schemaRpc()
  inspectTurnState(input: InspectTurnStateInput = {}): TurnStateInspection {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const clauses: string[] = [];
    const bindings: SqlBinding[] = [];
    if (input.trajectoryId) {
      clauses.push("t.log_id = ?");
      bindings.push(input.trajectoryId);
    }
    if (input.branchId) {
      clauses.push("t.head = ?");
      bindings.push(input.branchId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.sql
      .exec(
        `SELECT t.log_id AS log_id,
                t.head AS head,
                t.turn_id AS turn_id,
                t.trigger_message_id AS trigger_message_id,
                t.opened_at AS opened_at,
                t.closed_at AS closed_at,
                COUNT(DISTINCT CASE WHEN m.status NOT IN ('completed', 'failed') THEN m.message_id END) AS streaming_messages,
                COUNT(DISTINCT CASE WHEN i.status NOT IN ('completed', 'failed', 'cancelled', 'abandoned') THEN i.invocation_id END) AS nonterminal_invocations,
                COUNT(DISTINCT e.envelope_id) AS duplicate_open_events
         FROM trajectory_turns t
         LEFT JOIN trajectory_messages m
           ON m.log_id = t.log_id AND m.head = t.head AND m.turn_id = t.turn_id
         LEFT JOIN trajectory_invocations i
           ON i.log_id = t.log_id AND i.head = t.head AND i.turn_id = t.turn_id
         LEFT JOIN log_events e
           ON e.log_id = t.log_id AND e.head = t.head AND e.turn_id = t.turn_id
          AND e.payload_kind = 'turn.opened'
         ${where}
         GROUP BY t.log_id, t.head, t.turn_id, t.trigger_message_id, t.opened_at, t.closed_at
         ORDER BY t.opened_at DESC
         LIMIT ?`,
        ...bindings,
        limit,
      )
      .toArray() as unknown as TurnStateRow[];
    // An explicit branch is already an exact scope. The channel-name heuristic
    // exists only for channel-only calls; applying both made valid custom
    // branch names disappear merely because they did not embed the channel id.
    const scopedRows =
      input.channelId && !input.branchId
        ? rows.filter((row) => String(row["head"]).includes(input.channelId!))
        : rows;
    return {
      summary: {
        branches: new Set(
          scopedRows.map(
            (row) => `${String(row["log_id"])} ${String(row["head"])}`,
          ),
        ).size,
        openTurns: scopedRows.filter((row) => row["closed_at"] == null).length,
        streamingMessages: scopedRows.reduce(
          (sum, row) => sum + asNumber(row["streaming_messages"]),
          0,
        ),
        nonterminalInvocations: scopedRows.reduce(
          (sum, row) => sum + asNumber(row["nonterminal_invocations"]),
          0,
        ),
        duplicateOpenedTurns: scopedRows.filter(
          (row) => asNumber(row["duplicate_open_events"]) > 1,
        ).length,
      },
      rows: scopedRows,
    };
  }

  @schemaRpc()
  inspectInvocationState(
    input: InspectInvocationStateInput = {},
  ): InvocationStateInspection {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const clauses: string[] = [];
    const bindings: SqlBinding[] = [];
    if (input.trajectoryId) {
      clauses.push("i.log_id = ?");
      bindings.push(input.trajectoryId);
    }
    if (input.branchId) {
      clauses.push("i.head = ?");
      bindings.push(input.branchId);
    }
    if (input.invocationId) {
      clauses.push("i.invocation_id = ?");
      bindings.push(input.invocationId);
    }
    if (input.transportCallId) {
      clauses.push("i.transport_call_id = ?");
      bindings.push(input.transportCallId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.sql
      .exec(
        `SELECT i.log_id,
                i.head,
                i.invocation_id,
                i.turn_id,
                i.transport_call_id,
                i.kind,
                i.status,
                i.terminal_outcome,
                i.terminal_reason_code,
                i.started_event_id,
                i.completed_event_id,
                i.updated_at,
                CASE
                  WHEN json_extract(trigger.payload_ref_json, '$.senderRef.kind') = 'user'
                  THEN replace(
                    COALESCE(
                      json_extract(trigger.payload_ref_json, '$.senderRef.participantId'),
                      json_extract(trigger.payload_ref_json, '$.senderRef.id')
                    ),
                    'user:',
                    ''
                  )
                  ELSE NULL
                END AS initiating_user_id,
                COUNT(CASE WHEN e.payload_kind = 'invocation.started' THEN 1 END) AS started_events,
                COUNT(CASE WHEN e.payload_kind IN ('invocation.completed', 'invocation.failed', 'invocation.cancelled', 'invocation.abandoned') THEN 1 END) AS terminal_events
         FROM trajectory_invocations i
         LEFT JOIN trajectory_turns t
           ON t.log_id = i.log_id AND t.head = i.head AND t.turn_id = i.turn_id
         LEFT JOIN log_events trigger
           ON trigger.log_id = t.log_id
          AND trigger.head = t.head
          AND trigger.envelope_id = t.trigger_message_id
         LEFT JOIN log_events e
           ON e.log_id = i.log_id
          AND e.head = i.head
          AND json_extract(e.causality_json, '$.invocationId') = i.invocation_id
         ${where}
         GROUP BY i.log_id, i.head, i.invocation_id, i.turn_id, i.transport_call_id, i.kind, i.status,
                  i.terminal_outcome, i.terminal_reason_code, i.started_event_id,
                  i.completed_event_id, i.updated_at, initiating_user_id
         ORDER BY i.updated_at DESC
         LIMIT ?`,
        ...bindings,
        limit,
      )
      .toArray() as unknown as InvocationStateRow[];
    return {
      summary: {
        projected: rows.length,
        startedEvents: rows.reduce(
          (sum, row) => sum + asNumber(row["started_events"]),
          0,
        ),
        terminalEvents: rows.reduce(
          (sum, row) => sum + asNumber(row["terminal_events"]),
          0,
        ),
        openProjectedInvocations: rows.filter(
          (row) =>
            !["completed", "failed", "cancelled", "abandoned"].includes(
              String(row["status"]),
            ),
        ).length,
      },
      rows,
    };
  }

  @schemaRpc()
  diagnoseInvocation(
    input: DiagnoseInvocationInput,
  ): InvocationDiagnosticPacket {
    this.ensureReady();
    const eventLimit = Math.min(Math.max(input.eventLimit ?? 20, 1), 50);
    const commandLimit = Math.min(Math.max(input.commandLimit ?? 20, 1), 50);
    const effectLimit = Math.min(Math.max(input.effectLimit ?? 50, 1), 100);
    const invocation = this.sql
      .exec(
        `SELECT log_id,head,invocation_id,turn_id,transport_call_id,kind,status,
                terminal_outcome,terminal_reason_code,request_ref_json,result_ref_json,
                started_event_id,completed_event_id,updated_at
           FROM trajectory_invocations
          WHERE log_id = ? AND head = ? AND invocation_id = ?
          LIMIT 1`,
        input.trajectoryId,
        input.branchId,
        input.invocationId,
      )
      .toArray()[0] as unknown as InvocationDiagnostic | undefined;
    const turn =
      invocation?.["turn_id"] == null
        ? undefined
        : (this.sql
            .exec(
              `SELECT * FROM trajectory_turns
                WHERE log_id = ? AND head = ? AND turn_id = ?
                LIMIT 1`,
              input.trajectoryId,
              input.branchId,
              String(invocation["turn_id"]),
            )
            .toArray()[0] as unknown as TurnDiagnostic | undefined);
    const eventRows = this.sql
      .exec(
        `SELECT * FROM log_events
          WHERE log_id = ? AND head = ?
            AND json_extract(causality_json, '$.invocationId') = ?
          ORDER BY seq ASC
          LIMIT ?`,
        input.trajectoryId,
        input.branchId,
        input.invocationId,
        eventLimit + 1,
      )
      .toArray() as JsonRecord[];
    const eventsTruncated = eventRows.length > eventLimit;
    const events = eventRows
      .slice(0, eventLimit)
      .map((row) =>
        summarizeJsonForInspection(
          this.trajectoryEventView(this.mapLogEnvelope(row)),
        ),
      ) as JsonRecord[];
    const commandRows = this.sql
      .exec(
        `SELECT command_id,scope_kind,scope_id,method,request_digest,status,result_json,
                created_at,completed_at
           FROM vcs_command_journal
          WHERE cause_log_id = ? AND cause_head = ? AND cause_invocation_id = ?
          ORDER BY created_at ASC, command_id ASC
          LIMIT ?`,
        input.trajectoryId,
        input.branchId,
        input.invocationId,
        commandLimit + 1,
      )
      .toArray() as JsonRecord[];
    const commandsTruncated = commandRows.length > commandLimit;
    let effectsTruncated = false;
    const commands: CommandDiagnostic[] = commandRows
      .slice(0, commandLimit)
      .map((command) => {
        const effects = this.sql
          .exec(
            `SELECT effect_id,scope_kind,scope_id,command_id,kind,payload_digest,status,
                  receipt_digest,created_at,applied_at,payload_json,receipt_json
             FROM gad_effect_intents
            WHERE command_id = ? AND scope_kind = ? AND scope_id = ?
            ORDER BY created_at ASC,effect_id ASC
            LIMIT ?`,
            String(command["command_id"]),
            String(command["scope_kind"]),
            String(command["scope_id"]),
            effectLimit + 1,
          )
          .toArray()
          .slice(0, effectLimit + 1)
          .map((effect) => {
            const {
              payload_json: payloadJson,
              receipt_json: receiptJson,
              ...identity
            } = effect as JsonRecord;
            return {
              ...identity,
              payload:
                payloadJson == null ? null : parseJson(String(payloadJson)),
              receipt:
                receiptJson == null ? null : parseJson(String(receiptJson)),
            };
          }) as CommandDiagnostic["effects"];
        if (effects.length > effectLimit) effectsTruncated = true;
        effects.splice(effectLimit);
        const { result_json: resultJson, ...identity } = command;
        return {
          command: {
            ...identity,
            result: resultJson == null ? null : parseJson(String(resultJson)),
          } as CommandDiagnostic["command"],
          effects,
        };
      });
    const cleanupFailureCount = events.reduce((count, event) => {
      const payload = event["payload"];
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return count;
      const failure = (payload as Record<string, unknown>)["failure"];
      if (!failure || typeof failure !== "object" || Array.isArray(failure))
        return count;
      const causes = (failure as Record<string, unknown>)["causes"];
      return (
        count +
        (Array.isArray(causes)
          ? causes.filter(
              (cause) =>
                cause &&
                typeof cause === "object" &&
                !Array.isArray(cause) &&
                ["cleanup", "rollback"].includes(
                  String((cause as Record<string, unknown>)["role"]),
                ),
            ).length
          : 0)
      );
    }, 0);
    return {
      generatedAt: nowIso(),
      coordinate: {
        trajectoryId: input.trajectoryId,
        branchId: input.branchId,
        invocationId: input.invocationId,
      },
      invocation: invocation ?? null,
      turn: turn ?? null,
      events,
      commands,
      summary: {
        terminal: Boolean(
          invocation &&
          ["completed", "failed", "cancelled", "abandoned"].includes(
            String(invocation["status"]),
          ),
        ),
        eventCount: events.length,
        commandCount: commands.length,
        pendingEffectCount: commands.reduce(
          (count, command) =>
            count +
            command.effects.filter(
              (effect) => String(effect["status"]) === "pending",
            ).length,
          0,
        ),
        cleanupFailureCount,
        truncated: {
          events: eventsTruncated,
          commands: commandsTruncated,
          effects: effectsTruncated,
        },
      },
    };
  }

  @schemaRpc()
  inspectChannelRoster(
    input: InspectChannelRosterInput,
  ): ChannelRosterInspection {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const rows = this.sql
      .exec(
        `SELECT channel_id,
                participant_id,
                joined_at,
                left_at,
                roles_json
           FROM channel_roster
          WHERE channel_id = ?
          ORDER BY joined_at DESC
          LIMIT ?`,
        input.channelId,
        limit,
      )
      .toArray()
      .map((row) => ({
        channel_id: row["channel_id"] as JsonValue,
        participant_id: row["participant_id"] as JsonValue,
        joined_at: row["joined_at"] as JsonValue,
        left_at: row["left_at"] as JsonValue,
        roles: parseJson(
          row["roles_json"] as string | null | undefined,
        ) as JsonValue,
      })) as ChannelRosterRow[];
    return {
      summary: {
        rows: rows.length,
        activeParticipants: rows.filter((row) => row["left_at"] == null).length,
        inactiveParticipants: rows.filter((row) => row["left_at"] != null)
          .length,
      },
      rows,
    };
  }

  private agentDirectoryEntry(row: JsonRecord): AgentDirectoryEntry {
    const handle = asString(row["handle"]);
    const channelId = String(row["channel_id"]);
    return {
      instanceId: String(row["instance_id"]),
      // The ref IS the addressee grammar: discovering an instance and being
      // able to message it are the same act (plan §4.4).
      ref: `agent:${handle ?? String(row["participant_id"])}@${channelId}`,
      channelId,
      participantId: String(row["participant_id"]),
      kind: asString(row["kind"]),
      handle,
      displayName: asString(row["display_name"]),
      description: asString(row["description"]),
      parentInstanceId: asString(row["parent_instance_id"]),
      runId: asString(row["run_id"]),
      workerId: asString(row["worker_id"]),
      ownerUserId: asString(row["owner_user_id"]),
      status: String(row["status"]) as AgentDirectoryEntry["status"],
      statusEventId: asString(row["status_event_id"]),
      lastActivityAt:
        typeof row["last_activity_at"] === "number"
          ? row["last_activity_at"]
          : null,
      summary: asString(row["summary"]),
    };
  }

  private agentDirectoryListing(
    entries: AgentDirectoryEntry[],
  ): AgentDirectoryListing {
    return {
      summary: {
        rows: entries.length,
        running: entries.filter((entry) => entry.status === "running").length,
        terminal: entries.filter((entry) => entry.status === "terminal").length,
      },
      entries,
    };
  }

  @schemaRpc()
  listAgentDirectory(input: ListAgentDirectoryInput): AgentDirectoryListing {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const filters: string[] = [];
    const bindings: SqlBinding[] = [];
    if (input.channelId) {
      filters.push(`channel_id = ?`);
      bindings.push(input.channelId);
    }
    if (input.workerId) {
      filters.push(`worker_id = ?`);
      bindings.push(input.workerId);
    }
    if (input.runId) {
      filters.push(`run_id = ?`);
      bindings.push(input.runId);
    }
    if (input.handle) {
      filters.push(`handle = ?`);
      bindings.push(input.handle);
    }
    if (input.status) {
      filters.push(`status = ?`);
      bindings.push(input.status);
    } else if (!input.includeTerminal) {
      filters.push(`status != 'terminal'`);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = this.sql
      .exec(
        `SELECT * FROM agent_directory ${where}
          ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'idle' THEN 1
                               ELSE 3 END,
                   last_activity_at DESC,
                   instance_id
          LIMIT ?`,
        ...bindings,
        limit,
      )
      .toArray() as JsonRecord[];
    return this.agentDirectoryListing(
      rows.map((row) => this.agentDirectoryEntry(row)),
    );
  }

  @schemaRpc()
  searchAgentDirectory(
    input: SearchAgentDirectoryInput,
  ): AgentDirectoryListing {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const mode = this.ensureAgentDirectoryIndex();
    const statusFilter = input.includeTerminal
      ? ""
      : ` AND d.status != 'terminal'`;
    const rows =
      mode === "fts"
        ? (this.sql
            .exec(
              `SELECT d.* FROM gad_agent_directory_fts f
                 JOIN agent_directory d ON d.instance_id = f.instance_id
                WHERE gad_agent_directory_fts MATCH ?${statusFilter}
                ORDER BY bm25(gad_agent_directory_fts)
                LIMIT ?`,
              // Terms are quoted so a purpose query can't inject FTS5 syntax;
              // OR-ed because "gmail triage" should match either word.
              ftsQuery(recallTokens([input.query]), " OR "),
              limit,
            )
            .toArray() as JsonRecord[])
        : (this.sql
            .exec(
              `SELECT d.* FROM gad_agent_directory_fts f
                 JOIN agent_directory d ON d.instance_id = f.instance_id
                WHERE ${
                  recallTokens([input.query])
                    .map(() => `f.text LIKE ?`)
                    .join(" OR ") || "1 = 0"
                }${statusFilter}
                ORDER BY d.last_activity_at DESC
                LIMIT ?`,
              ...recallTokens([input.query]).map((term) => `%${term}%`),
              limit,
            )
            .toArray() as JsonRecord[]);
    return this.agentDirectoryListing(
      rows.map((row) => this.agentDirectoryEntry(row)),
    );
  }

  /**
   * Channel enrichment for discovery: who is in each channel, how busy it is,
   * and when it last moved.
   *
   * There is deliberately no `title`. A channel's title is DO-local config on
   * the channel itself and produces no durable event, so this projection has no
   * honest source for one — inventing a field every caller would find silently
   * stale is worse than omitting it. Callers that need a title ask the channel.
   */
  @schemaRpc()
  describeChannels(input: DescribeChannelsInput): ChannelDescription[] {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const channelIds =
      input.channelIds && input.channelIds.length > 0
        ? input.channelIds.slice(0, limit)
        : (
            this.sql
              .exec(
                `SELECT DISTINCT log_id FROM log_heads WHERE log_kind = 'channel' LIMIT ?`,
                limit,
              )
              .toArray() as JsonRecord[]
          ).map((row) => {
            const logId = String(row["log_id"]);
            return channelIdFromTrajectoryLog(logId) ?? logId;
          });
    return channelIds.map((channelId) => {
      const stats = this.sql
        .exec(
          `SELECT COUNT(*) AS n, MAX(appended_at) AS last FROM log_events
            WHERE log_id = ? AND head = ?`,
          channelId,
          CHANNEL_LOG_HEAD,
        )
        .toArray()[0] as JsonRecord | undefined;
      const participants = (
        this.sql
          .exec(
            `SELECT participant_id, handle, kind, status FROM agent_directory
              WHERE channel_id = ? ORDER BY handle, participant_id`,
            channelId,
          )
          .toArray() as JsonRecord[]
      ).map((row) => ({
        participantId: String(row["participant_id"]),
        handle: asString(row["handle"]),
        kind: asString(row["kind"]),
        status: asString(
          row["status"],
        ) as ChannelDescription["participants"][number]["status"],
      }));
      const last = asString(stats?.["last"]);
      return {
        channelId,
        envelopeCount: asNumber(stats?.["n"] ?? 0),
        lastEnvelopeAt: last ? Date.parse(last) || null : null,
        participants,
      };
    });
  }

  @schemaRpc()
  async inspectAgentHealth(
    input: InspectAgentHealthInput,
  ): Promise<AgentHealthInspection> {
    this.ensureReady();
    // This API is the incident *summary*. Keep it compact even when a caller
    // passes the broad limits used by the detailed inspectors; exact follow-up
    // calls remain available once the summary identifies an artifact.
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 50);
    const branchId = input.branchId ?? logIdForChannel(input.channelId);
    const publicationIntegrity = this.inspectPublicationIntegrity({
      channelId: input.channelId,
      branchId,
      limit,
    });
    const fullTurnState = this.inspectTurnState({
      channelId: input.channelId,
      branchId,
      limit,
    });
    const fullInvocationState = this.inspectInvocationState({
      branchId,
      limit,
    });
    const fullRoster = this.inspectChannelRoster({
      channelId: input.channelId,
      limit,
    });
    const turnState: TurnStateInspection = {
      summary: fullTurnState.summary,
      rows: fullTurnState.rows
        .filter(
          (row) =>
            row["closed_at"] == null ||
            asNumber(row["streaming_messages"]) > 0 ||
            asNumber(row["nonterminal_invocations"]) > 0 ||
            asNumber(row["duplicate_open_events"]) > 1,
        )
        .slice(0, 10),
    };
    const terminalInvocationStatuses = new Set([
      "completed",
      "failed",
      "cancelled",
      "abandoned",
    ]);
    const invocationState: InvocationStateInspection = {
      summary: fullInvocationState.summary,
      rows: fullInvocationState.rows
        .filter((row) => {
          const terminal = terminalInvocationStatuses.has(
            String(row["status"]),
          );
          return (
            !terminal ||
            asNumber(row["started_events"]) !== 1 ||
            asNumber(row["terminal_events"]) !== 1
          );
        })
        .slice(0, 10),
    };
    const roster: ChannelRosterInspection = {
      summary: fullRoster.summary,
      rows: fullRoster.rows
        .filter((row) => row["left_at"] == null)
        .slice(0, 10),
    };
    const envelopes = this.inspectChannelEnvelopes({
      channelId: input.channelId,
      limit: input.envelopeLimit ?? Math.min(limit, 5),
    });
    const storage = this.inspectStorageDiagnostics({
      branchId,
      channelId: input.channelId,
      rowByteLimit: input.rowByteLimit,
      limit: input.storageLimit ?? Math.min(limit, 10),
    });
    const publicationIssues =
      asNumber(publicationIntegrity.summary.missingMappings) +
      asNumber(publicationIntegrity.summary.orphanMappings) +
      asNumber(publicationIntegrity.summary.sequenceMismatches);
    const openTurns = asNumber(turnState.summary.openTurns);
    const streamingMessages = asNumber(turnState.summary.streamingMessages);
    const nonterminalInvocations = asNumber(
      turnState.summary.nonterminalInvocations,
    );
    const turnIntegrityIssues = asNumber(
      turnState.summary.duplicateOpenedTurns,
    );
    const storageIssues = storage.rows.length;
    const activity: "idle" | "in-flight" =
      openTurns > 0 || streamingMessages > 0 || nonterminalInvocations > 0
        ? "in-flight"
        : "idle";
    const durableIntegrityOk =
      publicationIssues === 0 &&
      turnIntegrityIssues === 0 &&
      storageIssues === 0;
    return {
      channelId: input.channelId,
      branchId,
      generatedAt: nowIso(),
      summary: {
        ok: durableIntegrityOk && activity === "idle",
        durableIntegrityOk,
        inFlightOnly: durableIntegrityOk && activity === "in-flight",
        activity,
        publicationIssues,
        turnIntegrityIssues,
        openTurns,
        streamingMessages,
        nonterminalInvocations,
        activeParticipants: roster.summary.activeParticipants,
        storageIssues,
      },
      publicationIntegrity,
      turnState,
      invocationState,
      roster,
      envelopes,
      storage,
    };
  }

  @schemaRpc()
  inspectStorageDiagnostics(input: InspectStorageDiagnosticsInput = {}): {
    rows: StorageDiagnostic[];
  } {
    this.ensureReady();
    const rowByteLimit = input.rowByteLimit ?? 512 * 1024;
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const rows: StorageDiagnostic[] = [];

    const eventClauses = ["length(payload_ref_json) > ?"];
    const eventBindings: SqlBinding[] = [];
    if (input.branchId && input.channelId) {
      eventClauses.unshift("(head = ? OR log_id = ?)");
      eventBindings.push(input.branchId, input.channelId);
    } else if (input.branchId) {
      eventClauses.unshift("head = ?");
      eventBindings.push(input.branchId);
    } else if (input.channelId) {
      eventClauses.unshift("log_id = ?");
      eventBindings.push(input.channelId);
    }
    rows.push(
      ...(this.sql
        .exec(
          `SELECT 'log_events' AS scope, envelope_id AS id, length(payload_ref_json) AS bytes
           FROM log_events
           WHERE ${eventClauses.join(" AND ")}
           ORDER BY bytes DESC LIMIT ?`,
          ...eventBindings,
          rowByteLimit,
          limit,
        )
        .toArray() as unknown as StorageDiagnostic[]),
    );

    const invocationBindings: SqlBinding[] = [];
    const invocationWhere = input.branchId ? "AND head = ?" : "";
    if (input.branchId) invocationBindings.push(input.branchId);
    rows.push(
      ...(this.sql
        .exec(
          `SELECT 'trajectory_invocations' AS scope, invocation_id AS id,
                  MAX(COALESCE(length(request_ref_json), 0), COALESCE(length(result_ref_json), 0)) AS bytes
           FROM trajectory_invocations
           WHERE MAX(COALESCE(length(request_ref_json), 0), COALESCE(length(result_ref_json), 0)) > ?
           ${invocationWhere}
           ORDER BY bytes DESC LIMIT ?`,
          rowByteLimit,
          ...invocationBindings,
          limit,
        )
        .toArray() as unknown as StorageDiagnostic[]),
    );

    const refClauses: string[] = [];
    const refBindings: SqlBinding[] = [];
    if (input.branchId && input.channelId) {
      refClauses.push("(r.head = ? OR r.log_id = ?)");
      refBindings.push(input.branchId, input.channelId);
    } else if (input.branchId) {
      refClauses.push("r.head = ?");
      refBindings.push(input.branchId);
    } else if (input.channelId) {
      refClauses.push("r.log_id = ?");
      refBindings.push(input.channelId);
    }
    rows.push(
      ...(this.sql
        .exec(
          `SELECT 'missing_gad_blob_index' AS scope, r.digest AS id, r.size AS bytes
           FROM log_blob_refs r
           LEFT JOIN gad_blobs b ON b.hash = r.digest
           WHERE b.hash IS NULL
           ${refClauses.length ? `AND ${refClauses.join(" AND ")}` : ""}
           LIMIT ?`,
          ...refBindings,
          limit,
        )
        .toArray() as unknown as StorageDiagnostic[]),
    );

    return { rows: rows.slice(0, limit) };
  }

  @schemaRpc()
  listStoredValueRefs(
    input: {
      eventId?: string | null;
      envelopeId?: string | null;
      digest?: string | null;
      limit?: number | null;
    } = {},
  ): { rows: JsonRecord[] } {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 1000);
    const clauses: string[] = [];
    const bindings: SqlBinding[] = [];
    const ownerId = input.eventId ?? input.envelopeId;
    if (ownerId) {
      clauses.push("r.envelope_id = ?");
      bindings.push(ownerId);
    }
    if (input.digest) {
      clauses.push("r.digest = ?");
      bindings.push(input.digest);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.sql
      .exec(
        `SELECT CASE WHEN lh.log_kind = 'channel' THEN 'channel' ELSE 'trajectory' END AS ref_scope,
                r.envelope_id AS owner_id,
                r.field_path, r.digest, r.purpose, r.size, r.created_at
         FROM log_blob_refs r
         LEFT JOIN log_heads lh ON lh.log_id = r.log_id AND lh.head = r.head
         ${where}
         ORDER BY r.created_at ASC LIMIT ?`,
        ...bindings,
        limit,
      )
      .toArray() as JsonRecord[];
    return { rows };
  }

  @schemaRpc()
  getStatus(): { metric: string; value: number }[] {
    const count = (sql: string, ...bindings: SqlBinding[]) =>
      asNumber(this.sql.exec(sql, ...bindings).one()["value"]);
    return [
      {
        metric: "Log events",
        value: count(`SELECT COUNT(*) AS value FROM log_events`),
      },
      {
        metric: "Log heads",
        value: count(`SELECT COUNT(*) AS value FROM log_heads`),
      },
      {
        metric: "Channel envelopes",
        value: count(
          `SELECT COUNT(*) AS value FROM log_events e
           JOIN log_heads h ON h.log_id = e.log_id AND h.head = e.head
           WHERE h.log_kind = 'channel'`,
        ),
      },
      {
        metric: "Workspace contexts",
        value: count(`SELECT COUNT(*) AS value FROM vcs_contexts`),
      },
      {
        metric: "Workspace events",
        value: count(`SELECT COUNT(*) AS value FROM gad_workspace_events`),
      },
      {
        metric: "Work units",
        value: count(`SELECT COUNT(*) AS value FROM gad_work_units`),
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Workspace-wide channel invitation inbox
  // -------------------------------------------------------------------------

  private requireInviteUserId(value: unknown, method: string): string {
    if (
      typeof value !== "string" ||
      value.trim() === "" ||
      value.startsWith("user:")
    ) {
      throw new Error(`${method}: userId must be a bare workspace account id`);
    }
    return value.trim();
  }

  private requireInviteChannelId(value: unknown, method: string): string {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${method}: channelId is required`);
    }
    return value.trim();
  }

  private assertInviteChannelAuthority(
    channelId: string,
    method: string,
  ): void {
    const caller = this.caller;
    const origin = this.authorization?.authorizingOrigin.kind;
    if (origin === "host") return;
    const expected = `do:workers/pubsub-channel:PubSubChannel:${channelId}`;
    if (origin !== "code" || caller?.callerId !== expected) {
      throw new Error(
        `${method}: only the owning channel DO may mutate or inspect this row`,
      );
    }
  }

  private requireMembershipRevision(value: unknown, method: string): number {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) {
      throw new Error(`${method}: revision must be a positive safe integer`);
    }
    return Number(value);
  }

  private channelMembershipRevision(
    userId: string,
    channelId: string,
  ): { revision: number; action: "put" | "delete" } | null {
    const row = this.sql
      .exec(
        `SELECT revision, action FROM channel_membership_revisions
          WHERE user_id = ? AND channel_id = ?`,
        userId,
        channelId,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      revision: Number(row["revision"]),
      action: String(row["action"]) as "put" | "delete",
    };
  }

  private recordChannelMembershipRevision(
    userId: string,
    channelId: string,
    revision: number,
    action: "put" | "delete",
  ): void {
    this.sql.exec(
      `INSERT INTO channel_membership_revisions (user_id, channel_id, revision, action)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET
         revision = excluded.revision,
         action = excluded.action`,
      userId,
      channelId,
      revision,
      action,
    );
  }

  private requireUserNotificationText(
    value: unknown,
    field: string,
    method: string,
  ): string {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${method}: ${field} is required`);
    }
    const text = value.trim();
    const max =
      field === "id"
        ? 512
        : field === "kind"
          ? 128
          : field === "title"
            ? 256
            : 4096;
    if (text.length > max)
      throw new Error(`${method}: ${field} exceeds ${max} characters`);
    return text;
  }

  private userNotificationFromRow(
    row: Record<string, unknown>,
  ): UserNotification {
    const dataJson = row["data_json"];
    let data: unknown;
    if (typeof dataJson === "string") {
      try {
        data = JSON.parse(dataJson);
      } catch {
        throw new Error(
          `Corrupt user notification ${String(row["notification_id"])}: invalid data_json`,
        );
      }
    }
    return {
      id: String(row["notification_id"]),
      userId: String(row["user_id"]),
      kind: String(row["kind"]),
      title: String(row["title"]),
      ...(typeof row["message"] === "string"
        ? { message: row["message"] }
        : {}),
      ...(data !== undefined ? { data } : {}),
      createdAt: Number(row["created_at"]),
      revision: Number(row["producer_revision"]),
    };
  }

  private writeUserNotification(
    input: PutUserNotificationInput,
    method: string,
  ): UserNotification {
    const userId = this.requireInviteUserId(input?.userId, method);
    const id = this.requireUserNotificationText(input?.id, "id", method);
    const kind = this.requireUserNotificationText(input?.kind, "kind", method);
    const title = this.requireUserNotificationText(
      input?.title,
      "title",
      method,
    );
    const message =
      typeof input.message === "string" && input.message.trim()
        ? this.requireUserNotificationText(input.message, "message", method)
        : null;
    if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
      throw new Error(
        `${method}: createdAt must be a non-negative safe integer`,
      );
    }
    if (!Number.isSafeInteger(input.revision) || input.revision <= 0) {
      throw new Error(`${method}: revision must be a positive safe integer`);
    }
    let dataJson: string | null = null;
    if (input.data !== undefined) {
      let encoded: string | undefined;
      try {
        encoded = JSON.stringify(input.data);
      } catch {
        throw new Error(`${method}: data must be JSON-serializable`);
      }
      if (encoded === undefined)
        throw new Error(`${method}: data must be JSON-serializable`);
      if (new TextEncoder().encode(encoded).byteLength > 64 * 1024) {
        throw new Error(`${method}: data exceeds 65536 serialized bytes`);
      }
      dataJson = encoded;
    }
    const existingRow = this.sql
      .exec(
        `SELECT user_id, notification_id, kind, title, message, data_json, created_at, producer_revision
           FROM user_notifications WHERE user_id = ? AND notification_id = ?`,
        userId,
        id,
      )
      .toArray()[0];
    if (existingRow) {
      const existing = this.userNotificationFromRow(existingRow);
      if (input.revision < existing.revision) return existing;
      if (input.revision === existing.revision) {
        const identical =
          existing.kind === kind &&
          existing.title === title &&
          (existing.message ?? null) === message &&
          (typeof existingRow["data_json"] === "string"
            ? existingRow["data_json"]
            : null) === dataJson &&
          existing.createdAt === input.createdAt;
        if (!identical) {
          throw new Error(
            `${method}: revision ${input.revision} was already used for other data`,
          );
        }
        return existing;
      }
    }
    this.sql.exec(
      `INSERT INTO user_notifications
         (user_id, notification_id, kind, title, message, data_json, created_at, producer_revision, acknowledged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(user_id, notification_id) DO UPDATE SET
         kind = excluded.kind,
         title = excluded.title,
         message = excluded.message,
         data_json = excluded.data_json,
         created_at = excluded.created_at,
         producer_revision = excluded.producer_revision,
         acknowledged_at = CASE
           WHEN excluded.producer_revision > user_notifications.producer_revision THEN NULL
           ELSE user_notifications.acknowledged_at
         END
       WHERE excluded.producer_revision >= user_notifications.producer_revision`,
      userId,
      id,
      kind,
      title,
      message,
      dataJson,
      input.createdAt,
      input.revision,
    );
    const row = this.sql
      .exec(
        `SELECT user_id, notification_id, kind, title, message, data_json, created_at, producer_revision
           FROM user_notifications WHERE user_id = ? AND notification_id = ?`,
        userId,
        id,
      )
      .toArray()[0];
    if (!row)
      throw new Error(`${method}: notification upsert did not produce a row`);
    return this.userNotificationFromRow(row);
  }

  private async signalUserNotificationChange(userId: string): Promise<boolean> {
    // This is the live-delivery half of the durable inbox mutation, not
    // unrelated background work. Keep it inside the originating RPC lifetime
    // so inherited authority remains valid, and propagate transport or
    // authorization failures to the producer. The durable write is
    // idempotent, so the producer can safely retry the semantic operation.
    // `false` only means that no transport for the account is currently live;
    // the next authenticated shell snapshot will still load the durable row.
    return this.rpc.call<boolean>("main", "notification.signalUserInbox", [
      userId,
    ]);
  }

  /**
   * Versioned channel-DO projection into membership + pending-invite indexes.
   * Equal-revision retries are no-ops: in particular, replaying a put after its
   * invite was acknowledged must not recreate that invite. Older revisions are
   * rejected without mutating either projection.
   */
  @schemaRpc()
  async putChannelMembership(input: PutChannelMembershipInput): Promise<{
    applied: boolean;
    currentRevision: number;
  }> {
    this.ensureReady();
    const userId = this.requireInviteUserId(
      input?.userId,
      "putChannelMembership",
    );
    const channelId = this.requireInviteChannelId(
      input?.channelId,
      "putChannelMembership",
    );
    this.assertInviteChannelAuthority(channelId, "putChannelMembership");
    const memberId = `user:${userId}`;
    if (input?.memberId !== memberId) {
      throw new Error(`putChannelMembership: memberId must equal ${memberId}`);
    }
    const handle = typeof input.handle === "string" ? input.handle.trim() : "";
    const addedBy =
      typeof input.addedBy === "string" ? input.addedBy.trim() : "";
    if (!handle) throw new Error("putChannelMembership: handle is required");
    if (!addedBy) throw new Error("putChannelMembership: addedBy is required");
    if (!Number.isSafeInteger(input.addedAt) || input.addedAt < 0) {
      throw new Error(
        "putChannelMembership: addedAt must be a non-negative integer",
      );
    }
    const revision = this.requireMembershipRevision(
      input.revision,
      "putChannelMembership",
    );
    let applied = false;
    let currentRevision = revision;
    this.ctx.storage.transactionSync(() => {
      const current = this.channelMembershipRevision(userId, channelId);
      if (current && revision <= current.revision) {
        currentRevision = current.revision;
        if (revision === current.revision && current.action !== "put") {
          throw new Error(
            `putChannelMembership: revision ${revision} was already used for delete`,
          );
        }
        return;
      }
      this.sql.exec(
        `INSERT INTO channel_membership_index
           (user_id, channel_id, member_id, handle, added_by, added_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, channel_id) DO UPDATE SET
           member_id = excluded.member_id,
           handle = excluded.handle,
           added_by = excluded.added_by,
           added_at = excluded.added_at`,
        userId,
        channelId,
        memberId,
        handle,
        addedBy,
        input.addedAt,
      );
      this.writeUserNotification(
        channelInviteNotification(
          {
            userId,
            channelId,
            memberId,
            handle,
            addedBy,
            addedAt: input.addedAt,
          },
          revision,
        ),
        "putChannelMembership",
      );
      this.recordChannelMembershipRevision(userId, channelId, revision, "put");
      applied = true;
    });
    // Re-drive the live projection even for an equal-revision retry. The
    // durable mutation may have committed before a previous signal failed.
    await this.signalUserNotificationChange(userId);
    return { applied, currentRevision };
  }

  /** Versioned channel-DO removal from membership and invite indexes. */
  @schemaRpc()
  async deleteChannelMembership(input: DeleteChannelMembershipInput): Promise<{
    applied: boolean;
    currentRevision: number;
    deleted: boolean;
  }> {
    this.ensureReady();
    const userId = this.requireInviteUserId(
      input?.userId,
      "deleteChannelMembership",
    );
    const channelId = this.requireInviteChannelId(
      input?.channelId,
      "deleteChannelMembership",
    );
    this.assertInviteChannelAuthority(channelId, "deleteChannelMembership");
    const revision = this.requireMembershipRevision(
      input.revision,
      "deleteChannelMembership",
    );
    let deleted = false;
    let applied = false;
    let currentRevision = revision;
    this.ctx.storage.transactionSync(() => {
      const current = this.channelMembershipRevision(userId, channelId);
      if (current && revision <= current.revision) {
        currentRevision = current.revision;
        if (revision === current.revision && current.action !== "delete") {
          throw new Error(
            `deleteChannelMembership: revision ${revision} was already used for put`,
          );
        }
        return;
      }
      deleted =
        this.sql
          .exec(
            `SELECT 1 FROM channel_membership_index WHERE user_id = ? AND channel_id = ?`,
            userId,
            channelId,
          )
          .toArray().length > 0;
      this.sql.exec(
        `DELETE FROM channel_membership_index WHERE user_id = ? AND channel_id = ?`,
        userId,
        channelId,
      );
      this.sql.exec(
        `DELETE FROM user_notifications WHERE user_id = ? AND notification_id = ?`,
        userId,
        channelInviteNotificationId(channelId),
      );
      this.recordChannelMembershipRevision(
        userId,
        channelId,
        revision,
        "delete",
      );
      applied = true;
    });
    await this.signalUserNotificationChange(userId);
    return { applied, currentRevision, deleted };
  }

  /** Server-only durable plan used by the child revocation cascade. */
  @schemaRpc()
  listChannelMembershipsForUser(input: {
    userId: string;
  }): ChannelMembershipCleanupPlan {
    this.ensureReady();
    const userId = this.requireInviteUserId(
      input?.userId,
      "listChannelMembershipsForUser",
    );
    const channelIds = this.sql
      .exec(
        `SELECT channel_id FROM channel_membership_index
         WHERE user_id = ? ORDER BY channel_id`,
        userId,
      )
      .toArray()
      .map((row) => String(row["channel_id"]));
    return { userId, channelIds };
  }

  /** Final idempotent scrub after every indexed channel acknowledged removal. */
  @schemaRpc()
  async purgeRevokedUserChannelIndexes(input: {
    userId: string;
  }): Promise<void> {
    this.ensureReady();
    const userId = this.requireInviteUserId(
      input?.userId,
      "purgeRevokedUserChannelIndexes",
    );
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `DELETE FROM channel_membership_index WHERE user_id = ?`,
        userId,
      );
      this.sql.exec(`DELETE FROM user_notifications WHERE user_id = ?`, userId);
    });
    await this.signalUserNotificationChange(userId);
  }

  /** Idempotent channel-DO removal from the workspace inbox. */
  @schemaRpc()
  async deleteChannelInvite(
    input: DeleteChannelInviteInput,
  ): Promise<{ deleted: boolean }> {
    this.ensureReady();
    const userId = this.requireInviteUserId(
      input?.userId,
      "deleteChannelInvite",
    );
    const channelId = this.requireInviteChannelId(
      input?.channelId,
      "deleteChannelInvite",
    );
    this.assertInviteChannelAuthority(channelId, "deleteChannelInvite");
    const existed =
      this.sql
        .exec(
          `SELECT 1 FROM user_notifications WHERE user_id = ? AND notification_id = ?`,
          userId,
          channelInviteNotificationId(channelId),
        )
        .toArray().length > 0;
    if (existed) {
      this.sql.exec(
        `DELETE FROM user_notifications WHERE user_id = ? AND notification_id = ?`,
        userId,
        channelInviteNotificationId(channelId),
      );
    }
    await this.signalUserNotificationChange(userId);
    return { deleted: existed };
  }

  /** Trusted channel-DO lookup for its verified calling user and own channel. */
  @schemaRpc()
  getChannelInvite(input: DeleteChannelInviteInput): ChannelInvite | null {
    this.ensureReady();
    const userId = this.requireInviteUserId(input?.userId, "getChannelInvite");
    const channelId = this.requireInviteChannelId(
      input?.channelId,
      "getChannelInvite",
    );
    this.assertInviteChannelAuthority(channelId, "getChannelInvite");
    const rows = this.sql
      .exec(
        `SELECT user_id, notification_id, kind, title, message, data_json, created_at, producer_revision
           FROM user_notifications
          WHERE user_id = ? AND notification_id = ? AND acknowledged_at IS NULL`,
        userId,
        channelInviteNotificationId(channelId),
      )
      .toArray();
    if (rows.length === 0) return null;
    const invite = channelInviteFromNotification(
      this.userNotificationFromRow(rows[0]!),
    );
    return invite?.channelId === channelId && invite.userId === userId
      ? invite
      : null;
  }

  private verifiedUserNotificationCallerUserId(method: string): string {
    const userId = this.caller?.userId;
    if (!userId)
      throw new Error(`${method} requires an authenticated workspace account`);
    return this.requireInviteUserId(userId, method);
  }

  /** Generic durable publish surface for trusted workspace services. */
  @schemaRpc()
  async putUserNotification(
    input: PutUserNotificationInput,
  ): Promise<UserNotification> {
    this.ensureReady();
    if (input?.kind === CHANNEL_INVITE_NOTIFICATION_KIND) {
      throw new Error(
        "putUserNotification: channel.invite is reserved for the revisioned channel membership projection",
      );
    }
    const notification = this.writeUserNotification(
      input,
      "putUserNotification",
    );
    await this.signalUserNotificationChange(notification.userId);
    return notification;
  }

  /** Generic durable removal surface for a notification's trusted producer. */
  @schemaRpc()
  async deleteUserNotification(input: { userId: string; id: string }): Promise<{
    deleted: boolean;
  }> {
    this.ensureReady();
    const userId = this.requireInviteUserId(
      input?.userId,
      "deleteUserNotification",
    );
    const id = this.requireUserNotificationText(
      input?.id,
      "id",
      "deleteUserNotification",
    );
    if (id.startsWith(`${CHANNEL_INVITE_NOTIFICATION_KIND}:`)) {
      throw new Error(
        "deleteUserNotification: channel invitation notifications are owned by the channel membership projection",
      );
    }
    const deleted =
      this.sql
        .exec(
          `SELECT 1 FROM user_notifications WHERE user_id = ? AND notification_id = ?`,
          userId,
          id,
        )
        .toArray().length > 0;
    if (deleted) {
      this.sql.exec(
        `DELETE FROM user_notifications WHERE user_id = ? AND notification_id = ?`,
        userId,
        id,
      );
    }
    await this.signalUserNotificationChange(userId);
    return { deleted };
  }

  /** Durable account inbox; never enumerates producer/channel DOs. */
  @schemaRpc()
  listUserNotificationsForMe(input?: {
    includeAcknowledged?: boolean;
    limit?: number;
  }): UserNotificationListResult {
    this.ensureReady();
    const userId = this.verifiedUserNotificationCallerUserId(
      "listUserNotificationsForMe",
    );
    const includeAcknowledged = input?.includeAcknowledged === true;
    const limit =
      typeof input?.limit === "number" &&
      Number.isInteger(input.limit) &&
      input.limit > 0
        ? Math.min(input.limit, 500)
        : null;
    // The inbox is the durable record (messaging plan §4.10.8): the default view
    // is what still wants attention; history is opt-in and bounded.
    const rows = this.sql
      .exec(
        `SELECT inbox.user_id, inbox.notification_id, inbox.kind, inbox.title, inbox.message,
                inbox.data_json, inbox.created_at, inbox.producer_revision, inbox.acknowledged_at
           FROM user_notifications AS inbox
          WHERE inbox.user_id = ?${includeAcknowledged ? "" : " AND inbox.acknowledged_at IS NULL"}
            AND NOT (
              inbox.kind = 'channel.invite'
              AND EXISTS (
                SELECT 1
                  FROM user_notifications AS message
                 WHERE message.user_id = inbox.user_id
                   AND message.kind = 'agent.message'
                   AND json_extract(message.data_json, '$.channelId') =
                       json_extract(inbox.data_json, '$.channelId')
              )
            )
          ORDER BY inbox.created_at DESC, inbox.notification_id ASC${limit ? ` LIMIT ${limit}` : ""}`,
        userId,
      )
      .toArray();
    return {
      notifications: rows.map((row) => {
        const notification = this.userNotificationFromRow(row);
        const acknowledgedAt = row["acknowledged_at"];
        return typeof acknowledgedAt === "number"
          ? { ...notification, acknowledgedAt }
          : notification;
      }),
    };
  }

  /** Acknowledge/dismiss one notification for the verified account caller. */
  @schemaRpc()
  async acknowledgeUserNotification(input: {
    id: string;
  }): Promise<UserNotificationAcknowledgementResult> {
    this.ensureReady();
    const userId = this.verifiedUserNotificationCallerUserId(
      "acknowledgeUserNotification",
    );
    const id = this.requireUserNotificationText(
      input?.id,
      "id",
      "acknowledgeUserNotification",
    );
    const acknowledged =
      this.sql
        .exec(
          `SELECT 1 FROM user_notifications
            WHERE user_id = ? AND notification_id = ? AND acknowledged_at IS NULL`,
          userId,
          id,
        )
        .toArray().length > 0;
    if (acknowledged) {
      this.sql.exec(
        `UPDATE user_notifications SET acknowledged_at = ?
          WHERE user_id = ? AND notification_id = ? AND acknowledged_at IS NULL`,
        Date.now(),
        userId,
        id,
      );
    }
    await this.signalUserNotificationChange(userId);
    return { acknowledged };
  }

  /**
   * Enumerate every durable channel log (the smallest primitive reflecting
   * durable truth for `vibestudio channel list`). There is no host-side live-DO
   * instance registry — workerd addresses DOs by one-way-hashed object id — so
   * the semantic control-plane `log_heads` index (log_kind = 'channel') is the authoritative
   * roster of channels that have ever received a durable envelope. Returns one
   * row per channel log id (`branch:channel:<channelId>`), newest first. The CLI
   * annotates each with its bound context via the channel DO's `getContextId`.
   */
  @schemaRpc()
  listChannelLogs(): {
    channelId: string;
    logId: string;
    createdAt: number | null;
  }[] {
    this.ensureReady();
    const rows = this.sql
      .exec(
        `SELECT log_id AS logId, MIN(created_at) AS createdAt
         FROM log_heads WHERE log_kind = 'channel'
         GROUP BY log_id ORDER BY createdAt DESC`,
      )
      .toArray();
    return rows.map((row) => {
      const logId = String(row["logId"]);
      const channelId = channelIdFromTrajectoryLog(logId);
      if (!channelId) {
        throw new Error(
          `Channel log index contains a non-canonical trajectory identity: ${logId}`,
        );
      }
      const createdAt = row["createdAt"];
      return {
        channelId,
        logId,
        createdAt: typeof createdAt === "number" ? createdAt : null,
      };
    });
  }

  @schemaRpc()
  async validateGadHashes(): Promise<{ ok: boolean; errors: string[] }> {
    const integrity = await this.checkGadIntegrity();
    return {
      ok: integrity.ok,
      errors: integrity.errors.map(
        (error) => `${String(error["type"])}: ${String(error["message"])}`,
      ),
    };
  }

  @schemaRpc()
  clearDirtyAfterValidation(): Promise<{ ok: boolean; errors: string[] }> {
    return this.validateGadHashes();
  }

  @schemaRpc()
  async checkGadIntegrity(): Promise<{
    ok: boolean;
    errors: Array<Record<string, unknown>>;
  }> {
    this.ensureReady();
    const errors: Array<Record<string, unknown>> = [];

    const logIntegrity = await this.checkLogIntegrity({});
    errors.push(...logIntegrity.errors);

    try {
      this.semanticVcsStore().assertIntegrity();
    } catch (error) {
      errors.push({
        type: "semantic-vcs",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof SemanticVcsError
          ? { code: error.code, detail: error.detail }
          : {}),
      });
    }

    for (const orphan of this.inspectPublicationIntegrity({}).rows) {
      errors.push({
        ...orphan,
        type: "publication",
        issue: orphan.type,
        message: "publication origin is missing",
      });
    }

    for (const event of this.sql
      .exec(`SELECT * FROM log_events`)
      .toArray() as JsonRecord[]) {
      for (const field of [
        "actor_json",
        "to_json",
        "payload_ref_json",
        "annotations_json",
      ] as const) {
        const path = findPrivateParticipantMetadataPath(
          parseJson(asString(event[field])),
        );
        if (path) {
          errors.push({
            type: "log-event-shape",
            message: "log event contains private participant metadata",
            envelopeId: event["envelope_id"] as JsonValue,
            field,
            path,
          });
        }
      }
    }

    for (const row of this.inspectStorageDiagnostics({}).rows) {
      errors.push({
        type: "storage-diagnostic",
        message: "oversized or missing indexed storage artifact",
        ...row,
      });
    }

    return { ok: errors.length === 0, errors };
  }
  private ensureEmptyState(): void {
    // Semantic workspace genesis is context-scoped and is created lazily by
    // SemanticVcsStore.ensureWorkspace. Schema creation itself has no authority
    // to invent a workspace/context identity.
  }

  private transaction<T>(fn: () => T): T {
    return this.ctx.storage.transactionSync(fn);
  }
}

/** Whether a payload kind is a member of the agentic EventKind vocabulary. */
/**
 * The channel's durable relationship facts, as roster actions. `presence` is
 * kept for direct appenders that phrase a roster change that way (its payload
 * then carries `action`).
 */
function rosterActionForPayloadKind(
  payloadKind: string,
): "join" | "update" | "leave" | null {
  switch (payloadKind) {
    case "channel.subscription.opened":
      return "join";
    case "channel.subscription.revised":
      return "update";
    case "channel.subscription.ended":
    case "channel.subscription.detached":
      return "leave";
    case "presence":
      // The payload names the action itself.
      return null;
    default:
      return null;
  }
}

function isStoredEventKind(payloadKind: string): boolean {
  return STORED_EVENT_KINDS.has(payloadKind);
}

const STORED_EVENT_KINDS = new Set<string>([
  "message.started",
  "message.delta",
  "message.completed",
  "message.failed",
  "invocation.started",
  "invocation.progress",
  "invocation.output",
  "invocation.completed",
  "invocation.failed",
  "invocation.cancelled",
  "invocation.abandoned",
  "approval.requested",
  "approval.resolved",
  "ui.inline_rendered",
  "ui.action_bar.updated",
  "ui.feedback",
  "messageType.registered",
  "messageType.cleared",
  "custom.started",
  "custom.updated",
  "memory.recalled",
  "external.envelope_published",
  "external.envelope_observed",
  "external.participant_observed",
  "branch.created",
  "branch.forked",
  "branch.head_changed",
  "channel.forked",
  "channel.fork_renamed",
  "channel.fork_archived",
  "turn.opened",
  "turn.waiting",
  "turn.closed",
  "system.event",
  "system.compaction_recorded",
  "build.completed",
]);
