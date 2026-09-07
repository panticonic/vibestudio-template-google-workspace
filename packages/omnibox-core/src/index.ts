/**
 * `@workspace/omnibox-core` — the one omnibox engine.
 *
 * Pure functions over injected data: no `@workspace/runtime`, no RPC, no DOM.
 * The same engine ranks the `about/new` launcher, the desktop quickfire
 * overlay, and (later) the mobile command sheet.
 */
export * from "./entryIntent";
export * from "./panelSources";
export * from "./addressSuggestions";
export * from "./launchablePanels";
export * from "./launcherSuggestions";
export * from "./commands";
export * from "./commandSuggestions";
export * from "./argSession";
