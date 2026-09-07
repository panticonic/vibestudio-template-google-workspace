/**
 * Method-call transport (WS2 §5) — `pending_calls` as a DECLARED CACHE.
 *
 * Authority: a call is pending ⟺ its `invocation.started` has no terminal in
 * the durable log. The SQLite rows exist only for dispatch state and deadline
 * alarms; `derivePendingCalls(fold(log))` reconstructs them at any time
 * (cache amnesia, P3).
 *
 * The settle pipeline appends the durable terminal FIRST (deterministic
 * envelopeId `terminal:{transportCallId}`), deletes the row second, and
 * broadcasts last — the old lost-terminal crash window (row deleted, append
 * never ran) is structurally impossible.
 */

import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  type AgenticEvent,
  type AppendIdempotency,
  type InvocationOutcome,
  type LogEnvelope,
  type ParticipantRef,
} from "@workspace/agentic-protocol";
import type { ChannelEvent } from "@workspace/pubsub";
import type { SqlStorage } from "@workspace/runtime/worker";
import type { ChannelCallEventBuilders } from "@workspace/channel-policies";
import type { StoredAttachment } from "./types.js";
import type { ChannelLog } from "./log-store.js";

/** A promise plus its resolver, used as a start-journaling barrier. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export interface PendingCallRow {
  transportCallId: string;
  invocationId: string;
  turnId?: string;
  callerId: string;
  targetId: string;
  method: string;
  args?: unknown;
  createdAt: number;
  deadlineAt?: number;
}

export type SubmitterCallResolution =
  | { kind: "pending"; pending: PendingCallRow }
  | { kind: "terminal"; eventId: number }
  | { kind: "missing" };

const TERMINAL_KINDS = new Set([
  "invocation.completed",
  "invocation.failed",
  "invocation.cancelled",
  "invocation.abandoned",
]);

/** Pure fold: pending ⟺ channel-transport invocation.started without a
 *  terminal carrying the same transportCallId (WS2 §5.4). */
export function derivePendingCalls(envelopes: LogEnvelope[]): PendingCallRow[] {
  const pending = new Map<string, PendingCallRow>();
  for (const envelope of envelopes) {
    if (envelope.payloadKind !== AGENTIC_EVENT_PAYLOAD_KIND) continue;
    const event = envelope.payload as AgenticEvent | null;
    if (!event || typeof event !== "object") continue;
    const kind = (event as { kind?: string }).kind ?? "";
    const causality = ((event as { causality?: Record<string, unknown> }).causality ??
      {}) as Record<string, unknown>;
    const payload = ((event as { payload?: Record<string, unknown> }).payload ?? {}) as Record<
      string,
      unknown
    >;
    const transport = (payload["transport"] ?? {}) as Record<string, unknown>;
    const transportCallId =
      typeof causality["transportCallId"] === "string"
        ? (causality["transportCallId"] as string)
        : typeof transport["transportCallId"] === "string"
          ? (transport["transportCallId"] as string)
          : null;
    if (!transportCallId) continue;
    if (kind === "invocation.started") {
      if (transport["kind"] !== "channel") continue;
      const actor = (event as { actor?: { id?: string; participantId?: string } }).actor ?? {};
      const target = (transport["target"] ?? {}) as {
        id?: string;
        participantId?: string;
      };
      const invocationId =
        typeof causality["invocationId"] === "string"
          ? (causality["invocationId"] as string)
          : transportCallId;
      pending.set(transportCallId, {
        transportCallId,
        invocationId,
        ...(typeof (event as { turnId?: string }).turnId === "string"
          ? { turnId: (event as { turnId?: string }).turnId }
          : {}),
        callerId: actor.participantId ?? actor.id ?? "unknown",
        targetId: target.participantId ?? target.id ?? "unknown",
        method: typeof payload["name"] === "string" ? (payload["name"] as string) : "unknown",
        ...(payload["request"] !== undefined ? { args: payload["request"] } : {}),
        createdAt: Date.parse(envelope.appendedAt),
        ...(typeof transport["deadlineAt"] === "number"
          ? { deadlineAt: transport["deadlineAt"] as number }
          : {}),
      });
      continue;
    }
    if (TERMINAL_KINDS.has(kind)) pending.delete(transportCallId);
  }
  return [...pending.values()];
}

export interface CallTransportDeps {
  sql: SqlStorage;
  objectKey: string;
  log: ChannelLog;
  builders(): ChannelCallEventBuilders;
  /** Append through the DO's policy pipeline (annotate + append + fold). */
  appendDurable(input: {
    type: string;
    payload: unknown;
    senderId: string;
    senderMetadata?: Record<string, unknown>;
    messageId?: string;
    idempotency?: AppendIdempotency;
    attachments?: StoredAttachment[];
    deliveryStartedAt?: number;
  }): Promise<ChannelEvent>;
  broadcastLive(
    event: ChannelEvent,
    senderId: string,
    ref?: number,
    structuredPublisherId?: string
  ): void;
  emitSignal(participantId: string, event: ChannelEvent): void;
  redeliverDurableEvent(participantId: string, eventId: string): Promise<boolean>;
  participantRef(participantId: string): ParticipantRef;
  getSenderMetadata(participantId: string): Record<string, unknown> | undefined;
  participantTransport(
    participantId: string
  ): "external-session" | "entity" | "resident-session" | null;
  rpcCall(targetId: string, method: string, args: unknown[]): Promise<unknown>;
  waitUntil(promise: Promise<unknown>): void;
  getStateValue(key: string): string | null;
  setStateValue(key: string, value: string): void;
  recordLatency(
    metric:
      | "publish-to-recipient-execution"
      | "call-to-provider-execution"
      | "result-to-caller-settlement",
    durationMs: number
  ): void;
}

