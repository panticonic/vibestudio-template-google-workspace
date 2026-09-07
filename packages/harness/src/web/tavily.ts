import type { SearchResult } from "./types.js";

const TAVILY_URL = "https://api.tavily.com/search";

export interface TavilyFetcher {
  (url: string, init: RequestInit): Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}

/**
 * Tavily search. Authentication is injected by the credentialed fetcher
 * passed in — this module never sees the API key. Register a Tavily
 * credential whose audience matches `https://api.tavily.com/` and whose
 * injection is a header `Authorization: Bearer {token}`; the host's
 * credentialed fetcher attaches it automatically.
 */
export async function searchTavily(
  query: string,
  limit: number,
  fetcher: TavilyFetcher = fetch as unknown as TavilyFetcher,
): Promise<SearchResult[]> {
  const res = await fetcher(TAVILY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      max_results: Math.max(1, Math.min(limit, 20)),
      search_depth: "basic",
      include_answer: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`Tavily returned HTTP ${res.status}`);
  }
  const text = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Tavily returned malformed JSON");
  }
  const results = (payload as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const out: SearchResult[] = [];
  for (const item of results) {
    if (out.length >= limit) break;
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const url = typeof rec["url"] === "string" ? rec["url"] : "";
    const title = typeof rec["title"] === "string" ? rec["title"] : "";
    const snippet = typeof rec["content"] === "string" ? rec["content"] : "";
    if (!url || !title) continue;
    out.push({ title, url, snippet });
  }
  return out;
}
