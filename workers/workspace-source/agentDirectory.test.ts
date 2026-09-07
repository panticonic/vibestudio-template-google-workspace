/**
 * The agent directory (messaging plan §4.4) — a projection over presence, turn,
 * and message events this DO already ingests.
 *
 * The load-bearing property under test is that a directory hit is *addressable*:
 * every entry prints the exact `agent:<handle>@<channelId>` ref `notify`
 * accepts, and one worker in several channels is several rows rather than one
 * ambiguous one.
 */
import { describe, expect, it } from "vitest";
import {
  createTestDO as createBaseTestDO,
  successfulTestRpcFetch,
} from "@vibestudio/durable/test-utils";
import { logIdForChannel } from "@vibestudio/trajectory-identity";
import { AGENTIC_PROTOCOL_VERSION } from "@workspace/agentic-protocol";
import { GadWorkspaceDO } from "./index.js";

const createTestDO: typeof createBaseTestDO = (DOClass, env, opts) =>
  createBaseTestDO(DOClass, { RPC_FETCH: successfulTestRpcFetch, ...env }, opts);

type Call = <R>(method: string, ...args: unknown[]) => Promise<R>;

async function join(
  call: Call,
  input: {
    channelId: string;
    participantId: string;
    metadata: Record<string, unknown>;
    envelopeId?: string;
    at?: string;
    action?: "join" | "leave";
  }
): Promise<void> {
  await call("appendChannelEnvelope", {
    channelId: input.channelId,
    envelopeId: input.envelopeId ?? `env-${input.channelId}-${input.participantId}`,
    from: { kind: "agent", id: input.participantId, participantId: input.participantId },
    payloadKind: "presence",
    payload: { action: input.action ?? "join", metadata: input.metadata },
    publishedAt: input.at ?? "2026-05-20T12:00:00.000Z",
  });
}

async function appendTrajectory(
  call: Call,
  input: {
    channelId: string;
    participantId: string;
    events: Array<{ envelopeId: string; kind: string; payload: unknown; causality?: unknown }>;
    expectedHeadHash?: string | null;
  }
): Promise<void> {
  await call("appendLogEvent", {
    logId: logIdForChannel(input.channelId),
    head: "main",
    logKind: "trajectory",
    owner: { kind: "agent", id: input.participantId, participantId: input.participantId },
    events: input.events.map((entry) => ({
      envelopeId: entry.envelopeId,
      actor: { kind: "agent", id: input.participantId, participantId: input.participantId },
      payloadKind: entry.kind,
      payload: entry.payload,
      ...(entry.causality ? { causality: entry.causality } : {}),
      appendedAt: "2026-05-20T12:05:00.000Z",
    })),
  });
}

const AGENT_METADATA = {
  name: "Gmail Agent",
  type: "agent",
  handle: "gmail",
  description: "Triages the inbox and drafts replies.",
};

