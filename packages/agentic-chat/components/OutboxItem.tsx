import React, { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Box, Button, Flex, IconButton, Text, TextArea, Tooltip } from "@radix-ui/themes";
import {
  Cross2Icon,
  LightningBoltIcon,
  LockOpen1Icon,
  Pencil1Icon,
  TimerIcon,
} from "@radix-ui/react-icons";
import type { Participant } from "@workspace/pubsub";
import { ImageGallery } from "./ImageGallery";
import { AckBadge, ReceiptIcon } from "./AckBadge";
import type { ChatMessage, ChatParticipantMetadata } from "../types";

/** UI-local lane tag set at send time — distinguishes steers from after-turn. */
export type OutboxLane = "steer" | "after-turn" | "send";

export interface OutboxItemProps {
  msg: ChatMessage;
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  /** UI lane treatment derived from send-time intent (local UI state). */
  lane: OutboxLane;
  touch?: boolean;
  onEdit: (messageId: string, newText: string) => void | Promise<void>;
  onCancel: (messageId: string) => void | Promise<void>;
}

const CLAMP_LINES = 2;

/**
 * A single outbox card: compact message-card language with the iris "you"
 * accent left rail + tint, an editable-until-read glyph, inline detailed ack
 * row, edit / cancel ghost buttons, a failed-retry state, and
 * lane treatment for "lands this turn" (steer) vs "after this turn" (deferred).
 */
export const OutboxItem = React.memo(function OutboxItem({
  msg,
  participants,
  lane,
  touch = false,
  onEdit,
  onCancel,
}: OutboxItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.content);
  const [expanded, setExpanded] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(msg.content);
      requestAnimationFrame(() => textRef.current?.focus());
    }
  }, [editing, msg.content]);

  const beginEdit = useCallback(() => setEditing(true), []);
  const cancelEdit = useCallback(() => {
    setEditing(false);
    setDraft(msg.content);
  }, [msg.content]);
  const saveEdit = useCallback(() => {
    const next = draft.trim();
    if (next && next !== msg.content) void onEdit(msg.id, next);
    setEditing(false);
  }, [draft, msg.content, msg.id, onEdit]);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        saveEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      }
    },
    [saveEdit, cancelEdit]
  );

  const hasAttachments = (msg.attachments?.length ?? 0) > 0;
  const aggregate = msg.receipts?.aggregate ?? "pending";
  const receiptStates = Object.values(msg.receipts?.byParticipant ?? {});
  const recipientHasReceived = receiptStates.some(
    (state) => state === "received" || state === "read"
  );
  const laneIsAfterTurn = lane === "after-turn";
  const laneIsSteer = lane === "steer";
  const laneLabel = laneIsAfterTurn
    ? "After this turn"
    : laneIsSteer
      ? "Lands this turn"
      : recipientHasReceived
        ? "Delivered · awaiting agent"
        : "Awaiting delivery";

  return (
    <Box
      role="listitem"
      className={[
        "outbox-item",
        laneIsAfterTurn
          ? "outbox-item-after-turn"
          : laneIsSteer
            ? "outbox-item-steer"
            : "outbox-item-send",
      ].join(" ")}
      data-lane={lane}
    >
      <Flex gap="2" align="start">
        <Flex direction="column" gap="2" style={{ flex: 1, minWidth: 0 }}>
          {/* Lane + editable-until-read header */}
          <Flex align="center" justify="between" gap="2">
            <Flex align="center" gap="2">
              <Badge
                size="1"
                variant="soft"
                color={laneIsAfterTurn || !laneIsSteer ? "gray" : "iris"}
                className="outbox-lane-badge"
              >
                {laneIsSteer ? <LightningBoltIcon /> : <TimerIcon />}
                <Text size="1">{laneLabel}</Text>
              </Badge>
              {/* Editable-until-read micro-state: an unlock/clock glyph that
                  resolves into the read check the instant any recipient reads. */}
              <Tooltip
                content={
                  aggregate === "pending"
                    ? "Editable until read"
                    : "Read — the agent is now thinking with it"
                }
              >
                <Box
                  className={`outbox-editable-glyph outbox-editable-${aggregate}`}
                  aria-hidden="true"
                >
                  {aggregate === "pending" ? <LockOpen1Icon /> : <ReceiptIcon state="read" />}
                </Box>
              </Tooltip>
            </Flex>
            {/* Right cluster: compact delivery badge + edit/cancel — receipts
                live in this top bar (not a bottom row) to save vertical space. */}
            <Flex align="center" gap="1" style={{ flexShrink: 0 }} aria-live="polite">
              {msg.receipts && (
                <AckBadge
                  receipts={msg.receipts}
                  participants={participants}
                  mode="compact"
                  touch={touch}
                />
              )}
              {!editing && (
                <Flex align="center" gap="1" className="outbox-item-actions">
                  <IconButton
                    size="1"
                    variant="ghost"
                    color="gray"
                    className="app-touch-target"
                    aria-label="Edit message"
                    title="Edit"
                    onClick={beginEdit}
                  >
                    <Pencil1Icon />
                  </IconButton>
                  <IconButton
                    size="1"
                    variant="ghost"
                    color="gray"
                    className="app-touch-target"
                    aria-label="Cancel message"
                    title="Cancel"
                    onClick={() => void onCancel(msg.id)}
                  >
                    <Cross2Icon />
                  </IconButton>
                </Flex>
              )}
            </Flex>
          </Flex>

          {/* Body: inline edit or clamped content */}
          {editing ? (
            <Flex direction="column" gap="2">
              <TextArea
                ref={textRef}
                size="2"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleEditKeyDown}
                style={{ resize: "none" }}
              />
              <Flex gap="2" justify="end">
                <Button size="1" variant="soft" color="gray" onClick={cancelEdit}>
                  Cancel
                </Button>
                <Button size="1" variant="solid" onClick={saveEdit}>
                  Save
                </Button>
              </Flex>
            </Flex>
          ) : (
            msg.content.length > 0 && (
              <Box className="outbox-item-body">
                <Text
                  size="2"
                  className={expanded ? "outbox-item-text" : "outbox-item-text outbox-item-clamp"}
                  style={
                    expanded
                      ? { whiteSpace: "pre-wrap" }
                      : {
                          display: "-webkit-box",
                          WebkitLineClamp: CLAMP_LINES,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }
                  }
                >
                  {msg.content}
                </Text>
                {msg.content.length > 120 && (
                  <Button
                    size="1"
                    variant="ghost"
                    color="gray"
                    onClick={() => setExpanded((v) => !v)}
                  >
                    {expanded ? "Show less" : "Show more"}
                  </Button>
                )}
              </Box>
            )
          )}

          {hasAttachments && !editing && <ImageGallery attachments={msg.attachments!} />}
        </Flex>
      </Flex>
    </Box>
  );
});
