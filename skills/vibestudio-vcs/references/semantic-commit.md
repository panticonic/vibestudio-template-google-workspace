# Commit, discard, and push

## Commit the complete local chain

Run `vcs.status` and verify the current working counts and head. Run the
relevant tests before committing.

Inside an agent, call `vcs({ operation: "commit", message, intent? })`. Use
`intent` when the milestone's purpose is not already explicit in the request;
omit it instead of paraphrasing the message. The compact tool
derives the exact working head and globally unique command ID from the current
invocation. The operation commits every local application in order and returns
one immutable event; it does not accept a subset. Authorized direct runtime,
CLI, or lifecycle clients call the canonical `vcs.commit` service with those
exact fields. A direct caller does not pretend to be an agent; its causal walk
ends honestly at the semantic command.

When finishing a merge, commit derives the source from decisions in the
local application chain. The chain may contain decisions for multiple source
events—this is the normal fan-in shape for merging several subagents. There is
no second input for selecting integration parents: even a convergent or net-zero
merge first records a decision-only application. Commit checks that every
source-touched coordinate is covered by a reachable decision. On success, the
new event records the prior committed event first, then every merge source as
an ordered additional parent.

After success the context is clean: both the committed pointer and working head
name the returned event.

`vcs.status.integrating` is the O(1) read model for integration debt. Each row
reports its source, remaining/mergeable/conflict counts, conclusion, snapshot
head, and `stale`. A stale row is explicitly only the last merge-decision
snapshot; the commit gate remains exact. Successful commit clears the live rows
it integrates.

## Discard the complete local chain

Inside an agent, call `vcs({ operation: "discard" })` only when all uncommitted
applications should be dropped; the compact tool supplies the exact live head
and invocation-bound command ID. Direct clients call `vcs.discard` with those
same exact inputs. It returns the discarded
application IDs and restores the committed event as the working head.

Use `revert` when only a named intention should be undone while other local
work survives.

## Publish an already committed event

Inside an agent, call `vcs({ operation: "status" })` immediately before
publication and refuse to push while the context is dirty. Then call
`vcs({ operation: "push" })`; the adapter supplies the exact committed event,
observed main event, and invocation-bound command ID. Direct clients call
`vcs.push` with those exact fields.

Push validates event ancestry and coordinate-accounting completeness, runs the exact
candidate build/typecheck gate for the changed units and their transitive
reverse dependents, obtains protected publication approval, and atomically
advances protected refs through one durable effect. It authors no new source
history. Run the same exact-context report explicitly before publication when
it is useful for faster feedback. A semantic, build-gate, approval,
authorization, or atomic-ref refusal advances nothing.

A content-identical committed event is still a real semantic-main advance and
still requires approval. Expect an event-level approval rather than a fabricated
file diff. Only replay of the same already-applied publication is approval-free.

On `RevisionChanged`, re-read status and merge the new main when needed.
On `IntegrationIncomplete`, follow the structured recovery recipe: use
`allRemaining: ours` to decline the literal remainder, or `current` with a
rationale after reviewing the combined present state, then commit again. In a
supervising agent the same refusal names the corresponding `merge_subagent`
run; elsewhere it names raw `vcs merge` with the retained source event. On
`Unauthorized`, stop and use the declared approval flow. On
`ExternalEffectFailed`, retain the same command ID only for an identical
uncertain retry.

After success verify the returned `eventId`, `mainEventId`, and durable effect
identity.
