import type { RpcCaller } from "@vibestudio/rpc";

export const DEFAULT_OPTIONAL_EXTENSION_TIMEOUT_MS = 15_000;

export interface OptionalExtensionInvocation {
  rpc: RpcCaller;
  extension: string;
  method: string;
  args: unknown[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Invoke an optional extension without allowing its lifecycle to stall the
 * calling tool. The caller still decides which failures are safe to recover
 * from; this boundary only guarantees cancellation and a finite settlement.
 */
export async function invokeOptionalExtension<T>({
  rpc,
  extension,
  method,
  args,
  signal,
  timeoutMs = DEFAULT_OPTIONAL_EXTENSION_TIMEOUT_MS,
}: OptionalExtensionInvocation): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        abortListener = () => {
          const error = createAbortError(signal);
          controller.abort(error);
          reject(error);
        };
        if (signal.aborted) abortListener();
        else signal.addEventListener("abort", abortListener, { once: true });
      })
    : null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new OptionalExtensionTimeoutError(extension, method, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  const invocation = rpc.call<T>("main", "extensions.invoke", [extension, method, args], {
    signal: controller.signal,
  });
  // A timed-out transport may reject after Promise.race has already settled.
  invocation.catch(() => {});

  try {
    return await Promise.race([
      invocation,
      timeoutPromise,
      ...(abortPromise ? [abortPromise] : []),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

export class OptionalExtensionTimeoutError extends Error {
  readonly code = "ETIMEOUT";

  constructor(
    readonly extension: string,
    readonly method: string,
    readonly timeoutMs: number
  ) {
    super(`${extension}.${method} timed out after ${timeoutMs}ms`);
    this.name = "OptionalExtensionTimeoutError";
  }
}

export function isOptionalExtensionTimeout(error: unknown): boolean {
  return (
    error instanceof OptionalExtensionTimeoutError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "ETIMEOUT")
  );
}

export function isOptionalExtensionUnavailable(error: unknown, extension: string): boolean {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === "ENOEXT" || code === "ENOTREADY") return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(`Extension ${extension} invocation failed: Extension is not installed`) ||
    message.includes(`Extension ${extension} invocation failed: Extension is not running`)
  );
}

export function isOptionalExtensionAbort(error: unknown): boolean {
  return (
    error instanceof Error && error.name === "AbortError" && !isOptionalExtensionTimeout(error)
  );
}

export function describeOptionalExtensionFallback(
  error: unknown,
  label: string,
  method: string
): string {
  if (isOptionalExtensionTimeout(error)) {
    const timeout = error instanceof OptionalExtensionTimeoutError ? error.timeoutMs : "configured";
    return `${label} ${method} timed out after ${timeout}ms`;
  }
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === "ENOTREADY") return `${label} extension or context not ready`;
  return `${label} extension unavailable`;
}

function createAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "Operation aborted");
  error.name = "AbortError";
  return error;
}
