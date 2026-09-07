import { Badge, Button, Flex, Text } from "@radix-ui/themes";
import { ChevronDownIcon, ChevronRightIcon } from "@radix-ui/react-icons";
import { useState } from "react";
import type { CSSProperties } from "react";
import { useIsMobile } from "@workspace/react/responsive";
import type { SessionInfo, TerminalNotification, TerminalState } from "./types.js";

export function NotificationCenter(props: {
  notifications: TerminalNotification[];
  sessions: Record<string, SessionInfo>;
  filter: TerminalState["notificationFilter"];
  onFilterChange(filter: TerminalState["notificationFilter"]): void;
  onJump(sessionId: string): void;
  onMarkRead(notifId: string): void;
  onDismiss(notifId: string): void;
  onMarkAllRead(): void;
  onClearAll(): void;
}) {
  const isMobile = useIsMobile();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [expandedItems, setExpandedItems] = useState<Set<string>>(() => new Set());
  const model = buildNotificationCenterModel(props.notifications, props.filter, props.sessions);
  return (
    <Flex
      direction="column"
      width={isMobile ? "100%" : "20rem"}
      p="3"
      gap="3"
      style={{
        borderLeft: "1px solid var(--gray-5)",
        background: "var(--gray-1)",
        boxSizing: "border-box",
        maxWidth: "100%",
      }}
    >
      <Flex align="center" justify="between">
        <Text weight="medium" size="2">
          Notifications
        </Text>
        <Flex gap="1">
          <Button size="1" variant="soft" onClick={props.onMarkAllRead}>
            Mark read
          </Button>
          <Button
            size="1"
            variant="ghost"
            onClick={() => {
              const unread = props.notifications.some((item) => !item.read);
              if (!unread || window.confirm("Clear all terminal notifications, including unread ones?")) props.onClearAll();
            }}
          >
            Clear
          </Button>
        </Flex>
      </Flex>
      <Flex gap="1" wrap="wrap">
        {(["all", "approval", "failure", "waiting", "done"] as const).map((item) => (
          <button
            key={item}
            onClick={() => props.onFilterChange(item)}
            style={{ border: 0, padding: 0, background: "transparent" }}
          >
            <Badge
              size="1"
              variant={model.filter === item ? "solid" : "soft"}
              color={
                item === "failure"
                  ? "red"
                  : item === "approval"
                    ? "amber"
                    : item === "waiting"
                      ? "blue"
                    : item === "done"
                      ? "green"
                      : "gray"
              }
            >
              {item}
            </Badge>
          </button>
        ))}
      </Flex>
      <Flex direction="column" gap="3" style={{ overflow: "auto", minHeight: 0 }}>
        {model.notifications.length === 0 ? (
          <Text size="2" color="gray">
            No notifications
          </Text>
        ) : null}
        {model.groups.map((group) => (
          <Flex key={group.sessionId} direction="column" gap="1">
            <button
              onClick={() => {
                setCollapsedGroups((prev) => toggleSet(prev, group.sessionId));
              }}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "var(--space-2)",
                border: 0,
                background: "transparent",
                padding: "var(--space-1) 0",
                color: "var(--gray-11)",
                textAlign: "left",
              }}
            >
              <Flex align="center" gap="1">
                {collapsedGroups.has(group.sessionId) ? (
                  <ChevronRightIcon width="12" height="12" />
                ) : (
                  <ChevronDownIcon width="12" height="12" />
                )}
                <Text size="1" color="gray" style={{ textTransform: "uppercase" }}>
                  {group.label}
                </Text>
              </Flex>
              <Badge size="1" variant="soft" color={groupBadgeColor(group.items)}>
                {group.items.length}
              </Badge>
            </button>
            {collapsedGroups.has(group.sessionId)
              ? null
              : group.items.map((item) => {
                  const expanded = expandedItems.has(item.notifId);
                  const presentation = notificationItemPresentation(item);
                  return (
                    <div
                      className="terminal-notification-item"
                      key={item.notifId}
                      style={{
                        border: 0,
                        borderLeft: `4px solid ${severityColor(item.severity)}`,
                        borderRadius: "var(--radius-2)",
                        padding: "var(--space-2)",
                        textAlign: "left",
                        background: !item.canJump
                          ? "var(--gray-2)"
                          : item.read
                            ? "var(--gray-2)"
                            : "var(--accent-3)",
                        opacity: item.canJump ? 1 : 0.72,
                        color: "var(--gray-12)",
                        cursor: "default",
                      }}
                    >
                      <Flex align="center" justify="between" gap="2">
                        <Text size="1" color="gray">
                          {new Date(item.timestamp).toLocaleTimeString()} · {group.label}
                        </Text>
                        <Flex align="center" gap="1">
                          {!item.canJump ? (
                            <Badge size="1" variant="soft" color="gray">
                              session ended
                            </Badge>
                          ) : null}
                          <Badge size="1" variant="soft" color={badgeColor(item.severity)}>
                            {item.severity}
                          </Badge>
                        </Flex>
                      </Flex>
                      {item.title ? (
                        <Text size="2" weight="medium">
                          {item.title}
                        </Text>
                      ) : null}
                      <Text
                        size="2"
                        style={
                          expanded
                            ? presentation.expandedBodyStyle
                            : presentation.collapsedBodyStyle
                        }
                      >
                        {item.message}
                      </Text>
                      <Flex className="terminal-notification-actions" gap="2" mt="2">
                        {item.canJump ? (
                          <Button
                            size="1"
                            variant="ghost"
                            onClick={() => props.onJump(item.sessionId)}
                          >
                            Jump
                          </Button>
                        ) : null}
                        {presentation.canExpand ? (
                          <Button
                            size="1"
                            variant="ghost"
                            onClick={() =>
                              setExpandedItems((prev) => toggleSet(prev, item.notifId))
                            }
                          >
                            {expanded ? "Show less" : "Show more"}
                          </Button>
                        ) : null}
                        {!item.read ? (
                          <Button
                            size="1"
                            variant="ghost"
                            onClick={() => props.onMarkRead(item.notifId)}
                          >
                            Mark read
                          </Button>
                        ) : null}
                        <Button
                          size="1"
                          variant="ghost"
                          onClick={() => props.onDismiss(item.notifId)}
                        >
                          Dismiss
                        </Button>
                      </Flex>
                    </div>
                  );
                })}
          </Flex>
        ))}
      </Flex>
      <style>{`
        .terminal-notification-actions {
          opacity: 0;
          transition: opacity 120ms ease;
        }
        .terminal-notification-item:hover .terminal-notification-actions,
        .terminal-notification-item:focus-within .terminal-notification-actions {
          opacity: 1;
        }
        @media (pointer: coarse), (max-width: 767px) {
          .terminal-notification-actions {
            opacity: 1;
            flex-wrap: wrap;
          }
        }
      `}</style>
    </Flex>
  );
}

