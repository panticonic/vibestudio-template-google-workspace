import { Box } from "@radix-ui/themes";
import type { InvocationCardPayload, ToolExecutionState } from "@workspace/agentic-core";

/**
 * One status vocabulary for every surface that renders an invocation: the
 * inline tool pill, the expanded tool detail, and the subagent run card (its
 * header, and the child calls consolidated inside it). Previously each of
 * these carried its own colour/label table, so a "cancelled" child call could
 * read amber in one place and gray in another.
 */

export type StatusKey = "pending" | "complete" | "error" | "cancelled" | "abandoned";

export type StatusTone = "gray" | "green" | "red" | "amber" | "blue";

const STATUS_DOT_COLOR: Record<StatusKey, string> = {
  pending: "var(--gray-8)",
  complete: "var(--green-9)",
  error: "var(--red-9)",
  cancelled: "var(--amber-9)",
  abandoned: "var(--amber-9)",
};

const STATUS_LABEL: Record<ToolExecutionState["status"], string> = {
  pending: "Pending",
  running: "Running",
  complete: "Complete",
  error: "Error",
  cancelled: "Cancelled",
  abandoned: "Abandoned",
};

/** Full execution status → tone, for headers that distinguish running from queued. */
const EXECUTION_TONE: Record<ToolExecutionState["status"], StatusTone> = {
  pending: "gray",
  running: "blue",
  complete: "green",
  error: "red",
  cancelled: "amber",
  abandoned: "gray",
};

export function getStatusKey(payload: InvocationCardPayload): StatusKey {
  const status = payload.execution.status;
  if (status === "pending" || status === "running") return "pending";
  if (status === "cancelled") return "cancelled";
  if (status === "abandoned") return "abandoned";
  return payload.execution.isError || status === "error" ? "error" : "complete";
}

export function getStatusColor(statusKey: StatusKey): "red" | "amber" | "green" {
  return statusKey === "error"
    ? "red"
    : statusKey === "pending" || statusKey === "cancelled" || statusKey === "abandoned"
      ? "amber"
      : "green";
}

export function executionStatusLabel(status: ToolExecutionState["status"]): string {
  return STATUS_LABEL[status];
}

export function executionStatusTone(status: ToolExecutionState["status"]): StatusTone {
  return EXECUTION_TONE[status];
}

/** True while the run may still produce updates. */
export function isLiveStatus(status: ToolExecutionState["status"]): boolean {
  return status === "pending" || status === "running";
}

export function StatusDot({ statusKey }: { statusKey: StatusKey }) {
  return (
    <Box
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        backgroundColor: STATUS_DOT_COLOR[statusKey],
        flexShrink: 0,
      }}
    />
  );
}
