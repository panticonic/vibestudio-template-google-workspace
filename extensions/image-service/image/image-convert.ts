/**
 * Image format conversion.
 *
 * Ported from @mariozechner/pi-coding-agent/src/utils/image-convert.ts.
 *
 * The pi-coding-agent original only exposes `convertToPng(base64Data, mimeType)`
 * (used by the kitty graphics protocol). We add a binary-friendly
 * `convertImage(data, sourceMimeType, targetMimeType)` wrapper used by the
 * image service extension so the RPC boundary stays in `Uint8Array`.
 *
 * Server-side only — depends on photon.ts which uses Node fs.
 */
import { Buffer } from "node:buffer";
import { loadPhoton } from "./photon.js";

export interface ConvertedImage {
  data: Uint8Array;
  mimeType: string;
}

/**
 * Convert image to PNG format for terminal display.
 * Kitty graphics protocol requires PNG format (f=100).
 *
 * Literal port from pi-coding-agent.
 */
export async function convertToPng(
  base64Data: string,
  mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
  // Already PNG, no conversion needed
  if (mimeType === "image/png") {
    return { data: base64Data, mimeType };
  }
  const photon = await loadPhoton();
  if (!photon) {
    // Photon not available, can't convert
    return null;
  }
  try {
    const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
    const image = photon.PhotonImage.new_from_byteslice(bytes);
    try {
      const pngBuffer = image.get_bytes();
      return {
        data: Buffer.from(pngBuffer).toString("base64"),
        mimeType: "image/png",
      };
    } finally {
      image.free();
    }
  } catch {
    // Conversion failed
    return null;
  }
}

/**
 * Convert image bytes between formats. Supports png/jpeg/webp.
 * Returns the original bytes unchanged when source matches target.
 * Returns null if photon is unavailable or conversion fails.
 */
export async function convertImage(
  data: Uint8Array,
  sourceMimeType: string,
  targetMimeType: string,
): Promise<ConvertedImage | null> {
  if (sourceMimeType === targetMimeType) {
    return { data, mimeType: sourceMimeType };
  }
  const photon = await loadPhoton();
  if (!photon) {
    return null;
  }
  let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
  try {
    image = photon.PhotonImage.new_from_byteslice(new Uint8Array(data));
    let outBuffer: Uint8Array;
    switch (targetMimeType) {
      case "image/png":
        outBuffer = image.get_bytes();
        break;
      case "image/jpeg":
        outBuffer = image.get_bytes_jpeg(80);
        break;
      case "image/webp":
        // photon-node doesn't expose a dedicated WebP encoder; fall back to PNG
        // and report image/png so callers see what they actually got.
        return { data: image.get_bytes(), mimeType: "image/png" };
      default:
        // Unknown target — give back PNG bytes.
        outBuffer = image.get_bytes();
        return { data: outBuffer, mimeType: "image/png" };
    }
    return { data: outBuffer, mimeType: targetMimeType };
  } catch {
    return null;
  } finally {
    if (image) {
      image.free();
    }
  }
}