function toggleSet(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export interface NotificationCenterGroup {
  sessionId: string;
  label: string;
  items: NotificationCenterItem[];
}

export type NotificationCenterItem = TerminalNotification & {
  canJump: boolean;
};

export function notificationItemPresentation(item: Pick<TerminalNotification, "message">): {
  canExpand: boolean;
  collapsedBodyStyle: CSSProperties;
  expandedBodyStyle: CSSProperties;
} {
  const mono = {
    fontFamily: "var(--font-mono, JetBrains Mono, Menlo, Consolas, monospace)",
  } satisfies CSSProperties;
  return {
    canExpand: item.message.length > 140 || item.message.includes("\n"),
    collapsedBodyStyle: {
      ...mono,
      display: "-webkit-box",
      WebkitLineClamp: 2,
      WebkitBoxOrient: "vertical",
      overflow: "hidden",
    },
    expandedBodyStyle: {
      ...mono,
      whiteSpace: "pre-wrap",
    },
  };
}

export function buildNotificationCenterModel(
  notifications: TerminalNotification[],
  filter: TerminalState["notificationFilter"],
  sessions: Record<string, SessionInfo> = {}
): {
  filter: NonNullable<TerminalState["notificationFilter"]>;
  notifications: NotificationCenterItem[];
  groups: NotificationCenterGroup[];
} {
  const effectiveFilter = filter ?? "all";
  const visible =
    effectiveFilter === "all"
      ? notifications
      : notifications.filter((item) => item.severity === effectiveFilter);
  const items = visible
    .map((item) => ({
      ...item,
      canJump: sessions[item.sessionId]?.alive === true,
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
  const grouped = groupBySession(items);
  return {
    filter: effectiveFilter,
    notifications: items,
    groups: Object.entries(grouped)
      .map(([sessionId, items]) => ({
        sessionId,
        label: sessions[sessionId]?.label || `Session ${sessionId.slice(0, 8)}`,
        items,
      }))
      .sort((a, b) => (b.items[0]?.timestamp ?? 0) - (a.items[0]?.timestamp ?? 0)),
  };
}

function groupBadgeColor(
  items: NotificationCenterItem[]
): "gray" | "green" | "blue" | "amber" | "red" {
  if (items.some((item) => item.severity === "failure")) return "red";
  if (items.some((item) => item.severity === "approval")) return "amber";
  if (items.some((item) => item.severity === "waiting")) return "blue";
  if (items.some((item) => item.severity === "done")) return "green";
  return "gray";
}

function groupBySession(
  notifications: NotificationCenterItem[]
): Record<string, NotificationCenterItem[]> {
  return notifications.reduce<Record<string, NotificationCenterItem[]>>((groups, item) => {
    (groups[item.sessionId] ??= []).push(item);
    return groups;
  }, {});
}

function severityColor(severity: TerminalNotification["severity"]): string {
  if (severity === "failure") return "var(--red-9)";
  if (severity === "approval") return "var(--amber-9)";
  if (severity === "waiting") return "var(--blue-9)";
  if (severity === "done") return "var(--green-9)";
  return "var(--gray-9)";
}

function badgeColor(
  severity: TerminalNotification["severity"]
): "gray" | "green" | "blue" | "amber" | "red" {
  if (severity === "failure") return "red";
  if (severity === "approval") return "amber";
  if (severity === "waiting") return "blue";
  if (severity === "done") return "green";
  return "gray";
}
