/**
 * Worker runtime entry point for workerd workers.
 *
 * Usage:
 * ```typescript
 * import { createWorkerRuntime, handleWorkerRpc } from "@workspace/runtime/worker";
 * import type { WorkerEnv } from "@workspace/runtime/worker";
 *
 * export default {
 *   async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
 *     const runtime = createWorkerRuntime(env);
 *
 *     // Handle incoming RPC calls from other callers
 *     const rpcResponse = handleWorkerRpc(runtime, request);
 *     if (rpcResponse) return rpcResponse;
 *
 *     const content = await runtime.fs.readFile("/src/index.ts", "utf8");
 *     return new Response(content);
 *   },
 * };
 * ```
 */
import {
  createConnectionlessRpcClient,
  type ConnectionlessRpcClient,
  type RpcClient,
  type RpcEnvelope,
  type RpcRequest,
} from "@vibestudio/rpc";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { canonicalEntityId } from "@vibestudio/shared/runtime/entitySpec";
import { workerLogMethods } from "@vibestudio/service-schemas/workerLog";
import type { OpenExternalOptions, OpenExternalResult } from "@vibestudio/shared/externalOpen";
import { _initFsWithRpc } from "./fs.js";
import { createWorkerdClient } from "../shared/workerd.js";
import { createNonPanelRuntimeHandle, createRuntimeParentHandle } from "../shared/handles.js";
import { helpfulNamespace } from "../shared/helpfulNamespace.js";
import { createGatewayFetch } from "../shared/gatewayFetch.js";
import { createMainCaller } from "../shared/mainRpc.js";
import { createPanelRuntime, type PanelRuntimeApi } from "../shared/panelRuntime.js";
import {
  createHostedRuntime,
  type RuntimeHost,
  type WorkspaceRuntime,
} from "../shared/hostedRuntime.js";
import type { WorkerEnv } from "./types.js";
export type { WorkerEnv, ExecutionContext } from "./types.js";
// Portable authoring helpers (z, defineContract, Rpc, path/context helpers,
// buildPanelLink, createGatewayFetch) — identical on panel · worker · eval.
export * from "../shared/portable.js";
export type * from "../core/types.js";
export type {
  CreatePanelSlotOptions,
  OpenPanelOptions,
  PanelRuntimeTree,
} from "../shared/panelRuntime.js";
export type {
  ClientConfigStatus,
  CredentialClient,
  CredentialAccessGrantSummary,
  CredentialAccessSubjectSummary,
  CredentialStoreSummary,
  ManagedCredentialSummary,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
  ConfigureClientRequest,
  ConnectCredentialRequest,
  DeleteClientConfigRequest,
  RequestCredentialInputRequest,
  GitHttpClient,
} from "../shared/credentials.js";
export type {
  CreateWebhookIngressSubscriptionRequest,
  RotateWebhookIngressSecretRequest,
  RotateWebhookIngressSecretResult,
  WebhookDeliveredPayload,
  WebhookDeliveryConfig,
  WebhookDeliveryEvent,
  WebhookIngressClient,
  WebhookIngressSubscriptionSummary,
  WebhookPayloadFormat,
  WebhookReplayConfig,
  WebhookResponsePolicy,
  WebhookTarget,
  WebhookVerifierConfig,
} from "../shared/webhooks.js";
export type { NotificationClient } from "../shared/notifications.js";
export { doTargetId, createDurableObjectServiceClient } from "../shared/workerd.js";
export type {
  DurableObjectServiceClient,
  ResolvedWorkspaceService,
  WorkspaceServiceInfo,
  WorkerSourceInfo,
} from "../shared/workerd.js";
export type { WorkspaceClient, WorkspaceConfig, WorkspaceEntry } from "../shared/workspace.js";
export type {
  Disposable,
  ExtensionName,
  ExtensionSource,
  ExtensionsClient,
  RegistryEntry,
  WorkspaceExtensions,
} from "../shared/extensions.js";
export type * from "../shared/gad.js";
export { DurableObjectBase } from "./durable-base.js";
export { PanelDurableObjectBase } from "./panel-durable-base.js";
export { assertExactSqlTableSchema } from "./sql-table-schema.js";
// `@rpc` exposure decorator — mark a DO method as reachable over RPC (opt-in / default-deny).
import { rpc as rpcDecorator } from "@vibestudio/rpc";
export type {
  DurableObjectContext,
  SqlStorage,
  SqlResult,
  DORef,
  LifecyclePrepareInput,
  LifecyclePrepareResult,
  LifecycleResumeInput,
} from "./durable-base.js";
export { fs } from "./fs.js";
export { createRpcFs } from "../shared/rpcFs.js";
export type * from "../shared/git.js";
export type * from "../shared/vcsClient.js";
export type { WorkspaceRuntime } from "../shared/hostedRuntime.js";
// Note: createTestDO is intentionally NOT exported here because it depends on
// sql.js test-only helpers that should not be bundled into production workers.
// Import from "@workspace/runtime/worker/test-utils" in Vitest-only code.
// Cache runtime per worker ID to avoid creating multiple bridges
let cachedRuntime: WorkerRuntime | null = null;
let cachedWorkerId: string | null = null;
let workerConsoleBridgeInstalled = false;

