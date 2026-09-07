import { createContext, useContext } from "react";
import type { ChatContextValue } from "../types";

export const ChatContext = createContext<ChatContextValue | null>(null);

export type ChatMessageActionsValue = Pick<
  ChatContextValue,
  "editPendingMessage" | "forkState" | "onNewConversation" | "childTranscript" | "onOpenChannel"
>;

export type ChatComposerRuntimeValue = Pick<
  ChatContextValue,
  | "agentBusy"
  | "allParticipants"
  | "chat"
  | "connected"
  | "flushNarration"
  | "flushOutboxAndInterrupt"
  | "hasOpenTurn"
  | "modelCatalog"
  | "onCallMethodResult"
  | "onReplaceAgent"
  | "participants"
  | "pendingSendCount"
  | "primaryActionIntent"
  | "selfId"
  | "undoableAction"
  | "undoLastAction"
>;

export const ChatMessageActionsContext = createContext<ChatMessageActionsValue | null>(null);
export const ChatComposerRuntimeContext = createContext<ChatComposerRuntimeValue | null>(null);

/**
 * Access the chat context. Must be used within a `<ChatProvider>`.
 * Throws if used outside of a ChatProvider.
 */
export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChatContext must be used within a <ChatProvider>");
  }
  return ctx;
}

/**
 * Access the chat context without requiring a provider. Returns `null` when
 * rendered outside a `<ChatProvider>`.
 *
 * Item-render-depth components (MessageCard, ForkRow, SubagentRunCard) are
 * exported via MessageList and rendered provider-less in tests and standalone
 * transcript views. They use this so fork/edit affordances degrade gracefully
 * (hidden) instead of throwing when no chat context is present.
 */
export function useOptionalChatContext(): ChatContextValue | null {
  return useContext(ChatContext);
}

/**
 * Row-depth message actions are isolated from transcript and presence changes
 * so a streaming tail cannot wake every resident card.
 */
export function useOptionalChatMessageActions(): ChatMessageActionsValue | null {
  return useContext(ChatMessageActionsContext);
}

/**
 * Runtime state used by the composer, excluding the transcript and unrelated
 * shell projections that update while the user is typing.
 */
export function useChatComposerRuntime(): ChatComposerRuntimeValue {
  const ctx = useContext(ChatComposerRuntimeContext);
  if (!ctx) {
    throw new Error("useChatComposerRuntime must be used within a <ChatProvider>");
  }
  return ctx;
}
