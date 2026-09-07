import { describe, expect, it, vi } from "vitest";
import { VscodeTerminalProcessBridge } from "./vscodeTerminalProcess.js";
import type { ShellApi } from "./types.js";

describe("VscodeTerminalProcessBridge", () => {
  it("replays shell scrollback before opening the live attach stream", async () => {
    const shell = createShell({ scrollback: "ready" });
    const onData = vi.fn();
    const bridge = new VscodeTerminalProcessBridge({
      sessionId: "session-1",
      shell,
      onData,
      onError: vi.fn(),
    });

    await bridge.start();

    expect(onData).toHaveBeenCalledWith(
      expect.objectContaining({ data: "ready", trackCommit: false })
    );
    expect(shell.attach).toHaveBeenCalledWith("session-1", { after: "5" });
    bridge.dispose();
  });

  it("reopens the live attach stream when shell scrollback advances but the reader has not", async () => {
    vi.useFakeTimers();
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const attachAfter: Array<string | undefined> = [];
    let cursor = "0";
    const shell = createShell({
      getScrollback: async () => ({ text: "", cursor }),
      attach: async (_sessionId, opts) => {
        attachAfter.push(opts?.after);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controllers.push(controller);
            },
          })
        );
      },
      write: async () => {
        cursor = "5";
      },
    });
    const onData = vi.fn();
    const bridge = new VscodeTerminalProcessBridge({
      sessionId: "session-1",
      shell,
      onData,
      onError: vi.fn(),
    });

    await bridge.start();
    await bridge.write("hello");
    await vi.advanceTimersByTimeAsync(151);

    expect(attachAfter).toEqual(["0", "0"]);

    controllers[1]?.enqueue(new TextEncoder().encode("hello"));
    await vi.waitFor(() =>
      expect(onData).toHaveBeenCalledWith(expect.objectContaining({ data: "hello" }))
    );
    bridge.dispose();
    vi.useRealTimers();
  });
});

function createShell(overrides: {
  scrollback?: string;
  getScrollback?: ShellApi["getScrollback"];
  attach?: ShellApi["attach"];
  write?: ShellApi["write"];
} = {}): ShellApi {
  const scrollback = overrides.scrollback ?? "";
  return {
    exec: vi.fn(),
    open: vi.fn(),
    write: vi.fn(overrides.write ?? (async () => {})),
    acknowledgeDataEvent: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    kill: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    getSessionInfo: vi.fn(async () => ({ alive: true })),
    watchSessionInfo: vi.fn(),
    attach: vi.fn(
      overrides.attach ??
        (async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start() {},
            })
          ))
    ),
    awaitExit: vi.fn(),
    getScrollback: vi.fn(
      overrides.getScrollback ??
        (async () => ({
          text: scrollback,
          cursor: String(new TextEncoder().encode(scrollback).byteLength),
        }))
    ),
  } as unknown as ShellApi;
}