// The worker entry is used in two different, deliberately compatible ways:
// DO implementations import the `@workspace/runtime/worker` entry for the
// `@rpc` decorator, while workspace skills import the conditional package
// root and use the connected runtime client.  A worker's env is only
// available when its fetch/DO entry is invoked, so the root exports must be
// live forwarding bindings rather than eagerly constructing a second runtime
// with missing credentials.
let activeRuntime: WorkerRuntime | null = null;
export let id = "";
export let contextId = "";
export let gatewayConfig: WorkspaceRuntime["gatewayConfig"] = null;
export let gatewayFetch: WorkspaceRuntime["gatewayFetch"] = (() => {
  throw new Error("Worker runtime has not been initialized");
}) as WorkspaceRuntime["gatewayFetch"];

function runtimeMember<K extends keyof WorkspaceRuntime>(name: K): WorkspaceRuntime[K] {
  return new Proxy(
    {},
    {
      get(_target, property) {
        const runtime = activeRuntime;
        if (!runtime) {
          throw new Error(`Worker runtime has not been initialized; cannot read ${String(name)}`);
        }
        const value = runtime[name] as unknown as Record<PropertyKey, unknown>;
        const member = value[property];
        return typeof member === "function" ? member.bind(value) : member;
      },
    }
  ) as WorkspaceRuntime[K];
}

// These are lazy only because worker modules are evaluated before the host
// has supplied WORKER_ID/GATEWAY_URL. Calls made by the module after runtime
// initialization see the real hosted clients.
export const callMain = runtimeMember("callMain");
export const parent = runtimeMember("parent");
export const getParent = runtimeMember("getParent");
export const getParentWithContract = runtimeMember("getParentWithContract");
export const gad = runtimeMember("gad");
export const blobstore = runtimeMember("blobstore");
export const workspace = runtimeMember("workspace");
export const runtime = runtimeMember("runtime");
export const credentials = runtimeMember("credentials");
export const browserData = runtimeMember("browserData");
export const git = runtimeMember("git");
export const vcs = runtimeMember("vcs");
export const webhooks = runtimeMember("webhooks");
export const extensions = runtimeMember("extensions");
export const notifications = runtimeMember("notifications");
export const workers = runtimeMember("workers");
export const openExternal = runtimeMember("openExternal");
export const createPanelSlot = runtimeMember("createPanelSlot");
export const openPanel = runtimeMember("openPanel");
export const getPanelHandle = runtimeMember("getPanelHandle");
export const panelTree = runtimeMember("panelTree");

// Preserve the decorator API for DO classes and add the connected client API
// for code importing the package root under the worker condition.
export const rpc = new Proxy(rpcDecorator as unknown as (...args: unknown[]) => unknown, {
  apply(_target, _thisArg, args) {
    return rpcDecorator(args[0] as Parameters<typeof rpcDecorator>[0]);
  },
  get(_target, property) {
    const runtime = activeRuntime;
    if (!runtime) {
      throw new Error(
        `Worker runtime has not been initialized; cannot read rpc.${String(property)}`
      );
    }
    const member = (runtime.rpc as unknown as Record<PropertyKey, unknown>)[property];
    return typeof member === "function" ? member.bind(runtime.rpc) : member;
  },
}) as typeof rpcDecorator & WorkspaceRuntime["rpc"];

