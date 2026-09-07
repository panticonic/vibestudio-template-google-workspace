import { describe, expect, it, vi } from "vitest";
import { createInMemorySql } from "@workspace/runtime/worker/test-utils";
import type { SqlStorage } from "@workspace/runtime/worker";
import type { ChannelClient } from "./channel-client.js";
import { DOIdentity } from "./identity.js";
import { SubscriptionManager } from "./subscription-manager.js";

async function makeManager(channel: Partial<ChannelClient>) {
  const sql = (await createInMemorySql()) as unknown as SqlStorage;
  const identity = new DOIdentity(sql);
  identity.createTables();
  identity.bootstrap(
    { source: "workers/test-agent", className: "TestAgentWorker", objectKey: "agent-1" },
    "session-1"
  );
  const manager = new SubscriptionManager(sql, () => channel as ChannelClient, identity);
  manager.createTables();
  return manager;
}

const descriptor = { name: "Test", type: "agent" as const, handle: "test" };

describe("SubscriptionManager finite relationships", () => {
  it("persists membership only after the channel acknowledges join", async () => {
    const join = vi.fn().mockRejectedValue(new Error("join rejected"));
    const manager = await makeManager({
      join,
      relationshipState: vi.fn().mockResolvedValue(null),
    });

    await expect(
      manager.subscribe({ channelId: "ch-1", contextId: "ctx-1", descriptor })
    ).rejects.toThrow("join rejected");
    expect(manager.listAll()).toEqual([]);
  });

  it("keeps an identical retry at the same relationship revision", async () => {
    const join = vi.fn().mockImplementation(async (input) => ({
      ok: true,
      participantId: "agent-1",
      revision: input.revision,
    }));
    const manager = await makeManager({
      join,
      relationshipState: vi.fn().mockResolvedValue(null),
    });

    const input = { channelId: "ch-1", contextId: "ctx-1", descriptor };
    await manager.subscribe(input);
    await manager.subscribe(input);

    expect(join.mock.calls.map(([arg]) => arg.revision)).toEqual([1, 1]);
    expect(manager.count()).toBe(1);
  });

  it("increments the revision when relationship semantics change", async () => {
    const join = vi.fn().mockImplementation(async (input) => ({
      ok: true,
      participantId: "agent-1",
      revision: input.revision,
    }));
    const manager = await makeManager({
      join,
      relationshipState: vi.fn().mockResolvedValue(null),
    });

    await manager.subscribe({ channelId: "ch-1", contextId: "ctx-1", descriptor });
    await manager.subscribe({
      channelId: "ch-1",
      contextId: "ctx-2",
      descriptor,
      config: { wakePolicy: "turn-final" },
    });

    expect(join.mock.calls.map(([arg]) => arg.revision)).toEqual([1, 2]);
    expect(manager.getContextId("ch-1")).toBe("ctx-2");
  });

  it("continues the channel's monotonic revision after a prior leave", async () => {
    const join = vi.fn().mockImplementation(async (input) => ({
      ok: true,
      participantId: "agent-1",
      revision: input.revision,
    }));
    const relationshipState = vi.fn().mockResolvedValue({ revision: 8, active: false });
    const manager = await makeManager({ join, relationshipState });

    await manager.subscribe({ channelId: "ch-1", contextId: "ctx-1", descriptor });

    expect(join).toHaveBeenCalledWith(expect.objectContaining({ revision: 9 }));
  });

  it("deletes local membership only after finite leave is acknowledged", async () => {
    const leave = vi.fn().mockResolvedValue(undefined);
    const manager = await makeManager({
      join: vi.fn().mockImplementation(async (input) => ({
        ok: true,
        participantId: "agent-1",
        revision: input.revision,
      })),
      leave,
      relationshipState: vi.fn().mockResolvedValue(null),
    });
    await manager.subscribe({ channelId: "ch-1", contextId: "ctx-1", descriptor });

    await manager.unsubscribeFromChannel("ch-1");

    expect(leave).toHaveBeenCalledWith(expect.stringContaining("agent-1"), 2);
    expect(manager.listAll()).toEqual([]);
  });

  it("distinguishes reasoning memberships from addressed-only supervision", async () => {
    const join = vi.fn().mockImplementation(async (input) => ({
      ok: true,
      participantId: "agent-1",
      revision: input.revision,
    }));
    const manager = await makeManager({
      join,
      relationshipState: vi.fn().mockResolvedValue(null),
    });

    await manager.subscribe({
      channelId: "work",
      contextId: "ctx-1",
      descriptor,
      delivery: "all",
    });
    await manager.subscribe({
      channelId: "supervised-task",
      contextId: "ctx-2",
      descriptor,
      delivery: "addressed",
    });

    expect(manager.ownsReasoningLoop("work")).toBe(true);
    expect(manager.ownsReasoningLoop("supervised-task")).toBe(false);
    expect(manager.ownsReasoningLoop("missing")).toBe(false);
    expect(join.mock.calls[1]![0]).toMatchObject({
      metadata: { type: "observer" },
    });
  });
});
