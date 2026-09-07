/**
 * AgentVesselBase (WS1 §2.7) — the thin, event-sourced agent vessel.
 *
 * Replaces TrajectoryVesselBase (8,662 lines). Composition only:
 *
 *   DOIdentity + SubscriptionManager + ChannelClient   — transport plumbing
 *   FeedbackIngest + CardManager                       — UX surfaces (unchanged)
 *   AgentLoopDriver (+ pure @workspace/agent-loop)     — ALL turn semantics
 *
 * Every durable decision lives in the trajectory log; this class only wires
 * ports (blobstore, credentials, local tools, channel calls) and translates
 * the DO surface (subscribe/envelope/methodCall/fork/alarm) into commands.
 */

import {
  type DurableObjectContext,
  type LifecyclePrepareInput,
  type LifecyclePrepareResult,
  type LifecycleResumeInput,
} from "@workspace/runtime/worker/durable-base";
import { PanelDurableObjectBase } from "@workspace/runtime/worker/panel-durable-base";
import { assertExactSqlTableSchema } from "@workspace/runtime/worker/sql-table-schema";
import {
  RemoteRpcError,
  rpc,
  withCausalParent,
  type RpcClient,
} from "@vibestudio/rpc";
import { withExecutionAdmission } from "@vibestudio/rpc/internal";
import {
  createGadServiceClient,
  type DurableObjectServiceClient,
} from "@workspace/runtime/workerd-client";
import type {
  ChannelAgenticContext,
  ChannelReplayEnvelope,
  RegisterMessageTypeInput,
  RpcChannelMessage,
} from "@workspace/pubsub";
import { iterateChannelReplayAfterPages } from "@workspace/pubsub";
import {
  driveMerge,
  renderCompareReview,
  renderMergeReview,
} from "@workspace/harness/merge-driver";
import {
  composeSystemPrompt,
  type SystemPromptMode,
} from "@workspace/harness/system-prompt";
import {
  evalToolParameters,
  formatEvalResult,
  normalizeEvalToolSource,
  type EvalRunResult,
} from "@workspace/harness/tools/eval";
import { resolveToolFile } from "@workspace/harness/semantic-file-resolution";
import type {
  ChannelEvent,
  ParticipantDescriptor,
} from "@workspace/harness/types";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  agentToolFailureFromUnknown,
  hydrateStoredValueRefs,
  isRespondPolicy,
  participantRefFromActor,
  participantRefFromMetadata,
  renderAgentToolFailure,
  resolveShouldRespond,
  type ActorRef,
  type AgenticEvent,
  type AutomationDefinitionSnapshot,
  type CustomMessageDisplayMode,
  type ParticipantRef,
  type AddresseeDirectoryEntry,
  type AddresseeUserEntry,
  type ResolveAddresseeContext,
} from "@workspace/agentic-protocol";
import {
  canonicalJson,
  sha256HexSyncText,
  stableSha256Hex,
} from "@vibestudio/content-addressing";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import {
  createDeferredEvalExecutor,
  evalAuthorityInputSchema,
} from "@vibestudio/service-schemas/eval";
import {
  channelTrajectoryFor,
  commandIdForTrajectoryInvocation,
  logIdForChannel,
} from "@vibestudio/trajectory-identity";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";
import {
  createAgentEntity,
  createSubagentContext,
  initAgentFromTrajectoryFork,
  publishAgentTaskSeed,
  subscribeAgentToChannel,
} from "@workspace/agentic-core/agent-launch";
import { resolveAgentObservationConfig } from "@workspace/agentic-core";
import {
  subagentFirstTaskPrompt,
  subagentRuntimePrompt,
  type SubagentIdentity,
} from "@workspace/agentic-core/subagent-prompt";
import type { DoAlarmSchedule } from "@vibestudio/shared/doDispatcher";
import {
  MISSION_COMPLETION_PROTOCOL,
  missionCompletionResponse,
  missionExecutionImageDigest,
  type AutomationExecutorRunStatus,
  type MissionAgentAction,
  type MissionAuthorityPlanReference,
  type MissionAuthorityProjection,
  type MissionOperationIntent,
  type MissionRecord,
  type MissionTrigger,
} from "@vibestudio/automation/mission";
import type {
  ClaimRequest,
  ClaimSettlement,
  DurableWorkQueue,
  SettleRequest,
  WorkClaim,
} from "@vibestudio/shared/durableWork";
import { executeLocalTool } from "./local-tool-execution.js";
import {
  AGENT_INSPECTION_METHODS,
  isAgentInspectionMethod,
  type AgentInspectionMethod,
} from "@vibestudio/shared/agentInspection";

import {
  vcsMethods,
  type VcsIntegrationProjection,
  type VcsMergeInput,
  type VcsStateNodeRef,
} from "@vibestudio/service-schemas/vcs";
import { toCredentialConnectRequest } from "@workspace/model-catalog/providerConnect";
import {
  defaultPolicies,
  derivedTurnStatus,
  ids,
  type AgentLoopConfig,
  type AgentTurnMetadata,
  type EffectOutcome,
  type RespondPolicy,
  type RosterEntry,
  type StepPolicy,
  type ThinkingLevel,
} from "@workspace/agent-loop";
import {
  createModelCredentialSentinel,
  installUrlBoundModelFetchProxy,
} from "./model-fetch-proxy.js";
import { modelTransportRuntimeEvidence } from "./effect-executors/index.js";
import {
  assertAgentToolParametersSchema,
  prepareAgentToolArguments,
} from "./tool-arguments.js";

export interface AgentToolExecutionContext {
  readonly invocationId: string;
  /** Stable semantic command id derived from the exact causal invocation. */
  readonly commandId: string;
  /** Immutable caller bound to the exact trajectory invocation that caused the tool call. */
  readonly rpc: RpcClient;
}
import type {
  ConnectCredentialRequest,
  StoredCredentialSummary as ModelCredentialSummary,
} from "@workspace/runtime/credentials";
import { DOIdentity } from "./identity.js";
import { SubscriptionManager } from "./subscription-manager.js";
import {
  SubagentRunStore,
  type SubagentAgentKind,
  type SubagentRunRow,
} from "./subagent-runs.js";
import { ChannelClient } from "./channel-client.js";
import { FeedbackIngest } from "./feedback-ingest.js";
import { CardManager } from "./custom-cards.js";
import {
  AgentLoopDriver,
  ensureAgentLoopDriverSchema,
  type DriverDeps,
} from "./agent-loop-driver.js";
import {
  inspectEffectOutbox,
  outboxExternalId,
  parseOutboxExternalId,
} from "./effect-outbox.js";
import {
  CredentialApprovalDeferredError,
  CredentialPendingError,
  type EphemeralEmit,
  type ExecutorDeps,
} from "./effect-executors/index.js";
import {
  LOCAL_FALLBACK_MODEL_REF,
  LOCAL_MODELS_EXTENSION_ID,
  LOCAL_PROVIDER_ID,
  materializeModel,
  type LocalModelDescriptor,
  type MaterializedModel,
} from "./model-spec.js";

function authorityAcquisitionRequired(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    errorData?: { acquisition?: { ownerRuntimeId?: unknown } };
  };
  return (
    candidate.code === "EACQUIRE" &&
    typeof candidate.errorData?.acquisition?.ownerRuntimeId === "string"
  );
}

function authorityDecisionDenied(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = (
    error as {
      errorData?: { authorityFailure?: { reasonCode?: unknown } };
    }
  ).errorData?.authorityFailure;
  return failure?.reasonCode === "user-denied";
}

const DELTA_BATCH_MS = 100;
const MAX_BUFFERED_DELTA_EVENTS = 256;
const MAX_PENDING_SIGNAL_BATCHES = 4;
const CHANNEL_STATE_CACHE_MS = 5_000;
/** Final backstop cadence for undelivered deferred-eval cancel intents. The
 * primary triggers are lifecycle events (resume, retire); this alarm only
 * covers an EvalDO outage that outlives them. */
const EVAL_CANCEL_INTENT_RETRY_MS = 60_000;
const BLOB_TEXT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
/** ~256KB of serialized session entries before compaction — comfortably
 *  under modern model context windows while keeping plenty of recent
 *  history. Subclasses override getCompactionTriggerBytes for a tighter or
 *  model-sized budget. */
const DEFAULT_COMPACTION_TRIGGER_BYTES = 256 * 1024;
/** Subagent guardrails (overridable per-agent via config). Depth bounds the
 *  spawn chain; owned slots bound child contexts per supervisor. */
const DEFAULT_MAX_SUBAGENT_DEPTH = 3;
const DEFAULT_MAX_SUBAGENTS = 3;
const PARTICIPANT_HANDLE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const SUBAGENT_MERGE_PROTOCOL = "vibestudio.subagent-merge.v1";
const CHANNEL_ENVELOPE_RETRY_MS = 250;
const CHANNEL_ENVELOPE_MAX_RETRY_MS = 30_000;
const SUBAGENT_RUN_HANDLE_LENGTH = 24;

/** Tool-facing run handle. The canonical id is the spawning invocation id and
 *  can be extremely long; the store deliberately resolves this unique prefix,
 *  with or without its display ellipsis, with a small transcription tolerance. */
export function subagentRunHandle(runId: string): string {
  return runId.length > SUBAGENT_RUN_HANDLE_LENGTH
    ? `${runId.slice(0, SUBAGENT_RUN_HANDLE_LENGTH)}…`
    : runId;
}

/** The roster as the addressee resolver wants it. The loop's `RosterEntry`
 *  keeps the handle and the participant id beside the ref rather than inside
 *  it, so lift both in — otherwise `@handle` resolution never sees a handle. */
/**
 * `owner` resolves to the one person on this channel — and only when there is
 * exactly one.
 *
 * There is no separate channel-ownership fact in this build, and the roster is
 * the honest approximation: a single-human channel has an unambiguous owner. A
 * channel with several people does NOT, so `owner` fails closed there and the
 * agent is told to name whom it meant. Picking the first human would be exactly
 * the "tell the wrong person" failure the addressee model exists to prevent.
 */
function soleChannelUserId(
  roster: readonly ParticipantRef[],
): string | undefined {
  const users = roster.filter((entry) => entry.kind === "user");
  if (users.length !== 1) return undefined;
  const id = users[0]?.participantId ?? users[0]?.id ?? "";
  return id.startsWith("user:") ? id.slice("user:".length) : id || undefined;
}

function rosterParticipantRef(entry: RosterEntry): ParticipantRef {
  const handle =
    entry.handle ??
    (entry.ref.metadata as { handle?: unknown } | undefined)?.handle ??
    undefined;
  return {
    ...entry.ref,
    participantId: entry.ref.participantId ?? entry.participantId,
    ...(typeof handle === "string" && handle
      ? { metadata: { ...(entry.ref.metadata ?? {}), handle } }
      : {}),
  };
}

function subagentLaunchReceipt(
  run: Pick<SubagentRunRow, "runId" | "status">,
): string {
  const handle = subagentRunHandle(run.runId);
  if (run.status !== "starting" && run.status !== "running") {
    return `subagent ${handle} already exists with status ${run.status}`;
  }
  return (
    `subagent ${handle} is running in the background. Continue independent foreground work, ` +
    `or call suspend_turn({ reason: "waiting_for_background" }) if no foreground work remains. ` +
    `Do not inspect, read, or merge merely to wait; terminal delivery will resume you.`
  );
}

function subagentVcsCommandId(
  phase: "merge",
  run: Pick<SubagentRunRow, "runId" | "parentContextId" | "childContextId">,
  basis: Record<string, unknown>,
): string {
  return `subagent-${phase}:${stableSha256Hex({
    protocol: SUBAGENT_MERGE_PROTOCOL,
    runId: run.runId,
    parentContextId: run.parentContextId,
    childContextId: run.childContextId,
    basis,
  })}`;
}

function createSubagentVcsClient(rpcClient: RpcClient) {
  return createTypedServiceClient("vcs", vcsMethods, (_service, method, args) =>
    rpcClient.call("main", `vcs.${method}`, args),
  );
}

function semanticIntegrationFromProjection(
  projection: VcsIntegrationProjection,
) {
  const state =
    projection.remainingCoordinateCount === 0 && projection.concluded
      ? "complete"
      : projection.mergeableCoordinateCount > 0
        ? "integrating"
        : "needs-decision";
  return { state, ...projection };
}

function sameVcsStateNodeRef(left: unknown, right: VcsStateNodeRef): boolean {
  if (!left || typeof left !== "object") return false;
  const candidate = left as Record<string, unknown>;
  return right.kind === "event"
    ? candidate["kind"] === "event" && candidate["eventId"] === right.eventId
    : candidate["kind"] === "application" &&
        candidate["applicationId"] === right.applicationId;
}

function semanticIntegrationForRun(
  run: SubagentRunRow,
  projections: readonly VcsIntegrationProjection[] = [],
  currentWorkingHead?: VcsStateNodeRef,
): Record<string, unknown> {
  const live = run.sourceEventId
    ? projections.find(
        (entry) =>
          entry.source.kind === "event" &&
          entry.source.eventId === run.sourceEventId,
      )
    : undefined;
  if (live) return semanticIntegrationFromProjection(live);
  const receipt = run.semanticIntegrationSnapshot;
  const receiptSource = receipt?.["source"];
  if (
    receipt &&
    currentWorkingHead &&
    run.sourceEventId &&
    receiptSource &&
    typeof receiptSource === "object" &&
    (receiptSource as Record<string, unknown>)["kind"] === "event" &&
    (receiptSource as Record<string, unknown>)["eventId"] ===
      run.sourceEventId &&
    sameVcsStateNodeRef(receipt["asOfWorkingHead"], currentWorkingHead)
  ) {
    return receipt;
  }
  return { state: "unattempted", sourceEventId: run.sourceEventId };
}

/** The subset of an external subagent launch result the spawn path consumes.
 *  Typed inline to avoid a vessel→extension source dependency; the call goes
 *  through a configured provider namespace when one exists. */
interface ExternalSubagentLaunchResult {
  entityId: string;
  contextId: string;
  channelId: string;
  vesselRef: string;
  vesselEntityId: string;
  vesselParticipantId: string | null;
  launchId: string;
  /** Exact provider-owned generation used for runtime inspection and release. */
  generationId: string;
  pid?: number | null;
}

const EXTERNAL_SUBAGENT_KIND_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;

function normalizeSubagentAgentKind(value: unknown): SubagentAgentKind | null {
  if (value === undefined || value === null || value === "") return "pi";
  if (typeof value !== "string") return null;
  const kind = value.trim();
  if (kind === "pi") return "pi";
  return EXTERNAL_SUBAGENT_KIND_PATTERN.test(kind) ? kind : null;
}

function externalSubagentExtensionId(agentKind: SubagentAgentKind): string {
  return `@workspace-extensions/${agentKind}`;
}

function externalSubagentProviderSlot(
  agentKind: SubagentAgentKind,
): string | null {
  return agentKind === "claude-code" ? "claudeCode" : null;
}

const OBSERVABLE_SUBAGENT_CONFIG_KEYS = [
  "model",
  "thinkingLevel",
  "fastMode",
  "effort",
  "fallbackModel",
  "fallbackThinkingLevel",
  "fallbackOn",
  "fallbackScope",
  "approvalLevel",
  "respondPolicy",
  "permissionMode",
  "maxBudgetUsd",
] as const;

function observableSubagentLaunchConfig(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!value) return null;
  const selected = Object.fromEntries(
    OBSERVABLE_SUBAGENT_CONFIG_KEYS.flatMap((key) =>
      value[key] === undefined ? [] : [[key, value[key]]],
    ),
  );
  return Object.keys(selected).length > 0 ? selected : null;
}

export type ApprovalLevel = 0 | 1 | 2;

export type CustomMessageReducer = (state: unknown, update: unknown) => unknown;

export interface AgentSettings {
  model: string;
  thinkingLevel: ThinkingLevel;
  fastMode: boolean;
  fallbackModel?: string;
  fallbackThinkingLevel?: ThinkingLevel;
  fallbackOn?: string[];
  fallbackScope?: "unattended" | "all-turns";
  approvalLevel: ApprovalLevel;
  respondPolicy: RespondPolicy;
  respondFrom: string[];
}

/** Per-channel settings — a Ref-kind KV value; every model call journals the
 *  values it actually used in its request descriptor, so the audit trail is
 *  the log, not this pointer. */
interface StoredSettings extends Partial<AgentSettings> {}

const CONFIGURABLE_FALLBACK_FAILURE_CODES = new Set([
  "usage_limit_terminal",
  "quota_exhausted_terminal",
  "rate_limited_retryable",
  "provider_overloaded_retryable",
  "auth_or_credentials",
  "circuit_breaker_open_retryable",
  "unknown_retryable",
]);

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

function isFallbackOn(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (code) =>
        typeof code === "string" &&
        CONFIGURABLE_FALLBACK_FAILURE_CODES.has(code),
    )
  );
}

/**
 * The agent's settings record is PER-AGENT (channel-independent): one model,
 * thinking level, approval posture, respond policy, etc. for the agent across
 * every channel it joins. Membership is per-channel (the subscriptions table);
 * behavior config is not.
 */
const AGENT_SETTINGS_KEY = "agent:settings";

const MAX_CHANNEL_OBSERVATION_CHARS = 32_768;
const MAX_CHANNEL_OBSERVATION_PREVIEW_CHARS = 8_192;

export interface ChannelObservationInput {
  kind: "channel-observation";
  version: 1;
  source: {
    channelId: string;
    envelopeId: string;
    sequence?: number;
    payloadKind: string;
    timestamp: number;
    sender: ParticipantRef;
  };
  payload: unknown;
  truncated?: {
    originalChars: number;
    preview: string;
  };
}

/**
 * Resolve a per-agent `respondFrom` allowlist (handles and/or participant ids) to
 * THIS channel's participant ids, so "who I respond to" travels with the agent
 * across channels. An entry matching a participant's handle maps to that
 * participant's id; an entry that matches nothing is kept as-is (already an id).
 * Pure + exported for direct testing.
 */
export function resolveRespondFromHandles(
  respondFrom: readonly string[],
  participants: ReadonlyArray<{
    participantId: string;
    metadata?: Record<string, unknown> | null;
  }>,
): string[] {
  const handleToId = new Map<string, string>();
  for (const p of participants) {
    const handle = p.metadata?.["handle"];
    if (typeof handle === "string" && handle.length > 0)
      handleToId.set(handle, p.participantId);
  }
  return respondFrom.map((entry) => handleToId.get(entry) ?? entry);
}

function participantIdFromRef(ref: ParticipantRef): string {
  return ref.participantId ?? ref.id;
}

function configuredParticipantHandle(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;
  const handle = (config as Record<string, unknown>)["handle"];
  return typeof handle === "string" && handle.length > 0 ? handle : null;
}

function configuredWakePolicy(
  config: unknown,
): "every-envelope" | "explicit" | "manual" {
  if (!config || typeof config !== "object") return "every-envelope";
  const wakePolicy = (config as Record<string, unknown>)["wakePolicy"];
  return wakePolicy === "explicit" || wakePolicy === "manual"
    ? wakePolicy
    : "every-envelope";
}

function sanitizeParticipantHandlePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function deriveSubagentParticipantHandle(
  baseHandle: string,
  runId: string,
  objectKey?: string,
): string {
  if (objectKey && PARTICIPANT_HANDLE_PATTERN.test(objectKey)) return objectKey;

  const base = sanitizeParticipantHandlePart(baseHandle) || "agent";
  const suffixSource =
    sanitizeParticipantHandlePart(objectKey ?? runId) || "subagent";
  const suffix = suffixSource.slice(-16);
  const maxBaseLength = Math.max(1, 63 - suffix.length);
  const trimmedBase =
    base.slice(0, maxBaseLength).replace(/[-_]+$/g, "") || "agent";
  const candidate = `${trimmedBase}-${suffix}`;
  const handle = /^[a-zA-Z]/.test(candidate) ? candidate : `a-${candidate}`;
  return handle.slice(0, 64);
}

/**
 * Summarize a loop's folded turn state for `agent.describe()` — derived status +
 * the live pending-effect counts. Pure (given the folded `AgentState`) + exported
 * so it can be verified against a REAL folded loop state in the loop-driver tests.
 */
export function summarizeTurn(state: Parameters<typeof derivedTurnStatus>[0]): {
  status: ReturnType<typeof derivedTurnStatus>;
  lastSeq: number;
  pendingInvocations: number;
  pendingApprovals: number;
  pendingCredentialWaits: number;
} {
  return {
    status: derivedTurnStatus(state),
    lastSeq: state.lastSeq,
    pendingInvocations: Object.keys(state.pendingInvocations).length,
    pendingApprovals: Object.keys(state.pendingApprovals).length,
    pendingCredentialWaits: Object.keys(state.pendingCredentialWaits).length,
  };
}

export interface AgentPromptResources {
  workspacePrompt?: string;
  skillIndex?: string;
}

export interface AgentPromptOverride {
  systemPrompt?: string;
  systemPromptMode?: SystemPromptMode;
}

// Moved to @workspace/agentic-core so external launcher extensions render the
// same contract; re-exported here for local tests and downstream launchers.
export {
  subagentFirstTaskPrompt,
  subagentRuntimePrompt,
} from "@workspace/agentic-core/subagent-prompt";
export type { SubagentIdentity } from "@workspace/agentic-core/subagent-prompt";

type BrowserOpenMode = "internal" | "external";
type BrowserHandoffCallerKind = "app" | "panel" | "shell";
type ConnectCredentialEnvelope = {
  spec: ConnectCredentialRequest;
  handoffTarget: {
    callerId: string;
    callerKind: BrowserHandoffCallerKind;
  };
};

function isSystemPromptMode(value: unknown): value is SystemPromptMode {
  return (
    value === "append" || value === "replace" || value === "replace-vibestudio"
  );
}

function normalizeBrowserOpenMode(value: unknown): BrowserOpenMode {
  return value === "internal" ? "internal" : "external";
}

function normalizeBrowserHandoffTarget(input: {
  browserHandoffCallerId?: unknown;
  browserHandoffCallerKind?: unknown;
}): ConnectCredentialEnvelope["handoffTarget"] | null {
  const callerId = input.browserHandoffCallerId;
  const callerKind = input.browserHandoffCallerKind;
  if (typeof callerId !== "string" || callerId.length === 0) return null;
  if (callerKind !== "app" && callerKind !== "panel" && callerKind !== "shell")
    return null;
  return { callerId, callerKind };
}

/** Context handed to {@link AgentVesselBase.onChannelForked} after a clone. */
export interface ClonedChannelContext {
  /** Channel id the parent was subscribed to (the clone is NOT subscribed to it). */
  oldChannelId: string;
  /** Channel id the clone is about to be subscribed to. */
  newChannelId: string;
  forkPointPubsubId: number;
}

export interface AgentAlarmSource {
  id: string;
  nextWakeAt(): number | null;
  fire(now: number): Promise<void>;
}

export interface AgentInitiatedTurnOptions extends AgentTurnMetadata {
  steeringId?: string;
}

interface ChannelDeliveryInput {
  deliveryId: string;
  channelId: string;
  channelRef: { source: string; className: string; objectKey: string };
  participantId: string;
  subscriptionRevision: number;
  eventSequence: number;
  envelope: unknown;
  agenticContext: ChannelAgenticContext;
}

interface ChannelDeliveryOutcome {
  deliveryId: string;
  disposition: "processed" | "duplicate" | "declined";
  recipientExecutionStartedAt?: number;
}

const HOT_PATH_TRACE_RETENTION_LIMIT = 500;
const HOT_PATH_TRACE_SWEEP_INTERVAL = 64;

/** Result of the deferred-eval gate: parked, or a settled tool result whose
 * typed terminal fields flow unchanged into the trajectory invocation event. */
type DeferredEvalGateResult =
  | { deferred: true; reason: "external-result" }
  | {
      result: unknown;
      isError: boolean;
      terminalOutcome?: "infrastructure_error";
      terminalReasonCode?: string;
      failure?: ReturnType<typeof agentToolFailureFromUnknown>;
    };

export abstract class AgentVesselBase extends PanelDurableObjectBase {
  static override schemaVersion = 3;

  protected readonly identity: DOIdentity;
  protected readonly subscriptions: SubscriptionManager;
  protected readonly feedback: FeedbackIngest;
  protected readonly cards: CardManager;
  protected readonly subagentRuns: SubagentRunStore;
  /** Activation-local admission intents make concurrent sibling snapshots
   * accurate without advancing durable status before prompt admission. */
  private readonly admittingSubagentTerminals = new Map<
    string,
    "completed" | "failed" | "cancelled" | "abandoned"
  >();
  private _driver: AgentLoopDriver | null = null;
  private readonly localTools = new Map<string, Map<string, AgentTool>>();
  /** Deferred evals are child resources of the channel that started them. */
  private readonly deferredEvalRuns = new Map<string, Set<string>>();
  private readonly deferredEvalBackstopWarnings = new Set<string>();
  private readonly deltaBuffers = new Map<
    string,
    { events: AgenticEvent[]; timer: unknown }
  >();
  private readonly channelClients = new Map<string, ChannelClient>();
  private readonly channelConfigCache = new Map<
    string,
    { expiresAt: number; value: Record<string, unknown> | null }
  >();
  private readonly participantCache = new Map<
    string,
    {
      expiresAt: number;
      value: Array<{
        participantId: string;
        ref: ParticipantRef;
        metadata: Record<string, unknown>;
      }>;
    }
  >();
  private readonly blobTextCache = new Map<
    string,
    { value: string; bytes: number }
  >();
  private readonly blobTextReads = new Map<string, Promise<string | null>>();
  private blobTextCacheBytes = 0;
  private readonly alarmSources = new Map<string, AgentAlarmSource>();
  private readonly alarmDeadlines = new Map<string, number>();
  /** Derived scheduling state only; the durable trace rows remain authoritative. */
  private readonly hotPathTraceInsertsSinceSweep = new Map<string, number>();
  private readonly directMethodCalls = new Map<string, AbortController>();
  /**
   * In-flight `chat.callMethod` relays initiated on behalf of an EvalDO sandbox
   * (keyed by transportCallId). The agent issues the call via ChannelClient,
   * then the channel's durable invocation terminal — broadcast back to us, the
   * caller — settles the awaiting promise in settleChatOpCall. This is a
   * loop-independent pending-call mechanism (parallel to the loop's
   * effect-outbox channel_call path) so the eval relay can return the delivered
   * result synchronously to the RPC caller. */
  private readonly chatOpPendingCalls = new Map<
    string,
    {
      resolve: (value: { content: unknown }) => void;
      reject: (error: Error) => void;
      responderSessionId: string;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.prepareSchemaStorage();
    this.identity = new DOIdentity(this.sql);
    this.subscriptions = new SubscriptionManager(
      this.sql,
      (channelId) => this.createChannelClient(channelId),
      this.identity,
    );
    this.subagentRuns = new SubagentRunStore(this.sql);
    this.feedback = new FeedbackIngest(this.sql);
    this.cards = new CardManager({
      sql: this.sql,
      createChannelClient: (channelId) => this.createChannelClient(channelId),
      getParticipantId: (channelId) =>
        this.subscriptions.getParticipantId(channelId),
      getActor: () => ({ kind: "agent", id: this.participantId() }),
      getAgentId: () => this.objectKey,
    });
    this.prepareSchemaForActivation();
  }

  protected override afterSchemaReady(): void {
    this.registerAgentAlarmSource({
      id: "agent-loop-driver",
      nextWakeAt: () =>
        this._driver?.nextWakeAt() ?? this.driverNextWakeAtFromSql(),
      fire: async () => {
        await this.driver.reconcileForRecovery();
      },
    });
    this.registerAgentAlarmSource({
      id: "durable-work-recovery",
      nextWakeAt: () => this.nextDurableWorkRecoveryAt(),
      fire: async () => {
        const queues = this.readyDurableWorkQueues();
        if (queues.length > 0) this.markWorkReady(...queues);
      },
    });
    this.registerAgentAlarmSource({
      id: "deferred-eval-cancel",
      nextWakeAt: () => this.nextEvalCancelIntentWakeAt(),
      fire: async () => {
        await this.drainEvalCancelIntents();
      },
    });
  }

  protected createTables(): void {
    DOIdentity.createTables(this.sql);
    SubscriptionManager.createTables(this.sql);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_delivery_admissions (
        delivery_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        subscription_revision INTEGER NOT NULL,
        event_sequence INTEGER NOT NULL,
        envelope_json TEXT,
        agentic_context_json TEXT,
        state TEXT NOT NULL CHECK (state IN ('admitted', 'processed', 'declined')),
        outcome_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    const wakeQueueDefinition = this.sql
      .exec(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_wake_queue'`,
      )
      .toArray()[0]?.["sql"];
    if (
      typeof wakeQueueDefinition === "string" &&
      !wakeQueueDefinition.includes("'turn-recovery'")
    ) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `ALTER TABLE agent_wake_queue RENAME TO agent_wake_queue_before_turn_recovery`,
        );
        this.sql.exec(`
          CREATE TABLE agent_wake_queue (
            wake_id TEXT PRIMARY KEY,
            channel_id TEXT NOT NULL,
            wake_kind TEXT NOT NULL CHECK (wake_kind IN (
              'scheduled-model-resume',
              'turn-recovery',
              'subagent-terminal-publish',
              'subagent-cancel-settle'
            )),
            payload_json TEXT NOT NULL,
            prerequisite_delivery_id TEXT,
            idempotency_key TEXT NOT NULL UNIQUE,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER NOT NULL,
            lease_owner TEXT,
            lease_generation INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            last_attempt_at INTEGER,
            disposition TEXT NOT NULL DEFAULT 'ready'
              CHECK (disposition IN ('ready', 'leased', 'retrying', 'terminal-completed', 'terminal-poison'))
          )
        `);
        this.sql.exec(`
          INSERT INTO agent_wake_queue
          SELECT * FROM agent_wake_queue_before_turn_recovery
        `);
        this.sql.exec(`DROP TABLE agent_wake_queue_before_turn_recovery`);
      });
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_wake_queue (
        wake_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        wake_kind TEXT NOT NULL CHECK (wake_kind IN (
          'scheduled-model-resume',
          'turn-recovery',
          'subagent-terminal-publish',
          'subagent-cancel-settle'
        )),
        payload_json TEXT NOT NULL,
        prerequisite_delivery_id TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_generation INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_attempt_at INTEGER,
        disposition TEXT NOT NULL DEFAULT 'ready'
          CHECK (disposition IN ('ready', 'leased', 'retrying', 'terminal-completed', 'terminal-poison'))
      )
    `);
    assertExactSqlTableSchema(this.sql, {
      table: "agent_wake_queue",
      columns: [
        ["wake_id", "TEXT", false],
        ["channel_id", "TEXT", true],
        ["wake_kind", "TEXT", true],
        ["payload_json", "TEXT", true],
        ["prerequisite_delivery_id", "TEXT", false],
        ["idempotency_key", "TEXT", true],
        ["attempts", "INTEGER", true, "0"],
        ["next_attempt_at", "INTEGER", true],
        ["lease_owner", "TEXT", false],
        ["lease_generation", "INTEGER", true, "0"],
        ["created_at", "INTEGER", true],
        ["last_attempt_at", "INTEGER", false],
        ["disposition", "TEXT", true, "'ready'"],
      ],
      primaryKey: ["wake_id"],
    });
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_wake_claim
        ON agent_wake_queue(disposition, next_attempt_at, channel_id, created_at)
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_hot_path_trace (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        source TEXT,
        item_id TEXT,
        generation INTEGER,
        started_at INTEGER NOT NULL,
        duration_ms INTEGER,
        details_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_hot_path_trace_channel
        ON agent_hot_path_trace(channel_id, sequence)
    `);
    SubagentRunStore.createTables(this.sql);
    FeedbackIngest.createTables(this.sql);
    CardManager.createTables(this.sql);
    ensureAgentLoopDriverSchema(this.sql);
    // Durable cancel intents for deferred eval runs: recorded before
    // unsubscribe/retire proceeds, deleted only on an acknowledged
    // eval.cancel, redriven by lifecycle events + the backstop alarm.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS deferred_eval_cancel_intents (
        channel_id       TEXT NOT NULL,
        run_id           TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        attempts         INTEGER NOT NULL DEFAULT 0,
        next_attempt_at  INTEGER NOT NULL,
        PRIMARY KEY (channel_id, run_id)
      )
    `);
    assertExactSqlTableSchema(this.sql, {
      table: "deferred_eval_cancel_intents",
      columns: [
        ["channel_id", "TEXT", true],
        ["run_id", "TEXT", true],
        ["created_at", "INTEGER", true],
        ["attempts", "INTEGER", true, "0"],
        ["next_attempt_at", "INTEGER", true],
      ],
      primaryKey: ["channel_id", "run_id"],
    });
  }

  protected override requiredTables(): readonly string[] {
    return [
      "do_identity",
      "subscriptions",
      "channel_delivery_admissions",
      "agent_wake_queue",
      "agent_hot_path_trace",
      "subagent_runs",
      "feedback_seen",
      "pending_feedback",
      "custom_cards",
      "effect_outbox",
      "fold_cache",
      "scheduled_model_resumes",
      "model_execution_attempts",
      "model_execution_attempt_diagnostics",
      "deferred_eval_cancel_intents",
    ];
  }

  protected override durableWorkQueues(): readonly DurableWorkQueue[] {
    return ["agent-wake", "agent-effect"];
  }

  protected override releaseDurableWorkClaims(
    previousWorkerId: string | null,
    _nextWorkerId: string,
  ): void {
    if (!previousWorkerId) return;
    const now = Date.now();
    this.sql.exec(
      `UPDATE agent_wake_queue
          SET disposition = 'ready',
              lease_owner = NULL,
              next_attempt_at = ?
        WHERE disposition = 'leased' AND lease_owner = ?`,
      now,
      previousWorkerId,
    );
    try {
      this.sql.exec(
        `UPDATE effect_outbox
            SET disposition = 'ready',
                lease_owner = NULL,
                next_attempt_at = ?
          WHERE disposition = 'leased' AND lease_owner = ?`,
        now,
        previousWorkerId,
      );
    } catch {
      // Effect storage is lazy.
    }
  }

  protected traceHotPath(
    channelId: string,
    phase: string,
    input: {
      startedAt?: number;
      source?: string;
      itemId?: string;
      generation?: number;
      details?: Record<string, string | number | boolean | null>;
    } = {},
  ): void {
    const now = Date.now();
    const startedAt = input.startedAt ?? now;
    this.sql.exec(
      `INSERT INTO agent_hot_path_trace (
         channel_id, phase, source, item_id, generation,
         started_at, duration_ms, details_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      channelId,
      phase,
      input.source ?? null,
      input.itemId ?? null,
      input.generation ?? null,
      startedAt,
      input.startedAt === undefined ? null : Math.max(0, now - startedAt),
      JSON.stringify(input.details ?? {}),
    );
    const insertsSinceSweep =
      (this.hotPathTraceInsertsSinceSweep.get(channelId) ??
        HOT_PATH_TRACE_SWEEP_INTERVAL - 1) + 1;
    if (insertsSinceSweep < HOT_PATH_TRACE_SWEEP_INTERVAL) {
      this.hotPathTraceInsertsSinceSweep.set(channelId, insertsSinceSweep);
      return;
    }
    this.sql.exec(
      `DELETE FROM agent_hot_path_trace
        WHERE channel_id = ?
          AND sequence NOT IN (
            SELECT sequence FROM agent_hot_path_trace
             WHERE channel_id = ?
             ORDER BY sequence DESC
             LIMIT ${HOT_PATH_TRACE_RETENTION_LIMIT}
          )`,
      channelId,
      channelId,
    );
    this.hotPathTraceInsertsSinceSweep.set(channelId, 0);
  }

  private hotPathTrace(channelId: string): Array<Record<string, unknown>> {
    return (
      this.sql
        .exec(
          `SELECT sequence, phase, source, item_id, generation,
                  started_at, duration_ms, details_json
             FROM agent_hot_path_trace
            WHERE channel_id = ?
            ORDER BY sequence`,
          channelId,
        )
        .toArray() as Array<Record<string, unknown>>
    ).map((row) => ({
      sequence: Number(row["sequence"]),
      phase: String(row["phase"]),
      ...(row["source"] == null ? {} : { source: String(row["source"]) }),
      ...(row["item_id"] == null ? {} : { itemId: String(row["item_id"]) }),
      ...(row["generation"] == null
        ? {}
        : { generation: Number(row["generation"]) }),
      startedAt: Number(row["started_at"]),
      ...(row["duration_ms"] == null
        ? {}
        : { durationMs: Number(row["duration_ms"]) }),
      details: JSON.parse(String(row["details_json"])),
    }));
  }

  override async releaseForLifecycle(
    input: LifecyclePrepareInput,
  ): Promise<LifecyclePrepareResult> {
    const releasedEffects = this._driver
      ? await this._driver.releaseActivation()
      : 0;
    if (input.mode === "retire") {
      const abandonedSubagents = await this.abandonLiveSubagentsForRetirement();
      const channelIds = this.subscriptions.listChannelIds();
      for (const channelId of channelIds)
        await this.unsubscribeChannel(channelId);
      return {
        status: "ready",
        detail: {
          mode: input.mode,
          releasedEffects,
          retiredSubscriptions: channelIds.length,
          abandonedSubagents,
        },
      };
    }
    return {
      status: "ready",
      detail: { mode: input.mode, releasedEffects },
    };
  }

  /** Retirement is the final owner of every live child obligation. Fence each
   * child first, then publish the supervisor-authored durable terminal while
   * the parent is still subscribed to both channels. A partial failure keeps
   * retirement uncommitted; retrying is idempotent at both boundaries. */
  private async abandonLiveSubagentsForRetirement(): Promise<number> {
    let abandoned = 0;
    for (const run of this.subagentRuns.listLive()) {
      const reason = "supervisor retired";
      if (run.externalSessionEntityId && run.externalGenerationId) {
        const agentKind = normalizeSubagentAgentKind(run.agentKind);
        if (!agentKind || agentKind === "pi") {
          throw new Error(
            `retire: invalid external agent kind ${run.agentKind}`,
          );
        }
        const providerSlot = externalSubagentProviderSlot(agentKind);
        await this.rpc.call(
          "main",
          providerSlot ? "extensions.invokeProvider" : "extensions.invoke",
          [
            providerSlot ?? externalSubagentExtensionId(agentKind),
            "release",
            [
              {
                entityId: run.externalSessionEntityId,
                generationId: run.externalGenerationId,
              },
            ],
          ],
        );
      } else {
        await this.rpc.call(run.childEntityId, "retireSubagentExecution", [
          { runId: run.runId, taskChannelId: run.taskChannelId, reason },
        ]);
      }
      await this.settleSubagentTerminal(run, "abandoned", reason);
      abandoned += 1;
    }
    return abandoned;
  }

  override async resumeAfterRestart(
    input: LifecycleResumeInput,
  ): Promise<void> {
    await super.resumeAfterRestart(input);
    // Eval terminal delivery was activation-local. Re-observe every parked
    // eval through its deterministic run id now, instead of waiting for the
    // periodic lost-push reconciliation cadence.
    this.driver.reconcileDeferredEvalRuns();
    // Cancel intents recorded while EvalDO was unavailable redrive on this
    // lifecycle event (the alarm remains only as the final backstop).
    await this.drainEvalCancelIntents();
  }

  // ── Subclass surface (WS1 §3.2 — names preserved where semantics survive) ─

  protected getDefaultModel(): string {
    return "anthropic:claude-sonnet-4-6";
  }
  protected getDefaultThinkingLevel(): ThinkingLevel {
    return "medium";
  }
  protected getDefaultApprovalLevel(): ApprovalLevel {
    return 2;
  }
  protected getDefaultRespondPolicy(): RespondPolicy {
    return "mentioned-or-followup";
  }
  protected getDefaultRespondFrom(): string[] {
    return [];
  }
  /** Idle-history byte budget that triggers compaction. Subclasses with a
   *  known model context window should override this to ~0.7× the window
   *  (in serialized-entry bytes). */
  protected getCompactionTriggerBytes(): number {
    return DEFAULT_COMPACTION_TRIGGER_BYTES;
  }

  /** Channel publication discipline (WS-4 `publishPolicy` StepPolicy). Default
   *  agents publish everything (`undefined` ⇒ "all"); the silent agent overrides
   *  this to "notify-only" (the old `silentPolicy` behavior). */
  protected getPublishPolicy(
    _channelId: string,
  ): "all" | "turn-final" | "notify-only" | "say-only" | undefined {
    return undefined;
  }

  /** Max subagent nesting depth enforced at spawn. */
  protected getMaxSubagentDepth(): number {
    return DEFAULT_MAX_SUBAGENT_DEPTH;
  }

  /** Maximum concurrent child executions; terminal results are retained outside this count. */
  protected getMaxSubagents(): number {
    return DEFAULT_MAX_SUBAGENTS;
  }

  protected abstract getParticipantInfo(
    channelId: string,
    config?: unknown,
  ): ParticipantDescriptor;

  protected getEffectiveParticipantInfo(
    channelId: string,
    config?: unknown,
  ): ParticipantDescriptor {
    const declared = this.getParticipantInfo(channelId, config);
    // The agent's own one-line self-description (`set_description`) rides the
    // roster metadata: it is what the workspace directory shows and searches
    // (messaging plan §4.4, D9), and it survives rejoin because it lives here.
    const description = this.agentDescription(channelId);
    const base: ParticipantDescriptor = description
      ? { ...declared, metadata: { ...(declared.metadata ?? {}), description } }
      : declared;
    const subagent = this.subagentIdentity();
    if (!subagent) return base;
    // The run identity rides on the roster metadata so the workspace agent
    // directory can carry lineage (messaging plan §4.4) without a second writer.
    const descriptor: ParticipantDescriptor = {
      ...base,
      metadata: { ...(base.metadata ?? {}), subagentRunId: subagent.runId },
    };

    const configuredHandle = configuredParticipantHandle(config);
    if (configuredHandle) return { ...descriptor, handle: configuredHandle };

    let objectKey: string | undefined;
    try {
      objectKey = this.objectKey;
    } catch {
      objectKey = undefined;
    }
    return {
      ...descriptor,
      handle: deriveSubagentParticipantHandle(
        descriptor.handle,
        subagent.runId,
        objectKey,
      ),
    };
  }

  /** The self-description this agent set for a channel, if any. */
  protected agentDescription(channelId: string): string | null {
    try {
      const value = this.getStateValue(`agent:description:${channelId}`);
      return typeof value === "string" && value.trim() ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * Set (or clear) this agent's self-description on a channel and revise its
   * roster metadata so the directory reflects it now — not on the next join.
   */
  protected async setAgentDescription(
    channelId: string,
    description: string | null,
  ): Promise<void> {
    if (description)
      this.setStateValue(`agent:description:${channelId}`, description);
    else this.deleteStateValue(`agent:description:${channelId}`);
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const descriptor = this.getEffectiveParticipantInfo(
      channelId,
      this.subscriptions.getConfig(channelId),
    );
    await this.createChannelClient(channelId).updateMetadata(participantId, {
      name: descriptor.name,
      type: descriptor.type,
      handle: descriptor.handle,
      ...(descriptor.metadata ?? {}),
      ...(descriptor.methods?.length ? { methods: descriptor.methods } : {}),
    });
  }

  private subscriptionContextOrNull(channelId: string): string | null {
    try {
      return this.subscriptions.getContextId(channelId);
    } catch {
      return null;
    }
  }

  /** Workspace-level prompt resources. Workspace agents load AGENTS.md and the
   *  skill index here; non-workspace agents may return nothing. */
  protected loadPromptResources(
    _channelId: string,
  ): AgentPromptResources | Promise<AgentPromptResources> {
    return {};
  }

  /** Clears any prompt resource cache owned by a subclass. */
  protected invalidatePromptResources(_channelId?: string): void {}

  /** Agent-class behavior prompt, such as a Gmail-specific role. */
  protected getAgentPrompt(_channelId: string): string | undefined {
    return undefined;
  }

  /** Per-subscription user/workspace override. */
  protected getPromptOverride(channelId: string): AgentPromptOverride {
    const config = this.subscriptions.getConfig(channelId);
    const override: AgentPromptOverride = {};
    if (typeof config?.systemPrompt === "string") {
      override.systemPrompt = config.systemPrompt;
    }
    const systemPromptMode = config?.systemPromptMode;
    if (isSystemPromptMode(systemPromptMode)) {
      override.systemPromptMode = systemPromptMode;
    }
    return override;
  }

  /** Final system prompt text for a channel (blob-spilled; its hash rides every
   *  model request descriptor). Keep run-specific volatile instructions out of
   *  this path so provider prompt-cache keys stay stable. */
  protected async composePrompt(channelId: string): Promise<string> {
    const resources = await this.loadPromptResources(channelId);
    const agentPrompt = this.getAgentPrompt(channelId);
    const override = this.getPromptOverride(channelId);
    const composed = composeSystemPrompt({
      ...(resources.workspacePrompt !== undefined
        ? { workspacePrompt: resources.workspacePrompt }
        : {}),
      ...(resources.skillIndex !== undefined
        ? { skillIndex: resources.skillIndex }
        : {}),
      ...(agentPrompt !== undefined ? { agentPrompt } : {}),
      ...(override.systemPrompt !== undefined
        ? { systemPrompt: override.systemPrompt }
        : {}),
      ...(override.systemPromptMode !== undefined
        ? { systemPromptMode: override.systemPromptMode }
        : {}),
    });
    const subagent = this.subagentIdentity();
    return [composed, subagent ? subagentRuntimePrompt(subagent) : ""]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Local tools registered with the local-tool executor. */
  protected getLoopTools(
    _channelId: string,
    _execution?: AgentToolExecutionContext,
  ): AgentTool[] | Promise<AgentTool[]> {
    return [];
  }

  /**
   * Provider-side enforcement for channel participant methods. Descriptors are
   * discovery/UI metadata; subclasses with a reduced control surface must also
   * close the method at the receiver.
   */
  protected isParticipantMethodEnabled(_methodName: string): boolean {
    return true;
  }

  /** Whether this vessel exposes workspace-history search to the model. */
  protected includeMemoryRecallTool(): boolean {
    return true;
  }

  /** Step policies composed onto the pure loop (silent agents, card flows…). */
  protected getStepPolicies(_channelId: string): StepPolicy[] {
    return defaultPolicies();
  }

  /** Test seam: replace effect executors (e.g. inject a scripted model so a
   *  full turn can be driven without a live model). Production returns
   *  undefined — the real executors run. */
  protected getDriverExecutorOverride(): DriverDeps["executorOverride"] {
    return undefined;
  }

  /** Roster method names this agent expects (warning surface only). */
  protected getExpectedChannelToolNames(_channelId: string): readonly string[] {
    return [];
  }

  /** Hook before addressing — return true to swallow the event. */
  protected async onChannelEvent(
    _channelId: string,
    _event: ChannelEvent,
  ): Promise<boolean> {
    return false;
  }

  /** Build the bounded, model-facing form of an opted-in non-chat envelope. */
  protected resolveChannelObservation(
    channelId: string,
    event: ChannelEvent,
  ): ChannelObservationInput | null {
    const serializedPayload = canonicalJson(event.payload);
    const source: ChannelObservationInput["source"] = {
      channelId,
      envelopeId: event.messageId,
      ...(Number.isFinite(event.id) ? { sequence: event.id } : {}),
      payloadKind: event.type,
      timestamp: event.ts,
      sender: participantRefFromMetadata(event.senderId, event.senderMetadata),
    };
    if (serializedPayload.length <= MAX_CHANNEL_OBSERVATION_CHARS) {
      return {
        kind: "channel-observation",
        version: 1,
        source,
        payload: event.payload,
      };
    }
    return {
      kind: "channel-observation",
      version: 1,
      source,
      payload: null,
      truncated: {
        originalChars: serializedPayload.length,
        preview: serializedPayload.slice(
          0,
          MAX_CHANNEL_OBSERVATION_PREVIEW_CHARS,
        ),
      },
    };
  }

  protected getModelCredentialSetupProps(
    _providerId: string,
  ): Record<string, unknown> | null {
    return null;
  }

  /** Provider claims baked into the JWT-shaped sentinel apiKey (e.g.
   *  openai-codex's chatgpt_account_id). Subclass hook; default none. */
  protected getModelCredentialTokenClaims(
    _providerId: string,
    _credential: ModelCredentialSummary,
  ): Record<string, unknown> {
    return {};
  }

  /** Fork hook. The clone has been re-identified and its subscription renamed
   *  old→new, but the new channel is not yet (re)subscribed. Subclasses purge
   *  or migrate the per-channel state the clone copied wholesale from the
   *  parent here — and may set flags that the subsequent subscribeChannel
   *  reads. Without this, any agent that keys SQLite by channelId or runs a
   *  per-channel scheduler would have the clone act on a channel it no longer
   *  holds a subscription on. */
  protected async onChannelForked(_ctx: ClonedChannelContext): Promise<void> {}

  // ── Wiring ────────────────────────────────────────────────────────────────

  protected createChannelClient(channelId: string): ChannelClient {
    let client = this.channelClients.get(channelId);
    if (!client) {
      client = new ChannelClient(this.rpc, channelId);
      this.channelClients.set(channelId, client);
    }
    return client;
  }

  private _identityBootstrapped = false;
  private _durableWorkActivationRecovered = false;
  private _durableWorkActivationRecovery: Promise<void> | null = null;

  /** Bootstrap identity from the canonical workerd environment. */
  protected ensureIdentity(): void {
    if (this._identityBootstrapped) return;
    const env = this.env as Record<string, string>;
    const source = env["WORKER_SOURCE"];
    const className = env["WORKER_CLASS_NAME"];
    const sessionId = env["WORKERD_SESSION_ID"];
    if (!source || !className || !sessionId) {
      throw new Error(
        "Agent vessel identity requires WORKER_SOURCE, WORKER_CLASS_NAME, and WORKERD_SESSION_ID",
      );
    }
    const generationRaw = env["WORKERD_BOOT_GENERATION"];
    const generation =
      typeof generationRaw === "string" && generationRaw.length > 0
        ? Number.parseInt(generationRaw, 10)
        : null;
    this.identity.bootstrap(
      { source, className, objectKey: this.objectKey },
      sessionId,
      Number.isFinite(generation) ? generation : null,
    );
    this._identityBootstrapped = true;
  }

  protected participantId(): string {
    this.ensureIdentity();
    const ref = this.identity.ref;
    return `do:${ref.source}:${ref.className}:${ref.objectKey}`;
  }

  protected selfRef(channelId: string): ParticipantRef {
    const descriptor = this.getEffectiveParticipantInfo(
      channelId,
      this.subscriptions.getConfig(channelId),
    );
    return {
      kind: "agent",
      id: this.participantId(),
      participantId: this.participantId(),
      displayName: descriptor.name,
      metadata: {
        type: descriptor.type,
        name: descriptor.name,
        handle: descriptor.handle,
      },
    };
  }

  /** Cognitive ancestry is narrower than channel membership: only a forked
   * child's parent chain owns its inherited assistant/tool protocol history. */
  private lineageSelfIds(channelId: string): string[] {
    const subagent = this.subagentIdentity();
    if (subagent?.mode !== "fork" || subagent.taskChannelId !== channelId) {
      return [];
    }
    return [
      ...new Set([
        ...(subagent.lineageParticipantIds ?? []),
        subagent.parentParticipantId,
      ]),
    ];
  }

  protected get driver(): AgentLoopDriver {
    this._driver ??= new AgentLoopDriver({
      sql: this.sql,
      gad: {
        call: <T>(method: string, args: Record<string, unknown>) =>
          this.callGad<T>(method, args),
      },
      executorDeps: this.executorDeps(),
      selfRefFor: (channelId) => this.selfRef(channelId),
      lineageSelfIdsFor: (channelId) => this.lineageSelfIds(channelId),
      configFor: (channelId) => this.loopConfig(channelId),
      policiesFor: (channelId) => this.getStepPolicies(channelId),
      onEphemeral: (emit) => this.emitEphemeral(emit),
      onTurnClosed: (input) => this.onTurnClosed(input),
      now: () => Date.now(),
      // Idle-history budget before a fold-shrinking compaction. Kept well
      // below typical model context windows so context never grows to the
      // model's hard limit (the deleted CompactionTrigger used ~0.8× the
      // window); a subclass can tune via getCompactionTriggerBytes.
      compaction: { triggerBytes: this.getCompactionTriggerBytes() },
      scheduleAlarm: (at) => {
        this.scheduleAgentAlarm(
          "agent-loop-driver",
          Math.max(at, Date.now() + 50),
        );
      },
      notifyWorkReady: () => this.markWorkReady("agent-effect"),
      commitTerminalOutcome: async (input, commitLocal) => {
        const wakeId = `turn-recovery:${outboxExternalId(input.branchId, input.effectId)}`;
        const now = Date.now();
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(
            `INSERT OR IGNORE INTO agent_wake_queue (
               wake_id, channel_id, wake_kind, payload_json, prerequisite_delivery_id,
               idempotency_key, attempts, next_attempt_at, lease_generation, created_at,
               disposition
             ) VALUES (?, ?, 'turn-recovery', '{}', NULL, ?, 0, ?, 0, ?, 'ready')`,
            wakeId,
            input.channelId,
            wakeId,
            now,
            now,
          );
          commitLocal();
        });
        this.markWorkReady("agent-wake");
        // Persist the recovery edge before continuing the remote-log cascade.
        // This request may be the last code the current activation executes.
        await this.persistAlarmSchedule({ wakeAt: now });
      },
      clearTerminalOutcomeRecovery: (input) => {
        this.sql.exec(
          `DELETE FROM agent_wake_queue WHERE wake_id = ? AND disposition = 'ready'`,
          `turn-recovery:${outboxExternalId(input.branchId, input.effectId)}`,
        );
      },
      executorOverride: this.getDriverExecutorOverride(),
    });
    this._driver.connectSpecProvider = async (providerId) =>
      this.getModelCredentialSetupProps(providerId) ?? { providerId };
    return this._driver;
  }

  protected async onTurnClosed(input: {
    channelId: string;
    turnId: string;
    metadata: AgentTurnMetadata;
    reason?: string;
    summary?: string;
    finalMessage?: string;
    effectFailures: Array<{
      invocationId: string;
      name: string;
      outcome:
        | "tool_error"
        | "infrastructure_error"
        | "cancelled"
        | "stale_dispatch"
        | "abandoned";
      code: string;
      message: string;
    }>;
  }): Promise<void> {
    const subagent = this.subagentIdentity();
    if (
      subagent &&
      subagent.taskChannelId === input.channelId &&
      !this.subagentTerminalIntentRecorded(subagent.runId)
    ) {
      const failed = Boolean(
        input.reason && input.reason !== "tool_terminated",
      );
      const primaryFailure = input.effectFailures[0];
      const failureReport = primaryFailure
        ? `${primaryFailure.name} failed (${primaryFailure.code}): ${primaryFailure.message}`
        : undefined;
      const report =
        input.finalMessage?.trim() ||
        failureReport ||
        input.summary?.trim() ||
        (failed ? input.reason : undefined);
      if (report) {
        await this.recordOwnSubagentTerminalIntent(
          subagent,
          report,
          failed ? "failed" : "completed",
        );
      }
      return;
    }
    const runId = input.metadata.automation?.runId;
    if (!runId) return;
    const service = await this.rpc.call<{
      kind: "durable-object" | "worker";
      targetId?: string;
    }>("main", "workers.resolveService", ["vibestudio.missions.v1"]);
    if (service.kind !== "durable-object" || !service.targetId) {
      throw new Error("The automation ledger must resolve to a Durable Object");
    }
    const failed = Boolean(input.reason && input.reason !== "tool_terminated");
    const completionKey = automationCompletionStateKey(runId);
    const recordedCompletion = automationCompletionForTurn(
      this.getStateValue(completionKey),
      input.channelId,
      input.turnId,
    );
    const evalCompletion =
      !failed && input.metadata.automation?.action === "eval"
        ? automationCompletionFromEvalSummary(input.summary)
        : null;
    const completionResponse =
      recordedCompletion?.response ?? evalCompletion?.response;
    const outcome = failed
      ? "failed"
      : input.effectFailures.length > 0
        ? "completed-with-errors"
        : "succeeded";
    const terminal: Extract<
      AutomationExecutorRunStatus,
      { state: "terminal" }
    > = {
      state: "terminal",
      channelId: input.channelId,
      turnId: input.turnId,
      outcome,
      ...(input.finalMessage
        ? { finalMessage: input.finalMessage }
        : !failed && completionResponse
          ? { finalMessage: completionResponse }
          : !failed && input.summary
            ? { finalMessage: input.summary }
            : {}),
      ...(!failed && completionResponse ? { completionResponse } : {}),
      ...(input.effectFailures.length > 0
        ? { effectFailures: input.effectFailures }
        : {}),
      ...(failed
        ? {
            failure: {
              code: "EAGENTTURN",
              stage: "executing",
              message:
                input.summary ?? input.reason ?? "Automation turn failed",
              retry: "manual" as const,
            },
          }
        : {}),
    };
    // The receiver records terminal truth before the cross-object callback.
    // If the callback or its response is lost, MissionsDO can reconcile this
    // exact result instead of guessing from elapsed time or redispatching.
    this.setStateValue(
      automationRunReceiptKey(runId),
      JSON.stringify(terminal),
    );
    await this.rpc.call(service.targetId, "finishRun", [
      {
        runId,
        outcome: terminal.outcome,
        ...(terminal.finalMessage
          ? { finalMessage: terminal.finalMessage }
          : {}),
        ...(terminal.completionResponse
          ? { completionResponse: terminal.completionResponse }
          : {}),
        ...(terminal.failure ? { failure: terminal.failure } : {}),
        ...(terminal.effectFailures
          ? { effectFailures: terminal.effectFailures }
          : {}),
      },
    ]);
    if (recordedCompletion) this.deleteStateValue(completionKey);
  }

  protected registerAgentAlarmSource(source: AgentAlarmSource): void {
    this.alarmSources.set(source.id, source);
    const next = source.nextWakeAt();
    if (next === null) {
      this.alarmDeadlines.delete(source.id);
    } else {
      this.alarmDeadlines.set(source.id, next);
    }
  }

  protected unregisterAgentAlarmSource(sourceId: string): void {
    this.alarmSources.delete(sourceId);
    this.alarmDeadlines.delete(sourceId);
  }

  protected scheduleAgentAlarm(sourceId: string, timeMs: number): void {
    if (!Number.isFinite(timeMs)) return;
    this.alarmDeadlines.set(
      sourceId,
      Math.max(Math.round(timeMs), Date.now() + 1),
    );
  }

  protected clearAgentAlarm(sourceId: string): void {
    this.alarmDeadlines.delete(sourceId);
  }

  protected nextAgentAlarmSchedule(): DoAlarmSchedule | null {
    for (const source of this.alarmSources.values()) {
      const next = source.nextWakeAt();
      if (next === null) this.alarmDeadlines.delete(source.id);
      else this.alarmDeadlines.set(source.id, next);
    }
    const deadlines = [
      ...this.alarmDeadlines.values(),
      this.nextDurableWorkReadyEdgeAt(),
    ].filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value >= 0,
    );
    return deadlines.length === 0 ? null : { wakeAt: Math.min(...deadlines) };
  }

  protected override nextAlarmAfterRequest(): DoAlarmSchedule | null {
    return this.nextAgentAlarmSchedule();
  }

  private async fireAgentAlarms(now: number): Promise<void> {
    const due = [...this.alarmSources.values()]
      .map((source) => ({ source, wakeAt: source.nextWakeAt() }))
      .filter(
        (entry): entry is { source: AgentAlarmSource; wakeAt: number } =>
          typeof entry.wakeAt === "number" && entry.wakeAt <= now,
      )
      .sort((a, b) => a.wakeAt - b.wakeAt);
    // Reconcile every due source before entering any source handler. A long
    // handler must not leave later sources looking not-yet-due merely because
    // this activation is still occupied.
    for (const { source } of due) this.alarmDeadlines.delete(source.id);
    for (const { source } of due) {
      await source.fire(now);
    }
  }

  private driverNextWakeAtFromSql(): number | null {
    const due: number[] = [];
    try {
      const row = this.sql
        .exec(
          `SELECT MIN(next_attempt_at) AS due
             FROM effect_outbox
            WHERE disposition IN ('retrying', 'parked')`,
        )
        .toArray()[0];
      const value = row?.["due"];
      if (typeof value === "number") due.push(value);
    } catch {
      // Driver tables are created lazily.
    }
    try {
      const row = this.sql
        .exec(`SELECT MIN(reset_at_ms) AS due FROM scheduled_model_resumes`)
        .toArray()[0];
      const value = row?.["due"];
      if (typeof value === "number") due.push(value);
    } catch {
      // Driver tables are created lazily.
    }
    return due.length ? Math.min(...due) : null;
  }

  private _gadClient: DurableObjectServiceClient | null = null;

  protected async callGad<T>(method: string, ...args: unknown[]): Promise<T> {
    this._gadClient ??= createGadServiceClient({
      call: <R>(targetId: string, m: string, a: unknown[]) =>
        this.rpc.call<R>(targetId, m, a),
    });
    return this._gadClient.call<T>(method, ...args);
  }

  /** Resolve the exact durable command coordinate used by mutation replay.
   * Missing commands are ordinary for read-only tools; every other inspection
   * failure stays exceptional so uncertainty can never authorize a duplicate. */
  private async completedMutationEvidence(
    commandId: string,
  ): Promise<{ commandId: string; command: unknown } | null> {
    try {
      const inspected = await createSubagentVcsClient(this.rpc).inspect({
        node: { kind: "command", commandId },
        edgeLimit: 1,
      });
      return inspected.node.kind === "command" &&
        inspected.node.value.status === "complete"
        ? { commandId, command: inspected.node }
        : null;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null
          ? ((error as { code?: unknown }).code ??
            (error as { errorData?: { code?: unknown } }).errorData?.code)
          : undefined;
      if (code === "InvalidReference") return null;
      throw error;
    }
  }

  private executorDeps(): ExecutorDeps {
    this.ensureIdentity();
    const ref = this.identity.ref;
    return {
      selfRef: {
        kind: "agent",
        id: this.participantId(),
        participantId: this.participantId(),
      },
      blobstore: {
        getText: (digest) => this.getCachedBlobText(digest),
        putText: async (value) => {
          const stored = await this.rpc.call<{ digest: string; size: number }>(
            "main",
            "blobstore.putText",
            [value],
          );
          this.rememberBlobText(stored.digest, value);
          return stored;
        },
      },
      channel: {
        callMethod: async (input) => {
          await this.createChannelClient(input.channelId).callMethod(
            this.participantId(),
            input.targetParticipantId,
            input.transportCallId,
            input.method,
            input.args,
            {
              invocationId: input.invocationId,
              transportCallId: input.transportCallId,
              ...(input.turnId ? { turnId: input.turnId } : {}),
              ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
            },
          );
        },
        cancelMethodCall: async (channelId, transportCallId) => {
          await this.createChannelClient(channelId).cancelCall(
            this.participantId(),
            transportCallId,
          );
        },
        publish: async (input) => {
          // The agent outbox owns this effect until the channel acknowledges
          // durable acceptance. The channel's idempotency key makes a retry
          // after an ambiguous transport failure safe.
          await this.createChannelClient(input.channelId).publish(
            this.participantId(),
            input.payloadKind,
            input.payload,
            input.idempotencyKey
              ? { idempotencyKey: input.idempotencyKey }
              : undefined,
          );
        },
        recordReadReceipt: async (input) => {
          await this.createChannelClient(input.channelId).recordReadReceipt(
            this.participantId(),
            input.messageId,
            input.turnId,
          );
        },
        sendSignalEvent: async (channelId, event) => {
          await this.createChannelClient(channelId).sendSignalEvent(
            this.participantId(),
            AGENTIC_EVENT_PAYLOAD_KIND,
            event,
          );
        },
      },
      localModels: {
        // Loopback model runtime (design §6.3). The key crosses this boundary
        // per call and is never persisted vessel-side; the extension enforces
        // do-kind + vessel-allowlist caller gating on getLoopbackAuth.
        ensureLoaded: async (modelId, signal) =>
          await this.rpc.call<{ baseUrl: string }>(
            "main",
            "extensions.invoke",
            [LOCAL_MODELS_EXTENSION_ID, "ensureLoaded", [modelId]],
            { signal },
          ),
        getLoopbackAuth: async (signal) =>
          await this.rpc.call<{ apiKey: string }>(
            "main",
            "extensions.invoke",
            [LOCAL_MODELS_EXTENSION_ID, "getLoopbackAuth", []],
            { signal },
          ),
      },
      promptArtifacts: {
        prepare: (channelId, signal) =>
          this.preparePromptArtifacts(channelId, signal),
      },
      credentials: {
        getApiKey: async ({
          providerId,
          modelBaseUrl,
          requestId,
          idempotencyKey,
          signal,
        }) => {
          // Prefer URL-bound credentials when the model exposes a concrete
          // endpoint; fall back to provider-scoped credentials for providers
          // whose registry entries do not carry a base URL.
          let summary: ModelCredentialSummary | null;
          const resolveRequest = modelBaseUrl
            ? { url: modelBaseUrl }
            : { providerId };
          try {
            if (requestId) {
              summary = await this.rpc.call<ModelCredentialSummary | null>(
                "main",
                "credentials.resolveCredential",
                [resolveRequest],
                {
                  idempotencyKey: idempotencyKey ?? requestId,
                  authorityAcquisition: "return",
                  signal,
                },
              );
            } else {
              summary = await this.rpc.call<ModelCredentialSummary | null>(
                "main",
                "credentials.resolveCredential",
                [resolveRequest],
                { signal },
              );
            }
            if (!summary)
              throw new CredentialPendingError(providerId, modelBaseUrl);
          } catch (err) {
            if (authorityAcquisitionRequired(err)) {
              throw new CredentialApprovalDeferredError(
                providerId,
                modelBaseUrl,
              );
            }
            if (authorityDecisionDenied(err)) throw err;
            if (!(err instanceof CredentialPendingError)) {
              console.warn(
                `[AgentVessel] resolveCredential(${modelBaseUrl ?? providerId}) failed:`,
                err instanceof Error ? err.message : err,
              );
            }
            // Only a successful resolver returning null means "no credential".
            // Service exposure, authority, transport, and implementation
            // failures are not credential absence and must retain their real
            // identity; collapsing them here produced a bogus reconnect card
            // and parked the turn forever.
            throw err;
          }
          installUrlBoundModelFetchProxy(modelBaseUrl ?? "*", (url, init) =>
            this.credentials.fetch(url, init),
          );
          return {
            apiKey: createModelCredentialSentinel(
              this.getModelCredentialTokenClaims(providerId, summary),
            ),
          };
        },
        registerCredentialInterest: async () => {
          // The agent-owned connect method resolves this durable wait after the
          // host has stored the credential; no separate panel acknowledgement
          // or server-side interest registry is required.
        },
      },
      localTools: {
        run: async ({
          channelId,
          tool,
          invocationId,
          args,
          signal,
          onProgress,
        }) => {
          const trajectory = channelTrajectoryFor(channelId);
          const causalRpc = withCausalParent(this.rpc, {
            kind: "trajectory-invocation",
            logId: trajectory.logId,
            head: trajectory.head,
            invocationId,
          });
          const admissionNonce =
            this.driver.peekLoadedLoop(channelId)?.state.openTurn?.metadata
              ?.automation?.authoritySessionNonce;
          const execution = Object.freeze({
            invocationId,
            commandId: commandIdForTrajectoryInvocation({
              logId: trajectory.logId,
              head: trajectory.head,
              invocationId,
            }),
            rpc: admissionNonce
              ? withExecutionAdmission(causalRpc, admissionNonce)
              : causalRpc,
          }) satisfies AgentToolExecutionContext;
          let resolvedTool: AgentTool | undefined;
          let executionAdmitted = false;
          try {
            // The `eval` tool DEFERS: the agent can't hold a connection for a multi-minute run.
            // eval.start receives this verified parent scope and delegates it to the EvalDO.
            if (tool === "eval") {
              return await this.runDeferredEval(
                channelId,
                invocationId,
                args,
                execution.rpc,
              );
            }
            // `spawn_subagent` is an agentic lifecycle operation, not workspace authorship.
            if (tool === "spawn_subagent") {
              return await this.runDeferredSpawn(
                channelId,
                invocationId,
                args,
                execution.rpc,
              );
            }
            const registry = await this.toolRegistry(channelId, execution);
            resolvedTool = registry.get(tool);
            if (!resolvedTool) {
              const failure = agentToolFailureFromUnknown(
                Object.assign(new Error(`unknown tool: ${tool}`), {
                  code: "tool_not_found",
                }),
                {
                  operation: `tool.${tool}`,
                  stage: "resolve",
                  causal: { invocationId, commandId: execution.commandId },
                },
              );
              return {
                result: {
                  protocolContent: [
                    { type: "text", text: renderAgentToolFailure(failure) },
                  ],
                  details: { failure },
                },
                isError: true,
                terminalReasonCode: failure.code,
                failure,
              };
            }
            const params = prepareAgentToolArguments(resolvedTool, args);
            executionAdmitted = true;
            const result = await executeLocalTool(resolvedTool, {
              invocationId,
              params,
              parentSignal: signal,
              onProgress,
            });
            return {
              result: {
                protocolContent: result.content,
                details: result.details,
              },
              isError: result.isError === true,
              ...(result.isError !== true && result.terminate === true
                ? { terminate: true }
                : {}),
            };
          } catch (err) {
            if (
              executionAdmitted &&
              resolvedTool?.cancellationMode === "settle"
            ) {
              const evidence = await this.completedMutationEvidence(
                execution.commandId,
              );
              if (evidence) {
                return {
                  result: {
                    protocolContent: [
                      {
                        type: "text",
                        text: `Recovered completed workspace mutation ${evidence.commandId}; its result raced with cancellation or transport failure.`,
                      },
                    ],
                    details: { replayed: true, evidence },
                  },
                  summary: "Recovered a completed workspace mutation",
                  isError: false,
                };
              }
            }
            const failure = agentToolFailureFromUnknown(err, {
              operation: `tool.${tool}`,
              stage: signal.aborted ? "cancel" : "execute",
              causal: { invocationId, commandId: execution.commandId },
              ...(signal.aborted ? { kind: "cancelled" as const } : {}),
            });
            return {
              result: {
                protocolContent: [
                  {
                    type: "text",
                    text: renderAgentToolFailure(failure),
                  },
                ],
                details: { failure },
              },
              isError: true,
              terminalReasonCode: failure.code,
              failure,
            };
          }
        },
        alreadyApplied: async (state, invocationId) => {
          const commandId = commandIdForTrajectoryInvocation({
            logId: state.logId,
            head: state.head,
            invocationId,
          });
          return this.completedMutationEvidence(commandId);
        },
      },
      http: {
        post: async (input) => {
          if (!input.target)
            throw new Error("http_call requires a target service/method");
          try {
            const result = await this.rpc.call(
              "main",
              `${input.target.service}.${input.target.method}`,
              [input.request],
              {
                idempotencyKey: input.idempotencyKey,
                authorityAcquisition: "return",
              },
            );
            return { deferred: false, result, isError: false };
          } catch (error) {
            if (authorityAcquisitionRequired(error)) {
              return { deferred: true, reason: "authority" };
            }
            throw error;
          }
        },
      },
      callbackAddress: {
        source: ref.source,
        className: ref.className,
        objectKey: ref.objectKey,
      },
      env: this.env,
    };
  }

  private async getCachedBlobText(digest: string): Promise<string | null> {
    const cached = this.blobTextCache.get(digest);
    if (cached) {
      this.blobTextCache.delete(digest);
      this.blobTextCache.set(digest, cached);
      return cached.value;
    }
    const active = this.blobTextReads.get(digest);
    if (active) return active;

    const pending = this.rpc
      .call<string | null>("main", "blobstore.getText", [digest])
      .then((value) => {
        if (value != null) this.rememberBlobText(digest, value);
        return value;
      });
    this.blobTextReads.set(digest, pending);
    void pending.then(
      () => {
        if (this.blobTextReads.get(digest) === pending)
          this.blobTextReads.delete(digest);
      },
      () => {
        if (this.blobTextReads.get(digest) === pending)
          this.blobTextReads.delete(digest);
      },
    );
    return pending;
  }

  private rememberBlobText(digest: string, value: string): void {
    const bytes = new TextEncoder().encode(value).byteLength;
    const existing = this.blobTextCache.get(digest);
    if (existing) this.blobTextCacheBytes -= existing.bytes;
    this.blobTextCache.delete(digest);
    this.blobTextCache.set(digest, { value, bytes });
    this.blobTextCacheBytes += bytes;
    while (this.blobTextCacheBytes > BLOB_TEXT_CACHE_MAX_BYTES) {
      const first = this.blobTextCache.entries().next().value as
        | [string, { value: string; bytes: number }]
        | undefined;
      if (!first) break;
      this.blobTextCache.delete(first[0]);
      this.blobTextCacheBytes -= first[1].bytes;
    }
  }

  private async channelTarget(channelId: string): Promise<string> {
    const service = await this.rpc.call<{ targetId?: string }>(
      "main",
      "workers.resolveService",
      ["vibestudio.channel.v1", channelId],
    );
    if (!service.targetId) throw new Error("channel service did not resolve");
    return service.targetId;
  }

  /** Batched delta signals (~100ms) — never durable (WS1 §2.4.1).
   * Per-channel pumps preserve order without allowing a slow UI transport to
   * create an unbounded promise chain. Dropped intermediate observations are
   * repaired by the replayable durable terminal. */
  private readonly signalPumps = new Map<
    string,
    { running: boolean; pending: Array<() => Promise<void>> }
  >();

  private sendOrderedSignal(channelId: string, events: AgenticEvent[]): void {
    this.enqueueEphemeralSignal(channelId, () =>
      this.createChannelClient(channelId)
        .sendSignalEvent(
          this.participantId(),
          AGENTIC_EVENT_PAYLOAD_KIND,
          events.length === 1 ? events[0] : events,
        )
        .catch(() => {}),
    );
  }

  private sendOrderedSignalMessage(
    channelId: string,
    content: string,
    contentType?: string,
  ): void {
    this.enqueueEphemeralSignal(channelId, () =>
      this.createChannelClient(channelId)
        .sendSignal(this.participantId(), content, contentType)
        .catch(() => {}),
    );
  }

  private enqueueEphemeralSignal(
    channelId: string,
    send: () => Promise<void>,
  ): void {
    const pump = this.signalPumps.get(channelId) ?? {
      running: false,
      pending: [],
    };
    if (pump.pending.length >= MAX_PENDING_SIGNAL_BATCHES) pump.pending.shift();
    pump.pending.push(send);
    this.signalPumps.set(channelId, pump);
    if (pump.running) return;
    pump.running = true;
    void (async () => {
      try {
        while (pump.pending.length > 0) await pump.pending.shift()!();
      } finally {
        pump.running = false;
        if (
          pump.pending.length === 0 &&
          this.signalPumps.get(channelId) === pump
        ) {
          this.signalPumps.delete(channelId);
        }
      }
    })();
  }

  private emitEphemeral(emit: EphemeralEmit): void {
    if (emit.kind === "signal-message") {
      this.sendOrderedSignalMessage(
        emit.channelId,
        emit.content,
        emit.contentType,
      );
      return;
    }
    const buffer = this.deltaBuffers.get(emit.channelId) ?? {
      events: [],
      timer: null,
    };
    if (buffer.events.length >= MAX_BUFFERED_DELTA_EVENTS)
      buffer.events.shift();
    buffer.events.push(emit.event);
    if (!buffer.timer) {
      buffer.timer = setTimeout(() => {
        const drained = this.deltaBuffers.get(emit.channelId);
        this.deltaBuffers.delete(emit.channelId);
        const events = drained?.events ?? [];
        if (events.length > 0) this.sendOrderedSignal(emit.channelId, events);
      }, DELTA_BATCH_MS);
    }
    this.deltaBuffers.set(emit.channelId, buffer);
  }

  // ── Settings (Ref-kind KV; the log journals what each call actually used) ─

  protected updateSettings(patch: StoredSettings): AgentSettings {
    const next = { ...this.storedSettings(), ...patch };
    this.setStateValue(AGENT_SETTINGS_KEY, JSON.stringify(next));
    // Config is PER-AGENT: a change applies to EVERY channel the agent is in,
    // so drop each channel's cached loop + fold so the next wake refolds with it.
    for (const channelId of this.subscriptions.listChannelIds()) {
      this.driver.dropLoop(channelId);
      const { logId, head } = channelTrajectoryFor(channelId);
      this.driver.foldCache.delete(logId, head);
    }
    return this.getAgentSettings();
  }

  /**
   * The agent's settings record (channel-INDEPENDENT). On first read it is
   * seeded from the agent's creation params (`STATE_ARGS.agentConfig`) so an
   * invited agent starts with the config it was created with, then persisted so
   * later reads are stable and edits (updateSettings) win over the seed.
   */
  private storedSettings(persistSeed = true): StoredSettings {
    const raw = this.getStateValue(AGENT_SETTINGS_KEY);
    if (raw) {
      try {
        return JSON.parse(raw) as StoredSettings;
      } catch {
        /* corrupt record — fall through to a fresh seed */
      }
    }
    const seed = this.seedSettingsFromStateArgs();
    if (persistSeed && Object.keys(seed).length > 0) {
      this.setStateValue(AGENT_SETTINGS_KEY, JSON.stringify(seed));
    }
    return seed;
  }

  /**
   * Initial settings from the agent's creation stateArgs (`STATE_ARGS.agentConfig`).
   * Picks ONLY the known settings (lenient — skips invalid/unknown keys) so the
   * persisted record stays clean even if the creation config carries presentation
   * fields (handle/systemPrompt) or junk.
   */
  private seedSettingsFromStateArgs(): StoredSettings {
    const stateArgs = this.env["STATE_ARGS"];
    const raw =
      stateArgs && typeof stateArgs === "object"
        ? (stateArgs as Record<string, unknown>)["agentConfig"]
        : undefined;
    if (!raw || typeof raw !== "object") return {};
    const c = raw as Record<string, unknown>;
    const seed: StoredSettings = {};
    if (typeof c["model"] === "string" && c["model"]) seed.model = c["model"];
    const tl = c["thinkingLevel"];
    if (isThinkingLevel(tl)) seed.thinkingLevel = tl;
    if (typeof c["fastMode"] === "boolean") seed.fastMode = c["fastMode"];
    if (typeof c["fallbackModel"] === "string" && c["fallbackModel"]) {
      seed.fallbackModel = c["fallbackModel"];
    }
    if (isThinkingLevel(c["fallbackThinkingLevel"])) {
      seed.fallbackThinkingLevel = c["fallbackThinkingLevel"];
    }
    if (isFallbackOn(c["fallbackOn"])) seed.fallbackOn = [...c["fallbackOn"]];
    if (
      c["fallbackScope"] === "unattended" ||
      c["fallbackScope"] === "all-turns"
    ) {
      seed.fallbackScope = c["fallbackScope"];
    }
    const al = c["approvalLevel"];
    if (al === 0 || al === 1 || al === 2) seed.approvalLevel = al;
    if (isRespondPolicy(c["respondPolicy"]))
      seed.respondPolicy = c["respondPolicy"];
    const rf = c["respondFrom"];
    if (Array.isArray(rf) && rf.every((x) => typeof x === "string"))
      seed.respondFrom = rf as string[];
    return seed;
  }

  private resolveAgentSettings(persistSeed: boolean): AgentSettings {
    const stored = this.storedSettings(persistSeed);
    const approval = stored.approvalLevel;
    return {
      model: stored.model ?? this.getDefaultModel(),
      thinkingLevel: stored.thinkingLevel ?? this.getDefaultThinkingLevel(),
      fastMode: stored.fastMode ?? false,
      ...(stored.fallbackModel ? { fallbackModel: stored.fallbackModel } : {}),
      ...(stored.fallbackThinkingLevel
        ? { fallbackThinkingLevel: stored.fallbackThinkingLevel }
        : {}),
      ...(stored.fallbackOn ? { fallbackOn: [...stored.fallbackOn] } : {}),
      ...(stored.fallbackScope ? { fallbackScope: stored.fallbackScope } : {}),
      approvalLevel:
        approval === 0 || approval === 1 || approval === 2
          ? approval
          : this.getDefaultApprovalLevel(),
      respondPolicy: isRespondPolicy(stored.respondPolicy)
        ? stored.respondPolicy
        : this.getRespondPolicy(),
      respondFrom: stored.respondFrom ?? this.getDefaultRespondFrom(),
    };
  }

  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  getAgentSettings(): AgentSettings {
    return this.resolveAgentSettings(true);
  }

  /** Settings projection for operational inspection; never seeds local state. */
  private inspectAgentSettings(): AgentSettings {
    return this.resolveAgentSettings(false);
  }

  protected getRespondPolicy(): RespondPolicy {
    return this.getDefaultRespondPolicy();
  }

  private loopConfig(channelId: string): AgentLoopConfig {
    const settings = this.getAgentSettings();
    // Tool-call review is a channel-wide interaction preference. The chat
    // header writes it to channel config; the agent setting supplies the
    // initial value until the channel makes an explicit selection. Host
    // authority is evaluated separately for each concrete operation.
    const channelConfig =
      (this.subscriptions.getConfig(channelId) as Record<
        string,
        unknown
      > | null) ?? this.channelConfigCache.get(channelId)?.value;
    const channelApprovalLevel = channelConfig?.["approvalLevel"];
    const approvalLevel =
      channelApprovalLevel === 0 ||
      channelApprovalLevel === 1 ||
      channelApprovalLevel === 2
        ? channelApprovalLevel
        : settings.approvalLevel;
    const publishPolicy = this.getPublishPolicy(channelId);
    const materialized = this.materializedModel(channelId, settings.model);
    if (!materialized) {
      throw new Error(
        `Agent model ${JSON.stringify(settings.model)} could not be materialized; ` +
          "select a model present in the current catalog before starting the agent",
      );
    }
    const fallbackModelRef = settings.fallbackModel ?? LOCAL_FALLBACK_MODEL_REF;
    const fallbackMaterialized = this.materializedModel(
      channelId,
      fallbackModelRef,
    );
    if (settings.fallbackModel && !fallbackMaterialized) {
      throw new Error(
        `Agent fallback model ${JSON.stringify(settings.fallbackModel)} could not be materialized; ` +
          "select a fallback model present in the current catalog before starting the agent",
      );
    }
    const toolSchemasHash =
      // Tool-capability gate (design §6.4): omit tool schemas at the source
      // for models whose chat template can't parse them.
      !materialized.toolsCapable
        ? undefined
        : (this.getStateValue(`agent:toolsHash:${channelId}`) ?? undefined);
    return {
      model: settings.model,
      modelSpec: materialized.spec,
      modelAuth: materialized.auth,
      ...(fallbackMaterialized
        ? {
            fallbackModelRef,
            fallbackModelSpec: fallbackMaterialized.spec,
            fallbackModelAuth: fallbackMaterialized.auth,
            ...(settings.fallbackThinkingLevel
              ? { fallbackThinkingLevel: settings.fallbackThinkingLevel }
              : {}),
            ...(settings.fallbackOn
              ? { fallbackFailureCodes: settings.fallbackOn }
              : {}),
            ...(settings.fallbackScope
              ? { fallbackScope: settings.fallbackScope }
              : {}),
          }
        : {}),
      thinkingLevel: settings.thinkingLevel,
      fastMode: settings.fastMode,
      approvalLevel,
      respondPolicy: settings.respondPolicy,
      systemPromptHash:
        this.getStateValue(`agent:promptHash:${channelId}`) ?? "",
      toolSchemasHash,
      activeToolNames: JSON.parse(
        this.getStateValue(`agent:toolNames:${channelId}`) ?? "[]",
      ) as string[],
      localToolExecutionModes: JSON.parse(
        this.getStateValue(`agent:toolExecutionModes:${channelId}`) ?? "{}",
      ) as Record<string, "sequential" | "parallel">,
      localToolCancellationModes: JSON.parse(
        this.getStateValue(`agent:toolCancellationModes:${channelId}`) ?? "{}",
      ) as Record<string, "interruptible" | "settle">,
      roster: { participants: [] }, // roster snapshots fold from system.event
      maxSubagentDepth: this.getMaxSubagentDepth(),
      maxSubagents: this.getMaxSubagents(),
      ...(publishPolicy ? { publishPolicy } : {}),
    };
  }

  /** Materialize the journaled model spec (design §6.2): local refs from the
   *  cached extension entry (refreshed in ensurePromptArtifacts), cloud refs
   *  from the pi-ai registry — an INPUT to materialization here at the impure
   *  edge, never a resolution path in the executor. */
  private materializedModel(
    channelId: string,
    ref: string,
  ): MaterializedModel | null {
    const idx = ref.indexOf(":");
    const providerId = idx === -1 ? "anthropic" : ref.slice(0, idx);
    const modelId = idx === -1 ? ref : ref.slice(idx + 1);
    let localEntry: LocalModelDescriptor | null = null;
    if (providerId === LOCAL_PROVIDER_ID) {
      const raw = this.getStateValue(`agent:localModelEntry:${channelId}`);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as LocalModelDescriptor;
          if (parsed && parsed.slug === modelId) localEntry = parsed;
        } catch {
          // Corrupt cache — the next artifact refresh rewrites it. Only the
          // bundled fallback has a static descriptor before that refresh.
        }
      }
    }
    return materializeModel(providerId, modelId, localEntry);
  }

  /** Cache the local-models extension entry for a `local:*` agent model so
   *  the synchronous loopConfig() can materialize its journaled spec. The
   *  bundled fallback has a truthful static descriptor for first boot; every
   *  other local model requires its extension-provided metadata. */
  private async refreshLocalModelEntry(channelId: string): Promise<void> {
    const model = this.getAgentSettings().model;
    if (!model.startsWith(`${LOCAL_PROVIDER_ID}:`)) return;
    const slug = model.slice(LOCAL_PROVIDER_ID.length + 1);
    try {
      const entries = await this.rpc.call<LocalModelDescriptor[]>(
        "main",
        "extensions.invoke",
        [LOCAL_MODELS_EXTENSION_ID, "listModels", []],
      );
      const entry = Array.isArray(entries)
        ? (entries.find((candidate) => candidate?.slug === slug) ?? null)
        : null;
      if (!entry) return;
      this.setStateValue(
        `agent:localModelEntry:${channelId}`,
        JSON.stringify({
          slug: entry.slug,
          displayName: entry.displayName,
          baseUrl: entry.baseUrl,
          contextWindow: entry.contextWindow,
          maxTokens: entry.maxTokens,
          toolsCapable: entry.toolsCapable,
          reasoningCapable: entry.reasoningCapable,
        } satisfies LocalModelDescriptor),
      );
    } catch (err) {
      console.warn("[agent-vessel] local model entry refresh failed:", err);
    }
  }

  /** Compose + blob-spill the exact prompt/tool/model snapshot that will be
   * journaled before a model call. This is the impure executor for the
   * loop-owned `prompt_artifacts` effect; channel delivery only journals the
   * prerequisite and never awaits this method. */
  private async preparePromptArtifacts(
    channelId: string,
    signal?: AbortSignal,
  ): Promise<Partial<AgentLoopConfig>> {
    const preparationStartedAt = Date.now();
    this.traceHotPath(channelId, "prompt-artifacts.started");
    const stage = async <T>(
      phase: string,
      operation: () => T | Promise<T>,
    ): Promise<T> => {
      const startedAt = Date.now();
      try {
        const value = await operation();
        this.traceHotPath(channelId, `${phase}.completed`, { startedAt });
        return value;
      } catch (error) {
        this.traceHotPath(channelId, `${phase}.failed`, {
          startedAt,
          details: { error: error instanceof Error ? error.name : "unknown" },
        });
        throw error;
      }
    };
    const throwIfAborted = () => {
      if (!signal?.aborted) return;
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("prompt artifact preparation aborted");
    };
    throwIfAborted();
    await stage("prompt-artifacts.local-model", () =>
      this.refreshLocalModelEntry(channelId),
    );
    throwIfAborted();
    const systemPrompt = await stage("prompt-artifacts.resources", () =>
      this.composePrompt(channelId),
    );
    throwIfAborted();
    const registry = await stage("prompt-artifacts.tool-registry", () =>
      this.toolRegistry(channelId),
    );
    const schemas: Array<{
      name: string;
      description?: string;
      parameters?: unknown;
    }> = [...registry.values()].map((tool) => {
      assertAgentToolParametersSchema(tool.name, tool.parameters);
      return {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      };
    });
    const executionModes = Object.fromEntries(
      [...registry.values()].map((tool) => [
        tool.name,
        tool.executionMode === "parallel" ? "parallel" : "sequential",
      ]),
    ) satisfies Record<string, "sequential" | "parallel">;
    const cancellationModes = Object.fromEntries(
      [...registry.values()].map((tool) => [
        tool.name,
        tool.cancellationMode === "settle" ? "settle" : "interruptible",
      ]),
    ) satisfies Record<string, "interruptible" | "settle">;
    // Channel tools: roster participants' advertised methods become model
    // tools dispatched as channel_call effects (the panel's UI surface —
    // inline_ui/feedback/action_bar). eval is a LOCAL tool now, not a channel method.
    const seenTools = new Set(registry.keys());
    const selfId = this.participantId();
    for (const participant of this.rosterSnapshot(channelId)) {
      if (
        participant.participantId === selfId ||
        participantIdFromRef(participant.ref) === selfId
      ) {
        continue;
      }
      if (participant.methods.length > 0) {
        await this.recordDerivedSessionIngestion(
          participant.participantId,
          "participant-tool-advertisement",
        );
        throwIfAborted();
      }
      for (const method of participant.methods) {
        if (seenTools.has(method.name)) continue;
        seenTools.add(method.name);
        const parameters = method.parameters ?? {
          type: "object",
          properties: {},
          additionalProperties: true,
        };
        assertAgentToolParametersSchema(method.name, parameters);
        schemas.push({
          name: method.name,
          description:
            method.description ??
            `Channel method on @${participant.handle ?? participant.participantId}`,
          parameters,
        });
      }
    }
    const schemasJson = JSON.stringify(schemas);
    const names = JSON.stringify([...registry.keys()]);
    const executionModesJson = JSON.stringify(executionModes);
    const cancellationModesJson = JSON.stringify(cancellationModes);
    const signature = stableSha256Hex({
      systemPrompt,
      schemas,
      executionModes,
      cancellationModes,
    });
    const promptHashKey = `agent:promptHash:${channelId}`;
    const toolsHashKey = `agent:toolsHash:${channelId}`;
    const toolNamesKey = `agent:toolNames:${channelId}`;
    const toolExecutionModesKey = `agent:toolExecutionModes:${channelId}`;
    const toolCancellationModesKey = `agent:toolCancellationModes:${channelId}`;
    const artifactSigKey = `agent:artifactSig:${channelId}`;
    const existingPromptHash = this.getStateValue(promptHashKey) ?? "";
    const existingToolsHash = this.getStateValue(toolsHashKey) ?? "";
    if (
      !existingPromptHash ||
      !existingToolsHash ||
      this.getStateValue(artifactSigKey) !== signature ||
      this.getStateValue(toolNamesKey) !== names ||
      this.getStateValue(toolExecutionModesKey) !== executionModesJson ||
      this.getStateValue(toolCancellationModesKey) !== cancellationModesJson
    ) {
      const prompt = await stage("prompt-artifacts.prompt-blob", () =>
        this.rpc.call<{ digest?: string }>("main", "blobstore.putText", [
          systemPrompt,
        ]),
      );
      throwIfAborted();
      const tools = await stage("prompt-artifacts.tools-blob", () =>
        this.rpc.call<{ digest?: string }>("main", "blobstore.putText", [
          schemasJson,
        ]),
      );
      throwIfAborted();
      const promptHash =
        typeof prompt?.digest === "string" ? prompt.digest : "";
      const toolsHash = typeof tools?.digest === "string" ? tools.digest : "";
      if (
        !/^[0-9a-f]{64}$/u.test(promptHash) ||
        !/^[0-9a-f]{64}$/u.test(toolsHash)
      ) {
        throw new Error(
          "prompt artifact storage returned an invalid content digest",
        );
      }
      this.setStateValue(promptHashKey, promptHash);
      this.setStateValue(toolsHashKey, toolsHash);
      this.setStateValue(toolNamesKey, names);
      this.setStateValue(toolExecutionModesKey, executionModesJson);
      this.setStateValue(toolCancellationModesKey, cancellationModesJson);
      this.setStateValue(artifactSigKey, signature);
    }
    throwIfAborted();
    const { roster: _foldOwnedRoster, ...patch } = this.loopConfig(channelId);
    this.traceHotPath(channelId, "prompt-artifacts.completed", {
      startedAt: preparationStartedAt,
      details: { toolCount: schemas.length },
    });
    return patch;
  }

  /** Explicit refresh API: materialize, then journal the same config patch the
   * durable prompt prerequisite would have produced. */
  protected async ensurePromptArtifacts(channelId: string): Promise<void> {
    const patch = await this.preparePromptArtifacts(channelId);
    await this.driver.handleIncoming(channelId, {
      type: "command",
      command: { kind: "setConfig", patch },
    });
  }

  /** Last roster snapshot for a channel (set by refreshRoster). */
  protected rosterSnapshot(channelId: string): RosterEntry[] {
    try {
      const raw = this.getStateValue(`agent:roster:${channelId}`);
      return raw ? (JSON.parse(raw) as RosterEntry[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * The lookup tables `resolveAddressee` (messaging plan §4.2) needs, assembled
   * from what this vessel already knows durably: who is on the channel, who
   * supervises it, and which children it is running.
   *
   * The directory and workspace-user tables are deliberately absent until the
   * Gad directory lands (§4.4): an `agent:` ref or an off-roster `user:` ref
   * therefore fails closed with "use discover_agents", which is the honest
   * answer while there is nothing to discover them from.
   */
  protected async addresseeContext(
    channelId: string,
  ): Promise<ResolveAddresseeContext> {
    const parentParticipantId = this.subagentIdentity()?.parentParticipantId;
    const roster = this.rosterSnapshot(channelId).map(rosterParticipantRef);
    const automationOwnerUserId =
      this.driver.peekLoadedLoop(channelId)?.state?.openTurn?.metadata
        ?.automation?.ownerUserId;
    const ownerUserId = automationOwnerUserId ?? soleChannelUserId(roster);
    const [directory, users] = await Promise.all([
      this.agentDirectoryEntries(),
      this.workspaceUserEntries(),
    ]);
    return {
      channelId,
      roster,
      ...(parentParticipantId
        ? { parent: { participantId: parentParticipantId } }
        : {}),
      runs: this.subagentRuns.listLive().map((run) => ({
        runId: run.runId,
        taskChannelId: run.taskChannelId,
        ...(run.childParticipantId
          ? { participantId: run.childParticipantId }
          : {}),
      })),
      directory,
      users,
      ...(ownerUserId ? { ownerUserId } : {}),
    };
  }

  /** The workspace's people, as addressing sees them (messaging plan §4.2):
   *  the fallback roster for `user:<id>` and `@handle` refs naming someone who
   *  is not on this channel yet. Read live from the host account projection; a
   *  failed read is an empty list, so such refs fail closed with suggestions
   *  from the channel roster rather than failing the message. */
  protected async workspaceUserEntries(): Promise<AddresseeUserEntry[]> {
    try {
      const members = await this.rpc.call<
        Array<{
          userId: string;
          handle?: string;
          displayName?: string;
          revoked?: boolean;
        }>
      >("main", "account.listWorkspaceMembers", []);
      return members
        .filter((member) => member.revoked !== true)
        .map((member) => ({
          userId: member.userId,
          ...(member.handle ? { handle: member.handle } : {}),
          ...(member.displayName ? { displayName: member.displayName } : {}),
        }));
    } catch {
      return [];
    }
  }

  /** The Gad directory as addressing sees it. A directory read that fails is an
   *  empty directory, not a failed message: `agent:` refs then fail closed with
   *  "use discover_agents", which is the same answer a caller gets when the
   *  instance genuinely is not there. */
  protected async agentDirectoryEntries(): Promise<AddresseeDirectoryEntry[]> {
    try {
      const listing = await this.callGad<{
        entries: Array<{
          instanceId: string;
          handle: string | null;
          channelId: string;
          participantId: string;
        }>;
      }>("listAgentDirectory", { includeTerminal: true });
      return listing.entries
        .filter((entry) => entry.handle)
        .map((entry) => ({
          instanceId: entry.instanceId,
          handle: entry.handle as string,
          channelId: entry.channelId,
          participantId: entry.participantId,
        }));
    } catch {
      return [];
    }
  }

  private async toolRegistry(
    channelId: string,
    execution?: AgentToolExecutionContext,
  ): Promise<Map<string, AgentTool>> {
    if (execution) {
      const registry = new Map<string, AgentTool>();
      if (this.includeMemoryRecallTool()) {
        registry.set("memory_recall", this.createMemoryRecallTool());
      }
      registry.set(
        "launch_automation",
        this.createAutomationLaunchTool(channelId, execution),
      );
      registry.set(
        "control_automation",
        this.createAutomationControlTool(channelId, execution),
      );
      registry.set(
        "complete_automation",
        this.createAutomationCompletionTool(channelId),
      );
      for (const tool of await this.getLoopTools(channelId, execution)) {
        registry.set(tool.name, tool);
      }
      return registry;
    }
    let registry = this.localTools.get(channelId);
    if (!registry) {
      registry = new Map();
      if (this.includeMemoryRecallTool()) {
        registry.set("memory_recall", this.createMemoryRecallTool());
      }
      registry.set(
        "launch_automation",
        this.createAutomationLaunchTool(channelId),
      );
      registry.set(
        "control_automation",
        this.createAutomationControlTool(channelId),
      );
      registry.set(
        "complete_automation",
        this.createAutomationCompletionTool(channelId),
      );
      for (const tool of await this.getLoopTools(channelId)) {
        registry.set(tool.name, tool);
      }
      this.localTools.set(channelId, registry);
    }
    return registry;
  }

  protected createAutomationLaunchTool(
    channelId: string,
    execution?: AgentToolExecutionContext,
  ): AgentTool {
    return {
      name: "launch_automation",
      label: "launch_automation",
      description:
        "Create and immediately start one recurring or manual automation. By default the current agent wakes in this conversation; choose a fresh conversation only for a separate topic or genuinely long-running background task. If shared context would help and wake-ups can be more than one hour apart, ask the user which mode they want when their intent is unclear. A prompt action is an instruction for the future agent, not a final message payload: preserve requested effects such as notifying the owner instead of supplying only the text to send. Model-facing tools such as notify are available to prompt actions, not as eval JavaScript globals. List concrete external service operations known at launch so the host can pre-acquire eligible standing grants; this list is not a runtime allowlist, and omitted authority falls back to ordinary user approval during a run. The running automation is added to this chat as an inspectable pill before the tool returns.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short automation name." },
          summary: {
            type: "string",
            description: "Plain-language purpose and cadence.",
          },
          action: {
            oneOf: [
              {
                type: "object",
                properties: {
                  kind: { const: "prompt" },
                  text: { type: "string" },
                },
                required: ["kind", "text"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { const: "eval" },
                  code: { type: "string" },
                  syntax: { enum: ["javascript", "typescript", "jsx", "tsx"] },
                  timeoutMs: { type: "integer", minimum: 1 },
                  reset: { type: "boolean" },
                },
                required: ["kind", "code"],
                additionalProperties: false,
              },
            ],
          },
          trigger: {
            oneOf: [
              {
                type: "object",
                properties: { kind: { const: "manual" } },
                required: ["kind"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { const: "schedule" },
                  everyMs: { type: "integer", minimum: 60000 },
                  anchorAt: { type: "integer", minimum: 0 },
                  jitterMs: { type: "integer", minimum: 0 },
                  untilAt: { type: "integer", minimum: 0 },
                  maxRuns: { type: "integer", minimum: 1 },
                },
                required: ["kind", "everyMs"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { const: "cron" },
                  expression: { type: "string" },
                  timezone: { type: "string" },
                  untilAt: { type: "integer", minimum: 0 },
                  maxRuns: { type: "integer", minimum: 1 },
                },
                required: ["kind", "expression", "timezone"],
                additionalProperties: false,
              },
            ],
          },
          conversation: {
            type: "object",
            description:
              "Where agent wake-ups run. Omit to continue the current agent and conversation. Use fresh only when the automation is a separate topic or intentionally independent background conversation.",
            properties: { mode: { enum: ["fresh", "continue"] } },
            required: ["mode"],
            additionalProperties: false,
          },
          operations: {
            type: "array",
            description:
              "Concrete external service operations reasonably predictable across future runs, used only for launch-time authority acquisition. Include service calls selected by prompt actions as well as calls made by inline eval, but do not translate model-facing tools such as notify into internal service calls; this is not a runtime allowlist.",
            items: {
              type: "object",
              properties: {
                service: { type: "string" },
                method: { type: "string" },
                args: { type: "array" },
                use: { enum: ["action", "conditional"] },
              },
              required: ["service", "method", "use"],
              additionalProperties: false,
            },
          },
        },
        required: ["name", "summary", "action", "trigger"],
        additionalProperties: false,
      } as never,
      execute: async (toolCallId, params) => {
        if (!execution) {
          throw new Error(
            "launch_automation requires an admitted agent invocation",
          );
        }
        const activeTurn =
          this.driver.peekLoadedLoop(channelId)?.state.openTurn;
        if (activeTurn?.metadata?.automation) {
          throw new Error(
            "A scheduled automation cannot launch another automation",
          );
        }
        const automation = await this.launchAutomation(
          channelId,
          params,
          execution.commandId || toolCallId,
          execution.rpc,
        );
        return {
          content: [
            {
              type: "text",
              text: `${automation.name} is running. Its automation pill is now available in this chat.`,
            },
          ],
          details: automation,
        } as AgentToolResult<MissionRecord>;
      },
    } as AgentTool;
  }

  protected createAutomationControlTool(
    channelId: string,
    execution?: AgentToolExecutionContext,
  ): AgentTool {
    return {
      name: "control_automation",
      label: "control_automation",
      description:
        "Control an automation owned by the current user directly. Use pause when the user says stop, disable, or turn it off; pause is reversible and must not be treated as deletion. Use retire only when the user explicitly asks to remove or delete the automation permanently. Do not inspect automation APIs, discover services, or use eval first. Omit the target only when exactly one matching automation is active in this conversation; otherwise pass its exact name or missionId from the launch result or automation pill.",
      parameters: {
        type: "object",
        properties: {
          action: { enum: ["pause", "resume", "run_now", "retire"] },
          missionId: { type: "string" },
          name: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      } as never,
      execute: async (toolCallId, params) => {
        if (!execution) {
          throw new Error(
            "control_automation requires an admitted agent invocation",
          );
        }
        return this.controlAutomation(
          channelId,
          params,
          execution.commandId || toolCallId,
          execution.rpc,
        );
      },
    } as AgentTool;
  }

  private createAutomationCompletionTool(channelId: string): AgentTool {
    return {
      name: "complete_automation",
      label: "complete_automation",
      description:
        "Complete the current recurring automation and prevent future ticks. This is available only inside a scheduled automation turn. Call it when the automation's natural goal is finished; the response is retained in the run and automation history.",
      parameters: {
        type: "object",
        properties: {
          response: {
            type: "string",
            description:
              "Concise final explanation of what completed and why no more ticks are needed.",
          },
        },
        required: ["response"],
        additionalProperties: false,
      } as never,
      execute: async (_toolCallId, params) => {
        const response = String(
          (params as { response?: unknown }).response ?? "",
        ).trim();
        if (!response)
          throw new Error("complete_automation requires a completion response");
        if (response.length > 24_000) {
          throw new Error(
            "complete_automation response exceeds 24000 characters",
          );
        }
        const turn = this.driver.peekLoadedLoop(channelId)?.state.openTurn;
        const automation = turn?.metadata?.automation;
        if (!turn || !automation) {
          throw new Error(
            "complete_automation is only available during an automation turn",
          );
        }
        this.setStateValue(
          automationCompletionStateKey(automation.runId),
          JSON.stringify({ channelId, turnId: turn.turnId, response }),
        );
        return {
          content: [
            {
              type: "text",
              text: "Automation completion recorded; no future ticks will be scheduled.",
            },
          ],
          details: { protocol: MISSION_COMPLETION_PROTOCOL, response },
          terminate: true,
        } as AgentToolResult<Record<string, unknown>>;
      },
    } as AgentTool;
  }

  /**
   * Workspace memory search (WS4): chat messages, committed file content, and
   * commit summaries with provenance. The recall result is journaled via the
   * invocation terminal like any tool output — replays and audits see exactly
   * what was recalled.
   */
  private createMemoryRecallTool(): AgentTool<never> {
    return {
      name: "memory_recall",
      label: "memory_recall",
      executionMode: "parallel",
      description:
        "Search workspace memory: past conversation messages, committed file content, and commit summaries. " +
        "Returns snippets with provenance (who/when/where). Use before re-deriving facts that may already be known.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search terms." },
          kinds: {
            type: "array",
            items: { type: "string", enum: ["message", "file", "commit"] },
            description:
              "Optional filter by memory kind. Commit summaries retain decisions whose text has left current files.",
          },
          limit: {
            type: "number",
            description: "Max results (default 10, max 50).",
          },
        },
        required: ["query"],
      } as never,
      execute: async (_toolCallId, params) => {
        const input = params as {
          query?: unknown;
          kinds?: unknown;
          limit?: unknown;
        };
        if (typeof input.query !== "string" || !input.query.trim()) {
          throw new Error("memory_recall requires a non-empty query");
        }
        const recall = await this.callGad<{
          results: Array<{
            kind: string;
            snippet: string;
            path: string | null;
            eventId: string | null;
            actor: unknown;
            appendedAt: string | null;
          }>;
        }>("recallMemory", {
          query: input.query,
          kinds: Array.isArray(input.kinds)
            ? input.kinds.filter(
                (kind): kind is string => typeof kind === "string",
              )
            : null,
          limit: typeof input.limit === "number" ? input.limit : null,
        });
        for (const result of recall.results) {
          const origin =
            result.actor &&
            typeof result.actor === "object" &&
            "id" in result.actor
              ? String((result.actor as { id: unknown }).id)
              : (result.eventId ?? "memory-unknown");
          await this.recordDerivedSessionIngestion(origin, "memory-recall");
        }
        const lines = recall.results.map((result) => {
          const where =
            result.path ??
            (result.actor &&
            typeof result.actor === "object" &&
            "id" in result.actor
              ? String((result.actor as { id: unknown }).id)
              : (result.eventId ?? "unknown"));
          const when = result.appendedAt ? ` @ ${result.appendedAt}` : "";
          return `[${result.kind}] ${where}${when}\n${result.snippet}`;
        });
        return {
          content: [
            {
              type: "text" as const,
              text:
                lines.length > 0
                  ? lines.join("\n\n")
                  : "No memory matched the query.",
            },
          ],
          details: { resultCount: recall.results.length } as never,
        };
      },
    };
  }

  // ── Channel membership ───────────────────────────────────────────────────

  // Membership is established by the userland owner that created or acquired
  // the agent. Host lifecycle code can interrupt an active vessel, but does not
  // join it to arbitrary channels on a product service's behalf.
  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async subscribeChannel(opts: {
    channelId: string;
    contextId: string;
    config?: unknown;
    replay?: boolean;
    delivery?: "all" | "addressed";
  }): Promise<{ ok: boolean; participantId: string }> {
    const subscriptionStartedAt = Date.now();
    this.traceHotPath(opts.channelId, "subscription.started");
    this.ensureIdentity();
    // AgentLoopDriver activation synchronously materializes its config. Resolve
    // extension-owned local model metadata before that boundary so every
    // installed local model is bootable, not only the bundled model with a
    // static fallback descriptor.
    await this.refreshLocalModelEntry(opts.channelId);
    // Addressed-only memberships are supervision endpoints, not alternate
    // execution homes. Activating one lets recovery fold the child's open turn
    // under the supervisor's identity and corrupts both transcript ownership
    // and host-bound tool causality.
    if (opts.delivery !== "addressed") {
      this.driver.activateChannel(opts.channelId);
    } else {
      this.driver.dropLoop(opts.channelId);
    }
    const descriptor = this.getEffectiveParticipantInfo(
      opts.channelId,
      opts.config,
    );
    // Subscription is MEMBERSHIP + presentation only. Behavior config (model,
    // approvalLevel, respondPolicy, …) is per-agent and seeded at creation from
    // STATE_ARGS.agentConfig — it does NOT ride the subscription. `config` here
    // carries only channel-presentation (handle, systemPrompt) consumed via the
    // participant descriptor / getPromptOverride.
    let result: Awaited<ReturnType<SubscriptionManager["subscribe"]>>;
    result = await this.subscriptions.subscribe({
      channelId: opts.channelId,
      contextId: opts.contextId,
      config: opts.config,
      descriptor,
      replay: opts.replay,
      delivery: opts.delivery,
    });
    await this.ingestSubscriptionReplay(
      opts.channelId,
      result.envelope,
      configuredWakePolicy(opts.config) === "every-envelope",
    );
    this.traceHotPath(opts.channelId, "subscription.completed", {
      startedAt: subscriptionStartedAt,
      details: { replay: opts.replay === true },
    });
    return { ok: result.ok, participantId: result.participantId };
  }

  /** Adopt this concrete vessel's durable queues for one server generation. */
  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async adoptDurableWorkWorker(
    workerId: string,
  ): Promise<{ adopted: boolean; previousWorkerId: string | null }> {
    const adoption = this.adoptDurableWorkWorkerGeneration(workerId);
    if (adoption.adopted) this._durableWorkActivationRecovered = false;
    if (
      !this._durableWorkActivationRecovered &&
      !this._durableWorkActivationRecovery
    ) {
      const recovery = (async () => {
        for (const channelId of this.subscriptions.listChannelIds()) {
          if (this.subscriptions.ownsReasoningLoop(channelId)) {
            await this.driver.wake(channelId);
          }
        }
        this._durableWorkActivationRecovered = true;
      })();
      this._durableWorkActivationRecovery = recovery;
      const clearRecovery = () => {
        if (this._durableWorkActivationRecovery === recovery) {
          this._durableWorkActivationRecovery = null;
        }
      };
      void recovery.then(clearRecovery, clearRecovery);
    }
    await this._durableWorkActivationRecovery;
    return adoption;
  }

  /**
   * Canonical unattended prompt ingress. The automation registry owns the
   * schedule and run ledger; the agent vessel owns only the ordinary durable
   * turn. `runId` is carried through the journal so the terminal turn can
   * close the exact ledger row without polling the conversation.
   */
  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async runAutomationTurn(input: {
    channelId: string;
    prompt: string;
    automation: NonNullable<AgentTurnMetadata["automation"]>;
  }): Promise<void> {
    if (!this.subscriptions.listChannelIds().includes(input.channelId)) {
      throw new Error(
        `Automation channel ${input.channelId} is not subscribed`,
      );
    }
    if (!input.automation.runId || !input.prompt.trim()) {
      throw new Error("Automation turn requires provenance and prompt text");
    }
    const existing = await this.describeAutomationRun({
      channelId: input.channelId,
      runId: input.automation.runId,
    });
    if (existing.state !== "not-found") return;
    const tickPrompt = `${input.prompt.trim()}

<automation-tick>
This is one admitted recurring-automation tick. If this tick establishes that the recurring goal is naturally finished and no future tick is needed, call complete_automation exactly once with a concise completion response. Otherwise finish normally so the schedule continues. Do not call complete_automation merely because this individual tick succeeded.
</automation-tick>`;
    await this.submitAgentInitiatedTurn(
      input.channelId,
      { content: tickPrompt },
      {
        steeringId: `automation:${input.automation.runId}`,
        origin: "scheduled",
        automation: input.automation,
        delivery: "channel",
        deliverAfterTurn: true,
      },
    );
  }

  /**
   * Canonical model-free automation ingress. The exact revision source is
   * journaled as an ordinary eval invocation and runs in this agent/channel's
   * EvalDO, so ambient `chat` publishes with this agent's durable identity.
   */
  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async runAutomationEval(input: {
    channelId: string;
    automation: NonNullable<AgentTurnMetadata["automation"]>;
    eval: {
      code: string;
      syntax?: "javascript" | "typescript" | "jsx" | "tsx";
      timeoutMs?: number;
      reset?: boolean;
    };
  }): Promise<void> {
    if (!this.subscriptions.listChannelIds().includes(input.channelId)) {
      throw new Error(
        `Automation channel ${input.channelId} is not subscribed`,
      );
    }
    if (!input.automation.runId || !input.eval.code.trim()) {
      throw new Error("Automation eval requires provenance and inline code");
    }
    const existing = await this.describeAutomationRun({
      channelId: input.channelId,
      runId: input.automation.runId,
    });
    if (existing.state !== "not-found") return;
    await this.driver.handleIncoming(input.channelId, {
      type: "command",
      command: {
        kind: "invoke",
        channelId: input.channelId,
        source: { envelopeId: `automation:${input.automation.runId}` },
        tool: "eval",
        args: {
          code: input.eval.code,
          ...(input.eval.syntax ? { syntax: input.eval.syntax } : {}),
          ...(input.eval.timeoutMs ? { timeoutMs: input.eval.timeoutMs } : {}),
          ...(input.eval.reset === true ? { reset: true } : {}),
          authority: { approvals: "prompt" },
        },
        metadata: {
          origin: "scheduled",
          automation: input.automation,
          completion: "after-invocation",
          delivery: "channel",
        },
      },
    });
  }

  /** Receiver-owned evidence for an automation dispatch. This method hydrates
   * the durable channel fold when needed; it never treats activation-local
   * cache absence as evidence that a run is missing. */
  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async describeAutomationRun(input: {
    channelId: string;
    runId: string;
  }): Promise<AutomationExecutorRunStatus> {
    if (!this.subscriptions.listChannelIds().includes(input.channelId)) {
      throw new Error(
        `Automation channel ${input.channelId} is not subscribed`,
      );
    }
    const terminal = automationRunReceipt(
      this.getStateValue(automationRunReceiptKey(input.runId)),
      input.channelId,
    );
    if (terminal) return terminal;
    const loop = await this.driver.loop(input.channelId);
    const turn = loop.state.openTurn;
    if (turn?.metadata?.automation?.runId !== input.runId)
      return { state: "not-found" };
    return {
      state: "running",
      channelId: input.channelId,
      turnId: turn.turnId,
      waiting: turn.waitingAtSeq !== undefined || turn.waitingCount > 0,
    };
  }

  /** MissionsDO calls this only after its terminal ledger row is durable. A
   * missed acknowledgement merely retains replay evidence; it cannot reopen or
   * duplicate the run. */
  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async acknowledgeAutomationRun(input: {
    channelId: string;
    runId: string;
  }): Promise<void> {
    const terminal = automationRunReceipt(
      this.getStateValue(automationRunReceiptKey(input.runId)),
      input.channelId,
    );
    if (terminal) this.deleteStateValue(automationRunReceiptKey(input.runId));
  }

  private async ingestSubscriptionReplay(
    channelId: string,
    envelope: ChannelReplayEnvelope | undefined,
    wakeAfterReplay: boolean,
  ): Promise<void> {
    let page = envelope;
    for (;;) {
      if (page?.logEvents?.length) {
        for (const event of page.logEvents) {
          await this.processSubscriptionReplayEvent(channelId, event);
        }
      }
      if (page?.mode !== "after" || !page.ready.hasMoreAfter) break;
      const after = page.ready.replayToId;
      const throughSeq = page.ready.snapshotLastSeq;
      if (after === undefined || throughSeq === undefined) {
        throw new Error(
          "subscription replay claims more history without a stable cursor",
        );
      }
      page = await this.createChannelClient(channelId).getReplayAfter({
        after,
        throughSeq,
      });
    }
    if (wakeAfterReplay) await this.driver.wake(channelId);
  }

  private async processSubscriptionReplayEvent(
    channelId: string,
    event: ChannelReplayEnvelope["logEvents"][number],
  ): Promise<void> {
    const contentIntegrity = event as typeof event &
      Pick<ChannelEvent, "contentClass" | "externalKeys">;
    await this.processChannelEvent(channelId, {
      id: event.id,
      messageId: event.messageId,
      type: event.type,
      payload: event.payload,
      senderId: event.senderId,
      ts: event.ts,
      ...(event.senderMetadata ? { senderMetadata: event.senderMetadata } : {}),
      ...(event.contentType ? { contentType: event.contentType } : {}),
      ...(event.attachments ? { attachments: event.attachments } : {}),
      contentClass: contentIntegrity.contentClass,
      externalKeys: contentIntegrity.externalKeys,
      ...((event as unknown as { annotations?: Record<string, unknown> })
        .annotations
        ? {
            annotations: (
              event as unknown as { annotations: Record<string, unknown> }
            ).annotations,
          }
        : {}),
    });
  }

  // Symmetric with `subscribeChannel`: an owning userland service must be able
  // to detach a vessel during lifecycle cleanup.
  @rpc({
    principals: ["user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async unsubscribeChannel(channelId: string): Promise<{ ok: boolean }> {
    // A deferred eval is no longer an active agent-loop dispatch after
    // `eval.start` acknowledges it, so interrupting the loop cannot cancel it.
    // Retire the child run before ending channel membership; otherwise the
    // EvalDO keeps its kernel lease and any open host resource after the agent
    // has disappeared. Never blocks: an unreachable EvalDO leaves a durable
    // cancel intent behind and unsubscribe proceeds.
    await this.cancelDeferredEvalRuns(channelId);
    try {
      await this.driver.abortChannel(channelId, "channel_unsubscribe");
      await this.subscriptions.unsubscribeFromChannel(channelId);
    } finally {
      this.subscriptions.deleteSubscription(channelId);
      this.driver.dropLoop(channelId);
    }
    return { ok: true };
  }

  // ── Channel intake ───────────────────────────────────────────────────────

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async acceptChannelDelivery(
    delivery: ChannelDeliveryInput,
  ): Promise<ChannelDeliveryOutcome> {
    const recipientExecutionStartedAt = Date.now();
    this.ensureIdentity();
    if (delivery.channelRef.objectKey !== delivery.channelId) {
      throw new Error("acceptChannelDelivery: channel identity mismatch");
    }
    const storedParticipantId = this.subscriptions.getParticipantId(
      delivery.channelId,
    );
    const stored = this.subscriptions
      .listStored()
      .find(({ channelId }) => channelId === delivery.channelId);
    const envelopeJson = JSON.stringify(delivery.envelope);
    const agenticContextJson = JSON.stringify(delivery.agenticContext);
    const existing = this.sql
      .exec(
        `SELECT channel_id, participant_id, subscription_revision, event_sequence,
                envelope_json, agentic_context_json, state, outcome_json
           FROM channel_delivery_admissions WHERE delivery_id = ?`,
        delivery.deliveryId,
      )
      .toArray()[0];
    if (existing) {
      if (
        existing["channel_id"] !== delivery.channelId ||
        existing["participant_id"] !== delivery.participantId ||
        Number(existing["subscription_revision"]) !==
          delivery.subscriptionRevision ||
        Number(existing["event_sequence"]) !== delivery.eventSequence ||
        // Terminal rows shed their envelope bytes (storage bound); the
        // deterministic delivery id plus the coordinate columns above remain
        // the duplicate identity. Compare bytes only while retained.
        (existing["envelope_json"] !== null &&
          existing["envelope_json"] !== envelopeJson) ||
        (existing["agentic_context_json"] !== null &&
          existing["agentic_context_json"] !== agenticContextJson)
      ) {
        throw new Error(
          `acceptChannelDelivery: mismatched duplicate ${delivery.deliveryId}`,
        );
      }
      if (
        existing["state"] === "processed" ||
        existing["state"] === "declined"
      ) {
        const retained = JSON.parse(
          String(existing["outcome_json"]),
        ) as ChannelDeliveryOutcome;
        return {
          ...retained,
          disposition:
            existing["state"] === "processed" ? "duplicate" : "declined",
          recipientExecutionStartedAt,
        };
      }
    }
    // The delivery's subscriptionRevision is the channel's at-sequence stamp;
    // the locally stored revision may legitimately be newer (or, across a
    // crash between the join append and the local store, older). Membership
    // at the event sequence is the channel's routing decision — decline only
    // when this vessel is not the addressed participant at all.
    if (storedParticipantId !== delivery.participantId || !stored) {
      if (delivery.participantId === this.participantId() && !stored) {
        throw Object.assign(
          new Error(
            "acceptChannelDelivery: local subscription commit is still pending",
          ),
          { code: "SubscriptionCommitPending" },
        );
      }
      const outcome: ChannelDeliveryOutcome = {
        deliveryId: delivery.deliveryId,
        disposition: "declined",
        recipientExecutionStartedAt,
      };
      this.sql.exec(
        `INSERT OR REPLACE INTO channel_delivery_admissions (
           delivery_id, channel_id, participant_id, subscription_revision,
           event_sequence, envelope_json, agentic_context_json, state, outcome_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'declined', ?, ?, ?)`,
        delivery.deliveryId,
        delivery.channelId,
        delivery.participantId,
        delivery.subscriptionRevision,
        delivery.eventSequence,
        JSON.stringify(outcome),
        Date.now(),
        Date.now(),
      );
      return outcome;
    }
    if (!existing) {
      const now = Date.now();
      this.sql.exec(
        `INSERT INTO channel_delivery_admissions (
           delivery_id, channel_id, participant_id, subscription_revision,
           event_sequence, envelope_json, agentic_context_json, state, outcome_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'admitted', NULL, ?, ?)`,
        delivery.deliveryId,
        delivery.channelId,
        delivery.participantId,
        delivery.subscriptionRevision,
        delivery.eventSequence,
        envelopeJson,
        agenticContextJson,
        now,
        now,
      );
    }
    this.traceHotPath(delivery.channelId, "delivery.admitted", {
      source: "channel-delivery",
      itemId: delivery.deliveryId,
    });
    const envelope = delivery.envelope as RpcChannelMessage;
    if (envelope.kind !== "log" || !envelope.event) {
      throw Object.assign(
        new Error(
          "acceptChannelDelivery: durable delivery must contain one log event",
        ),
        { code: "PermanentChannelDelivery" },
      );
    }
    const agenticContext = await this.applyDeliveredAgenticContext(
      delivery.channelId,
      delivery.agenticContext,
    );
    await this.processChannelEvent(
      delivery.channelId,
      envelope.event,
      agenticContext,
    );
    const outcome: ChannelDeliveryOutcome = {
      deliveryId: delivery.deliveryId,
      disposition: "processed",
      recipientExecutionStartedAt,
    };
    this.sql.exec(
      `UPDATE channel_delivery_admissions
          SET state = 'processed', outcome_json = ?, envelope_json = NULL,
              agentic_context_json = NULL, updated_at = ?
        WHERE delivery_id = ?`,
      JSON.stringify(outcome),
      Date.now(),
      delivery.deliveryId,
    );
    this.traceHotPath(delivery.channelId, "delivery.processed", {
      source: "channel-delivery",
      itemId: delivery.deliveryId,
    });
    return outcome;
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  claimReadyWork(queue: DurableWorkQueue, input: ClaimRequest): WorkClaim[] {
    if (!input.workerId || input.limit < 1) {
      throw new Error("claimReadyWork: invalid claim request");
    }
    this.adoptDurableWorkWorkerGeneration(input.workerId);
    if (queue === "agent-effect") {
      const claimed = this.driver.outbox.claimReady(input).map((row) => ({
        itemId: outboxExternalId(row.branchId, row.effectId),
        generation: row.leaseGeneration,
        idempotencyKey: row.idempotencyKey,
        createdAt: row.createdAt,
        attempt: row.attempts + 1,
        payload: {
          // Once eval.start is durably acknowledged, ANY claim of the row is
          // structurally the eval.get delivery-loss backstop — the parked-row
          // alarm arrives with an ordinary "hint" trigger, so keying on the
          // trigger would label the production backstop path as healthy work.
          claimSource:
            row.descriptor.kind === "local_tool" &&
            row.descriptor.tool === "eval" &&
            (row.descriptor as { deferredEvalStartAttempted?: boolean })
              .deferredEvalStartAttempted === true
              ? "redrive-backstop"
              : (input.trigger ?? "unknown"),
          laneKey:
            row.kind === "record_receipt" ||
            row.kind === "channel_call" ||
            row.kind === "http_call" ||
            (row.descriptor.kind === "local_tool" &&
              row.descriptor.executionMode === "parallel")
              ? `${row.channelId}\u0000${row.effectId}`
              : row.channelId,
          channelId: row.channelId,
          kind: row.kind,
        },
      }));
      for (const claim of claimed) {
        const channelId = String(
          (claim.payload as { channelId?: unknown } | null)?.channelId ?? "",
        );
        if (channelId) {
          this.traceHotPath(channelId, "effect.claimed", {
            source: String(
              (claim.payload as { claimSource?: unknown } | null)
                ?.claimSource ?? "unknown",
            ),
            itemId: claim.itemId,
            generation: claim.generation,
          });
        }
      }
      if (!this.readyDurableWorkQueues(input.now).includes("agent-effect")) {
        this.acknowledgeDurableWorkReady("agent-effect");
      }
      return claimed;
    }
    if (queue !== "agent-wake") return [];
    const claimed = this.ctx.storage.transactionSync(() => {
      let scheduledResumes: Record<string, unknown>[] = [];
      try {
        scheduledResumes = this.sql
          .exec(
            `SELECT channel_id, message_id, reset_at_ms, created_at
               FROM scheduled_model_resumes
              WHERE reset_at_ms <= ?`,
            input.now,
          )
          .toArray();
      } catch {
        // Scheduled-resume storage is lazy.
      }
      for (const resume of scheduledResumes) {
        const channelId = String(resume["channel_id"]);
        const messageId = String(resume["message_id"]);
        const resetAtMs = Number(resume["reset_at_ms"]);
        const wakeId = `scheduled-resume:${channelId}:${messageId}`;
        this.sql.exec(
          `INSERT OR IGNORE INTO agent_wake_queue (
             wake_id, channel_id, wake_kind, payload_json, prerequisite_delivery_id,
             idempotency_key, attempts, next_attempt_at, lease_generation, created_at,
             disposition
           ) VALUES (?, ?, 'scheduled-model-resume', ?, NULL, ?, 0, ?, 0, ?, 'ready')`,
          wakeId,
          channelId,
          JSON.stringify({ messageId }),
          wakeId,
          resetAtMs,
          Number(resume["created_at"]),
        );
      }
      const candidates = this.sql
        .exec(
          `SELECT *
             FROM agent_wake_queue
            WHERE disposition IN ('ready', 'retrying') AND next_attempt_at <= ?
              AND (
                prerequisite_delivery_id IS NULL OR EXISTS (
                  SELECT 1 FROM channel_delivery_admissions AS admission
                   WHERE admission.delivery_id = agent_wake_queue.prerequisite_delivery_id
                     AND admission.state IN ('processed', 'declined')
                )
              )
            ORDER BY channel_id, created_at
            LIMIT ?`,
          input.now,
          Math.min(input.limit * 4, 1_000),
        )
        .toArray();
      const selected: typeof candidates = [];
      const channels = new Set<string>();
      for (const row of candidates) {
        const channelId = String(row["channel_id"]);
        if (channels.has(channelId)) continue;
        channels.add(channelId);
        selected.push(row);
        if (selected.length >= input.limit) break;
      }
      return selected.map((row) => {
        const wakeId = String(row["wake_id"]);
        const generation = Number(row["lease_generation"] ?? 0) + 1;
        this.sql.exec(
          `UPDATE agent_wake_queue
              SET disposition = 'leased',
                  lease_owner = ?,
                  lease_generation = ?,
                  last_attempt_at = ?
            WHERE wake_id = ?`,
          input.workerId,
          generation,
          input.now,
          wakeId,
        );
        return {
          itemId: wakeId,
          generation,
          idempotencyKey: String(row["idempotency_key"]),
          createdAt: Number(row["created_at"]),
          attempt: Number(row["attempts"] ?? 0) + 1,
          payload: {
            laneKey: String(row["channel_id"]),
            channelId: String(row["channel_id"]),
            wakeKind: String(row["wake_kind"]),
          },
        };
      });
    });
    for (const claim of claimed) {
      const channelId = String(
        (claim.payload as { channelId?: unknown } | null)?.channelId ?? "",
      );
      if (channelId) {
        this.traceHotPath(channelId, "wake.claimed", {
          source: input.trigger ?? "unknown",
          itemId: claim.itemId,
          generation: claim.generation,
        });
      }
    }
    if (!this.readyDurableWorkQueues(input.now).includes("agent-wake")) {
      this.acknowledgeDurableWorkReady("agent-wake");
    }
    return claimed;
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async executeWakeClaim(input: {
    itemId: string;
    generation: number;
  }): Promise<{
    processed: true;
  }> {
    const row = this.sql
      .exec(
        `SELECT channel_id, wake_kind, payload_json
           FROM agent_wake_queue
          WHERE wake_id = ?
            AND lease_generation = ?
            AND disposition = 'leased'`,
        input.itemId,
        input.generation,
      )
      .toArray()[0];
    if (!row) throw new Error("executeWakeClaim: stale claim");
    const channelId = String(row["channel_id"]);
    const startedAt = Date.now();
    this.traceHotPath(channelId, "wake.execution.started", {
      itemId: input.itemId,
      generation: input.generation,
    });
    const wakeKind = String(row["wake_kind"]);
    const payload = JSON.parse(String(row["payload_json"])) as Record<
      string,
      unknown
    >;
    if (wakeKind === "subagent-terminal-publish") {
      if (
        typeof payload["runId"] !== "string" ||
        typeof payload["taskChannelId"] !== "string" ||
        typeof payload["parentRef"] !== "string" ||
        typeof payload["report"] !== "string"
      ) {
        throw Object.assign(
          new Error(
            "executeWakeClaim: invalid subagent-terminal-publish payload",
          ),
          { code: "PermanentDurableWork" },
        );
      }
      await this.publishOwnSubagentTerminal({
        runId: String(payload["runId"]),
        taskChannelId: String(payload["taskChannelId"]),
        parentRef: String(payload["parentRef"]),
        report: String(payload["report"]),
        outcome:
          payload["outcome"] === "failed"
            ? "failed"
            : payload["outcome"] === "cancelled"
              ? "cancelled"
              : "completed",
        sourceEventId:
          typeof payload["sourceEventId"] === "string"
            ? payload["sourceEventId"]
            : null,
      });
    } else if (wakeKind === "subagent-cancel-settle") {
      // PARENT side: re-drive an interrupted cancellation to its terminal
      // fact. Idempotent — a run already terminal no-ops.
      if (typeof payload["runId"] !== "string") {
        throw Object.assign(
          new Error("executeWakeClaim: invalid subagent-cancel-settle payload"),
          {
            code: "PermanentDurableWork",
          },
        );
      }
      await this.driveCancelSubagent(
        String(payload["runId"]),
        typeof payload["reason"] === "string" ? payload["reason"] : "cancelled",
      );
    } else if (wakeKind === "turn-recovery") {
      await this.driver.wake(channelId);
    } else if (
      wakeKind === "scheduled-model-resume" &&
      typeof payload["messageId"] === "string"
    ) {
      await this.driver.executeScheduledResume(channelId, payload["messageId"]);
    } else {
      throw Object.assign(
        new Error(`executeWakeClaim: invalid ${wakeKind} payload`),
        {
          code: "PermanentDurableWork",
        },
      );
    }
    this.traceHotPath(channelId, "wake.execution.completed", {
      startedAt,
      itemId: input.itemId,
      generation: input.generation,
    });
    return { processed: true };
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async executeEffectClaim(input: {
    itemId: string;
    generation: number;
  }): Promise<{
    executed: true;
  }> {
    const parsed = parseOutboxExternalId(input.itemId);
    const channelId = parsed
      ? this.driver.outbox.get(parsed.branchId, parsed.effectId)?.channelId
      : undefined;
    const startedAt = Date.now();
    if (channelId) {
      this.traceHotPath(channelId, "effect.execution.started", {
        itemId: input.itemId,
        generation: input.generation,
      });
    }
    await this.driver.executeClaimedEffect(input.itemId, input.generation);
    if (channelId) {
      this.traceHotPath(channelId, "effect.execution.completed", {
        startedAt,
        itemId: input.itemId,
        generation: input.generation,
      });
    }
    return { executed: true };
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  settleReadyWork(
    queue: DurableWorkQueue,
    request: SettleRequest,
  ): ClaimSettlement {
    if (queue === "agent-effect") {
      const parsed = parseOutboxExternalId(request.itemId);
      if (!parsed) throw new Error("settleReadyWork: invalid effect identity");
      const row = this.driver.outbox.get(parsed.branchId, parsed.effectId);
      if (!row) return "duplicate";
      if (
        row.leaseGeneration !== request.generation ||
        (row.leaseOwner !== null && row.leaseOwner !== request.workerId)
      ) {
        return "stale";
      }
      if (row.disposition === "leased") {
        if (this.driver.isActivationReleased()) return "stale";
        throw new Error(
          "settleReadyWork: effect execution left its claim leased",
        );
      }
      this.traceHotPath(row.channelId, "effect.settled", {
        source: request.workerId,
        itemId: request.itemId,
        generation: request.generation,
      });
      return "accepted";
    }
    if (queue !== "agent-wake") return "stale";
    const settlement = this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec(
          `SELECT lease_owner, lease_generation, disposition
             FROM agent_wake_queue
            WHERE wake_id = ?`,
          request.itemId,
        )
        .toArray()[0];
      if (!row) return { disposition: "duplicate" as const, channelId: null };
      if (
        row["lease_owner"] !== request.workerId ||
        Number(row["lease_generation"]) !== request.generation ||
        row["disposition"] !== "leased"
      ) {
        return { disposition: "stale" as const, channelId: null };
      }
      const channel = this.sql
        .exec(
          `SELECT channel_id, wake_kind FROM agent_wake_queue WHERE wake_id = ?`,
          request.itemId,
        )
        .toArray()[0];
      if (
        channel?.["wake_kind"] === "scheduled-model-resume" ||
        channel?.["wake_kind"] === "turn-recovery"
      ) {
        // This wake id is reusable when the same message is legitimately
        // scheduled again. Keeping a terminal row would make INSERT OR IGNORE
        // swallow that later schedule forever.
        this.sql.exec(
          `DELETE FROM agent_wake_queue WHERE wake_id = ?`,
          request.itemId,
        );
      } else {
        this.sql.exec(
          `UPDATE agent_wake_queue
              SET disposition = 'terminal-completed',
                  lease_owner = NULL
            WHERE wake_id = ?`,
          request.itemId,
        );
      }
      return {
        disposition: "accepted" as const,
        channelId: channel ? String(channel["channel_id"]) : null,
      };
    });
    if (settlement.channelId) {
      this.traceHotPath(settlement.channelId, "wake.settled", {
        source: request.workerId,
        itemId: request.itemId,
        generation: request.generation,
      });
    }
    return settlement.disposition;
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  failReadyWork(
    queue: DurableWorkQueue,
    request: {
      workerId: string;
      itemId: string;
      generation: number;
      error?: unknown;
    },
  ): { retryAt: number } | "stale" {
    if (queue === "agent-effect") {
      const parsed = parseOutboxExternalId(request.itemId);
      if (!parsed) return "stale";
      const row = this.driver.outbox.get(parsed.branchId, parsed.effectId);
      if (
        !row ||
        row.leaseOwner !== request.workerId ||
        row.leaseGeneration !== request.generation ||
        row.disposition !== "leased"
      ) {
        return "stale";
      }
      const updated = this.driver.outbox.recordFailure(
        parsed.branchId,
        parsed.effectId,
        Date.now(),
      );
      const retryAt = updated?.nextAttemptAt;
      if (retryAt === null || retryAt === undefined) return "stale";
      return { retryAt };
    }
    if (queue !== "agent-wake") return "stale";
    return this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec(
          `SELECT attempts
             FROM agent_wake_queue
            WHERE wake_id = ?
              AND lease_owner = ?
              AND lease_generation = ?
              AND disposition = 'leased'`,
          request.itemId,
          request.workerId,
          request.generation,
        )
        .toArray()[0];
      if (!row) return "stale";
      const errorCode =
        request.error && typeof request.error === "object"
          ? (request.error as { code?: unknown }).code
          : undefined;
      if (errorCode === "PermanentDurableWork") {
        this.sql.exec(
          `UPDATE agent_wake_queue
              SET disposition = 'terminal-poison', lease_owner = NULL
            WHERE wake_id = ? AND lease_owner = ? AND lease_generation = ?`,
          request.itemId,
          request.workerId,
          request.generation,
        );
        return { retryAt: Date.now() };
      }
      const attempts = Number(row["attempts"] ?? 0) + 1;
      const delay = Math.min(
        CHANNEL_ENVELOPE_RETRY_MS * 2 ** Math.min(attempts - 1, 7),
        CHANNEL_ENVELOPE_MAX_RETRY_MS,
      );
      const retryAt = Date.now() + delay;
      this.sql.exec(
        `UPDATE agent_wake_queue
            SET attempts = ?,
                disposition = 'retrying',
                next_attempt_at = ?,
                lease_owner = NULL
          WHERE wake_id = ?
            AND lease_owner = ?
            AND lease_generation = ?`,
        attempts,
        retryAt,
        request.itemId,
        request.workerId,
        request.generation,
      );
      return { retryAt };
    });
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  durableWorkStatus(): {
    readyQueues: DurableWorkQueue[];
    nextRecoveryAt: number | null;
  } {
    return {
      readyQueues: this.readyDurableWorkQueues(),
      nextRecoveryAt: this.nextDurableWorkRecoveryAt(),
    };
  }

  private readyDurableWorkQueues(now = Date.now()): DurableWorkQueue[] {
    const wakeReady =
      this.sql
        .exec(
          `SELECT 1
             FROM agent_wake_queue
            WHERE disposition IN ('ready', 'retrying') AND next_attempt_at <= ?
            LIMIT 1`,
          now,
        )
        .toArray().length > 0;
    let effectReady = false;
    let scheduledResumeReady = false;
    try {
      effectReady =
        this.sql
          .exec(
            `SELECT 1
               FROM effect_outbox
              WHERE (
                disposition IN ('ready', 'retrying', 'parked')
                AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
              )
              LIMIT 1`,
            now,
          )
          .toArray().length > 0;
    } catch {
      // Effect storage is lazy.
    }
    try {
      scheduledResumeReady =
        this.sql
          .exec(
            `SELECT 1 FROM scheduled_model_resumes WHERE reset_at_ms <= ? LIMIT 1`,
            now,
          )
          .toArray().length > 0;
    } catch {
      // Scheduled-resume storage is lazy.
    }
    return [
      ...(wakeReady || scheduledResumeReady ? (["agent-wake"] as const) : []),
      ...(effectReady ? (["agent-effect"] as const) : []),
    ];
  }

  private nextDurableWorkRecoveryAt(): number | null {
    const wakeValue = this.sql
      .exec(
        `SELECT MIN(next_attempt_at) AS due
           FROM agent_wake_queue
          WHERE disposition = 'retrying'`,
      )
      .toArray()[0]?.["due"];
    const wakeAt = typeof wakeValue === "number" ? wakeValue : null;
    let effectAt: number | null = null;
    try {
      const effectValue = this.sql
        .exec(
          `SELECT MIN(next_attempt_at) AS due
             FROM effect_outbox
            WHERE disposition IN ('retrying', 'parked')`,
        )
        .toArray()[0]?.["due"];
      effectAt = typeof effectValue === "number" ? effectValue : null;
    } catch {
      // Effect storage is lazy.
    }
    const candidates = [wakeAt, effectAt].filter(
      (value): value is number => typeof value === "number",
    );
    return candidates.length > 0 ? Math.min(...candidates) : null;
  }

  async processChannelEvent(
    channelId: string,
    event: ChannelEvent,
    deliveredContext?: ChannelAgenticContext,
  ): Promise<void> {
    // Invalidate the cached participant roster on any presence change, in the one sink both the
    // live stream and subscription-replay paths funnel through, so neither path
    // serves stale presence data to response policy or tool materialization.
    if (event.type === "presence") {
      this.participantCache.delete(channelId);
      this.localTools.delete(channelId);
    }
    const handledBySubclass = await this.onChannelEvent(channelId, event);
    if (await this.routeSupervisedTaskTerminal(channelId, event)) return;
    if (handledBySubclass) return;
    if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) {
      await this.routeConfiguredObservation(channelId, event);
      return;
    }
    const maybeFeedback = event.payload as AgenticEvent | null;
    if (
      maybeFeedback &&
      (maybeFeedback as { kind?: string }).kind === "ui.feedback"
    ) {
      const payload = (maybeFeedback as AgenticEvent<"ui.feedback">).payload;
      if (
        (payload.target as { participantId?: string })?.participantId ===
        this.participantId()
      ) {
        this.feedback.ingest(channelId, payload);
      }
      return;
    }
    // chatOp callMethod relay settles first: a terminal for a call WE initiated
    // on behalf of the EvalDO's `chat.callMethod` resolves its awaiting promise.
    // Like routeInvocationTerminal this must run before the message.completed
    // gate and self-sender skip (the channel journals terminals with us, the
    // caller, as sender).
    if (await this.settleChatOpCall(channelId, event)) return;
    // Outcome routing first: a channel invocation terminal for one of our
    // pending channel_call effects settles that effect. This must run BEFORE
    // the message.completed gate and the self-sender skip — the channel
    // journals call terminals with the CALLER (us) as sender.
    if (await this.routeInvocationTerminal(channelId, event)) return;

    // Edit/retract mutations target an existing message and may arrive outside
    // an open turn — route them BEFORE the message.completed-only gate, and skip
    // our own (the fold still enforces the author guard).
    if (await this.routeMessageMutation(channelId, event)) return;

    // Wake discipline (WS-5). A channel subscribed with a non-default wakePolicy
    // (task channels the supervisor watches, subscribed "explicit") retains
    // envelopes in the durable log and wakes only for explicit child-to-parent
    // communication. Ordinary child turn closure is progress, not a new prompt.
    const wakePolicy =
      this.subscriptions.getConfig(channelId)?.wakePolicy ?? "every-envelope";
    if (wakePolicy !== "every-envelope") {
      if (await this.resolveWake(channelId, event, wakePolicy)) return;
    }

    const agentic = event.payload as AgenticEvent | null;
    if (!agentic || (agentic as { kind?: string }).kind !== "message.completed")
      return;
    if (event.senderId === this.participantId()) return;

    const respond = await this.shouldRespond(
      channelId,
      event,
      deliveredContext,
    );
    if (!respond) return;

    // Sender's canonical message identity — the read-ack / edit / retract
    // correlation key. NOT derived from the recv envelope id.
    const sourceMessageId =
      ((agentic as AgenticEvent).causality?.messageId as string | undefined) ??
      undefined;

    // Validate identity before recording ingestion or allowing a subclass to
    // consume content. A transport envelope is not a durable source identity.
    if (!sourceMessageId) {
      throw new Error(
        `channel input ${event.messageId} has no canonical source message identity; refusing an unwalkable turn`,
      );
    }

    // The host resolves this exact durable message's persisted class. Do not
    // read a class from the delivered payload: a participant controls payload
    // bytes, while the GAD provenance row is product-sealed.
    await this.recordMessageIngestion(channelId, event, "channel-message");

    await this.dispatchApprovedInput(channelId, event, sourceMessageId);
  }

  private async routeConfiguredObservation(
    channelId: string,
    event: ChannelEvent,
  ): Promise<boolean> {
    const subscriptionConfig = this.subscriptions.getConfig(channelId);
    const configured = subscriptionConfig?.observations;
    if (configured === undefined) return false;
    const observationConfig = resolveAgentObservationConfig(configured);
    if (!observationConfig) {
      console.warn("[agent-vessel] invalid observation configuration", {
        channelId,
        envelopeId: event.messageId,
        payloadKind: event.type,
        truncated: false,
      });
      return false;
    }
    if (configuredWakePolicy(subscriptionConfig) !== "every-envelope")
      return false;
    if (!observationConfig.payloadKinds.has(event.type)) return false;
    if (event.senderId === this.participantId()) {
      console.debug(
        "[agent-vessel] skipped self-authored channel observation",
        {
          channelId,
          envelopeId: event.messageId,
          payloadKind: event.type,
          truncated: false,
        },
      );
      return false;
    }

    const observation = this.resolveChannelObservation(channelId, event);
    if (!observation) return false;
    await this.recordMessageIngestion(channelId, event, "channel-observation");
    await this.driver.handleIncoming(channelId, {
      type: "command",
      command: {
        kind: "prompt",
        channelId,
        source: { envelopeId: event.messageId },
        content: `Channel observation: ${event.type}`,
        structuredInput: observation,
        senderRef: observation.source.sender,
      },
    });
    console.debug("[agent-vessel] dispatched channel observation", {
      channelId,
      envelopeId: event.messageId,
      payloadKind: event.type,
      truncated: observation.truncated !== undefined,
    });
    return true;
  }

  /** A terminal task fact is both the retained card result and the supervisor
   * wake. Delivery remains pending in the channel mailbox until this finite
   * transition succeeds, so a foreground turn cannot consume or hide it. */
  private async routeSupervisedTaskTerminal(
    channelId: string,
    event: ChannelEvent,
  ): Promise<boolean> {
    if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) return false;
    const agentic = event.payload as AgenticEvent;
    const runId = agentic.causality?.taskId;
    if (typeof runId !== "string") return false;
    const run = this.subagentRuns.get(runId);
    if (!run || run.taskChannelId !== channelId) return false;
    const terminalStatus = this.authorizedSubagentTerminalStatus(run, event);
    if (!terminalStatus) {
      console.warn(
        `[agent-vessel] ignoring task terminal for ${runId}: publisher is neither the child nor an authorized supervisor terminal source`,
      );
      return false;
    }
    // The task channel is the sole first-write-wins authority for competing
    // child/supervisor terminals. Mirror these exact winning bytes before
    // advancing any local projection; a failed mirror keeps this mailbox
    // delivery retryable and can never leave the parent card permanently live.
    await this.mirrorSubagentTerminalToParent(run, agentic);
    const payload = agentic.payload as Record<string, unknown>;
    // Competing terminals (child completion racing a supervisor cancellation)
    // are fenced at PUBLICATION: both publishers share idempotency key
    // `subagent-terminal:<runId>`, so at most one terminal event ever commits
    // to the task log. Re-processing here is therefore always the SAME
    // durable terminal (a delivery retry after a failed supervisor wake), and
    // must re-run in full — status idempotently, prompt re-dispatched.
    const details =
      payload["details"] && typeof payload["details"] === "object"
        ? (payload["details"] as Record<string, unknown>)
        : payload["result"] && typeof payload["result"] === "object"
          ? (((payload["result"] as Record<string, unknown>)["details"] as
              | Record<string, unknown>
              | undefined) ?? {})
          : {};
    if (typeof details["sourceEventId"] === "string") {
      this.subagentRuns.setSourceEventId(runId, details["sourceEventId"]);
    }

    const report =
      typeof payload["summary"] === "string"
        ? payload["summary"]
        : typeof payload["reason"] === "string"
          ? payload["reason"]
          : "";
    this.admittingSubagentTerminals.set(runId, terminalStatus);
    const siblings = this.subagentRuns
      .listAll()
      .filter((candidate) => candidate.parentChannelId === run.parentChannelId)
      .map(
        (candidate) =>
          `- ${subagentRunHandle(candidate.runId)} (${candidate.label || "unlabeled"}): ${this.admittingSubagentTerminals.get(candidate.runId) ?? candidate.status}`,
      )
      .join("\n");
    const liveCount = this.subagentRuns
      .listLive()
      .filter(
        (candidate) =>
          candidate.parentChannelId === run.parentChannelId &&
          !this.admittingSubagentTerminals.has(candidate.runId),
      ).length;
    const content = [
      `Subagent "${run.label || subagentRunHandle(runId)}" ${terminalStatus}.`,
      report ? `Report:\n${report}` : "",
      "This is a durable terminal result for the existing user request, not a new request.",
      siblings ? `Supervised runs:\n${siblings}` : "",
      liveCount > 0
        ? `${liveCount} other supervised subagent${liveCount === 1 ? " remains" : "s remain"} live. Review this result now, then continue useful foreground work or suspend again.`
        : "No supervised subagents remain live. Review the retained result and continue the user goal. Integrate it only when incorporating the child's work is part of that goal; inspection-only and comparison tasks may deliberately leave it unintegrated.",
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      await this.driver.handleIncoming(run.parentChannelId, {
        type: "command",
        command: {
          kind: "prompt",
          channelId: run.parentChannelId,
          source: { envelopeId: event.messageId },
          sourceMessageId: event.messageId,
          content,
          senderRef: participantRefFromActor(agentic.actor),
          metadata: { deliverAfterTurn: true, supervisedTerminalRunId: runId },
        },
      });
      this.subagentRuns.setStatus(runId, terminalStatus);
      this.subagentRuns.touch(runId, event.ts);
    } finally {
      this.admittingSubagentTerminals.delete(runId);
    }
    // The supervisor must remain observably live until its exact terminal
    // report is durably admitted to the reasoning loop. Otherwise a
    // concurrent suspend_turn can see no live children before the report is
    // available, reject the suspension, and send the model chasing an empty
    // retained transcript. A delivery retry re-enters this same transition;
    // only successful admission advances the retained run to terminal.
    return true;
  }

  /**
   * Deliver an addressing-approved inbound message to this vessel's reasoning
   * loop. The default drives the in-process AgentLoopDriver; a vessel whose
   * reasoning loop lives OUTSIDE the system (linked agents — an attached
   * external process) overrides this to enqueue/forward instead. Runs AFTER
   * shouldRespond and the received ack, so overrides only ever see input the
   * agent should react to.
   */
  protected async dispatchApprovedInput(
    channelId: string,
    event: ChannelEvent,
    sourceMessageId: string | undefined,
  ): Promise<void> {
    // §7.2 execution fence: once this vessel (running as a subagent) has
    // committed its terminal intent, no further model execution is admitted.
    // The delivery itself still settles durably; only dispatch is refused.
    const sub = this.subagentIdentity();
    if (sub && this.subagentTerminalIntentRecorded(sub.runId)) {
      console.warn(
        `[agent-vessel] refusing post-terminal dispatch for subagent run ${sub.runId} on ${channelId}`,
      );
      return;
    }
    const agentic = event.payload as AgenticEvent | null;
    const metadata = this.turnMetadata(event);
    const command = {
      channelId,
      source: { envelopeId: event.messageId },
      ...(sourceMessageId ? { sourceMessageId } : {}),
      content: this.turnContent(channelId, event),
      senderRef: participantRefFromActor((agentic as AgenticEvent).actor),
      agentHops: event.annotations?.["agentHops"] as number | undefined,
      ...(metadata ? { metadata } : {}),
    };
    await this.driver.handleIncoming(channelId, {
      type: "command",
      command: {
        // Replayed history is deduped downstream by envelope id
        // (alreadyIngested) — only messages the loop never saw open a turn,
        // so backlog that arrived while the agent was down still gets a
        // response after replay.
        kind: "prompt",
        ...command,
      },
    });
  }

  /** Route a `message.edited` / `message.retracted` channel event to the loop
   *  as an edit/retract command. The fold enforces the author guard and the
   *  read-wins cutoff; here we only skip our own events and require a target. */
  private async routeMessageMutation(
    channelId: string,
    event: ChannelEvent,
  ): Promise<boolean> {
    if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) return false;
    const agentic = event.payload as AgenticEvent | null;
    const kind = (agentic as { kind?: string } | null)?.kind;
    if (kind !== "message.edited" && kind !== "message.retracted") return false;
    if (event.senderId === this.participantId()) return true; // our own; nothing to do
    const sourceMessageId = (agentic as AgenticEvent).causality?.messageId as
      | string
      | undefined;
    const by = participantRefFromActor((agentic as AgenticEvent).actor);
    if (!sourceMessageId || !by) return true;
    if (kind === "message.edited") {
      const payload = (agentic as AgenticEvent<"message.edited">).payload;
      await this.recordMessageIngestion(
        channelId,
        event,
        "channel-message-edit",
      );
      await this.driver.handleIncoming(channelId, {
        type: "command",
        command: { kind: "edit", sourceMessageId, blocks: payload.blocks, by },
      });
    } else {
      await this.driver.handleIncoming(channelId, {
        type: "command",
        command: { kind: "retract", sourceMessageId, by },
      });
    }
    return true;
  }

  /** Channel terminals for our pending channel_call/approval-form effects. */
  private static readonly INVOCATION_TERMINAL_KINDS = new Set([
    "invocation.completed",
    "invocation.failed",
    "invocation.cancelled",
    "invocation.abandoned",
  ]);

  /** Settle our pending channel_call effects from the channel's durable
   *  invocation terminals (the channel broadcasts them to all subscribers,
   *  including us, the caller). This IS the outcome-delivery leg of the
   *  channel_call at-least-once protocol — without it a turn that invokes a
   *  panel method (inline UI, feedback, …) never advances. Duplicate delivery is
   *  a no-op: the outbox row is gone after the first settle. */
  private async routeInvocationTerminal(
    channelId: string,
    event: ChannelEvent,
  ): Promise<boolean> {
    const agentic = event.payload as AgenticEvent;
    const kind = (agentic as { kind?: string }).kind ?? "";
    if (!kind.startsWith("invocation.")) return false;
    if (!AgentVesselBase.INVOCATION_TERMINAL_KINDS.has(kind)) {
      return true; // started/output traffic is never a prompt
    }
    const causality = ((agentic as { causality?: Record<string, unknown> })
      .causality ?? {}) as Record<string, unknown>;
    const invocationId =
      typeof causality["invocationId"] === "string"
        ? (causality["invocationId"] as string)
        : null;
    if (!invocationId) return true;
    const effectId = ids.invocationEffect(invocationId);
    const row = this.driver.outbox.getForChannel(channelId, effectId);
    if (!row || row.kind !== "channel_call") {
      // Live invocation execution is intentionally concurrent with model
      // streaming. A fast channel method may therefore publish its terminal
      // before the model outcome has derived the channel_call effect that
      // consumes it. Failing this inbox claim retains the canonical terminal
      // for the short durable retry path instead of losing it and waiting for
      // the channel_call's minute-scale redrive backstop.
      if (
        event.senderId === this.participantId() &&
        (await this.driver.channelCallMayMaterialize(channelId, effectId))
      ) {
        throw new Error(
          `channel invocation terminal arrived before effect ${effectId}`,
        );
      }
      return true; // not ours or already settled
    }
    const descriptor =
      row.descriptor as import("@workspace/agent-loop").ChannelCallEffect;
    const payload = ((agentic as { payload?: Record<string, unknown> })
      .payload ?? {}) as Record<string, unknown>;
    const isError = kind !== "invocation.completed";
    const responderSessionId = participantIdFromRef(descriptor.target);
    await this.recordMessageIngestion(channelId, event, "channel-tool-result");
    const hydratedResult = await this.hydrateTransportValue(
      payload["result"],
      responderSessionId,
      "channel-tool-result",
    );
    let outcome: EffectOutcome;
    if (descriptor.purpose === "approval-form") {
      const raw = hydratedResult;
      const granted =
        !isError &&
        !!raw &&
        typeof raw === "object" &&
        (raw as { granted?: unknown }).granted === true;
      outcome = {
        kind: "approval",
        granted,
        resolvedBy: descriptor.target,
        ...(typeof payload["reason"] === "string"
          ? { reason: payload["reason"] as string }
          : {}),
      };
      if (isError) {
        await this.publishApprovalDeliveryDiagnostic(
          channelId,
          descriptor,
          payload["reason"],
        );
      }
    } else {
      outcome = {
        kind: "tool",
        result: hydratedResult ?? payload["error"] ?? payload["reason"] ?? null,
        isError,
        ...(typeof payload["reason"] === "string"
          ? { reason: payload["reason"] as string }
          : {}),
      };
    }
    await this.driver.deliverEffectOutcome(effectId, outcome, { channelId });
    return true;
  }

  private async publishApprovalDeliveryDiagnostic(
    channelId: string,
    descriptor: import("@workspace/agent-loop").ChannelCallEffect,
    reason: unknown,
  ): Promise<void> {
    const participantId =
      this.subscriptions.getParticipantId(channelId) ?? this.participantId();
    const messageId = `approval-delivery-failed:${descriptor.transportCallId}`;
    const reasonText =
      typeof reason === "string" && reason.trim()
        ? reason
        : "approval prompt unavailable";
    const event: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: {
        kind: "agent",
        id: participantId,
        displayName: this.getEffectiveParticipantInfo(
          channelId,
          this.subscriptions.getConfig(channelId),
        ).name,
      },
      turnId: descriptor.turnId as never,
      causality: { messageId: messageId as never },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [
          {
            blockId: `${messageId}:diagnostic` as never,
            type: "diagnostic",
            content:
              "Approval prompt could not be delivered. The requested action was denied.",
            metadata: {
              code: "approval_prompt_unavailable",
              severity: "error",
              reason: reasonText,
              invocationId: descriptor.invocationId,
            },
          },
        ],
        outcome: "completed",
      },
      createdAt: new Date().toISOString(),
    };
    await this.createChannelClient(channelId)
      .publishAgenticEvent(participantId, event, {
        idempotencyKey: messageId,
        senderMetadata: { type: "agent", name: participantId },
      })
      .catch((err) => {
        console.error(
          `[AgentVessel] approval diagnostic emit failed for ${channelId}:`,
          err,
        );
      });
  }

  protected turnContent(channelId: string, event: ChannelEvent): unknown {
    const agentic = event.payload as { payload?: { blocks?: unknown[] } };
    const blocks = agentic.payload?.blocks ?? [];
    const text = blocks
      .map((block) =>
        block &&
        typeof block === "object" &&
        typeof (block as { content?: unknown }).content === "string"
          ? (block as { content: string }).content
          : "",
      )
      .filter(Boolean)
      .join("\n");
    const notes = this.feedback.consume(channelId);
    return notes.length > 0
      ? [...notes, text].filter(Boolean).join("\n\n")
      : text;
  }

  protected turnMetadata(event: ChannelEvent): AgentTurnMetadata | undefined {
    const agentic = event.payload as { payload?: { metadata?: unknown } };
    const metadata = agentic.payload?.metadata;
    return metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as AgentTurnMetadata)
      : undefined;
  }

  /** The hop depth of the conversation currently being answered on a channel.
   *  Written wherever an inbound event's depth is resolved; read by `notify`
   *  when it stamps a guest envelope. A human message resets the streak to 0
   *  upstream, so this needs no reset of its own. */
  protected recordInboundAgentHops(
    channelId: string,
    hops: number | undefined,
  ): void {
    if (typeof hops !== "number" || !Number.isFinite(hops)) return;
    try {
      this.setStateValue(`agent:inbound-hops:${channelId}`, String(hops));
    } catch {
      /* depth tracking is advisory; never fail delivery over it */
    }
  }

  protected inboundAgentHops(channelId: string): number {
    try {
      const raw = this.getStateValue(`agent:inbound-hops:${channelId}`);
      const value = raw ? Number(raw) : 0;
      return Number.isFinite(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  protected async shouldRespond(
    channelId: string,
    event: ChannelEvent,
    deliveredContext?: ChannelAgenticContext,
  ): Promise<boolean> {
    const agentic = event.payload as AgenticEvent;
    const payload = (agentic.payload ?? {}) as {
      mentions?: string[];
      replyTo?: string;
      to?: never[];
    };
    const channel = deliveredContext
      ? null
      : this.createChannelClient(channelId);
    let lastCompletedSender: string | null = null;
    let lastCompletedMessageId: string | null = null;
    let replyToSenderId: string | undefined;
    let conversationPolicy: "open" | "directed" | "moderated" | undefined;
    let agentHopLimit: number | undefined;
    let participantIds: string[] = [];
    // Captured for per-agent respondFrom handle→id resolution (resolveRespondFromHandles).
    let respondParticipants: ReadonlyArray<{
      participantId: string;
      metadata?: Record<string, unknown> | null;
    }> = [];
    let agentStreakHops: number | undefined;
    try {
      const resolved = deliveredContext
        ? {
            conversation: deliveredContext.conversation,
            config: deliveredContext.channelConfig,
            participants: deliveredContext.relationships.map(
              (relationship) => ({
                participantId: relationship.participantId,
                metadata: relationship.metadata,
                ref: participantRefFromMetadata(
                  relationship.participantId,
                  relationship.metadata,
                ),
              }),
            ),
            replyToSenderId: deliveredContext.replyToSenderId ?? undefined,
          }
        : await (async () => {
            const [policyState, config, participants] = await Promise.all([
              channel!.getPolicyState(),
              this.getCachedChannelConfig(channelId),
              this.getCachedParticipants(channelId),
            ]);
            return {
              conversation: policyState.state,
              config,
              participants,
              replyToSenderId: payload.replyTo
                ? ((await channel!.getMessageSender(
                    this.participantId(),
                    payload.replyTo,
                  )) ?? undefined)
                : undefined,
            };
          })();
      const conversation = resolved.conversation as {
        lastCompletedSender: string | null;
        lastCompletedMessageId?: string | null;
        lastCompletedSeq: number | null;
        previousCompletedSender: string | null;
        previousCompletedMessageId?: string | null;
        agentStreak?: number;
      };
      // The GAD trajectory fan-out path doesn't run the channel policy annotate,
      // so agent-published rows lack the per-event `agentHops` annotation. The
      // policy's `agentStreak` (folded over every channel row, incl. fan-out) is
      // the equivalent hop count — use it as the fallback so the loop breaker
      // still fires for agent→agent chains.
      if (typeof conversation.agentStreak === "number") {
        agentStreakHops = conversation.agentStreak;
      }
      lastCompletedSender =
        conversation.lastCompletedSeq != null &&
        conversation.lastCompletedSeq === event.id
          ? conversation.previousCompletedSender
          : conversation.lastCompletedSender;
      lastCompletedMessageId =
        conversation.lastCompletedSeq != null &&
        conversation.lastCompletedSeq === event.id
          ? (conversation.previousCompletedMessageId ?? null)
          : (conversation.lastCompletedMessageId ?? null);
      if (
        resolved.config?.["conversationPolicy"] === "open" ||
        resolved.config?.["conversationPolicy"] === "directed" ||
        resolved.config?.["conversationPolicy"] === "moderated"
      ) {
        conversationPolicy = resolved.config["conversationPolicy"];
      }
      if (typeof resolved.config?.["agentHopLimit"] === "number") {
        agentHopLimit = resolved.config["agentHopLimit"];
      }
      participantIds = resolved.participants.map(
        (participant) => participant.participantId,
      );
      respondParticipants = resolved.participants;
      if (payload.replyTo) {
        replyToSenderId =
          resolved.replyToSenderId ??
          (payload.replyTo === lastCompletedMessageId
            ? (lastCompletedSender ?? undefined)
            : undefined);
      }
    } catch {
      /* addressing degrades gracefully without channel state */
    }
    const settings = this.getAgentSettings();
    // respondFrom is per-agent: resolve handle entries to this channel's ids.
    const respondFrom = resolveRespondFromHandles(
      settings.respondFrom,
      respondParticipants,
    );
    const inboundHops =
      (event.annotations?.["agentHops"] as number | undefined) ??
      agentStreakHops;
    // Remember what depth this conversation is at, so a cross-channel `notify`
    // can carry the count over the boundary (plan §4.6, D13). Without this the
    // hop cap is a per-channel fold and an A↔B ping-pong gets twice the depth
    // it should: each channel sees a fresh streak.
    this.recordInboundAgentHops(channelId, inboundHops);
    const decision = resolveShouldRespond({
      event: {
        senderParticipantId: event.senderId,
        senderKind: agentic.actor?.kind ?? "user",
        mentions: payload.mentions,
        replyTo: payload.replyTo,
        replyToSenderId,
        to: payload.to,
        agentHops: inboundHops,
      },
      self: { participantId: this.participantId() },
      policy: settings.respondPolicy,
      respondFrom,
      participantIds,
      lastCompletedSender,
      conversationPolicy,
      agentHopLimit,
    });
    return decision.respond;
  }

  /** roster.snapshot details are class-INLINE (the fold reads them; there is
   *  no implicit spill, oversize is a hard encode error) — so this emitter
   *  bounds what panels advertise: descriptions are truncated, oversized
   *  parameter JSON-Schemas are dropped (the method stays callable; the
   *  model just loses its schema). */
  private static readonly MAX_ROSTER_DESCRIPTION_CHARS = 2_000;
  private static readonly MAX_ROSTER_PARAMETERS_BYTES = 16 * 1024;

  private boundedRosterMethod(method: {
    name: string;
    description?: string;
    parameters?: unknown;
  }): { name: string; description?: string; parameters?: unknown } {
    const description =
      typeof method.description === "string"
        ? method.description.slice(
            0,
            AgentVesselBase.MAX_ROSTER_DESCRIPTION_CHARS,
          )
        : undefined;
    let parameters = method.parameters;
    if (parameters !== undefined) {
      try {
        const bytes = new TextEncoder().encode(
          JSON.stringify(parameters),
        ).byteLength;
        if (bytes > AgentVesselBase.MAX_ROSTER_PARAMETERS_BYTES) {
          console.warn(
            `[Vessel] dropping oversized parameter schema for roster method ` +
              `${method.name} (${bytes} bytes > ${AgentVesselBase.MAX_ROSTER_PARAMETERS_BYTES})`,
          );
          parameters = undefined;
        }
      } catch {
        parameters = undefined;
      }
    }
    return {
      name: method.name,
      ...(description !== undefined ? { description } : {}),
      ...(parameters !== undefined ? { parameters } : {}),
    };
  }

  /** Commit the event-sequence roster projection carried by the mailbox row.
   * Recipient admission therefore performs no serialized channel read and the
   * prompt/tool surface is derived from the same relationship fold that chose
   * this recipient. */
  private async applyDeliveredAgenticContext(
    channelId: string,
    context: ChannelAgenticContext,
  ): Promise<ChannelAgenticContext> {
    if (context?.version !== 1) {
      throw Object.assign(
        new Error("acceptChannelDelivery: unsupported agentic context version"),
        {
          code: "PermanentChannelDelivery",
        },
      );
    }
    const relationships =
      context && typeof context === "object"
        ? (context as { relationships?: unknown }).relationships
        : undefined;
    if (
      !Array.isArray(relationships) ||
      !context.conversation ||
      !context.channelConfig
    ) {
      throw Object.assign(
        new Error("acceptChannelDelivery: missing versioned agentic context"),
        {
          code: "PermanentChannelDelivery",
        },
      );
    }
    const selfId = this.participantId();
    const roster: RosterEntry[] = relationships
      .filter(
        (
          value,
        ): value is {
          participantId: string;
          metadata: Record<string, unknown>;
        } =>
          !!value &&
          typeof value === "object" &&
          typeof (value as { participantId?: unknown }).participantId ===
            "string" &&
          !!(value as { metadata?: unknown }).metadata &&
          typeof (value as { metadata?: unknown }).metadata === "object",
      )
      .filter(({ participantId }) => participantId !== selfId)
      .map(({ participantId, metadata }) => ({
        participantId,
        ref: participantRefFromMetadata(participantId, metadata),
        handle:
          typeof metadata["handle"] === "string"
            ? String(metadata["handle"])
            : undefined,
        type:
          typeof metadata["type"] === "string"
            ? String(metadata["type"])
            : undefined,
        methods: Array.isArray(metadata["methods"])
          ? (
              metadata["methods"] as Array<{
                name?: string;
                description?: string;
                parameters?: unknown;
              }>
            )
              .filter(
                (
                  method,
                ): method is {
                  name: string;
                  description?: string;
                  parameters?: unknown;
                } => typeof method?.name === "string",
              )
              .map((method) => this.boundedRosterMethod(method))
          : [],
      }));
    const fingerprint = JSON.stringify(roster);
    if (this.getStateValue(`agent:roster:${channelId}`) !== fingerprint) {
      await this.driver.handleIncoming(channelId, {
        type: "command",
        command: { kind: "setRoster", roster: { participants: roster } },
      });
      this.setStateValue(`agent:roster:${channelId}`, fingerprint);
      this.localTools.delete(channelId);
    }
    return context;
  }

  private async getCachedChannelConfig(
    channelId: string,
  ): Promise<Record<string, unknown> | null> {
    const now = Date.now();
    const cached = this.channelConfigCache.get(channelId);
    if (cached && cached.expiresAt > now) return cached.value;
    const value =
      (await this.createChannelClient(channelId).getConfig()) ??
      (this.subscriptions.getConfig(channelId) as Record<
        string,
        unknown
      > | null) ??
      null;
    this.channelConfigCache.set(channelId, {
      value,
      expiresAt: now + CHANNEL_STATE_CACHE_MS,
    });
    return value;
  }

  private async getCachedParticipants(channelId: string): Promise<
    Array<{
      participantId: string;
      ref: ParticipantRef;
      metadata: Record<string, unknown>;
    }>
  > {
    const now = Date.now();
    const cached = this.participantCache.get(channelId);
    if (cached && cached.expiresAt > now) return cached.value;
    const value = await this.createChannelClient(channelId).getParticipants();
    this.participantCache.set(channelId, {
      value,
      expiresAt: now + CHANNEL_STATE_CACHE_MS,
    });
    return value;
  }

  // ── Method calls (agent as PROVIDER) ─────────────────────────────────────

  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async onMethodCall(
    channelId: string,
    transportCallId: string,
    methodName: string,
    args: unknown,
  ): Promise<{ result: unknown; isError?: boolean }> {
    this.assertChannelDeliveryCaller("onMethodCall", channelId);
    const directCallKey = this.directMethodCallKey(channelId, transportCallId);
    this.directMethodCalls
      .get(directCallKey)
      ?.abort("superseded provider generation");
    const controller = new AbortController();
    this.directMethodCalls.set(directCallKey, controller);
    try {
      return (
        (await this.handleStandardAgentMethodCall(
          channelId,
          methodName,
          args,
          controller.signal,
        )) ?? {
          result: { error: `unknown method: ${methodName}` },
          isError: true,
        }
      );
    } finally {
      if (this.directMethodCalls.get(directCallKey) === controller) {
        this.directMethodCalls.delete(directCallKey);
      }
    }
  }

  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async cancelDirectMethodCall(
    channelId: string,
    transportCallId: string,
  ): Promise<void> {
    this.assertChannelDeliveryCaller("cancelDirectMethodCall", channelId);
    const controller = this.directMethodCalls.get(
      this.directMethodCallKey(channelId, transportCallId),
    );
    if (controller) controller.abort(`method call cancelled on ${channelId}`);
  }

  /**
   * Operational, activation-local inspection for a channel or the host.
   *
   * This is deliberately separate from `onMethodCall`: inspection is not an
   * agent action and must not enter participant invocation routing. Every read
   * below is in-memory or local SQLite; missing folded state remains explicitly
   * missing instead of being hydrated through GAD.
   */
  @rpc({
    // PubSubChannel performs the admitted, receiver-gated inspection and then
    // reaches this endpoint as an authenticated code principal. The method's
    // exact channel-DO assertion below is the authority boundary for this
    // internal hop; host access remains available for operational inspection.
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async readAgentInspection(
    channelId: string,
    methodName: string,
  ): Promise<{ result: unknown; isError?: boolean }> {
    this.assertChannelDeliveryCaller("readAgentInspection", channelId);
    if (!isAgentInspectionMethod(methodName)) {
      throw new Error(
        `readAgentInspection: unsupported method ${methodName}; expected one of ` +
          AGENT_INSPECTION_METHODS.join(", "),
      );
    }
    return this.readStandardAgentInspection(channelId, methodName);
  }

  private readStandardAgentInspection(
    channelId: string,
    methodName: AgentInspectionMethod,
  ): { result: unknown; isError?: boolean } {
    switch (methodName) {
      case "getDebugState":
        return { result: this.activationDebugState(channelId) };
      case "getAgentSettings":
        return { result: this.inspectAgentSettings() };
      case "inspectMethodSuspensions":
        return { result: { outbox: inspectEffectOutbox(this.sql) } };
    }
  }

  /**
   * Journal-derived model route/usage evidence for headless orchestration.
   * This direct RPC remains available when channel presence has already gone
   * stale, which is precisely when timeout/cancellation diagnostics need it.
   * The response contains no prompt, tool argument, credential, or secret.
   */
  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async getModelExecutionEvidence(channelId: string): Promise<unknown> {
    const evidence = await this.driver.modelExecutionEvidence(channelId);
    return {
      ...evidence,
      transportRuntime: modelTransportRuntimeEvidence(),
      hotPathTrace: this.hotPathTrace(channelId),
    };
  }

  /** Direct lifecycle barrier for non-interactive owners. Unlike the chat
   * `pause` method this does not require the controller to remain a channel
   * member while cancellation is already unwinding that membership. */
  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async interruptChannel(
    channelId: string,
    flushDeferred = false,
  ): Promise<{ interrupted: true }> {
    await this.interruptChannelAndCancelDeferredEvals(channelId, flushDeferred);
    return { interrupted: true };
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async interruptAllChannels(
    flushDeferred = true,
  ): Promise<{ interrupted: number }> {
    const channelIds = [
      ...new Set(
        this.subscriptions
          .listAll()
          .map((subscription) => subscription.channelId),
      ),
    ];
    await Promise.all(
      channelIds.map((channelId) =>
        this.interruptChannelAndCancelDeferredEvals(channelId, flushDeferred),
      ),
    );
    return { interrupted: channelIds.length };
  }

  protected async handleStandardAgentMethodCall(
    channelId: string,
    methodName: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<{ result: unknown; isError?: boolean } | null> {
    if (!this.isParticipantMethodEnabled(methodName)) return null;
    if (isAgentInspectionMethod(methodName)) {
      return this.readStandardAgentInspection(channelId, methodName);
    }
    switch (methodName) {
      case "pause": {
        const flushDeferred =
          (args as { flushDeferred?: unknown } | null)?.flushDeferred === true;
        await this.interruptChannelAndCancelDeferredEvals(
          channelId,
          flushDeferred,
        );
        return { result: { paused: true } };
      }
      case "cancelEval": {
        // The chat-panel pill cancels a SERVER-SIDE eval run by asking THIS agent
        // (the eval's owner, subKey = channelId) to cancel it. The agent calls
        // eval.cancel for itself — the eval service resolves the owner from the
        // caller, so the panel cannot address another owner's EvalDO. The UI
        // supplies the journaled invocation coordinate; this trusted owner
        // derives the distinct eval-effect coordinate used as the run id.
        const invocationId = (args as { invocationId?: unknown } | null)
          ?.invocationId;
        if (typeof invocationId !== "string" || invocationId.length === 0) {
          return {
            result: { error: "cancelEval requires an invocationId" },
            isError: true,
          };
        }
        const runId = ids.invocationEffect(invocationId);
        try {
          const result = await this.rpc.call<{ ok: boolean }>(
            "main",
            "eval.cancel",
            [{ scopeKey: channelId, runId }],
            { signal },
          );
          return { result };
        } catch (err) {
          return {
            result: { error: err instanceof Error ? err.message : String(err) },
            isError: true,
          };
        }
      }
      case "resume": {
        await this.driver.wake(channelId);
        return { result: { resumed: true } };
      }
      case "scheduleResumeAtReset": {
        const result = await this.driver.scheduleResumeAtReset(
          channelId,
          (args ?? {}) as { messageId?: unknown; resetAt?: unknown },
        );
        return { result, isError: result.scheduled !== true };
      }
      case "connectModelCredential": {
        const input = (args ?? {}) as {
          providerId?: string;
          modelRef?: string;
          browserOpenMode?: string;
          modelBaseUrl?: string;
          browserHandoffCallerId?: string;
          browserHandoffCallerKind?: string;
        };
        if (!input.providerId) {
          return {
            result: { error: "connectModelCredential requires providerId" },
            isError: true,
          };
        }
        const browser = normalizeBrowserOpenMode(input.browserOpenMode);
        const request = toCredentialConnectRequest(input.providerId, {
          browser,
        });
        if (!request) {
          return {
            result: {
              error: `no credential connect request for provider ${input.providerId}`,
            },
            isError: true,
          };
        }
        const handoffTarget = normalizeBrowserHandoffTarget(input);
        const connectParams:
          | ConnectCredentialRequest
          | ConnectCredentialEnvelope = handoffTarget
          ? { spec: request, handoffTarget }
          : request;
        const credential = await this.rpc.call<Record<string, unknown>>(
          "main",
          "credentials.connect",
          [connectParams],
          { signal },
        );
        const effectId = ids.credentialWaitEffect(
          ids.credKey(channelId, input.providerId),
        );
        const resumed = await this.driver.deliverEffectOutcome(
          effectId,
          {
            kind: "credential",
            resolved: true,
          } satisfies EffectOutcome,
          { channelId },
        );
        if (resumed) await this.driver.wake(channelId);
        return { result: { credential, resumed } };
      }
      case "setModel": {
        const model = (args as { model?: unknown } | null)?.model;
        if (typeof model !== "string" || model.length === 0) {
          return {
            result: {
              error: "setModel requires model in provider:model format",
            },
            isError: true,
          };
        }
        return { result: this.updateSettings({ model }) };
      }
      case "setThinkingLevel": {
        const level = (args as { level?: unknown } | null)?.level;
        if (
          level !== "minimal" &&
          level !== "low" &&
          level !== "medium" &&
          level !== "high" &&
          level !== "xhigh" &&
          level !== "max"
        ) {
          return {
            result: {
              error:
                "setThinkingLevel requires level: minimal, low, medium, high, xhigh, or max",
            },
            isError: true,
          };
        }
        return { result: this.updateSettings({ thinkingLevel: level }) };
      }
      case "setFastMode": {
        const enabled = (args as { enabled?: unknown } | null)?.enabled;
        if (typeof enabled !== "boolean") {
          return {
            result: { error: "setFastMode requires enabled: boolean" },
            isError: true,
          };
        }
        return { result: this.updateSettings({ fastMode: enabled }) };
      }
      case "setApprovalLevel": {
        const level = (args as { level?: unknown } | null)?.level;
        if (level !== 0 && level !== 1 && level !== 2) {
          return {
            result: { error: "setApprovalLevel requires level: 0, 1, or 2" },
            isError: true,
          };
        }
        return { result: this.updateSettings({ approvalLevel: level }) };
      }
      case "setRespondPolicy": {
        const input = args as { policy?: unknown; from?: unknown } | null;
        if (!isRespondPolicy(input?.policy)) {
          return {
            result: {
              error:
                "setRespondPolicy requires policy: all, mentioned, mentioned-strict, mentioned-or-followup, or from-participants",
            },
            isError: true,
          };
        }
        const from = Array.isArray(input?.from)
          ? input.from.filter((id): id is string => typeof id === "string")
          : undefined;
        return {
          result: this.updateSettings({
            respondPolicy: input.policy,
            ...(from !== undefined ? { respondFrom: from } : {}),
          }),
        };
      }
      case "refreshPromptArtifacts": {
        this.invalidatePromptResources(channelId);
        await this.ensurePromptArtifacts(channelId);
        return {
          result: {
            refreshed: true,
            systemPromptHash: this.getStateValue(
              `agent:promptHash:${channelId}`,
            ),
            toolSchemasHash: this.getStateValue(`agent:toolsHash:${channelId}`),
          },
        };
      }
      case "getModelExecutionEvidence":
        return { result: await this.driver.modelExecutionEvidence(channelId) };
      default:
        return null;
    }
  }

  // ── chat proxy for server-side eval (chatOp) ─────────────────────────────

  /**
   * Forwarded channel operation from THIS agent's own EvalDO sandbox `chat`
   * binding. The EvalDO can only publish as its own non-agent identity and
   * cannot receive a delivered method result, so it relays every
   * `ChatSandboxValue` op here and we perform it AS the agent (correct @agent
   * attribution) using our existing channel machinery. Return values mirror
   * `ChatSandboxValue`'s.
   *
   * Auth: the caller MUST be this agent's own EvalDO. We re-derive that DO's
   * objectKey the SAME way evalService does — sha256(ownerId + "\\0" + subKey),
   * hex, first 40 chars — and require the verified caller id to be
   * `do:vibestudio/internal:EvalDO:<key>`. Any other caller is rejected; the
   * generic DO relay is open, so a sensitive receiver gates on receipt.
   */
  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async chatOp(
    channelId: string,
    op: string,
    args: unknown[],
  ): Promise<unknown> {
    await this.assertOwnEvalCaller(channelId);
    const channel = this.createChannelClient(channelId);
    const participantId =
      this.subscriptions.getParticipantId(channelId) ?? this.participantId();
    const a = args ?? [];

    switch (op) {
      case "publish": {
        const [eventType, payload, options] = a as [
          string,
          unknown,
          { idempotencyKey?: string } | undefined,
        ];
        const target = await this.channelTarget(channelId);
        return this.rpc.call(target, "publish", [
          participantId,
          eventType,
          payload,
          options?.idempotencyKey
            ? { idempotencyKey: options.idempotencyKey }
            : undefined,
        ]);
      }
      case "send": {
        const [content, options] = a as [
          string,
          { idempotencyKey?: string } | undefined,
        ];
        const messageId = options?.idempotencyKey ?? crypto.randomUUID();
        const descriptor = this.getEffectiveParticipantInfo(
          channelId,
          this.subscriptions.getConfig(channelId),
        );
        await channel.send(participantId, messageId, content, {
          senderMetadata: {
            type: "agent",
            name: descriptor.name,
            handle: descriptor.handle,
          },
          ...(options?.idempotencyKey
            ? { idempotencyKey: options.idempotencyKey }
            : {}),
        });
        return undefined;
      }
      case "publishCustomMessage": {
        const [input, options] = a as [
          {
            typeId: string;
            initialState?: unknown;
            displayMode?: CustomMessageDisplayMode;
          },
          { idempotencyKey?: string } | undefined,
        ];
        // create() mints a fresh card identity (random natural key), publishing
        // custom.started as the agent. The handle carries the pubsubId of that
        // started event — matching the panel client's { messageId, pubsubId }.
        const handle = await this.cards.create(
          channelId,
          input.typeId,
          input.initialState,
          {
            ...(input.displayMode ? { displayMode: input.displayMode } : {}),
            ...(options?.idempotencyKey ? { key: options.idempotencyKey } : {}),
          },
        );
        return { messageId: handle.messageId, pubsubId: handle.pubsubId };
      }
      case "updateCustomMessage": {
        const [messageId, update] = a as [string, unknown];
        const handle = this.cards.get(channelId, messageId);
        if (!handle) {
          throw new Error(
            `updateCustomMessage: no card ${messageId} on channel ${channelId}`,
          );
        }
        // Resolves to the pubsubId of the custom.updated event (number | undefined).
        return handle.update(update);
      }
      case "registerMessageType": {
        const [input] = a as [
          RegisterMessageTypeInput,
          { idempotencyKey?: string } | undefined,
        ];
        const idempotencyKey = (a[1] as { idempotencyKey?: string } | undefined)
          ?.idempotencyKey;
        return this.publishMessageTypeRegistered(
          channelId,
          participantId,
          input,
          idempotencyKey,
        );
      }
      case "clearMessageType": {
        const [typeId] = a as [string, { idempotencyKey?: string } | undefined];
        const idempotencyKey = (a[1] as { idempotencyKey?: string } | undefined)
          ?.idempotencyKey;
        return this.publishMessageTypeCleared(
          channelId,
          participantId,
          typeId,
          idempotencyKey,
        );
      }
      case "getMessageType": {
        const [typeId] = a as [string];
        return channel.getMessageType(typeId);
      }
      case "getMessageTypes":
        return channel.getMessageTypes();
      case "getParticipants":
        return (await channel.getParticipants()).map(
          ({ participantId: id, ref, metadata }) => ({
            id,
            ref,
            type: metadata["type"],
            name: metadata["name"],
            isPerson: metadata["type"] === "user",
            isAgent: metadata["type"] === "agent",
            ...(typeof metadata["handle"] === "string"
              ? { handle: metadata["handle"] }
              : {}),
            ...(Array.isArray(metadata["methods"])
              ? { methods: metadata["methods"] }
              : {}),
          }),
        );
      case "replayEnvelope": {
        const [envelopeId] = a as [string];
        if (typeof envelopeId !== "string" || envelopeId.length === 0)
          return null;
        return channel.getEnvelope(envelopeId);
      }
      case "callMethod": {
        const [targetPid, method, callArgs, options] = a as [
          string,
          string,
          unknown,
          { timeoutMs?: number } | undefined,
        ];
        const result = await this.relayChannelCall(
          channelId,
          targetPid,
          method,
          callArgs,
          options,
        );
        return result.content;
      }
      case "callMethodResult": {
        const [targetPid, method, callArgs, options] = a as [
          string,
          string,
          unknown,
          { timeoutMs?: number } | undefined,
        ];
        return this.relayChannelCall(
          channelId,
          targetPid,
          method,
          callArgs,
          options,
        );
      }
      case "participantByHandle": {
        const [handle] = a as [string];
        return this.resolveParticipantByHandle(channelId, handle);
      }
      case "callMethodByHandle": {
        const [handle, method, callArgs, options] = a as [
          string,
          string,
          unknown,
          { timeoutMs?: number } | undefined,
        ];
        const target = await this.requireParticipantByHandle(channelId, handle);
        const result = await this.relayChannelCall(
          channelId,
          target.id,
          method,
          callArgs,
          options,
        );
        return result.content;
      }
      case "callMethodResultByHandle": {
        const [handle, method, callArgs, options] = a as [
          string,
          string,
          unknown,
          { timeoutMs?: number } | undefined,
        ];
        const target = await this.requireParticipantByHandle(channelId, handle);
        return this.relayChannelCall(
          channelId,
          target.id,
          method,
          callArgs,
          options,
        );
      }
      case "focusMessage":
        // Panel-only DOM scroll; no server-side equivalent.
        return false;
      // ── agent self-management (the eval `agent` binding) ──────────────────
      case "describeSelf":
        return this.describeSelf(channelId);
      case "configureAgent":
        return this.configureAgent((a[0] ?? {}) as Record<string, unknown>);
      default:
        throw new Error(`chatOp: unknown op ${op}`);
    }
  }

  /** Read-only half of the eval owner surface. Keeping this outside chatOp is
   * intentional: chatOp contains mutations and is therefore correctly
   * classified as write, while a self snapshot must remain usable from a
   * read-only eval. The same own-EvalDO receiver check protects both routes. */
  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async describeEvalOwner(channelId: string): Promise<Record<string, unknown>> {
    await this.assertOwnEvalCaller(channelId);
    return this.describeSelf(channelId);
  }

  /** Launch the canonical mission first, then publish its idempotent running
   * resource projection. A retry recovers the same mission and the same pill;
   * the tool does not report success until both durable owners acknowledge. */
  private async automationServiceTarget(callerRpc: RpcClient): Promise<string> {
    const service = await callerRpc.call<{
      kind?: unknown;
      targetId?: unknown;
    }>("main", "workers.resolveService", ["vibestudio.missions.v1"]);
    if (
      service.kind !== "durable-object" ||
      typeof service.targetId !== "string"
    ) {
      throw new Error("The Automations service is unavailable");
    }
    return service.targetId;
  }

  private async controlAutomation(
    channelId: string,
    raw: unknown,
    requestIdentity: string,
    callerRpc: RpcClient,
  ): Promise<AgentToolResult<unknown>> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("control_automation requires an object");
    }
    const input = raw as Record<string, unknown>;
    const action = input["action"];
    if (
      action !== "pause" &&
      action !== "resume" &&
      action !== "run_now" &&
      action !== "retire"
    ) {
      throw new Error(
        "control_automation action must be pause, resume, run_now, or retire",
      );
    }
    const requestedMissionId =
      typeof input["missionId"] === "string" ? input["missionId"].trim() : "";
    const requestedName =
      typeof input["name"] === "string" ? input["name"].trim() : "";
    if (requestedMissionId && requestedName) {
      throw new Error("control_automation accepts missionId or name, not both");
    }

    const target = await this.automationServiceTarget(callerRpc);
    const visible = await callerRpc.call<MissionRecord[]>(target, "list", []);
    let candidates = visible;
    if (requestedMissionId) {
      candidates = visible.filter(
        (mission) => mission.missionId === requestedMissionId,
      );
    } else if (requestedName) {
      const normalized = requestedName.toLocaleLowerCase();
      candidates = visible.filter(
        (mission) => mission.name.toLocaleLowerCase() === normalized,
      );
    } else {
      candidates = visible.filter((mission) => {
        const execution = mission.charter.execution;
        return (
          execution.kind === "agent" &&
          execution.conversation.mode === "continue" &&
          execution.conversation.channelId === channelId &&
          (action === "resume"
            ? mission.state === "paused"
            : mission.state === "active")
        );
      });
    }
    if (candidates.length === 0) {
      throw new Error("No matching automation owned by the current user");
    }
    if (candidates.length > 1) {
      throw new Error(
        `More than one automation matches; call control_automation again with one exact name or missionId: ${candidates
          .map((mission) => `${mission.name} (${mission.missionId})`)
          .join(", ")}`,
      );
    }
    const mission = candidates[0]!;
    const method = action === "run_now" ? "runNow" : action;
    const result = await callerRpc.call<unknown>(
      target,
      method,
      [mission.missionId],
      {
        idempotencyKey: `automation:control:${this.objectKey}:${sha256HexSyncText(requestIdentity)}:${action}:${mission.missionId}`,
      },
    );
    const verb =
      action === "pause"
        ? "paused"
        : action === "resume"
          ? "resumed"
          : action === "run_now"
            ? "started"
            : "removed";
    return {
      content: [
        {
          type: "text",
          text: `${mission.name} was ${verb}.`,
        },
      ],
      details: result,
    } as AgentToolResult<unknown>;
  }

  private async launchAutomation(
    channelId: string,
    input: unknown,
    requestIdentity: string,
    callerRpc: RpcClient,
  ): Promise<MissionRecord> {
    const definition = this.selfAutomationDefinition(channelId, input);
    if (
      definition.charter.execution.kind === "agent" &&
      definition.charter.execution.conversation.mode === "continue" &&
      definition.charter.execution.operations.length > 0
    ) {
      const authorityPlan = await callerRpc.call<MissionAuthorityPlanReference>(
        "main",
        "authority.compileAuthorityPlan",
        [
          {
            executionImageDigest: missionExecutionImageDigest(
              definition.charter.execution.image,
            ),
            operations: definition.charter.execution.operations.map(
              (operation) => ({
                service: operation.service,
                method: operation.method,
                ...(operation.args ? { args: [...operation.args] } : {}),
                use: operation.use,
              }),
            ),
          },
        ],
        {
          idempotencyKey: `automation:task-authority-plan:${sha256HexSyncText(requestIdentity)}`,
        },
      );
      const authority = await callerRpc.call<MissionAuthorityProjection>(
        "main",
        "authority.acquireForCurrentTask",
        [{ authorityPlanDigest: authorityPlan.digest }],
        {
          idempotencyKey: `automation:task-authority:${sha256HexSyncText(requestIdentity)}`,
        },
      );
      if (authority.denialIds.length > 0) {
        throw new Error(
          "Automation launch was denied required authority for this agent task",
        );
      }
    }
    const target = await this.automationServiceTarget(callerRpc);
    const automation = await callerRpc.call<MissionRecord>(
      target,
      "launch",
      [definition],
      {
        idempotencyKey: `automation:launch:${this.objectKey}:${sha256HexSyncText(requestIdentity)}`,
      },
    );
    if (automation.state !== "active") {
      throw new Error(
        `Automation launch returned unexpected state ${automation.state}`,
      );
    }
    const participantId =
      this.subscriptions.getParticipantId(channelId) ?? this.participantId();
    const descriptor = this.getEffectiveParticipantInfo(
      channelId,
      this.subscriptions.getConfig(channelId),
    );
    const senderMetadata = {
      type: "agent",
      name: descriptor.name,
      handle: descriptor.handle,
    };
    const event: AgenticEvent<"automation.instituted"> = {
      kind: "automation.instituted",
      actor: {
        kind: "agent",
        id: participantId,
        displayName: descriptor.name,
        metadata: senderMetadata,
      },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        definition: automationDefinitionSnapshot(automation),
      },
      createdAt: new Date(automation.createdAt).toISOString(),
    };
    await this.createChannelClient(channelId).publishAgenticEvent(
      participantId,
      event,
      {
        idempotencyKey: `automation:instituted:${automation.missionId}`,
        senderMetadata,
      },
    );
    return automation;
  }

  /** Expand the native agent tool input into an exact installed mission
   * charter. Identity and code version come from this executing vessel, never
   * from model-authored strings or a racy build lookup. */
  private selfAutomationDefinition(
    channelId: string,
    raw: unknown,
  ): {
    name: string;
    charter: MissionRecord["charter"];
  } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("launch_automation requires an object");
    }
    const input = raw as Record<string, unknown>;
    const name = typeof input["name"] === "string" ? input["name"].trim() : "";
    const summary =
      typeof input["summary"] === "string" ? input["summary"].trim() : "";
    if (!name || !summary || !input["action"] || !input["trigger"]) {
      throw new Error(
        "launch_automation requires name, summary, action, and trigger",
      );
    }
    const source = String(this.env["WORKER_SOURCE"] ?? "");
    const className = String(
      this.env["WORKER_CLASS_NAME"] ?? this.constructor.name,
    );
    const ev = String(this.env["WORKER_EFFECTIVE_VERSION"] ?? "");
    const ref = String(this.env["WORKER_SOURCE_REF"] ?? "");
    if (
      !source ||
      !className ||
      !/^[0-9a-f]{64}$/u.test(ev) ||
      !/^state:[0-9a-f]{64}$/u.test(ref)
    ) {
      throw new Error(
        "launch_automation cannot bind this agent to an exact installed build; rebuild the agent runtime",
      );
    }
    const conversationInput = input["conversation"] as
      | { mode?: unknown }
      | undefined;
    if (
      conversationInput?.mode !== undefined &&
      conversationInput.mode !== "fresh" &&
      conversationInput.mode !== "continue"
    ) {
      throw new Error(
        'launch_automation conversation.mode must be "fresh" or "continue"',
      );
    }
    const conversation =
      conversationInput?.mode === "fresh"
        ? { mode: "fresh" as const }
        : {
            mode: "continue" as const,
            channelId,
            contextId: this.subscriptions.getContextId(channelId),
            executorId: this.participantId(),
          };
    const operations = (input["operations"] ?? []) as MissionOperationIntent[];
    return {
      name,
      charter: {
        summary,
        execution: {
          kind: "agent",
          image: {
            source,
            ref: ref as `state:${string}`,
            effectiveVersion: ev,
            className,
            objectKey: this.objectKey,
          },
          action: input["action"] as MissionAgentAction,
          conversation,
          operations,
        },
        trigger: input["trigger"] as MissionTrigger,
      },
    };
  }

  /** Re-derive this agent's own EvalDO objectKey (matching evalService's
   *  formula EXACTLY: sha256(`${ownerId}\0${subKey}`) hex, first 40 chars; owner
   *  = this agent's runtime id, subKey = channelId) and require the verified
   *  caller to be that EvalDO. */
  private async assertOwnEvalCaller(channelId: string): Promise<void> {
    const callerId = this.rpcCallerId;
    const expectedKey = sha256HexSyncText(
      `${this.participantId()}\0${channelId}`,
    );
    const expectedCaller = `do:vibestudio/internal:EvalDO:${expectedKey.slice(0, 40)}`;
    if (callerId !== expectedCaller) {
      throw new Error(
        `chatOp: refusing caller ${callerId ?? "unknown"} — only this agent's own EvalDO may forward chat ops`,
      );
    }
  }

  /** Server-stamped settlement (`onEvalComplete`, authority wake hints): the
   *  server dispatches these via doDispatch / callTarget as callerKind
   *  "server". The DO relay is open, so without this any authenticated caller
   *  could forge a completion or wake and drive the agent loop. */
  private assertServerCaller(method: string): void {
    if (this.rpcCallerKind !== "server") {
      throw new Error(
        `${method}: refusing caller ${this.rpcCallerId ?? "unknown"} (kind ${this.rpcCallerKind ?? "unknown"}) — server-only`,
      );
    }
  }

  /** The channel→agent callback boundary. Effect terminals
   *  (`deliverEffectOutcome`) and method dispatch (`onMethodCall`) arrive from
   *  exactly two legitimate sources: the server
   *  (http_call / credential callbacks, kind "server") and the agent's PubSubChannel
   *  DO (a "do" caller whose id names PubSubChannel). Refuse anything else — the open
   *  relay otherwise lets a panel, a worker, or ANOTHER agent forge channel traffic /
   *  tool outcomes into the loop. callerId is server-authenticated, so the className
   *  segment cannot be spoofed. */
  private directMethodCallKey(
    channelId: string,
    transportCallId: string,
  ): string {
    return `${channelId}\u0000${transportCallId}`;
  }

  private assertChannelDeliveryCaller(
    method: string,
    channelId?: string,
  ): void {
    const kind = this.rpcCallerKind;
    if (kind === "server") return;
    const callerId = this.rpcCallerId ?? "";
    if (
      kind === "do" &&
      typeof channelId === "string" &&
      channelId.length > 0 &&
      callerId === `do:workers/pubsub-channel:PubSubChannel:${channelId}`
    ) {
      return;
    }
    throw new Error(
      `${method}: refusing caller ${callerId || "unknown"} (kind ${kind ?? "unknown"})`,
    );
  }

  /** Publish a messageType.registered event AS the agent (mirrors the ui-install
   *  publisher + the panel client) and invalidate the CardManager type cache. */
  private async publishMessageTypeRegistered(
    channelId: string,
    participantId: string,
    input: RegisterMessageTypeInput,
    idempotencyKey?: string,
  ): Promise<number | undefined> {
    // Self-gate: this helper is independently RPC-exposed (collectExposableMethods
    // reflects every method) over the open DO relay, so chatOp's assertOwnEvalCaller
    // is bypassable by addressing it directly. Only this agent's own EvalDO may act
    // as the agent.
    await this.assertOwnEvalCaller(channelId);
    const actor = this.cardActor(channelId, participantId);
    const event: AgenticEvent<"messageType.registered"> = {
      kind: "messageType.registered",
      actor,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        typeId: input.typeId,
        displayMode: input.displayMode,
        source: input.source,
        ...(input.imports !== undefined ? { imports: input.imports } : {}),
        ...(input.stateSchema !== undefined
          ? { stateSchema: input.stateSchema }
          : {}),
        ...(input.updateSchema !== undefined
          ? { updateSchema: input.updateSchema }
          : {}),
        registeredBy: actor,
      },
      createdAt: new Date().toISOString(),
    };
    const res = await this.createChannelClient(channelId).publishAgenticEvent(
      participantId,
      event,
      {
        ...(idempotencyKey ? { idempotencyKey } : {}),
        senderMetadata: actor.metadata,
      },
    );
    this.cards.invalidateType(channelId, input.typeId);
    return res.id;
  }

  /** Publish a messageType.cleared tombstone AS the agent + invalidate cache. */
  private async publishMessageTypeCleared(
    channelId: string,
    participantId: string,
    typeId: string,
    idempotencyKey?: string,
  ): Promise<number | undefined> {
    await this.assertOwnEvalCaller(channelId); // direct-call gate — see publishMessageTypeRegistered
    const actor = this.cardActor(channelId, participantId);
    const event: AgenticEvent<"messageType.cleared"> = {
      kind: "messageType.cleared",
      actor,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, typeId },
      createdAt: new Date().toISOString(),
    };
    const res = await this.createChannelClient(channelId).publishAgenticEvent(
      participantId,
      event,
      {
        ...(idempotencyKey ? { idempotencyKey } : {}),
        senderMetadata: actor.metadata,
      },
    );
    this.cards.invalidateType(channelId, typeId);
    return res.id;
  }

  private cardActor(
    channelId: string,
    participantId: string,
  ): ActorRef & { participantId?: string; metadata?: Record<string, unknown> } {
    const descriptor = this.getEffectiveParticipantInfo(
      channelId,
      this.subscriptions.getConfig(channelId),
    );
    return {
      kind: "agent",
      id: participantId,
      displayName: descriptor.name,
      participantId,
      metadata: {
        type: "agent",
        name: descriptor.name,
        handle: descriptor.handle,
      },
    };
  }

  /** Resolve a participant by handle ("handle" or "@handle") from the channel
   *  roster. Returns the raw participant record (id + metadata) or null. */
  private async resolveParticipantByHandle(
    channelId: string,
    rawHandle: string,
  ): Promise<{ id: string; metadata: Record<string, unknown> } | null> {
    const handle = rawHandle.startsWith("@") ? rawHandle.slice(1) : rawHandle;
    const participants = await this.getCachedParticipants(channelId);
    const match = participants.find((p) => p.metadata?.["handle"] === handle);
    return match ? { id: match.participantId, metadata: match.metadata } : null;
  }

  private async requireParticipantByHandle(
    channelId: string,
    rawHandle: string,
  ): Promise<{ id: string; metadata: Record<string, unknown> }> {
    const participant = await this.resolveParticipantByHandle(
      channelId,
      rawHandle,
    );
    if (!participant) {
      const handle = rawHandle.startsWith("@") ? rawHandle.slice(1) : rawHandle;
      throw new Error(`No participant with handle @${handle}`);
    }
    return participant;
  }

  /**
   * Initiate a channel method call AS the agent and resolve to the DELIVERED
   * result. The channel broadcasts the durable invocation terminal back to us
   * (the caller); settleChatOpCall matches it by transportCallId and resolves
   * the promise registered here. Loop-independent (does not touch the
   * effect-outbox) so the eval relay returns the result inline.
   */
  private async relayChannelCall(
    channelId: string,
    targetPid: string,
    method: string,
    args: unknown,
    options?: { timeoutMs?: number },
  ): Promise<{ content: unknown }> {
    await this.assertOwnEvalCaller(channelId); // direct-call gate — see publishMessageTypeRegistered
    // An eval running inside this agent can inspect the agent itself, but a
    // channel relay to our own participant would wait for a result from the
    // turn that is currently waiting on that relay. Resolve the documented
    // read-only inspection methods locally; all other self-calls retain the
    // normal channel semantics.
    if (targetPid === this.participantId() && isAgentInspectionMethod(method)) {
      const inspection = this.readStandardAgentInspection(channelId, method);
      return { content: inspection.result };
    }
    const callId = crypto.randomUUID();
    const timeoutMs = options?.timeoutMs;
    const settled = new Promise<{ content: unknown }>((resolve, reject) => {
      const entry: {
        resolve: (value: { content: unknown }) => void;
        reject: (error: Error) => void;
        responderSessionId: string;
        timer?: ReturnType<typeof setTimeout>;
      } = { resolve, reject, responderSessionId: targetPid };
      if (timeoutMs && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.chatOpPendingCalls.delete(callId)) {
            reject(
              new Error(
                `chat.callMethod(${method}) timed out after ${timeoutMs}ms`,
              ),
            );
          }
        }, timeoutMs);
      }
      this.chatOpPendingCalls.set(callId, entry);
    });
    try {
      await this.createChannelClient(channelId).callMethod(
        this.participantId(),
        targetPid,
        callId,
        method,
        args,
        {
          invocationId: callId,
          transportCallId: callId,
          ...(timeoutMs && timeoutMs > 0 ? { timeoutMs } : {}),
        },
      );
    } catch (err) {
      const entry = this.chatOpPendingCalls.get(callId);
      if (entry?.timer) clearTimeout(entry.timer);
      this.chatOpPendingCalls.delete(callId);
      throw err instanceof Error ? err : new Error(String(err));
    }
    return settled;
  }

  /** Settle a pending chatOp relay call from a channel invocation terminal.
   *  Returns true when the event settled (or was a non-terminal phase of) one
   *  of our relay calls — so processChannelEvent stops routing it further. */
  private async settleChatOpCall(
    channelId: string,
    event: ChannelEvent,
  ): Promise<boolean> {
    if (this.chatOpPendingCalls.size === 0) return false;
    const agentic = event.payload as AgenticEvent | null;
    const kind = (agentic as { kind?: string } | null)?.kind ?? "";
    if (!kind.startsWith("invocation.")) return false;
    const causality = ((agentic as { causality?: Record<string, unknown> })
      ?.causality ?? {}) as Record<string, unknown>;
    const transportCallId =
      typeof causality["transportCallId"] === "string"
        ? (causality["transportCallId"] as string)
        : typeof causality["invocationId"] === "string"
          ? (causality["invocationId"] as string)
          : null;
    if (!transportCallId) return false;
    const entry = this.chatOpPendingCalls.get(transportCallId);
    if (!entry) return false;
    if (!AgentVesselBase.INVOCATION_TERMINAL_KINDS.has(kind)) {
      // started/output for our own relay call — consume but keep waiting.
      return true;
    }
    this.chatOpPendingCalls.delete(transportCallId);
    if (entry.timer) clearTimeout(entry.timer);
    const payload = ((agentic as { payload?: Record<string, unknown> })
      ?.payload ?? {}) as Record<string, unknown>;
    if (kind === "invocation.completed") {
      // Hydrate any stored-value refs the provider spilled, then resolve with
      // the delivered content (ChatMethodResult shape). hydrate is async; the
      // settle hook stays sync by resolving inside the promise chain.
      void this.recordMessageIngestion(channelId, event, "chat-method-result")
        .then(() =>
          this.hydrateTransportValue(
            payload["result"],
            entry.responderSessionId,
            "chat-method-result",
          ),
        )
        .then(
          (content) => entry.resolve({ content }),
          (err) =>
            entry.reject(err instanceof Error ? err : new Error(String(err))),
        );
    } else {
      const reason =
        payload["error"] ?? payload["reason"] ?? payload["result"] ?? null;
      const message =
        typeof reason === "string" && reason.length > 0
          ? reason
          : reason &&
              typeof reason === "object" &&
              typeof (reason as { error?: unknown }).error === "string"
            ? (reason as { error: string }).error
            : `chat.callMethod failed (${kind})`;
      entry.reject(new Error(message));
    }
    return true;
  }

  /** Channel DO settle path: terminals for our channel_call effects POST back
   *  here. Duplicate delivery is a no-op (deterministic terminal ids). */
  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async deliverEffectOutcome(
    effectId: string,
    outcome: EffectOutcome,
    address?: { branchId?: string; channelId?: string },
  ): Promise<void> {
    this.assertChannelDeliveryCaller(
      "deliverEffectOutcome",
      address?.channelId,
    );
    await this.driver.deliverEffectOutcome(effectId, outcome, address);
  }

  /** Best-effort host wake hint. Durable outbox state, not this notification,
   * owns continuation; a lost hint is recovered by the ordinary redrive alarm. */
  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async onAuthorityChanged(_acquisitionId: string): Promise<void> {
    this.assertServerCaller("onAuthorityChanged");
    // Authority acquisition and credential availability are independent
    // continuations. Only authority-deferred HTTP calls are eligible here;
    // Credential waits resume exclusively when the agent-owned connect
    // operation succeeds; authority changes cannot imply credential presence.
    this.driver.nudgeAuthorityRedrive();
  }

  /**
   * The deferral half of the agent's `eval` tool. Kicks off a durable background run (`eval.start`,
   * idempotent on a deterministic effect id derived from `invocationId`, while keeping that run id
   * distinct from authorship. Crash-replay / deferRedrive therefore never duplicates the eval. It
   * returns `{deferred:true}` while in flight. The result normally
   * arrives directly from this agent's own EvalDO; if that was lost, a ~60s deferRedrive re-runs this and the
   * `get` backstop completes the invocation INLINE (`done` → result, `cancelled` → error).
   */
  protected async runDeferredEval(
    channelId: string,
    invocationId: string,
    args: unknown,
    scopedRpc: RpcClient,
  ): Promise<DeferredEvalGateResult> {
    const runId = ids.invocationEffect(invocationId);
    // Durable state FIRST (single source of truth: the outbox row). Once a
    // previous dispatch durably recorded an eval.start attempt, the run
    // identity is settled server-side: never re-validate the arguments (a
    // later deploy may have tightened the schema after EvalDO already holds a
    // durable terminal) and never call eval.start again (EvalDO.dispose()
    // deletes runs; a fresh start would re-INSERT and RE-EXECUTE a
    // side-effectful eval). eval.get is the only permitted operation.
    if (this.driver.hasDeferredEvalStartAttempted(channelId, runId)) {
      return await this.recoverStartedDeferredEval(
        channelId,
        invocationId,
        runId,
        scopedRpc,
      );
    }
    const p = prepareAgentToolArguments(
      {
        name: "eval",
        parameters: evalToolParameters,
      } as unknown as import("@workspace/pi-core").AgentTool,
      args ?? {},
    ) as {
      code?: string;
      path?: string;
      sourcePath?: string;
      reset?: boolean;
      syntax?: "javascript" | "typescript" | "jsx" | "tsx";
      imports?: Record<string, string>;
      timeoutMs?: number;
      authority?: Partial<
        import("@vibestudio/service-schemas/eval").EvalAuthorityIntent
      >;
    };
    let source;
    try {
      source = normalizeEvalToolSource(p);
    } catch (error) {
      return {
        result: `[eval] ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
    let authority;
    try {
      authority =
        p.authority === undefined
          ? undefined
          : evalAuthorityInputSchema.parse(p.authority);
    } catch (error) {
      return {
        result: `[eval] Invalid authority: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
    this.trackDeferredEval(channelId, runId);
    const executeDeferred = createDeferredEvalExecutor(
      <T>(method: string, callArgs: unknown[]) =>
        scopedRpc.call<T>("main", method, callArgs),
      {
        onBackstopError: (err) => {
          if (this.deferredEvalBackstopWarnings.has(runId)) return;
          this.deferredEvalBackstopWarnings.add(runId);
          console.warn(
            `[AgentVessel] eval.get backstop for ${runId} failed (run parked; push/redrive covers it):`,
            err instanceof Error ? err.message : err,
          );
        },
      },
    );
    // Commit the single-dispatch fence before crossing into EvalDO. The RPC
    // outcome is inherently ambiguous: any rejection may follow
    // server-side acceptance. Recovery is therefore read-only (`eval.get`) and
    // can never recreate a disposed side-effectful run.
    this.driver.markDeferredEvalStartAttempted(channelId, runId);
    let settlement;
    try {
      settlement = await executeDeferred({
        scope: { key: channelId },
        reset: p.reset === true,
        source,
        imports: p.imports,
        ...(p.timeoutMs === undefined ? {} : { timeoutMs: p.timeoutMs }),
        authority,
        runId,
      });
    } catch (error) {
      // A structured service/application/access rejection is a completed RPC:
      // eval.start definitively rejected the request before admitting an
      // EvalDO run. In particular, exact preauthorization validates its
      // prospective invocation during prepareRun, before dispatch. Treating
      // that response as an ambiguous lost acknowledgement strands a bogus
      // started fence and replaces the actionable error with
      // runtime_generation_lost. Only transport/unstructured failures retain
      // the conservative read-only recovery path below.
      if (
        error instanceof RemoteRpcError &&
        (error.errorKind === "service" ||
          error.errorKind === "application" ||
          error.errorKind === "access")
      ) {
        this.forgetDeferredEval(channelId, runId);
        return this.deferredEvalSettlement(invocationId, {
          success: false,
          console: "",
          error: error.message,
          ...(error.code ? { failureCode: error.code } : {}),
          ...(error.errorData ? { errorData: error.errorData } : {}),
        });
      }
      console.warn(
        `[AgentVessel] eval.start outcome for ${runId} is ambiguous; reconciling read-only:`,
        error instanceof Error ? error.message : error,
      );
      return await this.recoverStartedDeferredEval(
        channelId,
        invocationId,
        runId,
        scopedRpc,
      );
    }
    if (!settlement.deferred) {
      this.forgetDeferredEval(channelId, runId);
      // eval.start returned the result inline — no push channel was exercised,
      // so this must not inflate the push side of the push-vs-backstop ratio.
      this.traceHotPath(channelId, "deferred-eval.completed", {
        source: "inline",
      });
      return this.deferredEvalSettlement(invocationId, settlement.result);
    }
    await this.publishDeferredEvalPending(channelId, invocationId, runId);
    return { deferred: true, reason: "external-result" };
  }

  /**
   * Redrive path for a run whose eval.start ack is durably recorded: the ONLY
   * consultation is the read-only durable run state (`eval.get`). A terminal
   * settles inline; a live run stays parked. A missing row is not immediately
   * terminal because the host may still be reconciling an ambiguously
   * acknowledged, idempotent start. The run stays parked for push/redrive; a
   * persistently absent generation is settled by the durable retry budget
   * without ever re-executing the eval body.
   */
  private async recoverStartedDeferredEval(
    channelId: string,
    invocationId: string,
    runId: string,
    scopedRpc: RpcClient,
  ): Promise<DeferredEvalGateResult> {
    this.trackDeferredEval(channelId, runId);
    let snapshot: { status: string; result?: EvalRunResult };
    try {
      snapshot = await scopedRpc.call("main", "eval.get", [
        { scopeKey: channelId, runId },
      ]);
    } catch (error) {
      // EvalDO unreachable: leave the run parked; the terminal push or the
      // next redrive recovers it. An outage must never settle the invocation.
      if (!this.deferredEvalBackstopWarnings.has(runId)) {
        this.deferredEvalBackstopWarnings.add(runId);
        console.warn(
          `[AgentVessel] eval.get recovery for started run ${runId} failed (run stays parked):`,
          error instanceof Error ? error.message : error,
        );
      }
      return { deferred: true, reason: "external-result" };
    }
    if (snapshot.status === "unknown") {
      return { deferred: true, reason: "external-result" };
    }
    if (
      snapshot.status === "done" ||
      snapshot.status === "approval-route-lost"
    ) {
      if (!snapshot.result)
        throw new Error(`eval: terminal run ${runId} has no result`);
      this.forgetDeferredEval(channelId, runId);
      this.traceHotPath(channelId, "deferred-eval.completed", {
        source: "backstop-poll",
      });
      return this.deferredEvalSettlement(invocationId, snapshot.result);
    }
    if (snapshot.status === "cancelled") {
      this.forgetDeferredEval(channelId, runId);
      this.traceHotPath(channelId, "deferred-eval.completed", {
        source: "backstop-poll",
      });
      if (snapshot.result) {
        return this.deferredEvalSettlement(invocationId, snapshot.result);
      }
      return this.deferredEvalSettlement(invocationId, {
        success: false,
        console: "",
        error: "eval: run cancelled",
        failureKind: "cancelled",
        failureCode: "eval_cancelled",
      });
    }
    await this.publishDeferredEvalPending(channelId, invocationId, runId);
    return { deferred: true, reason: "external-result" };
  }

  /**
   * A deferred invocation is deliberately non-terminal, but it must never look
   * like an empty terminal. Publish a durable, idempotent lifecycle fact after
   * eval.start is acknowledged (and on read-only recovery) so the UI and an
   * operator can distinguish "pending; do not retry" from every settled state.
   */
  private async publishDeferredEvalPending(
    channelId: string,
    invocationId: string,
    runId: string,
  ): Promise<void> {
    const participantId =
      this.subscriptions.getParticipantId(channelId) ?? this.participantId();
    const actor = this.cardActor(channelId, participantId);
    const event: AgenticEvent<"invocation.progress"> = {
      kind: "invocation.progress",
      actor,
      causality: { invocationId: invocationId as never },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        message: `Eval is running as ${runId}; this invocation is pending. Do not retry.`,
        data: {
          eval: {
            runId,
            state: "running",
            retryDirective: "do_not_retry",
          },
        },
      },
      createdAt: new Date().toISOString(),
    };
    try {
      await this.createChannelClient(channelId).publishAgenticEvent(
        participantId,
        event,
        {
          idempotencyKey: `eval-pending:${runId}`,
          senderMetadata: actor.metadata,
        },
      );
    } catch (error) {
      // The invocation outbox and EvalDO run remain authoritative. A failed
      // explanatory projection must not settle or re-execute durable eval.
      console.warn(
        `[AgentVessel] failed to publish pending state for ${runId}; eval remains parked:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /** Shared terminal formatting for both the first-dispatch settlement and the
   * durable-recovery settlement, so both produce identical tool results. */
  private deferredEvalSettlement(
    invocationId: string,
    statusResult: EvalRunResult,
  ): DeferredEvalGateResult {
    const formatted = formatEvalResult(statusResult);
    const failure =
      statusResult.success === true
        ? undefined
        : agentToolFailureFromUnknown(
            {
              message: statusResult.error ?? "eval failed",
              code: statusResult.failureCode,
              errorData: statusResult.errorData,
            },
            {
              operation: "tool.eval",
              stage: "execute",
              causal: { invocationId },
              ...(statusResult.failureKind === "infrastructure"
                ? { kind: "infrastructure" as const }
                : {}),
            },
          );
    return {
      result: {
        protocolContent: formatted.content,
        details: formatted.details,
      },
      // Preserve the structured diagnostic, but do not lie about its
      // terminal outcome. A user-code exception is still a failed eval tool
      // invocation; callers (and the system-test harness) must be able to
      // distinguish it from a successful execution and explicitly classify
      // deliberate failures when appropriate.
      isError: statusResult.success !== true,
      ...(statusResult.failureKind === "infrastructure"
        ? { terminalOutcome: "infrastructure_error" as const }
        : {}),
      ...(failure ? { terminalReasonCode: failure.code, failure } : {}),
    };
  }

  private trackDeferredEval(channelId: string, runId: string): void {
    const runs = this.deferredEvalRuns.get(channelId) ?? new Set<string>();
    runs.add(runId);
    this.deferredEvalRuns.set(channelId, runs);
  }

  private forgetDeferredEval(channelId: string, runId: string): void {
    this.deferredEvalBackstopWarnings.delete(runId);
    const runs = this.deferredEvalRuns.get(channelId);
    if (!runs) return;
    runs.delete(runId);
    if (runs.size === 0) this.deferredEvalRuns.delete(channelId);
  }

  /** Persist the cancellation obligation while the deferred outbox row still
   * names the exact EvalDO run. Interrupt/abort may remove that row, so every
   * terminal channel lifecycle must call this before changing loop state. */
  private recordDeferredEvalCancelIntents(channelId: string): void {
    const runIds = new Set<string>(this.deferredEvalRuns.get(channelId) ?? []);
    for (const row of this.driver.deferredEvalRows(channelId))
      runIds.add(row.effectId);
    if (runIds.size === 0) return;
    const now = Date.now();
    for (const runId of runIds) {
      this.sql.exec(
        `INSERT OR IGNORE INTO deferred_eval_cancel_intents
           (channel_id, run_id, created_at, attempts, next_attempt_at)
         VALUES (?, ?, ?, 0, ?)`,
        channelId,
        runId,
        now,
        now,
      );
    }
    this.deferredEvalRuns.delete(channelId);
  }

  /** Close the turn only after its EvalDO cancellation obligation is durable,
   * then deliver that cancellation after the loop can no longer resume from a
   * racing eval terminal. Delivery failure remains a durable retry intent. */
  private async interruptChannelAndCancelDeferredEvals(
    channelId: string,
    flushDeferred: boolean,
  ): Promise<void> {
    this.recordDeferredEvalCancelIntents(channelId);
    try {
      await this.driver.interruptChannel(channelId, flushDeferred);
    } finally {
      await this.drainEvalCancelIntents();
    }
  }

  /**
   * Retire every deferred eval owned by a channel. NEVER throws: an EvalDO
   * outage is exactly the failure class this hardens against, and it must not
   * block unsubscribe/retire. Each run's cancellation is first recorded as a
   * durable, idempotent cancel intent; the intent is deleted only after
   * EvalDO acknowledges `eval.cancel`, and surviving intents are redriven by
   * lifecycle events (resume) with the cancel-intent alarm as the final
   * backstop. EvalDO's own cancelRunsForLifecycle + reconcileOrphanedRuns
   * bound any residual leak.
   *
   * The run set is enumerated from DURABLE state (the parked local_tool:eval
   * outbox rows) — the in-memory map is only a cache and is empty right after
   * a generation change.
   */
  private async cancelDeferredEvalRuns(channelId: string): Promise<void> {
    this.recordDeferredEvalCancelIntents(channelId);
    await this.drainEvalCancelIntents();
  }

  /**
   * Attempt every due cancel intent once; delete an intent only on an
   * acknowledged `eval.cancel` (idempotent on EvalDO). A failed attempt keeps
   * the intent durable and re-arms the backstop alarm. Never throws.
   */
  protected async drainEvalCancelIntents(): Promise<void> {
    // Every drain trigger is a lifecycle event (retire, resume, backstop
    // alarm) — attempt ALL surviving intents each time. `next_attempt_at`
    // only schedules the backstop alarm; it is not an attempt gate.
    const intents = (
      this.sql
        .exec(
          `SELECT channel_id, run_id FROM deferred_eval_cancel_intents ORDER BY created_at`,
        )
        .toArray() as Array<Record<string, unknown>>
    ).map((row) => ({
      channelId: String(row["channel_id"]),
      runId: String(row["run_id"]),
    }));
    for (const intent of intents) {
      try {
        await this.rpc.call("main", "eval.cancel", [
          { scopeKey: intent.channelId, runId: intent.runId },
        ]);
        this.sql.exec(
          `DELETE FROM deferred_eval_cancel_intents WHERE channel_id = ? AND run_id = ?`,
          intent.channelId,
          intent.runId,
        );
      } catch (error) {
        console.warn(
          `[AgentVessel] deferred-eval cancel intent for ${intent.runId} not yet delivered (kept durable):`,
          error instanceof Error ? error.message : error,
        );
        this.sql.exec(
          `UPDATE deferred_eval_cancel_intents
              SET attempts = attempts + 1,
                  next_attempt_at = ?
            WHERE channel_id = ? AND run_id = ?`,
          Date.now() + EVAL_CANCEL_INTENT_RETRY_MS,
          intent.channelId,
          intent.runId,
        );
      }
    }
  }

  private nextEvalCancelIntentWakeAt(): number | null {
    const row = this.sql
      .exec(
        `SELECT MIN(next_attempt_at) AS due FROM deferred_eval_cancel_intents`,
      )
      .toArray()[0];
    const value = row?.["due"];
    return typeof value === "number" ? value : null;
  }

  /**
   * Streamed eval console — the rolling-output sibling of `onEvalComplete`. The agent's eval runs in
   * a server-side EvalDO; during the run the EvalDO forwards buffered console chunks here (gated
   * by `assertOwnEvalCaller`, exactly like the `chat` binding's `chatOp` — only this agent's own
   * EvalDO may act as it). Each chunk is published as an `invocation.output` event keyed to the eval
   * parent tool invocation (`agentInvocationId`), independently of the eval effect's `runId`, so the
   * chat panel renders the console live AND persists it for the card's details view. Best-effort: a
   * dropped chunk is just a gap in the live console — the
   * final result still carries the full console text. Ordering: the EvalDO awaits its final flush
   * before completing, so every output precedes the `invocation.completed` terminal (the reducer drops
   * output after terminal).
   */
  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async onEvalProgress(payload: {
    runId: string;
    agentInvocationId: string;
    channelId: string;
    output?: string;
    activity?: {
      kind: "authority-requested" | "authority-decided";
      detail?: unknown;
    };
  }): Promise<void> {
    await this.assertOwnEvalCaller(payload.channelId);
    if (payload.activity) {
      const detail =
        payload.activity.detail && typeof payload.activity.detail === "object"
          ? (payload.activity.detail as Record<string, unknown>)
          : {};
      const capability =
        typeof detail["capability"] === "string"
          ? detail["capability"]
          : undefined;
      const resourceKey =
        typeof detail["resourceKey"] === "string"
          ? detail["resourceKey"]
          : undefined;
      const waiting = payload.activity.kind === "authority-requested";
      const message = waiting
        ? `Waiting for approval${capability ? ` to use ${capability}` : ""}${resourceKey ? ` on ${resourceKey}` : ""}`
        : "Approval decision received; resuming eval";
      const participantId =
        this.subscriptions.getParticipantId(payload.channelId) ??
        this.participantId();
      const actor = this.cardActor(payload.channelId, participantId);
      const event: AgenticEvent<"invocation.progress"> = {
        kind: "invocation.progress",
        actor,
        causality: { invocationId: payload.agentInvocationId as never },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          message,
          data: {
            eval: {
              runId: payload.runId,
              activity: waiting ? "authority-pending" : "executing",
              detail: payload.activity.detail,
            },
          },
        },
        createdAt: new Date().toISOString(),
      };
      await this.createChannelClient(payload.channelId).publishAgenticEvent(
        participantId,
        event,
        {
          senderMetadata: actor.metadata,
        },
      );
      return;
    }
    if (!payload.output) return;
    const participantId =
      this.subscriptions.getParticipantId(payload.channelId) ??
      this.participantId();
    const actor = this.cardActor(payload.channelId, participantId);
    const event: AgenticEvent<"invocation.output"> = {
      kind: "invocation.output",
      actor,
      causality: { invocationId: payload.agentInvocationId as never },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        output: payload.output,
        channel: "stdout",
      },
      createdAt: new Date().toISOString(),
    };
    await this.createChannelClient(payload.channelId).publishAgenticEvent(
      participantId,
      event,
      {
        senderMetadata: actor.metadata,
      },
    );
  }

  /**
   * Settle the exact eval effect addressed by `runId`. Parent invocation
   * identity is carried separately for causality and never reconstructed from
   * the effect id. Duplicate settlement is an idempotent driver no-op.
   */
  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async onEvalComplete(payload: {
    runId: string;
    agentInvocationId?: string;
    result?: EvalRunResult;
    channelId?: string;
  }): Promise<void> {
    if (!payload.channelId || !payload.result) return;
    await this.assertOwnEvalCaller(payload.channelId);
    this.forgetDeferredEval(payload.channelId, payload.runId);
    const formatted = formatEvalResult(payload.result);
    const failure =
      payload.result.success === true
        ? undefined
        : agentToolFailureFromUnknown(
            {
              message: payload.result.error ?? "eval failed",
              code: payload.result.failureCode,
              errorData: payload.result.errorData,
            },
            {
              operation: "tool.eval",
              stage: "execute",
              causal: {
                invocationId: payload.agentInvocationId ?? payload.runId,
              },
              ...(payload.result.failureKind === "infrastructure"
                ? { kind: "infrastructure" as const }
                : {}),
            },
          );
    const delivered = await this.driver.deliverEffectOutcome(
      payload.runId,
      {
        kind: "tool",
        result: {
          protocolContent: formatted.content,
          details: formatted.details,
        },
        isError: payload.result.success !== true,
        ...(payload.result.failureKind === "infrastructure"
          ? { terminalOutcome: "infrastructure_error" as const }
          : {}),
        ...(failure ? { terminalReasonCode: failure.code, failure } : {}),
      },
      { channelId: payload.channelId },
    );
    if (delivered) {
      this.traceHotPath(payload.channelId, "deferred-eval.completed", {
        source: "direct-push",
      });
    }
  }

  // ── Custom message recovery (CardManager read path) ─────────────────────

  /** Fold this agent's own custom messages from the channel log:
   *  Map<typeId, Map<messageId, state>> with card reducers applied. Used by
   *  card-owning agents to recover live card state after hibernation/fork. */
  protected async indexOwnCustomMessages(
    channelId: string,
    reducerLookup?: (typeId: string) => CustomMessageReducer | undefined | null,
  ): Promise<Map<string, Map<string, unknown>>> {
    const selfParticipantId = this.subscriptions.getParticipantId(channelId);
    if (!selfParticipantId) return new Map();

    const byMessageId = new Map<string, { typeId: string; state: unknown }>();
    const channel = this.createChannelClient(channelId);
    for await (const envelope of iterateChannelReplayAfterPages(
      (request) => channel.getReplayAfter(request),
      { after: 0 },
    )) {
      const events = envelope.logEvents;
      for (const event of events) {
        if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) continue;
        const agentic = event.payload as {
          kind?: string;
          actor?: { id?: string; participantId?: string };
          payload?: Record<string, unknown>;
        } | null;
        const actor = agentic?.actor;
        if (
          actor?.participantId !== selfParticipantId &&
          actor?.id !== selfParticipantId
        ) {
          continue;
        }
        const payload = agentic?.payload ?? {};
        if (agentic?.kind === "custom.started") {
          const messageId =
            typeof payload["messageId"] === "string"
              ? payload["messageId"]
              : null;
          const typeId =
            typeof payload["typeId"] === "string" ? payload["typeId"] : null;
          if (!messageId || !typeId) continue;
          byMessageId.set(messageId, {
            typeId,
            state: await this.hydrateTransportValue(payload["initialState"]),
          });
          continue;
        }
        if (agentic?.kind === "custom.updated") {
          const messageId =
            typeof payload["messageId"] === "string"
              ? payload["messageId"]
              : null;
          if (!messageId) continue;
          const existing = byMessageId.get(messageId);
          if (!existing) continue;
          const reducer = reducerLookup?.(existing.typeId) ?? null;
          const update = await this.hydrateTransportValue(payload["update"]);
          byMessageId.set(messageId, {
            typeId: existing.typeId,
            state: reducer ? reducer(existing.state, update) : update,
          });
        }
      }
    }

    const byType = new Map<string, Map<string, unknown>>();
    for (const [messageId, { typeId, state }] of byMessageId.entries()) {
      let messages = byType.get(typeId);
      if (!messages) {
        messages = new Map();
        byType.set(typeId, messages);
      }
      messages.set(messageId, state);
    }
    return byType;
  }

  private async hydrateTransportValue(
    value: unknown,
    originSessionId?: string | null,
    via = "channel-value-hydration",
  ): Promise<unknown> {
    if (originSessionId)
      await this.recordDerivedSessionIngestion(originSessionId, via);
    return hydrateStoredValueRefs(value, {
      getText: (digest) =>
        this.rpc.call<string | null>("main", "blobstore.getText", [digest]),
    });
  }

  /** Advance the monotone latch before indirect userland content is exposed to
   * prompt composition or a tool result. The server resolves the origin
   * session's persisted class; unknown origins conservatively become external. */
  private async recordDerivedSessionIngestion(
    originSessionId: string,
    via: string,
  ): Promise<void> {
    if (!originSessionId || originSessionId === this.participantId()) return;
    await this.rpc.call("main", "contextIntegrity.ingest", [
      { key: `session:${originSessionId}`, via, classification: "derived" },
    ]);
  }

  private async recordMessageIngestion(
    channelId: string,
    event: ChannelEvent,
    via: string,
  ): Promise<void> {
    if (!channelId || !event.messageId) {
      throw new Error(
        `${via}: durable channel identity is required before content ingestion`,
      );
    }
    await this.rpc.call("main", "contextIntegrity.ingest", [
      {
        key: `msg:${channelId}/${event.messageId}`,
        via,
        classification: "derived",
      },
    ]);
  }

  // ── Subclass conveniences ────────────────────────────────────────────────

  /** Whether a channel event is a client-authored completed message. */
  protected shouldProcess(event: ChannelEvent): boolean {
    if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) return false;
    if (event.senderId === this.participantId()) return false;
    const agentic = event.payload as { kind?: string } | null;
    return agentic?.kind === "message.completed";
  }

  /** Plain-text turn input extracted from a channel event. */
  protected buildTurnInput(event: ChannelEvent): { content: string } {
    const agentic = event.payload as {
      payload?: { blocks?: unknown[] };
    } | null;
    const blocks = agentic?.payload?.blocks ?? [];
    const content = blocks
      .map((block) =>
        block &&
        typeof block === "object" &&
        typeof (block as { content?: unknown }).content === "string"
          ? (block as { content: string }).content
          : "",
      )
      .filter(Boolean)
      .join("\n");
    return { content };
  }

  /** Journal an agent-initiated prompt (digest turns, onboarding nudges).
   *  `steeringId` keys the deterministic turn identity — re-submission with
   *  the same id is a replay no-op all the way down. */
  protected async submitAgentInitiatedTurn(
    channelId: string,
    input: { content: string },
    opts?: AgentInitiatedTurnOptions,
  ): Promise<void> {
    const { steeringId, ...turnMetadata } = opts ?? {};
    const metadata: AgentTurnMetadata = {
      ...turnMetadata,
      origin: turnMetadata.origin ?? "agent-initiated",
    };
    await this.driver.handleIncoming(channelId, {
      type: "command",
      command: {
        kind: "prompt",
        channelId,
        source: { envelopeId: steeringId ?? `agent-init:${Date.now()}` },
        content: input.content,
        senderRef: { kind: "system", id: metadata.origin ?? "agent-initiated" },
        metadata,
      },
    });
  }

  /** Resolve the current model's API key (out-of-loop helpers like draft
   *  writers). When no credential is configured, publishes a connect-only
   *  credential card (resumeAfterConnect: false — one-shot flows have no
   *  parked turn to resume) and throws with the canonical message. */
  protected async resolveModelApiKey(
    channelId: string,
    opts?: { connectCard?: boolean },
  ): Promise<string> {
    const model = this.getAgentSettings().model;
    const providerId = model.includes(":")
      ? model.slice(0, model.indexOf(":"))
      : "anthropic";
    const modelId = model.includes(":")
      ? model.slice(model.indexOf(":") + 1)
      : model;
    try {
      const { getBuiltinModel: getModel } =
        await import("@workspace/pi-ai/providers/all");
      const registryModel = getModel(providerId as never, modelId as never) as
        | { baseUrl?: string }
        | undefined;
      const modelBaseUrl =
        typeof registryModel?.baseUrl === "string"
          ? registryModel.baseUrl
          : undefined;
      const resolved = await this.executorDeps().credentials.getApiKey({
        providerId,
        ...(modelBaseUrl ? { modelBaseUrl } : {}),
      });
      return resolved.apiKey;
    } catch (err) {
      if (
        err instanceof CredentialPendingError &&
        opts?.connectCard !== false
      ) {
        await this.publishCredentialConnectCard(channelId, providerId, {
          resumeAfterConnect: false,
        });
      }
      throw new Error(
        `No URL-bound model credential is configured for model provider: ${providerId}`,
      );
    }
  }

  /** The credential-connect inline card (same renderer the chat panel ships). */
  protected async publishCredentialConnectCard(
    channelId: string,
    providerId: string,
    opts: { resumeAfterConnect: boolean; reason?: string },
  ): Promise<void> {
    const participantId =
      this.subscriptions.getParticipantId(channelId) ?? this.participantId();
    const cardId = `model-credential-${providerId}:${channelId}`;
    const event: AgenticEvent<"ui.inline_rendered"> = {
      kind: "ui.inline_rendered",
      actor: { kind: "agent", id: participantId, displayName: participantId },
      payload: {
        protocol: "agentic.trajectory.v1",
        uiType: "inline",
        id: cardId,
        source: {
          type: "file",
          path: "packages/agentic-chat/components/ModelCredentialRequiredCard.tsx",
        },
        props: {
          providerId,
          modelRef: this.getAgentSettings().model,
          agentParticipantId: participantId,
          resumeAfterConnect: opts.resumeAfterConnect,
          ...(opts.reason ? { reason: opts.reason } : {}),
          ...(this.getModelCredentialSetupProps(providerId) ?? {}),
        },
      },
      createdAt: new Date().toISOString(),
    };
    await this.createChannelClient(channelId)
      .publishAgenticEvent(participantId, event, {
        idempotencyKey: cardId,
        senderMetadata: { type: "agent", name: participantId },
      })
      .catch((err) => {
        console.error(
          `[AgentVessel] credential card emit failed for ${providerId}:`,
          err,
        );
      });
  }

  // ── Fork ─────────────────────────────────────────────────────────────────

  /** Per-channel fork preflight. Vets ONLY the named subscription (it must
   *  exist); a multi-channel agent forks the one channel and drops the rest in
   *  the clone (see {@link postClone}), so the old ≤1-subscription gate is gone. */
  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async canFork(channelId: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.subscriptions.getParticipantId(channelId)) {
      return { ok: false, reason: `no subscription for channel ${channelId}` };
    }
    return { ok: true };
  }

  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async postClone(
    _parentObjectKey: string,
    newChannelId: string,
    oldChannelId: string,
    forkPointPubsubId: number,
    // The clone's new context. A true context fork (`runtime.cloneContext`) lands
    // the clone in a fresh, isolated context; thread it so the agent's subscription
    // re-homes to it (the entity record is already in the new context).
    newContextId: string,
  ): Promise<void> {
    if (!newContextId) throw new Error("postClone requires newContextId");
    // fix identity (cloneDO copied the parent's)
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES ('__objectKey', ?)`,
      this.objectKey,
    );
    const from = channelTrajectoryFor(oldChannelId);
    const to = channelTrajectoryFor(newChannelId);
    const atSeq = await this.resolveTrajectorySeqForChannelSeq(
      from.logId,
      oldChannelId,
      forkPointPubsubId,
    );
    await this.callGad("forkLog", {
      fromLogId: from.logId,
      fromHead: from.head,
      toLogId: to.logId,
      toHead: to.head,
      atSeq,
    });
    const driver = this.driver;
    // caches: wiped, reconverge (P3)
    this.sql.exec(`DELETE FROM effect_outbox`);
    this.sql.exec(`DELETE FROM fold_cache`);
    this.subscriptions.rename(oldChannelId, newChannelId, newContextId);
    // Per-channel fork: the clone is a NEW entity and must NOT ghost-join the
    // parent's OTHER channels (cloneDO copied the whole subscriptions table).
    // Drop every subscription except the forked one — delete the local row and
    // the driver loop, but DO NOT call the channel DO to unsubscribe: the copied
    // rows still carry the PARENT's participantId, so an unsubscribe would evict
    // the parent from its own channels. This runs BEFORE driver.wake so the
    // driver never wakes a loop for a channel the clone no longer holds.
    for (const otherChannelId of this.subscriptions.listChannelIds()) {
      if (otherChannelId === newChannelId) continue;
      this.subscriptions.deleteSubscription(otherChannelId);
      driver.dropLoop(otherChannelId);
    }
    // Subclass fork cleanup/setup runs with the rename applied but BEFORE the
    // new channel is (re)subscribed, so subclasses can purge per-channel state
    // the clone copied and influence the upcoming subscribe.
    await this.onChannelForked({
      oldChannelId,
      newChannelId,
      forkPointPubsubId,
    });
    await this.subscribeChannel({
      channelId: newChannelId,
      // After rename, getContextId(newChannelId) reflects newContextId.
      contextId: this.subscriptions.getContextId(newChannelId),
      config: this.subscriptions.getConfig(newChannelId) ?? undefined,
      replay: false,
    });
    await driver.wake(newChannelId); // fork policy settles pre-cut pendings
  }

  private async resolveTrajectorySeqForChannelSeq(
    trajectoryLogId: string,
    channelId: string,
    channelSeq: number,
  ): Promise<number> {
    const fork = await this.callGad<{ seq: number }>(
      "resolveTrajectoryForkPoint",
      {
        trajectoryId: trajectoryLogId,
        branchId: trajectoryLogId,
        channelId,
        channelSeq,
      },
    );
    return fork.seq;
  }

  /**
   * Re-root a FRESH child vessel's identity + trajectory from a parent agent's
   * trajectory at `seq` — the sibling of {@link postClone} for the
   * `spawn_subagent(mode:"fork")` path. No DO storage was cloned (the entity was
   * just created), so there is nothing to wipe: outbox/fold caches start empty.
   * The child boots knowing everything the parent knew at the fork point.
   */
  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async initFromTrajectoryFork(opts: {
    parentLogId: string;
    seq: number;
    taskChannelId: string;
    contextId: string;
    config?: unknown;
  }): Promise<{ ok: boolean; participantId: string }> {
    this.ensureIdentity();
    // Fix identity for parity with postClone (a fresh DO already has it correct).
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES ('__objectKey', ?)`,
      this.objectKey,
    );
    // `seq` is already a TRAJECTORY seq (the parent's folded head), not a channel
    // seq — no resolveTrajectorySeqForChannelSeq indirection needed.
    await this.ensureSubagentTaskTrajectoryFork({
      parentLogId: opts.parentLogId,
      parentSeq: opts.seq,
      taskChannelId: opts.taskChannelId,
    });
    const subscription = await this.subscribeChannel({
      channelId: opts.taskChannelId,
      contextId: opts.contextId,
      config: opts.config,
      replay: false,
    });
    // Fold hydration preserves the inherited semantic entries but normalizes
    // all pre-cut prompt/control projections. Wake validates that quiescent
    // boundary; only the later child seed may open executable work.
    await this.driver.wake(opts.taskChannelId);
    return subscription;
  }

  // ── Subagents ──────────────────────────────────────────────────────────────

  /** This agent's own subagent identity (set in `STATE_ARGS.subagent` at spawn),
   *  or null for a top-level agent. Drives depth accounting + the child `complete`
   *  tool gate. */
  protected subagentIdentity(): SubagentIdentity | null {
    const stateArgs = this.env["STATE_ARGS"];
    const raw =
      stateArgs && typeof stateArgs === "object"
        ? (stateArgs as Record<string, unknown>)["subagent"]
        : undefined;
    if (!raw || typeof raw !== "object") return null;
    const s = raw as Record<string, unknown>;
    if (
      typeof s["runId"] !== "string" ||
      typeof s["task"] !== "string" ||
      s["task"].trim().length === 0 ||
      typeof s["parentRef"] !== "string" ||
      typeof s["parentChannelId"] !== "string" ||
      typeof s["taskChannelId"] !== "string" ||
      typeof s["parentParticipantId"] !== "string"
    ) {
      return null;
    }
    return {
      runId: s["runId"],
      task: s["task"],
      parentRef: s["parentRef"],
      parentChannelId: s["parentChannelId"],
      taskChannelId: s["taskChannelId"],
      parentContextId:
        typeof s["parentContextId"] === "string" ? s["parentContextId"] : "",
      depth: typeof s["depth"] === "number" ? s["depth"] : 0,
      mode:
        s["mode"] === "fork" || s["mode"] === "fresh" ? s["mode"] : undefined,
      parentParticipantId: s["parentParticipantId"],
      lineageParticipantIds: Array.isArray(s["lineageParticipantIds"])
        ? s["lineageParticipantIds"].filter(
            (value): value is string =>
              typeof value === "string" && value.length > 0,
          )
        : undefined,
    };
  }

  /** True when this agent was spawned as a subagent (advertises `complete`). */
  protected isSubagent(): boolean {
    return this.subagentIdentity() !== null;
  }

  /** Validate a model's request to wait for supervised work against both
   * retained child lifecycle and already-admitted terminal prompts. A child
   * may finish while the parent's spawning turn is still open; in that case
   * the report is durably deferred until the turn closes and suspension is
   * precisely what releases it. */
  protected async guardBackgroundSuspension(channelId: string) {
    const supervised = this.subagentRuns
      .listAll()
      .filter((run) => run.parentChannelId === channelId);
    const live = supervised.filter(
      (run) => run.status === "starting" || run.status === "running",
    );
    if (live.length > 0) return { suspend: true };

    const terminalRunIds = new Set(supervised.map((run) => run.runId));
    if (terminalRunIds.size > 0) {
      const loop = await this.driver.loop(channelId);
      const admittedTerminalReport = loop.state.deferredPostTurnQueue.some(
        (prompt) => {
          const runId = prompt.metadata?.supervisedTerminalRunId;
          return typeof runId === "string" && terminalRunIds.has(runId);
        },
      );
      if (admittedTerminalReport) return { suspend: true };
    }

    const completedRunsAwaitingIntegration = supervised
      .filter(
        (run) => run.semanticIntegrationSnapshot?.["state"] !== "complete",
      )
      .map((run) => subagentRunHandle(run.runId));
    return {
      suspend: false,
      reason: "no_live_supervised_runs",
      message:
        completedRunsAwaitingIntegration.length > 0
          ? `Turn not suspended: no supervised subagent is live and no terminal report is waiting to enter this conversation. Review the retained result(s) ${completedRunsAwaitingIntegration.join(", ")} and continue the user goal; integrate only when the goal calls for incorporating the child work.`
          : "Turn not suspended: no supervised subagent is live. Continue or finish the foreground request.",
      details: { completedRunsAwaitingIntegration },
    };
  }

  /** True once this run's terminal intent + execution fence committed (§7.2
   *  step 1). The wake row is the durable fact; it is retained after the
   *  notification settles, so the fence survives restart and hibernation. */
  private subagentTerminalIntentRecorded(runId: string): boolean {
    return (
      this.sql
        .exec(
          `SELECT 1 FROM agent_wake_queue WHERE wake_id = ?`,
          `subagent-terminal-publish:${runId}`,
        )
        .toArray().length > 0
    );
  }

  private currentSubagentDepth(): number {
    return this.subagentIdentity()?.depth ?? 0;
  }

  private toolText(
    text: string,
    details?: Record<string, unknown>,
  ): AgentToolResult<Record<string, unknown>> {
    return { content: [{ type: "text", text }], details: details ?? {} };
  }

  /**
   * Fork only completed conversational history. The currently open parent turn
   * contains executable control state (and often an assistant tool-call block
   * whose results do not exist yet); inheriting it produces dangling calls and
   * lets a child continue the supervisor's work before its own task seed.
   */
  private async trajectoryForkSeq(channelId: string): Promise<number> {
    try {
      const loop = await this.driver.loop(channelId);
      return loop.state.openTurn
        ? Math.max(0, loop.state.openTurn.openedAtSeq - 1)
        : loop.state.lastSeq;
    } catch {
      return 0;
    }
  }

  private async ensureSubagentTaskTrajectoryFork(input: {
    parentLogId: string;
    parentSeq: number;
    taskChannelId: string;
  }): Promise<number> {
    const to = channelTrajectoryFor(input.taskChannelId);
    const existing = await this.callGad<{
      parentLogId: string | null;
      parentHead: string | null;
      forkSeq: number | null;
    } | null>("getLogHead", { logId: to.logId, head: to.head });
    const parentHead = input.parentLogId;
    const equivalentExisting =
      existing?.parentLogId === input.parentLogId &&
      existing.parentHead === parentHead &&
      existing.forkSeq != null;
    if (existing && !equivalentExisting) {
      throw new Error(
        `subagent task trajectory already exists with different fork lineage: ${to.logId}:${to.head}`,
      );
    }
    const atSeq = equivalentExisting ? existing.forkSeq! : input.parentSeq;
    await this.callGad("forkLog", {
      fromLogId: input.parentLogId,
      fromHead: parentHead,
      toLogId: to.logId,
      toHead: to.head,
      atSeq,
    });
    return atSeq;
  }

  /**
   * Launch `spawn_subagent`. Mints the child context (deterministic under
   * `targetKey`) + child agent entity, explicitly creates the task trajectory
   * fork, wires the task channel (child subscribes, parent watches explicit messages),
   * seeds the task, records the run + the parent-trajectory task card,
   * then returns a run handle.
   * Guarded by depth/fan-out. Any failure settles inline as a tool error.
   */
  protected async runDeferredSpawn(
    channelId: string,
    invocationId: string,
    args: unknown,
    invocationRpc: RpcClient,
  ): Promise<{ result: unknown; isError: boolean }> {
    try {
      const p = (args ?? {}) as {
        mode?: unknown;
        task?: unknown;
        config?: unknown;
        label?: unknown;
        agentKind?: unknown;
      };
      const mode: "fresh" | "fork" = p.mode === "fork" ? "fork" : "fresh";
      const agentKind = normalizeSubagentAgentKind(p.agentKind);
      if (!agentKind) {
        return {
          result:
            "spawn_subagent agentKind must be 'pi' or a valid extension launcher id",
          isError: true,
        };
      }
      const task = typeof p.task === "string" ? p.task : "";
      if (!task.trim()) {
        return {
          result: "spawn_subagent requires a non-empty durable task",
          isError: true,
        };
      }
      // Idempotency: a re-driven spawn returns the SAME run handle.
      const existingRun = this.subagentRuns.get(invocationId);
      if (existingRun) {
        if (existingRun.status === "starting") {
          console.warn(
            `[AgentVessel] resetting stale starting subagent run ${existingRun.runId}`,
          );
          await this.rollbackFailedSubagentSpawn(existingRun);
        } else {
          if (existingRun.status === "running" && task.trim()) {
            console.info(
              `[AgentVessel] retrying subagent seed for existing run ${existingRun.runId}`,
            );
            await this.publishSubagentSeed(existingRun, task);
          }
          return {
            result: {
              protocolContent: [
                {
                  type: "text",
                  text: subagentLaunchReceipt(existingRun),
                },
              ],
              details: this.subagentRunDetails(existingRun),
            },
            isError: false,
          };
        }
      }

      const loopConfig = this.loopConfig(channelId);
      const maxDepth =
        loopConfig.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
      const maxSubagents = loopConfig.maxSubagents ?? DEFAULT_MAX_SUBAGENTS;
      const childDepth = this.currentSubagentDepth() + 1;
      if (childDepth > maxDepth) {
        return {
          result: `subagent depth limit reached (max ${maxDepth})`,
          isError: true,
        };
      }
      if (this.subagentRuns.countLive() >= maxSubagents) {
        return {
          result: `subagent execution limit reached (max ${maxSubagents}); wait for or cancel a live run before spawning another`,
          isError: true,
        };
      }

      const runId = invocationId;
      const targetKey = `subagent:${runId}`;
      const taskChannelId = `task-${runId}`;
      const label =
        typeof p.label === "string" && p.label.trim()
          ? p.label
          : mode === "fork"
            ? "forked subagent"
            : "subagent";
      const requestedChildConfig =
        p.config && typeof p.config === "object"
          ? (p.config as Record<string, unknown>)
          : undefined;
      // A Pi subagent is a child of THIS agent, so its behavioral defaults
      // should be the parent's effective settings rather than whichever model
      // happens to be the worker-wide default. Besides being the unsurprising
      // product behavior, this keeps unattended/headless trees uniform: a
      // parent pinned to a model, approval posture, or stream watchdog cannot
      // silently spawn a differently configured child. Explicit child config
      // remains an override. External launcher config is provider-specific CLI
      // input, so it intentionally does not receive Pi settings.
      const parentChannelConfig =
        (this.subscriptions.getConfig(channelId) as Record<
          string,
          unknown
        > | null) ?? {};
      const inheritedPromptConfig = Object.fromEntries(
        ["systemPrompt", "systemPromptMode"].flatMap((key) =>
          parentChannelConfig[key] === undefined
            ? []
            : [[key, parentChannelConfig[key]]],
        ),
      );
      const childConfig =
        agentKind === "pi"
          ? {
              model: loopConfig.model,
              thinkingLevel: loopConfig.thinkingLevel,
              ...(loopConfig.fallbackModelRef
                ? { fallbackModel: loopConfig.fallbackModelRef }
                : {}),
              ...(loopConfig.fallbackThinkingLevel
                ? { fallbackThinkingLevel: loopConfig.fallbackThinkingLevel }
                : {}),
              ...(loopConfig.fallbackFailureCodes
                ? { fallbackOn: [...loopConfig.fallbackFailureCodes] }
                : {}),
              ...(loopConfig.fallbackScope
                ? { fallbackScope: loopConfig.fallbackScope }
                : {}),
              approvalLevel: loopConfig.approvalLevel,
              respondPolicy: loopConfig.respondPolicy,
              ...inheritedPromptConfig,
              ...(requestedChildConfig ?? {}),
            }
          : requestedChildConfig;
      // Validate the effective Pi model configuration before minting any
      // context or entity. A caller typo is a local argument error, not a
      // partially-created lifecycle that must be repaired through teardown.
      // This uses the same materialization boundary as loopConfig(), so child
      // admission and execution cannot disagree about catalog availability.
      if (agentKind === "pi") {
        const childModel = childConfig?.["model"];
        if (
          typeof childModel !== "string" ||
          !this.materializedModel(channelId, childModel)
        ) {
          return {
            result:
              `Agent model ${JSON.stringify(childModel)} could not be materialized; ` +
              "select a model present in the current catalog before starting the agent",
            isError: true,
          };
        }
        const childFallbackModel = childConfig?.["fallbackModel"];
        if (
          childFallbackModel !== undefined &&
          (typeof childFallbackModel !== "string" ||
            !this.materializedModel(channelId, childFallbackModel))
        ) {
          return {
            result:
              `Agent fallback model ${JSON.stringify(childFallbackModel)} could not be materialized; ` +
              "select a fallback model present in the current catalog before starting the agent",
            isError: true,
          };
        }
      }
      // A Pi child inherits the parent's executable identity. Letting model
      // arguments choose an arbitrary package here conflates the task's source
      // repository with a runtime worker and can launch the wrong code (or a
      // non-runtime package). Different reasoning engines are selected through
      // agentKind; they do not replace the vessel implementation.
      const source = String(this.env["WORKER_SOURCE"] ?? "");
      const className =
        childConfig && typeof childConfig["className"] === "string"
          ? String(childConfig["className"])
          : String(this.env["WORKER_CLASS_NAME"] ?? this.constructor.name);
      if (!source) {
        return {
          result: "spawn_subagent could not resolve a child source",
          isError: true,
        };
      }

      const parentContextId = this.subscriptions.getContextId(channelId);
      const ownerEntityId = this.participantId();
      const ownerRuntimeContextId = await invocationRpc.call<string | null>(
        "main",
        "runtime.resolveContext",
        [ownerEntityId],
      );
      if (ownerRuntimeContextId && ownerRuntimeContextId !== parentContextId) {
        console.warn("[AgentVessel] spawn_subagent context mismatch", {
          channelId,
          invocationId,
          ownerEntityId,
          ownerRuntimeContextId,
          subscriptionContextId: parentContextId,
        });
        throw new Error(
          `spawn_subagent context mismatch: owner ${ownerEntityId} is registered in ` +
            `${ownerRuntimeContextId}, but channel ${channelId} is subscribed as ${parentContextId}`,
        );
      }

      // External subagent target: the child is a linked external session driven
      // by an extension-owned headless process, not an in-process Pi child.
      if (agentKind !== "pi") {
        return await this.runExternalSubagentSpawn(agentKind, channelId, {
          runId,
          taskChannelId,
          label,
          task,
          mode,
          childDepth,
          parentContextId,
          ownerEntityId,
          // For external kinds `config` is launcher options (the extension
          // whitelists what its CLI supports — e.g. model/effort for claude-code).
          ...(childConfig ? { launcherOptions: childConfig } : {}),
        });
      }

      // 1) Child context (deterministic; runtime records the lifecycle edge).
      const { contextId } = await createSubagentContext(invocationRpc, {
        parentContextId,
        ownerEntityId,
        targetKey,
      });

      // 2) Child agent entity in that context. createEntity derives parentId from
      //    the verified caller (this vessel) → the entity→entity edge lands.
      const parentSubagent = this.subagentIdentity();
      const lineageParticipantIds =
        mode === "fork"
          ? [
              ...new Set([
                ...(parentSubagent?.lineageParticipantIds ?? []),
                ...(parentSubagent?.mode === "fork"
                  ? [parentSubagent.parentParticipantId]
                  : []),
                this.participantId(),
              ]),
            ]
          : [];
      const childHandle = await createAgentEntity(invocationRpc, {
        source,
        className,
        key: targetKey,
        contextId,
        agentChannelId: taskChannelId,
        config: childConfig,
        stateArgs: {
          subagent: {
            runId,
            task,
            mode,
            parentRef: ownerEntityId,
            parentChannelId: channelId,
            taskChannelId,
            parentContextId,
            depth: childDepth,
            parentParticipantId: this.participantId(),
            lineageParticipantIds,
          },
        },
      });

      // 3) Record the run BEFORE any wake so replay + teardown can find it.
      const now = Date.now();
      const run: SubagentRunRow = {
        runId,
        taskChannelId,
        parentContextId: parentContextId ?? null,
        childContextId: contextId,
        childEntityId: childHandle.id ?? childHandle.targetId,
        childParticipantId: null,
        parentChannelId: channelId,
        mode,
        label,
        depth: childDepth,
        status: "starting",
        sourceEventId: null,
        semanticIntegrationSnapshot: null,
        startedAt: now,
        lastActivityAt: now,
        agentKind: "pi",
        launchConfig: observableSubagentLaunchConfig(childConfig),
        externalSessionEntityId: null,
        externalGenerationId: null,
      };
      this.subagentRuns.insert(run);

      // 4) For forked subagents, the spawn orchestrator creates the task
      // trajectory fork before ANY task-channel participant subscribes. That
      // keeps observer-side roster/presence bookkeeping from claiming the task
      // trajectory as a root log.
      const parentLogId = logIdForChannel(channelId);
      const parentSeq =
        mode === "fork" ? await this.trajectoryForkSeq(channelId) : 0;
      if (mode === "fork") {
        await this.ensureSubagentTaskTrajectoryFork({
          parentLogId,
          parentSeq,
          taskChannelId,
        });
      }

      // 5) Bring the child online on the task channel.
      let childParticipantId: string;
      if (mode === "fork") {
        const childSubscription = await initAgentFromTrajectoryFork(
          invocationRpc,
          childHandle,
          {
            parentLogId,
            seq: parentSeq,
            taskChannelId,
            contextId,
            config: childConfig,
          },
        );
        childParticipantId = childSubscription.participantId;
      } else {
        const childSubscription = await subscribeAgentToChannel(
          invocationRpc,
          childHandle,
          {
            channelId: taskChannelId,
            contextId,
            config: childConfig,
            replay: false,
          },
        );
        childParticipantId = childSubscription.participantId;
      }
      this.subagentRuns.setChildParticipantId(runId, childParticipantId);
      const effectiveChildSettings = await invocationRpc.call<
        Record<string, unknown>
      >(childHandle.targetId, "getAgentSettings", []);
      for (const key of ["model", "thinkingLevel"] as const) {
        const requested = requestedChildConfig?.[key];
        if (
          requested !== undefined &&
          effectiveChildSettings[key] !== requested
        ) {
          throw new Error(
            `spawn_subagent effective ${key} mismatch: requested ${JSON.stringify(requested)}, ` +
              `started ${JSON.stringify(effectiveChildSettings[key])}`,
          );
        }
      }
      const effectiveLaunchConfig =
        observableSubagentLaunchConfig(effectiveChildSettings) ??
        observableSubagentLaunchConfig(childConfig);
      this.subagentRuns.setLaunchConfig(runId, effectiveLaunchConfig);

      // 6) Supervisor stance on the task channel (§9): delivery interest
      // "addressed" — child tool activity stays in the canonical task log
      // with ZERO supervisor mailbox rows; only utterances addressed to the
      // supervisor (child `notify` carries the parent audience) create parent
      // work. NOTE: any future parent-made channel_call against a task
      // channel would need addressed invocation terminals before it could
      // settle under this stance.
      await this.subscribeChannel({
        channelId: taskChannelId,
        contextId,
        config: { wakePolicy: "explicit" },
        replay: false,
        delivery: "addressed",
      });

      // 6b) Stamp task provenance on the task channel so its getProvenance
      //     reports kind:"task" (B1) — parent home channel + context + runId.
      await this.createChannelClient(taskChannelId).recordTaskProvenance({
        parentChannelId: channelId,
        parentContextId: parentContextId ?? "",
        runId,
      });

      // 6) Durable run record on the parent's home channel (the subagent card),
      // then transition from setup to live before the child sees a task prompt.
      const startedRun = this.subagentRuns.get(runId);
      if (!startedRun?.childParticipantId) {
        throw new Error(`Subagent ${runId} reached publication without its participant identity`);
      }
      await this.publishSubagentStarted(startedRun);
      this.subagentRuns.setStatus(runId, "running");
      const runningRun = this.subagentRuns.get(runId) ?? {
        ...startedRun,
        status: "running" as const,
      };

      // 7) Seed the task prompt (both modes, when provided).
      await this.publishSubagentSeed(runningRun, task);

      return {
        result: {
          protocolContent: [
            { type: "text", text: subagentLaunchReceipt(runningRun) },
          ],
          details: this.subagentRunDetails(runningRun),
        },
        isError: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[AgentVessel] spawn_subagent failed", {
        channelId,
        invocationId,
        message,
      });
      const run = this.subagentRuns.get(invocationId);
      if (run && (run.status === "starting" || run.status === "running")) {
        if (run.status === "running") {
          try {
            await this.settleSubagentTerminal(run, "failed", message);
          } catch (terminalErr) {
            console.error(
              `[AgentVessel] subagent setup failure terminal emit failed for ${run.runId}:`,
              terminalErr,
            );
          }
        }
        if (run.status === "starting") {
          await this.rollbackFailedSubagentSpawn(run).catch((rollbackError) => {
            console.error(
              `[AgentVessel] subagent spawn rollback failed for ${run.runId}:`,
              rollbackError,
            );
          });
        }
      }
      return { result: message, isError: true };
    }
  }

  /**
   * External subagent bring-up. Mirrors the Pi path but delegates the child
   * process to an extension launcher named by agentKind. Completion is the
   * linked vessel's durable terminal task event. Interactive completion can
   * arrive from the bridge; supervised
   * print-mode completion arrives from the launcher's typed process result.
   * Cards, progress, merge-back, and cancellation stay shared either way.
   */
  private async runExternalSubagentSpawn(
    agentKind: SubagentAgentKind,
    channelId: string,
    opts: {
      runId: string;
      taskChannelId: string;
      label: string;
      task: string;
      mode: "fresh" | "fork";
      childDepth: number;
      parentContextId: string;
      ownerEntityId: string;
      /** Launcher-specific options, forwarded verbatim; the extension owns the
       *  whitelist of what its CLI supports. */
      launcherOptions?: Record<string, unknown>;
    },
  ): Promise<{ result: unknown; isError: boolean }> {
    const {
      runId,
      taskChannelId,
      label,
      task,
      mode,
      childDepth,
      parentContextId,
      ownerEntityId,
    } = opts;
    const targetKey = `subagent:${runId}`;

    // 1) Child context (deterministic; runtime records the lifecycle edge).
    const { contextId } = await createSubagentContext(this.rpc, {
      parentContextId,
      ownerEntityId,
      targetKey,
    });

    // 2) Record the run BEFORE any external side effect so a setup failure is
    //    compensatable by the spawn transaction rollback. childEntityId/participant are filled
    //    once `prepare` returns; the complete-gate can't fire during setup.
    const now = Date.now();
    const run: SubagentRunRow = {
      runId,
      taskChannelId,
      parentContextId: parentContextId ?? null,
      childContextId: contextId,
      childEntityId: "",
      childParticipantId: null,
      parentChannelId: channelId,
      mode,
      label,
      depth: childDepth,
      status: "starting",
      sourceEventId: null,
      semanticIntegrationSnapshot: null,
      startedAt: now,
      lastActivityAt: now,
      agentKind,
      launchConfig: observableSubagentLaunchConfig(opts.launcherOptions),
      externalSessionEntityId: null,
      externalGenerationId: null,
    };
    this.subagentRuns.insert(run);

    // 3) Supervisor stance on the task channel (§9): "addressed" delivery —
    //    zero mailbox rows for child tool activity. This also materializes the
    //    channel bound to the child context, which the extension's `prepare`
    //    resolves the session context from.
    await this.subscribeChannel({
      channelId: taskChannelId,
      contextId,
      config: { wakePolicy: "explicit" },
      replay: false,
      delivery: "addressed",
    });
    await this.createChannelClient(taskChannelId).recordTaskProvenance({
      parentChannelId: channelId,
      parentContextId: parentContextId ?? "",
      runId,
    });

    // 4) Launch the linked external subagent via its extension. The extension
    //    owns the Node-only work: prepare the linked vessel, write the profile,
    //    and spawn the headless process in the child context.
    const providerSlot = externalSubagentProviderSlot(agentKind);
    const launched = await this.rpc.call<ExternalSubagentLaunchResult>(
      "main",
      providerSlot ? "extensions.invokeProvider" : "extensions.invoke",
      [
        providerSlot ?? externalSubagentExtensionId(agentKind),
        "launchSubagent",
        [
          {
            channelId: taskChannelId,
            title: label,
            ...(opts.launcherOptions ? { options: opts.launcherOptions } : {}),
            subagent: {
              runId,
              task,
              parentRef: ownerEntityId,
              parentChannelId: channelId,
              taskChannelId,
              parentContextId,
              depth: childDepth,
              mode,
              parentParticipantId: this.participantId(),
            },
          },
        ],
      ],
    );

    // The participant is the linked vessel's canonical publishing identity;
    // the entity remains its executable delivery/ownership endpoint. Terminal
    // admission validates the former and never conflates these two axes.
    this.subagentRuns.setChildEntityId(runId, launched.vesselEntityId);
    this.subagentRuns.setChildParticipantId(
      runId,
      launched.vesselParticipantId,
    );
    this.subagentRuns.setExternalSession(runId, {
      entityId: launched.entityId,
      generationId: launched.generationId,
    });

    // 6) Durable run card, then transition to live.
    const startedRun = this.subagentRuns.get(runId) ?? {
      ...run,
      externalSessionEntityId: launched.entityId,
      externalGenerationId: launched.generationId,
    };
    await this.publishSubagentStarted(startedRun);
    this.subagentRuns.setStatus(runId, "running");
    const runningRun = this.subagentRuns.get(runId) ?? {
      ...startedRun,
      status: "running" as const,
    };

    // 7) Seed the task on the channel (trajectory visibility; the headless copy
    //    is the -p prompt).
    await this.publishSubagentSeed(runningRun, task);

    return {
      result: {
        protocolContent: [
          {
            type: "text",
            text: `${agentKind} ${subagentLaunchReceipt(runningRun)}`,
          },
        ],
        details: this.subagentRunDetails(runningRun),
      },
      isError: false,
    };
  }

  private subagentRunDetails(run: SubagentRunRow): Record<string, unknown> {
    return {
      runId: subagentRunHandle(run.runId),
      mode: run.mode,
      label: run.label,
      taskChannelId: run.taskChannelId,
      contextId: run.childContextId,
      parentContextId: run.parentContextId,
      childEntityId: run.childEntityId,
      status: run.status,
      sourceEventId: run.sourceEventId,
      semanticIntegration: semanticIntegrationForRun(run),
      // W6b: the SubagentRunCard badges the reasoning engine from this field.
      agentKind: run.agentKind,
      ...(run.launchConfig ? { launchConfig: run.launchConfig } : {}),
      ...(run.externalSessionEntityId
        ? { externalSessionEntityId: run.externalSessionEntityId }
        : {}),
      ...(run.externalGenerationId
        ? { externalGenerationId: run.externalGenerationId }
        : {}),
    };
  }

  private async resolveSubagentRun(
    runId: string,
    parentChannelId?: string,
  ): Promise<SubagentRunRow | null> {
    const existing = this.subagentRuns.resolveReference(runId, parentChannelId);
    if (existing?.kind === "ambiguous") {
      throw this.subagentReferenceError(
        `ambiguous subagent run reference ${runId}; use a longer abbreviation or the exact runId`,
        { runId },
      );
    }
    if (existing) return this.hydrateSubagentParentContext(existing.run);
    // Recovery scans durable lifecycle cards by their exact causality id. An
    // abbreviated reference can only identify an already indexed run.
    if (
      !parentChannelId ||
      runId.trim().endsWith("...") ||
      runId.trim().endsWith("…")
    ) {
      return null;
    }
    return this.recoverSubagentRunFromParentChannel(runId, parentChannelId);
  }

  private async hydrateSubagentParentContext(
    run: SubagentRunRow,
  ): Promise<SubagentRunRow> {
    if (run.parentContextId) return run;
    let parentContextId: string | null = null;
    try {
      const provenance = await this.createChannelClient(
        run.taskChannelId,
      ).getProvenance();
      if (provenance && typeof provenance === "object") {
        const record = provenance as Record<string, unknown>;
        if (
          record["kind"] === "task" &&
          typeof record["parentContextId"] === "string"
        ) {
          parentContextId = record["parentContextId"];
        }
      }
    } catch {
      // Older task channels may not expose provenance; fall back below.
    }
    parentContextId =
      parentContextId ?? this.subscriptionContextOrNull(run.parentChannelId);
    if (!parentContextId) return run;
    this.subagentRuns.setParentContextId(run.runId, parentContextId);
    return { ...run, parentContextId };
  }

  private async recoverSubagentRunFromParentChannel(
    runId: string,
    parentChannelId: string,
  ): Promise<SubagentRunRow | null> {
    // The subagent lifecycle card is durably published on the parent channel.
    // Rebuild this local index from that stream after hibernation or teardown.
    let recovered: SubagentRunRow | null = null;
    const channel = this.createChannelClient(parentChannelId);
    for await (const page of iterateChannelReplayAfterPages(
      (request) => channel.getReplayAfter(request),
      { after: 0 },
    )) {
      for (const event of page.logEvents) {
        if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) continue;
        const agentic =
          event.payload && typeof event.payload === "object"
            ? (event.payload as AgenticEvent & { payload?: unknown })
            : null;
        if (!agentic) continue;
        const eventKind =
          typeof agentic.kind === "string" ? agentic.kind : null;
        if (!eventKind) continue;
        const taskId = (agentic.causality as { taskId?: unknown } | undefined)
          ?.taskId;
        if (taskId !== runId) continue;
        const payload =
          agentic.payload && typeof agentic.payload === "object"
            ? (agentic.payload as Record<string, unknown>)
            : {};
        const details =
          payload["details"] && typeof payload["details"] === "object"
            ? (payload["details"] as Record<string, unknown>)
            : null;
        const subagent =
          details?.["subagent"] && typeof details["subagent"] === "object"
            ? (details["subagent"] as Record<string, unknown>)
            : null;
        if (eventKind === "task.started" && subagent) {
          const taskChannelId = subagent["taskChannelId"];
          const contextId = subagent["contextId"];
          const parentContextId = subagent["parentContextId"];
          const childEntityId = subagent["childEntityId"];
          const childParticipantId = subagent["childParticipantId"];
          if (
            typeof taskChannelId !== "string" ||
            typeof contextId !== "string" ||
            typeof childEntityId !== "string" ||
            typeof childParticipantId !== "string" ||
            !childParticipantId.trim()
          ) {
            continue;
          }
          const mode = subagent["mode"] === "fork" ? "fork" : "fresh";
          const startedAt =
            Date.parse(
              typeof agentic.createdAt === "string" ? agentic.createdAt : "",
            ) ||
            event.ts ||
            Date.now();
          recovered = {
            runId,
            taskChannelId,
            parentContextId:
              typeof parentContextId === "string"
                ? parentContextId
                : this.subscriptionContextOrNull(parentChannelId),
            childContextId: contextId,
            childEntityId,
            childParticipantId,
            parentChannelId,
            mode,
            label:
              typeof subagent["label"] === "string"
                ? subagent["label"]
                : "subagent",
            depth: this.currentSubagentDepth() + 1,
            status: "running",
            sourceEventId: null,
            semanticIntegrationSnapshot: null,
            startedAt,
            lastActivityAt: startedAt,
            agentKind:
              typeof subagent["agentKind"] === "string" && subagent["agentKind"]
                ? subagent["agentKind"]
                : "pi",
            launchConfig:
              subagent["launchConfig"] &&
              typeof subagent["launchConfig"] === "object" &&
              !Array.isArray(subagent["launchConfig"])
                ? (subagent["launchConfig"] as Record<string, unknown>)
                : null,
            externalSessionEntityId:
              typeof subagent["externalSessionEntityId"] === "string"
                ? subagent["externalSessionEntityId"]
                : null,
            externalGenerationId:
              typeof subagent["externalGenerationId"] === "string"
                ? subagent["externalGenerationId"]
                : null,
          };
          continue;
        }
        if (!recovered) continue;
        const result =
          payload["result"] && typeof payload["result"] === "object"
            ? (payload["result"] as Record<string, unknown>)
            : null;
        const terminalDetails =
          result?.["details"] && typeof result["details"] === "object"
            ? (result["details"] as Record<string, unknown>)
            : details;
        if (
          terminalDetails &&
          typeof terminalDetails["sourceEventId"] === "string"
        ) {
          recovered = {
            ...recovered,
            sourceEventId: terminalDetails["sourceEventId"],
          };
        }
        if (eventKind === "task.completed") {
          recovered = { ...recovered, status: "completed" };
        } else if (eventKind === "task.failed") {
          recovered = { ...recovered, status: "failed" };
        } else if (eventKind === "task.cancelled") {
          recovered = { ...recovered, status: "cancelled" };
        } else if (eventKind === "task.abandoned") {
          recovered = { ...recovered, status: "abandoned" };
        }
      }
    }
    if (!recovered) return null;
    this.subagentRuns.insert(recovered);
    return this.subagentRuns.get(runId) ?? recovered;
  }

  private async publishSubagentSeed(
    run: SubagentRunRow,
    task: string,
  ): Promise<void> {
    if (!task.trim()) return;
    if (!run.childParticipantId) {
      throw new Error(
        `subagent ${run.runId} has no child participant identity`,
      );
    }
    const participantId =
      this.subscriptions.getParticipantId(run.taskChannelId) ??
      this.participantId();
    const messageId = `subagent-seed:${run.runId}`;
    const senderMetadata = {
      type: "headless",
      name: "Subagent task",
      handle: "subagent-task",
      parentParticipantId: participantId,
      subagentRunId: run.runId,
    };
    await publishAgentTaskSeed(this.createChannelClient(run.taskChannelId), {
      senderParticipantId: participantId,
      task: subagentFirstTaskPrompt({ task, mode: run.mode }),
      messageId,
      childParticipantId: run.childParticipantId,
      senderMetadata,
      // A retry reuses messageId as its idempotency key, so the complete event
      // must be byte-stable too. The run timestamp is durable across retries.
      createdAt: new Date(run.startedAt).toISOString(),
    });
  }

  /** Post a message into a subagent's task channel (parent → child). */
  protected async sendToSubagent(
    toolCallId: string,
    runId: string,
    message: string,
    parentChannelId?: string,
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const run = await this.resolveSubagentRun(runId, parentChannelId);
    if (!run) {
      throw this.subagentReferenceError(`unknown subagent run ${runId}`, {
        runId,
      });
    }
    if (run.status !== "starting" && run.status !== "running") {
      throw Object.assign(
        new Error(
          `subagent ${subagentRunHandle(run.runId)} is terminal (${run.status}) and cannot receive execution messages. ` +
            `Its retained result stays inspectable and mergeable; to continue this line of work, spawn a new run.`,
        ),
        {
          code: "SubagentTerminal",
          errorData: {
            code: "SubagentTerminal",
            runId: run.runId,
            status: run.status,
            sourceEventId: run.sourceEventId,
            allowedOperations: [
              "inspect_subagent",
              "read_subagent",
              "merge_subagent",
              "spawn_subagent",
            ],
          },
        },
      );
    }
    if (typeof message !== "string" || !message.trim()) {
      throw new Error("notify to a subagent run requires non-empty content");
    }
    const participantId =
      this.subscriptions.getParticipantId(run.taskChannelId) ??
      this.participantId();
    if (!run.childParticipantId) {
      throw this.subagentReferenceError(
        `subagent ${run.runId} is not ready to receive targeted messages`,
        { runId: run.runId },
      );
    }
    const messageId = `subagent-msg:${toolCallId}`;
    await this.createChannelClient(run.taskChannelId).send(
      participantId,
      messageId,
      message,
      {
        senderMetadata: { type: "agent", name: participantId },
        to: [{ kind: "participant", participantId: run.childParticipantId }],
      },
    );
    this.subagentRuns.touch(run.runId, Date.now());
    const handle = subagentRunHandle(run.runId);
    return this.toolText(`sent to subagent ${handle}`, {
      runId: handle,
      messageId,
    });
  }

  /** Inspect semantic child state through VCS, or an external engine through
   *  its provider-owned bounded runtime diagnostics. */
  protected async inspectSubagent(
    runId: string,
    query: string,
    parentChannelId?: string,
    page: { limit: number; cursor?: string } = { limit: 20 },
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const wrapperStartedAt = performance.now();
    const wrapperWallStartedAt = Date.now();
    const run = await this.resolveSubagentRun(runId, parentChannelId);
    const runResolvedAt = performance.now();
    if (!run) {
      throw this.subagentReferenceError(`unknown subagent run ${runId}`, {
        runId,
      });
    }
    const q = (query ?? "status").trim() || "status";
    if (q === "runtime") {
      if (!run.externalSessionEntityId || !run.externalGenerationId) {
        return this.toolText(
          `Runtime diagnostics are not applicable to ${run.agentKind} subagent ${subagentRunHandle(run.runId)}; use status, log, or read_subagent.`,
          {
            runId: subagentRunHandle(run.runId),
            query: q,
            available: false,
            reason: "not-external",
            agentKind: run.agentKind,
            status: run.status,
          },
        );
      }
      const agentKind = normalizeSubagentAgentKind(run.agentKind);
      if (!agentKind || agentKind === "pi") {
        throw new Error(
          `subagent ${run.runId} has invalid external agentKind ${run.agentKind}`,
        );
      }
      const providerSlot = externalSubagentProviderSlot(agentKind);
      const result = await this.rpc.call(
        "main",
        providerSlot ? "extensions.invokeProvider" : "extensions.invoke",
        [
          providerSlot ?? externalSubagentExtensionId(agentKind),
          "inspectLaunch",
          [
            {
              entityId: run.externalSessionEntityId,
              generationId: run.externalGenerationId,
            },
          ],
        ],
      );
      return this.toolText(JSON.stringify(result, null, 2), {
        runId: subagentRunHandle(run.runId),
        query: q,
      });
    }
    const vcs = createSubagentVcsClient(this.rpc);
    const childStatusStartedAt = performance.now();
    const childStatus = vcs.status({ contextId: run.childContextId });
    let statusFetchMs = 0;
    let semanticQueryMs = 0;
    let result: unknown;
    let renderedResult: string | null = null;
    let semanticRun = run;
    let semanticProjections: readonly VcsIntegrationProjection[] = [];
    let semanticWorkingHead: VcsStateNodeRef | undefined;
    if (q === "status") {
      const [status, parentStatus] = await Promise.all([
        childStatus,
        run.parentContextId
          ? vcs.status({ contextId: run.parentContextId })
          : null,
      ]);
      statusFetchMs = performance.now() - childStatusStartedAt;
      if (status.clean && status.committed.kind === "event") {
        this.subagentRuns.setSourceEventId(run.runId, status.committed.eventId);
        semanticRun = { ...run, sourceEventId: status.committed.eventId };
      }
      semanticProjections = parentStatus?.integrating ?? [];
      semanticWorkingHead = parentStatus?.workingHead;
      result = status;
    } else if (q === "diff") {
      if (!run.parentContextId) {
        throw new Error(
          `subagent ${run.runId} has no parent context for a relative diff`,
        );
      }
      const [status, parentStatus] = await Promise.all([
        childStatus,
        vcs.status({ contextId: run.parentContextId }),
      ]);
      statusFetchMs = performance.now() - childStatusStartedAt;
      const queryStartedAt = performance.now();
      const comparison = await vcs.compare({
        target: parentStatus.workingHead,
        source: { kind: "event", eventId: status.committed.eventId },
        limit: page.limit,
        ...(page.cursor ? { cursor: page.cursor } : {}),
      });
      semanticQueryMs = performance.now() - queryStartedAt;
      if (status.clean && status.committed.kind === "event") {
        this.subagentRuns.setSourceEventId(run.runId, status.committed.eventId);
        semanticRun = { ...run, sourceEventId: status.committed.eventId };
      }
      semanticProjections = parentStatus.integrating;
      semanticWorkingHead = parentStatus.workingHead;
      result = {
        child: {
          contextId: status.contextId,
          committed: status.committed,
          workingHead: status.workingHead,
          clean: status.clean,
          workingCounts: status.workingCounts,
        },
        parent: {
          contextId: parentStatus.contextId,
          workingHead: parentStatus.workingHead,
        },
        comparison,
        note: status.clean
          ? "Comparison includes the child's committed work."
          : "Comparison includes committed work only; workingCounts reports additional uncommitted semantic work.",
      };
      renderedResult =
        `${renderCompareReview(comparison)}\n` +
        (status.clean
          ? "Child source is committed and clean."
          : `Child has ${status.workingCounts.changes} additional uncommitted semantic change(s); comparison includes committed work only.`);
    } else if (q === "log") {
      const status = await childStatus;
      statusFetchMs = performance.now() - childStatusStartedAt;
      const queryStartedAt = performance.now();
      result = await vcs.history({
        root: status.committed,
        direction: "past",
        limit: page.limit,
        ...(page.cursor ? { cursor: page.cursor } : {}),
      });
      semanticQueryMs = performance.now() - queryStartedAt;
    } else {
      const status = await childStatus;
      statusFetchMs = performance.now() - childStatusStartedAt;
      const requestedPath = q.replace(/^\/+/, "");
      const queryStartedAt = performance.now();
      const file = await resolveToolFile(
        vcs,
        status.workingHead,
        requestedPath,
      );
      semanticQueryMs = performance.now() - queryStartedAt;
      if (!file) {
        throw this.subagentReferenceError(
          `no managed file at ${requestedPath} in subagent ${subagentRunHandle(run.runId)}; ` +
            "use an exact repo-prefixed path — inspect the child's diff or log for the paths it touched",
          {
            runId: run.runId,
            path: requestedPath,
            referenceKind: "child-file-path",
          },
        );
      }
      result = file;
    }
    const totalMs = performance.now() - wrapperStartedAt;
    if (totalMs >= 100) {
      this.traceHotPath(run.parentChannelId, "subagent-inspect.completed", {
        startedAt: wrapperWallStartedAt,
        details: {
          queryKind:
            q === "status" || q === "diff" || q === "log" ? q : "managed-file",
          runResolutionMs: Math.round(runResolvedAt - wrapperStartedAt),
          statusFetchMs: Math.round(statusFetchMs),
          semanticQueryMs: Math.round(semanticQueryMs),
          totalMs: Math.round(totalMs),
        },
      });
    }
    return this.toolText(
      renderedResult ??
        (typeof result === "string" ? result : JSON.stringify(result, null, 2)),
      {
        runId: subagentRunHandle(run.runId),
        query: q,
        semanticIntegration: semanticIntegrationForRun(
          semanticRun,
          semanticProjections,
          semanticWorkingHead,
        ),
      },
    );
  }

  /** Merge a child event through the same coordinate engine used everywhere else. */
  protected async mergeSubagent(
    runId: string,
    parentChannelId?: string,
    resolutions: VcsMergeInput["resolutions"] = [],
    intentSummary?: string,
    toolRpc: RpcClient = this.rpc,
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const wrapperStartedAt = performance.now();
    const wrapperWallStartedAt = Date.now();
    const run = await this.resolveSubagentRun(runId, parentChannelId);
    const runResolvedAt = performance.now();
    if (!run) {
      throw this.subagentReferenceError(`unknown subagent run ${runId}`, {
        runId,
      });
    }
    if (!run.parentContextId) {
      throw new Error(
        `subagent ${run.runId} has no recoverable parent context`,
      );
    }

    const vcs = createSubagentVcsClient(toolRpc);
    let mergeCalls = 0;
    let compareCalls = 0;
    const countedVcs = {
      ...vcs,
      merge: ((input) => {
        mergeCalls += 1;
        return vcs.merge(input);
      }) as typeof vcs.merge,
      compare: ((input) => {
        compareCalls += 1;
        return vcs.compare(input);
      }) as typeof vcs.compare,
    };
    const [targetStatus, sourceStatus] = await Promise.all([
      vcs.status({ contextId: run.parentContextId }),
      vcs.status({ contextId: run.childContextId }),
    ]);
    const sourceVerifiedAt = performance.now();
    if (!sourceStatus.clean) {
      this.subagentRuns.touch(run.runId, Date.now());
      return this.toolText(
        `subagent ${run.runId} has uncommitted semantic work; commit the child context before merging`,
        {
          protocol: SUBAGENT_MERGE_PROTOCOL,
          runId: subagentRunHandle(run.runId),
          status: "source-uncommitted",
          source: sourceStatus,
        },
      );
    }
    if (sourceStatus.committed.kind !== "event") {
      throw new Error(`subagent ${run.runId} has no committed source event`);
    }

    const sourceEventId = sourceStatus.committed.eventId;
    this.subagentRuns.setSourceEventId(run.runId, sourceEventId);
    const source = { kind: "event" as const, eventId: sourceEventId };
    const driven = await driveMerge({
      vcs: countedVcs,
      contextId: run.parentContextId,
      expectedWorkingHead: targetStatus.workingHead,
      source,
      ...(resolutions ? { resolutions } : {}),
      ...(intentSummary ? { intentSummary } : {}),
      headline: `Merge subagent ${subagentRunHandle(run.runId)}`,
      commandIdForPage: ({ expectedWorkingHead }) =>
        subagentVcsCommandId("merge", run, {
          contextId: run.parentContextId,
          expectedWorkingHead,
          source,
          resolutions,
          intentSummary,
        }),
    });
    this.subagentRuns.setSemanticIntegrationSnapshot(run.runId, {
      state:
        driven.review.resolution.complete && driven.review.resolution.concluded
          ? "complete"
          : driven.review.counts.adopt +
                driven.review.counts.composed +
                driven.review.counts.convergent >
              0
            ? "integrating"
            : "needs-decision",
      source,
      remainingCoordinateCount:
        driven.review.resolution.remainingCoordinateCount,
      mergeableCoordinateCount:
        driven.review.counts.adopt +
        driven.review.counts.composed +
        driven.review.counts.convergent,
      conflictCoordinateCount: driven.review.counts.conflict,
      concluded: driven.review.resolution.concluded,
      asOfWorkingHead: driven.workingHead,
      stale: false,
    });
    this.subagentRuns.touch(run.runId, Date.now());
    const totalMs = performance.now() - wrapperStartedAt;
    if (totalMs >= 100) {
      console.info("[SubagentMergeProfile] merge_subagent wrapper", {
        runResolutionMs: runResolvedAt - wrapperStartedAt,
        sourceVerificationMs: sourceVerifiedAt - runResolvedAt,
        driveMergeMs: performance.now() - sourceVerifiedAt,
        totalMs,
        mergeCalls,
        compareCalls,
      });
      this.traceHotPath(run.parentChannelId, "subagent-merge.completed", {
        startedAt: wrapperWallStartedAt,
        details: {
          runResolutionMs: Math.round(runResolvedAt - wrapperStartedAt),
          sourceVerificationMs: Math.round(sourceVerifiedAt - runResolvedAt),
          driveMergeMs: Math.round(performance.now() - sourceVerifiedAt),
          totalMs: Math.round(totalMs),
          mergeCalls,
          compareCalls,
        },
      });
    }
    return this.toolText(renderMergeReview(driven.review), {
      protocol: SUBAGENT_MERGE_PROTOCOL,
      runId: subagentRunHandle(run.runId),
      sourceEventId,
      ...driven,
    });
  }

  /** Read a subagent's task-channel envelopes since a cursor (the `manual`-wake
   *  read path). Returns the child's messages + the next cursor. */
  protected async readSubagent(
    runId: string,
    afterSeq: number,
    parentChannelId?: string,
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const run = await this.resolveSubagentRun(runId, parentChannelId);
    if (!run) {
      throw this.subagentReferenceError(`unknown subagent run ${runId}`, {
        runId,
      });
    }
    const envelope = await this.createChannelClient(
      run.taskChannelId,
    ).getReplayAfter({
      after: Number.isFinite(afterSeq) ? afterSeq : 0,
    });
    let nextSeq = Number.isFinite(afterSeq) ? afterSeq : 0;
    const messages: Array<{ seq: number; author: string; text: string }> = [];
    for (const event of envelope.logEvents) {
      nextSeq = Math.max(nextSeq, event.id ?? 0);
      if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) continue;
      const agentic = event.payload as AgenticEvent | null;
      if ((agentic as { kind?: string } | null)?.kind !== "message.completed")
        continue;
      const text = this.extractMessageText(agentic);
      if (!text) continue;
      messages.push({
        seq: event.id ?? 0,
        author: event.senderId ?? "unknown",
        text,
      });
    }
    if (messages.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No new subagent messages after this cursor.",
          },
        ],
        details: {
          runId: subagentRunHandle(run.runId),
          nextSeq,
          messages,
          empty: true,
          hasMore: envelope.ready.hasMoreAfter === true,
        },
      };
    }
    const rendered = messages
      .map((m) => `[#${m.seq} ${m.author}]\n${m.text}`)
      .join("\n\n");
    return this.toolText(rendered, {
      runId: subagentRunHandle(run.runId),
      nextSeq,
      messages,
      empty: false,
      hasMore: envelope.ready.hasMoreAfter === true,
    });
  }

  /** Cancel live execution while retaining the complete durable run result. */
  protected async cancelSubagent(
    runId: string,
    reason: string,
    parentChannelId?: string,
    toolRpc: RpcClient = this.rpc,
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const run = await this.resolveSubagentRun(runId, parentChannelId);
    if (!run)
      throw this.subagentReferenceError(`unknown subagent run ${runId}`, {
        runId,
      });
    if (run.status !== "starting" && run.status !== "running") {
      return this.toolText(
        `Subagent ${subagentRunHandle(run.runId)} is already ${run.status}; no cancellation was performed.`,
        { ...this.subagentRunDetails(run), cancelled: false, terminal: true },
      );
    }
    // Durable cancel intent BEFORE any side effect: a crash anywhere between
    // the child abort and the terminal settle re-drives through the wake
    // queue instead of leaking a fenced-but-`running` run and its slot.
    const wakeId = `subagent-cancel-settle:${run.runId}`;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT OR IGNORE INTO agent_wake_queue (
           wake_id, channel_id, wake_kind, payload_json, prerequisite_delivery_id,
           idempotency_key, attempts, next_attempt_at, lease_generation, created_at,
           disposition
         ) VALUES (?, ?, 'subagent-cancel-settle', ?, NULL, ?, 0, ?, 0, ?, 'ready')`,
        wakeId,
        run.parentChannelId,
        JSON.stringify({ runId: run.runId, reason }),
        wakeId,
        // Eligible only after a grace delay: the inline drive below is the
        // normal path; the wake row is the crash-recovery driver.
        now + CHANNEL_ENVELOPE_RETRY_MS,
        now,
      );
    });
    await this.driveCancelSubagent(run.runId, reason, toolRpc);
    const terminal = this.subagentRuns.get(run.runId) ?? {
      ...run,
      status: "cancelled" as const,
    };
    return this.toolText(`cancelled subagent ${subagentRunHandle(run.runId)}`, {
      ...this.subagentRunDetails(terminal),
      cancelled: true,
      retained: true,
    });
  }

  /** Idempotent core of cancellation: fence the child's live execution, then
   *  settle the terminal fact. Safe to re-drive from the wake queue — a run
   *  already terminal no-ops, the abort is fencing (repeatable), and the
   *  terminal publish is idempotent by run identity. */
  private async driveCancelSubagent(
    runId: string,
    reason: string,
    toolRpc: RpcClient = this.rpc,
  ): Promise<void> {
    const run = this.subagentRuns.get(runId);
    if (!run || (run.status !== "starting" && run.status !== "running")) return;
    if (run.externalSessionEntityId && run.externalGenerationId) {
      const agentKind = normalizeSubagentAgentKind(run.agentKind);
      if (!agentKind || agentKind === "pi") {
        throw new Error(
          `cancel_subagent: invalid external agent kind ${run.agentKind}`,
        );
      }
      const providerSlot = externalSubagentProviderSlot(agentKind);
      await toolRpc.call(
        "main",
        providerSlot ? "extensions.invokeProvider" : "extensions.invoke",
        [
          providerSlot ?? externalSubagentExtensionId(agentKind),
          "release",
          [
            {
              entityId: run.externalSessionEntityId,
              generationId: run.externalGenerationId,
            },
          ],
        ],
      );
    } else {
      await toolRpc.call(run.childEntityId, "cancelSubagentExecution", [
        { runId: run.runId, taskChannelId: run.taskChannelId, reason },
      ]);
      return;
    }
    await this.settleSubagentTerminal(run, "cancelled", reason);
  }

  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async cancelSubagentExecution(input: {
    runId: string;
    taskChannelId: string;
    reason: string;
  }): Promise<{ cancelled: true }> {
    const subagent = this.subagentIdentity();
    if (
      !subagent ||
      subagent.runId !== input.runId ||
      subagent.parentRef !== this.rpcCallerId
    ) {
      throw new Error(
        "cancelSubagentExecution: caller does not own this subagent run",
      );
    }
    await this.recordOwnSubagentTerminalIntent(
      subagent,
      input.reason,
      "cancelled",
    );
    await this.driver.abortChannel(input.taskChannelId, input.reason);
    return { cancelled: true };
  }

  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async retireSubagentExecution(input: {
    runId: string;
    taskChannelId: string;
    reason: string;
  }): Promise<{ retired: true }> {
    const subagent = this.subagentIdentity();
    if (
      !subagent ||
      subagent.runId !== input.runId ||
      subagent.parentRef !== this.rpcCallerId
    ) {
      throw new Error(
        "retireSubagentExecution: caller does not own this subagent run",
      );
    }
    const wakeId = `subagent-terminal-publish:${subagent.runId}`;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT OR IGNORE INTO agent_wake_queue (
           wake_id, channel_id, wake_kind, payload_json, prerequisite_delivery_id,
           idempotency_key, attempts, next_attempt_at, lease_generation, created_at,
           disposition
         ) VALUES (?, ?, 'subagent-terminal-publish', ?, NULL, ?, 0, ?, 0, ?, 'terminal-completed')`,
        wakeId,
        subagent.taskChannelId,
        JSON.stringify({
          runId: subagent.runId,
          reason: input.reason,
          outcome: "abandoned",
        }),
        wakeId,
        now,
        now,
      );
    });
    await this.driver.abortChannel(input.taskChannelId, input.reason);
    return { retired: true };
  }

  private subagentReferenceError(
    message: string,
    detail: Record<string, unknown>,
  ): Error {
    return Object.assign(new Error(message), {
      code: "InvalidReference",
      errorData: {
        code: "InvalidReference",
        operation: "subagent-reference",
        ...detail,
      },
    });
  }

  /** CHILD side of the terminal trigger (§7.2 steps 1–2): commit the terminal
   *  outcome and the post-terminal execution fence in ONE child-local
   *  transaction, then let the durable wake queue drive the parent
   *  notification at-least-once. A child crash after this commit can no
   *  longer lose the terminal fact — the wake row survives and republishes;
   *  the parent's settle is idempotent by run identity. */
  protected async completeAsSubagent(
    report: string,
    outcome: "success" | "failed",
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const sub = this.subagentIdentity();
    if (!sub) throw new Error("complete is only available to subagents");
    await this.recordOwnSubagentTerminalIntent(
      sub,
      report,
      outcome === "failed" ? "failed" : "completed",
    );
    return {
      ...this.toolText("subagent run completed; terminal delivery is durable", {
        runId: sub.runId,
        outcome,
      }),
      // `complete` is the semantic end of this child, not an ordinary tool
      // result for the model to reason over. The Pi loop otherwise starts a
      // continuation after receiving the successful result, causing the child
      // to call `complete` repeatedly while its first durable terminal intent
      // waits to reach the parent.
      terminate: true,
    };
  }

  private async recordOwnSubagentTerminalIntent(
    sub: SubagentIdentity,
    report: string,
    outcome: "completed" | "failed" | "cancelled",
  ): Promise<void> {
    const contextId = this.subscriptions.getContextId(sub.taskChannelId);
    const childStatus = await createSubagentVcsClient(this.rpc).status({
      contextId,
    });
    const sourceEventId =
      childStatus.clean && childStatus.committed.kind === "event"
        ? childStatus.committed.eventId
        : null;
    const wakeId = `subagent-terminal-publish:${sub.runId}`;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      // The wake row is simultaneously the durable terminal intent, the
      // execution fence marker (see dispatchApprovedInput), and the
      // notification driver. First intent wins; a duplicate `complete` from a
      // retried model turn is a no-op against the same wakeId.
      this.sql.exec(
        `INSERT OR IGNORE INTO agent_wake_queue (
           wake_id, channel_id, wake_kind, payload_json, prerequisite_delivery_id,
           idempotency_key, attempts, next_attempt_at, lease_generation, created_at,
           disposition
         ) VALUES (?, ?, 'subagent-terminal-publish', ?, NULL, ?, 0, ?, 0, ?, 'ready')`,
        wakeId,
        sub.taskChannelId,
        JSON.stringify({
          runId: sub.runId,
          parentRef: sub.parentRef,
          taskChannelId: sub.taskChannelId,
          report,
          outcome,
          sourceEventId,
        }),
        wakeId,
        now,
        now,
      );
    });
    this.markWorkReady("agent-wake");
  }

  /** Publish the terminal subagent card and notify the parent, then mark the run
   *  terminal to keep delivery retryable if either terminal side effect fails.
   *  `spawn_subagent`
   *  returns when the child is launched; child completion is a later event, not
   *  the terminal for the original tool.
   */
  protected async settleSubagentTerminal(
    run: SubagentRunRow,
    outcome: "completed" | "failed" | "cancelled" | "abandoned",
    text: string,
  ): Promise<void> {
    const canonicalStatus = await this.publishSubagentTerminal(
      run,
      outcome,
      text,
    );
    this.subagentRuns.setStatus(run.runId, canonicalStatus);
  }

  private async publishSubagentStarted(run: SubagentRunRow): Promise<void> {
    const participantId =
      this.subscriptions.getParticipantId(run.parentChannelId) ??
      this.participantId();
    const actor: ActorRef = {
      kind: "agent",
      id: run.childEntityId,
      displayName: run.label || "Subagent",
      metadata: {
        type: "agent",
        subagentRunId: run.runId,
        taskChannelId: run.taskChannelId,
      },
    };
    const event = {
      kind: "task.started",
      actor,
      causality: {
        taskId: run.runId as never,
        invocationId: run.runId as never,
      },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        taskType: "subagent",
        title: run.label || "Subagent",
        summary: run.label,
        details: {
          subagent: {
            runId: run.runId,
            mode: run.mode,
            taskChannelId: run.taskChannelId,
            contextId: run.childContextId,
            parentContextId: run.parentContextId,
            childEntityId: run.childEntityId,
            childParticipantId: run.childParticipantId,
            label: run.label,
            agentKind: run.agentKind,
            launchConfig: run.launchConfig,
          },
        },
      },
      createdAt: new Date().toISOString(),
    } as unknown as AgenticEvent;
    await this.createChannelClient(run.parentChannelId).publishAgenticEvent(
      participantId,
      event,
      {
        idempotencyKey: `subagent-started:${run.runId}`,
        senderMetadata: actor.metadata,
      },
    );
  }

  private async publishSubagentTerminal(
    run: SubagentRunRow,
    outcome: "completed" | "failed" | "cancelled" | "abandoned",
    text: string,
  ): Promise<"completed" | "failed" | "cancelled" | "abandoned"> {
    const kindByOutcome = {
      completed: "task.completed",
      failed: "task.failed",
      cancelled: "task.cancelled",
      abandoned: "task.abandoned",
    } as const;
    const terminalOutcomeByOutcome = {
      completed: "success",
      failed: "tool_error",
      cancelled: "cancelled",
      abandoned: "abandoned",
    } as const;
    const participantId =
      this.subscriptions.getParticipantId(run.taskChannelId) ??
      this.participantId();
    const actor: ActorRef = {
      kind: "agent",
      id: participantId,
      displayName: "Supervisor",
      metadata: {
        type: "agent",
        supervision: true,
        subagentRunId: run.runId,
        taskChannelId: run.taskChannelId,
      },
    };
    // The retained committed source event travels with the terminal event so a
    // replay-recovered receipt keeps its raw-VCS recovery recipe (the run row
    // may have been refreshed after `run` was captured).
    const sourceEventId =
      this.subagentRuns.get(run.runId)?.sourceEventId ??
      run.sourceEventId ??
      null;
    const terminalDetails = {
      runId: subagentRunHandle(run.runId),
      outcome: terminalOutcomeByOutcome[outcome],
      ...(sourceEventId ? { sourceEventId } : {}),
    };
    const payload: Record<string, unknown> =
      outcome === "completed"
        ? {
            protocol: AGENTIC_PROTOCOL_VERSION,
            terminalOutcome: "success",
            summary: text,
            to: [{ kind: "participant", participantId }],
            result: {
              protocolContent: [{ type: "text", text }],
              details: {
                ...terminalDetails,
              },
            },
          }
        : {
            protocol: AGENTIC_PROTOCOL_VERSION,
            reason: text,
            terminalOutcome: terminalOutcomeByOutcome[outcome],
            to: [{ kind: "participant", participantId }],
            details: terminalDetails,
          };
    const event = {
      kind: kindByOutcome[outcome],
      actor,
      causality: {
        taskId: run.runId as never,
        invocationId: run.runId as never,
      },
      payload,
      createdAt: new Date().toISOString(),
    } as unknown as AgenticEvent;
    const taskChannel = this.createChannelClient(run.taskChannelId);
    await taskChannel.publishAgenticEvent(participantId, event, {
      idempotencyKey: `subagent-terminal:${run.runId}`,
      senderMetadata: actor.metadata,
    });
    const canonicalEnvelope = (await taskChannel.getEnvelope(
      `ik:subagent-terminal:${run.runId}`,
    )) as ChannelEvent | null;
    const canonicalStatus = canonicalEnvelope
      ? this.authorizedSubagentTerminalStatus(run, canonicalEnvelope)
      : null;
    if (!canonicalEnvelope || !canonicalStatus) {
      throw new Error(
        `subagent terminal ${run.runId} has no authorized canonical task-channel event`,
      );
    }
    const canonicalEvent = canonicalEnvelope.payload as AgenticEvent;
    await this.mirrorSubagentTerminalToParent(run, canonicalEvent);
    return canonicalStatus;
  }

  private authorizedSubagentTerminalStatus(
    run: SubagentRunRow,
    envelope: ChannelEvent,
  ): "completed" | "failed" | "cancelled" | "abandoned" | null {
    if (envelope.type !== AGENTIC_EVENT_PAYLOAD_KIND) return null;
    const event = envelope.payload as AgenticEvent;
    const status = this.subagentTerminalStatus(event, run.runId);
    if (!status) return null;
    const childParticipantId = run.childParticipantId;
    if (!childParticipantId) return null;
    const actorParticipantId = event.actor.participantId ?? event.actor.id;
    if (
      envelope.senderId === childParticipantId &&
      actorParticipantId === childParticipantId
    ) {
      return status;
    }
    // A supervisor may author cancellation/abandonment/infrastructure failure
    // facts when the child is unreachable. Successful completion is child
    // evidence and can never be asserted by the supervisor.
    const supervisorParticipantId =
      this.subscriptions.getParticipantId(run.taskChannelId) ??
      this.participantId();
    return status !== "completed" &&
      envelope.senderId === supervisorParticipantId &&
      actorParticipantId === supervisorParticipantId
      ? status
      : null;
  }

  private subagentTerminalStatus(
    event: AgenticEvent,
    runId: string,
  ): "completed" | "failed" | "cancelled" | "abandoned" | null {
    if (event.causality?.taskId !== runId) return null;
    switch (event.kind) {
      case "task.completed":
        return "completed";
      case "task.failed":
        return "failed";
      case "task.cancelled":
        return "cancelled";
      case "task.abandoned":
        return "abandoned";
      default:
        return null;
    }
  }

  private async mirrorSubagentTerminalToParent(
    run: SubagentRunRow,
    canonicalEvent: AgenticEvent,
  ): Promise<void> {
    if (!this.subagentTerminalStatus(canonicalEvent, run.runId)) {
      throw new Error(
        `refusing to mirror a non-canonical terminal for subagent ${run.runId}`,
      );
    }
    const participantId =
      this.subscriptions.getParticipantId(run.parentChannelId) ??
      this.participantId();
    await this.createChannelClient(run.parentChannelId).publishAgenticEvent(
      participantId,
      canonicalEvent,
      { idempotencyKey: `subagent-terminal:${run.runId}` },
    );
  }

  private async publishOwnSubagentTerminal(input: {
    runId: string;
    taskChannelId: string;
    parentRef: string;
    report: string;
    outcome: "completed" | "failed" | "cancelled";
    sourceEventId: string | null;
  }): Promise<void> {
    const kind =
      input.outcome === "completed"
        ? "task.completed"
        : input.outcome === "failed"
          ? "task.failed"
          : "task.cancelled";
    const terminalOutcome =
      input.outcome === "completed"
        ? "success"
        : input.outcome === "failed"
          ? "tool_error"
          : "cancelled";
    const participantId =
      this.subscriptions.getParticipantId(input.taskChannelId) ??
      this.participantId();
    const actor: ActorRef = {
      kind: "agent",
      id: participantId,
      displayName: "Subagent",
      metadata: { type: "agent", subagentRunId: input.runId },
    };
    const details = {
      runId: subagentRunHandle(input.runId),
      outcome: terminalOutcome,
      ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
    };
    const payload =
      input.outcome === "completed"
        ? {
            protocol: AGENTIC_PROTOCOL_VERSION,
            terminalOutcome,
            summary: input.report,
            to: [
              { kind: "participant" as const, participantId: input.parentRef },
            ],
            result: {
              protocolContent: [{ type: "text", text: input.report }],
              details,
            },
          }
        : {
            protocol: AGENTIC_PROTOCOL_VERSION,
            reason: input.report,
            terminalOutcome,
            to: [
              { kind: "participant" as const, participantId: input.parentRef },
            ],
            details,
          };
    const event = {
      kind,
      actor,
      causality: {
        taskId: input.runId as never,
        invocationId: input.runId as never,
      },
      payload,
      createdAt: new Date().toISOString(),
    } as unknown as AgenticEvent;
    await this.createChannelClient(input.taskChannelId).publishAgenticEvent(
      participantId,
      event,
      {
        idempotencyKey: `subagent-terminal:${input.runId}`,
        senderMetadata: actor.metadata,
      },
    );
  }
  /** Compensation for a spawn transaction that never reached a published
   * running result. This is intentionally unreachable from normal lifecycle. */
  private async rollbackFailedSubagentSpawn(
    run: SubagentRunRow,
  ): Promise<void> {
    if (run.status !== "starting") {
      throw new Error(
        `refusing spawn rollback for ${run.runId} in ${run.status}`,
      );
    }
    if (run.externalSessionEntityId && run.externalGenerationId) {
      const agentKind = normalizeSubagentAgentKind(run.agentKind);
      if (!agentKind || agentKind === "pi") {
        throw new Error(`invalid external spawn kind ${run.agentKind}`);
      }
      const providerSlot = externalSubagentProviderSlot(agentKind);
      await this.rpc.call(
        "main",
        providerSlot ? "extensions.invokeProvider" : "extensions.invoke",
        [
          providerSlot ?? externalSubagentExtensionId(agentKind),
          "release",
          [
            {
              entityId: run.externalSessionEntityId,
              generationId: run.externalGenerationId,
            },
          ],
        ],
      );
    }
    await this.unsubscribeChannel(run.taskChannelId);
    await this.rpc.call("main", "runtime.destroyContext", [
      { contextId: run.childContextId, recursive: true },
    ]);
    this.subagentRuns.delete(run.runId);
  }

  // ── Wake discipline (explicit supervisor messages / manual) ─────────────────

  private extractMessageText(agentic: AgenticEvent | null): string {
    const blocks =
      (agentic as { payload?: { blocks?: unknown[] } } | null)?.payload
        ?.blocks ?? [];
    return blocks
      .map((block) =>
        block &&
        typeof block === "object" &&
        typeof (block as { content?: unknown }).content === "string"
          ? (block as { content: string }).content
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }

  private eventAddressesSelf(
    channelId: string,
    payload: {
      mentions?: string[];
      to?: Array<{ kind?: string; participantId?: string }>;
    },
  ): boolean {
    const selfPid =
      this.subscriptions.getParticipantId(channelId) ?? this.participantId();
    if (Array.isArray(payload.mentions) && payload.mentions.includes(selfPid))
      return true;
    if (Array.isArray(payload.to)) {
      for (const target of payload.to) {
        if (target?.kind === "all") return true;
        if (target?.participantId === selfPid) return true;
      }
    }
    return false;
  }

  /**
   * Resolve whether an inbound envelope wakes the loop NOW, per the channel's
   * wakePolicy. Non-default policies consume the event here. An explicit
   * supervisor message is routed to the owning run's parent channel; ordinary
   * progress remains in the durable task-channel log and parent task card.
   */
  private async resolveWake(
    channelId: string,
    event: ChannelEvent,
    wakePolicy: "explicit" | "manual",
  ): Promise<boolean> {
    if (wakePolicy === "manual") {
      // Never auto-wake; the supervisor reads via the read_subagent tool.
      return true;
    }
    // explicit
    if (event.senderId === this.participantId()) return true; // our own traffic never wakes us
    const agentic = event.payload as AgenticEvent | null;
    const kind = (agentic as { kind?: string } | null)?.kind ?? "";
    if (agentic !== null && kind === "message.completed") {
      const payload =
        ((agentic as AgenticEvent).payload as {
          saliency?: string;
          mentions?: string[];
          to?: Array<{ kind?: string; participantId?: string }>;
        }) ?? {};
      if (
        payload.saliency === "say" ||
        this.eventAddressesSelf(channelId, payload)
      ) {
        await this.wakeSupervisorFromExplicitChildMessage(
          channelId,
          event,
          agentic,
        );
      }
      return true;
    }
    return true;
  }

  /** Route an intentional child-to-supervisor update to the parent without
   *  presenting it as a replacement user request. */
  private async wakeSupervisorFromExplicitChildMessage(
    channelId: string,
    event: ChannelEvent,
    agentic: AgenticEvent,
  ): Promise<void> {
    const run = this.subagentRuns.getByTaskChannel(channelId);
    if (!run) {
      console.error(
        "[AgentVessel] refusing explicit task message without an owning subagent run",
        {
          taskChannelId: channelId,
          eventId: event.id ?? null,
        },
      );
      return;
    }
    const update = this.extractMessageText(agentic).trim();
    if (!update) return;
    this.subagentRuns.touch(run.runId, Date.now());
    const label = run.label ? `"${run.label}"` : subagentRunHandle(run.runId);
    const sourceMessageId =
      (agentic.causality?.messageId as string | undefined) ?? event.messageId;
    const content =
      `Subagent ${label} sent an explicit progress update for the existing user request. ` +
      `This is not a new request and does not mean the run is complete. Continue supervising ` +
      `the full goal; if no foreground work remains, call suspend_turn rather than finalizing.` +
      `\n\nUpdate:\n${update}`;
    await this.driver.handleIncoming(run.parentChannelId, {
      type: "command",
      command: {
        kind: "prompt",
        channelId: run.parentChannelId,
        source: {
          envelopeId: `subagent-explicit:${run.runId}:${event.id ?? event.messageId}`,
        },
        ...(sourceMessageId ? { sourceMessageId } : {}),
        content,
        senderRef: participantRefFromActor(agentic.actor),
      },
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  override async alarm(): Promise<DoAlarmSchedule | null> {
    await super.alarm();
    await this.fireAgentAlarms(Date.now());
    return this.nextAgentAlarmSchedule();
  }

  private activationDebugState(channelId?: string): Record<string, unknown> {
    const channels = channelId
      ? [channelId]
      : this.subscriptions.listChannelIds();
    const loops: Record<string, unknown> = {};
    for (const id of channels) {
      const loop = this._driver?.peekLoadedLoop(id) ?? null;
      const subscriptionConfig = this.subscriptions.getConfig(id);
      const promptPresentation = {
        configured: typeof subscriptionConfig?.systemPrompt === "string",
        mode:
          typeof subscriptionConfig?.systemPromptMode === "string"
            ? subscriptionConfig.systemPromptMode
            : "append",
        artifactHash: this.getStateValue(`agent:promptHash:${id}`) ?? null,
      };
      if (loop) {
        loops[id] = {
          loaded: true,
          turnStatus: derivedTurnStatus(loop.state),
          lastSeq: loop.state.lastSeq,
          pendingInvocations: Object.keys(loop.state.pendingInvocations),
          pendingApprovals: Object.keys(loop.state.pendingApprovals),
          pendingCredentialWaits: Object.keys(
            loop.state.pendingCredentialWaits,
          ),
          activeToolNames: loop.state.config.activeToolNames,
          settings: this.inspectAgentSettings(),
          promptPresentation,
        };
      } else {
        loops[id] = {
          loaded: false,
          note: "No folded loop is loaded in this activation; inspect GAD for durable trajectory state.",
          promptPresentation,
        };
      }
    }
    return {
      participantId: this.participantId(),
      loops,
      outbox: inspectEffectOutbox(this.sql),
      activeDispatches:
        this._driver?.activeDispatchDiagnostics?.(channelId) ?? [],
      retainedSubagentRuns: this.subagentRuns.listAll().length,
      liveSubagentRuns: this.subagentRuns.countLive(),
    };
  }

  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async getDebugState(channelId?: string): Promise<Record<string, unknown>> {
    return this.activationDebugState(channelId);
  }

  /**
   * Comprehensive self-snapshot for an agent introspecting itself from eval (the
   * `agent` binding): identity + resolved per-agent config + channel memberships
   * + active tools + this channel's turn state + an effect summary.
   */
  async describeSelf(channelId: string): Promise<Record<string, unknown>> {
    let turn: Record<string, unknown> = { status: "idle" };
    try {
      const loop = await this.driver.loop(channelId);
      turn = summarizeTurn(loop.state);
    } catch {
      /* loop not loadable yet — report idle */
    }
    let activeTools: string[] = [];
    try {
      activeTools = [...(await this.toolRegistry(channelId)).keys()];
    } catch {
      /* tools unavailable */
    }
    return {
      identity: {
        id: this.participantId(),
        objectKey: this.objectKey,
        source: String(this.env["WORKER_SOURCE"] ?? ""),
        className: String(
          this.env["WORKER_CLASS_NAME"] ?? this.constructor.name,
        ),
      },
      config: this.getAgentSettings(),
      channels: this.subscriptions.listAll(),
      tools: { active: activeTools },
      turn,
      effects: { outbox: { total: this.driver.outbox.all().length } },
    };
  }

  /**
   * Validate + apply a per-agent config patch (the `agent.configure`/setter write
   * path from eval). Every field is freely settable — including `approvalLevel`,
   * which is a UX convenience; all sensitive operations are gated by out-of-band
   * app approvals. Writes the per-agent record (applies to all the agent's channels).
   */
  configureAgent(patch: Record<string, unknown>): AgentSettings {
    const next: StoredSettings = {};
    if ("model" in patch) {
      if (typeof patch["model"] !== "string" || !patch["model"]) {
        throw new Error("model must be a non-empty 'provider:model' string");
      }
      next.model = patch["model"];
    }
    if ("thinkingLevel" in patch) {
      const l = patch["thinkingLevel"];
      if (!isThinkingLevel(l)) {
        throw new Error(
          "thinkingLevel must be minimal|low|medium|high|xhigh|max",
        );
      }
      next.thinkingLevel = l;
    }
    if ("fastMode" in patch) {
      if (typeof patch["fastMode"] !== "boolean") {
        throw new Error("fastMode must be a boolean");
      }
      next.fastMode = patch["fastMode"];
    }
    if ("fallbackModel" in patch) {
      if (
        typeof patch["fallbackModel"] !== "string" ||
        !patch["fallbackModel"]
      ) {
        throw new Error(
          "fallbackModel must be a non-empty 'provider:model' string",
        );
      }
      next.fallbackModel = patch["fallbackModel"];
    }
    if ("fallbackThinkingLevel" in patch) {
      const level = patch["fallbackThinkingLevel"];
      if (!isThinkingLevel(level)) {
        throw new Error(
          "fallbackThinkingLevel must be minimal|low|medium|high|xhigh|max",
        );
      }
      next.fallbackThinkingLevel = level;
    }
    if ("fallbackOn" in patch) {
      if (!isFallbackOn(patch["fallbackOn"])) {
        throw new Error(
          `fallbackOn must be a non-empty array containing only ${[
            ...CONFIGURABLE_FALLBACK_FAILURE_CODES,
          ].join("|")}`,
        );
      }
      next.fallbackOn = [...patch["fallbackOn"]];
    }
    if ("fallbackScope" in patch) {
      const scope = patch["fallbackScope"];
      if (scope !== "unattended" && scope !== "all-turns") {
        throw new Error("fallbackScope must be unattended|all-turns");
      }
      next.fallbackScope = scope;
    }
    if ("approvalLevel" in patch) {
      const l = patch["approvalLevel"];
      if (l !== 0 && l !== 1 && l !== 2)
        throw new Error("approvalLevel must be 0, 1, or 2");
      next.approvalLevel = l;
    }
    if ("respondPolicy" in patch) {
      if (!isRespondPolicy(patch["respondPolicy"]))
        throw new Error("invalid respondPolicy");
      next.respondPolicy = patch["respondPolicy"];
    }
    if ("respondFrom" in patch) {
      const from = patch["respondFrom"];
      if (!Array.isArray(from) || !from.every((x) => typeof x === "string")) {
        throw new Error(
          "respondFrom must be an array of handle/participant strings",
        );
      }
      next.respondFrom = from as string[];
    }
    return this.updateSettings(next);
  }
}

function automationCompletionStateKey(runId: string): string {
  return `automation:completion:${runId}`;
}

function automationRunReceiptKey(runId: string): string {
  return `automation:terminal:${runId}`;
}

function automationRunReceipt(
  value: string | null,
  channelId: string,
): Extract<AutomationExecutorRunStatus, { state: "terminal" }> | null {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Partial<
      Extract<AutomationExecutorRunStatus, { state: "terminal" }>
    >;
    if (
      candidate.state !== "terminal" ||
      candidate.channelId !== channelId ||
      typeof candidate.turnId !== "string" ||
      ![
        "succeeded",
        "completed-with-errors",
        "failed",
        "interrupted",
        "cancelled",
      ].includes(String(candidate.outcome))
    ) {
      return null;
    }
    return candidate as Extract<
      AutomationExecutorRunStatus,
      { state: "terminal" }
    >;
  } catch {
    return null;
  }
}

function automationDefinitionSnapshot(
  automation: MissionRecord,
): AutomationDefinitionSnapshot {
  const execution = automation.charter.execution;
  const trigger = automation.charter.trigger;
  return {
    missionId: automation.missionId,
    name: automation.name,
    summary: automation.charter.summary,
    revision: automation.revision,
    action: execution.kind === "method" ? "method" : execution.action.kind,
    createdAt: automation.createdAt,
    state: "active",
    ...(automation.nextRunAt === undefined
      ? {}
      : { nextRunAt: automation.nextRunAt }),
    schedule:
      trigger.kind === "schedule"
        ? {
            kind: "interval",
            everyMs: trigger.everyMs,
            ...(trigger.anchorAt === undefined
              ? {}
              : { anchorAt: trigger.anchorAt }),
            ...(trigger.jitterMs === undefined
              ? {}
              : { jitterMs: trigger.jitterMs }),
            ...(trigger.untilAt === undefined
              ? {}
              : { untilAt: trigger.untilAt }),
            ...(trigger.maxRuns === undefined
              ? {}
              : { maxRuns: trigger.maxRuns }),
          }
        : trigger.kind === "cron"
          ? {
              kind: "cron",
              expression: trigger.expression,
              timezone: trigger.timezone,
              ...(trigger.untilAt === undefined
                ? {}
                : { untilAt: trigger.untilAt }),
              ...(trigger.maxRuns === undefined
                ? {}
                : { maxRuns: trigger.maxRuns }),
            }
          : null,
  };
}

function automationCompletionForTurn(
  value: string | null,
  channelId: string,
  turnId: string,
): { response: string } | null {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as {
      channelId?: unknown;
      turnId?: unknown;
      response?: unknown;
    };
    return candidate.channelId === channelId &&
      candidate.turnId === turnId &&
      typeof candidate.response === "string" &&
      candidate.response.trim()
      ? { response: candidate.response.trim() }
      : null;
  } catch {
    return null;
  }
}

function automationCompletionFromEvalSummary(
  summary: string | undefined,
): { response: string } | null {
  if (!summary) return null;
  try {
    const value = JSON.parse(summary) as unknown;
    const direct = missionCompletionResponse(value);
    if (direct) return direct;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const details = (value as { details?: unknown }).details;
    if (!details || typeof details !== "object" || Array.isArray(details))
      return null;
    return missionCompletionResponse(
      (details as { returnValue?: unknown }).returnValue,
    );
  } catch {
    return null;
  }
}
