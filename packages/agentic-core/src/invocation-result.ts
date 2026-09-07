import type { MethodResultValue } from "@workspace/pubsub";

export type ChatMethodResult = MethodResultValue;

export function isChatMethodResult(value: unknown): value is ChatMethodResult {
  return !!value &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "content");
}

export function unwrapChatMethodResult(result: ChatMethodResult): unknown {
  return result.content;
}
