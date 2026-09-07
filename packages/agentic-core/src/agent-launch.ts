import {
  AGENTIC_PROTOCOL_VERSION,
  type AgenticEvent,
} from "@workspace/agentic-protocol";
import type { RuntimeEntityCreateSpec } from "@vibestudio/shared/runtime/entitySpec";
import { doTargetId } from "@vibestudio/shared/workspaceServiceRpc";
import {
  toSubscriptionConfig,
  type AgentSubscriptionConfig,
  type ChannelSubscriptionConfig,
} from "./agent-subscription-config.js";

/**
 * Runtime-agnostic launch/invite primitives for agent DOs. Browser panels,
 * headless sessions, and parent agents all enter through this port; caller
 * authority is enforced by runtime/channel services, not by duplicate helpers.
 */
export interface AgentLaunchRpc {
  call<T = unknown>(
    target: string,
    method: string,
    args: unknown[],
  ): Promise<T>;
}

export interface AgentEntityHandle {
  id?: string;
  targetId: string;
  contextId?: string;
}

export interface AgentSubscriptionResult {
  ok: boolean;
  participantId: string;
}

export interface AgentEntityCreateInput {
  source: string;
  className: string;
  key: string;
  contextId?: string;
  ref?: string;
  config?: AgentSubscriptionConfig | Record<string, unknown>;
  stateArgs?: Record<string, unknown>;
  agentBinding?: { entityId: string; channelId: string };
  resourceBindings?: Array<{
    resource: { kind: string; id: string };
    capabilities: string[];
    scope: { kind: "entity" } | { kind: "agent-channel"; channelId: string };
  }>;
  /** Host derives the self entity/context coordinates and binds this agent to the channel. */
  agentChannelId?: string;
}

export interface AgentChannelSubscriptionInput {
  channelId: string;
  contextId: string;
  config?: AgentSubscriptionConfig | Record<string, unknown>;
  replay?: boolean;
}

export interface AgentChannelUnsubscriptionInput {
  source: string;
  className: string;
  key: string;
  channelId: string;
}

export interface AgentTrajectoryForkInput {
  parentLogId: string;
  seq: number;
  taskChannelId: string;
  contextId: string;
  config?: AgentSubscriptionConfig | Record<string, unknown>;
}

export interface LaunchAgentIntoChannelInput extends AgentEntityCreateInput {
  channelId: string;
  replay?: boolean;
  missingContextErrorMessage?: string;
  /**
   * Headless/isolated launches should retire the entity if the subscribe step
   * fails. Panel and subagent launches generally keep this false because
   * createEntity may have reactivated an existing durable entity.
   */
  retireEntityOnSubscribeFailure?: boolean;
}

export interface LaunchAgentIntoChannelResult {
  handle: AgentEntityHandle;
  subscription: AgentSubscriptionResult;
  contextId: string;
}

export interface CreateSubagentContextInput {
  parentContextId: string;
  ownerEntityId: string;
  targetKey: string;
}

