import React from "react";
import { Flex } from "@radix-ui/themes";
import { ChatHeader } from "./ChatHeader";
import { ChatConnectionErrorBanner } from "./ChatConnectionErrorBanner";
import { ChatDirtyRepoWarnings } from "./ChatDirtyRepoWarnings";
import { LazyChatActionBar } from "./LazyChatActionBar";
import { ChatMessageArea } from "./ChatMessageArea";
import { LazyChatFeedbackArea } from "./LazyChatFeedbackArea";
import { Outbox } from "./Outbox";
import { PendingDeliveryQueue } from "./PendingDeliveryQueue";
import { ChatInput } from "./ChatInput";
import { ChatDebugConsole } from "./ChatDebugConsole";
import type { ChatMessageAreaProps } from "./ChatMessageArea";
import type { ResolvedAgenticChatFeatures } from "../features";
import "../styles.css";

export interface ChatLayoutProps extends Pick<
  ChatMessageAreaProps,
  "renderMessage" | "renderInlineGroup" | "renderInvocation" | "renderEmptyState"
> {
  /** Product-owned class and semantic-variable overrides for the chat root. */
  className?: string;
  style?: React.CSSProperties;
  /** Resolved browser-owned capabilities to mount in the stock layout. */
  features: ResolvedAgenticChatFeatures;
  /** Product-specific prompt shown when the composer is empty. */
  composerPlaceholder?: string;
  /** Recipients used when composer text contains no explicit @mention. */
  composerDefaultMentions?: readonly string[];
  /** Product-owned readiness gate for the composer. */
  composerDisabled?: boolean;
  /** Replace, wrap, or elide the stock conversation header. */
  renderHeader?: (defaultContent: React.ReactNode) => React.ReactNode;
  /** Replace, wrap, or elide the stock pending-delivery and outbox surfaces. */
  renderDeliveryStatus?: (defaultContent: React.ReactNode) => React.ReactNode;
  /** Replace, wrap, or elide the stock composer. */
  renderComposer?: (defaultContent: React.ReactNode) => React.ReactNode;
  /** Envelope to scroll to and highlight once present; see AgenticChatProps. */
  focusMessageId?: string;
  onFocusMessageConsumed?: (messageId: string) => void;
}

/**
 * Default full chat layout — drop-in replacement for the old ChatPhase.
 * Composes all sub-components reading from ChatContext.
 *
 * NOTE: Theme is applied in AgenticChat (above ChatProvider) so that
 * ChatLayout does NOT read from context. This prevents keystroke-driven
 * context updates (from ChatInput → setInput) from re-rendering
 * ChatLayout and triggering unnecessary Radix theme context propagation,
 * which can cause layout shifts that break autoscroll.
 *
 * For custom layouts, use the individual components directly:
 * ```tsx
 * <ChatProvider value={chatState}>
 *   <MyCustomHeader />
 *   <ChatMessageArea features={features} />
 *   <ChatInput />
 * </ChatProvider>
 * ```
 */
export const ChatLayout = React.memo(function ChatLayout({
  className,
  style,
  renderMessage,
  renderInlineGroup,
  renderInvocation,
  renderEmptyState,
  features,
  composerPlaceholder,
  composerDefaultMentions,
  composerDisabled,
  renderHeader,
  renderDeliveryStatus,
  renderComposer,
  focusMessageId,
  onFocusMessageConsumed,
}: ChatLayoutProps) {
  const defaultHeader = <ChatHeader />;
  const defaultDeliveryStatus = (
    <>
      <PendingDeliveryQueue />
      <Outbox />
    </>
  );
  const defaultComposer = (
    <ChatInput
      placeholder={composerPlaceholder}
      defaultMentions={composerDefaultMentions}
      disabled={composerDisabled}
    />
  );
  return (
    <>
      <Flex
        className={["agentic-chat-root", className].filter(Boolean).join(" ")}
        data-part="chat-root"
        direction="column"
        style={{
          height: "100%",
          minWidth: 0,
          width: "100%",
          boxSizing: "border-box",
          overflow: "hidden",
          gap: "var(--agentic-root-gap)",
          padding:
            "max(var(--agentic-root-padding), env(safe-area-inset-top, 0)) max(var(--agentic-root-padding), env(safe-area-inset-right, 0)) max(var(--agentic-root-padding), env(safe-area-inset-bottom, 0)) max(var(--agentic-root-padding), env(safe-area-inset-left, 0))",
          ...style,
        }}
      >
        {renderHeader ? renderHeader(defaultHeader) : defaultHeader}
        <ChatConnectionErrorBanner />
        <ChatDirtyRepoWarnings />
        {features.actionBar ? <LazyChatActionBar /> : null}
        <ChatMessageArea
          renderMessage={renderMessage}
          renderInlineGroup={renderInlineGroup}
          renderInvocation={renderInvocation}
          renderEmptyState={renderEmptyState}
          features={features}
          focusMessageId={focusMessageId}
          onFocusMessageConsumed={onFocusMessageConsumed}
        />
        {features.feedback ? <LazyChatFeedbackArea /> : null}
        {renderDeliveryStatus ? renderDeliveryStatus(defaultDeliveryStatus) : defaultDeliveryStatus}
        {renderComposer ? renderComposer(defaultComposer) : defaultComposer}
      </Flex>
      <ChatDebugConsole />
    </>
  );
});
