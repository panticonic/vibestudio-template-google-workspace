// Builtin semantic-authority implementation.
import type { SqlStorage } from "@vibestudio/durable";

/**
 * The relational contract of the semantic record.
 *
 * `prov_*` views — not the canonical tables — are the public surface an agent
 * may query. The tables stay private and freely refactorable; a refactor that
 * preserves view semantics is invisible to every agent surface.
 *
 * Every state-anchored view joins through the caller-scoped visibility basis
 * (`prov_vis_events`, `prov_vis_applications`, `prov_vis_commands`), which the
 * executor refills per query from the reachable context authorities the host
 * supplies. A static SQLite view cannot vary by caller, so the caller varies
 * the basis instead. The Durable Object is single-threaded, so a refilled
 * scratch table is exactly as caller-private as a temp table would be, and
 * unlike `CREATE TEMP TABLE` it needs no unversioned per-connection state.
 */

/** Bumped only with the view contract. Additive changes stay within a version. */
export const PROV_SCHEMA_VERSION = 1;

/** Persisted resolved-intent protocol; see semanticWorkspace.intentForWorkUnit. */
export const PROV_RESOLVER_PROTOCOL = "intent-ladder/v1";

export const PROV_VISIBILITY_TABLES = [
  "prov_vis_events",
  "prov_vis_applications",
  "prov_vis_commands",
] as const;

export interface ProvColumnDescription {
  readonly column: string;
  readonly meaning: string;
}

export interface ProvRelationDescription {
  readonly relation: string;
  readonly meaning: string;
  readonly columns: readonly ProvColumnDescription[];
}

