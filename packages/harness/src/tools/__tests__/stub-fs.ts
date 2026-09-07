/**
 * Tiny in-memory `RuntimeFs` for unit-testing the file tools.
 *
 * Stores files as `Buffer` keyed by absolute path. Directories are inferred
 * from the set of file paths plus a manually-tracked set of created dirs.
 * The implementation is minimal — only the methods the tools call are real.
 */

import { Buffer } from "node:buffer";
import * as nodePath from "node:path";
import type {
  Dirent,
  FileStats,
  MkdirOptions,
  ReaddirOptions,
  RuntimeFs,
} from "../runtime-fs.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeStat(isDir: boolean, size: number): FileStats {
  return {
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isSymbolicLink: () => false,
    size,
    mtime: new Date(NOW),
    ctime: new Date(NOW),
    mtimeMs: NOW.getTime(),
    ctimeMs: NOW.getTime(),
    mode: isDir ? 0o755 : 0o644,
  };
}

function makeDirent(name: string, isDir: boolean): Dirent {
  return {
    name,
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isSymbolicLink: () => false,
  };
}

function fsError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

export interface StubFsInit {
  /** Map of absolute path → file contents (string or Buffer). */
  files?: Record<string, string | Uint8Array>;
}

export class StubFs implements RuntimeFs {
  readonly constants = {
    F_OK: 0 as const,
    R_OK: 4 as const,
    W_OK: 2 as const,
    X_OK: 1 as const,
  };

  /** Map of absolute path → contents. */
  readonly files = new Map<string, Buffer>();
  /** Set of absolute directory paths. */
  readonly dirs = new Set<string>();
  private tmpCounter = 0;

  constructor(init?: StubFsInit) {
    if (init?.files) {
      for (const [path, data] of Object.entries(init.files)) {
        this.setFile(path, data);
      }
    }
    this.dirs.add("/");
  }

  /** Add or replace a file at `path`. Inferred parent dirs are added too. */
  setFile(path: string, data: string | Uint8Array): void {
    const normalized = nodePath.resolve(path);
    const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
    this.files.set(normalized, buf);
    let dir = nodePath.dirname(normalized);
    while (dir && dir !== "/" && !this.dirs.has(dir)) {
      this.dirs.add(dir);
      const parent = nodePath.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    this.dirs.add("/");
  }

  async mktemp(prefix?: string): Promise<string> {
    this.tmpCounter++;
    return `/.tmp/${prefix ?? "tmp-"}${this.tmpCounter}`;
  }

  async mkdtemp(prefix?: string): Promise<string> {
    const path = await this.mktemp(prefix);
    await this.mkdir(path, { recursive: true });
    return path;
  }

  async readFile(path: string, encoding?: BufferEncoding): Promise<string | Buffer> {
    const normalized = nodePath.resolve(path);
    const data = this.files.get(normalized);
    if (!data) {
      throw fsError("ENOENT", `ENOENT: no such file or directory, open '${path}'`);
    }
    if (encoding) {
      return data.toString(encoding);
    }
    return data;
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    this.setFile(path, data);
  }

  async readdir(path: string): Promise<string[]>;
  async readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  async readdir(path: string, options?: ReaddirOptions): Promise<string[] | Dirent[]>;
  async readdir(path: string, options?: ReaddirOptions): Promise<string[] | Dirent[]> {
    const normalized = nodePath.resolve(path);
    if (!this.dirs.has(normalized) && !this.entriesIn(normalized).length) {
      throw fsError("ENOENT", `ENOENT: no such file or directory, scandir '${path}'`);
    }
    const entries = this.entriesIn(normalized);
    if (options?.withFileTypes) {
      return entries.map(({ name, isDir }) => makeDirent(name, isDir));
    }
    return entries.map((e) => e.name);
  }

  /** Returns the immediate children (files + subdirs) of `dir`. */
  private entriesIn(dir: string): { name: string; isDir: boolean }[] {
    const seen = new Map<string, boolean>();
    const prefix = dir.endsWith("/") ? dir : dir + "/";
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) {
        const rest = filePath.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) {
          seen.set(rest, false);
        } else {
          seen.set(rest.slice(0, slash), true);
        }
      }
    }
    for (const subdir of this.dirs) {
      if (subdir.startsWith(prefix)) {
        const rest = subdir.slice(prefix.length);
        const slash = rest.indexOf("/");
        const name = slash === -1 ? rest : rest.slice(0, slash);
        if (name && !seen.has(name)) {
          seen.set(name, true);
        }
      }
    }
    return [...seen.entries()].map(([name, isDir]) => ({ name, isDir }));
  }

  async stat(path: string): Promise<FileStats> {
    const normalized = nodePath.resolve(path);
    const file = this.files.get(normalized);
    if (file) {
      return makeStat(false, file.length);
    }
    if (this.dirs.has(normalized) || this.entriesIn(normalized).length > 0) {
      return makeStat(true, 0);
    }
    throw fsError("ENOENT", `ENOENT: no such file or directory, stat '${path}'`);
  }

  async lstat(path: string): Promise<FileStats> {
    return this.stat(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<string | undefined> {
    const normalized = nodePath.resolve(path);
    if (options?.recursive) {
      const parts = normalized.split("/").filter(Boolean);
      let cur = "";
      for (const part of parts) {
        cur += "/" + part;
        this.dirs.add(cur);
      }
      return undefined;
    }
    this.dirs.add(normalized);
    return undefined;
  }

  async rm(path: string): Promise<void> {
    const normalized = nodePath.resolve(path);
    this.files.delete(normalized);
    this.dirs.delete(normalized);
  }

  async unlink(path: string): Promise<void> {
    return this.rm(path);
  }

  async exists(path: string): Promise<boolean> {
    const normalized = nodePath.resolve(path);
    return this.files.has(normalized) || this.dirs.has(normalized);
  }

  async access(path: string, _mode?: number): Promise<void> {
    const normalized = nodePath.resolve(path);
    if (!this.files.has(normalized) && !this.dirs.has(normalized)) {
      throw fsError("ENOENT", `ENOENT: no such file or directory, access '${path}'`);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldNormalized = nodePath.resolve(oldPath);
    const newNormalized = nodePath.resolve(newPath);
    const data = this.files.get(oldNormalized);
    if (!data) {
      throw fsError("ENOENT", `ENOENT: no such file or directory, rename '${oldPath}'`);
    }
    this.files.delete(oldNormalized);
    this.files.set(newNormalized, data);
  }

  async copyFile(sourcePath: string, destinationPath: string): Promise<void> {
    const source = this.files.get(nodePath.resolve(sourcePath));
    if (!source) {
      throw fsError("ENOENT", `ENOENT: no such file or directory, copyfile '${sourcePath}'`);
    }
    this.setFile(destinationPath, source);
  }
}
