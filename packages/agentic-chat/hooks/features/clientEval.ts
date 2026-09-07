import { z } from "zod";
import type {
  SandboxImportLoader,
  SandboxOptions,
  SandboxResult,
  ScopeManager,
} from "@workspace/eval";
import type { MethodDefinition, MethodExecutionContext } from "@workspace/pubsub";
import type { ChatSandboxValue } from "../../types";

const MAX_RESULT_CHARS = 100_000;
const PREVIEW_CHARS = 20_000;
const LAST_RETURN_KEY = "$lastClientEvalReturn";
const LAST_CONSOLE_KEY = "$lastClientEvalConsole";

export interface ClientEvalDependencies {
  importLoader?: SandboxImportLoader;
  executeSandbox: (code: string, options?: SandboxOptions) => Promise<SandboxResult>;
  loadSourceFile: (path: string) => Promise<string>;
  getChat: () => ChatSandboxValue;
  scopeManager: ScopeManager;
}

interface ClientEvalMethodResult {
  content: Array<{ type: "text"; text: string }>;
  details?: {
    success: boolean;
    failureKind?: SandboxResult["failureKind"];
    failureCode?: string;
  };
}

const clientEvalParameters = z
  .object({
    code: z
      .string()
      .optional()
      .describe("Inline TypeScript or JavaScript. Provide exactly one of code or path."),
    path: z
      .string()
      .optional()
      .describe(
        "Context-relative TypeScript/JavaScript file to execute in this panel. Relative imports resolve from the file."
      ),
    sourcePath: z
      .string()
      .optional()
      .describe("Optional context-relative virtual filename for inline code."),
    syntax: z.enum(["javascript", "typescript", "jsx", "tsx"]).default("tsx"),
    imports: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'On-demand packages. Workspace packages auto-resolve; npm packages use "npm:<version>".'
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Optional wall-clock deadline in milliseconds."),
  })
  .strict()
  .superRefine((value, context) => {
    const hasCode = value.code !== undefined;
    const hasPath = Boolean(value.path?.trim());
    if (hasCode === hasPath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of code or path.",
      });
    }
    if (value.sourcePath && !hasCode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourcePath"],
        message: "sourcePath is only valid with inline code.",
      });
    }
  });

function runtimeHelp(topic?: string): unknown {
  const moduleMap =
    ((globalThis as Record<string, unknown>)["__vibestudioModuleMap__"] as
      | Record<string, unknown>
      | undefined) ?? {};
  if (topic) {
    const runtimeModule = moduleMap["@workspace/runtime"] as Record<string, unknown> | undefined;
    const segments = topic.split(".");
    let value: unknown = moduleMap[topic] ?? runtimeModule?.[segments[0]!];
    for (const segment of segments.slice(1)) {
      value =
        value && (typeof value === "object" || typeof value === "function")
          ? (value as Record<string, unknown>)[segment]
          : undefined;
    }
    return value && (typeof value === "object" || typeof value === "function")
      ? {
          module: topic,
          surface: moduleMap[topic] === value ? "loaded-module" : "runtime-export",
          kind: typeof value,
          exports: Object.keys(value),
        }
      : { module: topic, available: false };
  }
  return {
    executionContext: "inviting-panel",
    preInjected: ["chat", "scope", "scopes", "help"],
    loadedModules: Object.keys(moduleMap).sort(),
    runtimeUsage:
      'Import panel/runtime APIs statically, for example: import { callMain, panel } from "@workspace/runtime".',
  };
}

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function bounded(
  label: string,
  text: string,
  scope: Record<string, unknown>,
  scopeKey: string,
  original: unknown
): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  scope[scopeKey] = original;
  return [
    `[${label} truncated: ${text.length} characters.]`,
    `The complete value is available as scope.${scopeKey}.`,
    "",
    "[preview]",
    text.slice(0, PREVIEW_CHARS),
  ].join("\n");
}

function errorHint(error: string): string {
  const missingRuntimeBinding = error.match(/^([A-Za-z_$][\w$]*) is not defined\b/);
  const runtimeExports = new Set([
    "callMain",
    "contextId",
    "fs",
    "rpc",
    "panel",
    "openPanel",
    "parent",
    "getParent",
  ]);
  const name = missingRuntimeBinding?.[1];
  if (name && runtimeExports.has(name)) {
    return `${error}\nHint: import { ${name} } from "@workspace/runtime";`;
  }
  return error;
}

