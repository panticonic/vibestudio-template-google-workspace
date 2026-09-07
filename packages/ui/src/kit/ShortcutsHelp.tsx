/**
 * One shared keyboard-shortcuts help surface. Panels pass their own grouped
 * bindings; the rendering (a `--z-dialog` modal with sectioned key rows and
 * styled `<kbd>` chips) is uniform app-wide.
 */
import type { ReactNode } from "react";
import { Dialog, Flex, Text } from "@radix-ui/themes";
import { OVERLAY_Z } from "./overlay";

export interface ShortcutEntry {
  /** Human description of the action. */
  label: string;
  /**
   * The keys. A `string[]` renders each token as its own chip joined by "+".
   * A `string` is shown verbatim in a single chip.
   */
  keys: string | string[];
}

export interface ShortcutGroup {
  title: string;
  entries: ShortcutEntry[];
}

export interface ShortcutsHelpProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: ShortcutGroup[];
  title?: ReactNode;
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      style={{
        display: "inline-block",
        minWidth: 18,
        padding: "1px 6px",
        borderRadius: "var(--radius-2)",
        background: "var(--gray-a3)",
        border: "1px solid var(--surface-border)",
        boxShadow: "var(--elevation-1)",
        fontFamily: "var(--code-font-family, monospace)",
        fontSize: "var(--font-size-1)",
        lineHeight: 1.5,
        textAlign: "center",
      }}
    >
      {children}
    </kbd>
  );
}

function Keys({ keys }: { keys: string | string[] }) {
  const tokens = Array.isArray(keys) ? keys : [keys];
  return (
    <Flex align="center" gap="1" style={{ flexShrink: 0 }}>
      {tokens.map((t, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
          {i > 0 && (
            <Text size="1" color="gray" aria-hidden>
              +
            </Text>
          )}
          <Kbd>{t}</Kbd>
        </span>
      ))}
    </Flex>
  );
}

export function ShortcutsHelp({ open, onOpenChange, groups, title = "Keyboard Shortcuts" }: ShortcutsHelpProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        style={{ maxWidth: 480, zIndex: OVERLAY_Z.dialog as unknown as number, boxShadow: "var(--elevation-overlay)" }}
      >
        <Dialog.Title>{title}</Dialog.Title>
        <Flex direction="column" gap="4" mt="3">
          {groups.map((group) => (
            <div key={group.title}>
              <Text as="div" size="1" weight="medium" color="gray" mb="2" style={{ textTransform: "uppercase", letterSpacing: 0.4 }}>
                {group.title}
              </Text>
              <Flex direction="column" gap="1">
                {group.entries.map((entry, i) => (
                  <Flex key={i} align="center" justify="between" gap="3" py="1">
                    <Text size="2">{entry.label}</Text>
                    <Keys keys={entry.keys} />
                  </Flex>
                ))}
              </Flex>
            </div>
          ))}
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
