import {
  createWorkspaceStateClient,
  type ShellServiceCall,
} from "@vibestudio/shell-core/workspaceStateClient";
import { omitTrailingUndefined } from "@vibestudio/shared/workspaceServiceRpc";

export interface RuntimeWorkspaceStateRpc {
  call(target: string, method: string, args: unknown[]): Promise<unknown>;
}

/**
 * The portable runtime's single workspace-state boundary. Workspace semantics
 * are implemented by WorkspaceDO; the named service supplies authority,
 * invalidation, and post-commit presentation convergence for every caller.
 */
export function callWorkspaceState<T>(
  rpc: RuntimeWorkspaceStateRpc,
  method: string,
  args: unknown[]
): Promise<T> {
  return rpc.call(
    "main",
    `workspace-state.${method}`,
    omitTrailingUndefined(args),
  ) as Promise<T>;
}

export function createRuntimeWorkspaceStateClient(rpc: RuntimeWorkspaceStateRpc) {
  const callService: ShellServiceCall = (_service, method, args) =>
    callWorkspaceState(rpc, method, args);
  return createWorkspaceStateClient(callService);
}
