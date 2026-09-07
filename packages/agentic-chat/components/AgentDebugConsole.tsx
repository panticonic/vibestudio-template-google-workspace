/**
 * Agent Debug Console
 *
 * Modal overlay showing agent's debug output (stdout/stderr, lifecycle events).
 * Opens from the participant badge dropdown menu.
 */

import { useRef, useEffect } from "react";
import { Box, Button, Dialog, Flex, ScrollArea, Text } from "@radix-ui/themes";
import type { AgentDebugPayload } from "@workspace/pubsub";

export interface AgentDebugConsoleProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentHandle: string;
  debugEvents: Array<AgentDebugPayload & { ts: number }>;
}

/**
 * Render a single debug event line.
 */
function DebugEventLine({ event }: { event: AgentDebugPayload & { ts: number } }) {
  const time = new Date(event.ts).toLocaleTimeString();

  if (event.debugType === "lifecycle") {
    const isError = event.event === "stopped" && event.reason === "crash";
    const color = isError ? "red" : "gray";
    const reasonText = event.reason ? ` (${event.reason})` : "";
    return (
      <Text as="div" size="1" color={color} style={{ fontFamily: "monospace" }}>
        [{time}] {event.event.toUpperCase()}
        {reasonText}
      </Text>
    );
  }

  if (event.debugType === "spawn-error") {
    const errorText = event.error ?? event.buildError?.message ?? "Unknown error";
    return (
      <Text
        as="div"
        size="1"
        color="red"
        style={{ fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
      >
        [{time}] SPAWN ERROR: {errorText}
      </Text>
    );
  }

  if (event.debugType === "log") {
    const levelColors: Record<string, "gray" | "blue" | "orange" | "red"> = {
      debug: "gray",
      info: "blue",
      warn: "orange",
      error: "red",
    };
    const color = levelColors[event.level] ?? "gray";
    const levelLabel = event.level.toUpperCase().padEnd(5);
    return (
      <Text
        as="div"
        size="1"
        color={color}
        style={{ fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
      >
        [{time}] [{levelLabel}] {event.message}
        {event.stack && (
          <Text as="div" size="1" color="gray" style={{ marginLeft: "1em", opacity: 0.7 }}>
            {event.stack}
          </Text>
        )}
      </Text>
    );
  }

  // Output event (stdout/stderr)
  if (event.debugType === "output") {
    const color = event.stream === "stderr" ? "red" : "gray";
    return (
      <Text
        as="div"
        size="1"
        color={color}
        style={{ fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
      >
        [{time}] {event.content}
      </Text>
    );
  }

  // Unknown event type - render as JSON for debugging
  return (
    <Text as="div" size="1" color="gray" style={{ fontFamily: "monospace" }}>
      [{time}] {JSON.stringify(event)}
    </Text>
  );
}

export function AgentDebugConsole({
  open,
  onOpenChange,
  agentHandle,
  debugEvents,
}: AgentDebugConsoleProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Filter events for this agent
  const agentEvents = debugEvents.filter((e) => e.handle === agentHandle);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [agentEvents.length]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        style={{
          width: "min(700px, calc(100vw - 24px))",
          maxHeight: "min(80dvh, 720px)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Dialog.Title>Debug Console: @{agentHandle}</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="3">
          Agent logs, stdout/stderr output, and lifecycle events
        </Dialog.Description>

        <ScrollArea
          style={{
            height: "min(400px, 55dvh)",
            background: "var(--gray-2)",
            borderRadius: "var(--radius-2)",
          }}
        >
          <Box p="2">
            {agentEvents.length === 0 ? (
              <Text size="2" color="gray">
                No debug output yet
              </Text>
            ) : (
              agentEvents.map((event, i) => <DebugEventLine key={i} event={event} />)
            )}
            <div ref={bottomRef} />
          </Box>
        </ScrollArea>

        <Flex justify="end" mt="3" gap="2">
          <Button variant="soft" color="gray" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
