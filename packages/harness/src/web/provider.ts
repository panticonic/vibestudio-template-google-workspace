import type { ProviderName } from "./types.js";

/**
 * Well-known API origins for each search provider. Provider availability
 * is determined by checking whether the credentials system holds a
 * credential whose audience matches one of these origins.
 */
export const SEARCH_PROVIDER_ORIGINS: Readonly<Record<Exclude<ProviderName, "duckduckgo">, string>> = {
  tavily: "https://api.tavily.com/",
  brave: "https://api.search.brave.com/",
  exa: "https://api.exa.ai/",
};

/**
 * Asks the host "is a stored credential available for this provider?".
 * The host implements this by querying the credentials runtime (e.g.
 * `credentials.resolveCredential({ url })` on the main process). The
 * harness never sees the credential value — only whether one exists.
 */
export type CredentialPresenceProbe = (
  providerOriginUrl: string,
) => Promise<boolean>;

/**
 * Picks the search provider based on which credentials the user has
 * configured via the app's credentials system.
 *
 * Preference order: Tavily > Brave > Exa > DuckDuckGo (zero-config
 * fallback). Tavily wins because it's the most agent-friendly (long
 * clean snippets); Brave is the next-best general engine; Exa is
 * excellent for semantic/neural queries; DDG is the residual free
 * fallback that needs no credential.
 */
export async function selectSearchProvider(
  probe: CredentialPresenceProbe | undefined,
): Promise<ProviderName> {
  if (!probe) return "duckduckgo";
  if (await probe(SEARCH_PROVIDER_ORIGINS.tavily)) return "tavily";
  if (await probe(SEARCH_PROVIDER_ORIGINS.brave)) return "brave";
  if (await probe(SEARCH_PROVIDER_ORIGINS.exa)) return "exa";
  return "duckduckgo";
}
