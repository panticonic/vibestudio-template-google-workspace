import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { loadPhoton } from "./image/photon.js";
import { detectMimeFromBytes } from "./image/mime.js";

import { activate } from "./index.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAUAAen63NgAAAAASUVORK5CYII=";

function tinyPng(): Uint8Array {
  return new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64"));
}

async function photonPng(): Promise<Uint8Array> {
  const photon = await loadPhoton();
  if (!photon) throw new Error("photon test dependency did not load");
  const image = new photon.PhotonImage(new Uint8Array([255, 0, 0, 255]), 1, 1);
  try {
    return image.get_bytes();
  } finally {
    image.free();
  }
}

async function api() {
  return activate({ log: { info: () => {} } });
}

describe("@workspace-extensions/image-service", () => {
  it("detects supported image magic bytes", async () => {
    const service = await api();

    await expect(service.detectMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).resolves.toBe("image/png");
    await expect(service.detectMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).resolves.toBe("image/jpeg");
    await expect(service.detectMimeType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).resolves.toBe("image/gif");
    await expect(service.detectMimeType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" />'))).resolves.toBe("image/svg+xml");
    await expect(service.detectMimeType(new Uint8Array([0x00, 0x01, 0x02]))).resolves.toBeNull();
  });

  it("does not depend on a Node-global Buffer in the extension worker", async () => {
    const input = await photonPng();
    const original = globalThis.Buffer;
    Reflect.deleteProperty(globalThis, "Buffer");
    try {
      const service = await api();
      await expect(
        service.detectMimeType({ __bin: true, data: TINY_PNG_BASE64 })
      ).resolves.toBe("image/png");
      await expect(service.resize(input, "image/png", undefined)).resolves.toMatchObject({
        mimeType: "image/png",
        width: 1,
        height: 1,
      });
    } finally {
      globalThis.Buffer = original;
    }
  });

  it("resizes tiny PNGs without changing dimensions", async () => {
    const service = await api();
    const result = await service.resize(await photonPng(), "image/png", undefined);

    expect(result.mimeType).toBe("image/png");
    expect(result.wasResized).toBe(false);
    expect(result.originalWidth).toBe(1);
    expect(result.originalHeight).toBe(1);
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    expect(result.dimensionNote).toBeUndefined();
    expect(typeof result.data).toBe("string");
    expect(Buffer.from(result.data, "base64")).not.toHaveLength(0);
  });

  it("converts identity formats without changing MIME type", async () => {
    const service = await api();
    const data = tinyPng();
    const result = await service.convert(data, "image/png", "image/png");

    expect(result.mimeType).toBe("image/png");
    expect(result.data).toBeInstanceOf(Uint8Array);
    expect(result.data.length).toBe(data.length);
  });

  it("keeps shared image helpers loadable", () => {
    expect(detectMimeFromBytes(tinyPng())).toBe("image/png");
    expect(typeof loadPhoton).toBe("function");
  });

  it("loads the CommonJS/WASM photon dependency", async () => {
    await expect(loadPhoton()).resolves.toMatchObject({
      PhotonImage: expect.any(Function),
    });
  });
});
