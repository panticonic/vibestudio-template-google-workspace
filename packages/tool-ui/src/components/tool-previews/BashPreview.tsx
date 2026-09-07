/**
 * BashPreview - Pretty command display for bash tool approvals
 *
 * Shows the command in a styled monospace block with the description as a label.
 */

import { Box, Text, Flex, Code } from "@radix-ui/themes";
import { CodeIcon } from "@radix-ui/react-icons";

export interface BashPreviewProps {
  command: string;
  description?: string;
}

export function BashPreview({ command, description }: BashPreviewProps) {
  return (
    <Box>
      {/* Description label */}
      {description && (
        <Flex gap="2" align="center" mb="2">
          <CodeIcon style={{ color: "var(--gray-11)", flexShrink: 0 }} />
          <Text size="2" color="gray">
            {description}
          </Text>
        </Flex>
      )}

      {/* Command block */}
      <Box
        style={{
          background: "var(--gray-3)",
          borderRadius: 6,
          padding: 12,
          border: "1px solid var(--gray-6)",
          maxHeight: 200,
          overflow: "auto",
        }}
      >
        <Flex gap="2" align="start">
          <Code
            size="2"
            variant="ghost"
            color="gray"
            style={{ flexShrink: 0, padding: 0, background: "none" }}
          >
            $
          </Code>
          <Text
            size="2"
            style={{
              fontFamily: "monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {command}
          </Text>
        </Flex>
      </Box>
    </Box>
  );
}
