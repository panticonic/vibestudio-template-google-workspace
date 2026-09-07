import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createApplyPatchTool } from "../apply-patch.js";
import { createMemoryWorkspaceFileObservationStore } from "../file-observations.js";
import { StubVcs } from "./stub-vcs.js";

const authority = { contextId: "context:test", commandId: "command:patch" };

describe("apply_patch", () => {
  it("advertises the complete managed repository path boundary", () => {
    const tool = createApplyPatchTool("/", new StubVcs(), authority);

    expect(tool.description).toContain("top-level section and repository name");
    expect(tool.description).toContain("projects/app/README.md");
    expect(tool.description).toContain("workspace-root files");
    expect(tool.description).toContain("one normalized occurrence");
    expect(tool.description).toContain("structured conflict");
    expect(tool.description).toContain("protected against stale mutations automatically");
    expect(JSON.stringify(tool.parameters)).not.toContain("receipt");
    expect(JSON.stringify(tool.parameters)).not.toContain("contentHash");
  });

  it("applies a multi-file content, presence, and mode transaction", async () => {
    const vcs = new StubVcs({
      files: {
        "meta/a.ts": "const a = 1;\nconst b = 2;\n",
        "meta/delete.ts": "obsolete\n",
        "meta/script.sh": "#!/bin/sh\n",
      },
    });
    const tool = createApplyPatchTool("/", vcs, authority);
    const result = await tool.execute("invocation:patch", {
      operations: [
        {
          kind: "replace",
          path: "meta/a.ts",
          mode: 0o600,
          replacements: [
            { oldText: "a = 1", newText: "a = 10" },
            { oldText: "b = 2", newText: "b = 20" },
          ],
        },
        { kind: "write", path: "meta/new.ts", content: "export {};\n" },
        { kind: "delete", path: "meta/delete.ts" },
        { kind: "chmod", path: "meta/script.sh", mode: 0o755 },
      ],
      intent: "Update the complete fixture atomically",
    } as never);

    expect(result.details).toMatchObject({
      status: "applied",
      intent: "Update the complete fixture atomically",
      operations: [
        { path: "meta/a.ts", status: "changed" },
        { path: "meta/new.ts", status: "created" },
        { path: "meta/delete.ts", status: "deleted" },
        { path: "meta/script.sh", status: "changed" },
      ],
    });
    expect(vcs.read("meta/a.ts")).toBe("const a = 10;\nconst b = 20;\n");
    expect(vcs.modes.get("meta/a.ts")).toBe(0o600);
    expect(vcs.read("meta/new.ts")).toBe("export {};\n");
    expect(vcs.read("meta/delete.ts")).toBeUndefined();
    expect(vcs.modes.get("meta/script.sh")).toBe(0o755);
    expect(vcs.lastEditInput).toMatchObject({
      commandId: "command:patch",
      intentSummary: "Update the complete fixture atomically",
      changes: [
        { kind: "text-edit", mode: 0o600 },
        { kind: "file-create", mode: 0o644 },
        { kind: "file-delete" },
        { kind: "file-mode", mode: 0o755 },
      ],
    });
  });

  it("writes arbitrary binary bytes without UTF-8 conversion", async () => {
    const vcs = new StubVcs();
    const tool = createApplyPatchTool("/", vcs, authority);
    const base64 = Buffer.from([0, 255, 1, 254]).toString("base64");
    await tool.execute("invocation:binary", {
      operations: [{ kind: "write_binary", path: "meta/asset.bin", base64, mode: 0o600 }],
    } as never);

    expect(vcs.readBinary("meta/asset.bin")).toBe(base64);
    expect(vcs.modes.get("meta/asset.bin")).toBe(0o600);
  });

  it("rejects every operation before mutation when a trusted observation is stale", async () => {
    const vcs = new StubVcs({
      files: { "meta/a.ts": "old", "meta/b.ts": "old" },
    });
    const observations = createMemoryWorkspaceFileObservationStore();
    observations.record("meta/b.ts", "f".repeat(64));
    const tool = createApplyPatchTool("/", vcs, authority, observations);
    const result = await tool.execute("invocation:stale", {
      operations: [
        { kind: "write", path: "meta/a.ts", content: "new" },
        {
          kind: "write",
          path: "meta/b.ts",
          content: "new",
        },
      ],
    } as never);
    expect(result.details).toMatchObject({
      status: "conflict",
      conflicts: [{ reason: "content-changed", path: "meta/b.ts" }],
    });
    expect(vcs.lastEditInput).toBeUndefined();
    expect(vcs.read("meta/a.ts")).toBe("old");
  });

  it("rejects ambiguous replacements instead of choosing a site", async () => {
    const vcs = new StubVcs({ files: { "meta/a.ts": "same\nsame\n" } });
    const tool = createApplyPatchTool("/", vcs, authority);
    const result = await tool.execute("invocation:ambiguous", {
      operations: [
        {
          kind: "replace",
          path: "meta/a.ts",
          replacements: [{ oldText: "same", newText: "changed" }],
        },
      ],
    } as never);
    expect(result.details).toMatchObject({
      status: "conflict",
      conflicts: [{ reason: "ambiguous", matchCount: 2, candidateLines: [1, 2] }],
    });
    expect(vcs.lastEditInput).toBeUndefined();
  });

  it("returns bounded current context when an exact replacement is stale", async () => {
    const vcs = new StubVcs({
      files: {
        "meta/a.ts": ["export function save() {", "  return submitCurrentValue();", "}"].join("\n"),
      },
    });
    const tool = createApplyPatchTool("/", vcs, authority);

    const result = await tool.execute("invocation:not-found", {
      operations: [
        {
          kind: "replace",
          path: "meta/a.ts",
          replacements: [{ oldText: "return submitOldValue();", newText: "return done;" }],
        },
      ],
    } as never);

    expect(result.details).toMatchObject({
      status: "conflict",
      conflicts: [
        {
          reason: "not-found",
          requestedText: "return submitOldValue();",
          closestCurrentExcerpts: [
            expect.objectContaining({
              text: expect.stringContaining("submitCurrentValue"),
            }),
          ],
          recovery: { action: "reobserve" },
        },
      ],
    });
    expect(vcs.lastEditInput).toBeUndefined();
  });

  it("validates every trusted observation before applying any operation", async () => {
    const vcs = new StubVcs({
      files: {
        "meta/a.ts": "export const currentValue = 2;\n",
        "meta/b.ts": "unchanged\n",
      },
    });
    const observations = createMemoryWorkspaceFileObservationStore();
    observations.record("meta/a.ts", "f".repeat(64));
    const tool = createApplyPatchTool("/", vcs, authority, observations);

    const result = await tool.execute("invocation:receipt-conflict", {
      operations: [
        { kind: "write", path: "meta/b.ts", content: "would mutate\n" },
        {
          kind: "replace",
          path: "meta/a.ts",
          replacements: [{ oldText: "currentValue = 1", newText: "currentValue = 3" }],
        },
      ],
    } as never);

    expect(result.details).toMatchObject({
      status: "conflict",
      conflicts: [
        {
          reason: "content-changed",
          closestCurrentExcerpts: [
            expect.objectContaining({
              text: expect.stringContaining("currentValue = 2"),
            }),
          ],
          recovery: { action: "reobserve" },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("contentHash");
    expect(JSON.stringify(result)).not.toContain("receipt");
    expect(vcs.lastEditInput).toBeUndefined();
    expect(vcs.read("meta/b.ts")).toBe("unchanged\n");
  });

  it("uses the same normalized matcher as edit without weakening atomicity", async () => {
    const vcs = new StubVcs({
      files: {
        "meta/a.ts": "const title = “Current”;  \r\n",
        "meta/b.ts": "before\n",
      },
    });
    const result = await createApplyPatchTool("/", vcs, authority).execute(
      "invocation:normalized",
      {
        operations: [
          {
            kind: "replace",
            path: "meta/a.ts",
            replacements: [
              {
                oldText: 'const title = "Current";\n',
                newText: 'const title = "Next";\n',
              },
            ],
          },
          { kind: "write", path: "meta/b.ts", content: "after\n" },
        ],
      } as never
    );

    expect(result.details).toMatchObject({
      status: "applied",
      operations: [
        { matches: [{ replacement: 0, mode: "normalized", line: 1 }] },
        { status: "changed" },
      ],
    });
    expect(vcs.read("meta/a.ts")).toBe('const title = "Next";\r\n');
    expect(vcs.read("meta/b.ts")).toBe("after\n");
  });

  it("bounds diff evidence across the whole atomic result", async () => {
    const oldText = `old:${"a".repeat(30_000)}\n`;
    const newText = `new:${"b".repeat(30_000)}\n`;
    const vcs = new StubVcs({
      files: { "meta/a.txt": oldText, "meta/b.txt": oldText },
    });

    const result = await createApplyPatchTool("/", vcs, authority).execute(
      "invocation:bounded-diff",
      {
        operations: [
          { kind: "write", path: "meta/a.txt", content: newText },
          { kind: "write", path: "meta/b.txt", content: newText },
        ],
      } as never
    );

    const details = result.details as {
      operations: Array<{
        diff?: string;
        diffTruncated?: boolean;
        diffOriginalChars?: number;
      }>;
    };
    expect(
      details.operations.reduce((length, operation) => length + (operation.diff?.length ?? 0), 0)
    ).toBeLessThanOrEqual(24_000);
    expect(details.operations.some((operation) => operation.diffTruncated)).toBe(true);
    expect(
      details.operations.some(
        (operation) => (operation.diffOriginalChars ?? 0) > (operation.diff?.length ?? 0)
      )
    ).toBe(true);
  });
});
