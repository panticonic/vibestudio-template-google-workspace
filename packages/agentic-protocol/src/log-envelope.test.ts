import { describe, expect, it } from "vitest";
import {
  LOG_GENESIS_HASH,
  GENESIS_EVENT_HASH,
  brandId,
  checkLogIntegrity,
  computeLogEnvelopeHash,
  logEnvelopeSchema,
  logEnvelopeSemantic,
  storedAgenticEventSchema,
  verifyLogEnvelopeHash,
  type EnvelopeId,
  type LogEnvelope,
  type ParticipantRef,
} from "./index.js";

const actor: ParticipantRef = { kind: "agent", id: "agent-1" };

async function buildChain(input: {
  logId: string;
  head: string;
  payloads: Array<{ payloadKind: string; payload: unknown }>;
  startPrevHash?: string;
  startSeq?: number;
}): Promise<LogEnvelope[]> {
  const envelopes: LogEnvelope[] = [];
  let prevHash = input.startPrevHash ?? LOG_GENESIS_HASH;
  let seq = input.startSeq ?? 1;
  for (const { payloadKind, payload } of input.payloads) {
    const envelope: Omit<LogEnvelope, "hash"> = {
      logId: input.logId,
      head: input.head,
      seq,
      envelopeId: brandId<EnvelopeId>(`env-${input.logId}-${input.head}-${seq}`),
      actor,
      payloadKind,
      payload,
      appendedAt: "2026-06-11T00:00:00.000Z",
      prevHash,
    };
    const hash = await computeLogEnvelopeHash({
      prevHash: envelope.prevHash,
      logId: envelope.logId,
      head: envelope.head,
      seq: envelope.seq,
      semantic: logEnvelopeSemantic(envelope as LogEnvelope),
    });
    const full: LogEnvelope = { ...envelope, hash };
    envelopes.push(full);
    prevHash = hash;
    seq += 1;
  }
  return envelopes;
}

const trajectoryPayloads = [
  {
    payloadKind: "turn.opened",
    payload: { protocol: "agentic.trajectory.v1", summary: "start" },
  },
  {
    payloadKind: "message.completed",
    payload: {
      protocol: "agentic.trajectory.v1",
      outcome: "completed",
      blocks: [{ type: "text", content: "hello" }],
    },
  },
  {
    payloadKind: "turn.closed",
    payload: { protocol: "agentic.trajectory.v1" },
  },
];

const channelPayloads = [
  { payloadKind: "presence", payload: { state: "online", who: "user-1" } },
  { payloadKind: "custom/opaque", payload: { anything: [1, 2, 3], nested: { ok: true } } },
];

describe("log envelope hashing", () => {
  it("re-exports the genesis hash", () => {
    expect(LOG_GENESIS_HASH).toBe(GENESIS_EVENT_HASH);
    expect(LOG_GENESIS_HASH).toBe("0".repeat(64));
  });

  it("round-trips computeLogEnvelopeHash through verifyLogEnvelopeHash", async () => {
    const [envelope] = await buildChain({
      logId: "traj-1",
      head: "main",
      payloads: trajectoryPayloads.slice(0, 1),
    });
    expect(envelope).toBeDefined();
    await expect(verifyLogEnvelopeHash(envelope!)).resolves.toBe(true);
  });

  it("rejects a tampered hash", async () => {
    const [envelope] = await buildChain({
      logId: "traj-1",
      head: "main",
      payloads: trajectoryPayloads.slice(0, 1),
    });
    await expect(verifyLogEnvelopeHash({ ...envelope!, hash: "f".repeat(64) })).resolves.toBe(
      false
    );
  });

  it("excludes logId/head/seq/prevHash/hash from the semantic slice and omits absent optionals", async () => {
    const [envelope] = await buildChain({
      logId: "traj-1",
      head: "main",
      payloads: trajectoryPayloads.slice(0, 1),
    });
    const semantic = logEnvelopeSemantic(envelope!);
    expect(Object.keys(semantic).sort()).toEqual([
      "actor",
      "appendedAt",
      "envelopeId",
      "payload",
      "payloadKind",
    ]);
  });

  it("covers to/annotations/causality in the semantic slice when present", async () => {
    const base = (
      await buildChain({ logId: "traj-1", head: "main", payloads: trajectoryPayloads.slice(0, 1) })
    )[0]!;
    const enriched: LogEnvelope = {
      ...base,
      to: { kind: "all" },
      annotations: { agentHops: 1 },
      causality: { originLogId: "traj-0", originEnvelopeId: "env-0", turnId: "turn-1" },
    };
    const semantic = logEnvelopeSemantic(enriched);
    expect(semantic["to"]).toEqual({ kind: "all" });
    expect(semantic["annotations"]).toEqual({ agentHops: 1 });
    expect(semantic["causality"]).toEqual({
      originLogId: "traj-0",
      originEnvelopeId: "env-0",
      turnId: "turn-1",
    });
    // The enriched envelope no longer verifies against the original hash.
    await expect(verifyLogEnvelopeHash(enriched)).resolves.toBe(false);
  });
});

