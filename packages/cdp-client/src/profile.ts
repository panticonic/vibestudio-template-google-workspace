type ProtocolTransport = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(method: string, listener: (params: unknown) => void): () => void;
};

type ProfilePage = {
  url(): string;
  evaluate(pageFunction: string | ((arg?: unknown) => unknown), arg?: unknown): Promise<unknown>;
};

export interface CdpProfileOptions {
  /** Human-readable operation name copied into the report. */
  label?: string;
  /** Disable the Chromium HTTP cache for this operation, then restore it. */
  disableCache?: boolean;
  /** Collect precise JS coverage. This adds profiler overhead and is off by default. */
  javascriptCoverage?: boolean;
  /** Number of slow network requests retained in the bounded report (default 20, max 100). */
  maxNetworkRecords?: number;
}

export interface CdpProfileRuntimeMetrics {
  taskDurationMs: number;
  scriptDurationMs: number;
  layoutDurationMs: number;
  styleRecalcDurationMs: number;
  layoutCount: number;
  styleRecalcCount: number;
  jsHeapUsedBytes: number;
  jsHeapDeltaBytes: number;
  nodes: number;
  documents: number;
}

export interface CdpProfilePageMetrics {
  navigation?: {
    ttfbMs: number;
    responseStartMs: number;
    domContentLoadedMs: number;
    loadMs: number;
  };
  firstContentfulPaintMs?: number;
  largestContentfulPaintMs?: number;
  cumulativeLayoutShift: number;
  layoutShiftCount: number;
  interactionLatencyMs?: number;
  longTasks: {
    count: number;
    totalDurationMs: number;
    maxDurationMs: number;
  };
}

export interface CdpProfileNetworkRequest {
  url: string;
  method: string;
  type: string;
  status?: number;
  mimeType?: string;
  durationMs?: number;
  transferBytes: number;
  fromCache: boolean;
  failedReason?: string;
}

export interface CdpProfileNetworkMetrics {
  requestCount: number;
  failedCount: number;
  cacheHits: number;
  transferBytes: number;
  resourceEncodedBytes: number;
  resourceDecodedBytes: number;
  byType: Record<string, { requestCount: number; transferBytes: number }>;
  slowest: CdpProfileNetworkRequest[];
}

export interface CdpProfileCoverageScript {
  url: string;
  totalBytes: number;
  usedBytes: number;
  unusedBytes: number;
}

export interface CdpProfileCoverage {
  scriptCount: number;
  totalBytes: number;
  usedBytes: number;
  unusedBytes: number;
  usedPercent: number;
  largestUnused: CdpProfileCoverageScript[];
}

export interface CdpProfileReport {
  version: 1;
  label?: string;
  url: string;
  startedAt: string;
  elapsedMs: number;
  runtime: CdpProfileRuntimeMetrics;
  page: CdpProfilePageMetrics;
  network: CdpProfileNetworkMetrics;
  coverage?: CdpProfileCoverage;
}

type MetricSnapshot = Map<string, number>;

type PageBaseline = {
  timeOrigin: number;
  now: number;
};

type PageSnapshot = {
  navigation?: CdpProfilePageMetrics["navigation"];
  firstContentfulPaintMs?: number;
  largestContentfulPaintMs?: number;
  cumulativeLayoutShift: number;
  layoutShiftCount: number;
  interactionLatencyMs?: number;
  longTasks: CdpProfilePageMetrics["longTasks"];
  resourceEncodedBytes: number;
  resourceDecodedBytes: number;
};

type NetworkRecord = CdpProfileNetworkRequest & {
  requestId: string;
  startedAt?: number;
  completedAt?: number;
};

type CoverageRange = { startOffset: number; endOffset: number; count: number };
type CoverageResult = {
  result?: Array<{
    url?: string;
    functions?: Array<{ ranges?: CoverageRange[] }>;
  }>;
};

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function safeUrl(raw: string): string {
  if (!raw) return "<anonymous>";
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return raw.length > 300 ? `${raw.slice(0, 297)}...` : raw;
  }
}

