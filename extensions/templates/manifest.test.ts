import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("templates authority manifest", () => {
  it("exposes only retained upstream snapshot operations", () => {
    const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    expect(Object.keys(manifest.vibestudio.extension.methodAuthority)).toEqual([
      "catalog", "inspect", "inspectAuthoring", "authoringParts", "publishAuthoring", "suggestRegistryEntry",
    ]);
    expect(JSON.stringify(manifest)).not.toContain("context.boundary");
    expect(JSON.stringify(manifest)).not.toContain("workspace.storage.delete");
    expect(manifest.vibestudio.authority.requests).toEqual(
      expect.arrayContaining([
        {
          capability: "network.response.read",
          resource: { kind: "origin", origin: "https://github.com" },
          tier: "gated",
          evidence: "bounded-dynamic",
        },
        {
          capability: "network.response.read",
          resource: { kind: "prefix", prefix: "" },
          tier: "gated",
          evidence: "intentional-broad",
        },
      ]),
    );
  });
});
