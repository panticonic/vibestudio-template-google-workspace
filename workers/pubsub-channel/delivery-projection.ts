import {
  canonicalJson,
  sha256HexSyncText,
} from "@vibestudio/content-addressing";
import type { SqlStorage } from "@workspace/runtime/worker";
import type { ChannelEvent } from "@workspace/pubsub";
import type {
  ChannelAgenticContext,
  ChannelConfig,
  RpcChannelMessage,
} from "@workspace/pubsub";
import type { AgenticEvent } from "@workspace/agentic-protocol";
import {
  conversationV1Policy,
  type ConversationStateV1,
  type PolicyEnvelopeView,
} from "@workspace/channel-policies";
import type { ChannelRelationshipPayload } from "./types.js";

export const CHANNEL_DELIVERY_PROJECTION_VERSION = 11;
export const CHANNEL_RELATIONSHIP_EVENT_TYPES = new Set([
  "channel.subscription.opened",
  "channel.subscription.revised",
  "channel.subscription.detached",
  "channel.subscription.ended",
]);

type DeliveryInterest = "all" | "addressed" | "none";

interface RelationshipRow {
  participantId: string;
  revision: number;
  delivery: DeliveryInterest;
  endpointEntityId: string | null;
  endpointKind: "entity" | "session";
  invocationRoute: "direct" | "mailbox" | null;
  active: boolean;
  attached: boolean;
  detachedAtSequence: number | null;
  reattachAfterSequence: number | null;
  reattachThroughSequence: number | null;
}

