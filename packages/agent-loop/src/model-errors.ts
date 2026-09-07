export type ModelFailureClass =
  | "usage_limit_terminal"
  | "quota_exhausted_terminal"
  | "rate_limited_retryable"
  | "provider_overloaded_retryable"
  | "auth_or_credentials"
  | "request_invalid_terminal"
  | "circuit_breaker_open_retryable"
  | "context_overflow_terminal"
  | "infrastructure_terminal"
  | "model_stream_stalled_retryable"
  | "unknown_retryable";

export interface ModelFailureInfo {
  code: ModelFailureClass;
  reason: string;
  recoverable: boolean;
  retryAfterMs?: number;
  resetAt?: string;
}

export interface ModelFailureInput {
  provider?: string;
  model?: string;
  status?: number;
  code?: string;
  type?: string;
  name?: string;
  message?: string;
  rawReason?: string;
  headers?: Record<string, unknown>;
  body?: unknown;
  now?: string;
}

type ModelFailureInputArg = string | ModelFailureInput | undefined;

const GENERIC_MODEL_ERROR_MESSAGE = "The model request failed.";
const GENERIC_USAGE_LIMIT_MESSAGE = "The model usage limit has been reached.";
const GENERIC_QUOTA_MESSAGE = "The model provider quota has been exhausted.";
const GENERIC_RATE_LIMIT_MESSAGE = "The model provider rate limit has been reached.";
const GENERIC_OVERLOADED_MESSAGE = "The model provider is temporarily overloaded.";
const DEFAULT_RATE_LIMIT_RETRY_MS = 30_000;
const DEFAULT_OVERLOAD_RETRY_MS = 10_000;
const DEFAULT_CIRCUIT_BREAKER_RETRY_MS = 30_000;
const DEFAULT_UNKNOWN_RETRY_MS = 1_000;
const MAX_AUTOMATIC_RATE_LIMIT_RETRY_MS = 5 * 60_000;
const UTC_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const RETRYABLE_RATE_CODES = new Set([
  "rate_limit",
  "rate_limited",
  "rate_limit_error",
  "rate_limit_exceeded",
  "too_many_requests",
  "too_many_requests_error",
  "resource_exhausted",
  "throttled",
  "throttling",
  "throttling_exception",
  "throttlingexception",
  "toomanyrequestsexception",
  "too_many_requests_exception",
  "model_rate_limited",
  "tokens_rate_limited",
  "requests_rate_limited",
]);

const OVERLOAD_CODES = new Set([
  "overloaded",
  "overloaded_error",
  "server_overloaded",
  "service_unavailable",
  "service_unavailable_error",
  "unavailable",
  "temporarily_unavailable",
  "model_overloaded",
]);

const TERMINAL_QUOTA_CODES = new Set([
  "usage_limit_reached",
  "insufficient_quota",
  "quota_exceeded",
  "quota_exhausted",
  "billing_hard_limit_reached",
  "billing_not_active",
  "balance_exceeded",
  "credits_exhausted",
  "credit_exhausted",
  "servicequotaexceededexception",
  "service_quota_exceeded",
]);

const AUTH_CODES = new Set([
  "invalid_api_key",
  "token_expired",
  "unauthorized",
  "authentication_error",
  "permission_error",
  "permission_denied",
  "forbidden",
  "invalid_auth",
  "invalid_authentication",
  "invalid_x_api_key",
]);

const REQUEST_INVALID_CODES = new Set([
  "bad_request",
  "invalid_request_error",
  "invalid_request",
  "invalid_argument",
  "invalid_params",
  "not_found_error",
  "model_not_found",
  "unsupported_model",
]);

// These are Vibestudio control-plane failures, not provider failures. If one
// reaches model classification, an upstream RPC/eval boundary failed to settle
// or acquire authority correctly. Retrying the model can never repair that
// invocation and, with the durable model retry policy, would otherwise leave
// the owning turn spinning forever.
const INFRASTRUCTURE_TERMINAL_CODES = new Set(["eacquire", "eacces", "respond_timeout"]);

