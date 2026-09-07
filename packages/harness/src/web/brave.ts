import type { SearchResult } from "./types.js";

const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";

export interface BraveFetcher {
  (url: string, init: RequestInit): Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}

/**
 * Brave search. Authentication is injected by the credentialed fetcher.
 * Register a Brave credential whose audience matches
 * `https://api.search.brave.com/` and whose injection is a header
 * `X-Subscription-Token: {token}`; the host's credentialed fetcher
 * attaches it automatically.
 */
export async function searchBrave(
  query: string,
  limit: number,
  fetcher: BraveFetcher = fetch as unknown as BraveFetcher,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    count: String(Math.max(1, Math.min(limit, 20))),
  });
  const res = await fetcher(`${BRAVE_URL}?${params.toString()}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Brave search returned HTTP ${res.status}`);
  }
  const text = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Brave returned malformed JSON");
  }
  const web = (payload as { web?: { results?: unknown } })?.web;
  const results = web?.results;
  if (!Array.isArray(results)) return [];
  const out: SearchResult[] = [];
  for (const item of results) {
    if (out.length >= limit) break;
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const url = typeof rec["url"] === "string" ? rec["url"] : "";
    const title = typeof rec["title"] === "string" ? rec["title"] : "";
    const snippet = typeof rec["description"] === "string" ? rec["description"] : "";
    if (!url || !title) continue;
    out.push({ title, url, snippet: stripHtmlTags(snippet) });
  }
  return out;
}

function stripHtmlTags(s: string): string {
  return s.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim();
}
