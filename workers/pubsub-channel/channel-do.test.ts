import { describe, expect, it, vi } from "vitest";
import { rpcMethodAuthority } from "@vibestudio/rpc";
import { successfulTestRpcFetch } from "@vibestudio/durable/test-utils";
import {
  createTestDO,
  createTestDirectAuthority,
} from "@workspace/runtime/worker/test-utils";
import { ledgerTest } from "../../tests/helpers/ledgerTest.js";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  type AgenticEvent,
  type BlockId,
} from "@workspace/agentic-protocol";
import { GadWorkspaceDO } from "@workspace-workers/workspace-source";
import { PubSubChannel } from "./channel-do.js";

type TestDO<T> = Awaited<ReturnType<typeof createTestDO<T>>>;
const sessionWrappedInstances = new WeakSet<object>();
const subscriptionSinks = new WeakMap<
  object,
  { emitted?: unknown[]; emittedTargets?: string[] }
>();
const testSubscriptions = new WeakMap<
  object,
  Map<string, ReadableStreamDefaultReader<Uint8Array>>
>();

function testSubscriptionKey(
  participantId: string,
  subscriptionId: string,
): string {
  return `${participantId}\u0000${subscriptionId}`;
}

async function closeTestSubscription(
  instance: PubSubChannel,
  participantId: string,
  deliveryId: string,
): Promise<void> {
  const reader = testSubscriptions
    .get(instance)
    ?.get(testSubscriptionKey(participantId, deliveryId));
  if (!reader) return;
  testSubscriptions
    .get(instance)
    ?.delete(testSubscriptionKey(participantId, deliveryId));
  await reader.cancel();
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setRpcCaller(
  instance: PubSubChannel,
  callerId: string | null,
  callerKind: string | null,
  callerPanelId?: string | null,
  userId?: string,
): void {
  if (!sessionWrappedInstances.has(instance)) {
    sessionWrappedInstances.add(instance);
    const original = instance.subscribe.bind(instance);
    (
      instance as unknown as { subscribe: PubSubChannel["subscribe"] }
    ).subscribe = async (participantId, metadata, subscriptionId) => {
      const caller = (
        instance as unknown as {
          _currentVerifiedCaller?: {
            callerId?: string;
            callerPanelId?: string;
          };
        }
      )._currentVerifiedCaller;
      const deliveryId =
        caller?.callerPanelId ?? caller?.callerId ?? participantId;
      const ownedSubscriptionId = subscriptionId ?? deliveryId;
      const response = await original(
        participantId,
        metadata,
        ownedSubscriptionId,
      );
      if (!response.body) throw new Error("test subscription returned no body");
      const reader = response.body.getReader();
      const firstChunk = await reader.read();
      const first = firstChunk.done
        ? null
        : (JSON.parse(new TextDecoder().decode(firstChunk.value).trim()) as {
            kind?: string;
            result?: Record<string, unknown>;
          });
      if (first?.kind !== "subscribed" || !first.result) {
        throw new Error("test subscription did not receive its ACK");
      }
      const result = first.result;
      const canonicalParticipantId = String(
        result["participantId"] ?? participantId,
      );
      const byKey = testSubscriptions.get(instance) ?? new Map();
      testSubscriptions.set(instance, byKey);
      byKey.set(
        testSubscriptionKey(canonicalParticipantId, ownedSubscriptionId),
        reader,
      );
      const sink = subscriptionSinks.get(instance);
      void (async () => {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          const record = JSON.parse(
            new TextDecoder().decode(chunk.value).trim(),
          ) as {
            kind?: string;
            payload?: unknown;
          };
          if (record.kind !== "message") continue;
          sink?.emitted?.push(record.payload);
          sink?.emittedTargets?.push(participantId);
        }
      })();
      // Unit tests call the method directly, so surface the first stream record
      // while the reader above continues to own the real response resource.
      return result as unknown as Response;
    };
  }
  (
    instance as unknown as { _currentRpcCallerId: string | null }
  )._currentRpcCallerId = callerId;
  (
    instance as unknown as { _currentRpcCallerKind: string | null }
  )._currentRpcCallerKind = callerKind;
  (
    instance as unknown as { _currentRpcCallerPanelId: string | null }
  )._currentRpcCallerPanelId = callerPanelId ?? null;
  (
    instance as unknown as { _currentVerifiedCaller: unknown }
  )._currentVerifiedCaller = callerId
    ? {
        callerId,
        callerKind: callerKind ?? "unknown",
        ...(callerPanelId ? { callerPanelId } : {}),
        ...(userId ? { userId } : {}),
      }
    : null;
}

async function joinEntity(
  instance: PubSubChannel,
  participantId: string,
  metadata: Record<string, unknown> = { name: "Agent", type: "agent" },
  contextId = "ctx-1",
): Promise<void> {
  setRpcCaller(instance, participantId, "durable-object");
  await instance.join({
    participantId,
    revision: 1,
    contextId,
    metadata,
    delivery: "all",
    endpoint: { kind: "entity", entityId: participantId, invocation: "direct" },
    applicationConfig: null,
    replay: true,
  });
}

async function joinResidentSession(
  instance: PubSubChannel,
  participantId: string,
  metadata: Record<string, unknown> = {
    name: "Resident client",
    type: "client",
  },
  contextId = "ctx-1",
): Promise<void> {
  setRpcCaller(instance, participantId, "durable-object");
  await instance.join({
    participantId,
    revision: 1,
    contextId,
    metadata,
    delivery: "all",
    endpoint: {
      kind: "entity",
      entityId: participantId,
      invocation: "mailbox",
    },
    applicationConfig: null,
    replay: true,
  });
}

function agenticEvent(kind = "message.completed") {
  return {
    kind,
    actor: { kind: "user", id: "panel:user" },
    causality: { messageId: "msg-1" },
    payload: {
      protocol: "agentic.trajectory.v1",
      role: "user",
      blocks: [{ blockId: "msg-1:block:0", type: "text", content: "hello" }],
      outcome: "completed",
    },
    createdAt: new Date().toISOString(),
  };
}

function messageTypeRegisteredEvent(
  typeId: string,
  code = "export default function App() { return null; }",
  imports?: Record<string, string>,
) {
  return {
    kind: "messageType.registered",
    actor: { kind: "panel", id: "panel:user" },
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      typeId,
      displayMode: "row",
      source: { type: "code", code },
      ...(imports ? { imports } : {}),
    },
    createdAt: new Date().toISOString(),
  };
}

async function createGadBackedChannel(
  options: {
    emitted?: unknown[];
    emittedTargets?: string[];
    channelKey?: string;
    gad?: TestDO<GadWorkspaceDO>;
    db?: TestDO<PubSubChannel>["db"];
    blobstorePutText?: (
      value: string,
    ) => Promise<{ digest: string; size: number }>;
    rpcCall?: (
      target: string,
      method: string,
      args: unknown[],
      options?: { readOnly?: boolean; timeoutMs?: number },
    ) => Promise<unknown> | unknown;
  } = {},
) {
  const gad =
    options.gad ??
    (await createTestDO(GadWorkspaceDO, {
      __objectKey: "workspace",
      RPC_FETCH: successfulTestRpcFetch,
    }));
  const channel = await createTestDO(
    PubSubChannel,
    {
      __objectKey: options.channelKey ?? "channel-1",
    },
    options.db ? { db: options.db } : undefined,
  );
  subscriptionSinks.set(channel.instance, {
    emitted: options.emitted,
    emittedTargets: options.emittedTargets,
  });
  const gadTarget = "do:workers/workspace-source:GadWorkspaceDO:workspace";
  const blobs = new Map<string, string>();
  // Inject a mock RPC client. The DO base now holds a ConnectionlessRpcClient
  // ({ client, respond, deliver }) behind the `rpc` getter; pre-setting
  // `_connectionless` short-circuits the real (network) client construction.
  const mockClient = {
    emit: vi.fn(async (target: string, _event: string, payload: unknown) => {
      options.emittedTargets?.push(target);
      options.emitted?.push(payload);
    }),
    call: vi.fn(
      async (
        target: string,
        method: string,
        args: unknown[],
        callOptions?: { readOnly?: boolean; timeoutMs?: number },
      ) => {
        const custom = await options.rpcCall?.(
          target,
          method,
          args,
          callOptions,
        );
        if (custom !== undefined) return custom;
        if (target === "main" && method === "workers.resolveService") {
          return {
            kind: "durable-object",
            source: "vibestudio/internal",
            className: "GadWorkspaceDO",
            objectKey: "workspace",
            targetId: gadTarget,
          };
        }
        if (target === "main" && method === "runtime.setTitle") {
          // Title registry isn't relevant in unit tests; treat as a no-op.
          return undefined;
        }
        if (
          target === "main" &&
          method === "workspace-state.entity.resolveActive"
        ) {
          return { id: args[0], kind: "do" };
        }
        if (
          target === "main" &&
          (method === "workspace-state.alarmSet" ||
            method === "workspace-state.alarmClear")
        ) {
          // DurableBase persists alarm metadata through main; these channel tests
          // exercise channel behavior, so acknowledge the lifecycle write.
          return undefined;
        }
        if (target === "main" && method === "blobstore.putText") {
          const value = String(args[0] ?? "");
          const blob = options.blobstorePutText
            ? await options.blobstorePutText(value)
            : { digest: `test-digest-${blobs.size + 1}`, size: value.length };
          blobs.set(blob.digest, value);
          return blob;
        }
        if (target === "main" && method === "blobstore.getText") {
          return blobs.get(String(args[0] ?? "")) ?? null;
        }
        if (target === gadTarget) {
          const callerId = `do:workers/pubsub-channel:PubSubChannel:${options.channelKey ?? "channel-1"}`;
          return await gad.callAs(
            { callerId, callerKind: "do" },
            method,
            ...args,
          );
        }
        throw new Error(`unexpected rpc call ${target}.${method}`);
      },
    ),
    expose: () => {},
    exposeAll: () => {},
    on: () => () => {},
  };
  (
    channel.instance as unknown as {
      _connectionless: { client: unknown; respond: unknown; deliver: unknown };
    }
  )._connectionless = {
    client: mockClient,
    respond: async () => null,
    deliver: () => {},
  };
  return { gad, blobs, ...channel };
}

