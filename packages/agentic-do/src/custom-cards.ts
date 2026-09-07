/**
 * CardManager / CustomMessageHandle — the typed, durable API agents use to
 * publish and update custom message cards.
 *
 * Replaces hand-rolled `publishCustom`/`updateCustom` wrappers in agent
 * workers. What it adds over raw event publishing:
 *
 * - **Durable identity**: cards are keyed by a natural key (e.g.
 *   `gmail:inbox:{channelId}`) in a local sqlite table, so `getOrCreate`
 *   returns the same card across DO restarts.
 * - **Deterministic idempotency**: every emission uses a per-card monotonic
 *   sequence (`custom:{messageId}:{seq}`), so a retried publish after a crash
 *   dedupes instead of double-applying (a random-UUID suffix defeats this).
 * - **Emission-time validation**: state/updates are validated against the
 *   JSON Schema registered with the message type. Failures throw typed errors
 *   — inside a tool call the model sees them as tool errors, closing the loop
 *   that previously only failed silently at the render boundary.
 * - **Protocol-level failure**: `card.fail(error)` marks the card failed so
 *   the UI renders a standard failed frame.
 */

import {
  AGENTIC_PROTOCOL_VERSION,
  jsonSchemaToZod,
  type ActorRef,
  type AgenticEvent,
  type CustomMessageDisplayMode,
  type MessageId,
} from "@workspace/agentic-protocol";
import type { SqlStorage } from "@workspace/runtime/worker";
import type { ChannelClient } from "./channel-client.js";

export class CardValidationError extends Error {
  constructor(
    public readonly typeId: string,
    public readonly issues: string[]
  ) {
    super(`Invalid state for card type "${typeId}": ${issues.join("; ")}`);
    this.name = "CardValidationError";
  }
}

export class CardTypeNotRegisteredError extends Error {
  constructor(public readonly typeId: string) {
    super(
      `Custom message type "${typeId}" is not registered on this channel. ` +
        `Register it (with its stateSchema) before creating cards.`
    );
    this.name = "CardTypeNotRegisteredError";
  }
}

interface MessageTypeInfo {
  typeId: string;
  displayMode: CustomMessageDisplayMode;
  stateSchema?: Record<string, unknown>;
  updateSchema?: Record<string, unknown>;
}

export interface CustomMessageHandle {
  readonly messageId: string;
  readonly typeId: string;
  readonly channelId: string;
  /**
   * Pubsub log id of the `custom.started` event that created this card, or
   * `undefined` when the handle was fetched for a card that already existed
   * (a getOrCreate hit) and so published nothing.
   */
  readonly pubsubId: number | undefined;
  /** Publish a new state (full replacement unless the type reduces). Resolves
   *  to the pubsub log id of the emitted `custom.updated` event. */
  update(state: unknown): Promise<number | undefined>;
  /** Mark the card failed; the UI renders a standard failed-card frame.
   *  Resolves to the pubsub log id of the emitted `custom.updated` event. */
  fail(error: { message: string; details?: unknown }): Promise<number | undefined>;
}

export interface CardManagerDeps {
  sql: SqlStorage;
  createChannelClient: (channelId: string) => ChannelClient;
  getParticipantId: (channelId: string) => string | null;
  getActor: (channelId: string) => ActorRef;
  /**
   * Stable agent identity used in idempotency keys. A getter because the DO's
   * objectKey is not available at construction time (workerd only knows it
   * once the first request arrives).
   */
  getAgentId: () => string;
}

export class CardManager {
  private readonly typeCache = new Map<string, MessageTypeInfo>();

  constructor(private readonly deps: CardManagerDeps) {
    CardManager.createTables(deps.sql);
  }

