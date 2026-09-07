import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedNotification } from "./notificationParser.js";
import { VscodeTerminalInstance } from "./vscodeTerminalInstance.js";
import type { TerminalFrontend, TerminalFrontendFactory } from "./terminalFrontend.js";
import type { ShellApi } from "./types.js";
import type { VscodeShellIntegrationEvent } from "./vscodeShellIntegration.js";

describe("VscodeTerminalInstance", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      disconnect = vi.fn();
    });
  });

  it("routes frontend input to the owning shell session", async () => {
    const frontend = createFakeFrontend();
    const shell = createShell();
    const instance = createInstance({ frontend, shell, sessionId: "session-a" });

    await instance.attach(hostElement());
    frontend.emitInput("echo hello\r");

    expect(shell.write).toHaveBeenCalledWith("session-a", "echo hello\r");
  });

  it("writes attached output to the frontend and parses notifications", async () => {
    vi.useFakeTimers();
    const frontend = createFakeFrontend();
    const shell = createShell();
    const onNotification = vi.fn();
    setScrollback(shell, "ready\x1b]9;[done] complete\x07\n");
    const instance = createInstance({ frontend, shell, onNotification });

    await instance.attach(hostElement());
    await vi.advanceTimersByTimeAsync(8);

    expect(textFromWrites(frontend.writes)).toContain("ready");
    expect(frontend.refresh).toHaveBeenCalled();
    expect(onNotification).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "done", message: "complete" })
    );
  });

  it("refreshes after parsed output", async () => {
    vi.useFakeTimers();
    const frontend = createFakeFrontend();
    const shell = createShell();
    setScrollback(shell, "ready");
    const instance = createInstance({ frontend, shell });

    await instance.attach(hostElement());
    await vi.advanceTimersByTimeAsync(8);

    expect(frontend.refresh).toHaveBeenCalledTimes(1);
    expect(frontend.fit).not.toHaveBeenCalled();
  });

  it("acknowledges parsed output back to the shell for flow control", async () => {
    vi.useFakeTimers();
    const frontend = createFakeFrontend();
    const shell = createShell();
    setScrollback(shell, "x".repeat(5001));
    const instance = createInstance({ frontend, shell });

    await instance.attach(hostElement());
    await vi.advanceTimersByTimeAsync(8);

    expect(shell.acknowledgeDataEvent).toHaveBeenCalledWith("session-1", 5000);
  });

  it("keeps focus, fit, theme, find, and selection behind the frontend boundary", async () => {
    const frontend = createFakeFrontend();
    const shell = createShell();
    const instance = createInstance({ frontend, shell, focused: true });

    await instance.attach(hostElement());
    instance.fit();
    instance.focus();
    instance.setTheme(theme("next"));
    instance.findNext("abc", { caseSensitive: true });
    instance.selectAll();

    expect(frontend.focus).toHaveBeenCalledTimes(2);
    expect(frontend.fit).toHaveBeenCalledTimes(2);
    expect(frontend.refresh).toHaveBeenCalledTimes(1);
    expect(frontend.setTheme).toHaveBeenCalledWith(theme("next"));
    expect(frontend.findNext).toHaveBeenCalledWith("abc", { caseSensitive: true });
    expect(frontend.selectAll).toHaveBeenCalledTimes(1);
  });

  it("contains frontend dispose failures during unmount", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const frontend = createFakeFrontend();
    frontend.dispose.mockImplementation(() => {
      throw new Error("dispose failed");
    });
    const shell = createShell();
    const instance = createInstance({ frontend, shell });

    await instance.attach(hostElement());

    expect(() => instance.dispose()).not.toThrow();
    expect(warn).toHaveBeenCalledWith("Terminal cleanup failed", expect.any(Error));
    warn.mockRestore();
  });

  it("forwards frontend shell integration events through the instance boundary", async () => {
    const frontend = createFakeFrontend();
    const shell = createShell();
    const onShellIntegrationEvent = vi.fn();
    const instance = createInstance({ frontend, shell, onShellIntegrationEvent });

    await instance.attach(hostElement());
    frontend.emitShellIntegrationEvent({ type: "cwd", source: "vscode", cwd: "/repo" });

    expect(onShellIntegrationEvent).toHaveBeenCalledWith({
      type: "cwd",
      source: "vscode",
      cwd: "/repo",
    });
  });

  it("forwards frontend line data through the instance boundary", async () => {
    const frontend = createFakeFrontend();
    const shell = createShell();
    const onLineData = vi.fn();
    const instance = createInstance({ frontend, shell, onLineData });

    await instance.attach(hostElement());
    frontend.emitLineData("build complete");

    expect(onLineData).toHaveBeenCalledWith("build complete");
  });

  it("forwards frontend title changes through the instance boundary", async () => {
    const frontend = createFakeFrontend();
    const shell = createShell();
    const onTitleChange = vi.fn();
    const instance = createInstance({ frontend, shell, onTitleChange });

    await instance.attach(hostElement());
    frontend.emitTitleChange("vim package.json");

    expect(onTitleChange).toHaveBeenCalledWith("vim package.json");
  });
});

