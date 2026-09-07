export function clampSplitRatio(ratio: number): number {
  return Math.min(0.9, Math.max(0.1, ratio));
}

export function splitRatioFromDrag(currentRatio: number, delta: number, totalSize: number): number {
  if (!Number.isFinite(totalSize) || totalSize <= 0) return clampSplitRatio(currentRatio);
  return clampSplitRatio(currentRatio + delta / totalSize);
}

export function splitRatioFromKey(currentRatio: number, key: string, shiftKey = false): number | undefined {
  const step = shiftKey ? 0.1 : 0.03;
  if (key === "ArrowLeft" || key === "ArrowUp") return clampSplitRatio(currentRatio - step);
  if (key === "ArrowRight" || key === "ArrowDown") return clampSplitRatio(currentRatio + step);
  if (key === "Home") return 0.1;
  if (key === "End") return 0.9;
  if (key === "Enter") return 0.5;
  return undefined;
}
