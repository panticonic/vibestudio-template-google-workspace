import { Card, Flex, Text } from "@radix-ui/themes";
import { CheckIcon } from "@radix-ui/react-icons";
import type { AvailableAgent } from "@workspace/agentic-core";

export interface AgentTypeCardProps {
  agent: AvailableAgent;
  selected: boolean;
  onSelect: () => void;
}

/** A single selectable agent-type card in the gallery (icon, name, blurb). */
export function AgentTypeCard({ agent, selected, onSelect }: AgentTypeCardProps) {
  return (
    <Card
      asChild
      variant={selected ? "surface" : "classic"}
      data-surface-tone={selected ? "selected" : undefined}
      style={{
        cursor: "pointer",
      }}
    >
      <button type="button" onClick={onSelect}>
        <Flex align="center" gap="3">
          <Text size="5" aria-hidden>
            {agent.icon ?? "🤖"}
          </Text>
          <Flex direction="column" style={{ minWidth: 0 }} flexGrow="1">
            <Text size="2" weight="bold" truncate>
              {agent.name}
            </Text>
            {agent.description && (
              <Text size="1" color="gray">
                {agent.description}
              </Text>
            )}
          </Flex>
          {selected && <CheckIcon />}
        </Flex>
      </button>
    </Card>
  );
}
