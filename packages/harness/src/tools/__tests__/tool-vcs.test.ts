import { describe, expect, it, vi } from "vitest";
import { vcsMethods } from "@vibestudio/service-schemas/vcs";
import { createToolVcs, toolCommandId } from "../tool-vcs.js";

describe("canonical tool VCS adapter", () => {
  it("derives the complete method roster from the service schema", () => {
    const vcs = createToolVcs(async () => null as never);
    expect(Object.keys(vcs).sort()).toEqual(Object.keys(vcsMethods).sort());
  });

  it("forwards canonical writes without a caller-authored attribution field", async () => {
    const call = vi.fn(async (_method: string, _args: unknown[]) => ({
      contextId: "context:1",
      workUnitId: "work:1",
      applicationId: "application:1",
      commandId: "command:1",
      decisionIds: [],
      changeCount: 1,
      changeIds: ["change:1"],
      incorporatedChangeCount: 0,
      incorporatedChangeIds: [],
      workingHead: { kind: "application", applicationId: "application:1" },
    }));
    const vcs = createToolVcs(
      async <T>(method: string, args: unknown[]) => (await call(method, args)) as T
    );
    const base = {
      contextId: "context:1",
      expectedWorkingHead: { kind: "event" as const, eventId: "event:1" },
      commandId: "command:1",
      changes: [
        {
          kind: "file-delete" as const,
          repositoryId: "repository:1",
          fileId: "file:1",
        },
      ],
    };

    await vcs.edit(base);

    expect(call).toHaveBeenCalledWith("vcs.edit", [base]);
    expect(call.mock.calls[0]?.[1]?.[0]).not.toHaveProperty("invocationId");
  });

  it("resolves a bound invocation command and fails closed when schema-only tools mutate", () => {
    expect(toolCommandId({ contextId: "context:1", commandId: "command:exact" })).toBe(
      "command:exact"
    );
    expect(() =>
      toolCommandId({
        contextId: "context:1",
        commandId: () => {
          throw new Error("no bound trajectory invocation");
        },
      })
    ).toThrow(/no bound trajectory invocation/);
    expect(() => toolCommandId({ contextId: "context:1", commandId: "" })).toThrow(
      /requires a bound trajectory invocation command id/
    );
  });
});
