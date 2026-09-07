/**
 * Pure formatting utilities for action argument display.
 * No React dependency — these are plain string transformations.
 */

export function truncateStr(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

export function formatArgValue(value: unknown, maxLen = 30): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (value.includes("/")) {
      const parts = value.split("/");
      const filename = parts.pop() || "";
      if (filename.length <= maxLen) return filename;
      return "..." + filename.slice(-(maxLen - 3));
    }
    return truncateStr(value, maxLen);
  }
  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    return `{${keys.length} fields}`;
  }
  return truncateStr(String(value), maxLen);
}

const PRIORITY_KEYS = ["file_path", "path", "command", "query", "pattern", "url", "code", "content", "message", "name", "title"];

export function formatArgsSummary(args: unknown, maxLen = 60): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return truncateStr(String(args), maxLen);

  const obj = args as Record<string, unknown>;
  const entries = Object.entries(obj);
  if (entries.length === 0) return "";

  entries.sort((a, b) => {
    const aIdx = PRIORITY_KEYS.indexOf(a[0]);
    const bIdx = PRIORITY_KEYS.indexOf(b[0]);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return 0;
  });

  const parts: string[] = [];
  let totalLen = 0;

  for (const [key, value] of entries) {
    const formattedValue = formatArgValue(value);
    if (!formattedValue) continue;

    const part = `${key}: ${formattedValue}`;
    if (totalLen + part.length > maxLen && parts.length > 0) {
      parts.push("...");
      break;
    }
    parts.push(part);
    totalLen += part.length + 2;
  }

  return parts.join(", ");
}

export function formatInvocationPreview(args: unknown, description?: string, maxLen = 96): string {
  const normalizedDescription = description?.replace(/\s+/g, " ").trim();
  if (normalizedDescription) return truncateStr(normalizedDescription, maxLen);
  return formatArgsSummary(args, maxLen);
}
