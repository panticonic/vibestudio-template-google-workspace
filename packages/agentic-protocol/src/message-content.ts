import type { MessageBlockInput } from "./events.js";

export function messageDisplayText(blocks: MessageBlockInput[] | undefined): string {
  return (blocks ?? [])
    .filter((block) => block.type === "text" && block.content?.trim())
    .map((block) => block.content!)
    .join("\n")
    .trim();
}

export interface MessageContentSummary {
  hasText: boolean;
  hasThinking: boolean;
  hasInvocations: boolean;
  hasAttachmentOrData: boolean;
  hasDiagnostic: boolean;
  isEmpty: boolean;
}

export function summarizeMessageBlocks(
  blocks: MessageBlockInput[] | undefined
): MessageContentSummary {
  let hasText = false;
  let hasThinking = false;
  let hasInvocations = false;
  let hasAttachmentOrData = false;
  let hasDiagnostic = false;

  for (const block of blocks ?? []) {
    if (block.type === "text") hasText ||= Boolean(block.content?.trim());
    else if (block.type === "thinking") hasThinking ||= Boolean(block.content?.trim());
    else if (block.type === "invocation") hasInvocations = true;
    else if (block.type === "attachment" || block.type === "data") hasAttachmentOrData = true;
    else if (block.type === "diagnostic") hasDiagnostic = true;
  }

  return {
    hasText,
    hasThinking,
    hasInvocations,
    hasAttachmentOrData,
    hasDiagnostic,
    isEmpty: !hasText && !hasThinking && !hasInvocations && !hasAttachmentOrData && !hasDiagnostic,
  };
}
