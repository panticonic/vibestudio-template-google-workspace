import type { ShellApi, TerminalState } from "./types.js";

const MAX_SCRATCH_BYTES = 25 * 1024 * 1024;
const DATA_URI_LIMIT_BYTES = 5 * 1024 * 1024;

export interface StashedPaste {
  pasteText: string;
  absolutePath?: string;
  workspaceRelative?: string;
}

export interface PasteBatchResult {
  stashed: Array<{ index: number; paste: StashedPaste }>;
  errors: Array<{ index: number; message: string }>;
  pasteText: string;
}

export async function stashForPaste(args: {
  shell: ShellApi;
  bytes: Uint8Array;
  mime: string;
  cwd: string;
  pasteMode: TerminalState["pasteMode"];
  imagePasteRelative: boolean;
}): Promise<StashedPaste> {
  if (!args.shell.stashScratch) throw new Error("shell.stashScratch is not available");
  if (args.bytes.byteLength === 0) throw new Error("Empty file, nothing pasted");
  const itemLabel = args.mime.startsWith("image/") ? "Image" : "File";
  if (args.bytes.byteLength > MAX_SCRATCH_BYTES) throw new Error(`${itemLabel} exceeds 25MB scratch limit`);
  if ((args.pasteMode === "dataUri" || args.pasteMode === "both") && args.bytes.byteLength > DATA_URI_LIMIT_BYTES) {
    throw new Error(`${itemLabel} exceeds 5MB data URI limit`);
  }

  const ext = extensionFromMime(args.mime);
  const stashed = await args.shell.stashScratch(args.bytes, ext);
  const pathText = args.imagePasteRelative
    ? safeRelativePath(args.cwd, stashed.absolutePath) ?? stashed.absolutePath
    : stashed.absolutePath;
  const pieces: string[] = [];
  if (args.pasteMode === "path" || args.pasteMode === "both") pieces.push(shellQuote(pathText));
  if (args.pasteMode === "dataUri" || args.pasteMode === "both") {
    pieces.push(`data:${args.mime || "application/octet-stream"};base64,${bytesToBase64(args.bytes)}`);
  }
  return { pasteText: pieces.join(" "), absolutePath: stashed.absolutePath, workspaceRelative: stashed.workspaceRelative };
}

export async function stashPasteBatch(args: {
  shell: ShellApi;
  items: Array<{ bytes: Uint8Array; mime: string }>;
  cwd: string;
  pasteMode: TerminalState["pasteMode"];
  imagePasteRelative: boolean;
}): Promise<PasteBatchResult> {
  const stashed: PasteBatchResult["stashed"] = [];
  const errors: PasteBatchResult["errors"] = [];
  for (const [index, item] of args.items.entries()) {
    try {
      const paste = await stashForPaste({
        shell: args.shell,
        bytes: item.bytes,
        mime: item.mime,
        cwd: args.cwd,
        pasteMode: args.pasteMode,
        imagePasteRelative: args.imagePasteRelative,
      });
      stashed.push({ index, paste });
    } catch (err) {
      errors.push({ index, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return {
    stashed,
    errors,
    pasteText: stashed.map((item) => item.paste.pasteText).join(" "),
  };
}

export async function fileToBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export async function fetchUrlForPaste(args: {
  shell: ShellApi;
  url: string;
  cwd: string;
  pasteMode: TerminalState["pasteMode"];
  imagePasteRelative: boolean;
}): Promise<StashedPaste | undefined> {
  if (!/^https?:\/\//i.test(args.url)) return undefined;
  const response = await fetch(args.url);
  if (!response.ok) return undefined;
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_SCRATCH_BYTES) {
    throw new Error("Dropped URL exceeds 25MB scratch limit");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_SCRATCH_BYTES) throw new Error("Dropped URL exceeds 25MB scratch limit");
  return stashForPaste({
    shell: args.shell,
    bytes,
    mime: response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream",
    cwd: args.cwd,
    pasteMode: args.pasteMode,
    imagePasteRelative: args.imagePasteRelative,
  });
}

export function extensionFromMime(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/")) return "txt";
  return "bin";
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function safeRelativePath(fromDir: string, absolutePath: string): string | undefined {
  const from = normalizePath(fromDir).replace(/\/+$/, "");
  const target = normalizePath(absolutePath);
  const fromParts = from.split("/").filter(Boolean);
  const targetParts = target.split("/").filter(Boolean);
  let shared = 0;
  while (shared < fromParts.length && shared < targetParts.length && fromParts[shared] === targetParts[shared]) shared += 1;
  const up = fromParts.slice(shared).map(() => "..");
  const down = targetParts.slice(shared);
  const rel = [...up, ...down].join("/") || ".";
  return rel.startsWith("..") ? undefined : rel;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
