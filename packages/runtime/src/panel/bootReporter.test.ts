import { describe, expect, it, vi } from "vitest";
import type { RpcConnectionStatus } from "@vibestudio/rpc";
import type { PanelBootObservation } from "@vibestudio/shared/panel/observation";
import { createPanelBootReporter } from "./bootReporter.js";

const observation = (boot: PanelBootObservation) => ({
  url: "http://panel.test/",
  loading: boot.phase !== "ready",
  boot: { kind: "observed" as const, observation: boot },
});

const view = (boot: PanelBootObservation) => ({
  url: "http://panel.test/",
  loading: boot.phase !== "ready",
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness() {
  let status: RpcConnectionStatus = "connected";
  const listeners = new Set<(next: RpcConnectionStatus) => void>();
  const call = vi.fn<(...args: unknown[]) => Promise<"reported" | "stale">>();
  const onError = vi.fn();
  const reporter = createPanelBootReporter({
    rpc: {
      call,
      status: () => status,
      onStatusChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    observeView: view,
    onError,
  });
  return {
    call,
    onError,
    reporter,
    setStatus(next: RpcConnectionStatus) {
      status = next;
      for (const listener of listeners) listener(next);
    },
    listenerCount: () => listeners.size,
  };
}

describe("createPanelBootReporter", () => {
  it("serializes transitions and preserves the newest evidence", async () => {
    const h = harness();
    const first = deferred<"reported">();
    h.call.mockReturnValueOnce(first.promise).mockResolvedValueOnce("reported");

    h.reporter.publish({ phase: "booting" });
    h.reporter.publish({ phase: "ready" });
    expect(h.call).toHaveBeenCalledTimes(1);

    first.resolve("reported");
    await vi.waitFor(() => expect(h.call).toHaveBeenCalledTimes(2));
    expect(h.call.mock.calls[1]?.[2]).toEqual([observation({ phase: "ready" })]);
  });

  it("retains ambiguous evidence across disconnect and retries on reconnect", async () => {
    const h = harness();
    const first = deferred<"reported">();
    h.call.mockReturnValueOnce(first.promise).mockResolvedValueOnce("reported");
    h.reporter.publish({ phase: "booting" });

    h.setStatus("disconnected");
    first.reject(new Error("connection lost"));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.onError).not.toHaveBeenCalled();

    h.setStatus("connected");
    await vi.waitFor(() => expect(h.call).toHaveBeenCalledTimes(2));
  });

  it("retires a stale renderer instead of publishing into a replacement lease", async () => {
    const h = harness();
    h.call.mockResolvedValue("stale");
    h.reporter.publish({ phase: "booting" });
    await vi.waitFor(() => expect(h.call).toHaveBeenCalledTimes(1));

    h.reporter.publish({ phase: "ready" });
    h.setStatus("disconnected");
    h.setStatus("connected");
    await Promise.resolve();
    expect(h.call).toHaveBeenCalledTimes(1);
  });

  it("surfaces connected failures without spinning", async () => {
    const h = harness();
    h.call.mockRejectedValue(new Error("forbidden"));
    h.reporter.publish({ phase: "booting" });
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(1));
    expect(h.call).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes and drops pending evidence when disposed", () => {
    const h = harness();
    h.setStatus("disconnected");
    h.reporter.publish({ phase: "booting" });
    h.reporter.dispose();
    expect(h.listenerCount()).toBe(0);
    h.setStatus("connected");
    expect(h.call).not.toHaveBeenCalled();
  });
});
