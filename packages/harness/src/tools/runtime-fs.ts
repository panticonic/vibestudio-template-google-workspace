/**
 * Minimal `RuntimeFs` type local to the file-tools package.
 *
 * The full `RuntimeFs` interface lives in `@workspace/runtime`'s
 * `types.ts`, but `@workspace/harness` is a workspace package and
 * deliberately does not depend on the `workspace/` runtime package.
 * Instead we define the slice of `RuntimeFs` the file tools touch and
 * leave it structurally compatible with the upstream interface — any
 * caller that has a real `RuntimeFs` from `@workspace/runtime` can
 * pass it directly because TypeScript checks structural assignability.
 *
 * Mirrors the shape in `workspace/packages/runtime/src/types.ts`.
 */

export interface FileStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mtime: Date;
  ctime: Date;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
}

export interface Dirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface ReaddirOptions {
  withFileTypes?: boolean;
}

export interface MkdirOptions {
  recursive?: boolean;
}

export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

export interface RuntimeFs {
  readonly constants: {
    readonly F_OK: 0;
    readonly R_OK: 4;
    readonly W_OK: 2;
    readonly X_OK: 1;
  };
  mktemp(prefix?: string): Promise<string>;
  mkdtemp(prefix?: string): Promise<string>;
  readFile(path: string, encoding?: string): Promise<string | Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  readdir(path: string, options?: ReaddirOptions): Promise<string[] | Dirent[]>;
  stat(path: string): Promise<FileStats>;
  lstat?(path: string): Promise<FileStats>;
  mkdir(path: string, options?: MkdirOptions): Promise<string | undefined>;
  rmdir?(path: string): Promise<void>;
  unlink?(path: string): Promise<void>;
  rm?(path: string, options?: RmOptions): Promise<void>;
  exists?(path: string): Promise<boolean>;
  access(path: string, mode?: number): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  realpath?(path: string): Promise<string>;
  symlink?(target: string, path: string, type?: "file" | "dir" | "junction"): Promise<void>;
}
