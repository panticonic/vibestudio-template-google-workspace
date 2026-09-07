import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Box, Button, Flex, ScrollArea, Text } from "@radix-ui/themes";
import type { Participant } from "@workspace/pubsub";
import { useStickToBottom } from "../hooks/useStickToBottom.js";
import { useScrollAnchor, type ScrollAnchorItem } from "../hooks/useScrollAnchor.js";
import { InlineGroup, type InlineItem, type InvocationRenderer } from "./InlineGroup";
import { NewContentIndicator } from "./NewContentIndicator";
import { MessageCard } from "./MessageCard";
import { SubagentRunCard } from "./SubagentRunCard";
import { TaskRunCard } from "./TaskRunCard";
import type { InvocationCardPayload } from "@workspace/agentic-core";
import type {
  BrowserHandoffCaller,
  ChannelParticipantId,
  ChatMessage,
  ChatParticipantMetadata,
  InlineUiComponentEntry,
  MessageTypeComponentEntry,
} from "../types";
import type { MdxActionHandlers } from "./markdownComponents";
import { useAccountProfiles, type AccountRpc } from "../hooks/useAccountProfiles";

// Grouped item types produced by the grouping logic
type GroupedItem =
  | {
      type: "inline-group";
      items: Array<{ msg: ChatMessage; index: number }>;
      inlineItems: InlineItem[];
      key: string;
    }
  | { type: "chat-message"; msg: ChatMessage; index: number };
const INITIAL_RENDERED_ITEMS = 200;

// --- Grouping helper functions (module-level for reuse by fast paths) ---

type InlineItemType = "thinking" | "toolcall-progress" | "invocation" | "typing" | "custom";

function getInlineItemType(msg: ChatMessage): InlineItemType | null {
  if (msg.contentType === "thinking") return "thinking";
  if (msg.contentType === "toolcall-progress") return "toolcall-progress";
  if (msg.contentType === "task") return null;
  if (msg.contentType === "invocation") return "invocation";
  if (msg.contentType === "typing") return "typing";
  if (msg.contentType === "custom" && msg.custom?.displayMode === "inline") return "custom";
  return null;
}

function isTypingMessage(msg: ChatMessage): boolean {
  return msg.contentType === "typing";
}

function messageSignature(msg: ChatMessage): string {
  const customUpdatedAt = msg.custom
    ? JSON.stringify([msg.custom.initialState ?? null, msg.custom.lastSeq, msg.custom.updates])
    : "";
  return [
    msg.contentType ?? "",
    msg.kind ?? "",
    msg.content,
    msg.complete ? "1" : "0",
    // Include every field that affects grouped rendering so receipt / edit /
    // retract changes re-memo the row (tier was previously omitted).
    msg.error ?? "",
    msg.tier ?? "",
    msg.receipts?.aggregate ?? "",
    msg.receipts ? JSON.stringify(msg.receipts.byParticipant) : "",
    msg.retracted ? "1" : "0",
    msg.revision ?? "",
    msg.editedAt ?? "",
    msg.automation ? JSON.stringify(msg.automation) : "",
    customUpdatedAt,
  ].join("\u001f");
}

function groupedItemAnchorId(item: GroupedItem): string {
  if (item.type === "inline-group") return item.key;
  return item.msg.id;
}

function groupedItemSignature(item: GroupedItem): string {
  if (item.type === "inline-group") {
    return item.items.map(({ msg }) => `${msg.id}:${messageSignature(msg)}`).join("\u001e");
  }
  return messageSignature(item.msg);
}

/** Transform an inline group's messages into InlineItem[] */
function buildInlineItems(items: Array<{ msg: ChatMessage; index: number }>): InlineItem[] {
  return items.flatMap(({ msg }) => {
    if (msg.contentType === "invocation") {
      if (!msg.invocation) return [];
      return {
        type: "invocation" as const,
        id: msg.id,
        invocation: msg.invocation,
        complete: msg.complete ?? false,
        senderId: msg.senderId,
      };
    }
    if (msg.contentType === "typing") {
      return {
        type: "typing" as const,
        id: msg.id,
        data: {
          senderId: msg.senderId,
          senderName: msg.senderMetadata?.name,
          senderType: msg.senderMetadata?.type,
        },
        senderId: msg.senderId,
      };
    }
    if (msg.contentType === "custom") {
      if (!msg.custom || msg.custom.displayMode !== "inline") return [];
      return {
        type: "custom" as const,
        id: msg.id,
        payload: msg.custom,
      };
    }
    if (msg.contentType === "toolcall-progress") {
      return {
        type: "toolcall-progress" as const,
        id: msg.id,
        content: msg.content,
      };
    }
    return {
      type: "thinking" as const,
      id: msg.id,
      content: msg.content,
      complete: msg.complete ?? false,
    };
  });
}

