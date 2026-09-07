import React, { useMemo } from "react";
import { Badge, Box, Flex, HoverCard, Popover, Text } from "@radix-ui/themes";
import {
  CheckCircledIcon,
  CheckIcon,
  ClockIcon,
} from "@radix-ui/react-icons";
import type { Participant } from "@workspace/pubsub";
import { isAgentParticipantType } from "@workspace/pubsub";
import type { ChatMessage, ChatParticipantMetadata } from "../types";

export type ReceiptState = "pending" | "received" | "read";
export type ReceiptAggregate = "pending" | "partial" | "read";

export interface AckBadgeProps {
  receipts: NonNullable<ChatMessage["receipts"]>;
  /** Roster used to resolve participant keys → display name / type. */
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  /**
   * - `compact`: a single soft badge (single recipient) or a stacked avatar
   *   cluster with an aggregate check overlay (multi). Opens a HoverCard
   *   (hover devices) / Popover (touch) with per-recipient rows.
   * - `detailed`: per-recipient chips rendered inline (outbox).
   */
  mode?: "compact" | "detailed";
  /** Touch devices use a tap-to-open Popover instead of hover. */
  touch?: boolean;
}

interface RecipientRow {
  key: string;
  name: string;
  isAgent: boolean;
  state: ReceiptState;
  /** Recipient has left the live roster while still un-read — its delivery is
   *  deferred until it returns (then its read-ack clears this automatically). */
  offline: boolean;
}

const STATE_ORDER: Record<ReceiptState, number> = { read: 0, received: 1, pending: 2 };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Lightweight initials avatar — avoids Radix Avatar's hydration tracking. */
function InitialsAvatar({ name }: { name: string }) {
  return (
    <Box className="ack-avatar" aria-hidden="true">
      <Text size="1" weight="medium">
        {initials(name)}
      </Text>
    </Box>
  );
}

/** Distinct SHAPE per state (status is never color-only). */
export function ReceiptIcon({ state, offline }: { state: ReceiptState; offline?: boolean }) {
  if (offline) {
    // Awaiting the recipient's return — amber clock distinguishes it from the
    // gray "pending" (in-flight to a present recipient) clock.
    return (
      <Box asChild className="ack-icon ack-icon-offline" style={{ color: "var(--amber-11)" }}>
        <span aria-hidden="true">
          <ClockIcon />
        </span>
      </Box>
    );
  }
  if (state === "read") {
    return (
      <Box asChild className="ack-icon ack-icon-read" style={{ color: "var(--grass-11)" }}>
        <span aria-hidden="true">
          <CheckCircledIcon />
        </span>
      </Box>
    );
  }
  if (state === "received") {
    return (
      <Box asChild className="ack-icon ack-icon-received" style={{ color: "var(--gray-11)" }}>
        <span aria-hidden="true">
          <CheckIcon />
        </span>
      </Box>
    );
  }
  return (
    <Box asChild className="ack-icon ack-icon-pending" style={{ color: "var(--gray-a9)" }}>
      <span aria-hidden="true">
        <ClockIcon />
      </span>
    </Box>
  );
}

/** Human label for a recipient's state. Agents "take into account", not "read". */
function stateLabel(state: ReceiptState, isAgent: boolean, offline?: boolean): string {
  if (offline) return "offline — delivers on return";
  if (state === "read") return isAgent ? "taken into account" : "read";
  if (state === "received") return "received";
  return "pending";
}

function aggregateLabel(rows: RecipientRow[]): string {
  if (rows.length === 1) {
    const r = rows[0]!;
    return `${r.name}: ${stateLabel(r.state, r.isAgent, r.offline)}`;
  }
  // Offline recipients are counted separately from in-flight "pending".
  const read = rows.filter((r) => r.state === "read");
  const offline = rows.filter((r) => r.offline);
  const received = rows.filter((r) => r.state === "received" && !r.offline);
  const pending = rows.filter((r) => r.state === "pending" && !r.offline);
  const parts: string[] = [];
  if (read.length) parts.push(`${read.length} read`);
  if (received.length) parts.push(`${received.length} received`);
  if (pending.length) parts.push(`${pending.length} pending`);
  if (offline.length) parts.push(`${offline.length} offline`);
  return `Delivery: ${parts.join(", ")} of ${rows.length}`;
}

function buildRows(
  receipts: NonNullable<ChatMessage["receipts"]>,
  participants: Record<string, Participant<ChatParticipantMetadata>>
): RecipientRow[] {
  const rows: RecipientRow[] = Object.entries(receipts.byParticipant).map(([key, state]) => {
    const participant = participants[key];
    const name =
      participant?.metadata.name ??
      participant?.metadata.handle ??
      // Keys may be `${kind}:${id}`; strip the kind prefix for display.
      key.replace(/^[a-z]+:/, "");
    const isAgent = isAgentParticipantType(participant?.metadata.type);
    // Absent from the (live) roster while still un-read ⇒ offline. `participants`
    // is the present roster here, so a missing key means the recipient left.
    const offline = state !== "read" && !(key in participants);
    return { key, name, isAgent, state, offline };
  });
  rows.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name));
  return rows;
}

