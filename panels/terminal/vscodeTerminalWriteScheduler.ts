/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type VscodeTerminalWriteTarget = {
  write(data: string | Uint8Array, callback?: () => void): void;
};

export type VscodeTerminalWriteSchedulerOptions = {
  target(): VscodeTerminalWriteTarget | null;
  acknowledge(charCount: number): void;
  onWillData?(data: string): void;
  onData?(data: string): void;
};

/**
 * Port of VS Code's process-data write path from `TerminalInstance`.
 *
 * It intentionally splits shell-integration command execute/finished sequences into separate
 * writes so command output is observed in a consistent form, and it acknowledges data only once
 * xterm confirms the write was parsed.
 */
export class VscodeTerminalWriteScheduler {
  private latestXtermWriteData = 0;
  private latestXtermParseData = 0;

  constructor(private readonly options: VscodeTerminalWriteSchedulerOptions) {}

  writeProcessData(data: string, trackCommit = false): Promise<void> | undefined {
    const leadingSegmentedData: string[] = [];
    // oxlint-disable-next-line eslint/no-control-regex -- ESC and BEL delimit shell integration OSC frames.
    const matches = data.matchAll(/(?<seq>\x1b\][16]33;(?:C|D(?:;\d+)?)\x07)/g);
    let i = 0;
    for (const match of matches) {
      const seq = match.groups?.["seq"];
      if (seq === undefined) throw new Error("seq must be defined");
      leadingSegmentedData.push(data.substring(i, match.index));
      leadingSegmentedData.push(seq);
      i = match.index + match[0].length;
    }
    const lastData = data.substring(i);

    for (const segment of leadingSegmentedData) {
      this.writeProcessSegment(segment);
    }
    if (trackCommit) {
      return new Promise<void>((resolve) => this.writeProcessSegment(lastData, resolve));
    }
    this.writeProcessSegment(lastData);
    return undefined;
  }

  private writeProcessSegment(data: string, callback?: () => void): void {
    if (!data) {
      callback?.();
      return;
    }
    this.options.onWillData?.(data);
    const messageId = ++this.latestXtermWriteData;
    this.options.target()?.write(data, () => {
      this.latestXtermParseData = messageId;
      this.options.acknowledge(data.length);
      callback?.();
      this.options.onData?.(data);
    });
  }

  get latestParsedMessageId(): number {
    return this.latestXtermParseData;
  }
}
