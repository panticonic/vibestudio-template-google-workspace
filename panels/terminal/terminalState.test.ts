import { describe, expect, it } from "vitest";
import {
  defaultTerminalState,
  loadTerminalState,
  TERMINAL_STATE_SCHEMA_VERSION,
} from "./terminalState.js";

describe("terminal exact state", () => {
  it("creates defaults only when the panel has no persisted state", () => {
    expect(loadTerminalState(null)).toEqual(defaultTerminalState());
  });

  it("loads the current exact schema without rewriting it", () => {
    const current = {
      ...defaultTerminalState(),
      panelTitle: "Build terminal",
      tree: { kind: "leaf" as const, sessionId: "session-1" },
      focusedSessionId: "session-1",
      perSession: {
        "session-1": {
          cwd: "/repo",
          originalArgv: ["pnpm", "dev"],
          readCursor: 12,
          lastSeenAt: 34,
        },
      },
      scratchBuffers: [{ bufferId: "scratch-1", text: "echo hi", createdAt: 1, updatedAt: 2 }],
      scratchActiveBufferId: "scratch-1",
    };

    expect(loadTerminalState(current)).toEqual(current);
  });

  it("does not restore transient scratch visibility", () => {
    const current = { ...defaultTerminalState(), scratchOpen: true };
    expect(loadTerminalState(current)).toEqual({ ...current, scratchOpen: false });
  });

  it("starts empty panels", () => {
    expect(loadTerminalState({})).toEqual(defaultTerminalState());
  });

  it.each([false, 0, "", []])("rejects non-object persisted state", (state) => {
    expect(() => loadTerminalState(state)).toThrow(/schema version/);
  });

  it.each([
    { ...defaultTerminalState(), schemaVersion: TERMINAL_STATE_SCHEMA_VERSION + 1 },
    { ...defaultTerminalState(), schemaVersion: TERMINAL_STATE_SCHEMA_VERSION - 1 },
    { ...defaultTerminalState(), fontSize: Number.NaN },
    { ...defaultTerminalState(), panelTitle: "  rewritten  " },
    { ...defaultTerminalState(), unexpected: "stale" },
    { ...defaultTerminalState(), scratchActiveBufferId: "missing" },
  ])("rejects non-current, malformed, or rewritten state", (state) => {
    expect(() => loadTerminalState(state)).toThrow(/current exact schema|schema version/);
  });
});