export function classifyModelFailure(
  input: ModelFailureInputArg,
  opts: { now?: string } = {}
): ModelFailureInfo {
  const normalized = normalizeInput(input, opts);
  const rawMessage = compactMessage(normalized);
  const embedded = parseEmbeddedJson(rawMessage);
  const body = mergeBody(normalized.body, embedded);
  const fields = collectFields(normalized, body);
  const codeKey = normalizeCode(fields.code ?? fields.type ?? fields.name);
  const status = fields.status;
  const retryAfterMs = retryAfterFromInput(normalized, body);
  const readable = readableMessage(fields.message ?? rawMessage);

  const codexUsage = codexUsageLimitMessage(fields, normalized, body, retryAfterMs);
  if (codexUsage) {
    return terminal("usage_limit_terminal", codexUsage.reason, {
      resetAt: codexUsage.resetAt,
    });
  }

  if (isInfrastructureTerminal(codeKey, readable)) {
    return terminal("infrastructure_terminal", readable);
  }

  if (codeKey === "model_stream_stalled_retryable") {
    return retryable("model_stream_stalled_retryable", readable, DEFAULT_UNKNOWN_RETRY_MS);
  }

  if (isAuthOrCredentialError(codeKey, status, readable)) {
    return terminal("auth_or_credentials", readable);
  }

  if (isTerminalQuotaError(codeKey, status, readable)) {
    return terminal("quota_exhausted_terminal", quotaMessage(readable));
  }

  if (isCircuitBreakerOpen(readable)) {
    return retryable("circuit_breaker_open_retryable", readable, DEFAULT_CIRCUIT_BREAKER_RETRY_MS);
  }

  if (isOverloadedError(codeKey, status, readable)) {
    return retryable(
      "provider_overloaded_retryable",
      overloadMessage(readable),
      boundedRetryAfter(retryAfterMs, DEFAULT_OVERLOAD_RETRY_MS)
    );
  }

  if (isRetryableRateLimit(codeKey, status, readable)) {
    const delayMs = boundedRetryAfter(retryAfterMs, DEFAULT_RATE_LIMIT_RETRY_MS);
    if (delayMs > MAX_AUTOMATIC_RATE_LIMIT_RETRY_MS) {
      const resetAt = new Date(baseNow(normalized) + delayMs).toISOString();
      return terminal(
        "rate_limited_retryable",
        `${rateLimitMessage(readable)} Try again after ${formatResetTime(resetAt)}.`,
        { resetAt }
      );
    }
    return retryable("rate_limited_retryable", rateLimitMessage(readable), delayMs);
  }

  if (isContextOverflow(codeKey, readable)) {
    return terminal("context_overflow_terminal", readable);
  }

  if (isProviderInputShapeError(readable)) {
    return terminal("request_invalid_terminal", readable);
  }

  if (isInvalidRequestError(codeKey, status, readable)) {
    return terminal("request_invalid_terminal", readable);
  }

  // Transport failures often arrive without an HTTP status/code (for example a
  // provider WebSocket closing cleanly before its terminal result). They are
  // not user/model errors and should exercise the bounded effect retry path,
  // rather than terminally failing an otherwise untouched turn.
  return retryable(
    "unknown_retryable",
    readable || GENERIC_MODEL_ERROR_MESSAGE,
    DEFAULT_UNKNOWN_RETRY_MS
  );
}

