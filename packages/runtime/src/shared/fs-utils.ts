/**
 * Shared filesystem utilities for panels and workers.
 */

import type { FileStats } from "../types.js";

/**
 * Convert any stat-like object to our FileStats interface.
 * Captures boolean values at creation time so they can be returned as methods.
 * Preserves `mode` for isomorphic-git compatibility.
 */
export function toFileStats(stats: unknown): FileStats {
  const s = stats as Record<string, unknown> | null | undefined;
  const isFileFn = s?.["isFile"];
  const isDirFn = s?.["isDirectory"];
  // Call methods with proper `this` binding - some fs implementations need their context
  const isFileBool = typeof isFileFn === "function" ? (isFileFn as () => boolean).call(s) : !!isFileFn;
  const isDirBool = typeof isDirFn === "function" ? (isDirFn as () => boolean).call(s) : !!isDirFn;
  const sizeVal = s?.["size"];
  const mtimeVal = s?.["mtime"];
  const ctimeVal = s?.["ctime"];
  const modeVal = s?.["mode"];

  // Default mode: 0o100644 for files, 0o40755 for directories
  // These include the file type bits that isomorphic-git expects
  const defaultMode = isDirBool ? 0o40755 : 0o100644;

  const isSymlinkFn = s?.["isSymbolicLink"];
  const isSymlinkBool = typeof isSymlinkFn === "function" ? (isSymlinkFn as () => boolean).call(s) : !!isSymlinkFn;
  const toDate = (value: unknown): Date => {
    if (value instanceof Date) return new Date(value.getTime());
    const parsed = new Date(typeof value === "number" ? value : String(value ?? ""));
    return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
  };
  const mtime = toDate(mtimeVal);
  const ctime = toDate(ctimeVal);

  return {
    isFile: () => isFileBool,
    isDirectory: () => isDirBool,
    isSymbolicLink: () => isSymlinkBool,
    size: typeof sizeVal === "number" ? sizeVal : 0,
    mtime,
    ctime,
    mtimeMs: mtime.getTime(),
    ctimeMs: ctime.getTime(),
    mode: typeof modeVal === "number" ? modeVal : defaultMode,
  };
}
