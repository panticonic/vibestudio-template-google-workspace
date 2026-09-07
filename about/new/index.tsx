/** One keyboard-first launcher for panels, browser destinations, and Agentic Chat. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Box, Button, Callout, Flex, Spinner, Text } from "@radix-ui/themes";
import {
  ClockIcon,
  EnterIcon,
  ExclamationTriangleIcon,
  GlobeIcon,
  MagicWandIcon,
  MagnifyingGlassIcon,
  PlusIcon,
} from "@radix-ui/react-icons";
import {
  browserData,
  buildPanelLink,
  panel,
  panelTree,
  workers,
  workspace,
} from "@workspace/runtime";
import type { PanelHandle } from "@workspace/runtime";
import {
  canonicalizeUrlForAddress,
  normalizeBrowserAddressSuggestions,
  type BrowserAddressSuggestion,
} from "@vibestudio/shared/panelChrome";
import { isReviewPending } from "@vibestudio/shared/authority/reviewPending";
import { unitIconTarget } from "@vibestudio/shared/panel/assetPathPolicy";
import type { PanelSourceUsage } from "@vibestudio/shared/panelSearchTypes";
import { useIsMobile } from "@workspace/react/responsive";
import { AboutPage, AboutThemeRoot } from "../../packages/about-shared/ui";
import {
  autocompleteForSuggestion,
  browserUrlFromEntry,
  buildIdleLauncherSuggestions,
  buildLauncherSuggestions,
  collectLaunchablePanelGroups,
  groupLauncherSuggestions,
  LAUNCHABLE_PANEL_CACHE_KEY,
  parseCachedLaunchablePanelGroups,
  parseLauncherInput,
  serializeLaunchablePanelGroups,
  type LauncherMode,
  type LauncherSuggestion,
  type LaunchablePanelGroups,
  type PanelUsage,
} from "@workspace/omnibox-core";
import "./launcher.css";

interface NavigationTarget {
  source: string;
  href?: string;
}

interface OpenPanel {
  id: string;
  title: string;
  source: string;
  canonicalSource: string;
  parentId: string | null;
  handle: PanelHandle;
}

type DisplaySuggestion = LauncherSuggestion & {
  /** Existing browser destination; activating it focuses rather than duplicates it. */
  openPanel?: OpenPanel;
  /** Workspace panel instances accompany, but never replace, the fresh-open action. */
  openPanels?: OpenPanel[];
};

type ModePrefix = "" | ">" | "@" | "/";

const PANEL_USAGE_CACHE_KEY = "vibestudio:new-panel-durable-usage";
const CATALOG_REVALIDATE_INTERVAL_MS = 30_000;
const BACKGROUND_REFRESH_DEADLINE_MS = 500;
const INSTANCE_EXPAND_DWELL_MS = 400;

/** With nothing typed there is no relevance signal, so lead with the workspace. */
const IDLE_GROUP_ORDER: LauncherSuggestion["kind"][] = [
  "panel",
  "history",
  "url",
  "chat",
];

/**
 * The unified prefix grammar (spec §1.2).
 *
 * `>` used to be this page's "panels only" scope. It now belongs to the
 * overlay palette's command slate, which this page does not have — so `@` is
 * the single "go to" scope over panels *and* history, `/` is chat, and bare is
 * everything. A typed `>` is still parsed as `@` for one release, with the
 * deprecation notice below saying so, rather than silently searching nothing.
 */
const MODES: Array<{
  prefix: Exclude<ModePrefix, "">;
  mode: LauncherMode;
  label: string;
}> = [
  { prefix: "@", mode: "goto", label: "Go to" },
  { prefix: "/", mode: "chat", label: "Chat" },
];

/** The retired panels-only prefix, kept working for one release. */
const DEPRECATED_PREFIX = ">";
const REPLACEMENT_PREFIX = "@";

/** Let the launcher paint and accept input before optional ranking data starts crossing RPC. */
function scheduleBackgroundRefresh(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(callback, {
      timeout: BACKGROUND_REFRESH_DEADLINE_MS,
    });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(callback, 0);
  return () => window.clearTimeout(id);
}

function readCachedPanelGroups(): LaunchablePanelGroups | null {
  try {
    return parseCachedLaunchablePanelGroups(
      localStorage.getItem(LAUNCHABLE_PANEL_CACHE_KEY),
    );
  } catch {
    return null;
  }
}

function cachePanelGroups(groups: LaunchablePanelGroups): void {
  try {
    localStorage.setItem(
      LAUNCHABLE_PANEL_CACHE_KEY,
      serializeLaunchablePanelGroups(groups),
    );
  } catch {
    // Catalog caching is optional; sourceTree remains authoritative.
  }
}

