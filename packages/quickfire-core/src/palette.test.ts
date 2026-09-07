import { describe, expect, it } from "vitest";
import { startArgSession, type ArgSession, type CommandSpec, type SurfaceContext } from "@workspace/omnibox-core";
import {
  HISTORY_SCOPE_TOKEN,
  buildPaletteRows,
  buildRowTargets,
  completionForRow,
  emptyMessageFor,
  inputForMode,
  modeForInput,
  parseGotoScope,
  stripModePrefix,
} from "./palette";
import type { BrowserAddressSuggestion } from "@vibestudio/shared/panelChrome";

const history: BrowserAddressSuggestion[] = [
  {
    url: "https://example.com/docs",
    title: "Example Docs",
    visitCount: 20,
    typedCount: 4,
    lastVisit: 200,
    source: "history",
  },
  {
    url: "https://example.com/changelog",
    title: "Example Changelog",
    visitCount: 1,
    lastVisit: 10,
    source: "history",
  },
  { url: "https://unrelated.test/", title: "Unrelated", source: "bookmark" },
];

const commands: CommandSpec[] = [
  {
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
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ],
      },
    ],
  },
  {
    id: "debug.devtools",
    title: "Open Panel DevTools",
    section: "Debug",
    surfaces: ["desktop"],
  },
];

const ctx: SurfaceContext = {
  platform: "mobile",
  openPanels: {
    entries: [{ id: "panel:tree/root/0", title: "Import wizard", source: "panels/import" }],
  },
};