describe("PubSubChannel", () => {
  it("projects a DO-to-DO work-ready edge into the next host alarm", async () => {
    const { instance, sql } = await createGadBackedChannel();
    const edgeAt = Date.now();
    sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)`,
      "durable-work-ready-generation:channel-delivery",
      "1",
    );

    const schedule = (
      instance as unknown as {
        nextAlarmAfterRequest(): { wakeAt: number } | null;
      }
    ).nextAlarmAfterRequest();

    expect(schedule).not.toBeNull();
    expect(schedule!.wakeAt).toBeGreaterThanOrEqual(edgeAt + 90);
    expect(schedule!.wakeAt).toBeLessThanOrEqual(Date.now() + 250);
  });

  ledgerTest("channel.locked.exact-admission", async () => {
    const workerId = "do:workers/system-agent:SystemAgentWorker:user-alice";
    const { instance } = await createGadBackedChannel({
      rpcCall: (target, method, args) => {
        if (
          target === "main" &&
          method === "workspace-state.entity.resolveActive"
        ) {
          return { id: args[0], kind: "do" };
        }
        if (target === workerId && method === "onChannelEnvelope") return null;
        return undefined;
      },
    });
    setRpcCaller(instance, "server:test", "server");
    await expect(
      instance.initializeLockedChannel("ctx-system-alice", {
        title: "System Agent",
        policies: ["agentic.conversation.v1"],
        membershipPolicy: {
          kind: "locked",
          participants: [workerId, "user:alice"],
        },
      }),
    ).resolves.toMatchObject({
      membershipPolicy: {
        kind: "locked",
        participants: [workerId, "user:alice"].sort(),
      },
    });

    setRpcCaller(instance, "panel:alice", "panel", "panel:alice", "alice");
    await expect(
      instance.subscribe("client-asserted-id-is-ignored", {
        contextId: "ctx-system-alice",
        name: "Alice",
        type: "panel",
      }),
    ).resolves.toMatchObject({ participantId: "user:alice" });

    setRpcCaller(instance, "panel:bob", "panel", "panel:bob", "bob");
    await expect(
      instance.subscribe("anything", {
        contextId: "ctx-system-alice",
        name: "Bob",
        type: "panel",
      }),
    ).rejects.toThrow(
      "Participant user:bob is not admitted by this locked channel",
    );

    await expect(
      joinEntity(
        instance,
        workerId,
        { name: "System Agent", type: "agent" },
        "ctx-system-alice",
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses a guest publish into a locked channel as closed, not as an unknown participant", async () => {
    const { instance } = await createGadBackedChannel();
    setRpcCaller(instance, "server:test", "server");
    await instance.initializeLockedChannel("ctx-sealed", {
      membershipPolicy: { kind: "locked", participants: ["user:alice"] },
    });

    // A guest envelope (messaging plan §4.6) is an ordinary publish by a
    // participant who never joined. It must run the same admission check a join
    // would rather than slipping past it.
    setRpcCaller(instance, "do:outsider", "do");
    const refusal = instance.publish(
      "do:outsider",
      AGENTIC_EVENT_PAYLOAD_KIND,
      {
        kind: "message.completed",
        actor: { kind: "agent", id: "do:outsider" },
        causality: { messageId: "msg-guest" },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          role: "assistant",
          outcome: "completed",
        },
        createdAt: "2026-05-20T12:00:00.000Z",
      },
    );

    // The distinction is load-bearing (D14): an agent that reads "unknown
    // addressee" retries forever, and one that reads "closed channel" stops.
    await expect(refusal).rejects.toMatchObject({ code: "ClosedChannel" });
    await expect(refusal).rejects.toThrow(/locked membership/iu);
    await expect(refusal).rejects.toThrow(/does not admit do:outsider/iu);
  });

  it("does not let subscribe or generic config updates create or widen locked membership", async () => {
    const { instance } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:alice", "panel", "panel:alice", "alice");
    await expect(
      instance.subscribe("ignored", {
        contextId: "ctx-private",
        name: "Alice",
        type: "panel",
        channelConfig: {
          membershipPolicy: { kind: "locked", participants: ["user:alice"] },
        },
      }),
    ).rejects.toThrow(
      "locked channel membership can only be initialized by the host",
    );

    setRpcCaller(instance, "server:test", "server");
    await instance.initializeLockedChannel("ctx-private", {
      membershipPolicy: { kind: "locked", participants: ["user:alice"] },
    });
    await expect(
      instance.updateConfig({
        membershipPolicy: {
          kind: "locked",
          participants: ["user:alice", "user:bob"],
        },
      }),
    ).rejects.toThrow("locked membership is immutable");
    await expect(
      instance.initializeLockedChannel("ctx-private", {
        membershipPolicy: { kind: "locked", participants: ["user:alice"] },
      }),
    ).resolves.toMatchObject({
      membershipPolicy: { kind: "locked", participants: ["user:alice"] },
    });
    await expect(
      instance.initializeLockedChannel("ctx-private", {
        membershipPolicy: {
          kind: "locked",
          participants: ["user:alice", "user:bob"],
        },
      }),
    ).rejects.toThrow("existing channel definition does not match");
  });

  it("terminates a subscription instead of buffering an unread live tail without bound", async () => {
    const { instance } = await createGadBackedChannel();
    const internal = instance as unknown as {
      openSubscriptionResponse(
        participantId: string,
        deliveryId: string,
        replaceParticipant: boolean,
        result: never,
      ): Response;
      deliverParticipantPayload(
        participantId: string,
        payload: unknown,
      ): Promise<void>;
      participantSubscriptionCount(participantId: string): number;
    };
    const response = internal.openSubscriptionResponse(
      "panel:slow",
      "delivery:slow",
      false,
      {
        ok: true,
        participantId: "panel:slow",
      } as never,
    );

    for (let index = 0; index < 80; index += 1) {
      await internal.deliverParticipantPayload("panel:slow", {
        index,
        content: "x".repeat(16_000),
      });
    }

    expect(internal.participantSubscriptionCount("panel:slow")).toBe(0);
    await expect(response.body!.getReader().read()).rejects.toThrow(
      /response-buffer-full/,
    );
  });

  it("stores durable publishes as opaque channel envelopes", async () => {
    const { instance, gad } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");

    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    const result = await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
      {
        idempotencyKey: "publish-1",
      },
    );

    expect(result.id).toBe(2);
    const rows = gad.sql
      .exec(
        `SELECT seq, envelope_id, payload_kind, payload_ref_json, annotations_json
       FROM log_events ORDER BY seq ASC`,
      )
      .toArray();
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[1]).toMatchObject({
      seq: 2,
      payload_kind: AGENTIC_EVENT_PAYLOAD_KIND,
    });
    expect(JSON.parse(rows[1]!["payload_ref_json"] as string)).toMatchObject({
      kind: "message.completed",
    });
    expect(JSON.parse(rows[1]!["annotations_json"] as string)).toMatchObject({
      metadata: { name: "User" },
    });
  });

  it("stamps the sender latch on the durable message and preserves exact outside lineage", async () => {
    const { instance, gad, callAs } = await createGadBackedChannel();
    setRpcCaller(instance, "agent:outside", "agent");
    const caller = (
      instance as unknown as {
        _currentVerifiedCaller: {
          authorization?: ReturnType<typeof createTestDirectAuthority>;
        };
      }
    )._currentVerifiedCaller;
    caller.authorization = createTestDirectAuthority({
      callerKind: "agent",
      method: "publish",
      objectKey: "channel-1",
    });
    caller.authorization.context.contextIntegrity = {
      class: "external",
      latchEpoch: 2,
      externalKeys: [
        `api:webhook:${"a".repeat(64)}`,
        "web:example.com",
        "msg:source/earlier",
      ],
    };

    await instance.subscribe("agent:outside", {
      contextId: "ctx-1",
      name: "Outside agent",
      type: "agent",
    });
    await callAs(
      {
        callerId: "agent:outside",
        callerKind: "agent",
        authorization: caller.authorization,
      },
      "publish",
      "agent:outside",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
    );
    const page = await gad.instance.readChannelEnvelopes({
      channelId: "channel-1",
    });
    const envelope = page.items.at(-1);

    expect(envelope).toMatchObject({
      contentClass: "external",
      externalKeys: [
        `api:webhook:${"a".repeat(64)}`,
        "web:example.com",
        "msg:source/earlier",
      ],
    });
  });

  ledgerTest("channel.ordinary.authenticated-admission", async () => {
    const { instance } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:nav-current", "panel", "panel:slot-stable");

    await expect(
      instance.subscribe("panel:slot-stable", {
        contextId: "ctx-1",
        name: "User",
        type: "panel",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      instance.publish(
        "panel:slot-stable",
        AGENTIC_EVENT_PAYLOAD_KIND,
        agenticEvent(),
      ),
    ).resolves.toMatchObject({ id: expect.any(Number) });
    await expect(
      instance.publish(
        "panel:other",
        AGENTIC_EVENT_PAYLOAD_KIND,
        agenticEvent(),
      ),
    ).rejects.toThrow(
      "publish: participant panel:other cannot be used by caller panel:nav-current",
    );
  });

  it("does not let agent callers inject arbitrary roster participants", async () => {
    const { instance } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });

    setRpcCaller(instance, "agent:session-1", "agent");
    await expect(
      instance.subscribe("panel:phantom", {
        contextId: "ctx-1",
        name: "Fake",
        type: "agent",
      }),
    ).rejects.toThrow(
      "Participant panel:phantom cannot be subscribed by caller agent:session-1",
    );
    await expect(
      instance.subscribe("agent:session-1", {
        contextId: "ctx-1",
        name: "Agent",
        type: "agent",
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("does not let shell callers inject arbitrary roster participants", async () => {
    const { instance } = await createGadBackedChannel();
    setRpcCaller(instance, "shell:dev-1", "shell");

    await expect(
      instance.subscribe("cli-shadow", {
        contextId: "ctx-1",
        name: "CLI",
        type: "client",
      }),
    ).rejects.toThrow(
      "Participant cli-shadow cannot be subscribed by caller shell:dev-1",
    );
    await expect(
      instance.subscribe("shell:dev-1", {
        contextId: "ctx-1",
        name: "CLI",
        type: "client",
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  ledgerTest("channel.presence.canonical-human", async () => {
    const emittedTargets: string[] = [];
    const { instance, sql } = await createGadBackedChannel({ emittedTargets });

    setRpcCaller(instance, "panel:nav-a", "panel", "panel:slot-a", "usr_alice");
    const first = (await instance.subscribe("panel:slot-a", {
      contextId: "ctx-1",
      name: "Chat panel A",
      type: "panel",
    })) as unknown as { participantId: string };
    setRpcCaller(instance, "panel:nav-b", "panel", "panel:slot-b", "usr_alice");
    const second = (await instance.subscribe("panel:slot-b", {
      contextId: "ctx-1",
      name: "Chat panel B",
      type: "panel",
    })) as unknown as { participantId: string };

    expect(first.participantId).toBe("user:usr_alice");
    expect(second.participantId).toBe("user:usr_alice");
    expect(sql.exec(`SELECT id FROM participants`).toArray()).toEqual([
      { id: "user:usr_alice" },
    ]);
    await expect(instance.getChannelPresence()).resolves.toMatchObject({
      entries: [{ participantId: "user:usr_alice", sessionCount: 2 }],
    });

    emittedTargets.length = 0;
    await instance.publish(
      "user:usr_alice",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
      {
        idempotencyKey: "human-publish",
      },
    );
    await Promise.resolve();
    expect(new Set(emittedTargets)).toEqual(
      new Set(["panel:slot-a", "panel:slot-b"]),
    );

    // Cooperative unsubscribe has the same delivery-local ownership as body
    // cancellation. Closing one UI must not retire another UI's response or
    // end their shared human relationship.
    setRpcCaller(instance, "panel:nav-b", "panel", "panel:slot-b", "usr_alice");
    await expect(
      instance.unsubscribe("user:usr_alice", "panel:slot-a"),
    ).rejects.toThrow(/owned by another delivery/u);
    await expect(instance.getChannelPresence()).resolves.toMatchObject({
      entries: [{ participantId: "user:usr_alice", sessionCount: 2 }],
    });
    await instance.unsubscribe("user:usr_alice");
    expect(sql.exec(`SELECT id FROM participants`).toArray()).toHaveLength(1);
    await expect(instance.getChannelPresence()).resolves.toMatchObject({
      entries: [{ participantId: "user:usr_alice", sessionCount: 1 }],
    });

    emittedTargets.length = 0;
    await instance.publish(
      "user:usr_alice",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
      {
        idempotencyKey: "human-publish-after-one-close",
      },
    );
    await Promise.resolve();
    expect(emittedTargets).toEqual(["panel:slot-a"]);

    await closeTestSubscription(instance, "user:usr_alice", "panel:slot-a");
    expect(sql.exec(`SELECT id FROM participants`).toArray()).toHaveLength(0);
    // Repeating response cancellation remains a successful no-op.
    await closeTestSubscription(instance, "user:usr_alice", "panel:slot-a");
    await expect(instance.getChannelPresence()).resolves.toMatchObject({
      entries: [
        {
          participantId: "user:usr_alice",
          userId: "usr_alice",
          status: "offline",
          sessionCount: 0,
          lastSeenAt: expect.any(Number),
        },
      ],
    });
  });

  it("does not let a superseded client's late unsubscribe close its replacement", async () => {
    const { instance } = await createGadBackedChannel();
    setRpcCaller(instance, "app:apps/shell:main", "app", null, "usr_alice");
    const metadata = {
      contextId: "ctx-1",
      name: "Shell",
      type: "client",
    };

    await instance.subscribe("app:apps/shell:main", metadata, "quickfire-old");
    await instance.subscribe("app:apps/shell:main", metadata, "quickfire-new");
    await instance.unsubscribe("user:usr_alice", "quickfire-old");

    await expect(instance.getChannelPresence()).resolves.toMatchObject({
      entries: [{ participantId: "user:usr_alice", sessionCount: 1 }],
    });
    await closeTestSubscription(instance, "user:usr_alice", "quickfire-new");
  });

  it("uses authenticated delivery identity without a client session namespace", async () => {
    const { instance, sql } = await createGadBackedChannel();
    setRpcCaller(
      instance,
      "panel:alice-nav",
      "panel",
      "panel:shared-slot",
      "usr_alice",
    );
    await instance.subscribe("panel:shared-slot", {
      contextId: "ctx-1",
      name: "Alice",
      type: "panel",
    });

    // The host owns endpoint/account integrity. The channel keeps no parallel
    // client-asserted session namespace or uniqueness authority.
    setRpcCaller(
      instance,
      "panel:bob-nav",
      "panel",
      "panel:shared-slot",
      "usr_bob",
    );
    await instance.subscribe("panel:shared-slot", {
      contextId: "ctx-1",
      name: "Bob",
      type: "panel",
    });

    expect(
      sql.exec(`SELECT id FROM participants ORDER BY id`).toArray(),
    ).toEqual([{ id: "user:usr_alice" }, { id: "user:usr_bob" }]);
  });

  it("derives online, idle, away, and offline from domain activity", async () => {
    const { instance, sql } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:alice", "panel", "panel:alice", "usr_alice");
    await instance.subscribe("panel:alice", {
      contextId: "ctx-1",
      name: "Alice panel",
      type: "panel",
    });
    const internal = instance as unknown as { advancePresenceStatuses(): void };
    const now = Date.now();

    sql.exec(
      `UPDATE participants SET last_active_at = ?, presence_status = 'online' WHERE id = ?`,
      now - 6 * 60_000,
      "user:usr_alice",
    );
    internal.advancePresenceStatuses();
    expect((await instance.getChannelPresence()).entries[0]?.status).toBe(
      "idle",
    );

    sql.exec(
      `UPDATE participants SET last_active_at = ?, presence_status = 'idle' WHERE id = ?`,
      now - 31 * 60_000,
      "user:usr_alice",
    );
    internal.advancePresenceStatuses();
    expect((await instance.getChannelPresence()).entries[0]?.status).toBe(
      "away",
    );

    await instance.setTypingState("user:usr_alice", true);
    expect((await instance.getChannelPresence()).entries[0]?.status).toBe(
      "online",
    );
  });

  ledgerTest("channel.invitation.discovery-metadata", async () => {
    const { instance, gad } = await createGadBackedChannel({
      rpcCall: (_target, method, args) => {
        if (method === "account.isMember") return args[0] === "usr_bob";
        if (method === "account.resolveProfiles") {
          return { usr_bob: { handle: "bob" } };
        }
        return undefined;
      },
    });
    setRpcCaller(instance, "panel:alice", "panel", "panel:alice", "usr_alice");
    await instance.subscribe("panel:alice", {
      contextId: "ctx-1",
      name: "Alice",
      type: "panel",
    });
    const before = gad.sql
      .exec(`SELECT COUNT(*) AS count FROM log_events`)
      .one()["count"];
    await expect(
      instance.addMember({ userId: "usr_bob" }),
    ).resolves.toMatchObject({
      userId: "usr_bob",
      memberId: "user:usr_bob",
      handle: "bob",
      alreadyMember: false,
    });
    expect(
      gad.sql
        .exec(
          `SELECT user_id, notification_id, kind FROM user_notifications WHERE user_id = ?`,
          "usr_bob",
        )
        .toArray(),
    ).toEqual([
      {
        user_id: "usr_bob",
        notification_id: "channel.invite:channel-1",
        kind: "channel.invite",
      },
    ]);
    const after = gad.sql
      .exec(`SELECT COUNT(*) AS count FROM log_events`)
      .one()["count"];
    expect(after).toBe(before);

    setRpcCaller(instance, "panel:bob", "panel", "panel:bob", "usr_bob");
    await expect(instance.listInvitesForMe()).resolves.toMatchObject({
      invites: [{ channelId: "channel-1", memberId: "user:usr_bob" }],
    });
    await expect(instance.acknowledgeInvite()).resolves.toEqual({
      acknowledged: true,
    });
    await expect(instance.acknowledgeInvite()).resolves.toEqual({
      acknowledged: false,
    });
    await expect(instance.listInvitesForMe()).resolves.toEqual({ invites: [] });

    // Re-adding an existing member refreshes profile data but does not invent a
    // second pending invitation after the first was acknowledged.
    setRpcCaller(instance, "panel:alice", "panel", "panel:alice", "usr_alice");
    await expect(
      instance.addMember({ userId: "usr_bob" }),
    ).resolves.toMatchObject({
      alreadyMember: true,
    });
    setRpcCaller(instance, "panel:bob", "panel", "panel:bob", "usr_bob");
    await expect(instance.listInvitesForMe()).resolves.toEqual({ invites: [] });

    // Remove and a subsequent fresh add both converge the workspace index.
    setRpcCaller(instance, "panel:alice", "panel", "panel:alice", "usr_alice");
    await expect(instance.removeMember({ userId: "usr_bob" })).resolves.toEqual(
      { removed: true },
    );
    await expect(
      instance.addMember({ userId: "usr_bob" }),
    ).resolves.toMatchObject({
      alreadyMember: false,
    });
    expect(
      gad.sql.exec(`SELECT COUNT(*) AS count FROM user_notifications`).one()[
        "count"
      ],
    ).toBe(1);
    await expect(instance.removeMember({ userId: "usr_bob" })).resolves.toEqual(
      { removed: true },
    );
    expect(
      gad.sql.exec(`SELECT COUNT(*) AS count FROM user_notifications`).one()[
        "count"
      ],
    ).toBe(0);

    await expect(instance.addMember({ userId: "usr_outside" })).rejects.toThrow(
      /not a member of this workspace/,
    );
    await expect(
      instance.addMember({ userId: "user:usr_bob" }),
    ).rejects.toThrow(/bare workspace account id/);
  });

  it("retries a lost workspace invite-index write through a host-held claim", async () => {
    let failFirstPut = true;
    const { instance, gad, sql } = await createGadBackedChannel({
      rpcCall: (target, method, args) => {
        if (method === "account.isMember") return args[0] === "usr_bob";
        if (method === "account.resolveProfiles")
          return { usr_bob: { handle: "bob" } };
        if (
          target.includes("GadWorkspaceDO") &&
          method === "putChannelMembership" &&
          failFirstPut
        ) {
          failFirstPut = false;
          throw new Error("simulated lost GAD response");
        }
        return undefined;
      },
    });
    setRpcCaller(instance, "panel:alice", "panel", "panel:alice", "usr_alice");

    await expect(instance.addMember({ userId: "usr_bob" })).rejects.toThrow(
      /invitation delivery is pending/,
    );
    expect(
      sql.exec(`SELECT COUNT(*) AS count FROM invite_index_ops`).one()["count"],
    ).toBe(1);
    expect(
      gad.sql.exec(`SELECT COUNT(*) AS count FROM user_notifications`).one()[
        "count"
      ],
    ).toBe(0);

    sql.exec(`UPDATE invite_index_ops SET updated_at = 0`);
    await instance.alarm();
    const [claim] = instance.claimReadyWork("channel-delivery", {
      workerId: "test-host",
      now: Date.now(),
      limit: 1,
    });
    expect(claim?.itemId).toContain("maintenance:invite-index:");
    const outcome = await instance.executeChannelMaintenanceClaim({
      itemId: claim!.itemId,
      generation: claim!.generation,
    });
    expect(
      instance.settleReadyWork("channel-delivery", {
        workerId: "test-host",
        itemId: claim!.itemId,
        generation: claim!.generation,
        outcome,
      }),
    ).toBe("accepted");

    expect(
      sql.exec(`SELECT COUNT(*) AS count FROM invite_index_ops`).one()["count"],
    ).toBe(0);
    expect(
      gad.sql.exec(`SELECT COUNT(*) AS count FROM user_notifications`).one()[
        "count"
      ],
    ).toBe(1);
  });

  it("turns a pending invite put into cleanup when workspace membership was revoked", async () => {
    let isWorkspaceMember = true;
    let putAttempts = 0;
    let deleteAttempts = 0;
    const { instance, gad, sql } = await createGadBackedChannel({
      rpcCall: (target, method, args) => {
        if (method === "account.isMember")
          return isWorkspaceMember && args[0] === "usr_bob";
        if (method === "account.resolveProfiles")
          return { usr_bob: { handle: "bob" } };
        if (
          target.includes("GadWorkspaceDO") &&
          method === "putChannelMembership"
        ) {
          putAttempts += 1;
          throw new Error("simulated unavailable invite index");
        }
        if (
          target.includes("GadWorkspaceDO") &&
          method === "deleteChannelMembership"
        ) {
          deleteAttempts += 1;
        }
        return undefined;
      },
    });
    setRpcCaller(instance, "panel:alice", "panel", "panel:alice", "usr_alice");

    await expect(instance.addMember({ userId: "usr_bob" })).rejects.toThrow(
      /invitation delivery is pending/,
    );
    expect(putAttempts).toBe(1);
    expect(
      sql.exec(`SELECT COUNT(*) AS count FROM channel_members`).one()["count"],
    ).toBe(1);

    isWorkspaceMember = false;
    await expect(instance.removeMember({ userId: "usr_bob" })).resolves.toEqual(
      {
        removed: true,
      },
    );

    expect(putAttempts).toBe(1);
    expect(deleteAttempts).toBe(1);
    expect(
      sql.exec(`SELECT COUNT(*) AS count FROM channel_members`).one()["count"],
    ).toBe(0);
    expect(
      sql.exec(`SELECT COUNT(*) AS count FROM invite_index_ops`).one()["count"],
    ).toBe(0);
    expect(
      gad.sql.exec(`SELECT COUNT(*) AS count FROM user_notifications`).one()[
        "count"
      ],
    ).toBe(0);
    await expect(instance.listMembers()).resolves.toEqual({ members: [] });
  });

  it("keeps remove as the final projection when an older add completes last", async () => {
    const putStarted = deferred<void>();
    const releasePut = deferred<void>();
    let holdFirstPut = true;
    const { instance, gad } = await createGadBackedChannel({
      rpcCall: async (target, method, args) => {
        if (method === "account.isMember") return args[0] === "usr_bob";
        if (method === "account.resolveProfiles")
          return { usr_bob: { handle: "bob" } };
        if (
          target.includes("GadWorkspaceDO") &&
          method === "putChannelMembership" &&
          holdFirstPut
        ) {
          holdFirstPut = false;
          putStarted.resolve(undefined);
          await releasePut.promise;
        }
        return undefined;
      },
    });
    setRpcCaller(instance, "panel:alice", "panel", "panel:alice", "usr_alice");

    const add = instance.addMember({ userId: "usr_bob" });
    await putStarted.promise;
    await expect(instance.removeMember({ userId: "usr_bob" })).resolves.toEqual(
      { removed: true },
    );
    releasePut.resolve(undefined);
    await expect(add).resolves.toMatchObject({ memberId: "user:usr_bob" });

    expect(
      gad.sql
        .exec(
          `SELECT action, revision FROM channel_membership_revisions
            WHERE user_id = 'usr_bob' AND channel_id = 'channel-1'`,
        )
        .toArray(),
    ).toEqual([{ action: "delete", revision: 2 }]);
    expect(
      gad.sql
        .exec(
          `SELECT 1 FROM channel_membership_index
            WHERE user_id = 'usr_bob' AND channel_id = 'channel-1'`,
        )
        .toArray(),
    ).toEqual([]);
    expect(gad.sql.exec(`SELECT * FROM user_notifications`).toArray()).toEqual(
      [],
    );
  });

  it("keeps add as the final projection when an older remove completes last", async () => {
    const deleteStarted = deferred<void>();
    const releaseDelete = deferred<void>();
    let holdDelete = false;
    const { instance, gad } = await createGadBackedChannel({
      rpcCall: async (target, method, args) => {
        if (method === "account.isMember") return args[0] === "usr_bob";
        if (method === "account.resolveProfiles")
          return { usr_bob: { handle: "bob" } };
        if (
          target.includes("GadWorkspaceDO") &&
          method === "deleteChannelMembership" &&
          holdDelete
        ) {
          holdDelete = false;
          deleteStarted.resolve(undefined);
          await releaseDelete.promise;
        }
        return undefined;
      },
    });
    setRpcCaller(instance, "panel:alice", "panel", "panel:alice", "usr_alice");
    await instance.addMember({ userId: "usr_bob" });

    holdDelete = true;
    const remove = instance.removeMember({ userId: "usr_bob" });
    await deleteStarted.promise;
    await expect(
      instance.addMember({ userId: "usr_bob" }),
    ).resolves.toMatchObject({
      alreadyMember: false,
    });
    releaseDelete.resolve(undefined);
    await expect(remove).resolves.toEqual({ removed: true });

    expect(
      gad.sql
        .exec(
          `SELECT action, revision FROM channel_membership_revisions
            WHERE user_id = 'usr_bob' AND channel_id = 'channel-1'`,
        )
        .toArray(),
    ).toEqual([{ action: "put", revision: 3 }]);
    expect(
      gad.sql
        .exec(
          `SELECT member_id FROM channel_membership_index
            WHERE user_id = 'usr_bob' AND channel_id = 'channel-1'`,
        )
        .toArray(),
    ).toEqual([{ member_id: "user:usr_bob" }]);
    expect(
      gad.sql
        .exec(
          `SELECT notification_id FROM user_notifications
            WHERE user_id = 'usr_bob' AND notification_id = 'channel.invite:channel-1'`,
        )
        .toArray(),
    ).toEqual([{ notification_id: "channel.invite:channel-1" }]);
  });

  it("sendAsCaller ignores an agent-supplied display handle", async () => {
    const { instance, gad } = await createGadBackedChannel();
    setRpcCaller(instance, "agent:session-1", "agent");
    const caller = (
      instance as unknown as {
        _currentVerifiedCaller: {
          authorization?: ReturnType<typeof createTestDirectAuthority>;
        };
      }
    )._currentVerifiedCaller;
    caller.authorization = createTestDirectAuthority({
      callerKind: "agent",
      method: "sendAsCaller",
    });

    await instance.sendAsCaller("hello", { handle: "Alice" });

    const rows = gad.sql
      .exec(
        `SELECT annotations_json FROM log_events WHERE payload_kind = ? ORDER BY seq DESC`,
        AGENTIC_EVENT_PAYLOAD_KIND,
      )
      .toArray();
    const annotations = JSON.parse(String(rows[0]!["annotations_json"]));
    expect(annotations.metadata).toMatchObject({
      name: "agent:session-1",
      handle: "agent:session-1",
      kind: "agent",
    });
  });

  it("rejects arbitrary participant labels for durable-object callers", async () => {
    const { instance } = await createGadBackedChannel({
      rpcCall: (target, method, args) => {
        if (
          target === "main" &&
          method === "workspace-state.entity.resolveActive"
        ) {
          return { id: args[0], kind: "do" };
        }
        return undefined;
      },
    });
    const evalDoId = "do:vibestudio/internal:EvalDO:eval-1";
    const arbitraryLabel = "headless-diagnose-123";
    setRpcCaller(instance, evalDoId, "durable-object");

    await expect(
      instance.join({
        participantId: arbitraryLabel,
        revision: 1,
        contextId: "ctx-1",
        metadata: { name: "Eval client", type: "client" },
        delivery: "all",
        endpoint: { kind: "entity", entityId: evalDoId, invocation: "mailbox" },
        applicationConfig: null,
        replay: true,
      }),
    ).rejects.toThrow(
      `join: participant ${arbitraryLabel} cannot be used by caller ${evalDoId}`,
    );
    await expect(
      instance.publish(
        arbitraryLabel,
        AGENTIC_EVENT_PAYLOAD_KIND,
        agenticEvent(),
      ),
    ).rejects.toThrow(
      `publish: participant ${arbitraryLabel} cannot be used by caller ${evalDoId}`,
    );

    await expect(
      joinResidentSession(instance, evalDoId, {
        name: "Eval client",
        type: "client",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a Durable Object participant that is not an active runtime entity", async () => {
    const participantId = "do:vibestudio/internal:EvalDO:retired-eval";
    const { instance } = await createGadBackedChannel({
      rpcCall: (target, method) => {
        if (
          target === "main" &&
          method === "workspace-state.entity.resolveActive"
        )
          return null;
        return undefined;
      },
    });
    setRpcCaller(instance, participantId, "do");

    await expect(
      instance.join({
        participantId,
        revision: 1,
        contextId: "ctx-1",
        metadata: { name: "Retired eval", type: "headless" },
        delivery: "all",
        endpoint: {
          kind: "entity",
          entityId: participantId,
          invocation: "direct",
        },
        applicationConfig: null,
        replay: true,
      }),
    ).rejects.toThrow(
      `join: Durable Object participant ${participantId} is not active`,
    );
  });

  it("dedupes concurrent publishes with the same idempotency key before append settles", async () => {
    const appendEntered = deferred();
    const releaseAppend = deferred();
    let appendCalls = 0;
    let blockAppend = false;
    const gad = await createTestDO(GadWorkspaceDO, {
      __objectKey: "workspace",
    });
    const { instance } = await createGadBackedChannel({
      gad,
      rpcCall: async (target, method, args) => {
        if (
          target === "do:workers/workspace-source:GadWorkspaceDO:workspace" &&
          method === "appendLogEvent" &&
          blockAppend
        ) {
          appendCalls += 1;
          appendEntered.resolve();
          await releaseAppend.promise;
          const callable = gad.instance as unknown as Record<
            string,
            (...methodArgs: unknown[]) => unknown
          >;
          return await callable[method]!(...args);
        }
        return undefined;
      },
    });
    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    blockAppend = true;

    const first = instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
      {
        idempotencyKey: "initial-prompt:chat-race",
      },
    );
    await appendEntered.promise;
    const second = instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
      {
        idempotencyKey: "initial-prompt:chat-race",
      },
    );
    await Promise.resolve();

    expect(appendCalls).toBe(1);
    releaseAppend.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { id: 2 },
      { id: 2 },
    ]);

    const rows = gad.sql
      .exec(`SELECT seq FROM log_events ORDER BY seq ASC`)
      .toArray();
    expect(rows.length).toBeGreaterThan(1);
  });

  it("does not persist full method schemas in durable participant metadata", async () => {
    const { instance, gad } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");

    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
      handle: "alice",
      methods: [
        {
          name: "eval",
          description: "x".repeat(4096),
          parameters: {
            type: "object",
            properties: {
              code: { type: "string", description: "y".repeat(4096) },
            },
          },
          returns: { type: "object", description: "z".repeat(4096) },
        },
      ],
    });
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
      {
        idempotencyKey: "publish-with-methods",
      },
    );

    const rows = gad.sql
      .exec(
        `SELECT actor_json, payload_ref_json, annotations_json
         FROM log_events ORDER BY seq ASC`,
      )
      .toArray();
    const durableJson = JSON.stringify(rows);

    expect(durableJson).not.toContain("properties");
    expect(durableJson).not.toContain("returns");
    expect(durableJson).not.toContain("description");
    expect(durableJson).not.toContain("yyyy");
    expect(JSON.parse(rows[0]!["payload_ref_json"] as string)).toMatchObject({
      metadata: { methods: [{ name: "eval" }] },
    });
    expect(JSON.parse(rows[1]!["annotations_json"] as string)).toMatchObject({
      metadata: { methods: [{ name: "eval" }] },
    });
  });

  it("fails durable publishes when blobstore storage fails", async () => {
    const { instance } = await createGadBackedChannel({
      blobstorePutText: async (value) => {
        if (!value.includes("must be stored")) {
          return { digest: "setup-digest", size: value.length };
        }
        throw new Error("blobstore unavailable");
      },
    });
    setRpcCaller(instance, "panel:user", "panel");

    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    let error: unknown;
    try {
      await instance.publish("panel:user", "custom.large", {
        value: `must be stored ${"x".repeat(160 * 1024)}`,
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("blobstore unavailable");
  });

  it("spills large durable payloads to blobstore and replays hydrated payloads", async () => {
    const blobs = new Map<string, string>();
    const { instance } = await createGadBackedChannel({
      blobstorePutText: async (value) => {
        const digest = `digest-${blobs.size + 1}`;
        blobs.set(digest, value);
        return { digest, size: value.length };
      },
    });
    setRpcCaller(instance, "panel:user", "panel");
    const largeResult = "x".repeat(140 * 1024);

    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      {
        ...agenticEvent("invocation.completed"),
        causality: { invocationId: "inv-large", transportCallId: "call-large" },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          result: { text: largeResult },
          terminalOutcome: "success",
        },
      },
      { idempotencyKey: "large-publish" },
    );

    const replay = await instance.getReplayAfter({ after: 1 });
    const event = replay.logEvents.find(
      (item) => item.type === AGENTIC_EVENT_PAYLOAD_KIND,
    );
    const payload = ((event?.payload as { payload?: unknown })?.payload ??
      {}) as Record<string, unknown>;
    expect(blobs.size).toBeGreaterThan(0);
    expect(payload["result"]).toEqual({ text: largeResult });
  });

  it("replays envelopes by sequence and paginates before a sequence", async () => {
    const { instance } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");

    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent("message.completed"),
    );
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent("message.completed"),
    );

    const afterOne = await instance.getReplayAfter({ after: 1 });
    expect(afterOne.logEvents.map((event) => event.id)).toEqual([2, 3]);
    expect(afterOne.ready).toMatchObject({
      totalCount: 3,
      envelopeCount: 3,
      firstEnvelopeSeq: 1,
    });

    const beforeThree = await instance.getReplayBefore(3, 1);
    expect(beforeThree.mode).toBe("before");
    expect(beforeThree.logEvents.map((event) => event.id)).toEqual([2]);
    expect(beforeThree.ready.hasMoreBefore).toBe(true);
  });

  it("looks up a durable envelope by its stable id", async () => {
    const { instance } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");

    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent("message.completed"),
      { idempotencyKey: "lookup-one" },
    );

    await expect(instance.getEnvelope("ik:lookup-one")).resolves.toMatchObject({
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      senderId: "panel:user",
    });
    await expect(instance.getEnvelope("missing-envelope")).resolves.toBeNull();
  });

  it("delivers live envelopes to RPC subscribers", async () => {
    const emitted: unknown[] = [];
    const { instance } = await createGadBackedChannel({ emitted });
    setRpcCaller(instance, "panel:live", "panel");

    await instance.subscribe("panel:live", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    await instance.publish(
      "panel:live",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(
      emitted.some((payload) => {
        const message = (
          payload as { message?: { kind?: string; event?: { type?: string } } }
        ).message;
        return (
          message?.kind === "log" &&
          message.event?.type === AGENTIC_EVENT_PAYLOAD_KIND
        );
      }),
    ).toBe(true);
  });

  it("keeps later durable deliveries behind a lane head in retry backoff", async () => {
    const agentId = "do:workers/agent-worker:AiChatWorker:headless-denied";
    const { instance } = await createGadBackedChannel({
      rpcCall: async (target, method, args) => {
        if (
          target === "main" &&
          method === "workspace-state.entity.resolveActive"
        ) {
          return { id: args[0], kind: "do" };
        }
        return undefined;
      },
    });

    setRpcCaller(instance, agentId, "durable-object");
    await instance.join({
      participantId: agentId,
      revision: 1,
      contextId: "ctx-1",
      metadata: { name: "Denied agent", type: "agent" },
      delivery: "all",
      endpoint: { kind: "entity", entityId: agentId, invocation: "direct" },
      applicationConfig: null,
      replay: true,
    });
    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
    );

    const [claim] = instance.claimReadyWork("channel-delivery", {
      workerId: "driver-1",
      now: Date.now(),
      limit: 1,
    });
    expect(claim).toBeDefined();
    expect(
      (claim!.payload as { delivery: { participantId: string } }).delivery
        .participantId,
    ).toBe(agentId);
    const failed = await instance.failReadyWork("channel-delivery", {
      workerId: "driver-1",
      itemId: claim!.itemId,
      generation: claim!.generation,
    });
    expect(failed).toEqual({ retryAt: expect.any(Number) });
    expect(instance.durableWorkStatus().nextRecoveryAt).toEqual(
      expect.any(Number),
    );

    // A newly published envelope is ready immediately, but allowing it to
    // overtake the failed lane head would make lifecycle terminals observable
    // before their corresponding starts.
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
    );
    expect(
      instance.claimReadyWork("channel-delivery", {
        workerId: "driver-1",
        now: Date.now(),
        limit: 1,
      }),
    ).toEqual([]);
    const retryAt = (failed as { retryAt: number }).retryAt;
    expect(instance.durableWorkStatus()).toMatchObject({
      readyQueues: [],
      nextRecoveryAt: retryAt,
    });

    const [retry] = instance.claimReadyWork("channel-delivery", {
      workerId: "driver-1",
      now: retryAt,
      limit: 1,
    });
    expect(retry!.itemId).toBe(claim!.itemId);
  });

  it("does not let an unavailable failure from an old claim detach a replacement receiver", async () => {
    const residentId = "do:vibestudio/internal:EvalDO:resident-generation";
    const { instance, sql } = await createGadBackedChannel({
      rpcCall: async (target, method, args) => {
        if (
          target === "main" &&
          method === "workspace-state.entity.resolveActive"
        ) {
          return { id: args[0], kind: "do" };
        }
        return undefined;
      },
    });
    await joinResidentSession(instance, residentId);
    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
    );

    const [oldClaim] = instance.claimReadyWork("channel-delivery", {
      workerId: "old-driver",
      now: Date.now(),
      limit: 1,
    });
    expect(oldClaim).toBeDefined();

    setRpcCaller(instance, residentId, "durable-object");
    await instance.join({
      participantId: residentId,
      revision: 2,
      contextId: "ctx-1",
      metadata: { name: "Replacement resident", type: "client" },
      delivery: "all",
      endpoint: { kind: "entity", entityId: residentId, invocation: "mailbox" },
      applicationConfig: null,
      replay: true,
    });

    await expect(
      instance.failReadyWork("channel-delivery", {
        workerId: "old-driver",
        itemId: oldClaim!.itemId,
        generation: oldClaim!.generation,
        error: Object.assign(new Error("old receiver disappeared"), {
          code: "ResidentSessionUnavailable",
        }),
      }),
    ).resolves.toEqual({ retryAt: expect.any(Number) });
    expect(
      sql
        .exec(
          `SELECT revision, attached FROM channel_relationships WHERE participant_id = ?`,
          residentId,
        )
        .toArray(),
    ).toEqual([expect.objectContaining({ revision: 2, attached: 1 })]);
    expect(
      instance.claimReadyWork("channel-delivery", {
        workerId: "replacement-driver",
        now: Date.now(),
        limit: 1,
      })[0]?.itemId,
    ).toBe(oldClaim!.itemId);
  });

  it("terminalizes permanent delivery poison and unblocks the ordered lane", async () => {
    const residentId = "do:vibestudio/internal:EvalDO:permanent-poison";
    const { instance, sql } = await createGadBackedChannel({
      rpcCall: async (target, method, args) => {
        if (
          target === "main" &&
          method === "workspace-state.entity.resolveActive"
        ) {
          return { id: args[0], kind: "do" };
        }
        return undefined;
      },
    });
    await joinResidentSession(instance, residentId);
    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
    );
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
    );

    const [poison] = instance.claimReadyWork("channel-delivery", {
      workerId: "driver-poison",
      now: Date.now(),
      limit: 1,
    });
    await expect(
      instance.failReadyWork("channel-delivery", {
        workerId: "driver-poison",
        itemId: poison!.itemId,
        generation: poison!.generation,
        error: Object.assign(new Error("malformed durable envelope"), {
          code: "PermanentChannelDelivery",
        }),
      }),
    ).resolves.toEqual({ retryAt: expect.any(Number) });
    expect(
      sql
        .exec(
          `SELECT state FROM channel_delivery_mailbox WHERE delivery_id = ?`,
          poison!.itemId,
        )
        .toArray(),
    ).toEqual([{ state: "terminal-integrity" }]);
    const [next] = instance.claimReadyWork("channel-delivery", {
      workerId: "driver-poison",
      now: Date.now(),
      limit: 1,
    });
    expect(next?.itemId).toBeDefined();
    expect(next?.itemId).not.toBe(poison!.itemId);
  });

  it("settles one finite delivery by its stable delivery id", async () => {
    const agentId = "do:workers/agent-worker:AiChatWorker:agent-settlement";
    const { instance, sql } = await createGadBackedChannel({
      rpcCall: async (target, method, args) => {
        if (
          target === "main" &&
          method === "workspace-state.entity.resolveActive"
        ) {
          return { id: args[0], kind: "do" };
        }
        return undefined;
      },
    });
    setRpcCaller(instance, agentId, "durable-object");
    await instance.join({
      participantId: agentId,
      revision: 1,
      contextId: "ctx-1",
      metadata: { name: "Agent", type: "agent" },
      delivery: "all",
      endpoint: { kind: "entity", entityId: agentId, invocation: "direct" },
      applicationConfig: null,
      replay: true,
    });
    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
    );
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
    );

    const [claim] = instance.claimReadyWork("channel-delivery", {
      workerId: "driver-1",
      now: Date.now(),
      limit: 1,
    });
    expect(
      instance.settleReadyWork("channel-delivery", {
        workerId: "driver-1",
        itemId: claim!.itemId,
        generation: claim!.generation,
        outcome: { processed: true, recipientExecutionStartedAt: Date.now() },
      }),
    ).toBe("accepted");
    expect(
      sql
        .exec(
          `SELECT samples FROM channel_delivery_latency_histogram
            WHERE metric = 'publish-to-recipient-execution'`,
        )
        .toArray(),
    ).toEqual([expect.objectContaining({ samples: 1 })]);
    const [next] = instance.claimReadyWork("channel-delivery", {
      workerId: "driver-1",
      now: Date.now(),
      limit: 1,
    });
    expect(next?.itemId).not.toBe(claim!.itemId);
  });

  it("derives every executable recipient through the same entity endpoint", async () => {
    const agentDoId = "do:workers/agent-worker:AiChatWorker:agent-x";
    const clientDoId = "do:vibestudio/internal:EvalDO:client-x";
    const { instance, sql } = await createGadBackedChannel({
      rpcCall: async (target, method, args) => {
        if (
          target === "main" &&
          method === "workspace-state.entity.resolveActive"
        ) {
          return { id: args[0], kind: "do" };
        }
        return undefined;
      },
    });

    setRpcCaller(instance, agentDoId, "durable-object");
    await instance.join({
      participantId: agentDoId,
      revision: 1,
      contextId: "ctx-1",
      metadata: { name: "Agent", type: "agent" },
      delivery: "all",
      endpoint: { kind: "entity", entityId: agentDoId, invocation: "direct" },
      applicationConfig: null,
      replay: true,
    });
    setRpcCaller(instance, clientDoId, "durable-object");
    await instance.join({
      participantId: clientDoId,
      revision: 1,
      contextId: "ctx-1",
      metadata: { name: "Eval client", type: "client" },
      delivery: "all",
      endpoint: { kind: "entity", entityId: clientDoId, invocation: "mailbox" },
      applicationConfig: null,
      replay: true,
    });

    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
    );
    const claims = instance.claimReadyWork("channel-delivery", {
      workerId: "driver-1",
      now: Date.now(),
      limit: 10,
    });
    expect(claims.map((claim) => claim.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          delivery: expect.objectContaining({
            participantId: agentDoId,
            agenticContext: expect.objectContaining({ version: 1 }),
          }),
        }),
        expect.objectContaining({
          delivery: expect.objectContaining({
            participantId: clientDoId,
            agenticContext: null,
          }),
        }),
      ]),
    );
    expect(
      sql
        .exec(`SELECT COUNT(*) AS contexts FROM channel_delivery_event_context`)
        .toArray()[0],
    ).toEqual({ contexts: 1 });
    expect(
      sql
        .exec(
          `SELECT COUNT(*) AS copied
             FROM channel_delivery_mailbox
            WHERE agentic_context_json IS NOT NULL`,
        )
        .toArray()[0],
    ).toEqual({ copied: 0 });
  });

  it("routes addressed task facts without copying ordinary child activity to the supervisor", async () => {
    const supervisorId = "do:workers/agent-worker:AiChatWorker:supervisor";
    const childId = "do:workers/agent-worker:AiChatWorker:child";
    const { instance, sql } = await createGadBackedChannel();

    setRpcCaller(instance, supervisorId, "durable-object");
    await instance.join({
      participantId: supervisorId,
      revision: 1,
      contextId: "ctx-task",
      metadata: { name: "Supervisor", type: "agent" },
      delivery: "addressed",
      endpoint: {
        kind: "entity",
        entityId: supervisorId,
        invocation: "direct",
      },
      applicationConfig: null,
      replay: true,
    });
    setRpcCaller(instance, childId, "durable-object");
    await instance.join({
      participantId: childId,
      revision: 1,
      contextId: "ctx-task",
      metadata: { name: "Child", type: "agent" },
      delivery: "all",
      endpoint: { kind: "entity", entityId: childId, invocation: "direct" },
      applicationConfig: null,
      replay: true,
    });

    await instance.publish(childId, AGENTIC_EVENT_PAYLOAD_KIND, {
      ...agenticEvent("invocation.progress"),
      actor: { kind: "agent", id: childId },
      causality: { invocationId: "tool-1" },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, delta: "working" },
    });
    expect(
      sql
        .exec(
          `SELECT delivery_id FROM channel_delivery_mailbox WHERE participant_id = ?`,
          supervisorId,
        )
        .toArray(),
    ).toEqual([]);

    await instance.publish(childId, AGENTIC_EVENT_PAYLOAD_KIND, {
      ...agenticEvent("task.completed"),
      actor: { kind: "agent", id: childId },
      causality: { taskId: "run-1" },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        terminalOutcome: "success",
        to: [{ kind: "participant", participantId: supervisorId }],
      },
    });
    expect(
      sql
        .exec(
          `SELECT participant_id, state FROM channel_delivery_mailbox WHERE participant_id = ?`,
          supervisorId,
        )
        .toArray(),
    ).toEqual([{ participant_id: supervisorId, state: "ready" }]);
  });

  it("records read receipts as a projection without appending or creating mailbox work", async () => {
    const agents = [
      "do:workers/agent-worker:AiChatWorker:receipt-a",
      "do:workers/agent-worker:AiChatWorker:receipt-b",
      "do:workers/agent-worker:AiChatWorker:receipt-c",
    ];
    const { instance, gad, sql } = await createGadBackedChannel();
    for (const agentId of agents) await joinEntity(instance, agentId);
    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
    );

    const logCountBefore = Number(
      gad.sql.exec(`SELECT COUNT(*) AS count FROM log_events`).toArray()[0]![
        "count"
      ],
    );
    const mailboxCountBefore = Number(
      sql
        .exec(`SELECT COUNT(*) AS count FROM channel_delivery_mailbox`)
        .toArray()[0]!["count"],
    );
    for (const agentId of agents) {
      setRpcCaller(instance, agentId, "durable-object");
      await instance.recordReceipt(agentId, "msg-1", "read", {
        turnId: `turn:${agentId}`,
      });
    }

    expect(
      Number(
        gad.sql.exec(`SELECT COUNT(*) AS count FROM log_events`).toArray()[0]![
          "count"
        ],
      ),
    ).toBe(logCountBefore);
    expect(
      Number(
        sql
          .exec(`SELECT COUNT(*) AS count FROM channel_delivery_mailbox`)
          .toArray()[0]!["count"],
      ),
    ).toBe(mailboxCountBefore);
    const replay = await instance.getReplayAfter({ after: 0 });
    const receiptSnapshot = replay.snapshots.find(
      (snapshot) => snapshot.kind === "receipt-snapshot",
    );
    expect(receiptSnapshot).toMatchObject({
      kind: "receipt-snapshot",
      events: expect.arrayContaining(
        agents.map((agentId) =>
          expect.objectContaining({
            senderId: agentId,
            payload: expect.objectContaining({ kind: "message.read" }),
          }),
        ),
      ),
    });
  });

  it("reconstructs durable membership and a missing mailbox projection after activation loss", async () => {
    const agentId = "do:workers/agent-worker:AiChatWorker:restart-recipient";
    const first = await createGadBackedChannel();
    await joinEntity(first.instance, agentId);
    setRpcCaller(first.instance, "panel:user", "panel");
    await first.instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    const published = await first.instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
    );
    expect(published.id).toBeDefined();
    const publishedSequence = published.id!;

    // Emulate loss after the canonical append but before projection commit.
    first.sql.exec(
      `DELETE FROM channel_delivery_mailbox WHERE event_sequence = ?`,
      publishedSequence,
    );
    first.sql.exec(`DELETE FROM channel_receipts WHERE message_id = 'msg-1'`);
    first.sql.exec(
      `UPDATE channel_delivery_projection_cursor SET log_sequence = ? WHERE singleton = 1`,
      publishedSequence - 1,
    );

    const restarted = await createGadBackedChannel({
      gad: first.gad,
      db: first.db,
    });
    await restarted.instance.adoptDurableWorkWorker("driver-after-restart");
    setRpcCaller(restarted.instance, agentId, "durable-object");
    await expect(
      restarted.instance.relationshipState(agentId),
    ).resolves.toEqual({
      revision: 1,
      active: true,
    });
    expect(
      restarted.sql
        .exec(
          `SELECT participant_id, event_sequence, state
             FROM channel_delivery_mailbox
            WHERE participant_id = ?`,
          agentId,
        )
        .toArray(),
    ).toEqual([
      { participant_id: agentId, event_sequence: published.id, state: "ready" },
    ]);
    const state = await restarted.instance.getState();
    expect(state["liveTransport"]).toMatchObject({ count: 0, streams: [] });
    expect(state["delivery"]).toMatchObject({ cursor: published.id, lag: 0 });
  });

  it("reports an envelope-only schema", async () => {
    const { instance } = await createGadBackedChannel();
    setRpcCaller(instance, "server:test", "server");

    const schema = await instance.adminInspectSchema();
    const envelopeTable = schema.tables.find(
      (table) => table.table === "channel_envelopes",
    );

    expect(envelopeTable).toBeUndefined();
    expect(schema.invariants.every((invariant) => invariant.ok)).toBe(true);
  });

  it("routes pause method calls through visible method invocation transport", async () => {
    const targetPid = "do:workers/agent-worker:AiChatWorker:agent-1";
    const rpcCalls: Array<{ target: string; method: string; args: unknown[] }> =
      [];
    const { instance, gad } = await createGadBackedChannel({
      rpcCall: (target, method, args) => {
        if (
          target === "main" &&
          method === "workspace-state.entity.resolveActive"
        ) {
          return { id: args[0], kind: "do" };
        }
        if (target === targetPid && method === "onChannelEnvelope") return null;
        if (target === targetPid && method === "onMethodCall") {
          rpcCalls.push({ target, method, args });
          return { result: { paused: true } };
        }
        return undefined;
      },
    });

    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    await joinEntity(instance, targetPid, { name: "AI Chat", type: "agent" });

    setRpcCaller(instance, "panel:user", "panel");
    await instance.callMethod(
      "panel:user",
      targetPid,
      "pause-call",
      "pause",
      { reason: "User interrupted execution" },
      { invocationId: "pause-invocation", transportCallId: "pause-call" },
    );

    expect(rpcCalls).toEqual([
      {
        target: targetPid,
        method: "onMethodCall",
        args: [
          "channel-1",
          "pause-call",
          "pause",
          { reason: "User interrupted execution" },
          { invocationId: "pause-invocation", turnId: undefined },
        ],
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const events = gad.sql
      .exec(
        `SELECT payload_ref_json FROM log_events WHERE payload_kind = ? ORDER BY seq ASC`,
        AGENTIC_EVENT_PAYLOAD_KIND,
      )
      .toArray()
      .map((row: Record<string, unknown>) =>
        JSON.parse(row["payload_ref_json"] as string),
      );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "invocation.started",
          causality: {
            invocationId: "pause-invocation",
            transportCallId: "pause-call",
          },
        }),
        expect.objectContaining({
          kind: "invocation.completed",
          causality: {
            invocationId: "pause-invocation",
            transportCallId: "pause-call",
          },
          payload: expect.objectContaining({ terminalOutcome: "success" }),
        }),
      ]),
    );
  });

  it("routes resident-session method calls through the durable event path", async () => {
    const evalPid = "do:vibestudio/internal:EvalDO:eval-1";
    const rpcCalls: Array<{ target: string; method: string }> = [];
    const { instance, gad, sql } = await createGadBackedChannel({
      rpcCall: (target, method, args) => {
        if (
          target === "main" &&
          method === "workspace-state.entity.resolveActive"
        ) {
          return { id: args[0], kind: "do" };
        }
        rpcCalls.push({ target, method });
        return undefined;
      },
    });

    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    await joinResidentSession(instance, evalPid, {
      name: "Eval client",
      type: "client",
    });

    setRpcCaller(instance, "panel:user", "panel");
    await instance.callMethod(
      "panel:user",
      evalPid,
      "title-call",
      "set_title",
      { title: "Hello" },
      { invocationId: "title-inv", transportCallId: "title-call" },
    );

    expect(
      rpcCalls.some((c) => c.target === evalPid && c.method === "onMethodCall"),
    ).toBe(false);
    await vi.waitFor(() =>
      expect(
        rpcCalls.some(
          (c) => c.target === evalPid && c.method === "acceptChannelInvocation",
        ),
      ).toBe(true),
    );

    setRpcCaller(instance, evalPid, "durable-object");
    const providerClaim = await instance.claimMethodCall(
      evalPid,
      "title-call",
      "eval-generation-1",
    );
    expect(
      sql
        .exec(
          `SELECT samples FROM channel_delivery_latency_histogram
            WHERE metric = 'call-to-provider-execution'`,
        )
        .toArray(),
    ).toEqual([]);
    await expect(
      instance.markMethodCallExecutionStarted(
        evalPid,
        "title-call",
        providerClaim.generation!,
      ),
    ).resolves.toEqual({ accepted: true });
    await expect(
      instance.markMethodCallExecutionStarted(
        evalPid,
        "title-call",
        providerClaim.generation!,
      ),
    ).resolves.toEqual({ accepted: true });
    expect(
      sql
        .exec(
          `SELECT samples FROM channel_delivery_latency_histogram
            WHERE metric = 'call-to-provider-execution'`,
        )
        .toArray(),
    ).toEqual([expect.objectContaining({ samples: 1 })]);
    const adoptedClaim = await instance.claimMethodCall(
      evalPid,
      "title-call",
      "eval-generation-2",
    );
    await expect(
      instance.markMethodCallExecutionStarted(
        evalPid,
        "title-call",
        providerClaim.generation!,
      ),
    ).resolves.toEqual({ accepted: false });
    await instance.submitMethodProgress(
      evalPid,
      "title-call",
      "stale progress",
      {
        invocationId: "title-inv",
        providerClaimGeneration: providerClaim.generation,
      },
    );
    await instance.submitMethodProgress(
      evalPid,
      "title-call",
      "current progress",
      {
        invocationId: "title-inv",
        providerClaimGeneration: adoptedClaim.generation,
      },
    );
    await expect(
      instance.submitMethodResult(
        evalPid,
        "title-call",
        { stale: true },
        false,
        {
          invocationId: "title-inv",
          providerClaimGeneration: providerClaim.generation,
        },
      ),
    ).resolves.toMatchObject({
      dropped: true,
      reason: "superseded-provider-claim",
    });
    await instance.submitMethodResult(
      evalPid,
      "title-call",
      { ok: true },
      false,
      {
        invocationId: "title-inv",
        providerClaimGeneration: adoptedClaim.generation,
      },
    );

    const events = gad.sql
      .exec(
        `SELECT payload_ref_json FROM log_events WHERE payload_kind = ? ORDER BY seq ASC`,
        AGENTIC_EVENT_PAYLOAD_KIND,
      )
      .toArray()
      .map((row: Record<string, unknown>) =>
        JSON.parse(row["payload_ref_json"] as string),
      );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "invocation.started",
          causality: {
            invocationId: "title-inv",
            transportCallId: "title-call",
          },
        }),
        expect.objectContaining({
          kind: "invocation.completed",
          causality: {
            invocationId: "title-inv",
            transportCallId: "title-call",
          },
          payload: expect.objectContaining({ terminalOutcome: "success" }),
        }),
      ]),
    );
    // Only the current provider generation may append progress. The payload is
    // blob-spilled by this fixture, so row cardinality is the authoritative
    // stale-generation assertion here.
    expect(
      events.filter((event) => event.kind === "invocation.output"),
    ).toHaveLength(1);
  });

  it.each([
    {
      name: "vessel",
      target: "do:workers/agent-worker:AiChatWorker:matrix",
      route: "direct",
    },
    {
      name: "resident",
      target: "do:vibestudio/internal:EvalDO:matrix-live",
      route: "mailbox",
    },
    {
      name: "disconnected resident",
      target: "do:vibestudio/internal:EvalDO:matrix-disconnected",
      route: "mailbox-refused",
    },
    { name: "live session", target: "panel:matrix-provider", route: "session" },
  ])(
    "route matrix: $name call, redrive, and cancel converge on one terminal",
    async (row) => {
      const rpcCalls: Array<{ target: string; method: string }> = [];
      let settleDirectCall: ((value: { result: unknown }) => void) | undefined;
      const { instance, gad, sql } = await createGadBackedChannel({
        rpcCall: async (target, method, args) => {
          if (
            target === "main" &&
            method === "workspace-state.entity.resolveActive"
          ) {
            return { id: args[0], kind: "do" };
          }
          rpcCalls.push({ target, method });
          if (
            row.route === "mailbox-refused" &&
            method === "acceptChannelInvocation"
          ) {
            throw Object.assign(new Error("no active receiver"), {
              code: "ResidentSessionUnavailable",
            });
          }
          if (method === "onMethodCall") {
            return new Promise((resolve) => {
              settleDirectCall = resolve;
            });
          }
          if (
            method === "acceptChannelInvocation" ||
            method === "cancelDirectMethodCall" ||
            method === "cancelChannelInvocation"
          ) {
            return null;
          }
          return undefined;
        },
      });
      setRpcCaller(instance, "panel:matrix-caller", "panel");
      await instance.subscribe("panel:matrix-caller", {
        contextId: "ctx-1",
        name: "Caller",
        type: "panel",
      });
      if (row.route === "session") {
        setRpcCaller(instance, row.target, "panel");
        await instance.subscribe(row.target, {
          contextId: "ctx-1",
          name: "Provider",
          type: "panel",
        });
      } else {
        setRpcCaller(instance, row.target, "durable-object");
        await instance.join({
          participantId: row.target,
          revision: 1,
          contextId: "ctx-1",
          metadata: { name: row.name, type: "client" },
          delivery: "all",
          endpoint: {
            kind: "entity",
            entityId: row.target,
            invocation: row.route === "direct" ? "direct" : "mailbox",
          },
          applicationConfig: null,
          replay: true,
        });
      }

      const options = {
        invocationId: `matrix-invocation-${row.name}`,
        transportCallId: `matrix-transport-${row.name}`,
        turnId: `matrix-turn-${row.name}`,
      };
      setRpcCaller(instance, "panel:matrix-caller", "panel");
      await instance.callMethod(
        "panel:matrix-caller",
        row.target,
        options.transportCallId,
        "eval",
        { code: "1 + 1" },
        options,
      );
      await instance.callMethod(
        "panel:matrix-caller",
        row.target,
        options.transportCallId,
        "eval",
        { code: "1 + 1" },
        options,
      );
      await instance.cancelMethodCall(
        "panel:matrix-caller",
        options.transportCallId,
      );
      settleDirectCall?.({ result: { ignoredAfterCancellation: true } });
      await Promise.resolve();

      expect(
        gad.sql
          .exec(
            `SELECT 1 FROM log_events WHERE envelope_id = ?`,
            options.invocationId,
          )
          .toArray(),
      ).toHaveLength(1);
      expect(
        gad.sql
          .exec(
            `SELECT 1 FROM log_events WHERE envelope_id = ?`,
            `terminal:${options.transportCallId}`,
          )
          .toArray(),
      ).toHaveLength(1);
      expect(
        gad.sql
          .exec(
            `SELECT payload_ref_json FROM log_events WHERE envelope_id = ?`,
            `terminal:${options.transportCallId}`,
          )
          .toArray()
          .map((terminal) => JSON.parse(String(terminal["payload_ref_json"]))),
      ).toEqual([
        expect.objectContaining({
          kind: "invocation.cancelled",
          payload: expect.objectContaining({
            terminalOutcome: "cancelled",
            to: [{ kind: "participant", participantId: "panel:matrix-caller" }],
          }),
        }),
      ]);
      if (row.route === "direct") {
        expect(rpcCalls.some((call) => call.method === "onMethodCall")).toBe(
          true,
        );
        expect(
          rpcCalls.some((call) => call.method === "cancelDirectMethodCall"),
        ).toBe(true);
      } else if (row.route === "session") {
        expect(rpcCalls.some((call) => call.target === row.target)).toBe(false);
      } else {
        expect(
          rpcCalls.some((call) => call.method === "acceptChannelInvocation"),
        ).toBe(true);
        expect(
          rpcCalls.some((call) => call.method === "cancelChannelInvocation"),
        ).toBe(true);
        expect(
          sql
            .exec(
              `SELECT COUNT(*) AS count FROM channel_delivery_mailbox
              WHERE participant_id = ? AND event_id = ?`,
              row.target,
              options.invocationId,
            )
            .toArray()[0]?.["count"],
        ).toBe(1);
      }
    },
  );

  it("reports channel-scoped target absence for method calls to participants outside the live roster", async () => {
    const { instance } = await createGadBackedChannel();
    const targetPid =
      "do:workers/agent-worker:AiChatWorker:agent-outside-channel";

    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    await instance.callMethod(
      "panel:user",
      targetPid,
      "debug-call",
      "getDebugState",
      {},
      { invocationId: "debug-invocation", transportCallId: "debug-call" },
    );

    const replay = await instance.getReplayAfter({ after: 0 });
    const events = replay.logEvents
      .filter((event) => event.type === AGENTIC_EVENT_PAYLOAD_KIND)
      .map((event) => event.payload);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "invocation.failed",
          causality: {
            invocationId: "debug-invocation",
            transportCallId: "debug-call",
          },
          payload: expect.objectContaining({
            error: expect.objectContaining({
              error: expect.stringContaining(
                "is not joined to channel channel-1; chat.callMethod is channel-scoped",
              ),
            }),
            terminalOutcome: "tool_error",
            terminalReasonCode: "method_failed",
          }),
        }),
      ]),
    );
  });

  it("atomically replaces a human delivery stream without abandoning pending calls", async () => {
    const { instance, gad, sql } = await createGadBackedChannel();
    const userParticipantId = "user:usr_alice";

    setRpcCaller(
      instance,
      "panel:slot-a",
      "panel",
      "panel:slot-a",
      "usr_alice",
    );
    await instance.subscribe(userParticipantId, {
      contextId: "ctx-1",
      name: "Chat panel",
      type: "panel",
      methods: [{ name: "feedback_form" }],
    });
    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    await instance.callMethod(
      "panel:caller",
      userParticipantId,
      "feedback-transport",
      "feedback_form",
      { title: "Question", fields: [] },
      {
        invocationId: "feedback-invocation",
        transportCallId: "feedback-transport",
        turnId: "feedback-turn",
      },
    );

    setRpcCaller(
      instance,
      "panel:slot-a",
      "panel",
      "panel:slot-a",
      "usr_alice",
    );
    await instance.subscribe(userParticipantId, {
      contextId: "ctx-1",
      name: "Chat panel",
      type: "panel",
      methods: [{ name: "feedback_form" }],
      sinceId: 10_000,
    });

    const lifecycle = gad.sql
      .exec(
        `SELECT payload_kind, payload_ref_json
           FROM log_events
          WHERE payload_kind IN ('presence', ?)
          ORDER BY seq`,
        AGENTIC_EVENT_PAYLOAD_KIND,
      )
      .toArray()
      .map((row) => ({
        kind: String(row["payload_kind"]),
        payload: JSON.parse(String(row["payload_ref_json"])) as {
          action?: string;
          kind?: string;
          causality?: { invocationId?: string };
        },
      }));
    expect(
      lifecycle.some(
        (entry) =>
          entry.kind === "presence" && entry.payload.action === "leave",
      ),
    ).toBe(false);
    expect(
      lifecycle.some(
        (entry) =>
          entry.payload.kind === "invocation.abandoned" &&
          entry.payload.causality?.invocationId === "feedback-invocation",
      ),
    ).toBe(false);
    expect(
      sql
        .exec(
          `SELECT transport_call_id FROM pending_calls WHERE transport_call_id = ?`,
          "feedback-transport",
        )
        .toArray(),
    ).toHaveLength(1);

    setRpcCaller(
      instance,
      "panel:slot-a",
      "panel",
      "panel:slot-a",
      "usr_alice",
    );
    await instance.submitMethodResult(
      userParticipantId,
      "feedback-transport",
      { answer: "private" },
      false,
      {
        invocationId: "feedback-invocation",
        turnId: "feedback-turn",
        terminalOutcome: "success",
      },
    );
  });

  it("admin-inspects a DO-backed agent debug method without requiring a live roster row", async () => {
    const targetPid =
      "do:workers/agent-worker:AiChatWorker:agent-recently-active";
    const rpcCalls: Array<{ target: string; method: string; args: unknown[] }> =
      [];
    const { instance } = await createGadBackedChannel({
      rpcCall: (target, method, args) => {
        if (target === targetPid && method === "readAgentInspection") {
          rpcCalls.push({ target, method, args });
          return { result: { loops: { "channel-1": { turnStatus: "idle" } } } };
        }
        return undefined;
      },
    });

    setRpcCaller(instance, "server:test", "server");
    await expect(
      instance.adminInspectAgent(targetPid, "getDebugState"),
    ).resolves.toMatchObject({
      participantId: targetPid,
      channelId: "channel-1",
      methodName: "getDebugState",
      result: { loops: { "channel-1": { turnStatus: "idle" } } },
      roster: { present: false },
    });
    expect(rpcCalls).toEqual([
      {
        target: targetPid,
        method: "readAgentInspection",
        args: ["channel-1", "getDebugState"],
      },
    ]);
  });

  it("keeps activation-local inspection off the ordinary agent method-call path", async () => {
    const targetPid = "do:workers/agent-worker:AiChatWorker:agent-stalled-turn";
    const routedMethods: string[] = [];
    let inspectionOptions:
      | { readOnly?: boolean; timeoutMs?: number }
      | undefined;
    const { instance } = await createGadBackedChannel({
      rpcCall: (target, method, _args, options) => {
        if (target === targetPid) {
          routedMethods.push(method);
          if (method === "onMethodCall") return new Promise(() => {});
          if (method === "readAgentInspection") {
            inspectionOptions = options;
            return {
              result: {
                loops: {
                  "channel-1": {
                    loaded: true,
                    turnStatus: "running",
                  },
                },
              },
            };
          }
        }
        return undefined;
      },
    });

    setRpcCaller(instance, "server:test", "server");
    await expect(
      instance.adminInspectAgent(targetPid, "getDebugState"),
    ).resolves.toMatchObject({
      result: {
        loops: {
          "channel-1": { loaded: true, turnStatus: "running" },
        },
      },
    });
    expect(routedMethods).toEqual(["readAgentInspection"]);
    expect(inspectionOptions).toEqual({ readOnly: true, timeoutMs: 5_000 });
  });

  it("lets the direct relay reject a retired or missing inspected agent without reactivation", async () => {
    const targetPid = "do:workers/agent-worker:AiChatWorker:agent-retired";
    const routedMethods: string[] = [];
    const { instance } = await createGadBackedChannel({
      rpcCall: (target, method) => {
        if (
          target === "main" &&
          (method === "workers.resolveDurableObject" ||
            method === "workspace-state.entity.resolveActive")
        ) {
          throw new Error(
            "agent inspection must not resolve or reactivate its target",
          );
        }
        if (target === targetPid) {
          routedMethods.push(method);
          throw Object.assign(
            new Error("agent entity is not active or missing"),
            {
              code: "DO_NOT_CREATED",
            },
          );
        }
        return undefined;
      },
    });

    setRpcCaller(instance, "server:test", "server");
    await expect(
      instance.adminInspectAgent(targetPid, "getDebugState"),
    ).rejects.toMatchObject({
      message: "agent entity is not active or missing",
      code: "DO_NOT_CREATED",
    });
    expect(routedMethods).toEqual(["readAgentInspection"]);
  });

  it("runs an already-admitted inspection without a second advisory approval", async () => {
    const targetPid =
      "do:workers/agent-worker:AiChatWorker:agent-recently-active";
    const rpcCalls: Array<{ target: string; method: string; args: unknown[] }> =
      [];
    const { instance } = await createGadBackedChannel({
      rpcCall: (target, method, args) => {
        if (target === targetPid && method === "readAgentInspection") {
          rpcCalls.push({ target, method, args });
          return { result: { settings: { model: "test:model" } } };
        }
        return undefined;
      },
    });

    setRpcCaller(instance, "do:vibestudio/internal:EvalDO:agent-eval", "do");
    await expect(
      instance.inspectAgent(targetPid, "getAgentSettings"),
    ).resolves.toMatchObject({
      participantId: targetPid,
      channelId: "channel-1",
      methodName: "getAgentSettings",
      result: { settings: { model: "test:model" } },
      roster: { present: false },
    });
    expect(rpcCalls).toEqual([
      {
        target: targetPid,
        method: "readAgentInspection",
        args: ["channel-1", "getAgentSettings"],
      },
    ]);
  });

  it("declares inspection as a receiver-enforced channel capability", async () => {
    const { instance } = await createGadBackedChannel();
    expect(rpcMethodAuthority(instance, "inspectAgent")).toMatchObject({
      principals: ["host", "user", "code"],
      effect: {
        kind: "userland-capability",
        capability: "channel.admin",
        resource: { kind: "receiver-object" },
      },
      tier: "gated",
      sensitivity: "admin",
    });
  });

  it("limits admin agent inspection to standard read-only debug methods", async () => {
    const { instance } = await createGadBackedChannel();

    setRpcCaller(instance, "server:test", "server");
    await expect(
      instance.adminInspectAgent(
        "do:workers/agent-worker:AiChatWorker:agent-recently-active",
        "pause",
      ),
    ).rejects.toThrow(/unsupported method pause/u);
  });

  it("uses GAD as the durable channel log backend without changing replay shape", async () => {
    const { instance, sql } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");

    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent("message.completed"),
    );

    expect(
      sql
        .exec(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_envelopes'`,
        )
        .toArray(),
    ).toEqual([]);
    const replay = await instance.getReplayAfter({ after: 1 });
    expect(
      replay.logEvents.map((event) => ({
        id: event.id,
        type: event.type,
        senderId: event.senderId,
      })),
    ).toEqual([
      { id: 2, type: AGENTIC_EVENT_PAYLOAD_KIND, senderId: "panel:user" },
    ]);
    expect(replay.ready).toMatchObject({
      totalCount: 2,
      envelopeCount: 2,
      firstEnvelopeSeq: 1,
    });
    expect(replay.snapshots[0]).toMatchObject({
      kind: "roster-snapshot",
      participants: [
        expect.objectContaining({
          id: "panel:user",
          ref: expect.objectContaining({
            kind: "panel",
            id: "panel:user",
            participantId: "panel:user",
          }),
        }),
      ],
    });
    expect(await instance.getParticipants()).toEqual([
      expect.objectContaining({
        participantId: "panel:user",
        ref: expect.objectContaining({
          kind: "panel",
          id: "panel:user",
          participantId: "panel:user",
        }),
      }),
    ]);
  });

  ledgerTest("channel.fork.context-and-log-origin", async () => {
    const parent = await createGadBackedChannel({
      channelKey: "channel-parent",
    });
    setRpcCaller(parent.instance, "panel:user", "panel");
    await parent.instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    await parent.instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent("message.completed"),
    );
    await parent.instance.publish("panel:user", AGENTIC_EVENT_PAYLOAD_KIND, {
      ...agenticEvent("message.completed"),
      causality: { messageId: "msg-2" },
    });

    const fork = await createGadBackedChannel({
      channelKey: "channel-fork",
      gad: parent.gad,
    });
    await fork.instance.postClone("channel-parent", 3, "ctx-forked");

    const replay = await fork.instance.getReplayAfter({ after: 0 });
    // No-copy fork: the child sees the parent prefix verbatim, including the
    // relationship and message facts with their original sequence numbers;
    // presence is intentionally an activation-local signal.
    expect(replay.logEvents.map((event) => event.id)).toEqual([1, 2, 3]);
    const messages = replay.logEvents.filter(
      (event) => event.type === AGENTIC_EVENT_PAYLOAD_KIND,
    );
    expect(
      messages.map(
        (event) =>
          (event.payload as { causality: { messageId: string } }).causality
            .messageId,
      ),
    ).toEqual(["msg-1", "msg-2"]);
    expect(replay.ready).toMatchObject({
      totalCount: 3,
      envelopeCount: 3,
      firstEnvelopeSeq: 1,
    });

    setRpcCaller(fork.instance, "panel:user", "panel");
    await fork.instance.publish("panel:user", AGENTIC_EVENT_PAYLOAD_KIND, {
      ...agenticEvent("message.completed"),
      causality: { messageId: "msg-fork" },
    });
    const afterForkAppend = await fork.instance.getReplayAfter({ after: 3 });
    expect(afterForkAppend.logEvents.map((event) => event.id)).toEqual([4]);
  });

  it("listForks folds this channel's own log into its direct-child fork projection", async () => {
    const selfTarget =
      "do:workers/pubsub-channel:PubSubChannel:channel-lf-parent";
    const agentTarget = "do:workers/agent-worker:AiChatWorker:agent-lf-parent";
    const clonedAgentTarget =
      "do:workers/agent-worker:AiChatWorker:agent-lf-child";
    let cloneCalls = 0;
    const lifecycleCalls: Array<{
      target: string;
      method: string;
      args: unknown[];
    }> = [];
    const parent = await createGadBackedChannel({
      channelKey: "channel-lf-parent",
      rpcCall: (target, method, args) => {
        // Sibling-channel resolve (fork parent): hand back THIS channel's own ref.
        if (
          target === "main" &&
          method === "workers.resolveService" &&
          args[0] === "vibestudio.channel.v1"
        ) {
          return {
            source: "workers/pubsub-channel",
            className: "PubSubChannel",
            objectKey: args[1] as string,
          };
        }
        if (
          target === "main" &&
          method === "workspace-state.entity.resolveActive"
        ) {
          return { id: args[0], kind: "do" };
        }
        if (target === agentTarget && method === "canFork") return { ok: true };
        // Clone the channel and its subscribed agent into a fresh context.
        if (target === "main" && method === "runtime.cloneContext") {
          cloneCalls += 1;
          return {
            contextId: "ctx-lf-fork",
            entities: [
              {
                sourceId: selfTarget,
                newId:
                  "do:workers/pubsub-channel:PubSubChannel:channel-lf-child",
                kind: "do",
                source: "workers/pubsub-channel",
                className: "PubSubChannel",
                sourceKey: "channel-lf-parent",
                newKey: "channel-lf-child",
                targetId:
                  "do:workers/pubsub-channel:PubSubChannel:channel-lf-child",
              },
              {
                sourceId: agentTarget,
                newId: clonedAgentTarget,
                kind: "do",
                source: "workers/agent-worker",
                className: "AiChatWorker",
                sourceKey: "agent-lf-parent",
                newKey: "agent-lf-child",
                targetId: clonedAgentTarget,
              },
            ],
          };
        }
        // The cloned child's postClone is driven over RPC; ack it.
        if (method === "postClone" || method === "runtime.rebindAgentChannel") {
          lifecycleCalls.push({ target, method, args });
          return null;
        }
        return undefined;
      },
    });
    setRpcCaller(parent.instance, "panel:user", "panel");
    await parent.instance.subscribe("panel:user", {
      contextId: "ctx-lf",
      name: "User",
      type: "panel",
    });
    setRpcCaller(parent.instance, agentTarget, "durable-object");
    await parent.instance.join({
      participantId: agentTarget,
      revision: 1,
      contextId: "ctx-lf",
      metadata: { name: "Agent", type: "agent" },
      delivery: "all",
      endpoint: { kind: "entity", entityId: agentTarget, invocation: "direct" },
      applicationConfig: null,
      replay: true,
    });
    setRpcCaller(parent.instance, "panel:user", "panel");

    expect(await parent.instance.listForks()).toEqual({
      forks: [],
      headSeq: expect.any(Number),
    });

    const forkInput = {
      operationId: "fork-operation-1",
      locus: { kind: "head" as const },
      reason: "deep dive",
      label: "My fork",
    };
    const result = await parent.instance.fork(forkInput);
    expect(result.forkedChannelId).toBe("channel-lf-child");
    await expect(parent.instance.fork(forkInput)).resolves.toEqual(result);
    expect(cloneCalls).toBe(1);
    expect(lifecycleCalls).toEqual([
      expect.objectContaining({
        target: "do:workers/pubsub-channel:PubSubChannel:channel-lf-child",
        method: "postClone",
      }),
      {
        target: "main",
        method: "runtime.rebindAgentChannel",
        args: [{ entityId: clonedAgentTarget, channelId: "channel-lf-child" }],
      },
      expect.objectContaining({
        target: clonedAgentTarget,
        method: "postClone",
      }),
    ]);

    const { forks } = await parent.instance.listForks();
    expect(forks).toHaveLength(1);
    expect(forks[0]).toMatchObject({
      forkId: result.forkId,
      forkedChannelId: "channel-lf-child",
      forkedContextId: "ctx-lf-fork",
      forkPointId: 2,
      label: "My fork",
      reason: "deep dive",
      archived: false,
    });

    // Rename + archive fold through the SAME projection; archived rows stay
    // (the UI filters), and rename wins.
    await parent.instance.renameFork(result.forkId, "Renamed fork");
    await parent.instance.archiveFork(result.forkId);
    const after = await parent.instance.listForks();
    expect(after.forks).toHaveLength(1);
    expect(after.forks[0]).toMatchObject({
      forkId: result.forkId,
      label: "Renamed fork",
      archived: true,
    });
  });

  it("resolves semantic message loci without trusting client sequence arithmetic", async () => {
    const { instance, sql } = await createGadBackedChannel({
      channelKey: "channel-loci",
    });
    sql.exec(
      `INSERT INTO fork_turn_loci (turn_id, opened_seq) VALUES ('turn-1', 20)`,
    );
    sql.exec(
      `INSERT INTO fork_message_loci
         (message_id, first_seq, terminal_seq, turn_id, actor_kind)
       VALUES ('assistant-1', 21, 27, 'turn-1', 'agent'),
              ('streaming-1', 30, NULL, 'turn-2', 'agent')`,
    );
    const internal = instance as unknown as {
      resolveForkRequest(request: Record<string, unknown>): Promise<{
        forkPointPubsubId: number;
        seed?: { replaces?: { messageId: string; seq: number } };
      }>;
    };

    await expect(
      internal.resolveForkRequest({
        operationId: "semantic-before-1",
        locus: { kind: "before-message", messageId: "assistant-1" },
        reason: "edit",
        seed: {
          author: { kind: "user", id: "user-1" },
          blocks: [{ type: "text", content: "revised" }],
          replaces: { messageId: "assistant-1" },
        },
      }),
    ).resolves.toMatchObject({
      forkPointPubsubId: 19,
      seed: {
        author: { kind: "system", id: "system" },
        replaces: { messageId: "assistant-1", seq: 27 },
      },
    });
    await expect(
      internal.resolveForkRequest({
        operationId: "semantic-after-1",
        locus: { kind: "after-message", messageId: "assistant-1" },
        reason: "fork",
      }),
    ).resolves.toMatchObject({ forkPointPubsubId: 27 });
    await expect(
      internal.resolveForkRequest({
        operationId: "semantic-unfinished-1",
        locus: { kind: "after-message", messageId: "streaming-1" },
        reason: "fork",
      }),
    ).rejects.toThrow(/cannot fork after unfinished message streaming-1/);
  });

  it("keeps failed fork cleanup retryable until context destruction succeeds", async () => {
    let destroyAttempts = 0;
    const { instance, sql } = await createGadBackedChannel({
      rpcCall: (_target, method) => {
        if (method !== "runtime.destroyContext") return undefined;
        destroyAttempts += 1;
        if (destroyAttempts === 1) throw new Error("cleanup unavailable");
        return null;
      },
    });
    const now = Date.now();
    sql.exec(
      `INSERT INTO fork_ops
         (fork_id, fork_point_id, opts, phase, forked_channel_id,
          forked_context_id, created_at, updated_at)
       VALUES (?, 1, ?, 'cloned', 'child-1', 'context-child-1', ?, ?)`,
      "fork-cleanup-1",
      JSON.stringify({
        operationId: "fork-cleanup-1",
        locus: { kind: "head" },
        request: {
          operationId: "fork-cleanup-1",
          locus: { kind: "head" },
          reason: "test",
        },
        forkPointPubsubId: 1,
        reason: "test",
      }),
      now,
      now,
    );
    const internal = instance as unknown as {
      rollbackForkOp(forkId: string): Promise<boolean>;
    };

    await expect(internal.rollbackForkOp("fork-cleanup-1")).resolves.toBe(
      false,
    );
    expect(sql.exec(`SELECT phase FROM fork_ops`).one()["phase"]).toBe(
      "rollback-pending",
    );
    await expect(internal.rollbackForkOp("fork-cleanup-1")).resolves.toBe(true);
    expect(sql.exec(`SELECT phase FROM fork_ops`).one()["phase"]).toBe(
      "rolledback",
    );
  });

  it("re-homes the channel's context when postClone threads a new contextId", async () => {
    const parent = await createGadBackedChannel({
      channelKey: "channel-ctx-parent",
    });
    setRpcCaller(parent.instance, "panel:user", "panel");
    await parent.instance.subscribe("panel:user", {
      contextId: "ctx-src",
      name: "User",
      type: "panel",
    });
    await parent.instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent("message.completed"),
    );

    // A true context fork re-homes the channel into a fresh isolated context.
    const fork = await createGadBackedChannel({
      channelKey: "channel-ctx-fork",
      gad: parent.gad,
    });
    await fork.instance.postClone("channel-ctx-parent", 2, "ctx-forked");
    expect(await fork.instance.getContextId()).toBe("ctx-forked");

    // Omitting the new contextId is rejected; forks always get a fresh context.
    const fork2 = await createGadBackedChannel({
      channelKey: "channel-ctx-fork2",
      gad: parent.gad,
    });
    await expect(
      (
        fork2.instance as unknown as {
          postClone(
            parentChannelId: string,
            forkPointId: number,
          ): Promise<void>;
        }
      ).postClone("channel-ctx-parent", 2),
    ).rejects.toThrow(/postClone requires newContextId/);
  });

  it("routes by transport id but publishes terminal events under the canonical invocation id", async () => {
    const { instance, gad } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-1",
      "eval",
      { code: "1 + 1" },
      {
        invocationId: "invocation-1",
        transportCallId: "transport-1",
        turnId: "turn-1",
      },
    );

    await instance.cancelMethodCall("panel:caller", "transport-1");

    const rows = gad.sql
      .exec(
        `SELECT payload_ref_json FROM log_events WHERE payload_kind = ? ORDER BY seq ASC`,
        AGENTIC_EVENT_PAYLOAD_KIND,
      )
      .toArray();
    const events = rows.map((row: Record<string, unknown>) =>
      JSON.parse(row["payload_ref_json"] as string),
    );
    const started = events.find(
      (event: { kind?: string }) => event.kind === "invocation.started",
    );
    const cancelled = events.find(
      (event: { kind?: string }) => event.kind === "invocation.cancelled",
    );

    expect(started).toMatchObject({
      turnId: "turn-1",
      causality: {
        invocationId: "invocation-1",
        transportCallId: "transport-1",
      },
      payload: { transport: { transportCallId: "transport-1" } },
    });
    expect(cancelled).toMatchObject({
      turnId: "turn-1",
      causality: {
        invocationId: "invocation-1",
        transportCallId: "transport-1",
      },
    });
  });

  it("lets a DO participant cancel its own call but rejects cancellation by another participant", async () => {
    const { instance, gad } = await createGadBackedChannel({
      rpcCall: (target, method, args) => {
        if (
          target === "main" &&
          method === "workspace-state.entity.resolveActive"
        ) {
          return { id: args[0], kind: "do" };
        }
        return undefined;
      },
    });
    const caller = "do:vibestudio/internal:EvalDO:system-tests";

    await joinResidentSession(instance, caller, {
      name: "System tests",
      type: "headless",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });
    setRpcCaller(instance, "panel:other", "panel");
    await instance.subscribe("panel:other", {
      contextId: "ctx-1",
      name: "Other",
      type: "panel",
    });

    setRpcCaller(instance, caller, "do");
    await instance.callMethod(
      caller,
      "panel:provider",
      "transport-owned-by-do",
      "eval",
      {
        code: "await forever()",
      },
    );

    setRpcCaller(instance, "panel:other", "panel");
    await expect(
      instance.cancelMethodCall("panel:other", "transport-owned-by-do"),
    ).rejects.toThrow(/did not initiate method call/);
    expect(
      gad.sql
        .exec(
          `SELECT 1 FROM log_events WHERE envelope_id = ?`,
          "terminal:transport-owned-by-do",
        )
        .toArray(),
    ).toHaveLength(0);

    setRpcCaller(instance, caller, "do");
    await instance.cancelMethodCall(caller, "transport-owned-by-do");
    expect(
      gad.sql
        .exec(
          `SELECT 1 FROM log_events WHERE envelope_id = ?`,
          "terminal:transport-owned-by-do",
        )
        .toArray(),
    ).toHaveLength(1);
  });

  it("reconstructs pending_calls during cancelMethodCall before dropping (cache-cold)", async () => {
    const { instance, sql, gad } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-cancel-cold",
      "eval",
      { code: "1 + 1" },
      {
        invocationId: "invocation-cancel-cold",
        transportCallId: "transport-cancel-cold",
        turnId: "turn-cancel-cold",
      },
    );

    // Simulate a cache-cold row (post-eviction): the durable started survives,
    // the SQLite cache row is gone. A cancel must reconcile and still settle.
    sql.exec(
      `DELETE FROM pending_calls WHERE transport_call_id = ?`,
      "transport-cancel-cold",
    );

    await instance.cancelMethodCall("panel:caller", "transport-cancel-cold");

    const cancelled = gad.sql
      .exec(
        `SELECT envelope_id FROM log_events WHERE envelope_id = ?`,
        "terminal:transport-cancel-cold",
      )
      .toArray();
    expect(cancelled).toHaveLength(1);
  });

  it("settles an expired timed call through a host-held deadline claim", async () => {
    const { instance, sql, gad } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-timed",
      "eval",
      { code: "1 + 1" },
      {
        invocationId: "invocation-timed",
        transportCallId: "transport-timed",
        turnId: "turn-timed",
        timeoutMs: 60_000,
      },
    );

    const row = sql
      .exec(
        `SELECT deadline_at FROM pending_calls WHERE transport_call_id = ?`,
        "transport-timed",
      )
      .toArray()[0] as { deadline_at: number | null } | undefined;
    expect(row?.deadline_at).toEqual(expect.any(Number));

    sql.exec(
      `UPDATE pending_calls SET deadline_at = ? WHERE transport_call_id = ?`,
      Date.now() - 1,
      "transport-timed",
    );
    await instance.alarm();
    const [claim] = instance.claimReadyWork("channel-delivery", {
      workerId: "test-host",
      now: Date.now(),
      limit: 1,
    });
    expect(claim?.itemId).toBe("maintenance:call-deadline:transport-timed");
    const outcome = await instance.executeChannelMaintenanceClaim({
      itemId: claim!.itemId,
      generation: claim!.generation,
    });
    expect(
      instance.settleReadyWork("channel-delivery", {
        workerId: "test-host",
        itemId: claim!.itemId,
        generation: claim!.generation,
        outcome,
      }),
    ).toBe("accepted");

    expect(
      sql
        .exec(
          `SELECT 1 FROM pending_calls WHERE transport_call_id = ?`,
          "transport-timed",
        )
        .toArray(),
    ).toEqual([]);
    expect(
      gad.sql
        .exec(
          `SELECT 1 FROM log_events WHERE envelope_id = ?`,
          "terminal:transport-timed",
        )
        .toArray(),
    ).toHaveLength(1);
  });

  it("does not use the durable alarm as a stale pending-call redelivery loop", async () => {
    const emitted: unknown[] = [];
    const { instance, sql } = await createGadBackedChannel({ emitted });
    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });
    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-redelivery",
      "slow_method",
      { value: 1 },
      {
        invocationId: "invocation-redelivery",
        transportCallId: "transport-redelivery",
      },
    );
    sql.exec(
      `UPDATE pending_calls SET created_at = ? WHERE transport_call_id = ?`,
      Date.now() - 60_000,
      "transport-redelivery",
    );
    emitted.length = 0;

    await instance.alarm();

    expect(
      emitted.some((payload) => {
        const message = (payload as { message?: { payload?: AgenticEvent } })
          .message;
        return (
          message?.payload?.causality?.transportCallId ===
          "transport-redelivery"
        );
      }),
    ).toBe(false);
    expect(
      sql
        .exec(
          `SELECT 1 FROM pending_calls WHERE transport_call_id = ?`,
          "transport-redelivery",
        )
        .toArray(),
    ).toHaveLength(1);
  });

  it("does not re-enter an agent method from a stale-call alarm sweep", async () => {
    const targetPid = "do:workers/agent-worker:AiChatWorker:agent-redelivery";
    const methodCalls: unknown[][] = [];
    const emitted: unknown[] = [];
    const { instance, sql } = await createGadBackedChannel({
      emitted,
      rpcCall: async (target, method, args) => {
        if (
          target === "main" &&
          method === "workspace-state.entity.resolveActive"
        ) {
          return { id: args[0], kind: "do" };
        }
        if (target === targetPid && method === "onChannelEnvelope") return null;
        if (target === targetPid && method === "onMethodCall") {
          methodCalls.push(args);
          return new Promise(() => {});
        }
        return undefined;
      },
    });
    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    await joinEntity(instance, targetPid);
    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      targetPid,
      "transport-agent-redelivery",
      "slow_method",
      { value: 1 },
      {
        invocationId: "invocation-agent-redelivery",
        transportCallId: "transport-agent-redelivery",
      },
    );
    expect(methodCalls).toHaveLength(1);
    sql.exec(
      `UPDATE pending_calls SET created_at = ? WHERE transport_call_id = ?`,
      Date.now() - 60_000,
      "transport-agent-redelivery",
    );
    emitted.length = 0;

    await instance.alarm();

    expect(methodCalls).toHaveLength(1);
    expect(
      emitted.some((payload) => {
        const message = (payload as { message?: { payload?: AgenticEvent } })
          .message;
        return (
          message?.payload?.causality?.transportCallId ===
          "transport-agent-redelivery"
        );
      }),
    ).toBe(false);
  });

  it("settles pending method calls as an error from malformed terminal invocation events", async () => {
    const { instance } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-malformed",
      "eval",
      { code: "1 + 1" },
      {
        invocationId: "invocation-malformed",
        transportCallId: "transport-malformed",
        turnId: "turn-malformed",
      },
    );

    // The publish is still rejected loudly so the producer sees its bug...
    setRpcCaller(instance, "panel:provider", "panel");
    await expect(
      instance.publish("panel:provider", AGENTIC_EVENT_PAYLOAD_KIND, {
        kind: "invocation.failed",
        actor: { kind: "panel", id: "panel:provider" },
        turnId: "turn-malformed",
        causality: {
          invocationId: "invocation-malformed",
          transportCallId: "transport-malformed",
        },
        // schema rejection fixture: terminalOutcome is intentionally omitted
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          reason: "malformed terminal event",
        },
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/terminalOutcome/u);

    // Invocation events are display/history only now; malformed terminal logs
    // are rejected but no longer settle method transport.
    const pending = (
      instance as unknown as {
        sql: { exec: (...args: unknown[]) => { toArray(): unknown[] } };
      }
    ).sql
      .exec(
        `SELECT transport_call_id FROM pending_calls WHERE transport_call_id = ?`,
        "transport-malformed",
      )
      .toArray();
    expect(pending).toHaveLength(1);
  });

  it("settles pending method calls from submitMethodResult", async () => {
    const { instance } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-ok",
      "eval",
      { code: "1 + 1" },
      {
        invocationId: "invocation-ok",
        transportCallId: "transport-ok",
        turnId: "turn-ok",
      },
    );

    setRpcCaller(instance, "panel:provider", "panel");
    await instance.submitMethodResult(
      "panel:provider",
      "transport-ok",
      2,
      false,
      {
        invocationId: "invocation-ok",
        turnId: "turn-ok",
        terminalOutcome: "success",
      },
    );

    const pending = (
      instance as unknown as {
        sql: { exec: (...args: unknown[]) => { toArray(): unknown[] } };
      }
    ).sql
      .exec(
        `SELECT transport_call_id FROM pending_calls WHERE transport_call_id = ?`,
        "transport-ok",
      )
      .toArray();
    expect(pending).toHaveLength(0);
  });

  it("reconstructs pending_calls during submitMethodResult before dropping a result", async () => {
    const { instance, sql, gad } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-cache-race",
      "eval",
      { code: "1 + 1" },
      {
        invocationId: "invocation-cache-race",
        transportCallId: "transport-cache-race",
        turnId: "turn-cache-race",
      },
    );

    sql.exec(
      `DELETE FROM pending_calls WHERE transport_call_id = ?`,
      "transport-cache-race",
    );

    setRpcCaller(instance, "panel:provider", "panel");
    const result = await instance.submitMethodResult(
      "panel:provider",
      "transport-cache-race",
      2,
      false,
      {
        invocationId: "invocation-cache-race",
        turnId: "turn-cache-race",
        terminalOutcome: "success",
      },
    );

    expect(result.id).toEqual(expect.any(Number));
    expect(
      sql
        .exec(
          `SELECT transport_call_id FROM pending_calls WHERE transport_call_id = ?`,
          "transport-cache-race",
        )
        .toArray(),
    ).toHaveLength(0);
    const terminals = gad.sql
      .exec(
        `SELECT envelope_id FROM log_events WHERE envelope_id = ?`,
        "terminal:transport-cache-race",
      )
      .toArray();
    expect(terminals).toHaveLength(1);
  });

  it("reconstructs agent-loop channel calls whose transport id lives in payload.transport", async () => {
    const { instance, sql, gad } = await createGadBackedChannel();

    setRpcCaller(instance, "do:agent", "durable-object");
    await instance.subscribe("do:agent", {
      contextId: "ctx-1",
      name: "Agent",
      type: "agent",
    });
    setRpcCaller(instance, "do:eval", "durable-object");
    await instance.subscribe("do:eval", {
      contextId: "ctx-1",
      name: "Headless",
      type: "headless",
    });

    await gad.instance.appendLogEvent({
      logId: "channel-1",
      head: "main",
      logKind: "channel",
      events: [
        {
          envelopeId: "invocation-agent-loop",
          actor: { kind: "agent", id: "do:agent", participantId: "do:agent" },
          payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
          annotations: { contentClass: "internal", externalKeys: [] },
          payload: {
            kind: "invocation.started",
            actor: { kind: "agent", id: "do:agent", participantId: "do:agent" },
            turnId: "turn-agent-loop",
            causality: {
              invocationId: "invocation-agent-loop",
              modelToolCallId: "invocation-agent-loop",
            },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              name: "set_title",
              invocationType: "panel",
              request: {
                protocol: "vibestudio.blob-ref.v1",
                digest: "request-agent-loop",
                size: 35,
                encoding: "json",
                originalBytes: 35,
              },
              transport: {
                kind: "channel",
                channelId: "channel-1",
                target: {
                  kind: "user",
                  id: "do:eval",
                  participantId: "do:eval",
                },
                transportCallId: "transport-agent-loop",
              },
              userVisible: true,
            },
            createdAt: "2026-06-25T13:28:08.115Z",
          },
        },
      ],
    });

    const { inserted } = await instance.reconcilePendingCalls(true);
    expect(inserted).toBe(1);
    expect(
      sql
        .exec(
          `SELECT transport_call_id, invocation_id, method FROM pending_calls WHERE transport_call_id = ?`,
          "transport-agent-loop",
        )
        .toArray(),
    ).toEqual([
      expect.objectContaining({
        transport_call_id: "transport-agent-loop",
        invocation_id: "invocation-agent-loop",
        method: "set_title",
      }),
    ]);

    setRpcCaller(instance, "do:eval", "durable-object");
    const result = await instance.submitMethodResult(
      "do:eval",
      "transport-agent-loop",
      {
        ok: true,
      },
      false,
      {
        invocationId: "invocation-agent-loop",
        turnId: "turn-agent-loop",
        terminalOutcome: "success",
      },
    );

    expect(result).toEqual({ id: expect.any(Number) });
    expect(
      gad.sql
        .exec(
          `SELECT envelope_id FROM log_events WHERE envelope_id = ?`,
          "invocation-agent-loop",
        )
        .toArray(),
    ).toHaveLength(1);
    expect(
      gad.sql
        .exec(
          `SELECT envelope_id FROM log_events WHERE envelope_id = ?`,
          "terminal:transport-agent-loop",
        )
        .toArray(),
    ).toHaveLength(1);
  });

  it("recovers a lost call: appends a terminal when a result has no pending row and no started", async () => {
    const emitted: unknown[] = [];
    const { instance, gad } = await createGadBackedChannel({ emitted });

    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    // No call was ever journaled for this transportCallId (cache-cold / lost
    // started record): reconcile finds nothing and there is no durable terminal.
    // Dropping the result would strand the caller forever — its parked
    // invocation only settles on a terminal carrying the same invocationId. So
    // the channel must ROOT the method and append a real terminal instead of a
    // silent no-op.
    setRpcCaller(instance, "panel:provider", "panel");
    const result = await instance.submitMethodResult(
      "panel:provider",
      "transport-lost-record",
      42,
      false,
      { invocationId: "invocation-lost-record", turnId: "turn-lost-record" },
    );

    // The submitter still gets an observability signal, but it is a RECOVERY,
    // not a drop — a real terminal seq id is returned.
    expect(result).toMatchObject({
      id: expect.any(Number),
      dropped: false,
      recovered: true,
    });

    // A durable terminal event now exists, keyed on the transportCallId and
    // carrying the caller's invocationId (what routeInvocationTerminal matches).
    const terminalRow = gad.sql
      .exec(
        `SELECT payload_ref_json FROM log_events WHERE envelope_id = ?`,
        "terminal:transport-lost-record",
      )
      .toArray();
    expect(terminalRow).toHaveLength(1);
    expect(
      JSON.parse(terminalRow[0]!["payload_ref_json"] as string),
    ).toMatchObject({
      kind: "invocation.completed",
      causality: {
        invocationId: "invocation-lost-record",
        transportCallId: "transport-lost-record",
      },
      payload: { result: 42, terminalOutcome: "success" },
    });

    // The synthetic `started` root was appended too (fold invariant: every
    // terminal is paired with a started carrying the same invocation id).
    const rootRow = gad.sql
      .exec(
        `SELECT payload_ref_json FROM log_events WHERE envelope_id = ?`,
        "invocation-lost-record",
      )
      .toArray();
    expect(rootRow).toHaveLength(1);
    expect(JSON.parse(rootRow[0]!["payload_ref_json"] as string)).toMatchObject(
      {
        kind: "invocation.started",
        causality: {
          invocationId: "invocation-lost-record",
          transportCallId: "transport-lost-record",
        },
      },
    );

    // The terminal is broadcast so subscribers (the caller) actually receive it.
    // The wire shape is { channelId, message: { kind: "log", event } } — the
    // invocation payload lives at message.event.payload.
    const broadcastCompleted = emitted
      .map(
        (payload) =>
          (
            payload as {
              message?: {
                event?: {
                  payload?: {
                    kind?: string;
                    causality?: { transportCallId?: string };
                  };
                };
              };
            }
          ).message?.event?.payload,
      )
      .find(
        (agentic) =>
          agentic?.kind === "invocation.completed" &&
          agentic?.causality?.transportCallId === "transport-lost-record",
      );
    expect(broadcastCompleted).toBeDefined();
  });

  it("recovers a lost call as invocation.failed when the submission isError", async () => {
    const { instance, gad } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:provider", "panel");
    const result = await instance.submitMethodResult(
      "panel:provider",
      "transport-lost-error",
      "boom",
      true,
      { invocationId: "invocation-lost-error" },
    );
    expect(result).toMatchObject({
      id: expect.any(Number),
      dropped: false,
      recovered: true,
    });

    const terminal = gad.sql
      .exec(
        `SELECT payload_ref_json FROM log_events WHERE envelope_id = ?`,
        "terminal:transport-lost-error",
      )
      .toArray();
    expect(terminal).toHaveLength(1);
    expect(
      JSON.parse(terminal[0]!["payload_ref_json"] as string),
    ).toMatchObject({
      kind: "invocation.failed",
      causality: { invocationId: "invocation-lost-error" },
      payload: { terminalOutcome: "tool_error" },
    });
  });

  it("settles via the NORMAL path when a result races an in-flight started append (no recovery)", async () => {
    // Root-cause durability case: callMethod journals the `started` to GAD
    // (a cross-DO RPC) BEFORE inserting the cache row. If a submitMethodResult
    // for the same transportCallId arrives WHILE that append is in flight, the
    // call exists in neither the cache (insertRow hasn't run) nor a committed
    // durable log a forced reconcile can re-derive it from. Without the
    // start-journaling barrier the submit fell through to settleMissingCall —
    // synthesizing a SECOND (synthetic) started + terminal instead of settling
    // against the canonical one (the observed "recovered a lost call" log).
    //
    // With the barrier, submit waits for the canonical started to commit, then
    // settles via the normal pending path: exactly one started, one terminal,
    // and result.recovered is never set.
    const blockStarted = deferred();
    let blockedOnce = false;
    const gad = await createTestDO(GadWorkspaceDO, {
      __objectKey: "workspace",
    });
    const { instance } = await createGadBackedChannel({
      gad,
      rpcCall: async (target, method, args) => {
        if (
          target === "do:workers/workspace-source:GadWorkspaceDO:workspace" &&
          method === "appendLogEvent"
        ) {
          const event = (
            args[0] as {
              events?: Array<{ payloadKind?: string; payload?: unknown }>;
            }
          )?.events?.[0];
          const payload = event?.payload as { kind?: string } | undefined;
          if (
            !blockedOnce &&
            event?.payloadKind === AGENTIC_EVENT_PAYLOAD_KIND &&
            payload?.kind === "invocation.started"
          ) {
            blockedOnce = true;
            // Hold the started append open, then let the real append proceed
            // (returning undefined falls through to the default gad handler).
            await blockStarted.promise;
          }
        }
        return undefined;
      },
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    // Fire callMethod; it parks inside the blocked `started` append.
    setRpcCaller(instance, "panel:caller", "panel");
    const callPromise = instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-start-race",
      "eval",
      { code: "1 + 1" },
      {
        invocationId: "invocation-start-race",
        transportCallId: "transport-start-race",
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    // The result arrives while the start is mid-append. It must NOT recover —
    // it parks on the in-flight barrier until the canonical started commits.
    setRpcCaller(instance, "panel:provider", "panel");
    const submitPromise = instance.submitMethodResult(
      "panel:provider",
      "transport-start-race",
      99,
      false,
      { invocationId: "invocation-start-race" },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Release the started append; both the call and the parked submit drain.
    blockStarted.resolve();
    const result = await submitPromise;
    await callPromise;

    // Settled via the NORMAL path — no lost-call recovery.
    expect(result.id).toEqual(expect.any(Number));
    expect(result.recovered).toBeUndefined();

    // Exactly one canonical started (envelopeId = invocationId) and one
    // terminal; no synthetic root was appended.
    const started = gad.sql
      .exec(
        `SELECT envelope_id FROM log_events WHERE envelope_id = ?`,
        "invocation-start-race",
      )
      .toArray();
    expect(started).toHaveLength(1);
    const startedEvents = gad.sql
      .exec(
        `SELECT payload_ref_json FROM log_events WHERE payload_kind = ? ORDER BY seq ASC`,
        AGENTIC_EVENT_PAYLOAD_KIND,
      )
      .toArray()
      .map((row: Record<string, unknown>) =>
        JSON.parse(row["payload_ref_json"] as string),
      );
    expect(
      startedEvents.filter((e) => e.kind === "invocation.started"),
    ).toHaveLength(1);
    expect(
      startedEvents.filter((e) => e.kind === "invocation.completed"),
    ).toHaveLength(1);
    const terminal = gad.sql
      .exec(
        `SELECT envelope_id FROM log_events WHERE envelope_id = ?`,
        "terminal:transport-start-race",
      )
      .toArray();
    expect(terminal).toHaveLength(1);

    // The cache row is consumed.
    expect(
      (
        instance as unknown as {
          sql: { exec: (...args: unknown[]) => { toArray(): unknown[] } };
        }
      ).sql
        .exec(
          `SELECT transport_call_id FROM pending_calls WHERE transport_call_id = ?`,
          "transport-start-race",
        )
        .toArray(),
    ).toHaveLength(0);
  });

  it("appends a durable invocation.completed terminal (no method-result envelope)", async () => {
    const emitted: unknown[] = [];
    const { instance, gad } = await createGadBackedChannel({ emitted });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-envelope",
      "eval",
      { code: "1 + 1" },
      {
        invocationId: "invocation-envelope",
        transportCallId: "transport-envelope",
        turnId: "turn-envelope",
      },
    );

    setRpcCaller(instance, "panel:provider", "panel");
    await instance.submitMethodResult(
      "panel:provider",
      "transport-envelope",
      2,
      false,
      {
        invocationId: "invocation-envelope",
        turnId: "turn-envelope",
        terminalOutcome: "success",
        attachments: [
          { id: "att-1", data: "AA==", mimeType: "text/plain", size: 1 },
        ],
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    // No method-* wire envelope is emitted anymore.
    const methodEnvelope = emitted
      .map((payload) => (payload as { message?: { kind?: string } }).message)
      .find(
        (message) =>
          typeof message?.kind === "string" &&
          message.kind.startsWith("method-"),
      );
    expect(methodEnvelope).toBeUndefined();

    // The canonical terminal is a durable invocation.completed log event,
    // carrying the result and the attachment on the envelope.
    const envelopes = gad.sql
      .exec(
        `SELECT payload_ref_json, annotations_json FROM log_events ORDER BY seq ASC`,
      )
      .toArray();
    const completed = envelopes.find(
      (row) =>
        (JSON.parse(row["payload_ref_json"] as string) as { kind?: string })
          .kind === "invocation.completed",
    );
    expect(completed).toBeDefined();
    expect(JSON.parse(completed!["payload_ref_json"] as string)).toMatchObject({
      kind: "invocation.completed",
      causality: { transportCallId: "transport-envelope" },
      payload: { result: 2, terminalOutcome: "success" },
    });
    expect(JSON.parse(completed!["annotations_json"] as string)).toMatchObject({
      attachments: [{ id: "att-1", mimeType: "text/plain" }],
    });
  });

  it("appends a durable invocation.cancelled on cancel and drops late submits", async () => {
    const emitted: unknown[] = [];
    const { instance, gad } = await createGadBackedChannel({ emitted });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-cancel-envelope",
      "eval",
      { code: "await forever()" },
      {
        invocationId: "invocation-cancel-envelope",
        transportCallId: "transport-cancel-envelope",
        turnId: "turn-cancel-envelope",
      },
    );

    await instance.cancelMethodCall(
      "panel:caller",
      "transport-cancel-envelope",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    // No method-* wire envelope — provider abort derives from invocation.cancelled.
    const methodEnvelope = emitted
      .map((payload) => (payload as { message?: { kind?: string } }).message)
      .find(
        (message) =>
          typeof message?.kind === "string" &&
          message.kind.startsWith("method-"),
      );
    expect(methodEnvelope).toBeUndefined();

    // Durable invocation.cancelled terminal.
    const cancelled = gad.sql
      .exec(`SELECT payload_ref_json FROM log_events ORDER BY seq ASC`)
      .toArray()
      .map(
        (row) =>
          JSON.parse(row["payload_ref_json"] as string) as {
            kind?: string;
            causality?: { transportCallId?: string };
          },
      )
      .find((ev) => ev.kind === "invocation.cancelled");
    expect(cancelled).toMatchObject({
      kind: "invocation.cancelled",
      causality: { transportCallId: "transport-cancel-envelope" },
      payload: expect.objectContaining({ terminalOutcome: "cancelled" }),
    });

    // The call is consumed: a late terminal is idempotently acknowledged with
    // the existing terminal id, and late progress is a no-op.
    setRpcCaller(instance, "panel:provider", "panel");
    const terminalCountBefore = gad.sql
      .exec(
        `SELECT COUNT(*) AS cnt FROM log_events WHERE envelope_id LIKE 'terminal:%'`,
      )
      .toArray()[0]?.["cnt"];
    await expect(
      instance.submitMethodResult(
        "panel:provider",
        "transport-cancel-envelope",
        "late",
        false,
      ),
    ).resolves.toEqual({ id: expect.any(Number) });
    expect(
      gad.sql
        .exec(
          `SELECT COUNT(*) AS cnt FROM log_events WHERE envelope_id LIKE 'terminal:%'`,
        )
        .toArray()[0]?.["cnt"],
    ).toBe(terminalCountBefore);
    await expect(
      instance.submitMethodProgress(
        "panel:provider",
        "transport-cancel-envelope",
        "late progress",
      ),
    ).resolves.toBeUndefined();
  });

  it("appends a durable invocation.output for a pending call and no-ops once consumed", async () => {
    const { instance, gad } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-output",
      "eval",
      { code: "stream()" },
      {
        invocationId: "invocation-output",
        transportCallId: "transport-output",
        turnId: "turn-output",
      },
    );

    setRpcCaller(instance, "panel:provider", "panel");
    await instance.submitMethodProgress(
      "panel:provider",
      "transport-output",
      "chunk-1",
    );

    const output = gad.sql
      .exec(`SELECT payload_ref_json FROM log_events ORDER BY seq ASC`)
      .toArray()
      .map(
        (row) =>
          JSON.parse(row["payload_ref_json"] as string) as {
            kind?: string;
            causality?: { transportCallId?: string };
            payload?: { output?: unknown };
          },
      )
      .find((ev) => ev.kind === "invocation.output");
    // Progress chunks are class-REFERENCE (storage classes: fold-opaque
    // streaming bulk is ALWAYS a ref, even when tiny — one code path).
    expect(output).toMatchObject({
      kind: "invocation.output",
      causality: { transportCallId: "transport-output" },
      payload: {
        output: { protocol: "vibestudio.blob-ref.v1", encoding: "text" },
      },
    });

    // Consume the call, then a late progress chunk is a quiet no-op (not appended).
    await instance.submitMethodResult(
      "panel:provider",
      "transport-output",
      "done",
      false,
    );
    await expect(
      instance.submitMethodProgress(
        "panel:provider",
        "transport-output",
        "chunk-2",
      ),
    ).resolves.toBeUndefined();
    const outputs = gad.sql
      .exec(`SELECT payload_ref_json FROM log_events ORDER BY seq ASC`)
      .toArray()
      .map(
        (row) =>
          JSON.parse(row["payload_ref_json"] as string) as { kind?: string },
      )
      .filter((ev) => ev.kind === "invocation.output");
    expect(outputs).toHaveLength(1);
  });

  it("rejects method result and progress submissions from non-target participants", async () => {
    const { instance } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });
    setRpcCaller(instance, "panel:intruder", "panel");
    await instance.subscribe("panel:intruder", {
      contextId: "ctx-1",
      name: "Intruder",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-guarded",
      "eval",
      { code: "1 + 1" },
      {
        invocationId: "invocation-guarded",
        transportCallId: "transport-guarded",
        turnId: "turn-guarded",
      },
    );

    setRpcCaller(instance, "panel:intruder", "panel");
    await expect(
      instance.submitMethodResult(
        "panel:intruder",
        "transport-guarded",
        99,
        false,
      ),
    ).rejects.toThrow(/not target/u);
    await expect(
      instance.submitMethodProgress(
        "panel:intruder",
        "transport-guarded",
        "still working",
      ),
    ).rejects.toThrow(/not target/u);

    setRpcCaller(instance, "panel:provider", "panel");
    await expect(
      instance.submitMethodResult(
        "panel:provider",
        "transport-guarded",
        2,
        false,
        {
          invocationId: "invocation-guarded",
          turnId: "turn-guarded",
        },
      ),
    ).resolves.toEqual({ id: expect.any(Number) });
  });

  // A terminal with no live pending call (already consumed / unknown) is dropped:
  // the canonical terminal is already in the durable log from the original settle.
  it("drops a method result with no live pending call", async () => {
    const { instance, gad } = await createGadBackedChannel();
    const worker = instance as unknown as {
      handleMethodResult(
        callId: string,
        content: unknown,
        isError: boolean,
        outcome?: string,
        reason?: string,
      ): Promise<number | undefined>;
    };

    const id = await worker.handleMethodResult(
      "transport-orphan",
      { value: 42 },
      false,
      "success",
    );
    expect(id).toBeUndefined();

    // No invocation.* terminal is appended for an unknown call.
    const orphan = gad.sql
      .exec(`SELECT payload_ref_json FROM log_events ORDER BY seq ASC`)
      .toArray()
      .map(
        (row) =>
          JSON.parse(row["payload_ref_json"] as string) as {
            causality?: { transportCallId?: string };
          },
      )
      .find((ev) => ev.causality?.transportCallId === "transport-orphan");
    expect(orphan).toBeUndefined();
  });

  // A target leaving appends a durable invocation.abandoned terminal so a
  // hibernated caller recovers the outcome from replay instead of hanging.
  it("appends a durable invocation.abandoned terminal when the target leaves", async () => {
    const { instance, gad } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-left",
      "eval",
      { code: "1 + 1" },
      {
        invocationId: "invocation-left",
        transportCallId: "transport-left",
        turnId: "turn-left",
      },
    );

    const worker = instance as unknown as {
      failPendingCallsTargeting(
        targetId: string,
        reason: "graceful" | "disconnect" | "replaced",
      ): Promise<void>;
    };
    await worker.failPendingCallsTargeting("panel:provider", "disconnect");

    const abandoned = gad.sql
      .exec(`SELECT payload_ref_json FROM log_events ORDER BY seq ASC`)
      .toArray()
      .map(
        (row) =>
          JSON.parse(row["payload_ref_json"] as string) as {
            kind?: string;
            causality?: { transportCallId?: string };
          },
      )
      .find(
        (ev) =>
          ev.kind === "invocation.abandoned" &&
          ev.causality?.transportCallId === "transport-left",
      );
    expect(abandoned).toBeDefined();
  });

  it("settles pending method calls from abandoned method results", async () => {
    const { instance } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-abandoned",
      "eval",
      { code: "await forever()" },
      {
        invocationId: "invocation-abandoned",
        transportCallId: "transport-abandoned",
        turnId: "turn-abandoned",
      },
    );

    setRpcCaller(instance, "panel:provider", "panel");
    const result = await instance.submitMethodResult(
      "panel:provider",
      "transport-abandoned",
      "runner restarted",
      true,
      {
        invocationId: "invocation-abandoned",
        turnId: "turn-abandoned",
        terminalOutcome: "abandoned",
        terminalReasonCode: "runner_restarted_before_invocation_completed",
      },
    );

    expect(result.id).toBeTypeOf("number");
    const pending = (
      instance as unknown as {
        sql: { exec: (...args: unknown[]) => { toArray(): unknown[] } };
      }
    ).sql
      .exec(
        `SELECT transport_call_id FROM pending_calls WHERE transport_call_id = ?`,
        "transport-abandoned",
      )
      .toArray();
    expect(pending).toHaveLength(0);

    const events = (await instance.getReplayAfter({ after: 0 })).logEvents.map(
      (event) => event.payload as { kind?: string; payload?: unknown },
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "invocation.abandoned",
          payload: expect.objectContaining({
            terminalOutcome: "abandoned",
            terminalReasonCode: "runner_restarted_before_invocation_completed",
          }),
        }),
      ]),
    );
    expect(events.some((event) => event.kind === "invocation.failed")).toBe(
      false,
    );
  });

  it("preserves cancelled outcome when provider cancellation settles a pending method call", async () => {
    const { instance } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-cancelled",
      "eval",
      { code: "await forever()" },
      {
        invocationId: "invocation-cancelled",
        transportCallId: "transport-cancelled",
        turnId: "turn-cancelled",
      },
    );

    setRpcCaller(instance, "panel:provider", "panel");
    const result = await instance.submitMethodResult(
      "panel:provider",
      "transport-cancelled",
      "cancelled",
      true,
      {
        invocationId: "invocation-cancelled",
        turnId: "turn-cancelled",
        terminalOutcome: "cancelled",
        terminalReasonCode: "cancelled",
      },
    );

    expect(result.id).toBeTypeOf("number");
    const events = (await instance.getReplayAfter({ after: 0 })).logEvents.map(
      (event) => event.payload as { kind?: string; payload?: unknown },
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "invocation.cancelled",
          payload: expect.objectContaining({
            terminalOutcome: "cancelled",
            terminalReasonCode: "cancelled",
          }),
        }),
      ]),
    );
    expect(events.some((event) => event.kind === "invocation.failed")).toBe(
      false,
    );
  });

  it("does not block channel cancellation behind an in-flight DO method call", async () => {
    let resolveMethod!: (value: unknown) => void;
    let resolveMethodStarted!: () => void;
    const methodStarted = new Promise<void>((resolve) => {
      resolveMethodStarted = resolve;
    });
    const methodResult = new Promise<unknown>((resolve) => {
      resolveMethod = resolve;
    });
    let methodStartedRecorded = false;
    let cancellationDelivered = false;
    const targetPid = "do:workers/agent-worker:AiChatWorker:agent-1";
    const { instance, gad } = await createGadBackedChannel({
      rpcCall: (target, method, args) => {
        if (
          target === "main" &&
          method === "workspace-state.entity.resolveActive"
        ) {
          return { id: args[0], kind: "do" };
        }
        if (target === targetPid && method === "onChannelEnvelope") return null;
        if (target === targetPid && method === "onMethodCall") {
          if (!methodStartedRecorded) {
            methodStartedRecorded = true;
            resolveMethodStarted();
          }
          return methodResult;
        }
        if (target === targetPid && method === "cancelDirectMethodCall") {
          cancellationDelivered = true;
          return null;
        }
        return undefined;
      },
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    await joinEntity(instance, targetPid, {
      name: "Agent",
      type: "agent",
      handle: "agent",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await expect(
      Promise.race([
        instance
          .callMethod(
            "panel:caller",
            targetPid,
            "transport-do",
            "eval",
            { code: "while (true) {}" },
            {
              invocationId: "invocation-do",
              transportCallId: "transport-do",
              turnId: "turn-do",
            },
          )
          .then(() => "returned"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 25)),
      ]),
    ).resolves.toBe("returned");
    await methodStarted;

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.cancelMethodCall("panel:caller", "transport-do");
    expect(cancellationDelivered).toBe(true);
    resolveMethod({ result: { ok: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const events = gad.sql
      .exec(
        `SELECT payload_ref_json FROM log_events WHERE payload_kind = ? ORDER BY seq ASC`,
        AGENTIC_EVENT_PAYLOAD_KIND,
      )
      .toArray()
      .map((row: Record<string, unknown>) =>
        JSON.parse(row["payload_ref_json"] as string),
      );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "invocation.started",
          causality: {
            invocationId: "invocation-do",
            transportCallId: "transport-do",
          },
        }),
        expect.objectContaining({
          kind: "invocation.cancelled",
          causality: {
            invocationId: "invocation-do",
            transportCallId: "transport-do",
          },
          payload: expect.objectContaining({
            terminalOutcome: "cancelled",
            terminalReasonCode: "cancelled",
          }),
        }),
      ]),
    );
    expect(
      events.some(
        (event: { kind?: string }) => event.kind === "invocation.completed",
      ),
    ).toBe(false);
  });

  it("persists method terminal events even when the caller participant has left", async () => {
    const { instance, gad } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-left",
      "eval",
      { code: "1 + 1" },
      {
        invocationId: "invocation-left",
        transportCallId: "transport-left",
        turnId: "turn-left",
      },
    );
    await closeTestSubscription(instance, "panel:caller", "panel:caller");

    const resultId = await instance.handleMethodResult(
      "transport-left",
      { ok: true },
      false,
    );

    expect(resultId).toBeTypeOf("number");
    const rows = gad.sql
      .exec(
        `SELECT payload_ref_json FROM log_events WHERE payload_kind = ? ORDER BY seq ASC`,
        AGENTIC_EVENT_PAYLOAD_KIND,
      )
      .toArray();
    const events = rows.map((row: Record<string, unknown>) =>
      JSON.parse(row["payload_ref_json"] as string),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "invocation.started",
          turnId: "turn-left",
          causality: {
            invocationId: "invocation-left",
            transportCallId: "transport-left",
          },
        }),
        expect.objectContaining({
          kind: "invocation.completed",
          turnId: "turn-left",
          causality: {
            invocationId: "invocation-left",
            transportCallId: "transport-left",
          },
          payload: expect.objectContaining({
            protocol: AGENTIC_PROTOCOL_VERSION,
            terminalOutcome: "success",
          }),
        }),
      ]),
    );
  });

  it("spills oversized method results to a blob ref on the durable terminal", async () => {
    const { instance, gad, blobs } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-large",
      "eval",
      { code: "huge()" },
      {
        invocationId: "invocation-large",
        transportCallId: "transport-large",
        turnId: "turn-large",
      },
    );

    await instance.handleMethodResult(
      "transport-large",
      { text: "x".repeat(80 * 1024) },
      false,
    );

    const rows = gad.sql
      .exec(
        `SELECT payload_ref_json FROM log_events WHERE payload_kind = ? ORDER BY seq ASC`,
        AGENTIC_EVENT_PAYLOAD_KIND,
      )
      .toArray();
    const events = rows.map((row: Record<string, unknown>) =>
      JSON.parse(row["payload_ref_json"] as string),
    );
    const completed = events.find(
      (event: { kind?: string; causality?: { invocationId?: string } }) =>
        event.kind === "invocation.completed" &&
        event.causality?.invocationId === "invocation-large",
    );
    // The channel-log store's generic encoder spills the oversized result to a
    // blob ref on the durable event; the blob holds the real content (no
    // method-specific "capped/omitted" wrapper).
    const resultRef = completed?.payload?.result as
      | { digest?: string }
      | undefined;
    expect(resultRef).toMatchObject({
      protocol: "vibestudio.blob-ref.v1",
      digest: expect.any(String),
      encoding: "json",
    });
    const storedResult = JSON.parse(blobs.get(resultRef!.digest!)!);
    expect(storedResult).toMatchObject({ text: "x".repeat(80 * 1024) });
    expect(JSON.stringify(completed).length).toBeLessThan(1_000);
  });

  it("reads message types directly from GAD", async () => {
    const { instance, gad } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });

    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      messageTypeRegisteredEvent(
        "weather",
        "export default function Weather() { return null; }",
        {
          react: "latest",
          "react/jsx-runtime": "latest",
        },
      ),
    );
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      messageTypeRegisteredEvent(
        "calendar",
        "export default function Calendar() { return null; }",
      ),
    );

    const storedWeather = await gad.call("getMessageType", {
      channelId: "channel-1",
      typeId: "weather",
    });
    expect(storedWeather).toMatchObject({
      source: { protocol: "vibestudio.blob-ref.v1", encoding: "json" },
      imports: { protocol: "vibestudio.blob-ref.v1", encoding: "json" },
    });

    await expect(instance.getMessageTypes()).resolves.toEqual([
      expect.objectContaining({ typeId: "calendar" }),
      expect.objectContaining({
        typeId: "weather",
        source: {
          type: "code",
          code: "export default function Weather() { return null; }",
        },
        imports: { react: "latest", "react/jsx-runtime": "latest" },
      }),
    ]);
  });

  it("rejects malformed message type registry events instead of persisting plain log rows", async () => {
    const { instance, gad } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });

    await expect(
      instance.publish("panel:user", AGENTIC_EVENT_PAYLOAD_KIND, {
        kind: "messageType.registered",
        actor: { kind: "panel", id: "panel:user" },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          typeId: "broken",
          displayMode: "bad",
          source: {
            type: "code",
            code: "export default function Broken() { return null; }",
          },
        },
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/payload invalid/u);

    const rows = gad.sql
      .exec(
        `SELECT payload_ref_json FROM log_events WHERE payload_kind = ? ORDER BY seq ASC`,
        AGENTIC_EVENT_PAYLOAD_KIND,
      )
      .toArray();
    expect(
      rows.map((row) => JSON.parse(row["payload_ref_json"] as string).kind),
    ).not.toContain("messageType.registered");
  });
});

