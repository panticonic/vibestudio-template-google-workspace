import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { activate } from "./index.js";
import { createArtifactStoreFromStorage } from "./pdf/artifacts.js";
import { resolveTesseractModule } from "./pdf/ocr.js";
import type { PdfRenderedPage } from "./pdf/types.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vibestudio-pdf-ingest-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe("@workspace-extensions/pdf-ingest", () => {
  it("extracts embedded text with page geometry and stanza layout", async () => {
    const api = await testApi();
    const pdf = makePdf([
      "BT",
      "/F1 12 Tf",
      "36 150 Td (First line) Tj",
      "0 -18 Td (Second line) Tj",
      "0 -42 Td (New stanza) Tj",
      "ET",
    ]);

    const result = await api.ingest(pdf, {
      preserveLayout: true,
      ocrFallback: false,
      pageImages: "never",
    });

    expect(result.document.pageCount).toBe(1);
    expect(result.document.scannedHint).toBe(false);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.extractionMethod).toBe("embedded-text");
    expect(result.pages[0]?.text).toContain("First line\nSecond line\n\nNew stanza");
    expect(result.pages[0]?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "First line",
          source: "embedded-text",
          confidence: 1,
        }),
      ])
    );
    expect(result.pages[0]?.stats.embeddedTextChars).toBeGreaterThan(20);
  });

  it("renders page images and stores them as artifacts", async () => {
    const api = await testApi();
    const pdf = makePdf(["BT", "/F1 24 Tf", "36 120 Td (Render me) Tj", "ET"]);

    const rendered = await api.renderPage(pdf, { pageNumber: 1, scale: 1 });
    expect(rendered.mimeType).toBe("image/png");
    expect(rendered.data.subarray(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );

    const artifact = await api.readArtifact(rendered.artifactId);
    expect(artifact.digest).toBe(rendered.digest);
    expect(artifact.mimeType).toBe("image/png");
    expect(artifact.data.length).toBe(rendered.data.length);
  });

  it("runs OCR fallback through the engine boundary for sparse embedded text", async () => {
    const root = await makeTempRoot();
    const storage = storageFor(root);
    const api = await activate(testContext(storage), {
      artifactStore: createArtifactStoreFromStorage(storage),
      recognizePage: async (image: PdfRenderedPage) => ({
        text: "OCR recovered line",
        lines: [
          {
            text: "OCR recovered line",
            bbox: [0, 0, image.width / image.scale, 20],
            confidence: 0.94,
            source: "ocr",
          },
        ],
        confidence: 0.94,
        warnings: [],
      }),
      engineStatus: async () => [],
    });
    const pdf = makePdf(["BT", "/F1 12 Tf", "36 120 Td (x) Tj", "ET"]);

    const result = await api.ingest(pdf, {
      ocrFallback: true,
      minEmbeddedCharsForOcr: 5,
      pageImages: "on-ocr",
    });

    expect(result.pages[0]?.extractionMethod).toBe("mixed");
    expect(result.pages[0]?.text).toBe("OCR recovered line");
    expect(result.pages[0]?.lines[0]).toMatchObject({
      text: "OCR recovered line",
      confidence: 0.94,
      source: "ocr",
    });
    expect(result.pages[0]?.imageArtifactId).toMatch(/^pdf-artifact:png:/);
  });

  it("probes PDF metadata and selected page ranges", async () => {
    const api = await testApi();
    const pdf = makePdf(["BT", "/F1 12 Tf", "36 120 Td (Probe) Tj", "ET"]);

    const result = await api.probe(pdf, { pages: "1" });

    expect(result.document.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.document.pageCount).toBe(1);
    expect(result.selectedPages).toEqual([1]);
  });

  it("accepts extension-RPC serialized PDF byte payloads", async () => {
    const api = await testApi();
    const pdf = makePdf(["BT", "/F1 12 Tf", "36 120 Td (Serialized) Tj", "ET"]);
    const numericRecord = JSON.parse(JSON.stringify(pdf));
    const base64Envelope = { __bin: true, data: Buffer.from(pdf).toString("base64") };

    const fromNumericRecord = await api.probe(numericRecord, { pages: "1" });
    const fromBytesWrapper = await api.probe({ bytes: numericRecord }, { pages: "1" });
    const fromEnvelope = await api.probe(base64Envelope, { pages: "1" });

    expect(fromNumericRecord.document.pageCount).toBe(1);
    expect(fromBytesWrapper.document.pageCount).toBe(1);
    expect(fromEnvelope.document.pageCount).toBe(1);
  });

  it("reports bundled and optional engines separately", async () => {
    const api = await testApi();
    const engines = await api.engines();

    expect(engines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "pdfjs", available: true, bundled: true }),
        expect.objectContaining({ id: "tesseract-ocr", bundled: true }),
        expect.objectContaining({ id: "docling-sidecar", bundled: false }),
        expect.objectContaining({ id: "poppler-vendor", bundled: false }),
      ])
    );
  });

  it("accepts both direct and default-wrapped Tesseract module shapes", () => {
    const createWorker = vi.fn();

    expect(resolveTesseractModule({ createWorker }).createWorker).toBe(createWorker);
    expect(resolveTesseractModule({ default: { createWorker } }).createWorker).toBe(createWorker);
  });
});

async function testApi() {
  const root = await makeTempRoot();
  const storage = storageFor(root);
  return activate(testContext(storage), {
    artifactStore: createArtifactStoreFromStorage(storage),
  });
}

function testContext(storage: ReturnType<typeof storageFor>) {
  return {
    storage,
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    health: {
      report: vi.fn(),
      healthy: vi.fn(),
      degraded: vi.fn(),
      unhealthy: vi.fn(),
    },
  };
}

function storageFor(root: string) {
  return {
    mkdir: (filePath: string, opts?: { recursive?: boolean }) =>
      fs.mkdir(path.join(root, filePath), { recursive: opts?.recursive ?? true }),
    readFile: (filePath: string, encoding?: BufferEncoding) =>
      encoding === undefined
        ? fs.readFile(path.join(root, filePath))
        : fs.readFile(path.join(root, filePath), encoding),
    writeFile: async (filePath: string, data: string | Uint8Array) => {
      await fs.mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
      await fs.writeFile(path.join(root, filePath), data);
    },
  };
}

function makePdf(contentLines: string[]): Uint8Array {
  const content = `${contentLines.join("\n")}\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    [
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200]",
      "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    ].join(" "),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += [
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ].join("\n");
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}
