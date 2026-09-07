import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

type RefWithCurrent<T> = { current: T | null };
type ReadonlyRef<T> = { readonly current: T };

export interface ScrollAnchorItem {
  id: string;
  signature?: string;
}

interface UseScrollAnchorOptions {
  scrollRef: RefWithCurrent<HTMLElement>;
  contentRef: RefWithCurrent<HTMLElement>;
  items: ScrollAnchorItem[];
  /**
   * Synchronous "pinned to bottom" signal. A ref (not a boolean) so gating is
   * never a render behind the user's actual scroll — anchoring and stick-to-
   * bottom must agree about who owns scrollTop in the same frame.
   */
  isAtBottomRef: ReadonlyRef<boolean>;
  onNewContent?: () => void;
}

interface AnchorSnapshot {
  id: string;
  offset: number;
}

interface ListSnapshot {
  items: ScrollAnchorItem[];
  anchor: AnchorSnapshot | null;
  scrollTop: number;
  scrollHeight: number;
}

function listItems(content: HTMLElement): HTMLElement[] {
  if (typeof content.querySelectorAll !== "function") return [];
  return Array.from(content.querySelectorAll<HTMLElement>("[data-scroll-anchor-id]"));
}

function getItemTop(item: HTMLElement, content: HTMLElement): number {
  if (Number.isFinite(item.offsetTop)) return item.offsetTop;
  const itemRect = item.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  return itemRect.top - contentRect.top;
}

function getItemHeight(item: HTMLElement): number {
  if (Number.isFinite(item.offsetHeight) && item.offsetHeight > 0) return item.offsetHeight;
  return item.getBoundingClientRect().height;
}

function captureAnchor(viewport: HTMLElement, content: HTMLElement): AnchorSnapshot | null {
  const scrollTop = viewport.scrollTop;
  for (const item of listItems(content)) {
    const top = getItemTop(item, content);
    const bottom = top + getItemHeight(item);
    if (bottom >= scrollTop) {
      const id = item.getAttribute("data-scroll-anchor-id");
      return id ? { id, offset: top - scrollTop } : null;
    }
  }
  const items = listItems(content);
  const last = items[items.length - 1];
  const id = last?.getAttribute("data-scroll-anchor-id");
  return last && id ? { id, offset: getItemTop(last, content) - scrollTop } : null;
}

function findAnchor(content: HTMLElement, id: string): HTMLElement | null {
  return listItems(content).find((item) => item.getAttribute("data-scroll-anchor-id") === id) ?? null;
}

function isAppendOnly(previous: ScrollAnchorItem[], next: ScrollAnchorItem[]): boolean {
  if (next.length <= previous.length) return false;
  return previous.every((item, index) => next[index]?.id === item.id);
}

function isPrependOnly(previous: ScrollAnchorItem[], next: ScrollAnchorItem[]): boolean {
  if (next.length <= previous.length) return false;
  const offset = next.length - previous.length;
  return previous.every((item, index) => next[index + offset]?.id === item.id);
}

function hasSharedChanges(previous: ScrollAnchorItem[], next: ScrollAnchorItem[]): boolean {
  const nextById = new Map(next.map((item, index) => [item.id, { item, index }]));
  let previousSharedIndex = -1;
  for (let index = 0; index < previous.length; index += 1) {
    const prevItem = previous[index]!;
    const nextEntry = nextById.get(prevItem.id);
    if (!nextEntry) continue;
    if (nextEntry.item.signature !== prevItem.signature) return true;
    if (nextEntry.index < previousSharedIndex) return true;
    previousSharedIndex = nextEntry.index;
  }
  return previous.some((item) => nextById.has(item.id));
}

function hasChangedItemBelowViewport(
  previous: ScrollAnchorItem[],
  next: ScrollAnchorItem[],
  viewport: HTMLElement,
  content: HTMLElement,
): boolean {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const viewportBottom = viewport.scrollTop + viewport.clientHeight;
  for (const item of next) {
    const previousItem = previousById.get(item.id);
    if (!previousItem || previousItem.signature === item.signature) continue;
    const element = findAnchor(content, item.id);
    if (element && getItemTop(element, content) >= viewportBottom) return true;
  }
  return false;
}

