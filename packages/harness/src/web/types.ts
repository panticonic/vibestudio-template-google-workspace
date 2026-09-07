export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type ProviderName = "duckduckgo" | "tavily" | "brave" | "exa";

export interface SearchProviderInvocation {
  provider: ProviderName;
  results: SearchResult[];
}
