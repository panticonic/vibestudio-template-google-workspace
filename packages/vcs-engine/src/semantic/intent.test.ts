import { describe, expect, it } from "vitest";
import { resolveIntent } from "./intent.js";

describe("resolveIntent", () => {
  it("uses the exact stated, trigger, mechanical ladder", () => {
    const all = {
      stated: "Remove the cache because it masks the race",
      externalDescription: "Upgrade the imported template",
      trigger: { sender: "user:1", text: "Fix the loader" },
      mechanical: "edit src/loader.ts content",
    };
    expect(resolveIntent(all)).toEqual({ text: all.stated, tier: "stated" });
    expect(resolveIntent({ ...all, stated: null })).toEqual({
      text: all.externalDescription,
      tier: "stated",
    });
    expect(resolveIntent({ ...all, stated: null, externalDescription: null })).toEqual({
      text: "asked by user:1: Fix the loader",
      tier: "trigger",
    });
    expect(
      resolveIntent({ ...all, stated: null, externalDescription: null, trigger: null })
    ).toEqual({ text: "edit src/loader.ts content", tier: "mechanical" });
  });

  it("does not fabricate a statement when only mechanics exist", () => {
    const resolved = resolveIntent({ mechanical: "move file:1 to src/new.ts" });
    expect(resolved).toEqual({ text: "move file:1 to src/new.ts", tier: "mechanical" });
    expect(() => resolveIntent({ mechanical: "   " })).toThrow(
      "canonical mechanical description"
    );
  });

  it("bounds the complete rendered trigger evidence", () => {
    const resolved = resolveIntent({
      trigger: { sender: "s".repeat(1_000), text: "t".repeat(5_000) },
      mechanical: "fallback",
    });
    expect(resolved.tier).toBe("trigger");
    expect(resolved.text.length).toBe(1_200);
    expect(resolved.text).toMatch(/^asked by s+…: t+/);
  });
});
