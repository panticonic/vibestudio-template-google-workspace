import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeChannelProvider } from "@workspace/agentic-do/testing/native-channel-provider";
import { createTestDO as createRuntimeTestDO } from "@workspace/runtime/worker/test-utils";
import { createCredentialClient } from "@workspace/runtime/credentials";
import type { WebhookDeliveryEvent } from "@workspace/runtime/worker";
import {
  GmailApiError,
  createGmailClient,
  type GmailClient,
  type GmailMessage,
  type GmailThread,
} from "@workspace/gmail";
import { fakeGmailClient } from "@workspace/gmail/test-utils";
import { AGENTIC_EVENT_PAYLOAD_KIND } from "@workspace/agentic-protocol";
import {
  RpcBoundaryError,
  type RpcClient,
  type RpcCallOptions,
} from "@vibestudio/rpc";
import type { JsonValue, Context } from "@panticonic/pi-chord";
import type { ToolExecutionApi } from "@panticonic/pi-durable";
import {
  nativeToolApi,
  nativeToolContext,
} from "@workspace/harness/testing/native-tool";
import { builtinModels } from "@panticonic/pi-ai/providers/all";

import {
  GmailAgentWorker,
  triageModelCandidates,
} from "./gmail-agent-worker.js";
import { SendAsCache } from "./agent/sendas-cache.js";
import { LabelResolver, type LabelCacheEntry } from "./agent/label-resolver.js";
import { GMAIL_MESSAGE_TYPES, GmailCards } from "./cards/cards.js";

const WORKSPACE_ROOT = path.resolve(__dirname, "../..");
const testDatabases: Array<{ close(): void; release(): Promise<unknown> }> = [];

const schemaDescriptors = new Map<unknown, Promise<unknown>>();
async function createTestDO<T>(
  ...args: Parameters<typeof createRuntimeTestDO<T>>
): ReturnType<typeof createRuntimeTestDO<T>> {
  const [ctor, suppliedEnv, options] = args;
  const env = {
    WORKER_SOURCE: "workers/gmail-agent",
    WORKER_CLASS_NAME: "GmailAgentWorker",
    WORKER_EXECUTION_DIGEST: "e".repeat(64),
    ...suppliedEnv,
  };
  let descriptor = schemaDescriptors.get(ctor);
  if (!descriptor) {
    descriptor = (async () => {
      const probe = await createRuntimeTestDO(
        ctor,
        { ...env, VIBESTUDIO_SCHEMA_PROBE: true },
        { initialize: false },
      );
      try {
        const response = await (
          probe.instance as { fetch(request: Request): Promise<Response> }
        ).fetch(
          new Request("http://test/test-key/__vibestudio_schema_descriptor"),
        );
        if (!response.ok) throw new Error(await response.text());
        return response.json();
      } finally {
        probe.db.close();
      }
    })();
    schemaDescriptors.set(ctor, descriptor);
  }
  const result = await createRuntimeTestDO(
    ctor,
    { ...env, VIBESTUDIO_SCHEMA_DESCRIPTOR: await descriptor },
    options,
  );
  testDatabases.push({
    close: () => result.db.close(),
    release: async () => {
      try {
        return await (
          result.instance as {
            releaseForLifecycle(input: unknown): Promise<unknown>;
          }
        ).releaseForLifecycle({
          epoch: "test-end",
          mode: "suspend",
          reason: "test",
          deadlineMs: 0,
        });
      } finally {
        await (
          result.instance as { closeMethodChannels?(): Promise<void> }
        ).closeMethodChannels?.();
      }
    },
  });
  return result;
}

afterEach(async () => {
  for (const database of testDatabases.splice(0)) {
    try {
      await database.release();
    } finally {
      database.close();
    }
  }
});

function message(
  id: string,
  threadId: string,
  headers: Record<string, string>,
  body = "hello",
  snippet = body,
  labelIds = ["INBOX", "UNREAD"],
): GmailMessage {
  return {
    id,
    threadId,
    labelIds,
    snippet,
    payload: {
      mimeType: "text/plain",
      headers: Object.entries(headers).map(([name, value]) => ({
        name,
        value,
      })),
      body: { data: Buffer.from(body, "utf8").toString("base64url") },
    },
  };
}

class TestGmailAgentWorker extends GmailAgentWorker {
  protected override get rpcCallerKind(): string | null {
    return "server";
  }
  private readonly methodChannels = new Map<
    string,
    ReturnType<typeof createNativeChannelProvider>
  >();
  private methodChannel(channelId: string) {
    let channel = this.methodChannels.get(channelId);
    if (!channel) {
      channel = createNativeChannelProvider({
        channelId,
        participantId: this.participantId(),
        deliver: (...args) => this.onMethodCall(...args),
        cancel: (id, callId) => this.cancelDirectMethodCall(id, callId),
      });
      this.methodChannels.set(channelId, channel);
    }
    return channel;
  }
  async deliveredMethod(
    channelId: string,
    callId: string,
    method: string,
    args: unknown,
  ) {
    return (await this.methodChannel(channelId)).invoke(callId, method, args);
  }
  async cancelDeliveredMethod(channelId: string, callId: string) {
    return (await this.methodChannel(channelId)).cancel(callId);
  }
  async closeMethodChannels() {
    for (const channel of this.methodChannels.values())
      await (await channel).close();
    this.methodChannels.clear();
  }
  protected override createBoundGmailClient(
    _rpc: RpcClient,
    credentialId?: string,
  ): GmailClient {
    return this.createGmailClient(credentialId);
  }
  published: Array<{
    participantId: string;
    event: { kind?: string; payload?: unknown };
    opts?: unknown;
  }> = [];
  signals: Array<{ participantId: string; content: string; type?: string }> =
    [];
  closedSubscriptions: string[] = [];
  gadCalls: Array<{ method: string; args: unknown[] }> = [];
  rawSqlRows: Array<Record<string, unknown>> = [{ seq: null }];
  lifecycleLeaseCalls: Array<{ method: string; input: unknown }> = [];
  agentInitiatedTurns: Array<{ channelId: string; content: string }> = [];
  replayEvents: Array<{
    id: number;
    type: string;
    senderId: string;
    payload: unknown;
    messageId: string;
    ts: number;
  }> = [];
  execSqlForTest(query: string, ...args: unknown[]): void {
    this.sql.exec(query, ...args);
  }

  profile = vi.fn(async () => ({
    emailAddress: "me@example.com",
    messagesTotal: 1,
    threadsTotal: 1,
    historyId: "h1",
  }));
  sync = vi.fn(async () => ({
    historyId: "h2",
    rawHistory: { historyId: "h2", history: [] },
    threads: [
      {
        threadId: "thr-1",
        messagesAdded: [],
        messagesDeleted: [],
        labelsAdded: [],
        labelsRemoved: [],
      },
    ],
  }));
  listMessages = vi.fn(async () => ({
    messages: [
      message(
        "msg-1",
        "thr-1",
        {
          Subject: "Question",
          From: "a@example.com",
          To: "me@example.com",
          "Message-ID": "<msg-1@example.com>",
          Date: "Fri, 22 May 2026 10:00:00 +0000",
        },
        "Private full email body",
        "Short snippet",
      ),
    ],
  }));
  fakeThread: GmailThread = {
    id: "thr-1",
    messages: [
      message(
        "msg-1",
        "thr-1",
        {
          Subject: "Question",
          From: "a@example.com",
          To: "me@example.com",
          "Message-ID": "<msg-1@example.com>",
          Date: "Fri, 22 May 2026 10:00:00 +0000",
        },
        "Private full email body",
        "Short snippet",
      ),
    ],
  };
  sent = vi.fn(async (params: unknown) => ({
    id: "sent-1",
    threadId: "thr-1",
    params,
  }));
  searchContacts = vi.fn(async (_query: string, _opts?: unknown) => [
    { email: "zelda@hyrule.example", displayName: "Zelda Hyrule" },
  ]);
  searchOtherContacts = vi.fn(
    async (_query: string, _opts?: unknown) => [] as Array<{ email: string }>,
  );
  createDraft = vi.fn(async () => ({
    id: "draft-1",
    message: { id: "m", threadId: "t" },
  }));
  modifyLabels = vi.fn(async () => ({}));
  batchModify = vi.fn(async () => undefined);
  draftBodies = vi.fn(
    async () => "Thanks for the context. I will follow up shortly.",
  );
  blobs = new Map<string, string>();
  unreadableRendererSources = false;
  rendererReadFailure: Error | undefined;
  rendererSourceOverrides = new Map<string, string | Uint8Array | null>();
  useBaseDraftGeneration = false;
  triageResponses: string[] = [];
  triageCalls: Array<{ channelId: string; userPrompt: string }> = [];
  /** Captured workspace writes (this.fs is getter-only, so override here). */
  writtenFiles: Array<{ path: string; data: Uint8Array }> = [];
  /** Fake clock: null = real time (most tests); set for alarm-loop tests. */
  clock: number | null = null;

  protected override async writeWorkspaceFile(
    path: string,
    data: Uint8Array,
  ): Promise<void> {
    this.writtenFiles.push({ path, data });
  }

  protected override now(): number {
    return this.clock ?? Date.now();
  }

  nextAlarmForTest() {
    return this.nextAlarmAfterRequest();
  }

