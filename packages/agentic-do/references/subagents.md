# Subagents

Subagents are supervised child agents with their own task channel and semantic workspace context. They are not repository branches and they do not publish directly into the parent.

## Parent workflow

1. `spawn_subagent` with one bounded task and a useful label. Use `fresh` for independent work and `fork` when the child needs the current trajectory context.
2. Keep doing useful foreground work. When only supervised execution remains, call `suspend_turn({ reason: "waiting_for_background" })`; do not poll a live child through status, transcript, log, or diff reads. Child activity exists once on its canonical task transcript. Every addressed terminal task fact durably resumes the supervisor. If sibling runs remain live afterward, continue useful foreground work or suspend again; do not finalize the user's goal while supervised runs remain live.
3. Use `notify({ to: "run:<runId>", content })` only for new instructions. The child must commit its semantic work and call `complete` with a concise result; that report arrives through the terminal task fact. Uncommitted child work cannot merge.
4. After terminal delivery, review the retained result and continue the user's goal. When the goal requires incorporating the child's work, call `merge_subagent({ runId })` directly; no status, diff, log, or transcript preflight is required. Inspection, comparison, and delegated research may deliberately leave the result unintegrated. The helper derives both exact states and invokes the same shared merge driver as ordinary VCS and protected-main integration, without a wrapper compare loop. Add optional `intent` when the parent's reason for integrating adds information beyond the child request; absence remains honest.
5. When integrating, review the model-visible resolution, `intents`, and every `composed` entry. A mechanically composed coordinate still needs semantic review.
6. If an integration returns `source-uncommitted` or `needs-decision`, use the returned evidence first. Inspect only the child state needed to resolve a concrete ambiguity, author any truthful combined state with ordinary parent edit tools, then call `merge_subagent` again with coordinate resolutions.
7. No cleanup action follows integration. Terminal runs immediately stop consuming execution capacity while their context, transcript, source event, and integration projection remain available. Use `cancel_subagent` only to fence a run that is still starting or running.

## Inspecting child state

Inspection serves explicit review/comparison goals and exceptional diagnostics;
it is not a merge preflight.
`inspect_subagent({ runId, query: "diff", limit: 50 })` returns a bounded
semantic comparison of the parent's current working head against the child's
committed event. The tool derives both exact VCS references; callers do not
provide source or target identifiers. If the child has additional uncommitted
work, the comparison still covers only its committed event and the result's
`workingCounts` and note make that distinction explicit. Continue a large
comparison with the returned opaque `nextCursor`.

When the user asks to inspect, review, or compare child work without
integration, use that bounded diff after terminal delivery rather than treating
the child's prose report as the comparison. When the goal calls for
integration, call `merge_subagent` directly and review its returned comparison;
do not duplicate the same work with an inspection preflight.

Use `query: "status"` for lifecycle and clean/dirty state, `query: "log"` for
bounded committed history, an exact repo-prefixed path for one child file, and
`query: "runtime"` only for external-engine process diagnostics. Use
`read_subagent` for deliberate transcript catch-up or conversation debugging.
Inspection never exposes the child's private model context window. Cursor reads
are ordinary bounded replay and remain available after terminal completion.
The parent task card observes the canonical task channel only while the run is
live or the user has expanded the transcript. Seeing a terminal fact updates
the card and releases the live observation; terminal cards retain finite replay
without holding the child, parent, or channel resident.

## Merge protocol

The helper returns `protocol: "vibestudio.subagent-merge.v1"`. Its bounded status union includes:

- `working`: at least one merge page changed the parent working head and the source is complete and concluded;
- `unchanged`: the source was already complete and concluded;
- `needs-decision`: clean pages landed, but one or more coordinates remain unresolved;
- `source-uncommitted`: the child's committed event does not include its current work;

The model-visible result includes bounded intents, mechanically composed coordinates, conflicts, and global resolution. Structured details additionally include the source event, initial and current parent heads, every landed merge result in `merges`, and the final review packet. Multi-page work uses stable idempotent command IDs. If a later page fails, the typed driver error retains every completed page and the last review.

The helper always performs the decision-establishing merge when a source is not concluded, even if it is convergent, net-zero, or conflict-only. Conflict-only work therefore returns a concluded decision plus unresolved coordinates instead of failing with an implicit conflict selection.

## Resolve a conflict

```js
merge_subagent({
  runId,
  intent: "Integrate the reviewed retry behavior while preserving the parent API",
  resolutions: [
    {
      coordinate: { kind: "file", id: "file:..." },
      resolution: "current",
      rationale: "The parent-authored current value combines both reviewed intents",
    },
  ],
});
```

- `theirs` accepts the child's coordinate.
- `ours` explicitly declines it.
- `current` accepts the parent head after you author the combined value with `edit` or `write` and a meaningful `intent` when the purpose is not obvious from the request.

To finish every remaining coordinate explicitly, use either:

```js
merge_subagent({ runId, resolutions: { allRemaining: { resolution: "ours" } } });
merge_subagent({
  runId,
  resolutions: {
    allRemaining: {
      resolution: "current",
      rationale: "The reviewed parent state combines or supersedes the child result",
    },
  },
});
```

`allRemaining` is literal: it applies to conflicts and clean coordinates alike, so abandoning a remainder cannot accidentally adopt unseen source work.

Do not resolve at aspect granularity, fabricate evidence, or order source operations. Coordinates are the decision surface; aspects and attribution explain the conflict.

## Run lifecycle

Execution status and semantic integration are independent axes. Execution is
`starting`, `running`, `completed`, `failed`, `cancelled`, or `abandoned`.
Semantic integration is derived from the shared merge engine as `unattempted`,
`integrating`, `needs-decision`, or `complete`.

Every terminal status is a retained result and frees a live execution slot
immediately. Ordinary completion and integration never unsubscribe the task
channel, destroy the child context, or add a housekeeping state. Retention is a
general storage policy concern, not a model workflow.

Terminal delivery is ordinary addressed channel work keyed by a deterministic
delivery identity. It does not depend on the parent being suspended: user input,
sibling completion, restart, and hibernation cannot acknowledge or displace an
unprocessed terminal fact.

`cancel_subagent({ runId, reason })` is legal only while a run is starting or
running. It fences execution, appends one addressed terminal cancellation fact,
and retains the same inspect/read/merge surface as every other terminal result.

## Child behavior

The child owns only its delegated task. It should inspect exact status, author managed changes with ordinary tools and meaningful optional `intent`, run focused verification, commit the complete local chain, and call `complete` once with the result. It should not push protected main, mutate the parent context, or ask the parent to replay its edits manually.
