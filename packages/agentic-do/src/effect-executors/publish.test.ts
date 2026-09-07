import { describe, expect, it, vi } from "vitest";
import { receiptExecutor } from "./index.js";
import type { ExecutorDeps } from "./types.js";
import type { RecordReceiptEffect } from "@workspace/agent-loop";

describe("receiptExecutor", () => {
  it("updates the read projection without publishing an envelope", async () => {
    const recordReadReceipt = vi.fn(async () => {});
    const deps = { channel: { recordReadReceipt } } as unknown as ExecutorDeps;
    const descriptor: RecordReceiptEffect = {
      effectId: "read:src-1:turn-1",
      kind: "record_receipt",
      channelId: "chan-1",
      idempotencyKey: "read:src-1:turn-1",
      messageId: "src-1",
      turnId: "turn-1",
    };

    await receiptExecutor.execute({
      descriptor,
      state: {} as never,
      signal: new AbortController().signal,
      deps,
      onEphemeral: () => {},
    });

    expect(recordReadReceipt).toHaveBeenCalledWith({
      channelId: "chan-1",
      messageId: "src-1",
      turnId: "turn-1",
    });
  });
});
