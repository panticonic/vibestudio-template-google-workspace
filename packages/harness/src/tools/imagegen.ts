/** Workspace-native image generation using the pi-imagegen Codex protocol.
 * Protocol reference: https://github.com/Jon-Vii/pi-imagegen (MIT).
 * Credentials stay in the host; files use the canonical semantic mutation engine.
 */
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import type { RpcCaller } from "@vibestudio/rpc";
import {
  createImagesClient,
  IMAGE_REFERENCE_LIMIT,
  type ImageAsset,
} from "@workspace/runtime/images";
import { mutateFiles, mutationResultText } from "./file-mutation.js";
import type { ToolEditingVcs, ToolMutationContext } from "./tool-vcs.js";
import type { RuntimeFs } from "./runtime-fs.js";
import type { AgentFileVisibility } from "./agent-file-visibility.js";
import type { WorkspaceFileObservationStore } from "./file-observations.js";
import { bytesToBase64 } from "./portable-bytes.js";
import { resolveToCwd } from "./path-utils.js";

const schema = Type.Object(
  {
    prompt: Type.String({
      minLength: 1,
      description: "Describe the image to generate or the changes to make to reference images.",
    }),
    outputPath: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Destination in an existing workspace repository, or .tmp/<name> for scratch. Match the extension to outputFormat. Omit to generate a reusable image asset without saving a source file.",
      })
    ),
    referenceAssetIds: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { maxItems: IMAGE_REFERENCE_LIMIT })
    ),
    referencePaths: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        maxItems: IMAGE_REFERENCE_LIMIT,
        description: "Workspace image paths used as visual references for generation or editing.",
      })
    ),
    size: Type.Optional(
      Type.Union([
        Type.Literal("auto"),
        Type.Literal("1024x1024"),
        Type.Literal("1536x1024"),
        Type.Literal("1024x1536"),
      ])
    ),
    quality: Type.Optional(
      Type.Union([
        Type.Literal("auto"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
      ])
    ),
    background: Type.Optional(
      Type.Union([Type.Literal("auto"), Type.Literal("opaque"), Type.Literal("transparent")])
    ),
    outputFormat: Type.Optional(
      Type.Union([Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")])
    ),
    createOnly: Type.Optional(
      Type.Boolean({
        description:
          "Defaults to true. Set false to replace an existing image; previously read files are protected against stale overwrites.",
      })
    ),
  },
  { additionalProperties: false }
);

export function createImagegenTool(deps: {
  cwd: string;
  fs: RuntimeFs;
  rpc: RpcCaller;
  vcs: ToolEditingVcs;
  context: ToolMutationContext;
  visibility: AgentFileVisibility;
  observations: WorkspaceFileObservationStore;
}): AgentTool<typeof schema> {
  return {
    name: "imagegen",
    label: "Generate image",
    description:
      "Generate or edit an image with the connected OpenAI Codex subscription (gpt-image-2). Returns a durable image asset and visible preview. Optional outputPath saves the original through semantic VCS. Supply referenceAssetIds or referencePaths for edits. Running panels use images.generate and GeneratedImage with the same service. Requires a connected openai-codex provider, regardless of the conversation model. Use read to inspect images and notify to share them with the user.",
    parameters: schema,
    cancellationMode: "settle",
    execute: async (_toolCallId, input, signal) => {
      signal?.throwIfAborted();
      if (typeof input.prompt !== "string" || !input.prompt.trim())
        throw new Error("imagegen requires prompt");
      const format = input.outputFormat ?? "png";
      const extension = input.outputPath?.split(".").pop()?.toLowerCase();
      if (
        input.outputPath !== undefined &&
        !(extension === format || (format === "jpeg" && extension === "jpg"))
      ) {
        throw new Error(`outputPath must have a ${format} extension matching outputFormat`);
      }
      const images = createImagesClient(deps.rpc);
      const references: ImageAsset[] = [];
      const imported: ImageAsset[] = [];
      const importOwner = `tool:${_toolCallId}`;
      try {
        for (const id of input.referenceAssetIds ?? []) references.push(await images.getAsset(id));
        for (const path of input.referencePaths ?? []) {
          signal?.throwIfAborted();
          const absolute = resolveToCwd(path, deps.cwd);
          if (await deps.visibility.isHidden(absolute)) throw new Error(`Path not found: ${path}`);
          const bytes = await deps.fs.readFile(absolute);
          if (!(bytes instanceof Uint8Array)) throw new Error(`Not an image: ${path}`);
          const base64 = bytesToBase64(bytes);
          const reference = await images.importAsset({ base64, owner: importOwner });
          imported.push(reference);
          references.push(reference);
        }
        const uniqueReferences = [
          ...new Map(references.map((asset) => [asset.id, asset])).values(),
        ];
        if (uniqueReferences.length > IMAGE_REFERENCE_LIMIT) {
          throw new Error(
            `Image generation accepts at most ${IMAGE_REFERENCE_LIMIT} distinct reference images`
          );
        }
        const job = await images.generate({
          requestId: `${deps.context.contextId}:${deps.context.commandId}:${_toolCallId}`,
          prompt: input.prompt,
          references: uniqueReferences,
          size: input.size,
          quality: input.quality,
          background: input.background,
          outputFormat: format,
        });
        let cancellation: Promise<unknown> | undefined;
        const abort = () => {
          cancellation = images.cancel(job.id);
          void cancellation.catch(() => undefined);
        };
        signal?.addEventListener("abort", abort, { once: true });
        let finished;
        try {
          if (signal?.aborted) {
            await images.cancel(job.id);
            signal.throwIfAborted();
          }
          finished = await images.wait(job.id, { signal });
        } finally {
          signal?.removeEventListener("abort", abort);
          if (cancellation) await cancellation;
        }
        if (finished.status !== "succeeded" || !finished.asset)
          throw new Error(finished.error ?? `Image generation ${finished.status}`);
        const asset = finished.asset;
        const { base64 } = await images.readAsset(asset.id);
        signal?.throwIfAborted();
        const mutation = input.outputPath
          ? await mutateFiles(
              deps.cwd,
              deps.vcs,
              deps.context,
              {
                operations: [
                  {
                    kind: "write_binary",
                    path: input.outputPath,
                    base64,
                    createOnly: input.createOnly ?? true,
                  },
                ],
                intent: input.prompt,
              },
              signal,
              deps.fs,
              deps.observations
            )
          : undefined;
        return {
          content: [
            {
              type: "text",
              text: mutation
                ? mutationResultText(mutation)
                : JSON.stringify({ asset, jobId: job.id }),
            },
            { type: "image", data: base64, mimeType: asset.mimeType },
          ],
          details: {
            ...asset.provenance,
            asset,
            jobId: job.id,
            outputPath: input.outputPath,
            mutation,
          },
        };
      } finally {
        await Promise.all(
          imported.map((asset) => images.release({ assetId: asset.id, owner: importOwner }))
        );
      }
    },
  };
}
