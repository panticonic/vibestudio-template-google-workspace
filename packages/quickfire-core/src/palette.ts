/**
 * The palette's pure projection: query + mode + context → rendered groups, and
 * a row id → what activating it means (quickfire-overlay-spec §4.1, §7.1).
 *
 * Extracted from `QuickfireOwner` so the desktop overlay and the mobile command
 * sheet rank and group identically. Ranking itself belongs to
 * `@workspace/omnibox-core`; this module only decides which sources a mode
 * consults, what a row looks like, and what its id resolves to.
 */
import {
  browserUrlFromEntry,
  buildArgSuggestions,
  buildCommandSuggestions,
  findMatchRanges,
  groupOmniboxSuggestions,
  isLikelyAgentPrompt,
  rankHistorySuggestions,
  textMatchScore,
  MATCH_PREFIX,
  activeArgSpec,
  type ArgSession,
  type CommandSpec,
  type OmniboxKind,
  type SurfaceContext,
} from "@workspace/omnibox-core";
import type { BrowserAddressSuggestion } from "@vibestudio/shared/panelChrome";
import {
  QUICKFIRE_MODE_PREFIX,
  type QuickfireGroup,
  type QuickfireMode,
  type QuickfireRow,
} from "./model";

/** Which suggestion kinds a mode shows, in display order. */
export const QUICKFIRE_MODE_GROUP_ORDER: Record<QuickfireMode, OmniboxKind[]> = {
  // `chat` leads the mixed scope because the only chat row it ever produces is
  // the quickfire ask row, and that row is emitted exactly when asking is the
  // likely intent (§4.1) — so it must be the default Enter target, not a
  // footnote under commands that matched nothing.
  all: ["chat", "command", "panel", "history", "url", "option"],
  commands: ["command", "option"],
  goto: ["panel", "history", "url", "command", "chat", "option"],
  quickfire: ["chat", "command", "panel", "history", "url", "option"],
};

export const QUICKFIRE_MODE_PLACEHOLDER: Record<QuickfireMode, string> = {
  all: "Run a command, go to a panel, or ask…",
  commands: "Run a command…",
  goto: "Go to a panel or page…",
  quickfire: "Ask about this panel…",
};

/** What activating a row means. Row ids are the only channel between the two. */
export type QuickfireRowTarget =
  | { kind: "command"; command: CommandSpec }
  | { kind: "option"; value: string }
  | { kind: "panel"; panelId: string }
  | { kind: "url"; url: string }
  | { kind: "quickfire-slot"; slotId: string }
  /** Ask the agent bound to the current panel — the mixed scope's default. */
  | { kind: "quickfire-ask"; prompt: string }
  | { kind: "chat"; prompt: string };

/**
 * The go-to scope's one sub-scope: `@history: docs` searches recent pages only.
 *
 * `nav.history` needs to land the user *in* the palette narrowed to history
 * rather than run something, and the narrowing has to be visible and reversible
 * — a hidden flag on chrome state would leave the user in a scope with no way
 * to see or leave it. A literal token in the input is both: backspacing it
 * widens the scope back to all destinations, and it survives the surface's
 * local input ownership because it *is* the input.
 */
export const HISTORY_SCOPE_TOKEN = "history:";

export interface GotoScope {
  /** True when the history sub-scope token leads the query. */
  historyOnly: boolean;
  /** The query with the token removed — what the sources should search for. */
  query: string;
}

/** Split `history: docs` into the sub-scope flag and the residual query. */
export function parseGotoScope(query: string): GotoScope {
  const trimmed = query.trimStart();
  if (!trimmed.toLowerCase().startsWith(HISTORY_SCOPE_TOKEN)) {
    return { historyOnly: false, query };
  }
  return { historyOnly: true, query: trimmed.slice(HISTORY_SCOPE_TOKEN.length).trimStart() };
}

/** Drop the mode's prefix from the raw input, leaving the search query. */
export function stripModePrefix(value: string, mode: QuickfireMode): string {
  const prefix = QUICKFIRE_MODE_PREFIX[mode];
  return prefix && value.startsWith(prefix) ? value.slice(prefix.length).trimStart() : value;
}

/** A typed prefix is a mode switch; anything else keeps the current mode. */
export function modeForInput(value: string, current: QuickfireMode): QuickfireMode {
  const first = value[0];
  if (first === ">") return "commands";
  if (first === "@") return "goto";
  if (first === "/") return "quickfire";
  return current === "all" ? "all" : first === undefined ? current : "all";
}

/** The input value that selecting `mode` should produce, preserving the query. */
export function inputForMode(currentValue: string, from: QuickfireMode, to: QuickfireMode): string {
  return `${QUICKFIRE_MODE_PREFIX[to]}${stripModePrefix(currentValue, from)}`;
}

