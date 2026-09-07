/**
 * RPC-backed RuntimeFs implementation.
 *
 * Each method calls rpc.call<T>("main", "fs.{method}", ...args).
 * Binary data is encoded as { __bin: true, data: base64String } for JSON transport.
 *
 * Shared between panels and workers — no Node.js or browser-specific dependencies.
 */
import { base64ToBytes, bytesToBase64, type RpcClient } from "@vibestudio/rpc";
import type {
  RuntimeFs,
  FileStats,
  Dirent,
  FileHandle,
  BinaryEnvelope,
  RuntimeBinaryData,
} from "../types.js";
import { toFileStats } from "./fs-utils.js";
// ---------------------------------------------------------------------------
// Binary helpers
// ---------------------------------------------------------------------------
function isBinaryEnvelope(v: unknown): v is BinaryEnvelope {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as any).__bin === true &&
    typeof (v as any).data === "string"
  );
}
function encodeBinary(buf: Uint8Array): BinaryEnvelope {
  return { __bin: true, data: bytesToBase64(buf) };
}
function decodeBinary(envelope: BinaryEnvelope): Uint8Array {
  return base64ToBytes(envelope.data);
}
function toUint8Array(data: RuntimeBinaryData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError(
    "Binary filesystem payload must be an ArrayBuffer, ArrayBuffer view, or binary envelope"
  );
}
function encodeWritePayload(data: string | RuntimeBinaryData): string | BinaryEnvelope {
  if (typeof data === "string" || isBinaryEnvelope(data)) return data;
  return encodeBinary(toUint8Array(data));
}
// ---------------------------------------------------------------------------
// Dirent reconstruction
// ---------------------------------------------------------------------------
interface SerializedDirent {
  name: string;
  _isFile: boolean;
  _isDirectory: boolean;
  _isSymbolicLink: boolean;
}
function toDirent(d: SerializedDirent): Dirent {
  return {
    name: d.name,
    isFile: () => d._isFile,
    isDirectory: () => d._isDirectory,
    isSymbolicLink: () => d._isSymbolicLink,
  };
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
/**
 * `fs.constants` shared between all `createRpcFs` instances. Defined at module
 * scope (rather than per-instance) because these values are true constants and
 * the `readonly` tuple literal lets TypeScript narrow them precisely.
 */
const FS_CONSTANTS = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
} as const;

export interface RpcFsTelemetry {
  method: string;
  phase: "settled";
  elapsedMs: number;
  outcome: "ok" | "error";
}

export interface RpcFsOptions {
  /** Abort when the owning execution is explicitly cancelled; never a deadline. */
  signal?: AbortSignal;
  /** Optional observer for settled-operation latency and outcomes. */
  onTelemetry?: (event: RpcFsTelemetry) => void;
}

