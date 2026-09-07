/** Workspace-native image generation using the pi-imagegen Codex protocol.
 * Protocol reference: https://github.com/Jon-Vii/pi-imagegen (MIT).
 * Credentials stay in the host; files use the canonical semantic mutation engine.
 */
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import { createExtensionProxy } from "@vibestudio/extension";
import type { RpcCaller } from "@vibestudio/rpc";
import { readResponseEvents, type CodexSession } from "../codex-responses.js";
import { mutateFiles, mutationResultText } from "./file-mutation.js";
import type { ToolEditingVcs, ToolMutationContext } from "./tool-vcs.js";
import type { RuntimeFs } from "./runtime-fs.js";
import type { AgentFileVisibility } from "./agent-file-visibility.js";
import type { WorkspaceFileObservationStore } from "./file-observations.js";
import { bytesToBase64, canonicalBase64Bytes } from "./portable-bytes.js";
import { resolveToCwd } from "./path-utils.js";

const schema = Type.Object(
  {
    prompt: Type.String({
      minLength: 1,
      description:
        "Describe the image to generate or the changes to make to reference images.",
    }),
    outputPath: Type.String({
      minLength: 1,
      description:
        "Destination in an existing workspace repository, or .tmp/<name> for scratch. Match the extension to outputFormat.",
    }),
    referencePaths: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        maxItems: 16,
        description:
          "Workspace image paths used as visual references for generation or editing.",
      }),
    ),
    size: Type.Optional(
      Type.Union([
        Type.Literal("auto"),
        Type.Literal("1024x1024"),
        Type.Literal("1536x1024"),
        Type.Literal("1024x1536"),
      ]),
    ),
    quality: Type.Optional(
      Type.Union([
        Type.Literal("auto"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
      ]),
    ),
    background: Type.Optional(
      Type.Union([
        Type.Literal("auto"),
        Type.Literal("opaque"),
        Type.Literal("transparent"),
      ]),
    ),
    outputFormat: Type.Optional(
      Type.Union([
        Type.Literal("png"),
        Type.Literal("jpeg"),
        Type.Literal("webp"),
      ]),
    ),
    createOnly: Type.Optional(
      Type.Boolean({
        description:
          "Defaults to true. Set false to replace an existing image; previously read files are protected against stale overwrites.",
      }),
    ),
  },
  { additionalProperties: false },
);

interface ImageItem {
  type?: string;
  id?: string;
  result?: string;
  revised_prompt?: string;
}
interface ImageEvent {
  item?: ImageItem;
  message?: string;
  error?: { message?: string };
  response?: {
    id?: string;
    status?: string;
    error?: { message?: string };
    output?: ImageItem[];
  };
}

