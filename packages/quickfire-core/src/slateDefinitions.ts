/**
 * The built-in command slate's *definitions* (quickfire-overlay-spec §3.2).
 *
 * What a command is — its id, title, match terms, section, icon, arguments,
 * availability predicate, and which surfaces it exists on — is one answer for
 * the whole workspace. What running it *does* is not: the desktop shell drives
 * Electron main and the mobile app drives its own native panel host, and
 * pretending those are the same call would be a lie in both directions. So this
 * module owns the definitions and each client owns a `run` per id
 * (`apps/shell/commands/slate.ts`, `apps/mobile/src/commands/slate.ts`).
 *
 * Everything here is pure: availability predicates and argument suggesters read
 * only the injected `SurfaceContext` (plus, for the workspace picker, a getter
 * the caller supplies). None of it performs IO.
 */
import { browserUrlFromEntry, type CommandSpec, type SurfaceContext } from "@workspace/omnibox-core";
import type { ThemeAccentColor } from "@vibestudio/shared/theme";

/** Accent swatches offered as quick theme commands (mirrors ThemeSettings). */
export const SLATE_ACCENTS = [
  "violet",
  "pink",
  "iris",
  "blue",
  "cyan",
  "grass",
  "tomato",
  "amber",
  "gray",
] as const satisfies readonly ThemeAccentColor[];

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

const desktopOnly: CommandSpec["surfaces"] = ["desktop"];
const everywhere: CommandSpec["surfaces"] = ["desktop", "mobile"];

/** Hidden unless there is a panel to act on — an action with no target is noise. */
function needsPanel(ctx: SurfaceContext): true | "hidden" {
  return ctx.focusedPanel ? true : "hidden";
}

export interface SlateDefinitionDeps {
  /** Live list of workspaces for the `workspace` argument's picker. */
  workspaceNames: () => string[];
}

/**
 * The ordered slate. Ranking sorts by score, so this order only decides ties;
 * it is kept in spec-section order because that is how the table reads.
 */