export function modelFailureInputFromUnknown(
  err: unknown,
  base: ModelFailureInput = {}
): ModelFailureInput {
  const input: ModelFailureInput = { ...base };
  if (err instanceof Error) {
    input.message = err.message;
    input.rawReason = err.message;
    input.name = err.name;
  } else if (typeof err === "string") {
    input.message = err;
    input.rawReason = err;
  } else {
    input.message = String(err);
    input.rawReason = String(err);
  }

  const recordValue = record(err);
  const response = record(recordValue["response"]);
  const cause = record(recordValue["cause"]);
  const error = record(recordValue["error"]);
  input.status =
    numberValue(recordValue["status"]) ??
    numberValue(recordValue["statusCode"]) ??
    numberValue(recordValue["code"]) ??
    numberValue(response["status"]) ??
    numberValue(cause["status"]) ??
    input.status;
  input.code =
    stringValue(recordValue["code"]) ??
    stringValue(error["code"]) ??
    stringValue(cause["code"]) ??
    input.code;
  input.type =
    stringValue(recordValue["type"]) ??
    stringValue(error["type"]) ??
    stringValue(cause["type"]) ??
    input.type;
  input.headers = mergeHeaders(input.headers, recordValue["headers"], response["headers"]);
  const errorBody = Object.keys(error).length > 0 ? error : undefined;
  input.body =
    recordValue["body"] ??
    recordValue["data"] ??
    recordValue["responseBody"] ??
    response["body"] ??
    response["data"] ??
    errorBody ??
    input.body;
  return input;
}

function normalizeInput(input: ModelFailureInputArg, opts: { now?: string }): ModelFailureInput {
  if (typeof input === "string" || input === undefined) {
    return { rawReason: input, message: input, now: opts.now };
  }
  return { ...input, now: input.now ?? opts.now };
}

function compactMessage(input: ModelFailureInput): string {
  return input.message?.trim() || input.rawReason?.trim() || GENERIC_MODEL_ERROR_MESSAGE;
}

function collectFields(
  input: ModelFailureInput,
  body: unknown
): {
  status?: number;
  code?: string;
  type?: string;
  name?: string;
  message?: string;
} {
  const bodyRecord = record(body);
  const error = record(bodyRecord["error"]);
  const details = record(bodyRecord["details"] ?? bodyRecord["detail"]);
  return {
    status:
      input.status ??
      numberValue(bodyRecord["status"]) ??
      numberValue(error["status"]) ??
      numberValue(details["status"]) ??
      httpStatusFromMessage(input.message ?? input.rawReason),
    code:
      input.code ??
      stringValue(bodyRecord["errorCode"]) ??
      stringValue(bodyRecord["code"]) ??
      stringValue(error["errorCode"]) ??
      stringValue(error["code"]) ??
      stringValue(details["errorCode"]) ??
      stringValue(details["code"]) ??
      stringValue(bodyRecord["reason"]) ??
      stringValue(error["reason"]),
    type:
      input.type ??
      stringValue(bodyRecord["type"]) ??
      stringValue(error["type"]) ??
      stringValue(details["type"]) ??
      stringValue(bodyRecord["status"]) ??
      stringValue(error["status"]),
    name:
      input.name ??
      stringValue(bodyRecord["name"]) ??
      stringValue(error["name"]) ??
      stringValue(details["name"]),
    message:
      input.message ??
      stringValue(bodyRecord["message"]) ??
      stringValue(error["message"]) ??
      stringValue(details["message"]),
  };
}

