import { useCallback, useEffect, useRef, useState } from "react";

interface ScrollToBottomOptions {
  animation?: ScrollBehavior;
}

interface StickToBottomOptions {
  initial?: ScrollBehavior;
  resize?: ScrollBehavior;
  /**
   * Distance (px) from the bottom within which the view is considered "at the
   * bottom" and stays pinned. A small sticky zone so trackpad/touch jitter near
   * the end doesn't release the pin, while a deliberate scroll up does.
   */
  threshold?: number;
}

type CallbackRef<T> = ((node: T | null) => void) & { current: T | null };

/** Read-only view of a ref — what we hand to consumers that only observe. */
export type ReadonlyRef<T> = { readonly current: T };

export interface StickToBottomController {
  scrollRef: CallbackRef<HTMLElement>;
  contentRef: CallbackRef<HTMLElement>;
  scrollToBottom: (options?: ScrollToBottomOptions) => boolean;
  /** Reactive flag — drives the "new messages" indicator and its dismissal. */
  isAtBottom: boolean;
  /**
   * Synchronous mirror of `isAtBottom`. Layout-effect consumers (useScrollAnchor)
   * read this instead of the state value so their gating can't lag a render
   * behind the user's actual scroll.
   */
  isAtBottomRef: ReadonlyRef<boolean>;
}

function createCallbackRef<T>(): CallbackRef<T> {
  const ref = ((node: T | null) => {
    ref.current = node;
  }) as CallbackRef<T>;
  ref.current = null;
  return ref;
}

export interface ScrollSample {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export type PinDecision = "pin" | "release" | "keep";

/**
 * Pure pin/release decision for one scroll event — the heart of the anti-yank
 * behavior, factored out so it can be unit-tested without a DOM.
 *
 *  - inside the bottom sticky zone → "pin" (user returned to the bottom; also
 *    where a shrink-clamp lands, so a clamp re-pins rather than releases);
 *  - moved up with steady/grown height → "release" (a deliberate scroll away);
 *  - moved up but height shrank → "keep" (a layout clamp, not a gesture);
 *  - anything else (growth, downward scroll still short of the zone) → "keep".
 *
 * Crucially, content growth alone never yields "pin": a released view can only
 * be re-pinned by the user scrolling back to the bottom.
 */
export function decidePin(previous: ScrollSample, next: ScrollSample, threshold: number): PinDecision {
  const distance = next.scrollHeight - next.scrollTop - next.clientHeight;
  if (distance <= threshold) return "pin";
  const movedUp = next.scrollTop < previous.scrollTop - 1;
  const shrank = next.scrollHeight < previous.scrollHeight;
  if (movedUp && !shrank) return "release";
  return "keep";
}

/**
 * Keeps a scroll container pinned to the bottom as content grows, while
 * treating an explicit upward scroll as a durable "let me read" intent.
 *
 * The core rule: pin state changes only from user intent, never from content
 * size. Streaming text and freshly-arrived pills grow the content but can't
 * re-pin a released view, so they never yank the user back down. Pinning
 * re-engages only when the user scrolls back into the bottom sticky zone.
 *
 * Scroll events are classified by comparing against the previous scroll
 * position and height:
 *  - inside the sticky zone  → pin (covers the user returning to the bottom and
 *    the browser's shrink-clamp landing us back at the new bottom);
 *  - moved up, height steady → release (a deliberate scroll away);
 *  - height shrank           → ignored (a layout clamp, not a user gesture);
 *  - moved down, still away   → keep current state.
 */
export function useStickToBottom(options: StickToBottomOptions = {}): StickToBottomController {
  const threshold = options.threshold ?? 32;
  const scrollRef = useRef<CallbackRef<HTMLElement>>(createCallbackRef<HTMLElement>()).current;
  const contentRef = useRef<CallbackRef<HTMLElement>>(createCallbackRef<HTMLElement>()).current;
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);

  const setPinned = useCallback((next: boolean) => {
    isAtBottomRef.current = next;
    setIsAtBottom((prev) => (prev === next ? prev : next));
  }, []);

  const scrollToBottom = useCallback((scrollOptions: ScrollToBottomOptions = {}) => {
    const viewport = scrollRef.current;
    if (!viewport) return false;
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: scrollOptions.animation ?? "instant",
    });
    lastScrollTopRef.current = viewport.scrollTop;
    lastScrollHeightRef.current = viewport.scrollHeight;
    setPinned(true);
    return true;
  }, [scrollRef, setPinned]);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;

    const syncPosition = () => {
      lastScrollTopRef.current = viewport.scrollTop;
      lastScrollHeightRef.current = viewport.scrollHeight;
    };

    const handleScroll = () => {
      const next: ScrollSample = {
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
      };
      const previous: ScrollSample = {
        scrollTop: lastScrollTopRef.current,
        scrollHeight: lastScrollHeightRef.current,
        clientHeight: next.clientHeight,
      };
      lastScrollTopRef.current = next.scrollTop;
      lastScrollHeightRef.current = next.scrollHeight;

      const decision = decidePin(previous, next, threshold);
      if (decision === "pin") setPinned(true);
      else if (decision === "release") setPinned(false);
    };

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    syncPosition();
    if (options.initial) {
      scrollToBottom({ animation: options.initial });
    } else {
      handleScroll();
    }
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, [options.initial, scrollRef, scrollToBottom, setPinned, threshold]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      // Content size changed: only follow it to the bottom if still pinned.
      // A released view stays put (useScrollAnchor preserves the exact spot).
      if (isAtBottomRef.current) {
        scrollToBottom({ animation: options.resize ?? "instant" });
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [contentRef, options.resize, scrollToBottom]);

  return { scrollRef, contentRef, scrollToBottom, isAtBottom, isAtBottomRef };
}
