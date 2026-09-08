import {
  bridgeTransport,
  type EnvelopeBridge,
  type EnvelopeRpcTransport,
} from "@vibestudio/rpc";
import { createRecoveryCoordinator } from "@vibestudio/shell-core/recoveryCoordinator";
import type {
  RecoveryCoordinator,
  RecoveryKind,
} from "@vibestudio/shell-core/recoveryCoordinator";

/** Panel hosting supplies the common channel plus its lifecycle recovery signals. */
type PanelBridge = EnvelopeBridge & {
  onRecovery?: (
    kind: RecoveryKind,
    handler: () => void | Promise<void>,
  ) => () => void;
};

export const recoveryCoordinator: RecoveryCoordinator =
  createRecoveryCoordinator();

export function createPanelTransport(
  lifetime: AbortSignal,
): EnvelopeRpcTransport {
  const bridge = (
    globalThis as typeof globalThis & { __vibestudioShell?: PanelBridge }
  ).__vibestudioShell;
  if (!bridge) throw new Error("Vibestudio shell bridge is not available");
  const unsubscribeResubscribe = bridge.onRecovery?.("resubscribe", () =>
    recoveryCoordinator.run("resubscribe"),
  );
  const unsubscribeColdRecover = bridge.onRecovery?.("cold-recover", () =>
    recoveryCoordinator.run("cold-recover"),
  );
  const retire = () => {
    unsubscribeResubscribe?.();
    unsubscribeColdRecover?.();
  };
  lifetime.addEventListener("abort", retire, { once: true });
  if (lifetime.aborted) retire();
  return bridgeTransport(bridge);
}
