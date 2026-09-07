/**
 * PubSubChannel — Durable Object for pub/sub messaging.
 *
 * WS2: a GENERIC substrate — durable ordered log (delegated to GAD's unified
 * log), live fan-out, roster, and call transport. Every agentic decision
 * (agent-hop stamping, conversation fold, invocation payload vocabulary)
 * lives in `@workspace/channel-policies`, selected by name from channel
 * config and hosted by `policy-host.ts`.
 *
 * State taxonomy (P1): the channel log in GAD is the authority;
 * `pending_calls` (calls.ts), `policy_state:*` (policy-host.ts), and
 * `dedup_keys` are declared caches — deletable at any moment; `participants`
 * is operational transport state (live connections, observed into the log as
 * presence events).
 */

// oxlint-disable-next-line typescript/triple-slash-reference -- workerd.d.ts supplies runtime-only ambient WebSocket APIs.
/// <reference path="./workerd.d.ts" />
import {
  createDurableObjectServiceClient,
  assertExactSqlTableSchema,
  rpc,
  DurableObjectBase,
  type DurableObjectContext,
  type DurableObjectServiceClient,
} from "@workspace/runtime/worker/kernel";
import { canonicalJson } from "@vibestudio/content-addressing";
import type { ChannelEvent } from "@workspace/pubsub";
import {
  channelSubscriptionQueuingStrategy,
  encodeChannelSubscriptionRecord,
  enqueueChannelSubscriptionBytes,
} from "@workspace/pubsub";
import type {
  BootstrapSnapshot,
  ChannelAgenticContext,
  ChannelInvite,
  ChannelReplayAfterRequest,
  ParticipantSnapshot,
  RpcChannelMessage,
  ServerLogEvent,
} from "@workspace/pubsub";

const PUBSUB_CHANNEL_SCHEMA_BASELINE = 120;
const STRUCTURED_DELIVERY_RETRY_MS = 1_000;
const STRUCTURED_DELIVERY_MAX_RETRY_MS = 30_000;
import type {
  DeleteChannelInviteInput,
  DeleteChannelMembershipInput,
  PutChannelMembershipInput,
} from "@vibestudio/shared/channelInvites";
import type { DoAlarmSchedule } from "@vibestudio/shared/doDispatcher";
import type {
  ClaimRequest,
  ClaimSettlement,
  DurableWorkQueue,
  SettleRequest,
  WorkClaim,
} from "@vibestudio/shared/durableWork";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  participantRefFromMetadata,
  publicParticipantMetadata,
  type AgenticEvent,
  type AppendIdempotency,
  type ForkProjection,
  type InvocationOutcome,
  type LogEnvelope,
  type MessageBlockInput,
  type ParticipantRef,
} from "@workspace/agentic-protocol";
import {
  participantMetadataSchema,
  type SubscribeResult,
  type ChannelJoinInput,
  type ChannelRelationshipPayload,
  type ChannelConfig,
  type LockedChannelMembershipPolicy,
  type PresencePayload,
  type StoredAttachment,
} from "./types.js";
import {
  broadcast,
  buildChannelEvent,
  channelEventToRpcSignal,
  loadBroadcastParticipants,
  type BroadcastDeps,
  type BroadcastParticipant,
} from "./broadcast.js";
import { ChannelDeliveryProjection } from "./delivery-projection.js";
import { ChannelLog, type ChannelReplayContext } from "./log-store.js";
import type { MessageTypeDefinition } from "@workspace/pubsub";
import { PolicyHost } from "./policy-host.js";
import { CallTransport, type PendingCallRow } from "./calls.js";
import {
  assertDeclaredAgenticEventAudience,
  type PolicyEnvelopeView,
} from "@workspace/channel-policies";
import {
  AGENT_INSPECTION_METHODS,
  AGENT_INSPECTION_RPC_METHOD,
  isAgentInspectionMethod,
  type AgentInspectionMethod,
} from "@vibestudio/shared/agentInspection";

/** Subscribed humans move through these activity states without being removed
 * from the roster. Only domain activity resets these clocks. */
const PRESENCE_IDLE_MS = 5 * 60 * 1000;
const PRESENCE_AWAY_MS = 30 * 60 * 1000;
/** WP8 §3 — how long a departed user's `presence_last_seen` row is retained so
 *  offline members still render "last seen Xm ago". A bounded window (decision
 *  §8.3); older rows are swept alongside the participant sweep. Their account
 *  identity persists in the hub-owned identity DB regardless. */
const PRESENCE_LAST_SEEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Default channel-envelope replay window. */
const REPLAY_LIMIT = 50;
/** Dedup keys are a latency cache; the durable dedupe is the `ik:{key}`
 *  envelope id in the log lineage. */
const DEDUP_TTL_MS = 5 * 60 * 1000;
const INVITE_INDEX_RETRY_MS = 5_000;
const INVITE_INDEX_REVISION_KEY = "inviteIndexRevision";

const DEFAULT_POLICY_NAME = "agentic.conversation.v1";

/** Service protocol the channel DO resolves for sibling channels (fork parent,
 *  lineage forwarding). */
const CHANNEL_SERVICE_PROTOCOL = "vibestudio.channel.v1";
const GAD_WORKSPACE_SERVICE_PROTOCOL = "vibestudio.gad.workspace.v1";
/** Signal contentType for the ephemeral fork.head_changed lineage badge. */
const FORK_HEAD_CHANGED_SIGNAL = "fork.head_changed";
const FORK_OP_RECONCILE_MS = 5_000;
const LINEAGE_HEAD_COALESCE_MS = 100;
type ChannelMaintenanceKind =
  | "invite-index"
  | "call-deadline"
  | "fork-reconcile"
  | "lineage-head";

/** Ordered fork-op phases; a resume skips everything at or below the recorded
 * phase. `rollback-pending` remains retryable until owned context cleanup is
 * confirmed; `rolledback` is terminal. */
const FORK_PHASES = [
  "journaled",
  "cloned",
  "postcloned",
  "seeded",
  "announced",
  "done",
] as const;
type ForkPhase =
  | (typeof FORK_PHASES)[number]
  | "rollback-pending"
  | "rolledback";
function forkPhaseReached(phase: string, target: ForkPhase): boolean {
  const a = FORK_PHASES.indexOf(phase as (typeof FORK_PHASES)[number]);
  const b = FORK_PHASES.indexOf(target as (typeof FORK_PHASES)[number]);
  return a >= 0 && b >= 0 && a >= b;
}

/** A resolvable durable-object reference. */
interface DORef {
  source: string;
  className: string;
  objectKey: string;
}

/** Build a DO RPC target id from a DORef: "do:{source}:{className}:{objectKey}". */
function doTarget(ref: DORef): string {
  return `do:${ref.source}:${ref.className}:${ref.objectKey}`;
}

/** The opening seed of an edit-/deep-dive fork. `blocks` are appended as a
 *  PRIMARY user message on the child channel by `appendSeed`. */
interface ForkSeed {
  blocks: MessageBlockInput[];
  replaces?: { messageId: string };
}

type ForkLocus =
  | { kind: "head" }
  | { kind: "after-message"; messageId: string }
  | { kind: "before-message"; messageId: string };

/** Request for the durable `fork()` RPC. `include` scopes which forkable agents
 *  are cloned (root-context entity scope → cloneContext.include); omit to clone
 *  every agent vessel in the roster. `exclude`/`replace` are REMOVED (C7). */
interface ForkRequest {
  /** Stable identity allocated once by the caller and retained by transport
   * retries. It is also the saga identity and clone target key. */
  operationId: string;
  locus: ForkLocus;
  seed?: ForkSeed;
  label?: string;
  reason: string;
  include?: string[];
}

type ResolvedForkSeed = Omit<ForkSeed, "replaces"> & {
  author: ParticipantRef;
  replaces?: { messageId: string; seq: number };
};

/** Fully resolved request retained in the fork journal. Numeric log positions
 * are authority-derived once and never recomputed during crash recovery. */
interface ForkOpts extends Omit<ForkRequest, "seed"> {
  request: ForkRequest;
  forkPointPubsubId: number;
  seed?: ResolvedForkSeed;
}

/** Result of a fork — the fresh channel + context and the cloned agents, so the
 *  caller can address them without re-resolving the new roster. */
interface ForkResult {
  forkId: string;
  forkedChannelId: string;
  forkedContextId: string;
  clonedParticipants: string[];
  clonedAgents: Array<{ participantId: string } & DORef>;
  seededMessageId?: string;
}

/** Provenance of a channel in the fork/task tree. */
type ChannelProvenance =
  | { kind: "root" }
  | {
      kind: "fork";
      forkedFrom: string;
      parentContextId: string;
      forkPointId: number;
      rootChannelId: string;
    }
  | {
      kind: "task";
      parentChannelId: string;
      parentContextId: string;
      runId: string;
    };

/** Pending fork seed marker consumed by `appendSeed` for idempotent fork recovery. */
interface ForkSeedMarker {
  forkId: string;
  parentChannelId: string;
  seed: ResolvedForkSeed;
}

/** Subset of `runtime.cloneContext`'s result the fork op consumes. */
interface ClonedEntityView {
  sourceId: string;
  newId: string;
  kind: "do" | "worker";
  source: string;
  className?: string;
  sourceKey: string;
  newKey: string;
  targetId: string;
}
interface CloneContextResultView {
  contextId: string;
  entities: ClonedEntityView[];
}

function parseDOParticipantId(
  participantId: string,
): { source: string; className: string; objectKey: string } | null {
  if (!participantId.startsWith("do:")) return null;
  const parts = participantId.slice(3).split(":");
  if (parts.length < 3) return null;
  const [source, className, ...objectKeyParts] = parts;
  const objectKey = objectKeyParts.join(":");
  if (!source || !className || !objectKey) return null;
  return { source, className, objectKey };
}

/**
 * Stable principal-derived human participant id (WP6 §4): `user:<userId>`.
 * One roster identity per human, shared by every live panel/device.
 */
function isUserParticipantId(participantId: string): boolean {
  return participantId.startsWith("user:");
}

/** Build the stable channel participant id from the canonical bare account id. */
function toUserMemberId(userId: string): string {
  return `user:${userId}`;
}

/** The bare `userId` behind a `user:<id>` member id (idempotent on a bare id). */
function bareUserId(userIdOrRef: string): string {
  return userIdOrRef.startsWith("user:")
    ? userIdOrRef.slice("user:".length)
    : userIdOrRef;
}

function requireBareUserId(value: unknown, method: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.startsWith("user:")
  ) {
    throw new Error(`${method}: userId must be a bare workspace account id`);
  }
  return value.trim();
}

/**
 * A human roster row stores ONLY the stable identity (`id: user:<userId>`,
 * `kind: "user"`) plus functional transport fields (methods, typing, …).
 * Mutable profile — handle/displayName/color/avatar — is NEVER frozen into
 * the row; renderers resolve it live from the host-projected identity read
 * (WP0 §3.7, WP6 §3). Client-asserted identity fields are dropped here: data
 * hygiene (one source of truth), not an inter-user security wall (plan §0.0).
 */
function scrubUserParticipantMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const scrubbed = { ...metadata };
  delete scrubbed["handle"];
  delete scrubbed["name"];
  delete scrubbed["displayName"];
  delete scrubbed["color"];
  delete scrubbed["avatar"];
  scrubbed["type"] = "user";
  scrubbed["kind"] = "user";
  return scrubbed;
}

const AGENT_INSPECTION_TIMEOUT_MS = 5_000;

interface AgentInspectionResult {
  participantId: string;
  channelId: string;
  methodName: string;
  result: unknown;
  isError?: boolean;
  roster: {
    present: boolean;
    transport?: string;
    metadata?: Record<string, unknown>;
  };
}

interface ChannelDeliveryInput {
  deliveryId: string;
  channelId: string;
  channelRef: { source: string; className: string; objectKey: string };
  participantId: string;
  subscriptionRevision: number;
  eventSequence: number;
  envelope: RpcChannelMessage;
  agenticContext: ChannelAgenticContext | null;
}

interface ChannelDeliveryOutcome {
  deliveryId: string;
  disposition: "processed" | "duplicate" | "declined" | "retired";
  recipientExecutionStartedAt?: number;
}

/** A durable channel membership record (WP7 §3) — separate from the ephemeral
 *  `participants` roster row. Survives reconnects and offline stretches. */
interface ChannelMember {
  /** Bare `userId` (the `user:<id>` prefix stripped). */
  userId: string;
  /** Stable member id / `channel_members` PK (`user:<userId>`). */
  memberId: string;
  /** Invitee handle snapshot at add time (profiles still render LIVE, WP6 §3). */
  handle: string;
  /** Acting user's member id (or raw callerId for agent/worker adds). */
  addedBy: string;
  addedAt: number;
}

type ChannelPresenceStatus = "online" | "idle" | "away" | "offline";

interface ChannelPresenceEntry {
  participantId: string;
  userId: string;
  status: ChannelPresenceStatus;
  lastActiveAt: number | null;
  lastSeenAt: number | null;
  sessionCount: number;
}

export class PubSubChannel extends DurableObjectBase {
  static override schemaVersion = PUBSUB_CHANNEL_SCHEMA_BASELINE;

