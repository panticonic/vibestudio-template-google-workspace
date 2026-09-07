/**
 * General agent-membership helpers — add/remove an agent worker to/from a channel
 * the correct way, so callers don't reimplement a per-agent `setup<Agent>Agent`
 * one-off (which is how a wrong/shared objectKey slips in).
 *
 * The one invariant: an agent instance is keyed PER CHANNEL (`${handle}-${channelId}`),
 * so each channel gets its own DO. Reusing a shared/standing key across channels makes
 * one instance fold multiple channels' turn state together and corrupts the channel log
 * (it can adopt another channel's in-flight turn → duplicate envelope ids → GAD
 * id-collision). `*-standing` keys are ONLY for scheduled instances in `vibestudio.yml`.
 */
import { contextId as runtimeContextId, rpc } from "@workspace/runtime";
import {
  launchAgentIntoChannel,
  unsubscribeAgentFromChannel,
  withWorkspaceReviewRetry,
  type WorkspaceReviewWaiter,
} from "@workspace/agentic-core";

export interface AddAgentToChannelArgs {
  /** Worker source, e.g. "workers/explorer-agent". */
  source: string;
  /** Worker class, e.g. "ExplorerAgentWorker". */
  className: string;
  /** Channel handle (and per-channel key prefix), e.g. "explorer". */
  handle: string;
  channelId: string;
  /** Defaults to the current runtime context. */
  contextId?: string | null;
  /** Whether the subscription should admit eligible existing channel history. */
  replay?: boolean;
  /** Optional product adapter for workspace-review approval and retry. */
  waitForReview?: WorkspaceReviewWaiter;
  name?: string;
  /**
   * Per-agent behavior (model / thinkingLevel / approvalLevel / respondPolicy / …) plus
   * any worker-specific config. Seeded into the entity's `stateArgs.agentConfig`;
   * presentation fields (handle/name) are also threaded to the subscription.
   */
  config?: Record<string, unknown>;
}

export interface AddAgentToChannelResult {
  ok: boolean;
  channelId: string;
  contextId: string;
  targetId: string;
  participantId?: string;
  key: string;
}

/** Deterministic per-channel instance key — one agent DO per channel (idempotent re-add). */
export function agentObjectKey(handle: string, channelId: string): string {
  return `${handle.trim()}-${channelId.trim()}`;
}

/**
 * Add an agent to a channel: mint a fresh per-channel instance key, create (or reactivate)
 * the agent DO, and subscribe it. Idempotent per channel. The general replacement for
 * per-agent `setup<Agent>Agent` helpers.
 */
export async function addAgentToChannel(
  args: AddAgentToChannelArgs
): Promise<AddAgentToChannelResult> {
  const channelId = args.channelId?.trim();
  const handle = args.handle?.trim();
  const contextId = args.contextId?.trim() || runtimeContextId;
  if (!channelId) throw new Error("addAgentToChannel requires a channelId");
  if (!handle) throw new Error("addAgentToChannel requires a handle");
  if (!contextId) throw new Error("addAgentToChannel requires a contextId");

  const key = agentObjectKey(handle, channelId);
  const agentConfig: Record<string, unknown> = {
    ...(args.config ?? {}),
    handle,
    ...(args.name ? { name: args.name } : {}),
  };

  const launch = () =>
    launchAgentIntoChannel(rpc, {
      source: args.source,
      className: args.className,
      key,
      channelId,
      contextId,
      config: agentConfig,
      ...(args.replay !== undefined ? { replay: args.replay } : {}),
    });
  const { handle: entity, subscription } = args.waitForReview
    ? await withWorkspaceReviewRetry(launch, args.waitForReview)
    : await launch();

  return {
    ok: subscription.ok,
    channelId,
    contextId,
    targetId: entity.targetId,
    participantId: subscription.participantId,
    key,
  };
}

/** Remove an agent from a channel — unsubscribe its per-channel instance. */
export async function removeAgentFromChannel(args: {
  source: string;
  className: string;
  handle: string;
  channelId: string;
}): Promise<{ ok: boolean }> {
  const channelId = args.channelId.trim();
  return unsubscribeAgentFromChannel(rpc, {
    source: args.source,
    className: args.className,
    key: agentObjectKey(args.handle, channelId),
    channelId,
  });
}
