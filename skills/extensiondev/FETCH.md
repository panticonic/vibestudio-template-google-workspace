# HTTP fetch handler

An extension can additionally expose an HTTP surface by adding a default export with a `fetch` method. The gateway routes `/_r/ext/<encoded-name>/*` to it. The RPC surface (the `activate(ctx)` return value) is the canonical one; `fetch` is optional and only worth adding when a caller specifically wants fetch-call ergonomics.

## Minimum example

```ts
import type { ExtensionContext, ExtensionFetchContext } from "@vibestudio/extension";

let activated: ExtensionContext;

export async function activate(ctx: ExtensionContext) {
  activated = ctx;
  return {
    async ping() { return "pong"; },
  };
}

export default {
  async fetch(request: Request, ctx: ExtensionFetchContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/status") return Response.json({ ok: true });
    if (url.pathname === "/echo" && request.method === "POST") {
      const body = await request.text();
      return new Response(body, { headers: { "content-type": "text/plain" } });
    }
    return new Response("Not Found", { status: 404 });
  },
};
```

## Semantics

- **Request / Response** are standard Fetch API types. Pass `Response.json(...)`, `new Response(buffer, { status })`, etc.
- **`ExtensionFetchContext`** is the same activated `ExtensionContext` plus a `waitUntil(promise)` method for fire-and-forget background work the host will keep alive after the response returns. It's not a per-request context — it's the same long-lived `ctx` your `activate()` saw.
- **Caller identity** is in `ctx.invocation.current()`, same as for RPC. Per-call approvals derive the original panel/worker from the host's active invocation chain.
- **Route prefix** is `/_r/ext/<encoded-name>/*`. The remainder is passed through. No custom top-level routes (`/webhooks/github`, `/api/...`) in v1 — those are deferred until the custom-route system lands.
- **Auth** is the standard caller-token bearer flow. Unauthenticated requests get 401 from the gateway before they reach your handler.
- **Body size** is capped at **32 MB** inbound; exceeding the cap returns 413. Streamed bodies count chunk-by-chunk.
- **Lifecycle**:
  - Requests before `activate()` finishes get **503** with a descriptive body. No queueing.
  - Requests while the extension is in `pending-approval` or `error` also get 503.
  - The fetch handler runs in the **same process** as `activate` — they share state, can call each other, can share connection pools.
- **`waitUntil(promise)`** — registered promises are settled after the response returns; rejections are logged but don't surface to the caller. Use this for analytics, cache warming, etc.

## Streaming responses

Return a `Response` whose body is a `ReadableStream` and the host streams chunks back to the caller. Server-sent events, large file downloads, and incremental responses all work this way. The current envelope buffers chunks server-side via base64 frames — fully live WS chunking is a future-work item.

## Reading streamed request bodies

```ts
export default {
  async fetch(request: Request) {
    if (!request.body) return new Response("Expected body", { status: 400 });
    const reader = request.body.getReader();
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      // …process chunk…
    }
    return Response.json({ bytes: totalBytes });
  },
};
```

The 32 MB cap applies to total bytes read; the host throws `EFBIG` mid-stream if you exceed it.

## When to use fetch vs RPC

Prefer RPC (the `activate` return surface) by default:

- **RPC** is typed end-to-end via `extensions.use<T>(name).method(...)`, the dispatcher validates args, and you get caller attribution for free.
- **Fetch** is for cases where the caller naturally speaks HTTP — embedding an existing HTTP-shaped library, exposing a download endpoint that benefits from streaming, or proxying to an upstream service that returns Fetch-compatible responses.

A common pattern is to expose both: a typed RPC surface for in-app callers and a thin fetch handler that delegates to the same internal helpers. See `workspace/extensions/browser-data/` for an example of the dual surface.

## Reaching it from userland

From a panel or worker:

```ts
import { gatewayFetch } from "@workspace/runtime";

const res = await gatewayFetch(`/_r/ext/${encodeURIComponent("@workspace-extensions/hello")}/status`);
console.log(await res.json());
```

`gatewayFetch` is the bearer-authenticated fetch helper exported from `@workspace/runtime`. It signs the request with the caller's token so your extension gets proper caller attribution.
