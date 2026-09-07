// =============================================================================
// @workspace/agentic-chat — Reusable agentic chat UI + state management
// =============================================================================

// --- Types ---
export type {
  ChatMessage,
  ChatParticipantMetadata,
  DisconnectedAgentInfo,
  PendingAgent,
  PendingAgentStatus,
  ConnectionConfig,
  AgenticChatActions,
  NewConversationOptions,
  ToolProvider,
  ToolProviderDeps,
  ChatSandboxValue,
  ChatContextValue,
  ChatInputContextValue,
  PrimaryActionIntent,
  FlushNarration,
  UndoableAction,
  InlineUiComponentEntry,
  ActionBarData,
  ActionBarState,
  ForkNavHandlers,
  ForkUiState,
  ForkEntry,
  ForkTreeNode,
  ChannelProvenance,
} from "./types";

// --- Context ---
export { ChatContext, useChatContext } from "./context/ChatContext";
export { ChatInputContext, useChatInputContext } from "./context/ChatInputContext";
export { ChatProvider } from "./context/ChatProvider";
export type { ChatProviderProps } from "./context/ChatProvider";

// --- Hooks ---
export { useAgenticChat } from "./hooks/useAgenticChat";
export type { UseAgenticChatOptions } from "./hooks/useAgenticChat";
export type { UseAgenticChatResult } from "./hooks/useAgenticChat";
export {
  AGENTIC_CHAT_FEATURES,
  FULL_AGENTIC_CHAT_FEATURES,
  composeAgenticChatMethods,
  resolveAgenticChatFeatures,
  selectAgenticChatTranscriptMessages,
} from "./features";
export type { AgenticChatFeature, ResolvedAgenticChatFeatures } from "./features";
export { useChannelSignals } from "./hooks/useChannelSignals";
export type { ChannelSignal, UseChannelSignalsOptions } from "./hooks/useChannelSignals";

// Core hook (minimum viable chat — delegates to SessionManager)
export { useChatCore } from "./hooks/core/useChatCore";
export type { UseChatCoreOptions, ChatCoreState } from "./hooks/core/useChatCore";

// Live account-profile projection for `user:<userId>` participants (WP6 §6).
// `resolveAccountProfiles` is the shared seam (also consumed by presence, WP8).
export {
  useAccountProfiles,
  resolveAccountProfiles,
  userIdFromParticipantId,
  USER_PARTICIPANT_PREFIX,
} from "./hooks/useAccountProfiles";
export type { AccountProfile, AccountRpc } from "./hooks/useAccountProfiles";

// Feature hooks
export { useChatFeedback } from "./hooks/features/useChatFeedback";
export type { ChatFeedbackState } from "./hooks/features/useChatFeedback";
export { useChatTools } from "./hooks/features/useChatTools";
export type { ChatToolsState } from "./hooks/features/useChatTools";
export { useChatDebug } from "./hooks/features/useChatDebug";
export type { ChatDebugState } from "./hooks/features/useChatDebug";
export { useInlineUi } from "./hooks/features/useInlineUi";
export type { InlineUiState } from "./hooks/features/useInlineUi";
export { useActionBar, parseActionBarData } from "./hooks/features/useActionBar";
export type { ActionBarHookState } from "./hooks/features/useActionBar";
export { useMessageTypeRegistry } from "./hooks/features/useMessageTypeRegistry";
export type { MessageTypeRegistryState } from "./hooks/features/useMessageTypeRegistry";

// --- High-level components ---
export { AgenticChat } from "./components/AgenticChat";
export type { AgenticChatHandle, AgenticChatProps } from "./components/AgenticChat";