/** Self-describing catalog: the skill teaches the pattern, not the DDL. */
export const PROV_CATALOG: readonly ProvRelationDescription[] = [
  {
    relation: "prov_work_units",
    meaning:
      "One authored unit of work; resolved intent is the persisted ladder output.",
    columns: [
      {
        column: "work_unit_id",
        meaning: "Work unit identity (bind with an @ref).",
      },
      {
        column: "kind",
        meaning:
          "edit | file-transfer | lifecycle | merge | revert | import | external-unapplied.",
      },
      {
        column: "intent_tier",
        meaning: "stated | trigger | mechanical; never laundered.",
      },
      { column: "intent_text", meaning: "Resolved intent text at that tier." },
      {
        column: "resolver_protocol",
        meaning: "Intent-ladder protocol that produced the columns.",
      },
      {
        column: "author_context_id",
        meaning: "Context that authored the work.",
      },
      { column: "command_id", meaning: "Originating semantic command." },
      { column: "created_at", meaning: "Capture-time timestamp." },
      { column: "content_class", meaning: "internal | external." },
    ],
  },
  {
    relation: "prov_changes",
    meaning: "Authored changes with their base and result coordinates.",
    columns: [
      { column: "change_id", meaning: "Change identity." },
      { column: "work_unit_id", meaning: "Authoring work unit." },
      {
        column: "kind",
        meaning: "Change kind (file-create, text-edit, file-delete, …).",
      },
      {
        column: "file_id",
        meaning: "Result file identity when the change places a file.",
      },
      { column: "repository_id", meaning: "Result repository identity." },
      { column: "base_path", meaning: "Path before the change." },
      { column: "result_path", meaning: "Path after the change." },
      {
        column: "effect_digest",
        meaning: "Canonical digest of the change effect.",
      },
    ],
  },
  {
    relation: "prov_applied_changes",
    meaning: "Realization of a change on one exact basis.",
    columns: [
      { column: "applied_change_id", meaning: "Applied change identity." },
      { column: "application_id", meaning: "Owning application." },
      { column: "change_id", meaning: "Authored change." },
      { column: "ordinal", meaning: "Order within the application." },
    ],
  },
  {
    relation: "prov_content_edges",
    meaning: "Immediate content-coordinate lineage between applied changes.",
    columns: [
      { column: "child_applied_change_id", meaning: "Later applied change." },
      {
        column: "parent_applied_change_id",
        meaning: "Earlier applied change.",
      },
      { column: "relation", meaning: "preserves | copies | incorporates." },
    ],
  },
  {
    relation: "prov_events",
    meaning: "Committed workspace events visible to the caller.",
    columns: [
      { column: "event_id", meaning: "Event identity." },
      { column: "kind", meaning: "genesis | commit | integration-commit." },
      { column: "message", meaning: "Commit message." },
      { column: "created_at", meaning: "Commit timestamp." },
    ],
  },
  {
    relation: "prov_event_parents",
    meaning: "Immediate event ancestry (no stored transitive closure).",
    columns: [
      { column: "event_id", meaning: "Child event." },
      { column: "parent_event_id", meaning: "Parent event." },
      { column: "ordinal", meaning: "Parent order; 0 is the first parent." },
    ],
  },
  {
    relation: "prov_event_applications",
    meaning: "Applications carried by an event.",
    columns: [
      { column: "event_id", meaning: "Event identity." },
      { column: "application_id", meaning: "Application identity." },
      { column: "ordinal", meaning: "Order within the event." },
    ],
  },
  {
    relation: "prov_applications",
    meaning: "One realization of one work unit on one basis.",
    columns: [
      { column: "application_id", meaning: "Application identity." },
      { column: "work_unit_id", meaning: "Realized work unit." },
      { column: "basis_kind", meaning: "event | application." },
      { column: "basis_id", meaning: "Exact basis identity." },
    ],
  },
  {
    relation: "prov_decisions",
    meaning: "Integration decisions owned by a merge work unit.",
    columns: [
      { column: "decision_id", meaning: "Decision identity." },
      { column: "work_unit_id", meaning: "Owning merge work unit." },
      { column: "target_state_kind", meaning: "event | application." },
      { column: "target_state_id", meaning: "Exact target state." },
      {
        column: "source_event_id",
        meaning: "Integrated source event, when any.",
      },
      {
        column: "source_delta_id",
        meaning: "Integrated external delta, when any.",
      },
      { column: "created_at", meaning: "Decision timestamp." },
    ],
  },
  {
    relation: "prov_decision_entries",
    meaning:
      "Per-coordinate accounting of one decision; `ours`/`current` are rejections.",
    columns: [
      { column: "decision_id", meaning: "Owning decision." },
      { column: "coordinate_kind", meaning: "file | repository." },
      { column: "coordinate_id", meaning: "Coordinate identity." },
      {
        column: "resolution",
        meaning: "adopt | convergent | composed | ours | current.",
      },
      { column: "rationale", meaning: "Recorded rationale prose, when any." },
      {
        column: "result_change_id",
        meaning: "Change the resolution produced, when any.",
      },
    ],
  },
  {
    relation: "prov_counteractions",
    meaning: "A change that undoes another; the negative-evidence edge.",
    columns: [
      { column: "change_id", meaning: "Counteracting change." },
      { column: "counteracted_change_id", meaning: "Change that was undone." },
    ],
  },
  {
    relation: "prov_external_deltas",
    meaning: "Declared changes made outside the workspace.",
    columns: [
      { column: "delta_id", meaning: "External delta identity." },
      { column: "work_unit_id", meaning: "Declaring work unit." },
      { column: "repository_id", meaning: "Affected repository." },
      { column: "repo_path", meaning: "Repository path." },
      { column: "status", meaning: "active | superseded | finalized." },
      {
        column: "superseded_by_delta_id",
        meaning: "Superseding delta, when any.",
      },
      { column: "created_at", meaning: "Declaration timestamp." },
    ],
  },
  {
    relation: "prov_commands",
    meaning:
      "The command journal: the join between semantic work and trajectories.",
    columns: [
      { column: "command_id", meaning: "Command identity." },
      { column: "method", meaning: "Semantic method name." },
      { column: "status", meaning: "pending | effect-pending | complete." },
      {
        column: "cause_invocation_id",
        meaning: "Causing tool invocation, when any.",
      },
      { column: "cause_log_id", meaning: "Causing trajectory log." },
      { column: "cause_head", meaning: "Causing trajectory head." },
      { column: "created_at", meaning: "Command timestamp." },
    ],
  },
  {
    relation: "prov_invocations",
    meaning: "Trajectory invocations causally linked to visible commands.",
    columns: [
      { column: "log_id", meaning: "Trajectory log." },
      { column: "head", meaning: "Trajectory head." },
      { column: "invocation_id", meaning: "Invocation identity." },
      { column: "turn_id", meaning: "Owning turn." },
      { column: "status", meaning: "Invocation status." },
      { column: "terminal_outcome", meaning: "Terminal outcome, when any." },
    ],
  },
  {
    relation: "prov_turns",
    meaning: "Trajectory turns reachable from visible invocations.",
    columns: [
      { column: "log_id", meaning: "Trajectory log." },
      { column: "head", meaning: "Trajectory head." },
      { column: "turn_id", meaning: "Turn identity." },
      { column: "ordinal", meaning: "Turn order." },
      {
        column: "trigger_message_id",
        meaning: "Message that opened the turn.",
      },
      { column: "summary", meaning: "Turn summary, when any." },
    ],
  },
  {
    relation: "prov_messages",
    meaning:
      "Trajectory messages with a bounded excerpt; inspect the message ref for its full recorded text.",
    columns: [
      { column: "log_id", meaning: "Trajectory log." },
      { column: "head", meaning: "Trajectory head." },
      { column: "message_id", meaning: "Message identity." },
      { column: "turn_id", meaning: "Owning turn." },
      { column: "role", meaning: "user | assistant | system | tool." },
      { column: "sender_kind", meaning: "Sender principal kind." },
      { column: "sender_id", meaning: "Sender principal identity." },
      {
        column: "source_message_id",
        meaning: "Message this one continues from.",
      },
      {
        column: "text_excerpt",
        meaning: "Leading excerpt of the message text, bounded by the view.",
      },
      {
        column: "text_length",
        meaning:
          "Full recorded length; longer than the excerpt means text was cut, so inspect the ref.",
      },
    ],
  },
  {
    relation: "prov_files",
    meaning: "File coordinates as the caller's visible basis last placed them.",
    columns: [
      { column: "file_id", meaning: "Stable file identity." },
      { column: "repository_id", meaning: "Repository identity." },
      { column: "path", meaning: "Path at the last visible placement." },
      { column: "presence", meaning: "placed | deleted." },
      {
        column: "last_change_id",
        meaning: "Change that last placed the coordinate.",
      },
    ],
  },
  {
    relation: "prov_search",
    meaning: "Full-text entry by content over stored prose.",
    columns: [
      {
        column: "subject_kind",
        meaning:
          "work-unit | decision | event | external-delta | trajectory-message.",
      },
      { column: "subject_id", meaning: "Subject identity." },
      { column: "log_id", meaning: "Trajectory log for message subjects." },
      { column: "head", meaning: "Trajectory head for message subjects." },
      { column: "label", meaning: "Short human label for the subject." },
      { column: "text", meaning: "Indexed prose." },
    ],
  },
  {
    relation: "prov_schema",
    meaning: "This catalog. One row per relation; query it first to learn the contract.",
    columns: [
      { column: "relation", meaning: "View name." },
      { column: "meaning", meaning: "What the relation means." },
      { column: "column_count", meaning: "How many columns the relation has." },
      {
        column: "columns",
        meaning: "Every column as `name — meaning`, separated by `; `.",
      },
    ],
  },
  {
    relation: "prov_schema_version",
    meaning: "The version of this view contract.",
    columns: [{ column: "version", meaning: "Contract version integer." }],
  },
];

