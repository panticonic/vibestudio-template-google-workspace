export interface EndpointDeclaration {
  url: string;
  methods: string[] | "*";
}

export interface WebhookBinding {
  event: string;
  deliver: string;
}

export interface IntegrationManifest {
  scopes?: Record<string, string[]>;
  endpoints?: Record<string, EndpointDeclaration[]>;
  webhooks?: Record<string, WebhookBinding[]>;
}

export interface DiscoveredManifest {
  moduleName: string;
  manifest: IntegrationManifest;
}

export function collectManifests(modules: Record<string, unknown>): DiscoveredManifest[] {
  const results: DiscoveredManifest[] = [];

  for (const [name, mod] of Object.entries(modules)) {
    if (!mod || typeof mod !== "object") continue;
    const manifest = (mod as Record<string, unknown>)["manifest"];
    if (!manifest || typeof manifest !== "object") continue;
    results.push({ moduleName: name, manifest: manifest as IntegrationManifest });
  }

  return results;
}