function readCachedPanelUsage(): PanelUsage {
  try {
    const cached = JSON.parse(
      localStorage.getItem(PANEL_USAGE_CACHE_KEY) ?? "null",
    ) as {
      version?: unknown;
      usage?: unknown;
    } | null;
    if (
      cached?.version !== 1 ||
      !cached.usage ||
      typeof cached.usage !== "object"
    )
      return {};
    return Object.fromEntries(
      Object.entries(cached.usage).filter(
        (entry): entry is [string, PanelUsage[string]] => {
          const value = entry[1] as Partial<PanelUsage[string]> | null;
          return (
            !!value &&
            typeof value.count === "number" &&
            Number.isFinite(value.count) &&
            typeof value.lastUsed === "number" &&
            Number.isFinite(value.lastUsed)
          );
        },
      ),
    );
  } catch {
    return {};
  }
}

function cachePanelUsage(usage: PanelUsage): void {
  try {
    localStorage.setItem(
      PANEL_USAGE_CACHE_KEY,
      JSON.stringify({ version: 1, usage }),
    );
  } catch {
    // This is only a warm-start projection of durable workspace state.
  }
}

function usageRecord(rows: PanelSourceUsage[]): PanelUsage {
  return Object.fromEntries(
    rows.map((row) => [
      row.source,
      { count: row.accessCount, lastUsed: row.lastAccessedAt },
    ]),
  );
}

async function readOpenPanels(
  onBatch?: (panels: OpenPanel[]) => void,
  knownRevision?: number | null,
): Promise<{ panels: OpenPanel[]; revision: number; unchanged: boolean }> {
  const found: OpenPanel[] = [];
  const pendingParents: string[] = [];
  let revision = 0;
  let unchanged = false;
  const readGroup = async (parentId?: string) => {
    let cursor: string | undefined;
    do {
      const page = parentId
        ? await panelTree.children(parentId, { cursor, limit: 200 })
        : await panelTree.roots({ cursor, limit: 200 });
      if (!parentId && cursor === undefined) {
        revision = page.revision;
        if (knownRevision === revision) {
          unchanged = true;
          return;
        }
      }
      const batch: OpenPanel[] = [];
      for (const entry of page.entries) {
        const source = entry.handle.source;
        const openPanel: OpenPanel = {
          id: entry.node.slotId,
          title: entry.handle.title,
          source,
          canonicalSource:
            entry.handle.kind === "browser"
              ? (canonicalizeUrlForAddress(source) ?? source)
              : source,
          parentId: entry.handle.parentId,
          handle: entry.handle,
        };
        found.push(openPanel);
        batch.push(openPanel);
        if (entry.node.childCount > 0) pendingParents.push(entry.node.slotId);
      }
      if (batch.length) onBatch?.(batch);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && found.length < 2_000);
  };
  await readGroup();
  if (unchanged) return { panels: [], revision, unchanged: true };
  while (pendingParents.length && found.length < 2_000)
    await readGroup(pendingParents.shift()!);
  return { panels: found, revision, unchanged: false };
}

function destinationSource(suggestion: LauncherSuggestion): string | null {
  if (suggestion.kind === "panel") return suggestion.panel.path;
  if (suggestion.kind === "history")
    return canonicalizeUrlForAddress(suggestion.browser.url);
  if (suggestion.kind === "url")
    return canonicalizeUrlForAddress(suggestion.url);
  return null;
}

/** The row's primary line: what the destination is, never how to reach it. */
function suggestionLabel(suggestion: LauncherSuggestion): string {
  if (suggestion.kind === "panel") return suggestion.panel.title;
  if (suggestion.kind === "history")
    return suggestion.browser.title || suggestion.browser.url;
  if (suggestion.kind === "url") return suggestion.url;
  return "Start a new Agentic Chat";
}

/** The row's secondary line: where it leads or what activating it will do. */
function suggestionMeta(suggestion: DisplaySuggestion): string {
  if (suggestion.kind === "panel")
    return suggestion.panel.description ?? suggestion.panel.path;
  if (suggestion.kind === "history") return suggestion.browser.url;
  if (suggestion.kind === "url") return "Open in a new browser panel";
  return `Send “${suggestion.prompt}” as the opening message`;
}

function activationLabel(suggestion: DisplaySuggestion | undefined): string {
  if (!suggestion) return "Open";
  if (suggestion.kind === "panel" && suggestion.openPanels?.length)
    return "Open new";
  if (suggestion.openPanel) return "Focus";
  return suggestion.kind === "chat" ? "Send" : "Open";
}

