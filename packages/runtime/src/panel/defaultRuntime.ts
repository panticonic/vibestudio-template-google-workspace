import { bridgeTransport, type WorkspaceProvider } from "@vibestudio/rpc";
import type { PanelEntityId, PanelSlotId } from "@vibestudio/shared/panel/idValues";
import { createPanelRuntime, type PanelApi } from "./createPanelRuntime.js";

let current: PanelApi | undefined;
let activeProvider: WorkspaceProvider | undefined;
let stopDisconnect: (() => void) | undefined;
let connecting: Promise<PanelApi> | undefined;
let generation = 0;
export let id: string;
export let contextId: string;
export let gatewayConfig: PanelApi["gatewayConfig"] = null;
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };
export const workspaceConnection = {
  get kind(): "installed" | "website" | "unavailable" {
    return activeProvider || globalThis.vibestudio ? "website" : current ? "installed" : "unavailable";
  },
  get connected(): boolean { return current !== undefined; },
  get available(): boolean { return Boolean(current || globalThis.vibestudio); },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};
function bind(runtime: PanelApi | undefined): void {
  current = runtime;
  id = runtime?.id as string;
  contextId = runtime?.contextId as string;
  gatewayConfig = runtime?.gatewayConfig ?? null;
  changed();
}
function disconnected(): Error {
  return Object.assign(new Error("Connect this website to a workspace before using workspace APIs"), {
    code: "EWORKSPACE_DISCONNECTED",
  });
}

/** Explicit user action. No workspace method implicitly calls this or queues for connection. */
export function connectWorkspace(provider: WorkspaceProvider | undefined = globalThis.vibestudio): Promise<PanelApi> {
  if (current) return Promise.resolve(current);
  if (connecting) return connecting;
  if (!provider) return Promise.reject(new Error("Open this page in a Vibestudio browser panel to connect"));
  const attempt = ++generation;
  connecting = (async () => {
    activeProvider = provider;
    stopDisconnect = provider.onDisconnect(() => {
      if (activeProvider !== provider) return;
      ++generation;
      stopDisconnect?.();
      stopDisconnect = undefined;
      activeProvider = undefined;
      current?.destroy();
      bind(undefined);
    });
    const connection = await provider.connect();
    if (attempt !== generation) throw disconnected();
    const bootstrap = connection.bootstrap;
    const instance = createPanelRuntime({
      selfId: bootstrap.runtimeId as PanelEntityId,
      entityId: bootstrap.runtimeId as PanelEntityId,
      slotId: bootstrap.slotId as PanelSlotId,
      contextId: bootstrap.contextId,
      parentId: bootstrap.parentId as PanelSlotId | null,
      parentEntityId: bootstrap.parentEntityId as PanelEntityId | null,
      initialTheme: bootstrap.theme,
      createTransport: () => bridgeTransport(provider),
      environment: { document: globalThis.document, location: globalThis.location },
    });
    bind(instance);
    return instance;
  })().catch(error => {
    if (attempt === generation) {
      stopDisconnect?.();
      stopDisconnect = undefined;
      activeProvider = undefined;
    }
    throw error;
  }).finally(() => { connecting = undefined; });
  return connecting;
}

export async function disconnectWorkspace(): Promise<void> {
  if (current && !activeProvider) throw new Error("Installed panel lifetime is owned by its presentation host");
  ++generation;
  const provider = activeProvider ?? globalThis.vibestudio;
  stopDisconnect?.();
  stopDisconnect = undefined;
  activeProvider = undefined;
  current?.destroy();
  bind(undefined);
  await provider?.disconnect();
}

/**
 * Default imports are borrowed views of the current runtime. Merely importing or
 * storing a method never performs RPC. Calls fail immediately while disconnected;
 * returned clients/resources belong to the concrete instance that created them.
 */
export function defaultMember<K extends keyof PanelApi>(key: K): PanelApi[K] {
  const view = (path: PropertyKey[]): unknown => {
    const resolve = () => {
      if (!current) throw disconnected();
      let owner: unknown = current;
      let value: unknown = current;
      for (const part of path) { owner = value; value = Reflect.get(Object(value), part); }
      return { owner, value };
    };
    return new Proxy(() => {}, {
      apply(_target, _this, args) {
        const { owner, value } = resolve();
        if (typeof value !== "function") throw new TypeError(`${path.join(".")} is not callable`);
        return Reflect.apply(value, owner, args);
      },
      get(_target, property) {
        if (!current) return property === "then" ? undefined : view([...path, property]);
        const value = Reflect.get(Object(resolve().value), property);
        return value !== null && (typeof value === "object" || typeof value === "function")
          ? view([...path, property]) : value;
      },
      ownKeys() { return current ? Reflect.ownKeys(Object(resolve().value)) : []; },
      getOwnPropertyDescriptor(_target, property) {
        if (!current) return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(Object(resolve().value), property);
        return descriptor ? { ...descriptor, configurable: true } : undefined;
      },
    });
  };
  return view([key]) as PanelApi[K];
}

declare global { var vibestudio: WorkspaceProvider | undefined; }

/** Called by the installed presentation entry before application modules run. */
export function bindInstalledRuntime(instance: PanelApi): void {
  if (current || connecting) throw new Error("A default runtime is already bound");
  bind(instance);
}
