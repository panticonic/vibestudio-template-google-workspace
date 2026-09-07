---
name: gad-context
description: Inspect canonical trajectory/channel logs, agent turns, invocations, publications, rosters, health, and storage diagnostics.
---

# GAD context

Use the typed `gad` namespace from `@workspace/runtime`. Read
[DIAGNOSTICS.md](DIAGNOSTICS.md) before live incident work; use live docs for
current method schemas and result shapes.

## Model

- Private agent trajectory and transmitted channel history are separate
  hash-chained logs.
- Agent context projects into typed message, block, invocation, approval, turn,
  usage, and checkpoint records.
- A channel row publishing a trajectory event carries exact origin-log,
  origin-head, and origin-envelope coordinates. User- or channel-origin rows
  correctly have no trajectory origin.
- Managed source history belongs to semantic VCS, not GAD. Read [Vibestudio
  VCS](../vibestudio-vcs/SKILL.md) for file, change, work-unit, decision, event,
  history, or blame questions.

Never infer joins from payload text or timestamps, reconstruct file history from
log storage, or query undocumented tables because an inspector omitted a field.

## Start with bounded inspectors

| Question | Inspector |
| --- | --- |
| Channel and agent health | `inspectAgentHealth` |
| Open turns or message state | `inspectTurnState` |
| One invocation and its terminal events | `inspectInvocationState` |
| Compact channel history | `inspectChannelEnvelopes` |
| One exact hydrated channel page | `readChannelEnvelopes` |
| Trajectory-to-channel publication joins | `inspectPublicationIntegrity` |
| Current roster projection | `inspectChannelRoster` |
| Oversized or suspicious storage rows | `inspectStorageDiagnostics` |

Use `getTrajectoryForEnvelope` or `listPublishedEnvelopesForTrajectory` only
after a bounded inspector identifies the exact artifact. Avoid broad hydrated
reads in agent turns.

Channel reads return `{ items, pageInfo }` with tail/before/after windows.
Follow returned cursors and preserve the first page's snapshot bound on a live
tail. Never request oversized pages or chase newly appended rows indefinitely.

```ts
const health = await gad.inspectAgentHealth({ channelId: chat.channelId });
return {
  channelId: health.channelId,
  branchId: health.branchId,
  summary: health.summary,
  turns: health.turnState.rows,
  invocations: health.invocationState.rows,
};
```

## Don't poll the observing turn

When inspecting `chat.channelId`, the diagnostic eval is itself the newest open
invocation. Take one snapshot. If durable integrity is healthy and only the
current diagnostic is in flight, report normal activity and return. Polling
can't observe that invocation close — it closes only after eval returns, and
each retry creates another invocation.

For another visible chat panel, resolve its panel handle, read its state args,
and use the exact stored channel identity. `chat.channelId` always means the
current response channel.

## Escalation

Inspector summaries, rows, byte counts, and stored-value digests are the normal
surface. Fetch or hydrate one exact value only when its content is required.
Large values are stored by reference — never return them wholesale from eval.

Use bounded schema or SQL inspection only after a typed inspector identifies a
specific storage defect. Confirm the live schema first. Preserve the distinction
between private trajectory rows, transmitted channel rows, and exact origin
coordinates.

For code provenance, continue from a typed trajectory invocation into semantic
VCS through recorded causal edges. For a fix that appears inactive, verify the
context working state, exact build, and running artifact before changing code
again.

Prefer fail-loud invariant evidence over projection code that hides corrupt
logs. A failed assistant message is terminal; unexpected open turns, missing
joins, empty rosters, or oversized inline values remain concrete diagnostics
until the typed inspectors explain them.
