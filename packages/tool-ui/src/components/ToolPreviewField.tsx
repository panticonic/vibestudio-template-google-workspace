/**
 * ToolPreviewField Component
 *
 * Renders a rich preview for tool arguments based on tool name.
 * Used by FeedbackFormRenderer for approval prompts.
 *
 * Provides styled previews for bash commands, plan mode, etc.
 * Falls back to JSON display for unknown tools.
 */

import { type ReactNode } from "react";
import { Box, Text } from "@radix-ui/themes";
import {
  BashPreview,
  EnterPlanModePreview,
  ExitPlanModePreview,
  isBashArgs,
  isEnterPlanModeArgs,
  isExitPlanModeArgs,
} from "./tool-previews/core.js";

export interface ToolPreviewFieldProps {
  toolName: string;
  args: unknown;
}

/**
 * Format tool arguments for JSON display.
 * Truncates large values.
 */
function formatArgs(args: unknown): string {
  try {
    const str = JSON.stringify(args, null, 2);
    // Truncate if too long
    if (str.length > 500) {
      return str.slice(0, 500) + "\n...";
    }
    return str;
  } catch {
    return String(args);
  }
}

/**
 * Render the appropriate preview component for the tool arguments.
 * Returns the rich preview if available, otherwise falls back to JSON.
 */
export function ToolPreviewField({ toolName, args }: ToolPreviewFieldProps): ReactNode {
  // bash - Pretty command display
  if (toolName === "bash" && isBashArgs(args)) {
    return (
      <BashPreview
        command={(args as { command: string }).command}
        description={(args as { description?: string }).description}
      />
    );
  }

  // enter_plan_mode - Plan mode entry request
  if (toolName === "enter_plan_mode" && isEnterPlanModeArgs(args)) {
    const extendedArgs = args as Record<string, unknown>;
    const reason = typeof extendedArgs["reason"] === "string" ? extendedArgs["reason"] : undefined;
    return <EnterPlanModePreview reason={reason} />;
  }

  // exit_plan_mode - Plan approval with requested permissions
  if (toolName === "exit_plan_mode" && isExitPlanModeArgs(args)) {
    // planFilePath and plan content may be passed by SDK
    const extendedArgs = args as Record<string, unknown>;
    const planFilePath =
      typeof extendedArgs["planFilePath"] === "string" ? extendedArgs["planFilePath"] : undefined;
    const plan = typeof extendedArgs["plan"] === "string" ? extendedArgs["plan"] : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (
      <ExitPlanModePreview
        plan={plan}
        allowedPrompts={extendedArgs["allowedPrompts"] as any}
        planFilePath={planFilePath}
      />
    );
  }

  // Default: JSON display
  return (
    <Box
      style={{
        background: "var(--gray-3)",
        borderRadius: 6,
        padding: 12,
        maxHeight: 200,
        overflow: "auto",
      }}
    >
      <Text
        size="1"
        style={{
          fontFamily: "monospace",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {formatArgs(args)}
      </Text>
    </Box>
  );
}
