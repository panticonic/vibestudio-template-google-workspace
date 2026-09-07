// Builtin semantic-authority tests.
import { describe, expect, it } from "vitest";
import { contentMappingDigest, type ContentMapping } from "@workspace/vcs-engine";
import {
  ContentMappingCodecError,
  contentMappingFromRow,
  decodeContentMappingRow,
  encodeContentMappingRow,
} from "./semanticVcsContentMappingCodec.js";

const mapping = (coordinateKind: "utf16" | "byte"): ContentMapping => {
  const value = {
    childContentHash: "child:content",
    coordinateKind,
    childStart: 1,
    childEnd: 4,
    parentContentHash: "parent:content",
    parentStart: 2,
    parentEnd: 5,
  };
  return { ...value, digest: contentMappingDigest(value) };
};

describe("semantic VCS content mapping codec", () => {
  it.each(["utf16", "byte"] as const)(
    "round-trips the intrinsic %s coordinate kind",
    (coordinateKind) => {
      const value = mapping(coordinateKind);
      expect(contentMappingFromRow(encodeContentMappingRow(value))).toEqual(value);
    }
  );

  it("rejects rows whose coordinate kind is absent from their digest", () => {
    const row = encodeContentMappingRow(mapping("utf16"));
    expect(() => decodeContentMappingRow({ ...row, coordinate_kind: "byte" })).toThrow(
      ContentMappingCodecError
    );
  });

  it("rejects unknown coordinate kinds instead of guessing", () => {
    const row = encodeContentMappingRow(mapping("byte"));
    expect(() => decodeContentMappingRow({ ...row, coordinate_kind: "codepoint" })).toThrow(
      /coordinate_kind must be utf16 or byte/
    );
  });
});
