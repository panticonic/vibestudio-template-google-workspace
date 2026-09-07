---
name: agentic-development
description: Modify and verify Vibestudio's workspace-owned agentic stack across the chat panel, agent worker/runtime, channel service, and agentic protocol. Use for coordinated agent behavior or conversation-stack changes; not for merely adding an existing agent to a channel.
---

# Agentic stack development

The agentic product is ordinary managed workspace source. Change it through the
same semantic authoring, exact-context verification, and protected publication
workflow as any other workspace unit.

## Ownership map

Read every local skill touched by the change:

| Concern | Owner | Read |
| --- | --- | --- |
| Chat product composition, model setup, agent lifecycle | `panels/chat` | [Chat panel](../../panels/chat/SKILL.md) |
| Reusable React conversation UI | `packages/agentic-chat` | [Agentic chat](../../packages/agentic-chat/SKILL.md) |
| Default chat-agent product adapter and tool selection | `workers/agent-worker` | [Chat agent worker](../../workers/agent-worker/SKILL.md) |
| Agent execution, folding, effects, diagnostics, subagents | `packages/agentic-do` | [Agentic DO](../../packages/agentic-do/SKILL.md) |
| Event vocabulary, schemas, reducers, hashes, stored values | `packages/agentic-protocol` | [Agentic protocol](../../packages/agentic-protocol/SKILL.md) |
| Durable channel log, roster, replay, delivery, policies | `workers/pubsub-channel` | [PubSub channel](../../workers/pubsub-channel/SKILL.md) |

Pure client coordination belongs in `packages/agentic-core`; reusable channel
clients belong in `packages/pubsub`; model adapters belong in `packages/pi-*`.
Move a fact to its actual owner instead of adding a second interpretation at a
convenient consumer.

The main flow is:

```text
panels/chat + packages/agentic-chat
                 ⇅
        workers/pubsub-channel
                 ⇅
 workers/agent-worker + packages/agentic-do
                 ⇅
       canonical trajectory / effects
```

`packages/agentic-protocol` is the shared vocabulary across these boundaries;
it is not a transport, store, runtime, or renderer.

## Development loop

Read [workspace development](../workspace-dev/SKILL.md) and [semantic
VCS](../vibestudio-vcs/SKILL.md) before authoring.

1. Orient to the current semantic working state and inspect the smallest owner
   surface. Use live docs for callable APIs; source owns implementation.
2. Make one coherent change at the owning boundary. Update all exhaustive
   consumers in the same application when a shared discriminant or contract
   changes. Do not introduce a compatibility flag, parallel event path, or
   consumer-local reinterpretation.
3. Run the narrow package tests that prove the changed invariant. Then build
   every affected executable edge against the exact context: normally
   `panels/chat`, `workers/agent-worker`, and/or `workers/pubsub-channel`.
4. Exercise a fresh canary against that same semantic state. Panel code needs
   an explicit `contextId` and a ref such as `ctx:${ctx.contextId}`; worker and DO
   resolution follows the owning context. Inspect the canary's transcript,
   invocation failures, channel delivery, lifecycle, and console evidence
   appropriate to the change.
5. Retire every temporary panel, channel participant, worker/DO, page, and
   diagnostic handle the canary created. Commit the complete local chain only
   after focused checks pass; publish only when the requested workflow includes
   advancing protected main.

## Self-replacement contract

Editing the code, prompt assembly, skills, tools, or protocol used by the
currently running agent never mutates that live incarnation. Its runtime image,
loaded prompt resources, channel join, and advertised method surface remain
fixed for their existing lifetimes.

Use the current agent as the stable parent:

- build the changed source in its semantic context;
- create a fresh channel or uniquely named canary agent in that context;
- direct a bounded realistic task to the canary;
- inspect the durable result and exact failures from the parent; and
- unsubscribe and retire the canary after verification.

Use [agents](../agents/SKILL.md) for the supported add/remove lifecycle. When a
change affects chat boot, channel creation, or protocol negotiation together,
open a temporary `panels/chat` at the exact context ref so all three new
incarnations are exercised as one system. Do not reload the parent agent or
reuse an existing channel merely to make new code appear active.

Panel source edits do not hot-swap an open page. `handle.reload()` restarts the
current renderer at its already selected build; `handle.rebuild()` prepares and
atomically activates a new immutable attempt at the panel's active ref. Use
`rebuild()` after source or transitive package changes. It keeps the stable
panel slot id, but the attempt, runtime entity, build key, and CDP generation
may change.

## Protocol blast radius

Treat channel envelopes and trajectory events as durable facts. A change to a
kind, terminal outcome, participant identity, stored-value encoding, hash input,
or replay reduction normally affects producers, schemas, reducers, persistence,
renderers, and diagnostics together. Prove both new-event handling and reduction
of representative retained history. A fresh empty-channel canary alone is not
enough for a persisted-shape change.

Keep one current contract. If a genuinely breaking current-generation change is
required, change every owner and its tests coherently; do not leave dual readers,
dual writers, version guessing, or an optional legacy mode behind.