// --- Layout components (composable) ---
export { ChatLayout } from "./components/ChatLayout";
export type { ChatLayoutProps } from "./components/ChatLayout";
export { ChatHeader } from "./components/ChatHeader";
export { ForkSwitcher } from "./components/ForkSwitcher";
export { ForkTreeView } from "./components/ForkTreeView";
export { SubagentRunCard } from "./components/SubagentRunCard";
export { useForkLineage } from "./hooks/useForkLineage";
export type { UseForkLineageOptions } from "./hooks/useForkLineage";
export { ChatMessageArea } from "./components/ChatMessageArea";
export type { ChatMessageAreaProps } from "./components/ChatMessageArea";
export { ChatFeedbackArea } from "./components/ChatFeedbackArea";
export { ChatInput } from "./components/ChatInput";
export type { ChatInputProps } from "./components/ChatInput";
export { Outbox } from "./components/Outbox";
export { OutboxItem } from "./components/OutboxItem";
export type { OutboxItemProps, OutboxLane } from "./components/OutboxItem";
export { SendButton } from "./components/SendButton";
export type { SendButtonProps } from "./components/SendButton";
export { AckBadge } from "./components/AckBadge";
export type { AckBadgeProps, ReceiptState, ReceiptAggregate } from "./components/AckBadge";
export { ChatDirtyRepoWarnings } from "./components/ChatDirtyRepoWarnings";
export { ChatDebugConsole } from "./components/ChatDebugConsole";
export { ChatActionBar } from "./components/ChatActionBar";
export {
  AutomationActivity,
  AutomationParametersEditor,
  createAutomationUiClient,
  formatAutomationInterval,
} from "./components/AutomationActivity";
export type {
  AutomationActivityProps,
  AutomationUiClient,
  AutomationUiRpc,
} from "./components/AutomationActivity";
export { CronScheduleDisplay, CronScheduleEditor } from "./components/CronScheduleControls";

// --- Primitive components ---
export { MessageList } from "./components/MessageList";
export type { MessageListProps, SenderInfo } from "./components/MessageList";
export { MessageCard } from "./components/MessageCard";
export { MessageContent } from "./components/MessageContent";
export { InlineGroup } from "./components/InlineGroup";
export type {
  InlineGroupProps,
  InlineItem,
  InvocationRenderContext,
  InvocationRenderer,
} from "./components/InlineGroup";
export { ThinkingPill, ExpandedThinking, PREVIEW_MAX_LENGTH } from "./components/ThinkingMessage";
export { ActionPill, ExpandedAction } from "./components/ActionMessage";
export { MethodArgumentsModal } from "./components/MethodArgumentsModal";
export { TypingPill } from "./components/TypingMessage";
export { SignalPills } from "./components/SignalPills";
export { TypingIndicator } from "./components/TypingIndicator";
export type { TypingIndicatorData } from "./types";
export { InlineUiMessage, parseInlineUiData } from "./components/InlineUiMessage";
export { ImageGallery } from "./components/ImageGallery";
export { ImageInput, getAttachmentInputsFromPendingImages } from "./components/ImageInput";
export { ParticipantBadgeMenu } from "./components/ParticipantBadgeMenu";
export { ToolPermissionsDropdown } from "./components/ToolPermissionsDropdown";
export { AgentDebugConsole } from "./components/AgentDebugConsole";
export { AgentDisconnectedMessage } from "./components/AgentDisconnectedMessage";
export { DirtyRepoWarning } from "./components/DirtyRepoWarning";
export { PendingAgentBadge } from "./components/PendingAgentBadge";
export { NewContentIndicator } from "./components/NewContentIndicator";
export { ChatConnectionErrorBanner } from "./components/ChatConnectionErrorBanner";
export { ContextUsageRing } from "./components/ContextUsageRing";
export { JsonSchemaForm } from "./components/JsonSchemaForm";
export { ErrorBoundary } from "./components/ErrorBoundary";
export {
  markdownComponents,
  mdxComponents,
  streamingMarkdownComponents,
} from "./components/markdownComponents";
export { MermaidDiagram, Diagram } from "@workspace/ui/diagram";

// --- Utilities ---
export {
  createPendingImage,
  cleanupPendingImages,
  validateImageFile,
  validateImageFiles,
  filterImageFiles,
  fileToAttachmentInput,
  fileToUint8Array,
  createImagePreviewUrl,
  revokeImagePreviewUrl,
  getImagesFromClipboard,
  getImagesFromDragEvent,
  SUPPORTED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  isImageMimeType,
  formatBytes,
} from "./utils/imageUtils";
export type { PendingImage } from "./utils/imageUtils";