describe("PubSubChannel policy folds and cache amnesia (WS2)", () => {
  function agentCompleted(
    messageId: string,
    extraCausality: Record<string, unknown> = {},
  ) {
    return {
      kind: "message.completed",
      actor: { kind: "agent", id: "agent:one" },
      causality: { messageId, ...extraCausality },
      payload: {
        protocol: "agentic.trajectory.v1",
        role: "assistant",
        blocks: [
          { blockId: `${messageId}:block:0`, type: "text", content: "reply" },
        ],
        outcome: "completed",
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
  }

  it("stamps agentHops into annotations without mutating the payload", async () => {
    const { instance, gad } = await createGadBackedChannel();
    setRpcCaller(instance, "agent:one", "server");
    await instance.subscribe("agent:one", {
      contextId: "ctx-1",
      name: "Agent",
      type: "agent",
    });

    await instance.publish(
      "agent:one",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agentCompleted("msg-a1"),
    );
    await instance.publish(
      "agent:one",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agentCompleted("msg-a2"),
    );

    const rows = gad.sql
      .exec(
        `SELECT payload_ref_json, annotations_json FROM log_events
         WHERE payload_kind = ? ORDER BY seq ASC`,
        AGENTIC_EVENT_PAYLOAD_KIND,
      )
      .toArray();
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!["annotations_json"] as string)).toMatchObject({
      agentHops: 1,
    });
    // agent:one's 2nd consecutive message (same author, one turn) is NOT a new hop → still 1.
    expect(JSON.parse(rows[1]!["annotations_json"] as string)).toMatchObject({
      agentHops: 1,
    });
    // the payload itself is never mutated by the transport
    for (const row of rows) {
      const payload = JSON.parse(row["payload_ref_json"] as string) as {
        causality?: { agentHops?: number };
      };
      expect(payload.causality?.agentHops).toBeUndefined();
    }

    // explicit caller-computed hops win
    await instance.publish(
      "agent:one",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agentCompleted("msg-a3", { agentHops: 9 }),
    );
    const explicit = gad.sql
      .exec(
        `SELECT annotations_json FROM log_events WHERE payload_kind = ? ORDER BY seq DESC LIMIT 1`,
        AGENTIC_EVENT_PAYLOAD_KIND,
      )
      .toArray();
    expect(
      JSON.parse(explicit[0]!["annotations_json"] as string),
    ).toMatchObject({ agentHops: 9 });
  });

  it("rebuilds conversation policy state across a fork (the fork-wipe bug fix)", async () => {
    const parent = await createGadBackedChannel({
      channelKey: "channel-policy-parent",
    });
    setRpcCaller(parent.instance, "agent:one", "server");
    await parent.instance.subscribe("agent:one", {
      contextId: "ctx-1",
      name: "Agent",
      type: "agent",
    });
    await parent.instance.publish(
      "agent:one",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agentCompleted("msg-p1"),
    );
    await parent.instance.publish(
      "agent:one",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agentCompleted("msg-p2"),
    );
    const parentState = await parent.instance.getPolicyState();
    expect(parentState.state).toMatchObject({
      agentStreak: 1,
      lastCompletedSender: "agent:one",
    });

    const fork = await createGadBackedChannel({
      channelKey: "channel-policy-fork",
      gad: parent.gad,
    });
    await fork.instance.postClone(
      "channel-policy-parent",
      3,
      "ctx-policy-fork",
    );

    // conversation state SURVIVES the fork — rebuilt by replaying the lineage
    const forkState = await fork.instance.getPolicyState();
    expect(forkState.state).toMatchObject({
      agentStreak: 1,
      lastCompletedSender: "agent:one",
    });

    setRpcCaller(fork.instance, "agent:one", "server");
    await fork.instance.subscribe("agent:one", {
      contextId: "ctx-policy-fork",
      name: "Agent",
      type: "agent",
    });
    await fork.instance.publish(
      "agent:one",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agentCompleted("msg-f1"),
    );
    const stamped = parent.gad.sql
      .exec(
        `SELECT annotations_json FROM log_events
         WHERE log_id = 'channel-policy-fork' AND payload_kind = ? ORDER BY seq DESC LIMIT 1`,
        AGENTIC_EVENT_PAYLOAD_KIND,
      )
      .toArray();
    // msg-f1 is agent:one again (same author across the fork) → still 1 hop, not 3.
    expect(JSON.parse(stamped[0]!["annotations_json"] as string)).toMatchObject(
      { agentHops: 1 },
    );
  });

  it("dedupes idempotent publishes durably across a dedup_keys wipe", async () => {
    const { instance, gad, sql } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });

    const payload = agenticEvent();
    const first = await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      payload,
      {
        idempotencyKey: "durable-key-1",
      },
    );

    // wipe the latency cache — the durable dedupe is the ik:{key} envelope id
    sql.exec(`DELETE FROM dedup_keys`);

    const second = await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      payload,
      {
        idempotencyKey: "durable-key-1",
      },
    );
    expect(second.id).toBe(first.id);
    const rows = gad.sql
      .exec(
        `SELECT envelope_id FROM log_events WHERE envelope_id = ?`,
        "ik:durable-key-1",
      )
      .toArray();
    expect(rows).toHaveLength(1);
  });

  it("treats duplicate pending callMethod as a durable redrive", async () => {
    const { instance, gad, sql } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "call-redrive",
      "eval",
      { code: "first" },
      {
        invocationId: "inv-redrive",
        transportCallId: "call-redrive",
        turnId: "turn-redrive",
      },
    );
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "call-redrive",
      "mutated_eval",
      { code: "second" },
      {
        invocationId: "inv-redrive",
        transportCallId: "call-redrive",
        turnId: "turn-redrive",
      },
    );

    const starts = gad.sql
      .exec(
        `SELECT envelope_id FROM log_events WHERE envelope_id = ?`,
        "inv-redrive",
      )
      .toArray();
    expect(starts).toHaveLength(1);

    const pending = sql
      .exec(
        `SELECT method FROM pending_calls WHERE transport_call_id = ?`,
        "call-redrive",
      )
      .toArray();
    expect(pending).toEqual([expect.objectContaining({ method: "eval" })]);
  });

  it("reconstructs pending_calls from the log after cache amnesia", async () => {
    const { instance, sql, gad } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", {
      contextId: "ctx-1",
      name: "Caller",
      type: "panel",
    });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "call-keep",
      "slow_method",
      { input: 1 },
      {
        invocationId: "inv-keep",
        transportCallId: "call-keep",
        turnId: "turn-1",
        timeoutMs: 60000,
      },
    );
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "call-settle",
      "fast_method",
      { input: 2 },
      { invocationId: "inv-settle", transportCallId: "call-settle" },
    );

    setRpcCaller(instance, "panel:provider", "panel");
    await instance.submitMethodResult(
      "panel:provider",
      "call-settle",
      { ok: true },
      false,
    );

    // P3: derived state is deletable at any time
    sql.exec(`DELETE FROM pending_calls`);
    const { inserted } = await instance.reconcilePendingCalls(true);
    expect(inserted).toBe(1);

    const rows = sql.exec(`SELECT * FROM pending_calls`).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      transport_call_id: "call-keep",
      invocation_id: "inv-keep",
      caller_id: "panel:caller",
      target_id: "panel:provider",
      method: "slow_method",
      turn_id: "turn-1",
    });
    // args come back in journal form — $.payload.request is blob-spilled by
    // the storage boundary, so the rebuilt row carries the blob ref
    expect(JSON.parse(rows[0]!["args"] as string)).toMatchObject({
      protocol: "vibestudio.blob-ref.v1",
    });
    expect(Number(rows[0]!["deadline_at"])).toBeGreaterThan(0);

    // the rebuilt row settles normally, with the deterministic terminal id
    await instance.submitMethodResult(
      "panel:provider",
      "call-keep",
      { ok: 1 },
      false,
    );
    const terminals = gad.sql
      .exec(
        `SELECT envelope_id FROM log_events WHERE envelope_id LIKE 'terminal:%'`,
      )
      .toArray();
    expect(terminals.map((row) => row["envelope_id"])).toEqual(
      expect.arrayContaining(["terminal:call-settle", "terminal:call-keep"]),
    );
    expect(
      sql.exec(`SELECT COUNT(*) AS cnt FROM pending_calls`).toArray()[0]?.[
        "cnt"
      ],
    ).toBe(0);
  });

  it("does not turn subscription recovery into a pending-call redelivery lifecycle", async () => {
    const emitted: unknown[] = [];
    let countRedeliveryTerminalProbes = false;
    let redeliveryTerminalProbeCount = 0;
    let redeliveryFullLogReadCount = 0;
    let redeliveryBatchProbeCount = 0;
    let sawRedeliveryBatchProbe = false;
    const { instance, sql } = await createGadBackedChannel({
      emitted,
      rpcCall: (_target, method, args) => {
        const firstArg = args[0] as { envelopeId?: unknown } | undefined;
        if (
          countRedeliveryTerminalProbes &&
          method === "getLogEvent" &&
          firstArg?.envelopeId === "terminal:call-feedback"
        ) {
          redeliveryTerminalProbeCount += 1;
        }
        if (
          countRedeliveryTerminalProbes &&
          sawRedeliveryBatchProbe &&
          method === "readLog"
        ) {
          redeliveryFullLogReadCount += 1;
        }
        if (countRedeliveryTerminalProbes && method === "hasLogEvents") {
          redeliveryBatchProbeCount += 1;
          sawRedeliveryBatchProbe = true;
        }
        return undefined;
      },
    });

    setRpcCaller(instance, "agent:caller", "worker");
    await instance.subscribe("agent:caller", {
      contextId: "ctx-1",
      name: "Agent",
      type: "agent",
    });
    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });

    setRpcCaller(instance, "agent:caller", "worker");
    await instance.callMethod(
      "agent:caller",
      "panel:user",
      "call-feedback",
      "feedback_form",
      { title: "Continue?" },
      {
        invocationId: "inv-feedback",
        transportCallId: "call-feedback",
        turnId: "turn-feedback",
      },
    );

    setRpcCaller(instance, "panel:user", "panel");
    await instance.submitMethodResult(
      "panel:user",
      "call-feedback",
      { type: "submit", value: { ok: true } },
      false,
      { invocationId: "inv-feedback", turnId: "turn-feedback" },
    );

    // Simulate a crash/old-cache state: the durable terminal exists, but the
    // declared pending_calls cache still contains the answered feedback call.
    sql.exec(
      `INSERT INTO pending_calls (transport_call_id, invocation_id, turn_id, caller_id,
        target_id, method, args, created_at, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "call-feedback",
      "inv-feedback",
      "turn-feedback",
      "agent:caller",
      "panel:user",
      "feedback_form",
      JSON.stringify({ title: "Continue?" }),
      Date.now() - 60_000,
      null,
    );
    emitted.length = 0;
    countRedeliveryTerminalProbes = true;

    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    countRedeliveryTerminalProbes = false;
    await Promise.resolve();

    const redeliveredFeedback = emitted.filter((payload) => {
      const signal = payload as {
        message?: {
          kind?: string;
          payload?: {
            kind?: string;
            causality?: { transportCallId?: string };
            payload?: { name?: string };
          };
        };
      };
      return (
        signal.message?.kind === "signal" &&
        signal.message.payload?.kind === "invocation.started" &&
        signal.message.payload.causality?.transportCallId === "call-feedback" &&
        signal.message.payload.payload?.name === "feedback_form"
      );
    });

    expect(redeliveredFeedback).toHaveLength(0);
    expect(redeliveryTerminalProbeCount).toBe(0);
    expect(redeliveryFullLogReadCount).toBe(0);
    expect(redeliveryBatchProbeCount).toBe(0);
    // Cache repair remains an explicit fold of the durable log; subscribing has
    // no hidden cleanup or synthetic invocation delivery side effect.
    await instance.reconcilePendingCalls(true);
    expect(
      sql
        .exec(
          `SELECT transport_call_id FROM pending_calls WHERE transport_call_id = ?`,
          "call-feedback",
        )
        .toArray(),
    ).toHaveLength(0);
  });
});

describe("PubSubChannel fork lineage delivery", () => {
  it("owns live lineage subscriptions through their response stream", async () => {
    const { instance } = await createGadBackedChannel({
      channelKey: "lineage-root",
    });
    setRpcCaller(instance, "panel:viewer", "panel");
    const response = await instance.subscribeLineage("panel:viewer");
    const reader = response.body!.getReader();
    const ack = await reader.read();
    expect(
      JSON.parse(new TextDecoder().decode(ack.value).trim()),
    ).toMatchObject({
      kind: "subscribed",
      result: { ok: true, rootChannelId: "lineage-root" },
    });

    const internal = instance as unknown as {
      recordLineageHead(channelId: string, headSeq: number): void;
      lineageSubscriptionStreams: Map<string, unknown>;
    };
    internal.recordLineageHead("lineage-child", 14);
    const message = await reader.read();
    expect(
      JSON.parse(new TextDecoder().decode(message.value).trim()),
    ).toMatchObject({
      kind: "message",
      payload: {
        kind: "signal",
        payload: {
          contentType: "fork.head_changed",
          content: JSON.stringify({ channelId: "lineage-child", headSeq: 14 }),
        },
      },
    });
    await reader.cancel();
    expect(internal.lineageSubscriptionStreams.size).toBe(0);
  });

  it("coalesces descendant heads and reports directly to the lineage root", async () => {
    const reports: Array<{ target: string; report: unknown }> = [];
    const parent = await createGadBackedChannel({ channelKey: "lineage-mid" });
    setRpcCaller(parent.instance, "panel:owner", "panel");
    await parent.instance.subscribe("panel:owner", {
      contextId: "lineage-parent-context",
      name: "Owner",
      type: "panel",
    });
    const child = await createGadBackedChannel({
      channelKey: "lineage-leaf",
      gad: parent.gad,
      rpcCall: (target, method, args) => {
        if (
          target === "main" &&
          method === "workers.resolveService" &&
          args[0] === "vibestudio.channel.v1"
        ) {
          return {
            source: "workers/pubsub-channel",
            className: "PubSubChannel",
            objectKey: args[1] as string,
          };
        }
        if (method === "reportLineageHead") {
          reports.push({ target, report: args[0] });
          return null;
        }
        return undefined;
      },
    });
    await child.instance.postClone("lineage-mid", 1, "lineage-context", {
      forkId: "lineage-fork-1",
      rootChannelId: "lineage-root",
    });
    const internal = child.instance as unknown as {
      noteLineageHeadAdvance(headSeq: number, rosterChanged?: boolean): void;
      flushLineageHeadOutbox(): Promise<void>;
    };
    internal.noteLineageHeadAdvance(11);
    internal.noteLineageHeadAdvance(15, true);
    await internal.flushLineageHeadOutbox();

    expect(reports).toEqual([
      {
        target: "do:workers/pubsub-channel:PubSubChannel:lineage-root",
        report: { channelId: "lineage-leaf", headSeq: 15, rosterChanged: true },
      },
    ]);
  });
});

// appendSeed is fork plumbing: it consumes the child channel's pending fork seed
// marker, appends the opening message once, and is idempotent on crash re-drive.
describe("PubSubChannel appendSeed fork plumbing", () => {
  const SEED_AUTHOR = {
    kind: "user" as const,
    id: "panel:user",
    participantId: "panel:user",
  };
  function forkSeed(author = SEED_AUTHOR) {
    return {
      author,
      blocks: [
        {
          blockId: "fork-seed:fork-1:block:0" as BlockId,
          type: "text" as const,
          content: "explore this branch",
        },
      ],
    };
  }

  // A cloned CHILD channel whose parent fork op (channel-parent) planted a
  // pending seed marker at postClone. `withSeed:false` clones WITHOUT planting
  // the marker (mirrors a fork with no seed).
  async function forkedChild(opts: { withSeed?: boolean } = {}): Promise<{
    parent: Awaited<ReturnType<typeof createGadBackedChannel>>;
    child: Awaited<ReturnType<typeof createGadBackedChannel>>;
  }> {
    const withSeed = opts.withSeed ?? true;
    const parent = await createGadBackedChannel({
      channelKey: "channel-parent",
    });
    setRpcCaller(parent.instance, "panel:user", "panel");
    // seq 1 = presence, seq 2 = message → fork point is 2.
    await parent.instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    await parent.instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
    );
    const child = await createGadBackedChannel({
      channelKey: "channel-child",
      gad: parent.gad,
      rpcCall: (target, method, args) => {
        if (
          target === "main" &&
          method === "workers.resolveService" &&
          args[0] === "vibestudio.channel.v1"
        ) {
          return {
            source: "workers/pubsub-channel",
            className: "PubSubChannel",
            objectKey: args[1] as string,
          };
        }
        return undefined;
      },
    });
    await child.instance.postClone("channel-parent", 2, "ctx-forked", {
      forkId: "fork-1",
      rootChannelId: "channel-parent",
      ...(withSeed ? { seed: forkSeed() } : {}),
    });
    return { parent, child };
  }

  // Envelopes appended past the fork point (2). The seed is the only event
  // appendSeed writes.
  async function tailAfterFork(
    child: Awaited<ReturnType<typeof createGadBackedChannel>>,
  ) {
    const replay = await child.instance.getReplayAfter({ after: 2 });
    return replay.logEvents;
  }

  it("appends the fork seed once and is idempotent on re-drive", async () => {
    const { child } = await forkedChild();
    setRpcCaller(
      child.instance,
      "do:workers/pubsub-channel:PubSubChannel:channel-parent",
      "do",
    );

    const res = await child.instance.appendSeed({ forkId: "fork-1" });
    expect(res.messageId).toBe("fork-seed:fork-1");

    const tail = await tailAfterFork(child);
    const seeds = tail.filter((e) => e.type === AGENTIC_EVENT_PAYLOAD_KIND);
    expect(seeds).toHaveLength(1);
    const seed = seeds[0]!.payload as {
      kind: string;
      actor: { participantId?: string; id: string };
      payload: { role: string; tier: string };
    };
    // A primary user message, authored from the supplied seed envelope.
    expect(seed.kind).toBe("message.completed");
    expect(seed.payload.role).toBe("user");
    expect(seed.payload.tier).toBe("primary");
    expect(seed.actor.participantId ?? seed.actor.id).toBe("panel:user");

    // Re-drive (crash-resume) returns the SAME durable message; no duplicate.
    const again = await child.instance.appendSeed({ forkId: "fork-1" });
    expect(again).toEqual(res);
    expect(
      (await tailAfterFork(child)).filter(
        (e) => e.type === AGENTIC_EVENT_PAYLOAD_KIND,
      ),
    ).toHaveLength(1);
  });

  it("rejects a call with no pending fork seed marker", async () => {
    const { child } = await forkedChild({ withSeed: false });
    setRpcCaller(
      child.instance,
      "do:workers/pubsub-channel:PubSubChannel:channel-parent",
      "do",
    );

    await expect(
      child.instance.appendSeed({ forkId: "fork-1" }),
    ).rejects.toThrow(/no pending fork seed for fork fork-1/);
    expect(await tailAfterFork(child)).toHaveLength(0);
  });

  it("rejects a forkId that does not match the pending seed marker", async () => {
    const { child } = await forkedChild();
    setRpcCaller(
      child.instance,
      "do:workers/pubsub-channel:PubSubChannel:channel-parent",
      "do",
    );

    await expect(
      child.instance.appendSeed({ forkId: "fork-EVIL" }),
    ).rejects.toThrow(/no pending fork seed for fork fork-EVIL/);
    expect(await tailAfterFork(child)).toHaveLength(0);
  });

  it("rejects a different channel even when it knows the pending fork id", async () => {
    const { child } = await forkedChild();
    setRpcCaller(
      child.instance,
      "do:workers/pubsub-channel:PubSubChannel:channel-attacker",
      "do",
    );
    await expect(
      child.instance.appendSeed({ forkId: "fork-1" }),
    ).rejects.toThrow(/recorded parent channel/);
    expect(await tailAfterFork(child)).toHaveLength(0);
  });

  it("keeps relay attestation separate from appendSeed's exact-parent check", async () => {
    const { instance } = await createGadBackedChannel();
    const gate = instance as unknown as {
      inboundCallerDenial(
        method: string,
        args: readonly unknown[],
        caller: {
          callerId: string;
          callerKind: string;
          authorization?: ReturnType<typeof createTestDirectAuthority>;
        } | null,
        authorityAcceptedAt: number,
      ): string | null;
    };
    const denialFor = (kind: "panel" | "worker" | "server" | "do" | "shell") =>
      gate.inboundCallerDenial(
        "appendSeed",
        [],
        {
          callerId: `${kind}:x`,
          callerKind: kind,
          authorization: createTestDirectAuthority({
            callerKind: kind,
            method: "appendSeed",
            effect: { kind: "open" },
            capability: "workspace-service:channel",
            targetCapability: "workspace-service:channel",
            targetPrincipals: ["host", "user", "code"],
            objectKey: "channel-1",
          }),
        },
        Date.now(),
      );
    for (const kind of ["do", "worker", "panel", "shell", "server"] as const) {
      expect(denialFor(kind)).toBeNull();
    }
  });
});
