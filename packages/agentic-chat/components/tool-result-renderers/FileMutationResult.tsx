import React from "react";
import { Badge, Box, Code, Flex, Text } from "@radix-ui/themes";
import { CodePreview } from "../shared/CodePreview";
import { CollapsibleSection } from "../shared/CollapsibleSection";

type RecordValue = Record<string, unknown>;

interface MutationOperation {
  operation: number;
  path: string;
  kind: string;
  status: "created" | "changed" | "deleted" | "unchanged";
  bytesWritten?: number;
  firstChangedLine?: number;
  diff?: string;
  diffTruncated?: boolean;
  diffOriginalChars?: number;
  matches?: Array<{ replacement: number; mode: "exact" | "normalized"; line: number }>;
}

interface MutationConflict {
  operation: number;
  path: string;
  reason: string;
  message: string;
  matchMode?: string;
  matchCount?: number;
  candidateLines?: number[];
  requestedText?: string;
  suggestedScratchPath?: string;
  closestCurrentExcerpts?: Array<{ startLine: number; endLine: number; text: string }>;
  recovery?: { action?: string; instruction?: string };
}

export interface FileMutationDetails {
  protocol: "file-mutation.v1";
  status: "applied" | "unchanged" | "conflict";
  storage: "vcs" | "scratch";
  intent?: string;
  operations: MutationOperation[];
  conflicts: MutationConflict[];
  vcsResult?: {
    workUnitId?: string;
    applicationId?: string;
    changeIds?: string[];
    workingHead?: unknown;
  };
}

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

export function extractFileMutationDetails(result: unknown): FileMutationDetails | null {
  const outer = record(result);
  const candidate = record(outer?.["details"]) ?? outer;
  if (
    candidate?.["protocol"] !== "file-mutation.v1" ||
    !Array.isArray(candidate["operations"]) ||
    !Array.isArray(candidate["conflicts"])
  ) {
    return null;
  }
  return candidate as unknown as FileMutationDetails;
}

function languageForPath(path: string): "typescript" | "javascript" | "json" | "bash" | "text" {
  if (/\.(?:ts|tsx|mts|cts)$/iu.test(path)) return "typescript";
  if (/\.(?:js|jsx|mjs|cjs)$/iu.test(path)) return "javascript";
  if (/\.(?:json|jsonc)$/iu.test(path)) return "json";
  if (/\.(?:sh|bash|zsh)$/iu.test(path)) return "bash";
  return "text";
}

