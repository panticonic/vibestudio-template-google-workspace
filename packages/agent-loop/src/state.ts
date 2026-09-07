/**
 * AgentState (WS1 §1.1) — derived by fold, never stored authoritatively
 * (the driver's fold_cache is a P1 cache). All fields JSON-serializable;
 * large payloads remain `vibestudio.blob-ref.v1` refs inside entries
 * (hydration happens in executors, never in the fold).
 */

import type {
  AgentToolFailure,
  InvocationTransport,
  ParticipantRef,
} from "@workspace/agentic-protocol";
import { logIdForChannel } from "@vibestudio/trajectory-identity";

export type ThinkingLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** How the executor authenticates a model call (design §6.3):
 *  "url-bound" — resolve a stored URL-bound credential (suspends on absence);
 *  "loopback"  — local llama.cpp server; key injected executor-side at call
 *                time, never journaled. */
export type ModelAuthMode = "url-bound" | "loopback";

/**
 * Serializable model descriptor — a pi-ai `Model` literal, journaled with
 * every model request so replay never depends on the installed registry
 * version (design docs/local-models-extension-design.md §6.2). Kept
 * structural so agent-loop stays free of a pi-ai dependency; the vessel
 * materializes it at the impure edge (settings write / artifact refresh).
 * MUST stay secret-free: it rides catalog snapshots and the journal.
 */
