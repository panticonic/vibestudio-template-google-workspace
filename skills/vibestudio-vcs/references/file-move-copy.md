# File move and copy

## Choose the identity operation

Use a move when the same managed file changes location. The result retains its
`fileId` across path or repository changes.

Use a copy when a new managed file starts from exact source content. The result
mints a new `fileId` and records one immediate coordinate mapping to the source
file at the named source state.

That whole-file mapping inherits its unit from the exact source and destination
states: UTF-16 for text, bytes for opaque content. A copy does not accept a
caller-selected coordinate kind or translate between content kinds.

Do not express either operation as delete-plus-create, byte similarity, or a
generic filesystem transfer on managed paths.

## Resolve exact endpoints

Call `status`, find the source and destination repository identities, and read
or list the source file at the exact working head. Retain its `fileId`.

For a move, supply the current repository/file identities plus the destination
repository and vacant path. For a copy, also retain the exact source state;
copying from an older event is valid and remains explicit.

Use the focused `move_file` and `copy_file` tools for one file. Supply optional
`intent` when the transfer serves a purpose the trigger does not reveal, for
example `intent: "Keep the generic adapter while creating a panel-owned variant"`.
Never fill it with the source and destination paths. An agent-bound
relay must retain the exact causal invocation. An authorized direct client may
use `vcs.move` or `vcs.copy` for an atomic batch, but its provenance stops at the
command; do not wrap it in a synthetic agent.

Each request creates one local application. Keep the returned working head for
the next step. Focused transfer results include complete `source.root` and
`destination.root` values plus full workspace paths; copy those roots unchanged
into compact `inspect`/`neighbors` instead of rebuilding a file coordinate.

## Verify provenance

After a move, inspect the file root at the returned state and confirm the same
file identity has the new placement. Its content lineage is unchanged.

After a copy, discover the destination file ID, then call `blame` or walk
the two deliberately distinct relations:

- `authored-copy-source` connects the stable copy change to the exact source
  file at the selected event/application state;
- `copies-content` connects the copy's applied change to the source applied
  change with exact coordinate mappings used by blame.

The authored source is one typed change endpoint, not a payload convention or
a second copy-source graph. Copy-of-copy naturally walks one immediate
`authored-copy-source` fact and one applied content mapping per generation; no
transitive source list is stored on the new change.

Editing the copy later creates new local content while preserved regions still
walk through the copy edge. Editing the original does not mutate the copy.

## Handle refusal

`DestinationOccupied` means the requested destination is not vacant. Re-read
the destination and choose a different operation; do not silently overwrite it.
On `RevisionChanged`, resolve both endpoints again because identity or
placement may have changed.

Use `vcs.importSnapshot` rather than copy when the source is outside managed
semantic history and must enter through an explicit external snapshot work
unit.
