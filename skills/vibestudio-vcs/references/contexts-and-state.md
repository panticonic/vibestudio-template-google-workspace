# Contexts and state nodes

## Orient from status

Call `vcs.status` when you need explicit chain orientation. Agent-facing mutations
bind the live working head themselves, and `vcs({ operation: "compare", view:
"local" })` resolves the exact local source and protected-main target itself, so
neither needs a status preflight. Status returns:

- `committed`: the context's immutable committed event;
- `workingHead`: that event when clean, or the latest local application;
- `clean`: whether local applications exist;
- `mainEventId` and the context's relation to protected main;
- compact counts for local applications, work units, and changes.

Retain the returned state object exactly. A state node is either an event or an
application; it is not a content digest, filesystem marker, or permission.
Its `workspace-event:…` or `application:…` identity is one opaque string:
never strip, split, hash, or reconstruct its prefix.

## Advance one local step at a time

Every successful `edit`, `move`, `copy`, `merge`, or `revert` appends one
work application and returns the new `workingHead`. Pass that returned state as
the next mutation's `expectedWorkingHead`.

This is a linear local chain inside one context:

```text
committed event -> edit application -> merge application -> revert application
```

Concurrent work that needs an independent chain belongs in another context.

## Execute context code from the same working state

A context is one workspace-wide branch across every repository in the
workspace. It is not a repository, directory, vault, channel, panel, or agent.
Selecting a repository or vault changes application focus inside the branch;
it never creates or switches contexts.

Every panel has one host-bound context. Agents launched by that panel and
channels served by those agents use that same context. Panel state arguments
cannot override it. Create an independent branch only through an explicit
fork/clone/subagent operation. To display an already-created branch in a panel,
open the panel with that `contextId` or use the panel's explicit context-switch
operation; do not store a second context id in application state.

Runtime-managed workers and Durable Objects follow their owning context's
working head by default. Their code and durable state therefore share one
semantic context boundary while work remains local. Pass `ref: "main"` only
when deliberately pinning protected main; do not use it as a recovery for a
context build problem.

Panel launch/navigation retains an explicit build-ref option. Pin
`ctx:<contextId>` when testing unpublished panel code.

A host checkout is not a semantic selector. Editing or restarting host source
does not move workspace `main`, rewrite a context, or rebind an image. Diagnose
runtime provenance from the selected event/application and image state, never
from checkout mtimes.

## Read exact state

Pass an event or application state directly to `resolveRepository`, `readFile`,
`listFiles`, `compare`, file/repository roots, and `blame`. Repository paths and
file paths help humans find stable identities; they do not name revisions.

`vcs.readFile` always reads that semantic state and has no raw/host form. Use
`fs` when the question is what bytes exist at a host or materialized filesystem
path. A context filesystem read may verify its projection marker first, but it
does not become a VCS fallback.

Keep ownership simple: semantic VCS owns events, applications, identities, and
provenance; `fs` owns host reads and materialized bytes; the publication gate
owns the protected-ref compare-and-swap. There is no VCS authority service
between them.

Treat projection recovery as derivation from the existing semantic state, not
new semantic work. Ordinary mutations materialize an exact-basis patch for the
repositories they changed. Recovery derives a fresh, self-contained full
replacement for the current working head against the exact host state (or exact
absence) it observed; a delayed replacement cannot roll a newer projection
back. Recovery does not replay an old partial effect, acknowledge it again, or
mint a semantic command, work unit, or event.

Use `resolveRepository` when a repository path is known, then use `listFiles`
to discover files by stable identity. Use `neighbors` from an event/application
root only when the repository path itself is unknown. In an agent, perform that
walk through `provenance` and follow each complete advertised continuation ref until the
intended identity is found, always with its compact `ref`; the harness carries
each exact root and service cursor internally. Never choose a convenient
first-page result.

A placed file reports `contentKind`, `byteLength`, and `coordinateExtent`.
`contentKind` derives the only valid range unit (`text` → UTF-16, `bytes` →
byte), so carry these state facts forward rather than inventing request
metadata for `blame`.

## Cross a boundary

`commit` consumes the complete local chain and returns a new event. `discard`
drops the complete chain and restores the committed event as the working head.
Neither operation accepts a subset.

Use local compare to inspect this context's complete working state, including
uncommitted applications, against protected main. Use incoming compare with a
target state and an exact committed source event when reviewing work from
another context. The source is always the state whose changes are being
considered; do not name main as the source when asking what changed locally.

Keep the same incoming source event through bounded coordinate decisions.
Commit only after all effective source changes are truthfully accounted for.
Commit derives the source parent from those decisions and rejects mixed sources
or a mismatched caller-supplied parent. Local applications are already in the
current context and therefore are inspected or committed, not merged back into
that same context.
