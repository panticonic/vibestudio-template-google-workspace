/**
 * EventErrorBoundary — catches React render errors, synchronous event-handler
 * errors, AND async errors thrown from awaited promises inside event handlers.
 *
 * React error boundaries (getDerivedStateFromError / componentDidCatch) only
 * catch errors thrown during rendering or in lifecycle methods.  Errors thrown
 * inside event handlers (onClick, onChange, …) bypass boundaries entirely and
 * surface as uncaught exceptions on `window`.
 *
 * This component closes that gap via three layers:
 *
 *   1. **Render-time errors** — standard getDerivedStateFromError / componentDidCatch.
 *
 *   2. **Synchronous throws in event handlers** — capture-phase listeners on the
 *      wrapper div set a module-level flag (`activeBoundary`) when a DOM event
 *      originates from our subtree.  A `window "error"` listener checks the
 *      flag and attributes the error to this boundary.  A microtask resets the
 *      flag after the synchronous handler finishes.
 *
 *   3. **Async throws from event handlers** — the capture-phase listener also
 *      records `lastEventTarget` and `lastEventTime`.  A second global listener
 *      on `unhandledrejection` routes rejections that weren't already handled
 *      by `trackPromise` (defaultPrevented) to the innermost registered
 *      boundary whose container contains `lastEventTarget`, provided the event
 *      was recent.  This catches `async () => { await fetch(...); throw … }`
 *      patterns where the handler awaits a promise our trackPromise wrapper
 *      does not cover.
 *
 * Limitations:
 *   - The async fallback uses the last event's target as an attribution
 *     hint.  If multiple unrelated async operations happen within the time
 *     window without intervening user interaction, later rejections may be
 *     misattributed to the wrong boundary.  The window is kept short to
 *     minimize this.
 *   - Rejections fired when no recent event exists (e.g. background timers,
 *     useEffect-initiated fetches with no awaits in handlers) are not caught
 *     by this layer — components should use try/catch in those cases.
 */

import { Component, type ErrorInfo, type ReactNode, type SyntheticEvent, createRef } from "react";
import { ensureTrackPromiseListener } from "../utils/trackAsyncErrors";

// ---------------------------------------------------------------------------
// Module-level tracking — only one JS event handler runs at a time, so a
// single variable is sufficient for the active-boundary flag.
// ---------------------------------------------------------------------------

let activeBoundary: EventErrorBoundary | null = null;

// Last user-event target, for routing late async rejections.
let lastEventTarget: Element | null = null;
let lastEventTime = 0;

// How long after an event we still accept its target as an attribution hint.
// Kept short to minimize misattribution of background rejections.
const ASYNC_EVENT_ATTRIBUTION_WINDOW_MS = 5_000;

// Registry of live boundaries, used to walk up from a DOM target to the
// innermost enclosing boundary.
const registeredBoundaries = new Map<EventErrorBoundary, HTMLDivElement>();

let globalListenersInstalled = false;

function activateBoundary(boundary: EventErrorBoundary): void {
  activeBoundary = boundary;
  queueMicrotask(() => {
    if (activeBoundary === boundary) activeBoundary = null;
  });
}

function installGlobalListeners() {
  if (globalListenersInstalled) return;
  globalListenersInstalled = true;

  // Make sure trackPromise's unhandledrejection listener registers first, so
  // tracked rejections preventDefault before our fallback sees them.
  ensureTrackPromiseListener();

  window.addEventListener("error", (event: ErrorEvent) => {
    const boundary = activeBoundary;
    if (!boundary) return;
    activeBoundary = null;
    event.preventDefault();
    const error =
      event.error instanceof Error
        ? event.error
        : new Error(event.message || "Unknown error in event handler");
    boundary.handleEventHandlerError(error);
  });

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    if (event.defaultPrevented) return;
    if (!lastEventTarget) return;
    if (Date.now() - lastEventTime > ASYNC_EVENT_ATTRIBUTION_WINDOW_MS) return;
    const boundary = findBoundaryContaining(lastEventTarget);
    if (!boundary) return;
    event.preventDefault();
    const error =
      event.reason instanceof Error
        ? event.reason
        : new Error(String(event.reason ?? "Unknown async error"));
    boundary.handleEventHandlerError(error);
  });
}

