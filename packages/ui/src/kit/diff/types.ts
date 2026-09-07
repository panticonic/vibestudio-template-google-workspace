/**
 * Diff-review payload types.
 *
 * P3.5: mirror of gate payload — unify with host schema when P1 lands.
 *
 * These shapes mirror what the host approval gate attaches per batch entry
 * (provenance-aware-diff-merge-plan §9). File contents are never inlined: the gate only
 * ships content hashes, and the UI lazily fetches the two trusted blobs by
 * content hash from the host blobstore read surface when a reviewer expands a
 * file. Content addressing is the integrity argument — `get(hash)` can only
 * return bytes matching `hash`, and the hashes originate from the host's own
 * `diffTrees`, so no read-surface caller can substitute display content.
 */

/** How a single path changed between the old and new tree. */
export type DiffFileKind = "added" | "removed" | "changed";

/** Per-file entry in the batch payload. `oldHash`/`newHash` are content digests
 *  (blobstore addresses); which are present depends on `kind`. */
export interface DiffChangedFile {
  path: string;
  kind: DiffFileKind;
  /** Content digest of the old blob (present for "removed" and "changed"). */
  oldHash?: string;
  /** Content digest of the new blob (present for "added" and "changed"). */
  newHash?: string;
  /** Host-flagged binary — rendered diffstat-only, never fetched for diffing. */
  binary?: boolean;
  /** Host-flagged oversized — rendered diffstat-only, never fetched for diffing. */
  tooLarge?: boolean;
}

/** Host-computed diffstat totals for one repo entry. `insertions`/`deletions`
 *  are OPTIONAL by design — the host omits them for entries where line counts
 *  weren't computed (any binary/oversized/truncated file). `filesChanged` is
 *  always exact. */
export interface DiffStat {
  filesChanged: number;
  insertions?: number;
  deletions?: number;
}

/** One repo's worth of changes in a batch approval — the DiffViewer's unit.
 *  `newState` is `null` for a delete entry (all files `removed`); `truncated`
 *  marks a `changedFiles` list capped by the host past its per-entry limit
 *  (`filesChanged` still exact). Field shapes mirror the canonical
 *  `@vibestudio/shared/approvals` `DiffReviewEntry` (this package stays free of a
 *  shared-package dependency). */
export interface DiffReviewEntry {
  repoPath: string;
  oldState: string;
  newState: string | null;
  diffStat: DiffStat;
  changedFiles: DiffChangedFile[];
  truncated?: boolean;
}

/**
 * Lazy content fetcher the host chrome supplies to the viewer. It resolves a
 * content hash (one of the hashes carried in the payload) to the blob's bytes.
 * Text blobs may come back as a decoded string; binary-ish blobs as raw bytes.
 * Rejecting or resolving `null`-ish is treated as "unavailable" and degrades to
 * a non-blocking notice — it never gates the approval decision.
 */
export type DiffContentFetcher = (hash: string) => Promise<string | Uint8Array>;
