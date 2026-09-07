/**
 * Core Tool Preview Components (Monaco-free)
 *
 * These components don't require Monaco and can be imported without
 * bundling the Monaco editor.
 */

export { BashPreview, type BashPreviewProps } from "./BashPreview.js";
export { ExitPlanModePreview, type ExitPlanModePreviewProps } from "./ExitPlanModePreview.js";
export { EnterPlanModePreview, type EnterPlanModePreviewProps } from "./EnterPlanModePreview.js";

// ============================================================================
// Re-export types and type guards from pubsub
// ============================================================================

// These are the canonical definitions - we re-export them for convenience
export {
  // Type guards
  isBashArgs,
  isEnterPlanModeArgs,
  isExitPlanModeArgs,
  // Rich preview helpers
  hasRichPreview,
  RICH_PREVIEW_TOOLS,
  // Types
  type BashArgs,
  type EnterPlanModeArgs,
  type ExitPlanModeArgs,
  type AllowedPrompt,
  type RichPreviewToolName,
} from "@workspace/pubsub";
