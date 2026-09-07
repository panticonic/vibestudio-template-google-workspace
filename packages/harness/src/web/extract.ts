import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const DEFAULT_EXTRACTION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_HTML_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TEXT_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_PDF_BYTES = 25 * 1024 * 1024;
const utf8Decoder = new TextDecoder();

export interface ExtractedPage {
  title: string;
  markdown: string;
  url: string;
  /** Source content-type after sniffing. "html" | "pdf" | "text" | "markdown". */
  contentType: "html" | "pdf" | "text" | "markdown";
}

export interface ExtractFetcher {
  (url: string, init: RequestInit): Promise<{
    ok: boolean;
    status: number;
    url?: string;
    headers: { get(name: string): string | null };
    body?: ReadableStream<Uint8Array> | null;
    text: () => Promise<string>;
    arrayBuffer: () => Promise<ArrayBuffer>;
  }>;
}

export interface ExtractPageOptions {
  timeoutMs?: number;
  maxHtmlBytes?: number;
  maxMarkdownBytes?: number;
  maxPdfBytes?: number;
  maxTextBytes?: number;
}

export async function extractPage(
  url: string,
  fetcher: ExtractFetcher = fetch as unknown as ExtractFetcher,
  signal?: AbortSignal,
  options: ExtractPageOptions = {},
): Promise<ExtractedPage> {
  const guard = createExtractionGuard(signal, options.timeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS);
  try {
    const res = await fetcher(url, {
      method: "GET",
      signal: guard.signal,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    } as RequestInit);
    throwIfAborted(guard.signal);
    if (!res.ok) {
      throw new Error(`Fetch ${url} returned HTTP ${res.status}`);
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const finalUrl = res.url ?? url;
    const looksLikePdf =
      contentType.includes("application/pdf") || /\.pdf(?:$|[?#])/iu.test(finalUrl);

    if (looksLikePdf) {
      const bytes = await readResponseBytes(
        res,
        options.maxPdfBytes ?? DEFAULT_MAX_PDF_BYTES,
        guard.signal,
        "PDF",
      );
      return await pdfToMarkdown(bytes, finalUrl, guard.signal);
    }
    if (contentType.includes("text/markdown") || contentType.includes("text/x-markdown")) {
      const text = await readResponseText(
        res,
        options.maxMarkdownBytes ?? DEFAULT_MAX_MARKDOWN_BYTES,
        guard.signal,
        "markdown",
      );
      return {
        title: deriveTitleFromUrl(finalUrl),
        markdown: text,
        url: finalUrl,
        contentType: "markdown",
      };
    }
    if (contentType.includes("text/plain") || contentType === "") {
      const text = await readResponseText(
        res,
        options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES,
        guard.signal,
        "text",
      );
      // If the body sniffs as HTML, fall through to HTML parsing.
      if (/^\s*<!doctype html|<html[\s>]/iu.test(text)) {
        return htmlToReadableMarkdown(text, finalUrl, guard.signal);
      }
      return {
        title: deriveTitleFromUrl(finalUrl),
        markdown: text,
        url: finalUrl,
        contentType: "text",
      };
    }
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      throw new Error(`Unsupported content-type for web_fetch: ${contentType || "unknown"}`);
    }

    const html = await readResponseText(
      res,
      options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES,
      guard.signal,
      "HTML",
    );
    return htmlToReadableMarkdown(html, finalUrl, guard.signal);
  } finally {
    guard.cleanup();
  }
}

async function pdfToMarkdown(
  bytes: Uint8Array,
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<ExtractedPage> {
  // Lazy-import so panel-side subpath consumers don't pay the pdf.js cost.
  throwIfAborted(signal);
  const { extractText, getDocumentProxy, getMeta } = await abortable(import("unpdf"), signal);
  throwIfAborted(signal);
  const doc = await abortable(getDocumentProxy(bytes), signal);
  throwIfAborted(signal);
  const [{ text: pages }, meta] = await abortable(Promise.all([
    extractText(doc, { mergePages: false }),
    getMeta(doc).catch(() => ({ info: {} as Record<string, unknown> })),
  ]), signal);
  throwIfAborted(signal);

  const info = (meta as { info?: Record<string, unknown> }).info ?? {};
  const title =
    (typeof info["Title"] === "string" && info["Title"].trim()) ||
    deriveTitleFromUrl(sourceUrl);

  const parts: string[] = [];
  parts.push(`# ${title}`);
  parts.push("");
  const author = typeof info["Author"] === "string" ? info["Author"].trim() : "";
  if (author) parts.push(`_Author: ${author}_`);
  parts.push(`_Source: ${sourceUrl}_  _Pages: ${pages.length}_`);
  parts.push("");

  const pageTexts = Array.isArray(pages) ? pages : [String(pages)];
  for (let i = 0; i < pageTexts.length; i++) {
    throwIfAborted(signal);
    parts.push(`## Page ${i + 1}`);
    parts.push("");
    parts.push(normalizePdfPageText(pageTexts[i] ?? ""));
    parts.push("");
  }

  return { title, markdown: parts.join("\n"), url: sourceUrl, contentType: "pdf" };
}

async function readResponseText(
  res: { headers: { get(name: string): string | null }; body?: ReadableStream<Uint8Array> | null; arrayBuffer: () => Promise<ArrayBuffer> },
  maxBytes: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<string> {
  return utf8Decoder.decode(await readResponseBytes(res, maxBytes, signal, label));
}

async function readResponseBytes(
  res: { headers: { get(name: string): string | null }; body?: ReadableStream<Uint8Array> | null; arrayBuffer: () => Promise<ArrayBuffer> },
  maxBytes: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<Uint8Array> {
  assertContentLengthWithinLimit(res.headers, maxBytes, label);
  throwIfAborted(signal);
  if (res.body) {
    return readStreamBytes(res.body, maxBytes, signal, label);
  }
  const buf = await abortable(res.arrayBuffer(), signal);
  const bytes = new Uint8Array(buf);
  assertByteLengthWithinLimit(bytes.byteLength, maxBytes, label);
  throwIfAborted(signal);
  return bytes;
}

async function readStreamBytes(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        assertByteLengthWithinLimit(total, maxBytes, label);
      }
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel(err).catch(() => undefined);
    throw err;
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function assertContentLengthWithinLimit(
  headers: { get(name: string): string | null },
  maxBytes: number,
  label: string,
): void {
  const raw = headers.get("content-length");
  if (!raw || !/^\d+$/u.test(raw.trim())) return;
  assertByteLengthWithinLimit(Number(raw), maxBytes, label);
}

function assertByteLengthWithinLimit(byteLength: number, maxBytes: number, label: string): void {
  if (byteLength > maxBytes) {
    throw new Error(`web_fetch: ${label} response body exceeds ${maxBytes} byte limit`);
  }
}

function createExtractionGuard(
  outer: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abortOuter = () => controller.abort(outer?.reason ?? new Error("web_fetch extraction aborted"));
  if (outer?.aborted) {
    abortOuter();
  } else {
    outer?.addEventListener("abort", abortOuter, { once: true });
  }
  const timeout = timeoutMs > 0
    ? setTimeout(() => {
      controller.abort(new Error(`web_fetch extraction timed out after ${timeoutMs}ms`));
    }, timeoutMs)
    : undefined;
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeout) clearTimeout(timeout);
      outer?.removeEventListener("abort", abortOuter);
    },
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let cleanup = () => {};
    const onAbort = () => {
      cleanup();
      reject(createAbortError(signal));
    };
    cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

function createAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(typeof signal.reason === "string" ? signal.reason : "web_fetch extraction aborted");
}

function normalizePdfPageText(s: string): string {
  return s
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function htmlToReadableMarkdown(
  html: string,
  sourceUrl: string,
  signal?: AbortSignal,
): ExtractedPage {
  throwIfAborted(signal);
  const { document } = parseHTML(html);
  throwIfAborted(signal);
  const docTitle = (document.querySelector("title")?.textContent ?? "").trim();

  let title = docTitle || deriveTitleFromUrl(sourceUrl);
  let contentHtml: string | null = null;

  try {
    const article = new Readability(document as unknown as Document, {
      charThreshold: 200,
    }).parse();
    if (article?.content) {
      contentHtml = article.content;
      if (article.title) title = article.title;
    }
  } catch {
    // Readability can throw on unusual documents; fall back to <body>.
  }
  throwIfAborted(signal);

  if (!contentHtml) {
    contentHtml = document.body?.innerHTML ?? "";
  }

  const { document: contentDoc } = parseHTML(`<div>${contentHtml}</div>`);
  throwIfAborted(signal);
  const root = contentDoc.querySelector("div");
  const md = root ? domToMarkdown(root as unknown as Element, signal).trim() : "";
  return { title, markdown: md, url: sourceUrl, contentType: "html" };
}

function deriveTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
}

const BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE", "NAV",
  "FIGURE", "FIGCAPTION", "TABLE", "TR", "FORM",
]);
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "SVG"]);

