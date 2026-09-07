import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import type { EventPayloads } from "@vibestudio/shared/events";

const PENDING_CHANGED_EVENT = "shell-approval:pending-changed" as const;
const ABORTED_MESSAGE = "Channel service resolution was aborted";

interface ReviewReadinessRpc {
  stream(
    targetId: string,
    method: string,
    args: unknown[],
    options?: { signal?: AbortSignal; bodyIdleTimeoutMs?: number | null }
  ): Promise<Response>;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

/**
 * One authority snapshot per RPC transport answers every channel blocked by a
 * workspace review. The initial events.watch snapshot closes the race between
 * resolveService reporting a review and the waiter beginning to observe it.
 */
class ReviewReadiness {
  private readonly events: EventsClient;
  private readonly waiters = new Map<string, Set<Waiter>>();
  private pendingApprovalIds: Set<string> | null = null;
  private subscription: Promise<void> | null = null;

  constructor(rpc: ReviewReadinessRpc) {
    this.events = new EventsClient(rpc);
    this.events.on(PENDING_CHANGED_EVENT, (payload) => this.update(payload));
  }

  async waitUntilResolved(approvalId: string, signal?: AbortSignal): Promise<void> {
    await this.awaitSubscription(signal);
    if (signal?.aborted) throw new Error(ABORTED_MESSAGE);
    if (this.pendingApprovalIds !== null && !this.pendingApprovalIds.has(approvalId)) return;

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      const finish = (error?: Error) => {
        this.remove(approvalId, waiter);
        if (error) reject(error);
        else resolve();
      };
      if (signal) {
        waiter.abort = () => finish(new Error(ABORTED_MESSAGE));
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      let approvalWaiters = this.waiters.get(approvalId);
      if (!approvalWaiters) {
        approvalWaiters = new Set();
        this.waiters.set(approvalId, approvalWaiters);
      }
      approvalWaiters.add(waiter);

      // An update can be delivered while the promise above is being built.
      // Re-read the authoritative snapshot after registering the waiter.
      if (this.pendingApprovalIds !== null && !this.pendingApprovalIds.has(approvalId)) finish();
    });
  }

  private awaitSubscription(signal?: AbortSignal): Promise<void> {
    if (!this.subscription) {
      const subscription = this.events.subscribe(PENDING_CHANGED_EVENT);
      this.subscription = subscription;
      void subscription.catch(() => {
        if (this.subscription === subscription) this.subscription = null;
      });
    }
    return abortable(this.subscription, signal);
  }

  private update(payload: EventPayloads[typeof PENDING_CHANGED_EVENT]): void {
    this.pendingApprovalIds = new Set(payload.pending.map(({ approvalId }) => approvalId));
    for (const [approvalId, waiters] of this.waiters) {
      if (this.pendingApprovalIds.has(approvalId)) continue;
      for (const waiter of [...waiters]) {
        this.remove(approvalId, waiter);
        waiter.resolve();
      }
    }
  }

  private remove(approvalId: string, waiter: Waiter): void {
    if (waiter.signal && waiter.abort) {
      waiter.signal.removeEventListener("abort", waiter.abort);
    }
    const approvalWaiters = this.waiters.get(approvalId);
    approvalWaiters?.delete(waiter);
    if (approvalWaiters?.size === 0) this.waiters.delete(approvalId);
  }
}

const readinessByRpc = new WeakMap<object, ReviewReadiness>();

export function waitForApprovalResolution(
  rpc: ReviewReadinessRpc,
  approvalId: string,
  signal?: AbortSignal
): Promise<void> {
  const key = rpc as object;
  let readiness = readinessByRpc.get(key);
  if (!readiness) {
    readiness = new ReviewReadiness(rpc);
    readinessByRpc.set(key, readiness);
  }
  return readiness.waitUntilResolved(approvalId, signal);
}

function abortable(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error(ABORTED_MESSAGE));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error(ABORTED_MESSAGE));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}
