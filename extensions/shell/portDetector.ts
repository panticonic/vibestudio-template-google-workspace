export interface DetectionState {
  detectedPorts: number[];
  detectedUrls: string[];
  lineWindow: string[];
  pendingLine: string;
}

const MAX_LINES = 80;
const MAX_ITEMS = 20;
const MAX_PENDING_LINE = 4096;
const URL_RE = /\bhttps?:\/\/[^\s"'<>)]{3,}/gi;
const PORT_RE = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)[^\d]{0,12}(\d{2,5})\b/gi;

export function createDetectionState(): DetectionState {
  return { detectedPorts: [], detectedUrls: [], lineWindow: [], pendingLine: "" };
}

export function scanChunk(state: DetectionState, bytes: Uint8Array): boolean {
  if (looksBinary(bytes)) return false;
  const text = new TextDecoder("utf8", { fatal: false }).decode(bytes);
  const lines = consumeLines(state, text);
  if (lines.length) state.lineWindow.push(...lines);
  if (state.lineWindow.length > MAX_LINES) state.lineWindow.splice(0, state.lineWindow.length - MAX_LINES);
  const haystack = state.lineWindow.join("\n");
  const previousPorts = state.detectedPorts.join(",");
  const previousUrls = state.detectedUrls.join("\n");

  for (const match of haystack.matchAll(URL_RE)) {
    addUnique(state.detectedUrls, match[0].replace(/[.,;:]+$/, ""));
  }
  for (const match of haystack.matchAll(PORT_RE)) {
    const port = Number(match[1]);
    if (port > 0 && port <= 65535) addUnique(state.detectedPorts, port);
  }

  return previousPorts !== state.detectedPorts.join(",") || previousUrls !== state.detectedUrls.join("\n");
}

function consumeLines(state: DetectionState, text: string): string[] {
  if (!text) return [];
  const endedWithNewline = /\r?\n$/.test(text);
  const parts = text.split(/\r?\n/);
  parts[0] = `${state.pendingLine}${parts[0] ?? ""}`;
  if (endedWithNewline) {
    state.pendingLine = "";
    return parts.filter(Boolean);
  }
  state.pendingLine = (parts.pop() ?? "").slice(-MAX_PENDING_LINE);
  return parts.filter(Boolean);
}

function addUnique<T>(items: T[], value: T): void {
  if (!items.includes(value)) items.push(value);
  if (items.length > MAX_ITEMS) items.splice(0, items.length - MAX_ITEMS);
}

function looksBinary(bytes: Uint8Array): boolean {
  if (!bytes.byteLength) return false;
  let nonPrintable = 0;
  for (const byte of bytes) {
    const printable = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126) || byte >= 128;
    if (!printable) nonPrintable += 1;
  }
  return nonPrintable / bytes.byteLength > 0.5;
}
