import { describe, expect, it } from "vitest";
import { headerBorderColor, paneAttentionShadow, paneBorderColor, severityDotColor } from "./paneChrome.js";

describe("pane chrome", () => {
  it("uses attention colors before focus colors", () => {
    expect(paneBorderColor("failure", true)).toBe("var(--red-8)");
    expect(paneBorderColor("approval", true)).toBe("var(--amber-8)");
    expect(paneBorderColor("waiting", false)).toBe("var(--blue-8)");
    expect(paneBorderColor("info", true)).toBe("var(--accent-8)");
    expect(paneBorderColor("info", false)).toBe("var(--gray-5)");
  });

  it("shows soft attention rings for blocked states", () => {
    expect(paneAttentionShadow("failure")).toContain("var(--red-8)");
    expect(paneAttentionShadow("approval")).toContain("var(--amber-8)");
    expect(paneAttentionShadow("waiting")).toContain("var(--blue-8)");
    expect(paneAttentionShadow("info")).toBeUndefined();
  });

  it("applies the same attention scale to header borders and status dots", () => {
    expect(headerBorderColor("approval", false)).toBe("var(--amber-8)");
    expect(headerBorderColor("info", true)).toBe("var(--accent-7)");
    expect(severityDotColor("done", true)).toBe("var(--green-9)");
    expect(severityDotColor("info", false)).toBe("var(--gray-9)");
    expect(severityDotColor("failure", false)).toBe("var(--red-9)");
  });
});
