import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@workspace/pi-core";
import { searchDuckDuckGo } from "./duckduckgo.js";
import { searchTavily } from "./tavily.js";
import { searchBrave } from "./brave.js";
import { searchExa } from "./exa.js";
import { selectSearchProvider, type CredentialPresenceProbe } from "./provider.js";
import type { ProviderName, SearchResult } from "./types.js";
import {
    searchWithCodex,
    type CodexSearchCall,
    type CodexSearchContextSize,
    type CodexSearchFreshness,
    type CodexSearchResult,
    type CodexSearchSession,
} from "./codex.js";

const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_SEARCH_BATCH_SIZE = 5;

export type WebSearchBackend = "codex" | "standard";

export interface WebSearchDeps {
    recordIngestion?: (entry: {
        key: string;
        via: string;
        classification: "external" | "derived";
    }) => Promise<void>;
    hasCredentialForOrigin?: CredentialPresenceProbe;
    /** Selects the schema and transport for the agent's configured primary provider. */
    searchBackend?: WebSearchBackend;
    /** Resolves a host-mediated session when searchBackend is codex. */
    resolveCodexSearchSession?: (signal?: AbortSignal) => Promise<CodexSearchSession | null>;
}

export interface WebSearchSource {
    title?: string;
    url: string;
    snippet?: string;
}

export interface WebSearchCitation {
    /** Zero-based index into the query result's sources array. */
    sourceIndex: number;
    /** Character offsets into the unmodified query result text. */
    startIndex?: number;
    endIndex?: number;
}

export interface WebSearchQueryResult {
    query: string;
    text: string;
    sources: WebSearchSource[];
    citations: WebSearchCitation[];
    searchCalls: CodexSearchCall[];
    error?: string;
    responseId?: string;
    usage?: CodexSearchResult["usage"];
}

export interface WebSearchDetails {
    provider: "openai-codex" | ProviderName;
    api: "responses" | "search-results";
    queryCount: number;
    failedQueryCount: number;
    results: WebSearchQueryResult[];
    elapsedMs: number;
    model?: string;
    freshness?: CodexSearchFreshness;
    searchContextSize?: CodexSearchContextSize;
    partial?: boolean;
    completedQueryCount?: number;
}

const QUERY_PROPERTY = {
    type: "array",
    items: { type: "string", minLength: 1 },
    minItems: 1,
    maxItems: DEFAULT_SEARCH_BATCH_SIZE,
    description: `One or more related search queries to run in parallel (max ${DEFAULT_SEARCH_BATCH_SIZE}).`,
};

function searchParameters(backend: WebSearchBackend): Record<string, unknown> {
    const properties: Record<string, unknown> = { queries: QUERY_PROPERTY };
    if (backend === "codex") {
        properties["search_context_size"] = {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "Amount of web context to retrieve. Defaults to medium.",
        };
        properties["freshness"] = {
            type: "string",
            enum: ["cached", "indexed", "live"],
            description: "Use live for changing facts, cached for stable facts, or indexed for OpenAI-indexed access. Defaults to live.",
        };
    }
    return { type: "object", properties, required: ["queries"], additionalProperties: false };
}

export function createWebSearchTool(
    deps: WebSearchDeps,
    fetcher: typeof fetch,
    now: () => number,
): AgentTool {
    const backend = deps.searchBackend ?? "standard";
    return {
        name: "web_search",
        label: "Web Search",
        description: backend === "codex"
            ? `Search the web with the configured OpenAI Codex subscription and citations. Batch up to ${DEFAULT_SEARCH_BATCH_SIZE} related queries.`
            : `Search the web with citations. Batch up to ${DEFAULT_SEARCH_BATCH_SIZE} related queries. Uses DuckDuckGo or a configured Tavily / Brave / Exa provider.`,
        parameters: searchParameters(backend) as never,
        execute: async (_toolCallId, params, signal, onUpdate) => {
            const { queries, search_context_size, freshness } = params as {
                queries: string[];
                search_context_size?: CodexSearchContextSize;
                freshness?: CodexSearchFreshness;
            };
            const normalizedQueries = Array.isArray(queries)
                ? queries.map((query) => query.trim()).filter(Boolean)
                : [];
            if (normalizedQueries.length === 0)
                throw new Error("web_search: at least one non-empty query is required");
            if (normalizedQueries.length > DEFAULT_SEARCH_BATCH_SIZE)
                throw new Error(`web_search: at most ${DEFAULT_SEARCH_BATCH_SIZE} queries are allowed`);

            const startedAt = now();
            if (backend === "codex") {
                return runCodexSearch(deps, normalizedQueries, {
                    freshness: freshness ?? "live",
                    searchContextSize: search_context_size ?? "medium",
                    signal,
                    startedAt,
                    now,
                    onUpdate,
                });
            }
            return runStandardSearch(deps, normalizedQueries, fetcher, signal, startedAt, now);
        },
    } as AgentTool;
}

