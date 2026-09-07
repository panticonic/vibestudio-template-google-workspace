import type { RpcClient, RpcEventContext } from "@vibestudio/rpc";
import type { PanelHandle as CorePanelHandle, Rpc } from "../core/index.js";
import type { OpenExternalOptions, OpenExternalResult } from "@vibestudio/shared/externalOpen";
import {
  createPanelRuntime,
  type CreatePanelSlotOptions,
  type OpenPanelOptions,
  type PanelRuntimeApi,
  type PanelRuntimeTree,
} from "../shared/panelRuntime.js";
import { currentJournal } from "../shared/journal.js";

export type PanelHandle<
  T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
  E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
  EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap,
> = CorePanelHandle<T, E, EmitE>;

export type PanelTreeApi = PanelRuntimeTree;

type PanelRuntimeRpc = Pick<RpcClient, "call" | "emit" | "on">;

let _rpc: PanelRuntimeRpc | null = null;
let _runtime: PanelRuntimeApi | null = null;
const shell = (globalThis as any).__vibestudioShell;

export function _initPanelHandleBridge(
  rpc: PanelRuntimeRpc,
  options: {
    selfId?: string | null;
    selfRpcTargetId?: string | null;
    parentId?: string | null;
    parentRpcTargetId?: string | null;
    effectiveVersion?: string | null;
  } = {}
): void {
  _rpc = rpc;
  _runtime = createPanelRuntime({
    rpc,
    ...(typeof shell?.focusPanel === "function"
      ? { focusPanel: (id, focusOptions) => shell.focusPanel(id, focusOptions) }
      : {}),
    selfId: options.selfId ?? null,
    selfRpcTargetId: options.selfRpcTargetId ?? options.selfId ?? null,
    parentId: options.parentId ?? null,
    effectiveVersion: options.effectiveVersion ?? null,
    defaultOpenParentId: options.selfId ?? null,
    requesterPanelId: options.selfId ?? null,
    initialMetadata: [
      ...(options.selfId
        ? [
            {
              id: options.selfId,
              title: options.selfId,
              source: options.selfId,
              kind: "workspace" as const,
              parentId: options.parentId ?? null,
              rpcTargetId: options.selfRpcTargetId ?? options.selfId,
              effectiveVersion: options.effectiveVersion ?? null,
            },
          ]
        : []),
      ...(options.parentId
        ? [
            {
              id: options.parentId,
              title: options.parentId,
              source: options.parentId,
              kind: "workspace" as const,
              parentId: null,
              rpcTargetId: options.parentRpcTargetId ?? options.parentId,
            },
          ]
        : []),
    ],
    onOpen: (entry) => currentJournal()?.append({ type: "open", ...entry }),
    onReload: (id) => currentJournal()?.append({ type: "reload", id }),
    onClose: (id) => currentJournal()?.append({ type: "close", id }),
    onStateArgsSet: (id) => currentJournal()?.append({ type: "stateArgs.set", id }),
  });
}

function getRpc(): PanelRuntimeRpc {
  if (!_rpc) throw new Error("Panel bridge not initialized");
  return _rpc;
}

function getRuntime(): PanelRuntimeApi {
  if (!_runtime) throw new Error("Panel bridge not initialized");
  return _runtime;
}

export async function openPanel(source: string, options?: OpenPanelOptions): Promise<PanelHandle> {
  return getRuntime().openPanel(source, options);
}

export async function createPanelSlot(
  source: string,
  options?: CreatePanelSlotOptions
): Promise<PanelHandle> {
  return getRuntime().createPanelSlot(source, options);
}

export async function openExternal(
  url: string,
  options?: OpenExternalOptions
): Promise<OpenExternalResult> {
  return getRpc().call<OpenExternalResult>("main", "externalOpen.openExternal", [url, options]);
}

export function onChildCreated(
  handler: (info: { childId: string; url: string }) => void
): () => void {
  const unsubs: Array<() => void> = [];
  if (shell?.addEventListener) {
    const listenerId = shell.addEventListener((event: string, payload: unknown) => {
      if (event === "runtime:child-created") {
        const data = payload as { childId?: string; url?: string } | null;
        if (data?.childId && data?.url) handler({ childId: data.childId, url: data.url });
      }
    });
    unsubs.push(() => shell.removeEventListener(listenerId));
  }
  const rpc = getRpc();
  unsubs.push(
    rpc.on("runtime:child-created", (event: RpcEventContext) => {
      const data = event.payload as { childId?: string; url?: string } | null;
      if (data?.childId && data?.url) handler({ childId: data.childId, url: data.url });
    })
  );
  return () => {
    for (const unsub of unsubs) unsub();
  };
}

export function onChildCreationError(
  handler: (info: { url: string; error: string }) => void
): () => void {
  const unsubs: Array<() => void> = [];
  const notify = (payload: unknown) => {
    const data = payload as { url?: string; error?: string } | null;
    if (data?.url && data?.error) handler({ url: data.url, error: data.error });
  };
  if (shell?.addEventListener) {
    const listenerId = shell.addEventListener((event: string, payload: unknown) => {
      if (event === "runtime:child-creation-error") notify(payload);
    });
    unsubs.push(() => shell.removeEventListener(listenerId));
  }
  unsubs.push(
    getRpc().on("runtime:child-creation-error", (event: RpcEventContext) => notify(event.payload))
  );
  return () => {
    for (const unsub of unsubs) unsub();
  };
}

export function getPanelHandle(
  id: string,
  kind: "workspace" | "browser" = "workspace"
): PanelHandle {
  return getRuntime().getPanelHandle(id, kind);
}

export const panelTree: PanelTreeApi = {
  self: () => getRuntime().panelTree.self(),
  get: (id, kind) => getRuntime().panelTree.get(id, kind),
  rootOwners: (input) => getRuntime().panelTree.rootOwners(input),
  roots: (input) => getRuntime().panelTree.roots(input),
  rootsForOwner: (ownerUserId, input) => getRuntime().panelTree.rootsForOwner(ownerUserId, input),
  children: (parentSlotId, input) => getRuntime().panelTree.children(parentSlotId, input),
  page: (input) => getRuntime().panelTree.page(input),
  path: (id) => getRuntime().panelTree.path(id),
  search: (input) => getRuntime().panelTree.search(input),
  sourceUsage: (limit) => getRuntime().panelTree.sourceUsage(limit),
  parent: (id) => getRuntime().panelTree.parent(id),
  navigate: (id, source, options) => getRuntime().panelTree.navigate(id, source, options),
  navigateHistory: (id, delta) => getRuntime().panelTree.navigateHistory(id, delta),
};