export function createRpcFs(rpc: Pick<RpcClient, "call">, options: RpcFsOptions = {}): RuntimeFs {
  function call<T>(method: string, ...args: unknown[]): Promise<T> {
    const startedAt = Date.now();
    const report = (event: RpcFsTelemetry): void => {
      try {
        options.onTelemetry?.(event);
      } catch (error) {
        console.warn("[rpc-fs] telemetry observer failed", error);
      }
    };
    const invocation = options.signal
      ? rpc.call<T>("main", `fs.${method}`, [...args], { signal: options.signal })
      : rpc.call<T>("main", `fs.${method}`, [...args]);
    return invocation.then(
      (value) => {
        if (options.onTelemetry) {
          report({
            method,
            phase: "settled",
            elapsedMs: Date.now() - startedAt,
            outcome: "ok",
          });
        }
        return value;
      },
      (error: unknown) => {
        if (options.onTelemetry) {
          report({
            method,
            phase: "settled",
            elapsedMs: Date.now() - startedAt,
            outcome: "error",
          });
        }
        throw error;
      }
    );
  }
  return {
    constants: FS_CONSTANTS,
    async mktemp(prefix?: string): Promise<string> {
      return call<string>("mktemp", prefix);
    },
    async mkdtemp(prefix?: string): Promise<string> {
      const path = await call<string>("mktemp", prefix);
      await call<string | undefined>("mkdir", path, { recursive: true });
      return path;
    },
    async readFile(path: string, encoding?: string): Promise<string | Uint8Array> {
      const result = await call<string | BinaryEnvelope>("readFile", path, encoding);
      if (isBinaryEnvelope(result)) {
        return decodeBinary(result);
      }
      return result as string;
    },
    async writeFile(path: string, data: string | RuntimeBinaryData): Promise<void> {
      await call<void>("writeFile", path, encodeWritePayload(data));
    },
    readdir: (async (
      path: string,
      options?: {
        withFileTypes?: boolean;
        recursive?: boolean;
      }
    ): Promise<string[] | Dirent[]> => {
      if (options?.withFileTypes) {
        const entries = await call<SerializedDirent[]>("readdir", path, options);
        return entries.map(toDirent);
      }
      return options ? call<string[]>("readdir", path, options) : call<string[]>("readdir", path);
    }) as RuntimeFs["readdir"],
    async stat(path: string): Promise<FileStats> {
      return toFileStats(await call<unknown>("stat", path));
    },
    async lstat(path: string): Promise<FileStats> {
      return toFileStats(await call<unknown>("lstat", path));
    },
    async mkdir(
      path: string,
      options?: {
        recursive?: boolean;
      }
    ): Promise<string | undefined> {
      await call<void>("mkdir", path, options);
      return undefined;
    },
    async rmdir(path: string): Promise<void> {
      await call<void>("rmdir", path);
    },
    async rm(
      path: string,
      options?: {
        recursive?: boolean;
        force?: boolean;
      }
    ): Promise<void> {
      await call<void>("rm", path, options);
    },
    async exists(path: string): Promise<boolean> {
      return call<boolean>("exists", path);
    },
    async unlink(path: string): Promise<void> {
      await call<void>("unlink", path);
    },
    async access(path: string, mode?: number): Promise<void> {
      await call<void>("access", path, mode);
    },
    async appendFile(path: string, data: string | RuntimeBinaryData): Promise<void> {
      await call<void>("appendFile", path, encodeWritePayload(data));
    },
    async copyFile(src: string, dest: string): Promise<void> {
      await call<void>("copyFile", src, dest);
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      await call<void>("rename", oldPath, newPath);
    },
    async realpath(path: string): Promise<string> {
      return call<string>("realpath", path);
    },
    async open(filePath: string, flags?: string, mode?: number): Promise<FileHandle> {
      const { handleId } = await call<{
        handleId: number;
      }>("open", filePath, flags, mode);
      return {
        fd: handleId,
        async read(
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number | null
        ): Promise<{
          bytesRead: number;
          buffer: Uint8Array;
        }> {
          const result = await call<{
            bytesRead: number;
            buffer: BinaryEnvelope;
          }>("handleRead", handleId, length, position);
          const decoded = decodeBinary(result.buffer);
          buffer.set(decoded, offset);
          return { bytesRead: result.bytesRead, buffer };
        },
        async write(
          buffer: RuntimeBinaryData | string,
          offset?: number,
          length?: number,
          position?: number | null
        ): Promise<{
          bytesWritten: number;
          buffer: RuntimeBinaryData | string;
        }> {
          // Node parity: `write(string[, position[, encoding]])` as well as
          // `write(buffer[, offset[, length[, position]]])`. A string is encoded (utf-8)
          // and the 2nd arg is the file POSITION, not a byte offset.
          let slice: Uint8Array;
          let pos: number | null;
          if (typeof buffer === "string") {
            slice = new TextEncoder().encode(buffer);
            pos = typeof offset === "number" ? offset : null;
          } else {
            const bytes = toUint8Array(buffer);
            slice = bytes.subarray(offset ?? 0, (offset ?? 0) + (length ?? bytes.length));
            pos = position ?? null;
          }
          const result = await call<{
            bytesWritten: number;
          }>("handleWrite", handleId, encodeBinary(slice), pos);
          return { bytesWritten: result.bytesWritten, buffer };
        },
        async close(): Promise<void> {
          await call<void>("handleClose", handleId);
        },
        async stat(): Promise<FileStats> {
          return toFileStats(await call<unknown>("handleStat", handleId));
        },
      };
    },
    async readlink(path: string): Promise<string> {
      return call<string>("readlink", path);
    },
    async symlink(target: string, path: string, type?: "file" | "dir" | "junction"): Promise<void> {
      await call<void>("symlink", target, path, type);
    },
    async chmod(path: string, mode: number): Promise<void> {
      await call<void>("chmod", path, mode);
    },
    async utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void> {
      // Convert Date to seconds-since-epoch for JSON transport
      const a = atime instanceof Date ? atime.getTime() / 1000 : atime;
      const m = mtime instanceof Date ? mtime.getTime() / 1000 : mtime;
      await call<void>("utimes", path, a, m);
    },
    async truncate(path: string, len?: number): Promise<void> {
      await call<void>("truncate", path, len);
    },
  };
}
