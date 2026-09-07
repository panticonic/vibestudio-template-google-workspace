/**
 * Core types for the tool-ui package.
 *
 * This file contains all shared type definitions used across feedback forms,
 * tool approval prompts, and related UI components.
 */

import type { ComponentType } from "react";
import type { FieldDefinition, FieldValue } from "@vibestudio/types";

// ============================================================================
// Feedback Result Types
// ============================================================================

/**
 * Result returned from a feedback component.
 * Discriminated union with three cases:
 * - submit: user submitted data successfully
 * - cancel: user cancelled (empty case, no data)
 * - error: an error occurred (includes message)
 */
export type FeedbackResult =
  | { type: "submit"; value: unknown }
  | { type: "cancel" }
  | { type: "error"; message: string };

/**
 * Completion callbacks shared by all feedback types (schema-based and TSX).
 */
export interface FeedbackCallbacks {
  /** Call when user submits data successfully */
  onSubmit: (value: unknown) => void;
  /** Call when user cancels (no data) */
  onCancel: () => void;
  /** Call when an error occurs */
  onError: (message: string) => void;
}

/**
 * Props passed to TSX feedback components (feedback_custom).
 * Extends callbacks with the sandbox chat binding.
 */
export interface FeedbackComponentProps extends FeedbackCallbacks {
  /** Chat API — publish messages, access runtime, etc. */
  chat: Record<string, unknown>;
  /** Panel-local durable UI scope. Serializable values survive panel reloads. */
  scope: Record<string, unknown>;
  /** Panel-local scope API — save/list/push/get scope snapshots. */
  scopes: Record<string, unknown>;
}

// ============================================================================
// Active Feedback Types
// ============================================================================

/**
 * Base interface for active feedback items
 */
export interface ActiveFeedbackBase {
  callId: string;
  /** Complete the feedback with a result (submit, cancel, or error) */
  complete: (result: FeedbackResult) => void;
  createdAt: number;
}

/**
 * TSX code-based feedback (compiled React component)
 */
export interface ActiveFeedbackTsx extends ActiveFeedbackBase {
  type: "tsx";
  Component: ComponentType<FeedbackComponentProps>;
  /** Cache key for cleanup after feedback completion */
  cacheKey: string;
  /** Optional title for the feedback container header */
  title?: string;
}

/**
 * Schema-based feedback (uses FormRenderer)
 */
export interface ActiveFeedbackSchema extends ActiveFeedbackBase {
  type: "schema";
  title: string;
  fields: FieldDefinition[];
  values: Record<string, FieldValue>;
  submitLabel?: string;
  cancelLabel?: string;
  severity?: "info" | "warning" | "danger";
  hideSubmit?: boolean;
  hideCancel?: boolean;
  /** Omit the header close button when dismissing would have a destructive meaning. */
  dismissible?: boolean;
}

/**
 * Discriminated union of all feedback types
 */
export type ActiveFeedback = ActiveFeedbackTsx | ActiveFeedbackSchema;

// ============================================================================
// Tool Approval Types
// ============================================================================

/**
 * Approval level type for the three permission modes.
 * 0 = Ask All: Request approval for every tool call
 * 1 = Auto-Safe: Auto-approve read-only tools, ask for writes
 * 2 = Full Auto: Auto-approve all tools
 */
export type ApprovalLevel = 0 | 1 | 2;

/**
 * Tool approval settings — channel-global approval level.
 */
export interface ToolApprovalSettings {
  /** Global floor: 0=Ask All, 1=Auto-Safe, 2=Full Auto */
  globalFloor: ApprovalLevel;
}

/**
 * Return type of useToolApproval hook.
 *
 * Approval level is channel-global and stored in channel config.
 * Per-agent grants have been removed — one level applies to all agents.
 */
export interface UseToolApprovalResult {
  settings: ToolApprovalSettings;
  setGlobalFloor: (level: ApprovalLevel) => Promise<void>;
}

/**
 * Grouped props for tool approval functionality (passed to components).
 */
export interface ToolApprovalProps {
  settings: ToolApprovalSettings;
  onSetFloor: (level: ApprovalLevel) => Promise<void>;
}

// ============================================================================
// Feedback Compilation Types
// ============================================================================

/**
 * Arguments for compiling a feedback UI component from TSX code.
 */
export interface FeedbackUiToolArgs {
  /** TSX code defining a React component */
  code: string;
}

/**
 * Result of compiling a feedback UI component.
 */
export interface FeedbackUiToolResult {
  success: boolean;
  /** The compiled React component (if successful) */
  Component?: ComponentType<FeedbackComponentProps>;
  /** Cache key for cleanup (if successful) */
  cacheKey?: string;
  /** Error message (if failed) */
  error?: string;
}