describe("palette projection", () => {
  it("maps prefixes to modes and back without losing the query", () => {
    expect(modeForInput(">move", "all")).toBe("commands");
    expect(modeForInput("@sales", "all")).toBe("goto");
    expect(modeForInput("/why", "all")).toBe("quickfire");
    expect(stripModePrefix("> theme", "commands")).toBe("theme");
    expect(inputForMode("> theme", "commands", "goto")).toBe("@theme");
  });

  it("offers commands and open panels in mixed mode, honouring the surface", () => {
    const groups = buildPaletteRows({ mode: "all", argSession: null, query: "", ctx, commands });
    const ids = groups.flatMap((group) => group.rows.map((row) => row.id));
    expect(ids).toContain("command:view.theme");
    // Desktop-only on a mobile context.
    expect(ids).not.toContain("command:debug.devtools");
    expect(ids).toContain("panel:panel:tree/root/0");
  });

  it("leads the mixed scope with the ask row for typed prose", () => {
    const asking: SurfaceContext = {
      ...ctx,
      focusedPanel: { panelId: "panel:tree/root/0", title: "Keyboard Shortcuts" },
    };
    const groups = buildPaletteRows({
      mode: "all",
      argSession: null,
      query: "why aren't keyboard combos editable?",
      ctx: asking,
      commands,
    });
    const first = groups[0]!.rows[0]!;
    expect(first.id).toBe("ask:why aren't keyboard combos editable?");
    expect(first.title).toBe("Ask about “Keyboard Shortcuts”");
    expect(buildRowTargets(groups, commands, { argSession: null }).get(first.id)).toEqual({
      kind: "quickfire-ask",
      prompt: "why aren't keyboard combos editable?",
    });
  });

  it("falls back to asking when nothing else matches, so Enter always has a target", () => {
    const groups = buildPaletteRows({
      mode: "all",
      argSession: null,
      query: "zzzz",
      ctx,
      commands,
    });
    expect(groups.flatMap((group) => group.rows.map((row) => row.id))).toEqual(["ask:zzzz"]);
  });

  it("leads with the panel when the query names one, so Enter switches to it", () => {
    const groups = buildPaletteRows({
      mode: "all",
      argSession: null,
      query: "Import wiz",
      ctx,
      commands,
    });
    const first = groups[0]!.rows[0]!;
    expect(first.id).toBe("panel:panel:tree/root/0");
    expect(completionForRow(first)).toBe("Import wizard");
    expect(buildRowTargets(groups, commands, { argSession: null }).get(first.id)).toEqual({
      kind: "panel",
      panelId: "panel:tree/root/0",
    });
  });

  it("keeps a matching command ahead of the ask row", () => {
    const groups = buildPaletteRows({ mode: "all", argSession: null, query: "theme", ctx, commands });
    expect(groups[0]!.rows[0]!.id).toBe("command:view.theme");
  });

  it("shows only the active argument's options once a session is open", () => {
    const outcome = startArgSession(commands[0]!, { restoreQuery: ">theme" });
    expect(outcome.kind).toBe("session");
    const session = (outcome as { session: ArgSession }).session;
    const groups = buildPaletteRows({
      mode: "commands",
      argSession: session,
      query: "",
      ctx,
      commands,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows.map((row) => row.id)).toEqual([
      "option:mode:light",
      "option:mode:dark",
    ]);
    const targets = buildRowTargets(groups, commands, { argSession: session });
    expect(targets.get("option:mode:dark")).toEqual({ kind: "option", value: "dark" });
  });

  it("resolves a URL row without a command behind it", () => {
    const groups = buildPaletteRows({
      mode: "goto",
      argSession: null,
      query: "example.com",
      ctx,
      commands,
    });
    const targets = buildRowTargets(groups, commands, { argSession: null });
    expect(targets.get("url:https://example.com/")).toEqual({
      kind: "url",
      url: "https://example.com/",
    });
  });

  it("ranks recent pages into the go-to scope and opens them like any URL", () => {
    const groups = buildPaletteRows({
      mode: "goto",
      argSession: null,
      query: "example",
      ctx,
      commands,
      history,
    });
    const recent = groups.find((group) => group.key === "history");
    expect(recent?.label).toBe("Recent pages");
    // Frequency only breaks ties inside a match tier, so the often-visited
    // page leads its equally-matching sibling.
    expect(recent?.rows.map((row) => row.id)).toEqual([
      "history:https://example.com/docs",
      "history:https://example.com/changelog",
    ]);
    expect(recent?.rows[0]?.title).toBe("Example Docs");
    const targets = buildRowTargets(groups, commands, { argSession: null });
    expect(targets.get("history:https://example.com/docs")).toEqual({
      kind: "url",
      url: "https://example.com/docs",
    });
  });

  it("keeps history out of the commands scope and a typed URL out of history", () => {
    const commandsOnly = buildPaletteRows({
      mode: "commands",
      argSession: null,
      query: "example",
      ctx,
      commands,
      history,
    });
    expect(commandsOnly.some((group) => group.key === "history")).toBe(false);

    // A page typed in full is one destination, not a literal row plus a
    // duplicate history row.
    const typed = buildPaletteRows({
      mode: "goto",
      argSession: null,
      query: "https://example.com/docs",
      ctx,
      commands,
      history,
    });
    const ids = typed.flatMap((group) => group.rows.map((row) => row.id));
    expect(ids).toContain("url:https://example.com/docs");
    expect(ids).not.toContain("history:https://example.com/docs");
  });

  it("narrows the go-to scope to recent pages behind the history sub-scope token", () => {
    expect(parseGotoScope(`${HISTORY_SCOPE_TOKEN} docs`)).toEqual({
      historyOnly: true,
      query: "docs",
    });
    expect(parseGotoScope("docs")).toEqual({ historyOnly: false, query: "docs" });

    const groups = buildPaletteRows({
      mode: "goto",
      argSession: null,
      query: `${HISTORY_SCOPE_TOKEN} example`,
      ctx,
      commands,
      history,
    });
    expect(groups.map((group) => group.key)).toEqual(["history"]);
    expect(groups[0]!.rows.map((row) => row.id)).toEqual([
      "history:https://example.com/docs",
      "history:https://example.com/changelog",
    ]);
  });

  it("stays silent on an empty query and explains an empty result", () => {
    expect(emptyMessageFor({ argSession: null, query: "   " })).toBeNull();
    expect(emptyMessageFor({ argSession: null, query: "zzz" })).toContain("zzz");
  });
});
