import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type {
  AuthenticatedCaller,
  AuthorizationContext,
  AuthorityGrant,
  Principal,
  PrincipalKind,
} from "@vibestudio/rpc";
import type { AttestedCaller, DirectAuthorityAttestation } from "@vibestudio/rpc/internal";
import { rpcMethodAuthority } from "@vibestudio/rpc";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";

type BindParams = Parameters<Database["run"]>[1];

interface SqlResult {
  toArray(): Record<string, unknown>[];
  one(): Record<string, unknown>;
}

/** Mock WebSocket for testing channel DO and hibernation flows. */
export class MockWebSocket {
  sent: string[] = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;
  private attachment: unknown = undefined;
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }
  serializeAttachment(value: unknown) {
    this.attachment = value;
  }
  deserializeAttachment() {
    return this.attachment;
  }
}

interface AcceptedWebSocket {
  ws: unknown;
  tags: string[];
}

interface TestDOResult<T> {
  instance: T;
  sql: { exec(query: string, ...bindings: unknown[]): SqlResult };
  /** The raw in-memory database. Pass it to a second `createTestDO` (via
   *  `opts.db`) to simulate hibernation: a fresh DO instance — empty in-memory
   *  state — backed by the SAME durable storage. */
  db: Database;
  /** Alarms scheduled via ctx.storage.setAlarm(). Inspectable in tests. */
  alarms: number[];
  /** WebSockets accepted via ctx.acceptWebSocket(). Inspectable in tests. */
  acceptedWebSockets: AcceptedWebSocket[];
  /**
   * Call a DO method through fetch(), matching the production dispatch path.
   * Runs ensureReady(), ensureBootstrapped(), and objectKey parsing from the URL.
   * Throws on non-2xx responses (with the error message from the response body).
   */
  call: <R = unknown>(method: string, ...args: unknown[]) => Promise<R>;
  /** Like `call`, but constructs the exact attested principal for a runtime
   *  role (e.g. `callAs("do", ...)` to simulate an agent/channel DO). */
  callAs: <R = unknown>(
    caller:
      | AuthenticatedCaller["callerKind"]
      | (Pick<AuthenticatedCaller, "callerId" | "callerKind"> &
          Partial<Pick<AuthenticatedCaller, "callerPanelId" | "userId">> & {
            authorization?: DirectAuthorityAttestation;
          }),
    method: string,
    ...args: unknown[]
  ) => Promise<R>;
}

/** Shared sql.js initialization (cached after first call) */
let sqlJsPromise: Promise<SqlJsStatic> | null = null;
function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) sqlJsPromise = initSqlJs();
  return sqlJsPromise!;
}

/**
 * Create a workerd-compatible SQL proxy backed by sql.js (pure WASM).
 * Matches the `ctx.storage.sql.exec()` API that workerd DOs use.
 */
function createSqlProxy(db: Database) {
  return {
    exec(query: string, ...bindings: unknown[]): SqlResult {
      const trimmed = query.trim().toUpperCase();
      const isQuery =
        trimmed.startsWith("SELECT") ||
        trimmed.startsWith("WITH") ||
        trimmed.startsWith("PRAGMA") ||
        /\bRETURNING\b/.test(trimmed);

      if (isQuery) {
        const stmt = db.prepare(query);
        if (bindings.length > 0) stmt.bind(bindings as BindParams);
        const rows: Record<string, unknown>[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>);
        stmt.free();
        return {
          toArray() {
            return rows;
          },
          one() {
            if (rows.length === 0) throw new Error("Expected one row, got none");
            return rows[0]!;
          },
        };
      } else {
        if (bindings.length === 0) {
          db.run(query);
        } else {
          db.run(query, bindings as BindParams);
        }
        return {
          toArray() {
            return [];
          },
          one() {
            throw new Error("No rows from mutation");
          },
        };
      }
    },
  };
}

/**
 * Standalone in-memory SQL storage (sql.js / WASM) matching `ctx.storage.sql`.
 * For unit-testing stores in isolation without spinning up a full DO.
 */
export async function createInMemorySql(): Promise<{
  exec(query: string, ...bindings: unknown[]): SqlResult;
}> {
  const SQL = await getSqlJs();
  return createSqlProxy(new SQL.Database());
}

/** Default env stubs so AgentWorkerBase subclasses don't crash during construction.
 *  The HTTP clients are created but never called in unit tests. */
