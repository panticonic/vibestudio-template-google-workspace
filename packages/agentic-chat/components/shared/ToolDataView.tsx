import { useMemo } from "react";
import { Box, Flex, Text } from "@radix-ui/themes";
import { isStoredValueRef, type StoredValueRef } from "@workspace/agentic-protocol";
import type { ChatSandboxValue } from "@workspace/agentic-core";
import { CodePreview, type CodePreviewLanguage } from "./CodePreview";

function stableStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function languageForField(name: string, value: unknown): CodePreviewLanguage {
  if (typeof value !== "string") return "json";
  const lower = name.toLowerCase();
  if (lower === "code" || lower.endsWith("source") || lower.includes("typescript")) {
    return "typescript";
  }
  if (lower === "command" || lower === "cmd" || lower === "script" || lower.includes("shell")) {
    return "bash";
  }
  if (
    lower.includes("json") ||
    lower === "args" ||
    lower === "arguments" ||
    lower === "props" ||
    lower === "imports"
  ) {
    return "json";
  }
  return "text";
}

function renderableValue(value: unknown): { code: string; language: CodePreviewLanguage } {
  if (typeof value === "string") {
    const parsed = parseMaybeJson(value);
    if (parsed !== value) return { code: stableStringify(parsed), language: "json" };
    return { code: value, language: "text" };
  }
  return { code: stableStringify(value), language: "json" };
}

function StoredValueView({
  value,
  label,
}: {
  value: StoredValueRef;
  label: string;
}) {
  const fallback = {
    protocol: value.protocol,
    digest: value.digest,
    size: value.size,
    encoding: value.encoding,
    originalBytes: value.originalBytes,
  };
  return (
    <Box>
      <Flex mb="1" gap="2" align="center">
        <Text size="1" color="red">
          Stored value reached transcript UI; upstream storage hydration failed.
        </Text>
      </Flex>
      <CodePreview code={stableStringify(fallback)} language="json" label={label} />
    </Box>
  );
}

export function ToolDataView({
  value,
  label,
  chat: _chat,
  fieldName,
}: {
  value: unknown;
  label: string;
  chat?: Partial<Pick<ChatSandboxValue, "rpc">> | null;
  fieldName?: string;
}) {
  const rendered = useMemo(() => {
    if (fieldName) {
      const language = languageForField(fieldName, value);
      return {
        code: language === "json" ? stableStringify(value) : String(value ?? ""),
        language,
      };
    }
    return renderableValue(value);
  }, [fieldName, value]);

  if (isStoredValueRef(value)) {
    return <StoredValueView value={value} label={label} />;
  }

  return <CodePreview code={rendered.code} language={rendered.language} label={label} wrap={rendered.language === "text"} />;
}

export function ToolArgumentsView({
  args,
  chat,
}: {
  args: Record<string, unknown>;
  chat?: Partial<Pick<ChatSandboxValue, "rpc">> | null;
}) {
  const entries = Object.entries(args);
  if (entries.length === 0) return null;
  return (
    <Flex direction="column" gap="2">
      {entries.map(([key, value]) => (
        <ToolDataView key={key} value={value} fieldName={key} label={key} chat={chat} />
      ))}
      {entries.length > 1 && (
        <ToolDataView value={args} label="All arguments" chat={chat} />
      )}
    </Flex>
  );
}
