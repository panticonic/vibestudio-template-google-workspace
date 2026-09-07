/**
 * DiffViewer — the shared, reusable diff-review surface for the approval prompt
 * (and any other panel, e.g. Workspace History, that wants the same viewer). It takes
 * one host-computed batch entry (repo + per-file change list) plus a lazy
 * content fetcher, and renders:
 *
 *   • a file list with kind badges and per-file diffstat,
 *   • expandable per-file unified diffs (with expand-all),
 *   • client-side LCS line diffing of the two fetched blobs, and
 *   • added/removed line backgrounds layered over best-effort shiki highlighting.
 *
 * Guardrails (provenance-aware-diff-merge-plan §9): file contents are fetched only by the
 * content hashes named in the payload, lazily on expand. Binary/oversized files
 * render diffstat-only; callers that have a real file-inspection surface may
 * opt into an "open in Workspace History" action. Highlighting is best-effort — plain
 * text never blocks review. Crucially, this component renders NO decision
 * controls: the host's Allow/Deny buttons live outside it and are never gated
 * on any fetch or highlight completing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Box, Button, Flex, IconButton, Text, Tooltip } from "@radix-ui/themes";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileIcon,
} from "@radix-ui/react-icons";
import {
  allAdded,
  allRemoved,
  diffLines,
  type DiffRow,
  type LineDiffResult,
} from "@vibestudio/shared/lineDiff";
import type { DiffChangedFile, DiffContentFetcher, DiffReviewEntry } from "./types";
import { highlightBlob, type HighlightAppearance, type HighlightedLine } from "./highlight";

export interface DiffViewerProps {
  /** One repo's batch entry (host-computed). */
  entry: DiffReviewEntry;
  /** Lazy blob fetcher — resolves a payload content hash to its bytes. */
  fetchContent: DiffContentFetcher;
  /** Drives shiki theme selection; defaults to light. */
  appearance?: HighlightAppearance;
  /**
   * Escape hatch into Workspace History's file-inspection surface. Rendered as the
   * primary action on degraded (binary/oversized) rows — which can't render
   * inline — and as a quiet secondary icon on normal file headers, for
   * reviewers who want full context beyond the unified diff. When omitted, the
   * degraded row simply explains why it can't render inline and normal headers
   * carry no extra action (the shell may leave this unimplemented for now).
   */
  onOpenInWorkspaceHistory?: (file: DiffChangedFile, entry: DiffReviewEntry) => void;
  /**
   * Paths to expand on first render (inline files only — degraded rows can't
   * expand). Lets a host deep-link straight into an open diff, e.g. Workspace History
   * pre-expanding the file the reviewer was sent to. Changes are additive: a
   * later value merges in without collapsing what the reviewer has open.
   */
  initialExpanded?: readonly string[];
}

const KIND_BADGE: Record<
  DiffChangedFile["kind"],
  { label: string; color: "green" | "red" | "amber" }
> = {
  added: { label: "added", color: "green" },
  removed: { label: "removed", color: "red" },
  changed: { label: "changed", color: "amber" },
};

