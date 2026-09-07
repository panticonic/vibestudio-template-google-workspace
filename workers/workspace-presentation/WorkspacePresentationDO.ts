import {
  DurableObjectBase,
  schemaRpc,
  type DurableObjectContext,
} from "@workspace/runtime/worker/kernel";
import { workspacePresentationMethods } from "@vibestudio/service-schemas/workspacePresentation";
import type {
  IndexablePanel,
  PanelSearchResult,
  PanelSourceUsage,
} from "@vibestudio/shared/panelSearchTypes";
import { normalizePanelTitle } from "@vibestudio/shared/panel/title";

export class WorkspacePresentationDO extends DurableObjectBase {
  static override rpcMethods = workspacePresentationMethods;
  static override schemaVersion = 1;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
  }

  protected createTables(): void {
    this.sql.exec(`
      CREATE TABLE entity_titles (
        entity_id TEXT PRIMARY KEY,
        title TEXT NOT NULL
      );
      CREATE TABLE panels (
        slot_id TEXT PRIMARY KEY,
        entity_id TEXT,
        source TEXT NOT NULL DEFAULT '',
        searchable_title TEXT NOT NULL DEFAULT '',
        searchable_path TEXT,
        manifest_description TEXT,
        manifest_dependencies TEXT,
        tags TEXT,
        keywords TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_indexed_at INTEGER NOT NULL
      );
      CREATE TABLE source_usage (
        source TEXT PRIMARY KEY,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE VIRTUAL TABLE panel_fts USING fts5(
        searchable_title,
        searchable_path,
        manifest_description,
        manifest_dependencies,
        tags,
        keywords,
        content='panels',
        content_rowid='rowid'
      );
      CREATE TRIGGER panel_fts_insert AFTER INSERT ON panels BEGIN
        INSERT INTO panel_fts(rowid, searchable_title, searchable_path,
          manifest_description, manifest_dependencies, tags, keywords)
        VALUES (NEW.rowid, NEW.searchable_title, NEW.searchable_path,
          NEW.manifest_description, NEW.manifest_dependencies, NEW.tags, NEW.keywords);
      END;
      CREATE TRIGGER panel_fts_delete AFTER DELETE ON panels BEGIN
        INSERT INTO panel_fts(panel_fts, rowid, searchable_title, searchable_path,
          manifest_description, manifest_dependencies, tags, keywords)
        VALUES ('delete', OLD.rowid, OLD.searchable_title, OLD.searchable_path,
          OLD.manifest_description, OLD.manifest_dependencies, OLD.tags, OLD.keywords);
      END;
      CREATE TRIGGER panel_fts_update AFTER UPDATE ON panels BEGIN
        INSERT INTO panel_fts(panel_fts, rowid, searchable_title, searchable_path,
          manifest_description, manifest_dependencies, tags, keywords)
        VALUES ('delete', OLD.rowid, OLD.searchable_title, OLD.searchable_path,
          OLD.manifest_description, OLD.manifest_dependencies, OLD.tags, OLD.keywords);
        INSERT INTO panel_fts(rowid, searchable_title, searchable_path,
          manifest_description, manifest_dependencies, tags, keywords)
        VALUES (NEW.rowid, NEW.searchable_title, NEW.searchable_path,
          NEW.manifest_description, NEW.manifest_dependencies, NEW.tags, NEW.keywords);
      END;
    `);
  }

  protected override requiredTables(): readonly string[] {
    return ["entity_titles", "panels", "source_usage", "panel_fts"];
  }

  /**
   * Bind a shell slot to the presented panel and entity.
   *
   * `title` is the display title the binder already knows — a manifest title,
   * or the one the opener asked for. Recording it here is what keeps a slot
   * from being presented as its own slot id: the tree reads titles from this
   * table the moment the node exists, which is long before a panel document
   * has loaded and reported one of its own. A title already stored for the
   * entity still wins, so this can never undo a later, better name.
   */
  @schemaRpc()
  bindSlot(
    slotId: string,
    entityId: string,
    source: string,
    title?: string | null,
  ): void {
    const stored = this.entityTitle(entityId);
    const known = stored ?? normalizePanelTitle(title) ?? null;
    if (stored === null && known !== null) this.setEntityTitle(entityId, known);
    this.sql.exec(
      `INSERT INTO panels(slot_id, entity_id, source, searchable_title, last_indexed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(slot_id) DO UPDATE SET
         entity_id = excluded.entity_id,
         source = excluded.source,
         searchable_title = CASE
           WHEN excluded.searchable_title = '' THEN panels.searchable_title
           ELSE excluded.searchable_title
         END,
         last_indexed_at = excluded.last_indexed_at`,
      slotId,
      entityId,
      source,
      known ?? "",
      Date.now(),
    );
  }

  @schemaRpc()
  removeSlots(slotIds: string[]): void {
    this.ctx.storage.transactionSync(() => {
      for (const slotId of slotIds)
        this.sql.exec(`DELETE FROM panels WHERE slot_id = ?`, slotId);
    });
  }

  @schemaRpc()
  indexPanel(
    input: IndexablePanel & { source: string },
    entityId: string | null,
    options?: { explicit?: boolean },
  ): string | null {
    const now = Date.now();
    const existingTitle = entityId ? this.entityTitle(entityId) : null;
    const requestedTitle = normalizePanelTitle(input.title);
    // Re-observing a slot may repair a missing presentation row, but must not
    // replace a newer runtime title with its manifest default. Explicit human
    // edits remain authoritative.
    const title = options?.explicit
      ? requestedTitle
      : (existingTitle ?? requestedTitle);
    this.sql.exec(
      `INSERT INTO panels(
         slot_id, entity_id, source, searchable_title, searchable_path,
         manifest_description, manifest_dependencies, tags, keywords, last_indexed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slot_id) DO UPDATE SET
         entity_id = excluded.entity_id,
         source = excluded.source,
         searchable_title = excluded.searchable_title,
         searchable_path = excluded.searchable_path,
         manifest_description = excluded.manifest_description,
         manifest_dependencies = excluded.manifest_dependencies,
         tags = excluded.tags,
         keywords = excluded.keywords,
         last_indexed_at = excluded.last_indexed_at`,
      input.id,
      entityId,
      input.source,
      title ?? "",
      input.path ?? null,
      input.manifestDescription ?? null,
      input.manifestDependencies
        ? JSON.stringify(input.manifestDependencies)
        : null,
      input.tags ? JSON.stringify(input.tags) : null,
      input.keywords ? JSON.stringify(input.keywords) : null,
      now,
    );
    if (entityId && title) this.setEntityTitle(entityId, title, options);
    return entityId;
  }

  @schemaRpc()
  updatePanelTitle(
    slotId: string,
    entityId: string,
    title: string | null,
    options?: { explicit?: boolean },
  ): string {
    if (this.isEntityTitleExplicit(entityId) && !options?.explicit)
      return entityId;
    this.setEntityTitle(entityId, title, options);
    this.sql.exec(
      `UPDATE panels SET entity_id = ?, searchable_title = ?, last_indexed_at = ? WHERE slot_id = ?`,
      entityId,
      normalizePanelTitle(title) ?? "",
      Date.now(),
      slotId,
    );
    return entityId;
  }

  @schemaRpc()
  setEntityTitle(
    entityId: string,
    title: string | null,
    options?: { explicit?: boolean },
  ): void {
    const normalized = normalizePanelTitle(title);
    this.ctx.storage.transactionSync(() => {
      if (normalized === undefined) {
        this.sql.exec(
          `DELETE FROM entity_titles WHERE entity_id = ?`,
          entityId,
        );
        this.deleteStateValue(this.explicitTitleKey(entityId));
        return;
      }
      if (this.isEntityTitleExplicit(entityId) && !options?.explicit) return;
      this.sql.exec(
        `INSERT INTO entity_titles(entity_id, title) VALUES (?, ?)
         ON CONFLICT(entity_id) DO UPDATE SET title = excluded.title`,
        entityId,
        normalized,
      );
      this.sql.exec(
        `UPDATE panels SET searchable_title = ?, last_indexed_at = ? WHERE entity_id = ?`,
        normalized,
        Date.now(),
        entityId,
      );
      if (options?.explicit)
        this.setStateValue(this.explicitTitleKey(entityId), "1");
    });
  }

  @schemaRpc()
  listEntityTitles(): Array<{ id: string; title: string; explicit: boolean }> {
    return this.sql
      .exec(
        `SELECT entity_id AS id, title FROM entity_titles ORDER BY entity_id`,
      )
      .toArray()
      .map((row) => ({
        id: String(row["id"]),
        title: String(row["title"]),
        explicit: this.isEntityTitleExplicit(String(row["id"])),
      }));
  }

  @schemaRpc()
  isEntityTitleExplicit(entityId: string): boolean {
    return this.getStateValue(this.explicitTitleKey(entityId)) === "1";
  }

  @schemaRpc()
  titlesForSlots(slotIds: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const slotId of slotIds) {
      const row = this.sql
        .exec(
          `SELECT COALESCE(t.title, p.searchable_title) AS title
             FROM panels p LEFT JOIN entity_titles t ON t.entity_id = p.entity_id
            WHERE p.slot_id = ?`,
          slotId,
        )
        .toArray()[0];
      if (typeof row?.["title"] === "string" && row["title"] !== "") {
        result[slotId] = row["title"];
      }
    }
    return result;
  }

  @schemaRpc()
  incrementAccess(slotId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE panels SET access_count = access_count + 1 WHERE slot_id = ?`,
        slotId,
      );
      const source = this.sql
        .exec(`SELECT source FROM panels WHERE slot_id = ?`, slotId)
        .toArray()[0]?.["source"];
      if (typeof source !== "string" || source === "") return;
      this.sql.exec(
        `INSERT INTO source_usage(source, access_count, last_accessed_at) VALUES (?, 1, ?)
         ON CONFLICT(source) DO UPDATE SET
           access_count = source_usage.access_count + 1,
           last_accessed_at = excluded.last_accessed_at`,
        source,
        Date.now(),
      );
    });
  }

  @schemaRpc()
  sourceUsage(limit = 200): PanelSourceUsage[] {
    return this.sql
      .exec(
        `SELECT source, access_count, last_accessed_at FROM source_usage
         ORDER BY access_count DESC, last_accessed_at DESC, source ASC LIMIT ?`,
        Math.max(1, Math.min(200, limit)),
      )
      .toArray()
      .map((row) => ({
        source: String(row["source"]),
        accessCount: Number(row["access_count"]),
        lastAccessedAt: Number(row["last_accessed_at"]),
      }));
  }

  @schemaRpc()
  search(
    query: string,
    limit = 50,
    cursor?: string,
  ): { results: PanelSearchResult[]; nextCursor: string | null } {
    const safeQuery = this.sanitizeSearchQuery(query);
    const boundedLimit = Math.max(1, Math.min(200, limit));
    const parsed = cursor ? (JSON.parse(cursor) as [number, string]) : null;
    if (!safeQuery) return { results: [], nextCursor: null };
    const rows = this.sql
      .exec(
        `SELECT * FROM (
           SELECT p.slot_id AS id, COALESCE(t.title, p.searchable_title) AS title,
                  p.access_count AS access_count, bm25(panel_fts) AS relevance
             FROM panel_fts JOIN panels p ON panel_fts.rowid = p.rowid
             LEFT JOIN entity_titles t ON t.entity_id = p.entity_id
            WHERE panel_fts MATCH ?
         ) matches
         WHERE (? IS NULL OR relevance > ? OR (relevance = ? AND id > ?))
         ORDER BY relevance, id LIMIT ?`,
        safeQuery,
        parsed === null ? null : 1,
        parsed?.[0] ?? 0,
        parsed?.[0] ?? 0,
        parsed?.[1] ?? "",
        boundedLimit + 1,
      )
      .toArray() as Array<{
      id: string;
      title: string;
      access_count: number;
      relevance: number;
    }>;
    const hasMore = rows.length > boundedLimit;
    const visible = hasMore ? rows.slice(0, boundedLimit) : rows;
    const last = visible.at(-1);
    return {
      results: visible.map((row) => ({
        id: row.id,
        title: row.title,
        relevance: row.relevance,
        accessCount: row.access_count,
      })),
      nextCursor:
        hasMore && last ? JSON.stringify([last.relevance, last.id]) : null,
    };
  }

  @schemaRpc()
  rebuildIndex(): void {
    this.sql.exec(`INSERT INTO panel_fts(panel_fts) VALUES('rebuild')`);
  }

  private entityTitle(entityId: string): string | null {
    const title = this.sql
      .exec(`SELECT title FROM entity_titles WHERE entity_id = ?`, entityId)
      .toArray()[0]?.["title"];
    return typeof title === "string" ? title : null;
  }

  private explicitTitleKey(entityId: string): string {
    return `workspace-presentation.explicit-title:${entityId}`;
  }

  private sanitizeSearchQuery(query: string): string {
    return (query.normalize("NFKC").match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])
      .map((token) => `"${token}"*`)
      .join(" AND ");
  }
}
