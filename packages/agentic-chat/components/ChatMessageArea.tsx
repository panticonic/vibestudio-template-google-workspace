import { useMemo } from "react";
import type { ReactNode } from "react";
import { Flex } from "@radix-ui/themes";
import { useChatContext } from "../context/ChatContext";
import { useChatInputActions } from "../context/ChatInputContext";
import { AgentSetupInline } from "./AgentSetupInline";
import { FirstRunCard } from "./FirstRunCard";
import { MessageList } from "./MessageList";
import { deriveActiveOutbox } from "./Outbox";
import { SignalPills } from "./SignalPills";
import { ChatStartupStatus } from "./ChatStartupStatus";
import { pendingReviewNotice } from "@vibestudio/shared/authority/reviewPending";
import {
  selectAgenticChatTranscriptMessages,
  type ResolvedAgenticChatFeatures,
} from "../features";

export interface ChatMessageAreaProps {
  /** Override default message card rendering */
  renderMessage?: (
    ...args: Parameters<
      NonNullable<import("./MessageList").MessageListProps["renderMessage"]>
    >
  ) => ReactNode;
  /** Override default inline group rendering */
  renderInlineGroup?: (
    ...args: Parameters<
      NonNullable<import("./MessageList").MessageListProps["renderInlineGroup"]>
    >
  ) => ReactNode;
  /** Override individual invocation rendering while retaining the stock group. */
  renderInvocation?: import("./InlineGroup").InvocationRenderer;
  /** Replace, wrap, or elide the empty transcript using its complete stock renderer. */
  renderEmptyState?: (
    defaultContent: ReactNode,
    state: {
      phase: "review" | "agent" | "models" | "ready" | "connecting";
    },
  ) => ReactNode;
  /** Resolved browser-owned features for the stock transcript. */
  features: ResolvedAgenticChatFeatures;
  /** Envelope to scroll to and highlight once present; see AgenticChatProps. */
  focusMessageId?: string;
  onFocusMessageConsumed?: (messageId: string) => void;
}

/**
 * Message list area with load-earlier button.
 * Reads from ChatContext and passes to MessageList.
 */
export function ChatMessageArea({
  renderMessage,
  renderInlineGroup,
  renderInvocation,
  renderEmptyState,
  features,
  focusMessageId,
  onFocusMessageConsumed,
}: ChatMessageAreaProps) {
  const {
    connected,
    messages,
    participants,
    selfId,
    allParticipants,
    inlineUiComponents,
    messageTypeComponents,
    hasMoreHistory,
    loadingMore,
    onLoadEarlierMessages,
    onInterrupt,
    onCancelInvocation,
    onFocusPanel,
    onReloadPanel,
    chat,
    browserHandoffCaller,
    clientRef,
    deferredAgent,
    connectionError,
  } = useChatContext();
  const { setReplyTo } = useChatInputActions();

  const mdxActions = useMemo(
    () => ({
      publishMessage: async (content: string) => {
        await chat.send(content);
      },
    }),
    [chat],
  );

  // Hide exactly the active-outbox set (messages live in the queue OR the
  // transcript, never both — so a fresh send doesn't flash here and then bounce
  // to the queue). deriveActiveOutbox already keeps the right things visible:
  //  - no recipient (sent before any agent joined) → not deliverable → visible;
  //  - offline recipient → excluded → visible with an "agent offline" marker,
  //    self-resolving on return;
  //  - read messages → no longer pending → visible (graduated from the queue).
  // Until connected (replay complete), the Outbox is suppressed, so don't hide
  // anything here either — otherwise a transiently-pending historical message
  // would vanish from BOTH places mid-replay.
  const transcriptMessages = useMemo(() => {
    const featureVisibleMessages = selectAgenticChatTranscriptMessages(
      messages,
      features,
    );
    if (!connected) return featureVisibleMessages;
    const hiddenIds = new Set(
      deriveActiveOutbox(featureVisibleMessages, selfId, participants).map(
        (message) => message.id,
      ),
    );
    return hiddenIds.size > 0
      ? featureVisibleMessages.filter((message) => !hiddenIds.has(message.id))
      : featureVisibleMessages;
  }, [connected, messages, selfId, participants, features.inlineUi]);

  // Empty-transcript surface. While the spawned agent is starting, show an
  // accurate status (the pre-send queue below the composer shows the spinner
  // + the queued messages themselves). Otherwise, once replay has settled
  // (`connected`) on a genuinely empty channel, show the first-run narrative
  // card (item 9) — gating on `connected` avoids flashing it mid-replay for an
  // existing conversation. MessageList only mounts this when there are zero
  // items, so it self-hides the moment the first message lands.
  const emptyPhase = useMemo<
    "review" | "agent" | "models" | "ready" | "connecting"
  >(() => {
    const pending = pendingReviewNotice(
      connectionError?.cause ?? connectionError,
    );
    if (pending) return "review";
    if (deferredAgent?.launching) return "agent";
    if (
      deferredAgent?.modelDiscoveryPending &&
      deferredAgent.queued.length > 0
    ) return "models";
    return connected ? "ready" : "connecting";
  }, [
    connectionError,
    deferredAgent?.launching,
    deferredAgent?.modelDiscoveryPending,
    deferredAgent?.queued.length,
    connected,
  ]);
  const defaultEmptyState = useMemo<ReactNode>(() => {
    if (emptyPhase === "review") {
      const pending = pendingReviewNotice(
        connectionError?.cause ?? connectionError,
      );
      return <ChatStartupStatus phase="review" detail={pending?.message} />;
    }
    if (emptyPhase === "agent") return <ChatStartupStatus phase="agent" />;
    if (emptyPhase === "models") return <ChatStartupStatus phase="models" />;
    return emptyPhase === "ready" ? (
      <FirstRunCard />
    ) : (
      <ChatStartupStatus phase="conversation" />
    );
  }, [emptyPhase, connectionError]);
  const emptyState = renderEmptyState
    ? renderEmptyState(defaultEmptyState, { phase: emptyPhase })
    : defaultEmptyState;

  // Before the first agent exists, the message canvas hosts the inline setup
  // (armed config) instead of an empty transcript.
  if (deferredAgent?.setupActive) {
    return (
      <Flex direction="column" gap="1" style={{ minHeight: 0, flexGrow: 1 }}>
        <SignalPills client={clientRef.current} />
        <AgentSetupInline />
      </Flex>
    );
  }

  return (
    <Flex direction="column" gap="1" style={{ minHeight: 0, flexGrow: 1 }}>
      <SignalPills client={clientRef.current} />
      <MessageList
        emptyState={emptyState}
        messages={transcriptMessages}
        participants={participants}
        selfId={selfId}
        allParticipants={allParticipants}
        inlineUiComponents={inlineUiComponents}
        messageTypeComponents={messageTypeComponents}
        chat={chat as unknown as Record<string, unknown>}
        browserHandoffCaller={browserHandoffCaller}
        hasMoreHistory={hasMoreHistory}
        loadingMore={loadingMore}
        onLoadEarlierMessages={onLoadEarlierMessages}
        onInterrupt={onInterrupt}
        onCancelInvocation={onCancelInvocation}
        onFocusPanel={onFocusPanel}
        onReloadPanel={onReloadPanel}
        onReply={setReplyTo}
        mdxActions={mdxActions}
        renderMessage={renderMessage}
        renderInlineGroup={renderInlineGroup}
        renderInvocation={renderInvocation}
        focusMessageId={focusMessageId}
        onFocusMessageConsumed={onFocusMessageConsumed}
      />
    </Flex>
  );
}
