import { readResponseEvents, type CodexSession } from "./codex-responses.js";
import { canonicalBase64Bytes } from "./tools/portable-bytes.js";
export type { CodexSession } from "./codex-responses.js";
export interface GenerateImageInput {
  prompt: string;
  references?: { base64: string; mimeType: string }[];
  size?: "auto" | "1024x1024" | "1536x1024" | "1024x1536";
  quality?: "auto" | "low" | "medium" | "high";
  background?: "auto" | "opaque" | "transparent";
  outputFormat?: "png" | "jpeg" | "webp";
}
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

export async function generateImage(
  input: GenerateImageInput,
  deps: { session: CodexSession; detectMimeType(base64: string): Promise<string | null> },
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  if (!input.prompt.trim()) throw new Error("Image prompt must not be empty");
  const session = deps.session;
  const format = input.outputFormat ?? "png";
  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: input.prompt }];
  for (const reference of input.references ?? [])
    content.push({
      type: "input_image",
      image_url: `data:${reference.mimeType};base64,${reference.base64}`,
    });
  const response = await session.fetcher("https://chatgpt.com/backend-api/codex/responses", {
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
  });
  if (!response.ok)
    throw new Error(
      `Codex image generation failed: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`
    );
  if (!response.body) throw new Error("Codex image generation returned no response body");
  const images = new Map<string, ImageItem>();
  let completed = false;
  let responseId: string | undefined;
  for await (const { type, data } of readResponseEvents<ImageEvent>(response.body)) {
    signal?.throwIfAborted();
    if (type === "error" || type === "response.failed" || type === "response.incomplete") {
      throw new Error(
        data.response?.error?.message ??
          data.error?.message ??
          data.message ??
          `Codex image generation ${type}`
      );
    }
    if (type === "response.output_item.done" && data.item?.type === "image_generation_call")
      images.set(data.item.id ?? "image", data.item);
    if (type === "response.completed") {
      completed = true;
      responseId = data.response?.id;
      for (const item of data.response?.output ?? []) {
        if (item.type === "image_generation_call") images.set(item.id ?? "image", item);
      }
      break;
    }
  }
  if (!completed) throw new Error("Codex image generation stream ended before completion");
  if (images.size !== 1) throw new Error(`Expected one generated image, received ${images.size}`);
  const image = [...images.values()][0]!;
  if (!image.result) throw new Error("Codex image generation completed without image data");
  const base64 = canonicalBase64Bytes(image.result).base64;
  const generatedMimeType = await deps.detectMimeType(base64);
  if (generatedMimeType !== `image/${format}`)
    throw new Error("Generated image data does not match the requested output format");

  return {
    base64,
    mimeType: generatedMimeType as "image/png" | "image/jpeg" | "image/webp",
    provenance: {
      provider: "openai-codex",
      responseModel: session.model,
      imageModel: "gpt-image-2",
      responseId,
      imageId: image.id,
      revisedPrompt: image.revised_prompt,
    },
  };
}
