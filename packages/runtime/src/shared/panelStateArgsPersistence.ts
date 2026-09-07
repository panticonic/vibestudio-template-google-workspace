import type { RpcClient } from "@vibestudio/rpc";
import { decodePanelStateArgs } from "@vibestudio/shared/panelStateArgs";
import { validateStateArgsAsync } from "@vibestudio/shared/asyncStateArgsValidator";
import type { StateArgsSchema } from "@vibestudio/shared/stateArgs";
import { asPanelSlotId } from "@vibestudio/shared/panel/idValues";
import { callWorkspaceState, createRuntimeWorkspaceStateClient } from "./workspaceStateClient.js";

type PanelStateArgsRpc = Pick<RpcClient, "call">;

interface PanelStateArgsDetail {
  currentHistory: { state_args: string | null };
  entity: { activeBuildKey?: string };
}

interface PanelBuildMetadata {
  stateArgsSchema?: StateArgsSchema;
}

export async function readPanelStateArgs<T = Record<string, unknown>>(
  rpc: PanelStateArgsRpc,
  panelId: string
): Promise<T> {
  const detail = await callWorkspaceState<PanelStateArgsDetail | null>(rpc, "panelTree.detail", [
    panelId,
  ]);
  if (!detail) throw new Error(`Panel not found: ${panelId}`);
  return decodePanelStateArgs(detail.currentHistory.state_args) as T;
}

export async function updatePanelStateArgs(
  rpc: PanelStateArgsRpc,
  panelId: string,
  updates: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const workspaceState = createRuntimeWorkspaceStateClient(rpc);
  const detail = (await workspaceState.getPanelDetail(
    asPanelSlotId(panelId)
  )) as PanelStateArgsDetail | null;
  if (!detail) throw new Error(`Panel not found: ${panelId}`);

  const current = decodePanelStateArgs(detail.currentHistory.state_args);
  const merged = Object.fromEntries(
    Object.entries({ ...current, ...updates }).filter(([, value]) => value !== null)
  );
  const metadata = detail.entity.activeBuildKey
    ? await rpc.call<PanelBuildMetadata | null>("main", "build.getBuildMetadata", [
        detail.entity.activeBuildKey,
        { includeExecutableModules: false },
      ])
    : null;
  const validation = await validateStateArgsAsync(merged, metadata?.stateArgsSchema);
  if (!validation.success) {
    throw new Error(`Invalid stateArgs: ${validation.error}`);
  }
  const next = validation.data as Record<string, unknown>;
  await workspaceState.updateCurrentStateArgs(asPanelSlotId(panelId), next);
  return next;
}
