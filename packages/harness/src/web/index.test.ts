import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createWebTools } from "./index.js";
import { parseLiteResults, searchDuckDuckGo, DuckDuckGoBlockedError } from "./duckduckgo.js";
import { extractPage, htmlToReadableMarkdown } from "./extract.js";
import { selectSearchProvider } from "./provider.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

interface MockTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate?: (result: {
      content: Array<{ type: string; text: string }>;
      details: unknown;
    }) => void,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details?: unknown;
  }>;
}

function registeredTools(tools: unknown[]): Map<string, MockTool> {
  const registered = new Map<string, MockTool>();
  for (const tool of tools as MockTool[]) registered.set(tool.name, tool);
  return registered;
}

function mockResponse(
  body: string | Uint8Array,
  init?: { ok?: boolean; status?: number; contentType?: string; contentLength?: string; url?: string },
) {
  const bytes =
    body instanceof Uint8Array ? body : new TextEncoder().encode(body);
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    url: init?.url,
    headers: {
      get(name: string) {
        if (name.toLowerCase() === "content-type") {
          return init?.contentType ?? "text/html; charset=utf-8";
        }
        if (name.toLowerCase() === "content-length") {
          return init?.contentLength ?? null;
        }
        return null;
      },
    },
    text: async () => (typeof body === "string" ? body : new TextDecoder().decode(bytes)),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function makeBlobstore() {
  const store = new Map<string, string>();
  const call = vi.fn(
    <T>(target: string, method: string, args: unknown[]): Promise<T> => {
      if (target !== "main") {
        return Promise.reject(new Error(`unexpected rpc target ${target}`));
      }
      if (method === "blobstore.putText") {
        const text = args[0] as string;
        const digest = createHash("sha256").update(text, "utf8").digest("hex");
        store.set(digest, text);
        return Promise.resolve({ digest, size: Buffer.byteLength(text, "utf8") } as T);
      }
      if (method === "blobstore.getRange") {
        const digest = args[0] as string;
        const offset = args[1] as number;
        const limit = args[2] as number;
        const text = store.get(digest);
        if (text === undefined) return Promise.resolve(null as T);
        const buf = Buffer.from(text, "utf8");
        if (offset >= buf.length) return Promise.resolve("" as T);
        return Promise.resolve(
          buf.subarray(offset, Math.min(buf.length, offset + limit)).toString("utf8") as T,
        );
      }
      if (method === "blobstore.getRangeBytes") {
        const digest = args[0] as string;
        const offset = args[1] as number;
        const limit = args[2] as number;
        const text = store.get(digest);
        if (text === undefined) return Promise.resolve(null as T);
        const buf = Buffer.from(text, "utf8");
        if (offset >= buf.length) return Promise.resolve({ bytesBase64: "" } as T);
        return Promise.resolve({
          bytesBase64: buf
            .subarray(offset, Math.min(buf.length, offset + limit))
            .toString("base64"),
        } as T);
      }
      if (method === "blobstore.grep") {
        const digest = args[0] as string;
        const pattern = args[1] as string;
        const opts = (args[2] as {
          caseInsensitive?: boolean;
          contextLines?: number;
          maxMatches?: number;
        }) ?? {};
        const text = store.get(digest);
        if (text === undefined) return Promise.resolve(null as T);
        const re = new RegExp(pattern, opts.caseInsensitive ? "iu" : "u");
        const lines = text.split(/\r?\n/u);
        const ctx = opts.contextLines ?? 0;
        const max = opts.maxMatches ?? 50;
        const matches: Array<{
          lineNumber: number;
          line: string;
          before: string[];
          after: string[];
        }> = [];
        for (let i = 0; i < lines.length && matches.length < max; i++) {
          if (!re.test(lines[i]!)) continue;
          matches.push({
            lineNumber: i + 1,
            line: lines[i]!,
            before: lines.slice(Math.max(0, i - ctx), i),
            after: lines.slice(i + 1, Math.min(lines.length, i + 1 + ctx)),
          });
        }
        return Promise.resolve(matches as T);
      }
      return Promise.reject(new Error(`unexpected rpc method ${method}`));
    },
  );
  return { rpc: { call }, store };
}

describe("createWebTools", () => {
  it("registers web_search, web_fetch, and web_read", () => {
    const { rpc } = makeBlobstore();
    const registered = registeredTools(createWebTools({ rpc: rpc as never }));

    expect(registered.has("web_search")).toBe(true);
    expect(registered.has("web_fetch")).toBe(true);
    expect(registered.has("web_read")).toBe(true);
    const properties = (registered.get("web_search")!.parameters as {
      properties: Record<string, unknown>;
    }).properties;
    expect(Object.keys(properties)).toEqual(["queries"]);
  });

  it("uses DuckDuckGo when no API key is available", async () => {
    const { rpc } = makeBlobstore();
    const fetcher = vi.fn(async () =>
      mockResponse(fixture("ddg-lite-sample.html"), { contentType: "text/html" }),
    ) as unknown as typeof fetch;
    const registered = registeredTools(createWebTools({ rpc: rpc as never, fetcher }));

    const tool = registered.get("web_search")!;
    const result = await tool.execute("call-1", { queries: ["tc39 stage 3"] }, undefined);
    const details = result.details as { provider: string; results: unknown[] };
    expect(details.provider).toBe("duckduckgo");
    expect(details.results.length).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses the configured Codex subscription search session and preserves citations", async () => {
    const { rpc } = makeBlobstore();
    const sse = [
      'event: response.created\ndata: {"response":{"id":"resp-1"}}',
      'event: response.output_item.done\ndata: {"item":{"id":"search-1","type":"web_search_call","status":"completed","action":{"type":"search","query":"current tc39 proposals"}}}',
      'event: response.output_text.delta\ndata: {"delta":"Temporal is standardized. TC39 maintains it."}',
      'event: response.output_item.done\ndata: {"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Temporal is standardized. TC39 maintains it.","annotations":[{"type":"url_citation","title":"TC39","url":"https://tc39.es/","start_index":0,"end_index":25},{"type":"url_citation","title":"TC39","url":"https://tc39.es/","start_index":26,"end_index":44}]}]}}',
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}',
    ].join("\n\n");
    const codexFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        model: string;
        tools: Array<Record<string, unknown>>;
      };
      expect(request.model).toBe("gpt-5.6-sol");
      expect(request.tools[0]).toMatchObject({
        type: "web_search",
        external_web_access: true,
        search_context_size: "high",
      });
      expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("account-1");
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const recordIngestion = vi.fn(async () => undefined);
    const registered = registeredTools(createWebTools({
      rpc: rpc as never,
      recordIngestion,
      searchBackend: "codex",
      resolveCodexSearchSession: async () => ({
        model: "gpt-5.6-sol",
        accountId: "account-1",
        sessionId: "channel-1",
        fetcher: codexFetch,
      }),
    }));
    const properties = (registered.get("web_search")!.parameters as {
      properties: Record<string, unknown>;
    }).properties;
    expect(Object.keys(properties)).toEqual(["queries", "search_context_size", "freshness"]);
    const onUpdate = vi.fn();

    const result = await registered.get("web_search")!.execute(
      "call-codex",
      {
        queries: ["current tc39 proposals"],
        search_context_size: "high",
        freshness: "live",
      },
      undefined,
      onUpdate,
    );

    expect(result.content[0]?.text).toContain(
      "Temporal is standardized.[1] TC39 maintains it.[1]",
    );
    expect(result.content[0]?.text).toContain("https://tc39.es/");
    expect(result.details).toMatchObject({
      provider: "openai-codex",
      api: "responses",
      model: "gpt-5.6-sol",
      queryCount: 1,
      failedQueryCount: 0,
      searchContextSize: "high",
      results: [{
        query: "current tc39 proposals",
        sources: [{ title: "TC39", url: "https://tc39.es/" }],
        citations: [
          { sourceIndex: 0, startIndex: 0, endIndex: 25 },
          { sourceIndex: 0, startIndex: 26, endIndex: 44 },
        ],
      }],
    });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({
      content: [{ type: "text", text: "Temporal is standardized. TC39 maintains it." }],
      details: expect.objectContaining({
        partial: true,
        results: [expect.objectContaining({
          query: "current tc39 proposals",
          text: "Temporal is standardized. TC39 maintains it.",
        })],
      }),
    }));
    expect(recordIngestion).toHaveBeenCalledWith({
      key: "web:tc39.es",
      via: "web-search:openai-codex",
      classification: "external",
    });
  });

  it("batches legacy-provider queries without exposing a second search tool", async () => {
    const { rpc } = makeBlobstore();
    const fetcher = vi.fn(async () =>
      mockResponse(fixture("ddg-lite-sample.html"), { contentType: "text/html" }),
    ) as unknown as typeof fetch;
    const registered = registeredTools(createWebTools({ rpc: rpc as never, fetcher }));

    const result = await registered.get("web_search")!.execute(
      "call-batch",
      { queries: ["query one", "query two"] },
      undefined,
    );

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((result.details as { results: Array<{ query: string }> }).results.map(({ query }) => query))
      .toEqual(["query one", "query two"]);
    expect(registered.has("codex_search")).toBe(false);
  });

  it("selects Brave when a Brave credential is registered", async () => {
    const { rpc } = makeBlobstore();
    const credentialedFetcher = vi.fn(async (input: string | URL, init: RequestInit | undefined) => {
      expect(typeof input === "string" ? input : input.toString()).toContain(
        "search.brave.com",
      );
      // Auth header is NOT set by the provider module — the host fetcher
      // would inject it. The provider must not leak the API key in any form.
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Subscription-Token")).toBeNull();
      return mockResponse(
        JSON.stringify({
          web: {
            results: [
              {
                title: "Brave Result",
                url: "https://brave-example.com",
                description: "from <em>brave</em>",
              },
            ],
          },
        }),
        { contentType: "application/json" },
      );
    }) as unknown as typeof fetch;
    const registered = registeredTools(createWebTools({
      rpc: rpc as never,
      fetcher: credentialedFetcher,
      hasCredentialForOrigin: async (origin) => origin.includes("search.brave.com"),
    }));

    const tool = registered.get("web_search")!;
    const result = await tool.execute("c", { queries: ["x"] }, undefined);
    const details = result.details as {
      provider: string;
      results: Array<{ sources: Array<{ snippet: string }> }>;
    };
    expect(details.provider).toBe("brave");
    expect(details.results[0]!.sources[0]!.snippet).toBe("from brave");
  });

  it("selects Exa when an Exa credential is registered", async () => {
    const { rpc } = makeBlobstore();
    const credentialedFetcher = vi.fn(async (input: string | URL, init: RequestInit | undefined) => {
      expect(typeof input === "string" ? input : input.toString()).toContain("exa.ai");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBeNull();
      return mockResponse(
        JSON.stringify({
          results: [
            {
              title: "Exa Result",
              url: "https://exa-example.com",
              highlights: ["semantic snippet"],
            },
          ],
        }),
        { contentType: "application/json" },
      );
    }) as unknown as typeof fetch;
    const registered = registeredTools(createWebTools({
      rpc: rpc as never,
      fetcher: credentialedFetcher,
      hasCredentialForOrigin: async (origin) => origin.includes("exa.ai"),
    }));
    const tool = registered.get("web_search")!;
    const result = await tool.execute("c", { queries: ["x"] }, undefined);
    const details = result.details as {
      provider: string;
      results: Array<{ sources: Array<{ snippet: string }> }>;
    };
    expect(details.provider).toBe("exa");
    expect(details.results[0]!.sources[0]!.snippet).toBe("semantic snippet");
  });

  it("auto-upgrades to Tavily when a Tavily credential is registered", async () => {
    const { rpc } = makeBlobstore();
    const credentialedFetcher = vi.fn(async (input: string | URL, init: RequestInit | undefined) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("tavily.com");
      // The provider module must not embed any auth header. The host's
      // credentialed fetcher is responsible for attaching `Authorization`.
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      return mockResponse(
        JSON.stringify({
          results: [
            { title: "Example", url: "https://example.com", content: "snippet" },
          ],
        }),
        { contentType: "application/json" },
      );
    }) as unknown as typeof fetch;
    const registered = registeredTools(createWebTools({
      rpc: rpc as never,
      fetcher: credentialedFetcher,
      hasCredentialForOrigin: async (origin) => origin.includes("tavily.com"),
    }));

    const tool = registered.get("web_search")!;
    const result = await tool.execute("call-1", { queries: ["anything"] }, undefined);
    const details = result.details as {
      provider: string;
      results: Array<{ sources: Array<{ url: string }> }>;
    };
    expect(details.provider).toBe("tavily");
    expect(details.results[0]!.sources[0]!.url).toBe("https://example.com");
  });

  it("web_fetch caches markdown in the blobstore and returns digest + head", async () => {
    const { rpc, store } = makeBlobstore();
    const recordIngestion = vi.fn(async () => undefined);
    const fetcher = vi.fn(async () =>
      mockResponse(SAMPLE_PAGE_HTML, {
        contentType: "text/html",
        url: "https://example.com/spec",
      }),
    ) as unknown as typeof fetch;
    // headLength of 600 means a page that produces ~700+ bytes of markdown will truncate.
    const registered = registeredTools(createWebTools({ rpc: rpc as never, fetcher, headLength: 600, recordIngestion }));

    const tool = registered.get("web_fetch")!;
    const result = await tool.execute(
      "call-1",
      { url: "https://example.com/spec" },
      undefined,
    );
    const details = result.details as {
      digest: string;
      size: number;
      truncated: boolean;
      head_length: number;
    };

    expect(details.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(details.size).toBeGreaterThan(0);
    expect(details.head_length).toBeLessThanOrEqual(600);
    expect(details.head_length).toBeLessThanOrEqual(details.size);
    expect(store.has(details.digest)).toBe(true);
    expect(store.get(details.digest)).toContain("Section");
    expect(recordIngestion).toHaveBeenCalledWith({
      key: "web:example.com",
      via: "web-fetch",
      classification: "external",
    });
  });

  it("uses the managed Chromium transport and selects browser-session authority explicitly", async () => {
    const { rpc: blobRpc } = makeBlobstore();
    const html = new TextEncoder().encode(SAMPLE_PAGE_HTML);
    const call = vi.fn(async <T>(target: string, method: string, args: unknown[]): Promise<T> => {
      if (method === "chromiumFetch.openBrowser") {
        expect(args).toEqual(["https://example.com/private"]);
        return {
          responseId: "c531b602-45d7-4875-bbe8-c876f0721750",
          url: "https://example.com/private",
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/html; charset=utf-8" },
          size: html.byteLength,
        } as T;
      }
      if (method === "chromiumFetch.read") {
        return { bytesBase64: Buffer.from(html).toString("base64"), done: true } as T;
      }
      return (await blobRpc.call(target, method, args)) as T;
    });
    const registered = registeredTools(createWebTools({ rpc: { call } as never }));

    const result = await registered.get("web_fetch")!.execute(
      "call-browser",
      { url: "https://example.com/private", session: "browser" },
      undefined,
    );

    expect(call).toHaveBeenCalledWith("main", "chromiumFetch.openBrowser", [
      "https://example.com/private",
    ]);
    expect(call).toHaveBeenCalledWith(
      "main",
      "chromiumFetch.read",
      ["c531b602-45d7-4875-bbe8-c876f0721750", 0, 256 * 1024],
    );
    expect((result.details as { session: string }).session).toBe("browser");
  });

  it("web_read returns a slice of the cached page", async () => {
    const { rpc } = makeBlobstore();
    // Pre-populate the store via web_fetch.
    const fetcher = vi.fn(async () =>
      mockResponse(SAMPLE_PAGE_HTML, {
        contentType: "text/html",
        url: "https://example.com/spec",
      }),
    ) as unknown as typeof fetch;
    const registered = registeredTools(createWebTools({ rpc: rpc as never, fetcher }));

    const fetchTool = registered.get("web_fetch")!;
    const fetchResult = await fetchTool.execute(
      "call-1",
      { url: "https://example.com/spec" },
      undefined,
    );
    const { digest, size } = fetchResult.details as { digest: string; size: number };

    const readTool = registered.get("web_read")!;
    const result = await readTool.execute(
      "call-2",
      { digest, offset: 0, limit: 20 },
      undefined,
    );
    const details = result.details as { digest: string; bytes: number };
    expect(details.digest).toBe(digest);
    expect(details.bytes).toBeLessThanOrEqual(20);
    expect(details.bytes).toBeLessThanOrEqual(size);
  });

  it("web_read preserves UTF-8 boundaries and reports byte progress", async () => {
    const { rpc, store } = makeBlobstore();
    const text = "AéB🙂C";
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    store.set(digest, text);
    const registered = registeredTools(createWebTools({ rpc: rpc as never }));
    const readTool = registered.get("web_read")!;

    const completeMultibyte = await readTool.execute(
      "call-1",
      { digest, offset: 0, limit: 3 },
      undefined,
    );
    expect(completeMultibyte.content[0]!.text).toBe("Aé");
    expect(completeMultibyte.content[0]!.text).not.toContain("\uFFFD");
    expect(completeMultibyte.details).toMatchObject({
      bytes: 3,
      next_offset: 3,
    });

    const trailingPartial = await readTool.execute(
      "call-2",
      { digest, offset: 3, limit: 2 },
      undefined,
    );
    expect(trailingPartial.content[0]!.text).toBe("B");
    expect(trailingPartial.content[0]!.text).not.toContain("\uFFFD");
    expect(trailingPartial.details).toMatchObject({
      bytes: 1,
      next_offset: 4,
    });

    const leadingPartial = await readTool.execute(
      "call-3",
      { digest, offset: 5, limit: 4 },
      undefined,
    );
    expect(leadingPartial.content[0]!.text).toBe("C");
    expect(leadingPartial.content[0]!.text).not.toContain("\uFFFD");
    expect(leadingPartial.details).toMatchObject({
      bytes: 4,
      next_offset: 9,
    });
  });

  it("web_read throws when the digest is unknown", async () => {
    const { rpc } = makeBlobstore();
    const registered = registeredTools(createWebTools({ rpc: rpc as never }));
    const readTool = registered.get("web_read")!;
    await expect(
      readTool.execute("call-1", { digest: "0".repeat(64) }, undefined),
    ).rejects.toThrow(/no cached blob/);
  });

  it("web_fetch extracts text from PDF responses", async () => {
    const { rpc, store } = makeBlobstore();
    const pdfBytes = readFileSync(join(FIXTURES_DIR, "hello.pdf"));
    const fetcher = vi.fn(async () =>
      mockResponse(new Uint8Array(pdfBytes), {
        contentType: "application/pdf",
        url: "https://example.com/doc.pdf",
      }),
    ) as unknown as typeof fetch;
    const registered = registeredTools(createWebTools({ rpc: rpc as never, fetcher }));

    const tool = registered.get("web_fetch")!;
    const result = await tool.execute(
      "c1",
      { url: "https://example.com/doc.pdf" },
      undefined,
    );
    const details = result.details as {
      digest: string;
      content_type: string;
      size: number;
    };
    expect(details.content_type).toBe("pdf");
    expect(details.size).toBeGreaterThan(0);
    const stored = store.get(details.digest)!;
    expect(stored).toContain("Hello PDF fixture text");
    expect(stored).toContain("Page 1");
  });

  it("web_fetch rejects oversized HTML bodies before extraction", async () => {
    const { rpc } = makeBlobstore();
    const readBody = vi.fn(async () => new ArrayBuffer(0));
    const readText = vi.fn(async () => "<html><body>too large</body></html>");
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      url: "https://example.com/huge",
      headers: {
        get(name: string) {
          if (name.toLowerCase() === "content-type") return "text/html";
          if (name.toLowerCase() === "content-length") return String(6 * 1024 * 1024);
          return null;
        },
      },
      text: readText,
      arrayBuffer: readBody,
    })) as unknown as typeof fetch;
    const registered = registeredTools(createWebTools({ rpc: rpc as never, fetcher }));

    const tool = registered.get("web_fetch")!;
    await expect(
      tool.execute("c1", { url: "https://example.com/huge" }, undefined),
    ).rejects.toThrow(/HTML response body exceeds \d+ byte limit/);
    expect(readBody).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
  });

  it("web_fetch rejects non-http URLs", async () => {
    const { rpc } = makeBlobstore();
    const registered = registeredTools(createWebTools({ rpc: rpc as never }));
    const tool = registered.get("web_fetch")!;
    await expect(
      tool.execute("call-1", { url: "ftp://example.com/x" }, undefined),
    ).rejects.toThrow(/must start with http/);
  });

  it("web_fetch serves the same URL from the session cache on the second call", async () => {
    const { rpc, store } = makeBlobstore();
    const fetcher = vi.fn(async () =>
      mockResponse(SAMPLE_PAGE_HTML, {
        contentType: "text/html",
        url: "https://example.com/spec",
      }),
    ) as unknown as typeof fetch;
    const registered = registeredTools(createWebTools({ rpc: rpc as never, fetcher }));

    const tool = registered.get("web_fetch")!;
    const first = await tool.execute("call-1", { url: "https://example.com/spec" }, undefined);
    const second = await tool.execute("call-2", { url: "https://example.com/spec" }, undefined);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const f = first.details as { digest: string; served_from_cache?: boolean };
    const s = second.details as { digest: string; served_from_cache?: boolean };
    expect(s.digest).toBe(f.digest);
    expect(f.served_from_cache).toBe(false);
    expect(s.served_from_cache).toBe(true);
    expect(store.size).toBe(1);
  });

  it("web_fetch URL cache respects the TTL", async () => {
    const { rpc } = makeBlobstore();
    let nowMs = 1000;
    const fetcher = vi.fn(async () =>
      mockResponse(SAMPLE_PAGE_HTML, {
        contentType: "text/html",
        url: "https://example.com/spec",
      }),
    ) as unknown as typeof fetch;
    const registered = registeredTools(createWebTools({
      rpc: rpc as never,
      fetcher,
      urlCacheTtlMs: 100,
      now: () => nowMs,
    }));

    const tool = registered.get("web_fetch")!;
    await tool.execute("call-1", { url: "https://example.com/spec" }, undefined);
    nowMs += 200; // past TTL
    await tool.execute("call-2", { url: "https://example.com/spec" }, undefined);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

});

