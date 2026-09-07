/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const enum Constants {
  /**
   * The _normal_ buffer length threshold at which point resizing starts being debounced.
   */
  StartDebouncingThreshold = 200,
}

/**
 * Port of VS Code's `TerminalResizeDebouncer`, adapted away from VS Code's Disposable and
 * decorator infrastructure.
 */
export class VscodeTerminalResizeDebouncer {
  private latestX = 0;
  private latestY = 0;
  private resizeXTimer: ReturnType<typeof setTimeout> | undefined;
  private resizeYIdle: number | undefined;
  private disposed = false;

  constructor(
    private readonly isVisible: () => boolean,
    private readonly getBufferLength: () => number,
    private readonly resizeBothCallback: (cols: number, rows: number) => void,
    private readonly resizeXCallback: (cols: number) => void,
    private readonly resizeYCallback: (rows: number) => void
  ) {}

  resize(cols: number, rows: number, immediate: boolean): void {
    if (this.disposed) return;
    this.latestX = cols;
    this.latestY = rows;

    if (immediate || this.getBufferLength() < Constants.StartDebouncingThreshold) {
      this.clearJobs();
      this.resizeBothCallback(cols, rows);
      return;
    }

    if (!this.isVisible()) {
      this.resizeYIdle ??= requestIdleCallbackSafe(() => {
        if (this.disposed) return;
        this.resizeBothCallback(this.latestX, this.latestY);
        this.resizeYIdle = undefined;
      });
      return;
    }

    this.resizeYCallback(rows);
    this.debounceResizeX(cols);
  }

  flush(): void {
    if (this.disposed) return;
    if (this.resizeXTimer || this.resizeYIdle) {
      this.clearJobs();
      this.resizeBothCallback(this.latestX, this.latestY);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearJobs();
  }

  private debounceResizeX(cols: number): void {
    if (this.resizeXTimer) clearTimeout(this.resizeXTimer);
    this.resizeXTimer = setTimeout(() => {
      this.resizeXTimer = undefined;
      if (!this.disposed) this.resizeXCallback(cols);
    }, 100);
  }

  private clearJobs(): void {
    if (this.resizeXTimer) clearTimeout(this.resizeXTimer);
    this.resizeXTimer = undefined;
    if (this.resizeYIdle !== undefined) cancelIdleCallbackSafe(this.resizeYIdle);
    this.resizeYIdle = undefined;
  }
}

function requestIdleCallbackSafe(callback: () => void): number {
  const idle = globalThis.requestIdleCallback;
  if (idle) return idle(callback) as unknown as number;
  return setTimeout(callback, 100) as unknown as number;
}

function cancelIdleCallbackSafe(handle: number): void {
  const cancel = globalThis.cancelIdleCallback;
  if (cancel) {
    cancel(handle as unknown as number);
    return;
  }
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

