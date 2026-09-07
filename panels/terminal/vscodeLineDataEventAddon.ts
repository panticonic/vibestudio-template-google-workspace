/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IBuffer, IDisposable, ITerminalAddon, Terminal } from "@xterm/xterm";

type OperatingSystem = "linux" | "mac" | "windows";

/**
 * Port of VS Code's `LineDataEventAddon`, adapted away from VS Code's Disposable/Emitter
 * infrastructure. It emits a fully unwrapped line when xterm advances to the next line and
 * flushes the current line on dispose.
 */
export class VscodeLineDataEventAddon implements ITerminalAddon {
  private terminal: Terminal | undefined;
  private disposables: IDisposable[] = [];
  private listeners = new Set<(line: string) => void>();
  private isOsSet = false;
  private disposed = false;

  constructor(private readonly initializationPromise?: Promise<void>) {}

  async activate(terminal: Terminal): Promise<void> {
    this.terminal = terminal;
    const buffer = terminal.buffer;

    await this.initializationPromise;
    if (this.disposed) return;

    this.disposables.push(
      terminal.onLineFeed(() => {
        const active = buffer.active;
        const newLine = active.getLine(active.baseY + active.cursorY);
        if (newLine && !newLine.isWrapped) {
          this.sendLineData(active, active.baseY + active.cursorY - 1);
        }
      }),
      {
        dispose: () => {
          const active = buffer.active;
          this.sendLineData(active, active.baseY + active.cursorY);
        },
      }
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const disposable of this.disposables) safeDispose(disposable);
    this.disposables = [];
    this.listeners.clear();
    this.terminal = undefined;
  }

  onLineData(listener: (line: string) => void): IDisposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  setOperatingSystem(os: OperatingSystem): void {
    if (this.isOsSet || !this.terminal) return;
    this.isOsSet = true;
    if (os !== "windows") return;

    const terminal = this.terminal;
    this.disposables.push(
      terminal.parser.registerCsiHandler({ final: "H" }, () => {
        const buffer = terminal.buffer.active;
        this.sendLineData(buffer, buffer.baseY + buffer.cursorY);
        return false;
      })
    );
  }

  private sendLineData(buffer: IBuffer, lineIndex: number): void {
    let line = buffer.getLine(lineIndex);
    if (!line) return;
    let lineData = line.translateToString(true);
    while (lineIndex > 0 && line.isWrapped) {
      line = buffer.getLine(--lineIndex);
      if (!line) break;
      lineData = line.translateToString(false) + lineData;
    }
    for (const listener of this.listeners) listener(lineData);
  }
}

function safeDispose(disposable: IDisposable | null | undefined): void {
  try {
    disposable?.dispose();
  } catch (err) {
    console.warn("Terminal cleanup failed", err);
  }
}
