import { describe, expect, it, vi } from "vitest";
import type { RpcClient } from "@vibestudio/rpc";
import { updatePanelStateArgs } from "./panelStateArgsPersistence.js";

describe("updatePanelStateArgs", () => {
  it("reads only compact validation metadata before persisting state args", async () => {
    const call = vi.fn(async (_target: string, method: string, args: unknown[]) => {
      if (method === "workspace-state.panelTree.detail") {
        return {
          currentHistory: { state_args: JSON.stringify({ preserved: true }) },
          entity: { activeBuildKey: "build-chat" },
        };
      }
      if (method === "build.getBuildMetadata") {
        return { stateArgsSchema: { type: "object" } };
      }
      if (method === "workspace-state.slot.updateCurrentStateArgs") return undefined;
      throw new Error(`Unexpected RPC ${method} ${JSON.stringify(args)}`);
    });

    await expect(
      updatePanelStateArgs({ call: call as RpcClient["call"] }, "panel:tree/chat", {
        channelName: "chat-1",
      }),
    ).resolves.toEqual({ preserved: true, channelName: "chat-1" });

    expect(call).toHaveBeenCalledWith("main", "build.getBuildMetadata", [
      "build-chat",
      { includeExecutableModules: false },
    ]);
    expect(call).toHaveBeenCalledWith(
      "main",
      "workspace-state.slot.updateCurrentStateArgs",
      ["panel:tree/chat", { preserved: true, channelName: "chat-1" }],
    );
  });
});
