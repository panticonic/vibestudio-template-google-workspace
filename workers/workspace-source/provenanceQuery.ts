// Builtin semantic-authority implementation.
import type { SqlStorage } from "@vibestudio/durable";
import { PROV_RELATIONS, PROV_SCHEMA_VERSION } from "./provenanceViews.js";

/**
 * Read-only execution of agent-authored SQL against the `prov_*` contract.
 *
 * The budget contract is layered and honest about which failures are refused
 * before work and which are stopped during it:
 *
 *  1. structural validation refuses the pathological class outright (not a
 *     single SELECT, an unknown relation, forbidden syntax, recursion);
 *  2. an `EXPLAIN QUERY PLAN` gate refuses full scans of large tables and
 *     cartesian joins, naming the offending term;
 *  3. execution streams rows and aborts on the scan budget where the runtime
 *     exposes cursor accounting, returning a typed partial-with-refusal.
 *
 * The residue — plans that pass the gate but buffer heavily before the first
 * row — is bounded only by the Durable Object's own CPU limits. Post-hoc
 * `rowsRead` is recorded so the residue is measurable; no stronger enforcement
 * is claimed than the runtime can deliver.
 */

export type ProvenanceQueryRefusalCode =
  | "not-a-select"
  | "unknown-relation"
  | "forbidden-syntax"
  | "recursive-cte"
  | "plan-unavailable"
  | "full-scan"
  | "cartesian-join"
  | "scan-budget"
  /** The deployed SQLite refused the statement on a limit of its own. */
  | "engine-error";

export interface ProvenanceQueryRefusal {
  stage: "validation" | "plan" | "execution";
  code: ProvenanceQueryRefusalCode;
  message: string;
  term: string | null;
}

export interface ProvenanceQueryOutcome {
  schemaVersion: number;
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  rowsRead: number;
  truncated: boolean;
  refusal: ProvenanceQueryRefusal | null;
}

export interface ProvenanceQueryBudget {
  /** Maximum rows returned to the caller. */
  rowLimit: number;
  /** Maximum rows the engine may read before a streamed abort. */
  scanBudget: number;
  /** A full scan of a table with more rows than this is refused pre-execution. */
  fullScanRowThreshold: number;
  /** Two or more full scans of tables this large read as a cartesian join. */
  cartesianRowThreshold: number;
  /** Longest text a single cell may render. */
  cellTextLimit: number;
}

export const PROVENANCE_QUERY_BUDGET: ProvenanceQueryBudget = {
  rowLimit: 50,
  scanBudget: 250_000,
  fullScanRowThreshold: 20_000,
  cartesianRowThreshold: 2_000,
  cellTextLimit: 2_000,
};

const FORBIDDEN_KEYWORDS = new Set([
  "alter",
  "attach",
  "begin",
  "commit",
  "create",
  "delete",
  "detach",
  "drop",
  "insert",
  "pragma",
  "reindex",
  "release",
  "replace",
  "rollback",
  "savepoint",
  "temp",
  "temporary",
  "trigger",
  "update",
  "vacuum",
]);

const FORBIDDEN_FUNCTIONS = [
  "load_extension",
  "readfile",
  "writefile",
  "fts5",
  "randomblob",
  "zeroblob",
];

interface Token {
  kind: "word" | "string" | "number" | "punct";
  value: string;
  lower: string;
}

/** Tokenize enough SQL to decide admissibility; SQLite still owns parsing. */
export function tokenizeSql(query: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < query.length) {
    const char = query[index]!;
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "-" && query[index + 1] === "-") {
      const end = query.indexOf("\n", index);
      index = end === -1 ? query.length : end + 1;
      continue;
    }
    if (char === "/" && query[index + 1] === "*") {
      const end = query.indexOf("*/", index + 2);
      index = end === -1 ? query.length : end + 2;
      continue;
    }
    if (char === "'") {
      let end = index + 1;
      while (end < query.length) {
        if (query[end] === "'" && query[end + 1] === "'") {
          end += 2;
          continue;
        }
        if (query[end] === "'") break;
        end += 1;
      }
      tokens.push({ kind: "string", value: query.slice(index, end + 1), lower: "" });
      index = end + 1;
      continue;
    }
    if (char === '"' || char === "`" || char === "[") {
      const closing = char === "[" ? "]" : char;
      const end = query.indexOf(closing, index + 1);
      const value = end === -1 ? query.slice(index + 1) : query.slice(index + 1, end);
      tokens.push({ kind: "word", value, lower: value.toLowerCase() });
      index = end === -1 ? query.length : end + 1;
      continue;
    }
    if (/[0-9]/u.test(char)) {
      let end = index;
      while (end < query.length && /[0-9.eE]/u.test(query[end]!)) end += 1;
      tokens.push({ kind: "number", value: query.slice(index, end), lower: "" });
      index = end;
      continue;
    }
    if (/[A-Za-z_]/u.test(char)) {
      let end = index;
      while (end < query.length && /[A-Za-z0-9_$]/u.test(query[end]!)) end += 1;
      const value = query.slice(index, end);
      tokens.push({ kind: "word", value, lower: value.toLowerCase() });
      index = end;
      continue;
    }
    tokens.push({ kind: "punct", value: char, lower: char });
    index += 1;
  }
  return tokens;
}

