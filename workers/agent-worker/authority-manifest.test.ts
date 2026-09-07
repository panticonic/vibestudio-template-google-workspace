import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface AuthorityRequest {
  capability: string;
  resource: { kind: string; key?: string; prefix?: string };
  tier: string;
  evidence?: string;
}

describe("agent-worker authority manifest", () => {
  it("keeps the generic agent independent of System phone provisioning", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    ) as {
      vibestudio: {
        authority: {
          requests: AuthorityRequest[];
          serviceRequests: Array<{ protocol: string; availability: string }>;
        };
      };
    };
    expect(manifest.vibestudio.authority.serviceRequests).not.toContainEqual({
      protocol: "vibestudio.phone-provisioning.v1",
      availability: "required",
    });
    expect(manifest.vibestudio.authority.serviceRequests).toContainEqual({
      protocol: "vibestudio.missions.v1",
      availability: "required",
    });
    expect(
      manifest.vibestudio.authority.requests.map(
        ({ capability }) => capability,
      ),
    ).not.toEqual(
      expect.arrayContaining(["mobile.devices.read", "mobile.provision"]),
    );
  });

  it("declares the internal workspace-state transport used by public panel helpers", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    ) as {
      vibestudio: { authority: { requests: AuthorityRequest[] } };
    };
    expect(manifest.vibestudio.authority.requests).toContainEqual({
      capability: "workspace-service:workspace.state",
      resource: { kind: "prefix", prefix: "" },
      tier: "gated",
      evidence: "intentional-broad",
    });
  });

  it("declares the redacted server-log capability that Quickfire binds at launch", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    ) as {
      vibestudio: { authority: { requests: AuthorityRequest[] } };
    };
    expect(manifest.vibestudio.authority.requests).toContainEqual({
      capability: "server-logs.read",
      resource: { kind: "prefix", prefix: "" },
      tier: "gated",
      evidence: "intentional-broad",
    });
  });

  it("declares the provider-bound test capability used by first-class verification", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    ) as {
      vibestudio: { authority: { requests: AuthorityRequest[] } };
    };
    expect(manifest.vibestudio.authority.requests).toContainEqual({
      capability: "userland:extensions/test-runner/native.code.execute-tests#*",
      resource: {
        kind: "exact",
        key: "native.code.tests:extension:@workspace-extensions/test-runner",
      },
      tier: "gated",
      evidence: "bounded-dynamic",
    });
  });
});
