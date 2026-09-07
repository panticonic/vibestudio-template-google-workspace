/**
 * Opt-in panel automation capability for Durable Objects.
 *
 * Most DOs are stores, coordinators, or agents and never touch a visible
 * panel. Keeping this capability in a subclass prevents the panel navigation,
 * CDP, state-args, and diagnostics graph from becoming part of every DO's
 * activation kernel.
 */
import type { PanelHandle } from "../core/index.js";
import { createNonPanelRuntimeHandle } from "../shared/handles.js";
import {
  createPanelRuntime,
  type CreatePanelSlotOptions,
  type OpenPanelOptions,
  type PanelRuntimeApi,
  type PanelRuntimeTree,
} from "../shared/panelRuntime.js";
import { DurableObjectBase } from "./durable-base.js";

export abstract class PanelDurableObjectBase extends DurableObjectBase {
  private _panelRuntime: PanelRuntimeApi | null = null;

  private get panelRuntime(): PanelRuntimeApi {
    if (!this._panelRuntime) {
      this._panelRuntime = createPanelRuntime({
        rpc: this.rpc,
        selfHandle: () =>
          createNonPanelRuntimeHandle({
            id: String(this.env["DO_ID"] ?? this.ctx.id.toString()),
          }),
        defaultOpenParentId: null,
        requesterPanelId: () =>
          this.rpcCallerKind === "panel" ? (this.rpcCallerPanelId ?? this.rpcCallerId) : null,
      });
    }
    return this._panelRuntime;
  }

  /** Get a handle to the first dispatcher when it is a runtime entity. */
  protected getParent(): PanelHandle | null {
    const callerId = this.rpcCallerId;
    if (!callerId) return null;
    if (this.rpcCallerKind === "panel") {
      const panelId = this.rpcCallerPanelId ?? callerId;
      return this.panelRuntime.fromMetadata({
        id: panelId,
        title: panelId,
        source: panelId,
        kind: "workspace",
        parentId: null,
        rpcTargetId: callerId,
      });
    }
    if (this.rpcCallerKind === "worker" || this.rpcCallerKind === "do") {
      return createNonPanelRuntimeHandle({ id: callerId });
    }
    return null;
  }

  protected createPanelSlot(
    source: string,
    options?: CreatePanelSlotOptions
  ): Promise<PanelHandle> {
    return this.panelRuntime.createPanelSlot(source, options);
  }

  protected openPanel(source: string, options?: OpenPanelOptions): Promise<PanelHandle> {
    return this.panelRuntime.openPanel(source, options);
  }

  protected getPanelHandle(id: string, kind?: "workspace" | "browser"): PanelHandle {
    return this.panelRuntime.getPanelHandle(id, kind);
  }

  protected get panelTree(): PanelRuntimeTree {
    return this.panelRuntime.panelTree;
  }

  protected override resetRpcClients(): void {
    super.resetRpcClients();
    this._panelRuntime = null;
  }
}
