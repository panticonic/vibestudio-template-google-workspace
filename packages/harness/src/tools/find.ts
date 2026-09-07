/**
 * Find tool — workerd-native rewrite of pi-coding-agent's
 * `dist/core/tools/find.js`.
 *
 * Upstream uses `fd` via `child_process.spawnSync`, plus the `glob` package
 * for nested .gitignore discovery. workerd has neither. Active agent runs use
 * the context-scoped host `fs.glob` service, which performs the traversal once
 * at the filesystem boundary. Embeddings without RPC retain a small in-memory
 * `RuntimeFs` walker.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import type { TextContent, ImageContent } from "@workspace/pi-ai";
import type { RpcCaller } from "@vibestudio/rpc";
import path from "node:path";
import type { RuntimeFs } from "./runtime-fs.js";
import { resolveToCwd } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, type TruncationResult } from "./truncate.js";
import { globToRegex } from "./grep.js";
import { walkSearchFiles } from "./search-walk.js";
import type { AgentFileVisibility } from "./agent-file-visibility.js";

const findSchema = Type.Object({
  pattern: Type.Optional(
    Type.String({
      description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
    })
  ),
  path: Type.Optional(
    Type.String({ description: "Directory to search in (default: current directory)" })
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 10_000,
      description: "Maximum number of results (default: 1000; maximum: 10000)",
    })
  ),
  cursor: Type.Optional(
    Type.String({
      description: "Resume strictly after this exact relative path from a previous bounded result",
    })
  ),
  includeIgnored: Type.Optional(
    Type.Boolean({ description: "Include files excluded by .gitignore/.ignore (default: false)" })
  ),
});

export type FindToolInput = Static<typeof findSchema>;

export interface FindToolDetails {
  type?: "console";
  content?: string;
  truncation?: TruncationResult;
  resultLimitReached?: number;
  engine?: "fs-service" | "runtime-fs";
  nextCursor?: string;
  missingSearchPath?: string;
  nonDirectorySearchPath?: string;
  extensionFallback?: string;
}

export interface FindToolDeps {
  rpc?: RpcCaller;
  visibility?: AgentFileVisibility;
}

const DEFAULT_LIMIT = 1000;

export function createFindTool(
  cwd: string,
  fs: RuntimeFs,
  deps?: FindToolDeps
): AgentTool<typeof findSchema, FindToolDetails | undefined> {
  return {
    name: "find",
    label: "find",
    executionMode: "parallel",
    description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: findSchema,
    execute: async (_toolCallId, input, signal, _onUpdate) => {
      const { pattern, path: searchDir, limit, cursor, includeIgnored } = input;
      if (typeof pattern !== "string") {
        return {
          content: [
            {
              type: "text",
              text: "No find pattern supplied. Pass a glob such as `*`, `**/*.ts`, or `src/**`.",
            },
          ],
          details: undefined,
        };
      }
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const searchPath = resolveToCwd(searchDir || ".", cwd);
      const effectiveLimit = limit ?? DEFAULT_LIMIT;
      if (deps?.visibility && (await deps.visibility.isHidden(searchPath))) {
        return renderMatches([], effectiveLimit, false, deps.rpc ? "fs-service" : "runtime-fs");
      }

      if (deps?.rpc) {
        let page: { files: string[]; truncated: boolean; nextCursor?: string };
        try {
          page = await deps.rpc.call<{
            files: string[];
            truncated: boolean;
            nextCursor?: string;
          }>(
            "main",
            "fs.glob",
            [
              pattern,
              {
                path: searchPath,
                limit: effectiveLimit,
                ...(cursor ? { after: path.resolve(searchPath, cursor) } : {}),
                ...(includeIgnored ? { includeIgnored: true } : {}),
              },
            ],
            signal ? { signal } : undefined
          );
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | null)?.code;
          if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
          const displayPath = searchDir || ".";
          const nonDirectory = code === "ENOTDIR";
          return {
            content: [
              {
                type: "text",
                text: nonDirectory
                  ? `No files found matching pattern (search path is not a directory: ${displayPath})`
                  : `No files found matching pattern (search path does not exist: ${displayPath})`,
              },
            ],
            details: nonDirectory
              ? { engine: "fs-service", nonDirectorySearchPath: displayPath }
              : { engine: "fs-service", missingSearchPath: displayPath },
          };
        }
        const visibleFiles = deps.visibility
          ? await deps.visibility.filterVisible(page.files, (file) =>
              path.isAbsolute(file) ? file : path.resolve(searchPath, file)
            )
          : page.files;
        const matches = visibleFiles.map((file) =>
          path.relative(searchPath, file).replace(/\\/g, "/")
        );
        return renderMatches(matches, effectiveLimit, page.truncated, "fs-service");
      }

      // The in-memory fallback needs an explicit root probe; the host glob
      // service already combines this with its traversal in one RPC above.
      try {
        await fs.stat(searchPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
        const displayPath = searchDir || ".";
        return {
          content: [
            {
              type: "text",
              text: `No files found matching pattern (search path does not exist: ${displayPath})`,
            },
          ],
          details: { engine: "runtime-fs", missingSearchPath: displayPath },
        };
      }

      const regex = globToRegex(pattern);
      // A slashless pattern matches by BASENAME anywhere in the tree (the
      // universal agent-glob convention — `system-testing*` should find
      // `skills/system-testing/`). Path-shaped patterns keep full-path
      // semantics.
      const basenameRegex = pattern.includes("/") ? null : regex;
      const matches: string[] = [];
      let resultLimitReached = false;
      let cursorSeen = cursor === undefined;

      for await (const full of walkSearchFiles(fs, searchPath, {
        includeIgnored,
        signal,
        visibility: deps?.visibility,
      })) {
        const rel = path.relative(searchPath, full).replace(/\\/g, "/");
        const basename = path.basename(full);
        if (regex.test(rel) || basenameRegex?.test(basename)) {
          if (!cursorSeen) {
            cursorSeen = rel === cursor;
            continue;
          }
          matches.push(rel);
          if (matches.length > effectiveLimit) {
            resultLimitReached = true;
            break;
          }
        }
      }
      if (!cursorSeen) {
        throw new Error(`Find cursor is no longer present: ${cursor}`);
      }

      return renderMatches(
        matches.slice(0, effectiveLimit),
        effectiveLimit,
        resultLimitReached,
        "runtime-fs"
      );
    },
  };
}

function renderMatches(
  matches: string[],
  effectiveLimit: number,
  resultLimitReached: boolean,
  engine: "fs-service" | "runtime-fs"
): {
  content: (TextContent | ImageContent)[];
  details: FindToolDetails | undefined;
} {
  if (matches.length === 0) {
    return {
      content: [{ type: "text", text: "No files found matching pattern" }],
      details: undefined,
    };
  }

  const rawOutput = matches.join("\n");
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  let resultOutput = truncation.content;
  const details: FindToolDetails = { engine };
  const notices: string[] = [];

  if (resultLimitReached) {
    details.resultLimitReached = effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  } else if (resultLimitReached) {
    details.nextCursor = matches.at(-1);
    notices.push(
      `${effectiveLimit} results limit reached. Continue with cursor=${JSON.stringify(details.nextCursor)}, or refine the pattern`
    );
  }
  if (notices.length > 0) {
    resultOutput += `\n\n[${notices.join(". ")}]`;
  }

  return {
    content: [{ type: "text", text: resultOutput }],
    details,
  };
}
