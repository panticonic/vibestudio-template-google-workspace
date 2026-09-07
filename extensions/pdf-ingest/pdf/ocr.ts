import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PdfEngineStatus, PdfLine, PdfRenderedPage, OcrPageResult } from "./types.js";

const require = createRequire(import.meta.url);

type TesseractModule = {
  createWorker: (...args: unknown[]) => Promise<TesseractWorker>;
  version?: string;
};

type TesseractImport = Partial<TesseractModule> & {
  default?: Partial<TesseractModule>;
};

type TesseractWorker = {
  recognize(image: Buffer | Uint8Array): Promise<{ data?: TesseractData }>;
  terminate(): Promise<void>;
};

interface TesseractData {
  text?: string;
  confidence?: number;
  lines?: Array<{
    text?: string;
    confidence?: number;
    bbox?: { x0?: number; y0?: number; x1?: number; y1?: number };
  }>;
}

export async function recognizePageWithTesseract(
  image: PdfRenderedPage,
  languages: string[]
): Promise<OcrPageResult> {
  const langPath = await bundledLanguageDataPath(languages);
  if (!langPath) {
    return {
      text: "",
      lines: [],
      confidence: null,
      warnings: [
        `Tesseract language data is not bundled for ${languages.join("+")}. ` +
          "Install a @tesseract.js-data/* package or configure another OCR engine.",
      ],
    };
  }

  const tesseract = resolveTesseractModule(await import("tesseract.js"));
  const worker = await tesseract.createWorker(languages.join("+"), 1, {
    langPath,
    cacheMethod: "readOnly",
    gzip: true,
    logger: undefined,
  });
  try {
    const result = await worker.recognize(Buffer.from(image.data));
    const data = result.data ?? {};
    const text = typeof data.text === "string" ? data.text.trimEnd() : "";
    const lines = tesseractLinesToPdfLines(data, image);
    return {
      text,
      lines: lines.length > 0 ? lines : plainTextToLines(text, image),
      confidence: normalizeConfidence(data.confidence),
      warnings: text ? [] : ["Tesseract OCR returned no text"],
    };
  } finally {
    await worker.terminate();
  }
}

export async function tesseractEngineStatus(languages = ["eng"]): Promise<PdfEngineStatus> {
  try {
    const tesseract = resolveTesseractModule(await import("tesseract.js"));
    const langPath = await bundledLanguageDataPath(languages);
    return {
      id: "tesseract-ocr",
      label: "Tesseract.js OCR",
      available: Boolean(langPath),
      bundled: true,
      role: "ocr",
      version: tesseract.version,
      detail: langPath
        ? `Local language data found at ${langPath}`
        : `Missing bundled language data for ${languages.join("+")}`,
    };
  } catch (error) {
    return {
      id: "tesseract-ocr",
      label: "Tesseract.js OCR",
      available: false,
      bundled: true,
      role: "ocr",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resolveTesseractModule(raw: unknown): TesseractModule {
  const mod = raw && typeof raw === "object" ? (raw as TesseractImport) : {};
  const candidate =
    typeof mod.createWorker === "function"
      ? mod
      : typeof mod.default?.createWorker === "function"
        ? mod.default
        : null;

  if (!candidate) {
    throw new Error("tesseract.js did not expose createWorker");
  }

  return candidate as TesseractModule;
}

async function bundledLanguageDataPath(languages: string[]): Promise<string | null> {
  const unique = [...new Set(languages.map((lang) => lang.trim()).filter(Boolean))];
  if (unique.length === 0) return null;
  const paths = await Promise.all(unique.map((lang) => bundledLanguageDir(lang)));
  if (paths.some((entry) => entry === null)) return null;
  return paths[0] ?? null;
}

async function bundledLanguageDir(language: string): Promise<string | null> {
  if (language !== "eng") return null;
  let packageRoot: string;
  try {
    packageRoot = path.dirname(require.resolve("@tesseract.js-data/eng/package.json"));
  } catch {
    return null;
  }
  const file = await findFile(packageRoot, "eng.traineddata.gz");
  if (file) return path.dirname(file);
  const rawFile = await findFile(packageRoot, "eng.traineddata");
  return rawFile ? path.dirname(rawFile) : null;
}

async function findFile(root: string, fileName: string): Promise<string | null> {
  let entries: Array<{ name: string; path: string; isDirectory: boolean }>;
  try {
    entries = (await fs.readdir(root, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      path: path.join(root, entry.name),
      isDirectory: entry.isDirectory(),
    }));
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.name === fileName) return entry.path;
  }
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const found = await findFile(entry.path, fileName);
    if (found) return found;
  }
  return null;
}

function tesseractLinesToPdfLines(data: TesseractData, image: PdfRenderedPage): PdfLine[] {
  if (!Array.isArray(data.lines)) return [];
  return data.lines
    .map((line): PdfLine | null => {
      const text = (line.text ?? "").trimEnd();
      const bbox = line.bbox;
      if (!text || !bbox) return null;
      const x0 = Number(bbox.x0 ?? 0);
      const y0 = Number(bbox.y0 ?? 0);
      const x1 = Number(bbox.x1 ?? x0);
      const y1 = Number(bbox.y1 ?? y0);
      return {
        text,
        bbox: [
          round(x0 / image.scale),
          round(y0 / image.scale),
          round(Math.max(0, x1 - x0) / image.scale),
          round(Math.max(0, y1 - y0) / image.scale),
        ],
        confidence: normalizeConfidence(line.confidence),
        source: "ocr",
      };
    })
    .filter((line): line is PdfLine => line !== null);
}

function plainTextToLines(text: string, image: PdfRenderedPage): PdfLine[] {
  const rows = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const lineHeight = Math.max(10, image.height / Math.max(1, rows.length) / image.scale);
  return rows.map((line, index) => ({
    text: line,
    bbox: [0, round(index * lineHeight), round(image.width / image.scale), round(lineHeight)],
    confidence: null,
    source: "ocr",
  }));
}

function normalizeConfidence(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value > 1 ? Math.max(0, Math.min(1, value / 100)) : Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
