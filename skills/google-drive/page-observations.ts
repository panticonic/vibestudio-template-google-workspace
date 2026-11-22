/** Reconstruct the latest observed cursor chain; retries replace their page. */
export function observePages<T>(pages: ReadonlyMap<string | null, { next: string | null; rows: T[]; incomplete?: boolean }>): { rows: T[]; complete: boolean; incomplete: boolean } {
  const rows: T[] = [];
  const seen = new Set<string | null>();
  let cursor: string | null = null;
  let incomplete = false;
  for (;;) {
    if (seen.has(cursor)) return { rows, complete: false, incomplete: true };
    seen.add(cursor);
    const page = pages.get(cursor);
    if (!page) return { rows, complete: false, incomplete };
    rows.push(...page.rows);
    incomplete ||= page.incomplete === true;
    if (page.next === null) return { rows, complete: true, incomplete };
    cursor = page.next;
  }
}