const AGENTIC_ENV_DEFAULTS: Record<string, string> = {
  GATEWAY_URL: "http://test-server.invalid",
  RPC_AUTH_TOKEN: "test-token",
  WORKER_SOURCE: "test",
  WORKER_CLASS_NAME: "TestDO",
  WORKERD_SESSION_ID: "test-session",
  WORKERD_BOOT_GENERATION: "1",
};

function principalKindForTestCaller(callerKind: AuthenticatedCaller["callerKind"]): PrincipalKind {
  if (callerKind === "server") return "host";
  if (callerKind === "shell") return "user";
  if (callerKind === "agent") return "session";
  return "code";
}

/**
 * Mint the same exact-target, exact-method authority shape that the host relay
 * supplies in production. Tests may override individual fields to exercise
 * stale, wrong-target, missing-grant, and read-only rejection without weakening
 * the receiver or teaching fixtures to trust runtime kinds.
 */
export function createTestDirectAuthority(input: {
  callerKind: AuthenticatedCaller["callerKind"];
  method: string;
  /** Exact manifest-facing method capability declared by the receiver. */
  capability?: string;
  effect?: DirectAuthorityAttestation["effect"];
  /** Product service boundary traversed to reach a workspace-service method. */
  targetCapability?: `workspace-service:${string}`;
  targetPrincipals?: readonly PrincipalKind[];
  source?: string;
  className?: string;
  objectKey?: string;
  tier?: "open" | "gated" | "critical";
  now?: number;
  overrides?: Partial<DirectAuthorityAttestation>;
}): DirectAuthorityAttestation {
  const source = input.source ?? AGENTIC_ENV_DEFAULTS["WORKER_SOURCE"]!;
  const className = input.className ?? AGENTIC_ENV_DEFAULTS["WORKER_CLASS_NAME"]!;
  const objectKey = input.objectKey ?? "test-key";
  const audience = `do:${source}:${className}:${objectKey}`;
  const capability = input.capability ?? `rpc:${input.method}`;
  const resourceKey =
    input.effect?.kind === "userland-capability" ? `${capability}:${audience}` : audience;
  const now = input.now ?? Date.now();
  const invocationDigest =
    input.tier === "critical" ? `test-invocation:${crypto.randomUUID()}` : undefined;
  const kind = principalKindForTestCaller(input.callerKind);
  const subject = (kind === "code" ? `code:test@${"a".repeat(64)}` : `${kind}:test`) as Principal;
  const actingUser = kind === "host" ? null : ("user:test" as const);
  const entity = input.callerKind === "agent" ? ("entity:test" as const) : null;
  const capabilities = [
    ...new Set([capability, input.targetCapability].filter(Boolean)),
  ] as string[];
  const requested = capabilities.map((requestedCapability) => ({
    capability: requestedCapability,
    resource: {
      kind: "exact" as const,
      key: requestedCapability === capability ? resourceKey : audience,
    },
  }));
  const context: AuthorizationContext = {
    authorizingOrigin: { kind, principal: subject } as AuthorizationContext["authorizingOrigin"],
    host: kind === "host" ? (subject as `host:${string}`) : null,
    actingUser,
    entity,
    incarnation: null,
    executingCode:
      kind === "code"
        ? {
            principal: subject as `code:${string}`,
            requested,
            sourceLineage: { class: "internal", externalKeys: [] },
          }
        : null,
    initiatorChain: [...(actingUser ? [actingUser] : []), ...(entity ? [entity] : []), subject],
    ownerChain: actingUser ? [actingUser] : [],
    agentBinding:
      entity === null ? null : { entity, contextId: "ctx:test", channelId: "channel:test" },
    executionSession: null,
    testPolicy: null,
    workspace: { workspaceId: "test", member: true, role: null, revision: "test" },
    session: { id: "test-session", audience, version: "1.0.0", expiresAt: now + 5_000 },
    contextIntegrity:
      kind === "session"
        ? { class: "internal", latchEpoch: 0, externalKeys: [] }
        : { class: "not-applicable", latchEpoch: 0, externalKeys: [] },
  };
  const grants: AuthorityGrant[] = capabilities.map((grantedCapability) => ({
    subject,
    capability: grantedCapability,
    resource: {
      kind: "exact",
      key: grantedCapability === capability ? resourceKey : audience,
    },
    effect: "allow",
    issuedBy: "host:test",
    createdAt: now,
    constraints: {
      lineageAtConsent: [],
      ...(invocationDigest ? { invocationDigest } : {}),
    },
    provenance: invocationDigest ? "critical-confirmation" : "durable-test-host-attestation",
  }));
  return {
    audience,
    method: input.method,
    effect:
      input.effect ??
      (input.targetCapability
        ? { kind: "open" }
        : input.capability
          ? { kind: "host-capability", capability, resource: { kind: "receiver-object" } }
          : { kind: "open" }),
    capability,
    resourceKey,
    issuedAt: now,
    expiresAt: now + 5_000,
    nonce: crypto.randomUUID(),
    ...(invocationDigest ? { invocationDigest } : {}),
    context,
    grants,
    ...(input.targetCapability
      ? {
          targetRequirement: requirementForPrincipals(
            input.targetPrincipals ?? [kind],
            input.targetCapability
          ),
          targetCapability: input.targetCapability,
          targetTier: "gated" as const,
        }
      : {}),
    ...input.overrides,
    capabilityDefinitionDigest: input.overrides?.capabilityDefinitionDigest ?? "-",
    resourceType: input.overrides?.resourceType ?? capability,
    provider: input.overrides?.provider ?? "-",
    providerExecutionDigest: input.overrides?.providerExecutionDigest ?? "-",
  };
}

