import { ChevronRightIcon } from "@radix-ui/react-icons";

interface ExpandableChevronProps {
  expanded: boolean;
  size?: number;
}

/**
 * Styled chevron icon that rotates when expanded.
 * Uses Radix UI ChevronRightIcon with rotation animation.
 */
export function ExpandableChevron({ expanded, size = 12 }: ExpandableChevronProps) {
  return (
    <ChevronRightIcon
      width={size}
      height={size}
      style={{
        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.15s ease",
        flexShrink: 0,
      }}
    />
  );
}
