import type { SplitNode } from "./types.js";

export type PaneFocusDirection = "up" | "down" | "left" | "right";

interface PaneRect {
  sessionId: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function findDirectionalPane(
  tree: SplitNode,
  currentSessionId: string,
  direction: PaneFocusDirection,
): string | undefined {
  const rects: PaneRect[] = [];
  collectPaneRects(tree, { left: 0, top: 0, right: 1, bottom: 1 }, rects);
  const current = rects.find((rect) => rect.sessionId === currentSessionId);
  if (!current) return undefined;
  const currentCenterX = (current.left + current.right) / 2;
  const currentCenterY = (current.top + current.bottom) / 2;
  const candidates = rects
    .filter((rect) => rect.sessionId !== currentSessionId && isDirectionalCandidate(current, rect, direction))
    .map((rect) => {
      const centerX = (rect.left + rect.right) / 2;
      const centerY = (rect.top + rect.bottom) / 2;
      const primary = direction === "left"
        ? current.left - rect.right
        : direction === "right"
          ? rect.left - current.right
          : direction === "up"
            ? current.top - rect.bottom
            : rect.top - current.bottom;
      const overlap = direction === "left" || direction === "right"
        ? axisOverlap(current.top, current.bottom, rect.top, rect.bottom)
        : axisOverlap(current.left, current.right, rect.left, rect.right);
      const secondary = direction === "left" || direction === "right"
        ? Math.abs(centerY - currentCenterY)
        : Math.abs(centerX - currentCenterX);
      return { rect, primary, overlap, secondary };
    })
    .sort((a, b) => {
      const aTouches = a.overlap > 0 ? 0 : 1;
      const bTouches = b.overlap > 0 ? 0 : 1;
      return aTouches - bTouches || a.primary - b.primary || b.overlap - a.overlap || a.secondary - b.secondary;
    });
  return candidates[0]?.rect.sessionId;
}

function collectPaneRects(node: SplitNode, rect: Omit<PaneRect, "sessionId">, out: PaneRect[]): void {
  if (node.kind === "leaf") {
    out.push({ sessionId: node.sessionId, ...rect });
    return;
  }
  const ratio = Math.min(0.9, Math.max(0.1, node.ratio));
  if (node.direction === "row") {
    const split = rect.left + (rect.right - rect.left) * ratio;
    collectPaneRects(node.a, { ...rect, right: split }, out);
    collectPaneRects(node.b, { ...rect, left: split }, out);
    return;
  }
  const split = rect.top + (rect.bottom - rect.top) * ratio;
  collectPaneRects(node.a, { ...rect, bottom: split }, out);
  collectPaneRects(node.b, { ...rect, top: split }, out);
}

function isDirectionalCandidate(current: PaneRect, candidate: PaneRect, direction: PaneFocusDirection): boolean {
  if (direction === "left") return candidate.right <= current.left;
  if (direction === "right") return candidate.left >= current.right;
  if (direction === "up") return candidate.bottom <= current.top;
  return candidate.top >= current.bottom;
}

function axisOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}
