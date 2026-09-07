import { beforeEach, describe, expect, it } from "vitest";
import { createInMemorySql } from "@workspace/runtime/worker/test-utils";
import type { SqlStorage } from "@workspace/runtime/worker";
import type { ChannelEvent } from "@workspace/pubsub";
import type { ChannelAgenticContext } from "@workspace/pubsub";
import {
  CHANNEL_DELIVERY_PROJECTION_VERSION,
  ChannelDeliveryProjection,
} from "./delivery-projection.js";

const CHANNEL_ID = "channel-projection-test";
const AGENT_ID = "do:workers/agent-worker:AiChatWorker:agent-a";

function event(
  id: number,
  type: string,
  payload: unknown,
  senderId = "panel:user",
  messageId = `event-${id}`
): ChannelEvent {
  return {
    id,
    type,
    payload,
    senderId,
    messageId,
    ts: id * 1_000,
  } as ChannelEvent;
}

function relationship(
  id: number,
  revision: number,
  type:
    | "channel.subscription.opened"
    | "channel.subscription.revised"
    | "channel.subscription.detached"
    | "channel.subscription.ended" = "channel.subscription.opened"
): ChannelEvent {
  return event(
    id,
    type,
    type === "channel.subscription.ended" || type === "channel.subscription.detached"
      ? {
          participantId: AGENT_ID,
          revision,
          ...(type === "channel.subscription.detached" ? { detachAfterSequence: 1 } : {}),
        }
      : {
          participantId: AGENT_ID,
          revision,
          delivery: "all",
          endpoint: {
            kind: "entity",
            entityId: AGENT_ID,
            invocation: "direct",
          },
          metadata: { type: "agent", handle: "agent-a" },
          applicationConfig: { version: 1, value: { respondPolicy: "always" } },
        },
    AGENT_ID
  );
}

function message(
  id: number,
  senderId = "panel:user",
  messageId = `message-${id}`,
  replyTo?: string
): ChannelEvent {
  return event(
    id,
    "agentic.trajectory.v1/event",
    {
      kind: "message.completed",
      actor: {
        kind: senderId.startsWith("do:") ? "agent" : "user",
        id: senderId,
      },
      causality: { messageId },
      payload: {
        protocol: "agentic.trajectory.v1",
        role: senderId.startsWith("do:") ? "assistant" : "user",
        blocks: [],
        outcome: "completed",
        ...(replyTo ? { replyTo } : {}),
      },
      createdAt: new Date(id * 1_000).toISOString(),
    },
    senderId,
    `envelope-${messageId}`
  );
}

function invocationTerminal(
  id: number,
  kind:
    | "invocation.completed"
    | "invocation.failed"
    | "invocation.cancelled"
    | "invocation.abandoned",
  senderId = AGENT_ID
): ChannelEvent {
  return event(
    id,
    "agentic.trajectory.v1/event",
    {
      kind,
      actor: { kind: "agent", id: senderId },
      causality: { invocationId: `invocation-${id}` },
      payload: {
        protocol: "agentic.trajectory.v1",
        to: [{ kind: "participant", participantId: senderId }],
      },
      createdAt: new Date(id * 1_000).toISOString(),
    },
    senderId,
    `terminal-${id}`
  );
}

function invocationOutput(id: number, senderId = AGENT_ID): ChannelEvent {
  return event(
    id,
    "agentic.trajectory.v1/event",
    {
      kind: "invocation.output",
      actor: { kind: "agent", id: senderId },
      causality: { invocationId: `invocation-${id}` },
      payload: {
        protocol: "agentic.trajectory.v1",
        output: { progress: 50 },
        to: [{ kind: "participant", participantId: senderId }],
      },
      createdAt: new Date(id * 1_000).toISOString(),
    },
    senderId,
    `output-${id}`
  );
}

