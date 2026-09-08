import { describe, expect, it, vi } from "vitest";
import {
  createShellTemplateManagementClient,
  createTemplateManagementClient,
} from "./index.js";

describe("template management client", () => {
  it("exposes only retained upstream operations through the templates extension", async () => {
    const invoke = vi.fn().mockImplementation(async (_extension, method) =>
      method === "inspect"
        ? {
            pin: {
              url: "https://example.com/base.git",
              ref: "refs/tags/v1",
              commit: "1".repeat(40),
              snapshot: `v1-sha256:${"2".repeat(64)}`,
            },
            repositories: [],
            files: [],
          }
        : method === "authoringParts"
          ? []
          : null,
    );
    const client = createTemplateManagementClient(invoke);
    await client.inspect({ url: "https://example.com/base.git" });
    await client.authoringParts();
    expect(invoke.mock.calls.map(([, method]) => method)).toEqual([
      "inspect",
      "authoringParts",
    ]);
    expect(
      invoke.mock.calls.every(
        ([extension]) => extension === "@workspace-extensions/templates",
      ),
    ).toBe(true);
  });
});

it("resolves moving URLs once and sends every exact pin to the host owner", async () => {
  const pin = {
    url: "https://example.invalid/dirty.git",
    ref: "refs/heads/main",
    commit: "a".repeat(40),
    snapshot: `v1-sha256:${"b".repeat(64)}` as const,
  };
  const invoke = vi.fn(async (_extension, method) => {
    if (method === "resolveSource") return pin;
    throw new Error(`Unexpected extension method: ${method}`);
  });
  const callHost = vi.fn(async () => ({ pin, repositories: [], files: [] }));
  const client = createShellTemplateManagementClient(invoke, callHost);

  await client.inspect({ url: pin.url });
  await client.inspect({ pin });

  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith(
    "@workspace-extensions/templates",
    "resolveSource",
    [{ url: pin.url }],
  );
  expect(callHost).toHaveBeenNthCalledWith(
    1,
    "workspaceTemplateSource",
    "inspectExact",
    [pin],
  );
  expect(callHost).toHaveBeenNthCalledWith(
    2,
    "workspaceTemplateSource",
    "inspectExact",
    [pin],
  );
});
