/**
 * Tool Approval Utilities
 *
 * Functions for determining whether tools need user approval
 * based on approval level and tool name patterns.
 */

import {
  REVERSE_CANONICAL_MAPPINGS,
  extractMethodName,
  normalizeToolName,
} from "./tool-name-utils.js";

/**
 * Approval level constants for tool execution.
 *
 * These define how much autonomy the agent has when executing tools:
 * - ASK_ALL: Always prompt user for approval before any tool execution
 * - AUTO_SAFE: Auto-approve read-only operations, prompt for write operations
 * - FULL_AUTO: Execute all tools without prompting (use with caution)
 */
export const APPROVAL_LEVELS = {
  /** Always ask for approval before executing any tool */
  ASK_ALL: 0,
  /** Auto-approve read-only operations, ask for write operations */
  AUTO_SAFE: 1,
  /** Never ask, execute all tools automatically */
  FULL_AUTO: 2,
} as const;

export type ApprovalLevel = typeof APPROVAL_LEVELS[keyof typeof APPROVAL_LEVELS];

/**
 * Known read-only tools by exact name.
 * Covers native SDK tool names that don't match prefix patterns.
 */
const KNOWN_READ_ONLY_TOOLS = new Set([
  // Native SDK tools (PascalCase)
  "Glob",
  "Grep",
  "View",
  // Pubsub tools (snake_case)
  "check_types",
]);

/**
 * Check if a tool is read-only (safe for auto-approval at level 1).
 * Uses an explicit set for known tools and prefix pattern matching.
 */
export function isReadOnlyTool(methodName: string): boolean {
  // Check explicit set first
  if (KNOWN_READ_ONLY_TOOLS.has(methodName)) return true;

  // Try reverse lookup for canonical names
  const snakeName = REVERSE_CANONICAL_MAPPINGS[methodName];
  if (snakeName && KNOWN_READ_ONLY_TOOLS.has(snakeName)) return true;

  // Prefix pattern matching
  const readPatterns = [/^read/i, /^get/i, /^list/i, /^search/i, /^find/i, /^query/i, /^fetch/i];
  if (snakeName && readPatterns.some((p) => p.test(snakeName))) return true;
  return readPatterns.some((p) => p.test(methodName));
}

/**
 * Determine if a tool needs approval based on approval level.
 *
 * @param toolName - The tool name (may be prefixed or in any naming convention)
 * @param approvalLevel - One of APPROVAL_LEVELS (ASK_ALL, AUTO_SAFE, FULL_AUTO)
 * @returns true if user approval is required, false if auto-approved
 *
 * @see APPROVAL_LEVELS for level definitions
 */
export function needsApprovalForTool(
  toolName: string,
  approvalLevel: ApprovalLevel | number
): boolean {
  if (approvalLevel >= APPROVAL_LEVELS.FULL_AUTO) return false; // Full auto - never ask
  if (approvalLevel === APPROVAL_LEVELS.ASK_ALL) return true; // Ask all - always ask

  // AUTO_SAFE (level 1): Auto-approve read-only operations
  // Try multiple naming conventions to handle SDK tool names
  const methodName = extractMethodName(toolName);

  // First check the raw method name (handles PascalCase like "Read", "Glob")
  if (isReadOnlyTool(methodName)) return false;

  // Also try normalized snake_case (handles "Read" -> "file_read")
  const normalized = normalizeToolName(toolName);
  if (isReadOnlyTool(normalized)) return false;

  // Tool is not read-only, requires approval
  return true;
}
