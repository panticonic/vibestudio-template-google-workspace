import { normalizeWorkspaceRepoPath } from "@vibestudio/workspace/remotes";

const locks = new Map<string, Promise<unknown>>();

export function withOperationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!key) throw new Error("Operation lock key must be non-empty");
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(
    () => fn(),
    () => fn()
  );
  const chain = next.then(
    () => undefined,
    () => undefined
  );
  locks.set(key, chain);
  // Evict the entry once the chain drains, so idle repos don't accumulate
  // map entries for the process lifetime.
  void chain.then(() => {
    if (locks.get(key) === chain) locks.delete(key);
  });
  return next;
}

export function withRepoLock<T>(
  repoPath: string,
  fn: (repoPath: string) => Promise<T>
): Promise<T> {
  const repo = normalizeWorkspaceRepoPath(repoPath);
  return withOperationLock(`repo:${repo}`, () => fn(repo));
}
