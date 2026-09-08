/** Installed presentation adapter; the exported application API is the shared panel entry. */
import { initRuntime } from "../setup/initRuntime.js";
import { createPanelTransport, recoveryCoordinator } from "./transport.js";
import { createPanelApi } from "./createPanelRuntime.js";
import { bindInstalledRuntime } from "./defaultRuntime.js";
import { installPanelErrorDiagnosticLauncher } from "./errorDebugChat.js";
const { runtime, config } = initRuntime({
  createTransport: createPanelTransport,
  onRecovery: (handler) => {
    const resubscribe = recoveryCoordinator.registerResubscribeHandler(
      "panel-rpc",
      () => handler("resubscribe"),
      { includeCurrentGeneration: false },
    );
    const cold = recoveryCoordinator.registerColdRecoverHandler(
      "panel-rpc",
      () => handler("cold-recover"),
    );
    return () => {
      resubscribe();
      cold();
    };
  },
});
bindInstalledRuntime(createPanelApi(runtime, config));
installPanelErrorDiagnosticLauncher({
  slotId: config.slotId ?? config.entityId,
  contextId: config.contextId,
  panelRuntime: runtime.panelRuntime,
});
export * from "./index.js";
