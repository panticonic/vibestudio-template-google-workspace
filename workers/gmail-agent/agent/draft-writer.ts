import type { AssistantMessage, Context } from "@panticonic/pi-ai";
import type { GmailMessage, GmailThread } from "@workspace/gmail";
import { header, latestMessage, textFromPart } from "../sync/thread-model.js";
import { DRAFT_REPLY_SYSTEM_PROMPT } from "./prompts.js";

export function modelReplyText(message: AssistantMessage): string {
  if (message.stopReason === "error" || message.stopReason === "aborted")
    throw new Error(
      message.errorMessage || `Model request ${message.stopReason}`,
    );
  return message.content
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )
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
              textFromPart(message.payload).slice(0, 4_000) ||
                message.snippet ||
                "",
            ].join("\n"),
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
  thread: GmailThread;
  generate: (context: Context) => Promise<AssistantMessage>;
}): Promise<string> {
  const response = await opts.generate(buildDraftReplyContext(opts.thread));
  return (
    modelReplyText(response) ||
    "Thanks for the note. I will take a look and follow up shortly."
  );
}
