import { Flex, IconButton } from "@radix-ui/themes";
import { StopIcon, PauseIcon } from "@radix-ui/react-icons";

interface TypingIndicatorProps {
  isPaused: boolean;
  showInterruptButton?: boolean;
  onInterrupt?: () => void;
}

/**
 * Animated typing indicator component.
 * Shows three bouncing dots while streaming, with optional interrupt button.
 */
export function TypingIndicator({ isPaused, showInterruptButton, onInterrupt }: TypingIndicatorProps) {
  if (isPaused) {
    return (
      <Flex align="center" gap="2" style={{ color: "var(--amber-9)" }}>
        <PauseIcon />
        <span>Paused</span>
      </Flex>
    );
  }

  return (
    <Flex align="center" gap="2" className="typing-indicator">
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
      {showInterruptButton && onInterrupt && (
        <IconButton
          size="1"
          color="gray"
          variant="ghost"
          onClick={onInterrupt}
          aria-label="Interrupt agent"
          title="Stop execution"
          style={{ marginLeft: 4, opacity: 0.6 }}
        >
          <StopIcon />
        </IconButton>
      )}
    </Flex>
  );
}