export interface AgentTaskSeedInput {
  senderParticipantId: string;
  task: string;
  messageId: string;
  childParticipantId: string;
  displayName?: string;
  senderMetadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface AgentTaskSeedChannel {
  publishAgenticEvent(
    participantId: string,
    event: AgenticEvent,
    opts?: {
      idempotencyKey?: string;
      senderMetadata?: Record<string, unknown>;
    },
  ): Promise<{ id?: number }>;
}

function targetIdFor(handleOrTargetId: AgentEntityHandle | string): string {
  return typeof handleOrTargetId === "string"
    ? handleOrTargetId
    : handleOrTargetId.targetId;
}

function requireAgentSubscriptionResult(
  operation: "subscribeChannel" | "initFromTrajectoryFork",
  result: unknown,
): AgentSubscriptionResult {
  if (
    !result ||
    typeof result !== "object" ||
    typeof (result as { ok?: unknown }).ok !== "boolean" ||
    typeof (result as { participantId?: unknown }).participantId !== "string" ||
    !(result as { participantId: string }).participantId.trim()
  ) {
    throw new Error(`${operation} returned no participant identity`);
  }
  return result as AgentSubscriptionResult;
}

type AgentEntityCreateSpec = Extract<RuntimeEntityCreateSpec, { kind: "do" }>;

export function buildAgentEntityCreateSpec(
  input: AgentEntityCreateInput,
): AgentEntityCreateSpec {
  const stateArgs = {
    ...(input.stateArgs ?? {}),
    ...(input.config !== undefined ? { agentConfig: input.config } : {}),
  };
  return {
    kind: "do",
    execution: {
      surface: "code",
      source: input.source,
      ...(input.ref ? { ref: input.ref } : {}),
    },
    className: input.className,
    key: input.key,
    ...(input.contextId ? { contextId: input.contextId } : {}),
    ...(Object.keys(stateArgs).length > 0 ? { stateArgs } : {}),
    ...(input.agentBinding ? { agentBinding: input.agentBinding } : {}),
    ...(input.resourceBindings
      ? { resourceBindings: input.resourceBindings }
      : {}),
    ...(input.agentChannelId ? { agentChannelId: input.agentChannelId } : {}),
  };
}

export async function createAgentEntity(
  rpc: AgentLaunchRpc,
  input: AgentEntityCreateInput,
): Promise<AgentEntityHandle> {
  return rpc.call<AgentEntityHandle>("main", "runtime.createEntity", [
    buildAgentEntityCreateSpec(input),
  ]);
}

export async function retireAgentEntity(
  rpc: AgentLaunchRpc,
  id: string,
): Promise<void> {
  await rpc.call("main", "runtime.retireEntity", [{ id }]);
}

export async function subscribeAgentToChannel(
  rpc: AgentLaunchRpc,
  handleOrTargetId: AgentEntityHandle | string,
  input: AgentChannelSubscriptionInput,
): Promise<AgentSubscriptionResult> {
  return requireAgentSubscriptionResult(
    "subscribeChannel",
    await rpc.call<unknown>(targetIdFor(handleOrTargetId), "subscribeChannel", [
      {
        channelId: input.channelId,
        contextId: input.contextId,
        config: toSubscriptionConfig(input.config),
        replay: input.replay,
      },
    ]),
  );
}

/**
 * Unsubscribe an already-active agent without acquiring or reactivating it.
 * Absence or retirement is reported by the ordinary active-entity relay.
 */
export async function unsubscribeAgentFromChannel(
  rpc: AgentLaunchRpc,
  input: AgentChannelUnsubscriptionInput,
): Promise<{ ok: boolean }> {
  return rpc.call<{ ok: boolean }>(
    doTargetId({
      source: input.source,
      className: input.className,
      objectKey: input.key,
    }),
    "unsubscribeChannel",
    [input.channelId],
  );
}

export async function initAgentFromTrajectoryFork(
  rpc: AgentLaunchRpc,
  handleOrTargetId: AgentEntityHandle | string,
  input: AgentTrajectoryForkInput,
): Promise<AgentSubscriptionResult> {
  return requireAgentSubscriptionResult(
    "initFromTrajectoryFork",
    await rpc.call<unknown>(
      targetIdFor(handleOrTargetId),
      "initFromTrajectoryFork",
      [
        {
          parentLogId: input.parentLogId,
          seq: input.seq,
          taskChannelId: input.taskChannelId,
          contextId: input.contextId,
          config: toSubscriptionConfig(input.config),
        },
      ],
    ),
  );
}

export async function launchAgentIntoChannel(
  rpc: AgentLaunchRpc,
  input: LaunchAgentIntoChannelInput,
): Promise<LaunchAgentIntoChannelResult> {
  // There are two disjoint identities behind the same subscription workflow:
  // an ordinary agent acts as itself on the channel, while a linked vessel
  // relays an already-bound external agent session. Giving the latter a second
  // self-agent channel would make one entity claim both identities and is
  // rejected by runtime.createEntity.
  const handle = await createAgentEntity(
    rpc,
    input.agentBinding
      ? input
      : {
          ...input,
          agentChannelId: input.channelId,
        },
  );
  if (
    input.contextId &&
    handle.contextId &&
    handle.contextId !== input.contextId
  ) {
    if (input.retireEntityOnSubscribeFailure && handle.id) {
      await retireAgentEntity(rpc, handle.id).catch(() => undefined);
    }
    throw new Error(
      `runtime.createEntity returned existing agent ${handle.id ?? handle.targetId} in context ` +
        `${handle.contextId}, but channel ${input.channelId} is in context ${input.contextId}`,
    );
  }
  const contextId = input.contextId ?? handle.contextId;
  if (!contextId) {
    if (input.retireEntityOnSubscribeFailure && handle.id) {
      await retireAgentEntity(rpc, handle.id).catch(() => undefined);
    }
    throw new Error(
      input.missingContextErrorMessage ??
        "runtime.createEntity did not return a contextId for agent subscription",
    );
  }
  try {
    const subscription = await subscribeAgentToChannel(rpc, handle, {
      channelId: input.channelId,
      contextId,
      config: input.config,
      replay: input.replay,
    });
    return { handle, subscription, contextId };
  } catch (err) {
    if (input.retireEntityOnSubscribeFailure && handle.id) {
      await retireAgentEntity(rpc, handle.id).catch(() => undefined);
    }
    throw err;
  }
}

export async function createSubagentContext(
  rpc: AgentLaunchRpc,
  input: CreateSubagentContextInput,
): Promise<{ contextId: string }> {
  return rpc.call<{ contextId: string }>(
    "main",
    "runtime.createSubagentContext",
    [input],
  );
}

export function buildAgentTaskSeedEvent(
  input: AgentTaskSeedInput,
): AgenticEvent<"message.completed"> {
  if (!input.childParticipantId.trim()) {
    throw new Error("Agent task seed requires a child participant identity");
  }
  const displayName = input.displayName ?? "Subagent task";
  const senderMetadata = input.senderMetadata ?? {};
  return {
    kind: "message.completed",
    actor: {
      kind: "user",
      id: input.senderParticipantId,
      displayName,
      metadata: senderMetadata,
    },
    causality: { messageId: input.messageId as never },
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      role: "user",
      blocks: [
        {
          blockId: `${input.messageId}:block:0` as never,
          type: "text",
          content: input.task,
        },
      ],
      outcome: "completed",
      tier: "primary",
      to: [
        {
          kind: "participant" as const,
          participantId: input.childParticipantId,
        },
      ],
      // Turn metadata makes the child's ordinary turn closure observable to
      // its vessel. A subagent that returns a final answer instead of calling
      // the explicit `complete` tool must still publish a durable terminal.
      metadata: { origin: "agent-initiated" },
    },
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export async function publishAgentTaskSeed(
  channel: AgentTaskSeedChannel,
  input: AgentTaskSeedInput,
): Promise<{ id?: number }> {
  const senderMetadata = input.senderMetadata ?? {};
  return channel.publishAgenticEvent(
    input.senderParticipantId,
    buildAgentTaskSeedEvent({ ...input, senderMetadata }),
    { idempotencyKey: input.messageId, senderMetadata },
  );
}

export { toSubscriptionConfig };
export type { AgentSubscriptionConfig, ChannelSubscriptionConfig };
