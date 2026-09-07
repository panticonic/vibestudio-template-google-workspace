import { describe, expect, it, vi } from "vitest";
import { createInMemorySql } from "@workspace/runtime/worker/test-utils";
import type { SqlStorage } from "@workspace/runtime/worker";
import {
  CardManager,
  CardTypeNotRegisteredError,
  CardValidationError,
} from "./custom-cards.js";
import type { ChannelClient } from "./channel-client.js";

const WEATHER_TYPE = {
  typeId: "weather",
  displayMode: "row",
  stateSchema: {
    type: "object",
    properties: { city: { type: "string" }, temp: { type: "number" } },
    required: ["city"],
    additionalProperties: false,
  },
};

async function makeManager(opts?: {
  types?: Record<string, Record<string, unknown> | null>;
}) {
  const sql = (await createInMemorySql()) as unknown as SqlStorage;
  const published: Array<{ event: Record<string, unknown>; idempotencyKey?: string }> = [];
  const channel = {
    getMessageType: vi.fn(async (typeId: string) => opts?.types?.[typeId] ?? null),
    publishAgenticEvent: vi.fn(async (_pid: string, event: unknown, publishOpts?: { idempotencyKey?: string }) => {
      published.push({
        event: event as Record<string, unknown>,
        idempotencyKey: publishOpts?.idempotencyKey,
      });
      return { id: published.length };
    }),
  } as unknown as ChannelClient;
  const manager = new CardManager({
    sql,
    createChannelClient: () => channel,
    getParticipantId: () => "agent-pid",
    getActor: () => ({ kind: "agent", id: "agent-1", displayName: "Agent" }),
    getAgentId: () => "agent-1",
  });
  return { manager, published, channel, sql };
}

describe("CardManager", () => {
  it("creates a card, publishing custom.started with the registered display mode", async () => {
    const { manager, published } = await makeManager({ types: { weather: WEATHER_TYPE } });
    const card = await manager.getOrCreate("chan-1", "weather", "main", { city: "Berlin" });
    expect(published).toHaveLength(1);
    const event = published[0]!.event;
    expect(event["kind"]).toBe("custom.started");
    const payload = event["payload"] as Record<string, unknown>;
    expect(payload["typeId"]).toBe("weather");
    expect(payload["displayMode"]).toBe("row");
    expect(payload["initialState"]).toEqual({ city: "Berlin" });
    expect(published[0]!.idempotencyKey).toBe(`custom:agent-1:${card.messageId}:start`);
  });

  it("getOrCreate is idempotent by natural key — same card, no re-publish", async () => {
    const { manager, published } = await makeManager({ types: { weather: WEATHER_TYPE } });
    const first = await manager.getOrCreate("chan-1", "weather", "main", { city: "Berlin" });
    const second = await manager.getOrCreate("chan-1", "weather", "main", { city: "Paris" });
    expect(second.messageId).toBe(first.messageId);
    expect(published).toHaveLength(1);
  });

  it("surfaces the started-publish pubsubId on the created handle (undefined on a hit)", async () => {
    const { manager } = await makeManager({ types: { weather: WEATHER_TYPE } });
    // Mock publishAgenticEvent returns { id: published.length } → first is 1.
    const created = await manager.getOrCreate("chan-1", "weather", "main", { city: "Berlin" });
    expect(created.pubsubId).toBe(1);
    // A getOrCreate hit publishes nothing → no pubsubId.
    const hit = await manager.getOrCreate("chan-1", "weather", "main", { city: "Paris" });
    expect(hit.pubsubId).toBeUndefined();
  });

  it("update/fail resolve to the pubsubId of the emitted custom.updated event", async () => {
    const { manager } = await makeManager({ types: { weather: WEATHER_TYPE } });
    const card = await manager.getOrCreate("chan-1", "weather", "main", { city: "Berlin" }); // id 1
    await expect(card.update({ city: "Paris" })).resolves.toBe(2);
    await expect(card.fail({ message: "down" })).resolves.toBe(3);
  });

  it("uses deterministic, monotonic idempotency keys for updates", async () => {
    const { manager, published } = await makeManager({ types: { weather: WEATHER_TYPE } });
    const card = await manager.getOrCreate("chan-1", "weather", "main", { city: "Berlin" });
    await card.update({ city: "Paris" });
    await card.update({ city: "Oslo" });
    expect(published.map((p) => p.idempotencyKey)).toEqual([
      `custom:agent-1:${card.messageId}:start`,
      `custom:agent-1:${card.messageId}:1`,
      `custom:agent-1:${card.messageId}:2`,
    ]);
  });

  it("survives a restart: a new manager over the same sql resumes the seq", async () => {
    const { manager, published, sql, channel } = await makeManager({ types: { weather: WEATHER_TYPE } });
    const card = await manager.getOrCreate("chan-1", "weather", "main", { city: "Berlin" });
    await card.update({ city: "Paris" });

    const revived = new CardManager({
      sql,
      createChannelClient: () => channel,
      getParticipantId: () => "agent-pid",
      getActor: () => ({ kind: "agent", id: "agent-1" }),
      getAgentId: () => "agent-1",
    });
    const same = await revived.getOrCreate("chan-1", "weather", "main", { city: "ignored" });
    expect(same.messageId).toBe(card.messageId);
    await same.update({ city: "Oslo" });
    expect(published[published.length - 1]!.idempotencyKey).toBe(
      `custom:agent-1:${card.messageId}:2`
    );
  });

  it("throws CardValidationError on invalid initial state and updates", async () => {
    const { manager, published } = await makeManager({ types: { weather: WEATHER_TYPE } });
    await expect(
      manager.getOrCreate("chan-1", "weather", "bad", { temp: 20 })
    ).rejects.toThrow(CardValidationError);
    expect(published).toHaveLength(0);

    const card = await manager.getOrCreate("chan-1", "weather", "main", { city: "Berlin" });
    await expect(card.update({ city: 42 })).rejects.toThrow(CardValidationError);
    expect(published).toHaveLength(1);
  });

  it("throws CardTypeNotRegisteredError for unknown types", async () => {
    const { manager } = await makeManager({ types: {} });
    await expect(
      manager.getOrCreate("chan-1", "nope", "main", {})
    ).rejects.toThrow(CardTypeNotRegisteredError);
  });

  it("fail() publishes a failed custom.updated with the error", async () => {
    const { manager, published } = await makeManager({ types: { weather: WEATHER_TYPE } });
    const card = await manager.getOrCreate("chan-1", "weather", "main", { city: "Berlin" });
    await card.fail({ message: "weather API down" });
    const payload = published[1]!.event["payload"] as Record<string, unknown>;
    expect(payload["status"]).toBe("failed");
    expect(payload["error"]).toEqual({ message: "weather API down" });
  });

  it("invalidateType refetches the definition on next use", async () => {
    const types: Record<string, Record<string, unknown> | null> = { weather: WEATHER_TYPE };
    const { manager, channel } = await makeManager({ types });
    await manager.getOrCreate("chan-1", "weather", "main", { city: "Berlin" });
    expect(channel.getMessageType).toHaveBeenCalledTimes(1);
    const card = manager.find("chan-1", "main")!;
    await card.update({ city: "Paris" });
    expect(channel.getMessageType).toHaveBeenCalledTimes(1); // cached
    manager.invalidateType("chan-1", "weather");
    await card.update({ city: "Oslo" });
    expect(channel.getMessageType).toHaveBeenCalledTimes(2);
  });
});
