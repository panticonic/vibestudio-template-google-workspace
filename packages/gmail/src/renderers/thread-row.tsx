import { Badge, Box, Button, Flex, Text } from "@radix-ui/themes";

export interface ThreadRowItem {
  threadId: string;
  from?: string;
  subject?: string;
  gist?: string;
  suggested?: "reply" | "archive" | "read" | "open";
  unread?: boolean;
}

const ACTION_LABELS: Record<NonNullable<ThreadRowItem["suggested"]>, string> = {
  reply: "Reply",
  archive: "Archive",
  read: "Mark read",
  open: "Open",
};

/**
 * Mobile-first thread row shared by the digest and search cards: the whole
 * row is tappable (opens the thread card), with exactly ONE trailing action
 * button. Min-height 44px for touch targets. `done` grays the row out after
 * its action ran (component-local — digest cards stay immutable).
 */
export function ThreadRow({
  item,
  busy,
  done,
  onOpen,
  onAction,
}: {
  item: ThreadRowItem;
  busy: boolean;
  /** Set after the row's action completed, e.g. { label: "Archived" }. */
  done?: { label: string };
  onOpen: (threadId: string) => void;
  onAction: (item: ThreadRowItem) => void;
}) {
  const action = item.suggested ?? "open";
  return (
    <Flex
      align="center"
      gap="2"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item.threadId)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onOpen(item.threadId);
      }}
      style={{
        minHeight: 44,
        padding: "6px 8px",
        borderRadius: 8,
        cursor: "pointer",
        border: "1px solid var(--gray-a4)",
        opacity: done ? 0.55 : 1,
      }}
    >
      <Box
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          flex: "0 0 auto",
          background: item.unread ? "var(--blue-9)" : "transparent",
        }}
      />
      <Box style={{ minWidth: 0, flex: "1 1 auto" }}>
        <Text
          size="2"
          weight={item.unread ? "bold" : "medium"}
          truncate
          style={{ display: "block" }}
        >
          {item.from || "(unknown sender)"}
        </Text>
        <Text size="1" truncate style={{ display: "block" }}>
          {item.subject || "(no subject)"}
        </Text>
        {item.gist ? (
          <Text size="1" color="gray" truncate style={{ display: "block" }}>
            {item.gist}
          </Text>
        ) : null}
      </Box>
      {done ? (
        <Badge color="gray" variant="soft" style={{ flex: "0 0 auto" }}>
          {done.label}
        </Badge>
      ) : (
        <Button
          size="2"
          variant={action === "reply" ? "soft" : "ghost"}
          disabled={busy}
          style={{ flex: "0 0 auto" }}
          onClick={(event) => {
            event.stopPropagation();
            onAction(item);
          }}
        >
          {ACTION_LABELS[action]}
        </Button>
      )}
    </Flex>
  );
}
