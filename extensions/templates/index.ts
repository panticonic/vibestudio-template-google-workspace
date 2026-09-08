import type {
  TemplateAuthoringIntent,
  TemplateInspection,
  TemplateLocator,
  TemplatePublication,
} from "@vibestudio/service-schemas/templates";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type { ExtensionContextLike } from "./context.js";
import {
  inspectTemplateAuthoring,
  listTemplateAuthoringParts,
} from "./authoring.js";
import { observeWorkspace } from "./workspace.js";
import { retainedInspectionPin } from "./inspectionPin.js";
import { discoverDirectTemplatePin } from "./source.js";

export async function resolveInspectionPin(
  ctx: ExtensionContextLike,
  locator: TemplateLocator,
) {
  const retained = retainedInspectionPin(locator);
  if (retained) return WorkspaceTemplatePinSchema.parse(retained);
  if ("url" in locator)
    return discoverDirectTemplatePin(ctx, ctx.storage.root, locator);
  throw new Error("Unsupported template locator");
}

async function inspect(ctx: ExtensionContextLike, locator: TemplateLocator) {
  const pin = await resolveInspectionPin(ctx, locator);
  return ctx.rpc.call<TemplateInspection>(
    "main",
    "workspaceTemplateSource.inspectExact",
    pin,
  );
}

export async function activate(ctx: ExtensionContextLike) {
  ctx.log.info("templates activating");
  return {
    resolveSource: (source: { url: string; credential?: string }) =>
      discoverDirectTemplatePin(ctx, ctx.storage.root, source),
    inspect: (locator: TemplateLocator) => inspect(ctx, locator),
    inspectAuthoring: async (input: TemplateAuthoringIntent) =>
      inspectTemplateAuthoring(ctx, await observeWorkspace(ctx), input),
    authoringParts: async () =>
      listTemplateAuthoringParts(ctx, await observeWorkspace(ctx)),
    async publishAuthoring(input: {
      commandId: string;
      intent: TemplateAuthoringIntent;
      expectedFingerprint: string;
      version: string;
      destination: { provider: string; owner: string; name: string };
      credentialId?: string;
      creation?: { private?: boolean; description?: string };
    }) {
      const observation = await observeWorkspace(ctx);
      const current = await inspectTemplateAuthoring(
        ctx,
        observation,
        input.intent,
      );
      if (current.fingerprint !== input.expectedFingerprint)
        throw new Error(
          "Workspace source changed after inspection; inspect authoring again",
        );
      return ctx.extensions.invoke<TemplatePublication>(
        "@workspace-extensions/git-bridge",
        "publishTemplate",
        [
          {
            operationId: input.commandId,
            expectedMainEventId: current.mainEventId,
            templateName: current.request.name,
            version: input.version,
            manifest: current.manifest,
            manifestDigest: current.manifestDigest,
            parts: current.includedParts.map((repoPath) => ({
              repoPath,
              subdir: repoPath,
            })),
            destination: input.destination,
            ...(input.credentialId ? { credentialId: input.credentialId } : {}),
            creation: {
              private: input.creation?.private ?? true,
              description:
                input.creation?.description ?? input.intent.description,
            },
          },
        ],
      );
    },
  };
}
export type Api = Awaited<ReturnType<typeof activate>>;
