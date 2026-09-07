// Builtin semantic-authority implementation.
import type { SqlResult, SqlStorage } from "@vibestudio/durable";

// Durable Objects SQLite accepts at most 100 bound parameters per statement.
// Keep the batching primitive at that deployment boundary so every caller gets
// the same behavior in workerd and in-memory tests.
export const DURABLE_OBJECT_SQL_MAX_BOUND_PARAMETERS = 100;

// Keep each JSON rowset comfortably below SQLite's value-size limits while
// still turning snapshot-scale persistence into a handful of statements. The
// row itself is never split, so unusually large canonical JSON fields retain
// their exact value in one insertion.
const JSON_ROWSET_TARGET_CHARS = 512 * 1024;

function encodedRowsets(
  columnsPerRow: number,
  rows: readonly (readonly unknown[])[]
): string[] {
  const rowsets: string[] = [];
  let encodedRows: string[] = [];
  let encodedChars = 2;
  for (const row of rows) {
    if (row.length !== columnsPerRow) {
      throw new Error(
        `Batched SQL insert expected ${columnsPerRow} values, received ${row.length}`
      );
    }
    const encoded = JSON.stringify(row);
    if (encoded === undefined) {
      throw new Error("Batched SQL insert row is not JSON-serializable");
    }
    const nextChars = encodedChars + encoded.length + (encodedRows.length === 0 ? 0 : 1);
    if (encodedRows.length > 0 && nextChars > JSON_ROWSET_TARGET_CHARS) {
      rowsets.push(`[${encodedRows.join(",")}]`);
      encodedRows = [];
      encodedChars = 2;
    }
    encodedRows.push(encoded);
    encodedChars += encoded.length + (encodedRows.length === 1 ? 0 : 1);
  }
  if (encodedRows.length > 0) rowsets.push(`[${encodedRows.join(",")}]`);
  return rowsets;
}

export function execBatchedInsert(
  sql: SqlStorage,
  insertPrefix: string,
  columnsPerRow: number,
  rows: readonly (readonly unknown[])[]
): void {
  execBatchedInsertReturning(sql, insertPrefix, columnsPerRow, rows);
}

export function execBatchedInsertReturning(
  sql: SqlStorage,
  insertPrefix: string,
  columnsPerRow: number,
  rows: readonly (readonly unknown[])[],
  returning = ""
): Record<string, unknown>[] {
  if (!Number.isSafeInteger(columnsPerRow) || columnsPerRow <= 0) {
    throw new Error("Batched SQL insert requires a positive column count");
  }
  if (columnsPerRow > DURABLE_OBJECT_SQL_MAX_BOUND_PARAMETERS) {
    throw new Error(
      `Batched SQL insert row has ${columnsPerRow} columns; Durable Objects allows ${DURABLE_OBJECT_SQL_MAX_BOUND_PARAMETERS} parameters`
    );
  }
  if (rows.length === 0) return [];

  // A JSON rowset is one bound parameter regardless of row count. SQLite's
  // json_each/json_extract preserve the scalar SQL values used by semantic
  // persistence and avoid hundreds of parser/VM round trips for a cold Base
  // snapshot without weakening the Durable Objects 100-binding contract.
  const projections = Array.from(
    { length: columnsPerRow },
    (_, index) => `json_extract(value, '$[${index}]')`
  ).join(", ");
  const returned: Record<string, unknown>[] = [];
  for (const rowset of encodedRowsets(columnsPerRow, rows)) {
    const result: SqlResult = sql.exec(
      `${insertPrefix} SELECT ${projections} FROM json_each(?)${returning}`,
      rowset
    );
    if (returning) returned.push(...result.toArray());
  }
  return returned;
}
