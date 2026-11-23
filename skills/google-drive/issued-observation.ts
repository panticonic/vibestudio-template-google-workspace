/** Replay an immutable assigned snapshot; concurrent readers share the acquisition. */
export function issuedObservation<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return async () => {
    const current = pending ??= load();
    try { return structuredClone(await current); }
    catch (error) { if (pending === current) pending = undefined; throw error; }
  };
}
