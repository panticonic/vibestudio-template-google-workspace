import React, { useCallback, useMemo, useState } from "react";
import { Box, Button, Flex, IconButton, ScrollArea, Text } from "@radix-ui/themes";
import { ChevronDownIcon, ChevronUpIcon, LightningBoltIcon } from "@radix-ui/react-icons";
import { useIsMobile, useTouchDevice } from "@workspace/react/responsive";
import { useChatContext } from "../context/ChatContext";
import { OutboxItem, type OutboxLane } from "./OutboxItem";
import type { ChatMessage } from "../types";

/**
 * Resolve which outbox items the user authored and are still unread.
 * - self-authored, kind === "message", not error, not retracted, zero reads.
 * Sorted by existing message order (the array is already chronological).
 */
function deriveOutboxMessages(messages: ChatMessage[], selfId: string | null): ChatMessage[] {
  if (!selfId) return [];
  return messages.filter((m) => {
    if (m.senderId !== selfId) return false;
    if ((m.kind ?? "message") !== "message") return false;
    // Method invocations the user fired (e.g. `pause`/"send now") are projected
    // as self-authored kind:"message" rows with contentType:"invocation" and no
    // receipts — they must NOT be treated as queued chat messages. The outbox is
    // plain text/attachment messages only (those carry no special contentType).
    if (m.contentType) return false;
    if (m.error) return false;
    if (m.retracted) return false;
    // Only purely-unread messages live in the outbox. A partial/read message
    // graduates to the transcript with per-recipient badges.
    return (m.receipts?.aggregate ?? "pending") === "pending";
  });
}

/**
 * A pending recipient that has left the live roster (its receipt key is no
 * longer present) cannot integrate the message until it returns. Such a message
 * is surfaced in the TRANSCRIPT ("agent offline — delivers on return"), not the
 * outbox — so the outbox stays the set of messages actively deliverable now.
 * Derived purely from receipts + the live roster, so it self-resolves: when the
 * agent rejoins it re-enters the roster (no longer offline) and, once it folds
 * the backlog, its read-ack advances the receipt out of "pending" entirely.
 */
export function hasOfflinePendingRecipient(
  msg: ChatMessage,
  liveRoster: Record<string, unknown>
): boolean {
  const byParticipant = msg.receipts?.byParticipant;
  if (!byParticipant) return false;
  return Object.entries(byParticipant).some(
    ([key, state]) => state !== "read" && !(key in liveRoster)
  );
}

/**
 * Is there a PRESENT recipient to deliver this message to right now?
 * - With receipts: a recipient still in the roster that hasn't read it.
 * - Without receipts (optimistic, just-sent): true iff the roster has any
 *   non-self participant — i.e. someone the message is en route to. This is what
 *   lets a fresh send go STRAIGHT to the queue instead of flashing in the
 *   transcript first and then bouncing to the queue when its received-ack lands.
 * A message with no recipient at all (sent before any agent joined) returns
 * false, so it stays in the transcript rather than vanishing into the outbox.
 */
function hasDeliverableRecipient(
  msg: ChatMessage,
  selfId: string,
  liveRoster: Record<string, unknown>
): boolean {
  const byParticipant = msg.receipts?.byParticipant;
  if (byParticipant) {
    return Object.entries(byParticipant).some(
      ([key, state]) => state !== "read" && key in liveRoster
    );
  }
  return Object.keys(liveRoster).some((key) => key !== selfId);
}

/**
 * The outbox / transcript-hidden set: pending self messages still actively
 * deliverable to a PRESENT recipient. Excludes offline-recipient ones AND
 * no-recipient ones (both shown in the transcript instead). Shared by the
 * Outbox, the transcript filter, and the composer's flush control so all three
 * agree on what "queued" means — and so a message lives in exactly ONE place
 * (queue OR transcript) and transitions once (queue → transcript on read),
 * never flickering between them.
 */
export function deriveActiveOutbox(
  messages: ChatMessage[],
  selfId: string | null,
  liveRoster: Record<string, unknown>
): ChatMessage[] {
  if (!selfId) return [];
  return deriveOutboxMessages(messages, selfId).filter(
    (m) =>
      !hasOfflinePendingRecipient(m, liveRoster) && hasDeliverableRecipient(m, selfId, liveRoster)
  );
}

