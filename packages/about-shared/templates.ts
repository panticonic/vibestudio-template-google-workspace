export interface TemplateCatalogPresentationEntry {
  name: string;
  description: string;
  tags: readonly string[];
}

export function filterTemplateCatalog<T extends TemplateCatalogPresentationEntry>(
  entries: readonly T[],
  query: string
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...entries];
  return entries.filter((entry) =>
    [entry.name, entry.description, ...entry.tags].join(" ").toLocaleLowerCase().includes(needle)
  );
}

export function templateCatalogEmptyMessage(totalEntries: number, query: string): string | null {
  if (totalEntries === 0)
    return "No featured templates are published yet. Use a template address below.";
  return query.trim() ? "No templates match that search." : null;
}

export function isTemplateHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function gitCredentialInputRequest(requirement: {
  name: string;
  remoteUrl: string;
  provider: string;
}) {
  return {
    title: `Connect ${requirement.provider}`,
    description: `Enter an access token for ${requirement.remoteUrl}. It is stored in your encrypted profile and remains scoped to this Git remote.`,
    credential: {
      label: requirement.name,
      audience: [{ url: requirement.remoteUrl, match: "path-prefix" as const }],
      injection: {
        type: "basic-auth" as const,
        usernameTemplate: "git",
        passwordTemplate: "{token}",
      },
      bindings: [
        {
          id: "git-http",
          label: `${requirement.provider} Git`,
          use: "git-http" as const,
          audience: [{ url: requirement.remoteUrl, match: "path-prefix" as const }],
          injection: {
            type: "basic-auth" as const,
            usernameTemplate: "git",
            passwordTemplate: "{token}",
          },
        },
      ],
      metadata: { providerId: requirement.provider },
    },
    fields: [
      {
        name: "token",
        label: `${requirement.provider} access token`,
        type: "secret" as const,
        required: true,
      },
    ],
    material: { type: "bearer-token" as const, tokenField: "token" },
  };
}
