import { describe, expect, it, vi } from "vitest";
import { createWorkspacePresentationClient } from "./workspacePresentation.js";

describe("workspace presentation boundary", () => {
  it("uses only the composed workspace-state service for shell reads", async () => {
    const page = {
      revision: 7,
      group: { kind: "roots" as const, ownerUserId: "user-1" },
      nodes: [
        {
          slotId: "panel:browser",
          parentSlotId: null,
          ownerUserId: "user-1",
          createdAt: 1,
          childCount: 0,
          source: "panels/browser",
          title: "Example",
          icon: "🌐",
          kind: "workspace" as const,
          ref: "release",
          placement: { disposition: "side" as const, preferredWidth: 420 },
        },
      ],
      nextCursor: null,
    };
    const call = vi.fn(async (target: string, method: string) => {
      if (target === "main" && method === "workspace-state.panelTree.page") {
        return page;
      }
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });

    const client = createWorkspacePresentationClient({ call } as never);
    await expect(
      client.page({
        group: { kind: "roots", ownerUserId: "user-1" },
        limit: 10,
      }),
    ).resolves.toEqual(page);
    expect(call).toHaveBeenCalledOnce();
    expect(call).not.toHaveBeenCalledWith(
      "main",
      "workers.resolveService",
      expect.anything(),
    );
  });

  it("maps composed detail into the existing shell presentation shape", async () => {
    const call = vi.fn(async (target: string, method: string) => {
      if (target === "main" && method === "workspace-state.panelTree.detail") {
        return {
          revision: 1,
          slot: {
            slot_id: "panel:tree/chat",
            current_entity_title: "Agentic Chat",
          },
          currentHistory: { source: "panels/chat" },
          entity: { id: "panel:nav-chat" },
          icon: "./assets/chat.svg",
        };
      }
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });

    const client = createWorkspacePresentationClient({ call } as never);
    await expect(client.detail("panel:tree/chat")).resolves.toMatchObject({
      presentation: {
        title: "Agentic Chat",
        icon: "./assets/chat.svg",
      },
    });
  });

  it("routes presentation lifecycle methods through workspace-state without resolving the owner", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const call = vi.fn(
      async (target: string, method: string, args: unknown[]) => {
        if (target !== "main" || !method.startsWith("workspace-state.")) {
          throw new Error(`Unexpected RPC ${target}.${method}`);
        }
        calls.push({ method, args });
        return method.endsWith("panel.index") ||
          method.endsWith("panel.updateTitle")
          ? "panel:nav-chat"
          : undefined;
      },
    );
    const client = createWorkspacePresentationClient({ call } as never);

    await client.indexPanel({ id: "panel:tree/chat", title: "Agentic Chat" });
    await client.updatePanelTitle("panel:tree/chat", "Renamed");
    await client.incrementAccess("panel:tree/chat");
    await client.sourceUsage(25);
    await client.rebuildIndex();

    expect(calls).toEqual([
      {
        method: "workspace-state.panel.index",
        args: [{ id: "panel:tree/chat", title: "Agentic Chat" }],
      },
      {
        method: "workspace-state.panel.updateTitle",
        args: ["panel:tree/chat", "Renamed"],
      },
      {
        method: "workspace-state.panel.incrementAccess",
        args: ["panel:tree/chat"],
      },
      { method: "workspace-state.panel.sourceUsage", args: [25] },
      { method: "workspace-state.panel.rebuildIndex", args: [] },
    ]);
    expect(call).not.toHaveBeenCalledWith(
      "main",
      "workers.resolveService",
      expect.anything(),
    );
  });

  it("omits absent optional RPC arguments rather than serializing them as null", async () => {
    const call = vi.fn(async () => "panel:nav-chat");
    const client = createWorkspacePresentationClient({ call } as never);

    await client.updatePanelTitle("panel:tree/chat", "Agentic Chat");

    expect(call).toHaveBeenCalledWith(
      "main",
      "workspace-state.panel.updateTitle",
      ["panel:tree/chat", "Agentic Chat"],
    );
  });
});