/** Only panels and commands complete inline; a URL or prompt is literal text. */
export function completionForRow(row: QuickfireRow): string | null {
  return row.id.startsWith("panel:") || row.id.startsWith("command:") ? row.title : null;
}

export function emptyMessageFor(input: {
  argSession: ArgSession | null;
  query: string;
}): string | null {
  if (input.argSession) return "No matching options — type a value and press Enter.";
  if (!input.query.trim()) return null;
  return `Nothing matches “${input.query.trim()}”.`;
}

export interface PaletteRowsInput {
  mode: QuickfireMode;
  /** Non-null while a command's arguments are being collected. */
  argSession: ArgSession | null;
  /** The query with the mode prefix already stripped. */
  query: string;
  ctx: SurfaceContext;
  commands: CommandSpec[];
  /**
   * Browser history/bookmark/session rows the client already fetched, ranked
   * here by `@workspace/omnibox-core` so the palette's "Recent pages" group and
   * `about/new`'s agree to the row.
   */
  history?: BrowserAddressSuggestion[];
  /** Row cap per source; both clients use the same budget. */
  limit?: number;
}

const DEFAULT_ROW_LIMIT = 12;

/** Everything the ranked engines produce, projected into display groups. */
/** Highlight ranges for a row title, using the address bar's own matcher. */
function ranges(title: string, query: string): { titleRanges?: ReturnType<typeof findMatchRanges> } {
  const found = findMatchRanges(title, query);
  return found ? { titleRanges: found } : {};
}

