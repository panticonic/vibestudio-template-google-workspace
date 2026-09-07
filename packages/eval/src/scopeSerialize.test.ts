import { describe, expect, it } from "vitest";
import {
  deserializeScope,
  deserializeScopeValue,
  isScopeBlobRef,
  SCOPE_BLOB_REF,
  serializeScope,
} from "./scopeSerialize.js";

/**
 * Round-trip a scope: serialize → spill into an in-memory blob map → JSON → deserialize → hydrate,
 * mirroring what `ScopeManager.persist`/`hydrate` do against a real content-addressed blob store.
 */
function roundTrip(scope: Map<string, unknown>) {
  const res = serializeScope(scope);
  const blobs = new Map<string, string>();
  let n = 0;
  for (const spill of res.spills) {
    const digest = `d${n++}`;
    blobs.set(digest, spill.valueJson);
    spill.placeholder[SCOPE_BLOB_REF] = digest;
  }
  const data = JSON.stringify(res.serialized);
  const out = new Map<string, unknown>();
  for (const [key, value] of deserializeScope(data)) {
    out.set(
      key,
      isScopeBlobRef(value)
        ? deserializeScopeValue(blobs.get(value[SCOPE_BLOB_REF] as string)!)
        : value
    );
  }
  return { ...res, data, blobs, out };
}

