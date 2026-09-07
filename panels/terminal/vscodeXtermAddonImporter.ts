/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ClipboardAddon as ClipboardAddonType } from "@xterm/addon-clipboard";
import type { ImageAddon as ImageAddonType } from "@xterm/addon-image";
import type { LigaturesAddon as LigaturesAddonType } from "@xterm/addon-ligatures";
import type { ProgressAddon as ProgressAddonType } from "@xterm/addon-progress";
import type { SearchAddon as SearchAddonType } from "@xterm/addon-search";
import type { SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
import type { Unicode11Addon as Unicode11AddonType } from "@xterm/addon-unicode11";
import type { WebLinksAddon as WebLinksAddonType } from "@xterm/addon-web-links";
import type { WebglAddon as WebglAddonType } from "@xterm/addon-webgl";

export interface VscodeXtermAddonNameToCtor {
  clipboard: typeof ClipboardAddonType;
  image: typeof ImageAddonType;
  ligatures: typeof LigaturesAddonType;
  progress: typeof ProgressAddonType;
  search: typeof SearchAddonType;
  serialize: typeof SerializeAddonType;
  unicode11: typeof Unicode11AddonType;
  webLinks: typeof WebLinksAddonType;
  webgl: typeof WebglAddonType;
}

interface ImportedXtermAddonMap
  extends Map<
    keyof VscodeXtermAddonNameToCtor,
    VscodeXtermAddonNameToCtor[keyof VscodeXtermAddonNameToCtor]
  > {
  get<K extends keyof VscodeXtermAddonNameToCtor>(name: K): VscodeXtermAddonNameToCtor[K] | undefined;
  set<K extends keyof VscodeXtermAddonNameToCtor>(
    name: K,
    value: VscodeXtermAddonNameToCtor[K]
  ): this;
}

const importedAddons: ImportedXtermAddonMap = new Map();

/**
 * Port of VS Code's `XtermAddonImporter`, adapted to ESM dynamic imports instead of AMD.
 * It keeps addon constructor loading/caching out of the terminal frontend itself.
 */
export class VscodeXtermAddonImporter {
  async importAddon<T extends keyof VscodeXtermAddonNameToCtor>(
    name: T
  ): Promise<VscodeXtermAddonNameToCtor[T]> {
    let addon = importedAddons.get(name);
    if (!addon) {
      switch (name) {
        case "clipboard":
          addon = (await import("@xterm/addon-clipboard")).ClipboardAddon as VscodeXtermAddonNameToCtor[T];
          break;
        case "image":
          addon = (await import("@xterm/addon-image")).ImageAddon as VscodeXtermAddonNameToCtor[T];
          break;
        case "ligatures":
          addon = (await import("@xterm/addon-ligatures")).LigaturesAddon as VscodeXtermAddonNameToCtor[T];
          break;
        case "progress":
          addon = (await import("@xterm/addon-progress")).ProgressAddon as VscodeXtermAddonNameToCtor[T];
          break;
        case "search":
          addon = (await import("@xterm/addon-search")).SearchAddon as VscodeXtermAddonNameToCtor[T];
          break;
        case "serialize":
          addon = (await import("@xterm/addon-serialize")).SerializeAddon as VscodeXtermAddonNameToCtor[T];
          break;
        case "unicode11":
          addon = (await import("@xterm/addon-unicode11")).Unicode11Addon as VscodeXtermAddonNameToCtor[T];
          break;
        case "webLinks":
          addon = (await import("@xterm/addon-web-links")).WebLinksAddon as VscodeXtermAddonNameToCtor[T];
          break;
        case "webgl":
          addon = (await import("@xterm/addon-webgl")).WebglAddon as VscodeXtermAddonNameToCtor[T];
          break;
      }
      if (!addon) throw new Error(`Could not load addon ${name}`);
      importedAddons.set(name, addon);
    }
    return addon as VscodeXtermAddonNameToCtor[T];
  }
}

