import { Badge, Box, Flex, Spinner, Text } from "@radix-ui/themes";
import type { ChatMessage, TaskCardPayload } from "@workspace/agentic-core";
import { MessageContent } from "./MessageContent";
import { CollapsibleSection } from "./shared/CollapsibleSection";
import { ToolDataView } from "./shared/ToolDataView";
import {
  executionStatusLabel,
  executionStatusTone,
  isLiveStatus,
  StatusDot,
  type StatusKey,
} from "./shared/invocationStatus";

function taskStatusKey(task: TaskCardPayload): StatusKey {
  switch (task.execution.status) {
    case "pending":
    case "running":
      return "pending";
    case "error":
      return "error";
    case "cancelled":
      return "cancelled";
    case "abandoned":
      return "abandoned";
    case "complete":
      return task.execution.isError ? "error" : "complete";
  }
}

/**
 * Structured presentation for ordinary durable task lifecycles. Subagent tasks
 * use `SubagentRunCard`; every other task still needs an exhaustive renderer so
 * its internal ChatMessage compatibility encoding never leaks as chat text.
 */
export function TaskRunCard({ msg }: { msg: ChatMessage }) {
  const task = msg.task;
  if (!task) return null;

  const status = task.execution.status;
  const statusKey = taskStatusKey(task);
  const description = task.execution.description.trim();
  const hasResult = task.execution.result !== undefined;
  const tone = executionStatusTone(status);

  return (
    <Box className="message-row message-row-agent">
      <Box
        className={`message-card-task task-status-${status}`}
        data-testid="task-run-card"
        data-task-status={status}
      >
        <Flex align="center" gap="2" className="task-card-header">
          {isLiveStatus(status) ? (
            <Spinner size="1" />
          ) : (
            <StatusDot statusKey={statusKey} />
          )}
          <Text className="task-card-title" size="2" weight="medium" truncate>
            {task.title}
          </Text>
          <Badge
            className="task-card-status"
            size="1"
            variant="soft"
            color={tone}
          >
            {executionStatusLabel(status)}
          </Badge>
        </Flex>

        {description ? (
          <Box className="task-card-description">
            <MessageContent content={description} isStreaming={false} />
          </Box>
        ) : isLiveStatus(status) ? (
          <Text className="task-card-empty" size="1" color="gray">
            Task in progress
          </Text>
        ) : null}

        {hasResult ? (
          <Box className="task-card-result">
            <CollapsibleSection
              label="Result details"
              color={statusKey === "error" ? "red" : "gray"}
            >
              <ToolDataView value={task.execution.result} label="Task result" />
            </CollapsibleSection>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
