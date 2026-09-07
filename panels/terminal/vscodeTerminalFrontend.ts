/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ClipboardSelectionType } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import type { ImageAddon } from "@xterm/addon-image";
import type { LigaturesAddon } from "@xterm/addon-ligatures";
import type { SearchAddon } from "@xterm/addon-search";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as RawXtermTerminal, type ITerminalOptions } from "@xterm/xterm";
import type {
  TerminalFindResult,
  TerminalFrontend,
  TerminalFrontendOptions,
  TerminalSearchOptions,
  TerminalSize,
} from "./terminalFrontend.js";
import type { XtermTheme } from "./paneTheme.js";
import {
  VscodeShellIntegrationAddon,
  type VscodeShellIntegrationEvent,
} from "./vscodeShellIntegration.js";
import { VscodeLineDataEventAddon } from "./vscodeLineDataEventAddon.js";
import { VscodeXtermAddonImporter } from "./vscodeXtermAddonImporter.js";

type Disposable = { dispose(): void };

export type VscodeTerminalFrontendConfig = {
  rendererType?: "auto" | "dom" | "webgl";
  enableImages?: boolean;
  enableLigatures?: boolean;
  unicodeVersion?: "6" | "11";
};

const defaultConfig: Required<VscodeTerminalFrontendConfig> = {
  // WebGL remains available behind config, but the WebContentsView panel path uses the DOM
  // renderer by default to avoid GPU readback stalls and xterm WebGL dispose races.
  rendererType: "dom",
  enableImages: false,
  enableLigatures: false,
  unicodeVersion: "11",
};

export async function createVscodeTerminalFrontend(
  options: TerminalFrontendOptions
): Promise<TerminalFrontend> {
  return new VscodeTerminalFrontend(options, defaultConfig);
}

/**
 * Ported from VS Code's `XtermTerminal` layer, with VS Code workbench services replaced by
 * local browser adapters. The upstream source lives under `vscode-upstream/`; this class keeps
 * the same ownership model: raw xterm plus a managed addon store, renderer recovery, clipboard,
 * search, serialize, unicode, and optional GPU/image/ligature support.
 */
export class VscodeTerminalFrontend implements TerminalFrontend {
  readonly raw: RawXtermTerminal;
  private readonly fitAddon = new FitAddon();
  private readonly addonImporter = new VscodeXtermAddonImporter();
  private readonly shellIntegrationAddon = new VscodeShellIntegrationAddon();
  private readonly lineDataEventAddon = new VscodeLineDataEventAddon();
  private searchAddon: SearchAddon | undefined;
  private serializeAddon: SerializeAddon | undefined;
  private readonly disposables: Disposable[] = [];
  private webglAddon: WebglAddon | undefined;
  private imageAddon: ImageAddon | undefined;
  private ligaturesAddon: LigaturesAddon | undefined;
  private disposed = false;
  private rendererGeneration = 0;

  constructor(
    private readonly options: TerminalFrontendOptions,
    private readonly config: Required<VscodeTerminalFrontendConfig>
  ) {
    const terminalOptions: ITerminalOptions = {
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      theme: options.theme,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      scrollOnUserInput: true,
    };
    this.raw = new RawXtermTerminal(terminalOptions);
  }

  open(host: HTMLElement): void {
    this.raw.open(host);
    this.installTextareaPasteResidueGuard();
    void this.loadCoreAddons().then(() => {
      if (this.disposed) return;
      this.fit();
      void this.refreshRenderer();
    });
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    if (typeof data === "string" ? data.length > 0 : data.byteLength > 0) {
      this.raw.write(data, callback);
    } else {
      callback?.();
    }
  }

  onInput(cb: (data: string) => void): Disposable {
    return this.raw.onData(cb);
  }

  onResize(cb: (size: TerminalSize) => void): Disposable {
    return this.raw.onResize(cb);
  }

  onScroll(cb: () => void): Disposable {
    return this.raw.onScroll(() => cb());
  }

  onShellIntegrationEvent(cb: (event: VscodeShellIntegrationEvent) => void): Disposable {
    return this.shellIntegrationAddon.onEvent(cb);
  }

  onLineData(cb: (line: string) => void): Disposable {
    return this.lineDataEventAddon.onLineData(cb);
  }

  onTitleChange(cb: (title: string) => void): Disposable {
    return this.raw.onTitleChange(cb);
  }

  fit(): void {
    this.fitAddon.fit();
  }

  refresh(): void {
    this.raw.refresh(0, Math.max(0, this.raw.rows - 1));
  }

  focus(): void {
    this.raw.focus();
  }

  setTheme(theme: XtermTheme): void {
    this.raw.options.theme = theme;
  }

  getSelection(): string {
    return this.raw.getSelection();
  }

  selectAll(): void {
    this.raw.selectAll();
  }

  scrollToBottom(): void {
    this.raw.scrollToBottom();
  }

  isScrolledUp(): boolean {
    return this.raw.buffer.active.viewportY < this.raw.buffer.active.baseY;
  }

  getBufferLength(): number {
    return this.raw.buffer.normal.length;
  }

  findNext(query: string, opts?: TerminalSearchOptions): boolean {
    return this.searchAddon?.findNext(query, opts) ?? false;
  }

  findPrevious(query: string, opts?: TerminalSearchOptions): boolean {
    return this.searchAddon?.findPrevious(query, opts) ?? false;
  }

  clearSearch(): void {
    this.searchAddon?.clearDecorations();
  }

