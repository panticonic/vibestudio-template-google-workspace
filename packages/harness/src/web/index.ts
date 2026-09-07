/**
 * Vibestudio Web Tools Extension
 *
 * Registers three Pi tools:
 *   - `web_search` — Batched, cited Codex subscription search when the
 *     configured primary provider is openai-codex; otherwise DuckDuckGo
 *     (zero-config) or an auto-selected keyed provider from the credentials system.
 *   - `web_fetch` — Fetches a URL, extracts main content with Mozilla
 *     Readability, converts to markdown, stores the full result in the
 *     content-addressed blobstore, and returns `{ url, title, digest, size, head }`.
 *   - `web_read` — Reads a byte range of a previously-fetched blob by digest
 *     so the agent can drill into large pages without re-fetching.
 *
 * Designed for a "good basic experience" with zero setup: DDG works from
 * any residential IP. To upgrade to Tavily / Brave / Exa, the agent
 * registers a credential via the `@workspace-skills/web-research` skill;
 * the harness never sees the API key — it just fetches the provider URL
 * and the credentialed fetcher attaches auth based on URL audience.
 */
import type { AgentTool } from "@workspace/pi-core";
import { base64ToBytes } from "@vibestudio/rpc";
import { createWebSearchTool, type WebSearchDeps } from "./search.js";
export type WebRpcCaller = <T = unknown>(target: string, method: string, args: unknown[]) => Promise<T>;
export interface WebToolsDeps extends WebSearchDeps {
    /** RPC client for blobstore put/range reads. */
    rpc: {
        call: WebRpcCaller;
    };
    /**
     * Test/embedder override for web search and page retrieval. Production
     * page retrieval uses the managed Chromium host; tests pass plain mocks.
     */
    fetcher?: typeof fetch;
    /** Length of the head excerpt included inline with `web_fetch` results. */
    headLength?: number;
    /** TTL (ms) for the URL→digest session memo. Default 10 minutes; 0 disables. */
    urlCacheTtlMs?: number;
    /** Override for `Date.now()` — used in tests. */
    now?: () => number;
}
const DEFAULT_HEAD_LENGTH = 5000;
const DEFAULT_READ_LIMIT = 8000;
const MAX_READ_LIMIT = 32000;
const DEFAULT_URL_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_URL_CACHE_ENTRIES = 200;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const FETCH_PARAMETERS = {
    type: "object",
    properties: {
        url: { type: "string", description: "Absolute URL (http:// or https://) to fetch." },
        session: {
            type: "string",
            enum: ["public", "browser"],
            description: "Cookie-free public fetch (default), or an approval-gated normal Chromium page load using your imported browser cookies.",
        },
    },
    required: ["url"],
};
const READ_PARAMETERS = {
    type: "object",
    properties: {
        digest: {
            type: "string",
            description: "sha256 digest returned by an earlier web_fetch call.",
        },
        offset: {
            type: "integer",
            description: "Byte offset to start reading from (default 0).",
            minimum: 0,
        },
        limit: {
            type: "integer",
            description: `Maximum number of bytes to read (default ${DEFAULT_READ_LIMIT}, max ${MAX_READ_LIMIT}).`,
            minimum: 1,
            maximum: MAX_READ_LIMIT,
        },
    },
    required: ["digest"],
};
export function createWebTools(deps: WebToolsDeps): AgentTool[] {
    const searchFetcher = (deps.fetcher ?? fetch) as typeof fetch;
    const headLength = Math.max(500, deps.headLength ?? DEFAULT_HEAD_LENGTH);
    const now = deps.now ?? Date.now;
    const urlCacheTtlMs = deps.urlCacheTtlMs ?? DEFAULT_URL_CACHE_TTL_MS;
    const urlCache = new Map<string, {
        digest: string;
        size: number;
        title: string;
        expiresAt: number;
    }>();
    function urlCacheGet(url: string): {
        digest: string;
        size: number;
        title: string;
    } | null {
        const entry = urlCache.get(url);
        if (!entry)
            return null;
        if (entry.expiresAt <= now()) {
            urlCache.delete(url);
            return null;
        }
        return { digest: entry.digest, size: entry.size, title: entry.title };
    }
    function urlCacheSet(url: string, digest: string, size: number, title: string): void {
        if (urlCacheTtlMs <= 0)
            return;
        if (urlCache.size >= MAX_URL_CACHE_ENTRIES) {
            // Drop the oldest entry; insertion order preserves least-recently-set.
            const firstKey = urlCache.keys().next().value;
            if (firstKey !== undefined)
                urlCache.delete(firstKey);
        }
        urlCache.set(url, { digest, size, title, expiresAt: now() + urlCacheTtlMs });
    }
    const tools: AgentTool[] = [];
    // Tool definitions below keep the registerTool shape they had as a Pi
    // extension; the registrar now just collects them into the returned list.
    const pi = {
        registerTool(tool: {
            name: string;
            label: string;
            description: string;
            parameters: unknown;
            execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
        }): void {
            tools.push(tool as unknown as AgentTool);
        },
    };
    {
        pi.registerTool(createWebSearchTool(deps, withAbort(searchFetcher), now) as never);
        pi.registerTool({
            name: "web_fetch",
            label: "Web Fetch",
            description: "Fetch a URL through managed Chromium, extract its main content as markdown, and cache the full result in the blobstore. Public mode is cookie-free. Browser mode loads a normal browser page with imported cookies and requires approval. Returns the cleaned title, a head excerpt, and a digest.",
            parameters: FETCH_PARAMETERS as never,
            execute: async (_toolCallId, params, signal) => {
                const { url, session = "public" } = params as {
                    url: string;
                    session?: "public" | "browser";
                };
                if (!url || typeof url !== "string") {
                    throw new Error("web_fetch: 'url' is required");
                }
                if (!/^https?:\/\//iu.test(url)) {
                    throw new Error("web_fetch: 'url' must start with http:// or https://");
                }
                if (session !== "public" && session !== "browser") {
                    throw new Error("web_fetch: 'session' must be 'public' or 'browser'");
                }
                const sourceHost = hostnameOf(url);
                if (!sourceHost) throw new Error("web_fetch: URL has no canonical host");
                const t0 = now();
                const cacheKey = `${session}:${url}`;
                const cached = urlCacheGet(cacheKey);
                if (cached) {
                    const headSlice = await readUtf8BlobRange(deps.rpc, cached.digest, 0, headLength);
                    if (headSlice !== null) {
                        await deps.recordIngestion?.({ key: `web:${sourceHost}`, via: "web-fetch-cache", classification: "external" });
                        const truncated = cached.size > headSlice.bytes;
                        const summary = [
                            `# ${cached.title}`,
                            url,
                            "",
                            `Cached as digest ${cached.digest} (${cached.size} bytes, served from session cache).`,
                            truncated
                                ? `Showing the first ${headSlice.bytes} of ${cached.size} bytes. Use web_read({ digest, offset, limit }) to read more.`
                                : "Full content shown below.",
                            "",
                            headSlice.text,
                        ].join("\n");
                        return {
                            content: [{ type: "text" as const, text: summary }],
                            details: {
                                url,
                                title: cached.title,
                                digest: cached.digest,
                                size: cached.size,
                                head_length: headSlice.bytes,
                                truncated,
                                served_from_cache: true,
                                elapsed_ms: now() - t0,
                            },
                        };
                    }
                    // Blob was pruned out from under us; fall through and re-fetch.
                }
                // HTML/PDF extraction carries Readability, DOM parsing, and PDF
                // support. Keep that feature payload out of every agent's cold
                // isolate; workerd loads the split module on the first fetch.
                const { extractPage } = await import("./extract.js");
                const pageFetcher = deps.fetcher ?? createChromiumFetcher(deps.rpc, session);
                const page = await extractPage(
                    url,
                    withAbort(pageFetcher, signal) as never,
                    signal
                );
                await deps.recordIngestion?.({ key: `web:${sourceHost}`, via: "web-fetch", classification: "external" });
                const stored = await deps.rpc.call<{
                    digest: string;
                    size: number;
                }>("main", "blobstore.putText", [page.markdown]);
                urlCacheSet(cacheKey, stored.digest, stored.size, page.title);
                const head = utf8Prefix(page.markdown, headLength);
                const truncated = stored.size > head.byteLength;
                const summary = [
                    `# ${page.title}`,
                    page.url,
                    "",
                    `Cached as digest ${stored.digest} (${stored.size} bytes).`,
                    truncated
                        ? `Showing the first ${head.byteLength} of ${stored.size} bytes. Use web_read({ digest, offset, limit }) to read more.`
                        : "Full content shown below.",
                    "",
                    head.text,
                ].join("\n");
                return {
                    content: [{ type: "text" as const, text: summary }],
                    details: {
                        url: page.url,
                        title: page.title,
                        digest: stored.digest,
                        size: stored.size,
                        head_length: head.byteLength,
                        truncated,
                        served_from_cache: false,
                        elapsed_ms: now() - t0,
                        content_type: page.contentType,
                        session,
                    },
                };
            },
        });
        pi.registerTool({
            name: "web_read",
            label: "Web Read",
            description: "Read a byte range of a page previously cached by web_fetch. Identify the page by the digest returned from web_fetch.",
            parameters: READ_PARAMETERS as never,
            execute: async (_toolCallId, params) => {
                const { digest, offset, limit } = params as {
                    digest: string;
                    offset?: number;
                    limit?: number;
                };
                if (!digest || typeof digest !== "string") {
                    throw new Error("web_read: 'digest' is required");
                }
                const off = clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0);
                const len = clampInt(limit, 1, MAX_READ_LIMIT, DEFAULT_READ_LIMIT);
                const slice = await readUtf8BlobRange(deps.rpc, digest, off, len);
                if (slice === null) {
                    throw new Error(`web_read: no cached blob found for digest ${digest}`);
                }
                return {
                    content: [{ type: "text" as const, text: slice.text }],
                    details: {
                        digest,
                        offset: off,
                        limit: len,
                        bytes: slice.bytes,
                        next_offset: off + slice.bytes,
                    },
                };
            },
        });
    }
    return tools;
}

