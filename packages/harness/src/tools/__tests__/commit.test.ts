import { describe, expect, it } from "vitest";
import { createWorkspaceVcsTool, type ToolWorkflowVcs } from "../workspace-vcs.js";
import { StubVcs } from "./stub-vcs.js";

const authority = { contextId: "context:test", commandId: "command:commit" };

function commitTool(vcs: StubVcs) {
  return createWorkspaceVcsTool("/", vcs as unknown as ToolWorkflowVcs, authority);
}

describe("workspace VCS commit operation", () => {
  it("commits the complete working application chain into one event", async () => {
    const vcs = new StubVcs({ files: { "packages/demo/a.ts": "a" } });
    await vcs.edit({
      contextId: "context:test",
      expectedWorkingHead: { kind: "event", eventId: "event:committed" },
      commandId: "command:prepare",
      changes: [
        {
          kind: "text-edit",
          repositoryId: "repository:packages/demo",
          fileId: "file:packages/demo/a.ts",
          edits: [{ start: 0, end: 1, text: "b" }],
        },
      ],
    });
    const tool = commitTool(vcs);
    const result = await tool.execute("invocation:1", {
      operation: "commit",
      message: "Unify authorization",
    });

    expect(vcs.lastCommitInput).toMatchObject({
      contextId: "context:test",
      commandId: "command:commit",
      expectedWorkingHead: { kind: "application", applicationId: "application:1" },
      message: "Unify authorization",
    });
    const committed = result.details.result as {
      event: { kind: "event"; eventId: string };
      committedApplicationIds: string[];
    };
    expect(committed.event).toMatchObject({
      kind: "event",
      eventId: expect.stringMatching(/^event:/),
    });
    expect(committed.committedApplicationIds).toEqual(["application:1"]);
    expect(result.details.status).toMatchObject({
      clean: true,
      committed: committed.event,
      workingHead: committed.event,
      workingCounts: { applications: 0, workUnits: 0, changes: 0 },
      integrating: [],
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("the context is clean at that event"),
    });
  });

  it("does not expose selective commit inputs", async () => {
    const vcs = new StubVcs();
    const tool = commitTool(vcs);
    expect(JSON.stringify(tool.parameters)).not.toContain("workUnitIds");
    await tool.execute("invocation:2", { operation: "commit", message: "Commit the chain" });
    expect(vcs.lastCommitInput).not.toHaveProperty("selection");
  });

  it("derives integration parents without exposing a second commit channel", async () => {
    const vcs = new StubVcs();
    const tool = commitTool(vcs);
    await tool.execute("invocation:integration", {
      operation: "commit",
      message: "Close the incremental integration",
    });
    expect(vcs.lastCommitInput).toMatchObject({ commandId: "command:commit" });
    expect(vcs.lastCommitInput).not.toHaveProperty("integratesEventIds");
  });

  it("does not expose integration parents in the commit input", () => {
    const tool = commitTool(new StubVcs());
    const variants = (tool.parameters as unknown as { anyOf: Record<string, unknown>[] }).anyOf;
    const commit = variants.find((variant) => {
      const properties = variant["properties"] as
        | Record<string, Record<string, unknown>>
        | undefined;
      return properties?.["operation"]?.["const"] === "commit";
    });
    const properties = commit?.["properties"] as
      | Record<string, Record<string, unknown>>
      | undefined;

    expect(properties).not.toHaveProperty("integratesEventIds");
  });
});