  rpcCall = vi.fn(
    async (
      _target: string,
      method: string,
      args?: unknown[],
      _options?: RpcCallOptions,
    ): Promise<unknown> => {
      if (_target === "do:gad:test") {
        this.gadCalls.push({ method, args: args ?? [] });
        if (method === "rawSql") return { rows: this.rawSqlRows };
        if (method === "resolveTrajectoryForkPoint") return { seq: 0 };
        if (method === "forkLog")
          return { inherited: (args?.[0] as { atSeq?: number })?.atSeq ?? 0 };
        if (method === "getLogHead") return null;
        if (method === "readLog") return [];
        if (method === "getLogEvent") return null;
        if (method === "appendLogEvent") {
          return {
            envelopes: [],
            headSeq: 0,
            headHash: "0".repeat(64),
            published: [],
          };
        }
      }
      if (method === "runtime.resolveContext") return "ctx-1";
      if (method === "workers.resolveService") {
        if (args?.[0] === "vibestudio.gad.workspace.v1") {
          return {
            kind: "durable-object",
            source: "vibestudio/internal",
            className: "GadWorkspaceDO",
            objectKey: "workspace",
            targetId: "do:gad:test",
          };
        }
        return { kind: "durable-object", targetId: "do:channel:test" };
      }
      if (method === "authority.outstandingAcquisitions")
        return { receipts: [], next: null };
      if (method === "workerLog.write") return undefined;
      if (method === "workspace.getAgentsMd") return "";
      if (method === "workspace.listSkills") return [];
      if (method === "blobstore.putText") {
        const value = String(args?.[0] ?? "");
        const digest = `blob-${this.blobs.size + 1}`;
        this.blobs.set(digest, value);
        return { digest, size: value.length };
      }
      if (method === "credentials.connect") return { id: "cred-1" };
      if (method === "credentials.resolveCredential") return { id: "cred-1" };
      if (
        method === "workspace-state.alarmSet" ||
        method === "workspace-state.alarmClear"
      ) {
        return undefined;
      }
      if (
        _target === "main" &&
        (method === "workspace-state.lifecycleLeaseUpsert" ||
          method === "workspace-state.lifecycleLeaseClear")
      ) {
        this.lifecycleLeaseCalls.push({ method, input: args?.[0] });
        return undefined;
      }
      if (method === "fs.writeFile") {
        const path = args?.[0];
        const payload = args?.[1] as
          | { __bin?: boolean; data?: string }
          | string;
        if (typeof path !== "string")
          throw new Error("fs.writeFile path must be a string");
        const data =
          typeof payload === "string"
            ? new TextEncoder().encode(payload)
            : payload?.__bin === true && typeof payload.data === "string"
              ? new Uint8Array(Buffer.from(payload.data, "base64"))
              : (() => {
                  throw new Error(
                    "fs.writeFile requires its actual binary payload",
                  );
                })();
        this.writtenFiles.push({ path, data });
        return undefined;
      }
      if (method === "fs.readFile") {
        if (this.rendererReadFailure) throw this.rendererReadFailure;
        if (this.unreadableRendererSources) {
          throw new Error("test renderer source unavailable");
        }
        const filePath = args?.[0];
        const encoding = args?.[1];
        if (typeof filePath !== "string")
          throw new Error("fs.readFile path must be a string");
        if (this.rendererSourceOverrides.has(filePath)) {
          return this.rendererSourceOverrides.get(filePath);
        }
        return fs.readFile(
          path.join(WORKSPACE_ROOT, filePath),
          typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8",
        );
      }
      throw new Error(`unexpected rpc ${_target}.${method}`);
    },
  );

  rpcStream?: (
    target: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions,
  ) => Promise<Response>;
  protected override get rpc(): never {
    return {
      selfId: this.participantId(),
      call: this.rpcCall,
      expose: () => {},
      exposeAll: () => {},
      exposeStreaming: () => {},
      on: () => () => {},
      status: () => "connected",
      ready: async () => {},
      onStatusChange: () => () => {},
      stream: (
        target: string,
        method: string,
        args: unknown[],
        options?: RpcCallOptions,
      ) => {
        if (this.rpcStream)
          return this.rpcStream(target, method, args, options);
        throw new Error("No stream in this Gmail domain fixture");
      },
      streamReadable: () => {
        throw new Error("No stream in this Gmail domain fixture");
      },
      emit: async () => {},
      peer: () => {
        throw new Error("No peer in this Gmail domain fixture");
      },
    } as never;
  }

  protected override callAgentHost = async <T>(
    method: string,
    _args: unknown[],
  ): Promise<T> => {
    const image = this.loadedImage();
    const result =
      method === "workspace-state.entity.resolveActive"
        ? {
            id: image.runtimeId,
            authoritySessionId: "actual-test-owner-session",
            kind: "do",
            source: { repoPath: image.source, effectiveVersion: "test" },
            activeExecutionDigest: image.executionDigest,
            className: image.className,
            key: image.objectKey,
            contextId: "ctx-1",
            createdAt: 1,
            status: "active",
            cleanupComplete: false,
          }
        : method === "workspace-state.alarmSourceRegister"
          ? "test-storage-incarnation"
          : method === "workspace-state.alarmSourcePublish"
            ? "accepted"
            : method === "authority.outstandingAcquisitions"
              ? { receipts: [], next: null }
              : [
                    "workspace-state.lifecycleLeaseUpsert",
                    "workspace-state.lifecycleLeaseClear",
                    "workerLog.write",
                  ].includes(method)
                ? undefined
                : (() => {
                    throw new Error(
                      `Unexpected native host fixture method ${method}`,
                    );
                  })();
    return result as T;
  };

  private readonly accountClients = new Map<string, GmailClient>();
  protected override createGmailClient(credentialId?: string): GmailClient {
    const key = credentialId ?? "default";
    const retained = this.accountClients.get(key);
    if (retained) return retained;
    const client = fakeGmailClient({
      thread: () => this.fakeThread,
      overrides: {
        getProfile: this.profile as never,
        syncSince: this.sync as never,
        listMessages: this.listMessages as never,
        sendMessage: this.sent as never,
        createDraft: this.createDraft as never,
        modifyLabels: this.modifyLabels as never,
        batchModify: this.batchModify as never,
        searchContacts: this.searchContacts as never,
        searchOtherContacts: this.searchOtherContacts as never,
      },
    });
    this.accountClients.set(key, client);
    return client;
  }

  protected override generateDraftReplyBody(
    channelId: string,
    thread: GmailThread,
  ): Promise<string> {
    if (this.useBaseDraftGeneration) {
      return super.generateDraftReplyBody(channelId, thread);
    }
    return this.draftBodies();
  }

  protected override async runTriageModel(
    channelId: string,
    _systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    this.triageCalls.push({ channelId, userPrompt });
    const next = this.triageResponses.shift();
    if (next === undefined) throw new Error("no triage response queued");
    return next;
  }

  protected override async submitAgentInitiatedTurn(
    channelId: string,
    input: { content?: string },
  ): Promise<void> {
    this.agentInitiatedTurns.push({ channelId, content: input.content ?? "" });
  }

  protected override createChannelClient(channelId: string) {
    return {
      getEnvelope: async (envelopeId: string) =>
        (await this.methodChannel(channelId)).channel.callAs(
          { callerId: this.participantId(), callerKind: "do" },
          "getEnvelope",
          envelopeId,
        ),
      markMethodCallExecutionStarted: async (
        participantId: string,
        callId: string,
        generation: number,
      ) =>
        (await this.methodChannel(channelId)).markExecutionStarted(
          participantId,
          callId,
          generation,
        ),
      relationshipState: async () => null,
      join: async (input: { participantId: string; revision: number }) => ({
        ok: true,
        participantId: input.participantId,
        revision: input.revision,
        channelConfig: undefined,
        envelope: { mode: "initial", logEvents: [], snapshots: [], ready: {} },
      }),
      leave: async (participantId: string) => {
        this.closedSubscriptions.push(participantId);
        return { ok: true };
      },
      getConfig: async () => null,
      getParticipants: async () => [],
      getReplayAfter: async (request: { after: number }) => ({
        mode: "after",
        logEvents: this.replayEvents.filter(
          (event) => event.id > request.after,
        ),
        snapshots: [],
        ready: {
          totalCount: this.replayEvents.length,
          envelopeCount: this.replayEvents.length,
        },
      }),
      publishAgenticEvent: async (
        participantId: string,
        event: { kind?: string; payload?: unknown },
        opts?: unknown,
      ) => {
        this.published.push({ participantId, event, opts });
        return { id: this.published.length };
      },
      sendSignal: async (
        participantId: string,
        content: string,
        type?: string,
      ) => {
        this.signals.push({ participantId, content, type });
      },
      getMessageType: async (typeId: string) => {
        const spec = GMAIL_MESSAGE_TYPES.find(
          (entry) => entry.typeId === typeId,
        );
        if (!spec) return null;
        return {
          typeId: spec.typeId,
          displayMode: spec.displayMode,
          stateSchema: spec.stateSchema,
          ...(spec.updateSchema ? { updateSchema: spec.updateSchema } : {}),
        };
      },
    } as never;
  }

