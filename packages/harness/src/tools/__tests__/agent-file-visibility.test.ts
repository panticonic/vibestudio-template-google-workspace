import { describe, expect, it, vi } from "vitest";
import { createAgentFileVisibility } from "../agent-file-visibility.js";
import { createFindTool } from "../find.js";
import { createGrepTool } from "../grep.js";
import { createLsTool } from "../ls.js";
import { createReadTool } from "../read.js";
import { StubFs } from "./stub-fs.js";

const files = {
  "/skills/public/SKILL.md": "---\nname: public\n---\n# Public\n",
  "/skills/public/index.ts": 'export const visible = "needle";\n',
  "/skills/internal/SKILL.md": "---\nname: internal\nagentVisible: false\n---\n# Internal\n",
  "/skills/internal/fixture.ts": 'export const secret = "needle";\n',
};

describe("agent file visibility", () => {
  it("uses agentVisible false as one catalog and filesystem boundary", async () => {
    const fs = new StubFs({ files });
    const visibility = createAgentFileVisibility("/", fs);

    await expect(visibility.isHidden("/skills/internal/fixture.ts")).resolves.toBe(true);
    await expect(visibility.isHidden("/skills/public/index.ts")).resolves.toBe(false);

    const listed = await createLsTool("/", fs, visibility).execute("ls", { path: "skills" });
    expect(listed.content[0]).toMatchObject({ text: "public/" });

    const read = await createReadTool("/", fs, { visibility }).execute("read", {
      path: "skills/internal/fixture.ts",
    });
    expect(read).toMatchObject({ details: { missing: true } });

    const grep = await createGrepTool("/", fs, { visibility }).execute("grep", {
      pattern: "needle",
      path: "skills",
      includeIgnored: true,
    });
    expect(grep.content[0]).toMatchObject({ text: expect.stringContaining("public/index.ts") });
    expect(grep.content[0]).not.toMatchObject({ text: expect.stringContaining("internal") });

    const found = await createFindTool("/", fs, { visibility }).execute("find", {
      pattern: "**/*.ts",
      path: "skills",
      includeIgnored: true,
    });
    expect(found.content[0]).toMatchObject({ text: "public/index.ts" });
  });

  it("decodes visibility frontmatter without a Node Buffer global", async () => {
    const originalBuffer = globalThis.Buffer;
    vi.stubGlobal("Buffer", undefined);
    try {
      const fs = new StubFs({
        files: {
          "/skills/internal/SKILL.md": new TextEncoder().encode(
            "---\nname: internal\nagentVisible: false\n---\n# Internal\n"
          ),
        },
      });
      const visibility = createAgentFileVisibility("/", fs);

      await expect(visibility.isHidden("/skills/internal/SKILL.md")).resolves.toBe(true);
    } finally {
      vi.stubGlobal("Buffer", originalBuffer);
    }
  });

  it("filters hidden skill results returned by the host search service", async () => {
    const fs = new StubFs({ files });
    const visibility = createAgentFileVisibility("/", fs);
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "fs.grep") {
        return {
          matches: [
            {
              file: "internal/fixture.ts",
              lineNumber: 1,
              line: "needle",
              before: [],
              after: [],
            },
            {
              file: "public/index.ts",
              lineNumber: 1,
              line: "needle",
              before: [],
              after: [],
            },
          ],
          matchCount: 2,
          truncated: false,
        };
      }
      return {
        files: ["/skills/internal/fixture.ts", "/skills/public/index.ts"],
        truncated: false,
      };
    });

    const grep = await createGrepTool("/", fs, { rpc: { call } as never, visibility }).execute(
      "grep",
      { pattern: "needle", path: "skills", includeIgnored: true }
    );
    expect(grep.content[0]).toMatchObject({ text: "public/index.ts:1: needle" });

    const found = await createFindTool("/", fs, {
      rpc: { call } as never,
      visibility,
    }).execute("find", { pattern: "**/*.ts", path: "skills", includeIgnored: true });
    expect(found.content[0]).toMatchObject({ text: "public/index.ts" });
  });
});
