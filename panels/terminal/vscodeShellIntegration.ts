/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable, ITerminalAddon, Terminal } from "@xterm/xterm";

/**
 * Ported subset of VS Code's shell integration addon. The full upstream addon wires these
 * sequences into VS Code's terminal capability graph; this runtime port keeps the protocol parser
 * live while exposing small, system-local events for CWD and command lifecycle.
 */
export class VscodeShellIntegrationAddon implements ITerminalAddon {
  private disposables: IDisposable[] = [];
  private readonly listeners = new Set<(event: VscodeShellIntegrationEvent) => void>();
  readonly seenSequences = new Set<string>();
  status: VscodeShellIntegrationStatus = VscodeShellIntegrationStatus.Off;

  activate(terminal: Terminal): void {
    this.disposables.push(
      terminal.parser.registerOscHandler(ShellIntegrationOscPs.VSCode, (data) =>
        this.handleVSCodeSequence(data)
      ),
      terminal.parser.registerOscHandler(ShellIntegrationOscPs.ITerm, (data) =>
        this.handleITermSequence(data)
      ),
      terminal.parser.registerOscHandler(ShellIntegrationOscPs.FinalTerm, (data) =>
        this.handleFinalTermSequence(data)
      ),
      terminal.parser.registerOscHandler(ShellIntegrationOscPs.SetCwd, (data) =>
        this.handleCwd(data)
      ),
      terminal.parser.registerOscHandler(ShellIntegrationOscPs.SetWindowsFriendlyCwd, (data) =>
        this.handleCwd(data)
      )
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) safeDispose(disposable);
    this.disposables = [];
    this.listeners.clear();
  }

  onEvent(listener: (event: VscodeShellIntegrationEvent) => void): IDisposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private handleVSCodeSequence(data: string): boolean {
    this.status = VscodeShellIntegrationStatus.VSCode;
    this.seenSequences.add(`${ShellIntegrationOscPs.VSCode};${data.charAt(0)}`);
    const [command, ...args] = data.split(";");
    switch (command) {
      case VSCodeOscPt.PromptStart:
        this.fire("vscode", { type: "prompt-start" });
        return true;
      case VSCodeOscPt.CommandStart:
        this.fire("vscode", { type: "command-start" });
        return true;
      case VSCodeOscPt.CommandExecuted:
        this.fire("vscode", { type: "command-executed" });
        return true;
      case VSCodeOscPt.CommandFinished:
        this.fire("vscode", { type: "command-finished", exitCode: parseExitCode(args[0]) });
        return true;
      case VSCodeOscPt.CommandLine:
        this.fire("vscode", {
          type: "command-line",
          commandLine: decodeURIComponentSafe(args.join(";")),
        });
        return true;
      case VSCodeOscPt.SetCwd:
        return this.handleCwd(args.join(";"), "vscode");
      case VSCodeOscPt.SetProperty:
        return this.handleVSCodeProperty(args.join(";"));
      case VSCodeOscPt.ContinuationStart:
        this.fire("vscode", { type: "continuation-start" });
        return true;
      case VSCodeOscPt.ContinuationEnd:
        this.fire("vscode", { type: "continuation-end" });
        return true;
      case VSCodeOscPt.EnvJson:
        return this.handleEnvJson(args);
      case VSCodeOscPt.EnvSingleStart:
        this.fire("vscode", { type: "env-single-start", clear: args[0] === "1" });
        return true;
      case VSCodeOscPt.EnvSingleEntry:
        return this.handleEnvSingleEntry(args);
      case VSCodeOscPt.EnvSingleDelete:
        return this.handleEnvSingleDelete(args);
      case VSCodeOscPt.EnvSingleEnd:
        this.fire("vscode", { type: "env-single-end" });
        return true;
      default:
        return false;
    }
  }

  private handleFinalTermSequence(data: string): boolean {
    if (this.status !== VscodeShellIntegrationStatus.VSCode) {
      this.status = VscodeShellIntegrationStatus.FinalTerm;
    }
    this.seenSequences.add(`${ShellIntegrationOscPs.FinalTerm};${data.charAt(0)}`);
    const [command, exitCode] = data.split(";");
    switch (command) {
      case FinalTermOscPt.PromptStart:
        this.fire("finalTerm", { type: "prompt-start" });
        return true;
      case FinalTermOscPt.CommandStart:
        this.fire("finalTerm", { type: "command-start" });
        return true;
      case FinalTermOscPt.CommandExecuted:
        this.fire("finalTerm", { type: "command-executed" });
        return true;
      case FinalTermOscPt.CommandFinished:
        this.fire("finalTerm", { type: "command-finished", exitCode: parseExitCode(exitCode) });
        return true;
      default:
        return false;
    }
  }

  private handleITermSequence(data: string): boolean {
    const [key, ...value] = data.split("=");
    if (key === "CurrentDir") return this.handleCwd(value.join("="), "iterm");
    return false;
  }

  private handleCwd(data: string, source: VscodeShellIntegrationEventSource = "generic"): boolean {
    const cwd = decodeURIComponentSafe(data.replace(/^file:\/\/[^/]*(?=\/)/, ""));
    if (!cwd) return false;
    this.fire(source, { type: "cwd", cwd });
    return true;
  }

