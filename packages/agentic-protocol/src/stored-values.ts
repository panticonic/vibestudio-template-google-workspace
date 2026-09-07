import type { AgenticEvent } from "./events.js";

export const STORED_VALUE_REF_PROTOCOL = "vibestudio.blob-ref.v1" as const;

export const MAX_INLINE_TRAJECTORY_TEXT_BYTES = 128 * 1024;
export const MAX_INLINE_TRAJECTORY_EVENT_BYTES = 512 * 1024;

export interface StoredValueRef {
  protocol: typeof STORED_VALUE_REF_PROTOCOL;
  digest: string;
  size: number;
  encoding: "json" | "text";
  originalBytes: number;
}

export interface BlobWriter {
  putText(value: string): Promise<{ digest: string; size: number }>;
}

export interface BlobReader {
  getText(digest: string): Promise<string | null>;
}

export interface HydrateStoredValueRefsOptions {
  strict?: boolean;
  context?: string;
}

export interface EncodedAgenticEvent {
  event: AgenticEvent;
  eventBytes: number;
}

export interface StorageClassOptions {
  /** Hard bound for class-INLINE string leaves. */
  maxInlineTextBytes?: number;
  /** Exact paths that are class REFERENCE: always stored by ref. Array
   *  indices in these paths are written `[*]`. */
  referencePaths?: ReadonlySet<string>;
  /** What happens when an INLINE leaf exceeds the bound:
   *  - "error" (default — trajectory events): InlineValueTooLargeError at
   *    the emitter. Trajectory folds read inline fields; a silent spill
   *    blinds them, so oversize is the emitter's bug and must surface there.
   *  - "spill" (channel payloads ONLY): store by ref. Channel payload bodies
   *    are a bulk transport for presentation/custom data, hydrated on read;
   *    arbitrary client publishes must not be able to trigger server-side
   *    encode errors. Channel policy folds must not read unbounded payload
   *    fields (they may see refs).
   */
  oversizeInline?: "error" | "spill";
}

/**
 * Storage classes — every payload field is exactly one of:
 *
 * - REFERENCE (listed below): ALWAYS stored as a StoredValueRef, even when
 *   tiny — one code path, no "maybe spilled" states. Folds retain these as
 *   opaque carriers. Semantic event cascades, executors, and UI hydrate at
 *   their explicit read boundaries.
 * - INLINE (everything else): always present verbatim in the envelope — the
 *   ONLY class folds may read. Oversized inline values are a hard
 *   encode-time error at the emitter (InlineValueTooLargeError), never a
 *   silent spill: emitters of fold-read data must bound it by construction
 *   (split long model text blocks, clamp roster descriptions, keep
 *   connectSpec small).
 *
 * History: the previous model (force-spill paths + a 128KB size-threshold
 * spill on everything else) blinded the fold four separate times
 * (modelRequest, system.event details, compaction replacement, and a latent
 * roster spill). Fold-readability is now a static property of the path.
 */
export const REFERENCE_PAYLOAD_PATHS: ReadonlySet<string> = new Set([
  "$.payload.request",
  "$.payload.result",
  // NOTE: $.payload.details is INLINE — the fold reads fold-critical fields
  // from system.event details (credKey, expiresAt, roster, config patch).
  // Emitters must keep details bounded; oversize is an error, not a spill.
  "$.payload.data",
  // Method progress chunks are fold-opaque streaming bulk: always by ref
  // (one code path; chunks are arbitrary client data and must never be able
  // to trigger an inline-bound error remotely).
  "$.payload.output",
  "$.payload.error",
  // NOTE: $.payload.replacement (compaction) is INLINE — the fold replaces
  // its entries from it. The entries it carries are copies of fold entries,
  // whose bulky members (request/result/output) are already refs.
  "$.payload.body",
  "$.payload.update",
  "$.payload.initialState",
  "$.payload.props",
  "$.payload.imports",
  "$.payload.source",
  // Tool-call arguments inside assistant blocks are unbounded model output
  // (file writes!) and fold-opaque: the step reads the block's `name` and
  // copies `arguments` verbatim into invocation.started's `request` (itself
  // a reference path); executors hydrate before running the tool. `[*]`
  // matches any array index. Block `content` (text/thinking) stays INLINE —
  // the model-call executor splits oversized text into multiple blocks.
  "$.payload.blocks[*].arguments",
]);

const REQUIRED_STORED_PAYLOAD_PATHS = REFERENCE_PAYLOAD_PATHS;

