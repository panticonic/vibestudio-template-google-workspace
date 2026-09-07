/**
 * Context ID utilities for Vibestudio panels and workers.
 *
 * Context IDs use the format:
 *    ctx_{instanceId}
 *
 * All panels run in safe sandboxed mode.
 */

/** Parsed components of a context ID */
export interface ParsedContextId {
  instanceId: string;
}

/**
 * Parse a context ID into its components.
 * Returns null if the context ID is invalid.
 *
 * Format: ctx_{instanceId}
 *
 * @example
 * ```ts
 * const parsed = parseContextId("ctx_panels~editor");
 * // { instanceId: "panels~editor" }
 *
 * const invalid = parseContextId("invalid");
 * // null
 * ```
 */
export function parseContextId(contextId: string): ParsedContextId | null {
  const match = contextId.match(/^ctx_(.+)$/);
  if (match && match[1]) {
    return {
      instanceId: match[1],
    };
  }

  return null;
}

/**
 * Check if a context ID is valid.
 *
 * @example
 * ```ts
 * isValidContextId("ctx_panels~editor"); // true
 * isValidContextId("invalid"); // false
 * ```
 */
export function isValidContextId(contextId: string): boolean {
  return parseContextId(contextId) !== null;
}

/**
 * Get the instance ID from a context ID.
 *
 * @example
 * ```ts
 * getInstanceId("ctx_panels~editor"); // "panels~editor"
 * getInstanceId("invalid"); // null
 * ```
 */
export function getInstanceId(contextId: string): string | null {
  const parsed = parseContextId(contextId);
  return parsed?.instanceId ?? null;
}