export const PROV_RELATIONS: ReadonlySet<string> = new Set(
  PROV_CATALOG.map((relation) => relation.relation),
);

const sqlText = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * A catalog nobody can finish reading is not self-describing. One row per column
 * put the contract at 104 rows against a 50-row default page, so the single
 * taught discovery call could never complete and an agent learned only the
 * alphabetically-first relations. One row per relation keeps the whole contract
 * inside one page, with the column detail carried along in `columns`.
 *
 * A VALUES rowset also has no compound-SELECT term limit. The original UNION ALL
 * form crossed workerd's SQLite deployment limit as the contract grew and
 * stopped an otherwise healthy workspace from starting.
 */
function catalogView(): string {
  const rows = PROV_CATALOG.map((relation) => {
    const columns = relation.columns
      .map((column) => `${column.column} — ${column.meaning}`)
      .join("; ");
    return (
      `(${sqlText(relation.relation)}, ${sqlText(relation.meaning)}, ` +
      `${relation.columns.length}, ${sqlText(columns)})`
    );
  });
  return (
    "CREATE VIEW IF NOT EXISTS prov_schema AS\n" +
    "SELECT column1 AS relation, column2 AS meaning, column3 AS column_count, " +
    "column4 AS columns\n" +
    `FROM (VALUES\n${rows.join(",\n")}\n)`
  );
}

