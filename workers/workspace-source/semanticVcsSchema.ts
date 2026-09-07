// Builtin semantic-authority implementation.
import type { SqlStorage } from "@vibestudio/durable";
import {
  PROV_VISIBILITY_TABLES,
  createProvenanceSearchIndex,
  createProvenanceSearchView,
  createProvenanceViews,
} from "./provenanceViews.js";

/**
 * Production baseline schema for the semantic workspace machine.
 *
 * A row is either an immutable semantic fact, an immediate graph edge, a
 * mutable context/head pointer, or a durable host-effect command. Derived
 * views never become stored authorities: there are no frontier wrappers,
 * source capabilities, certificates, ancestry closures, application
 * sequences, traversal continuations, packet proofs, or outcomes/realizations.
 * Work units do retain their bounded author context and causal trigger evidence.
 * The `prov_*` views created at the end of this file are the agent-facing
 * contract over these tables; the tables themselves stay private.
 * Version 57 is the first supported
 * production shape; older experimental epochs are rejected intact because no
 * lossless historical translation exists.
 */
export const SEMANTIC_VCS_REQUIRED_TABLES = [
  "vcs_repositories",
  "vcs_files",
  "vcs_file_states",
  "vcs_file_manifests",
  "vcs_repository_states",
  "vcs_workspace_fact_roots",
  "gad_persistent_radix_nodes",
  "gad_persistent_radix_edges",
  "vcs_contexts",
  "vcs_context_projection_policies",
  "vcs_workspace_heads",
  "gad_workspace_events",
  "gad_workspace_event_parents",
  "gad_workspace_event_applications",
  "gad_work_units",
  "gad_external_deltas",
  "gad_work_unit_applications",
  "gad_changes",
  "gad_change_coordinates",
  "gad_change_counteractions",
  "gad_applied_changes",
  "gad_applied_change_predicates",
  "gad_content_edges",
  "gad_content_edge_mappings",
  "gad_integration_decisions",
  "gad_integration_projection",
  "gad_merge_decision_entries",
  "gad_workspace_event_external_sources",
  "gad_decision_source_changes",
  "vcs_command_journal",
  "gad_effect_intents",
  "gad_materialized_repository_states",
  ...PROV_VISIBILITY_TABLES,
] as const;

