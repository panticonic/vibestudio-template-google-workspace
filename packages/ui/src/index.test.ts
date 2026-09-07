import { describe, expect, it } from "vitest";

describe("@workspace/ui root import", () => {
  it("stays lightweight and does not require panel runtime globals", async () => {
    const root = await import("@workspace/ui");
    expect(root).toHaveProperty("APP_THEME");
    expect(root).toHaveProperty("VibestudioLogo");
    expect(root).not.toHaveProperty("DiffViewer");
  });
});
