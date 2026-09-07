/**
 * scopeSerialize — Recursive per-property serializer for REPL scope.
 *
 * Persists a top-level scope value only when it can be reconstructed exactly.
 * Any unsupported leaf makes that complete top-level key volatile; a cold
 * kernel never receives a methodless or otherwise semantically changed copy.
 * Handles type-tagged values (Date, Map, Set, RegExp), circular references,
 * and max depth.
 */

// Depth is a safety/perf bound only — circular refs are handled separately by `seen`, so it can be
// generous; deeply-nested legitimate data (e.g. test-result trees) is preserved, not truncated.
const MAX_DEPTH = 100;
/** Top-level values larger than this spill to the content-addressed blob store (never dropped). */
const SPILL_THRESHOLD_CHARS = 128 * 1024;
/** Inline (in-row) scope budget — the largest remaining values spill until the row fits comfortably
 *  under the DO-SQLite per-value limit. */
const MAX_INLINE_TOTAL_CHARS = 256 * 1024;
/** Diagnostic cap: bounds the `dropped_paths` record so a pathological value can't overflow it. */
const MAX_DROPPED_ENTRIES = 200;

/**
 * Marker for a spilled top-level value: `{ [SCOPE_BLOB_REF]: <digest>, bytes }`. On hydrate, the
 * blob's content replaces it inline. Distinctive to avoid colliding with user data.
 */
export const SCOPE_BLOB_REF = "__vibestudioScopeBlob__";

/** A top-level value too large to inline — its serialized JSON is stored in the blob store and the
 *  placeholder (embedded in `serialized`) gets the content digest stamped in by `persist`. */
export interface ScopeSpill {
  placeholder: Record<string, unknown>;
  valueJson: string;
  bytes: number;
  key: string;
}

export interface SerializedScope {
  /** The scope object; large top-level values are replaced by blob-ref placeholders. */
  serialized: Record<string, unknown>;
  /** Large values to store in the blob store (the caller stamps each placeholder's digest). */
  spills: ScopeSpill[];
  /** Top-level keys that were fully serialized (incl. losslessly spilled). */
  serializedKeys: string[];
  /** Paths that were dropped, with reasons (functions/symbols/circular/depth — bounded). */
  droppedPaths: Array<{ path: string; reason: string }>;
  /**
   * Top-level keys excluded because only a partial representation was possible.
   * Retained as persistence metadata for diagnostics; these keys are never
   * present in `serialized`.
   */
  volatileKeys: string[];
}

/** A spilled-value placeholder produced by `serializeScope` (top-level only). */
export function isScopeBlobRef(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[SCOPE_BLOB_REF] === "string"
  );
}

// ---------------------------------------------------------------------------
// Type-tagged envelope for round-trip fidelity
// ---------------------------------------------------------------------------

interface TypeTagged {
  __vibestudioScopeType__: string;
  v: unknown;
}

function isTypeTagged(val: unknown): val is TypeTagged {
  return (
    typeof val === "object" &&
    val !== null &&
    "__vibestudioScopeType__" in val &&
    typeof (val as TypeTagged).__vibestudioScopeType__ === "string"
  );
}

