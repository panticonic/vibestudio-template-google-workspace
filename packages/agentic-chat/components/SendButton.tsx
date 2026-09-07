import React, { useMemo } from "react";
import { Box, Button, DropdownMenu, Flex, IconButton, Kbd, Text } from "@radix-ui/themes";
import {
  ChevronDownIcon,
  ImageIcon,
  LightningBoltIcon,
  PaperPlaneIcon,
  TimerIcon,
} from "@radix-ui/react-icons";
import type { PrimaryActionIntent } from "../types";
import { isMacPlatform, shortcutLabel } from "../utils/platform.js";

export interface SendButtonProps {
  /** What pressing Enter does right now — drives the primary label/icon. */
  intent: PrimaryActionIntent;
  /** Whether any agent is busy (enables interrupt / after-turn rows). */
  agentBusy: boolean;
  /** Whether there is an open/waiting turn that can accept after-turn delivery. */
  canSendAfterTurn?: boolean;
  /** Disable the options chevron independently from the primary send button. */
  optionsDisabled?: boolean;
  disabled?: boolean;
  size?: "2" | "3";
  /** Default send (Enter): steers if the agent is mid-turn. */
  onSend: () => void;
  /** Send after turn (Cmd/Ctrl+Shift+Enter): queue until the turn closes. */
  onSendAfterTurn: () => void;
  /** Toggle the image attachment panel (lives in this menu to keep the row tidy). */
  onAttach?: () => void;
  /** Count of images currently attached, shown on the menu item. */
  attachmentCount?: number;
}

const PRIMARY: Record<PrimaryActionIntent, { label: string; Icon: typeof PaperPlaneIcon }> = {
  send: { label: "Send", Icon: PaperPlaneIcon },
  steer: { label: "Steer", Icon: LightningBoltIcon },
  queue: { label: "Queue after turn", Icon: TimerIcon },
};

/**
 * Split send control that previews its real consequence instead of always
 * saying "Send". Primary button morphs label/icon with a short cross-fade as
 * `intent` changes; an adjacent chevron opens the alternate modes. When an
 * agent is busy the chevron carries a small accent dot.
 */
export const SendButton = React.memo(function SendButton({
  intent,
  agentBusy,
  canSendAfterTurn = agentBusy,
  optionsDisabled,
  disabled = false,
  size = "2",
  onSend,
  onSendAfterTurn,
  onAttach,
  attachmentCount = 0,
}: SendButtonProps) {
  const mac = useMemo(() => isMacPlatform(), []);
  const { label, Icon } = PRIMARY[intent];
  const menuDisabled = optionsDisabled ?? (disabled && !onAttach);

  const enterKbd = shortcutLabel({ enter: true }, mac);
  const afterTurnKbd = shortcutLabel({ mod: true, shift: true, enter: true }, mac);

  return (
    <Flex className="send-button-group" align="center" gap="0">
      <Button
        className="send-button-primary"
        size={size}
        variant="solid"
        disabled={disabled}
        onClick={onSend}
        title={
          intent === "steer"
            ? "Send now; steers the agent mid-turn"
            : intent === "queue"
              ? "Queue this message to send after the current turn"
              : "Send message"
        }
        aria-label={`${label} (${enterKbd})`}
      >
        {/* keyed span so the morph cross-fades rather than hard-swaps. Icon
            only — the action is conveyed by the morphing glyph + aria-label. */}
        <Box asChild className="send-button-morph" key={intent}>
          <span style={{ display: "inline-flex", alignItems: "center" }}>
            <Icon />
          </span>
        </Box>
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <IconButton
            className="send-button-chevron"
            size={size}
            color="gray"
            variant="soft"
            disabled={menuDisabled}
            aria-label="Send options"
            title="Send options"
          >
            <Box position="relative" asChild>
              <span>
                <ChevronDownIcon />
                {agentBusy && <span className="send-button-accent-dot" aria-hidden="true" />}
              </span>
            </Box>
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content size="2" align="end" className="send-button-menu">
          <SendMenuRow
            Icon={PaperPlaneIcon}
            label="Send"
            kbd={enterKbd}
            secondary="Send now; steers if the agent is mid-turn."
            onSelect={onSend}
            disabled={disabled}
          />
          <SendMenuRow
            Icon={TimerIcon}
            label="Send after turn"
            kbd={afterTurnKbd}
            secondary="Let the agent finish, then send."
            onSelect={onSendAfterTurn}
            disabled={disabled || !canSendAfterTurn}
          />
          {onAttach && (
            <>
              <DropdownMenu.Separator />
              <DropdownMenu.Item className="send-menu-row" onSelect={() => onAttach()}>
                <Flex align="center" gap="2">
                  <ImageIcon />
                  <Text size="2" weight="medium">
                    {attachmentCount > 0 ? `Images attached (${attachmentCount})` : "Attach image…"}
                  </Text>
                </Flex>
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </Flex>
  );
});

function SendMenuRow({
  Icon,
  label,
  kbd,
  secondary,
  onSelect,
  disabled = false,
}: {
  Icon: typeof PaperPlaneIcon;
  label: string;
  kbd: string;
  secondary: string;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu.Item className="send-menu-row" disabled={disabled} onSelect={() => onSelect()}>
      <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
        <Flex align="center" justify="between" gap="3">
          <Flex align="center" gap="2">
            <Icon />
            <Text size="2" weight="medium">
              {label}
            </Text>
          </Flex>
          <Kbd size="1">{kbd}</Kbd>
        </Flex>
        <Text size="1" color="gray">
          {secondary}
        </Text>
      </Flex>
    </DropdownMenu.Item>
  );
}
