// Builtin semantic-authority implementation.
import { contentMappingDigest, type ContentMapping } from "@workspace/vcs-engine";

export interface ContentMappingRow extends Record<string, unknown> {
  child_content_hash: string;
  coordinate_kind: "utf16" | "byte";
  child_start: number;
  child_end: number;
  parent_content_hash: string;
  parent_start: number;
  parent_end: number;
  digest: string;
}

export class ContentMappingCodecError extends Error {
  constructor(message: string) {
    super(`Invalid content mapping row: ${message}`);
    this.name = "ContentMappingCodecError";
  }
}

const text = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new ContentMappingCodecError(`${field} must be a non-empty string`);
  }
  return value;
};

const integer = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ContentMappingCodecError(`${field} must be a non-negative safe integer`);
  }
  return value;
};

const coordinateKind = (value: unknown): "utf16" | "byte" => {
  if (value !== "utf16" && value !== "byte") {
    throw new ContentMappingCodecError("coordinate_kind must be utf16 or byte");
  }
  return value;
};

export function encodeContentMappingRow(mapping: ContentMapping): ContentMappingRow {
  return decodeContentMappingRow({
    child_content_hash: mapping.childContentHash,
    coordinate_kind: mapping.coordinateKind,
    child_start: mapping.childStart,
    child_end: mapping.childEnd,
    parent_content_hash: mapping.parentContentHash,
    parent_start: mapping.parentStart,
    parent_end: mapping.parentEnd,
    digest: mapping.digest,
  });
}

export function decodeContentMappingRow(row: Record<string, unknown>): ContentMappingRow {
  const decoded: ContentMappingRow = {
    child_content_hash: text(row["child_content_hash"], "child_content_hash"),
    coordinate_kind: coordinateKind(row["coordinate_kind"]),
    child_start: integer(row["child_start"], "child_start"),
    child_end: integer(row["child_end"], "child_end"),
    parent_content_hash: text(row["parent_content_hash"], "parent_content_hash"),
    parent_start: integer(row["parent_start"], "parent_start"),
    parent_end: integer(row["parent_end"], "parent_end"),
    digest: text(row["digest"], "digest"),
  };
  if (decoded.child_end < decoded.child_start || decoded.parent_end < decoded.parent_start) {
    throw new ContentMappingCodecError("range end precedes its start");
  }
  const expected = contentMappingDigest({
    childContentHash: decoded.child_content_hash,
    coordinateKind: decoded.coordinate_kind,
    childStart: decoded.child_start,
    childEnd: decoded.child_end,
    parentContentHash: decoded.parent_content_hash,
    parentStart: decoded.parent_start,
    parentEnd: decoded.parent_end,
  });
  if (decoded.digest !== expected) {
    throw new ContentMappingCodecError("digest does not identify the exact columns");
  }
  return decoded;
}

export function contentMappingFromRow(row: Record<string, unknown>): ContentMapping {
  const value = decodeContentMappingRow(row);
  return {
    childContentHash: value.child_content_hash,
    coordinateKind: value.coordinate_kind,
    childStart: value.child_start,
    childEnd: value.child_end,
    parentContentHash: value.parent_content_hash,
    parentStart: value.parent_start,
    parentEnd: value.parent_end,
    digest: value.digest,
  };
}

export const contentMappingRowValues = (row: ContentMappingRow): readonly unknown[] => [
  row.child_content_hash,
  row.coordinate_kind,
  row.child_start,
  row.child_end,
  row.parent_content_hash,
  row.parent_start,
  row.parent_end,
  row.digest,
];
