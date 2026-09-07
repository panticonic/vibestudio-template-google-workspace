import { Buffer } from "node:buffer";
import { canonicalJson } from "@vibestudio/content-addressing";
import type {
  VcsReadFileResult,
  VcsResolveRepositoryResult,
  VcsStatusResult,
} from "@vibestudio/service-schemas/vcs";
import type { ExtensionContextLike } from "./context.js";

const META_REPOSITORY = "meta";

function readText(file: NonNullable<VcsReadFileResult>): string {
  return file.content.kind === "text"
    ? file.content.text
    : Buffer.from(file.content.base64, "base64").toString("utf8");
}

export async function ensureExternalSemanticIntent(input: {
  ctx: ExtensionContextLike;
  contextId: string;
  fileName: string;
  intent: unknown;
  operationLabel: string;
}): Promise<void> {
  const { ctx } = input;
  await ctx.rpc.call("main", "runtime.createContext", { contextId: input.contextId });
  let status = await ctx.rpc.call<VcsStatusResult>("main", "vcs.status", {
    contextId: input.contextId,
  });
  if (!status.clean) {
    throw new Error(`${input.operationLabel} intent context has uncommitted work`);
  }
  const meta = await ctx.rpc.call<VcsResolveRepositoryResult>("main", "vcs.resolveRepository", {
    state: status.workingHead,
    repoPath: META_REPOSITORY,
  });
  if (!meta) throw new Error(`${input.operationLabel} intent context has no meta repository`);
  const existing = await ctx.rpc.call<VcsReadFileResult>("main", "vcs.readFile", {
    state: status.workingHead,
    repositoryId: meta.repositoryId,
    file: { kind: "path", path: input.fileName },
  });
  if (existing) {
    let observed: unknown;
    try {
      observed = JSON.parse(readText(existing));
    } catch {
      throw new Error(`${input.operationLabel} intent context contains invalid JSON`);
    }
    if (canonicalJson(observed) !== canonicalJson(input.intent)) {
      throw new Error(`${input.operationLabel} command was reused with different exact intent`);
    }
    return;
  }
  await ctx.rpc.call("main", "vcs.edit", {
    commandId: `${input.contextId}:record`,
    contextId: input.contextId,
    expectedWorkingHead: status.workingHead,
    intentSummary: `Record exact ${input.operationLabel} intent`,
    changes: [
      {
        kind: "file-create",
        repositoryId: meta.repositoryId,
        path: input.fileName,
        content: { kind: "text", text: `${JSON.stringify(input.intent, null, 2)}\n` },
        mode: 0o644,
      },
    ],
  });
  status = await ctx.rpc.call<VcsStatusResult>("main", "vcs.status", {
    contextId: input.contextId,
  });
  await ctx.rpc.call("main", "vcs.commit", {
    commandId: `${input.contextId}:commit`,
    contextId: input.contextId,
    expectedWorkingHead: status.workingHead,
    intentSummary: `Commit exact ${input.operationLabel} intent`,
    message: `Record ${input.operationLabel}`,
  });
}
