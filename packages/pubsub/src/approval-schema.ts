/**
 * Worker Base Utilities
 *
 * Provides createApprovalSchema for building unified tool approval UI fields.
 * Used by both workers and panels (via tool-ui).
 */

import { hasRichPreview } from "./tool-types.js";
import { normalizeToolName, getCanonicalToolName } from "./tool-name-utils.js";
import type { FieldDefinition } from "@vibestudio/types";

// ============================================================================
// Unified Approval Schema
// ============================================================================

/**
 * Parameters for creating an approval schema.
 */
export interface CreateApprovalSchemaParams {
  /** Name of the agent requesting access */
  agentName: string;
  /** Tool name (any format - will be normalized) */
  toolName: string;
  /** Optional display name override for the tool */
  displayName?: string;
  /** Tool input arguments */
  args: unknown;
  /** Whether this is a first-time grant (vs per-call) */
  isFirstTimeGrant: boolean;
  /** Current approval level (0=Ask All, 1=Auto-Safe, 2=Full Auto) */
  floorLevel: number;
  /** Optional reason for the permission request (shown to user) */
  reason?: string;
}

/**
 * Create a unified approval schema for tool approval prompts.
 *
 * The schema provides consistent UI for permission prompts:
 * - approvalHeader: Shows agent name, tool name, first-time grant status, floor level
 * - reason (optional): Shows why approval is needed
 * - toolPreview: Rich preview for supported tools (bash, plan mode)
 * - buttonGroup: Allow/Deny decision buttons with tool-specific labels
 *
 * @param params - Parameters for the approval schema
 * @returns Array of field definitions for the approval form
 */
export function createApprovalSchema(params: CreateApprovalSchemaParams): FieldDefinition[] {
  const normalized = normalizeToolName(params.toolName);
  const displayName = params.displayName ?? getCanonicalToolName(normalized);

  const fields: FieldDefinition[] = [
    // Header with agent info and approval context
    {
      key: "header",
      type: "approvalHeader",
      agentName: params.agentName,
      toolName: normalized,
      displayName,
      isFirstTimeGrant: params.isFirstTimeGrant,
      floorLevel: params.floorLevel,
    },
  ];

  // Add reason field if provided
  if (params.reason) {
    fields.push({
      key: "reason",
      label: "Reason",
      type: "readonly",
      default: params.reason,
    });
  }

  // Add tool preview for supported tools, otherwise show JSON args
  if (hasRichPreview(normalized)) {
    fields.push({
      key: "preview",
      type: "toolPreview",
      toolName: normalized,
      toolArgs: params.args,
    });
  } else {
    // For tools without rich preview, show JSON args
    fields.push({
      key: "args",
      label: "Arguments",
      type: "code",
      language: "json",
      maxHeight: 150,
      default: JSON.stringify(params.args, null, 2),
    });
  }

  // Decision buttons - use tool-specific labels for clarity
  const isExitPlanApproval = normalized === "exit_plan_mode";
  const isEnterPlanApproval = normalized === "enter_plan_mode";

  let buttons: Array<{ value: string; label: string; color: "gray" | "green" | "amber" }>;
  if (isExitPlanApproval) {
    buttons = [
      { value: "deny", label: "Reject", color: "gray" },
      { value: "allow", label: "Approve Plan", color: "green" },
      { value: "always", label: "Trust Agent", color: "amber" },
    ];
  } else if (isEnterPlanApproval) {
    buttons = [
      { value: "deny", label: "Deny", color: "gray" },
      { value: "allow", label: "Enter Plan Mode", color: "green" },
      { value: "always", label: "Always Allow", color: "amber" },
    ];
  } else if (params.isFirstTimeGrant) {
    buttons = [
      { value: "deny", label: "Deny", color: "gray" },
      { value: "allow", label: "Grant Access", color: "green" },
      { value: "always", label: "Always Allow", color: "amber" },
    ];
  } else {
    buttons = [
      { value: "deny", label: "Deny", color: "gray" },
      { value: "allow", label: "Allow", color: "green" },
      { value: "always", label: "Always Allow", color: "amber" },
    ];
  }

  fields.push({
    key: "decision",
    type: "buttonGroup",
    submitOnSelect: true,
    buttons,
  });

  return fields;
}