function httpStatusFromMessage(message: string | undefined): number | undefined {
  if (!message) return undefined;
  const match =
    message.match(/^\s*(\d{3})(?:\s|["':-])/u) ??
    message.match(/\bHTTP(?:\/\d(?:\.\d)?)?\s+(\d{3})\b/iu);
  if (!match?.[1]) return undefined;
  const status = Number(match[1]);
  return status >= 100 && status <= 599 ? status : undefined;
}

function isInfrastructureTerminal(codeKey: string, message: string): boolean {
  if (INFRASTRUCTURE_TERMINAL_CODES.has(codeKey)) return true;
  if (
    codeKey === "promptartifactinvarianterror" ||
    message.includes("Vibestudio model setup invariant failed") ||
    /^\[blobstore\.[^\]]+\] Invalid args:/u.test(message)
  ) {
    return true;
  }
  return /\b(?:caller has no sealed execution authority|has no sealed execution authority for)\b/i.test(
    message
  );
}

function codexUsageLimitMessage(
  fields: ReturnType<typeof collectFields>,
  input: ModelFailureInput,
  body: unknown,
  retryAfterMs: number | undefined
): { reason: string; resetAt?: string } | null {
  const codeKey = normalizeCode(fields.code ?? fields.type ?? fields.name);
  const bodyRecord = record(body);
  const error = record(bodyRecord["error"]);
  const message =
    stringValue(error["message"]) ??
    stringValue(bodyRecord["message"]) ??
    fields.message ??
    compactMessage(input);
  if (codeKey !== "usage_limit_reached" && !looksLikeUsageLimit(message)) return null;

  const headers = mergeHeaders(input.headers, bodyRecord["headers"], error["headers"]) ?? {};
  const limitName =
    headerValue(headers, "x-codex-bengalfox-limit-name") ??
    stringValue(bodyRecord["limit_name"]) ??
    stringValue(error["limit_name"]);
  const resetAt =
    timestampFromUnknown(error["resets_at"]) ??
    timestampFromUnknown(bodyRecord["resets_at"]) ??
    timestampFromUnknown(headerValue(headers, "x-codex-primary-reset-at")) ??
    timestampFromUnknown(headerValue(headers, "x-codex-secondary-reset-at")) ??
    (retryAfterMs !== undefined ? new Date(baseNow(input) + retryAfterMs).toISOString() : null);

  const subject = limitName ? ` for ${limitName}` : "";
  const reset = resetAt ? ` Try again after ${formatResetTime(resetAt)}.` : "";
  const readable = (readableMessage(message) || GENERIC_USAGE_LIMIT_MESSAGE).replace(/[.!?]+$/, "");
  return {
    reason: `${readable}${subject}.${reset}`,
    resetAt: resetAt ?? undefined,
  };
}

function isTerminalQuotaError(
  codeKey: string,
  status: number | undefined,
  message: string
): boolean {
  if (TERMINAL_QUOTA_CODES.has(codeKey)) return true;
  const lower = message.toLowerCase();
  if (looksLikeUsageLimit(message)) return true;
  if (/\binsufficient[_ -]?quota\b/i.test(message)) return true;
  if (/\bservice[_ -]?quota[_ -]?exceeded\b|servicequotaexceededexception/i.test(message)) {
    return true;
  }
  if (/\b(?:billing|payment|credits?|balance|spend limit)\b/i.test(message)) {
    return /\b(?:quota|limit|exhausted|insufficient|disabled|inactive|required|reached)\b/i.test(
      message
    );
  }
  if (/\b(?:daily|per day|rpd|requests per day|current quota|quota exceeded)\b/i.test(lower)) {
    return true;
  }
  return status === 402;
}

function isRetryableRateLimit(
  codeKey: string,
  status: number | undefined,
  message: string
): boolean {
  if (RETRYABLE_RATE_CODES.has(codeKey)) return true;
  if (status === 429) return true;
  return (
    /\b(?:rate limit|rate-limit|too many requests|resource exhausted|throttl\w*)\b/i.test(
      message
    ) || /\bplease retry in\s+\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds|m|min|minutes)?/i.test(message)
  );
}

function isOverloadedError(codeKey: string, status: number | undefined, message: string): boolean {
  if (OVERLOAD_CODES.has(codeKey)) return true;
  if (status === 529 || status === 503) return true;
  return /\b(?:overloaded|temporarily overloaded|capacity|service unavailable|try again later)\b/i.test(
    message
  );
}

function isCircuitBreakerOpen(message: string): boolean {
  return /\bcircuit breaker(?: is)? open\b/i.test(message);
}

function isAuthOrCredentialError(
  codeKey: string,
  status: number | undefined,
  message: string
): boolean {
  if (AUTH_CODES.has(codeKey)) return true;
  if (status === 401 || status === 403) return true;
  return /\b(?:invalid api key|token expired|expired token|unauthorized|permission denied|forbidden|authentication)\b/i.test(
    message
  );
}

function isInvalidRequestError(
  codeKey: string,
  status: number | undefined,
  message: string
): boolean {
  if (REQUEST_INVALID_CODES.has(codeKey)) return true;
  if (status === 400 || status === 404) return true;
  return /\b(?:invalid request|invalid argument|invalid schema|unsupported model|model not found)\b/i.test(
    message
  );
}

function isProviderInputShapeError(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes("model transcript invariant violated")) return true;
  if (lower.includes("no tool call found for function call output")) return true;
  return (
    /\bfunction[_ -]?call[_ -]?output\b/i.test(message) &&
    /\b(?:no matching|missing|not found|unknown)\b/i.test(message)
  );
}

