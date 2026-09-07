import { describe, expect, it } from "vitest";
import { VscodeLineDataEventAddon } from "./vscodeLineDataEventAddon.js";

describe("VscodeLineDataEventAddon", () => {
  it("emits completed unwrapped line data on line feed", async () => {
    const terminal = fakeTerminal([
      line("first", false),
      line("second", false),
    ]);
    const addon = new VscodeLineDataEventAddon();
    const lines: string[] = [];
    addon.onLineData((value) => lines.push(value));

    await addon.activate(terminal as never);
    terminal.buffer.active.cursorY = 1;
    terminal.fireLineFeed();

    expect(lines).toEqual(["first"]);
  });

  it("joins wrapped buffer lines before emitting", async () => {
    const terminal = fakeTerminal([
      line("wrap-", false),
      line("continued", true),
      line("", false),
    ]);
    const addon = new VscodeLineDataEventAddon();
    const lines: string[] = [];
    addon.onLineData((value) => lines.push(value));

    await addon.activate(terminal as never);
    terminal.buffer.active.cursorY = 2;
    terminal.fireLineFeed();

    expect(lines).toEqual(["wrap-continued"]);
  });

  it("flushes the current line on dispose", async () => {
    const terminal = fakeTerminal([line("active", false)]);
    const addon = new VscodeLineDataEventAddon();
    const lines: string[] = [];
    addon.onLineData((value) => lines.push(value));

    await addon.activate(terminal as never);
    addon.dispose();

    expect(lines).toEqual(["active"]);
  });
});

function fakeTerminal(lines: ReturnType<typeof line>[]) {
  let lineFeed: (() => void) | undefined;
  return {
    buffer: {
      active: {
        baseY: 0,
        cursorY: 0,
        getLine(index: number) {
          return lines[index];
        },
      },
    },
    parser: {
      registerCsiHandler() {
        return { dispose() {} };
      },
    },
    onLineFeed(cb: () => void) {
      lineFeed = cb;
      return { dispose: () => { lineFeed = undefined; } };
    },
    fireLineFeed() {
      lineFeed?.();
    },
  };
}

function line(text: string, isWrapped: boolean) {
  return {
    isWrapped,
    translateToString: () => text,
  };
}
