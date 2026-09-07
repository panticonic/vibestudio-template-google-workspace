import { envelopeFromMessage, type RpcEnvelope } from "@vibestudio/rpc";

export interface GatewayFetchConfig {
  serverUrl: string;
  token: string;
  /**
   * Constrain the helper to the configured gateway origin: relative paths and
   * absolute URLs on that same origin are accepted, while cross-origin targets
   * are rejected. External requests belong in `credentials.fetch` (the egress
   * proxy), not in an authenticated gateway helper.
   */
  relativeOnly?: boolean;
}

export type GatewayFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** Server RPC method that performs an authenticated gateway-relative fetch for
 * a panel principal and streams the response back over the pipe. The handler is
 * wired server-side (orchestrator seam); the panel's logical session — not a
 * bearer header on a loopback HTTP request — is the auth. */
const GATEWAY_FETCH_METHOD = "gateway.fetch";

type ShellStreamBridge = {
  stream: (
    envelope: RpcEnvelope,
    signal?: AbortSignal | null,
    body?: ReadableStream<Uint8Array> | null
  ) => Promise<Response>;
};

function getShellBridge(): unknown {
  return (globalThis as any).__vibestudioShell;
}

export interface GatewayFetchDeps {
  /**
   * The panel RPC client's `stream(targetId, method, args)` → Response. It
   * transparently falls back to the duplex stream-request/stream-frame envelope
   * path when the host bridge exposes no first-class `stream()` (the case on both
   * mobile and desktop), so panel gatewayFetch prefers it over a direct
   * `shell.stream()`. Server-side contexts (worker/eval) omit it — they fetch the
   * loopback gateway directly and never tunnel.
   *
   * `options.body` is the streaming REQUEST body (plan §1.6 — uploads ride the
   * bulk channel, never base64 inside the descriptor). Transports without a
   * body-capable stream path THROW when one is passed — fail loud, no fallback.
   */
  rpcStream?: (
    targetId: string,
    method: string,
    args: unknown[],
    options?: { signal?: AbortSignal | null; body?: ReadableStream<Uint8Array> | null }
  ) => Promise<Response>;
}

export function createGatewayFetch(
  config: GatewayFetchConfig,
  deps: GatewayFetchDeps = {}
): GatewayFetch {
  const baseUrl = config.serverUrl.replace(/\/$/, "");
  const baseOrigin = (() => {
    try {
      return new URL(baseUrl).origin;
    } catch {
      return null;
    }
  })();
  // A panel runs inside a webview reached through the shell bridge; a worker /
  // EvalDO runs server-side, co-located with the gateway. Only the panel must
  // tunnel — the server-side contexts can reach the loopback gateway directly.
  const inPanel = !!getShellBridge();
  // The public helper is gateway-scoped by default. A caller must explicitly
  // opt out (only for a trusted host-side integration) before it can target a
  // different origin and attach the configured bearer.
  const relativeOnly = config.relativeOnly ?? true;

  return async (path, init = {}) => {
    // Resolve the gateway-relative target and keep the relativeOnly guard exactly.
    let target: string;
    if (relativeOnly) {
      if (!baseOrigin) {
        throw new Error("gatewayFetch: gateway origin is not configured");
      }
      // Resolve against the gateway base; reject anything that escapes its origin.
      const resolved = new URL(path, `${baseUrl}/`);
      if (resolved.origin !== baseOrigin) {
        throw new Error(
          `gatewayFetch: only gateway-relative paths are allowed (got "${path}"). ` +
            `Use credentials.fetch for external requests.`,
        );
      }
      target = resolved.toString();
    } else {
      target =
        path.startsWith("http://") || path.startsWith("https://")
          ? path
          : `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    }

    if (inPanel) {
      // Panel: tunnel over the shell bridge. No bearer ever rides an HTTP plane;
      // the panel's authenticated logical session on the pipe is the auth.
      return tunnelOverBridge(target, baseUrl);
    }

    // Worker / EvalDO (server-side, co-located with the gateway): a direct
    // loopback fetch with the bearer. There is no remote origin and no TLS
    // pinning here, so this never leaves the host.
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${config.token}`);
    return fetch(target, { ...init, headers });

    async function tunnelOverBridge(absoluteTarget: string, gatewayBase: string): Promise<Response> {
      const entityId = (globalThis as any).__vibestudioEntityId as string | undefined;
      if (typeof entityId !== "string" || entityId.length === 0) {
        throw new Error("gatewayFetch: panel entity id is unavailable");
      }
      // The home server reaches its OWN gateway, so pass a gateway-relative path.
      const gatewayPath = toGatewayRelativePath(absoluteTarget, gatewayBase);
      const probe = new Request(absoluteTarget, init);
      const headers = Object.fromEntries(probe.headers.entries());
      // Request bodies stream over the pipe's bulk channel (plan §1.6) — never
      // as base64 inside the descriptor (the server's schema rejects that).
      // Buffered here (webview bodies are already in memory on a Request) then
      // handed off as a one-chunk stream.
      const bodyBuffer = await probe.arrayBuffer();
      const body: ReadableStream<Uint8Array> | null =
        bodyBuffer.byteLength > 0
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(bodyBuffer));
                controller.close();
              },
            })
          : null;
      const descriptor = {
        path: gatewayPath,
        method: (init.method ?? probe.method ?? "GET").toUpperCase(),
        headers,
      };
      // Prefer the RPC client's stream: it transparently falls back to the duplex
      // stream-request/stream-frame envelope path when the host bridge exposes no
      // first-class stream() (the case on both mobile and desktop). Only with no
      // rpcStream wired do we require a direct shell.stream() — then a missing one
      // is a real, loud error rather than the silent default. A body over a
      // transport with no body-capable stream path throws loudly (plan §1.6).
      if (deps.rpcStream) {
        return deps.rpcStream("main", GATEWAY_FETCH_METHOD, [descriptor], {
          signal: init.signal ?? null,
          body,
        });
      }
      const shell = getShellBridge() as Partial<ShellStreamBridge> | undefined;
      if (!shell || typeof shell.stream !== "function") {
        throw new Error(
          "gatewayFetch: no rpcStream wired and shell bridge stream() is unavailable; " +
            "panel gateway fetches must ride the host pipe (no authenticated loopback HTTP).",
        );
      }
      const envelope = envelopeFromMessage({
        selfId: entityId,
        from: entityId,
        target: "main",
        callerKind: "panel",
        message: {
          type: "stream-request",
          requestId: crypto.randomUUID(),
          fromId: entityId,
          method: GATEWAY_FETCH_METHOD,
          args: [descriptor],
        },
      });
      return (shell as ShellStreamBridge).stream(envelope, init.signal ?? null, body);
    }
  };
}

/** Reduce an absolute gateway URL to its `path?query#hash` for the server to
 * re-issue against its own gateway. */
function toGatewayRelativePath(absoluteTarget: string, gatewayBase: string): string {
  try {
    const resolved = new URL(absoluteTarget, `${gatewayBase}/`);
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return absoluteTarget;
  }
}
