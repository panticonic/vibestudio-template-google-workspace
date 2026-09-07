import { useState } from "react";
import {
  AlertDialog,
  Badge,
  Button,
  Dialog,
  DropdownMenu,
  Flex,
  Text,
  TextField,
} from "@radix-ui/themes";
import { ChevronDownIcon } from "@radix-ui/react-icons";
import { useChatContext } from "../context/ChatContext";
import { ForkTreeView } from "./ForkTreeView";
import type { ForkEntry } from "../types";

/**
 * ForkSwitcher — the ChatHeader branch control (next to the roster). Shows the
 * current branch label, the parent breadcrumb (when this is a fork), the
 * current channel's direct-child forks and any siblings, plus "New fork" and
 * "Show tree". Each fork entry switches in place (primary), or opens in a new
 * panel. Reconciles on open (§H).
 */

function ForkItem({
  entry,
  onSwitch,
  onOpen,
  onRename,
  onArchive,
}: {
  entry: ForkEntry;
  onSwitch: (e: ForkEntry) => void;
  onOpen: (e: ForkEntry) => void;
  onRename: (e: ForkEntry) => void;
  onArchive: (e: ForkEntry) => void;
}) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger>
        <Flex align="center" gap="2" style={{ minWidth: 0 }}>
          <Text truncate style={{ minWidth: 0, opacity: entry.archived ? 0.5 : 1 }}>
            {entry.label}
          </Text>
          {entry.unread && (
            <Badge size="1" variant="soft" color="green">
              new
            </Badge>
          )}
        </Flex>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.SubContent>
        <DropdownMenu.Label>
          {entry.actorName} · from message {entry.forkPointId}
        </DropdownMenu.Label>
        <DropdownMenu.Item onSelect={() => onSwitch(entry)}>Switch to this fork</DropdownMenu.Item>
        <DropdownMenu.Item onSelect={() => onOpen(entry)}>Open in new panel</DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item onSelect={() => onRename(entry)}>Rename…</DropdownMenu.Item>
        <DropdownMenu.Item color="red" onSelect={() => onArchive(entry)}>
          Archive…
        </DropdownMenu.Item>
      </DropdownMenu.SubContent>
    </DropdownMenu.Sub>
  );
}

