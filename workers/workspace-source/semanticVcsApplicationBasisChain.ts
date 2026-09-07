// Builtin semantic-authority implementation.
import type { StateNodeRef } from "@workspace/vcs-engine";
import type { SqlStorage } from "@vibestudio/durable";

type Row = Record<string, unknown>;

export class SemanticVcsApplicationBasisChainError extends Error {
  constructor(
    readonly code: "InvalidTail" | "ScopeTooLarge" | "IntegrityFailure" | "UnknownContext",
    message: string,
    readonly handles: readonly string[] = []
  ) {
    super(message);
    this.name = "SemanticVcsApplicationBasisChainError";
  }
}

export interface WorkingApplicationBasisChain {
  tailApplicationId: string | null;
  root: StateNodeRef | null;
  /** Oldest first, exactly as application bases compose. */
  applicationIds: readonly string[];
}

/**
 * Follow the one authoritative application basis edge. There is no sequence
 * root, stored count, skip witness, or proof packet; those are derived query
 * aids and can be added later as rebuildable indexes if measurements demand it.
 */
export function readWorkingApplicationBasisChain(input: {
  sql: SqlStorage;
  tailApplicationId: string | null;
  maxApplications: number;
}): WorkingApplicationBasisChain {
  if (!Number.isSafeInteger(input.maxApplications) || input.maxApplications < 0) {
    throw new SemanticVcsApplicationBasisChainError("InvalidTail", "invalid application bound");
  }
  if (input.tailApplicationId === null) {
    return { tailApplicationId: null, root: null, applicationIds: [] };
  }

  const newestFirst: string[] = [];
  const seen = new Set<string>();
  let cursor: StateNodeRef = { kind: "application", applicationId: input.tailApplicationId };
  while (cursor.kind === "application") {
    if (newestFirst.length === input.maxApplications) {
      throw new SemanticVcsApplicationBasisChainError(
        "ScopeTooLarge",
        `working chain exceeds ${input.maxApplications} applications`,
        [input.tailApplicationId]
      );
    }
    if (seen.has(cursor.applicationId)) {
      throw new SemanticVcsApplicationBasisChainError(
        "IntegrityFailure",
        "application basis chain is cyclic",
        [cursor.applicationId]
      );
    }
    seen.add(cursor.applicationId);
    newestFirst.push(cursor.applicationId);
    const rows = input.sql
      .exec(
        `SELECT basis_kind, basis_id
           FROM gad_work_unit_applications
          WHERE application_id = ? LIMIT 2`,
        cursor.applicationId
      )
      .toArray() as Row[];
    if (rows.length !== 1) {
      throw new SemanticVcsApplicationBasisChainError(
        "IntegrityFailure",
        `application ${cursor.applicationId} is missing or ambiguous`,
        [cursor.applicationId]
      );
    }
    const kind = String(rows[0]!["basis_kind"]);
    const basisId = String(rows[0]!["basis_id"]);
    cursor =
      kind === "event"
        ? { kind: "event", eventId: basisId }
        : kind === "application"
          ? { kind: "application", applicationId: basisId }
          : (() => {
              throw new SemanticVcsApplicationBasisChainError(
                "IntegrityFailure",
                `application ${cursor.applicationId} has an invalid basis`,
                [cursor.applicationId]
              );
            })();
  }

  return {
    tailApplicationId: input.tailApplicationId,
    root: cursor,
    applicationIds: newestFirst.reverse(),
  };
}

export function readContextWorkingApplicationBasisChain(input: {
  sql: SqlStorage;
  contextId: string;
  maxApplications: number;
}): WorkingApplicationBasisChain {
  const rows = input.sql
    .exec(
      `SELECT committed_event_id, working_head_application_id
         FROM vcs_contexts WHERE context_id = ? LIMIT 2`,
      input.contextId
    )
    .toArray() as Row[];
  if (rows.length !== 1) {
    throw new SemanticVcsApplicationBasisChainError(
      "UnknownContext",
      `context ${input.contextId} is missing or ambiguous`,
      [input.contextId]
    );
  }
  const chain = readWorkingApplicationBasisChain({
    sql: input.sql,
    tailApplicationId:
      rows[0]!["working_head_application_id"] == null
        ? null
        : String(rows[0]!["working_head_application_id"]),
    maxApplications: input.maxApplications,
  });
  if (
    chain.root &&
    (chain.root.kind !== "event" || chain.root.eventId !== String(rows[0]!["committed_event_id"]))
  ) {
    throw new SemanticVcsApplicationBasisChainError(
      "IntegrityFailure",
      "working application chain is not rooted at the context's committed event",
      [
        input.contextId,
        chain.root.kind === "event" ? chain.root.eventId : chain.root.applicationId,
        String(rows[0]!["committed_event_id"]),
      ]
    );
  }
  return chain.root
    ? chain
    : {
        ...chain,
        root: { kind: "event", eventId: String(rows[0]!["committed_event_id"]) },
      };
}
