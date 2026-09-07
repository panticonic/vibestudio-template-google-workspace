/**
 * Command types for the omnibox.
 *
 * Two shapes, deliberately split (spec §3.1):
 *
 * - `CommandSpec` / `ArgSpec` are **chrome-local**. The built-in slate is
 *   defined inside the shell chrome and its `availability` / `suggest` /
 *   `validate` functions never cross a process boundary.
 * - `WireCommandSpec` / `WireArgSpec` are the **declarative wire subset** that
 *   panels contribute over `HostCommandRegistry`. Functions cannot round-trip
 *   through a serialized event payload, so contributed commands express
 *   availability as `requiresFocus`, enums as inline static options, and
 *   validation as a regex `pattern`.
 */

export const COMMAND_SECTIONS = [
  "Panel",
  "Navigate",
  "Quickfire",
  "Debug",
  "Appearance & Layout",
  "Workspace",
  "Approvals & Safety",
  "Application",
] as const;

export type BuiltInCommandSection = (typeof COMMAND_SECTIONS)[number];
/** Built-in sections plus whatever a contributing panel names its group. */
export type CommandSection = BuiltInCommandSection | (string & {});

export type CommandSurface = "desktop" | "mobile";

/** What the overlay knows about the panel it is floating over. */
export interface PanelDescriptor {
  panelId: string;
  title: string;
  /** Workspace source path ("panels/chat") or the URL for a browser panel. */
  source?: string;
  kind?: "workspace" | "browser" | "about" | "unknown";
  icon?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  pinned?: boolean;
  collapsed?: boolean;
  hasChildren?: boolean;
  /** True when the source is addressable, i.e. `buildPanelLink` can name it. */
  addressable?: boolean;
  /** True for privileged targets (permissions, authority surfaces). */
  privileged?: boolean;
}

/** One row of the "already open" index — the `@` scope and `panel` arg source. */
export interface OpenPanelEntry {
  id: string;
  title: string;
  source: string;
  /** URL-canonical form for browser panels, so dedup matches the launcher's. */
  canonicalSource?: string;
  icon?: string;
  /** Human-facing location hint ("pane 2"), shown as row meta. */
  location?: string;
}

export interface OpenPanelIndex {
  entries: OpenPanelEntry[];
}

/**
 * Everything a command's availability predicate and arg suggesters may read.
 * Purely injected data — the engine performs no IO of its own.
 */
export interface SurfaceContext {
  focusedPanel?: PanelDescriptor;
  openPanels: OpenPanelIndex;
  platform: "desktop" | "mobile" | "panel";
  /** Feature switches (e.g. `devFeatures`) consulted by availability. */
  flags?: Record<string, boolean>;
  /** Quickfire conversation state for the bound slot, when known. */
  quickfire?: { hasConversation: boolean; messageCount?: number; promoted?: boolean };
  /** Count of approvals awaiting a decision. */
  pendingApprovals?: number;
}

export interface ArgOption {
  value: string;
  label: string;
  /** Optional secondary line for the option row. */
  meta?: string;
}

export type ArgType = "string" | "enum" | "panel" | "source" | "url" | "workspace" | "number";

export interface ArgSpec {
  name: string;
  /** Placeholder shown while this argument is being prompted. */
  label: string;
  type: ArgType;
  /** Optional arguments are skippable with Enter on an empty input. */
  required: boolean;
  suggest?: (query: string, ctx: SurfaceContext) => ArgOption[];
  /** Returns an error message, or null when the value is acceptable. */
  validate?: (value: string) => string | null;
  /** Static option list for `enum` arguments. */
  options?: ArgOption[];
}

/** `true` = available, `false` = shown but disabled, `"hidden"` = not listed. */
export type CommandAvailability = boolean | "hidden";

