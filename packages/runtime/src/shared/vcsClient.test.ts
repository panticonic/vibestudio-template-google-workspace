import { describe, expect, it, vi } from "vitest";
import { RemoteRpcError } from "@vibestudio/rpc";
import { vcsMethods } from "@vibestudio/service-schemas/vcs";
import { createVcsClient } from "./vcsClient.js";

describe("createVcsClient", () => {
  it("exposes exactly the schema-owned method roster", () => {
    const client = createVcsClient(async () => null as never, "context:bound");
    expect(Object.keys(client).sort()).toEqual(Object.keys(vcsMethods).sort());
  });

  it("dispatches one canonical request without a routing overlay", async () => {
    const call = vi.fn(async (..._args: unknown[]) => ({
      contextId: "context:1",
      committed: { kind: "event", eventId: "event:committed" },
      workingHead: { kind: "event", eventId: "event:committed" },
      clean: true,
      mainEventId: "event:committed",
      mainRelation: "at",
      workingCounts: { applications: 0, workUnits: 0, changes: 0 },
      integrating: [],
    }));
    const client = createVcsClient(
      async <T>(method: string, ...args: unknown[]) => (await call(method, args[0])) as T,
      "context:bound"
    );

    await client.status({ contextId: "context:1" });

    expect(call).toHaveBeenCalledWith("vcs.status", { contextId: "context:1" });
  });

  it("binds omitted context to the runtime's semantic context", async () => {
    const call = vi.fn(async (..._args: unknown[]) => ({
      contextId: "context:bound",
      committed: { kind: "event", eventId: "event:committed" },
      workingHead: { kind: "event", eventId: "event:committed" },
      clean: true,
      mainEventId: "event:committed",
      mainRelation: "at",
      workingCounts: { applications: 0, workUnits: 0, changes: 0 },
      integrating: [],
    }));
    const client = createVcsClient(
      async <T>(method: string, ...args: unknown[]) => (await call(method, args[0])) as T,
      "context:bound"
    );

    await client.status();

    expect(call).toHaveBeenCalledWith("vcs.status", { contextId: "context:bound" });
  });

  it("binds context only for methods whose schema declares a context reference", async () => {
    const call = vi.fn(async (..._args: unknown[]) => ({
      root: { kind: "event", eventId: "event:committed" },
      node: {
        kind: "event",
        value: {
          eventId: "event:committed",
          workspaceId: "workspace:1",
          commandId: "command:1",
          kind: "commit",
          workspaceFactRootId: "fact:1",
          parentEventIds: [],
          applicationIds: [],
          decisionIds: [],
          message: null,
          semanticProtocol: "semantic-vcs-v1",
          createdAt: "2026-07-24T00:00:00.000Z",
        },
      },
      edges: [],
      hasMoreEdges: false,
    }));
    const client = createVcsClient(
      async <T>(method: string, ...args: unknown[]) => (await call(method, args[0])) as T,
      "context:bound"
    );

    await client.inspect({
      node: { kind: "event", eventId: "event:committed" },
      edgeLimit: 1,
    });

    expect(call).toHaveBeenCalledWith("vcs.inspect", {
      node: { kind: "event", eventId: "event:committed" },
      edgeLimit: 1,
    });
  });

  it("allows context-bound mutations to omit only their context identity", async () => {
    const call = vi.fn(async (..._args: unknown[]) => ({
      contextId: "context:bound",
      workingHead: { kind: "event", eventId: "event:committed" },
      discardedApplicationIds: [],
    }));
    const client = createVcsClient(
      async <T>(method: string, ...args: unknown[]) => (await call(method, args[0])) as T,
      "context:bound"
    );

    await client.discard({
      commandId: "command:discard",
      expectedWorkingHead: { kind: "event", eventId: "event:committed" },
    });

    expect(call).toHaveBeenCalledWith("vcs.discard", {
      contextId: "context:bound",
      commandId: "command:discard",
      expectedWorkingHead: { kind: "event", eventId: "event:committed" },
    });
  });

  it("preserves typed service refusals", async () => {
    const errorData = {
      code: "RevisionChanged",
      message: "Working head changed",
      expected: { kind: "event" as const, eventId: "event:observed" },
      actual: { kind: "application" as const, applicationId: "application:current" },
    };
    const refusal = new RemoteRpcError(errorData.message, "application", errorData.code, errorData);
    const client = createVcsClient(async () => {
      throw refusal;
    }, "context:bound");

    const rejected = await client
      .discard({
        contextId: "context:1",
        expectedWorkingHead: errorData.expected,
        commandId: "command:discard",
      })
      .catch((error) => error);

    expect(rejected).toBe(refusal);
    expect(rejected).toMatchObject({ code: "RevisionChanged", errorData });
  });
});