function RecipientRows({ rows }: { rows: RecipientRow[] }) {
  return (
    <Flex direction="column" gap="2" role="list" aria-label="Per-recipient delivery state">
      {rows.map((row) => (
        <Flex key={row.key} role="listitem" align="center" justify="between" gap="3">
          <Flex align="center" gap="2" style={{ minWidth: 0 }}>
            <InitialsAvatar name={row.name} />
            <Text size="2" truncate>
              {row.name}
            </Text>
          </Flex>
          <Flex align="center" gap="1">
            <ReceiptIcon state={row.state} offline={row.offline} />
            <Text size="1" color={row.offline ? "amber" : "gray"}>
              {stateLabel(row.state, row.isAgent, row.offline)}
            </Text>
          </Flex>
        </Flex>
      ))}
    </Flex>
  );
}

/** A small stacked avatar cluster with an aggregate check overlay. */
function AvatarStack({ rows, aggregate }: { rows: RecipientRow[]; aggregate: ReceiptAggregate }) {
  const shown = rows.slice(0, 3);
  const overflow = rows.length - shown.length;
  const overlayState: ReceiptState =
    aggregate === "read" ? "read" : aggregate === "partial" ? "received" : "pending";
  return (
    <Flex align="center" className="ack-avatar-stack" gap="0">
      {shown.map((row, i) => (
        <Box
          key={row.key}
          className="ack-avatar-stack-item"
          style={{ marginLeft: i === 0 ? 0 : -6, zIndex: shown.length - i }}
          data-state={row.state}
        >
          <InitialsAvatar name={row.name} />
        </Box>
      ))}
      {overflow > 0 && (
        <Text size="1" color="gray" style={{ marginLeft: 4 }}>
          +{overflow}
        </Text>
      )}
      <Box
        className={`ack-aggregate-overlay ack-pop-${overlayState}`}
        style={{ marginLeft: 4 }}
        key={`overlay-${overlayState}`}
      >
        <ReceiptIcon state={overlayState} />
      </Box>
    </Flex>
  );
}

/**
 * Delivery / acknowledgment badge. Status is conveyed by distinct SHAPES, not
 * color alone. Single recipient renders as one soft Radix Badge; multi renders
 * a stacked avatar cluster opening a HoverCard / Popover with per-recipient
 * rows and an aria-label spelling out every recipient's state.
 */
export const AckBadge = React.memo(function AckBadge({
  receipts,
  participants,
  mode = "compact",
  touch = false,
}: AckBadgeProps) {
  const rows = useMemo(() => buildRows(receipts, participants), [receipts, participants]);
  if (rows.length === 0) return null;

  const ariaLabel = aggregateLabel(rows);

  // --- Detailed (outbox): per-recipient chips inline, no extra surface. ---
  if (mode === "detailed") {
    return (
      <Flex
        className="ack-badge-detailed"
        align="center"
        gap="1"
        wrap="wrap"
        role="group"
        aria-label={ariaLabel}
      >
        {rows.map((row) => (
          <Badge
            key={row.key}
            size="1"
            variant="soft"
            color={row.offline ? "amber" : row.state === "read" ? "grass" : "gray"}
            className={`ack-chip ack-pop-${row.state}`}
            title={row.offline ? `${row.name}: offline — delivers on return` : undefined}
          >
            <ReceiptIcon state={row.state} offline={row.offline} />
            <Text size="1">{row.name}</Text>
          </Badge>
        ))}
      </Flex>
    );
  }

  // --- Compact single recipient: one soft badge. ---
  if (rows.length === 1) {
    const row = rows[0]!;
    return (
      <Badge
        size="1"
        variant="soft"
        color={row.offline ? "amber" : row.state === "read" ? "grass" : "gray"}
        className={`ack-badge-compact ack-badge-icon-only ack-pop-${row.state}`}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        {/* Icon only — state reads as shape + color (a green check when read,
            an amber clock when offline); the wordy label is in aria-label/title. */}
        <ReceiptIcon state={row.state} offline={row.offline} />
      </Badge>
    );
  }

  // --- Compact multi recipient: stacked avatars opening a detail surface. ---
  const trigger = (
    <Box
      asChild
      className="ack-badge-trigger app-touch-target"
      aria-label={ariaLabel}
      tabIndex={0}
    >
      <button type="button" style={{ background: "none", border: "none", padding: 2, cursor: "pointer" }}>
        <AvatarStack rows={rows} aggregate={receipts.aggregate} />
      </button>
    </Box>
  );

  if (touch) {
    return (
      <Popover.Root>
        <Popover.Trigger>{trigger}</Popover.Trigger>
        <Popover.Content size="1" className="ack-detail-surface" style={{ minWidth: 220 }}>
          <RecipientRows rows={rows} />
        </Popover.Content>
      </Popover.Root>
    );
  }

  return (
    <HoverCard.Root openDelay={120} closeDelay={80}>
      <HoverCard.Trigger>{trigger}</HoverCard.Trigger>
      <HoverCard.Content size="1" className="ack-detail-surface" style={{ minWidth: 220 }}>
        <RecipientRows rows={rows} />
      </HoverCard.Content>
    </HoverCard.Root>
  );
});
