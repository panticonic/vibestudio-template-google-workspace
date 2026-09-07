export { DEFAULT_THEME_CONFIG } from "@vibestudio/shared/theme";
export type { ThemeConfig } from "@vibestudio/shared/theme";
export type { HostCommand } from "@vibestudio/shared/hostCommands";

export type ThemeAppearance = "light" | "dark";

export interface FileStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mtime: Date;
  ctime: Date;
  mtimeMs: number;
  ctimeMs: number;
  /** Unix-style file mode (e.g. 0o644). Required by isomorphic-git. */
  mode: number;
}

export interface MkdirOptions {
  recursive?: boolean;
}

export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

export interface BinaryEnvelope {
  __bin: true;
  data: string;
}

export type RuntimeBinaryData = Uint8Array | ArrayBuffer | ArrayBufferView | BinaryEnvelope;

/**
 * Options for opening a file.
 */
export interface OpenOptions {
  flags?: string;
  mode?: number;
}

/**
 * File handle returned by open().
 */
export interface FileHandle {
  fd: number;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null
  ): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  // A string is encoded (utf-8) and the 2nd arg is the file position (Node's `write(string[, position[, encoding]])`).
  write(
    buffer: RuntimeBinaryData | string,
    offset?: number,
    length?: number,
    position?: number | null
  ): Promise<{ bytesWritten: number; buffer: RuntimeBinaryData | string }>;
  close(): Promise<void>;
  stat(): Promise<FileStats>;
}

/**
 * Directory entry returned by readdir({ withFileTypes: true }).
 * Compatible with Node's fs.Dirent.
 */
export interface Dirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * Options for readdir.
 */
export interface ReaddirOptions {
  withFileTypes?: boolean;
  /** Recurse into descendants and return paths relative to the listed directory. */
  recursive?: boolean;
}

/**
 * Filesystem interface for panels, workers, and eval.
 * Compatible with Node's fs/promises and @vibestudio/git's FsPromisesLike.
 * Every path is relative to the caller's context root, including paths with a
 * leading `/`. Mutations inside workspace repos become attributed semantic VCS operations;
 * ordinary non-repo and platform-ignored paths are context-local scratch.
 * Operations have no implicit filesystem deadline: they settle normally unless
 * the owning runtime supplies an explicit AbortSignal. Implementations may emit
 * settled-operation telemetry, but telemetry never changes completion behavior.
 */
export interface RuntimeFs {
  /**
   * `fs.constants` — mode bits for `access()`.
   * Matches Node's `fs.constants` values so code written against
   * `node:fs/promises` can be ported as a near-pure import swap.
   */
  readonly constants: {
    readonly F_OK: 0;
    readonly R_OK: 4;
    readonly W_OK: 2;
    readonly X_OK: 1;
  };
  /**
   * Create a unique temp file path inside the context's `.tmp/` directory and
   * return it (relative to the context root, with a leading `/`). The file
   * itself is not created — callers use the returned path for atomic writes
   * (write to tmp → rename into place). Analogous to the pattern used around
   * `os.tmpdir()` in Node tools.
   */
  mktemp(prefix?: string): Promise<string>;
  /** Create and return a unique context-local directory under `/.tmp`. */
  mkdtemp(prefix?: string): Promise<string>;
  readFile(path: string, encoding?: string): Promise<string | Uint8Array>;
  writeFile(path: string, data: string | RuntimeBinaryData): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  readdir(path: string, options?: ReaddirOptions): Promise<string[] | Dirent[]>;
  stat(path: string): Promise<FileStats>;
  lstat(path: string): Promise<FileStats>;
  mkdir(path: string, options?: MkdirOptions): Promise<string | undefined>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  // Extensions beyond FsPromisesLike
  rm(path: string, options?: RmOptions): Promise<void>;
  exists(path: string): Promise<boolean>;
  // Full runtime filesystem operations
  access(path: string, mode?: number): Promise<void>;
  appendFile(path: string, data: string | RuntimeBinaryData): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  realpath(path: string): Promise<string>;
  open(path: string, flags?: string, mode?: number): Promise<FileHandle>;
  readlink(path: string): Promise<string>;
  symlink(target: string, path: string, type?: "file" | "dir" | "junction"): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void>;
  truncate(path: string, len?: number): Promise<void>;
}
