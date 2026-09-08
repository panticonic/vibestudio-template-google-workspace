import type { RpcClient, RpcEventContext } from "@vibestudio/rpc";
import type { PanelHandle as CorePanelHandle, Rpc } from "../core/index.js";
import type {
  OpenExternalOptions,
  OpenExternalResult,
} from "@vibestudio/shared/externalOpen";
import {
  createPanelRuntime,
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

export function createPanelHandleApi(
  rpc: PanelRuntimeRpc,
  options: {
    selfId?: string | null;
    selfRpcTargetId?: string | null;
    parentId?: string | null;
    parentRpcTargetId?: string | null;
    effectiveVersion?: string | null;
  } = {},
) {
  const shell = (globalThis as any).__vibestudioShell;
  const runtime = createPanelRuntime({
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
    onStateArgsSet: (id) =>
      currentJournal()?.append({ type: "stateArgs.set", id }),
  });
  const subscriptions = new Set<() => void>();
  let destroyed = false;
  function ownSubscription(unsubs: Array<() => void>): () => void {
    const unsubscribe = () => {
      if (!subscriptions.delete(unsubscribe)) return;
      for (const unsub of unsubs) unsub();
    };
    subscriptions.add(unsubscribe);
    return unsubscribe;
  }

  async function openExternal(
    url: string,
    options?: OpenExternalOptions,
  ): Promise<OpenExternalResult> {
    return rpc.call<OpenExternalResult>("main", "externalOpen.openExternal", [
      url,
      options,
    ]);
  }

  function onChildCreated(
    handler: (info: { childId: string; url: string }) => void,
  ): () => void {
    if (destroyed) throw new Error("Panel handle runtime has been destroyed");
    const unsubs: Array<() => void> = [];
    if (shell?.addEventListener) {
      const listenerId = shell.addEventListener(
        (event: string, payload: unknown) => {
          if (event === "runtime:child-created") {
            const data = payload as { childId?: string; url?: string } | null;
            if (data?.childId && data?.url)
              handler({ childId: data.childId, url: data.url });
          }
        },
      );
      unsubs.push(() => shell.removeEventListener(listenerId));
    }
    unsubs.push(
      rpc.on(
        "runtime:child-created",
        (event: RpcEventContext) => {
          const data = event.payload as {
            childId?: string;
            url?: string;
          } | null;
          if (data?.childId && data?.url)
            handler({ childId: data.childId, url: data.url });
        },
        {
          kind: "closed",
          reason:
            "This listener consumes host or implementation lifecycle events.",
        },
      ),
    );
    return ownSubscription(unsubs);
  }

  function onChildCreationError(
    handler: (info: { url: string; error: string }) => void,
  ): () => void {
    if (destroyed) throw new Error("Panel handle runtime has been destroyed");
    const unsubs: Array<() => void> = [];
    const notify = (payload: unknown) => {
      const data = payload as { url?: string; error?: string } | null;
      if (data?.url && data?.error)
        handler({ url: data.url, error: data.error });
    };
    if (shell?.addEventListener) {
      const listenerId = shell.addEventListener(
        (event: string, payload: unknown) => {
          if (event === "runtime:child-creation-error") notify(payload);
        },
      );
      unsubs.push(() => shell.removeEventListener(listenerId));
    }
    unsubs.push(
      rpc.on(
        "runtime:child-creation-error",
        (event: RpcEventContext) => notify(event.payload),
        {
          kind: "closed",
          reason:
            "This listener consumes host or implementation lifecycle events.",
        },
      ),
    );
    return ownSubscription(unsubs);
  }

  return {
    ...runtime,
    openExternal,
    onChildCreated,
    onChildCreationError,
    destroy: () => {
      destroyed = true;
      for (const unsubscribe of subscriptions) unsubscribe();
    },
  };
}
