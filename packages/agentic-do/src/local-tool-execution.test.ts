import { describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@workspace/pi-core";
import { executeLocalTool } from "./local-tool-execution.js";

function tool(execute: AgentTool["execute"]): AgentTool {
  return {
    name: "probe",
    label: "probe",
    description: "probe",
    parameters: { type: "object" } as never,
    execute,
  };
}

describe("executeLocalTool", () => {
  it("does not invent a wall-clock deadline", async () => {
    vi.useFakeTimers();
    try {
      let settle!: (value: ReturnType<AgentTool["execute"]> extends Promise<infer T> ? T : never) => void;
      const execution = executeLocalTool(
        tool(async () => {
          return await new Promise((resolve) => {
            settle = resolve;
          });
        }),
        {
          invocationId: "call-1",
          params: {},
          parentSignal: new AbortController().signal,
        }
      );
      const observed = vi.fn();
      void execution.then(observed);

      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(observed).not.toHaveBeenCalled();

      settle({ content: [{ type: "text", text: "ok" }], details: null });
      await expect(execution).resolves.toMatchObject({ details: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards progress", async () => {
    const onProgress = vi.fn();
    await expect(
      executeLocalTool(
        tool(async (_id, _params, _signal, update) => {
          update?.({ content: [], details: { phase: "done" } });
          return { content: [{ type: "text", text: "ok" }], details: null };
        }),
        {
          invocationId: "call-2",
          params: {},
          parentSignal: new AbortController().signal,
          onProgress,
        }
      )
    ).resolves.toMatchObject({ details: null });
    expect(onProgress).toHaveBeenCalledOnce();
  });

  it("forwards explicit parent cancellation to the tool", async () => {
    const parent = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const execution = executeLocalTool(
      tool(async (_id, _params, signal) => {
        observedSignal = signal;
        return await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
      {
        invocationId: "call-3",
        params: {},
        parentSignal: parent.signal,
      }
    );

    const reason = new Error("turn cancelled");
    parent.abort(reason);
    await expect(execution).rejects.toBe(reason);
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe(reason);
  });
});
