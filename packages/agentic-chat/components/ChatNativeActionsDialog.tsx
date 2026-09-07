import { useMemo } from "react";
import { Button, Card, Dialog, Flex, Text } from "@radix-ui/themes";
import { useChatContext } from "../context/ChatContext";
import { useAccountProfiles, type AccountRpc } from "../hooks/useAccountProfiles";
import { ChannelPeopleMenu } from "./ChannelPeopleMenu";
import { ForkSwitcher } from "./ForkSwitcher";
import { ToolPermissionsDropdown } from "./ToolPermissionsDropdown";
import { ConversationAgentDialogs, useConversationActions } from "./useConversationActions";

interface ChatNativeActionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Touch-oriented conversation controls opened from the native panel menu. */
export function ChatNativeActionsDialog({ open, onOpenChange }: ChatNativeActionsDialogProps) {
  const { participants, chat, toolApproval, onRemoveAgent, onDebugConsoleChange } =
    useChatContext();
  const participantIds = useMemo(() => Object.keys(participants), [participants]);
  const accountProfiles = useAccountProfiles(
    (chat as { rpc?: AccountRpc } | undefined)?.rpc,
    participantIds
  );
  const actions = useConversationActions({
    participants,
    accountProfiles,
    onRemoveAgent,
    onDebugConsoleChange,
  });

  const leaveDialog = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Content className="chat-native-actions-dialog" maxWidth="440px">
          <Dialog.Title>Conversation actions</Dialog.Title>
          <Dialog.Description size="2" color="gray">
            Manage this conversation without adding another toolbar to the panel.
          </Dialog.Description>

          <Flex direction="column" gap="4" mt="4">
            <Flex direction="column" gap="2">
              <Text size="1" weight="bold" color="gray">
                Conversation
              </Text>
              <Flex gap="2" wrap="wrap">
                <ForkSwitcher />
                <ChannelPeopleMenu />
              </Flex>
            </Flex>

            <Flex direction="column" gap="2">
              <Text size="1" weight="bold" color="gray">
                Agents
              </Text>
              {actions.agents.map(({ participant, handle }) => {
                return (
                  <Card key={participant.id} size="1" variant="surface">
                    <Flex align="center" justify="between" gap="2" wrap="wrap">
                      <Text size="2" weight="medium">
                        @{handle}
                      </Text>
                      <Flex gap="2" wrap="wrap">
                        <Button
                          size="2"
                          variant="soft"
                          onClick={() =>
                            leaveDialog(() => actions.openAgentSettings(participant.id))
                          }
                        >
                          Settings
                        </Button>
                        {actions.canOpenDebugConsole ? (
                          <Button
                            size="2"
                            variant="soft"
                            color="gray"
                            onClick={() => leaveDialog(() => actions.openDebugConsole(handle))}
                          >
                            Debug
                          </Button>
                        ) : null}
                        {actions.canRemoveAgent ? (
                          <Button
                            size="2"
                            variant="soft"
                            color="red"
                            onClick={() => {
                              if (actions.requestRemoveAgent(handle)) onOpenChange(false);
                            }}
                          >
                            Remove
                          </Button>
                        ) : null}
                      </Flex>
                    </Flex>
                  </Card>
                );
              })}
              <Flex gap="2" wrap="wrap">
                {actions.canChangeAgent ? (
                  <Button size="2" onClick={() => leaveDialog(actions.openAddAgent)}>
                    {actions.agentActionLabel}
                  </Button>
                ) : null}
                {actions.canOpenClaudeCode ? (
                  <Button
                    size="2"
                    variant="soft"
                    onClick={() => leaveDialog(actions.openClaudeCode)}
                  >
                    Open Claude Code
                  </Button>
                ) : null}
              </Flex>
            </Flex>

            {toolApproval ? (
              <Flex direction="column" gap="2">
                <Text size="1" weight="bold" color="gray">
                  Autonomy
                </Text>
                <Flex>
                  <ToolPermissionsDropdown
                    settings={toolApproval.settings}
                    onSetFloor={toolApproval.onSetFloor}
                  />
                </Flex>
              </Flex>
            ) : null}
          </Flex>

          <Flex justify="end" mt="5">
            <Dialog.Close>
              <Button variant="soft" color="gray" size="2">
                Done
              </Button>
            </Dialog.Close>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      <ConversationAgentDialogs controller={actions} />
    </>
  );
}