export class CallTransport {
  private readonly providerDispatchId = crypto.randomUUID();
  private providerDispatchSequence = 0;

  constructor(private readonly deps: CallTransportDeps) {}

  /**
   * In-flight `callMethod` start-journaling, keyed by transportCallId. The
   * durable `started` append is a cross-DO RPC to GAD; until it RESOLVES the
   * row exists in neither the SQLite cache (insertRow runs after) nor the
   * durable log a concurrent `submitMethodResult` can reconcile from (GAD's
   * txn hasn't committed). A result racing INTO that window — the target
   * already holds the call from a prior delivery / redrive and replies while a
   * re-issued `callMethod` is still appending — would see "no pending row, no
   * durable started" and fall through to the lost-call recovery, appending a
   * SYNTHETIC started + terminal instead of settling against the real one.
   *
   * The settle/submit paths await this barrier before concluding the call is
   * missing, so the canonical started is always visible first. Mirrors
   * `publishDedupInFlight` in channel-do.ts. Cleared in a `finally`, so an
   * append failure never wedges later submits.
   */
  private readonly startInFlight = new Map<string, Promise<void>>();

  /** Await (and forget) any in-flight start for this call so a concurrent
   *  settle/submit observes the canonical started after it commits. */
  private async awaitInFlightStart(transportCallId: string): Promise<void> {
    const inFlight = this.startInFlight.get(transportCallId);
    if (inFlight) await inFlight.catch(() => {});
  }

  // ── pending_calls cache rows ──────────────────────────────────────────────