function pushInlineGroup(
  result: GroupedItem[],
  items: Array<{ msg: ChatMessage; index: number }>
): void {
  if (items.length === 0) return;
  const inlineItems = buildInlineItems(items);
  if (inlineItems.length === 0) return;
  result.push({
    type: "inline-group",
    items,
    inlineItems,
    key: `inline-group-${items[0]!.msg.id || items[0]!.index}`,
  });
}

/** Full grouping computation — scans all messages from scratch */
function fullGroupComputation(messages: ChatMessage[]): GroupedItem[] {
  const result: GroupedItem[] = [];
  let currentInlineGroup: Array<{ msg: ChatMessage; index: number }> = [];

  messages.forEach((msg, index) => {
    if (isTypingMessage(msg)) {
      if (currentInlineGroup.length > 0) {
        pushInlineGroup(result, currentInlineGroup);
        currentInlineGroup = [];
      }
      pushInlineGroup(result, [{ msg, index }]);
      return;
    }

    const inlineType = getInlineItemType(msg);

    if (inlineType !== null) {
      currentInlineGroup.push({ msg, index });
    } else {
      if (currentInlineGroup.length > 0) {
        pushInlineGroup(result, currentInlineGroup);
        currentInlineGroup = [];
      }
      result.push({ type: "chat-message", msg, index });
    }
  });

  if (currentInlineGroup.length > 0) {
    pushInlineGroup(result, currentInlineGroup);
  }

  return result;
}

/**
 * Roster fallback for participants that expose ephemeral typing metadata.
 * Durable `turn.opened` / `turn.closed` events are projected into
 * `contentType: "typing"` messages and take precedence for agent turns.
 */
function buildActiveTypingItems(
  participants: Record<string, Participant<ChatParticipantMetadata>>,
  selfId: string | null
): InlineItem[] {
  const items: InlineItem[] = [];
  for (const [pid, p] of Object.entries(participants)) {
    if (!p.metadata.typing) continue;
    if (pid === selfId) continue;
    items.push({
      type: "typing" as const,
      id: `typing-${pid}`,
      data: {
        senderId: pid,
        senderName: p.metadata.name,
        senderType: p.metadata.type,
      },
      senderId: pid,
    });
  }
  return items;
}

/** Sender info returned by getSenderInfo */
export interface SenderInfo {
  name: string;
  type: "panel" | "headless" | "agent" | "unknown";
  handle: string;
  /** Live account tint (WP6 §6) — present for `user:<userId>` senders. */
  color?: string;
  /** Live inline `data:` URI avatar (WP0 §3.8) — present for human senders. */
  avatar?: string;
}

export interface MessageListProps {
  messages: ChatMessage[];
  /** Current active roster — typing indicators are derived from participant metadata */
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  /** This client's participant ID — excluded from typing display */
  selfId: ChannelParticipantId | null;
  allParticipants: Record<string, Participant<ChatParticipantMetadata>>;
  inlineUiComponents?: Map<string, InlineUiComponentEntry>;
  messageTypeComponents?: Map<string, MessageTypeComponentEntry>;
  chat?: Record<string, unknown>;
  browserHandoffCaller?: BrowserHandoffCaller;
  hasMoreHistory?: boolean;
  loadingMore?: boolean;
  onLoadEarlierMessages?: () => void | Promise<void>;
  onInterrupt?: (agentId: string, messageId?: string, agentHandle?: string) => void;
  onCancelInvocation?: (invocation: InvocationCardPayload, senderId: string) => void;
  onFocusPanel?: (panelId: string) => void;
  onReloadPanel?: (panelId: string) => void;
  onReply?: (messageId: string) => void;
  mdxActions?: MdxActionHandlers;
  /** Replace, wrap, or elide a message using its complete stock renderer. */
  renderMessage?: (
    msg: ChatMessage,
    senderInfo: SenderInfo,
    defaultContent: React.ReactNode
  ) => React.ReactNode;
  /** Replace, wrap, or elide an inline group using its complete stock renderer. */
  renderInlineGroup?: (items: InlineItem[], defaultContent: React.ReactNode) => React.ReactNode;
  /** Override individual invocation rendering while retaining the stock group. */
  renderInvocation?: InvocationRenderer;
  /** Override the empty-transcript placeholder (e.g. while an agent is launching). */
  emptyState?: React.ReactNode;
  /** Envelope to scroll to and highlight once it is rendered (messaging plan
   *  §4.5/§4.10). Consumed through `onFocusMessageConsumed`. */
  focusMessageId?: string;
  onFocusMessageConsumed?: (messageId: string) => void;
}

