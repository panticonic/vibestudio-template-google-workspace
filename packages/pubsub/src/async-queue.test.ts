import { describe, expect, it } from "vitest";
import { AsyncQueue } from "./async-queue.js";

describe("AsyncQueue", () => {
  it("preserves a large buffered burst in FIFO order", async () => {
    const queue = new AsyncQueue<number>();
    const count = 20_000;
    for (let i = 0; i < count; i++) queue.push(i);
    queue.close();

    const received: number[] = [];
    for await (const value of queue) received.push(value);

    expect(received).toHaveLength(count);
    expect(received[0]).toBe(0);
    expect(received[10_000]).toBe(10_000);
    expect(received[count - 1]).toBe(count - 1);
    expect(queue.length).toBe(0);
  });

  it("settles concurrently waiting consumers in FIFO order", async () => {
    const queue = new AsyncQueue<string>();
    const first = queue[Symbol.asyncIterator]().next();
    const second = queue[Symbol.asyncIterator]().next();

    queue.push("first");
    queue.push("second");

    await expect(first).resolves.toEqual({ value: "first", done: false });
    await expect(second).resolves.toEqual({ value: "second", done: false });
  });

  it("releases all waiting consumers when closed", async () => {
    const queue = new AsyncQueue<string>();
    const first = queue[Symbol.asyncIterator]().next();
    const second = queue[Symbol.asyncIterator]().next();

    queue.close();

    await expect(first).resolves.toEqual({ value: undefined, done: true });
    await expect(second).resolves.toEqual({ value: undefined, done: true });
  });
});
