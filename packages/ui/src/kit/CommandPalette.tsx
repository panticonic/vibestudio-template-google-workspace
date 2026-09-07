/**
 * One app-level command-palette primitive that the fragmented panel launchers
 * (terminal `CommandLauncher`, spectrolite `QuickOpen`) converge on.
 *
 * It owns the shared shape - a `--z-dialog` modal, a search field, arrow-key
 * navigation, sectioned results, and Enter-to-run - while each panel supplies
 * its own typed items and `onSelect`. Panel-specific extras (split-target
 * chiplets, "create file" affordance) ride in each item's `trailing`/`footer`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { Dialog, Flex, Text, TextField } from "@radix-ui/themes";
import { OVERLAY_Z } from "./overlay";

export interface CommandItem<T = unknown> {
  /** Stable identity. */
  id: string;
  /** Primary label - also the plain-text identity used for a11y and for callers
   *  that filter on text. Supply `labelNode` to override how it's displayed. */
  label: string;
  /** Optional pre-rendered label (e.g. with match highlighting). Display only;
   *  `label` stays the searchable string. Falls back to `label` when absent. */
  labelNode?: ReactNode;
  /** Optional secondary line (path, description). */
  hint?: string;
  /** Optional pre-rendered secondary line. Display only; falls back to `hint`. */
  hintNode?: ReactNode;
  /** Optional leading glyph. */
  icon?: ReactNode;
  /** Optional trailing content (badges, target chiplets). A function form
   *  receives whether the row is currently active, so a row can show, say,
   *  static state normally and richer controls once highlighted. */
  trailing?: ReactNode | ((ctx: { active: boolean }) => ReactNode);
  /** Group label; items sharing one are rendered under a single header. */
  section?: string;
  /** Arbitrary payload returned to `onSelect`. */
  value?: T;
}

export interface CommandPaletteProps<T = unknown> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current query text (controlled). */
  query: string;
  onQueryChange: (query: string) => void;
  /** Already-filtered, already-ordered items. Filtering is the panel's job. */
  items: CommandItem<T>[];
  /** Invoked with the chosen item plus the live keyboard modifiers. */
  onSelect: (item: CommandItem<T>, modifiers: SelectModifiers) => void;
  placeholder?: string;
  /** Optional leading glyph inside the search field. */
  searchIcon?: ReactNode;
  /** Optional footer (modifier legend, hints). */
  footer?: ReactNode;
  /** Optional empty-results message. */
  emptyMessage?: ReactNode;
  maxWidth?: CSSProperties["maxWidth"];
}

export interface SelectModifiers {
  shift: boolean;
  mod: boolean; // Cmd on macOS, Ctrl elsewhere
  alt: boolean;
}

export interface CommandSection<T = unknown> {
  label: string | null;
  items: { item: CommandItem<T>; index: number }[];
}

/**
 * Group an already-ordered item list into contiguous sections by `section`.
 * Consecutive items sharing a section (including the no-section run, `null`)
 * fall under one header; the original flat index is preserved on each item so
 * keyboard navigation stays aligned with the rendered rows. Pure + exported so
 * the grouping can be unit-tested without mounting the (portaled) dialog.
 */
export function groupCommandSections<T = unknown>(items: CommandItem<T>[]): CommandSection<T>[] {
  const out: CommandSection<T>[] = [];
  items.forEach((item, index) => {
    const label = item.section ?? null;
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push({ item, index });
    else out.push({ label, items: [{ item, index }] });
  });
  return out;
}

