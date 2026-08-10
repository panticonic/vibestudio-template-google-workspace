import { Badge, Flex, Spinner, Text } from "@radix-ui/themes";
import { MagnifyingGlassIcon } from "@radix-ui/react-icons";
import { useState } from "react";
import { ThreadRow, type ThreadRowItem } from "./thread-row";
import type { GmailSearchCardState } from "@workspace/gmail/card-types";

type SearchState = Partial<GmailSearchCardState> & { query: string };

interface GmailChat {
  callMethodByHandle: (handle: string, method: string, args: unknown) => Promise<unknown>;
  /** Scroll-to-and-highlight a message (optional on older panels). */
  focusMessage?: (messageId: string) => Promise<boolean>;
}

/** Search updates are merge patches over the card state. */
export function reduce(state: SearchState, update: Partial<GmailSearchCardState>): SearchState {
  return { ...state, ...update };
}

export function Pill({ state }: { state: SearchState }) {
  return (
    <Flex align="center" gap="1">
      <MagnifyingGlassIcon />
      <Text size="1" weight="medium" truncate style={{ minWidth: 0 }}>
        “{state.query}”
      </Text>
      {state.status === "searching" ? (
        <Spinner size="1" />
      ) : (
        <Badge size="1" color="gray">
          {state.results?.length ?? 0}
        </Badge>
      )}
    </Flex>
  );
}

/**
 * Ephemeral search-results card. A new search creates a new card; there is
 * nothing to clear. Rows open thread cards.
 */
export default function GmailSearch({
  state,
  expanded,
  chat,
}: {
  state: SearchState;
  expanded: boolean;
  chat: GmailChat;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<Set<string>>(() => new Set());

  if (!expanded) return <Pill state={state} />;

  async function open(threadId: string) {
    setBusy(true);
    setError(null);
    try {
      const result = (await chat.callMethodByHandle("gmail", "openThread", { threadId })) as {
        messageId?: string;
      } | null;
      setOpened((current) => new Set(current).add(threadId));
      if (result?.messageId && chat.focusMessage) void chat.focusMessage(result.messageId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const results = state.results ?? [];
  return (
    <Flex direction="column" gap="2">
      <Flex align="center" gap="2" style={{ minWidth: 0 }}>
        <MagnifyingGlassIcon />
        <Text size="2" weight="bold" truncate style={{ minWidth: 0 }}>
          {state.query}
        </Text>
        {state.status === "searching" ? (
          <Spinner size="1" />
        ) : (
          <Badge color="gray" variant="soft">
            {results.length}
            {state.totalEstimate && state.totalEstimate > results.length
              ? ` of ~${state.totalEstimate}`
              : ""}
          </Badge>
        )}
      </Flex>
      {state.status === "error" ? (
        <Text size="1" color="red">
          {state.error ?? "Search failed."}
        </Text>
      ) : null}
      {error ? (
        <Text size="1" color="red">
          {error}
        </Text>
      ) : null}
      {state.status === "done" && results.length === 0 ? (
        <Text size="2" color="gray">
          No matches. Try asking me to refine the search.
        </Text>
      ) : null}
      <Flex direction="column" gap="1">
        {results.map((item: ThreadRowItem) => (
          <ThreadRow
            key={item.threadId}
            item={{ ...item, suggested: "open" }}
            busy={busy}
            done={opened.has(item.threadId) ? { label: "Opened ↓" } : undefined}
            onOpen={(threadId) => void open(threadId)}
            onAction={(row) => void open(row.threadId)}
          />
        ))}
      </Flex>
    </Flex>
  );
}
