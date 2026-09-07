/**
 * Grep tool — workerd-native rewrite of pi-coding-agent's
 * `dist/core/tools/grep.js`.
 *
 * The upstream tool spawns ripgrep via `child_process.spawn`. workerd has
 * neither `child_process` nor any native binary, so active agent runs route
 * through the context-scoped host filesystem service. Environments without
 * that service fall back to walking the same `RuntimeFs` and applying the
 * regex locally. The
 * schema, details type, and output formatting match the upstream tool so
 * chat-UI renderers don't have to special-case either backend.
 *
 * Upstream reference: `@mariozechner/pi-coding-agent@0.67.x`
 * `dist/core/tools/grep.js`; prebuilt tool exports were removed in Pi 0.68,
 * and current `@workspace/pi-core` does not ship this file tool.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import path from "node:path";
import type { RpcCaller } from "@vibestudio/rpc";
import type { RuntimeFs } from "./runtime-fs.js";
import { resolveToCwd } from "./path-utils.js";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  truncateHead,
  truncateLine,
  type TruncationResult,
} from "./truncate.js";
import { walkSearchFiles } from "./search-walk.js";
import type { AgentFileVisibility } from "./agent-file-visibility.js";
import { decodeUtf8 } from "./portable-bytes.js";

// ---------------------------------------------------------------------------
// RE2 loader — preferred linear-time matcher. Falls back to `RegExp` when
// the native build is unavailable (no toolchain, prebuilt missing for
// platform, etc.). The fallback is announced once via stderr at startup so
// operators can trace ReDoS-mitigation status without spamming logs per
// call.
// ---------------------------------------------------------------------------

type RegexLike = { test(input: string): boolean };

interface Re2Ctor {
  new (source: string, flags?: string): RegexLike;
}

let RE2: Re2Ctor | null = null;
let re2WarningEmitted = false;

try {
  // Use createRequire so that environments without the optional native
  // dependency (e.g. workerd, CI on alpine, or a dependency projection that
  // intentionally disables native install scripts) keep working with the
  // structural-shape fallback below.
  const { createRequire } = await import("node:module");
  const requireFn = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = requireFn("re2");
  RE2 = (mod && typeof mod === "function" ? mod : mod?.default) as Re2Ctor;
  if (typeof RE2 !== "function") RE2 = null;
} catch {
  RE2 = null;
}

type Re2FallbackRuntime = {
  navigator?: { userAgent?: string };
  process?: { versions?: { node?: string } };
  WebSocketPair?: unknown;
};

export function shouldWarnRe2Fallback(runtime: Re2FallbackRuntime = globalThis): boolean {
  const hasNodeVersion = typeof runtime.process?.versions?.node === "string";
  if (!hasNodeVersion) return false;

  const userAgent = runtime.navigator?.userAgent ?? "";
  if (/\b(?:Cloudflare-Workers|workerd)\b/i.test(userAgent)) return false;

  // workerd exposes Cloudflare Worker globals and cannot load native Node
  // addons even with nodejs_compat enabled. In that runtime, the guarded V8
  // fallback is expected rather than an operator-actionable install problem.
  if (typeof runtime.WebSocketPair !== "undefined") return false;

  return true;
}

function warnFallbackOnce(): void {
  if (re2WarningEmitted) return;
  if (!shouldWarnRe2Fallback()) return;
  re2WarningEmitted = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[harness/grep] `re2` native binding not available — falling back to V8 RegExp. " +
      "Pattern length is capped and structural ReDoS shapes are rejected, but matching is " +
      "no longer guaranteed linear-time. Native RE2 acceleration must be provisioned by " +
      "the active runtime dependency environment."
  );
}

/** Exposed for `find.ts` so it can apply the same RE2 / fallback policy. */
export function isRe2Available(): boolean {
  return RE2 !== null;
}

/**
 * Compile a user-supplied regex source. Applies the structural-shape
 * pre-check first (cheap defence-in-depth) and then uses `re2` if
 * available, otherwise the V8 `RegExp` — emitting a one-shot warning the
 * first time the fallback path is taken.
 */
