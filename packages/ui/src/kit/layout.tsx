/**
 * Layout primitives for the shared app-wide UI kit.
 *
 * These wrap Radix `Flex`/`Box` with the app's spacing rhythm and the
 * surface/elevation tokens from `foundation.css`, so every panel frames its content
 * the same way instead of re-deriving chrome. Import the tokens once at the
 * app/panel root:
 *
 *   import "@workspace/ui/foundation.css";
 */
import type { CSSProperties, ReactNode } from "react";
import { Box, Flex } from "@radix-ui/themes";

type Gap = "0" | "1" | "2" | "3" | "4" | "5" | "6";
type Align = "start" | "center" | "end" | "stretch" | "baseline";
type Justify = "start" | "center" | "end" | "between";

export interface StackProps {
  /** Stacking direction. Defaults to vertical column. */
  direction?: "row" | "column";
  /** Radix space scale gap between children. */
  gap?: Gap;
  align?: Align;
  justify?: Justify;
  wrap?: boolean;
  flex?: CSSProperties["flex"];
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/**
 * A thin, opinionated stack. Vertical by default - the most common panel
 * layout - with the Radix space scale for gaps so spacing reads consistently.
 */
export function Stack({
  direction = "column",
  gap = "3",
  align,
  justify,
  wrap = false,
  flex,
  className,
  style,
  children,
}: StackProps) {
  return (
    <Flex
      direction={direction}
      gap={gap}
      align={align}
      justify={justify}
      wrap={wrap ? "wrap" : undefined}
      className={className}
      style={{ ...(flex !== undefined ? { flex } : null), ...style }}
    >
      {children}
    </Flex>
  );
}

export type SurfaceLevel = "chrome" | "panel" | "card" | "raised";
export type ElevationLevel = 0 | 1 | 2 | "overlay";

const SURFACE_BG: Record<SurfaceLevel, string> = {
  chrome: "var(--surface-chrome)",
  panel: "var(--surface-panel)",
  card: "var(--surface-card)",
  raised: "var(--surface-raised)",
};

const ELEVATION_SHADOW: Record<Exclude<ElevationLevel, 0>, string> = {
  1: "var(--elevation-1)",
  2: "var(--elevation-2)",
  overlay: "var(--elevation-overlay)",
};

export interface SurfaceProps {
  /** Named surface level keyed to the surface tokens. */
  level?: SurfaceLevel;
  /** Elevation shadow. `0` = flat. */
  elevation?: ElevationLevel;
  /** Draw the standard 1px token border. */
  bordered?: boolean;
  /** Radix-token corner radius. */
  radius?: CSSProperties["borderRadius"];
  padding?: Gap;
  flex?: CSSProperties["flex"];
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/**
 * A neutral surface that reads correctly in light and dark via the surface
 * tokens. Use it for cards, panes, and overlays rather than hand-rolling
 * background/border/shadow on every container.
 */
export function Surface({
  level = "card",
  elevation = 0,
  bordered = false,
  radius,
  padding,
  flex,
  className,
  style,
  children,
}: SurfaceProps) {
  return (
    <Box
      p={padding}
      className={className}
      style={{
        background: SURFACE_BG[level],
        boxShadow: elevation === 0 ? undefined : ELEVATION_SHADOW[elevation],
        border: bordered ? "1px solid var(--surface-border)" : undefined,
        borderRadius: radius ?? "var(--radius-3)",
        ...(flex !== undefined ? { flex } : null),
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export interface ToolbarProps {
  /** Leading content (titles, primary controls). */
  children: ReactNode;
  /** Trailing content, pushed to the far edge. */
  actions?: ReactNode;
  align?: Align;
  /** Render the standard bottom hairline (header) or top hairline (footer). */
  divider?: "top" | "bottom" | "none";
  className?: string;
  style?: CSSProperties;
}

/**
 * One horizontal control strip - the editor and several panels each rolled
 * their own. Items left, `actions` pushed right, with an optional token
 * hairline so headers and footers read uniformly.
 */
export function Toolbar({
  children,
  actions,
  align = "center",
  divider = "none",
  className,
  style,
}: ToolbarProps) {
  const border =
    divider === "bottom"
      ? { borderBottom: "1px solid var(--surface-border)" }
      : divider === "top"
        ? { borderTop: "1px solid var(--surface-border)" }
        : null;
  return (
    <Flex
      align={align}
      justify="between"
      gap="3"
      px="3"
      py="2"
      className={className}
      style={{ minHeight: 44, background: "var(--surface-chrome)", ...border, ...style }}
    >
      <Flex align={align} gap="2" style={{ minWidth: 0 }}>
        {children}
      </Flex>
      {actions != null && (
        <Flex align="center" gap="2" style={{ flexShrink: 0 }}>
          {actions}
        </Flex>
      )}
    </Flex>
  );
}

export interface PanelChromeProps {
  /** Rendered in the top toolbar's leading slot. */
  header?: ReactNode;
  /** Rendered in the top toolbar's trailing slot. */
  headerActions?: ReactNode;
  /** Optional footer strip. */
  footer?: ReactNode;
  /** Main scrollable body. */
  children: ReactNode;
  /** Body padding (Radix scale). Defaults to none so panels control insets. */
  bodyPadding?: Gap;
  className?: string;
  style?: CSSProperties;
}

/**
 * The standard panel frame: a calm chrome header, a flexible body that owns the
 * scroll, and an optional footer. Panel-specific guts (xterm, Lexical, tables)
 * drop into `children` while the framing stays uniform app-wide.
 */
export function PanelChrome({
  header,
  headerActions,
  footer,
  children,
  bodyPadding,
  className,
  style,
}: PanelChromeProps) {
  return (
    <Flex
      direction="column"
      className={className}
      style={{ height: "100%", minHeight: 0, ...style }}
    >
      {(header != null || headerActions != null) && (
        <Toolbar divider="bottom" actions={headerActions}>
          {header}
        </Toolbar>
      )}
      <Box p={bodyPadding} style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {children}
      </Box>
      {footer != null && <Box style={{ flexShrink: 0 }}>{footer}</Box>}
    </Flex>
  );
}
