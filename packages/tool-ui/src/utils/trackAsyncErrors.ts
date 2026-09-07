/**
 * trackAsyncErrors — catch unhandled promise rejections from wrapped APIs.
 *
 * React error boundaries and EventErrorBoundary catch synchronous errors.
 * Async errors (unhandled rejections from `await`-ed calls) bypass both.
 *
 * This module provides the core `trackPromise` function.  Callers wrap their
 * own API surfaces and supply an `onError` callback.  If the caller of the
 * wrapped API doesn't catch the rejection, `onError` fires.
 *
 * Key property: **no false positives**.  If the component catches the error
 * itself (`try { await chat.rpc.call(...) } catch { ... }`), the
 * `unhandledrejection` event never fires and we never call `onError`.
 *
 * Implementation:
 *   1. `trackPromise(p, onError)` chains `.then(v=>v, err=>{throw err})` onto
 *      the original promise, creating a derived promise that the caller awaits.
 *      The derived promise is stored in a WeakMap keyed to its onError handler.
 *   2. A single global `unhandledrejection` listener checks the WeakMap.  If the
 *      rejected promise is one we're tracking, we call onError and preventDefault.
 *   3. WeakMap means tracked promises that get caught (or GC'd) impose zero cost.
 */

// ---------------------------------------------------------------------------
// Global unhandledrejection listener (installed once)
// ---------------------------------------------------------------------------

const trackedPromises = new WeakMap<Promise<unknown>, (err: Error) => void>();
let listenerInstalled = false;

/**
 * Install the global `unhandledrejection` listener that routes tracked
 * rejections to their `onError` handler. Idempotent. Exported so callers that
 * install their own fallback listeners can ensure this one is registered first
 * (listeners fire in registration order; a later fallback can then check
 * `event.defaultPrevented` and skip anything already handled here).
 */
export function ensureTrackPromiseListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const handler = trackedPromises.get(event.promise);
    if (!handler) return;
    trackedPromises.delete(event.promise);
    event.preventDefault();
    const error =
      event.reason instanceof Error
        ? event.reason
        : new Error(String(event.reason ?? "Unknown async error"));
    handler(error);
  });
}

// ---------------------------------------------------------------------------
// Core tracking
// ---------------------------------------------------------------------------

/**
 * Wrap a promise so that if the caller leaves its rejection unhandled,
 * `onError` is called and the browser's default rejection logging is suppressed.
 *
 * If the caller catches normally, nothing extra happens.
 */
export function trackPromise<T>(promise: Promise<T>, onError: (err: Error) => void): Promise<T> {
  ensureTrackPromiseListener();
  // Create a derived promise — this is what the caller awaits.
  // The original rejection is "handled" by our .then rejection handler,
  // and we re-throw to create a new rejection on `derived`.
  const derived: Promise<T> = promise.then(
    (v) => v,
    (err) => { throw err; },
  );
  trackedPromises.set(derived as Promise<unknown>, onError);
  return derived;
}