function tagged(type: string, value: unknown = null): TypeTagged {
  return { __vibestudioScopeType__: type, v: value };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

type DroppedEntry = { path: string; reason: string };
type SerializedTopLevelEntry = {
  key: string;
  value: unknown;
  jsonChars: number;
};

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (typeof val !== "object" || val === null) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function hasExactObjectShape(val: object, prototype: object, expectedKeys: PropertyKey[]): boolean {
  const ownKeys = Reflect.ownKeys(val);
  return (
    Object.getPrototypeOf(val) === prototype &&
    ownKeys.length === expectedKeys.length &&
    ownKeys.every((key) => expectedKeys.includes(key))
  );
}

function rejectInexactBuiltin(
  val: object,
  prototype: object,
  expectedKeys: PropertyKey[],
  path: string,
  name: string,
  dropped: DroppedEntry[]
): boolean {
  if (hasExactObjectShape(val, prototype, expectedKeys)) return false;
  dropped.push({ path, reason: `${name} subclass or custom property` });
  return true;
}

function serializeValue(
  val: unknown,
  path: string,
  dropped: DroppedEntry[],
  seen: Set<unknown>,
  depth: number
): unknown {
  // Max depth
  if (depth > MAX_DEPTH) {
    dropped.push({ path, reason: "max depth exceeded" });
    return undefined;
  }

  // Primitives
  if (val === null) return val;
  if (val === undefined) return tagged("Undefined");
  const t = typeof val;
  if (t === "string" || t === "boolean") return val;
  if (t === "number") {
    if (Number.isNaN(val)) return tagged("NaN");
    if (val === Number.POSITIVE_INFINITY) return tagged("Infinity");
    if (val === Number.NEGATIVE_INFINITY) return tagged("-Infinity");
    if (Object.is(val, -0)) return tagged("-0");
    return val;
  }
  if (t === "bigint") return tagged("BigInt", val.toString());

  // Drop functions and symbols
  if (t === "function") {
    dropped.push({ path, reason: "function" });
    return undefined;
  }
  if (t === "symbol") {
    dropped.push({ path, reason: "symbol" });
    return undefined;
  }

  // Circular reference check
  if (typeof val === "object" && val !== null) {
    if (seen.has(val)) {
      dropped.push({ path, reason: "circular or shared object reference" });
      return undefined;
    }
    seen.add(val);
  }

  try {
    // Type-tagged values
    if (val instanceof Date) {
      if (rejectInexactBuiltin(val, Date.prototype, [], path, "Date", dropped)) {
        return undefined;
      }
      const time = val.getTime();
      return tagged("Date", {
        // An invalid Date has a NaN time value. JSON would silently turn that
        // into null, so invalidity is represented deliberately.
        time: Number.isNaN(time) ? null : time,
        extensible: Object.isExtensible(val),
      });
    }
    if (val instanceof RegExp) {
      if (rejectInexactBuiltin(val, RegExp.prototype, ["lastIndex"], path, "RegExp", dropped)) {
        return undefined;
      }
      const lastIndexDescriptor = Object.getOwnPropertyDescriptor(val, "lastIndex");
      if (
        !lastIndexDescriptor ||
        !("value" in lastIndexDescriptor) ||
        lastIndexDescriptor.enumerable ||
        lastIndexDescriptor.configurable ||
        !lastIndexDescriptor.writable
      ) {
        dropped.push({ path: `${path}.lastIndex`, reason: "custom property descriptor" });
        return undefined;
      }
      const lastIndex = serializeValue(
        lastIndexDescriptor.value,
        `${path}.lastIndex`,
        dropped,
        seen,
        depth + 1
      );
      return tagged("RegExp", {
        source: val.source,
        flags: val.flags,
        lastIndex,
        extensible: Object.isExtensible(val),
      });
    }
    if (val instanceof Map) {
      if (rejectInexactBuiltin(val, Map.prototype, [], path, "Map", dropped)) {
        return undefined;
      }
      const entries: [unknown, unknown][] = [];
      let i = 0;
      for (const [k, v] of val) {
        const kSer = serializeValue(k, `${path}[Map key ${i}]`, dropped, seen, depth + 1);
        const vSer = serializeValue(v, `${path}[Map value ${i}]`, dropped, seen, depth + 1);
        entries.push([kSer, vSer]);
        i++;
      }
      return tagged("Map", {
        entries,
        extensible: Object.isExtensible(val),
      });
    }
    if (val instanceof Set) {
      if (rejectInexactBuiltin(val, Set.prototype, [], path, "Set", dropped)) {
        return undefined;
      }
      const items: unknown[] = [];
      let i = 0;
      for (const item of val) {
        const ser = serializeValue(item, `${path}[Set ${i}]`, dropped, seen, depth + 1);
        items.push(ser);
        i++;
      }
      return tagged("Set", {
        items,
        extensible: Object.isExtensible(val),
      });
    }

    // WeakMap, WeakSet — drop
    if (val instanceof WeakMap || val instanceof WeakSet) {
      dropped.push({ path, reason: val.constructor.name });
      return undefined;
    }
    // WeakRef — may not exist in all targets, check by constructor name
    if (val.constructor?.name === "WeakRef") {
      dropped.push({ path, reason: "WeakRef" });
      return undefined;
    }

    // Arrays
    if (Array.isArray(val)) {
      if (Object.getPrototypeOf(val) !== Array.prototype) {
        dropped.push({ path, reason: "Array subclass or custom prototype" });
        return undefined;
      }
      const ownKeys = Reflect.ownKeys(val);
      const expectedKeys = new Set([
        "length",
        ...Array.from({ length: val.length }, (_, i) => String(i)),
      ]);
      if (
        ownKeys.length !== expectedKeys.size ||
        ownKeys.some((key) => typeof key === "symbol" || !expectedKeys.has(key)) ||
        [...expectedKeys].some((key) => !Object.prototype.hasOwnProperty.call(val, key))
      ) {
        dropped.push({ path, reason: "sparse array or custom array property" });
        return undefined;
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(val, "length");
      if (
        !lengthDescriptor ||
        !("value" in lengthDescriptor) ||
        lengthDescriptor.value !== val.length ||
        lengthDescriptor.enumerable ||
        lengthDescriptor.configurable ||
        !lengthDescriptor.writable
      ) {
        dropped.push({ path: `${path}.length`, reason: "custom property descriptor" });
        return undefined;
      }
      const result: unknown[] = [];
      for (let i = 0; i < val.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(val, String(i));
        if (
          !descriptor ||
          !("value" in descriptor) ||
          !descriptor.enumerable ||
          !descriptor.configurable ||
          !descriptor.writable
        ) {
          dropped.push({ path: `${path}[${i}]`, reason: "custom property descriptor" });
          return undefined;
        }
        const elemPath = `${path}[${i}]`;
        const ser = serializeValue(val[i], elemPath, dropped, seen, depth + 1);
        result.push(ser);
      }
      return tagged("Array", {
        items: result,
        extensible: Object.isExtensible(val),
      });
    }

    // Plain objects
    if (isPlainObject(val)) {
      const result: Array<[string, unknown]> = [];
      for (const key of Reflect.ownKeys(val)) {
        if (typeof key === "symbol") {
          dropped.push({ path, reason: "symbol property key" });
          return undefined;
        }
        const descriptor = Object.getOwnPropertyDescriptor(val, key);
        if (
          !descriptor ||
          !("value" in descriptor) ||
          !descriptor.enumerable ||
          !descriptor.configurable ||
          !descriptor.writable
        ) {
          dropped.push({ path: `${path}.${key}`, reason: "custom property descriptor" });
          return undefined;
        }
        const childPath = path ? `${path}.${key}` : key;
        const ser = serializeValue(descriptor.value, childPath, dropped, seen, depth + 1);
        result.push([key, ser]);
      }
      return tagged("Object", {
        nullPrototype: Object.getPrototypeOf(val) === null,
        entries: result,
        extensible: Object.isExtensible(val),
      });
    }

    // Class instances — drop (prototype not Object.prototype/null)
    dropped.push({ path, reason: `class instance (${val.constructor?.name ?? "unknown"})` });
    return undefined;
  } finally {
    // Keep every visited object in `seen` for the complete top-level value.
    // Repeated references carry identity semantics that a tree snapshot cannot
    // reproduce exactly, so they are volatile just like cycles.
  }
}

export function serializeScope(scope: Map<string, unknown>): SerializedScope {
  const dropped: DroppedEntry[] = [];
  const entries: SerializedTopLevelEntry[] = [];
  const serializedKeys: string[] = [];
  const volatileKeys: string[] = [];

  for (const [key, value] of scope) {
    const droppedBefore = dropped.length;
    const ser = serializeValue(value, key, dropped, new Set(), 0);
    // Scope durability is exact, never a best-effort data projection. A plain
    // object containing functions is a live object, not the smaller object
    // produced after deleting those functions.
    if (ser !== undefined && dropped.length === droppedBefore) {
      entries.push({ key, value: ser, jsonChars: serializedJsonChars(ser) });
      serializedKeys.push(key);
    } else {
      volatileKeys.push(key);
    }
  }

  // Decide which top-level values SPILL to the content-addressed blob store (lossless) rather than
  // being inlined in the scope row: any value over the per-value threshold, plus the largest
  // remaining values if the inline total is still over budget. (Previously such values were DROPPED.)
  const spillKeys = new Set<string>();
  for (const e of entries) if (e.jsonChars > SPILL_THRESHOLD_CHARS) spillKeys.add(e.key);
  let inlineTotal = entries
    .filter((e) => !spillKeys.has(e.key))
    .reduce((sum, e) => sum + e.jsonChars, 0);
  if (inlineTotal > MAX_INLINE_TOTAL_CHARS) {
    for (const e of entries
      .filter((x) => !spillKeys.has(x.key))
      .sort((a, b) => b.jsonChars - a.jsonChars)) {
      spillKeys.add(e.key);
      inlineTotal -= e.jsonChars;
      if (inlineTotal <= MAX_INLINE_TOTAL_CHARS) break;
    }
  }

  const serialized: Record<string, unknown> = {};
  const spills: ScopeSpill[] = [];
  for (const e of entries) {
    if (spillKeys.has(e.key)) {
      const placeholder: Record<string, unknown> = { [SCOPE_BLOB_REF]: "", bytes: e.jsonChars };
      serialized[e.key] = placeholder;
      spills.push({
        placeholder,
        valueJson: JSON.stringify(e.value),
        bytes: e.jsonChars,
        key: e.key,
      });
    } else {
      serialized[e.key] = e.value;
    }
  }

  // Bound the dropped-paths diagnostic so a pathological structure can't overflow the column.
  if (dropped.length > MAX_DROPPED_ENTRIES) {
    const omitted = dropped.length - MAX_DROPPED_ENTRIES;
    dropped.length = MAX_DROPPED_ENTRIES;
    dropped.push({ path: "(truncated)", reason: `${omitted} more dropped paths omitted` });
  }

  return { serialized, spills, serializedKeys, droppedPaths: dropped, volatileKeys };
}

function serializedJsonChars(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// ---------------------------------------------------------------------------
// Deserialization
// ---------------------------------------------------------------------------

function restoreExtensibility<T extends object>(value: T, extensible: boolean): T {
  if (!extensible) Object.preventExtensions(value);
  return value;
}

function deserializeValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  const t = typeof val;
  if (t === "string" || t === "number" || t === "boolean") return val;

  if (Array.isArray(val)) {
    return val.map(deserializeValue);
  }

  if (typeof val === "object" && val !== null) {
    // Type-tagged values
    if (isTypeTagged(val)) {
      switch (val.__vibestudioScopeType__) {
        case "Undefined":
          return undefined;
        case "NaN":
          return Number.NaN;
        case "Infinity":
          return Number.POSITIVE_INFINITY;
        case "-Infinity":
          return Number.NEGATIVE_INFINITY;
        case "-0":
          return -0;
        case "Date": {
          const date = val.v as { time: number | null; extensible: boolean };
          return restoreExtensibility(
            new Date(date.time === null ? Number.NaN : date.time),
            date.extensible
          );
        }
        case "RegExp": {
          const rv = val.v as {
            source: string;
            flags: string;
            lastIndex: unknown;
            extensible: boolean;
          };
          const expression = new RegExp(rv.source, rv.flags);
          expression.lastIndex = deserializeValue(rv.lastIndex) as number;
          return restoreExtensibility(expression, rv.extensible);
        }
        case "Map": {
          const map = val.v as {
            entries: [unknown, unknown][];
            extensible: boolean;
          };
          return restoreExtensibility(
            new Map(
              map.entries.map(([key, value]) => [deserializeValue(key), deserializeValue(value)])
            ),
            map.extensible
          );
        }
        case "Set": {
          const set = val.v as { items: unknown[]; extensible: boolean };
          return restoreExtensibility(new Set(set.items.map(deserializeValue)), set.extensible);
        }
        case "BigInt":
          return BigInt(val.v as string);
        case "Array": {
          const array = val.v as { items: unknown[]; extensible: boolean };
          return restoreExtensibility(array.items.map(deserializeValue), array.extensible);
        }
        case "Object": {
          const object = val.v as {
            nullPrototype: boolean;
            entries: Array<[string, unknown]>;
            extensible: boolean;
          };
          const result = Object.create(object.nullPrototype ? null : Object.prototype) as Record<
            string,
            unknown
          >;
          for (const [key, child] of object.entries) {
            Object.defineProperty(result, key, {
              value: deserializeValue(child),
              enumerable: true,
              configurable: true,
              writable: true,
            });
          }
          return restoreExtensibility(result, object.extensible);
        }
      }
    }

    // Plain object
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(val)) {
      result[key] = deserializeValue(child);
    }
    return result;
  }

  return val;
}

export function deserializeScope(json: string): Map<string, unknown> {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const map = new Map<string, unknown>();
  for (const [key, value] of Object.entries(parsed)) {
    map.set(key, deserializeValue(value));
  }
  return map;
}

/** Deserialize a single spilled value's JSON (the content stored in the blob store). */
export function deserializeScopeValue(json: string): unknown {
  return deserializeValue(JSON.parse(json));
}
