/**
 * Raw CDP session helper over a panel's CDP endpoint.
 *
 * Browser panels: connect directly (panel callers are allowed). Workspace
 * panels: panel callers are denied by panelCdp policy — those route through
 * the testkit-driver DO once registered (see driver.ts); until then the
 * server's policy error propagates with its own remediation hint.
 */
import { CdpConnection } from "@workspace/cdp-client";
import type { PanelHandle } from "@workspace/runtime";

export interface RawCdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(method: string, listener: (params: unknown) => void): () => void;
  close(): void;
}

type SessionRoute = (handle: PanelHandle) => Promise<RawCdpSession | null>;

// Phase-2 hook: driver.ts registers a route that proxies workspace-panel
// sessions through the testkit-driver DO.
let driverRoute: SessionRoute | null = null;

export function _registerDriverRoute(route: SessionRoute): void {
  driverRoute = route;
}

async function connectDirect(handle: PanelHandle): Promise<RawCdpSession> {
  const endpoint = await handle.cdp.getCdpEndpoint();
  const connection = await CdpConnection.connect(
    endpoint.wsEndpoint,
    (endpoint as { token?: string }).token
  );
  return {
    send: (method, params) => connection.send(method, params),
    on: (method, listener) => connection.on(method, listener),
    close: () => connection.close(),
  };
}

/** Open a raw CDP session to a panel, routing via the driver DO when needed. */
export async function rawCdpSession(handle: PanelHandle): Promise<RawCdpSession> {
  if (handle.kind !== "browser" && driverRoute) {
    const routed = await driverRoute(handle);
    if (routed) return routed;
  }
  return connectDirect(handle);
}

/** Run `fn` with a session that is always closed afterwards. */
export async function withCdpSession<T>(
  handle: PanelHandle,
  fn: (session: RawCdpSession) => Promise<T>
): Promise<T> {
  const session = await rawCdpSession(handle);
  try {
    return await fn(session);
  } finally {
    session.close();
  }
}