  private handleVSCodeProperty(data: string): boolean {
    const separator = data.indexOf("=");
    const key = separator === -1 ? data : data.slice(0, separator);
    const value = separator === -1 ? "" : data.slice(separator + 1);
    if (key === "Cwd") return this.handleCwd(value, "vscode");
    this.fire("vscode", { type: "property", key, value: decodeURIComponentSafe(value) });
    return true;
  }

  private handleEnvJson(args: string[]): boolean {
    const value = args[0];
    if (value === undefined) return true;
    try {
      const parsed = JSON.parse(decodeURIComponentSafe(value));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
      const env: Record<string, string> = {};
      for (const [key, entry] of Object.entries(parsed)) {
        if (typeof entry === "string") env[key] = entry;
      }
      this.fire("vscode", { type: "env-json", env });
    } catch {
      this.fire("vscode", { type: "property", key: "EnvJsonParseError", value });
    }
    return true;
  }

  private handleEnvSingleEntry(args: string[]): boolean {
    const key = args[0];
    const value = args[1];
    if (key === undefined || value === undefined) return true;
    this.fire("vscode", { type: "env-single-entry", key, value: decodeURIComponentSafe(value) });
    return true;
  }

  private handleEnvSingleDelete(args: string[]): boolean {
    const key = args[0];
    if (key === undefined) return true;
    this.fire("vscode", { type: "env-single-delete", key });
    return true;
  }

  private fire(
    source: VscodeShellIntegrationEventSource,
    event: VscodeShellIntegrationEventWithoutSource
  ): void {
    for (const listener of this.listeners) listener({ ...event, source } as VscodeShellIntegrationEvent);
  }
}

export const enum VscodeShellIntegrationStatus {
  Off,
  FinalTerm,
  VSCode,
}

export type VscodeShellIntegrationEvent =
  | { type: "prompt-start"; source: VscodeShellIntegrationEventSource }
  | { type: "command-start"; source: VscodeShellIntegrationEventSource }
  | { type: "command-executed"; source: VscodeShellIntegrationEventSource }
  | { type: "command-finished"; source: VscodeShellIntegrationEventSource; exitCode?: number }
  | { type: "command-line"; source: VscodeShellIntegrationEventSource; commandLine: string }
  | { type: "cwd"; source: VscodeShellIntegrationEventSource; cwd: string }
  | { type: "property"; source: VscodeShellIntegrationEventSource; key: string; value: string }
  | { type: "continuation-start"; source: VscodeShellIntegrationEventSource }
  | { type: "continuation-end"; source: VscodeShellIntegrationEventSource }
  | { type: "env-json"; source: VscodeShellIntegrationEventSource; env: Record<string, string> }
  | { type: "env-single-start"; source: VscodeShellIntegrationEventSource; clear: boolean }
  | { type: "env-single-entry"; source: VscodeShellIntegrationEventSource; key: string; value: string }
  | { type: "env-single-delete"; source: VscodeShellIntegrationEventSource; key: string }
  | { type: "env-single-end"; source: VscodeShellIntegrationEventSource };

export type VscodeShellIntegrationEventSource = "vscode" | "finalTerm" | "iterm" | "generic";

type VscodeShellIntegrationEventWithoutSource =
  | { type: "prompt-start" }
  | { type: "command-start" }
  | { type: "command-executed" }
  | { type: "command-finished"; exitCode?: number }
  | { type: "command-line"; commandLine: string }
  | { type: "cwd"; cwd: string }
  | { type: "property"; key: string; value: string }
  | { type: "continuation-start" }
  | { type: "continuation-end" }
  | { type: "env-json"; env: Record<string, string> }
  | { type: "env-single-start"; clear: boolean }
  | { type: "env-single-entry"; key: string; value: string }
  | { type: "env-single-delete"; key: string }
  | { type: "env-single-end" };

/**
 * The identifier for the first numeric parameter (`Ps`) for OSC commands used by shell integration.
 */
const enum ShellIntegrationOscPs {
  FinalTerm = 133,
  VSCode = 633,
  ITerm = 1337,
  SetCwd = 7,
  SetWindowsFriendlyCwd = 9,
}

const enum FinalTermOscPt {
  PromptStart = "A",
  CommandStart = "B",
  CommandExecuted = "C",
  CommandFinished = "D",
}

const enum VSCodeOscPt {
  PromptStart = "A",
  CommandStart = "B",
  CommandExecuted = "C",
  CommandFinished = "D",
  CommandLine = "E",
  ContinuationStart = "F",
  ContinuationEnd = "G",
  EnvJson = "EnvJson",
  EnvSingleDelete = "EnvSingleDelete",
  EnvSingleStart = "EnvSingleStart",
  EnvSingleEntry = "EnvSingleEntry",
  EnvSingleEnd = "EnvSingleEnd",
  SetProperty = "P",
  SetCwd = "7",
}

function parseExitCode(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeDispose(disposable: IDisposable | null | undefined): void {
  try {
    disposable?.dispose();
  } catch (err) {
    console.warn("Terminal cleanup failed", err);
  }
}
