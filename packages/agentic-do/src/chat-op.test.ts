/**
 * chatOp — the agent-side proxy for an EvalDO sandbox `chat` binding.
 *
 * Server-side `eval` runs in a per-channel EvalDO that has no channel identity,
 * so its `chat` binding forwards every op here via
 * `rpc.callTarget(agentId, "chatOp", [channelId, op, args])`. The agent performs
 * the op AS itself (correct @agent attribution) using its own channel
 * machinery, and relays the result. These tests cover the auth gate, the card
 * dispatch, message-type publishing, and the result-awaiting callMethod relay.
 */
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { ledgerTest } from "../../../tests/helpers/ledgerTest.js";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { ids, type AgentTurnMetadata } from "@workspace/agent-loop";
import { logIdForChannel } from "@vibestudio/trajectory-identity";
import {
  RemoteRpcError,
  rpc,
  rpcMethodAuthority,
  type RpcClient,
} from "@vibestudio/rpc";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  type AgenticEvent,
  type ParticipantRef,
} from "@workspace/agentic-protocol";
import { sha256HexSyncText } from "@vibestudio/content-addressing";
import type { ChannelEvent, ParticipantDescriptor } from "@workspace/harness";
import type { RpcChannelMessage } from "@workspace/pubsub";
import type {
  VcsCompareResult,
  VcsStatusResult,
} from "@vibestudio/service-schemas/vcs";
import type { MissionRecord } from "@vibestudio/automation/mission";
import { AgentVesselBase } from "./agent-vessel.js";
import type { ChannelClient } from "./channel-client.js";
import type { AgentLoopDriver } from "./agent-loop-driver.js";