describe("ChannelDeliveryProjection", () => {
  let sql: SqlStorage;
  let projection: ChannelDeliveryProjection;

  beforeEach(async () => {
    sql = (await createInMemorySql()) as unknown as SqlStorage;
    ChannelDeliveryProjection.createTables(sql);
    projection = new ChannelDeliveryProjection(sql, (callback) => callback(), CHANNEL_ID);
    projection.initializeChannelConfig({
      conversationPolicy: "directed",
      agentHopLimit: 4,
    });
  });

  it("replays a canonical append omitted before a simulated activation loss", () => {
    projection.fold(relationship(1, 1));
    expect(() => projection.fold(message(3))).toThrow(/expected 2, received 3/);

    const restarted = new ChannelDeliveryProjection(sql, (callback) => callback(), CHANNEL_ID);
    expect(restarted.fold(message(2)).inserted).toBe(1);
    expect(restarted.fold(message(3)).inserted).toBe(1);
    expect(restarted.cursor()).toBe(3);
    expect(
      sql.exec(`SELECT COUNT(*) AS count FROM channel_delivery_mailbox`).toArray()[0]?.["count"]
    ).toBe(2);
  });

  it("retains the append boundary as the delivery latency origin", () => {
    projection.fold(relationship(1, 1));
    projection.fold(message(2), 1_234);

    expect(sql.exec(`SELECT created_at FROM channel_delivery_mailbox`).toArray()).toEqual([
      { created_at: 1_234 },
    ]);
  });

  it("routes at event sequence and terminalizes work when the relationship departs", () => {
    projection.fold(relationship(1, 1));
    projection.fold(message(2));
    projection.fold(relationship(3, 2, "channel.subscription.ended"));
    expect(projection.fold(message(4)).inserted).toBe(0);
    projection.fold(relationship(5, 3));
    expect(projection.fold(message(6)).inserted).toBe(1);

    const rows = sql
      .exec(
        `SELECT event_sequence, subscription_revision, state
           FROM channel_delivery_mailbox ORDER BY event_sequence`
      )
      .toArray();
    expect(rows).toEqual([
      {
        event_sequence: 2,
        subscription_revision: 1,
        state: "terminal-departed",
      },
      { event_sequence: 6, subscription_revision: 3, state: "ready" },
    ]);
  });

  it("carries a blocked receiver debt across a same-endpoint revision", () => {
    projection.fold(relationship(1, 1));
    projection.fold(message(2));
    sql.exec(
      `UPDATE channel_delivery_mailbox
          SET state = 'retrying', attempts = 8, next_attempt_at = ?
        WHERE event_sequence = 2`,
      Date.now() + 30_000
    );

    projection.fold(relationship(3, 2, "channel.subscription.revised"));
    expect(projection.fold(message(4)).inserted).toBe(1);

    expect(
      sql
        .exec(
          `SELECT event_sequence, subscription_revision, state
             FROM channel_delivery_mailbox ORDER BY event_sequence`
        )
        .toArray()
    ).toEqual([
      { event_sequence: 2, subscription_revision: 1, state: "retrying" },
      { event_sequence: 4, subscription_revision: 2, state: "ready" },
    ]);
  });

  it("durably resumes a partially completed detached-range backfill", () => {
    const beforeDetach = message(2);
    const whileDetached = message(4);
    projection.fold(relationship(1, 1));
    projection.fold(beforeDetach);
    projection.fold(relationship(3, 2, "channel.subscription.detached"));
    expect(projection.fold(whileDetached).inserted).toBe(0);
    projection.fold(relationship(5, 3, "channel.subscription.revised"));

    expect(projection.pendingReattachBackfills()).toEqual([
      { participantId: AGENT_ID, afterSequence: 1, throughSequence: 4 },
    ]);
    expect(() => projection.fold(message(6))).toThrow(/while reattach recovery/);
    expect(projection.advanceReattachBackfill(beforeDetach, AGENT_ID)).toBe(1);

    // This is the activation-loss checkpoint: a new projection instance reads
    // the durable cursor and continues after the last atomically derived row.
    projection = new ChannelDeliveryProjection(sql, (callback) => callback(), CHANNEL_ID);
    expect(projection.pendingReattachBackfills()).toEqual([
      { participantId: AGENT_ID, afterSequence: 2, throughSequence: 4 },
    ]);
    expect(
      projection.advanceReattachBackfill(
        relationship(3, 2, "channel.subscription.detached"),
        AGENT_ID
      )
    ).toBe(0);
    expect(projection.advanceReattachBackfill(whileDetached, AGENT_ID)).toBe(1);
    expect(projection.pendingReattachBackfills()).toEqual([]);
    expect(
      sql
        .exec(
          `SELECT event_sequence, subscription_revision, state
             FROM channel_delivery_mailbox ORDER BY event_sequence, subscription_revision`
        )
        .toArray()
    ).toEqual([
      {
        event_sequence: 2,
        subscription_revision: 1,
        state: "terminal-retired",
      },
      { event_sequence: 2, subscription_revision: 3, state: "ready" },
      { event_sequence: 4, subscription_revision: 3, state: "ready" },
    ]);
  });

  it("places every outstanding delivery after the detach recovery boundary", () => {
    projection.fold(relationship(1, 1));
    projection.fold(message(2));
    projection.fold(message(3));
    sql.exec(
      `UPDATE channel_delivery_mailbox SET state = 'terminal-completed'
        WHERE event_sequence = 2`
    );

    expect(projection.detachRecoveryBoundary(AGENT_ID)).toBe(2);
    expect(projection.detachRecoveryBoundary(AGENT_ID, 1)).toBe(1);
  });

  it("re-derives terminal redelivery bytes from the canonical event", () => {
    const canonical = message(2);
    projection.fold(relationship(1, 1));
    projection.fold(canonical);
    sql.exec(
      `UPDATE channel_delivery_mailbox
          SET state = 'terminal-completed', envelope_json = NULL, agentic_context_json = NULL
        WHERE event_sequence = 2`
    );

    expect(projection.redeliverEventTo(canonical, AGENT_ID)).toBe(true);
    const row = sql
      .exec(`SELECT state, envelope_json FROM channel_delivery_mailbox WHERE event_sequence = 2`)
      .toArray()[0]!;
    expect(row["state"]).toBe("ready");
    expect(JSON.parse(String(row["envelope_json"]))).toMatchObject({
      kind: "log",
      event: { id: 2, messageId: canonical.messageId },
    });
  });

  it("delivers to a durable member without any activation-local transport", () => {
    projection.fold(relationship(1, 1));
    expect(projection.fold(message(2)).inserted).toBe(1);
    expect(projection.diagnostics(2)).toMatchObject({
      cursor: 2,
      lag: 0,
      memberships: [{ active: true, endpointKind: "entity", delivery: "all", count: 1 }],
      mailbox: [{ state: "ready", count: 1 }],
    });
  });

  it("delivers self-authored invocation responses to their parked caller", () => {
    projection.fold(relationship(1, 1));

    expect(projection.fold(invocationTerminal(2, "invocation.completed")).inserted).toBe(1);
    expect(projection.fold(invocationTerminal(3, "invocation.failed")).inserted).toBe(1);
    expect(projection.fold(invocationTerminal(4, "invocation.cancelled")).inserted).toBe(1);
    expect(projection.fold(invocationTerminal(5, "invocation.abandoned")).inserted).toBe(1);
    expect(projection.fold(invocationOutput(6)).inserted).toBe(1);

    expect(
      sql
        .exec(
          `SELECT event_sequence, participant_id
             FROM channel_delivery_mailbox ORDER BY event_sequence`
        )
        .toArray()
    ).toEqual([
      { event_sequence: 2, participant_id: AGENT_ID },
      { event_sequence: 3, participant_id: AGENT_ID },
      { event_sequence: 4, participant_id: AGENT_ID },
      { event_sequence: 5, participant_id: AGENT_ID },
      { event_sequence: 6, participant_id: AGENT_ID },
    ]);
  });

  it("continues to suppress ordinary self-authored messages", () => {
    projection.fold(relationship(1, 1));

    expect(projection.fold(message(2, AGENT_ID)).inserted).toBe(0);
    expect(
      sql.exec(`SELECT COUNT(*) AS count FROM channel_delivery_mailbox`).toArray()[0]?.["count"]
    ).toBe(0);
  });

  it("treats an all selector as addressed without opting the author into self-delivery", () => {
    const otherAgent = "do:workers/agent-worker:AiChatWorker:agent-b";
    projection.fold(
      event(1, "channel.subscription.opened", {
        participantId: AGENT_ID,
        revision: 1,
        delivery: "addressed",
        endpoint: { kind: "entity", entityId: AGENT_ID, invocation: "direct" },
        metadata: { type: "agent" },
      })
    );
    projection.fold(
      event(2, "channel.subscription.opened", {
        participantId: otherAgent,
        revision: 1,
        delivery: "addressed",
        endpoint: {
          kind: "entity",
          entityId: otherAgent,
          invocation: "direct",
        },
        metadata: { type: "agent" },
      })
    );
    const broadcast = event(
      3,
      "agentic.trajectory.v1/event",
      {
        kind: "ui.feedback",
        actor: { kind: "agent", id: AGENT_ID },
        payload: { protocol: "agentic.trajectory.v1", to: [{ kind: "all" }] },
        createdAt: new Date(3_000).toISOString(),
      },
      AGENT_ID
    );

    expect(projection.fold(broadcast).inserted).toBe(1);
    expect(sql.exec(`SELECT participant_id FROM channel_delivery_mailbox`).toArray()).toEqual([
      { participant_id: otherAgent },
    ]);
  });

  it("resets disposable state on a projection version change and preserves initial config", () => {
    projection.fold(relationship(1, 1));
    projection.fold(message(2));
    sql.exec(
      `UPDATE channel_delivery_projection_cursor SET projection_version = ? WHERE singleton = 1`,
      CHANNEL_DELIVERY_PROJECTION_VERSION - 1
    );

    expect(projection.cursor()).toBe(0);
    expect(
      sql.exec(`SELECT COUNT(*) AS count FROM channel_delivery_mailbox`).toArray()[0]?.["count"]
    ).toBe(0);
    projection.fold(relationship(1, 1));
    projection.fold(message(2));
    const context = JSON.parse(
      String(
        sql.exec(`SELECT agentic_context_json FROM channel_delivery_event_context`).toArray()[0]?.[
          "agentic_context_json"
        ]
      )
    ) as ChannelAgenticContext;
    expect(context.channelConfig).toEqual({
      conversationPolicy: "directed",
      agentHopLimit: 4,
    });
  });

  it("restores the durable fork boundary when a projection version changes", () => {
    const forked = new ChannelDeliveryProjection(
      sql,
      (callback) => callback(),
      CHANNEL_ID,
      () => 2
    );
    forked.resetForFork(2);
    forked.fold(relationship(1, 1));
    forked.fold(message(2));
    forked.fold(relationship(3, 1));
    sql.exec(
      `UPDATE channel_delivery_projection_cursor SET projection_version = ? WHERE singleton = 1`,
      CHANNEL_DELIVERY_PROJECTION_VERSION - 1
    );

    expect(forked.cursor()).toBe(0);
    expect(
      sql
        .exec(
          `SELECT fork_boundary_sequence FROM channel_delivery_projection_cursor WHERE singleton = 1`
        )
        .toArray()[0]?.["fork_boundary_sequence"]
    ).toBe(2);
    forked.fold(relationship(1, 1));
    forked.fold(message(2));
    forked.fold(relationship(3, 1));
    expect(forked.relationship(AGENT_ID)?.revision).toBe(1);
    expect(
      sql.exec(`SELECT COUNT(*) AS count FROM channel_delivery_mailbox`).toArray()[0]?.["count"]
    ).toBe(0);
  });

  it("co-derives conversation, configuration, roster, and reply identity", () => {
    projection.fold(relationship(1, 1));
    projection.fold(message(2, "panel:author", "origin"));
    projection.fold(
      event(3, "config-update", { conversationPolicy: "moderated", agentHopLimit: 2 }, "system")
    );
    projection.fold(message(4, "panel:reply", "reply", "origin"));

    const row = sql
      .exec(
        `SELECT agentic_context_json FROM channel_delivery_event_context WHERE event_id = ?`,
        "envelope-reply"
      )
      .toArray()[0]!;
    const context = JSON.parse(String(row["agentic_context_json"])) as ChannelAgenticContext;
    expect(context).toMatchObject({
      version: 1,
      channelConfig: { conversationPolicy: "moderated", agentHopLimit: 2 },
      conversation: {
        lastCompletedSender: "panel:reply",
        previousCompletedSender: "panel:author",
      },
      replyToSenderId: "panel:author",
      relationships: [
        {
          participantId: AGENT_ID,
          applicationConfig: { version: 1, value: { respondPolicy: "always" } },
        },
      ],
    });
  });

  it("stores one event context for every direct recipient instead of copying it per mailbox row", () => {
    projection.fold(relationship(1, 1));
    for (let index = 1; index < 12; index += 1) {
      const participantId = `do:workers/agent-worker:AiChatWorker:agent-${index}`;
      projection.fold(
        event(
          index + 1,
          "channel.subscription.opened",
          {
            participantId,
            revision: 1,
            delivery: "all",
            endpoint: {
              kind: "entity",
              entityId: participantId,
              invocation: "direct",
            },
            metadata: { type: "agent", handle: `agent-${index}` },
            applicationConfig: null,
          },
          participantId
        )
      );
    }

    expect(projection.fold(message(13)).inserted).toBe(12);
    expect(
      sql
        .exec(
          `SELECT COUNT(*) AS deliveries,
                  SUM(CASE WHEN agentic_context_json IS NULL THEN 1 ELSE 0 END) AS empty_contexts
             FROM channel_delivery_mailbox`
        )
        .toArray()[0]
    ).toEqual({ deliveries: 12, empty_contexts: 12 });
    const contextStorage = sql
      .exec(
        `SELECT COUNT(*) AS contexts,
                SUM(LENGTH(agentic_context_json)) AS bytes
           FROM channel_delivery_event_context`
      )
      .toArray()[0]!;
    expect(contextStorage["contexts"]).toBe(1);
    const normalizedBytes = Number(contextStorage["bytes"]);
    expect(normalizedBytes).toBeGreaterThan(0);
    expect(normalizedBytes * 12).toBeGreaterThan(normalizedBytes);
  });
});
