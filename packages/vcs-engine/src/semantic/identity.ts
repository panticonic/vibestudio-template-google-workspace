import { canonicalJson, sha256HexSyncText } from "@vibestudio/content-addressing";
import type { ContentMapping } from "./model.js";

export const SEMANTIC_PROTOCOL = "vibestudio.vcs.semantic.v1";
export const NORMALIZATION_PROTOCOL = "vibestudio.vcs.normalization.v2";

export function canonicalDigest(domain: string, payload: unknown): string {
  return sha256HexSyncText(canonicalJson({ domain, protocol: SEMANTIC_PROTOCOL, payload }));
}

export function compactId(domain: string, payload: unknown): string {
  return `${domain}:${canonicalDigest(domain, payload)}`;
}

export function contentMappingDigest(mapping: Omit<ContentMapping, "digest">): string {
  return compactId("mapping", mapping);
}
