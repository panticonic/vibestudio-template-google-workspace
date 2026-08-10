import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Context } from "@earendil-works/pi-ai";
import type { GmailMessage, GmailThread } from "@workspace/gmail";
import { header, latestMessage, textFromPart } from "../sync/thread-model.js";
import { DRAFT_REPLY_SYSTEM_PROMPT } from "./prompts.js";

const PI_MODELS = builtinModels();

function textContentFromAssistant(message: Awaited<ReturnType<typeof PI_MODELS.complete>>): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

export function buildDraftReplyContext(thread: GmailThread): Context {
  const latest = latestMessage(thread);
  return {
    systemPrompt: DRAFT_REPLY_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        timestamp: Date.now(),
        content: [
          `Subject: ${latest ? (header(latest, "Subject") ?? "") : ""}`,
          "",
          "Thread:",
          ...(thread.messages ?? []).map((message: GmailMessage) =>
            [
              `From: ${header(message, "From") ?? ""}`,
              `Date: ${header(message, "Date") ?? ""}`,
              textFromPart(message.payload).slice(0, 4_000) || message.snippet || "",
            ].join("\n")
          ),
        ]
          .join("\n\n")
          .slice(0, 16_000),
      },
    ],
  };
}

/** One-shot LLM call that produces a reply body for a compose card. */
export async function generateDraftReplyBody(opts: {
  modelRef: string;
  apiKey: string | undefined;
  thread: GmailThread;
}): Promise<string> {
  const colonIdx = opts.modelRef.indexOf(":");
  if (colonIdx < 0) throw new Error(`Model must be "provider:model", got: ${opts.modelRef}`);
  const provider = opts.modelRef.slice(0, colonIdx);
  const modelId = opts.modelRef.slice(colonIdx + 1);
  const model = PI_MODELS.getModel(provider, modelId);
  if (!model) throw new Error(`No model metadata found for model provider: ${provider}`);

  const response = await PI_MODELS.complete(model, buildDraftReplyContext(opts.thread), {
    apiKey: opts.apiKey,
    temperature: 0.2,
    maxTokens: 300,
  });
  return (
    textContentFromAssistant(response) ||
    "Thanks for the note. I will take a look and follow up shortly."
  );
}