  private insertRow(row: PendingCallRow): void {
    // A re-call with the same transportCallId (nudge redrive) must NOT reset
    // the expiry clock — keep the ORIGINAL created_at so timeouts fire from
    // first issuance, not from the latest retry.
    const existing = this.peek(row.transportCallId);
    if (existing) row = { ...row, createdAt: existing.createdAt };
    this.deps.sql.exec(
      `INSERT OR REPLACE INTO pending_calls (
         transport_call_id, invocation_id, turn_id, caller_id, target_id,
         method, args, created_at, deadline_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.transportCallId,
      row.invocationId,
      row.turnId ?? null,
      row.callerId,
      row.targetId,
      row.method,
      row.args !== undefined ? JSON.stringify(row.args) : null,
      row.createdAt,
      row.deadlineAt ?? null
    );
  }

  peek(transportCallId: string): PendingCallRow | null {
    const rows = this.deps.sql
      .exec(`SELECT * FROM pending_calls WHERE transport_call_id = ?`, transportCallId)
      .toArray();
    if (rows.length === 0) return null;
    return this.rowFrom(rows[0] as Record<string, unknown>);
  }

  pendingTarget(transportCallId: string): string | null {
    return this.peek(transportCallId)?.targetId ?? null;
  }

  pendingFor(targetId: string): PendingCallRow[] {
    return (
      this.deps.sql
        .exec(`SELECT * FROM pending_calls WHERE target_id = ?`, targetId)
        .toArray() as Record<string, unknown>[]
    ).map((row) => this.rowFrom(row));
  }

  private rowFrom(row: Record<string, unknown>): PendingCallRow {
    let args: unknown;
    const raw = row["args"];
    if (typeof raw === "string") {
      try {
        args = JSON.parse(raw);
      } catch {
        args = undefined;
      }
    }
    return {
      transportCallId: String(row["transport_call_id"]),
      invocationId: String(row["invocation_id"]),
      ...(row["turn_id"] ? { turnId: String(row["turn_id"]) } : {}),
      callerId: String(row["caller_id"]),
      targetId: String(row["target_id"]),
      method: String(row["method"]),
      ...(args !== undefined ? { args } : {}),
      createdAt: Number(row["created_at"] ?? 0),
      ...(row["deadline_at"] != null ? { deadlineAt: Number(row["deadline_at"]) } : {}),
    };
  }

  private deleteRow(transportCallId: string): void {
    this.deps.sql.exec(`DELETE FROM pending_calls WHERE transport_call_id = ?`, transportCallId);
    this.deps.sql.exec(
      `DELETE FROM provider_call_claims WHERE transport_call_id = ?`,
      transportCallId
    );
  }

  claimProviderCall(
    participantId: string,
    transportCallId: string,
    providerGenerationId: string
  ): { claimed: boolean; generation?: number } {
    const pending = this.peek(transportCallId);
    if (!pending || pending.targetId !== participantId) return { claimed: false };
    const existing = this.deps.sql
      .exec(`SELECT * FROM provider_call_claims WHERE transport_call_id = ?`, transportCallId)
      .toArray()[0];
    if (
      existing &&
      String(existing["provider_id"]) === participantId &&
      String(existing["provider_generation_id"]) === providerGenerationId
    ) {
      return {
        claimed: true,
        generation: Number(existing["claim_generation"]),
      };
    }
    const generation = Number(existing?.["claim_generation"] ?? 0) + 1;
    const claimedAt = Date.now();
    this.deps.sql.exec(
      `INSERT OR REPLACE INTO provider_call_claims (
         transport_call_id, provider_id, provider_generation_id, claim_generation, claimed_at
       ) VALUES (?, ?, ?, ?, ?)`,
      transportCallId,
      participantId,
      providerGenerationId,
      generation,
      claimedAt
    );
    return { claimed: true, generation };
  }

  markProviderCallExecutionStarted(
    participantId: string,
    transportCallId: string,
    generation: number
  ): boolean {
    const pending = this.peek(transportCallId);
    if (!pending || pending.targetId !== participantId) return false;
    const startedAt = Date.now();
    const updated = this.deps.sql
      .exec(
        `UPDATE provider_call_claims
            SET execution_started_at = ?
          WHERE transport_call_id = ? AND provider_id = ? AND claim_generation = ?
            AND execution_started_at IS NULL
          RETURNING transport_call_id`,
        startedAt,
        transportCallId,
        participantId,
        generation
      )
      .toArray();
    if (updated.length > 0) {
      this.deps.recordLatency(
        "call-to-provider-execution",
        Math.max(0, startedAt - pending.createdAt)
      );
      return true;
    }
    // The response to the first mark may be lost after SQLite commits. The
    // provider must be allowed to repeat the same generation's admission;
    // returning false here would acknowledge the durable mailbox copy while
    // preventing either copy from ever entering the handler. A superseded
    // generation still fails this exact-current-claim check.
    return this.isCurrentProviderClaim(transportCallId, participantId, generation);
  }

  isCurrentProviderClaim(
    transportCallId: string,
    participantId: string,
    generation: number | undefined
  ): boolean {
    if (!Number.isSafeInteger(generation) || generation! < 1) return false;
    return (
      this.deps.sql
        .exec(
          `SELECT 1 FROM provider_call_claims
            WHERE transport_call_id = ? AND provider_id = ? AND claim_generation = ?`,
          transportCallId,
          participantId,
          generation
        )
        .toArray().length > 0
    );
  }

  async abortProviderCall(pending: PendingCallRow): Promise<void> {
    const transport = this.deps.participantTransport(pending.targetId);
    if (transport !== "resident-session" && transport !== "entity") return;
    try {
      await this.deps.rpcCall(
        pending.targetId,
        transport === "entity" ? "cancelDirectMethodCall" : "cancelChannelInvocation",
        transport === "entity"
          ? [this.deps.objectKey, pending.transportCallId]
          : [
              {
                channelId: this.deps.objectKey,
                transportCallId: pending.transportCallId,
              },
            ]
      );
    } catch (error) {
      console.warn(
        `[Channel] provider cancellation delivery failed for ${pending.transportCallId}:`,
        error
      );
    }
  }

  private pendingFromStartedEvent(event: ChannelEvent, fallback: PendingCallRow): PendingCallRow {
    const agentic = event.payload as AgenticEvent | null;
    if (!agentic || typeof agentic !== "object" || agentic.kind !== "invocation.started") {
      return fallback;
    }
    const causality = (agentic.causality ?? {}) as Record<string, unknown>;
    const payload = (agentic.payload ?? {}) as Record<string, unknown>;
    const transport = (payload["transport"] ?? {}) as Record<string, unknown>;
    const actor = (agentic.actor ?? {}) as {
      id?: string;
      participantId?: string;
    };
    const target = (transport["target"] ?? {}) as {
      id?: string;
      participantId?: string;
    };
    const createdAt =
      typeof agentic.createdAt === "string" ? Date.parse(agentic.createdAt) : Number.NaN;

    return {
      transportCallId:
        typeof causality["transportCallId"] === "string"
          ? (causality["transportCallId"] as string)
          : fallback.transportCallId,
      invocationId:
        typeof causality["invocationId"] === "string"
          ? (causality["invocationId"] as string)
          : fallback.invocationId,
      ...(typeof agentic.turnId === "string" ? { turnId: agentic.turnId } : {}),
      callerId: actor.participantId ?? actor.id ?? fallback.callerId,
      targetId: target.participantId ?? target.id ?? fallback.targetId,
      method: typeof payload["name"] === "string" ? (payload["name"] as string) : fallback.method,
      ...(payload["request"] !== undefined ? { args: payload["request"] } : {}),
      createdAt: Number.isFinite(createdAt) ? createdAt : fallback.createdAt,
      ...(typeof transport["deadlineAt"] === "number"
        ? { deadlineAt: transport["deadlineAt"] as number }
        : fallback.deadlineAt != null
          ? { deadlineAt: fallback.deadlineAt }
          : {}),
    };
  }

  // ── callMethod — journal before dispatch (P2, WS2 §5.2) ──────────────────

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
    }
  ): Promise<void> {
    const transportCallId = opts?.transportCallId ?? callId;

    // Publish the in-flight barrier BEFORE the first await so any concurrent
    // submitMethodResult for this call observes it and waits for the canonical
    // started to commit (durable + cached) instead of treating the call as a
    // lost record and synthesizing a recovery started/terminal. A redrive that
    // races the target's reply is the realistic trigger. Cleared in `finally`
    // — an append failure resolves the barrier so later submits aren't wedged.
    const startBarrier = deferred();
    this.startInFlight.set(transportCallId, startBarrier.promise);
    const dispatch = await (async () => {
      try {
        return await this.journalCallStart(callerPid, targetPid, callId, method, args, opts);
      } finally {
        startBarrier.resolve();
        if (this.startInFlight.get(transportCallId) === startBarrier.promise) {
          this.startInFlight.delete(transportCallId);
        }
      }
    })();
    if (dispatch) await dispatch();
  }

  /** Journal the started + cache row + broadcast. Returns a dispatcher thunk to
   *  run AFTER the in-flight barrier resolves (the cache row is visible by then,
   *  so a settle triggered by dispatch never races the start). */
  private async journalCallStart(
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
    }
  ): Promise<(() => Promise<void>) | null> {
    const transportCallId = opts?.transportCallId ?? callId;
    const invocationId = opts?.invocationId ?? callId;
    const turnId = opts?.turnId;
    const deadlineAt =
      opts?.timeoutMs && opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : undefined;
    const createdAt = new Date().toISOString();

    // Idempotent re-call: when the caller redrives a call whose terminal is
    // already durable (it missed the outcome broadcast), do NOT resurrect a
    // pending row — that wedges the call forever (the target dedups
    // redeliveries; reconcile skips because the head didn't move). Re-deliver
    // the journaled terminal instead so the caller can settle.
    const existingTerminal = await this.deps.log.getEventByEnvelopeId(
      `terminal:${transportCallId}`
    );
    if (existingTerminal) {
      this.deleteRow(transportCallId);
      console.log(
        `[Channel] callMethod re-drive for settled call ${transportCallId}: ` +
          `re-broadcasting durable terminal (seq ${existingTerminal.id})`
      );
      this.deps.broadcastLive(
        existingTerminal,
        existingTerminal.senderId ?? callerPid,
        undefined,
        targetPid
      );
      await this.deps.redeliverDurableEvent(callerPid, existingTerminal.messageId);
      return null;
    }

    // 1. APPEND the durable started intention (deterministic envelopeId =
    //    invocationId). Re-drives of a still-pending call carry volatile
    //    createdAt/request fields; the journaled first start wins by id.
    const payload = this.deps.builders().started({
      channelId: this.deps.objectKey,
      caller: this.deps.participantRef(callerPid),
      target: this.deps.participantRef(targetPid),
      invocationId,
      transportCallId,
      ...(turnId ? { turnId } : {}),
      method,
      args,
      ...(deadlineAt != null ? { deadlineAt } : {}),
      createdAt,
    });
    const callEvent = await this.deps.appendDurable({
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload,
      senderId: callerPid,
      senderMetadata: this.deps.getSenderMetadata(callerPid),
      messageId: invocationId,
      idempotency: "idempotent-by-id",
    });
    const fallbackRow: PendingCallRow = {
      transportCallId,
      invocationId,
      ...(turnId ? { turnId } : {}),
      callerId: callerPid,
      targetId: targetPid,
      method,
      ...(args !== undefined ? { args } : {}),
      createdAt: Date.now(),
      ...(deadlineAt != null ? { deadlineAt } : {}),
    };
    const pendingRow = this.pendingFromStartedEvent(callEvent, fallbackRow);

    const terminalAfterStart = await this.deps.log.getEventByEnvelopeId(
      `terminal:${pendingRow.transportCallId}`
    );
    if (terminalAfterStart) {
      this.deleteRow(pendingRow.transportCallId);
      this.deps.broadcastLive(
        terminalAfterStart,
        terminalAfterStart.senderId ?? callerPid,
        undefined,
        pendingRow.targetId
      );
      await this.deps.redeliverDurableEvent(callerPid, terminalAfterStart.messageId);
      return null;
    }

    // 2. cache row, 3. alarm, 4. broadcast
    this.insertRow(pendingRow);
    this.recordObservedHead(callEvent.id);
    this.deps.broadcastLive(callEvent, callerPid);

    return () => this.dispatchCallStart(pendingRow);
  }

  private async dispatchCallStart(pendingRow: PendingCallRow): Promise<void> {
    // 5. dispatch
    const transport = this.deps.participantTransport(pendingRow.targetId);
    if (transport === null) {
      const message =
        `Target ${pendingRow.targetId} is not joined to channel ${this.deps.objectKey}; ` +
        "chat.callMethod is channel-scoped and only routes to live participants in this channel";
      await this.settleCall(pendingRow.transportCallId, { error: message }, true);
      return;
    }
    if (transport === "entity") {
      this.deps.waitUntil(
        this.deliverDoMethodCall({
          targetPid: pendingRow.targetId,
          transportCallId: pendingRow.transportCallId,
          invocationId: pendingRow.invocationId,
          turnId: pendingRow.turnId,
          method: pendingRow.method,
          args: pendingRow.args,
        })
      );
    } else if (transport === "resident-session") {
      // Claim fencing inside the provider makes this direct attempt and the
      // authoritative mailbox delivery one semantic execution. A refused or
      // lost fast path is harmless: the mailbox row remains ready.
      this.deps.waitUntil(this.deliverResidentFastPath(pendingRow));
    }
    // RPC participants AND RPC-style DO clients receive the durable invocation start through the log
    // broadcast and reply via submitMethodResult.
  }

  private async deliverResidentFastPath(pendingRow: PendingCallRow): Promise<void> {
    try {
      const event = await this.deps.log.getEventByEnvelopeId(pendingRow.invocationId);
      if (!event) return;
      await this.deps.rpcCall(pendingRow.targetId, "acceptChannelInvocation", [
        {
          channelId: this.deps.objectKey,
          message: { kind: "log", phase: "live", event },
        },
      ]);
    } catch {
      // The mailbox is authority; fast-path refusal is expected while the
      // resident provider is hibernated or between registrations.
    }
  }

  private async deliverDoMethodCall(input: {
    targetPid: string;
    transportCallId: string;
    invocationId: string;
    turnId?: string;
    method: string;
    args: unknown;
  }): Promise<void> {
    const claim = this.claimProviderCall(
      input.targetPid,
      input.transportCallId,
      `${this.providerDispatchId}:${++this.providerDispatchSequence}`
    );
    if (!claim.claimed || !claim.generation) return;
    try {
      this.markProviderCallExecutionStarted(
        input.targetPid,
        input.transportCallId,
        claim.generation
      );
      const result = await this.deps.rpcCall(input.targetPid, "onMethodCall", [
        this.deps.objectKey,
        input.transportCallId,
        input.method,
        input.args,
        { invocationId: input.invocationId, turnId: input.turnId },
      ]);
      const res = result as { result: unknown; isError?: boolean };
      if (!this.isCurrentProviderClaim(input.transportCallId, input.targetPid, claim.generation)) {
        return;
      }
      await this.settleCall(input.transportCallId, res.result, !!res.isError);
    } catch (err) {
      if (!this.isCurrentProviderClaim(input.transportCallId, input.targetPid, claim.generation)) {
        return;
      }
      await this.settleCall(
        input.transportCallId,
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }

  // ── settleCall — terminal ordering fixed (WS2 §5.3, THE bug fix) ─────────

  async settleCall(
    transportCallId: string,
    result: unknown,
    isError: boolean,
    terminalOutcome?: InvocationOutcome,
    terminalReasonCode?: string,
    opts?: {
      attachments?: StoredAttachment[];
      /** Pre-built terminal event (cancel/timeout paths use the `cancelled`
       *  builder with actor system). */
      eventOverride?: AgenticEvent;
      senderId?: string;
    }
  ): Promise<number | undefined> {
    const deliveryStartedAt = Date.now();
    // 0. If a callMethod start for this call is still journaling, wait for it
    // to commit so the canonical started/row is visible — never settle against
    // a half-written start.
    await this.awaitInFlightStart(transportCallId);

    // 1. READ, do not delete. pending_calls is a declared cache, so a submit
    // racing with replay/resubscribe may arrive after the durable start is
    // visible but before the row exists locally. Reconcile from the log before
    // deciding the result is unknown.
    let pending = this.peek(transportCallId);
    if (!pending) {
      const existingTerminal = await this.deps.log.getEventByEnvelopeId(
        `terminal:${transportCallId}`
      );
      if (existingTerminal) return existingTerminal.id;
      await this.reconcilePendingCalls(true);
      pending = this.peek(transportCallId);
    }
    if (!pending) {
      const existingTerminal = await this.deps.log.getEventByEnvelopeId(
        `terminal:${transportCallId}`
      );
      if (existingTerminal) return existingTerminal.id;
      console.log(
        `[Channel] method result without a live pending call (already terminal or unknown): ` +
          `channel=${this.deps.objectKey} transportCallId=${transportCallId} isError=${isError}`
      );
      return undefined;
    }

    // 2. Root the terminal (synthetic started if the canonical one is absent).
    await this.ensureMethodRoot(pending);

    // 3. APPEND the terminal FIRST, deterministic id. A duplicate settle after
    //    a crash-between-append-and-delete finds the terminal already durable
    //    and skips straight to consuming the row.
    const terminalEnvelopeId = `terminal:${transportCallId}`;
    let event = await this.deps.log.getEventByEnvelopeId(terminalEnvelopeId);
    if (!event) {
      const payload =
        opts?.eventOverride ??
        this.deps.builders().terminal({
          descriptor: {
            channelId: this.deps.objectKey,
            caller: this.deps.participantRef(pending.callerId),
            invocationId: pending.invocationId,
            transportCallId: pending.transportCallId,
            method: pending.method,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
          },
          result,
          isError,
          ...(terminalOutcome ? { terminalOutcome } : {}),
          ...(terminalReasonCode ? { terminalReasonCode } : {}),
          createdAt: new Date().toISOString(),
        });
      event = await this.deps.appendDurable({
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload,
        senderId: opts?.senderId ?? pending.callerId,
        messageId: terminalEnvelopeId,
        idempotency: "idempotent-by-id",
        deliveryStartedAt,
        ...(opts?.attachments ? { attachments: opts.attachments } : {}),
      });
    }

    // 4. consume the cache row AFTER the durable append; 5. alarm; 6. broadcast.
    this.deleteRow(transportCallId);
    this.recordObservedHead(event.id);
    const sender = opts?.senderId ?? pending.callerId;
    const callerPresent =
      opts?.senderId != null || this.deps.participantTransport(pending.callerId) !== null;
    if (callerPresent) {
      this.deps.broadcastLive(event, sender, undefined, pending.targetId);
    }
    return event.id;
  }

  /**
   * Settle a call for which NO pending row exists and reconcile found no durable
   * `invocation.started` either — a cache-cold / lost record (the started append
   * never landed, or its envelope is gone). A naive drop strands the caller
   * forever: its parked invocation is keyed on `transportCallId`/`invocationId`
   * and only settles on a terminal carrying the same ids.
   *
   * We refuse to silently no-op the fold. The submitter knows the call's
   * identity (it just executed it): `participantId` is the target, and the
   * caller passes `invocationId` (the id its `routeInvocationTerminal` matches
   * on) + `turnId` through `submitMethodResult`. We synthesize a minimal
   * pending descriptor from that, root the method via the SANCTIONED
   * `ensureMethodRoot` (which appends a synthetic `started` keyed on the
   * invocation id, satisfying the fold's started⟂terminal pairing), then append
   * + broadcast the terminal exactly as `settleCall` does. The caller now gets a
   * real terminal instead of hanging.
   *
   * `callerId` is genuinely unknown here (the started that named it is missing),
   * so we use a sentinel and FORCE the broadcast — the caller is a remote
   * subscriber matching by `invocationId`, not by being the terminal's sender.
   */
  async settleMissingCall(
    targetId: string,
    transportCallId: string,
    result: unknown,
    isError: boolean,
    opts?: {
      invocationId?: string;
      callerId?: string;
      turnId?: string;
      terminalOutcome?: InvocationOutcome;
      terminalReasonCode?: string;
      attachments?: StoredAttachment[];
    }
  ): Promise<number | undefined> {
    const deliveryStartedAt = Date.now();
    // The terminal must carry the invocationId the caller parked on. The
    // submitter forwards it; fall back to transportCallId (callMethod's own
    // default when no explicit invocationId is supplied).
    const invocationId = opts?.invocationId ?? transportCallId;
    const synthetic: PendingCallRow = {
      transportCallId,
      invocationId,
      ...(opts?.turnId ? { turnId: opts.turnId } : {}),
      callerId: opts?.callerId ?? "unknown",
      targetId,
      method: "unknown",
      createdAt: Date.now(),
    };

    // 1. Root the method (synthetic `started`, idempotent on invocationId).
    await this.ensureMethodRoot(synthetic);

    // 2. APPEND the terminal FIRST (deterministic envelopeId), mirroring
    //    settleCall. Idempotent: a concurrent/duplicate settle finds it durable.
    const terminalEnvelopeId = `terminal:${transportCallId}`;
    let event = await this.deps.log.getEventByEnvelopeId(terminalEnvelopeId);
    if (!event) {
      const payload = this.deps.builders().terminal({
        descriptor: {
          channelId: this.deps.objectKey,
          caller: this.deps.participantRef(synthetic.callerId),
          invocationId: synthetic.invocationId,
          transportCallId: synthetic.transportCallId,
          method: synthetic.method,
          ...(synthetic.turnId ? { turnId: synthetic.turnId } : {}),
        },
        result,
        isError,
        ...(opts?.terminalOutcome ? { terminalOutcome: opts.terminalOutcome } : {}),
        ...(opts?.terminalReasonCode ? { terminalReasonCode: opts.terminalReasonCode } : {}),
        createdAt: new Date().toISOString(),
      });
      event = await this.deps.appendDurable({
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload,
        senderId: synthetic.callerId,
        messageId: terminalEnvelopeId,
        idempotency: "idempotent-by-id",
        deliveryStartedAt,
        ...(opts?.attachments ? { attachments: opts.attachments } : {}),
      });
    }

    // 3. There is no cache row to consume. Record head, schedule, and FORCE the
    //    broadcast — the caller is a subscriber matching by invocationId.
    this.recordObservedHead(event.id);
    this.deps.broadcastLive(event, synthetic.callerId, undefined, synthetic.targetId);
    await this.deps.redeliverDurableEvent(synthetic.callerId, event.messageId);
    return event.id;
  }

  /** Before any output/terminal append: if no envelope with the invocation id
   *  exists in the log, append a synthetic started so terminals never orphan. */
  private async ensureMethodRoot(pending: PendingCallRow): Promise<void> {
    if (await this.deps.log.hasEnvelope(pending.invocationId)) return;
    const payload = this.deps.builders().started({
      channelId: this.deps.objectKey,
      caller: this.deps.participantRef(pending.callerId),
      target: this.deps.participantRef(pending.targetId ?? "unknown"),
      invocationId: pending.invocationId,
      transportCallId: pending.transportCallId,
      ...(pending.turnId ? { turnId: pending.turnId } : {}),
      method: pending.method ?? "unknown",
      args: pending.args,
      createdAt: new Date().toISOString(),
    });
    await this.deps.appendDurable({
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload,
      senderId: pending.callerId,
      senderMetadata: this.deps.getSenderMetadata(pending.callerId),
      messageId: pending.invocationId,
      idempotency: "idempotent-by-id",
    });
  }

  // ── submit / progress ─────────────────────────────────────────────────────

  async resolveSubmitterForCall(
    participantId: string,
    transportCallId: string,
    operation: "submitMethodResult" | "submitMethodProgress"
  ): Promise<SubmitterCallResolution> {
    // Wait out any concurrent callMethod start-journaling for this call: the
    // result must not be classified `missing` (→ lost-call recovery) while the
    // canonical started is still being appended. After the barrier the started
    // is durable and the row is cached, so the normal pending/terminal paths
    // resolve it.
    await this.awaitInFlightStart(transportCallId);

    let pending = this.peek(transportCallId);
    if (!pending) {
      const existingTerminal = await this.deps.log.getEventByEnvelopeId(
        `terminal:${transportCallId}`
      );
      if (existingTerminal) return { kind: "terminal", eventId: existingTerminal.id };

      await this.reconcilePendingCalls(true);
      pending = this.peek(transportCallId);
    }

    if (!pending) {
      const existingTerminal = await this.deps.log.getEventByEnvelopeId(
        `terminal:${transportCallId}`
      );
      if (existingTerminal) return { kind: "terminal", eventId: existingTerminal.id };
      return { kind: "missing" };
    }

    if (pending.targetId !== participantId) {
      throw new Error(
        `${operation} rejected: participant ${participantId} is not target ${pending.targetId} ` +
          `for method call ${transportCallId}`
      );
    }
    return { kind: "pending", pending };
  }

  async submitMethodProgress(
    transportCallId: string,
    content: unknown,
    opts?: { attachments?: StoredAttachment[] }
  ): Promise<void> {
    const pending = this.peek(transportCallId);
    if (!pending) return;
    await this.ensureMethodRoot(pending);
    const payload = this.deps.builders().output({
      descriptor: {
        channelId: this.deps.objectKey,
        caller: this.deps.participantRef(pending.callerId),
        invocationId: pending.invocationId,
        transportCallId: pending.transportCallId,
        method: pending.method,
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
      },
      output: content,
      createdAt: new Date().toISOString(),
    });
    const event = await this.deps.appendDurable({
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload,
      senderId: pending.callerId,
      ...(opts?.attachments ? { attachments: opts.attachments } : {}),
    });
    this.recordObservedHead(event.id);
    this.deps.broadcastLive(event, pending.callerId, undefined, pending.targetId);
  }

  // ── cancel / timeout / abandon ────────────────────────────────────────────

  async cancelMethodCall(
    callId: string,
    reason = "cancelled",
    expectedCallerId?: string
  ): Promise<PendingCallRow | null> {
    // Settle against the committed start, never a half-written one (a cancel
    // racing a redrive's start would otherwise no-op or recover spuriously).
    await this.awaitInFlightStart(callId);
    let pending = this.peek(callId);
    if (!pending) {
      // Cache-cold: the row may live in the durable log but not yet in the
      // SQLite cache (post-eviction / reload). Reconcile then peek again before
      // concluding the call is gone — otherwise a legitimate cancel/timeout
      // silently no-ops and the call hangs (mirrors settleCall / resolveSubmitter).
      const existingTerminal = await this.deps.log.getEventByEnvelopeId(`terminal:${callId}`);
      if (existingTerminal) {
        return null;
      }
      await this.reconcilePendingCalls(true);
      pending = this.peek(callId);
    }
    if (!pending) {
      return null;
    }
    if (expectedCallerId !== undefined && pending.callerId !== expectedCallerId) {
      throw new Error(
        `cancelMethodCall rejected: participant ${expectedCallerId} did not initiate method call ${callId}`
      );
    }
    const event = this.deps.builders().cancelled({
      descriptor: {
        channelId: this.deps.objectKey,
        caller: this.deps.participantRef(pending.callerId),
        invocationId: pending.invocationId,
        transportCallId: pending.transportCallId,
        method: pending.method,
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
      },
      actor: this.deps.participantRef("system"),
      reason,
      createdAt: new Date().toISOString(),
    });
    await this.settleCall(callId, reason, true, "cancelled", "cancelled", {
      eventOverride: event,
      senderId: "system",
    });
    return pending;
  }

  /** Abandoned terminals for every pending call targeting a leaver —
   *  peek-then-settle per call, never bulk-delete-then-append.
   *
   *  `aborted-by-fork` is the fork-rewiring reason (C6): a recursive clone
   *  could not re-home a call whose target did not follow the fork, so the
   *  parked caller is settled aborted (terminalReasonCode `aborted-by-fork`)
   *  rather than left hanging until the deadline. */
  async failPendingCallsTargeting(
    targetId: string,
    reason: "graceful" | "disconnect" | "replaced" | "aborted-by-fork"
  ): Promise<number> {
    const rows = this.pendingFor(targetId);
    if (rows.length === 0) return 0;
    const errorMessage =
      reason === "graceful"
        ? `Target ${targetId} left the channel before the call completed`
        : reason === "disconnect"
          ? `Target ${targetId} disconnected from the channel before the call completed`
          : reason === "replaced"
            ? `Target ${targetId} was replaced by a new session before the call completed`
            : `Target ${targetId} did not follow the fork; its pending call was aborted`;
    for (const row of rows) {
      try {
        await this.settleCall(
          row.transportCallId,
          { error: errorMessage },
          true,
          "abandoned",
          reason
        );
        await this.abortProviderCall(row);
      } catch (err) {
        console.warn(
          `[Channel] failPendingCallsTargeting: settle failed for ${row.transportCallId}:`,
          err
        );
      }
    }
    console.log(
      `[Channel] Cancelled ${rows.length} pending call(s) targeting ${targetId} (${reason})`
    );
    return rows.length;
  }

  /** Re-emit still-pending calls targeting a subscribed participant. Delivery
   * is at-least-once; invocation ids make receiver execution idempotent. */
  async redeliverPendingCallsTo(participantId: string): Promise<number> {
    const rows = this.pendingFor(participantId);
    if (rows.length === 0) return 0;
    const terminalEnvelopeIds = await this.deps.log.hasEnvelopes(
      rows.map((row) => `terminal:${row.transportCallId}`)
    );
    let redelivered = 0;
    let pruned = 0;
    for (const row of rows) {
      if (terminalEnvelopeIds.has(`terminal:${row.transportCallId}`)) {
        this.deleteRow(row.transportCallId);
        pruned += 1;
        continue;
      }
      const payload = this.deps.builders().started({
        channelId: this.deps.objectKey,
        caller: this.deps.participantRef(row.callerId),
        target: this.deps.participantRef(participantId),
        invocationId: row.invocationId,
        transportCallId: row.transportCallId,
        ...(row.turnId ? { turnId: row.turnId } : {}),
        method: row.method,
        args: row.args,
        ...(row.deadlineAt != null ? { deadlineAt: row.deadlineAt } : {}),
        createdAt: new Date().toISOString(),
      });
      const transport = this.deps.participantTransport(participantId);
      if (transport === "entity") {
        // Agent vessels execute method calls only through the structured
        // onMethodCall boundary. Their subscription response owns membership
        // but intentionally is not a second semantic delivery path.
        await this.dispatchCallStart(row);
      } else if (transport === "resident-session") {
        await this.deps.redeliverDurableEvent(participantId, row.invocationId);
      } else {
        this.deps.emitSignal(participantId, {
          id: 0,
          messageId: row.invocationId,
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          payload,
          senderId: row.callerId,
          senderMetadata: this.deps.getSenderMetadata(row.callerId),
          ts: Date.now(),
        });
      }
      redelivered += 1;
    }
    if (redelivered > 0 || pruned > 0) {
      console.log(
        `[Channel] Redelivered ${redelivered} pending call(s) to ${participantId}` +
          (pruned > 0 ? ` (${pruned} stale row(s) pruned)` : "")
      );
    }
    return redelivered;
  }

  async timeoutExpiredPendingCalls(
    onTimeout: (pending: PendingCallRow, reason: string) => Promise<void>
  ): Promise<void> {
    const rows = this.deps.sql
      .exec(
        `SELECT transport_call_id FROM pending_calls
          WHERE deadline_at IS NOT NULL AND deadline_at <= ?`,
        Date.now()
      )
      .toArray();
    for (const row of rows) {
      const transportCallId = String(row["transport_call_id"]);
      const pending = await this.cancelMethodCall(
        transportCallId,
        "Channel method deadline expired"
      );
      if (pending) await onTimeout(pending, "method call deadline expired");
    }
  }

  nextCallDeadlineAt(): number | null {
    const deadline = this.deps.sql
      .exec(`SELECT MIN(deadline_at) AS deadline FROM pending_calls WHERE deadline_at IS NOT NULL`)
      .toArray()[0]?.["deadline"];
    return typeof deadline === "number" ? deadline : null;
  }

  // ── reconcile — the convergence sweep (WS2 §5.4) ─────────────────────────

  private recordObservedHead(seq: number): void {
    const current = Number(this.deps.getStateValue("calls_reconciled_through") ?? 0);
    if (seq > current) this.deps.setStateValue("calls_reconciled_through", String(seq));
  }

  async reconcilePendingCalls(force = false): Promise<{ inserted: number; deleted: number }> {
    const headSeq = await this.deps.log.headSeq();
    if (!force) {
      const through = Number(this.deps.getStateValue("calls_reconciled_through") ?? -1);
      if (through === headSeq) return { inserted: 0, deleted: 0 };
    }
    const envelopes: LogEnvelope[] = [];
    let afterSeq = 0;
    for (;;) {
      const page = await this.deps.log.read({
        afterSeq,
        limit: 500,
        payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      });
      if (page.length === 0) break;
      envelopes.push(...page);
      afterSeq = page[page.length - 1]!.seq;
      if (page.length < 500) break;
    }
    const derived = derivePendingCalls(envelopes);
    const derivedByKey = new Map(derived.map((row) => [row.transportCallId, row]));
    const existing = (
      this.deps.sql.exec(`SELECT * FROM pending_calls`).toArray() as Record<string, unknown>[]
    ).map((row) => this.rowFrom(row));
    let inserted = 0;
    let deleted = 0;
    for (const row of existing) {
      if (!derivedByKey.has(row.transportCallId)) {
        this.deleteRow(row.transportCallId);
        deleted += 1;
      } else {
        derivedByKey.delete(row.transportCallId);
      }
    }
    for (const row of derivedByKey.values()) {
      this.insertRow(row);
      inserted += 1;
    }
    for (const claim of this.deps.sql
      .exec(`SELECT transport_call_id FROM provider_call_claims`)
      .toArray()) {
      const transportCallId = String(claim["transport_call_id"]);
      if (!this.peek(transportCallId)) {
        this.deps.sql.exec(
          `DELETE FROM provider_call_claims WHERE transport_call_id = ?`,
          transportCallId
        );
      }
    }
    this.deps.setStateValue("calls_reconciled_through", String(headSeq));
    return { inserted, deleted };
  }
}
