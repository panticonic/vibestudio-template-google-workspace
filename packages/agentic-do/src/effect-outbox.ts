/**
 * Effect outbox (WS1 §2.1) — ONE table replaces eight. No status column: a
 * row exists ⟺ the effect is unresolved (P1). Resolution = append the
 * outcome event to GAD, THEN delete the row; the reconcile heals both crash
 * directions.
 */

import type { SqlStorage } from "@workspace/runtime/worker/durable-base";
import { assertExactSqlTableSchema } from "@workspace/runtime/worker/sql-table-schema";
import type { EffectDescriptor, EffectKind } from "@workspace/agent-loop";

export interface OutboxRow {
  effectId: string;
  branchId: string;
  channelId: string;
  kind: EffectKind;
  idempotencyKey: string;
  descriptor: EffectDescriptor;
  attempts: number;
  nextAttemptAt: number | null;
  leaseOwner: string | null;
  leaseGeneration: number;
  disposition: "ready" | "leased" | "parked" | "retrying";
  lastAttemptAt: number | null;
  createdAt: number;
}

const OUTBOX_EXTERNAL_ID_PREFIX = "outbox:";

export function outboxExternalId(branchId: string, effectId: string): string {
  return `${OUTBOX_EXTERNAL_ID_PREFIX}${encodeURIComponent(branchId)}:${encodeURIComponent(effectId)}`;
}

export function parseOutboxExternalId(
  value: string
): { branchId: string; effectId: string } | null {
  if (!value.startsWith(OUTBOX_EXTERNAL_ID_PREFIX)) return null;
  const encoded = value.slice(OUTBOX_EXTERNAL_ID_PREFIX.length);
  const split = encoded.indexOf(":");
  if (split < 0) return null;
  return {
    branchId: decodeURIComponent(encoded.slice(0, split)),
    effectId: decodeURIComponent(encoded.slice(split + 1)),
  };
}

