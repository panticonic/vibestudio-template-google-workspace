import { useEffect, useRef, useState } from "react";

/** Below this card width (px) renderers switch to their compact layout. */
export const COMPACT_MAX_WIDTH = 480;

/**
 * ResizeObserver-backed card-width hook for sandbox renderers. Renderers are
 * self-contained (no chat package CSS), so width-responsive behavior keys on
 * the rendered card's own width — panels can be narrow even on wide viewports.
 * Attach `ref` to the card's root element and branch on `compact`.
 */
export function useContainerWidth<T extends HTMLElement = HTMLDivElement>(): {
  ref: React.RefObject<T | null>;
  width: number | null;
  compact: boolean;
} {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  return { ref, width, compact: width !== null && width < COMPACT_MAX_WIDTH };
}
