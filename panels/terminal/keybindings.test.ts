import { describe, expect, it } from "vitest";
import {
  buildResolvedKeymap,
  displayChord,
  eventToChord,
  isPlainEscapeEvent,
  sanitizeKeybindingOverrides,
  validateKeybindingOverrides,
} from "./keybindings.js";

describe("terminal keybindings", () => {
  it("resolves Mod to Ctrl+Shift outside macOS", () => {
    expect(buildResolvedKeymap({}, "Linux")["Ctrl+Shift+K"]).toBe("palette");
    expect(buildResolvedKeymap({}, "Linux")["Ctrl+Alt+T"]).toBe("newPane");
  });

  it("keeps shifted Mod defaults collision-free on every platform", () => {
    for (const platform of ["Linux", "Win32", "MacIntel"]) {
      const resolved = buildResolvedKeymap({}, platform);
      expect(Object.values(resolved)).toContain("splitRight");
      expect(Object.values(resolved)).toContain("splitDown");
      expect(Object.values(resolved)).toContain("findNext");
      expect(Object.values(resolved)).toContain("findPrev");
    }
    expect(buildResolvedKeymap({}, "Linux")["Ctrl+Shift+D"]).toBe("splitRight");
    expect(buildResolvedKeymap({}, "Linux")["Ctrl+Alt+D"]).toBe("splitDown");
  });

  it("formats stored Mod chords as physical platform keys", () => {
    expect(displayChord("Mod+K", "Linux")).toEqual(["Ctrl", "Shift", "K"]);
    expect(displayChord("Mod+Shift+D", "Linux")).toEqual(["Ctrl", "Alt", "D"]);
    expect(displayChord("Mod+K", "MacIntel")).toEqual(["⌘", "K"]);
  });

  it("resolves Mod to Meta on macOS", () => {
    expect(buildResolvedKeymap({}, "MacIntel")["Meta+K"]).toBe("palette");
  });

  it("can resolve bindings without an explicit browser platform", () => {
    expect(() => buildResolvedKeymap({})).not.toThrow();
  });

  it("keeps Shift in Ctrl+Shift letter events so Linux Mod shortcuts work", () => {
    expect(
      eventToChord({
        key: "K",
        ctrlKey: true,
        shiftKey: true,
        metaKey: false,
        altKey: false,
      } as KeyboardEvent)
    ).toBe("Ctrl+Shift+K");
  });

  it("normalizes shifted equals to the configured font-up chord", () => {
    expect(
      eventToChord({
        key: "+",
        ctrlKey: true,
        shiftKey: true,
        metaKey: false,
        altKey: false,
      } as KeyboardEvent)
    ).toBe("Ctrl+Shift+=");
  });

  it("rejects plain Ctrl letter overrides", () => {
    const issues = validateKeybindingOverrides({ palette: "Ctrl+K" }, "Linux");
    expect(issues).toContainEqual(
      expect.objectContaining({
        action: "palette",
        message: expect.stringContaining("Plain Ctrl+letter"),
      })
    );
    expect(sanitizeKeybindingOverrides({ palette: "Ctrl+K" }, "Linux")).toEqual({});
  });

  it("reports conflicts and drops conflicting overrides", () => {
    const issues = validateKeybindingOverrides({ palette: "Mod+Shift+T" }, "Linux");
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "palette",
          message: expect.stringContaining("Conflicts"),
        }),
        expect.objectContaining({
          action: "newPane",
          message: expect.stringContaining("Conflicts"),
        }),
      ])
    );
    expect(sanitizeKeybindingOverrides({ palette: "Mod+Shift+T" }, "Linux")).toEqual({});
  });

  it("recognizes only unmodified Escape as a plain escape event", () => {
    expect(
      isPlainEscapeEvent({
        key: "Escape",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      } as KeyboardEvent)
    ).toBe(true);
    expect(
      isPlainEscapeEvent({
        key: "Escape",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      } as KeyboardEvent)
    ).toBe(false);
    expect(
      isPlainEscapeEvent({
        key: "Esc",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      } as KeyboardEvent)
    ).toBe(false);
  });
});
