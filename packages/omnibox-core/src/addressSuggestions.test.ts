/**
 * The address-bar pipeline's behaviour, moved with the code it covers (P6).
 *
 * These cases came verbatim from `packages/shared/src/panelChrome.test.ts`.
 * They are the parity contract for the title bar and the mobile address field:
 * the consolidation onto one omnibox package was explicitly not allowed to
 * change what the address bar suggests.
 */
import { describe, expect, it } from "vitest";
import { canonicalizeUrlForAddress } from "@vibestudio/shared/panelChrome";
import { buildAddressAutocompleteItems } from "./addressSuggestions";

describe("addressSuggestions", () => {
  it("builds platform-neutral autocomplete rows", () => {
    expect(
      buildAddressAutocompleteItems({
        kind: "panel",
        input: "chat",
        panelSuggestions: [{ source: "panels/chat", title: "Chat", kind: "launchable" }],
      })
    ).toEqual([
      expect.objectContaining({
        kind: "panel-source",
        value: "panels/chat",
        meta: "launchable · Chat",
      }),
    ]);

    expect(
      buildAddressAutocompleteItems({
        kind: "browser",
        input: "docs",
        browserSuggestions: [{ url: "https://example.com/docs", title: "Docs", source: "history" }],
      })
    ).toEqual([
      expect.objectContaining({
        kind: "search",
        action: expect.objectContaining({ type: "search" }),
      }),
      expect.objectContaining({
        kind: "history",
        value: "https://example.com/docs",
        label: "Docs",
        action: expect.objectContaining({ type: "navigate-url" }),
      }),
    ]);
  });

  it("keeps canonical panel locations as panel actions in browser autocomplete", () => {
    const items = buildAddressAutocompleteItems({
      kind: "browser",
      input: "vibestudio://panel?v=1&source=about%2Fserver-logs&disposition=root",
      browserSuggestions: [],
    });
    expect(items[0]).toMatchObject({
      label: "Open about/server-logs",
      iconKind: "panel",
      action: {
        type: "panel-location",
        location: { source: "about/server-logs", disposition: "root" },
      },
    });
  });

  it("pins synthetic rows and canonicalizes URL dedupe", () => {
    expect(canonicalizeUrlForAddress("HTTPS://Example.COM:443/path#top")).toBe(
      "https://example.com/path"
    );
    const items = buildAddressAutocompleteItems({
      kind: "browser",
      input: "example.com",
      browserSuggestions: [
        { url: "https://example.com/", title: "One", source: "history", visitCount: 1 },
        { url: "https://EXAMPLE.com/#fragment", title: "Two", source: "bookmark" },
      ],
    });
    expect(items[0]).toMatchObject({
      kind: "url",
      action: { type: "navigate-url", recordAsTyped: true },
    });
    expect(
      items.filter((item) => item.kind === "bookmark" || item.kind === "history")
    ).toHaveLength(1);
  });
});