function createInstance(opts: {
  frontend: FakeFrontend;
  shell: ShellApi;
  sessionId?: string;
  focused?: boolean;
  onNotification?: (notification: ParsedNotification) => void;
  onShellIntegrationEvent?: (event: VscodeShellIntegrationEvent) => void;
  onLineData?: (line: string) => void;
  onTitleChange?: (title: string) => void;
}): VscodeTerminalInstance {
  const frontendFactory: TerminalFrontendFactory = vi.fn(async () => opts.frontend);
  return new VscodeTerminalInstance({
    sessionId: opts.sessionId ?? "session-1",
    shell: opts.shell,
    frontendFactory,
    fontFamily: "monospace",
    fontSize: 13,
    theme: theme("base"),
    focused: opts.focused ?? false,
    onError: vi.fn(),
    onNotification: opts.onNotification ?? vi.fn(),
    onShellIntegrationEvent: opts.onShellIntegrationEvent,
    onLineData: opts.onLineData,
    onTitleChange: opts.onTitleChange,
  });
}

function hostElement(): HTMLElement {
  return {} as HTMLElement;
}

function responseFromChunks(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    })
  );
}

function createShell(): ShellApi {
  return {
    exec: vi.fn(),
    open: vi.fn(),
    write: vi.fn(async () => {}),
    acknowledgeDataEvent: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    kill: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    getSessionInfo: vi.fn(async () => ({ alive: true })),
    watchSessionInfo: vi.fn(),
    attach: vi.fn(async () => responseFromChunks([])),
    awaitExit: vi.fn(),
    getScrollback: vi.fn(async () => ({ text: "", cursor: "0" })),
  } as unknown as ShellApi;
}

function setScrollback(shell: ShellApi, text: string): void {
  vi.mocked(shell.getScrollback).mockResolvedValue({
    text,
    cursor: String(new TextEncoder().encode(text).byteLength),
  });
}

type FakeFrontend = TerminalFrontend & {
  writes: Uint8Array[];
  emitInput(data: string): void;
  emitResize(size: { cols: number; rows: number }): void;
  emitShellIntegrationEvent(event: VscodeShellIntegrationEvent): void;
  emitLineData(line: string): void;
  emitTitleChange(title: string): void;
  focus: ReturnType<typeof vi.fn>;
  fit: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  setTheme: ReturnType<typeof vi.fn>;
  findNext: ReturnType<typeof vi.fn>;
  selectAll: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

function createFakeFrontend(): FakeFrontend {
  let input: ((data: string) => void) | undefined;
  let resize: ((size: { cols: number; rows: number }) => void) | undefined;
  let shellIntegrationEvent: ((event: VscodeShellIntegrationEvent) => void) | undefined;
  let lineData: ((line: string) => void) | undefined;
  let titleChange: ((title: string) => void) | undefined;
  const writes: Uint8Array[] = [];
  return {
    writes,
    open: vi.fn(),
    write: vi.fn((data: string | Uint8Array, callback?: () => void) => {
      writes.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
      callback?.();
    }),
    onInput: vi.fn((cb) => {
      input = cb;
      return { dispose: vi.fn() };
    }),
    onResize: vi.fn((cb) => {
      resize = cb;
      return { dispose: vi.fn() };
    }),
    onScroll: vi.fn(() => ({ dispose: vi.fn() })),
    onShellIntegrationEvent: vi.fn((cb) => {
      shellIntegrationEvent = cb;
      return { dispose: vi.fn() };
    }),
    onLineData: vi.fn((cb) => {
      lineData = cb;
      return { dispose: vi.fn() };
    }),
    onTitleChange: vi.fn((cb) => {
      titleChange = cb;
      return { dispose: vi.fn() };
    }),
    fit: vi.fn(),
    refresh: vi.fn(),
    focus: vi.fn(),
    setTheme: vi.fn(),
    getSelection: vi.fn(() => "selection"),
    selectAll: vi.fn(),
    scrollToBottom: vi.fn(),
    isScrolledUp: vi.fn(() => false),
    getBufferLength: vi.fn(() => 0),
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearSearch: vi.fn(),
    serialize: vi.fn(() => textFromWrites(writes)),
    dispose: vi.fn(),
    emitInput(data: string) {
      input?.(data);
    },
    emitResize(size: { cols: number; rows: number }) {
      resize?.(size);
    },
    emitShellIntegrationEvent(event: VscodeShellIntegrationEvent) {
      shellIntegrationEvent?.(event);
    },
    emitLineData(line: string) {
      lineData?.(line);
    },
    emitTitleChange(title: string) {
      titleChange?.(title);
    },
  };
}

function textFromWrites(writes: Uint8Array[]): string {
  return writes.map((chunk) => new TextDecoder().decode(chunk)).join("");
}

function theme(seed: string) {
  return {
    background: seed,
    foreground: seed,
    cursor: seed,
    selectionBackground: seed,
    black: seed,
    red: seed,
    green: seed,
    yellow: seed,
    blue: seed,
    magenta: seed,
    cyan: seed,
    white: seed,
    brightBlack: seed,
    brightRed: seed,
    brightGreen: seed,
    brightYellow: seed,
    brightBlue: seed,
    brightMagenta: seed,
    brightCyan: seed,
    brightWhite: seed,
  };
}
