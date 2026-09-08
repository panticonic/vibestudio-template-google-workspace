import { describe, it, expect, vi, afterEach } from "vitest";
import { createImageLoader } from "./imageLoader.js";
import type { ImageAsset } from "./images.js";
const asset = { id: "asset:one", mimeType: "image/png" } as ImageAsset;
afterEach(() => vi.unstubAllGlobals());
function setup(getBytes = vi.fn(async () => new Uint8Array([1]))) {
  const revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:local"), revokeObjectURL: revoke });
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode = async () => {};
    }
  );
  return { loader: createImageLoader({ getBytes }), revoke, getBytes };
}
describe("image loader leases", () => {
  it("shares authenticated fetch and decode until the final consumer releases", async () => {
    const { loader, getBytes, revoke } = setup();
    const [first, second] = await Promise.all([loader.load(asset), loader.load(asset)]);
    expect(getBytes).toHaveBeenCalledTimes(1);
    expect(first.image).toBe(second.image);
    first.release();
    first.release();
    expect(revoke).not.toHaveBeenCalled();
    second.release();
    expect(revoke).toHaveBeenCalledTimes(1);
  });
  it("aborting one pending consumer does not invalidate another", async () => {
    let complete!: (value: Uint8Array) => void;
    const { loader, revoke } = setup(
      vi.fn(
        () =>
          new Promise<Uint8Array>((resolve) => {
            complete = resolve;
          })
      )
    );
    const controller = new AbortController();
    const first = loader.load(asset, { signal: controller.signal });
    const second = loader.load(asset);
    controller.abort(new Error("obsolete scene"));
    await expect(first).rejects.toThrow("obsolete scene");
    complete(new Uint8Array([1]));
    const lease = await second;
    expect(revoke).not.toHaveBeenCalled();
    lease.release();
    expect(revoke).toHaveBeenCalledTimes(1);
  });
  it("cleans up an abandoned pending decode and permits a fresh request", async () => {
    let complete!: (value: Uint8Array) => void;
    const { loader, revoke } = setup(
      vi.fn(
        () =>
          new Promise<Uint8Array>((resolve) => {
            complete = resolve;
          })
      )
    );
    const controller = new AbortController();
    const result = loader.load(asset, { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toThrow();
    complete(new Uint8Array([1]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revoke).toHaveBeenCalledTimes(1);
    loader.dispose();
    await expect(loader.load(asset)).rejects.toThrow("disposed");
  });
});
