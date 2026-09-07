/** Thin agent-tool adapter for the canonical semantic VCS service. */

import { vcsMethods } from "@vibestudio/service-schemas/vcs";
import type { VcsCommitResult, VcsStateNodeRef } from "@vibestudio/service-schemas/vcs";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";

import { resolveToCwd } from "./path-utils.js";

export function toVcsPath(path: string, cwd: string): string {
  const abs = resolveToCwd(path, cwd);
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (abs === cwd || `${abs}/` === root) return "";
  if (!abs.startsWith(root)) throw new Error(`Path escapes the workspace root: ${path}`);
  return abs.slice(root.length);
}

export type ToolVcs = TypedServiceClient<typeof vcsMethods>;

export type ToolEditingVcs = Pick<
  ToolVcs,
  "status" | "resolveRepository" | "readFile" | "edit" | "commit"
>;

export type ToolFileTransferVcs = Pick<
  ToolVcs,
  "status" | "resolveRepository" | "readFile" | "move" | "copy"
>;

export interface ToolWorkspaceContext {
  readonly contextId: string | (() => string);
}

/** Trusted invocation binding required by every semantic mutation tool. */
export interface ToolMutationContext extends ToolWorkspaceContext {
  readonly commandId: string | (() => string);
  readonly integrationSourceResolver?: (sourceEventId: string) => { runId: string } | null;
  readonly onIntegrationSourcesCommitted?: (result: VcsCommitResult) => void;
}

export function toolContextId(context: ToolWorkspaceContext): string {
  return typeof context.contextId === "function" ? context.contextId() : context.contextId;
}

/** Resolve the command identity at mutation time, failing closed when unbound. */
export function toolCommandId(context: ToolMutationContext): string {
  const commandId =
    typeof context.commandId === "function" ? context.commandId() : context.commandId;
  if (commandId.length === 0) {
    throw new Error("A semantic mutation requires a bound trajectory invocation command id");
  }
  return commandId;
}

export async function resolveToolWorkingState(
  vcs: Pick<ToolVcs, "status">,
  context: ToolWorkspaceContext
): Promise<VcsStateNodeRef> {
  return (await vcs.status({ contextId: toolContextId(context) })).workingHead;
}

export function createToolVcs(
  callMain: <T>(method: string, args: unknown[]) => Promise<T>
): ToolVcs {
  return createTypedServiceClient("vcs", vcsMethods, (_service, method, args) =>
    callMain(`vcs.${method}`, args)
  );
}
