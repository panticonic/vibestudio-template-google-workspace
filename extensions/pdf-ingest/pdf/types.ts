export type PdfEngineId =
  | "pdfjs"
  | "tesseract-ocr"
  | "docling-sidecar"
  | "poppler-vendor"
  | "provider-native";

export type PdfExtractionSource = "embedded-text" | "ocr";

export type PdfPageImageMode = "never" | "always" | "on-ocr" | "on-request";

export interface PdfIngestOptions {
  extractText?: boolean;
  ocrFallback?: boolean;
  preserveLayout?: boolean;
  pageImages?: boolean | PdfPageImageMode;
  pages?: string | number[] | { from?: number; to?: number };
  maxPages?: number;
  minEmbeddedCharsForOcr?: number;
  renderScale?: number;
  ocrLanguages?: string[];
  engine?: "auto" | "pdfjs" | "ocr-only" | "docling";
}

export interface PdfRenderPageOptions {
  pageNumber?: number;
  scale?: number;
  mimeType?: "image/png";
}

export interface PdfProbeOptions {
  pages?: string | number[] | { from?: number; to?: number };
}

export interface PdfLine {
  text: string;
  bbox: [number, number, number, number];
  confidence: number | null;
  source: PdfExtractionSource;
}

export interface PdfPageResult {
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
  text: string;
  markdown: string;
  lines: PdfLine[];
  extractionMethod: PdfExtractionSource | "mixed" | "none";
  imageDigest?: string;
  imageArtifactId?: string;
  warnings: string[];
  stats: {
    embeddedTextChars: number;
    ocrTextChars: number;
    textItemCount: number;
  };
}

export interface PdfDocumentInfo {
  digest: string;
  pageCount: number;
  fingerprint?: string;
  encrypted: boolean;
  metadata: Record<string, unknown>;
  scannedHint: boolean;
}

export interface PdfIngestResult {
  document: PdfDocumentInfo;
  pages: PdfPageResult[];
  engines: PdfEngineStatus[];
  warnings: string[];
}

export interface PdfProbeResult {
  document: PdfDocumentInfo;
  selectedPages: number[];
  engines: PdfEngineStatus[];
  warnings: string[];
}

export interface PdfRenderedPage {
  pageNumber: number;
  width: number;
  height: number;
  scale: number;
  mimeType: "image/png";
  data: Uint8Array;
  digest: string;
  artifactId: string;
}

export interface PdfArtifact {
  artifactId: string;
  digest: string;
  mimeType: string;
  data: Uint8Array;
}

export interface PdfEngineStatus {
  id: PdfEngineId;
  label: string;
  available: boolean;
  bundled: boolean;
  role: "text" | "render" | "ocr" | "layout" | "provider";
  version?: string;
  detail?: string;
}

export interface ExtractedPdfPage {
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
  lines: PdfLine[];
  text: string;
  markdown: string;
  textItemCount: number;
  warnings: string[];
}

export interface ExtractedPdfDocument {
  pageCount: number;
  fingerprint?: string;
  encrypted: boolean;
  metadata: Record<string, unknown>;
}

export interface ExtractedPdf {
  document: ExtractedPdfDocument;
  pages: ExtractedPdfPage[];
}

export interface OcrPageResult {
  text: string;
  lines: PdfLine[];
  confidence: number | null;
  warnings: string[];
}
