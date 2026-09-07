---
name: pdf-ingestion
description: Extract text, layout, OCR, page images, metadata, or structure from local PDFs through @workspace-extensions/pdf-ingest.
---

# PDF Ingestion

Use `@workspace-extensions/pdf-ingest` for local PDF work. Do not assume
`pdftotext`, `pdfinfo`, Poppler, or Tesseract are installed on the host.
The extension brings bundled-capable dependencies and reports engine status.

## Fast Path

```ts
import { extensions } from "@workspace/runtime";

const pdf = extensions.use("@workspace-extensions/pdf-ingest");
const result = await pdf.ingest(toPdfExtensionBytes(fileBytes), {
  preserveLayout: true,
  ocrFallback: true,
  pageImages: "on-ocr",
  ocrLanguages: ["eng"],
});

function toPdfExtensionBytes(bytes: Uint8Array | ArrayBuffer | number[]) {
  const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return { __bin: true, data: Buffer.from(uint8).toString("base64") };
}
```

For workspace files inside the same runtime, reading with `fs.readFile(path)`
and passing the returned bytes directly is fine. For bytes returned by Drive,
tool calls, or another RPC boundary, use the base64 envelope above before
calling `pdf.ingest(...)`, `pdf.probe(...)`, or `pdf.renderPage(...)`.

## Engine Policy

- Use PDF.js embedded-text extraction first. It is local, bundled, Apache-2.0,
  and returns text items with geometry for line reconstruction.
- Use OCR fallback only for pages with sparse embedded text, or when the user
  explicitly asks for OCR. OCR is local through Tesseract.js with bundled English
  trained data.
- Treat Docling, vendored Poppler, and provider-native PDF paths as optional
  adapters. Check `await pdf.engines()` before relying on them.
- Do not use cloud OCR unless the user explicitly chooses that privacy/cost
  tradeoff.

## Structure-sensitive documents

For poetry, tables, or other layout-sensitive documents, start with:

```ts
{
  preserveLayout: true,
  ocrFallback: true,
  pageImages: "on-ocr"
}
```

Inspect `pages[].lines` and geometry rather than relying only on flattened text.
Use page warnings, confidence, and statistics to identify material that needs
review.

## Useful Calls

```ts
const pdfBytes = toPdfExtensionBytes(fileBytes);

await pdf.probe(pdfBytes, { pages: "1-3" });
await pdf.renderPage(pdfBytes, { pageNumber: 2, scale: 2 });
await pdf.readArtifact(page.imageArtifactId);
await pdf.engines({ ocrLanguages: ["eng"] });
```

`ingest` returns:

- `document`: digest, page count, metadata, encryption flag, scanned hint
- `pages`: page text, markdown, line boxes, extraction method, image artifact
  ids, warnings, and text/OCR stats
- `engines`: available bundled and optional engine diagnostics
- `warnings`: document-level fallback notes

## Failure Handling

- If `probe` reports `encrypted: true`, ask for a password-capable follow-up;
  the current extension does not accept passwords.
- If OCR language data is missing, the result includes warnings and engine
  diagnostics. Do not silently switch to a cloud provider.
- For long PDFs, pass `pages` or `maxPages` first, inspect quality, then ingest
  the rest in batches.
