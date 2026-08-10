import type { GmailClient, GmailLabel } from "@workspace/gmail";

const LABEL_CACHE_TTL_MS = 5 * 60 * 1000;

/** Well-known system label ids accepted verbatim (case-insensitive). */
const SYSTEM_LABEL_IDS = new Set([
  "INBOX",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "SPAM",
  "TRASH",
  "SENT",
  "DRAFT",
  "CATEGORY_PERSONAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);

interface LabelCacheEntry {
  byName: Map<string, GmailLabel>;
  byId: Map<string, GmailLabel>;
  fetchedAt: number;
}

/**
 * Resolves human label names to Gmail label ids, creating missing user
 * labels on demand so the agent can apply REAL Gmail labels instead of
 * local-only categories.
 */
export class LabelResolver {
  private cache = new Map<string, LabelCacheEntry>();

  constructor(
    private readonly deps: {
      gmailFor: (channelId: string) => GmailClient;
      now?: () => number;
    }
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  invalidate(channelId: string): void {
    this.cache.delete(channelId);
  }

  private async entry(channelId: string): Promise<LabelCacheEntry> {
    const cached = this.cache.get(channelId);
    if (cached && this.now() - cached.fetchedAt < LABEL_CACHE_TTL_MS) return cached;
    const labels = await this.deps.gmailFor(channelId).listLabels();
    const fresh: LabelCacheEntry = {
      byName: new Map(labels.map((label) => [label.name.toLowerCase(), label])),
      byId: new Map(labels.map((label) => [label.id, label])),
      fetchedAt: this.now(),
    };
    this.cache.set(channelId, fresh);
    return fresh;
  }

  /**
   * Resolve label names/ids to ids. Unknown user labels are created when
   * `createMissing` (only for adds, never for removals).
   */
  async resolveIds(
    channelId: string,
    names: string[],
    opts: { createMissing: boolean }
  ): Promise<string[]> {
    if (names.length === 0) return [];
    const entry = await this.entry(channelId);
    const ids: string[] = [];
    for (const raw of names) {
      const name = raw.trim();
      if (!name) continue;
      const upper = name.toUpperCase();
      if (SYSTEM_LABEL_IDS.has(upper)) {
        ids.push(upper);
        continue;
      }
      if (entry.byId.has(name)) {
        ids.push(name);
        continue;
      }
      const existing = entry.byName.get(name.toLowerCase());
      if (existing) {
        ids.push(existing.id);
        continue;
      }
      if (!opts.createMissing) {
        throw new Error(`Unknown Gmail label: ${name}`);
      }
      const created = await this.deps.gmailFor(channelId).createLabel({
        name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      });
      entry.byName.set(created.name.toLowerCase(), created);
      entry.byId.set(created.id, created);
      ids.push(created.id);
    }
    return Array.from(new Set(ids));
  }
}