export function ensureOutboxSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS effect_outbox (
      branch_id        TEXT NOT NULL,
      effect_id        TEXT NOT NULL,
      channel_id       TEXT NOT NULL,
      kind             TEXT NOT NULL,
      idempotency_key  TEXT NOT NULL,
      descriptor_json  TEXT NOT NULL,
      attempts         INTEGER NOT NULL DEFAULT 0,
      next_attempt_at  INTEGER,
      lease_owner      TEXT,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL,
      last_attempt_at  INTEGER,
      disposition      TEXT NOT NULL DEFAULT 'ready'
        CHECK (disposition IN ('ready', 'leased', 'parked', 'retrying')),
      PRIMARY KEY (branch_id, effect_id)
    )
  `);
  assertExactSqlTableSchema(sql, {
    table: "effect_outbox",
    columns: [
      ["branch_id", "TEXT", true],
      ["effect_id", "TEXT", true],
      ["channel_id", "TEXT", true],
      ["kind", "TEXT", true],
      ["idempotency_key", "TEXT", true],
      ["descriptor_json", "TEXT", true],
      ["attempts", "INTEGER", true, "0"],
      ["next_attempt_at", "INTEGER", false],
      ["lease_owner", "TEXT", false],
      ["lease_generation", "INTEGER", true, "0"],
      ["created_at", "INTEGER", true],
      ["last_attempt_at", "INTEGER", false],
      ["disposition", "TEXT", true, "'ready'"],
    ],
    primaryKey: ["branch_id", "effect_id"],
  });
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_effect_outbox_due ON effect_outbox(next_attempt_at)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_effect_outbox_effect ON effect_outbox(effect_id)`);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_effect_outbox_channel_effect
      ON effect_outbox(channel_id, effect_id)`
  );
  sql.exec(`
    CREATE TABLE IF NOT EXISTS effect_completion_evidence (
      branch_id TEXT NOT NULL,
      effect_id TEXT NOT NULL,
      completed_at INTEGER NOT NULL,
      PRIMARY KEY (branch_id, effect_id)
    )
  `);
}

export function maxAttempts(descriptor: EffectDescriptor): number {
  switch (descriptor.kind) {
    case "prompt_artifacts":
      // Prompt/tool materialization is read-mostly and its blob writes are
      // content-addressed. Brief host-RPC transport failures must not discard
      // a user's message before it reaches the model, but a persistent or
      // deterministic failure still settles visibly after a bounded retry.
      return 3;
    case "model_call":
      // Reviewed provider backpressure remains pending until it succeeds or
      // the owning turn is cancelled. Opaque transport failures are bounded
      // by AgentLoopDriver because only the classified outcome identifies
      // them; they must not leave an interactive turn typing forever.
      return Number.POSITIVE_INFINITY;
    case "local_tool":
      // A settle boundary may have committed before its transport reported an
      // error. Do not redrive it blindly; durable semantic mutations recover
      // through command evidence, while scratch mutations have no replay key.
      return descriptor.cancellationMode === "settle" ? 1 : 3;
    case "channel_call":
    case "http_call":
      return 5;
    case "credential_wait":
      return Number.POSITIVE_INFINITY; // deadline-only
    case "record_receipt":
      return 3;
  }
}

export function backoffMs(attempts: number): number {
  return Math.min(30_000, 500 * 2 ** attempts);
}

function mapRow(row: Record<string, unknown>): OutboxRow {
  return {
    effectId: String(row["effect_id"]),
    branchId: String(row["branch_id"]),
    channelId: String(row["channel_id"]),
    kind: String(row["kind"]) as EffectKind,
    idempotencyKey: String(row["idempotency_key"]),
    descriptor: JSON.parse(String(row["descriptor_json"])) as EffectDescriptor,
    attempts: Number(row["attempts"] ?? 0),
    nextAttemptAt: row["next_attempt_at"] == null ? null : Number(row["next_attempt_at"]),
    leaseOwner: row["lease_owner"] == null ? null : String(row["lease_owner"]),
    leaseGeneration: Number(row["lease_generation"] ?? 0),
    disposition: String(row["disposition"] ?? "ready") as OutboxRow["disposition"],
    lastAttemptAt: row["last_attempt_at"] == null ? null : Number(row["last_attempt_at"]),
    createdAt: Number(row["created_at"] ?? 0),
  };
}

function invocationOrder(row: OutboxRow): {
  turnId: string;
  sequence: number;
  executionMode: "sequential" | "parallel";
} | null {
  const descriptor = row.descriptor;
  if (
    (descriptor.kind === "local_tool" ||
      descriptor.kind === "channel_call" ||
      descriptor.kind === "http_call") &&
    typeof descriptor.invocationSeq === "number" &&
    (descriptor.executionMode === "sequential" || descriptor.executionMode === "parallel")
  ) {
    return {
      turnId: descriptor.turnId,
      sequence: descriptor.invocationSeq,
      executionMode: descriptor.executionMode,
    };
  }
  return null;
}

function compareDispatchOrder(left: OutboxRow, right: OutboxRow): number {
  const leftInvocation = invocationOrder(left);
  const rightInvocation = invocationOrder(right);
  if (leftInvocation && rightInvocation && leftInvocation.turnId === rightInvocation.turnId) {
    const sequence = leftInvocation.sequence - rightInvocation.sequence;
    if (sequence !== 0) return sequence;
  }
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  const branch = left.branchId.localeCompare(right.branchId);
  return branch !== 0 ? branch : left.effectId.localeCompare(right.effectId);
}

/**
 * Inspect the activation-local outbox without creating or migrating its
 * reconstructible schema. A diagnostic read must not initialize an otherwise
 * unused agent merely because no outbox has existed in this activation yet.
 */
export function inspectEffectOutbox(sql: SqlStorage): OutboxRow[] {
  const tables = sql
    .exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_outbox'`)
    .toArray();
  if (tables.length === 0) return [];
  return (
    sql
      .exec(`SELECT * FROM effect_outbox ORDER BY created_at, branch_id, effect_id`)
      .toArray() as Record<string, unknown>[]
  ).map(mapRow);
}

export class EffectOutbox {
  constructor(private readonly sql: SqlStorage) {
    ensureOutboxSchema(sql);
  }

