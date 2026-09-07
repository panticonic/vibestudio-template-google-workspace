import { getStateArgs } from "./stateArgs.js";
import { openPanel, panelTree } from "./handle.js";

export interface PanelRenderErrorDiagnosticRequest {
  surfaceName?: string;
  errorName?: string;
  errorMessage: string;
  errorStack?: string;
  componentStack?: string;
  locationHref?: string;
  userAgent?: string;
  timestamp?: string;
}

export interface PanelErrorDiagnosticChatResult {
  panelId: string;
  title: string;
  prompt: string;
}

export type PanelErrorDiagnosticLauncher = (
  request: PanelRenderErrorDiagnosticRequest
) => Promise<PanelErrorDiagnosticChatResult>;

interface PanelErrorDiagnosticLauncherGlobal {
  __vibestudioPanelErrorDiagnostics?: PanelErrorDiagnosticLauncher;
}

interface CaptureOk<T> {
  ok: true;
  value: T;
}

interface CaptureErr {
  ok: false;
  error: string;
}

type CaptureResult<T> = CaptureOk<T> | CaptureErr;

const MAX_PROMPT_CHARS = 60_000;
const MAX_STRING_CHARS = 8_000;
const MAX_OBJECT_KEYS = 80;
const MAX_ARRAY_ITEMS = 80;
const MAX_DEPTH = 6;
const REDACTED = "[redacted]";
const SENSITIVE_KEY_RE = /(?:token|secret|password|credential|api[_-]?key|authorization|cookie)/i;

export function installPanelErrorDiagnosticLauncher(options: {
  slotId: string;
  contextId?: string | null;
}): void {
  const g = globalThis as typeof globalThis & PanelErrorDiagnosticLauncherGlobal;
  g.__vibestudioPanelErrorDiagnostics = (request) => openPanelErrorDiagnosticChat(request, options);
}

export async function openPanelErrorDiagnosticChat(
  request: PanelRenderErrorDiagnosticRequest,
  options: { slotId: string; contextId?: string | null }
): Promise<PanelErrorDiagnosticChatResult> {
  const self = panelTree.self();
  const [diagnostics, stateArgs] = await Promise.all([
    capture("panel diagnostics", () => self.diagnose()),
    capture("panel stateArgs", async () => {
      try {
        return await self.stateArgs.get<Record<string, unknown>>();
      } catch {
        return getStateArgs<Record<string, unknown>>();
      }
    }),
  ]);

  const prompt = buildPanelRenderErrorPrompt({
    request,
    panel: diagnostics.ok
      ? { ok: true, value: diagnostics.value.observation }
      : diagnostics,
    stateArgs,
    consoleHistory: diagnostics.ok
      ? { ok: true, value: diagnostics.value.consoleHistory }
      : diagnostics,
  });
  const panelContextId = diagnostics.ok
    ? diagnostics.value.observation.contextId
    : options.contextId;
  const debugChat = await openPanel("panels/chat", {
    parentId: options.slotId,
    focus: true,
    title: "Panel error debug",
    ...(panelContextId ? { contextId: panelContextId } : {}),
    stateArgs: { initialPrompt: prompt },
  });

  return {
    panelId: debugChat.id,
    title: debugChat.title,
    prompt,
  };
}

export function buildPanelRenderErrorPrompt(input: {
  request: PanelRenderErrorDiagnosticRequest;
  panel: CaptureResult<unknown>;
  stateArgs: CaptureResult<unknown>;
  consoleHistory: CaptureResult<unknown>;
}): string {
  const request = input.request;
  const surfaceName = request.surfaceName ?? "panel";
  const errorText = [
    `${request.errorName ?? "Error"}: ${request.errorMessage}`,
    request.errorStack ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const prompt = [
    `A Vibestudio ${surfaceName} hit a React render error and opened this child chat for debugging.`,
    "",
    "Your task:",
    "1. Inspect the failing panel source and the recent local changes.",
    "2. Reproduce or reason through the crash using the diagnostics below.",
    "3. Fix the root cause in the workspace, not just the fallback UI.",
    "4. Run the most focused relevant tests, type checks, or build checks.",
    "5. Report the fix and any verification gaps.",
    "",
    "Do not ask for more information unless the local repo and diagnostics are insufficient.",
    "",
    jsonSection("Runtime panel context", {
      capturedAt: request.timestamp ?? new Date().toISOString(),
      locationHref: request.locationHref,
      userAgent: request.userAgent,
      panel: captureForPrompt(input.panel),
    }),
    textSection("Thrown error", errorText),
    textSection("React component stack", request.componentStack ?? "(not captured)"),
    jsonSection("Panel stateArgs", captureForPrompt(input.stateArgs)),
    jsonSection("Panel console history", captureForPrompt(input.consoleHistory)),
  ].join("\n");
  return truncate(prompt, MAX_PROMPT_CHARS);
}

async function capture<T>(label: string, fn: () => Promise<T>): Promise<CaptureResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: `${label}: ${errorToString(error)}` };
  }
}

function captureForPrompt(result: CaptureResult<unknown>): unknown {
  if (!result.ok) return { unavailable: result.error };
  return sanitizeForPrompt(result.value);
}

function jsonSection(label: string, value: unknown): string {
  return `${label}:\n\`\`\`json\n${stringifyForPrompt(value)}\n\`\`\``;
}

function textSection(label: string, value: string): string {
  return `${label}:\n\`\`\`\n${sanitizeText(value)}\n\`\`\``;
}

function stringifyForPrompt(value: unknown): string {
  try {
    return JSON.stringify(sanitizeForPrompt(value), null, 2) ?? "null";
  } catch (error) {
    return JSON.stringify({ unavailable: errorToString(error) }, null, 2);
  }
}

function sanitizeForPrompt(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return sanitizeText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return `[${typeof value}]`;
  if (depth >= MAX_DEPTH) return "[truncated: max depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeForPrompt(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[truncated: ${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return items;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
    out[key] = SENSITIVE_KEY_RE.test(key)
      ? REDACTED
      : sanitizeForPrompt(entryValue, depth + 1, seen);
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    out["__truncated"] = `${entries.length - MAX_OBJECT_KEYS} more keys`;
  }
  return out;
}

function sanitizeText(value: string): string {
  return truncate(redactLikelySecrets(value), MAX_STRING_CHARS);
}

function redactLikelySecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|ghp|xox[baprs])-?[A-Za-z0-9_=-]{12,}/g, REDACTED);
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated: ${value.length - maxChars} chars]`;
}

function errorToString(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ? `${error.name}: ${error.message}\n${error.stack}` : error.message;
  }
  return String(error);
}
