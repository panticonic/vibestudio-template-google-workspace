/**
 * Client for the testkit-driver DO (workspace/workers/testkit-driver).
 *
 * Panel callers may not open CDP sessions to workspace panels directly
 * (panelCdp policy); the driver DO performs those operations as a DO caller
 * under the panel-access approval flow. This module exposes the DO's
 * session protocol as a RawCdpSession and registers itself as the routing
 * fallback in cdp.ts — importing "@workspace/testkit" activates it.
 */
import { createDurableObjectServiceClient } from "@workspace/runtime";
import type { PanelHandle } from "@workspace/runtime";
import { _registerDriverRoute, type RawCdpSession } from "./cdp.js";
import type { ProfileRef } from "./profile-core.js";

const DRIVER_PROTOCOL = "vibestudio.testkit-driver.v1";
const EVENT_POLL_INTERVAL_MS = 250;

type DriverClient = { call<T = unknown>(method: string, ...args: unknown[]): Promise<T> };

let _client: DriverClient | null = null;

function driverClient(): DriverClient {
  _client ??= createDurableObjectServiceClient(DRIVER_PROTOCOL) as DriverClient;
  return _client;
}

/** Driver-backed RawCdpSession: events arrive via cursor polling. */
async function openDriverSession(handle: PanelHandle): Promise<RawCdpSession> {
  const client = driverClient();
  const { sessionId } = await client.call<{ sessionId: string }>("cdpOpen", handle.id);

  const listeners = new Map<string, Set<(params: unknown) => void>>();
  let cursor = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const drain = async (): Promise<void> => {
    if (closed || listeners.size === 0) return;
    const result = await client
      .call<{ events: Array<{ seq: number; method: string; params: unknown }>; cursor: number }>(
        "cdpDrainEvents",
        sessionId,
        cursor
      )
      .catch(() => null);
    if (!result || closed) return;
    cursor = result.cursor;
    for (const event of result.events) {
      for (const listener of listeners.get(event.method) ?? []) listener(event.params);
    }
  };

  const ensurePolling = (): void => {
    pollTimer ??= setInterval(() => void drain(), EVENT_POLL_INTERVAL_MS);
  };

  return {
    send: (method, params) => client.call("cdpSend", sessionId, method, params),
    on: (method, listener) => {
      const set = listeners.get(method) ?? new Set();
      set.add(listener);
      listeners.set(method, set);
      void client.call("cdpSubscribe", sessionId, method);
      ensurePolling();
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(method);
      };
    },
    close: () => {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      // Final drain so trailing events (e.g. heap snapshot chunks) are not
      // lost, then close the remote session.
      void drain().finally(() => void client.call("cdpClose", sessionId).catch(() => undefined));
    },
  };
}

/** Fixed-duration CPU profile of any panel, captured driver-side. */
export async function driverProfilePanel(
  handle: PanelHandle | string,
  opts?: { durationMs?: number; samplingIntervalUs?: number }
): Promise<ProfileRef> {
  const panelId = typeof handle === "string" ? handle : handle.id;
  return driverClient().call<ProfileRef>("profilePanel", panelId, opts);
}

/** Heap snapshot of any panel, captured driver-side (artifact on context fs). */
export async function driverHeapSnapshot(handle: PanelHandle | string): Promise<ProfileRef> {
  const panelId = typeof handle === "string" ? handle : handle.id;
  return driverClient().call<ProfileRef>("heapSnapshot", panelId);
}

/** Readiness probe; resolving the service builds/starts the worker on demand. */
export async function driverPing(): Promise<{ ok: boolean; sessions: number }> {
  return driverClient().call("ping");
}

_registerDriverRoute(async (handle) => openDriverSession(handle));