export interface CommandSpec {
  id: string;
  title: string;
  aliases?: string[];
  /** Extra match terms. Never displayed. */
  keywords?: string[];
  section: CommandSection;
  icon?: string;
  /** Ordered; prompted in sequence (see ./argSession). */
  args?: ArgSpec[];
  availability?: (ctx: SurfaceContext) => CommandAvailability;
  surfaces: CommandSurface[];
  /** Renders in the danger tone and never auto-runs from an inline utterance. */
  danger?: boolean;
  /** Display hint only; the Electron menu remains the source of truth. */
  accelerator?: string;
  /** Secondary line for the row. */
  description?: string;
  /** Set for commands proxied to a contributing panel. */
  panelId?: string;
}

// ---------------------------------------------------------------------------
// Wire subset (panel-contributed commands)
// ---------------------------------------------------------------------------

export type WireArgType = "string" | "enum" | "number" | "url";

export interface WireArgSpec {
  name: string;
  label: string;
  type: WireArgType;
  required: boolean;
  /** Enum options are inline and static — there is no dynamic `suggest` in v1. */
  options?: { value: string; label: string }[];
  /** Regex source used to validate free-text values. */
  pattern?: string;
}

export interface WireCommandSpec {
  id: string;
  /** The wire field stays `label`; the palette maps it to `CommandSpec.title`. */
  label: string;
  description?: string;
  /** Maps to a section rendered under the contributing panel's name. */
  group?: string;
  args?: WireArgSpec[];
  /** The only availability a serialized contribution can express. */
  requiresFocus?: boolean;
  danger?: boolean;
}

const NUMBER_PATTERN = /^-?\d+(?:\.\d+)?$/u;

function compilePattern(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "u");
  } catch {
    return null;
  }
}

/** Lift one declarative wire argument into the chrome-local `ArgSpec`. */
export function argSpecFromWire(wire: WireArgSpec): ArgSpec {
  const options = wire.options?.map((option) => ({ value: option.value, label: option.label }));
  const compiled = wire.pattern ? compilePattern(wire.pattern) : null;
  return {
    name: wire.name,
    label: wire.label,
    type: wire.type,
    required: wire.required,
    ...(options ? { options } : {}),
    ...(compiled
      ? {
          validate: (value: string) =>
            compiled.test(value) ? null : `${wire.label} doesn't match the expected format.`,
        }
      : {}),
  };
}

/**
 * Lift a contributed command into the palette's local shape.
 *
 * Legacy `{id, label}` contributions are accepted unchanged and become arg-less
 * specs; `requiresFocus` becomes the only availability predicate a serialized
 * contribution can express.
 */
export function commandSpecFromWire(
  wire: WireCommandSpec,
  context: { panelId: string; panelTitle?: string }
): CommandSpec {
  const args = wire.args?.map(argSpecFromWire);
  return {
    id: `${context.panelId}:${wire.id}`,
    title: wire.label,
    section: wire.group ?? context.panelTitle ?? "Panel",
    surfaces: ["desktop", "mobile"],
    panelId: context.panelId,
    ...(wire.description ? { description: wire.description } : {}),
    ...(args && args.length > 0 ? { args } : {}),
    ...(wire.danger ? { danger: true } : {}),
    ...(wire.requiresFocus
      ? {
          availability: (ctx: SurfaceContext): CommandAvailability =>
            ctx.focusedPanel?.panelId === context.panelId ? true : "hidden",
        }
      : {}),
  };
}

/** Resolved availability, with the default (`true`) applied. */
export function commandAvailability(
  command: CommandSpec,
  ctx: SurfaceContext
): CommandAvailability {
  const surface = ctx.platform === "mobile" ? "mobile" : "desktop";
  if (!command.surfaces.includes(surface)) return "hidden";
  return command.availability?.(ctx) ?? true;
}

/** Validate one argument value against its spec. Returns an error or null. */
export function validateArgValue(arg: ArgSpec, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return arg.required ? `${arg.label} is required.` : null;
  if (arg.type === "number" && !NUMBER_PATTERN.test(trimmed)) {
    return `${arg.label} must be a number.`;
  }
  if (arg.type === "enum" && arg.options && !arg.options.some((o) => o.value === trimmed)) {
    return `${arg.label} must be one of: ${arg.options.map((o) => o.value).join(", ")}.`;
  }
  return arg.validate?.(trimmed) ?? null;
}
