/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ShellApi } from "./types.js";

export const VscodeFlowControlConstants = {
  /**
   * The number of _unacknowledged_ chars to have been sent before the pty is paused in order for
   * the client to catch up.
   */
  HighWatermarkChars: 100000,
  /**
   * After flow control pauses the pty for the client the catch up, this is the number of
   * _unacknowledged_ chars to have been caught up to on the client before resuming the pty again.
   */
  LowWatermarkChars: 5000,
  /**
   * The number characters that are accumulated on the client side before sending an ack event.
   * This must be less than or equal to LowWatermarkChars or the terminal max never unpause.
   */
  CharCountAckSize: 5000,
} as const;

export type VscodeProcessDataEvent = {
  bytes: Uint8Array;
  data: string;
  trackCommit: boolean;
};

export class VscodeAckDataBufferer {
  private unsentCharCount = 0;

  constructor(private readonly callback: (charCount: number) => void) {}

  ack(charCount: number): void {
    this.unsentCharCount += charCount;
    while (this.unsentCharCount > VscodeFlowControlConstants.CharCountAckSize) {
      this.unsentCharCount -= VscodeFlowControlConstants.CharCountAckSize;
      this.callback(VscodeFlowControlConstants.CharCountAckSize);
    }
  }
}

export type VscodeTerminalProcessBridgeOptions = {
  sessionId: string;
  shell: ShellApi;
  onData(event: VscodeProcessDataEvent): void;
  onError(error: string): void;
  onRecovered?(): void;
};

/**
 * vibestudio connectivity adapter for VS Code's terminal process-manager role.
 *
 * VS Code's `TerminalProcessManager` cannot be imported unchanged without its backend registry,
 * profile resolver, environment collections, remote authority services, telemetry, and workspace
 * services. This class keeps the upstream shape at the edge where it matters to the terminal
 * frontend: a process emits data events, accepts input/resize, has contained disposal, and tracks
 * client parse acknowledgement using VS Code's flow-control constants.
 */
export class VscodeTerminalProcessBridge {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private disposed = false;
  private generation = 0;
  private lastCursor = 0;
  private cursorWatchdog: ReturnType<typeof setTimeout> | null = null;
  private streamFailed = false;
  private readonly ackBufferer = new VscodeAckDataBufferer(() => {
    void this.options.shell
      .acknowledgeDataEvent?.(this.options.sessionId, VscodeFlowControlConstants.CharCountAckSize)
      .catch((error: unknown) =>
        console.warn(
          `[terminal] Failed to acknowledge output for session ${this.options.sessionId}:`,
          error
        )
      );
  });

  constructor(private readonly options: VscodeTerminalProcessBridgeOptions) {}

  async start(): Promise<void> {
    await this.replayScrollback();
    if (!this.disposed) this.connectLiveStream();
  }

  private async replayScrollback(): Promise<void> {
    try {
      const { text, cursor } = await this.options.shell.getScrollback(this.options.sessionId);
      if (this.disposed) return;
      this.lastCursor = cursorFrom(cursor);
      if (text) {
        this.options.onData({
          bytes: new TextEncoder().encode(text),
          data: text,
          trackCommit: false,
        });
      }
    } catch (err) {
      if (!this.disposed) {
        this.options.onError(err instanceof Error ? err.message : "Terminal output failed");
      }
    }
  }

  private connectLiveStream(): void {
    const generation = ++this.generation;
    void this.reader?.cancel().catch(() => {});
    this.reader = null;
    void this.readLiveStream(generation);
  }

  private async readLiveStream(generation: number): Promise<void> {
    while (!this.disposed && generation === this.generation) {
      try {
        const response = await this.options.shell.attach(this.options.sessionId, {
          after: String(this.lastCursor),
        });
        if (this.disposed || generation !== this.generation) return;
        if (this.streamFailed) {
          this.streamFailed = false;
          this.options.onRecovered?.();
        }
        const reader = response.body?.getReader() ?? null;
        this.reader = reader;
        if (!reader) {
          await delay(250);
          continue;
        }
        const decoder = new TextDecoder();
        while (!this.disposed && generation === this.generation) {
          const next = await reader.read();
          if (next.done) {
            const tail = decoder.decode();
            if (tail) {
              this.options.onData({
                bytes: new Uint8Array(0),
                data: tail,
                trackCommit: false,
              });
            }
            break;
          }
          this.lastCursor += next.value.byteLength;
          this.options.onData({
            bytes: next.value,
            data: decoder.decode(next.value, { stream: true }),
            trackCommit: false,
          });
        }
      } catch (err) {
        if (!this.disposed && generation === this.generation) {
          this.streamFailed = true;
          this.options.onError(err instanceof Error ? err.message : "Terminal output failed");
        }
      } finally {
        if (generation === this.generation) this.reader = null;
      }
      if (this.disposed || generation !== this.generation || !(await this.sessionAlive())) return;
      await delay(250);
    }
  }

  async write(data: string): Promise<void> {
    await this.options.shell.write(this.options.sessionId, data);
    this.scheduleCursorWatchdog();
  }

  resize(cols: number, rows: number): Promise<void> {
    return this.options.shell.resize(this.options.sessionId, cols, rows);
  }

  acknowledgeDataEvent(charCount: number): void {
    this.ackBufferer.ack(charCount);
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    if (this.cursorWatchdog) clearTimeout(this.cursorWatchdog);
    void this.reader?.cancel().catch(() => {});
    this.reader = null;
  }

  private scheduleCursorWatchdog(): void {
    if (this.cursorWatchdog) clearTimeout(this.cursorWatchdog);
    this.cursorWatchdog = setTimeout(() => {
      this.cursorWatchdog = null;
      void this.reconnectIfScrollbackAdvanced();
    }, 150);
  }

  private async reconnectIfScrollbackAdvanced(): Promise<void> {
    if (this.disposed) return;
    try {
      const { cursor } = await this.options.shell.getScrollback(this.options.sessionId, 1024);
      const remoteCursor = cursorFrom(cursor);
      if (remoteCursor > this.lastCursor) {
        this.connectLiveStream();
      }
    } catch {
      // The live reader reports stream errors; this watchdog is best-effort recovery.
    }
  }

  private async sessionAlive(): Promise<boolean> {
    try {
      return (await this.options.shell.getSessionInfo(this.options.sessionId)).alive;
    } catch {
      return false;
    }
  }
}

function cursorFrom(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
