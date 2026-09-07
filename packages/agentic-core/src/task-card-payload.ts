import type { InvocationOutcome } from "@workspace/agentic-protocol";

export interface SubagentRunState {
  runId?: string;
  mode?: "fresh" | "fork";
  taskChannelId?: string;
  contextId?: string;
  parentContextId?: string | null;
  childEntityId?: string;
  childParticipantId: string;
  label?: string;
  agentKind?: string;
  launchConfig?: Record<string, unknown> | null;
}

export interface TaskCardPayload {
  id: string;
  taskType: string;
  title: string;
  execution: {
    status: "pending" | "running" | "complete" | "error" | "cancelled" | "abandoned";
    terminalOutcome?: InvocationOutcome;
    description: string;
    result?: unknown;
    isError?: boolean;
  };
  subagent?: SubagentRunState;
}
