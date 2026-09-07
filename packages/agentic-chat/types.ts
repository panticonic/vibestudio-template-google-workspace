// ===========================================================================
// Re-export headless types from agentic-core
// ===========================================================================
export type {
  ChatParticipantMetadata,
  ChatParticipantSummary,
  ClientParticipantMetadata,
  ConnectionConfig,
  AgenticChatActions,
  ChatSandboxValue,
  ChatMethodResult,
  ToolProviderDeps,
  ToolProvider,
  NewConversationOptions,
  ModelSetupResult
} from "@workspace/agentic-core";

// ===========================================================================
// Re-export derived UI types from agentic-core (ChatMessage, pending agent state, …)
// ===========================================================================
export type {
  ChatMessage,
  MessageTypeDefinition,
  PendingAgent,
  PendingAgentStatus,
  DisconnectedAgentInfo,
  DirtyRepoDetails
} from "@workspace/agentic-core";

// ===========================================================================
// UI-only types
// ===========================================================================
import type {
  AgentDebugPayload,
  Participant,
  AttachmentInput,
  SandboxSource,
  PubSubClient
} from "@workspace/pubsub";
import type { ActiveFeedback, ToolApprovalProps } from "@workspace/tool-ui";
import type { PendingImage } from "./utils/imageUtils";
import type { ComponentType, RefObject } from "react";
import type { ScopeManager, ScopesApi } from "@workspace/eval";
import type { MessageTier } from "@workspace/agentic-protocol";
import type { DefaultAgentConfig } from "@workspace/model-catalog/catalog";
import type { AgentConfigDraft } from "./components/AgentConfigForm";
import type { ChildTranscriptConnection } from "./hooks/useChildTranscript";
import type {
  ChatParticipantMetadata,
  ChatSandboxValue,
  InvocationCardPayload
} from "@workspace/agentic-core";
import type { ConsoleCapture } from "@workspace/eval";
import type {
  ChatMessage,
  MessageTypeDefinition,
  PendingAgent,
  DirtyRepoDetails,
  AvailableAgent,
  ModelSetupResult,
  ModelCatalog,
  AgentSubscriptionConfig,
  NewConversationOptions
} from "@workspace/agentic-core";

// ===========================================================================
// Inline UI Component Entry
// ===========================================================================

export interface InlineUiComponentEntry {
  Component?: ComponentType<{
    props: Record<string, unknown>;
    chat: Record<string, unknown>;
    scope: Record<string, unknown>;
    scopes: Record<string, unknown>;
    inlineUi?: { id: string; renderedAt?: string };
  }>;
  cacheKey: string;
  error?: string;
  errorStack?: string;
  runtime?: { console: ConsoleCapture };
}

// ===========================================================================
// Action Bar
// ===========================================================================

export interface ActionBarData {
  /** Unique ID for this action bar revision. New revisions replace old ones. */
  id: string;
  /** Component source to compile and render. */
  source: SandboxSource;
  /** Optional explicit imports for the current compiled revision. */
  imports?: Record<string, string>;
  /** Optional props to pass to the component */
  props?: Record<string, unknown>;
  /** Optional preferred maximum height in pixels. Clamped by the renderer. */
  maxHeight?: number;
}

export interface ActionBarState {
  data: ActionBarData;
  component?: InlineUiComponentEntry;
}

// ===========================================================================
// Typing Indicators
// ===========================================================================

/** Typing indicator data derived from roster participant metadata. */
export interface TypingIndicatorData {
  senderId: string;
  senderName?: string;
  senderType?: string;
}

declare const runtimeCallerIdBrand: unique symbol;
declare const channelParticipantIdBrand: unique symbol;

export type RuntimeCallerId = string & {
  readonly [runtimeCallerIdBrand]: true;
};
export type ChannelParticipantId = string & {
  readonly [channelParticipantIdBrand]: true;
};
export type BrowserHandoffCallerKind = "app" | "panel" | "shell";

export interface BrowserHandoffCaller {
  id: RuntimeCallerId;
  kind: BrowserHandoffCallerKind;
}

export function runtimeCallerId(value: string): RuntimeCallerId {
  return value as RuntimeCallerId;
}

export function channelParticipantId(value: string): ChannelParticipantId {
  return value as ChannelParticipantId;
}

// ===========================================================================
// ChatInputContext Value
// ===========================================================================

