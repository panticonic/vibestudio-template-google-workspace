# External snapshot import

## Import one exact snapshot

Use `vcs.importSnapshot` when Git, an archive, upload, filesystem tree, or
generated source enters semantic history. One import creates one ordinary work
unit with `kind: "import"` and one committed event over exact complete
repository trees. The work unit requires one `externalSnapshot` value. Its
repository and file differences are ordinary changes: repository create, file
create/delete/mode, and whole-content replacement. There is no synthetic
barrier change or second import graph.

Provide exactly the external-source coordinate that can be proved:

- source kind and canonical credential-free URI;
- exact snapshot revision;
- complete repository trees with each file's canonical path, exact content
  hash, and mode.

The host content owner verifies the named CAS digests and returns their
intrinsic content descriptors without transporting the blobs into semantic
execution. Callers do not assert content kind, byte length, or coordinate
extent. The semantic workspace validates the host receipt, enriches every file
fact with its observed intrinsic descriptor, then derives one
canonical `snapshotDigest` from the complete normalized repository/file
facts; callers do not supply a root, tree hash, or snapshot digest. The
work unit stores all four values together:
`sourceKind`, `sourceUri`, `snapshotRevision`, and `snapshotDigest`. They answer
which source snapshot the importer observed and which verified descriptors
crossed the boundary, at snapshot granularity. The source coordinate is
source-observed evidence—not cryptographic identity, authorization, or native
authorship—and does not assert who authored any path or coordinate before
import. Never place a checkout path, embedded credentials, access token, or
signed query parameters in the stored source URI. For Git, use the canonical credential-free remote; a
local-only remote is represented by an opaque digest, not its machine path.

The normalized snapshot also stores the complete sorted IDs of every repository
the snapshot targeted, including an identical re-import that authors no content
change. Work-unit inspection returns that exact `targetRepositoryIds` vector.
`imports-repository` neighbors expose the same relation as typed walkable edges.
Do not infer targets from authored-change previews, which are independently
bounded and may be empty.

Capture/read the external source through the ordinary `fs` owner so its exact
content digests are present in the workspace CAS. `vcs.importSnapshot` consumes
the complete source-level repository/file facts; it does not accept intrinsic
content claims, a caller root, a raw host path, or perform a hidden filesystem
read.

One import remains one atomic semantic transaction regardless of repository or
file count. Repositories and files must arrive in strict canonical path order;
manifest reads use bounded pages internally so database query limits do not leak
into the public contract. Each path component is at most 255 UTF-8 bytes and a
complete file path is at most 512 UTF-8 bytes because those are path-identity
constraints, not operation-capacity policy. There is no descriptor-size or item-count
ceiling, upload session, chunk assembler, or partial visible import state.

Every path crosses one shared admission predicate at schema ingress, semantic
resume, external adapters, host scans, and materialization. `.git`, `.gad`, the
materializer's context-binding file, and exact credential-bearing filenames
such as `.env` cannot enter semantic state: common project tools consume those
exact names automatically, so materializing them can disclose credentials.
Project configuration such as `.npmrc` remains ordinary tracked source; secrets
belong in the credential store, not repository configuration. Templates such as
`.env.example` also remain ordinary source. Ordinary project content such as `dist/`, `out/`,
`release/`, `coverage/`, `.cache/`, `node_modules/`, logs, archives, and
environment templates is not excluded merely by convention.

There is no evidence-quality mode, per-path last-touch data, imported author,
external commit graph, or evidence mini-graph. Do not traverse Git history to
make the import look more complete. A shallow clone is sufficient when it can
identify the requested revision and exact tree. If a separate Git query says a
commit last touched a path, describe that as external path-level evidence; do
not turn it into Vibestudio line blame. The current import contract deliberately
does not persist that optional claim. Blame stops at an import boundary when
its terminal ordinary change belongs to an import work unit.

Content classification is exact and source-independent. Decode the complete
blob as strict UTF-8. A successful decode produces text with `byteLength` equal
to the original octet count and `coordinateExtent` equal to the decoded UTF-16
code-unit length. Any malformed sequence produces opaque bytes with equal byte
length and coordinate extent. File extension, MIME type, NUL heuristics,
replacement decoding, and caller overrides do not participate.

## Prepare causal ingress and state

When an agent imports, run it from the real tool invocation so the graph remains
trigger message → turn → invocation → globally unique semantic command → import
work unit → ordinary changes. An authorized direct import instead stops
honestly at its semantic command. Do not create a wrapper agent or synthetic
adapter invocation.

Import requires a clean context because it creates a committed import event
directly. Commit or discard local applications first. Supply the current
working head and one globally unique command ID with the source tuple and
complete repository/file source facts. The semantic workspace observes each
distinct content digest through the existing content port, validates its
intrinsic descriptor, and derives the snapshot digest only from the normalized
combination. Raw blob bytes do not cross
into semantic execution.

For a new repository, omit its repository ID and provide a vacant workspace
path. For a later complete snapshot of an existing repository, provide its
stable repository ID. The imported manifest is complete, not a patch. The
semantic workspace derives only the changes between that complete snapshot and
the exact basis. Unchanged files do not get fake changes.

A whole-content external replacement records exact before and after endpoints
but no inferred preservation mapping. Similar bytes do not prove coordinate
continuity. Because import changes use the ordinary vocabulary, they appear in
normal compare pages, can be merged in bounded coordinate pages, and can be
reverted without an import-specific workflow.

## Verify the result

The successful return is the atomic acknowledgement of the committed import. It
includes `contextId`, `eventId`, `applicationId`, `workUnitId`,
`importedRepositoryIds`, and the complete canonical `externalSnapshot`. These
fields are required; callers must not accept an event-only result or reconstruct
the application/work-unit/snapshot tuple in a post-commit pass.

Confirm that the returned `externalSnapshot` exposes `sourceKind`, `sourceUri`,
`snapshotRevision`, and `snapshotDigest` together, plus the complete sorted
`targetRepositoryIds` vector. Confirm that `importedRepositoryIds` names the
same admitted repositories. Independently inspect the returned event,
application, and import work unit; the persisted work unit must expose the same
snapshot. The `imports-repository` neighbors expose those same exact targets as
walkable edges.
Inspect its ordinary authored changes and confirm the repository identities and
imported file states. Confirm each placed file reports intrinsic `contentKind`,
`byteLength`, and `coordinateExtent`.

For a vague question such as “who changed this line, and what do we actually
know?”, first run bounded blame. Walk native mappings normally. When a span
stops at an import boundary, pass its terminal typed `change` root unchanged to
`inspect`, then do the same with its `workUnit` and `command` roots. Report the work unit's four
snapshot fields and its exact recorded intent summary, plus any later native
intent the graph actually proves. Join the change to its work unit through the
change's exact ownership field; never depend on membership in a bounded
authored-change preview. Say
explicitly that pre-import coordinate authorship is unknown. The importer may
have caused the admission command; that does not make it the author of the
external bytes. Do not attribute the line to the external revision's committer
or source system either.

Retry an identical uncertain import with the same command ID. Any change to the
source tuple, repository/file facts, or expected working head requires a
new globally unique command ID.
