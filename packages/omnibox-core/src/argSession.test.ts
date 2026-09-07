import { describe, expect, it } from "vitest";
import {
  filledArgChips,
  reduceArgSession,
  startArgSession,
  type ArgSession,
  type ArgSessionOutcome,
} from "./argSession";
import type { CommandSpec, SurfaceContext } from "./commands";

const ctx: SurfaceContext = { openPanels: { entries: [] }, platform: "desktop" };

const movePanel: CommandSpec = {
  id: "panel.move",
  title: "Move Panel",
  section: "Panel",
  surfaces: ["desktop"],
  args: [
    {
      name: "direction",
      label: "direction",
      type: "enum",
      required: true,
      options: [
        { value: "left", label: "Left" },
        { value: "right", label: "Right" },
        { value: "up", label: "Up" },
        { value: "down", label: "Down" },
      ],
    },
  ],
};

const reloadPanel: CommandSpec = {
  id: "panel.reload",
  title: "Reload Panel",
  section: "Panel",
  surfaces: ["desktop"],
};

const newPanel: CommandSpec = {
  id: "panel.new",
  title: "New Panel",
  section: "Panel",
  surfaces: ["desktop"],
  args: [{ name: "source", label: "source", type: "source", required: false }],
};

const openUrl: CommandSpec = {
  id: "nav.open-url",
  title: "Open URL",
  section: "Navigate",
  surfaces: ["desktop"],
  args: [
    {
      name: "url",
      label: "address",
      type: "url",
      required: true,
      validate: (value) => (value.includes(".") ? null : "Enter a web address."),
    },
  ],
};

const rename: CommandSpec = {
  id: "panel.rename",
  title: "Rename Panel",
  section: "Panel",
  surfaces: ["desktop"],
  args: [
    { name: "title", label: "title", type: "string", required: true },
    { name: "note", label: "note", type: "string", required: false },
  ],
};

function session(outcome: ArgSessionOutcome): ArgSession {
  if (outcome.kind !== "session") throw new Error(`expected a session, got ${outcome.kind}`);
  return outcome.session;
}

describe("startArgSession", () => {
  it("executes immediately for an argument-less command", () => {
    expect(startArgSession(reloadPanel)).toEqual({
      kind: "execute",
      command: reloadPanel,
      args: {},
    });
  });

  it("opens on the first unfilled argument and remembers the query to restore", () => {
    const state = session(startArgSession(movePanel, { restoreQuery: "mov" }));
    expect(state.activeIndex).toBe(0);
    expect(state.query).toBe("");
    expect(state.restoreQuery).toBe("mov");
    expect(state.error).toBeNull();
  });

  it("executes when an inline utterance already supplied every argument", () => {
    expect(startArgSession(movePanel, { prefilled: { direction: "right" } })).toEqual({
      kind: "execute",
      command: movePanel,
      args: { direction: "right" },
    });
  });

  it("seeds the prompted argument with the leftover inline tail", () => {
    const state = session(startArgSession(openUrl, { seedQuery: "example" }));
    expect(state.query).toBe("example");
    expect(state.activeIndex).toBe(0);
  });

  it("skips past arguments an inline parse already resolved", () => {
    const state = session(startArgSession(rename, { prefilled: { title: "Notes" } }));
    expect(state.activeIndex).toBe(1);
    expect(filledArgChips(state)).toEqual([
      { arg: rename.args![0], value: "Notes" },
    ]);
  });
});

