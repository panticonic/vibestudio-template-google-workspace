/**
 * The address-bar suggestion pipeline (spec §0.1, §2.2, P6).
 *
 * This is the second omnibox the workspace used to have: it lived in
 * `@vibestudio/shared/panelChrome` and ranked the shell title bar and the
 * mobile address field while `launcherSuggestions` ranked `about/new`. P6
 * moved it here verbatim so there is exactly one package that ranks omnibox
 * input, rather than rewriting the address bar's behaviour — the address bar
 * is muscle memory, so its nuances (search-engine keywords, session/bookmark
 * rows, `parseAddressInput`'s panel-location grammar, match-range
 * highlighting) were ported rather than approximated.
 *
 * Its scoring still differs from `buildLauncherSuggestions`: the address bar
 * ranks by visit/typed counts through `mergeBrowserAddressSuggestions`, the
 * launcher by match tier. That difference is deliberate and now visible in one
 * place instead of two packages.
 */
import {
  mergeBrowserAddressSuggestions,
  parseAddressInput,
  DEFAULT_SEARCH_TEMPLATE,
  type AddressAction,
  type BrowserAddressSuggestion,
  type PanelSourceKind,
  type TextMatchRange,
} from "@vibestudio/shared/panelChrome";
import { filterPanelSourceSuggestions, type PanelSourceSuggestion } from "./panelSources";
export interface AddressAutocompleteBase {
  id: string;
  value: string;
  label: string;
  meta: string;
  iconKind: "globe" | "history" | "bookmark" | "search" | "panel" | "session";
  matchRanges?: {
    label?: TextMatchRange[];
    meta?: TextMatchRange[];
  };
  action: AddressAction;
}

export type AddressAutocompleteItem =
  | (AddressAutocompleteBase & {
      kind: "panel-source";
      panel: PanelSourceSuggestion;
    })
  | (AddressAutocompleteBase & {
      kind: "url" | "history" | "bookmark" | "session" | "search" | "search-engine";
      browser: BrowserAddressSuggestion;
    });

export function buildAddressAutocompleteItems(args: {
  kind: PanelSourceKind;
  input: string;
  panelSuggestions?: PanelSourceSuggestion[];
  browserSuggestions?: BrowserAddressSuggestion[];
  limit?: number;
  defaultSearchTemplate?: string;
}): AddressAutocompleteItem[] {
  const limit = args.limit ?? 8;
  if (args.kind === "panel") {
    return filterPanelSourceSuggestions(args.panelSuggestions ?? [], args.input, limit).map(
      (panel) => ({
        id: `panel-source:${panel.source}`,
        kind: "panel-source",
        value: panel.source,
        label: panel.source,
        meta: panel.title ? `${panel.kind} · ${panel.title}` : panel.kind,
        iconKind: "panel",
        matchRanges: {
          label: findMatchRanges(panel.source, args.input),
          meta: findMatchRanges(
            panel.title ? `${panel.kind} · ${panel.title}` : panel.kind,
            args.input
          ),
        },
        action: { type: "panel-source", source: panel.source },
        panel,
      })
    );
  }

  const items: AddressAutocompleteItem[] = [];
  const input = args.input.trim();
  const defaultSearchTemplate =
    args.browserSuggestions?.find(
      (item) => item.source === "search-engine" && item.typedCount === 1 && item.searchTemplate
    )?.searchTemplate ??
    args.defaultSearchTemplate ??
    DEFAULT_SEARCH_TEMPLATE;
  if (input) {
    const parsed = parseAddressInput(input);
    if (parsed?.type === "browser-url") {
      items.push(
        browserItem({
          kind: "url",
          browser: { url: parsed.url, source: "history" },
          label: `Go to ${parsed.url}`,
          meta: parsed.url,
          iconKind: "globe",
          query: input,
          action: { type: "navigate-url", url: parsed.url, recordAsTyped: true },
        })
      );
    } else if (parsed?.type === "panel-location") {
      items.push(
        browserItem({
          kind: "url",
          browser: { url: input, source: "session" },
          label: `Open ${parsed.location.source}`,
          meta: "Vibestudio panel location",
          iconKind: "panel",
          query: input,
          action: { type: "panel-location", location: parsed.location, raw: input },
        })
      );
    } else {
      const searchQuery = parsed?.type === "search" ? parsed.query : input;
      items.push(
        browserItem({
          kind: "search",
          browser: {
            url: defaultSearchTemplate,
            title: searchQuery,
            source: "search-engine",
            searchTemplate: defaultSearchTemplate,
          },
          label: `Search ${searchQuery}`,
          meta: "default search",
          iconKind: "search",
          query: input,
          action: {
            type: "search",
            query: searchQuery,
            template: defaultSearchTemplate,
            recordAsTyped: true,
          },
        })
      );
    }
  }

  const keywordRows = buildKeywordSearchRows(args.browserSuggestions ?? [], input);
  const ranked = mergeBrowserAddressSuggestions(
    [args.browserSuggestions ?? []],
    input,
    Math.max(limit * 2, limit)
  )
    .filter((item) => item.source !== "search-engine")
    .slice(0, Math.max(0, limit - items.length - keywordRows.length));

  items.push(...keywordRows.slice(0, Math.max(0, limit - items.length)));
  items.push(
    ...ranked.map((browser) => {
      const kind =
        browser.source === "session"
          ? "session"
          : browser.source === "bookmark"
            ? "bookmark"
            : "history";
      const label = browser.title || browser.url;
      const meta = browser.title
        ? browser.url
        : browser.source === "session"
          ? "open browser panel"
          : browser.source;
      return browserItem({
        kind,
        browser,
        label,
        meta,
        iconKind:
          browser.source === "session"
            ? "session"
            : browser.source === "bookmark"
              ? "bookmark"
              : "history",
        query: input,
        action: { type: "navigate-url", url: browser.url },
      });
    })
  );
  return items.slice(0, limit);
}

