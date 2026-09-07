import { describe, expect, it, vi } from "vitest";
import { createSuspendTurnTool } from "../suspend-turn.js";

describe("suspend_turn", () => {
  it("suspends when its runtime-owned waiting condition remains true", async () => {
    const guard = vi.fn(() => ({ suspend: true }));
    const result = await createSuspendTurnTool({ guard }).execute("call-1", {
      reason: "waiting_for_background",
    });

    expect(guard).toHaveBeenCalledWith({ reason: "waiting_for_background" });
    expect(result.details).toEqual({
      suspendTurn: true,
      reason: "waiting_for_background",
    });
  });

  it("returns foreground lifecycle work instead of accepting a stale wait", async () => {
    const result = await createSuspendTurnTool({
      guard: () => ({
        suspend: false,
        reason: "no_live_supervised_runs",
        message: "Integrate the completed run.",
        details: { completedRunsAwaitingIntegration: ["call_completed…"] },
      }),
    }).execute("call-1", { reason: "waiting_for_background" });

    expect(result.content).toEqual([{ type: "text", text: "Integrate the completed run." }]);
    expect(result.details).toEqual({
      suspendTurn: false,
      reason: "no_live_supervised_runs",
      completedRunsAwaitingIntegration: ["call_completed…"],
    });
  });
});
