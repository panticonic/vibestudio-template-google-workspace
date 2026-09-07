/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { NotificationStreamParser, type ParsedNotification } from "./notificationParser.js";
import type { XtermTheme } from "./paneTheme.js";
import {
  VscodeTerminalProcessBridge,
  type VscodeProcessDataEvent,
} from "./vscodeTerminalProcess.js";
import { VscodeTerminalResizeDebouncer } from "./vscodeTerminalResizeDebouncer.js";
import { VscodeTerminalWriteScheduler } from "./vscodeTerminalWriteScheduler.js";
import type {
  TerminalFindResult,
  TerminalFrontend,
  TerminalFrontendFactory,
  TerminalSearchOptions,
} from "./terminalFrontend.js";
import type { ShellApi } from "./types.js";
import type { VscodeShellIntegrationEvent } from "./vscodeShellIntegration.js";

type Disposable = { dispose(): void };

export type VscodeTerminalInstanceOptions = {
  sessionId: string;
  shell: ShellApi;
  frontendFactory: TerminalFrontendFactory;
  fontFamily: string;
  fontSize: number;
  theme: XtermTheme;
  focused: boolean;
  onError(error: string): void;
  onRecovered?(): void;
  onNotification(notification: ParsedNotification): void;
  onFindResult?(result: TerminalFindResult): void;
  onScrollStateChange?(scrolledUp: boolean): void;
  onShellIntegrationEvent?(event: VscodeShellIntegrationEvent): void;
  onLineData?(line: string): void;
  onTitleChange?(title: string): void;
};

export class VscodeTerminalInstance {
  private frontend: TerminalFrontend | null = null;
  private process: VscodeTerminalProcessBridge | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeDebouncer: VscodeTerminalResizeDebouncer | null = null;
  private writeScheduler: VscodeTerminalWriteScheduler | null = null;
  private disposables: Disposable[] = [];
  private resizeFrame: number | null = null;
  private resizeTimers: Array<ReturnType<typeof setTimeout>> = [];
  private disposed = false;
  private readonly notificationParser = new NotificationStreamParser();
  private autoScroll = true;
  private onNotification: (notification: ParsedNotification) => void;
  private onError: (error: string) => void;

  constructor(private readonly options: VscodeTerminalInstanceOptions) {
    this.onNotification = options.onNotification;
    this.onError = options.onError;
  }

  updateCallbacks(callbacks: {
    onError?: (error: string) => void;
    onNotification?: (notification: ParsedNotification) => void;
    onScrollStateChange?: (scrolledUp: boolean) => void;
    onShellIntegrationEvent?: (event: VscodeShellIntegrationEvent) => void;
    onLineData?: (line: string) => void;
    onTitleChange?: (title: string) => void;
  }): void {
    if (callbacks.onError) this.onError = callbacks.onError;
    if (callbacks.onNotification) this.onNotification = callbacks.onNotification;
    if (callbacks.onScrollStateChange) {
      this.options.onScrollStateChange = callbacks.onScrollStateChange;
      this.updateScrollState();
    }
    if (callbacks.onShellIntegrationEvent) {
      this.options.onShellIntegrationEvent = callbacks.onShellIntegrationEvent;
    }
    if (callbacks.onLineData) this.options.onLineData = callbacks.onLineData;
    if (callbacks.onTitleChange) this.options.onTitleChange = callbacks.onTitleChange;
  }

