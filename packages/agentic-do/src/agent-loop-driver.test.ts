import { describe, expect, it, vi } from "vitest";
import { createTestDO as createBaseTestDO } from "@workspace/runtime/worker/test-utils";
import { successfulTestRpcFetch } from "@vibestudio/durable/test-utils";
import { GadWorkspaceDO } from "@workspace-workers/workspace-source";
import {
  ids,
  askUserPolicy,
  type AgentLoopConfig,
  type AgentTurnMetadata,
  type EffectDescriptor,
  type EffectOutcome,
  type StepPolicy,
} from "@workspace/agent-loop";
import {
  AgentLoopDriver,
  MODEL_TRANSPORT_CATASTROPHIC_ATTEMPT_LIMIT,
  type DriverDeps,
} from "./agent-loop-driver.js";
import type {
  ChannelCallPort,
  EffectExecutor,
  EphemeralEmit,
} from "./effect-executors/index.js";
import {
  CREDENTIAL_CONNECT_PAYLOAD_KIND,
  agentToolFailureFromUnknown,
} from "@workspace/agentic-protocol";
import { logIdForChannel } from "@vibestudio/trajectory-identity";
import { summarizeTurn } from "./agent-vessel.js";

const createTestDO: typeof createBaseTestDO = (DOClass, env, opts) =>
  createBaseTestDO(
    DOClass,
    { RPC_FETCH: successfulTestRpcFetch, ...env },
    opts,
  );

const CHANNEL = "chan-d1";
const LOG_ID = logIdForChannel(CHANNEL);

const config: AgentLoopConfig = {
  model: "anthropic:claude-sonnet-4-6",
  modelSpec: {
    id: "claude-sonnet-4-6",
    name: "anthropic:claude-sonnet-4-6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  thinkingLevel: "medium",
  fastMode: false,
  approvalLevel: 2,
  respondPolicy: "all",
  systemPromptHash: "blob:sys",
  activeToolNames: ["read"],
  roster: { participants: [] },
};

const fallbackModelRef = "local:lfm2.5-2.6b";
const fallbackModelSpec: NonNullable<AgentLoopConfig["fallbackModelSpec"]> = {
  id: "lfm2.5-2.6b",
  name: "LFM2.5 2.6B",
  api: "openai-completions",
  provider: "local",
  baseUrl: "http://127.0.0.1:0/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 4096,
};

interface Script {
  /** queued model outcomes, consumed per model_call dispatch. */
  model: EffectOutcome[];
  /** queued tool outcomes. */
  tool: EffectOutcome[];
}

async function makeHarness(opts: {
  script: Script;
  config?: AgentLoopConfig;
  policies?: StepPolicy[];
  ephemeral?: EphemeralEmit;
  executorOverride?: DriverDeps["executorOverride"];
  killPoint?: (point: string) => void;
  selfRefFor?: DriverDeps["selfRefFor"];
  gad?: Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;
  driverSql?: Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;
  compaction?: { minEntries?: number; triggerBytes?: number };
  /** Optional gate to inject a TRANSIENT store-load failure: return an Error to
   *  make the gad call throw (and record nothing). Used to verify the driver
   *  never silently drops an outcome on a transient store error (F3). */
  gadFault?: (method: string) => Error | null;
  onGadCall?: (method: string) => void;
  channelPublish?: ChannelCallPort["publish"];
  onTurnClosed?: NonNullable<DriverDeps["onTurnClosed"]>;
  commitTerminalOutcome?: NonNullable<DriverDeps["commitTerminalOutcome"]>;
  clearTerminalOutcomeRecovery?: NonNullable<
    DriverDeps["clearTerminalOutcomeRecovery"]
  >;
}) {
  const gad =
    opts.gad ?? (await createTestDO(GadWorkspaceDO, { __objectKey: "gad" }));
  const driverHost =
    opts.driverSql ??
    (await createTestDO(GadWorkspaceDO, { __objectKey: "driver-host" }));
  const ephemerals: EphemeralEmit[] = [];
  const channelPublishes: Array<Parameters<ChannelCallPort["publish"]>[0]> = [];
  const readReceipts: Array<
    Parameters<ChannelCallPort["recordReadReceipt"]>[0]
  > = [];
  const channelCalls: Array<Parameters<ChannelCallPort["callMethod"]>[0]> = [];
  const cancelledChannelCalls: Array<{
    channelId: string;
    transportCallId: string;
  }> = [];
  const alarms: number[] = [];
  let now = 1_750_000_000_000;
  const setNow = (value: number) => {
    now = value;
  };

  const fakeExecutor = (
    kind: EffectDescriptor["kind"],
    queue: EffectOutcome[],
  ): EffectExecutor =>
    ({
      kind,
      async execute({ onEphemeral }) {
        if (opts.ephemeral) onEphemeral(opts.ephemeral);
        const next = queue.shift();
        if (!next) throw new Error(`script exhausted for ${kind}`);
        return next;
      },
    }) as EffectExecutor;

  const blobs = new Map<string, string>();
  const deps: DriverDeps = {
    sql: driverHost.sql as never,
    gad: {
      // The driver runs INSIDE the agent DO, so its control-plane calls are attributed
      // as a durable entity — GAD write methods require entity authority.
      call: <T>(method: string, args: Record<string, unknown>) => {
        opts.onGadCall?.(method);
        const fault = opts.gadFault?.(method);
        if (fault) return Promise.reject(fault);
        return gad.callAs<T>("do", method, args);
      },
    },
    executorDeps: {
      blobstore: {
        getText: async (digest: string) => blobs.get(digest) ?? null,
        putText: async (value: string) => {
          const digest = `blob-${blobs.size + 1}`;
          blobs.set(digest, value);
          return { digest, size: value.length };
        },
      },
      promptArtifacts: {
        prepare: async () => opts.config ?? config,
      },
      channel: {
        callMethod: async (
          input: Parameters<ChannelCallPort["callMethod"]>[0],
        ) => {
          channelCalls.push(input);
        },
        cancelMethodCall: async (
          channelId: string,
          transportCallId: string,
        ) => {
          cancelledChannelCalls.push({ channelId, transportCallId });
        },
        publish: async (input: Parameters<ChannelCallPort["publish"]>[0]) => {
          channelPublishes.push(input);
          await opts.channelPublish?.(input);
        },
        recordReadReceipt: async (
          input: Parameters<ChannelCallPort["recordReadReceipt"]>[0],
        ) => {
          readReceipts.push(input);
        },
        sendSignalEvent: async () => {},
      },
      credentials: {
        getApiKey: async () => ({ apiKey: "test-key" }),
        registerCredentialInterest: async () => {},
      },
    } as never, // fakes only touch blobstore
    selfRefFor:
      opts.selfRefFor ??
      (() => ({
        kind: "agent",
        id: "agent:self",
        participantId: "agent:self",
      })),
    configFor: () => opts.config ?? config,
    policiesFor: () => opts.policies ?? [],
    onEphemeral: (emit) => ephemerals.push(emit),
    now: () => (now += 7),
    scheduleAlarm: (at) => alarms.push(at),
    ...(opts.commitTerminalOutcome
      ? { commitTerminalOutcome: opts.commitTerminalOutcome }
      : {}),
    ...(opts.clearTerminalOutcomeRecovery
      ? { clearTerminalOutcomeRecovery: opts.clearTerminalOutcomeRecovery }
      : {}),
    ...(opts.onTurnClosed ? { onTurnClosed: opts.onTurnClosed } : {}),
    executorOverride: (descriptor) => {
      const override = opts.executorOverride?.(descriptor);
      if (override) return override;
      if (descriptor.kind === "model_call")
        return fakeExecutor("model_call", opts.script.model);
      if (descriptor.kind === "local_tool")
        return fakeExecutor("local_tool", opts.script.tool);
      return null;
    },
    ...(opts.compaction ? { compaction: opts.compaction } : {}),
    ...(opts.killPoint ? { killPoint: opts.killPoint } : {}),
  };
  const driver = new AgentLoopDriver(deps);
  return {
    driver,
    gad,
    driverHost,
    ephemerals,
    alarms,
    channelPublishes,
    readReceipts,
    channelCalls,
    cancelledChannelCalls,
    setNow,
  };
}

/** Drain the alarm pump until the outbox is quiet (the driver executes
 *  effects ONLY in alarm context — hibernation-first discipline). */
async function settle(driver: AgentLoopDriver, rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await driver.dispatchReadyEffectsForTest().catch(() => {});
    if (driver.outbox.all().length === 0) break;
  }
}

function promptIncoming(
  envelopeId = "env-1",
  content = "hello",
  metadata?: AgentTurnMetadata,
) {
  return {
    type: "command" as const,
    command: {
      kind: "prompt" as const,
      channelId: CHANNEL,
      source: { envelopeId },
      content,
      senderRef: {
        kind: "user" as const,
        id: "panel:user",
        participantId: "panel:user",
      },
      ...(metadata ? { metadata } : {}),
    },
  };
}

function observationIncoming(
  envelopeId = "observation-env-1",
  payloadKind = "application.incident.v1",
) {
  const structuredInput = {
    kind: "channel-observation" as const,
    version: 1 as const,
    source: {
      channelId: CHANNEL,
      envelopeId,
      payloadKind,
      timestamp: 1_786_400_000_000,
      sender: { kind: "external" as const, id: "app:incident-feed" },
    },
    payload: { incidentId: envelopeId },
  };
  return {
    type: "command" as const,
    command: {
      kind: "prompt" as const,
      channelId: CHANNEL,
      source: { envelopeId },
      content: `Channel observation: ${payloadKind}`,
      structuredInput,
      senderRef: structuredInput.source.sender,
    },
  };
}

async function logKinds(gad: {
  sql: {
    exec(
      query: string,
      ...bindings: unknown[]
    ): { toArray(): Record<string, unknown>[] };
  };
}) {
  const rows = gad.sql.exec(
    `SELECT payload_kind FROM log_events
     WHERE log_id = '${LOG_ID}'
       AND envelope_id NOT LIKE 'sys:prompt-artifacts:%'
     ORDER BY seq`,
  );
  return rows.toArray().map((row) => String(row["payload_kind"]));
}

function inspectSql<TResult>(
  gad: {
    sql: {
      exec(
        query: string,
        ...bindings: unknown[]
      ): { toArray(): Record<string, unknown>[] };
    };
  },
  query: string,
  bindings: unknown[] = [],
): TResult {
  return { rows: gad.sql.exec(query, ...bindings).toArray() } as TResult;
}

const textReply = (text: string): EffectOutcome => ({
  kind: "model",
  blocks: [{ type: "text", content: text }],
  stopReason: "completed",
});

const toolCallReply = (id: string): EffectOutcome => ({
  kind: "model",
  blocks: [{ type: "toolCall", id, name: "read", arguments: { path: "a" } }],
  stopReason: "completed",
});

const toolOk: EffectOutcome = { kind: "tool", result: null, isError: false };

function rawUsageLimitError(): string {
  return `Codex error: ${JSON.stringify({
    type: "error",
    error: {
      type: "usage_limit_reached",
      message: "The usage limit has been reached",
      resets_at: 1781548501,
    },
    headers: {
      "X-Codex-Bengalfox-Limit-Name": "GPT-5.3 Codex-Spark",
    },
  })}`;
}