function compact(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function statusColor(
  status: FileMutationDetails["status"] | MutationOperation["status"]
): "green" | "amber" | "gray" | "red" {
  if (status === "conflict") return "amber";
  if (status === "unchanged") return "gray";
  if (status === "deleted") return "red";
  return "green";
}

function ArgumentSummary({ args }: { args: RecordValue }) {
  const intent = typeof args["intent"] === "string" ? args["intent"] : undefined;
  return (
    <Flex direction="column" gap="1">
      {typeof args["path"] === "string" && (
        <Flex gap="2" align="center" wrap="wrap">
          <Text size="1" color="gray">
            Path
          </Text>
          <Code size="1">{args["path"]}</Code>
        </Flex>
      )}
      {intent && (
        <Flex gap="2" align="start">
          <Text size="1" color="gray">
            Intent
          </Text>
          <Text size="1">{intent}</Text>
        </Flex>
      )}
    </Flex>
  );
}

function WriteArguments({ args }: { args: RecordValue }) {
  const path = typeof args["path"] === "string" ? args["path"] : "file";
  const content = typeof args["content"] === "string" ? args["content"] : "";
  return (
    <Flex direction="column" gap="2" data-testid="file-mutation-arguments">
      <ArgumentSummary args={args} />
      <Flex gap="2" wrap="wrap">
        <Badge size="1" color="gray" variant="outline">
          {content.length.toLocaleString()} chars
        </Badge>
        {args["createOnly"] === true && (
          <Badge size="1" color="amber">
            create only
          </Badge>
        )}
        {typeof args["mode"] === "number" && (
          <Badge size="1" color="gray">
            mode {args["mode"]}
          </Badge>
        )}
      </Flex>
      <CodePreview code={content} language={languageForPath(path)} label="Complete file content" />
    </Flex>
  );
}

function EditArguments({ args }: { args: RecordValue }) {
  const path = typeof args["path"] === "string" ? args["path"] : "file";
  const oldText = typeof args["oldText"] === "string" ? args["oldText"] : "";
  const newText = typeof args["newText"] === "string" ? args["newText"] : "";
  return (
    <Flex direction="column" gap="2" data-testid="file-mutation-arguments">
      <ArgumentSummary args={args} />
      <CodePreview code={oldText} language={languageForPath(path)} label="Find one occurrence" />
      <CodePreview code={newText} language={languageForPath(path)} label="Replace with" />
    </Flex>
  );
}

function PatchArguments({ args }: { args: RecordValue }) {
  const operations = Array.isArray(args["operations"]) ? args["operations"] : [];
  return (
    <Flex direction="column" gap="2" data-testid="file-mutation-arguments">
      <ArgumentSummary args={args} />
      <Text size="1" color="gray">
        {operations.length} atomic operation{operations.length === 1 ? "" : "s"}
      </Text>
      {operations.map((raw, index) => {
        const operation = record(raw) ?? {};
        const kind = typeof operation["kind"] === "string" ? operation["kind"] : "operation";
        const path =
          typeof operation["path"] === "string" ? operation["path"] : `operation ${index + 1}`;
        const replacements = Array.isArray(operation["replacements"])
          ? operation["replacements"]
          : [];
        return (
          <Box
            key={`${index}:${path}`}
            style={{ border: "1px solid var(--gray-a5)", borderRadius: 5, padding: 7 }}
          >
            <Flex gap="2" align="center" wrap="wrap">
              <Badge size="1" color="gray">
                {kind}
              </Badge>
              <Code size="1">{path}</Code>
            </Flex>
            {typeof operation["content"] === "string" && (
              <CollapsibleSection
                label={`Content (${operation["content"].length.toLocaleString()} chars)`}
                defaultOpen={operations.length === 1}
              >
                <CodePreview
                  code={operation["content"]}
                  language={languageForPath(path)}
                  label="Complete file content"
                />
              </CollapsibleSection>
            )}
            {replacements.map((rawReplacement, replacementIndex) => {
              const replacement = record(rawReplacement) ?? {};
              return (
                <Box key={replacementIndex} mt="2">
                  <CodePreview
                    code={String(replacement["oldText"] ?? "")}
                    language={languageForPath(path)}
                    label={`Find ${replacementIndex + 1}`}
                  />
                  <Box mt="1">
                    <CodePreview
                      code={String(replacement["newText"] ?? "")}
                      language={languageForPath(path)}
                      label="Replace with"
                    />
                  </Box>
                </Box>
              );
            })}
          </Box>
        );
      })}
    </Flex>
  );
}

export function renderFileMutationArguments(
  toolName: string,
  args: RecordValue
): React.ReactNode | null {
  if (toolName === "write") return <WriteArguments args={args} />;
  if (toolName === "edit") return <EditArguments args={args} />;
  if (toolName === "apply_patch") return <PatchArguments args={args} />;
  return null;
}

function ConflictView({ conflict }: { conflict: MutationConflict }) {
  return (
    <Box
      style={{
        border: "1px solid var(--amber-a7)",
        borderRadius: 5,
        background: "var(--amber-a2)",
        padding: 8,
      }}
    >
      <Flex gap="2" align="center" wrap="wrap">
        <Badge size="1" color="amber">
          {conflict.reason.replace(/-/gu, " ")}
        </Badge>
        <Code size="1">{conflict.path}</Code>
        {conflict.matchMode && (
          <Badge size="1" color="gray">
            {conflict.matchMode} match
          </Badge>
        )}
      </Flex>
      <Text size="1" mt="1" style={{ display: "block" }}>
        {conflict.message}
      </Text>
      {conflict.candidateLines && conflict.candidateLines.length > 0 && (
        <Text size="1" color="gray" style={{ display: "block" }}>
          Candidate lines: {conflict.candidateLines.join(", ")}
        </Text>
      )}
      {conflict.suggestedScratchPath && (
        <Text size="1" color="gray" style={{ display: "block" }}>
          Scratch alternative: <Code size="1">{conflict.suggestedScratchPath}</Code>
        </Text>
      )}
      {conflict.recovery?.instruction && (
        <Text size="1" color="amber" mt="1" style={{ display: "block" }}>
          {conflict.recovery.instruction}
        </Text>
      )}
      {(conflict.closestCurrentExcerpts ?? []).map((excerpt, index) => (
        <Box key={index} mt="2">
          <CodePreview
            code={excerpt.text}
            language="text"
            label={`Current lines ${excerpt.startLine}–${excerpt.endLine}`}
          />
        </Box>
      ))}
    </Box>
  );
}

function OperationView({ operation }: { operation: MutationOperation }) {
  return (
    <Box style={{ borderTop: "1px solid var(--gray-a4)", paddingTop: 6 }}>
      <Flex align="center" gap="2" wrap="wrap">
        <Badge size="1" color={statusColor(operation.status)}>
          {operation.status}
        </Badge>
        <Badge size="1" color="gray" variant="outline">
          {operation.kind.replace(/_/gu, " ")}
        </Badge>
        <Code size="1">{operation.path}</Code>
        {typeof operation.bytesWritten === "number" && (
          <Text size="1" color="gray">
            {operation.bytesWritten.toLocaleString()} bytes
          </Text>
        )}
      </Flex>
      {(operation.matches ?? []).map((match) => (
        <Text
          key={match.replacement}
          size="1"
          color={match.mode === "normalized" ? "amber" : "gray"}
          style={{ display: "block", marginTop: 3 }}
        >
          Replacement {match.replacement + 1}: {match.mode} match at line {match.line}
        </Text>
      ))}
      {operation.diff && (
        <Box mt="2">
          <CodePreview
            code={operation.diff}
            language="text"
            label={
              operation.firstChangedLine
                ? `Diff · first change line ${operation.firstChangedLine}`
                : "Diff"
            }
          />
        </Box>
      )}
      {operation.diffTruncated && (
        <Text size="1" color="amber" style={{ display: "block", marginTop: 4 }}>
          Diff preview truncated
          {typeof operation.diffOriginalChars === "number"
            ? ` from ${operation.diffOriginalChars.toLocaleString()} characters`
            : ""}
          . The file mutation itself was applied in full.
        </Text>
      )}
    </Box>
  );
}

function VcsEvidence({ details }: { details: FileMutationDetails }) {
  const vcs = details.vcsResult;
  if (details.storage !== "vcs" || !vcs) return null;
  return (
    <CollapsibleSection label="Semantic VCS evidence" defaultOpen={false}>
      <Flex direction="column" gap="1">
        {details.intent && (
          <Text size="1">
            <Text color="gray">Intent: </Text>
            {details.intent}
          </Text>
        )}
        {vcs.workUnitId && (
          <Text size="1">
            <Text color="gray">Work unit: </Text>
            <Code size="1">{vcs.workUnitId}</Code>
          </Text>
        )}
        {vcs.applicationId && (
          <Text size="1">
            <Text color="gray">Application: </Text>
            <Code size="1">{vcs.applicationId}</Code>
          </Text>
        )}
        {vcs.changeIds && vcs.changeIds.length > 0 && (
          <Text size="1">
            <Text color="gray">Changes: </Text>
            {vcs.changeIds.map((id) => (
              <Code key={id} size="1" mr="1">
                {id}
              </Code>
            ))}
          </Text>
        )}
        {vcs.workingHead !== undefined && vcs.workingHead !== null && (
          <CodePreview
            code={JSON.stringify(vcs.workingHead, null, 2)}
            language="json"
            label="Resulting working head"
          />
        )}
      </Flex>
    </CollapsibleSection>
  );
}

export function FileMutationResultView({ details }: { details: FileMutationDetails }) {
  return (
    <Flex direction="column" gap="2" data-testid="file-mutation-result">
      <Flex align="center" gap="2" wrap="wrap">
        <Badge size="1" color={statusColor(details.status)}>
          {details.status}
        </Badge>
        <Badge size="1" color={details.storage === "vcs" ? "blue" : "gray"} variant="soft">
          {details.storage === "vcs" ? "semantic VCS" : "scratch"}
        </Badge>
        {details.intent && (
          <Text size="1" color="gray">
            {compact(details.intent, 140)}
          </Text>
        )}
      </Flex>
      {details.conflicts.map((conflict, index) => (
        <ConflictView key={`${index}:${conflict.path}`} conflict={conflict} />
      ))}
      {details.operations.map((operation) => (
        <OperationView key={`${operation.operation}:${operation.path}`} operation={operation} />
      ))}
      <VcsEvidence details={details} />
    </Flex>
  );
}

export function renderFileMutationToolResult(
  toolName: string,
  result: unknown
): React.ReactNode | null {
  if (toolName !== "write" && toolName !== "edit" && toolName !== "apply_patch") return null;
  const details = extractFileMutationDetails(result);
  return details ? <FileMutationResultView details={details} /> : null;
}
