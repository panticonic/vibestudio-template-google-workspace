/**
 * ApprovalHeaderField Component
 *
 * Renders the header for tool approval prompts.
 * Handles both first-time agent grants and per-call approvals.
 *
 * The surrounding FeedbackContainer already provides the "Approval needed"
 * chrome, so this header focuses on what's actually being requested
 * (which agent, which tool, what scope) without redundant framing.
 */

import { Box, Code, Flex, Text } from "@radix-ui/themes";
import { LockClosedIcon, ExclamationTriangleIcon, CheckCircledIcon } from "@radix-ui/react-icons";
import { APPROVAL_LEVELS } from "../hooks/useToolApproval";

export interface ApprovalHeaderFieldProps {
  agentName: string;
  toolName: string;
  displayName?: string;
  isFirstTimeGrant: boolean;
  floorLevel: number;
}

export function ApprovalHeaderField({
  agentName,
  toolName,
  displayName,
  isFirstTimeGrant,
  floorLevel,
}: ApprovalHeaderFieldProps) {
  const toolDisplayName = displayName ?? toolName;

  if (isFirstTimeGrant) {
    const level = APPROVAL_LEVELS[floorLevel as keyof typeof APPROVAL_LEVELS];
    return (
      <Flex direction="column" gap="3">
        <Flex gap="2" align="center">
          <LockClosedIcon style={{ color: "var(--blue-10)", flexShrink: 0 }} />
          <Text size="3" weight="bold">
            <Text color="blue">@{agentName}</Text> wants workspace access
          </Text>
        </Flex>

        <Box
          style={{
            background: "var(--gray-3)",
            borderRadius: "var(--radius-2)",
            padding: "10px 12px",
          }}
        >
          <Text size="1" color="gray" weight="medium" style={{ display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Permission level: {level?.label ?? "Unknown"}
          </Text>
          <Flex direction="column" gap="1">
            {level?.details.map((desc, i) => (
              <Text key={i} size="2" color="gray">
                • {desc}
              </Text>
            ))}
          </Flex>
        </Box>

        <Text size="1" color="gray">
          First call: <Code size="1">{toolDisplayName}</Code>
        </Text>
      </Flex>
    );
  }

  // Per-call approval - special handling for plan mode
  const isExitPlanApproval = toolName === "exit_plan_mode";
  const isEnterPlanApproval = toolName === "enter_plan_mode";

  if (isEnterPlanApproval) {
    return (
      <Flex gap="2" align="center" mb="2">
        <ExclamationTriangleIcon style={{ color: "var(--blue-10)", flexShrink: 0 }} />
        <Text size="3" weight="bold">
          <Text color="blue">@{agentName}</Text> wants to enter planning mode
        </Text>
      </Flex>
    );
  }

  if (isExitPlanApproval) {
    return (
      <Flex gap="2" align="center" mb="2">
        <CheckCircledIcon style={{ color: "var(--green-10)", flexShrink: 0 }} />
        <Text size="3" weight="bold">
          <Text color="green">@{agentName}</Text> is ready to implement
        </Text>
      </Flex>
    );
  }

  return (
    <Flex gap="2" align="center" mb="2">
      <ExclamationTriangleIcon style={{ color: "var(--amber-10)", flexShrink: 0 }} />
      <Text size="3" weight="bold">
        <Text color="amber">@{agentName}</Text> wants to use <Code>{toolDisplayName}</Code>
      </Text>
    </Flex>
  );
}