async function readMetrics(transport: ProtocolTransport): Promise<MetricSnapshot> {
  const response = (await transport.send("Performance.getMetrics")) as {
    metrics?: Array<{ name?: string; value?: number }>;
  };
  return new Map(
    (response.metrics ?? [])
      .filter(
        (metric): metric is { name: string; value: number } =>
          typeof metric.name === "string" &&
          typeof metric.value === "number" &&
          Number.isFinite(metric.value)
      )
      .map((metric) => [metric.name, metric.value])
  );
}

function metric(snapshot: MetricSnapshot, name: string): number {
  return snapshot.get(name) ?? 0;
}

function metricDelta(before: MetricSnapshot, after: MetricSnapshot, name: string): number {
  return Math.max(0, metric(after, name) - metric(before, name));
}

function runtimeMetrics(before: MetricSnapshot, after: MetricSnapshot): CdpProfileRuntimeMetrics {
  return {
    taskDurationMs: rounded(metricDelta(before, after, "TaskDuration") * 1_000),
    scriptDurationMs: rounded(metricDelta(before, after, "ScriptDuration") * 1_000),
    layoutDurationMs: rounded(metricDelta(before, after, "LayoutDuration") * 1_000),
    styleRecalcDurationMs: rounded(metricDelta(before, after, "RecalcStyleDuration") * 1_000),
    layoutCount: metricDelta(before, after, "LayoutCount"),
    styleRecalcCount: metricDelta(before, after, "RecalcStyleCount"),
    jsHeapUsedBytes: metric(after, "JSHeapUsedSize"),
    jsHeapDeltaBytes: metric(after, "JSHeapUsedSize") - metric(before, "JSHeapUsedSize"),
    nodes: metric(after, "Nodes"),
    documents: metric(after, "Documents"),
  };
}

async function readPageBaseline(page: ProfilePage): Promise<PageBaseline> {
  const result = (await page.evaluate(() => ({
    timeOrigin: performance.timeOrigin,
    now: performance.now(),
  }))) as Partial<PageBaseline> | undefined;
  return {
    timeOrigin: finite(result?.timeOrigin),
    now: finite(result?.now),
  };
}