async function runCodexSearch(
    deps: WebSearchDeps,
    queries: string[],
    options: {
        freshness: CodexSearchFreshness;
        searchContextSize: CodexSearchContextSize;
        signal?: AbortSignal;
        startedAt: number;
        now: () => number;
        onUpdate?: AgentToolUpdateCallback<WebSearchDetails>;
    },
): Promise<AgentToolResult<WebSearchDetails>> {
    if (!deps.resolveCodexSearchSession)
        throw new Error("Codex web search is selected but no session resolver is configured");
    const session = await deps.resolveCodexSearchSession(options.signal);
    if (!session)
        throw new Error("Codex web search is selected but no subscription session is available");

    const partialResults: Array<WebSearchQueryResult | undefined> = queries.map((query) => ({
        query,
        text: "",
        sources: [],
        citations: [],
        searchCalls: [],
    }));
    let completedQueryCount = 0;
    const emitProgress = (text: string) => options.onUpdate?.({
        content: [{ type: "text", text }],
        details: codexDetails(session, options, queries.length, partialResults, true),
    });
    emitProgress(queries.length === 1 ? `Searching the web for "${queries[0]}"…` : `Searching ${queries.length} web queries…`);

    await Promise.all(queries.map(async (query, index) => {
        try {
            const result = await searchWithCodex({
                query,
                session,
                freshness: options.freshness,
                searchContextSize: options.searchContextSize,
                signal: options.signal,
                onTextDelta: queries.length === 1
                    ? (delta) => {
                        partialResults[index]!.text += delta;
                        emitProgress(partialResults[index]!.text);
                    }
                    : undefined,
            });
            partialResults[index] = normalizeCodexResult(result);
        }
        catch (error) {
            if (options.signal?.aborted)
                throw options.signal.reason ?? error;
            partialResults[index] = failedQuery(query, error);
        }
        finally {
            completedQueryCount += 1;
            if (queries.length > 1 && !options.signal?.aborted)
                emitProgress(`Completed ${completedQueryCount} of ${queries.length} web queries…`);
        }
    }));

    const results = partialResults.filter((result): result is WebSearchQueryResult => Boolean(result));
    const failedQueryCount = results.filter((result) => result.error).length;
    await recordDomains(
        deps,
        results.flatMap((result) => result.sources.map((source) => source.url)),
        "openai-codex",
    );
    return {
        content: [{ type: "text", text: formatNormalizedResults(results, "openai-codex") }],
        details: codexDetails(session, options, queries.length, partialResults, false),
        ...(failedQueryCount === queries.length ? { isError: true } : {}),
    };

    function codexDetails(
        activeSession: CodexSearchSession,
        activeOptions: typeof options,
        queryCount: number,
        currentResults: Array<WebSearchQueryResult | undefined>,
        partial: boolean,
    ): WebSearchDetails {
        const results = currentResults.filter((result): result is WebSearchQueryResult => Boolean(result));
        return {
            provider: "openai-codex",
            api: "responses",
            model: activeSession.model,
            freshness: activeOptions.freshness,
            searchContextSize: activeOptions.searchContextSize,
            queryCount,
            failedQueryCount: results.filter((result) => result.error).length,
            results,
            elapsedMs: activeOptions.now() - activeOptions.startedAt,
            ...(partial ? { partial: true, completedQueryCount } : {}),
        };
    }
}

async function runStandardSearch(
    deps: WebSearchDeps,
    queries: string[],
    fetcher: typeof fetch,
    signal: AbortSignal | undefined,
    startedAt: number,
    now: () => number,
): Promise<AgentToolResult<WebSearchDetails>> {
    const provider = await selectSearchProvider(deps.hasCredentialForOrigin);
    const requestFetcher = bindSignal(fetcher, signal);
    const results = await Promise.all(queries.map(async (query): Promise<WebSearchQueryResult> => {
        const sources = await runProvider(provider, query, DEFAULT_SEARCH_LIMIT, requestFetcher);
        return {
            query,
            text: formatSearchResults(sources, provider, query),
            sources: sources.map(({ title, url, snippet }) => ({ title, url, snippet })),
            citations: [],
            searchCalls: [],
        };
    }));
    await recordDomains(deps, results.flatMap((result) => result.sources.map((source) => source.url)), provider);
    return {
        content: [{ type: "text", text: formatNormalizedResults(results, provider) }],
        details: {
            provider,
            api: "search-results",
            queryCount: queries.length,
            failedQueryCount: 0,
            results,
            elapsedMs: now() - startedAt,
        },
    };
}