describe("agent directory", () => {
  it("projects a joining agent into an addressable directory entry", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await join(call, {
      channelId: "ch-mail",
      participantId: "do:gmail",
      metadata: AGENT_METADATA,
    });

    const listing = await call<any>("listAgentDirectory", {});
    expect(listing.summary).toMatchObject({ rows: 1, running: 0, terminal: 0 });
    expect(listing.entries[0]).toMatchObject({
      instanceId: "gmail@ch-mail",
      // This string is the contract: discovery output is notify input.
      ref: "agent:gmail@ch-mail",
      channelId: "ch-mail",
      participantId: "do:gmail",
      kind: "worker-agent",
      handle: "gmail",
      displayName: "Gmail Agent",
      description: "Triages the inbox and drafts replies.",
      workerId: "do:gmail",
      status: "idle",
    });
  });

  it("gives one worker in two channels two rows sharing a worker id", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await join(call, { channelId: "ch-a", participantId: "do:gmail", metadata: AGENT_METADATA });
    await join(call, { channelId: "ch-b", participantId: "do:gmail", metadata: AGENT_METADATA });

    const listing = await call<any>("listAgentDirectory", { workerId: "do:gmail" });
    // "Message the gmail agent" is meaningless without saying where, so the
    // two instances stay distinct rather than collapsing into one row.
    expect(listing.entries.map((entry: any) => entry.ref).sort()).toEqual([
      "agent:gmail@ch-a",
      "agent:gmail@ch-b",
    ]);
    expect(new Set(listing.entries.map((entry: any) => entry.workerId))).toEqual(
      new Set(["do:gmail"])
    );
  });

  it("does not list humans or panels as agent instances", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendChannelEnvelope", {
      channelId: "ch-home",
      envelopeId: "env-user-join",
      from: { kind: "panel", id: "user:gabriel", participantId: "user:gabriel" },
      payloadKind: "presence",
      payload: { action: "join", metadata: { name: "Gabriel", type: "user", handle: "gabriel" } },
      publishedAt: "2026-05-20T12:00:00.000Z",
    });

    const listing = await call<any>("listAgentDirectory", {});
    expect(listing.entries).toEqual([]);
  });

  it("flips status on lifecycle events and never on a clock", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await join(call, { channelId: "ch-mail", participantId: "do:gmail", metadata: AGENT_METADATA });

    await appendTrajectory(call, {
      channelId: "ch-mail",
      participantId: "do:gmail",
      events: [
        {
          envelopeId: "ev-turn-open",
          kind: "turn.opened",
          payload: { protocol: AGENTIC_PROTOCOL_VERSION },
          causality: { turnId: "turn-1" },
        },
      ],
    });
    let listing = await call<any>("listAgentDirectory", {});
    expect(listing.entries[0]).toMatchObject({
      status: "running",
      // The event that set it is recorded; nothing here consults elapsed time.
      statusEventId: "ev-turn-open",
    });

    await appendTrajectory(call, {
      channelId: "ch-mail",
      participantId: "do:gmail",
      events: [
        {
          envelopeId: "ev-turn-closed",
          kind: "turn.closed",
          payload: { protocol: AGENTIC_PROTOCOL_VERSION },
          causality: { turnId: "turn-1" },
        },
      ],
    });
    listing = await call<any>("listAgentDirectory", {});
    expect(listing.entries[0]).toMatchObject({ status: "idle", statusEventId: "ev-turn-closed" });
  });

  it("keeps a departed instance listed only when terminal rows are requested", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await join(call, { channelId: "ch-mail", participantId: "do:gmail", metadata: AGENT_METADATA });
    await join(call, {
      channelId: "ch-mail",
      participantId: "do:gmail",
      metadata: AGENT_METADATA,
      envelopeId: "env-leave",
      action: "leave",
      at: "2026-05-20T13:00:00.000Z",
    });

    expect((await call<any>("listAgentDirectory", {})).entries).toEqual([]);
    // A terminal instance whose channel is durable is exactly the catalog of
    // agents that can be woken again (plan §4.4).
    const withTerminal = await call<any>("listAgentDirectory", { includeTerminal: true });
    expect(withTerminal.entries[0]).toMatchObject({
      ref: "agent:gmail@ch-mail",
      status: "terminal",
    });
  });

  it("searches by purpose over description and the latest deliberate utterance", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await join(call, { channelId: "ch-mail", participantId: "do:gmail", metadata: AGENT_METADATA });
    await join(call, {
      channelId: "ch-build",
      participantId: "do:builder",
      metadata: { name: "Builder", type: "agent", handle: "builder", description: "Runs CI." },
    });

    expect(
      (await call<any>("searchAgentDirectory", { query: "inbox triage" })).entries.map(
        (entry: any) => entry.ref
      )
    ).toEqual(["agent:gmail@ch-mail"]);

    // A deliberate notify (wire saliency "say") is the instance's own account of
    // what it is doing, so it becomes searchable; turn narration does not.
    await appendTrajectory(call, {
      channelId: "ch-build",
      participantId: "do:builder",
      events: [
        {
          envelopeId: "ev-say",
          kind: "message.completed",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            role: "assistant",
            outcome: "completed",
            saliency: "say",
            blocks: [
              { blockId: "b1", type: "text", content: "Watching the nightly deployment pipeline." },
            ],
          },
          causality: { messageId: "msg-1" },
        },
      ],
    });

    const hits = await call<any>("searchAgentDirectory", { query: "deployment" });
    expect(hits.entries.map((entry: any) => entry.ref)).toEqual(["agent:builder@ch-build"]);
    expect(hits.entries[0].summary).toContain("nightly deployment");
  });

  it("describes channels with their directory participants and envelope stats", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await join(call, { channelId: "ch-mail", participantId: "do:gmail", metadata: AGENT_METADATA });
    await appendTrajectory(call, {
      channelId: "ch-mail",
      participantId: "do:gmail",
      events: [
        {
          envelopeId: "ev-turn-open",
          kind: "turn.opened",
          payload: { protocol: AGENTIC_PROTOCOL_VERSION },
          causality: { turnId: "turn-1" },
        },
      ],
    });

    const [described] = await call<any>("describeChannels", { channelIds: ["ch-mail"] });
    // One channel envelope: the presence join. The agent's turn lives on its
    // own trajectory log and is deliberately not counted as channel traffic.
    expect(described).toMatchObject({ channelId: "ch-mail", envelopeCount: 1 });
    expect(described.participants).toEqual([
      { participantId: "do:gmail", handle: "gmail", kind: "worker-agent", status: "running" },
    ]);
  });

  it("projects the channel's DURABLE subscription facts, not only presence signals", async () => {
    // What the channel actually appends when an agent joins, revises its
    // metadata (set_description), and leaves. Presence itself is a disposable
    // signal the channel never writes; a directory fed only by it stays empty.
    const { call } = await createTestDO(GadWorkspaceDO);
    const append = (
      envelopeId: string,
      payloadKind: string,
      payload: Record<string, unknown>,
      metadata: Record<string, unknown>
    ) =>
      call("appendChannelEnvelope", {
        channelId: "ch-sub",
        envelopeId,
        from: { kind: "agent", id: "do:gmail", participantId: "do:gmail", metadata },
        payloadKind,
        payload,
        publishedAt: "2026-05-20T12:00:00.000Z",
      });
    await append(
      "sub-1",
      "channel.subscription.opened",
      { participantId: "do:gmail", revision: 1, metadata: AGENT_METADATA },
      AGENT_METADATA
    );
    let listing = await call<{ entries: Array<Record<string, unknown>> }>("listAgentDirectory", {});
    expect(listing.entries).toEqual([
      expect.objectContaining({ instanceId: "gmail@ch-sub", status: "idle", handle: "gmail" }),
    ]);

    const revised = { ...AGENT_METADATA, description: "Triaging today's newsletters." };
    await append(
      "sub-2",
      "channel.subscription.revised",
      { participantId: "do:gmail", revision: 2, metadata: revised },
      revised
    );
    listing = await call("listAgentDirectory", {});
    expect(listing.entries[0]).toMatchObject({ description: "Triaging today's newsletters." });

    await append("sub-3", "channel.subscription.ended", { participantId: "do:gmail", revision: 3 }, revised);
    listing = await call("listAgentDirectory", {});
    expect(listing.entries).toEqual([]);
    listing = await call("listAgentDirectory", { includeTerminal: true });
    expect(listing.entries[0]).toMatchObject({ instanceId: "gmail@ch-sub", status: "terminal" });
  });
});
