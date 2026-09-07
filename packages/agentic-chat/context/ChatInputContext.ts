import { createContext, useContext } from "react";
import type { Participant } from "@workspace/pubsub";
import type { ChatInputContextValue, ChatParticipantMetadata } from "../types";
import type { AccountProfile } from "../hooks/useAccountProfiles";

const MENTION_TOKEN_RE = /(^|[\s([{])@([A-Za-z0-9_.-]+)/g;
const EMPTY_PROFILES: ReadonlyMap<string, AccountProfile> = new Map();

export function getMentionsFromInput(
  text: string,
  roster: Record<string, Participant<ChatParticipantMetadata>>,
  selectedMentions?: Record<string, string>,
  profiles: ReadonlyMap<string, AccountProfile> = EMPTY_PROFILES
): string[] {
  const handleToIds = new Map<string, string[]>();
  for (const [participantId, participant] of Object.entries(roster)) {
    const handle = profiles.get(participantId)?.handle ?? participant.metadata.handle;
    if (!handle) continue;
    const key = handle.toLowerCase();
    const ids = handleToIds.get(key) ?? [];
    ids.push(participantId);
    handleToIds.set(key, ids);
  }

  const mentions = new Set<string>();
  for (const match of text.matchAll(MENTION_TOKEN_RE)) {
    const handle = match[2]?.toLowerCase();
    if (!handle) continue;
    const ids = handleToIds.get(handle);
    if (!ids) continue;
    const selectedId = selectedMentions?.[handle];
    if (selectedId && ids.includes(selectedId)) {
      mentions.add(selectedId);
      continue;
    }
    for (const id of ids) mentions.add(id);
  }
  return [...mentions];
}

export const ChatInputContext = createContext<ChatInputContextValue | null>(null);
export type ChatInputActionsValue = Pick<ChatInputContextValue, "onInputChange" | "setReplyTo">;
export const ChatInputActionsContext = createContext<ChatInputActionsValue | null>(null);

/**
 * Access the chat input context. Must be used within a `<ChatProvider>`.
 * Throws if used outside of a ChatProvider.
 */
export function useChatInputContext(): ChatInputContextValue {
  const ctx = useContext(ChatInputContext);
  if (!ctx) {
    throw new Error("useChatInputContext must be used within a <ChatProvider>");
  }
  return ctx;
}

export function useChatInputActions(): ChatInputActionsValue {
  const ctx = useContext(ChatInputActionsContext);
  if (!ctx) {
    throw new Error("useChatInputActions must be used within a <ChatProvider>");
  }
  return ctx;
}

export function useOptionalChatInputActions(): ChatInputActionsValue | null {
  return useContext(ChatInputActionsContext);
}
