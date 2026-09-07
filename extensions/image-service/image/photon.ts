/**
 * Photon image processing wrapper.
 *
 * Ported literally from @mariozechner/pi-coding-agent/src/utils/photon.ts.
 *
 * This module provides a unified interface to @silvia-odwyer/photon-node that
 * runs server-side (Node.js). Photon owns and resolves its WASM asset from its
 * installed package; the extension does not search executable or process roots.
 *
 * NOTE: this file is server-only. workerd cannot import it.
 */
// Lazy-loaded photon module
let photonModule: typeof import("@silvia-odwyer/photon-node") | null = null;
let loadPromise: Promise<
  typeof import("@silvia-odwyer/photon-node") | null
> | null = null;

/**
 * Load the photon module asynchronously.
 * Returns cached module on subsequent calls.
 */
export async function loadPhoton(): Promise<
  typeof import("@silvia-odwyer/photon-node") | null
> {
  if (photonModule) {
    return photonModule;
  }
  if (loadPromise) {
    return loadPromise;
  }
  loadPromise = (async () => {
    try {
      const imported = await import("@silvia-odwyer/photon-node");
      const moduleNamespace = imported as unknown as {
        default?: typeof imported;
      };
      photonModule = moduleNamespace.default ?? imported;
      return photonModule;
    } catch {
      photonModule = null;
      return photonModule;
    }
  })();
  return loadPromise;
}
