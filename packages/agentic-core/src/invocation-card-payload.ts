/**
 * Structured UI payload for rendering invocation cards.
 *
 * Channel envelopes carry typed invocation events. The chat projection derives
 * this card payload for the React transcript; it is not a channel protocol.
 */
import type { InvocationOutcome } from "@workspace/agentic-protocol";

export interface InvocationCardPayload {
  id: string;
  transportCallId?: string;
  name: string;
  arguments: Record<string, unknown>;
  execution: ToolExecutionState;
}

export interface ToolExecutionState {
  status: "pending" | "running" | "complete" | "error" | "cancelled" | "abandoned";
  terminalOutcome?: InvocationOutcome;
  terminalReasonCode?: string;
  description: string;
  consoleOutput?: string;
  result?: unknown;
  isError?: boolean;
  resultTruncated?: boolean;
  resultImages?: ReadonlyArray<{ mimeType: string; data: string }>;
}

/** Parse an InvocationCardPayload from a derived chat message's `content` string.
 *  Returns null on malformed input so consumers can fall back gracefully. */
export function parseInvocationCardPayload(content: string): InvocationCardPayload | null {
  if (!content) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj["id"] !== "string" || typeof obj["name"] !== "string") return null;
  if (!obj["execution"] || typeof obj["execution"] !== "object") return null;
  const exec = obj["execution"] as Record<string, unknown>;
  const status = exec["status"];
  if (
    status !== "pending" &&
    status !== "running" &&
    status !== "complete" &&
    status !== "error" &&
    status !== "cancelled" &&
    status !== "abandoned"
  ) {
    return null;
  }
  if (typeof exec["description"] !== "string") return null;
  if (exec["terminalOutcome"] !== undefined && typeof exec["terminalOutcome"] !== "string") {
    return null;
  }
  if (exec["terminalReasonCode"] !== undefined && typeof exec["terminalReasonCode"] !== "string") {
    return null;
  }
  return parsed as InvocationCardPayload;
}
