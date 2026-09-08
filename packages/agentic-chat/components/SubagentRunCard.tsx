import { useMemo, useState } from "react";
import { Badge, Box, Flex, IconButton, Popover, Text } from "@radix-ui/themes";
import { ChevronDownIcon, ExternalLinkIcon, InfoCircledIcon } from "@radix-ui/react-icons";
import type { ChatMessage } from "@workspace/agentic-core";
import { useOptionalChatMessageActions } from "../context/ChatContext";
import { MarkdownPreview } from "./MarkdownPreview";
import { MessageContent } from "./MessageContent";
import { SubagentTranscriptContent } from "./SubagentTranscript";
import { useChildTranscript } from "../hooks/useChildTranscript";
import { toolPresentation } from "./ActionMessage";
import { CopyIconButton } from "./shared/CopyButton";

/**
 * SubagentRunCard — how a spawned child run appears in its parent's transcript.
 * Routed here from `MessageList.renderItem` for a durable subagent task card.
 *
 * The retained card opens the child's canonical conversation. Activity and
 * results belong to that transcript; finishing a turn does not retire the
 * collaborator or require a second completion record in the parent log.
 */

function compactId(value: string): string {
  if (value.length <= 36) return value;
  return `${value.slice(0, 18)}…${value.slice(-12)}`;
}

export interface SubagentActivityPreview {
  prefix?: string;
  content: string;
}

function compactActivity(value: string, max = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

/** Convert one child-authored transcript row into compact parent-card copy. */
function activityPreview(message: ChatMessage): SubagentActivityPreview | null {
  if (message.invocation) {
    const presentation = toolPresentation(message.invocation);
    const content = compactActivity(
      presentation.preview
        ? `${presentation.displayName} · ${presentation.preview}`
        : presentation.displayName
    );
    const invocationStatus = message.invocation.execution.status;
    return {
      prefix:
        invocationStatus === "error"
          ? "Failed"
          : invocationStatus === "cancelled" || invocationStatus === "abandoned"
            ? "Stopped"
            : invocationStatus === "pending" || invocationStatus === "running"
              ? "Using"
              : "Used",
      content,
    };
  }

  const content = compactActivity(message.content);
  if (message.contentType === "typing") {
    return { prefix: "Working", content: "Composing a response" };
  }
  if (!content) return null;
  if (message.contentType === "thinking") return { prefix: "Thinking", content };
  if (message.contentType === "toolcall-progress") return { prefix: "Preparing", content };
  if (message.contentType === "diagnostic" || message.error) {
    return { prefix: "Issue", content };
  }
  return { prefix: message.saliency === "say" ? "Update" : "Said", content };
}

/**
 * Project a compact live trail from the child's canonical transcript. The run
 * event carries the exact participant id; no author inference is permitted at
 * this authority boundary.
 */
export function latestSubagentActivities(
  messages: ChatMessage[],
  childParticipantId: string | undefined,
  limit = 3
): SubagentActivityPreview[] {
  if (!childParticipantId) return [];
  const activities: SubagentActivityPreview[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.task || message.senderId !== childParticipantId) continue;
    const activity = activityPreview(message);
    if (!activity) continue;
    const previous = activities[activities.length - 1];
    if (previous && previous.prefix === activity.prefix && previous.content === activity.content) {
      continue;
    }
    activities.push(activity);
    if (activities.length >= limit) break;
  }
  return activities;
}

function IdentifiersPopover({ rows }: { rows: Array<[string, string]> }) {
  return (
    <Popover.Root>
      <Popover.Trigger>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          title="Run identifiers"
          aria-label="Run identifiers"
        >
          <InfoCircledIcon />
        </IconButton>
      </Popover.Trigger>
      <Popover.Content size="1" className="subagent-ids-popover">
        <Text size="1" weight="medium" className="subagent-ids-heading">
          Run identifiers
        </Text>
        <Box className="subagent-detail-grid">
          {rows.map(([name, value]) => (
            <div className="subagent-detail-row" key={name}>
              <Text size="1" className="subagent-detail-name">
                {name}
              </Text>
              <Flex align="center" gap="1" className="subagent-detail-value-wrap">
                <Text size="1" className="subagent-detail-value" title={value}>
                  {compactId(value)}
                </Text>
                <CopyIconButton
                  value={value}
                  label={`Copy ${name.toLowerCase()} id`}
                  className="subagent-copy-button"
                />
              </Flex>
            </div>
          ))}
        </Box>
      </Popover.Content>
    </Popover.Root>
  );
}