export function DiffViewer({
  entry,
  fetchContent,
  appearance = "light",
  onOpenInWorkspaceHistory,
  initialExpanded,
}: DiffViewerProps) {
  const files = entry.changedFiles;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initialExpanded));

  const inlineFiles = useMemo(() => files.filter((f) => !f.binary && !f.tooLarge), [files]);

  // Merge in any later `initialExpanded` request (e.g. a deep link switching to
  // a different focused file on the same mounted panel) without collapsing what
  // the reviewer already opened. Degraded rows are ignored — they can't expand.
  const inlinePaths = useMemo(() => new Set(inlineFiles.map((f) => f.path)), [inlineFiles]);
  useEffect(() => {
    if (!initialExpanded || initialExpanded.length === 0) return;
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const path of initialExpanded) {
        if (inlinePaths.has(path) && !next.has(path)) {
          next.add(path);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [initialExpanded, inlinePaths]);
  const allInlineExpanded =
    inlineFiles.length > 0 && inlineFiles.every((f) => expanded.has(f.path));

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    if (allInlineExpanded) setExpanded(new Set());
    else setExpanded(new Set(inlineFiles.map((f) => f.path)));
  }, [allInlineExpanded, inlineFiles]);

  return (
    <Box data-diff-viewer="" style={{ minWidth: 0 }}>
      <Flex align="center" justify="between" gap="2" mb="1" wrap="wrap">
        <Flex align="center" gap="2" style={{ minWidth: 0 }}>
          <FileIcon />
          <Text size="1" color="gray">
            {entry.diffStat.filesChanged} file{entry.diffStat.filesChanged === 1 ? "" : "s"} changed
          </Text>
          <DiffStatCounts
            insertions={entry.diffStat.insertions}
            deletions={entry.diffStat.deletions}
          />
        </Flex>
        {inlineFiles.length > 0 ? (
          <Button size="1" variant="ghost" color="gray" onClick={expandAll}>
            {allInlineExpanded ? "Collapse all" : "Expand all"}
          </Button>
        ) : null}
      </Flex>

      <Flex direction="column" gap="1">
        {files.map((file) => (
          <DiffFileRow
            key={file.path}
            file={file}
            entry={entry}
            expanded={expanded.has(file.path)}
            appearance={appearance}
            fetchContent={fetchContent}
            onToggle={() => toggle(file.path)}
            onOpenInWorkspaceHistory={onOpenInWorkspaceHistory}
          />
        ))}
        {files.length === 0 ? (
          <Text size="1" color="gray">
            No file changes in this entry.
          </Text>
        ) : null}
      </Flex>
    </Box>
  );
}

function DiffStatCounts({ insertions, deletions }: { insertions?: number; deletions?: number }) {
  // Host omits line totals for entries with any skipped file — render nothing
  // rather than a misleading +0 −0.
  if (insertions == null && deletions == null) return null;
  return (
    <Flex align="center" gap="2" style={{ flexShrink: 0 }}>
      <Text size="1" style={{ color: "var(--green-11)" }}>
        +{insertions ?? 0}
      </Text>
      <Text size="1" style={{ color: "var(--red-11)" }}>
        −{deletions ?? 0}
      </Text>
    </Flex>
  );
}

function DiffFileRow({
  file,
  entry,
  expanded,
  appearance,
  fetchContent,
  onToggle,
  onOpenInWorkspaceHistory,
}: {
  file: DiffChangedFile;
  entry: DiffReviewEntry;
  expanded: boolean;
  appearance: HighlightAppearance;
  fetchContent: DiffContentFetcher;
  onToggle: () => void;
  onOpenInWorkspaceHistory?: (file: DiffChangedFile, entry: DiffReviewEntry) => void;
}) {
  const degraded = Boolean(file.binary || file.tooLarge);
  const badge = KIND_BADGE[file.kind];
  const diff = useFileDiff(expanded && !degraded ? file : null, fetchContent, appearance);

  return (
    <Box
      data-diff-file={file.path}
      style={{ border: "1px solid var(--gray-a5)", borderRadius: 6, overflow: "hidden" }}
    >
      <Flex align="center" style={{ background: "var(--gray-a2)", minWidth: 0 }}>
        <button
          type="button"
          data-diff-file-header=""
          onClick={degraded ? undefined : onToggle}
          aria-expanded={degraded ? undefined : expanded}
          disabled={degraded}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flex: 1,
            padding: "5px 8px",
            background: "transparent",
            border: "none",
            textAlign: "left",
            cursor: degraded ? "default" : "pointer",
            minWidth: 0,
          }}
        >
          <span style={{ flexShrink: 0, color: "var(--gray-10)", display: "inline-flex" }}>
            {degraded ? <FileIcon /> : expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </span>
          <Badge color={badge.color} variant="soft" radius="full" style={{ flexShrink: 0 }}>
            {badge.label}
          </Badge>
          <Text
            size="1"
            style={{
              fontFamily: "var(--code-font-family, monospace)",
              overflowWrap: "anywhere",
              minWidth: 0,
              flex: 1,
            }}
          >
            {file.path}
          </Text>
          {diff.result ? (
            <DiffStatCounts insertions={diff.result.insertions} deletions={diff.result.deletions} />
          ) : null}
        </button>
        {/* Quiet secondary escape hatch on NORMAL rows — degraded rows carry the
            primary action in their body note instead, so we skip it here. */}
        {onOpenInWorkspaceHistory && !degraded ? (
          <Tooltip content="Open in Workspace History">
            <IconButton
              size="1"
              variant="ghost"
              color="gray"
              data-diff-open-workspace-history=""
              aria-label={`Open ${file.path} in Workspace History`}
              onClick={() => onOpenInWorkspaceHistory(file, entry)}
              style={{ flexShrink: 0, margin: "0 6px" }}
            >
              <ExternalLinkIcon />
            </IconButton>
          </Tooltip>
        ) : null}
      </Flex>

      {degraded ? (
        <DegradedFileNote
          file={file}
          entry={entry}
          onOpenInWorkspaceHistory={onOpenInWorkspaceHistory}
        />
      ) : expanded ? (
        <DiffFileBody diff={diff} />
      ) : null}
    </Box>
  );
}

