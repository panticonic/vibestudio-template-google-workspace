---
name: provenance-orientation
description: Recover why tracked state is the way it is — what was attempted, what else happened under that intent, what was rejected, and which subjects match a description.
---

# Provenance orientation

Read [Vibestudio VCS](../vibestudio-vcs/SKILL.md) first. Provenance is the
adjacency of semantic VCS and trajectory records, not a parallel store.

The point of provenance is not audit. It is theory maintenance: users prompt in
consequences ("cap the backoff at 30s") and almost never state the axiom behind
them ("this deploy target kills long-lived connections"). Your job is to
reconstruct enough of the record to impute that axiom before you act against it.

## Name your question, then use its mechanism

| Your question | Mechanism |
| --- | --- |
| Why do these bytes exist? | already attached to the managed `read` — stop there when it answers |
| What was actually being attempted? | `provenance({ target, walk: "cause" })` |
| What else happened under that intent? | `provenance({ target, walk: "cohort" })` |
| How are these two things related? | cause-walk both, intersect the refs; or one `query` join |
| What has this coordinate been *for*? | `vcs({ operation: "blame" })` and file history, read as intent drift |
| What was tried and rejected here? | `provenance({ target, walk: "rejections" })` |
| Which subjects match a description? | `provenance({ target: "search: some words" })` |
| A set-shaped question ("all X where Y") | `provenance({ query: "SELECT …" })` |
| Nothing above fits | `provenance({ target })` for one subject's immediate edges |

Each of these is meant to cost one call. If you are about to spend five calls
walking a chain by hand, you have picked the wrong mechanism.

```ts
provenance({ target: "packages/example/src/index.ts", walk: "cause" });
provenance({ target: "@r7-1c9a", walk: "cohort", scope: "turn" });
provenance({ target: "packages/example/src/retry.ts", walk: "rejections" });
provenance({ target: "search: retry backoff" });
provenance({ query: "SELECT relation, meaning, column_count FROM prov_schema" });
provenance({ targets: ["@r3-11ab", "@r4-77cd"] });
```

`target` is the sole selector for a subject: a managed path, `session`, a
semantic shorthand, a `search:` phrase, or a compact `@ref` you were given.
`targets` expands up to ten refs at once instead of ten calls. Never repeat a
long content-addressed identity: trusted code retains exact roots, and every
rendered subject carries the `@ref` you pass back.

## What each walk gives you

- **cause** — one indented narrative from the artifact up through applied
  change → work unit → command → invocation → turn → trigger message, following
  message sources until it reaches a human statement or a labeled boundary
  (subagent brief, external delta, import snapshot, outside your visibility).
  Intents lead; mechanics trail. A boundary is a fact, not a failure: the walk
  never fabricates continuity across one.
- **cohort** — everything else the same `work-unit`, `command`, or `turn`
  touched, grouped by coordinate, decision, and commit. Axioms show up as
  patterns across a cohort, not in a single edit.
- **rejections** — counteracted changes with the intent of the work that undid
  them, revert work, superseded external deltas, and merge coordinates resolved
  `ours`/`current`. A user saying *no* is the strongest evidence the record
  holds; consult it before repeating work that was already rejected.

## The abduction pattern

1. **Gather** — `cause` for what was asked, `cohort` for the pattern, and
   `rejections` for the counter-evidence.
2. **Hypothesize** the axiom that makes all three consistent. The axiom is a
   property of the environment, not of the file you are looking at. Ask what
   the recorded choices have in common — three settings all kept short is
   evidence about *time*, not about retries, sockets, and uploads separately.
3. **Check** it against the rejections and the intent-annotated history. If a
   rejection contradicts your hypothesis, the hypothesis is wrong, not the
   rejection.

   **Do not dismiss a rejection because its subject differs from yours.** The
   most common abduction failure is reading "someone raised the retry backoff
   and it was undone" as a fact about retries, concluding it says nothing about
   the keepalive you are adding, and repeating the rejected work under another
   name. Ask instead what property the rejected work shares with yours. If your
   change has that property, the rejection is about your change, whatever
   coordinate it was recorded at — say so before acting, and let the user decide.
4. **Write it down** if it will recur — as ordinary prose in the relevant notes
   file, with the edit's own intent naming the evidence it came from. There is
   no theory store: a recovered axiom is a paragraph in a tracked file, with
   authorship, history, and revision already provided by the VCS.
5. **Treat an inherited note as a prior, not as ground truth.** Every written
   axiom is someone's guess. When the stakes warrant it, re-check it against the
   evidence walks; when the evidence contradicts it, edit the note (or say so),
   never silently obey or silently override it.

## Interpret evidence narrowly

Keep actor, executor, cause, intent, authorization, and content origin separate.
An edge records a relationship, not the truth of every upstream claim.

Intent tiers are not interchangeable: `stated` is explicit purpose, `trigger` is
durable assignment evidence, `mechanical` describes only the effect. Never
invent private reasoning or authorship from a turn summary, and never launder a
`mechanical` line into a claim about what someone wanted.

A copy should reach its immediate source coordinate. An integration explanation
should reach the decision and source changes it accounted for. At an external
import boundary, report the recorded source kind, credential-free URI, revision,
and target repositories as snapshot facts. Importer intent explains why bytes
entered Vibestudio — it does not identify the earlier file author.

Every surface is bounded and scoped to what you may read. A pruned branch
renders as a labeled boundary, a long list as a counted omission plus a `@ref`,
and an over-broad query as a typed refusal that names the offending term. Narrow
the question; never treat a refusal as a reason to retry it larger.
