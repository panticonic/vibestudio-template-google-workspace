/**
 * Tool Preview Components
 *
 * Rich UI components for displaying tool call arguments in the approval prompt.
 * Each component provides a specialized view for its tool type.
 */

export { BashPreview, type BashPreviewProps } from "./BashPreview";

// ============================================================================
// Re-export types and type guards from pubsub
// ============================================================================

// These are the canonical definitions - we re-export them for convenience
export {
  // Type guards
  isBashArgs,
  // Rich preview helpers
  hasRichPreview,
  RICH_PREVIEW_TOOLS,
  // Types
  type BashArgs,
  type RichPreviewToolName,
} from "@workspace/pubsub";
