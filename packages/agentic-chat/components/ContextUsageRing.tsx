import { useMemo } from "react";
import type { ContextWindowUsage } from "@workspace/pubsub";
import { Tooltip } from "@radix-ui/themes";

export interface ContextUsageRingProps {
  /** Context usage data from participant metadata */
  usage: ContextWindowUsage | undefined;
  /** Ring size in pixels */
  size?: number;
  /** Ring stroke width */
  strokeWidth?: number;
  /** Whether the agent is currently active (for animation) */
  isActive?: boolean;
  /** Execution mode - "plan" or "edit" */
  executionMode?: "plan" | "edit";
}

/**
 * Get color based on usage percentage.
 * Green (0-60%), Amber (60-80%), Orange (80-90%), Red (90-100%)
 */
function getUsageColor(percent: number): string {
  if (percent < 60) return "var(--green-9)";
  if (percent < 80) return "var(--amber-9)";
  if (percent < 90) return "var(--orange-9)";
  return "var(--red-9)";
}

/**
 * Format token count for display (e.g., "12,345" or "12.3K")
 */
function formatTokens(tokens: number): string {
  if (tokens >= 100000) {
    return `${(tokens / 1000).toFixed(0)}K`;
  }
  if (tokens >= 10000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return tokens.toLocaleString();
}

/**
 * Circular progress ring showing context window usage.
 * Renders as an SVG ring chart with percentage in the center.
 */
export function ContextUsageRing({
  usage,
  size = 20,
  strokeWidth = 3,
  isActive = false,
  executionMode,
}: ContextUsageRingProps) {
  const { color, circumference, strokeDashoffset, tooltipText } = useMemo(() => {
    const hasPercent = usage?.usagePercent !== undefined;
    const percent = usage?.usagePercent ?? 0;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    // When we have a percentage, show progress; otherwise show a full neutral ring
    const strokeDashoffset = hasPercent ? circumference * (1 - percent / 100) : 0;
    // Use actual color for percentage, neutral gray when just counting tokens
    const color = hasPercent ? getUsageColor(percent) : "var(--gray-9)";

    // Build tooltip text
    const usedTokens = usage?.session?.inputTokens ?? 0;
    const maxTokens = usage?.maxContextTokens;
    const modeLabel = executionMode === "plan" ? " • Plan Mode" : "";
    const tooltipText = maxTokens
      ? `Context: ${percent}% used (${formatTokens(usedTokens)} / ${formatTokens(maxTokens)} tokens)${modeLabel}`
      : `Context: ${formatTokens(usedTokens)} tokens used${modeLabel}`;

    return { color, circumference, strokeDashoffset, tooltipText };
  }, [
    usage?.usagePercent,
    usage?.session?.inputTokens,
    usage?.maxContextTokens,
    size,
    strokeWidth,
    executionMode,
  ]);

  // Don't render if no usage data
  if (!usage || (usage.usagePercent === undefined && !usage.session?.inputTokens)) {
    return null;
  }

  const center = size / 2;
  const radius = (size - strokeWidth) / 2;

  return (
    <Tooltip content={tooltipText}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{
          transform: "rotate(-90deg)",
          marginLeft: 4,
          flexShrink: 0,
        }}
      >
        {/* Background ring */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="var(--gray-a5)"
          strokeWidth={strokeWidth}
        />
        {/* Usage ring */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          style={{
            transition: "stroke-dashoffset 0.5s ease-in-out, stroke 0.3s ease",
            ...(isActive && {
              filter: "drop-shadow(0 0 2px currentColor)",
            }),
          }}
        />
      </svg>
    </Tooltip>
  );
}
