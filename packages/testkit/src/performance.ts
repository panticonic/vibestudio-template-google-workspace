import type { BuildPerformanceProfileWire } from "@vibestudio/service-schemas/build";
import type {
  HostEventLoopSample,
  HostPerformanceSnapshot,
} from "@vibestudio/service-schemas/hostPerformance";
import type { ServerLogRecord } from "@vibestudio/service-schemas/serverLog";
import type { CdpProfileOptions, CdpProfileReport } from "@workspace/cdp-client";
import { rpc, type PanelHandle } from "@workspace/runtime";

export interface HostSpanSummary {
  elapsedMs: number;
  server: {
    rssDeltaBytes: number;
    heapUsedDeltaBytes: number;
    userCpuMs: number;
    systemCpuMs: number;
  };
  workerd: {
    rssDeltaBytes: number | null;
    rssBytes: number | null;
    rssPeakBytes: number | null;
    regularWorkers: number;
    doServices: number;
  } | null;
  eventLoop: {
    sampleCount: number;
    maxP99Ms: number | null;
    maxDelayMs: number | null;
    maxUtilization: number | null;
  };
}

export interface HostSpanProfile<T> {
  version: 1;
  label?: string;
  startedAt: number;
  before: HostPerformanceSnapshot;
  after: HostPerformanceSnapshot;
  summary: HostSpanSummary;
  value: T;
}

export interface ElectronProcessPerformanceSnapshot {
  version: 1;
  sampledAt: number;
  familyWorkingSetBytes: number;
  processes: Array<{
    pid: number;
    type: string;
    workingSetBytes: number;
    cpuPercent: number;
  }>;
  eventLoop: { samples: HostEventLoopSample[] };
}

export async function hostPerformanceSnapshot(options?: {
  since?: number;
  eventLoopLimit?: number;
}): Promise<HostPerformanceSnapshot> {
  return rpc.call<HostPerformanceSnapshot>("main", "hostPerformance.snapshot", [options]);
}

export function summarizeHostSpan(
  before: HostPerformanceSnapshot,
  after: HostPerformanceSnapshot,
  elapsedMs: number
): HostSpanSummary {
  const samples = after.eventLoop.samples;
  const maximum = (pick: (sample: HostEventLoopSample) => number): number | null =>
    samples.length > 0 ? Math.max(...samples.map(pick)) : null;
  return {
    elapsedMs,
    server: {
      rssDeltaBytes: after.process.rssBytes - before.process.rssBytes,
      heapUsedDeltaBytes: after.process.heapUsedBytes - before.process.heapUsedBytes,
      userCpuMs: after.process.userCpuMs - before.process.userCpuMs,
      systemCpuMs: after.process.systemCpuMs - before.process.systemCpuMs,
    },
    workerd:
      after.workerd === null
        ? null
        : {
            rssDeltaBytes:
              before.workerd?.rssBytes !== null &&
              before.workerd?.rssBytes !== undefined &&
              after.workerd.rssBytes !== null
                ? after.workerd.rssBytes - before.workerd.rssBytes
                : null,
            rssBytes: after.workerd.rssBytes,
            rssPeakBytes: after.workerd.rssPeakBytes,
            regularWorkers: after.workerd.regularWorkers,
            doServices: after.workerd.doServices,
          },
    eventLoop: {
      sampleCount: samples.length,
      maxP99Ms: maximum((sample) => sample.p99Ms),
      maxDelayMs: maximum((sample) => sample.maxMs),
      maxUtilization: maximum((sample) => sample.utilization),
    },
  };
}

/** Measure one exact userland workload against server/workerd resource counters. */
export async function profileHost<T>(
  run: () => Promise<T>,
  options?: { label?: string; eventLoopLimit?: number }
): Promise<HostSpanProfile<T>> {
  const before = await hostPerformanceSnapshot({ eventLoopLimit: 1 });
  const startedAt = Date.now();
  const wallStartedAt = performance.now();
  const value = await run();
  const elapsedMs = performance.now() - wallStartedAt;
  const after = await hostPerformanceSnapshot({
    since: startedAt,
    eventLoopLimit: options?.eventLoopLimit ?? 60,
  });
  return {
    version: 1,
    ...(options?.label ? { label: options.label } : {}),
    startedAt,
    before,
    after,
    summary: summarizeHostSpan(before, after, elapsedMs),
    value,
  };
}

/**
 * Profile the canonical exact-context build and its verified-cache repeat.
 * Bundle/module contents stay server-side; this returns bounded attribution.
 */
