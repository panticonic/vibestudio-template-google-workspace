import { describe, expect, it } from "vitest";
import { parseClaudeLaunchRecord } from "./launchOwnership.js";

const record = {
  version: 1,
  launchId: "generation",
  entityId: "session",
  contextId: "context",
  channelId: "channel",
  ownerKind: "host-headless",
  phase: "active",
  agentId: "agent",
  preparedAt: "2026-09-06T00:00:00.000Z",
};
describe("Claude semantic generation ownership", () => {
  it("persists the exact generation and delegated agent without host resources", () => {
    expect(
      parseClaudeLaunchRecord(
        JSON.parse(JSON.stringify(record)),
        "generation.json",
      ),
    ).toEqual(record);
  });
  it.each([
    { ...record, process: { pid: 1 } },
    { ...record, materialization: { profileDir: "/host/profile" } },
    { ...record, version: 4 },
    { ...record, agentId: undefined },
  ])("rejects nonsemantic or corrupt ownership records", (value) => {
    expect(() => parseClaudeLaunchRecord(value, "invalid.json")).toThrow(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
  });
});
