import { describe, expect, it, vi } from "vitest";
import { createPanelSelfNavigation } from "./selfNavigation.js";

describe("panel self navigation", () => {
  it("reopens in the current workspace branch without emitting a context override", async () => {
    const call = vi.fn(async (_target: string, method: string) =>
      method === "workers.resolveService"
        ? { kind: "durable-object", targetId: "do:workspace-state" }
        : { currentHistory: { source: "panels/chat" } }
    );
    const navigatePanel = vi.fn(async () => ({ panelId: "slot-1", title: "Chat" }));
    const navigation = createPanelSelfNavigation({
      rpc: { call },
      slotId: "slot-1",
      navigatePanel,
    });

    await expect(navigation.reopen({ stateArgs: { channelName: "chat-1" } })).resolves.toEqual({
      id: "slot-1",
      title: "Chat",
    });
    expect(navigatePanel).toHaveBeenLastCalledWith(
      "slot-1",
      "panels/chat",
      { stateArgs: { channelName: "chat-1" } }
    );
  });

  it("switches context only through the panel navigation option", async () => {
    const call = vi.fn(async () => ({ id: "slot-1", title: "Chat" }));
    const navigatePanel = vi.fn(async () => ({ panelId: "slot-1", title: "Chat" }));
    const navigation = createPanelSelfNavigation({
      rpc: { call },
      slotId: "slot-1",
      navigatePanel,
    });

    await navigation.switchContext(" ctx-fork ", {
      source: "panels/chat",
      ref: "ctx:ctx-fork",
      stateArgs: { channelName: "fork-1" },
    });

    expect(navigatePanel).toHaveBeenCalledWith(
      "slot-1",
      "panels/chat",
      {
        contextId: "ctx-fork",
        ref: "ctx:ctx-fork",
        source: "panels/chat",
        stateArgs: { channelName: "fork-1" },
      }
    );
  });

  it("rejects an empty context before dispatch", () => {
    const call = vi.fn();
    const navigation = createPanelSelfNavigation({ rpc: { call }, slotId: "slot-1" });

    expect(() => navigation.switchContext("  ")).toThrow(/must be non-empty/);
    expect(call).not.toHaveBeenCalled();
  });
});