  static createTables(sql: SqlStorage): void {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS custom_cards (
        natural_key TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        type_id TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_custom_cards_message ON custom_cards(message_id)`);
  }

  /** Invalidate the cached definition when a type is (re)registered. */
  invalidateType(channelId: string, typeId: string): void {
    this.typeCache.delete(`${channelId}:${typeId}`);
  }

  /**
   * Adopt a card recovered from channel replay (e.g. after a fork or
   * hibernation) into the registry so subsequent `find`/`getOrCreate` calls
   * reuse its message identity instead of minting a duplicate card.
   */
  adoptRecovered(channelId: string, naturalKey: string, typeId: string, messageId: string): void {
    this.deps.sql.exec(
      `INSERT OR IGNORE INTO custom_cards (natural_key, channel_id, message_id, type_id, seq, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
      `${channelId}:${naturalKey}`,
      channelId,
      messageId,
      typeId,
      Date.now()
    );
  }

  /**
   * Create a card with a fresh identity. Prefer `getOrCreate` for cards with a
   * stable role (a dashboard, a per-thread card) so restarts reuse them.
   */
  async create(
    channelId: string,
    typeId: string,
    initialState: unknown,
    opts?: { displayMode?: CustomMessageDisplayMode; key?: string }
  ): Promise<CustomMessageHandle> {
    const key = opts?.key ?? `card:${crypto.randomUUID()}`;
    return this.getOrCreate(channelId, typeId, key, initialState, opts);
  }

  /**
   * Idempotently create (or fetch) the card identified by `naturalKey` on this
   * channel. Validates `initialState` against the registered stateSchema.
   */
  async getOrCreate(
    channelId: string,
    typeId: string,
    naturalKey: string,
    initialState: unknown,
    opts?: { displayMode?: CustomMessageDisplayMode }
  ): Promise<CustomMessageHandle> {
    const fullKey = `${channelId}:${naturalKey}`;
    const existing = this.findByKey(fullKey);
    if (existing) {
      if (existing.typeId !== typeId) {
        throw new Error(
          `Card key "${naturalKey}" already exists with type "${existing.typeId}" (asked for "${typeId}")`
        );
      }
      return this.handleFor(existing);
    }

    const info = await this.requireType(channelId, typeId);
    this.validate(info, info.stateSchema, initialState);

    const messageId = crypto.randomUUID();
    const row: CardRow = {
      naturalKey: fullKey,
      channelId,
      messageId,
      typeId,
      seq: 0,
    };
    this.deps.sql.exec(
      `INSERT INTO custom_cards (natural_key, channel_id, message_id, type_id, seq, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
      fullKey,
      channelId,
      messageId,
      typeId,
      Date.now()
    );

    const actor = this.deps.getActor(channelId);
    const event: AgenticEvent<"custom.started"> = {
      kind: "custom.started",
      actor,
      causality: { messageId: messageId as MessageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        messageId: messageId as MessageId,
        typeId,
        displayMode: opts?.displayMode ?? info.displayMode,
        ...(initialState !== undefined ? { initialState } : {}),
        by: actor,
      },
      createdAt: new Date().toISOString(),
    };
    const pubsubId = await this.publish(channelId, event, this.idempotencyKey(messageId, "start"));
    return this.handleFor(row, pubsubId);
  }

  /** Look up an existing card handle by messageId (no creation). */
  get(channelId: string, messageId: string): CustomMessageHandle | null {
    const rows = this.deps.sql
      .exec(
        `SELECT * FROM custom_cards WHERE channel_id = ? AND message_id = ?`,
        channelId,
        messageId
      )
      .toArray();
    return rows.length > 0 ? this.handleFor(this.toRow(rows[0]!)) : null;
  }

  /** Look up an existing card handle by its natural key (no creation). */
  find(channelId: string, naturalKey: string): CustomMessageHandle | null {
    const row = this.findByKey(`${channelId}:${naturalKey}`);
    return row ? this.handleFor(row) : null;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private handleFor(row: CardRow, pubsubId?: number): CustomMessageHandle {
    return {
      messageId: row.messageId,
      typeId: row.typeId,
      channelId: row.channelId,
      pubsubId,
      update: async (state: unknown): Promise<number | undefined> => {
        const info = await this.requireType(row.channelId, row.typeId);
        // Types with a UI reducer treat updates as patches and validate against
        // updateSchema; plain types replace state and validate against stateSchema.
        this.validate(info, info.updateSchema ?? info.stateSchema, state);
        return this.publishUpdate(row, state);
      },
      fail: async (error: { message: string; details?: unknown }): Promise<number | undefined> =>
        this.publishUpdate(row, undefined, { status: "failed", error }),
    };
  }

  private async publishUpdate(
    row: CardRow,
    update: unknown,
    failure?: { status: "failed"; error: { message: string; details?: unknown } }
  ): Promise<number | undefined> {
    const seq = this.bumpSeq(row.naturalKey);
    const event: AgenticEvent<"custom.updated"> = {
      kind: "custom.updated",
      actor: this.deps.getActor(row.channelId),
      causality: { messageId: row.messageId as MessageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        messageId: row.messageId as MessageId,
        update,
        ...(failure ?? {}),
      },
      createdAt: new Date().toISOString(),
    };
    return this.publish(row.channelId, event, this.idempotencyKey(row.messageId, String(seq)));
  }

  private async publish(
    channelId: string,
    event: AgenticEvent,
    idempotencyKey: string
  ): Promise<number | undefined> {
    const participantId = this.deps.getParticipantId(channelId);
    if (!participantId) {
      throw new Error(`Not subscribed to channel ${channelId}; cannot publish card events`);
    }
    const channel = this.deps.createChannelClient(channelId);
    const res = await channel.publishAgenticEvent(participantId, event, { idempotencyKey });
    return res?.id;
  }

  private idempotencyKey(messageId: string, suffix: string): string {
    return `custom:${this.deps.getAgentId()}:${messageId}:${suffix}`;
  }

  private bumpSeq(naturalKey: string): number {
    this.deps.sql.exec(`UPDATE custom_cards SET seq = seq + 1 WHERE natural_key = ?`, naturalKey);
    const rows = this.deps.sql
      .exec(`SELECT seq FROM custom_cards WHERE natural_key = ?`, naturalKey)
      .toArray();
    return Number(rows[0]?.["seq"] ?? 0);
  }

  private async requireType(channelId: string, typeId: string): Promise<MessageTypeInfo> {
    const cacheKey = `${channelId}:${typeId}`;
    const cached = this.typeCache.get(cacheKey);
    if (cached) return cached;
    const channel = this.deps.createChannelClient(channelId);
    const definition = await channel.getMessageType(typeId);
    if (!definition) throw new CardTypeNotRegisteredError(typeId);
    const info: MessageTypeInfo = {
      typeId,
      displayMode: definition["displayMode"] === "inline" ? "inline" : "row",
      ...(isRecord(definition["stateSchema"])
        ? { stateSchema: definition["stateSchema"] as Record<string, unknown> }
        : {}),
      ...(isRecord(definition["updateSchema"])
        ? { updateSchema: definition["updateSchema"] as Record<string, unknown> }
        : {}),
    };
    this.typeCache.set(cacheKey, info);
    return info;
  }

  private validate(
    info: MessageTypeInfo,
    schema: Record<string, unknown> | undefined,
    value: unknown
  ): void {
    if (!schema) return;
    const parsed = jsonSchemaToZod(schema).safeParse(value);
    if (parsed.success) return;
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    });
    throw new CardValidationError(
      info.typeId,
      issues.length ? issues : ["schema validation failed"]
    );
  }

  private findByKey(fullKey: string): CardRow | null {
    const rows = this.deps.sql
      .exec(`SELECT * FROM custom_cards WHERE natural_key = ?`, fullKey)
      .toArray();
    return rows.length > 0 ? this.toRow(rows[0]!) : null;
  }

  private toRow(row: Record<string, unknown>): CardRow {
    return {
      naturalKey: row["natural_key"] as string,
      channelId: row["channel_id"] as string,
      messageId: row["message_id"] as string,
      typeId: row["type_id"] as string,
      seq: Number(row["seq"] ?? 0),
    };
  }
}

interface CardRow {
  naturalKey: string;
  channelId: string;
  messageId: string;
  typeId: string;
  seq: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