function isContextOverflow(codeKey: string, message: string): boolean {
  return (
    codeKey === "request_too_large" ||
    codeKey === "context_length_exceeded" ||
    codeKey === "model_context_window_exceeded" ||
    /\b(?:context window|context length|available context size|too many tokens|token limit|prompt is too long|input token count)\b/i.test(
      message
    )
  );
}

function terminal(
  code: ModelFailureClass,
  reason: string,
  opts: { resetAt?: string } = {}
): ModelFailureInfo {
  return {
    code,
    reason: readableMessage(reason),
    recoverable: false,
    ...(opts.resetAt ? { resetAt: opts.resetAt } : {}),
  };
}

function retryable(
  code: ModelFailureClass,
  reason: string,
  retryAfterMs: number | undefined
): ModelFailureInfo {
  return {
    code,
    reason: readableMessage(reason),
    recoverable: true,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

function rateLimitMessage(message: string): string {
  const readable = readableMessage(message);
  if (!readable || readable === GENERIC_MODEL_ERROR_MESSAGE) return GENERIC_RATE_LIMIT_MESSAGE;
  return readable.length > 500 ? GENERIC_RATE_LIMIT_MESSAGE : readable;
}

function overloadMessage(message: string): string {
  const readable = readableMessage(message);
  if (!readable || readable === GENERIC_MODEL_ERROR_MESSAGE) return GENERIC_OVERLOADED_MESSAGE;
  return readable.length > 500 ? GENERIC_OVERLOADED_MESSAGE : readable;
}

function quotaMessage(message: string): string {
  const readable = readableMessage(message);
  if (!readable || readable === GENERIC_MODEL_ERROR_MESSAGE) return GENERIC_QUOTA_MESSAGE;
  return readable.length > 500 ? GENERIC_QUOTA_MESSAGE : readable;
}

function readableMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return GENERIC_MODEL_ERROR_MESSAGE;
  const embedded = parseEmbeddedJson(trimmed);
  if (!embedded) return trimmed;
  const fields = collectFields({ message: trimmed }, embedded);
  return (
    fields.message?.trim() ||
    stringValue(record(embedded)["message"]) ||
    GENERIC_MODEL_ERROR_MESSAGE
  );
}

function retryAfterFromInput(input: ModelFailureInput, body: unknown): number | undefined {
  const headers = normalizeHeaders(input.headers);
  return (
    retryAfterHeaderMs(headerValue(headers, "retry-after"), input.now) ??
    retryAfterHeaderMs(headerValue(headers, "x-retry-after"), input.now) ??
    resetHeaderMs(headerValue(headers, "x-ratelimit-reset"), input.now) ??
    resetHeaderMs(headerValue(headers, "x-rate-limit-reset"), input.now) ??
    resetHeaderMs(headerValue(headers, "anthropic-ratelimit-requests-reset"), input.now) ??
    resetHeaderMs(headerValue(headers, "anthropic-ratelimit-tokens-reset"), input.now) ??
    resetHeaderMs(headerValue(headers, "x-codex-primary-reset-at"), input.now) ??
    retryAfterHeaderMs(headerValue(headers, "x-codex-primary-reset-after-seconds"), input.now) ??
    retryAfterFromBody(body) ??
    retryAfterFromText(compactMessage(input))
  );
}

function retryAfterFromBody(body: unknown): number | undefined {
  const text = JSON.stringify(body ?? "");
  return retryAfterFromText(text);
}

function retryAfterFromText(text: string): number | undefined {
  const match = text.match(
    /\b(?:retry|try again)\s+in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?)?/i
  );
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = (match[2] ?? "s").toLowerCase();
  if (unit.startsWith("ms")) return Math.ceil(value);
  if (unit.startsWith("m") && unit !== "ms") return Math.ceil(value * 60_000);
  return Math.ceil(value * 1000);
}

