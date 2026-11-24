/** Reconstruct the latest observed cursor chain; retries replace their page. */
export function observePageChain<T>(pages: ReadonlyMap<string | null, { next: string | null; rows: T[]; incomplete?: boolean }>, initialCursor: string | null = null): { rows: T[]; complete: boolean; incomplete: boolean; cursors: (string | null)[]; frontier: string | null } {
  const rows: T[] = [];
  const cursors: (string | null)[] = [];
  const seen = new Set<string | null>();
  let cursor = initialCursor;
  let incomplete = false;
  for (;;) {
    if (seen.has(cursor)) return { rows, complete: false, incomplete: true, cursors, frontier: cursor };
    seen.add(cursor);
    const page = pages.get(cursor);
    if (!page) return { rows, complete: false, incomplete, cursors, frontier: cursor };
    cursors.push(cursor);
    rows.push(...page.rows);
    incomplete ||= page.incomplete === true;
    if (page.next === null) return { rows, complete: true, incomplete, cursors, frontier: null };
    cursor = page.next;
  }
}

export function observePages<T>(pages: ReadonlyMap<string | null, { next: string | null; rows: T[]; incomplete?: boolean }>): { rows: T[]; complete: boolean; incomplete: boolean } {
  const { rows, complete, incomplete } = observePageChain(pages);
  return { rows, complete, incomplete };
}
