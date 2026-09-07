import { describe, expect, it, vi } from "vitest";
import { VscodeShellIntegrationAddon } from "./vscodeShellIntegration.js";

describe("VscodeShellIntegrationAddon", () => {
  it("parses VS Code shell integration command lifecycle sequences", () => {
    const terminal = fakeTerminal();
    const addon = new VscodeShellIntegrationAddon();
    const events: unknown[] = [];
    addon.onEvent((event) => events.push(event));

    addon.activate(terminal as never);
    terminal.fireOsc(633, "A");
    terminal.fireOsc(633, "E;echo%20hello");
    terminal.fireOsc(633, "C");
    terminal.fireOsc(633, "D;0");

    expect(events).toEqual([
      { type: "prompt-start", source: "vscode" },
      { type: "command-line", source: "vscode", commandLine: "echo hello" },
      { type: "command-executed", source: "vscode" },
      { type: "command-finished", source: "vscode", exitCode: 0 },
    ]);
  });

  it("parses cwd sequences from VS Code and iTerm protocols", () => {
    const terminal = fakeTerminal();
    const addon = new VscodeShellIntegrationAddon();
    const events: unknown[] = [];
    addon.onEvent((event) => events.push(event));

    addon.activate(terminal as never);
    terminal.fireOsc(633, "P;Cwd=/repo");
    terminal.fireOsc(633, "7;/repo/from-set-cwd");
    terminal.fireOsc(1337, "CurrentDir=file://host/tmp/project");

    expect(events).toEqual([
      { type: "cwd", source: "vscode", cwd: "/repo" },
      { type: "cwd", source: "vscode", cwd: "/repo/from-set-cwd" },
      { type: "cwd", source: "iterm", cwd: "/tmp/project" },
    ]);
  });

  it("parses VS Code property and continuation sequences", () => {
    const terminal = fakeTerminal();
    const addon = new VscodeShellIntegrationAddon();
    const events: unknown[] = [];
    addon.onEvent((event) => events.push(event));

    addon.activate(terminal as never);
    terminal.fireOsc(633, "P;PromptType=starship");
    terminal.fireOsc(633, "F");
    terminal.fireOsc(633, "G");

    expect(events).toEqual([
      { type: "property", source: "vscode", key: "PromptType", value: "starship" },
      { type: "continuation-start", source: "vscode" },
      { type: "continuation-end", source: "vscode" },
    ]);
  });

  it("parses VS Code shell environment reporting sequences", () => {
    const terminal = fakeTerminal();
    const addon = new VscodeShellIntegrationAddon();
    const events: unknown[] = [];
    addon.onEvent((event) => events.push(event));

    addon.activate(terminal as never);
    terminal.fireOsc(633, "EnvJson;%7B%22PATH%22%3A%22%2Fbin%22%7D;nonce");
    terminal.fireOsc(633, "EnvSingleStart;1;nonce");
    terminal.fireOsc(633, "EnvSingleEntry;NODE_ENV;development;nonce");
    terminal.fireOsc(633, "EnvSingleDelete;NODE_ENV;development;nonce");
    terminal.fireOsc(633, "EnvSingleEnd;nonce");

    expect(events).toEqual([
      { type: "env-json", source: "vscode", env: { PATH: "/bin" } },
      { type: "env-single-start", source: "vscode", clear: true },
      { type: "env-single-entry", source: "vscode", key: "NODE_ENV", value: "development" },
      { type: "env-single-delete", source: "vscode", key: "NODE_ENV" },
      { type: "env-single-end", source: "vscode" },
    ]);
  });

  it("disposes parser registrations and listeners", () => {
    const terminal = fakeTerminal();
    const addon = new VscodeShellIntegrationAddon();
    const listener = vi.fn();
    addon.onEvent(listener);

    addon.activate(terminal as never);
    addon.dispose();
    terminal.fireOsc(633, "A");

    expect(listener).not.toHaveBeenCalled();
    expect(terminal.disposedHandlers).toBeGreaterThan(0);
  });
});

function fakeTerminal() {
  const handlers = new Map<number, (data: string) => boolean>();
  const terminal = {
    disposedHandlers: 0,
    parser: {
      registerOscHandler(ps: number, handler: (data: string) => boolean) {
        handlers.set(ps, handler);
        return {
          dispose: () => {
            handlers.delete(ps);
            terminal.disposedHandlers += 1;
          },
        };
      },
    },
    fireOsc(ps: number, data: string) {
      return handlers.get(ps)?.(data);
    },
  };
  return terminal;
}
