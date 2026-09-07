import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleBackgroundStages } from "./scheduleBackgroundWork";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("scheduleBackgroundStages", () => {
  it("waits for each stage and gives the next stage a separate task", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.stubGlobal("cancelIdleCallback", undefined);
    const order: string[] = [];
    let finishFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });

    scheduleBackgroundStages([
      async () => {
        order.push("first");
        await firstFinished;
      },
      () => {
        order.push("second");
      },
    ]);

    await vi.runOnlyPendingTimersAsync();
    expect(order).toEqual(["first"]);
    finishFirst();
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();
    expect(order).toEqual(["first", "second"]);
  });

  it("cancels a stage that has not started", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.stubGlobal("cancelIdleCallback", undefined);
    const stage = vi.fn();

    const cancel = scheduleBackgroundStages([stage]);
    cancel();
    await vi.runAllTimersAsync();

    expect(stage).not.toHaveBeenCalled();
  });
});
