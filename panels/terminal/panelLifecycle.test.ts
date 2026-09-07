import { describe, expect, it, vi } from "vitest";
import { collectPanelSessionIds, disposePanelSessions } from "./panelLifecycle.js";
import type { ShellApi, TerminalState } from "./types.js";

describe("terminal panel lifecycle", () => {
  it("collects unique session ids across the split tree", () => {
    const state = stateWithSessions();

    expect(collectPanelSessionIds(state)).toEqual(["a", "b", "c"]);
  });

  it("best-effort disposes every owned panel session", () => {
    const dispose = vi.fn(async () => {});
    const state = stateWithSessions();

    disposePanelSessions({ dispose } as unknown as ShellApi, state);

    expect(dispose).toHaveBeenCalledWith("a");
    expect(dispose).toHaveBeenCalledWith("b");
    expect(dispose).toHaveBeenCalledWith("c");
    expect(dispose).toHaveBeenCalledTimes(3);
  });
});

function stateWithSessions(): Pick<TerminalState, "tree"> {
  return {
    tree: {
      kind: "split",
      direction: "row",
      ratio: 0.5,
      a: {
        kind: "split",
        direction: "column",
        ratio: 0.5,
        a: { kind: "leaf", sessionId: "a" },
        b: { kind: "leaf", sessionId: "b" },
      },
      b: { kind: "leaf", sessionId: "c" },
    },
  };
}
