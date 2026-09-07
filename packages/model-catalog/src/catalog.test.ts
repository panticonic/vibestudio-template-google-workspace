import { describe, expect, it } from "vitest";
import { isModelAgentLaunchable, isModelUsable, type ModelAvailability } from "./catalog";

describe("isModelUsable", () => {
  it.each<ModelAvailability>([
    { state: "ready" },
    { state: "startable", detail: "will-load-on-use" },
  ])("allows $state models to start an agent", (availability) => {
    expect(isModelUsable({ availability })).toBe(true);
  });

  it.each<ModelAvailability>([
    { state: "needs-setup", detail: "not-installed" },
    {
      state: "downloading",
      progress: 0.5,
      phase: "active",
      receivedBytes: 350_000_000,
      totalBytes: 700_000_000,
    },
    { state: "starting" },
    { state: "error", message: "installation failed" },
  ])("blocks $state models from starting an agent", (availability) => {
    expect(isModelUsable({ availability })).toBe(false);
  });

  it("treats a missing catalog entry as unavailable", () => {
    expect(isModelUsable(null)).toBe(false);
  });
});

describe("isModelAgentLaunchable", () => {
  it("allows a connectable remote model to park for agent-owned credential setup", () => {
    expect(
      isModelAgentLaunchable({
        provider: "openai-codex",
        connectable: true,
        availability: { state: "needs-setup", detail: "no-credential" },
      })
    ).toBe(true);
  });

  it("still blocks uninstalled local and non-connectable remote models", () => {
    expect(
      isModelAgentLaunchable({
        provider: "local",
        connectable: false,
        availability: { state: "needs-setup", detail: "not-installed" },
      })
    ).toBe(false);
    expect(
      isModelAgentLaunchable({
        provider: "custom",
        connectable: false,
        availability: { state: "needs-setup", detail: "no-credential" },
      })
    ).toBe(false);
  });
});
