import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { groupTextItems, linesToLayoutText, linesToMarkdown, type PdfTextItem } from "./layout.js";
import type {
  ExtractedPdf,
  ExtractedPdfDocument,
  ExtractedPdfPage,
  PdfEngineStatus,
  PdfRenderedPage,
} from "./types.js";
import { selectPages } from "./pages.js";
import { sha256Hex } from "./binary.js";
import type { ArtifactStore } from "./artifacts.js";

const require = createRequire(import.meta.url);

type PdfJsModule = {
  getDocument: (params: Record<string, unknown>) => { promise: Promise<PdfJsDocument> };
  version?: string;
};

interface LoadedPdfJs {
  module: PdfJsModule;
  packageName: "pdfjs-dist";
}

type PdfJsDocument = {
  numPages: number;
  fingerprints?: string[];
  getPage(pageNumber: number): Promise<PdfJsPage>;
  getMetadata(): Promise<{ info?: Record<string, unknown>; metadata?: unknown }>;
  destroy?: () => Promise<void> | void;
  cleanup?: () => Promise<void> | void;
};

type PdfJsPage = {
  rotate?: number;
  getViewport(options: { scale: number; rotation?: number }): { width: number; height: number };
  getTextContent(options?: Record<string, unknown>): Promise<{ items: unknown[] }>;
  render(params: Record<string, unknown>): { promise: Promise<void> };
  cleanup?(): void;
};

type CanvasLike = {
  getContext(type: "2d"): unknown;
  toBuffer?: (mimeType?: string) => Buffer | Promise<Buffer>;
  encode?: (mimeType: string) => Buffer | Promise<Buffer>;
};

type CanvasModuleLike = {
  createCanvas(width: number, height: number): unknown;
  DOMMatrix?: unknown;
  ImageData?: unknown;
  Path2D?: unknown;
};

let pdfjsPromise: Promise<LoadedPdfJs> | null = null;

export class PdfPasswordError extends Error {
  constructor(message = "PDF is encrypted or password-protected") {
    super(message);
    this.name = "PdfPasswordError";
  }
}

export async function extractWithPdfjs(
  data: Uint8Array,
  options: {
    pages?: string | number[] | { from?: number; to?: number };
    maxPages?: number;
    preserveLayout: boolean;
  }
): Promise<ExtractedPdf> {
  const doc = await loadDocument(data);
  try {
    const selectedPages = selectPages(options.pages, doc.numPages, options.maxPages);
    const document = await documentInfo(doc);
    const pages: ExtractedPdfPage[] = [];
    for (const pageNumber of selectedPages) {
      const page = await doc.getPage(pageNumber);
      pages.push(await extractPage(page, pageNumber, options.preserveLayout));
      page.cleanup?.();
    }
    return { document, pages };
  } finally {
    await disposeDocument(doc);
  }
}

export async function probeWithPdfjs(data: Uint8Array): Promise<ExtractedPdfDocument> {
  const doc = await loadDocument(data);
  try {
    return await documentInfo(doc);
  } finally {
    await disposeDocument(doc);
  }
}

export async function renderPageWithPdfjs(
  data: Uint8Array,
  pageNumber: number,
  scale: number,
  artifactStore: ArtifactStore
): Promise<PdfRenderedPage> {
  const canvasMod = await loadCanvasModule();
  const doc = await loadDocument(data);
  try {
    if (pageNumber < 1 || pageNumber > doc.numPages) {
      throw new Error(`pdf-ingest: page ${pageNumber} is outside 1-${doc.numPages}`);
    }
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = canvasMod.createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height)
    ) as CanvasLike;
    const context = canvas.getContext("2d");
    await page.render({ canvasContext: context, viewport, canvas }).promise;
    const buffer = await canvasToPng(canvas);
    const dataOut = new Uint8Array(buffer);
    const stored = await artifactStore.put(dataOut, "image/png");
    page.cleanup?.();
    return {
      pageNumber,
      width: Math.ceil(viewport.width),
      height: Math.ceil(viewport.height),
      scale,
      mimeType: "image/png",
      data: dataOut,
      digest: stored.digest,
      artifactId: stored.artifactId,
    };
  } finally {
    await disposeDocument(doc);
  }
}

export async function pdfjsEngineStatus(): Promise<PdfEngineStatus[]> {
  const statuses: PdfEngineStatus[] = [];
  try {
    const pdfjs = await loadPdfjs();
    statuses.push({
      id: "pdfjs",
      label: "PDF.js",
      available: true,
      bundled: true,
      role: "text",
      version: pdfjs.module.version,
      detail: `Embedded text, metadata, and geometry extraction (${pdfjs.packageName})`,
    });
  } catch (error) {
    statuses.push({
      id: "pdfjs",
      label: "PDF.js",
      available: false,
      bundled: true,
      role: "text",
      detail: errorMessage(error),
    });
  }

  try {
    await loadCanvasModule();
    statuses.push({
      id: "pdfjs",
      label: "PDF.js renderer",
      available: true,
      bundled: true,
      role: "render",
      detail: "Page rasterization through @napi-rs/canvas",
    });
  } catch (error) {
    statuses.push({
      id: "pdfjs",
      label: "PDF.js renderer",
      available: false,
      bundled: true,
      role: "render",
      detail: errorMessage(error),
    });
  }
  return statuses;
}

