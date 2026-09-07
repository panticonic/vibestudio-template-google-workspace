import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const prose = (text: string) => text.replace(/\s+/gu, " ");

describe("capabilities skill", () => {
  it("routes dynamic services through live declarations and docs", () => {
    const markdown = prose(read("./SKILL.md"));

    expect(markdown).toContain('`workspace_service`');
    expect(markdown).toContain('`operation: "upsert"`');
    expect(markdown).toContain("`docs_search`");
    expect(markdown).toContain("`docs_open`");
    expect(markdown).toContain('workers.resolveService("example.protocol")');
    expect(markdown).toContain("not eval globals or runtime exports");
    expect(markdown).toContain("not a startup scan or static");
    expect(markdown).toMatch(/(?:Never|Do not) source-scan another unit/u);
  });

  it("keeps installed requests separate from grants and runtime calls", () => {
    const markdown = prose(read("./SKILL.md"));

    expect(markdown).toContain("A request is not a grant");
    expect(markdown).toContain("`workspace-service:<name>`");
    expect(markdown).toContain("`package.json#vibestudio.authority.requests`");
    expect(markdown).toContain("exact `ctx:<contextId>` working state");
    expect(markdown).toContain("build seals and checks the manifest");
    expect(markdown).toContain("Version-bound grants follow the exact execution digest");
  });

  it("delegates host, mission, seed, and System Agent detail to the checklist", () => {
    const markdown = read("./SKILL.md");
    const checklist = prose(read("./references/authority-implementation-checklist.md"));

    expect(markdown).toContain("references/authority-implementation-checklist.md");
    expect(checklist).toContain("One version decision covers code plus its full authority contract");
    expect(checklist).toContain("one progressive-disclosure startup decision");
    expect(checklist).toContain("mission:<id>@<revisionDigest>");
    expect(checklist).toContain("immutable product snapshot outputs");
    expect(checklist).toContain("exactly `eval` and `notify` as model-facing tools");
    expect(checklist).toContain("no non-delegated approval payload or settlement");
    expect(checklist).toContain("hostAuthorityCatalog.generated.ts");
    expect(checklist).toContain("runtime-authority-review.json");
    expect(checklist).toContain("Regenerating derived ledgers is not approval");
  });
});
