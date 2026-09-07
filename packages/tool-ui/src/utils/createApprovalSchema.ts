/**
 * Create Approval Schema
 *
 * Re-exports the unified createApprovalSchema from @workspace/pubsub.
 * This ensures both restricted mode (panel-side) and unrestricted mode (worker-side)
 * use the exact same schema builder.
 *
 * The schema includes:
 * - approvalHeader: Agent name, tool name, first-time grant status, floor level
 * - reason (optional): Why approval is needed
 * - toolPreview: Rich preview for supported tools (Monaco diffs, git previews)
 * - buttonGroup: Allow/Deny decision buttons with tool-specific labels
 */

// Re-export from the canonical source
export {
  createApprovalSchema,
  type CreateApprovalSchemaParams,
} from "@workspace/pubsub";