async function readPageSnapshot(page: ProfilePage, baseline: PageBaseline): Promise<PageSnapshot> {
  const result = await page.evaluate(async (value?: unknown) => {
    // Marker used by protocol fakes and diagnostics to identify this bounded read.
    const __vibestudioProfileSnapshot = true;
    void __vibestudioProfileSnapshot;
    const start = value as { timeOrigin: number; now: number };
    const number = (candidate: unknown): number =>
      typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
    const sameDocument = performance.timeOrigin === start.timeOrigin;
    const cutoff = sameDocument ? start.now : 0;
    const afterCutoff = (entry: PerformanceEntry) => entry.startTime >= cutoff;

    const buffered = async (type: string): Promise<Array<Record<string, unknown>>> => {
      if (typeof PerformanceObserver !== "function") return [];
      return await new Promise((resolve) => {
        const entries: Array<Record<string, unknown>> = [];
        let observer: PerformanceObserver | undefined;
        try {
          observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (!afterCutoff(entry)) continue;
              const candidate = entry as PerformanceEntry & {
                hadRecentInput?: boolean;
                value?: number;
                interactionId?: number;
              };
              entries.push({
                startTime: candidate.startTime,
                duration: candidate.duration,
                hadRecentInput: candidate.hadRecentInput,
                value: candidate.value,
                interactionId: candidate.interactionId,
              });
            }
          });
          observer.observe({ type, buffered: true });
        } catch {
          observer?.disconnect();
          resolve([]);
          return;
        }
        setTimeout(() => {
          if (observer) {
            for (const entry of observer.takeRecords()) {
              if (!afterCutoff(entry)) continue;
              const candidate = entry as PerformanceEntry & {
                hadRecentInput?: boolean;
                value?: number;
                interactionId?: number;
              };
              entries.push({
                startTime: candidate.startTime,
                duration: candidate.duration,
                hadRecentInput: candidate.hadRecentInput,
                value: candidate.value,
                interactionId: candidate.interactionId,
              });
            }
            observer.disconnect();
          }
          resolve(entries);
        }, 0);
      });
    };

    const [largestPaint, layoutShifts, interactions, longTasks] = await Promise.all([
      buffered("largest-contentful-paint"),
      buffered("layout-shift"),
      buffered("event"),
      buffered("longtask"),
    ]);
    const resources = performance
      .getEntriesByType("resource")
      .filter(afterCutoff) as PerformanceResourceTiming[];
    const paints = performance.getEntriesByName("first-contentful-paint").filter(afterCutoff);
    const paint = paints[paints.length - 1];
    const navigations = performance.getEntriesByType("navigation");
    const navigation = !sameDocument
      ? (navigations[navigations.length - 1] as PerformanceNavigationTiming | undefined)
      : undefined;
    const shifts = layoutShifts.filter((entry) => entry["hadRecentInput"] !== true);
    const interactionDurations = interactions
      .filter((entry) => number(entry["interactionId"]) > 0)
      .map((entry) => number(entry["duration"]));
    const longTaskDurations = longTasks.map((entry) => number(entry["duration"]));

    return {
      ...(navigation
        ? {
            navigation: {
              ttfbMs: Math.max(0, navigation.responseStart - navigation.requestStart),
              responseStartMs: navigation.responseStart,
              domContentLoadedMs: navigation.domContentLoadedEventEnd,
              loadMs: navigation.loadEventEnd,
            },
          }
        : {}),
      ...(paint ? { firstContentfulPaintMs: paint.startTime } : {}),
      ...(largestPaint.length
        ? {
            largestContentfulPaintMs: Math.max(
              ...largestPaint.map((entry) => number(entry["startTime"]))
            ),
          }
        : {}),
      cumulativeLayoutShift: shifts.reduce((sum, entry) => sum + number(entry["value"]), 0),
      layoutShiftCount: shifts.length,
      ...(interactionDurations.length
        ? { interactionLatencyMs: Math.max(...interactionDurations) }
        : {}),
      longTasks: {
        count: longTaskDurations.length,
        totalDurationMs: longTaskDurations.reduce((sum, duration) => sum + duration, 0),
        maxDurationMs: longTaskDurations.length ? Math.max(...longTaskDurations) : 0,
      },
      resourceEncodedBytes: resources.reduce(
        (sum, resource) => sum + number(resource.encodedBodySize),
        0
      ),
      resourceDecodedBytes: resources.reduce(
        (sum, resource) => sum + number(resource.decodedBodySize),
        0
      ),
    };
  }, baseline);
  const snapshot = (result ?? {}) as Partial<PageSnapshot>;
  return {
    ...(snapshot.navigation ? { navigation: snapshot.navigation } : {}),
    ...(snapshot.firstContentfulPaintMs !== undefined
      ? { firstContentfulPaintMs: finite(snapshot.firstContentfulPaintMs) }
      : {}),
    ...(snapshot.largestContentfulPaintMs !== undefined
      ? { largestContentfulPaintMs: finite(snapshot.largestContentfulPaintMs) }
      : {}),
    cumulativeLayoutShift: finite(snapshot.cumulativeLayoutShift),
    layoutShiftCount: finite(snapshot.layoutShiftCount),
    ...(snapshot.interactionLatencyMs !== undefined
      ? { interactionLatencyMs: finite(snapshot.interactionLatencyMs) }
      : {}),
    longTasks: {
      count: finite(snapshot.longTasks?.count),
      totalDurationMs: finite(snapshot.longTasks?.totalDurationMs),
      maxDurationMs: finite(snapshot.longTasks?.maxDurationMs),
    },
    resourceEncodedBytes: finite(snapshot.resourceEncodedBytes),
    resourceDecodedBytes: finite(snapshot.resourceDecodedBytes),
  };
}

