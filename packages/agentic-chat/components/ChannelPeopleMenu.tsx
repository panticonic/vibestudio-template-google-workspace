import { useCallback, useMemo, useState } from "react";
import { Badge, Button, DropdownMenu, Flex, IconButton, Spinner, Text } from "@radix-ui/themes";
import { PersonIcon } from "@radix-ui/react-icons";
import type { ChannelInvite, ChannelMember, ChannelPresenceEntry } from "@workspace/pubsub";
import { useChatContext } from "../context/ChatContext";
import type { AccountProfile, AccountRpc } from "../hooks/useAccountProfiles";

function presenceColor(status: ChannelPresenceEntry["status"] | undefined) {
  if (status === "online") return "green" as const;
  if (status === "idle") return "amber" as const;
  if (status === "away") return "orange" as const;
  return "gray" as const;
}

function presenceDescription(entry: ChannelPresenceEntry | undefined): string {
  if (!entry) return "Not connected";
  if (entry.status !== "offline") {
    const devices = entry.sessionCount === 1 ? "1 session" : `${entry.sessionCount} sessions`;
    return `${entry.status} · ${devices}`;
  }
  if (entry.lastSeenAt == null) return "Not seen in this channel yet";
  const minutes = Math.max(0, Math.floor((Date.now() - entry.lastSeenAt) / 60_000));
  if (minutes < 1) return "Offline · just now";
  if (minutes < 60) return `Offline · ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Offline · ${hours}h ago`;
  return `Offline · ${Math.floor(hours / 24)}d ago`;
}

/** Current-channel member management and invite acknowledgement. Workspace
 * accounts come from the host-bound account projection, so the UI never asks a
 * person to paste an opaque user id. */
export function ChannelPeopleMenu({
  variant = "button",
}: {
  variant?: "button" | "icon" | "submenu";
}) {
  const { chat, clientRef, connected, selfId } = useChatContext();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaceProfiles, setWorkspaceProfiles] = useState<AccountProfile[]>([]);
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [presence, setPresence] = useState<ChannelPresenceEntry[]>([]);
  const [invites, setInvites] = useState<ChannelInvite[]>([]);

  const refresh = useCallback(async () => {
    const client = clientRef.current;
    const rpc = (chat as { rpc?: AccountRpc }).rpc;
    if (!client || !rpc) return;
    setLoading(true);
    setError(null);
    try {
      const [nextMembers, nextPresence, nextInvites, profiles] = await Promise.all([
        client.listMembers(),
        client.getChannelPresence(),
        client.listInvitesForMe(),
        rpc.call("main", "account.listWorkspaceMembers", []) as Promise<AccountProfile[]>,
      ]);
      setMembers(nextMembers);
      setPresence(nextPresence.entries);
      setInvites(nextInvites);
      setWorkspaceProfiles(profiles);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [chat, clientRef]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) void refresh();
    },
    [refresh]
  );

  const profileByUserId = useMemo(
    () => new Map(workspaceProfiles.map((profile) => [profile.userId, profile])),
    [workspaceProfiles]
  );
  const presenceByUserId = useMemo(
    () => new Map(presence.map((entry) => [entry.userId, entry])),
    [presence]
  );
  const memberIds = useMemo(() => new Set(members.map((member) => member.userId)), [members]);
  const available = workspaceProfiles.filter(
    (profile) => !memberIds.has(profile.userId) && `user:${profile.userId}` !== selfId
  );

  const add = useCallback(
    async (userId: string) => {
      const client = clientRef.current;
      if (!client) return;
      setBusyUserId(userId);
      setError(null);
      try {
        await client.addMember(userId);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusyUserId(null);
      }
    },
    [clientRef, refresh]
  );

  const remove = useCallback(
    async (userId: string) => {
      const client = clientRef.current;
      if (!client) return;
      setBusyUserId(userId);
      setError(null);
      try {
        await client.removeMember(userId);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusyUserId(null);
      }
    },
    [clientRef, refresh]
  );

  const acknowledge = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    setBusyUserId(selfId ?? "self");
    try {
      await client.acknowledgeInvite();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyUserId(null);
    }
  }, [clientRef, refresh, selfId]);

  const content = (
    <>
      <DropdownMenu.Label>
        <Flex align="center" justify="between" gap="3">
          <Text>Channel people</Text>
          {loading ? <Spinner size="1" /> : null}
        </Flex>
      </DropdownMenu.Label>

      {invites.length > 0 ? (
        <>
          <DropdownMenu.Item color="blue" onSelect={() => void acknowledge()}>
            You were invited · mark as joined
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
        </>
      ) : null}

      {members.length === 0 && !loading ? (
        <DropdownMenu.Item disabled>No invited members yet</DropdownMenu.Item>
      ) : null}
      {members.map((member) => {
        const profile = profileByUserId.get(member.userId);
        const entry = presenceByUserId.get(member.userId);
        const isSelf = member.memberId === selfId;
        return (
          <DropdownMenu.Sub key={member.memberId}>
            <DropdownMenu.SubTrigger>
              <Flex align="center" gap="2">
                <Badge color={presenceColor(entry?.status)} variant="soft" radius="full">
                  @{profile?.handle ?? member.handle}
                </Badge>
                <Text size="1" color="gray">
                  {presenceDescription(entry)}
                </Text>
              </Flex>
            </DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent>
              <DropdownMenu.Label>{profile?.displayName ?? member.handle}</DropdownMenu.Label>
              <DropdownMenu.Item
                color="red"
                disabled={busyUserId === member.userId}
                onSelect={() => void remove(member.userId)}
              >
                {isSelf ? "Leave channel" : "Remove from channel"}
              </DropdownMenu.Item>
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>
        );
      })}

      {available.length > 0 ? (
        <>
          <DropdownMenu.Separator />
          <DropdownMenu.Label>Invite from workspace</DropdownMenu.Label>
          {available.map((profile) => (
            <DropdownMenu.Item
              key={profile.userId}
              disabled={busyUserId === profile.userId}
              onSelect={() => void add(profile.userId)}
            >
              Invite @{profile.handle}
              <Text size="1" color="gray" ml="2">
                {profile.displayName}
              </Text>
            </DropdownMenu.Item>
          ))}
        </>
      ) : null}

      {error ? (
        <>
          <DropdownMenu.Separator />
          <DropdownMenu.Item color="red" disabled>
            {error}
          </DropdownMenu.Item>
        </>
      ) : null}
    </>
  );

  if (variant === "submenu") {
    return (
      <DropdownMenu.Sub open={open} onOpenChange={onOpenChange}>
        <DropdownMenu.SubTrigger disabled={!connected}>People</DropdownMenu.SubTrigger>
        <DropdownMenu.SubContent style={{ minWidth: 260, maxWidth: 340 }}>
          {content}
        </DropdownMenu.SubContent>
      </DropdownMenu.Sub>
    );
  }

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger>
        {variant === "icon" ? (
          <IconButton
            variant="soft"
            color="gray"
            size="2"
            disabled={!connected}
            aria-label="Channel people"
          >
            <PersonIcon />
          </IconButton>
        ) : (
          <Button variant="soft" color="gray" size="1" disabled={!connected}>
            <PersonIcon />
            People
          </Button>
        )}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" style={{ minWidth: 260, maxWidth: 340 }}>
        {content}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
