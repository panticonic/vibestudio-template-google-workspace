/**
 * Typed append-failure contract for the unified log.
 *
 * Semantic control-plane appendLogEvent failures cross the workerd RPC boundary as
 * plain Error messages, so the machine-readable code is embedded in the
 * message with a stable marker. Callers MUST use classifyGadAppendError to
 * branch on failure kind — never match prose.
 *
 * Codes:
 * - "id-collision":   an envelope id already exists in the lineage with
 *                     DIFFERENT semantic content. Under intent "exact" this
 *                     is an integrity violation (a divergent duplicate —
 *                     surface it). It never means "safe to ignore".
 * - "head-conflict":  expectedHeadHash did not match the current head and
 *                     none of the batch was an already-applied replay. The
 *                     caller's fold is stale; the events are NEW — reload
 *                     and retry the append.
 * - "replay-mismatch": the batch mixes already-applied events with new ones
 *                     in a way that no longer lines up with the head
 *                     (already-applied events after a new suffix, or a
 *                     replayed prefix that is not the current head). Reload
 *                     and re-derive the batch.
 */

export type GadAppendErrorCode = "id-collision" | "head-conflict" | "replay-mismatch";

const MARKER = "GadAppendError";
const MARKER_PATTERN = /GadAppendError\[(id-collision|head-conflict|replay-mismatch)\]/u;

export function gadAppendErrorMessage(code: GadAppendErrorCode, detail: string): string {
  return `${MARKER}[${code}]: ${detail}`;
}

export function classifyGadAppendError(error: unknown): GadAppendErrorCode | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const match = MARKER_PATTERN.exec(message);
  return (match?.[1] as GadAppendErrorCode | undefined) ?? null;
}

/** Append idempotency intent.
 *
 * - "exact" (default): every envelope id must either be absent (appended) or
 *   already journaled with IDENTICAL semantic content (idempotent replay).
 *   Same id + different content is a hard "id-collision" error. This is the
 *   contract for trusted appenders (drivers, call terminals, system events).
 * - "idempotent-by-id": first write wins. Same id + different content
 *   returns the journaled original instead of erroring. ONLY for client
 *   publish paths where the id is the client's stable retry token and
 *   payload fields may legitimately vary between retries.
 */
export type AppendIdempotency = "exact" | "idempotent-by-id";
