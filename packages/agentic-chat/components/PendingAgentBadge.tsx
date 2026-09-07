/**
 * Pending Agent Badge
 *
 * Shows a badge for agents that are starting up or failed to start.
 * Provides access to the debug console even before the agent joins the roster.
 */

import { Badge, DropdownMenu, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon, ReloadIcon, TriangleDownIcon } from "@radix-ui/react-icons";
import type { AgentBuildError } from "@workspace/pubsub";
import type { PendingAgentStatus } from "../types";

export interface PendingAgentBadgeProps {
  handle: string;
  agentId: string;
  status: PendingAgentStatus;
  error?: AgentBuildError;
  onOpenDebugConsole?: (agentHandle: string) => void;
}

/**
 * Badge for pending/failed agents with debug console access.
 */
export function PendingAgentBadge({
  handle,
  status,
  error,
  onOpenDebugConsole,
}: PendingAgentBadgeProps) {
  const isError = status === "error";
  const color = isError ? "red" : "amber";
  const icon = isError ? (
    <ExclamationTriangleIcon style={{ width: 10, height: 10 }} />
  ) : (
    <ReloadIcon
      style={{
        width: 10,
        height: 10,
        animation: "spin 1s linear infinite",
      }}
    />
  );

  const title = isError
    ? `Agent failed to start: ${error?.message ?? "Unknown error"}`
    : "Agent starting...";

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Badge
          color={color}
          variant="soft"
          style={{ cursor: "pointer", opacity: isError ? 1 : 0.8 }}
          title={title}
        >
          {icon}
          <Text style={{ marginLeft: 4 }}>@{handle}</Text>
          <TriangleDownIcon
            style={{
              marginLeft: 4,
              width: 10,
              height: 10,
              opacity: 0.6,
            }}
          />
        </Badge>
      </DropdownMenu.Trigger>

      <DropdownMenu.Content>
        <DropdownMenu.Label>
          {isError ? "Failed to start" : "Starting..."}
        </DropdownMenu.Label>
        {error?.message && (
          <DropdownMenu.Label>
            <Text size="1" color="red" style={{ maxWidth: 250, wordBreak: "break-word" }}>
              {error.message}
            </Text>
          </DropdownMenu.Label>
        )}
        <DropdownMenu.Separator />
        {onOpenDebugConsole && (
          <DropdownMenu.Item onSelect={() => {
            console.log("[PendingAgentBadge] Debug Console clicked for handle:", handle);
            onOpenDebugConsole(handle);
          }}>
            Debug Console
          </DropdownMenu.Item>
        )}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