export function buildSlateDefinitions(deps: SlateDefinitionDeps): CommandSpec[] {
  return [
    // ---- Panel --------------------------------------------------------------
    {
      id: "panel.new",
      title: "New Panel",
      aliases: ["new"],
      keywords: ["open", "create", "tab"],
      section: "Panel",
      icon: "＋",
      surfaces: everywhere,
      accelerator: "⌘T",
      args: [
        {
          name: "source",
          label: "source",
          type: "source",
          required: false,
        },
      ],
    },
    {
      id: "panel.close",
      title: "Close Panel",
      keywords: ["archive"],
      section: "Panel",
      icon: "✕",
      surfaces: everywhere,
      availability: needsPanel,
      // Closing a panel with children takes its subtree with it.
      danger: true,
    },
    {
      id: "panel.focus",
      title: "Go to Panel",
      aliases: ["go to", "goto"],
      section: "Panel",
      icon: "▤",
      surfaces: everywhere,
      args: [
        {
          name: "panel",
          label: "panel",
          type: "panel",
          required: true,
          suggest: (query, ctx) => {
            const normalized = query.trim().toLowerCase();
            return ctx.openPanels.entries
              .filter(
                (entry) =>
                  !normalized ||
                  entry.title.toLowerCase().includes(normalized) ||
                  entry.source.toLowerCase().includes(normalized)
              )
              .slice(0, 20)
              .map((entry) => ({
                value: entry.id,
                label: entry.title,
                ...(entry.location ? { meta: entry.location } : { meta: entry.source }),
              }));
          },
        },
      ],
    },
    {
      id: "panel.pin",
      title: "Pin Panel",
      section: "Panel",
      icon: "📌",
      surfaces: everywhere,
      availability: (ctx) => (ctx.focusedPanel && ctx.focusedPanel.pinned !== true ? true : "hidden"),
    },
    {
      id: "panel.unpin",
      title: "Unpin Panel",
      section: "Panel",
      icon: "📌",
      surfaces: everywhere,
      availability: (ctx) => (ctx.focusedPanel?.pinned === true ? true : "hidden"),
    },
    {
      id: "panel.reload",
      title: "Reload Panel",
      keywords: ["refresh"],
      section: "Panel",
      icon: "⟳",
      surfaces: everywhere,
      accelerator: "⌘R",
      availability: needsPanel,
    },
    {
      id: "panel.duplicate",
      title: "Duplicate Panel",
      section: "Panel",
      icon: "⧉",
      surfaces: everywhere,
      availability: needsPanel,
    },
    {
      id: "panel.copy-link",
      title: "Copy Panel Link",
      section: "Panel",
      icon: "🔗",
      surfaces: everywhere,
      // Only addressable sources have a link worth copying; a browser panel's
      // address belongs to the address bar, not to `buildPanelLink`.
      availability: (ctx) => (ctx.focusedPanel?.addressable ? true : "hidden"),
    },

    // ---- Navigate -----------------------------------------------------------
    {
      id: "nav.back",
      title: "Back",
      section: "Navigate",
      icon: "←",
      surfaces: everywhere,
      availability: (ctx) => (ctx.focusedPanel ? ctx.focusedPanel.canGoBack === true : "hidden"),
    },
    {
      id: "nav.forward",
      title: "Forward",
      section: "Navigate",
      icon: "→",
      surfaces: everywhere,
      availability: (ctx) => (ctx.focusedPanel ? ctx.focusedPanel.canGoForward === true : "hidden"),
    },
    {
      id: "nav.open-url",
      title: "Open URL",
      aliases: ["open-url", "url"],
      section: "Navigate",
      icon: "🌐",
      surfaces: everywhere,
      args: [
        {
          name: "url",
          label: "address",
          type: "url",
          required: true,
          // The same parser the launcher uses, so what counts as an address is
          // one answer across the workspace.
          validate: (value) =>
            browserUrlFromEntry(value) ? null : "That doesn't look like a web address.",
        },
      ],
    },
    {
      id: "nav.history",
      title: "Search History",
      aliases: ["history"],
      keywords: ["recent", "pages", "visited"],
      section: "Navigate",
      icon: "🕘",
      surfaces: everywhere,
      // Deliberately argument-less. Running it does not navigate — it drops the
      // user into the `@` scope narrowed to recent pages, where the palette's
      // own input is the query field. Prompting for a query first would put an
      // argument session in front of a text box that does the same job.
    },
    {
      id: "nav.address",
      title: "Edit Address",
      keywords: ["location", "url bar"],
      section: "Navigate",
      icon: "⌨",
      surfaces: desktopOnly,
      accelerator: "⌘L",
    },

    // ---- Quickfire agent ----------------------------------------------------
    {
      id: "quickfire.ask",
      title: "Ask About This Panel",
      aliases: ["ask"],
      section: "Quickfire agent",
      icon: "✦",
      surfaces: everywhere,
      args: [{ name: "prompt", label: "prompt", type: "string", required: false }],
    },
    {
      id: "quickfire.clear",
      title: "Clear Panel Conversation",
      section: "Quickfire agent",
      icon: "⟲",
      surfaces: everywhere,
      danger: true,
      availability: needsPanel,
    },
    {
      id: "quickfire.promote",
      title: "Open Conversation as Chat Panel",
      section: "Quickfire agent",
      icon: "⧉",
      surfaces: everywhere,
      availability: needsPanel,
    },
    {
      id: "quickfire.list",
      title: "Quickfire Agent Conversations",
      section: "Quickfire agent",
      icon: "✦",
      surfaces: everywhere,
    },
    {
      id: "agent.new-chat",
      title: "New Chat",
      aliases: ["chat"],
      section: "Quickfire agent",
      icon: "✧",
      surfaces: everywhere,
      args: [{ name: "prompt", label: "prompt", type: "string", required: false }],
    },

    // ---- Debug --------------------------------------------------------------
    {
      id: "debug.devtools",
      title: "Open Panel DevTools",
      keywords: ["inspect", "console"],
      section: "Debug",
      icon: "⚙",
      surfaces: desktopOnly,
      availability: needsPanel,
    },
    {
      id: "debug.shell-devtools",
      title: "Open Shell DevTools",
      section: "Debug",
      icon: "⚙",
      surfaces: desktopOnly,
    },

    // ---- Appearance & Layout ------------------------------------------------
    {
      id: "view.theme",
      title: "Theme",
      aliases: ["appearance"],
      keywords: ["dark", "light", "mode"],
      section: "Appearance & Layout",
      icon: "◐",
      surfaces: everywhere,
      args: [
        {
          name: "mode",
          label: "mode",
          type: "enum",
          required: true,
          options: [
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ],
        },
      ],
    },
    {
      id: "view.accent",
      title: "Accent Color",
      keywords: ["colour", "theme"],
      section: "Appearance & Layout",
      icon: "◍",
      // Desktop-only on purpose, and stated rather than silently dropped (the
      // parity rule in apps/shell/SKILL.md): the mobile app has no accent
      // system at all — its palette is two literal light/dark colour tables in
      // `state/themeAtoms.ts`. Offering the command there would list nine
      // swatches that change nothing. Give mobile an accent and this flips.
      surfaces: desktopOnly,
      args: [
        {
          name: "accent",
          label: "accent",
          type: "enum",
          required: true,
          options: SLATE_ACCENTS.map((accent) => ({ value: accent, label: capitalize(accent) })),
        },
      ],
    },

    // ---- Workspace ----------------------------------------------------------
    {
      id: "workspace.switch",
      title: "Switch Workspace",
      section: "Workspace",
      icon: "▦",
      surfaces: everywhere,
      accelerator: "⌘⇧O",
      args: [
        {
          name: "workspace",
          label: "workspace",
          type: "workspace",
          // Optional: with no argument this opens the chooser, which is exactly
          // what the retired palette item and the menus do.
          required: false,
          suggest: (query) => {
            const normalized = query.trim().toLowerCase();
            return deps
              .workspaceNames()
              .filter((name) => !normalized || name.toLowerCase().includes(normalized))
              .map((name) => ({ value: name, label: name }));
          },
        },
      ],
    },
    {
      id: "workspace.permissions",
      title: "Permissions & Agents",
      keywords: ["authority", "grants"],
      section: "Workspace",
      icon: "🛡",
      surfaces: everywhere,
    },
    {
      id: "workspace.downloads",
      title: "Downloads",
      section: "Workspace",
      icon: "⇩",
      surfaces: everywhere,
    },
    {
      id: "workspace.about",
      title: "About This Workspace",
      section: "Workspace",
      icon: "ⓘ",
      surfaces: everywhere,
    },

    // ---- Approvals & Safety -------------------------------------------------
    {
      id: "authority.focus-approval",
      title: "Focus Pending Approval",
      section: "Approvals & Safety",
      icon: "⚑",
      surfaces: desktopOnly,
      accelerator: "⌘⇧A",
      availability: (ctx) => ((ctx.pendingApprovals ?? 0) > 0 ? true : "hidden"),
    },

    // ---- Application --------------------------------------------------------
    {
      id: "app.shortcuts",
      title: "Keyboard Shortcuts",
      section: "Application",
      icon: "⌨",
      surfaces: everywhere,
      accelerator: "⌘/",
    },
    {
      id: "app.reload-shell",
      title: "Reload App Shell",
      section: "Application",
      icon: "⟳",
      surfaces: desktopOnly,
      danger: true,
    },
    {
      id: "app.check-updates",
      title: "Check for Updates",
      section: "Application",
      icon: "⇧",
      // Desktop-only, stated rather than omitted: mobile does not poll for
      // updates from a command. Its trusted OTA path is `appUpdatePrompt.ts`,
      // which is offered by the host when a prepared bundle exists — a command
      // that reported "up to date" from a different update system would be
      // actively misleading about which artifact it checked.
      surfaces: desktopOnly,
    },
  ];
}
