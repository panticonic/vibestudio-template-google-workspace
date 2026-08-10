/**
 * Multipart/mixed batch support for the Gmail REST API.
 *
 * Google's batch endpoint (`POST https://gmail.googleapis.com/batch/gmail/v1`)
 * accepts up to 100 inner HTTP requests per call; Google recommends staying at
 * or below 50, so `executeBatch` chunks at 50 and runs chunks sequentially to
 * respect per-user quota. The response is multipart/mixed with its OWN
 * boundary (different from the request boundary) and correlates parts via
 * `Content-ID: response-<id>`.
 */

export const GMAIL_BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1";
export const BATCH_CHUNK_SIZE = 50;

export interface BatchPart {
  /** Correlation id, echoed back as `Content-ID: response-<id>`. */
  id: string;
  method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  /** Absolute API path including the /gmail/v1 prefix, e.g. "/gmail/v1/users/me/threads/t1?format=metadata". */
  path: string;
  body?: unknown;
}

export interface BatchPartResult {
  id: string;
  status: number;
  ok: boolean;
  /** Parsed JSON body when present and parseable. */
  json?: unknown;
  bodyText: string;
}

export type BatchFetch = (url: string, init: RequestInit) => Promise<Response>;

function buildBatchBody(parts: BatchPart[], boundary: string): string {
  const segments: string[] = [];
  for (const part of parts) {
    const lines = [
      `--${boundary}`,
      "Content-Type: application/http",
      `Content-ID: <${part.id}>`,
      "",
      `${part.method} ${part.path} HTTP/1.1`,
    ];
    if (part.body !== undefined) {
      lines.push("Content-Type: application/json");
      lines.push("");
      lines.push(JSON.stringify(part.body));
    } else {
      lines.push("");
    }
    segments.push(lines.join("\r\n"));
  }
  segments.push(`--${boundary}--`);
  return segments.join("\r\n") + "\r\n";
}

function parseBoundary(contentType: string | null): string | null {
  if (!contentType) return null;
  const match = /boundary="?([^";]+)"?/i.exec(contentType);
  return match ? match[1]! : null;
}

/** Strip request-id decoration: `<response-item-3>` / `response-item-3` → `item-3`. */
function contentIdToRequestId(raw: string): string {
  const trimmed = raw.trim().replace(/^<|>$/g, "");
  return trimmed.replace(/^response-/, "");
}

function parsePart(part: string): { id: string; status: number; bodyText: string } | null {
  // A part is: outer headers (Content-Type, Content-ID), blank line, then an
  // embedded HTTP response: status line, headers, blank line, body.
  const normalized = part.replace(/\r\n/g, "\n");
  const outerSplit = normalized.indexOf("\n\n");
  if (outerSplit === -1) return null;
  const outerHeaders = normalized.slice(0, outerSplit);
  const inner = normalized.slice(outerSplit + 2);

  const idMatch = /^content-id:\s*(.+)$/im.exec(outerHeaders);
  if (!idMatch) return null;
  const id = contentIdToRequestId(idMatch[1]!);

  const statusMatch = /^HTTP\/[\d.]+\s+(\d{3})/m.exec(inner);
  if (!statusMatch) return null;
  const status = Number(statusMatch[1]);

  const innerSplit = inner.indexOf("\n\n");
  const bodyText = innerSplit === -1 ? "" : inner.slice(innerSplit + 2).trim();
  return { id, status, bodyText };
}

export function parseBatchResponse(responseText: string, boundary: string): BatchPartResult[] {
  const results: BatchPartResult[] = [];
  // Split on boundary markers; tolerate leading CRLF and the closing `--`.
  const pieces = responseText.split(new RegExp(`--${escapeRegExp(boundary)}(?:--)?`));
  for (const piece of pieces) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const parsed = parsePart(trimmed);
    if (!parsed) continue;
    let json: unknown;
    if (parsed.bodyText) {
      try {
        json = JSON.parse(parsed.bodyText);
      } catch {
        json = undefined;
      }
    }
    results.push({
      id: parsed.id,
      status: parsed.status,
      ok: parsed.status >= 200 && parsed.status < 300,
      ...(json !== undefined ? { json } : {}),
      bodyText: parsed.bodyText,
    });
  }
  return results;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let batchCounter = 0;

