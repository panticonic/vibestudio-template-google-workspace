import type { RpcClient } from "@vibestudio/rpc";
import type { PanelRendererViewReport } from "@vibestudio/service-schemas/panelRuntime";
import type { PanelBootObservation } from "@vibestudio/shared/panel/observation";

export type PanelBootReportResult = "reported" | "stale";

export type PanelRendererViewObservation = Omit<PanelRendererViewReport, "boot"> & {
  boot: { kind: "observed"; observation: PanelBootObservation };
};

export interface PanelBootReporter {
  publish(boot: PanelBootObservation): void;
  dispose(): void;
}

/**
 * Publishes renderer boot evidence in order and only retires it after the
 * coordinator acknowledges the exact renderer lease. A disconnected direct
 * call is retried on the transport's next connected transition; application
 * failures are surfaced and left to host/coordinator supervision to resolve.
 */
export function createPanelBootReporter(options: {
  rpc: Pick<RpcClient, "status" | "onStatusChange"> & {
    call(targetId: string, method: string, args: unknown[]): Promise<PanelBootReportResult>;
  };
  observeView: (
    boot: PanelBootObservation
  ) => Omit<PanelRendererViewObservation, "boot">;
  onError?: (error: unknown, observation: PanelRendererViewObservation) => void;
}): PanelBootReporter {
  let generation = 0;
  let pending: { generation: number; observation: PanelRendererViewObservation } | null = null;
  let publishing = false;
  let disposed = false;
  let leaseEnded = false;
  let disconnectRevision = 0;

  const publishPending = (): void => {
    if (disposed || leaseEnded || publishing || !pending || options.rpc.status() !== "connected") {
      return;
    }
    const publication = pending;
    const publicationDisconnectRevision = disconnectRevision;
    publishing = true;
    void options.rpc
      .call("main", "panelRuntime.reportOwnView", [publication.observation])
      .then((result) => {
        if (result === "stale") {
          // This document no longer owns the exact coordinator lease. It must
          // never publish into a replacement incarnation with the same entity.
          leaseEnded = true;
          pending = null;
          return;
        }
        if (pending?.generation === publication.generation) pending = null;
      })
      .catch((error: unknown) => {
        if (
          options.rpc.status() === "connected" &&
          disconnectRevision === publicationDisconnectRevision
        ) {
          // A connected rejection is not transport ambiguity. Surface it once
          // and remove only this generation; newer evidence still publishes.
          options.onError?.(error, publication.observation);
          if (pending?.generation === publication.generation) pending = null;
        }
        // A disconnect rejects direct server calls before an acknowledgement
        // can exist. Keep the latest evidence for the connected transition.
      })
      .finally(() => {
        publishing = false;
        publishPending();
      });
  };

  const unsubscribe = options.rpc.onStatusChange((status) => {
    if (status === "disconnected") disconnectRevision += 1;
    if (status === "connected") publishPending();
  });

  return {
    publish(boot) {
      if (disposed || leaseEnded) return;
      pending = {
        generation: ++generation,
        observation: {
          ...options.observeView(boot),
          boot: { kind: "observed", observation: boot },
        },
      };
      publishPending();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pending = null;
      unsubscribe();
    },
  };
}