describe("scope serialization — spill (not drop) of large values", () => {
  it("spills an oversized top-level value to a blob and hydrates it losslessly", () => {
    const big = "x".repeat(512 * 1024);
    const rt = roundTrip(
      new Map<string, unknown>([
        ["small", { ok: true }],
        ["results", big],
      ])
    );

    expect(rt.data.length).toBeLessThan(64 * 1024); // the inline row stays tiny (small + a ref)
    expect(rt.spills.map((s) => s.key)).toContain("results");
    expect(rt.out.get("small")).toEqual({ ok: true });
    expect(rt.out.get("results")).toBe(big); // FULL value preserved — nothing dropped
    expect(rt.serializedKeys).toEqual(expect.arrayContaining(["small", "results"]));
    expect(rt.droppedPaths).toEqual([]);
  });

  it("keeps small values inline (no spill)", () => {
    const rt = roundTrip(new Map([["v", "x".repeat(50 * 1024)]]));
    expect(rt.spills).toHaveLength(0);
    expect(rt.out.get("v")).toBe("x".repeat(50 * 1024));
  });

  it("spills the largest keys when the inline total exceeds budget — none dropped", () => {
    const rt = roundTrip(
      new Map<string, unknown>([
        ["a", "a".repeat(100 * 1024)],
        ["b", "b".repeat(100 * 1024)],
        ["c", "c".repeat(100 * 1024)],
        ["d", "d".repeat(100 * 1024)],
        ["small", "kept"],
      ])
    );

    expect(rt.data.length).toBeLessThanOrEqual(256 * 1024 + 4096);
    expect(rt.spills.length).toBeGreaterThan(0);
    expect(rt.out.get("small")).toBe("kept");
    for (const k of ["a", "b", "c", "d"]) expect(typeof rt.out.get(k)).toBe("string"); // all preserved
    expect(rt.droppedPaths).toEqual([]);
  });

  it("preserves deeply-nested data (depth bound is generous, not 20)", () => {
    let nested: Record<string, unknown> = { leaf: 42 };
    for (let i = 0; i < 40; i += 1) nested = { next: nested };
    const rt = roundTrip(new Map([["deep", nested]]));

    let cur = rt.out.get("deep") as Record<string, unknown> | undefined;
    for (let i = 0; i < 40; i += 1) cur = cur?.["next"] as Record<string, unknown> | undefined;
    expect(cur).toEqual({ leaf: 42 });
    expect(rt.droppedPaths).toEqual([]);
  });

  it("round-trips type-tagged values (Date) inside a spilled value", () => {
    const big = { when: new Date("2026-01-02T03:04:05.000Z"), pad: "x".repeat(300 * 1024) };
    const rt = roundTrip(new Map([["r", big]]));

    expect(rt.spills.map((s) => s.key)).toContain("r");
    const out = rt.out.get("r") as { when: Date; pad: string };
    expect(out.when).toBeInstanceOf(Date);
    expect(out.when.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(out.pad.length).toBe(300 * 1024);
  });

  it("round-trips undefined, special numbers, and tag-shaped user data exactly", () => {
    const original = {
      undefinedValue: undefined,
      nan: Number.NaN,
      positiveInfinity: Number.POSITIVE_INFINITY,
      negativeInfinity: Number.NEGATIVE_INFINITY,
      negativeZero: -0,
      userTag: { __vibestudioScopeType__: "Date", v: 0 },
    };
    const rt = roundTrip(new Map([["exact", original]]));
    const out = rt.out.get("exact") as typeof original;

    expect(Object.prototype.hasOwnProperty.call(out, "undefinedValue")).toBe(true);
    expect(out.undefinedValue).toBeUndefined();
    expect(Number.isNaN(out.nan)).toBe(true);
    expect(out.positiveInfinity).toBe(Number.POSITIVE_INFINITY);
    expect(out.negativeInfinity).toBe(Number.NEGATIVE_INFINITY);
    expect(Object.is(out.negativeZero, -0)).toBe(true);
    expect(out.userTag).toEqual({ __vibestudioScopeType__: "Date", v: 0 });
  });

  it("preserves invalid Dates, special RegExp state, and object extensibility", () => {
    const invalidDate = new Date(Number.NaN);
    const expression = /exact/gu;
    expression.lastIndex = Number.NaN;
    const fixedArray = Object.preventExtensions(["fixed"]);
    const fixedMap = Object.preventExtensions(new Map([["key", "value"]]));
    const rt = roundTrip(
      new Map<string, unknown>([
        ["date", invalidDate],
        ["expression", expression],
        ["array", fixedArray],
        ["map", fixedMap],
      ])
    );

    const restoredDate = rt.out.get("date") as Date;
    const restoredExpression = rt.out.get("expression") as RegExp;
    expect(Number.isNaN(restoredDate.getTime())).toBe(true);
    expect(Number.isNaN(restoredExpression.lastIndex)).toBe(true);
    expect(Object.isExtensible(rt.out.get("array") as object)).toBe(false);
    expect(Object.isExtensible(rt.out.get("map") as object)).toBe(false);
    expect(rt.volatileKeys).toEqual([]);
  });

  it("marks built-in subclasses and custom built-in properties volatile", () => {
    class SpecialDate extends Date {}
    const customMap = new Map();
    Object.defineProperty(customMap, "label", {
      value: "custom",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const rt = roundTrip(
      new Map<string, unknown>([
        ["dateSubclass", new SpecialDate(0)],
        ["customMap", customMap],
        ["stable", new Set([1, 2])],
      ])
    );

    expect(rt.out.has("dateSubclass")).toBe(false);
    expect(rt.out.has("customMap")).toBe(false);
    expect(rt.out.get("stable")).toEqual(new Set([1, 2]));
    expect(rt.volatileKeys).toEqual(["dateSubclass", "customMap"]);
  });

  it("marks shared references and custom object semantics volatile instead of changing them", () => {
    const shared = { value: 1 };
    const accessor = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      configurable: true,
      get: () => 1,
    });
    const rt = roundTrip(
      new Map<string, unknown>([
        ["shared", { left: shared, right: shared }],
        ["accessor", accessor],
        ["stable", "yes"],
      ])
    );

    expect(rt.out.has("shared")).toBe(false);
    expect(rt.out.has("accessor")).toBe(false);
    expect(rt.volatileKeys).toEqual(["shared", "accessor"]);
    expect(rt.out.get("stable")).toBe("yes");
  });

  it("still drops genuinely-unserializable leaves (functions), and bounds the dropped list", () => {
    const rt = roundTrip(new Map<string, unknown>([["fn", () => 1]]));
    expect(rt.out.has("fn")).toBe(false);
    expect(rt.droppedPaths.length).toBeGreaterThan(0);
    expect(rt.droppedPaths.length).toBeLessThanOrEqual(201); // MAX_DROPPED_ENTRIES + truncation note
  });

  it("reports every volatile top-level key even when path diagnostics are truncated", () => {
    const scope = new Map<string, unknown>();
    for (let index = 0; index < 205; index += 1) {
      scope.set(`fn${index}`, () => index);
    }

    const rt = roundTrip(scope);

    expect(rt.droppedPaths).toHaveLength(201);
    expect(rt.droppedPaths.at(-1)).toEqual({
      path: "(truncated)",
      reason: "5 more dropped paths omitted",
    });
    expect(rt.volatileKeys).toEqual([...scope.keys()]);
    expect(rt.volatileKeys).not.toContain("(truncated)");
  });

  it("rejects a whole top-level value instead of hydrating a methodless imitation", () => {
    const rt = roundTrip(
      new Map<string, unknown>([
        ["handle", { id: "panel:one", cdp: { page: async () => "live" } }],
        ["panelId", "panel:one"],
      ])
    );

    expect(rt.out.has("handle")).toBe(false);
    expect(rt.volatileKeys).toEqual(["handle"]);
    expect(rt.out.get("panelId")).toBe("panel:one");
  });
});
