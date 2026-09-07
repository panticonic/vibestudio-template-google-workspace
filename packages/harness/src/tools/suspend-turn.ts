import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";

const suspendTurnSchema = Type.Object(
  {
    reason: Type.Optional(
      Type.Union([
        Type.Literal("waiting_for_background"),
        Type.Literal("not_addressed"),
        Type.Literal("already_handled"),
        Type.Literal("no_foreground_work"),
      ])
    ),
    noteToSelf: Type.Optional(
      Type.String({
        description:
          "Optional private rationale for why this turn is being suspended without a visible response.",
      })
    ),
  },
  { additionalProperties: false }
);

export type SuspendTurnInput = Static<typeof suspendTurnSchema>;

export interface SuspendTurnDetails {
  suspendTurn: boolean;
  reason: string;
  noteToSelf?: string;
  completedRunsAwaitingIntegration?: string[];
}

export interface SuspendTurnGuardResult {
  suspend: boolean;
  reason?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface SuspendTurnToolOptions {
  /**
   * Validate the requested wait against the runtime state that owns its wake
   * condition. This runs immediately before suspension, so a terminal event
   * that arrived after the model chose the tool can invalidate a stale wait.
   */
  guard?: (input: {
    reason: NonNullable<SuspendTurnInput["reason"]>;
    noteToSelf?: string;
  }) => SuspendTurnGuardResult | Promise<SuspendTurnGuardResult>;
}

export function createSuspendTurnTool(
  options: SuspendTurnToolOptions = {}
): AgentTool<typeof suspendTurnSchema> {
  return {
    name: "suspend_turn",
    label: "suspend turn",
    description:
      "Suspend this agent turn without a visible assistant response. Use when the latest activity is for another agent, has already been handled, or when background work is running and you have no useful foreground work left. The runtime will wake the open turn on later user input or background results; do not poll while suspended.",
    parameters: suspendTurnSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<SuspendTurnDetails>> => {
      const reason = params.reason ?? "no_foreground_work";
      const guarded = await options.guard?.({
        reason,
        ...(params.noteToSelf ? { noteToSelf: params.noteToSelf } : {}),
      });
      if (guarded && !guarded.suspend) {
        return {
          content: [
            {
              type: "text",
              text:
                guarded.message ??
                "Turn was not suspended because its waiting condition is no longer true.",
            },
          ],
          details: {
            suspendTurn: false,
            reason: guarded.reason ?? "waiting_condition_invalidated",
            ...(guarded.details ?? {}),
          },
        };
      }
      return {
        content: [{ type: "text", text: "Turn suspended." }],
        details: {
          suspendTurn: true,
          reason,
          ...(params.noteToSelf ? { noteToSelf: params.noteToSelf } : {}),
        },
      };
    },
  };
}
