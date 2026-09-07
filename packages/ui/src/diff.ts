export { DiffViewer } from "./kit/diff/DiffViewer";
export type { DiffViewerProps } from "./kit/diff/DiffViewer";
export type {
  DiffReviewEntry,
  DiffChangedFile,
  DiffFileKind,
  DiffStat,
  DiffContentFetcher,
} from "./kit/diff/types";
export { diffLines, splitLines, allAdded, allRemoved } from "@vibestudio/shared/lineDiff";
export type { DiffRow, DiffRowType, LineDiffResult } from "@vibestudio/shared/lineDiff";
export { languageForPath } from "./kit/diff/highlight";
