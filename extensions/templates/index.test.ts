import { describe, expect, it, vi } from "vitest";
import { retainedInspectionPin } from "./inspectionPin.js";
import { activate } from "./index.js";

describe("exact template reinspection", () => {
  it("keeps a reviewed pin when its moving ref may have advanced", async () => {
    const pin = {
      url: "https://example.test/app.git",
      ref: "refs/heads/main",
      commit: "a".repeat(40),
      snapshot: `v1-sha256:${"b".repeat(64)}`,
    };
    expect(retainedInspectionPin({ pin })).toEqual(pin);
  });
});

it("delegates every exact pin to the host-owned source acquisition contract", async () => {
  const pin = {
    url: "https://example.invalid/dirty.git",
    ref: "refs/heads/main",
    commit: "a".repeat(40),
    snapshot: `v1-sha256:${"b".repeat(64)}` as const,
  };
  const inspected = {
    pin,
    presentation: { name: "Dirty source" },
    repositories: ["panels/example"],
    files: ["package.json"],
  };
  const call = vi.fn(async () => inspected);
  const api = await activate({
    log: { info: vi.fn() },
    rpc: { call },
  } as never);

  await expect(api.inspect({ pin })).resolves.toEqual(inspected);
  expect(call).toHaveBeenCalledWith(
    "main",
    "workspaceTemplateSource.inspectExact",
    pin,
  );
});
