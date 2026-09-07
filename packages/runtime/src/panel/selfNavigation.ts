import { callWorkspaceState } from "../shared/workspaceStateClient.js";

export interface ReopenPanelOptions {
  source?: string;
  ref?: string;
  stateArgs?: Record<string, unknown>;
}

interface SelfNavigationRpc {
  call(target: string, method: string, args: unknown[]): Promise<unknown>;
}

export function createPanelSelfNavigation(options: {
  rpc: SelfNavigationRpc;
  slotId: string;
  navigatePanel?: (
    slotId: string,
    source: string,
    options: ReopenPanelOptions & { contextId?: string }
  ) => Promise<{ id?: string; panelId?: string; title?: string } | void>;
}): {
  reopen(opts?: ReopenPanelOptions): Promise<{ id: string; title: string }>;
  switchContext(
    nextContextId: string,
    opts?: ReopenPanelOptions
  ): Promise<{ id: string; title: string }>;
} {
  const navigate = async (
    input: ReopenPanelOptions & { contextId?: string }
  ): Promise<{ id: string; title: string }> => {
    let source = input.source;
    if (!source) {
      const detail = (await callWorkspaceState(options.rpc, "panelTree.detail", [
        options.slotId,
      ])) as {
        currentHistory?: { source?: string };
      } | null;
      source = detail?.currentHistory?.source;
      if (!source) throw new Error("reopen: could not resolve the current panel source");
    }
    if (!options.navigatePanel) {
      throw new Error("Panel navigation runtime is unavailable");
    }
    const result = await options.navigatePanel(options.slotId, source, input);
    return {
      id: result?.id ?? result?.panelId ?? options.slotId,
      title: result?.title ?? source,
    };
  };

  return {
    /** Reopen this panel without changing its workspace branch. */
    reopen: (input = {}) => navigate(input),
    /**
     * Explicitly move this panel to an already-created workspace branch.
     * State args are ordinary application state and cannot select a context.
     */
    switchContext(nextContextId, input = {}) {
      const next = nextContextId.trim();
      if (!next) throw new Error("switchContext: contextId must be non-empty");
      return navigate({ ...input, contextId: next });
    },
  };
}