export interface ChatInputContextValue {
  input: string;
  pendingImages: PendingImage[];
  onInputChange: (value: string) => void;
  onSendMessage: (
    attachments?: AttachmentInput[],
    options?: {
      mentions?: string[];
      replyTo?: string;
      /** Written into the published message payload (e.g. deliverAfterTurn). */
      metadata?: Record<string, unknown>;
    }
  ) => Promise<void>;
  onImagesChange: (images: PendingImage[]) => void;
  replyTo: string | null;
  replyToMessage: ChatMessage | null;
  setReplyTo: (messageId: string | null) => void;
}

/**
 * What pressing Enter will do right now, given agent-busy + send-mode state.
 * - `send`  — no agent busy: a normal send.
 * - `steer` — an agent is mid-turn: the default send steers it.
 * - `queue` — after-turn mode armed: the message waits until the turn closes.
 */
export type PrimaryActionIntent = "send" | "steer" | "queue";

/** Transient outcome of the last incremental flush, for the pill + aria-live. */
export interface FlushNarration {
  text: string;
  /** Remaining queued items after this flush step (drives "· N waiting"). */
  remaining: number;
}

/** A short, reversible client-side undo window after retract/cancel. */
export interface UndoableAction {
  kind: "retract" | "cancel";
  /** Messages covered by this undo. Consecutive cancels within the window
   *  accumulate here so a single Undo restores them all (e.g. "cancel queued"). */
  messageIds: string[];
  /** The resend can restore text only; the original carried richer delivery data. */
  textOnlyRestore?: boolean;
  /** Epoch ms when the undo window closes. */
  expiresAt: number;
}

// ===========================================================================
// Deferred agent — first-agent setup + pre-send delivery queue
// ===========================================================================

/** A message the user "sent" while no agent was present yet — held client-side
 *  (unsent) and flushed live once the first agent joins the roster, so the very
 *  first message lands as a normal live turn rather than backlog replay. */
export interface PendingDelivery {
  id: string;
  text: string;
  attachments?: AttachmentInput[];
  mentions?: string[];
  replyTo?: string;
  metadata?: Record<string, unknown>;
  tier?: MessageTier;
  /** Stable key for idempotent (re)delivery — e.g. an injected initialPrompt. */
  idempotencyKey?: string;
}

/** State for the first-agent flow: the inline armed config plus the queue of
 *  messages waiting for that agent to come online. Present only on surfaces that
 *  can create agents (host supplies `onAddAgent`). */
export interface DeferredAgentState {
  /** No agent present and one can or will be created — hides the header
   *  "Add agent" launcher (the inline setup owns adding the first agent). */
  active: boolean;
  /** Show the inline config card: no agent present, none already spawning, and
   *  we have the means to spawn one. Flips false once the first message arms it. */
  setupActive: boolean;
  /** True once the first message has armed the spawn (agent launching) — drives
   *  the "Launching agent…" spinner/explanation in the pre-send queue. */
  launching: boolean;
  /** The spawn failed (onAddAgent rejected) — drives the queue's error + retry UI. */
  launchFailed: boolean;
  /** The host found no configured model for the first agent. Its queued first
   *  message must wait for an explicit model/provider choice. */
  modelSelectionRequired: boolean;
  /** Model/provider discovery has not resolved yet. The queued message is
   * waiting on preflight, not on an agent that has already been launched. */
  modelDiscoveryPending: boolean;
  /** Confirm the current draft and start the agent for the queued message. */
  startQueued: () => void;
  /** Retry a failed launch (re-issues the spawn). */
  retryLaunch: () => void;
  /** Inline config draft (model/effort/autonomy/…) applied to the agent spawned
   *  on the first message. */
  draft: AgentConfigDraft;
  setDraft: (next: AgentConfigDraft) => void;
  /** Selected agent-type id (worker source) for the first agent. */
  agentId: string | undefined;
  setAgentId: (id: string | undefined) => void;
  /** Agent types available to choose from (mirrors `availableAgents`). */
  availableAgents: AvailableAgent[];
  /** Messages queued (unsent) until the agent joins; rendered in the pre-send queue. */
  queued: PendingDelivery[];
  /** Drop a queued message before it is delivered. */
  cancelQueued: (id: string) => void;
}

// ===========================================================================
// Fork lineage UI (switcher, tree, inline rows, subagent review)
// ===========================================================================