export interface AgentModelSpec {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  /** Provider service tiers supported by this exact catalog model. */
  serviceTiers?: Array<"priority">;
  /**
   * Optional provider-transport silence deadline. Absent means the model call
   * is unbounded and can be stopped only by explicit lifecycle/caller
   * cancellation. This is intentionally configuration, never a runtime
   * default.
   */
  streamIdleTimeoutMs?: number;
  thinkingLevelMap?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

/** Exact model identity that produced a durable assistant message. */
export interface AssistantModelIdentity {
  provider: string;
  api: string;
  model: string;
}

export type RespondPolicy =
  | "all"
  | "mentioned"
  | "mentioned-strict"
  | "mentioned-or-followup"
  | "from-participants";

export interface RosterMethod {
  name: string;
  description?: string;
  /** JSON Schema for the method's arguments (from the participant's
   *  method advertisement) — exposed to the model as the tool schema. */
  parameters?: unknown;
}

export interface RosterEntry {
  participantId: string;
  ref: ParticipantRef;
  handle?: string;
  type?: string;
  methods: RosterMethod[];
}

export interface RosterSnapshot {
  participants: RosterEntry[];
}

export interface AgentLoopConfig {
  model: string;
  /** Materialized descriptor + auth for `model` (design §6.2/§6.3). The
   *  vessel resolves these at the impure edge; the pure planner copies them
   *  onto every request. There is no registry lookup or descriptor-less
   *  request path after the impure configuration boundary. */
  modelSpec: AgentModelSpec;
  modelAuth?: ModelAuthMode;
  /** Unattended provider-failure fallback (design §8). When present, the pure
   *  loop can journal exactly one retry without consulting a registry. */
  fallbackModelRef?: string;
  fallbackModelSpec?: AgentModelSpec;
  fallbackModelAuth?: ModelAuthMode;
  fallbackThinkingLevel?: ThinkingLevel;
  /** Absent preserves the provider-failure fallback set. */
  fallbackFailureCodes?: string[];
  /** Absent preserves the background-only fallback behavior. */
  fallbackScope?: "unattended" | "all-turns";
  thinkingLevel: ThinkingLevel;
  /** Request the accelerated Codex service tier for eligible model calls. */
  fastMode: boolean;
  approvalLevel: 0 | 1 | 2;
  respondPolicy: RespondPolicy;
  systemPromptHash: string;
  skillIndexHash?: string;
  toolSchemasHash?: string;
  activeToolNames: string[];
  /** Execution ordering declared by local AgentTool metadata. Missing entries
   * fail safe to sequential execution. */
  localToolExecutionModes?: Record<string, "sequential" | "parallel">;
  /** Cancellation settlement declared by local AgentTool metadata. Missing
   * entries are interruptible. */
  localToolCancellationModes?: Record<string, "interruptible" | "settle">;
  roster: RosterSnapshot;
  agentHopLimit?: number;
  /** Channel publication discipline (gated by `publishPolicyPolicy`, appended
   *  last in `defaultPolicies`). "all" = today's behavior (every model outcome
   *  publishes). "turn-final" = only the end-of-turn (tier "primary") message
   *  publishes; intermediate tool-step text stays trajectory-only (streamed as
   *  ephemeral deltas). "notify-only" = NO model message publishes; the agent
   *  speaks only through its explicit `notify` tool + turn boundaries. Absent ⇒
   *  "all".
   *
   *  `"say-only"` is a frozen accepted alias for `"notify-only"`: the value is
   *  checked into agent configs across templates, and invalidating those buys
   *  nothing. Read it through `isNotifyOnlyPolicy`; only ever write
   *  "notify-only". */
  publishPolicy?: "all" | "turn-final" | "notify-only" | "say-only";
  /** Max subagent nesting depth (enforced at spawn by the vessel). Absent ⇒
   *  the vessel's implementation default. */
  maxSubagentDepth?: number;
  /** Maximum concurrently executing child runs. Retained terminal results do
   *  not consume execution capacity. */
  maxSubagents?: number;
}

export interface AgentTurnContextPolicy {
  mode?: "full" | "isolated";
  includeWorkspacePrompt?: boolean;
  includeSkillIndex?: boolean;
  promptFile?: string;
  promptFileContent?: string;
  tokenBudget?: number;
}

export interface AgentTurnMetadata {
  origin?: "agent-initiated" | "scheduled";
  /** Durable reviewed automation provenance for this exact tick. */
  automation?: {
    missionId: string;
    runId: string;
    /** Account that owns this mission revision; used for exact `owner` addressing in fresh runs. */
    ownerUserId: string;
    name: string;
    revision: number;
    action: "prompt" | "eval" | "method";
    trigger: "manual" | "scheduled";
    startedAt: number;
    createdAt: number;
    activatedAt?: number;
    runNumber?: number;
    /** Opaque host admission for tool effects in this exact turn. Never rendered to the model. */
    authoritySessionNonce: string;
    schedule:
      | {
          /** Missing only on durable turn snapshots written before calendar schedules. */
          kind?: "interval";
          everyMs: number;
          anchorAt?: number;
          jitterMs?: number;
          untilAt?: number;
          maxRuns?: number;
        }
      | {
          kind: "cron";
          expression: string;
          timezone: string;
          untilAt?: number;
          maxRuns?: number;
        }
      | null;
  };
  /** Model-free turns close after their directly journaled invocation settles. */
  completion?: "after-invocation";
  contextPolicy?: AgentTurnContextPolicy;
  delivery?: "none" | "channel" | "last-contact";
  ackToken?: string;
  silentOk?: boolean;
  /** Send-after-turn intent: while a turn is open this message is held in the
   *  deferred post-turn queue and promoted (one per turn) after close, instead
   *  of steering the open turn. */
  deliverAfterTurn?: boolean;
  /** Exact retained child run whose terminal report this deferred prompt
   * carries. Runtime-owned: it lets a same-turn suspend release the report
   * without treating every completed-but-unintegrated child as pending input. */
  supervisedTerminalRunId?: string;
  /**
   * A machine-stable user-interface selection carried by the same message as
   * its readable text. The context builder exposes this bounded structure to
   * the model; delivery controls above remain transport-only.
   */
  interaction?: {
    source: string;
    kind: string;
    action: string;
    targetId: string;
  };
}

/** Config fields that are FOLD-OWNED: the reducer derives them from the log
 *  (roster from `roster.snapshot` events), so a reload must keep the folded
 *  value, NOT the vessel's injected input config (which carries an empty
 *  sentinel roster). Everything else in AgentLoopConfig is INPUT-OWNED
 *  (settings the vessel injects: model/prompt/tool hashes/active tools) and
 *  must overlay so updated settings reach the model. */
const FOLD_OWNED_CONFIG_KEYS = ["roster"] as const;

/** Overlay input-owned config onto a folded state's config while preserving
 *  fold-owned fields (see FOLD_OWNED_CONFIG_KEYS). Used by the fold cache on
 *  every reload: input settings win, but the folded roster survives so
 *  channel tools don't vanish after an eviction/reload. */
export function overlayInputConfig(
  folded: AgentLoopConfig,
  input: AgentLoopConfig,
): AgentLoopConfig {
  const merged = { ...input };
  for (const key of FOLD_OWNED_CONFIG_KEYS) {
    (merged as Record<string, unknown>)[key] = folded[key];
  }
  return merged;
}

export interface ModelRequestDescriptor {
  provider: string;
  model: string;
  /** Journaled pi-ai Model literal — the ONLY resolution path in the
   *  executor (design §6.2).
   *  For local models the journaled baseUrl documents what ran; the live
   *  endpoint from ensureLoaded() wins at execution time (§6.3). */
  modelSpec: AgentModelSpec;
  /** Auth mode copied from the catalog entry (design §6.3). Absent ⇒ "url-bound". */
  auth?: ModelAuthMode;
  modelBaseUrl?: string;
  thinkingLevel: ThinkingLevel;
  /** Provider-native service tier pinned at request materialization time. */
  serviceTier?: "priority";
  systemPromptHash: string;
  skillIndexHash?: string;
  toolSchemasHash?: string;
  activeToolNames: string[];
  /** Exact channel-method routing represented by `toolSchemasHash` for this
   * model call. Dispatch must use this map rather than a later live roster,
   * which may change while the model request is in flight. */
  channelToolOwners?: Record<string, ParticipantRef>;
  /** Exact canonical humans available when this model call was materialized.
   * `ask_user` is a local model tool whose execution is rewritten onto the
   * channel, so its target set must be pinned at the same boundary as channel
   * tool ownership instead of consulting mutable presence after the model
   * returns. */
  askUserParticipants?: Array<{
    participantId: string;
    ref: ParticipantRef;
    handle?: string;
  }>;
  /** entries snapshot boundary; executor rebuilds context through this seq. */
  contextThroughSeq: number;
  attemptId: string;
  streamOptions?: { deltaBatchMs?: number; idleTimeoutMs?: number | null };
  turnMetadata?: AgentTurnMetadata;
}

export interface OpenTurn {
  turnId: string;
  openedAtSeq: number;
  reason?: string;
  /** count of message.started in this turn — drives messageId derivation. */
  modelCallCount: number;
  /** Consecutive model failures since the last successful assistant message. */
  consecutiveModelFailureCount: number;
  /** system.event {interrupt} seen since the turn opened (gates new model calls). */
  interrupted: boolean;
  /** count of turn.waiting events (drives waiting envelope id suffix). */
  waitingCount: number;
  /**
   * Log boundary at which the turn was parked. Recovery wakes must only resume
   * when transcript input newer than this boundary exists; otherwise the tool
   * result that requested suspension would wake itself forever.
   */
  waitingAtSeq?: number;
  metadata?: AgentTurnMetadata;
  /** A soft "flush queued steers" interrupt is in flight: the in-flight model
   *  call is being aborted, but the turn must CONTINUE (re-run the model with
   *  the queued steers) rather than close. Distinct from `interrupted` (a hard
   *  interrupt that closes the turn). Cleared when the next model call starts. */
  pendingFlush?: "steers";
  /** True once this turn has auto-switched to the local fallback. */
  failedOverToFallback?: boolean;
  /** Most recently journaled model route for this turn. Once failover occurs,
   *  post-tool continuation calls reuse this complete request descriptor so
   *  they cannot drift back to an unavailable primary model. */
  activeModelRequest?: ModelRequestDescriptor;
  /** Captured by the fold when a model failure clears inFlightModelCall, so the
   *  post-fold step can still apply provider/local guards. */
  lastFailedModelRequest?: ModelRequestDescriptor;
}

export interface InFlightModelCall {
  messageId: string;
  attemptId: string;
  contextThroughSeq: number;
  request: ModelRequestDescriptor;
}

export interface PendingInvocation {
  invocationId: string;
  turnId: string;
  startedAtSeq: number;
  /** originating model attempt (causality.attemptId). */
  attemptId?: string;
  name: string;
  transport: InvocationTransport;
  /** Folded from invocation.started so replay preserves the originally
   * selected ordering even if the installed tool registry later changes. */
  executionMode: "sequential" | "parallel";
  /** Durable ask_user fan-out audience. The pure effect derivation recreates
   * one independently journaled channel call per target after a restart. */
  askUserTargets?: ParticipantRef[];
  request: unknown;
  requiresApproval: boolean;
  approvalId?: string;
  approvalState: "none" | "pending" | "granted";
}

export interface PendingApproval {
  approvalId: string;
  invocationId: string;
  turnId: string;
  startedAtSeq: number;
  question: string;
  details: { toolName: string; input: unknown };
}

export interface PendingCredentialWait {
  credKey: string;
  providerId: string;
  turnId: string;
  startedAtSeq: number;
  connectSpec: Record<string, unknown>;
  modelBaseUrl?: string;
  waitReason?:
    | "model_credential_required"
    | "model_credential_reconnect_required";
  reason?: string;
  failureCode?: string;
  /** ISO; from the logged event, never wall clock. */
  expiresAt: string;
}

export interface SteeringEntry {
  envelopeId: string;
  turnTriggerEnvelopeId: string;
  seq: number;
  /** Sender's canonical message id; the read-ack/edit/retract correlation key. */
  sourceMessageId?: string;
  senderRef: ParticipantRef;
  content: unknown;
  metadata?: AgentTurnMetadata;
  artifactsReady?: boolean;
}

export interface PendingPrompt {
  envelopeId: string;
  turnTriggerEnvelopeId: string;
  seq: number;
  sourceMessageId?: string;
  senderRef: ParticipantRef;
  content: unknown;
  agentHops?: number;
  metadata?: AgentTurnMetadata;
  /** The exact prompt/tool/model snapshot needed to consume this input has
   * completed and was journaled after the input. */
  artifactsReady?: boolean;
}

/** A "send after turn" message held until the current turn closes, then
 *  promoted (one per turn) into a fresh turn of its own. */
export interface DeferredPrompt {
  sourceMessageId: string;
  envelopeId: string;
  turnTriggerEnvelopeId: string;
  seq: number;
  senderRef: ParticipantRef;
  content: unknown;
  metadata?: AgentTurnMetadata;
  agentHops?: number;
  artifactsReady?: boolean;
}

/** Durable prerequisite for consuming an inbound prompt/steer. The request is
 * journaled before any host/build/blob I/O starts; the outbox derives exactly
 * one preparation effect at a time from these rows. */
export interface PendingPromptPreparation {
  triggerEnvelopeId: string;
  /** Original channel envelope that determines the semantic turn identity.
   * `triggerEnvelopeId` is the private trajectory copy used for effect
   * idempotency and must never replace this value in turn ids. */
  turnTriggerEnvelopeId: string;
  requestedAtSeq: number;
}

/** Linear session entry — the materialized model-context path. */
export type SessionEntry =
  | {
      kind: "user";
      seq: number;
      envelopeId: string;
      sourceMessageId?: string;
      senderRef?: ParticipantRef;
      content: unknown;
      structuredInput?: unknown;
      metadata?: AgentTurnMetadata;
    }
  | {
      kind: "assistant";
      seq: number;
      messageId: string;
      /** Author. When it differs from the loop's `selfId` (another agent in the channel),
       *  the context builder presents this as an attributed `user` message, NOT as this
       *  agent's own `assistant` turn — so the model doesn't read it as its own voice. */
      senderRef?: ParticipantRef;
      blocks: unknown[];
      outcome?: string;
      /** Present only for model-produced messages. Runtime diagnostics and
       * model-free direct invocations have no model identity to invent. */
      model?: AssistantModelIdentity;
    }
  | {
      kind: "tool-result";
      seq: number;
      invocationId: string;
      turnId: string;
      attemptId?: string;
      name: string;
      result: unknown;
      isError: boolean;
      /** True only when this finalized tool asked the owning model turn to
       * stop after its entire sibling batch settles. */
      terminate?: boolean;
      /** Retained so a terminal infrastructure failure cannot be forgotten
       * while parallel sibling invocations are still settling. */
      terminalOutcome?:
        | "tool_error"
        | "infrastructure_error"
        | "cancelled"
        | "stale_dispatch"
        | "abandoned";
      terminalReasonCode?: string;
      /** Full typed failure is retained until turn closure so mission ledgers
       * can record child-effect failures even when the model recovers. */
      failure?: AgentToolFailure;
      /** Typed recovery survives folding so parallel sibling settlement cannot
       * turn a recoverable infrastructure failure into a terminal turn. */
      failureRecovery?: AgentToolFailure["recovery"];
    }
  | { kind: "note"; seq: number; text: string };

export interface AgentState {
  /** Invalidates non-authoritative fold caches when model-context projection changes. */
  modelContextVersion: number;
  logId: string;
  head: string;
  channelId: string;
  /** seq of last folded envelope. */
  lastSeq: number;
  /** hash of last folded envelope (== expectedHeadHash for the next append). */
  lastHash: string;
  /** fork boundary of this head (0 for root logs); pendings with
   *  startedAtSeq ≤ forkSeq are pre-cut (fork policy). */
  forkSeq: number;
  /** This agent's own participant/actor id for this channel's loop. Turn/message
   *  lifecycle events authored by ANOTHER participant are NOT folded into loop state
   *  (the fold filters by this), so the agent never adopts another agent's open turn
   *  from the shared channel replay. */
  selfId: string;
  /** Actors whose assistant messages before `forkSeq` are inherited model
   * history rather than messages from unrelated channel participants. */
  lineageSelfIds: string[];

