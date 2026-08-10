import {
  AgentWorkerBase,
  installMessageTypes,
  type AgentToolExecutionContext,
  type RespondPolicy,
} from "@workspace/agentic-do";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { rpc } from "@workspace/runtime/worker";
import type { DurableObjectContext, WebhookDeliveryEvent } from "@workspace/runtime/worker";
import {
  AGENTIC_PROTOCOL_VERSION,
  type ActorRef,
  type AgenticEvent,
} from "@workspace/agentic-protocol";
import { createGmailClient, type GmailClient, type GmailThread } from "@workspace/gmail";
import type { GmailAttentionPrefs, GmailSetupState } from "@workspace/gmail/card-types";
import {
  reduce as reduceGmailThread,
  type GmailThreadState,
} from "@workspace/gmail/renderers/gmail-thread.reducer";
import type { ParticipantDescriptor } from "@workspace/harness";
import type { AgentTool } from "@workspace/pi-core";
import type { DoAlarmSchedule } from "@vibestudio/shared/doDispatcher";

import { DEFAULT_ATTENTION_PREFERENCES, createGmailTables } from "./schema.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  booleanArg,
  numberArg,
  record,
  stringArg,
  type GmailChannelState,
} from "./types.js";
import { TriageStore } from "./triage/triage-store.js";
import { TriageEngine } from "./triage/triage-engine.js";
import { PeopleStore } from "./people/people-store.js";
import { WAKE_DEBOUNCE_MS, WakeQueue, buildWakeDigestPrompt } from "./triage/wake.js";
import { SyncEngine } from "./sync/sync-engine.js";
import {
  GMAIL_MESSAGE_TYPES,
  GMAIL_RETIRED_MESSAGE_TYPES,
  GmailCards,
  SETUP_CARD_KEY,
  threadCardKey,
} from "./cards/cards.js";
import { GmailHandlers } from "./agent/handlers.js";
import { LabelResolver } from "./agent/label-resolver.js";
import { SendAsCache } from "./agent/sendas-cache.js";
import { GmailParticipantApi } from "./participant-api.js";
import {
  advertisedMethods,
  buildOperationIndex,
  toolOperations,
  type GmailOperation,
  type GmailOperationContext,
} from "./agent/operations.js";
import { GMAIL_SETUP_ONBOARDING_PROMPT, GMAIL_SYSTEM_PROMPT } from "./agent/prompts.js";
import { generateDraftReplyBody as generateDraftReplyBodyLlm } from "./agent/draft-writer.js";

const GMAIL_ACTION_BAR_FILE = "packages/gmail/src/action-bar.tsx";
const GMAIL_ACTION_BAR_MAX_HEIGHT = 64;
const GMAIL_UI_INSTALL_VERSION = 5;
const GMAIL_UI_IMPORTS = {
  react: "latest",
  "react/jsx-runtime": "latest",
  "@radix-ui/themes": "npm:^3.2.1",
  "@radix-ui/react-icons": "npm:^1.3.2",
} satisfies Record<string, string>;
const GMAIL_UNIVERSAL_LOOP_TOOL_NAMES = new Set(["suspend_turn", "ask_user"]);
const PI_MODELS = builtinModels();

/** Preferred cheap triage tier per provider; falls back to the channel model. */
const TRIAGE_MODEL_BY_PROVIDER: Record<string, string> = {
  "openai-codex": "gpt-5.6-luna",
  anthropic: "claude-haiku-4-5",
};