/** Client-side mirror of the channel DO's `getProvenance()` result. */
export type ChannelProvenance =
  | { kind: "root" }
  | {
      kind: "fork";
      forkedFrom: string;
      parentContextId: string;
      forkPointId: number;
      rootChannelId: string;
    }
  | {
      kind: "task";
      parentChannelId: string;
      parentContextId: string;
      runId: string;
    };

/** A fork surfaced in the switcher / tree (a child of the current channel or a
 *  sibling read from the parent's `forks` projection). */
export interface ForkEntry {
  forkId: string;
  channelId: string;
  contextId: string;
  label: string;
  reason: string;
  actorName: string;
  actorId: string;
  forkPointId: number;
  createdAtSeq: number;
  /** Latest durable head reported by this fork. */
  headSeq: number;
  /** Channel on whose log rename/archive facts for this entry live. */
  parentChannelId: string;
  archived: boolean;
  /** Live "has unread since our cursor" badge, reconciled on open (§H). */
  unread?: boolean;
}

/** One node of the lazily-walked lineage tree ("Show tree" overlay). */
export interface ForkTreeNode {
  channelId: string;
  contextId?: string;
  label: string;
  provenanceKind: "root" | "fork" | "task";
  children: ForkTreeNode[];
  isCurrent: boolean;
  headSeq?: number;
  unread?: boolean;
}

/** Panel-supplied navigation handlers. */
export interface ForkNavHandlers {
  /** In-place switch: rebind the panel's channel + context and reconnect. */
  switchTo: (channelId: string, contextId: string) => void | Promise<void>;
  /** Side-by-side: open the fork in a NEW chat panel. */
  openInNewPanel: (channelId: string, contextId: string) => void | Promise<void>;
  /** Panel-persisted lineage read cursors. */
  readForkCursors?: () => Record<string, number>;
  /** Persist one monotone lineage read cursor. */
  markForkRead?: (channelId: string, headSeq: number) => void | Promise<void>;
  /** A fork the local user did not initiate just landed. The shell owns focus
   * policy and notification presentation. */
  onExternalFork?: (fork: {
    forkedChannelId: string;
    forkedContextId: string;
    actorName: string;
    forkPointId: number;
  }) => void | Promise<void>;
}

/** Fork lineage state + actions threaded onto ChatContextValue and read by the
 *  ForkSwitcher, ForkTreeView, inline fork rows, and SubagentRunCard. */
export interface ForkUiState {
  provenance?: ChannelProvenance;
  currentLabel: string;
  /** Direct-child forks of the current channel (from `ChannelViewState.forks`). */
  children: ForkEntry[];
  /** Sibling forks (the parent's other children); loaded lazily by `refresh`. */
  siblings: ForkEntry[];
  /** Parent channel breadcrumb, when this channel is itself a fork. */
  parent?: { channelId: string; contextId?: string };
  /** True while a fork op is mid-flight (disables the affordances). */
  forking: boolean;
  /** Last actionable lineage/fork failure; never dropped to console only. */
  error?: string;
  /** Reconcile siblings + badges from durable heads (call on switcher/tree open). */
  refresh: () => void;
  /** Walk provenance up + forks down into the full lineage tree (lazy). */
  loadTree: () => Promise<ForkTreeNode[]>;
  actions: {
    /** Fork at a message's seq (inclusive), no seed. */
    forkFromMessage: (msg: ChatMessage) => Promise<void>;
    /** Fork at seq−1 seeding an edited/authored turn (replaces for agent msgs). */
    editAndForkMessage: (msg: ChatMessage, newText: string) => Promise<void>;
    /** Channel-level fork at the current head, no seed. */
    newFork: () => Promise<void>;
    renameFork: (entry: ForkEntry, label: string) => Promise<void>;
    archiveFork: (entry: ForkEntry) => Promise<void>;
    clearError: () => void;
    reportError: (summary: string, error: unknown) => void;
  } & ForkNavHandlers;
}

// ===========================================================================
// ChatContext Value
// ===========================================================================