/**
 * Visibility scratch tables. These are not part of the public contract: they
 * are the per-query basis the executor materializes before running a query.
 */
export function createProvenanceVisibilityTables(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS prov_vis_events (event_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS prov_vis_applications (application_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS prov_vis_commands (command_id TEXT PRIMARY KEY);
  `);
}

export function createProvenanceViews(sql: SqlStorage): void {
  createProvenanceVisibilityTables(sql);
  sql.exec(`
    CREATE VIEW IF NOT EXISTS prov_applications AS
      SELECT app.application_id AS application_id,
             app.work_unit_id AS work_unit_id,
             app.basis_kind AS basis_kind,
             app.basis_id AS basis_id
        FROM gad_work_unit_applications app
        JOIN prov_vis_applications vis ON vis.application_id = app.application_id;

    CREATE VIEW IF NOT EXISTS prov_work_units AS
      SELECT work.work_unit_id AS work_unit_id,
             work.kind AS kind,
             work.resolved_intent_tier AS intent_tier,
             work.resolved_intent_text AS intent_text,
             work.resolver_protocol AS resolver_protocol,
             work.author_context_id AS author_context_id,
             work.command_id AS command_id,
             work.created_at AS created_at,
             work.content_class AS content_class
        FROM gad_work_units work
        JOIN gad_work_unit_applications app ON app.work_unit_id = work.work_unit_id
        JOIN prov_vis_applications vis ON vis.application_id = app.application_id;

    CREATE VIEW IF NOT EXISTS prov_changes AS
      SELECT change.change_id AS change_id,
             change.work_unit_id AS work_unit_id,
             change.kind AS kind,
             result.file_id AS file_id,
             coalesce(result.repository_id, base.repository_id) AS repository_id,
             base.path AS base_path,
             result.path AS result_path,
             change.effect_digest AS effect_digest
        FROM gad_changes change
        JOIN gad_work_unit_applications app ON app.work_unit_id = change.work_unit_id
        JOIN prov_vis_applications vis ON vis.application_id = app.application_id
        LEFT JOIN gad_change_coordinates base
               ON base.change_id = change.change_id AND base.role = 'base'
        LEFT JOIN gad_change_coordinates result
               ON result.change_id = change.change_id AND result.role = 'result';

    CREATE VIEW IF NOT EXISTS prov_applied_changes AS
      SELECT applied.applied_change_id AS applied_change_id,
             applied.application_id AS application_id,
             applied.change_id AS change_id,
             applied.ordinal AS ordinal
        FROM gad_applied_changes applied
        JOIN prov_vis_applications vis ON vis.application_id = applied.application_id;

    CREATE VIEW IF NOT EXISTS prov_content_edges AS
      SELECT edge.child_applied_change_id AS child_applied_change_id,
             edge.parent_applied_change_id AS parent_applied_change_id,
             edge.relation AS relation
        FROM gad_content_edges edge
        JOIN gad_applied_changes child
          ON child.applied_change_id = edge.child_applied_change_id
        JOIN prov_vis_applications vis ON vis.application_id = child.application_id;

    CREATE VIEW IF NOT EXISTS prov_events AS
      SELECT event.event_id AS event_id,
             event.kind AS kind,
             event.message AS message,
             event.created_at AS created_at,
             event.command_id AS command_id
        FROM gad_workspace_events event
        JOIN prov_vis_events vis ON vis.event_id = event.event_id;

    CREATE VIEW IF NOT EXISTS prov_event_parents AS
      SELECT parents.event_id AS event_id,
             parents.parent_event_id AS parent_event_id,
             parents.ordinal AS ordinal
        FROM gad_workspace_event_parents parents
        JOIN prov_vis_events vis ON vis.event_id = parents.event_id;

    CREATE VIEW IF NOT EXISTS prov_event_applications AS
      SELECT link.event_id AS event_id,
             link.application_id AS application_id,
             link.ordinal AS ordinal
        FROM gad_workspace_event_applications link
        JOIN prov_vis_events vis ON vis.event_id = link.event_id;

    CREATE VIEW IF NOT EXISTS prov_decisions AS
      SELECT decision.decision_id AS decision_id,
             decision.work_unit_id AS work_unit_id,
             decision.target_state_kind AS target_state_kind,
             decision.target_state_id AS target_state_id,
             decision.source_event_id AS source_event_id,
             decision.source_delta_id AS source_delta_id,
             decision.created_at AS created_at
        FROM gad_integration_decisions decision
        JOIN gad_work_unit_applications app ON app.work_unit_id = decision.work_unit_id
        JOIN prov_vis_applications vis ON vis.application_id = app.application_id;

    CREATE VIEW IF NOT EXISTS prov_decision_entries AS
      SELECT entry.decision_id AS decision_id,
             entry.coordinate_kind AS coordinate_kind,
             entry.coordinate_id AS coordinate_id,
             entry.resolution AS resolution,
             entry.rationale AS rationale,
             entry.result_change_id AS result_change_id
        FROM gad_merge_decision_entries entry
        JOIN gad_integration_decisions decision ON decision.decision_id = entry.decision_id
        JOIN gad_work_unit_applications app ON app.work_unit_id = decision.work_unit_id
        JOIN prov_vis_applications vis ON vis.application_id = app.application_id;

    CREATE VIEW IF NOT EXISTS prov_counteractions AS
      SELECT counteraction.change_id AS change_id,
             counteraction.counteracted_change_id AS counteracted_change_id
        FROM gad_change_counteractions counteraction
        JOIN gad_changes change ON change.change_id = counteraction.change_id
        JOIN gad_work_unit_applications app ON app.work_unit_id = change.work_unit_id
        JOIN prov_vis_applications vis ON vis.application_id = app.application_id;

    CREATE VIEW IF NOT EXISTS prov_external_deltas AS
      SELECT delta.delta_id AS delta_id,
             delta.work_unit_id AS work_unit_id,
             delta.repository_id AS repository_id,
             delta.repo_path AS repo_path,
             delta.status AS status,
             delta.superseded_by_delta_id AS superseded_by_delta_id,
             delta.created_at AS created_at
        FROM gad_external_deltas delta
        JOIN gad_work_unit_applications app ON app.work_unit_id = delta.work_unit_id
        JOIN prov_vis_applications vis ON vis.application_id = app.application_id;

    CREATE VIEW IF NOT EXISTS prov_commands AS
      SELECT command.command_id AS command_id,
             command.method AS method,
             command.status AS status,
             command.cause_invocation_id AS cause_invocation_id,
             command.cause_log_id AS cause_log_id,
             command.cause_head AS cause_head,
             command.created_at AS created_at
        FROM vcs_command_journal command
        JOIN prov_vis_commands vis ON vis.command_id = command.command_id;

    CREATE VIEW IF NOT EXISTS prov_invocations AS
      SELECT invocation.log_id AS log_id,
             invocation.head AS head,
             invocation.invocation_id AS invocation_id,
             invocation.turn_id AS turn_id,
             invocation.status AS status,
             invocation.terminal_outcome AS terminal_outcome
        FROM trajectory_invocations invocation
        WHERE EXISTS (
          SELECT 1 FROM vcs_command_journal command
            JOIN prov_vis_commands vis ON vis.command_id = command.command_id
           WHERE command.cause_log_id = invocation.log_id
             AND command.cause_head = invocation.head
             AND command.cause_invocation_id = invocation.invocation_id
        );

    CREATE VIEW IF NOT EXISTS prov_turns AS
      SELECT turn.log_id AS log_id,
             turn.head AS head,
             turn.turn_id AS turn_id,
             turn.ordinal AS ordinal,
             turn.trigger_message_id AS trigger_message_id,
             turn.summary AS summary
        FROM trajectory_turns turn
        WHERE EXISTS (
          SELECT 1 FROM prov_invocations invocation
           WHERE invocation.log_id = turn.log_id
             AND invocation.head = turn.head
             AND invocation.turn_id = turn.turn_id
        );

    CREATE VIEW IF NOT EXISTS prov_messages AS
      SELECT message.log_id AS log_id,
             message.head AS head,
             message.message_id AS message_id,
             message.turn_id AS turn_id,
             message.role AS role,
             coalesce(
               json_extract(event.payload_ref_json, '$.senderRef.kind'),
               json_extract(event.actor_json, '$.kind')
             ) AS sender_kind,
             coalesce(
               json_extract(event.payload_ref_json, '$.senderRef.id'),
               json_extract(event.actor_json, '$.id')
             ) AS sender_id,
             json_extract(event.payload_ref_json, '$.sourceMessageId') AS source_message_id,
             substr(
               coalesce(json_extract(event.payload_ref_json, '$.blocks[0].content'), ''),
               1, 400
             ) AS text_excerpt,
             length(
               coalesce(json_extract(event.payload_ref_json, '$.blocks[0].content'), '')
             ) AS text_length
        FROM trajectory_messages message
        LEFT JOIN log_events event
               ON event.log_id = message.log_id
              AND event.head = message.head
              AND event.envelope_id =
                    coalesce(message.completed_event_id, message.started_event_id)
        WHERE EXISTS (
          SELECT 1 FROM prov_turns turn
           WHERE turn.log_id = message.log_id
             AND turn.head = message.head
             AND turn.turn_id = message.turn_id
        );

    CREATE VIEW IF NOT EXISTS prov_files AS
      SELECT file_id, repository_id, path, presence, last_change_id FROM (
        SELECT coord.file_id AS file_id,
               coord.repository_id AS repository_id,
               coord.path AS path,
               CASE WHEN coord.path IS NULL THEN 'deleted' ELSE 'placed' END AS presence,
               change.change_id AS last_change_id,
               ROW_NUMBER() OVER (
                 PARTITION BY coord.file_id
                 ORDER BY work.created_at DESC, applied.applied_change_id DESC
               ) AS placement_rank
          FROM prov_vis_applications vis
          JOIN gad_applied_changes applied ON applied.application_id = vis.application_id
          JOIN gad_changes change ON change.change_id = applied.change_id
          JOIN gad_work_units work ON work.work_unit_id = change.work_unit_id
          JOIN gad_change_coordinates coord
            ON coord.change_id = change.change_id AND coord.role = 'result'
         WHERE coord.file_id IS NOT NULL
      ) WHERE placement_rank = 1;

    CREATE VIEW IF NOT EXISTS prov_schema_version AS SELECT ${PROV_SCHEMA_VERSION} AS version;
  `);
  sql.exec(catalogView());
}

/**
 * The search index is derived, rebuildable, and maintained in the same
 * transactions that write its source rows. FTS5 is unavailable in some
 * SQLite builds, so the plain fallback keeps the contract identical and only
 * the ranking cheaper — the same discipline the memory index already uses.
 */
export function createProvenanceSearchIndex(sql: SqlStorage): "fts" | "plain" {
  try {
    sql.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS prov_search_index USING fts5(
         text, subject_kind UNINDEXED, subject_id UNINDEXED,
         log_id UNINDEXED, head UNINDEXED, label UNINDEXED
       )`,
    );
    return "fts";
  } catch {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS prov_search_index (
         text TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
         log_id TEXT, head TEXT, label TEXT
       )`,
    );
    return "plain";
  }
}

export function provenanceSearchIndexMode(
  sql: SqlStorage,
): "fts" | "plain" | null {
  const row = sql
    .exec(
      `SELECT sql FROM sqlite_master WHERE name = 'prov_search_index' LIMIT 1`,
    )
    .toArray()[0];
  if (!row) return null;
  return /\bCREATE\s+VIRTUAL\s+TABLE\b/iu.test(String(row["sql"] ?? ""))
    ? "fts"
    : "plain";
}

/** The searchable projection joins visibility exactly as the typed views do. */
export function createProvenanceSearchView(sql: SqlStorage): void {
  sql.exec(`
    CREATE VIEW IF NOT EXISTS prov_search AS
      SELECT entry.subject_kind AS subject_kind,
             entry.subject_id AS subject_id,
             entry.log_id AS log_id,
             entry.head AS head,
             entry.label AS label,
             entry.text AS text
        FROM prov_search_index entry
       WHERE (entry.subject_kind = 'work-unit'
                AND entry.subject_id IN (SELECT work_unit_id FROM prov_work_units))
          OR (entry.subject_kind = 'decision'
                AND entry.subject_id IN (SELECT decision_id FROM prov_decisions))
          OR (entry.subject_kind = 'event'
                AND entry.subject_id IN (SELECT event_id FROM prov_events))
          OR (entry.subject_kind = 'external-delta'
                AND entry.subject_id IN (SELECT delta_id FROM prov_external_deltas))
          OR (entry.subject_kind = 'trajectory-message'
                AND EXISTS (
                  SELECT 1 FROM prov_messages message
                   WHERE message.message_id = entry.subject_id
                     AND message.log_id = entry.log_id
                     AND message.head = entry.head
                ))
  `);
}
