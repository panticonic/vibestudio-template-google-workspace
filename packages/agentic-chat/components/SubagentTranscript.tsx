import { Box, Button, Callout, Flex, Spinner, Text } from "@radix-ui/themes";
import { MessageList } from "./MessageList";
import { useChildTranscript, type ChildTranscriptConnection } from "../hooks/useChildTranscript";
import type { ChildTranscriptResult } from "../hooks/useChildTranscript";

/**
 * The child's real transcript, rendered by the same `MessageList` that renders
 * the parent conversation. Every affordance the main chat has — consolidated
 * tool pills, expand-in-place argument/result inspection, thinking blocks,
 * markdown bodies — is present here because it is literally the same renderer,
 * not a reimplementation.
 *
 * Mounted only while the user has asked for it (see `useChildTranscript`), so
 * the observer subscription exists exactly as long as the view does.
 */
export function SubagentTranscript({
  connection,
  channelId,
  contextId,
  chat,
}: {
  connection: ChildTranscriptConnection;
  channelId: string;
  contextId: string | null;
  chat?: Record<string, unknown>;
}) {
  const transcript = useChildTranscript({
    connection,
    channelId,
    contextId,
    enabled: true,
  });
  return <SubagentTranscriptContent transcript={transcript} chat={chat} />;
}

export function SubagentTranscriptContent({
  transcript,
  chat,
}: {
  transcript: ChildTranscriptResult;
  chat?: Record<string, unknown>;
}) {
  const { messages, participants, selfId, loading, error } = transcript;

  if (error && messages.length === 0) {
    return (
      <Callout.Root color="amber" size="1" className="subagent-transcript-error">
        <Callout.Text>
          Could not open the child&rsquo;s transcript ({error}). The retained task result remains
          available for inspection.
        </Callout.Text>
        <Button size="1" variant="soft" color="amber" onClick={transcript.retry}>
          Retry transcript
        </Button>
      </Callout.Root>
    );
  }

  if (loading && messages.length === 0) {
    return (
      <Flex align="center" gap="2" className="subagent-transcript-loading">
        <Spinner size="1" />
        <Text size="1" color="gray">
          Loading the child&rsquo;s transcript…
        </Text>
      </Flex>
    );
  }

  if (messages.length === 0) {
    return (
      <Text size="1" color="gray" className="subagent-transcript-empty">
        The child has not recorded any messages yet.
      </Text>
    );
  }

  return (
    <Box className="subagent-transcript" data-testid="subagent-transcript">
      {error ? (
        <Callout.Root color="amber" size="1" className="subagent-transcript-error">
          <Callout.Text>
            Live transcript refresh was interrupted ({error}). The loaded history is preserved.
          </Callout.Text>
          <Button size="1" variant="soft" color="amber" onClick={transcript.retry}>
            Retry refresh
          </Button>
        </Callout.Root>
      ) : null}
      <MessageList
        messages={messages}
        participants={participants}
        selfId={selfId as never}
        allParticipants={participants}
        hasMoreHistory={transcript.hasMoreHistory}
        loadingMore={transcript.loadingMore}
        onLoadEarlierMessages={transcript.loadEarlierMessages}
        {...(chat ? { chat } : {})}
      />
    </Box>
  );
}
