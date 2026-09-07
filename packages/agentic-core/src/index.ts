// =============================================================================
// @workspace/agentic-core — Headless agentic session helpers
//
// Pi (`@workspace/pi-core`) owns live agent session execution.
// Durable transcript state is projected from channel trajectory events. This
// package provides:
// - Pi message/event type re-exports (single import surface for consumers)
// - The signal event envelope used by transient structured channel payloads
// - The panel import loader factory
// - Connection management primitives
// =============================================================================

// --- Headless types ---
export type {
  ChatParticipantMetadata,
  ChatParticipantSummary,
  ConnectionConfig,
  AgenticChatActions,
  AvailableAgent,
  ModelSetupResult,
  ChatSandboxValue,
  ToolProviderDeps,
  ToolProvider,
  NewConversationOptions,
} from "./types.js";
// Model catalog shared types (re-exported so chat/panel import one surface).
export type {
  ModelCatalog,
  ModelCatalogEntry,
  ModelCatalogProvider,
} from "@workspace/model-catalog/catalog";
export type {
  AgentApprovalLevel,
  AgentConfig,
  AgentChannelFeatures,
  AgentObservationConfig,
  AgentResourceBinding,
  AgentRespondPolicy,
  AgentSettingKey,
  AgentSubscriptionConfig,
  AgentSystemPromptMode,
  AgentThinkingLevel,
  AgentToolBinding,
  ChannelSubscriptionConfig,
} from "./agent-subscription-config.js";
export {
  AGENT_SETTING_KEYS,
  resolveAgentObservationConfig,
  toSubscriptionConfig,
} from "./agent-subscription-config.js";
export {
  buildAgentEntityCreateSpec,
  buildAgentTaskSeedEvent,
  createAgentEntity,
  createSubagentContext,
  initAgentFromTrajectoryFork,
  launchAgentIntoChannel,
  publishAgentTaskSeed,
  retireAgentEntity,
  subscribeAgentToChannel,
  unsubscribeAgentFromChannel,
} from "./agent-launch.js";
export {
  ProvisionalAgentLifecycle,
  withWorkspaceReviewRetry,
} from "./provisional-agent-lifecycle.js";
export type {
  ClaimedProvisionalAgent,
  ProvisionalAgentIntent,
  WorkspaceReviewWaiter,
} from "./provisional-agent-lifecycle.js";
export type {
  AgentChannelSubscriptionInput,
  AgentChannelUnsubscriptionInput,
  AgentEntityCreateInput,
  AgentEntityHandle,
  AgentLaunchRpc,
  AgentSubscriptionResult,
  AgentTaskSeedChannel,
  AgentTaskSeedInput,
  AgentTrajectoryForkInput,
  CreateSubagentContextInput,
  LaunchAgentIntoChannelInput,
  LaunchAgentIntoChannelResult,
} from "./agent-launch.js";
export { subagentFirstTaskPrompt, subagentRuntimePrompt } from "./subagent-prompt.js";
export type { SubagentIdentity } from "./subagent-prompt.js";

// Re-exported from @workspace/pubsub for convenience — canonical role-based
// predicates for distinguishing agent participants from client participants.
export { isAgentParticipantType, isClientParticipantType } from "@workspace/pubsub";

// --- Typed Event Emitter ---
export { TypedEmitter } from "./emitter.js";

// --- Connection ---
export { ConnectionManager } from "./connection.js";
export type { ConnectionStatus, ClientParticipantMetadata } from "./connection.js";

// --- Panel dynamic import loading ---
export { createPanelImportLoader } from "./panel-import-loader.js";

// --- Signal Event Envelope (typed structured channel payloads) ---
export { parseSignalEvent } from "./signal-event-envelope.js";
export type { SignalEventEnvelope, SignalMessageLike } from "./signal-event-envelope.js";

// --- Derived UI shapes (computed from channel trajectory events for rendering) ---
export type {
  ChatMessage,
  PendingAgent,
  PendingAgentStatus,
  DisconnectedAgentInfo,
  DirtyRepoDetails,
  InlineUiCardPayload,
  ActionBarPayload,
  ApprovalCardPayload,
  AutomationActivityPayload,
  AutomationActivitySnapshot,
  AutomationDefinitionPayload,
  ForkRowPayload,
  CustomMessageCardPayload,
  CustomMessageDisplayMode,
  CustomMessageUpdatePayload,
  ActiveMessageTypeDefinition,
  ClearedMessageTypeDefinition,
  MessageTypeDefinition,
  ProjectedMessageTypeDefinition,
} from "./derived-types.js";

export {
  compileMessageTypeModule,
  foldCustomMessageState,
  validateCustomState,
} from "./custom-message-types.js";
export { DEFAULT_HOST_MODULES, lintRendererSource } from "./renderer-lint.js";
export type { RendererLintIssue } from "./renderer-lint.js";
export {
  assertMessageTypesHealthy,
  installDoctorHostModules,
  runMessageTypeDoctor,
} from "./message-type-doctor.js";
export type {
  MessageTypeDoctorIssue,
  MessageTypeDoctorOptions,
  MessageTypeDoctorSpec,
} from "./message-type-doctor.js";
export type { CustomMessageComponentProps, MessageTypeModule } from "./custom-message-types.js";

// --- Invocation card payload (derived UI shape for invocation events) ---
export type { InvocationCardPayload, ToolExecutionState } from "./invocation-card-payload.js";
export { parseInvocationCardPayload } from "./invocation-card-payload.js";
export type { SubagentRunState, TaskCardPayload } from "./task-card-payload.js";

// --- Shared wire-event → ChatMessage merge helpers ---
export {
  actionBarPayloadFromChannelView,
  chatMessagesFromChannelView,
  messageTypeDefinitionsFromChannelView,
} from "./channel-chat-merge.js";

// --- Invocation result helpers ---
export { isChatMethodResult, unwrapChatMethodResult } from "./invocation-result.js";
export type { ChatMethodResult } from "./invocation-result.js";