describe("checkLogIntegrity", () => {
  it("accepts a valid trajectory-shaped chain", async () => {
    const chain = await buildChain({ logId: "traj-1", head: "main", payloads: trajectoryPayloads });
    const result = await checkLogIntegrity(chain);
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("accepts a valid opaque channel chain through the same code path", async () => {
    const chain = await buildChain({ logId: "chan-1", head: "main", payloads: channelPayloads });
    const result = await checkLogIntegrity(chain);
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("verifies mixed logs independently by (logId, head)", async () => {
    const trajectory = await buildChain({
      logId: "traj-1",
      head: "main",
      payloads: trajectoryPayloads,
    });
    const channel = await buildChain({ logId: "chan-1", head: "main", payloads: channelPayloads });
    const result = await checkLogIntegrity([...channel, ...trajectory]);
    expect(result.ok).toBe(true);
  });

  it("catches a seq gap", async () => {
    const chain = await buildChain({ logId: "traj-1", head: "main", payloads: trajectoryPayloads });
    const gapped = [chain[0]!, chain[2]!];
    const result = await checkLogIntegrity(gapped);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("seq gap"))).toBe(true);
  });

  it("catches a broken prevHash link", async () => {
    const chain = await buildChain({ logId: "traj-1", head: "main", payloads: trajectoryPayloads });
    const broken = chain.map((envelope) =>
      envelope.seq === 2 ? { ...envelope, prevHash: "a".repeat(64) } : envelope
    );
    // Re-hash seq 2 so only the linkage is broken, not the per-envelope hash.
    const tampered = await Promise.all(
      broken.map(async (envelope) =>
        envelope.seq === 2
          ? {
              ...envelope,
              hash: await computeLogEnvelopeHash({
                prevHash: envelope.prevHash,
                logId: envelope.logId,
                head: envelope.head,
                seq: envelope.seq,
                semantic: logEnvelopeSemantic(envelope),
              }),
            }
          : envelope
      )
    );
    const result = await checkLogIntegrity(tampered);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("prevHash"))).toBe(true);
    // seq 3 also breaks because its prevHash no longer matches seq 2's new hash.
  });

  it("catches a tampered payload", async () => {
    const chain = await buildChain({ logId: "chan-1", head: "main", payloads: channelPayloads });
    const tampered = chain.map((envelope) =>
      envelope.seq === 1 ? { ...envelope, payload: { state: "offline" } } : envelope
    );
    const result = await checkLogIntegrity(tampered);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("hash mismatch"))).toBe(true);
  });

  it("catches a wrong start prevHash when startPrevHashByLog is given", async () => {
    const chain = await buildChain({ logId: "traj-1", head: "fork", payloads: trajectoryPayloads });
    const result = await checkLogIntegrity(chain, {
      startPrevHashByLog: { "traj-1 fork": "b".repeat(64) },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("expected start"))).toBe(true);
  });

  it("accepts a forked chain whose start prevHash matches startPrevHashByLog", async () => {
    const forkHash = "c".repeat(64);
    const chain = await buildChain({
      logId: "traj-1",
      head: "fork",
      payloads: trajectoryPayloads,
      startPrevHash: forkHash,
      startSeq: 4,
    });
    const result = await checkLogIntegrity(chain, {
      startPrevHashByLog: { "traj-1 fork": forkHash },
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("accepts any start when the log has no startPrevHashByLog key", async () => {
    const chain = await buildChain({
      logId: "traj-2",
      head: "main",
      payloads: trajectoryPayloads,
      startPrevHash: "d".repeat(64),
    });
    const result = await checkLogIntegrity(chain, { startPrevHashByLog: {} });
    expect(result.ok).toBe(true);
  });
});

describe("logEnvelopeSchema", () => {
  it("parses a valid envelope", async () => {
    const [envelope] = await buildChain({
      logId: "chan-1",
      head: "main",
      payloads: channelPayloads.slice(0, 1),
    });
    expect(logEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it("rejects an empty payloadKind and unknown keys", async () => {
    const [envelope] = await buildChain({
      logId: "chan-1",
      head: "main",
      payloads: channelPayloads.slice(0, 1),
    });
    expect(logEnvelopeSchema.safeParse({ ...envelope, payloadKind: "" }).success).toBe(false);
    expect(logEnvelopeSchema.safeParse({ ...envelope, extra: true }).success).toBe(false);
    expect(logEnvelopeSchema.safeParse({ ...envelope, seq: -1 }).success).toBe(false);
    expect(logEnvelopeSchema.safeParse({ ...envelope, hash: "" }).success).toBe(false);
  });
});

describe("new event kinds", () => {
  const base = { actor, createdAt: "2026-06-11T00:00:00.000Z" };

  it("parses memory.recalled", () => {
    const event = {
      ...base,
      kind: "memory.recalled",
      payload: {
        protocol: "agentic.trajectory.v1",
        query: "what changed in the build system",
        results: [{ score: 0.9 }],
        anchors: ["env-1"],
        metadata: { recallRun: 1 },
      },
    };
    expect(storedAgenticEventSchema.safeParse(event).success).toBe(true);
  });

  it("parses build.completed", () => {
    const event = {
      ...base,
      kind: "build.completed",
      payload: {
        protocol: "agentic.trajectory.v1",
        inputStateHash: "state:abc",
        subtree: "panels/chat",
        evHash: "ev:123",
        artifactRefs: { bundle: "blob:1" },
        diagnostics: [],
        metadata: { durationMs: 1200 },
      },
    };
    expect(storedAgenticEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects unknown event kinds", () => {
    const event = {
      ...base,
      kind: "memory.unknown",
      payload: { protocol: "agentic.trajectory.v1" },
    };
    expect(storedAgenticEventSchema.safeParse(event).success).toBe(false);
  });
});
