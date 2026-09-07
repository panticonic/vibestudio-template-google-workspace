import { compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import { canonicalDigest, compactId, SEMANTIC_PROTOCOL } from "./identity.js";

/** Generic, authenticated radix indices.  Routing is an explicit part of the
 * root/node identity; index names never acquire hidden routing semantics. */
export type PersistentRadixIndexKind = string;
export type PersistentRadixRouteStrategy = "hashed" | "utf16";

export interface PersistentRadixLeafEntry {
  key: string;
  value: string;
  keyDigest: string;
}

export type PersistentRadixNodeShape =
  | { kind: "empty" }
  | {
      kind: "branch";
      depth: number;
      /** Full route prefix skipped before the branching nibble. */
      prefix: string;
      children: readonly { slot: number; childNodeId: string }[];
    }
  | { kind: "leaf"; entries: readonly PersistentRadixLeafEntry[] };

export interface PersistentRadixNode {
  nodeId: string;
  indexKind: PersistentRadixIndexKind;
  routeStrategy: PersistentRadixRouteStrategy;
  shape: PersistentRadixNodeShape;
}

export type PersistentRadixNodeReader = (
  indexKind: PersistentRadixIndexKind,
  routeStrategy: PersistentRadixRouteStrategy,
  nodeId: string,
  expectedPrefix: string
) => PersistentRadixNode | null;

export class PersistentRadixError extends Error {
  constructor(
    readonly code:
      | "InvalidRoot"
      | "InvalidNode"
      | "MissingNode"
      | "RepeatedNode"
      | "InvalidUpdate"
      | "ExpectedMemberMismatch"
      | "DestinationOccupied",
    message: string,
    readonly handles: readonly string[] = []
  ) {
    super(message);
    this.name = "PersistentRadixError";
  }
}

export const PERSISTENT_RADIX_BITS = 4;
export const PERSISTENT_RADIX = 1 << PERSISTENT_RADIX_BITS;
export const PERSISTENT_RADIX_HASH_NIBBLES = 64;

export function persistentRadixUtf16PrefixRoute(prefix: string): string {
  if (!prefix) {
    throw new PersistentRadixError(
      "InvalidUpdate",
      "persistent radix lexical prefixes are nonempty"
    );
  }
  let route = "";
  for (let index = 0; index < prefix.length; index += 1) {
    const codeUnit = prefix.charCodeAt(index);
    if (codeUnit === 0) {
      throw new PersistentRadixError(
        "InvalidUpdate",
        "persistent radix lexical keys cannot contain the NUL terminator"
      );
    }
    route += codeUnit.toString(16).padStart(4, "0");
  }
  return route;
}

function utf16PathRoute(path: string): string {
  return `${persistentRadixUtf16PrefixRoute(path)}0000`;
}

export function persistentRadixRoute(
  routeStrategy: PersistentRadixRouteStrategy,
  key: string
): string {
  if (!key) {
    throw new PersistentRadixError(
      "InvalidUpdate",
      "persistent radix domains and keys are nonempty"
    );
  }
  return routeStrategy === "utf16"
    ? utf16PathRoute(key)
    : canonicalDigest("persistent-radix-key", key);
}

const canonicalEntries = (
  entries: readonly PersistentRadixLeafEntry[]
): PersistentRadixLeafEntry[] =>
  [...entries]
    .map((entry) => ({ ...entry }))
    .sort((left, right) => compareUtf16CodeUnits(left.key, right.key));

const canonicalChildren = (
  children: readonly { slot: number; childNodeId: string }[]
): Array<{ slot: number; childNodeId: string }> =>
  [...children].map((child) => ({ ...child })).sort((left, right) => left.slot - right.slot);

function nodePayload(
  indexKind: PersistentRadixIndexKind,
  routeStrategy: PersistentRadixRouteStrategy,
  shape: PersistentRadixNodeShape
) {
  switch (shape.kind) {
    case "empty":
      return {
        kind: "empty",
        indexKind,
        routeStrategy,
        protocol: SEMANTIC_PROTOCOL,
        radixBits: PERSISTENT_RADIX_BITS,
      };
    case "branch":
      return {
        kind: "branch",
        indexKind,
        routeStrategy,
        depth: shape.depth,
        prefix: shape.prefix,
        children: canonicalChildren(shape.children),
      };
    case "leaf":
      return { kind: "leaf", indexKind, routeStrategy, entries: canonicalEntries(shape.entries) };
  }
}

export function persistentRadixNodeIdentity(
  indexKind: PersistentRadixIndexKind,
  routeStrategy: PersistentRadixRouteStrategy,
  shape: PersistentRadixNodeShape
): PersistentRadixNode {
  if (!indexKind) {
    throw new PersistentRadixError("InvalidNode", "persistent radix domain is nonempty");
  }
  const payload = nodePayload(indexKind, routeStrategy, shape);
  return {
    nodeId: compactId("radixn", payload),
    indexKind,
    routeStrategy,
    shape:
      shape.kind === "branch"
        ? {
            kind: "branch",
            depth: shape.depth,
            prefix: shape.prefix,
            children: canonicalChildren(shape.children),
          }
        : shape.kind === "leaf"
          ? { kind: "leaf", entries: canonicalEntries(shape.entries) }
          : { kind: "empty" },
  };
}

export function emptyPersistentRadixNode(
  indexKind: PersistentRadixIndexKind,
  routeStrategy: PersistentRadixRouteStrategy
): PersistentRadixNode {
  return persistentRadixNodeIdentity(indexKind, routeStrategy, { kind: "empty" });
}

const routeIsCanonical = (routeStrategy: PersistentRadixRouteStrategy, value: string): boolean =>
  routeStrategy === "utf16" ? /^(?:[0-9a-f]{4})+$/.test(value) : /^[0-9a-f]{64}$/.test(value);

export function authenticatePersistentRadixNode(
  node: PersistentRadixNode,
  expectedPrefix: string
): PersistentRadixNode {
  if (node.shape.kind === "branch") {
    const children = canonicalChildren(node.shape.children);
    if (
      !/^[0-9a-f]*$/.test(expectedPrefix) ||
      !/^[0-9a-f]*$/.test(node.shape.prefix) ||
      node.shape.depth !== node.shape.prefix.length ||
      !node.shape.prefix.startsWith(expectedPrefix) ||
      !Number.isSafeInteger(node.shape.depth) ||
      children.length < 1 ||
      children.length > PERSISTENT_RADIX ||
      children.some(
        (child, index) =>
          !child.childNodeId ||
          !Number.isSafeInteger(child.slot) ||
          child.slot < 0 ||
          child.slot >= PERSISTENT_RADIX ||
          (index > 0 && children[index - 1]!.slot === child.slot)
      )
    ) {
      throw new PersistentRadixError("InvalidNode", "repository-state map branch is invalid", [
        node.nodeId,
      ]);
    }
  } else if (node.shape.kind === "leaf") {
    const entries = canonicalEntries(node.shape.entries);
    if (
      entries.length < 1 ||
      entries.some(
        (entry, index) =>
          !entry.key ||
          !entry.value ||
          !routeIsCanonical(node.routeStrategy, entry.keyDigest) ||
          !entry.keyDigest.startsWith(expectedPrefix) ||
          entry.keyDigest !== persistentRadixRoute(node.routeStrategy, entry.key) ||
          (index > 0 && entries[index - 1]!.key === entry.key)
      ) ||
      entries.some((entry) => entry.keyDigest !== entries[0]!.keyDigest)
    ) {
      throw new PersistentRadixError("InvalidNode", "repository-state map leaf is invalid", [
        node.nodeId,
      ]);
    }
  }
  const exact = persistentRadixNodeIdentity(node.indexKind, node.routeStrategy, node.shape);
  if (exact.nodeId !== node.nodeId) {
    throw new PersistentRadixError(
      "InvalidNode",
      `repository-state map node ${node.nodeId} failed content authentication`,
      [node.nodeId]
    );
  }
  return exact;
}

const slotAt = (route: string, depth: number): number => {
  const value = route[depth];
  if (value === undefined) {
    throw new PersistentRadixError(
      "InvalidNode",
      `persistent radix route ended before branch depth ${depth}`
    );
  }
  return Number.parseInt(value, 16);
};

interface MutableComposition {
  readonly readNode: PersistentRadixNodeReader;
  readonly routeStrategy: PersistentRadixRouteStrategy;
  readonly created: Map<string, PersistentRadixNode>;
  readonly reused: Set<string>;
}

function loadNode(
  composition: MutableComposition,
  indexKind: PersistentRadixIndexKind,
  nodeId: string,
  expectedPrefix: string,
  path: ReadonlySet<string>
): PersistentRadixNode {
  if (path.has(nodeId)) {
    throw new PersistentRadixError("RepeatedNode", `repository map repeats node ${nodeId}`, [
      nodeId,
    ]);
  }
  const node =
    composition.created.get(nodeId) ??
    composition.readNode(indexKind, composition.routeStrategy, nodeId, expectedPrefix);
  if (!node) {
    throw new PersistentRadixError("MissingNode", `repository map misses node ${nodeId}`, [nodeId]);
  }
  if (node.indexKind !== indexKind || node.routeStrategy !== composition.routeStrategy) {
    throw new PersistentRadixError("InvalidNode", `repository map crosses index kinds`, [
      nodeId,
      indexKind,
      node.indexKind,
      node.routeStrategy,
    ]);
  }
  if (!composition.created.has(nodeId)) composition.reused.add(nodeId);
  return authenticatePersistentRadixNode(node, expectedPrefix);
}

function pointLookup(
  composition: MutableComposition,
  indexKind: PersistentRadixIndexKind,
  rootNodeId: string,
  key: string
): PersistentRadixLeafEntry | null {
  const digest = persistentRadixRoute(composition.routeStrategy, key);
  if (!routeIsCanonical(composition.routeStrategy, digest)) {
    throw new PersistentRadixError("InvalidUpdate", "persistent radix key route is invalid", [key]);
  }
  let nodeId = rootNodeId;
  let expectedPrefix = "";
  const path = new Set<string>();
  while (true) {
    const node = loadNode(composition, indexKind, nodeId, expectedPrefix, path);
    path.add(nodeId);
    if (node.shape.kind === "empty") return null;
    if (node.shape.kind === "leaf")
      return node.shape.entries.find((entry) => entry.key === key) ?? null;
    if (!digest.startsWith(node.shape.prefix)) return null;
    const branchDepth = node.shape.depth;
    const child = node.shape.children.find(
      (candidate) => candidate.slot === slotAt(digest, branchDepth)
    );
    if (!child) return null;
    nodeId = child.childNodeId;
    expectedPrefix = `${node.shape.prefix}${child.slot.toString(16)}`;
  }
}

function rememberNode(
  composition: MutableComposition,
  indexKind: PersistentRadixIndexKind,
  shape: PersistentRadixNodeShape
): PersistentRadixNode {
  const node = persistentRadixNodeIdentity(indexKind, composition.routeStrategy, shape);
  composition.created.set(node.nodeId, node);
  return node;
}

function branchChain(
  composition: MutableComposition,
  indexKind: PersistentRadixIndexKind,
  depth: number,
  leftDigest: string,
  leftNodeId: string,
  rightDigest: string,
  rightNodeId: string
): PersistentRadixNode {
  let divergence = depth;
  while (
    divergence < leftDigest.length &&
    divergence < rightDigest.length &&
    slotAt(leftDigest, divergence) === slotAt(rightDigest, divergence)
  ) {
    divergence += 1;
  }
  if (divergence >= leftDigest.length || divergence >= rightDigest.length) {
    throw new PersistentRadixError(
      "InvalidUpdate",
      "distinct persistent radix domains and keys produced a non-divergent route"
    );
  }
  return rememberNode(composition, indexKind, {
    kind: "branch",
    depth: divergence,
    prefix: leftDigest.slice(0, divergence),
    children: [
      { slot: slotAt(leftDigest, divergence), childNodeId: leftNodeId },
      { slot: slotAt(rightDigest, divergence), childNodeId: rightNodeId },
    ],
  });
}

function setAt(
  composition: MutableComposition,
  indexKind: PersistentRadixIndexKind,
  nodeId: string,
  expectedPrefix: string,
  entry: PersistentRadixLeafEntry,
  path: ReadonlySet<string>
): PersistentRadixNode {
  const node = loadNode(composition, indexKind, nodeId, expectedPrefix, path);
  const nextPath = new Set(path).add(nodeId);
  if (node.shape.kind === "empty") {
    return rememberNode(composition, indexKind, { kind: "leaf", entries: [entry] });
  }
  if (node.shape.kind === "leaf") {
    const index = node.shape.entries.findIndex((candidate) => candidate.key === entry.key);
    if (index >= 0) {
      return rememberNode(composition, indexKind, {
        kind: "leaf",
        entries: node.shape.entries.map((candidate, ordinal) =>
          ordinal === index ? entry : candidate
        ),
      });
    }
    const leafDigest = node.shape.entries[0]!.keyDigest;
    if (leafDigest === entry.keyDigest) {
      return rememberNode(composition, indexKind, {
        kind: "leaf",
        entries: [...node.shape.entries, entry],
      });
    }
    const added = rememberNode(composition, indexKind, { kind: "leaf", entries: [entry] });
    return branchChain(
      composition,
      indexKind,
      expectedPrefix.length,
      leafDigest,
      node.nodeId,
      entry.keyDigest,
      added.nodeId
    );
  }
  if (!entry.keyDigest.startsWith(node.shape.prefix)) {
    const added = rememberNode(composition, indexKind, { kind: "leaf", entries: [entry] });
    return branchChain(
      composition,
      indexKind,
      expectedPrefix.length,
      node.shape.prefix,
      node.nodeId,
      entry.keyDigest,
      added.nodeId
    );
  }
  const slot = slotAt(entry.keyDigest, node.shape.depth);
  const child = node.shape.children.find((candidate) => candidate.slot === slot);
  const replacement = child
    ? setAt(
        composition,
        indexKind,
        child.childNodeId,
        `${node.shape.prefix}${slot.toString(16)}`,
        entry,
        nextPath
      )
    : rememberNode(composition, indexKind, { kind: "leaf", entries: [entry] });
  return rememberNode(composition, indexKind, {
    kind: "branch",
    depth: node.shape.depth,
    prefix: node.shape.prefix,
    children: [
      ...node.shape.children.filter((candidate) => candidate.slot !== slot),
      { slot, childNodeId: replacement.nodeId },
    ],
  });
}

function deleteAt(
  composition: MutableComposition,
  indexKind: PersistentRadixIndexKind,
  nodeId: string,
  expectedPrefix: string,
  key: string,
  digest: string,
  path: ReadonlySet<string>
): PersistentRadixNode {
  const node = loadNode(composition, indexKind, nodeId, expectedPrefix, path);
  const nextPath = new Set(path).add(nodeId);
  if (node.shape.kind === "empty") {
    throw new PersistentRadixError(
      "ExpectedMemberMismatch",
      `repository map key ${key} is absent`,
      [key]
    );
  }
  if (node.shape.kind === "leaf") {
    const entries = node.shape.entries.filter((entry) => entry.key !== key);
    if (entries.length === node.shape.entries.length) {
      throw new PersistentRadixError(
        "ExpectedMemberMismatch",
        `repository map key ${key} is absent`,
        [key]
      );
    }
    return rememberNode(
      composition,
      indexKind,
      entries.length === 0 ? { kind: "empty" } : { kind: "leaf", entries }
    );
  }
  if (!digest.startsWith(node.shape.prefix)) {
    throw new PersistentRadixError(
      "ExpectedMemberMismatch",
      `persistent radix key ${key} is absent`,
      [key]
    );
  }
  const slot = slotAt(digest, node.shape.depth);
  const child = node.shape.children.find((candidate) => candidate.slot === slot);
  if (!child) {
    throw new PersistentRadixError(
      "ExpectedMemberMismatch",
      `repository map key ${key} is absent`,
      [key]
    );
  }
  const replacement = deleteAt(
    composition,
    indexKind,
    child.childNodeId,
    `${node.shape.prefix}${slot.toString(16)}`,
    key,
    digest,
    nextPath
  );
  const children =
    replacement.shape.kind === "empty"
      ? node.shape.children.filter((candidate) => candidate.slot !== slot)
      : [
          ...node.shape.children.filter((candidate) => candidate.slot !== slot),
          { slot, childNodeId: replacement.nodeId },
        ];
  if (children.length === 0) return rememberNode(composition, indexKind, { kind: "empty" });
  if (children.length === 1) {
    return loadNode(composition, indexKind, children[0]!.childNodeId, expectedPrefix, nextPath);
  }
  return rememberNode(composition, indexKind, {
    kind: "branch",
    depth: node.shape.depth,
    prefix: node.shape.prefix,
    children,
  });
}

/** A root descriptor, embedded in an authenticated semantic owner such as a
 * WorkspaceFactRoot or PersistentFileManifest. Nodes carry the authenticated
 * route strategy; the descriptor deliberately has no second identity. */
export interface PersistentRadixRoot {
  indexKind: PersistentRadixIndexKind;
  routeStrategy: PersistentRadixRouteStrategy;
  rootNodeId: string;
  entryCount: number;
}

export interface PersistentRadixUpdate {
  key: string;
  expectedValue: string | null;
  resultValue: string | null;
}

export interface PersistentRadixMutationProof {
  basisRootNodeId: string;
  resultRoot: PersistentRadixRoot;
  updates: readonly PersistentRadixUpdate[];
  createdNodes: readonly PersistentRadixNode[];
  reusedNodeIds: readonly string[];
}

export function persistentRadixRootIdentity(input: {
  indexKind: PersistentRadixIndexKind;
  routeStrategy: PersistentRadixRouteStrategy;
  rootNodeId: string;
  entryCount: number;
}): PersistentRadixRoot {
  if (
    !input.indexKind ||
    !input.rootNodeId ||
    !Number.isSafeInteger(input.entryCount) ||
    input.entryCount < 0
  ) {
    throw new PersistentRadixError("InvalidRoot", "persistent radix root is invalid");
  }
  return {
    indexKind: input.indexKind,
    routeStrategy: input.routeStrategy,
    rootNodeId: input.rootNodeId,
    entryCount: input.entryCount,
  };
}

export function authenticatePersistentRadixRoot(root: PersistentRadixRoot): void {
  persistentRadixRootIdentity(root);
}

export function emptyPersistentRadixRoot(
  indexKind: PersistentRadixIndexKind,
  routeStrategy: PersistentRadixRouteStrategy
): {
  root: PersistentRadixRoot;
  node: PersistentRadixNode;
} {
  const node = emptyPersistentRadixNode(indexKind, routeStrategy);
  return {
    root: persistentRadixRootIdentity({
      indexKind,
      routeStrategy,
      rootNodeId: node.nodeId,
      entryCount: 0,
    }),
    node,
  };
}

const canonicalPersistentRadixUpdates = (
  updates: readonly PersistentRadixUpdate[]
): PersistentRadixUpdate[] =>
  [...updates]
    .map((update) => ({ ...update }))
    .sort((left, right) => compareUtf16CodeUnits(left.key, right.key));

/**
 * Point updates repeatedly replace the immutable path from the changed leaf to
 * the root. Earlier paths remain in the composition cache so later updates can
 * read them, but they are not part of the final tree and therefore are not
 * part of the mutation proof that must be persisted.
 */
function reachableCreatedNodes(
  rootNodeId: string,
  created: ReadonlyMap<string, PersistentRadixNode>
): PersistentRadixNode[] {
  const reachable = new Set<string>();
  const pending = [rootNodeId];
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (reachable.has(nodeId)) continue;
    const node = created.get(nodeId);
    if (!node) continue;
    reachable.add(nodeId);
    if (node.shape.kind === "branch") {
      for (const child of node.shape.children) pending.push(child.childNodeId);
    }
  }
  return [...created.values()].filter((node) => reachable.has(node.nodeId));
}

