import { useMemo, useState } from "react";
import type { Participant } from "@workspace/pubsub";
import { isAgentParticipantType } from "@workspace/agentic-core";
import { useChatContext } from "../context/ChatContext";
import type { ChatParticipantMetadata } from "../types";
import type { AccountProfile } from "../hooks/useAccountProfiles";
import { LazyAgentDialog } from "./LazyAgentDialog";

interface UseConversationActionsOptions {
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  accountProfiles: Map<string, AccountProfile>;
  onRemoveAgent?: (handle: string) => void;
  onDebugConsoleChange?: (agentHandle: string | null) => void;
}

export interface ConversationParticipantAction {
  participant: Participant<ChatParticipantMetadata>;
  handle: string;
  isAgent: boolean;
}

export interface ConversationActionsController {
  participants: ConversationParticipantAction[];
  agents: ConversationParticipantAction[];
  canChangeAgent: boolean;
  agentActionLabel: "Add agent" | "Switch agent";
  canOpenClaudeCode: boolean;
  canOpenDebugConsole: boolean;
  canRemoveAgent: boolean;
  openAddAgent(): void;
  openAgentSettings(participantId: string): void;
  openDebugConsole(handle: string): void;
  requestRemoveAgent(handle: string): boolean;
  openClaudeCode(): void;
  addAgentOpen: boolean;
  setAddAgentOpen(open: boolean): void;
  settingsParticipantId: string | null;
  setSettingsParticipantId(participantId: string | null): void;
}

/** Shared behavior model; desktop and mobile provide only presentation. */
export function useConversationActions({
  participants,
  accountProfiles,
  onRemoveAgent,
  onDebugConsoleChange,
}: UseConversationActionsOptions): ConversationActionsController {
  const { channelId, messages, deferredAgent, onAddAgent, onReplaceAgent, onOpenClaudeCode } =
    useChatContext();
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [settingsParticipantId, setSettingsParticipantId] = useState<string | null>(null);

  const participantActions = useMemo(
    () =>
      Object.values(participants).map((participant) => ({
        participant,
        handle:
          accountProfiles.get(participant.id)?.handle ??
          participant.metadata.handle ??
          participant.id,
        isAgent: isAgentParticipantType(participant.metadata.type),
      })),
    [accountProfiles, participants]
  );
  const agents = useMemo(
    () => participantActions.filter((participant) => participant.isAgent),
    [participantActions]
  );
  const canChangeAgent = (!!onAddAgent || !!onReplaceAgent) && !deferredAgent?.active;
  const agentActionLabel =
    messages.length === 0 && agents.length === 1 && onReplaceAgent ? "Switch agent" : "Add agent";

  return {
    participants: participantActions,
    agents,
    canChangeAgent,
    agentActionLabel,
    canOpenClaudeCode: !!onOpenClaudeCode && !!channelId,
    canOpenDebugConsole: !!onDebugConsoleChange,
    canRemoveAgent: !!onRemoveAgent,
    openAddAgent: () => setAddAgentOpen(true),
    openAgentSettings: setSettingsParticipantId,
    openDebugConsole: (handle) => onDebugConsoleChange?.(handle),
    requestRemoveAgent: (handle) => {
      if (!onRemoveAgent || !window.confirm(`Remove @${handle} and its saved agent settings?`)) {
        return false;
      }
      onRemoveAgent(handle);
      return true;
    },
    openClaudeCode: () => {
      if (onOpenClaudeCode && channelId) void onOpenClaudeCode(channelId);
    },
    addAgentOpen,
    setAddAgentOpen,
    settingsParticipantId,
    setSettingsParticipantId,
  };
}

export function ConversationAgentDialogs({
  controller,
}: {
  controller: ConversationActionsController;
}) {
  return (
    <>
      <LazyAgentDialog open={controller.addAgentOpen} onOpenChange={controller.setAddAgentOpen} />
      {controller.settingsParticipantId ? (
        <LazyAgentDialog
          open
          onOpenChange={(open) => {
            if (!open) controller.setSettingsParticipantId(null);
          }}
          editParticipantId={controller.settingsParticipantId}
        />
      ) : null}
    </>
  );
}