/** Wait until the relay has issued its channel call. */
async function waitForCall(
  vessel: TestVessel,
): Promise<{ callId: string; method: string }> {
  for (let i = 0; i < 100; i++) {
    const call = vessel.channelStub.calls[0];
    if (call) return call;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("relay never issued a channel call");
}

const AGENT_ID = "do:workers/test:TestAgent:agent-key";
const CHANNEL = "chan-1";
const TEST_AGENT_ENV = {
  __objectKey: "agent-key",
  WORKER_SOURCE: "workers/test",
  WORKER_CLASS_NAME: "TestAgent",
  WORKER_EFFECTIVE_VERSION: "a".repeat(64),
  WORKER_SOURCE_REF: `state:${"b".repeat(64)}`,
} as const;

function automationRecord(
  overrides: Partial<MissionRecord> = {},
): MissionRecord {
  return {
    schemaVersion: 3,
    missionId: "mission-daily",
    name: "Daily check",
    revision: 1,
    charter: {
      summary: "Check the project every morning.",
      execution: {
        kind: "agent",
        image: {
          source: "workers/agent",
          effectiveVersion: "a".repeat(64),
          ref: `state:${"b".repeat(64)}`,
          className: "Agent",
          objectKey: "daily",
        },
        action: { kind: "prompt", text: "Check the project." },
        conversation: {
          mode: "continue",
          channelId: CHANNEL,
          contextId: "ctx-1",
          executorId: AGENT_ID,
        },
        operations: [],
      },
      trigger: {
        kind: "cron",
        expression: "5 5 * * THU",
        timezone: "America/New_York",
      },
    },
    owner: { userId: "alice" },
    state: "active",
    revisionDigest: "b".repeat(64),
    authorityPlan: {
      schemaVersion: 1,
      digest: "c".repeat(64),
      artifactRef: `authority-plan:${"c".repeat(64)}`,
      compilerVersion: "test",
      catalogDigest: "d".repeat(64),
    },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    activatedAt: 1_700_000_000_000,
    runCount: 0,
    authority: { requestIds: [], grantIds: [], denialIds: [] },
    ...overrides,
  };
}

async function withAlarmGateway<T>(
  run: (gatewayUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      from: string;
      target: string;
      message: { requestId: string };
    };
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        from: envelope.target,
        target: envelope.from,
        delivery: { caller: { callerId: "main", callerKind: "server" } },
        provenance: [],
        message: {
          type: "response",
          requestId: envelope.message.requestId,
          result: undefined,
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test server did not bind TCP");

  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const WEATHER_TYPE = {
  typeId: "weather",
  displayMode: "row" as const,
  stateSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
};

/** A test vessel that lets us drive chatOp directly: it pins the agent's
 *  participant id, lets the test set the verified caller id, and swaps the
 *  ChannelClient for an in-memory stub whose callMethod we settle by feeding a
 *  terminal back through processChannelEvent (mirroring the live broadcast). */
class TestVessel extends AgentVesselBase {
  callerIdForTest: string | null = null;
  callerKindForTest: string | null = null;
  blobTextReaderForTest: ((digest: string) => Promise<string | null>) | null =
    null;
  automationLaunchForTest: MissionRecord | null = null;
  automationVisibleForTest: MissionRecord[] | null = null;
  credentialConnectForTest: (() => Promise<Record<string, unknown>>) | null = null;
  readonly automationLaunchCalls: Array<{
    args: unknown[];
    options?: unknown;
  }> = [];
  readonly automationAuthorityCalls: Array<{
    method: string;
    args: unknown[];
  }> = [];
  readonly automationControlCalls: Array<{
    method: string;
    args: unknown[];
    options?: unknown;
  }> = [];
  readonly channelPublishFailures = new Set<string>();
  readonly channelStub = {
    published: [] as Array<{
      channelId: string;
      event: AgenticEvent;
      idempotencyKey?: string;
    }>,
    messageTypes: new Map<string, Record<string, unknown>>(),
    calls: [] as Array<{
      callId: string;
      targetPid: string;
      method: string;
      args: unknown;
    }>,
    participants: [] as Array<{
      participantId: string;
      ref: ParticipantRef;
      metadata: Record<string, unknown>;
    }>,
    subscriptions: [] as Array<{ channelId: string; participantId: string }>,
    sent: [] as Array<{
      channelId: string;
      participantId: string;
      messageId: string;
      content: string;
      options?: Record<string, unknown>;
    }>,
    replay: new Map<string, ChannelEvent[]>(),
    envelopes: new Map<string, ChannelEvent>(),
    channelEnvelopes: new Map<string, ChannelEvent>(),
  };
  readonly operationLog: string[] = [];
  channelClientCreations = 0;
  lifecycleRegistrations = 0;
  lifecycleClears = 0;

  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  markWorkReadyForTest(...queues: Array<"agent-wake" | "agent-effect">): void {
    this.markWorkReady(...queues);
  }

  durableWorkReadyGenerationsForTest(): Array<{
    queue: string;
    generation: number;
  }> {
    const prefix = "durable-work-ready-generation:";
    return (
      this.sql
        .exec(
          `SELECT key, value
             FROM state
            WHERE key LIKE ?
            ORDER BY key`,
          `${prefix}%`,
        )
        .toArray() as Record<string, unknown>[]
    ).map((row) => ({
      queue: String(row["key"]).slice(prefix.length),
      generation: Number(row["value"]),
    }));
  }

  writeHotPathTracesForTest(count: number, channelId = CHANNEL): void {
    for (let index = 0; index < count; index += 1) {
      this.traceHotPath(channelId, "test.trace", { details: { index } });
    }
  }

  hotPathTraceCountForTest(channelId = CHANNEL): number {
    return Number(
      this.sql
        .exec(
          `SELECT COUNT(*) AS count
             FROM agent_hot_path_trace
            WHERE channel_id = ?`,
          channelId,
        )
        .toArray()[0]?.["count"] ?? 0,
    );
  }

  hotPathTraceSourcesForTest(phase: string, channelId = CHANNEL): string[] {
    return (
      this.sql
        .exec(
          `SELECT source FROM agent_hot_path_trace
            WHERE channel_id = ? AND phase = ?
            ORDER BY sequence`,
          channelId,
          phase,
        )
        .toArray() as Array<Record<string, unknown>>
    ).map((row) => String(row["source"]));
  }

  seedDeferredEvalForTest(runId: string, started: boolean): void {
    this.driver.outbox.insert(
      logIdForChannel(CHANNEL),
      {
        kind: "local_tool",
        effectId: runId,
        channelId: CHANNEL,
        idempotencyKey: runId,
        invocationId: runId,
        turnId: `turn:${runId}`,
        invocationSeq: 1,
        executionMode: "parallel",
        tool: "eval",
        args: {},
      } as never,
      null,
    );
    if (started) this.driver.markDeferredEvalStartAttempted(CHANNEL, runId);
  }

  nextAlarmScheduleForTest(): { wakeAt: number } | null {
    return this.nextAgentAlarmSchedule();
  }

  protected override async registerLifecycleRelease(): Promise<void> {
    this.lifecycleRegistrations += 1;
  }

  protected override async clearLifecycleRelease(): Promise<void> {
    this.lifecycleClears += 1;
  }

  protected override get rpcCallerId(): string | null {
    return this.callerIdForTest;
  }

  protected override get rpcCallerKind(): string | null {
    return this.callerKindForTest;
  }

  protected override get rpcRequestId(): string | null {
    return "request-for-test";
  }

  protected override participantId(): string {
    return AGENT_ID;
  }

  protected override getParticipantInfo(): ParticipantDescriptor {
    return {
      type: "agent",
      name: "TestAgent",
      handle: "testagent",
    } as ParticipantDescriptor;
  }

  /** Context-integrity ingestion is a mandatory host boundary, not an HTTP
   * concern of these channel-behavior tests. Keep every other RPC on the real
   * client so tests that exercise transport behavior retain coverage. */
  protected override get rpc(): RpcClient {
    const base = super.rpc;
    const vessel = this;
    return new Proxy(base, {
      get(target, property, receiver) {
        if (property === "call") {
          return async (
            targetId: string,
            method: string,
            args: unknown[],
            options?: unknown,
          ) => {
            if (targetId === "main" && method === "contextIntegrity.ingest") {
              vessel.operationLog.push("rpc:main:contextIntegrity.ingest");
              return { class: "internal", latchEpoch: 0, externalKeys: [] };
            }
            if (
              targetId === "main" &&
              method === "credentials.connect" &&
              vessel.credentialConnectForTest
            ) {
              return vessel.credentialConnectForTest();
            }
            if (
              targetId === "main" &&
              method === "blobstore.getText" &&
              vessel.blobTextReaderForTest
            ) {
              return vessel.blobTextReaderForTest(String(args[0]));
            }
            if (
              (vessel.automationLaunchForTest ||
                vessel.automationVisibleForTest) &&
              targetId === "main" &&
              method === "authority.compileAuthorityPlan"
            ) {
              vessel.automationAuthorityCalls.push({ method, args });
              return {
                schemaVersion: 1,
                digest: "c".repeat(64),
                artifactRef: `authority-plan:${"c".repeat(64)}`,
                compilerVersion: "test",
                catalogDigest: "d".repeat(64),
              };
            }
            if (
              vessel.automationLaunchForTest &&
              targetId === "main" &&
              method === "authority.acquireForCurrentTask"
            ) {
              vessel.automationAuthorityCalls.push({ method, args });
              return {
                requestIds: [],
                grantIds: ["grant:task"],
                denialIds: [],
              };
            }
            if (
              (vessel.automationLaunchForTest ||
                vessel.automationVisibleForTest) &&
              targetId === "main" &&
              method === "workers.resolveService" &&
              args[0] === "vibestudio.missions.v1"
            ) {
              return { kind: "durable-object", targetId: "do:missions" };
            }
            if (
              vessel.automationLaunchForTest &&
              targetId === "do:missions" &&
              method === "launch"
            ) {
              vessel.automationLaunchCalls.push({ args, options });
              return vessel.automationLaunchForTest;
            }
            if (
              vessel.automationVisibleForTest &&
              targetId === "do:missions" &&
              method === "list"
            ) {
              return vessel.automationVisibleForTest;
            }
            if (
              vessel.automationVisibleForTest &&
              targetId === "do:missions" &&
              ["pause", "resume", "runNow", "retire"].includes(method)
            ) {
              vessel.automationControlCalls.push({ method, args, options });
              const mission = vessel.automationVisibleForTest.find(
                (candidate) => candidate.missionId === args[0],
              );
              if (!mission) throw new Error("unknown test automation");
              return {
                ...mission,
                state:
                  method === "pause"
                    ? "paused"
                    : method === "retire"
                      ? "retired"
                      : "active",
              };
            }
            return target.call(targetId, method, args, options as never);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  protected override createChannelClient(channelId: string): ChannelClient {
    this.channelClientCreations += 1;
    return this.makeChannelStub(channelId) as unknown as ChannelClient;
  }

  async executeAutomationLaunchForTest(input: unknown): Promise<unknown> {
    const tool = this.createAutomationLaunchTool(CHANNEL, {
      invocationId: "invocation-daily",
      commandId: "command-daily",
      rpc: this.rpc,
    });
    return tool.execute("tool-call-daily", input);
  }

  async executeAutomationControlForTest(input: unknown): Promise<unknown> {
    const tool = this.createAutomationControlTool(CHANNEL, {
      invocationId: "invocation-control",
      commandId: "command-control",
      rpc: this.rpc,
    });
    return tool.execute("tool-call-control", input);
  }

  /** Register a subscription row (so getParticipantId returns a non-null
   *  participant id for the card publish path) WITHOUT running the heavy
   *  post-subscribe machinery (prompt artifacts, driver wake) that needs a live
   *  gateway/GAD. */
  async registerSubscriptionForTest(
    channelId = CHANNEL,
    config?: unknown,
  ): Promise<void> {
    this.ensureIdentity();
    await this.subscriptions.subscribe({
      channelId,
      contextId: "ctx-1",
      descriptor: this.getParticipantInfo(),
      config,
      replay: false,
    });
  }

  hasEffectOutboxTableForTest(): boolean {
    return (
      this.sql
        .exec(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_outbox'`,
        )
        .toArray().length > 0
    );
  }

  driverForTest(): AgentLoopDriver {
    return this.driver;
  }

  readBlobTextForTest(digest: string): Promise<string | null> {
    return (
      this as unknown as {
        getCachedBlobText(value: string): Promise<string | null>;
      }
    ).getCachedBlobText(digest);
  }

  private makeChannelStub(channelId: string) {
    const stub = this.channelStub;
    const failures = this.channelPublishFailures;
    const operationLog = this.operationLog;
    const getReplayAfter = vi.fn(
      async (request: {
        after: number;
        limit?: number;
        throughSeq?: number;
      }) => {
        const all = (stub.replay.get(channelId) ?? []).filter(
          (event) =>
            (event.id ?? 0) > request.after &&
            (request.throughSeq === undefined ||
              (event.id ?? 0) <= request.throughSeq),
        );
        const snapshotLastSeq =
          request.throughSeq ??
          all.reduce(
            (maximum, event) => Math.max(maximum, event.id ?? 0),
            request.after,
          );
        const logEvents = all.slice(0, request.limit ?? 500);
        return {
          mode: "after" as const,
          logEvents,
          snapshots: [],
          ready: {
            totalCount: all.length,
            envelopeCount: all.length,
            snapshotLastSeq,
            replayToId: logEvents.at(-1)?.id,
            hasMoreAfter: logEvents.length < all.length,
          },
        };
      },
    );
    return {
      publishAgenticEvent: vi.fn(
        async (
          pid: string,
          event: AgenticEvent,
          opts?: { idempotencyKey?: string },
        ) => {
          if (opts?.idempotencyKey && failures.has(opts.idempotencyKey)) {
            throw new Error(`publish failed: ${opts.idempotencyKey}`);
          }
          const envelopeId = opts?.idempotencyKey
            ? `ik:${opts.idempotencyKey}`
            : undefined;
          const channelEnvelopeId = envelopeId
            ? `${channelId}\u0000${envelopeId}`
            : undefined;
          const existing = channelEnvelopeId
            ? stub.channelEnvelopes.get(channelEnvelopeId)
            : undefined;
          stub.published.push({
            channelId,
            event,
            idempotencyKey: opts?.idempotencyKey,
          });
          if (existing) return { id: existing.id };
          const id = stub.published.length;
          if (channelEnvelopeId && envelopeId) {
            stub.channelEnvelopes.set(channelEnvelopeId, {
              id,
              messageId: envelopeId,
              type: AGENTIC_EVENT_PAYLOAD_KIND,
              payload: event,
              senderId: pid,
              ts: Date.now(),
            } as ChannelEvent);
          }
          return { id };
        },
      ),
      getMessageType: vi.fn(
        async (typeId: string) => stub.messageTypes.get(typeId) ?? null,
      ),
      getMessageTypes: vi.fn(async () => [...stub.messageTypes.values()]),
      getParticipants: vi.fn(async () => stub.participants),
      callMethod: vi.fn(
        async (
          _callerPid: string,
          targetPid: string,
          callId: string,
          method: string,
          args: unknown,
        ) => {
          stub.calls.push({ callId, targetPid, method, args });
        },
      ),
      getReplayAfter,
      replayAfterPages: async function* (request: {
        after: number;
        limit?: number;
        throughSeq?: number;
      }) {
        let after = request.after;
        let throughSeq = request.throughSeq;
        for (;;) {
          const page = await getReplayAfter({ ...request, after, throughSeq });
          yield page;
          if (!page.ready.hasMoreAfter) return;
          after = page.ready.replayToId!;
          throughSeq ??= page.ready.snapshotLastSeq;
        }
      },
      getEnvelope: vi.fn(
        async (envelopeId: string) =>
          stub.channelEnvelopes.get(`${channelId}\u0000${envelopeId}`) ??
          stub.envelopes.get(envelopeId) ??
          null,
      ),
      send: vi.fn(
        async (
          participantId: string,
          messageId: string,
          content: string,
          options?: Record<string, unknown>,
        ) => {
          stub.sent.push({
            channelId,
            participantId,
            messageId,
            content,
            options,
          });
        },
      ),
      recordTaskProvenance: vi.fn(async () => undefined),
      relationshipState: vi.fn(async () => ({ revision: 0, active: false })),
      join: vi.fn(
        async (input: { participantId: string; revision: number }) => {
          operationLog.push(`channel:${channelId}:join`);
          stub.subscriptions.push({
            channelId,
            participantId: input.participantId,
          });
          return {
            ok: true,
            channelConfig: {},
            envelope: {
              logEvents: [],
              ready: { totalCount: 0, envelopeCount: 0 },
            },
            participantId: input.participantId,
            revision: input.revision,
          };
        },
      ),
      leave: vi.fn(async () => {
        operationLog.push(`channel:${channelId}:leave`);
      }),
      getConfig: vi.fn(async () => ({})),
    };
  }

  /** Feed a terminal event the way the live channel broadcast would, to settle
   *  a pending relay call. */
  async deliverTerminal(
    transportCallId: string,
    kind:
      | "invocation.completed"
      | "invocation.failed"
      | "invocation.cancelled"
      | "invocation.abandoned",
    payload: Record<string, unknown>,
  ): Promise<void> {
    const event: ChannelEvent = {
      id: 1,
      messageId: transportCallId,
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: {
        kind,
        actor: { kind: "agent", id: AGENT_ID },
        causality: { invocationId: transportCallId, transportCallId },
        payload,
        createdAt: new Date().toISOString(),
      } as unknown as AgenticEvent,
      senderId: AGENT_ID,
      ts: Date.now(),
    };
    await this.processChannelEvent(CHANNEL, event);
  }

  subscriptionIdsForTest(): string[] {
    return this.subscriptions.listChannelIds();
  }

  subscriptionParticipantIdForTest(channelId: string): string {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) throw new Error(`missing subscription ${channelId}`);
    return participantId;
  }

  private envelopeSequence = 0;

  async deliverEnvelopeForTest(envelope: RpcChannelMessage): Promise<void> {
    this.ensureIdentity();
    const eventSequence = ++this.envelopeSequence;
    await this.acceptChannelDelivery({
      deliveryId: `test:${eventSequence}`,
      channelId: CHANNEL,
      channelRef: {
        source: "workers/pubsub-channel",
        className: "PubSubChannel",
        objectKey: CHANNEL,
      },
      participantId: this.subscriptions.getParticipantId(CHANNEL)!,
      subscriptionRevision: 1,
      eventSequence,
      envelope,
      agenticContext: {
        version: 1 as const,
        relationships: [
          {
            participantId: this.subscriptions.getParticipantId(CHANNEL)!,
            metadata: { name: "Test agent", type: "agent" },
            applicationConfig: null,
          },
        ],
        channelConfig: {},
        conversation: {
          lastCompletedSender: null,
          lastCompletedMessageId: null,
          lastCompletedSeq: null,
          previousCompletedSender: null,
          previousCompletedMessageId: null,
          previousCompletedSeq: null,
          agentStreak: 0,
        },
        replyToSenderId: null,
      },
    });
  }

  installLifecycleDriverForTest() {
    const driver = {
      releaseActivation: vi.fn(async () => 1),
      handleIncoming: vi.fn(async () => {}),
      abortChannel: vi.fn(async () => {}),
      dropLoop: vi.fn(),
      activateChannel: vi.fn(),
      wake: vi.fn(async () => {}),
      reconcileDeferredEvalRuns: vi.fn(),
      deferredEvalRows: vi.fn(() => []),
    };
    (this as unknown as { _driver: unknown })._driver = driver;
    return driver;
  }
}

class PromptEventProbe extends TestVessel {
  readonly handleIncomingSpy = vi.fn(
    async (_channelId: string, _incoming: unknown) => {
      this.operationLog.push("driver:handleIncoming");
    },
  );
  useDeliveredDecisionContext = false;
  consumePayloadKind: string | null = null;

  protected override async onChannelEvent(
    _channelId: string,
    event: ChannelEvent,
  ): Promise<boolean> {
    return event.type === this.consumePayloadKind;
  }

  protected override async shouldRespond(
    channelId: string,
    event: ChannelEvent,
    deliveredContext?: import("@workspace/pubsub").ChannelAgenticContext,
  ): Promise<boolean> {
    return this.useDeliveredDecisionContext
      ? super.shouldRespond(channelId, event, deliveredContext)
      : true;
  }

  protected override async ensurePromptArtifacts(): Promise<void> {}

  protected override get driver(): AgentLoopDriver {
    return {
      activateChannel: vi.fn(),
      handleIncoming: this.handleIncomingSpy,
      loop: vi.fn(async () => ({ state: { openTurn: null } })),
    } as unknown as AgentLoopDriver;
  }

  markEmptyRosterFresh(channelId: string): void {
    this.setStateValue(`agent:roster:${channelId}`, "[]");
  }
}

class AutomationCompletionProbe extends PromptEventProbe {
  private openAutomationTurn: {
    turnId: string;
    metadata: AgentTurnMetadata;
  } | null = null;

  setAutomationTurnForTest(
    automation: NonNullable<AgentTurnMetadata["automation"]>,
  ): void {
    this.openAutomationTurn = {
      turnId: "turn-automation",
      metadata: { origin: "scheduled", automation },
    };
  }

  protected override get driver(): AgentLoopDriver {
    const openTurn = this.openAutomationTurn;
    return {
      activateChannel: vi.fn(),
      handleIncoming: this.handleIncomingSpy,
      peekLoadedLoop: vi.fn(() =>
        openTurn ? { state: { openTurn } } : { state: { openTurn: null } },
      ),
      loop: vi.fn(async () => ({
        state: { openTurn },
      })),
    } as unknown as AgentLoopDriver;
  }

  async completeAutomationForTest(response: string): Promise<unknown> {
    const tool = (
      this as unknown as {
        createAutomationCompletionTool(channelId: string): {
          execute(
            callId: string,
            input: { response: string },
          ): Promise<unknown>;
        };
      }
    ).createAutomationCompletionTool(CHANNEL);
    return tool.execute("complete-call", { response });
  }

  async automationAddresseeContextForTest(): Promise<{ ownerUserId?: string }> {
    return this.addresseeContext(CHANNEL);
  }

  async closeAutomationTurnForTest(input: {
    automation: NonNullable<AgentTurnMetadata["automation"]>;
    summary?: string;
    reason?: string;
    effectFailures?: Array<{
      invocationId: string;
      name: string;
      outcome: "tool_error";
      code: string;
      message: string;
    }>;
  }): Promise<void> {
    await this.onTurnClosed({
      channelId: CHANNEL,
      turnId: "turn-automation",
      metadata: { origin: "scheduled", automation: input.automation },
      effectFailures: input.effectFailures ?? [],
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
  }
}

async function makeVessel(): Promise<TestVessel> {
  const { instance } = await createTestDO(TestVessel, TEST_AGENT_ENV);
  // Register a subscription row so the card path has a participant id, without
  // booting the driver/prompt machinery.
  await instance.registerSubscriptionForTest();
  return instance;
}

async function makePromptProbe(config?: unknown): Promise<PromptEventProbe> {
  const { instance } = await createTestDO(PromptEventProbe, TEST_AGENT_ENV);
  await instance.registerSubscriptionForTest(CHANNEL, config);
  instance.markEmptyRosterFresh(CHANNEL);
  return instance;
}

function customChannelEvent(
  type: string,
  overrides: Partial<ChannelEvent> = {},
): ChannelEvent {
  return {
    id: 17,
    messageId: "custom-envelope-17",
    type,
    payload: { incidentId: "inc-17", severity: "high" },
    senderId: "app:incident-feed",
    senderMetadata: {
      type: "app",
      name: "Incident feed",
      handle: "incidents",
      privateCredential: "must-not-leak",
    },
    ts: 1_786_400_000_000,
    ...overrides,
  };
}

/** The EvalDO objectKey the eval service derives, and the caller id chatOp
 *  expects: sha256(`${agentRuntimeId}\0${channelId}`) hex, first 40. */
async function expectedEvalCaller(): Promise<string> {
  const key = sha256HexSyncText(`${AGENT_ID}\0${CHANNEL}`).slice(0, 40);
  return `do:vibestudio/internal:EvalDO:${key}`;
}

describe("AgentVesselBase automation ingress", () => {
  const automation = {
    missionId: "mission-health",
    runId: "run-health",
    ownerUserId: "usr_owner",
    authoritySessionNonce: "nonce:run-health",
    name: "Project health",
    revision: 2,
    action: "eval" as const,
    trigger: "scheduled" as const,
    startedAt: 1_786_400_000_000,
    createdAt: 1_786_000_000_000,
    activatedAt: 1_786_100_000_000,
    schedule: { kind: "interval" as const, everyMs: 3_600_000 },
  };

  it("keeps the mission owner exactly addressable in an otherwise empty fresh run channel", async () => {
    const { instance: vessel } = await createTestDO(
      AutomationCompletionProbe,
      TEST_AGENT_ENV,
    );
    await vessel.registerSubscriptionForTest(CHANNEL);
    vessel.markEmptyRosterFresh(CHANNEL);
    vessel.setAutomationTurnForTest(automation);
    Object.defineProperty(vessel, "rpc", {
      value: {
        call: vi.fn(async (target: string, method: string) => {
          if (target === "main" && method === "account.listWorkspaceMembers") {
            return [{ userId: automation.ownerUserId, handle: "owner" }];
          }
          if (target === "main" && method === "workers.resolveService") {
            throw new Error("directory unavailable");
          }
          throw new Error(`Unexpected RPC ${target}.${method}`);
        }),
      },
      configurable: true,
    });

    await expect(
      vessel.automationAddresseeContextForTest(),
    ).resolves.toMatchObject({
      ownerUserId: automation.ownerUserId,
      roster: [],
      users: [{ userId: automation.ownerUserId, handle: "owner" }],
    });
  });

  it("journals scheduled eval source with ordinary approval fallback", async () => {
    const vessel = await makePromptProbe();

    await vessel.runAutomationEval({
      channelId: CHANNEL,
      automation,
      eval: { code: "return await chat.getParticipants()", timeoutMs: 30_000 },
    });

    expect(vessel.handleIncomingSpy).toHaveBeenCalledWith(CHANNEL, {
      type: "command",
      command: {
        kind: "invoke",
        channelId: CHANNEL,
        source: { envelopeId: "automation:run-health" },
        tool: "eval",
        args: {
          code: "return await chat.getParticipants()",
          timeoutMs: 30_000,
          authority: { approvals: "prompt" },
        },
        metadata: {
          origin: "scheduled",
          automation,
          completion: "after-invocation",
          delivery: "channel",
        },
      },
    });
  });

  it("carries the same durable automation provenance into prompt turns", async () => {
    const vessel = await makePromptProbe();
    const promptAutomation = { ...automation, action: "prompt" as const };

    await vessel.runAutomationTurn({
      channelId: CHANNEL,
      automation: promptAutomation,
      prompt: "Review the open risks.",
    });

    expect(vessel.handleIncomingSpy).toHaveBeenCalledWith(
      CHANNEL,
      expect.objectContaining({
        command: expect.objectContaining({
          kind: "prompt",
          source: { envelopeId: "automation:run-health" },
          content: expect.stringContaining("<automation-tick>"),
          metadata: expect.objectContaining({
            automation: promptAutomation,
            deliverAfterTurn: true,
          }),
        }),
      }),
    );
  });

  it("records prompt completion as a first-class terminal automation response", async () => {
    const { instance: vessel } = await createTestDO(
      AutomationCompletionProbe,
      TEST_AGENT_ENV,
    );
    await vessel.registerSubscriptionForTest(CHANNEL);
    const promptAutomation = { ...automation, action: "prompt" as const };
    vessel.setAutomationTurnForTest(promptAutomation);
    const rpcCall = vi.fn(async (target: string, method: string) => {
      if (target === "main" && method === "workers.resolveService") {
        return { kind: "durable-object", targetId: "do:missions" };
      }
      if (target === "do:missions" && method === "finishRun") return undefined;
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    Object.defineProperty(vessel, "rpc", {
      value: { call: rpcCall },
      configurable: true,
    });

    await expect(
      vessel.completeAutomationForTest("All rollout targets are healthy."),
    ).resolves.toMatchObject({ terminate: true });
    await vessel.closeAutomationTurnForTest({
      automation: promptAutomation,
      reason: "tool_terminated",
    });

    expect(rpcCall).toHaveBeenCalledWith("do:missions", "finishRun", [
      {
        runId: automation.runId,
        outcome: "succeeded",
        finalMessage: "All rollout targets are healthy.",
        completionResponse: "All rollout targets are healthy.",
      },
    ]);
  });

  it("recognizes the same completion protocol returned by a scheduled eval", async () => {
    const { instance: vessel } = await createTestDO(
      AutomationCompletionProbe,
      TEST_AGENT_ENV,
    );
    await vessel.registerSubscriptionForTest(CHANNEL);
    vessel.setAutomationTurnForTest(automation);
    const rpcCall = vi.fn(async (target: string, method: string) => {
      if (target === "main" && method === "workers.resolveService") {
        return { kind: "durable-object", targetId: "do:missions" };
      }
      if (target === "do:missions" && method === "finishRun") return undefined;
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    Object.defineProperty(vessel, "rpc", {
      value: { call: rpcCall },
      configurable: true,
    });
    await vessel.closeAutomationTurnForTest({
      automation,
      summary: JSON.stringify({
        protocolContent: [],
        details: {
          returnValue: {
            protocol: "automation-completion.v1",
            response: "No pending migrations remain.",
          },
        },
      }),
    });

    expect(rpcCall).toHaveBeenCalledWith("do:missions", "finishRun", [
      {
        runId: automation.runId,
        outcome: "succeeded",
        finalMessage: "No pending migrations remain.",
        completionResponse: "No pending migrations remain.",
      },
    ]);
  });

  it("reports a failed scheduled turn with the mission ledger's structured failure contract", async () => {
    const { instance: vessel } = await createTestDO(
      AutomationCompletionProbe,
      TEST_AGENT_ENV,
    );
    await vessel.registerSubscriptionForTest(CHANNEL);
    const promptAutomation = { ...automation, action: "prompt" as const };
    vessel.setAutomationTurnForTest(promptAutomation);
    const rpcCall = vi.fn(async (target: string, method: string) => {
      if (target === "main" && method === "workers.resolveService") {
        return { kind: "durable-object", targetId: "do:missions" };
      }
      if (target === "do:missions" && method === "finishRun") return undefined;
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    Object.defineProperty(vessel, "rpc", {
      value: { call: rpcCall },
      configurable: true,
    });

    await vessel.closeAutomationTurnForTest({
      automation: promptAutomation,
      reason: "model_failed",
      summary: "Provider rejected the turn",
    });

    expect(rpcCall).toHaveBeenCalledWith("do:missions", "finishRun", [
      {
        runId: automation.runId,
        outcome: "failed",
        failure: {
          code: "EAGENTTURN",
          stage: "executing",
          message: "Provider rejected the turn",
          retry: "manual",
        },
      },
    ]);
  });

  it("reports a completed turn with failed effects instead of claiming success", async () => {
    const { instance: vessel } = await createTestDO(
      AutomationCompletionProbe,
      TEST_AGENT_ENV,
    );
    await vessel.registerSubscriptionForTest(CHANNEL);
    const promptAutomation = { ...automation, action: "prompt" as const };
    vessel.setAutomationTurnForTest(promptAutomation);
    const rpcCall = vi.fn(async (target: string, method: string) => {
      if (target === "main" && method === "workers.resolveService")
        return { kind: "durable-object", targetId: "do:missions" };
      if (target === "do:missions" && method === "finishRun") return undefined;
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    Object.defineProperty(vessel, "rpc", {
      value: { call: rpcCall },
      configurable: true,
    });
    const effectFailure = {
      invocationId: "notify-call",
      name: "notify",
      outcome: "tool_error" as const,
      code: "EDELIVERY",
      message: "Notification delivery failed",
    };

    await vessel.closeAutomationTurnForTest({
      automation: promptAutomation,
      summary: "I could not deliver the notification.",
      effectFailures: [effectFailure],
    });

    expect(rpcCall).toHaveBeenCalledWith("do:missions", "finishRun", [
      {
        runId: automation.runId,
        outcome: "completed-with-errors",
        finalMessage: "I could not deliver the notification.",
        effectFailures: [effectFailure],
      },
    ]);
  });

  it("retains terminal receiver evidence when the mission callback is lost", async () => {
    const { instance: vessel } = await createTestDO(
      AutomationCompletionProbe,
      TEST_AGENT_ENV,
    );
    await vessel.registerSubscriptionForTest(CHANNEL);
    const promptAutomation = { ...automation, action: "prompt" as const };
    vessel.setAutomationTurnForTest(promptAutomation);
    Object.defineProperty(vessel, "rpc", {
      value: {
        call: vi.fn(async (target: string, method: string) => {
          if (target === "main" && method === "workers.resolveService") {
            return { kind: "durable-object", targetId: "do:missions" };
          }
          if (target === "do:missions" && method === "finishRun") {
            throw new Error("response lost after receiver commit");
          }
          throw new Error(`Unexpected RPC ${target}.${method}`);
        }),
      },
      configurable: true,
    });

    await expect(
      vessel.closeAutomationTurnForTest({
        automation: promptAutomation,
        summary: "The scheduled work completed.",
      }),
    ).rejects.toThrow("response lost after receiver commit");

    await expect(
      vessel.describeAutomationRun({
        channelId: CHANNEL,
        runId: automation.runId,
      }),
    ).resolves.toMatchObject({
      state: "terminal",
      outcome: "succeeded",
      finalMessage: "The scheduled work completed.",
    });
    await vessel.runAutomationTurn({
      channelId: CHANNEL,
      automation: promptAutomation,
      prompt: "This must not be submitted again.",
    });
    expect(vessel.handleIncomingSpy).not.toHaveBeenCalled();
  });
});

describe("AgentVesselBase finite channel delivery", () => {
  it("returns the retained outcome after a response-loss retry", async () => {
    const vessel = await makePromptProbe();
    vessel.useDeliveredDecisionContext = true;
    const clientCreationsBeforeDelivery = vessel.channelClientCreations;
    const participantId = vessel.subscriptionParticipantIdForTest(CHANNEL);
    const event: ChannelEvent = {
      id: 1,
      messageId: "delivery-message",
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: {
        kind: "message.completed",
        actor: { kind: "user", id: "user:test" },
        causality: { messageId: "delivery-message" },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          role: "user",
          blocks: [
            {
              blockId: "delivery-message:block",
              type: "text",
              content: "hello",
            },
          ],
          outcome: "completed",
        },
        createdAt: new Date().toISOString(),
      } as AgenticEvent,
      senderId: "user:test",
      ts: Date.now(),
    };
    const input = {
      deliveryId: "delivery-idempotent",
      channelId: CHANNEL,
      channelRef: {
        source: "workers/pubsub-channel",
        className: "PubSubChannel",
        objectKey: CHANNEL,
      },
      participantId,
      subscriptionRevision: 1,
      eventSequence: event.id,
      envelope: { kind: "log", phase: "live", event } as RpcChannelMessage,
      agenticContext: {
        version: 1 as const,
        relationships: [
          {
            participantId,
            metadata: { name: "Test agent", type: "agent" },
            applicationConfig: null,
          },
          {
            participantId: "user:test",
            metadata: { name: "Test user", type: "panel" },
            applicationConfig: null,
          },
        ],
        channelConfig: {},
        conversation: {
          lastCompletedSender: "user:test",
          lastCompletedMessageId: "delivery-message",
          lastCompletedSeq: event.id,
          previousCompletedSender: null,
          previousCompletedMessageId: null,
          previousCompletedSeq: null,
          agentStreak: 0,
        },
        replyToSenderId: null,
      },
    };

    await expect(vessel.acceptChannelDelivery(input)).resolves.toMatchObject({
      deliveryId: input.deliveryId,
      disposition: "processed",
    });
    await expect(vessel.acceptChannelDelivery(input)).resolves.toMatchObject({
      deliveryId: input.deliveryId,
      disposition: "duplicate",
    });
    expect(vessel.channelClientCreations).toBe(clientCreationsBeforeDelivery);
  });
});

describe("AgentVesselBase hot-path trace retention", () => {
  it("amortizes retention sweeps while keeping the durable trace bounded", async () => {
    const { instance } = await createTestDO(TestVessel, TEST_AGENT_ENV);

    instance.writeHotPathTracesForTest(576);
    expect(instance.hotPathTraceCountForTest()).toBe(563);

    instance.writeHotPathTracesForTest(1);
    expect(instance.hotPathTraceCountForTest()).toBe(500);
  });

  it("labels only a previously-started eval recovery claim as the redrive backstop", async () => {
    const { instance: redrive } = await createTestDO(
      TestVessel,
      TEST_AGENT_ENV,
    );
    redrive.seedDeferredEvalForTest("eval:redrive", true);
    // The parked-row alarm delivers through the ordinary work-ready hint, so
    // the label must key on the durable started flag, not the trigger.
    expect(
      redrive.claimReadyWork("agent-effect", {
        workerId: "test-worker",
        now: Date.now(),
        limit: 1,
        trigger: "hint",
      }),
    ).toHaveLength(1);
    expect(redrive.hotPathTraceSourcesForTest("effect.claimed")).toEqual([
      "redrive-backstop",
    ]);

    const { instance: healthy } = await createTestDO(
      TestVessel,
      TEST_AGENT_ENV,
    );
    healthy.seedDeferredEvalForTest("eval:first-dispatch", false);
    expect(
      healthy.claimReadyWork("agent-effect", {
        workerId: "test-worker",
        now: Date.now(),
        limit: 1,
        trigger: "hint",
      }),
    ).toHaveLength(1);
    expect(healthy.hotPathTraceSourcesForTest("effect.claimed")).toEqual([
      "hint",
    ]);
  });
});

describe("AgentVesselBase durable work readiness", () => {
  it("treats settlement from a lifecycle-released activation as stale", async () => {
    const { instance: vessel } = await createTestDO(TestVessel, TEST_AGENT_ENV);
    vessel.seedDeferredEvalForTest("eval:lifecycle-release", false);
    const claim = vessel.claimReadyWork("agent-effect", {
      workerId: "test-worker",
      now: Date.now(),
      limit: 1,
    })[0]!;

    await vessel.releaseForLifecycle({
      epoch: "test-epoch",
      mode: "suspend",
      reason: "test",
      deadlineMs: 1_000,
    });

    expect(
      vessel.settleReadyWork("agent-effect", {
        workerId: "test-worker",
        itemId: claim.itemId,
        generation: claim.generation,
        outcome: { executed: true },
      }),
    ).toBe("stale");
  });

  it("persists an immediate host wake until work exposed by a DO-to-DO callback is drained", async () => {
    await withAlarmGateway(async (gatewayUrl) => {
      const { instance: vessel, callAs } = await createTestDO(TestVessel, {
        ...TEST_AGENT_ENV,
        GATEWAY_URL: gatewayUrl,
      });

      await callAs(
        "do",
        "markWorkReadyForTest",
        "agent-effect",
        "agent-effect",
      );

      expect(vessel.durableWorkReadyGenerationsForTest()).toEqual([
        { queue: "agent-effect", generation: 1 },
      ]);
      expect(vessel.nextAlarmScheduleForTest()?.wakeAt).toEqual(
        expect.any(Number),
      );

      await vessel.alarm();
      expect(vessel.durableWorkReadyGenerationsForTest()).toEqual([
        { queue: "agent-effect", generation: 1 },
      ]);

      expect(
        vessel.claimReadyWork("agent-effect", {
          workerId: "test-worker",
          now: Date.now(),
          limit: 1,
        }),
      ).toEqual([]);
      expect(vessel.nextAlarmScheduleForTest()).toBeNull();
    });
  });

  it("uses the response-carried hint alone when the host owns the request", async () => {
    await withAlarmGateway(async (gatewayUrl) => {
      const { instance: vessel, call } = await createTestDO(TestVessel, {
        ...TEST_AGENT_ENV,
        GATEWAY_URL: gatewayUrl,
      });

      await call("markWorkReadyForTest", "agent-effect");

      expect(vessel.durableWorkReadyGenerationsForTest()).toEqual([
        { queue: "agent-effect", generation: 1 },
      ]);
    });
  });
});

describe("AgentVesselBase activation-local inspection", () => {
  it("admits the authenticated channel DO before enforcing its exact identity", async () => {
    const vessel = await makeVessel();

    expect(rpcMethodAuthority(vessel, "readAgentInspection")).toMatchObject({
      principals: ["host", "code"],
      effect: { kind: "open" },
      tier: "open",
      sensitivity: "read",
    });
  });

  it("returns a partial snapshot without entering a stalled loop hydration path", async () => {
    const vessel = await makeVessel();
    const hydrateLoop = vi.fn(() => new Promise(() => {}));
    const peekLoadedLoop = vi.fn(() => null);
    (vessel as unknown as { _driver: unknown })._driver = {
      loop: hydrateLoop,
      peekLoadedLoop,
      connectSpecProvider: undefined,
    };
    vessel.callerKindForTest = "do";
    vessel.callerIdForTest = "do:workers/pubsub-channel:PubSubChannel:chan-1";

    await expect(
      vessel.readAgentInspection(CHANNEL, "getDebugState"),
    ).resolves.toMatchObject({
      result: {
        loops: {
          [CHANNEL]: {
            loaded: false,
            note: expect.stringContaining("inspect GAD"),
          },
        },
        outbox: [],
      },
    });
    expect(peekLoadedLoop).toHaveBeenCalledWith(CHANNEL);
    expect(hydrateLoop).not.toHaveBeenCalled();
  });

  it("does not populate reconstructible loop storage while inspecting an unused activation", async () => {
    const vessel = await makeVessel();
    vessel.callerKindForTest = "do";
    vessel.callerIdForTest = "do:workers/pubsub-channel:PubSubChannel:chan-1";

    expect(vessel.hasEffectOutboxTableForTest()).toBe(true);
    await expect(
      vessel.readAgentInspection(CHANNEL, "getDebugState"),
    ).resolves.toMatchObject({
      result: { loops: { [CHANNEL]: { loaded: false } }, outbox: [] },
    });
    expect(vessel.hasEffectOutboxTableForTest()).toBe(true);
  });

  it("rejects inspection calls from anything except a channel DO or the server", async () => {
    const vessel = await makeVessel();
    vessel.callerKindForTest = "panel";
    vessel.callerIdForTest = "panel:untrusted";

    await expect(
      vessel.readAgentInspection(CHANNEL, "getDebugState"),
    ).rejects.toThrow(/refusing caller/u);
  });
});

describe("AgentVesselBase.chatOp", () => {
  it("coalesces concurrent blob-cache misses and retains the immutable result", async () => {
    const vessel = await makeVessel();
    let releaseRead: ((value: string) => void) | undefined;
    let reads = 0;
    vessel.blobTextReaderForTest = async () => {
      reads += 1;
      return await new Promise<string>((resolve) => {
        releaseRead = resolve;
      });
    };

    const concurrent = Array.from({ length: 32 }, () =>
      vessel.readBlobTextForTest("same-digest"),
    );
    await vi.waitFor(() => expect(reads).toBe(1));
    releaseRead?.("shared text");

    await expect(Promise.all(concurrent)).resolves.toEqual(
      Array.from({ length: 32 }, () => "shared text"),
    );
    await expect(vessel.readBlobTextForTest("same-digest")).resolves.toBe(
      "shared text",
    );
    expect(reads).toBe(1);
  });

  it("does not retain failed or missing blob reads", async () => {
    const vessel = await makeVessel();
    let reads = 0;
    vessel.blobTextReaderForTest = async () => {
      reads += 1;
      if (reads === 1) throw new Error("temporary read failure");
      if (reads === 2) return null;
      return "available";
    };

    await expect(vessel.readBlobTextForTest("eventual-digest")).rejects.toThrow(
      "temporary read failure",
    );
    await expect(
      vessel.readBlobTextForTest("eventual-digest"),
    ).resolves.toBeNull();
    await expect(vessel.readBlobTextForTest("eventual-digest")).resolves.toBe(
      "available",
    );
    expect(reads).toBe(3);
  });

  it("rejects a caller that is not this agent's own EvalDO", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = "do:vibestudio/internal:EvalDO:someoneelse";
    await expect(vessel.chatOp(CHANNEL, "getMessageTypes", [])).rejects.toThrow(
      /only this agent's own EvalDO/,
    );
  });

  it("rejects when there is no verified caller", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = null;
    await expect(vessel.chatOp(CHANNEL, "getMessageTypes", [])).rejects.toThrow(
      /refusing caller/,
    );
  });

  it("accepts the agent's own EvalDO (key matches the eval service formula)", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    vessel.channelStub.messageTypes.set("weather", WEATHER_TYPE);
    const types = await vessel.chatOp(CHANNEL, "getMessageTypes", []);
    expect(Array.isArray(types)).toBe(true);
    expect((types as unknown[]).length).toBe(1);
  });

  it("replayEnvelope returns one durable envelope by id and null when absent", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    const event = {
      id: 7,
      type: "message",
      payload: { text: "hello" },
      senderId: "panel:user",
      ts: Date.now(),
    } as ChannelEvent;
    vessel.channelStub.envelopes.set("env-7", event);

    await expect(
      vessel.chatOp(CHANNEL, "replayEnvelope", ["env-7"]),
    ).resolves.toEqual(event);
    await expect(
      vessel.chatOp(CHANNEL, "replayEnvelope", ["missing"]),
    ).resolves.toBeNull();
    await expect(
      vessel.chatOp(CHANNEL, "replayEnvelope", [""]),
    ).resolves.toBeNull();
  });

  it("getParticipants exposes the canonical chat participant shape", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    vessel.channelStub.participants = [
      {
        participantId: "participant-1",
        ref: { kind: "agent", id: "agent-1" },
        metadata: { type: "agent", name: "Agent" },
      },
    ];

    await expect(
      vessel.chatOp(CHANNEL, "getParticipants", []),
    ).resolves.toEqual([
      {
        id: "participant-1",
        ref: { kind: "agent", id: "agent-1" },
        type: "agent",
        name: "Agent",
        isPerson: false,
        isAgent: true,
      },
    ]);
  });

  it("configureAgent + describeSelf expose per-agent config to the eval `agent` binding", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();

    const updated = (await vessel.chatOp(CHANNEL, "configureAgent", [
      { model: "openai:gpt-5.3", thinkingLevel: "high" },
    ])) as { model: string; thinkingLevel: string };
    expect(updated.model).toBe("openai:gpt-5.3");
    expect(updated.thinkingLevel).toBe("high");

    const snapshot = (await vessel.chatOp(CHANNEL, "describeSelf", [])) as {
      identity: { id: string };
      config: { model: string };
      channels: Array<{ channelId: string }>;
    };
    expect(snapshot.identity.id).toBe(AGENT_ID);
    // Per-agent: the model set above is what describeSelf reports.
    expect(snapshot.config.model).toBe("openai:gpt-5.3");
    expect(snapshot.channels.some((c) => c.channelId === CHANNEL)).toBe(true);

    const readSnapshot = (await vessel.describeEvalOwner(CHANNEL)) as {
      identity: { id: string };
    };
    expect(readSnapshot.identity.id).toBe(AGENT_ID);
  });

  it("configureAgent validates its patch (rejects an empty model)", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    await expect(
      vessel.chatOp(CHANNEL, "configureAgent", [{ model: "" }]),
    ).rejects.toThrow(/model/);
  });

  it("registerMessageType publishes messageType.registered AS the agent", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    await vessel.chatOp(CHANNEL, "registerMessageType", [
      {
        typeId: "weather",
        displayMode: "row",
        source: { type: "file", path: "renderers/weather.tsx" },
        stateSchema: WEATHER_TYPE.stateSchema,
      },
    ]);
    const published = vessel.channelStub.published;
    expect(published).toHaveLength(1);
    expect(published[0]!.event.kind).toBe("messageType.registered");
    expect(published[0]!.event.actor.kind).toBe("agent");
    expect(published[0]!.event.actor.id).toBe(AGENT_ID);
  });

  it("publishCustomMessage routes through the card manager and returns { messageId, pubsubId }", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    vessel.channelStub.messageTypes.set("weather", WEATHER_TYPE);
    const result = (await vessel.chatOp(CHANNEL, "publishCustomMessage", [
      { typeId: "weather", initialState: { city: "Berlin" } },
    ])) as { messageId: string; pubsubId: number | undefined };
    expect(typeof result.messageId).toBe("string");
    // The stub returns { id: published.length }; the first publish is id 1, and
    // the handle must surface it (harmonized with the panel client).
    expect(result.pubsubId).toBe(1);
    const started = vessel.channelStub.published.find(
      (p) => p.event.kind === "custom.started",
    );
    expect(started).toBeDefined();
    expect(started!.event.actor.kind).toBe("agent");
  });

  it("launches one active automation and publishes its running inspector before returning", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    vessel.automationLaunchForTest = {
      schemaVersion: 3,
      missionId: "mission-daily",
      name: "Daily check",
      revision: 1,
      charter: {
        summary: "Check the project every morning.",
        execution: {
          kind: "agent",
          image: {
            source: "workers/agent",
            effectiveVersion: "a".repeat(64),
            ref: `state:${"b".repeat(64)}`,
            className: "Agent",
            objectKey: "daily",
          },
          action: { kind: "prompt", text: "Check the project." },
          conversation: { mode: "fresh" },
          operations: [],
        },
        trigger: {
          kind: "cron",
          expression: "5 5 * * THU",
          timezone: "America/New_York",
        },
      },
      owner: { userId: "alice" },
      state: "active",
      revisionDigest: "b".repeat(64),
      authorityPlan: {
        schemaVersion: 1,
        digest: "c".repeat(64),
        artifactRef: `authority-plan:${"c".repeat(64)}`,
        compilerVersion: "test",
        catalogDigest: "d".repeat(64),
      },
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      activatedAt: 1_700_000_000_000,
      runCount: 0,
      authority: { requestIds: [], grantIds: [], denialIds: [] },
    };

    const input = {
      name: "Daily check",
      summary: "Check the project every morning.",
      action: { kind: "prompt", text: "Check the project." },
      trigger: {
        kind: "cron",
        expression: "5 5 * * THU",
        timezone: "America/New_York",
      },
      operations: [],
    };
    const pillKey = "automation:instituted:mission-daily";
    vessel.channelPublishFailures.add(pillKey);
    await expect(vessel.executeAutomationLaunchForTest(input)).rejects.toThrow(
      `publish failed: ${pillKey}`,
    );
    expect(vessel.channelStub.published).toHaveLength(0);

    vessel.channelPublishFailures.delete(pillKey);
    await expect(
      vessel.executeAutomationLaunchForTest(input),
    ).resolves.toMatchObject({
      details: { missionId: "mission-daily", state: "active" },
    });

    expect(vessel.automationLaunchCalls).toHaveLength(2);
    expect(vessel.automationLaunchCalls).toEqual(
      Array.from({ length: 2 }, () => ({
        args: [
          {
            name: "Daily check",
            charter: {
              summary: "Check the project every morning.",
              execution: {
                kind: "agent",
                image: {
                  source: "workers/test",
                  effectiveVersion: "a".repeat(64),
                  ref: `state:${"b".repeat(64)}`,
                  className: "TestAgent",
                  objectKey: "agent-key",
                },
                action: { kind: "prompt", text: "Check the project." },
                conversation: {
                  mode: "continue",
                  channelId: CHANNEL,
                  contextId: "ctx-1",
                  executorId: AGENT_ID,
                },
                operations: [],
              },
              trigger: {
                kind: "cron",
                expression: "5 5 * * THU",
                timezone: "America/New_York",
              },
            },
          },
        ],
        options: {
          idempotencyKey: expect.stringMatching(
            /automation:launch:.*:[0-9a-f]{64}$/,
          ),
        },
      })),
    );
    expect(vessel.automationLaunchCalls[1]!.options).toEqual(
      vessel.automationLaunchCalls[0]!.options,
    );
    expect(vessel.channelStub.published).toContainEqual(
      expect.objectContaining({
        idempotencyKey: pillKey,
        event: expect.objectContaining({
          kind: "automation.instituted",
          payload: expect.objectContaining({
            definition: expect.objectContaining({
              missionId: "mission-daily",
              state: "active",
              action: "prompt",
              schedule: {
                kind: "cron",
                expression: "5 5 * * THU",
                timezone: "America/New_York",
              },
            }),
          }),
        }),
      }),
    );

    await vessel.executeAutomationLaunchForTest({
      ...input,
      operations: [
        {
          service: "accounts",
          method: "connect",
          use: "action",
        },
      ],
    });
    expect(vessel.automationAuthorityCalls.map(({ method }) => method)).toEqual(
      ["authority.compileAuthorityPlan", "authority.acquireForCurrentTask"],
    );
    expect(vessel.automationAuthorityCalls[1]!.args).toEqual([
      { authorityPlanDigest: "c".repeat(64) },
    ]);

    await vessel.executeAutomationLaunchForTest({
      ...input,
      conversation: { mode: "fresh" },
    });
    expect(vessel.automationLaunchCalls[3]!.args).toMatchObject([
      {
        charter: {
          execution: { conversation: { mode: "fresh" } },
        },
      },
    ]);
  });

  it("pauses the sole active automation in this conversation through the native control tool", async () => {
    const vessel = await makeVessel();
    vessel.automationVisibleForTest = [
      automationRecord({ missionId: "mission-sloths", name: "Sloth fun facts" }),
    ];

    await expect(
      vessel.executeAutomationControlForTest({ action: "pause" }),
    ).resolves.toMatchObject({
      content: [{ text: "Sloth fun facts was paused." }],
      details: { missionId: "mission-sloths", state: "paused" },
    });
    expect(vessel.automationControlCalls).toEqual([
      {
        method: "pause",
        args: ["mission-sloths"],
        options: {
          idempotencyKey: expect.stringMatching(
            /automation:control:agent-key:[0-9a-f]{64}:pause:mission-sloths/,
          ),
        },
      },
    ]);
  });

  it("requires an exact target when multiple current-conversation automations match", async () => {
    const vessel = await makeVessel();
    vessel.automationVisibleForTest = [
      automationRecord({ missionId: "mission-one", name: "One" }),
      automationRecord({ missionId: "mission-two", name: "Two" }),
    ];

    await expect(
      vessel.executeAutomationControlForTest({ action: "pause" }),
    ).rejects.toThrow("More than one automation matches");
    await expect(
      vessel.executeAutomationControlForTest({
        action: "pause",
        name: "Two",
      }),
    ).resolves.toMatchObject({ details: { missionId: "mission-two" } });
  });

  it("updateCustomMessage publishes custom.updated AS the agent and returns its pubsubId", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    vessel.channelStub.messageTypes.set("weather", WEATHER_TYPE);
    const created = (await vessel.chatOp(CHANNEL, "publishCustomMessage", [
      { typeId: "weather", initialState: { city: "Berlin" } },
    ])) as { messageId: string };
    const pubsubId = await vessel.chatOp(CHANNEL, "updateCustomMessage", [
      created.messageId,
      { city: "Paris" },
    ]);
    // Second publish on this channel → stub id 2.
    expect(pubsubId).toBe(2);
    const updated = vessel.channelStub.published.find(
      (p) => p.event.kind === "custom.updated",
    );
    expect(updated).toBeDefined();
    expect(updated!.event.actor.kind).toBe("agent");
  });

  it("focusMessage is panel-only and resolves false", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    await expect(
      vessel.chatOp(CHANNEL, "focusMessage", ["msg-1"]),
    ).resolves.toBe(false);
  });

  it("callMethod initiates a channel call and resolves with the delivered content", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    const promise = vessel.chatOp(CHANNEL, "callMethod", [
      "panel-pid",
      "doThing",
      { x: 1 },
    ]);
    const call = await waitForCall(vessel);
    expect(call.method).toBe("doThing");
    await vessel.deliverTerminal(call.callId, "invocation.completed", {
      result: { ok: 42 },
    });
    await expect(promise).resolves.toEqual({ ok: 42 });
  });

  it("callMethodResult resolves with the full ChatMethodResult envelope", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    const promise = vessel.chatOp(CHANNEL, "callMethodResult", [
      "panel-pid",
      "doThing",
      {},
    ]);
    const call = await waitForCall(vessel);
    await vessel.deliverTerminal(call.callId, "invocation.completed", {
      result: "hello",
    });
    await expect(promise).resolves.toEqual({ content: "hello" });
  });

  it("callMethod rejects when the channel terminal is an error", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    const promise = vessel.chatOp(CHANNEL, "callMethod", [
      "panel-pid",
      "boom",
      {},
    ]);
    const call = await waitForCall(vessel);
    await vessel.deliverTerminal(call.callId, "invocation.failed", {
      error: "kaboom",
    });
    await expect(promise).rejects.toThrow(/kaboom/);
  });

  it("resolves the agent's own read-only inspection call without a channel deadlock", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();

    await expect(
      vessel.chatOp(CHANNEL, "callMethod", [AGENT_ID, "getDebugState", {}]),
    ).resolves.toMatchObject({ participantId: AGENT_ID });
    expect(vessel.channelStub.calls).toHaveLength(0);
  });
});

describe("AgentVesselBase.processChannelEvent", () => {
  it("forwards message metadata into the loop command", async () => {
    const vessel = await makePromptProbe();
    const event: ChannelEvent = {
      id: 1,
      messageId: "env-after-turn",
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: {
        kind: "message.completed",
        actor: { kind: "user", id: "panel:user", participantId: "panel:user" },
        causality: { messageId: "msg-after-turn" },
        payload: {
          protocol: "agentic.trajectory.v1",
          role: "user",
          blocks: [{ type: "text", content: "next please" }],
          outcome: "completed",
          metadata: { deliverAfterTurn: true },
        },
        createdAt: new Date().toISOString(),
      } as unknown as AgenticEvent,
      senderId: "panel:user",
      ts: Date.now(),
    };

    await vessel.processChannelEvent(CHANNEL, event);

    expect(vessel.handleIncomingSpy).toHaveBeenCalledTimes(1);
    expect(vessel.handleIncomingSpy.mock.calls[0]?.[1]).toMatchObject({
      type: "command",
      command: {
        kind: "prompt",
        source: { envelopeId: "env-after-turn" },
        sourceMessageId: "msg-after-turn",
        metadata: { deliverAfterTurn: true },
      },
    });
  });

  it("ignores an unconfigured custom payload", async () => {
    const vessel = await makePromptProbe();

    await vessel.processChannelEvent(
      CHANNEL,
      customChannelEvent("application.incident.v1"),
    );

    expect(vessel.handleIncomingSpy).not.toHaveBeenCalled();
  });

  it("dispatches one exact configured payload with sanitized provenance and structure", async () => {
    const vessel = await makePromptProbe({
      observations: { payloadKinds: ["application.incident.v1"] },
    });
    const payload = {
      incidentId: "inc-17",
      severity: "high",
      details: { region: "eu" },
    };

    await vessel.processChannelEvent(
      CHANNEL,
      customChannelEvent("application.incident.v1", { payload }),
    );

    expect(vessel.handleIncomingSpy).toHaveBeenCalledOnce();
    expect(vessel.handleIncomingSpy).toHaveBeenCalledWith(CHANNEL, {
      type: "command",
      command: {
        kind: "prompt",
        channelId: CHANNEL,
        source: { envelopeId: "custom-envelope-17" },
        content: "Channel observation: application.incident.v1",
        structuredInput: {
          kind: "channel-observation",
          version: 1,
          source: {
            channelId: CHANNEL,
            envelopeId: "custom-envelope-17",
            sequence: 17,
            payloadKind: "application.incident.v1",
            timestamp: 1_786_400_000_000,
            sender: {
              kind: "external",
              id: "app:incident-feed",
              participantId: "app:incident-feed",
              displayName: "Incident feed",
              metadata: {
                type: "app",
                name: "Incident feed",
                handle: "incidents",
              },
            },
          },
          payload,
        },
        senderRef: {
          kind: "external",
          id: "app:incident-feed",
          participantId: "app:incident-feed",
          displayName: "Incident feed",
          metadata: { type: "app", name: "Incident feed", handle: "incidents" },
        },
      },
    });
    expect(vessel.operationLog).toEqual(
      expect.arrayContaining([
        "rpc:main:contextIntegrity.ingest",
        "driver:handleIncoming",
      ]),
    );
    expect(
      vessel.operationLog.indexOf("rpc:main:contextIntegrity.ingest"),
    ).toBeLessThan(vessel.operationLog.indexOf("driver:handleIncoming"));
  });

  it("requires an exact payload-kind match", async () => {
    const vessel = await makePromptProbe({
      observations: { payloadKinds: ["application.incident.v1"] },
    });

    await vessel.processChannelEvent(
      CHANNEL,
      customChannelEvent("application.incident.v1.updated"),
    );

    expect(vessel.handleIncomingSpy).not.toHaveBeenCalled();
  });

  it("ignores self-authored configured payloads", async () => {
    const vessel = await makePromptProbe({
      observations: { payloadKinds: ["application.incident.v1"] },
    });

    await vessel.processChannelEvent(
      CHANNEL,
      customChannelEvent("application.incident.v1", { senderId: AGENT_ID }),
    );

    expect(vessel.handleIncomingSpy).not.toHaveBeenCalled();
  });

  it("replaces an oversized payload with a bounded canonical preview", async () => {
    const vessel = await makePromptProbe({
      observations: { payloadKinds: ["application.incident.v1"] },
    });
    const payload = { details: "x".repeat(40_000) };
    const serialized = JSON.stringify(payload);

    await vessel.processChannelEvent(
      CHANNEL,
      customChannelEvent("application.incident.v1", { payload }),
    );

    const incoming = vessel.handleIncomingSpy.mock.calls[0]?.[1] as {
      command?: {
        structuredInput?: {
          payload?: unknown;
          truncated?: Record<string, unknown>;
        };
      };
    };
    expect(incoming.command?.structuredInput).toMatchObject({
      payload: null,
      truncated: {
        originalChars: serialized.length,
        preview: serialized.slice(0, 8_192),
      },
    });
  });

  it.each(["manual", "explicit"] as const)(
    "suppresses configured observations for the %s wake policy",
    async (wakePolicy) => {
      const vessel = await makePromptProbe({
        wakePolicy,
        observations: { payloadKinds: ["application.incident.v1"] },
      });

      await vessel.processChannelEvent(
        CHANNEL,
        customChannelEvent("application.incident.v1"),
      );

      expect(vessel.handleIncomingSpy).not.toHaveBeenCalled();
    },
  );

  it("never routes agentic infrastructure events as observations", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const vessel = await makePromptProbe({
      observations: { payloadKinds: [AGENTIC_EVENT_PAYLOAD_KIND] },
    });

    await vessel.processChannelEvent(CHANNEL, {
      ...customChannelEvent(AGENTIC_EVENT_PAYLOAD_KIND),
      payload: {
        kind: "system.event",
        actor: { kind: "system", id: "system" },
        payload: { protocol: AGENTIC_PROTOCOL_VERSION },
        createdAt: new Date().toISOString(),
      },
    });

    expect(vessel.handleIncomingSpy).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("lets the subclass hook consume a configured custom payload first", async () => {
    const vessel = await makePromptProbe({
      observations: { payloadKinds: ["application.incident.v1"] },
    });
    vessel.consumePayloadKind = "application.incident.v1";

    await vessel.processChannelEvent(
      CHANNEL,
      customChannelEvent("application.incident.v1"),
    );

    expect(vessel.handleIncomingSpy).not.toHaveBeenCalled();
  });

  it("keeps delivery retryable when prompt admission fails", async () => {
    const vessel = await makePromptProbe({
      observations: { payloadKinds: ["application.incident.v1"] },
    });
    const event = customChannelEvent("application.incident.v1");
    vessel.handleIncomingSpy.mockRejectedValueOnce(
      new Error("prompt admission failed"),
    );

    await expect(vessel.processChannelEvent(CHANNEL, event)).rejects.toThrow(
      "prompt admission failed",
    );
    await expect(
      vessel.processChannelEvent(CHANNEL, event),
    ).resolves.toBeUndefined();

    expect(vessel.handleIncomingSpy).toHaveBeenCalledTimes(2);
  });
});

describe("AgentVesselBase.onEvalComplete (deferred-eval resume)", () => {
  /** Replace the lazily-built driver with a spy so we can assert the delivered outcome. */
  function stubDriver(vessel: TestVessel): ReturnType<typeof vi.fn> {
    const deliverSpy = vi.fn(async () => {});
    (vessel as unknown as { _driver: unknown })._driver = {
      deliverEffectOutcome: deliverSpy,
      connectSpecProvider: undefined, // the driver getter sets this each access
    };
    return deliverSpy;
  }

  it("delivers the formatted result to the parked effect using its distinct eval run id", async () => {
    const vessel = await makeVessel();
    const deliverSpy = stubDriver(vessel);
    vessel.callerKindForTest = "do";
    vessel.callerIdForTest = await expectedEvalCaller();

    await vessel.onEvalComplete({
      runId: ids.invocationEffect("inv-77"),
      result: {
        success: true,
        console: "out",
        returnValue: 7,
        scopeKeys: ["a"],
      },
      channelId: CHANNEL,
    });

    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const [effectId, outcome, address] = deliverSpy.mock.calls[0]!;
    expect(effectId).toBe(ids.invocationEffect("inv-77"));
    expect(outcome).toMatchObject({
      kind: "tool",
      isError: false,
      // The formatted protocol content + the raw result on details (for the harness).
      result: { details: { success: true } },
    });
    expect(address).toEqual({ channelId: CHANNEL });
  });

  it("delivers a failed eval as a structured tool failure", async () => {
    const vessel = await makeVessel();
    const deliverSpy = stubDriver(vessel);
    vessel.callerKindForTest = "do";
    vessel.callerIdForTest = await expectedEvalCaller();
    await vessel.onEvalComplete({
      runId: "inv-78",
      result: { success: false, console: "", error: "boom" },
      channelId: CHANNEL,
    });
    expect(deliverSpy.mock.calls[0]![1]).toMatchObject({
      kind: "tool",
      isError: true,
      result: { details: { success: false, error: "boom" } },
    });
  });

  it("marks an eval infrastructure failure as terminal for the owning turn", async () => {
    const vessel = await makeVessel();
    const deliverSpy = stubDriver(vessel);
    vessel.callerKindForTest = "do";
    vessel.callerIdForTest = await expectedEvalCaller();
    await vessel.onEvalComplete({
      runId: "inv-infra",
      result: {
        success: false,
        console: "",
        error: "package load failed",
        failureKind: "infrastructure",
        failureCode: "package_load_failed",
      },
      channelId: CHANNEL,
    });
    expect(deliverSpy.mock.calls[0]![1]).toMatchObject({
      kind: "tool",
      isError: true,
      terminalOutcome: "infrastructure_error",
      result: {
        details: {
          failureKind: "infrastructure",
          failureCode: "package_load_failed",
        },
      },
    });
  });

  it("preserves typed in-turn recovery on an eval infrastructure failure", async () => {
    const vessel = await makeVessel();
    const deliverSpy = stubDriver(vessel);
    vessel.callerKindForTest = "do";
    vessel.callerIdForTest = await expectedEvalCaller();
    await vessel.onEvalComplete({
      runId: "inv-repairable",
      agentInvocationId: "call-repairable",
      result: {
        success: false,
        console: "",
        error: "protected publication build gate failed",
        failureKind: "infrastructure",
        failureCode: "scaffold_publication_failed",
        errorData: {
          code: "scaffold_publication_failed",
          recovery: {
            action: "repair-source",
            instruction: "Inspect diagnostics and publish a repaired revision.",
          },
        },
      },
      channelId: CHANNEL,
    });

    expect(deliverSpy.mock.calls[0]![1]).toMatchObject({
      kind: "tool",
      isError: true,
      terminalOutcome: "infrastructure_error",
      terminalReasonCode: "scaffold_publication_failed",
      failure: {
        kind: "infrastructure",
        recovery: { action: "repair-source" },
        causal: { invocationId: "call-repairable" },
      },
    });
  });

  it("keeps admission-loss recovery in-turn so the agent can inspect before a fresh eval", async () => {
    const vessel = await makeVessel();
    const deliverSpy = stubDriver(vessel);
    vessel.callerKindForTest = "do";
    vessel.callerIdForTest = await expectedEvalCaller();
    await vessel.onEvalComplete({
      runId: "inv-admission-lost",
      agentInvocationId: "call-admission-lost",
      result: {
        success: false,
        console: "",
        error: "Evaluated execution session is not active",
        failureKind: "infrastructure",
        failureCode: "eval_execution_admission_lost",
        errorData: {
          retry: {
            policy: "reobserve",
            commandIdPolicy: "use-new-after-reobserve",
          },
          recovery: {
            action: "reobserve",
            instruction:
              "Inspect current state, then issue a new eval for only unfinished work.",
          },
        },
      },
      channelId: CHANNEL,
    });

    expect(deliverSpy.mock.calls[0]![1]).toMatchObject({
      kind: "tool",
      isError: true,
      terminalOutcome: "infrastructure_error",
      terminalReasonCode: "eval_execution_admission_lost",
      failure: {
        kind: "infrastructure",
        retry: { policy: "reobserve" },
        recovery: { action: "reobserve" },
        causal: { invocationId: "call-admission-lost" },
      },
    });
  });

  it("is a no-op without a channelId or result (can't route the resume)", async () => {
    const vessel = await makeVessel();
    const deliverSpy = stubDriver(vessel);
    vessel.callerKindForTest = "server";
    await vessel.onEvalComplete({
      runId: "inv-79",
      result: { success: true, console: "" },
    });
    await vessel.onEvalComplete({ runId: "inv-79", channelId: CHANNEL });
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("refuses a foreign DO (only this agent's own EvalDO settles an eval)", async () => {
    const vessel = await makeVessel();
    const deliverSpy = stubDriver(vessel);
    vessel.callerKindForTest = "do";
    vessel.callerIdForTest = "do:vibestudio/internal:EvalDO:someoneelse";
    await expect(
      vessel.onEvalComplete({
        runId: "inv-80",
        result: { success: true, console: "" },
        channelId: CHANNEL,
      }),
    ).rejects.toThrow(/only this agent's own EvalDO/);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("deliverEffectOutcome accepts server + the agent's PubSubChannel DO, refuses other DOs", async () => {
    const vessel = await makeVessel();
    const deliverSpy = stubDriver(vessel);
    const outcome = { kind: "tool", result: "ok", isError: false } as never;

    vessel.callerKindForTest = "server";
    await vessel.deliverEffectOutcome("eff-1", outcome);
    vessel.callerKindForTest = "do";
    vessel.callerIdForTest = "do:workers/pubsub-channel:PubSubChannel:chan-1";
    await vessel.deliverEffectOutcome("eff-2", outcome, { channelId: CHANNEL });
    expect(deliverSpy).toHaveBeenCalledTimes(2);

    vessel.callerIdForTest =
      "do:workers/pubsub-channel:PubSubChannel:another-channel";
    await expect(
      vessel.deliverEffectOutcome("eff-wrong-channel", outcome, {
        channelId: CHANNEL,
      }),
    ).rejects.toThrow(/refusing caller/);

    vessel.callerIdForTest = "do:workers/forged-channel:PubSubChannel:chan-1";
    await expect(
      vessel.deliverEffectOutcome("eff-forged-source", outcome, {
        channelId: CHANNEL,
      }),
    ).rejects.toThrow(/refusing caller/);

    vessel.callerIdForTest = "do:agents/evil:EvilAgent:x"; // a foreign agent forging
    await expect(vessel.deliverEffectOutcome("eff-3", outcome)).rejects.toThrow(
      /refusing caller/,
    );
    expect(deliverSpy).toHaveBeenCalledTimes(2);
  });

  it("connectModelCredential resumes its pending credential wait atomically", async () => {
    const vessel = await makeVessel();
    vessel.credentialConnectForTest = async () => ({ id: "credential-1" });
    const deliverSpy = vi.fn(async () => true);
    const wakeSpy = vi.fn(async () => {});
    (vessel as unknown as { _driver: unknown })._driver = {
      deliverEffectOutcome: deliverSpy,
      wake: wakeSpy,
      connectSpecProvider: undefined,
    };
    vessel.callerKindForTest = "do";
    vessel.callerIdForTest = "do:workers/pubsub-channel:PubSubChannel:chan-1";

    await expect(
      vessel.onMethodCall(CHANNEL, "call-1", "connectModelCredential", {
        providerId: "openai-codex",
      }),
    ).resolves.toEqual({
      result: { credential: { id: "credential-1" }, resumed: true },
    });
    expect(deliverSpy).toHaveBeenCalledWith(
      ids.credentialWaitEffect(ids.credKey(CHANNEL, "openai-codex")),
      { kind: "credential", resolved: true },
      { channelId: CHANNEL },
    );
    expect(wakeSpy).toHaveBeenCalledWith(CHANNEL);

    deliverSpy.mockResolvedValueOnce(false);
    wakeSpy.mockClear();
    await expect(
      vessel.onMethodCall(CHANNEL, "call-2", "connectModelCredential", {
        providerId: "openai-codex",
      }),
    ).resolves.toEqual({
      result: { credential: { id: "credential-1" }, resumed: false },
    });
    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it("scopes direct provider calls and cancellation to the authenticated channel", async () => {
    const vessel = await makeVessel();
    vessel.credentialConnectForTest = async () => ({ id: "credential-1" });
    let release!: (value: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    (vessel as unknown as { _driver: unknown })._driver = {
      deliverEffectOutcome: vi.fn(() => gate),
      wake: vi.fn(async () => {}),
      connectSpecProvider: undefined,
    };
    vessel.callerKindForTest = "do";
    vessel.callerIdForTest = "do:workers/pubsub-channel:PubSubChannel:chan-1";
    const first = vessel.onMethodCall(
      "chan-1",
      "shared-transport",
      "connectModelCredential",
      {
        providerId: "openai-codex",
      },
    );
    await vi.waitFor(() =>
      expect(
        (
          vessel as unknown as {
            directMethodCalls: Map<string, AbortController>;
          }
        ).directMethodCalls.size,
      ).toBe(1),
    );

    vessel.callerIdForTest = "do:workers/pubsub-channel:PubSubChannel:chan-2";
    const second = vessel.onMethodCall(
      "chan-2",
      "shared-transport",
      "connectModelCredential",
      {
        providerId: "openai-codex",
      },
    );
    await vi.waitFor(() =>
      expect(
        (
          vessel as unknown as {
            directMethodCalls: Map<string, AbortController>;
          }
        ).directMethodCalls.size,
      ).toBe(2),
    );

    await vessel.cancelDirectMethodCall("chan-2", "shared-transport");
    const calls = (
      vessel as unknown as { directMethodCalls: Map<string, AbortController> }
    ).directMethodCalls;
    expect(calls.get("chan-1\u0000shared-transport")?.signal.aborted).toBe(
      false,
    );
    expect(calls.get("chan-2\u0000shared-transport")?.signal.aborted).toBe(
      true,
    );

    vessel.callerIdForTest = "do:workers/pubsub-channel:PubSubChannel:chan-1";
    await expect(
      vessel.cancelDirectMethodCall("chan-2", "shared-transport"),
    ).rejects.toThrow(/refusing caller/);
    release(true);
    await Promise.all([first, second]);
  });

  it("onAuthorityChanged refuses a non-server caller", async () => {
    const vessel = await makeVessel();
    vessel.callerKindForTest = "panel";
    await expect(vessel.onAuthorityChanged("acq-1")).rejects.toThrow(
      /server-only/,
    );
  });

  it("onAuthorityChanged nudges durable authority redrive for the host-owned vessel", async () => {
    const vessel = await makeVessel();
    vessel.callerKindForTest = "server";
    const nudge = vi
      .spyOn(vessel.driverForTest(), "nudgeAuthorityRedrive")
      .mockImplementation(() => undefined);

    await expect(vessel.onAuthorityChanged("acq-1")).resolves.toBeUndefined();
    expect(nudge).toHaveBeenCalledOnce();
  });
});

/** Vessel whose `rpc.call` is a recording stub, so we can drive `runDeferredEval` (the eval gate). */
class EvalGateProbe extends TestVessel {
  rpcCalls: Array<{ method: string; args: unknown[] }> = [];
  getRunStatus: { status: string; result?: unknown } = { status: "pending" };
  /** When set, `eval.get` REJECTS with this error (a transient store/RPC hiccup). */
  getRunError: Error | null = null;
  /** When set, `eval.start` REJECTS with this error (the kick-off itself failed). */
  startRunError: Error | null = null;
  /** When set, `eval.cancel` REJECTS with this error. */
  cancelError: Error | null = null;
  protected override get rpc(): RpcClient {
    return {
      call: async (_target: string, method: string, args: unknown[]) => {
        this.rpcCalls.push({ method, args });
        if (method === "eval.get") {
          if (this.getRunError) throw this.getRunError;
          return this.getRunStatus;
        }
        if (method === "eval.start" && this.startRunError)
          throw this.startRunError;
        if (method === "eval.cancel") {
          if (this.cancelError) throw this.cancelError;
          return { ok: true };
        }
        return {
          runId: (args[0] as { runId: string }).runId,
          status: "pending",
        };
      },
    } as unknown as RpcClient;
  }
  callGate(channelId: string, invocationId: string, args: unknown) {
    return this.runDeferredEval(
      channelId,
      invocationId,
      args,
      this.rpc as unknown as RpcClient,
    );
  }
  /** Drive a channel-callable agent method (cancelEval / pause / …) directly. */
  callAgentMethod(channelId: string, methodName: string, args: unknown) {
    return this.handleStandardAgentMethodCall(channelId, methodName, args);
  }
  /** Replace the lazily-built driver with a spy so `pause` doesn't boot the real
   *  driver (which needs a live gateway/control plane). */
  stubDriverForPause(): {
    interruptChannel: ReturnType<typeof vi.fn>;
  } {
    const interruptChannel = vi.fn(async () => {});
    (this as unknown as { _driver: unknown })._driver = {
      interruptChannel,
      deferredEvalRows: vi.fn(() => []),
    };
    return { interruptChannel };
  }

  seedTurnRecoveryForTest(wakeId = "turn-recovery:effect-1"): void {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO agent_wake_queue (
         wake_id, channel_id, wake_kind, payload_json, prerequisite_delivery_id,
         idempotency_key, attempts, next_attempt_at, lease_generation, created_at,
         disposition
       ) VALUES (?, ?, 'turn-recovery', '{}', NULL, ?, 0, ?, 0, ?, 'ready')`,
      wakeId,
      CHANNEL,
      wakeId,
      now,
      now,
    );
    this.markWorkReady("agent-wake");
  }

  stubDriverForRecovery(): { wake: ReturnType<typeof vi.fn> } {
    const wake = vi.fn(async () => {});
    (this as unknown as { _driver: unknown })._driver = { wake };
    return { wake };
  }
}

async function makeGateProbe(): Promise<EvalGateProbe> {
  const { instance } = await createTestDO(EvalGateProbe, TEST_AGENT_ENV);
  return instance;
}

describe("AgentVesselBase turn recovery", () => {
  it("drives and settles a durable terminal-cascade wake on a replacement activation", async () => {
    const probe = await makeGateProbe();
    probe.seedTurnRecoveryForTest();
    const { wake } = probe.stubDriverForRecovery();

    const [claim] = probe.claimReadyWork("agent-wake", {
      workerId: "replacement-worker",
      now: Date.now(),
      limit: 1,
    });
    expect(claim).toEqual(
      expect.objectContaining({ itemId: "turn-recovery:effect-1" }),
    );

    await expect(
      probe.executeWakeClaim({
        itemId: claim!.itemId,
        generation: claim!.generation,
      }),
    ).resolves.toEqual({ processed: true });
    expect(wake).toHaveBeenCalledWith(CHANNEL);
    expect(
      probe.settleReadyWork("agent-wake", {
        workerId: "replacement-worker",
        itemId: claim!.itemId,
        generation: claim!.generation,
        outcome: { executed: true },
      }),
    ).toBe("accepted");
    expect(
      probe.claimReadyWork("agent-wake", {
        workerId: "replacement-worker",
        now: Date.now(),
        limit: 1,
      }),
    ).toEqual([]);
  });
});

class SubagentSpawnProbe extends TestVessel {
  rpcCalls: Array<{ target: string; method: string; args: unknown[] }> = [];
  childSettings: Record<string, unknown> = {};
  readonly vcsResponses = new Map<string, unknown[]>();
  gadLogHead: Record<string, unknown> | null = null;
  failClaudeLaunch = false;
  failExternalReleaseCount = 0;
  failDestroyContextCount = 0;
  ownerRuntimeContextId = "ctx-1";
  readonly handleIncomingSpy = vi.fn(
    async (_channelId: string, _incoming: unknown) => {},
  );
  readonly wakeSpy = vi.fn(async (_channelId: string) => {});
  readonly activateChannelSpy = vi.fn((_channelId: string) => {});
  readonly dropLoopSpy = vi.fn((_channelId: string) => {});
  deferredPostTurnQueueForTest: Array<{
    metadata?: { supervisedTerminalRunId?: string };
  }> = [];
  protected override async ensurePromptArtifacts(): Promise<void> {}
  protected override get driver(): AgentLoopDriver {
    return {
      activateChannel: this.activateChannelSpy,
      wake: this.wakeSpy,
      abortChannel: vi.fn(async () => undefined),
      deliverEffectOutcome: vi.fn(async () => true),
      handleIncoming: this.handleIncomingSpy,
      deferredEvalRows: vi.fn(() => []),
      dropLoop: this.dropLoopSpy,
      foldCache: { delete: vi.fn() },
      outbox: { getForChannel: vi.fn(() => undefined) },
      channelCallMayMaterialize: vi.fn(async () => false),
      loop: vi.fn(async () => ({
        state: { deferredPostTurnQueue: this.deferredPostTurnQueueForTest },
      })),
    } as unknown as AgentLoopDriver;
  }
  protected override get rpc(): RpcClient {
    return {
      call: async (target: string, method: string, args: unknown[]) => {
        this.rpcCalls.push({ target, method, args });
        this.operationLog.push(`rpc:${target}:${method}`);
        const vcsResponses = this.vcsResponses.get(method);
        if (target === "main" && vcsResponses && vcsResponses.length > 0) {
          return vcsResponses.shift();
        }
        if (target === "main" && method === "vcs.status") {
          const contextId = String(
            (args[0] as { contextId?: unknown } | undefined)?.contextId ??
              "ctx-1",
          );
          const eventId = `event:${contextId}`;
          return semanticStatus(
            contextId,
            eventId,
            { kind: "event", eventId },
            true,
          );
        }
        if (target === "main" && method === "runtime.resolveContext") {
          return this.ownerRuntimeContextId;
        }
        if (target === "main" && method === "runtime.createSubagentContext") {
          return { contextId: "ctx-child" };
        }
        if (target === "main" && method === "runtime.destroyContext") {
          if (this.failDestroyContextCount > 0) {
            this.failDestroyContextCount -= 1;
            throw new Error("destroyContext boom");
          }
          return { destroyed: true };
        }
        if (target === "main" && method === "runtime.createEntity") {
          const spec = args[0] as {
            stateArgs?: { agentConfig?: Record<string, unknown> };
          };
          this.childSettings = { ...(spec.stateArgs?.agentConfig ?? {}) };
          return {
            id: "do:workers/agent-worker:AiChatWorker:subagent-inv-1",
            targetId: "do:workers/agent-worker:AiChatWorker:subagent-inv-1",
          };
        }
        if (method === "getAgentSettings" && target.includes(":subagent-")) {
          return this.childSettings;
        }
        if (target === "main" && method === "workers.resolveService") {
          return {
            kind: "durable-object",
            source: "vibestudio/internal",
            className: "GadWorkspaceDO",
            objectKey: "workspace-main",
            targetId: "gad",
          };
        }
        if (target === "gad" && method === "getLogHead") {
          return this.gadLogHead;
        }
        if (target === "gad" && method === "forkLog") {
          const input = args[0] as { atSeq?: number };
          return {
            forkSeq: input.atSeq ?? 0,
            forkHash: "fork-hash",
            inherited: 0,
          };
        }
        if (target === "main" && method === "extensions.invokeProvider") {
          const [provider, providerMethod] = args as [
            string,
            string,
            unknown[],
          ];
          if (
            provider === "claudeCode" &&
            providerMethod === "launchSubagent"
          ) {
            if (this.failClaudeLaunch) throw new Error("launchSubagent boom");
            return {
              entityId: "session:cc-1",
              contextId: "ctx-child",
              channelId: "task-inv-cc",
              vesselRef:
                "do:workers/linked-agent:LinkedAgentWorker:linked:session-cc-1",
              vesselEntityId:
                "do:workers/linked-agent:LinkedAgentWorker:linked:session-cc-1",
              vesselParticipantId: "participant-linked",
              launchId: "claude-code:inv-cc",
              generationId: "generation:cc-1",
              pid: 4242,
              logPath: "/state/agent-launch/session:cc-1/headless.log",
            };
          }
          if (provider === "claudeCode" && providerMethod === "release") {
            if (this.failExternalReleaseCount > 0) {
              this.failExternalReleaseCount -= 1;
              throw new Error("release boom");
            }
            return { released: true };
          }
          if (provider === "claudeCode" && providerMethod === "inspectLaunch") {
            return {
              entityId: "session:cc-1",
              generationId: "generation:cc-1",
              state: "running",
              pid: 4242,
              log: { bytes: 12, tail: "checking…", truncated: false },
            };
          }
        }
        if (target === "main" && method === "extensions.invoke") {
          const [ext, extMethod] = args as [string, string, unknown[]];
          if (
            ext === "@workspace-extensions/codex" &&
            extMethod === "launchSubagent"
          ) {
            return {
              entityId: "session:codex-1",
              contextId: "ctx-child",
              channelId: "task-inv-codex",
              vesselRef:
                "do:workers/linked-agent:LinkedAgentWorker:linked:session-codex-1",
              vesselEntityId:
                "do:workers/linked-agent:LinkedAgentWorker:linked:session-codex-1",
              vesselParticipantId: "participant-linked",
              launchId: "codex:inv-codex",
              generationId: "generation:codex-1",
              pid: 4242,
              logPath: "/state/agent-launch/session:codex-1/headless.log",
            };
          }
          if (
            ext === "@workspace-extensions/codex" &&
            extMethod === "release"
          ) {
            if (this.failExternalReleaseCount > 0) {
              this.failExternalReleaseCount -= 1;
              throw new Error("release boom");
            }
            return { released: true };
          }
        }
        return { ok: true, participantId: "participant-child" };
      },
    } as unknown as RpcClient;
  }
  async spawnForTest(channelId: string, invocationId: string, args: unknown) {
    return this.runDeferredSpawn(channelId, invocationId, args, this.rpc);
  }
  subagentRunForTest(runId: string) {
    return this.subagentRuns.get(runId);
  }
  seedSubagentStartedInParentChannelForTest(
    runId: string,
    options: { includeChildParticipantId?: boolean } = {},
  ) {
    this.channelStub.replay.set(CHANNEL, [
      {
        id: 1,
        messageId: `ik:subagent-started:${runId}`,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: {
          kind: "task.started",
          actor: { kind: "agent", id: AGENT_ID, displayName: "TestAgent" },
          causality: { taskId: runId, invocationId: runId },
          payload: {
            protocol: "agentic.trajectory.v1",
            taskType: "subagent",
            title: "recovered subagent",
            details: {
              subagent: {
                runId,
                mode: "fresh",
                taskChannelId: `task-${runId}`,
                contextId: `ctx-${runId}`,
                parentContextId: "ctx-1",
                childEntityId: `do:workers/agent-worker:AiChatWorker:subagent-${runId}`,
                ...(options.includeChildParticipantId === false
                  ? {}
                  : { childParticipantId: "participant-child" }),
                label: "recovered subagent",
              },
            },
          },
          createdAt: new Date().toISOString(),
        } as unknown as AgenticEvent,
        senderId: AGENT_ID,
        ts: Date.now(),
      },
    ]);
  }
  insertSubagentRunForTest(row: {
    runId: string;
    status: "starting" | "running";
    lastActivityAt?: number;
  }) {
    const now = Date.now();
    this.subagentRuns.insert({
      runId: row.runId,
      taskChannelId: `task-${row.runId}`,
      parentContextId: "ctx-1",
      childContextId: `ctx-${row.runId}-stale`,
      childEntityId: `do:workers/agent-worker:AiChatWorker:subagent-${row.runId}`,
      childParticipantId: "participant-child",
      parentChannelId: CHANNEL,
      mode: "fresh",
      label: "stale subagent",
      depth: 1,
      status: row.status,
      sourceEventId: null,
      semanticIntegrationSnapshot: null,
      startedAt: now,
      lastActivityAt: row.lastActivityAt ?? now,
      agentKind: "pi",
      launchConfig: null,
      externalSessionEntityId: null,
      externalGenerationId: null,
    });
  }
  async inspectSubagentForTest(
    runId: string,
    query: string,
    parentChannelId = CHANNEL,
  ) {
    return this.inspectSubagent(runId, query, parentChannelId);
  }
  async mergeSubagentForTest(
    runId: string,
    parentChannelId = CHANNEL,
    intent?: string,
  ) {
    return this.mergeSubagent(runId, parentChannelId, [], intent);
  }
  respondToVcs(method: string, ...responses: unknown[]) {
    this.vcsResponses.set(`vcs.${method}`, [...responses]);
  }
  async readSubagentForTest(
    runId: string,
    afterSeq: number,
    parentChannelId = CHANNEL,
  ) {
    return this.readSubagent(runId, afterSeq, parentChannelId);
  }
  async sendToSubagentForTest(
    runId: string,
    message: string,
    parentChannelId = CHANNEL,
  ) {
    return this.sendToSubagent("send-test", runId, message, parentChannelId);
  }
  async cancelSubagentForTest(runId: string, reason = "cancelled by test") {
    return this.cancelSubagent(runId, reason, CHANNEL);
  }
  async settleSubagentForTest(
    runId: string,
    outcome: "completed" | "failed" | "cancelled" | "abandoned",
    text: string,
  ) {
    const run = this.subagentRuns.get(runId);
    if (!run) throw new Error(`missing run ${runId}`);
    return this.settleSubagentTerminal(run, outcome, text);
  }
  async completeSubagentForTest(
    runId: string,
    report: string,
    outcome: "success" | "failed",
  ) {
    const run = this.subagentRuns.get(runId);
    if (!run) throw new Error(`missing run ${runId}`);
    if (!run.childParticipantId) {
      throw new Error(`run ${runId} has no child participant identity`);
    }
    const terminal = outcome === "success" ? "completed" : "failed";
    await this.processChannelEvent(run.taskChannelId, {
      id: Date.now(),
      messageId: `subagent-terminal:${runId}:${terminal}`,
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      senderId: run.childParticipantId,
      senderMetadata: { type: "agent" },
      payload: {
        kind: outcome === "success" ? "task.completed" : "task.failed",
        actor: {
          kind: "agent",
          id: run.childParticipantId,
        },
        causality: { taskId: runId, invocationId: runId },
        payload:
          outcome === "success"
            ? {
                protocol: AGENTIC_PROTOCOL_VERSION,
                terminalOutcome: "success",
                summary: report,
                result: {
                  protocolContent: [{ type: "text", text: report }],
                  details: { runId, outcome: "success" },
                },
              }
            : {
                protocol: AGENTIC_PROTOCOL_VERSION,
                terminalOutcome: "tool_error",
                reason: report,
                details: { runId, outcome: "failed" },
              },
        createdAt: new Date().toISOString(),
      },
      ts: Date.now(),
    } as ChannelEvent);
  }
  async completeOwnRunForTest(report: string, outcome: "success" | "failed") {
    return this.completeAsSubagent(report, outcome);
  }
  async closeOwnTurnForTest(input: {
    finalMessage?: string;
    reason?: string;
    summary?: string;
    effectFailures?: Array<{
      invocationId: string;
      name: string;
      outcome: "tool_error";
      code: string;
      message: string;
    }>;
  }) {
    await this.onTurnClosed({
      channelId: "task-child-run-1",
      turnId: "turn-child-1",
      metadata: { origin: "agent-initiated" },
      effectFailures: input.effectFailures ?? [],
      ...input,
    });
  }
  ownTerminalWakeForTest() {
    const row = this.sql
      .exec(
        `SELECT payload_json, disposition
           FROM agent_wake_queue
          WHERE wake_id = ?`,
        "subagent-terminal-publish:child-run-1",
      )
      .toArray()[0];
    return row
      ? {
          payload: JSON.parse(String(row["payload_json"])),
          disposition: String(row["disposition"]),
        }
      : null;
  }
  async guardBackgroundSuspensionForTest(channelId = CHANNEL) {
    return this.guardBackgroundSuspension(channelId);
  }
  systemPromptForTest(channelId = CHANNEL) {
    return this.composePrompt(channelId);
  }
  setSubagentSourceForTest(runId: string, sourceEventId: string) {
    this.subagentRuns.setSourceEventId(runId, sourceEventId);
  }
  clearSubagentParticipantForTest(runId: string) {
    this.sql.exec(
      `UPDATE subagent_runs SET child_participant_id = NULL WHERE run_id = ?`,
      runId,
    );
  }
}

async function makeSubagentSpawnProbe(
  config?: unknown,
): Promise<SubagentSpawnProbe> {
  const { instance } = await createTestDO(SubagentSpawnProbe, TEST_AGENT_ENV);
  await instance.registerSubscriptionForTest(CHANNEL, config);
  return instance;
}

async function makeChildCompletionProbe(): Promise<SubagentSpawnProbe> {
  const { instance } = await createTestDO(SubagentSpawnProbe, {
    ...TEST_AGENT_ENV,
    STATE_ARGS: {
      subagent: {
        runId: "child-run-1",
        task: "review the design",
        parentRef: "participant-parent",
        parentChannelId: CHANNEL,
        taskChannelId: "task-child-run-1",
        parentContextId: "ctx-parent",
        parentParticipantId: "participant-parent",
        depth: 1,
        mode: "fresh",
      },
    },
  });
  await instance.registerSubscriptionForTest("task-child-run-1");
  return instance;
}

function semanticStatus(
  contextId: string,
  committedEventId: string,
  workingHead:
    | { kind: "event"; eventId: string }
    | { kind: "application"; applicationId: string },
  clean: boolean,
  integrating: VcsStatusResult["integrating"] = [],
) {
  return {
    contextId,
    committed: { kind: "event" as const, eventId: committedEventId },
    workingHead,
    clean,
    mainEventId: "event:main",
    mainRelation: "ahead" as const,
    workingCounts: {
      applications: clean ? 0 : 1,
      workUnits: clean ? 0 : 1,
      changes: clean ? 0 : 1,
    },
    integrating,
  };
}

function semanticComparison(
  target:
    | { kind: "event"; eventId: string }
    | { kind: "application"; applicationId: string },
  sourceEventId: string,
  coordinates: Array<{ id: string; status: "adopt" | "conflict" }>,
  concluded = coordinates.length === 0,
): VcsCompareResult {
  const conflict = coordinates.filter(
    (coordinate) => coordinate.status === "conflict",
  ).length;
  const adopt = coordinates.length - conflict;
  return {
    target,
    source: { kind: "event" as const, eventId: sourceEventId },
    base: { kind: "event" as const, eventId: "event:base" },
    resolution: {
      complete: coordinates.length === 0,
      remainingCoordinateCount: coordinates.length,
      concluded,
    },
    counts: { adopt, convergent: 0, composed: 0, conflict, resolved: 0 },
    intentCounts: {
      merged: 0,
      settled: 0,
      split: 0,
      contested: conflict,
      pending: adopt,
    },
    coordinates: coordinates.map((entry) => ({
      coordinate: {
        kind: "file" as const,
        id: entry.id,
        paths: { theirs: `${entry.id}.ts` },
      },
      status: entry.status,
      aspects: [
        {
          aspect: "content" as const,
          base: null,
          ours: null,
          theirs: entry.id,
          status: entry.status,
        },
      ],
      attribution: {
        ours: [],
        theirs: [
          { changeId: `change:${entry.id}`, workUnitId: `work:${entry.id}` },
        ],
      },
      resolutions: ["theirs", "ours", "current"],
      summary: entry.id,
    })),
    intents: [],
    intentsTruncated: false,
    nextCursor: null,
  };
}

describe("AgentVesselBase.runDeferredEval (the agent's eval-tool deferral gate)", () => {
  it("kicks off eval.start with a distinct deterministic effect id and defers while pending", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = { status: "pending" };

    const out = await probe.callGate(CHANNEL, "inv-1", { code: "1+1" });

    expect(out).toEqual({ deferred: true, reason: "external-result" });
    const start = probe.rpcCalls.find((c) => c.method === "eval.start");
    expect(start?.args[0]).toMatchObject({
      runId: ids.invocationEffect("inv-1"),
      scope: { key: CHANNEL },
      source: { kind: "inline", code: "1+1" },
      resultReceiver: { kind: "caller" },
    });
    expect(start?.args[0]).not.toHaveProperty("timeoutMs");
    // The poll backstop check happened even on the first dispatch.
    expect(probe.rpcCalls.some((c) => c.method === "eval.get")).toBe(true);
    expect(
      probe.channelStub.published.find(
        (entry) =>
          entry.idempotencyKey ===
          `eval-pending:${ids.invocationEffect("inv-1")}`,
      ),
    ).toMatchObject({
      event: {
        kind: "invocation.progress",
        causality: { invocationId: "inv-1" },
        payload: {
          message: expect.stringContaining("pending. Do not retry"),
          data: {
            eval: {
              runId: ids.invocationEffect("inv-1"),
              state: "running",
              retryDirective: "do_not_retry",
            },
          },
        },
      },
    });
  });

  it("cancels a parked eval when its owning channel is being retired", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = { status: "running" };

    await expect(
      probe.callGate(CHANNEL, "inv-retire", { code: "await wait()" }),
    ).resolves.toEqual({
      deferred: true,
      reason: "external-result",
    });
    expect((probe as any).deferredEvalRuns.get(CHANNEL)).toEqual(
      new Set([ids.invocationEffect("inv-retire")]),
    );

    await (probe as any).cancelDeferredEvalRuns(CHANNEL);

    expect(probe.rpcCalls).toContainEqual({
      method: "eval.cancel",
      args: [
        {
          scopeKey: CHANNEL,
          runId: ids.invocationEffect("inv-retire"),
        },
      ],
    });
    expect((probe as any).deferredEvalRuns.has(CHANNEL)).toBe(false);
  });

  it("records a durable cancel intent and PROCEEDS when EvalDO is unavailable (unsubscribe must not deadlock)", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = { status: "running" };
    await probe.callGate(CHANNEL, "inv-retry", { code: "await wait()" });
    probe.cancelError = new Error("eval cancellation unavailable");

    // NEVER throws: the outage class this hardens against must not block
    // channel retirement. The cancel obligation survives as a durable intent.
    await expect(
      (probe as any).cancelDeferredEvalRuns(CHANNEL),
    ).resolves.toBeUndefined();
    const intents = (probe as any).sql
      .exec(`SELECT channel_id, run_id FROM deferred_eval_cancel_intents`)
      .toArray();
    expect(intents).toEqual([
      { channel_id: CHANNEL, run_id: ids.invocationEffect("inv-retry") },
    ]);

    // A later lifecycle drain (resume / backstop alarm) redrives the cancel;
    // the intent is deleted only on an acknowledged eval.cancel. Idempotent.
    probe.cancelError = null;
    await (probe as any).drainEvalCancelIntents();
    expect(
      (probe as any).sql
        .exec(`SELECT count(*) AS n FROM deferred_eval_cancel_intents`)
        .toArray(),
    ).toEqual([{ n: 0 }]);
    expect(
      probe.rpcCalls.filter((call) => call.method === "eval.cancel"),
    ).toEqual([
      {
        method: "eval.cancel",
        args: [{ scopeKey: CHANNEL, runId: ids.invocationEffect("inv-retry") }],
      },
      {
        method: "eval.cancel",
        args: [{ scopeKey: CHANNEL, runId: ids.invocationEffect("inv-retry") }],
      },
    ]);
  });

  it("enumerates the cancel set from durable outbox rows, not the heap cache (generation change window)", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = { status: "running" };
    await probe.callGate(CHANNEL, "inv-durable", { code: "await wait()" });
    // Simulate the post-generation-change window: the in-memory run map is
    // empty, but the parked local_tool:eval outbox row still names the run.
    (probe as any).deferredEvalRuns.clear();
    const runId = ids.invocationEffect("inv-durable");
    probe.driverForTest().outbox.insert(
      logIdForChannel(CHANNEL),
      {
        kind: "local_tool",
        effectId: runId,
        channelId: CHANNEL,
        idempotencyKey: "inv-durable",
        invocationId: "inv-durable",
        turnId: "turn:durable",
        invocationSeq: 1,
        executionMode: "parallel",
        tool: "eval",
        args: {},
      } as never,
      null,
    );

    await (probe as any).cancelDeferredEvalRuns(CHANNEL);

    expect(probe.rpcCalls).toContainEqual({
      method: "eval.cancel",
      args: [{ scopeKey: CHANNEL, runId }],
    });
  });

  it("completes INLINE when getRun already reports done (the lost-push poll backstop)", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = {
      status: "done",
      result: { success: true, console: "out", returnValue: 5 },
    };

    const out = await probe.callGate(CHANNEL, "inv-2", { code: "5" });

    expect((out as { deferred?: boolean }).deferred).toBeUndefined();
    expect(out).toMatchObject({ isError: false });
    expect((out as { result: { details: unknown } }).result).toMatchObject({
      details: { success: true },
    });
  });

  it("reports an inline failed eval as a tool failure", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = {
      status: "done",
      result: { success: false, console: "", error: "boom" },
    };

    await expect(
      probe.callGate(CHANNEL, "inv-failed", {
        code: "throw new Error('boom')",
      }),
    ).resolves.toMatchObject({
      isError: true,
      result: { details: { success: false, error: "boom" } },
    });
  });

  it("reports an inline infrastructure failure as terminal", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = {
      status: "done",
      result: {
        success: false,
        console: "",
        error: "link failed",
        failureKind: "infrastructure",
        failureCode: "package_load_failed",
      },
    };

    await expect(
      probe.callGate(CHANNEL, "inv-infra", { code: "import('broken')" }),
    ).resolves.toMatchObject({
      isError: true,
      terminalOutcome: "infrastructure_error",
    });
  });

  it("returns a terminal error when getRun reports cancelled (reset)", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = { status: "cancelled" };
    const out = await probe.callGate(CHANNEL, "inv-3", { code: "x" });
    expect(out).toMatchObject({
      isError: true,
      result: { details: { failureKind: "cancelled" } },
    });
  });

  it("uses path as an inline source hint and rejects only a missing source", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = { status: "pending" };
    await expect(
      probe.callGate(CHANNEL, "inv-4", {
        code: "x",
        path: "meta",
        sourcePath: "src/probe.ts",
      }),
    ).resolves.toEqual({ deferred: true, reason: "external-result" });
    expect(
      probe.rpcCalls.find((call) => call.method === "eval.start")?.args[0],
    ).toMatchObject({
      source: { kind: "inline", code: "x", pathHint: "src/probe.ts" },
    });

    const missing = await probe.callGate(CHANNEL, "inv-missing", {});
    expect(missing).toMatchObject({ isError: true });
  });

  it("treats an empty path emitted beside inline code as omitted", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = { status: "pending" };
    await expect(
      probe.callGate(CHANNEL, "inv-empty-path", { code: "1+1", path: "" }),
    ).resolves.toEqual({ deferred: true, reason: "external-result" });
    expect(
      probe.rpcCalls.find((call) => call.method === "eval.start")?.args[0],
    ).toMatchObject({
      source: { kind: "inline", code: "1+1", pathHint: undefined },
    });
  });

  it("threads an atomic reset flag into the deferred eval start", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = { status: "pending" };

    await expect(
      probe.callGate(CHANNEL, "inv-reset", {
        reset: true,
        code: "return Object.keys(scope)",
      }),
    ).resolves.toEqual({ deferred: true, reason: "external-result" });

    expect(
      probe.rpcCalls.find((call) => call.method === "eval.start")?.args[0],
    ).toMatchObject({
      runId: ids.invocationEffect("inv-reset"),
      reset: true,
      source: { kind: "inline", code: "return Object.keys(scope)" },
    });
  });

  it("threads an explicit eval deadline into the deferred eval start", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = { status: "pending" };

    await expect(
      probe.callGate(CHANNEL, "inv-timeout", {
        code: "await new Promise(() => {})",
        timeoutMs: 250,
      }),
    ).resolves.toEqual({ deferred: true, reason: "external-result" });

    expect(
      probe.rpcCalls.find((call) => call.method === "eval.start")?.args[0],
    ).toMatchObject({
      runId: ids.invocationEffect("inv-timeout"),
      timeoutMs: 250,
    });
  });

  it("rejects misplaced eval options before starting a deferred run", async () => {
    const probe = await makeGateProbe();

    await expect(
      probe.callGate(CHANNEL, "inv-bad-timeout", {
        code: "return 1",
        authority: { effects: "read-write", timeoutMs: 250 },
      }),
    ).rejects.toMatchObject({
      code: "invalid_tool_arguments",
      message: expect.stringContaining("/authority/timeoutMs"),
    });
    expect(probe.rpcCalls.some((call) => call.method === "eval.start")).toBe(
      false,
    );
  });

  it("settles invalid cross-field authority before fencing a deferred run", async () => {
    const probe = await makeGateProbe();

    await expect(
      probe.callGate(CHANNEL, "inv-bad-authority", {
        code: "return 1",
        authority: {
          effects: "read-write",
          approvals: "pregranted-only",
          preauthorize: [{ service: "missions", method: "create", args: [{}] }],
        },
      }),
    ).resolves.toMatchObject({
      isError: true,
      result: expect.stringContaining(
        "preauthorize is valid only when authority.approvals is prompt",
      ),
    });
    expect(probe.rpcCalls.some((call) => call.method === "eval.start")).toBe(
      false,
    );
    expect(probe.rpcCalls.some((call) => call.method === "eval.get")).toBe(
      false,
    );
  });

  it("F4: PARKS (deferred) when the getRun poll throws AFTER startRun succeeded — never a spurious error", async () => {
    // The run is already in flight server-side (startRun returned). A transient getRun hiccup must
    // NOT surface as the tool result (that would settle the invocation with a fake error AND drop the
    // real eval result when the held run later completes). It parks for the push / deferRedrive.
    const probe = await makeGateProbe();
    probe.getRunError = new Error("transient store load failed");

    const out = await probe.callGate(CHANNEL, "inv-park", { code: "1+1" });

    // Parked, not errored.
    expect(out).toEqual({ deferred: true, reason: "external-result" });
    expect((out as { isError?: boolean }).isError).toBeUndefined();
    // startRun still kicked off the run (so the result can arrive out-of-band).
    expect(
      probe.rpcCalls.find((c) => c.method === "eval.start")?.args[0],
    ).toMatchObject({
      runId: ids.invocationEffect("inv-park"),
    });
    // The poll WAS attempted (and threw).
    expect(probe.rpcCalls.some((c) => c.method === "eval.get")).toBe(true);
  });

  it("surfaces a definitive eval.start rejection without misclassifying it as generation loss", async () => {
    const probe = await makeGateProbe();
    probe.startRunError = new RemoteRpcError(
      "[workerdInspector.getEndpoint] Invalid args: expected string",
      "service",
    );
    probe.getRunStatus = { status: "unknown" };

    await expect(
      probe.callGate(CHANNEL, "inv-rejected", { code: "1+1" }),
    ).resolves.toMatchObject({
      isError: true,
      result: {
        details: {
          success: false,
          error: expect.stringContaining("Invalid args"),
        },
      },
    });
    expect(
      probe.rpcCalls.filter((call) => call.method === "eval.start"),
    ).toHaveLength(1);
    expect(probe.rpcCalls.some((call) => call.method === "eval.get")).toBe(
      false,
    );
  });

  it("F4: treats a rejected startRun response as ambiguous and never dispatches twice", async () => {
    const probe = await makeGateProbe();
    probe.seedDeferredEvalForTest(ids.invocationEffect("inv-ambiguous"), false);
    probe.startRunError = new Error(
      "response lost after EvalDO accepted the run",
    );
    probe.getRunStatus = { status: "running" };

    await expect(
      probe.callGate(CHANNEL, "inv-ambiguous", { code: "1+1" }),
    ).resolves.toEqual({
      deferred: true,
      reason: "external-result",
    });
    expect(
      probe
        .driverForTest()
        .hasDeferredEvalStartAttempted(
          CHANNEL,
          ids.invocationEffect("inv-ambiguous"),
        ),
    ).toBe(true);
    probe.startRunError = null;
    await expect(
      probe.callGate(CHANNEL, "inv-ambiguous", { code: "1+1" }),
    ).resolves.toEqual({
      deferred: true,
      reason: "external-result",
    });

    expect(
      probe.rpcCalls.filter((call) => call.method === "eval.start"),
    ).toHaveLength(1);
    expect(
      probe.rpcCalls.filter((call) => call.method === "eval.get"),
    ).toHaveLength(2);
  });

  it("parks an ambiguously acknowledged start while host admission reconciliation is pending", async () => {
    const probe = await makeGateProbe();
    probe.seedDeferredEvalForTest(
      ids.invocationEffect("inv-admission-race"),
      false,
    );
    probe.startRunError = new Error(
      "response lost before admission was observable",
    );
    probe.getRunStatus = { status: "unknown" };

    await expect(
      probe.callGate(CHANNEL, "inv-admission-race", { code: "1+1" }),
    ).resolves.toEqual({
      deferred: true,
      reason: "external-result",
    });
    expect(
      probe.rpcCalls.filter((call) => call.method === "eval.start"),
    ).toHaveLength(1);
    expect(
      probe.rpcCalls.filter((call) => call.method === "eval.get"),
    ).toHaveLength(1);
  });
});

describe("AgentVesselBase.runDeferredSpawn", () => {
  it("turns a subagent's natural final answer into a durable terminal intent", async () => {
    const probe = await makeChildCompletionProbe();

    await probe.closeOwnTurnForTest({
      finalMessage: "Five concise design bullets.",
    });

    expect(probe.ownTerminalWakeForTest()).toMatchObject({
      disposition: "ready",
      payload: {
        runId: "child-run-1",
        taskChannelId: "task-child-run-1",
        parentRef: "participant-parent",
        report: "Five concise design bullets.",
        outcome: "completed",
      },
    });
  });

  it("reports the primary tool failure instead of a generic turn reason", async () => {
    const probe = await makeChildCompletionProbe();

    await probe.closeOwnTurnForTest({
      reason: "work_failed",
      summary: "work failed",
      effectFailures: [
        {
          invocationId: "call-read",
          name: "read",
          outcome: "tool_error",
          code: "EACCES",
          message: "Causal parent does not match the presenter's host-bound trajectory",
        },
      ],
    });

    expect(probe.ownTerminalWakeForTest()).toMatchObject({
      payload: {
        report:
          "read failed (EACCES): Causal parent does not match the presenter's host-bound trajectory",
        outcome: "failed",
      },
    });
  });

  it("terminates the child model loop after recording its durable completion", async () => {
    const probe = await makeChildCompletionProbe();

    await expect(
      probe.completeOwnRunForTest("Five concise design bullets.", "success"),
    ).resolves.toMatchObject({
      terminate: true,
      details: { runId: "child-run-1", outcome: "success" },
    });
  });

  it("inherits the parent's effective Pi model, unattended settings, and system prompt", async () => {
    const probe = await makeSubagentSpawnProbe({
      systemPrompt: "system-test-parent-prompt",
      systemPromptMode: "append",
    });
    probe.callerIdForTest = await expectedEvalCaller();
    await probe.chatOp(CHANNEL, "configureAgent", [
      {
        model: "openai-codex:gpt-5.3-codex-spark",
        thinkingLevel: "high",
        fallbackModel: "anthropic:claude-sonnet-4-6",
        fallbackThinkingLevel: "minimal",
        fallbackOn: ["usage_limit_terminal"],
        fallbackScope: "all-turns",
        approvalLevel: 2,
      },
    ]);

    const out = await probe.spawnForTest(CHANNEL, "inv-inherit", {
      mode: "fresh",
      task: "exercise the inherited child configuration",
    });

    expect(out).toMatchObject({ isError: false });
    const create = probe.rpcCalls.find(
      (call) =>
        call.target === "main" && call.method === "runtime.createEntity",
    );
    expect(create?.args[0]).toMatchObject({
      stateArgs: {
        agentConfig: {
          model: "openai-codex:gpt-5.3-codex-spark",
          thinkingLevel: "high",
          fallbackModel: "anthropic:claude-sonnet-4-6",
          fallbackThinkingLevel: "minimal",
          fallbackOn: ["usage_limit_terminal"],
          fallbackScope: "all-turns",
          approvalLevel: 2,
          systemPrompt: "system-test-parent-prompt",
          systemPromptMode: "append",
        },
      },
    });
  });

  it("lets explicit Pi child config override inherited approval behavior", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.callerIdForTest = await expectedEvalCaller();
    await probe.chatOp(CHANNEL, "configureAgent", [
      { model: "openai-codex:gpt-5.3-codex-spark", approvalLevel: 2 },
    ]);

    const out = await probe.spawnForTest(CHANNEL, "inv-override", {
      mode: "fresh",
      task: "exercise an explicit child override",
      config: { model: "openai-codex:gpt-5.3-codex-spark", approvalLevel: 1 },
    });

    expect(out).toMatchObject({
      isError: false,
      result: {
        details: {
          launchConfig: {
            model: "openai-codex:gpt-5.3-codex-spark",
            approvalLevel: 1,
          },
        },
      },
    });
    const create = probe.rpcCalls.find(
      (call) =>
        call.target === "main" && call.method === "runtime.createEntity",
    );
    expect(create?.args[0]).toMatchObject({
      stateArgs: {
        agentConfig: {
          model: "openai-codex:gpt-5.3-codex-spark",
          approvalLevel: 1,
        },
      },
    });
  });

  it("rejects an unavailable Pi model before creating child lifecycle state", async () => {
    const probe = await makeSubagentSpawnProbe();

    const out = await probe.spawnForTest(CHANNEL, "inv-invalid-model", {
      mode: "fresh",
      task: "exercise invalid child model admission",
      config: { model: "pi" },
    });

    expect(out).toEqual({
      result:
        'Agent model "pi" could not be materialized; select a model present in the current catalog before starting the agent',
      isError: true,
    });
    expect(
      probe.rpcCalls.some(
        (call) =>
          call.target === "main" &&
          (call.method === "runtime.createSubagentContext" ||
            call.method === "runtime.createEntity" ||
            call.method === "runtime.destroyContext"),
      ),
    ).toBe(false);
  });

  ledgerTest("execution.agent-spawn", async () => {
    const probe = await makeSubagentSpawnProbe();

    await probe.spawnForTest(CHANNEL, "inv-source-identity", {
      mode: "fresh",
      task: "exercise child runtime identity",
      // Legacy or malformed arguments must not turn an edited package into
      // executable agent code.
      source: "packages/disposable-task",
    });

    const create = probe.rpcCalls.find(
      (call) =>
        call.target === "main" && call.method === "runtime.createEntity",
    );
    expect(create?.args[0]).toMatchObject({
      execution: { surface: "code", source: "workers/test" },
    });
  });

  it("requires one durable task for forked children too", async () => {
    const probe = await makeSubagentSpawnProbe();

    const out = await probe.spawnForTest(CHANNEL, "inv-missing-task", {
      mode: "fork",
    });

    expect(out).toEqual({
      result: "spawn_subagent requires a non-empty durable task",
      isError: true,
    });
    expect(
      probe.rpcCalls.some(
        (call) =>
          call.target === "main" &&
          call.method === "runtime.createSubagentContext",
      ),
    ).toBe(false);
  });

  it("reuses an existing child trajectory fork point when a forked spawn is retried", async () => {
    const probe = await makeSubagentSpawnProbe();
    const parentLogId = logIdForChannel(CHANNEL);
    const taskChannelId = "task-inv-1";
    const childLogId = logIdForChannel(taskChannelId);
    probe.gadLogHead = {
      logId: childLogId,
      head: childLogId,
      logKind: "trajectory",
      seq: 12,
      hash: "child-head",
      envelopeId: null,
      parentLogId,
      parentHead: parentLogId,
      forkSeq: 7,
      forkHash: "parent-seq-7",
    };

    await probe.initFromTrajectoryFork({
      parentLogId,
      seq: 99,
      taskChannelId,
      contextId: "ctx-child",
    });

    const forkCall = probe.rpcCalls.find(
      (call) => call.target === "gad" && call.method === "forkLog",
    );
    expect(forkCall?.args[0]).toMatchObject({
      fromLogId: parentLogId,
      fromHead: parentLogId,
      toLogId: childLogId,
      toHead: childLogId,
      atSeq: 7,
    });
    expect(probe.wakeSpy).toHaveBeenCalledWith(taskChannelId);
  });

  it("creates the task trajectory fork before initializing the child or subscribing the supervisor", async () => {
    const probe = await makeSubagentSpawnProbe();

    const out = await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fork",
      task: "start the forked child",
    });

    expect(out).toMatchObject({ isError: false });
    const forkIndex = probe.operationLog.findIndex(
      (entry) => entry === "rpc:gad:forkLog",
    );
    const initIndex = probe.operationLog.findIndex((entry) =>
      entry.includes(":initFromTrajectoryFork"),
    );
    const supervisorSubscribeIndex = probe.operationLog.findIndex(
      (entry) => entry === "channel:task-inv-1:join",
    );
    expect(forkIndex).toBeGreaterThanOrEqual(0);
    expect(initIndex).toBeGreaterThanOrEqual(0);
    expect(supervisorSubscribeIndex).toBeGreaterThanOrEqual(0);
    expect(forkIndex).toBeLessThan(initIndex);
    expect(initIndex).toBeLessThan(supervisorSubscribeIndex);
    const create = probe.rpcCalls.find(
      (call) =>
        call.target === "main" && call.method === "runtime.createEntity",
    );
    expect(create?.args[0]).toMatchObject({
      stateArgs: {
        subagent: {
          mode: "fork",
          parentParticipantId: AGENT_ID,
          lineageParticipantIds: [AGENT_ID],
        },
      },
    });
    expect(probe.activateChannelSpy).not.toHaveBeenCalledWith("task-inv-1");
    expect(probe.dropLoopSpy).toHaveBeenCalledWith("task-inv-1");
    const seed = probe.channelStub.published.find(
      (published) => published.idempotencyKey === "subagent-seed:inv-1",
    );
    expect(seed?.event).toMatchObject({
      payload: {
        blocks: [
          {
            type: "text",
            content: expect.stringContaining("## Fork Assignment Boundary"),
          },
        ],
      },
    });
    expect(JSON.stringify(seed?.event)).toContain(
      "inherited parent trajectory is reference context only",
    );
    expect(JSON.stringify(seed?.event)).toContain(
      "<assigned_task>\\nstart the forked child\\n</assigned_task>",
    );

    probe.wakeSpy.mockClear();
    await probe.adoptDurableWorkWorker("worker-generation-1");
    expect(probe.wakeSpy).toHaveBeenCalledWith(CHANNEL);
    expect(probe.wakeSpy).not.toHaveBeenCalledWith("task-inv-1");
  });

  it("fails before context creation when the owner entity and channel subscription contexts diverge", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.ownerRuntimeContextId = "ctx-original";

    const out = await probe.spawnForTest(CHANNEL, "inv-ctx-mismatch", {
      mode: "fork",
      task: "start the forked child",
    });

    expect(out).toMatchObject({
      isError: true,
      result: expect.stringContaining(
        "spawn_subagent context mismatch: owner do:workers/test:TestAgent:agent-key is registered in ctx-original, but channel chan-1 is subscribed as ctx-1",
      ),
    });
    expect(
      probe.rpcCalls.some(
        (call) =>
          call.target === "main" &&
          call.method === "runtime.createSubagentContext",
      ),
    ).toBe(false);
  });

  it("fails a forked spawn before child init when the task trajectory has different lineage", async () => {
    const probe = await makeSubagentSpawnProbe();
    const childLogId = logIdForChannel("task-inv-1");
    probe.gadLogHead = {
      logId: childLogId,
      head: childLogId,
      logKind: "trajectory",
      seq: 0,
      hash: "root-head",
      envelopeId: null,
      parentLogId: null,
      parentHead: null,
      forkSeq: null,
      forkHash: null,
    };

    const out = await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fork",
      task: "start the forked child",
    });

    expect(out).toMatchObject({
      isError: true,
      result: `subagent task trajectory already exists with different fork lineage: ${childLogId}:${childLogId}`,
    });
    expect(
      probe.operationLog.some((entry) =>
        entry.includes(":initFromTrajectoryFork"),
      ),
    ).toBe(false);
    expect(
      probe.rpcCalls.some(
        (call) =>
          call.target === "main" &&
          call.method === "runtime.destroyContext" &&
          JSON.stringify(call.args).includes("ctx-child"),
      ),
    ).toBe(true);
  });

  it("launches the child and returns a run handle immediately instead of parking the tool call", async () => {
    const probe = await makeSubagentSpawnProbe();

    const out = await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      label: "background audit",
      task: "audit this in the child",
    });

    expect((out as { deferred?: boolean }).deferred).toBeUndefined();
    expect(out).toMatchObject({
      isError: false,
      result: {
        details: {
          runId: "inv-1",
          mode: "fresh",
          label: "background audit",
          taskChannelId: "task-inv-1",
          contextId: "ctx-child",
          status: "running",
        },
      },
    });
    expect(probe.subagentRunForTest("inv-1")).toMatchObject({
      runId: "inv-1",
      status: "running",
      taskChannelId: "task-inv-1",
      childContextId: "ctx-child",
    });
    expect(
      probe.rpcCalls.some((call) => call.method === "runtime.createEntity"),
    ).toBe(true);
    const started = probe.channelStub.published.find(
      (p) => p.idempotencyKey === "subagent-started:inv-1",
    );
    expect(started?.event).toMatchObject({
      kind: "task.started",
      payload: {
        details: {
          subagent: { childParticipantId: "participant-child" },
        },
      },
    });
    const startedIndex = probe.channelStub.published.findIndex(
      (p) => p.idempotencyKey === "subagent-started:inv-1",
    );
    const seedIndex = probe.channelStub.published.findIndex(
      (p) => p.idempotencyKey === "subagent-seed:inv-1",
    );
    expect(startedIndex).toBeGreaterThanOrEqual(0);
    expect(seedIndex).toBeGreaterThan(startedIndex);
    const seed = probe.channelStub.published.find(
      (p) => p.idempotencyKey === "subagent-seed:inv-1",
    );
    expect(seed?.event).toMatchObject({
      kind: "message.completed",
      actor: { kind: "user", displayName: "Subagent task" },
      payload: {
        role: "user",
        to: [{ kind: "participant", participantId: "participant-child" }],
      },
    });
    expect(
      probe.rpcCalls.some((call) => call.method === "onChannelEnvelope"),
    ).toBe(false);
  });

  it("tears down a stale starting row and retries spawn setup on re-drive", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.insertSubagentRunForTest({ runId: "inv-1", status: "starting" });

    const out = await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      task: "retry the child setup",
    });

    expect(out).toMatchObject({ isError: false });
    expect(probe.rpcCalls).toContainEqual({
      target: "main",
      method: "runtime.destroyContext",
      args: [{ contextId: "ctx-inv-1-stale", recursive: true }],
    });
    expect(probe.subagentRunForTest("inv-1")).toMatchObject({
      runId: "inv-1",
      status: "running",
      childContextId: "ctx-child",
    });
  });

  it("keeps a running setup-failure row retryable when terminal publish fails", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.channelPublishFailures.add("subagent-seed:inv-1");
    probe.channelPublishFailures.add("subagent-terminal:inv-1");

    const out = await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      task: "this seed publish will fail",
    });

    expect(out).toMatchObject({
      isError: true,
      result: "publish failed: subagent-seed:inv-1",
    });
    expect(probe.subagentRunForTest("inv-1")).toMatchObject({
      runId: "inv-1",
      status: "running",
    });
    expect(
      probe.rpcCalls.some(
        (call) =>
          call.target === "main" &&
          call.method === "runtime.destroyContext" &&
          JSON.stringify(call.args).includes("ctx-child"),
      ),
    ).toBe(false);
  });

  it("tears down setup when the started-card publish fails", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.channelPublishFailures.add("subagent-started:inv-1");

    const out = await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      task: "this started publish will fail",
    });

    expect(out).toMatchObject({
      isError: true,
      result: "publish failed: subagent-started:inv-1",
    });
    expect(probe.subagentRunForTest("inv-1")).toBeNull();
    expect(
      probe.rpcCalls.some(
        (call) =>
          call.target === "main" &&
          call.method === "runtime.destroyContext" &&
          JSON.stringify(call.args).includes("ctx-child"),
      ),
    ).toBe(true);
    expect(
      probe.channelStub.published.some(
        (p) => p.idempotencyKey === "subagent-seed:inv-1",
      ),
    ).toBe(false);
  });

  it("retains a running setup-failure terminal for later inspection", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.channelPublishFailures.add("subagent-seed:inv-1");

    const out = await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      task: "this seed publish will fail",
    });

    expect(out).toMatchObject({
      isError: true,
      result: "publish failed: subagent-seed:inv-1",
    });
    expect(probe.subagentRunForTest("inv-1")).toMatchObject({
      status: "failed",
    });
    expect(
      probe.rpcCalls.some(
        (call) =>
          call.target === "main" &&
          call.method === "runtime.destroyContext" &&
          JSON.stringify(call.args).includes("ctx-child"),
      ),
    ).toBe(false);
    expect(
      probe.channelStub.published.some(
        (p) => p.idempotencyKey === "subagent-terminal:inv-1",
      ),
    ).toBe(true);
  });

  it("retries the idempotent task seed for an existing running run", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.insertSubagentRunForTest({ runId: "inv-1", status: "running" });

    const out = await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      task: "seed retry",
    });

    expect(out).toMatchObject({
      isError: false,
      result: { details: { runId: "inv-1", status: "running" } },
    });
    const seed = probe.channelStub.published.find(
      (p) => p.idempotencyKey === "subagent-seed:inv-1",
    );
    expect(seed?.event).toMatchObject({
      kind: "message.completed",
      payload: {
        role: "user",
        to: [{ kind: "participant", participantId: "participant-child" }],
      },
    });
  });

  it("retries a task seed with an identical durable event", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.insertSubagentRunForTest({ runId: "inv-1", status: "running" });

    await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      task: "seed retry",
    });
    await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      task: "seed retry",
    });

    const seeds = probe.channelStub.published.filter(
      (entry) => entry.idempotencyKey === "subagent-seed:inv-1",
    );
    expect(seeds).toHaveLength(2);
    expect(seeds[1]?.event).toEqual(seeds[0]?.event);
  });

  it("recovers a missing subagent row from the parent task card for inspect", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.seedSubagentStartedInParentChannelForTest("inv-recovered");
    probe.respondToVcs(
      "status",
      semanticStatus(
        "ctx-inv-recovered",
        "event:recovered",
        { kind: "event", eventId: "event:recovered" },
        true,
      ),
    );

    const out = await probe.inspectSubagentForTest("inv-recovered", "status");

    expect(out.details).toMatchObject({
      runId: "inv-recovered",
      query: "status",
    });
    expect(probe.subagentRunForTest("inv-recovered")).toMatchObject({
      runId: "inv-recovered",
      status: "running",
      taskChannelId: "task-inv-recovered",
      childContextId: "ctx-inv-recovered",
    });
    expect(probe.rpcCalls).toContainEqual({
      target: "main",
      method: "vcs.status",
      args: [{ contextId: "ctx-inv-recovered" }],
    });
  });

  it("refuses to recover a subagent card without its child participant identity", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.seedSubagentStartedInParentChannelForTest("inv-unbound", {
      includeChildParticipantId: false,
    });

    await expect(
      probe.inspectSubagentForTest("inv-unbound", "status"),
    ).rejects.toThrow(/unknown subagent run inv-unbound/);
    expect(probe.subagentRunForTest("inv-unbound")).toBeNull();
  });

  it("returns a bounded parent-relative diff instead of expanding the child semantic graph", async () => {
    const probe = await makeSubagentSpawnProbe();
    const runId = "inv-diff";
    probe.insertSubagentRunForTest({ runId, status: "running" });
    const childHead = { kind: "event" as const, eventId: "event:child" };
    const parentHead = {
      kind: "application" as const,
      applicationId: "application:parent",
    };
    probe.respondToVcs(
      "status",
      semanticStatus("ctx-inv-diff-stale", "event:child", childHead, true),
      semanticStatus("ctx-1", "event:parent", parentHead, false),
    );
    probe.respondToVcs(
      "compare",
      semanticComparison(parentHead, "event:child", [
        { id: "child", status: "adopt" },
      ]),
    );

    const out = await probe.inspectSubagentForTest(runId, "diff");
    const text = (out.content[0] as { text?: string } | undefined)?.text ?? "";

    expect(text).toContain("Source event:child: 1 adopt");
    expect(text).toContain("Coordinate: file:child · adopt · child");
    expect(text).toContain("Child source is committed and clean");
    expect(text.length).toBeLessThan(20_000);
    expect(
      probe.rpcCalls.filter(({ method }) => method.startsWith("vcs.")),
    ).toEqual([
      {
        target: "main",
        method: "vcs.status",
        args: [{ contextId: "ctx-inv-diff-stale" }],
      },
      {
        target: "main",
        method: "vcs.status",
        args: [{ contextId: "ctx-1" }],
      },
      {
        target: "main",
        method: "vcs.compare",
        args: [
          {
            target: parentHead,
            source: { kind: "event", eventId: "event:child" },
            limit: 20,
          },
        ],
      },
    ]);
    expect(probe.rpcCalls.some(({ method }) => method === "vcs.inspect")).toBe(
      false,
    );
  });

  it("pages child log history from the committed event when the working head is an application", async () => {
    const probe = await makeSubagentSpawnProbe();
    const runId = "inv-log";
    probe.insertSubagentRunForTest({ runId, status: "running" });
    const committed = { kind: "event" as const, eventId: "event:child-commit" };
    const workingHead = {
      kind: "application" as const,
      applicationId: "application:child-working",
    };
    probe.respondToVcs(
      "status",
      semanticStatus(
        "ctx-inv-log-stale",
        committed.eventId,
        workingHead,
        false,
      ),
    );
    probe.respondToVcs("history", {
      root: committed,
      entries: [
        { node: committed, createdAt: null, summary: "Child fixture commit" },
      ],
      nextCursor: null,
    });

    const out = await probe.inspectSubagentForTest(runId, "log");

    expect((out.content[0] as { text?: string } | undefined)?.text).toContain(
      "Child fixture commit",
    );
    expect(
      probe.rpcCalls.filter(({ method }) => method.startsWith("vcs.")),
    ).toEqual([
      {
        target: "main",
        method: "vcs.status",
        args: [{ contextId: "ctx-inv-log-stale" }],
      },
      {
        target: "main",
        method: "vcs.history",
        args: [{ root: committed, direction: "past", limit: 20 }],
      },
    ]);
  });

  it("recovers a missing subagent row from the parent task card for transcript reads", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.seedSubagentStartedInParentChannelForTest("inv-recovered");
    probe.channelStub.replay.set("task-inv-recovered", [
      {
        id: 7,
        messageId: "child-msg-7",
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: {
          kind: "message.completed",
          actor: {
            kind: "agent",
            id: "participant-child",
            displayName: "Child",
          },
          payload: {
            protocol: "agentic.trajectory.v1",
            role: "assistant",
            blocks: [{ type: "text", content: "Recovered transcript line." }],
          },
          createdAt: new Date().toISOString(),
        } as unknown as AgenticEvent,
        senderId: "participant-child",
        ts: Date.now(),
      },
    ]);

    const out = await probe.readSubagentForTest("inv-recovered", 0);

    expect((out.content[0] as { text?: string } | undefined)?.text).toContain(
      "Recovered transcript line.",
    );
    expect(out.details).toMatchObject({
      runId: "inv-recovered",
      nextSeq: 7,
      empty: false,
    });
  });

  it("adopts a committed child's applicable changes into the local working chain", async () => {
    const probe = await makeSubagentSpawnProbe();
    const runId = "inv-semantic";
    probe.insertSubagentRunForTest({ runId, status: "running" });
    const target = {
      kind: "application" as const,
      applicationId: "application:target",
    };
    const integrated = {
      kind: "application" as const,
      applicationId: "application:integrated",
    };
    const sourceEventId = "event:source";
    const integration = {
      contextId: "ctx-1",
      workUnitId: "work:integration",
      applicationId: integrated.applicationId,
      changeIds: [],
      incorporatedChangeIds: ["change:1"],
      workingHead: integrated,
      decisionId: "decision:1",
    };

    probe.respondToVcs(
      "status",
      semanticStatus("ctx-1", "event:parent", target, false),
      semanticStatus(
        "ctx-child",
        sourceEventId,
        { kind: "event", eventId: sourceEventId },
        true,
      ),
    );
    const initialComparison = semanticComparison(target, sourceEventId, [
      { id: "one", status: "adopt" },
    ]);
    initialComparison.intents = [
      {
        workUnitId: "work:child",
        side: "theirs",
        state: "pending",
        intent: {
          tier: "trigger",
          text: "asked by user:owner: Build the fixture corpus",
        },
        coordinates: [{ kind: "file", id: "one" }],
      },
    ];
    probe.respondToVcs(
      "compare",
      initialComparison,
      semanticComparison(integrated, sourceEventId, []),
    );
    probe.respondToVcs("merge", {
      ...integration,
      status: "working",
      commandId: "command:integration",
      changeCount: 0,
      incorporatedChangeCount: 1,
      decisionIds: ["decision:1"],
      outcomes: [],
      resolution: {
        complete: true,
        remainingCoordinateCount: 0,
        concluded: true,
      },
      intents: initialComparison.intents,
      intentsTruncated: false,
      counts: {
        adopt: 0,
        convergent: 0,
        composed: 0,
        conflict: 0,
        resolved: 1,
      },
      conflicts: [],
      nextConflictCursor: null,
      composed: [
        {
          coordinate: { kind: "file", id: "one" },
          ours: { tier: "mechanical", text: "Keep the parent index" },
          theirs: { tier: "trigger", text: "Build the fixture corpus" },
        },
      ],
    });

    const result = await probe.mergeSubagentForTest(
      runId,
      CHANNEL,
      "Integrate the reviewed fixture corpus",
    );

    expect(result.details).toMatchObject({
      protocol: "vibestudio.subagent-merge.v1",
      runId,
      status: "working",
      sourceEventId,
      initialWorkingHead: target,
      workingHead: integrated,
      merges: [expect.objectContaining({ decisionId: "decision:1" })],
      review: expect.objectContaining({
        sourceHeadline: "asked by user:owner: Build the fixture corpus",
      }),
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(
        /Resolution: complete=true; concluded=true; remaining=0[\s\S]*Source: asked by user:owner[\s\S]*Composed: file:one/,
      ),
    });
    expect(probe.subagentRunForTest(runId)?.sourceEventId).toBe(sourceEventId);
    const vcsCalls = probe.rpcCalls.filter(
      ({ target: callTarget, method }) =>
        callTarget === "main" && method.startsWith("vcs."),
    );
    expect(vcsCalls.map(({ method }) => method)).toEqual([
      "vcs.status",
      "vcs.status",
      "vcs.merge",
    ]);
    const integrateInput = vcsCalls.find(({ method }) => method === "vcs.merge")
      ?.args[0] as Record<string, unknown>;
    expect(integrateInput).toMatchObject({
      contextId: "ctx-1",
      expectedWorkingHead: target,
      source: { kind: "event", eventId: sourceEventId },
      intentSummary: "Integrate the reviewed fixture corpus",
    });
    expect(integrateInput["commandId"]).toMatch(
      /^subagent-merge:[a-f0-9]{64}$/,
    );
    expect(vcsCalls.some(({ method }) => method === "vcs.commit")).toBe(false);
  });

  it("treats an already-accounted child event as unchanged without a recovery subsystem", async () => {
    const probe = await makeSubagentSpawnProbe();
    const runId = "inv-retry";
    probe.insertSubagentRunForTest({ runId, status: "running" });
    const target = {
      kind: "application" as const,
      applicationId: "application:target",
    };
    const sourceEventId = "event:source";
    probe.respondToVcs(
      "status",
      semanticStatus("ctx-1", "event:parent", target, false),
      semanticStatus(
        "ctx-child",
        sourceEventId,
        { kind: "event", eventId: sourceEventId },
        true,
      ),
    );
    probe.respondToVcs("merge", {
      status: "unchanged",
      contextId: "ctx-1",
      workingHead: target,
      resolution: {
        complete: true,
        remainingCoordinateCount: 0,
        concluded: true,
      },
      counts: {
        adopt: 0,
        convergent: 0,
        composed: 0,
        conflict: 0,
        resolved: 1,
      },
      intents: [],
      intentsTruncated: false,
      conflicts: [],
      nextConflictCursor: null,
    });

    const result = await probe.mergeSubagentForTest(runId);

    expect(result.details).toMatchObject({
      status: "unchanged",
      sourceEventId,
      initialWorkingHead: target,
      workingHead: target,
      merges: [expect.objectContaining({ status: "unchanged" })],
    });
    expect(probe.subagentRunForTest(runId)?.sourceEventId).toBe(sourceEventId);
    const methods = probe.rpcCalls.map(({ method }) => method);
    expect(methods.filter((method) => method === "vcs.merge")).toHaveLength(1);
    expect(methods).not.toContain("vcs.commit");

    expect(probe.subagentRunForTest(runId)).toMatchObject({
      status: "running",
      semanticIntegrationSnapshot: expect.objectContaining({
        state: "complete",
        asOfWorkingHead: target,
      }),
    });
  });

  it("returns the engine's bounded conflict page without a wrapper compare", async () => {
    const probe = await makeSubagentSpawnProbe();
    const runId = "inv-paged-conflict";
    probe.insertSubagentRunForTest({ runId, status: "running" });
    const target = {
      kind: "application" as const,
      applicationId: "application:target",
    };
    const sourceEventId = "event:source";
    probe.respondToVcs(
      "status",
      semanticStatus("ctx-1", "event:parent", target, false),
      semanticStatus(
        "ctx-child",
        sourceEventId,
        { kind: "event", eventId: sourceEventId },
        true,
      ),
    );
    const latePage = semanticComparison(
      target,
      sourceEventId,
      [{ id: "late-conflict", status: "conflict" }],
      true,
    );
    probe.respondToVcs("merge", {
      status: "unchanged",
      contextId: "ctx-1",
      workingHead: target,
      resolution: {
        complete: false,
        remainingCoordinateCount: 1,
        concluded: true,
      },
      counts: latePage.counts,
      intents: [],
      intentsTruncated: false,
      conflicts: latePage.coordinates,
      nextConflictCursor: "cursor:late-conflict",
    });

    const result = await probe.mergeSubagentForTest(runId);

    expect(result.details).toMatchObject({
      status: "needs-decision",
      review: expect.objectContaining({
        conflicts: [
          expect.objectContaining({
            coordinate: expect.objectContaining({ id: "late-conflict" }),
          }),
        ],
      }),
    });
    expect(
      probe.rpcCalls.filter(({ method }) => method === "vcs.compare"),
    ).toHaveLength(0);
    expect(
      probe.rpcCalls.filter(({ method }) => method === "vcs.merge"),
    ).toHaveLength(1);
  });

  it("keeps adopted changes local and reports remaining conflicting changes", async () => {
    const probe = await makeSubagentSpawnProbe();
    const runId = "inv-conflict";
    probe.insertSubagentRunForTest({ runId, status: "running" });
    const target = {
      kind: "application" as const,
      applicationId: "application:target",
    };
    const integrated = {
      kind: "application" as const,
      applicationId: "application:partial",
    };
    const sourceEventId = "event:source";
    const conflicting = { id: "conflicting", status: "conflict" as const };
    probe.respondToVcs(
      "status",
      semanticStatus("ctx-1", "event:parent", target, false),
      semanticStatus(
        "ctx-child",
        sourceEventId,
        { kind: "event", eventId: sourceEventId },
        true,
      ),
    );
    probe.respondToVcs(
      "compare",
      semanticComparison(target, sourceEventId, [
        { id: "applicable", status: "adopt" },
        conflicting,
      ]),
      semanticComparison(integrated, sourceEventId, [conflicting], true),
    );
    probe.respondToVcs("merge", {
      status: "working",
      commandId: "command:partial",
      contextId: "ctx-1",
      workUnitId: "work:partial",
      applicationId: integrated.applicationId,
      changeCount: 0,
      changeIds: [],
      incorporatedChangeCount: 1,
      incorporatedChangeIds: ["change:applicable"],
      decisionIds: ["decision:partial"],
      workingHead: integrated,
      decisionId: "decision:partial",
      outcomes: [],
      resolution: {
        complete: false,
        remainingCoordinateCount: 1,
        concluded: true,
      },
      intents: [],
      intentsTruncated: false,
      counts: {
        adopt: 0,
        convergent: 0,
        composed: 0,
        conflict: 1,
        resolved: 1,
      },
      conflicts: semanticComparison(
        integrated,
        sourceEventId,
        [conflicting],
        true,
      ).coordinates,
      nextConflictCursor: null,
      composed: [],
    });

    const result = await probe.mergeSubagentForTest(runId);

    expect(result.details).toMatchObject({
      status: "needs-decision",
      sourceEventId,
      workingHead: integrated,
      review: expect.objectContaining({
        conflicts: [
          expect.objectContaining({
            coordinate: expect.objectContaining({ id: "conflicting" }),
            status: "conflict",
          }),
        ],
      }),
    });
    expect(probe.subagentRunForTest(runId)?.sourceEventId).toBe(sourceEventId);
    const methods = probe.rpcCalls.map(({ method }) => method);
    expect(methods.filter((method) => method === "vcs.merge")).toHaveLength(1);
    expect(methods).not.toContain("vcs.commit");

    expect(probe.subagentRunForTest(runId)).not.toBeNull();
  });

  it("resolves a long unique run prefix with or without its display ellipsis", async () => {
    const probe = await makeSubagentSpawnProbe();
    const runId =
      "call_nnrl4WyxSSNYE7v57Bm9QPtD|fc_028d12fc097db4d5016a549442191c81918d66c1c1c324a9eb";
    probe.insertSubagentRunForTest({ runId, status: "running" });

    const withEllipsis = await probe.readSubagentForTest(
      "call_nnrl4WyxSSNYE7v57Bm9P...",
      0,
    );
    const exactPrefix = await probe.readSubagentForTest(
      "call_nnrl4WyxSSNYE7v57Bm9QPtD",
      0,
    );
    const displayPrefix = await probe.readSubagentForTest(
      "call_nnrWyxSSNYE7v57Bm…",
      0,
    );

    expect(withEllipsis.details).toMatchObject({
      runId: "call_nnrl4WyxSSNYE7v57Bm…",
      empty: true,
    });
    expect(exactPrefix.details).toMatchObject({ empty: true });
    expect(displayPrefix.details).toMatchObject({ empty: true });
  });

  it("rejects ambiguous or too-short abbreviated run references", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.insertSubagentRunForTest({
      runId: "call_shared_prefix_1234567890_alpha",
      status: "running",
    });
    probe.insertSubagentRunForTest({
      runId: "call_shared_prefix_1234567890_bravo",
      status: "running",
    });

    await expect(
      probe.readSubagentForTest("call_shared_prefix_1234567890_...", 0),
    ).rejects.toMatchObject({
      code: "InvalidReference",
      errorData: expect.objectContaining({
        code: "InvalidReference",
        operation: "subagent-reference",
      }),
      message: expect.stringContaining("ambiguous subagent run reference"),
    });
    await expect(
      probe.readSubagentForTest("call_shared...", 0),
    ).rejects.toThrow("unknown subagent run");
  });

  it("does not project supervised-run or VCS state into the system prompt", async () => {
    const probe = await makeSubagentSpawnProbe();
    const runId = "inv-prompt-integration";
    const sourceEventId = "event:child-source";
    probe.insertSubagentRunForTest({ runId, status: "running" });
    probe.setSubagentSourceForTest(runId, sourceEventId);
    probe.respondToVcs(
      "status",
      semanticStatus(
        "ctx-1",
        "event:parent",
        { kind: "application", applicationId: "application:parent" },
        false,
        [
          {
            source: { kind: "event", eventId: sourceEventId },
            remainingCoordinateCount: 3,
            mergeableCoordinateCount: 0,
            conflictCoordinateCount: 3,
            concluded: true,
            asOfWorkingHead: {
              kind: "application",
              applicationId: "application:parent",
            },
            stale: false,
          },
        ],
      ),
    );

    const prompt = await probe.systemPromptForTest();

    expect(prompt).not.toContain("Durable Supervised Subagent Ledger");
    expect(prompt).not.toContain("semanticIntegration");
    expect(probe.rpcCalls).toEqual([]);
  });

  it("targets follow-up instructions to the exact child participant", async () => {
    const probe = await makeSubagentSpawnProbe();
    await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      label: "background audit",
      task: "audit this in the child",
    });

    await probe.sendToSubagentForTest(
      "inv-1",
      "Correct the focused verification.",
    );

    expect(probe.channelStub.sent).toContainEqual({
      channelId: "task-inv-1",
      participantId: AGENT_ID,
      messageId: "subagent-msg:send-test",
      content: "Correct the focused verification.",
      options: {
        senderMetadata: { type: "agent", name: AGENT_ID },
        to: [{ kind: "participant", participantId: "participant-child" }],
      },
    });
  });

  it("counts only live child executions against the concurrency limit", async () => {
    const probe = await makeSubagentSpawnProbe();
    for (const runId of ["inv-1", "inv-2", "inv-3"]) {
      const result = await probe.spawnForTest(CHANNEL, runId, {
        mode: "fresh",
        label: runId,
        task: `work for ${runId}`,
      });
      expect(result).toMatchObject({ isError: false });
    }
    await probe.completeSubagentForTest("inv-1", "Done.", "success");

    const replacement = await probe.spawnForTest(CHANNEL, "inv-4", {
      mode: "fresh",
      label: "replacement",
      task: "replace an existing child",
    });

    expect(replacement).toMatchObject({ isError: false });
    expect(probe.subagentRunForTest("inv-1")).toMatchObject({
      status: "completed",
    });
  });

  it("wakes the parent channel when the child completes while the parent is suspended", async () => {
    const probe = await makeSubagentSpawnProbe();
    await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      label: "background audit",
      task: "audit this in the child",
    });

    await probe.completeSubagentForTest(
      "inv-1",
      "All checks passed.",
      "success",
    );

    expect(probe.subagentRunForTest("inv-1")).toMatchObject({
      status: "completed",
    });
    expect(
      probe.channelStub.published.find(
        (entry) =>
          entry.channelId === CHANNEL &&
          entry.idempotencyKey === "subagent-terminal:inv-1",
      )?.event,
    ).toMatchObject({ kind: "task.completed", causality: { taskId: "inv-1" } });
    expect(probe.handleIncomingSpy).toHaveBeenCalledWith(
      CHANNEL,
      expect.objectContaining({
        type: "command",
        command: expect.objectContaining({
          kind: "prompt",
          channelId: CHANNEL,
          source: { envelopeId: "subagent-terminal:inv-1:completed" },
          sourceMessageId: "subagent-terminal:inv-1:completed",
          content: expect.stringContaining("All checks passed."),
        }),
      }),
    );
    expect(probe.handleIncomingSpy.mock.calls[0]?.[1]).toMatchObject({
      command: {
        content: expect.stringContaining("No supervised subagents remain live"),
      },
    });
    const terminalPrompt = (
      probe.handleIncomingSpy.mock.calls[0]?.[1] as {
        command?: { content?: string };
      }
    ).command?.content;
    expect(terminalPrompt).toContain(
      "Integrate it only when incorporating the child's work",
    );
    expect(terminalPrompt).not.toContain(
      "Review and integrate retained results",
    );
  });

  it("projects the task-channel terminal winner across a competing supervisor terminal", async () => {
    const probe = await makeSubagentSpawnProbe();
    await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      label: "background audit",
      task: "audit this in the child",
    });
    const canonicalEvent = {
      kind: "task.completed",
      actor: { kind: "agent", id: "participant-child" },
      causality: { taskId: "inv-1", invocationId: "inv-1" },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        terminalOutcome: "success",
        summary: "Child completed first.",
        result: {
          protocolContent: [{ type: "text", text: "Child completed first." }],
        },
      },
      createdAt: new Date().toISOString(),
    } as unknown as AgenticEvent;
    probe.channelStub.channelEnvelopes.set(
      `task-inv-1\u0000ik:subagent-terminal:inv-1`,
      {
        id: 99,
        messageId: "ik:subagent-terminal:inv-1",
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: canonicalEvent,
        senderId: "participant-child",
        ts: Date.now(),
      } as ChannelEvent,
    );

    await probe.settleSubagentForTest(
      "inv-1",
      "abandoned",
      "supervisor retired",
    );

    expect(probe.subagentRunForTest("inv-1")).toMatchObject({
      status: "completed",
    });
    expect(
      probe.channelStub.published.find(
        (entry) =>
          entry.channelId === CHANNEL &&
          entry.idempotencyKey === "subagent-terminal:inv-1",
      )?.event,
    ).toMatchObject({
      kind: "task.completed",
      payload: { summary: "Child completed first." },
    });
  });

  it("rejects a canonical task terminal whose actor does not match its publisher", async () => {
    const probe = await makeSubagentSpawnProbe();
    await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      label: "background audit",
      task: "audit this in the child",
    });
    const forgedEvent = {
      kind: "task.failed",
      actor: { kind: "agent", id: AGENT_ID },
      causality: { taskId: "inv-1", invocationId: "inv-1" },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        terminalOutcome: "tool_error",
        reason: "forged supervisor result",
      },
      createdAt: new Date().toISOString(),
    } as unknown as AgenticEvent;
    probe.channelStub.channelEnvelopes.set(
      `task-inv-1\u0000ik:subagent-terminal:inv-1`,
      {
        id: 100,
        messageId: "ik:subagent-terminal:inv-1",
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: forgedEvent,
        senderId: "participant-child",
        ts: Date.now(),
      } as ChannelEvent,
    );

    await expect(
      probe.settleSubagentForTest("inv-1", "abandoned", "supervisor retired"),
    ).rejects.toThrow(/no authorized canonical task-channel event/);
    expect(probe.subagentRunForTest("inv-1")).toMatchObject({
      status: "running",
    });
    expect(
      probe.channelStub.published.some(
        (entry) =>
          entry.channelId === CHANNEL &&
          entry.idempotencyKey === "subagent-terminal:inv-1",
      ),
    ).toBe(false);
  });

  it("does not authorize a child terminal through an entity-id fallback", async () => {
    const probe = await makeSubagentSpawnProbe();
    await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      label: "background audit",
      task: "audit this in the child",
    });
    const childEntityId = probe.subagentRunForTest("inv-1")!.childEntityId;
    probe.clearSubagentParticipantForTest("inv-1");
    const unboundEvent = {
      kind: "task.completed",
      actor: { kind: "agent", id: childEntityId },
      causality: { taskId: "inv-1", invocationId: "inv-1" },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        terminalOutcome: "success",
        summary: "Unbound completion.",
      },
      createdAt: new Date().toISOString(),
    } as unknown as AgenticEvent;
    probe.channelStub.channelEnvelopes.set(
      `task-inv-1\u0000ik:subagent-terminal:inv-1`,
      {
        id: 101,
        messageId: "ik:subagent-terminal:inv-1",
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: unboundEvent,
        senderId: childEntityId,
        ts: Date.now(),
      } as ChannelEvent,
    );

    await expect(
      probe.settleSubagentForTest("inv-1", "abandoned", "supervisor retired"),
    ).rejects.toThrow(/no authorized canonical task-channel event/);
    expect(probe.subagentRunForTest("inv-1")).toMatchObject({ status: "running" });
  });

  it("resumes the supervisor after every sibling terminal", async () => {
    const probe = await makeSubagentSpawnProbe();
    await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      label: "first audit",
      task: "audit the first area",
    });
    await probe.spawnForTest(CHANNEL, "inv-2", {
      mode: "fresh",
      label: "second audit",
      task: "audit the second area",
    });

    await probe.completeSubagentForTest("inv-1", "First result.", "success");

    expect(probe.subagentRunForTest("inv-1")).toMatchObject({
      status: "completed",
    });
    expect(probe.subagentRunForTest("inv-2")).toMatchObject({
      status: "running",
    });
    expect(probe.handleIncomingSpy).toHaveBeenCalledOnce();
    const firstWake = probe.handleIncomingSpy.mock.calls[0]?.[1] as {
      command?: { source?: { envelopeId?: string }; content?: string };
    };
    expect(firstWake.command?.source?.envelopeId).toBe(
      "subagent-terminal:inv-1:completed",
    );
    expect(firstWake.command).toMatchObject({
      metadata: { deliverAfterTurn: true },
    });
    expect(firstWake.command?.content).toContain("First result.");
    expect(firstWake.command?.content).toContain(
      "1 other supervised subagent remains live",
    );
    expect(firstWake.command?.content).toContain(
      "inv-1 (first audit): completed",
    );
    expect(firstWake.command?.content).toContain(
      "inv-2 (second audit): running",
    );
    expect(firstWake.command?.content).toContain(
      "continue useful foreground work or suspend again",
    );

    await probe.completeSubagentForTest("inv-2", "Second result.", "success");

    expect(probe.subagentRunForTest("inv-2")).toMatchObject({
      status: "completed",
    });
    expect(probe.handleIncomingSpy).toHaveBeenCalledTimes(2);
    const secondWake = probe.handleIncomingSpy.mock.calls[1]?.[1] as {
      command?: { source?: { envelopeId?: string }; content?: string };
    };
    expect(secondWake.command?.source?.envelopeId).toBe(
      "subagent-terminal:inv-2:completed",
    );
    expect(secondWake.command?.content).toContain("Second result.");
    expect(secondWake.command?.content).toContain(
      "No supervised subagents remain live",
    );
    expect(secondWake.command?.content).toContain(
      "inv-1 (first audit): completed",
    );
    expect(secondWake.command?.content).toContain(
      "inv-2 (second audit): completed",
    );
  });

  it("notifies the supervisor for a failed child while a sibling remains live", async () => {
    const probe = await makeSubagentSpawnProbe();
    await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      label: "blocked audit",
      task: "audit the blocked area",
    });
    await probe.spawnForTest(CHANNEL, "inv-2", {
      mode: "fresh",
      label: "continuing audit",
      task: "audit the continuing area",
    });

    await probe.completeSubagentForTest(
      "inv-1",
      "Blocked by invalid input.",
      "failed",
    );

    expect(probe.subagentRunForTest("inv-1")).toMatchObject({
      status: "failed",
    });
    expect(probe.subagentRunForTest("inv-2")).toMatchObject({
      status: "running",
    });
    expect(probe.handleIncomingSpy).toHaveBeenCalledOnce();
    expect(probe.handleIncomingSpy.mock.calls[0]?.[1]).toMatchObject({
      command: {
        source: { envelopeId: "subagent-terminal:inv-1:failed" },
        content: expect.stringContaining("Blocked by invalid input."),
      },
    });
  });

  it("delivers each near-simultaneous sibling terminal exactly once", async () => {
    const probe = await makeSubagentSpawnProbe();
    await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      label: "first audit",
      task: "audit the first area",
    });
    await probe.spawnForTest(CHANNEL, "inv-2", {
      mode: "fresh",
      label: "second audit",
      task: "audit the second area",
    });

    await Promise.all([
      probe.completeSubagentForTest("inv-1", "First result.", "success"),
      probe.completeSubagentForTest("inv-2", "Second result.", "success"),
    ]);

    expect(probe.subagentRunForTest("inv-1")).toMatchObject({
      status: "completed",
    });
    expect(probe.subagentRunForTest("inv-2")).toMatchObject({
      status: "completed",
    });
    expect(probe.handleIncomingSpy).toHaveBeenCalledTimes(2);
    const envelopeIds = probe.handleIncomingSpy.mock.calls.map(
      (call) =>
        (call[1] as { command?: { source?: { envelopeId?: string } } }).command
          ?.source?.envelopeId,
    );
    expect(envelopeIds).toEqual(
      expect.arrayContaining([
        "subagent-terminal:inv-1:completed",
        "subagent-terminal:inv-2:completed",
      ]),
    );
    const wakeContents = probe.handleIncomingSpy.mock.calls.map(
      (call) =>
        (call[1] as { command?: { content?: string } }).command?.content,
    );
    expect(wakeContents).toHaveLength(2);
    expect(
      wakeContents.filter((content) =>
        content?.includes("1 other supervised subagent remains live"),
      ),
    ).toHaveLength(1);
    expect(
      wakeContents.filter((content) =>
        content?.includes("No supervised subagents remain live"),
      ),
    ).toHaveLength(1);
    expect(wakeContents).toEqual(
      expect.arrayContaining([
        expect.stringContaining("First result."),
        expect.stringContaining("Second result."),
      ]),
    );
  });

  it("keeps child completion retryable when waking the parent fails", async () => {
    const probe = await makeSubagentSpawnProbe();
    await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      label: "background audit",
      task: "audit this in the child",
    });
    probe.handleIncomingSpy.mockRejectedValueOnce(new Error("wake failed"));

    await expect(
      probe.completeSubagentForTest("inv-1", "All checks passed.", "success"),
    ).rejects.toThrow("wake failed");

    expect(probe.subagentRunForTest("inv-1")).toMatchObject({
      status: "running",
    });

    await probe.completeSubagentForTest(
      "inv-1",
      "All checks passed.",
      "success",
    );

    expect(probe.subagentRunForTest("inv-1")).toMatchObject({
      status: "completed",
    });
    expect(probe.handleIncomingSpy).toHaveBeenCalledTimes(2);
  });

  it("lets suspension release an already-admitted terminal report from the open turn", async () => {
    const probe = await makeSubagentSpawnProbe();
    await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      label: "background audit",
      task: "audit this in the child",
    });
    await probe.completeSubagentForTest(
      "inv-1",
      "All checks passed.",
      "success",
    );

    expect(probe.handleIncomingSpy).toHaveBeenCalledWith(
      CHANNEL,
      expect.objectContaining({
        command: expect.objectContaining({
          metadata: {
            deliverAfterTurn: true,
            supervisedTerminalRunId: "inv-1",
          },
        }),
      }),
    );
    probe.deferredPostTurnQueueForTest = [
      { metadata: { supervisedTerminalRunId: "inv-1" } },
    ];
    await expect(probe.guardBackgroundSuspensionForTest()).resolves.toEqual({
      suspend: true,
    });

    probe.deferredPostTurnQueueForTest = [];
    await expect(
      probe.guardBackgroundSuspensionForTest(),
    ).resolves.toMatchObject({
      suspend: false,
      reason: "no_live_supervised_runs",
    });
  });

  it("keeps the child live until its exact terminal report is admitted", async () => {
    const probe = await makeSubagentSpawnProbe();
    await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      label: "background audit",
      task: "audit this in the child",
    });
    let admitReport!: () => void;
    const reportAdmission = new Promise<void>((resolve) => {
      admitReport = resolve;
    });
    probe.handleIncomingSpy.mockImplementationOnce(async () => reportAdmission);

    const completion = probe.completeSubagentForTest(
      "inv-1",
      "All checks passed.",
      "success",
    );
    await vi.waitFor(() =>
      expect(probe.handleIncomingSpy).toHaveBeenCalledOnce(),
    );

    expect(probe.subagentRunForTest("inv-1")).toMatchObject({
      status: "running",
    });

    admitReport();
    await completion;

    expect(probe.subagentRunForTest("inv-1")).toMatchObject({
      status: "completed",
    });
  });

  it("agentKind:'claude-code' prepares the linked vessel and headless-launches via the supervisor", async () => {
    const probe = await makeSubagentSpawnProbe();

    const out = await probe.spawnForTest(CHANNEL, "inv-cc", {
      mode: "fresh",
      agentKind: "claude-code",
      label: "cc audit",
      task: "audit the repo",
      config: { model: "opus", effort: "high" },
    });

    expect(out).toMatchObject({
      isError: false,
      result: {
        details: {
          runId: "inv-cc",
          status: "running",
          agentKind: "claude-code",
          taskChannelId: "task-inv-cc",
          contextId: "ctx-child",
        },
      },
    });

    // Run row records the claude-code kind, the linked vessel as childEntityId
    // (its complete-caller identity), and the external session entity to release.
    expect(probe.subagentRunForTest("inv-cc")).toMatchObject({
      runId: "inv-cc",
      status: "running",
      agentKind: "claude-code",
      childEntityId:
        "do:workers/linked-agent:LinkedAgentWorker:linked:session-cc-1",
      childParticipantId: "participant-linked",
      externalSessionEntityId: "session:cc-1",
      externalGenerationId: "generation:cc-1",
      childContextId: "ctx-child",
    });

    // The extension's subagent launch was invoked on the task channel WITH
    // subagent duty and the task; argv/cwd/env stay private to the extension.
    const launchCall = probe.rpcCalls.find(
      (c) =>
        c.method === "extensions.invokeProvider" &&
        (c.args[1] as string) === "launchSubagent",
    );
    expect(launchCall).toBeDefined();
    expect(launchCall!.args[0]).toBe("claudeCode");
    const launchArg = (launchCall!.args[2] as unknown[])[0] as {
      channelId: string;
      options?: Record<string, unknown>;
      subagent: {
        runId: string;
        task: string;
        parentRef: string;
        parentChannelId: string;
        depth: number;
      };
    };
    expect(launchArg.channelId).toBe("task-inv-cc");
    // The spawn `config` reaches the launcher as CLI options (the extension
    // whitelists what its CLI supports).
    expect(launchArg.options).toEqual({ model: "opus", effort: "high" });
    expect(launchArg.subagent).toMatchObject({
      runId: "inv-cc",
      task: "audit the repo",
      parentChannelId: CHANNEL,
      depth: 1,
    });

    // The started card + task seed still flow through the shared pipeline.
    expect(
      probe.channelStub.published.some(
        (p) => p.idempotencyKey === "subagent-started:inv-cc",
      ),
    ).toBe(true);
    expect(
      probe.channelStub.published.some(
        (p) => p.idempotencyKey === "subagent-seed:inv-cc",
      ),
    ).toBe(true);
  });

  it("agentKind names an external launcher extension without a vessel branch", async () => {
    const probe = await makeSubagentSpawnProbe();

    const out = await probe.spawnForTest(CHANNEL, "inv-codex", {
      mode: "fresh",
      agentKind: "codex",
      label: "codex audit",
      task: "audit the repo",
    });

    expect(out).toMatchObject({
      isError: false,
      result: {
        details: {
          runId: "inv-codex",
          status: "running",
          agentKind: "codex",
          taskChannelId: "task-inv-codex",
          contextId: "ctx-child",
        },
      },
    });

    const launchCall = probe.rpcCalls.find(
      (c) =>
        c.method === "extensions.invoke" &&
        (c.args[1] as string) === "launchSubagent",
    );
    expect(launchCall!.args[0]).toBe("@workspace-extensions/codex");

    await probe.cancelSubagentForTest("inv-codex");
    const releaseCall = probe.rpcCalls.find(
      (c) =>
        c.method === "extensions.invoke" &&
        c.args[0] === "@workspace-extensions/codex" &&
        c.args[1] === "release",
    );
    expect(releaseCall).toBeDefined();
    expect((releaseCall!.args[2] as unknown[])[0]).toMatchObject({
      entityId: "session:codex-1",
      generationId: "generation:codex-1",
    });
  });

  it("tears down the child context when the Claude extension launch fails during setup", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.failClaudeLaunch = true;

    const out = await probe.spawnForTest(CHANNEL, "inv-cc", {
      mode: "fresh",
      agentKind: "claude-code",
      task: "audit the repo",
    });

    expect(out).toMatchObject({ isError: true });
    // The run row (recorded before prepare) is reclaimed and the child context torn down.
    expect(probe.subagentRunForTest("inv-cc")).toBeNull();
    expect(
      probe.rpcCalls.some(
        (c) =>
          c.method === "runtime.destroyContext" &&
          JSON.stringify(c.args).includes("ctx-child"),
      ),
    ).toBe(true);
  });

  it("reports external runtime inspection as not applicable for a Pi subagent", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.insertSubagentRunForTest({ runId: "inv-pi", status: "running" });

    const runtime = await probe.inspectSubagentForTest("inv-pi", "runtime");

    expect(runtime).toMatchObject({
      details: {
        runId: "inv-pi",
        query: "runtime",
        available: false,
        reason: "not-external",
        agentKind: "pi",
        status: "running",
      },
    });
    expect(
      probe.rpcCalls.some(
        (call) =>
          (call.method === "extensions.invoke" ||
            call.method === "extensions.invokeProvider") &&
          call.args[1] === "inspectLaunch",
      ),
    ).toBe(false);
  });
});

describe("AgentVesselBase.cancelEval (pill cancel → server-side eval run)", () => {
  it("derives the namespaced effect id and routes eval.cancel for ITSELF", async () => {
    const probe = await makeGateProbe();
    const out = await probe.callAgentMethod(CHANNEL, "cancelEval", {
      invocationId: "inv-9",
    });
    expect(out).toEqual({ result: { ok: true } });
    const cancel = probe.rpcCalls.find((c) => c.method === "eval.cancel");
    expect(cancel?.args[0]).toEqual({
      scopeKey: CHANNEL,
      runId: ids.invocationEffect("inv-9"),
    });
  });

  it("rejects a missing/empty invocationId WITHOUT dispatching a cancel", async () => {
    const probe = await makeGateProbe();
    const out = await probe.callAgentMethod(CHANNEL, "cancelEval", {});
    expect(out).toMatchObject({ isError: true });
    expect(probe.rpcCalls.some((c) => c.method === "eval.cancel")).toBe(false);
  });

  it("surfaces an eval.cancel failure as an error result (without throwing)", async () => {
    const probe = await makeGateProbe();
    probe.cancelError = new Error("cancel dispatch failed");
    const out = await probe.callAgentMethod(CHANNEL, "cancelEval", {
      invocationId: "inv-10",
    });
    expect(out).toMatchObject({
      isError: true,
      result: { error: "cancel dispatch failed" },
    });
  });
});

describe("AgentVesselBase pause", () => {
  it("makes the channel interruption terminal when no eval is pending", async () => {
    const probe = await makeGateProbe();
    const { interruptChannel } = probe.stubDriverForPause();

    const out = await probe.callAgentMethod(CHANNEL, "pause", {});

    expect(out).toEqual({ result: { paused: true } });
    expect(interruptChannel).toHaveBeenCalledWith(CHANNEL, false);
  });

  it("records eval cancellation before interrupting the turn, then delivers it", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = { status: "running" };
    await probe.callGate(CHANNEL, "inv-pause", {
      code: "await new Promise(() => {})",
    });
    const runId = ids.invocationEffect("inv-pause");
    const { interruptChannel } = probe.stubDriverForPause();
    interruptChannel.mockImplementation(async () => {
      expect(
        (probe as any).sql
          .exec(
            `SELECT run_id FROM deferred_eval_cancel_intents WHERE channel_id = ?`,
            CHANNEL,
          )
          .toArray(),
      ).toEqual([{ run_id: runId }]);
      expect(probe.rpcCalls.some((call) => call.method === "eval.cancel")).toBe(
        false,
      );
    });

    await expect(probe.callAgentMethod(CHANNEL, "pause", {})).resolves.toEqual({
      result: { paused: true },
    });

    expect(probe.rpcCalls).toContainEqual({
      method: "eval.cancel",
      args: [{ scopeKey: CHANNEL, runId }],
    });
    expect(
      (probe as any).sql
        .exec(`SELECT run_id FROM deferred_eval_cancel_intents`)
        .toArray(),
    ).toEqual([]);
  });

  it("keeps an undelivered pause cancellation durable", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = { status: "running" };
    await probe.callGate(CHANNEL, "inv-pause-retry", {
      code: "await new Promise(() => {})",
    });
    const runId = ids.invocationEffect("inv-pause-retry");
    probe.cancelError = new Error("eval cancellation unavailable");
    probe.stubDriverForPause();

    await expect(probe.callAgentMethod(CHANNEL, "pause", {})).resolves.toEqual({
      result: { paused: true },
    });
    expect(
      (probe as any).sql
        .exec(
          `SELECT channel_id, run_id, attempts
             FROM deferred_eval_cancel_intents`,
        )
        .toArray(),
    ).toEqual([{ channel_id: CHANNEL, run_id: runId, attempts: 1 }]);
  });

  it("does not report completion before the aborted effect has settled", async () => {
    const probe = await makeGateProbe();
    let releaseAbort!: () => void;
    const abortSettled = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    const { interruptChannel } = probe.stubDriverForPause();
    interruptChannel.mockImplementation(() => abortSettled);

    let completed = false;
    const pause = probe.callAgentMethod(CHANNEL, "pause", {}).then((result) => {
      completed = true;
      return result;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    releaseAbort();
    await expect(pause).resolves.toEqual({ result: { paused: true } });
  });

  it("forwards soft-flush intent to the terminal driver operation", async () => {
    const probe = await makeGateProbe();
    const { interruptChannel } = probe.stubDriverForPause();
    await probe.callAgentMethod(CHANNEL, "pause", { flushDeferred: true });
    expect(interruptChannel).toHaveBeenCalledWith(CHANNEL, true);
  });

  it("lets the host interrupt every subscribed transport for an emergency authority lock", async () => {
    const probe = await makeGateProbe();
    await probe.registerSubscriptionForTest(CHANNEL);
    await probe.registerSubscriptionForTest("channel-2");
    const { interruptChannel } = probe.stubDriverForPause();

    await expect(probe.interruptAllChannels()).resolves.toEqual({
      interrupted: 2,
    });
    expect(interruptChannel).toHaveBeenCalledTimes(2);
    expect(interruptChannel).toHaveBeenCalledWith(CHANNEL, true);
    expect(interruptChannel).toHaveBeenCalledWith("channel-2", true);
  });
});

describe("AgentVesselBase.onEvalProgress (live eval console streaming)", () => {
  it("publishes output against the parent invocation, not the eval effect runId", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();

    await vessel.onEvalProgress({
      runId: "inv:inv-5",
      agentInvocationId: "inv-5",
      channelId: CHANNEL,
      output: "hello\nworld",
    });

    const published = vessel.channelStub.published.find(
      (p) => p.event.kind === "invocation.output",
    );
    expect(published?.event).toMatchObject({
      kind: "invocation.output",
      causality: { invocationId: "inv-5" },
      payload: { output: "hello\nworld", channel: "stdout" },
    });
  });

  it("refuses a caller that is not the agent's own EvalDO (same gate as chatOp)", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = "do:vibestudio/internal:EvalDO:someoneelse";
    await expect(
      vessel.onEvalProgress({
        runId: "inv:inv-6",
        agentInvocationId: "inv-6",
        channelId: CHANNEL,
        output: "x",
      }),
    ).rejects.toThrow(/only this agent's own EvalDO/);
  });

  it("is a no-op for empty output (no event published)", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    await vessel.onEvalProgress({
      runId: "inv:inv-7",
      agentInvocationId: "inv-7",
      channelId: CHANNEL,
      output: "",
    });
    expect(
      vessel.channelStub.published.some(
        (p) => p.event.kind === "invocation.output",
      ),
    ).toBe(false);
  });
});

describe("AgentVesselBase.onEvalProgress authority lifecycle", () => {
  it("publishes authority suspension as structured parent-invocation progress", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();

    await vessel.onEvalProgress({
      runId: "inv:inv-authority",
      agentInvocationId: "inv-authority",
      channelId: CHANNEL,
      activity: {
        kind: "authority-requested",
        detail: { capability: "vcs.edit", resourceKey: "repo:panels/taskflow" },
      },
    });

    expect(
      vessel.channelStub.published.find(
        (entry) => entry.event.kind === "invocation.progress",
      )?.event,
    ).toMatchObject({
      kind: "invocation.progress",
      causality: { invocationId: "inv-authority" },
      payload: {
        message: "Waiting for approval to use vcs.edit on repo:panels/taskflow",
        data: {
          eval: {
            runId: "inv:inv-authority",
            activity: "authority-pending",
          },
        },
      },
    });
  });
});
