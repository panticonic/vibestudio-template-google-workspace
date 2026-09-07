import { describe, expect, it } from "vitest";
import { documentTitleForPanel } from "./documentTitle.js";

describe("documentTitleForPanel", () => {
  it("uses the stable panel title instead of session implementation details", () => {
    expect(documentTitleForPanel("Development terminal")).toBe("Development terminal");
  });

  it("defaults empty titles to Terminal", () => {
    expect(documentTitleForPanel(undefined)).toBe("Terminal");
    expect(documentTitleForPanel("   ")).toBe("Terminal");
  });

  it("normalizes whitespace and bounds titles", () => {
    expect(documentTitleForPanel("  Build   terminal  ")).toBe("Build terminal");
    expect(documentTitleForPanel("x".repeat(100))).toHaveLength(80);
  });
});
