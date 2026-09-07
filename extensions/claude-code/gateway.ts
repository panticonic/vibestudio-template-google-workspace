/** Normalize the extension host gateway into the HTTP(S) base RpcClient expects. */
export function toServerBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  url.hash = "";
  url.search = "";
  if (url.pathname === "/rpc") {
    url.pathname = "/";
  } else if (url.pathname.endsWith("/rpc")) {
    const withoutSuffix = url.pathname.slice(0, -"/rpc".length) || "/";
    if (withoutSuffix !== "/_workspace") url.pathname = withoutSuffix;
  }
  const normalized = url.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}