  seedSubscription(channelId = "ch-1", participantId = "agent-gmail") {
    this.sql.exec(
      `INSERT OR REPLACE INTO subscriptions
         (channel_id, context_id, revision, subscribed_at, config, relationship_json, participant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      channelId,
      "ctx-1",
      1,
      Date.now(),
      JSON.stringify({ handle: "gmail" }),
      JSON.stringify({ test: true }),
      participantId,
    );
  }

  updateSubscriptionConfig(channelId: string, config: Record<string, unknown>) {
    this.sql.exec(
      `UPDATE subscriptions SET config = ? WHERE channel_id = ?`,
      JSON.stringify(config),
      channelId,
    );
  }

  seedRepliedSender(channelId = "ch-1", email = "a@example.com") {
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_replied_senders
       (channel_id, email, display, first_replied_at, last_replied_at, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
      channelId,
      email,
      email,
      Date.now(),
      Date.now(),
      "test",
    );
  }

  forkConfiguration(channelId: string) {
    return this.exportNativeAgentKnowledgeConfiguration(channelId);
  }
  restoreForkConfiguration(channelId: string, configuration: JsonValue) {
    return this.restoreNativeAgentKnowledgeConfiguration(
      channelId,
      configuration,
    );
  }

  prepareProductForTest(channelId: string, context: Context) {
    return this.prepareNativeChannelProduct(
      channelId,
      this.subscriptions.getConfig(channelId),
      null,
      context,
    );
  }
  watchForTest(channelId: string) {
    return this.ensureWatch(channelId);
  }

  composeInstances() {
    const operations = new Map<string, Promise<unknown>>();
    return [1, 2].map(
      () =>
        new GmailCards({
          cards: this.cards,
          sql: this.sql,
          composeOperations: operations,
        }),
    );
  }

  respondPolicy() {
    return this.getRespondPolicy();
  }

  prompt(channelId: string) {
    return this.getAgentPrompt(channelId);
  }

  async runnerTools(channelId = "ch-1") {
    return (await this.getTools(channelId)).map((tool) => tool.name);
  }

  seedUserRoster(channelId = "ch-1") {
    this.setStateValue(
      `agent:roster:${channelId}`,
      JSON.stringify([
        {
          participantId: "user:alice",
          ref: { kind: "user", id: "user:alice", participantId: "user:alice" },
          methods: [],
        },
      ]),
    );
  }

  async runnerTool(name: string, channelId = "ch-1") {
    return (await this.getTools(channelId)).find((tool) => tool.name === name);
  }

  participant() {
    return this.getParticipantInfo("ch-1");
  }

  model() {
    return this.getAgentSettings().model;
  }

  async debug(channelId = "ch-1") {
    return this.getDebugState(channelId);
  }

  drainWake(now = Date.now()) {
    return this.processWakeQueues(now);
  }

  drainTriage() {
    return this.processTriageQueues();
  }

  ageTriageQueue(channelId = "ch-1", byMs = 120_000) {
    this.sql.exec(
      `UPDATE gmail_triage_queue SET enqueued_at = enqueued_at - ? WHERE channel_id = ?`,
      byMs,
      channelId,
    );
  }

  triageQueueRows(channelId = "ch-1") {
    return this.sql
      .exec(`SELECT * FROM gmail_triage_queue WHERE channel_id = ?`, channelId)
      .toArray();
  }

  channelStateRow(channelId = "ch-1") {
    return this.sql
      .exec(`SELECT * FROM gmail_channel_state WHERE channel_id = ?`, channelId)
      .toArray()[0];
  }

  subscriptionRows() {
    return this.sql
      .exec(
        `SELECT channel_id, participant_id FROM subscriptions ORDER BY channel_id`,
      )
      .toArray();
  }

  rows(query: string, ...params: unknown[]) {
    return this.sql.exec(query, ...(params as never[])).toArray();
  }

  bootstrapIdentityForTest(): void {
    this.ensureIdentity();
  }
}

class NetworkMethodGmailWorker extends TestGmailAgentWorker {
  protected override createBoundGmailClient(
    rpc: RpcClient,
    credentialId?: string,
    context?: Context,
  ): GmailClient {
    return createGmailClient(createCredentialClient(rpc), {
      ...(credentialId ? { credentialId } : {}),
      signal: context?.abortSignal,
    });
  }
}

class NativeToolGmailWorker extends TestGmailAgentWorker {
  readonly boundClients: Array<{ rpc: RpcClient; credentialId?: string }> = [];
  readonly boundCalls: string[] = [];
  protected override async bindNativeToolExecution(
    api: ToolExecutionApi,
    context: Context,
  ) {
    context.abortSignal?.throwIfAborted();
    this.boundCalls.push(api.callId);
    return {
      invocationId: `native:${api.callId}`,
      commandId: `command:${api.callId}`,
      rpc: this.rpc,
    };
  }
  protected override createBoundGmailClient(
    rpc: RpcClient,
    credentialId?: string,
  ): GmailClient {
    this.boundClients.push({ rpc, credentialId });
    return this.createGmailClient();
  }
}

describe("GmailAgentWorker", () => {
  it("cancels and joins the original claimed Gmail network method without later publication", async () => {
    const { instance: worker } = await createTestDO(NetworkMethodGmailWorker);
    worker.seedSubscription();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let aborted!: () => void;
    const abortObserved = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    let cleanup!: () => void;
    const cleanupAllowed = new Promise<void>((resolve) => {
      cleanup = resolve;
    });
    let originalSignal: AbortSignal | undefined;
    let proxyCalls = 0;
    let networkJoined = false;
    worker.rpcStream = async (target, method, args, options) => {
      expect(target).toBe("main");
      expect(method).toBe("credentials.proxyFetch");
      expect(args[0]).toMatchObject({
        url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      });
      originalSignal = options?.signal;
      if (!originalSignal)
        throw new Error(
          "Gmail request did not retain its actual operation signal",
        );
      proxyCalls += 1;
      entered();
      await new Promise<void>((resolve) => {
        if (originalSignal!.aborted) resolve();
        else
          originalSignal!.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      aborted();
      await cleanupAllowed;
      networkJoined = true;
      throw originalSignal.reason;
    };
    const execution = worker.deliveredMethod(
      "ch-1",
      "cancel-gmail-network",
      "checkNow",
      {},
    );
    void execution.catch(() => undefined);
    await started;
    let cancelJoined = false;
    const cancellation = worker
      .cancelDeliveredMethod("ch-1", "cancel-gmail-network")
      .then(() => {
        cancelJoined = true;
      });
    await abortObserved;
    expect(cancelJoined).toBe(false);
    expect(networkJoined).toBe(false);
    const publicationsAtAbort = worker.published.length;
    cleanup();
    await cancellation;
    await expect(execution).rejects.toBe(originalSignal!.reason);
    expect(networkJoined).toBe(true);
    expect(proxyCalls).toBe(1);
    expect(worker.published).toHaveLength(publicationsAtAbort);
    expect(
      worker.rows(
        "SELECT history_id, last_error FROM gmail_channel_state WHERE channel_id = ?",
        "ch-1",
      ),
    ).toMatchObject([{ history_id: null, last_error: null }]);
  });

  it("uses Luna as the cheap Codex triage tier and keeps Sol as fallback", () => {
    expect(triageModelCandidates("openai-codex:gpt-6-sol")).toEqual([
      "openai-codex:gpt-6-luna",
      "openai-codex:gpt-6-sol",
    ]);
    expect(
      builtinModels()
        .getModels("openai-codex")
        .find((model) => model.id === "gpt-6-luna"),
    ).toMatchObject({
      id: "gpt-6-luna",
      provider: "openai-codex",
    });
  });

  it("serializes compose operations across distinct caller-bound card instances and joins failure before the next send", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    const [first, second] = worker.composeInstances();
    let release!: () => void;
    const started: string[] = [];
    const original = new Error("original remote send failure");
    const pending = first!.withCompose("ch-1", "actual-card", async () => {
      started.push("first");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw original;
    });
    const failed = expect(pending).rejects.toBe(original);
    const next = second!.withCompose("ch-1", "actual-card", async () => {
      started.push("second");
      return "sent";
    });
    await Promise.resolve();
    expect(started).toEqual(["first"]);
    release();
    await failed;
    await expect(next).resolves.toBe("sent");
    expect(started).toEqual(["first", "second"]);
  });

  it("isolates shared label caches by the actual account and preserves authority errors from optional send-as discovery", async () => {
    const shared = new Map<string, LabelCacheEntry>();
    const first = fakeGmailClient({
      overrides: {
        listLabels: async () => [
          { id: "account-one-label", name: "Invoices", type: "user" },
        ],
      },
    });
    const second = fakeGmailClient({
      overrides: {
        listLabels: async () => [
          { id: "account-two-label", name: "Invoices", type: "user" },
        ],
      },
    });
    const resolver = (client: GmailClient, account: string) =>
      new LabelResolver({
        gmailFor: () => client,
        cache: shared,
        cacheKey: (channel) => JSON.stringify([channel, account]),
      });
    await expect(
      resolver(first, "one").resolveIds("ch-1", ["Invoices"], {
        createMissing: false,
      }),
    ).resolves.toEqual(["account-one-label"]);
    await expect(
      resolver(second, "two").resolveIds("ch-1", ["Invoices"], {
        createMissing: false,
      }),
    ).resolves.toEqual(["account-two-label"]);
    const original = new Error("host approval withdrawn");
    const aliases = new SendAsCache({
      gmailFor: () =>
        fakeGmailClient({
          overrides: {
            listSendAs: async () => {
              throw original;
            },
          },
        }),
    });
    await expect(aliases.aliases("ch-1")).rejects.toBe(original);
    const missingScope = new SendAsCache({
      gmailFor: () =>
        fakeGmailClient({
          overrides: {
            listSendAs: async () => {
              throw new GmailApiError(
                "missing optional settings scope",
                "forbidden",
                { status: 403 },
              );
            },
          },
        }),
    });
    await expect(missingScope.aliases("ch-1")).resolves.toEqual([]);
  });

  it("restores the original user/account configuration into fresh Gmail storage without copying execution or sync debt", async () => {
    const source = (await createTestDO(TestGmailAgentWorker))
      .instance as TestGmailAgentWorker;
    await source.configureAgent({
      model: "anthropic:claude-sonnet-4-6",
      thinkingLevel: "high",
      fastMode: true,
    });
    source.seedSubscription();
    source.updateSubscriptionConfig("ch-1", {
      credentialId: "original-account",
    });
    await source.setAttentionPrefs("ch-1", {
      preferences: "Invoices need attention",
      knownSenderShortcut: false,
    });
    source.execSqlForTest(
      "UPDATE gmail_attention_prefs SET triage_model = ? WHERE channel_id = ?",
      "openai-codex:gpt-6-luna",
      "ch-1",
    );
    const original = source.forkConfiguration("ch-1");
    await source.setAttentionPrefs("ch-1", {
      preferences: "Changed after export",
    });
    const receiving = (
      await createTestDO(TestGmailAgentWorker, { __objectKey: "fresh-gmail" })
    ).instance as TestGmailAgentWorker;
    await receiving.restoreForkConfiguration("fork-channel", original);
    await receiving.restoreForkConfiguration("fork-channel", original);
    expect(receiving.forkConfiguration("fork-channel")).toMatchObject({
      agentSettings: {
        model: "anthropic:claude-sonnet-4-6",
        thinkingLevel: "high",
        fastMode: true,
      },
      domain: {
        attention: {
          preferencesText: "Invoices need attention",
          knownSenderShortcut: false,
          triageModel: "openai-codex:gpt-6-luna",
        },
      },
    });
    expect(
      receiving.rows(
        "SELECT credential_id,history_id,watch_expiration,last_sync_at FROM gmail_channel_state WHERE channel_id = ?",
        "fork-channel",
      )[0],
    ).toMatchObject({
      credential_id: "original-account",
      history_id: null,
      watch_expiration: null,
      last_sync_at: null,
    });
    expect(receiving.rows("SELECT * FROM gmail_triage_queue")).toEqual([]);
    expect(receiving.rows("SELECT * FROM gmail_attention_queue")).toEqual([]);
  });

  it("executes the original native offer against its pinned account after channel configuration changes", async () => {
    const { instance } = await createTestDO(NativeToolGmailWorker);
    const worker = instance as NativeToolGmailWorker;
    worker.seedSubscription();
    worker.updateSubscriptionConfig("ch-1", {
      credentialId: "original-account",
    });
    const original = (await worker.runnerTool("gmail_read"))!;
    expect(original.executionData).toMatchObject({
      channelId: "ch-1",
      credentialId: "original-account",
    });
    worker.updateSubscriptionConfig("ch-1", {
      credentialId: "replacement-account",
    });
    const refreshed = (await worker.runnerTool("gmail_read"))!;
    const result = await refreshed.execute(
      { threadId: "thr-1" },
      {
        ...nativeToolApi({ callId: "actual-native-call" }),
        executionData: original.executionData,
      },
      nativeToolContext(),
    );
    expect(result).toMatchObject({ details: { threadId: "thr-1" } });
    expect(worker.boundCalls).toEqual(["actual-native-call"]);
    expect(worker.boundClients.map((value) => value.credentialId)).toEqual([
      "original-account",
    ]);
    expect(refreshed.executionData).toMatchObject({
      credentialId: "replacement-account",
    });
  });

  it("rejects a missing native account offer before creating a caller or making Gmail requests", async () => {
    const { instance } = await createTestDO(NativeToolGmailWorker);
    const worker = instance as NativeToolGmailWorker;
    worker.seedSubscription();
    const tool = (await worker.runnerTool("gmail_read"))!;
    await expect(
      tool.execute({ threadId: "thr-1" }, nativeToolApi(), nativeToolContext()),
    ).rejects.toThrow("original native account binding");
    expect(worker.boundCalls).toEqual([]);
    expect(worker.boundClients).toEqual([]);
  });

  it("owns one current schema for this system epoch", () => {
    expect(GmailAgentWorker.schemaVersion).toBe(1);
  });

  it("advertises Gmail and standard agent methods with mention-or-followup policy", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;

    expect(worker.respondPolicy()).toBe("mentioned-or-followup");
    expect(worker.participant()).toMatchObject({
      handle: "gmail",
      name: "Gmail",
      type: "agent",
    });
    const methods = worker.participant().methods?.map((method) => method.name);
    expect(methods).toContain("checkNow");
    expect(methods).toContain("gmail_query");
    expect(methods).toContain("getAttentionPrefs");
    expect(methods).toContain("connectModelCredential");
    expect(methods).toContain("getAgentSettings");
    expect(worker.prompt("ch-1")).toContain("Gmail agent");
  });

  it("inherits model credential methods and honors configured model overrides", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    // Model is PER-AGENT (not per-channel subscription config) — set it via the
    // agent settings record, which credential operations resolve from.
    await worker.configureAgent({ model: "anthropic:claude-sonnet-4-6" });

    expect(worker.model()).toBe("anthropic:claude-sonnet-4-6");
    expect(
      worker.participant().methods?.map((method) => method.name),
    ).toContain("connectModelCredential");
  });

  it("exposes the consolidated composable tool surface", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedUserRoster();
    worker.seedSubscription();

    expect(await worker.runnerTools()).not.toContain(
      "gmail_upsertAttentionRule",
    );
    expect(await worker.runnerTools()).toEqual([
      "suspend_turn",
      "ask_user",
      "gmail_search",
      "gmail_read",
      "gmail_modify",
      "gmail_draft",
      "gmail_send",
      "gmail_contacts",
      "gmail_set_attention",
      "gmail_snooze",
      "gmail_list_reminders",
      "gmail_get_attachment",
      "gmail_publish_digest",
    ]);
  });

  it("advertises strict Gmail runner tool schemas with pagination", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;

    worker.seedSubscription();
    expect((await worker.runnerTool("gmail_search"))?.parameters).toMatchObject(
      {
        type: "object",
        required: ["q"],
        additionalProperties: false,
        properties: {
          q: { type: "string", minLength: 1 },
          pageToken: { type: "string" },
          limit: { type: "number", maximum: 50 },
        },
      },
    );
    expect((await worker.runnerTool("gmail_modify"))?.parameters).toMatchObject(
      {
        type: "object",
        additionalProperties: false,
        properties: {
          threadIds: { type: "array" },
          addLabels: { type: "array" },
          archive: { type: "boolean" },
        },
      },
    );
  });

  it("persists the Google credential pin from subscription config", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker, {
      WORKERD_SESSION_ID: "test-session",
      WORKERD_BOOT_GENERATION: "1",
    });
    const worker = instance as TestGmailAgentWorker;

    await worker.subscribeChannel({
      channelId: "ch-1",
      contextId: "ctx-1",
      replay: false,
      config: { handle: "gmail", googleCredentialId: "google-cred-2" },
    });

    expect(worker.channelStateRow("ch-1")).toMatchObject({
      channel_id: "ch-1",
      credential_id: "google-cred-2",
    });
  });

  it("removes local subscription state when unsubscribing from a channel", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    const { participantId } = await worker.subscribeChannel({
      channelId: "ch-1",
      contextId: "ctx-1",
      replay: false,
    });

    await expect(worker.unsubscribeChannel("ch-1")).resolves.toEqual({
      ok: true,
    });

    expect(worker.closedSubscriptions).toEqual([participantId]);
    expect(worker.subscriptionRows()).toEqual([]);
  });

  it("retains native bootstrap signal and original authority failure through required renderer preparation", async () => {
    const worker = (await createTestDO(TestGmailAgentWorker))
      .instance as TestGmailAgentWorker;
    worker.seedSubscription();
    const original = new RpcBoundaryError(
      "Required renderer read denied",
      "access",
      "EACCES",
    );
    worker.rendererReadFailure = original;
    const controller = new AbortController();
    await expect(
      worker.prepareProductForTest("ch-1", {
        ...nativeToolContext(),
        abortSignal: controller.signal,
      }),
    ).rejects.toBe(original);
    const reads = worker.rpcCall.mock.calls.filter(
      (call) => call[1] === "fs.readFile",
    );
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((call) => call[3]?.signal === controller.signal)).toBe(
      true,
    );
    expect(worker.published).toEqual([]);
  });

  it("optional Gmail push rejection degrades only protocol errors and preserves original host failure", async () => {
    const worker = (await createTestDO(TestGmailAgentWorker))
      .instance as TestGmailAgentWorker;
    worker.seedSubscription();
    worker.updateSubscriptionConfig("ch-1", {
      googlePubSubTopicName: "projects/p/topics/gmail-push",
    });
    await worker.deliveredMethod("ch-1", "resolve-mailbox", "checkNow", {});
    const client = worker["gmailForChannel"]("ch-1");
    const original = new RpcBoundaryError(
      "Credential owner disconnected",
      "transport",
      "SESSION_CONNECTION_LOST",
    );
    client.watch = vi.fn(async () => {
      throw original;
    });
    await expect(worker.watchForTest("ch-1")).rejects.toBe(original);
    client.watch = vi.fn(async () => {
      throw new GmailApiError("Optional push unavailable", "forbidden", {
        status: 403,
      });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(worker.watchForTest("ch-1")).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("continues Gmail UI registration when renderer source files are transiently unreadable", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker, {
      WORKERD_SESSION_ID: "test-session",
      WORKERD_BOOT_GENERATION: "1",
    });
    const worker = instance as TestGmailAgentWorker;
    worker.unreadableRendererSources = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(
        worker.subscribeChannel({
          channelId: "ch-1",
          contextId: "ctx-1",
          replay: false,
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("renderer lint skipped"),
      );
    } finally {
      warn.mockRestore();
    }

    expect(worker.published.map((entry) => entry.event.kind)).toEqual([
      "messageType.cleared",
      "messageType.registered",
      "messageType.registered",
      "messageType.registered",
      "messageType.registered",
      "messageType.registered",
      "ui.action_bar.updated",
      "custom.started",
    ]);
  });

  it("blocks Gmail UI registration when renderer lint finds unsupported imports", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker, {
      WORKERD_SESSION_ID: "test-session",
      WORKERD_BOOT_GENERATION: "1",
    });
    const worker = instance as TestGmailAgentWorker;
    worker.rendererSourceOverrides.set(
      GMAIL_MESSAGE_TYPES[0]!.path,
      `import lodash from "lodash";\nexport default function GmailSetup() { return null; }\n`,
    );

    await expect(
      worker.subscribeChannel({
        channelId: "ch-1",
        contextId: "ctx-1",
        replay: false,
      }),
    ).rejects.toThrow(
      /Renderer registration blocked:[\s\S]*Value import "lodash"/,
    );

    expect(worker.published).toEqual([]);
  });

  it("starts first-run setup and installs the card inventory (tombstoning gmail.inbox)", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker, {
      WORKERD_SESSION_ID: "test-session",
      WORKERD_BOOT_GENERATION: "1",
    });
    const worker = instance as TestGmailAgentWorker;

    await expect(
      worker.subscribeChannel({
        channelId: "ch-1",
        contextId: "ctx-1",
        replay: false,
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(worker.published.map((entry) => entry.event.kind)).toEqual([
      "messageType.cleared",
      "messageType.registered",
      "messageType.registered",
      "messageType.registered",
      "messageType.registered",
      "messageType.registered",
      "ui.action_bar.updated",
      "custom.started",
    ]);
    expect(
      worker.published.map(
        (entry) => (entry.event.payload as { typeId?: string }).typeId,
      ),
    ).toEqual([
      "gmail.inbox",
      "gmail.setup",
      "gmail.digest",
      "gmail.search",
      "gmail.thread",
      "gmail.compose",
      undefined,
      "gmail.setup",
    ]);
    expect(worker.published[1]?.event.payload).toMatchObject({
      stateSchema: { type: "object" },
      imports: {
        react: "latest",
        "react/jsx-runtime": "latest",
        "@radix-ui/themes": "npm:^3.2.1",
        "@radix-ui/react-icons": "npm:^1.3.2",
      },
    });
    expect(worker.published[6]?.event.payload).toMatchObject({
      uiType: "action_bar",
      source: { type: "file", path: "packages/gmail/src/action-bar.tsx" },
      maxHeight: 64,
    });
    expect(worker.agentInitiatedTurns).toEqual([
      {
        channelId: "ch-1",
        content: expect.stringContaining("what kinds of incoming email"),
      },
    ]);

    await worker.subscribeChannel({
      channelId: "ch-1",
      contextId: "ctx-1",
      replay: false,
    });
    expect(worker.agentInitiatedTurns).toHaveLength(1);
  });

  it("batches known-sender wakes into one debounced digest turn with per-message dedup", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker, {
      WORKERD_SESSION_ID: "test-session",
      WORKERD_BOOT_GENERATION: "1",
    });
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    await worker.deliveredMethod("ch-1", "call-1", "checkNow", {});
    await worker.drainWake(Date.now() + 91_000);
    expect(worker.agentInitiatedTurns).toEqual([]);

    worker.seedRepliedSender("ch-1", "a@example.com");
    await worker.deliveredMethod("ch-1", "call-2", "checkNow", {});
    // The hit is queued, not turned into an immediate per-message turn.
    expect(worker.agentInitiatedTurns).toEqual([]);
    await worker.drainWake(Date.now());
    expect(worker.agentInitiatedTurns).toEqual([]); // debounce window still open
    await worker.drainWake(Date.now() + 91_000);
    expect(worker.agentInitiatedTurns).toHaveLength(1);
    expect(worker.agentInitiatedTurns[0]?.content).toContain(
      "matched your attention preferences",
    );
    expect(worker.agentInitiatedTurns[0]?.content).toContain(
      "From someone you have replied to before",
    );
    expect(worker.agentInitiatedTurns[0]?.content).toContain(
      "ONE short digest message",
    );

    // The same message does not re-enqueue (gmail_attention_turns dedup).
    await worker.deliveredMethod("ch-1", "call-3", "checkNow", {});
    await worker.drainWake(Date.now() + 200_000);
    expect(worker.agentInitiatedTurns).toHaveLength(1);
  });

  it("queues unknown senders for the batched LLM triage pass and wakes on its verdict", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    worker.fakeThread = {
      id: "thr-1",
      messages: [
        message(
          "msg-urgent",
          "thr-1",
          {
            Subject: "Server down",
            From: "alerts@vendor.example",
            To: "me@example.com",
            Date: "Fri, 22 May 2026 10:15:00 +0000",
          },
          "Production incident",
          "Production incident",
        ),
      ],
    };

    // Save preferences (also enables the LLM pass).
    await worker.deliveredMethod("ch-1", "call-1", "gmail_set_attention", {
      preferences:
        "Wake me for production incidents and urgent operational mail.",
      markConfigured: true,
    });

    await worker.deliveredMethod("ch-1", "call-2", "checkNow", {});
    await worker.deliveredMethod("ch-1", "call-3", "checkNow", {});
    expect(worker.triageQueueRows()).toHaveLength(1);
    expect(worker.agentInitiatedTurns).toEqual([]);

    // Too fresh: no LLM call yet.
    await worker.drainTriage();
    expect(worker.triageCalls).toHaveLength(0);

    worker.ageTriageQueue();
    worker.triageResponses = [
      JSON.stringify([
        {
          i: 1,
          decision: "wake",
          reason: "Production incident matches your preferences",
        },
      ]),
    ];
    await worker.drainTriage();
    expect(worker.triageCalls).toHaveLength(1);
    expect(worker.triageCalls[0]?.userPrompt).toContain("production incidents");
    expect(worker.triageCalls[0]?.userPrompt).toContain("Server down");
    expect(worker.triageQueueRows()).toHaveLength(0);

    await worker.drainWake(Date.now() + 91_000);
    expect(worker.agentInitiatedTurns).toHaveLength(1);
    expect(worker.agentInitiatedTurns[0]?.content).toContain(
      "Production incident matches your preferences",
    );
  });

  it("falls back to surface (visible, no wake) when the triage model stays unavailable", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    await worker.deliveredMethod("ch-1", "call-1", "gmail_set_attention", {
      preferences: "Wake me for urgent mail.",
      markConfigured: true,
    });
    await worker.deliveredMethod("ch-1", "call-2", "checkNow", {});
    await worker.deliveredMethod("ch-1", "call-3", "checkNow", {});
    expect(worker.triageQueueRows()).toHaveLength(1);

    // Two failed attempts (no responses queued) → deterministic fallback.
    worker.ageTriageQueue();
    await worker.drainTriage();
    expect(worker.triageQueueRows()).toHaveLength(1); // retriable, still queued
    await worker.drainTriage();
    expect(worker.triageQueueRows()).toHaveLength(0); // fallback consumed it

    // Non-prior-reply fallback is surface: hit recorded, no wake turn.
    await worker.drainWake(Date.now() + 200_000);
    expect(worker.agentInitiatedTurns).toEqual([]);
    const hits = worker.rows(
      `SELECT * FROM gmail_attention_hits WHERE channel_id = ?`,
      "ch-1",
    );
    expect(hits).toHaveLength(1);
    expect(String(hits[0]?.["reason"])).toContain("Triage model unavailable");
  });

  it("schedules the alarm at the earliest of triage retry, wake deadline, and poll interval", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    const base = 1_750_000_000_000;
    worker.clock = base;

    await worker.deliveredMethod("ch-1", "call-1", "gmail_set_attention", {
      preferences: "Wake me for urgent mail.",
      markConfigured: true,
    });
    // Bootstrap + one history sync enqueue a triage candidate at `base`.
    await worker.deliveredMethod("ch-1", "call-2", "checkNow", {});
    await worker.deliveredMethod("ch-1", "call-3", "checkNow", {});
    expect(worker.triageQueueRows()).toHaveLength(1);

    // Candidate is 30s old: triage retry (~30s) beats the 5-min poll interval.
    worker.clock = base + 30_000;
    const firstSchedule = await worker.alarm();
    expect(firstSchedule).not.toBeNull();
    expect(firstSchedule!.wakeAt - worker.clock).toBeGreaterThan(0);
    expect(firstSchedule!.wakeAt - worker.clock).toBeLessThanOrEqual(30_000);

    // Candidate aged past 60s: the triage pass runs (and here wakes), so the
    // wake debounce deadline (~90s) becomes the earliest signal.
    worker.clock = base + 61_000;
    worker.triageResponses = [
      JSON.stringify([{ i: 1, decision: "wake", reason: "urgent" }]),
    ];
    const secondSchedule = await worker.alarm();
    expect(worker.triageCalls).toHaveLength(1);
    expect(worker.triageQueueRows()).toHaveLength(0);
    expect(secondSchedule).not.toBeNull();
    expect(secondSchedule!.wakeAt - worker.clock).toBeLessThanOrEqual(90_000);

    // Past the debounce deadline the queued wake drains into a digest turn,
    // and the next alarm falls back to the poll interval.
    worker.clock = base + 61_000 + 91_000;
    const thirdSchedule = await worker.alarm();
    expect(worker.agentInitiatedTurns).toHaveLength(1);
    expect(thirdSchedule).not.toBeNull();
    expect(thirdSchedule!.wakeAt - worker.clock).toBeLessThanOrEqual(
      5 * 60 * 1000,
    );
  });

  it("skips auth-needed channels and honors rate-limit backoff in alarm scheduling", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    const base = 1_750_000_000_000;
    worker.clock = base;

    // Seed channel state, then mark it rate-limited for 2 minutes.
    await worker.deliveredMethod("ch-1", "call-1", "checkNow", {});
    worker.execSqlForTest(
      `UPDATE gmail_channel_state SET rate_limited_until = ? WHERE channel_id = ?`,
      base + 120_000,
      "ch-1",
    );
    worker.profile.mockClear();
    worker.sync.mockClear();
    const rateLimitSchedule = await worker.alarm();
    expect(worker.sync).not.toHaveBeenCalled();
    // The alarm targets the backoff deadline, not the poll interval.
    expect(rateLimitSchedule).not.toBeNull();
    expect(rateLimitSchedule!.wakeAt - worker.clock).toBeLessThanOrEqual(
      120_000,
    );
    expect(rateLimitSchedule!.wakeAt - worker.clock).toBeGreaterThan(60_000);

    // Auth-needed channels neither sync nor reschedule polling.
    worker.execSqlForTest(
      `UPDATE gmail_channel_state SET sync_state = 'auth-needed', rate_limited_until = NULL WHERE channel_id = ?`,
      "ch-1",
    );
    const authNeededSchedule = await worker.alarm();
    expect(worker.sync).not.toHaveBeenCalled();
    expect(authNeededSchedule).toBeNull();
  });

  it("saves natural-language attention preferences and reads them back", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    await expect(worker.getAttentionPrefs("other-channel")).rejects.toThrow(
      "not subscribed",
    );

    // Unsaved channels report the default preference text.
    await expect(worker.getAttentionPrefs("ch-1")).resolves.toMatchObject({
      preferencesText: expect.stringContaining("people I have replied to"),
      knownSenderShortcut: true,
    });

    await expect(
      worker.deliveredMethod("ch-1", "call-1", "gmail_set_attention", {
        preferences:
          "Invoices, scheduling changes, and anything from acme.example.",
        markConfigured: true,
        summary: "Watching invoices, scheduling, acme.example",
      }),
    ).resolves.toMatchObject({
      result: { saved: true, configured: true },
    });
    await expect(worker.getAttentionPrefs("ch-1")).resolves.toMatchObject({
      preferencesText:
        "Invoices, scheduling changes, and anything from acme.example.",
    });
    expect(worker.channelStateRow("ch-1")).toMatchObject({
      setup_status: "configured",
    });

    // append mode extends rather than replaces.
    await worker.deliveredMethod("ch-1", "call-2", "gmail_set_attention", {
      preferences: "Also wake me for anything mentioning the Q3 audit.",
      mode: "append",
    });
    const prefs = await worker.getAttentionPrefs("ch-1");
    expect(prefs.preferencesText).toContain("acme.example");
    expect(prefs.preferencesText).toContain("Q3 audit");

    // DO callers cannot silently rewrite preferences.
    (
      worker as unknown as {
        _currentVerifiedCaller: { callerId: string; callerKind: string } | null;
      }
    )._currentVerifiedCaller = { callerId: "do:other", callerKind: "do" };
    await expect(
      worker.setAttentionPrefs("ch-1", { preferences: "hijacked" }),
    ).rejects.toThrow("user-facing panel");
    (
      worker as unknown as {
        _currentVerifiedCaller: { callerId: string; callerKind: string } | null;
      }
    )._currentVerifiedCaller = null;

    await expect(
      worker.setAttentionPrefs("ch-1", {
        preferences: "Only mail from my team.",
      }),
    ).resolves.toMatchObject({ saved: true });
  });

  it("reports a scoped dry run over recent triage hits when preferences change", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    worker.fakeThread = {
      id: "thr-1",
      messages: [
        message("msg-urgent", "thr-1", {
          Subject: "Server down",
          From: "alerts@vendor.example",
          To: "me@example.com",
          Date: "Fri, 22 May 2026 10:15:00 +0000",
        }),
      ],
    };
    await worker.deliveredMethod("ch-1", "call-1", "gmail_set_attention", {
      preferences: "Wake me for production incidents.",
      markConfigured: true,
      dryRun: false,
    });
    await worker.deliveredMethod("ch-1", "call-2", "checkNow", {});
    await worker.deliveredMethod("ch-1", "call-3", "checkNow", {});
    worker.ageTriageQueue();
    worker.triageResponses = [
      JSON.stringify([{ i: 1, decision: "wake", reason: "incident" }]),
    ];
    await worker.drainTriage();

    // Now narrow the preferences; the dry run re-evaluates the recorded hit.
    worker.triageResponses = [
      JSON.stringify([
        { i: 1, decision: "ignore", reason: "no longer relevant" },
      ]),
    ];
    const result = await worker.deliveredMethod(
      "ch-1",
      "call-4",
      "gmail_set_attention",
      {
        preferences: "Only wake me for mail from my manager.",
      },
    );
    expect(result.isError).toBeUndefined();
    expect(result.result).toMatchObject({
      saved: true,
      dryRun: {
        reEvaluated: 1,
        changed: [
          expect.objectContaining({
            threadId: "thr-1",
            before: "wake",
            after: "ignore",
          }),
        ],
        unchanged: 0,
        note: expect.stringContaining(
          "previously ignored mail is not re-checked",
        ),
      },
    });
    // The dry run is read-only: it does not consume the triage queue (the
    // retriage that follows re-enqueued the stored unread thread).
    expect(worker.triageQueueRows()).toHaveLength(1);

    // dryRun: false (the setAttentionPrefs RPC path) skips the model call.
    worker.triageCalls = [];
    await worker.setAttentionPrefs("ch-1", {
      preferences: "Everything important.",
    });
    expect(worker.triageCalls).toEqual([]);
  });

  it("lets the agent mark Gmail setup configured", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    await expect(
      worker.deliveredMethod("ch-1", "call-1", "markConfigured", {
        summary: "Watching invoices and scheduling mail.",
      }),
    ).resolves.toMatchObject({
      result: {
        configured: true,
        summary: "Watching invoices and scheduling mail.",
      },
    });

    const setup = worker.published.find(
      (entry) =>
        (entry.event.payload as { typeId?: string }).typeId === "gmail.setup",
    );
    expect(setup?.event.payload).toMatchObject({
      initialState: {
        status: "configured",
        setupSummary: "Watching invoices and scheduling mail.",
        auth: { status: "unknown" },
        attentionPreference: expect.any(String),
      },
    });
  });

  it("emits a connect-only credential card for one-shot draft generation without entering external wait", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    worker.useBaseDraftGeneration = true;
    const originalCall = worker.rpcCall.getMockImplementation()!;
    worker.rpcCall.mockImplementation(
      async (...args: Parameters<typeof originalCall>) => {
        if (args[1] === "credentials.resolveCredential") return null;
        return originalCall(...args);
      },
    );

    await expect(
      worker.deliveredMethod("ch-1", "call-1", "draftReply", {
        threadId: "thr-1",
      }),
    ).rejects.toMatchObject({
      name: "NativeModelCredentialMissing",
      message: "No model credential configured for openai-codex",
    });
    const inlineUi = worker.published.find(
      (entry) => entry.event.kind === "ui.inline_rendered",
    );
    expect(inlineUi?.event.payload).toMatchObject({
      uiType: "inline",
      props: expect.objectContaining({
        providerId: "openai-codex",
        resumeAfterConnect: false,
      }),
    });
  });

  it("fetches sanitized thread contents for renderer expansion", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;

    const result = await worker.deliveredMethod(
      "ch-1",
      "call-1",
      "gmail_read",
      {
        threadId: "thr-1",
        format: "full",
        includeAttachmentList: true,
      },
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toMatchObject({
      threadId: "thr-1",
      messages: [
        {
          id: "msg-1",
          from: "a@example.com",
          subject: "Question",
          bodyText: "Private full email body",
        },
      ],
    });
  });

  it("reads metadata-only message summaries via gmail_read", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;

    const result = await worker.deliveredMethod(
      "ch-1",
      "call-1",
      "gmail_read",
      {
        threadId: "thr-1",
        format: "metadata",
      },
    );

    expect(result.isError).toBeUndefined();
    const payload = result.result as {
      messages: Array<Record<string, unknown>>;
    };
    expect(payload.messages[0]).toMatchObject({ subject: "Question" });
    expect(payload.messages[0]).not.toHaveProperty("bodyText");
  });

  it("sends an owned compose and rejects sends without compose identity", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    await expect(
      worker.deliveredMethod("ch-1", "missing", "gmail_send", {
        to: "b@example.com",
        subject: "Hello",
        body: "Body",
      }),
    ).rejects.toThrow("messageId is required");
    expect(worker.sent).not.toHaveBeenCalled();
    const compose = await worker.deliveredMethod(
      "ch-1",
      "compose",
      "compose",
      {},
    );
    const result = await worker.deliveredMethod(
      "ch-1",
      "call-1",
      "gmail_send",
      {
        messageId: (compose.result as { messageId: string }).messageId,
        to: "b@example.com",
        subject: "Re: Question",
        body: "Done",
      },
    );

    expect(result.result).toEqual({ sent: true, id: "sent-1" });
    expect(worker.sent).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "b@example.com",
        subject: "Re: Question",
        body: "Done",
      }),
    );
  });

  it("resolves compose replies from the source thread", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    const compose = await worker.deliveredMethod("ch-1", "compose", "compose", {
      threadId: "thr-1",
    });
    const result = await worker.deliveredMethod(
      "ch-1",
      "call-1",
      "gmail_send",
      {
        messageId: (compose.result as { messageId: string }).messageId,
        threadId: "thr-1",
        body: "Inline reply",
      },
    );

    expect(result.result).toEqual({ sent: true, id: "sent-1" });
    expect(worker.sent).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "a@example.com",
        subject: "Re: Question",
        body: "Inline reply",
        threadId: "thr-1",
        inReplyTo: "<msg-1@example.com>",
        references: "<msg-1@example.com>",
      }),
    );
  });

  it("uses a one-shot draft generator for reply compose cards", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    const result = await worker.deliveredMethod(
      "ch-1",
      "call-1",
      "draftReply",
      {
        threadId: "thr-1",
      },
    );

    expect(result.isError).toBeUndefined();
    expect(worker.draftBodies).toHaveBeenCalledOnce();
    expect(result.result).toMatchObject({
      body: "Thanks for the context. I will follow up shortly.",
    });
    expect(
      worker.published[worker.published.length - 1]?.event.payload,
    ).toMatchObject({
      typeId: "gmail.compose",
      initialState: {
        to: "a@example.com",
        subject: "Re: Question",
        body: "Thanks for the context. I will follow up shortly.",
        threadId: "thr-1",
        // Agent-generated drafts always land in review; only the user sends.
        status: "review",
      },
    });
  });

  it("creates review-state compose cards from gmail_draft with the agent-written body", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    const result = await worker.deliveredMethod(
      "ch-1",
      "call-1",
      "gmail_draft",
      {
        mode: "reply",
        threadId: "thr-1",
        body: "Here is the agent-written reply.",
      },
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toMatchObject({ status: "review" });
    // The main model writes the body itself — no one-shot generator call.
    expect(worker.draftBodies).not.toHaveBeenCalled();
    expect(
      worker.published[worker.published.length - 1]?.event.payload,
    ).toMatchObject({
      typeId: "gmail.compose",
      initialState: {
        to: "a@example.com",
        subject: "Re: Question",
        body: "Here is the agent-written reply.",
        status: "review",
      },
    });

    // Incomplete drafts park in drafting state instead of erroring.
    const parked = await worker.deliveredMethod(
      "ch-1",
      "call-2",
      "gmail_draft",
      {
        mode: "new",
        body: "No recipient yet.",
      },
    );
    expect(parked.result).toMatchObject({
      status: "drafting",
      note: expect.stringContaining("drafting state"),
    });
  });

  it("syncs Gmail state into cards without durably publishing message bodies", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    await expect(
      worker.deliveredMethod("ch-1", "call-1", "checkNow", {}),
    ).resolves.toMatchObject({
      result: { ok: true, historyId: "h1", threadsUpdated: 0 },
    });
    await expect(
      worker.deliveredMethod("ch-1", "call-2", "checkNow", {}),
    ).resolves.toMatchObject({
      result: { ok: true, historyId: "h2", threadsUpdated: 1 },
    });

    // Routine syncs only touch the setup card — no chat messages, no inbox
    // dashboard, and never full message bodies.
    const typeIds = worker.published
      .map((entry) => (entry.event.payload as { typeId?: string }).typeId)
      .filter(Boolean);
    expect(new Set(typeIds)).toEqual(new Set(["gmail.setup"]));
    expect(JSON.stringify(worker.published)).not.toContain(
      "Private full email body",
    );
  });

  it("applies local categories through gmail_modify", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    await worker.deliveredMethod("ch-1", "call-1", "checkNow", {});
    await worker.deliveredMethod("ch-1", "call-2", "checkNow", {});

    await expect(
      worker.deliveredMethod("ch-1", "call-3", "gmail_modify", {
        threadIds: ["thr-1"],
        localCategory: "urgent",
      }),
    ).resolves.toMatchObject({
      result: { modified: true, threadIds: ["thr-1"] },
    });
    const row = worker.rows(
      `SELECT category FROM gmail_threads WHERE channel_id = ? AND thread_id = ?`,
      "ch-1",
      "thr-1",
    )[0];
    expect(row).toMatchObject({ category: "urgent" });
    // Local-only category: no Gmail label mutation.
    expect(worker.modifyLabels).not.toHaveBeenCalled();
    expect(worker.batchModify).not.toHaveBeenCalled();
  });

  it("archives and marks read through gmail_modify with real label changes", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    await worker.deliveredMethod("ch-1", "call-1", "checkNow", {});
    await worker.deliveredMethod("ch-1", "call-2", "checkNow", {});

    await expect(
      worker.deliveredMethod("ch-1", "call-3", "gmail_modify", {
        threadIds: ["thr-1"],
        markRead: true,
        archive: true,
      }),
    ).resolves.toMatchObject({
      result: {
        modified: true,
        removedLabels: expect.arrayContaining(["UNREAD", "INBOX"]),
      },
    });
    expect(worker.modifyLabels).toHaveBeenCalledWith({
      threadId: "thr-1",
      addLabelIds: [],
      removeLabelIds: expect.arrayContaining(["UNREAD", "INBOX"]),
    });
    const row = worker.rows(
      `SELECT unread, in_inbox FROM gmail_threads WHERE channel_id = ? AND thread_id = ?`,
      "ch-1",
      "thr-1",
    )[0];
    expect(row).toMatchObject({ unread: 0, in_inbox: 0 });

    // Message-id batches go through the native batchModify endpoint.
    await worker.deliveredMethod("ch-1", "call-4", "gmail_modify", {
      messageIds: ["m1", "m2"],
      markRead: true,
    });
    expect(worker.batchModify).toHaveBeenCalledWith({
      messageIds: ["m1", "m2"],
      addLabelIds: [],
      removeLabelIds: ["UNREAD"],
    });
  });

  it("publishes search results as an ephemeral search card", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    const result = await worker.deliveredMethod(
      "ch-1",
      "call-1",
      "gmail_search",
      {
        q: "from:a",
      },
    );
    expect(result.isError).toBeUndefined();
    expect(result.result).toMatchObject({ query: "from:a", count: 0 });

    const searchEvents = worker.published.filter(
      (entry) =>
        (entry.event.payload as { typeId?: string }).typeId === "gmail.search",
    );
    expect(searchEvents.length).toBeGreaterThanOrEqual(1);
    expect(searchEvents[0]?.event.payload).toMatchObject({
      initialState: { query: "from:a", status: "searching" },
    });
    const updated = worker.published.find(
      (entry) => entry.event.kind === "custom.updated",
    );
    expect(updated?.event.payload).toMatchObject({
      update: { status: "done" },
    });

    // Internal lookups skip the card entirely.
    const before = worker.published.length;
    await worker.deliveredMethod("ch-1", "call-2", "gmail_search", {
      q: "from:b",
      mirrorToCard: false,
    });
    expect(worker.published.length).toBe(before);
  });

  it("searches at true thread granularity with pagination via threads.list", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    const listThreads = vi.fn(async (opts: { pageToken?: string }) =>
      opts.pageToken
        ? { threads: [{ id: "thr-3" }] }
        : {
            threads: [{ id: "thr-1" }, { id: "thr-2" }],
            nextPageToken: "page-2",
            resultSizeEstimate: 3,
          },
    );
    const batchGetThreads = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        value: {
          id,
          messages: [
            message(`${id}-m1`, id, {
              Subject: `Subject ${id}`,
              From: "a@example.com",
              To: "me@example.com",
              Date: "Fri, 22 May 2026 10:00:00 +0000",
            }),
          ],
        },
      })),
    );
    const client = worker["gmailForChannel"]("ch-1") as unknown as {
      listThreads: typeof listThreads;
      batchGetThreads: typeof batchGetThreads;
    };
    client.listThreads = listThreads;
    client.batchGetThreads = batchGetThreads;

    const page1 = await worker.deliveredMethod(
      "ch-1",
      "call-1",
      "gmail_search",
      {
        q: "report",
        limit: 2,
        mirrorToCard: false,
      },
    );
    expect(page1.result).toMatchObject({
      count: 2,
      nextPageToken: "page-2",
      results: [
        expect.objectContaining({
          threadId: "thr-1",
          subject: "Subject thr-1",
        }),
        expect.objectContaining({ threadId: "thr-2" }),
      ],
    });
    expect(listThreads).toHaveBeenCalledWith({ q: "report", maxResults: 2 });

    const page2 = await worker.deliveredMethod(
      "ch-1",
      "call-2",
      "gmail_search",
      {
        q: "report",
        limit: 2,
        pageToken: "page-2",
        mirrorToCard: false,
      },
    );
    expect(page2.result).toMatchObject({
      count: 1,
      results: [expect.objectContaining({ threadId: "thr-3" })],
    });
    expect(
      (page2.result as { nextPageToken?: string }).nextPageToken,
    ).toBeUndefined();
  });

  it("appends the default send-as signature at draft time and offers a From picker", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    const client = worker["gmailForChannel"]("ch-1") as unknown as {
      listSendAs: ReturnType<typeof vi.fn>;
    };
    client.listSendAs = vi.fn(async () => [
      {
        sendAsEmail: "me@example.com",
        isPrimary: true,
        isDefault: true,
        signature: "Best,<br><b>Gabriel</b>",
      },
      { sendAsEmail: "support@example.com", displayName: "Support" },
    ]);

    const result = await worker.deliveredMethod(
      "ch-1",
      "call-1",
      "gmail_draft",
      {
        mode: "reply",
        threadId: "thr-1",
        body: "Sounds good, see you then.",
      },
    );
    expect(result.isError).toBeUndefined();
    const compose = worker.published[worker.published.length - 1]?.event
      .payload as {
      initialState: { body: string; fromOptions?: string[] };
    };
    // Signature converted to plain text and appended exactly once, visibly,
    // at draft time (never silently at send time).
    expect(compose.initialState.body).toBe(
      "Sounds good, see you then.\n\nBest,\nGabriel",
    );
    expect(compose.initialState.fromOptions).toEqual([
      "me@example.com",
      "Support <support@example.com>",
    ]);

    // Re-drafting onto the same card does not duplicate the signature.
    const again = await worker.deliveredMethod(
      "ch-1",
      "call-2",
      "gmail_draft",
      {
        mode: "reply",
        threadId: "thr-1",
        body: compose.initialState.body,
        composeCardId: (result.result as { messageId: string }).messageId,
      },
    );
    expect(again.isError).toBeUndefined();
    const updated = worker.published[worker.published.length - 1]?.event
      .payload as {
      update?: { body?: string };
    };
    expect((updated.update?.body ?? "").match(/Best,/g)).toHaveLength(1);
  });

  it("validates an explicit from against the send-as alias list on send", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    const client = worker["gmailForChannel"]("ch-1") as unknown as {
      listSendAs: ReturnType<typeof vi.fn>;
    };
    client.listSendAs = vi.fn(async () => [
      { sendAsEmail: "me@example.com", isPrimary: true, isDefault: true },
      { sendAsEmail: "support@example.com", displayName: "Support" },
    ]);

    const compose = await worker.deliveredMethod(
      "ch-1",
      "compose",
      "compose",
      {},
    );
    const messageId = (compose.result as { messageId: string }).messageId;
    const ok = await worker.deliveredMethod("ch-1", "call-1", "gmail_send", {
      messageId,
      to: "b@example.com",
      from: "support@example.com",
      subject: "Hello",
      body: "Hi",
    });
    expect(ok.result).toEqual({ sent: true, id: "sent-1" });
    expect(worker.sent).toHaveBeenCalledWith(
      expect.objectContaining({ from: "Support <support@example.com>" }),
    );

    const secondCompose = await worker.deliveredMethod(
      "ch-1",
      "compose-2",
      "compose",
      {},
    );
    await expect(
      worker.deliveredMethod("ch-1", "call-2", "gmail_send", {
        messageId: (secondCompose.result as { messageId: string }).messageId,
        to: "b@example.com",
        from: "spoofed@evil.example",
        subject: "Hello",
        body: "Hi",
      }),
    ).rejects.toThrow("not a configured send-as alias");
  });

  it("saves attachments as workspace files with binary-safe decode and sanitized names", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    // PNG-ish bytes that TextDecoder would corrupt.
    const bytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a,
    ]);
    const data = Buffer.from(bytes).toString("base64url");
    const written: Array<{ path: string; data: Uint8Array }> = [];
    worker.writtenFiles = written;
    const client = worker["gmailForChannel"]("ch-1") as unknown as {
      getAttachment: ReturnType<typeof vi.fn>;
    };
    client.getAttachment = vi.fn(async () => ({
      size: bytes.byteLength,
      data,
    }));

    const result = await worker.deliveredMethod(
      "ch-1",
      "call-1",
      "gmail_get_attachment",
      {
        messageId: "msg-1",
        attachmentId: "att-1",
        filename: "../../etc/passwd <invoice>.png",
        mimeType: "image/png",
        threadId: "thr-1",
      },
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toMatchObject({
      saved: true,
      path: "gmail-attachments/thr-1/passwd _invoice_.png",
      size: bytes.byteLength,
      mimeType: "image/png",
    });
    expect(written).toHaveLength(1);
    expect([...written[0]!.data]).toEqual([...bytes]); // byte-exact round trip
  });

  it("looks up attachment metadata from the message when the caller omits it and enforces the size cap", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    const written: Array<{ path: string; data: Uint8Array }> = [];
    worker.writtenFiles = written;
    const client = worker["gmailForChannel"]("ch-1") as unknown as {
      getAttachment: ReturnType<typeof vi.fn>;
      getMessage: ReturnType<typeof vi.fn>;
    };
    client.getMessage = vi.fn(async () => ({
      id: "msg-1",
      threadId: "thr-9",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          {
            filename: "report.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: "att-9", size: 5 },
          },
        ],
      },
    }));
    client.getAttachment = vi.fn(async () => ({
      size: 5,
      data: Buffer.from("hello").toString("base64url"),
    }));

    const result = await worker.deliveredMethod(
      "ch-1",
      "call-1",
      "gmail_get_attachment",
      {
        messageId: "msg-1",
        attachmentId: "att-9",
      },
    );
    expect(result.result).toMatchObject({
      saved: true,
      path: "gmail-attachments/thr-9/report.pdf",
      mimeType: "application/pdf",
    });

    // Oversized attachments are refused before decoding.
    client.getAttachment = vi.fn(async () => ({
      size: 50 * 1024 * 1024,
      data: "",
    }));
    await expect(
      worker.deliveredMethod("ch-1", "call-2", "gmail_get_attachment", {
        messageId: "msg-1",
        attachmentId: "att-9",
        filename: "huge.bin",
        threadId: "thr-9",
      }),
    ).rejects.toThrow("exceeds");
    expect(written).toHaveLength(1);
  });

  it("starts a push watch, registers with the Gmail push router, and renews near expiry", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    worker.updateSubscriptionConfig("ch-1", {
      handle: "gmail",
      googlePubSubTopicName: "projects/p/topics/gmail-push",
    });
    const registered: unknown[] = [];
    worker.rpcCall.mockImplementation(
      async (target: string, method: string, args?: unknown[]) => {
        if (
          target ===
            "do:workers/gmail-agent:GmailAgentWorker:gmail-push-router" &&
          method === "registerPushTarget"
        ) {
          registered.push(args?.[0]);
          return { registered: true };
        }
        return { id: "cred-1" };
      },
    );
    const watch = vi.fn(async () => ({
      historyId: "h5",
      expiration: Date.now() + 7 * 86_400_000,
    }));
    const client = worker["gmailForChannel"]("ch-1") as unknown as {
      watch: typeof watch;
    };
    client.watch = watch;

    // First sync resolves the mailbox address; then the watch can start.
    await worker.deliveredMethod("ch-1", "call-1", "checkNow", {});
    await (
      worker as unknown as { ensureWatch(channelId: string): Promise<void> }
    ).ensureWatch("ch-1");

    expect(watch).toHaveBeenCalledWith({
      topicName: "projects/p/topics/gmail-push",
    });
    expect(worker.channelStateRow("ch-1")).toMatchObject({
      watch_expiration: expect.any(Number),
    });
    expect(registered).toEqual([
      {
        emailAddress: "me@example.com",
        source: "workers/gmail-agent",
        className: "GmailAgentWorker",
        objectKey: expect.any(String),
      },
    ]);

    // A live watch re-registers (heals server restarts) without re-watching.
    await (
      worker as unknown as { ensureWatch(channelId: string): Promise<void> }
    ).ensureWatch("ch-1");
    expect(watch).toHaveBeenCalledTimes(1);
    expect(registered).toHaveLength(2);
  });

  it("syncs the matching channel when the Gmail push router dispatches a notification", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    await worker.deliveredMethod("ch-1", "call-1", "checkNow", {});
    worker.sync.mockClear();

    (
      worker as unknown as {
        _currentVerifiedCaller: { callerId: string; callerKind: string } | null;
      }
    )._currentVerifiedCaller = {
      callerId: "do:workers/gmail-agent:GmailAgentWorker:gmail-push-router",
      callerKind: "do",
    };

    const result = await worker.onGmailPushNotification({
      emailAddress: "ME@example.com",
      historyId: "h9",
    });
    expect(result).toEqual({ synced: ["ch-1"] });
    expect(worker.sync).toHaveBeenCalledTimes(1);

    // Unknown mailboxes are a no-op.
    await expect(
      worker.onGmailPushNotification({
        emailAddress: "other@example.com",
        historyId: "h9",
      }),
    ).resolves.toEqual({ synced: [] });

    // Only the Gmail push router may dispatch pushes.
    (
      worker as unknown as {
        _currentVerifiedCaller: { callerId: string; callerKind: string } | null;
      }
    )._currentVerifiedCaller = { callerId: "panel:other", callerKind: "panel" };
    await expect(
      worker.onGmailPushNotification({
        emailAddress: "me@example.com",
        historyId: "h9",
      }),
    ).rejects.toThrow("Gmail push router");
    (
      worker as unknown as {
        _currentVerifiedCaller: { callerId: string; callerKind: string } | null;
      }
    )._currentVerifiedCaller = {
      callerId: "do:workers/gmail-agent:GmailAgentWorker:gmail-push-router",
      callerKind: "do",
    };
  });

  it("routes generic Cloud Pub/Sub webhook deliveries to registered Gmail workers", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const router = instance as TestGmailAgentWorker;
    router.registerPushTarget({
      emailAddress: "me@example.com",
      source: "workers/gmail-agent",
      className: "GmailAgentWorker",
      objectKey: "gmail-ch-1",
    });
    router.rpcCall.mockImplementation(
      async (target: string, method: string, args?: unknown[]) => {
        if (
          target === "do:workers/gmail-agent:GmailAgentWorker:gmail-ch-1" &&
          method === "onGmailPushNotification"
        ) {
          expect(args?.[0]).toEqual({
            emailAddress: "me@example.com",
            historyId: "h9",
          });
          return { synced: ["ch-1"] };
        }
        return { id: "cred-1" };
      },
    );

    const event: WebhookDeliveryEvent = {
      subscriptionId: "sub-1",
      publicUrl: "https://server/_r/s/webhookIngress/sub-1",
      receivedAt: Date.now(),
      delivery: { mode: "direct" },
      headers: {},
      rawBodyBase64: "",
      payload: {
        type: "cloud-pubsub",
        messageId: "m-1",
        dataJson: { emailAddress: "ME@example.com", historyId: "h9" },
      },
    };
    await expect(router.onWebhookDelivery(event)).resolves.toEqual({
      synced: ["ch-1"],
    });
  });

  it("snoozes a thread (archive + reminder) and wakes a digest when it is due", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    const base = 1_750_000_000_000;
    worker.clock = base;
    await worker.deliveredMethod("ch-1", "call-1", "checkNow", {});
    await worker.deliveredMethod("ch-1", "call-2", "checkNow", {});

    const result = await worker.deliveredMethod(
      "ch-1",
      "call-3",
      "gmail_snooze",
      {
        threadId: "thr-1",
        inMs: 60 * 60 * 1000,
        note: "decide on the Q3 numbers",
      },
    );
    expect(result.isError).toBeUndefined();
    expect(result.result).toMatchObject({ snoozed: true, archived: true });
    // Archived in Gmail immediately…
    expect(worker.modifyLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        removeLabelIds: expect.arrayContaining(["INBOX"]),
      }),
    );
    expect(worker.rows(`SELECT * FROM gmail_reminders`)).toHaveLength(1);

    // …not due yet: nothing wakes.
    worker.clock = base + 30 * 60 * 1000;
    await worker.alarm();
    expect(worker.agentInitiatedTurns).toEqual([]);

    // Due: the reminder rides the wake/digest pipeline.
    worker.clock = base + 61 * 60 * 1000;
    await worker.alarm();
    expect(worker.rows(`SELECT * FROM gmail_reminders`)).toEqual([]);
    worker.clock = base + 61 * 60 * 1000 + 91_000;
    await worker.drainWake(worker.clock);
    expect(worker.agentInitiatedTurns).toHaveLength(1);
    expect(worker.agentInitiatedTurns[0]?.content).toContain(
      "Reminder: decide on the Q3 numbers",
    );

    // listReminders reflects cancellation too.
    await worker.deliveredMethod("ch-1", "call-4", "gmail_snooze", {
      threadId: "thr-1",
      inMs: 3_600_000,
    });
    await expect(
      worker.deliveredMethod("ch-1", "call-5", "cancelReminder", {
        threadId: "thr-1",
      }),
    ).resolves.toMatchObject({ result: { cancelled: true } });
    const list = await worker.deliveredMethod(
      "ch-1",
      "call-6",
      "gmail_list_reminders",
      {},
    );
    expect(list.result).toEqual({ reminders: [] });
  });

  it("publishes digest cards from gmail_publish_digest", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    const result = await worker.deliveredMethod(
      "ch-1",
      "call-1",
      "gmail_publish_digest",
      {
        headline: "3 new — 1 needs a reply",
        items: [
          {
            threadId: "thr-1",
            from: "a@example.com",
            subject: "Question",
            gist: "Asks about the Q3 numbers",
            suggested: "reply",
            unread: true,
          },
        ],
        moreCount: 2,
      },
    );

    expect(result.isError).toBeUndefined();
    expect(
      worker.published[worker.published.length - 1]?.event.payload,
    ).toMatchObject({
      typeId: "gmail.digest",
      initialState: {
        headline: "3 new — 1 needs a reply",
        items: [
          expect.objectContaining({ threadId: "thr-1", suggested: "reply" }),
        ],
        moreCount: 2,
      },
    });
  });

  it("limits actionable threads to unread primary messages addressed to the user", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    await worker.deliveredMethod("ch-1", "call-1", "checkNow", {});
    await worker.deliveredMethod("ch-1", "call-2", "checkNow", {});
    await expect(
      worker.deliveredMethod("ch-1", "call-3", "listActionableThreads", {}),
    ).resolves.toMatchObject({
      result: [
        expect.objectContaining({ threadId: "thr-1", actionable: true }),
      ],
    });

    worker.fakeThread = {
      id: "thr-1",
      messages: [
        message(
          "msg-2",
          "thr-1",
          {
            Subject: "Promo",
            From: "a@example.com",
            To: "me@example.com",
            Date: "Fri, 22 May 2026 10:05:00 +0000",
          },
          "Sale",
          "Sale",
          ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
        ),
      ],
    };
    await worker.deliveredMethod("ch-1", "call-4", "checkNow", {});
    await expect(
      worker.deliveredMethod("ch-1", "call-5", "listActionableThreads", {}),
    ).resolves.toMatchObject({
      result: [],
    });

    worker.fakeThread = {
      id: "thr-1",
      messages: [
        message(
          "msg-3",
          "thr-1",
          {
            Subject: "Sent by me",
            From: "me@example.com",
            To: "a@example.com",
            Date: "Fri, 22 May 2026 10:10:00 +0000",
          },
          "I replied",
          "I replied",
        ),
      ],
    };
    await worker.deliveredMethod("ch-1", "call-6", "checkNow", {});
    await expect(
      worker.deliveredMethod("ch-1", "call-7", "listActionableThreads", {}),
    ).resolves.toMatchObject({
      result: [],
    });
  });

  it("harvests synced senders into the people store and resolves them from history", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    worker.fakeThread = {
      id: "thr-1",
      messages: [
        message("msg-1", "thr-1", {
          Subject: "Hi",
          From: "Alice Smith <alice@example.com>",
          To: "me@example.com",
          Date: "Fri, 22 May 2026 10:00:00 +0000",
        }),
      ],
    };

    await worker.deliveredMethod("ch-1", "call-1", "checkNow", {});
    await worker.deliveredMethod("ch-1", "call-2", "checkNow", {});

    const resolved = await worker.deliveredMethod(
      "ch-1",
      "call-3",
      "resolveContact",
      {
        name: "alice",
      },
    );
    expect(resolved.result).toMatchObject({
      query: "alice",
      candidates: [
        expect.objectContaining({
          email: "alice@example.com",
          displayName: "Alice Smith",
          source: "history",
        }),
      ],
    });
    expect(worker.searchContacts).not.toHaveBeenCalled();

    const suggested = await worker.deliveredMethod(
      "ch-1",
      "call-4",
      "contactSuggest",
      {
        prefix: "ali",
      },
    );
    expect(suggested.result).toMatchObject({
      candidates: [expect.objectContaining({ email: "alice@example.com" })],
    });

    // The unified gmail_contacts tool reaches the same store.
    const viaTool = await worker.deliveredMethod(
      "ch-1",
      "call-5",
      "gmail_contacts",
      {
        query: "alice",
      },
    );
    expect(viaTool.result).toMatchObject({
      candidates: [expect.objectContaining({ email: "alice@example.com" })],
    });
  });

  it("falls back to the Google People API when history has no candidates", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    const result = await worker.deliveredMethod(
      "ch-1",
      "call-1",
      "resolveContact",
      {
        name: "zelda",
      },
    );
    expect(worker.searchContacts).toHaveBeenCalledWith("zelda", {
      pageSize: 5,
    });
    expect(result.result).toMatchObject({
      candidates: [
        {
          email: "zelda@hyrule.example",
          displayName: "Zelda Hyrule",
          source: "google-contacts",
          sentTo: 0,
          receivedFrom: 0,
          youReplied: false,
          score: 0,
        },
      ],
    });
    expect(worker.channelStateRow("ch-1")).toMatchObject({
      people_api_status: "ok",
    });
  });

  it("degrades gracefully when the People API is forbidden (missing scopes)", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    worker.searchContacts.mockRejectedValue(
      new GmailApiError("missing scope", "forbidden", { status: 403 }),
    );

    const result = await worker.deliveredMethod(
      "ch-1",
      "call-1",
      "resolveContact",
      {
        name: "zelda",
      },
    );
    expect(result.isError).toBeUndefined();
    expect(result.result).toMatchObject({ query: "zelda", candidates: [] });
    expect(worker.channelStateRow("ch-1")).toMatchObject({
      people_api_status: "unavailable",
    });

    // Subsequent resolves skip the API entirely.
    await worker.deliveredMethod("ch-1", "call-2", "resolveContact", {
      name: "zelda",
    });
    expect(worker.searchContacts).toHaveBeenCalledTimes(1);

    const setup = [...worker.published]
      .reverse()
      .find((entry) =>
        JSON.stringify(entry.event.payload ?? {}).includes("addressBook"),
      );
    expect(JSON.stringify(setup?.event.payload)).toContain(
      '"googleContacts":"unavailable"',
    );
  });

  it("saves an incomplete owned compose and then updates the same Gmail draft", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    const compose = await worker.deliveredMethod("ch-1", "compose", "compose", {
      subject: "Quarterly numbers",
      body: "Draft body",
    });
    const messageId = (compose.result as { messageId: string }).messageId;
    const result = await worker.deliveredMethod("ch-1", "save", "saveDraft", {
      messageId,
    });
    expect(result.result).toMatchObject({ saved: true, draftId: "draft-1" });
    expect(worker.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ to: "", subject: "Quarterly numbers" }),
    );
    const saved = await worker.deliveredMethod("ch-1", "save-2", "saveDraft", {
      messageId,
      to: "alice@example.com",
    });
    expect(saved.result).toMatchObject({ saved: true, draftId: "draft-1" });
    expect(worker.createDraft).toHaveBeenCalledTimes(1);
  });

  it("includes parsed fromEmail alongside the display from in query results", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    worker.fakeThread = {
      id: "thr-1",
      messages: [
        message("msg-1", "thr-1", {
          Subject: "Hello",
          From: "Alice Smith <alice@example.com>",
          To: "me@example.com",
          Date: "Fri, 22 May 2026 10:00:00 +0000",
        }),
      ],
    };
    await worker.deliveredMethod("ch-1", "call-1", "checkNow", {});
    await worker.deliveredMethod("ch-1", "call-2", "checkNow", {});

    const result = await worker.deliveredMethod(
      "ch-1",
      "call-3",
      "gmail_query",
      {
        q: "Hello",
      },
    );
    expect(result.result).toMatchObject({
      source: "cache",
      results: [
        expect.objectContaining({
          from: "Alice Smith <alice@example.com>",
          fromEmail: "alice@example.com",
        }),
      ],
    });
  });

  it("recovers actionable thread state from durable custom messages on first use", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    worker.replayEvents = [
      {
        id: 1,
        messageId: "custom-start",
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        senderId: "agent-gmail",
        payload: {
          kind: "custom.started",
          actor: { kind: "agent", id: "agent-gmail" },
          payload: {
            protocol: "agentic.trajectory.v1",
            typeId: "gmail.thread",
            messageId: "thread-card-1",
            initialState: {
              threadId: "thr-recovered",
              subject: "Recovered",
              participants: ["a@example.com"],
              lastSnippet: "Needs reply",
              unreadCount: 1,
              hasDraft: false,
              status: "unread",
            },
          },
          createdAt: new Date().toISOString(),
        },
        ts: Date.now(),
      },
    ];

    const result = await worker.deliveredMethod(
      "ch-1",
      "call-1",
      "listActionableThreads",
      {
        limit: 3,
      },
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toEqual([
      expect.objectContaining({
        threadId: "thr-recovered",
        subject: "Recovered",
        lastSnippet: "Needs reply",
        unreadCount: 1,
        status: "unread",
      }),
    ]);
  });
});
