/**
 * Agent Disconnected Message Component
 *
 * Displays an inline notification when an agent unexpectedly disconnects.
 * Provides actions to focus or reload the agent's panel.
 */

import { Flex, Text, Button, Callout } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import type { DisconnectedAgentInfo } from "../types";

interface AgentDisconnectedMessageProps {
  agent: DisconnectedAgentInfo;
  onFocusPanel?: (panelId: string) => void;
  onReloadPanel?: (panelId: string) => void;
}

export function AgentDisconnectedMessage({
  agent,
  onFocusPanel,
  onReloadPanel,
}: AgentDisconnectedMessageProps) {
  const hasPanelId = !!agent.panelId;

  return (
    <Callout.Root color="orange" size="1" style={{ margin: "8px 0" }}>
      <Callout.Icon>
        <ExclamationTriangleIcon />
      </Callout.Icon>
      <Callout.Text>
        <Flex direction="column" gap="2">
          <Text size="2">
            <strong>{agent.name}</strong> (@{agent.handle}) disconnected unexpectedly.
          </Text>
          {hasPanelId && (
            <Flex gap="2">
              <Button size="1" variant="soft" onClick={() => onFocusPanel?.(agent.panelId!)}>
                Focus Panel
              </Button>
              <Button size="1" variant="soft" onClick={() => onReloadPanel?.(agent.panelId!)}>
                Reload
              </Button>
            </Flex>
          )}
          {!hasPanelId && (
            <Text size="1" color="gray">
              @{agent.handle} stopped unexpectedly. Reload this chat to reconnect it.
            </Text>
          )}
        </Flex>
      </Callout.Text>
    </Callout.Root>
  );
}
