/**
 * Type definitions for message trackers.
 *
 * These interfaces define the contracts for thinking, action, and typing
 * trackers used by responder workers.
 */

import type { AgenticParticipantMetadata } from "./protocol-types.js";
import type { ContextWindowUsage } from "./context-tracker.js";

/**
 * Three participant roles exist on a channel:
 * - **clients** ("panel", "headless") — sources of user input
 * - **agents** ("agent") — AI workers responding to user input
 * - **observers** ("observer") — lifecycle recipients that never reason here
 *
 * The helpers below are positive-match predicates: any new participant type
 * defaults to neither role until it's added explicitly. This is intentional.
 * Negative checks like `type !== "panel"` are forbidden because they
 * accidentally classify new client types as agents (or vice versa).
 */
export function isAgentParticipantType(type: string | undefined): boolean {
  return type === "agent";
}

export function isClientParticipantType(type: string | undefined): boolean {
  return type === "user" || type === "panel" || type === "headless";
}

/**
 * Standard participant metadata for chat-style channels.
 *
 * The canonical participant-metadata shape for both panel-side React adapters
 * and headless workers. `@workspace/agentic-core` re-exports this directly —
 * there is exactly one definition.
 */
export interface ChatParticipantMetadata extends AgenticParticipantMetadata {
  name: string;
  /**
   * Participant role on the channel:
   * - `"user"` — canonical authenticated human (possibly many panels/devices)
   * - `"panel"` — non-canonical interactive UI provider
   * - `"headless"` — programmatic client without a UI (worker, test harness, server)
   * - `"agent"` — AI agent worker responding to user input
   * - `"observer"` — non-interactive lifecycle observer/supervisor
   *
   * Adding a new value? Update `isAgentParticipantType` / `isClientParticipantType`
   * in this file so the role-based filters classify it correctly.
   */
  type: "user" | "panel" | "headless" | "agent" | "observer";
  /** Runtime panel/worker ID — allows chat panel to link participant to child panel for focus/reload */
  panelId?: string;
  /** Worker source identifier for agent identification/recovery (e.g., "workers/agent-worker"). */
  agentTypeId?: string;
  /** Context window usage tracking (updated by AI responders) */
  contextUsage?: ContextWindowUsage;
  /** Execution mode — `"plan"` for planning only, `"edit"` for full execution */
  executionMode?: "plan" | "edit";
  /** Display name of the model currently in use (e.g., `"Claude Opus 4.6"`) */
  activeModel?: string;
  /** Whether this participant is currently typing / working. Set via updateMetadata;
   *  automatically cleared when the participant leaves the channel. */
  typing?: boolean;
  /**
   * Set by an externally-driven linked-agent vessel (a Claude Code session,
   * docs/claude-code-channels-plan.md §8.1). Marks this `agent` participant as
   * one whose reasoning loop runs outside the system via an attached process.
   */
  linkedAgent?: boolean;
  /**
   * Kind of linked agent, e.g. `"claude-code"`. Drives the roster kind badge.
   * Also carried on subagent run details for the SubagentRunCard badge.
   */
  agentKind?: string;
  /**
   * Attachment/presence state of a linked agent: `"attached"` (the external
   * process is connected and online) or `"detached"` (offline; buffered).
   * Drives the roster presence dot.
   */
  linkedAttachment?: "attached" | "detached";
}

/**
 * Source for sandbox-backed UI components.
 */
export type SandboxSource = { type: "code"; code: string } | { type: "file"; path: string };

/**
 * Inline UI data structure sent as message content (JSON stringified).
 */
export interface InlineUiData {
  /** Unique ID for this inline UI instance (allows updates with same ID) */
  id: string;
  /** Component source to compile and render */
  source: SandboxSource;
  /** On-demand package builds required by the component. */
  imports?: Record<string, string>;
  /** Optional props to pass to the component */
  props?: Record<string, unknown>;
  /** Latest stable-ID render revision. */
  renderedAt?: string;
}

/**
 * Action data structure sent as message content (JSON stringified).
 */
export interface ActionData {
  /** Action type identifier (e.g., "Read", "Edit", "Bash", "Grep") */
  type: string;
  /** Brief description of the action (e.g., "Reading src/index.ts") */
  description: string;
  /** Tool use ID for correlation with method calls */
  toolUseId?: string;
  /** Action status */
  status: "pending" | "complete" | "error";
}

/**
 * Interface for the client methods needed by trackers.
 * This allows trackers to work with any AgenticClient implementation.
 */
export interface TrackerClient {
  send(
    content: string,
    options?: { replyTo?: string; contentType?: string }
  ): Promise<{ messageId: string }>;
  update(
    messageId: string,
    content: string,
    options?: { complete?: boolean; contentType?: string }
  ): Promise<void | number | undefined>;
  complete(messageId: string): Promise<void | number | undefined>;
}

// --- Thinking Tracker ---

/**
 * State managed by the thinking tracker.
 */
export interface ThinkingTrackerState {
  /** Current content type being streamed */
  currentContentType: "thinking" | "text" | null;
  /** Message ID for the current thinking message, if any */
  thinkingMessageId: string | null;
  /** Item ID for the current thinking block */
  thinkingItemId: string | null;
}

/**
 * Options for creating a thinking tracker.
 */
export interface ThinkingTrackerOptions {
  /** Client to use for sending/updating messages */
  client: TrackerClient;
  /** Logger function for debug output */
  log?: (message: string) => void;
  /** Message ID to use as replyTo for thinking messages */
  replyTo?: string;
}

/**
 * ThinkingTracker manages the state of thinking/reasoning messages.
 */
export interface ThinkingTracker {
  /** Current state of the tracker */
  readonly state: ThinkingTrackerState;
  setReplyTo(id: string | undefined): void;
  startThinking(itemId?: string): Promise<string>;
  updateThinking(content: string): Promise<void>;
  endThinking(): Promise<void>;
  isThinking(): boolean;
  isThinkingItem(itemId: string): boolean;
  setTextMode(): void;
  cleanup(): Promise<boolean>;
}

// --- Action Tracker ---

/**
 * State managed by the action tracker.
 */
export interface ActionTrackerState {
  /** Current action message ID, if any */
  actionMessageId: string | null;
  /** Current action data */
  currentAction: ActionData | null;
}

/**
 * Options for creating an action tracker.
 */
export interface ActionTrackerOptions {
  /** Client to use for sending/updating messages */
  client: TrackerClient;
  /** Logger function for debug output */
  log?: (message: string) => void;
  /** Message ID to use as replyTo for action messages */
  replyTo?: string;
}

/**
 * ActionTracker manages the state of action messages.
 */
export interface ActionTracker {
  /** Current state of the tracker */
  readonly state: ActionTrackerState;
  setReplyTo(id: string | undefined): void;
  startAction(action: Omit<ActionData, "status">): Promise<string>;
  completeAction(): Promise<void>;
  isActive(): boolean;
  cleanup(): Promise<boolean>;
}