export interface ChatContextValue {
  // Connection
  connected: boolean;
  /** True once the initial replay has settled — `messages` then reliably
   *  reflects prior history (distinct from socket connect). */
  replaySettled: boolean;
  status: string;
  channelId: string | null;
  /** Current user-visible channel title, updated with channel config changes. */
  channelTitle: string | null;
  /** Connected runtime caller that can receive OAuth browser handoff events. */
  browserHandoffCaller: BrowserHandoffCaller;
  sessionEnabled?: boolean;
  /**
   * Last connection-layer error surfaced by `ConnectionManager.onError`
   * (subscribe failure, event-stream rejection). Cleared on successful
   * reconnect. Rendered inline at the top of the chat by `ChatLayout`
   * so silent stalls become visibly broken.
   */
  connectionError: { message: string; at: number; cause?: unknown } | null;
  /** Clear the current connectionError (e.g., after a retry). */
  dismissConnectionError?: () => void;
  /** Re-run the initial channel connection after a terminal failure. */
  retryConnection?: () => void;

  /** Chat API for sandboxed code */
  chat: ChatSandboxValue;
  clientRef: RefObject<PubSubClient<ChatParticipantMetadata> | null>;
  /** Stable panel identity used to isolate panel-local UI scopes. */
  panelScopeId: string;
  /** Panel-local UI scope shared by inline UI, feedback_custom, and action bar. */
  scope: Record<string, unknown>;
  /** Scope API for the panel-local UI scope. */
  scopes: ScopesApi;
  /** Scope manager for panel-local UI scope reactivity and persistence. */
  scopeManager: ScopeManager;

  // Messages
  messages: ChatMessage[];
  inlineUiComponents: Map<string, InlineUiComponentEntry>;
  messageTypeComponents: Map<string, MessageTypeComponentEntry>;
  actionBar: ActionBarState | null;
  onActionBarMaxHeightChange?: (maxHeight: number, options?: { saveState?: boolean }) => void;
  hasMoreHistory: boolean;
  loadingMore: boolean;

  // Participants
  /** This client's participant ID */
  selfId: ChannelParticipantId | null;
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  allParticipants: Record<string, Participant<ChatParticipantMetadata>>;

  // Agent state
  debugEvents: Array<AgentDebugPayload & { ts: number }>;
  debugConsoleAgent: string | null;
  dirtyRepoWarnings: Map<string, DirtyRepoDetails>;
  pendingAgents: Map<string, PendingAgent>;
  /** First-agent setup + pre-send delivery queue (only on agent-capable hosts). */
  deferredAgent?: DeferredAgentState;

  // Feedback
  activeFeedbacks: Map<string, ActiveFeedback>;

  // Theme
  theme: "light" | "dark";

  // --- Delivery model: outbox, send intent, flush, undo ---------------------
  /**
   * Whether any agent is currently mid-turn. Derived robustly by OR-ing every
   * busy signal (durable typing message, ephemeral roster typing, open turn) so
   * interrupt/steer affordances stay enabled across the whole turn.
   */
  agentBusy: boolean;
  /** Whether the channel has an open/waiting turn that can receive after-turn messages. */
  hasOpenTurn: boolean;
  /** Edit a still-unread outbox message (rebuilds text + attachment blocks). */
  editPendingMessage: (messageId: string, newText: string) => Promise<void>;
  /** Retract a still-unread outbox message; raises an Undo snackbar. */
  cancelPendingMessage: (messageId: string) => Promise<void>;
  /** Esc / "Send now": pause busy agents with flushDeferred and narrate it. */
  flushOutboxAndInterrupt: () => Promise<void>;
  /** What pressing Enter will do right now (drives the send-button label/hint). */
  primaryActionIntent: PrimaryActionIntent;
  /** Transient outcome of the last flush, for the inline pill + aria-live. */
  flushNarration?: FlushNarration;
  /** The short client-side undo window after retract/cancel. */
  undoableAction?: UndoableAction;
  /** Undo the pending undoable action (re-send the retracted message text). */
  undoLastAction?: () => void;
  /**
   * Transient count of locally-in-flight sends ("Sending…" ghost). Local UI
   * state only; never protocol state.
   */
  pendingSendCount: number;
  /** Message ids sent with after-turn intent — drives the outbox lane cue. */
  afterTurnMessageIds: Set<string>;