/**
 * Create a test DO instance backed by in-memory SQLite (sql.js / WASM).
 * Eliminates the need for workerd or native modules in unit tests.
 *
 * Works with both DurableObjectBase and AgentWorkerBase subclasses.
 * For AgentWorkerBase subclasses, GATEWAY_URL/RPC_AUTH_TOKEN
 * are automatically stubbed unless overridden via the env parameter.
 *
 * Must be awaited since sql.js initialization is async.
 */
export async function createTestDO<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DOClass: new (ctx: any, env: any) => T,
  env?: Record<string, unknown>,
  opts?: { db?: Database; initialize?: boolean }
): Promise<TestDOResult<T>> {
  const SQL = await getSqlJs();
  // Reuse an existing db to simulate hibernation (fresh DO, same durable storage).
  const db = opts?.db ?? new SQL.Database();
  const sqlProxy = createSqlProxy(db);

  const alarms: number[] = [];
  const acceptedWebSockets: AcceptedWebSocket[] = [];

  const objectKey = (env?.["__objectKey"] as string) ?? "test-key";

  const ctx = {
    id: { toString: () => objectKey, name: objectKey },
    storage: {
      sql: sqlProxy,
      setAlarm(scheduledTime: number | Date) {
        const ts = typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime();
        alarms.push(ts);
      },
      async getAlarm(): Promise<number | null> {
        return alarms.length > 0 ? alarms[alarms.length - 1]! : null;
      },
      deleteAlarm() {
        alarms.length = 0;
      },
      transactionSync<T>(callback: () => T): T {
        // sql.js doesn't enforce workerd's "no raw BEGIN/COMMIT" rule, but we
        // mirror the production semantics: synchronous block, auto-rollback on
        // throw. Use a SAVEPOINT so nested calls work too.
        const savepoint = `_tx_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        sqlProxy.exec(`SAVEPOINT ${savepoint}`);
        try {
          const result = callback();
          sqlProxy.exec(`RELEASE ${savepoint}`);
          return result;
        } catch (err) {
          try {
            sqlProxy.exec(`ROLLBACK TO ${savepoint}`);
          } catch {
            /* ignore */
          }
          try {
            sqlProxy.exec(`RELEASE ${savepoint}`);
          } catch {
            /* ignore */
          }
          throw err;
        }
      },
    },
    acceptWebSocket(ws: unknown, tags?: string[]) {
      acceptedWebSockets.push({ ws, tags: tags ?? [] });
    },
    getWebSockets(tag?: string) {
      if (tag) return acceptedWebSockets.filter((s) => s.tags.includes(tag)).map((s) => s.ws);
      return acceptedWebSockets.map((s) => s.ws);
    },
    blockConcurrencyWhile<T>(fn: () => Promise<T>) {
      return fn();
    },
  };

  const mergedEnv = { ...AGENTIC_ENV_DEFAULTS, ...env };
  const instance = new DOClass(ctx, mergedEnv);
  if (opts?.initialize !== false) {
    (instance as unknown as { ensureReady?: () => void }).ensureReady?.();
  }

  // call() dispatches through fetch(), matching the production DO invocation path:
  // URL /{objectKey}/{method} → ensureReady() → ensureBootstrapped() → method dispatch
  const dispatch = async <R = unknown>(
    callerInput:
      | AuthenticatedCaller["callerKind"]
      | (Pick<AuthenticatedCaller, "callerId" | "callerKind"> &
          Partial<Pick<AuthenticatedCaller, "callerPanelId" | "userId">> & {
            authorization?: DirectAuthorityAttestation;
          }),
    method: string,
    args: unknown[]
  ): Promise<R> => {
    const caller =
      typeof callerInput === "string" ? { callerId: "main", callerKind: callerInput } : callerInput;
    const { authorization: suppliedAuthorization, ...callerIdentity } = caller;
    const fetchable = instance as unknown as { fetch(request: Request): Promise<Response> };
    if (typeof fetchable.fetch !== "function") {
      throw new Error("DO instance does not have a fetch() method");
    }
    // Dispatch through the converged `__rpc` envelope path — the production relay
    // path, which trusts the server-set `delivery.caller`. We attribute the call as
    // the server (production calls always carry a verified caller; the
    // workspace-realm default-deny gate refuses unattributed calls).
    const url = `http://test/${encodeURIComponent(objectKey)}/__rpc`;
    const declaration = rpcMethodAuthority(instance as object, method);
    const schemaMethod = (
      (instance as object).constructor as unknown as {
        rpcMethods?: Record<
          string,
          {
            capability?: string;
            directEffect?: DirectAuthorityAttestation["effect"];
            authority?: { principals?: readonly PrincipalKind[] };
            tier?: { tier: "open" | "gated" | "critical" };
          }
        >;
      }
    ).rpcMethods?.[method];
    const effect = schemaMethod?.directEffect ?? declaration?.effect;
    const capability =
      schemaMethod?.capability ??
      (effect && effect.kind !== "open" ? effect.capability : `rpc:${method}`);
    const attestedCapability =
      effect?.kind === "userland-capability" ? `userland:${effect.capability}` : capability;
    const envelope = {
      from: "main",
      target: `do:test:${objectKey}`,
      delivery: {
        caller: {
          ...callerIdentity,
          authorization:
            suppliedAuthorization ??
            createTestDirectAuthority({
              callerKind: caller.callerKind,
              method,
              capability: attestedCapability,
              effect,
              tier: schemaMethod?.tier?.tier ?? declaration?.tier,
              targetPrincipals:
                schemaMethod?.authority && "principals" in schemaMethod.authority
                  ? schemaMethod.authority.principals
                  : declaration?.principals,
              source: String(mergedEnv["WORKER_SOURCE"]),
              className: String(mergedEnv["WORKER_CLASS_NAME"]),
              objectKey,
            }),
        } satisfies AttestedCaller,
      },
      provenance: [],
      message: { type: "request", requestId: crypto.randomUUID(), fromId: "main", method, args },
    };
    const request = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    const response = await fetchable.fetch(request);
    const text = await response.text();
    if (!response.ok) {
      const parsed = text ? JSON.parse(text) : {};
      throw new Error(parsed.error ?? `DO call ${method} failed: ${response.status}`);
    }
    const respEnv = text ? JSON.parse(text) : {};
    const msg = respEnv.message as { type?: string; result?: unknown; error?: unknown } | undefined;
    if (msg?.type === "response" && msg.error != null) {
      throw new Error(typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error));
    }
    return (msg && "result" in msg ? msg.result : undefined) as R;
  };

  // Default test caller is the host relay. `callAs` changes the authenticated
  // origin and mints the matching exact-target attestation.
  const call = <R = unknown>(method: string, ...args: unknown[]): Promise<R> =>
    dispatch<R>("server", method, args);
  const callAs = <R = unknown>(
    caller:
      | AuthenticatedCaller["callerKind"]
      | (Pick<AuthenticatedCaller, "callerId" | "callerKind"> &
          Partial<Pick<AuthenticatedCaller, "callerPanelId" | "userId">> & {
            authorization?: DirectAuthorityAttestation;
          }),
    method: string,
    ...args: unknown[]
  ): Promise<R> => dispatch<R>(caller, method, args);

  return { instance, sql: sqlProxy, db, alarms, acceptedWebSockets, call, callAs };
}
