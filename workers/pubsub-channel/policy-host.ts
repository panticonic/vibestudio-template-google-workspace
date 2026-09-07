/**
 * Policy host (WS2 §4.3) — owns the `policy_state:{name}` KV caches.
 *
 * P1 classification: each cache is `{ stateJson, foldedThroughSeq,
 * policyVersion }` with derivation `fold(policy.reduce, log[1..foldedThroughSeq])`.
 * Deleting every key at any moment changes nothing but latency: `getState`
 * rebuilds by replaying the (lineage-aware) durable log.
 */

import {
  getChannelPolicy,
  resolveChannelPolicies,
  type ChannelCallEventBuilders,
  type ChannelPolicy,
  type PolicyAppendDraft,
  type PolicyEnvelopeView,
} from "@workspace/channel-policies";
import type { LogEnvelope } from "@workspace/agentic-protocol";
import type { ChannelLog } from "./log-store.js";

export interface PolicyHostDeps {
  getStateValue(key: string): string | null;
  setStateValue(key: string, value: string): void;
  deleteStateValue(key: string): void;
  log: ChannelLog;
  /** Configured policy names (from channel config); undefined ⇒ defaults. */
  policyNames(): string[] | undefined;
}

interface PolicyStateCache {
  stateJson: string;
  foldedThroughSeq: number;
  policyVersion: number;
}

export function policyViewFromLogEnvelope(envelope: LogEnvelope): PolicyEnvelopeView {
  const actor = envelope.actor as { id: string; kind?: string; participantId?: string };
  return {
    envelopeId: String(envelope.envelopeId),
    seq: envelope.seq,
    payloadKind: envelope.payloadKind,
    payload: envelope.payload,
    senderId: actor.participantId ?? actor.id,
    senderKind: actor.kind ?? "unknown",
    ...(envelope.annotations ? { annotations: envelope.annotations } : {}),
    appendedAt: envelope.appendedAt,
  };
}

const FOLD_PAGE_LIMIT = 500;

export class PolicyHost {
  private resolved: ChannelPolicy[] | null = null;

  constructor(private readonly deps: PolicyHostDeps) {}

  policies(): ChannelPolicy[] {
    this.resolved ??= resolveChannelPolicies(this.deps.policyNames());
    return this.resolved;
  }

  /** Config may change (updateConfig) — drop the resolved cache. */
  invalidatePolicySelection(): void {
    this.resolved = null;
  }

  private cacheKey(name: string): string {
    return `policy_state:${name}`;
  }

  private loadCache(policy: ChannelPolicy): { state: unknown; foldedThroughSeq: number } | null {
    const raw = this.deps.getStateValue(this.cacheKey(policy.name));
    if (!raw) return null;
    try {
      const cache = JSON.parse(raw) as PolicyStateCache;
      if (cache.policyVersion !== policy.version) return null;
      return { state: JSON.parse(cache.stateJson), foldedThroughSeq: cache.foldedThroughSeq };
    } catch {
      return null;
    }
  }

  private persist(policy: ChannelPolicy, state: unknown, foldedThroughSeq: number): void {
    const cache: PolicyStateCache = {
      stateJson: JSON.stringify(state ?? null),
      foldedThroughSeq,
      policyVersion: policy.version,
    };
    this.deps.setStateValue(this.cacheKey(policy.name), JSON.stringify(cache));
  }

  /** Load cached state, folding any tail the cache is behind on. */
  async getState(name: string): Promise<{
    policy: string;
    version: number;
    foldedThroughSeq: number;
    state: unknown;
  }> {
    const policy =
      this.policies().find((candidate) => candidate.name === name) ?? getChannelPolicy(name);
    const cached = this.loadCache(policy);
    let state = cached?.state ?? policy.init();
    let foldedThroughSeq = cached?.foldedThroughSeq ?? 0;
    let advanced = false;
    for (;;) {
      const page = await this.deps.log.read({
        afterSeq: foldedThroughSeq,
        limit: FOLD_PAGE_LIMIT,
      });
      if (page.length === 0) break;
      for (const envelope of page) {
        state = policy.reduce(state, policyViewFromLogEnvelope(envelope));
        foldedThroughSeq = envelope.seq;
      }
      advanced = true;
      if (page.length < FOLD_PAGE_LIMIT) break;
    }
    if (advanced || !cached) this.persist(policy, state, foldedThroughSeq);
    return { policy: policy.name, version: policy.version, foldedThroughSeq, state };
  }

  /** Pure annotate pass over all configured policies; merged result. */
  async annotate(draft: PolicyAppendDraft): Promise<Record<string, unknown> | null> {
    let merged: Record<string, unknown> | null = null;
    for (const policy of this.policies()) {
      const { state } = await this.getState(policy.name);
      const annotations = policy.annotate(state, draft);
      if (annotations) merged = { ...(merged ?? {}), ...annotations };
    }
    return merged;
  }

  /**
   * Fold ONE just-appended envelope into every policy's cached state. Only the
   * contiguous next seq advances in-memory (no IO); any gap heals on the next
   * `getState` catch-up — a crash between the durable append and this fold is
   * cache amnesia by construction.
   */
  foldAppended(view: PolicyEnvelopeView): void {
    for (const policy of this.policies()) {
      const cached = this.loadCache(policy);
      if (!cached) continue; // next getState rebuilds from scratch
      if (view.seq <= cached.foldedThroughSeq) continue; // idempotent
      if (view.seq !== cached.foldedThroughSeq + 1) continue; // gap → heal later
      this.persist(policy, policy.reduce(cached.state, view), view.seq);
    }
  }

  /** The call-transport vocabulary owner (exactly one configured policy). */
  callBuilders(): ChannelCallEventBuilders {
    const owner = this.policies().find((policy) => policy.callEventPayload);
    if (!owner?.callEventPayload) {
      throw new Error("No configured channel policy owns callEventPayload");
    }
    return owner.callEventPayload;
  }

  /** postClone: drop every policy cache and rebuild by replaying the forked
   *  lineage — conversation state SURVIVES forks (the fork-wipe bug fix). */
  async rebuildAfterFork(): Promise<void> {
    for (const policy of this.policies()) {
      this.deps.deleteStateValue(this.cacheKey(policy.name));
    }
    for (const policy of this.policies()) {
      await this.getState(policy.name);
    }
  }
}
