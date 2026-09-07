/**
 * URL-bound model credential fetch proxy — port of the pre-rewrite vessel's
 * `installUrlBoundModelFetchProxy` (HTTP/SSE path).
 *
 * The agent DO never holds a raw model credential. The model SDK (pi-ai) is
 * given a SENTINEL apiKey; this module patches the global `fetch` so any
 * request bearing the sentinel Authorization to a registered model base URL
 * is stripped of the sentinel and rerouted through the credential-injecting
 * `credentials.proxyFetch` stream (the server injects the real token; SSE
 * responses arrive as a real ReadableStream via `rpc.stream`).
 *
 * Requests with a sentinel to a NON-registered URL are refused — the sentinel
 * marks "this request expects a URL-bound credential", and sending it
 * anywhere else would silently call the provider unauthenticated.
 *
 * WebSocket upgrades use the same URL-bound credential contract: provider
 * headers are encoded into proxy metadata and the server-side egress proxy
 * injects the real credential during the upgrade.
 */

export const URL_BOUND_MODEL_CREDENTIAL_SENTINEL = "vibestudio-url-bound-model-credential";
const URL_BOUND_MODEL_CREDENTIAL_SENTINEL_CLAIM =
  "https://vibestudio.local/url-bound-model-credential";

export type CredentialedFetcher = (url: string, init?: RequestInit) => Promise<Response>;

interface ProxyState {
  originalFetch: typeof fetch;
  routes: Map<string, CredentialedFetcher>;
}

type ProxyGlobals = typeof globalThis & {
  __vibestudioModelFetchProxyState?: ProxyState;
  __vibestudioModelFetchProxyInstalled?: boolean;
  __vibestudioShouldReuseCodexWebSocket?: () => boolean;
};

function base64UrlJson(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Mint the sentinel apiKey. With provider claims (e.g. openai-codex's
 *  chatgpt_account_id) the sentinel is JWT-shaped so SDK layers that parse
 *  the bearer for identity claims keep working; the fetch proxy still strips
 *  it before anything leaves the DO. */
export function createModelCredentialSentinel(
  providerClaims: Record<string, unknown> = {}
): string {
  if (Object.keys(providerClaims).length === 0) {
    return URL_BOUND_MODEL_CREDENTIAL_SENTINEL;
  }
  return [
    "vibestudio",
    base64UrlJson({
      [URL_BOUND_MODEL_CREDENTIAL_SENTINEL_CLAIM]: true,
      ...providerClaims,
    }),
    "url-bound",
  ].join(".");
}

export function isModelCredentialSentinel(value: string): boolean {
  if (value === URL_BOUND_MODEL_CREDENTIAL_SENTINEL) return true;
  // JWT-shaped sentinel (some SDK layers re-mint the bearer into a token).
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  try {
    const normalized = (parts[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    return payload[URL_BOUND_MODEL_CREDENTIAL_SENTINEL_CLAIM] === true;
  } catch {
    return false;
  }
}

function isUrlWithinBase(url: URL, rawBaseUrl: string): boolean {
  if (rawBaseUrl === "*") return true;
  try {
    const base = new URL(rawBaseUrl);
    if (url.origin !== base.origin) return false;
    const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    return url.pathname === base.pathname || url.pathname.startsWith(basePath);
  } catch {
    return false;
  }
}

function findRoute(
  url: URL,
  routes: ReadonlyMap<string, CredentialedFetcher>
): CredentialedFetcher | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") {
    return null;
  }
  let best: { baseUrl: string; fetcher: CredentialedFetcher } | null = null;
  for (const [baseUrl, fetcher] of routes.entries()) {
    if (!isUrlWithinBase(url, baseUrl)) continue;
    if (!best || baseUrl.length > best.baseUrl.length) best = { baseUrl, fetcher };
  }
  return best?.fetcher ?? null;
}

/** Register a model base URL, or "*" for provider-scoped request-time matching. */
const WS_BLOCKED_HEADERS = new Set([
  "authorization",
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "sec-websocket-accept",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "upgrade",
]);

function wsHeaderPairs(headers: Headers): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  headers.forEach((value, name) => {
    if (!WS_BLOCKED_HEADERS.has(name.toLowerCase())) pairs.push([name, value]);
  });
  return pairs;
}

