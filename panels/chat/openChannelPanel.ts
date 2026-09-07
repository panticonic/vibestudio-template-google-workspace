/**
 * Find-or-open the chat panel for a channel (messaging plan §4.10.3–4.10.7).
 *
 * The same rule the shell's notification surface applies: an already-open chat
 * panel for that channel is focused (and told which envelope to land on through
 * its own stateArgs) rather than duplicated; only when none exists is a fresh
 * panel opened in the channel's owning context.
 */
import { openPanel, panelTree, rpc } from "@workspace/runtime";

const CHANNEL_SERVICE_PROTOCOL = "vibestudio.channel.v1";
const CHAT_PANEL_SOURCE = "panels/chat";

interface ChatPanelStateArgs {
  channelName?: string;
}

async function findChatPanelForChannel(channelId: string): Promise<string | null> {
  const visit = async (
    group: { kind: "roots" } | { kind: "children"; parentSlotId: string }
  ): Promise<string | null> => {
    let cursor: string | undefined;
    do {
      const page =
        group.kind === "roots"
          ? await panelTree.roots({ ...(cursor ? { cursor } : {}), limit: 100 })
          : await panelTree.children(group.parentSlotId, {
              ...(cursor ? { cursor } : {}),
              limit: 100,
            });
      for (const entry of page.entries) {
        if (entry.node.source === CHAT_PANEL_SOURCE) {
          const args = await entry.handle.stateArgs
            .get<ChatPanelStateArgs>()
            .catch((): ChatPanelStateArgs => ({}));
          if (args.channelName === channelId) return entry.node.slotId;
        }
        if (entry.node.childCount > 0) {
          const nested = await visit({ kind: "children", parentSlotId: entry.node.slotId });
          if (nested) return nested;
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return null;
  };
  return visit({ kind: "roots" });
}

async function resolveChannelContextId(channelId: string): Promise<string | null> {
  const service = await rpc.call<{ kind: string; targetId?: string }>(
    "main",
    "workers.resolveService",
    [CHANNEL_SERVICE_PROTOCOL, channelId]
  );
  if (service.kind !== "durable-object" || !service.targetId) return null;
  return rpc.call<string | null>(service.targetId, "getContextId", []);
}

export async function openChannelPanel(
  channelId: string,
  opts?: { focusMessageId?: string }
): Promise<{ id: string }> {
  const existingId = await findChatPanelForChannel(channelId);
  if (existingId) {
    const existing = panelTree.get(existingId);
    if (opts?.focusMessageId) {
      await existing.stateArgs.set({ focusMessageId: opts.focusMessageId }).catch(() => undefined);
    }
    await existing.focus();
    return { id: existingId };
  }
  const contextId = await resolveChannelContextId(channelId);
  if (!contextId) {
    throw new Error("This conversation is not ready yet. Please try again in a moment.");
  }
  const handle = await openPanel(CHAT_PANEL_SOURCE, {
    focus: true,
    contextId,
    stateArgs: {
      channelName: channelId,
      ...(opts?.focusMessageId ? { focusMessageId: opts.focusMessageId } : {}),
    },
  });
  return { id: handle.id };
}