function refuse(
  stage: ProvenanceQueryRefusal["stage"],
  code: ProvenanceQueryRefusalCode,
  message: string,
  term: string | null = null
): ProvenanceQueryRefusal {
  return { stage, code, message, term };
}

/**
 * Structural admissibility: one SELECT, `prov_` relations only, no recursion,
 * no statement that could write or reach outside the contract.
 *
 * The FROM/JOIN check catches the common miss with a teaching message, but it
 * cannot see every syntactic position a relation can occupy (comma joins,
 * `IN table`, indexed-by clauses). `privateNames` closes that class: any bare
 * word naming a real database object outside the contract refuses the query
 * outright, wherever it appears. String literals are never inspected, so
 * prose mentioning a table name stays legal.
 */
export function validateProvenanceQuery(
  query: string,
  privateNames?: ReadonlySet<string>
): ProvenanceQueryRefusal | null {
  const tokens = tokenizeSql(query);
  if (tokens.length === 0) {
    return refuse("validation", "not-a-select", "The query is empty");
  }
  const statementEnd = tokens.findIndex((token) => token.value === ";");
  if (statementEnd !== -1 && statementEnd !== tokens.length - 1) {
    return refuse(
      "validation",
      "not-a-select",
      "Only one statement may be submitted; remove everything after the first `;`",
      ";"
    );
  }
  const body = statementEnd === -1 ? tokens : tokens.slice(0, statementEnd);
  const first = body[0]!;
  if (first.lower !== "select" && first.lower !== "with") {
    return refuse(
      "validation",
      "not-a-select",
      `A provenance query must be one SELECT (optionally preceded by WITH); received \`${first.value}\``,
      first.value
    );
  }
  const cteNames = new Set<string>();
  for (let index = 0; index + 2 < body.length; index += 1) {
    if (body[index]!.kind === "word" && body[index + 1]!.lower === "as" && body[index + 2]!.value === "(") {
      cteNames.add(body[index]!.lower);
    }
  }
  for (const [index, token] of body.entries()) {
    if (token.kind !== "word") continue;
    if (privateNames?.has(token.lower) && !PROV_RELATIONS.has(token.lower)) {
      return refuse(
        "validation",
        "unknown-relation",
        `\`${token.value}\` is not part of the provenance contract; run \`SELECT relation, column_name, meaning FROM prov_schema\` for the catalog`,
        token.value
      );
    }
    if (token.lower === "recursive") {
      return refuse(
        "validation",
        "recursive-cte",
        "Recursive CTEs are not available here; multi-hop traversal is what walks are for, with server-owned bounds",
        token.value
      );
    }
    if (FORBIDDEN_KEYWORDS.has(token.lower) && !cteNames.has(token.lower)) {
      return refuse(
        "validation",
        "forbidden-syntax",
        `\`${token.value}\` is not available on the read-only query surface`,
        token.value
      );
    }
    if (FORBIDDEN_FUNCTIONS.includes(token.lower) || token.lower.startsWith("pragma_")) {
      return refuse(
        "validation",
        "forbidden-syntax",
        `The function \`${token.value}\` is not available on the query surface`,
        token.value
      );
    }
    if (token.lower === "from" || token.lower === "join") {
      const next = body[index + 1];
      if (!next || next.value === "(") continue;
      if (next.kind !== "word") continue;
      if (next.lower === "select") continue;
      if (cteNames.has(next.lower)) continue;
      if (!PROV_RELATIONS.has(next.lower)) {
        return refuse(
          "validation",
          "unknown-relation",
          `\`${next.value}\` is not part of the provenance contract; run \`SELECT relation, column_name, meaning FROM prov_schema\` for the catalog`,
          next.value
        );
      }
    }
  }
  return null;
}