function readModifiers(e: KeyboardEvent | { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): SelectModifiers {
  return { shift: e.shiftKey, mod: e.metaKey || e.ctrlKey, alt: e.altKey };
}

export function CommandPalette<T = unknown>({
  open,
  onOpenChange,
  query,
  onQueryChange,
  items,
  onSelect,
  placeholder = "Type a command...",
  searchIcon,
  footer,
  emptyMessage = "No matches",
  maxWidth = 640,
}: CommandPaletteProps<T>) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Clamp the active index whenever the result set changes.
  useEffect(() => {
    setActive((i) => (items.length === 0 ? 0 : Math.min(i, items.length - 1)));
  }, [items]);

  // Query changes usually replace the ranked result set; start at the top hit.
  useEffect(() => {
    setActive(0);
  }, [query]);

  // Reset selection on open.
  useEffect(() => {
    if (open) setActive(0);
  }, [open]);

  // Keep the active row visible.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cmd-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const sections = useMemo(() => groupCommandSections(items), [items]);

  const handleQueryChange = (nextQuery: string) => {
    setActive(0);
    onQueryChange(nextQuery);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = items[active];
      if (chosen) onSelect(chosen, readModifiers(e));
    } else if (e.key === "Escape") {
      e.preventDefault();
      onOpenChange(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        aria-label="Command palette"
        style={{
          maxWidth,
          padding: 0,
          overflow: "hidden",
          zIndex: OVERLAY_Z.dialog as unknown as number,
          boxShadow: "var(--elevation-overlay)",
        }}
      >
        <Dialog.Title style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          Command palette
        </Dialog.Title>
        <Dialog.Description style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          Type to filter, then press Enter to run a command.
        </Dialog.Description>
        <div style={{ padding: "var(--space-2)", borderBottom: "1px solid var(--surface-border)" }}>
          <TextField.Root
            autoFocus
            value={query}
            placeholder={placeholder}
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            size="3"
          >
            {searchIcon != null && <TextField.Slot>{searchIcon}</TextField.Slot>}
          </TextField.Root>
        </div>
        <div
          ref={listRef}
          role="listbox"
          aria-label="Commands"
          style={{ maxHeight: "min(50dvh, 420px)", overflowY: "auto", padding: "var(--space-1)" }}
        >
          {items.length === 0 ? (
            <Flex align="center" justify="center" py="5">
              <Text size="2" color="gray">
                {emptyMessage}
              </Text>
            </Flex>
          ) : (
            sections.map((section, si) => (
              <div key={section.label ?? `__s${si}`}>
                {section.label != null && (
                  <Text
                    as="div"
                    size="1"
                    color="gray"
                    weight="medium"
                    style={{ padding: "var(--space-2) var(--space-3) var(--space-1)" }}
                  >
                    {section.label}
                  </Text>
                )}
                {section.items.map(({ item, index }) => {
                  const isActive = index === active;
                  const trailingNode =
                    typeof item.trailing === "function"
                      ? item.trailing({ active: isActive })
                      : item.trailing;
                  const hasHint = item.hintNode != null || item.hint != null;
                  return (
                    <div
                      key={item.id}
                      data-cmd-index={index}
                      role="option"
                      aria-selected={isActive}
                      className="app-touch-target"
                      onMouseEnter={() => setActive(index)}
                      onMouseDown={(e) => {
                        // Avoid blurring the input before the click resolves.
                        e.preventDefault();
                        onSelect(item, readModifiers(e));
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "var(--space-2)",
                        padding: "var(--space-2) var(--space-3)",
                        borderRadius: "var(--radius-2)",
                        cursor: "pointer",
                        background: isActive ? "var(--accent-a3)" : "transparent",
                      }}
                    >
                      {item.icon != null && (
                        <span style={{ display: "inline-flex", color: "var(--gray-10)", flexShrink: 0 }}>
                          {item.icon}
                        </span>
                      )}
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <Text as="div" size="2" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {item.labelNode ?? item.label}
                        </Text>
                        {hasHint && (
                          <Text as="div" size="1" color="gray" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {item.hintNode ?? item.hint}
                          </Text>
                        )}
                      </span>
                      {trailingNode != null && <span style={{ flexShrink: 0 }}>{trailingNode}</span>}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
        {footer != null && (
          <div
            style={{
              padding: "var(--space-2) var(--space-3)",
              borderTop: "1px solid var(--surface-border)",
              background: "var(--surface-chrome)",
            }}
          >
            {footer}
          </div>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}
