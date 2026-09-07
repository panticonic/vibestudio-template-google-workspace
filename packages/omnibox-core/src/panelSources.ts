/**
 * One walk of the workspace source tree (spec §2.2, P6 consolidation).
 *
 * There used to be two: `collectLaunchablePanelGroups` here for the launcher's
 * "which panels can I open" catalogue, and `collectPanelSourceSuggestions` in
 * `@vibestudio/shared/panelChrome` for the title bar's panel-path completion.
 * Same recursion, same nodes, two answers that could drift. P6 keeps both
 * *answers* — they really are different projections, one needs
 * description/icon/hidden and the other needs packages, skills and units — but
 * derives them from a single `visitWorkspaceNodes`.
 *
 * Everything here is pure. `getSharedPanelAddressOptions` takes the repository
 * reader as an injected adapter rather than importing a runtime client, so this
 * module still loads in a panel, the shell chrome, an overlay document and
 * React Native alike.
 */
import { isAboutSource } from "@vibestudio/workspace-contracts/aboutNamespace";

/**
 * Structural mirror of the runtime's `WorkspaceNode`, declared locally so the
 * omnibox engine stays free of `@workspace/runtime` (it has to run in panels,
 * the shell chrome, an overlay document, and React Native alike). Callers pass
 * the real runtime nodes; only the fields the traversal reads are named here.
 */
export interface WorkspaceNode {
  name: string;
  path: string;
  isUnit: boolean;
  launchable?: {
    type: "app";
    title: string;
    description?: string;
    icon?: string;
    /** Names a `./`-relative icon's content, so its URL can be cached forever. */
    iconVersion?: string;
    hidden?: boolean;
  };
  packageInfo?: {
    name: string;
    version?: string;
  };
  skillInfo?: {
    name: string;
    description: string;
  };
  children: WorkspaceNode[];
}

/** Depth-first walk in declaration order — the one traversal of the tree. */
export function visitWorkspaceNodes(
  nodes: WorkspaceNode[],
  visit: (node: WorkspaceNode) => void
): void {
  const walk = (node: WorkspaceNode) => {
    visit(node);
    for (const child of node.children) walk(child);
  };
  for (const node of nodes) walk(node);
}

/** A completion row for the title bar's panel-path field. */
export interface PanelSourceSuggestion {
  source: string;
  title?: string;
  kind: "launchable" | "package" | "skill" | "unit" | "folder";
}

export interface PanelAddressOptions {
  source: string;
  suggestions: PanelSourceSuggestion[];
}

/** Every addressable node in the tree, as panel-path completion rows. */
export function collectPanelSourceSuggestions(nodes: WorkspaceNode[]): PanelSourceSuggestion[] {
  const suggestions: PanelSourceSuggestion[] = [];
  visitWorkspaceNodes(nodes, (node) => {
    const kind: PanelSourceSuggestion["kind"] = node.launchable
      ? "launchable"
      : node.packageInfo
        ? "package"
        : node.skillInfo
          ? "skill"
          : node.isUnit
            ? "unit"
            : "folder";

    if (node.launchable || node.packageInfo || node.skillInfo || node.isUnit) {
      suggestions.push({
        source: node.path,
        title:
          node.launchable?.title ?? node.packageInfo?.name ?? node.skillInfo?.name ?? node.name,
        kind,
      });
    }
  });
  return suggestions.sort((a, b) => a.source.localeCompare(b.source));
}

export function filterPanelSourceSuggestions(
  suggestions: PanelSourceSuggestion[],
  query: string,
  limit = 50
): PanelSourceSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();
  return suggestions
    .filter(
      (item) =>
        !normalizedQuery ||
        item.source.toLowerCase().includes(normalizedQuery) ||
        item.title?.toLowerCase().includes(normalizedQuery)
    )
    .slice(0, limit);
}

export interface AddressProviderRepoAdapter {
  sourceTree(): Promise<{ children: WorkspaceNode[] }>;
}

/** Panel-path suggestions are scoped to navigable panel sources: `panels/*` and `about/*`. */
function isPanelOrAboutSource(suggestion: PanelSourceSuggestion): boolean {
  return suggestion.source.startsWith("panels/") || isAboutSource(suggestion.source);
}

export async function getSharedPanelAddressOptions(args: {
  source: string;
  repoProvider?: AddressProviderRepoAdapter | null;
}): Promise<PanelAddressOptions> {
  const { source, repoProvider } = args;
  if (!repoProvider) return { source, suggestions: [] };

  const tree = await repoProvider.sourceTree();
  const suggestions = filterPanelSourceSuggestions(
    collectPanelSourceSuggestions(tree.children).filter(isPanelOrAboutSource),
    source,
    50
  );
  return { source, suggestions };
}
