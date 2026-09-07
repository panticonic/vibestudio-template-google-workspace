/**
 * Tool name utilities - mapping, extraction, and prettification.
 *
 * These utilities handle conversion between different tool name formats:
 * - snake_case pubsub names (e.g., "file_read")
 * - PascalCase canonical names (e.g., "Read")
 * - Prefixed names (e.g., "pubsub_abc123_file_read", "mcp__server__Read")
 *
 * Kept separate from tool-types.ts so lightweight consumers (chat UI)
 * can import name utilities without pulling in all Zod schema definitions.
 */

// ============================================================================
// Canonical Tool Name Mappings
// ============================================================================

/**
 * Mapping from pubsub tool names to Claude Agent canonical tool names.
 * Used to provide familiar tool names to the LLM while using pubsub RPC underneath.
 */
export const CANONICAL_TOOL_MAPPINGS: Record<string, string> = {
  // Plan mode
  enter_plan_mode: "EnterPlanMode",
  exit_plan_mode: "ExitPlanMode",
  // Shell
  bash: "Bash",
  // Type checking tools
  check_types: "CheckTypes",
  get_type_info: "GetTypeInfo",
  get_completions: "GetCompletions",
};

/**
 * Reverse mapping from canonical names to pubsub tool names.
 */
export const REVERSE_CANONICAL_MAPPINGS: Record<string, string> = Object.fromEntries(
  Object.entries(CANONICAL_TOOL_MAPPINGS).map(([pubsub, canonical]) => [canonical, pubsub])
);

// ============================================================================
// Name Extraction
// ============================================================================

/**
 * Extract the actual method name from a prefixed tool name.
 *
 * Handles known prefix formats:
 * - pubsub_providerId_methodName -> methodName (e.g., "pubsub_abc123_file_read" -> "file_read")
 * - mcp__server__methodName -> methodName (e.g., "mcp__workspace__ListDirectory" -> "ListDirectory")
 *
 * Does NOT strip parts from regular snake_case names like "exit_plan_mode".
 */
export function extractMethodName(toolName: string): string {
  // Handle MCP prefix format: mcp__server__methodName
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    if (parts.length >= 3) {
      return parts.slice(2).join("__");
    }
  }

  // Handle pubsub prefix format: pubsub_providerId_methodName
  if (toolName.startsWith("pubsub_")) {
    const parts = toolName.split("_");
    if (parts.length >= 3) {
      return parts.slice(2).join("_");
    }
  }

  // No known prefix - return as-is
  return toolName;
}

// ============================================================================
// Prettification & Canonicalization
// ============================================================================

/**
 * Extract the display name from a tool name, stripping MCP/pubsub prefixes
 * and applying canonical name mappings.
 *
 * Examples:
 * - "mcp__workspace__ListDirectory" -> "ListDirectory"
 * - "mcp__proxy-uuid__Read" -> "Read"
 * - "pubsub_abc123_file_read" -> "Read"
 * - "file_read" -> "Read"
 * - "list_directory" -> "ListDirectory"
 */
export function prettifyToolName(toolName: string): string {
  let name = toolName;

  // Strip MCP prefix: mcp__<server>__<name> -> <name>
  // Uses split("__") so server names with underscores (e.g. "my_server") are handled.
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    if (parts.length >= 3) {
      name = parts.slice(2).join("__");
    }
  }
  // Strip pubsub prefix: pubsub_<providerId>_<methodName> -> <methodName>
  else if (name.startsWith("pubsub_")) {
    name = extractMethodName(name);
  }

  // Apply canonical mapping if available
  const canonical = CANONICAL_TOOL_MAPPINGS[name];
  if (canonical) {
    return canonical;
  }

  // If name is already PascalCase (canonical), return as-is
  if (/^[A-Z][a-zA-Z]+$/.test(name)) {
    return name;
  }

  // Convert snake_case to TitleCase as fallback
  return name
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

/**
 * Get the canonical tool name for a pubsub method name.
 * Returns the original name if no mapping exists.
 */
export function getCanonicalToolName(pubsubName: string): string {
  return CANONICAL_TOOL_MAPPINGS[pubsubName] ?? pubsubName;
}

/**
 * Get the pubsub method name for a canonical tool name.
 * Returns the original name if no mapping exists.
 */
export function getPubsubMethodName(canonicalName: string): string {
  return REVERSE_CANONICAL_MAPPINGS[canonicalName] ?? canonicalName;
}

/**
 * Normalize any tool name format to pubsub snake_case format.
 *
 * Handles:
 * - Prefixed names: "pubsub_abc123_file_edit" -> "file_edit"
 * - PascalCase: "Edit" -> "file_edit"
 * - Already normalized: "file_edit" -> "file_edit"
 *
 * @param toolName - Tool name in any format
 * @returns Normalized snake_case pubsub method name
 */
export function normalizeToolName(toolName: string): string {
  // First strip prefix if present
  const stripped = extractMethodName(toolName);
  // Then try to map from PascalCase to snake_case
  return getPubsubMethodName(stripped);
}
