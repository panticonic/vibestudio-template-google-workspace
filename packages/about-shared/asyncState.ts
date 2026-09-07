import { useCallback, useEffect, useRef, useState } from "react";

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A newer read owns the result, including its loading and error state. */
export function useAsyncResource<T>(
  read: () => Promise<T>,
  refreshIntervalMs?: number,
) {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await read();
      if (generation.current === current) setData(result);
    } catch (cause) {
      if (generation.current === current) setError(errorMessage(cause));
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [read]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh();
      if (!disposed && refreshIntervalMs !== undefined)
        timer = setTimeout(() => void poll(), refreshIntervalMs);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      generation.current++;
    };
  }, [refresh, refreshIntervalMs]);
  return { data, loading, error, refresh };
}

/** Serialize each record's actions while leaving other records usable. */
export function useRecordActions() {
  const active = useRef(new Set<string | number>());
  const [pending, setPending] = useState<ReadonlySet<string | number>>(
    new Set(),
  );
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (key: string | number, action: () => Promise<unknown>) => {
      if (active.current.has(key)) return;
      active.current.add(key);
      setPending(new Set(active.current));
      setError(null);
      try {
        await action();
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        active.current.delete(key);
        setPending(new Set(active.current));
      }
    },
    [],
  );
  return { pending, error, run };
}
