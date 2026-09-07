/**
 * Context window usage data types.
 *
 * These types are used across the system for tracking token usage.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Token usage for a single measurement point.
 */
export interface TokenUsage {
  /** Input/prompt tokens consumed */
  inputTokens: number;
  /** Output/completion tokens generated */
  outputTokens: number;
  /** Total tokens (inputTokens + outputTokens) */
  totalTokens: number;
}

/**
 * Cumulative context window usage for a session.
 * Published via participant metadata for UI display.
 */
export interface ContextWindowUsage {
  /** Current turn's token usage */
  current: TokenUsage;
  /** Cumulative session usage (all turns combined) */
  session: TokenUsage;
  /** Model's maximum context window size (if known) */
  maxContextTokens?: number;
  /** Percentage of context used (0-100), based on session.inputTokens vs maxContextTokens */
  usagePercent?: number;
  /** Cumulative cost in USD (if available from provider) */
  costUsd?: number;
  /** Timestamp of last update (ms since epoch) */
  lastUpdated: number;
}

/**
 * Normalized usage data from different SDKs.
 * Agents convert their SDK-specific formats to this.
 */
export interface NormalizedUsage {
  /** Input/prompt tokens consumed */
  inputTokens: number;
  /** Output/completion tokens generated */
  outputTokens: number;
  /** Cost in USD (if available from provider) */
  costUsd?: number;
}