function pageMetrics(snapshot: PageSnapshot): CdpProfilePageMetrics {
  return {
    ...(snapshot.navigation ? { navigation: snapshot.navigation } : {}),
    ...(snapshot.firstContentfulPaintMs !== undefined
      ? { firstContentfulPaintMs: rounded(snapshot.firstContentfulPaintMs) }
      : {}),
    ...(snapshot.largestContentfulPaintMs !== undefined
      ? { largestContentfulPaintMs: rounded(snapshot.largestContentfulPaintMs) }
      : {}),
    cumulativeLayoutShift: rounded(snapshot.cumulativeLayoutShift),
    layoutShiftCount: snapshot.layoutShiftCount,
    ...(snapshot.interactionLatencyMs !== undefined
      ? { interactionLatencyMs: rounded(snapshot.interactionLatencyMs) }
      : {}),
    longTasks: {
      count: snapshot.longTasks.count,
      totalDurationMs: rounded(snapshot.longTasks.totalDurationMs),
      maxDurationMs: rounded(snapshot.longTasks.maxDurationMs),
    },
  };
}

function createNetworkCapture(transport: ProtocolTransport): {
  records: Map<string, NetworkRecord>;
  cleanup(): void;
} {
  const records = new Map<string, NetworkRecord>();
  const current = new Map<string, string>();
  const generations = new Map<string, number>();
  const cleanups: Array<() => void> = [];

  cleanups.push(
    transport.on("Network.requestWillBeSent", (raw) => {
      const event = raw as {
        requestId?: string;
        timestamp?: number;
        type?: string;
        request?: { url?: string; method?: string };
        redirectResponse?: { status?: number; mimeType?: string; encodedDataLength?: number };
      };
      if (!event.requestId) return;
      const priorKey = current.get(event.requestId);
      if (priorKey && event.redirectResponse) {
        const prior = records.get(priorKey);
        if (prior) {
          prior.status = finite(event.redirectResponse.status);
          prior.mimeType = event.redirectResponse.mimeType;
          prior.transferBytes = finite(event.redirectResponse.encodedDataLength);
          prior.completedAt = event.timestamp;
        }
      }
      const generation = (generations.get(event.requestId) ?? 0) + 1;
      generations.set(event.requestId, generation);
      const key = `${event.requestId}:${generation}`;
      current.set(event.requestId, key);
      records.set(key, {
        requestId: event.requestId,
        url: safeUrl(event.request?.url ?? ""),
        method: event.request?.method ?? "GET",
        type: event.type ?? "Other",
        transferBytes: 0,
        fromCache: false,
        startedAt: event.timestamp,
      });
    })
  );
  cleanups.push(
    transport.on("Network.responseReceived", (raw) => {
      const event = raw as {
        requestId?: string;
        type?: string;
        response?: {
          status?: number;
          mimeType?: string;
          fromDiskCache?: boolean;
          fromServiceWorker?: boolean;
        };
      };
      if (!event.requestId) return;
      const record = records.get(current.get(event.requestId) ?? "");
      if (!record) return;
      record.type = event.type ?? record.type;
      record.status = finite(event.response?.status);
      record.mimeType = event.response?.mimeType;
      record.fromCache = Boolean(
        record.fromCache || event.response?.fromDiskCache || event.response?.fromServiceWorker
      );
    })
  );
  cleanups.push(
    transport.on("Network.requestServedFromCache", (raw) => {
      const event = raw as { requestId?: string };
      if (!event.requestId) return;
      const record = records.get(current.get(event.requestId) ?? "");
      if (record) record.fromCache = true;
    })
  );
  cleanups.push(
    transport.on("Network.loadingFinished", (raw) => {
      const event = raw as { requestId?: string; timestamp?: number; encodedDataLength?: number };
      if (!event.requestId) return;
      const record = records.get(current.get(event.requestId) ?? "");
      if (!record) return;
      record.completedAt = event.timestamp;
      record.transferBytes = finite(event.encodedDataLength);
    })
  );
  cleanups.push(
    transport.on("Network.loadingFailed", (raw) => {
      const event = raw as { requestId?: string; timestamp?: number; errorText?: string };
      if (!event.requestId) return;
      const record = records.get(current.get(event.requestId) ?? "");
      if (!record) return;
      record.completedAt = event.timestamp;
      record.failedReason = event.errorText ?? "Network request failed";
    })
  );

  return {
    records,
    cleanup: () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

function networkMetrics(
  records: Map<string, NetworkRecord>,
  page: PageSnapshot,
  maxRecords: number
): CdpProfileNetworkMetrics {
  const requests = [...records.values()].map((record): CdpProfileNetworkRequest => {
    const durationMs =
      record.startedAt !== undefined && record.completedAt !== undefined
        ? Math.max(0, (record.completedAt - record.startedAt) * 1_000)
        : undefined;
    return {
      url: record.url,
      method: record.method,
      type: record.type,
      ...(record.status !== undefined ? { status: record.status } : {}),
      ...(record.mimeType ? { mimeType: record.mimeType } : {}),
      ...(durationMs !== undefined ? { durationMs: rounded(durationMs) } : {}),
      transferBytes: record.transferBytes,
      fromCache: record.fromCache,
      ...(record.failedReason ? { failedReason: record.failedReason } : {}),
    };
  });
  const byType: CdpProfileNetworkMetrics["byType"] = {};
  for (const request of requests) {
    const aggregate = byType[request.type] ?? { requestCount: 0, transferBytes: 0 };
    aggregate.requestCount += 1;
    aggregate.transferBytes += request.transferBytes;
    byType[request.type] = aggregate;
  }
  return {
    requestCount: requests.length,
    failedCount: requests.filter((request) => request.failedReason).length,
    cacheHits: requests.filter((request) => request.fromCache).length,
    transferBytes: requests.reduce((sum, request) => sum + request.transferBytes, 0),
    resourceEncodedBytes: page.resourceEncodedBytes,
    resourceDecodedBytes: page.resourceDecodedBytes,
    byType,
    slowest: requests
      .filter((request) => request.durationMs !== undefined)
      .sort((left, right) => (right.durationMs ?? 0) - (left.durationMs ?? 0))
      .slice(0, maxRecords),
  };
}

function usedBytesForScript(ranges: CoverageRange[]): { totalBytes: number; usedBytes: number } {
  const valid = ranges.filter(
    (range) =>
      Number.isFinite(range.startOffset) &&
      Number.isFinite(range.endOffset) &&
      range.endOffset > range.startOffset
  );
  const totalBytes = valid.reduce((largest, range) => Math.max(largest, range.endOffset), 0);
  const boundaries = [
    ...new Set(valid.flatMap((range) => [range.startOffset, range.endOffset])),
  ].sort((left, right) => left - right);
  let usedBytes = 0;
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index]!;
    const end = boundaries[index + 1]!;
    const owning = valid
      .filter((range) => range.startOffset <= start && range.endOffset >= end)
      .sort(
        (left, right) => left.endOffset - left.startOffset - (right.endOffset - right.startOffset)
      )[0];
    if (owning && owning.count > 0) usedBytes += end - start;
  }
  return { totalBytes, usedBytes };
}