function rawInvalidToolSchemaError(): string {
  return "Codex error: Invalid schema for function 'client_eval': True is not of type 'number'.";
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("AgentLoopDriver", () => {
  it("journals a model-free automation eval as one visible invocation and closes from its result", async () => {
    const closed: Parameters<NonNullable<DriverDeps["onTurnClosed"]>>[0][] = [];
    const observed: EffectDescriptor[] = [];
    const harness = await makeHarness({
      script: {
        model: [],
        tool: [{ kind: "tool", result: "eval completed", isError: false }],
      },
      onTurnClosed: (input) => {
        closed.push(input);
      },
      executorOverride: (descriptor) => {
        observed.push(descriptor);
        return null;
      },
    });

    await harness.driver.handleIncoming(CHANNEL, {
      type: "command",
      command: {
        kind: "invoke",
        channelId: CHANNEL,
        source: { envelopeId: "automation:run-eval" },
        tool: "eval",
        args: {
          code: "return 42",
          authority: { approvals: "pregranted-only" },
        },
        metadata: {
          origin: "scheduled",
          completion: "after-invocation",
          automation: {
            missionId: "mission-eval",
            runId: "run-eval",
            ownerUserId: "usr_owner",
            authoritySessionNonce: "nonce:run-eval",
            name: "Daily check",
            revision: 1,
            action: "eval",
            trigger: "scheduled",
            startedAt: 10,
            createdAt: 1,
            schedule: { everyMs: 86_400_000 },
          },
        },
      },
    });
    await settle(harness.driver);

    expect(observed.map((descriptor) => descriptor.kind)).toEqual([
      "local_tool",
    ]);
    expect(observed[0]).toMatchObject({
      kind: "local_tool",
      tool: "eval",
      args: { code: "return 42", authority: { approvals: "pregranted-only" } },
    });
    expect(await logKinds(harness.gad)).toEqual([
      "turn.opened",
      "message.completed",
      "invocation.started",
      "invocation.completed",
      "turn.closed",
    ]);
    expect(closed).toEqual([
      expect.objectContaining({
        summary: "eval completed",
        metadata: expect.objectContaining({
          automation: expect.objectContaining({
            runId: "run-eval",
            action: "eval",
          }),
        }),
      }),
    ]);
  });

  it("reports terminal child-effect failures when an automation turn closes", async () => {
    const closed: Parameters<NonNullable<DriverDeps["onTurnClosed"]>>[0][] = [];
    const failure = agentToolFailureFromUnknown(
      Object.assign(new Error("Notification delivery failed"), {
        code: "EDELIVERY",
      }),
      { operation: "tool.notify", stage: "execute" },
    );
    const harness = await makeHarness({
      script: {
        model: [],
        tool: [
          {
            kind: "tool",
            result: { protocolContent: [], details: { failure } },
            isError: true,
            terminalOutcome: "tool_error",
            terminalReasonCode: failure.code,
            failure,
          },
        ],
      },
      onTurnClosed: (input) => {
        closed.push(input);
      },
    });

    await harness.driver.handleIncoming(CHANNEL, {
      type: "command",
      command: {
        kind: "invoke",
        channelId: CHANNEL,
        source: { envelopeId: "automation:run-notify" },
        tool: "notify",
        args: { content: "One minute has passed" },
        metadata: {
          origin: "scheduled",
          completion: "after-invocation",
          automation: {
            missionId: "mission-notify",
            runId: "run-notify",
            ownerUserId: "usr_owner",
            authoritySessionNonce: "nonce:run-notify",
            name: "Talk timer",
            revision: 1,
            action: "prompt",
            trigger: "scheduled",
            startedAt: 10,
            createdAt: 1,
            schedule: { everyMs: 60_000 },
          },
        },
      },
    });
    await settle(harness.driver);

    expect(closed).toEqual([
      expect.objectContaining({
        effectFailures: [
          {
            invocationId: expect.any(String),
            name: "notify",
            outcome: "tool_error",
            code: "EDELIVERY",
            message: "Notification delivery failed",
          },
        ],
      }),
    ]);
  });

  it("reports only the exact automation turn's final assistant message", async () => {
    const closed: Parameters<NonNullable<DriverDeps["onTurnClosed"]>>[0][] = [];
    let attempt = 0;
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      onTurnClosed: (input) => {
        closed.push(input);
      },
      executorOverride: (descriptor) => {
        if (descriptor.kind !== "model_call") return null;
        return {
          kind: "model_call",
          async execute() {
            attempt += 1;
            if (attempt === 1) return textReply("first run complete");
            throw new Error(rawInvalidToolSchemaError());
          },
        } satisfies EffectExecutor;
      },
    });

    await harness.driver.handleIncoming(
      CHANNEL,
      promptIncoming("automation-one", "first", {
        origin: "scheduled",
        automation: {
          missionId: "mission-one",
          runId: "run-one",
          ownerUserId: "usr_owner",
          authoritySessionNonce: "nonce:run-one",
          name: "One",
          revision: 1,
          action: "prompt",
          trigger: "scheduled",
          startedAt: 1,
          createdAt: 1,
          schedule: { everyMs: 60_000 },
        },
      }),
    );
    await settle(harness.driver);
    await harness.driver.handleIncoming(
      CHANNEL,
      promptIncoming("automation-two", "second", {
        origin: "scheduled",
        automation: {
          missionId: "mission-two",
          runId: "run-two",
          ownerUserId: "usr_owner",
          authoritySessionNonce: "nonce:run-two",
          name: "Two",
          revision: 1,
          action: "prompt",
          trigger: "scheduled",
          startedAt: 2,
          createdAt: 1,
          schedule: { everyMs: 60_000 },
        },
      }),
    );
    await settle(harness.driver);

    expect(closed).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          automation: expect.objectContaining({ runId: "run-one" }),
        }),
        finalMessage: "first run complete",
      }),
      expect.objectContaining({
        metadata: expect.objectContaining({
          automation: expect.objectContaining({ runId: "run-two" }),
        }),
        reason: "work_failed",
      }),
    ]);
    expect(closed[1]).not.toHaveProperty("finalMessage");
  });

  it("deduplicates a replayed structured observation by source envelope", async () => {
    const harness = await makeHarness({
      script: { model: [textReply("done")], tool: [] },
    });
    const incoming = observationIncoming("observation-replayed");

    await harness.driver.handleIncoming(CHANNEL, incoming);
    await harness.driver.handleIncoming(CHANNEL, incoming);
    await settle(harness.driver);

    expect(
      (await logKinds(harness.gad)).filter((kind) => kind === "turn.opened"),
    ).toHaveLength(1);
    const userRows = inspectSql<{ rows: Array<{ payload_ref_json: string }> }>(
      harness.gad,
      `SELECT payload_ref_json FROM log_events WHERE log_id = ? AND payload_kind = 'message.completed' ORDER BY seq`,
      [LOG_ID],
    ).rows.filter((row) => JSON.parse(row.payload_ref_json).role === "user");
    expect(userRows).toHaveLength(1);
    expect(JSON.parse(userRows[0]!.payload_ref_json)).toMatchObject({
      structuredInput: incoming.command.structuredInput,
    });
  });

  it("admits different observation envelopes as different inputs", async () => {
    const harness = await makeHarness({
      script: { model: [textReply("first"), textReply("second")], tool: [] },
    });

    await harness.driver.handleIncoming(
      CHANNEL,
      observationIncoming("observation-a"),
    );
    await settle(harness.driver);
    await harness.driver.handleIncoming(
      CHANNEL,
      observationIncoming("observation-b"),
    );
    await settle(harness.driver);

    expect(
      (await logKinds(harness.gad)).filter((kind) => kind === "turn.opened"),
    ).toHaveLength(2);
    expect(
      (await harness.driver.loop(CHANNEL)).state.entries.filter(
        (entry) => entry.kind === "user",
      ),
    ).toHaveLength(2);
  });

  it("uses the existing steering queue for an observation during an open turn", async () => {
    const harness = await makeHarness({ script: { model: [], tool: [] } });

    await harness.driver.handleIncoming(
      CHANNEL,
      observationIncoming("observation-open-a"),
    );
    const preparation = harness.driver.outbox.all()[0];
    expect(preparation).toMatchObject({ kind: "prompt_artifacts" });
    await harness.driver.applyOutcome(preparation!, {
      kind: "prompt-artifacts",
      patch: {},
    });
    const originalTurnId = (await harness.driver.loop(CHANNEL)).state.openTurn
      ?.turnId;

    await harness.driver.handleIncoming(
      CHANNEL,
      observationIncoming("observation-open-b"),
    );

    const state = (await harness.driver.loop(CHANNEL)).state;
    expect(state.openTurn?.turnId).toBe(originalTurnId);
    expect(state.steeringQueue).toHaveLength(1);
    expect(state.steeringQueue[0]?.turnTriggerEnvelopeId).toBe(
      "observation-open-b",
    );
    expect(
      (await logKinds(harness.gad)).filter((kind) => kind === "turn.opened"),
    ).toHaveLength(1);
  });

  it("can retry the same observation after failure before prompt admission", async () => {
    let failAdmission = true;
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      gadFault: (method) =>
        failAdmission && method === "appendLogEvent"
          ? new Error("trajectory unavailable")
          : null,
    });
    const incoming = observationIncoming("observation-retry");

    await expect(
      harness.driver.handleIncoming(CHANNEL, incoming),
    ).rejects.toThrow("trajectory unavailable");
    failAdmission = false;
    await expect(
      harness.driver.handleIncoming(CHANNEL, incoming),
    ).resolves.toBeUndefined();

    expect(
      (await harness.driver.loop(CHANNEL)).state.entries.filter(
        (entry) => entry.kind === "user",
      ),
    ).toHaveLength(1);
  });

  it("records distinct provider attempts even when a retry reuses the message id", async () => {
    const harness = await makeHarness({ script: { model: [], tool: [] } });
    const record = (
      harness.driver as unknown as {
        recordModelExecutionAttempt(event: Record<string, unknown>): void;
      }
    ).recordModelExecutionAttempt.bind(harness.driver);
    for (const [attemptId, startedAt] of [
      ["attempt-a", "2026-07-13T10:00:00.000Z"],
      ["attempt-b", "2026-07-13T10:00:01.000Z"],
    ] as const) {
      record({
        phase: "started",
        attemptId,
        channelId: CHANNEL,
        messageId: "same-message",
        provider: "openai-codex",
        model: "gpt-5.3-codex-spark",
        ref: "openai-codex:gpt-5.3-codex-spark",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        auth: "url-bound",
        startedAt,
        transportRuntime: {
          workersFetchUpgradeAvailable: true,
          ambientWebSocketAvailable: true,
          vibestudioWebSocketRouteInstalled: true,
        },
      });
      record({
        phase: "finished",
        attemptId,
        completedAt: startedAt,
        outcome: attemptId === "attempt-a" ? "failed" : "completed",
        ...(attemptId === "attempt-a"
          ? { error: "retryable provider failure" }
          : { usage: { input: 10, output: 5, totalTokens: 15 } }),
      });
    }

    expect(await harness.driver.modelExecutionEvidence(CHANNEL)).toMatchObject({
      totalCalls: 2,
      truncated: false,
      calls: [
        {
          attemptId: "attempt-a",
          messageId: "same-message",
          outcome: "failed",
          transportRuntime: { vibestudioWebSocketRouteInstalled: true },
        },
        {
          attemptId: "attempt-b",
          messageId: "same-message",
          outcome: "completed",
          usage: { totalTokens: 15 },
        },
      ],
    });
  });

  it("reports journal-derived model execution routing and usage", async () => {
    const harness = await makeHarness({
      script: { model: [textReply("done")], tool: [] },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver);

    expect(await harness.driver.modelExecutionEvidence(CHANNEL)).toMatchObject({
      totalCalls: 1,
      truncated: false,
      calls: [
        {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          ref: "anthropic:claude-sonnet-4-6",
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          auth: "url-bound",
          outcome: "completed",
        },
      ],
    });
  });

  it("dispatches a read-ack before the pending model call completes", async () => {
    // The receipt is a best-effort, idempotent publish with no semantic
    // outcome, so it must not hold the durable chain behind a long model call.
    const started = deferred<void>();
    const hung = deferred<EffectOutcome>();
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "model_call"
          ? ({
              kind: "model_call",
              execute: () => {
                started.resolve();
                return hung.promise;
              },
            } as EffectExecutor)
          : null,
    });
    await harness.driver.handleIncoming(CHANNEL, {
      type: "command",
      command: {
        kind: "prompt",
        channelId: CHANNEL,
        source: { envelopeId: "env-1" },
        sourceMessageId: "u1",
        content: "hi",
        senderRef: {
          kind: "user",
          id: "panel:user",
          participantId: "panel:user",
        },
      },
    });
    const alarm = harness.driver.dispatchReadyEffectsForTest();
    await started.promise;
    expect(harness.readReceipts).toContainEqual(
      expect.objectContaining({ channelId: CHANNEL, messageId: "u1" }),
    );
    hung.resolve(textReply("done"));
    await alarm;
  });

  it("a long model_call on one channel does NOT pin the shared pump (other channels still dispatch)", async () => {
    // Long effects are awaited by their alarm event. A later alarm delivery can
    // still lease and dispatch another channel while channel A is awaiting I/O.
    const CHANNEL_B = "chan-d2";
    const hung = deferred<EffectOutcome>();
    const aStarted = deferred<void>();
    let bModelCalls = 0;
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) => {
        if (descriptor.kind !== "model_call") return null;
        if (descriptor.channelId === CHANNEL) {
          return {
            kind: "model_call",
            execute: () => {
              aStarted.resolve();
              return hung.promise;
            },
          } as EffectExecutor;
        }
        return {
          kind: "model_call",
          async execute() {
            bModelCalls += 1;
            return textReply("hi from B");
          },
        } as EffectExecutor;
      },
    });
    // Channel A's first alarm owns a model call that remains pending.
    await harness.driver.handleIncoming(CHANNEL, promptIncoming("env-a"));
    const alarmA = harness.driver.dispatchReadyEffectsForTest();
    alarmA.catch(() => undefined);
    await aStarted.promise;
    // Channel B: a different channel's turn must still dispatch + complete.
    await harness.driver.handleIncoming(CHANNEL_B, {
      type: "command",
      command: {
        kind: "prompt",
        channelId: CHANNEL_B,
        source: { envelopeId: "env-b" },
        content: "hi",
        senderRef: {
          kind: "user",
          id: "panel:user",
          participantId: "panel:user",
        },
      },
    });
    await harness.driver.dispatchReadyEffectsForTest();
    // Channel B got its model call despite channel A's model hanging.
    expect(bModelCalls).toBe(1);
    hung.resolve(textReply("A recovered"));
    await alarmA;
  });

  it("does not let a non-cooperative executor hold the interrupt boundary", async () => {
    const started = deferred<void>();
    const finish = deferred<EffectOutcome>();
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "model_call"
          ? ({
              kind: "model_call",
              execute: () => {
                started.resolve();
                return finish.promise;
              },
            } as EffectExecutor)
          : null,
    });
    await harness.driver.handleIncoming(CHANNEL, promptIncoming("env-abort"));
    const { completion } = harness.driver.beginReadyEffectDispatchForTest();
    await started.promise;
    let completionSettled = false;
    void completion.then(() => {
      completionSettled = true;
    });
    await Promise.resolve();
    expect(completionSettled).toBe(false);

    await harness.driver.interruptChannel(CHANNEL);
    await completion;
    const kindsAfterInterrupt = await logKinds(harness.gad);

    finish.resolve({
      kind: "model",
      blocks: [{ type: "text", text: "too late" }],
      stopReason: "completed",
    });
    await Promise.resolve();
    expect(await logKinds(harness.gad)).toEqual(kindsAfterInterrupt);
    expect(harness.driver.outbox.all()).toEqual([]);
  });

  it("settles an admitted mutation before journaling a user interrupt", async () => {
    const started = deferred<void>();
    let committed = false;
    const mutationConfig: AgentLoopConfig = {
      ...config,
      activeToolNames: ["write"],
      localToolExecutionModes: { write: "sequential" },
      localToolCancellationModes: { write: "settle" },
    };
    const harness = await makeHarness({
      config: mutationConfig,
      script: {
        model: [
          {
            kind: "model",
            blocks: [
              {
                type: "toolCall",
                id: "write-1",
                name: "write",
                arguments: { path: "meta/out.txt", content: "value" },
              },
            ],
            stopReason: "completed",
          },
        ],
        tool: [],
      },
      executorOverride: (descriptor) =>
        descriptor.kind === "local_tool"
          ? ({
              kind: "local_tool",
              execute: ({ signal }) => {
                started.resolve();
                return new Promise<EffectOutcome>((resolve) => {
                  signal.addEventListener(
                    "abort",
                    () => {
                      // Models the tool's atomic RPC returning success after
                      // the parent cancellation raced with its commit.
                      committed = true;
                      resolve({
                        kind: "tool",
                        result: {
                          protocolContent: [
                            { type: "text", text: "write committed" },
                          ],
                          details: { committed: true },
                        },
                        isError: false,
                      });
                    },
                    { once: true },
                  );
                });
              },
            } as EffectExecutor)
          : null,
    });
    await harness.driver.handleIncoming(
      CHANNEL,
      promptIncoming("env-settle-mutation"),
    );
    const dispatch = harness.driver.dispatchReadyEffectsForTest();
    await started.promise;

    await harness.driver.interruptChannel(CHANNEL);
    await dispatch;

    expect(committed).toBe(true);
    const rows = harness.gad.sql
      .exec(
        `SELECT payload_kind FROM log_events
         WHERE log_id = ? AND payload_kind IN ('invocation.completed', 'system.event')
         ORDER BY seq`,
        LOG_ID,
      )
      .toArray();
    const terminalKinds = rows.map((row) => row["payload_kind"]);
    expect(terminalKinds.lastIndexOf("invocation.completed")).toBeLessThan(
      terminalKinds.lastIndexOf("system.event"),
    );
    expect(harness.driver.outbox.all()).toEqual([]);
  });

  it("fences non-cooperative model work before channel retirement returns", async () => {
    const started = deferred<void>();
    const finish = deferred<EffectOutcome>();
    const retirementOrder: string[] = [];
    let retiring = false;
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "model_call"
          ? ({
              kind: "model_call",
              execute: ({ signal }) => {
                started.resolve();
                signal.addEventListener(
                  "abort",
                  () => {
                    retirementOrder.push("executor-aborted");
                  },
                  { once: true },
                );
                return finish.promise;
              },
            } as EffectExecutor)
          : null,
      onGadCall: (method) => {
        if (retiring && method === "appendLogEvent")
          retirementOrder.push("retirement-journal");
      },
    });
    await harness.driver.handleIncoming(
      CHANNEL,
      promptIncoming("env-channel-retire"),
    );
    const { completion } = harness.driver.beginReadyEffectDispatchForTest();
    await started.promise;

    retiring = true;
    await harness.driver.abortChannel(CHANNEL, "channel_unsubscribe");
    await completion;
    expect(retirementOrder[0]).toBe("executor-aborted");
    expect(retirementOrder).toContain("retirement-journal");
    const kindsAfterRetirement = await logKinds(harness.gad);

    finish.resolve({
      kind: "model",
      blocks: [{ type: "text", text: "too late" }],
      stopReason: "completed",
    });
    await Promise.resolve();
    expect(await logKinds(harness.gad)).toEqual(kindsAfterRetirement);
    expect(harness.driver.outbox.all()).toEqual([]);

    await harness.driver.wake(CHANNEL);
    await harness.driver.handleIncoming(
      CHANNEL,
      promptIncoming("env-after-retirement"),
    );
    await harness.driver.dispatchReadyEffectsForTest();
    expect(await logKinds(harness.gad)).toEqual(kindsAfterRetirement);

    harness.driver.activateChannel(CHANNEL);
    await harness.driver.handleIncoming(
      CHANNEL,
      promptIncoming("env-after-reactivation"),
    );
    expect(harness.driver.outbox.all()).not.toEqual([]);
  });

  it("persists channel retirement after a user interrupt without reusing its envelope id", async () => {
    const started = deferred<void>();
    const hung = deferred<EffectOutcome>();
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "model_call"
          ? ({
              kind: "model_call",
              execute: () => {
                started.resolve();
                return hung.promise;
              },
            } as EffectExecutor)
          : null,
    });
    await harness.driver.handleIncoming(
      CHANNEL,
      promptIncoming("env-retire-after-interrupt"),
    );
    const alarm = harness.driver.dispatchReadyEffectsForTest();
    await started.promise;

    await harness.driver.handleIncoming(CHANNEL, {
      type: "command",
      command: { kind: "interrupt" },
    });
    await harness.driver.abortChannel(CHANNEL, "channel_unsubscribe");
    hung.resolve({ kind: "model", blocks: [], stopReason: "aborted" });
    await alarm;

    const turnId = ids.turnId(
      CHANNEL,
      "env-retire-after-interrupt",
      "agent:self",
    );
    const rows = inspectSql<{ rows: Array<{ envelope_id: string }> }>(
      harness.gad,
      `SELECT envelope_id FROM log_events
       WHERE log_id = '${LOG_ID}'
         AND payload_kind = 'system.event'
         AND envelope_id LIKE '%:interrupt:%'
       ORDER BY seq`,
    );
    expect(rows.rows.map((row) => row.envelope_id)).toEqual([
      ids.interruptEvent(turnId, "user_interrupted"),
      ids.interruptEvent(turnId, "channel_unsubscribe"),
    ]);
  });

  it("releases an executor waiting in ensureLoaded without journaling a semantic terminal", async () => {
    const started = deferred<void>();
    let executions = 0;
    const ensureLoaded = vi.fn(
      (_modelId: string, signal: AbortSignal) =>
        new Promise<EffectOutcome>((_resolve, reject) => {
          executions += 1;
          started.resolve();
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "model_call"
          ? ({
              kind: "model_call",
              execute: ({ signal }) => ensureLoaded("lfm2.5-2.6b", signal),
            } as EffectExecutor)
          : null,
    });
    await harness.driver.handleIncoming(CHANNEL, promptIncoming("env-release"));
    const alarm = harness.driver.dispatchReadyEffectsForTest();
    await started.promise;

    await expect(harness.driver.releaseActivation()).resolves.toBe(1);
    await alarm;
    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
    ]);
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({ kind: "model_call", attempts: 0 }),
    ]);

    await harness.driver.dispatchReadyEffectsForTest();
    expect(executions).toBe(1);
    expect(ensureLoaded).toHaveBeenCalledWith(
      "lfm2.5-2.6b",
      expect.any(AbortSignal),
    );
  });

  it("does not let a non-cooperative executor hold lifecycle release or journal a late result", async () => {
    const started = deferred<void>();
    const finish = deferred<EffectOutcome>();
    let observedSignal: AbortSignal | null = null;
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "model_call"
          ? ({
              kind: "model_call",
              execute: ({ signal }) => {
                observedSignal = signal;
                started.resolve();
                return finish.promise;
              },
            } as EffectExecutor)
          : null,
    });
    await harness.driver.handleIncoming(
      CHANNEL,
      promptIncoming("env-noncooperative-release"),
    );
    const { completion } = harness.driver.beginReadyEffectDispatchForTest();
    await started.promise;
    let completionSettled = false;
    void completion.then(() => {
      completionSettled = true;
    });
    await Promise.resolve();
    expect(completionSettled).toBe(false);

    let released = false;
    const release = harness.driver.releaseActivation().then((count) => {
      released = true;
      return count;
    });
    await Promise.resolve();
    expect(released).toBe(true);
    await expect(release).resolves.toBe(1);
    expect((observedSignal as AbortSignal | null)?.aborted).toBe(true);

    finish.resolve({
      kind: "model",
      blocks: [{ type: "text", text: "too late" }],
      stopReason: "completed",
    });
    await completion;
    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
    ]);
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({ kind: "model_call", attempts: 0 }),
    ]);
  });

  it("re-evaluates authority when a protected port is used during an active effect", async () => {
    const started = deferred<void>();
    const continueExecution = deferred<void>();
    let allowed = true;
    const publish = vi.fn(async () => {
      if (!allowed) throw new Error("authority revoked");
    });
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      channelPublish: publish,
      executorOverride: (descriptor) =>
        descriptor.kind === "model_call"
          ? ({
              kind: "model_call",
              async execute({ deps }) {
                started.resolve();
                await continueExecution.promise;
                await deps.channel.publish({
                  channelId: CHANNEL,
                  payloadKind: "agentic.trajectory.v1/event",
                  payload: { kind: "message.completed" },
                  idempotencyKey: "authority-probe",
                });
                return textReply("should not commit");
              },
            } as EffectExecutor)
          : null,
    });

    await harness.driver.handleIncoming(
      CHANNEL,
      promptIncoming("env-authority"),
    );
    const alarm = harness.driver
      .dispatchReadyEffectsForTest()
      .catch(() => undefined);
    await started.promise;
    allowed = false;
    continueExecution.resolve();
    await alarm;

    expect(publish).toHaveBeenCalledOnce();
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({ kind: "model_call", attempts: 1 }),
    ]);
    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
    ]);
  });

  it("closes effect admission while the interrupt marker is being journaled", async () => {
    let modelCalls = 0;
    const modelStarted = deferred<void>();
    const interruptEntered = deferred<void>();
    const releaseInterrupt = deferred<void>();
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "model_call"
          ? ({
              kind: "model_call",
              execute({ signal }) {
                modelCalls += 1;
                modelStarted.resolve();
                return new Promise<EffectOutcome>((resolve) => {
                  signal.addEventListener(
                    "abort",
                    () =>
                      resolve({
                        kind: "model",
                        blocks: [],
                        stopReason: "aborted",
                      }),
                    { once: true },
                  );
                });
              },
            } as EffectExecutor)
          : null,
    });
    await harness.driver.handleIncoming(
      CHANNEL,
      promptIncoming("env-admission"),
    );
    const alarm = harness.driver.dispatchReadyEffectsForTest();
    await modelStarted.promise;
    const handleIncoming = harness.driver.handleIncoming.bind(harness.driver);
    vi.spyOn(harness.driver, "handleIncoming").mockImplementation(
      async (channelId, incoming) => {
        if (
          incoming.type === "command" &&
          incoming.command.kind === "interrupt"
        ) {
          interruptEntered.resolve();
          await releaseInterrupt.promise;
        }
        await handleIncoming(channelId, incoming);
      },
    );

    const interrupt = harness.driver.interruptChannel(CHANNEL);
    await interruptEntered.promise;
    await harness.driver.dispatchReadyEffectsForTest();
    expect(modelCalls).toBe(1);

    releaseInterrupt.resolve();
    await interrupt;
    await alarm;
    expect(harness.driver.outbox.all()).toEqual([]);
  });

  it("does not execute effects outside the alarm owner and propagates alarm failures", async () => {
    let failAppends = false;
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "model_call"
          ? ({
              kind: "model_call",
              async execute() {
                failAppends = true;
                return textReply("done");
              },
            } as EffectExecutor)
          : null,
      gadFault: (method) =>
        failAppends && method === "appendLogEvent"
          ? new Error("append down")
          : null,
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming("env-bg-fail"));
    expect(failAppends).toBe(false);

    await expect(harness.driver.dispatchReadyEffectsForTest()).rejects.toThrow(
      "append down",
    );
    expect(harness.driver.outbox.all()[0]).toEqual(
      expect.objectContaining({
        disposition: "leased",
        leaseOwner: "agent-loop-driver:test-host",
      }),
    );
  });

  it("surfaces a divergent outcome id collision without consuming the effect", async () => {
    let rejectOutcomeAppend = false;
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "model_call"
          ? ({
              kind: "model_call",
              async execute() {
                rejectOutcomeAppend = true;
                return textReply("done");
              },
            } as EffectExecutor)
          : null,
      gadFault: (method) =>
        rejectOutcomeAppend && method === "appendLogEvent"
          ? new Error("GadAppendError[id-collision]: divergent terminal")
          : null,
    });

    await harness.driver.handleIncoming(
      CHANNEL,
      promptIncoming("env-collision"),
    );
    await expect(harness.driver.dispatchReadyEffectsForTest()).rejects.toThrow(
      "GadAppendError[id-collision]",
    );
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({
        kind: "model_call",
        disposition: "leased",
      }),
    ]);
    expect(
      (await harness.driver.loop(CHANNEL)).state.inFlightModelCall,
    ).not.toBeNull();
  });

  it("stamps channel-specific self identity on durable turn events", async () => {
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      selfRefFor: (channelId) => ({
        kind: "agent",
        id: `agent:${channelId}`,
        participantId: `agent:${channelId}`,
        displayName: "AI Chat",
        metadata: { type: "agent", name: "AI Chat", handle: "ai-chat" },
      }),
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver);

    const rows = inspectSql<{ rows: Array<{ actor_json: string }> }>(
      harness.gad,
      `SELECT actor_json FROM log_events WHERE log_id = '${LOG_ID}' AND payload_kind = 'turn.opened' ORDER BY seq`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(JSON.parse(rows.rows[0]!.actor_json)).toEqual({
      kind: "agent",
      id: `agent:${CHANNEL}`,
      participantId: `agent:${CHANNEL}`,
      displayName: "AI Chat",
      metadata: { type: "agent", name: "AI Chat", handle: "ai-chat" },
    });
  });

  it("stamps provider-qualified model provenance on assistant completions", async () => {
    const harness = await makeHarness({
      script: { model: [textReply("done")], tool: [] },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver);

    const rows = inspectSql<{ rows: Array<{ payload_ref_json: string }> }>(
      harness.gad,
      `SELECT payload_ref_json FROM log_events WHERE log_id = '${LOG_ID}' AND payload_kind = 'message.completed' ORDER BY seq`,
    );
    const assistantCompleted = rows.rows
      .map((row) => JSON.parse(row.payload_ref_json) as Record<string, unknown>)
      .find((payload) => payload["role"] === "assistant");

    expect(assistantCompleted?.["model"]).toMatchObject({
      ref: "anthropic:claude-sonnet-4-6",
      provider: "anthropic",
      displayName: "anthropic:claude-sonnet-4-6",
    });
  });

  it("accepts the first ask_user answer and cancels every other human form", async () => {
    const askConfig: AgentLoopConfig = {
      ...config,
      roster: {
        participants: ["alice", "bob"].map((handle) => ({
          participantId: `user:${handle}`,
          ref: {
            kind: "user" as const,
            id: `user:${handle}`,
            participantId: `user:${handle}`,
          },
          type: "user",
          handle,
          methods: [{ name: "feedback_form" }],
        })),
      },
    };
    const harness = await makeHarness({
      config: askConfig,
      policies: [askUserPolicy()],
      script: {
        model: [
          {
            kind: "model",
            blocks: [
              {
                type: "toolCall",
                id: "tc-ask",
                name: "ask_user",
                arguments: { question: "Choose" },
              },
            ],
            stopReason: "completed",
          },
        ],
        tool: [],
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver, 2);
    expect(harness.channelCalls).toHaveLength(2);
    const askRows = harness.driver.outbox
      .all()
      .filter((row) => row.descriptor.kind === "channel_call");
    expect(askRows).toHaveLength(2);

    // Bob answers first (the secondary effect). The canonical invocation
    // terminal wins and Alice's still-open form is cancelled immediately.
    const bob = askRows.find((row) => row.effectId.includes("#user:bob"))!;
    await harness.driver.deliverEffectOutcome(
      bob.effectId,
      { kind: "tool", result: { answer: "yes" }, isError: false },
      { channelId: CHANNEL },
    );

    expect(
      harness.driver.outbox
        .all()
        .filter((row) => row.descriptor.kind === "channel_call"),
    ).toHaveLength(0);
    expect(harness.cancelledChannelCalls).toEqual([
      {
        channelId: CHANNEL,
        transportCallId: ids.transportCallId("tc-ask"),
      },
    ]);
    const terminalRows = inspectSql<{
      rows: Array<{ envelope_id: string }>;
    }>(
      harness.gad,
      `SELECT envelope_id FROM log_events WHERE log_id = '${LOG_ID}' AND payload_kind = 'invocation.completed'`,
    );
    expect(terminalRows.rows).toEqual([
      { envelope_id: ids.invocationTerminal("tc-ask") },
    ]);
  });

  it("keeps equal effect ids isolated by branch", async () => {
    const harness = await makeHarness({
      script: { model: [], tool: [] },
    });
    const effectFor = (channelId: string): EffectDescriptor => ({
      kind: "local_tool",
      effectId: ids.invocationEffect("tc-1"),
      channelId,
      idempotencyKey: "tc-1",
      invocationId: "tc-1",
      turnId: `turn:${channelId}`,
      invocationSeq: 1,
      executionMode: "parallel",
      cancellationMode: "interruptible",
      tool: "read",
      args: {},
    });

    const otherChannel = "chan-other";
    const otherLog = logIdForChannel(otherChannel);
    harness.driver.outbox.insert(LOG_ID, effectFor(CHANNEL), null);
    harness.driver.outbox.insert(otherLog, effectFor(otherChannel), null);

    expect(harness.driver.outbox.all()).toHaveLength(2);
    expect(
      harness.driver.outbox.get(LOG_ID, ids.invocationEffect("tc-1"))
        ?.channelId,
    ).toBe(CHANNEL);
    expect(
      harness.driver.outbox.get(otherLog, ids.invocationEffect("tc-1"))
        ?.channelId,
    ).toBe(otherChannel);
  });

  it("redrives only parked eval effects when a runtime generation is replaced", async () => {
    const harness = await makeHarness({ script: { model: [], tool: [] } });
    const effect = (invocationId: string, tool: string): EffectDescriptor => ({
      kind: "local_tool",
      effectId: ids.invocationEffect(invocationId),
      channelId: CHANNEL,
      idempotencyKey: invocationId,
      invocationId,
      turnId: "turn:restart",
      invocationSeq: tool === "eval" ? 1 : 2,
      executionMode: "parallel",
      cancellationMode: "interruptible",
      tool,
      args: {},
    });
    harness.driver.outbox.insert(LOG_ID, effect("eval-1", "eval"), null);
    harness.driver.outbox.insert(LOG_ID, effect("read-1", "read"), null);
    harness.driverHost.sql.exec(
      `UPDATE effect_outbox SET disposition = 'parked', next_attempt_at = ?`,
      Date.now() + 60_000,
    );

    harness.driver.reconcileDeferredEvalRuns();

    expect(
      harness.driver.outbox.get(LOG_ID, ids.invocationEffect("eval-1")),
    ).toMatchObject({
      disposition: "ready",
      leaseOwner: null,
    });
    expect(
      harness.driver.outbox.get(LOG_ID, ids.invocationEffect("read-1")),
    ).toMatchObject({
      disposition: "parked",
    });
  });

  it("dispatches local tools in durable ordered waves around sequential barriers", async () => {
    const starts: string[] = [];
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "local_tool"
          ? {
              kind: "local_tool",
              async execute() {
                starts.push(descriptor.tool);
                return { deferred: true, reason: "external-result" };
              },
            }
          : null,
    });
    const effect = (
      invocationSeq: number,
      tool: string,
      executionMode: "sequential" | "parallel",
    ): EffectDescriptor => ({
      kind: "local_tool",
      effectId: ids.invocationEffect(`tc-${invocationSeq}`),
      channelId: CHANNEL,
      idempotencyKey: `tc-${invocationSeq}`,
      invocationId: `tc-${invocationSeq}`,
      turnId: "turn:ordered-wave",
      invocationSeq,
      executionMode,
      cancellationMode: "interruptible",
      tool,
      args: {},
    });
    const rows = [
      effect(10, "read-a", "parallel"),
      effect(11, "read-b", "parallel"),
      effect(12, "write-a", "sequential"),
      effect(13, "read-after-write", "parallel"),
      effect(14, "write-b", "sequential"),
    ];
    for (const descriptor of rows)
      harness.driver.outbox.insert(LOG_ID, descriptor, null);

    await harness.driver.dispatchReadyEffectsForTest();
    expect(starts).toEqual(["read-a", "read-b"]);

    for (const descriptor of rows.slice(0, 2)) {
      harness.driver.outbox.delete(LOG_ID, descriptor.effectId);
    }
    await harness.driver.dispatchReadyEffectsForTest();
    expect(starts).toEqual(["read-a", "read-b", "write-a"]);

    // A deferred/leased mutation remains a durable barrier. A later read must
    // not observe the pre-mutation state merely because another alarm fires.
    await harness.driver.dispatchReadyEffectsForTest();
    expect(starts).toEqual(["read-a", "read-b", "write-a"]);

    harness.driver.outbox.delete(LOG_ID, rows[2]!.effectId);
    await harness.driver.dispatchReadyEffectsForTest();
    expect(starts).toEqual(["read-a", "read-b", "write-a", "read-after-write"]);

    harness.driver.outbox.delete(LOG_ID, rows[3]!.effectId);
    await harness.driver.dispatchReadyEffectsForTest();
    expect(starts).toEqual([
      "read-a",
      "read-b",
      "write-a",
      "read-after-write",
      "write-b",
    ]);
  });

  it("applies policy filters to executor-side ephemeral signals", async () => {
    const messageId = ids.messageId(
      ids.turnId(CHANNEL, "env-1", "agent:self"),
      1,
    );
    const dropEphemeral: StepPolicy = {
      name: "drop-ephemeral",
      intercept: ({ output }) => output,
      filterEphemeral: () => null,
    };
    const harness = await makeHarness({
      script: { model: [textReply("done")], tool: [] },
      policies: [dropEphemeral],
      ephemeral: {
        kind: "signal-event",
        channelId: CHANNEL,
        event: {
          kind: "message.delta",
          actor: {
            kind: "agent",
            id: "agent:self",
            participantId: "agent:self",
          },
          causality: { messageId: messageId as never },
          payload: {
            protocol: "agentic.trajectory.v1",
            blockId: `${messageId}:block:0` as never,
            type: "text",
            text: "streamed",
          },
          createdAt: new Date(0).toISOString(),
        } as never,
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver);

    expect(harness.ephemerals).toEqual([]);
  });

  it("runs prompt → model → tool → model → close against the real gad store", async () => {
    const harness = await makeHarness({
      script: {
        model: [toolCallReply("tc-1"), textReply("done")],
        tool: [toolOk],
      },
    });
    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver);

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed", // recv user
      "turn.opened",
      "message.started",
      "message.completed", // assistant w/ tool call
      "invocation.started",
      "invocation.completed",
      "message.started",
      "message.completed", // assistant final
      "turn.closed",
    ]);
    // outbox drained; channel log got the published events
    expect(harness.driver.outbox.all()).toHaveLength(0);
    const channelRows = inspectSql<{ rows: Array<{ cnt: number }> }>(
      harness.gad,
      `SELECT COUNT(*) AS cnt FROM log_events WHERE log_id = '${CHANNEL}'`,
    );
    expect(channelRows.rows[0]!.cnt).toBeGreaterThan(0);
    const publicationRows = inspectSql<{
      rows: Array<{ envelope_id: string }>;
    }>(
      harness.gad,
      `SELECT envelope_id FROM publication_delivery_outbox ORDER BY created_at, item_id`,
    );
    expect(publicationRows.rows.map((row) => row.envelope_id)).toContain(
      `pub:${ids.messageTerminal(ids.messageId(ids.turnId(CHANNEL, "env-1", "agent:self"), 1))}:${CHANNEL}`,
    );
  });

  it("keeps only the matching channel terminal retryable until its effect materializes", async () => {
    const invocationId = "tc-fast-channel";
    const effectId = ids.invocationEffect(invocationId);
    const started = deferred<void>();
    const firstModel = deferred<EffectOutcome>();
    let modelCalls = 0;
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      config: {
        ...config,
        roster: {
          participants: [
            {
              participantId: "panel:user",
              ref: {
                kind: "panel",
                id: "panel:user",
                participantId: "panel:user",
              },
              type: "panel",
              methods: [{ name: "set_title" }],
            },
          ],
        },
      },
      executorOverride: (descriptor) =>
        descriptor.kind === "model_call"
          ? ({
              kind: "model_call",
              execute: () => {
                modelCalls += 1;
                if (modelCalls === 1) {
                  started.resolve();
                  return firstModel.promise;
                }
                return Promise.resolve(textReply("done"));
              },
            } as EffectExecutor)
          : null,
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    const modelDispatch = harness.driver.dispatchReadyEffectsForTest();
    await started.promise;
    // An unrelated in-flight model call is not evidence that this particular
    // invocation can materialize.
    expect(
      await harness.driver.channelCallMayMaterialize(CHANNEL, effectId),
    ).toBe(false);

    firstModel.resolve({
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: invocationId,
          name: "set_title",
          arguments: { title: "Fast title" },
        },
      ],
      stopReason: "completed",
    });
    await modelDispatch;
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({ effectId, kind: "channel_call" }),
    ]);
    expect(
      await harness.driver.channelCallMayMaterialize(CHANNEL, effectId),
    ).toBe(true);

    await harness.driver.deliverEffectOutcome(
      effectId,
      { kind: "tool", result: { ok: true }, isError: false },
      { channelId: CHANNEL },
    );
    await settle(harness.driver);
    expect(
      await harness.driver.channelCallMayMaterialize(CHANNEL, effectId),
    ).toBe(false);
  });

  it("a deferred local_tool (eval) parks the row + keeps the turn open; deliverEffectOutcome completes it → next model call", async () => {
    let toolDispatches = 0;
    const harness = await makeHarness({
      script: { model: [toolCallReply("tc-1"), textReply("done")], tool: [] },
      executorOverride: (descriptor) => {
        if (descriptor.kind !== "local_tool") return null;
        // Mirror the agent's eval gate: a local tool that DEFERS (eval.start kicked off; the
        // result arrives out-of-band via onEvalComplete → deliverEffectOutcome).
        return {
          kind: "local_tool",
          async execute() {
            toolDispatches += 1;
            return { deferred: true, reason: "external-result" };
          },
        } satisfies EffectExecutor;
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver);

    // The deferred local_tool PARKS (row kept, not deleted) and the turn stays OPEN / non-stranded
    // — its PendingInvocation in the fold is the keep-alive (no credential-style turn.waiting needed).
    expect(toolDispatches).toBe(1);
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({ kind: "local_tool" }),
    ]);
    expect((await harness.driver.loop(CHANNEL)).state.openTurn).not.toBeNull();

    // Deliver the result out-of-band (exactly what the agent's onEvalComplete does).
    await harness.driver.deliverEffectOutcome(
      ids.invocationEffect("tc-1"),
      {
        kind: "tool",
        result: {
          protocolContent: [{ type: "text", text: "[eval] ok" }],
          details: { success: true },
        },
        isError: false,
      },
      { channelId: CHANNEL },
    );
    await settle(harness.driver);

    // Row drained; the invocation completed, the next model call ran, the turn closed.
    expect(harness.driver.outbox.all()).toHaveLength(0);
    const kinds = await logKinds(harness.gad);
    expect(kinds).toContain("invocation.completed");
    expect(kinds).toContain("turn.closed");
    expect((await harness.driver.loop(CHANNEL)).state.openTurn).toBeNull();
  });

  it("reconciles a lost eval terminal after a runtime generation change without re-executing", async () => {
    const invocationId = "tc-generation-loss";
    const effectId = ids.invocationEffect(invocationId);
    const evalToolCall: EffectOutcome = {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: invocationId,
          name: "eval",
          arguments: { code: "1+1" },
        },
      ],
      stopReason: "completed",
    };
    let driver!: AgentLoopDriver;
    let evalStarts = 0;
    let canonicalReads = 0;
    let terminalDurable = false;
    const harness = await makeHarness({
      script: { model: [evalToolCall, textReply("done")], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "local_tool" && descriptor.tool === "eval"
          ? ({
              kind: "local_tool",
              async execute() {
                if (!driver.hasDeferredEvalStartAttempted(CHANNEL, effectId)) {
                  evalStarts += 1;
                  driver.markDeferredEvalStartAttempted(CHANNEL, effectId);
                  return { deferred: true, reason: "external-result" };
                }
                canonicalReads += 1;
                if (!terminalDurable)
                  return { deferred: true, reason: "external-result" };
                return {
                  kind: "tool",
                  result: {
                    protocolContent: [{ type: "text", text: "[eval] 2" }],
                    details: { success: true },
                  },
                  isError: false,
                };
              },
            } satisfies EffectExecutor)
          : null,
    });
    driver = harness.driver;

    await driver.handleIncoming(CHANNEL, promptIncoming("env-generation-loss"));
    await settle(driver);
    expect(driver.outbox.get(LOG_ID, effectId)).toMatchObject({
      disposition: "parked",
    });
    expect(evalStarts).toBe(1);

    // EvalDO durably committed its terminal, but the live onEvalComplete push
    // was lost with the old process generation.
    terminalDurable = true;
    driver.reconcileDeferredEvalRuns();
    await settle(driver);

    expect(evalStarts).toBe(1);
    expect(canonicalReads).toBe(1);
    expect(driver.outbox.get(LOG_ID, effectId)).toBeNull();
    expect(await logKinds(harness.gad)).toContain("invocation.completed");
    expect((await driver.loop(CHANNEL)).state.openTurn).toBeNull();
  });

  it("redrives an authority-deferred model call as soon as authority changes", async () => {
    let modelDispatches = 0;
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "model_call"
          ? ({
              kind: "model_call",
              async execute() {
                modelDispatches += 1;
                return modelDispatches === 1
                  ? { deferred: true, reason: "authority" }
                  : textReply("approved");
              },
            } satisfies EffectExecutor)
          : null,
    });

    await harness.driver.handleIncoming(
      CHANNEL,
      promptIncoming("env-authority-deferred"),
    );
    await settle(harness.driver);

    const parked = harness.driver.outbox.all();
    expect(modelDispatches).toBe(1);
    expect(parked).toEqual([
      expect.objectContaining({
        kind: "model_call",
        disposition: "parked",
        nextAttemptAt: expect.any(Number),
      }),
    ]);

    harness.driver.nudgeAuthorityRedrive();
    const nudged = harness.driver.outbox.all()[0]!;
    expect(nudged.nextAttemptAt).toBeLessThan(parked[0]!.nextAttemptAt!);

    await settle(harness.driver);
    expect(modelDispatches).toBe(2);
    expect(harness.driver.outbox.all()).toHaveLength(0);
    expect((await harness.driver.loop(CHANNEL)).state.openTurn).toBeNull();
  });

  it("preserves an authority wake that races the executor's deferred acknowledgement", async () => {
    const started = deferred<void>();
    const deferredAck = deferred<{ deferred: true; reason: "authority" }>();
    let modelDispatches = 0;
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "model_call"
          ? ({
              kind: "model_call",
              async execute() {
                modelDispatches += 1;
                if (modelDispatches === 1) {
                  started.resolve();
                  return deferredAck.promise;
                }
                return textReply("approved");
              },
            } satisfies EffectExecutor)
          : null,
    });

    await harness.driver.handleIncoming(
      CHANNEL,
      promptIncoming("env-racing-authority"),
    );
    const dispatch = harness.driver.dispatchReadyEffectsForTest();
    await started.promise;
    expect(harness.driver.outbox.all()[0]).toMatchObject({
      kind: "model_call",
      disposition: "leased",
      nextAttemptAt: null,
    });

    harness.driver.nudgeAuthorityRedrive();
    expect(harness.driver.outbox.all()[0]).toMatchObject({
      disposition: "leased",
      nextAttemptAt: expect.any(Number),
    });

    deferredAck.resolve({ deferred: true, reason: "authority" });
    await dispatch;
    await settle(harness.driver);
    expect(modelDispatches).toBe(2);
    expect(harness.driver.outbox.all()).toHaveLength(0);
  });

  it("does not redrive effects awaiting an external result when authority changes", async () => {
    let toolDispatches = 0;
    const harness = await makeHarness({
      script: { model: [toolCallReply("tc-1")], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "local_tool"
          ? ({
              kind: "local_tool",
              async execute() {
                toolDispatches += 1;
                return { deferred: true, reason: "external-result" };
              },
            } satisfies EffectExecutor)
          : null,
    });

    await harness.driver.handleIncoming(
      CHANNEL,
      promptIncoming("env-external-deferred"),
    );
    await settle(harness.driver);

    const parked = harness.driver.outbox.all()[0]!;
    expect(parked).toMatchObject({ kind: "local_tool", disposition: "parked" });
    expect(toolDispatches).toBe(1);

    harness.driver.nudgeAuthorityRedrive();
    expect(harness.driver.outbox.all()[0]!.nextAttemptAt).toBe(
      parked.nextAttemptAt,
    );
    await harness.driver.dispatchReadyEffectsForTest();
    expect(toolDispatches).toBe(1);
  });

  it("a duplicate deliverEffectOutcome for a deferred eval is a harmless no-op (the push + poll-backstop both fire)", async () => {
    const harness = await makeHarness({
      script: { model: [toolCallReply("tc-1"), textReply("done")], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "local_tool"
          ? ({
              kind: "local_tool",
              async execute() {
                return { deferred: true, reason: "external-result" };
              },
            } satisfies EffectExecutor)
          : null,
    });
    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver);

    const outcome: EffectOutcome = {
      kind: "tool",
      result: { protocolContent: [{ type: "text", text: "ok" }], details: {} },
      isError: false,
    };
    await expect(
      harness.driver.deliverEffectOutcome(
        ids.invocationEffect("tc-1"),
        outcome,
        {
          channelId: CHANNEL,
        },
      ),
    ).resolves.toBe(true);
    await settle(harness.driver);
    const kindsAfterFirst = await logKinds(harness.gad);

    // Second delivery (the getRun poll backstop racing the onEvalComplete push) — idempotent no-op.
    await expect(
      harness.driver.deliverEffectOutcome(
        ids.invocationEffect("tc-1"),
        outcome,
        {
          channelId: CHANNEL,
        },
      ),
    ).resolves.toBe(false);
    await settle(harness.driver);
    expect(await logKinds(harness.gad)).toEqual(kindsAfterFirst);
  });

  it("F3: a TRANSIENT store-load error during deliverEffectOutcome must NOT silently drop the outcome", async () => {
    // Park a deferred local_tool (the eval pattern), then make the store FAIL on the next fold-load
    // (getLogHead) so deliverEffectOutcome → applyOutcome → loopForBranch hits a transient error.
    // Previously loopForBranch swallowed this as `null` and the arriving outcome was DROPPED with the
    // row left parked forever. Now the error propagates: the row stays parked and a later redelivery
    // (after the store recovers) completes the invocation.
    let faultArmed = false;
    const harness = await makeHarness({
      script: { model: [toolCallReply("tc-1"), textReply("done")], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "local_tool"
          ? ({
              kind: "local_tool",
              async execute() {
                return { deferred: true, reason: "external-result" };
              },
            } satisfies EffectExecutor)
          : null,
      // Fail ONLY the fold-load head read, and only while armed — appends still work.
      gadFault: (method) =>
        faultArmed && method === "getLogHead"
          ? new Error("store unavailable")
          : null,
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver);
    // Parked: the deferred local_tool row is kept, the turn stays open.
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({ kind: "local_tool" }),
    ]);

    const outcome: EffectOutcome = {
      kind: "tool",
      result: {
        protocolContent: [{ type: "text", text: "[eval] ok" }],
        details: { success: true },
      },
      isError: false,
    };

    // Force a fresh fold (drop the cached loop) so the next deliver MUST load via getLogHead → faults.
    harness.driver.dropLoop(CHANNEL);
    faultArmed = true;
    // The transient error PROPAGATES (no longer swallowed) — the caller's redrive/alarm retries.
    await expect(
      harness.driver.deliverEffectOutcome(
        ids.invocationEffect("tc-1"),
        outcome,
        {
          channelId: CHANNEL,
        },
      ),
    ).rejects.toThrow(/store unavailable/);
    // Critically: the outbox row is STILL parked (the outcome was not dropped, the row not deleted).
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({ kind: "local_tool" }),
    ]);

    // Store recovers → the redelivery (the redrive/push backstop) settles the invocation normally.
    faultArmed = false;
    await harness.driver.deliverEffectOutcome(
      ids.invocationEffect("tc-1"),
      outcome,
      {
        channelId: CHANNEL,
      },
    );
    await settle(harness.driver);
    expect(harness.driver.outbox.all()).toHaveLength(0);
    const kinds = await logKinds(harness.gad);
    expect(kinds).toContain("invocation.completed");
    expect(kinds).toContain("turn.closed");
  });

  it("publishes a credential-connect card when a model call suspends for credentials", async () => {
    const harness = await makeHarness({
      script: {
        model: [
          {
            kind: "model-suspended",
            reason: "credential",
            providerId: "openai-codex",
            modelBaseUrl: "https://chatgpt.com/backend-api/codex",
          },
        ],
        tool: [],
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver);

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.failed",
      "system.event",
      "turn.waiting",
    ]);
    expect(harness.channelPublishes).toContainEqual(
      expect.objectContaining({
        channelId: CHANNEL,
        payloadKind: CREDENTIAL_CONNECT_PAYLOAD_KIND,
        payload: expect.objectContaining({
          providerId: "openai-codex",
          modelBaseUrl: "https://chatgpt.com/backend-api/codex",
        }),
        idempotencyKey: expect.stringContaining("credcard:"),
      }),
    );
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({ kind: "credential_wait" }),
    ]);
    const effectId = ids.credentialWaitEffect(
      ids.credKey(CHANNEL, "openai-codex"),
    );
    await expect(
      harness.driver.deliverEffectOutcome(
        effectId,
        { kind: "credential", resolved: true },
        { channelId: CHANNEL },
      ),
    ).resolves.toBe(true);
    await expect(
      harness.driver.deliverEffectOutcome(
        effectId,
        { kind: "credential", resolved: true },
        { channelId: CHANNEL },
      ),
    ).resolves.toBe(false);
    const loop = await harness.driver.loop(CHANNEL);
    expect(loop.state.pendingCredentialWaits).toEqual({});
    expect(loop.state.inFlightModelCall).not.toBeNull();
  });

  it("parks model auth failures behind a credential reconnect card", async () => {
    const reason =
      "Provided authentication token is expired. Please try signing in again.";
    const harness = await makeHarness({
      script: {
        model: [
          {
            kind: "model-suspended",
            reason: "credential",
            providerId: "openai-codex",
            modelBaseUrl: "https://chatgpt.com/backend-api/codex",
            waitReason: "model_credential_reconnect_required",
            diagnosticReason: reason,
            failureCode: "auth_or_credentials",
          },
        ],
        tool: [],
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver);

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.failed",
      "system.event",
      "turn.waiting",
    ]);
    const failedRows = inspectSql<{
      rows: Array<{ payload_ref_json: string }>;
    }>(
      harness.gad,
      `SELECT payload_ref_json FROM log_events WHERE log_id = '${LOG_ID}' AND payload_kind = 'message.failed'`,
    );
    expect(JSON.parse(failedRows.rows[0]!.payload_ref_json)).toMatchObject({
      reason: "model_credential_reconnect_required",
      recoverable: true,
      code: "auth_or_credentials",
    });
    const waitingRows = inspectSql<{
      rows: Array<{ payload_ref_json: string }>;
    }>(
      harness.gad,
      `SELECT payload_ref_json FROM log_events WHERE log_id = '${LOG_ID}' AND payload_kind = 'turn.waiting'`,
    );
    expect(JSON.parse(waitingRows.rows[0]!.payload_ref_json)).toMatchObject({
      reason: "model_credential_reconnect_required",
      summary: "Waiting for model credential reconnect",
    });
    expect(harness.channelPublishes).toContainEqual(
      expect.objectContaining({
        channelId: CHANNEL,
        payloadKind: CREDENTIAL_CONNECT_PAYLOAD_KIND,
        payload: expect.objectContaining({
          providerId: "openai-codex",
          modelBaseUrl: "https://chatgpt.com/backend-api/codex",
          reason,
          failureCode: "auth_or_credentials",
        }),
      }),
    );
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({ kind: "credential_wait" }),
    ]);
    const effectId = ids.credentialWaitEffect(
      ids.credKey(CHANNEL, "openai-codex"),
    );
    await expect(
      harness.driver.deliverEffectOutcome(
        effectId,
        { kind: "credential", resolved: true },
        { channelId: CHANNEL },
      ),
    ).resolves.toBe(true);
    const resumed = await harness.driver.loop(CHANNEL);
    expect(resumed.state.pendingCredentialWaits).toEqual({});
    expect(resumed.state.openTurn).not.toBeNull();
    expect(resumed.state.inFlightModelCall).not.toBeNull();
  });

  it("lets unattended executor auth throws continue on local fallback", async () => {
    const modelDispatches: Array<{
      provider: string;
      model: string;
      auth?: string;
    }> = [];
    const harness = await makeHarness({
      config: { ...config, fallbackModelRef, fallbackModelSpec },
      script: { model: [], tool: [] },
      executorOverride: (descriptor) => {
        if (descriptor.kind !== "model_call") return null;
        return {
          kind: "model_call",
          async execute() {
            modelDispatches.push({
              provider: descriptor.request.provider,
              model: descriptor.request.model,
              auth: descriptor.request.auth,
            });
            if (descriptor.request.provider !== "local") {
              throw Object.assign(
                new Error(
                  "Provided authentication token is expired. Please try signing in again.",
                ),
                { status: 401 },
              );
            }
            return textReply("continued locally");
          },
        } satisfies EffectExecutor;
      },
    });

    await harness.driver.handleIncoming(
      CHANNEL,
      promptIncoming("env-scheduled", "background check", {
        origin: "scheduled",
      }),
    );
    await settle(harness.driver, 8);

    expect(modelDispatches).toEqual([
      { provider: "anthropic", model: "claude-sonnet-4-6", auth: undefined },
      { provider: "local", model: "lfm2.5-2.6b", auth: "loopback" },
    ]);
    expect(harness.channelPublishes).not.toContainEqual(
      expect.objectContaining({ payloadKind: CREDENTIAL_CONNECT_PAYLOAD_KIND }),
    );
    const notices = inspectSql<{ rows: Array<{ payload_ref_json: string }> }>(
      harness.gad,
      `SELECT payload_ref_json FROM log_events WHERE log_id = '${LOG_ID}' AND payload_kind = 'system.event' ORDER BY seq`,
    );
    expect(
      notices.rows.map((row) => JSON.parse(row.payload_ref_json)),
    ).toContainEqual(
      expect.objectContaining({ kind: "model.fallback_continued" }),
    );
    const starts = inspectSql<{ rows: Array<{ payload_ref_json: string }> }>(
      harness.gad,
      `SELECT payload_ref_json FROM log_events WHERE log_id = '${LOG_ID}' AND payload_kind = 'message.started' ORDER BY seq`,
    );
    expect(
      JSON.parse(starts.rows.at(-1)!.payload_ref_json).modelRequest,
    ).toMatchObject({
      provider: "local",
      model: "lfm2.5-2.6b",
      auth: "loopback",
      modelSpec: fallbackModelSpec,
    });
    expect(harness.driver.outbox.all()).toEqual([]);
  });

  it("does not mark a queued model call failed when wake races the pump", async () => {
    const harness = await makeHarness({
      script: { model: [textReply("done")], tool: [] },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    const preparation = harness.driver.outbox.all()[0];
    expect(preparation).toEqual(
      expect.objectContaining({ kind: "prompt_artifacts" }),
    );
    await harness.driver.applyOutcome(preparation!, {
      kind: "prompt-artifacts",
      patch: {},
    });
    await harness.driver.wake(CHANNEL);

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
    ]);

    await settle(harness.driver);

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.completed",
      "turn.closed",
    ]);
  });

  it("retries transient prompt-resource transport failures before failing the user turn", async () => {
    let attempts = 0;
    const harness = await makeHarness({
      script: { model: [textReply("done")], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "prompt_artifacts"
          ? ({
              kind: "prompt_artifacts",
              async execute() {
                attempts += 1;
                if (attempts < 3)
                  throw new TypeError("workspace.listSkills fetch failed");
                return { kind: "prompt-artifacts", patch: config };
              },
            } satisfies EffectExecutor)
          : null,
    });

    await harness.driver.handleIncoming(
      CHANNEL,
      promptIncoming("env-prompt-retry"),
    );
    await harness.driver.dispatchReadyEffectsForTest();
    expect(attempts).toBe(1);
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({ kind: "prompt_artifacts", attempts: 1 }),
    ]);

    harness.setNow(1_800_000_000_000);
    await harness.driver.dispatchReadyEffectsForTest();
    expect(attempts).toBe(2);
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({ kind: "prompt_artifacts", attempts: 2 }),
    ]);

    harness.setNow(1_900_000_000_000);
    await settle(harness.driver);
    expect(attempts).toBe(3);
    expect(harness.driver.outbox.all()).toEqual([]);
    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.completed",
      "turn.closed",
    ]);
  });

  it("does not mark a generation-owned model call failed after activation restart", async () => {
    const gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    const host = await createTestDO(GadWorkspaceDO, {
      __objectKey: "driver-host",
    });
    const started = deferred<void>();
    const first = await makeHarness({
      script: { model: [], tool: [] },
      gad,
      driverSql: host,
      executorOverride: (descriptor) =>
        descriptor.kind === "model_call"
          ? ({
              kind: "model_call",
              async execute() {
                started.resolve();
                return new Promise<EffectOutcome>(() => {});
              },
            } as EffectExecutor)
          : null,
    });

    await first.driver.handleIncoming(CHANNEL, promptIncoming());
    void first.driver.dispatchReadyEffectsForTest().catch(() => undefined);
    await started.promise;
    const leasedRow = first.driver.outbox.all()[0];
    expect(leasedRow).toEqual(
      expect.objectContaining({
        kind: "model_call",
        disposition: "leased",
        leaseOwner: "agent-loop-driver:test-host",
      }),
    );

    const recovered = await makeHarness({
      script: { model: [], tool: [] },
      gad,
      driverSql: host,
    });
    await recovered.driver.wake(CHANNEL);

    expect(await logKinds(gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
    ]);
    expect(recovered.driver.outbox.all()[0]).toEqual(
      expect.objectContaining({
        kind: "model_call",
        disposition: "leased",
        leaseGeneration: leasedRow?.leaseGeneration,
      }),
    );
  });

  it("closes a completed assistant turn when replay missed the terminal cascade", async () => {
    const gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    const host = await createTestDO(GadWorkspaceDO, {
      __objectKey: "driver-host",
    });
    let outcomeAppends = 0;
    const crashed = await makeHarness({
      script: { model: [textReply("done")], tool: [] },
      gad,
      driverSql: host,
      killPoint: (point) => {
        if (point === "after-outcome-append" && ++outcomeAppends === 2) {
          throw new Error("crash after terminal append");
        }
      },
    });

    await crashed.driver.handleIncoming(CHANNEL, promptIncoming());
    await crashed.driver.dispatchReadyEffectsForTest().catch(() => {});

    expect(await logKinds(gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.completed",
    ]);

    const recovered = await makeHarness({
      script: { model: [], tool: [] },
      gad,
      driverSql: host,
    });
    await recovered.driver.wake(CHANNEL);

    expect(await logKinds(gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.completed",
      "turn.closed",
    ]);
    expect((await recovered.driver.loop(CHANNEL)).state.openTurn).toBeNull();
    expect(recovered.driver.outbox.all()).toHaveLength(0);
  });

  it("leaves a durable recovery intent when activation loss follows local effect consumption", async () => {
    const gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    const host = await createTestDO(GadWorkspaceDO, {
      __objectKey: "driver-host",
    });
    const recoveries = new Map<
      string,
      { channelId: string; branchId: string; effectId: string }
    >();
    let deletedOutcomes = 0;
    const crashed = await makeHarness({
      script: { model: [textReply("done")], tool: [] },
      gad,
      driverSql: host,
      commitTerminalOutcome: (input, commitLocal) => {
        recoveries.set(input.effectId, input);
        commitLocal();
      },
      clearTerminalOutcomeRecovery: (input) => {
        recoveries.delete(input.effectId);
      },
      killPoint: (point) => {
        if (point === "after-outbox-delete" && ++deletedOutcomes === 2) {
          throw new Error("activation lost after consuming terminal outcome");
        }
      },
    });

    await crashed.driver.handleIncoming(CHANNEL, promptIncoming());
    await crashed.driver.dispatchReadyEffectsForTest().catch(() => {});

    expect(crashed.driver.outbox.all()).toHaveLength(0);
    expect([...recoveries.values()]).toEqual([
      expect.objectContaining({ channelId: CHANNEL, branchId: LOG_ID }),
    ]);
    expect(await logKinds(gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.completed",
    ]);

    const recovered = await makeHarness({
      script: { model: [], tool: [] },
      gad,
      driverSql: host,
    });
    await recovered.driver.wake(CHANNEL);

    expect((await recovered.driver.loop(CHANNEL)).state.openTurn).toBeNull();
    expect((await logKinds(gad)).at(-1)).toBe("turn.closed");
  });

  it("settles cancellation after recovering a completed turn from a prior activation", async () => {
    const gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    const host = await createTestDO(GadWorkspaceDO, {
      __objectKey: "driver-host",
    });
    let deletedOutcomes = 0;
    const crashed = await makeHarness({
      script: { model: [textReply("done")], tool: [] },
      gad,
      driverSql: host,
      commitTerminalOutcome: (_input, commitLocal) => commitLocal(),
      killPoint: (point) => {
        if (point === "after-outbox-delete" && ++deletedOutcomes === 2) {
          throw new Error("activation lost before terminal cascade");
        }
      },
    });
    await crashed.driver.handleIncoming(CHANNEL, promptIncoming());
    await crashed.driver.dispatchReadyEffectsForTest().catch(() => {});

    const recovered = await makeHarness({
      script: { model: [], tool: [] },
      gad,
      driverSql: host,
    });
    await expect(
      recovered.driver.interruptChannel(CHANNEL),
    ).resolves.toBeUndefined();

    expect((await recovered.driver.loop(CHANNEL)).state.openTurn).toBeNull();
    expect((await logKinds(gad)).at(-1)).toBe("turn.closed");
    expect(recovered.driver.outbox.all()).toHaveLength(0);
  });

  it("repairs a committed tool-call cascade before accepting queued steering", async () => {
    let deletedOutcomes = 0;
    const harness = await makeHarness({
      script: {
        model: [toolCallReply("tc-queued"), textReply("done")],
        tool: [toolOk],
      },
      killPoint: (point) => {
        // Prompt-artifact preparation commits first. Crash the same activation
        // after deleting the completed model row but before message.completed
        // can expand its tool call into invocation.started.
        if (point === "after-outbox-delete" && ++deletedOutcomes === 2) {
          throw new Error("crash before tool-call cascade");
        }
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await harness.driver.dispatchReadyEffectsForTest().catch(() => {});
    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.completed",
    ]);
    await harness.driver.handleIncoming(CHANNEL, {
      type: "command",
      command: {
        kind: "steer",
        channelId: CHANNEL,
        source: { envelopeId: "env-steer" },
        content: "also remove the maximum width",
        senderRef: {
          kind: "user",
          id: "panel:user",
          participantId: "panel:user",
        },
      },
    });

    const afterSteer = await logKinds(harness.gad);
    expect(afterSteer).toContain("invocation.started");
    expect(
      afterSteer.filter((kind) => kind === "message.started"),
    ).toHaveLength(1);

    await settle(harness.driver);
    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.completed",
      "invocation.started",
      "message.completed",
      "invocation.completed",
      "message.started",
      "message.completed",
      "turn.closed",
    ]);
    expect((await harness.driver.loop(CHANNEL)).state.openTurn).toBeNull();
  });

  it("does not re-expand inherited parent tool calls when waking a forked child turn", async () => {
    const gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    const parentChannel = "parent-chan";
    const parentLogId = logIdForChannel(parentChannel);
    const inheritedInvocationId = "call-parent-spawn";
    await gad.callAs("do", "appendLogEvent", {
      logId: parentLogId,
      head: parentLogId,
      logKind: "trajectory",
      events: [
        {
          envelopeId: ids.messageTerminal("parent-msg"),
          actor: {
            kind: "agent",
            id: "agent:parent",
            participantId: "agent:parent",
          },
          payloadKind: "message.completed",
          payload: {
            protocol: "agentic.trajectory.v1",
            role: "assistant",
            blocks: [
              {
                type: "toolCall",
                id: inheritedInvocationId,
                name: "spawn_subagent",
                arguments: {
                  protocol: "vibestudio.blob-ref.v1",
                  digest: "blob-parent-spawn-args",
                  size: 35,
                  encoding: "json",
                  originalBytes: 35,
                },
              },
            ],
            outcome: "completed",
          },
          causality: { messageId: "parent-msg" },
        },
        {
          envelopeId: ids.invocationStart(inheritedInvocationId),
          actor: {
            kind: "agent",
            id: "agent:parent",
            participantId: "agent:parent",
          },
          payloadKind: "invocation.started",
          payload: {
            protocol: "agentic.trajectory.v1",
            name: "spawn_subagent",
            invocationType: "tool",
            request: {
              protocol: "vibestudio.blob-ref.v1",
              digest: "blob-parent-spawn-args",
              size: 35,
              encoding: "json",
              originalBytes: 35,
            },
            transport: { kind: "local", awaiterId: inheritedInvocationId },
            userVisible: true,
          },
          causality: { invocationId: inheritedInvocationId },
        },
      ],
    });
    await gad.callAs("do", "forkLog", {
      fromLogId: parentLogId,
      fromHead: parentLogId,
      toLogId: LOG_ID,
      toHead: LOG_ID,
      atSeq: 2,
    });

    const childTurnId = ids.turnId(CHANNEL, "child-seed", "agent:self");
    const childMessageId = ids.messageId(childTurnId, 0);
    await gad.callAs("do", "appendLogEvent", {
      logId: LOG_ID,
      head: LOG_ID,
      logKind: "trajectory",
      events: [
        {
          envelopeId: ids.turnOpened(childTurnId),
          actor: {
            kind: "agent",
            id: "agent:self",
            participantId: "agent:self",
          },
          payloadKind: "turn.opened",
          payload: { protocol: "agentic.trajectory.v1" },
          causality: { turnId: childTurnId },
        },
        {
          envelopeId: ids.messageStarted(childMessageId),
          actor: {
            kind: "agent",
            id: "agent:self",
            participantId: "agent:self",
          },
          payloadKind: "message.started",
          payload: {
            protocol: "agentic.trajectory.v1",
            role: "assistant",
            modelRequest: {
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              modelSpec: config.modelSpec,
              thinkingLevel: "medium",
              systemPromptHash: "blob:sys",
              activeToolNames: ["read"],
              contextThroughSeq: 3,
              attemptId: ids.attemptId(childMessageId),
            },
          },
          causality: { messageId: childMessageId, turnId: childTurnId },
        },
      ],
    });

    const harness = await makeHarness({ script: { model: [], tool: [] }, gad });

    await expect(harness.driver.wake(CHANNEL)).resolves.toBeUndefined();

    const rows = inspectSql<{ rows: Array<{ envelope_id: string }> }>(
      gad,
      `SELECT envelope_id FROM log_events WHERE log_id = '${LOG_ID}' ORDER BY seq`,
    );
    const localEnvelopeIds = rows.rows.map((row) => row.envelope_id);
    expect(localEnvelopeIds).toContain(ids.messageTerminal(childMessageId));
    expect(localEnvelopeIds).toContain(
      ids.messageStarted(ids.messageId(childTurnId, 1)),
    );
    expect(localEnvelopeIds).not.toContain(
      ids.invocationStart(inheritedInvocationId),
    );
  });

  it("parks a reset-aware model failure when replay missed the terminal cascade", async () => {
    const gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    const host = await createTestDO(GadWorkspaceDO, {
      __objectKey: "driver-host",
    });
    let outcomeAppends = 0;
    const crashed = await makeHarness({
      script: {
        model: [
          {
            kind: "model",
            blocks: [],
            stopReason: "error",
            errorReason: rawUsageLimitError(),
          },
        ],
        tool: [],
      },
      gad,
      driverSql: host,
      killPoint: (point) => {
        if (point === "after-outcome-append" && ++outcomeAppends === 2) {
          throw new Error("crash after terminal append");
        }
      },
    });

    await crashed.driver.handleIncoming(CHANNEL, promptIncoming());
    await crashed.driver.dispatchReadyEffectsForTest().catch(() => {});

    expect(await logKinds(gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.failed",
    ]);

    const recovered = await makeHarness({
      script: { model: [], tool: [] },
      gad,
      driverSql: host,
    });
    await recovered.driver.wake(CHANNEL);

    expect(await logKinds(gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.failed",
      "turn.waiting",
    ]);
    const loop = await recovered.driver.loop(CHANNEL);
    expect(loop.state.openTurn?.waitingCount).toBe(1);
    expect(loop.state.inFlightModelCall).toBeNull();
    expect(recovered.driver.outbox.all()).toHaveLength(0);
  });

  it("pauses usage-limit failures and resumes from a scheduled host transition", async () => {
    const harness = await makeHarness({
      script: {
        model: [
          {
            kind: "model",
            blocks: [],
            stopReason: "error",
            errorReason: rawUsageLimitError(),
          },
          textReply("resumed"),
        ],
        tool: [],
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver, 3);

    expect(harness.driver.outbox.all()).toHaveLength(0);
    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.failed",
      "turn.waiting",
    ]);
    const failedRows = inspectSql<{
      rows: Array<{ payload_ref_json: string }>;
    }>(
      harness.gad,
      `SELECT payload_ref_json FROM log_events WHERE log_id = '${LOG_ID}' AND payload_kind = 'message.failed'`,
    );
    expect(JSON.parse(failedRows.rows[0]!.payload_ref_json)).toMatchObject({
      reason:
        "The usage limit has been reached for GPT-5.3 Codex-Spark. Try again after Jun 15, 2026 at 6:35 PM UTC.",
      recoverable: false,
      code: "usage_limit_terminal",
      resetAt: "2026-06-15T18:35:01.000Z",
    });

    const messageId = ids.messageId(
      ids.turnId(CHANNEL, "env-1", "agent:self"),
      0,
    );
    await expect(
      harness.driver.scheduleResumeAtReset(CHANNEL, {
        messageId,
        resetAt: "2026-06-15T18:35:01.000Z",
      }),
    ).resolves.toMatchObject({
      scheduled: true,
      wakeAt: "2026-06-15T18:35:01.000Z",
    });
    expect(harness.alarms).toContain(Date.parse("2026-06-15T18:35:01.000Z"));

    harness.setNow(Date.parse("2026-06-15T18:35:02.000Z"));
    await harness.driver.executeScheduledResume(CHANNEL, messageId);
    await settle(harness.driver, 6);

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.failed",
      "turn.waiting",
      "system.event",
      "message.started",
      "message.completed",
      "turn.closed",
    ]);
  });

  it("preserves reset metadata when the model executor throws a usage-limit error", async () => {
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) => {
        if (descriptor.kind !== "model_call") return null;
        return {
          kind: "model_call",
          async execute() {
            throw new Error(rawUsageLimitError());
          },
        } satisfies EffectExecutor;
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver, 3);

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.failed",
      "turn.waiting",
    ]);
    const failedRows = inspectSql<{
      rows: Array<{ payload_ref_json: string }>;
    }>(
      harness.gad,
      `SELECT payload_ref_json FROM log_events WHERE log_id = '${LOG_ID}' AND payload_kind = 'message.failed'`,
    );
    expect(JSON.parse(failedRows.rows[0]!.payload_ref_json)).toMatchObject({
      code: "usage_limit_terminal",
      resetAt: "2026-06-15T18:35:01.000Z",
    });
  });

  it("terminalizes provider tool-schema rejections without retrying the turn", async () => {
    let attempts = 0;
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) => {
        if (descriptor.kind !== "model_call") return null;
        return {
          kind: "model_call",
          async execute() {
            attempts += 1;
            throw new Error(rawInvalidToolSchemaError());
          },
        } satisfies EffectExecutor;
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver, 3);

    expect(attempts).toBe(1);
    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.failed",
      "turn.closed",
    ]);
    const failedRows = inspectSql<{
      rows: Array<{ payload_ref_json: string }>;
    }>(
      harness.gad,
      `SELECT payload_ref_json FROM log_events WHERE log_id = '${LOG_ID}' AND payload_kind = 'message.failed'`,
    );
    expect(JSON.parse(failedRows.rows[0]!.payload_ref_json)).toMatchObject({
      reason: rawInvalidToolSchemaError(),
      recoverable: false,
      code: "request_invalid_terminal",
    });
    expect(harness.driver.outbox.all()).toHaveLength(0);
    const loop = await harness.driver.loop(CHANNEL);
    expect(loop.state.openTurn).toBeNull();
    expect(loop.state.inFlightModelCall).toBeNull();

    await harness.driver.dispatchReadyEffectsForTest();
    expect(attempts).toBe(1);
  });

  it("reschedules retryable provider rate limits without publishing message failures", async () => {
    const harness = await makeHarness({
      script: {
        model: [
          {
            kind: "retry",
            reason: "Rate limit reached for requests.",
            retryAfterMs: 12_000,
            code: "rate_limited_retryable",
          },
        ],
        tool: [],
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await harness.driver.dispatchReadyEffectsForTest();

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
    ]);
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({
        kind: "model_call",
        attempts: 1,
        nextAttemptAt: expect.any(Number),
      }),
    ]);
  });

  it("recovers from one transient unclassified model transport failure", async () => {
    let attempts = 0;
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "model_call"
          ? ({
              kind: "model_call",
              async execute() {
                attempts += 1;
                return attempts === 1
                  ? {
                      kind: "retry",
                      reason: "fetch failed",
                      retryAfterMs: 1_000,
                      code: "unknown_retryable",
                    }
                  : textReply("network recovered");
              },
            } satisfies EffectExecutor)
          : null,
    });

    await harness.driver.handleIncoming(
      CHANNEL,
      promptIncoming("env-network-outage"),
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      harness.setNow((attempt + 1) * 10_000);
      await harness.driver.dispatchReadyEffectsForTest();
    }

    expect(attempts).toBe(2);
    expect(harness.driver.outbox.all()).toEqual([]);
    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.completed",
      "turn.closed",
    ]);
  });

  it("keeps a persistent unclassified model transport failure durably retrying", async () => {
    let attempts = 0;
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "model_call"
          ? ({
              kind: "model_call",
              async execute() {
                attempts += 1;
                return {
                  kind: "retry",
                  reason: "model stream made no semantic progress",
                  retryAfterMs: 1_000,
                  code: "model_stream_stalled_retryable",
                };
              },
            } satisfies EffectExecutor)
          : null,
    });

    await harness.driver.handleIncoming(
      CHANNEL,
      promptIncoming("env-network-stalled"),
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      harness.setNow((attempt + 1) * 10_000);
      await harness.driver.dispatchReadyEffectsForTest();
    }

    expect(attempts).toBe(2);
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({
        descriptor: expect.objectContaining({ kind: "model_call" }),
        disposition: "retrying",
        attempts: 2,
        nextAttemptAt: expect.any(Number),
      }),
    ]);
    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
    ]);
    const loop = await harness.driver.loop(CHANNEL);
    expect(loop.state.openTurn).not.toBeNull();
    expect(loop.state.inFlightModelCall).not.toBeNull();
  });

  it("settles only after the catastrophic model transport recovery budget", async () => {
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "model_call"
          ? ({
              kind: "model_call",
              async execute() {
                return {
                  kind: "retry",
                  reason: "provider network remained unavailable",
                  retryAfterMs: 1_000,
                  code: "unknown_retryable",
                };
              },
            } satisfies EffectExecutor)
          : null,
    });

    await harness.driver.handleIncoming(
      CHANNEL,
      promptIncoming("env-catastrophic-network-outage"),
    );
    harness.setNow(10_000);
    await harness.driver.dispatchReadyEffectsForTest();
    harness.driverHost.sql.exec(
      `UPDATE effect_outbox SET attempts = ? WHERE kind = 'model_call'`,
      MODEL_TRANSPORT_CATASTROPHIC_ATTEMPT_LIMIT - 1,
    );
    harness.setNow(100_000);
    await harness.driver.dispatchReadyEffectsForTest();

    expect(harness.driver.outbox.all()).toEqual([]);
    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.failed",
      "turn.closed",
    ]);
  });

  it("does not mark a locally running model call failed when wake arrives during credential approval", async () => {
    const started = deferred<void>();
    const released = deferred<EffectOutcome>();
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) => {
        if (descriptor.kind !== "model_call") return null;
        return {
          kind: "model_call",
          async execute() {
            started.resolve();
            return released.promise;
          },
        } satisfies EffectExecutor;
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    const alarm = harness.driver.dispatchReadyEffectsForTest();
    await started.promise;
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({
        kind: "model_call",
        disposition: "leased",
        leaseOwner: "agent-loop-driver:test-host",
      }),
    ]);

    await harness.driver.wake(CHANNEL);

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
    ]);

    released.resolve(textReply("done"));
    await alarm;

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.completed",
      "turn.closed",
    ]);
  });

  it("converges after a crash at every kill point (crash-injection harness)", async () => {
    // Reference run
    const reference = await makeHarness({
      script: {
        model: [toolCallReply("tc-1"), textReply("done")],
        tool: [toolOk],
      },
    });
    await reference.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(reference.driver);
    const referenceKinds = await logKinds(reference.gad);

    for (const point of [
      "after-append",
      "after-fold-cache",
      "after-outbox-insert",
      "after-outcome-append",
      "after-outbox-delete",
    ]) {
      const gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
      const host = await createTestDO(GadWorkspaceDO, {
        __objectKey: "driver-host",
      });
      const script: Script = {
        model: [toolCallReply("tc-1"), textReply("done")],
        tool: [toolOk],
      };
      let armed = true;
      const crashed = await makeHarness({
        script,
        gad,
        driverSql: host,
        killPoint: (p) => {
          if (armed && p === point) {
            armed = false;
            throw new Error(`crash at ${point}`);
          }
        },
      });
      await crashed.driver
        .handleIncoming(CHANNEL, promptIncoming())
        .catch(() => {});
      // one pump round, then the "process dies" mid-flight
      await crashed.driver.dispatchReadyEffectsForTest().catch(() => {});

      // restart: fresh driver on the same sql + gad; wake + pump until quiescent
      const recovered = await makeHarness({ script, gad, driverSql: host });
      for (let i = 0; i < 6; i += 1) {
        await recovered.driver.wake(CHANNEL);
        await settle(recovered.driver, 2);
        if (recovered.driver.outbox.all().length === 0) break;
      }

      const kinds = await logKinds(gad);
      // allow benign extra message.failed{recoverable} + retry pairs
      const essential = kinds.filter(
        (kind) => kind !== "message.failed" && kind !== "message.started",
      );
      const referenceEssential = referenceKinds.filter(
        (kind) => kind !== "message.failed" && kind !== "message.started",
      );
      expect(essential, `kill point ${point}`).toEqual(referenceEssential);
      expect(recovered.driver.outbox.all(), `kill point ${point}`).toHaveLength(
        0,
      );
      const integrity = await gad.call<{ ok: boolean }>(
        "checkLogIntegrity",
        {},
      );
      expect(integrity.ok, `kill point ${point}`).toBe(true);
    }
  }, 30_000);

  it("survives total cache amnesia mid-run (P3)", async () => {
    const gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    const host = await createTestDO(GadWorkspaceDO, {
      __objectKey: "driver-host",
    });
    const script: Script = {
      model: [toolCallReply("tc-1"), textReply("done")],
      tool: [toolOk],
    };
    // run only the first model call, then crash before the tool dispatch
    let calls = 0;
    const first = await makeHarness({
      script,
      gad,
      driverSql: host,
      killPoint: (point) => {
        if (point === "after-outbox-insert") {
          calls += 1;
          if (calls === 2) throw new Error("simulated crash"); // after tool row insert
        }
      },
    });
    await first.driver
      .handleIncoming(CHANNEL, promptIncoming())
      .catch(() => {});
    await first.driver.dispatchReadyEffectsForTest().catch(() => {});

    // cache amnesia: wipe BOTH caches
    host.sql.exec(`DELETE FROM effect_outbox`);
    host.sql.exec(`DELETE FROM fold_cache`);

    const recovered = await makeHarness({ script, gad, driverSql: host });
    for (let i = 0; i < 6; i += 1) {
      await recovered.driver.wake(CHANNEL);
      await settle(recovered.driver, 2);
      if (recovered.driver.outbox.all().length === 0) break;
    }
    const kinds = await logKinds(gad);
    expect(kinds).toContain("invocation.completed");
    expect(kinds[kinds.length - 1]).toBe("turn.closed");
    expect(recovered.driver.outbox.all()).toHaveLength(0);
    expect((await gad.call<{ ok: boolean }>("checkLogIntegrity", {})).ok).toBe(
      true,
    );
  });

  it("treats duplicate deliverEffectOutcome as a no-op (deterministic terminals)", async () => {
    const harness = await makeHarness({
      script: { model: [toolCallReply("tc-1"), textReply("done")], tool: [] },
    });
    // make the tool a deferred channel-style settle: override executor to defer
    harness.driver["deps" as never]; // (no-op; keep TS quiet about unused)
    const driver = harness.driver;
    // run up to the pending local_tool dispatch — script.tool is empty so the
    // dispatch fails once and backs off; instead deliver the outcome out-of-band
    await driver.handleIncoming(CHANNEL, promptIncoming()).catch(() => {});
    await driver.dispatchReadyEffectsForTest().catch(() => {});
    const effectId = ids.invocationEffect("tc-1");
    await expect(driver.deliverEffectOutcome(effectId, toolOk)).resolves.toBe(
      true,
    );
    const kindsAfterFirst = await logKinds(harness.gad);
    await expect(driver.deliverEffectOutcome(effectId, toolOk)).resolves.toBe(
      false,
    ); // duplicate
    expect(await logKinds(harness.gad)).toEqual(kindsAfterFirst);
    const terminals = inspectSql<{ rows: Array<{ cnt: number }> }>(
      harness.gad,
      `SELECT COUNT(*) AS cnt FROM log_events WHERE envelope_id = '${ids.invocationTerminal("tc-1")}'`,
    );
    expect(terminals.rows[0]!.cnt).toBe(1);
  });

  it("compacts at idle AFTER a turn closes once the threshold is exceeded", async () => {
    const TURNS = 6;
    const harness = await makeHarness({
      // one plain text reply per turn (no tool calls)
      script: {
        model: Array.from({ length: TURNS }, (_, i) => textReply(`reply-${i}`)),
        tool: [],
      },
      // low thresholds so a handful of turns trips compaction; the vessel sizes
      // these to the model context window in production.
      compaction: { minEntries: 6, triggerBytes: 1 },
    });

    for (let i = 0; i < TURNS; i += 1) {
      await harness.driver.handleIncoming(
        CHANNEL,
        promptIncoming(`env-${i}`, `msg-${i}`),
      );
      await settle(harness.driver);
    }

    // Compaction is journaled as system.compaction_recorded — and it fires
    // during the active prompt→reply session (each turn opens AND closes a
    // turn inside handleIncoming+settle), not only on a post-hibernation wake.
    const kinds = await logKinds(harness.gad);
    expect(kinds).toContain("system.compaction_recorded");

    // The fold actually shrank: the live loop keeps only the compaction's
    // retained tail (slice(-8)) plus whatever the last turn(s) appended —
    // bounded well below 2*TURNS entries.
    const loop = await harness.driver.loop(CHANNEL);
    expect(loop.state.entries.length).toBeLessThanOrEqual(10);
    expect(loop.state.openTurn).toBeNull();
  });

  it("never compacts while a turn is open (mid-turn context preserved)", async () => {
    const harness = await makeHarness({
      // a tool call keeps the turn OPEN across the model terminal; the tool
      // outcome is delivered out of band so the turn stays open mid-settle.
      script: { model: [toolCallReply("tc-1"), textReply("done")], tool: [] },
      compaction: { minEntries: 1, triggerBytes: 1 },
    });
    await harness.driver
      .handleIncoming(CHANNEL, promptIncoming())
      .catch(() => {});
    await harness.driver.dispatchReadyEffectsForTest().catch(() => {});
    // Turn is open (awaiting the tool). No compaction event yet.
    expect(await logKinds(harness.gad)).not.toContain(
      "system.compaction_recorded",
    );
    const loop = await harness.driver.loop(CHANNEL);
    expect(loop.state.openTurn).not.toBeNull();
  });

  it("compacts an overflowing open turn and retries the model call", async () => {
    const overflow: EffectOutcome = {
      kind: "model",
      blocks: [],
      stopReason: "error",
      errorReason: "Your input exceeds the context window of this model.",
    };
    const harness = await makeHarness({
      script: { model: [overflow, textReply("recovered")], tool: [] },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver);

    expect(await logKinds(harness.gad)).toContain("system.compaction_recorded");
    const failures = inspectSql<{
      rows: Array<{ payload_ref_json: string }>;
    }>(
      harness.gad,
      `SELECT payload_ref_json FROM log_events
        WHERE log_id = '${LOG_ID}' AND payload_kind = 'message.failed'`,
    );
    expect(
      failures.rows.map((row) => JSON.parse(row.payload_ref_json)),
    ).toContainEqual({
      protocol: expect.any(String),
      reason: expect.any(String),
      recoverable: true,
      code: "context_overflow_terminal",
    });
    expect(await logKinds(harness.gad)).toContain("turn.closed");
    expect(await harness.driver.modelExecutionEvidence(CHANNEL)).toMatchObject({
      totalCalls: 2,
    });
  });
});

