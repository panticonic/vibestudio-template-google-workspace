import ignore, { type Ignore } from "ignore";
import path from "node:path";
import type { Dirent, RuntimeFs } from "./runtime-fs.js";
import type { AgentFileVisibility } from "./agent-file-visibility.js";
import { decodeUtf8 } from "./portable-bytes.js";

const HARD_SKIP_DIRECTORIES = new Set([".git", ".gad", "node_modules"]);

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
  }
}

function scopedIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) return null;
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const scoped = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${scoped}` : scoped;
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

async function addIgnoreFile(
  fs: RuntimeFs,
  matcher: Ignore,
  directory: string,
  root: string,
  filename: string
): Promise<void> {
  let raw: string | Uint8Array;
  try {
    raw = await fs.readFile(path.join(directory, filename));
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  const relativeDirectory = path.relative(root, directory).replace(/\\/gu, "/");
  const prefix = relativeDirectory ? `${relativeDirectory}/` : "";
  const rules = (typeof raw === "string" ? raw : decodeUtf8(raw))
    .split(/\r?\n/gu)
    .map((line) => scopedIgnorePattern(line, prefix))
    .filter((line): line is string => line !== null);
  if (rules.length > 0) matcher.add(rules);
}

/** RuntimeFs counterpart to the host search traversal contract. */
export async function* walkSearchFiles(
  fs: RuntimeFs,
  root: string,
  options: {
    includeIgnored?: boolean;
    signal?: AbortSignal;
    visibility?: AgentFileVisibility;
  } = {}
): AsyncGenerator<string> {
  const matcher = ignore().add([".git/", ".gad/", "node_modules/"]);

  async function* visit(directory: string): AsyncGenerator<string> {
    throwIfAborted(options.signal);
    if (!options.includeIgnored) {
      await addIgnoreFile(fs, matcher, directory, root, ".gitignore");
      await addIgnoreFile(fs, matcher, directory, root, ".ignore");
    }
    const entries = (await fs.readdir(directory, { withFileTypes: true })) as Dirent[];
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      throwIfAborted(options.signal);
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/gu, "/");
      if (options.visibility && (await options.visibility.isHidden(absolute))) continue;
      if (entry.isDirectory()) {
        if (HARD_SKIP_DIRECTORIES.has(entry.name)) continue;
        if (!options.includeIgnored && matcher.ignores(`${relative}/`)) continue;
        yield* visit(absolute);
      } else if (entry.isFile()) {
        if (!options.includeIgnored && matcher.ignores(relative)) continue;
        yield absolute;
      }
    }
  }

  yield* visit(root);
}
