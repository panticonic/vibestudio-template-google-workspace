import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { pendingReviewNotice } from "@vibestudio/shared/authority/reviewPending";
import {
  createAgentEntity,
  retireAgentEntity,
  subscribeAgentToChannel,
  type AgentEntityHandle,
  type AgentLaunchRpc,
  type AgentSubscriptionResult,
} from "./agent-launch.js";

export type WorkspaceReviewWaiter = (approvalId: string) => Promise<void>;

/** Retry one idempotent operation after each exact workspace review resolves. */
export async function withWorkspaceReviewRetry<T>(
  operation: () => Promise<T>,
  waitForReview?: WorkspaceReviewWaiter
): Promise<T> {
  while (true) {
    try {
      return await operation();
    } catch (error) {
      const review = pendingReviewNotice(error);
      if (!review || !waitForReview) throw error;
      await waitForReview(review.approvalId);
    }
  }
}

/** Fully resolved intent for an agent that may be warmed before it is needed. */
export interface ProvisionalAgentIntent {
  source: string;
  className: string;
  channelId: string;
  channelContextId: string;
  handleBase: string;
  config: Record<string, unknown>;
  persistedConfig: Record<string, unknown>;
  replay?: boolean;
}

export interface ClaimedProvisionalAgent {
  subscription: AgentSubscriptionResult;
  source: string;
  className: string;
  key: string;
  handle: string;
  persistedConfig: Record<string, unknown>;
}

interface ProvisionalAgentLease {
  fingerprint: string;
  entity: AgentEntityHandle;
  key: string;
  handle: string;
  config: Record<string, unknown>;
}

function fingerprintIntent(intent: ProvisionalAgentIntent): string {
  return canonicalJson({
    source: intent.source,
    className: intent.className,
    channelId: intent.channelId,
    channelContextId: intent.channelContextId,
    handleBase: intent.handleBase,
    config: intent.config,
    persistedConfig: intent.persistedConfig,
    replay: intent.replay ?? false,
  });
}

/**
 * Owns one uncommitted agent entity lease.
 *
 * `prepare()` is latest-intent-wins and never subscribes. `claim()` promotes
 * the exact matching lease into its channel. Replacing an intent retires the
 * previous entity first; disposal retires every lease that was never committed.
 */
export class ProvisionalAgentLifecycle {
  private desired: { fingerprint: string; intent: ProvisionalAgentIntent } | null = null;
  private current: ProvisionalAgentLease | null = null;
  private claimLease: ProvisionalAgentLease | null = null;
  private reconcileTail: Promise<void> = Promise.resolve();
  private readonly retirementPromises = new Map<string, Promise<void>>();
  private started = false;
  private claiming = false;
  private committed = false;
  private disposed = false;

  constructor(
    private readonly launchRpc: AgentLaunchRpc,
    private readonly randomUuid: () => string = () => crypto.randomUUID(),
    private readonly waitForReview?: WorkspaceReviewWaiter
  ) {}

  get hasStarted(): boolean {
    return this.started;
  }

  get hasCommitted(): boolean {
    return this.committed;
  }

  prepare(intent: ProvisionalAgentIntent | null): Promise<void> {
    if (this.disposed || this.committed || this.claiming) return Promise.resolve();
    if (intent) this.started = true;
    this.desired = intent ? { fingerprint: fingerprintIntent(intent), intent } : null;
    return this.scheduleReconcile();
  }

  async claim(intent: ProvisionalAgentIntent): Promise<ClaimedProvisionalAgent> {
    if (this.disposed) throw new Error("Cannot claim a disposed provisional agent");
    if (this.committed || this.claiming) {
      throw new Error("The provisional agent lifecycle has already been claimed");
    }

    this.started = true;
    this.claiming = true;
    const fingerprint = fingerprintIntent(intent);
    this.desired = { fingerprint, intent };

    try {
      await this.scheduleReconcile();
      const lease = this.current;
      if (!lease || lease.fingerprint !== fingerprint) {
        throw new Error("The requested provisional agent could not be activated");
      }

      this.current = null;
      this.desired = null;
      this.claimLease = lease;
      const subscription = await withWorkspaceReviewRetry(
        () =>
          subscribeAgentToChannel(this.launchRpc, lease.entity, {
            channelId: intent.channelId,
            contextId: intent.channelContextId,
            config: lease.config,
            replay: intent.replay,
          }),
        this.waitForReview
      );
      if (this.disposed) {
        await this.retireLease(lease);
        throw new Error("The owner closed while its provisional agent was being claimed");
      }

      this.claimLease = null;
      this.committed = true;
      return {
        subscription,
        source: intent.source,
        className: intent.className,
        key: lease.key,
        handle: lease.handle,
        persistedConfig: intent.persistedConfig,
      };
    } catch (error) {
      const lease = this.claimLease;
      this.claimLease = null;
      if (lease) {
        try {
          await this.retireLease(lease);
        } catch (cleanupError) {
          this.claiming = false;
          throw new AggregateError(
            [error, cleanupError],
            "Failed to claim and retire the provisional agent"
          );
        }
      }
      this.claiming = false;
      throw error;
    } finally {
      if (this.committed) this.claiming = false;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.desired = null;
    let failure: unknown;
    try {
      await this.scheduleReconcile();
    } catch (error) {
      failure = error;
    }
    const claimLease = this.claimLease;
    if (claimLease) {
      try {
        await this.retireLease(claimLease);
        if (this.claimLease === claimLease) this.claimLease = null;
      } catch (error) {
        failure = failure
          ? new AggregateError([failure, error], "Failed to dispose provisional agents")
          : error;
      }
    }
    if (failure) throw failure;
  }

  private scheduleReconcile(): Promise<void> {
    const next = this.reconcileTail.catch(() => undefined).then(() => this.reconcile());
    this.reconcileTail = next;
    return next;
  }

  private async reconcile(): Promise<void> {
    while (true) {
      if (this.disposed) {
        if (!this.current) return;
        const current = this.current;
        await this.retireLease(current);
        if (this.current === current) this.current = null;
        continue;
      }

      const desired = this.desired;
      if (this.current?.fingerprint === desired?.fingerprint) return;

      if (this.current) {
        const current = this.current;
        await this.retireLease(current);
        if (this.current === current) this.current = null;
        continue;
      }
      if (!desired) return;

      const handle = `${desired.intent.handleBase}-${this.randomUuid().slice(0, 4)}`;
      const key = `${handle}-${this.randomUuid().slice(0, 8)}`;
      const config = { ...desired.intent.config, handle };
      const entity = await withWorkspaceReviewRetry(
        () =>
          createAgentEntity(this.launchRpc, {
            source: desired.intent.source,
            className: desired.intent.className,
            key,
            contextId: desired.intent.channelContextId,
            config,
            agentChannelId: desired.intent.channelId,
          }),
        this.waitForReview
      );
      const lease: ProvisionalAgentLease = {
        fingerprint: desired.fingerprint,
        entity,
        key,
        handle,
        config,
      };

      if (this.disposed || !this.desired || this.desired.fingerprint !== desired.fingerprint) {
        this.current = lease;
        continue;
      }
      this.current = lease;
      return;
    }
  }

  private retireLease(lease: ProvisionalAgentLease): Promise<void> {
    const entityId = lease.entity.id ?? lease.entity.targetId;
    const existing = this.retirementPromises.get(entityId);
    if (existing) return existing;
    const retirement = retireAgentEntity(this.launchRpc, entityId).catch((error) => {
      this.retirementPromises.delete(entityId);
      throw error;
    });
    this.retirementPromises.set(entityId, retirement);
    return retirement;
  }
}
