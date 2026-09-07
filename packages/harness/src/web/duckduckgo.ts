import { parseHTML } from "linkedom";
import type { SearchResult } from "./types.js";

const DDG_LITE_URL = "https://lite.duckduckgo.com/lite/";
const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

export interface DuckDuckGoFetcher {
  (url: string, init: RequestInit): Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}

/** Thrown when DDG appears to be rate-limiting or CAPTCHA-walling us. */
export class DuckDuckGoBlockedError extends Error {
  readonly code = "DDG_BLOCKED";
  constructor(reason: string) {
    super(
      `DuckDuckGo is blocking automated requests (${reason}). ` +
        "Register a Tavily, Brave, or Exa credential via the web-research skill (e.g. `await requestTavilyApiKey()`) to upgrade to a keyed provider.",
    );
    this.name = "DuckDuckGoBlockedError";
  }
}

export async function searchDuckDuckGo(
  query: string,
  limit: number,
  fetcher: DuckDuckGoFetcher = fetch as unknown as DuckDuckGoFetcher,
): Promise<SearchResult[]> {
  // Try the lite endpoint first; fall back to the html one if lite returns empty.
  const liteResults = await fetchAndParse(DDG_LITE_URL, query, limit, fetcher);
  if (liteResults.length > 0) return liteResults;

  const htmlResults = await fetchAndParse(DDG_HTML_URL, query, limit, fetcher);
  if (htmlResults.length > 0) return htmlResults;

  // Both endpoints returned zero — almost always a block, not a query with no hits.
  throw new DuckDuckGoBlockedError("both endpoints returned zero results");
}

async function fetchAndParse(
  endpoint: string,
  query: string,
  limit: number,
  fetcher: DuckDuckGoFetcher,
): Promise<SearchResult[]> {
  const body = new URLSearchParams({ q: query }).toString();
  const res = await fetcher(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    body,
  });
  if (!res.ok) {
    if (res.status === 429 || res.status === 403) {
      throw new DuckDuckGoBlockedError(`HTTP ${res.status}`);
    }
    throw new Error(`DuckDuckGo ${endpoint} returned HTTP ${res.status}`);
  }
  const html = await res.text();
  if (looksLikeAnomalyPage(html)) {
    throw new DuckDuckGoBlockedError("anomaly/CAPTCHA page detected");
  }
  return parseLiteResults(html, limit);
}

function looksLikeAnomalyPage(html: string): boolean {
  // DDG's anomaly page is small and includes specific strings.
  if (html.length < 2000 && /anomaly|unusual traffic|captcha/iu.test(html)) return true;
  if (/Please solve.{0,40}CAPTCHA/iu.test(html)) return true;
  return false;
}

export function parseLiteResults(html: string, limit: number): SearchResult[] {
  const { document } = parseHTML(html);
  const out: SearchResult[] = [];

  // Endpoint 1: lite.duckduckgo.com/lite/ — table layout, `a.result-link`.
  const liteAnchors = document.querySelectorAll("a.result-link");
  for (let i = 0; i < liteAnchors.length && out.length < limit; i++) {
    const anchor = liteAnchors[i] as Element;
    const href = anchor.getAttribute("href") ?? "";
    const url = unwrapDdgRedirect(href);
    if (!url) continue;
    const title = (anchor.textContent ?? "").trim();
    if (!title) continue;

    const titleRow = anchor.closest("tr");
    let snippet = "";
    let cursor: Element | null = titleRow?.nextElementSibling ?? null;
    while (cursor) {
      const snippetCell = cursor.querySelector("td.result-snippet");
      if (snippetCell) {
        snippet = (snippetCell.textContent ?? "").trim().replace(/\s+/gu, " ");
        break;
      }
      if (cursor.querySelector("a.result-link")) break;
      cursor = cursor.nextElementSibling;
    }
    out.push({ title, url, snippet });
  }

  if (out.length > 0) return out;

  // Endpoint 2: html.duckduckgo.com/html/ — div-based, `a.result__a` + `a.result__snippet`.
  const htmlResults = document.querySelectorAll(".result");
  for (let i = 0; i < htmlResults.length && out.length < limit; i++) {
    const node = htmlResults[i] as Element;
    const anchor = node.querySelector("a.result__a");
    if (!anchor) continue;
    const href = anchor.getAttribute("href") ?? "";
    const url = unwrapDdgRedirect(href);
    if (!url) continue;
    const title = (anchor.textContent ?? "").trim();
    if (!title) continue;
    const snippetEl = node.querySelector(".result__snippet");
    const snippet = (snippetEl?.textContent ?? "").trim().replace(/\s+/gu, " ");
    out.push({ title, url, snippet });
  }

  return out;
}

function unwrapDdgRedirect(href: string): string | null {
  if (!href) return null;
  // DDG sometimes wraps result URLs as `//duckduckgo.com/l/?uddg=<encoded>&rut=...`.
  if (href.startsWith("//duckduckgo.com/l/") || href.includes("duckduckgo.com/l/")) {
    try {
      const url = new URL(href.startsWith("//") ? `https:${href}` : href);
      const target = url.searchParams.get("uddg");
      if (target) return decodeURIComponent(target);
    } catch {
      return null;
    }
  }
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  return null;
}
