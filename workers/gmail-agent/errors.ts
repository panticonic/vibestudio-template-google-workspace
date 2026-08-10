import { isGmailApiError, type GmailApiError, type GmailApiErrorCode } from "@workspace/gmail";

export const RECONNECT_ACTION = "Ask the user to reconnect Google on the Gmail card";

export interface GmailFailureContext {
  channelId: string;
  operation: string;
}

export type GmailFailureKind =
  | "auth" // reconnect required; stop polling
  | "rate-limited" // back off, honor retryAfterMs
  | "not-found" // caller reconciles (e.g. thread archived/deleted)
  | "transient" // network/server; bounded retry then surface lastError
  | "invalid"; // bad request; surface as-is

export interface GmailFailure {
  kind: GmailFailureKind;
  code: GmailApiErrorCode;
  message: string;
  operation: string;
  channelId: string;
  retryAfterMs?: number;
  /** Guidance the agent should relay instead of an opaque error string. */
  action?: string;
}

const KIND_BY_CODE: Record<GmailApiErrorCode, GmailFailureKind> = {
  "auth-expired": "auth",
  "credential-missing": "auth",
  forbidden: "invalid",
  "not-found": "not-found",
  "rate-limited": "rate-limited",
  "invalid-request": "invalid",
  network: "transient",
  server: "transient",
};

/**
 * Classify a thrown error into a structured Gmail failure. Returns null for
 * non-Gmail errors so callers rethrow them untouched.
 */
export function handleGmailError(ctx: GmailFailureContext, err: unknown): GmailFailure | null {
  if (!isGmailApiError(err)) return null;
  const apiError = err as GmailApiError;
  const kind = KIND_BY_CODE[apiError.code];
  return {
    kind,
    code: apiError.code,
    message: apiError.message,
    operation: ctx.operation,
    channelId: ctx.channelId,
    ...(apiError.retryAfterMs !== undefined ? { retryAfterMs: apiError.retryAfterMs } : {}),
    ...(kind === "auth" ? { action: RECONNECT_ACTION } : {}),
  };
}

/** Structured tool/method result for a handled Gmail failure. */
export function failureResult(failure: GmailFailure): {
  error: { code: GmailApiErrorCode; message: string; action?: string; retryAfterMs?: number };
} {
  return {
    error: {
      code: failure.code,
      message: failure.message,
      ...(failure.action ? { action: failure.action } : {}),
      ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
    },
  };
}
