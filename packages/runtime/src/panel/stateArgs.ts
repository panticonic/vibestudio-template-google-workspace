import type { PanelSlotId } from "@vibestudio/shared/panel/idValues";
import { readPanelStateArgs, updatePanelStateArgs } from "../shared/panelStateArgsPersistence.js";

// Global injected by preload via --vibestudio-state-args command line arg
declare global {
  interface Window {
    __vibestudioStateArgs?: Record<string, unknown>;
  }
}

export function createStateArgsRuntime(input: {
  slotId: PanelSlotId;
  call: <T>(service: string, method: string, args: unknown[]) => Promise<T>;
  initial?: Record<string, unknown>;
  changed?: (snapshot: Record<string, unknown>) => void;
}) {
  let snapshot = input.initial ?? {};
  const apply = (next: Record<string, unknown>) => {
    snapshot = next;
    input.changed?.(next);
  };
  const setForPanel = async <T = Record<string, unknown>>(panelId: string, updates: Record<string, unknown>): Promise<T> => {
    const next = await updatePanelStateArgs({ call: input.call }, panelId, updates);
    if (panelId === input.slotId) apply(next);
    return next as T;
  };
  return {
    get: <T = Record<string, unknown>>(): T => snapshot as T,
    set: <T = Record<string, unknown>>(updates: Record<string, unknown>) => setForPanel<T>(input.slotId, updates),
    setForPanel,
    getForPanel: <T = Record<string, unknown>>(panelId: string) => readPanelStateArgs<T>({ call: input.call }, panelId),
    apply,
  };
}

// The default panel import binds one instance. Explicit factories own their
// state independently and never replace this convenience binding.
let defaultState: ReturnType<typeof createStateArgsRuntime> | undefined;
export function bindDefaultStateArgs(state: ReturnType<typeof createStateArgsRuntime>): void {
  defaultState = state;
}
function current() {
  if (!defaultState) throw new Error("Panel runtime has not been initialized");
  return defaultState;
}
export function getStateArgs<T = Record<string, unknown>>(): T { return current().get<T>(); }
export function setStateArgs<T = Record<string, unknown>>(updates: Record<string, unknown>): Promise<T> { return current().set<T>(updates); }
export function setStateArgsForPanel<T = Record<string, unknown>>(panelId: string, updates: Record<string, unknown>): Promise<T> { return current().setForPanel<T>(panelId, updates); }
export function getStateArgsForPanel<T = Record<string, unknown>>(panelId: string): Promise<T> { return current().getForPanel<T>(panelId); }
