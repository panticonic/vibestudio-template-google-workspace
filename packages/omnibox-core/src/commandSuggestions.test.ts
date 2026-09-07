import { describe, expect, it } from "vitest";
import {
  buildArgSuggestions,
  buildCommandSuggestions,
  groupOmniboxSuggestions,
  parseInlineCommand,
} from "./commandSuggestions";
import {
  commandSpecFromWire,
  type CommandSpec,
  type SurfaceContext,
  type WireCommandSpec,
} from "./commands";

const ctx: SurfaceContext = { openPanels: { entries: [] }, platform: "desktop" };

const focusedCtx: SurfaceContext = {
  openPanels: {
    entries: [
      { id: "panel:tree/a", title: "Sales Dashboard", source: "panels/sales" },
      { id: "panel:tree/b", title: "Import wizard", source: "panels/import" },
    ],
  },
  platform: "desktop",
  focusedPanel: { panelId: "panel:tree/a", title: "Sales Dashboard", pinned: true },
};

const move: CommandSpec = {
  id: "panel.move",
  title: "Move Panel",
  aliases: ["mv"],
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

const theme: CommandSpec = {
  id: "view.theme",
  title: "Theme",
  section: "Appearance & Layout",
  surfaces: ["desktop", "mobile"],
  args: [
    {
      name: "mode",
      label: "mode",
      type: "enum",
      required: true,
      options: [
        { value: "system", label: "System" },
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
      ],
    },
  ],
};

const reload: CommandSpec = {
  id: "panel.reload",
  title: "Reload Panel",
  keywords: ["refresh"],
  section: "Panel",
  surfaces: ["desktop"],
};

const unpin: CommandSpec = {
  id: "panel.unpin",
  title: "Unpin Panel",
  section: "Panel",
  surfaces: ["desktop"],
  availability: (surface) => (surface.focusedPanel?.pinned === true ? true : "hidden"),
};

/** `false` (rather than `"hidden"`) means listed but not runnable. */
const back: CommandSpec = {
  id: "nav.back",
  title: "Back",
  section: "Navigate",
  surfaces: ["desktop"],
  availability: (surface) => surface.focusedPanel?.canGoBack === true,
};

const shellDevtools: CommandSpec = {
  id: "debug.shell-devtools",
  title: "Open Shell DevTools",
  section: "Debug",
  surfaces: ["desktop"],
};

const focusPanel: CommandSpec = {
  id: "panel.focus",
  title: "Go to Panel",
  section: "Panel",
  surfaces: ["desktop"],
  args: [
    {
      name: "panel",
      label: "panel",
      type: "panel",
      required: true,
      suggest: (query, surface) =>
        surface.openPanels.entries
          .filter((entry) => entry.title.toLowerCase().includes(query.trim().toLowerCase()))
          .map((entry) => ({ value: entry.id, label: entry.title })),
    },
  ],
};

const slate = [move, theme, reload, unpin, shellDevtools, focusPanel];

const ids = (rows: { command: CommandSpec }[]) => rows.map((row) => row.command.id);

describe("buildCommandSuggestions", () => {
  it("matches title, alias, id tail, and never-displayed keywords", () => {
    expect(ids(buildCommandSuggestions({ query: "move", commands: slate, ctx }))).toContain(
      "panel.move"
    );
    expect(ids(buildCommandSuggestions({ query: "mv", commands: slate, ctx }))).toContain(
      "panel.move"
    );
    expect(
      ids(buildCommandSuggestions({ query: "shell-devtools", commands: slate, ctx }))
    ).toContain("debug.shell-devtools");
    expect(ids(buildCommandSuggestions({ query: "refresh", commands: slate, ctx }))).toContain(
      "panel.reload"
    );
  });

  it("ranks an exact title above a substring match", () => {
    const rows = buildCommandSuggestions({ query: "theme", commands: slate, ctx });
    expect(rows[0]?.command.id).toBe("view.theme");
  });

  it("keeps a keyword hit below a real title hit", () => {
    const rows = buildCommandSuggestions({
      query: "re",
      commands: [reload, { ...theme, keywords: ["re"] }],
      ctx,
    });
    expect(rows[0]?.command.id).toBe("panel.reload");
  });

  it("hides commands whose availability predicate says so", () => {
    expect(ids(buildCommandSuggestions({ query: "panel", commands: slate, ctx }))).not.toContain(
      "panel.unpin"
    );
    expect(
      ids(buildCommandSuggestions({ query: "panel", commands: slate, ctx: focusedCtx }))
    ).toContain("panel.unpin");
  });

  it("lists an unavailable-but-not-hidden command as disabled, below its peers", () => {
    const rows = buildCommandSuggestions({ query: "", commands: [back, reload], ctx });
    expect(rows.map((row) => [row.command.id, row.disabled === true])).toEqual([
      ["panel.reload", false],
      ["nav.back", true],
    ]);
  });

  it("hides commands that do not declare the active surface", () => {
    const mobile: SurfaceContext = { ...ctx, platform: "mobile" };
    const rows = ids(buildCommandSuggestions({ query: "", commands: slate, ctx: mobile }));
    expect(rows).toEqual(["view.theme"]);
  });

  it("ranks the idle slate by usage", () => {
    const rows = buildCommandSuggestions({
      query: "",
      commands: [move, theme, reload],
      ctx,
      usage: {
        "panel.reload": { count: 12, lastUsed: 5 },
        "view.theme": { count: 1, lastUsed: 99 },
      },
    });
    expect(ids(rows)).toEqual(["panel.reload", "view.theme", "panel.move"]);
  });

  it("honors the limit", () => {
    expect(buildCommandSuggestions({ query: "", commands: slate, ctx, limit: 2 })).toHaveLength(2);
  });
});

describe("buildArgSuggestions", () => {
  it("offers static enum options and filters them by query", () => {
    const all = buildArgSuggestions(move.args![0]!, "", ctx);
    expect(all.map((row) => row.option.value)).toEqual(["left", "right", "up", "down"]);
    const filtered = buildArgSuggestions(move.args![0]!, "ri", ctx);
    expect(filtered.map((row) => row.option.value)).toEqual(["right"]);
  });

  it("delegates to a dynamic suggester and keeps its order when nothing is typed", () => {
    const rows = buildArgSuggestions(focusPanel.args![0]!, "", focusedCtx);
    expect(rows.map((row) => row.option.label)).toEqual(["Sales Dashboard", "Import wizard"]);
  });

  it("gives every option a stable row id", () => {
    const [row] = buildArgSuggestions(move.args![0]!, "up", ctx);
    expect(row?.id).toBe("option:direction:up");
  });
});

describe("parseInlineCommand", () => {
  it("parses `move right` into a complete utterance", () => {
    const parse = parseInlineCommand("move right", slate, ctx);
    expect(parse?.command.id).toBe("panel.move");
    expect(parse?.filled).toEqual({ direction: "right" });
    expect(parse?.residual).toBe("");
    expect(parse?.complete).toBe(true);
  });

  it("parses `theme dark`", () => {
    expect(parseInlineCommand("theme dark", slate, ctx)?.filled).toEqual({ mode: "dark" });
  });

  it("accepts an option label as well as its value", () => {
    expect(parseInlineCommand("move Right", slate, ctx)?.filled).toEqual({ direction: "right" });
  });

  it("accepts a prefix of an option", () => {
    expect(parseInlineCommand("theme da", slate, ctx)?.filled).toEqual({ mode: "dark" });
  });

  it("addresses a command by its id tail", () => {
    const openUrl: CommandSpec = {
      id: "nav.open-url",
      title: "Open URL",
      section: "Navigate",
      surfaces: ["desktop"],
      args: [{ name: "url", label: "address", type: "url", required: true }],
    };
    const parse = parseInlineCommand("open-url example.com", [openUrl], ctx);
    expect(parse?.filled).toEqual({ url: "example.com" });
    expect(parse?.complete).toBe(true);
  });

  it("lets the final free-text argument absorb the whole remainder", () => {
    const ask: CommandSpec = {
      id: "quickfire.ask",
      title: "Ask About This Panel",
      aliases: ["ask"],
      section: "Quickfire",
      surfaces: ["desktop"],
      args: [{ name: "prompt", label: "prompt", type: "string", required: false }],
    };
    expect(parseInlineCommand("ask why is this slow", [ask], ctx)?.filled).toEqual({
      prompt: "why is this slow",
    });
  });

  it("returns an incomplete parse with the residual when the tail does not match", () => {
    const parse = parseInlineCommand("move sideways", slate, ctx);
    expect(parse?.command.id).toBe("panel.move");
    expect(parse?.filled).toEqual({});
    expect(parse?.residual).toBe("sideways");
    expect(parse?.complete).toBe(false);
  });

  it("does not fire on a bare command name", () => {
    expect(parseInlineCommand("move", slate, ctx)).toBeNull();
  });

  it("refuses a partial word as a command head", () => {
    expect(parseInlineCommand("mo right", slate, ctx)).toBeNull();
  });

  it("accepts a whole leading word as a head", () => {
    expect(parseInlineCommand("move right", slate, ctx)?.head).toBe("move");
  });

  it("ignores commands that take no arguments", () => {
    expect(parseInlineCommand("reload panel now", [reload], ctx)).toBeNull();
  });

  it("ignores hidden commands", () => {
    expect(parseInlineCommand("unpin panel", slate, ctx)).toBeNull();
  });

  it("declines an ambiguous head", () => {
    const other: CommandSpec = { ...move, id: "layout.move", title: "Move Column" };
    expect(parseInlineCommand("move right", [move, other], ctx)).toBeNull();
  });

  it("resolves a dynamic panel argument inline", () => {
    const parse = parseInlineCommand("go to Sales", [focusPanel], focusedCtx);
    expect(parse?.filled).toEqual({ panel: "panel:tree/a" });
  });
});

describe("groupOmniboxSuggestions", () => {
  it("buckets by kind in best-rank order and labels each group", () => {
    const rows = [
      { id: "command:a", kind: "command" as const },
      { id: "panel:p", kind: "panel" as const },
      { id: "command:b", kind: "command" as const },
    ];
    const groups = groupOmniboxSuggestions(rows);
    expect(groups.map((group) => [group.kind, group.label, group.items.length])).toEqual([
      ["command", "Commands", 2],
      ["panel", "Panels", 1],
    ]);
  });

  it("honors an explicit idle order", () => {
    const rows = [
      { id: "history:h", kind: "history" as const },
      { id: "command:a", kind: "command" as const },
    ];
    expect(
      groupOmniboxSuggestions(rows, ["command", "panel", "history", "url", "chat", "option"]).map(
        (group) => group.kind
      )
    ).toEqual(["command", "history"]);
  });

  it("keeps grouped order identical to keyboard order", () => {
    const rows = [
      { id: "command:a", kind: "command" as const },
      { id: "panel:p", kind: "panel" as const },
      { id: "command:b", kind: "command" as const },
    ];
    expect(groupOmniboxSuggestions(rows).flatMap((group) => group.items.map((i) => i.id))).toEqual([
      "command:a",
      "command:b",
      "panel:p",
    ]);
  });
});

describe("wire commands", () => {
  const wire: WireCommandSpec = {
    id: "new",
    label: "New conversation",
    description: "Start a fresh thread",
    group: "Chat",
    args: [
      { name: "title", label: "title", type: "string", required: true, pattern: "^[A-Za-z ]+$" },
      {
        name: "model",
        label: "model",
        type: "enum",
        required: false,
        options: [
          { value: "fast", label: "Fast" },
          { value: "deep", label: "Deep" },
        ],
      },
    ],
    requiresFocus: true,
    danger: true,
  };

  it("lifts a contribution into a namespaced chrome-local spec", () => {
    const spec = commandSpecFromWire(wire, { panelId: "panel:tree/chat" });
    expect(spec.id).toBe("panel:tree/chat:new");
    expect(spec.title).toBe("New conversation");
    expect(spec.section).toBe("Chat");
    expect(spec.danger).toBe(true);
    expect(spec.panelId).toBe("panel:tree/chat");
    expect(spec.args?.map((arg) => arg.name)).toEqual(["title", "model"]);
  });

  it("turns `pattern` into a validator", () => {
    const spec = commandSpecFromWire(wire, { panelId: "panel:tree/chat" });
    expect(spec.args?.[0]?.validate?.("Notes")).toBeNull();
    expect(spec.args?.[0]?.validate?.("N0tes")).toContain("expected format");
  });

  it("turns `requiresFocus` into the only availability a wire spec can express", () => {
    const spec = commandSpecFromWire(wire, { panelId: "panel:tree/a" });
    expect(spec.availability?.(ctx)).toBe("hidden");
    expect(spec.availability?.(focusedCtx)).toBe(true);
  });

  it("wraps a legacy `{id, label}` contribution as an arg-less spec", () => {
    const spec = commandSpecFromWire(
      { id: "clear", label: "Clear" },
      { panelId: "panel:tree/chat", panelTitle: "Chat" }
    );
    expect(spec.args).toBeUndefined();
    expect(spec.availability).toBeUndefined();
    expect(spec.section).toBe("Chat");
  });

  it("ranks and runs contributed commands through the same engine", () => {
    const spec = commandSpecFromWire({ id: "clear", label: "Clear transcript" }, {
      panelId: "panel:tree/chat",
    });
    const rows = buildCommandSuggestions({ query: "clear", commands: [...slate, spec], ctx });
    expect(rows[0]?.command.id).toBe("panel:tree/chat:clear");
  });
});
