---
name: pubsub-channel
description: "Develop the durable workspace conversation service: channel envelopes, participants, replay, delivery, policies, addressing, outbox recovery, and channel lifecycle."
---

# PubSub channel

`workers/pubsub-channel` owns durable conversation envelopes, participant
membership and metadata, replay, delivery settlement, channel configuration,
and recovery. The rendered transcript is a client reduction; agent trajectory
execution belongs to the agent runtime.

Read [agentic development](../../skills/agentic-development/SKILL.md) for a
coordinated stack change and
[agentic protocol](../../packages/agentic-protocol/SKILL.md) before changing
shared event or participant shapes. Reusable channel clients belong in
`packages/pubsub`; fixed conversation policies belong in
`packages/channel-policies`.

## Invariants

- Persist an accepted durable envelope before advertising or delivering it.
  A reconnect or alarm may redrive delivery, but must not create a second fact.
- Replay and live delivery expose the same canonical envelope semantics. Phase
  metadata may describe delivery; it must not change the payload's meaning.
- Durable participant identity, ephemeral connection/presence, delivery mode,
  and application configuration are separate facts. Never use a live socket as
  membership authority.
- Verified caller identity and locked membership policy authorize joins.
  Conversation text, claimed metadata, handles, and object keys do not.
- Participant handles and advertised methods use the canonical validation and
  collision rules. Reject ambiguity rather than renaming it at delivery time.
- Addressed delivery, hop limits, detach boundaries, and policy decisions are
  deterministic over the stored causal envelope.
- Outbox retries are idempotent and bounded per attempt. Delivery failure must
  not block unrelated channel work or erase the accepted log fact.
- Archives, member removal, and other destructive administration retain their
  declared capability and approval boundary.

## Verification

Run the focused channel tests for log append/replay, roster transitions,
addressed delivery, policy decisions, and outbox recovery affected by the
change. Protocol-shape changes also require the corresponding
`packages/agentic-protocol` reducer/schema tests and representative chat/agent
consumer checks. Build `workers/pubsub-channel` against the exact context, then
exercise a fresh channel plus any retained-history case the change can affect.
Retire the temporary participants and channel resources after inspection.