// Integration: agent.describe()'s `turn` block is `summarizeTurn(loop.state)`.
// Drive REAL turns through a GAD-backed loop and assert the summary over the
// state re-folded from the persisted log (not the in-memory cache).
describe("summarizeTurn over a real GAD-backed loop (agent.describe turn block)", () => {
  it("reports an in-flight turn after a prompt, then idle once it settles", async () => {
    const harness = await makeHarness({
      script: { model: [textReply("done")], tool: [] },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    harness.driver.dropLoop(CHANNEL); // force a fresh fold from the log
    const open = summarizeTurn((await harness.driver.loop(CHANNEL)).state);
    expect(open.status).not.toBe("idle");
    expect(["starting", "running_model"]).toContain(open.status);
    expect(open.lastSeq).toBeGreaterThan(0);

    await settle(harness.driver);
    harness.driver.dropLoop(CHANNEL);
    const settled = summarizeTurn((await harness.driver.loop(CHANNEL)).state);
    expect(settled.status).toBe("idle");
    expect(settled.lastSeq).toBeGreaterThan(open.lastSeq);
    expect(settled.pendingInvocations).toBe(0);
  });

  it("reports a pending tool invocation as waiting_external with a live count", async () => {
    // model emits a tool call but the tool outcome is never delivered (tool: []),
    // so the invocation stays pending in the fold.
    const harness = await makeHarness({
      script: { model: [toolCallReply("tc-1"), textReply("done")], tool: [] },
    });
    await harness.driver
      .handleIncoming(CHANNEL, promptIncoming())
      .catch(() => {});
    await harness.driver.dispatchReadyEffectsForTest().catch(() => {}); // model emits the tool call

    harness.driver.dropLoop(CHANNEL);
    const s = summarizeTurn((await harness.driver.loop(CHANNEL)).state);
    expect(s.status).toBe("waiting_external");
    expect(s.pendingInvocations).toBeGreaterThanOrEqual(1);
  });
});