function createChromiumFetcher(
    rpc: WebToolsDeps["rpc"],
    session: "public" | "browser"
): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const opened = await rpc.call<{
            responseId: string;
            url: string;
            status: number;
            statusText: string;
            headers: Record<string, string>;
            size: number;
        }>("main", `chromiumFetch.${session === "browser" ? "openBrowser" : "openPublic"}`, [url]);
        let offset = 0;
        let closed = false;
        const close = async () => {
            if (closed) return;
            closed = true;
            await rpc.call("main", "chromiumFetch.close", [opened.responseId]).catch(() => undefined);
        };
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (init?.signal?.aborted) {
                    await close();
                    controller.error(init.signal.reason ?? new Error("Chromium fetch aborted"));
                    return;
                }
                try {
                    const chunk = await rpc.call<{ bytesBase64: string; done: boolean }>(
                        "main",
                        "chromiumFetch.read",
                        [opened.responseId, offset, 256 * 1024]
                    );
                    const bytes = base64ToBytes(chunk.bytesBase64);
                    offset += bytes.byteLength;
                    if (bytes.byteLength > 0) controller.enqueue(bytes);
                    if (chunk.done) {
                        closed = true;
                        controller.close();
                    }
                } catch (error) {
                    await close();
                    controller.error(error);
                }
            },
            cancel: close,
        });
        const consume = () => new Response(body).arrayBuffer();
        return {
            ok: opened.status >= 200 && opened.status < 300,
            status: opened.status,
            statusText: opened.statusText,
            url: opened.url,
            headers: new Headers(opened.headers),
            body,
            arrayBuffer: consume,
            text: async () => textDecoder.decode(await consume()),
        } as Response;
    }) as typeof fetch;
}
function hostnameOf(input: string | URL | Request): string | null {
    try {
        if (typeof input === "string")
            return new URL(input).hostname;
        if (input instanceof URL)
            return input.hostname;
        if (input && typeof input === "object" && "url" in input) {
            return new URL((input as {
                url: string;
            }).url).hostname;
        }
        return null;
    }
    catch {
        return null;
    }
}
async function readUtf8BlobRange(rpc: WebToolsDeps["rpc"], digest: string, offset: number, limit: number): Promise<{
    text: string;
    bytes: number;
} | null> {
    const range = await rpc.call<{ bytesBase64: string } | null>("main", "blobstore.getRangeBytes", [
        digest,
        offset,
        limit,
    ]);
    if (range === null)
        return null;
    return decodeUtf8BlobRange(base64ToBytes(range.bytesBase64));
}
function decodeUtf8BlobRange(bytes: Uint8Array): {
    text: string;
    bytes: number;
} {
    let start = 0;
    while (start < bytes.length && isUtf8Continuation(bytes[start]!))
        start++;
    let end = start;
    while (end < bytes.length) {
        const width = completeUtf8SequenceLength(bytes, end);
        if (width <= 0)
            break;
        end += width;
    }
    return { text: textDecoder.decode(bytes.subarray(start, end)), bytes: end };
}
function completeUtf8SequenceLength(bytes: Uint8Array, offset: number): number {
    const first = bytes[offset]!;
    const width = expectedUtf8SequenceLength(first);
    if (width === 0 || offset + width > bytes.length)
        return 0;
    for (let i = 1; i < width; i++) {
        if (!isUtf8Continuation(bytes[offset + i]!))
            return 0;
    }
    return width;
}
function expectedUtf8SequenceLength(first: number): number {
    if (first <= 0x7f)
        return 1;
    if (first >= 0xc2 && first <= 0xdf)
        return 2;
    if (first >= 0xe0 && first <= 0xef)
        return 3;
    if (first >= 0xf0 && first <= 0xf4)
        return 4;
    return 0;
}
function isUtf8Continuation(byte: number): boolean {
    return (byte & 0xc0) === 0x80;
}
function utf8Prefix(text: string, maxBytes: number): { text: string; byteLength: number } {
    const bytes = textEncoder.encode(text);
    if (bytes.byteLength <= maxBytes)
        return { text, byteLength: bytes.byteLength };
    let end = Math.max(0, Math.min(text.length, maxBytes));
    while (end > 0 && textEncoder.encode(text.slice(0, end)).byteLength > maxBytes)
        end--;
    if (end > 0) {
        const last = text.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff)
            end--;
    }
    const prefix = text.slice(0, end);
    return { text: prefix, byteLength: textEncoder.encode(prefix).byteLength };
}
function withAbort(fetcher: typeof fetch, outer?: AbortSignal): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
            controller.abort(new Error(`web tool fetch timed out after ${DEFAULT_FETCH_TIMEOUT_MS}ms`));
        }, DEFAULT_FETCH_TIMEOUT_MS);
        const abort = () => controller.abort(outer?.reason ?? new Error("web tool aborted"));
        if (outer) {
            if (outer.aborted)
                abort();
            else
                outer.addEventListener("abort", abort, { once: true });
        }
        const initSignal = init?.signal;
        const abortInit = () => controller.abort(initSignal?.reason ?? new Error("web tool fetch aborted"));
        if (initSignal) {
            if (initSignal.aborted)
                abortInit();
            else
                initSignal.addEventListener("abort", abortInit, { once: true });
        }
        try {
            return await fetcher(input as never, { ...init, signal: controller.signal });
        }
        finally {
            clearTimeout(timeout);
            outer?.removeEventListener("abort", abort);
            initSignal?.removeEventListener("abort", abortInit);
        }
    }) as typeof fetch;
}
function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
    if (typeof raw !== "number" || !Number.isFinite(raw))
        return fallback;
    const n = Math.trunc(raw);
    if (n < min)
        return min;
    if (n > max)
        return max;
    return n;
}
export type { SearchResult, ProviderName } from "./types.js";
export type { CredentialPresenceProbe } from "./provider.js";
