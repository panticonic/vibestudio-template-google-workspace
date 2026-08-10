import { Badge, Flex, Text } from "@radix-ui/themes";
import { EnvelopeClosedIcon } from "@radix-ui/react-icons";
import { useState } from "react";
import { ThreadRow, type ThreadRowItem } from "./thread-row";
import type { GmailDigestCardState } from "@workspace/gmail/card-types";

type DigestState = Partial<GmailDigestCardState> & { headline: string };

interface GmailChat {
  callMethodByHandle: (handle: string, method: string, args: unknown) => Promise<unknown>;
  /** Scroll-to-and-highlight a message (optional on older panels). */
  focusMessage?: (messageId: string) => Promise<boolean>;
}

export function Pill({ state }: { state: DigestState }) {
  const count = state.items?.length ?? 0;
  return (
    <Flex align="center" gap="1">
      <EnvelopeClosedIcon />
      <Text size="1" weight="medium" truncate style={{ minWidth: 0 }}>
        {state.headline}
      </Text>
      {count > 0 ? (
        <Badge size="1" color="blue">
          {count}
        </Badge>
      ) : null}
    </Flex>
  );
}

/**
 * Immutable per-wake digest card: a headline and up to 5 tappable thread
 * rows. Posted once per digest turn; scrolls away with the conversation.
 */
export default function GmailDigest({
  state,
  expanded,
  chat,
}: {
  state: DigestState;
  expanded: boolean;
  chat: GmailChat;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Component-local action outcomes: digest channel state stays immutable,
  // but the row a user acted on grays out with what happened.
  const [doneByThread, setDoneByThread] = useState<Map<string, string>>(() => new Map());

  if (!expanded) return <Pill state={state} />;

  async function call(method: string, args: unknown): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    try {
      const result = await chat.callMethodByHandle("gmail", method, args);
      return result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  function markDone(threadId: string, label: string) {
    setDoneByThread((current) => new Map(current).set(threadId, label));
  }

  /** Hand the user to the card the action created (scroll + highlight). */
  function focusResult(result: Record<string, unknown> | null) {
    const messageId = result?.["messageId"];
    if (typeof messageId === "string" && chat.focusMessage) {
      void chat.focusMessage(messageId);
    }
  }

  function runAction(item: ThreadRowItem) {
    const action = item.suggested ?? "open";
    if (action === "reply") {
      void call("draftReply", { threadId: item.threadId }).then((result) => {
        if (!result) return;
        markDone(item.threadId, "Draft created ↓");
        focusResult(result);
      });
    } else if (action === "archive") {
      void call("archiveThread", { threadId: item.threadId }).then(
        (result) => result && markDone(item.threadId, "Archived")
      );
    } else if (action === "read") {
      void call("markRead", { threadId: item.threadId }).then(
        (result) => result && markDone(item.threadId, "Read")
      );
    } else {
      void call("openThread", { threadId: item.threadId }).then((result) => {
        if (!result) return;
        markDone(item.threadId, "Opened ↓");
        focusResult(result);
      });
    }
  }

  const items = state.items ?? [];
  return (
    <Flex direction="column" gap="2">
      <Flex align="center" gap="2" style={{ minWidth: 0 }}>
        <EnvelopeClosedIcon />
        <Text size="2" weight="bold" style={{ minWidth: 0, wordBreak: "break-word" }}>
          {state.headline}
        </Text>
      </Flex>
      {error ? (
        <Text size="1" color="red">
          {error}
        </Text>
      ) : null}
      <Flex direction="column" gap="1">
        {items.map((item) => (
          <ThreadRow
            key={item.threadId}
            item={item}
            busy={busy}
            done={
              doneByThread.has(item.threadId)
                ? { label: doneByThread.get(item.threadId)! }
                : undefined
            }
            onOpen={(threadId) =>
              void call("openThread", { threadId }).then((result) => {
                if (!result) return;
                markDone(threadId, "Opened ↓");
                focusResult(result);
              })
            }
            onAction={runAction}
          />
        ))}
      </Flex>
      {state.moreCount ? (
        <Text size="1" color="gray">
          +{state.moreCount} more — ask me to list them.
        </Text>
      ) : null}
    </Flex>
  );
}
