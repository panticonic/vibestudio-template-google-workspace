/**
 * Workerd profiling — attach the V8 inspector to workerd isolates through the
 * server's approval-gated workerdInspector service and bridge.
 *
 * Granularity caveat: regular workers load dynamically into the shared
 * `worker-host` service, so a CPU profile of that target may include sibling
 * workers. Per-source DO services are precise. listWorkerdTargets() shows
 * what workerd actually exposes — match on title/id rather than guessing.
 */
import { CdpConnection } from "@workspace/cdp-client";
import { rpc, workers } from "@workspace/runtime";
import { cpuProfileRef, type ProfileRef, type V8Profile } from "./profile-core.js";
import { saveProfile } from "./profiles-store.js";

export interface WorkerdTarget {
  id: string;
  title: string;
  type: string;
  targetPath: string;
}

/** Live workerd inspector targets (one per top-level workerd service). */
export async function listWorkerdTargets(): Promise<WorkerdTarget[]> {
  return rpc.call<WorkerdTarget[]>("main", "workerdInspector.listTargets", []);
}

async function resolveTargetPath(target: string | WorkerdTarget): Promise<string> {
  if (typeof target !== "string") return target.targetPath;
  const targets = await listWorkerdTargets();
  const match =
    targets.find((row) => row.targetPath === target) ??
    targets.find((row) => row.id === target || row.title === target) ??
    targets.find((row) => row.title.includes(target) || row.id.includes(target));
  if (!match) {
    throw new Error(
      `no workerd inspector target matching "${target}"; available: ${targets
        .map((row) => row.title)
        .join(", ")}`
    );
  }
  return match.targetPath;
}

/** Open an authenticated raw inspector session to a workerd target. */
export async function workerdInspectorSession(
  target: string | WorkerdTarget
): Promise<CdpConnection> {
  const targetPath = await resolveTargetPath(target);
  const endpoint = await rpc.call<{ wsEndpoint: string; token: string }>(
    "main",
    "workerdInspector.getEndpoint",
    [targetPath]
  );
  return CdpConnection.connect(endpoint.wsEndpoint, endpoint.token);
}

/** CPU-profile a workerd target while `run` executes. */
export async function profileWorkerd(
  target: string | WorkerdTarget,
  run: () => Promise<void>,
  opts?: { samplingIntervalUs?: number }
): Promise<ProfileRef> {
  const targetPath = await resolveTargetPath(target);
  const connection = await workerdInspectorSession(targetPath);
  const label = typeof target === "string" ? target : target.title;
  const startedAt = Date.now();
  try {
    await connection.send("Profiler.enable");
    if (opts?.samplingIntervalUs) {
      await connection.send("Profiler.setSamplingInterval", { interval: opts.samplingIntervalUs });
    }
    await connection.send("Profiler.start");
    let savedProfile: ProfileRef | undefined;
    try {
      await run();
    } finally {
      const result = (await connection.send("Profiler.stop")) as { profile: V8Profile };
      savedProfile = await saveProfile(
        cpuProfileRef(`workerd:${label}`, startedAt, result.profile),
        JSON.stringify(result.profile)
      );
    }
    if (!savedProfile) throw new Error("Workerd CPU profile was not saved");
    return savedProfile;
  } finally {
    connection.close();
  }
}

/**
 * CPU-profile the workerd service hosting a Durable Object while `run`
 * executes. `query` is a service name/protocol (workers.resolveService
 * semantics). Falls back to the shared universal-do service when no
 * source-specific target matches.
 */
export async function profileDO(
  query: string,
  run: () => Promise<void>,
  opts?: { samplingIntervalUs?: number }
): Promise<ProfileRef> {
  const [service, targets] = await Promise.all([
    workers.resolveService(query).catch(() => null),
    listWorkerdTargets(),
  ]);
  const sourceName = (service as { source?: string } | null)?.source?.split("/").pop();
  const match =
    (sourceName &&
      targets.find((row) => row.title.includes(sourceName) || row.id.includes(sourceName))) ||
    targets.find((row) => row.title.includes("universal-do") || row.id.includes("universal-do"));
  if (!match) {
    throw new Error(
      `no workerd inspector target for DO service "${query}"; available: ${targets
        .map((row) => row.title)
        .join(", ")}`
    );
  }
  return profileWorkerd(match, run, opts);
}