export function createImagegenTool(deps: {
  cwd: string;
  fs: RuntimeFs;
  rpc: RpcCaller;
  vcs: ToolEditingVcs;
  context: ToolMutationContext;
  visibility: AgentFileVisibility;
  observations: WorkspaceFileObservationStore;
  resolveSession: (signal?: AbortSignal) => Promise<CodexSession>;
}): AgentTool<typeof schema> {
  return {
    name: "imagegen",
    label: "Generate image",
    description:
      "Generate or edit an image with the connected OpenAI Codex subscription (gpt-image-2). Saves the original image to the workspace through semantic VCS and returns a visible preview. Supply referencePaths for image edits. Requires a connected openai-codex provider, regardless of the conversation model. Use read to inspect images and notify to share them with the user.",
    parameters: schema,
    cancellationMode: "settle",
    execute: async (_toolCallId, input, signal) => {
      signal?.throwIfAborted();
      if (
        typeof input.prompt !== "string" ||
        !input.prompt.trim() ||
        typeof input.outputPath !== "string" ||
        !input.outputPath.trim()
      )
        throw new Error("imagegen requires prompt and outputPath");
      const format = input.outputFormat ?? "png";
      const extension = input.outputPath.split(".").pop()?.toLowerCase();
      if (
        !(extension === format || (format === "jpeg" && extension === "jpg"))
      ) {
        throw new Error(
          `outputPath must have a ${format} extension matching outputFormat`,
        );
      }
      const session = await deps.resolveSession(signal);
      const imageService = createExtensionProxy<{
        detectMimeType(data: {
          __bin: true;
          data: string;
        }): Promise<string | null>;
      }>(deps.rpc, "@workspace-extensions/image-service", () => false);
      const content: Array<Record<string, unknown>> = [
        { type: "input_text", text: input.prompt },
      ];
      for (const path of input.referencePaths ?? []) {
        signal?.throwIfAborted();
        const absolute = resolveToCwd(path, deps.cwd);
        if (await deps.visibility.isHidden(absolute))
          throw new Error(`Path not found: ${path}`);
        const bytes = await deps.fs.readFile(absolute);
        if (!(bytes instanceof Uint8Array))
          throw new Error(`Not an image: ${path}`);
        const base64 = bytesToBase64(bytes);
        const mimeType = await imageService.detectMimeType({
          __bin: true,
          data: base64,
        });
        if (
          !mimeType ||
          !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
            mimeType,
          )
        )
          throw new Error(`Unsupported reference image: ${path}`);
        content.push({
          type: "input_image",
          image_url: `data:${mimeType};base64,${base64}`,
        });
      }
      const response = await session.fetcher(
        "https://chatgpt.com/backend-api/codex/responses",
        {
          method: "POST",
          headers: {
            accept: "text/event-stream",
            "content-type": "application/json",
            "chatgpt-account-id": session.accountId,
            originator: "codex_cli_rs",
            "OpenAI-Beta": "responses=experimental",
            ...(session.sessionId ? { session_id: session.sessionId } : {}),
          },
          body: JSON.stringify({
            model: session.model,
            instructions:
              "Generate the requested image using image_generation. Use supplied images as visual references. Generate exactly one image.",
            input: [{ type: "message", role: "user", content }],
            tools: [
              {
                type: "image_generation",
                model: "gpt-image-2",
                size: input.size ?? "auto",
                quality: input.quality ?? "auto",
                background: input.background ?? "auto",
                output_format: format,
                moderation: "auto",
              },
            ],
            tool_choice: { type: "image_generation" },
            parallel_tool_calls: false,
            store: false,
            stream: true,
          }),
          signal,
        },
      );
      if (!response.ok)
        throw new Error(
          `Codex image generation failed: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
        );
      if (!response.body)
        throw new Error("Codex image generation returned no response body");
      const images = new Map<string, ImageItem>();
      let completed = false;
      let responseId: string | undefined;
      for await (const { type, data } of readResponseEvents<ImageEvent>(
        response.body,
      )) {
        signal?.throwIfAborted();
        if (
          type === "error" ||
          type === "response.failed" ||
          type === "response.incomplete"
        ) {
          throw new Error(
            data.response?.error?.message ??
              data.error?.message ??
              data.message ??
              `Codex image generation ${type}`,
          );
        }
        if (
          type === "response.output_item.done" &&
          data.item?.type === "image_generation_call"
        )
          images.set(data.item.id ?? "image", data.item);
        if (type === "response.completed") {
          completed = true;
          responseId = data.response?.id;
          for (const item of data.response?.output ?? []) {
            if (item.type === "image_generation_call")
              images.set(item.id ?? "image", item);
          }
          break;
        }
      }
      if (!completed)
        throw new Error(
          "Codex image generation stream ended before completion",
        );
      if (images.size !== 1)
        throw new Error(
          `Expected one generated image, received ${images.size}`,
        );
      const image = [...images.values()][0]!;
      if (!image.result)
        throw new Error("Codex image generation completed without image data");
      const base64 = canonicalBase64Bytes(image.result).base64;
      const generatedMimeType = await imageService.detectMimeType({
        __bin: true,
        data: base64,
      });
      if (generatedMimeType !== `image/${format}`)
        throw new Error(
          "Generated image data does not match the requested output format",
        );
      signal?.throwIfAborted();
      const mutation = await mutateFiles(
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
        deps.observations,
      );
      return {
        content: [
          { type: "text", text: mutationResultText(mutation) },
          { type: "image", data: base64, mimeType: `image/${format}` },
        ],
        details: {
          provider: "openai-codex",
          responseModel: session.model,
          imageModel: "gpt-image-2",
          responseId,
          imageId: image.id,
          revisedPrompt: image.revised_prompt,
          outputPath: input.outputPath,
          mutation,
        },
      };
    },
  };
}
