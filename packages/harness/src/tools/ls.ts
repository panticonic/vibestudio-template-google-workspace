/**
 * Ls tool — workerd port of pi-coding-agent's `dist/core/tools/ls.js`.
 *
 * Differences from upstream:
 * - File I/O goes through `RuntimeFs` (no synchronous Node fs).
 * - Uses `readdir({ withFileTypes: true })` so we don't need a per-entry
 *   `stat()` call to check directory-ness.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import type { RuntimeFs, Dirent } from "./runtime-fs.js";
import { AgentToolFailureError, agentToolFailureFromUnknown } from "@workspace/agentic-protocol";
import { resolveToCwd } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, type TruncationResult } from "./truncate.js";
import type { AgentFileVisibility } from "./agent-file-visibility.js";

const lsSchema = Type.Object({
  path: Type.Optional(
    Type.String({ description: "Directory to list (default: current directory)" })
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of entries to return (default: 500)" })
  ),
});

export type LsToolInput = Static<typeof lsSchema>;

export interface LsToolDetails {
  path: string;
  entries?: string[];
  truncation?: TruncationResult;
  entryLimitReached?: number;
  diagnostic?: "not-found" | "not-directory";
}

const DEFAULT_LIMIT = 500;

export function createLsTool(
  cwd: string,
  fs: RuntimeFs,
  visibility?: AgentFileVisibility
): AgentTool<typeof lsSchema, LsToolDetails | undefined> {
  return {
    name: "ls",
    label: "ls",
    executionMode: "parallel",
    description: `List directory contents. Returns source-tree entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. A directory listing proves only that source exists; it does not prove that a panel, worker, service, or other unit is built, registered, launchable, or currently running. Use the documented live runtime API for those questions. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: lsSchema,
    execute: async (_toolCallId, { path: rawPath, limit }, signal) => {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const dirPath = resolveToCwd(rawPath || ".", cwd);
      const effectiveLimit = limit ?? DEFAULT_LIMIT;

      if (visibility && (await visibility.isHidden(dirPath))) {
        return {
          content: [{ type: "text", text: `Path not found: ${dirPath}` }],
          details: { diagnostic: "not-found", path: dirPath },
        };
      }

      let stat;
      try {
        stat = await fs.stat(dirPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return {
            content: [
              {
                type: "text",
                text:
                  `Path not found: ${dirPath}\n` +
                  "This is a recoverable lookup miss. Check the parent directory with ls or locate the path with find.",
              },
            ],
            details: { diagnostic: "not-found", path: dirPath },
          };
        }
        throw new AgentToolFailureError(
          agentToolFailureFromUnknown(err, {
            operation: "fs.stat",
            stage: "resolve-directory",
          }),
          err
        );
      }
      if (!stat.isDirectory()) {
        return {
          content: [
            {
              type: "text",
              text:
                `Not a directory: ${dirPath}\n` +
                "This is a recoverable path-kind mismatch. Use read for a file or ls on its parent directory.",
            },
          ],
          details: { diagnostic: "not-directory", path: dirPath },
        };
      }

      let entries: Dirent[];
      try {
        entries = (await fs.readdir(dirPath, { withFileTypes: true })) as Dirent[];
      } catch (e) {
        throw new AgentToolFailureError(
          agentToolFailureFromUnknown(e, {
            operation: "fs.readdir",
            stage: "list-directory",
          }),
          e
        );
      }
      if (visibility) {
        entries = await visibility.filterVisible(entries, (entry) =>
          pathForEntry(dirPath, entry.name)
        );
      }

      // Sort case-insensitively to match upstream.
      entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

      const results: string[] = [];
      let entryLimitReached = false;
      for (const entry of entries) {
        if (results.length >= effectiveLimit) {
          entryLimitReached = true;
          break;
        }
        const suffix = entry.isDirectory() ? "/" : "";
        results.push(entry.name + suffix);
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "(empty directory)" }],
          details: { path: dirPath, entries: [] },
        };
      }

      const rawOutput = results.join("\n");
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const details: LsToolDetails = { path: dirPath, entries: results };
      const notices: string[] = [];

      if (entryLimitReached) {
        notices.push(
          `${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`
        );
        details.entryLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (notices.length > 0) {
        output += `\n\n[${notices.join(". ")}]`;
      }

      return {
        content: [{ type: "text", text: output }],
        details,
      };
    },
  };
}

function pathForEntry(directory: string, entry: string): string {
  return directory.endsWith("/") ? `${directory}${entry}` : `${directory}/${entry}`;
}
