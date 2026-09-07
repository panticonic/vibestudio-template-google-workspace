import type { ExtensionContext } from "@vibestudio/extension";
import { assertPdfBytes, toUint8Array } from "./pdf/binary.js";
import { createArtifactStoreFromStorage, type ArtifactStore } from "./pdf/artifacts.js";
import { normalizePageImageMode, selectPages } from "./pdf/pages.js";
import {
  extractWithPdfjs,
  pdfDigest,
  pdfjsEngineStatus,
  PdfPasswordError,
  probeWithPdfjs,
  renderPageWithPdfjs,
} from "./pdf/pdfjsEngine.js";
import { recognizePageWithTesseract, tesseractEngineStatus } from "./pdf/ocr.js";
import type {
  PdfArtifact,
  PdfEngineStatus,
  PdfIngestOptions,
  PdfIngestResult,
  PdfLine,
  PdfProbeOptions,
  PdfProbeResult,
  PdfRenderedPage,
  PdfRenderPageOptions,
  OcrPageResult,
} from "./pdf/types.js";

type ExtensionContextLike = {
  storage: {
    mkdir(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
    readFile(path: string, encoding?: BufferEncoding): Promise<string | Buffer>;
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
  };
  log: Pick<ExtensionContext["log"], "info">;
  health: Pick<ExtensionContext["health"], "healthy" | "degraded">;
};

interface PdfIngestDeps {
  artifactStore?: ArtifactStore;
  recognizePage?: (image: PdfRenderedPage, languages: string[]) => Promise<OcrPageResult>;
  engineStatus?: (languages?: string[]) => Promise<PdfEngineStatus[]>;
}

const DEFAULT_MIN_EMBEDDED_CHARS_FOR_OCR = 20;
const DEFAULT_RENDER_SCALE = 2;

/** Public API surface of this extension — the awaited return of {@link activate}. */
export type Api = Awaited<ReturnType<typeof activate>>;
declare module "@vibestudio/extension" {
  interface WorkspaceExtensions {
    "@workspace-extensions/pdf-ingest": Api;
  }
}

export async function activate(ctx: ExtensionContextLike, deps: PdfIngestDeps = {}) {
  ctx.log.info("pdf-ingest extension activating");
  const artifactStore = deps.artifactStore ?? createArtifactStoreFromStorage(ctx.storage);
  const recognizePage = deps.recognizePage ?? recognizePageWithTesseract;
  const engineStatus = deps.engineStatus ?? defaultEngineStatus;

  const api = {
    async engines(options?: { ocrLanguages?: string[] }) {
      return engineStatus(options?.ocrLanguages);
    },

    async probe(rawData: unknown, options: PdfProbeOptions = {}): Promise<PdfProbeResult> {
      const data = normalizePdfInput(rawData);
      const digest = pdfDigest(data);
      const warnings: string[] = [];
      try {
        const document = await probeWithPdfjs(data);
        const selectedPages = selectPages(options.pages, document.pageCount);
        return {
          document: {
            digest,
            ...document,
            scannedHint: false,
          },
          selectedPages,
          engines: await engineStatus(),
          warnings,
        };
      } catch (error) {
        if (error instanceof PdfPasswordError) {
          warnings.push(error.message);
          return {
            document: {
              digest,
              pageCount: 0,
              encrypted: true,
              metadata: {},
              scannedHint: false,
            },
            selectedPages: [],
            engines: await engineStatus(),
            warnings,
          };
        }
        throw error;
      }
    },

    async ingest(rawData: unknown, options: PdfIngestOptions = {}): Promise<PdfIngestResult> {
      const data = normalizePdfInput(rawData);
      const digest = pdfDigest(data);
      const preserveLayout = options.preserveLayout ?? true;
      const extractText = options.extractText ?? true;
      const imageMode = normalizePageImageMode(options.pageImages);
      const renderScale = positiveNumber(options.renderScale, DEFAULT_RENDER_SCALE);
      const ocrLanguages = options.ocrLanguages?.length ? options.ocrLanguages : ["eng"];
      const minEmbeddedChars = Math.max(
        0,
        Math.trunc(options.minEmbeddedCharsForOcr ?? DEFAULT_MIN_EMBEDDED_CHARS_FOR_OCR)
      );
      const warnings: string[] = [];

      if (options.engine === "docling") {
        const status = doclingStatus();
        if (!status.available) {
          warnings.push("Docling sidecar requested but not configured; falling back to PDF.js.");
        }
      }

      const extracted = await extractWithPdfjs(data, {
        pages: options.pages,
        maxPages: options.maxPages,
        preserveLayout,
      });
      const selectedPages = extractText
        ? extracted.pages
        : extracted.pages.map((page) => ({
            ...page,
            text: "",
            markdown: "",
            lines: [],
          }));

      const pages = [];
      let scannedPages = 0;
      for (const embeddedPage of selectedPages) {
        const embeddedChars = countMeaningfulChars(embeddedPage.text);
        const needsOcr =
          options.engine === "ocr-only" ||
          Boolean(options.ocrFallback) ||
          embeddedChars < minEmbeddedChars;
        const shouldRunOcr =
          options.engine === "ocr-only" ||
          (Boolean(options.ocrFallback) && embeddedChars < minEmbeddedChars);
        if (embeddedChars < minEmbeddedChars) scannedPages++;

        let rendered: PdfRenderedPage | null = null;
        const pageWarnings = [...embeddedPage.warnings];
        const shouldRenderImage =
          imageMode === "always" || (imageMode === "on-ocr" && needsOcr) || shouldRunOcr;

        if (shouldRenderImage) {
          try {
            rendered = await renderPageWithPdfjs(
              data,
              embeddedPage.pageNumber,
              renderScale,
              artifactStore
            );
          } catch (error) {
            pageWarnings.push(`Failed to render page image: ${errorMessage(error)}`);
          }
        }

        let text = embeddedPage.text;
        let markdown = embeddedPage.markdown;
        let lines: PdfLine[] = embeddedPage.lines;
        let extractionMethod: "embedded-text" | "ocr" | "mixed" | "none" =
          embeddedChars > 0 ? "embedded-text" : "none";
        let ocrTextChars = 0;

        if (shouldRunOcr) {
          if (!rendered) {
            pageWarnings.push("OCR requested but page image rendering was unavailable.");
          } else {
            const ocr = await recognizePage(rendered, ocrLanguages);
            pageWarnings.push(...ocr.warnings);
            ocrTextChars = countMeaningfulChars(ocr.text);
            if (ocrTextChars > 0 || options.engine === "ocr-only") {
              text = ocr.text;
              markdown = ocr.text;
              lines = ocr.lines;
              extractionMethod = embeddedChars > 0 && ocrTextChars > 0 ? "mixed" : "ocr";
            }
          }
        }

        pages.push({
          pageNumber: embeddedPage.pageNumber,
          width: embeddedPage.width,
          height: embeddedPage.height,
          rotation: embeddedPage.rotation,
          text,
          markdown,
          lines,
          extractionMethod,
          ...(rendered
            ? { imageDigest: rendered.digest, imageArtifactId: rendered.artifactId }
            : {}),
          warnings: pageWarnings,
          stats: {
            embeddedTextChars: embeddedChars,
            ocrTextChars,
            textItemCount: embeddedPage.textItemCount,
          },
        });
      }

      const scannedHint = pages.length > 0 && scannedPages / pages.length >= 0.5;
      const engines = await engineStatus(ocrLanguages);
      return {
        document: {
          digest,
          ...extracted.document,
          scannedHint,
        },
        pages,
        engines,
        warnings,
      };
    },

    async renderPage(
      rawData: unknown,
      options: PdfRenderPageOptions = {}
    ): Promise<PdfRenderedPage> {
      const data = normalizePdfInput(rawData);
      if (options.mimeType && options.mimeType !== "image/png") {
        throw new Error(`pdf-ingest.renderPage only supports image/png, got ${options.mimeType}`);
      }
      return renderPageWithPdfjs(
        data,
        Math.max(1, Math.trunc(options.pageNumber ?? 1)),
        positiveNumber(options.scale, DEFAULT_RENDER_SCALE),
        artifactStore
      );
    },

    async readArtifact(artifactId: string): Promise<PdfArtifact> {
      return artifactStore.get(artifactId);
    },
  };

  const initialEngines = await engineStatus().catch((error) => [
    {
      id: "pdfjs" as const,
      label: "PDF.js",
      available: false,
      bundled: true,
      role: "text" as const,
      detail: errorMessage(error),
    },
  ]);
  const unavailable = initialEngines.filter(
    (engine) => !engine.available && (engine.id === "pdfjs" || engine.id === "tesseract-ocr")
  );
  if (unavailable.length > 0) {
    ctx.health.degraded({
      summary: "PDF ingest activated with degraded engines",
      reasons: unavailable.map((engine) => `${engine.label}: ${engine.detail ?? "unavailable"}`),
    });
  } else {
    ctx.health.healthy({ summary: "PDF ingest extension activated" });
  }

  return api;
}

async function defaultEngineStatus(languages = ["eng"]): Promise<PdfEngineStatus[]> {
  return [
    ...(await pdfjsEngineStatus()),
    await tesseractEngineStatus(languages),
    doclingStatus(),
    popplerVendorStatus(),
    providerNativeStatus(),
  ];
}

function doclingStatus(): PdfEngineStatus {
  const command = process.env["VIBESTUDIO_PDF_DOCLING_CMD"];
  return {
    id: "docling-sidecar",
    label: "Docling sidecar",
    available: Boolean(command),
    bundled: false,
    role: "layout",
    detail: command
      ? `Configured via VIBESTUDIO_PDF_DOCLING_CMD=${command}`
      : "Optional adapter hook; no sidecar command configured",
  };
}

function popplerVendorStatus(): PdfEngineStatus {
  return {
    id: "poppler-vendor",
    label: "Vendored Poppler",
    available: false,
    bundled: false,
    role: "text",
    detail: "Adapter slot reserved; default stack avoids GPL Poppler binaries",
  };
}

function providerNativeStatus(): PdfEngineStatus {
  return {
    id: "provider-native",
    label: "Provider-native PDF input",
    available: false,
    bundled: false,
    role: "provider",
    detail:
      "Use upstream model APIs directly when a workflow chooses Anthropic/Google native PDF handling",
  };
}

function normalizePdfInput(rawData: unknown): Uint8Array {
  const data = toUint8Array(rawData);
  assertPdfBytes(data);
  return data;
}

function countMeaningfulChars(text: string): number {
  return text.replace(/\s/g, "").length;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