export function ForkSwitcher({ variant = "button" }: { variant?: "button" | "submenu" }) {
  const { forkState } = useChatContext();
  const [treeOpen, setTreeOpen] = useState(false);
  const [renameEntry, setRenameEntry] = useState<ForkEntry | null>(null);
  const [renameLabel, setRenameLabel] = useState("");
  const [archiveEntry, setArchiveEntry] = useState<ForkEntry | null>(null);
  const [mutating, setMutating] = useState(false);
  if (!forkState) return null;

  const { provenance, currentLabel, children, siblings, parent, forking, error, refresh, actions } =
    forkState;
  const hasForks = children.length > 0 || siblings.length > 0;

  const handleSwitch = (entry: ForkEntry) => {
    actions.clearError();
    void (async () => {
      try {
        await actions.markForkRead?.(entry.channelId, entry.headSeq);
      } catch (cause) {
        actions.reportError("Could not save the conversation read position", cause);
      }
      try {
        await actions.switchTo(entry.channelId, entry.contextId);
      } catch (cause) {
        actions.reportError("Could not switch conversations", cause);
      }
    })();
  };
  const handleOpen = (entry: ForkEntry) => {
    actions.clearError();
    void Promise.resolve(actions.openInNewPanel(entry.channelId, entry.contextId)).catch((cause) =>
      actions.reportError("Could not open conversation", cause)
    );
  };
  const handleRename = (entry: ForkEntry) => {
    actions.clearError();
    setRenameEntry(entry);
    setRenameLabel(entry.label);
  };
  const handleArchive = (entry: ForkEntry) => {
    actions.clearError();
    setArchiveEntry(entry);
  };

  const content = (
    <>
      {parent && (
        <>
          <DropdownMenu.Item
            onSelect={() => {
              if (!parent.contextId) return;
              actions.clearError();
              void Promise.resolve(actions.switchTo(parent.channelId, parent.contextId)).catch(
                (cause) => actions.reportError("Could not switch conversations", cause)
              );
            }}
          >
            ↑ Parent conversation
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
        </>
      )}
      {siblings.length > 0 && (
        <>
          <DropdownMenu.Label>Sibling forks</DropdownMenu.Label>
          {siblings.map((entry) => (
            <ForkItem
              key={entry.forkId}
              entry={entry}
              onSwitch={handleSwitch}
              onOpen={handleOpen}
              onRename={handleRename}
              onArchive={handleArchive}
            />
          ))}
          <DropdownMenu.Separator />
        </>
      )}
      {children.length > 0 && (
        <>
          <DropdownMenu.Label>Forks from here</DropdownMenu.Label>
          {children.map((entry) => (
            <ForkItem
              key={entry.forkId}
              entry={entry}
              onSwitch={handleSwitch}
              onOpen={handleOpen}
              onRename={handleRename}
              onArchive={handleArchive}
            />
          ))}
          <DropdownMenu.Separator />
        </>
      )}
      {!hasForks && provenance?.kind !== "fork" && (
        <DropdownMenu.Label>No forks yet</DropdownMenu.Label>
      )}
      {error && (
        <>
          <DropdownMenu.Label>
            <Text color="red">{error}</Text>
          </DropdownMenu.Label>
          <DropdownMenu.Item onSelect={actions.clearError}>Dismiss error</DropdownMenu.Item>
        </>
      )}
      <DropdownMenu.Item
        disabled={forking}
        onSelect={() =>
          void actions
            .newFork()
            .catch((cause) => actions.reportError("Could not create fork", cause))
        }
      >
        New fork from here
      </DropdownMenu.Item>
      <DropdownMenu.Item onSelect={() => setTreeOpen(true)}>Show tree…</DropdownMenu.Item>
    </>
  );

  return (
    <>
      {variant === "submenu" ? (
        <DropdownMenu.Sub onOpenChange={(open) => open && refresh()}>
          <DropdownMenu.SubTrigger disabled={forking}>
            Branch: {forking ? "Forking…" : currentLabel}
          </DropdownMenu.SubTrigger>
          <DropdownMenu.SubContent>{content}</DropdownMenu.SubContent>
        </DropdownMenu.Sub>
      ) : (
        <Flex align="center" gap="2" style={{ minWidth: 0 }}>
          <DropdownMenu.Root onOpenChange={(open) => open && refresh()}>
            <DropdownMenu.Trigger>
              <Button
                size="1"
                variant="soft"
                color={error ? "red" : "gray"}
                disabled={forking}
                aria-label="Switch fork"
              >
                <Flex align="center" gap="1">
                  <Text size="1" aria-hidden="true">
                    ⑂
                  </Text>
                  <Text size="1" truncate style={{ maxWidth: 140 }}>
                    {forking ? "Forking…" : currentLabel}
                  </Text>
                  <ChevronDownIcon />
                </Flex>
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="start">{content}</DropdownMenu.Content>
          </DropdownMenu.Root>
          {error && (
            <Button
              size="1"
              variant="ghost"
              color="red"
              title={error}
              aria-label={`${error}. Dismiss`}
              onClick={actions.clearError}
            >
              <Text size="1" truncate style={{ maxWidth: 220 }}>
                {error}
              </Text>
              ×
            </Button>
          )}
        </Flex>
      )}
      <ForkTreeView open={treeOpen} onClose={() => setTreeOpen(false)} />
      <Dialog.Root
        open={renameEntry !== null}
        onOpenChange={(open) => {
          if (!open && !mutating) setRenameEntry(null);
        }}
      >
        <Dialog.Content maxWidth="420px">
          <Dialog.Title>Rename fork</Dialog.Title>
          <Dialog.Description size="2" color="gray">
            Use a short label that explains what changed in this direction.
          </Dialog.Description>
          <TextField.Root
            mt="3"
            autoFocus
            value={renameLabel}
            onChange={(event) => setRenameLabel(event.target.value)}
          />
          {error && (
            <Text as="p" size="1" color="red" mt="2">
              {error}
            </Text>
          )}
          <Flex justify="end" gap="2" mt="4">
            <Button
              variant="soft"
              color="gray"
              disabled={mutating}
              onClick={() => setRenameEntry(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={mutating || !renameLabel.trim()}
              onClick={() => {
                if (!renameEntry) return;
                setMutating(true);
                void actions
                  .renameFork(renameEntry, renameLabel.trim())
                  .then(() => setRenameEntry(null))
                  .catch((cause) => actions.reportError("Could not rename fork", cause))
                  .finally(() => setMutating(false));
              }}
            >
              {mutating ? "Saving…" : "Save"}
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
      <AlertDialog.Root
        open={archiveEntry !== null}
        onOpenChange={(open) => {
          if (!open && !mutating) setArchiveEntry(null);
        }}
      >
        <AlertDialog.Content maxWidth="420px">
          <AlertDialog.Title>Archive this fork?</AlertDialog.Title>
          <AlertDialog.Description size="2">
            “{archiveEntry?.label}” will leave the active switcher and conversation tree.
          </AlertDialog.Description>
          {error && (
            <Text as="p" size="1" color="red" mt="2">
              {error}
            </Text>
          )}
          <Flex justify="end" gap="2" mt="4">
            <AlertDialog.Cancel>
              <Button variant="soft" color="gray" disabled={mutating}>
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <Button
              color="red"
              disabled={mutating}
              onClick={() => {
                if (!archiveEntry) return;
                setMutating(true);
                void actions
                  .archiveFork(archiveEntry)
                  .then(() => setArchiveEntry(null))
                  .catch((cause) => actions.reportError("Could not archive fork", cause))
                  .finally(() => setMutating(false));
              }}
            >
              {mutating ? "Archiving…" : "Archive"}
            </Button>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );
}
