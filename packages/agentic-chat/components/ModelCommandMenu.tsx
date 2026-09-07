import { createPortal } from "react-dom";
import { Badge, Box, Flex, Text } from "@radix-ui/themes";
import { HomeIcon } from "@radix-ui/react-icons";
import type { ModelCatalogEntry } from "@workspace/agentic-core";

const POPOVER_WIDTH = 320;

export interface ModelCommandMenuProps {
  candidates: ModelCatalogEntry[];
  selectedIndex: number;
  /** Viewport coordinates of the composer's top-left (for upward placement). */
  position: { left: number; top: number } | null;
  onSelect: (model: ModelCatalogEntry) => void;
  onHighlight: (index: number) => void;
}

/**
 * Composer `/model` quick-switcher menu (item 7). Mirrors MentionAutocomplete's
 * portal + upward placement so it clears the input card's overflow clipping and
 * inherits the Radix theme tokens. Lists models the agent can switch to right
 * now; selecting one restarts the current agent on that model.
 */
export function ModelCommandMenu({
  candidates,
  selectedIndex,
  position,
  onSelect,
  onHighlight,
}: ModelCommandMenuProps) {
  const portalTarget =
    typeof document === "undefined"
      ? null
      : (document.querySelector<HTMLElement>(".radix-themes") ?? document.body);
  if (!portalTarget) return null;
  return createPortal(
    <Box
      style={{
        position: "fixed",
        left: position
          ? Math.min(Math.max(4, position.left), window.innerWidth - POPOVER_WIDTH - 8)
          : 12,
        top: position ? Math.max(8, position.top - 6) : 0,
        transform: "translateY(-100%)",
        zIndex: 1000,
        width: POPOVER_WIDTH,
        maxWidth: "calc(100vw - 32px)",
        border: "1px solid var(--gray-a6)",
        borderRadius: 8,
        background: "var(--color-panel-solid)",
        boxShadow: "var(--shadow-4)",
        overflow: "hidden",
      }}
    >
      <Box px="3" py="1" style={{ borderBottom: "1px solid var(--gray-a4)" }}>
        <Text size="1" color="gray">
          Switch this agent's model
        </Text>
      </Box>
      {candidates.map((model, index) => (
        <Flex
          key={model.ref}
          align="center"
          justify="between"
          gap="2"
          px="3"
          py="2"
          style={{
            cursor: "pointer",
            background: index === selectedIndex ? "var(--accent-a4)" : "transparent",
          }}
          onMouseEnter={() => onHighlight(index)}
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(model);
          }}
        >
          <Box style={{ minWidth: 0 }}>
            <Text size="2" weight="medium" truncate>
              {model.name}
            </Text>
            <Text as="div" size="1" color="gray" truncate>
              {model.provider}
            </Text>
          </Box>
          {model.provider === "local" && (
            <Badge color="green" variant="soft" size="1" style={{ flexShrink: 0 }}>
              <HomeIcon width="10" height="10" /> on-device
            </Badge>
          )}
        </Flex>
      ))}
    </Box>,
    portalTarget
  );
}
