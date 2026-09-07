import { describe, expect, it } from "vitest";
import { commandAvailability, type SurfaceContext } from "@workspace/omnibox-core";
import { buildSlateDefinitions } from "./slateDefinitions";

const definitions = buildSlateDefinitions({ workspaceNames: () => ["alpha", "beta"] });

function contextFor(platform: SurfaceContext["platform"]): SurfaceContext {
  return {
    platform,
    openPanels: { entries: [] },
    focusedPanel: { panelId: "panel:tree/root/0", title: "Sales", addressable: true },
  };
}

describe("built-in slate definitions", () => {
  it("declares every command exactly once", () => {
    const ids = definitions.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the surfaces a phone cannot honour off the mobile slate", () => {
    const mobileIds = definitions
      .filter((command) => command.surfaces.includes("mobile"))
      .map((command) => command.id);
    // Spec §3.2 excludes shell devtools, the worker inspector, zoom and the
    // address bar; this workspace additionally has no mobile accent system and
    // no command-driven mobile update check (see the comments on those two).
    expect(mobileIds).not.toContain("debug.shell-devtools");
    expect(mobileIds).not.toContain("debug.devtools");
    expect(mobileIds).not.toContain("nav.address");
    expect(mobileIds).not.toContain("view.accent");
    expect(mobileIds).not.toContain("app.check-updates");
    expect(mobileIds).not.toContain("app.reload-shell");
    expect(mobileIds).not.toContain("authority.focus-approval");
    // …while the panel, navigation and quickfire slate all ship on both.
    expect(mobileIds).toEqual(
      expect.arrayContaining([
        "panel.new",
        "panel.close",
        "panel.focus",
        "panel.reload",
        "nav.back",
        "nav.open-url",
        "quickfire.ask",
        "quickfire.clear",
        "quickfire.promote",
        "view.theme",
        "workspace.permissions",
      ])
    );
  });

  it("hides desktop-only commands from a mobile surface context", () => {
    const accent = definitions.find((command) => command.id === "view.accent")!;
    expect(commandAvailability(accent, contextFor("mobile"))).toBe("hidden");
    expect(commandAvailability(accent, contextFor("desktop"))).toBe(true);
  });

  it("ranks the workspace picker off the injected name list", () => {
    const command = definitions.find((entry) => entry.id === "workspace.switch")!;
    const arg = command.args?.[0];
    expect(arg?.name).toBe("workspace");
    expect(arg?.required).toBe(false);
    expect(arg?.suggest?.("al", contextFor("desktop"))).toEqual([
      { value: "alpha", label: "alpha" },
    ]);
  });

  it("makes history search a scope switch rather than a navigation", () => {
    const command = definitions.find((entry) => entry.id === "nav.history")!;
    expect(command.section).toBe("Navigate");
    expect(command.surfaces).toEqual(["desktop", "mobile"]);
    // No argument session in front of the scope's own search box.
    expect(command.args).toBeUndefined();
  });

  it("validates a URL argument through the launcher's own parser", () => {
    const command = definitions.find((entry) => entry.id === "nav.open-url")!;
    const arg = command.args?.[0];
    expect(arg?.validate?.("example.com")).toBeNull();
    expect(arg?.validate?.("not a url at all")).toMatch(/web address/u);
  });

  it("keeps availability predicates pure over the injected context", () => {
    const pin = definitions.find((entry) => entry.id === "panel.pin")!;
    const unpin = definitions.find((entry) => entry.id === "panel.unpin")!;
    const pinned: SurfaceContext = {
      ...contextFor("mobile"),
      focusedPanel: { panelId: "p", title: "Pinned", pinned: true },
    };
    expect(commandAvailability(pin, pinned)).toBe("hidden");
    expect(commandAvailability(unpin, pinned)).toBe(true);
    expect(commandAvailability(unpin, contextFor("mobile"))).toBe("hidden");
  });
});