async function extractPage(
  page: PdfJsPage,
  pageNumber: number,
  preserveLayout: boolean
): Promise<ExtractedPdfPage> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent({
    includeMarkedContent: false,
    disableNormalization: false,
  });
  const textItems = content.items.filter(isPdfTextItem);
  const lines = groupTextItems(textItems, { width: viewport.width, height: viewport.height });
  const text = preserveLayout
    ? linesToLayoutText(lines)
    : textItems
        .map((item) => item.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
  return {
    pageNumber,
    width: viewport.width,
    height: viewport.height,
    rotation: page.rotate ?? 0,
    lines,
    text,
    markdown: linesToMarkdown(lines),
    textItemCount: textItems.length,
    warnings: textItems.length === 0 ? ["No embedded text items found on page"] : [],
  };
}

async function documentInfo(doc: PdfJsDocument): Promise<ExtractedPdfDocument> {
  const meta = await doc.getMetadata().catch(() => null);
  const metadata = sanitizeMetadata(meta?.info ?? {});
  const fingerprint = doc.fingerprints?.[0];
  return {
    pageCount: doc.numPages,
    fingerprint,
    encrypted: false,
    metadata,
  };
}

async function loadDocument(data: Uint8Array): Promise<PdfJsDocument> {
  const pdfjs = await loadPdfjs();
  const root = pdfjsDistRoot(pdfjs.packageName);
  const task = pdfjs.module.getDocument({
    data: new Uint8Array(data),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
    cMapUrl: directoryUrl(path.join(root, "cmaps")),
    cMapPacked: true,
    standardFontDataUrl: directoryUrl(path.join(root, "standard_fonts")),
  });
  try {
    return await task.promise;
  } catch (error) {
    if (isPasswordError(error)) throw new PdfPasswordError(errorMessage(error));
    throw error;
  }
}

async function loadPdfjs(): Promise<LoadedPdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      await ensureCanvasGlobals();
      const mod = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJsModule;
      return { module: mod, packageName: "pdfjs-dist" };
    })();
  }
  return pdfjsPromise;
}

async function ensureCanvasGlobals(): Promise<void> {
  const canvas = await loadCanvasModule().catch(() => null);
  if (!canvas) return;
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of ["DOMMatrix", "ImageData", "Path2D"] as const) {
    const value = canvas[key];
    if (value && !globals[key]) globals[key] = value;
  }
}

async function loadCanvasModule(): Promise<CanvasModuleLike> {
  const canvas = await import("@napi-rs/canvas");
  return normalizeCanvasModule(canvas);
}

function normalizeCanvasModule(value: unknown): CanvasModuleLike {
  const namespace = isRecord(value) ? value : null;
  const candidates = [
    namespace,
    namespace && isRecord(namespace["default"]) ? namespace["default"] : null,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate["createCanvas"] === "function") {
      return candidate as CanvasModuleLike;
    }
  }
  throw new Error("pdf-ingest: @napi-rs/canvas did not expose createCanvas");
}

async function canvasToPng(canvas: unknown): Promise<Buffer> {
  const value = canvas as {
    toBuffer?: (mimeType?: string) => Buffer | Promise<Buffer>;
    encode?: (mimeType: string) => Buffer | Promise<Buffer>;
  };
  if (typeof value.toBuffer === "function") {
    return Buffer.from(await value.toBuffer("image/png"));
  }
  if (typeof value.encode === "function") {
    return Buffer.from(await value.encode("image/png"));
  }
  throw new Error("pdf-ingest: canvas implementation cannot encode PNG");
}

function isPdfTextItem(item: unknown): item is PdfTextItem {
  return (
    typeof item === "object" &&
    item !== null &&
    typeof (item as { str?: unknown }).str === "string" &&
    Array.isArray((item as { transform?: unknown }).transform)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (
      raw === null ||
      typeof raw === "string" ||
      typeof raw === "number" ||
      typeof raw === "boolean"
    ) {
      output[key] = raw;
    } else if (raw instanceof Date) {
      output[key] = raw.toISOString();
    } else if (raw !== undefined) {
      output[key] = String(raw);
    }
  }
  return output;
}

function pdfjsDistRoot(packageName: LoadedPdfJs["packageName"]): string {
  return path.dirname(require.resolve(`${packageName}/package.json`));
}

function directoryUrl(dir: string): string {
  const url = pathToFileURL(dir).href;
  return url.endsWith("/") ? url : `${url}/`;
}

function isPasswordError(error: unknown): boolean {
  const err = error as { name?: unknown; code?: unknown; message?: unknown };
  return (
    err.name === "PasswordException" ||
    err.code === "PasswordException" ||
    /password|encrypted/i.test(String(err.message ?? ""))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function pdfDigest(data: Uint8Array): string {
  return sha256Hex(data);
}

async function disposeDocument(doc: PdfJsDocument): Promise<void> {
  if (typeof doc.destroy === "function") {
    await doc.destroy();
    return;
  }
  if (typeof doc.cleanup === "function") {
    await doc.cleanup();
  }
}
