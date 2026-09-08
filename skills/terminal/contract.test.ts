import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("terminal skill contract", () => {
  it("routes programmatic scratch filesystem work through scoped runtime fs", async () => {
    const skill = await readFile(new URL("./SKILL.md", import.meta.url), "utf8");

    expect(skill).toMatch(/actual operating-system process or\s+command behavior/u);
    expect(skill).toMatch(/programmatic workspace or scratch filesystem work/u);
    expect(skill).toContain("`@workspace/runtime` filesystem API");
  });
});
