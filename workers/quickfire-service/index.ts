import {
  DurableObjectBase,
  doTargetId,
  rpc,
} from "@workspace/runtime/worker/kernel";
import { launchAgentIntoChannel } from "@workspace/agentic-core/agent-launch";
import { quickfireAgentConfig } from "@workspace/quickfire-core/agent";
import type { QuickfireSession } from "@workspace/quickfire-core/service";

const CHANNEL_SOURCE = "workers/pubsub-channel";
const CHANNEL_CLASS = "PubSubChannel";
const AGENT_SOURCE = "workers/agent-worker";
const AGENT_CLASS = "AiChatWorker";

function agentResourceBindings(slotId: string, channelId: string) {
  return [
    {
      resource: { kind: "panel-slot", id: slotId },
      capabilities: ["panel.inspect"],
      scope: { kind: "agent-channel" as const, channelId },
    },
    {
      resource: { kind: "workspace-diagnostics", id: "server-logs" },
      capabilities: ["server-logs.read"],
      scope: { kind: "agent-channel" as const, channelId },
    },
  ];
}

interface SessionRow {
  slot_id: string;
  channel_id: string;
  context_id: string;
  agent_entity_id: string;
  agent_key: string;
  created_at: number;
  promoted_at: number | null;
}

interface PanelTreeDetail {
  slot?: {
    parent_slot_id?: string | null;
    current_entity_title?: string | null;
  };
  currentHistory?: { context_id?: string; source?: string };
}

export class QuickfireSessionsDO extends DurableObjectBase {
  static override schemaVersion = 1;

  protected createTables(): void {
    this.sql.exec(`CREATE TABLE quickfire_sessions (
      slot_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL UNIQUE,
      context_id TEXT NOT NULL,
      agent_entity_id TEXT NOT NULL,
      agent_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      promoted_at INTEGER
    )`);
  }

  protected override requiredTables(): readonly string[] {
    return ["quickfire_sessions"];
  }

  private row(slotId: string): SessionRow | null {
    return (
      (this.sql
        .exec(`SELECT * FROM quickfire_sessions WHERE slot_id = ?`, slotId)
        .toArray()[0] as unknown as SessionRow | undefined) ?? null
    );
  }

  private async panelFor(slotId: string): Promise<{
    contextId: string;
    title: string | null;
    source: string;
    parentSlotId: string | null;
  }> {
    const detail = (await this.rpc.call(
      "main",
      "workspace-state.panelTree.detail",
      [slotId],
    )) as PanelTreeDetail | null;
    const contextId = detail?.currentHistory?.context_id;
    const source = detail?.currentHistory?.source;
    if (!contextId || !source)
      throw new Error(`Panel slot is not open: ${slotId}`);
    return {
      contextId,
      title: detail.slot?.current_entity_title ?? null,
      source,
      parentSlotId: detail.slot?.parent_slot_id ?? null,
    };
  }

  private async agentIsActive(row: SessionRow): Promise<boolean> {
    const record = (await this.rpc.call(
      "main",
      "workspace-state.entity.resolveActive",
      [row.agent_entity_id],
    )) as { status?: string } | null;
    return record?.status === "active";
  }

  private async activateChannel(
    channelId: string,
    slotId: string,
  ): Promise<void> {
    await this.rpc.call("main", "runtime.createEntity", [
      {
        kind: "do",
        execution: { surface: "code", source: CHANNEL_SOURCE },
        className: CHANNEL_CLASS,
        key: channelId,
        resourceBindings: [
          {
            resource: { kind: "panel-slot", id: slotId },
            capabilities: [],
            scope: { kind: "entity" },
          },
        ],
      },
    ]);
  }

  private async activity(row: SessionRow): Promise<{
    messageCount: number | null;
    lastActivityAt: number | null;
  }> {
    try {
      const target = `do:${CHANNEL_SOURCE}:${CHANNEL_CLASS}:${row.channel_id}`;
      const envelope = (await this.rpc.call(target, "getReplayAfter", [
        { after: 0, limit: 1 },
      ])) as { ready?: { snapshotLastSeq?: number } };
      const messageCount = envelope.ready?.snapshotLastSeq ?? null;
      if (!messageCount) return { messageCount, lastActivityAt: null };
      const tail = (await this.rpc.call(target, "getReplayBefore", [
        messageCount + 1,
        1,
      ])) as { logEvents?: Array<{ ts?: number }> } | Array<{ ts?: number }>;
      const events = Array.isArray(tail) ? tail : (tail.logEvents ?? []);
      return { messageCount, lastActivityAt: events.at(-1)?.ts ?? null };
    } catch {
      return { messageCount: null, lastActivityAt: null };
    }
  }

  private async present(
    row: SessionRow,
    state: QuickfireSession["state"],
  ): Promise<QuickfireSession> {
    const activity =
      state === "fresh"
        ? { messageCount: 0, lastActivityAt: null }
        : await this.activity(row);
    return {
      slotId: row.slot_id,
      channelId: row.channel_id,
      contextId: row.context_id,
      agentEntityId: row.agent_entity_id,
      state,
      ...activity,
      createdAt: row.created_at,
      promotedAt: row.promoted_at,
    };
  }

