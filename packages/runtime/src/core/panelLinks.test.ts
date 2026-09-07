import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPanelDeepLink, buildPanelLink, buildPanelShareLink } from "./panelLinks.js";
import { parsePanelLocationLink } from "@vibestudio/shared/panelLocation";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { __vibestudioGatewayConfig?: unknown }).__vibestudioGatewayConfig;
});

describe("buildPanelLink", () => {
  it("keeps the selected workspace route prefix in browser panel links", () => {
    vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:43873" } });
    (
      globalThis as {
        __vibestudioGatewayConfig?: { serverUrl: string };
      }
    ).__vibestudioGatewayConfig = {
      serverUrl: "http://localhost:43873/_workspace/dev-123",
    };

    expect(buildPanelLink("about/server-logs")).toBe("/_workspace/dev-123/about/server-logs/");
  });

  it("fails loudly instead of navigating to the wrong workspace for invalid gateway config", () => {
    vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:43873" } });
    (
      globalThis as {
        __vibestudioGatewayConfig?: { serverUrl: string };
      }
    ).__vibestudioGatewayConfig = { serverUrl: "not a URL" };

    expect(() => buildPanelLink("about/server-logs")).toThrow();
  });

  it("preserves ref, state, focus, tree disposition, and layout placement in HTTP links", () => {
    expect(
      buildPanelLink("panels/chat", {
        ref: "state:abc",
        stateArgs: { prompt: "hello" },
        title: "Research",
        slug: "research",
        focus: false,
        disposition: "child",
        placement: { disposition: "side", preferredWidth: 640, minWidth: 440 },
      })
    ).toBe(
      "/panels/chat/?ref=state%3Aabc&stateArgs=%7B%22prompt%22%3A%22hello%22%7D&title=Research&slug=research&focus=false&disposition=child&placement=side&preferredWidth=640&minWidth=440"
    );
  });

  it("builds equivalent canonical deep and share links for the current workspace", () => {
    (
      globalThis as {
        __vibestudioGatewayConfig?: { serverUrl: string };
      }
    ).__vibestudioGatewayConfig = {
      serverUrl: "http://localhost:43873/_workspace/dev-123",
    };
    const options = {
      contextId: "ctx-1",
      stateArgs: { prompt: "hi" },
      title: "Research",
      slug: "research",
      disposition: "root" as const,
      placement: { disposition: "split-below" as const, minWidth: 480 },
    };
    for (const link of [
      buildPanelDeepLink("panels/chat", options),
      buildPanelShareLink("panels/chat", options),
    ]) {
      expect(parsePanelLocationLink(link)).toMatchObject({
        kind: "ok",
        location: {
          source: "panels/chat",
          workspace: "dev-123",
          contextId: "ctx-1",
          stateArgs: { prompt: "hi" },
          title: "Research",
          slug: "research",
          disposition: "root",
          placement: { disposition: "split-below", minWidth: 480 },
        },
      });
    }
  });

  it("uses the explicitly injected workspace when the mobile facade URL has no route prefix", () => {
    (
      globalThis as {
        __vibestudioGatewayConfig?: { serverUrl: string; workspace: string };
      }
    ).__vibestudioGatewayConfig = {
      serverUrl: "http://127.0.0.1:43873",
      workspace: "mobile-workspace",
    };
    expect(parsePanelLocationLink(buildPanelShareLink("about/server-logs"))).toMatchObject({
      kind: "ok",
      location: { workspace: "mobile-workspace" },
    });
  });
});
