/** Durable supervisor index for retained subagent execution results. */

import type { SqlStorage } from "@workspace/runtime/worker/durable-base";
import { assertExactSqlTableSchema } from "@workspace/runtime/worker/sql-table-schema";

export type SubagentRunStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "abandoned";

export type SubagentAgentKind = string;

export interface SubagentRunRow {
  runId: string;
  taskChannelId: string;
  parentContextId: string | null;
  childContextId: string;
  childEntityId: string;
  childParticipantId: string | null;
  parentChannelId: string;
  mode: "fresh" | "fork";
  label: string;
  depth: number;
  status: SubagentRunStatus;
  sourceEventId: string | null;
  semanticIntegrationSnapshot: Record<string, unknown> | null;
  startedAt: number;
  lastActivityAt: number;
  agentKind: SubagentAgentKind;
  launchConfig: Record<string, unknown> | null;
  externalSessionEntityId: string | null;
  externalGenerationId: string | null;
}

export type SubagentRunReferenceResolution =
  | { kind: "exact" | "abbreviated"; run: SubagentRunRow }
  | { kind: "ambiguous" }
  | null;

const MIN_ABBREVIATED_RUN_ID_LENGTH = 16;
const SUBAGENT_RUN_STATUSES = [
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
  "abandoned",
] as const satisfies readonly SubagentRunStatus[];

interface SubagentRunSqlRow {
  run_id: string;
  task_channel_id: string;
  parent_context_id?: string | null;
  child_context_id: string;
  child_entity_id: string;
  child_participant_id: string | null;
  parent_channel_id: string;
  mode: string;
  label: string;
  depth: number;
  status: string;
  source_event_id: string | null;
  semantic_integration_json: string | null;
  started_at: number;
  last_activity_at: number;
  agent_kind: string;
  launch_config_json: string | null;
  external_session_entity_id: string | null;
  external_generation_id: string | null;
}

function exactEnum<const Value extends string>(
  field: string,
  value: unknown,
  allowed: readonly Value[]
): Value {
  if (typeof value === "string" && allowed.includes(value as Value)) return value as Value;
  throw new Error(`Invalid subagent_runs.${field}: ${JSON.stringify(value)}`);
}

function parseRecord(field: string, value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`Invalid subagent_runs.${field}: ${JSON.stringify(value)}`);
  }
}

function toRow(row: SubagentRunSqlRow): SubagentRunRow {
  if (typeof row.agent_kind !== "string" || row.agent_kind.trim().length === 0) {
    throw new Error(`Invalid subagent_runs.agent_kind: ${JSON.stringify(row.agent_kind)}`);
  }
  return {
    runId: row.run_id,
    taskChannelId: row.task_channel_id,
    parentContextId: row.parent_context_id ?? null,
    childContextId: row.child_context_id,
    childEntityId: row.child_entity_id,
    childParticipantId: row.child_participant_id ?? null,
    parentChannelId: row.parent_channel_id,
    mode: exactEnum("mode", row.mode, ["fresh", "fork"] as const),
    label: row.label,
    depth: Number(row.depth),
    status: exactEnum("status", row.status, SUBAGENT_RUN_STATUSES),
    sourceEventId: row.source_event_id ?? null,
    semanticIntegrationSnapshot: parseRecord(
      "semantic_integration_json",
      row.semantic_integration_json
    ),
    startedAt: Number(row.started_at),
    lastActivityAt: Number(row.last_activity_at),
    agentKind: row.agent_kind,
    launchConfig: parseRecord("launch_config_json", row.launch_config_json),
    externalSessionEntityId: row.external_session_entity_id ?? null,
    externalGenerationId: row.external_generation_id ?? null,
  };
}

function normalizeAbbreviatedReference(reference: string): string {
  const trimmed = reference.trim();
  if (trimmed.endsWith("...")) return trimmed.slice(0, -3).trimEnd();
  if (trimmed.endsWith("…")) return trimmed.slice(0, -1).trimEnd();
  return trimmed;
}

function boundedEditDistance(left: string, right: string, limit: number): number | null {
  if (Math.abs(left.length - right.length) > limit) return null;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const distance = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + substitutionCost
      );
      current.push(distance);
      rowMinimum = Math.min(rowMinimum, distance);
    }
    if (rowMinimum > limit) return null;
    previous = current;
  }
  const distance = previous[right.length]!;
  return distance <= limit ? distance : null;
}

