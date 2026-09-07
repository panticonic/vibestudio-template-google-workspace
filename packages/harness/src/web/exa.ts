import type { SearchResult } from "./types.js";

const EXA_URL = "https://api.exa.ai/search";

export interface ExaFetcher {
  (url: string, init: RequestInit): Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}

/**
 * Exa search. Authentication is injected by the credentialed fetcher.
 * Register an Exa credential whose audience matches `https://api.exa.ai/`
 * and whose injection is a header `x-api-key: {token}`; the host's
 * credentialed fetcher attaches it automatically.
 */
export async function searchExa(
  query: string,
  limit: number,
  fetcher: ExaFetcher = fetch as unknown as ExaFetcher,
): Promise<SearchResult[]> {
  const res = await fetcher(EXA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      numResults: Math.max(1, Math.min(limit, 25)),
      type: "auto",
      contents: { highlights: true },
    }),
  });
  if (!res.ok) {
    throw new Error(`Exa search returned HTTP ${res.status}`);
  }
  const text = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Exa returned malformed JSON");
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
    const highlights = rec["highlights"];
    let snippet = "";
    if (Array.isArray(highlights) && highlights.length > 0 && typeof highlights[0] === "string") {
      snippet = highlights[0] as string;
    } else if (typeof rec["text"] === "string") {
      snippet = (rec["text"] as string).slice(0, 300);
    }
    if (!url || !title) continue;
    out.push({ title, url, snippet: snippet.trim() });
  }
  return out;
}
