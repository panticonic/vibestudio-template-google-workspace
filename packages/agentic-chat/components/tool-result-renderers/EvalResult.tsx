import React, { useMemo } from "react";
import { Badge, Box, Code, Flex, Text } from "@radix-ui/themes";
import { InfoCircledIcon } from "@radix-ui/react-icons";
import type { ChatSandboxValue } from "@workspace/agentic-core";
import { CodePreview } from "../shared/CodePreview";
import { CollapsibleSection } from "../shared/CollapsibleSection";
import { ToolDataView } from "../shared/ToolDataView";

interface EvalRunDetails {
  success: boolean;
  console?: string;
  returnValue?: unknown;
  error?: string;
  scopeKeys?: string[];
}

interface BoundedEvalItem {
  label: string;
  scopeKey: string;
  reason?: string;
  originalChars?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isEvalRunDetails(value: unknown): value is EvalRunDetails {
  const record = asRecord(value);
  return !!record && typeof record["success"] === "boolean";
}

function textFromProtocolContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .map((item) => {
      const record = asRecord(item);
      return record?.["type"] === "text" && typeof record["text"] === "string"
        ? record["text"]
        : undefined;
    })
    .filter((text): text is string => text !== undefined);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractEvalResult(result: unknown): {
  details?: EvalRunDetails;
  protocolText?: string;
} {
  const record = asRecord(result);
  if (!record) return {};

  const details = isEvalRunDetails(record["details"])
    ? record["details"]
    : isEvalRunDetails(result)
      ? result
      : undefined;
  const protocolText =
    textFromProtocolContent(record["protocolContent"]) ??
    textFromProtocolContent(record["content"]);

  return { details, protocolText };
}

function truncatedReturnItem(value: unknown): BoundedEvalItem | null {
  const record = asRecord(value);
  if (!record || record["truncated"] !== true || typeof record["scopeKey"] !== "string") {
    return null;
  }
  return {
    label: "Return value",
    scopeKey: record["scopeKey"],
    reason: typeof record["reason"] === "string" ? record["reason"] : undefined,
    originalChars:
      typeof record["originalChars"] === "number" ? record["originalChars"] : undefined,
  };
}

function truncatedTextItem(
  label: string,
  text: string | undefined,
  scopeKey: string
): BoundedEvalItem | null {
  if (!text) return null;
  const hasRecoveryPointer = text.includes(`scope.${scopeKey}`);
  const saysTruncated = text.includes("eval output truncated") || text.includes("Result exceeded");
  return hasRecoveryPointer && saysTruncated ? { label, scopeKey } : null;
}

function boundedEvalItems(details: EvalRunDetails | undefined): BoundedEvalItem[] {
  if (!details) return [];
  return [
    truncatedReturnItem(details.returnValue),
    truncatedTextItem("Console", details.console, "$lastConsole"),
    truncatedTextItem("Error", details.error, "$lastConsole"),
  ].filter((item): item is BoundedEvalItem => item !== null);
}

function scopeExpression(scopeKey: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(scopeKey)
    ? `scope.${scopeKey}`
    : `scope[${JSON.stringify(scopeKey)}]`;
}

function readSnippet(scopeKey: string): string {
  const target = scopeExpression(scopeKey);
  return `return ${target}.slice(0, 40000);`;
}

function formatChars(chars: number | undefined): string | null {
  return typeof chars === "number" ? `${chars.toLocaleString()} chars` : null;
}

function BoundedEvalNotice({ items }: { items: BoundedEvalItem[] }) {
  if (items.length === 0) return null;

  return (
    <Box
      data-testid="eval-bounded-output"
      style={{
        border: "1px solid var(--amber-a6)",
        borderRadius: 4,
        background: "var(--amber-a2)",
        padding: "8px",
      }}
    >
      <Flex direction="column" gap="2">
        <Flex align="center" gap="2" wrap="wrap">
          <Text color="amber" style={{ display: "inline-flex", alignItems: "center" }}>
            <InfoCircledIcon />
          </Text>
          <Text size="1" color="amber" weight="medium">
            Bounded eval output
          </Text>
          <Badge size="1" color="amber" variant="soft">
            {items.length} saved {items.length === 1 ? "buffer" : "buffers"}
          </Badge>
        </Flex>

        <Text size="1" color="gray">
          Large output was clipped before chat rendering. Page the saved scope value in a follow-up
          eval.
        </Text>

        {items.map((item) => {
          const charLabel = formatChars(item.originalChars);
          return (
            <Box key={`${item.label}:${item.scopeKey}`}>
              <Flex align="center" gap="2" wrap="wrap" mb="1">
                <Text size="1" weight="medium">
                  {item.label}
                </Text>
                <Code size="1">scope.{item.scopeKey}</Code>
                {charLabel && (
                  <Badge size="1" color="gray" variant="outline">
                    {charLabel}
                  </Badge>
                )}
                {item.reason && (
                  <Text size="1" color="gray">
                    {item.reason}
                  </Text>
                )}
              </Flex>
              <CodePreview
                code={readSnippet(item.scopeKey)}
                language="typescript"
                label={`Read scope.${item.scopeKey}`}
              />
            </Box>
          );
        })}
      </Flex>
    </Box>
  );
}

export function EvalResultView({
  result,
  chat,
}: {
  result: unknown;
  chat?: Partial<Pick<ChatSandboxValue, "rpc">> | null;
}) {
  const { details, protocolText } = useMemo(() => extractEvalResult(result), [result]);
  const boundedItems = useMemo(() => boundedEvalItems(details), [details]);

  return (
    <Flex direction="column" gap="2">
      <BoundedEvalNotice items={boundedItems} />

      {protocolText && (
        <CodePreview code={protocolText} language="text" label="Agent-visible output" wrap={true} />
      )}

      {details ? (
        <CollapsibleSection label="Structured details" defaultOpen={!protocolText}>
          <ToolDataView value={details} label="Details" chat={chat} />
        </CollapsibleSection>
      ) : (
        <ToolDataView value={result} label="Result" chat={chat} />
      )}
    </Flex>
  );
}

export function renderEvalToolResult(
  toolName: string,
  result: unknown,
  chat?: Partial<Pick<ChatSandboxValue, "rpc">> | null
): React.ReactNode | null {
  if (toolName !== "eval") return null;
  const { details, protocolText } = extractEvalResult(result);
  if (!details && !protocolText) return null;
  return <EvalResultView result={result} chat={chat} />;
}
