import type {
  VcsListDirectoryResult,
  VcsStateNodeRef,
} from "@vibestudio/service-schemas/vcs";
import { WorkspaceConfigSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import type { ExtensionContextLike } from "./context.js";

export const META_REPOSITORY = "meta";
export interface SemanticWorkspaceObservation {
  mainEventId: string;
  mainState: VcsStateNodeRef;
  runtimeTop: Omit<WorkspaceConfig, "id">;
  localRepoPaths: Set<string>;
}

async function listDirectory(
  ctx: ExtensionContextLike,
  state: VcsStateNodeRef,
  directory: string,
) {
  const entries: NonNullable<VcsListDirectoryResult>["entries"] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.rpc.call<VcsListDirectoryResult>(
      "main",
      "vcs.listDirectory",
      {
        state,
        path: directory,
        ...(cursor ? { cursor } : {}),
        limit: 500,
      },
    );
    if (!page) break;
    entries.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return entries;
}
async function repositoryPaths(
  ctx: ExtensionContextLike,
  state: VcsStateNodeRef,
) {
  const result = new Set<string>();
  for (const root of await listDirectory(ctx, state, "")) {
    if (root.repositoryRoot) result.add(root.path);
    if (root.kind !== "directory" || root.repositoryRoot) continue;
    for (const child of await listDirectory(ctx, state, root.path))
      if (child.repositoryRoot) result.add(child.path);
  }
  return result;
}
export async function observeWorkspace(
  ctx: ExtensionContextLike,
): Promise<SemanticWorkspaceObservation> {
  const mainState = await ctx.rpc.call<
    Extract<VcsStateNodeRef, { kind: "event" }>
  >("main", "vcs.mainState");
  const info = await ctx.workspace.getInfo();
  if (!info.config)
    throw new Error("Workspace info did not expose its resolved configuration");
  const parsed = WorkspaceConfigSchema.parse({
    ...(info.config as object),
    id: info.id,
  });
  const { id: _id, ...runtimeTop } = parsed;
  return {
    mainEventId: mainState.eventId,
    mainState,
    runtimeTop,
    localRepoPaths: await repositoryPaths(ctx, mainState),
  };
}
