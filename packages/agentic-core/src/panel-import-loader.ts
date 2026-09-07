/** Build-backed dynamic import loading for browser panel sandboxes. */
import {
  createBuildServiceClient,
  createEvalImportLoader,
} from "@vibestudio/service-schemas/clients/evalImportLoader";
import type { SandboxImportLoader } from "@workspace/eval";

interface RpcLike {
  call(target: string, method: string, args: unknown[]): Promise<unknown>;
}

/**
 * Create the import loader used by authored panel code. Connection RPC remains
 * part of the chat's ConnectionConfig; this factory supplies only the optional
 * dynamic-loading capability required by authored UI and client evaluation.
 */
export function createPanelImportLoader(
  rpc: RpcLike,
  options: { defaultWorkspaceRef: () => `ctx:${string}` }
): SandboxImportLoader {
  const build = createBuildServiceClient((service, method, args) =>
    rpc.call("main", `${service}.${method}`, args)
  );
  return createEvalImportLoader(build, "panel", options);
}
