import { describe, expect, it, vi } from "vitest";
import { createTemplateManagementClient } from "./index.js";

describe("template management client", () => {
  it("exposes only retained upstream operations through the templates extension", async () => {
    const invoke = vi.fn().mockImplementation(async (_extension, method) => method === "inspect"
      ? { pin: { url: "https://example.com/base.git", ref: "refs/tags/v1", commit: "1".repeat(40), snapshot: `v1-sha256:${"2".repeat(64)}` }, repositories: [], files: [] }
      : method === "authoringParts" ? [] : null);
    const client = createTemplateManagementClient(invoke);
    await client.catalog({ refresh: true });
    await client.inspect({ url: "https://example.com/base.git" });
    await client.authoringParts();
    expect(invoke.mock.calls.map(([, method]) => method)).toEqual(["catalog", "inspect", "authoringParts"]);
    expect(invoke.mock.calls.every(([extension]) => extension === "@workspace-extensions/templates")).toBe(true);
  });
});
