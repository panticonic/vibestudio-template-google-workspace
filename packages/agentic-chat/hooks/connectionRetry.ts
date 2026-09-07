export function isTransientConnectionFailure(error: unknown): boolean {
  const kind =
    typeof error === "object" && error !== null && "errorKind" in error
      ? (error as { errorKind?: unknown }).errorKind
      : undefined;
  return kind !== "access" && kind !== "application";
}

export function connectionRetryDelayMs(attempt: number): number {
  return Math.min(5_000, 250 * 2 ** Math.min(Math.max(0, attempt), 5));
}