export function SubagentRunCard({ msg }: { msg: ChatMessage }) {
  const actions = useOptionalChatMessageActions();
  const forkState = actions?.forkState;
  const childTranscript = actions?.childTranscript;
  const [open, setOpen] = useState(false);

  const task = msg.task;
  const subagent = task?.subagent;
  const canObserve = Boolean(childTranscript && subagent?.taskChannelId);
  const observed = useChildTranscript({
    connection: childTranscript ?? null,
    channelId: subagent?.taskChannelId ?? null,
    contextId: subagent?.contextId ?? null,
    // Retained collaborators can receive future work. A collapsed history
    // card does not need a permanent subscription to wait for a terminal.
    enabled: canObserve && open,
  });
  const activities = useMemo(
    () => latestSubagentActivities(observed.messages, subagent?.childParticipantId),
    [observed.messages, subagent?.childParticipantId]
  );

  if (!task || !subagent) return null;

  const description = task.execution.description.trim();
  const label = subagent.label || task.title || "Subagent";
  const canOpenPanel = Boolean(forkState && subagent.taskChannelId && subagent.contextId);
  const previews: SubagentActivityPreview[] =
    activities.length > 0
      ? activities
      : [{ content: description || "Open the subagent conversation" }];
  const preview = previews[0]!;

  const detailRows = (
    [
      ["Run", subagent.runId],
      ["Task", subagent.taskChannelId],
      ["Context", subagent.contextId],
      ["Parent", subagent.parentContextId ?? undefined],
      ["Child", subagent.childEntityId],
    ] as Array<[string, string | undefined]>
  ).filter((row): row is [string, string] => typeof row[1] === "string" && row[1].length > 0);

  const handleOpenPanel = () => {
    if (!forkState || !subagent.taskChannelId || !subagent.contextId) return;
    forkState.actions.clearError();
    void Promise.resolve(
      forkState.actions.openInNewPanel(subagent.taskChannelId, subagent.contextId)
    ).catch((cause) =>
      forkState.actions.reportError("Could not open subagent conversation", cause)
    );
  };

  return (
    <Box className="message-row message-row-agent">
      <Box
        className={`message-card-subagent${open ? " subagent-card-open" : ""}`}
        data-testid="subagent-run-card"
      >
        <div className="subagent-summary">
          <Flex align="center" gap="2" className="subagent-card-header">
            <button
              type="button"
              className="subagent-summary-toggle"
              aria-expanded={open}
              aria-label={open ? "Collapse run details" : "Expand run details"}
              onClick={() => setOpen((value) => !value)}
            >
              <span
                className={`subagent-expand-chevron${open ? " subagent-expand-chevron-open" : ""}`}
                aria-hidden="true"
              >
                <ChevronDownIcon />
              </span>
              <Text className="subagent-title" size="2" weight="medium" truncate>
                {label}
              </Text>
              {subagent.mode && (
                <Badge className="subagent-mode-badge" size="1" variant="surface" color="gray">
                  {subagent.mode}
                </Badge>
              )}
              {subagent.agentKind === "claude-code" && (
                <Badge
                  className="subagent-kind-badge"
                  size="1"
                  variant="soft"
                  color="amber"
                  title="Claude Code subagent"
                >
                  Claude Code
                </Badge>
              )}
            </button>
            <Flex align="center" gap="2" className="subagent-card-actions">
              <Badge className="subagent-status-badge" size="1" variant="soft" color="gray">
                Conversation
              </Badge>
              {detailRows.length > 0 && <IdentifiersPopover rows={detailRows} />}
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                disabled={!canOpenPanel}
                onClick={handleOpenPanel}
                title="Open subagent chat in a new panel"
                aria-label="Open subagent chat in a new panel"
              >
                <ExternalLinkIcon />
              </IconButton>
            </Flex>
          </Flex>
          {!open && preview.content && (
            <button
              type="button"
              className="subagent-update-preview"
              aria-label="Expand run details from summary"
              onClick={() => setOpen(true)}
            >
              <span className="subagent-activity-text">
                {preview.prefix ? (
                  <span className="subagent-activity-prefix">{preview.prefix}</span>
                ) : null}
                <MarkdownPreview content={preview.content} />
              </span>
              {previews.length > 1 ? (
                <span className="subagent-activity-history" aria-label="Recent child activity">
                  {previews.slice(1).map((item, index) => (
                    <span
                      className="subagent-activity-history-item"
                      key={`${item.prefix}-${item.content}`}
                    >
                      {index > 0 ? <span aria-hidden="true"> · </span> : null}
                      {item.prefix ? `${item.prefix} ` : ""}
                      {item.content}
                    </span>
                  ))}
                </span>
              ) : null}
            </button>
          )}
        </div>

        {open && (
          <Box className="subagent-details">
            {description && (
              <div className="subagent-description">
                <MessageContent content={description} isStreaming={false} />
              </div>
            )}

            {canObserve && childTranscript && subagent.taskChannelId ? (
              <SubagentTranscriptContent transcript={observed} />
            ) : (
              <Text size="1" color="gray" className="subagent-empty-feed">
                The child's transcript is not observable from this view.
              </Text>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}