function installWorkerConsoleBridge(rpc: Pick<RpcClient, "call">): void {
  if (workerConsoleBridgeInstalled) return;
  workerConsoleBridgeInstalled = true;
  const workerLogService = createTypedServiceClient("workerLog", workerLogMethods, (svc, m, a) =>
    rpc.call("main", `${svc}.${m}`, a)
  );
  const original = {
    debug: console.debug.bind(console),
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  let forwarding = false;
  const forward = (
    level: "debug" | "log" | "info" | "warn" | "error",
    args: unknown[],
    source?: string
  ): void => {
    if (forwarding) return;
    forwarding = true;
    try {
      const message = args
        .map((arg) => {
          if (typeof arg === "string") return arg;
          if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(" ");
      // Normal path: forward ONLY via workerLog — don't also print to the local console,
      // or every line double-prints in the server terminal (`[workerd]` + `[workerLog]`).
      // On forward failure (workerLog unreachable), fall back to the original console so
      // the line is never lost. `original.*` is bound pre-override ⇒ no recursion.
      workerLogService.write(level, message, source ? { source } : undefined).catch(() => {
        original[level](...args);
      });
    } finally {
      forwarding = false;
    }
  };
  const source = (globalThis as { __vibestudioWorkerSource?: string }).__vibestudioWorkerSource;
  const installSink = (
    globalThis as typeof globalThis & {
      __vibestudioInstallConsoleSink?: (
        sink: (level: "debug" | "log" | "info" | "warn" | "error", args: unknown[]) => void
      ) => void;
    }
  ).__vibestudioInstallConsoleSink;
  if (installSink) {
    installSink((level, args) => forward(level, args, source));
  } else {
    console.debug = (...args: unknown[]) => forward("debug", args, source);
    console.log = (...args: unknown[]) => forward("log", args, source);
    console.info = (...args: unknown[]) => forward("info", args, source);
    console.warn = (...args: unknown[]) => forward("warn", args, source);
    console.error = (...args: unknown[]) => forward("error", args, source);
  }
}

/**
 * The worker runtime: the portable `WorkspaceRuntime` (shared with panel + eval
 * via `createHostedRuntime`) plus worker-only target extras.
 */
export interface WorkerRuntime extends WorkspaceRuntime {
  /** Handle an incoming RPC POST body (an `RpcEnvelope`), returning the response payload. */
  handleRpcPost(body: unknown): Promise<unknown>;
  destroy(): void;
}

/**
 * Create or retrieve the worker runtime for the given environment.
 *
 * The runtime is cached per sealed worker entity identity.
 * This is important because workerd may call fetch() multiple times on the same
 * isolate, and we want to reuse the HTTP RPC bridge.
 */
export function createWorkerRuntime(env: WorkerEnv): WorkerRuntime {
  const workerId = env.WORKER_ID;
  const workerSource = env.WORKER_SOURCE;
  if (!workerId) throw new Error("Worker env must provide WORKER_ID");
  if (!workerSource) throw new Error("Worker env must provide WORKER_SOURCE");
  const selfId = canonicalEntityId({ kind: "worker", source: workerSource, key: workerId });

  // Return cached runtime if same worker
  if (cachedRuntime && cachedWorkerId === selfId) {
    return cachedRuntime;
  }

  const serverUrl = env.GATEWAY_URL;
  if (!serverUrl) {
    throw new Error("Worker env must provide GATEWAY_URL");
  }

  (globalThis as { __vibestudioWorkerSource?: string }).__vibestudioWorkerSource = workerSource;
  const parentId = (env.PARENT_ID as string) || null;
  const parentEntityId = (env.PARENT_ENTITY_ID as string) || parentId;
  const parentKind = parseParentKind(env.PARENT_KIND);

  // The unified connectionless client — same core as panel/eval, envelope-native.
  const connectionless = createConnectionlessRpcClient({
    selfId,
    serverUrl,
    authToken: env.RPC_AUTH_TOKEN,
    callerKind: "worker",
  });
  const rpc = connectionless.client;
  installWorkerConsoleBridge(rpc);

  const runtimeFs = _initFsWithRpc(rpc);
  const workers = helpfulNamespace("workers", createWorkerdClient(rpc));
  const gatewayAliases = parseGatewayAliases(env.GATEWAY_URL_ALIASES);
  const initialGatewayConfig = {
    serverUrl,
    token: env.RPC_AUTH_TOKEN,
    aliases: gatewayAliases,
  };
  // gatewayFetch is for the configured gateway, not general egress. Keep the
  // same origin guard as server-side eval so an absolute URL can still name a
  // gateway route, but a gateway bearer can never be sent to another origin.
  const initialGatewayFetch = createGatewayFetch({ ...initialGatewayConfig, relativeOnly: true });
  const callMain = createMainCaller(rpc);

  let panelRuntime!: PanelRuntimeApi;
  const resolveParent = () =>
    createRuntimeParentHandle(
      (id) => panelRuntime.getPanelHandle(id),
      parentId,
      parentEntityId,
      parentKind
    );

  panelRuntime = createPanelRuntime({
    rpc,
    selfHandle: () =>
      createNonPanelRuntimeHandle({
        id: selfId,
        parentId,
        parent: resolveParent,
      }),
    // Pass our DIRECT parent (any kind). The server resolves it to the nearest panel ANCESTOR that
    // still exists (walking the entity lineage) — so a worker whose direct parent is another worker
    // still nests its panels under the owning panel further up, matching eval. `null` (no parent) ⇒ root.
    defaultOpenParentId: parentId,
    requesterPanelId: parentKind === "panel" ? parentId : null,
    initialMetadata:
      parentKind === "panel" && parentId
        ? [
            {
              id: parentId,
              title: parentId,
              source: parentId,
              kind: "workspace",
              parentId: null,
              rpcTargetId: parentEntityId ?? parentId,
            },
          ]
        : [],
  });

  const host: RuntimeHost = {
    id: selfId,
    contextId: env.CONTEXT_ID,
    rpc,
    fs: runtimeFs,
    gatewayConfig: initialGatewayConfig,
    gatewayFetch: initialGatewayFetch,
    panelRuntime,
    workers,
    openExternal: (url: string, options?: OpenExternalOptions) =>
      callMain<OpenExternalResult>("externalOpen.openExternal", url, options),
    resolveParent,
  };
  const core = createHostedRuntime(host);

  // Worker-only infra layered on the portable surface (callMain/parent/expose
  // now come from `core` / `rpc.expose`).
  const runtime: WorkerRuntime = {
    ...core,
    handleRpcPost: (body: unknown) => handleInboundWorkerEnvelope(connectionless, body),
    destroy: () => {
      if (cachedWorkerId === selfId) {
        cachedRuntime = null;
        cachedWorkerId = null;
        activeRuntime = null;
      }
    },
  };

  activeRuntime = runtime;
  id = selfId;
  contextId = env.CONTEXT_ID;
  gatewayConfig = runtime.gatewayConfig;
  gatewayFetch = runtime.gatewayFetch;
  cachedRuntime = runtime;
  cachedWorkerId = selfId;

  return runtime;
}

/**
 * Dispatch an inbound `RpcEnvelope` (POSTed to `/__rpc`) through the converged
 * core: request envelopes return a response envelope; events deliver and ack.
 */
async function handleInboundWorkerEnvelope(
  connectionless: ConnectionlessRpcClient,
  body: unknown
): Promise<unknown> {
  const envelope = body as RpcEnvelope;
  const message = envelope?.message as RpcRequest | undefined;
  if (message?.type !== "request" && message?.type !== "stream-request") {
    connectionless.deliver(envelope);
    return {};
  }
  return (await connectionless.respond(envelope)) ?? {};
}

function parseParentKind(kind: unknown): "panel" | "worker" | "do" | null {
  return kind === "panel" || kind === "worker" || kind === "do" ? kind : null;
}

function parseGatewayAliases(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0
      );
    }
  } catch {
    // Fall through to comma-separated env syntax.
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
/**
 * Handle incoming RPC POST requests for a worker.
 *
 * Workers must wire this into their fetch handler so that the server
 * (or other callers) can invoke methods exposed via `runtime.expose()`.
 *
 * @returns A Response promise if the request is an RPC call, or null if not.
 */
export function handleWorkerRpc(
  runtime: WorkerRuntime,
  request: Request
): Promise<Response> | null {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/__rpc") && request.method === "POST") {
    return (async () => {
      const body = await request.json();
      const result = await runtime.handleRpcPost(body);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    })();
  }
  return null;
}
