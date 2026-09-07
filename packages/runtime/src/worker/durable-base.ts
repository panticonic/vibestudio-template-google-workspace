/**
 * DurableObjectBase — Tiny generic foundation for all Durable Objects.
 *
 * Only what every DO needs: context, SQL, schema versioning, state KV,
 * alarm support, HTTP dispatch, WebSocket upgrade stub, and hibernation hooks.
 *
 * Agent-specific concerns (harnesses, turns, subscriptions, streams) live
 * in @workspace/agentic-do — composable modules that extend this base.
 */

import {
  createTypedServiceClient,
  type MethodSchema,
  type ServiceMethodSchemas,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import { runtimeMethods } from "@vibestudio/service-schemas/runtime";
import { workerLogMethods } from "@vibestudio/service-schemas/workerLog";
import { workspaceStateMethods } from "@vibestudio/service-schemas/workspaceState";
import type {
  DoAlarmSchedule,
  LifecyclePrepareInput,
  LifecyclePrepareResult,
  LifecycleResumeInput,
} from "@vibestudio/shared/doDispatcher";
export type {
  LifecyclePrepareInput,
  LifecyclePrepareResult,
  LifecycleResumeInput,
} from "@vibestudio/shared/doDispatcher";
import {
  collectExposableMethods,
  envelopeFromMessage,
  rpcExposedMethodNames,
  rpcErrorDataOf,
  rpcErrorKindOf,
  rpcMethodAuthority,
  rpc,
  type ConnectionlessRpcClient,
  type RpcClient,
  type RpcEnvelope,
  type RpcEvent,
  type RpcRequest,
  type ResolvedRpcAuthority,
} from "@vibestudio/rpc";
import type { AuthorizationContext } from "@vibestudio/rpc";
import {
  DurableDirectRpcNonceLedger,
  directRpcInvalidAttestationFailure,
  directRpcDenial,
  directRpcInvocationResourceKey,
  eventIntakeAuthority,
  hostControlDenial,
  type DirectRpcDenial,
  type EventIntakeRule,
  type HostControlDenial,
} from "@vibestudio/shared/directRpcEnforcement";
import {
  createCredentialClient,
  type CredentialClient,
} from "../shared/credentials.js";
import {
  createNotificationClient,
  type NotificationClient,
} from "../shared/notifications.js";
import { _initFsWithRpc } from "./fs.js";
import type { AuthenticatedCaller } from "@vibestudio/rpc";
import {
  DIRECT_AUTHORITY_ACCEPTED_AT_HEADER,
  createCausalRpcOperationTracker,
  createInternalConnectionlessRpcClient,
  type AttestedCaller,
} from "@vibestudio/rpc/internal";
import type { RuntimeFs } from "../types.js";
import {
  acceptResidentChannelDelivery,
  acceptResidentChannelInvocation,
  cancelResidentChannelInvocation,
  inspectResidentSessions,
  registerResidentSession,
  type ResidentChannelDeliveryInput,
  type ResidentChannelInvocationInput,
  type ResidentChannelCancellationInput,
  type ResidentSessionReceiver,
} from "@vibestudio/shared/residentSession";
import {
  bindMethodCapability,
  allOf,
  anyOf,
  capability,
} from "@vibestudio/shared/authorization";
import {
  DURABLE_WORK_READY_HEADER,
  encodeDurableWorkReady,
  type DurableWorkQueue,
} from "@vibestudio/shared/durableWork";
import {
  dispatchWithDurableObjectSchemaGuard,
  durableObjectSchemaDescriptor,
  installDurableObjectSchema,
  validateDurableObjectSchemaIndexes,
} from "@vibestudio/durable/schema";
import { DurableWorkReadiness, InvocationContext } from "@vibestudio/durable";

interface RpcInvocationContext {
  verifiedCaller: AttestedCaller | null;
  /** False once the inbound invocation has returned, even though
   * AsyncLocalStorage may still be present in deferred work it spawned. */
  authorityActive: boolean;
  callerId: string | null;
  callerKind: string | null;
  callerPanelId: string | null;
  requestId: string | null;
  idempotencyKey: string | null;
  readyQueues: Set<DurableWorkQueue>;
}

// ---------------------------------------------------------------------------
// Console bridge — forwards DO console.* output to the server terminal.
//
// workerd's native console routing does not reliably surface DO logs to the
// embedding process's stdout/stderr, which makes swallowed errors inside DOs
// invisible during development. The bridge installs a proxy that, in
// addition to the local console.*, fires a best-effort `workerLog.write`
// RPC to the server. The server's `workerLog` service prefixes the caller
// DO's identity and prints through dev-log, so lines appear in the main
// terminal as `[server] [workerLog] [do:<src>:<cls>:<key>] <level>: <msg>`.
//
// Installed at most once per isolate via a module-local guard. The bridged
// handlers route their own failure logs back to the original console to
// avoid recursion.
// ---------------------------------------------------------------------------

let consoleBridgeInstalled = false;

function directAuthorityAcceptedAt(request: Request): number {
  const raw = request.headers.get(DIRECT_AUTHORITY_ACCEPTED_AT_HEADER);
  if (raw !== null) {
    const acceptedAt = Number(raw);
    if (Number.isFinite(acceptedAt) && acceptedAt > 0) return acceptedAt;
  }
  // Direct unit harnesses do not run through the authenticated workerd router;
  // retaining receipt-time evaluation keeps that path strictly shorter-lived.
  return Date.now();
}

function installConsoleBridge(rpc: Pick<RpcClient, "call">): void {
  if (consoleBridgeInstalled) return;
  consoleBridgeInstalled = true;
  const workerLogService = createTypedServiceClient(
    "workerLog",
    workerLogMethods,
    (svc, m, a) => rpc.call("main", `${svc}.${m}`, a),
  );
  const original = {
    debug: console.debug.bind(console),
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  // Re-entrancy guard: if the RPC path itself logs (directly or via a
  // downstream library), the proxy would recurse. Keep forwards suppressed
  // while one is in-flight on the same synchronous stack.
  let forwarding = false;
  const forward = (
    level: "debug" | "log" | "info" | "warn" | "error",
    args: unknown[],
  ): void => {
    if (forwarding) return;
    forwarding = true;
    let message: string;
    try {
      message = args
        .map((a) => {
          if (typeof a === "string") return a;
          if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ");
    } catch {
      message = "<unserializable>";
    }
    try {
      // Normal path: forward ONLY via workerLog (the contextful `[do:<id>]` line). Do NOT
      // also print to the local console, or every DO line double-prints in the server
      // terminal (once as `[workerd]` from stdout, once as `[workerLog]`). If the forward
      // fails (workerLog unreachable — early boot, server down), fall back to the original
      // console so the line is never lost. `original.*` is bound pre-override ⇒ no recursion.
      workerLogService.write(level, message).catch(() => {
        original[level](...args);
      });
    } finally {
      forwarding = false;
    }
  };
  const installSink = (
    globalThis as typeof globalThis & {
      __vibestudioInstallConsoleSink?: (
        sink: (
          level: "debug" | "log" | "info" | "warn" | "error",
          args: unknown[],
        ) => void,
      ) => void;
    }
  ).__vibestudioInstallConsoleSink;
  if (installSink) {
    installSink(forward);
  } else {
    console.debug = (...args: unknown[]) => forward("debug", args);
    console.log = (...args: unknown[]) => forward("log", args);
    console.info = (...args: unknown[]) => forward("info", args);
    console.warn = (...args: unknown[]) => forward("warn", args);
    console.error = (...args: unknown[]) => forward("error", args);
  }
}

// Minimal types for workerd DurableObject context (cannot import cloudflare:workers in Node)

export interface DurableObjectContext {
  id: { toString(): string; name?: string };
  storage: {
    sql: SqlStorage;
    setAlarm(scheduledTime: number | Date): void;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): void;
    /**
     * Run a synchronous block inside a DO storage transaction. Workerd
     * rejects raw `BEGIN`/`COMMIT` SQL and requires this API instead — it
     * auto-rolls-back on thrown exceptions and coalesces with the DO's
     * atomic-write semantics. The callback must be synchronous.
     */
    transactionSync<T>(callback: () => T): T;
  };
  // Tagged accept: tags survive hibernation, retrievable via getWebSockets(tag)
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  // Retrieve by tag, or all if no tag
  getWebSockets(tag?: string): WebSocket[];
  // Run async init during construction or upgrade (blocks other events)
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  // Keep background work alive after an RPC/fetch handler returns.
  waitUntil?(promise: Promise<unknown>): void;
}

export interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlResult;
}

export interface SqlResult {
  toArray(): Record<string, unknown>[];
  one(): Record<string, unknown>;
}

/** Typed authoring facade over the raw workerd SQL cursor. */
export interface TypedSqlStorage {
  exec<Row extends object = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): {
    toArray(): Row[];
    one(): Row;
  };
}

export interface DORef {
  source: string;
  className: string;
  objectKey: string;
}

// (RPC exposure is now opt-in via `@rpc` + `rpcExposedMethodNames` — no reserved deny-list needed;
// framework/lifecycle methods are simply never `@rpc`-marked, and the base-proto boundary backstops.)

export abstract class DurableObjectBase {
  protected ctx: DurableObjectContext;
  protected sql: TypedSqlStorage;
  protected env: Record<string, unknown>;

  private _schemaReady = false;
  private _schemaInstalled = false;
  private _schemaPreparationError: unknown = null;
  private _connectionless: ConnectionlessRpcClient | null = null;
  private readonly _directRpcNonces: DurableDirectRpcNonceLedger;
  protected _currentRpcCallerId: string | null = null;
  protected _currentRpcCallerKind: string | null = null;
  protected _currentRpcCallerPanelId: string | null = null;
  protected _currentRpcRequestId: string | null = null;
  protected _currentRpcIdempotencyKey: string | null = null;
  private _currentVerifiedCaller: AttestedCaller | null = null;
  private readonly _invocationContext =
    new InvocationContext<RpcInvocationContext>();
  private readonly _causalRpcOperations = createCausalRpcOperationTracker(
    () => this.activeInvocationContext ?? undefined,
  );
  private _credentials: CredentialClient | null = null;
  private _notifications: NotificationClient | null = null;
  private _fs: RuntimeFs | null = null;
  private readonly _durableWorkReadiness: DurableWorkReadiness;

  constructor(ctx: DurableObjectContext, env: unknown) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql as TypedSqlStorage;
    this._directRpcNonces = new DurableDirectRpcNonceLedger({
      exec: (query, ...bindings) => this.sql.exec(query, ...bindings),
      transactionSync: (callback) => this.ctx.storage.transactionSync(callback),
    });
    this.env = env as Record<string, unknown>;
    this._durableWorkReadiness = new DurableWorkReadiness(
      {
        get: (key) => this.getStateValue(key),
        set: (key, value) => this.setStateValue(key, value),
        transaction: (callback) => this.ctx.storage.transactionSync(callback),
      },
      crypto.randomUUID(),
    );
    // Schema is NOT initialized here — deferred to first fetch()/alarm().
    // This avoids the init-order bug where createTables() would be called
    // during super() before subclass fields are initialized.
  }

  // --- Schema (lazy init, enforced automatically) ---

  static schemaVersion = 1;
  static eventIntake: readonly EventIntakeRule[] = [];
  static rpcMethods?: ServiceMethodSchemas;

  /** Subclasses define their SQL tables here. Called during schema init. */
  protected abstract createTables(): void;

  /** Activation-local initialization that requires the committed schema. */
  protected afterSchemaReady(): void {}

  protected rpcSchemaCodeSource(
    _method: string,
    _wireMethod: MethodSchema,
  ): string | null {
    return null;
  }

  protected rpcAuthorityDeclaration(
    method: string,
    wireMethod: MethodSchema | undefined,
  ): ResolvedRpcAuthority | null {
    if (!wireMethod) return rpcMethodAuthority(this, method) ?? null;
    const authority = wireMethod.authority;
    const tier = wireMethod.tier;
    const sensitivity = wireMethod.access?.sensitivity;
    const methodCapability = wireMethod.capability;
    if (!authority || !tier || !sensitivity) {
      throw new Error(
        `${this.constructor.name}.${method} has an incomplete typed receiver authority declaration`,
      );
    }
    const effect = wireMethod.directEffect;
    if (!effect && !methodCapability) {
      throw new Error(
        `${this.constructor.name}.${method} has an incomplete typed receiver authority declaration`,
      );
    }
    const resolvedEffect =
      effect ??
      ({
        kind: "host-capability" as const,
        capability: methodCapability!,
        resource: { kind: "receiver-object" as const },
      } as const);
    if (!("principals" in authority)) {
      if (!methodCapability) {
        throw new Error(
          `${this.constructor.name}.${method} has an incomplete typed receiver authority declaration`,
        );
      }
      if (authority.additional?.length || authority.prepared) {
        throw new Error(
          `${this.constructor.name}.${method} uses host-service-only prepared authority`,
        );
      }
      return {
        requires: bindMethodCapability(authority.requirement, methodCapability),
        effect: resolvedEffect,
        tier: tier.tier,
        sensitivity,
        ...(tier.session === "codeOnly" ? { codeOnly: true } : {}),
        ...(wireMethod.crossWorkspace === true ? { crossWorkspace: true } : {}),
      };
    }
    const codeSource = this.rpcSchemaCodeSource(method, wireMethod);
    if (!codeSource || !authority.principals.includes("code")) {
      return {
        principals: authority.principals,
        effect: resolvedEffect,
        tier: tier.tier,
        sensitivity,
        ...(tier.session === "codeOnly" ? { codeOnly: true } : {}),
        ...(wireMethod.crossWorkspace === true ? { crossWorkspace: true } : {}),
      };
    }
    const unconstrained = authority.principals.filter(
      (principal) => principal !== "code",
    );
    if (!methodCapability) {
      throw new Error(
        `${this.constructor.name}.${method} has an incomplete typed receiver authority declaration`,
      );
    }
    return {
      requires: anyOf(
        ...unconstrained.map((principal) =>
          capability(principal, methodCapability),
        ),
        allOf(capability("code", methodCapability), {
          kind: "relationship",
          name: "code-source",
          value: codeSource,
        }),
      ),
      effect: resolvedEffect,
      tier: tier.tier,
      sensitivity,
      ...(tier.session === "codeOnly" ? { codeOnly: true } : {}),
      ...(wireMethod.crossWorkspace === true ? { crossWorkspace: true } : {}),
    };
  }

  /** Tables that must exist before a schema version is recorded as ready. */
  protected requiredTables(): readonly string[] {
    return [];
  }

  protected schemaIndexDefinitions(): readonly string[] | undefined {
    return undefined;
  }

  protected validateSchema(): void {
    const missing = this.requiredTables().filter((table) => {
      const rows = this.sql
        .exec(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
          table,
        )
        .toArray();
      return rows.length === 0;
    });
    if (missing.length > 0) {
      throw new Error(
        `${this.constructor.name} schema validation failed: missing table(s): ${missing.join(", ")}`,
      );
    }
    const indexes = this.schemaIndexDefinitions();
    if (indexes)
      validateDurableObjectSchemaIndexes(
        this.sql,
        this.requiredTables(),
        indexes,
      );
  }

  /**
   * Lazily called on first fetch() or alarm(). Safe for subclasses to call
   * earlier from their constructor if they need schema before first request.
   */
  protected ensureReady(): void {
    if (this._schemaPreparationError !== null) {
      const error = this._schemaPreparationError;
      this._schemaPreparationError = null;
      throw error;
    }
    if (this._schemaReady) return;
    if (!this._schemaInstalled) {
      this.ensureSchema();
      this._schemaInstalled = true;
    }
    if (this.env["VIBESTUDIO_SCHEMA_PROBE"] !== true) this.afterSchemaReady();
    this._schemaReady = true; // only after success — allows retry on next request if init throws
  }

  /** Install schema storage before subclass helpers can create or query tables. */
  protected prepareSchemaStorage(): void {
    if (this._schemaInstalled) return;
    try {
      this.ensureSchema();
      this._schemaInstalled = true;
    } catch (error) {
      this._schemaPreparationError = error;
    }
  }

  /**
   * Establish constructor-time schema invariants without letting a refusal
   * escape workerd's request error boundary. The first request observes a
   * captured failure through ensureReady(); a later request may retry.
   */
  protected prepareSchemaForActivation(): void {
    try {
      this.ensureReady();
    } catch (error) {
      this._schemaPreparationError = error;
    }
  }

  private schemaDescriptorResponse(): Response {
    return Response.json(
      durableObjectSchemaDescriptor({
        className: String(
          this.env["WORKER_CLASS_NAME"] ?? this.constructor.name,
        ),
        version: (this.constructor as typeof DurableObjectBase).schemaVersion,
        storage: this.ctx.storage,
        schemaTables: this.requiredTables(),
        createSchema: () => this.createTables(),
        validateSchema: () => this.validateSchema(),
      }),
    );
  }

  private ensureSchema(): void {
    installDurableObjectSchema({
      className: String(this.env["WORKER_CLASS_NAME"] ?? this.constructor.name),
      version: (this.constructor as typeof DurableObjectBase).schemaVersion,
      storage: this.ctx.storage,
      schemaTables: this.requiredTables(),
      createSchema: () => this.createTables(),
      validateSchema: () => this.validateSchema(),
    });
  }

  // --- State KV (generic, always available) ---

  protected getStateValue(key: string): string | null {
    const row = this.sql
      .exec(`SELECT value FROM state WHERE key = ?`, key)
      .toArray();
    return row.length > 0 ? (row[0]!["value"] as string) : null;
  }

  protected setStateValue(key: string, value: string): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)`,
      key,
      value,
    );
  }

  protected deleteStateValue(key: string): void {
    this.sql.exec(`DELETE FROM state WHERE key = ?`, key);
  }

  // Authority continuation belongs to each caller's domain outbox. The runtime
  // base intentionally exposes only ordinary RPC; it stores no generic
  // continuations or host-process callbacks.

  /** Parse a POST body into positional method arguments. */
  private parseRequestBody(body: string): {
    args: unknown[];
    error?: string;
    caller?: AttestedCaller | null;
  } {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      return { args: parsed };
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      ("__instanceToken" in parsed || "__instanceId" in parsed) &&
      Array.isArray((parsed as { args?: unknown }).args)
    ) {
      const caller = (parsed as { __caller?: unknown }).__caller;
      if (caller && typeof caller === "object") {
        const record = caller as Record<string, unknown>;
        if (
          typeof record["callerId"] === "string" &&
          typeof record["callerKind"] === "string"
        ) {
          return {
            args: (parsed as { args: unknown[] }).args,
            caller: {
              callerId: record["callerId"],
              callerKind: record[
                "callerKind"
              ] as AuthenticatedCaller["callerKind"],
              ...(typeof record["callerPanelId"] === "string"
                ? { callerPanelId: record["callerPanelId"] }
                : {}),
              ...(typeof record["userId"] === "string"
                ? { userId: record["userId"] }
                : {}),
              ...(record["authorization"] &&
              typeof record["authorization"] === "object"
                ? {
                    authorization: record[
                      "authorization"
                    ] as AttestedCaller["authorization"],
                  }
                : {}),
            } as AttestedCaller,
          };
        }
      }
      return {
        args: (parsed as { args: unknown[] }).args,
      };
    }
    return { args: [parsed] };
  }

  // --- RPC bridge + shared clients (lazy) ---

  /**
   * RPC bridge — the unified connectionless `createRpcClient` core (envelope
   * transport). The DO's public methods are `exposeAll`'d onto
   * it so inbound request envelopes dispatch to the class method via the shared
   * `handleEnvelope`; `respond`/`deliver` are wired in `fetch`.
   */
  protected get rpc(): RpcClient {
    return this.connectionlessClient().client;
  }

  private connectionlessClient(): ConnectionlessRpcClient {
    if (!this._connectionless) {
      const token = this.env["RPC_AUTH_TOKEN"];
      if (typeof token !== "string" || token.length === 0) {
        throw new Error("RPC not available: RPC_AUTH_TOKEN not configured");
      }
      const source = this.env["WORKER_SOURCE"];
      const className = this.env["WORKER_CLASS_NAME"];
      if (typeof source !== "string" || source.length === 0) {
        throw new Error("RPC not available: WORKER_SOURCE not configured");
      }
      if (typeof className !== "string" || className.length === 0) {
        throw new Error("RPC not available: WORKER_CLASS_NAME not configured");
      }
      const serverUrl = this.env["GATEWAY_URL"] as string;
      if (!serverUrl) {
        throw new Error("RPC not available: GATEWAY_URL not configured");
      }
      const connectionless = createInternalConnectionlessRpcClient({
        selfId: `do:${source}:${className}:${this.objectKey}`,
        serverUrl,
        authToken: token,
        callerKind: "do",
        // Continue only the currently executing host-attested invocation.
        // The callback is evaluated per outbound envelope; once inbound
        // dispatch restores its caller, alarms and later work carry no nonce.
        authorityParentNonce: () =>
          this.activeInvocationContext?.verifiedCaller?.authorization?.nonce,
        onOutboundOperation: this._causalRpcOperations.observe,
      });
      // Expose ONLY this DO's `@rpc`-marked methods (opt-in / default-deny). Private/protected helpers
      // and all framework plumbing (`dispatchInboundEnvelope`, state KV, panel/alarm helpers) are
      // unreachable over the open relay; a forgotten `@rpc` fails loud ("not exposed").
      connectionless.client.exposeAll(
        // The framework base itself contains intentionally public, @rpc-marked
        // lifecycle/capability methods. The decorator allow-list is the security
        // boundary; stopping before DurableObjectBase would make those methods
        // impossible to call on every subclass.
        collectExposableMethods(
          this,
          rpcExposedMethodNames(this),
          Object.prototype,
        ),
      );
      this._connectionless = connectionless;
      // Bridge DO `console.*` to the server terminal. Installed lazily on
      // first rpc access — constructor-time logs are still local-only, but
      // steady-state errors reach the main terminal.
      installConsoleBridge(connectionless.client);
    }
    return this._connectionless;
  }

  /** OAuth client for token access */
  protected get credentials(): CredentialClient {
    if (!this._credentials)
      this._credentials = createCredentialClient(this.rpc);
    return this._credentials;
  }

  /** Notification client for shell notifications */
  protected get notifications(): NotificationClient {
    if (!this._notifications)
      this._notifications = createNotificationClient(this.rpc);
    return this._notifications;
  }

  /** Filesystem client */
  protected get fs(): RuntimeFs {
    if (!this._fs) this._fs = _initFsWithRpc(this.rpc);
    return this._fs;
  }

  protected get rpcCallerId(): string | null {
    const context = this._invocationContext.current();
    return context ? context.callerId : this._currentRpcCallerId;
  }

  protected get rpcCallerKind(): string | null {
    const context = this._invocationContext.current();
    return context ? context.callerKind : this._currentRpcCallerKind;
  }

  /**
   * The authenticated caller of the in-flight method, in the canonical
   * `AuthenticatedCaller` shape shared with the bridge and server. Sourced from
   * the signed `X-vibestudio-Rpc-Caller-*` headers the server injects. Null when
   * there is no active RPC caller (e.g. alarm/lifecycle). Prefer this over the
   * raw `rpcCallerId`/`rpcCallerKind` pair for authorization checks.
   */
  protected get caller(): AuthenticatedCaller | null {
    if (this.activeVerifiedCaller) {
      const caller = this.activeVerifiedCaller;
      return {
        callerId: caller.callerId,
        callerKind: caller.callerKind,
        ...(caller.callerPanelId
          ? { callerPanelId: caller.callerPanelId }
          : {}),
        ...(caller.userId ? { userId: caller.userId } : {}),
      };
    }
    if (this._invocationContext.current()) return null;
    const callerId = this._currentRpcCallerId;
    if (!callerId) return null;
    return {
      callerId,
      callerKind:
        (this._currentRpcCallerKind as AuthenticatedCaller["callerKind"]) ??
        "unknown",
      ...(this._currentRpcCallerPanelId
        ? { callerPanelId: this._currentRpcCallerPanelId }
        : {}),
    };
  }

  /** Complete host-attested facts for the active direct dispatch. */
  protected get authorization(): AuthorizationContext | null {
    return this.activeVerifiedCaller?.authorization?.context ?? null;
  }

  protected get rpcCallerPanelId(): string | null {
    const context = this._invocationContext.current();
    return context ? context.callerPanelId : this._currentRpcCallerPanelId;
  }

  /** Correlation id of the inbound call, when the caller stamped one. */
  protected get rpcRequestId(): string | null {
    const context = this._invocationContext.current();
    return context ? context.requestId : this._currentRpcRequestId;
  }

  /** Dedup key of the inbound call, when the caller stamped one. */
  protected get rpcIdempotencyKey(): string | null {
    const context = this._invocationContext.current();
    return context ? context.idempotencyKey : this._currentRpcIdempotencyKey;
  }

  /** Last value pushed via `setOwnTitle` during this activation. Used to
   *  dedupe redundant `runtime.setTitle` RPCs. Persists only across method
   *  calls within one isolate; on hibernation it resets. */
  private _titleSetForThisActivation: string | null = null;
  /**
   * A DO can be constructed while its runtime entity is still being prepared.
   * Constructor-time title setters therefore run before the WorkspaceDO row is
   * mirrored into the host principal cache. Keep the desired title until the
   * first authenticated ordinary request instead of sending a request that can
   * only fail with "Unknown principal kind".
   */
  private _pendingOwnTitle: { value: string | null; explicit: boolean } | null =
    null;

  /** Persistent state key used to record explicit (tool-driven) title sets.
   *  When this key is "1" the heuristic first-message fallback in chat agents
   *  is suppressed so explicit titles survive hibernation/restart. */
  private static readonly EXPLICIT_TITLE_STATE_KEY = "__title_explicit";

  protected get titleSetForThisActivation(): string | null {
    return this._titleSetForThisActivation;
  }

  /**
   * Returns true iff a previous activation called `setOwnTitleExplicitly`.
   * Heuristic title setters (e.g. chat agents' first-user-message fallback)
   * should bail when this is true so a user-confirmed title isn't overwritten.
   */
  protected isOwnTitleExplicitlySet(): boolean {
    try {
      return (
        this.getStateValue(DurableObjectBase.EXPLICIT_TITLE_STATE_KEY) === "1"
      );
    } catch {
      // `state` table may not exist before the first ensureReady — read
      // returning false is the safe default (no explicit title yet).
      return false;
    }
  }

  /**
   * Set the title and durably record that an explicit setter (e.g. the
   * built-in `set_title` agent tool) chose it. Subsequent activations check
   * `isOwnTitleExplicitlySet` before running any heuristic fallback.
   */
  protected async setOwnTitleExplicitly(
    title: string | null | undefined,
  ): Promise<void> {
    await this.setOwnTitle(title, { explicit: true });
    try {
      this.ensureReady();
      this.setStateValue(DurableObjectBase.EXPLICIT_TITLE_STATE_KEY, "1");
    } catch (err) {
      console.warn(
        "[DurableObjectBase] failed to persist explicit-title flag:",
        err,
      );
    }
  }

  /**
   * Set the server-controlled display title for this entity. Approval UIs
   * (and any other surface that resolves an entity by id) show this in
   * place of the opaque id. Best-effort — failures log a warning and do
   * not throw. Pass null/empty to clear.
   *
   * This is the heuristic / non-persisting setter — use
   * `setOwnTitleExplicitly` when an explicit tool call drives the change.
   */
  protected async setOwnTitle(
    title: string | null | undefined,
    options: { explicit?: boolean } = {},
  ): Promise<void> {
    const normalized = title == null ? null : title.trim();
    const effective = normalized && normalized.length > 0 ? normalized : null;
    if (effective === this._titleSetForThisActivation) return;
    this._titleSetForThisActivation = effective;

    // A constructor (or another activation callback before the first request)
    // has no authenticated inbound invocation yet. The entity activation that
    // owns this DO is still in flight, so defer the host call until the first
    // ordinary request after that activation commits.
    if (
      !this._invocationContext.current() &&
      this._currentRpcCallerId === null
    ) {
      this._pendingOwnTitle = {
        value: effective,
        explicit: options.explicit === true,
      };
      return;
    }

    await this.sendOwnTitle(effective, options.explicit === true);
  }

  /** Flush a constructor-time title after runtime entity activation. */
  private async flushPendingOwnTitle(): Promise<void> {
    const pending = this._pendingOwnTitle;
    if (!pending) return;
    this._pendingOwnTitle = null;
    await this.sendOwnTitle(pending.value, pending.explicit);
  }

  private async sendOwnTitle(
    effective: string | null,
    explicit: boolean,
  ): Promise<void> {
    let bridge: Pick<RpcClient, "call">;
    try {
      bridge = this.rpc;
    } catch (err) {
      // `this.rpc` throws when the workerd env bindings aren't ready yet —
      // typical during constructor-time calls before the first request has
      // attached the RPC token. Skip silently; setOwnTitle will be retried
      // on the next caller (request, alarm, RPC handler).
      void err;
      return;
    }
    // Test harnesses point GATEWAY_URL at an unreachable sentinel; emit no
    // noise when the RPC fails in that mode. Real installs surface failures.
    const gatewayUrl = String(this.env["GATEWAY_URL"] ?? "");
    const isTestSentinel =
      gatewayUrl.includes("test-server.invalid") ||
      gatewayUrl.includes(".test/");
    const runtimeService = createTypedServiceClient(
      "runtime",
      runtimeMethods,
      (svc, m, a) => bridge.call("main", `${svc}.${m}`, a),
    );
    try {
      await runtimeService.setTitle(effective, { explicit });
    } catch (err) {
      if (!isTestSentinel) {
        console.warn("[DurableObjectBase] runtime.setTitle failed:", err);
      }
    }
  }

  // --- Object key identity ---
  // Set from the first fetch() request URL: /{objectKey}/{method}
  // The router includes the objectKey in the forwarded URL.

  private _objectKey: string | null = null;

  protected get objectKey(): string {
    if (this._objectKey) return this._objectKey;
    // Fallback to ctx.id.name (available in some workerd versions)
    const name = this.ctx.id.name;
    if (name) {
      this._objectKey = name;
      return name;
    }
    // Fallback to persisted state (survives hibernation)
    try {
      const stored = this.sql
        .exec(`SELECT value FROM state WHERE key = '__objectKey'`)
        .toArray();
      if (stored.length > 0) {
        this._objectKey = stored[0]!["value"] as string;
        return this._objectKey;
      }
    } catch {
      /* state table may not exist yet */
    }
    throw new Error(
      "objectKey not available — no request received yet and ctx.id.name not set",
    );
  }

  /** Concrete immutable runtime identity presented by this object on outbound RPC. */
  protected get rpcSelfId(): string {
    return `do:${String(this.env["WORKER_SOURCE"] ?? "")}:${String(
      this.env["WORKER_CLASS_NAME"] ?? this.constructor.name,
    )}:${this.objectKey}`;
  }

  // --- Alarm (server-driven; persists across workerd/server restarts) ---
  //
  // workerd does not implement alarms for SQLite-backed Durable Objects (and
  // never for facets), so the wake time is registered durably with the server
  // (WorkspaceDO `do_alarms`) and the server's AlarmDriver fires `__alarm` on
  // schedule. Ordinary calls keep the synchronous `ctx.storage.setAlarm`
  // shape, while fetch() drains the tracked relay writes before returning so
  // the wake is durable across immediate hibernation/eviction. Alarm handlers
  // instead return their complete next scheduling decision to AlarmDriver.

  protected setAlarm(delayMs: number): void {
    this.setAlarmAt(Date.now() + delayMs);
  }

  /** Schedule the alarm at an absolute epoch-ms time. */
  protected setAlarmAt(timeMs: number): void {
    this.trackAlarmRpc(this.persistAlarmSchedule({ wakeAt: timeMs }));
  }

  /** Cancel any pending alarm for this DO. */
  protected deleteAlarm(): void {
    this.trackAlarmRpc(this.persistAlarmSchedule(null));
  }

  /** Persist an exact alarm projection from activation-owned work which has
   * no later fetch-finally drain boundary. */
  protected async persistAlarmSchedule(
    schedule: DoAlarmSchedule | null,
  ): Promise<void> {
    if (schedule) {
      await this.workspaceStateService.alarmSet({
        ...this.lifecycleKey(),
        wakeAt: schedule.wakeAt,
      });
      return;
    }
    await this.workspaceStateService.alarmClear(this.lifecycleKey());
  }

  private readonly pendingAlarmRpcs = new Set<Promise<void>>();

  private trackAlarmRpc(pending: Promise<void>): void {
    this.pendingAlarmRpcs.add(pending);
  }

  private async drainAlarmRpcs(): Promise<void> {
    while (this.pendingAlarmRpcs.size > 0) {
      const pending = [...this.pendingAlarmRpcs];
      try {
        await Promise.all(pending);
      } finally {
        for (const settled of pending) this.pendingAlarmRpcs.delete(settled);
      }
    }
  }

  private lifecycleKey(): {
    source: string;
    className: string;
    objectKey: string;
  } {
    return {
      source: String(this.env["WORKER_SOURCE"] ?? ""),
      className: String(this.env["WORKER_CLASS_NAME"] ?? this.constructor.name),
      objectKey: this.objectKey,
    };
  }

  /**
   * Typed client for the workspace-state service. Built lazily — the call
   * function dereferences `this.rpc` per call, so constructing the client
   * never touches the (possibly not-yet-ready) RPC bridge.
   */
  private _workspaceStateService?: TypedServiceClient<
    typeof workspaceStateMethods
  >;

  private get workspaceStateService(): TypedServiceClient<
    typeof workspaceStateMethods
  > {
    return (this._workspaceStateService ??= createTypedServiceClient(
      "workspace-state",
      workspaceStateMethods,
      (svc, m, a) => this.rpc.call("main", `${svc}.${m}`, a),
    ));
  }

  /** Override in subclasses for timed callbacks. Return the one exact next wake. */
  async alarm(): Promise<DoAlarmSchedule | null> {
    this.ensureReady();
    const queues = this.pendingDurableWorkReadyQueues();
    if (queues.length > 0) this.emitWorkReadyHint(...queues);
    return null;
  }

  /**
   * Project durable/domain scheduling facts after an ordinary request.
   *
   * `undefined` means this class does not own a derived schedule. `null`
   * explicitly clears the alarm. Alarm delivery bypasses this hook because an
   * alarm returns the same projection directly to AlarmDriver.
   */
  protected nextAlarmAfterRequest(): DoAlarmSchedule | null | undefined {
    return undefined;
  }

  // --- HTTP dispatch + WebSocket upgrade ---

  async fetch(request: Request): Promise<Response> {
    try {
      const segments = new URL(request.url).pathname.split("/").filter(Boolean);
      if (segments.length >= 1 && !this._objectKey) {
        this._objectKey = decodeURIComponent(segments[0]!);
      }
      const objectKey = this._objectKey ?? this.ctx.id.name;
      if (!objectKey)
        throw new Error("Durable Object request has no exact object key");
      return await dispatchWithDurableObjectSchemaGuard({
        request,
        identity: {
          source: String(this.env["WORKER_SOURCE"] ?? ""),
          className: String(
            this.env["WORKER_CLASS_NAME"] ?? this.constructor.name,
          ),
          objectKey,
        },
        ensureReady: () => this.ensureReady(),
        dispatch: () => this.dispatchFetch(request),
      });
    } finally {
      // setAlarmAt/deleteAlarm mirror the synchronous DO storage API, but this
      // runtime persists alarms through an asynchronous server RPC. Do not let
      // an ordinary request return until those durability writes have
      // settled: a hibernation or eviction immediately after the response must
      // never lose the only wake that advances an effect outbox.
      await this.drainAlarmRpcs();
    }
  }

  private async dispatchFetch(request: Request): Promise<Response> {
    // Parse /{objectKey}/{method} — router includes objectKey in forwarded URL
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 1 && !this._objectKey) {
      this._objectKey = decodeURIComponent(segments[0]!);
      // Persist for hibernation recovery
      try {
        this.sql.exec(
          `INSERT OR IGNORE INTO state (key, value) VALUES ('__objectKey', ?)`,
          this._objectKey,
        );
      } catch {
        /* state table may not exist yet — ensureReady hasn't run */
      }
    }

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    const method = segments.slice(1).join("/") || "getState";
    if (this.env["VIBESTUDIO_SCHEMA_PROBE"] === true) {
      return method === "__vibestudio_schema_descriptor"
        ? this.schemaDescriptorResponse()
        : new Response("Schema probes refuse application dispatch", {
            status: 403,
          });
    }
    const authorityAcceptedAt = directAuthorityAcceptedAt(request);

    // Converged inbound dispatch: an `RpcEnvelope` POSTed to `__rpc` (relay
    // traffic and server→DO event push) flows through the shared
    // core's `handleEnvelope` → `exposeAll`'d method / event listeners.
    if (method === "__rpc") {
      return this.handleInboundEnvelope(request);
    }

    try {
      let args: unknown[] = [];
      let verifiedCallerFromBody: AttestedCaller | null = null;
      if (request.method === "POST") {
        const body = await request.text();
        if (body) {
          const result = this.parseRequestBody(body);
          if (result.error) {
            return new Response(JSON.stringify({ error: result.error }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          args = result.args;
          verifiedCallerFromBody = result.caller ?? null;
        }
      }

      if (method === "__lifecycle/prepare" || method === "__lifecycle/resume") {
        return this.withVerifiedCaller(verifiedCallerFromBody, async () => {
          const denial = this.inboundHostControlDenial(
            method,
            authorityAcceptedAt,
          );
          if (denial) {
            return new Response(
              JSON.stringify({
                error: denial.reason,
                errorCode: denial.code,
                errorKind: "access",
                errorData: { authorityFailure: denial.failure },
              }),
              {
                status: 403,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          // Live module replacement may update the class schema while this
          // activation retains its previous schemaReady cache. Lifecycle is the
          // generation boundary, so revalidate the one current schema here.
          this.ensureSchema();
          this._schemaInstalled = true;
          const result =
            method === "__lifecycle/prepare"
              ? await (async () => {
                  await this.drainAlarmRpcs();
                  return this.releaseForLifecycle(
                    args[0] as LifecyclePrepareInput,
                  );
                })()
              : await this.resumeAfterRestart(args[0] as LifecycleResumeInput);
          return new Response(JSON.stringify(result ?? null), {
            headers: this.workReadyHeaders(),
          });
        });
      }

      // Alarm endpoint — server-driven (workerd lacks SQLite/facet alarms).
      // The AlarmDriver fires this on schedule; gate to the server caller.
      if (method === "__alarm") {
        return this.withVerifiedCaller(verifiedCallerFromBody, async () => {
          const denial = this.inboundHostControlDenial(
            method,
            authorityAcceptedAt,
          );
          if (denial) {
            return new Response(
              JSON.stringify({
                error: denial.reason,
                errorCode: denial.code,
                errorKind: "access",
                errorData: { authorityFailure: denial.failure },
              }),
              {
                status: 403,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          const nextAlarm = await this.alarm();
          return new Response(JSON.stringify({ nextAlarm }), {
            headers: this.workReadyHeaders(),
          });
        });
      }

      // Method-path dispatch (the server's instance-token channel,
      // `DODispatch.dispatch`): build an inbound request envelope from
      // {method, args, __caller} and route it through the SAME converged core
      // dispatch as `__rpc`. `(this)[method]` is gone — `exposeAll` is the single
      // dispatch. Returns the raw method result (the DODispatch contract).
      const caller: AttestedCaller = verifiedCallerFromBody ?? {
        callerId: "",
        callerKind: "unknown",
      };
      const envelope = envelopeFromMessage({
        selfId: `do:${this.env["WORKER_SOURCE"]}:${this.env["WORKER_CLASS_NAME"]}:${this.objectKey}`,
        from: caller.callerId || "unknown",
        target: `do:${this.env["WORKER_SOURCE"]}:${this.env["WORKER_CLASS_NAME"]}:${this.objectKey}`,
        caller,
        message: {
          type: "request",
          requestId: crypto.randomUUID(),
          fromId: caller.callerId || "unknown",
          method,
          args,
        },
      });
      const dispatched = await this.dispatchInboundEnvelope(
        envelope,
        directAuthorityAcceptedAt(request),
      );
      const responseEnvelope = dispatched.result;
      const responseMessage = responseEnvelope?.message;
      if (responseMessage?.type === "response" && "error" in responseMessage) {
        if (responseMessage.error.startsWith('Method "')) {
          return new Response(
            JSON.stringify({ error: `Unknown method: ${method}` }),
            {
              status: 404,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        const status =
          responseMessage.errorCode === "EACCES" ||
          responseMessage.errorCode === "EVAL_READ_ONLY"
            ? 403
            : 500;
        return new Response(
          JSON.stringify({
            error: responseMessage.error,
            errorKind: responseMessage.errorKind,
            ...(responseMessage.errorCode
              ? { errorCode: responseMessage.errorCode }
              : {}),
            ...(responseMessage.errorData !== undefined
              ? { errorData: responseMessage.errorData }
              : {}),
          }),
          {
            status,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      const result =
        responseMessage?.type === "response" && "result" in responseMessage
          ? (responseMessage.result ?? null)
          : null;
      return new Response(JSON.stringify(result), {
        headers: this.workReadyHeaders(dispatched.readyQueues),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorData = rpcErrorDataOf(err);
      const errorCode =
        err instanceof Error
          ? (err as Error & { code?: string }).code
          : undefined;
      return new Response(
        JSON.stringify({
          error: message,
          errorKind: rpcErrorKindOf(err),
          ...(typeof errorCode === "string" ? { errorCode } : {}),
          ...(errorData === undefined ? {} : { errorData }),
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  /** Handle an `RpcEnvelope` POSTed to `__rpc`; returns a response envelope (or `{}` for events). */
  private async handleInboundEnvelope(request: Request): Promise<Response> {
    const envelope = (await request.json()) as RpcEnvelope;
    const message = envelope.message;
    const authorityAcceptedAt = directAuthorityAcceptedAt(request);
    if (message?.type === "event") {
      const caller =
        (envelope.delivery.caller as AttestedCaller | undefined) ?? null;
      const event = message as RpcEvent;
      const method = `__event:${event.event}`;
      const audience = this.directAuthorityAudience();
      const denial = directRpcDenial({
        kind: "event",
        method,
        eventTopic: event.event,
        caller,
        attestation: caller?.authorization ?? null,
        declaration: eventIntakeAuthority(this, event.event),
        audience,
        resourceKey: audience,
        capability: `event:${event.event}`,
        now: authorityAcceptedAt,
      });
      if (denial) {
        return new Response(
          JSON.stringify({
            error: denial.reason,
            errorCode: denial.code,
            errorKind: "access",
            errorData: { authorityFailure: denial.failure },
          }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      const attestation = caller?.authorization;
      if (
        !attestation ||
        !this._directRpcNonces.consume(
          attestation.nonce,
          attestation.expiresAt,
          authorityAcceptedAt,
        )
      ) {
        const reason =
          `${method}: host authority attestation nonce was replayed or is outside ` +
          "the receiver's retention bound";
        return new Response(
          JSON.stringify({
            error: reason,
            errorCode: "EACCES",
            errorKind: "access",
            errorData: {
              authorityFailure: directRpcInvalidAttestationFailure(reason),
            },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
      this.connectionlessClient().deliver(envelope);
      return new Response(JSON.stringify({}), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (message?.type !== "request" && message?.type !== "stream-request") {
      this.connectionlessClient().deliver(envelope);
      return new Response(JSON.stringify({}), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (message.type === "stream-request") {
      const dispatched = await this.dispatchInboundEnvelope(
        {
          ...envelope,
          message: { ...message, type: "request" } satisfies RpcRequest,
        },
        authorityAcceptedAt,
      );
      const responseEnvelope = dispatched.result;
      const responseMessage = responseEnvelope?.message;
      if (responseMessage?.type === "response" && "result" in responseMessage) {
        if (responseMessage.result instanceof Response)
          return responseMessage.result;
        return new Response(
          JSON.stringify({
            error: `Streaming method ${message.method} did not return a Response`,
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
      if (responseMessage?.type === "response" && "error" in responseMessage) {
        const status =
          responseMessage.errorCode === "EACCES" ||
          responseMessage.errorCode === "EVAL_READ_ONLY"
            ? 403
            : 500;
        return new Response(
          JSON.stringify({
            error: responseMessage.error,
            errorKind: responseMessage.errorKind,
            ...(responseMessage.errorCode
              ? { errorCode: responseMessage.errorCode }
              : {}),
            ...(responseMessage.errorData !== undefined
              ? { errorData: responseMessage.errorData }
              : {}),
          }),
          { status, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          error: `Streaming method ${message.method} did not produce a response`,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
    const dispatched = await this.dispatchInboundEnvelope(
      envelope,
      authorityAcceptedAt,
    );
    const responseEnvelope = dispatched.result;
    return new Response(JSON.stringify(responseEnvelope ?? {}), {
      headers: this.workReadyHeaders(dispatched.readyQueues),
    });
  }

  /** Evaluate the method's complete declaration against fresh host mediation. */
  private inboundCallerDenial(
    method: string | undefined,
    args: readonly unknown[],
    caller: AttestedCaller | null,
    authorityAcceptedAt: number,
    wireMethod?: MethodSchema,
  ): DirectRpcDenial | null {
    if (!method) return null;
    const declaration = this.rpcAuthorityDeclaration(method, wireMethod);
    const audience = this.directAuthorityAudience();
    const attestation = caller?.authorization ?? null;
    const resourceKey = directRpcInvocationResourceKey({
      audience,
      declaration,
      attestation,
      args,
    });
    return directRpcDenial({
      kind: "call",
      method,
      caller,
      attestation,
      declaration,
      audience,
      resourceKey,
      capability: caller?.authorization?.capability ?? "",
      now: authorityAcceptedAt,
    });
  }

  private directAuthorityAudience(): string {
    return `do:${String(this.env["WORKER_SOURCE"])}:${String(this.env["WORKER_CLASS_NAME"])}:${this.objectKey}`;
  }

  private inboundHostControlDenial(
    method: string,
    authorityAcceptedAt: number,
  ): HostControlDenial | null {
    const attestation = this.activeVerifiedCaller?.authorization ?? null;
    const denial = hostControlDenial({
      method,
      attestation,
      audience: this.directAuthorityAudience(),
      now: authorityAcceptedAt,
    });
    if (denial) return denial;
    if (
      !attestation ||
      !this._directRpcNonces.consume(
        attestation.nonce,
        attestation.expiresAt,
        authorityAcceptedAt,
      )
    ) {
      const reason =
        `${method}: host authority attestation nonce was replayed or is outside ` +
        "the receiver's retention bound";
      return {
        code: "EACCES",
        reason,
        failure: directRpcInvalidAttestationFailure(reason),
      };
    }
    return null;
  }

  /**
   * Dispatch an inbound request envelope through the converged core
   * (`respond` → `handleEnvelope` → `exposeAll`'d method), with the DO's
   * caller-context getters bound to `envelope.delivery.caller` for the duration.
   */
  private async dispatchInboundEnvelope(
    envelope: RpcEnvelope,
    authorityAcceptedAt: number,
  ): Promise<{ result: RpcEnvelope | null; readyQueues: DurableWorkQueue[] }> {
    const connectionless = this.connectionlessClient();
    // An unattributed method-path call carries a synthetic empty caller; surface
    // it as a null caller context (matching the pre-convergence behavior) rather
    // than a forgeable `"unknown"` — methods that gate on `this.caller` rely on it.
    const rawCaller = envelope.delivery.caller;
    const caller =
      rawCaller && rawCaller.callerId !== ""
        ? (rawCaller as AttestedCaller)
        : null;
    const message = envelope.message as RpcRequest;
    const method = message?.method;
    const wireMethod = method
      ? (this.constructor as typeof DurableObjectBase).rpcMethods?.[method]
      : undefined;
    if (wireMethod && message) {
      const tupleItems = (
        wireMethod.args as unknown as { _def?: { items?: readonly unknown[] } }
      )._def?.items;
      const args = message.args ?? [];
      const paddedArgs = tupleItems
        ? [...args, ...Array(Math.max(0, tupleItems.length - args.length))]
        : args;
      const parsedArgs = wireMethod.args.safeParse(paddedArgs);
      if (!parsedArgs.success) {
        return {
          result: this.schemaDenialResponse(
            envelope,
            message,
            `Invalid arguments for ${method}: ${parsedArgs.error.message}`,
          ),
          readyQueues: [],
        };
      }
      message.args = parsedArgs.data as unknown[];
    }
    const denial = this.inboundCallerDenial(
      method,
      message?.args ?? [],
      caller,
      authorityAcceptedAt,
      wireMethod,
    );
    if (denial) {
      return {
        result: {
          from: envelope.target,
          target: envelope.from,
          delivery: {
            caller: caller ?? { callerId: "", callerKind: "unknown" },
          },
          provenance: envelope.provenance ?? [],
          message: {
            type: "response",
            requestId: message?.requestId ?? "",
            error: denial.reason,
            errorCode: denial.code,
            errorKind: "access",
            errorData: { authorityFailure: denial.failure },
          },
        } as RpcEnvelope,
        readyQueues: [],
      };
    }
    const attestation = caller?.authorization;
    if (
      attestation &&
      !this._directRpcNonces.consume(
        attestation.nonce,
        attestation.expiresAt,
        authorityAcceptedAt,
      )
    ) {
      const reason =
        `${message?.method ?? "<unknown>"}: host authority attestation nonce was replayed ` +
        "or is outside the receiver's retention bound";
      return {
        result: {
          from: envelope.target,
          target: envelope.from,
          delivery: {
            caller: caller ?? { callerId: "", callerKind: "unknown" },
          },
          provenance: envelope.provenance ?? [],
          message: {
            type: "response",
            requestId: message?.requestId ?? "",
            error: reason,
            errorCode: "EACCES",
            errorKind: "access",
            errorData: {
              authorityFailure: directRpcInvalidAttestationFailure(reason),
            },
          },
        } as RpcEnvelope,
        readyQueues: [],
      };
    }
    const dispatched = await this.withRpcCaller(
      caller,
      message,
      envelope,
      async () => {
        // Constructor-time title writes are held until the first authenticated
        // ordinary request. Lifecycle probes happen before the host commits the
        // entity row, so they must not release that write early.
        if (
          message?.method !== "__lifecycle/prepare" &&
          message?.method !== "__lifecycle/resume" &&
          message?.method !== "__alarm"
        ) {
          await this.flushPendingOwnTitle();
        }
        return connectionless.respond(envelope);
      },
    );
    const response = dispatched.result;
    if (
      wireMethod?.returns &&
      response?.message.type === "response" &&
      !("error" in response.message)
    ) {
      const parsedResult = wireMethod.returns.safeParse(
        response.message.result,
      );
      if (!parsedResult.success) {
        return {
          result: this.schemaDenialResponse(
            envelope,
            message,
            `Invalid result from ${method}: ${parsedResult.error.message}`,
          ),
          readyQueues: dispatched.readyQueues,
        };
      }
      response.message.result = parsedResult.data;
    }
    return dispatched;
  }

  private schemaDenialResponse(
    envelope: RpcEnvelope,
    message: RpcRequest,
    reason: string,
  ): RpcEnvelope {
    return {
      from: envelope.target,
      target: envelope.from,
      delivery: envelope.delivery,
      provenance: envelope.provenance ?? [],
      message: {
        type: "response",
        requestId: message.requestId,
        error: reason,
        errorCode: "EINVAL",
        errorKind: "protocol",
      },
    };
  }

  private async withVerifiedCaller<T>(
    caller: AttestedCaller | null,
    callback: () => Promise<T>,
  ): Promise<T> {
    const context: RpcInvocationContext = {
      verifiedCaller: caller,
      authorityActive: true,
      callerId: caller?.callerId ?? null,
      callerKind: caller?.callerKind ?? null,
      callerPanelId: caller?.callerPanelId ?? null,
      requestId: null,
      idempotencyKey: null,
      readyQueues: new Set(),
    };
    try {
      return await this._invocationContext.run(context, async () => {
        try {
          return await callback();
        } finally {
          await this._causalRpcOperations.drain(context);
        }
      });
    } finally {
      context.authorityActive = false;
    }
  }

  private async withRpcCaller<T>(
    caller: AttestedCaller | null,
    message: RpcRequest,
    envelope: RpcEnvelope,
    callback: () => Promise<T>,
  ): Promise<{ result: T; readyQueues: DurableWorkQueue[] }> {
    const context: RpcInvocationContext = {
      verifiedCaller: caller,
      authorityActive: true,
      callerId: caller?.callerId ?? null,
      callerKind: caller?.callerKind ?? null,
      callerPanelId: caller?.callerPanelId ?? null,
      requestId: message?.requestId ?? null,
      idempotencyKey: envelope.delivery.idempotencyKey ?? null,
      readyQueues: new Set(),
    };
    try {
      const result = await this._invocationContext.run(context, async () => {
        const result = await (async () => {
          try {
            return await callback();
          } finally {
            await this._causalRpcOperations.drain(context);
          }
        })();
        const nextAlarm = this.nextAlarmAfterRequest();
        if (nextAlarm === null) this.deleteAlarm();
        else if (nextAlarm !== undefined) this.setAlarmAt(nextAlarm.wakeAt);
        return result;
      });
      return { result, readyQueues: [...context.readyQueues] };
    } finally {
      context.authorityActive = false;
    }
  }

  /**
   * Advance authoritative queue readiness and attach an opportunistic response
   * hint when a response exists. Every caller follows the same durable path;
   * transport topology can affect latency, never correctness.
   */
  protected markWorkReady(...queues: DurableWorkQueue[]): void {
    const unique = [...new Set(queues)];
    this.emitWorkReadyHint(...unique);
    this._durableWorkReadiness.markReady(unique);
  }

  /**
   * Attach readiness already recorded in durable state to the current
   * response. Re-delivery must not manufacture another generation: one
   * committed transition remains one unacknowledged transition until drained.
   */
  private emitWorkReadyHint(...queues: DurableWorkQueue[]): void {
    const context = this._invocationContext.current();
    for (const queue of new Set(queues)) context?.readyQueues.add(queue);
  }

  /** Immediate alarm edge while any ready generation remains unacknowledged. */
  protected nextDurableWorkReadyEdgeAt(): number | null {
    return this.pendingDurableWorkReadyQueues().length > 0 ? Date.now() : null;
  }

  private pendingDurableWorkReadyQueues(): DurableWorkQueue[] {
    return this._durableWorkReadiness.pendingQueues(this.durableWorkQueues());
  }

  protected acknowledgeDurableWorkReady(queue: DurableWorkQueue): void {
    this._durableWorkReadiness.acknowledge(queue);
  }

  protected durableWorkReadinessDiagnostics() {
    return this._durableWorkReadiness.diagnostics(this.durableWorkQueues());
  }

  /** Queue capabilities are registered by the host before entity activation
   * becomes observable. Subclasses declare only queues they own locally. */
  protected durableWorkQueues(): readonly DurableWorkQueue[] {
    return [];
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  durableWorkCapabilities(): DurableWorkQueue[] {
    return [...this.durableWorkQueues()];
  }

  /** Finite delivery into an explicitly resident in-memory operation. The
   * durable sender retries when no receiver is active; this method owns no
   * stream, timer, or durable relationship state. */
  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async acceptChannelDelivery(
    input: ResidentChannelDeliveryInput,
  ): Promise<unknown> {
    return acceptResidentChannelDelivery(this.directAuthorityAudience(), input);
  }

  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async acceptChannelInvocation(
    input: ResidentChannelInvocationInput,
  ): Promise<unknown> {
    return acceptResidentChannelInvocation(
      this.directAuthorityAudience(),
      input,
    );
  }

  @rpc({
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async cancelChannelInvocation(
    input: ResidentChannelCancellationInput,
  ): Promise<unknown> {
    return cancelResidentChannelInvocation(
      this.directAuthorityAudience(),
      input,
    );
  }

  /** Explicit owner-local registration capability for workspace Durable
   * Objects that declare mailbox invocation routing. Without this hook an
   * entity endpoint could join successfully but could never accept delivery. */
  protected registerResidentChannelSession(
    channelId: string,
    receiver: ResidentSessionReceiver,
  ): () => void {
    return registerResidentSession(
      this.directAuthorityAudience(),
      channelId,
      receiver,
    );
  }

  protected residentSessionDiagnostics(): {
    active: number;
    receivers: Array<{ channelId: string; openedAt: number; ageMs: number }>;
  } {
    const receivers = inspectResidentSessions(this.directAuthorityAudience());
    return { active: receivers.length, receivers };
  }

  /**
   * Claim methods call this before selecting rows, so an immediate response
   * hint and a registry recovery scan have identical fencing semantics.
   */
  protected adoptDurableWorkWorkerGeneration(workerId: string): {
    adopted: boolean;
    previousWorkerId: string | null;
  } {
    return this._durableWorkReadiness.adoptWorker(
      workerId,
      (previousWorkerId, nextWorkerId) =>
        this.releaseDurableWorkClaims(previousWorkerId, nextWorkerId),
    );
  }

  protected releaseDurableWorkClaims(
    _previousWorkerId: string | null,
    _nextWorkerId: string,
  ): void {}

  private workReadyHeaders(queues?: Iterable<DurableWorkQueue>): Headers {
    const headers = new Headers({ "Content-Type": "application/json" });
    const encoded = encodeDurableWorkReady(
      queues ?? this._invocationContext.current()?.readyQueues ?? [],
    );
    if (encoded) headers.set(DURABLE_WORK_READY_HEADER, encoded);
    return headers;
  }

  private get activeVerifiedCaller(): AttestedCaller | null {
    const context = this.activeInvocationContext;
    return context ? context.verifiedCaller : this._currentVerifiedCaller;
  }

  private get activeInvocationContext(): RpcInvocationContext | null {
    const context = this._invocationContext.current();
    return context?.authorityActive ? context : null;
  }

  /** Override in subclasses to accept WebSocket connections. */
  protected handleWebSocketUpgrade(_request: Request): Response {
    return new Response("WebSocket not supported", { status: 426 });
  }

  async releaseForLifecycle(
    _input: LifecyclePrepareInput,
  ): Promise<LifecyclePrepareResult> {
    return { status: "ready" };
  }

  async resumeAfterRestart(_input: LifecycleResumeInput): Promise<void> {
    // No generic continuation store: event-sourced subclasses re-derive their
    // pending work from their logs on wake.
  }

  protected async registerLifecycleRelease(detail?: unknown): Promise<void> {
    // Registration is the durable declaration that this activation owns
    // resources which must be released before replacement and reconstructed
    // afterwards. It is exact: a failed write fails the owning operation rather
    // than starting unregistered work or retrying behind its back.
    await this.workspaceStateService.lifecycleLeaseUpsert({
      ...this.lifecycleKey(),
      detail,
    });
  }

  protected async clearLifecycleRelease(): Promise<void> {
    await this.workspaceStateService.lifecycleLeaseClear(this.lifecycleKey());
  }

  // --- Hibernation hooks ---
  // On a resumed hibernated DO, workerd can invoke these on a fresh instance
  // WITHOUT going through fetch(), so schema must be ready here too.
  // Subclasses that override these MUST call super.webSocketMessage() etc.

  async webSocketMessage(
    _ws: WebSocket,
    _msg: string | ArrayBuffer,
  ): Promise<void> {
    this.ensureReady();
  }

  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    this.ensureReady();
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    this.ensureReady();
  }

  // --- Clone support ---

  protected resetRpcClients(): void {
    this._connectionless = null;
    this._credentials = null;
    this._notifications = null;
    this._fs = null;
  }

  // --- Introspection ---

  async getState(): Promise<Record<string, unknown>> {
    const state = this.sql.exec(`SELECT * FROM state`).toArray();
    return { state, residentExecution: this.residentSessionDiagnostics() };
  }
}