function abbreviatedReferenceScore(reference: string, runId: string): number | null {
  const maxDistance = reference.length >= MIN_ABBREVIATED_RUN_ID_LENGTH ? 2 : 1;
  let best: number | null = null;
  const shortest = Math.max(1, reference.length - maxDistance);
  const longest = Math.min(runId.length, reference.length + maxDistance);
  for (let length = shortest; length <= longest; length += 1) {
    const distance = boundedEditDistance(reference, runId.slice(0, length), maxDistance);
    if (distance !== null && (best === null || distance < best)) best = distance;
  }
  return best;
}

export class SubagentRunStore {
  constructor(private readonly sql: SqlStorage) {}

  static createTables(sql: SqlStorage): void {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS subagent_runs (
        run_id TEXT PRIMARY KEY,
        task_channel_id TEXT NOT NULL,
        parent_context_id TEXT,
        child_context_id TEXT NOT NULL,
        child_entity_id TEXT NOT NULL,
        child_participant_id TEXT,
        parent_channel_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        label TEXT NOT NULL,
        depth INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'starting', 'running', 'completed', 'failed', 'cancelled', 'abandoned'
        )),
        started_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        agent_kind TEXT NOT NULL,
        launch_config_json TEXT,
        external_session_entity_id TEXT,
        external_generation_id TEXT,
        source_event_id TEXT,
        semantic_integration_json TEXT
      )
    `);
    assertExactSqlTableSchema(sql, {
      table: "subagent_runs",
      columns: [
        ["run_id", "TEXT", false],
        ["task_channel_id", "TEXT", true],
        ["parent_context_id", "TEXT", false],
        ["child_context_id", "TEXT", true],
        ["child_entity_id", "TEXT", true],
        ["child_participant_id", "TEXT", false],
        ["parent_channel_id", "TEXT", true],
        ["mode", "TEXT", true],
        ["label", "TEXT", true],
        ["depth", "INTEGER", true],
        ["status", "TEXT", true],
        ["started_at", "INTEGER", true],
        ["last_activity_at", "INTEGER", true],
        ["agent_kind", "TEXT", true],
        ["launch_config_json", "TEXT", false],
        ["external_session_entity_id", "TEXT", false],
        ["external_generation_id", "TEXT", false],
        ["source_event_id", "TEXT", false],
        ["semantic_integration_json", "TEXT", false],
      ],
      primaryKey: ["run_id"],
    });
  }

  createTables(): void {
    SubagentRunStore.createTables(this.sql);
  }

  insert(row: SubagentRunRow): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO subagent_runs
         (run_id, task_channel_id, parent_context_id, child_context_id, child_entity_id,
          child_participant_id, parent_channel_id, mode, label, depth, status,
          source_event_id, semantic_integration_json, started_at,
          last_activity_at, agent_kind, launch_config_json, external_session_entity_id,
          external_generation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.runId,
      row.taskChannelId,
      row.parentContextId,
      row.childContextId,
      row.childEntityId,
      row.childParticipantId,
      row.parentChannelId,
      row.mode,
      row.label,
      row.depth,
      row.status,
      row.sourceEventId,
      row.semanticIntegrationSnapshot ? JSON.stringify(row.semanticIntegrationSnapshot) : null,
      row.startedAt,
      row.lastActivityAt,
      row.agentKind,
      row.launchConfig ? JSON.stringify(row.launchConfig) : null,
      row.externalSessionEntityId,
      row.externalGenerationId
    );
  }

  get(runId: string): SubagentRunRow | null {
    const row = this.sql.exec(`SELECT * FROM subagent_runs WHERE run_id = ?`, runId).toArray()[0];
    return row ? toRow(row as unknown as SubagentRunSqlRow) : null;
  }

  getBySourceEvent(sourceEventId: string): SubagentRunRow | null {
    return this.listBySourceEvent(sourceEventId)[0] ?? null;
  }

  listBySourceEvent(sourceEventId: string): SubagentRunRow[] {
    return this.sql
      .exec(
        `SELECT * FROM subagent_runs WHERE source_event_id = ? ORDER BY started_at, run_id`,
        sourceEventId
      )
      .toArray()
      .map((row) => toRow(row as unknown as SubagentRunSqlRow));
  }

  getByTaskChannel(taskChannelId: string): SubagentRunRow | null {
    const row = this.sql
      .exec(`SELECT * FROM subagent_runs WHERE task_channel_id = ?`, taskChannelId)
      .toArray()[0];
    return row ? toRow(row as unknown as SubagentRunSqlRow) : null;
  }

  listAll(): SubagentRunRow[] {
    return (this.sql.exec(`SELECT * FROM subagent_runs`).toArray() as unknown as SubagentRunSqlRow[]).map(
      toRow
    );
  }

  listByStatus(status: SubagentRunStatus): SubagentRunRow[] {
    return (
      this.sql
        .exec(`SELECT * FROM subagent_runs WHERE status = ?`, status)
        .toArray() as unknown as SubagentRunSqlRow[]
    ).map(toRow);
  }

  listLive(): SubagentRunRow[] {
    return (
      this.sql
        .exec(`SELECT * FROM subagent_runs WHERE status IN ('starting', 'running')`)
        .toArray() as unknown as SubagentRunSqlRow[]
    ).map(toRow);
  }

  countLive(): number {
    const row = this.sql
      .exec(`SELECT COUNT(*) AS cnt FROM subagent_runs WHERE status IN ('starting', 'running')`)
      .toArray()[0];
    return Number(row?.["cnt"] ?? 0);
  }

  resolveReference(reference: string, parentChannelId?: string): SubagentRunReferenceResolution {
    const exact = this.get(reference);
    if (exact) return { kind: "exact", run: exact };
    const abbreviated = normalizeAbbreviatedReference(reference);
    if (abbreviated.length < MIN_ABBREVIATED_RUN_ID_LENGTH) return null;
    const candidates = this.listAll()
      .filter((run) => !parentChannelId || run.parentChannelId === parentChannelId)
      .map((run) => ({ run, score: abbreviatedReferenceScore(abbreviated, run.runId) }))
      .filter(
        (candidate): candidate is { run: SubagentRunRow; score: number } => candidate.score !== null
      );
    if (candidates.length === 0) return null;
    const bestScore = Math.min(...candidates.map(({ score }) => score));
    const best = candidates.filter(({ score }) => score === bestScore);
    return best.length === 1 ? { kind: "abbreviated", run: best[0]!.run } : { kind: "ambiguous" };
  }

  setStatus(runId: string, status: SubagentRunStatus): void {
    this.sql.exec(`UPDATE subagent_runs SET status = ? WHERE run_id = ?`, status, runId);
  }

  setSourceEventId(runId: string, sourceEventId: string): void {
    this.sql.exec(`UPDATE subagent_runs SET source_event_id = ? WHERE run_id = ?`, sourceEventId, runId);
  }

  setSemanticIntegrationSnapshot(runId: string, value: Record<string, unknown>): void {
    this.sql.exec(
      `UPDATE subagent_runs SET semantic_integration_json = ? WHERE run_id = ?`,
      JSON.stringify(value),
      runId
    );
  }

  setChildParticipantId(runId: string, participantId: string | null): void {
    this.sql.exec(`UPDATE subagent_runs SET child_participant_id = ? WHERE run_id = ?`, participantId, runId);
  }

  setLaunchConfig(runId: string, launchConfig: Record<string, unknown> | null): void {
    this.sql.exec(
      `UPDATE subagent_runs SET launch_config_json = ? WHERE run_id = ?`,
      launchConfig ? JSON.stringify(launchConfig) : null,
      runId
    );
  }

  setExternalSession(runId: string, session: { entityId: string; generationId: string } | null): void {
    this.sql.exec(
      `UPDATE subagent_runs SET external_session_entity_id = ?, external_generation_id = ? WHERE run_id = ?`,
      session?.entityId ?? null,
      session?.generationId ?? null,
      runId
    );
  }

  setChildEntityId(runId: string, childEntityId: string): void {
    this.sql.exec(`UPDATE subagent_runs SET child_entity_id = ? WHERE run_id = ?`, childEntityId, runId);
  }

  setParentContextId(runId: string, contextId: string): void {
    this.sql.exec(`UPDATE subagent_runs SET parent_context_id = ? WHERE run_id = ?`, contextId, runId);
  }

  touch(runId: string, at: number): void {
    this.sql.exec(`UPDATE subagent_runs SET last_activity_at = ? WHERE run_id = ?`, at, runId);
  }

  delete(runId: string): void {
    this.sql.exec(`DELETE FROM subagent_runs WHERE run_id = ?`, runId);
  }
}
