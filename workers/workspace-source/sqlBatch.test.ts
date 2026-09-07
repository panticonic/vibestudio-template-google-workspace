// Builtin semantic-authority tests.
import { describe, expect, it, vi } from "vitest";
import type { SqlStorage } from "@vibestudio/durable";
import { createInMemorySql } from "@vibestudio/durable/test-utils";

import {
  DURABLE_OBJECT_SQL_MAX_BOUND_PARAMETERS,
  execBatchedInsert,
  execBatchedInsertReturning,
} from "./sqlBatch.js";

function recordingSql(returned: Record<string, unknown>[] = []) {
  const exec = vi.fn((_query: string, ..._bindings: unknown[]) => ({
    toArray: () => returned,
    one: () => returned[0] ?? {},
  }));
  return { exec, sql: { exec } as SqlStorage };
}

describe("execBatchedInsert", () => {
  it("persists a snapshot-scale rowset through one bounded binding", async () => {
    const sql = await createInMemorySql();
    sql.exec(
      `CREATE TABLE values_table (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL,
        optional TEXT
      )`
    );
    const rows = Array.from({ length: 101 }, (_, index) => [index, `value:${index}`, null]);

    execBatchedInsert(sql, "INSERT INTO values_table (id, value, optional)", 3, rows);

    expect(
      sql.exec(`SELECT id, value, optional FROM values_table ORDER BY id`).toArray()
    ).toEqual(rows.map(([id, value, optional]) => ({ id, value, optional })));

    const recording = recordingSql();
    execBatchedInsert(
      recording.sql,
      "INSERT INTO values_table (id, value, optional)",
      3,
      rows
    );
    expect(recording.exec).toHaveBeenCalledTimes(1);
    expect(recording.exec.mock.calls[0]?.slice(1)).toHaveLength(1);
    expect(recording.exec.mock.calls[0]?.slice(1).length).toBeLessThanOrEqual(
      DURABLE_OBJECT_SQL_MAX_BOUND_PARAMETERS
    );
  });

  it("collects RETURNING rows from every statement", () => {
    const returned = [{ id: "one" }];
    const { exec, sql } = recordingSql(returned);
    const rows = Array.from({ length: 51 }, (_, index) => [index, `value:${index}`]);

    expect(
      execBatchedInsertReturning(
        sql,
        "INSERT INTO values_table (id, value)",
        2,
        rows,
        " RETURNING id"
      )
    ).toEqual(returned);
    expect(exec.mock.calls.map(([query]) => query)).toEqual([
      expect.stringContaining(" RETURNING id"),
    ]);
  });

  it("rejects malformed rows before executing their statement", () => {
    const { exec, sql } = recordingSql();

    expect(() => execBatchedInsert(sql, "INSERT INTO values_table (id, value)", 2, [[1]])).toThrow(
      "expected 2 values"
    );
    expect(exec).not.toHaveBeenCalled();
  });
});
