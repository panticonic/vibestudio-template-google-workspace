import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { GIT_INTEROP_PROVIDER_METHOD_NAMES } from "@vibestudio/service-schemas/gitInterop";
import { activate } from "./index.js";
import { UpstreamEngine } from "./upstream.js";

describe("git-bridge activation surface", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps ordinary Git transport provider-owned and exposes only the userland template contribution venue", async () => {
    vi.spyOn(UpstreamEngine.prototype, "activate").mockResolvedValue(undefined);
    const rpc = { call: vi.fn(async () => ({ ok: true })) };
    const api = await activate({
      name: "@workspace-extensions/git-bridge",
      log: { info: vi.fn(), warn: vi.fn() },
      rpc,
    } as never);

    expect(Object.keys(api.providerContracts.gitInterop)).toEqual(
      GIT_INTEROP_PROVIDER_METHOD_NAMES
    );
    const manifest = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8")
    ) as {
      vibestudio: {
        extension: { providerContracts: { gitInterop: { methods: string[] } } };
      };
    };
    expect(manifest.vibestudio.extension.providerContracts.gitInterop.methods).toEqual(
      GIT_INTEROP_PROVIDER_METHOD_NAMES
    );
    expect(api).not.toHaveProperty("pushUpstream");
    expect(api).not.toHaveProperty("publishRepo");
    expect(api).toHaveProperty("suggestTemplateContribution");
    expect(api).toHaveProperty("suggestRegistryEntry");
  });

  it("routes notification actions directly through the owning Git engine", async () => {
    vi.spyOn(UpstreamEngine.prototype, "activate").mockResolvedValue(undefined);
    const push = vi.spyOn(UpstreamEngine.prototype, "pushUpstream").mockResolvedValue({
      exported: 0,
      headCommit: null,
      outcome: "already-at-remote",
    });
    const autoPush = vi.spyOn(UpstreamEngine.prototype, "setAutoPush").mockResolvedValue({});
    const rpc = { call: vi.fn(async () => ({ ok: true })) };
    const api = await activate({
      name: "@workspace-extensions/git-bridge",
      log: { info: vi.fn(), warn: vi.fn() },
      rpc,
    } as never);

    await api.retryUpstreamPush("projects/demo");
    await api.pauseAutoPush("projects/demo");

    expect(push).toHaveBeenCalledWith("projects/demo");
    expect(autoPush).toHaveBeenCalledWith("projects/demo", false);
    expect(rpc.call).not.toHaveBeenCalled();
  });
});