/** Construct the canonical compressed radix for a complete set of entries.
 * This is equivalent to repeated setAt() calls but avoids rebuilding the
 * immutable root path after every insertion when the authenticated basis is
 * empty. */
function buildCompleteRadix(
  composition: MutableComposition,
  indexKind: PersistentRadixIndexKind,
  entries: readonly PersistentRadixLeafEntry[],
  expectedPrefix: string
): PersistentRadixNode {
  if (entries.length === 0) {
    return rememberNode(composition, indexKind, { kind: "empty" });
  }
  const firstRoute = entries[0]!.keyDigest;
  if (entries.every((entry) => entry.keyDigest === firstRoute)) {
    return rememberNode(composition, indexKind, { kind: "leaf", entries });
  }
  let divergence = expectedPrefix.length;
  while (
    divergence < firstRoute.length &&
    entries.every((entry) => entry.keyDigest[divergence] === firstRoute[divergence])
  ) {
    divergence += 1;
  }
  if (divergence >= firstRoute.length) {
    throw new PersistentRadixError(
      "InvalidUpdate",
      "distinct persistent radix entries produced a non-divergent route"
    );
  }
  const prefix = firstRoute.slice(0, divergence);
  const bySlot = new Map<number, PersistentRadixLeafEntry[]>();
  for (const entry of entries) {
    const slot = slotAt(entry.keyDigest, divergence);
    const group = bySlot.get(slot) ?? [];
    group.push(entry);
    bySlot.set(slot, group);
  }
  const children = [...bySlot.entries()].map(([slot, group]) => ({
    slot,
    childNodeId: buildCompleteRadix(
      composition,
      indexKind,
      group,
      `${prefix}${slot.toString(16)}`
    ).nodeId,
  }));
  return rememberNode(composition, indexKind, {
    kind: "branch",
    depth: divergence,
    prefix,
    children,
  });
}

