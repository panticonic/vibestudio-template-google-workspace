import { describe, expect, it, vi } from "vitest";
import { VscodeTerminalWriteScheduler, type VscodeTerminalWriteTarget } from "./vscodeTerminalWriteScheduler.js";

describe("VscodeTerminalWriteScheduler", () => {
  it("acknowledges data after the xterm write callback", () => {
    let writeCallback: (() => void) | undefined;
    const acknowledge = vi.fn();
    const target: VscodeTerminalWriteTarget = {
      write: vi.fn((_data, callback) => {
        writeCallback = callback;
      }),
    };
    const scheduler = new VscodeTerminalWriteScheduler({
      target: () => target,
      acknowledge,
    });

    scheduler.writeProcessData("hello");

    expect(acknowledge).not.toHaveBeenCalled();
    writeCallback?.();
    expect(acknowledge).toHaveBeenCalledWith(5);
  });

  it("splits shell integration command boundary sequences into separate writes", () => {
    const writes: string[] = [];
    const scheduler = new VscodeTerminalWriteScheduler({
      target: () => ({
        write(data, callback) {
          writes.push(String(data));
          callback?.();
        },
      }),
      acknowledge: vi.fn(),
    });

    scheduler.writeProcessData("before\x1b]633;C\x07after\x1b]633;D;0\x07tail");

    expect(writes).toEqual(["before", "\x1b]633;C\x07", "after", "\x1b]633;D;0\x07", "tail"]);
  });

  it("resolves tracked commits after the final write segment parses", async () => {
    let finalCallback: (() => void) | undefined;
    const scheduler = new VscodeTerminalWriteScheduler({
      target: () => ({
        write(data, callback) {
          if (String(data) === "tail") finalCallback = callback;
          else callback?.();
        },
      }),
      acknowledge: vi.fn(),
    });

    const promise = scheduler.writeProcessData("lead\x1b]633;C\x07tail", true);
    let resolved = false;
    void promise?.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    finalCallback?.();
    await Promise.resolve();
    expect(resolved).toBe(true);
  });
});