function browserItem(args: {
  kind: Extract<
    AddressAutocompleteItem["kind"],
    "url" | "history" | "bookmark" | "session" | "search" | "search-engine"
  >;
  browser: BrowserAddressSuggestion;
  label: string;
  meta: string;
  iconKind: AddressAutocompleteBase["iconKind"];
  query: string;
  action: AddressAction;
}): AddressAutocompleteItem {
  return {
    id: `${args.kind}:${actionValue(args.action, args.browser.url)}:${args.label}`,
    kind: args.kind,
    value: actionValue(args.action, args.browser.url),
    label: args.label,
    meta: args.meta,
    iconKind: args.iconKind,
    matchRanges: {
      label: findMatchRanges(args.label, args.query),
      meta: findMatchRanges(args.meta, args.query),
    },
    action: args.action,
    browser: args.browser,
  };
}

function actionValue(action: AddressAction, fallback: string): string {
  if (action.type === "navigate-url") return action.url;
  if (action.type === "search" || action.type === "keyword-search") return action.query;
  if (action.type === "panel-source") return action.source;
  return fallback;
}

function buildKeywordSearchRows(
  suggestions: BrowserAddressSuggestion[],
  input: string
): AddressAutocompleteItem[] {
  const [keyword, ...queryParts] = input.trim().split(/\s+/);
  const query = queryParts.join(" ").trim();
  if (!keyword || !query) return [];
  return suggestions
    .filter(
      (item) =>
        item.source === "search-engine" &&
        item.keyword === keyword &&
        item.searchTemplate &&
        item.engineId !== undefined
    )
    .slice(0, 3)
    .map((engine) =>
      browserItem({
        kind: "search-engine",
        browser: engine,
        label: `Search ${engine.engineName ?? engine.title ?? keyword} for ${query}`,
        meta: `${keyword} search`,
        iconKind: "search",
        query: input,
        action: {
          type: "keyword-search",
          engineId: engine.engineId!,
          query,
          template: engine.searchTemplate!,
          recordAsTyped: true,
        },
      })
    );
}

/**
 * Where a query occurs in a label, for highlighting.
 *
 * Exported because the command palette highlights the same way the address bar
 * does; two implementations of "which characters matched" would drift into two
 * different ideas of what matched.
 */
export function findMatchRanges(text: string, query: string): TextMatchRange[] | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;
  const haystack = text.toLowerCase();
  const ranges: TextMatchRange[] = [];
  let start = 0;
  while (start < haystack.length) {
    const index = haystack.indexOf(needle, start);
    if (index === -1) break;
    ranges.push({ start: index, end: index + needle.length });
    start = index + needle.length;
  }
  return ranges.length ? ranges : undefined;
}
