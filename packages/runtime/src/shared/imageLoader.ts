import type { ImageAsset, ImagesClient } from "./images.js";

export interface LoadedImage {
  readonly url: string;
  /** Decoded image, usable directly with CanvasRenderingContext2D.drawImage. */
  readonly image: HTMLImageElement;
  release(): void;
}
export interface ImageLoader {
  load(asset: ImageAsset, options?: { signal?: AbortSignal }): Promise<LoadedImage>;
  dispose(): void;
}
/** One loader per renderer/isolated realm. The authenticated client owns access;
 * local object URLs exist only while at least one consumer holds a lease. */
export function createImageLoader(client: Pick<ImagesClient, "getBytes">): ImageLoader {
  type Entry = {
    users: number;
    promise: Promise<{ url: string; image: HTMLImageElement }>;
    value?: { url: string; image: HTMLImageElement };
  };
  const entries = new Map<string, Entry>();
  let disposed = false;
  const remove = (key: string, entry: Entry) => {
    if (entries.get(key) === entry) entries.delete(key);
    if (entry.value) {
      URL.revokeObjectURL(entry.value.url);
      entry.value.image.src = "";
      entry.value = undefined;
    }
  };
  return {
    async load(asset, options = {}) {
      if (disposed) throw new Error("Image loader is disposed");
      options.signal?.throwIfAborted();
      // ID is the authorization-bearing registry identity. Never share a cached
      // digest across distinct asset registrations or workspace clients.
      const key = asset.id;
      let entry = entries.get(key);
      if (!entry) {
        const created: Entry = { users: 0, promise: undefined! };
        created.promise = (async () => {
          const bytes = await client.getBytes(asset);
          const url = URL.createObjectURL(
            new Blob([new Uint8Array(bytes)], { type: asset.mimeType })
          );
          const image = new Image();
          image.src = url;
          try {
            await image.decode();
          } catch (error) {
            URL.revokeObjectURL(url);
            image.src = "";
            throw error;
          }
          created.value = { url, image };
          if (disposed || created.users === 0) {
            remove(key, created);
            throw new Error("Image load no longer needed");
          }
          return created.value;
        })();
        entry = created;
        entries.set(key, entry);
      }
      entry.users += 1;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          entry!.users -= 1;
          if (entry!.users === 0) remove(key, entry!);
        }
      };
      let abort: (() => void) | undefined;
      try {
        const aborted = new Promise<never>((_resolve, reject) => {
          abort = () => {
            release();
            reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
          };
          options.signal?.addEventListener("abort", abort, { once: true });
          if (options.signal?.aborted) abort();
        });
        const value = await Promise.race([entry.promise, aborted]);
        if (disposed) throw new Error("Image loader is disposed");
        return { ...value, release };
      } catch (error) {
        release();
        throw error;
      } finally {
        if (abort) options.signal?.removeEventListener("abort", abort);
      }
    },
    dispose() {
      disposed = true;
      for (const [key, entry] of entries) remove(key, entry);
    },
  };
}
