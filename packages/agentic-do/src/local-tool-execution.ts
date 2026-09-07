import type { AgentTool, AgentToolResult } from "@workspace/pi-core";

/**
 * Execute an in-process tool under the lifetime of its parent agent turn.
 *
 * The runtime does not invent a wall-clock deadline: legitimate tool work may
 * take an arbitrary amount of time, and reporting a timeout cannot cancel a
 * downstream operation that ignores its signal. The owner may still cancel the
 * turn explicitly through the parent signal, while individual tools and
 * protocols remain free to implement deadlines that are part of their own
 * semantics.
 */
export async function executeLocalTool(
  tool: AgentTool,
  input: {
    invocationId: string;
    params: unknown;
    parentSignal: AbortSignal;
    onProgress?: (chunk: unknown) => void;
  }
): Promise<AgentToolResult<unknown>> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(input.parentSignal.reason);
  if (input.parentSignal.aborted) onParentAbort();
  else input.parentSignal.addEventListener("abort", onParentAbort, { once: true });

  try {
    return (await tool.execute(
      input.invocationId,
      input.params as never,
      controller.signal,
      (update) => input.onProgress?.(update)
    )) as AgentToolResult<unknown>;
  } finally {
    input.parentSignal.removeEventListener("abort", onParentAbort);
  }
}
