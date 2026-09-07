/**
 * Dirty Repo Warning
 *
 * Shows a dismissible warning when an agent was spawned with uncommitted changes.
 */

import { Callout, Flex, Text, Button } from "@radix-ui/themes";
import { InfoCircledIcon, Cross2Icon } from "@radix-ui/react-icons";

export interface DirtyRepoWarningProps {
  agentName: string;
  dirtyRepo: { modified: string[]; untracked: string[]; staged: string[] };
  onDismiss: () => void;
}

export function DirtyRepoWarning({ agentName, dirtyRepo, onDismiss }: DirtyRepoWarningProps) {
  const totalChanges = dirtyRepo.modified.length + dirtyRepo.untracked.length + dirtyRepo.staged.length;

  return (
    <Callout.Root color="amber" size="1" mb="2">
      <Callout.Icon>
        <InfoCircledIcon />
      </Callout.Icon>
      <Callout.Text>
        <Flex justify="between" align="center">
          <Text size="2">
            <strong>{agentName}</strong> has {totalChanges} uncommitted change(s).
            Consider committing before testing.
          </Text>
          <Button variant="ghost" size="1" onClick={onDismiss}>
            <Cross2Icon />
          </Button>
        </Flex>
      </Callout.Text>
    </Callout.Root>
  );
}
