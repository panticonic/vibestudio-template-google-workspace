# Querying provenance

The semantic record is a relational database, and for set-shaped questions you
should treat it as one. `provenance({ query: "SELECT …" })` runs one read-only
statement inside the workspace authority against a versioned set of `prov_*`
views. The canonical tables stay private; the views are the contract.

## Discover the contract instead of memorizing it

The catalog is self-describing. This is the first query to run, and the only
schema fact worth remembering:

`prov_schema` is one row per relation, so the whole contract fits in one page —
read it, then read the `columns` cell of whichever relation you need.

```ts
provenance({ query: "SELECT relation, meaning, column_count FROM prov_schema" });
provenance({
  query: "SELECT columns FROM prov_schema WHERE relation = 'prov_decision_entries'",
});
provenance({ query: "SELECT version FROM prov_schema_version" });
```

Prefer `WHERE relation = '…'` over `LIKE`: it is exact, and the deployed engine
enforces pattern limits the development engine does not.

Relations, in one line each: `prov_work_units` (intent tier and text, persisted
from the one resolver), `prov_changes`, `prov_applied_changes`,
`prov_content_edges`, `prov_applications`, `prov_events`, `prov_event_parents`,
`prov_event_applications`, `prov_decisions`, `prov_decision_entries`,
`prov_counteractions`, `prov_external_deltas`, `prov_commands`,
`prov_invocations`, `prov_turns`, `prov_messages`, `prov_files`, `prov_search`.

## Rules the executor enforces

- one statement, one `SELECT` (a non-recursive `WITH` is fine);
- `prov_*` relations only — naming a canonical table is refused with the term
  quoted;
- no recursive CTEs: multi-hop traversal is what `walk` is for, with
  server-owned bounds;
- a plan gate refuses full scans of large relations and cartesian joins *before*
  execution, and a streamed abort stops a query that reads past the scan budget
  and returns the partial rows with a typed refusal;
- text columns are bounded excerpts. Full content stays behind `read`;
- every row you can reach through a query, you could have reached by a legal
  walk — the visibility basis is the caller's, not the query's.

## Refs, not identities

Identity columns render as compact `@ref`s, and a `@ref` is a legal *value* in
query text — trusted code binds it to the exact identity before execution:

```ts
provenance({
  query: `SELECT change_id, result_path FROM prov_changes WHERE work_unit_id = '@r3-9c1a'`,
});
```

Joins between `prov_` relations need no literal identity at all.

## Worked examples

**Q3 — the cohort as a set.** Everything one command touched, by coordinate:

```sql
SELECT change.result_path AS path, count(*) AS changes
  FROM prov_work_units work
  JOIN prov_changes change ON change.work_unit_id = work.work_unit_id
 WHERE work.command_id = '@r5-2a1f'
 GROUP BY change.result_path
 ORDER BY changes DESC
```

**Q4 — how two subjects are related.** The join that answers "did the same
command touch both of these files":

```sql
SELECT work.work_unit_id, work.intent_tier, work.intent_text
  FROM prov_changes mine
  JOIN prov_changes theirs ON theirs.work_unit_id = mine.work_unit_id
  JOIN prov_work_units work ON work.work_unit_id = mine.work_unit_id
 WHERE mine.result_path = 'packages/api/src/retry.ts'
   AND theirs.result_path = 'packages/api/src/deploy.ts'
```

If that returns nothing, cause-walk both subjects and intersect the refs before
concluding they are unrelated.

**Q5 — purpose drift at one coordinate.** What this file has been *for*, over
time, tier-labeled:

```sql
SELECT work.created_at, work.intent_tier, work.intent_text
  FROM prov_changes change
  JOIN prov_work_units work ON work.work_unit_id = change.work_unit_id
 WHERE change.result_path = 'packages/api/src/retry.ts'
 ORDER BY work.created_at DESC
```

**Q6 — rejections as a set.** Which stated intents undid other work:

```sql
SELECT work.intent_text, count(*) AS undone
  FROM prov_counteractions counteraction
  JOIN prov_changes change ON change.change_id = counteraction.change_id
  JOIN prov_work_units work ON work.work_unit_id = change.work_unit_id
 WHERE work.intent_tier = 'stated'
 GROUP BY work.intent_text
 ORDER BY undone DESC
```

**Q7 — content entry composed with a filter.** Decisions whose rationale
mentions retries:

```sql
SELECT hit.subject_id, entry.resolution, entry.rationale
  FROM prov_search hit
  JOIN prov_decision_entries entry ON entry.decision_id = hit.subject_id
 WHERE hit.subject_kind = 'decision' AND hit.text LIKE '%retry%'
```

For a ranked phrase search without SQL, use `provenance({ target: "search: …" })`
and walk from the ref it hands back.

## When not to query

If the question is a chain rather than a set, use a walk: it is one call, it
renders as a spine instead of a table, and its bounds are the server's problem
rather than yours.
