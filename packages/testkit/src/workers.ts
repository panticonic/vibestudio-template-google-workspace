/**
 * Worker/DO orchestration and state inspection helpers.
 */
import {
  contextId,
  createDurableObjectServiceClient,
  rpc,
  runtime,
} from "@workspace/runtime";
import type { RuntimeSupervisionDescription } from "@vibestudio/service-schemas/runtime";

export type UnitDiagnostics = Awaited<ReturnType<typeof runtime.supervision.health>>;
import { activeTestContext } from "./run.js";
import { waitFor } from "./panels.js";

export interface CompactUnitStatus {
  name: string;
  kind: RuntimeSupervisionDescription["identity"]["kind"];
  source: string;
  status: RuntimeSupervisionDescription["status"];
  version?: string | null;
  lastError?: string | null;
}

function compact(unit: RuntimeSupervisionDescription): CompactUnitStatus {
  return {
    name: unit.identity.entityId,
    kind: unit.identity.kind,
    source: unit.source,
    status: unit.status,
    version: unit.artifact.effectiveVersion,
    lastError: unit.lastError ?? undefined,
  };
}

/** All workspace units (panels/workers/extensions/apps) in compact form. */
export async function listUnits(filter?: {
  kind?: CompactUnitStatus["kind"];
  status?: CompactUnitStatus["status"];
}): Promise<CompactUnitStatus[]> {
  const units = await runtime.supervision.list();
  return units
    .filter((unit) => !filter?.kind || unit.identity.kind === filter.kind)
    .filter((unit) => !filter?.status || unit.status === filter.status)
    .map(compact);
}

/** Logs + errors for a unit since a timestamp, via RuntimeDiagnosticsStore. */
export async function unitDiagnostics(
  name: string,
  opts?: { since?: number; level?: "debug" | "info" | "warn" | "error"; limit?: number }
): Promise<UnitDiagnostics> {
  const matches = (await runtime.supervision.list()).filter(
    (unit) => unit.identity.entityId === name || unit.source === name
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `No running executable entity matches ${name}`
        : `Executable entity selector is ambiguous: ${name}`
    );
  }
  return runtime.supervision.health(matches[0]!.identity, opts);
}

/** Call a method on a Durable Object-backed service. */
export async function callDO<T = unknown>(
  query: string,
  method: string,
  args: unknown[] = [],
  opts?: { objectKey?: string | null }
): Promise<T> {
  const client = createDurableObjectServiceClient(query, opts?.objectKey ?? null);
  return (await client.call(method, ...args)) as T;
}

/** Ensure a worker instance exists for `source` and is running; auto-watch it. */
export async function ensureWorker(
  source: string,
  opts?: {
    name?: string;
    env?: Record<string, string>;
    stateArgs?: Record<string, unknown>;
    timeoutMs?: number;
  }
): Promise<CompactUnitStatus> {
  const name = opts?.name ?? source.split("/").pop() ?? source;
  const handle = await rpc.call<{ id: string }>("main", "runtime.createEntity", [
      {
        kind: "worker",
        execution: { surface: "code", source },
        key: name,
        contextId,
        env: opts?.env,
        stateArgs: opts?.stateArgs,
      },
    ]);
  const identity = { kind: "worker" as const, entityId: handle.id };
  const running = await waitFor(
    async () => {
      const status = await runtime.supervision.describe(identity);
      if (status?.status === "error") {
        throw new Error(`worker ${name} entered error state`);
      }
      return status?.status === "running" ? status : undefined;
    },
    { timeoutMs: opts?.timeoutMs ?? 60_000, label: `worker ${name} running` }
  );
  activeTestContext()?.supervisor.watchUnit(handle.id);
  return {
    name: running.identity.entityId,
    kind: "worker",
    source: running.source,
    status: "running",
  };
}

export async function restartUnit(name: string): Promise<void> {
  const matches = (await runtime.supervision.list()).filter(
    (unit) => unit.identity.entityId === name || unit.source === name
  );
  if (matches.length !== 1) throw new Error(`Expected one running executable entity for ${name}`);
  await runtime.supervision.restart(matches[0]!.identity);
}
