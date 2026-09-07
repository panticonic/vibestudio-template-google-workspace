/**
 * Unified async tracking API for both panels and workers.
 *
 * Runtimes that support tracking publish `__vibestudioAsyncTracking__`.
 * Consumers treat its absence as tracking being unavailable.
 */

/**
 * Async tracking context returned by start().
 */
export interface TrackingContext {
  id: number;
  promises: Set<Promise<unknown>>;
  pauseCount: number;
}

/**
 * The async tracking API interface.
 * This is accessed via globalThis.__vibestudioAsyncTracking__ when a runtime
 * provides one.
 */
export interface AsyncTrackingAPI {
  /** Create a new tracking context and set it as current */
  start: () => TrackingContext;
  /** Enter an existing tracking context (set as current) */
  enter: (ctx: TrackingContext) => void;
  /** Exit the current tracking context */
  exit: () => void;
  /** Stop and destroy a context, cleaning up all references */
  stop: (ctx?: TrackingContext) => void;
  /** Pause tracking in a context (nested pause supported) */
  pause: (ctx?: TrackingContext) => void;
  /** Resume tracking in a context */
  resume: (ctx?: TrackingContext) => void;
  /** Mark a promise as ignored (never tracked in any context) */
  ignore: <T>(promise: T) => T;
  /** Wait for all promises in a context to settle */
  waitAll: (ctx?: TrackingContext) => Promise<void>;
  /** Get pending promise count for a context */
  pending: (ctx?: TrackingContext) => number;
  /** Get all active context IDs (for debugging) */
  activeContexts: () => number[];
}

/**
 * Get the async tracking API from the global scope.
 * Returns undefined if not available (not running in Vibestudio panel/worker).
 */
export function getAsyncTracking(): AsyncTrackingAPI | undefined {
  return (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"] as
    | AsyncTrackingAPI
    | undefined;
}
