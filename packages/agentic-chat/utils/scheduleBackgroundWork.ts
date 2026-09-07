/**
 * Schedule auxiliary panel work after primary rendering and lifecycle effects.
 *
 * Chromium provides requestIdleCallback in every Vibestudio panel host. The
 * timer fallback preserves the same "next task" boundary in tests and other
 * DOM-compatible hosts. The timeout guarantees eventual progress on a busy
 * panel after its startup work has still had ample time to dispatch.
 */
export function scheduleBackgroundWork(work: () => void): () => void {
  const requestIdle = globalThis.requestIdleCallback;
  const cancelIdle = globalThis.cancelIdleCallback;
  if (typeof requestIdle === "function" && typeof cancelIdle === "function") {
    const handle = requestIdle(() => work(), { timeout: 1_000 });
    return () => cancelIdle(handle);
  }

  const handle = globalThis.setTimeout(work, 0);
  return () => globalThis.clearTimeout(handle);
}

/**
 * Run dependent warmup stages on separate idle turns. A stage may load several
 * independent chunks in parallel, but the next (usually heavier) stage does
 * not compete with the first paint or with the previous stage's parse work.
 */
export function scheduleBackgroundStages(
  stages: ReadonlyArray<() => void | Promise<void>>,
  onError: (error: unknown, stage: number) => void = (error, stage) => {
    console.warn(`[background] Stage ${stage + 1} failed:`, error);
  }
): () => void {
  let cancelled = false;
  let cancelScheduled: (() => void) | null = null;

  const scheduleStage = (index: number): void => {
    if (cancelled || index >= stages.length) return;
    cancelScheduled = scheduleBackgroundWork(() => {
      cancelScheduled = null;
      if (cancelled) return;
      void Promise.resolve()
        .then(() => stages[index]?.())
        .catch((error) => onError(error, index))
        .finally(() => scheduleStage(index + 1));
    });
  };

  scheduleStage(0);
  return () => {
    cancelled = true;
    cancelScheduled?.();
    cancelScheduled = null;
  };
}
