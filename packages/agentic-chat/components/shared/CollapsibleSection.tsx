import React, { useState } from "react";
import { Box, Flex, Text } from "@radix-ui/themes";
import { ExpandableChevron } from "./Chevron";

export function CollapsibleSection({
  label,
  defaultOpen = false,
  children,
  color = "gray",
}: {
  label: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  color?: "gray" | "red" | "green" | "blue" | "amber";
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <Box>
      <Flex
        align="center"
        gap="1"
        onClick={() => setIsOpen(!isOpen)}
        style={{ cursor: "pointer", userSelect: "none" }}
        tabIndex={0}
      >
        <Text size="1" color={color}>
          <ExpandableChevron expanded={isOpen} />
        </Text>
        <Text size="1" color={color} weight="medium">
          {label}
        </Text>
      </Flex>
      {isOpen && (
        <Box mt="1" ml="3">
          {children}
        </Box>
      )}
    </Box>
  );
}