export function triageModelCandidates(channelModelRef: string, override?: string): string[] {
  const colonIdx = channelModelRef.indexOf(":");
  const provider = colonIdx > 0 ? channelModelRef.slice(0, colonIdx) : channelModelRef;
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
const GMAIL_AGENT_SCHEMA_BASELINE = 7;

type GmailTool = AgentTool;

interface GmailPushTarget {
  source: string;
  className: string;
  objectKey: string;
}

export class GmailAgentWorker extends AgentWorkerBase {
  // Version 7 is the first supported production shape. Earlier experimental
  // layouts have no proven lossless translation and are rejected intact.
  static override schemaVersion = GMAIL_AGENT_SCHEMA_BASELINE;

  protected override schemaProductionBaseline() {
    return {
      version: GMAIL_AGENT_SCHEMA_BASELINE,
      name: "gmail-agent-v7",
    } as const;
  }

  private gmailClients = new Map<string, GmailClient>();
  private recoveredChannels = new Set<string>();
  private readonly operationIndex: Map<string, GmailOperation>;
  private readonly operationContext: GmailOperationContext;

  private readonly store: TriageStore;
  private readonly triage: TriageEngine;
  private readonly people: PeopleStore;
  private readonly wake: WakeQueue;
  private readonly gmailCards: GmailCards;
  private readonly labels: LabelResolver;
  private readonly sendAs: SendAsCache;
  private readonly syncEngine: SyncEngine;
  private readonly handlers: GmailHandlers;
  private readonly participantApi: GmailParticipantApi;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    void this.setOwnTitle("Gmail");
    // One clock for everything time-based (wake debounce, triage rate caps,
    // alarm scheduling) so tests can inject a coherent fake time via now().
    const now = () => this.now();
    this.store = new TriageStore({ sql: this.sql, now });
    this.people = new PeopleStore({ sql: this.sql });
    this.wake = new WakeQueue({ sql: this.sql, now });
    this.gmailCards = new GmailCards({ cards: this.cards, sql: this.sql });
    this.labels = new LabelResolver({
      gmailFor: (channelId) => this.gmailForChannel(channelId),
      now,
    });
    this.sendAs = new SendAsCache({
      gmailFor: (channelId) => this.gmailForChannel(channelId),
      now,
    });
    this.triage = new TriageEngine({
      store: this.store,
      wake: this.wake,
      runTriageModel: (channelId, systemPrompt, userPrompt) =>
        this.runTriageModel(channelId, systemPrompt, userPrompt),
      isConfigured: (channelId) => this.getChannelState(channelId).setupStatus === "configured",
      applyDecision: (channelId, threadId, decision) =>
        this.syncEngine.applyTriageDecision(channelId, threadId, decision),
      now,
    });
    this.syncEngine = new SyncEngine({
      sql: this.sql,
      gmailFor: (channelId) => this.gmailForChannel(channelId),
      triage: this.triage,
      store: this.store,
      people: this.people,
      cards: this.gmailCards,
      getChannelState: (channelId) => this.getChannelState(channelId),
      saveChannelState: (state) => this.saveChannelState(state),
      publishSetup: (channelId) => this.publishSetupCard(channelId),
      now,
    });
    this.handlers = new GmailHandlers({
      sql: this.sql,
      gmailFor: (channelId) => this.gmailForChannel(channelId),
      sync: this.syncEngine,
      store: this.store,
      triage: this.triage,
      labels: this.labels,
      sendAs: this.sendAs,
      people: this.people,
      cards: this.gmailCards,
      getChannelState: (channelId) => this.getChannelState(channelId),
      saveChannelState: (state) => this.saveChannelState(state),
      publishSetup: (channelId) => this.publishSetupCard(channelId),
      generateDraftReplyBody: (channelId, thread) => this.generateDraftReplyBody(channelId, thread),
      isSubscribed: (channelId) => Boolean(this.subscriptions.getParticipantId(channelId)),
      writeFile: (path, data) => this.writeWorkspaceFile(path, data),
      now,
    });
    this.participantApi = new GmailParticipantApi({
      sql: this.sql,
      handlers: this.handlers,
      sync: this.syncEngine,
      getChannelState: (channelId) => this.getChannelState(channelId),
    });
    this.operationIndex = buildOperationIndex();
    this.operationContext = {
      handlers: this.handlers,
      participantApi: this.participantApi,
      queuedWakeCount: (channelId) => this.wake.queuedCount(channelId),
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

  protected override createTables(): void {
    super.createTables();
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
    return createGmailClient(this.credentials, credentialId ? { credentialId } : {});
  }

  private getGmailCredentialId(channelId: string): string | undefined {
    const state = this.getChannelState(channelId);
    if (state.credentialId) return state.credentialId;
    const config = record(this.subscriptions.getConfig(channelId));
    return (
      stringArg(config, "googleCredentialId") ?? stringArg(config, "credentialId") ?? undefined
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
      DEFAULT_POLL_INTERVAL_MS
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
      pollIntervalMs: Number(row["poll_interval_ms"]) || DEFAULT_POLL_INTERVAL_MS,
      lastSyncAt: (row["last_sync_at"] as number | null) ?? undefined,
      lastError: (row["last_error"] as string | null) ?? undefined,
      setupStatus: row["setup_status"] === "configured" ? "configured" : "needs-user-preferences",
      setupPromptedAt: (row["setup_prompted_at"] as number | null) ?? undefined,
      configuredAt: (row["configured_at"] as number | null) ?? undefined,
      setupSummary: (row["setup_summary"] as string | null) ?? undefined,
      syncState: row["sync_state"] === "auth-needed" ? "auth-needed" : "ok",
      rateLimitedUntil: (row["rate_limited_until"] as number | null) ?? undefined,
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
      state.watchExpiration ?? null
    );
  }

  // ── agent configuration ───────────────────────────────────────────────────

  protected override getDefaultModel(): string {
    return "openai-codex:gpt-5.6-sol";
  }

  protected override getRespondPolicy(): RespondPolicy {
    return "mentioned-or-followup";
  }

  protected override getAgentPrompt(_channelId: string): string {
    return GMAIL_SYSTEM_PROMPT;
  }

  protected async generateDraftReplyBody(channelId: string, thread: GmailThread): Promise<string> {
    return generateDraftReplyBodyLlm({
      modelRef: this.getAgentSettings().model,
      apiKey: await this.resolveModelApiKey(channelId),
      thread,
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
    userPrompt: string
  ): Promise<string> {
    const channelModelRef = this.getAgentSettings().model;
    const override = this.store.getPrefs(channelId).triageModel;
    const candidates = triageModelCandidates(channelModelRef, override);
    let model: ReturnType<typeof PI_MODELS.getModel> | null = null;
    for (const candidate of candidates) {
      const idx = candidate.indexOf(":");
      if (idx <= 0) continue;
      model = PI_MODELS.getModel(candidate.slice(0, idx), candidate.slice(idx + 1));
      if (model) break;
    }
    if (!model) throw new Error(`No triage model metadata for: ${candidates.join(", ")}`);
    const apiKey = await this.resolveModelApiKey(channelId);
    const response = await PI_MODELS.complete(
      model,
      {
        systemPrompt,
        messages: [{ role: "user", timestamp: Date.now(), content: userPrompt }],
      },
      { apiKey, temperature: 0, maxTokens: 800 }
    );
    return response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
  }

  protected override async getLoopTools(
    channelId: string,
    execution?: AgentToolExecutionContext
  ): Promise<AgentTool[]> {
    const universalTools = (await super.getLoopTools(channelId, execution)).filter((tool) =>
      GMAIL_UNIVERSAL_LOOP_TOOL_NAMES.has(tool.name)
    );
    const gmailTools = toolOperations().map(
      (op) =>
        ({
          name: op.name,
          label: op.name,
          description: op.description,
          parameters: op.schema,
          execute: async (_toolCallId: string, params: unknown) => {
            if (op.needsRecovery) await this.ensureRecovered(channelId);
            const details = await op.run(this.operationContext, channelId, record(params));
            return {
              content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
              details,
            };
          },
        }) as GmailTool
    );
    return [...universalTools, ...gmailTools];
  }

  protected override getParticipantInfo(
    _channelId: string,
    config?: unknown
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

  // ── lifecycle ─────────────────────────────────────────────────────────────

  override async subscribeChannel(
    opts: Parameters<AgentWorkerBase["subscribeChannel"]>[0]
  ): Promise<{ ok: boolean; participantId: string }> {
    const result = await super.subscribeChannel(opts);
    this.ensureChannelState(opts.channelId);
    const credentialId =
      stringArg(record(opts.config), "googleCredentialId") ??
      stringArg(record(opts.config), "credentialId");
    if (credentialId) {
      const state = this.getChannelState(opts.channelId);
      state.credentialId = credentialId;
      this.saveChannelState(state);
    }
    await this.installChannelUi(opts.channelId);
    await this.publishSetupCard(opts.channelId);
    await this.startSetupTurnIfNeeded(opts.channelId);
    await this.ensureWatch(opts.channelId);
    return result;
  }

  private nextGmailAlarmSchedule(now = this.now()): DoAlarmSchedule | null {
    const wakeTimes: number[] = [];
    const reminderAt = this.store.nextReminderAt();
    if (reminderAt !== undefined) wakeTimes.push(Math.max(reminderAt, now + 1000));

    for (const channelId of this.store.channelsWithPendingCandidates()) {
      const wakeAt = this.triage.nextWakeAt(channelId, now);
      if (wakeAt !== undefined) wakeTimes.push(wakeAt);
    }
    const attentionChannels = this.sql
      .exec(`SELECT DISTINCT channel_id FROM gmail_attention_queue ORDER BY channel_id`)
      .toArray();
    for (const row of attentionChannels) {
      const wakeAt = this.wake.nextWakeAt(String(row["channel_id"]), now);
      if (wakeAt !== undefined) wakeTimes.push(wakeAt);
    }

    const channels = this.sql
      .exec(
        `SELECT poll_interval_ms, sync_state, rate_limited_until, watch_expiration
           FROM gmail_channel_state`
      )
      .toArray();
    for (const row of channels) {
      if (String(row["sync_state"] ?? "ok") === "auth-needed") continue;
      const rateLimitedUntil = Number(row["rate_limited_until"] ?? 0);
      const watchExpiration = Number(row["watch_expiration"] ?? 0);
      const watchActive = watchExpiration > now + WATCH_RENEW_MARGIN_MS;
      const basePoll = Number(row["poll_interval_ms"]) || DEFAULT_POLL_INTERVAL_MS;
      const poll = watchActive
        ? Math.min(
            Math.max(basePoll, WATCH_FALLBACK_POLL_MS),
            Math.max(watchExpiration - WATCH_RENEW_MARGIN_MS - now, 60_000)
          )
        : basePoll;
      wakeTimes.push(rateLimitedUntil > now ? Math.max(rateLimitedUntil, now + 1000) : now + poll);
    }
    return wakeTimes.length === 0 ? null : { wakeAt: Math.min(...wakeTimes) };
  }

  protected override nextAlarmAfterRequest(): DoAlarmSchedule | null {
    const agent = super.nextAlarmAfterRequest();
    const gmail = this.nextGmailAlarmSchedule();
    if (agent === null) return gmail;
    if (gmail === null) return agent;
    return agent.wakeAt <= gmail.wakeAt ? agent : gmail;
  }

  override async alarm(): Promise<DoAlarmSchedule | null> {
    await super.alarm();
    const now = this.now();
    const rows = this.sql
      .exec(`SELECT channel_id, sync_state, rate_limited_until FROM gmail_channel_state`)
      .toArray();
    for (const row of rows) {
      const channelId = String(row["channel_id"]);
      if (String(row["sync_state"] ?? "ok") === "auth-needed") continue;
      const rateLimitedUntil = Number(row["rate_limited_until"] ?? 0);
      if (rateLimitedUntil > now) continue;
      await this.ensureRecovered(channelId);
      await this.syncEngine.syncChannel(channelId).catch((err) => {
        console.error(`[GmailAgentWorker] sync failed for channel=${channelId}:`, err);
      });
      await this.ensureWatch(channelId);
    }
    this.processDueReminders(now);
    await this.processTriageQueues();
    await this.processWakeQueues(now);
    return this.nextAlarmAfterRequest();
  }

  // ── push notifications (users.watch → Cloud Pub/Sub → webhook ingress) ───

  /**
   * Start or renew the Gmail push watch for a channel and (re-)register this
   * DO with the Gmail-owned push router. No-ops when the channel has no
   * Google Pub/Sub topic configured — polling remains the only sync driver.
   */
  protected async ensureWatch(channelId: string): Promise<void> {
    try {
      const topicName = this.getPushTopicName(channelId);
      if (!topicName) return;
      const state = this.getChannelState(channelId);
      if (!state.emailAddress) return; // first sync hasn't resolved the mailbox yet
      const now = this.now();
      if (!state.watchExpiration || state.watchExpiration - now < WATCH_RENEW_MARGIN_MS) {
        const result = await this.gmailForChannel(channelId).watch({
          topicName,
        });
        const fresh = this.getChannelState(channelId);
        fresh.watchExpiration = result.expiration;
        this.saveChannelState(fresh);
      }
      // Re-register every pass: cloned/restarted workers and recreated router
      // state converge without requiring the generic webhook ingress to know
      // anything about Gmail mailboxes.
      await this.rpc.call(gmailPushRouterTarget(), "registerPushTarget", [
        {
          emailAddress: state.emailAddress,
          source: GMAIL_DO_SOURCE,
          className: GMAIL_DO_CLASS,
          objectKey: this.objectKey,
        },
      ]);
    } catch (err) {
      // Push is an optimization; polling keeps working without it.
      console.warn(`[GmailAgentWorker] ensureWatch failed for channel=${channelId}:`, err);
    }
  }

  /**
   * Generic webhook ingress delivery for the singleton Gmail push router. The
   * server has already verified and decoded the Cloud Pub/Sub envelope; Gmail
   * interpretation and fanout stay here.
   */
  @rpc({ principals: ["host"], effect: { kind: "open" }, tier: "open", sensitivity: "write" })
  async onWebhookDelivery(event: WebhookDeliveryEvent): Promise<{ synced: string[] }> {
    if (event.payload.type !== "cloud-pubsub") return { synced: [] };
    const data = record(event.payload.dataJson);
    const email = stringArg(data, "emailAddress")?.toLowerCase();
    const historyId = stringArg(data, "historyId") ?? String(data["historyId"] ?? "");
    if (!email || !historyId) return { synced: [] };
    const rows = this.sql
      .exec(
        `SELECT source, class_name, object_key
         FROM gmail_push_targets
         WHERE email_address = ?`,
        email
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
        const result = (await this.rpc.call(gmailTargetId(target), "onGmailPushNotification", [
          { emailAddress: email, historyId },
        ])) as { synced?: string[] } | undefined;
        for (const channelId of result?.synced ?? []) synced.add(channelId);
      } catch (err) {
        console.warn(
          `[GmailAgentWorker] push dispatch failed for ${email} -> ${gmailTargetId(target)}:`,
          err
        );
      }
    }
    return { synced: [...synced] };
  }

  @rpc({ principals: ["code"], effect: { kind: "open" }, tier: "open", sensitivity: "write" })
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
      throw new Error("registerPushTarget requires emailAddress, source, className, and objectKey");
    }
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_push_targets
       (email_address, source, class_name, object_key, registered_at)
       VALUES (?, ?, ?, ?, ?)`,
      email,
      source,
      className,
      objectKey,
      this.now()
    );
    return { registered: true };
  }

  @rpc({ principals: ["code"], effect: { kind: "open" }, tier: "open", sensitivity: "write" })
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
    if (!email || !source || !className || !objectKey) return { unregistered: false };
    const before = this.sql
      .exec(
        `SELECT COUNT(*) AS count FROM gmail_push_targets
         WHERE email_address = ? AND source = ? AND class_name = ? AND object_key = ?`,
        email,
        source,
        className,
        objectKey
      )
      .toArray()[0];
    this.sql.exec(
      `DELETE FROM gmail_push_targets
       WHERE email_address = ? AND source = ? AND class_name = ? AND object_key = ?`,
      email,
      source,
      className,
      objectKey
    );
    return { unregistered: Number(before?.["count"] ?? 0) > 0 };
  }

  /**
   * Gmail-router-dispatched Pub/Sub push: a new historyId exists for a mailbox.
   * Sync every channel bound to that address now; the follow-up alarm runs
   * the triage/wake pipeline.
   */
  @rpc({ principals: ["host", "code"], effect: { kind: "open" }, tier: "open", sensitivity: "write" })
  async onGmailPushNotification(payload: { emailAddress: string; historyId: string }): Promise<{
    synced: string[];
  }> {
    const caller = this.caller;
    const expectedRouter = gmailPushRouterTarget();
    if (!caller || caller.callerId !== expectedRouter) {
      throw new Error("onGmailPushNotification is only dispatched by the Gmail push router");
    }
    const email = String(payload?.emailAddress ?? "").toLowerCase();
    if (!email) return { synced: [] };
    const rows = this.sql
      .exec(
        `SELECT channel_id FROM gmail_channel_state WHERE lower(email_address) = ? AND sync_state != 'auth-needed'`,
        email
      )
      .toArray();
    const synced: string[] = [];
    for (const row of rows) {
      const channelId = String(row["channel_id"]);
      if (!this.subscriptions.getParticipantId(channelId)) continue;
      await this.ensureRecovered(channelId);
      const result = await this.syncEngine.syncChannel(channelId).catch(() => null);
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
          reason: reminder.note ? `Reminder: ${reminder.note}` : "Snoozed thread is due",
          actions: ["surface"],
        }
      );
    }
    const next = this.store.nextReminderAt();
    return next === undefined ? undefined : Math.max(next - now, 1000);
  }

  /** Run the batched LLM triage pass for every channel with queued candidates. */
  protected async processTriageQueues(): Promise<number | undefined> {
    let nextDelay: number | undefined;
    for (const channelId of this.store.channelsWithPendingCandidates()) {
      try {
        const { retryInMs } = await this.triage.runTriagePass(channelId);
        nextDelay = minDefined(nextDelay, retryInMs);
      } catch (err) {
        console.error(`[GmailAgentWorker] triage failed for channel=${channelId}:`, err);
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
          { mode: "sequential", steeringId: `gmail-attention-digest:${channelId}:${now}` }
        );
      }
    }
    return nextDelay;
  }

  override async onMethodCall(
    channelId: string,
    _transportCallId: string,
    methodName: string,
    args: unknown
  ): Promise<{ result: unknown; isError?: boolean }> {
    try {
      const standardResult = await this.handleStandardAgentMethodCall(channelId, methodName, args);
      if (standardResult) return standardResult;

      const op = this.operationIndex.get(methodName);
      if (!op) return { result: { error: `unknown method: ${methodName}` }, isError: true };
      if (op.needsRecovery) await this.ensureRecovered(channelId);
      const result = await op.run(this.operationContext, channelId, record(args));
      const isError = Boolean(
        result && typeof result === "object" && "error" in (result as Record<string, unknown>)
      );
      return isError ? { result, isError: true } : { result };
    } catch (err) {
      return { result: { error: err instanceof Error ? err.message : String(err) }, isError: true };
    }
  }

  // ── attention preference RPC (public Durable Object methods) ──────────────

  private assertSubscribedChannel(channelId: string): void {
    if (!channelId || !this.subscriptions.getParticipantId(channelId)) {
      throw new Error(`Gmail agent is not subscribed to channel: ${channelId}`);
    }
  }

  @rpc({ principals: ["host", "user", "code"], effect: { kind: "open" }, tier: "open", sensitivity: "read" })
  async getAttentionPrefs(channelId: string): Promise<GmailAttentionPrefs> {
    this.assertSubscribedChannel(channelId);
    return this.handlers.getAttentionPrefs(channelId);
  }

  @rpc({ principals: ["host", "user", "code"], effect: { kind: "open" }, tier: "open", sensitivity: "write" })
  async setAttentionPrefs(
    channelId: string,
    args: unknown
  ): Promise<{ saved: true; preferences: GmailAttentionPrefs }> {
    const caller = this.caller;
    if (caller && caller.callerKind !== "panel") {
      throw new Error("Attention preferences may only be changed by a user-facing panel");
    }
    this.assertSubscribedChannel(channelId);
    const input = record(args);
    const result = await this.handlers.setAttention(channelId, {
      preferences: stringArg(input, "preferences") ?? stringArg(input, "preferencesText"),
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
    if (!participantId) throw new Error(`Gmail agent is not subscribed to channel ${channelId}`);
    return {
      kind: "agent",
      id: participantId,
      participantId,
      displayName: "Gmail",
      metadata: { type: "agent", handle: "gmail", name: "Gmail" },
    };
  }

  private async installChannelUi(channelId: string): Promise<void> {
    await installMessageTypes({
      channel: this.createChannelClient(channelId),
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
      cards: this.cards,
      channelId,
      readFile: async (path) => {
        try {
          const raw = await this.fs.readFile(path, "utf8");
          return typeof raw === "string"
            ? raw
            : raw instanceof Uint8Array
              ? new TextDecoder().decode(raw)
              : null;
        } catch {
          return null;
        }
      },
    });
  }

  private async startSetupTurnIfNeeded(channelId: string): Promise<void> {
    const state = this.getChannelState(channelId);
    if (state.setupStatus === "configured" || state.setupPromptedAt) return;
    await this.submitAgentInitiatedTurn(
      channelId,
      { content: GMAIL_SETUP_ONBOARDING_PROMPT },
      {
        mode: "sequential",
        steeringId: `gmail-setup:${channelId}`,
      }
    );
    state.setupPromptedAt = Date.now();
    this.saveChannelState(state);
  }

  // ── setup card publishing ─────────────────────────────────────────────────

  /** Publish/refresh the gmail.setup card; deduped via last_setup_json. */
  private async publishSetupCard(channelId: string): Promise<void> {
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
      ...(state.lastSyncAt ? { lastSyncAt: new Date(state.lastSyncAt).toISOString() } : {}),
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
    await this.gmailCards.publishSetup(channelId, payload);
    const fresh = this.getChannelState(channelId);
    fresh.lastSetupJson = setupJson;
    this.saveChannelState(fresh);
  }

  // ── replay recovery ───────────────────────────────────────────────────────

  private async ensureRecovered(channelId: string): Promise<void> {
    if (this.recoveredChannels.has(channelId)) return;
    this.recoveredChannels.add(channelId);

    const folded = await this.indexOwnCustomMessages(channelId, (typeId) => {
      if (typeId === "gmail.thread") {
        return (state, update) => reduceGmailThread(state as GmailThreadState, update as never);
      }
      return undefined;
    });

    const setup = folded.get("gmail.setup");
    if (setup && setup.size > 0) {
      const messageId = [...setup.keys()][0]!;
      this.gmailCards.adoptRecoveredCard(channelId, SETUP_CARD_KEY, "gmail.setup", messageId);
    }

    for (const [messageId, value] of folded.get("gmail.thread") ?? []) {
      const thread = record(value);
      const threadId = typeof thread["threadId"] === "string" ? thread["threadId"] : undefined;
      if (!threadId) continue;
      this.gmailCards.adoptRecoveredCard(
        channelId,
        threadCardKey(threadId),
        "gmail.thread",
        messageId
      );
      const subject = typeof thread["subject"] === "string" ? thread["subject"] : "(no subject)";
      const from =
        Array.isArray(thread["participants"]) && typeof thread["participants"][0] === "string"
          ? thread["participants"][0]
          : "";
      const snippet =
        typeof thread["lastSnippet"] === "string"
          ? thread["lastSnippet"]
          : typeof thread["snippet"] === "string"
            ? thread["snippet"]
            : "";
      const unreadCount = typeof thread["unreadCount"] === "number" ? thread["unreadCount"] : 0;
      const status = typeof thread["status"] === "string" ? thread["status"] : "unread";
      const category = typeof thread["category"] === "string" ? thread["category"] : null;
      const actionable =
        Boolean(thread["actionable"]) ||
        (unreadCount > 0 &&
          status !== "archived" &&
          !["Promotions", "Social", "Updates", "Forums"].includes(category ?? ""));
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
        Date.now()
      );
    }
  }
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
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