export class ChannelDeliveryProjection {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: <T>(callback: () => T) => T,
    private readonly channelId: string,
    private readonly durableForkBoundary: () => number | null = () => null,
  ) {}

  static createTables(sql: SqlStorage): void {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_relationships (
        participant_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision > 0),
        delivery TEXT NOT NULL CHECK (delivery IN ('all', 'addressed', 'none')),
        endpoint_kind TEXT NOT NULL CHECK (endpoint_kind IN ('entity', 'session')),
        endpoint_entity_id TEXT,
        invocation_route TEXT CHECK (invocation_route IN ('direct', 'mailbox')),
        metadata_json TEXT NOT NULL,
        application_config_json TEXT,
        opened_sequence INTEGER NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        attached INTEGER NOT NULL DEFAULT 1 CHECK (attached IN (0, 1)),
        detached_at_sequence INTEGER,
        reattach_after_sequence INTEGER,
        reattach_through_sequence INTEGER,
        CHECK (
          (endpoint_kind = 'entity' AND endpoint_entity_id IS NOT NULL AND invocation_route IS NOT NULL) OR
          (endpoint_kind = 'session' AND endpoint_entity_id IS NULL AND invocation_route IS NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS channel_delivery_mailbox (
        delivery_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_sequence INTEGER NOT NULL,
        participant_id TEXT NOT NULL,
        endpoint_entity_id TEXT NOT NULL,
        subscription_revision INTEGER NOT NULL,
        envelope_json TEXT,
        agentic_context_json TEXT,
        projection_version INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'ready'
          CHECK (state IN (
            'ready', 'leased', 'retrying',
            'terminal-completed', 'terminal-departed',
            'terminal-retired', 'terminal-integrity'
          )),
        claim_generation INTEGER NOT NULL DEFAULT 0,
        claimed_by TEXT,
        claimed_relationship_revision INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_attempt_at INTEGER,
        terminal_outcome_json TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_delivery_event_recipient
        ON channel_delivery_mailbox(event_id, participant_id, subscription_revision);
      CREATE INDEX IF NOT EXISTS idx_channel_delivery_claim
        ON channel_delivery_mailbox(state, next_attempt_at, participant_id, event_sequence);
      CREATE INDEX IF NOT EXISTS idx_channel_delivery_lane
        ON channel_delivery_mailbox(participant_id, event_sequence, state, next_attempt_at);
      CREATE TABLE IF NOT EXISTS channel_delivery_event_context (
        event_id TEXT PRIMARY KEY,
        agentic_context_json TEXT NOT NULL,
        projection_version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channel_delivery_projection_cursor (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        projection_version INTEGER NOT NULL,
        log_sequence INTEGER NOT NULL,
        fork_boundary_sequence INTEGER
      );
      INSERT OR IGNORE INTO channel_delivery_projection_cursor
        (singleton, projection_version, log_sequence, fork_boundary_sequence)
        VALUES (1, ${CHANNEL_DELIVERY_PROJECTION_VERSION}, 0, NULL);
      CREATE TABLE IF NOT EXISTS channel_delivery_context (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        projection_version INTEGER NOT NULL,
        initial_config_json TEXT NOT NULL,
        current_config_json TEXT NOT NULL,
        conversation_state_json TEXT NOT NULL
      );
      INSERT OR IGNORE INTO channel_delivery_context
        (singleton, projection_version, initial_config_json, current_config_json,
         conversation_state_json)
      VALUES (
        1,
        ${CHANNEL_DELIVERY_PROJECTION_VERSION},
        '{}',
        '{}',
        '${JSON.stringify(conversationV1Policy.init()).replaceAll("'", "''")}'
      );
      CREATE TABLE IF NOT EXISTS channel_delivery_message_senders (
        message_id TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL,
        event_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channel_receipts (
        message_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('delivered', 'read', 'declined')),
        turn_id TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, participant_id)
      );
    `);
  }

  cursor(): number {
    this.ensureProjectionVersion();
    const row = this.sql
      .exec(
        `SELECT log_sequence FROM channel_delivery_projection_cursor WHERE singleton = 1`,
      )
      .toArray()[0];
    return row ? Number(row["log_sequence"]) : 0;
  }

  /** Bind the immutable initial channel configuration before the first log
   * event. Later changes are ordinary `config-update` facts in the same fold. */
  initializeChannelConfig(config: object): void {
    this.ensureProjectionVersion();
    const cursor = this.cursor();
    const encoded = JSON.stringify(config);
    const row = this.sql
      .exec(
        `SELECT initial_config_json FROM channel_delivery_context WHERE singleton = 1`,
      )
      .toArray()[0];
    const retained = String(row?.["initial_config_json"] ?? "{}");
    if (cursor > 0 && retained !== encoded) {
      throw new Error(
        "Channel configuration must be initialized before the first log event",
      );
    }
    this.sql.exec(
      `UPDATE channel_delivery_context
          SET initial_config_json = ?, current_config_json = ?
        WHERE singleton = 1`,
      encoded,
      encoded,
    );
  }

  /** The plan's disposable-projection reset rule: a projection-version change
   *  never bricks a channel. On mismatch, drop the interval table, the whole
   *  mailbox, and the cursor, then let the ordinary derivation replay rebuild
   *  everything from the canonical log. In-flight leased rows are dropped with
   *  the rest: a stale settle for a vanished row is answered as stale, the
   *  rebuilt row re-delivers with the SAME deterministic delivery_id, and the
   *  recipient's admission journal returns its retained outcome — redelivery
   *  after a version bump is idempotent, merely wasteful, and version bumps
   *  are rare explicit events. */
  private ensureProjectionVersion(): void {
    const row = this.sql
      .exec(
        `SELECT projection_version FROM channel_delivery_projection_cursor WHERE singleton = 1`,
      )
      .toArray()[0];
    if (
      row &&
      Number(row["projection_version"]) === CHANNEL_DELIVERY_PROJECTION_VERSION
    )
      return;
    this.transaction(() => {
      this.sql.exec(`DELETE FROM channel_relationships`);
      this.sql.exec(`DELETE FROM channel_delivery_mailbox`);
      this.sql.exec(`DELETE FROM channel_delivery_event_context`);
      this.sql.exec(`DELETE FROM channel_receipts`);
      this.sql.exec(`DELETE FROM channel_delivery_message_senders`);
      this.sql.exec(
        `UPDATE channel_delivery_context
            SET projection_version = ?,
                current_config_json = initial_config_json,
                conversation_state_json = ?
          WHERE singleton = 1`,
        CHANNEL_DELIVERY_PROJECTION_VERSION,
        JSON.stringify(conversationV1Policy.init()),
      );
      this.sql.exec(
        `INSERT OR REPLACE INTO channel_delivery_projection_cursor
           (singleton, projection_version, log_sequence, fork_boundary_sequence)
         VALUES (1, ?, 0, ?)`,
        CHANNEL_DELIVERY_PROJECTION_VERSION,
        this.durableForkBoundary(),
      );
    });
  }

  relationship(participantId: string): RelationshipRow | null {
    const row = this.sql
      .exec(
        `SELECT participant_id, revision, delivery, endpoint_kind, endpoint_entity_id,
                invocation_route, active, attached, detached_at_sequence,
                reattach_after_sequence, reattach_through_sequence
           FROM channel_relationships WHERE participant_id = ?`,
        participantId,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      participantId: String(row["participant_id"]),
      revision: Number(row["revision"]),
      delivery: String(row["delivery"]) as DeliveryInterest,
      endpointEntityId:
        typeof row["endpoint_entity_id"] === "string"
          ? row["endpoint_entity_id"]
          : null,
      endpointKind: String(row["endpoint_kind"]) as "entity" | "session",
      invocationRoute:
        row["invocation_route"] === "direct" ||
        row["invocation_route"] === "mailbox"
          ? row["invocation_route"]
          : null,
      active: Number(row["active"]) === 1,
      attached: Number(row["attached"]) === 1,
      detachedAtSequence:
        row["detached_at_sequence"] == null
          ? null
          : Number(row["detached_at_sequence"]),
      reattachAfterSequence:
        row["reattach_after_sequence"] == null
          ? null
          : Number(row["reattach_after_sequence"]),
      reattachThroughSequence:
        row["reattach_through_sequence"] == null
          ? null
          : Number(row["reattach_through_sequence"]),
    };
  }

  fold(
    event: ChannelEvent,
    deliveryStartedAt?: number,
  ): { inserted: number; relationshipChanged: boolean } {
    const current = this.cursor();
    if (event.id <= current) return { inserted: 0, relationshipChanged: false };
    const pendingRecovery = this.pendingReattachBackfills()[0];
    if (pendingRecovery) {
      throw new Error(
        `Channel delivery projection cannot fold event ${event.id} while reattach recovery for ` +
          `${pendingRecovery.participantId} remains at ${pendingRecovery.afterSequence}/` +
          `${pendingRecovery.throughSequence}`,
      );
    }
    if (event.id !== current + 1) {
      throw new Error(
        `Channel delivery projection gap: expected ${current + 1}, received ${event.id}`,
      );
    }
    return this.transaction(() => {
      let inserted = 0;
      let relationshipChanged = false;
      this.foldDecisionContext(event);
      const boundaryRow = this.sql
        .exec(
          `SELECT fork_boundary_sequence FROM channel_delivery_projection_cursor WHERE singleton = 1`,
        )
        .toArray()[0];
      const forkBoundary =
        typeof boundaryRow?.["fork_boundary_sequence"] === "number"
          ? Number(boundaryRow["fork_boundary_sequence"])
          : null;
      const contextOnly = forkBoundary !== null && event.id <= forkBoundary;
      if (contextOnly) {
        // An inherited fork prefix supplies conversational context and message
        // sender identity, but its relationships belong to the parent lineage
        // and its delivery debts must never cross into the child.
      } else if (CHANNEL_RELATIONSHIP_EVENT_TYPES.has(event.type)) {
        // A malformed or revision-inconsistent relationship event fails the
        // EVENT, never the channel: it is skipped and the cursor advances.
        // The skip decision is a pure function of the event bytes and the
        // prior folded state (itself a pure fold of prior events), so every
        // replay reaches the identical decision — determinism holds by
        // construction. Throwing here would brick every subsequent publish,
        // join, and leave behind one poison event.
        try {
          this.foldRelationship(event);
          relationshipChanged = true;
        } catch (error) {
          console.warn(
            `[channel-delivery-projection] skipping poison relationship event ${event.id} (${event.type}) on ${this.channelId}:`,
            error,
          );
        }
      } else {
        inserted = this.deriveEvent(event, undefined, false, deliveryStartedAt);
      }
      this.sql.exec(
        `UPDATE channel_delivery_projection_cursor SET log_sequence = ? WHERE singleton = 1`,
        event.id,
      );
      return { inserted, relationshipChanged };
    });
  }

  /** Reset every disposable projection after a channel clone. The inherited
   * prefix is replayed context-only through `forkPointSequence`; child-local
   * facts after the boundary use the ordinary full fold. */
  resetForFork(forkPointSequence: number): void {
    this.transaction(() => {
      this.sql.exec(`DELETE FROM channel_relationships`);
      this.sql.exec(`DELETE FROM channel_delivery_mailbox`);
      this.sql.exec(`DELETE FROM channel_delivery_event_context`);
      this.sql.exec(`DELETE FROM channel_receipts`);
      this.sql.exec(`DELETE FROM channel_delivery_message_senders`);
      this.sql.exec(
        `UPDATE channel_delivery_context
            SET projection_version = ?,
                current_config_json = initial_config_json,
                conversation_state_json = ?
          WHERE singleton = 1`,
        CHANNEL_DELIVERY_PROJECTION_VERSION,
        JSON.stringify(conversationV1Policy.init()),
      );
      this.sql.exec(
        `INSERT OR REPLACE INTO channel_delivery_projection_cursor
           (singleton, projection_version, log_sequence, fork_boundary_sequence)
         VALUES (1, ?, 0, ?)`,
        CHANNEL_DELIVERY_PROJECTION_VERSION,
        forkPointSequence,
      );
    });
  }

  private foldRelationship(event: ChannelEvent): void {
    const payload = this.requireRelationshipPayload(event.payload);
    const current = this.relationship(payload.participantId);
    if (event.type === "channel.subscription.detached") {
      if (
        !current ||
        !current.active ||
        !current.attached ||
        payload.revision !== current.revision + 1
      ) {
        throw new Error(
          `Invalid detached relationship revision for ${payload.participantId}`,
        );
      }
      const detachAfterSequence =
        typeof payload.detachAfterSequence === "number" &&
        payload.detachAfterSequence >= 0
          ? payload.detachAfterSequence
          : event.id - 1;
      this.sql.exec(
        `UPDATE channel_relationships
            SET revision = ?, attached = 0, detached_at_sequence = ?,
                reattach_after_sequence = NULL, reattach_through_sequence = NULL
          WHERE participant_id = ?`,
        payload.revision,
        detachAfterSequence,
        payload.participantId,
      );
      this.sql.exec(
        `UPDATE channel_delivery_mailbox
            SET state = 'terminal-retired', claimed_by = NULL
          WHERE participant_id = ? AND state IN ('ready', 'leased', 'retrying')`,
        payload.participantId,
      );
      return;
    }
    if (event.type === "channel.subscription.ended") {
      if (
        !current ||
        !current.active ||
        payload.revision !== current.revision + 1
      ) {
        throw new Error(
          `Invalid ended relationship revision for ${payload.participantId}`,
        );
      }
      this.sql.exec(
        `UPDATE channel_relationships
            SET revision = ?, active = 0, attached = 0,
                reattach_after_sequence = NULL, reattach_through_sequence = NULL
          WHERE participant_id = ?`,
        payload.revision,
        payload.participantId,
      );
      this.sql.exec(
        `UPDATE channel_delivery_mailbox
            SET state = 'terminal-departed', claimed_by = NULL
          WHERE participant_id = ? AND state IN ('ready', 'leased', 'retrying')`,
        payload.participantId,
      );
      return;
    }
    if (!payload.delivery || !payload.endpoint || !payload.metadata) {
      throw new Error(`${event.type} is missing relationship fields`);
    }
    if (
      payload.endpoint.kind === "entity" &&
      payload.endpoint.invocation !== "direct" &&
      payload.endpoint.invocation !== "mailbox"
    ) {
      throw new Error(
        `${event.type} entity endpoint is missing its invocation route`,
      );
    }
    const expected = current ? current.revision + 1 : 1;
    if (payload.revision !== expected) {
      throw new Error(
        `Invalid relationship revision for ${payload.participantId}: expected ${expected}`,
      );
    }
    const endpointEntityId =
      payload.endpoint.kind === "entity" ? payload.endpoint.entityId : null;
    const invocationRoute =
      payload.endpoint.kind === "entity" ? payload.endpoint.invocation : null;
    const reattaching = current !== null && current.active && !current.attached;
    const reattachAfterSequence = reattaching
      ? current.detachedAtSequence
      : null;
    const reattachThroughSequence = reattaching ? event.id - 1 : null;
    // A pending row's revision is its at-sequence coordinate, not an
    // incarnation lease. Preserve debt across metadata/config revisions when
    // the endpoint is unchanged; retire only when the actual address changes.
    const endpointChanged =
      current !== null &&
      (current.endpointKind !== payload.endpoint.kind ||
        current.endpointEntityId !== endpointEntityId ||
        current.invocationRoute !== invocationRoute);
    if (current && endpointChanged) {
      this.sql.exec(
        `UPDATE channel_delivery_mailbox
            SET state = 'terminal-retired', claimed_by = NULL
          WHERE participant_id = ?
            AND subscription_revision < ?
            AND state IN ('ready', 'leased', 'retrying')`,
        payload.participantId,
        payload.revision,
      );
    }
    this.sql.exec(
      `INSERT OR REPLACE INTO channel_relationships (
         participant_id, revision, delivery, endpoint_kind, endpoint_entity_id,
         invocation_route,
         metadata_json, application_config_json, opened_sequence, active,
         attached, detached_at_sequence, reattach_after_sequence,
         reattach_through_sequence
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, NULL, ?, ?)`,
      payload.participantId,
      payload.revision,
      payload.delivery,
      payload.endpoint.kind,
      endpointEntityId,
      invocationRoute,
      JSON.stringify(payload.metadata),
      payload.applicationConfig === undefined
        ? null
        : JSON.stringify(payload.applicationConfig),
      event.id,
      reattachAfterSequence,
      reattachThroughSequence,
    );
  }

  pendingReattachBackfills(): Array<{
    participantId: string;
    afterSequence: number;
    throughSequence: number;
  }> {
    return this.sql
      .exec(
        `SELECT participant_id, reattach_after_sequence, reattach_through_sequence
           FROM channel_relationships
          WHERE active = 1 AND attached = 1
            AND reattach_after_sequence IS NOT NULL
            AND reattach_through_sequence IS NOT NULL
          ORDER BY participant_id`,
      )
      .toArray()
      .map((row) => ({
        participantId: String(row["participant_id"]),
        afterSequence: Number(row["reattach_after_sequence"]),
        throughSequence: Number(row["reattach_through_sequence"]),
      }));
  }

  /** Advance one durable reattach step atomically with any mailbox row it
   * derives. A crash can therefore repeat a step or resume after it, but can
   * never record progress beyond an unmaterialized delivery debt. */
  advanceReattachBackfill(event: ChannelEvent, participantId: string): number {
    return this.transaction(() => {
      const relationship = this.relationship(participantId);
      const after = relationship?.reattachAfterSequence;
      const through = relationship?.reattachThroughSequence;
      if (
        after === null ||
        after === undefined ||
        through === null ||
        through === undefined
      ) {
        return 0;
      }
      if (event.id <= after) return 0;
      if (event.id > through) {
        throw new Error(
          `Reattach backfill for ${participantId} advanced beyond ${through}: ${event.id}`,
        );
      }
      const inserted = CHANNEL_RELATIONSHIP_EVENT_TYPES.has(event.type)
        ? 0
        : this.deriveEvent(event, participantId);
      if (event.id === through) {
        this.sql.exec(
          `UPDATE channel_relationships
              SET reattach_after_sequence = NULL, reattach_through_sequence = NULL
            WHERE participant_id = ?`,
          participantId,
        );
      } else {
        this.sql.exec(
          `UPDATE channel_relationships SET reattach_after_sequence = ?
            WHERE participant_id = ?`,
          event.id,
          participantId,
        );
      }
      return inserted;
    });
  }

  completeEmptyReattachBackfill(participantId: string): boolean {
    return this.transaction(() => {
      const relationship = this.relationship(participantId);
      const after = relationship?.reattachAfterSequence;
      const through = relationship?.reattachThroughSequence;
      if (
        after === null ||
        after === undefined ||
        through === null ||
        through === undefined
      ) {
        return false;
      }
      if (after < through) return false;
      this.sql.exec(
        `UPDATE channel_relationships
            SET reattach_after_sequence = NULL, reattach_through_sequence = NULL
          WHERE participant_id = ?`,
        participantId,
      );
      return true;
    });
  }

  /** The last sequence that can be retired safely during detach. Reattach
   * rebuilds strictly after this boundary, so every outstanding mailbox debt
   * must lie on the replay side of it. */
  detachRecoveryBoundary(
    participantId: string,
    requestedUpperBound = this.cursor(),
  ): number {
    const row = this.sql
      .exec(
        `SELECT MIN(event_sequence) AS first_outstanding
           FROM channel_delivery_mailbox
          WHERE participant_id = ? AND state IN ('ready', 'leased', 'retrying')`,
        participantId,
      )
      .toArray()[0];
    const firstOutstanding = row?.["first_outstanding"];
    return typeof firstOutstanding === "number"
      ? Math.min(requestedUpperBound, Math.max(0, Number(firstOutstanding) - 1))
      : requestedUpperBound;
  }

  /** Re-derive a delivery from its canonical log event. Terminal mailbox rows
   * deliberately discard their payload bytes, so redelivery must never use a
   * prior mailbox row as an event store. */
  redeliverEventTo(event: ChannelEvent, participantId: string): boolean {
    return this.transaction(
      () => this.deriveEvent(event, participantId, true) > 0,
    );
  }

  private deriveEvent(
    event: ChannelEvent,
    onlyParticipantId?: string,
    rearmTerminal = false,
    deliveryStartedAt?: number,
  ): number {
    const envelope: RpcChannelMessage = { kind: "log", phase: "live", event };
    const envelopeJson = JSON.stringify(envelope);
    const now = Date.now();
    const createdAt =
      typeof deliveryStartedAt === "number" &&
      Number.isFinite(deliveryStartedAt)
        ? deliveryStartedAt
        : typeof event.ts === "number" && Number.isFinite(event.ts)
          ? event.ts
          : now;
    let inserted = 0;
    const relationships = this.sql
      .exec(
        `SELECT participant_id, revision, delivery, endpoint_kind, endpoint_entity_id,
                invocation_route
           FROM channel_relationships
          WHERE active = 1 AND attached = 1
            AND delivery != 'none' AND endpoint_kind = 'entity'
          ORDER BY participant_id`,
      )
      .toArray();
    let agenticContextJson: string | null = null;
    for (const row of relationships) {
      const participantId = String(row["participant_id"]);
      if (onlyParticipantId && participantId !== onlyParticipantId) continue;
      const delivery = String(row["delivery"]) as DeliveryInterest;
      const audience = this.audienceFor(event, participantId);
      // Ordinary self-publication is already locally known. Explicitly
      // addressed facts still create recipient work, including when the
      // publisher and recipient are the same durable participant.
      if (participantId === event.senderId && !audience.explicitParticipant)
        continue;
      if (delivery === "addressed" && !audience.addressed) continue;
      const revision = Number(row["revision"]);
      const endpointEntityId = String(row["endpoint_entity_id"]);
      const invocationRoute = String(row["invocation_route"]);
      if (invocationRoute === "direct" && agenticContextJson === null) {
        const retained = this.sql
          .exec(
            `SELECT agentic_context_json
               FROM channel_delivery_event_context
              WHERE event_id = ?`,
            event.messageId,
          )
          .toArray()[0];
        agenticContextJson = retained
          ? String(retained["agentic_context_json"])
          : this.agenticContextJson(event);
        this.sql.exec(
          `INSERT OR IGNORE INTO channel_delivery_event_context
             (event_id, agentic_context_json, projection_version)
           VALUES (?, ?, ?)`,
          event.messageId,
          agenticContextJson,
          CHANNEL_DELIVERY_PROJECTION_VERSION,
        );
      }
      const deliveryId = sha256HexSyncText(
        canonicalJson([
          this.channelId,
          event.messageId,
          participantId,
          revision,
        ]),
      );
      const result = this.sql.exec(
        `INSERT INTO channel_delivery_mailbox (
           delivery_id, channel_id, event_id, event_sequence, participant_id,
           endpoint_entity_id,
           subscription_revision, envelope_json, agentic_context_json,
           projection_version, state, claim_generation, attempts,
           next_attempt_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 0, 0, ?, ?)
         ON CONFLICT(delivery_id) DO ${
           rearmTerminal
             ? `UPDATE SET
           event_sequence = excluded.event_sequence,
           endpoint_entity_id = excluded.endpoint_entity_id,
           subscription_revision = excluded.subscription_revision,
           envelope_json = excluded.envelope_json,
           agentic_context_json = excluded.agentic_context_json,
           projection_version = excluded.projection_version,
           state = 'ready', claim_generation = 0, claimed_by = NULL,
           attempts = 0, next_attempt_at = excluded.next_attempt_at,
           terminal_outcome_json = NULL
         WHERE channel_delivery_mailbox.state LIKE 'terminal-%'`
             : "NOTHING"
         }
         RETURNING delivery_id`,
        deliveryId,
        this.channelId,
        event.messageId,
        event.id,
        participantId,
        endpointEntityId,
        revision,
        envelopeJson,
        null,
        CHANNEL_DELIVERY_PROJECTION_VERSION,
        now,
        createdAt,
      );
      const insertedRows = result.toArray().length;
      inserted += insertedRows;
      const sourceMessageId = this.sourceMessageId(event);
      if (insertedRows > 0 && sourceMessageId) {
        this.sql.exec(
          `INSERT INTO channel_receipts
             (message_id, participant_id, state, turn_id, updated_at)
           VALUES (?, ?, 'delivered', NULL, ?)
           ON CONFLICT(message_id, participant_id) DO NOTHING`,
          sourceMessageId,
          participantId,
          now,
        );
      }
    }
    return inserted;
  }

  private agenticContextJson(event: ChannelEvent): string {
    const contextRow = this.sql
      .exec(
        `SELECT current_config_json, conversation_state_json
           FROM channel_delivery_context WHERE singleton = 1`,
      )
      .toArray()[0]!;
    const replyTo = this.replyToMessageId(event);
    const replyToRow = replyTo
      ? this.sql
          .exec(
            `SELECT sender_id FROM channel_delivery_message_senders WHERE message_id = ?`,
            replyTo,
          )
          .toArray()[0]
      : undefined;
    const agenticContext: ChannelAgenticContext = {
      version: 1,
      relationships: this.sql
        .exec(
          `SELECT participant_id, metadata_json, application_config_json
             FROM channel_relationships
            WHERE active = 1
            ORDER BY participant_id`,
        )
        .toArray()
        .map((row) => ({
          participantId: String(row["participant_id"]),
          metadata: JSON.parse(String(row["metadata_json"])) as Record<
            string,
            unknown
          >,
          applicationConfig:
            row["application_config_json"] === null
              ? null
              : (JSON.parse(String(row["application_config_json"])) as {
                  version: number;
                  value: unknown;
                }),
        })),
      channelConfig: JSON.parse(
        String(contextRow["current_config_json"]),
      ) as ChannelConfig,
      conversation: JSON.parse(
        String(contextRow["conversation_state_json"]),
      ) as ConversationStateV1,
      replyToSenderId:
        typeof replyToRow?.["sender_id"] === "string"
          ? String(replyToRow["sender_id"])
          : null,
    };
    return JSON.stringify(agenticContext);
  }

  rearmRetryingFor(participantId: string): number {
    return this.sql
      .exec(
        `UPDATE channel_delivery_mailbox
            SET state = 'ready', next_attempt_at = ?, claimed_by = NULL
          WHERE participant_id = ? AND state = 'retrying'
          RETURNING delivery_id`,
        Date.now(),
        participantId,
      )
      .toArray().length;
  }

  private foldDecisionContext(event: ChannelEvent): void {
    const row = this.sql
      .exec(
        `SELECT current_config_json, conversation_state_json
           FROM channel_delivery_context WHERE singleton = 1`,
      )
      .toArray()[0]!;
    const currentConfig = JSON.parse(
      String(row["current_config_json"]),
    ) as ChannelConfig;
    const currentConversation = JSON.parse(
      String(row["conversation_state_json"]),
    ) as ConversationStateV1;
    const nextConfig =
      event.type === "config-update" &&
      event.payload &&
      typeof event.payload === "object"
        ? (event.payload as ChannelConfig)
        : currentConfig;
    const actorKind = ((event.payload as { actor?: { kind?: string } } | null)
      ?.actor?.kind ?? "unknown") as string;
    const view: PolicyEnvelopeView = {
      envelopeId: event.messageId,
      seq: event.id,
      payloadKind: event.type,
      payload: event.payload,
      senderId: event.senderId,
      senderKind: actorKind,
      ...(event.annotations ? { annotations: event.annotations } : {}),
      appendedAt: new Date(event.ts).toISOString(),
    };
    const nextConversation = conversationV1Policy.reduce(
      currentConversation,
      view,
    );
    this.sql.exec(
      `UPDATE channel_delivery_context
          SET current_config_json = ?, conversation_state_json = ?
        WHERE singleton = 1`,
      JSON.stringify(nextConfig),
      JSON.stringify(nextConversation),
    );
    const sourceMessageId = this.sourceMessageId(event);
    if (sourceMessageId) {
      this.sql.exec(
        `INSERT OR IGNORE INTO channel_delivery_message_senders
           (message_id, sender_id, event_sequence) VALUES (?, ?, ?)`,
        sourceMessageId,
        event.senderId,
        event.id,
      );
    }
  }

  private replyToMessageId(event: ChannelEvent): string | null {
    if (event.type !== "agentic.trajectory.v1/event") return null;
    const payload = (
      event.payload as { payload?: { replyTo?: unknown } } | null
    )?.payload;
    return typeof payload?.replyTo === "string" ? payload.replyTo : null;
  }

  recordRead(messageId: string, participantId: string, turnId?: string): void {
    this.sql.exec(
      `INSERT INTO channel_receipts
         (message_id, participant_id, state, turn_id, updated_at)
       VALUES (?, ?, 'read', ?, ?)
       ON CONFLICT(message_id, participant_id) DO UPDATE SET
         state = 'read',
         turn_id = COALESCE(excluded.turn_id, channel_receipts.turn_id),
         updated_at = MAX(channel_receipts.updated_at, excluded.updated_at)`,
      messageId,
      participantId,
      turnId ?? null,
      Date.now(),
    );
  }

  recordDeclined(deliveryId: string): void {
    const row = this.sql
      .exec(
        `SELECT participant_id, envelope_json
           FROM channel_delivery_mailbox
          WHERE delivery_id = ?`,
        deliveryId,
      )
      .toArray()[0];
    if (!row || typeof row["envelope_json"] !== "string") return;
    const sourceMessageId = this.sourceMessageIdFromEnvelope(
      String(row["envelope_json"]),
    );
    if (!sourceMessageId) return;
    this.sql.exec(
      `INSERT INTO channel_receipts
         (message_id, participant_id, state, turn_id, updated_at)
       VALUES (?, ?, 'declined', NULL, ?)
       ON CONFLICT(message_id, participant_id) DO UPDATE SET
         state = CASE WHEN channel_receipts.state = 'read' THEN 'read' ELSE 'declined' END,
         updated_at = MAX(channel_receipts.updated_at, excluded.updated_at)`,
      sourceMessageId,
      String(row["participant_id"]),
      Date.now(),
    );
  }

  receiptRows(): Array<{
    messageId: string;
    participantId: string;
    state: "delivered" | "read" | "declined";
    turnId?: string;
    updatedAt: number;
  }> {
    return this.sql
      .exec(
        `SELECT message_id, participant_id, state, turn_id, updated_at
           FROM channel_receipts
          ORDER BY message_id, participant_id`,
      )
      .toArray()
      .map((row) => ({
        messageId: String(row["message_id"]),
        participantId: String(row["participant_id"]),
        state: String(row["state"]) as "delivered" | "read" | "declined",
        ...(typeof row["turn_id"] === "string"
          ? { turnId: String(row["turn_id"]) }
          : {}),
        updatedAt: Number(row["updated_at"]),
      }));
  }

  diagnostics(headSequence: number): {
    projectionVersion: number;
    cursor: number;
    lag: number;
    memberships: Array<{
      active: boolean;
      endpointKind: "entity" | "session";
      delivery: DeliveryInterest;
      count: number;
    }>;
    mailbox: Array<{ state: string; count: number; oldestCreatedAt: number }>;
    debts: {
      retryingAboveThreshold: number;
      maximumAttempts: number;
      detachedRelationships: number;
      terminalRetired: number;
      terminalIntegrity: number;
    };
    receiptCount: number;
    contextStorage: {
      eventRows: number;
      mailboxRows: number;
      mailboxContextCopies: number;
    };
  } {
    const cursor = this.cursor();
    return {
      projectionVersion: CHANNEL_DELIVERY_PROJECTION_VERSION,
      cursor,
      lag: Math.max(0, headSequence - cursor),
      memberships: this.sql
        .exec(
          `SELECT active, endpoint_kind, delivery, COUNT(*) AS count
             FROM channel_relationships
            GROUP BY active, endpoint_kind, delivery
            ORDER BY active DESC, endpoint_kind, delivery`,
        )
        .toArray()
        .map((row) => ({
          active: Number(row["active"]) === 1,
          endpointKind: String(row["endpoint_kind"]) as "entity" | "session",
          delivery: String(row["delivery"]) as DeliveryInterest,
          count: Number(row["count"]),
        })),
      mailbox: this.sql
        .exec(
          `SELECT state, COUNT(*) AS count, MIN(created_at) AS oldest_created_at
             FROM channel_delivery_mailbox
            GROUP BY state
            ORDER BY state`,
        )
        .toArray()
        .map((row) => ({
          state: String(row["state"]),
          count: Number(row["count"]),
          oldestCreatedAt: Number(row["oldest_created_at"]),
        })),
      debts: {
        retryingAboveThreshold: Number(
          this.sql
            .exec(
              `SELECT COUNT(*) AS count FROM channel_delivery_mailbox
                WHERE state = 'retrying' AND attempts >= 3`,
            )
            .toArray()[0]?.["count"] ?? 0,
        ),
        maximumAttempts: Number(
          this.sql
            .exec(
              `SELECT MAX(attempts) AS attempts FROM channel_delivery_mailbox`,
            )
            .toArray()[0]?.["attempts"] ?? 0,
        ),
        detachedRelationships: Number(
          this.sql
            .exec(
              `SELECT COUNT(*) AS count FROM channel_relationships
                WHERE active = 1 AND attached = 0`,
            )
            .toArray()[0]?.["count"] ?? 0,
        ),
        terminalRetired: Number(
          this.sql
            .exec(
              `SELECT COUNT(*) AS count FROM channel_delivery_mailbox
                WHERE state = 'terminal-retired'`,
            )
            .toArray()[0]?.["count"] ?? 0,
        ),
        terminalIntegrity: Number(
          this.sql
            .exec(
              `SELECT COUNT(*) AS count FROM channel_delivery_mailbox
                WHERE state = 'terminal-integrity'`,
            )
            .toArray()[0]?.["count"] ?? 0,
        ),
      },
      contextStorage: {
        eventRows: Number(
          this.sql
            .exec(
              `SELECT COUNT(*) AS count FROM channel_delivery_event_context`,
            )
            .toArray()[0]?.["count"] ?? 0,
        ),
        mailboxRows: Number(
          this.sql
            .exec(`SELECT COUNT(*) AS count FROM channel_delivery_mailbox`)
            .toArray()[0]?.["count"] ?? 0,
        ),
        mailboxContextCopies: Number(
          this.sql
            .exec(
              `SELECT COUNT(*) AS count FROM channel_delivery_mailbox
                WHERE agentic_context_json IS NOT NULL`,
            )
            .toArray()[0]?.["count"] ?? 0,
        ),
      },
      receiptCount: Number(
        this.sql
          .exec(`SELECT COUNT(*) AS count FROM channel_receipts`)
          .toArray()[0]?.["count"] ?? 0,
      ),
    };
  }

  private sourceMessageId(event: ChannelEvent): string | null {
    if (event.type !== "agentic.trajectory.v1/event") return null;
    const agentic = event.payload as {
      kind?: unknown;
      causality?: { messageId?: unknown };
    };
    return agentic.kind === "message.completed" &&
      typeof agentic.causality?.messageId === "string"
      ? agentic.causality.messageId
      : null;
  }

  private sourceMessageIdFromEnvelope(envelopeJson: string): string | null {
    try {
      const envelope = JSON.parse(envelopeJson) as { event?: ChannelEvent };
      return envelope.event ? this.sourceMessageId(envelope.event) : null;
    } catch {
      return null;
    }
  }

  private audienceFor(
    event: ChannelEvent,
    participantId: string,
  ): { addressed: boolean; explicitParticipant: boolean } {
    if (
      event.type !== "agentic.trajectory.v1/event" ||
      !event.payload ||
      typeof event.payload !== "object"
    ) {
      return { addressed: false, explicitParticipant: false };
    }
    const agentic = event.payload as AgenticEvent;
    const payload = (
      agentic as { payload?: { mentions?: unknown; to?: unknown } }
    ).payload;
    if (
      Array.isArray(payload?.mentions) &&
      payload.mentions.includes(participantId)
    ) {
      return { addressed: true, explicitParticipant: true };
    }
    if (!Array.isArray(payload?.to))
      return { addressed: false, explicitParticipant: false };
    let addressed = false;
    let explicitParticipant = false;
    for (const target of payload.to) {
      if (!target || typeof target !== "object") continue;
      const value = target as { kind?: unknown; participantId?: unknown };
      if (value.kind === "all") addressed = true;
      if (
        value.kind === "participant" &&
        value.participantId === participantId
      ) {
        addressed = true;
        explicitParticipant = true;
      }
    }
    return { addressed, explicitParticipant };
  }

  private requireRelationshipPayload(
    value: unknown,
  ): ChannelRelationshipPayload {
    if (!value || typeof value !== "object")
      throw new Error("Invalid channel relationship payload");
    const payload = value as ChannelRelationshipPayload;
    if (
      !payload.participantId ||
      !Number.isSafeInteger(payload.revision) ||
      payload.revision < 1
    ) {
      throw new Error("Invalid channel relationship identity");
    }
    return payload;
  }
}