function SuggestionIcon({
  suggestion,
  favicon,
}: {
  suggestion: LauncherSuggestion;
  favicon?: string;
}) {
  const panelIcon =
    suggestion.kind === "panel" ? suggestion.panel.icon : undefined;
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [panelIcon]);
  if (suggestion.kind === "panel") {
    if (panelIcon?.startsWith("./") && !imageFailed) {
      return (
        <img
          className="launcher-icon launcher-image-icon"
          src={`${buildPanelLink(suggestion.panel.path)}../../${unitIconTarget(
            suggestion.panel.path,
            panelIcon,
            suggestion.panel.iconVersion,
          )}`}
          alt=""
          aria-hidden="true"
          onError={() => setImageFailed(true)}
        />
      );
    }
    return (
      <span className="launcher-icon launcher-semantic-icon" aria-hidden="true">
        {panelIcon?.startsWith("./") ? "🧩" : (panelIcon ?? "🧩")}
      </span>
    );
  }
  if (suggestion.kind === "chat") {
    return (
      <span className="launcher-icon launcher-icon-chat" aria-hidden="true">
        <MagicWandIcon width={16} height={16} />
      </span>
    );
  }
  return (
    <span className="launcher-icon" aria-hidden="true">
      {favicon ? (
        <img src={favicon} alt="" />
      ) : suggestion.kind === "history" ? (
        <ClockIcon width={16} height={16} />
      ) : (
        <GlobeIcon width={16} height={16} />
      )}
    </span>
  );
}

function LauncherNotice({
  color,
  children,
}: {
  color: "orange" | "red";
  children: ReactNode;
}) {
  return (
    <Callout.Root color={color} size="1" variant="surface">
      <Callout.Icon>
        <ExclamationTriangleIcon />
      </Callout.Icon>
      <Flex align="center" gap="3" wrap="wrap">
        {children}
      </Flex>
    </Callout.Root>
  );
}

