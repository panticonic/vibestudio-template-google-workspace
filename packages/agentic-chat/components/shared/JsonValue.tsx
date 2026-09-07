import { useState } from "react";
import { Box, Code, Flex, Text } from "@radix-ui/themes";
import { ExpandableChevron } from "./Chevron";

/** Recursive JSON tree explorer with depth-based auto-expand and color-coded types. */
export function JsonValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [isExpanded, setIsExpanded] = useState(depth < 2);

  if (value === null) return <Text size="1" color="gray">null</Text>;
  if (value === undefined) return <Text size="1" color="gray">undefined</Text>;
  if (typeof value === "boolean") return <Text size="1" color="purple">{String(value)}</Text>;
  if (typeof value === "number") return <Text size="1" color="orange">{String(value)}</Text>;

  if (typeof value === "string") {
    if (value.includes("\n") || value.length > 100) {
      return (
        <Box>
          <Flex align="center" gap="1" onClick={() => setIsExpanded(!isExpanded)}
            style={{ cursor: "pointer", userSelect: "none" }} tabIndex={0}>
            <ExpandableChevron expanded={isExpanded} />
            <Text size="1" color="gray">{value.length} chars</Text>
          </Flex>
          {isExpanded && (
            <Box mt="1" ml="3">
              <Code size="1" style={{
                display: "block", whiteSpace: "pre-wrap", padding: "8px",
                maxHeight: "300px", overflow: "auto", backgroundColor: "var(--gray-a3)",
              }}>
                {value}
              </Code>
            </Box>
          )}
        </Box>
      );
    }
    return <Text size="1" color="green">{value}</Text>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <Text size="1" color="gray">[]</Text>;
    return (
      <Box>
        <Flex align="center" gap="1" onClick={() => setIsExpanded(!isExpanded)}
          style={{ cursor: "pointer", userSelect: "none" }} tabIndex={0}>
          <ExpandableChevron expanded={isExpanded} />
          <Text size="1" color="gray">[{value.length}]</Text>
        </Flex>
        {isExpanded && (
          <Box mt="1" ml="3">
            {value.map((item, index) => (
              <Box key={index} py="1">
                <Text size="1" color="gray">{index}</Text>
                <Box ml="3"><JsonValue value={item} depth={depth + 1} /></Box>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <Text size="1" color="gray">{"{}"}</Text>;
    return (
      <Box>
        <Flex align="center" gap="1" onClick={() => setIsExpanded(!isExpanded)}
          style={{ cursor: "pointer", userSelect: "none" }} tabIndex={0}>
          <ExpandableChevron expanded={isExpanded} />
          <Text size="1" color="gray">{"{"}...{"}"}</Text>
        </Flex>
        {isExpanded && (
          <Box mt="1" ml="3">
            {entries.map(([key, val]) => (
              <Box key={key} py="1">
                <Text size="1" color="cyan">{key}</Text>
                <Box ml="3"><JsonValue value={val} depth={depth + 1} /></Box>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    );
  }

  return <Text size="1">{String(value)}</Text>;
}
