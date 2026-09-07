import { Suspense, lazy } from "react";
import { Dialog, Flex, Spinner, Text } from "@radix-ui/themes";
import type { AgentDialogProps } from "./AgentDialog";

const AgentDialog = lazy(() =>
  import("./AgentDialog").then((module) => ({ default: module.AgentDialog }))
);

/**
 * Agent configuration pulls in the model picker and provider setup UI. Keep it
 * off the chat startup path, while still opening an immediate loading dialog
 * when the user asks for it.
 */
export function LazyAgentDialog(props: AgentDialogProps) {
  if (!props.open) return null;

  return (
    <Suspense
      fallback={
        <Dialog.Root open onOpenChange={props.onOpenChange}>
          <Dialog.Content>
            <Dialog.Title>Agent settings</Dialog.Title>
            <Dialog.Description>Preparing the agent configuration controls.</Dialog.Description>
            <Flex align="center" gap="2">
              <Spinner size="1" />
              <Text size="2" color="gray">
                Loading agent settings…
              </Text>
            </Flex>
          </Dialog.Content>
        </Dialog.Root>
      }
    >
      <AgentDialog {...props} />
    </Suspense>
  );
}