function executionSignal(
  parent: AbortSignal,
  timeoutMs: number | undefined
): { signal: AbortSignal; dispose: () => void } {
  if (!timeoutMs) return { signal: parent, dispose: () => undefined };
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`client_eval timed out after ${timeoutMs}ms`)),
    timeoutMs
  );
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", abortFromParent);
    },
  };
}

export function buildClientEvalMethod(
  dependencies: ClientEvalDependencies
): MethodDefinition<typeof clientEvalParameters, ClientEvalMethodResult> {
  return {
    description: `Execute TypeScript/JavaScript inside the panel that invited you.

This is client-affine execution: it shares the panel's runtime, filesystem context,
host transport, loaded modules, DOM, and durable panel-local scope. Electron-local
\`callMain\` services therefore resolve through this panel's Electron host. Use
\`client_eval\` when work depends on the current customer's visible client or panel.
Use server-side \`eval\` for durable server work that has no client affinity.

\`chat\`, \`scope\`, \`scopes\`, and \`help\` are pre-injected. Import all runtime
APIs and workspace packages with static imports. \`return\` sends a value back;
\`console.log\` streams output; \`scope\` persists across calls and panel reloads.`,
    parameters: clientEvalParameters,
    streaming: true,
    execute: async (rawArgs, context: MethodExecutionContext) => {
      const args = clientEvalParameters.parse(rawArgs);
      const path = args.path?.trim();
      let code: string;
      try {
        code = path ? await dependencies.loadSourceFile(path) : (args.code ?? "");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text:
                `[client_eval] Error loading ${JSON.stringify(path)} from this panel's ` +
                `context filesystem: ${message}`,
            },
          ],
        };
      }

      const scopeManager = dependencies.scopeManager;
      const scope = scopeManager.current;
      const timeout = executionSignal(context.signal, args.timeoutMs);
      scopeManager.enterEval();
      try {
        const result = await dependencies.executeSandbox(code, {
          syntax: args.syntax,
          signal: timeout.signal,
          ...(args.timeoutMs
            ? { deadline: { atMs: Date.now() + args.timeoutMs, timeoutMs: args.timeoutMs } }
            : {}),
          imports: args.imports,
          ...(dependencies.importLoader ? { loadImport: dependencies.importLoader } : {}),
          sourcePath: path ?? args.sourcePath,
          loadSourceFile: path || args.sourcePath ? dependencies.loadSourceFile : undefined,
          bindings: {
            chat: dependencies.getChat(),
            scope,
            scopes: scopeManager.api,
            help: runtimeHelp,
          },
          onConsole: (formatted) => {
            void context
              .stream({ type: "console", content: formatted })
              .catch((error) => console.warn("[client_eval] console stream failed", error));
          },
        });

        const parts: Array<{ type: "text"; text: string }> = [];
        if (!result.success) {
          parts.push({
            type: "text",
            text: `[client_eval] Error: ${errorHint(result.error ?? "unknown error")}`,
          });
          if (result.errorData !== undefined) {
            parts.push({
              type: "text",
              text: `[client_eval] Failure data:\n${printable(result.errorData)}`,
            });
          }
        }
        if (result.consoleOutput) {
          parts.push({
            type: "text",
            text: `[client_eval] Console:\n${bounded(
              "Console",
              result.consoleOutput,
              scope,
              LAST_CONSOLE_KEY,
              result.consoleOutput
            )}`,
          });
        }
        if (result.success && result.returnValue !== undefined) {
          const formatted = printable(result.returnValue);
          parts.push({
            type: "text",
            text: `[client_eval] Return value:\n${bounded(
              "Return value",
              formatted,
              scope,
              LAST_RETURN_KEY,
              result.returnValue
            )}`,
          });
        }
        if (result.panelJournalFooter) {
          parts.push({ type: "text", text: result.panelJournalFooter });
        }
        if (parts.length === 0) {
          parts.push({ type: "text", text: "[client_eval] (no output)" });
        }
        const keys = Object.keys(scope);
        parts.push({
          type: "text",
          text: keys.length
            ? `[scope] keys: ${keys.join(", ")} (${keys.length} total)`
            : "[scope] (empty)",
        });
        return {
          content: parts,
          details: {
            success: result.success,
            ...(result.failureKind ? { failureKind: result.failureKind } : {}),
            ...(result.failureCode ? { failureCode: result.failureCode } : {}),
          },
        };
      } finally {
        timeout.dispose();
        await scopeManager.exitEval();
      }
    },
  };
}