  hasCompletionEvidence(branchId: string, effectId: string): boolean {
    return (
      this.sql
        .exec(
          `SELECT 1 FROM effect_completion_evidence WHERE branch_id = ? AND effect_id = ?`,
          branchId,
          effectId
        )
        .toArray().length > 0
    );
  }

  recordCompletionEvidence(branchId: string, effectId: string, completedAt: number): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO effect_completion_evidence (branch_id, effect_id, completed_at)
       VALUES (?, ?, ?)`,
      branchId,
      effectId,
      completedAt
    );
  }

  pruneCompletionEvidence(branchId: string, expectedEffectIds: Set<string>): void {
    const rows = this.sql
      .exec(`SELECT effect_id FROM effect_completion_evidence WHERE branch_id = ?`, branchId)
      .toArray();
    for (const row of rows) {
      const effectId = String(row["effect_id"]);
      if (!expectedEffectIds.has(effectId)) {
        this.sql.exec(
          `DELETE FROM effect_completion_evidence WHERE branch_id = ? AND effect_id = ?`,
          branchId,
          effectId
        );
      }
    }
  }

  insert(branchId: string, descriptor: EffectDescriptor, nextAttemptAt: number | null): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO effect_outbox (
         effect_id, branch_id, channel_id, kind, idempotency_key,
         descriptor_json, attempts, next_attempt_at, lease_generation,
         created_at, disposition
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, 'ready')`,
      descriptor.effectId,
      branchId,
      descriptor.channelId,
      descriptor.kind,
      descriptor.idempotencyKey,
      JSON.stringify(descriptor),
      nextAttemptAt,
      Date.now()
    );
  }

  /** Rewrite the durable descriptor of an unresolved row (used to record
   * monotonic lifecycle facts such as the deferred-eval `started` ack). The
   * row identity, kind, and scheduling columns are untouched. */
  updateDescriptor(branchId: string, effectId: string, descriptor: EffectDescriptor): void {
    this.sql.exec(
      `UPDATE effect_outbox SET descriptor_json = ? WHERE branch_id = ? AND effect_id = ?`,
      JSON.stringify(descriptor),
      branchId,
      effectId
    );
  }

  delete(branchId: string, effectId: string): void {
    this.sql.exec(
      `DELETE FROM effect_outbox WHERE branch_id = ? AND effect_id = ?`,
      branchId,
      effectId
    );
  }

  get(branchId: string, effectId: string): OutboxRow | null {
    const rows = this.sql
      .exec(`SELECT * FROM effect_outbox WHERE branch_id = ? AND effect_id = ?`, branchId, effectId)
      .toArray();
    return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
  }

  getForChannel(channelId: string, effectId: string): OutboxRow | null {
    const rows = this.sql
      .exec(
        `SELECT * FROM effect_outbox WHERE channel_id = ? AND effect_id = ?`,
        channelId,
        effectId
      )
      .toArray() as Record<string, unknown>[];
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      throw new Error(`ambiguous outbox effect ${effectId} for channel ${channelId}`);
    }
    return mapRow(rows[0]!);
  }

  getUnique(effectId: string): OutboxRow | null {
    const rows = this.sql
      .exec(`SELECT * FROM effect_outbox WHERE effect_id = ?`, effectId)
      .toArray() as Record<string, unknown>[];
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      throw new Error(`ambiguous outbox effect ${effectId}; provide branch or channel`);
    }
    return mapRow(rows[0]!);
  }

  forBranch(branchId: string): OutboxRow[] {
    return (
      this.sql
        .exec(
          `SELECT * FROM effect_outbox WHERE branch_id = ? AND kind != 'record_receipt'`,
          branchId
        )
        .toArray() as Record<string, unknown>[]
    ).map(mapRow);
  }

  all(): OutboxRow[] {
    return inspectEffectOutbox(this.sql);
  }

  /** Rows due for dispatch in the active host generation. Leased rows remain
   * owned until settlement, explicit failure, or dispatcher-generation adoption. */
  due(now: number): OutboxRow[] {
    return (
      this.sql
        .exec(
          `SELECT * FROM effect_outbox
           WHERE (next_attempt_at IS NULL OR next_attempt_at <= ?)
             AND disposition IN ('ready', 'retrying', 'parked')
           ORDER BY created_at, branch_id, effect_id`,
          now
        )
        .toArray() as Record<string, unknown>[]
    ).map(mapRow);
  }

  releaseLease(branchId: string, effectId: string): void {
    this.sql.exec(
      `UPDATE effect_outbox
       SET lease_owner = NULL, disposition = 'ready'
       WHERE branch_id = ? AND effect_id = ?`,
      branchId,
      effectId
    );
  }

  recordFailure(
    branchId: string,
    effectId: string,
    now: number,
    delayMs?: number
  ): OutboxRow | null {
    const row = this.get(branchId, effectId);
    if (!row) return null;
    const attempts = row.attempts + 1;
    const delay =
      typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs >= 0
        ? delayMs
        : backoffMs(attempts);
    this.sql.exec(
      `UPDATE effect_outbox
       SET attempts = ?,
           lease_owner = NULL,
           next_attempt_at = ?,
           disposition = 'retrying'
       WHERE branch_id = ? AND effect_id = ?`,
      attempts,
      now + delay,
      branchId,
      effectId
    );
    return this.get(branchId, effectId);
  }

  claimReady(input: { workerId: string; now: number; limit: number }): OutboxRow[] {
    const candidates = this.due(input.now);
    const dueKeys = new Set(candidates.map((row) => `${row.branchId}\u0000${row.effectId}`));
    const unresolved = this.all();
    const selected: OutboxRow[] = [];
    for (const channelId of [...new Set(unresolved.map((row) => row.channelId))]) {
      const rows = unresolved
        .filter((row) => row.channelId === channelId)
        .sort(compareDispatchOrder);
      selected.push(
        ...rows.filter((row) => {
          const independentlyDispatchable =
            row.kind === "record_receipt" ||
            ((row.kind === "channel_call" || row.kind === "http_call") &&
              invocationOrder(row) === null);
          return independentlyDispatchable && dueKeys.has(`${row.branchId}\u0000${row.effectId}`);
        })
      );
      const semantic = rows.filter(
        (row) =>
          row.kind !== "record_receipt" &&
          !(
            (row.kind === "channel_call" || row.kind === "http_call") &&
            invocationOrder(row) === null
          )
      );
      const first = semantic[0];
      if (!first) continue;
      const firstInvocation = invocationOrder(first);
      if (firstInvocation?.executionMode === "parallel") {
        for (const row of semantic) {
          const invocation = invocationOrder(row);
          if (
            invocation?.executionMode !== "parallel" ||
            invocation.turnId !== firstInvocation.turnId
          ) {
            break;
          }
          if (dueKeys.has(`${row.branchId}\u0000${row.effectId}`)) selected.push(row);
        }
      } else if (dueKeys.has(`${first.branchId}\u0000${first.effectId}`)) {
        selected.push(first);
      }
    }
    const claimed: OutboxRow[] = [];
    for (const row of selected.slice(0, input.limit)) {
      const updated = (
        this.sql
          .exec(
            `UPDATE effect_outbox
                SET lease_owner = ?,
                    lease_generation = lease_generation + 1,
                    next_attempt_at = NULL,
                    last_attempt_at = ?,
                    disposition = 'leased'
              WHERE branch_id = ?
                AND effect_id = ?
                AND disposition IN ('ready', 'retrying', 'parked')
            RETURNING *`,
            input.workerId,
            input.now,
            row.branchId,
            row.effectId
          )
          .toArray() as Record<string, unknown>[]
      )[0];
      if (updated) claimed.push(mapRow(updated));
    }
    return claimed;
  }

  isClaim(branchId: string, effectId: string, generation: number, workerId?: string): boolean {
    const row = this.get(branchId, effectId);
    return (
      row?.disposition === "leased" &&
      row.leaseGeneration === generation &&
      (workerId === undefined || row.leaseOwner === workerId)
    );
  }

  earliestRecoveryAt(): number | null {
    const row = this.sql
      .exec(
        `SELECT MIN(
           next_attempt_at
         ) AS due
           FROM effect_outbox
          WHERE disposition IN ('retrying', 'parked')`
      )
      .toArray()[0];
    const value = row?.["due"];
    return typeof value === "number" ? value : null;
  }
}
