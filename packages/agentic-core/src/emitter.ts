/**
 * Typed event emitter — lightweight, no dependencies.
 *
 * Used by SessionManager to emit state change events that both
 * React adapters and headless consumers can subscribe to.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class TypedEmitter<Events extends {} = {}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private listeners = new Map<string | symbol, Set<(...args: any[]) => void>>();

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof Events>(event: K, handler: Events[K]): () => void {
    let set = this.listeners.get(event as string | symbol);
    if (!set) {
      set = new Set();
      this.listeners.set(event as string | symbol, set);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    set.add(handler as any);
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set!.delete(handler as any);
    };
  }

  /** Subscribe to an event for a single invocation. */
  once<K extends keyof Events>(event: K, handler: Events[K]): () => void {
    const wrapped = ((...args: unknown[]) => {
      unsub();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (handler as any)(...args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const unsub = this.on(event, wrapped);
    return unsub;
  }

  /** Emit an event to all listeners. */
  emit<K extends keyof Events>(event: K, ...args: Events[K] extends (...a: infer P) => void ? P : never[]): void {
    const set = this.listeners.get(event as string | symbol);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(...args);
      } catch (err) {
        console.error(`[TypedEmitter] Error in ${String(event)} handler:`, err);
      }
    }
  }

  /** Remove all listeners for all events. */
  removeAllListeners(): void {
    this.listeners.clear();
  }

  /** Remove all listeners for a specific event. */
  removeListenersFor<K extends keyof Events>(event: K): void {
    this.listeners.delete(event as string | symbol);
  }
}