function retryAfterHeaderMs(value: unknown, now: string | undefined): number | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const parsedDate = Date.parse(raw);
  if (!Number.isFinite(parsedDate)) return undefined;
  return Math.max(0, parsedDate - baseNow({ now }));
}

function resetHeaderMs(value: unknown, now: string | undefined): number | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    const ms = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    return Math.max(0, ms - baseNow({ now }));
  }
  const parsedDate = Date.parse(raw);
  if (!Number.isFinite(parsedDate)) return undefined;
  return Math.max(0, parsedDate - baseNow({ now }));
}

function boundedRetryAfter(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.max(0, Math.ceil(value));
}

function baseNow(input: { now?: string }): number {
  if (!input.now) return Date.now();
  const parsed = Date.parse(input.now);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function looksLikeUsageLimit(reason: string): boolean {
  return (
    /usage[_ -]?limit[_ -]?reached/i.test(reason) ||
    /usage limit has been reached/i.test(reason) ||
    /\b(?:you(?:'ve| have)?\s+)?hit (?:your )?(?:chatgpt )?usage limit\b/i.test(reason)
  );
}

function parseEmbeddedJson(reason: string): unknown | null {
  const start = reason.indexOf("{");
  const end = reason.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(reason.slice(start, end + 1));
  } catch {
    return null;
  }
}

function mergeBody(primary: unknown, fallback: unknown): unknown {
  if (primary === undefined || primary === null) return fallback;
  if (typeof primary === "string") return parseEmbeddedJson(primary) ?? primary;
  return primary;
}

function mergeHeaders(...values: unknown[]): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const value of values) {
    const headers = normalizeHeaders(value);
    for (const [key, entry] of Object.entries(headers)) out[key] = entry;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeHeaders(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof Headers !== "undefined" && value instanceof Headers) {
    const out: Record<string, unknown> = {};
    value.forEach((entry, key) => {
      out[key.toLowerCase()] = entry;
    });
    return out;
  }
  if (typeof (value as { forEach?: unknown }).forEach === "function") {
    const out: Record<string, unknown> = {};
    (value as { forEach: (cb: (entry: unknown, key: string) => void) => void }).forEach(
      (entry, key) => {
        out[String(key).toLowerCase()] = entry;
      }
    );
    return out;
  }
  const source = record(value);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) out[key.toLowerCase()] = entry;
  return out;
}

function headerValue(headers: Record<string, unknown>, key: string): unknown {
  return headers[key.toLowerCase()];
}

function timestampFromUnknown(value: unknown): string | null {
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ms = raw > 1_000_000_000_000 ? raw : raw * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatResetTime(value: string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const month = UTC_MONTHS[date.getUTCMonth()] ?? "Jan";
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const hour24 = date.getUTCHours();
  const hour12 = hour24 % 12 || 12;
  const period = hour24 >= 12 ? "PM" : "AM";
  return `${month} ${day}, ${year} at ${hour12}:${minute} ${period} UTC`;
}

function normalizeCode(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, "_");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
