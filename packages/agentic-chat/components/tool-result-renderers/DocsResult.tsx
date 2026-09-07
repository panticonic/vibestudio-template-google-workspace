import React from "react";
import { Badge, Box, Code, Flex, Text } from "@radix-ui/themes";
import { CodePreview } from "../shared/CodePreview";
import { CollapsibleSection } from "../shared/CollapsibleSection";

/**
 * Rich result renderers for the first-party `docs_open` / `docs_search` tools.
 * Both carry their structured payload in `result.details` (a `CatalogEntry` or a
 * `CatalogHit[]`); this turns the otherwise raw JSON-schema dump into a card with
 * access badges, the typed schemas, and examples. Dispatched by tool name from
 * `ActionMessage`; non-docs tools / unrecognized shapes fall back to the generic
 * `ToolDataView`.
 */

interface CatalogHit {
  id: string;
  surface: string;
  qualifiedName: string;
  title: string;
  description?: string;
}
interface CatalogEntry extends CatalogHit {
  parent?: string;
  access?: {
    callers?: string[];
    sensitivity?: string;
    restrictedTo?: Array<{ when: string; callers: string[]; reason: string }>;
    approval?: Array<{ when?: string; capability?: string; reason: string }>;
    requires?: Array<{ kind: string; description: string }>;
  };
  argsSchema?: Record<string, unknown>;
  returnsSchema?: Record<string, unknown>;
  members?: string[];
  examples?: unknown[];
}

const SENSITIVITY_COLOR: Record<string, "green" | "amber" | "orange" | "red"> = {
  read: "green",
  write: "amber",
  admin: "orange",
  destructive: "red",
};

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function hasCatalogShape(v: unknown): v is Record<string, unknown> {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as Record<string, unknown>)["surface"] === "string" &&
    typeof (v as Record<string, unknown>)["qualifiedName"] === "string"
  );
}

export function DocsOpenResult({ entry }: { entry: CatalogEntry }) {
  const access = entry.access ?? {};
  return (
    <Flex direction="column" gap="2">
      <Flex align="center" gap="2" wrap="wrap">
        <Code size="2">{entry.qualifiedName}</Code>
        <Badge color="gray" variant="soft" size="1">
          {entry.surface}
        </Badge>
        {access.sensitivity && (
          <Badge color={SENSITIVITY_COLOR[access.sensitivity] ?? "gray"} variant="soft" size="1">
            {access.sensitivity}
          </Badge>
        )}
      </Flex>

      {entry.description && <Text size="2">{entry.description}</Text>}

      {access.callers && access.callers.length > 0 && (
        <Flex align="center" gap="1" wrap="wrap">
          <Text size="1" color="gray">
            Callers:
          </Text>
          {access.callers.map((caller) => (
            <Badge key={caller} size="1" variant="outline" color="gray">
              {caller}
            </Badge>
          ))}
        </Flex>
      )}

      {(access.restrictedTo ?? []).map((restriction, index) => (
        <Text key={`restrict-${index}`} size="1" color="amber">
          Restricted ({restriction.reason}): when {restriction.when} → only [
          {restriction.callers.join(", ")}]
        </Text>
      ))}
      {(access.approval ?? []).map((approval, index) => (
        <Text key={`approval-${index}`} size="1" color="orange">
          Approval: {approval.reason}
          {approval.capability ? ` (capability: ${approval.capability})` : ""}
          {approval.when ? ` — when ${approval.when}` : ""}
        </Text>
      ))}
      {(access.requires ?? []).map((requirement, index) => (
        <Text key={`requires-${index}`} size="1" color="gray">
          Requires {requirement.kind}: {requirement.description}
        </Text>
      ))}

      {entry.members && entry.members.length > 0 && (
        <Text size="1" color="gray">
          Members: {entry.members.join(", ")}
        </Text>
      )}

      {entry.argsSchema && (
        <CollapsibleSection label="Args schema" defaultOpen={true}>
          <CodePreview code={json(entry.argsSchema)} language="json" label="args" />
        </CollapsibleSection>
      )}
      {entry.returnsSchema && (
        <CollapsibleSection label="Returns schema" defaultOpen={false}>
          <CodePreview code={json(entry.returnsSchema)} language="json" label="returns" />
        </CollapsibleSection>
      )}
      {entry.examples && entry.examples.length > 0 && (
        <CollapsibleSection label={`Examples (${entry.examples.length})`} defaultOpen={false}>
          <CodePreview code={json(entry.examples)} language="json" label="examples" />
        </CollapsibleSection>
      )}
    </Flex>
  );
}

export function DocsSearchResult({ hits }: { hits: CatalogHit[] }) {
  if (hits.length === 0) {
    return (
      <Text size="1" color="gray">
        No catalog matches.
      </Text>
    );
  }
  return (
    <Flex direction="column" gap="2">
      <Text size="1" color="gray">
        {hits.length} result{hits.length === 1 ? "" : "s"}
      </Text>
      {hits.map((hit) => (
        <Box key={hit.id} style={{ borderTop: "1px solid var(--gray-a4)", paddingTop: 6 }}>
          <Flex align="center" gap="2" wrap="wrap">
            <Code size="1">{hit.id}</Code>
            <Badge size="1" color="gray" variant="soft">
              {hit.surface}
            </Badge>
          </Flex>
          {hit.description && (
            <Text size="1" color="gray">
              {hit.description}
            </Text>
          )}
        </Box>
      ))}
    </Flex>
  );
}

/**
 * Dispatch a docs tool result to its renderer. Returns null for non-docs tools or
 * unrecognized result shapes so the caller can fall back to the generic viewer.
 */
export function renderDocsToolResult(toolName: string, result: unknown): React.ReactNode | null {
  const details =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)["details"]
      : undefined;
  if (toolName === "docs_open" && hasCatalogShape(details)) {
    return <DocsOpenResult entry={details as unknown as CatalogEntry} />;
  }
  if (toolName === "docs_search" && Array.isArray(details)) {
    const hits = details.filter(hasCatalogShape) as unknown as CatalogHit[];
    if (hits.length === details.length) return <DocsSearchResult hits={hits} />;
  }
  return null;
}
