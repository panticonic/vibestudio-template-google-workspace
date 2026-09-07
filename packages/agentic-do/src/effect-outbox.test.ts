import { describe, expect, it } from "vitest";
import { createInMemorySql, createTestDO } from "@workspace/runtime/worker/test-utils";
import type { SqlStorage } from "@workspace/runtime/worker";
import { GadWorkspaceDO } from "@workspace-workers/workspace-source";
import { EffectOutbox, maxAttempts } from "./effect-outbox.js";
import type { EffectDescriptor } from "@workspace/agent-loop";

describe("EffectOutbox host-generation claims", () => {
  it("never blindly retries a local mutation settlement boundary", () => {
    const descriptor = (cancellationMode: "interruptible" | "settle"): EffectDescriptor => ({
      kind: "local_tool",
      effectId: "effect-1",
      channelId: "channel-1",
      idempotencyKey: "tool-1",
      invocationId: "tool-1",
      turnId: "turn-1",
      invocationSeq: 1,
      executionMode: "sequential",
      cancellationMode,
      tool: "write",
      args: {},
    });

    expect(maxAttempts(descriptor("interruptible"))).toBe(3);
    expect(maxAttempts(descriptor("settle"))).toBe(1);
  });

  it("rejects an obsolete globally keyed outbox instead of replacing it", async () => {
    const sql = (await createInMemorySql()) as unknown as SqlStorage;
    sql.exec(`
      CREATE TABLE effect_outbox (
        effect_id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        descriptor_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        created_at INTEGER NOT NULL
      )
    `);

    expect(() => new EffectOutbox(sql)).toThrow(
      "Unsupported effect_outbox schema; delete this pre-release state"
    );
  });

  it("keeps a claimed deferred effect unavailable regardless of elapsed wall time", async () => {
    const host = await createTestDO(GadWorkspaceDO, { __objectKey: "outbox-lease-host" });
    const outbox = new EffectOutbox(host.sql as never);
    const now = 1_700_000_000_000;

    const descriptor = {
      kind: "channel_call",
      effectId: "eff-1",
      channelId: "chan-1",
      idempotencyKey: "idem-1",
      transportCallId: "tc-1",
      invocationId: "inv-1",
      method: "set_title",
      args: { title: "x" },
      target: { id: "do:x" },
    } as unknown as EffectDescriptor;

    // Appended due at its dispatch time `now`.
    outbox.insert("branch-1", descriptor, now);
    expect(outbox.get("branch-1", "eff-1")?.nextAttemptAt).toBe(now);

    const claims = outbox.claimReady({
      workerId: "worker-generation-1",
      now: now + 5,
      limit: 1,
    });
    expect(claims).toHaveLength(1);
    const leased = outbox.get("branch-1", "eff-1");
    expect(leased?.nextAttemptAt).toBeNull();
    expect(leased?.disposition).toBe("leased");
    expect(leased?.leaseOwner).toBe("worker-generation-1");
    expect(outbox.due(now + 10_000_000).some((r) => r.effectId === "eff-1")).toBe(false);

    // A concrete deferred outcome releases ownership and schedules its explicit
    // protocol backstop. Time controls that future retry, never the live claim.
    const deferAt = now + 8;
    const backstopMs = 60_000;
    host.sql.exec(
      `UPDATE effect_outbox
       SET lease_owner = NULL,
           disposition = 'parked',
           next_attempt_at = CASE
             WHEN next_attempt_at IS NOT NULL AND next_attempt_at <= ? THEN next_attempt_at
             ELSE ?
           END
       WHERE branch_id = ? AND effect_id = ?`,
      deferAt,
      deferAt + backstopMs,
      "branch-1",
      "eff-1"
    );
    expect(outbox.get("branch-1", "eff-1")?.nextAttemptAt).toBe(deferAt + backstopMs);
    expect(outbox.due(deferAt + 10).some((r) => r.effectId === "eff-1")).toBe(false); // backstopped
  });

  it("orders local-tool barriers by numeric invocation sequence, not lexical effect id", async () => {
    const host = await createTestDO(GadWorkspaceDO, { __objectKey: "outbox-order-host" });
    const outbox = new EffectOutbox(host.sql as never);
    const descriptor = (invocationSeq: number): EffectDescriptor => ({
      kind: "local_tool",
      effectId: `effect-${invocationSeq}`,
      channelId: "channel-1",
      idempotencyKey: `tool-${invocationSeq}`,
      invocationId: `tool-${invocationSeq}`,
      turnId: "turn-1",
      invocationSeq,
      executionMode: "sequential",
      cancellationMode: "interruptible",
      tool: `tool-${invocationSeq}`,
      args: {},
    });
    outbox.insert("branch-1", descriptor(10), 0);
    outbox.insert("branch-1", descriptor(2), 0);
    host.sql.exec(`UPDATE effect_outbox SET created_at = 1`);

    const claims = outbox.claimReady({
      workerId: "worker-generation-1",
      now: 2,
      limit: 1,
    });
    expect(claims.map((row) => row.descriptor)).toEqual([
      expect.objectContaining({ kind: "local_tool", invocationSeq: 2 }),
    ]);
  });

  it("preserves sequential invocation order across local and channel transports", async () => {
    const host = await createTestDO(GadWorkspaceDO, { __objectKey: "outbox-cross-order-host" });
    const outbox = new EffectOutbox(host.sql as never);
    const channel = {
      kind: "channel_call",
      effectId: "effect-channel",
      channelId: "channel-1",
      idempotencyKey: "transport-channel",
      transportCallId: "transport-channel",
      invocationId: "tool-channel",
      turnId: "turn-1",
      invocationSeq: 2,
      executionMode: "sequential",
      target: { id: "participant-1" },
      method: "render",
      args: {},
    } as unknown as EffectDescriptor;
    const local: EffectDescriptor = {
      kind: "local_tool",
      effectId: "effect-local",
      channelId: "channel-1",
      idempotencyKey: "tool-local",
      invocationId: "tool-local",
      turnId: "turn-1",
      invocationSeq: 1,
      executionMode: "sequential",
      cancellationMode: "interruptible",
      tool: "read",
      args: {},
    };
    // Insert the later transport first to prove creation order cannot overtake
    // the model's numeric invocation order.
    outbox.insert("branch-1", channel, 0);
    outbox.insert("branch-1", local, 0);
    host.sql.exec(`UPDATE effect_outbox SET created_at = 1`);

    const first = outbox.claimReady({ workerId: "worker-1", now: 2, limit: 64 });
    expect(first.map((row) => row.effectId)).toEqual(["effect-local"]);

    outbox.delete("branch-1", "effect-local");
    const second = outbox.claimReady({ workerId: "worker-1", now: 2, limit: 64 });
    expect(second.map((row) => row.effectId)).toEqual(["effect-channel"]);
  });

  it("dispatches one parallel invocation wave across local and HTTP transports", async () => {
    const host = await createTestDO(GadWorkspaceDO, {
      __objectKey: "outbox-cross-parallel-host",
    });
    const outbox = new EffectOutbox(host.sql as never);
    const local: EffectDescriptor = {
      kind: "local_tool",
      effectId: "effect-local",
      channelId: "channel-1",
      idempotencyKey: "tool-local",
      invocationId: "tool-local",
      turnId: "turn-1",
      invocationSeq: 1,
      executionMode: "parallel",
      cancellationMode: "interruptible",
      tool: "read",
      args: {},
    };
    const http: EffectDescriptor = {
      kind: "http_call",
      effectId: "effect-http",
      channelId: "channel-1",
      idempotencyKey: "transport-http",
      invocationId: "tool-http",
      turnId: "turn-1",
      invocationSeq: 2,
      executionMode: "parallel",
      target: { service: "remote", method: "query" },
      request: {},
    };
    outbox.insert("branch-1", http, 0);
    outbox.insert("branch-1", local, 0);
    host.sql.exec(`UPDATE effect_outbox SET created_at = 1`);

    const claims = outbox.claimReady({ workerId: "worker-1", now: 2, limit: 64 });
    expect(claims.map((row) => row.effectId)).toEqual(["effect-local", "effect-http"]);
  });
});
