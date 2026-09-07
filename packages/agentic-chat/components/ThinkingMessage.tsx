import React from "react";
import { Box, Flex, Spinner, Text } from "@radix-ui/themes";
import { ExpandableChevron } from "./shared/Chevron";
import { MessageContent } from "./MessageContent";

// Collapsed state - small inline pill matching method calls
const ThinkingPill = React.memo(function ThinkingPill({
  id,
  preview,
  isTruncated,
  isStreaming,
  onExpand,
}: {
  id: string;
  preview: string;
  isTruncated: boolean;
  isStreaming: boolean;
  onExpand: (id: string) => void;
}) {
  return (
    <Flex
      className="inline-status-pill"
      align="center"
      gap="1"
      onClick={() => onExpand(id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onExpand(id);
        }
      }}
      role="button"
      style={{
        cursor: "pointer",
        userSelect: "none",
        padding: "2px 6px",
        borderRadius: "4px",
        backgroundColor: "var(--gray-a3)",
        display: "inline-flex",
      }}
      tabIndex={0}
      aria-label={preview ? `Thinking: ${preview}` : "Thinking"}
    >
      {isStreaming && <Spinner size="1" />}
      {preview && (
        <Box className="inline-pill-summary inline-pill-markdown-preview" style={{ opacity: 0.85 }}>
          <MessageContent
            content={`${preview}${isTruncated ? "..." : ""}`}
            isStreaming={isStreaming}
          />
        </Box>
      )}
    </Flex>
  );
});

// Expanded state - shows full thinking content
const ExpandedThinking = React.memo(function ExpandedThinking({
  content,
  isStreaming,
  onCollapse,
}: {
  content: string;
  isStreaming: boolean;
  onCollapse: () => void;
}) {
  return (
    <Box
      style={{
        backgroundColor: "var(--gray-a2)",
        borderRadius: "6px",
        padding: "8px 10px",
        border: "1px solid var(--gray-a4)",
      }}
    >
      <Flex
        align="center"
        gap="2"
        onClick={onCollapse}
        onKeyDown={(event) => {
          if (event.currentTarget !== event.target) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onCollapse();
          }
        }}
        role="button"
        style={{ cursor: "pointer", userSelect: "none" }}
        tabIndex={0}
      >
        <Text color="gray" style={{ display: "flex", alignItems: "center" }}>
          <ExpandableChevron expanded={true} />
        </Text>
        <Text size="1" color="gray" weight="medium">
          Thinking
        </Text>
      </Flex>
      <Box mt="2" ml="4">
        <MessageContent content={content} isStreaming={isStreaming} />
      </Box>
    </Box>
  );
});

export const PREVIEW_MAX_LENGTH = 120;

// Export sub-components for use in InlineGroup
export { ThinkingPill, ExpandedThinking };
