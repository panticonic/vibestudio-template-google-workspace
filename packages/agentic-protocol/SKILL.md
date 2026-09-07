---
name: agentic-protocol
description: Change the canonical agentic event vocabulary, schemas, reducers, participant identities, hashes, terminal outcomes, tool-failure envelopes, and stored-value encoding.
---

# Agentic protocol

This package is the pure shared contract for agentic facts. It owns vocabulary,
validation, canonical encoding, hashing, and deterministic reduction. It owns
no RPC transport, persistence, Durable Object lifecycle, model execution, or UI.

Read [agentic development](../../skills/agentic-development/SKILL.md) for the
cross-stack workflow. Relevant runtime consumers include `packages/agentic-do`,
`packages/agentic-core`, `packages/agentic-chat`, `packages/pubsub`, and
`workers/pubsub-channel`.

## Invariants

- Event kinds and payloads form one discriminated contract. Update constructors,
  schemas, exported types, exhaustive reducers, and terminal-kind helpers
  together.
- Encoded facts hash canonically. Never add presentation-only or ambient runtime
  data to a hash input, and never accept multiple encodings for convenience.
- Terminal outcome and terminal event kind must agree exactly. Cancellation,
  abandonment, failure, and completion remain distinct durable facts.
- Participant and actor projections must preserve the public/private identity
  boundary; renderers do not repair unsafe metadata after the fact.
- Oversized values cross the stored-value reference boundary before persistence.
  Inline size limits and hydration validation remain deterministic.
- Tool failures keep one canonical structured envelope with the primary failure,
  cleanup evidence, and safe retry policy; prose is presentation, not control
  flow.
- Reducers are pure and deterministic over retained history. They do not call
  services, read clocks, or infer missing facts from current runtime state.

## Changing the contract

Classify a change as vocabulary, encoding, or reduction before editing. Add the
smallest focused tests at that owner, including invalid and terminal cases. For
a persisted-shape change, reduce representative retained history as well as new
events. Then test and build the affected channel, agent, and chat consumers
named by the actual import graph.

Keep one current protocol. Coordinate a real breaking change across every
producer and consumer instead of adding optional legacy fields, dual decoders,
version guessing, or consumer-specific normalization.
