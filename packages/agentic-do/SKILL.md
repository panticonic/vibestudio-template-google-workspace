---
name: agentic-do
description: Develop @workspace/agentic-do agent runtime behavior, including model and provider defaults, live session tuning, tool-failure diagnostics, structured channel observations, and subagent supervision.
---

# Agentic DO

For a change spanning the chat panel, default agent, channel, or shared event
contract, read [agentic development](../../skills/agentic-development/SKILL.md).

Read the local reference that matches the task before editing:

- [Agent tuning](references/agent-tuning.md) for default model/provider changes,
  model credential setup, thinking effort, approval, and response policy.
- [Subagents](references/subagents.md) for `spawn_subagent`, child task channels,
  child context inspection, semantic integration, cancellation, and retained terminal results.
- [Failures and diagnostics](references/failures-and-diagnostics.md) for the
  canonical tool-failure envelope, primary/cleanup ordering, bounded invocation
  diagnostic packets, and paged outside-lineage explanation.

Keep package boundaries explicit. Core runtime mechanics live in this package;
projection/rendering details can live in sibling packages such as
`../agentic-core` or `../agentic-protocol`, and the standard chat worker lives
under `../../workers/agent-worker`.

## Structured channel observations

A channel subscription can opt an agent into exact non-chat payload kinds:

```ts
{
  name: "Incident agent",
  observations: {
    payloadKinds: ["application.incident.v1"]
  }
}
```

Matching is exact. Self-authored events and infrastructure payload kinds are
excluded. Only `wakePolicy: "every-envelope"` wakes for observations; other
wake policies suppress them. The envelope ID supplies deterministic prompt
identity, and observation configuration controls model delivery rather than
channel access.

Read `../agentic-core/src/agent-subscription-config.ts` for the configuration
contract and `src/agent-vessel.ts` for routing, prompt shape, and payload bounds.
Keep those files and their focused tests aligned instead of duplicating their
constants here.
