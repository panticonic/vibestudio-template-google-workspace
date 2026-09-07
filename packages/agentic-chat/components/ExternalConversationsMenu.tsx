/**
 * The chat header's external-conversations menu (messaging plan §4.10.7):
 * "where did my agent talk to other agents", at channel granularity. Built from
 * the transcript's own cross-channel rows — outgoing dispatch cards
 * (`external.envelope_published`) and incoming guest messages — so it needs no
 * second subscription, and it is absent when there is nothing to show.
 */
import { Button, DropdownMenu, Flex, Text } from "@radix-ui/themes";
import { ChevronDownIcon } from "@radix-ui/react-icons";
import type { ChatMessage } from "../types";

export interface ExternalConversationEntry {
  channelId: string;
  /** Handles/refs this channel's agents addressed there (outgoing). */
  addressees: string[];
  /** Guest senders that spoke here from that channel (incoming). */
  guests: string[];
  sent: number;
  received: number;
  /** Most recent envelope on either side, for the deep link. */
  latestEnvelopeId?: string;
}

/** Fold cross-channel traffic out of the transcript, one entry per channel. */
export function externalConversationsFromMessages(
  messages: readonly ChatMessage[]
): ExternalConversationEntry[] {
  const byChannel = new Map<string, ExternalConversationEntry>();
  const entryFor = (channelId: string): ExternalConversationEntry => {
    let entry = byChannel.get(channelId);
    if (!entry) {
      entry = { channelId, addressees: [], guests: [], sent: 0, received: 0 };
      byChannel.set(channelId, entry);
    }
    return entry;
  };
  for (const message of messages) {
    if (message.contentType === "cross-channel-sent" && message.crossChannel) {
      const entry = entryFor(message.crossChannel.channelId);
      entry.sent += 1;
      entry.latestEnvelopeId = message.crossChannel.envelopeId;
      for (const ref of message.crossChannel.addressees ?? []) {
        const handle = ref.replace(/^agent:/u, "@").replace(/@[^@]+$/u, "");
        if (!entry.addressees.includes(handle)) entry.addressees.push(handle);
      }
    } else if (message.origin && message.kind !== "system") {
      const entry = entryFor(message.origin.channelId);
      entry.received += 1;
      if (message.origin.envelopeId) entry.latestEnvelopeId = message.origin.envelopeId;
      const handle = message.senderMetadata?.handle
        ? `@${message.senderMetadata.handle}`
        : message.senderMetadata?.name ?? message.senderId;
      if (!entry.guests.includes(handle)) entry.guests.push(handle);
    }
  }
  return [...byChannel.values()];
}

function describe(entry: ExternalConversationEntry): string {
  const who = [...entry.addressees, ...entry.guests].slice(0, 3).join(", ");
  const counts = [
    entry.sent > 0 ? `${entry.sent} sent` : null,
    entry.received > 0 ? `${entry.received} received` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return who ? `${who} · ${counts}` : counts;
}

export function ExternalConversationsMenu({
  entries,
  onOpenChannel,
  variant = "button",
}: {
  entries: readonly ExternalConversationEntry[];
  onOpenChannel?: (channelId: string, opts?: { focusMessageId?: string }) => Promise<void> | void;
  variant?: "button" | "submenu";
}) {
  if (entries.length === 0) return null;
  const items = entries.map((entry) => (
    <DropdownMenu.Item
      key={entry.channelId}
      disabled={!onOpenChannel}
      onSelect={() =>
        void Promise.resolve(
          onOpenChannel?.(entry.channelId, {
            ...(entry.latestEnvelopeId ? { focusMessageId: entry.latestEnvelopeId } : {}),
          })
        ).catch(() => undefined)
      }
    >
      <Flex direction="column" gap="0" style={{ minWidth: 0 }}>
        <Text size="1" truncate>
          {entry.channelId}
        </Text>
        <Text size="1" color="gray" truncate>
          {describe(entry)}
        </Text>
      </Flex>
    </DropdownMenu.Item>
  ));
  if (variant === "submenu") {
    return (
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger>Conversations with… ({entries.length})</DropdownMenu.SubTrigger>
        <DropdownMenu.SubContent>{items}</DropdownMenu.SubContent>
      </DropdownMenu.Sub>
    );
  }
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Button size="1" variant="soft" color="gray" aria-label="Conversations with other channels">
          <Flex align="center" gap="1">
            <Text size="1" aria-hidden="true">
              ↗
            </Text>
            <Text size="1">{entries.length}</Text>
            <ChevronDownIcon />
          </Flex>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">{items}</DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
