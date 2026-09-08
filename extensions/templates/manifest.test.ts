import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("templates authority manifest", () => {
  it("keeps exact source inspection gated", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    );
    for (const method of ["inspect"]) {
      const declared = manifest.vibestudio.extension.methodAuthority[method];
      expect(declared.website.kind).toBe("eligible");
      expect(declared.effect.kind).toBe("userland-capability");
      const provided = manifest.vibestudio.authority.provides.find(
        (item: { name: string }) => item.name === declared.effect.capability,
      );
      expect(provided).toMatchObject({
        tier: "gated",
        sensitivity: "read",
        grantScopes: ["once", "session"],
      });
    }
  });
  it("exposes only retained upstream snapshot operations", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    );
    expect(Object.keys(manifest.vibestudio.extension.methodAuthority)).toEqual([
      "resolveSource",
      "inspect",
      "inspectAuthoring",
      "authoringParts",
      "publishAuthoring",
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
