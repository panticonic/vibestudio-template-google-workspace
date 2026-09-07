import { describe, expect, it } from "vitest";
import manifest from "./package.json";

describe("chat panel authority", () => {
  it("declares the Missions service used by the automation inspector", () => {
    expect(
      manifest.vibestudio.authority.serviceRequests.find(
        (request) => request.protocol === "vibestudio.missions.v1"
      )
    ).toEqual({
      protocol: "vibestudio.missions.v1",
      availability: "required",
    });
    expect(
      manifest.vibestudio.authority.requests.find(
        (request) => request.capability === "workspace-service:missions"
      )
    ).toEqual({
      capability: "workspace-service:missions",
      resource: {
        kind: "exact",
        key: "do:workers/missions:MissionsDO:workspace-missions",
      },
      tier: "gated",
      evidence: "exact",
    });
  });

  it("can request approval to configure an OAuth client from client eval", () => {
    expect(
      manifest.vibestudio.authority.requests.find(
        (request) => request.capability === "account-providers.configure"
      )
    ).toEqual({
      capability: "account-providers.configure",
      resource: { kind: "exact", key: "account-providers.configure" },
      tier: "gated",
      evidence: "exact",
    });
  });

  it("can request a destination-scoped external browser approval from client eval", () => {
    expect(
      manifest.vibestudio.authority.requests.find(
        (request) => request.capability === "external.open"
      )
    ).toEqual({
      capability: "external.open",
      resource: { kind: "prefix", prefix: "" },
      tier: "gated",
      evidence: "intentional-broad",
    });
  });
});
