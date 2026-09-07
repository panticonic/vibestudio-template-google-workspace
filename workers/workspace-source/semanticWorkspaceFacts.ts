// Builtin semantic-authority implementation.
import { canonicalJson, compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import type { SqlStorage } from "@vibestudio/durable";
import {
  authenticateFileManifest,
  authenticatePersistentRadixNode,
  authenticateWorkspaceFileState,
  authenticateWorkspaceFactRoot,
  authenticateWorkspaceRepositoryMember,
  composeFileManifest,
  composeWorkspaceFacts,
  emptyFileManifest,
  emptyWorkspaceFactRoot,
  fileManifestEntryAt,
  persistentRadixRoute,
  persistentRadixUtf16PrefixRoute,
  validateWorkspaceFactChangeSet,
  workspaceFactFileEntryAt,
  workspaceFactRepositoryAtPath,
  workspaceFactRepositoryEntryAt,
  type FileManifestMutationProof,
  type PersistentFileManifest,
  type PersistentRadixIndexKind,
  type PersistentRadixNode,
  type PersistentRadixRouteStrategy,
  type WorkspaceFileState,
  type WorkspaceFactChangeSet,
  type WorkspaceFactMutation,
  type WorkspaceFactRoot,
  type WorkspaceRepositoryMember,
} from "@workspace/vcs-engine";
import {
  DURABLE_OBJECT_SQL_MAX_BOUND_PARAMETERS,
  execBatchedInsert,
  execBatchedInsertReturning,
} from "./sqlBatch.js";

type Row = Record<string, unknown>;
const text = (row: Row, key: string): string => String(row[key]);
const nullableText = (row: Row, key: string): string | null =>
  row[key] == null ? null : String(row[key]);
const nullableNumber = (row: Row, key: string): number | null =>
  row[key] == null ? null : Number(row[key]);

export class SemanticWorkspaceFactsError extends Error {
  constructor(
    readonly code:
      | "InvalidRoot"
      | "InvalidNode"
      | "MissingState"
      | "ExpectedMemberMismatch"
      | "IndexMismatch",
    message: string,
    readonly handles: readonly string[] = []
  ) {
    super(message);
    this.name = "SemanticWorkspaceFactsError";
  }
}

export interface WorkspaceFactPersistence extends WorkspaceFactMutation {
  manifestProofs: readonly FileManifestMutationProof[];
}

/**
 * One exact in-memory workspace-fact transition. Composition authenticates the
 * basis and derives the immutable radix proof; application persists that same
 * proof in the surrounding semantic transaction. Keeping the two together
 * prevents callers from paying to derive an identical proof twice.
 */
export interface PreparedWorkspaceFactChange {
  changeSet: WorkspaceFactChangeSet;
  persistence: WorkspaceFactPersistence;
}

export type WorkspaceAggregateIndexKind = "repository" | "live-path" | "file";

/** Point-first SQL adapter over one immutable workspace facts and the
 * neutral persistent-radix node store. Full walks exist only for bounded pages
 * and explicit maintenance integrity audits. */
export class SemanticWorkspaceFacts {
  constructor(private readonly sql: SqlStorage) {}

  empty(): WorkspaceFactRoot {
    const { root, nodes } = emptyWorkspaceFactRoot();
    this.persistNodes(nodes);
    this.persistRoot(root);
    return root;
  }

  root(workspaceFactRootId: string): WorkspaceFactRoot {
    const row = this.sql
      .exec(
        `SELECT workspace_fact_root_id, root_node_id, entry_count,
                repository_count, live_path_count, file_count
           FROM vcs_workspace_fact_roots
          WHERE workspace_fact_root_id = ?`,
        workspaceFactRootId
      )
      .toArray()[0] as Row | undefined;
    if (!row) {
      throw new SemanticWorkspaceFactsError(
        "InvalidRoot",
        `Missing workspace facts ${workspaceFactRootId}`,
        [workspaceFactRootId]
      );
    }
    const root: WorkspaceFactRoot = {
      workspaceFactRootId: text(row, "workspace_fact_root_id"),
      rootNodeId: text(row, "root_node_id"),
      entryCount: Number(row["entry_count"]),
      repositoryCount: Number(row["repository_count"]),
      livePathCount: Number(row["live_path_count"]),
      fileCount: Number(row["file_count"]),
    };
    authenticateWorkspaceFactRoot(root);
    return root;
  }

  node(
    indexKind: PersistentRadixIndexKind,
    routeStrategy: PersistentRadixRouteStrategy,
    nodeId: string,
    expectedPrefix: string
  ): PersistentRadixNode | null {
    const row = this.sql
      .exec(
        `SELECT node_id, index_kind, route_strategy, node_kind, branch_depth, branch_prefix
           FROM gad_persistent_radix_nodes WHERE node_id = ?`,
        nodeId
      )
      .toArray()[0] as Row | undefined;
    if (!row) return null;
    if (text(row, "index_kind") !== indexKind || text(row, "route_strategy") !== routeStrategy) {
      throw new SemanticWorkspaceFactsError(
        "InvalidNode",
        `Persistent radix node ${nodeId} crossed from ${indexKind} into ${text(row, "index_kind")}`,
        [nodeId, indexKind, text(row, "index_kind")]
      );
    }
    const nodeKind = text(row, "node_kind") as "empty" | "branch" | "leaf";
    const edges = this.sql
      .exec(
        `SELECT ordinal, slot, child_node_id, entry_key, entry_value
           FROM gad_persistent_radix_edges WHERE node_id = ? ORDER BY ordinal`,
        nodeId
      )
      .toArray() as Row[];
    let shape: PersistentRadixNode["shape"];
    if (nodeKind === "empty") {
      if (edges.length !== 0) this.invalidNode(nodeId, "empty node has edges");
      shape = { kind: "empty" };
    } else if (nodeKind === "branch") {
      const depth = nullableNumber(row, "branch_depth");
      const prefix = nullableText(row, "branch_prefix");
      if (
        depth === null ||
        prefix === null ||
        edges.length === 0 ||
        edges.some(
          (edge) =>
            nullableNumber(edge, "slot") === null ||
            nullableText(edge, "child_node_id") === null ||
            nullableText(edge, "entry_key") !== null ||
            nullableText(edge, "entry_value") !== null
        )
      ) {
        this.invalidNode(nodeId, "branch header or edges are malformed");
      }
      shape = {
        kind: "branch",
        depth: depth!,
        prefix: prefix!,
        children: edges.map((edge, ordinal) => {
          const slot = Number(edge["slot"]);
          if (Number(edge["ordinal"]) !== ordinal) {
            this.invalidNode(nodeId, "branch edges are not canonically ordered");
          }
          return { slot, childNodeId: text(edge, "child_node_id") };
        }),
      };
    } else if (nodeKind === "leaf") {
      if (
        nullableNumber(row, "branch_depth") !== null ||
        nullableText(row, "branch_prefix") !== null ||
        edges.length === 0 ||
        edges.some(
          (edge) =>
            nullableNumber(edge, "slot") !== null ||
            nullableText(edge, "child_node_id") !== null ||
            nullableText(edge, "entry_key") === null ||
            nullableText(edge, "entry_value") === null
        )
      ) {
        this.invalidNode(nodeId, "leaf header or edges are malformed");
      }
      shape = {
        kind: "leaf",
        entries: edges.map((edge, ordinal) => {
          if (Number(edge["ordinal"]) !== ordinal) {
            this.invalidNode(nodeId, "leaf entries are not canonically ordered");
          }
          const key = text(edge, "entry_key");
          return {
            key,
            value: text(edge, "entry_value"),
            keyDigest: persistentRadixRoute(routeStrategy, key),
          };
        }),
      };
    } else {
      this.invalidNode(nodeId, `unknown node kind ${nodeKind}`);
    }
    return authenticatePersistentRadixNode(
      {
        nodeId: text(row, "node_id"),
        indexKind,
        routeStrategy,
        shape,
      },
      expectedPrefix
    );
  }

  member(workspaceFactRootId: string, repositoryId: string): WorkspaceRepositoryMember | null {
    const root = this.root(workspaceFactRootId);
    const entry = workspaceFactRepositoryEntryAt({
      root,
      repositoryId,
      readNode: (kind, route, nodeId, prefix) => this.node(kind, route, nodeId, prefix),
    });
    return entry ? this.memberByStateId(entry.repositoryStateId) : null;
  }

  repositoryAtPath(
    workspaceFactRootId: string,
    repoPath: string
  ): WorkspaceRepositoryMember | null {
    const root = this.root(workspaceFactRootId);
    const repositoryId = workspaceFactRepositoryAtPath({
      root,
      repoPath,
      readNode: (kind, route, nodeId, prefix) => this.node(kind, route, nodeId, prefix),
    });
    return repositoryId ? this.member(workspaceFactRootId, repositoryId) : null;
  }

  file(
    workspaceFactRootId: string,
    fileId: string
  ): { repository: WorkspaceRepositoryMember; state: WorkspaceFileState } | null {
    const root = this.root(workspaceFactRootId);
    const entry = workspaceFactFileEntryAt({
      root,
      fileId,
      readNode: (kind, route, nodeId, prefix) => this.node(kind, route, nodeId, prefix),
    });
    if (!entry) return null;
    const state = this.fileStateById(entry.fileStateId);
    if (!state || state.fileId !== fileId) {
      throw new SemanticWorkspaceFactsError(
        "MissingState",
        `Workspace file index references an unrealized state for ${fileId}`,
        [workspaceFactRootId, fileId, entry.fileStateId]
      );
    }
    const priorFileStateId = state.presence === "deleted" ? state.priorFileStateId : null;
    const placed = priorFileStateId ? this.fileStateById(priorFileStateId) : state;
    if (!placed || placed.presence !== "placed" || placed.fileId !== fileId) {
      throw new SemanticWorkspaceFactsError(
        "MissingState",
        `File tombstone ${state.fileStateId} has no exact prior placed state`,
        [state.fileStateId, priorFileStateId ?? "placed"]
      );
    }
    const repositoryId = placed.repositoryId;
    const repository = this.member(workspaceFactRootId, repositoryId);
    if (!repository) {
      throw new SemanticWorkspaceFactsError(
        "MissingState",
        `Workspace file ${fileId} references missing repository ${repositoryId}`,
        [workspaceFactRootId, fileId, repositoryId]
      );
    }
    return { repository, state };
  }

  /** Resolve many file coordinates against one immutable root.
   *
   * Atomic imports and replacements already page their repository manifest,
   * then need the corresponding aggregate file states. Sharing authenticated
   * radix nodes and batching the immutable state rows keeps that bounded walk
   * from degenerating into one independent SQL traversal per file. */
  fileStatesAt(
    workspaceFactRootId: string,
    fileIds: readonly string[]
  ): Map<string, WorkspaceFileState> {
    const root = this.root(workspaceFactRootId);
    const nodes = new Map<string, PersistentRadixNode | null>();
    const readNode = (
      kind: string,
      route: PersistentRadixRouteStrategy,
      nodeId: string,
      prefix: string
    ) => {
      const cacheKey = `${kind}\0${route}\0${nodeId}\0${prefix}`;
      if (nodes.has(cacheKey)) return nodes.get(cacheKey) ?? null;
      const node = this.node(kind, route, nodeId, prefix);
      nodes.set(cacheKey, node);
      return node;
    };
    const stateIdByFileId = new Map<string, string>();
    for (const fileId of fileIds) {
      const entry = workspaceFactFileEntryAt({ root, fileId, readNode });
      if (entry) stateIdByFileId.set(fileId, entry.fileStateId);
    }
    const stateById = this.fileStatesByStateId([...stateIdByFileId.values()]);
    const states = new Map<string, WorkspaceFileState>();
    for (const [fileId, stateId] of stateIdByFileId) {
      const state = stateById.get(stateId);
      if (!state || state.fileId !== fileId) {
        throw new SemanticWorkspaceFactsError(
          "MissingState",
          `Workspace file index references an unrealized state for ${fileId}`,
          [workspaceFactRootId, fileId, stateId]
        );
      }
      states.set(fileId, state);
    }
    return states;
  }

  private fileStatesByStateId(fileStateIds: readonly string[]): Map<string, WorkspaceFileState> {
    const stateIds = [...new Set(fileStateIds)];
    const stateById = new Map<string, WorkspaceFileState>();
    for (
      let offset = 0;
      offset < stateIds.length;
      offset += DURABLE_OBJECT_SQL_MAX_BOUND_PARAMETERS
    ) {
      const batch = stateIds.slice(offset, offset + DURABLE_OBJECT_SQL_MAX_BOUND_PARAMETERS);
      const rows = this.sql
        .exec(
          `SELECT file_state_id, file_id, presence, repository_id, path, content_hash,
                  mode, content_kind, byte_length, coordinate_extent,
                  prior_file_state_id, tombstone_change_id
             FROM vcs_file_states
            WHERE file_state_id IN (${batch.map(() => "?").join(", ")})`,
          ...batch
        )
        .toArray() as Row[];
      for (const row of rows) {
        const state = this.fileStateFromRow(row);
        stateById.set(state.fileStateId, state);
      }
    }
    return stateById;
  }

  fileAtPath(
    workspaceFactRootId: string,
    repositoryId: string,
    path: string
  ): { repository: WorkspaceRepositoryMember; state: WorkspaceFileState } | null {
    const repository = this.member(workspaceFactRootId, repositoryId);
    if (!repository || repository.presence !== "present") return null;
    const manifest = this.manifest(repository.fileManifestId);
    if (manifest.repositoryId !== repositoryId) {
      throw new SemanticWorkspaceFactsError(
        "IndexMismatch",
        `Repository ${repositoryId} names a manifest owned by ${manifest.repositoryId}`,
        [repositoryId, manifest.fileManifestId, manifest.repositoryId]
      );
    }
    const entry = fileManifestEntryAt({
      manifest,
      path,
      readNode: (kind, route, nodeId, prefix) => this.node(kind, route, nodeId, prefix),
    });
    if (!entry) return null;
    const indexed = workspaceFactFileEntryAt({
      root: this.root(workspaceFactRootId),
      fileId: entry.fileId,
      readNode: (kind, route, nodeId, prefix) => this.node(kind, route, nodeId, prefix),
    });
    const state = indexed ? this.fileStateById(indexed.fileStateId) : null;
    if (
      !state ||
      state.presence !== "placed" ||
      state.repositoryId !== repositoryId ||
      state.path !== path
    ) {
      throw new SemanticWorkspaceFactsError(
        "IndexMismatch",
        `Manifest ${manifest.fileManifestId} path ${path} references a cross-coordinate file state`,
        [manifest.fileManifestId, path, entry.fileId]
      );
    }
    return { repository, state };
  }

  manifest(fileManifestId: string): PersistentFileManifest {
    const row = this.sql
      .exec(
        `SELECT file_manifest_id, repository_id, path_root_node_id, entry_count
           FROM vcs_file_manifests WHERE file_manifest_id = ?`,
        fileManifestId
      )
      .toArray()[0] as Row | undefined;
    if (!row) {
      throw new SemanticWorkspaceFactsError(
        "MissingState",
        `Missing file manifest ${fileManifestId}`,
        [fileManifestId]
      );
    }
    const manifest: PersistentFileManifest = {
      fileManifestId: text(row, "file_manifest_id"),
      repositoryId: text(row, "repository_id"),
      pathRootNodeId: text(row, "path_root_node_id"),
      entryCount: Number(row["entry_count"]),
    };
    authenticateFileManifest(manifest);
    return manifest;
  }

  private compose(changeSet: WorkspaceFactChangeSet): WorkspaceFactPersistence {
    const validity = validateWorkspaceFactChangeSet(changeSet);
    if (validity.kind === "invalid") {
      throw new SemanticWorkspaceFactsError("InvalidRoot", validity.failure.message, [
        changeSet.basisWorkspaceFactRootId,
        ...validity.failure.handles,
      ]);
    }
    const basis = this.root(changeSet.basisWorkspaceFactRootId);
    // One atomic proof commonly touches many coordinates in the same radix
    // branches. Nodes are immutable and content-addressed, so authenticate each
    // distinct read once for this composition instead of repeating the same
    // SQLite reads for every point lookup.
    const persistedNodes = new Map<string, PersistentRadixNode | null>();
    const transientNodes = new Map<string, PersistentRadixNode>();
    const readNode = (
      kind: string,
      route: PersistentRadixRouteStrategy,
      nodeId: string,
      prefix: string
    ) => {
      const transient = transientNodes.get(nodeId);
      if (transient) return transient;
      const cacheKey = `${kind}\0${route}\0${nodeId}\0${prefix}`;
      if (persistedNodes.has(cacheKey)) return persistedNodes.get(cacheKey) ?? null;
      const node = this.node(kind, route, nodeId, prefix);
      persistedNodes.set(cacheKey, node);
      return node;
    };
    for (const update of changeSet.repositoryUpdates) {
      const entry = workspaceFactRepositoryEntryAt({
        root: basis,
        repositoryId: update.repositoryId,
        readNode,
      });
      const observed = entry ? this.memberByStateId(entry.repositoryStateId) : null;
      if (canonicalJson(observed) !== canonicalJson(update.expected)) {
        throw new SemanticWorkspaceFactsError(
          "ExpectedMemberMismatch",
          `Workspace facts expected repository disagrees for ${update.repositoryId}`,
          [update.repositoryId]
        );
      }
    }
    const indexedFileUpdates = changeSet.fileUpdates.map((update) => ({
      update,
      entry: workspaceFactFileEntryAt({
        root: basis,
        fileId: update.fileId,
        readNode,
      }),
    }));
    const observedFileStates = this.fileStatesByStateId(
      indexedFileUpdates.flatMap(({ entry }) => (entry ? [entry.fileStateId] : []))
    );
    for (const { update, entry } of indexedFileUpdates) {
      const observed = entry ? (observedFileStates.get(entry.fileStateId) ?? null) : null;
      if (observed && observed.fileId !== update.fileId) {
        throw new SemanticWorkspaceFactsError(
          "IndexMismatch",
          `Workspace file index points ${update.fileId} at state for ${observed.fileId}`,
          [basis.workspaceFactRootId, update.fileId, entry?.fileStateId ?? "absent"]
        );
      }
      if (canonicalJson(observed) !== canonicalJson(update.expected)) {
        throw new SemanticWorkspaceFactsError(
          "ExpectedMemberMismatch",
          `Workspace facts expected file disagrees for ${update.fileId}`,
          [update.fileId]
        );
      }
    }

    const manifestProofs: FileManifestMutationProof[] = [];
    const fileUpdateById = new Map(
      changeSet.fileUpdates.map((update) => [update.fileId, update] as const)
    );
    for (const update of changeSet.manifestUpdates) {
      let manifest: PersistentFileManifest;
      if (update.expectedFileManifestId === null) {
        const empty = emptyFileManifest(update.repositoryId);
        manifest = empty.manifest;
        transientNodes.set(empty.node.nodeId, empty.node);
      } else {
        manifest = this.manifest(update.expectedFileManifestId);
      }
      if (manifest.repositoryId !== update.repositoryId) {
        throw new SemanticWorkspaceFactsError(
          "IndexMismatch",
          `Manifest update crosses repository ownership for ${update.repositoryId}`,
          [update.repositoryId, manifest.repositoryId, manifest.fileManifestId]
        );
      }
      this.assertTouchedManifestStates(update.repositoryId, update.pathUpdates, fileUpdateById);
      if (update.pathUpdates.length === 0) {
        if (
          update.expectedFileManifestId !== null ||
          canonicalJson(update.resultManifest) !== canonicalJson(manifest)
        ) {
          throw new SemanticWorkspaceFactsError(
            "IndexMismatch",
            `Empty manifest initialization disagrees for ${update.repositoryId}`,
            [update.repositoryId, manifest.fileManifestId, update.resultManifest.fileManifestId]
          );
        }
        continue;
      }
      const proof = composeFileManifest({
        basis: manifest,
        updates: update.pathUpdates,
        readNode,
      });
      if (canonicalJson(proof.resultManifest) !== canonicalJson(update.resultManifest)) {
        throw new SemanticWorkspaceFactsError(
          "IndexMismatch",
          `Manifest result disagrees for ${update.repositoryId}`,
          [
            update.repositoryId,
            proof.resultManifest.fileManifestId,
            update.resultManifest.fileManifestId,
          ]
        );
      }
      for (const node of proof.createdNodes) transientNodes.set(node.nodeId, node);
      manifestProofs.push(proof);
    }

    const mutation = composeWorkspaceFacts({
      basis,
      update: {
        repositoryUpdates: changeSet.repositoryUpdates.map((update) => ({
          repositoryId: update.repositoryId,
          expectedRepositoryStateId: update.expected?.repositoryStateId ?? null,
          resultRepositoryStateId: update.result.repositoryStateId,
          expectedRepoPath:
            update.expected?.presence === "present" ? update.expected.repoPath : null,
          resultRepoPath: update.result.presence === "present" ? update.result.repoPath : null,
        })),
        fileUpdates: changeSet.fileUpdates.map((update) => ({
          fileId: update.fileId,
          expectedFileStateId: update.expected?.fileStateId ?? null,
          resultFileStateId: update.result.fileStateId,
        })),
      },
      readNode,
    });
    const created = new Map<string, PersistentRadixNode>();
    for (const node of transientNodes.values()) created.set(node.nodeId, node);
    for (const node of mutation.createdNodes) created.set(node.nodeId, node);
    return { ...mutation, createdNodes: [...created.values()], manifestProofs };
  }

  prepare(changeSet: WorkspaceFactChangeSet): PreparedWorkspaceFactChange {
    return { changeSet, persistence: this.compose(changeSet) };
  }

  apply(prepared: PreparedWorkspaceFactChange): WorkspaceFactPersistence {
    const profileStartedAt = Date.now();
    const { changeSet, persistence: proof } = prepared;
    for (const update of changeSet.repositoryUpdates) {
      if (
        canonicalJson(this.memberByStateId(update.result.repositoryStateId)) !==
        canonicalJson(update.result)
      ) {
        throw new SemanticWorkspaceFactsError(
          "MissingState",
          `Repository result state is missing or invalid for ${update.repositoryId}`,
          [update.repositoryId, update.result.repositoryStateId]
        );
      }
    }
    const resultFileStates = this.fileStatesByStateId(
      changeSet.fileUpdates.map((update) => update.result.fileStateId)
    );
    for (const update of changeSet.fileUpdates) {
      if (
        canonicalJson(resultFileStates.get(update.result.fileStateId) ?? null) !==
        canonicalJson(update.result)
      ) {
        throw new SemanticWorkspaceFactsError(
          "MissingState",
          `File result state is missing or invalid for ${update.fileId}`,
          [update.fileId, update.result.fileStateId]
        );
      }
    }
    const resultValidationCompletedAt = Date.now();
    this.persistNodes(proof.createdNodes);
    const nodesCompletedAt = Date.now();
    for (const manifest of changeSet.manifestUpdates) this.persistManifest(manifest.resultManifest);
    const manifestsCompletedAt = Date.now();
    this.persistRoot(proof.resultRoot);
    const profileCompletedAt = Date.now();
    const totalMs = profileCompletedAt - profileStartedAt;
    if (totalMs >= 100) {
      console.info("[VcsProfile] workspace fact persistence", {
        repositoryUpdates: changeSet.repositoryUpdates.length,
        fileUpdates: changeSet.fileUpdates.length,
        manifests: changeSet.manifestUpdates.length,
        createdNodes: proof.createdNodes.length,
        resultValidationMs: resultValidationCompletedAt - profileStartedAt,
        nodesMs: nodesCompletedAt - resultValidationCompletedAt,
        manifestsMs: manifestsCompletedAt - nodesCompletedAt,
        rootMs: profileCompletedAt - manifestsCompletedAt,
        totalMs,
      });
    }
    return proof;
  }

  entries(
    workspaceFactRootId: string,
    indexKind: WorkspaceAggregateIndexKind
  ): Array<{ key: string; value: string }> {
    const root = this.root(workspaceFactRootId);
    const prefix = `${indexKind}:`;
    return this.walkEntries(
      "workspace-fact",
      "utf16",
      root.rootNodeId,
      root.entryCount,
      workspaceFactRootId
    )
      .filter((entry) => entry.key.startsWith(prefix))
      .map((entry) => ({ key: entry.key.slice(prefix.length), value: entry.value }));
  }

  page(
    workspaceFactRootId: string,
    indexKind: WorkspaceAggregateIndexKind,
    input: { afterKey?: string; limit: number }
  ): { values: Array<{ key: string; value: string }>; total: number; next: string | null } {
    const root = this.root(workspaceFactRootId);
    const keyPrefix = `${indexKind}:`;
    const total =
      indexKind === "repository"
        ? root.repositoryCount
        : indexKind === "live-path"
          ? root.livePathCount
          : root.fileCount;
    const page = this.pageRadix("workspace-fact", "utf16", root.rootNodeId, total, {
      keyPrefix,
      ...(input.afterKey ? { afterKey: `${keyPrefix}${input.afterKey}` } : {}),
      limit: input.limit,
    });
    return {
      values: page.values.map(({ key, value }) => ({
        key: key.slice(keyPrefix.length),
        value,
      })),
      total: page.total,
      next: page.next?.slice(keyPrefix.length) ?? null,
    };
  }

  pageManifest(
    fileManifestId: string,
    input: { afterPath?: string; atOrAfterPath?: string; prefix?: string; limit: number }
  ): { values: Array<{ path: string; fileId: string }>; total: number; next: string | null } {
    if (input.afterPath !== undefined && input.atOrAfterPath !== undefined) {
      throw new SemanticWorkspaceFactsError(
        "InvalidRoot",
        "Manifest page cannot combine exclusive and inclusive lower bounds",
        [fileManifestId]
      );
    }
    const manifest = this.manifest(fileManifestId);
    const page = this.pageRadix(
      "manifest-path",
      "utf16",
      manifest.pathRootNodeId,
      manifest.entryCount,
      {
        ...(input.afterPath ? { afterKey: input.afterPath } : {}),
        ...(input.atOrAfterPath ? { atOrAfterKey: input.atOrAfterPath } : {}),
        ...(input.prefix ? { keyPrefix: input.prefix } : {}),
        limit: input.limit,
      }
    );
    return {
      values: page.values.map(({ key, value }) => ({ path: key, fileId: value })),
      total: page.total,
      next: page.next,
    };
  }

  /** Resolve complete snapshots for several present repositories against one
   * immutable workspace root. Sharing the aggregate-file radix cache and one
   * batched state read avoids repeating the same authenticated root traversal
   * independently for every repository during full workspace publication. */
  materializationSnapshotsAt(
    workspaceFactRootId: string,
    repositories: readonly Extract<WorkspaceRepositoryMember, { presence: "present" }>[]
  ): Map<string, Array<{ path: string; contentHash: string; mode: number }>> {
    const coordinates: Array<{
      repository: Extract<WorkspaceRepositoryMember, { presence: "present" }>;
      path: string;
      fileId: string;
    }> = [];
    for (const repository of repositories) {
      let afterPath: string | undefined;
      do {
        const page = this.pageManifest(repository.fileManifestId, {
          ...(afterPath ? { afterPath } : {}),
          limit: 500,
        });
        for (const entry of page.values) coordinates.push({ repository, ...entry });
        afterPath = page.next ?? undefined;
      } while (afterPath !== undefined);
    }
    const states = this.fileStatesAt(
      workspaceFactRootId,
      coordinates.map(({ fileId }) => fileId)
    );
    const snapshots = new Map<
      string,
      Array<{ path: string; contentHash: string; mode: number }>
    >();
    for (const repository of repositories) snapshots.set(repository.repositoryId, []);
    for (const { repository, path, fileId } of coordinates) {
      const state = states.get(fileId);
      if (
        !state ||
        state.presence !== "placed" ||
        state.repositoryId !== repository.repositoryId ||
        state.path !== path
      ) {
        throw new SemanticWorkspaceFactsError(
          "IndexMismatch",
          `Manifest ${repository.fileManifestId} has no exact file state for ${fileId}`,
          [repository.fileManifestId, fileId]
        );
      }
      snapshots.get(repository.repositoryId)!.push({
        path,
        contentHash: state.contentHash,
        mode: state.mode,
      });
    }
    return snapshots;
  }

  assertIndexParity(workspaceFactRootId: string): void {
    const root = this.root(workspaceFactRootId);
    const repositories = this.entries(workspaceFactRootId, "repository");
    const paths = this.entries(workspaceFactRootId, "live-path");
    const files = this.entries(workspaceFactRootId, "file");
    if (
      repositories.length !== root.repositoryCount ||
      paths.length !== root.livePathCount ||
      files.length !== root.fileCount
    ) {
      throw new SemanticWorkspaceFactsError(
        "IndexMismatch",
        "Workspace fact-kind counts disagree with the committed radix",
        [workspaceFactRootId]
      );
    }
    const pathByRepository = new Map(paths.map((entry) => [entry.value, entry.key]));
    if (pathByRepository.size !== paths.length) {
      throw new SemanticWorkspaceFactsError(
        "IndexMismatch",
        "Workspace repository-path index repeats a repository identity",
        [workspaceFactRootId]
      );
    }
    for (const entry of repositories) {
      const member = this.memberByStateId(entry.value);
      if (!member || member.repositoryId !== entry.key) {
        throw new SemanticWorkspaceFactsError(
          "IndexMismatch",
          `Workspace repository index references an unrealized state for ${entry.key}`,
          [workspaceFactRootId, entry.key, entry.value]
        );
      }
      const indexedPath = pathByRepository.get(entry.key) ?? null;
      const expectedPath = member.presence === "present" ? member.repoPath : null;
      if (indexedPath !== expectedPath) {
        throw new SemanticWorkspaceFactsError(
          "IndexMismatch",
          `Workspace path index disagrees with repository ${entry.key}`,
          [workspaceFactRootId, entry.key, expectedPath ?? "deleted", indexedPath ?? "absent"]
        );
      }
      if (member.presence !== "present") continue;
      const manifest = this.manifest(member.fileManifestId);
      if (manifest.repositoryId !== member.repositoryId) {
        throw new SemanticWorkspaceFactsError(
          "IndexMismatch",
          `Repository ${member.repositoryId} has a cross-owned manifest`,
          [member.repositoryId, manifest.fileManifestId, manifest.repositoryId]
        );
      }
    }
    for (const entry of files) {
      const state = this.fileStateById(entry.value);
      if (!state || state.fileId !== entry.key) {
        throw new SemanticWorkspaceFactsError(
          "IndexMismatch",
          `Workspace file index references an unrealized state for ${entry.key}`,
          [workspaceFactRootId, entry.key, entry.value]
        );
      }
      if (state.presence === "placed") {
        const repository = this.member(workspaceFactRootId, state.repositoryId);
        if (!repository) {
          throw new SemanticWorkspaceFactsError(
            "IndexMismatch",
            `Placed file ${state.fileId} references missing repository ${state.repositoryId}`,
            [state.fileId, state.repositoryId]
          );
        }
        // A deleted repository masks its immutable manifest and member files as
        // one semantic operation. The placed file facts remain reachable for
        // exact restoration but are not live because the repository has no
        // live-path entry.
        if (repository.presence === "deleted") continue;
        const manifestEntry = fileManifestEntryAt({
          manifest: this.manifest(repository.fileManifestId),
          path: state.path,
          readNode: (kind, route, nodeId, prefix) => this.node(kind, route, nodeId, prefix),
        });
        if (manifestEntry?.fileId !== state.fileId) {
          throw new SemanticWorkspaceFactsError(
            "IndexMismatch",
            `Placed file ${state.fileId} is absent from its repository manifest`,
            [state.fileId, repository.fileManifestId, state.path]
          );
        }
      }
    }
  }

  memberByStateId(repositoryStateId: string): WorkspaceRepositoryMember | null {
    const row = this.sql
      .exec(
        `SELECT repository_state_id, repository_id, presence, repo_path,
                file_manifest_id, prior_repository_state_id, tombstone_change_id
           FROM vcs_repository_states WHERE repository_state_id = ?`,
        repositoryStateId
      )
      .toArray()[0] as Row | undefined;
    if (!row) return null;
    const common = {
      repositoryStateId: text(row, "repository_state_id"),
      repositoryId: text(row, "repository_id"),
    };
    const member: WorkspaceRepositoryMember =
      text(row, "presence") === "present"
        ? {
            ...common,
            presence: "present",
            repoPath: text(row, "repo_path"),
            fileManifestId: text(row, "file_manifest_id"),
          }
        : {
            ...common,
            presence: "deleted",
            priorRepositoryStateId: text(row, "prior_repository_state_id"),
            tombstoneChangeId: text(row, "tombstone_change_id"),
          };
    return authenticateWorkspaceRepositoryMember(member);
  }

  fileStateById(fileStateId: string): WorkspaceFileState | null {
    const row = this.sql
      .exec(
        `SELECT file_state_id, file_id, presence, repository_id, path, content_hash,
                mode, content_kind, byte_length, coordinate_extent,
                prior_file_state_id, tombstone_change_id
           FROM vcs_file_states WHERE file_state_id = ?`,
        fileStateId
      )
      .toArray()[0] as Row | undefined;
    if (!row) return null;
    return this.fileStateFromRow(row);
  }

  private fileStateFromRow(row: Row): WorkspaceFileState {
    const state: WorkspaceFileState =
      text(row, "presence") === "placed"
        ? {
            fileStateId: text(row, "file_state_id"),
            fileId: text(row, "file_id"),
            presence: "placed",
            repositoryId: text(row, "repository_id"),
            path: text(row, "path"),
            contentHash: text(row, "content_hash"),
            mode: Number(row["mode"]),
            contentKind: text(row, "content_kind") as "text" | "bytes",
            byteLength: Number(row["byte_length"]),
            coordinateExtent: Number(row["coordinate_extent"]),
          }
        : {
            fileStateId: text(row, "file_state_id"),
            fileId: text(row, "file_id"),
            presence: "deleted",
            priorFileStateId: text(row, "prior_file_state_id"),
            tombstoneChangeId: text(row, "tombstone_change_id"),
          };
    return authenticateWorkspaceFileState(state);
  }

  private assertTouchedManifestStates(
    repositoryId: string,
    pathUpdates: WorkspaceFactChangeSet["manifestUpdates"][number]["pathUpdates"],
    fileUpdateById: ReadonlyMap<string, WorkspaceFactChangeSet["fileUpdates"][number]>
  ): void {
    for (const update of pathUpdates) {
      const fileUpdate = fileUpdateById.get(update.fileId);
      for (const [path, state] of [
        [update.expectedPath, fileUpdate?.expected ?? null],
        [update.resultPath, fileUpdate?.result ?? null],
      ] as const) {
        if (!path) continue;
        if (
          !state ||
          state.presence !== "placed" ||
          state.repositoryId !== repositoryId ||
          state.path !== path ||
          state.fileId !== update.fileId
        ) {
          throw new SemanticWorkspaceFactsError(
            "IndexMismatch",
            `Manifest update for ${update.fileId} references a cross-coordinate file state`,
            [repositoryId, update.fileId, path]
          );
        }
      }
    }
  }

  private persistNodes(nodes: readonly PersistentRadixNode[]): void {
    const uniqueById = new Map<string, PersistentRadixNode>();
    for (const node of nodes) {
      authenticatePersistentRadixNode(node, "");
      const duplicate = uniqueById.get(node.nodeId);
      if (duplicate && canonicalJson(duplicate) !== canonicalJson(node)) {
        throw new SemanticWorkspaceFactsError(
          "InvalidNode",
          `Persistent radix node ${node.nodeId} repeats with a different exact value`,
          [node.nodeId]
        );
      }
      uniqueById.set(node.nodeId, node);
    }
    const uniqueNodes = [...uniqueById.values()];
    const insertedNodeIds = new Set(
      execBatchedInsertReturning(
        this.sql,
        `INSERT OR IGNORE INTO gad_persistent_radix_nodes
         (node_id, index_kind, route_strategy, node_kind, branch_depth, branch_prefix)`,
        6,
        uniqueNodes.map((node) => [
          node.nodeId,
          node.indexKind,
          node.routeStrategy,
          node.shape.kind,
          node.shape.kind === "branch" ? node.shape.depth : null,
          node.shape.kind === "branch" ? node.shape.prefix : null,
        ]),
        " RETURNING node_id"
      ).map((row) => text(row, "node_id"))
    );
    execBatchedInsert(
      this.sql,
      `INSERT INTO gad_persistent_radix_edges
       (node_id, ordinal, slot, child_node_id, entry_key, entry_value)`,
      6,
      uniqueNodes.flatMap((node) => {
        if (!insertedNodeIds.has(node.nodeId)) return [];
        if (node.shape.kind === "branch") {
          return node.shape.children.map((child, ordinal) => [
            node.nodeId,
            ordinal,
            child.slot,
            child.childNodeId,
            null,
            null,
          ]);
        }
        if (node.shape.kind === "leaf") {
          return node.shape.entries.map((entry, ordinal) => [
            node.nodeId,
            ordinal,
            null,
            null,
            entry.key,
            entry.value,
          ]);
        }
        return [];
      })
    );
    for (const node of uniqueNodes) {
      if (insertedNodeIds.has(node.nodeId)) continue;
      // A reused content identity must still prove it denotes the same exact
      // node. This is the collision/corruption path, not the normal write path.
      const exact = this.node(node.indexKind, node.routeStrategy, node.nodeId, "");
      if (!exact || canonicalJson(exact) !== canonicalJson(node)) {
        throw new SemanticWorkspaceFactsError(
          "InvalidNode",
          `Stored persistent radix node ${node.nodeId} differs from its exact value`,
          [node.nodeId]
        );
      }
    }
  }

  private persistManifest(manifest: PersistentFileManifest): void {
    authenticateFileManifest(manifest);
    const stored = this.sql
      .exec(
        `SELECT repository_id, path_root_node_id, entry_count
           FROM vcs_file_manifests WHERE file_manifest_id = ?`,
        manifest.fileManifestId
      )
      .toArray()[0] as Row | undefined;
    if (!stored) {
      this.sql.exec(
        `INSERT INTO vcs_file_manifests
         (file_manifest_id, repository_id, path_root_node_id, entry_count)
         VALUES (?, ?, ?, ?)`,
        manifest.fileManifestId,
        manifest.repositoryId,
        manifest.pathRootNodeId,
        manifest.entryCount
      );
      return;
    }
    if (
      text(stored, "repository_id") !== manifest.repositoryId ||
      text(stored, "path_root_node_id") !== manifest.pathRootNodeId ||
      Number(stored["entry_count"]) !== manifest.entryCount
    ) {
      throw new SemanticWorkspaceFactsError(
        "InvalidRoot",
        `Stored file manifest ${manifest.fileManifestId} differs from its exact value`,
        [manifest.fileManifestId]
      );
    }
  }

  private persistRoot(root: WorkspaceFactRoot): void {
    authenticateWorkspaceFactRoot(root);
    const stored = this.sql
      .exec(
        `SELECT root_node_id, entry_count, repository_count, live_path_count, file_count
           FROM vcs_workspace_fact_roots WHERE workspace_fact_root_id = ?`,
        root.workspaceFactRootId
      )
      .toArray()[0] as Row | undefined;
    if (!stored) {
      this.sql.exec(
        `INSERT INTO vcs_workspace_fact_roots
         (workspace_fact_root_id, root_node_id, entry_count,
          repository_count, live_path_count, file_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
        root.workspaceFactRootId,
        root.rootNodeId,
        root.entryCount,
        root.repositoryCount,
        root.livePathCount,
        root.fileCount
      );
      return;
    }
    if (
      text(stored, "root_node_id") !== root.rootNodeId ||
      Number(stored["entry_count"]) !== root.entryCount ||
      Number(stored["repository_count"]) !== root.repositoryCount ||
      Number(stored["live_path_count"]) !== root.livePathCount ||
      Number(stored["file_count"]) !== root.fileCount
    ) {
      throw new SemanticWorkspaceFactsError(
        "InvalidRoot",
        `Stored workspace facts ${root.workspaceFactRootId} differs from its exact value`,
        [root.workspaceFactRootId]
      );
    }
  }

  private walkEntries(
    indexKind: string,
    routeStrategy: PersistentRadixRouteStrategy,
    rootNodeId: string,
    expectedCount: number,
    rootHandle: string
  ): Array<{ key: string; value: string }> {
    const result: Array<{ key: string; value: string }> = [];
    const visited = new Set<string>();
    const walk = (nodeId: string, expectedPrefix: string): void => {
      if (visited.has(nodeId)) this.invalidNode(nodeId, `root ${rootHandle} repeats a node`);
      visited.add(nodeId);
      const node = this.node(indexKind, routeStrategy, nodeId, expectedPrefix);
      if (!node) this.invalidNode(nodeId, `root ${rootHandle} references a missing node`);
      if (node!.shape.kind === "empty") return;
      if (node!.shape.kind === "leaf") {
        for (const entry of node!.shape.entries)
          result.push({ key: entry.key, value: entry.value });
        return;
      }
      for (const child of node!.shape.children) {
        walk(child.childNodeId, `${node!.shape.prefix}${child.slot.toString(16)}`);
      }
    };
    walk(rootNodeId, "");
    result.sort((left, right) => compareUtf16CodeUnits(left.key, right.key));
    if (
      result.length !== expectedCount ||
      result.some((entry, index) => index > 0 && result[index - 1]!.key === entry.key)
    ) {
      throw new SemanticWorkspaceFactsError(
        "InvalidRoot",
        `Persistent radix root ${rootHandle} has ${result.length} entries; expected ${expectedCount}`,
        [rootHandle]
      );
    }
    return result;
  }

  private pageRadix(
    indexKind: string,
    routeStrategy: PersistentRadixRouteStrategy,
    rootNodeId: string,
    total: number,
    input: { afterKey?: string; atOrAfterKey?: string; keyPrefix?: string; limit: number }
  ): { values: Array<{ key: string; value: string }>; total: number; next: string | null } {
    const limit = Math.max(1, Math.trunc(input.limit));
    if (input.afterKey !== undefined && input.atOrAfterKey !== undefined) {
      this.invalidNode(rootNodeId, "page cannot combine exclusive and inclusive lower bounds");
    }
    const lowerKey = input.afterKey ?? input.atOrAfterKey;
    const lowerRoute = lowerKey ? persistentRadixRoute(routeStrategy, lowerKey) : null;
    const lowerInclusive = input.atOrAfterKey !== undefined;
    if (input.keyPrefix && routeStrategy !== "utf16") {
      this.invalidNode(rootNodeId, "prefix paging requires a lexical radix");
    }
    const requiredRoutePrefix = input.keyPrefix
      ? persistentRadixUtf16PrefixRoute(input.keyPrefix)
      : null;
    const values: Array<{ key: string; value: string; route: string }> = [];
    const visited = new Set<string>();
    const walk = (nodeId: string, expectedPrefix: string): void => {
      if (values.length > limit) return;
      if (visited.has(nodeId)) this.invalidNode(nodeId, "bounded page repeats a node");
      visited.add(nodeId);
      const node = this.node(indexKind, routeStrategy, nodeId, expectedPrefix);
      if (!node) this.invalidNode(nodeId, "bounded page references a missing node");
      if (node!.shape.kind === "empty") return;
      if (node!.shape.kind === "leaf") {
        for (const entry of node!.shape.entries) {
          if (input.keyPrefix && !entry.key.startsWith(input.keyPrefix)) continue;
          const lowerComparison =
            lowerKey === undefined ? 1 : compareUtf16CodeUnits(entry.key, lowerKey);
          if (
            lowerRoute &&
            (entry.keyDigest < lowerRoute ||
              (entry.keyDigest === lowerRoute &&
                (lowerInclusive ? lowerComparison < 0 : lowerComparison <= 0)))
          ) {
            continue;
          }
          values.push({ key: entry.key, value: entry.value, route: entry.keyDigest });
          if (values.length > limit) return;
        }
        return;
      }
      for (const child of node!.shape.children) {
        const childPrefix = `${node!.shape.prefix}${child.slot.toString(16)}`;
        if (
          requiredRoutePrefix &&
          !requiredRoutePrefix.startsWith(childPrefix) &&
          !childPrefix.startsWith(requiredRoutePrefix)
        ) {
          continue;
        }
        if (lowerRoute && childPrefix < lowerRoute.slice(0, childPrefix.length)) continue;
        walk(child.childNodeId, childPrefix);
        if (values.length > limit) return;
      }
    };
    walk(rootNodeId, "");
    values.sort((left, right) =>
      left.route === right.route
        ? compareUtf16CodeUnits(left.key, right.key)
        : compareUtf16CodeUnits(left.route, right.route)
    );
    const hasMore = values.length > limit;
    const page = values.slice(0, limit).map(({ key, value }) => ({ key, value }));
    return { values: page, total, next: hasMore ? page.at(-1)!.key : null };
  }

  private invalidNode(nodeId: string, message: string): never {
    throw new SemanticWorkspaceFactsError(
      "InvalidNode",
      `Persistent radix node ${nodeId}: ${message}`,
      [nodeId]
    );
  }
}
