import type { PanelRuntimeEnvironment } from "./runtimeEnvironment.js";
import { applyStateArgsSnapshot } from "@vibestudio/shared/panel/applyStateArgsSnapshot";

/** The default hosted entry is the only adapter that reads injected page globals. */
export function injectedPanelEnvironment(): PanelRuntimeEnvironment {
  const shell = (globalThis as unknown as { __vibestudioShell?: {
    addEventListener?(handler: (event: string, payload: unknown) => void): number;
    removeEventListener?(id: number): void;
    reportPanelBoot?: NonNullable<PanelRuntimeEnvironment["boot"]>["report"];
    getInfo?: PanelRuntimeEnvironment["getInfo"];
    focusPanel?: PanelRuntimeEnvironment["focusPanel"];
  } }).__vibestudioShell;
  return {
    modeChanged(mode) {
      if (globalThis.window) {
        globalThis.window.__vibestudioAgentMode = mode;
        globalThis.window.dispatchEvent(new CustomEvent("vibestudio:agentModeChanged", { detail: mode }));
      }
    },
    document: globalThis.document,
    location: globalThis.location,
    events: shell?.addEventListener ? { subscribe(handler) {
      const id = shell.addEventListener!(handler);
      return () => shell.removeEventListener?.(id);
    } } : undefined,
    stateArgs: {
      initial: globalThis.window?.__vibestudioStateArgs ?? {},
      changed: applyStateArgsSnapshot,
    },
    boot: {
      initial: globalThis.__vibestudioPanelBoot,
      report: shell?.reportPanelBoot,
      subscribe(handler) {
        const listener = (event: Event) => handler((event as CustomEvent).detail);
        globalThis.addEventListener?.("vibestudio:panel-boot", listener);
        return () => globalThis.removeEventListener?.("vibestudio:panel-boot", listener);
      },
    },
    getInfo: shell?.getInfo,
    focusPanel: shell?.focusPanel,
  };
}