function coverageMetrics(raw: CoverageResult): CdpProfileCoverage {
  const scripts = (raw.result ?? []).map((script): CdpProfileCoverageScript => {
    const ranges = (script.functions ?? []).flatMap((fn) => fn.ranges ?? []);
    const { totalBytes, usedBytes } = usedBytesForScript(ranges);
    return {
      url: safeUrl(script.url ?? ""),
      totalBytes,
      usedBytes,
      unusedBytes: Math.max(0, totalBytes - usedBytes),
    };
  });
  const totalBytes = scripts.reduce((sum, script) => sum + script.totalBytes, 0);
  const usedBytes = scripts.reduce((sum, script) => sum + script.usedBytes, 0);
  return {
    scriptCount: scripts.length,
    totalBytes,
    usedBytes,
    unusedBytes: Math.max(0, totalBytes - usedBytes),
    usedPercent: totalBytes > 0 ? rounded((usedBytes / totalBytes) * 100) : 100,
    largestUnused: scripts
      .filter((script) => script.unusedBytes > 0)
      .sort((left, right) => right.unusedBytes - left.unusedBytes)
      .slice(0, 20),
  };
}

export async function runCdpProfile(input: {
  page: ProfilePage;
  transport: ProtocolTransport;
  action: () => unknown | Promise<unknown>;
  options?: CdpProfileOptions;
}): Promise<CdpProfileReport> {
  const options = input.options ?? {};
  const maxNetworkRecords = options.maxNetworkRecords ?? 20;
  if (!Number.isInteger(maxNetworkRecords) || maxNetworkRecords < 1 || maxNetworkRecords > 100) {
    throw new TypeError("maxNetworkRecords must be an integer from 1 through 100");
  }

  const network = createNetworkCapture(input.transport);
  let coverageStarted = false;
  let cacheDisabled = false;
  try {
    await Promise.all([
      input.transport.send("Network.enable"),
      input.transport.send("Performance.enable"),
    ]);
    if (options.disableCache) {
      await input.transport.send("Network.setCacheDisabled", { cacheDisabled: true });
      cacheDisabled = true;
    }
    if (options.javascriptCoverage) {
      await input.transport.send("Profiler.enable");
      await input.transport.send("Profiler.startPreciseCoverage", {
        callCount: false,
        detailed: true,
        allowTriggeredUpdates: false,
      });
      coverageStarted = true;
    }

    const [before, baseline] = await Promise.all([
      readMetrics(input.transport),
      readPageBaseline(input.page),
    ]);
    const startedAt = new Date();
    const actionStartedAt = performance.now();
    await input.action();
    const elapsedMs = performance.now() - actionStartedAt;
    const [after, page, rawCoverage] = await Promise.all([
      readMetrics(input.transport),
      readPageSnapshot(input.page, baseline),
      coverageStarted
        ? (input.transport.send("Profiler.takePreciseCoverage") as Promise<CoverageResult>)
        : Promise.resolve(undefined),
    ]);

    return {
      version: 1,
      ...(options.label ? { label: options.label } : {}),
      url: safeUrl(input.page.url()),
      startedAt: startedAt.toISOString(),
      elapsedMs: rounded(elapsedMs),
      runtime: runtimeMetrics(before, after),
      page: pageMetrics(page),
      network: networkMetrics(network.records, page, maxNetworkRecords),
      ...(rawCoverage ? { coverage: coverageMetrics(rawCoverage) } : {}),
    };
  } finally {
    network.cleanup();
    const cleanup: Array<Promise<unknown>> = [];
    if (coverageStarted) {
      cleanup.push(input.transport.send("Profiler.stopPreciseCoverage").catch(() => undefined));
      cleanup.push(input.transport.send("Profiler.disable").catch(() => undefined));
    }
    if (cacheDisabled) {
      cleanup.push(
        input.transport
          .send("Network.setCacheDisabled", { cacheDisabled: false })
          .catch(() => undefined)
      );
    }
    cleanup.push(input.transport.send("Performance.disable").catch(() => undefined));
    cleanup.push(input.transport.send("Network.disable").catch(() => undefined));
    await Promise.all(cleanup);
  }
}