/**
 * The outbox — an "on-deck" tray between the feedback area and the composer.
 * Visualizes now-vs-next, pre-explains the flush priority, and tethers to the
 * agent's typing indicator while a turn is in flight. Mobile collapses to a
 * one-line summary bar; the queue caps height with internal scroll so the
 * composer stays visible. Stays below the mention popover z-layer.
 */
export const Outbox = React.memo(function Outbox() {
  const {
    connected,
    messages,
    selfId,
    participants,
    allParticipants,
    agentBusy,
    editPendingMessage,
    cancelPendingMessage,
    flushOutboxAndInterrupt,
    afterTurnMessageIds,
  } = useChatContext();
  const isMobile = useIsMobile();
  const isTouch = useTouchDevice();
  const touch = isMobile || isTouch;

  const [collapsed, setCollapsed] = useState(true);

  // Offline-recipient messages move to the transcript (with a marker), not the
  // outbox, so the outbox stays the actively-deliverable queue.
  const derived = useMemo(
    () => deriveActiveOutbox(messages, selfId, participants),
    [messages, selfId, participants]
  );

  const items = derived;

  const laneFor = useCallback(
    (id: string): OutboxLane => {
      if (afterTurnMessageIds?.has(id)) return "after-turn";
      return agentBusy ? "steer" : "send";
    },
    [afterTurnMessageIds, agentBusy]
  );

  // Suppress the queue until the channel is connected (replay complete — the
  // ConnectionManager only reports "connected" after `client.ready()`). During
  // the initial replay, historical self-messages are folded BEFORE their
  // read-acks, so they transiently look pending and the iris-accented queue
  // would flash into view before settling. No queue exists while disconnected
  // anyway (nothing can be flushed), so this is purely correct.
  if (!connected) return null;
  if (items.length === 0) return null;

  const summary = `${items.length} unsent`;
  const steerCount = items.filter((m) => laneFor(m.id) === "steer").length;
  const showAsCollapsed = touch && collapsed && items.length > 0;

  const itemList = (
    <Flex
      direction="column"
      gap="2"
      role="list"
      aria-label="Outbox — your unsent messages"
      className="outbox-list"
    >
      {items.map((m) => (
        <OutboxItem
          key={m.id}
          msg={m}
          participants={allParticipants}
          lane={laneFor(m.id)}
          touch={touch}
          onEdit={editPendingMessage}
          onCancel={cancelPendingMessage}
        />
      ))}
    </Flex>
  );

  return (
    <Box
      className={`outbox-root${agentBusy ? " outbox-tethered" : ""}`}
      flexShrink="0"
      data-testid="outbox"
    >
      {/* Quiet tether between the typing indicator and the outbox. */}
      {agentBusy && <Box className="outbox-tether" aria-hidden="true" />}
      {showAsCollapsed ? (
        <button
          type="button"
          className="outbox-summary-bar app-touch-target"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          aria-label={`${summary}. Tap to expand.`}
        >
          <Flex align="center" justify="between" gap="2" style={{ width: "100%" }}>
            <Text size="2" weight="medium">
              {summary}
            </Text>
            <Flex align="center" gap="2">
              {steerCount > 0 && (
                <Text size="1" color="iris">
                  {steerCount} lands this turn
                </Text>
              )}
              <ChevronUpIcon />
            </Flex>
          </Flex>
        </button>
      ) : (
        <Box className="outbox-panel">
          {touch && (
            <Flex align="center" justify="between" gap="2" className="outbox-panel-header">
              <Text size="2" weight="medium">
                {summary}
              </Text>
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                aria-label="Collapse outbox"
                onClick={() => setCollapsed(true)}
              >
                <ChevronDownIcon />
              </IconButton>
            </Flex>
          )}
          {/* Radix ScrollArea (same as the transcript) for the polished thin
              scrollbar instead of the browser's default chunky one. */}
          <ScrollArea className="outbox-scroll" scrollbars="vertical" size="1">
            {itemList}
          </ScrollArea>
          {/* Flush control lives at the foot of the queue and names its effect:
              while an agent is mid-turn it interrupts to deliver now; otherwise
              it just sends the queue. (Esc flushes too — see useChatCore.) */}
          <Button
            className="outbox-flush app-touch-target"
            size="2"
            variant="soft"
            color="iris"
            mt="2"
            style={{ width: "100%" }}
            onClick={() => void flushOutboxAndInterrupt()}
          >
            <LightningBoltIcon />
            {agentBusy ? "Send now & interrupt" : "Send now"}
          </Button>
        </Box>
      )}
    </Box>
  );
});

export { deriveOutboxMessages };
