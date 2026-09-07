/**
 * Stable runner-level error codes shared across harness entry points.
 *
 * Mirrors upstream's `AgentHarnessError` shape so external callers (the
 * worker, the dispatcher) can classify failures without sniffing message
 * strings. Throw `AgentWorkerError` from any public runner method that
 * previously threw a bare `Error`.
 */

export type AgentWorkerErrorCode =
  | "busy"
  | "invalid_state"
  | "invalid_argument"
  | "session"
  | "hook"
  | "auth"
  | "compaction"
  | "dispatch"
  | "provenance"
  | "resource_loading"
  | "runner_lifecycle"
  | "transcript_shape";

export class AgentWorkerError extends Error {
  readonly code: AgentWorkerErrorCode;

  constructor(code: AgentWorkerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "AgentWorkerError";
    this.code = code;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}
