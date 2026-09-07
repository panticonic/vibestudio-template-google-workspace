import type { ChannelConfig } from "@workspace/pubsub";
import { Theme } from "@radix-ui/themes";
import { forwardRef, useEffect, useImperativeHandle } from "react";
import type { CSSProperties } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { ChatLayout, type ChatLayoutProps } from "./ChatLayout";
import { ChatHostCommands } from "./ChatPaletteCommands";
import { ChatProvider } from "../context/ChatProvider";
import { useAgenticChat } from "../hooks/useAgenticChat";
import type {
  ChatParticipantMetadata,
  ConnectionConfig,
  AgenticChatActions,
  ToolProvider,
  ForkNavHandlers,
  ChatSandboxValue,
} from "../types";
import type { SandboxImportLoader } from "@workspace/eval";
import { scheduleChatCapabilityWarmup } from "../utils/chatCapabilityWarmup";
import type { ChatMessageAreaProps } from "./ChatMessageArea";
import type { AgenticChatFeature } from "../features";

export interface AgenticChatHandle {
  /**
   * Publish through the chat component's existing channel participant. The
   * promise waits for that participant to be connected first.
   */
  send(content: string, options?: Parameters<ChatSandboxValue["send"]>[1]): Promise<unknown>;
}

export interface AgenticChatProps {
  /** Product-owned presentation class and semantic-variable overrides. */
  className?: string;
  style?: CSSProperties;
  /** Connection configuration (server URL, token, client ID) */
  config: ConnectionConfig;
  /** Channel name to connect to */
  channelName: string;
  /** Channel configuration */
  channelConfig?: ChannelConfig;
  /** Context ID for channel authorization */
  contextId?: string;
  /** Participant metadata */
  metadata?: ChatParticipantMetadata;
  /** Tool provider factory */
  tools?: ToolProvider;
  /** Platform-specific actions */
  actions?: AgenticChatActions;
  /** Theme */
  theme?: "light" | "dark";
  /** Whether this chat owns the viewport or fills an embedding container. */
  heightMode?: "viewport" | "container";
  /** Agents installed for this channel; shown as pending until they join the roster */
  installedAgents?: Array<{ agentId: string; handle: string }>;
  /** If set, automatically sent as the first user message once connected */
  initialPrompt?: string;
  /** Send initialPrompt even if the channel already has history (idempotent). */
  forceInitialPrompt?: boolean;
  /** Override the durable deduplication key for an explicitly triggered prompt. */
  initialPromptIdempotencyKey?: string;
  /** Panel-supplied fork navigation + review overlay handlers (fork switcher,
   *  inline fork rows, subagent review). Omit to disable the fork UI. */
  forkNav?: ForkNavHandlers;
  /** Optional build-backed loader for imports used by authored UI and client evaluation. */
  importLoader?: SandboxImportLoader;
  /** Context-relative TSX file to load into the panel-local action bar on mount */
  initialActionBarFile?: string;
  /** Props for initialActionBarFile */
  initialActionBarProps?: Record<string, unknown>;
  /** Preferred max height for initialActionBarFile */
  initialActionBarMaxHeight?: number;
  /** Persist action-bar file changes into the hosting panel state, if supported */
  onActionBarFileChange?: (value: {
    path: string | null;
    props?: Record<string, unknown>;
    maxHeight?: number;
  }) => void | Promise<void>;
  /** Host approval changes can unblock the initial channel connection. */
  connectionRetrySignal?: number;
  /**
   * Browser-owned capabilities exposed by this chat participant. The choice is
   * explicit and fixed for the lifetime of the mounted participant.
   */
  features: readonly AgenticChatFeature[];
  /** Override ordinary transcript message rendering. */
  renderMessage?: ChatMessageAreaProps["renderMessage"];
  /** Override complete inline groups (thinking, invocations, typing, custom messages). */
  renderInlineGroup?: ChatMessageAreaProps["renderInlineGroup"];
  /** Override individual invocation rendering while retaining the stock group. */
  renderInvocation?: ChatMessageAreaProps["renderInvocation"];
  /** Replace, wrap, or elide the empty transcript using its complete stock renderer. */
  renderEmptyState?: ChatMessageAreaProps["renderEmptyState"];
  /** Replace, wrap, or elide the stock conversation header. */
  renderHeader?: ChatLayoutProps["renderHeader"];
  /** Replace, wrap, or elide the stock pending-delivery and outbox surfaces. */
  renderDeliveryStatus?: ChatLayoutProps["renderDeliveryStatus"];
  /** Replace, wrap, or elide the stock composer. */
  renderComposer?: ChatLayoutProps["renderComposer"];
  /** Product-specific prompt shown when the composer is empty. */
  composerPlaceholder?: string;
  /** Recipients used when composer text contains no explicit @mention. */
  composerDefaultMentions?: readonly string[];
  /** Product-owned readiness gate for the composer. */
  composerDisabled?: boolean;
  /**
   * Envelope to scroll to and highlight once present (messaging plan §4.5,
   * §4.10). Notification surfaces and other channels' open links set it; the
   * host clears it through `onFocusMessageConsumed` once honoured.
   */
  focusMessageId?: string;
  onFocusMessageConsumed?: (messageId: string) => void;
}