  async attach(host: HTMLElement): Promise<void> {
    try {
      const frontend = await this.options.frontendFactory({
        fontFamily: this.options.fontFamily,
        fontSize: this.options.fontSize,
        theme: this.options.theme,
        onFindResult: this.options.onFindResult,
      });
      if (this.disposed) {
        safeDispose(frontend);
        return;
      }
      this.frontend = frontend;
      frontend.open(host);
      if (this.options.focused) frontend.focus();
      this.updateScrollState();

      this.resizeObserver = new ResizeObserver(() => {
        this.scheduleFitBurst();
      });
      this.resizeObserver.observe(host);

      this.process = new VscodeTerminalProcessBridge({
        sessionId: this.options.sessionId,
        shell: this.options.shell,
        onData: (event) => this.handleProcessData(event),
        onError: this.onError,
        onRecovered: this.options.onRecovered,
      });
      this.writeScheduler = new VscodeTerminalWriteScheduler({
        target: () => this.frontend,
        acknowledge: (charCount) => this.process?.acknowledgeDataEvent(charCount),
        onWillData: (data) => {
          for (const notification of this.notificationParser.push(data)) {
            this.onNotification(notification);
          }
        },
        onData: () => {
          if (this.autoScroll) this.frontend?.scrollToBottom();
          this.frontend?.refresh();
          this.updateScrollState();
        },
      });
      let latestCols = 0;
      let latestRows = 0;
      this.resizeDebouncer = new VscodeTerminalResizeDebouncer(
        () => true,
        () => frontend.getBufferLength(),
        (cols, rows) => {
          latestCols = cols;
          latestRows = rows;
          void this.process?.resize(cols, rows).catch(() => {});
        },
        (cols) => {
          latestCols = cols;
          if (latestRows > 0) void this.process?.resize(latestCols, latestRows).catch(() => {});
        },
        (rows) => {
          latestRows = rows;
          if (latestCols > 0) void this.process?.resize(latestCols, latestRows).catch(() => {});
        }
      );

      this.disposables.push(
        frontend.onInput((data) => {
          void this.process?.write(data).catch((err) => {
            this.onError(err instanceof Error ? err.message : "Terminal input failed");
          });
        }),
        frontend.onResize(({ cols, rows }) => {
          this.resizeDebouncer?.resize(cols, rows, false);
        }),
        frontend.onScroll?.(() => this.updateScrollState()) ?? noopDisposable,
        frontend.onShellIntegrationEvent?.((event) =>
          this.options.onShellIntegrationEvent?.(event)
        ) ?? noopDisposable,
        frontend.onLineData?.((line) =>
          this.options.onLineData?.(line)
        ) ?? noopDisposable,
        frontend.onTitleChange?.((title) =>
          this.options.onTitleChange?.(title)
        ) ?? noopDisposable
      );

      await this.process.start();
    } catch (err) {
      if (!this.disposed) this.onError(err instanceof Error ? err.message : "Terminal failed to load");
    }
  }

  focus(): void {
    this.frontend?.fit();
    this.frontend?.refresh();
    this.frontend?.focus();
  }

  fit(): void {
    this.frontend?.fit();
  }

  setTheme(theme: XtermTheme): void {
    this.frontend?.setTheme(theme);
  }

  getSelection(): string {
    return this.frontend?.getSelection() ?? "";
  }

  selectAll(): void {
    this.frontend?.selectAll();
  }

  scrollToBottom(): void {
    this.frontend?.scrollToBottom();
    this.autoScroll = true;
    this.options.onScrollStateChange?.(false);
  }

  findNext(query: string, opts?: TerminalSearchOptions): boolean {
    return this.frontend?.findNext(query, opts) ?? false;
  }

  findPrevious(query: string, opts?: TerminalSearchOptions): boolean {
    return this.frontend?.findPrevious(query, opts) ?? false;
  }

  clearSearch(): void {
    this.frontend?.clearSearch();
  }

  serialize(): string {
    return this.frontend?.serialize() ?? "";
  }

  dispose(): void {
    this.disposed = true;
    this.clearScheduledFits();
    this.resizeObserver?.disconnect();
    this.resizeDebouncer?.flush();
    this.resizeDebouncer?.dispose();
    this.process?.dispose();
    for (const disposable of this.disposables) safeDispose(disposable);
    safeDispose(this.frontend);
    this.disposables = [];
    this.frontend = null;
    this.process = null;
    this.resizeDebouncer = null;
    this.writeScheduler = null;
  }

  private handleProcessData(event: VscodeProcessDataEvent): void {
    void this.writeScheduler?.writeProcessData(event.data, event.trackCommit);
  }

  private updateScrollState(): void {
    const scrolledUp = this.frontend?.isScrolledUp() ?? false;
    this.autoScroll = !scrolledUp;
    if (!this.disposed) this.options.onScrollStateChange?.(scrolledUp);
  }

  private scheduleFitBurst(): void {
    this.clearScheduledFits();
    const run = () => {
      if (this.disposed) return;
      try {
        this.frontend?.fit();
      } catch {
        // The frontend may still be loading xterm addons during the first resize.
      }
    };
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = null;
      run();
    });
    for (const delayMs of [50, 150, 300]) {
      const timeout = setTimeout(() => {
        this.resizeTimers = this.resizeTimers.filter((timer) => timer !== timeout);
        run();
      }, delayMs);
      this.resizeTimers.push(timeout);
    }
  }

  private clearScheduledFits(): void {
    if (this.resizeFrame !== null) {
      cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = null;
    }
    for (const timer of this.resizeTimers) clearTimeout(timer);
    this.resizeTimers = [];
  }

}

const noopDisposable = { dispose() {} };

function safeDispose(disposable: Disposable | null | undefined): void {
  try {
    disposable?.dispose();
  } catch (err) {
    console.warn("Terminal cleanup failed", err);
  }
}