export class InlineValueTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly bytes: number,
    readonly maxBytes: number
  ) {
    super(
      `inline value at ${path} is ${bytes} bytes (max ${maxBytes}). There is no ` +
        `implicit spill: bound this value at the emitter (split/clamp it) or ` +
        `classify the path as REFERENCE in REFERENCE_PAYLOAD_PATHS (fold-opaque, ` +
        `always stored by ref).`
    );
    this.name = "InlineValueTooLargeError";
  }
}

export async function encodeAgenticEventStoredValues(
  event: AgenticEvent,
  writer: BlobWriter
): Promise<EncodedAgenticEvent> {
  const eventWithStoredPayload = {
    ...event,
    payload: await encodeStorageClasses(event.payload, writer, {
      referencePaths: REFERENCE_PAYLOAD_PATHS,
    }, "$.payload"),
  } as AgenticEvent;
  const eventBytes = byteLength(JSON.stringify(eventWithStoredPayload));
  return { event: eventWithStoredPayload, eventBytes };
}

export async function encodeChannelPayloadStoredValues(
  payload: unknown,
  writer: BlobWriter
): Promise<unknown> {
  return encodeStorageClasses(payload, writer, {
    referencePaths: REFERENCE_PAYLOAD_PATHS,
    oversizeInline: "spill",
  });
}

export async function encodeStorageClasses(
  value: unknown,
  writer: BlobWriter,
  options: StorageClassOptions = {},
  path = "$"
): Promise<unknown> {
  // matchPath generalizes array indices to `[*]` so reference paths can
  // classify array elements; `path` keeps real indices for diagnostics.
  return encodeStorageClassesInner(value, writer, options, path, path);
}

async function encodeStorageClassesInner(
  value: unknown,
  writer: BlobWriter,
  options: StorageClassOptions,
  path: string,
  matchPath: string
): Promise<unknown> {
  if (isStoredValueRef(value)) return value;

  const maxText = options.maxInlineTextBytes ?? MAX_INLINE_TRAJECTORY_TEXT_BYTES;
  const reference = options.referencePaths?.has(matchPath) === true;

  if (reference) {
    if (typeof value === "string") return storeText(value, writer);
    if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    return storeJson(value, writer);
  }

  if (typeof value === "string") {
    const bytes = byteLength(value);
    if (bytes > maxText) {
      if (options.oversizeInline === "spill") return storeText(value, writer);
      throw new InlineValueTooLargeError(path, bytes, maxText);
    }
    return value;
  }
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "object") return String(value);

  if (Array.isArray(value)) {
    return Promise.all(
      value.map((item, index) =>
        encodeStorageClassesInner(item, writer, options, `${path}[${index}]`, `${matchPath}[*]`)
      )
    );
  }
  const entries = await Promise.all(
    Object.entries(value as Record<string, unknown>).map(async ([key, item]) => [
      key,
      await encodeStorageClassesInner(item, writer, options, `${path}.${key}`, `${matchPath}.${key}`),
    ] as const)
  );
  return Object.fromEntries(entries);
}

export function isStoredValueRef(value: unknown): value is StoredValueRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record["protocol"] === STORED_VALUE_REF_PROTOCOL &&
    typeof record["digest"] === "string" &&
    typeof record["size"] === "number" &&
    (record["encoding"] === "json" || record["encoding"] === "text") &&
    typeof record["originalBytes"] === "number";
}

export function collectStoredValueRefs(value: unknown, path = "$"): Array<{ path: string; ref: StoredValueRef }> {
  if (isStoredValueRef(value)) return [{ path, ref: value }];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectStoredValueRefs(item, `${path}[${index}]`));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    collectStoredValueRefs(item, `${path}.${key}`)
  );
}

export function assertNoStoredValueRefs(value: unknown, context = "value"): void {
  const refs = collectStoredValueRefs(value);
  if (refs.length === 0) return;
  const summary = refs
    .slice(0, 8)
    .map(({ path, ref }) => `${path} -> ${ref.digest} (${ref.encoding}, ${ref.size} bytes)`)
    .join("; ");
  const suffix = refs.length > 8 ? `; ${refs.length - 8} more` : "";
  throw new Error(`${context} contains unresolved stored value refs: ${summary}${suffix}`);
}

