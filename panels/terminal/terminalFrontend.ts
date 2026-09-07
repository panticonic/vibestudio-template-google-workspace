import type { XtermTheme } from "./paneTheme.js";
import type { VscodeShellIntegrationEvent } from "./vscodeShellIntegration.js";

export type TerminalSize = { cols: number; rows: number };

export type TerminalSearchOptions = {
  caseSensitive?: boolean;
  regex?: boolean;
  decorations?: {
    activeMatchBackground: string;
    activeMatchBorder: string;
    activeMatchColorOverviewRuler: string;
    matchBackground: string;
    matchBorder: string;
    matchOverviewRuler: string;
  };
};

export type TerminalFindResult = { index: number; count: number };

export type TerminalFrontendOptions = {
  fontFamily: string;
  fontSize: number;
  theme: XtermTheme;
  onFindResult?(result: TerminalFindResult): void;
};

export interface TerminalFrontend {
  open(host: HTMLElement): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  onInput(cb: (data: string) => void): { dispose(): void };
  onResize(cb: (size: TerminalSize) => void): { dispose(): void };
  onScroll?(cb: () => void): { dispose(): void };
  onShellIntegrationEvent?(cb: (event: VscodeShellIntegrationEvent) => void): { dispose(): void };
  onLineData?(cb: (line: string) => void): { dispose(): void };
  onTitleChange?(cb: (title: string) => void): { dispose(): void };
  fit(): void;
  refresh(): void;
  focus(): void;
  setTheme(theme: XtermTheme): void;
  getSelection(): string;
  selectAll(): void;
  scrollToBottom(): void;
  isScrolledUp(): boolean;
  getBufferLength(): number;
  findNext(query: string, opts?: TerminalSearchOptions): boolean;
  findPrevious(query: string, opts?: TerminalSearchOptions): boolean;
  clearSearch(): void;
  serialize(): string;
  dispose(): void;
}

export type TerminalFrontendFactory = (
  options: TerminalFrontendOptions
) => Promise<TerminalFrontend>;
