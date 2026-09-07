/**
 * Web-research skill helpers.
 *
 * Agents configured with an OpenAI Codex primary use their connected subscription. For other
 * model providers, the harness's `web_search` tool auto-selects between
 * DuckDuckGo (free, zero-config) and three keyed providers (Tavily, Brave,
 * Exa) based on which credentials the user has registered in the app's
 * credentials system. Each helper here pops the trusted credential-input UI
 * for one provider, asks the user to paste their API key, and stores it as a
 * URL-bound credential whose audience matches the provider's API origin.
 *
 * The harness never sees the key value. When `web_search` issues a
 * request to (e.g.) `https://api.tavily.com/search`, the host's
 * credentialed fetcher matches the URL against stored audiences and
 * injects the right header automatically.
 *
 * Usage from eval:
 *
 *   import { requestTavilyApiKey } from "@workspace-skills/web-research";
 *   await requestTavilyApiKey();    // pops the approval UI; user pastes key
 *
 * Listing / revoking:
 *
 *   import { listSearchProviderCredentials, revokeSearchProviderCredential }
 *     from "@workspace-skills/web-research";
 *   const creds = await listSearchProviderCredentials();
 *   await revokeSearchProviderCredential(creds[0].id);
 */

import { credentials, openExternal, openPanel } from "@workspace/runtime";
import type { RequestCredentialInputRequest, StoredCredentialSummary } from "@workspace/runtime";

type RuntimeCredentials = typeof credentials;

export type SearchProviderId = "tavily" | "brave" | "exa";

interface ProviderSpec {
  id: SearchProviderId;
  label: string;
  origin: string;
  signupUrl: string;
  injection: RequestCredentialInputRequest["credential"]["injection"];
  fieldDescription: string;
}

const PROVIDERS: Readonly<Record<SearchProviderId, ProviderSpec>> = {
  tavily: {
    id: "tavily",
    label: "Tavily Search",
    origin: "https://api.tavily.com/",
    signupUrl: "https://app.tavily.com/home",
    injection: {
      type: "header",
      name: "authorization",
      valueTemplate: "Bearer {token}",
    },
    fieldDescription:
      "Paste your Tavily API key from https://app.tavily.com/home (Settings → API Keys).",
  },
  brave: {
    id: "brave",
    label: "Brave Search",
    origin: "https://api.search.brave.com/",
    signupUrl: "https://api-dashboard.search.brave.com/app/keys",
    injection: {
      type: "header",
      name: "x-subscription-token",
      valueTemplate: "{token}",
    },
    fieldDescription:
      "Paste your Brave Search subscription token from https://api-dashboard.search.brave.com/app/keys.",
  },
  exa: {
    id: "exa",
    label: "Exa Search",
    origin: "https://api.exa.ai/",
    signupUrl: "https://dashboard.exa.ai/api-keys",
    injection: {
      type: "header",
      name: "x-api-key",
      valueTemplate: "{token}",
    },
    fieldDescription:
      "Paste your Exa API key from https://dashboard.exa.ai/api-keys.",
  },
};

function getCredentialRuntime(): RuntimeCredentials {
  const api = credentials as Partial<RuntimeCredentials> | undefined;
  if (!api) {
    throw new Error(
      "Vibestudio credential runtime is unavailable: @workspace/runtime did not export credentials.",
    );
  }
  for (const method of ["requestCredentialInput", "listStoredCredentials", "revokeCredential"] as const) {
    if (typeof api[method] !== "function") {
      throw new Error(
        `Vibestudio credential runtime is unavailable: credentials.${method} is missing.`,
      );
    }
  }
  return api as RuntimeCredentials;
}

function buildSearchProviderCredentialRequest(spec: ProviderSpec): RequestCredentialInputRequest {
  const audience = [{ url: spec.origin, match: "origin" as const }];
  const binding = {
    id: `${spec.id}-api`,
    use: "fetch" as const,
    audience,
    injection: spec.injection,
  };
  return {
    title: `Add ${spec.label}`,
    description: `Save a ${spec.label} API key so the agent's web_search tool can route through ${spec.label} instead of DuckDuckGo.`,
    credential: {
      label: spec.label,
      audience,
      injection: spec.injection,
      bindings: [binding],
      accountIdentity: { providerUserId: `${spec.id}-api-key` },
      scopes: [],
      metadata: {
        providerId: spec.id,
        providerKind: "search-api-key",
      },
    },
    fields: [
      {
        name: "token",
        label: "API Key",
        type: "secret",
        required: true,
        description: spec.fieldDescription,
      },
    ],
    material: {
      type: "api-key",
      tokenField: "token",
    },
  };
}

async function requestSearchProviderCredential(
  spec: ProviderSpec,
): Promise<StoredCredentialSummary> {
  const api = getCredentialRuntime();
  return api.requestCredentialInput(buildSearchProviderCredentialRequest(spec));
}

export async function requestTavilyApiKey(): Promise<StoredCredentialSummary> {
  return requestSearchProviderCredential(PROVIDERS.tavily);
}

export async function requestBraveApiKey(): Promise<StoredCredentialSummary> {
  return requestSearchProviderCredential(PROVIDERS.brave);
}

export async function requestExaApiKey(): Promise<StoredCredentialSummary> {
  return requestSearchProviderCredential(PROVIDERS.exa);
}

export async function requestSearchProviderApiKey(
  provider: SearchProviderId,
): Promise<StoredCredentialSummary> {
  return requestSearchProviderCredential(PROVIDERS[provider]);
}

export async function openSearchProviderSignup(
  provider: SearchProviderId,
  opts: { browser?: "internal" | "external" } = {},
): Promise<void> {
  const spec = PROVIDERS[provider];
  if (opts.browser === "external") {
    await openExternal(spec.signupUrl);
  } else {
    await openPanel(spec.signupUrl, { focus: true, title: `${spec.label} setup` });
  }
}

function isSearchProviderCredential(
  credential: StoredCredentialSummary,
): SearchProviderId | null {
  if (credential.revokedAt) return null;
  const metaProvider = credential.metadata?.["providerId"];
  if (typeof metaProvider === "string" && (metaProvider in PROVIDERS)) {
    return metaProvider as SearchProviderId;
  }
  for (const audience of credential.audience) {
    try {
      const origin = new URL(audience.url).origin;
      for (const spec of Object.values(PROVIDERS)) {
        if (origin === new URL(spec.origin).origin) return spec.id;
      }
    } catch {
      // ignore malformed audience URLs
    }
  }
  return null;
}

export interface SearchProviderCredentialSummary extends StoredCredentialSummary {
  provider: SearchProviderId;
}

export async function listSearchProviderCredentials(): Promise<SearchProviderCredentialSummary[]> {
  const api = getCredentialRuntime();
  const all = await api.listStoredCredentials();
  const out: SearchProviderCredentialSummary[] = [];
  for (const c of all) {
    const provider = isSearchProviderCredential(c);
    if (provider) out.push({ ...c, provider });
  }
  return out;
}

export async function revokeSearchProviderCredential(credentialId: string): Promise<void> {
  const api = getCredentialRuntime();
  await api.revokeCredential(credentialId);
}

/** Effective provider that `web_search` will currently use. */
export async function getActiveSearchProvider(): Promise<SearchProviderId | "duckduckgo"> {
  const creds = await listSearchProviderCredentials();
  const has = (id: SearchProviderId) => creds.some((c) => c.provider === id);
  if (has("tavily")) return "tavily";
  if (has("brave")) return "brave";
  if (has("exa")) return "exa";
  return "duckduckgo";
}
