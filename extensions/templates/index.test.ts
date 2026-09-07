import { describe, expect, it } from "vitest";
import { retainedInspectionPin } from "./inspectionPin.js";

describe("exact template reinspection", () => {
  it("keeps a reviewed pin when its moving ref may have advanced", async () => {
    const pin = {
      url: "https://example.test/app.git",
      ref: "refs/heads/main",
      commit: "a".repeat(40),
      snapshot: `v1-sha256:${"b".repeat(64)}`,
    };
    expect(retainedInspectionPin({ pin })).toEqual(pin);
  });
});
