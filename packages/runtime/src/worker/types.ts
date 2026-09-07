/**
 * Worker environment types for workerd bindings.
 *
 * Workers receive these as the `env` parameter in their fetch handler.
 * Vibestudio injects the RPC bindings; user workers add their own.
 */

export interface WorkerEnv {
  /** Auth token for RPC authentication */
  RPC_AUTH_TOKEN: string;
  /** Worker instance name (e.g., "hello") */
  WORKER_ID: string;
  /** Exact workspace source that, together with WORKER_ID, forms the sealed entity id. */
  WORKER_SOURCE: string;
  /** Context ID for storage partition */
  CONTEXT_ID: string;
  /** HTTP base URL for gateway server (e.g., "http://127.0.0.1:8080") */
  GATEWAY_URL: string;
  /** Additional gateway URLs that should use the internal bearer token. */
  GATEWAY_URL_ALIASES?: string | string[];
  /** Parent panel/worker ID used to seed the unified parent handle */
  PARENT_ID?: string;
  /** Parent runtime entity ID used for RPC when the parent is a panel slot */
  PARENT_ENTITY_ID?: string;
  /** Parent runtime kind used to seed the correct unified handle shape */
  PARENT_KIND?: "panel" | "worker" | "do";
  /** Initial state args (parsed object from JSON binding, if provided at instance creation) */
  STATE_ARGS?: Record<string, unknown>;
  /** User-defined bindings */
  [key: string]: unknown;
}

/**
 * workerd ExecutionContext — provided as the third argument to fetch handlers.
 */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
