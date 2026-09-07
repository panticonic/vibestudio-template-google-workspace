import { Suspense, lazy } from "react";
import { Dialog, Flex, Spinner, Text } from "@radix-ui/themes";
import { useChatContext } from "../context/ChatContext";

const AgentDebugConsole = lazy(() =>
  import("./AgentDebugConsole").then((module) => ({ default: module.AgentDebugConsole }))
);

/**
 * Agent debug console modal. Reads from ChatContext.
 */
export function ChatDebugConsole() {
  const { debugConsoleAgent, debugEvents, onDebugConsoleChange } = useChatContext();
  if (!debugConsoleAgent) return null;

  return (
    <Suspense
      fallback={
        <Dialog.Root open onOpenChange={(open) => !open && onDebugConsoleChange(null)}>
          <Dialog.Content>
            <Dialog.Title>Debug Console</Dialog.Title>
            <Dialog.Description>Preparing agent diagnostics.</Dialog.Description>
            <Flex align="center" gap="2">
              <Spinner size="1" />
              <Text size="2" color="gray">
                Loading diagnostics…
              </Text>
            </Flex>
          </Dialog.Content>
        </Dialog.Root>
      }
    >
      <AgentDebugConsole
        open
        onOpenChange={(open) => !open && onDebugConsoleChange(null)}
        agentHandle={debugConsoleAgent}
        debugEvents={debugEvents}
      />
    </Suspense>
  );
}
