import { describe, expect, it, vi } from "vitest";
import { createRuntimeWorkspaceStateClient } from "./workspaceStateClient.js";

describe("createRuntimeWorkspaceStateClient", () => {
  it("uses the canonical workspace-state service without resolving a parallel DO path", async () => {
    const call = vi.fn(async (_target: string, _method: string, _args: unknown[]) => ({
      revision: 1,
      groups: [],
      nextCursor: null,
    }));
    const client = createRuntimeWorkspaceStateClient({ call });

    await client.getPanelTreeRootGroups({ limit: 25 });

    expect(call).toHaveBeenCalledWith("main", "workspace-state.panelTree.rootGroups", [
      { limit: 25 },
    ]);
    expect(call.mock.calls.map((entry: unknown[]) => entry[1])).not.toContain(
      "workers.resolveService"
    );
  });

  it("routes semantic commits through the service that owns post-commit convergence", async () => {
    const result = {
      previousEntityId: "panel:nav-old",
      currentEntityId: "panel:nav-new",
      currentEntryKey: "nav-new",
      cursor: 1,
    };
    const call = vi.fn(async (_target: string, _method: string, _args: unknown[]) => result);
    const client = createRuntimeWorkspaceStateClient({ call });
    const input = {
      slotId: "panel:tree/news" as never,
      expectedCurrentEntityId: "panel:nav-old" as never,
      mutation: { kind: "select" as const, entryKey: "nav-new" },
    };

    await expect(client.commitPreparedNavigation(input)).resolves.toEqual(result);
    expect(call).toHaveBeenCalledWith("main", "workspace-state.slot.commitPreparedNavigation", [
      input,
    ]);
  });
});
