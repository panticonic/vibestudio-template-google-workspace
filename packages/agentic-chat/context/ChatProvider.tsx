import { useMemo, type ReactNode } from "react";
import {
  ChatComposerRuntimeContext,
  ChatContext,
  ChatMessageActionsContext,
  type ChatComposerRuntimeValue,
  type ChatMessageActionsValue,
} from "./ChatContext";
import {
  ChatInputActionsContext,
  ChatInputContext,
  type ChatInputActionsValue,
} from "./ChatInputContext";
import type { ChatContextValue, ChatInputContextValue } from "../types";

export interface ChatProviderProps {
  value: ChatContextValue;
  inputValue: ChatInputContextValue;
  children: ReactNode;
}

/**
 * Provides chat state and handlers to all child components via React context.
 *
 * Keeps the public full contexts while publishing stable internal slices for
 * row actions and composer runtime. Transcript streaming and input keystrokes
 * therefore reach only consumers that use the changing projection.
 *
 * Usage:
 * ```tsx
 * const { contextValue, inputContextValue } = useAgenticChat({ config, channelName, tools });
 * <ChatProvider value={contextValue} inputValue={inputContextValue}>
 *   <ChatLayout features={features} />
 * </ChatProvider>
 * ```
 */
export function ChatProvider({ value, inputValue, children }: ChatProviderProps) {
  const messageActions = useMemo<ChatMessageActionsValue>(
    () => ({
      editPendingMessage: value.editPendingMessage,
      forkState: value.forkState,
      onNewConversation: value.onNewConversation,
      childTranscript: value.childTranscript,
      onOpenChannel: value.onOpenChannel,
    }),
    [
      value.editPendingMessage,
      value.forkState,
      value.onNewConversation,
      value.childTranscript,
      value.onOpenChannel,
    ]
  );
  const composerRuntime = useMemo<ChatComposerRuntimeValue>(
    () => ({
      agentBusy: value.agentBusy,
      allParticipants: value.allParticipants,
      chat: value.chat,
      connected: value.connected,
      flushNarration: value.flushNarration,
      flushOutboxAndInterrupt: value.flushOutboxAndInterrupt,
      hasOpenTurn: value.hasOpenTurn,
      modelCatalog: value.modelCatalog,
      onCallMethodResult: value.onCallMethodResult,
      onReplaceAgent: value.onReplaceAgent,
      participants: value.participants,
      pendingSendCount: value.pendingSendCount,
      primaryActionIntent: value.primaryActionIntent,
      selfId: value.selfId,
      undoableAction: value.undoableAction,
      undoLastAction: value.undoLastAction,
    }),
    [
      value.agentBusy,
      value.allParticipants,
      value.chat,
      value.connected,
      value.flushNarration,
      value.flushOutboxAndInterrupt,
      value.hasOpenTurn,
      value.modelCatalog,
      value.onCallMethodResult,
      value.onReplaceAgent,
      value.participants,
      value.pendingSendCount,
      value.primaryActionIntent,
      value.selfId,
      value.undoableAction,
      value.undoLastAction,
    ]
  );
  const inputActions = useMemo<ChatInputActionsValue>(
    () => ({
      onInputChange: inputValue.onInputChange,
      setReplyTo: inputValue.setReplyTo,
    }),
    [inputValue.onInputChange, inputValue.setReplyTo]
  );

  return (
    <ChatContext.Provider value={value}>
      <ChatMessageActionsContext.Provider value={messageActions}>
        <ChatComposerRuntimeContext.Provider value={composerRuntime}>
          <ChatInputActionsContext.Provider value={inputActions}>
            <ChatInputContext.Provider value={inputValue}>{children}</ChatInputContext.Provider>
          </ChatInputActionsContext.Provider>
        </ChatComposerRuntimeContext.Provider>
      </ChatMessageActionsContext.Provider>
    </ChatContext.Provider>
  );
}
