---
name: vibestudio-vcs
description: Semantic workspace VCS for managed authoring, net-effect merges, provenance, commit, revert, snapshots, and protected-main publication. Not for context-local scratch files or unrelated Git repositories.
---

# Vibestudio semantic VCS

Managed workspace state is semantic history, not a Git worktree. Use
`apply_patch` for atomic multi-file text/binary writes, exact replacements,
deletes, and mode changes; `edit` or `write` for a single simple text change;
`move_file`/`copy_file` for identity-preserving transfers. Use `vcs` for status,
compare, merge, revert, commit, discard, blame, and push. Use `provenance` as
the sole agent-facing graph walker for typed roots and adjacency.

## Non-negotiable rules

- Treat every event, application, repository, file, change, work unit, and
  decision ID as opaque. Copy returned identities exactly.
- Carry the newest returned `workingHead` into the next mutation. On
  `RevisionChanged`, re-read status and re-plan — never rewrite the expected
  basis.
- Managed edits stay local until one deliberate whole-chain commit. Never
  emulate a move or copy with read/write.
- Add optional `intent` only when the purpose isn't clear from the trigger.
  Good: `intent: "Remove the cache because it hides the request race"`. Omit
  when it would restate the request.
- Sources merge by stable coordinate and net effect. Operations are provenance,
  not replay steps.
- `resolution.complete && resolution.concluded` is the only finished merge
  signal.
- Push only an exact clean committed event after focused verification.

## Core workflow

1. Run `vcs({ operation: "status" })` to orient to the current chain.
   Agent-facing mutations derive and bind the live `workingHead` — a separate
   status preflight isn't required for every call.
2. Inspect or read the smallest relevant surface. Managed reads may include
   bounded memory with intent and causality.
3. Author coherent multi-file changes with `apply_patch`; use `edit`/`write` for
   one simple text file and `move_file`/`copy_file` for transfers. Give `intent`
   only when it adds purpose beyond the request.
4. To inspect everything currently changed (including uncommitted applications),
   use local comparison directly — no status or history preflight needed:

   ```js
   vcs({ operation: "compare", view: "local" })
   ```

      Compare is read-only with no `intent` field. Never pass main as
   `source` here — that reverses the comparison and can truthfully show
   no changes.

5. For incoming committed work, call merge directly in the normal case. The
   agent-facing tool drains every clean page in one call, never selects a
   conflict implicitly, and returns final global resolution, counts, intents,
   composed-review evidence, and a bounded conflict page. Use compare first only
   for a deliberate read-only preview:

   ```js
   vcs({ operation: "compare", source: "event:...", limit: 500 })
   ```

6. Review both views in compare results:
   - `coordinates`: mechanical surface — `adopt`, `convergent`, `composed`,
     `conflict`, or `resolved`, with aspect values and full attribution.
   - `intents`: semantic surface. Visible tier is `stated`, `trigger`, or
     `mechanical`; `split` and `contested` prompt deeper inspection, never
     machine gates.

7. Merge clean work. Omitting `coordinates` lets the driver drain bounded engine
   pages; explicit `coordinates` selects one page only:

   ```js
   vcs({
     operation: "merge",
     source: "event:...",
     intent: "Bring the reviewed child implementation into the parent"
   })
   ```

8. Review every returned `composed` entry. Deterministic non-overlapping text
   composition is mechanically safe, not a semantic approval.
9. Resolve conflicts per coordinate:
   - `theirs`: accept the source coordinate
   - `ours`: keep ours and explicitly decline the source coordinate
   - `current`: accept the current head after authoring the truthful combined
     result with ordinary edit tools

   ```js
   vcs({
     operation: "merge",
     source: "event:...",
     resolutions: [{
       coordinate: { kind: "file", id: "file:..." },
       resolution: "current",
       rationale: "The current file combines the retry contract with the local validation"
     }],
     intent: "Conclude the reviewed hand merge"
   })
   ```

      To decline every unseen remainder (including clean coordinates), use
   `resolutions: { allRemaining: { resolution: "ours" } }`. After authoring a
   combined parent result, use `current` with a required rationale. The blanket
   repeats safely across whole-group pages and never accepts source content
   implicitly.

10. Use the merge result as the completion receipt. `status: "unchanged"` is an
idempotent receipt, not an error — still inspect `resolution.complete`. If
conflicts exceed the bounded result, continue only the filtered sequence by
copying the advertised `compare` call containing its complete compact ref. A
convergent or net-zero source still gets one
decision-only merge call to establish conclusion and ancestry.
11. Run focused tests and commit the complete application chain. The compact
commit verifies that the context is clean at the committed event; request status
separately only when you need additional orientation, then push if requested.

## Commit and publication

`vcs({ operation: "commit", message, intent? })` commits the complete local
chain. Merge decisions are the sole source of merge parents, including
decision-only convergent and net-zero merges.

`vcs({ operation: "push" })` publishes the exact committed event. Push
revalidates every merge parent by coordinate and runs protected candidate
checks. It never includes uncommitted work.

## Recovery

- `ConflictPresent`: the selected coordinate conflicts and lacks a resolution.
  Read its aspects, attributions, closed resolution list, and both intents.
- `CoupledGroupIncomplete`: the selection split a structural group. Select the
  entire named group or omit `coordinates` to let the planner select a valid
  page.
- `ScopeTooLarge`: narrow the compare page or coordinate selection — never split
  a coupled group.
- `IntegrityFailure`: stop. The state can't be explained by reachable
  provenance; never route around it.
- `IntegrationIncomplete`: follow the returned merge recipe. Use `allRemaining:
  ours` to decline the source remainder, or `current` with rationale after
  reviewing a truthful combined parent state.
- `NoEffect`: inspect current state. Report success only when the requested
  semantic outcome is already true.

## Reference map

- [Authoring basics](references/authoring-basics.md)
- [Contexts and exact state](references/contexts-and-state.md)
- [Compare and merge](references/compare-and-merge.md)
- [File move and copy](references/file-move-copy.md)
- [Revert and counteractions](references/revert-counteractions.md)
- [Semantic commit](references/semantic-commit.md)
- [Provenance, intent, and blame](references/provenance-and-blame.md)
- [Querying provenance](references/querying-provenance.md)
- [External snapshot import](references/external-snapshot-import.md)
- [Checks and publication](references/checks-and-publication.md)
- [Typed recovery](references/typed-recovery.md)
- [Scenarios](references/scenarios.md)
- [Generated public contract](references/public-contract.md)

Use `help("vcs")` for the method index and `help("vcs.merge")` for an exact live
method contract.

The generated public contract and `help` output own the method roster. Agent
tools expose the common workflow; direct runtime callers use the same semantic
contracts with explicit service fields.
