import { describe, expect, it } from "vitest";
import { contentMappingDigest } from "./identity.js";

describe("content mapping identity", () => {
  it("includes the intrinsic coordinate kind", () => {
    const range = {
      childContentHash: "blob:unicode-copy",
      childStart: 0,
      childEnd: "a😀éz".length,
      parentContentHash: "blob:unicode-source",
      parentStart: 0,
      parentEnd: "a😀éz".length,
    } as const;

    expect("a😀éz".length).toBe(5);
    expect(new TextEncoder().encode("a😀éz").byteLength).toBe(8);
    expect(contentMappingDigest({ ...range, coordinateKind: "utf16" })).not.toBe(
      contentMappingDigest({ ...range, coordinateKind: "byte" })
    );
  });
});
