// Builtin semantic-authority implementation.
import { canonicalJson, compareUtf16CodeUnits } from "@vibestudio/content-addressing";

/**
 * Bind an arbitrarily large identity set through SQLite's JSON table rather
 * than expanding one SQL variable per identity. This keeps every query at one
 * binding while preserving exact, deterministic set semantics.
 */
export function sqlIdentitySet(values: Iterable<string>): string {
  return canonicalJson([...new Set(values)].sort(compareUtf16CodeUnits));
}

export const SQL_TEXT_IDENTITY_SET = "SELECT CAST(value AS TEXT) FROM json_each(?)";