describe("reduceArgSession", () => {
  it("fills the active argument and executes after the last one", () => {
    const state = session(startArgSession(movePanel));
    expect(reduceArgSession(state, { type: "enter", value: "right" })).toEqual({
      kind: "execute",
      command: movePanel,
      args: { direction: "right" },
    });
  });

  it("advances to the next argument instead of executing early", () => {
    const state = session(startArgSession(rename));
    const next = session(reduceArgSession(state, { type: "enter", value: "Notes" }));
    expect(next.activeIndex).toBe(1);
    expect(next.filled).toEqual({ title: "Notes" });
    expect(next.query).toBe("");
  });

  it("rejects an invalid enum value without closing the session", () => {
    const state = session(startArgSession(movePanel));
    const next = session(reduceArgSession(state, { type: "enter", value: "sideways" }));
    expect(next.error).toContain("direction must be one of");
    expect(next.filled).toEqual({});
    expect(next.activeIndex).toBe(0);
  });

  it("surfaces a spec-supplied validation message", () => {
    const state = session(startArgSession(openUrl));
    const next = session(reduceArgSession(state, { type: "enter", value: "notanaddress" }));
    expect(next.error).toBe("Enter a web address.");
  });

  it("clears the error as soon as the user types again", () => {
    const failed = session(
      reduceArgSession(session(startArgSession(openUrl)), { type: "enter", value: "nope" })
    );
    const typed = session(reduceArgSession(failed, { type: "input", value: "n" }));
    expect(typed.error).toBeNull();
    expect(typed.query).toBe("n");
  });

  it("refuses to skip a required argument on empty Enter", () => {
    const state = session(startArgSession(movePanel));
    const next = session(reduceArgSession(state, { type: "enter" }));
    expect(next.error).toBe("direction is required.");
    expect(next.activeIndex).toBe(0);
  });

  it("skips an optional argument on empty Enter, leaving it absent", () => {
    expect(reduceArgSession(session(startArgSession(newPanel)), { type: "enter" })).toEqual({
      kind: "execute",
      command: newPanel,
      args: {},
    });
  });

  it("uses the typed query when Enter carries no explicit value", () => {
    const typed = session(
      reduceArgSession(session(startArgSession(movePanel)), { type: "input", value: " left " })
    );
    expect(reduceArgSession(typed, { type: "enter" })).toEqual({
      kind: "execute",
      command: movePanel,
      args: { direction: "left" },
    });
  });

  it("pops the last filled argument on backspace and restores it as the query", () => {
    const filled = session(
      reduceArgSession(session(startArgSession(rename)), { type: "enter", value: "Notes" })
    );
    const popped = session(reduceArgSession(filled, { type: "backspace" }));
    expect(popped.activeIndex).toBe(0);
    expect(popped.filled).toEqual({});
    expect(popped.query).toBe("Notes");
  });

  it("exits the session when backspace has nothing left to pop", () => {
    expect(reduceArgSession(session(startArgSession(movePanel, { restoreQuery: "mov" })), {
      type: "backspace",
    })).toEqual({ kind: "exit", restoreQuery: "mov" });
  });

  it("exits on escape, restoring the query that found the command", () => {
    expect(
      reduceArgSession(session(startArgSession(movePanel, { restoreQuery: "move" })), {
        type: "escape",
      })
    ).toEqual({ kind: "exit", restoreQuery: "move" });
  });

  it("walks a two-argument command forwards and backwards", () => {
    let state = session(startArgSession(rename, { restoreQuery: "ren" }));
    state = session(reduceArgSession(state, { type: "enter", value: "Notes" }));
    state = session(reduceArgSession(state, { type: "backspace" }));
    state = session(reduceArgSession(state, { type: "enter", value: "Journal" }));
    expect(reduceArgSession(state, { type: "enter", value: "daily" })).toEqual({
      kind: "execute",
      command: rename,
      args: { title: "Journal", note: "daily" },
    });
  });
});

describe("validation through the wire subset", () => {
  it("enforces a numeric argument", () => {
    const zoom: CommandSpec = {
      id: "view.zoom",
      title: "Zoom",
      section: "Appearance & Layout",
      surfaces: ["desktop"],
      args: [{ name: "level", label: "level", type: "number", required: true }],
    };
    const state = session(startArgSession(zoom));
    expect(session(reduceArgSession(state, { type: "enter", value: "big" })).error).toBe(
      "level must be a number."
    );
    expect(reduceArgSession(state, { type: "enter", value: "1.5" })).toEqual({
      kind: "execute",
      command: zoom,
      args: { level: "1.5" },
    });
  });
});

describe("availability does not leak into the session", () => {
  it("keeps a session usable for a command whose context later changes", () => {
    const contextual: CommandSpec = {
      ...movePanel,
      availability: (surface: SurfaceContext) => surface.focusedPanel !== undefined,
    };
    const state = session(startArgSession(contextual));
    expect(ctx.focusedPanel).toBeUndefined();
    expect(reduceArgSession(state, { type: "enter", value: "up" })).toEqual({
      kind: "execute",
      command: contextual,
      args: { direction: "up" },
    });
  });
});
