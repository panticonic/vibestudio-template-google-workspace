import { describe, expect, it, vi } from "vitest";
import { observeWorkspace } from "./workspace.js";
import type { ExtensionContextLike } from "./context.js";

describe("template workspace observation", () => {
  it("reads one exact protected main and inventories it without creating a context", async () => {
    const state = { kind: "event", eventId: "event:current-main" };
    const call = vi.fn(
      async (_target: string, method: string, ...args: unknown[]) => {
        if (method === "vcs.mainState") {
          expect(args).toEqual([]);
          return state;
        }
        if (method === "vcs.listDirectory") {
          expect(args[0]).toMatchObject({ state });
          return {
            state,
            path: "",
            entries: [
              { path: "meta", kind: "directory", repositoryRoot: true },
            ],
            nextCursor: null,
          };
        }
        throw new Error(`Unexpected observation mutation: ${method}`);
      },
    );
    const ctx = {
      rpc: { call },
      workspace: {
        getInfo: async () => ({
          id: "workspace:test",
          config: { systemEpoch: 1 },
        }),
      },
    } as unknown as ExtensionContextLike;
    await expect(observeWorkspace(ctx)).resolves.toMatchObject({
      mainState: state,
      mainEventId: state.eventId,
      localRepoPaths: new Set(["meta"]),
    });
    expect(call.mock.calls.map(([, method]) => method)).toEqual([
      "vcs.mainState",
      "vcs.listDirectory",
    ]);
  });
});