function SuggestionRow({
  suggestion,
  selected,
  expanded,
  pendingId,
  disabled,
  favicon,
  onSelect,
  onActivate,
  onFocusExisting,
  onToggleExisting,
}: {
  suggestion: DisplaySuggestion;
  selected: boolean;
  expanded: boolean;
  pendingId: string | null;
  disabled: boolean;
  favicon?: string;
  onSelect: () => void;
  onActivate: () => void;
  onFocusExisting: (openPanel: OpenPanel) => void;
  onToggleExisting: () => void;
}) {
  const pending = pendingId === suggestion.id;
  const openPanels =
    suggestion.kind === "panel" ? (suggestion.openPanels ?? []) : [];
  const body = (
    <>
      <SuggestionIcon suggestion={suggestion} favicon={favicon} />
      <span className="launcher-row-text">
        <span className="launcher-title">{suggestionLabel(suggestion)}</span>
        <span className="launcher-meta">{suggestionMeta(suggestion)}</span>
      </span>
      <span className="launcher-row-trailing">
        {suggestion.openPanel ? (
          <span className="launcher-open-badge">Already open</span>
        ) : null}
        {pending ? (
          <Spinner size="1" />
        ) : selected ? (
          <span className="launcher-enter">
            ↵ {activationLabel(suggestion)}
          </span>
        ) : null}
      </span>
    </>
  );
  const shared = {
    className: "launcher-row",
    id: `launcher-${suggestion.id}`,
    role: "option",
    "aria-selected": selected,
    "aria-expanded": openPanels.length ? expanded : undefined,
    "aria-disabled": disabled || undefined,
    onMouseMove: onSelect,
  };

  // A panel destination is a real link, so the usual browser gestures — middle
  // click, modifier click, copy address — keep working. Everything else is a
  // command with no addressable target.
  const href =
    suggestion.kind === "panel"
      ? buildPanelLink(suggestion.panel.path)
      : undefined;
  const primary = href ? (
    <a
      {...shared}
      href={href}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        if (!disabled) onActivate();
      }}
    >
      {body}
    </a>
  ) : (
    <button {...shared} type="button" disabled={disabled} onClick={onActivate}>
      {body}
    </button>
  );

  return (
    <div className="launcher-row-shell" data-expanded={expanded || undefined}>
      <div className="launcher-row-primary">
        {primary}
        {openPanels.length ? (
          <button
            type="button"
            className="launcher-open-disclosure"
            aria-label={`${expanded ? "Hide" : "Show"} ${openPanels.length} open ${suggestionLabel(
              suggestion,
            )} ${openPanels.length === 1 ? "panel" : "panels"}`}
            aria-expanded={expanded}
            disabled={disabled}
            onClick={onToggleExisting}
          >
            <span>{openPanels.length} open</span>
            <span
              className="launcher-open-disclosure-chevron"
              aria-hidden="true"
            >
              {expanded ? "⌃" : "⌄"}
            </span>
          </button>
        ) : null}
      </div>
      {expanded ? (
        <div
          className="launcher-open-instances"
          aria-label={`Open ${suggestionLabel(suggestion)} panels`}
        >
          <div className="launcher-open-instances-heading">
            <span>
              <strong>Already open</strong>
              <span>Choose an instance, or press Enter to open another.</span>
            </span>
          </div>
          <div className="launcher-open-instance-list">
            {openPanels.map((openPanel, index) => {
              const instancePending = pendingId === `existing:${openPanel.id}`;
              return (
                <button
                  key={openPanel.id}
                  type="button"
                  className="launcher-open-instance"
                  disabled={disabled}
                  aria-label={`Go to ${openPanel.title || suggestionLabel(suggestion)}, ${
                    openPanel.parentId ? "nested panel" : "top-level panel"
                  }`}
                  onClick={() => onFocusExisting(openPanel)}
                >
                  <span
                    className="launcher-open-instance-index"
                    aria-hidden="true"
                  >
                    {index + 1}
                  </span>
                  <span className="launcher-open-instance-text">
                    <span className="launcher-open-instance-title">
                      {openPanel.title || suggestionLabel(suggestion)}
                    </span>
                    <span className="launcher-open-instance-meta">
                      {openPanel.parentId ? "Nested panel" : "Top-level panel"}
                    </span>
                  </span>
                  <span className="launcher-open-instance-action">
                    {instancePending ? <Spinner size="1" /> : "Go there →"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NewPanelPage() {
  const isMobile = useIsMobile();
  const [panelGroups, setPanelGroups] = useState<LaunchablePanelGroups | null>(
    readCachedPanelGroups,
  );
  const [loading, setLoading] = useState(panelGroups === null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [panelUsage, setPanelUsage] =
    useState<PanelUsage>(readCachedPanelUsage);
  const [openPanels, setOpenPanels] = useState<OpenPanel[]>([]);
  const [browserSuggestions, setBrowserSuggestions] = useState<
    BrowserAddressSuggestion[]
  >([]);
  const [hasBrowserData, setHasBrowserData] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [historyReviewPending, setHistoryReviewPending] = useState(false);
  const [historyRefreshEpoch, setHistoryRefreshEpoch] = useState(0);
  const [favicons, setFavicons] = useState<Record<string, string | null>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resizeRafRef = useRef(0);
  const historyRequestRef = useRef(0);
  const faviconRequestRef = useRef(0);
  const selectionTouchedRef = useRef(false);
  const navigationStartedRef = useRef(false);
  const lastNavigationRef = useRef<NavigationTarget | null>(null);
  const lastExistingRef = useRef<{
    openPanel: OpenPanel;
    suggestionId: string;
  } | null>(null);
  const catalogFetchRef = useRef<Promise<void> | null>(null);
  const lastCatalogFetchRef = useRef(0);
  const liveRefreshRef = useRef(0);
  const liveRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const openTreeRevisionRef = useRef<number | null>(null);
  const catalogWasWarmAtMountRef = useRef(panelGroups !== null);

  const parsedInput = useMemo(() => parseLauncherInput(value), [value]);
  const browserUrl = useMemo(
    () =>
      parsedInput.mode === "all"
        ? browserUrlFromEntry(parsedInput.query)
        : null,
    [parsedInput],
  );

  const refreshCatalog = useCallback((force = false): Promise<void> => {
    if (catalogFetchRef.current) return catalogFetchRef.current;
    if (
      !force &&
      Date.now() - lastCatalogFetchRef.current < CATALOG_REVALIDATE_INTERVAL_MS
    ) {
      return Promise.resolve();
    }
    lastCatalogFetchRef.current = Date.now();
    const request = Promise.all([
      workspace.sourceTree(),
      workers.listServices(),
    ])
      .then(([tree, services]) => {
        setHasBrowserData(
          services.some((service) => service.name === "browser.data"),
        );
        const groups = collectLaunchablePanelGroups(tree.children);
        setPanelGroups(groups);
        cachePanelGroups(groups);
        setCatalogError(null);
      })
      .catch((cause: unknown) => {
        setCatalogError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        setLoading(false);
        if (catalogFetchRef.current === request) catalogFetchRef.current = null;
      });
    catalogFetchRef.current = request;
    return request;
  }, []);

  const refreshLiveData = useCallback(() => {
    if (liveRefreshInFlightRef.current) return;
    const refreshId = ++liveRefreshRef.current;
    // These are independent enhancements. Each publishes as soon as it
    // arrives, so neither can hold the catalog or input interaction back.
    const usageRequest = panelTree
      .sourceUsage(200)
      .then((rows) => {
        if (liveRefreshRef.current !== refreshId) return;
        const usage = usageRecord(rows);
        setPanelUsage(usage);
        cachePanelUsage(usage);
      })
      .catch(() => {
        // Keep the warm cache while the durable service recovers.
      });

    const topologyRequest = readOpenPanels((batch) => {
      if (liveRefreshRef.current !== refreshId) return;
      setOpenPanels((current) => {
        const merged = new Map(current.map((entry) => [entry.id, entry]));
        for (const entry of batch) merged.set(entry.id, entry);
        return [...merged.values()];
      });
    }, openTreeRevisionRef.current)
      .then((result) => {
        if (liveRefreshRef.current !== refreshId || result.unchanged) return;
        openTreeRevisionRef.current = result.revision;
        setOpenPanels(result.panels);
      })
      .catch(() => {
        // Awareness is progressive enhancement; launching remains available.
      });
    const refresh = Promise.allSettled([usageRequest, topologyRequest]).then(
      () => undefined,
    );
    liveRefreshInFlightRef.current = refresh;
    void refresh.finally(() => {
      if (liveRefreshInFlightRef.current === refresh)
        liveRefreshInFlightRef.current = null;
    });
  }, []);

  useEffect(() => {
    const cancelCatalogRefresh = catalogWasWarmAtMountRef.current
      ? scheduleBackgroundRefresh(() => void refreshCatalog(true))
      : (() => {
          void refreshCatalog(true);
          return () => {};
        })();
    let cancelLiveDataRefresh = scheduleBackgroundRefresh(refreshLiveData);
    const offFocus = panel.onFocus(() => {
      void refreshCatalog();
      cancelLiveDataRefresh();
      cancelLiveDataRefresh = scheduleBackgroundRefresh(refreshLiveData);
      // A first read can race workspace admission or BrowserData materialization.
      // Focus is level-triggered evidence that the launcher is active again, so
      // converge its history projection instead of preserving a stale failure.
      setHistoryRefreshEpoch((epoch) => epoch + 1);
    });
    const offNavigationError = panel.onChildCreationError(({ error }) => {
      navigationStartedRef.current = false;
      setPendingId(null);
      setNavigationError(error);
    });
    return () => {
      cancelCatalogRefresh();
      cancelLiveDataRefresh();
      offFocus();
      offNavigationError();
    };
  }, [refreshCatalog, refreshLiveData]);

  useEffect(() => {
    const requestId = ++historyRequestRef.current;
    if (!hasBrowserData || parsedInput.mode === "chat") {
      setBrowserSuggestions([]);
      setHistoryError(false);
      setHistoryReviewPending(false);
      return;
    }
    const timer = window.setTimeout(
      () => {
        const query = parsedInput.query.trim();
        const request = query
          ? browserData.searchHistoryForAutocomplete(query, 60)
          : browserData.getHistory({ limit: 60 });
        void request
          .then((rows) => {
            if (requestId !== historyRequestRef.current) return;
            setBrowserSuggestions(normalizeBrowserAddressSuggestions(rows));
            setHistoryError(false);
            setHistoryReviewPending(false);
          })
          .catch((error: unknown) => {
            if (requestId !== historyRequestRef.current) return;
            setBrowserSuggestions([]);
            const reviewPending = isReviewPending(error);
            setHistoryReviewPending(reviewPending);
            setHistoryError(!reviewPending);
            if (!reviewPending) {
              console.warn(
                "[new-panel] Canonical browser history query failed",
                error,
              );
            }
          });
      },
      parsedInput.query ? 100 : 0,
    );
    return () => clearTimeout(timer);
  }, [hasBrowserData, historyRefreshEpoch, parsedInput]);

  useEffect(() => {
    if (!historyReviewPending) return;
    const timer = window.setTimeout(
      () => setHistoryRefreshEpoch((epoch) => epoch + 1),
      2_000,
    );
    return () => clearTimeout(timer);
  }, [historyReviewPending, historyRefreshEpoch]);

  const baseSuggestions = useMemo(() => {
    const query = parsedInput.query.trim();
    if (!query) {
      return buildIdleLauncherSuggestions({
        value,
        panels: panelGroups?.panels ?? [],
        aboutPanels: panelGroups?.about ?? [],
        panelUsage,
        browserSuggestions,
        browserUrl,
      });
    }
    return buildLauncherSuggestions({
      value,
      panels: panelGroups ? [...panelGroups.panels, ...panelGroups.about] : [],
      panelUsage,
      browserSuggestions,
      browserUrl,
    });
  }, [
    browserSuggestions,
    browserUrl,
    panelGroups,
    panelUsage,
    parsedInput.query,
    value,
  ]);

  const groups = useMemo(
    () =>
      groupLauncherSuggestions<DisplaySuggestion>(
        baseSuggestions.map((suggestion) => {
          const source = destinationSource(suggestion);
          if (!source) return suggestion;
          const matches = openPanels.filter(
            (entry) =>
              entry.source === source || entry.canonicalSource === source,
          );
          if (!matches.length) return suggestion;
          return suggestion.kind === "panel"
            ? { ...suggestion, openPanels: matches }
            : { ...suggestion, openPanel: matches[0] };
        }),
        parsedInput.query.trim() ? undefined : IDLE_GROUP_ORDER,
      ),
    [baseSuggestions, openPanels, parsedInput],
  );

  // The keyboard walks exactly what the eye walks: grouped display order.
  const suggestions = useMemo(
    () => groups.flatMap((group) => group.items),
    [groups],
  );

  useEffect(() => {
    setSelectedId((current) => {
      if (
        selectionTouchedRef.current &&
        suggestions.some((item) => item.id === current)
      )
        return current;
      return suggestions[0]?.id ?? null;
    });
  }, [suggestions]);

  const selectedIndex = Math.max(
    0,
    suggestions.findIndex((item) => item.id === selectedId),
  );
  const selected =
    suggestions.find((item) => item.id === selectedId) ?? suggestions[0];
  const completion = autocompleteForSuggestion(value, selected);

  // Let a deliberate pause reveal live instances without making fast arrow-key
  // traversal accordion the whole list. Pointer/touch and keyboard users can
  // also disclose immediately through the badge or Right Arrow.
  useEffect(() => {
    setExpandedId(null);
    if (!selected?.openPanels?.length) return;
    const timer = window.setTimeout(
      () => setExpandedId(selected.id),
      INSTANCE_EXPAND_DWELL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [selected?.id, selected?.openPanels?.length]);

  useEffect(() => {
    if (!selected?.id) return;
    const option = document.getElementById(`launcher-${selected.id}`);
    if (typeof option?.scrollIntoView === "function")
      option.scrollIntoView({ block: "nearest" });
  }, [selected?.id]);

  useEffect(() => {
    if (!hasBrowserData) return;
    const urls = suggestions.flatMap((item) =>
      item.kind === "history"
        ? [item.browser.url]
        : item.kind === "url"
          ? [item.url]
          : [],
    );
    const missing = [...new Set(urls)]
      .filter((url) => !(url in favicons))
      .slice(0, 12);
    if (!missing.length) return;
    const requestId = ++faviconRequestRef.current;
    const timer = window.setTimeout(() => {
      void Promise.all(
        missing.map(async (url) => {
          try {
            const icon = await browserData.getPageFavicon(url);
            return [
              url,
              icon ? `data:${icon.mime_type};base64,${icon.image_data}` : null,
            ] as const;
          } catch {
            return [url, null] as const;
          }
        }),
      ).then((entries) => {
        if (requestId === faviconRequestRef.current)
          setFavicons((current) => ({
            ...current,
            ...Object.fromEntries(entries),
          }));
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [hasBrowserData, favicons, suggestions]);

  const maxInputHeight = isMobile ? 144 : 190;
  const resizeInput = useCallback(() => {
    cancelAnimationFrame(resizeRafRef.current);
    resizeRafRef.current = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, maxInputHeight)}px`;
    });
  }, [maxInputHeight]);
  // Programmatic edits (completion, mode toggles, clearing) resize too.
  useEffect(() => resizeInput(), [resizeInput, value]);
  useEffect(() => () => cancelAnimationFrame(resizeRafRef.current), []);

  const beginNavigation = useCallback(
    (target: NavigationTarget, id: string) => {
      if (navigationStartedRef.current) return;
      navigationStartedRef.current = true;
      lastNavigationRef.current = target;
      lastExistingRef.current = null;
      setPendingId(id);
      setNavigationError(null);
      if (target.href) {
        requestAnimationFrame(() => location.assign(target.href!));
        return;
      }
      void panel.reopen({ source: target.source }).catch((cause: unknown) => {
        navigationStartedRef.current = false;
        setPendingId(null);
        setNavigationError(
          cause instanceof Error ? cause.message : String(cause),
        );
      });
    },
    [],
  );

  const focusExisting = useCallback(
    (openPanel: OpenPanel, suggestionId: string) => {
      if (pendingId) return;
      lastExistingRef.current = { openPanel, suggestionId };
      lastNavigationRef.current = null;
      setPendingId(`existing:${openPanel.id}`);
      setNavigationError(null);
      void (async () => {
        await openPanel.handle.focus();
        // Choosing an existing destination completes the launcher's job. Retire
        // this transient about/new slot instead of leaving it behind in the tree.
        await panelTree.self().archive();
      })().catch((cause: unknown) => {
        setPendingId(null);
        setNavigationError(
          cause instanceof Error ? cause.message : String(cause),
        );
      });
    },
    [pendingId],
  );

  const activate = useCallback(
    (suggestion: DisplaySuggestion | undefined) => {
      if (!suggestion || pendingId) return;
      if (suggestion.kind !== "panel" && suggestion.openPanel) {
        setPendingId(suggestion.id);
        void suggestion.openPanel.handle.focus().catch((cause: unknown) => {
          setPendingId(null);
          setNavigationError(
            cause instanceof Error ? cause.message : String(cause),
          );
        });
        return;
      }
      if (suggestion.kind === "panel") {
        beginNavigation(
          {
            source: suggestion.panel.path,
            href: buildPanelLink(suggestion.panel.path),
          },
          suggestion.id,
        );
      } else if (suggestion.kind === "history") {
        beginNavigation({ source: suggestion.browser.url }, suggestion.id);
      } else if (suggestion.kind === "url") {
        beginNavigation({ source: suggestion.url }, suggestion.id);
      } else {
        beginNavigation(
          {
            source: "panels/chat",
            href: buildPanelLink("panels/chat", {
              stateArgs: { initialPrompt: suggestion.prompt },
            }),
          },
          suggestion.id,
        );
      }
    },
    [beginNavigation, pendingId],
  );

  const chooseOffset = (offset: number) => {
    if (!suggestions.length) return;
    selectionTouchedRef.current = true;
    const next =
      (selectedIndex + offset + suggestions.length) % suggestions.length;
    setSelectedId(suggestions[next]!.id);
  };

  const replaceInput = useCallback((next: string, caret = next.length) => {
    selectionTouchedRef.current = false;
    setSelectedId(null);
    setValue(next);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(caret, caret);
    });
  }, []);

  const toggleMode = (prefix: Exclude<ModePrefix, "">) =>
    replaceInput(
      parsedInput.prefix === prefix
        ? parsedInput.query
        : `${prefix}${parsedInput.query}`,
    );

  const actionLabel = activationLabel(selected);
  const showGhost = !!completion && !value.includes("\n");

  return (
    <AboutPage
      icon={<PlusIcon width={20} height={20} />}
      title="New Panel"
      subtitle="Jump to a panel, revisit a page, or ask an agent."
      maxWidth={720}
    >
      <Box className="launcher-search">
        <div className="launcher-field">
          <div className="launcher-entry">
            <MagnifyingGlassIcon
              className="launcher-entry-icon"
              width={18}
              height={18}
            />
            <div className="launcher-input-wrap">
              {showGhost ? (
                <div className="launcher-ghost" aria-hidden="true">
                  <span className="launcher-ghost-typed">{value}</span>
                  <span className="launcher-ghost-suffix">
                    {completion.suffix}
                  </span>
                </div>
              ) : null}
              <textarea
                ref={inputRef}
                className="launcher-input"
                autoFocus
                rows={1}
                role="combobox"
                aria-label="Search panels and history, enter a web address, or start a chat"
                aria-autocomplete="both"
                aria-expanded={suggestions.length > 0}
                aria-controls="launcher-suggestions"
                aria-activedescendant={
                  selected ? `launcher-${selected.id}` : undefined
                }
                enterKeyHint={selected?.kind === "chat" ? "send" : "go"}
                style={{ maxHeight: maxInputHeight }}
                placeholder="Panel, address, or ask an agent…"
                value={value}
                onChange={(event) => {
                  selectionTouchedRef.current = false;
                  setSelectedId(null);
                  setValue(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    chooseOffset(1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    chooseOffset(-1);
                  } else if (
                    (event.key === "Tab" || event.key === "ArrowRight") &&
                    completion
                  ) {
                    if (
                      event.key === "Tab" ||
                      inputRef.current?.selectionStart === value.length
                    ) {
                      event.preventDefault();
                      replaceInput(completion.value);
                    }
                  } else if (
                    event.key === "ArrowRight" &&
                    selected?.openPanels?.length
                  ) {
                    event.preventDefault();
                    setExpandedId(selected.id);
                  } else if (
                    event.key === "ArrowLeft" &&
                    expandedId === selected?.id
                  ) {
                    event.preventDefault();
                    setExpandedId(null);
                  } else if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    selected
                  ) {
                    event.preventDefault();
                    activate(selected);
                  } else if (event.key === "Escape" && value) {
                    event.preventDefault();
                    replaceInput("");
                  }
                }}
              />
            </div>
          </div>
          <div className="launcher-actions">
            <div className="launcher-modes" aria-label="Search scope">
              {MODES.map((mode) => (
                <button
                  key={mode.prefix}
                  type="button"
                  className="launcher-mode"
                  aria-pressed={parsedInput.mode === mode.mode}
                  onClick={() => toggleMode(mode.prefix)}
                >
                  <span className="launcher-key">{mode.prefix}</span>
                  {mode.label}
                </button>
              ))}
            </div>
            <Button
              size="2"
              onClick={() => activate(selected)}
              disabled={!selected || !!pendingId}
              style={{ flexShrink: 0 }}
            >
              {pendingId ? <Spinner size="1" /> : <EnterIcon />}
              {actionLabel}
            </Button>
          </div>
        </div>
        <p className="launcher-hint">
          {[
            { keys: ["↑", "↓"], label: "choose" },
            { keys: ["Tab"], label: "complete" },
            { keys: ["↵"], label: actionLabel.toLowerCase() },
            { keys: ["⇧", "↵"], label: "new line" },
          ].map((hint) => (
            <span key={hint.label} className="launcher-hint-item">
              {hint.keys.map((key) => (
                <kbd key={key} className="launcher-hint-key">
                  {key}
                </kbd>
              ))}
              {hint.label}
            </span>
          ))}
        </p>
      </Box>

      {catalogError ? (
        <LauncherNotice color={panelGroups ? "orange" : "red"}>
          <Text size="2">
            {panelGroups
              ? "Panel suggestions may be out of date."
              : "The panel catalog could not be loaded."}
          </Text>
          <Button
            size="1"
            variant="soft"
            onClick={() => void refreshCatalog(true)}
          >
            Retry
          </Button>
        </LauncherNotice>
      ) : null}
      {parsedInput.prefix === DEPRECATED_PREFIX ? (
        <LauncherNotice color="orange">
          <Text size="2">
            <code>&gt;</code> is now <code>@</code> — one &ldquo;go to&rdquo;
            scope for panels and recent pages. Searching there instead.
          </Text>
          <Button
            size="1"
            variant="soft"
            onClick={() =>
              replaceInput(`${REPLACEMENT_PREFIX}${parsedInput.query}`)
            }
          >
            Use @
          </Button>
        </LauncherNotice>
      ) : null}
      {historyError ? (
        <LauncherNotice color="orange">
          <Text size="2">History suggestions couldn&apos;t be loaded.</Text>
          <Button
            size="1"
            variant="soft"
            onClick={() => setHistoryRefreshEpoch((epoch) => epoch + 1)}
          >
            Retry
          </Button>
        </LauncherNotice>
      ) : null}
      {navigationError ? (
        <LauncherNotice color="red">
          <Text size="2">
            Couldn&apos;t open that destination: {navigationError}
          </Text>
          <Button
            size="1"
            variant="soft"
            color="red"
            onClick={() => {
              const existing = lastExistingRef.current;
              if (existing) {
                focusExisting(existing.openPanel, existing.suggestionId);
                return;
              }
              const target = lastNavigationRef.current;
              if (target && selected) beginNavigation(target, selected.id);
            }}
          >
            Try again
          </Button>
        </LauncherNotice>
      ) : null}

      {loading && !panelGroups && !suggestions.length ? (
        <Flex
          direction="column"
          gap="2"
          aria-busy="true"
          aria-label="Loading destinations"
        >
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="launcher-skeleton" />
          ))}
        </Flex>
      ) : suggestions.length ? (
        <div
          className="launcher-results"
          id="launcher-suggestions"
          role="listbox"
          aria-label="Destinations"
        >
          {groups.map((group) => (
            <section
              key={group.kind}
              role="group"
              aria-labelledby={`launcher-group-${group.kind}`}
            >
              <h2
                className="launcher-group-label"
                id={`launcher-group-${group.kind}`}
              >
                {group.label}
              </h2>
              <div className="launcher-group-items">
                {group.items.map((suggestion) => (
                  <SuggestionRow
                    key={suggestion.id}
                    suggestion={suggestion}
                    selected={suggestion.id === selected?.id}
                    expanded={suggestion.id === expandedId}
                    pendingId={pendingId}
                    disabled={!!pendingId}
                    favicon={
                      (suggestion.kind === "history"
                        ? favicons[suggestion.browser.url]
                        : suggestion.kind === "url"
                          ? favicons[suggestion.url]
                          : undefined) ?? undefined
                    }
                    onSelect={() => {
                      if (suggestion.id === selectedId) return;
                      selectionTouchedRef.current = true;
                      setSelectedId(suggestion.id);
                    }}
                    onActivate={() => activate(suggestion)}
                    onFocusExisting={(openPanel) =>
                      focusExisting(openPanel, suggestion.id)
                    }
                    onToggleExisting={() =>
                      setExpandedId((current) =>
                        current === suggestion.id ? null : suggestion.id,
                      )
                    }
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="launcher-empty">
          <Text size="2" color="gray">
            {parsedInput.prefix
              ? `Nothing in ${
                  MODES.find(
                    (mode) => mode.mode === parsedInput.mode,
                  )?.label.toLowerCase() ?? "this scope"
                } matches “${parsedInput.query}”.`
              : `Nothing matches “${parsedInput.query}”.`}
          </Text>
          <Flex gap="2" justify="center" wrap="wrap" mt="3">
            {parsedInput.prefix ? (
              <Button
                size="2"
                variant="soft"
                onClick={() => replaceInput(parsedInput.query)}
              >
                Search everything
              </Button>
            ) : null}
            {parsedInput.query.trim() ? (
              <Button
                size="2"
                variant="soft"
                onClick={() => replaceInput(`/${parsedInput.query.trim()}`)}
              >
                <MagicWandIcon />
                Ask an agent instead
              </Button>
            ) : null}
          </Flex>
        </div>
      )}
    </AboutPage>
  );
}

export default function AboutPanelRoot() {
  return (
    <AboutThemeRoot>
      <NewPanelPage />
    </AboutThemeRoot>
  );
}