function domToMarkdown(node: Element, signal?: AbortSignal): string {
  const out: string[] = [];
  walk(node, out, { listDepth: 0, ordered: false, signal, visited: 0 });
  return out.join("").replace(/\n{3,}/gu, "\n\n");
}

interface WalkContext {
  listDepth: number;
  ordered: boolean;
  signal?: AbortSignal;
  visited: number;
}

function walk(node: Node, out: string[], ctx: WalkContext): void {
  ctx.visited++;
  if (ctx.visited % 200 === 0) throwIfAborted(ctx.signal);
  if (node.nodeType === 3 /* TEXT_NODE */) {
    out.push(normalizeText((node as Text).data));
    return;
  }
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
  const el = node as Element;
  const tag = el.tagName?.toUpperCase() ?? "";
  if (SKIP_TAGS.has(tag)) return;

  switch (tag) {
    case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": {
      const level = Number(tag.slice(1));
      out.push(`\n\n${"#".repeat(level)} `);
      walkChildren(el, out, ctx);
      out.push("\n\n");
      return;
    }
    case "BR":
      out.push("\n");
      return;
    case "HR":
      out.push("\n\n---\n\n");
      return;
    case "STRONG": case "B":
      out.push("**");
      walkChildren(el, out, ctx);
      out.push("**");
      return;
    case "EM": case "I":
      out.push("*");
      walkChildren(el, out, ctx);
      out.push("*");
      return;
    case "CODE":
      if (el.closest && el.closest("pre")) {
        walkChildren(el, out, ctx);
      } else {
        out.push("`");
        walkChildren(el, out, ctx);
        out.push("`");
      }
      return;
    case "PRE": {
      out.push("\n\n```\n");
      out.push((el.textContent ?? "").replace(/\n+$/u, ""));
      out.push("\n```\n\n");
      return;
    }
    case "BLOCKQUOTE": {
      const inner: string[] = [];
      walkChildren(el, inner, ctx);
      const quoted = inner.join("").trim().split("\n").map((line) => `> ${line}`).join("\n");
      out.push("\n\n" + quoted + "\n\n");
      return;
    }
    case "A": {
      const href = el.getAttribute("href") ?? "";
      const inner: string[] = [];
      walkChildren(el, inner, ctx);
      const text = inner.join("").trim();
      if (href && text) {
        out.push(`[${text}](${href})`);
      } else if (text) {
        out.push(text);
      }
      return;
    }
    case "UL": case "OL": {
      out.push("\n");
      const childCtx: WalkContext = {
        listDepth: ctx.listDepth + 1,
        ordered: tag === "OL",
        signal: ctx.signal,
        visited: ctx.visited,
      };
      let idx = 1;
      for (const child of Array.from(el.children)) {
        if (child.tagName?.toUpperCase() !== "LI") continue;
        const prefix = childCtx.ordered ? `${idx}. ` : "- ";
        out.push("  ".repeat(Math.max(0, childCtx.listDepth - 1)) + prefix);
        const liOut: string[] = [];
        walkChildren(child, liOut, childCtx);
        out.push(liOut.join("").trim() + "\n");
        idx++;
      }
      ctx.visited = childCtx.visited;
      out.push("\n");
      return;
    }
    case "IMG": {
      const alt = el.getAttribute("alt") ?? "";
      const src = el.getAttribute("src") ?? "";
      if (src) out.push(`![${alt}](${src})`);
      return;
    }
  }

  if (BLOCK_TAGS.has(tag)) {
    out.push("\n");
    walkChildren(el, out, ctx);
    out.push("\n");
    return;
  }

  walkChildren(el, out, ctx);
}

function walkChildren(el: Element, out: string[], ctx: WalkContext): void {
  for (const child of Array.from(el.childNodes)) {
    walk(child, out, ctx);
  }
}

function normalizeText(s: string): string {
  return s.replace(/[\t\f\v]+/gu, " ").replace(/ {2,}/gu, " ").replace(/\n{3,}/gu, "\n\n");
}
