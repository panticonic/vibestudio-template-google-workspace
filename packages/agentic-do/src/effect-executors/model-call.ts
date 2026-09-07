/**
 * model_call executor (WS1 §2.4.1) — drives @workspace/pi-ai `stream`
 * directly. The prompt is re-derived purely from the log (entries through
 * contextThroughSeq) + blobstore hashes — nothing closure-bound. Streaming
 * deltas ride the channel's ephemeral signal mode; the durable terminal is
 * `message.completed` with authoritative blocks.
 */

import { stream } from "@workspace/pi-ai/compat";
import {
  closeOpenAICodexWebSocketSessions,
  releaseOpenAICodexWebSocketSession,
} from "@workspace/pi-ai/api/openai-codex-responses";
import { clampMaxTokensToContext } from "@workspace/pi-ai/api/simple-options";
import type { Context, Message } from "@workspace/pi-ai";
import {
  buildModelContext,
  classifyModelFailure,
  type AgentState,
  type AgentTurnContextPolicy,
  type EffectOutcome,
  modelFailureInputFromUnknown,
  type ModelCallEffect,
  type ModelMessage,
} from "@workspace/agent-loop";
import {
  AGENTIC_PROTOCOL_VERSION,
  hydrateStoredValueRefs,
  type AgenticEvent,
} from "@workspace/agentic-protocol";
import { buildRawThinkingOptions, type RawThinkingModel } from "./pi-raw-thinking-options.js";
import {
  CredentialApprovalDeferredError,
  CredentialPendingError,
  type EffectDeferral,
  type EffectExecutor,
  type EphemeralEmit,
} from "./types.js";
import { modelCredentialReconnectOutcome } from "../model-credential-suspension.js";

const PI_REPLAY_METADATA_KEY = "pi";
const MAX_PROVIDER_SESSION_ID_LENGTH = 64;
const LOCAL_MODEL_SIGNAL_CONTENT_TYPE = "vibestudio-ext-working";
const LOCAL_MODEL_PREFILL_POLL_MS = 1000;
// A Codex request with no response headers or stream frames is not a long
// generation; it is a dead transport. Keep the lease renewable by real
// provider activity, but never let an absent provider response pin the agent
// turn and its authority session forever.
const DEFAULT_CODEX_TRANSPORT_IDLE_TIMEOUT_MS = 60_000;

class ModelProgressIdleTimeoutError extends Error {
  readonly code = "model_stream_stalled_retryable";

  constructor(timeoutMs: number) {
    super(`Model stream made no semantic progress for ${timeoutMs}ms`);
    this.name = "ModelProgressIdleTimeoutError";
  }
}

async function nextModelStreamEvent<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number | undefined,
  abort: (reason: Error) => void
): Promise<IteratorResult<T>> {
  const pending = iterator.next();
  if (timeoutMs === undefined || timeoutMs <= 0) return pending;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new ModelProgressIdleTimeoutError(timeoutMs);
          abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type PiReplayMetadata = {
  textSignature?: string;
  thinkingSignature?: string;
  thoughtSignature?: string;
  redacted?: boolean;
};

type OnEphemeral = (emit: EphemeralEmit) => void;

function emitLocalModelStatus(onEphemeral: OnEphemeral, channelId: string, message: string): void {
  onEphemeral({
    kind: "signal-message",
    channelId,
    content: JSON.stringify({ message }),
    contentType: LOCAL_MODEL_SIGNAL_CONTENT_TYPE,
  });
}

function startLocalModelPrefillSignals(input: {
  baseUrl: string;
  apiKey: string;
  signal: AbortSignal;
  emit(message: string): void;
}): () => void {
  const slotsUrl = localModelSlotsUrl(input.baseUrl);
  if (!slotsUrl || input.signal.aborted) return () => {};
  const abort = new AbortController();
  const abortFromParent = () => abort.abort(input.signal.reason);
  input.signal.addEventListener("abort", abortFromParent, { once: true });
  let stopped = false;
  let lastPercent: number | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    input.signal.removeEventListener("abort", abortFromParent);
    abort.abort();
  };

  void (async () => {
    while (!stopped && !abort.signal.aborted) {
      if (!(await waitForPrefillPollDelay(abort.signal))) return;
      let percent: number | null = null;
      try {
        const response = await fetch(slotsUrl, {
          headers: { Authorization: `Bearer ${input.apiKey}` },
          signal: abort.signal,
        });
        if (!response.ok) {
          stop();
          return;
        }
        percent = prefillPercentFromSlots(await response.json());
      } catch {
        stop();
        return;
      }
      if (percent !== null && percent > 0 && percent !== lastPercent) {
        lastPercent = percent;
        input.emit(`Reading prompt ${percent}%…`);
      }
    }
  })();

  return stop;
}

function localModelSlotsUrl(baseUrl: string): string | null {
  try {
    return `${baseUrl.replace(/\/+$/u, "")}/slots`;
  } catch {
    return null;
  }
}

function waitForPrefillPollDelay(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, LOCAL_MODEL_PREFILL_POLL_MS);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function prefillPercentFromSlots(value: unknown): number | null {
  const slots = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { slots?: unknown }).slots)
      ? (value as { slots: unknown[] }).slots
      : [value];
  const percents = slots
    .map(prefillPercentFromSlot)
    .filter((percent): percent is number => percent !== null);
  return percents.length > 0 ? Math.max(...percents) : null;
}

function prefillPercentFromSlot(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const slot = value as Record<string, unknown>;
  const direct = firstFiniteNumber(slot, [
    "prompt_progress",
    "promptProgress",
    "prefill_progress",
    "prefillProgress",
    "progress",
  ]);
  if (direct !== null) return normalizePercent(direct);

  const processed = firstFiniteNumber(slot, [
    "n_prompt_tokens_processed",
    "prompt_tokens_processed",
    "processed_prompt_tokens",
    "n_past",
  ]);
  const total = firstFiniteNumber(slot, [
    "n_prompt_tokens",
    "prompt_tokens",
    "prompt_tokens_total",
    "n_prompt_total",
  ]);
  if (processed === null || total === null || total <= 0) return null;
  return normalizePercent((processed / total) * 100);
}

function firstFiniteNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    const numeric =
      typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function normalizePercent(value: number): number {
  const percent = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function isUnattendedModelRequest(request: ModelCallEffect["request"]): boolean {
  return request.turnMetadata?.origin === "scheduled";
}

function modelFailureOutcome(
  err: unknown,
  request: ModelCallEffect["request"],
  opts: { modelBaseUrl?: string } = {}
): EffectOutcome {
  const failure = classifyModelFailure(
    modelFailureInputFromUnknown(err, {
      provider: request.provider,
      model: request.model,
      now: new Date().toISOString(),
    })
  );
  if (
    failure.code === "auth_or_credentials" &&
    request.auth !== "loopback" &&
    !isUnattendedModelRequest(request)
  ) {
    return modelCredentialReconnectOutcome({
      providerId: request.provider,
      modelBaseUrl: opts.modelBaseUrl ?? request.modelBaseUrl,
      reason: failure.reason,
      failureCode: failure.code,
    });
  }
  if (failure.recoverable && failure.retryAfterMs !== undefined) {
    return {
      kind: "retry",
      reason: failure.reason,
      retryAfterMs: failure.retryAfterMs,
      code: failure.code,
    };
  }
  return {
    kind: "model",
    blocks: [],
    stopReason: "error",
    errorReason: failure.reason,
    recoverable: failure.recoverable,
    failure,
  };
}

function modelFailureOutcomeFromMessage(
  message: string,
  request: ModelCallEffect["request"],
  opts: { modelBaseUrl?: string } = {}
): EffectOutcome {
  return modelFailureOutcome(new Error(message), request, opts);
}

function modelCallTraceEnabled(env?: Record<string, unknown>): boolean {
  const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  return (
    env?.["VIBESTUDIO_MODEL_CALL_TRACE"] === "1" ||
    env?.["VIBESTUDIO_MODEL_CALL_TRACE"] === true ||
    processEnv?.["VIBESTUDIO_MODEL_CALL_TRACE"] === "1" ||
    processEnv?.["VIBESTUDIO_MODEL_CALL_TRACE"] === "true" ||
    env?.["VIBESTUDIO_LOG_LEVEL"] === "verbose" ||
    env?.["VIBESTUDIO_LOG_LEVEL"] === "trace" ||
    processEnv?.["VIBESTUDIO_LOG_LEVEL"] === "verbose" ||
    processEnv?.["VIBESTUDIO_LOG_LEVEL"] === "trace"
  );
}

function traceModelCallStage(
  stage: string,
  descriptor: ModelCallEffect,
  extra?: Record<string, unknown>,
  env?: Record<string, unknown>
): void {
  if (!modelCallTraceEnabled(env)) return;
  console.info("[model-call] trace:", {
    stage,
    channelId: descriptor.channelId,
    turnId: descriptor.turnId,
    messageId: descriptor.messageId,
    provider: descriptor.request.provider,
    model: descriptor.request.model,
    attemptId: descriptor.request.attemptId,
    ...extra,
  });
}

function modelStreamSessionId(
  descriptor: ModelCallEffect,
  selfRef: { id: string; participantId?: string }
): string {
  // This is a transport reuse scope, not an agent identity. A turn can make
  // several sequential model requests around tool calls, but a different
  // turn or fallback model must never inherit the prior connection's
  // provider-side continuation state.
  return providerSafeSessionId(
    [
      descriptor.channelId,
      selfRef.participantId ?? selfRef.id,
      descriptor.turnId,
      descriptor.request.provider,
      descriptor.request.model,
    ].join(":")
  );
}

/** Credential-free activation evidence for diagnosing a model attempt that
 * was journaled but never emitted a provider event. Keep this on the same
 * module graph as the transport call so it describes the exact bundled
 * runtime, not the host process. */
export function modelTransportRuntimeEvidence(): {
  workersFetchUpgradeAvailable: boolean;
  ambientWebSocketAvailable: boolean;
  vibestudioWebSocketRouteInstalled: boolean;
} {
  const globals = globalThis as typeof globalThis & {
    WebSocketPair?: unknown;
    WebSocket?: unknown;
    __vibestudioPrepareModelWebSocket?: unknown;
  };
  return {
    workersFetchUpgradeAvailable:
      typeof globals.fetch === "function" && typeof globals.WebSocketPair === "function",
    ambientWebSocketAvailable: typeof globals.WebSocket === "function",
    vibestudioWebSocketRouteInstalled:
      typeof globals.__vibestudioPrepareModelWebSocket === "function",
  };
}

function hasToolCallBlock(blocks: readonly unknown[]): boolean {
  return blocks.some(
    (block) =>
      !!block &&
      typeof block === "object" &&
      (block as Record<string, unknown>)["type"] === "toolCall"
  );
}

function providerSafeSessionId(raw: string): string {
  if (raw.length <= MAX_PROVIDER_SESSION_ID_LENGTH) return raw;
  const hash = stableShortHash(raw);
  const prefixLength = MAX_PROVIDER_SESSION_ID_LENGTH - hash.length - 1;
  return `${raw.slice(0, prefixLength)}-${hash}`;
}

function stableShortHash(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(36).padStart(7, "0")}${(h1 >>> 0).toString(36).padStart(7, "0")}`;
}

export function toPiMessages(messages: ModelMessage[]): Message[] {
  assertToolResultsHaveAssistantCalls(messages);
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({
        role: "user",
        content:
          typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : extractUserContent(message.content),
        timestamp: 0,
      } as unknown as Message);
    } else if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: toPiAssistantBlocks(message.blocks ?? []) as never,
        ...(message.model
          ? {
              provider: message.model.provider,
              api: message.model.api,
              model: message.model.model,
            }
          : {}),
        usage: {},
        stopReason: "stop",
        timestamp: 0,
      } as unknown as Message);
    } else {
      out.push({
        role: "toolResult",
        toolCallId: message.toolCallId ?? "",
        toolName: message.toolName ?? "",
        content: modelFacingToolResultContent(message.content),
        isError: message.isError ?? false,
        timestamp: 0,
      } as unknown as Message);
    }
  }
  return out;
}

type ModelFacingToolBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Keep tool protocol content separate from diagnostic/UI details and preserve
 * screenshots as native multimodal blocks instead of base64 language text. */
export function modelFacingToolResultContent(value: unknown): ModelFacingToolBlock[] {
  const record = isRecord(value) ? value : null;
  const rawBlocks = Array.isArray(value)
    ? value
    : Array.isArray(record?.["protocolContent"])
      ? record!["protocolContent"]
      : Array.isArray(record?.["content"])
        ? record!["content"]
        : null;
  if (!rawBlocks) return [{ type: "text", text: safeText(value) }];

  const blocks: ModelFacingToolBlock[] = [];
  for (const raw of rawBlocks) {
    if (!isRecord(raw)) continue;
    if (raw["type"] === "text" && typeof raw["text"] === "string") {
      blocks.push({ type: "text", text: raw["text"] });
      continue;
    }
    if (
      raw["type"] === "image" &&
      typeof raw["data"] === "string" &&
      typeof raw["mimeType"] === "string"
    ) {
      blocks.push({ type: "image", data: raw["data"], mimeType: raw["mimeType"] });
    }
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text: safeText(value) }];
}

function assertToolResultsHaveAssistantCalls(messages: ModelMessage[]): void {
  const availableToolCalls = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.blocks ?? []) {
        const id = toolCallIdFromBlock(block);
        if (id) availableToolCalls.add(id);
      }
      continue;
    }
    if (message.role !== "toolResult") continue;
    const toolCallId = message.toolCallId ?? "";
    if (toolCallId && availableToolCalls.has(toolCallId)) {
      availableToolCalls.delete(toolCallId);
      continue;
    }
    const label = [message.toolName, toolCallId].filter(Boolean).join(" ");
    throw new Error(
      `model transcript invariant violated: orphaned tool result${label ? ` ${label}` : ""}`
    );
  }
  const danglingToolCall = availableToolCalls.values().next().value as string | undefined;
  if (danglingToolCall) {
    throw new Error(
      `model transcript invariant violated: assistant tool call ${danglingToolCall} has no tool result`
    );
  }
}

function toolCallIdFromBlock(block: unknown): string | null {
  if (!block || typeof block !== "object") return null;
  const record = block as Record<string, unknown>;
  const type = record["type"];
  if (type !== "toolCall" && type !== "tool_call") return null;
  const id = record["id"] ?? record["toolCallId"] ?? record["call_id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Tool calls and their results are one causal transcript unit even when
 * asynchronous steering messages arrive between them. Expand a retained
 * selection in both directions so context trimming can never keep one side
 * while dropping the other.
 */
function closeOverToolInteractions(
  messages: readonly ModelMessage[],
  selected: Set<number>
): Set<number> {
  const ownerByToolCall = new Map<string, number>();
  const resultsByToolCall = new Map<string, number[]>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "assistant") {
      for (const block of message.blocks ?? []) {
        const id = toolCallIdFromBlock(block);
        if (id) ownerByToolCall.set(id, index);
      }
    } else if (message.role === "toolResult" && message.toolCallId) {
      const indexes = resultsByToolCall.get(message.toolCallId) ?? [];
      indexes.push(index);
      resultsByToolCall.set(message.toolCallId, indexes);
    }
  }

  for (let changed = true; changed; ) {
    changed = false;
    for (const index of [...selected]) {
      const message = messages[index]!;
      if (message.role === "toolResult" && message.toolCallId) {
        const owner = ownerByToolCall.get(message.toolCallId);
        if (owner !== undefined && !selected.has(owner)) {
          selected.add(owner);
          changed = true;
        }
      } else if (message.role === "assistant") {
        for (const block of message.blocks ?? []) {
          const id = toolCallIdFromBlock(block);
          if (!id) continue;
          for (const resultIndex of resultsByToolCall.get(id) ?? []) {
            if (!selected.has(resultIndex)) {
              selected.add(resultIndex);
              changed = true;
            }
          }
        }
      }
    }
  }
  return selected;
}

function toolInteractionIndexes(
  messages: readonly ModelMessage[],
  assistantIndex: number
): Set<number> {
  return closeOverToolInteractions(messages, new Set([assistantIndex]));
}

/** Journaled protocol blocks carry `content`; pi-ai message blocks carry
 *  `text` / `thinking`. Passing protocol blocks through raw makes pi-ai call
 *  `text.replace` on undefined for every historical text block — which fails
 *  every model call in any turn whose context contains assistant prose. */
export function toPiAssistantBlocks(blocks: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    const type = block["type"];
    const replay = readPiReplayMetadata(block["metadata"]);
    const content = typeof block["content"] === "string" ? (block["content"] as string) : "";
    if (type === "text") {
      out.push({
        type: "text",
        text: typeof block["text"] === "string" ? block["text"] : content,
        ...(replay.textSignature !== undefined ? { textSignature: replay.textSignature } : {}),
      });
    } else if (type === "thinking") {
      out.push({
        type: "thinking",
        thinking: typeof block["thinking"] === "string" ? block["thinking"] : content,
        ...(replay.thinkingSignature !== undefined
          ? { thinkingSignature: replay.thinkingSignature }
          : {}),
        ...(replay.redacted !== undefined ? { redacted: replay.redacted } : {}),
      });
    } else if (type === "toolCall") {
      out.push({
        type: "toolCall",
        id: block["id"],
        name: block["name"],
        arguments: block["arguments"] ?? {},
        ...(replay.thoughtSignature !== undefined
          ? { thoughtSignature: replay.thoughtSignature }
          : {}),
      });
    }
    // diagnostic / unknown block types are agent-internal — not model input.
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readPiReplayMetadata(metadata: unknown): PiReplayMetadata {
  if (!isRecord(metadata)) return {};
  const pi = metadata[PI_REPLAY_METADATA_KEY];
  if (!isRecord(pi)) return {};
  return {
    ...(typeof pi["textSignature"] === "string" ? { textSignature: pi["textSignature"] } : {}),
    ...(typeof pi["thinkingSignature"] === "string"
      ? { thinkingSignature: pi["thinkingSignature"] }
      : {}),
    ...(typeof pi["thoughtSignature"] === "string"
      ? { thoughtSignature: pi["thoughtSignature"] }
      : {}),
    ...(typeof pi["redacted"] === "boolean" ? { redacted: pi["redacted"] } : {}),
  };
}

function metadataWithPiReplay(
  existing: unknown,
  replay: PiReplayMetadata
): Record<string, unknown> | undefined {
  const base = isRecord(existing) ? { ...existing } : {};
  const pi = readDefinedReplayMetadata(replay);
  if (Object.keys(pi).length > 0) {
    const existingPi = isRecord(base[PI_REPLAY_METADATA_KEY]) ? base[PI_REPLAY_METADATA_KEY] : {};
    base[PI_REPLAY_METADATA_KEY] = { ...existingPi, ...pi };
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

function readDefinedReplayMetadata(replay: PiReplayMetadata): Record<string, unknown> {
  return {
    ...(replay.textSignature !== undefined ? { textSignature: replay.textSignature } : {}),
    ...(replay.thinkingSignature !== undefined
      ? { thinkingSignature: replay.thinkingSignature }
      : {}),
    ...(replay.thoughtSignature !== undefined ? { thoughtSignature: replay.thoughtSignature } : {}),
    ...(replay.redacted !== undefined ? { redacted: replay.redacted } : {}),
  };
}

function extractUserContent(content: unknown): Array<{ type: "text"; text: string }> {
  if (
    content &&
    typeof content === "object" &&
    Array.isArray((content as { blocks?: unknown[] }).blocks)
  ) {
    const blocks = (content as { blocks: unknown[] }).blocks;
    const texts = blocks
      .map((block) =>
        block &&
        typeof block === "object" &&
        typeof (block as { content?: unknown }).content === "string"
          ? (block as { content: string }).content
          : null
      )
      .filter((text): text is string => text !== null);
    if (texts.length > 0) return texts.map((text) => ({ type: "text", text }));
  }
  return [{ type: "text", text: safeText(content) }];
}

function safeText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function deterministicTestModeModelOutcome(
  descriptor: ModelCallEffect,
  state: AgentState,
  systemPrompt: string,
  env?: Record<string, unknown>
): EffectOutcome | null {
  const testMode = env?.["VIBESTUDIO_TEST_MODE"];
  const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  if (testMode !== "1" && processEnv?.["VIBESTUDIO_TEST_MODE"] !== "1") return null;

  // This deterministic endpoint substitutes only for model inference,
  // independently of whichever provider a fresh profile resolves. The opening
  // turn is the prompt's executable startup contract; honor its explicit
  // Markdown-path read so E2E still exercises the real invocation, file
  // transport, and continuation loop.
  const openingTurn = systemPrompt.match(/##\s+Opening turn\b([\s\S]*?)(?=\n##\s|$)/i)?.[1];
  const requestedRead = openingTurn?.match(/\bread\s+`([^`]+)`/i)?.[1];
  if (requestedRead && descriptor.request.activeToolNames.includes("read")) {
    const turnOpenedAt = state.openTurn?.openedAtSeq ?? 0;
    const readCompleted = state.entries.some(
      (entry) =>
        entry.kind === "tool-result" &&
        entry.seq >= turnOpenedAt &&
        entry.name === "read" &&
        !entry.isError
    );
    if (!readCompleted) {
      return {
        kind: "model",
        blocks: [
          {
            type: "toolCall",
            id: `${descriptor.messageId}:test-read`,
            name: "read",
            arguments: { path: requestedRead },
          },
        ],
        stopReason: "completed",
        outcome: "tool_calls_only",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
  }

  const turnOpenedAt = state.openTurn?.openedAtSeq ?? 0;
  const userEntry = [...state.entries]
    .reverse()
    .find(
      (entry): entry is Extract<(typeof state.entries)[number], { kind: "user" }> =>
        entry.kind === "user" && entry.seq <= descriptor.request.contextThroughSeq
    );
  const userRequest = userEntry
    ? extractUserContent(userEntry.content)
        .map((block) => block.text)
        .join("\n")
    : undefined;
  const requestedWebUrl =
    typeof userRequest === "string"
      ? /\bhttps?:\/\/[^\s<>"')\]]+/iu.exec(userRequest)?.[0]?.replace(/[.,;:!?]+$/u, "")
      : undefined;
  const requestsSandboxExecution =
    typeof userRequest === "string" && /\b(?:eval|sandbox)\b/iu.test(userRequest);
  if (
    requestedWebUrl &&
    requestsSandboxExecution &&
    descriptor.request.activeToolNames.includes("eval")
  ) {
    const evalCompleted = state.entries.some(
      (entry) => entry.kind === "tool-result" && entry.seq >= turnOpenedAt && entry.name === "eval"
    );
    if (!evalCompleted) {
      const urlLiteral = JSON.stringify(requestedWebUrl);
      return {
        kind: "model",
        blocks: [
          {
            type: "toolCall",
            id: `${descriptor.messageId}:test-eval-fetch`,
            name: "eval",
            arguments: {
              syntax: "javascript",
              code:
                `const response = await credentials.fetch(${urlLiteral});\n` +
                "const body = await response.text();\n" +
                "return { url: response.url, status: response.status, head: body.slice(0, 512) };",
            },
          },
        ],
        stopReason: "completed",
        outcome: "tool_calls_only",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
  } else if (requestedWebUrl && descriptor.request.activeToolNames.includes("web_fetch")) {
    const webFetchCompleted = state.entries.some(
      (entry) =>
        entry.kind === "tool-result" && entry.seq >= turnOpenedAt && entry.name === "web_fetch"
    );
    if (!webFetchCompleted) {
      return {
        kind: "model",
        blocks: [
          {
            type: "toolCall",
            id: `${descriptor.messageId}:test-web-fetch`,
            name: "web_fetch",
            arguments: { url: requestedWebUrl },
          },
        ],
        stopReason: "completed",
        outcome: "tool_calls_only",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
  }

  return {
    kind: "model",
    blocks: [
      {
        blockId: `${descriptor.messageId}:block:0`,
        type: "text",
        content: "E2E model response: initial agent turn completed.",
      },
    ],
    stopReason: "completed",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

const SLOW_MODEL_CALL_WARN_INTERVAL_MS = 30_000;
/** Re-emit the ephemeral tool-call progress line every this many argument
 *  bytes (~a few times per second at typical stream rates). */
const TOOLCALL_PROGRESS_EMIT_BYTES = 2_048;

/** Best-effort tool name from a stream event's `partial` message (the last
 *  toolCall content block carries the name once the provider has parsed it). */
function toolCallNameFromEvent(event: Record<string, unknown>): string | null {
  const partial = event["partial"];
  if (!partial || typeof partial !== "object") return null;
  const content = (partial as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i];
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record["type"] !== "toolCall") continue;
    const name = record["name"] ?? record["toolName"] ?? record["functionName"];
    return typeof name === "string" && name.length > 0 ? name : null;
  }
  return null;
}

/** Live stage marker for the slow-call watchdog: which phase of the model
 *  call is currently pending, and since when. Event accounting distinguishes
 *  a legitimately long generation (delta-heavy) from a stream that spins on
 *  ignored events (keepalives/status frames) and never terminates. */
type ModelCallProgress = {
  stage: string;
  stageChangedAt: number;
  startedAt: number;
  eventCounts: Record<string, number>;
  lastEventType: string | null;
  totalEvents: number;
  lastEventAt: number | null;
  /** Largest gap between consecutive stream events since the last slow-call
   *  warning — distinguishes a provider that throttles mid-stream (large gaps)
   *  from a steady stream that is merely long (small gaps, high totals). */
  maxEventGapMs: number;
  /** Aggregate argument bytes received for in-flight tool calls. */
  toolArgumentBytes: number;
  /** Stage-transition timeline for the per-call completion summary. */
  marks: Array<[string, number]>;
};

/** Pairwise phase durations from the stage timeline, keyed by the phase that
 *  was running (e.g. `credential.resolve.start: 120` = 120ms resolving). */
function phaseDurationsFromMarks(
  marks: Array<[string, number]>,
  endedAt: number
): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < marks.length; i += 1) {
    const [stage, at] = marks[i]!;
    const nextAt = i + 1 < marks.length ? marks[i + 1]![1] : endedAt;
    out[stage] = (out[stage] ?? 0) + (nextAt - at);
  }
  return out;
}

export const modelCallExecutor: EffectExecutor<ModelCallEffect> = {
  kind: "model_call",

  async execute(args) {
    const { descriptor } = args;
    const progress: ModelCallProgress = {
      stage: "start",
      stageChangedAt: Date.now(),
      startedAt: Date.now(),
      eventCounts: {},
      lastEventType: null,
      totalEvents: 0,
      lastEventAt: null,
      maxEventGapMs: 0,
      toolArgumentBytes: 0,
      marks: [["start", Date.now()]],
    };
    // Stall diagnostics: several phases of a model call (credential resolve,
    // blob hydration, the provider stream itself) ride host RPCs with no
    // transport deadline — while any of them is pending, periodically name
    // the offending stage in the log instead of hanging silently.
    let eventsAtLastWarn = 0;
    const slowTimer = setInterval(() => {
      const eventsInWindow = progress.totalEvents - eventsAtLastWarn;
      eventsAtLastWarn = progress.totalEvents;
      const maxEventGapMs = progress.maxEventGapMs;
      progress.maxEventGapMs = 0;
      console.warn("[model-call] slow model call:", {
        stage: progress.stage,
        stageAgeMs: Date.now() - progress.stageChangedAt,
        totalMs: Date.now() - progress.startedAt,
        eventCounts: progress.eventCounts,
        lastEventType: progress.lastEventType,
        eventsInWindow,
        eventsPerSecond:
          Math.round((eventsInWindow / (SLOW_MODEL_CALL_WARN_INTERVAL_MS / 1000)) * 10) / 10,
        maxEventGapMs,
        toolArgumentBytes: progress.toolArgumentBytes,
        channelId: descriptor.channelId,
        messageId: descriptor.messageId,
        provider: descriptor.request.provider,
        model: descriptor.request.model,
      });
    }, SLOW_MODEL_CALL_WARN_INTERVAL_MS);
    try {
      return await executeModelCall(args, progress);
    } finally {
      clearInterval(slowTimer);
      // Per-call phase summary: which phase the time went to. A session that
      // "starts fast and crawls" shows its growth here — context-build/
      // hydration (our storage path), time-to-first-event (provider prefill /
      // prompt-cache miss), or stream rate (provider). Quick calls stay silent
      // unless the fine-grained trace is enabled; slow ones always log.
      const endedAt = Date.now();
      const summaryWorthLogging =
        endedAt - progress.startedAt >= 10_000 || modelCallTraceEnabled(args.deps.env);
      if (summaryWorthLogging)
        console.info("[model-call] finished:", {
          totalMs: endedAt - progress.startedAt,
          phaseMs: phaseDurationsFromMarks(progress.marks, endedAt),
          totalEvents: progress.totalEvents,
          eventCounts: progress.eventCounts,
          toolArgumentBytes: progress.toolArgumentBytes,
          channelId: descriptor.channelId,
          messageId: descriptor.messageId,
          provider: descriptor.request.provider,
          model: descriptor.request.model,
        });
    }
  },
};

async function executeModelCall(
  {
    descriptor,
    state,
    signal,
    deps,
    onEphemeral,
    onExecutionProgress,
    onModelExecutionAttempt,
  }: Parameters<EffectExecutor<ModelCallEffect>["execute"]>[0],
  progress: ModelCallProgress
): Promise<EffectOutcome | EffectDeferral> {
  const request = descriptor.request;
  const throwIfAborted = () => {
    if (!signal.aborted) return;
    throw signal.reason instanceof Error ? signal.reason : new Error("model call aborted");
  };
  const trace = (stage: string, extra?: Record<string, unknown>) => {
    progress.stage = stage;
    progress.stageChangedAt = Date.now();
    progress.marks.push([stage, progress.stageChangedAt]);
    onExecutionProgress?.(stage);
    traceModelCallStage(stage, descriptor, extra, deps.env);
  };
  trace("start");
  throwIfAborted();

  // Journal-materialized model resolution (design §6.2): the request carries
  // the exact pi-ai Model literal the vessel resolved at the impure edge.
  // There is no registry fallback in the executor: the impure configuration
  // boundary materializes the descriptor before a request can be journaled.
  const modelSpec = request.modelSpec;
  const modelBaseUrl = request.modelBaseUrl ?? modelSpec.baseUrl;

  if (!request.systemPromptHash) {
    const error = new Error(
      "Vibestudio model setup invariant failed: the system prompt artifact is not ready"
    );
    error.name = "PromptArtifactInvariantError";
    throw error;
  }
  const systemPromptPromise = deps.blobstore.getText(request.systemPromptHash);
  const toolsJsonPromise = request.toolSchemasHash
    ? deps.blobstore.getText(request.toolSchemasHash)
    : Promise.resolve(null);
  // The credential lookup below can return (suspend) or throw before these
  // are awaited; detached no-op handlers prevent an unhandled rejection in
  // that window. The awaited Promise.all still observes any real rejection.
  systemPromptPromise.catch(() => {});
  toolsJsonPromise.catch(() => {});

  const testModeEnabled =
    deps.env?.["VIBESTUDIO_TEST_MODE"] === "1" ||
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
      "VIBESTUDIO_TEST_MODE"
    ] === "1";
  const testModeOutcome = testModeEnabled
    ? deterministicTestModeModelOutcome(
        descriptor,
        state,
        (await systemPromptPromise) ?? "",
        deps.env
      )
    : null;
  if (testModeOutcome) {
    trace("test-mode.completed");
    return testModeOutcome;
  }

  let credentials: { apiKey: string; headers?: Record<string, string> };
  // Live endpoint override: set for loopback (ensureLoaded's answer beats any
  // journaled port — design §6.3) or when the request carries an explicit one.
  let liveBaseUrl: string | undefined = request.modelBaseUrl;
  const isLoopback = request.auth === "loopback";
  if (isLoopback) {
    // Local llama.cpp: no stored credential, no connect-card suspend. The
    // loopback key is injected here at call time and exists only in
    // extension storage and this in-flight request — never journaled.
    const localModels = deps.localModels;
    if (!localModels) {
      return {
        kind: "model",
        blocks: [],
        stopReason: "error",
        errorReason:
          "local model runtime unavailable (local-models extension not reachable from executor)",
      };
    }
    try {
      const modelName =
        typeof modelSpec.name === "string" && modelSpec.name.trim()
          ? modelSpec.name
          : request.model;
      emitLocalModelStatus(onEphemeral, descriptor.channelId, "Starting local model…");
      emitLocalModelStatus(
        onEphemeral,
        descriptor.channelId,
        `Loading ${modelName}… (first use may download)`
      );
      trace("loopback.ensure-loaded.start", { model: request.model });
      const [loaded, auth] = await Promise.all([
        localModels.ensureLoaded(request.model, signal),
        localModels.getLoopbackAuth(signal),
      ]);
      liveBaseUrl = loaded.baseUrl;
      credentials = { apiKey: auth.apiKey };
      trace("loopback.ready", { baseUrl: loaded.baseUrl });
    } catch (err) {
      // Activation release owns this signal. Cancellation is not a model
      // failure and must not manufacture a terminal outcome; let the driver
      // retain the durable outbox row for recovery in the next activation.
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("model call aborted");
      }
      return {
        kind: "model",
        blocks: [],
        stopReason: "error",
        errorReason: `local model start failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  } else {
    // A pending connect suspends the turn, not fails it. Immutable prompt/tool
    // blob reads above can run concurrently with this lookup.
    try {
      trace("credential.resolve.start", { modelBaseUrl });
      credentials = await deps.credentials.getApiKey({
        providerId: request.provider,
        ...(modelBaseUrl ? { modelBaseUrl } : {}),
        requestId: descriptor.effectId,
        idempotencyKey: descriptor.idempotencyKey,
        signal,
      });
      throwIfAborted();
      trace("credential.resolve.completed", {
        hasHeaders: !!credentials.headers,
      });
    } catch (err) {
      throwIfAborted();
      if (err instanceof CredentialApprovalDeferredError) {
        return { deferred: true, reason: "authority" };
      }
      if (err instanceof CredentialPendingError) {
        trace("credential.pending", {
          providerId: err.providerId,
          modelBaseUrl: err.modelBaseUrl ?? modelBaseUrl,
        });
        return {
          kind: "model-suspended",
          reason: "credential",
          providerId: err.providerId,
          ...((err.modelBaseUrl ?? modelBaseUrl)
            ? { modelBaseUrl: err.modelBaseUrl ?? modelBaseUrl }
            : {}),
        } satisfies EffectOutcome;
      }
      throw err;
    }
  }

  const [systemPromptRaw, toolsJson] = await Promise.all([systemPromptPromise, toolsJsonPromise]);
  throwIfAborted();
  trace("context.blobs.loaded", {
    hasSystemPrompt: systemPromptRaw !== null,
    hasTools: toolsJson !== null,
  });
  const systemPrompt = systemPromptForPolicy(
    systemPromptRaw ?? undefined,
    request.turnMetadata?.contextPolicy
  );
  const tools = toolsJson ? (JSON.parse(toolsJson) as Context["tools"]) : undefined;

  // Storage boundary, model-input side: fold entries keep spilled fields
  // (tool results, large user content) as blob refs — the model must see
  // the actual bytes, never `vibestudio.blob-ref.v1` pointers (a model that
  // reads pointer JSON emits garbage tool args and pointer-shaped paths).
  const hydratedMessages = (await hydrateStoredValueRefs(
    modelContextForPolicy(state, request.contextThroughSeq, request.turnMetadata?.contextPolicy),
    { getText: (digest) => deps.blobstore.getText(digest) }
  )) as ModelMessage[];
  const modelFacingMessages = hydratedMessages.map((message) =>
    message.role === "toolResult"
      ? { ...message, content: modelFacingToolResultContent(message.content) }
      : message
  );
  throwIfAborted();
  const unboundedMessages = modelFacingMessages;
  const boundedInput = boundModelInput({
    messages: unboundedMessages,
    systemPrompt: systemPrompt || undefined,
    tools,
    contextWindow: modelSpec.contextWindow,
    policyTokenBudget: request.turnMetadata?.contextPolicy?.tokenBudget,
  });
  const messages = boundedInput.messages;
  if (boundedInput.trimmed) {
    trace("context.trimmed", {
      originalChars: boundedInput.originalChars,
      finalChars: boundedInput.finalChars,
      removedMessages: boundedInput.removedMessages,
      windowedToolResults: boundedInput.windowedToolResults,
    });
  }
  const context: Context = {
    ...(systemPrompt ? { systemPrompt } : {}),
    messages: toPiMessages(messages),
    ...(tools ? { tools } : {}),
  };
  trace("context.built", {
    messageCount: context.messages.length,
    toolCount: Array.isArray(context.tools) ? context.tools.length : undefined,
  });

  const streamAbort = new AbortController();
  if (signal.aborted) {
    streamAbort.abort(signal.reason);
  }
  const forwardAbort = () => streamAbort.abort(signal.reason);
  signal.addEventListener("abort", forwardAbort, { once: true });

  trace("stream.start", {
    modelBaseUrl: liveBaseUrl ?? modelBaseUrl,
  });
  // Live endpoint override must be baked INTO the model literal: pi-ai
  // constructs its client from model.baseUrl and ignores any baseUrl
  // option (verified against 0.78.0) — with a journaled loopback
  // placeholder port, passing the spec unmodified dials a dead endpoint.
  const effectiveSpec = liveBaseUrl ? { ...modelSpec, baseUrl: liveBaseUrl } : modelSpec;
  const providerSessionId = modelStreamSessionId(descriptor, deps.selfRef);
  // Invalidation preserves the provider's same-session SSE fallback marker so
  // the durable retry does not immediately reuse a poisoned WebSocket.
  const invalidateProviderSession = () => closeOpenAICodexWebSocketSessions(providerSessionId);
  // Terminal release also clears fallback/debug state for this per-turn key.
  const releaseProviderSession = () => releaseOpenAICodexWebSocketSession(providerSessionId);
  const codexTransportIdleTimeoutMs =
    effectiveSpec.api === "openai-codex-responses"
      ? (modelSpec.streamIdleTimeoutMs ?? DEFAULT_CODEX_TRANSPORT_IDLE_TIMEOUT_MS)
      : undefined;
  const modelProgressIdleTimeoutMs =
    modelSpec.streamIdleTimeoutMs ?? codexTransportIdleTimeoutMs;
  const attemptId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  onModelExecutionAttempt?.({
    phase: "started",
    attemptId,
    channelId: descriptor.channelId,
    messageId: descriptor.messageId,
    provider: request.provider,
    model: request.model,
    ref: `${request.provider}:${request.model}`,
    api: String(effectiveSpec.api ?? ""),
    baseUrl: String(effectiveSpec.baseUrl ?? modelBaseUrl ?? ""),
    auth: request.auth ?? "url-bound",
    startedAt,
    transportRuntime: modelTransportRuntimeEvidence(),
  });
  let attemptFinished = false;
  const finishAttempt = (
    outcome: "completed" | "failed" | "aborted",
    options: { usage?: Record<string, unknown>; error?: string } = {}
  ) => {
    if (attemptFinished) return;
    attemptFinished = true;
    onModelExecutionAttempt?.({
      phase: "finished",
      attemptId,
      completedAt: new Date().toISOString(),
      outcome,
      ...(options.usage ? { usage: options.usage } : {}),
      ...(options.error ? { error: options.error } : {}),
    });
  };
  let eventStream: ReturnType<typeof stream>;
  try {
    // Some provider adapters begin transport setup even when handed an already
    // aborted signal. Never let retired channel work reach network or
    // credential authority after crossing the driver cancellation fence.
    throwIfAborted();
    eventStream = stream(effectiveSpec as never, context, {
      apiKey: credentials.apiKey,
      // We call pi-ai's raw stream surface to retain provider-native
      // reasoning summaries. Raw stream does not apply streamSimple's base
      // options for us, so carry the journaled model output limit across this
      // boundary explicitly. Omitting it lets a malformed tool call stream
      // without the model catalog's terminal token bound.
      maxTokens: clampMaxTokensToContext(effectiveSpec as never, context, effectiveSpec.maxTokens),
      ...(credentials.headers ? { headers: credentials.headers } : {}),
      signal: streamAbort.signal,
      sessionId: providerSessionId,
      ...(codexTransportIdleTimeoutMs !== undefined
        ? {
            // pi-ai applies timeoutMs only while waiting for SSE response
            // headers and streamIdleTimeoutMs as a renewable lease after the
            // stream starts (including WebSocket frames).
            timeoutMs: codexTransportIdleTimeoutMs,
            streamIdleTimeoutMs: codexTransportIdleTimeoutMs,
          }
        : {}),
      ...buildRawThinkingOptions(modelSpec as unknown as RawThinkingModel, request.thinkingLevel),
      ...(request.serviceTier ? { serviceTier: request.serviceTier } : {}),
    } as never);
  } catch (error) {
    signal.removeEventListener("abort", forwardAbort);
    invalidateProviderSession();
    finishAttempt("failed", { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  let stopPrefillSignals: (() => void) | null =
    isLoopback && liveBaseUrl
      ? startLocalModelPrefillSignals({
          baseUrl: liveBaseUrl,
          apiKey: credentials.apiKey,
          signal: streamAbort.signal,
          emit: (message) => emitLocalModelStatus(onEphemeral, descriptor.channelId, message),
        })
      : null;

  const blockIds = new Map<number, string>();
  const toolCallProgress = new Map<
    number,
    { name: string | null; argBytes: number; emitted: number }
  >();
  let deltaCounter = 0;
  let sawFirstStreamEvent = false;
  try {
    const iterator = (eventStream as AsyncIterable<Record<string, unknown>>)[
      Symbol.asyncIterator
    ]();
    for (;;) {
      // Raw transport activity (including SSE keepalives) proves only that a
      // socket is alive. Require provider-semantic events as a second,
      // renewable liveness lease so a stream cannot hold an interactive turn
      // open forever while producing no model progress.
      const next = await nextModelStreamEvent(iterator, modelProgressIdleTimeoutMs, (reason) => {
        streamAbort.abort(reason);
        void iterator.return?.().catch(() => {});
      });
      if (next.done) break;
      const event = next.value;
      // Direct progress update (not `trace` — per-event tracing would spam):
      // a healthy stream shows stage "streaming" with a fresh stageChangedAt.
      progress.stage = "streaming";
      progress.stageChangedAt = Date.now();
      const eventArrivedAt = Date.now();
      if (progress.lastEventAt !== null) {
        const gap = eventArrivedAt - progress.lastEventAt;
        if (gap > progress.maxEventGapMs) progress.maxEventGapMs = gap;
      }
      progress.lastEventAt = eventArrivedAt;
      progress.totalEvents += 1;
      const progressEventType = String(event["type"] ?? "unknown");
      progress.eventCounts[progressEventType] = (progress.eventCounts[progressEventType] ?? 0) + 1;
      progress.lastEventType = progressEventType;
      if (!sawFirstStreamEvent) {
        sawFirstStreamEvent = true;
        stopPrefillSignals?.();
        stopPrefillSignals = null;
        trace("stream.first-event", {
          eventType: String(event["type"] ?? ""),
        });
        // first-event is an instant milestone, not the phase that remains
        // active for the rest of generation.
        trace("streaming");
      }
      const type = String(event["type"] ?? "");
      if (type === "text_delta" || type === "thinking_delta") {
        const index = Number(event["contentIndex"] ?? event["index"] ?? 0);
        // First delta for this block IN THIS EXECUTION replaces the block's
        // accumulated text instead of appending. A retry of a retryably-failed
        // attempt reuses the same messageId AND blockIds, and no terminal is
        // published for the failed attempt — without `replace`, each retry's
        // re-derived thinking/text concatenates onto the dead attempt's in the
        // streaming card (the "word salad" wedge).
        const isFirstDeltaForBlock = !blockIds.has(index);
        if (isFirstDeltaForBlock) {
          blockIds.set(index, `${descriptor.messageId}:block:${index}`);
        }
        deltaCounter += 1;
        const deltaEvent: AgenticEvent = {
          kind: "message.delta",
          actor: deps.selfRef,
          causality: { messageId: descriptor.messageId as never },
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            blockId: blockIds.get(index) as never,
            type: type === "text_delta" ? "text" : "thinking",
            text: String(event["delta"] ?? event["text"] ?? ""),
            ...(isFirstDeltaForBlock ? { replace: true } : {}),
          },
          createdAt: new Date().toISOString(),
        } as AgenticEvent;
        onEphemeral({
          kind: "signal-event",
          channelId: descriptor.channelId,
          event: deltaEvent,
        });
      } else if (
        type === "toolcall_start" ||
        type === "toolcall_delta" ||
        type === "toolcall_end"
      ) {
        // Tool-call argument streaming is otherwise invisible: a model that
        // writes a whole file through tool args streams for minutes with a
        // dead-silent card ("looks hung"). Emit a throttled, self-replacing
        // progress line on a dedicated ephemeral block; the durable terminal
        // replaces blocks wholesale, so it vanishes on completion.
        const index = Number(event["contentIndex"] ?? event["index"] ?? 0);
        if (type === "toolcall_start") {
          toolCallProgress.set(index, {
            name: toolCallNameFromEvent(event),
            argBytes: 0,
            emitted: 0,
          });
        }
        const tracked = toolCallProgress.get(index) ?? { name: null, argBytes: 0, emitted: 0 };
        if (type === "toolcall_delta") {
          const deltaBytes = String(event["delta"] ?? "").length;
          tracked.argBytes += deltaBytes;
          progress.toolArgumentBytes += deltaBytes;
          if (!tracked.name) tracked.name = toolCallNameFromEvent(event);
        }
        toolCallProgress.set(index, tracked);
        const shouldEmit =
          type === "toolcall_start" ||
          type === "toolcall_end" ||
          tracked.argBytes - tracked.emitted >= TOOLCALL_PROGRESS_EMIT_BYTES;
        if (shouldEmit) {
          tracked.emitted = tracked.argBytes;
          // Machine-readable status line; the chat pill renders it with its
          // own spinner/label chrome. `name|bytes|phase` keeps the payload a
          // plain delta string (no protocol schema change beyond the type).
          const text = JSON.stringify({
            toolName: tracked.name,
            argBytes: tracked.argBytes,
            phase: type === "toolcall_end" ? "prepared" : "streaming",
          });
          onEphemeral({
            kind: "signal-event",
            channelId: descriptor.channelId,
            event: {
              kind: "message.delta",
              actor: deps.selfRef,
              causality: { messageId: descriptor.messageId as never },
              payload: {
                protocol: AGENTIC_PROTOCOL_VERSION,
                blockId: `${descriptor.messageId}:toolcall-progress:${index}` as never,
                type: "toolcall-progress",
                text,
                replace: true,
              },
              createdAt: new Date().toISOString(),
            } as AgenticEvent,
          });
        }
      }
    }
  } catch (err) {
    stopPrefillSignals?.();
    stopPrefillSignals = null;
    signal.removeEventListener("abort", forwardAbort);
    if (signal.aborted) {
      releaseProviderSession();
      finishAttempt("aborted", { error: String(signal.reason ?? "aborted") });
      return { kind: "model", blocks: [], stopReason: "aborted" };
    }
    // The journaled message.failed only keeps the message — log the stack
    // here so a deterministic crash in the request path is traceable.
    console.warn(
      "[model-call] stream failed:",
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    );
    trace("stream.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    invalidateProviderSession();
    finishAttempt("failed", { error: err instanceof Error ? err.message : String(err) });
    return modelFailureOutcome(err, request, { modelBaseUrl });
  }
  void deltaCounter;
  stopPrefillSignals?.();
  stopPrefillSignals = null;

  let result: Record<string, unknown>;
  try {
    trace("stream.result.start");
    result = await (
      eventStream as unknown as { result(): Promise<Record<string, unknown>> }
    ).result();
  } catch (err) {
    if (signal.aborted) {
      releaseProviderSession();
      finishAttempt("aborted", { error: String(signal.reason ?? "aborted") });
      return { kind: "model", blocks: [], stopReason: "aborted" };
    }
    invalidateProviderSession();
    finishAttempt("failed", { error: err instanceof Error ? err.message : String(err) });
    return modelFailureOutcome(
      err instanceof Error ? err : new Error("model stream failed"),
      request,
      { modelBaseUrl }
    );
  } finally {
    signal.removeEventListener("abort", forwardAbort);
  }
  const content = Array.isArray(result["content"]) ? (result["content"] as unknown[]) : [];
  const blocks = toProtocolBlocks(content, descriptor.messageId);
  const stopReason = String(result["stopReason"] ?? "stop");
  const usage =
    result["usage"] && typeof result["usage"] === "object" && !Array.isArray(result["usage"])
      ? (result["usage"] as Record<string, unknown>)
      : undefined;
  trace("stream.result.completed", {
    stopReason,
    blockCount: content.length,
  });
  if (signal.aborted || stopReason === "aborted") {
    releaseProviderSession();
    finishAttempt("aborted", {
      ...(usage ? { usage } : {}),
      error: String(signal.reason ?? result["errorMessage"] ?? "aborted"),
    });
    return {
      kind: "model",
      blocks,
      stopReason: "aborted",
    };
  }
  if (stopReason === "error") {
    invalidateProviderSession();
    // Provider-reported terminal error (e.g. a WS close mid-generation).
    // This path throws nothing, so without this log the failure is invisible
    // in worker logs — only the journaled message.failed records it.
    console.warn("[model-call] stream ended with provider error:", {
      errorMessage: String(result["errorMessage"] ?? "model error"),
      totalMs: Date.now() - progress.startedAt,
      eventCounts: progress.eventCounts,
      channelId: descriptor.channelId,
      messageId: descriptor.messageId,
      provider: request.provider,
      model: request.model,
    });
    const errorMessage = String(result["errorMessage"] ?? "model error");
    finishAttempt("failed", { ...(usage ? { usage } : {}), error: errorMessage });
    return modelFailureOutcomeFromMessage(errorMessage, request, { modelBaseUrl });
  }
  // Tool calls continue the same turn, so keep the connection-scoped Codex
  // context for the immediately following model request. Final assistant
  // output ends the reuse scope explicitly; no idle socket is required for
  // correctness and no socket is left behind to impede DO hibernation.
  if (!hasToolCallBlock(blocks)) releaseProviderSession();
  finishAttempt("completed", usage ? { usage } : {});
  return {
    kind: "model",
    blocks,
    stopReason: "completed",
    usage,
  };
}

function systemPromptForPolicy(
  workspacePrompt: string | undefined,
  policy?: AgentTurnContextPolicy
): string | undefined {
  if (!policy || policy.mode === "full") {
    return appendPromptFile(workspacePrompt, policy?.promptFileContent);
  }
  const parts = [
    "You are running a reviewed unattended automation. Follow its prompt using the relevant context, finish with a concise result, and avoid unrelated user-facing chatter.",
  ];
  if (policy.includeWorkspacePrompt !== false && workspacePrompt) {
    parts.push(workspacePrompt);
  }
  if (policy.promptFileContent) parts.push(policy.promptFileContent);
  return parts.filter(Boolean).join("\n\n");
}

function appendPromptFile(
  prompt: string | undefined,
  promptFileContent?: string
): string | undefined {
  if (!promptFileContent) return prompt;
  return [prompt, promptFileContent].filter(Boolean).join("\n\n");
}

function modelContextForPolicy(
  state: Parameters<typeof buildModelContext>[0],
  contextThroughSeq: number,
  policy?: AgentTurnContextPolicy
): ModelMessage[] {
  if (!policy || policy.mode === "full") {
    return buildModelContext(state, contextThroughSeq);
  }
  const entries = state.entries.filter((entry) => entry.seq <= contextThroughSeq);
  const targetOrigin = state.openTurn?.metadata?.origin ?? "scheduled";
  let startIndex = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.kind === "user" && entry.metadata?.origin === targetOrigin) {
      startIndex = i;
      break;
    }
  }
  if (startIndex < 0) {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i]?.kind === "user") {
        startIndex = i;
        break;
      }
    }
  }
  const selectedEntries = startIndex >= 0 ? entries.slice(startIndex) : entries.slice(-1);
  return buildModelContext({ ...state, entries: selectedEntries }, contextThroughSeq);
}

interface BoundedModelInput {
  messages: ModelMessage[];
  trimmed: boolean;
  originalChars: number;
  finalChars: number;
  removedMessages: number;
  windowedToolResults: number;
}

/**
 * Bound the actual provider input after blob hydration. Stored-value pointers
 * are intentionally tiny, so budgeting before hydration can underestimate a
 * tool result by megabytes and let an otherwise recoverable turn hit the
 * provider's hard context limit.
 *
 * Old complete interactions are removed as assistant+tool-result units so the
 * provider transcript invariant is preserved. If the newest result alone is
 * huge, only the provider-facing copy is windowed; the journal and inspection
 * trajectory retain the full value and the model receives an explicit recovery
 * notice instead of a terminal context-overflow error.
 */
function boundModelInput(input: {
  messages: ModelMessage[];
  systemPrompt?: string;
  tools?: Context["tools"];
  contextWindow: number;
  policyTokenBudget?: number;
}): BoundedModelInput {
  const fixedChars = JSON.stringify({
    systemPrompt: input.systemPrompt ?? "",
    tools: input.tools ?? [],
  }).length;
  const reserveTokens = Math.min(
    16_384,
    Math.max(1_024, Math.floor(input.contextWindow * 0.15)),
    Math.max(1, Math.floor(input.contextWindow * 0.4))
  );
  const safeInputTokens = Math.max(1_024, input.contextWindow - reserveTokens);
  const requestedTokens =
    input.policyTokenBudget && input.policyTokenBudget > 0
      ? Math.min(safeInputTokens, input.policyTokenBudget)
      : safeInputTokens;
  // Three serialized characters per token is deliberately conservative for
  // code/JSON-heavy tool transcripts and leaves room for provider framing.
  const messageCharBudget = Math.max(4_000, requestedTokens * 3 - fixedChars);
  const originalChars = serializedMessageChars(input.messages);
  if (originalChars <= messageCharBudget) {
    return {
      messages: input.messages,
      trimmed: false,
      originalChars,
      finalChars: originalChars,
      removedMessages: 0,
      windowedToolResults: 0,
    };
  }

  let messages = [...input.messages];
  let removedMessages = 0;
  let windowedToolResults = 0;
  const omittedInteractionSummaries: string[] = [];

  // Prior turns are the cheapest context to discard. Preserve the newest user
  // request and everything after it. Steering can arrive while tools from an
  // earlier assistant message are still settling, so retain the complete
  // assistant/result interaction for every result that crosses this boundary.
  const lastUser = findLastUserMessageIndex(messages);
  if (lastUser > 0) {
    const retained = closeOverToolInteractions(
      messages,
      new Set(messages.map((_message, index) => index).filter((index) => index >= lastUser))
    );
    const removed = new Set(
      messages.map((_message, index) => index).filter((index) => !retained.has(index))
    );
    omittedInteractionSummaries.push(...summarizeRemovedToolInteractions(messages, removed));
    removedMessages += messages.length - retained.size;
    messages = messages.filter((_message, index) => retained.has(index));
  }

  // Within a tool-heavy current turn, discard oldest completed interactions
  // while retaining at least the newest assistant/result unit. Results need
  // not be contiguous with their assistant because pushed child/user steering
  // may be interleaved.
  while (serializedMessageChars(messages) > messageCharBudget) {
    const assistantIndexes = messages
      .map((message, index) => (message.role === "assistant" ? index : -1))
      .filter((index) => index >= 0);
    if (assistantIndexes.length <= 1) break;
    const remove = toolInteractionIndexes(messages, assistantIndexes[0]!);
    omittedInteractionSummaries.push(...summarizeRemovedToolInteractions(messages, remove));
    removedMessages += remove.size;
    messages = messages.filter((_message, index) => !remove.has(index));
  }

  // A single returned artifact can still exceed the whole model budget. Keep
  // head+tail evidence and an explicit recovery instruction in the provider
  // input without mutating the authoritative trajectory.
  for (let index = 0; index < messages.length; index += 1) {
    if (serializedMessageChars(messages) <= messageCharBudget) break;
    const message = messages[index]!;
    if (message.role !== "toolResult") continue;
    const blocks = modelFacingToolResultContent(message.content);
    const text = blocks
      .filter(
        (block): block is Extract<ModelFacingToolBlock, { type: "text" }> => block.type === "text"
      )
      .map((block) => block.text)
      .join("\n");
    if (text.length <= 8_000) continue;
    const excess = serializedMessageChars(messages) - messageCharBudget;
    const target = Math.max(4_000, Math.min(32_000, text.length - excess - 1_000));
    messages[index] = {
      ...message,
      content: [
        { type: "text", text: windowModelInputText(text, target, "tool result") },
        ...blocks.filter(
          (block): block is Extract<ModelFacingToolBlock, { type: "image" }> =>
            block.type === "image"
        ),
      ],
    };
    windowedToolResults += 1;
  }

  // Last resort: discard the remaining completed interaction and let the
  // capable agent re-run a narrower operation. A provider context error gives
  // it no opportunity to recover at all.
  while (serializedMessageChars(messages) > messageCharBudget) {
    const assistant = messages.findIndex((message) => message.role === "assistant");
    if (assistant < 0) break;
    const remove = toolInteractionIndexes(messages, assistant);
    omittedInteractionSummaries.push(...summarizeRemovedToolInteractions(messages, remove));
    removedMessages += remove.size;
    messages = messages.filter((_message, index) => !remove.has(index));
  }

  if (removedMessages > 0 && messages.length > 0) {
    const receiptLedger = windowModelInputText(
      omittedInteractionSummaries.slice(-12).join("\n"),
      6_000,
      "completed-call receipt ledger"
    );
    const notice: ModelMessage = {
      role: "user",
      content:
        `[Context safety: ${removedMessages} older completed transcript message(s) were omitted ` +
        "to fit this model's context window. Completed mutations remain durable: do not repeat " +
        "a create, fork, write, edit, commit, publish, or other side effect merely because its " +
        "original call is absent. Inspect scope and current workspace state, then resume only the " +
        `unfinished phase.${receiptLedger ? `\nRecent completed-call receipts:\n${receiptLedger}` : ""}]`,
    };
    const insertAt = messages[0]?.role === "user" ? 1 : 0;
    messages.splice(insertAt, 0, notice);
  }

  // A huge user attachment/request is rare but must still fail recoverably.
  if (serializedMessageChars(messages) > messageCharBudget) {
    const userIndex = findLastUserMessageIndex(messages);
    const user = messages[userIndex];
    if (user && typeof user.content === "string") {
      const excess = serializedMessageChars(messages) - messageCharBudget;
      const target = Math.max(2_000, user.content.length - excess - 1_000);
      messages[userIndex] = {
        ...user,
        content: windowModelInputText(user.content, target, "user content"),
      };
    }
  }

  const finalChars = serializedMessageChars(messages);
  return {
    messages,
    trimmed: true,
    originalChars,
    finalChars,
    removedMessages,
    windowedToolResults,
  };
}

function summarizeRemovedToolInteractions(
  messages: readonly ModelMessage[],
  removed: ReadonlySet<number>
): string[] {
  const results = new Map(
    messages
      .filter((message) => message.role === "toolResult" && message.toolCallId)
      .map((message) => [message.toolCallId!, message] as const)
  );
  const summaries: string[] = [];
  for (const index of removed) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    for (const raw of message.blocks ?? []) {
      if (!isRecord(raw) || (raw["type"] !== "toolCall" && raw["type"] !== "tool_call")) continue;
      const id = toolCallIdFromBlock(raw);
      const name = typeof raw["name"] === "string" ? raw["name"] : "tool";
      const args = windowModelInputText(safeText(raw["arguments"] ?? {}), 360, "arguments");
      const result = id ? results.get(id) : undefined;
      const blocks = modelFacingToolResultContent(result?.content);
      const text = blocks
        .map((block) =>
          block.type === "text"
            ? block.text
            : `[image ${block.mimeType}, ${block.data.length} chars]`
        )
        .join("\n");
      const outcome = result?.isError ? "failed" : result ? "completed" : "result unavailable";
      summaries.push(
        `- ${name} ${args} → ${outcome}: ${windowModelInputText(text, 700, "result")}`
      );
    }
  }
  return summaries;
}

function serializedMessageChars(messages: ModelMessage[]): number {
  return JSON.stringify(messages, function (key, value) {
    if (key === "data" && isRecord(this) && this["type"] === "image") {
      // Native images consume vision tokens, not one language token per few
      // base64 characters. Reserve a conservative fixed allowance while
      // keeping encoded pixels out of the text budget.
      return IMAGE_CONTEXT_BUDGET_PLACEHOLDER;
    }
    return value;
  }).length;
}

const IMAGE_CONTEXT_BUDGET_PLACEHOLDER = "x".repeat(4_800);

function findLastUserMessageIndex(messages: ModelMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

function windowModelInputText(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  const notice =
    `\n[${label} windowed for model context: ${text.length - maxChars} of ${text.length} chars ` +
    "omitted. The full value remains in the trajectory; re-run or page the source narrowly if needed.]\n";
  const contentBudget = Math.max(0, maxChars - notice.length);
  const head = Math.floor(contentBudget * 0.7);
  const tail = contentBudget - head;
  return `${text.slice(0, head)}${notice}${tail > 0 ? text.slice(-tail) : ""}`;
}

/** Block content is class-INLINE (the fold and step read block structure;
 *  there is no implicit spill), so this emitter must bound it: text and
 *  thinking content larger than this splits into multiple blocks. Margin
 *  below MAX_INLINE_TRAJECTORY_TEXT_BYTES leaves room for envelope framing. */
const MAX_BLOCK_CONTENT_BYTES = 96 * 1024;

/** Split on code-point boundaries so no chunk exceeds maxBytes of UTF-8. */
function splitTextByBytes(text: string, maxBytes: number): string[] {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes) return [text];
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of text) {
    const chBytes = encoder.encode(ch).byteLength;
    if (currentBytes + chBytes > maxBytes && current.length > 0) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += chBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Map pi-ai assistant content to the loop's block shapes: text/thinking
 *  blocks keep their content (split into multiple blocks when oversized —
 *  provider metadata/signatures stay on the first chunk); tool calls become
 *  `toolCall` blocks the step function recognizes (E-model-terminal). */
export function toProtocolBlocks(content: unknown[], messageId: string): unknown[] {
  return content.flatMap((block, index) => {
    if (!block || typeof block !== "object") return [block];
    const record = block as Record<string, unknown>;
    if (record["type"] === "text" || record["type"] === "thinking") {
      const type = record["type"];
      const metadata =
        type === "text"
          ? metadataWithPiReplay(record["metadata"], {
              ...(typeof record["textSignature"] === "string"
                ? { textSignature: record["textSignature"] }
                : {}),
            })
          : metadataWithPiReplay(record["metadata"], {
              ...(typeof record["thinkingSignature"] === "string"
                ? { thinkingSignature: record["thinkingSignature"] }
                : {}),
              ...(typeof record["redacted"] === "boolean" ? { redacted: record["redacted"] } : {}),
            });
      const text =
        type === "text"
          ? String(record["text"] ?? "")
          : String(record["thinking"] ?? record["text"] ?? "");
      return splitTextByBytes(text, MAX_BLOCK_CONTENT_BYTES).map((chunk, chunkIndex) => ({
        type,
        blockId:
          chunkIndex === 0
            ? `${messageId}:block:${index}`
            : `${messageId}:block:${index}:${chunkIndex}`,
        content: chunk,
        ...(chunkIndex === 0 && metadata ? { metadata } : {}),
      }));
    }
    if (record["type"] === "toolCall") {
      const metadata = metadataWithPiReplay(record["metadata"], {
        ...(typeof record["thoughtSignature"] === "string"
          ? { thoughtSignature: record["thoughtSignature"] }
          : {}),
      });
      // Recover name/args from the alternate keys some provider/pi-ai tool-call shapes
      // use (`toolName`/`functionName`; `input`/`args`). A missing `name` here is the
      // origin of the nameless "invocation" pill some tools (e.g. docs_*) showed.
      const name = String(record["name"] ?? record["toolName"] ?? record["functionName"] ?? "");
      const args = record["arguments"] ?? record["input"] ?? record["args"];
      if (!name) {
        // Diagnostic: the model block carried no usable tool name even after the
        // fallbacks. Log its shape so we can see whether the name lives under yet
        // another key, or is genuinely absent from the provider's tool-call.
        console.warn(
          "[model-call] toolCall block has no usable name; raw block:",
          JSON.stringify({ keys: Object.keys(record), block: record })?.slice(0, 1000)
        );
      }
      return [
        {
          type: "toolCall",
          id: String(record["id"] ?? ""),
          name,
          arguments: args,
          ...(metadata ? { metadata } : {}),
        },
      ];
    }
    return [block];
  });
}