function encodeWebSocketHeaderPairs(headers: Headers): string {
  return btoa(JSON.stringify(wsHeaderPairs(headers)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** ws(s):// → http(s):// for base-URL route matching. */
function wsMatchUrl(url: URL): URL | null {
  const match = new URL(url.toString());
  if (match.protocol === "wss:") match.protocol = "https:";
  else if (match.protocol === "ws:") match.protocol = "http:";
  else if (match.protocol !== "https:" && match.protocol !== "http:") return null;
  return match;
}

const OPENAI_CODEX_ORIGINATOR = "codex_cli_rs";

function isChatGptCodexTarget(target: URL): boolean {
  return (
    target.protocol === "https:" &&
    target.hostname === "chatgpt.com" &&
    (target.pathname === "/backend-api/codex" || target.pathname.startsWith("/backend-api/codex/"))
  );
}

function prepareModelRequestHeaders(target: URL, headers: Headers, webSocket: boolean): void {
  if (!isChatGptCodexTarget(target)) return;
  // The stored credential is issued through the Codex CLI OAuth client. Keep
  // the request's originator aligned with that client: ChatGPT uses this field
  // when selecting the account's model route. Leaving pi-ai's generic `pi`
  // value in place can select a free-tier internal alias that does not exist
  // even though the same account and public model work through Codex CLI.
  headers.set("originator", OPENAI_CODEX_ORIGINATOR);
  if (webSocket && !headers.has("origin")) {
    headers.set("origin", target.origin);
  }
}

function prepareModelWebSocketUrl(url: URL, headers: Headers): URL {
  const proxyUrl = new URL(url.toString());
  proxyUrl.searchParams.set("__vibestudio_ws_headers", encodeWebSocketHeaderPairs(headers));
  return proxyUrl;
}

export function installUrlBoundModelFetchProxy(
  modelBaseUrl: string,
  fetcher: CredentialedFetcher
): void {
  const globals = globalThis as ProxyGlobals & {
    __vibestudioPrepareModelWebSocket?: (
      url: string,
      headers: Headers | Record<string, string>
    ) => { url: string } | null;
  };
  // The model executor scopes cache keys to a single turn/provider/model and
  // closes them on final output, abort, or failure. Reuse between tool calls
  // avoids repeatedly consuming outbound connection slots while remaining a
  // performance optimization: a hibernation/restart may discard it safely.
  globals.__vibestudioShouldReuseCodexWebSocket = () => true;
  let state = globals.__vibestudioModelFetchProxyState;
  if (!state) {
    state = { originalFetch: globalThis.fetch.bind(globalThis), routes: new Map() };
    globals.__vibestudioModelFetchProxyState = state;
  }
  state.routes.set(modelBaseUrl, fetcher);
  const proxyRoutes = state.routes;
  // Codex realtime transport: pi-ai consults this hook before opening the
  // model WebSocket. Strip the sentinel bearer and pack the remaining headers
  // into `__vibestudio_ws_headers` — the server egress proxy injects the real
  // credential on upgrade. Without this hook the WS attempt fails auth and
  // pi-ai silently falls back to SSE (no raw reasoning deltas, extra latency
  // on every call).
  globals.__vibestudioPrepareModelWebSocket = (url, headersInput) => {
    const target = wsMatchUrl(new URL(url));
    if (!target || !findRoute(target, proxyRoutes)) return null;
    const headers = new Headers(headersInput);
    const authorization = headers.get("authorization");
    const sentinel = authorization?.startsWith("Bearer ")
      ? isModelCredentialSentinel(authorization.slice("Bearer ".length))
      : false;
    if (!sentinel) return null;
    prepareModelRequestHeaders(target, headers, true);
    const proxyUrl = new URL(url);
    return { url: prepareModelWebSocketUrl(proxyUrl, headers).toString() };
  };
  if (globals.__vibestudioModelFetchProxyInstalled) return;
  globals.__vibestudioModelFetchProxyInstalled = true;

  const proxyState = state;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    const authorization = request.headers.get("authorization");
    const sentinel = authorization?.startsWith("Bearer ")
      ? isModelCredentialSentinel(authorization.slice("Bearer ".length))
      : false;
    if (!sentinel) return proxyState.originalFetch(input as RequestInfo, init);

    const targetUrl = new URL(request.url);
    const route = findRoute(targetUrl, proxyState.routes);
    if (!route) {
      throw new Error(
        `Refusing to send URL-bound model credential to non-model URL: ${targetUrl.toString()}`
      );
    }
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    if (headers.get("upgrade")?.toLowerCase() === "websocket") {
      // workerd outbound WebSocket = fetch-with-Upgrade. The credentialed
      // proxyFetch stream cannot carry an upgrade; encode the provider
      // headers in the URL metadata used by the egress proxy and send the
      // sentinel-free request through the runtime's attributed egress path.
      prepareModelRequestHeaders(targetUrl, headers, true);
      const proxyUrl = prepareModelWebSocketUrl(targetUrl, headers);
      return proxyState.originalFetch(proxyUrl.toString(), {
        method: request.method,
        headers,
        signal: request.signal,
      });
    }
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : new Uint8Array(await request.arrayBuffer());
    prepareModelRequestHeaders(targetUrl, headers, false);
    return route(targetUrl.toString(), {
      method: request.method,
      headers,
      ...(body ? { body } : {}),
      signal: request.signal,
    });
  };
}
