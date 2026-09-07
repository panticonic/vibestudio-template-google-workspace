/**
 * EnterPlanModePreview - Plan mode entry UI for EnterPlanMode tool
 *
 * Shows a friendly explanation of what plan mode does and asks
 * the user to approve entering this mode.
 */

import { Box, Text, Flex, Card } from "@radix-ui/themes";
import { MagnifyingGlassIcon, FileTextIcon, ReaderIcon } from "@radix-ui/react-icons";

export interface EnterPlanModePreviewProps {
  /** Optional reason/context for entering plan mode */
  reason?: string;
}

export function EnterPlanModePreview({ reason }: EnterPlanModePreviewProps) {
  return (
    <Box>
      {/* Header */}
      <Flex gap="2" align="center" mb="3">
        <MagnifyingGlassIcon style={{ color: "var(--blue-9)", width: 18, height: 18 }} />
        <Text size="2" weight="medium">
          Planning Mode
        </Text>
      </Flex>

      {/* Reason (if provided) */}
      {reason && (
        <Card size="1" mb="3">
          <Text size="2" color="gray">
            {reason}
          </Text>
        </Card>
      )}

      {/* What plan mode does */}
      <Card size="1">
        <Flex direction="column" gap="2">
          <Text size="2" weight="medium">
            In plan mode, Claude will:
          </Text>
          <Flex direction="column" gap="2" pl="2">
            <Flex gap="2" align="center">
              <ReaderIcon style={{ color: "var(--gray-9)", flexShrink: 0 }} />
              <Text size="2">
                Explore the codebase (read-only)
              </Text>
            </Flex>
            <Flex gap="2" align="center">
              <FileTextIcon style={{ color: "var(--gray-9)", flexShrink: 0 }} />
              <Text size="2">
                Design an implementation approach
              </Text>
            </Flex>
            <Flex gap="2" align="center">
              <MagnifyingGlassIcon style={{ color: "var(--gray-9)", flexShrink: 0 }} />
              <Text size="2">
                Present the plan for your approval before making changes
              </Text>
            </Flex>
          </Flex>
        </Flex>
      </Card>

      {/* Help text */}
      <Text size="1" color="gray" mt="2" style={{ display: "block" }}>
        No files will be modified until you approve the plan.
      </Text>
    </Box>
  );
}
