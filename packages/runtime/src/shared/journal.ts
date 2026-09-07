export type PanelJournalEntry =
  | { type: "open"; source: string; id: string; kind: "workspace" | "browser" }
  | { type: "reload"; id: string }
  | { type: "close"; id: string }
  | { type: "stateArgs.set"; id: string };

export class Journal {
  readonly entries: PanelJournalEntry[] = [];

  append(entry: PanelJournalEntry): void {
    this.entries.push(entry);
  }
}

const active = new Map<Journal, number>();
const fanoutJournal: Journal = {
  get entries() {
    return [];
  },
  append(entry: PanelJournalEntry): void {
    for (const journal of active.keys()) {
      journal.append(entry);
    }
  },
} as Journal;

export async function withJournal<T>(journal: Journal, fn: () => Promise<T> | T): Promise<T> {
  active.set(journal, (active.get(journal) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const count = active.get(journal) ?? 0;
    if (count <= 1) active.delete(journal);
    else active.set(journal, count - 1);
  }
}

export function currentJournal(): Journal | null {
  return active.size > 0 ? fanoutJournal : null;
}
