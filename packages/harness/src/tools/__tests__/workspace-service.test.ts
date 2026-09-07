import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import YAML from "yaml";
import { createWorkspaceServiceTool } from "../workspace-service.js";
import { StubVcs } from "./stub-vcs.js";

const authority = { contextId: "context:test", commandId: "command:workspace-service" };
const initial = `systemEpoch: 1
singletonObjects:
  - source: workers/testkit-driver
    className: TestkitDriverDO
    key: workspace-testkit-driver
services:
  - source: workers/testkit-driver
    name: testkit-driver
    title: Test runner
    action: run workspace tests
    description: Run tests.
    protocols: [vibestudio.testkit-driver.v1]
    authority:
      principals: [host, code]
    durableObject:
      className: TestkitDriverDO
routes: []
`;

describe("workspace_service tool", () => {
  it("makes every upsert declaration field required in the public tool schema", () => {
    const tool = createWorkspaceServiceTool(
      new StubVcs({ files: { "meta/vibestudio.yml": initial } }),
      authority,
      { validateConfig: vi.fn(async () => {}) }
    );

    expect(
      Value.Check(tool.parameters, {
        operation: "upsert",
        source: "workers/todo-store",
        name: "todo-store",
        title: "Todo store",
        action: "read todos",
        description: "Read todos.",
        presentation: { domain: "automation", verb: "act" },
        protocols: ["example.todos.v1"],
        principals: ["code"],
        transport: { kind: "durable-object", className: "TodoStore" },
      })
    ).toBe(false);
    expect(
      Value.Check(tool.parameters, {
        operation: "remove",
        name: "todo-store",
      })
    ).toBe(true);
  });

  it("upserts a service and its singleton in one validated semantic edit", async () => {
    const vcs = new StubVcs({ files: { "meta/vibestudio.yml": initial } });
    const validateConfig = vi.fn(async (content: string) => {
      expect(YAML.parse(content).services).toHaveLength(2);
    });
    const tool = createWorkspaceServiceTool(vcs, authority, { validateConfig });

    const result = await tool.execute("invocation:service", {
      operation: "upsert",
      source: "workers/todo-store",
      name: "todo-store",
      title: "Todo store",
      action: "read and update todos",
      description: "Keep shared todos for this workspace.",
      notability: "everyday",
      presentation: { domain: "automation", verb: "manage" },
      protocols: ["example.todos.v1"],
      principals: ["user", "code"],
      transport: { kind: "durable-object", className: "TodoStore", objectKey: "main" },
    });

    const config = YAML.parse(vcs.read("meta/vibestudio.yml")!);
    expect(config.services).toEqual([
      expect.objectContaining({
        name: "testkit-driver",
        protocols: ["vibestudio.testkit-driver.v1"],
        durableObject: { className: "TestkitDriverDO" },
      }),
      expect.objectContaining({
        name: "todo-store",
        notability: "everyday",
        protocols: ["example.todos.v1"],
        durableObject: { className: "TodoStore" },
      }),
    ]);
    expect(config.singletonObjects).toContainEqual({
      source: "workers/todo-store",
      className: "TodoStore",
      key: "main",
    });
    expect(validateConfig).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({
      changed: true,
      serviceName: "todo-store",
      docsId: "workspace:todo-store",
    });
  });

  it("does not create a working state when complete-config validation fails", async () => {
    const vcs = new StubVcs({ files: { "meta/vibestudio.yml": initial } });
    const tool = createWorkspaceServiceTool(vcs, authority, {
      validateConfig: vi.fn(async () => {
        throw new Error("candidate is invalid");
      }),
    });

    await expect(
      tool.execute("invocation:invalid", {
        operation: "upsert",
        source: "workers/todo-store",
        name: "todo-store",
        title: "Todo store",
        action: "read todos",
        description: "Read todos.",
        notability: "everyday",
        presentation: { domain: "automation", verb: "see" },
        protocols: ["example.todos.v1"],
        principals: ["code"],
        transport: { kind: "durable-object", className: "TodoStore", objectKey: "main" },
      })
    ).rejects.toThrow("candidate is invalid");
    expect(vcs.read("meta/vibestudio.yml")).toBe(initial);
    expect(vcs.lastEditInput).toBeUndefined();
  });
});