interface GroupedMessageRowProps {
  item: GroupedItem;
  index: number;
  copied: boolean;
  renderItem: (index: number, copied: boolean) => React.ReactNode;
}

/**
 * Dynamic-height rows stay in normal document flow for scroll anchoring, but
 * unchanged rows no longer rerender when a streaming tail message is replaced.
 */
const GroupedMessageRow = React.memo(function GroupedMessageRow({
  item,
  index,
  copied,
  renderItem,
}: GroupedMessageRowProps) {
  return (
    <div
      className="message-item"
      data-scroll-anchor-id={groupedItemAnchorId(item)}
      key={item.type === "inline-group" ? item.key : item.msg.id || `msg-${index}`}
    >
      {renderItem(index, copied)}
    </div>
  );
});

/**
 * MessageList — the core message rendering area, wrapped in React.memo.
 *
 * This component owns:
 * - Scroll tracking and auto-scroll logic
 * - Message grouping (groupedItems useMemo)
 * - The rendering loop over grouped items
 * - Copy-to-clipboard state (copiedMessageId)
 * - "New content" indicator
 *
 * Critically, it does NOT receive `input` as a prop, so keystroke-driven
 * re-renders in the parent stop at this memo boundary.
 */
export const MessageList = React.memo(function MessageList({
  messages,
  participants,
  selfId,
  allParticipants,
  inlineUiComponents,
  messageTypeComponents,
  chat,
  browserHandoffCaller,
  hasMoreHistory,
  loadingMore,
  onLoadEarlierMessages,
  onInterrupt,
  onCancelInvocation,
  onFocusPanel,
  onReloadPanel,
  onReply,
  mdxActions,
  renderMessage: customRenderMessage,
  renderInlineGroup: customRenderInlineGroup,
  renderInvocation,
  emptyState,
  focusMessageId,
  onFocusMessageConsumed,
}: MessageListProps) {
  // --- Scroll state ---
  const [showNewContent, setShowNewContent] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const { scrollRef, contentRef, scrollToBottom, isAtBottom, isAtBottomRef } = useStickToBottom({
    initial: "instant",
    resize: "instant",
  });

  // Refs for auto-load on scroll to top (keeps handleScroll stable)
  const hasMoreHistoryRef = useRef(hasMoreHistory);
  const loadingMoreRef = useRef(loadingMore);
  const onLoadEarlierMessagesRef = useRef(onLoadEarlierMessages);
  const localHistoryHiddenRef = useRef(false);
  const revealLocalHistoryRef = useRef<() => void>(() => {});
  hasMoreHistoryRef.current = hasMoreHistory;
  loadingMoreRef.current = loadingMore;
  onLoadEarlierMessagesRef.current = onLoadEarlierMessages;

  const handleViewportScroll = useCallback(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    if (viewport.scrollTop >= 200 || loadingMoreRef.current) return;
    if (localHistoryHiddenRef.current) {
      revealLocalHistoryRef.current();
    } else if (hasMoreHistoryRef.current) {
      void onLoadEarlierMessagesRef.current?.();
    }
  }, [scrollRef]);

  // Attach scroll listener
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) {
      return;
    }

    viewport.addEventListener("scroll", handleViewportScroll, { passive: true });
    handleViewportScroll();
    return () => viewport.removeEventListener("scroll", handleViewportScroll);
  }, [handleViewportScroll, scrollRef, hasMoreHistory, loadingMore]);

  useEffect(() => {
    if (isAtBottom) {
      setShowNewContent(false);
    }
  }, [isAtBottom]);

  // Land on a requested envelope once it is in the DOM (messaging plan §4.5,
  // §4.10): scroll it into view, mark it briefly, and tell the host it was
  // honoured so the request does not replay on the next mount.
  const focusConsumedRef = useRef(onFocusMessageConsumed);
  focusConsumedRef.current = onFocusMessageConsumed;
  useEffect(() => {
    if (!focusMessageId) return;
    if (!messages.some((message) => message.id === focusMessageId)) return;
    const element = document.getElementById(`message-${focusMessageId}`);
    if (!element) return;
    element.scrollIntoView({ block: "center" });
    element.classList.add("message-row-focused");
    const timer = setTimeout(() => element.classList.remove("message-row-focused"), 2500);
    focusConsumedRef.current?.(focusMessageId);
    return () => clearTimeout(timer);
  }, [focusMessageId, messages]);

  // Scroll to the latest content when the indicator is clicked.
  const handleScrollToNewContent = useCallback(() => {
    void scrollToBottom({ animation: "instant" });
    setShowNewContent(false);
  }, [scrollToBottom]);

  // --- Copy handler (local to MessageList) ---
  const handleCopyMessage = useCallback(async (messageId: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageId(messageId);
    } catch (err) {
      console.error("Failed to copy message:", err);
    }
  }, []);
  const handleClearCopiedMessage = useCallback((messageId: string) => {
    setCopiedMessageId((current) => (current === messageId ? null : current));
  }, []);

  // --- Live account profiles for `user:<userId>` senders (WP6 §6) ---
  // The channel stores only the stable id; handle/displayName/avatar/color
  // resolve from the host projection, so a profile edit re-renders the
  // transcript without any roster or message rewrite.
  const senderParticipantIds = useMemo(() => {
    const ids = new Set<string>(Object.keys(allParticipants));
    for (const msg of messages) ids.add(msg.senderId);
    return [...ids];
  }, [allParticipants, messages]);
  const accountProfiles = useAccountProfiles(
    (chat as { rpc?: AccountRpc } | undefined)?.rpc,
    senderParticipantIds
  );

  // --- Sender info lookup ---
  // Falls back to the message's senderMetadata snapshot (populated from events
  // and history) before defaulting, so historical messages from agents align
  // correctly on reload even when the original participant left the roster.
  const getSenderInfo = useCallback(
    (senderId: string, msg?: ChatMessage) => {
      const live = allParticipants[senderId]?.metadata;
      const stored = msg?.senderMetadata;
      // Merge stored snapshot (immutable, from DB — always has correct type)
      // with live roster (may be fresher, but empty {} during join→metadata gap).
      // Stored is absent for locally-created messages not yet persisted;
      // live is {} during the connection setup window.
      const base = {
        name: "Unknown",
        type: "unknown" as const,
        handle: "unknown",
        ...(stored?.type ? stored : {}),
        ...(live?.type ? live : {}),
      };
      // Human senders: the live account projection wins over any snapshot —
      // one source of truth for who authored a message (WP6 §3/§6).
      const profile = accountProfiles.get(senderId);
      if (profile) {
        return {
          ...base,
          name: profile.displayName,
          handle: profile.handle,
          ...(profile.color !== undefined ? { color: profile.color } : {}),
          ...(profile.avatar !== undefined ? { avatar: profile.avatar } : {}),
        };
      }
      return base;
    },
    [allParticipants, accountProfiles]
  );

  // --- Interrupt handler ---
  const handleInterruptMessage = useCallback(
    (msgId: string, senderId: string) => {
      const handle = allParticipants[senderId]?.metadata?.handle;
      onInterrupt?.(senderId, msgId, handle);
    },
    [onInterrupt, allParticipants]
  );

  // Stable callback for interrupting typing indicators
  const handleTypingInterrupt = useCallback(
    (senderId: string) => {
      const handle = allParticipants[senderId]?.metadata?.handle;
      onInterrupt?.(senderId, undefined, handle);
    },
    [allParticipants, onInterrupt]
  );

  // --- Message grouping (with incremental fast paths) ---
  const prevGroupCacheRef = useRef<{
    messages: ChatMessage[];
    result: GroupedItem[];
  } | null>(null);

  const groupedItems = useMemo(() => {
    const cache = prevGroupCacheRef.current;

    // Fast path A: streaming update — same array length, only last message changed.
    // During streaming, the messages array is replaced with a new reference where only
    // the last element has updated content. All prior elements are reference-equal.
    if (cache && cache.messages.length === messages.length && messages.length > 0) {
      let onlyLastChanged = true;
      for (let i = 0; i < messages.length - 1; i++) {
        if (messages[i] !== cache.messages[i]) {
          onlyLastChanged = false;
          break;
        }
      }
      if (onlyLastChanged) {
        const lastMsg = messages[messages.length - 1]!;
        const lastItem = cache.result[cache.result.length - 1];
        const lastMsgInlineType = getInlineItemType(lastMsg);
        // If the last grouped item is a regular message with the same id, swap it in-place.
        // Also verify the message hasn't transitioned to an inline type.
        if (
          lastItem?.type === "chat-message" &&
          lastItem.msg.id === lastMsg.id &&
          lastMsgInlineType === null
        ) {
          const result = cache.result.slice(); // shallow copy
          result[result.length - 1] = {
            type: "chat-message",
            msg: lastMsg,
            index: messages.length - 1,
          };
          prevGroupCacheRef.current = { messages, result };
          return result;
        }
        // If it's an inline group whose last source message changed (e.g., thinking/action streaming),
        // rebuild only that inline group. Verify the message is still an inline type.
        if (lastItem?.type === "inline-group" && lastMsgInlineType !== null) {
          const lastSrcMsg = lastItem.items[lastItem.items.length - 1]?.msg;
          if (lastSrcMsg?.id === lastMsg.id) {
            const result = cache.result.slice();
            const updatedItems = lastItem.items.slice();
            updatedItems[updatedItems.length - 1] = { msg: lastMsg, index: messages.length - 1 };
            const inlineItems = buildInlineItems(updatedItems);
            if (inlineItems.length > 0) {
              result[result.length - 1] = {
                type: "inline-group",
                items: updatedItems,
                inlineItems,
                key: lastItem.key,
              };
            } else {
              result.pop();
            }
            prevGroupCacheRef.current = { messages, result };
            return result;
          }
        }
      }
    }

    // Fast path B: append-only — prefix unchanged, new messages added at end.
    // Common when a new message arrives or a new inline item is appended.
    if (cache && messages.length > cache.messages.length) {
      let prefixMatch = true;
      for (let i = 0; i < cache.messages.length; i++) {
        if (messages[i] !== cache.messages[i]) {
          prefixMatch = false;
          break;
        }
      }
      if (prefixMatch) {
        const result = cache.result.slice();
        // Process only the new messages, potentially merging with the tail group
        let tailInlineGroup: Array<{ msg: ChatMessage; index: number }> | null = null;
        const lastCached = result[result.length - 1];
        if (
          lastCached?.type === "inline-group" &&
          !lastCached.items.some(({ msg }) => isTypingMessage(msg))
        ) {
          // Pop the last inline group — new messages might extend it
          tailInlineGroup = lastCached.items.slice();
          result.pop();
        }

        for (let i = cache.messages.length; i < messages.length; i++) {
          const msg = messages[i]!;
          if (isTypingMessage(msg)) {
            if (tailInlineGroup && tailInlineGroup.length > 0) {
              pushInlineGroup(result, tailInlineGroup);
              tailInlineGroup = null;
            }
            pushInlineGroup(result, [{ msg, index: i }]);
            continue;
          }

          const inlineType = getInlineItemType(msg);
          if (inlineType !== null) {
            if (!tailInlineGroup) tailInlineGroup = [];
            tailInlineGroup.push({ msg, index: i });
          } else {
            if (tailInlineGroup && tailInlineGroup.length > 0) {
              pushInlineGroup(result, tailInlineGroup);
              tailInlineGroup = null;
            }
            result.push({ type: "chat-message", msg, index: i });
          }
        }

        if (tailInlineGroup && tailInlineGroup.length > 0) {
          pushInlineGroup(result, tailInlineGroup);
        }

        prevGroupCacheRef.current = { messages, result };
        return result;
      }
    }

    // Full recompute fallback (prepends, trims, mid-array changes)
    const result = fullGroupComputation(messages);
    prevGroupCacheRef.current = { messages, result };
    return result;
  }, [messages]);
  const [renderLimit, setRenderLimit] = useState(INITIAL_RENDERED_ITEMS);
  const visibleGroupedItems = useMemo(
    () => groupedItems.slice(Math.max(0, groupedItems.length - renderLimit)),
    [groupedItems, renderLimit]
  );
  const localHistoryHidden = visibleGroupedItems.length < groupedItems.length;
  localHistoryHiddenRef.current = localHistoryHidden;
  revealLocalHistoryRef.current = () => {
    setRenderLimit((limit) => limit + INITIAL_RENDERED_ITEMS);
  };

  // Server pagination prepends into `messages`, while this component keeps a
  // separate bounded render window. Grow that window by the prepended count so
  // a successful history fetch is immediately visible instead of landing
  // behind the same newest-N slice.
  const previousMessagesRef = useRef(messages);
  useEffect(() => {
    const previous = previousMessagesRef.current;
    previousMessagesRef.current = messages;
    const previousFirstId = previous[0]?.id;
    if (!previousFirstId || messages.length <= previous.length) return;
    const previousFirstIndex = messages.findIndex((message) => message.id === previousFirstId);
    if (previousFirstIndex > 0) {
      setRenderLimit((limit) => limit + previousFirstIndex);
    }
  }, [messages]);
  const scrollAnchorItems = useMemo<ScrollAnchorItem[]>(
    () =>
      visibleGroupedItems.map((item) => ({
        id: groupedItemAnchorId(item),
        signature: groupedItemSignature(item),
      })),
    [visibleGroupedItems]
  );

  useScrollAnchor({
    scrollRef,
    contentRef,
    items: scrollAnchorItems,
    isAtBottomRef,
    onNewContent: () => setShowNewContent(true),
  });

  const messagesById = useMemo(() => {
    const byId = new Map<string, ChatMessage>();
    for (const message of messages) byId.set(message.id, message);
    return byId;
  }, [messages]);
  const messagesByIdRef = useRef(messagesById);
  messagesByIdRef.current = messagesById;

  const hasDurableTypingMessages = messages.some((msg) => msg.contentType === "typing");
  const activeTypingItems = useMemo(
    () => (hasDurableTypingMessages ? [] : buildActiveTypingItems(participants, selfId)),
    [participants, selfId, hasDurableTypingMessages]
  );

  // Ref for the stable renderItem callback — avoids recreating its closure when
  // grouped items change, which would force every visible row to re-render.
  const groupedItemsRef = useRef(visibleGroupedItems);
  groupedItemsRef.current = visibleGroupedItems;

  // Render a single grouped item by index.
  // Each item is wrapped in its own flex column container so that
  // MessageCard's alignSelf works regardless of the parent's display mode.
  const renderItem = useCallback(
    (index: number, copied: boolean) => {
      const item = groupedItemsRef.current[index];
      if (!item) return null;

      if (item.type === "inline-group") {
        const defaultContent = (
          <InlineGroup
            key={item.key}
            items={item.inlineItems}
            messageTypeComponents={messageTypeComponents}
            chat={chat}
            onInterrupt={handleTypingInterrupt}
            onCancelInvocation={onCancelInvocation}
            renderInvocation={renderInvocation}
          />
        );
        if (customRenderInlineGroup) {
          return (
            <Flex className="message-item" direction="column">
              {customRenderInlineGroup(item.inlineItems, defaultContent)}
            </Flex>
          );
        }
        return (
          <Flex className="message-item" direction="column">
            {defaultContent}
          </Flex>
        );
      }

      const { msg, index: msgIndex } = item;
      const sender = getSenderInfo(msg.senderId, msg);
      const mentionLabels = (msg.mentions ?? []).map((participantId) => {
        const participant = allParticipants[participantId];
        const profile = accountProfiles.get(participantId);
        return (
          profile?.handle ??
          participant?.metadata.handle ??
          participant?.metadata.name ??
          participantId
        );
      });
      const repliedTo = msg.replyTo ? messagesByIdRef.current.get(msg.replyTo) : undefined;
      const replySender = repliedTo ? getSenderInfo(repliedTo.senderId, repliedTo) : null;
      const replyContext =
        repliedTo && replySender
          ? {
              id: repliedTo.id,
              senderName: replySender.name,
              snippet: repliedTo.content.slice(0, 120),
            }
          : undefined;

      // Subagent runs bypass the grouping/MessageCard path for a richer card.
      // User messages are published as `message.completed`, so streaming is
      // determined solely by the canonical completion flag.
      const isStreaming = msg.kind === "message" && !msg.complete;
      const defaultContent = msg.task ? (
        msg.task.subagent ? (
          <SubagentRunCard msg={msg} />
        ) : (
          <TaskRunCard msg={msg} />
        )
      ) : (
        <MessageCard
          key={msg.id || `fallback-msg-${msgIndex}`}
          msg={msg}
          index={msgIndex}
          selfId={selfId}
          senderType={sender.type}
          senderInfo={sender as SenderInfo}
          participants={allParticipants}
          mentionLabels={mentionLabels}
          replyContext={replyContext}
          isStreaming={isStreaming}
          isCopied={copied}
          inlineUiComponents={inlineUiComponents}
          messageTypeComponents={messageTypeComponents}
          chat={chat}
          browserHandoffCaller={browserHandoffCaller}
          onInterrupt={handleInterruptMessage}
          onCopy={handleCopyMessage}
          onClearCopied={handleClearCopiedMessage}
          onReply={onReply}
          onFocusPanel={onFocusPanel}
          onReloadPanel={onReloadPanel}
          mdxActions={mdxActions}
        />
      );

      return (
        <Flex className="message-item" direction="column">
          {customRenderMessage
            ? customRenderMessage(msg, sender as SenderInfo, defaultContent)
            : defaultContent}
        </Flex>
      );
    },
    [
      getSenderInfo,
      inlineUiComponents,
      messageTypeComponents,
      chat,
      browserHandoffCaller,
      mdxActions,
      allParticipants,
      onReply,
      handleInterruptMessage,
      handleCopyMessage,
      handleClearCopiedMessage,
      handleTypingInterrupt,
      onCancelInvocation,
      onFocusPanel,
      onReloadPanel,
      customRenderMessage,
      customRenderInlineGroup,
      renderInvocation,
    ]
  );

  // --- Render ---
  return (
    <Box
      className="message-list-card"
      data-part="message-list"
      flexGrow="1"
      overflow="hidden"
      style={{ minHeight: 0, position: "relative" }}
    >
      <ScrollArea
        className="message-scroll-area"
        ref={(node) => {
          scrollRef(node);
        }}
        style={{
          height: "100%",
          width: "100%",
        }}
        scrollbars="vertical"
        size="1"
      >
        <div
          ref={contentRef}
          className="message-list-content"
          style={{ padding: "var(--agentic-message-list-padding)" }}
        >
          {/* Load earlier messages button */}
          {localHistoryHidden ? (
            <Flex justify="center" py="1">
              <Button
                size="1"
                variant="soft"
                onClick={() => setRenderLimit((limit) => limit + INITIAL_RENDERED_ITEMS)}
              >
                Show{" "}
                {Math.min(INITIAL_RENDERED_ITEMS, groupedItems.length - visibleGroupedItems.length)}{" "}
                earlier messages
              </Button>
            </Flex>
          ) : null}
          {!localHistoryHidden && hasMoreHistory && onLoadEarlierMessages && (
            <Flex justify="center" py="1">
              <Button
                size="1"
                variant="soft"
                onClick={onLoadEarlierMessages}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading..." : "Load earlier messages"}
              </Button>
            </Flex>
          )}
          {groupedItems.length === 0 && activeTypingItems.length === 0 ? (
            (emptyState ?? (
              <Text color="gray" size="2">
                Send a message to start chatting
              </Text>
            ))
          ) : (
            <Flex className="message-list-stack" direction="column" gap="1">
              {visibleGroupedItems.map((item, index) => (
                <GroupedMessageRow
                  key={item.type === "inline-group" ? item.key : item.msg.id || `msg-${index}`}
                  item={item}
                  index={index}
                  copied={item.type === "chat-message" && copiedMessageId === item.msg.id}
                  renderItem={renderItem}
                />
              ))}
              {activeTypingItems.length > 0 && (
                <div className="message-item" key="active-typing">
                  <Flex className="message-item" direction="column">
                    {customRenderInlineGroup ? (
                      customRenderInlineGroup(
                        activeTypingItems,
                        <InlineGroup
                          items={activeTypingItems}
                          messageTypeComponents={messageTypeComponents}
                          chat={chat}
                          onInterrupt={handleTypingInterrupt}
                          onCancelInvocation={onCancelInvocation}
                          renderInvocation={renderInvocation}
                        />
                      )
                    ) : (
                      <InlineGroup
                        items={activeTypingItems}
                        messageTypeComponents={messageTypeComponents}
                        chat={chat}
                        onInterrupt={handleTypingInterrupt}
                        onCancelInvocation={onCancelInvocation}
                        renderInvocation={renderInvocation}
                      />
                    )}
                  </Flex>
                </div>
              )}
            </Flex>
          )}
        </div>
      </ScrollArea>
      {showNewContent && <NewContentIndicator onClick={handleScrollToNewContent} />}
    </Box>
  );
});