/**
 * High-level drop-in agentic chat component.
 *
 * Composes useAgenticChat() → ErrorBoundary → ChatProvider → ChatLayout.
 *
 * For custom layouts, use useAgenticChat() + ChatProvider + individual components directly.
 */
export const AgenticChat = forwardRef<AgenticChatHandle, AgenticChatProps>(function AgenticChat(
  {
    className,
    style,
    config,
    channelName,
    channelConfig,
    contextId,
    metadata,
    tools,
    actions,
    theme,
    heightMode = "viewport",
    installedAgents: installedAgentInfos,
    initialPrompt,
    forceInitialPrompt,
    initialPromptIdempotencyKey,
    forkNav,
    importLoader,
    initialActionBarFile,
    initialActionBarProps,
    initialActionBarMaxHeight,
    onActionBarFileChange,
    connectionRetrySignal,
    features: requestedFeatures,
    renderMessage,
    renderInlineGroup,
    renderInvocation,
    renderEmptyState,
    renderHeader,
    renderDeliveryStatus,
    renderComposer,
    composerPlaceholder,
    composerDefaultMentions,
    composerDisabled,
    focusMessageId,
    onFocusMessageConsumed,
  },
  ref
) {
  const { contextValue, inputContextValue, features } = useAgenticChat({
    config,
    channelName,
    channelConfig,
    contextId,
    metadata,
    tools,
    actions,
    theme,
    installedAgentInfos,
    initialPrompt,
    forceInitialPrompt,
    initialPromptIdempotencyKey,
    forkNav,
    importLoader,
    initialActionBarFile,
    initialActionBarProps,
    initialActionBarMaxHeight,
    onActionBarFileChange,
    connectionRetrySignal,
    features: requestedFeatures,
  });
  useEffect(() => scheduleChatCapabilityWarmup(features), [features]);
  useImperativeHandle(
    ref,
    () => ({
      async send(content, options) {
        const client = contextValue.clientRef.current;
        if (!client) throw new Error("Agentic chat is not connected");
        await client.ready();
        return contextValue.chat.send(content, options);
      },
    }),
    [contextValue.chat, contextValue.clientRef]
  );

  return (
    <ErrorBoundary surfaceName="chat panel">
      {/* Theme is applied here (above ChatProvider) rather than in ChatLayout
          so that ChatLayout does NOT read from context. This prevents
          keystroke-driven context updates from re-rendering ChatLayout and
          causing layout shifts that break autoscroll.

          Appearance flows from the explicitly-passed `theme` prop OR, when
          absent, the system / centralized appearance (resolved in useChatCore
          via resolveSystemTheme) — NEVER a hardcoded "dark" literal. */}
      <Theme
        appearance={contextValue.theme}
        style={{
          minWidth: 0,
          width: "100%",
          height: heightMode === "container" ? "100%" : "100dvh",
        }}
      >
        <ChatProvider value={contextValue} inputValue={inputContextValue}>
          <ChatHostCommands />
          <ChatLayout
            className={className}
            style={style}
            features={features}
            renderMessage={renderMessage}
            renderInlineGroup={renderInlineGroup}
            renderInvocation={renderInvocation}
            renderEmptyState={renderEmptyState}
            renderHeader={renderHeader}
            renderDeliveryStatus={renderDeliveryStatus}
            renderComposer={renderComposer}
            composerPlaceholder={composerPlaceholder}
            composerDefaultMentions={composerDefaultMentions}
            composerDisabled={composerDisabled}
            focusMessageId={focusMessageId}
            onFocusMessageConsumed={onFocusMessageConsumed}
          />
        </ChatProvider>
      </Theme>
    </ErrorBoundary>
  );
});
