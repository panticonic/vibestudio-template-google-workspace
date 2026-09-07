import { Box } from "@radix-ui/themes";
import { useChatContext } from "../context/ChatContext";
import { DirtyRepoWarning } from "./DirtyRepoWarning";

/**
 * Renders dirty repo warning callouts for agents spawned with uncommitted changes.
 * Reads from ChatContext.
 */
export function ChatDirtyRepoWarnings() {
  const { dirtyRepoWarnings, onDismissDirtyWarning } = useChatContext();

  if (dirtyRepoWarnings.size === 0) return null;

  return (
    <Box px="1" flexShrink="0">
      {Array.from(dirtyRepoWarnings.entries()).map(([name, state]) => (
        <DirtyRepoWarning
          key={name}
          agentName={name}
          dirtyRepo={state}
          onDismiss={() => onDismissDirtyWarning(name)}
        />
      ))}
    </Box>
  );
}
