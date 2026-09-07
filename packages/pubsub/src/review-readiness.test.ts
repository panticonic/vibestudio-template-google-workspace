import { describe, expect, it, vi } from "vitest";
import { encodeEventWatchRecord } from "@vibestudio/shared/events";
import { waitForApprovalResolution } from "./review-readiness.js";

function createApprovalEventsRpc(initialApprovalIds: string[]) {
  const encoder = (record: Parameters<typeof encodeEventWatchRecord>[0]) =>
    encodeEventWatchRecord(record);
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let sequence = 0;
  const stream = vi.fn(
    async (_target: string, _method: string, args: unknown[], options?: { signal?: AbortSignal }) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(next) {
            controller = next;
            next.enqueue(
              encoder({
                kind: "watching",
                events: args[0] as ["shell-approval:pending-changed"],
                epoch: "test-epoch",
              })
            );
            next.enqueue(
              encoder({
                kind: "snapshot",
                event: "shell-approval:pending-changed",
                payload: {
                  pending: initialApprovalIds.map((approvalId) => ({ approvalId })),
                },
                sequence,
              })
            );
            options?.signal?.addEventListener("abort", () => next.close(), { once: true });
          },
        })
      )
  );

  return {
    rpc: { stream },
    stream,
    update(approvalIds: string[]) {
      sequence += 1;
      controller?.enqueue(
        encoder({
          kind: "event",
          event: "shell-approval:pending-changed",
          payload: { pending: approvalIds.map((approvalId) => ({ approvalId })) },
          sequence,
        })
      );
    },
  };
}

describe("review readiness", () => {
  it("shares one authoritative watch while resolving only the changed approval", async () => {
    const { rpc, stream, update } = createApprovalEventsRpc(["review-a", "review-b"]);
    let firstResolved = false;
    let secondResolved = false;
    const first = waitForApprovalResolution(rpc, "review-a").then(() => {
      firstResolved = true;
    });
    const second = waitForApprovalResolution(rpc, "review-b").then(() => {
      secondResolved = true;
    });

    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
    update(["review-b"]);
    await first;

    expect(firstResolved).toBe(true);
    expect(secondResolved).toBe(false);
    update([]);
    await second;
    expect(secondResolved).toBe(true);
  });

  it("cancels a waiter without waiting for another approval event", async () => {
    const { rpc } = createApprovalEventsRpc(["review-a"]);
    const controller = new AbortController();
    const waiting = waitForApprovalResolution(rpc, "review-a", controller.signal);

    controller.abort();

    await expect(waiting).rejects.toThrow("Channel service resolution was aborted");
  });
});
