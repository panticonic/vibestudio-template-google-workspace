/**
 * Pure helper functions for ActionData serialization.
 * Extracted so they can be unit-tested without importing the DO base class.
 */

/** Extract a human-readable summary from a tool result for ActionData description. */
export function summarizeToolResult(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 300);
  if (result == null) return "Done";

  // Normalize: tool results can be a plain array of content blocks OR
  // an object with a `content` array (e.g. { content: [...], details: {...} }).
  let blocks: unknown[] | null = null;
  if (Array.isArray(result)) {
    blocks = result;
  } else if (typeof result === "object" && Array.isArray((result as Record<string, unknown>)["content"])) {
    blocks = (result as Record<string, unknown>)["content"] as unknown[];
  }

  if (blocks) {
    const parts: string[] = [];
    for (const item of blocks) {
      const block = item as { type?: string; text?: string; mimeType?: string };
      if (block?.type === "text" && typeof block.text === "string") {
        parts.push(block.text.slice(0, 200));
      } else if (block?.type === "image") {
        parts.push(`Image (${block.mimeType ?? "image"})`);
      }
    }
    if (parts.length > 0) return parts.join("; ").slice(0, 300);
  }

  // Fallback: stringified, truncated
  let s: string;
  try {
    s = JSON.stringify(result);
  } catch {
    return String(result);
  }
  return s.length > 300 ? s.slice(0, 297) + "..." : s;
}

const RESULT_MAX_BYTES = 32_768;
const STRING_TRUNCATE_LEN = 8_000;

/**
 * Truncate a tool result for inclusion in ActionData JSON.
 * Preserves structure (objects, arrays, content blocks) so the expanded UI
 * can render a JsonValue tree. Only individual long strings are shortened.
 * Returns { value, truncated }.
 */
export function truncateResult(result: unknown): { value: unknown; truncated: boolean } {
  if (result === null || result === undefined) {
    return { value: result, truncated: false };
  }
  if (typeof result === "string") {
    if (result.length <= RESULT_MAX_BYTES) return { value: result, truncated: false };
    return { value: result.slice(0, STRING_TRUNCATE_LEN) + `\n... (${result.length - STRING_TRUNCATE_LEN} chars truncated)`, truncated: true };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    // Non-serializable result (circular refs, BigInts, etc.)
    return { value: String(result), truncated: true };
  }
  if (serialized.length <= RESULT_MAX_BYTES) {
    return { value: result, truncated: false };
  }
  return { value: deepTruncateStrings(result), truncated: true };
}

/**
 * Recursively walk a value and truncate long strings to preserve structure
 * for the JsonValue tree renderer in the UI.
 */
function deepTruncateStrings(value: unknown, maxStr = STRING_TRUNCATE_LEN): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length <= maxStr) return value;
    return value.slice(0, maxStr) + `... (${value.length - maxStr} chars truncated)`;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map(item => deepTruncateStrings(item, maxStr));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = deepTruncateStrings(v, maxStr);
  }
  return out;
}
