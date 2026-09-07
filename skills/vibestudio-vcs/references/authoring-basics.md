# Managed authoring

## Use the runtime client

In eval and runtime code, import the goal-shaped client instead of assembling
raw RPC transport calls:

```ts
import { contextId, vcs } from "@workspace/runtime";

const status = await vcs.status({ contextId });
const repository = await vcs.resolveRepository({
  state: status.workingHead,
  repoPath: "projects/example",
});
```

Every `vcs` method accepts its documented request object directly. Do not wrap
that object in an argument array or use `rpc.call("main", "vcs.*", ...)` when
the runtime client is available; that lower-level transport adds no capability
and makes argument mistakes harder to diagnose. In an ordinary chat turn,
prefer the compact `vcs` tool (including its commit operation) plus `apply_patch`
for coherent multi-file changes and the focused `write`, `edit`, `move_file`,
and `copy_file` tools described by the parent skill.

## Discover identities before changing them

Call `vcs.status` and retain its exact `workingHead`. Resolve a known workspace
repository path at that state with `vcs.resolveRepository`; a `null` result
means the repository is absent there. Then use `vcs.listFiles` with the returned
stable `repositoryId`. Do not scan all state neighbors merely to turn one known
path into its identity. A file listing supplies stable `repositoryId`, `fileId`,
path, content digest, authoring change/work-unit IDs, persisted `contentClass`
and `externalKeys`, mode, `contentKind`, `byteLength`, and `coordinateExtent`.
Inside an agent, browse with `ls`, `find`, and `read`; these use the same
context-scoped filesystem as injected JavaScript `fs` and resolve semantic
repository state in the background. Use full workspace paths for compact
`blame`. When an agent genuinely needs a typed semantic root, obtain it from a
semantic operation rather than using VCS as a second filesystem browser.

Read a managed file with `vcs.readFile` at the same state. Prefer a stable file
ID after discovery; use a path only to resolve the initial identity. A `null`
result means the file is absent at that exact state. This method is
semantic-only: always pass `state`, `repositoryId`, and a typed file selector.
For the same state and file ID, `listFiles` and `readFile` must return identical
`authoredChangeId`, `authoredByWorkUnitId`, `contentClass`, and `externalKeys`;
stop with an integrity failure if they disagree.
Use `fs` to read a host or materialized path. Do not look for a raw VCS variant
or expect VCS to fall back to disk.

Inside an agent, ordinary `read` of managed text is also the default memory
surface. After reading the exact bytes, the harness asks `vcs.readMemory` for
the displayed UTF-16 range and includes the bytes' content hash. The service
attaches only memory for that exact working-head file state, or reports a stale
read in structured details instead of attaching history from different bytes
or adding warning prose to the file content. The visible
**workspace memory** block answers why the displayed lines exist using
tier-labeled intent, merge-arrival context, independently labeled commit
evidence, and intent-annotated file history. It samples for coverage, orders
surprise before routine work, collapses the reading context's own work, and
gives compact, complete continuations while retaining exact content identities
and opaque service cursors inside the harness. This is a projection of canonical GAD
facts, not a second claims store.

Do not ask the model to choose a provenance level or recall keywords before
reading. Do not repeat a graph walk when the attachment is already conclusive.
Use the focused `provenance` tool only when its continuation reveals a question
that needs a larger graph walk. Direct runtime clients
may call `vcs.readMemory` for the same exact path/hash/range contract; ordinary
historical reads at an explicitly selected state still use `vcs.readFile`.

## Author one coherent local step

Use `edit` for ordinary changes confined to one text file. Use `apply_patch`
when several files must change atomically, or for a whole binary write,
deletion, or mode change. Its exact replacement strings are preconditions, not
fuzzy search instructions: a mismatch changes nothing and returns the current
content hash plus bounded nearby excerpts for re-observation. Both tools compile
to the same semantic edit operation. Use direct `vcs.edit` when repository
creation or a lower-level stable-identity batch is required.
The focused `edit` tool treats unchanged oldText/newText surroundings as match
anchors: only actual differing UTF-16 ranges become authored edits, so a
neighboring unchanged line retains its existing provenance.

The in-agent authoring tools supply the exact current tool invocation as causal
ingress. A linked agent credential without that parent may perform the
discovery and reads above but cannot author this step. An authorized paired or
direct human CLI may mutate without an agent parent; its causal walk ends
honestly at the admitted command. Do not create an adapter invocation merely
to make direct work appear agent-authored.

For a direct causally bound service request, supply:

- the current context ID;
- the exact expected working head;
- one globally unique command ID;
- one or more changes over stable repository/file identities;
- optional `intentSummary` only when the author explicitly supplied meaningful
  purpose. Agent-facing tools expose this as `intent`; never manufacture a
  summary from the operation or path.

The intent stated here is the tier-labeled reason the next reader sees above
these lines; omitted intent remains honestly `trigger` or `mechanical`.

Treat one edit request as one work unit and one local application. Keep the
returned `workingHead`, `workUnitId`, `applicationId`, and `changeIds` when the
task needs later inspection, revert, or explanation.

Text edit offsets are UTF-16 coordinates over the exact text read from the same
basis. The placed file state owns that coordinate domain:

- text has `contentKind: "text"`, byte storage length in `byteLength`, and
  UTF-16 code-unit length in `coordinateExtent`;
- opaque bytes have `contentKind: "bytes"` and equal `byteLength` and
  `coordinateExtent`.

Re-read before computing offsets after another mutation. Do not send a
coordinate-kind hint or infer text length from byte length; the service derives
the unit from the exact state and validates every range against its extent.

## Keep semantics explicit

- Create a new repository at a verified vacant workspace path with one
  `repository-create` change containing its complete initial file set. The
  repository identity and files are authored in one lifecycle work unit; do
  not use `repository-create` for an existing project, `mkdir` a managed path,
  or loop over writes to synthesize the lifecycle.
- Create a file with a destination repository and vacant path.
- Delete or change mode by stable file identity.
- Use `vcs.move` for a location change and `vcs.copy` for a new identity with
  source lineage; do not encode either as delete-plus-create.
- Use `vcs.importSnapshot` when content crosses an external provenance
  boundary. It authors ordinary changes under one import work unit.

## Continue or recover

After success, continue from the returned working head. On `RevisionChanged`,
call `status`, re-read the relevant files, and re-plan. Retry an identical lost
request with the same command ID; use a new command ID for any changed payload.

Consult the generated [public contract](public-contract.md) or live `help`
before constructing a direct service request. Do not infer fields from these
examples.