describe("parseLiteResults", () => {
  it("parses DuckDuckGo lite (table) result pages", () => {
    const results = parseLiteResults(fixture("ddg-lite-sample.html"), 10);
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results[0]).toMatchObject({
      title: "Example Domain",
      url: "https://example.com/",
    });
    expect(results[0]!.snippet).toContain("illustrative");
    expect(results[1]!.url).toBe("https://nodejs.org/");
    expect(results[2]!.url).toBe("https://tc39.es/proposals/");
  });

  it("parses DuckDuckGo html (div) result pages", () => {
    const results = parseLiteResults(fixture("ddg-html-sample.html"), 10);
    expect(results.length).toBe(2);
    expect(results[0]!.url).toBe("https://example.com/");
    expect(results[1]!.url).toBe("https://deno.land/");
    expect(results[1]!.snippet).toContain("Deno");
  });

  it("respects the limit", () => {
    const results = parseLiteResults(fixture("ddg-lite-sample.html"), 1);
    expect(results.length).toBe(1);
  });

  it("returns empty on an anomaly page", () => {
    const results = parseLiteResults(fixture("ddg-anomaly.html"), 10);
    expect(results).toEqual([]);
  });
});

describe("searchDuckDuckGo", () => {
  it("throws DuckDuckGoBlockedError on a 429 response", async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => "",
    }));
    await expect(
      searchDuckDuckGo("anything", 5, fetcher as never),
    ).rejects.toBeInstanceOf(DuckDuckGoBlockedError);
  });

  it("throws DuckDuckGoBlockedError on an anomaly page", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => fixture("ddg-anomaly.html"),
    }));
    await expect(
      searchDuckDuckGo("anything", 5, fetcher as never),
    ).rejects.toBeInstanceOf(DuckDuckGoBlockedError);
  });

  it("falls back to the html endpoint when lite returns empty", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("lite.duckduckgo.com")) {
        return { ok: true, status: 200, text: async () => "<html><body>no hits</body></html>" };
      }
      return { ok: true, status: 200, text: async () => fixture("ddg-html-sample.html") };
    });
    const results = await searchDuckDuckGo("deno", 5, fetcher as never);
    expect(results.length).toBe(2);
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain("lite.duckduckgo.com");
    expect(calls[1]).toContain("html.duckduckgo.com");
  });
});

