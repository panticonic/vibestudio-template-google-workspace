import { describe, expect, it } from "vitest";
import {
  collectLaunchablePanelGroups,
  parseCachedLaunchablePanelGroups,
  serializeLaunchablePanelGroups,
  type WorkspaceNode,
} from "./launchablePanels";

function node(
  path: string,
  options: {
    title?: string;
    hidden?: boolean;
    icon?: string;
    children?: WorkspaceNode[];
    launchable?: boolean;
  } = {}
): WorkspaceNode {
  return {
    name: path.split("/").at(-1) ?? path,
    path,
    isUnit: path.includes("/"),
    children: options.children ?? [],
    ...(options.launchable
      ? {
          launchable: {
            type: "app" as const,
            title: options.title ?? path,
            ...(options.icon ? { icon: options.icon } : {}),
            ...(options.hidden ? { hidden: true } : {}),
          },
        }
      : {}),
  };
}

describe("collectLaunchablePanelGroups", () => {
  it("groups visible panel targets by workspace source", () => {
    const groups = collectLaunchablePanelGroups([
      node("panels", {
        children: [
          node("panels/terminal", { launchable: true, title: "Terminal" }),
          node("panels/chat", { launchable: true, title: "Chat", icon: "💬" }),
          node("panels/internal", { launchable: true, title: "Internal", hidden: true }),
        ],
      }),
      node("about", {
        children: [
          node("about/help", { launchable: true, title: "Help" }),
          node("about/about", { launchable: true, title: "About Vibestudio" }),
        ],
      }),
      node("skills/example"),
      node("extensions/example"),
      node("workers/agent", { launchable: true, title: "Agent" }),
    ]);

    expect(groups).toEqual({
      panels: [
        { path: "panels/chat", title: "Chat", icon: "💬" },
        { path: "panels/terminal", title: "Terminal" },
      ],
      about: [
        { path: "about/about", title: "About Vibestudio" },
        { path: "about/help", title: "Help" },
      ],
    });
  });

  it("round-trips the small launcher projection through its versioned cache", () => {
    const groups = {
      panels: [{ path: "panels/chat", title: "Chat", description: "Start a chat" }],
      about: [{ path: "about/help", title: "Help" }],
    };

    expect(parseCachedLaunchablePanelGroups(serializeLaunchablePanelGroups(groups))).toEqual(
      groups
    );
  });

  it("ignores malformed, obsolete, and cross-namespace cache entries", () => {
    expect(parseCachedLaunchablePanelGroups("not json")).toBeNull();
    expect(parseCachedLaunchablePanelGroups(JSON.stringify({ version: 0, groups: {} }))).toBeNull();
    expect(
      parseCachedLaunchablePanelGroups(
        JSON.stringify({
          version: 2,
          groups: {
            panels: [{ path: "workers/agent", title: "Agent" }],
            about: [],
          },
        })
      )
    ).toBeNull();
  });
});