/** Every real table/view outside the `prov_*` contract, straight from the engine. */
function privateDatabaseNames(sql: SqlStorage): ReadonlySet<string> {
  const names = new Set<string>();
  try {
    for (const row of sql
      .exec(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view')`)
      .toArray()) {
      const name = String(row["name"] ?? "").toLowerCase();
      if (name && !PROV_RELATIONS.has(name)) names.add(name);
    }
  } catch {
    // With no catalog to consult, the FROM/JOIN relation check still holds.
  }
  return names;
}

interface PlanStep {
  detail: string;
}

/**
 * The plan, or null when the engine could not produce one.
 *
 * An *empty* plan is not a missing plan: it is the plan for a statement that
 * scans nothing at all, which the catalog view and any constant-only query
 * produce. Treating the two alike refused the cheapest possible queries — the
 * quiet shape of the failure this gate must never have, since a surface that
 * refuses everything is indistinguishable from a healthy one to its caller.
 */
function planSteps(sql: SqlStorage, query: string): PlanStep[] | { error: unknown } {
  try {
    return sql
      .exec(`EXPLAIN QUERY PLAN ${query}`)
      .toArray()
      .map((row) => ({ detail: String(row["detail"] ?? "") }));
  } catch (error) {
    return { error };
  }
}

function tableRowCount(sql: SqlStorage, table: string, cache: Map<string, number>): number {
  const known = cache.get(table);
  if (known !== undefined) return known;
  let count = 0;
  try {
    const row = sql.exec(`SELECT count(*) AS n FROM "${table.replaceAll('"', "")}"`).toArray()[0];
    count = Number(row?.["n"] ?? 0);
  } catch {
    count = 0;
  }
  cache.set(table, count);
  return count;
}

/**
 * Refuse the plans SQLite tells us are pathological. The plan names canonical
 * tables because views expand; that is exactly the level at which scan cost is
 * decidable, and the refusal quotes the offending term rather than the table's
 * private role.
 */
export function gateProvenanceQueryPlan(
  sql: SqlStorage,
  query: string,
  budget: ProvenanceQueryBudget
): ProvenanceQueryRefusal | null {
  const planned = planSteps(sql, query);
  if (!Array.isArray(planned)) {
    // A throwing EXPLAIN usually means the *statement* is wrong — a misspelled
    // column, say — not that the engine cannot plan. Reporting "scan cost cannot
    // be bounded" for `no such column` sends the agent to fix the wrong thing,
    // so the engine's own message decides which failure this is.
    const message =
      planned.error instanceof Error ? planned.error.message : String(planned.error);
    return /\bexplain\b/iu.test(message) && /unsupported|no such module|not supported/iu.test(message)
      ? refuse(
          "plan",
          "plan-unavailable",
          "The engine could not produce a query plan for this statement, so its scan cost cannot be bounded before execution"
        )
      : { ...engineRefusal(planned.error), stage: "plan" };
  }
  const steps = planned;
  const counts = new Map<string, number>();
  const fullScans: Array<{ table: string; rows: number }> = [];
  for (const step of steps) {
    const scan = /\bSCAN\s+(?:TABLE\s+)?([A-Za-z_][A-Za-z0-9_]*)/u.exec(step.detail);
    if (!scan?.[1]) continue;
    if (/\bUSING\s+(COVERING\s+)?(INDEX|INTEGER PRIMARY KEY)/u.test(step.detail)) continue;
    const table = scan[1];
    if (table.toLowerCase() === "subquery" || table.startsWith("sqlite_")) continue;
    fullScans.push({ table, rows: tableRowCount(sql, table, counts) });
  }
  const oversized = fullScans.find((scan) => scan.rows > budget.fullScanRowThreshold);
  if (oversized) {
    return refuse(
      "plan",
      "full-scan",
      `The plan scans every row of a relation backing \`${oversized.table}\` (${oversized.rows} rows). Filter on an indexed column, or narrow the join.`,
      oversized.table
    );
  }
  const cartesian = fullScans.filter((scan) => scan.rows > budget.cartesianRowThreshold);
  if (cartesian.length >= 2) {
    return refuse(
      "plan",
      "cartesian-join",
      `The plan fully scans ${cartesian.length} large relations (${cartesian
        .map((scan) => scan.table)
        .join(", ")}), which multiplies rows read. Add the join predicate that relates them.`,
      cartesian[0]!.table
    );
  }
  return null;
}

function cell(value: unknown, limit: number): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = typeof value === "string" ? value : String(value);
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

interface CursorLike {
  toArray(): Record<string, unknown>[];
  rowsRead?: number;
  [Symbol.iterator]?: () => Iterator<Record<string, unknown>>;
}

/**
 * Turn a raw engine failure into the typed refusal the contract promises. The
 * engine's own message is the most precise statement of the bound available, so
 * it is quoted rather than replaced with a guess.
 */
function engineRefusal(error: unknown): ProvenanceQueryRefusal {
  const message = error instanceof Error ? error.message : String(error);
  return refuse(
    "execution",
    "engine-error",
    `The database engine refused this statement: ${message.slice(0, 400)}. Rewrite the query — this is a limit of the deployed engine, not of your authorization`,
    null
  );
}

/** Execute one validated, plan-gated query with a streamed scan abort. */
export function executeProvenanceQuery(
  sql: SqlStorage,
  input: { query: string; limit: number },
  budget: ProvenanceQueryBudget = PROVENANCE_QUERY_BUDGET
): ProvenanceQueryOutcome {
  const empty = {
    schemaVersion: PROV_SCHEMA_VERSION,
    columns: [] as string[],
    rows: [] as Array<Array<string | number | boolean | null>>,
    rowsRead: 0,
    truncated: false,
  };
  const structural = validateProvenanceQuery(input.query, privateDatabaseNames(sql));
  if (structural) return { ...empty, refusal: structural };
  const limit = Math.max(1, Math.min(input.limit, budget.rowLimit));
  const bounded = `SELECT * FROM (\n${input.query.replace(/;\s*$/u, "")}\n) LIMIT ${limit + 1}`;
  const plan = gateProvenanceQueryPlan(sql, bounded, budget);
  if (plan) return { ...empty, refusal: plan };

  // The deployed engine enforces limits the fallback engine used in unit tests
  // does not, so a well-formed query can still be rejected by SQLite itself.
  // That is a refusal like any other and must arrive typed and named: letting it
  // escape as an untyped tool failure tells the agent "do not retry" about a
  // query it could trivially correct, and breaks the contract that every layer
  // refuses distinctly and names its bound.
  let cursor: CursorLike;
  try {
    cursor = sql.exec(bounded) as unknown as CursorLike;
  } catch (error) {
    return { ...empty, refusal: engineRefusal(error) };
  }
  const collected: Record<string, unknown>[] = [];
  let refusal: ProvenanceQueryRefusal | null = null;
  try {
    if (typeof cursor[Symbol.iterator] === "function") {
      for (const row of cursor as Iterable<Record<string, unknown>>) {
        collected.push(row);
        if ((cursor.rowsRead ?? 0) > budget.scanBudget) {
          refusal = refuse(
            "execution",
            "scan-budget",
            `The query read more than ${budget.scanBudget} rows before completing; the partial result below is what it produced before the budget stopped it`,
            String(cursor.rowsRead ?? 0)
          );
          break;
        }
        if (collected.length > limit) break;
      }
    } else {
      collected.push(...cursor.toArray());
    }
  } catch (error) {
    refusal = engineRefusal(error);
  }
  const rowsRead = cursor.rowsRead ?? collected.length;
  if (!refusal && rowsRead > budget.scanBudget) {
    refusal = refuse(
      "execution",
      "scan-budget",
      `The query read ${rowsRead} rows, over the ${budget.scanBudget} row budget`,
      String(rowsRead)
    );
  }
  const truncated = collected.length > limit;
  const page = collected.slice(0, limit);
  const columns = [...new Set(page.flatMap((row) => Object.keys(row)))].slice(0, 64);
  // Logging-only residue accounting: this is the evidence that would justify a
  // per-caller quota, which is deliberately not built up front.
  if (rowsRead > budget.scanBudget / 4) {
    console.info("[ProvenanceQuery] scan accounting", {
      rowsRead,
      returned: page.length,
      truncated,
    });
  }
  return {
    schemaVersion: PROV_SCHEMA_VERSION,
    columns,
    rows: page.map((row) => columns.map((column) => cell(row[column], budget.cellTextLimit))),
    rowsRead,
    truncated,
    refusal,
  };
}
