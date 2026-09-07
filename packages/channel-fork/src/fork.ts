/**
 * Client helper for the durable, journaled channel fork.
 *
 * Orchestration LIVES IN the parent channel DO (`PubSubChannel.fork` — a
 * fork_ops-journaled saga: clone → postClones → appendSeed → channel.forked).
 * This module is the thin userland caller: resolve the parent channel's DO ref
 * and invoke its `fork` RPC. All durability, idempotency (targetKey / deterministic
 * envelopeIds), and crash recovery are the DO's; nothing here is stateful.
 */

import type { RpcCaller } from "@vibestudio/rpc";
import type { MessageBlockInput } from "@workspace/agentic-protocol";

export interface DORef {
  source: string;
  className: string;
  objectKey: string;
}

/** The opening user message for an edit-/deep-dive fork, appended on the child
 *  channel by the DO's `appendSeed`. */
export interface ForkSeed {
  blocks: MessageBlockInput[];
  /** Edit-fork: the parent message this seed supersedes in the child channel. */
  replaces?: { messageId: string };
}

export type ForkLocus =
  | { kind: "head" }
  | { kind: "after-message"; messageId: string }
  | { kind: "before-message"; messageId: string };

export interface ForkConversationOpts {
  channelId: string;
  /** Semantic boundary resolved by the channel against its authoritative log. */
  locus: ForkLocus;
  seed?: ForkSeed;
  label?: string;
  reason: string;
  /** Entity scope: canonical ids of the forkable agents to clone (root-context
   *  cloneContext.include). Omit to clone every agent vessel in the roster. */
  include?: string[];
}

export interface ForkResult {
  forkId: string;
  forkedChannelId: string;
  /** The fresh, isolated context the fork landed in (clones + file snapshot). */
  forkedContextId: string;
  clonedParticipants: string[];
  /** DO refs of the freshly-cloned agents, so the caller can address them
   *  (e.g. to seed a per-fork turn) without re-resolving the new roster. */
  clonedAgents: Array<{ participantId: string } & DORef>;
  /** The seed message's id, when a seed was supplied. */
  seededMessageId?: string;
}

const CHANNEL_SERVICE_PROTOCOL = "vibestudio.channel.v1";

/** Resolved durable-object channel service (the fields we address). */
interface ResolvedChannelService extends DORef {
  targetId?: string;
}

/**
 * Fork a conversation at a point. Resolves the parent channel DO and drives its
 * durable `fork` RPC; the DO owns the whole journaled saga.
 */
export async function forkConversation(
  rpc: RpcCaller,
  opts: ForkConversationOpts
): Promise<ForkResult> {
  const service = await rpc.call<ResolvedChannelService>("main", "workers.resolveService", [
    CHANNEL_SERVICE_PROTOCOL,
    opts.channelId,
  ]);
  const target =
    service.targetId ?? `do:${service.source}:${service.className}:${service.objectKey}`;
  const operationId = crypto.randomUUID();
  return rpc.call<ForkResult>(
    target,
    "fork",
    [
      {
        operationId,
        locus: opts.locus,
        ...(opts.seed ? { seed: opts.seed } : {}),
        ...(opts.label !== undefined ? { label: opts.label } : {}),
        reason: opts.reason,
        ...(opts.include ? { include: opts.include } : {}),
      },
    ],
    { idempotencyKey: `channel-fork:${operationId}` }
  );
}
