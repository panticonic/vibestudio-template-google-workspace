import { describe, expect, it } from "vitest";
import { createWriteTool } from "../write.js";
import { createReadTool } from "../read.js";
import { createMemoryWorkspaceFileObservationStore } from "../file-observations.js";
import { sha256Hex } from "@vibestudio/content-addressing";
import { StubFs } from "./stub-fs.js";
import { StubVcs } from "./stub-vcs.js";

const CWD = "/";
const authority = { contextId: "context:test", commandId: "command:write" };

describe("canonical write tool", () => {
  it("automatically carries a read observation into a later write", async () => {
    const observations = createMemoryWorkspaceFileObservationStore();
    const fs = new StubFs({ files: { "/meta/out.txt": "before" } });
    await createReadTool(CWD, fs, { observations }).execute("invocation:read", {
      path: "meta/out.txt",
    });
    const vcs = new StubVcs({ files: { "meta/out.txt": "before" } });
    vcs.files.set("meta/out.txt", "changed elsewhere");

    const result = await createWriteTool(
      CWD,
      vcs,
      authority,
      undefined,
      observations
    ).execute("invocation:write", { path: "meta/out.txt", content: "replacement" });

    expect(result.details).toMatchObject({
      status: "conflict",
      conflicts: [{ path: "meta/out.txt", reason: "content-changed" }],
    });
    expect(JSON.stringify(result)).not.toContain("contentHash");
    expect(JSON.stringify(result)).not.toContain("receipt");
    expect(vcs.read("meta/out.txt")).toBe("changed elsewhere");
  });

  it("keeps stale-write state inside the harness and advances it after writes", async () => {
    const vcs = new StubVcs({ files: { "meta/out.txt": "before" } });
    const observations = createMemoryWorkspaceFileObservationStore();
    observations.record("meta/out.txt", sha256Hex(new TextEncoder().encode("before")));
    const tool = createWriteTool(CWD, vcs, authority, undefined, observations);

    expect(JSON.stringify(tool.parameters)).not.toContain("receipt");
    expect(JSON.stringify(tool.parameters)).not.toContain("contentHash");
    await expect(
      tool.execute("invocation:first", {
        path: "meta/out.txt",
        content: "after",
      })
    ).resolves.toMatchObject({ details: { status: "applied" } });
    expect(observations.get("meta/out.txt")).toBe(sha256Hex(new TextEncoder().encode("after")));
    await expect(
      tool.execute("invocation:second", {
        path: "meta/out.txt",
        content: "final",
      })
    ).resolves.toMatchObject({ details: { status: "applied" } });
    expect(vcs.read("meta/out.txt")).toBe("final");
  });

  it("declares an admitted mutation as a cancellation settlement boundary", () => {
    expect(createWriteTool(CWD, new StubVcs(), authority).cancellationMode).toBe("settle");
  });

  it("does not advertise a file mode that scratch writes cannot honor", () => {
    const tool = createWriteTool(CWD, new StubVcs(), authority);

    expect(tool.parameters.properties).not.toHaveProperty("mode");
    expect(tool.description).toContain("apply_patch");
    expect(tool.description).toContain("explicit file mode");
  });

  it("creates a new repository file through a state-checked change", async () => {
    const vcs = new StubVcs();
    const tool = createWriteTool(CWD, vcs, authority);
    const result = await tool.execute("invocation:1", {
      path: "meta/out.txt",
      content: "hello",
      intent: "Create the durable handoff consumed by the next pipeline stage",
    });
    expect(vcs.read("meta/out.txt")).toBe("hello");
    expect(vcs.lastEditInput).toMatchObject({
      commandId: "command:write",
      intentSummary: "Create the durable handoff consumed by the next pipeline stage",
      expectedWorkingHead: { kind: "event", eventId: "event:committed" },
      changes: [
        {
          kind: "file-create",
          repositoryId: "repository:meta",
          path: "out.txt",
        },
      ],
    });
    expect(result.details.storage).toBe("vcs");
  });

  it("guards an overwrite with the exact state and file identity", async () => {
    const vcs = new StubVcs({ files: { "meta/out.txt": "old" } });
    const tool = createWriteTool(CWD, vcs, authority);
    await tool.execute("invocation:2", {
      path: "meta/out.txt",
      content: "new",
    });
    expect(vcs.lastEditInput).toMatchObject({
      expectedWorkingHead: { kind: "event", eventId: "event:committed" },
      changes: [
        {
          kind: "text-edit",
          repositoryId: "repository:meta",
          fileId: "file:meta/out.txt",
          edits: [{ start: 0, end: 3, text: "new" }],
        },
      ],
    });
  });

  it("treats an identical whole-file write as an idempotent success", async () => {
    const vcs = new StubVcs({ files: { "meta/out.txt": "same" } });
    const tool = createWriteTool(CWD, vcs, authority);
    const result = await tool.execute("invocation:unchanged", {
      path: "meta/out.txt",
      content: "same",
    });

    expect(result.details).toMatchObject({
      protocol: "file-mutation.v1",
      status: "unchanged",
      storage: "vcs",
      operations: [
        {
          path: "meta/out.txt",
          kind: "write",
          status: "unchanged",
          bytesWritten: 4,
        },
      ],
      conflicts: [],
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: "meta/out.txt already matches the requested state.",
      },
    ]);
    expect(vcs.read("meta/out.txt")).toBe("same");
    expect(vcs.lastEditInput).toBeUndefined();
  });

  it("writes non-repository scratch paths directly", async () => {
    const vcs = new StubVcs();
    const fs = new StubFs();
    const tool = createWriteTool(CWD, vcs, authority, fs);
    const result = await tool.execute("invocation:3", {
      path: ".tmp/out.txt",
      content: "scratch",
    });
    await expect(fs.readFile(".tmp/out.txt", "utf8")).resolves.toBe("scratch");
    expect(result.details.storage).toBe("scratch");
    expect(vcs.lastEditInput).toBeUndefined();
  });

  it("reports success when cancellation arrives after the semantic edit committed", async () => {
    const controller = new AbortController();
    class AbortAfterCommitVcs extends StubVcs {
      override async edit(input: Parameters<StubVcs["edit"]>[0]) {
        const result = await super.edit(input);
        controller.abort(new Error("turn interrupted after commit"));
        return result;
      }
    }
    const vcs = new AbortAfterCommitVcs();
    const tool = createWriteTool(CWD, vcs, authority);

    const result = await tool.execute(
      "invocation:post-commit-cancel",
      { path: "meta/out.txt", content: "committed" },
      controller.signal
    );

    expect(controller.signal.aborted).toBe(true);
    expect(vcs.read("meta/out.txt")).toBe("committed");
    expect(result.details).toMatchObject({
      storage: "vcs",
      operations: [{ bytesWritten: 9, status: "created" }],
    });
  });

  it("rejects cancellation before mutation admission", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before admission"));
    const vcs = new StubVcs();
    const tool = createWriteTool(CWD, vcs, authority);

    await expect(
      tool.execute(
        "invocation:pre-admission-cancel",
        { path: "meta/out.txt", content: "never" },
        controller.signal
      )
    ).rejects.toThrow("Operation aborted");
    expect(vcs.lastEditInput).toBeUndefined();
  });

  it("returns a recoverable scratch suggestion for a missing managed repository", async () => {
    const vcs = new StubVcs();
    const tool = createWriteTool(CWD, vcs, authority);
    const result = await tool.execute("invocation:missing-repo", {
      path: "projects/temporary-note.md",
      content: "scratch",
    });

    expect(result.details).toMatchObject({
      status: "conflict",
      storage: "vcs",
      conflicts: [
        {
          path: "projects/temporary-note/temporary-note.md",
          reason: "repository-not-present",
          suggestedScratchPath: ".tmp/temporary-note.md",
        },
      ],
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("No files changed"),
    });
    expect(vcs.lastEditInput).toBeUndefined();
  });

  it("returns a create-only conflict without exposing internal file state", async () => {
    const vcs = new StubVcs({ files: { "meta/out.txt": "existing" } });
    const result = await createWriteTool(CWD, vcs, authority).execute("invocation:create-only", {
      path: "meta/out.txt",
      content: "replacement",
      createOnly: true,
    });

    expect(result.details).toMatchObject({
      status: "conflict",
      conflicts: [{ reason: "file-exists" }],
    });
    expect(JSON.stringify(result)).not.toContain("contentHash");
    expect(JSON.stringify(result)).not.toContain("receipt");
    expect(vcs.read("meta/out.txt")).toBe("existing");
    expect(vcs.lastEditInput).toBeUndefined();
  });

  it("can expose its schema unbound but refuses a semantic mutation", async () => {
    const vcs = new StubVcs();
    const tool = createWriteTool(CWD, vcs, {
      contextId: "context:test",
      commandId: () => {
        throw new Error("no bound trajectory invocation");
      },
    });

    expect(tool.parameters.properties).toHaveProperty("path");
    await expect(
      tool.execute("untrusted-tool-call-id", {
        path: "meta/out.txt",
        content: "hello",
      })
    ).rejects.toThrow(/no bound trajectory invocation/);
    expect(vcs.lastEditInput).toBeUndefined();
  });
});