  private async release(row: SessionRow): Promise<void> {
    const target = doTargetId({
      source: AGENT_SOURCE,
      className: AGENT_CLASS,
      objectKey: row.agent_key,
    });
    await this.rpc
      .call(target, "interruptChannel", [row.channel_id, false])
      .catch(() => undefined);
    await this.rpc
      .call(target, "unsubscribeChannel", [row.channel_id])
      .catch(() => undefined);
    await this.rpc.call("main", "runtime.retireEntity", [
      { id: row.agent_entity_id, removeContext: false },
    ]);
    await this.rpc.call("main", "runtime.retireEntity", [
      {
        id: doTargetId({
          source: CHANNEL_SOURCE,
          className: CHANNEL_CLASS,
          objectKey: row.channel_id,
        }),
        removeContext: false,
      },
    ]);
  }

  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async sessionFor(input: {
    slotId: string;
    fresh?: boolean;
  }): Promise<QuickfireSession> {
    if (!input?.slotId) throw new Error("Quickfire requires a panel slot id");
    let existing = this.row(input.slotId);
    if (
      existing &&
      existing.promoted_at === null &&
      !(await this.agentIsActive(existing))
    ) {
      this.sql.exec(
        `DELETE FROM quickfire_sessions WHERE slot_id = ?`,
        input.slotId,
      );
      existing = null;
    }
    if (existing && input.fresh !== true) {
      await this.panelFor(input.slotId);
      if (existing.promoted_at === null) {
        // Resource bindings are lifecycle state, not immutable launch state.
        // Reconcile them when an older durable Quickfire conversation resumes
        // so newly added built-in grants apply without replacing the agent.
        await this.rpc.call("main", "runtime.replaceResourceBindings", [
          {
            id: existing.agent_entity_id,
            bindings: agentResourceBindings(input.slotId, existing.channel_id),
          },
        ]);
      }
      return this.present(
        existing,
        existing.promoted_at === null ? "resumed" : "promoted",
      );
    }
    if (existing) {
      if (existing.promoted_at === null) await this.release(existing);
      this.sql.exec(
        `DELETE FROM quickfire_sessions WHERE slot_id = ?`,
        input.slotId,
      );
    }

    const panel = await this.panelFor(input.slotId);
    const suffix = crypto.randomUUID().slice(0, 12);
    const channelId = `quickfire-${suffix}`;
    const agentKey = `quickfire-agent-${suffix}`;
    await this.activateChannel(channelId, input.slotId);
    const launched = await launchAgentIntoChannel(this.rpc, {
      source: AGENT_SOURCE,
      className: AGENT_CLASS,
      key: agentKey,
      channelId,
      config: quickfireAgentConfig(input.slotId, panel),
      resourceBindings: agentResourceBindings(input.slotId, channelId),
      replay: true,
      retireEntityOnSubscribeFailure: true,
    });
    if (!launched.handle.id)
      throw new Error("Quickfire agent has no runtime entity id");
    const createdAt = Date.now();
    this.sql.exec(
      `INSERT INTO quickfire_sessions
         (slot_id, channel_id, context_id, agent_entity_id, agent_key, created_at, promoted_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      input.slotId,
      channelId,
      launched.contextId,
      launched.handle.id,
      agentKey,
      createdAt,
    );
    return this.present(this.row(input.slotId)!, "fresh");
  }

  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async clear(input: { slotId: string }): Promise<{ cleared: boolean }> {
    const row = this.row(input.slotId);
    if (!row) return { cleared: false };
    if (row.promoted_at === null) await this.release(row);
    this.sql.exec(
      `DELETE FROM quickfire_sessions WHERE slot_id = ?`,
      input.slotId,
    );
    return { cleared: true };
  }

  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async promote(input: { slotId: string }): Promise<QuickfireSession | null> {
    const row = this.row(input.slotId);
    if (!row) return null;
    if (row.promoted_at === null) {
      await this.rpc.call("main", "runtime.releaseResourceBindings", [
        {
          id: doTargetId({
            source: CHANNEL_SOURCE,
            className: CHANNEL_CLASS,
            objectKey: row.channel_id,
          }),
        },
      ]);
      await this.rpc.call("main", "runtime.releaseResourceBindings", [
        { id: row.agent_entity_id },
      ]);
      this.sql.exec(
        `UPDATE quickfire_sessions SET promoted_at = ? WHERE slot_id = ?`,
        Date.now(),
        input.slotId,
      );
    }
    return this.present(this.row(input.slotId)!, "promoted");
  }

  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async list(): Promise<QuickfireSession[]> {
    const rows = this.sql
      .exec(`SELECT * FROM quickfire_sessions ORDER BY created_at`)
      .toArray() as unknown as SessionRow[];
    return Promise.all(
      rows.map((row) =>
        this.present(row, row.promoted_at === null ? "resumed" : "promoted"),
      ),
    );
  }
}