function normalizeCodexResult(result: CodexSearchResult): WebSearchQueryResult {
    const sources: WebSearchSource[] = [];
    const sourceIndexes = new Map<string, number>();
    const citations = result.citations.map(({ title, url, startIndex, endIndex }) => {
        let sourceIndex = sourceIndexes.get(url);
        if (sourceIndex === undefined) {
            sourceIndex = sources.length;
            sourceIndexes.set(url, sourceIndex);
            sources.push({ title, url });
        }
        else if (!sources[sourceIndex]!.title && title) {
            sources[sourceIndex]!.title = title;
        }
        return {
            sourceIndex,
            ...(startIndex !== undefined ? { startIndex } : {}),
            ...(endIndex !== undefined ? { endIndex } : {}),
        };
    });
    return {
        query: result.query,
        text: result.text,
        sources,
        citations,
        searchCalls: result.searchCalls,
        ...(result.responseId ? { responseId: result.responseId } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
    };
}

function failedQuery(query: string, error: unknown): WebSearchQueryResult {
    return {
        query,
        text: "",
        sources: [],
        citations: [],
        searchCalls: [],
        error: error instanceof Error ? error.message : String(error),
    };
}

async function recordDomains(deps: WebSearchDeps, urls: string[], provider: string): Promise<void> {
    if (!deps.recordIngestion) return;
    const domains = [...new Set(urls.map(hostnameOf).filter((host): host is string => Boolean(host)))];
    await Promise.all(domains.map((host) => deps.recordIngestion!({
        key: `web:${host}`,
        via: `web-search:${provider}`,
        classification: "external",
    })));
}

function formatNormalizedResults(results: WebSearchQueryResult[], provider: string): string {
    const multiple = results.length > 1;
    return results.map((result) => {
        let body: string;
        if (result.error) {
            body = `FAILED: ${result.error}`;
        }
        else if (provider === "openai-codex") {
            const sources = result.sources.map((source, index) =>
                `${index + 1}. ${source.title?.trim() || source.url}: ${source.url}`);
            body = [
                result.text ? renderCitations(result.text, result.citations) : "(no response text)",
                sources.length > 0 ? `Sources:\n${sources.join("\n")}` : "",
            ].filter(Boolean).join("\n\n");
        }
        else {
            body = result.text;
        }
        return multiple ? `## Query: ${result.query}\n\n${body}` : body;
    }).join("\n\n");
}

function renderCitations(text: string, citations: WebSearchCitation[]): string {
    const markersByOffset = new Map<number, Set<number>>();
    for (const citation of citations) {
        const offset = citation.endIndex;
        if (offset === undefined || offset < 0 || offset > text.length) continue;
        const markers = markersByOffset.get(offset) ?? new Set<number>();
        markers.add(citation.sourceIndex + 1);
        markersByOffset.set(offset, markers);
    }
    let citedText = text;
    const offsets = [...markersByOffset.keys()].sort((left, right) => right - left);
    for (const offset of offsets) {
        const marker = [...markersByOffset.get(offset)!]
            .sort((left, right) => left - right)
            .map((sourceNumber) => `[${sourceNumber}]`)
            .join("");
        citedText = `${citedText.slice(0, offset)}${marker}${citedText.slice(offset)}`;
    }
    return citedText;
}

async function runProvider(
    provider: ProviderName,
    query: string,
    limit: number,
    fetcher: typeof fetch,
): Promise<SearchResult[]> {
    switch (provider) {
        case "tavily":
            return searchTavily(query, limit, fetcher as never);
        case "brave":
            return searchBrave(query, limit, fetcher as never);
        case "exa":
            return searchExa(query, limit, fetcher as never);
        case "duckduckgo":
        default:
            return searchDuckDuckGo(query, limit, fetcher as never);
    }
}

function bindSignal(fetcher: typeof fetch, signal?: AbortSignal): typeof fetch {
    return ((input: RequestInfo | URL, init?: RequestInit) =>
        fetcher(input, { ...init, signal })) as typeof fetch;
}

function formatSearchResults(results: SearchResult[], provider: ProviderName, query: string): string {
    if (results.length === 0) return `No results for "${query}" (provider: ${provider}).`;
    const lines: string[] = [`Web search results for "${query}" (provider: ${provider}):`, ""];
    for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        lines.push(`${i + 1}. ${result.title}`, `   ${result.url}`);
        if (result.snippet) lines.push(`   ${result.snippet}`);
        lines.push("");
    }
    return lines.join("\n");
}

function hostnameOf(url: string): string | null {
    try {
        return new URL(url).hostname;
    }
    catch {
        return null;
    }
}