export function createSemanticVcsSchema(sql: SqlStorage): void {
  sql.exec(`PRAGMA foreign_keys = ON`);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS vcs_repositories (
      repository_id TEXT PRIMARY KEY,
      created_work_unit_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vcs_files (
      file_id TEXT PRIMARY KEY,
      created_repository_id TEXT NOT NULL,
      created_change_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vcs_files_repository
      ON vcs_files(created_repository_id, file_id);

    CREATE TABLE IF NOT EXISTS vcs_file_states (
      file_state_id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      presence TEXT NOT NULL CHECK (presence IN ('placed', 'deleted')),
      repository_id TEXT,
      path TEXT,
      content_hash TEXT,
      mode INTEGER,
      content_kind TEXT CHECK (content_kind IS NULL OR content_kind IN ('text', 'bytes')),
      byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0),
      coordinate_extent INTEGER CHECK (coordinate_extent IS NULL OR coordinate_extent >= 0),
      prior_file_state_id TEXT,
      tombstone_change_id TEXT,
      CHECK (
        (presence = 'placed'
          AND repository_id IS NOT NULL AND path IS NOT NULL
          AND content_hash IS NOT NULL AND mode IS NOT NULL
          AND content_kind IS NOT NULL AND byte_length IS NOT NULL
          AND coordinate_extent IS NOT NULL
          AND (content_kind = 'text' OR coordinate_extent = byte_length)
          AND prior_file_state_id IS NULL AND tombstone_change_id IS NULL)
        OR
        (presence = 'deleted'
          AND repository_id IS NULL AND path IS NULL AND content_hash IS NULL
          AND mode IS NULL AND content_kind IS NULL AND byte_length IS NULL
          AND coordinate_extent IS NULL
          AND prior_file_state_id IS NOT NULL AND tombstone_change_id IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_vcs_file_states_file
      ON vcs_file_states(file_id, file_state_id);
    CREATE INDEX IF NOT EXISTS idx_vcs_file_states_coordinate
      ON vcs_file_states(repository_id, path, file_state_id);
    CREATE INDEX IF NOT EXISTS idx_vcs_file_states_prior
      ON vcs_file_states(prior_file_state_id, file_state_id);

    CREATE TABLE IF NOT EXISTS vcs_file_manifests (
      file_manifest_id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      path_root_node_id TEXT NOT NULL,
      entry_count INTEGER NOT NULL CHECK (entry_count >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_vcs_file_manifests_repository
      ON vcs_file_manifests(repository_id, file_manifest_id);

    CREATE TABLE IF NOT EXISTS vcs_repository_states (
      repository_state_id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      presence TEXT NOT NULL CHECK (presence IN ('present', 'deleted')),
      repo_path TEXT,
      file_manifest_id TEXT,
      prior_repository_state_id TEXT,
      tombstone_change_id TEXT,
      CHECK (
        (presence = 'present' AND repo_path IS NOT NULL
          AND file_manifest_id IS NOT NULL
          AND prior_repository_state_id IS NULL AND tombstone_change_id IS NULL)
        OR
        (presence = 'deleted' AND repo_path IS NULL AND file_manifest_id IS NULL
          AND prior_repository_state_id IS NOT NULL AND tombstone_change_id IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_vcs_repository_states_repository
      ON vcs_repository_states(repository_id, repository_state_id);
    CREATE INDEX IF NOT EXISTS idx_vcs_repository_states_path
      ON vcs_repository_states(repo_path, repository_state_id);
    CREATE INDEX IF NOT EXISTS idx_vcs_repository_states_prior
      ON vcs_repository_states(prior_repository_state_id, repository_state_id);

    CREATE TABLE IF NOT EXISTS vcs_workspace_fact_roots (
      workspace_fact_root_id TEXT PRIMARY KEY,
      root_node_id TEXT NOT NULL,
      entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
      repository_count INTEGER NOT NULL CHECK (repository_count >= 0),
      live_path_count INTEGER NOT NULL CHECK (live_path_count >= 0),
      file_count INTEGER NOT NULL CHECK (file_count >= 0),
      CHECK (entry_count = repository_count + live_path_count + file_count)
    );
    CREATE TABLE IF NOT EXISTS gad_persistent_radix_nodes (
      node_id TEXT PRIMARY KEY,
      index_kind TEXT NOT NULL CHECK (index_kind <> ''),
      route_strategy TEXT NOT NULL CHECK (route_strategy IN ('hashed', 'utf16')),
      node_kind TEXT NOT NULL CHECK (node_kind IN ('empty', 'branch', 'leaf')),
      branch_depth INTEGER CHECK (branch_depth IS NULL OR branch_depth >= 0),
      branch_prefix TEXT,
      CHECK (
        (node_kind = 'branch' AND branch_depth IS NOT NULL AND branch_prefix IS NOT NULL)
        OR (node_kind IN ('empty', 'leaf')
          AND branch_depth IS NULL AND branch_prefix IS NULL)
      )
    );
    CREATE TABLE IF NOT EXISTS gad_persistent_radix_edges (
      node_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      slot INTEGER CHECK (slot IS NULL OR (slot >= 0 AND slot < 16)),
      child_node_id TEXT,
      entry_key TEXT,
      entry_value TEXT,
      PRIMARY KEY (node_id, ordinal),
      CHECK (
        (slot IS NOT NULL AND child_node_id IS NOT NULL
          AND entry_key IS NULL AND entry_value IS NULL)
        OR
        (slot IS NULL AND child_node_id IS NULL
          AND entry_key IS NOT NULL AND entry_value IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_gad_radix_edges_child
      ON gad_persistent_radix_edges(child_node_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_gad_radix_edges_entry
      ON gad_persistent_radix_edges(entry_key, entry_value, node_id);

    -- A context is two pointers, not two materialized frontier objects.
    CREATE TABLE IF NOT EXISTS vcs_contexts (
      context_id TEXT PRIMARY KEY,
      committed_event_id TEXT NOT NULL,
      working_head_application_id TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vcs_contexts_committed
      ON vcs_contexts(committed_event_id, context_id);
    CREATE INDEX IF NOT EXISTS idx_vcs_contexts_working_head
      ON vcs_contexts(working_head_application_id, context_id);

    -- Projection intent is operational state, not semantic history. A
    -- coordinate-only context remains entirely inside the semantic workspace
    -- until an explicit filesystem consumer upgrades it to required.
    CREATE TABLE IF NOT EXISTS vcs_context_projection_policies (
      context_id TEXT PRIMARY KEY,
      projection TEXT NOT NULL CHECK (projection IN ('required', 'deferred')),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vcs_workspace_heads (
      head TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gad_workspace_events (
      event_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('genesis', 'commit', 'integration-commit')),
      result_workspace_fact_root_id TEXT NOT NULL,
      message TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gad_workspace_events_command
      ON gad_workspace_events(command_id, event_id);
    CREATE INDEX IF NOT EXISTS idx_gad_workspace_events_root
      ON gad_workspace_events(result_workspace_fact_root_id, event_id);

    CREATE TABLE IF NOT EXISTS gad_workspace_event_parents (
      event_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      parent_event_id TEXT NOT NULL,
      PRIMARY KEY (event_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_gad_workspace_event_parents_parent
      ON gad_workspace_event_parents(parent_event_id, event_id);

    CREATE TABLE IF NOT EXISTS gad_workspace_event_applications (
      event_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      application_id TEXT NOT NULL,
      PRIMARY KEY (event_id, ordinal),
      UNIQUE (event_id, application_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gad_event_applications_application
      ON gad_workspace_event_applications(application_id, event_id);

    CREATE TABLE IF NOT EXISTS gad_work_units (
      work_unit_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (
        kind IN ('edit', 'file-transfer', 'lifecycle', 'merge', 'revert', 'import',
                 'external-unapplied')
      ),
      intent_summary TEXT,
      author_context_id TEXT NOT NULL,
      trigger_excerpt TEXT,
      trigger_sender_json TEXT,
      external_snapshot_json TEXT,
      content_class TEXT NOT NULL CHECK (content_class IN ('internal', 'external')),
      external_lineage_json TEXT NOT NULL CHECK (
        json_valid(external_lineage_json) = 1
        AND json_type(external_lineage_json) IS 'array'
        AND (content_class = 'external' OR json_array_length(external_lineage_json) = 0)
      ),
      normalization_protocol TEXT NOT NULL,
      -- Frozen output of the one intent loader over evidence that is itself
      -- immutable once the row exists. This is derived-but-frozen input for
      -- SQL carriers (views cannot call the loader), not a cache that can go
      -- stale under it; a resolver protocol change ships a recompute that runs
      -- through the same loader and bumps resolver_protocol.
      resolved_intent_text TEXT,
      resolved_intent_tier TEXT CHECK (
        resolved_intent_tier IS NULL
        OR resolved_intent_tier IN ('stated', 'trigger', 'mechanical')
      ),
      resolver_protocol TEXT,
      created_at TEXT NOT NULL,
      -- Trigger evidence is well-formed or absent. It is deliberately *not*
      -- conditioned on intent_summary: which rung the ladder resolves to is the
      -- resolver's decision, and making the schema enforce "no statement when
      -- the author wrote a summary" destroyed the requester's own words for
      -- every work unit an author bothered to describe.
      CHECK (
        (trigger_excerpt IS NULL AND trigger_sender_json IS NULL)
        OR (trigger_excerpt IS NOT NULL
          AND trigger_sender_json IS NOT NULL
          AND json_valid(trigger_sender_json) = 1)
      ),
      CHECK (
        (kind = 'import'
          AND external_snapshot_json IS NOT NULL
          AND json_valid(external_snapshot_json) = 1
          AND json_type(external_snapshot_json, '$.targetRepositoryIds') IS 'array'
          AND json_array_length(external_snapshot_json, '$.targetRepositoryIds') >= 1)
        OR (kind <> 'import' AND external_snapshot_json IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_gad_work_units_command
      ON gad_work_units(command_id, work_unit_id);

    CREATE TABLE IF NOT EXISTS gad_external_deltas (
      delta_id TEXT PRIMARY KEY,
      work_unit_id TEXT NOT NULL UNIQUE,
      owner_context_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      target_state_kind TEXT NOT NULL CHECK (target_state_kind IN ('event', 'application')),
      target_state_id TEXT NOT NULL,
      old_source_json TEXT NOT NULL CHECK (json_valid(old_source_json) = 1),
      new_source_json TEXT NOT NULL CHECK (json_valid(new_source_json) = 1),
      old_snapshot TEXT NOT NULL,
      new_snapshot TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'finalized')),
      superseded_by_delta_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gad_external_deltas_repository
      ON gad_external_deltas(repository_id, status, delta_id);

    -- A mutation authors one work unit and realizes it once on one exact basis.
    CREATE TABLE IF NOT EXISTS gad_work_unit_applications (
      application_id TEXT PRIMARY KEY,
      work_unit_id TEXT NOT NULL UNIQUE,
      basis_kind TEXT NOT NULL CHECK (basis_kind IN ('event', 'application')),
      basis_id TEXT NOT NULL,
      result_workspace_fact_root_id TEXT NOT NULL,
      semantic_protocol TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gad_applications_basis
      ON gad_work_unit_applications(basis_kind, basis_id, application_id);
    CREATE INDEX IF NOT EXISTS idx_gad_applications_root
      ON gad_work_unit_applications(result_workspace_fact_root_id, application_id);

    -- A Change is the expressive authored record (text, binary, create,
    -- delete, mode, move, copy, repository lifecycle, and exact content replacement).
    CREATE TABLE IF NOT EXISTS gad_changes (
      change_id TEXT PRIMARY KEY,
      work_unit_id TEXT NOT NULL,
      operation INTEGER NOT NULL CHECK (operation >= 0),
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      kind TEXT NOT NULL,
      source_json TEXT,
      base_json TEXT,
      result_json TEXT,
      payload_json TEXT NOT NULL,
      effect_digest TEXT NOT NULL,
      CHECK (
        (kind = 'file-copy'
          AND source_json IS NOT NULL
          AND json_valid(source_json) = 1
          AND json_extract(source_json, '$.kind') = 'file'
          AND json_type(source_json, '$.state') = 'object'
          AND json_extract(source_json, '$.state.kind') IN ('event', 'application')
          AND json_extract(source_json, '$.repositoryId') <> ''
          AND json_extract(source_json, '$.fileId') <> ''
          AND json_extract(source_json, '$.path') <> ''
          AND json_extract(source_json, '$.contentHash') <> '')
        OR (kind <> 'file-copy' AND source_json IS NULL)
      ),
      UNIQUE (work_unit_id, operation, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_gad_changes_work_unit
      ON gad_changes(work_unit_id, change_id);
    CREATE INDEX IF NOT EXISTS idx_gad_changes_authored_source
      ON gad_changes(
        json_extract(source_json, '$.fileId'),
        json_extract(source_json, '$.state.kind'),
        coalesce(
          json_extract(source_json, '$.state.eventId'),
          json_extract(source_json, '$.state.applicationId')
        ),
        change_id
      ) WHERE source_json IS NOT NULL;

    CREATE TABLE IF NOT EXISTS gad_change_coordinates (
      change_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('base', 'result')),
      repository_id TEXT,
      repo_path TEXT,
      file_id TEXT,
      path TEXT,
      PRIMARY KEY (change_id, role)
    );
    CREATE INDEX IF NOT EXISTS idx_gad_change_coordinates_file
      ON gad_change_coordinates(file_id, change_id, role);
    CREATE INDEX IF NOT EXISTS idx_gad_change_coordinates_repository
      ON gad_change_coordinates(repository_id, change_id, role);

    -- Queryable projection of the expressive counteraction list in payload_json.
    -- This is an immediate edge index, not a stored transitive closure.
    CREATE TABLE IF NOT EXISTS gad_change_counteractions (
      change_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      counteracted_change_id TEXT NOT NULL,
      PRIMARY KEY (change_id, ordinal),
      UNIQUE (change_id, counteracted_change_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gad_change_counteractions_reverse
      ON gad_change_counteractions(counteracted_change_id, change_id);

    CREATE TABLE IF NOT EXISTS gad_applied_changes (
      applied_change_id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      change_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      applied_base_json TEXT,
      applied_result_json TEXT,
      UNIQUE (application_id, ordinal),
      UNIQUE (application_id, change_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gad_applied_changes_change
      ON gad_applied_changes(change_id, application_id);

    CREATE TABLE IF NOT EXISTS gad_applied_change_predicates (
      applied_change_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      predicate_json TEXT NOT NULL,
      predicate_digest TEXT NOT NULL,
      PRIMARY KEY (applied_change_id, ordinal),
      UNIQUE (applied_change_id, predicate_digest)
    );
    CREATE INDEX IF NOT EXISTS idx_gad_applied_change_predicates_digest
      ON gad_applied_change_predicates(predicate_digest, applied_change_id);

    -- Applied changes form the one transitive content-coordinate graph used by
    -- preservation, copies, integration, history, and blame.
    CREATE TABLE IF NOT EXISTS gad_content_edges (
      content_edge_id TEXT PRIMARY KEY,
      child_applied_change_id TEXT NOT NULL,
      parent_applied_change_id TEXT NOT NULL,
      relation TEXT NOT NULL CHECK (relation IN ('preserves', 'copies', 'incorporates')),
      UNIQUE (child_applied_change_id, parent_applied_change_id, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_gad_content_edges_parent
      ON gad_content_edges(parent_applied_change_id, child_applied_change_id);

    CREATE TABLE IF NOT EXISTS gad_content_edge_mappings (
      content_edge_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      child_content_hash TEXT NOT NULL,
      coordinate_kind TEXT NOT NULL CHECK (coordinate_kind IN ('utf16', 'byte')),
      child_start INTEGER NOT NULL CHECK (child_start >= 0),
      child_end INTEGER NOT NULL CHECK (child_end >= child_start),
      parent_content_hash TEXT NOT NULL,
      parent_start INTEGER NOT NULL CHECK (parent_start >= 0),
      parent_end INTEGER NOT NULL CHECK (parent_end >= parent_start),
      digest TEXT NOT NULL,
      PRIMARY KEY (content_edge_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_gad_content_edge_mappings_parent
      ON gad_content_edge_mappings(
        parent_content_hash, parent_start, parent_end, content_edge_id
      );

    -- A merge mutation owns one decision. Coordinate entries are the durable
    -- state-anchored accounting ledger; source changes remain normalized edges.
    CREATE TABLE IF NOT EXISTS gad_integration_decisions (
      decision_id TEXT PRIMARY KEY,
      target_state_kind TEXT NOT NULL CHECK (target_state_kind IN ('event', 'application')),
      target_state_id TEXT NOT NULL,
      source_event_id TEXT,
      source_delta_id TEXT,
      work_unit_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (work_unit_id),
      CHECK ((source_event_id IS NULL) <> (source_delta_id IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_gad_decisions_source
      ON gad_integration_decisions(source_event_id, decision_id);
    CREATE INDEX IF NOT EXISTS idx_gad_decisions_delta
      ON gad_integration_decisions(source_delta_id, decision_id);
    CREATE INDEX IF NOT EXISTS idx_gad_decisions_target
      ON gad_integration_decisions(target_state_kind, target_state_id, decision_id);
    CREATE TABLE IF NOT EXISTS gad_integration_projection (
      context_id TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('event', 'external-delta')),
      source_id TEXT NOT NULL,
      remaining_coordinate_count INTEGER NOT NULL CHECK (remaining_coordinate_count >= 0),
      mergeable_coordinate_count INTEGER NOT NULL CHECK (mergeable_coordinate_count >= 0),
      conflict_coordinate_count INTEGER NOT NULL CHECK (conflict_coordinate_count >= 0),
      concluded INTEGER NOT NULL CHECK (concluded IN (0, 1)),
      as_of_working_head_kind TEXT NOT NULL CHECK (as_of_working_head_kind IN ('event', 'application')),
      as_of_working_head_id TEXT NOT NULL,
      PRIMARY KEY (context_id, source_kind, source_id)
    );
    CREATE TABLE IF NOT EXISTS gad_merge_decision_entries (
      decision_id TEXT NOT NULL,
      coordinate_kind TEXT NOT NULL CHECK (coordinate_kind IN ('file', 'repository')),
      coordinate_id TEXT NOT NULL,
      resolution TEXT NOT NULL CHECK (
        resolution IN ('adopt', 'convergent', 'composed', 'ours', 'current')
      ),
      result_change_id TEXT,
      rationale TEXT,
      PRIMARY KEY (decision_id, coordinate_kind, coordinate_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gad_merge_entries_coordinate
      ON gad_merge_decision_entries(coordinate_kind, coordinate_id, decision_id);
    CREATE TABLE IF NOT EXISTS gad_decision_source_changes (
      decision_id TEXT NOT NULL,
      coordinate_kind TEXT NOT NULL CHECK (coordinate_kind IN ('file', 'repository')),
      coordinate_id TEXT NOT NULL,
      change_id TEXT NOT NULL,
      PRIMARY KEY (decision_id, coordinate_kind, coordinate_id, change_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gad_decision_source_changes_change
      ON gad_decision_source_changes(change_id, decision_id);

    CREATE TABLE IF NOT EXISTS gad_workspace_event_external_sources (
      event_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      delta_id TEXT NOT NULL,
      PRIMARY KEY (event_id, ordinal),
      UNIQUE (event_id, delta_id)
    );

    -- The journal owns idempotency and one optional exact tool-invocation edge.
    -- Direct host commands terminate here; caller/user/request snapshots are
    -- authorization inputs at service ingress, not semantic history.
    CREATE TABLE IF NOT EXISTS vcs_command_journal (
      command_id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('context', 'workspace')),
      scope_id TEXT NOT NULL,
      method TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      cause_log_id TEXT,
      cause_head TEXT,
      cause_invocation_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'effect-pending', 'complete')),
      result_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      CHECK (
        (cause_invocation_id IS NULL AND cause_log_id IS NULL AND cause_head IS NULL)
        OR
        (cause_invocation_id IS NOT NULL AND cause_log_id IS NOT NULL AND cause_head IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_vcs_command_journal_cause
      ON vcs_command_journal(cause_log_id, cause_head, cause_invocation_id, command_id);

    -- Host effects are commands with receipts, not callbacks from the
    -- semantic state machine. The server drains and acknowledges these rows.
    CREATE TABLE IF NOT EXISTS gad_effect_intents (
      effect_id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('context', 'workspace')),
      scope_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('observe-content', 'materialize-context', 'publish-main')),
      payload_json TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'applied')),
      receipt_json TEXT,
      receipt_digest TEXT,
      created_at TEXT NOT NULL,
      applied_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gad_effect_intents_pending
      ON gad_effect_intents(status, created_at, effect_id);
    CREATE INDEX IF NOT EXISTS idx_gad_effect_intents_command
      ON gad_effect_intents(command_id, effect_id);

    -- Exact host observations indexed by semantic workspace state and stable
    -- repository identity. A file manifest authenticates placement only; it is
    -- deliberately not a content-state key because in-place edits retain the
    -- same path-to-file identity manifest.
    CREATE TABLE IF NOT EXISTS gad_materialized_repository_states (
      workspace_fact_root_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      content_root TEXT NOT NULL CHECK (
        length(content_root) = 70
        AND substr(content_root, 1, 6) = 'state:'
        AND substr(content_root, 7) NOT GLOB '*[^0-9a-f]*'
      ),
      receipt_effect_id TEXT NOT NULL,
      PRIMARY KEY (workspace_fact_root_id, repository_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gad_materialized_repository_states_repository
      ON gad_materialized_repository_states(repository_id, workspace_fact_root_id);
    CREATE INDEX IF NOT EXISTS idx_gad_materialized_repository_states_effect
      ON gad_materialized_repository_states(receipt_effect_id, workspace_fact_root_id, repository_id);
  `);
  // The agent-facing relational contract is derived from the tables above and
  // is created last so the views read as a projection of a complete schema.
  createProvenanceRelationalContract(sql);
}

/** Views, the caller-scoped visibility basis, and the derived search index. */
export function createProvenanceRelationalContract(sql: SqlStorage): void {
  createProvenanceViews(sql);
  createProvenanceSearchIndex(sql);
  createProvenanceSearchView(sql);
}

/**
 * The trajectory mirror the semantic layer joins against.
 *
 * These tables live in the same store as the semantic tables precisely so that
 * a walk can cross from an artifact to the statement that caused it in one
 * query. That makes them part of the semantic schema's contract, not incidental
 * workspace storage — so they are created here, once, instead of being
 * hand-copied into every fixture that needs a causal chain to exist.
 */
export function createTrajectoryMirrorSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS trajectory_turns (
      log_id TEXT NOT NULL,
      head TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      opened_at TEXT,
      closed_at TEXT,
      summary TEXT,
      -- §6.3 turn-decay basis: the turn's per-branch ordinal (count of prior
      -- turns on this (log_id, head) at turn.opened). Wall-clock is display-only.
      ordinal INTEGER,
      -- Exact private trajectory message that triggered this turn. Actor and
      -- intent are derived by walking to that message; they are never copied
      -- onto the turn as an authorship snapshot. Nullable for non-message
      -- turns such as scheduled or heartbeat work.
      trigger_message_id TEXT,
      PRIMARY KEY (log_id, head, turn_id)
    )
  `);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_trajectory_turns_trigger_message
     ON trajectory_turns(log_id, head, trigger_message_id)`
  );
  sql.exec(`
    CREATE TABLE IF NOT EXISTS trajectory_messages (
      log_id TEXT NOT NULL,
      head TEXT NOT NULL,
      message_id TEXT NOT NULL,
      turn_id TEXT,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      started_event_id TEXT,
      completed_event_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (log_id, head, message_id)
    )
  `);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_trajectory_messages_turn
     ON trajectory_messages(log_id, head, turn_id, message_id)`
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_trajectory_messages_started
     ON trajectory_messages(started_event_id, log_id, head, message_id)`
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_trajectory_messages_completed
     ON trajectory_messages(completed_event_id, log_id, head, message_id)`
  );
  sql.exec(`
    CREATE TABLE IF NOT EXISTS trajectory_message_blocks (
      log_id TEXT NOT NULL,
      head TEXT NOT NULL,
      block_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      block_index INTEGER NOT NULL,
      block_type TEXT NOT NULL,
      invocation_id TEXT,
      PRIMARY KEY (log_id, head, block_id)
    )
  `);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_trajectory_message_blocks_message
     ON trajectory_message_blocks(log_id, head, message_id, block_index, block_id)`
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_trajectory_message_blocks_invocation
     ON trajectory_message_blocks(invocation_id, log_id, head, message_id)`
  );
  sql.exec(`
    CREATE TABLE IF NOT EXISTS trajectory_invocations (
      log_id TEXT NOT NULL,
      head TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      turn_id TEXT,
      transport_call_id TEXT,
      kind TEXT,
      status TEXT NOT NULL,
      terminal_outcome TEXT,
      terminal_reason_code TEXT,
      request_ref_json TEXT,
      result_ref_json TEXT,
      started_event_id TEXT,
      completed_event_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (log_id, head, invocation_id)
    )
  `);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_trajectory_invocations_transport ON trajectory_invocations(transport_call_id)`
  );
    // Invocation→turn traversal is shared by semantic provenance inspectors.
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_trajectory_invocations_scoped_turn
     ON trajectory_invocations(log_id, head, turn_id, invocation_id)`
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_trajectory_invocations_identity
     ON trajectory_invocations(invocation_id, log_id, head)`
  );
}
