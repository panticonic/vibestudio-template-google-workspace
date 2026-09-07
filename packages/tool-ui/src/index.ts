/**
 * @workspace/tool-ui
 *
 * Shared UI components for feedback forms, tool approval prompts, and tool previews.
 * Provides reusable building blocks for any panel that needs to display feedback UIs
 * or handle tool approval workflows.
 */

// ============================================================================
// Types
// ============================================================================
export type {
  FeedbackResult,
  FeedbackCallbacks,
  FeedbackComponentProps,
  ActiveFeedback,
  ActiveFeedbackBase,
  ActiveFeedbackSchema,
  ActiveFeedbackTsx,
  ApprovalLevel,
  ToolApprovalSettings,
  UseToolApprovalResult,
  ToolApprovalProps,
  FeedbackUiToolArgs,
  FeedbackUiToolResult,
} from "./types";

// Re-export from pubsub for convenience
export type { FeedbackFormArgs } from "@workspace/pubsub";

// ============================================================================
// Components
// ============================================================================
export { FeedbackFormRenderer, type FeedbackFormRendererProps } from "./components/FeedbackFormRenderer";
export { FeedbackContainer, type FeedbackContainerProps } from "./components/FeedbackContainer";
export {
  SurfaceFrame,
  surfaceButtonProps,
  type SurfaceFrameProps,
  type SurfaceTone,
} from "./components/SurfaceFrame";
export { ToolPreviewField, type ToolPreviewFieldProps } from "./components/ToolPreviewField";
export { ErrorBoundary } from "./components/ErrorBoundary";
export { EventErrorBoundary, type EventErrorBoundaryProps } from "./components/EventErrorBoundary";

// Tool Previews (core exports)
export {
  BashPreview,
  isBashArgs,
  hasRichPreview,
  RICH_PREVIEW_TOOLS,
  type BashArgs,
  type RichPreviewToolName,
} from "./components/tool-previews/core.js";

// ============================================================================
// Hooks
// ============================================================================
export { useFeedbackManager, type UseFeedbackManagerResult } from "./hooks/useFeedbackManager";
export { useToolApproval, APPROVAL_LEVELS } from "./hooks/useToolApproval";

// ============================================================================
// Utilities
// ============================================================================
export { createApprovalSchema, type CreateApprovalSchemaParams } from "./utils/createApprovalSchema";
export { trackPromise } from "./utils/trackAsyncErrors";

// ============================================================================
// Additional Components
// ============================================================================
export { ApprovalHeaderField, type ApprovalHeaderFieldProps } from "./components/ApprovalHeaderField";
