import { describe, expect, it, vi } from "vitest";

import { runCdpProfile } from "./profile";

function metricResponse(values: Record<string, number>) {
  return { metrics: Object.entries(values).map(([name, value]) => ({ name, value })) };
}

class FakeTransport {
  readonly sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();
  private metricRead = 0;

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params });
    if (method === "Performance.getMetrics") {
      this.metricRead += 1;
      return this.metricRead === 1
        ? metricResponse({
            TaskDuration: 1,
            ScriptDuration: 0.4,
            LayoutDuration: 0.1,
            RecalcStyleDuration: 0.05,
            LayoutCount: 10,
            RecalcStyleCount: 20,
            JSHeapUsedSize: 1_000,
            Nodes: 100,
            Documents: 2,
          })
        : metricResponse({
            TaskDuration: 1.08,
            ScriptDuration: 0.45,
            LayoutDuration: 0.11,
            RecalcStyleDuration: 0.052,
            LayoutCount: 12,
            RecalcStyleCount: 23,
            JSHeapUsedSize: 1_500,
            Nodes: 110,
            Documents: 2,
          });
    }
    if (method === "Profiler.takePreciseCoverage") {
      return {
        result: [
          {
            url: "https://example.com/bundle.js?token=secret#fragment",
            functions: [
              {
                ranges: [
                  { startOffset: 0, endOffset: 100, count: 1 },
                  { startOffset: 20, endOffset: 80, count: 0 },
                  { startOffset: 40, endOffset: 60, count: 1 },
                ],
              },
            ],
          },
        ],
      };
    }
    return {};
  }

  on(method: string, listener: (params: unknown) => void): () => void {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  emit(method: string, params: unknown): void {
    for (const listener of this.listeners.get(method) ?? []) listener(params);
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}

function fakePage() {
  let reads = 0;
  return {
    url: () => "https://example.com/panel?credential=secret#state",
    evaluate: vi.fn(async () => {
      reads += 1;
      if (reads === 1) return { timeOrigin: 1_000, now: 50 };
      return {
        navigation: {
          ttfbMs: 12,
          responseStartMs: 20,
          domContentLoadedMs: 40,
          loadMs: 55,
        },
        firstContentfulPaintMs: 30,
        largestContentfulPaintMs: 45,
        cumulativeLayoutShift: 0.01,
        layoutShiftCount: 1,
        interactionLatencyMs: 24,
        longTasks: { count: 1, totalDurationMs: 60, maxDurationMs: 60 },
        resourceEncodedBytes: 800,
        resourceDecodedBytes: 1_200,
      };
    }),
  };
}

describe("CDP bounded profiling", () => {
  it("reads resource timing after a cross-document action in the isolated page realm", async () => {
    const transport = new FakeTransport();
    let timeOrigin = 1_000;
    const resource = {
      startTime: 4,
      encodedBodySize: 321,
      decodedBodySize: 654,
    };
    const navigation = {
      startTime: 0,
      requestStart: 1,
      responseStart: 3,
      domContentLoadedEventEnd: 8,
      loadEventEnd: 10,
    };
    const performance = {
      get timeOrigin() {
        return timeOrigin;
      },
      now: () => 12,
      getEntriesByType: (type: string) =>
        type === "resource" ? [resource] : type === "navigation" ? [navigation] : [],
      getEntriesByName: () => [],
    };
    const page = {
      url: () => "https://example.com/panel",
      evaluate: vi.fn(async (pageFunction: string | ((arg?: unknown) => unknown), arg?: unknown) => {
        if (typeof pageFunction !== "function") throw new Error("expected an evaluation function");
        // CDP serializes function source into the target realm. Reconstructing
        // it here prevents module-scope helpers from accidentally making a
        // browser callback look valid in unit tests.
        const isolated = Function(
          "performance",
          "PerformanceObserver",
          `return (${pageFunction.toString()});`
        )(performance, undefined) as (value?: unknown) => unknown;
        return isolated(arg);
      }),
    };

    const report = await runCdpProfile({
      page,
      transport,
      action: () => {
        timeOrigin = 2_000;
      },
    });

    expect(report.page.navigation).toEqual({
      ttfbMs: 2,
      responseStartMs: 3,
      domContentLoadedMs: 8,
      loadMs: 10,
    });
    expect(report.network).toMatchObject({
      resourceEncodedBytes: 321,
      resourceDecodedBytes: 654,
    });
  });

  it("reports runtime, page, network, and optional coverage measurements", async () => {
    const transport = new FakeTransport();
    const page = fakePage();

    const report = await runCdpProfile({
      page,
      transport,
      options: {
        label: "cold panel load",
        disableCache: true,
        javascriptCoverage: true,
        maxNetworkRecords: 5,
      },
      action: () => {
        transport.emit("Network.requestWillBeSent", {
          requestId: "request-1",
          timestamp: 10,
          type: "Script",
          request: {
            url: "https://example.com/bundle.js?signature=sensitive",
            method: "GET",
          },
        });
        transport.emit("Network.responseReceived", {
          requestId: "request-1",
          type: "Script",
          response: { status: 200, mimeType: "text/javascript" },
        });
        transport.emit("Network.loadingFinished", {
          requestId: "request-1",
          timestamp: 10.025,
          encodedDataLength: 640,
        });
      },
    });

    expect(report).toMatchObject({
      version: 1,
      label: "cold panel load",
      url: "https://example.com/panel",
      runtime: {
        taskDurationMs: 80,
        scriptDurationMs: 50,
        layoutDurationMs: 10,
        styleRecalcDurationMs: 2,
        layoutCount: 2,
        styleRecalcCount: 3,
        jsHeapUsedBytes: 1_500,
        jsHeapDeltaBytes: 500,
      },
      page: {
        firstContentfulPaintMs: 30,
        largestContentfulPaintMs: 45,
        interactionLatencyMs: 24,
        longTasks: { count: 1, totalDurationMs: 60, maxDurationMs: 60 },
      },
      network: {
        requestCount: 1,
        transferBytes: 640,
        resourceEncodedBytes: 800,
        resourceDecodedBytes: 1_200,
        byType: { Script: { requestCount: 1, transferBytes: 640 } },
        slowest: [
          expect.objectContaining({
            url: "https://example.com/bundle.js",
            durationMs: 25,
          }),
        ],
      },
      coverage: {
        scriptCount: 1,
        totalBytes: 100,
        usedBytes: 60,
        unusedBytes: 40,
        usedPercent: 60,
        largestUnused: [
          expect.objectContaining({ url: "https://example.com/bundle.js", unusedBytes: 40 }),
        ],
      },
    });
    expect(report.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(transport.listenerCount()).toBe(0);
    expect(transport.sent).toContainEqual({
      method: "Network.setCacheDisabled",
      params: { cacheDisabled: false },
    });
    expect(transport.sent.map(({ method }) => method)).toEqual(
      expect.arrayContaining([
        "Performance.enable",
        "Performance.disable",
        "Profiler.startPreciseCoverage",
        "Profiler.stopPreciseCoverage",
        "Network.enable",
        "Network.disable",
      ])
    );
  });

  it("always restores profiling domains when the measured action fails", async () => {
    const transport = new FakeTransport();
    const failure = new Error("interaction failed");

    await expect(
      runCdpProfile({
        page: fakePage(),
        transport,
        options: { disableCache: true, javascriptCoverage: true },
        action: () => {
          throw failure;
        },
      })
    ).rejects.toBe(failure);

    expect(transport.listenerCount()).toBe(0);
    expect(transport.sent).toContainEqual({
      method: "Network.setCacheDisabled",
      params: { cacheDisabled: false },
    });
    expect(transport.sent.map(({ method }) => method)).toEqual(
      expect.arrayContaining([
        "Performance.disable",
        "Profiler.stopPreciseCoverage",
        "Profiler.disable",
        "Network.disable",
      ])
    );
  });

  it("rejects unbounded network retention", async () => {
    await expect(
      runCdpProfile({
        page: fakePage(),
        transport: new FakeTransport(),
        options: { maxNetworkRecords: 101 },
        action: () => undefined,
      })
    ).rejects.toThrow("maxNetworkRecords must be an integer from 1 through 100");
  });
});
