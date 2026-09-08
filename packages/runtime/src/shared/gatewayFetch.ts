import type { RpcClient } from "@vibestudio/rpc";

/** Direct authenticated HTTP is for server-hosted runtimes only. */
export interface GatewayFetchConfig {
  serverUrl: string;
  token: string;
}

/** Browser runtimes use their authenticated RPC connection, with no bearer. */
export interface GatewayRpcFetchConfig {
  rpc: Pick<RpcClient, "stream">;
  /** Optional URL recognition for existing absolute gateway links. */
  serverUrl?: string;
}

export type GatewayFetch = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

/** The host chooses transport explicitly; application globals never select authority. */
export function createGatewayFetch(
  config: GatewayFetchConfig | GatewayRpcFetchConfig,
): GatewayFetch {
  const base = config.serverUrl ? new URL(config.serverUrl) : null;
  if (!("rpc" in config) && !base) {
    throw new Error("gatewayFetch: direct HTTP requires a gateway origin");
  }
  if (
    base &&
    (!["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password)
  ) {
    throw new Error("gatewayFetch: invalid gateway origin");
  }
  if ("rpc" in config && typeof config.rpc.stream !== "function") {
    throw new Error("gatewayFetch: RPC stream transport is unavailable");
  }
  return async (path, init = {}) => {
    let relative: string;
    let absolute: string | undefined;
    if (base) {
      const resolved = new URL(
        path,
        base.href.endsWith("/") ? base.href : base.href + "/",
      );
      if (
        resolved.origin !== base.origin ||
        resolved.username ||
        resolved.password
      ) {
        throw new Error(
          "gatewayFetch: only gateway-relative paths are allowed; use credentials.fetch for external requests",
        );
      }
      absolute = resolved.href;
      relative = resolved.pathname + resolved.search;
    } else {
      // Without a gateway URL the API accepts paths, never network destinations.
      if (
        !path ||
        /^[a-z][a-z0-9+.-]*:/i.test(path) ||
        path.startsWith("//") ||
        /[\\\r\n\t]/.test(path)
      ) {
        throw new Error(
          "gatewayFetch: only gateway-relative paths are allowed",
        );
      }
      relative = (path.startsWith("/") ? path : "/" + path).split("#", 1)[0]!;
    }
    if ("rpc" in config) {
      const method = (init.method ?? "GET").toUpperCase();
      if ((method === "GET" || method === "HEAD") && init.body != null) {
        throw new TypeError("Request with GET/HEAD method cannot have body");
      }
      // The standard BodyInit serializer preserves FormData boundaries and streaming
      // bodies. No buffering, base64 encoding, host URL or page identity is needed.
      const payload = new Response(init.body ?? null, {
        headers: init.headers,
      });
      return config.rpc.stream(
        "main",
        "gateway.fetch",
        [
          {
            path: relative,
            method,
            headers: Object.fromEntries(payload.headers.entries()),
          },
        ],
        { signal: init.signal ?? undefined, body: payload.body },
      );
    }
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${config.token}`);
    return fetch(absolute!, { ...init, headers });
  };
}