  serialize(): string {
    const serialized = this.serializeAddon?.serialize() ?? "";
    return serialized || this.serializeBufferText();
  }

  dispose(): void {
    this.disposed = true;
    this.rendererGeneration += 1;
    this.disposeOfWebglRenderer(false);
    for (const disposable of this.disposables) safeDispose(disposable);
    this.imageAddon = undefined;
    this.ligaturesAddon = undefined;
    safeDispose(this.raw);
  }

  private async loadCoreAddons(): Promise<void> {
    const [ClipboardAddon, SearchAddon, SerializeAddon, Unicode11Addon, WebLinksAddon] =
      await Promise.all([
        this.addonImporter.importAddon("clipboard"),
        this.addonImporter.importAddon("search"),
        this.addonImporter.importAddon("serialize"),
        this.addonImporter.importAddon("unicode11"),
        this.addonImporter.importAddon("webLinks"),
      ]);
    if (this.disposed) return;
    this.searchAddon = new SearchAddon();
    this.serializeAddon = new SerializeAddon();
    this.raw.loadAddon(this.fitAddon);
    this.raw.loadAddon(this.shellIntegrationAddon);
    this.raw.loadAddon(this.lineDataEventAddon);
    this.raw.loadAddon(this.searchAddon);
    this.raw.loadAddon(this.serializeAddon);
    this.raw.loadAddon(new WebLinksAddon());
    this.raw.loadAddon(
      new ClipboardAddon(undefined, {
        readText: async (type) => readClipboardText(type),
        writeText: async (type, text) => writeClipboardText(type, text),
      })
    );
    this.raw.loadAddon(new Unicode11Addon());
    this.raw.unicode.activeVersion = this.config.unicodeVersion;
    this.disposables.push(
      this.searchAddon.onDidChangeResults((results) => {
        this.options.onFindResult?.({
          index: results.resultIndex,
          count: results.resultCount,
        } satisfies TerminalFindResult);
      })
    );
  }

  private async refreshRenderer(): Promise<void> {
    if (this.disposed || this.config.rendererType === "dom") return;
    if (!this.raw.element) return;
    const generation = ++this.rendererGeneration;
    try {
      this.disposeOfWebglRenderer(false);
      const WebglAddon = await this.addonImporter.importAddon("webgl");
      if (this.disposed || generation !== this.rendererGeneration) return;
      this.webglAddon = new WebglAddon();
      this.raw.loadAddon(this.webglAddon);
      this.disposables.push(
        this.webglAddon.onContextLoss(() => {
          this.rendererGeneration += 1;
          this.disposeOfWebglRenderer(true);
        })
      );
      await this.refreshImageAddon(generation);
      if (this.config.enableLigatures) {
        const LigaturesAddon = await this.addonImporter.importAddon("ligatures");
        if (this.disposed || generation !== this.rendererGeneration) return;
        this.ligaturesAddon = new LigaturesAddon();
        this.raw.loadAddon(this.ligaturesAddon);
      }
      this.fit();
    } catch (err) {
      console.warn("Falling back to xterm DOM renderer", err);
      this.disposeOfWebglRenderer(true);
    }
  }

  private async refreshImageAddon(generation: number): Promise<void> {
    if (this.disposed) return;
    if (this.config.enableImages && this.webglAddon) {
      if (this.imageAddon) return;
      const ImageAddon = await this.addonImporter.importAddon("image");
      if (this.disposed || generation !== this.rendererGeneration || !this.webglAddon) return;
      this.imageAddon = new ImageAddon();
      this.raw.loadAddon(this.imageAddon);
      return;
    }
    safeDispose(this.imageAddon);
    this.imageAddon = undefined;
  }

  private serializeBufferText(): string {
    const buffer = this.raw.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i += 1) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n").trimEnd();
  }

  private disposeOfWebglRenderer(refit: boolean): void {
    const webglAddon = this.webglAddon;
    if (!webglAddon) return;
    this.webglAddon = undefined;
    safeDispose(webglAddon);
    void this.refreshImageAddon(this.rendererGeneration);
    if (refit && !this.disposed) this.fit();
  }

  private installTextareaPasteResidueGuard(): void {
    const element = this.raw.element;
    const textarea = this.raw.textarea;
    if (!element || !textarea) return;
    const clearResidue = () => {
      if (this.disposed || document.activeElement !== textarea) return;
      textarea.value = "";
    };
    const scheduleClear = () => {
      window.setTimeout(clearResidue, 0);
      window.setTimeout(clearResidue, 50);
    };
    const onAuxClick = (event: MouseEvent) => {
      if (event.button === 1) scheduleClear();
    };
    const onPaste = () => scheduleClear();
    element.addEventListener("auxclick", onAuxClick);
    textarea.addEventListener("paste", onPaste);
    this.disposables.push({
      dispose: () => {
        element.removeEventListener("auxclick", onAuxClick);
        textarea.removeEventListener("paste", onPaste);
      },
    });
  }
}

async function readClipboardText(type: ClipboardSelectionType): Promise<string> {
  if (type !== "p") return navigator.clipboard?.readText?.() ?? "";
  return "";
}

async function writeClipboardText(type: ClipboardSelectionType, text: string): Promise<void> {
  if (type === "p") return;
  await navigator.clipboard?.writeText?.(text);
}

function safeDispose(disposable: Disposable | null | undefined): void {
  try {
    disposable?.dispose();
  } catch (err) {
    console.warn("Terminal cleanup failed", err);
  }
}
