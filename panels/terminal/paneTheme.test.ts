import { describe, expect, it } from "vitest";
import { resolveTerminalTheme } from "./paneTheme.js";

describe("pane theme", () => {
  it("uses an appearance-aware fallback when CSS variables are unavailable", () => {
    expect(resolveTerminalTheme("light").background).toBe("#fcfcfd");
    expect(resolveTerminalTheme("light").foreground).toBe("#1c2024");
    expect(resolveTerminalTheme("dark").background).toBe("#111113");
    expect(resolveTerminalTheme("dark").foreground).toBe("#eeeeee");
  });
});