function DegradedFileNote({
  file,
  entry,
  onOpenInWorkspaceHistory,
}: {
  file: DiffChangedFile;
  entry: DiffReviewEntry;
  onOpenInWorkspaceHistory?: (file: DiffChangedFile, entry: DiffReviewEntry) => void;
}) {
  const reason = file.binary ? "Binary file" : "File too large to render inline";
  return (
    <Flex align="center" justify="between" gap="2" p="2" wrap="wrap" data-diff-degraded="">
      <Text size="1" color="gray">
        {reason} — diffstat only.
      </Text>
      {onOpenInWorkspaceHistory ? (
        <Button
          size="1"
          variant="soft"
          color="gray"
          onClick={() => onOpenInWorkspaceHistory(file, entry)}
        >
          <ExternalLinkIcon />
          Open in Workspace History
        </Button>
      ) : null}
    </Flex>
  );
}

function DiffFileBody({ diff }: { diff: FileDiffState }) {
  if (diff.status === "loading") {
    return (
      <Box p="2">
        <Text size="1" color="gray">
          Loading diff…
        </Text>
      </Box>
    );
  }
  if (diff.status === "error") {
    return (
      <Box p="2">
        <Text size="1" style={{ color: "var(--red-11)" }}>
          Could not render file diff: {diff.error}
        </Text>
      </Box>
    );
  }
  if (!diff.result) return null;
  return <UnifiedDiff rows={diff.result.rows} highlight={diff.highlight} />;
}