/** Walk up from a target element to find the innermost registered boundary. */
function findBoundaryContaining(target: Element): EventErrorBoundary | null {
  let innermost: EventErrorBoundary | null = null;
  let innermostDepth = Infinity;
  for (const [boundary, container] of registeredBoundaries) {
    if (!container.contains(target)) continue;
    let depth = 0;
    let el: Element | null = target;
    while (el && el !== container) {
      el = el.parentElement;
      depth++;
    }
    if (depth < innermostDepth) {
      innermost = boundary;
      innermostDepth = depth;
    }
  }
  return innermost;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface EventErrorBoundaryProps {
  children: ReactNode;
  /** Called when any error is caught — render-time or event-handler. */
  onError?: (error: Error, info?: ErrorInfo) => void;
  /** Changing this value clears the error state (useful for retry). */
  resetKey?: string;
  /** Custom fallback UI.  When omitted a default red box is shown. */
  renderFallback?: (error: Error) => ReactNode;
}

interface EventErrorBoundaryState {
  error: Error | null;
  prevResetKey?: string;
}

export class EventErrorBoundary extends Component<
  EventErrorBoundaryProps,
  EventErrorBoundaryState
> {
  state: EventErrorBoundaryState = { error: null };
  private containerRef = createRef<HTMLDivElement>();

  // ── React error boundary (render-time errors) ────────────────────────────

  static getDerivedStateFromError(error: Error): Partial<EventErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: EventErrorBoundaryProps,
    state: EventErrorBoundaryState
  ): Partial<EventErrorBoundaryState> | null {
    if (props.resetKey !== state.prevResetKey) {
      return { error: null, prevResetKey: props.resetKey };
    }
    return { prevResetKey: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  // ── Lifecycle — manage the global listeners and boundary registry ────────

  componentDidMount(): void {
    installGlobalListeners();
    if (this.containerRef.current) {
      registeredBoundaries.set(this, this.containerRef.current);
    }
  }

  componentDidUpdate(): void {
    // Container ref may change across re-renders of the fallback vs children.
    if (this.containerRef.current) {
      registeredBoundaries.set(this, this.containerRef.current);
    } else {
      registeredBoundaries.delete(this);
    }
  }

  componentWillUnmount(): void {
    registeredBoundaries.delete(this);
    if (activeBoundary === this) activeBoundary = null;
  }

  // ── Event-handler error path ─────────────────────────────────────────────

  /** Called by the global `window "error"` / unhandledrejection listeners
   *  when an error is attributed to this boundary. */
  handleEventHandlerError(error: Error): void {
    this.setState({ error });
    this.props.onError?.(error);
  }

  /** Capture-phase handler — marks this boundary as the active target and
   *  records the event target for async-rejection attribution. */
  private trackEvent = (e: SyntheticEvent): void => {
    activateBoundary(this);
    if (e.target instanceof Element) {
      lastEventTarget = e.target;
      lastEventTime = Date.now();
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.renderFallback) {
        return this.props.renderFallback(this.state.error);
      }
      return (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: 6,
            background: "var(--intent-error-surface, var(--red-a3))",
            border: "1px solid var(--intent-error-border, var(--red-a6))",
            color: "var(--intent-error-text, var(--red-11))",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <strong>Component error</strong>
          <div style={{ marginTop: 4, fontFamily: "monospace", fontSize: 12 }}>
            {this.state.error.message}
          </div>
        </div>
      );
    }

    return (
      <div
        ref={this.containerRef}
        onClickCapture={this.trackEvent}
        onChangeCapture={this.trackEvent}
        onInputCapture={this.trackEvent}
        onSubmitCapture={this.trackEvent}
        onKeyDownCapture={this.trackEvent}
        onKeyUpCapture={this.trackEvent}
        onFocusCapture={this.trackEvent}
        onBlurCapture={this.trackEvent}
        onPointerDownCapture={this.trackEvent}
        onPointerUpCapture={this.trackEvent}
      >
        {this.props.children}
      </div>
    );
  }
}
