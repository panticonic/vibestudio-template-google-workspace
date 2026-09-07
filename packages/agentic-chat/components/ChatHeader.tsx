import React, { useRef, useState } from "react";
import { Badge, Card, DropdownMenu, Flex, IconButton, Text } from "@radix-ui/themes";
import { DotsHorizontalIcon } from "@radix-ui/react-icons";
import { getVibestudioHostPlatform } from "@workspace/react/responsive";
import type { ChannelPresenceStatus, Participant } from "@workspace/pubsub";
import type { ToolApprovalProps } from "@workspace/tool-ui";
import { useChatContext } from "../context/ChatContext";
import type { ChatParticipantMetadata, PendingAgent } from "../types";
import {
  useAccountProfiles,
  type AccountProfile,
  type AccountRpc
} from "../hooks/useAccountProfiles";
import { ParticipantBadgeMenu } from "./ParticipantBadgeMenu";
import { PendingAgentBadge } from "./PendingAgentBadge";
import { ToolPermissionsDropdown } from "./ToolPermissionsDropdown";
import { ForkSwitcher } from "./ForkSwitcher";
import {
  ExternalConversationsMenu,
  externalConversationsFromMessages,
  type ExternalConversationEntry
} from "./ExternalConversationsMenu";
import { ChannelPeopleMenu } from "./ChannelPeopleMenu";
import { ConversationAgentDialogs, useConversationActions } from "./useConversationActions";

const NOOP = () => {};

function friendlyConnectionStatus(status: string): string {
  switch (status.trim().toLowerCase()) {
    case "error":
      return "Connection failed";
    case "disconnected":
      return "Offline";
    case "connecting":
    case "connecting...":
      return "Connecting…";
    case "reconnecting":
    case "reconnecting...":
      return "Reconnecting…";
    default:
      return status || "Offline";
  }
}

/** Shallow-compare two Maps by entry value (used for small maps like activeStatus). */
function mapsShallowEqual<K, V>(a: Map<K, V>, b: Map<K, V>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, val] of a) {
    if (b.get(key) !== val) return false;
  }
  return true;
}

/**
 * Chat header bar with connection status, participant badges, and actions.
 * Reads all data from ChatContext.
 *
 * The participantActiveStatus is stabilised with a ref — the previous Map
 * reference is returned when the values haven't changed so that the inner
 * React.memo boundary isn't defeated during streaming (messages changes
 * every frame but active-status rarely flips).
 */
export function ChatHeader() {
  if (getVibestudioHostPlatform() === "mobile") return null;
  return <DesktopChatHeader />;
}