function hasNewNonPrependItem(previous: ScrollAnchorItem[], next: ScrollAnchorItem[]): boolean {
  if (isPrependOnly(previous, next)) return false;
  const previousIds = new Set(previous.map((item) => item.id));
  return next.some((item) => !previousIds.has(item.id));
}

export function useScrollAnchor({
  scrollRef,
  contentRef,
  items,
  isAtBottomRef,
  onNewContent,
}: UseScrollAnchorOptions): void {
  const snapshotRef = useRef<ListSnapshot | null>(null);
  const onNewContentRef = useRef(onNewContent);
  onNewContentRef.current = onNewContent;

  // Keep the captured anchor synced to where the user is actually looking.
  // Without this, the anchor only refreshes when `items` change, so a scroll
  // made while the list is idle would be undone by the next streaming update —
  // the view would snap back to the pre-scroll spot. Re-capturing on scroll
  // means item changes always preserve the *current* viewport.
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport || typeof viewport.addEventListener !== "function") return;
    const handleScroll = () => {
      if (isAtBottomRef.current) return;
      const snapshot = snapshotRef.current;
      const node = contentRef.current;
      if (!snapshot || !node) return;
      snapshot.anchor = captureAnchor(viewport, node);
      snapshot.scrollTop = viewport.scrollTop;
      snapshot.scrollHeight = viewport.scrollHeight;
    };
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, [scrollRef, contentRef, isAtBottomRef]);

  const itemKey = useMemo(
    () => items.map((item) => `${item.id}:${item.signature ?? ""}`).join("\u001f"),
    [items],
  );

  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const previous = snapshotRef.current;
    if (previous && !isAtBottomRef.current) {
      const appendOnly = isAppendOnly(previous.items, items);
      const prependOnly = isPrependOnly(previous.items, items);
      const shouldPreserveAnchor = prependOnly || !appendOnly || hasSharedChanges(previous.items, items);

      if (appendOnly && !prependOnly) {
        onNewContentRef.current?.();
      } else if (
        hasNewNonPrependItem(previous.items, items) ||
        hasChangedItemBelowViewport(previous.items, items, viewport, content)
      ) {
        onNewContentRef.current?.();
        if (shouldPreserveAnchor && previous.anchor) {
          const anchor = findAnchor(content, previous.anchor.id);
          if (anchor) {
            viewport.scrollTop = getItemTop(anchor, content) - previous.anchor.offset;
          }
        }
      } else if (shouldPreserveAnchor && previous.anchor) {
        const anchor = findAnchor(content, previous.anchor.id);
        if (anchor) {
          viewport.scrollTop = getItemTop(anchor, content) - previous.anchor.offset;
        } else {
          viewport.scrollTop = previous.scrollTop + (viewport.scrollHeight - previous.scrollHeight);
        }
      } else if (prependOnly) {
        viewport.scrollTop = previous.scrollTop + (viewport.scrollHeight - previous.scrollHeight);
      }
    }

    snapshotRef.current = {
      items,
      anchor: captureAnchor(viewport, content),
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
    };
  }, [contentRef, itemKey, items, scrollRef]);

  useEffect(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!viewport || !content || typeof ResizeObserver === "undefined") return;

    const heights = new WeakMap<HTMLElement, number>();
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const previousHeight = heights.get(target) ?? getItemHeight(target);
        const nextHeight = getItemHeight(target);
        heights.set(target, nextHeight);
        const delta = nextHeight - previousHeight;
        if (delta === 0 || isAtBottomRef.current) continue;
        if (getItemTop(target, content) < viewport.scrollTop) {
          viewport.scrollTop += delta;
        }
      }
      snapshotRef.current = {
        items,
        anchor: captureAnchor(viewport, content),
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
      };
    });

    for (const item of listItems(content)) {
      heights.set(item, getItemHeight(item));
      observer.observe(item);
    }
    return () => observer.disconnect();
  }, [contentRef, itemKey, items, scrollRef]);
}