  config: AgentLoopConfig;
  entries: SessionEntry[];

  openTurn: OpenTurn | null;
  inFlightModelCall: InFlightModelCall | null;
  pendingInvocations: Record<string, PendingInvocation>;
  pendingApprovals: Record<string, PendingApproval>;
  pendingCredentialWaits: Record<string, PendingCredentialWait>;
  steeringQueue: SteeringEntry[];
  pendingPrompt: PendingPrompt | null;
  pendingPromptPreparations: Record<string, PendingPromptPreparation>;
  /** "Send after turn" messages, drained one per turn after each turn closes. */
  deferredPostTurnQueue: DeferredPrompt[];
}

export const MODEL_CONTEXT_VERSION = 2;

/**
 * A trajectory fork inherits semantic conversation entries, not executable
 * delivery state. Replaying the parent's prefix under a new agent identity can
 * otherwise leave the latest user message as a pending prompt: the parent's
 * turn lifecycle is correctly foreign to the child and therefore never clears
 * it. Keep the entries for context/cache reuse while dropping every pre-cut
 * prompt/control projection. New child-channel input is always post-cut.
 */
export function normalizeForkControlState(state: AgentState): AgentState {
  if (state.forkSeq <= 0) return state;
  const pendingPrompt =
    state.pendingPrompt && state.pendingPrompt.seq <= state.forkSeq
      ? null
      : state.pendingPrompt;
  const pendingPromptPreparations = Object.fromEntries(
    Object.entries(state.pendingPromptPreparations).filter(
      ([, preparation]) => preparation.requestedAtSeq > state.forkSeq,
    ),
  );
  return {
    ...state,
    modelContextVersion: MODEL_CONTEXT_VERSION,
    pendingPrompt,
    pendingPromptPreparations,
    steeringQueue: state.steeringQueue.filter(
      (entry) => entry.seq > state.forkSeq,
    ),
    deferredPostTurnQueue: state.deferredPostTurnQueue.filter(
      (entry) => entry.seq > state.forkSeq,
    ),
  };
}

export const GENESIS_LAST_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000";

export interface InitialStateInput {
  channelId: string;
  logId?: string;
  head?: string;
  config: AgentLoopConfig;
  forkSeq?: number;
  lastSeq?: number;
  lastHash?: string;
  /** The agent's own participant/actor id (see AgentState.selfId). */
  selfId: string;
  lineageSelfIds?: string[];
}

export function initialAgentState(input: InitialStateInput): AgentState {
  const logId = input.logId ?? logIdForChannel(input.channelId);
  return {
    modelContextVersion: MODEL_CONTEXT_VERSION,
    logId,
    head: input.head ?? logId,
    channelId: input.channelId,
    lastSeq: input.lastSeq ?? input.forkSeq ?? 0,
    lastHash: input.lastHash ?? GENESIS_LAST_HASH,
    forkSeq: input.forkSeq ?? 0,
    selfId: input.selfId,
    lineageSelfIds: input.lineageSelfIds ?? [],
    config: input.config,
    entries: [],
    openTurn: null,
    inFlightModelCall: null,
    pendingInvocations: {},
    pendingApprovals: {},
    pendingCredentialWaits: {},
    steeringQueue: [],
    pendingPrompt: null,
    pendingPromptPreparations: {},
    deferredPostTurnQueue: [],
  };
}

/** Derived turn status — replaces the old 8-state agent_turn_runs FSM. */
export function derivedTurnStatus(
  state: AgentState,
): "idle" | "starting" | "running_model" | "waiting_external" | "continuing" {
  if (
    state.pendingPrompt ||
    Object.keys(state.pendingPromptPreparations).length > 0
  ) {
    return "starting";
  }
  if (!state.openTurn) return "idle";
  if (state.inFlightModelCall) return "running_model";
  if (state.openTurn.modelCallCount === 0) return "starting";
  const pendings = Object.values(state.pendingInvocations);
  const hasExternal =
    pendings.some((inv) => inv.transport.kind !== "local") ||
    Object.keys(state.pendingApprovals).length > 0 ||
    Object.keys(state.pendingCredentialWaits).length > 0;
  if (pendings.length > 0 || hasExternal) return "waiting_external";
  return "continuing";
}
