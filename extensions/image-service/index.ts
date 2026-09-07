import { Buffer } from "node:buffer";
import {
  resizeImage,
  formatDimensionNote,
  type ImageResizeOptions,
} from "./image/image-resize.js";
import { convertImage } from "./image/image-convert.js";
import { detectMimeFromBytes } from "./image/mime.js";

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj["__bin"] === true && typeof obj["data"] === "string") {
      return new Uint8Array(Buffer.from(obj["data"], "base64"));
    }
    if (obj["type"] === "Buffer" && Array.isArray(obj["data"])) {
      return new Uint8Array(obj["data"] as number[]);
    }
    if ("buffer" in obj && (obj as { buffer?: unknown }).buffer instanceof ArrayBuffer) {
      const view = obj as { buffer: ArrayBuffer; byteOffset?: number; byteLength?: number };
      return new Uint8Array(view.buffer, view.byteOffset ?? 0, view.byteLength ?? view.buffer.byteLength);
    }
  }
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  if (typeof value === "string") return new Uint8Array(Buffer.from(value, "base64"));
  throw new Error("image-service: expected binary data");
}

/** Public API surface of this extension — the awaited return of {@link activate}. */
export type Api = Awaited<ReturnType<typeof activate>>;
declare module "@vibestudio/extension" {
  interface WorkspaceExtensions {
    "@workspace-extensions/image-service": Api;
  }
}

export async function activate(ctx: { log: { info(message: string): void } }) {
  ctx.log.info("image-service activating");
  return {
    async resize(rawData: unknown, mimeType: string, options?: ImageResizeOptions) {
      const data = toUint8Array(rawData);
      const result = await resizeImage(
        { type: "image", mimeType, data: Buffer.from(data).toString("base64") },
        options,
      );
      const out: {
        data: string;
        mimeType: string;
        width: number;
        height: number;
        originalWidth: number;
        originalHeight: number;
        wasResized: boolean;
        dimensionNote?: string;
      } = {
        data: result.data,
        mimeType: result.mimeType,
        originalWidth: result.originalWidth,
        originalHeight: result.originalHeight,
        width: result.width,
        height: result.height,
        wasResized: result.wasResized,
      };
      const note = formatDimensionNote(result);
      if (note !== undefined) out.dimensionNote = note;
      return out;
    },

    async convert(rawData: unknown, sourceMimeType: string, targetMimeType: string) {
      const result = await convertImage(toUint8Array(rawData), sourceMimeType, targetMimeType);
      if (!result) {
        throw new Error(
          `image-service.convert: failed to convert ${sourceMimeType} to ${targetMimeType}`,
        );
      }
      return {
        data: result.data,
        mimeType: result.mimeType,
      };
    },

    async detectMimeType(rawData: unknown) {
      return detectMimeFromBytes(toUint8Array(rawData));
    },
  };
}