export function findUnencodedAgenticEventStoredValues(event: AgenticEvent): Array<{ path: string; reason: string }> {
  const violations: Array<{ path: string; reason: string }> = [];
  for (const { path, ref } of collectStoredValueRefs(event)) {
    if (path === "$.payload" || path.startsWith("$.payload.")) continue;
    violations.push({ path, reason: `stored ref is only allowed inside payload storage (${ref.digest})` });
  }
  for (const path of REQUIRED_STORED_PAYLOAD_PATHS) {
    // getPathAll expands `[*]` wildcards over arrays, so e.g.
    // $.payload.blocks[*].arguments validates EVERY block's arguments — a
    // literal lookup matched nothing and let unencoded args through.
    for (const value of getPathAll(event, path)) {
      if (
        value === undefined ||
        value === null ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        continue;
      }
      if (isStoredValueRef(value)) continue;
      violations.push({ path, reason: "storage-boundary payload field must be a StoredValueRef" });
    }
  }
  const eventBytes = byteLength(JSON.stringify(event));
  if (eventBytes > MAX_INLINE_TRAJECTORY_EVENT_BYTES) {
    violations.push({ path: "$", reason: `encoded event too large: ${eventBytes}` });
  }
  return violations;
}

/** Resolve a JSONPath-ish path to all matching values, expanding a trailing
 *  `[*]` on a segment over array elements (e.g. `blocks[*].arguments`). */
function getPathAll(value: unknown, path: string): unknown[] {
  if (path === "$") return [value];
  let current: unknown[] = [value];
  for (const segment of path.slice(2).split(".")) {
    const wildcard = segment.endsWith("[*]");
    const key = wildcard ? segment.slice(0, -3) : segment;
    const next: unknown[] = [];
    for (const node of current) {
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      const child = (node as Record<string, unknown>)[key];
      if (wildcard) {
        if (Array.isArray(child)) next.push(...child);
      } else {
        next.push(child);
      }
    }
    current = next;
  }
  return current;
}

export function assertAgenticEventStoredValuesEncoded(event: AgenticEvent): void {
  const violations = findUnencodedAgenticEventStoredValues(event);
  if (violations.length > 0) {
    const summary = violations.map((item) => `${item.path}: ${item.reason}`).join("; ");
    throw new Error(`trajectory event contains unencoded stored values: ${summary}`);
  }
}

export async function hydrateStoredValueRef(
  ref: StoredValueRef,
  reader: BlobReader,
  options: HydrateStoredValueRefsOptions = {},
  path = "$"
): Promise<unknown> {
  const text = await reader.getText(ref.digest);
  if (text === null) {
    if (options.strict) {
      const context = options.context ? `${options.context} ` : "";
      throw new Error(
        `${context}stored value missing at ${path}: ${ref.digest} (${ref.encoding}, ${ref.size} bytes)`
      );
    }
    return null;
  }
  if (ref.encoding === "text") return text;
  return hydrateStoredValueRefs(JSON.parse(text), reader, options, path);
}

export async function hydrateStoredValueRefs(
  value: unknown,
  reader: BlobReader,
  options: HydrateStoredValueRefsOptions = {},
  path = "$"
): Promise<unknown> {
  if (isStoredValueRef(value)) return hydrateStoredValueRef(value, reader, options, path);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Promise.all(
      value.map((item, index) => hydrateStoredValueRefs(item, reader, options, `${path}[${index}]`))
    );
  }
  const entries = await Promise.all(
    Object.entries(value as Record<string, unknown>).map(async ([key, item]) => [
      key,
      await hydrateStoredValueRefs(item, reader, options, `${path}.${key}`),
    ] as const)
  );
  return Object.fromEntries(entries);
}

export function assertEncodedAgenticEventFits(event: AgenticEvent, maxBytes = MAX_INLINE_TRAJECTORY_EVENT_BYTES): void {
  const eventBytes = byteLength(JSON.stringify(event));
  if (eventBytes > maxBytes) {
    throw new Error(`encoded trajectory event too large: ${eventBytes} > ${maxBytes}`);
  }
}

async function storeText(value: string, writer: BlobWriter): Promise<StoredValueRef> {
  const originalBytes = byteLength(value);
  const blob = await writer.putText(value);
  return {
    protocol: STORED_VALUE_REF_PROTOCOL,
    digest: blob.digest,
    size: blob.size,
    encoding: "text",
    originalBytes,
  };
}

async function storeJson(value: unknown, writer: BlobWriter): Promise<StoredValueRef> {
  const json = JSON.stringify(value);
  const originalBytes = byteLength(json);
  const blob = await writer.putText(json);
  return {
    protocol: STORED_VALUE_REF_PROTOCOL,
    digest: blob.digest,
    size: blob.size,
    encoding: "json",
    originalBytes,
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
