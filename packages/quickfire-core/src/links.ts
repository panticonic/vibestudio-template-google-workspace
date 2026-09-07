/**
 * What a link in agent prose means, and what opening it should do.
 *
 * One policy, three consumers: the Markdown projection asks it whether a
 * destination is worth rendering as a link at all, and each client's owner asks
 * it what to actually open. Before this, the overlay's answer was "http(s) or
 * nothing" — so `/panels/editor/`, the shape `buildPanelLink` produces, was
 * silently flattened to plain text, and an http link fell through to an
 * `<a target="_blank">` in a `WebContentsView` with no window-open handler.
 *
 * The classification itself is not ours: `parseAddressInput` is the same
 * address-bar grammar the title bar and the mobile address field use, so a link
 * an agent writes and a link a person types resolve identically.
 */

import { parseAddressInput } from "@vibestudio/shared/panelChrome";
import type { PanelLocation } from "@vibestudio/shared/panelLocation";

export type QuickfireLinkTarget =
  /** A full panel link: source plus ref/context/state/placement. */
  | { kind: "panel-location"; location: PanelLocation }
  /** A bare workspace source, e.g. `panels/editor` or `about/help`. */
  | { kind: "panel-source"; source: string }
  /** Something a browser panel should show. */
  | { kind: "browser-url"; url: string }
  /** `mailto:`/`tel:` and friends — the OS opens these, not us. */
  | { kind: "external"; url: string };

/**
 * Resolve a Markdown destination, or `null` when it names nothing this
 * workspace can open.
 *
 * `null` covers relative document paths (`./notes.md`), bare words, and
 * refused schemes (`javascript:`, `file:`). Those keep their text and lose
 * their link — an underlined thing that does nothing is worse than prose.
 */
export function classifyQuickfireLink(href: string): QuickfireLinkTarget | null {
  const raw = href.trim();
  if (!raw) return null;
  // Never linkify prose. `parseAddressInput` falls back to a web search for
  // anything it cannot resolve, which is right for a typed address bar and
  // wrong for a destination someone wrote down.
  if (/^(?:mailto:|tel:)/iu.test(raw)) return { kind: "external", url: raw };

  const parsed = parseAddressInput(raw);
  if (!parsed) return null;
  switch (parsed.type) {
    case "panel-location":
      return { kind: "panel-location", location: parsed.location };
    case "panel-source":
      return { kind: "panel-source", source: parsed.source };
    case "browser-url":
      return { kind: "browser-url", url: parsed.url };
    case "search":
      return null;
  }
}

/** Whether a destination should render as a link rather than as plain text. */
export function isOpenableLink(href: string): boolean {
  return classifyQuickfireLink(href) !== null;
}