  // Handlers
  onLoadEarlierMessages: () => void;
  onInterrupt: (agentId: string, messageId?: string, agentHandle?: string) => void;
  onCancelInvocation: (invocation: InvocationCardPayload, senderId: string) => void;
  onCallMethod: (providerId: string, methodName: string, args: unknown) => void;
  /** Awaits and returns the provider's result payload (for settings UIs). */
  onCallMethodResult: (providerId: string, methodName: string, args: unknown) => Promise<unknown>;
  onFeedbackDismiss: (callId: string) => void;
  onFeedbackError: (callId: string, error: Error) => void;
  onDebugConsoleChange: (agentHandle: string | null) => void;
  onDismissDirtyWarning: (agentName: string) => void;

  // Optional actions (platform-specific)
  onListTaskRules?: () => Promise<
    Array<{
      id: string;
      capability: string;
      action: string;
      resource: string;
      decidedAt: number;
    }>
  >;
  onResetTaskRules?: () => Promise<number>;
  onAddAgent?: (agentId?: string, config?: AgentSubscriptionConfig) => void;
  /** Replace an existing agent (by participant id), reusing its handle. */
  onReplaceAgent?: (
    participantId: string,
    agentId?: string,
    config?: AgentSubscriptionConfig
  ) => Promise<void> | void;
  /** Start installing a local model; live progress arrives through modelCatalog. */
  onInstallLocalModel?: (modelRef: string) => Promise<ModelSetupResult>;
  availableAgents?: AvailableAgent[];
  /** Static pi model catalog; connection status merged in the UI. */
  modelCatalog?: ModelCatalog | null;
  /** Workspace default model ref ("provider:modelId") for new agents. */
  defaultModelRef?: string | null;
  /** Full workspace default agent config (model + behavior) for new agents. */
  defaultAgentConfig?: DefaultAgentConfig | null;
  /** Explicitly save the full default agent config (model + behavior) as the
   *  workspace default — the ONLY path that writes it. Wired to the "Save as
   *  defaults" control in the agent config UI. */
  onSaveDefaults?: (config: DefaultAgentConfig) => Promise<void> | void;
  onRemoveAgent?: (handle: string) => void;
  onFocusPanel?: (panelId: string) => void;
  onReloadPanel?: (panelId: string) => void;
  /** Find-or-open the chat panel for another channel, landing on an envelope
   *  when given (messaging plan §4.10). */
  onOpenChannel?: (channelId: string, opts?: { focusMessageId?: string }) => Promise<void> | void;
  /** Start a fresh conversation (surfaced for the command palette). */
  onNewConversation?: (options?: NewConversationOptions) => void | Promise<void>;
  /** Launch Claude Code as a linked agent in this conversation (§4.3). */
  onOpenClaudeCode?: (channelId: string) => Promise<void> | void;
  /** Open the Local Models panel focused on a server's log (item 6) — wired
   *  from a local model's red error dot in the picker. */
  onOpenLocalModelsLog?: (server: "utility" | "main") => void;
  /** Open the full Local Models manager. */
  onOpenLocalModels?: () => void;

  // Tool approval (optional)
  toolApproval?: ToolApprovalProps;

  /** Fork lineage state + actions (switcher, tree, inline rows, subagent
   *  review). Absent on hosts that don't wire fork navigation. */
  forkState?: ForkUiState;

  /**
   * Connection material letting a subagent run card lazily observe the child's
   * own task channel and render its real transcript inline. Absent on hosts
   * without a live connection (tests, static transcript views), where cards
   * fall back to the relayed progress feed.
   */
  childTranscript?: ChildTranscriptConnection;
}

/** Which await a loading message type is currently parked on. */
export type MessageTypeLoadingStage = "fetching-definition" | "loading-source" | "compiling";

export type MessageTypeRegistryEntry =
  | {
      status: "ready";
      definition: MessageTypeDefinition;
      module: import("@workspace/agentic-core").MessageTypeModule;
      cacheKey: string;
    }
  | {
      status: "loading";
      /** Stage the load is parked on — makes an endless spinner self-describing. */
      stage?: MessageTypeLoadingStage;
      /** Epoch ms when this stage started. */
      startedAt?: number;
      /** Definition being compiled, when known (absent while fetching it). */
      definition?: MessageTypeDefinition;
    }
  | {
      status: "error";
      message: string;
      /** Registration seq the failure corresponds to (newer seqs recompile). */
      updatedAtSeq?: number;
      /** Definition that failed, when known. */
      definition?: MessageTypeDefinition;
      /** Re-attempt the fetch/compile that produced this error. */
      retry?: () => void;
    };

export type MessageTypeComponentEntry = MessageTypeRegistryEntry;