export function profileBuild(
  source: string,
  options?: { ref?: string; verifyCache?: boolean }
): Promise<BuildPerformanceProfileWire> {
  return rpc.call<BuildPerformanceProfileWire>("main", "build.getPerformanceProfile", [
    source,
    options?.ref,
    { verifyCache: options?.verifyCache ?? true },
  ]);
}

/** Capture Electron's process family from client-affine eval in a desktop app or panel. */
export function electronPerformanceSnapshot(): Promise<ElectronProcessPerformanceSnapshot> {
  const root = globalThis as typeof globalThis & {
    __vibestudioShell?: {
      getProcessPerformanceSnapshot?: () => Promise<ElectronProcessPerformanceSnapshot>;
    };
    __vibestudioApp?: {
      getProcessPerformanceSnapshot?: () => Promise<ElectronProcessPerformanceSnapshot>;
    };
  };
  const read =
    root.__vibestudioShell?.getProcessPerformanceSnapshot ??
    root.__vibestudioApp?.getProcessPerformanceSnapshot;
  if (!read) {
    throw new Error(
      "Electron process metrics require client_eval in an Electron-hosted Vibestudio app or panel"
    );
  }
  return read();
}

type ServerLogEnvelope = {
  records: ServerLogRecord[];
  startedAt: number;
};

function firstStructuredField(record: ServerLogRecord | undefined): Record<string, unknown> | null {
  const value = record?.fields?.[0];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Extract the current boot's measured startup phases from canonical host logs. */
export async function readStartupProfile(): Promise<{
  version: 1;
  startedAt: number;
  semanticActivation: Record<string, unknown> | null;
  reconciliation: Record<string, unknown> | null;
  buildDiscovery: string | null;
  responsivenessWarnings: Array<{
    timestamp: number;
    label: string;
    message: string;
  }>;
}> {
  const snapshot = await hostPerformanceSnapshot({ eventLoopLimit: 1 });
  const envelope = await rpc.call<ServerLogEnvelope>("main", "serverLog.query", [
    { since: snapshot.startedAt, limit: 5_000 },
  ]);
  const latest = (predicate: (record: ServerLogRecord) => boolean) =>
    [...envelope.records].reverse().find(predicate);
  const semantic = latest(
    (record) => record.tag === "Vcs" && record.message === "semantic activation report"
  );
  const reconciliation = latest(
    (record) => record.tag === "StartupBootstrap" && record.message === "Reconciliation barrier"
  );
  const buildDiscovery = latest(
    (record) => record.tag === "BuildV2" && record.message.startsWith("Discovered ")
  );
  return {
    version: 1,
    startedAt: envelope.startedAt,
    semanticActivation: firstStructuredField(semantic),
    reconciliation: firstStructuredField(reconciliation),
    buildDiscovery: buildDiscovery?.message ?? null,
    responsivenessWarnings: envelope.records
      .filter((record) => record.tag?.startsWith("EventLoop:") && record.level === "warn")
      .map((record) => ({
        timestamp: record.timestamp,
        label: record.tag!.slice("EventLoop:".length),
        message: record.message,
      })),
  };
}

/** Profile an interaction on one existing panel and always release the CDP lease. */
export async function profilePanelInteraction(
  handle: PanelHandle,
  action: (page: Awaited<ReturnType<PanelHandle["cdp"]["page"]>>) => void | Promise<void>,
  options?: CdpProfileOptions
): Promise<CdpProfileReport> {
  const page = await handle.cdp.page();
  try {
    return await page.profile(() => action(page), options);
  } finally {
    await page.close();
  }
}

/** Profile the real in-place workspace-panel reload and retain lifecycle proof. */
export async function profilePanelReload(
  handle: PanelHandle,
  options?: CdpProfileOptions
): Promise<{
  beforeAttemptId: string | null;
  afterAttemptId: string | null;
  markerResetAfterReload: boolean;
  report: CdpProfileReport;
}> {
  const beforeAttemptId = (await handle.snapshot()).attemptId ?? null;
  let markerResetAfterReload = false;
  const report = await profilePanelInteraction(
    handle,
    async (page) => {
      await page.evaluate(() => {
        Reflect.set(globalThis, "__vibestudioProfilePanelReloadProbe", true);
      });
      await handle.reload();
      await page.waitForLoadState("networkidle");
      markerResetAfterReload =
        (await page.evaluate(() =>
          Reflect.get(globalThis, "__vibestudioProfilePanelReloadProbe")
        )) === undefined;
    },
    options
  );
  const afterAttemptId = (await handle.snapshot()).attemptId ?? null;
  return { beforeAttemptId, afterAttemptId, markerResetAfterReload, report };
}