export function buildPaletteRows(input: PaletteRowsInput): QuickfireGroup[] {
  const { mode, argSession, ctx, commands } = input;
  const limit = input.limit ?? DEFAULT_ROW_LIMIT;

  if (argSession) {
    const arg = activeArgSpec(argSession);
    if (!arg) return [];
    const options = buildArgSuggestions(arg, argSession.query, ctx);
    if (!options.length) return [];
    return [
      {
        key: "option",
        label: arg.label,
        rows: options.map((option) => ({
          id: option.id,
          title: option.option.label,
          ...(option.option.meta ? { meta: option.option.meta } : {}),
        })),
      },
    ];
  }

  const suggestions: Array<{ kind: OmniboxKind; row: QuickfireRow }> = [];
  /** Set when an open panel's title matches the query at prefix strength or better. */
  let strongPanelMatch = false;
  const scope = mode === "goto" ? parseGotoScope(input.query) : { historyOnly: false, query: input.query };
  const trimmed = scope.query.trim();

  if (!scope.historyOnly && (mode === "all" || mode === "commands")) {
    for (const suggestion of buildCommandSuggestions({ query: trimmed, commands, ctx, limit })) {
      suggestions.push({
        kind: "command",
        row: {
          id: suggestion.id,
          title: suggestion.command.title,
          ...ranges(suggestion.command.title, trimmed),
          ...(suggestion.command.description ? { meta: suggestion.command.description } : {}),
          ...(suggestion.command.icon ? { icon: suggestion.command.icon } : {}),
          ...(suggestion.command.accelerator
            ? { accelerator: suggestion.command.accelerator }
            : {}),
          ...(suggestion.command.danger ? { danger: true } : {}),
          ...(suggestion.disabled ? { disabled: true } : {}),
        },
      });
    }
  }

  if (!scope.historyOnly && (mode === "all" || mode === "goto")) {
    // Titles are ranked, not merely filtered: a title-prefix hit beats a hit
    // buried in a source path, so the best panel is the row that ghost-completes
    // and the row Enter switches to. Tree order breaks ties, which keeps the
    // idle list (empty query) in the shape the sidebar shows.
    const scored = ctx.openPanels.entries.flatMap((entry, index) => {
      if (!trimmed) return [{ entry, index, score: 0 }];
      const score = Math.max(
        textMatchScore(trimmed, entry.title),
        // A source-path match is real but weaker than the visible title.
        textMatchScore(trimmed, entry.source) - 1
      );
      return score < 0 ? [] : [{ entry, index, score }];
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    // Typing a panel's name is a request to go there. When the query names one
    // that precisely, destinations lead the mixed scope so Enter switches to the
    // panel and the ghost completes its title — otherwise "Keyboard Shortcuts"
    // would run the same-named command instead of showing the panel you can see
    // in the sidebar.
    strongPanelMatch = (scored[0]?.score ?? -1) >= MATCH_PREFIX;
    for (const { entry } of scored.slice(0, limit)) {
      suggestions.push({
        kind: "panel",
        row: {
          id: `panel:${entry.id}`,
          title: entry.title,
          ...ranges(entry.title, trimmed),
          ...(entry.location ? { meta: entry.location } : { meta: entry.source }),
          icon: "▤",
          badge: "open",
        },
      });
    }
  }

  const typedUrl =
    !scope.historyOnly && (mode === "all" || mode === "goto") && trimmed
      ? browserUrlFromEntry(trimmed)
      : null;
  if (typedUrl) {
    suggestions.push({
      kind: "url",
      row: {
        id: `url:${typedUrl}`,
        title: typedUrl,
        meta: "Open in a new browser panel",
        icon: "🌐",
      },
    });
  }

  if (mode === "all" || mode === "goto") {
    // A page the user already typed in full is one destination, not two: the
    // literal URL row wins and the matching history row drops out, exactly as
    // `buildLauncherSuggestions` does it for `about/new`.
    const sameAsTyped = (url: string) =>
      typedUrl !== null && typedUrl.replace(/\/$/, "") === url.replace(/\/$/, "");
    for (const suggestion of rankHistorySuggestions(trimmed, input.history ?? [], limit)) {
      const { browser } = suggestion;
      if (sameAsTyped(browser.url)) continue;
      suggestions.push({
        kind: "history",
        row: {
          id: `history:${browser.url}`,
          title: browser.title || browser.url,
          ...ranges(browser.title || browser.url, trimmed),
          meta: browser.title ? browser.url : browser.source === "session" ? "open browser panel" : browser.source,
          icon: "🕘",
        },
      });
    }
  }

  // The mixed scope's fallback and its agentic fast path are one row (§4.1):
  // typed prose goes to the panel's agent, and so does anything that matched
  // nothing else. Without it, Enter on "why is this cut off?" had no target at
  // all and the palette silently did nothing.
  if (mode === "all" && trimmed && (isLikelyAgentPrompt(trimmed) || suggestions.length === 0)) {
    const panelTitle = ctx.focusedPanel?.title;
    const conversation = ctx.quickfire;
    suggestions.unshift({
      kind: "chat",
      row: {
        id: `ask:${trimmed}`,
        title: panelTitle ? `Ask about “${panelTitle}”` : "Ask about this panel",
        meta:
          conversation?.hasConversation && !conversation.promoted
            ? conversation.messageCount
              ? `Continues this panel's conversation · ${conversation.messageCount} messages`
              : "Continues this panel's conversation"
            : `Send “${trimmed}” to the agent bound to this panel`,
        icon: "✦",
      },
    });
  }

  if (!scope.historyOnly && mode === "quickfire" && trimmed) {
    suggestions.push({
      kind: "chat",
      row: {
        id: `chat:${trimmed}`,
        title: "Start a new chat panel",
        meta: `Send “${trimmed}” as the opening message`,
        icon: "✧",
      },
    });
  }

  const order =
    mode === "all" && strongPanelMatch
      ? (["chat", "panel", "command", "history", "url", "option"] as OmniboxKind[])
      : QUICKFIRE_MODE_GROUP_ORDER[mode];
  return groupOmniboxSuggestions(
    suggestions.map((entry) => ({ ...entry.row, kind: entry.kind })),
    order
  ).map((group) => ({
    key: group.kind,
    label: group.label,
    rows: group.items.map(({ kind: _kind, ...row }) => row),
  }));
}

/** Resolve every rendered row id back to what activating it does. */
export function buildRowTargets(
  groups: QuickfireGroup[],
  commands: CommandSpec[],
  options: { argSession: ArgSession | null }
): Map<string, QuickfireRowTarget> {
  const byId = new Map<string, CommandSpec>(commands.map((command) => [command.id, command]));
  const targets = new Map<string, QuickfireRowTarget>();
  for (const group of groups) {
    for (const row of group.rows) {
      if (row.id.startsWith("command:")) {
        const command = byId.get(row.id.slice("command:".length));
        if (command) targets.set(row.id, { kind: "command", command });
      } else if (row.id.startsWith("option:")) {
        // `option:<argName>:<value>` — the value may itself contain colons.
        if (options.argSession) {
          targets.set(row.id, { kind: "option", value: row.id.split(":").slice(2).join(":") });
        }
      } else if (row.id.startsWith("panel:")) {
        targets.set(row.id, { kind: "panel", panelId: row.id.slice("panel:".length) });
      } else if (row.id.startsWith("url:")) {
        targets.set(row.id, { kind: "url", url: row.id.slice("url:".length) });
      } else if (row.id.startsWith("history:")) {
        // A recent page is opened the same way a typed one is; only the row's
        // group and provenance differ.
        targets.set(row.id, { kind: "url", url: row.id.slice("history:".length) });
      } else if (row.id.startsWith("quickfire-slot:")) {
        targets.set(row.id, {
          kind: "quickfire-slot",
          slotId: row.id.slice("quickfire-slot:".length),
        });
      } else if (row.id.startsWith("ask:")) {
        targets.set(row.id, { kind: "quickfire-ask", prompt: row.id.slice("ask:".length) });
      } else if (row.id.startsWith("chat:")) {
        targets.set(row.id, { kind: "chat", prompt: row.id.slice("chat:".length) });
      }
    }
  }
  return targets;
}