function UnifiedDiff({ rows, highlight }: { rows: DiffRow[]; highlight: DiffHighlight | null }) {
  return (
    <Box
      data-diff-body=""
      style={{ overflowX: "auto", background: "var(--color-panel-solid, var(--gray-1))" }}
    >
      <table
        style={{
          borderCollapse: "collapse",
          width: "100%",
          fontFamily: "var(--code-font-family, monospace)",
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        <tbody>
          {rows.map((row, index) => {
            const tokens = highlightTokensFor(row, highlight);
            const background =
              row.type === "added"
                ? "var(--green-a3)"
                : row.type === "removed"
                  ? "var(--red-a3)"
                  : "transparent";
            const marker = row.type === "added" ? "+" : row.type === "removed" ? "−" : " ";
            return (
              <tr key={index} data-diff-row={row.type} style={{ background }}>
                <td style={gutterStyle}>{row.oldLineNo ?? ""}</td>
                <td style={gutterStyle}>{row.newLineNo ?? ""}</td>
                <td style={markerStyle} aria-hidden="true">
                  {marker}
                </td>
                <td
                  style={{
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    padding: "0 8px",
                    width: "100%",
                  }}
                >
                  {tokens
                    ? tokens.map((tok, tokIndex) => (
                        <span key={tokIndex} style={tok.color ? { color: tok.color } : undefined}>
                          {tok.content}
                        </span>
                      ))
                    : row.text}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Box>
  );
}

const gutterStyle = {
  width: 1,
  whiteSpace: "nowrap" as const,
  textAlign: "right" as const,
  padding: "0 6px",
  color: "var(--gray-9)",
  userSelect: "none" as const,
  verticalAlign: "top" as const,
};
const markerStyle = {
  width: 1,
  whiteSpace: "nowrap" as const,
  padding: "0 4px",
  color: "var(--gray-10)",
  userSelect: "none" as const,
  verticalAlign: "top" as const,
};

/** Highlighted-line lookups for the old and new blobs, indexed by line number. */
interface DiffHighlight {
  old: HighlightedLine[] | null;
  neu: HighlightedLine[] | null;
}

function highlightTokensFor(row: DiffRow, highlight: DiffHighlight | null): HighlightedLine | null {
  if (!highlight) return null;
  if (row.type === "added" || row.type === "context") {
    if (row.newLineNo && highlight.neu) return highlight.neu[row.newLineNo - 1] ?? null;
  }
  if (row.type === "removed") {
    if (row.oldLineNo && highlight.old) return highlight.old[row.oldLineNo - 1] ?? null;
  }
  if (row.type === "context" && row.oldLineNo && highlight.old) {
    return highlight.old[row.oldLineNo - 1] ?? null;
  }
  return null;
}

interface FileDiffState {
  status: "idle" | "loading" | "ready" | "error";
  result: LineDiffResult | null;
  highlight: DiffHighlight | null;
  error?: string;
}

function decodeBlob(value: string | Uint8Array): string {
  if (typeof value === "string") return value;
  return new TextDecoder("utf-8", { fatal: false }).decode(value);
}

/**
 * Fetch the file's blob(s) by the payload hashes, line-diff them, then
 * asynchronously upgrade with best-effort highlighting. Passing `file: null`
 * (collapsed / degraded) keeps everything idle so nothing is fetched.
 */
function useFileDiff(
  file: DiffChangedFile | null,
  fetchContent: DiffContentFetcher,
  appearance: HighlightAppearance
): FileDiffState {
  const [state, setState] = useState<FileDiffState>({
    status: "idle",
    result: null,
    highlight: null,
  });
  // Keep the latest fetcher without making it a fetch dependency (its identity
  // may change each render as the host rebuilds closures).
  const fetchRef = useRef(fetchContent);
  fetchRef.current = fetchContent;

  const path = file?.path ?? null;
  const oldHash = file?.oldHash;
  const newHash = file?.newHash;
  const kind = file?.kind;

  useEffect(() => {
    if (!path || !kind) {
      setState({ status: "idle", result: null, highlight: null });
      return;
    }
    let cancelled = false;
    setState({ status: "loading", result: null, highlight: null });

    void (async () => {
      try {
        // Fetch ONLY the hashes carried in the payload for this file.
        const [oldText, newText] = await Promise.all([
          oldHash ? fetchRef.current(oldHash).then(decodeBlob) : Promise.resolve(null),
          newHash ? fetchRef.current(newHash).then(decodeBlob) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        const result =
          kind === "added"
            ? allAdded(newText ?? "")
            : kind === "removed"
              ? allRemoved(oldText ?? "")
              : diffLines(oldText ?? "", newText ?? "");
        setState({ status: "ready", result, highlight: null });

        // Best-effort highlight upgrade — never blocks the diff already shown.
        const [oldHi, newHi] = await Promise.all([
          oldText != null ? highlightBlob(oldText, path, appearance) : Promise.resolve(null),
          newText != null ? highlightBlob(newText, path, appearance) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        if (oldHi || newHi) {
          setState((prev) =>
            prev.status === "ready" ? { ...prev, highlight: { old: oldHi, neu: newHi } } : prev
          );
        }
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "error",
          result: null,
          highlight: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, oldHash, newHash, kind, appearance]);

  return state;
}