/** Default pause between sequential chunks — eases per-user quota pressure. */
export const BATCH_INTER_CHUNK_DELAY_MS = 200;
/**
 * Fixed backoff before the single per-part 429 retry. Per-part Retry-After
 * is NOT available: parsePart deliberately discards inner response headers
 * (Google rarely sends one per part; keeping the parser simple wins). If
 * that ever changes, extend BatchPartResult with parsed inner headers first.
 */
export const BATCH_PART_RETRY_DELAY_MS = 1000;

export interface ExecuteBatchOptions {
  interChunkDelayMs?: number;
  /** Retry rate-limited (429) parts once after a fixed backoff. Default on. */
  retryRateLimitedParts?: boolean;
  retryDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runChunk(
  fetchRaw: BatchFetch,
  chunk: BatchPart[]
): Promise<BatchPartResult[]> {
  batchCounter += 1;
  const boundary = `batch_vibestudio_${batchCounter}`;
  const response = await fetchRaw(GMAIL_BATCH_URL, {
    method: "POST",
    headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` },
    body: buildBatchBody(chunk, boundary),
  });
  const text = await response.text();
  if (!response.ok) {
    // Whole-batch failure (e.g. 429/401) — the client wrapper classifies it.
    throw new BatchHttpError(response.status, response.statusText, text);
  }
  const responseBoundary = parseBoundary(response.headers.get("Content-Type"));
  if (!responseBoundary) {
    throw new BatchHttpError(response.status, "missing multipart boundary in batch response", text);
  }
  return parseBatchResponse(text, responseBoundary);
}

/**
 * Execute up to N requests against the Gmail batch endpoint. Chunks at
 * BATCH_CHUNK_SIZE; chunks run sequentially with a small pause between them.
 * Rate-limited (429) parts are retried once with a fixed backoff. Throws only
 * on transport-level failure of a whole batch call (the caller classifies
 * it); remaining per-part failures come back as non-ok BatchPartResult
 * entries.
 */
export async function executeBatch(
  fetchRaw: BatchFetch,
  requests: BatchPart[],
  options: ExecuteBatchOptions = {}
): Promise<Map<string, BatchPartResult>> {
  const interChunkDelayMs = options.interChunkDelayMs ?? BATCH_INTER_CHUNK_DELAY_MS;
  const retryParts = options.retryRateLimitedParts ?? true;
  const retryDelayMs = options.retryDelayMs ?? BATCH_PART_RETRY_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;

  const results = new Map<string, BatchPartResult>();
  const byId = new Map(requests.map((part) => [part.id, part]));
  for (let offset = 0; offset < requests.length; offset += BATCH_CHUNK_SIZE) {
    if (offset > 0 && interChunkDelayMs > 0) await sleep(interChunkDelayMs);
    const chunk = requests.slice(offset, offset + BATCH_CHUNK_SIZE);
    for (const part of await runChunk(fetchRaw, chunk)) {
      results.set(part.id, part);
    }
  }

  if (retryParts) {
    const rateLimited = [...results.values()]
      .filter((part) => part.status === 429)
      .map((part) => byId.get(part.id))
      .filter((part): part is BatchPart => Boolean(part));
    if (rateLimited.length > 0) {
      await sleep(retryDelayMs);
      for (let offset = 0; offset < rateLimited.length; offset += BATCH_CHUNK_SIZE) {
        if (offset > 0 && interChunkDelayMs > 0) await sleep(interChunkDelayMs);
        const chunk = rateLimited.slice(offset, offset + BATCH_CHUNK_SIZE);
        for (const part of await runChunk(fetchRaw, chunk)) {
          results.set(part.id, part);
        }
      }
    }
  }
  return results;
}

/** Transport-level failure of an entire batch call. */
export class BatchHttpError extends Error {
  constructor(
    public readonly status: number,
    statusText: string,
    public readonly bodyText: string
  ) {
    super(`Gmail batch request failed: ${status} ${statusText}`);
    this.name = "BatchHttpError";
  }
}
