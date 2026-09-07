import { createHash } from "node:crypto";

export function toUint8Array(value: unknown, label = "pdf-ingest"): Uint8Array {
  const data = coerceUint8Array(value, new Set());
  if (data) return data;
  throw new Error(`${label}: expected PDF binary data`);
}

function coerceUint8Array(value: unknown, seen: Set<object>): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return null;
    seen.add(value);
    const obj = value as Record<string, unknown>;
    if (obj["__bin"] === true && typeof obj["data"] === "string") {
      return new Uint8Array(Buffer.from(obj["data"], "base64"));
    }
    if (
      (obj["encoding"] === "base64" || obj["base64"] === true) &&
      typeof obj["data"] === "string"
    ) {
      return new Uint8Array(Buffer.from(obj["data"], "base64"));
    }
    if (obj["type"] === "Buffer" && Array.isArray(obj["data"])) {
      return new Uint8Array(obj["data"] as number[]);
    }
    if (
      (obj["type"] === "Uint8Array" || obj["constructor"] === "Uint8Array") &&
      "data" in obj
    ) {
      const fromData = coerceUint8Array(obj["data"], seen);
      if (fromData) return fromData;
    }
    if ("bytes" in obj) {
      const fromBytes = coerceUint8Array(obj["bytes"], seen);
      if (fromBytes) return fromBytes;
    }
    if ("buffer" in obj && (obj as { buffer?: unknown }).buffer instanceof ArrayBuffer) {
      const view = obj as { buffer: ArrayBuffer; byteOffset?: number; byteLength?: number };
      return new Uint8Array(
        view.buffer,
        view.byteOffset ?? 0,
        view.byteLength ?? view.buffer.byteLength
      );
    }
    const fromNumericRecord = numericRecordToUint8Array(obj);
    if (fromNumericRecord) return fromNumericRecord;
  }
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  if (typeof value === "string") return new Uint8Array(Buffer.from(value, "base64"));
  return null;
}

function numericRecordToUint8Array(value: Record<string, unknown>): Uint8Array | null {
  const numericKeys = Object.keys(value).filter((key) => /^\d+$/.test(key));
  if (numericKeys.length === 0) return null;

  const explicitLength = value["length"] ?? value["byteLength"];
  let maxIndex = -1;
  for (const key of numericKeys) {
    const index = Number(key);
    if (index > maxIndex) maxIndex = index;
  }
  const length =
    typeof explicitLength === "number" &&
    Number.isInteger(explicitLength) &&
    explicitLength >= 0
      ? explicitLength
      : maxIndex + 1;

  if (!Number.isSafeInteger(length) || length < numericKeys.length || maxIndex >= length) {
    return null;
  }

  const output = new Uint8Array(length);
  for (const key of numericKeys) {
    const byte = value[key];
    if (
      typeof byte !== "number" ||
      !Number.isInteger(byte) ||
      byte < 0 ||
      byte > 255
    ) {
      return null;
    }
    output[Number(key)] = byte;
  }
  return output;
}

export function sha256Hex(data: Uint8Array | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function assertPdfBytes(data: Uint8Array): void {
  const header = Buffer.from(data.subarray(0, 8)).toString("latin1");
  if (!header.startsWith("%PDF-")) {
    throw new Error("pdf-ingest: input does not look like a PDF file");
  }
}
