/**
 * Image MIME-type detection via magic bytes.
 *
 * Ported from @mariozechner/pi-coding-agent/src/utils/mime.ts but adapted for
 * the buffer-only path (no file handle / fs API). We inline a minimal
 * magic-byte sniffer for PNG, JPEG, GIF, WebP, and SVG so we don't pull in
 * the `file-type` ESM package as an explicit dep — pi-coding-agent's
 * `IMAGE_MIME_TYPES` allowlist is exactly these formats anyway.
 */

const SUPPORTED_IMAGE_MIME_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

/** Number of bytes pi-coding-agent sniffs (kept for parity with file-type). */
export const FILE_TYPE_SNIFF_BYTES = 4100;

function startsWith(data: Uint8Array, prefix: number[], offset = 0): boolean {
  if (data.length < offset + prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (data[offset + i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Detect a supported image MIME type from a byte buffer.
 * Returns null if the bytes do not match a known image format we accept.
 */
export function detectMimeFromBytes(data: Uint8Array): string | null {
  if (!data || data.length === 0) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (startsWith(data, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }

  // GIF: "GIF87a" or "GIF89a"
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return "image/gif";
  }

  // WebP: "RIFF" .... "WEBP"
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) &&
      startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }

  // SVG: textual — sniff the first ~512 bytes for "<svg" (case-insensitive)
  // after optional XML prolog / whitespace.
  const sniffLen = Math.min(data.length, 512);
  let textPrefix = "";
  for (let i = 0; i < sniffLen; i++) {
    textPrefix += String.fromCharCode(data[i]!);
  }
  const lower = textPrefix.toLowerCase().trimStart();
  if (lower.startsWith("<?xml")) {
    if (lower.includes("<svg")) return "image/svg+xml";
  } else if (lower.startsWith("<svg")) {
    return "image/svg+xml";
  }

  return null;
}

/**
 * Returns true if `mime` is one of the image formats we accept.
 */
export function isSupportedImageMime(mime: string | null | undefined): boolean {
  return !!mime && SUPPORTED_IMAGE_MIME_TYPES.has(mime);
}
