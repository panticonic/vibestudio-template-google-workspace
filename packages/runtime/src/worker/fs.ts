/**
 * Filesystem provider backed by worker RPC.
 *
 * Workers can expose this through the module-map fs shim before a specific
 * worker instance has called createWorkerRuntime(). Calls wait until the
 * runtime wires in the instance RPC bridge.
 */

import type { RuntimeFs } from "../types.js";
import type { RpcClient } from "@vibestudio/rpc";
import { createRpcFs } from "../shared/rpcFs.js";

let _fs: RuntimeFs | null = null;
let _resolve: (() => void) | null = null;
const _ready = new Promise<void>((resolve) => {
  _resolve = resolve;
});

export function _initFsWithRpc(rpc: Pick<RpcClient, "call">): RuntimeFs {
  _fs = createRpcFs(rpc);
  _resolve?.();
  return _fs;
}

const FS_CONSTANTS = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
} as const;

export const fs: RuntimeFs = new Proxy({} as RuntimeFs, {
  get(_target, prop: string | symbol) {
    if (prop === "then" || typeof prop === "symbol") return undefined;
    if (prop === "constants") return FS_CONSTANTS;
    return async (...args: unknown[]) => {
      await _ready;
      if (!_fs) throw new Error("[Vibestudio] Worker filesystem not initialized");
      const method = (_fs as any)[prop] as (...args: unknown[]) => Promise<unknown>;
      return method.apply(_fs, args);
    };
  },
});
