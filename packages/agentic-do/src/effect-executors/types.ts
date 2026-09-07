/**
 * Executor interfaces (WS1 §2.4). Executors are the impure edge: they take a
 * pure EffectDescriptor + read-only AgentState and produce an EffectOutcome
 * that `outcomeEvents` (pure) maps to terminal append items. Ephemeral
 * emissions (stream deltas, typing) bypass the log entirely.
 */

import type {
  AgentLoopConfig,
  AgentState,
  EffectDescriptor,
  EffectKind,
  EffectOutcome,
} from "@workspace/agent-loop";
import type { AgenticEvent, ParticipantRef } from "@workspace/agentic-protocol";
import type { AgentToolFailure } from "@workspace/agentic-protocol";

export type EffectDeferral =
  | { deferred: true; reason: "authority" }
  | { deferred: true; reason: "external-result" };

export type EphemeralEmit =
  | {
      /** AgenticEvent shape broadcast as a channel `signal` (never durable). */
      kind: "signal-event";
      channelId: string;
      event: AgenticEvent;
    }
  | {
      /** Plain channel signal payload for live-only UI pills (never durable). */
      kind: "signal-message";
      channelId: string;
      content: string;
      contentType?: string;
    };

export interface BlobReaderWriter {
  getText(digest: string): Promise<string | null>;
  putText(value: string): Promise<{ digest: string; size: number }>;
}

export interface ChannelCallPort {
  callMethod(input: {
    channelId: string;
    targetParticipantId: string;
    transportCallId: string;
    method: string;
    args: unknown;
    invocationId: string;
    turnId?: string;
    timeoutMs?: number;
  }): Promise<void>;
  cancelMethodCall(channelId: string, transportCallId: string): Promise<void>;
  publish(input: {
    channelId: string;
    payloadKind: string;
    payload: unknown;
    idempotencyKey?: string;
  }): Promise<void>;
  recordReadReceipt(input: {
    channelId: string;
    messageId: string;
    turnId?: string;
  }): Promise<void>;
  sendSignalEvent(channelId: string, event: AgenticEvent): Promise<void>;
}

export interface CredentialPort {
  /** Resolve the API key for a provider; throws CredentialPendingError when a
   *  connect flow is required. */
  getApiKey(input: {
    providerId: string;
    modelBaseUrl?: string;
    requestId?: string;
    idempotencyKey?: string;
    signal?: AbortSignal;
  }): Promise<{ apiKey: string; headers?: Record<string, string> }>;
  /** Register interest in a credential with the server-side service;
   *  resolution is delivered back via deliverEffectOutcome (http callback). */
  registerCredentialInterest(input: {
    credKey: string;
    providerId: string;
    effectId: string;
    expiresAt: string;
  }): Promise<void>;
}

export class CredentialPendingError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly modelBaseUrl?: string
  ) {
    super(`credential pending for ${providerId}`);
    this.name = "CredentialPendingError";
  }
}

export class CredentialApprovalDeferredError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly modelBaseUrl?: string
  ) {
    super(`credential approval deferred for ${providerId}`);
    this.name = "CredentialApprovalDeferredError";
  }
}

/** Bridge to the local-models extension (design §6.3). Only consulted for
 *  requests with auth: "loopback"; the loopback api-key obtained here exists
 *  solely in extension storage and in-flight request headers — callers must
 *  never persist or journal it. */
export interface LocalModelsPort {
  /** Request-path start/load: boots the local server process if needed,
   *  triggers the router load, returns the LIVE base URL (journaled ports
   *  must never become load-bearing). */
  ensureLoaded(modelId: string, signal: AbortSignal): Promise<{ baseUrl: string }>;
  getLoopbackAuth(signal: AbortSignal): Promise<{ apiKey: string }>;
}

export interface LocalToolPort {
  /** Execute a registered local tool. */
  run(input: {
    channelId: string;
    tool: string;
    invocationId: string;
    args: unknown;
    signal: AbortSignal;
    onProgress?(chunk: unknown): void;
  }): Promise<
    | {
        result: unknown;
        summary?: string;
        isError: boolean;
        /** Preserve the tool runtime's early-termination request across the
         * durable effect boundary. */
        terminate?: boolean;
        terminalReasonCode?: string;
        failure?: AgentToolFailure;
      }
    // A long-running local tool (the agent's `eval`) defers: it kicks off the work (eval.start)
    // and the result arrives out-of-band via `deliverEffectOutcome` (onEvalComplete). The driver
    // parks the leased row (deferRedrive backstop), exactly like channel_call/http_call.
    | { deferred: true; reason: "external-result" }
  >;
  /** Mutation-replay guard (§1.4.2). A completed semantic command is durable
   * evidence that this invocation must be recovered, not executed again. */
  alreadyApplied(
    state: AgentState,
    invocationId: string
  ): Promise<{ commandId: string; command: unknown } | null>;
}

export interface HttpCallPort {
  post(input: {
    targetUrl?: string;
    target?: { service: string; method: string };
    idempotencyKey: string;
    request: unknown;
    /** Branch-scoped outbox row id — the durable continuation key used to
     * redrive the exact request after authority changes. */
    effectId: string;
    callback: { source: string; className: string; objectKey: string; method: string };
  }): Promise<
    { deferred: true; reason: "authority" } | { deferred: false; result: unknown; isError: boolean }
  >;
}

export interface ExecutorDeps {
  selfRef: ParticipantRef;
  blobstore: BlobReaderWriter;
  channel: ChannelCallPort;
  credentials: CredentialPort;
  /** Absent when the local-models extension is not installed — loopback
   *  requests then fail with a clear model error, never a suspend. */
  localModels?: LocalModelsPort;
  localTools: LocalToolPort;
  promptArtifacts?: {
    prepare(channelId: string, signal: AbortSignal): Promise<Partial<AgentLoopConfig>>;
  };
  http: HttpCallPort;
  callbackAddress: { source: string; className: string; objectKey: string };
  env?: Record<string, unknown>;
}

export type ModelExecutionAttemptEvent =
  | {
      phase: "started";
      attemptId: string;
      channelId: string;
      messageId: string;
      provider: string;
      model: string;
      ref: string;
      api: string;
      baseUrl: string;
      auth: string;
      startedAt: string;
      transportRuntime: {
        workersFetchUpgradeAvailable: boolean;
        ambientWebSocketAvailable: boolean;
        vibestudioWebSocketRouteInstalled: boolean;
      };
    }
  | {
      phase: "finished";
      attemptId: string;
      completedAt: string;
      outcome: "completed" | "failed" | "aborted";
      usage?: Record<string, unknown>;
      error?: string;
    };

export interface EffectExecutor<D extends EffectDescriptor = EffectDescriptor> {
  kind: EffectKind;
  execute(args: {
    descriptor: D;
    state: AgentState;
    signal: AbortSignal;
    deps: ExecutorDeps;
    onEphemeral(emit: EphemeralEmit): void;
    /** Activation-local, payload-free stage marker for live stall diagnostics. */
    onExecutionProgress?(stage: string): void;
    /** Synchronous local durability hook. A thrown `started` write prevents
     * the provider call; a thrown terminal write surfaces as a system error. */
    onModelExecutionAttempt?(event: ModelExecutionAttemptEvent): void;
  }): Promise<EffectOutcome | EffectDeferral>;
}
