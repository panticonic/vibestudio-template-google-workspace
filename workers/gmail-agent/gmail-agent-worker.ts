import {
  AgentWorkerBase,
  installMessageTypes,
  CardManager,
  type RespondPolicy,
} from "@workspace/agentic-do";
import { Type, type Api, type Model } from "@panticonic/pi-ai";
import { defineExtension, type ToolRegistration } from "@panticonic/pi-durable";
import { copyJson, type Context, type JsonValue } from "@panticonic/pi-chord";
import { BACKGROUND_CONTEXT } from "@panticonic/pi-chord/context";
import { withRpcAbortSignal, type RpcClient } from "@vibestudio/rpc";
import { createCredentialClient } from "@workspace/runtime/credentials";
import { createRpcFs } from "@workspace/runtime/worker/rpc-fs";
import { rpc } from "@workspace/runtime/worker/kernel";
import type {
  DurableObjectContext,
  WebhookDeliveryEvent,
} from "@workspace/runtime/worker";
import { type ActorRef } from "@workspace/agentic-protocol";
import {
  createGmailClient,
  GmailApiError,
  type GmailClient,
  type GmailThread,
} from "@workspace/gmail";
import type {
  GmailAttentionPrefs,
  GmailSetupState,
  GmailComposeCardState,
} from "@workspace/gmail/card-types";
import {
  reduce as reduceGmailThread,
  type GmailThreadState,
} from "@workspace/gmail/renderers/gmail-thread.reducer";
import type { ParticipantDescriptor } from "@workspace/harness";
import { z } from "zod";
import type { DoAlarmSchedule } from "@vibestudio/shared/doDispatcher";

import { DEFAULT_ATTENTION_PREFERENCES, createGmailTables } from "./schema.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  booleanArg,
  record,
  stringArg,
  type GmailChannelState,
} from "./types.js";
import { TriageStore } from "./triage/triage-store.js";
import { TriageEngine } from "./triage/triage-engine.js";
import { PeopleStore } from "./people/people-store.js";
import { WakeQueue, buildWakeDigestPrompt } from "./triage/wake.js";
import { SyncEngine } from "./sync/sync-engine.js";
import { createGmailSchedule } from "./schedule.js";
import {
  GMAIL_MESSAGE_TYPES,
  GMAIL_RETIRED_MESSAGE_TYPES,
  GmailCards,
  SETUP_CARD_KEY,
  threadCardKey,
} from "./cards/cards.js";
import { GmailHandlers } from "./agent/handlers.js";
import { LabelResolver, type LabelCacheEntry } from "./agent/label-resolver.js";
import { SendAsCache, type SendAsCacheEntry } from "./agent/sendas-cache.js";
import { GmailParticipantApi } from "./participant-api.js";
import {
  advertisedMethods,
  buildOperationIndex,
  toolOperations,
  type GmailOperation,
  type GmailOperationContext,
} from "./agent/operations.js";
import {
  GMAIL_SETUP_ONBOARDING_PROMPT,
  GMAIL_SYSTEM_PROMPT,
} from "./agent/prompts.js";
import {
  generateDraftReplyBody as generateDraftReplyBodyLlm,
  modelReplyText,
} from "./agent/draft-writer.js";

const GMAIL_ACTION_BAR_FILE = "packages/gmail/src/action-bar.tsx";
const GMAIL_ACTION_BAR_MAX_HEIGHT = 64;
const GMAIL_UI_INSTALL_VERSION = 5;
const GMAIL_UI_IMPORTS = {
  react: "latest",
  "react/jsx-runtime": "latest",
  "@radix-ui/themes": "npm:^3.2.1",
  "@radix-ui/react-icons": "npm:^1.3.2",
} satisfies Record<string, string>;
const GMAIL_UNIVERSAL_TOOL_NAMES = new Set(["suspend_turn", "ask_user"]);

/** Preferred cheap triage tier per provider; falls back to the channel model. */
const TRIAGE_MODEL_BY_PROVIDER: Record<string, string> = {
  "openai-codex": "gpt-6-luna",
  anthropic: "claude-haiku-4-5",
};

export function triageModelCandidates(
  channelModelRef: string,
  override?: string,
): string[] {
  const colonIdx = channelModelRef.indexOf(":");
  const provider =
    colonIdx > 0 ? channelModelRef.slice(0, colonIdx) : channelModelRef;
  return [
    ...(override ? [override] : []),
    ...(TRIAGE_MODEL_BY_PROVIDER[provider]
      ? [`${provider}:${TRIAGE_MODEL_BY_PROVIDER[provider]}`]
      : []),
    channelModelRef,
  ];
}

/** Renew users.watch when less than this remains (registrations last ~7d). */
const WATCH_RENEW_MARGIN_MS = 24 * 60 * 60 * 1000;
/** With push active, polling is only a safety net — stretch the interval. */
const WATCH_FALLBACK_POLL_MS = 30 * 60 * 1000;
const GMAIL_DO_SOURCE = "workers/gmail-agent";
const GMAIL_DO_CLASS = "GmailAgentWorker";
const GMAIL_PUSH_ROUTER_KEY = "gmail-push-router";
const GMAIL_AGENT_SCHEMA_BASELINE = 1;

interface GmailPushTarget {
  source: string;
  className: string;
  objectKey: string;
}

const gmailKnowledgeConfigurationSchema = z
  .object({
    kind: z.literal("gmail.configuration"),
    version: z.literal(1),
    credentialId: z.string().min(1).nullable(),
    attention: z
      .object({
        preferencesText: z.string().max(4000),
        knownSenderShortcut: z.boolean(),
        triageModel: z.string().nullable(),
      })
      .strict()
      .nullable(),
    setupStatus: z.enum(["needs-user-preferences", "configured"]),
    setupSummary: z.string().nullable(),
    pollIntervalMs: z.number().positive().finite(),
  })
  .strict();

export class GmailAgentWorker extends AgentWorkerBase {
  static override schemaVersion = GMAIL_AGENT_SCHEMA_BASELINE;

  private readonly composeOperations = new Map<string, Promise<unknown>>();
  private readonly labelCache = new Map<string, LabelCacheEntry>();
  private readonly sendAsCache = new Map<string, SendAsCacheEntry>();
  private gmailClients = new Map<string, GmailClient>();
  private recoveredChannels = new Set<string>();
  private readonly operationIndex: Map<string, GmailOperation>;