  private _channelLog: ChannelLog | null = null;
  private _inviteIndex: DurableObjectServiceClient | null = null;
  private _policyHost: PolicyHost | null = null;
  private _calls: CallTransport | null = null;
  private _deliveryProjection: ChannelDeliveryProjection | null = null;
  private readonly publishDedupInFlight = new Map<
    string,
    Promise<ChannelEvent>
  >();
  private readonly relationshipMutations = new Map<string, Promise<void>>();
  private broadcastParticipantCache: BroadcastParticipant[] | null = null;
  private readonly subscriptionStreams = new Map<
    string,
    {
      participantId: string;
      deliveryId: string;
      subscriptionId: string;
      token: symbol;
      openedAt: number;
      controller: ReadableStreamDefaultController<Uint8Array>;
    }
  >();
  private readonly lineageSubscriptionStreams = new Map<
    string,
    {
      participantId: string;
      deliveryId: string;
      token: symbol;
      controller: ReadableStreamDefaultController<Uint8Array>;
    }
  >();

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
  }

  protected override afterSchemaReady(): void {
    try {
      this.sql.exec(`PRAGMA foreign_keys = ON`);
    } catch {
      /* workerd may ignore pragmas */
    }
    // Live session rows belong to routed external connections. They are never
    // routing authority and cannot survive a fresh activation. Stamp each
    // user's retained last-seen summary before dropping the session rows so a
    // user connected across a restart shows "last seen at restart" instead of
    // vanishing from presence history entirely.
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO presence_last_seen (participant_id, last_seen)
           SELECT id, COALESCE(last_active_at, ?) FROM participants WHERE id LIKE 'user:%'
         ON CONFLICT(participant_id) DO UPDATE SET last_seen = excluded.last_seen`,
        Date.now(),
      );
      this.sql.exec(`DELETE FROM participants`);
    });
  }

  protected createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY,
        metadata TEXT NOT NULL,
        transport TEXT NOT NULL CHECK (transport IN ('rpc','do')),
        -- Freshest real client activity across a user's subscriptions.
        last_active_at INTEGER,
        presence_status TEXT CHECK (presence_status IN ('online','idle','away')),
        handle TEXT
      )
    `);
    this.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_handle
         ON participants(handle) WHERE handle IS NOT NULL`,
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_calls (
        transport_call_id TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL,
        turn_id TEXT,
        caller_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        method TEXT NOT NULL,
        args TEXT,
        created_at INTEGER NOT NULL,
        deadline_at INTEGER
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_pending_calls_target ON pending_calls(target_id)`,
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_pending_calls_deadline
         ON pending_calls(deadline_at) WHERE deadline_at IS NOT NULL`,
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS provider_call_claims (
        transport_call_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        provider_generation_id TEXT NOT NULL,
        claim_generation INTEGER NOT NULL CHECK (claim_generation > 0),
        claimed_at INTEGER NOT NULL,
        execution_started_at INTEGER
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_delivery_latency_histogram (
        metric TEXT NOT NULL CHECK (metric IN (
          'publish-to-recipient-execution',
          'call-to-provider-execution',
          'result-to-caller-settlement'
        )),
        upper_bound_ms INTEGER NOT NULL,
        samples INTEGER NOT NULL DEFAULT 0,
        total_ms INTEGER NOT NULL DEFAULT 0,
        maximum_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (metric, upper_bound_ms)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS dedup_keys (
        key TEXT PRIMARY KEY,
        result_id INTEGER,
        created_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_dedup_keys_created ON dedup_keys(created_at)`,
    );
    ChannelDeliveryProjection.createTables(this.sql);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_maintenance_queue (
        item_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL
          CHECK (kind IN ('invite-index', 'call-deadline', 'fork-reconcile', 'lineage-head')),
        target_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_generation INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_attempt_at INTEGER,
        disposition TEXT NOT NULL DEFAULT 'ready'
          CHECK (disposition IN ('ready', 'leased', 'retrying'))
      )
    `);
    assertExactSqlTableSchema(this.sql, {
      table: "channel_maintenance_queue",
      columns: [
        ["item_id", "TEXT", false],
        ["kind", "TEXT", true],
        ["target_id", "TEXT", true],
        ["idempotency_key", "TEXT", true],
        ["attempts", "INTEGER", true, "0"],
        ["next_attempt_at", "INTEGER", true],
        ["lease_owner", "TEXT", false],
        ["lease_generation", "INTEGER", true, "0"],
        ["created_at", "INTEGER", true],
        ["last_attempt_at", "INTEGER", false],
        ["disposition", "TEXT", true, "'ready'"],
      ],
      primaryKey: ["item_id"],
    });
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_channel_maintenance_claim
        ON channel_maintenance_queue(disposition, next_attempt_at, created_at)
    `);
    // Fork-operation journal (single-writer: this parent channel DO). The op's
    // durability lives HERE — the row is written BEFORE any host/DO call, and its
    // `phase` advances after each idempotent step so a crash resumes (or rolls
    // back) from the alarm reconciler. The `opts` blob carries the seed/label/
    // reason; `forked_*` are recorded once the clone exists (WS2 §fork).
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS fork_ops (
        fork_id TEXT PRIMARY KEY,
        fork_point_id INTEGER NOT NULL,
        opts TEXT NOT NULL,
        phase TEXT NOT NULL,
        forked_channel_id TEXT,
        forked_context_id TEXT,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_fork_ops_phase ON fork_ops(phase)`,
    );
    // Incremental, rebuildable fork metadata projection. The unified log stays
    // authoritative; these tables make fork locus resolution and roster reads
    // proportional to new events / fork count instead of total conversation
    // history. A cloned child prunes message/turn rows past its fork boundary
    // and starts with an empty direct-child projection.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS fork_view_cursor (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        folded_through_seq INTEGER NOT NULL
      )
    `);
    this.sql.exec(
      `INSERT OR IGNORE INTO fork_view_cursor (singleton, folded_through_seq) VALUES (1, 0)`,
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS fork_message_loci (
        message_id TEXT PRIMARY KEY,
        first_seq INTEGER NOT NULL,
        terminal_seq INTEGER,
        turn_id TEXT,
        actor_kind TEXT NOT NULL
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_fork_message_first ON fork_message_loci(first_seq)`,
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS fork_turn_loci (
        turn_id TEXT PRIMARY KEY,
        opened_seq INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS fork_projection (
        fork_id TEXT PRIMARY KEY,
        parent_channel_id TEXT NOT NULL,
        forked_channel_id TEXT NOT NULL UNIQUE,
        forked_context_id TEXT NOT NULL,
        fork_point_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        reason TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        created_at_seq INTEGER NOT NULL,
        head_seq INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_fork_projection_created ON fork_projection(created_at_seq)`,
    );
    // Every fork reports its latest durable head directly to the lineage root.
    // The single-row outbox coalesces bursts without losing the latest seq;
    // the root's table is the durable cross-session unread authority.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS lineage_head_outbox (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        head_seq INTEGER NOT NULL,
        roster_changed INTEGER NOT NULL DEFAULT 0 CHECK (roster_changed IN (0, 1)),
        next_attempt_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS lineage_heads (
        channel_id TEXT PRIMARY KEY,
        head_seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    // Durable channel membership (WP7 §3). This is deliberately separate from
    // the ephemeral `participants` roster, which is rebuilt on reconnect. The
    // workspace-wide pending-invite index lives in GAD; membership carries no
    // duplicate acknowledgement state.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_members (
        user_id  TEXT PRIMARY KEY,   -- user:<userId>
        handle   TEXT NOT NULL,
        added_by TEXT NOT NULL,      -- user:<userId> (or raw callerId)
        added_at INTEGER NOT NULL
      )
    `);
    // Crash-safe membership → workspace-inbox projection. A row is replaced
    // atomically whenever the desired state changes, and removed only when the
    // matching op_id is confirmed by GAD, so an interleaved add/remove cannot
    // let an older response erase the newer intent.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS invite_index_ops (
        user_id    TEXT PRIMARY KEY,   -- user:<userId>
        op_id      TEXT NOT NULL UNIQUE,
        revision   INTEGER NOT NULL CHECK (revision > 0),
        action     TEXT NOT NULL CHECK (action IN ('put', 'delete')),
        handle     TEXT,
        added_by   TEXT,
        added_at   INTEGER,
        updated_at INTEGER NOT NULL,
        CHECK (
          action = 'delete' OR
          (handle IS NOT NULL AND added_by IS NOT NULL AND added_at IS NOT NULL)
        )
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_invite_index_ops_updated ON invite_index_ops(updated_at)`,
    );
    // WP8 §3 — retained last-seen for account presence. When a user's last
    // subscribed panel leaves, we stamp `last_seen`
    // here so an offline member still renders "last seen Xm ago". Deliberately
    // OUTLIVES the ephemeral `participants` row (which is deleted on leave); a
    // (re)join clears the row. Bounded by PRESENCE_LAST_SEEN_RETENTION_MS.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS presence_last_seen (
        participant_id TEXT PRIMARY KEY,    -- user:<userId>
        last_seen      INTEGER NOT NULL
      )
    `);
  }

  protected override requiredTables(): readonly string[] {
    return [
      "participants",
      "pending_calls",
      "provider_call_claims",
      "channel_delivery_latency_histogram",
      "dedup_keys",
      "channel_relationships",
      "channel_delivery_mailbox",
      "channel_delivery_event_context",
      "channel_delivery_projection_cursor",
      "channel_maintenance_queue",
      "fork_ops",
      "fork_view_cursor",
      "fork_message_loci",
      "fork_turn_loci",
      "fork_projection",
      "lineage_head_outbox",
      "lineage_heads",
      "channel_members",
      "invite_index_ops",
      "presence_last_seen",
      "channel_relationships",
      "channel_delivery_mailbox",
      "channel_delivery_projection_cursor",
      "channel_delivery_context",
      "channel_delivery_message_senders",
      "channel_receipts",
    ];
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  private get broadcastDeps(): BroadcastDeps {
    return {
      objectKey: this.objectKey,
      participants: () => {
        this.broadcastParticipantCache ??= loadBroadcastParticipants(this.sql);
        return this.broadcastParticipantCache;
      },
      deliverParticipant: (participantId, payload) =>
        this.deliverParticipantPayload(participantId, payload),
    };
  }

  private invalidateBroadcastParticipants(): void {
    this.broadcastParticipantCache = null;
  }

  protected override durableWorkQueues(): readonly DurableWorkQueue[] {
    return ["channel-delivery"];
  }

  protected override releaseDurableWorkClaims(
    previousWorkerId: string | null,
    _nextWorkerId: string,
  ): void {
    if (!previousWorkerId) return;
    const now = Date.now();
    for (const table of [
      "channel_delivery_mailbox",
      "channel_maintenance_queue",
    ] as const) {
      this.sql.exec(
        `UPDATE ${table}
            SET ${table === "channel_delivery_mailbox" ? "state" : "disposition"} = 'ready',
                ${table === "channel_delivery_mailbox" ? "claimed_by" : "lease_owner"} = NULL,
                next_attempt_at = ?
          WHERE ${table === "channel_delivery_mailbox" ? "state" : "disposition"} = 'leased'
            AND ${table === "channel_delivery_mailbox" ? "claimed_by" : "lease_owner"} = ?`,
        now,
        previousWorkerId,
      );
    }
  }

  private nextStructuredDeliveryRecoveryAt(): number | null {
    const value = this.sql
      .exec(
        `SELECT MIN(next_attempt_at) AS due
           FROM channel_delivery_mailbox
          WHERE state = 'retrying'`,
      )
      .toArray()[0]?.["due"];
    return typeof value === "number" ? value : null;
  }

  private materializeDueMaintenance(now: number): void {
    const insert = (
      itemId: string,
      kind: ChannelMaintenanceKind,
      targetId: string,
      createdAt: number,
    ) => {
      this.sql.exec(
        `INSERT OR IGNORE INTO channel_maintenance_queue (
           item_id, kind, target_id, idempotency_key, attempts,
           next_attempt_at, lease_generation, created_at, disposition
         ) VALUES (?, ?, ?, ?, 0, ?, 0, ?, 'ready')`,
        itemId,
        kind,
        targetId,
        `channel-maintenance:${this.objectKey}:${itemId}`,
        now,
        createdAt,
      );
    };
    for (const row of this.sql
      .exec(
        `SELECT user_id, op_id, updated_at
           FROM invite_index_ops
          WHERE updated_at + ? <= ?`,
        INVITE_INDEX_RETRY_MS,
        now,
      )
      .toArray()) {
      insert(
        `maintenance:invite-index:${String(row["op_id"])}`,
        "invite-index",
        String(row["user_id"]),
        Number(row["updated_at"]),
      );
    }
    for (const row of this.sql
      .exec(
        `SELECT transport_call_id, deadline_at
           FROM pending_calls
          WHERE deadline_at IS NOT NULL AND deadline_at <= ?`,
        now,
      )
      .toArray()) {
      insert(
        `maintenance:call-deadline:${String(row["transport_call_id"])}`,
        "call-deadline",
        String(row["transport_call_id"]),
        Number(row["deadline_at"]),
      );
    }
    for (const row of this.sql
      .exec(
        `SELECT fork_id, updated_at
           FROM fork_ops
          WHERE phase NOT IN ('done', 'rolledback')
            AND updated_at + ? <= ?`,
        FORK_OP_RECONCILE_MS,
        now,
      )
      .toArray()) {
      insert(
        `maintenance:fork-reconcile:${String(row["fork_id"])}`,
        "fork-reconcile",
        String(row["fork_id"]),
        Number(row["updated_at"]),
      );
    }
    for (const row of this.sql
      .exec(
        `SELECT head_seq, updated_at FROM lineage_head_outbox WHERE next_attempt_at <= ?`,
        now,
      )
      .toArray()) {
      insert(
        `maintenance:lineage-head:${this.objectKey}`,
        "lineage-head",
        this.objectKey,
        Number(row["updated_at"]),
      );
    }
  }

  private hasReadyMaintenance(now: number): boolean {
    const queued =
      this.sql
        .exec(
          `SELECT 1
             FROM channel_maintenance_queue
            WHERE disposition IN ('ready', 'retrying') AND next_attempt_at <= ?
            LIMIT 1`,
          now,
        )
        .toArray().length > 0;
    if (queued) return true;
    const inviteDue =
      this.sql
        .exec(
          `SELECT 1 FROM invite_index_ops
            WHERE updated_at + ? <= ?
              AND NOT EXISTS (
                SELECT 1 FROM channel_maintenance_queue AS queued
                 WHERE queued.item_id = 'maintenance:invite-index:' || invite_index_ops.op_id
              )
            LIMIT 1`,
          INVITE_INDEX_RETRY_MS,
          now,
        )
        .toArray().length > 0;
    if (inviteDue) return true;
    const callDue =
      this.sql
        .exec(
          `SELECT 1 FROM pending_calls
            WHERE deadline_at IS NOT NULL AND deadline_at <= ?
              AND NOT EXISTS (
                SELECT 1 FROM channel_maintenance_queue AS queued
                 WHERE queued.item_id =
                   'maintenance:call-deadline:' || pending_calls.transport_call_id
              )
            LIMIT 1`,
          now,
        )
        .toArray().length > 0;
    if (callDue) return true;
    const lineageDue =
      this.sql
        .exec(
          `SELECT 1 FROM lineage_head_outbox
            WHERE next_attempt_at <= ?
              AND NOT EXISTS (
                SELECT 1 FROM channel_maintenance_queue
                 WHERE item_id = ?
              )
            LIMIT 1`,
          now,
          `maintenance:lineage-head:${this.objectKey}`,
        )
        .toArray().length > 0;
    if (lineageDue) return true;
    return (
      this.sql
        .exec(
          `SELECT 1 FROM fork_ops
            WHERE phase NOT IN ('done', 'rolledback')
              AND updated_at + ? <= ?
              AND NOT EXISTS (
                SELECT 1 FROM channel_maintenance_queue AS queued
                 WHERE queued.item_id =
                   'maintenance:fork-reconcile:' || fork_ops.fork_id
              )
            LIMIT 1`,
          FORK_OP_RECONCILE_MS,
          now,
        )
        .toArray().length > 0
    );
  }

  private nextMaintenanceRecoveryAt(): number | null {
    const value = this.sql
      .exec(
        `SELECT MIN(next_attempt_at) AS due
           FROM channel_maintenance_queue
          WHERE disposition = 'retrying'`,
      )
      .toArray()[0]?.["due"];
    return typeof value === "number" ? value : null;
  }

  /** Adopt this concrete channel's durable queues for one server generation. */
  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async adoptDurableWorkWorker(
    workerId: string,
  ): Promise<{ adopted: boolean; previousWorkerId: string | null }> {
    const adoption = this.adoptDurableWorkWorkerGeneration(workerId);
    await this.deriveDeliveries();
    return adoption;
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async executeChannelMaintenanceClaim(input: {
    itemId: string;
    generation: number;
  }): Promise<{ processed: true }> {
    const row = this.sql
      .exec(
        `SELECT kind, target_id
           FROM channel_maintenance_queue
          WHERE item_id = ?
            AND lease_generation = ?
            AND disposition = 'leased'`,
        input.itemId,
        input.generation,
      )
      .toArray()[0];
    if (!row) throw new Error("executeChannelMaintenanceClaim: stale claim");
    const kind = String(row["kind"]) as ChannelMaintenanceKind;
    const targetId = String(row["target_id"]);
    if (kind === "invite-index") {
      if (!(await this.flushInviteIndexOp(targetId))) {
        throw new Error(`invite-index maintenance failed for ${targetId}`);
      }
    } else if (kind === "call-deadline") {
      await this.timeoutMethodCall(targetId, "Channel method deadline expired");
    } else if (kind === "fork-reconcile") {
      const op = this.getForkOpRow(targetId);
      if (op?.["phase"] === "rollback-pending")
        await this.rollbackForkOp(targetId);
      else if (op && op["phase"] !== "done" && op["phase"] !== "rolledback") {
        await this.runForkOp(targetId);
      }
    } else if (kind === "lineage-head") {
      await this.flushLineageHeadOutbox();
    } else {
      throw new Error(`executeChannelMaintenanceClaim: unknown kind ${kind}`);
    }
    return { processed: true };
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  claimReadyWork(queue: DurableWorkQueue, input: ClaimRequest): WorkClaim[] {
    if (queue !== "channel-delivery") return [];
    if (!input.workerId || input.limit < 1) {
      throw new Error("claimReadyWork: invalid claim request");
    }
    this.adoptDurableWorkWorkerGeneration(input.workerId);
    const claims = this.ctx.storage.transactionSync(() => {
      this.materializeDueMaintenance(input.now);
      const claims: WorkClaim[] = [];
      const maintenance = this.sql
        .exec(
          `SELECT *
             FROM channel_maintenance_queue
            WHERE disposition IN ('ready', 'retrying') AND next_attempt_at <= ?
            ORDER BY created_at, item_id
            LIMIT ?`,
          input.now,
          Math.min(input.limit, 1),
        )
        .toArray();
      for (const row of maintenance) {
        const itemId = String(row["item_id"]);
        const generation = Number(row["lease_generation"] ?? 0) + 1;
        this.sql.exec(
          `UPDATE channel_maintenance_queue
              SET disposition = 'leased',
                  lease_owner = ?,
                  lease_generation = ?,
                  last_attempt_at = ?
            WHERE item_id = ?`,
          input.workerId,
          generation,
          input.now,
          itemId,
        );
        claims.push({
          itemId,
          generation,
          idempotencyKey: String(row["idempotency_key"]),
          createdAt: Number(row["created_at"]),
          attempt: Number(row["attempts"] ?? 0) + 1,
          payload: {
            workKind: "channel-maintenance",
            // Channel control-plane operations can call out and re-enter local
            // state. Serialize them with each other while preserving
            // independent per-participant delivery lanes.
            laneKey: `channel-maintenance\u0000${this.objectKey}`,
            kind: String(row["kind"]),
            targetId: String(row["target_id"]),
          },
        });
      }
      const remaining = input.limit - claims.length;
      if (remaining < 1) return claims;
      const candidates = this.sql
        .exec(
          `SELECT current.*, relationship.revision AS active_relationship_revision,
                  relationship.invocation_route AS active_invocation_route,
                  event_context.agentic_context_json AS event_agentic_context_json
             FROM channel_delivery_mailbox AS current
             JOIN channel_relationships AS relationship
               ON relationship.participant_id = current.participant_id
             LEFT JOIN channel_delivery_event_context AS event_context
               ON event_context.event_id = current.event_id
            WHERE current.state IN ('ready', 'retrying')
              AND current.next_attempt_at <= ?
              AND relationship.active = 1
              AND relationship.attached = 1
              AND NOT EXISTS (
                -- Strict head-of-line: any earlier non-terminal row blocks,
                -- eligible or not. This guarantees at most one claim per
                -- participant lane per pass (the host driver rejects two
                -- simultaneous claims for one lane) and makes same-recipient
                -- sequence ordering structural rather than an emergent
                -- property of lane conflicts.
                SELECT 1
                  FROM channel_delivery_mailbox AS blocker
                 WHERE blocker.participant_id = current.participant_id
                   AND blocker.event_sequence < current.event_sequence
                   AND blocker.state NOT LIKE 'terminal-%'
              )
            ORDER BY current.created_at, current.participant_id, current.event_sequence
            LIMIT ?`,
          input.now,
          Math.min(remaining, 1_000),
        )
        .toArray();
      for (const row of candidates) {
        if (claims.length >= input.limit) break;
        const deliveryId = String(row["delivery_id"]);
        const participantId = String(row["participant_id"]);
        const target = parseDOParticipantId(String(row["endpoint_entity_id"]));
        const directContextMissing =
          row["active_invocation_route"] === "direct" &&
          typeof row["event_agentic_context_json"] !== "string";
        if (!target || directContextMissing) {
          this.sql.exec(
            `UPDATE channel_delivery_mailbox
                SET state = 'terminal-integrity', claimed_by = NULL
              WHERE delivery_id = ?`,
            deliveryId,
          );
          continue;
        }
        const generation = Number(row["claim_generation"] ?? 0) + 1;
        const relationshipRevision = Number(
          row["active_relationship_revision"],
        );
        this.sql.exec(
          `UPDATE channel_delivery_mailbox
              SET state = 'leased', claimed_by = ?, claim_generation = ?, last_attempt_at = ?,
                  claimed_relationship_revision = ?
            WHERE delivery_id = ?`,
          input.workerId,
          generation,
          input.now,
          relationshipRevision,
          deliveryId,
        );
        const delivery: ChannelDeliveryInput = {
          deliveryId,
          channelId: this.objectKey,
          channelRef: {
            source: String(this.env["WORKER_SOURCE"]),
            className: String(this.env["WORKER_CLASS_NAME"]),
            objectKey: this.objectKey,
          },
          participantId,
          subscriptionRevision: Number(row["subscription_revision"]),
          eventSequence: Number(row["event_sequence"]),
          envelope: JSON.parse(
            String(row["envelope_json"]),
          ) as RpcChannelMessage,
          agenticContext:
            row["active_invocation_route"] === "direct"
              ? (JSON.parse(
                  String(row["event_agentic_context_json"]),
                ) as ChannelAgenticContext)
              : null,
        };
        claims.push({
          itemId: deliveryId,
          generation,
          idempotencyKey: `channel-delivery:${deliveryId}`,
          createdAt: Number(row["created_at"]),
          attempt: Number(row["attempts"] ?? 0) + 1,
          payload: {
            laneKey: participantId,
            target,
            delivery,
          },
        });
      }
      return claims;
    });
    if (!this.durableWorkStatus().readyQueues.includes("channel-delivery")) {
      this.acknowledgeDurableWorkReady("channel-delivery");
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
    request: SettleRequest<
      | ChannelDeliveryOutcome
      | { processed: true; recipientExecutionStartedAt?: number }
    >,
  ): ClaimSettlement {
    if (queue !== "channel-delivery") return "stale";
    if (request.itemId.startsWith("maintenance:")) {
      return this.ctx.storage.transactionSync(() => {
        const row = this.sql
          .exec(
            `SELECT lease_owner, lease_generation, disposition
               FROM channel_maintenance_queue
              WHERE item_id = ?`,
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
        this.sql.exec(
          `DELETE FROM channel_maintenance_queue WHERE item_id = ?`,
          request.itemId,
        );
        return "accepted";
      });
    }
    const acknowledged = request.outcome as
      | ChannelDeliveryOutcome
      | { processed: true; recipientExecutionStartedAt?: number }
      | null;
    const outcome: ChannelDeliveryOutcome =
      acknowledged !== null &&
      typeof acknowledged === "object" &&
      "processed" in acknowledged &&
      acknowledged.processed === true
        ? {
            deliveryId: request.itemId,
            disposition: "processed",
            ...(typeof acknowledged.recipientExecutionStartedAt === "number"
              ? {
                  recipientExecutionStartedAt:
                    acknowledged.recipientExecutionStartedAt,
                }
              : {}),
          }
        : (acknowledged as ChannelDeliveryOutcome);
    if (
      !outcome ||
      outcome.deliveryId !== request.itemId ||
      !["processed", "duplicate", "declined", "retired"].includes(
        outcome.disposition,
      )
    ) {
      throw new Error("settleReadyWork: invalid channel delivery outcome");
    }
    return this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec(
          `SELECT claimed_by, claim_generation, state, created_at, envelope_json
             FROM channel_delivery_mailbox
            WHERE delivery_id = ?`,
          request.itemId,
        )
        .toArray()[0];
      if (!row) return "duplicate";
      if (
        row["claimed_by"] !== request.workerId ||
        Number(row["claim_generation"]) !== request.generation ||
        row["state"] !== "leased"
      ) {
        return String(row["state"]).startsWith("terminal-")
          ? "duplicate"
          : "stale";
      }
      if (outcome.disposition === "declined") {
        this.deliveryProjection.recordDeclined(request.itemId);
      }
      if (typeof outcome.recipientExecutionStartedAt === "number") {
        this.recordDeliveryLatency(
          "publish-to-recipient-execution",
          Math.max(
            0,
            outcome.recipientExecutionStartedAt - Number(row["created_at"]),
          ),
        );
      }
      if (typeof row["envelope_json"] === "string") {
        try {
          const envelope = JSON.parse(String(row["envelope_json"])) as {
            event?: { payload?: { kind?: unknown } };
          };
          const kind = envelope.event?.payload?.kind;
          if (
            kind === "invocation.completed" ||
            kind === "invocation.failed" ||
            kind === "invocation.cancelled" ||
            kind === "invocation.abandoned"
          ) {
            this.recordDeliveryLatency(
              "result-to-caller-settlement",
              Math.max(0, Date.now() - Number(row["created_at"])),
            );
          }
        } catch {
          // Malformed envelopes are classified by the delivery consumer. The
          // latency observer never becomes an alternate validation path.
        }
      }
      this.sql.exec(
        `UPDATE channel_delivery_mailbox
            SET state = ?, claimed_by = NULL,
                envelope_json = NULL, agentic_context_json = NULL,
                terminal_outcome_json = ?
          WHERE delivery_id = ?
            AND claimed_by = ?
            AND claim_generation = ?`,
        outcome.disposition === "retired"
          ? "terminal-retired"
          : "terminal-completed",
        JSON.stringify(outcome),
        request.itemId,
        request.workerId,
        request.generation,
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
  async failReadyWork(
    queue: DurableWorkQueue,
    request: {
      workerId: string;
      itemId: string;
      generation: number;
      error?: unknown;
    },
  ): Promise<{ retryAt: number } | "stale"> {
    if (queue !== "channel-delivery") return "stale";
    if (request.itemId.startsWith("maintenance:")) {
      return this.ctx.storage.transactionSync(() => {
        const row = this.sql
          .exec(
            `SELECT attempts
               FROM channel_maintenance_queue
              WHERE item_id = ?
                AND lease_owner = ?
                AND lease_generation = ?
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
            STRUCTURED_DELIVERY_RETRY_MS * 2 ** Math.min(attempts - 1, 5),
            STRUCTURED_DELIVERY_MAX_RETRY_MS,
          );
        this.sql.exec(
          `UPDATE channel_maintenance_queue
              SET attempts = ?,
                  disposition = 'retrying',
                  next_attempt_at = ?,
                  lease_owner = NULL
            WHERE item_id = ?
              AND lease_owner = ?
              AND lease_generation = ?`,
          attempts,
          retryAt,
          request.itemId,
          request.workerId,
          request.generation,
        );
        return { retryAt };
      });
    }
    const errorCode =
      request.error && typeof request.error === "object"
        ? (request.error as { code?: unknown }).code
        : undefined;
    if (errorCode === "PermanentChannelDelivery") {
      return this.ctx.storage.transactionSync(() => {
        const updated = this.sql.exec(
          `UPDATE channel_delivery_mailbox
              SET state = 'terminal-integrity', claimed_by = NULL,
                  terminal_outcome_json = ?
            WHERE delivery_id = ? AND claimed_by = ? AND claim_generation = ? AND state = 'leased'
            RETURNING delivery_id`,
          JSON.stringify({
            disposition: "integrity-error",
            error: request.error,
          }),
          request.itemId,
          request.workerId,
          request.generation,
        );
        return updated.toArray().length > 0 ? { retryAt: Date.now() } : "stale";
      });
    }
    if (errorCode === "ResidentSessionUnavailable") {
      const claimed = this.sql
        .exec(
          `SELECT participant_id
             FROM channel_delivery_mailbox
            WHERE delivery_id = ? AND claimed_by = ? AND claim_generation = ? AND state = 'leased'`,
          request.itemId,
          request.workerId,
          request.generation,
        )
        .toArray()[0];
      if (!claimed) return "stale";
      const participantId = String(claimed["participant_id"]);
      return this.withRelationshipMutation(participantId, async () => {
        const current = this.sql
          .exec(
            `SELECT mailbox.event_sequence, mailbox.claimed_relationship_revision,
                    relationship.revision AS active_relationship_revision
               FROM channel_delivery_mailbox AS mailbox
               LEFT JOIN channel_relationships AS relationship
                 ON relationship.participant_id = mailbox.participant_id
              WHERE mailbox.delivery_id = ? AND mailbox.claimed_by = ?
                AND mailbox.claim_generation = ? AND mailbox.state = 'leased'`,
            request.itemId,
            request.workerId,
            request.generation,
          )
          .toArray()[0];
        if (!current) return "stale" as const;
        if (
          Number(current["claimed_relationship_revision"]) !==
          Number(current["active_relationship_revision"])
        ) {
          const now = Date.now();
          this.sql.exec(
            `UPDATE channel_delivery_mailbox
                SET state = 'ready', claimed_by = NULL, next_attempt_at = ?,
                    claimed_relationship_revision = NULL
              WHERE delivery_id = ? AND claimed_by = ? AND claim_generation = ? AND state = 'leased'`,
            now,
            request.itemId,
            request.workerId,
            request.generation,
          );
          this.markWorkReady("channel-delivery");
          return { retryAt: now };
        }
        await this.detachParticipantUnlocked(
          participantId,
          Math.max(0, Number(current["event_sequence"]) - 1),
        );
        return { retryAt: Date.now() };
      });
    }
    return this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec(
          `SELECT attempts
             FROM channel_delivery_mailbox
            WHERE delivery_id = ?
              AND claimed_by = ?
              AND claim_generation = ?
              AND state = 'leased'`,
          request.itemId,
          request.workerId,
          request.generation,
        )
        .toArray()[0];
      if (!row) return "stale";
      const attempts = Number(row["attempts"] ?? 0) + 1;
      const delay = Math.min(
        STRUCTURED_DELIVERY_RETRY_MS * 2 ** Math.min(attempts - 1, 5),
        STRUCTURED_DELIVERY_MAX_RETRY_MS,
      );
      const retryAt = Date.now() + delay;
      this.sql.exec(
        `UPDATE channel_delivery_mailbox
            SET attempts = ?,
                state = 'retrying',
                next_attempt_at = ?,
                claimed_by = NULL
          WHERE delivery_id = ?
            AND claimed_by = ?
            AND claim_generation = ?`,
        attempts,
        retryAt,
        request.itemId,
        request.workerId,
        request.generation,
      );
      return { retryAt };
    });
  }

  private async detachParticipant(
    participantId: string,
    detachAfterSequence?: number,
  ): Promise<void> {
    return this.withRelationshipMutation(participantId, () =>
      this.detachParticipantUnlocked(participantId, detachAfterSequence),
    );
  }

  private async detachParticipantUnlocked(
    participantId: string,
    detachAfterSequence?: number,
  ): Promise<void> {
    await this.deriveDeliveries();
    const relationship = this.deliveryProjection.relationship(participantId);
    if (!relationship?.active || !relationship.attached) return;
    const metadata = this.getSenderMetadata(participantId) ?? {};
    const recoveryBoundary = this.deliveryProjection.detachRecoveryBoundary(
      participantId,
      detachAfterSequence ?? this.deliveryProjection.cursor(),
    );
    await this.appendDurable({
      type: "channel.subscription.detached",
      payload: {
        participantId,
        revision: relationship.revision + 1,
        detachAfterSequence: recoveryBoundary,
      },
      senderId: participantId,
      senderMetadata: metadata,
      messageId: `channel-subscription:${participantId}:${relationship.revision + 1}`,
      idempotency: "idempotent-by-id",
    });
    this.invalidateBroadcastParticipants();
    this.broadcastPresenceSignal(
      participantId,
      "leave",
      metadata,
      "disconnect",
    );
  }

  private async withRelationshipMutation<T>(
    participantId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.relationshipMutations.get(participantId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.relationshipMutations.set(participantId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.relationshipMutations.get(participantId) === tail) {
        this.relationshipMutations.delete(participantId);
      }
    }
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
    const deliveryReady =
      this.sql
        .exec(
          `SELECT 1
             FROM channel_delivery_mailbox AS current
             JOIN channel_relationships AS relationship
               ON relationship.participant_id = current.participant_id
            WHERE current.state IN ('ready', 'retrying')
              AND current.next_attempt_at <= ?
              AND relationship.active = 1
              AND relationship.attached = 1
              AND NOT EXISTS (
                SELECT 1
                  FROM channel_delivery_mailbox AS blocker
                 WHERE blocker.participant_id = current.participant_id
                   AND blocker.event_sequence < current.event_sequence
                   AND blocker.state NOT LIKE 'terminal-%'
              )
            LIMIT 1`,
          now,
        )
        .toArray().length > 0;
    const ready = deliveryReady || this.hasReadyMaintenance(now);
    const recoveryTimes = [
      this.nextStructuredDeliveryRecoveryAt(),
      this.nextMaintenanceRecoveryAt(),
      this.nextDurableWorkReadyEdgeAt(),
    ].filter((value): value is number => typeof value === "number");
    return {
      readyQueues: ready ? ["channel-delivery"] : [],
      nextRecoveryAt:
        recoveryTimes.length > 0 ? Math.min(...recoveryTimes) : null,
    };
  }

  private get channelLog(): ChannelLog {
    this._channelLog ??= new ChannelLog(
      {
        call: <T = unknown>(
          targetId: string,
          method: string,
          args: unknown[],
        ) => this.rpc.call<T>(targetId, method, args),
      },
      this.objectKey,
    );
    return this._channelLog;
  }

  private get deliveryProjection(): ChannelDeliveryProjection {
    this._deliveryProjection ??= new ChannelDeliveryProjection(
      this.sql,
      (callback) => this.ctx.storage.transactionSync(callback),
      this.objectKey,
      () => {
        const value = this.getStateValue("forkPointId");
        if (value === null) return null;
        const boundary = Number(value);
        return Number.isSafeInteger(boundary) && boundary >= 0
          ? boundary
          : null;
      },
    );
    return this._deliveryProjection;
  }

  /** Advance the delivery projection. On the happy path the just-appended
   *  event is folded directly from memory — `channelLog.append` returns the
   *  same hydrated construction `readEvents` would replay, so no GAD
   *  round trip is spent re-reading an event this activation already holds.
   *  Any gap (a prior crash left the cursor behind) falls back to bounded
   *  replay from the committed cursor. */
  private async deriveDeliveries(
    appended?: ChannelEvent,
    deliveryStartedAt?: number,
  ): Promise<number> {
    // A later relationship fold can legitimately replace the relationship
    // row that owns recovery. Drain that durable debt before the projection
    // cursor is allowed to advance to any newer canonical event.
    let inserted = await this.resumeReattachBackfills();
    if (appended) {
      const cursor = this.deliveryProjection.cursor();
      if (appended.id <= cursor) {
        if (inserted > 0) this.markWorkReady("channel-delivery");
        return inserted;
      }
      if (appended.id === cursor + 1) {
        inserted += this.deliveryProjection.fold(
          appended,
          deliveryStartedAt,
        ).inserted;
        inserted += await this.resumeReattachBackfills();
        if (inserted > 0) this.markWorkReady("channel-delivery");
        return inserted;
      }
      // Cursor is behind by more than this event: recover through replay,
      // which folds the appended event in sequence with everything missing.
    }
    for (;;) {
      const events = await this.channelLog.readEvents({
        afterSeq: this.deliveryProjection.cursor(),
        limit: 500,
      });
      if (events.length === 0) break;
      for (const event of events) {
        inserted += this.deliveryProjection.fold(event).inserted;
        inserted += await this.resumeReattachBackfills();
      }
      if (events.length < 500) break;
    }
    if (inserted > 0) this.markWorkReady("channel-delivery");
    return inserted;
  }

  /** Resume every durable detached-range recovery. Progress is stored in the
   * relationship row atomically with each derived mailbox item, so activation
   * loss at any await boundary simply resumes from the last committed event. */
  private async resumeReattachBackfills(): Promise<number> {
    let inserted = 0;
    for (const recovery of this.deliveryProjection.pendingReattachBackfills()) {
      if (recovery.afterSequence >= recovery.throughSequence) {
        this.deliveryProjection.completeEmptyReattachBackfill(
          recovery.participantId,
        );
        continue;
      }
      let afterSeq = recovery.afterSequence;
      while (afterSeq < recovery.throughSequence) {
        const events = await this.channelLog.readEvents({
          afterSeq,
          limit: 500,
        });
        const gap = events.filter(
          (event) => event.id <= recovery.throughSequence,
        );
        if (gap.length === 0) {
          throw new Error(
            `Reattach backfill for ${recovery.participantId} cannot reach ` +
              `${recovery.throughSequence} after ${afterSeq}`,
          );
        }
        for (const event of gap) {
          inserted += this.deliveryProjection.advanceReattachBackfill(
            event,
            recovery.participantId,
          );
          afterSeq = event.id;
        }
      }
    }
    return inserted;
  }

  private get inviteIndex(): DurableObjectServiceClient {
    this._inviteIndex ??= createDurableObjectServiceClient(
      {
        call: <T = unknown>(
          targetId: string,
          method: string,
          args: unknown[],
        ) => this.rpc.call<T>(targetId, method, args),
      },
      GAD_WORKSPACE_SERVICE_PROTOCOL,
    );
    return this._inviteIndex;
  }

  private get policyHost(): PolicyHost {
    this._policyHost ??= new PolicyHost({
      getStateValue: (key) => this.getStateValue(key),
      setStateValue: (key, value) => this.setStateValue(key, value),
      deleteStateValue: (key) => this.deleteStateValue(key),
      log: this.channelLog,
      policyNames: () => this.getChannelConfig()?.policies,
    });
    return this._policyHost;
  }

  private get calls(): CallTransport {
    this._calls ??= new CallTransport({
      sql: this.sql,
      objectKey: this.objectKey,
      log: this.channelLog,
      builders: () => this.policyHost.callBuilders(),
      appendDurable: (input) => this.appendDurable(input),
      broadcastLive: (event, senderId, ref, structuredPublisherId) =>
        broadcast(
          this.broadcastDeps,
          event,
          { kind: "log", phase: "live", ref },
          senderId,
          structuredPublisherId,
        ),
      emitSignal: (participantId, event) => {
        void this.deliverParticipantPayload(participantId, {
          channelId: this.objectKey,
          message: channelEventToRpcSignal(event),
        });
      },
      redeliverDurableEvent: async (participantId, eventId) => {
        const event = await this.channelLog.getEventByEnvelopeId(eventId);
        if (!event) return false;
        const changed = this.deliveryProjection.redeliverEventTo(
          event,
          participantId,
        );
        if (changed) this.markWorkReady("channel-delivery");
        return changed;
      },
      participantRef: (participantId) => this.participantRef(participantId),
      getSenderMetadata: (participantId) =>
        this.getSenderMetadata(participantId),
      participantTransport: (participantId) => {
        const session = this.sql
          .exec(
            `SELECT transport FROM participants WHERE id = ?`,
            participantId,
          )
          .toArray()[0];
        if (session) return "external-session";
        const relationship =
          this.deliveryProjection.relationship(participantId);
        if (!relationship?.active) return null;
        if (relationship.endpointKind !== "entity") return "resident-session";
        return relationship.invocationRoute === "direct"
          ? "entity"
          : "resident-session";
      },
      rpcCall: (targetId, method, args) =>
        this.rpc.call(targetId, method, args),
      waitUntil: (promise) => {
        if (this.ctx.waitUntil) this.ctx.waitUntil(promise);
        else void promise;
      },
      getStateValue: (key) => this.getStateValue(key),
      setStateValue: (key, value) => this.setStateValue(key, value),
      recordLatency: (metric, durationMs) =>
        this.recordDeliveryLatency(metric, durationMs),
    });
    return this._calls;
  }

  private recordDeliveryLatency(
    metric:
      | "publish-to-recipient-execution"
      | "call-to-provider-execution"
      | "result-to-caller-settlement",
    durationMs: number,
  ): void {
    const bounded = Math.max(0, Math.round(durationMs));
    const upperBound =
      [10, 50, 100, 250, 500, 1_000, 5_000, 30_000].find(
        (value) => bounded <= value,
      ) ?? 2_147_483_647;
    this.sql.exec(
      `INSERT INTO channel_delivery_latency_histogram (
         metric, upper_bound_ms, samples, total_ms, maximum_ms
       ) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(metric, upper_bound_ms) DO UPDATE SET
         samples = samples + 1,
         total_ms = total_ms + excluded.total_ms,
         maximum_ms = MAX(maximum_ms, excluded.maximum_ms)`,
      metric,
      upperBound,
      bounded,
      bounded,
    );
  }

  /** Look up metadata from either live session presence or durable membership. */
  /**
   * A guest envelope — a publish by a participant who never joined this channel
   * (messaging plan §4.6) — is not a loophole around locked membership. It runs
   * the same admission check a join would, and fails closed.
   *
   * The error names the CHANNEL as closed rather than the addressee as unknown:
   * an agent that cannot tell those two apart retries an unknown addressee
   * forever, and correctly gives up on a closed channel.
   */
  private assertGuestAdmission(participantId: string): void {
    const policy = this.lockedMembershipPolicy();
    if (!policy || policy.participants.includes(participantId)) return;
    throw Object.assign(
      new Error(
        `This channel has locked membership and does not admit ${participantId}. ` +
          `Its participants are fixed at initialization; there is no way in.`,
      ),
      { code: "ClosedChannel" },
    );
  }

  private getSenderMetadata(
    participantId: string,
  ): Record<string, unknown> | undefined {
    const session = this.sql
      .exec(`SELECT metadata FROM participants WHERE id = ?`, participantId)
      .toArray()[0];
    const relationship = session
      ? null
      : this.sql
          .exec(
            `SELECT metadata_json FROM channel_relationships WHERE participant_id = ?`,
            participantId,
          )
          .toArray()[0];
    const raw = session?.["metadata"] ?? relationship?.["metadata_json"];
    if (typeof raw !== "string") return undefined;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  private participantRef(participantId: string): ParticipantRef {
    return participantRefFromMetadata(
      participantId,
      this.getSenderMetadata(participantId),
    );
  }

  // ── The ONE append pipeline (WS2 §4.3) ───────────────────────────────────
  //
  //  1. policy state catch-up + pure annotate
  //  2. durable append (GAD validates + sanitizes + projects in the txn)
  //  3. fold the appended envelope into the policy caches
  //
  // A crash between 2 and 3 leaves the cache behind head; the next
  // getState() heals it (cache amnesia by construction).

  private async appendDurable(input: {
    type: string;
    payload: unknown;
    senderId: string;
    senderMetadata?: Record<string, unknown>;
    messageId?: string;
    /** "idempotent-by-id" is reserved for the client publish path. */
    idempotency?: AppendIdempotency;
    attachments?: StoredAttachment[];
    /** Measurement origin only; never consulted as delivery authority. */
    deliveryStartedAt?: number;
  }): Promise<ChannelEvent> {
    const deliveryStartedAt = input.deliveryStartedAt ?? Date.now();
    if (
      input.type === AGENTIC_EVENT_PAYLOAD_KIND &&
      input.payload &&
      typeof input.payload === "object"
    ) {
      assertDeclaredAgenticEventAudience(input.payload as AgenticEvent);
      const audience = (input.payload as { payload?: { to?: unknown } }).payload
        ?.to;
      if (
        Array.isArray(audience) &&
        audience.some(
          (selector) =>
            selector !== null &&
            typeof selector === "object" &&
            (selector as { kind?: unknown }).kind === "role",
        )
      ) {
        throw new Error(
          "Participant role selectors are not resolvable on channel append",
        );
      }
    }
    const contentIntegrity = this.senderContentIntegrity();
    const payloadRecord =
      input.payload &&
      typeof input.payload === "object" &&
      !Array.isArray(input.payload)
        ? (input.payload as Record<string, unknown>)
        : null;
    const senderKind =
      ((payloadRecord?.["actor"] as { kind?: string } | undefined)?.kind as
        | string
        | undefined) ?? "unknown";
    const annotations = await this.policyHost.annotate({
      payloadKind: input.type,
      payload: input.payload,
      senderId: input.senderId,
      senderKind,
    });
    const event = await this.channelLog.append({
      type: input.type,
      payload: input.payload,
      senderId: input.senderId,
      senderMetadata: input.senderMetadata,
      messageId: input.messageId,
      ...(input.idempotency ? { idempotency: input.idempotency } : {}),
      ...(annotations ? { annotations } : {}),
      attachments: input.attachments,
      ...contentIntegrity,
    });
    this.policyHost.foldAppended(this.policyViewFromChannelEvent(event));
    await this.deriveDeliveries(event, deliveryStartedAt);
    // Report the head advance up the fork lineage (debounced) so live badges on
    // the root fan out. Cheap: records a pending seq + arms the alarm.
    const appendedKind =
      input.type === AGENTIC_EVENT_PAYLOAD_KIND
        ? (input.payload as { kind?: unknown } | null)?.kind
        : undefined;
    this.noteLineageHeadAdvance(
      event.id,
      appendedKind === "channel.forked" ||
        appendedKind === "channel.fork_renamed" ||
        appendedKind === "channel.fork_archived",
    );
    return event;
  }

  /** The message class is never accepted from publish arguments. The host
   * relay seals this fact onto the current direct invocation. Non-model
   * callers have no cognition latch and therefore author internal content. */
  private senderContentIntegrity(): {
    contentClass: "internal" | "external";
    externalKeys: string[];
  } {
    const fact = this.authorization?.contextIntegrity;
    if (fact?.class !== "external")
      return { contentClass: "internal", externalKeys: [] };
    return {
      contentClass: "external",
      externalKeys: [...new Set(fact.externalKeys)],
    };
  }

  private policyViewFromChannelEvent(event: ChannelEvent): PolicyEnvelopeView {
    const actorKind = ((event.payload as { actor?: { kind?: string } } | null)
      ?.actor?.kind ?? "unknown") as string;
    return {
      envelopeId: event.messageId,
      seq: event.id,
      payloadKind: event.type,
      payload: event.payload,
      senderId: event.senderId,
      senderKind: actorKind,
      ...(event.annotations ? { annotations: event.annotations } : {}),
      appendedAt: new Date(event.ts).toISOString(),
    };
  }

  private currentReplayContext(): ChannelReplayContext {
    return {
      contextId: this.getStateValue("contextId") ?? undefined,
      channelConfig: this.getChannelConfig() ?? undefined,
      snapshots: [this.rosterSnapshot(), this.receiptSnapshot()],
    };
  }

  private rosterSnapshot(): BootstrapSnapshot {
    const participants: ParticipantSnapshot[] = [];
    for (const row of this.sql
      .exec(`SELECT id, metadata FROM participants ORDER BY id ASC`)
      .toArray()) {
      try {
        const id = row["id"] as string;
        const metadata = JSON.parse(row["metadata"] as string) as Record<
          string,
          unknown
        >;
        participants.push({
          id,
          ref: participantRefFromMetadata(id, metadata),
          metadata,
        });
      } catch {
        /* ignore corrupt participant metadata */
      }
    }
    return { kind: "roster-snapshot", participants, ts: Date.now() };
  }

  private receiptSnapshot(): BootstrapSnapshot {
    const events: ServerLogEvent[] = this.deliveryProjection
      .receiptRows()
      .flatMap((receipt) => {
        if (receipt.state === "declined") return [];
        const ref = this.participantRef(receipt.participantId);
        return [
          {
            id: 0,
            messageId: `receipt:${receipt.messageId}:${receipt.participantId}:${receipt.state}`,
            type: AGENTIC_EVENT_PAYLOAD_KIND,
            senderId: receipt.participantId,
            senderMetadata: ref.metadata,
            contentClass: "internal",
            externalKeys: [],
            payload: {
              kind:
                receipt.state === "read" ? "message.read" : "message.received",
              actor: ref,
              causality: { messageId: receipt.messageId },
              payload: {
                protocol: AGENTIC_PROTOCOL_VERSION,
                ...(receipt.turnId ? { turnId: receipt.turnId } : {}),
              },
              createdAt: new Date(receipt.updatedAt).toISOString(),
            },
            ts: receipt.updatedAt,
          },
        ];
      });
    return { kind: "receipt-snapshot", events, ts: Date.now() };
  }

  // ── Channel initialization ──────────────────────────────────────────────

  private initChannel(
    contextId: string,
    channelConfig?: Record<string, unknown>,
  ): void {
    const existing = this.getStateValue("contextId");
    if (existing) {
      if (existing !== contextId) {
        throw new Error(
          `Context mismatch: channel bound to ${existing}, got ${contextId}`,
        );
      }
      return;
    }
    this.setStateValue("contextId", contextId);
    this.setStateValue("createdAt", String(Date.now()));
    if (channelConfig)
      this.setStateValue("config", JSON.stringify(channelConfig));
    this.deliveryProjection.initializeChannelConfig(channelConfig ?? {});
    void this.refreshOwnTitle();
  }

  /** Push this channel's display title to the server-side registry. */
  private async refreshOwnTitle(): Promise<void> {
    const config = this.getChannelConfig();
    const configured =
      config &&
      typeof config.title === "string" &&
      config.title.trim().length > 0
        ? config.title.trim()
        : null;
    if (config?.titleExplicit === true) {
      await this.setOwnTitleExplicitly(configured ?? null);
    } else {
      await this.setOwnTitle(configured ?? "Channel");
    }
  }

  private getChannelConfig(): ChannelConfig | null {
    const raw = this.getStateValue("config");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private normalizeLockedMembershipPolicy(
    value: unknown,
  ): LockedChannelMembershipPolicy {
    if (
      typeof value !== "object" ||
      value === null ||
      (value as { kind?: unknown }).kind !== "locked" ||
      !Array.isArray((value as { participants?: unknown }).participants)
    ) {
      throw new Error("Locked channel membership policy is invalid");
    }
    const participants = (value as { participants: unknown[] }).participants;
    if (
      participants.length === 0 ||
      participants.some(
        (participantId) =>
          typeof participantId !== "string" || participantId.length === 0,
      )
    ) {
      throw new Error(
        "Locked channel membership requires non-empty participant identities",
      );
    }
    const normalized = [...new Set(participants as string[])].sort();
    if (normalized.length !== participants.length) {
      throw new Error(
        "Locked channel membership contains duplicate participant identities",
      );
    }
    return { kind: "locked", participants: normalized };
  }

  private lockedMembershipPolicy(): LockedChannelMembershipPolicy | null {
    const policy = this.getChannelConfig()?.membershipPolicy;
    return policy === undefined
      ? null
      : this.normalizeLockedMembershipPolicy(policy);
  }

  private assertLockedMembership(participantId: string): void {
    const policy = this.lockedMembershipPolicy();
    if (policy && !policy.participants.includes(participantId)) {
      throw new Error(
        `Participant ${participantId} is not admitted by this locked channel`,
      );
    }
  }

  private assertParticipantCaller(participantId: string, method: string): void {
    if (!this.isAuthorizedParticipantCaller(participantId)) {
      const caller = this.caller;
      throw new Error(
        `${method}: participant ${participantId} cannot be used by caller ${caller?.callerId ?? "unknown"}`,
      );
    }
  }

  private isAuthorizedParticipantCaller(participantId: string): boolean {
    const caller = this.caller;
    if (!caller?.callerId) return false;
    if (caller.callerId === participantId) return true;
    if (caller.callerPanelId === participantId) return true;
    // Principal-derived human identity (WP6 §3-4): any panel/device owned by
    // the host-verified user acts as the shared `user:<userId>` participant.
    if (caller.userId && participantId === `user:${caller.userId}`) return true;
    return false;
  }

  private participantSubscriptionCount(participantId: string): number {
    let count = 0;
    for (const stream of this.subscriptionStreams.values()) {
      if (stream.participantId === participantId) count += 1;
    }
    return count;
  }

  private subscriptionStreamKey(
    participantId: string,
    subscriptionId: string,
  ): string {
    return `${participantId}\u0000${subscriptionId}`;
  }

  private async deliverParticipantPayload(
    participantId: string,
    payload: unknown,
  ): Promise<void> {
    const bytes = encodeChannelSubscriptionRecord({ kind: "message", payload });
    const terminated: Array<{ key: string; token: symbol }> = [];
    for (const [key, stream] of this.subscriptionStreams) {
      if (stream.participantId !== participantId) continue;
      try {
        if (
          enqueueChannelSubscriptionBytes(stream.controller, bytes) !==
          "enqueued"
        ) {
          terminated.push({ key, token: stream.token });
        }
      } catch {
        terminated.push({ key, token: stream.token });
      }
    }
    for (const stream of terminated) {
      await this.terminateSubscriptionStream(
        stream.key,
        stream.token,
        "response-buffer-full",
      );
    }
  }

  private async terminateSubscriptionStream(
    key: string,
    token: symbol,
    reason: string,
  ): Promise<void> {
    const stream = this.subscriptionStreams.get(key);
    if (!stream || stream.token !== token) return;
    this.subscriptionStreams.delete(key);
    try {
      stream.controller.error(
        new Error(`Channel subscription terminated: ${reason}`),
      );
    } catch {
      // Already terminal.
    }
    await this.unsubscribeParticipant(
      stream.participantId,
      "disconnect",
      stream.subscriptionId,
    );
  }

  private openSubscriptionResponse(
    participantId: string,
    deliveryId: string,
    subscriptionId: string,
    replaceParticipant: boolean,
    result: SubscribeResult,
  ): Response {
    const key = this.subscriptionStreamKey(participantId, subscriptionId);
    const token = Symbol(key);
    for (const [streamKey, previous] of [...this.subscriptionStreams]) {
      if (
        streamKey !== key &&
        (!replaceParticipant || previous.participantId !== participantId)
      ) {
        continue;
      }
      this.subscriptionStreams.delete(streamKey);
      try {
        previous.controller.close();
      } catch {
        // Already terminal.
      }
    }
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.subscriptionStreams.set(key, {
            participantId,
            deliveryId,
            subscriptionId,
            token,
            openedAt: Date.now(),
            controller,
          });
          const ack = encodeChannelSubscriptionRecord({
            kind: "subscribed",
            result,
          });
          if (enqueueChannelSubscriptionBytes(controller, ack) !== "enqueued") {
            void this.terminateSubscriptionStream(
              key,
              token,
              "subscription-ack-too-large",
            );
          }
        },
        cancel: async () => {
          const current = this.subscriptionStreams.get(key);
          if (!current || current.token !== token) return;
          this.subscriptionStreams.delete(key);
          await this.unsubscribeParticipant(
            participantId,
            "disconnect",
            subscriptionId,
          );
        },
      },
      channelSubscriptionQueuingStrategy(),
    );
    return new Response(body, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store",
      },
    });
  }

  private closeSubscriptionStream(
    participantId: string,
    subscriptionId: string,
  ): void {
    const key = this.subscriptionStreamKey(participantId, subscriptionId);
    const stream = this.subscriptionStreams.get(key);
    if (!stream) return;
    this.subscriptionStreams.delete(key);
    try {
      stream.controller.close();
    } catch {
      // Already terminal.
    }
  }

  // ── Presence events ─────────────────────────────────────────────────────

  private async publishPresenceEvent(
    senderId: string,
    action: "join" | "leave" | "update",
    metadata: Record<string, unknown>,
    leaveReason?: "graceful" | "disconnect" | "replaced",
    senderRef?: number,
  ): Promise<void> {
    // Presence is a disposable presentation signal. Durable relationship facts
    // and the roster/last-seen projections carry all semantic state; appending
    // presence would wake every executable member for UI-only connectivity.
    const publicMetadata = publicParticipantMetadata(metadata) ?? {};
    this.broadcastPresenceSignal(
      senderId,
      action,
      publicMetadata,
      leaveReason,
      senderRef,
    );
  }

  private broadcastPresenceSignal(
    senderId: string,
    action: "join" | "leave" | "update",
    metadata: Record<string, unknown>,
    leaveReason?: "graceful" | "disconnect" | "replaced",
    senderRef?: number,
  ): void {
    const payload: PresencePayload = {
      action,
      ref: participantRefFromMetadata(senderId, metadata),
      metadata,
      ...(leaveReason ? { leaveReason } : {}),
    };
    const event = buildChannelEvent(
      0,
      crypto.randomUUID(),
      "presence",
      JSON.stringify(payload),
      senderId,
      metadata,
      Date.now(),
    );
    broadcast(
      this.broadcastDeps,
      event,
      { kind: "signal", ref: senderRef },
      senderId,
    );
  }

  private broadcastChannelSignal(
    type: string,
    payload: Record<string, unknown>,
    senderId = "system",
  ): void {
    const event = buildChannelEvent(
      0,
      crypto.randomUUID(),
      type,
      JSON.stringify(payload),
      senderId,
      undefined,
      Date.now(),
    );
    broadcast(this.broadcastDeps, event, { kind: "signal" }, senderId);
  }

  private presenceStatusAt(
    lastActiveAt: number,
    now = Date.now(),
  ): Exclude<ChannelPresenceStatus, "offline"> {
    const age = Math.max(0, now - lastActiveAt);
    if (age < PRESENCE_IDLE_MS) return "online";
    if (age < PRESENCE_AWAY_MS) return "idle";
    return "away";
  }

  /** Record real user activity (message, typing, method interaction). */
  private markParticipantActive(participantId: string): void {
    if (!isUserParticipantId(participantId)) return;
    const now = Date.now();
    const row = this.sql
      .exec(
        `SELECT presence_status FROM participants WHERE id = ?`,
        participantId,
      )
      .toArray()[0];
    if (!row) return;
    const was = row["presence_status"] as string | null;
    this.sql.exec(
      `UPDATE participants SET last_active_at = ?, presence_status = 'online' WHERE id = ?`,
      now,
      participantId,
    );
    if (was !== "online") {
      this.broadcastPresenceSignal(participantId, "update", {
        kind: "user",
        presenceStatus: "online",
        lastActiveAt: now,
      });
    }
  }

  private recordOfflinePresence(participantId: string, lastSeen: number): void {
    this.sql.exec(
      `INSERT INTO presence_last_seen (participant_id, last_seen) VALUES (?, ?)
       ON CONFLICT(participant_id) DO UPDATE SET last_seen = excluded.last_seen`,
      participantId,
      lastSeen,
    );
  }

  /** Durable per-channel human presence, including offline members who have no
   * roster row. Status is server-derived from real activity and session count. */
  @rpc({
    principals: ["host", "user", "code"],
    effect: {
      kind: "userland-capability",
      capability: "channel.admin",
      resource: { kind: "receiver-object" },
    },
    tier: "gated",
    sensitivity: "admin",
  })
  async getChannelPresence(): Promise<{
    entries: ChannelPresenceEntry[];
    generatedAt: number;
  }> {
    const generatedAt = Date.now();
    const entries = new Map<string, ChannelPresenceEntry>();
    for (const row of this.sql
      .exec(
        `SELECT id, last_active_at, presence_status
           FROM participants
          WHERE id LIKE 'user:%'`,
      )
      .toArray()) {
      const participantId = row["id"] as string;
      const lastActiveAt =
        (row["last_active_at"] as number | null) ?? generatedAt;
      entries.set(participantId, {
        participantId,
        userId: bareUserId(participantId),
        status: this.presenceStatusAt(lastActiveAt, generatedAt),
        lastActiveAt,
        lastSeenAt: null,
        sessionCount: this.participantSubscriptionCount(participantId),
      });
    }
    for (const row of this.sql
      .exec(`SELECT participant_id, last_seen FROM presence_last_seen`)
      .toArray()) {
      const participantId = row["participant_id"] as string;
      if (entries.has(participantId)) continue;
      entries.set(participantId, {
        participantId,
        userId: bareUserId(participantId),
        status: "offline",
        lastActiveAt: null,
        lastSeenAt: row["last_seen"] as number,
        sessionCount: 0,
      });
    }
    for (const row of this.sql
      .exec(`SELECT user_id FROM channel_members`)
      .toArray()) {
      const participantId = row["user_id"] as string;
      if (entries.has(participantId)) continue;
      entries.set(participantId, {
        participantId,
        userId: bareUserId(participantId),
        status: "offline",
        lastActiveAt: null,
        lastSeenAt: null,
        sessionCount: 0,
      });
    }
    return {
      entries: [...entries.values()].sort((a, b) =>
        a.participantId.localeCompare(b.participantId),
      ),
      generatedAt,
    };
  }

  // ── RPC-callable methods ──────────────────────────────────────────────

  /**
   * Open or replay one durable participant relationship. This finite RPC is
   * the only membership operation used by executable entities.
   */
  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async join(input: ChannelJoinInput): Promise<SubscribeResult> {
    return this.withRelationshipMutation(input.participantId, () =>
      this.joinUnlocked(input),
    );
  }

  private async joinUnlocked(
    input: ChannelJoinInput,
  ): Promise<SubscribeResult> {
    const { participantId } = input;
    this.assertParticipantCaller(participantId, "join");
    this.assertLockedMembership(participantId);
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
      throw new Error("join: revision must be a positive integer");
    }
    const metadataResult = participantMetadataSchema.safeParse(input.metadata);
    if (!metadataResult.success) {
      const issue = metadataResult.error.issues[0];
      throw new Error(
        `join: invalid participant metadata at ${issue?.path.join(".") || "$"}: ${issue?.message ?? "invalid"}`,
      );
    }
    if (input.endpoint.kind !== "entity") {
      throw new Error(
        "join: executable participants require an entity delivery endpoint",
      );
    }
    if (input.endpoint.entityId !== participantId) {
      throw new Error(
        "join: delivery endpoint must be owned by the stable participant entity",
      );
    }
    const entity = parseDOParticipantId(input.endpoint.entityId);
    if (!entity)
      throw new Error("join: entity endpoint is not a Durable Object identity");
    const active = (await this.rpc.call(
      "main",
      "workspace-state.entity.resolveActive",
      [input.endpoint.entityId],
    )) as { id?: unknown; kind?: unknown } | null;
    if (
      !active ||
      active.id !== input.endpoint.entityId ||
      active.kind !== "do"
    ) {
      throw new Error(
        `join: Durable Object participant ${participantId} is not active`,
      );
    }
    if (input.contextId) this.initChannel(input.contextId);
    await this.deriveDeliveries();

    const existing = this.sql
      .exec(
        `SELECT revision, delivery, endpoint_kind, endpoint_entity_id, invocation_route, active,
                attached, detached_at_sequence,
                metadata_json, application_config_json
           FROM channel_relationships WHERE participant_id = ?`,
        participantId,
      )
      .toArray()[0];
    const payload: ChannelRelationshipPayload = {
      participantId,
      revision: input.revision,
      delivery: input.delivery,
      endpoint: input.endpoint,
      metadata: input.metadata,
      applicationConfig: input.applicationConfig,
    };
    if (
      existing &&
      Number(existing["active"]) === 1 &&
      Number(existing["attached"]) === 1 &&
      Number(existing["revision"]) === input.revision
    ) {
      const retained = canonicalJson({
        participantId,
        revision: Number(existing["revision"]),
        delivery: String(existing["delivery"]),
        endpoint: {
          kind: String(existing["endpoint_kind"]),
          entityId: String(existing["endpoint_entity_id"]),
          invocation: String(existing["invocation_route"]),
        },
        metadata: JSON.parse(String(existing["metadata_json"])),
        applicationConfig:
          existing["application_config_json"] === null
            ? null
            : JSON.parse(String(existing["application_config_json"])),
      });
      if (retained !== canonicalJson(payload)) {
        throw new Error(
          `join: revision ${input.revision} already names different relationship data`,
        );
      }
    } else {
      const expected = existing ? Number(existing["revision"]) + 1 : 1;
      if (input.revision !== expected) {
        throw new Error(
          `join: expected relationship revision ${expected}, received ${input.revision}`,
        );
      }
      await this.appendDurable({
        type:
          existing && Number(existing["active"]) === 1
            ? "channel.subscription.revised"
            : "channel.subscription.opened",
        payload,
        senderId: participantId,
        senderMetadata: input.metadata,
        messageId: `channel-subscription:${participantId}:${input.revision}`,
        idempotency: "idempotent-by-id",
      });
      this.invalidateBroadcastParticipants();
      this.broadcastPresenceSignal(
        participantId,
        existing && Number(existing["active"]) === 1 ? "update" : "join",
        input.metadata,
      );
    }

    const envelope = input.replay
      ? await this.channelLog.replayInitial(
          REPLAY_LIMIT,
          this.currentReplayContext(),
        )
      : undefined;
    const rearmed = this.deliveryProjection.rearmRetryingFor(participantId);
    await this.calls.redeliverPendingCallsTo(participantId);
    if (rearmed > 0) this.markWorkReady("channel-delivery");
    return {
      ok: true,
      participantId,
      revision: input.revision,
      channelConfig: this.getChannelConfig() ?? undefined,
      ...(envelope ? { envelope } : {}),
    };
  }

  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async leave(input: {
    participantId: string;
    revision: number;
  }): Promise<void> {
    this.assertParticipantCaller(input.participantId, "leave");
    await this.deriveDeliveries();
    const current = this.deliveryProjection.relationship(input.participantId);
    if (!current || !current.active) return;
    if (input.revision !== current.revision + 1) {
      throw new Error(
        `leave: expected relationship revision ${current.revision + 1}`,
      );
    }
    const metadata = this.getSenderMetadata(input.participantId) ?? {};
    await this.appendDurable({
      type: "channel.subscription.ended",
      payload: { participantId: input.participantId, revision: input.revision },
      senderId: input.participantId,
      senderMetadata: metadata,
      messageId: `channel-subscription:${input.participantId}:${input.revision}`,
      idempotency: "idempotent-by-id",
    });
    await this.calls.failPendingCallsTargeting(input.participantId, "graceful");
    this.broadcastPresenceSignal(
      input.participantId,
      "leave",
      metadata,
      "graceful",
    );
  }

  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async detach(input: { participantId: string }): Promise<void> {
    this.assertParticipantCaller(input.participantId, "detach");
    await this.detachParticipant(input.participantId);
  }

  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async relationshipState(
    participantId: string,
  ): Promise<{ revision: number; active: boolean }> {
    this.assertParticipantCaller(participantId, "relationshipState");
    await this.deriveDeliveries();
    const relationship = this.deliveryProjection.relationship(participantId);
    return relationship
      ? { revision: relationship.revision, active: relationship.active }
      : { revision: 0, active: false };
  }

  /**
   * Subscribe a participant to this channel. Inserts the participant first,
   * then builds replay, so an initial roster snapshot includes the subscriber.
   */
  @rpc({
    principals: ["user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async subscribe(
    participantId: string,
    metadata: Record<string, unknown>,
    subscriptionId?: string,
  ): Promise<Response> {
    const doRef = parseDOParticipantId(participantId);
    if (doRef) {
      throw new Error(
        "Durable Object participants must use finite join delivery",
      );
    }
    // ── Principal-derived human identity (WP6 §3-4) ──────────────────────
    // A human panel/shell joins as the STABLE account participant
    // `user:<userId>` (kind "user"), stamped from the host-verified caller
    // userId (WP4 §2.4) — any client-asserted id/handle for a human join is
    // IGNORED. This is data hygiene (one reliable identity per human, plan
    // §0.0), not an inter-user security wall. Mutable profile fields
    // (handle/displayName/color/avatar) are never frozen onto the roster
    // row; renderers resolve them live from the host-projected identity
    // read (WP0 §3.7). Agents/vessels keep supplying their own descriptor.
    const subscribeCaller = this.caller;
    // Which callers are a *person at a client*, as opposed to an agent vessel or
    // background code. Panels were the only ones named originally, which left
    // the desktop shell chrome — the app the command overlay runs in — unable to
    // join any channel at all: its participant id stayed the raw client id and
    // the authorization check below rejected it. A chrome app and a paired
    // device shell are as much a human's client as a panel is; what makes the
    // claim safe is the host-stamped `userId`, which no client can assert.
    const humanClient =
      subscribeCaller?.callerPanelId !== undefined ||
      subscribeCaller?.callerKind === "app" ||
      subscribeCaller?.callerKind === "shell" ||
      this.authorization?.authorizingOrigin.kind === "user";
    const verifiedUserId =
      subscribeCaller?.userId && humanClient ? subscribeCaller.userId : null;
    // Clean cut: every verified panel/shell is a human account. There is no
    // client marker, asserted kind, or pre-canonical participant-id convention.
    if (!doRef && verifiedUserId) {
      participantId = `user:${verifiedUserId}`;
    } else if (isUserParticipantId(participantId)) {
      throw new Error(
        `subscribe: participant id "${participantId}" is principal-derived; only a ` +
          `host-verified human caller (panel/shell carrying a userId) may claim it`,
      );
    }
    const isUserParticipant = isUserParticipantId(participantId);

    if (!this.isAuthorizedParticipantCaller(participantId)) {
      const caller = this.caller;
      throw new Error(
        `Participant ${participantId} cannot be subscribed by caller ${caller?.callerId ?? "unknown"}`,
      );
    }
    const deliveryId =
      subscribeCaller?.callerPanelId ?? subscribeCaller?.callerId;
    if (!deliveryId)
      throw new Error("subscribe: authenticated delivery identity is required");
    if (
      subscriptionId !== undefined &&
      (subscriptionId.length === 0 || subscriptionId.length > 128)
    ) {
      throw new Error("subscribe: invalid subscription identity");
    }
    const ownedSubscriptionId = subscriptionId ?? deliveryId;

    const parsedMetadata = participantMetadataSchema.safeParse(metadata);
    if (!parsedMetadata.success) {
      const issue = parsedMetadata.error.issues[0];
      throw new Error(
        `subscribe: invalid participant metadata at ${issue?.path.join(".") || "$"}: ${issue?.message ?? "invalid"}`,
      );
    }

    const contextId = metadata["contextId"] as string | undefined;
    const channelConfigRaw = metadata["channelConfig"] as
      | Record<string, unknown>
      | undefined;
    if (channelConfigRaw && "membershipPolicy" in channelConfigRaw) {
      throw new Error(
        "subscribe: locked channel membership can only be initialized by the host",
      );
    }
    this.assertLockedMembership(participantId);
    if (contextId) {
      this.initChannel(contextId, channelConfigRaw);
    }

    // Handle uniqueness: a friendly pre-check complements the partial unique
    // index that provides race-proof enforcement. Human
    // rows store NO handle (WP6 §3: the account handle renders live, is
    // unique server-wide, and never enters this per-channel column).
    const handle =
      !isUserParticipant && typeof metadata["handle"] === "string"
        ? (metadata["handle"] as string)
        : null;
    if (handle) {
      const conflict = this.sql
        .exec(
          `SELECT id FROM participants WHERE handle = ? AND id != ?`,
          handle,
          participantId,
        )
        .toArray();
      if (conflict.length > 0) {
        const otherId = conflict[0]!["id"] as string;
        throw new Error(
          `Participant handle "${handle}" is already in use by another participant ` +
            `(${otherId}) in this channel. Handles must be unique.`,
        );
      }
    }

    if (doRef) {
      // Subscription does not discover or activate a class. The participant
      // authenticated above is an exact runtime identity and must already be
      // active before the channel may retain or route to it. Using the active
      // entity registry keeps that liveness proof independent of the public
      // workspace-service/DO discovery surface (which intentionally does not
      // expose per-owner internal objects such as EvalDO).
      const active = (await this.rpc.call(
        "main",
        "workspace-state.entity.resolveActive",
        [participantId],
      )) as { id?: unknown; kind?: unknown } | null;
      if (!active || active.id !== participantId || active.kind !== "do") {
        throw new Error(
          `subscribe: Durable Object participant ${participantId} is not active`,
        );
      }
    }
    // Live external sessions are presence resources only. Durable entity
    // membership uses join() and never enters this table or opens a response.
    const existingSubscriptions =
      this.participantSubscriptionCount(participantId);

    // Extract replay options before cleaning metadata
    const wantsReplay = metadata["replay"] !== false;
    const sinceId = metadata["sinceId"] as number | undefined;
    const replayMessageLimit = metadata["replayMessageLimit"] as
      | number
      | undefined;

    // Clean metadata for storage (remove transport/DO fields and subscribe-time hints)
    let storedMetadata = { ...metadata };
    delete storedMetadata["contextId"];
    delete storedMetadata["channelConfig"];
    delete storedMetadata["replay"];
    delete storedMetadata["sinceId"];
    delete storedMetadata["replayMessageLimit"];
    delete storedMetadata["transport"];
    if (isUserParticipant)
      storedMetadata = scrubUserParticipantMetadata(storedMetadata);
    // Relationships are durable public conversation facts. Retain only the
    // bounded participant summary; executable schemas remain owned by the
    // participant and are resolved at invocation time.
    storedMetadata = publicParticipantMetadata(storedMetadata) ?? {};

    // The streamed response is only an external transport attachment. The
    // participant's semantic relationship is a canonical log fact and remains
    // independently reconstructible after this response disappears.
    await this.ensureSessionRelationship(
      participantId,
      contextId ?? "",
      storedMetadata,
    );

    try {
      if (isUserParticipant) {
        // The shared human identity and retained-presence reset form one
        // storage commit.
        // Joining IS activity (WP8 §3): seed `last_active_at` on first join and
        // bump it on every (re)join so a returning panel resets idle/away.
        const joinNow = Date.now();
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(
            `INSERT INTO participants (
               id, metadata, transport, last_active_at, presence_status, handle
             ) VALUES (?, ?, 'rpc', ?, 'online', NULL)
             ON CONFLICT(id) DO UPDATE SET
               metadata = excluded.metadata,
               transport = excluded.transport,
               last_active_at = MAX(COALESCE(participants.last_active_at, 0), excluded.last_active_at),
               presence_status = 'online'`,
            participantId,
            JSON.stringify(storedMetadata),
            joinNow,
          );
          // Back online — drop retained last-seen in the same commit.
          this.sql.exec(
            `DELETE FROM presence_last_seen WHERE participant_id = ?`,
            participantId,
          );
        });
      } else {
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(
            `INSERT INTO participants (
               id, metadata, transport, last_active_at, presence_status, handle
             ) VALUES (?, ?, ?, NULL, NULL, ?)
             ON CONFLICT(id) DO UPDATE SET
               metadata = excluded.metadata,
               transport = excluded.transport,
               handle = excluded.handle`,
            participantId,
            JSON.stringify(storedMetadata),
            "rpc",
            handle,
          );
        });
      }
    } catch (err) {
      if (handle && err instanceof Error && /unique/iu.test(err.message)) {
        throw new Error(
          `Participant handle "${handle}" is already in use by another participant ` +
            `(unknown) in this channel. Handles must be unique.`,
        );
      }
      throw err;
    }
    this.invalidateBroadcastParticipants();

    // Publish join presence before building replay so the initial roster snapshot
    // includes self. Replacing a transport generation is an update to the same
    // semantic participant, not a synthetic leave/join pair.
    await this.publishPresenceEvent(
      participantId,
      existingSubscriptions > 0 ? "update" : "join",
      storedMetadata,
    );

    const mode = wantsReplay && sinceId && sinceId > 0 ? "after" : "initial";
    const envelope =
      mode === "after"
        ? await this.channelLog.replayAfter(
            { after: sinceId! },
            this.currentReplayContext(),
          )
        : await this.channelLog.replayInitial(
            wantsReplay ? (replayMessageLimit ?? REPLAY_LIMIT) : 0,
            this.currentReplayContext(),
          );
    return this.openSubscriptionResponse(
      participantId,
      deliveryId,
      ownedSubscriptionId,
      !isUserParticipant,
      {
        ok: true,
        participantId,
        channelConfig: this.getChannelConfig() ?? undefined,
        envelope,
      },
    );
  }

  @rpc({
    principals: ["host", "user"],
    effect: {
      kind: "userland-capability",
      capability: "channel.admin",
      resource: { kind: "receiver-object" },
    },
    tier: "gated",
    sensitivity: "admin",
  })
  async adminUnsubscribeParticipant(participantId: string): Promise<void> {
    await this.unsubscribeParticipant(participantId, "graceful");
    await this.endRelationship(participantId);
  }

  /**
   * Acknowledged self-leave. Stream cancellation remains the crash/disconnect
   * terminal, but a cooperative participant must use this method so its owner
   * can prove that accepted structured deliveries were drained before retiring
   * the participant runtime.
   */
  @rpc({
    principals: ["user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async unsubscribe(
    participantId: string,
    subscriptionId?: string,
  ): Promise<void> {
    this.assertParticipantCaller(participantId, "unsubscribe");
    if (
      subscriptionId !== undefined &&
      (subscriptionId.length === 0 || subscriptionId.length > 128)
    ) {
      throw new Error("unsubscribe: invalid subscription identity");
    }
    const deliveryId = this.caller?.callerPanelId ?? this.caller?.callerId;
    if (!deliveryId) {
      throw new Error(
        "unsubscribe: authenticated delivery identity is required",
      );
    }
    const ownedSubscriptionId = subscriptionId ?? deliveryId;
    const stream = this.subscriptionStreams.get(
      this.subscriptionStreamKey(participantId, ownedSubscriptionId),
    );
    if (stream && stream.deliveryId !== deliveryId) {
      throw new Error(
        "unsubscribe: subscription is owned by another delivery",
      );
    }
    await this.unsubscribeParticipant(
      participantId,
      "graceful",
      ownedSubscriptionId,
    );
    // A human participant is shared by every surface owned by that account.
    // Closing one response releases only that authenticated delivery; the
    // durable relationship remains active until its final response is gone.
    if (this.participantSubscriptionCount(participantId) === 0) {
      await this.endRelationship(participantId);
    }
  }

  private async ensureSessionRelationship(
    participantId: string,
    contextId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deriveDeliveries();
    const current = this.deliveryProjection.relationship(participantId);
    const retained = this.sql
      .exec(
        `SELECT delivery, endpoint_kind, metadata_json, application_config_json, active
           FROM channel_relationships WHERE participant_id = ?`,
        participantId,
      )
      .toArray()[0];
    const desired = {
      delivery: "all" as const,
      endpoint: { kind: "session" as const },
      metadata,
      applicationConfig: null,
    };
    const unchanged =
      current?.active === true &&
      retained?.["endpoint_kind"] === "session" &&
      retained?.["delivery"] === desired.delivery &&
      canonicalJson(JSON.parse(String(retained?.["metadata_json"] ?? "{}"))) ===
        canonicalJson(metadata) &&
      retained?.["application_config_json"] === null;
    if (unchanged) return;
    const revision = (current?.revision ?? 0) + 1;
    await this.appendDurable({
      type: current
        ? "channel.subscription.revised"
        : "channel.subscription.opened",
      payload: { participantId, revision, ...desired },
      senderId: participantId,
      senderMetadata: metadata,
      messageId: `channel-subscription:${participantId}:${revision}`,
      idempotency: "idempotent-by-id",
    });
    if (contextId) this.initChannel(contextId);
  }

  private async endRelationship(participantId: string): Promise<void> {
    await this.deriveDeliveries();
    const current = this.deliveryProjection.relationship(participantId);
    if (!current?.active) return;
    const revision = current.revision + 1;
    await this.appendDurable({
      type: "channel.subscription.ended",
      payload: { participantId, revision },
      senderId: participantId,
      senderMetadata: this.getSenderMetadata(participantId) ?? {},
      messageId: `channel-subscription:${participantId}:${revision}`,
      idempotency: "idempotent-by-id",
    });
  }

  private async unsubscribeParticipant(
    participantId: string,
    leaveReason: "graceful" | "disconnect" | "replaced",
    subscriptionId?: string,
  ): Promise<void> {
    const metadata = this.getSenderMetadata(participantId) ?? {};
    const participantExists =
      this.sql
        .exec(`SELECT 1 FROM participants WHERE id = ?`, participantId)
        .toArray().length > 0;
    if (subscriptionId) {
      this.closeSubscriptionStream(participantId, subscriptionId);
    } else {
      for (const stream of [...this.subscriptionStreams.values()]) {
        if (stream.participantId === participantId) {
          this.closeSubscriptionStream(participantId, stream.subscriptionId);
        }
      }
    }
    if (this.participantSubscriptionCount(participantId) > 0) return;
    if (!participantExists) return;

    this.ctx.storage.transactionSync(() => {
      if (isUserParticipantId(participantId)) {
        this.recordOfflinePresence(participantId, Date.now());
      }
      this.sql.exec(`DELETE FROM participants WHERE id = ?`, participantId);
    });
    this.invalidateBroadcastParticipants();
    await this.calls.failPendingCallsTargeting(participantId, leaveReason);
    await this.publishPresenceEvent(
      participantId,
      "leave",
      {
        ...metadata,
        ...(isUserParticipantId(participantId)
          ? { presenceStatus: "offline" }
          : {}),
      },
      leaveReason,
    );
  }

  /** Abandoned terminals for every pending call targeting a leaver (or, on a
   *  fork that could not re-home the call, `aborted-by-fork` — C6). */
  async failPendingCallsTargeting(
    targetId: string,
    reason: "graceful" | "disconnect" | "replaced" | "aborted-by-fork",
  ): Promise<void> {
    await this.calls.failPendingCallsTargeting(targetId, reason);
  }

  /**
   * Publish a typed message. The transport is OPAQUE to payload semantics:
   * GAD validates agentic payloads at append-time inside the txn; policies
   * annotate (never mutate) the envelope.
   */
  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async publish(
    participantId: string,
    type: string,
    payload: unknown,
    opts?: {
      ref?: number;
      senderMetadata?: Record<string, unknown>;
      attachments?: StoredAttachment[];
      idempotencyKey?: string;
    },
  ): Promise<{ id?: number }> {
    this.assertParticipantCaller(participantId, "publish");
    this.assertGuestAdmission(participantId);
    this.markParticipantActive(participantId);
    const ref = opts?.ref;
    const attachments = opts?.attachments;
    const idempotencyKey = opts?.idempotencyKey;
    if (idempotencyKey) {
      const existing = this.sql
        .exec(`SELECT result_id FROM dedup_keys WHERE key = ?`, idempotencyKey)
        .toArray();
      const existingId = existing[0]?.["result_id"] as
        | number
        | null
        | undefined;
      if (existingId != null) return { id: existingId };
      const inFlight = this.publishDedupInFlight.get(idempotencyKey);
      if (inFlight) return { id: (await inFlight).id };
      if (existing.length > 0) {
        // A previous publish reserved the key but failed or the DO restarted
        // before storing a result. Let this request become the new owner.
        this.sql.exec(
          `DELETE FROM dedup_keys WHERE key = ? AND result_id IS NULL`,
          idempotencyKey,
        );
      }
    }

    const senderMetadata =
      this.getSenderMetadata(participantId) ?? opts?.senderMetadata;
    const event = await this.runDedupedPublish(idempotencyKey, async () =>
      this.appendDurable({
        type,
        payload,
        senderId: participantId,
        senderMetadata,
        // Durable idempotency is the deterministic envelope id in the log
        // lineage; dedup_keys is only a latency cache (WS2 §3.2). Client
        // retries carry a stable key with volatile payload fields, so this
        // path — and ONLY this path — appends first-write-wins.
        messageId: idempotencyKey ? `ik:${idempotencyKey}` : undefined,
        ...(idempotencyKey ? { idempotency: "idempotent-by-id" as const } : {}),
        attachments,
      }),
    );

    broadcast(
      this.broadcastDeps,
      event,
      { kind: "log", phase: "live", ref },
      participantId,
    );
    return { id: event.id };
  }

  /** Update recipient visibility without appending another channel message.
   * Receipts are a monotone projection and reach live external clients only
   * as disposable presentation signals; replay reads the durable snapshot. */
  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async recordReceipt(
    participantId: string,
    messageId: string,
    state: "read",
    opts?: { turnId?: string },
  ): Promise<{ recorded: true }> {
    this.assertParticipantCaller(participantId, "recordReceipt");
    if (!messageId || state !== "read")
      throw new Error("recordReceipt: invalid receipt");
    this.deliveryProjection.recordRead(messageId, participantId, opts?.turnId);
    const ref = this.participantRef(participantId);
    const now = Date.now();
    broadcast(
      this.broadcastDeps,
      {
        id: 0,
        messageId: `receipt:${messageId}:${participantId}:read`,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        senderId: participantId,
        senderMetadata: ref.metadata,
        payload: {
          kind: "message.read",
          actor: ref,
          causality: { messageId },
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            ...(opts?.turnId ? { turnId: opts.turnId } : {}),
          },
          createdAt: new Date(now).toISOString(),
        },
        ts: now,
      },
      { kind: "signal" },
      participantId,
    );
    return { recorded: true };
  }

  /**
   * Publish a durable text message on behalf of a NON-participant host caller
   * (the `vibestudio channel send` CLI: a human `shell` device or an autonomous
   * `agent`). Unlike `publish`, the sender is NOT a roster participant and is NOT
   * taken from a client-supplied `participantId` — it is stamped from the VERIFIED
   * caller (`this.caller`), so a CLI can address a conversation without joining it
   * and cannot impersonate another participant. The message is a standard
   * `agentic.trajectory.v1` `message.completed` (role user for a shell device,
   * role assistant for an agent), carrying the same addressing fields
   * (`to`/`mentions`) a participant's message would.
   */
  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async sendAsCaller(
    text: string,
    opts?: {
      handle?: string;
      to?: Array<{
        kind: "all" | "role" | "participant";
        role?: string;
        participantId?: string;
      }>;
      mentions?: string[];
      idempotencyKey?: string;
    },
  ): Promise<{ id?: number; messageId: string }> {
    const caller = this.caller;
    const senderId = caller?.callerId ?? "cli";
    const isAgent = this.authorization?.authorizingOrigin.kind === "session";
    const handle = isAgent ? senderId : (opts?.handle ?? senderId);
    const messageId = opts?.idempotencyKey
      ? `ik:${opts.idempotencyKey}`
      : crypto.randomUUID();
    const senderMetadata: Record<string, unknown> = {
      name: handle,
      handle,
      transport: "rpc",
      kind: isAgent ? "agent" : "user",
    };
    const event = {
      kind: "message.completed",
      actor: {
        kind: isAgent ? "agent" : "user",
        id: senderId,
        displayName: handle,
        metadata: senderMetadata,
      },
      causality: { messageId },
      payload: {
        protocol: "agentic.trajectory.v1",
        role: isAgent ? "assistant" : "user",
        blocks: [
          { blockId: `${messageId}:block:0`, type: "text", content: text },
        ],
        outcome: "completed",
        ...(opts?.mentions ? { mentions: opts.mentions } : {}),
        ...(opts?.to ? { to: opts.to } : {}),
      },
      createdAt: new Date().toISOString(),
    };
    const logged = await this.appendDurable({
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: event,
      senderId,
      senderMetadata,
      messageId,
      ...(opts?.idempotencyKey
        ? { idempotency: "idempotent-by-id" as const }
        : {}),
    });
    broadcast(
      this.broadcastDeps,
      logged,
      { kind: "log", phase: "live" },
      senderId,
    );
    return { id: logged.id, messageId };
  }

  /** Policy fold state (replaces getConversationState — WS2 §4.4). */
  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async getPolicyState(name?: string): Promise<{
    policy: string;
    version: number;
    foldedThroughSeq: number;
    state: unknown;
  }> {
    return this.policyHost.getState(name ?? DEFAULT_POLICY_NAME);
  }

  private async runDedupedPublish(
    idempotencyKey: string | undefined,
    append: () => Promise<ChannelEvent>,
  ): Promise<ChannelEvent> {
    if (!idempotencyKey) return append();

    let promise!: Promise<ChannelEvent>;
    promise = (async () => {
      this.sql.exec(
        `INSERT OR IGNORE INTO dedup_keys (key, result_id, created_at) VALUES (?, NULL, ?)`,
        idempotencyKey,
        Date.now(),
      );
      try {
        const event = await append();
        this.sql.exec(
          `UPDATE dedup_keys SET result_id = ?, created_at = ? WHERE key = ?`,
          event.id,
          Date.now(),
          idempotencyKey,
        );
        return event;
      } catch (err) {
        this.sql.exec(
          `DELETE FROM dedup_keys WHERE key = ? AND result_id IS NULL`,
          idempotencyKey,
        );
        throw err;
      } finally {
        if (this.publishDedupInFlight.get(idempotencyKey) === promise) {
          this.publishDedupInFlight.delete(idempotencyKey);
        }
      }
    })();

    this.publishDedupInFlight.set(idempotencyKey, promise);
    return promise;
  }

  /**
   * Broadcast envelopes that were durably appended to GAD outside this DO
   * (trajectory publication fan-out). Folds each into the policy caches.
   */
  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async broadcastStoredEnvelopes(
    envelopeIds: string[],
  ): Promise<{ broadcasted: number }> {
    let broadcasted = 0;
    for (const envelopeId of envelopeIds) {
      if (typeof envelopeId !== "string" || envelopeId.length === 0) continue;
      const event = await this.channelLog.getEventByEnvelopeId(envelopeId);
      if (!event) continue;
      this.policyHost.foldAppended(this.policyViewFromChannelEvent(event));
      await this.deriveDeliveries(event);
      broadcast(
        this.broadcastDeps,
        event,
        { kind: "log", phase: "live" },
        event.senderId,
      );
      broadcasted += 1;
    }
    return { broadcasted };
  }

  /** Mark a message as errored (durable `error` channel event). */
  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async error(
    participantId: string,
    messageId: string,
    errorMessage: string,
    code?: string,
  ): Promise<void> {
    this.assertParticipantCaller(participantId, "error");
    this.markParticipantActive(participantId);
    const senderMetadata = this.getSenderMetadata(participantId);
    const payload: Record<string, unknown> = {
      id: messageId,
      error: errorMessage,
    };
    if (code) payload["code"] = code;
    const event = await this.appendDurable({
      type: "error",
      payload,
      senderId: participantId,
      senderMetadata,
    });
    broadcast(
      this.broadcastDeps,
      event,
      { kind: "log", phase: "live" },
      participantId,
    );
  }

  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async getReplayAfter(request: ChannelReplayAfterRequest) {
    return this.channelLog.replayAfter(request, this.currentReplayContext());
  }

  /** Return one durable envelope by its stable envelope id, or null when that
   * id belongs to another log (for example a VCS commit id). This is a pure,
   * lineage-aware lookup used by panels, agents, and diagnostic evals. */
  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async getEnvelope(envelopeId: string): Promise<ChannelEvent | null> {
    return this.channelLog.getEventByEnvelopeId(envelopeId);
  }

  /** Send a non-durable signal message. */
  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async sendSignal(
    participantId: string,
    content: string,
    contentType?: string,
  ): Promise<void> {
    this.assertParticipantCaller(participantId, "sendSignal");
    this.markParticipantActive(participantId);
    const ts = Date.now();
    const senderMetadata = this.getSenderMetadata(participantId);

    const payload: Record<string, unknown> = { content };
    if (contentType) payload["contentType"] = contentType;
    const payloadJson = JSON.stringify(payload);

    const event = buildChannelEvent(
      0,
      `sig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      "signal",
      payloadJson,
      participantId,
      senderMetadata,
      ts,
    );
    broadcast(this.broadcastDeps, event, { kind: "signal" }, participantId);
  }

  /** Replace a participant's metadata entirely. */
  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async updateMetadata(
    participantId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    this.assertParticipantCaller(participantId, "updateMetadata");
    this.markParticipantActive(participantId);
    await this.updateParticipantMetadata(participantId, metadata);
  }

  @rpc({
    principals: ["host", "user"],
    effect: {
      kind: "userland-capability",
      capability: "channel.admin",
      resource: { kind: "receiver-object" },
    },
    tier: "gated",
    sensitivity: "admin",
  })
  async adminUpdateParticipantMetadata(
    participantId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.updateParticipantMetadata(participantId, metadata);
  }

  private async updateParticipantMetadata(
    participantId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    // A human row keeps only its stable identity — re-asserted profile fields
    // are dropped (WP6 §3: profile renders live, never frozen into the roster).
    const stored = isUserParticipantId(participantId)
      ? scrubUserParticipantMetadata(metadata)
      : metadata;
    await this.deriveDeliveries();
    const relationship = this.deliveryProjection.relationship(participantId);
    if (relationship?.active) {
      const row = this.sql
        .exec(
          `SELECT delivery, endpoint_kind, endpoint_entity_id, application_config_json
             FROM channel_relationships WHERE participant_id = ?`,
          participantId,
        )
        .toArray()[0]!;
      const revision = relationship.revision + 1;
      await this.appendDurable({
        type: "channel.subscription.revised",
        payload: {
          participantId,
          revision,
          delivery: row["delivery"],
          endpoint:
            row["endpoint_kind"] === "entity"
              ? { kind: "entity", entityId: String(row["endpoint_entity_id"]) }
              : { kind: "session" },
          metadata: stored,
          applicationConfig:
            row["application_config_json"] === null
              ? null
              : JSON.parse(String(row["application_config_json"])),
        },
        senderId: participantId,
        senderMetadata: stored,
        messageId: `channel-subscription:${participantId}:${revision}`,
        idempotency: "idempotent-by-id",
      });
    }
    this.sql.exec(
      `UPDATE participants SET metadata = ? WHERE id = ?`,
      JSON.stringify(stored),
      participantId,
    );
    this.invalidateBroadcastParticipants();
    await this.publishPresenceEvent(participantId, "update", stored);
  }

  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async setTypingState(participantId: string, typing: boolean): Promise<void> {
    this.assertParticipantCaller(participantId, "setTypingState");
    if (typing) this.markParticipantActive(participantId);
    this.setParticipantTypingState(participantId, typing);
  }

  @rpc({
    principals: ["host", "user"],
    effect: {
      kind: "userland-capability",
      capability: "channel.admin",
      resource: { kind: "receiver-object" },
    },
    tier: "gated",
    sensitivity: "admin",
  })
  async adminSetParticipantTypingState(
    participantId: string,
    typing: boolean,
  ): Promise<void> {
    this.setParticipantTypingState(participantId, typing);
  }

  private setParticipantTypingState(
    participantId: string,
    typing: boolean,
  ): void {
    const rows = this.sql
      .exec(`SELECT metadata FROM participants WHERE id = ?`, participantId)
      .toArray();
    if (rows.length === 0) return;
    const final = { ...JSON.parse(rows[0]!["metadata"] as string), typing };
    this.sql.exec(
      `UPDATE participants SET metadata = ? WHERE id = ?`,
      JSON.stringify(final),
      participantId,
    );
    this.invalidateBroadcastParticipants();
    this.broadcastPresenceSignal(participantId, "update", final);
  }

  /** Get all participants with DO identity when available. */
  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async getParticipants(): Promise<
    Array<{
      participantId: string;
      ref: ParticipantRef;
      metadata: Record<string, unknown>;
      transport: string;
      doRef?: { source: string; className: string; objectKey: string };
    }>
  > {
    const rows = [
      ...this.sql
        .exec(
          `SELECT id AS participant_id, metadata AS metadata_json, transport, NULL AS endpoint_entity_id FROM participants`,
        )
        .toArray(),
      ...this.sql
        .exec(
          `SELECT participant_id, metadata_json,
                  CASE endpoint_kind WHEN 'entity' THEN 'do' ELSE 'session' END AS transport,
                  endpoint_entity_id
             FROM channel_relationships WHERE active = 1`,
        )
        .toArray(),
    ];
    const unique = new Map<string, (typeof rows)[number]>();
    for (const row of rows) unique.set(String(row["participant_id"]), row);
    return [...unique.values()].map((row) => {
      const participantId = String(row["participant_id"]);
      const metadata = JSON.parse(String(row["metadata_json"])) as Record<
        string,
        unknown
      >;
      const entry: {
        participantId: string;
        ref: ParticipantRef;
        metadata: Record<string, unknown>;
        transport: string;
        doRef?: { source: string; className: string; objectKey: string };
      } = {
        participantId,
        ref: participantRefFromMetadata(participantId, metadata),
        metadata,
        transport: row["transport"] as string,
      };
      const doRef =
        typeof row["endpoint_entity_id"] === "string"
          ? parseDOParticipantId(row["endpoint_entity_id"])
          : null;
      if (doRef) entry.doRef = doRef;
      return entry;
    });
  }

  // ── Channel membership + workspace invite index (WP7 §3-4,7) ─────────────
  //
  // A durable, per-channel member list layered ON TOP OF — deliberately NOT
  // inside — the ephemeral `participants` roster (see `channel_members` in
  // createTables). Membership is notification / roster visibility, NOT a hard
  // ACL wall: inside a workspace users are mutually trusted (plan §0.0). The
  // ONE authorization gate is workspace membership of the ADDED user, answered
  // by the host — userland never opens the identity DB (INV-2).

  /**
   * Add a workspace member to this channel (WP7 §3). Records durable membership,
   * journals the workspace-inbox projection, and emits a best-effort live nudge.
   * Authorization (§4): the added user must be a member of THIS workspace
   * — checked via the host-projected `account.isMember` predicate (the child
   * resolves it against its OWN bound workspaceId over the shared identity DB
   * read-only; userland neither learns the workspaceId nor opens the DB). No
   * per-channel ACL. Attribution (`added_by`) is the acting caller's
   * host-verified `userId` (WP4). Idempotent: re-adding refreshes the handle
   * snapshot without a second invite.
   */
  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async addMember(input: {
    userId: string;
  }): Promise<ChannelMember & { alreadyMember: boolean }> {
    const targetUserId = requireBareUserId(input?.userId, "addMember");
    const memberId = toUserMemberId(targetUserId);

    const caller = this.caller;
    const addedBy = caller?.userId
      ? toUserMemberId(caller.userId)
      : (caller?.callerId ?? "system");

    // Authorization (WP7 §4): the only gate is workspace membership of the
    // ADDED user. Host seam — the child opens the shared identity DB RO and
    // answers `MembershipStore.has(userId, <its own workspaceId>)` (INV-2/§4).
    const isMember = await this.rpc.call<boolean>("main", "account.isMember", [
      targetUserId,
    ]);
    if (!isMember) {
      throw new Error(
        `addMember: ${memberId} is not a member of this workspace and cannot be added to the channel`,
      );
    }

    // Denormalize the invitee's current handle for member-list / invite-chip
    // display. Profiles still render LIVE from the host projection (WP6 §3) —
    // this snapshot is a convenience, not the source of truth.
    const profiles = await this.rpc.call<Record<string, { handle?: string }>>(
      "main",
      "account.resolveProfiles",
      [[targetUserId]],
    );
    const handle = profiles[targetUserId]?.handle ?? memberId;

    const existing = this.sql
      .exec(
        `SELECT added_at, added_by FROM channel_members WHERE user_id = ?`,
        memberId,
      )
      .toArray();
    const alreadyMember = existing.length > 0;
    if (alreadyMember) {
      const pendingPut =
        this.sql
          .exec(
            `SELECT 1 FROM invite_index_ops WHERE user_id = ? AND action = 'put'`,
            memberId,
          )
          .toArray().length > 0;
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `UPDATE channel_members SET handle = ? WHERE user_id = ?`,
          handle,
          memberId,
        );
        if (pendingPut) {
          this.journalInvitePut(
            memberId,
            handle,
            String(existing[0]!["added_by"]),
            Number(existing[0]!["added_at"]),
          );
        }
      });
      if (pendingPut) {
        const synced = await this.flushInviteIndexOp(memberId);
        if (!synced) {
          throw new Error(
            `addMember: membership is saved, but invitation delivery is pending; retry to confirm`,
          );
        }
      }
      return {
        userId: targetUserId,
        memberId,
        handle,
        addedBy: existing[0]!["added_by"] as string,
        addedAt: existing[0]!["added_at"] as number,
        alreadyMember: true,
      };
    }

    const addedAt = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO channel_members (user_id, handle, added_by, added_at)
           VALUES (?, ?, ?, ?)`,
        memberId,
        handle,
        addedBy,
        addedAt,
      );
      this.journalInvitePut(memberId, handle, addedBy, addedAt);
    });
    const synced = await this.flushInviteIndexOp(memberId);
    // Live nudge is a membership signal, never a presence event: inviting an
    // offline person must not make them appear online.
    this.broadcastChannelSignal("channel.invite", {
      channelId: this.objectKey,
      memberId,
      userId: targetUserId,
      addedBy,
      addedAt,
    });
    if (!synced) {
      throw new Error(
        `addMember: membership is saved, but invitation delivery is pending; retry to confirm`,
      );
    }
    return {
      userId: targetUserId,
      memberId,
      handle,
      addedBy,
      addedAt,
      alreadyMember: false,
    };
  }

  /** Remove a member from this channel (WP7 §3, §10.3 — a user may remove
   *  themselves; mutual trust means anyone may, no ACL). History stays visible. */
  @rpc({
    principals: ["host", "user", "code"],
    effect: {
      kind: "userland-capability",
      capability: "channel.members.remove",
      resource: { kind: "receiver-object" },
    },
    tier: "critical",
    sensitivity: "destructive",
  })
  async removeMember(input: { userId: string }): Promise<{ removed: boolean }> {
    const userId = requireBareUserId(input?.userId, "removeMember");
    const memberId = toUserMemberId(userId);
    const removed = this.deleteMembershipRow(memberId);
    const synced = await this.flushInviteIndexOp(memberId);
    if (!synced) {
      throw new Error(
        `removeMember: membership was removed, but invitation cleanup is pending; retry to confirm`,
      );
    }
    return { removed };
  }

  /** Delete one durable membership row and journal inbox cleanup. */
  private deleteMembershipRow(memberId: string): boolean {
    const existed =
      this.sql
        .exec(`SELECT 1 FROM channel_members WHERE user_id = ?`, memberId)
        .toArray().length > 0;
    this.ctx.storage.transactionSync(() => {
      if (existed)
        this.sql.exec(
          `DELETE FROM channel_members WHERE user_id = ?`,
          memberId,
        );
      this.journalInviteDelete(memberId);
    });
    return existed;
  }

  /** List this channel's durable members (WP7 §3). Ordered by add time. */
  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async listMembers(): Promise<{ members: ChannelMember[] }> {
    const rows = this.sql
      .exec(
        `SELECT user_id, handle, added_by, added_at
           FROM channel_members ORDER BY added_at ASC`,
      )
      .toArray();
    return {
      members: rows.map((row) => {
        const memberId = row["user_id"] as string;
        return {
          userId: bareUserId(memberId),
          memberId,
          handle: row["handle"] as string,
          addedBy: row["added_by"] as string,
          addedAt: row["added_at"] as number,
        };
      }),
    };
  }

  /**
   * Current-channel view of the canonical workspace inbox (WP7 §7). The caller
   * identity is host-verified and the indexed lookup is exact; no client-supplied
   * user id and no channel enumeration participate in discovery.
   */
  @rpc({
    principals: ["user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async listInvitesForMe(): Promise<{ invites: ChannelInvite[] }> {
    const caller = this.caller;
    if (!caller?.userId)
      throw new Error("listInvitesForMe requires an authenticated user");
    const invite = await this.inviteIndex.call<ChannelInvite | null>(
      "getChannelInvite",
      {
        userId: caller.userId,
        channelId: this.objectKey,
      } satisfies DeleteChannelInviteInput,
    );
    return { invites: invite ? [invite] : [] };
  }

  /** Remove the calling user's invite from the canonical workspace inbox. */
  @rpc({
    principals: ["user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async acknowledgeInvite(): Promise<{ acknowledged: boolean }> {
    const caller = this.caller;
    if (!caller?.userId)
      throw new Error("acknowledgeInvite requires an authenticated user");
    const result = await this.inviteIndex.call<{ deleted: boolean }>(
      "deleteChannelInvite",
      {
        userId: caller.userId,
        channelId: this.objectKey,
      } satisfies DeleteChannelInviteInput,
    );
    return { acknowledged: result.deleted };
  }

  private journalInvitePut(
    memberId: string,
    handle: string,
    addedBy: string,
    addedAt: number,
  ): void {
    const revision = this.nextInviteIndexRevision();
    this.sql.exec(
      `INSERT OR REPLACE INTO invite_index_ops
         (user_id, op_id, revision, action, handle, added_by, added_at, updated_at)
       VALUES (?, ?, ?, 'put', ?, ?, ?, ?)`,
      memberId,
      crypto.randomUUID(),
      revision,
      handle,
      addedBy,
      addedAt,
      Date.now(),
    );
  }

  private journalInviteDelete(memberId: string): void {
    const revision = this.nextInviteIndexRevision();
    this.sql.exec(
      `INSERT OR REPLACE INTO invite_index_ops
         (user_id, op_id, revision, action, handle, added_by, added_at, updated_at)
       VALUES (?, ?, ?, 'delete', NULL, NULL, NULL, ?)`,
      memberId,
      crypto.randomUUID(),
      revision,
      Date.now(),
    );
  }

  /** Allocate the next channel-local projection revision inside the caller's
   * storage transaction. A single counter is sufficient because GAD compares
   * revisions within (channel,user), and gives every local intent a total order. */
  private nextInviteIndexRevision(): number {
    const current = Number(this.getStateValue(INVITE_INDEX_REVISION_KEY) ?? 0);
    const revision = current + 1;
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new Error("channel membership projection revision overflow");
    }
    this.setStateValue(INVITE_INDEX_REVISION_KEY, String(revision));
    return revision;
  }

  /** Drive one idempotent index mutation. Failures remain durably journaled. */
  private async flushInviteIndexOp(memberId: string): Promise<boolean> {
    const rows = this.sql
      .exec(
        `SELECT op_id, revision, action, handle, added_by, added_at
           FROM invite_index_ops WHERE user_id = ?`,
        memberId,
      )
      .toArray();
    if (rows.length === 0) return true;
    const row = rows[0]!;
    const opId = String(row["op_id"]);
    const userId = bareUserId(memberId);
    try {
      if (row["action"] === "put") {
        // The local row and journal can outlive workspace membership while a
        // failed GAD write is waiting for its alarm retry. Re-authorize every
        // delayed put so revocation cannot resurrect the canonical invite.
        const isStillWorkspaceMember = await this.rpc.call<boolean>(
          "main",
          "account.isMember",
          [userId],
        );
        if (!isStillWorkspaceMember) {
          this.ctx.storage.transactionSync(() => {
            this.sql.exec(
              `DELETE FROM channel_members WHERE user_id = ?`,
              memberId,
            );
            this.journalInviteDelete(memberId);
          });
          // Flush the newly journaled, higher-revision delete now. If it fails,
          // the normal retry path retains it durably.
          return await this.flushInviteIndexOp(memberId);
        }
        await this.inviteIndex.call<void>("putChannelMembership", {
          channelId: this.objectKey,
          userId,
          memberId,
          handle: String(row["handle"]),
          addedBy: String(row["added_by"]),
          addedAt: Number(row["added_at"]),
          revision: Number(row["revision"]),
        } satisfies PutChannelMembershipInput);
      } else {
        await this.inviteIndex.call("deleteChannelMembership", {
          channelId: this.objectKey,
          userId,
          revision: Number(row["revision"]),
        } satisfies DeleteChannelMembershipInput);
      }
      this.sql.exec(
        `DELETE FROM invite_index_ops WHERE user_id = ? AND op_id = ?`,
        memberId,
        opId,
      );
      return true;
    } catch (error) {
      // Retain the latest failed attempt for explicit action retry and diagnosis.
      this.sql.exec(
        `UPDATE invite_index_ops SET updated_at = ? WHERE user_id = ? AND op_id = ?`,
        Date.now(),
        memberId,
        opId,
      );
      console.warn(
        `[Channel] invite index sync failed for ${memberId}:`,
        error,
      );
      return false;
    }
  }

  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async getContextId(): Promise<string | null> {
    return this.getStateValue("contextId");
  }

  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async getConfig(): Promise<ChannelConfig | null> {
    return this.getChannelConfig();
  }

  /**
   * Atomically bind a new private channel to its context, exact config, and
   * immutable participant set. Repeated identical initialization is safe;
   * any drift is a programming error rather than an implicit policy update.
   */
  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async initializeLockedChannel(
    contextId: string,
    config: ChannelConfig & { membershipPolicy: LockedChannelMembershipPolicy },
  ): Promise<ChannelConfig> {
    if (!contextId)
      throw new Error("initializeLockedChannel: contextId is required");
    const normalizedConfig: ChannelConfig = {
      ...config,
      membershipPolicy: this.normalizeLockedMembershipPolicy(
        config.membershipPolicy,
      ),
    };
    const existingContextId = this.getStateValue("contextId");
    const existingConfig = this.getChannelConfig();
    if (existingContextId) {
      if (
        existingContextId !== contextId ||
        !existingConfig ||
        canonicalJson(existingConfig) !== canonicalJson(normalizedConfig)
      ) {
        throw new Error(
          "initializeLockedChannel: existing channel definition does not match",
        );
      }
      return existingConfig;
    }
    this.ctx.storage.transactionSync(() => {
      if (this.getStateValue("contextId")) {
        throw new Error(
          "initializeLockedChannel: channel was initialized concurrently",
        );
      }
      this.setStateValue("contextId", contextId);
      this.setStateValue("createdAt", String(Date.now()));
      this.setStateValue("config", JSON.stringify(normalizedConfig));
    });
    this.deliveryProjection.initializeChannelConfig(normalizedConfig);
    this.policyHost.invalidatePolicySelection();
    void this.refreshOwnTitle();
    return normalizedConfig;
  }

  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async updateConfig(config: Partial<ChannelConfig>): Promise<ChannelConfig> {
    if ("membershipPolicy" in config) {
      throw new Error(
        "updateConfig: locked membership is immutable; initialize a different channel instead",
      );
    }
    const newConfig = { ...this.getChannelConfig(), ...config };
    this.setStateValue("config", JSON.stringify(newConfig));
    this.policyHost.invalidatePolicySelection();
    const event = await this.appendDurable({
      type: "config-update",
      payload: newConfig,
      senderId: "system",
    });
    broadcast(
      this.broadcastDeps,
      event,
      { kind: "log", phase: "live" },
      "system",
    );
    void this.refreshOwnTitle();
    return newConfig;
  }

  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async getReplayBefore(beforeSeq: number, limit?: number) {
    return this.channelLog.replayBefore(
      beforeSeq,
      limit ?? 100,
      this.currentReplayContext(),
    );
  }

  // Registry reads: direct passthrough to GAD's channel_message_types
  // projection (hydrated — published `source` payloads are blob-spilled).

  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async getMessageTypes(): Promise<MessageTypeDefinition[]> {
    return this.channelLog.listMessageTypes();
  }

  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async getMessageType(typeId: string): Promise<MessageTypeDefinition | null> {
    return this.channelLog.getMessageType(typeId);
  }

  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async getMessageSender(
    participantId: string,
    messageId: string,
  ): Promise<string | null> {
    this.assertParticipantCaller(participantId, "getMessageSender");
    const replay = await this.channelLog.replayInitial(
      500,
      this.currentReplayContext(),
    );
    for (const event of [...replay.logEvents].reverse()) {
      if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) continue;
      const payload = event.payload as {
        kind?: string;
        causality?: Record<string, unknown>;
      } | null;
      if (!payload || typeof payload !== "object") continue;
      if (payload.kind !== "message.completed") continue;
      if (payload.causality?.["messageId"] === messageId) return event.senderId;
    }
    return null;
  }

  @rpc({
    principals: ["host", "user"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async adminInspectSchema() {
    const tableNames = [
      "participants",
      "pending_calls",
      "dedup_keys",
      "fork_ops",
      "fork_view_cursor",
      "fork_message_loci",
      "fork_turn_loci",
      "fork_projection",
      "lineage_head_outbox",
      "lineage_heads",
      "channel_members",
      "invite_index_ops",
      "presence_last_seen",
    ];
    const tables = tableNames.map((table) => ({
      table,
      columns: this.sql.exec(`PRAGMA table_info(${table})`).toArray(),
    }));
    const indexes = tableNames.flatMap((table) => {
      const list = this.sql.exec(`PRAGMA index_list(${table})`).toArray();
      return list.map((idx) => ({
        table,
        ...idx,
        columns: this.sql
          .exec(`PRAGMA index_info(${idx["name"] as string})`)
          .toArray(),
      }));
    });
    const localEnvelopeTables = this.sql
      .exec(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_envelopes'`,
      )
      .toArray();
    return {
      tables,
      indexes,
      invariants: [
        {
          name: "durable-log-delegated-to-gad",
          ok: localEnvelopeTables.length === 0,
        },
      ],
    };
  }

  @rpc({
    principals: ["host", "user"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async adminInspectLog(
    opts: {
      afterId?: number;
      beforeId?: number;
      limit?: number;
      includePresence?: boolean;
    } = {},
  ) {
    const rows = await this.channelLog.inspectRows(opts);
    const firstId = rows[0]?.["seq"] as number | undefined;
    const lastId = rows[rows.length - 1]?.["seq"] as number | undefined;
    const before =
      firstId != null
        ? await this.channelLog.replayBefore(
            firstId,
            1,
            this.currentReplayContext(),
          )
        : null;
    const after =
      lastId != null
        ? await this.channelLog.replayAfter(
            { after: lastId },
            this.currentReplayContext(),
          )
        : null;
    return {
      rows,
      hasMoreBefore: (before?.logEvents.length ?? 0) > 0,
      hasMoreAfter: (after?.logEvents.length ?? 0) > 0,
    };
  }

  @rpc({
    principals: ["host", "user"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async adminInspectEnvelope(envelopeId: string) {
    return { rows: await this.channelLog.inspectEnvelope(envelopeId) };
  }

  @rpc({
    principals: ["host", "user"],
    effect: {
      kind: "userland-capability",
      capability: "channel.admin",
      resource: { kind: "receiver-object" },
    },
    tier: "gated",
    sensitivity: "admin",
  })
  async adminReconstructTranscript(
    opts: { rootLimit?: number; beforeSeq?: number } = {},
  ) {
    const envelope =
      opts.beforeSeq != null
        ? await this.getReplayBefore(opts.beforeSeq, opts.rootLimit)
        : await this.channelLog.replayInitial(
            opts.rootLimit ?? REPLAY_LIMIT,
            this.currentReplayContext(),
          );
    return {
      logEvents: envelope.logEvents,
      ready: envelope.ready,
    };
  }

  @rpc({
    principals: ["host", "user"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async adminInspectAgent(
    participantId: string,
    methodName = "getDebugState",
  ): Promise<AgentInspectionResult> {
    return this.inspectAgentReadOnly(participantId, methodName);
  }

  @rpc({
    principals: ["host", "user", "code"],
    effect: {
      kind: "userland-capability",
      capability: "channel.admin",
      resource: { kind: "receiver-object" },
    },
    tier: "gated",
    sensitivity: "admin",
  })
  async inspectAgent(
    participantId: string,
    methodName = "getDebugState",
  ): Promise<AgentInspectionResult> {
    this.assertSupportedAgentInspectionMethod(methodName);
    return this.inspectAgentReadOnly(participantId, methodName);
  }

  private assertSupportedAgentInspectionMethod(
    methodName: string,
  ): asserts methodName is AgentInspectionMethod {
    if (isAgentInspectionMethod(methodName)) return;
    throw new Error(
      `inspectAgent: unsupported method ${methodName}; expected one of ` +
        AGENT_INSPECTION_METHODS.join(", "),
    );
  }

  private async inspectAgentReadOnly(
    participantId: string,
    methodName: string,
  ): Promise<AgentInspectionResult> {
    this.assertSupportedAgentInspectionMethod(methodName);
    if (!parseDOParticipantId(participantId)) {
      throw new Error(
        `inspectAgent: participant ${participantId} is not a Durable Object participant id`,
      );
    }

    const rosterRows = this.sql
      .exec(
        `SELECT metadata, transport FROM participants WHERE id = ?`,
        participantId,
      )
      .toArray();
    const roster: {
      present: boolean;
      transport?: string;
      metadata?: Record<string, unknown>;
    } = { present: rosterRows.length > 0 };
    if (rosterRows.length > 0) {
      roster.transport = String(rosterRows[0]!["transport"] ?? "");
      try {
        roster.metadata = JSON.parse(
          String(rosterRows[0]!["metadata"] ?? "{}"),
        ) as Record<string, unknown>;
      } catch {
        roster.metadata = {};
      }
    }

    const response = (await this.rpc.call(
      participantId,
      AGENT_INSPECTION_RPC_METHOD,
      [this.objectKey, methodName],
      { readOnly: true, timeoutMs: AGENT_INSPECTION_TIMEOUT_MS },
    )) as { result?: unknown; isError?: boolean } | unknown;
    const payload =
      response && typeof response === "object" && "result" in response
        ? (response as { result?: unknown; isError?: boolean })
        : { result: response };

    return {
      participantId,
      channelId: this.objectKey,
      methodName,
      result: payload.result,
      ...(payload.isError !== undefined
        ? { isError: payload.isError === true }
        : {}),
      roster,
    };
  }

  @rpc({
    principals: ["host", "user"],
    effect: {
      kind: "userland-capability",
      capability: "channel.admin",
      resource: { kind: "receiver-object" },
    },
    tier: "gated",
    sensitivity: "admin",
  })
  async adminValidateLog(opts: { rootLimit?: number } = {}) {
    const issues: Array<{ code: string; message: string; rowId?: number }> = [];
    const schema = await this.adminInspectSchema();
    for (const invariant of schema.invariants) {
      if (!invariant.ok)
        issues.push({
          code: "schema",
          message: `schema invariant failed: ${invariant.name}`,
        });
    }
    const rows = await this.channelLog.inspectRows({
      limit: Math.min(Math.max(opts.rootLimit ?? 10000, 1), 100000),
    });
    for (const row of rows) {
      const rowId = row["seq"] as number;
      try {
        const parsed = JSON.parse(row["payload"] as string);
        if (row["payload_kind"] === AGENTIC_EVENT_PAYLOAD_KIND) {
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            issues.push({
              code: "agentic-envelope",
              message: "agentic envelope payload is invalid",
              rowId,
            });
          }
        }
      } catch {
        issues.push({
          code: "payload-json",
          message: "payload is not valid JSON",
          rowId,
        });
      }
    }
    return {
      ok: issues.length === 0,
      issues,
      stats: {
        rowCount: rows.length,
      },
    };
  }

  // ── Method calls (calls.ts — pending_calls is a declared cache) ──────────

  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async callMethod(
    callerPid: string,
    targetPid: string,
    callId: string,
    method: string,
    args: unknown,
    opts?: {
      invocationId?: string;
      transportCallId?: string;
      turnId?: string;
      timeoutMs?: number;
    },
  ): Promise<void> {
    this.assertParticipantCaller(callerPid, "callMethod");
    this.markParticipantActive(callerPid);
    await this.calls.callMethod(
      callerPid,
      targetPid,
      callId,
      method,
      args,
      opts,
    );
  }

  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async submitMethodResult(
    participantId: string,
    transportCallId: string,
    content: unknown,
    isError: boolean,
    opts?: {
      invocationId?: string;
      callerId?: string;
      turnId?: string;
      terminalOutcome?: InvocationOutcome;
      terminalReasonCode?: string;
      attachments?: StoredAttachment[];
      providerClaimGeneration?: number;
    },
  ): Promise<{
    id?: number;
    dropped?: boolean;
    reason?: string;
    recovered?: boolean;
  }> {
    this.assertParticipantCaller(participantId, "submitMethodResult");
    this.markParticipantActive(participantId);
    if (
      this.deliveryProjection.relationship(participantId)?.invocationRoute ===
        "mailbox" &&
      !this.calls.isCurrentProviderClaim(
        transportCallId,
        participantId,
        opts?.providerClaimGeneration,
      )
    ) {
      return { dropped: true, reason: "superseded-provider-claim" };
    }
    const resolution = await this.calls.resolveSubmitterForCall(
      participantId,
      transportCallId,
      "submitMethodResult",
    );
    if (resolution.kind === "terminal") {
      return { id: resolution.eventId };
    }
    if (resolution.kind === "missing") {
      // No live pending row AND no durable `started`/terminal even after
      // reconcile: a cache-cold / lost record. Dropping the result here strands
      // the caller forever — its parked invocation only settles on a terminal
      // carrying the same invocationId/transportCallId, so with NO terminal the
      // turn never closes and waitForIdle hangs. Recover by rooting the method
      // (sanctioned synthetic `started`, satisfying the fold) and appending +
      // broadcasting a real terminal keyed on the caller's invocationId.
      const id = await this.calls.settleMissingCall(
        participantId,
        transportCallId,
        content,
        isError,
        {
          ...(opts?.invocationId ? { invocationId: opts.invocationId } : {}),
          ...(opts?.callerId ? { callerId: opts.callerId } : {}),
          ...(opts?.turnId ? { turnId: opts.turnId } : {}),
          ...(opts?.terminalOutcome
            ? { terminalOutcome: opts.terminalOutcome }
            : {}),
          ...(opts?.terminalReasonCode
            ? { terminalReasonCode: opts.terminalReasonCode }
            : {}),
          ...(opts?.attachments ? { attachments: opts.attachments } : {}),
        },
      );
      console.warn(
        `[Channel] submitMethodResult recovered a lost call (no pending row): rooted method + ` +
          `appended terminal so the caller settles: channel=${this.objectKey} ` +
          `transportCallId=${transportCallId} isError=${isError} terminalSeq=${id}`,
      );
      return { id, dropped: false, recovered: true };
    }
    const id = await this.calls.settleCall(
      transportCallId,
      content,
      isError,
      opts?.terminalOutcome,
      opts?.terminalReasonCode,
      { attachments: opts?.attachments },
    );
    return { id };
  }

  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async submitMethodProgress(
    participantId: string,
    transportCallId: string,
    content: unknown,
    opts?: {
      invocationId?: string;
      turnId?: string;
      attachments?: StoredAttachment[];
      providerClaimGeneration?: number;
    },
  ): Promise<void> {
    this.assertParticipantCaller(participantId, "submitMethodProgress");
    this.markParticipantActive(participantId);
    const resolution = await this.calls.resolveSubmitterForCall(
      participantId,
      transportCallId,
      "submitMethodProgress",
    );
    if (resolution.kind !== "pending") {
      return;
    }
    if (
      this.deliveryProjection.relationship(participantId)?.invocationRoute ===
        "mailbox" &&
      !this.calls.isCurrentProviderClaim(
        transportCallId,
        participantId,
        opts?.providerClaimGeneration,
      )
    ) {
      return;
    }
    await this.calls.submitMethodProgress(transportCallId, content, {
      attachments: opts?.attachments,
    });
  }

  /** Terminal result entry point (kept for DO delivery + external callers). */
  async handleMethodResult(
    transportCallId: string,
    content: unknown,
    isError: boolean,
    terminalOutcome?: InvocationOutcome,
    terminalReasonCode?: string,
    transportOpts?: {
      attachments?: StoredAttachment[];
    },
  ): Promise<number | undefined> {
    return this.calls.settleCall(
      transportCallId,
      content,
      isError,
      terminalOutcome,
      terminalReasonCode,
      { attachments: transportOpts?.attachments },
    );
  }

  /** Cancel a method call owned by the authenticated participant.
   *
   * Cancellation is not an administrative operation: the participant that
   * initiated a call owns its lifetime. Authenticate the participant against
   * the transport principal, then have Calls verify the durable pending row's
   * caller before appending the terminal. Server-driven expiry remains the
   * separate `timeoutMethodCall` authority below.
   */
  @rpc({
    principals: ["user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async cancelMethodCall(participantId: string, callId: string): Promise<void> {
    this.assertParticipantCaller(participantId, "cancelMethodCall");
    const pending = await this.calls.cancelMethodCall(
      callId,
      "cancelled",
      participantId,
    );
    if (pending) await this.calls.abortProviderCall(pending);
  }

  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async claimMethodCall(
    participantId: string,
    transportCallId: string,
    providerGenerationId: string,
  ): Promise<{ claimed: boolean; generation?: number }> {
    this.assertParticipantCaller(participantId, "claimMethodCall");
    return this.calls.claimProviderCall(
      participantId,
      transportCallId,
      providerGenerationId,
    );
  }

  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async markMethodCallExecutionStarted(
    participantId: string,
    transportCallId: string,
    providerClaimGeneration: number,
  ): Promise<{ accepted: boolean }> {
    this.assertParticipantCaller(
      participantId,
      "markMethodCallExecutionStarted",
    );
    return {
      accepted: this.calls.markProviderCallExecutionStarted(
        participantId,
        transportCallId,
        providerClaimGeneration,
      ),
    };
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async timeoutMethodCall(callId: string, reason?: string): Promise<void> {
    const pending = await this.calls.cancelMethodCall(
      callId,
      reason ?? "timed out",
    );
    if (!pending) return;
    await this.calls.abortProviderCall(pending);
    // Tell the target agent its call rotted — the caller already got a
    // terminal, but the agent otherwise never learns it failed to respond.
    await this.publishMethodCallFeedback(
      pending.targetId,
      pending.transportCallId,
      pending.method,
      reason ?? "method call deadline expired",
    );
  }

  /** Publish a ui.feedback event targeted at a participant (best effort). */
  private async publishMethodCallFeedback(
    targetId: string,
    transportCallId: string,
    method: string,
    message: string,
  ): Promise<void> {
    try {
      const event: AgenticEvent<"ui.feedback"> = {
        kind: "ui.feedback",
        actor: { kind: "system", id: "channel" },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          target: this.participantRef(targetId),
          to: [{ kind: "participant", participantId: targetId }],
          category: "method_call_failed",
          refs: { callId: transportCallId },
          error: { message: `${method}: ${message}` },
          occurrenceKey: `method_call_failed:${transportCallId}`,
        },
        createdAt: new Date().toISOString(),
      };
      const logged = await this.appendDurable({
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: event,
        senderId: "system",
      });
      broadcast(
        this.broadcastDeps,
        logged,
        { kind: "log", phase: "live" },
        "system",
      );
    } catch (err) {
      console.warn(
        `[Channel] failed to publish method-call feedback for ${transportCallId}:`,
        err,
      );
    }
  }

  /** Convergence sweep for the pending_calls cache (P3 — also an ops hook). */
  async reconcilePendingCalls(
    force = false,
  ): Promise<{ inserted: number; deleted: number }> {
    return this.calls.reconcilePendingCalls(force);
  }

  // ── Alarm — single scheduler over pure next-time sources (WS2 §8.2) ──────

  private nextDedupSweepAt(): number | null {
    const oldest = this.sql
      .exec(`SELECT MIN(created_at) AS oldest FROM dedup_keys`)
      .toArray()[0]?.["oldest"];
    return typeof oldest === "number" ? oldest + DEDUP_TTL_MS : null;
  }

  private nextPresenceTransitionAt(): number | null {
    const row = this.sql
      .exec(
        `SELECT MIN(
           CASE presence_status
             WHEN 'online' THEN last_active_at + ?
             WHEN 'idle' THEN last_active_at + ?
             ELSE NULL
           END
         ) AS next_at
         FROM participants
         WHERE id LIKE 'user:%' AND last_active_at IS NOT NULL`,
        PRESENCE_IDLE_MS,
        PRESENCE_AWAY_MS,
      )
      .toArray()[0]?.["next_at"];
    return typeof row === "number" ? row : null;
  }

  private nextPresenceRetentionSweepAt(): number | null {
    const oldest = this.sql
      .exec(`SELECT MIN(last_seen) AS oldest FROM presence_last_seen`)
      .toArray()[0]?.["oldest"];
    return typeof oldest === "number"
      ? oldest + PRESENCE_LAST_SEEN_RETENTION_MS
      : null;
  }

  private nextInviteIndexSyncAt(): number | null {
    const oldest = this.sql
      .exec(`SELECT MIN(updated_at) AS oldest FROM invite_index_ops`)
      .toArray()[0]?.["oldest"];
    return typeof oldest === "number" ? oldest + INVITE_INDEX_RETRY_MS : null;
  }

  private nextForkOpReconcileAt(): number | null {
    const oldest = this.sql
      .exec(
        `SELECT MIN(updated_at) AS oldest FROM fork_ops
          WHERE phase NOT IN ('done', 'rolledback')`,
      )
      .toArray()[0]?.["oldest"];
    return typeof oldest === "number" ? oldest + FORK_OP_RECONCILE_MS : null;
  }

  private nextLineageHeadReportAt(): number | null {
    const value = this.sql
      .exec(
        `SELECT next_attempt_at FROM lineage_head_outbox
          WHERE singleton = 1
            AND NOT EXISTS (
              SELECT 1 FROM channel_maintenance_queue
               WHERE item_id = ?
            )`,
        `maintenance:lineage-head:${this.objectKey}`,
      )
      .toArray()[0]?.["next_attempt_at"];
    return typeof value === "number" ? value : null;
  }

  private nextAlarmSchedule(): DoAlarmSchedule | null {
    const now = Date.now();
    const sources = [
      this.nextDedupSweepAt(),
      this.nextPresenceTransitionAt(),
      this.nextPresenceRetentionSweepAt(),
      this.nextInviteIndexSyncAt(),
      this.calls.nextCallDeadlineAt(),
      this.nextForkOpReconcileAt(),
      this.nextLineageHeadReportAt(),
      this.nextStructuredDeliveryRecoveryAt(),
      this.nextMaintenanceRecoveryAt(),
      this.nextDurableWorkReadyEdgeAt(),
    ].filter((value): value is number => typeof value === "number");
    return sources.length === 0
      ? null
      : { wakeAt: Math.max(Math.min(...sources), now + 100) };
  }

  protected override nextAlarmAfterRequest(): DoAlarmSchedule | null {
    return this.nextAlarmSchedule();
  }

  override async alarm(): Promise<DoAlarmSchedule | null> {
    await super.alarm();

    if (this.durableWorkReadinessDiagnostics().some((entry) => entry.pending)) {
      const spins = Number(
        this.getStateValue("deliveryReadyEdgeAlarmSpins") ?? 0,
      );
      this.setStateValue("deliveryReadyEdgeAlarmSpins", String(spins + 1));
    }

    // Heal an interrupted append-to-projection window even when no later
    // channel traffic arrives.
    await this.deriveDeliveries();

    this.advancePresenceStatuses();
    this.sql.exec(
      `DELETE FROM presence_last_seen WHERE last_seen < ?`,
      Date.now() - PRESENCE_LAST_SEEN_RETENTION_MS,
    );

    // Dedup TTL sweep — unconditional (no latch; a key inserted while no
    // publish succeeds is still swept).
    this.sql.exec(
      `DELETE FROM dedup_keys WHERE created_at < ?`,
      Date.now() - DEDUP_TTL_MS,
    );

    if (this.durableWorkStatus().readyQueues.length > 0) {
      this.markWorkReady("channel-delivery");
    }

    return this.nextAlarmSchedule();
  }

  private advancePresenceStatuses(): void {
    const now = Date.now();
    const rows = this.sql
      .exec(
        `SELECT id, last_active_at, presence_status FROM participants
          WHERE id LIKE 'user:%' AND last_active_at IS NOT NULL`,
      )
      .toArray();
    for (const row of rows) {
      const participantId = row["id"] as string;
      const lastActiveAt = row["last_active_at"] as number;
      const next = this.presenceStatusAt(lastActiveAt, now);
      if (row["presence_status"] === next) continue;
      this.sql.exec(
        `UPDATE participants SET presence_status = ? WHERE id = ?`,
        next,
        participantId,
      );
      this.broadcastPresenceSignal(participantId, "update", {
        kind: "user",
        presenceStatus: next,
        lastActiveAt,
      });
    }
  }

  // ── Provenance ────────────────────────────────────────────────────────────

  /**
   * The channel's place in the fork/task tree, read from durable state (NOT the
   * old `getState()` dump peek). Fork provenance is written at `postClone`; task
   * provenance at task-channel creation (B1, WS-5) — until that lands a task
   * channel reads as `root`/`fork`.
   */
  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async getProvenance(): Promise<ChannelProvenance> {
    return this.computeProvenance();
  }

  /**
   * Record task provenance for a subagent task channel (B1, WS-5). Written by
   * the spawning vessel right after the task channel is created/subscribed so
   * {@link getProvenance} reports `kind:"task"` instead of `root`. Durable state
   * keys, mirroring how fork provenance is stamped at `postClone`.
   */
  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async recordTaskProvenance(args: {
    parentChannelId: string;
    parentContextId: string;
    runId: string;
  }): Promise<void> {
    this.setStateValue("taskParentChannelId", args.parentChannelId);
    this.setStateValue("taskParentContextId", args.parentContextId);
    this.setStateValue("taskRunId", args.runId);
  }

  /** Fold only the agentic envelopes appended since the last local projection
   * cursor. The GAD log remains authoritative; these rows are a rebuildable
   * index for semantic fork loci and direct-child metadata. */
  private async syncForkView(): Promise<void> {
    const PAGE = 500;
    let afterSeq = Number(
      this.sql
        .exec(
          `SELECT folded_through_seq FROM fork_view_cursor WHERE singleton = 1`,
        )
        .toArray()[0]?.["folded_through_seq"] ?? 0,
    );
    for (;;) {
      const envelopes = await this.channelLog.read({
        afterSeq,
        limit: PAGE,
        payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      });
      if (envelopes.length === 0) return;
      this.ctx.storage.transactionSync(() => {
        for (const envelope of envelopes) {
          this.foldForkMetadataEnvelope(envelope);
          afterSeq = envelope.seq;
        }
        this.sql.exec(
          `UPDATE fork_view_cursor SET folded_through_seq = ? WHERE singleton = 1`,
          afterSeq,
        );
      });
      if (envelopes.length < PAGE) return;
    }
  }

  private foldForkMetadataEnvelope(envelope: LogEnvelope): void {
    const event = envelope.payload as AgenticEvent | null;
    if (!event || typeof event !== "object") return;
    if (
      event.kind === "message.started" ||
      event.kind === "message.completed" ||
      event.kind === "message.failed"
    ) {
      const messageId = event.causality?.messageId;
      if (!messageId) return;
      this.sql.exec(
        `INSERT INTO fork_message_loci
           (message_id, first_seq, terminal_seq, turn_id, actor_kind)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET
           first_seq = MIN(first_seq, excluded.first_seq),
           terminal_seq = COALESCE(excluded.terminal_seq, terminal_seq),
           turn_id = COALESCE(turn_id, excluded.turn_id)`,
        String(messageId),
        envelope.seq,
        event.kind === "message.completed" || event.kind === "message.failed"
          ? envelope.seq
          : null,
        event.turnId ? String(event.turnId) : null,
        event.actor.kind,
      );
      return;
    }
    if (event.kind === "turn.opened" && event.turnId) {
      this.sql.exec(
        `INSERT OR IGNORE INTO fork_turn_loci (turn_id, opened_seq) VALUES (?, ?)`,
        String(event.turnId),
        envelope.seq,
      );
      return;
    }
    if (event.kind === "channel.forked") {
      const payload = (event as AgenticEvent<"channel.forked">).payload;
      if (payload.parentChannelId !== this.objectKey) return;
      this.sql.exec(
        `INSERT INTO fork_projection
           (fork_id, parent_channel_id, forked_channel_id, forked_context_id,
            fork_point_id, label, reason, actor_json, created_at_seq, head_seq, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(fork_id) DO UPDATE SET
           parent_channel_id = excluded.parent_channel_id,
           forked_channel_id = excluded.forked_channel_id,
           forked_context_id = excluded.forked_context_id,
           fork_point_id = excluded.fork_point_id,
           label = excluded.label,
           reason = excluded.reason,
           actor_json = excluded.actor_json,
           created_at_seq = excluded.created_at_seq,
           head_seq = MAX(head_seq, excluded.head_seq)`,
        payload.forkId,
        payload.parentChannelId,
        payload.forkedChannelId,
        payload.forkedContextId,
        payload.forkPointId,
        payload.label,
        payload.reason,
        JSON.stringify(payload.actor),
        envelope.seq,
        payload.headSeq,
      );
      return;
    }
    if (event.kind === "channel.fork_renamed") {
      const payload = (event as AgenticEvent<"channel.fork_renamed">).payload;
      if (payload.parentChannelId !== this.objectKey) return;
      this.sql.exec(
        `UPDATE fork_projection SET label = ? WHERE fork_id = ?`,
        payload.label,
        payload.forkId,
      );
      return;
    }
    if (event.kind === "channel.fork_archived") {
      const payload = (event as AgenticEvent<"channel.fork_archived">).payload;
      if (payload.parentChannelId !== this.objectKey) return;
      this.sql.exec(
        `UPDATE fork_projection SET archived = 1 WHERE fork_id = ?`,
        payload.forkId,
      );
    }
  }

  /** Resolve a client-facing semantic locus to one authoritative log boundary.
   * The resolved request is what the durable saga journals and reuses. */
  private async resolveForkRequest(request: ForkRequest): Promise<ForkOpts> {
    await this.syncForkView();
    let forkPointPubsubId: number;
    let replacementSeq: number | undefined;
    if (request.locus.kind === "head") {
      forkPointPubsubId = await this.channelLog.headSeq();
    } else {
      const rows = this.sql
        .exec(
          `SELECT first_seq, terminal_seq, turn_id FROM fork_message_loci WHERE message_id = ?`,
          request.locus.messageId,
        )
        .toArray();
      const row = rows[0];
      if (!row)
        throw new Error(
          `fork locus message ${request.locus.messageId} was not found`,
        );
      const firstSeq = Number(row["first_seq"]);
      const terminalSeq =
        row["terminal_seq"] === null || row["terminal_seq"] === undefined
          ? undefined
          : Number(row["terminal_seq"]);
      replacementSeq = terminalSeq ?? firstSeq;
      if (request.locus.kind === "after-message") {
        if (terminalSeq === undefined) {
          throw new Error(
            `cannot fork after unfinished message ${request.locus.messageId}`,
          );
        }
        forkPointPubsubId = terminalSeq;
      } else {
        const turnId = row["turn_id"] as string | null;
        const opened = turnId
          ? this.sql
              .exec(
                `SELECT opened_seq FROM fork_turn_loci WHERE turn_id = ?`,
                turnId,
              )
              .toArray()[0]?.["opened_seq"]
          : undefined;
        forkPointPubsubId = Math.max(0, Number(opened ?? firstSeq) - 1);
      }
    }
    if (request.seed?.replaces && request.locus.kind !== "before-message") {
      throw new Error(
        "a replacement seed requires a before-message fork locus",
      );
    }
    const locusMessageId =
      request.locus.kind === "head" ? undefined : request.locus.messageId;
    if (
      request.seed?.replaces &&
      request.seed.replaces.messageId !== locusMessageId
    ) {
      throw new Error(
        "replacement seed and fork locus must identify the same message",
      );
    }
    const { seed: requestedSeed, ...requestWithoutSeed } = request;
    let seed: ResolvedForkSeed | undefined;
    if (requestedSeed) {
      const { replaces, ...seedWithoutReplacement } = requestedSeed;
      seed = replaces
        ? {
            ...seedWithoutReplacement,
            author: this.participantRef(this.rpcCallerId ?? "system"),
            replaces: { messageId: replaces.messageId, seq: replacementSeq! },
          }
        : {
            ...seedWithoutReplacement,
            author: this.participantRef(this.rpcCallerId ?? "system"),
          };
    }
    return {
      ...requestWithoutSeed,
      request,
      forkPointPubsubId,
      ...(seed ? { seed } : {}),
    };
  }

  private computeProvenance(): ChannelProvenance {
    const taskParent = this.getStateValue("taskParentChannelId");
    if (taskParent) {
      return {
        kind: "task",
        parentChannelId: taskParent,
        parentContextId: this.getStateValue("taskParentContextId") ?? "",
        runId: this.getStateValue("taskRunId") ?? "",
      };
    }
    const forkedFrom = this.getStateValue("forkedFrom");
    if (forkedFrom) {
      return {
        kind: "fork",
        forkedFrom,
        parentContextId: this.getStateValue("forkedFromContextId") ?? "",
        forkPointId: Number(this.getStateValue("forkPointId") ?? 0),
        rootChannelId: this.getStateValue("rootChannelId") ?? forkedFrom,
      };
    }
    return { kind: "root" };
  }

  // ── Fork operation (durable, journaled, owned by THIS parent channel) ──────
  //
  // The op's durability lives in `fork_ops`: the row is journaled BEFORE any
  // host/DO call and its `phase` advances after each idempotent step. Order:
  //   journal → clone (targetKey=`fork:{forkId}`) → postClones → appendSeed →
  //   channel.forked → done.
  // Every phase is idempotent (deterministic clone targetKey + deterministic
  // envelopeIds `fork-seed:{forkId}` / `fork-event:{forkId}`), so callers can
  // safely retry the operation.

  /** Thin host-call wrapper (the DO drives runtime.cloneContext/destroyContext).
   *  Host runtime services take exactly ONE opts object, positional. */
  private callMain<T>(method: string, arg: unknown): Promise<T> {
    return this.rpc.call<T>("main", method, [arg]);
  }

  /** Resolve a sibling channel's DO ref (fork parent / lineage forwarding). */
  private async resolveChannelRef(channelId: string): Promise<DORef> {
    const svc = await this.rpc.call<DORef>("main", "workers.resolveService", [
      CHANNEL_SERVICE_PROTOCOL,
      channelId,
    ]);
    return {
      source: svc.source,
      className: svc.className,
      objectKey: svc.objectKey,
    };
  }

  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async fork(request: ForkRequest): Promise<ForkResult> {
    const forkId = request.operationId;
    if (typeof forkId !== "string" || forkId.length < 8) {
      throw new Error("fork requires a stable operationId");
    }
    const existing = this.getForkOpRow(forkId);
    if (existing) {
      const recorded = JSON.parse(String(existing["opts"])) as ForkOpts;
      if (canonicalJson(recorded.request) !== canonicalJson(request)) {
        throw new Error(
          `fork operation ${forkId} was reused with different input`,
        );
      }
      if (existing["phase"] === "rollback-pending") {
        await this.rollbackForkOp(forkId);
        throw new Error(
          `fork operation ${forkId} failed and its cloned context was cleaned up`,
        );
      }
      if (existing["phase"] === "rolledback") {
        throw new Error(
          `fork operation ${forkId} previously failed and was rolled back`,
        );
      }
      if (
        existing["phase"] === "done" &&
        typeof existing["result_json"] === "string"
      ) {
        return JSON.parse(existing["result_json"] as string) as ForkResult;
      }
      return this.runForkOp(forkId);
    }
    const opts = await this.resolveForkRequest(request);
    const now = Date.now();
    // Journal FIRST — before any host/DO call — so a crash is always recoverable.
    this.sql.exec(
      `INSERT INTO fork_ops (fork_id, fork_point_id, opts, phase, created_at, updated_at)
         VALUES (?, ?, ?, 'journaled', ?, ?)`,
      forkId,
      opts.forkPointPubsubId,
      canonicalJson(opts),
      now,
      now,
    );
    return this.runForkOp(forkId);
  }

  private getForkOpRow(forkId: string): Record<string, unknown> | null {
    const rows = this.sql
      .exec(`SELECT * FROM fork_ops WHERE fork_id = ?`, forkId)
      .toArray();
    return rows.length > 0 ? (rows[0] as Record<string, unknown>) : null;
  }

  private setForkOpPhase(
    forkId: string,
    phase: ForkPhase,
    fields?: { forkedChannelId?: string; forkedContextId?: string },
  ): void {
    this.sql.exec(
      `UPDATE fork_ops SET phase = ?,
         forked_channel_id = COALESCE(?, forked_channel_id),
         forked_context_id = COALESCE(?, forked_context_id),
         updated_at = ?
       WHERE fork_id = ?`,
      phase,
      fields?.forkedChannelId ?? null,
      fields?.forkedContextId ?? null,
      Date.now(),
      forkId,
    );
  }

  /** Drive an interrupted/fresh fork op from its recorded phase to `done`,
   *  rolling back on unrecoverable failure. Idempotent under retry. */
  private async runForkOp(forkId: string): Promise<ForkResult> {
    const row = this.getForkOpRow(forkId);
    if (!row) throw new Error(`fork op ${forkId} not found`);
    const phase = row["phase"] as string;
    const opts = JSON.parse(row["opts"] as string) as ForkOpts;

    const sourceContextId = this.getStateValue("contextId");
    if (!sourceContextId)
      throw new Error(`Channel ${this.objectKey} has no contextId`);

    // Classify the (stable) parent roster: forkable = agent vessels with a doRef,
    // scoped by opts.include when given (C7 entity scope).
    const includeScope = opts.include ? new Set(opts.include) : null;
    const selfRef = await this.resolveChannelRef(this.objectKey);
    const keptAgents: Array<{ participantId: string; ref: DORef }> = [];
    for (const p of await this.getParticipants()) {
      const relationship = this.deliveryProjection.relationship(
        p.participantId,
      );
      if (
        !relationship?.active ||
        relationship.endpointKind !== "entity" ||
        !p.doRef
      )
        continue;
      if (includeScope && !includeScope.has(doTarget(p.doRef))) continue;
      keptAgents.push({ participantId: p.participantId, ref: p.doRef });
    }
    console.info("[Channel] fork op starting", {
      forkId,
      phase,
      channelId: this.objectKey,
      sourceContextId,
      forkPointPubsubId: opts.forkPointPubsubId,
      keptAgentCount: keptAgents.length,
      keptAgents: keptAgents.map((agent) => ({
        participantId: agent.participantId,
        target: doTarget(agent.ref),
      })),
    });

    try {
      // Preflight canFork on the kept agents (WS-5 per-channel shape).
      for (const agent of keptAgents) {
        const r = await this.rpc.call<{ ok: boolean; reason?: string }>(
          doTarget(agent.ref),
          "canFork",
          [this.objectKey],
        );
        if (!r.ok) {
          throw new Error(
            `Cannot fork participant ${agent.participantId}: ${r.reason ?? "canFork=false"}`,
          );
        }
      }

      // 1. CLONE — idempotent via targetKey; a resumed op gets the SAME child.
      //    Recursive so a live-subagent context clones its lifecycle subtree in
      //    full (include scopes the ROOT context only); lineage edges are never
      //    followed.
      const include = [
        doTarget(selfRef),
        ...keptAgents.map((a) => doTarget(a.ref)),
      ];
      const clone = await this.callMain<CloneContextResultView>(
        "runtime.cloneContext",
        {
          sourceContextId,
          include,
          recursive: true,
          targetKey: `fork:${forkId}`,
        },
      );
      const findClone = (ref: DORef): ClonedEntityView => {
        const id = doTarget(ref);
        const entity = clone.entities.find((e) => e.sourceId === id);
        if (!entity) throw new Error(`cloneContext did not clone ${id}`);
        return entity;
      };
      const channelClone = findClone(selfRef);
      const forkedChannelId = channelClone.newKey;
      const forkedContextId = clone.contextId;
      const forkedChannelRef: DORef = {
        source: channelClone.source,
        className: channelClone.className!,
        objectKey: forkedChannelId,
      };
      const homeableTargets = clone.entities.map((e) => e.sourceId);
      console.info("[Channel] fork op cloned context", {
        forkId,
        sourceChannelId: this.objectKey,
        forkedChannelId,
        forkedContextId,
        clonedEntityCount: clone.entities.length,
        homeableTargets,
      });
      if (!forkPhaseReached(phase, "cloned")) {
        this.setForkOpPhase(forkId, "cloned", {
          forkedChannelId,
          forkedContextId,
        });
      }

      const clonedAgents: Array<{ participantId: string } & DORef> = [];
      const clonedParticipants: string[] = [];

      // 2. POSTCLONES — re-root the cloned channel's log at the fork point, hand
      //    it its provenance + pending seed marker, then re-home each
      //    cloned agent. Skipped on a resume that already passed this phase.
      const parentProvenance = this.computeProvenance();
      const rootChannelId =
        parentProvenance.kind === "fork"
          ? parentProvenance.rootChannelId
          : this.objectKey;
      if (!forkPhaseReached(phase, "postcloned")) {
        await this.rpc.call(doTarget(forkedChannelRef), "postClone", [
          this.objectKey,
          opts.forkPointPubsubId,
          forkedContextId,
          {
            forkId,
            rootChannelId,
            ...(opts.seed ? { seed: opts.seed } : {}),
            homeableTargets,
          },
        ]);
        for (const agent of keptAgents) {
          const ce = findClone(agent.ref);
          const clonedRef: DORef = {
            source: ce.source,
            className: ce.className!,
            objectKey: ce.newKey,
          };
          // cloneContext creates an unbound entity deliberately: the child
          // channel identity does not exist until the channel clone is known.
          // Commit the host-authenticated binding before the clone subscribes,
          // so its first delivery cannot run with split host/local identity.
          await this.callMain("runtime.rebindAgentChannel", {
            entityId: ce.newId,
            channelId: forkedChannelId,
          });
          await this.rpc.call(doTarget(clonedRef), "postClone", [
            agent.ref.objectKey,
            forkedChannelId,
            this.objectKey,
            opts.forkPointPubsubId,
            forkedContextId,
          ]);
          clonedParticipants.push(agent.participantId);
          clonedAgents.push({
            participantId: agent.participantId,
            ...clonedRef,
          });
        }
        this.setForkOpPhase(forkId, "postcloned");
        console.info("[Channel] fork op postClone complete", {
          forkId,
          forkedChannelId,
          forkedContextId,
          clonedParticipants,
        });
      } else {
        for (const agent of keptAgents) {
          const ce = findClone(agent.ref);
          clonedParticipants.push(agent.participantId);
          clonedAgents.push({
            participantId: agent.participantId,
            source: ce.source,
            className: ce.className!,
            objectKey: ce.newKey,
          });
        }
      }

      // 3. SEED — append the fork opening message on the child.
      let seededMessageId: string | undefined;
      if (opts.seed) {
        seededMessageId = `fork-seed:${forkId}`;
        if (!forkPhaseReached(phase, "seeded")) {
          await this.rpc.call(doTarget(forkedChannelRef), "appendSeed", [
            { forkId },
          ]);
        }
      }
      if (!forkPhaseReached(phase, "seeded"))
        this.setForkOpPhase(forkId, "seeded");

      // 4. ANNOUNCE — channel.forked on THIS (parent) log; the parent's `forks`
      //    projection enumerates its direct children.
      if (!forkPhaseReached(phase, "announced")) {
        await this.appendForkEvent(forkId, opts, {
          forkedChannelId,
          forkedContextId,
          rootChannelId,
          seededMessageId,
        });
        this.setForkOpPhase(forkId, "announced");
      }

      const result: ForkResult = {
        forkId,
        forkedChannelId,
        forkedContextId,
        clonedParticipants,
        clonedAgents,
        ...(seededMessageId ? { seededMessageId } : {}),
      };
      this.sql.exec(
        `UPDATE fork_ops SET phase = 'done', result_json = ?, updated_at = ? WHERE fork_id = ?`,
        canonicalJson(result),
        Date.now(),
        forkId,
      );
      console.info("[Channel] fork op done", {
        forkId,
        sourceChannelId: this.objectKey,
        forkedChannelId,
        forkedContextId,
        seededMessageId,
        clonedParticipants,
      });
      return result;
    } catch (err) {
      console.error("[Channel] fork op failed; rolling back", {
        forkId,
        channelId: this.objectKey,
        phase,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.rollbackForkOp(forkId);
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Fork failed: ${message}`);
    }
  }

  /** Tear down a failed fork. Cleanup failure is itself durable and retryable;
   * the operation becomes terminal only after context destruction succeeds. */
  private async rollbackForkOp(forkId: string): Promise<boolean> {
    const row = this.getForkOpRow(forkId);
    const forkedContextId = row?.["forked_context_id"] as
      | string
      | null
      | undefined;
    if (forkedContextId) {
      try {
        await this.callMain("runtime.destroyContext", {
          contextId: forkedContextId,
        });
      } catch (e) {
        console.error(
          `[Channel] fork rollback destroyContext failed for ${forkedContextId}:`,
          e,
        );
        this.setForkOpPhase(forkId, "rollback-pending");
        return false;
      }
    }
    this.setForkOpPhase(forkId, "rolledback");
    return true;
  }

  /** Append the durable `channel.forked` event to the parent log (this channel).
   *  Deterministic envelopeId makes a reconcile re-append a no-op. */
  private async appendForkEvent(
    forkId: string,
    opts: ForkOpts,
    fork: {
      forkedChannelId: string;
      forkedContextId: string;
      rootChannelId: string;
      seededMessageId?: string;
    },
  ): Promise<void> {
    void fork.rootChannelId;
    const actor =
      opts.seed?.author ?? this.participantRef(this.rpcCallerId ?? "system");
    const event: AgenticEvent<"channel.forked"> = {
      kind: "channel.forked",
      actor,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        forkId,
        parentChannelId: this.objectKey,
        forkedChannelId: fork.forkedChannelId,
        forkedContextId: fork.forkedContextId,
        forkPointId: opts.forkPointPubsubId,
        headSeq: opts.forkPointPubsubId + (opts.seed ? 1 : 0),
        label: opts.label ?? opts.reason,
        reason: opts.reason,
        actor,
        ...(fork.seededMessageId
          ? { seededMessageId: fork.seededMessageId }
          : {}),
      },
      createdAt: new Date().toISOString(),
    };
    const logged = await this.appendDurable({
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: event,
      senderId: "system",
      messageId: `fork-event:${forkId}`,
      idempotency: "idempotent-by-id",
    });
    broadcast(
      this.broadcastDeps,
      logged,
      { kind: "log", phase: "live" },
      "system",
    );
  }

  /** Rename a direct child fork (durable `channel.fork_renamed` on this log). */
  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async renameFork(forkId: string, label: string): Promise<void> {
    await this.assertDirectFork(forkId);
    const normalizedLabel = label.trim();
    if (!normalizedLabel)
      throw new Error("renameFork requires a non-empty label");
    const event: AgenticEvent<"channel.fork_renamed"> = {
      kind: "channel.fork_renamed",
      actor: this.participantRef(this.rpcCallerId ?? "system"),
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        parentChannelId: this.objectKey,
        forkId,
        label: normalizedLabel,
      },
      createdAt: new Date().toISOString(),
    };
    const logged = await this.appendDurable({
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: event,
      senderId: "system",
    });
    broadcast(
      this.broadcastDeps,
      logged,
      { kind: "log", phase: "live" },
      "system",
    );
  }

  /** Archive a direct child fork (durable `channel.fork_archived` latch). */
  @rpc({
    principals: ["host", "code"],
    effect: {
      kind: "userland-capability",
      capability: "channel.archive",
      resource: { kind: "receiver-object" },
    },
    tier: "critical",
    sensitivity: "destructive",
  })
  async archiveFork(forkId: string): Promise<void> {
    await this.assertDirectFork(forkId);
    const event: AgenticEvent<"channel.fork_archived"> = {
      kind: "channel.fork_archived",
      actor: this.participantRef(this.rpcCallerId ?? "system"),
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        parentChannelId: this.objectKey,
        forkId,
      },
      createdAt: new Date().toISOString(),
    };
    const logged = await this.appendDurable({
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: event,
      senderId: "system",
    });
    broadcast(
      this.broadcastDeps,
      logged,
      { kind: "log", phase: "live" },
      "system",
    );
  }

  private async assertDirectFork(forkId: string): Promise<void> {
    await this.syncForkView();
    const exists =
      this.sql
        .exec(`SELECT 1 FROM fork_projection WHERE fork_id = ?`, forkId)
        .toArray().length > 0;
    if (!exists)
      throw new Error(
        `fork ${forkId} is not a direct child of channel ${this.objectKey}`,
      );
  }

  /**
   * List the DIRECT-CHILD forks rooted off THIS channel — folded from this
   * channel's incremental log-derived projection. It folds only envelopes
   * newer than the local cursor, then returns O(fork count) metadata plus the
   * current durable head. Archived forks remain available to administrative
   * callers; active UI surfaces filter them.
   */
  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async listForks(): Promise<{ forks: ForkProjection[]; headSeq: number }> {
    await this.syncForkView();
    let forks = this.sql
      .exec(`SELECT * FROM fork_projection ORDER BY created_at_seq ASC`)
      .toArray()
      .map(
        (row) =>
          ({
            parentChannelId: String(row["parent_channel_id"]),
            forkId: String(row["fork_id"]),
            forkedChannelId: String(row["forked_channel_id"]),
            forkedContextId: String(row["forked_context_id"]),
            forkPointId: Number(row["fork_point_id"]),
            label: String(row["label"]),
            reason: String(row["reason"]),
            actor: JSON.parse(String(row["actor_json"])) as ParticipantRef,
            createdAtSeq: Number(row["created_at_seq"]),
            headSeq: Number(row["head_seq"]),
            archived: Number(row["archived"]) === 1,
          }) satisfies ForkProjection,
      );
    const channelIds = forks.map((fork) => fork.forkedChannelId);
    if (channelIds.length > 0) {
      const provenance = this.computeProvenance();
      let heads: Record<string, number>;
      if (provenance.kind === "fork") {
        const rootRef = await this.resolveChannelRef(provenance.rootChannelId);
        heads = await this.rpc.call<Record<string, number>>(
          doTarget(rootRef),
          "getLineageHeads",
          [channelIds],
        );
      } else {
        heads = await this.getLineageHeads(channelIds);
      }
      forks = forks.map((fork) => ({
        ...fork,
        headSeq: Math.max(fork.headSeq, heads[fork.forkedChannelId] ?? 0),
      }));
    }
    return { forks, headSeq: await this.channelLog.headSeq() };
  }

  // ── appendSeed — fork opening message ──────────────────────────────────────

  /**
   * Append the fork's opening message on the CHILD channel. This is fork
   * plumbing: the pending fork marker only makes the operation one-shot and
   * crash-resumable for the matching fork id.
   */
  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async appendSeed(forkOpRef: {
    forkId: string;
  }): Promise<{ messageId: string; seq: number }> {
    const forkId = forkOpRef.forkId;
    const messageId = `fork-seed:${forkId}`;
    const marker = this.readForkSeedMarker();
    if (!marker || marker.forkId !== forkId) {
      throw new Error(
        `appendSeed: no pending fork seed for fork ${forkId} on this channel`,
      );
    }
    const parentRef = await this.resolveChannelRef(marker.parentChannelId);
    const caller = this.caller;
    if (
      caller?.callerKind !== "do" ||
      caller.callerId !== doTarget(parentRef)
    ) {
      throw new Error(
        "appendSeed may only be called by the recorded parent channel",
      );
    }
    // Authorize before returning an idempotent result: possession of a fork id
    // is not authority to learn or complete another parent's seed operation.
    const existing = await this.channelLog.getEventByEnvelopeId(messageId);
    if (existing) return { messageId, seq: existing.id };

    const envelope = marker.seed;
    const author = envelope.author;
    const seedEvent: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: author,
      causality: { messageId: messageId as never },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "user",
        blocks: envelope.blocks,
        outcome: "completed",
        tier: "primary",
        ...(envelope.replaces
          ? {
              replaces: {
                messageId: envelope.replaces.messageId as never,
                seq: envelope.replaces.seq,
              },
            }
          : {}),
      },
      createdAt: new Date().toISOString(),
    };
    const logged = await this.appendDurable({
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: seedEvent,
      senderId: author.participantId ?? author.id,
      senderMetadata: author.metadata,
      messageId,
      idempotency: "idempotent-by-id",
    });
    broadcast(
      this.broadcastDeps,
      logged,
      { kind: "log", phase: "live" },
      logged.senderId,
    );
    return { messageId, seq: logged.id };
  }

  private readForkSeedMarker(): ForkSeedMarker | null {
    const raw = this.getStateValue("forkSeedMarker");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ForkSeedMarker;
    } catch {
      return null;
    }
  }

  // ── Fork support ────────────────────────────────────────────────────────

  /**
   * Called after cloneDO() copies the parent's SQLite. Forks the durable
   * channel log (no-copy), clears operational state, and REBUILDS the policy
   * caches by replaying the forked lineage — conversation state survives the
   * fork (WS2 §4.5). Also lands the clone's fork provenance + pending seed
   * marker from the parent fork op (`forkInit`).
   */
  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async postClone(
    parentChannelId: string,
    forkPointId: number,
    // The clone's new context. A true context fork (`runtime.cloneContext`) lands
    // the clone in a fresh, isolated context; thread it so the channel's stored
    // contextId re-homes (matching the clone's entity record).
    newContextId: string,
    // Provenance + seed marker from the parent fork op. `rootChannelId`
    // roots the lineage tree; `seed` records that one `appendSeed` is pending;
    // `homeableTargets` are the cloned entity ids — a pending call whose target is
    // NOT among them could not follow the fork and is settled `aborted-by-fork` (C6).
    forkInit?: {
      forkId: string;
      rootChannelId: string;
      seed?: ResolvedForkSeed;
      homeableTargets?: string[];
    },
  ): Promise<void> {
    if (!newContextId) throw new Error("postClone requires newContextId");
    // Fix identity: cloneDO copies parent's __objectKey; overwrite with our actual key
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES ('__objectKey', ?)`,
      this.objectKey,
    );
    const parentContextId = this.getStateValue("contextId");
    if (parentContextId)
      this.setStateValue("forkedFromContextId", parentContextId);
    // Re-home the context (bypasses initChannel's mismatch guard by writing the
    // state row directly because clone provisioning owns the new context).
    this.setStateValue("contextId", newContextId);
    this.setStateValue("forkedFrom", parentChannelId);
    this.setStateValue("forkPointId", String(forkPointId));
    if (forkInit) {
      this.setStateValue("rootChannelId", forkInit.rootChannelId);
      this.setStateValue("forkId", forkInit.forkId);
      if (forkInit.seed) {
        this.setStateValue(
          "forkSeedMarker",
          JSON.stringify({
            forkId: forkInit.forkId,
            parentChannelId,
            seed: forkInit.seed,
          } satisfies ForkSeedMarker),
        );
      }
    }
    await this.channelLog.forkFrom(parentChannelId, forkPointId);
    this.deliveryProjection.resetForFork(forkPointId);
    // The child must NOT inherit the parent's fork journal or direct-child
    // projection. Its semantic locus index retains only the inherited prefix.
    this.sql.exec(`DELETE FROM fork_ops`);
    this.sql.exec(`DELETE FROM fork_projection`);
    this.sql.exec(`DELETE FROM lineage_head_outbox`);
    this.sql.exec(`DELETE FROM lineage_heads`);
    this.sql.exec(
      `DELETE FROM fork_message_loci WHERE first_seq > ?`,
      forkPointId,
    );
    this.sql.exec(
      `UPDATE fork_message_loci SET terminal_seq = NULL
       WHERE terminal_seq IS NOT NULL AND terminal_seq > ?`,
      forkPointId,
    );
    this.sql.exec(
      `DELETE FROM fork_turn_loci WHERE opened_seq > ?`,
      forkPointId,
    );
    this.sql.exec(
      `UPDATE fork_view_cursor SET folded_through_seq = ? WHERE singleton = 1`,
      forkPointId,
    );
    // A cloned operation was authored for the parent's object key. Membership
    // may be inherited, but its in-flight projection must never be replayed as
    // a new pending invite for the child channel.
    this.sql.exec(`DELETE FROM invite_index_ops`);
    // Clear operational state + caches
    this.sql.exec(`DELETE FROM participants`);
    this.invalidateBroadcastParticipants();
    this.sql.exec(`DELETE FROM pending_calls`);
    this.sql.exec(`DELETE FROM provider_call_claims`);
    this.sql.exec(`DELETE FROM channel_delivery_latency_histogram`);
    this.deleteStateValue("deliveryReadyEdgeAlarmSpins");
    this.sql.exec(`DELETE FROM dedup_keys`);
    await this.policyHost.rebuildAfterFork();
    // Rebuild pending_calls for any started-without-terminal in the inherited
    // prefix (they will be abandoned/redelivered by normal roster flow).
    await this.calls.reconcilePendingCalls(true);
    // Settle calls that could not follow the fork (target not cloned) —
    // aborted-by-fork rather than left hanging until deadline (C6).
    if (forkInit?.homeableTargets) {
      await this.settleUnhomeablePendingCalls(
        new Set(forkInit.homeableTargets),
      );
    }
  }

  private async settleUnhomeablePendingCalls(
    homeable: Set<string>,
  ): Promise<void> {
    const targets = new Set<string>();
    for (const row of this.sql
      .exec(`SELECT DISTINCT target_id FROM pending_calls`)
      .toArray()) {
      targets.add(String((row as Record<string, unknown>)["target_id"]));
    }
    for (const targetId of targets) {
      if (homeable.has(targetId)) continue;
      await this.calls.failPendingCallsTargeting(targetId, "aborted-by-fork");
    }
  }

  // ── Lineage subscriptions + fork.head_changed hub ─────────────────────────
  //
  // The subscription RESPONSE is the live resource. There is no durable roster
  // of dead clients: cancellation or DO eviction releases every stream. Heads,
  // by contrast, are durable and coalesced through each fork's outbox directly
  // to the root, so reconnecting clients can reconcile without replaying logs.

  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async subscribeLineage(participantId: string): Promise<Response> {
    if (!this.isAuthorizedParticipantCaller(participantId)) {
      const caller = this.caller;
      throw new Error(
        `Participant ${participantId} cannot subscribe to lineage by caller ${caller?.callerId ?? "unknown"}`,
      );
    }
    const deliveryId = this.caller?.callerPanelId ?? this.caller?.callerId;
    if (!deliveryId)
      throw new Error("subscribeLineage requires an authenticated delivery id");
    const key = this.subscriptionStreamKey(participantId, deliveryId);
    const token = Symbol(key);
    const prior = this.lineageSubscriptionStreams.get(key);
    if (prior) {
      this.lineageSubscriptionStreams.delete(key);
      try {
        prior.controller.close();
      } catch {
        // Already terminal.
      }
    }
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.lineageSubscriptionStreams.set(key, {
            participantId,
            deliveryId,
            token,
            controller,
          });
          enqueueChannelSubscriptionBytes(
            controller,
            encodeChannelSubscriptionRecord({
              kind: "subscribed",
              result: { ok: true, rootChannelId: this.objectKey },
            }),
          );
        },
        cancel: () => {
          const current = this.lineageSubscriptionStreams.get(key);
          if (current?.token === token)
            this.lineageSubscriptionStreams.delete(key);
        },
      },
      channelSubscriptionQueuingStrategy(),
    );
    return new Response(body, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store",
      },
    });
  }

  /** Root endpoint for a coalesced head advance reported by the exact channel. */
  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async reportLineageHead(report: {
    channelId: string;
    headSeq: number;
    rosterChanged?: boolean;
  }): Promise<void> {
    if (!Number.isSafeInteger(report.headSeq) || report.headSeq < 0) {
      throw new Error("reportLineageHead requires a non-negative safe headSeq");
    }
    if (this.computeProvenance().kind === "fork") {
      throw new Error(
        "reportLineageHead must be sent directly to the lineage root",
      );
    }
    const channelRef = await this.resolveChannelRef(report.channelId);
    const caller = this.caller;
    if (
      caller?.callerKind !== "do" ||
      caller.callerId !== doTarget(channelRef)
    ) {
      throw new Error(
        "reportLineageHead caller does not match the reported channel",
      );
    }
    const reportedProvenance = await this.rpc.call<ChannelProvenance>(
      doTarget(channelRef),
      "getProvenance",
      [],
    );
    if (
      reportedProvenance.kind !== "fork" ||
      reportedProvenance.rootChannelId !== this.objectKey
    ) {
      throw new Error("reported channel does not belong to this lineage root");
    }
    this.recordLineageHead(
      report.channelId,
      report.headSeq,
      report.rosterChanged === true,
    );
  }

  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async getLineageHeads(channelIds: string[]): Promise<Record<string, number>> {
    if (this.computeProvenance().kind === "fork") {
      throw new Error("getLineageHeads must be read from the lineage root");
    }
    const unique = [...new Set(channelIds)];
    if (unique.length > 500)
      throw new Error("getLineageHeads accepts at most 500 channels");
    const heads: Record<string, number> = {};
    for (const channelId of unique) {
      const value = this.sql
        .exec(
          `SELECT head_seq FROM lineage_heads WHERE channel_id = ?`,
          channelId,
        )
        .toArray()[0]?.["head_seq"];
      if (typeof value === "number") heads[channelId] = value;
    }
    return heads;
  }

  /** Coalesce a local durable head advance; roots can publish immediately. */
  private noteLineageHeadAdvance(seq: number, rosterChanged = false): void {
    const provenance = this.computeProvenance();
    if (provenance.kind !== "fork") {
      this.recordLineageHead(this.objectKey, seq, rosterChanged);
      return;
    }
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO lineage_head_outbox
         (singleton, head_seq, roster_changed, next_attempt_at, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         head_seq = MAX(head_seq, excluded.head_seq),
         roster_changed = MAX(roster_changed, excluded.roster_changed),
         next_attempt_at = MIN(next_attempt_at, excluded.next_attempt_at),
         updated_at = excluded.updated_at`,
      seq,
      rosterChanged ? 1 : 0,
      now + LINEAGE_HEAD_COALESCE_MS,
      now,
    );
  }

  private async flushLineageHeadOutbox(): Promise<void> {
    const row = this.sql
      .exec(
        `SELECT head_seq, roster_changed FROM lineage_head_outbox WHERE singleton = 1`,
      )
      .toArray()[0];
    if (!row) return;
    const provenance = this.computeProvenance();
    if (provenance.kind !== "fork") {
      this.sql.exec(`DELETE FROM lineage_head_outbox WHERE singleton = 1`);
      return;
    }
    const headSeq = Number(row["head_seq"]);
    const rosterChanged = Number(row["roster_changed"]) === 1;
    const rootRef = await this.resolveChannelRef(provenance.rootChannelId);
    await this.rpc.call(doTarget(rootRef), "reportLineageHead", [
      {
        channelId: this.objectKey,
        headSeq,
        ...(rosterChanged ? { rosterChanged: true } : {}),
      },
    ]);
    this.sql.exec(
      `DELETE FROM lineage_head_outbox WHERE singleton = 1 AND head_seq <= ?`,
      headSeq,
    );
  }

  private recordLineageHead(
    originChannelId: string,
    headSeq: number,
    rosterChanged = false,
  ): void {
    const prior = this.sql
      .exec(
        `SELECT head_seq FROM lineage_heads WHERE channel_id = ?`,
        originChannelId,
      )
      .toArray()[0]?.["head_seq"];
    if (typeof prior === "number" && prior >= headSeq) return;
    this.sql.exec(
      `INSERT INTO lineage_heads (channel_id, head_seq, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET
         head_seq = MAX(head_seq, excluded.head_seq),
         updated_at = excluded.updated_at`,
      originChannelId,
      headSeq,
      Date.now(),
    );
    this.fanoutLineageHead(originChannelId, headSeq, rosterChanged);
  }

  private fanoutLineageHead(
    originChannelId: string,
    headSeq: number,
    rosterChanged: boolean,
  ): void {
    if (this.lineageSubscriptionStreams.size === 0) return;
    const event = buildChannelEvent(
      0,
      `linsig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      "signal",
      JSON.stringify({
        content: JSON.stringify({
          channelId: originChannelId,
          headSeq,
          ...(rosterChanged ? { rosterChanged: true } : {}),
        }),
        contentType: FORK_HEAD_CHANGED_SIGNAL,
      }),
      "system",
      undefined,
      Date.now(),
    );
    const signal = channelEventToRpcSignal(event);
    const bytes = encodeChannelSubscriptionRecord({
      kind: "message",
      payload: signal,
    });
    for (const [key, stream] of [...this.lineageSubscriptionStreams]) {
      try {
        if (
          enqueueChannelSubscriptionBytes(stream.controller, bytes) ===
          "enqueued"
        )
          continue;
      } catch {
        // Close below.
      }
      this.lineageSubscriptionStreams.delete(key);
      try {
        stream.controller.error(
          new Error("Lineage subscription buffer is full"),
        );
      } catch {
        // Already terminal.
      }
    }
  }

  // ── State introspection ─────────────────────────────────────────────────

  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  override async getState(): Promise<Record<string, unknown>> {
    const replay = await this.channelLog.replayInitial(
      1,
      this.currentReplayContext(),
    );
    const headSequence = await this.channelLog.headSeq();
    const participants = this.sql.exec(`SELECT * FROM participants`).toArray();
    const pendingCalls = this.sql.exec(`SELECT * FROM pending_calls`).toArray();
    const state = this.sql.exec(`SELECT * FROM state`).toArray();
    return {
      envelopeCount: replay.ready.envelopeCount,
      participants,
      pendingCalls,
      state,
      delivery: this.deliveryProjection.diagnostics(headSequence),
      deliveryLifecycle: {
        readiness: this.durableWorkReadinessDiagnostics(),
        readyEdgeAlarmSpins: Number(
          this.getStateValue("deliveryReadyEdgeAlarmSpins") ?? 0,
        ),
        pendingCalls: pendingCalls.length,
        providerClaims: Number(
          this.sql
            .exec(`SELECT COUNT(*) AS count FROM provider_call_claims`)
            .toArray()[0]?.["count"] ?? 0,
        ),
        pendingCallsWithDurableTerminal: (
          await Promise.all(
            pendingCalls.map(async (row) =>
              Boolean(
                await this.channelLog.getEventByEnvelopeId(
                  `terminal:${String(row["transport_call_id"])}`,
                ),
              ),
            ),
          )
        ).filter(Boolean).length,
        latencyHistogram: this.sql
          .exec(
            `SELECT metric, upper_bound_ms, samples, total_ms, maximum_ms
               FROM channel_delivery_latency_histogram
              ORDER BY metric, upper_bound_ms`,
          )
          .toArray(),
      },
      liveTransport: {
        count: this.subscriptionStreams.size,
        streams: [...this.subscriptionStreams.values()].map((stream) => ({
          kind: "external-session",
          participantId: stream.participantId,
          deliveryId: stream.deliveryId,
          subscriptionId: stream.subscriptionId,
          openedAt: stream.openedAt,
          ageMs: Math.max(0, Date.now() - stream.openedAt),
        })),
      },
    };
  }
}

export type { PendingCallRow };
