/**
 * The launcher's projection of the workspace source tree.
 *
 * The walk itself lives in `./panelSources` — one traversal serves both this
 * catalogue and the title bar's panel-path completion (P6).
 */
import { visitWorkspaceNodes, type WorkspaceNode } from "./panelSources";

export type { WorkspaceNode };

export interface LaunchablePanel {
  path: string;
  title: string;
  description?: string;
  icon?: string;
  /** Names the icon's content, so its URL can be cached forever. */
  iconVersion?: string;
}

export interface LaunchablePanelGroups {
  panels: LaunchablePanel[];
  about: LaunchablePanel[];
}

interface CachedLaunchablePanelGroups {
  version: 2;
  groups: LaunchablePanelGroups;
}

export const LAUNCHABLE_PANEL_CACHE_KEY = "vibestudio:new-panel-catalog";

const byTitle = (a: LaunchablePanel, b: LaunchablePanel) => a.title.localeCompare(b.title);

function launchablePanel(node: WorkspaceNode): LaunchablePanel {
  return {
    path: node.path,
    title: node.launchable?.title ?? node.name,
    ...(node.launchable?.description ? { description: node.launchable.description } : {}),
    ...(node.launchable?.icon ? { icon: node.launchable.icon } : {}),
    ...(node.launchable?.iconVersion ? { iconVersion: node.launchable.iconVersion } : {}),
  };
}

/** Collect visible launch targets into the categories shown by the launcher. */
export function collectLaunchablePanelGroups(nodes: WorkspaceNode[]): LaunchablePanelGroups {
  const groups: LaunchablePanelGroups = { panels: [], about: [] };

  visitWorkspaceNodes(nodes, (node) => {
    if (node.launchable && !node.launchable.hidden) {
      if (node.path.startsWith("panels/")) groups.panels.push(launchablePanel(node));
      else if (node.path.startsWith("about/")) groups.about.push(launchablePanel(node));
    }
  });

  groups.panels.sort(byTitle);
  groups.about.sort(byTitle);
  return groups;
}

function isLaunchablePanel(
  value: unknown,
  namespace: "panels" | "about"
): value is LaunchablePanel {
  if (!value || typeof value !== "object") return false;
  const panel = value as Record<string, unknown>;
  return (
    typeof panel["path"] === "string" &&
    panel["path"].startsWith(`${namespace}/`) &&
    typeof panel["title"] === "string" &&
    panel["title"].length > 0 &&
    (panel["description"] === undefined || typeof panel["description"] === "string") &&
    (panel["icon"] === undefined ||
      (typeof panel["icon"] === "string" && panel["icon"].length <= 256))
  );
}

/** Decode the small, versioned launcher projection stored by a prior panel. */
export function parseCachedLaunchablePanelGroups(raw: string | null): LaunchablePanelGroups | null {
  if (!raw) return null;
  try {
    const cached = JSON.parse(raw) as Partial<CachedLaunchablePanelGroups>;
    if (
      cached.version !== 2 ||
      !cached.groups ||
      !Array.isArray(cached.groups.panels) ||
      !cached.groups.panels.every((panel) => isLaunchablePanel(panel, "panels")) ||
      !Array.isArray(cached.groups.about) ||
      !cached.groups.about.every((panel) => isLaunchablePanel(panel, "about"))
    ) {
      return null;
    }
    return cached.groups;
  } catch {
    return null;
  }
}

export function serializeLaunchablePanelGroups(groups: LaunchablePanelGroups): string {
  return JSON.stringify({ version: 2, groups } satisfies CachedLaunchablePanelGroups);
}