  private readonly store: TriageStore;
  private readonly triage: TriageEngine;
  private readonly people: PeopleStore;
  private readonly wake: WakeQueue;
  private readonly gmailCards: GmailCards;
  private readonly syncEngine: SyncEngine;
  private readonly handlers: GmailHandlers;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    void this.setOwnTitle("Gmail");
    // One clock for everything time-based (wake debounce, triage rate caps,
    // alarm scheduling) so tests can inject a coherent fake time via now().
    const now = () => this.now();
    this.store = new TriageStore({ sql: this.sql, now });
    this.people = new PeopleStore({ sql: this.sql });
    this.wake = new WakeQueue({ sql: this.sql, now });
    const domain = this.composeGmailDomain({
      cards: this.cards,
      gmailFor: (channelId) => this.gmailForChannel(channelId),
      cacheKey: (channelId) =>
        JSON.stringify([
          channelId,
          this.getGmailCredentialId(channelId) ?? null,
        ]),
      generateDraftReplyBody: (channelId, thread) =>
        this.generateDraftReplyBody(channelId, thread),
      runTriageModel: (channelId, systemPrompt, userPrompt) =>
        this.runTriageModel(channelId, systemPrompt, userPrompt),
      writeFile: (path, data) => this.writeWorkspaceFile(path, data),
    });
    this.gmailCards = domain.cards;
    this.triage = domain.triage;
    this.syncEngine = domain.sync;
    this.handlers = domain.context.handlers;
    this.operationIndex = buildOperationIndex();
  }

  /** One operation graph; capabilities are explicit, shared domain state stays owned here. */
  private composeGmailDomain(ports: {
    cards: CardManager;
    gmailFor: (channelId: string) => GmailClient;
    cacheKey: (channelId: string) => string;
    generateDraftReplyBody: (
      channelId: string,
      thread: GmailThread,
    ) => Promise<string>;
    runTriageModel: (
      channelId: string,
      systemPrompt: string,
      userPrompt: string,
    ) => Promise<string>;
    writeFile: (path: string, data: Uint8Array) => Promise<void>;
    rpc?: RpcClient;
    shareAccountCaches?: boolean;
  }) {
    const now = () => this.now();
    const cards = new GmailCards({
      cards: ports.cards,
      sql: this.sql,
      composeOperations: this.composeOperations,
    });
    const labels = new LabelResolver({
      gmailFor: ports.gmailFor,
      now,
      cache: ports.shareAccountCaches === false ? undefined : this.labelCache,
      cacheKey: ports.cacheKey,
    });
    const sendAs = new SendAsCache({
      gmailFor: ports.gmailFor,
      now,
      cache: ports.shareAccountCaches === false ? undefined : this.sendAsCache,
      cacheKey: ports.cacheKey,
    });
    let sync: SyncEngine;
    const triage = new TriageEngine({
      store: this.store,
      wake: this.wake,
      runTriageModel: ports.runTriageModel,
      isConfigured: (channelId) =>
        this.getChannelState(channelId).setupStatus === "configured",
      applyDecision: (channelId, threadId, decision) =>
        sync.applyTriageDecision(channelId, threadId, decision),
      now,
    });
    const publishSetup = (channelId: string) =>
      this.publishSetupCard(channelId, cards, ports.cards, ports.rpc);
    sync = new SyncEngine({
      sql: this.sql,
      gmailFor: ports.gmailFor,
      triage,
      store: this.store,
      people: this.people,
      cards,
      getChannelState: (channelId) => this.getChannelState(channelId),
      saveChannelState: (state) => this.saveChannelState(state),
      publishSetup,
      now,
    });
    const handlers = new GmailHandlers({
      sql: this.sql,
      gmailFor: ports.gmailFor,
      sync,
      store: this.store,
      triage,
      labels,
      sendAs,
      people: this.people,
      cards,
      getChannelState: (channelId) => this.getChannelState(channelId),
      saveChannelState: (state) => this.saveChannelState(state),
      publishSetup,
      generateDraftReplyBody: ports.generateDraftReplyBody,
      isSubscribed: (channelId) =>
        Boolean(this.subscriptions.getParticipantId(channelId)),
      writeFile: ports.writeFile,
      now,
    });
    const participantApi = new GmailParticipantApi({
      sql: this.sql,
      handlers,
      sync,
      getChannelState: (channelId) => this.getChannelState(channelId),
    });
    return {
      cards,
      labels,
      sendAs,
      triage,
      sync,
      context: {
        handlers,
        participantApi,
        queuedWakeCount: (channelId: string) =>
          this.wake.queuedCount(channelId),
      } satisfies GmailOperationContext,
    };
  }

  /** Injectable clock shared by triage/wake/sync state and alarm scheduling. */
  protected now(): number {
    return Date.now();
  }

  /** Workspace file write (overridable in tests — this.fs is getter-only). */
  protected writeWorkspaceFile(path: string, data: Uint8Array): Promise<void> {
    return this.fs.writeFile(path, data);
  }

  protected override async createAgentTables(): Promise<void> {
    await super.createAgentTables();
    createGmailTables(this.sql);
  }

  // ── Gmail client & channel state ──────────────────────────────────────────

  protected gmailForChannel(channelId: string): GmailClient {
    const credentialId = this.getGmailCredentialId(channelId);
    const key = credentialId ?? "__default__";
    let client = this.gmailClients.get(key);
    if (!client) {
      client = this.createGmailClient(credentialId);
      this.gmailClients.set(key, client);
    }
    return client;
  }

  protected createGmailClient(credentialId?: string): GmailClient {
    return createGmailClient(
      this.credentials,
      credentialId ? { credentialId } : {},
    );
  }

  protected createBoundGmailClient(
    toolRpc: RpcClient,
    credentialId?: string,
    context: Context = BACKGROUND_CONTEXT,
  ): GmailClient {
    return createGmailClient(createCredentialClient(toolRpc), {
      ...(credentialId ? { credentialId } : {}),
      signal: context.abortSignal,
    });
  }

  private getGmailCredentialId(channelId: string): string | undefined {
    const state = this.getChannelState(channelId);
    if (state.credentialId) return state.credentialId;
    const config = record(this.subscriptions.getConfig(channelId));
    return (
      stringArg(config, "googleCredentialId") ??
      stringArg(config, "credentialId") ??
      undefined
    );
  }

  private getPushTopicName(channelId: string): string | undefined {
    const config = record(this.subscriptions.getConfig(channelId));
    return (
      stringArg(config, "googlePubSubTopicName") ??
      stringArg(config, "gmailPushTopicName") ??
      stringArg(config, "pushTopicName") ??
      undefined
    );
  }

  private ensureChannelState(channelId: string): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO gmail_channel_state (channel_id, poll_interval_ms) VALUES (?, ?)`,
      channelId,
      DEFAULT_POLL_INTERVAL_MS,
    );
  }

  private getChannelState(channelId: string): GmailChannelState {
    this.ensureChannelState(channelId);
    const row = this.sql
      .exec(`SELECT * FROM gmail_channel_state WHERE channel_id = ?`, channelId)
      .toArray()[0]!;
    return {
      channelId,
      historyId: (row["history_id"] as string | null) ?? undefined,
      emailAddress: (row["email_address"] as string | null) ?? undefined,
      credentialId: (row["credential_id"] as string | null) ?? undefined,
      pollIntervalMs:
        Number(row["poll_interval_ms"]) || DEFAULT_POLL_INTERVAL_MS,
      lastSyncAt: (row["last_sync_at"] as number | null) ?? undefined,
      lastError: (row["last_error"] as string | null) ?? undefined,
      setupStatus:
        row["setup_status"] === "configured"
          ? "configured"
          : "needs-user-preferences",
      setupPromptedAt: (row["setup_prompted_at"] as number | null) ?? undefined,
      configuredAt: (row["configured_at"] as number | null) ?? undefined,
      setupSummary: (row["setup_summary"] as string | null) ?? undefined,
      syncState: row["sync_state"] === "auth-needed" ? "auth-needed" : "ok",
      rateLimitedUntil:
        (row["rate_limited_until"] as number | null) ?? undefined,
      backoffMs: (row["backoff_ms"] as number | null) ?? undefined,
      lastSetupJson: (row["last_setup_json"] as string | null) ?? undefined,
      peopleApiStatus:
        row["people_api_status"] === "ok"
          ? "ok"
          : row["people_api_status"] === "unavailable"
            ? "unavailable"
            : undefined,
      watchExpiration: (row["watch_expiration"] as number | null) ?? undefined,
    };
  }

  private saveChannelState(state: GmailChannelState): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_channel_state
       (channel_id, history_id, email_address, credential_id, poll_interval_ms, last_sync_at, last_error, setup_status, setup_prompted_at, configured_at, setup_summary, sync_state, rate_limited_until, backoff_ms, last_setup_json, people_api_status, watch_expiration)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      state.channelId,
      state.historyId ?? null,
      state.emailAddress ?? null,
      state.credentialId ?? null,
      state.pollIntervalMs,
      state.lastSyncAt ?? null,
      state.lastError ?? null,
      state.setupStatus,
      state.setupPromptedAt ?? null,
      state.configuredAt ?? null,
      state.setupSummary ?? null,
      state.syncState,
      state.rateLimitedUntil ?? null,
      state.backoffMs ?? null,
      state.lastSetupJson ?? null,
      state.peopleApiStatus ?? null,
      state.watchExpiration ?? null,
    );
  }

  // ── agent configuration ───────────────────────────────────────────────────

  protected override getDefaultModel(): string {
    return "openai-codex:gpt-6-sol";
  }

  protected override getRespondPolicy(): RespondPolicy {
    return "mentioned-or-followup";
  }

  protected override getAgentPrompt(_channelId: string): string {
    return GMAIL_SYSTEM_PROMPT;
  }

  protected async generateDraftReplyBody(
    channelId: string,
    thread: GmailThread,
    context: Context = BACKGROUND_CONTEXT,
    toolRpc: RpcClient = this.rpc,
    selected: string = this.getAgentSettings().model,
  ): Promise<string> {
    const colon = selected.indexOf(":");
    if (colon < 1)
      throw new Error(`Model must be "provider:model", got: ${selected}`);
    const model = await this.selectedNativeModelDescriptor(
      selected.slice(0, colon),
      selected.slice(colon + 1),
    );
    if (!model)
      throw new Error(`No model metadata found for model: ${selected}`);
    return generateDraftReplyBodyLlm({
      thread,
      generate: (transcript) =>
        this.withNativeModelConnection(
          channelId,
          model,
          (prepared, connection) =>
            this.nativeModels().complete(prepared, transcript, {
              ...connection.options,
              temperature: 0.2,
              maxTokens: 300,
            }),
          context,
          toolRpc,
        ),
    });
  }

  /**
   * One cheap-model call for the batched triage pass. Prefers the provider's
   * cheap tier (same provider as the channel model — the API key resolution
   * is base-URL-bound) and falls back to the channel model.
   */
  protected async runTriageModel(
    channelId: string,
    systemPrompt: string,
    userPrompt: string,
    context: Context = BACKGROUND_CONTEXT,
    toolRpc: RpcClient = this.rpc,
    channelModelRef: string = this.getAgentSettings().model,
    override: string | null = this.store.getPrefs(channelId).triageModel ??
      null,
  ): Promise<string> {
    const candidates = triageModelCandidates(
      channelModelRef,
      override ?? undefined,
    );
    let model: Model<Api> | undefined;
    for (const candidate of candidates) {
      const idx = candidate.indexOf(":");
      if (idx <= 0) continue;
      model = await this.selectedNativeModelDescriptor(
        candidate.slice(0, idx),
        candidate.slice(idx + 1),
      );
      if (model) break;
    }
    if (!model)
      throw new Error(`No triage model metadata for: ${candidates.join(", ")}`);
    const response = await this.withNativeModelConnection(
      channelId,
      model,
      (prepared, connection) =>
        this.nativeModels().complete(
          prepared,
          {
            systemPrompt,
            messages: [
              { role: "user", timestamp: Date.now(), content: userPrompt },
            ],
          },
          { ...connection.options, temperature: 0, maxTokens: 800 },
        ),
      context,
      toolRpc,
    );
    return modelReplyText(response);
  }

  private boundCardManager(rpc: RpcClient): CardManager {
    return new CardManager({
      sql: this.sql,
      createChannelClient: (id) => this.createChannelClient(id, rpc),
      getParticipantId: (id) => this.subscriptions.getParticipantId(id),
      getActor: () => ({ kind: "agent", id: this.participantId() }),
      getAgentId: () => this.objectKey,
    });
  }

  protected override async getTools(
    channelId: string,
  ): Promise<ToolRegistration[]> {
    const universalTools = (await super.getTools(channelId)).filter((tool) =>
      GMAIL_UNIVERSAL_TOOL_NAMES.has(tool.name),
    );
    const credentialId = this.getGmailCredentialId(channelId) ?? null;
    const executionData = {
      channelId,
      credentialId,
      modelRef: this.getAgentSettings().model,
      triageModel: this.store.getPrefs(channelId).triageModel ?? null,
    };
    const gmailTools: ToolRegistration[] = toolOperations().map((op) => ({
      name: op.name,
      version: 1,
      description: op.description,
      parameters: Type.Unsafe<Record<string, unknown>>(op.schema),
      executionData,
      execute: async (args, api, context) => {
        const offer = record(api.executionData);
        if (
          offer["channelId"] !== channelId ||
          !(
            offer["credentialId"] === null ||
            typeof offer["credentialId"] === "string"
          ) ||
          typeof offer["modelRef"] !== "string" ||
          !(
            offer["triageModel"] === null ||
            typeof offer["triageModel"] === "string"
          )
        )
          throw new Error(
            "Gmail tool requires its original native account binding",
          );
        const selectedCredential = offer["credentialId"] as string | null;
        const execution = await this.bindNativeToolExecution(api, context);
        const toolRpc = execution.rpc;
        const cards = this.boundCardManager(toolRpc);
        const gmail = this.createBoundGmailClient(
          toolRpc,
          selectedCredential ?? undefined,
          context,
        );
        const fs = createRpcFs(toolRpc as never);
        const domain = this.composeGmailDomain({
          cards,
          gmailFor: () => gmail,
          cacheKey: (id) => JSON.stringify([id, selectedCredential]),
          shareAccountCaches: selectedCredential !== null,
          generateDraftReplyBody: (id, thread) =>
            this.generateDraftReplyBody(
              id,
              thread,
              context,
              toolRpc,
              offer["modelRef"] as string,
            ),
          runTriageModel: (id, system, prompt) =>
            this.runTriageModel(
              id,
              system,
              prompt,
              context,
              toolRpc,
              offer["modelRef"] as string,
              offer["triageModel"] as string | null,
            ),
          writeFile: (path, data) => fs.writeFile(path, data),
          rpc: toolRpc,
        });
        if (op.needsRecovery)
          await this.ensureRecovered(channelId, domain.cards, toolRpc);
        const details = copyJson(
          await op.run(domain.context, channelId, record(args)),
          { omitUndefinedProperties: true },
        );
        await this.updateGmailSchedule();
        return {
          content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
          details,
        };
      },
    }));
    return [...universalTools, ...gmailTools];
  }

  protected override getParticipantInfo(
    _channelId: string,
    config?: unknown,
  ): ParticipantDescriptor {
    const cfg = record(config);
    return {
      handle: typeof cfg["handle"] === "string" ? cfg["handle"] : "gmail",
      name: typeof cfg["name"] === "string" ? cfg["name"] : "Gmail",
      type: "agent",
      metadata: { provider: "gmail" },
      methods: [...advertisedMethods(), ...this.getStandardAgentMethods()],
    };
  }

  protected override exportNativeChannelKnowledgeConfiguration(
    channelId: string,
  ): JsonValue {
    const state = this.getChannelState(channelId);
    const prefs = this.store.getPrefs(channelId);
    return gmailKnowledgeConfigurationSchema.parse({
      kind: "gmail.configuration",
      version: 1,
      credentialId: this.getGmailCredentialId(channelId) ?? null,
      attention: this.store.hasSavedPrefs(channelId)
        ? {
            preferencesText: prefs.preferencesText,
            knownSenderShortcut: prefs.knownSenderShortcut,
            triageModel: prefs.triageModel ?? null,
          }
        : null,
      setupStatus: state.setupStatus,
      setupSummary: state.setupSummary ?? null,
      pollIntervalMs: state.pollIntervalMs,
    });
  }

  protected override async restoreNativeChannelKnowledgeConfiguration(
    channelId: string,
    configuration: JsonValue,
  ): Promise<void> {
    if (configuration === null) return;
    const original = gmailKnowledgeConfigurationSchema.parse(configuration);
    this.ensureChannelState(channelId);
    if (original.attention) this.store.setPrefs(channelId, original.attention);
    else
      this.sql.exec(
        "DELETE FROM gmail_attention_prefs WHERE channel_id = ?",
        channelId,
      );
    const state = this.getChannelState(channelId);
    state.credentialId = original.credentialId ?? undefined;
    state.setupStatus = original.setupStatus;
    state.setupSummary = original.setupSummary ?? undefined;
    state.pollIntervalMs = original.pollIntervalMs;
    this.saveChannelState(state);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  protected override async prepareNativeChannelProduct(
    channelId: string,
    config: unknown,
    _fork: unknown,
    context: Context,
  ): Promise<void> {
    this.ensureChannelState(channelId);
    const credentialId =
      stringArg(record(config), "googleCredentialId") ??
      stringArg(record(config), "credentialId");
    if (credentialId) {
      const state = this.getChannelState(channelId);
      state.credentialId = credentialId;
      this.saveChannelState(state);
    }
    const rpc = context.abortSignal
      ? withRpcAbortSignal(this.rpc, context.abortSignal)
      : this.rpc;
    const cards = this.boundCardManager(rpc);
    const gmailCards = new GmailCards({
      cards,
      sql: this.sql,
      composeOperations: this.composeOperations,
    });
    await this.installChannelUi(channelId, rpc, cards, context);
    await this.publishSetupCard(channelId, gmailCards, cards, rpc);
    await this.ensureWatch(channelId, rpc);
  }

  protected override async activateNativeChannelProduct(
    channelId: string,
    context: Context,
  ): Promise<void> {
    await this.startSetupTurnIfNeeded(channelId, context);
  }

  private nextGmailAlarmSchedule(now = this.now()): DoAlarmSchedule | null {
    const wakeTimes: number[] = [];
    const reminderAt = this.store.nextReminderAt();
    if (reminderAt !== undefined)
      wakeTimes.push(Math.max(reminderAt, now + 1000));

    for (const channelId of this.store.channelsWithPendingCandidates()) {
      const wakeAt = this.triage.nextWakeAt(channelId, now);
      if (wakeAt !== undefined) wakeTimes.push(wakeAt);
    }
    const attentionChannels = this.sql
      .exec(
        `SELECT DISTINCT channel_id FROM gmail_attention_queue ORDER BY channel_id`,
      )
      .toArray();
    for (const row of attentionChannels) {
      const wakeAt = this.wake.nextWakeAt(String(row["channel_id"]), now);
      if (wakeAt !== undefined) wakeTimes.push(wakeAt);
    }

    const channels = this.sql
      .exec(
        `SELECT poll_interval_ms, sync_state, rate_limited_until, watch_expiration
           FROM gmail_channel_state`,
      )
      .toArray();
    for (const row of channels) {
      if (String(row["sync_state"] ?? "ok") === "auth-needed") continue;
      const rateLimitedUntil = Number(row["rate_limited_until"] ?? 0);
      const watchExpiration = Number(row["watch_expiration"] ?? 0);
      const watchActive = watchExpiration > now + WATCH_RENEW_MARGIN_MS;
      const basePoll =
        Number(row["poll_interval_ms"]) || DEFAULT_POLL_INTERVAL_MS;
      const poll = watchActive
        ? Math.min(
            Math.max(basePoll, WATCH_FALLBACK_POLL_MS),
            Math.max(watchExpiration - WATCH_RENEW_MARGIN_MS - now, 60_000),
          )
        : basePoll;
      wakeTimes.push(
        rateLimitedUntil > now
          ? Math.max(rateLimitedUntil, now + 1000)
          : now + poll,
      );
    }
    return wakeTimes.length === 0 ? null : { wakeAt: Math.min(...wakeTimes) };
  }

  private readonly gmailSchedule = createGmailSchedule({
    nextWake: () => this.nextGmailAlarmSchedule()?.wakeAt ?? null,
    poll: (context) => this.runGmailScheduledWork(context),
  });

  protected override nativeProductExtensions() {
    return [
      ...super.nativeProductExtensions(),
      defineExtension({
        name: "gmail.schedule",
        tasks: [this.gmailSchedule.task],
      }),
    ];
  }

  protected override agentOptions() {
    return { ...super.agentOptions(), now: () => this.now() };
  }

  protected override async nextAlarmAfterRequest(): Promise<undefined> {
    await this.updateGmailSchedule();
    return super.nextAlarmAfterRequest();
  }

  private async updateGmailSchedule(): Promise<void> {
    await this.gmailSchedule.update(
      await this.agentSession(),
      BACKGROUND_CONTEXT,
    );
  }

  override async alarm(): Promise<DoAlarmSchedule | null> {
    await this.updateGmailSchedule();
    return super.alarm();
  }

  private async runGmailScheduledWork(context: Context): Promise<void> {
    const rpc = withRpcAbortSignal(this.rpc, context.abortSignal!);
    const fs = createRpcFs(rpc as never);
    const domain = this.composeGmailDomain({
      cards: this.boundCardManager(rpc),
      gmailFor: (id) =>
        this.createBoundGmailClient(
          rpc,
          this.getGmailCredentialId(id),
          context,
        ),
      cacheKey: (id) =>
        JSON.stringify([id, this.getGmailCredentialId(id) ?? null]),
      generateDraftReplyBody: (id, thread) =>
        this.generateDraftReplyBody(id, thread, context, rpc),
      runTriageModel: (id, system, prompt) =>
        this.runTriageModel(id, system, prompt, context, rpc),
      writeFile: (path, data) => fs.writeFile(path, data),
      rpc,
    });
    const now = this.now();
    const rows = this.sql
      .exec(
        `SELECT channel_id, sync_state, rate_limited_until FROM gmail_channel_state`,
      )
      .toArray();
    for (const row of rows) {
      const channelId = String(row["channel_id"]);
      if (String(row["sync_state"] ?? "ok") === "auth-needed") continue;
      const rateLimitedUntil = Number(row["rate_limited_until"] ?? 0);
      if (rateLimitedUntil > now) continue;
      await this.ensureRecovered(channelId, domain.cards, rpc);
      await domain.sync.syncChannel(channelId).catch((err) => {
        console.error(
          `[GmailAgentWorker] sync failed for channel=${channelId}:`,
          err,
        );
      });
      context.abortSignal?.throwIfAborted();
      await this.ensureWatch(channelId, rpc, context);
    }
    this.processDueReminders(now);
    await this.processTriageQueues(domain.triage);
    await this.processWakeQueues(now);
    context.abortSignal?.throwIfAborted();
  }

  // ── push notifications (users.watch → Cloud Pub/Sub → webhook ingress) ───

  /**
   * Start or renew the Gmail push watch for a channel and (re-)register this
   * DO with the Gmail-owned push router. No-ops when the channel has no
   * Google Pub/Sub topic configured — polling remains the only sync driver.
   */
  protected async ensureWatch(
    channelId: string,
    rpc?: RpcClient,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    const caller = rpc ?? this.rpc;
    try {
      const topicName = this.getPushTopicName(channelId);
      if (!topicName) return;
      const state = this.getChannelState(channelId);
      if (!state.emailAddress) return; // first sync hasn't resolved the mailbox yet
      const now = this.now();
      if (
        !state.watchExpiration ||
        state.watchExpiration - now < WATCH_RENEW_MARGIN_MS
      ) {
        const gmail =
          rpc === undefined
            ? this.gmailForChannel(channelId)
            : this.createBoundGmailClient(
                rpc,
                this.getGmailCredentialId(channelId),
                context,
              );
        const result = await gmail.watch({
          topicName,
        });
        const fresh = this.getChannelState(channelId);
        fresh.watchExpiration = result.expiration;
        this.saveChannelState(fresh);
      }
      // Re-register every pass: cloned/restarted workers and recreated router
      // state converge without requiring the generic webhook ingress to know
      // anything about Gmail mailboxes.
      await caller.call(gmailPushRouterTarget(), "registerPushTarget", [
        {
          emailAddress: state.emailAddress,
          source: GMAIL_DO_SOURCE,
          className: GMAIL_DO_CLASS,
          objectKey: this.objectKey,
        },
      ]);
    } catch (err) {
      if (!(err instanceof GmailApiError)) throw err;
      // Push is an optimization; polling keeps working without it.
      console.warn(
        `[GmailAgentWorker] ensureWatch failed for channel=${channelId}:`,
        err,
      );
    }
  }

  /**
   * Generic webhook ingress delivery for the singleton Gmail push router. The
   * server has already verified and decoded the Cloud Pub/Sub envelope; Gmail
   * interpretation and fanout stay here.
   */
  @rpc({
    website: {
      kind: "closed",
      reason:
        "This receiver serves installed workspace applications and their agents.",
    },
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async onWebhookDelivery(
    event: WebhookDeliveryEvent,
  ): Promise<{ synced: string[] }> {
    if (event.payload.type !== "cloud-pubsub") return { synced: [] };
    const data = record(event.payload.dataJson);
    const email = stringArg(data, "emailAddress")?.toLowerCase();
    const historyId =
      stringArg(data, "historyId") ?? String(data["historyId"] ?? "");
    if (!email || !historyId) return { synced: [] };
    const rows = this.sql
      .exec(
        `SELECT source, class_name, object_key
         FROM gmail_push_targets
         WHERE email_address = ?`,
        email,
      )
      .toArray();
    const synced = new Set<string>();
    for (const row of rows) {
      const target: GmailPushTarget = {
        source: String(row["source"]),
        className: String(row["class_name"]),
        objectKey: String(row["object_key"]),
      };
      try {
        const result = (await this.rpc.call(
          gmailTargetId(target),
          "onGmailPushNotification",
          [{ emailAddress: email, historyId }],
        )) as { synced?: string[] } | undefined;
        for (const channelId of result?.synced ?? []) synced.add(channelId);
      } catch (err) {
        console.warn(
          `[GmailAgentWorker] push dispatch failed for ${email} -> ${gmailTargetId(target)}:`,
          err,
        );
      }
    }
    return { synced: [...synced] };
  }

  @rpc({
    website: {
      kind: "closed",
      reason:
        "This receiver serves installed workspace applications and their agents.",
    },
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  registerPushTarget(input: {
    emailAddress: string;
    source: string;
    className: string;
    objectKey: string;
  }): { registered: true } {
    const email = stringArg(record(input), "emailAddress")?.toLowerCase();
    const source = stringArg(record(input), "source");
    const className = stringArg(record(input), "className");
    const objectKey = stringArg(record(input), "objectKey");
    if (!email || !source || !className || !objectKey) {
      throw new Error(
        "registerPushTarget requires emailAddress, source, className, and objectKey",
      );
    }
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_push_targets
       (email_address, source, class_name, object_key, registered_at)
       VALUES (?, ?, ?, ?, ?)`,
      email,
      source,
      className,
      objectKey,
      this.now(),
    );
    return { registered: true };
  }

  @rpc({
    website: {
      kind: "closed",
      reason:
        "This receiver serves installed workspace applications and their agents.",
    },
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  unregisterPushTarget(input: {
    emailAddress: string;
    source: string;
    className: string;
    objectKey: string;
  }): { unregistered: boolean } {
    const email = stringArg(record(input), "emailAddress")?.toLowerCase();
    const source = stringArg(record(input), "source");
    const className = stringArg(record(input), "className");
    const objectKey = stringArg(record(input), "objectKey");
    if (!email || !source || !className || !objectKey)
      return { unregistered: false };
    const before = this.sql
      .exec(
        `SELECT COUNT(*) AS count FROM gmail_push_targets
         WHERE email_address = ? AND source = ? AND class_name = ? AND object_key = ?`,
        email,
        source,
        className,
        objectKey,
      )
      .toArray()[0];
    this.sql.exec(
      `DELETE FROM gmail_push_targets
       WHERE email_address = ? AND source = ? AND class_name = ? AND object_key = ?`,
      email,
      source,
      className,
      objectKey,
    );
    return { unregistered: Number(before?.["count"] ?? 0) > 0 };
  }

  /**
   * Gmail-router-dispatched Pub/Sub push: a new historyId exists for a mailbox.
   * Sync every channel bound to that address now; the follow-up alarm runs
   * the triage/wake pipeline.
   */
  @rpc({
    website: {
      kind: "closed",
      reason:
        "This receiver serves installed workspace applications and their agents.",
    },
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async onGmailPushNotification(payload: {
    emailAddress: string;
    historyId: string;
  }): Promise<{
    synced: string[];
  }> {
    const caller = this.caller;
    const expectedRouter = gmailPushRouterTarget();
    if (!caller || caller.callerId !== expectedRouter) {
      throw new Error(
        "onGmailPushNotification is only dispatched by the Gmail push router",
      );
    }
    const email = String(payload?.emailAddress ?? "").toLowerCase();
    if (!email) return { synced: [] };
    const rows = this.sql
      .exec(
        `SELECT channel_id FROM gmail_channel_state WHERE lower(email_address) = ? AND sync_state != 'auth-needed'`,
        email,
      )
      .toArray();
    const synced: string[] = [];
    for (const row of rows) {
      const channelId = String(row["channel_id"]);
      if (!this.subscriptions.getParticipantId(channelId)) continue;
      await this.ensureRecovered(channelId);
      const result = await this.syncEngine
        .syncChannel(channelId)
        .catch(() => null);
      if (result?.ok) synced.push(channelId);
    }
    // Let the normal alarm pipeline drain triage candidates + wake digests.
    return { synced };
  }

  /**
   * Fire due snooze reminders through the existing wake/digest pipeline and
   * return the delay until the next pending reminder.
   */
  protected processDueReminders(now: number): number | undefined {
    for (const reminder of this.store.drainDueReminders(now)) {
      if (!this.subscriptions.getParticipantId(reminder.channelId)) continue;
      this.wake.enqueue(
        reminder.channelId,
        {
          threadId: reminder.threadId,
          messageId: `reminder-${reminder.remindAt}`,
          from: reminder.from ?? "",
          to: "",
          subject: reminder.subject ?? "(snoozed thread)",
          snippet: reminder.note ?? "",
          labels: [],
          hasAttachment: false,
          unread: true,
          inInbox: true,
          addressedToUser: true,
        },
        {
          wake: true,
          directiveId: "reminder",
          directiveName: "Reminder",
          reason: reminder.note
            ? `Reminder: ${reminder.note}`
            : "Snoozed thread is due",
          actions: ["surface"],
        },
      );
    }
    const next = this.store.nextReminderAt();
    return next === undefined ? undefined : Math.max(next - now, 1000);
  }

  /** Run the batched LLM triage pass for every channel with queued candidates. */
  protected async processTriageQueues(
    triage: TriageEngine = this.triage,
  ): Promise<number | undefined> {
    let nextDelay: number | undefined;
    for (const channelId of this.store.channelsWithPendingCandidates()) {
      try {
        const { retryInMs } = await triage.runTriagePass(channelId);
        nextDelay = minDefined(nextDelay, retryInMs);
      } catch (err) {
        console.error(
          `[GmailAgentWorker] triage failed for channel=${channelId}:`,
          err,
        );
      }
    }
    return nextDelay;
  }

  /**
   * Drain due attention wake windows into a single digest turn per channel.
   * Returns the delay (ms) until the next pending wake deadline, if any.
   */
  protected async processWakeQueues(now: number): Promise<number | undefined> {
    let nextDelay: number | undefined;
    const minDelay = (deadline: number) => {
      const delay = Math.max(deadline - now, 1000);
      nextDelay = nextDelay === undefined ? delay : Math.min(nextDelay, delay);
    };
    const channels = this.sql
      .exec(`SELECT DISTINCT channel_id FROM gmail_attention_queue`)
      .toArray()
      .map((row) => String(row["channel_id"]));
    for (const channelId of channels) {
      const decision = this.wake.decision(channelId, now);
      if (decision.kind === "wait") {
        minDelay(decision.deadline);
      } else if (decision.kind === "capped") {
        // Rate-capped: keep the backlog queued; retry once the oldest counted
        // wake turn ages out of the window.
        minDelay(decision.retryAt);
      } else if (decision.kind === "turn") {
        const hits = this.wake.drain(channelId, now);
        if (hits.length === 0) continue;
        await this.submitAgentInitiatedTurn(
          channelId,
          { content: buildWakeDigestPrompt(hits) },
          { steeringId: `gmail-attention-digest:${channelId}:${now}` },
        );
      }
    }
    return nextDelay;
  }

  protected override async handleAgentMethodCall(
    channelId: string,
    methodName: string,
    args: unknown,
    signal: AbortSignal,
    transportCallId: string,
  ): Promise<{ result: unknown; isError?: boolean } | null> {
    const standard = await super.handleAgentMethodCall(
      channelId,
      methodName,
      args,
      signal,
      transportCallId,
    );
    if (standard) return standard;
    const op = this.operationIndex.get(methodName);
    if (!op) return null;
    signal.throwIfAborted();
    const context: Context = { ...BACKGROUND_CONTEXT, abortSignal: signal };
    const methodRpc = withRpcAbortSignal(this.rpc, signal);
    const credentialId = this.getGmailCredentialId(channelId);
    const gmail = this.createBoundGmailClient(methodRpc, credentialId, context);
    const fs = createRpcFs(methodRpc as never);
    const domain = this.composeGmailDomain({
      cards: this.boundCardManager(methodRpc),
      gmailFor: () => gmail,
      cacheKey: (id) => JSON.stringify([id, credentialId ?? null]),
      shareAccountCaches: credentialId !== undefined,
      generateDraftReplyBody: (id, thread) =>
        this.generateDraftReplyBody(id, thread, context, methodRpc),
      runTriageModel: (id, system, prompt) =>
        this.runTriageModel(id, system, prompt, context, methodRpc),
      writeFile: (path, data) => fs.writeFile(path, data),
      rpc: methodRpc,
    });
    if (op.needsRecovery)
      await this.ensureRecovered(channelId, domain.cards, methodRpc);
    const result = await op.run(domain.context, channelId, record(args));
    await this.updateGmailSchedule();
    signal.throwIfAborted();
    const isError = Boolean(
      result && typeof result === "object" && "error" in result,
    );
    return isError ? { result, isError: true } : { result };
  }

  // ── attention preference RPC (public Durable Object methods) ──────────────

  private assertSubscribedChannel(channelId: string): void {
    if (!channelId || !this.subscriptions.getParticipantId(channelId)) {
      throw new Error(`Gmail agent is not subscribed to channel: ${channelId}`);
    }
  }

  @rpc({
    website: {
      kind: "closed",
      reason:
        "This receiver serves installed workspace applications and their agents.",
    },
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async getAttentionPrefs(channelId: string): Promise<GmailAttentionPrefs> {
    this.assertSubscribedChannel(channelId);
    return this.handlers.getAttentionPrefs(channelId);
  }

  @rpc({
    website: {
      kind: "closed",
      reason:
        "This receiver serves installed workspace applications and their agents.",
    },
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async setAttentionPrefs(
    channelId: string,
    args: unknown,
  ): Promise<{ saved: true; preferences: GmailAttentionPrefs }> {
    const caller = this.caller;
    if (caller && caller.callerKind !== "panel") {
      throw new Error(
        "Attention preferences may only be changed by a user-facing panel",
      );
    }
    this.assertSubscribedChannel(channelId);
    const input = record(args);
    const result = await this.handlers.setAttention(channelId, {
      preferences:
        stringArg(input, "preferences") ?? stringArg(input, "preferencesText"),
      ...(booleanArg(input, "knownSenderShortcut") !== undefined
        ? { knownSenderShortcut: booleanArg(input, "knownSenderShortcut") }
        : {}),
      ...(booleanArg(input, "markConfigured") !== undefined
        ? { markConfigured: booleanArg(input, "markConfigured") }
        : {}),
    });
    return { saved: true, preferences: result.preferences };
  }

  // ── channel UI install & onboarding ───────────────────────────────────────

  private localActor(channelId: string): ActorRef & { participantId?: string } {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId)
      throw new Error(`Gmail agent is not subscribed to channel ${channelId}`);
    return {
      kind: "agent",
      id: participantId,
      participantId,
      displayName: "Gmail",
      metadata: { type: "agent", handle: "gmail", name: "Gmail" },
    };
  }

  private async installChannelUi(
    channelId: string,
    rpc: RpcClient = this.rpc,
    cards: CardManager = this.cards,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    const fs = createRpcFs(rpc as never);
    await installMessageTypes({
      channel: this.createChannelClient(channelId, rpc),
      actor: this.localActor(channelId),
      specs: GMAIL_MESSAGE_TYPES,
      imports: GMAIL_UI_IMPORTS,
      version: GMAIL_UI_INSTALL_VERSION,
      keyPrefix: "gmail",
      // Tombstone retired message types (e.g. the old gmail.inbox desk card)
      // so stale cards stop rendering against deleted renderer files.
      retiredTypeIds: GMAIL_RETIRED_MESSAGE_TYPES,
      actionBar: {
        id: "gmail-action-bar",
        path: GMAIL_ACTION_BAR_FILE,
        maxHeight: GMAIL_ACTION_BAR_MAX_HEIGHT,
      },
      cards,
      channelId,
      readFile: async (path) => {
        try {
          const raw = await fs.readFile(path, "utf8");
          return typeof raw === "string"
            ? raw
            : raw instanceof Uint8Array
              ? new TextDecoder().decode(raw)
              : null;
        } catch (error) {
          if (
            context.abortSignal?.aborted ||
            (error &&
              typeof error === "object" &&
              "errorKind" in error &&
              error.errorKind !== "application")
          )
            throw error;
          return null;
        }
      },
    });
  }

  private async startSetupTurnIfNeeded(
    channelId: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    const state = this.getChannelState(channelId);
    if (state.setupStatus === "configured" || state.setupPromptedAt) return;
    await this.submitAgentInitiatedTurn(
      channelId,
      { content: GMAIL_SETUP_ONBOARDING_PROMPT },
      { steeringId: `gmail-setup:${channelId}` },
      context,
    );
    state.setupPromptedAt = Date.now();
    this.saveChannelState(state);
  }

  // ── setup card publishing ─────────────────────────────────────────────────

  /** Publish/refresh the gmail.setup card; deduped via last_setup_json. */
  private async publishSetupCard(
    channelId: string,
    gmailCards: GmailCards = this.gmailCards,
    cards: CardManager = this.cards,
    toolRpc?: RpcClient,
  ): Promise<void> {
    if (!this.subscriptions.getParticipantId(channelId)) return;
    const state = this.getChannelState(channelId);
    const prefs = this.store.getPrefs(channelId);
    const payload: GmailSetupState = {
      status: state.setupStatus === "configured" ? "configured" : "onboarding",
      auth: {
        status:
          state.syncState === "auth-needed"
            ? "reconnect-required"
            : state.lastSyncAt
              ? "ok"
              : "unknown",
      },
      ...(state.emailAddress ? { email: state.emailAddress } : {}),
      ...(state.setupSummary ? { setupSummary: state.setupSummary } : {}),
      attentionPreference: this.store.hasSavedPrefs(channelId)
        ? prefs.preferencesText
        : DEFAULT_ATTENTION_PREFERENCES,
      pollIntervalMs: state.pollIntervalMs,
      ...(state.lastSyncAt
        ? { lastSyncAt: new Date(state.lastSyncAt).toISOString() }
        : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
      addressBook: {
        knownPeople: this.people.count(channelId),
        googleContacts:
          state.peopleApiStatus === "ok"
            ? "available"
            : state.peopleApiStatus === "unavailable"
              ? "unavailable"
              : "unknown",
      },
    };
    const setupJson = JSON.stringify(payload);
    if (state.lastSetupJson === setupJson) return;
    const previouslyNeededAuth =
      state.lastSetupJson?.includes('"reconnect-required"') ?? false;
    await gmailCards.publishSetup(channelId, payload);
    // Reauth is a background failure the person cannot see from the channel
    // alone: it happens on a poll while nobody is watching, and every later
    // triage silently stops. Escalate ONCE per transition into
    // reconnect-required (messaging plan §6.4), on the setup card that already
    // carries the reconnect affordance — never per poll.
    if (payload.auth.status === "reconnect-required" && !previouslyNeededAuth) {
      await this.escalateReauth(channelId, cards, toolRpc);
    }
    const fresh = this.getChannelState(channelId);
    fresh.lastSetupJson = setupJson;
    this.saveChannelState(fresh);
  }

  /** The single person on this channel, when there is one — the messaging
   *  plan's `owner` rule; several people means no unambiguous owner. */
  private channelOwnerUserId(channelId: string): string | null {
    const users = this.rosterSnapshot(channelId).filter(
      (entry) => entry.ref.kind === "user",
    );
    if (users.length !== 1) return null;
    const id = users[0]?.ref.participantId ?? users[0]?.participantId ?? "";
    return id.startsWith("user:") ? id.slice("user:".length) : id || null;
  }

  private async escalateReauth(
    channelId: string,
    cards: CardManager = this.cards,
    toolRpc: RpcClient = this.rpc,
  ): Promise<void> {
    const owner = this.channelOwnerUserId(channelId);
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!owner || !participantId) return;
    const setupCard = cards.find(channelId, SETUP_CARD_KEY);
    const state = this.getChannelState(channelId);
    await this.escalateNotify(
      {
        userId: owner,
        channelId,
        messageId: setupCard?.messageId ?? SETUP_CARD_KEY,
        senderParticipantId: participantId,
        senderHandle: "gmail",
        rung: "inbox",
        title: `Gmail needs to be reconnected${state.emailAddress ? ` (${state.emailAddress})` : ""}`,
        message:
          "Google rejected the stored credential, so mail sync and triage are paused. " +
          "Open the conversation and use **Reconnect** on the setup card to resume." +
          (state.lastError ? `\n\n_${state.lastError}_` : ""),
      },
      toolRpc,
    );
  }

  // ── replay recovery ───────────────────────────────────────────────────────

  private async ensureRecovered(
    channelId: string,
    cards: GmailCards = this.gmailCards,
    toolRpc: RpcClient = this.rpc,
  ): Promise<void> {
    if (this.recoveredChannels.has(channelId)) return;

    const folded = await this.indexOwnCustomMessages(
      channelId,
      (typeId) => {
        if (typeId === "gmail.thread") {
          return (state, update) =>
            reduceGmailThread(state as GmailThreadState, update as never);
        }
        return undefined;
      },
      toolRpc,
    );

    for (const [messageId, value] of folded.get("gmail.compose") ?? []) {
      cards.recoverCompose(
        channelId,
        messageId,
        value as GmailComposeCardState,
      );
    }

    const setup = folded.get("gmail.setup");
    if (setup && setup.size > 0) {
      const messageId = [...setup.keys()][0]!;
      cards.adoptRecoveredCard(
        channelId,
        SETUP_CARD_KEY,
        "gmail.setup",
        messageId,
      );
    }

    for (const [messageId, value] of folded.get("gmail.thread") ?? []) {
      const thread = record(value);
      const threadId =
        typeof thread["threadId"] === "string" ? thread["threadId"] : undefined;
      if (!threadId) continue;
      cards.adoptRecoveredCard(
        channelId,
        threadCardKey(threadId),
        "gmail.thread",
        messageId,
      );
      const subject =
        typeof thread["subject"] === "string"
          ? thread["subject"]
          : "(no subject)";
      const from =
        Array.isArray(thread["participants"]) &&
        typeof thread["participants"][0] === "string"
          ? thread["participants"][0]
          : "";
      const snippet =
        typeof thread["lastSnippet"] === "string"
          ? thread["lastSnippet"]
          : typeof thread["snippet"] === "string"
            ? thread["snippet"]
            : "";
      const unreadCount =
        typeof thread["unreadCount"] === "number" ? thread["unreadCount"] : 0;
      const status =
        typeof thread["status"] === "string" ? thread["status"] : "unread";
      const category =
        typeof thread["category"] === "string" ? thread["category"] : null;
      const actionable =
        Boolean(thread["actionable"]) ||
        (unreadCount > 0 &&
          status !== "archived" &&
          !["Promotions", "Social", "Updates", "Forums"].includes(
            category ?? "",
          ));
      this.sql.exec(
        `INSERT OR REPLACE INTO gmail_threads
         (channel_id, thread_id, subject, from_addr, snippet, unread, in_inbox, actionable, category, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        channelId,
        threadId,
        subject,
        from,
        snippet,
        unreadCount > 0 ? 1 : 0,
        status === "archived" ? 0 : 1,
        actionable ? 1 : 0,
        category,
        Date.now(),
      );
    }
    this.recoveredChannels.add(channelId);
  }
}

function minDefined(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function gmailPushRouterTarget(): string {
  return gmailTargetId({
    source: GMAIL_DO_SOURCE,
    className: GMAIL_DO_CLASS,
    objectKey: GMAIL_PUSH_ROUTER_KEY,
  });
}

function gmailTargetId(target: GmailPushTarget): string {
  return `do:${target.source}:${target.className}:${target.objectKey}`;
}
