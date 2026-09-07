# Theory of State

## Classify every persistent structure

Every persistent structure is one of:

- **Log** — an append-only hash-chained sequence for trajectory and channel
  delivery.
- **Semantic graph fact** — an immutable typed node or immediate edge: command,
  work unit, change, application, decision, content mapping, workspace event,
  or event parent.
- **Value** — immutable content-addressed bytes or trees used for file content,
  large payloads, and build artifacts.
- **Ref** — a mutable named pointer such as a trajectory head, context committed
  event, context working head, or protected `main` event.
- **Cache** — a rebuildable index, materialized context folder, or build output.

Never promote a cache, traversal cursor, self-derived digest, or repeated
projection to authority. Journal an intended external effect before dispatch;
mint semantic identity before materializing its content projection.

## Join the trajectory to semantic work once

The unified log envelope carries exact log/head coordinates, ordering,
causality, actor, payload identity, and hash-chain integrity. A model-visible
trajectory contains messages, turns, tool invocations, model changes,
compactions, and summaries. Semantic file mutations are not copied into that
log: the workspace graph owns commands, work units, changes, applications, and
events. The invocation-to-command edge is their one exact join.

An agent-caused semantic command points to its verified ingress coordinate from
that trajectory; an authorized direct command stops honestly at itself. Neither
copies actor/invocation fields into every VCS node or creates another invocation
registry. Executor, initiating intent, authorization, incorporation, and blame
are separate graph walks. Approvals and runtime diagnostics remain with their
domain owners; there is no sidecar provenance or claims ledger.

## Use one semantic workspace graph

A committed state is a workspace event. A local state is the latest work
application. Each context stores two pointers:

- `committedEventId` — its immutable local commit boundary;
- `workingHead` — the committed event when clean, otherwise the latest local
  application.

Each application points to its exact event/application basis and applies one
work unit. Every edit, move, copy, integration decision, or revert appends one
ordinary local application. Commit consumes the complete local chain and
creates one event; discard drops the complete chain. There is no parallel
composition or partial-commit state machine.

One authenticated workspace fact map holds typed repository and file states.
Repository manifests map paths to stable file IDs. File state owns placement,
content, mode, size, and tombstone predecessor. A content edit changes one file
fact; a move preserves file ID; a copy mints file ID. The copy change itself
owns one typed source endpoint (state, repository, file, path, and content),
from which both the `authored-copy-source` adjacency and each application's
ordinary mapped content edge are derived. Do not add a copy-source table,
payload convention, or copy-specific traversal graph.

Work units group coherent intent. Changes record expressive edit, lifecycle,
move, copy, import, and counteraction semantics. Applications record how work
was applied to an exact basis. Integration decisions account for exact source
changes by adopting, reconciling with truthful state evidence, or declining
with rationale. Immediate content edges preserve, copy, or incorporate exact
coordinates, so blame walks transitively without storing transitive snapshots.

Import creates an explicit evidence barrier. Exact snapshot bytes may be known
while earlier external origin remains unknown; provenance stops honestly where
evidence stops.

Read [vibestudio-vcs](../vibestudio-vcs/SKILL.md) for the operating procedure.

## Separate semantics from host effects

The semantic workspace authority owns contexts, events, work, changes,
applications, decisions, content lineage, comparisons, command journaling, and
the durable effect outbox.

Invocation diagnostics are a bounded read projection over those existing
authorities, not a sidecar ledger. `gad.diagnoseInvocation` joins the exact
trajectory coordinate to its projected invocation/turn, terminal events,
causal semantic commands, effect intents, and receipts. Every section has an
explicit limit and truncation fact; the projection stores nothing and cannot
change semantic state.

Two narrow host-effect ports consume exact requests and return receipts:

- workspace content observation/materialization;
- approval-gated protected-ref compare-and-swap.

These ports do not interpret changes, conflicts, integration completeness, or
ancestry. They are not another VCS. The semantic authority performs no direct
filesystem or protected-ref effect.

The build subsystem is a separate content consumer, not a semantic effect port.
It can be invoked explicitly against an exact context for fast feedback and is
also invoked by protected publication for the affected build closure. Build
observations and artifacts do not become semantic history; only the successful
candidate gate permits the protected ref effect.

Materialized context folders and host content-tree digests are projections.
Build keys identify derived artifacts. None is semantic revision identity.

## Walk provenance directly

Expose one typed node vocabulary across `inspect`, `neighbors`, `history`, and
`blame`. Define each relation once with its exact allowed endpoint kinds and
derive the identical canonical edge from either incident node. Persist only
immediate normalized facts, never a second adjacency graph. Page adjacency in deterministic order
with one opaque cursor; keep traversal state in the caller and restart from the
root if a mutable trajectory grows. Derive ancestry from event parents and
content origin from coordinate mappings.

If a proposed persistent object merely summarizes facts reachable through
these edges, make it a rebuildable cache or delete it.

## Store runtime state with its owner

- Durable Object SQL is the durable SQL primitive; each DO owns its schema.
- The per-workspace blobstore owns immutable content-addressed values.
- The host state directory owns DO databases, blob/build stores, projected
  context folders, and device credentials.
- Framework-internal DOs own their bounded runtime concerns; workspace units do
  not acquire host authority from filesystem position.

## Build from content, publish events

Builds are content-addressed and demand-driven. An effective version derives
from one unit's content, transitive internal dependencies, and global build
keys. Equal effective versions reuse artifacts. An explicit context build is
the fast local diagnostic loop; the protected-main gate repeats the exact
candidate build/typecheck before ref mutation. A post-publication build
remains a derived projection.

Protected `vcs.push` publishes an already committed event. The semantic
authority validates event ancestry and integration facts; the publication gate
obtains approval and atomically advances protected refs. Publication creates no
source-history event. Candidate build/typecheck success is a precondition for
content-changing pushes.

Runtime activation consumes derived artifacts and fails closed. If the newly
published source cannot be built, validated, or started, its artifact is not
activated and the previous runnable artifact remains selected. The semantic
publication remains true; a repair is a new ordinary event.