describe("htmlToReadableMarkdown", () => {
  it("extracts readable content as markdown", () => {
    const out = htmlToReadableMarkdown(SAMPLE_PAGE_HTML, "https://example.com/spec");
    expect(out.title).toBeTruthy();
    expect(out.markdown).toContain("Section 7");
    expect(out.markdown).toContain("This is a paragraph");
  });

  it("extractPage rejects streamed HTML beyond the configured byte limit", async () => {
    const canceled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<html>"));
        controller.enqueue(new TextEncoder().encode("<body>oversized</body></html>"));
      },
      cancel: canceled,
    });
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      url: "https://example.com/stream",
      headers: {
        get(name: string) {
          if (name.toLowerCase() === "content-type") return "text/html";
          return null;
        },
      },
      body,
      text: async () => "",
      arrayBuffer: async () => new ArrayBuffer(0),
    }));

    await expect(
      extractPage("https://example.com/stream", fetcher, undefined, { maxHtmlBytes: 8 }),
    ).rejects.toThrow(/HTML response body exceeds 8 byte limit/);
    expect(canceled).toHaveBeenCalled();
  });
});

describe("selectSearchProvider", () => {
  it("defaults to duckduckgo when no probe is provided", async () => {
    await expect(selectSearchProvider(undefined)).resolves.toBe("duckduckgo");
  });
  it("returns tavily when the probe reports a Tavily credential", async () => {
    await expect(
      selectSearchProvider(async (origin) => origin.includes("tavily.com")),
    ).resolves.toBe("tavily");
  });
  it("prefers tavily over brave when both credentials exist", async () => {
    await expect(
      selectSearchProvider(async () => true),
    ).resolves.toBe("tavily");
  });
  it("falls back to brave then exa when tavily is absent", async () => {
    await expect(
      selectSearchProvider(async (origin) => origin.includes("brave.com") || origin.includes("exa.ai")),
    ).resolves.toBe("brave");
    await expect(
      selectSearchProvider(async (origin) => origin.includes("exa.ai")),
    ).resolves.toBe("exa");
  });
  it("returns duckduckgo when no provider credential is present", async () => {
    await expect(selectSearchProvider(async () => false)).resolves.toBe("duckduckgo");
  });
});

const SAMPLE_PAGE_HTML = `
<!doctype html>
<html>
<head><title>Sample Spec</title></head>
<body>
  <nav>Site navigation, ignore me</nav>
  <article>
    <h1>Sample Spec</h1>
    <p>This is a paragraph of <strong>important</strong> content that Readability should preserve.</p>
    <h2>Section 7</h2>
    <p>Some more detail about <a href="https://example.com/details">the topic</a>.</p>
    <ul>
      <li>First bullet</li>
      <li>Second bullet</li>
    </ul>
    <p>And a closing line, this is a paragraph of regular text to give Readability enough to chew on so it does not bail out due to the charThreshold.</p>
    <p>Adding another paragraph here so the total text length is comfortably above the threshold and Readability is happy to extract the main content. The more text, the better the heuristics work.</p>
  </article>
  <footer>Site footer, ignore</footer>
</body>
</html>
`;