export function composePersistentRadix(input: {
  basis: PersistentRadixRoot;
  updates: readonly PersistentRadixUpdate[];
  readNode: PersistentRadixNodeReader;
}): PersistentRadixMutationProof {
  authenticatePersistentRadixRoot(input.basis);
  const updates = canonicalPersistentRadixUpdates(input.updates);
  if (
    updates.length === 0 ||
    updates.some(
      (update, index) =>
        !update.key ||
        update.expectedValue === update.resultValue ||
        (update.resultValue !== null && !update.resultValue) ||
        (index > 0 && updates[index - 1]!.key === update.key)
    )
  ) {
    throw new PersistentRadixError(
      "InvalidUpdate",
      "persistent radix update is empty, duplicate, incomplete, or effect-free"
    );
  }
  const composition: MutableComposition = {
    readNode: input.readNode,
    routeStrategy: input.basis.routeStrategy,
    created: new Map(),
    reused: new Set(),
  };
  const completeInitialization =
    input.basis.entryCount === 0 &&
    updates.every((update) => update.expectedValue === null && update.resultValue !== null);
  if (completeInitialization) {
    const basisNode = loadNode(
      composition,
      input.basis.indexKind,
      input.basis.rootNodeId,
      "",
      new Set()
    );
    if (basisNode.shape.kind !== "empty") {
      throw new PersistentRadixError(
        "InvalidRoot",
        "zero-entry persistent radix basis is not empty",
        [input.basis.rootNodeId]
      );
    }
    const entries = updates.map((update) => ({
      key: update.key,
      value: update.resultValue!,
      keyDigest: persistentRadixRoute(input.basis.routeStrategy, update.key),
    }));
    const result = buildCompleteRadix(composition, input.basis.indexKind, entries, "");
    return {
      basisRootNodeId: input.basis.rootNodeId,
      resultRoot: persistentRadixRootIdentity({
        indexKind: input.basis.indexKind,
        routeStrategy: input.basis.routeStrategy,
        rootNodeId: result.nodeId,
        entryCount: entries.length,
      }),
      updates,
      createdNodes: reachableCreatedNodes(result.nodeId, composition.created),
      reusedNodeIds: [input.basis.rootNodeId],
    };
  }
  let rootNodeId = input.basis.rootNodeId;
  let entryCount = input.basis.entryCount;
  for (const update of updates) {
    const observed = pointLookup(composition, input.basis.indexKind, rootNodeId, update.key);
    if ((observed?.value ?? null) !== update.expectedValue) {
      throw new PersistentRadixError(
        "ExpectedMemberMismatch",
        `persistent radix key ${update.key} changed from its exact expectation`,
        [input.basis.rootNodeId, update.key]
      );
    }
  }
  for (const update of updates) {
    if (update.resultValue === null) {
      rootNodeId = deleteAt(
        composition,
        input.basis.indexKind,
        rootNodeId,
        "",
        update.key,
        persistentRadixRoute(input.basis.routeStrategy, update.key),
        new Set()
      ).nodeId;
      entryCount -= 1;
      continue;
    }
    rootNodeId = setAt(
      composition,
      input.basis.indexKind,
      rootNodeId,
      "",
      {
        key: update.key,
        value: update.resultValue,
        keyDigest: persistentRadixRoute(input.basis.routeStrategy, update.key),
      },
      new Set()
    ).nodeId;
    if (update.expectedValue === null) entryCount += 1;
  }
  const resultRoot = persistentRadixRootIdentity({
    indexKind: input.basis.indexKind,
    routeStrategy: input.basis.routeStrategy,
    rootNodeId,
    entryCount,
  });
  const createdIds = new Set(composition.created.keys());
  return {
    basisRootNodeId: input.basis.rootNodeId,
    resultRoot,
    updates,
    createdNodes: reachableCreatedNodes(resultRoot.rootNodeId, composition.created),
    reusedNodeIds: [...composition.reused]
      .filter((nodeId) => !createdIds.has(nodeId))
      .sort(compareUtf16CodeUnits),
  };
}

export function persistentRadixEntryAt(input: {
  root: PersistentRadixRoot;
  key: string;
  readNode: PersistentRadixNodeReader;
}): { key: string; value: string } | null {
  authenticatePersistentRadixRoot(input.root);
  const entry = pointLookup(
    {
      readNode: input.readNode,
      routeStrategy: input.root.routeStrategy,
      created: new Map(),
      reused: new Set(),
    },
    input.root.indexKind,
    input.root.rootNodeId,
    input.key
  );
  return entry ? { key: entry.key, value: entry.value } : null;
}
