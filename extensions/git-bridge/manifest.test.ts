import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("git-bridge authority manifest", () => {
  it("requests both credential use and response access for smart HTTP", () => {
    const manifest = JSON.parse(
      fs.readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8")
    ) as {
      vibestudio?: {
        authority?: {
          requests?: Array<{
            capability?: string;
            resource?: { kind?: string; prefix?: string };
            tier?: string;
          }>;
        };
      };
    };
    const requests = manifest.vibestudio?.authority?.requests ?? [];

    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "credential.use",
          resource: { kind: "prefix", prefix: "" },
          tier: "gated",
        }),
        expect.objectContaining({
          capability: "network.response.read",
          resource: { kind: "prefix", prefix: "" },
          tier: "gated",
        }),
      ])
    );
  });
});