export function compileUserRegex(source: string, flags: string): RegexLike {
  rejectRedosShape(source);
  // V8 is used only as a syntax parser here, never as the matcher when RE2 is
  // available. This lets us distinguish malformed regex syntax from a valid
  // JavaScript construct that RE2 deliberately does not implement.
  try {
    RegExp(source, flags);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regular expression: ${reason}`);
  }
  if (RE2) {
    try {
      return new RE2(source, flags);
    } catch {
      // RE2 rejects some V8 features (lookbehind, backrefs). Surface the
      // failure as a regular pattern error rather than crashing the tool.
      throw new Error(
        `RE2 could not compile pattern (likely uses unsupported features such as lookbehind or backreferences). ` +
          `Rewrite the pattern using basic constructs.`
      );
    }
  }
  warnFallbackOnce();
  return new RegExp(source, flags);
}

const grepSchema = Type.Object({
  pattern: Type.Optional(
    Type.String({
      description:
        "Text to search for. Treated as a literal string by default; do not escape punctuation or set literal=false for code snippets like openPanel( unless you intentionally want a valid regex.",
    })
  ),
  path: Type.Optional(
    Type.String({
      description:
        "Single directory or file to search (default: current directory). Do not pass a space-separated list; run separate grep calls for multiple roots.",
    })
  ),
  glob: Type.Optional(
    Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })
  ),
  ignoreCase: Type.Optional(
    Type.Boolean({ description: "Case-insensitive search (default: false)" })
  ),
  literal: Type.Optional(
    Type.Boolean({
      description:
        "Treat pattern as literal string instead of regex. Default: true. Leave unset/true for code, identifiers, function calls, paths, and punctuation. Set false only when pattern is a deliberate valid regex.",
    })
  ),
  context: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        "Requested number of lines to show before and after each match (default: 0). Total output remains bounded.",
    })
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 1000,
      description: "Maximum number of matches to return (default: 100; maximum: 1000)",
    })
  ),
  includeIgnored: Type.Optional(
    Type.Boolean({ description: "Include files excluded by .gitignore/.ignore (default: false)" })
  ),
});

export type GrepToolInput = Static<typeof grepSchema>;

export interface GrepToolDetails {
  type?: "console";
  content?: string;
  truncation?: TruncationResult;
  matchLimitReached?: number;
  linesTruncated?: boolean;
  filesScanned?: number;
  engine?: "ripgrep" | "fs-service" | "runtime-fs";
  missingSearchPath?: string;
  extensionFallback?: string;
}

export interface GrepToolDeps {
  rpc?: RpcCaller;
  visibility?: AgentFileVisibility;
}

const DEFAULT_LIMIT = 100;
const MAX_RESULT_LINES = 10_000;
const READ_CONCURRENCY = 8;
const PROGRESS_EVERY_FILES = 250;

export function createGrepTool(
  cwd: string,
  fs: RuntimeFs,
  deps?: GrepToolDeps
): AgentTool<typeof grepSchema, GrepToolDetails | undefined> {
  return {
    name: "grep",
    label: "grep",
    executionMode: "parallel",
    description: `Search file contents. Literal search is the default and should be used for code snippets, identifiers, paths, and punctuation; set literal=false only for intentional valid regex. Returns matching lines with file paths and line numbers. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
    parameters: grepSchema,
    execute: async (_toolCallId, input, signal, onUpdate) => {
      const {
        pattern,
        path: searchDir,
        glob,
        ignoreCase,
        literal,
        context,
        limit,
        includeIgnored,
      } = input;
      const literalSearch = literal !== false;
      if (typeof pattern !== "string") {
        return {
          content: [
            {
              type: "text",
              text: "No grep pattern supplied. Pass the text to search for in `pattern`.",
            },
          ],
          details: undefined,
        };
      }
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      // Prefer the context-scoped host fs service before the workerd
      // file-by-file walker. It uses the same filesystem contract as injected
      // `fs`, but can use native search without a second extension lifecycle.
      if (deps?.rpc) {
        if (!literalSearch) {
          buildRegex(pattern, { literal: false, ignoreCase: !!ignoreCase });
        }
        const searchPath = resolveToCwd(searchDir || ".", cwd);
        if (deps.visibility && (await deps.visibility.isHidden(searchPath))) {
          return { content: [{ type: "text", text: "No matches found" }], details: undefined };
        }
        const servicePattern = literalSearch ? escapeRegex(pattern) : pattern;
        const result = await deps.rpc.call<{
          matches: Array<{
            file: string;
            lineNumber: number;
            line: string;
            before: string[];
            after: string[];
          }>;
          matchCount: number;
          truncated: boolean;
        }>(
          "main",
          "fs.grep",
          [
            servicePattern,
            {
              path: searchPath,
              ...(glob ? { glob } : {}),
              caseInsensitive: !!ignoreCase,
              contextLines: context ?? 0,
              maxMatches: limit ?? DEFAULT_LIMIT,
              ...(includeIgnored ? { includeIgnored: true } : {}),
            },
          ],
          signal ? { signal } : undefined
        );
        const visibleMatches = deps.visibility
          ? await deps.visibility.filterVisible(result.matches, (match) =>
              path.isAbsolute(match.file) ? match.file : path.resolve(searchPath, match.file)
            )
          : result.matches;
        let linesTruncated = false;
        const formatServicePath = (file: string): string => {
          if (!path.isAbsolute(file)) return file.replace(/\\/gu, "/");
          const relative = path.relative(searchPath, file);
          return relative && !relative.startsWith("..")
            ? relative.replace(/\\/gu, "/")
            : path.basename(file);
        };
        const truncateServiceLine = (line: string): string => {
          const value = truncateLine(line);
          if (value.wasTruncated) linesTruncated = true;
          return value.text;
        };
        const lines: string[] = [];
        for (const match of visibleMatches) {
          const displayPath = formatServicePath(match.file);
          const beforeStart = match.lineNumber - match.before.length;
          match.before.forEach((line, index) =>
            lines.push(`${displayPath}-${beforeStart + index}- ${truncateServiceLine(line)}`)
          );
          lines.push(`${displayPath}:${match.lineNumber}: ${truncateServiceLine(match.line)}`);
          match.after.forEach((line, index) =>
            lines.push(
              `${displayPath}-${match.lineNumber + index + 1}- ${truncateServiceLine(line)}`
            )
          );
        }
        if (lines.length === 0) {
          return { content: [{ type: "text", text: "No matches found" }], details: undefined };
        }
        const truncation = truncateHead(lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
        let text = truncation.content;
        const details: GrepToolDetails = { engine: "fs-service" };
        const notices: string[] = [];
        if (result.truncated) {
          notices.push(
            `${limit ?? DEFAULT_LIMIT} matches limit reached. Refine the pattern or path`
          );
          details.matchLimitReached = limit ?? DEFAULT_LIMIT;
        }
        if (truncation.truncated) {
          notices.push(`${formatSize(DEFAULT_MAX_BYTES)} output limit reached`);
          details.truncation = truncation;
        }
        if (linesTruncated) {
          notices.push(
            `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars; use read for full lines`
          );
          details.linesTruncated = true;
        }
        if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;
        return { content: [{ type: "text", text }], details };
      }

      const searchPath = resolveToCwd(searchDir || ".", cwd);
      if (deps?.visibility && (await deps.visibility.isHidden(searchPath))) {
        return { content: [{ type: "text", text: "No matches found" }], details: undefined };
      }
      const requestedContext = context && context > 0 ? context : 0;
      const contextValue = Math.min(requestedContext, Math.floor((MAX_RESULT_LINES - 1) / 2));
      const effectiveLimit = Math.min(
        Math.max(1, limit ?? DEFAULT_LIMIT),
        Math.max(1, Math.floor(MAX_RESULT_LINES / (2 * contextValue + 1)))
      );

      // Stat the entry point so we know whether to walk a tree or open a file.
      let isDirectory: boolean;
      try {
        const stat = await fs.stat(searchPath);
        isDirectory = stat.isDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
        const hint = /\s/.test((searchDir || "").trim())
          ? " The `path` argument accepts one directory or file, not a space-separated list. Run separate grep calls for multiple roots, or search from `.` with a narrower `glob`."
          : "";
        const displayPath = searchDir || ".";
        return {
          content: [
            {
              type: "text",
              text: `No matches found (search path does not exist: ${displayPath}).${hint}`,
            },
          ],
          details: {
            engine: "runtime-fs",
            missingSearchPath: displayPath,
          },
        };
      }

      const regex = buildRegex(pattern, { literal: literalSearch, ignoreCase: !!ignoreCase });
      const globRegex = glob ? globToRegex(glob) : null;

      const formatPath = (filePath: string): string => {
        if (isDirectory) {
          const relative = path.relative(searchPath, filePath);
          if (relative && !relative.startsWith("..")) {
            return relative.replace(/\\/g, "/");
          }
        }
        return path.basename(filePath);
      };

      const shouldSearchFile = (filePath: string): boolean => {
        if (!globRegex) return true;
        const rel = isDirectory ? path.relative(searchPath, filePath) : path.basename(filePath);
        return globRegex.test(rel.replace(/\\/g, "/"));
      };

      // Collect candidate files. Apply the glob during traversal so broad
      // searches such as `glob: "**/*.ts"` do not carry every file in the
      // workspace into the read phase.
      const files: string[] = [];
      if (isDirectory) {
        for await (const file of walkSearchFiles(fs, searchPath, {
          includeIgnored,
          signal,
          visibility: deps?.visibility,
        })) {
          if (shouldSearchFile(file)) files.push(file);
        }
      } else {
        if (shouldSearchFile(searchPath)) files.push(searchPath);
      }

      let matchCount = 0;
      let matchLimitReached = false;
      let linesTruncated = false;
      let filesScanned = 0;
      let nextProgressAt = PROGRESS_EVERY_FILES;
      const outputLines: string[] = [];

      const scanFile = async (filePath: string): Promise<string[][]> => {
        if (signal?.aborted) {
          throw new Error("Operation aborted");
        }
        let raw: string | Uint8Array;
        try {
          raw = await fs.readFile(filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
          throw error;
        }
        filesScanned++;
        if (onUpdate && filesScanned >= nextProgressAt) {
          onUpdate({
            content: [],
            details: {
              type: "console",
              content: `grep scanned ${filesScanned}/${files.length} candidate files...`,
            },
          });
          nextProgressAt += PROGRESS_EVERY_FILES;
        }
        const text = typeof raw === "string" ? raw : decodeUtf8(raw);
        const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        const relativePath = formatPath(filePath);
        const matches: string[][] = [];
        for (let i = 0; i < lines.length; i++) {
          // Reset regex state for each line (only relevant when /g is set
          // and the matcher is a V8 RegExp; RE2's `test` is stateless).
          if ("lastIndex" in regex) {
            (regex as { lastIndex: number }).lastIndex = 0;
          }
          if (regex.test(lines[i]!)) {
            const lineNumber = i + 1;
            const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
            const end =
              contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
            const matchLines: string[] = [];
            for (let cur = start; cur <= end; cur++) {
              const lineText = (lines[cur - 1] ?? "").replace(/\r/g, "");
              const { text: truncatedText, wasTruncated } = truncateLine(lineText);
              if (wasTruncated) linesTruncated = true;
              if (cur === lineNumber) {
                matchLines.push(`${relativePath}:${cur}: ${truncatedText}`);
              } else {
                matchLines.push(`${relativePath}-${cur}- ${truncatedText}`);
              }
            }
            matches.push(matchLines);
          }
        }
        return matches;
      };

      for (let i = 0; i < files.length && !matchLimitReached; i += READ_CONCURRENCY) {
        if (signal?.aborted) {
          throw new Error("Operation aborted");
        }
        const batch = files.slice(i, i + READ_CONCURRENCY);
        const batchResults = await Promise.all(batch.map((filePath) => scanFile(filePath)));
        for (const matchesForFile of batchResults) {
          for (const matchLines of matchesForFile) {
            if (matchCount >= effectiveLimit) {
              matchLimitReached = true;
              break;
            }
            matchCount++;
            outputLines.push(...matchLines);
          }
          if (matchLimitReached) break;
        }
      }

      if (matchCount === 0) {
        return {
          content: [{ type: "text", text: "No matches found" }],
          details: undefined,
        };
      }

      const rawOutput = outputLines.join("\n");
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const details: GrepToolDetails = { engine: "runtime-fs" };
      const notices: string[] = [];

      if (matchLimitReached) {
        notices.push(
          `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`
        );
        details.matchLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (linesTruncated) {
        notices.push(
          `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`
        );
        details.linesTruncated = true;
      }
      details.filesScanned = filesScanned;
      if (notices.length > 0) {
        output += `\n\n[${notices.join(". ")}]`;
      }

      return {
        content: [{ type: "text", text: output }],
        details: Object.keys(details).length > 0 ? details : undefined,
      };
    },
  };
}

/**
 * Maximum allowed pattern length. Most legitimate user regexes are well
 * under this; longer patterns are almost always pathological or
 * machine-generated.
 */
const MAX_PATTERN_LENGTH = 256;

/**
 * Structural shapes that produce catastrophic backtracking on V8's regex
 * engine when fed an adversarial input. Not exhaustive — see RE2's
 * documentation for the full taxonomy — but covers the common
 * "(a+)+", "(a*)*", "(a|a)*" / "(a|aa)*" styles seen in CTF / fuzzers.
 *
 * Defence-in-depth fast-path: rejected even when `re2` is available, so
 * obviously-pathological patterns never reach the matcher at all. When
 * `re2` is unavailable, this is the *only* protection against ReDoS in
 * the fallback `RegExp` path.
 */
const REDOS_SHAPES: RegExp[] = [
  // (X+)+ / (X*)+ / (X+)* — nested unbounded quantifiers
  /\([^()]*[+*]\)[+*]/,
  // (X|X)* / (X|XX)* — alternation with overlapping branches under *
  /\([^()|]+\|[^()|]+\)[+*]/,
];

function rejectRedosShape(source: string): void {
  for (const shape of REDOS_SHAPES) {
    if (shape.test(source)) {
      throw new Error(
        `Refusing potentially catastrophic regex (matches structural shape ${shape.source}). ` +
          `Rewrite the pattern or split it across multiple grep calls.`
      );
    }
  }
}

/** Build a regex matcher from the user's pattern, honouring `literal` / `ignoreCase`. */
function buildRegex(
  pattern: string,
  { literal, ignoreCase }: { literal: boolean; ignoreCase: boolean }
): RegexLike {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(
      `Pattern too long (${pattern.length} chars; max ${MAX_PATTERN_LENGTH}). ` +
        `Long regexes are almost always pathological.`
    );
  }
  const source = literal ? escapeRegex(pattern) : pattern;
  const flags = ignoreCase ? "i" : "";
  // Literal patterns can never trigger ReDoS (no metacharacters survive
  // `escapeRegex`), so feed them straight to the matcher without the
  // structural pre-check. Non-literal patterns go through `compileUserRegex`
  // which applies the shape check then prefers RE2.
  if (literal) {
    if (RE2) {
      try {
        return new RE2(source, flags);
      } catch {
        // fall through to RegExp
      }
    }
    return new RegExp(source, flags);
  }
  return compileUserRegex(source, flags);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Translate a glob pattern (`*.ts`, `**\/*.spec.ts`) into a regex anchored
 * to the start and end of the test string. Supports `*`, `**`, and `?`.
 */
export function globToRegex(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** matches across path separators
        re += ".*";
        i += 2;
        if (glob[i] === "/") i++;
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}