function DesktopChatHeader() {
  const {
    channelId,
    channelTitle,
    connected,
    status,
    messages,
    participants,
    pendingAgents,
    toolApproval,
    onCallMethod,
    onDebugConsoleChange,
    onRemoveAgent,
    onOpenChannel,
    onListTaskRules,
    onResetTaskRules,
    chat,
    clientRef
  } = useChatContext();

  // Live account-profile projection for channel-stamped `user:<userId>`
  // participants (WP6 §6): handle/displayName/avatar/color resolve from the
  // host, so a hubControl.updateProfile re-renders here without roster rewrites.
  const participantIds = React.useMemo(() => Object.keys(participants), [participants]);
  // Cross-channel traffic for the header menu (messaging plan §4.10.7). Keyed
  // by content so streaming deltas do not defeat the inner header's memo.
  const externalConversationsKey = React.useMemo(
    () => JSON.stringify(externalConversationsFromMessages(messages)),
    [messages]
  );
  const externalConversations = React.useMemo(
    () => JSON.parse(externalConversationsKey) as ExternalConversationEntry[],
    [externalConversationsKey]
  );
  const accountProfiles = useAccountProfiles(
    (chat as { rpc?: AccountRpc } | undefined)?.rpc,
    participantIds
  );
  const [participantPresenceStatus, setParticipantPresenceStatus] = useState<
    Map<string, ChannelPresenceStatus>
  >(new Map());
  React.useEffect(() => {
    if (!connected || !channelId) {
      setParticipantPresenceStatus((current) => (current.size === 0 ? current : new Map()));
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      const client = clientRef.current;
      if (!client) return;
      try {
        const result = await client.getChannelPresence();
        if (cancelled) return;
        const next = new Map(
          result.entries.map((entry) => [entry.participantId, entry.status] as const)
        );
        setParticipantPresenceStatus((current) =>
          mapsShallowEqual(current, next) ? current : next
        );
      } catch {
        // Preserve the last durable snapshot through a transient reconnect.
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [channelId, clientRef, connected]);

  // Memoize participant active status: single reverse scan instead of O(P*M) filter per render.
  // Stabilised with a ref — return the previous Map reference when the values haven't
  // changed so that ChatHeaderInner's React.memo boundary isn't defeated during streaming.
  const prevActiveStatusRef = useRef<Map<string, boolean>>(new Map());
  const participantActiveStatus = React.useMemo(() => {
    const statusMap = new Map<string, boolean>();
    const pIds = new Set(Object.keys(participants));
    const found = new Set<string>();
    for (let i = messages.length - 1; i >= 0 && found.size < pIds.size; i--) {
      const msg = messages[i];
      if (!msg) continue;
      if (msg.kind !== "message" || !pIds.has(msg.senderId) || found.has(msg.senderId)) continue;
      statusMap.set(msg.senderId, !msg.complete && !msg.error);
      found.add(msg.senderId);
    }

    // Return previous reference if values are identical (avoids breaking memo)
    const prev = prevActiveStatusRef.current;
    if (mapsShallowEqual(prev, statusMap)) return prev;
    prevActiveStatusRef.current = statusMap;
    return statusMap;
  }, [messages, participants]);

  return (
    <ChatHeaderInner
      title={channelTitle ?? "Agentic Chat"}
      connected={connected}
      status={status}
      participants={participants}
      participantActiveStatus={participantActiveStatus}
      participantPresenceStatus={participantPresenceStatus}
      accountProfiles={accountProfiles}
      pendingAgents={pendingAgents}
      onCallMethod={onCallMethod}
      toolApproval={toolApproval}
      onRemoveAgent={onRemoveAgent}
      onDebugConsoleChange={onDebugConsoleChange}
      externalConversations={externalConversations}
      onOpenChannel={onOpenChannel}
      onListTaskRules={onListTaskRules}
      onResetTaskRules={onResetTaskRules}
    />
  );
}

// ---------- Memoized inner component ----------

interface ChatHeaderInnerProps {
  title: string;
  connected: boolean;
  status: string;
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  participantActiveStatus: Map<string, boolean>;
  participantPresenceStatus: Map<string, ChannelPresenceStatus>;
  /** Live `user:<userId>` → account profile projection (WP6 §6). */
  accountProfiles: Map<string, AccountProfile>;
  /** Other channels this conversation's agents talked to (messaging plan §4.10.7). */
  externalConversations: ExternalConversationEntry[];
  onOpenChannel?: (channelId: string, opts?: { focusMessageId?: string }) => Promise<void> | void;
  onListTaskRules?: () => Promise<Array<{ id: string; action: string; resource: string }>>;
  onResetTaskRules?: () => Promise<number>;
  pendingAgents: Map<string, PendingAgent>;
  onCallMethod?: (providerId: string, methodName: string, args: unknown) => void;
  toolApproval?: ToolApprovalProps;
  onRemoveAgent?: (handle: string) => void;
  onDebugConsoleChange?: (agentHandle: string | null) => void;
}

function chatHeaderInnerPropsEqual(
  prev: ChatHeaderInnerProps,
  next: ChatHeaderInnerProps
): boolean {
  return (
    prev.title === next.title &&
    prev.connected === next.connected &&
    prev.status === next.status &&
    prev.participants === next.participants &&
    prev.accountProfiles === next.accountProfiles &&
    prev.pendingAgents === next.pendingAgents &&
    prev.onCallMethod === next.onCallMethod &&
    prev.toolApproval === next.toolApproval &&
    prev.onRemoveAgent === next.onRemoveAgent &&
    prev.onDebugConsoleChange === next.onDebugConsoleChange &&
    prev.externalConversations === next.externalConversations &&
    prev.onOpenChannel === next.onOpenChannel &&
    prev.onListTaskRules === next.onListTaskRules &&
    prev.onResetTaskRules === next.onResetTaskRules &&
    mapsShallowEqual(prev.participantActiveStatus, next.participantActiveStatus) &&
    mapsShallowEqual(prev.participantPresenceStatus, next.participantPresenceStatus)
  );
}

const ChatHeaderInner = React.memo(function ChatHeaderInner({
  title,
  connected,
  status,
  participants,
  participantActiveStatus,
  participantPresenceStatus,
  accountProfiles,
  pendingAgents,
  onCallMethod,
  toolApproval,
  onRemoveAgent,
  onDebugConsoleChange,
  externalConversations,
  onOpenChannel,
  onListTaskRules,
  onResetTaskRules
}: ChatHeaderInnerProps) {
  const visiblePendingAgents = pendingAgents
    ? Array.from(pendingAgents.entries()).filter(([handle, _info]) => {
        // Hide pending badge if a participant with this handle already joined.
        return !Object.values(participants ?? {}).some(
          (p) => (p?.metadata?.handle as string | undefined) === handle
        );
      })
    : [];

  return (
    <Card
      className="chat-surface-card chat-header-card"
      data-part="chat-header"
      size="1"
      variant="surface"
      style={{ flexShrink: 0 }}
    >
      {/* Wide layout */}
      <Flex
        className="chat-wide-only"
        justify="between"
        align="center"
        wrap="wrap"
        gap="2"
        style={{ minWidth: 0 }}
      >
        <Flex gap="2" align="center" wrap="wrap" style={{ minWidth: 0, flex: "1 1 240px" }}>
          <Text size="4" weight="bold" style={{ minWidth: 0 }}>
            {title}
          </Text>
        </Flex>
        <Flex gap="2" align="center" wrap="wrap" style={{ minWidth: 0 }}>
          {!connected && <Badge color="gray">{friendlyConnectionStatus(status)}</Badge>}
          {Object.values(participants).map((p) => {
            const hasActive = participantActiveStatus.get(p.id) ?? false;

            return (
              <ParticipantBadgeMenu
                key={p.id}
                participant={p}
                profile={accountProfiles.get(p.id)}
                presenceStatus={participantPresenceStatus.get(p.id)}
                hasActiveMessage={hasActive}
                onCallMethod={onCallMethod ?? NOOP}
                onRemoveAgent={onRemoveAgent}
                onOpenDebugConsole={onDebugConsoleChange ?? undefined}
              />
            );
          })}
          {/* Pending/failed agents not yet in roster */}
          {visiblePendingAgents.map(([handle, info]) => (
            <PendingAgentBadge
              key={`pending-${handle}`}
              handle={handle}
              agentId={info.agentId}
              status={info.status}
              error={info.error}
              onOpenDebugConsole={onDebugConsoleChange ?? undefined}
            />
          ))}
          <ForkSwitcher />
          <ExternalConversationsMenu
            entries={externalConversations}
            onOpenChannel={onOpenChannel}
          />
          <ChatHeaderOverflowMenu
            participants={participants}
            accountProfiles={accountProfiles}
            participantPresenceStatus={participantPresenceStatus}
            toolApproval={toolApproval}
            onRemoveAgent={onRemoveAgent}
            onDebugConsoleChange={onDebugConsoleChange}
            onListTaskRules={onListTaskRules}
            onResetTaskRules={onResetTaskRules}
          />
        </Flex>
      </Flex>

      {/* Narrow layout — title + connection problem + one overflow menu */}
      <Flex
        className="chat-narrow-only"
        justify="between"
        align="center"
        gap="2"
        style={{ minWidth: 0 }}
      >
        <Flex gap="2" align="center" style={{ minWidth: 0 }}>
          <Text size="4" weight="bold" truncate style={{ minWidth: 0 }}>
            {title}
          </Text>
          {!connected && <Badge color="gray">{friendlyConnectionStatus(status)}</Badge>}
        </Flex>
        <ChatHeaderOverflowMenu
          participants={participants}
          accountProfiles={accountProfiles}
          participantPresenceStatus={participantPresenceStatus}
          toolApproval={toolApproval}
          onRemoveAgent={onRemoveAgent}
          onDebugConsoleChange={onDebugConsoleChange}
          onListTaskRules={onListTaskRules}
          onResetTaskRules={onResetTaskRules}
        />
      </Flex>
    </Card>
  );
}, chatHeaderInnerPropsEqual);

/**
 * Single overflow menu for secondary chat actions at every container width.
 */
function ChatHeaderOverflowMenu({
  participants,
  accountProfiles,
  participantPresenceStatus,
  toolApproval,
  onRemoveAgent,
  onDebugConsoleChange,
  onListTaskRules,
  onResetTaskRules
}: {
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  accountProfiles: Map<string, AccountProfile>;
  participantPresenceStatus: Map<string, ChannelPresenceStatus>;
  toolApproval?: ToolApprovalProps;
  onRemoveAgent?: (handle: string) => void;
  onDebugConsoleChange?: (agentHandle: string | null) => void;
  onListTaskRules?: () => Promise<Array<{ id: string; action: string; resource: string }>>;
  onResetTaskRules?: () => Promise<number>;
}) {
  const actions = useConversationActions({
    participants,
    accountProfiles,
    onRemoveAgent,
    onDebugConsoleChange
  });

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <IconButton
            className="chat-header-menu-button"
            variant="soft"
            color="gray"
            size="1"
            aria-label="Chat menu"
          >
            <DotsHorizontalIcon />
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          {onListTaskRules && onResetTaskRules ? (
            <TaskRulesMenu onList={onListTaskRules} onReset={onResetTaskRules} />
          ) : null}
          <ForkSwitcher variant="submenu" />
          <ChannelPeopleMenu variant="submenu" />
          {actions.participants.length > 0 && <DropdownMenu.Separator />}
          {actions.participants.map(({ participant, handle, isAgent }) => {
            const presenceStatus = participantPresenceStatus.get(participant.id);
            if (!isAgent) {
              return (
                <DropdownMenu.Item key={participant.id} disabled>
                  <Flex align="center" gap="2">
                    <span
                      aria-label={presenceStatus ?? "offline"}
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background:
                          presenceStatus === "online"
                            ? "var(--green-9)"
                            : presenceStatus === "idle"
                              ? "var(--amber-9)"
                              : presenceStatus === "away"
                                ? "var(--orange-9)"
                                : "var(--gray-8)"
                      }}
                    />
                    @{handle} · {presenceStatus ?? "offline"}
                  </Flex>
                </DropdownMenu.Item>
              );
            }
            return (
              <DropdownMenu.Sub key={participant.id}>
                <DropdownMenu.SubTrigger>@{handle}</DropdownMenu.SubTrigger>
                <DropdownMenu.SubContent>
                  <DropdownMenu.Item onSelect={() => actions.openAgentSettings(participant.id)}>
                    Settings…
                  </DropdownMenu.Item>
                  {actions.canOpenDebugConsole && (
                    <DropdownMenu.Item onSelect={() => actions.openDebugConsole(handle)}>
                      Debug Console
                    </DropdownMenu.Item>
                  )}
                  {actions.canRemoveAgent && (
                    <>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item
                        color="red"
                        onSelect={() => {
                          actions.requestRemoveAgent(handle);
                        }}
                      >
                        Remove Agent
                      </DropdownMenu.Item>
                    </>
                  )}
                </DropdownMenu.SubContent>
              </DropdownMenu.Sub>
            );
          })}
          <DropdownMenu.Separator />
          {actions.canChangeAgent && (
            <DropdownMenu.Item onSelect={actions.openAddAgent}>
              {actions.agentActionLabel}
            </DropdownMenu.Item>
          )}
          {actions.canOpenClaudeCode && (
            <DropdownMenu.Item onSelect={actions.openClaudeCode}>
              Open Claude Code
            </DropdownMenu.Item>
          )}
          {toolApproval && (
            <ToolPermissionsDropdown
              variant="submenu"
              settings={toolApproval.settings}
              onSetFloor={toolApproval.onSetFloor}
            />
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      <ConversationAgentDialogs controller={actions} />
    </>
  );
}

function TaskRulesMenu({
  onList,
  onReset
}: {
  onList: () => Promise<Array<{ id: string; action: string; resource: string }>>;
  onReset: () => Promise<number>;
}) {
  const [rules, setRules] = React.useState<Array<{ id: string; action: string; resource: string }>>(
    []
  );
  const [loaded, setLoaded] = React.useState(false);
  const refresh = React.useCallback(() => {
    void onList().then((next) => {
      setRules(next);
      setLoaded(true);
    });
  }, [onList]);
  return (
    <DropdownMenu.Sub onOpenChange={(open) => open && refresh()}>
      <DropdownMenu.SubTrigger>Chat permissions</DropdownMenu.SubTrigger>
      <DropdownMenu.SubContent>
        {!loaded ? <DropdownMenu.Item disabled>Loading…</DropdownMenu.Item> : null}
        {loaded && rules.length === 0 ? (
          <DropdownMenu.Item disabled>No saved permissions</DropdownMenu.Item>
        ) : null}
        {rules.map((rule) => (
          <DropdownMenu.Item key={rule.id} disabled>
            {rule.action} · {rule.resource}
          </DropdownMenu.Item>
        ))}
        {rules.length > 0 ? <DropdownMenu.Separator /> : null}
        <DropdownMenu.Item
          color="red"
          disabled={rules.length === 0}
          onSelect={(event) => {
            event.preventDefault();
            void onReset().then(() => {
              setRules([]);
              setLoaded(true);
            });
          }}
        >
          Reset permissions for this chat
        </DropdownMenu.Item>
      </DropdownMenu.SubContent>
    </DropdownMenu.Sub>
  );
}
