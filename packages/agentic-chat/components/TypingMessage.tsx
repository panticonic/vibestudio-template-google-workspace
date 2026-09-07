import { Flex, IconButton, Spinner, Text } from "@radix-ui/themes";
import { StopIcon } from "@radix-ui/react-icons";
import type { TypingIndicatorData } from "../types";

/**
 * Compact pill for typing indicators.
 * Shows who is typing with an optional interrupt button.
 */
export function TypingPill({
  data,
  onInterrupt,
}: {
  data: TypingIndicatorData;
  onInterrupt?: () => void;
}) {
  return (
    <Flex
      className="inline-status-pill"
      align="center"
      gap="1"
      style={{
        padding: "2px 6px",
        borderRadius: "4px",
        backgroundColor: "var(--purple-a3)",
        display: "inline-flex",
      }}
    >
      <Spinner size="1" />
      <Text className="inline-pill-summary" size="1" color="purple" weight="medium">
        {data.senderName ?? "Agent"} typing
      </Text>
      {onInterrupt && (
        <IconButton
          size="1"
          color="gray"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            onInterrupt();
          }}
          aria-label="Interrupt"
          title="Stop"
          style={{ marginLeft: 4 }}
        >
          <StopIcon />
        </IconButton>
      )}
    </Flex>
  );
}
