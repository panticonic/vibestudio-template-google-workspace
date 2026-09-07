import { describe, expect, it } from "vitest";

import { hasAskableUser } from "./agent-worker-base.js";

describe("agent loop tool availability", () => {
  it("offers ask_user only when the channel has a canonical user participant", () => {
    expect(hasAskableUser([{ ref: { kind: "headless" } }, { ref: { kind: "agent" } }])).toBe(false);
    expect(hasAskableUser([{ ref: { kind: "headless" } }, { ref: { kind: "user" } }])).toBe(true);
  });
});
