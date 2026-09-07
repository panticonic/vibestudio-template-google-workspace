/**
 * Filesystem provider backed by server-side RPC.
 *
 * Panel fs calls are routed to the server's fsService via RPC, which
 * operates on real files in per-context folders on disk.
 *
 * The Proxy pattern ensures panels can import `fs` before RPC is ready —
 * each call awaits the _ready promise which resolves once _initFsWithRpc
 * is called.
 */

import type { RuntimeFs } from "../types.js";
import type { RpcClient } from "@vibestudio/rpc";
import { createRpcFs } from "../shared/rpcFs.js";

let _fs: RuntimeFs | null = null;
let _resolve: (() => void) | null = null;
const _ready = new Promise<void>((r) => {
  _resolve = r;
});

/**
 * Initialize the fs implementation with an RPC bridge.
 * Called once from initRuntime after the runtime is created.
 */
export function _initFsWithRpc(rpc: Pick<RpcClient, "call">): void {
  _fs = createRpcFs(rpc);
  _resolve?.();
}

/**
 * `fs.constants` is a plain object, not a method. Expose it synchronously so
 * panel code like `if (mode & fs.constants.R_OK)` works without awaiting.
 * These values match Node's `fs.constants` on POSIX systems.
 */
const FS_CONSTANTS = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
} as const;

/**
 * Proxy-based fs that waits for RPC initialization on each call.
 * Ensures the correct implementation is used regardless of import timing.
 */
export const fs: RuntimeFs = new Proxy({} as RuntimeFs, {
  get(_target, prop: string | symbol) {
    // Prevent the proxy from being treated as a thenable (e.g. `await fs`)
    if (prop === "then" || typeof prop === "symbol") return undefined;
    // `constants` is a sync data property — not a method — so return it
    // directly without wrapping in a promise-producing function.
    if (prop === "constants") return FS_CONSTANTS;
    return async (...args: unknown[]) => {
      await _ready;
      if (!_fs) throw new Error("[Vibestudio] Filesystem not initialized");
      const method = (_fs as any)[prop] as (...args: unknown[]) => Promise<unknown>;
      return method.apply(_fs, args);
    };
  },
});
