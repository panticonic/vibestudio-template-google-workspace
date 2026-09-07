/**
 * Contributes the chat panel's commands to its owning application host. Lives
 * inside `<ChatProvider>` so it can read the live delivery
 * state and actions straight from the chat context — the single place that has
 * them — and registers ONE state-aware command set (two `useHostCommands`
 * calls in the same panel would clobber each other's registration).
 *
 * The set is state-aware on purpose: the host only offers what is actually
 * actionable right now (flush only while something is queued/in-flight, cancel
 * only with queued messages, undo only inside the undo window), so the delivery
 * model — the same "now vs. next", "nothing happens invisibly" semantics as the
 * composer — is reachable by keyboard without hunting for the right gesture.
 *
 * Failed sends restore their draft to the composer rather than leaving a
 * separate retriable outbox entry.
 */
import { useMemo, useState } from "react";
import { useHostCommands } from "@workspace/react";
import { getVibestudioHostPlatform } from "@workspace/react/responsive";
import { useChatContext } from "../context/ChatContext";
import { deriveActiveOutbox } from "./Outbox";
import { ChatNativeActionsDialog } from "./ChatNativeActionsDialog";

type ChatCommand = { id: string; label: string; description?: string; group: string };

const SECTION = "Chat";

export function ChatHostCommands() {
  const [nativeActionsOpen, setNativeActionsOpen] = useState(false);
  const nativeHost = getVibestudioHostPlatform() === "mobile";
  const {
    onNewConversation,
    messages,
    selfId,
    participants,
    agentBusy,
    pendingSendCount,
    flushOutboxAndInterrupt,
    cancelPendingMessage,
    undoableAction,
    undoLastAction,
  } = useChatContext();

  const queuedMessageIds = useMemo(
    () => deriveActiveOutbox(messages, selfId, participants).map((message) => message.id),
    [messages, selfId, participants]
  );
  const queuedCount = queuedMessageIds.length;
  const canFlush = agentBusy || queuedCount > 0 || pendingSendCount > 0;
  const canUndo = !!undoableAction && !!undoLastAction;

  const commands = useMemo<ChatCommand[]>(() => {
    const cmds: ChatCommand[] = [];
    if (nativeHost) {
      cmds.push({
        id: "chat-conversation-actions",
        label: "Conversation actions",
        description: "People, agents, branches, and autonomy",
        group: SECTION,
      });
    }
    if (onNewConversation) {
      cmds.push({ id: "chat-new-conversation", label: "New conversation", group: SECTION });
    }
    if (canFlush) {
      cmds.push({
        id: "chat-flush",
        label: "Send queued now & interrupt",
        description: "Esc",
        group: SECTION,
      });
    }
    if (queuedCount > 0) {
      cmds.push({
        id: "chat-cancel-queued",
        label: queuedCount > 1 ? `Cancel ${queuedCount} queued messages` : "Cancel queued message",
        group: SECTION,
      });
    }
    if (canUndo) {
      cmds.push({ id: "chat-undo", label: "Undo last send action", group: SECTION });
    }
    return cmds;
  }, [nativeHost, onNewConversation, canFlush, queuedCount, canUndo]);

  useHostCommands(commands, (id) => {
    switch (id) {
      case "chat-conversation-actions":
        setNativeActionsOpen(true);
        break;
      case "chat-new-conversation":
        onNewConversation?.();
        break;
      case "chat-flush":
        void flushOutboxAndInterrupt();
        break;
      case "chat-cancel-queued":
        // Snapshot first — cancelling mutates the underlying set. Consecutive
        // cancels accumulate into one undoable action (see useChatCore).
        for (const messageId of queuedMessageIds) void cancelPendingMessage(messageId);
        break;
      case "chat-undo":
        undoLastAction?.();
        break;
    }
  });

  return nativeHost ? (
    <ChatNativeActionsDialog open={nativeActionsOpen} onOpenChange={setNativeActionsOpen} />
  ) : null;
}
