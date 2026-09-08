---
name: architecture
description: "Design or review cross-cutting Vibestudio architecture: trust boundaries, ownership, agents, state, provenance, permissions, credentials, builds."
---

# Vibestudio architecture

Use this skill to decide which component owns a fact or effect. Use task skills
for implementation details.

## Read by question

| Question | Reference |
| --- | --- |
| Host/userland boundary, unit kinds, RPC, transport, agents | [SYSTEM.md](SYSTEM.md) |
| Durable state, logs, semantic VCS, provenance, blobs, builds | [STORAGE.md](STORAGE.md) |
| Permissions, approvals, credentials, devices, principals | [SECURITY.md](SECURITY.md) |

## System model

The trusted host owns identity, protected refs, permission decisions, credential
injection, builds, disk projection, and network egress. Workspace units have
explicit trust models: panels run in isolated webviews; workers and DOs run in
workerd isolates; extensions run as approved Node services; apps are approved
clients. Agents are ordinary workspace participants using the same services and
gates as other callers.

The workspace is the locality boundary for source, state, and contexts.
Contexts branch inside one workspace; they do not make another workspace's
source available. Quickfire follows the workspace of its target panel.
Personal and System are private per-user workspaces, and native client code is
owned by that user's System workspace. `about/new` and other workspace-local
pages load from the local workspace. Cross-workspace application RPC uses an
explicit destination and an exposed receiver method. Source outgoing and
destination incoming policies are hard admission boundaries; ordinary
operation authority is checked afterward. A qualified target alone grants no
access, and an approval cannot override either workspace policy. See
[workspace RPC](../workspace-dev/RPC.md) for the integration contract.

Durable conversations and tool activity live in canonical trajectory/channel
logs. Managed source, applications, integration decisions, and publication live
in the semantic workspace graph. Materialized files, indexes, Git checkouts, and
build outputs are projections — never make one a competing authority.

## Load-bearing invariants

- Keep the trusted host narrow. Workspace behavior belongs in workspace units
  unless it must enforce a trust boundary.
- Trust comes from declared identity and review, not filesystem location.
- Store durable history as immutable, walkable facts. Caches must be disposable
  and rebuildable.
- Join tool invocations to semantic work through recorded causal edges — no
  claims or provenance sidecar.
- Keep semantic source authority singular. Git, builds, and filesystem
  projections are adapters or consumers.
- Authentication establishes caller identity; grants and approvals authorize
  effects. Credentials stay host-held and audience-bound.
- Protected publication validates ancestry, integration, the exact candidate,
  and approval. Runtime activation fails closed and retains the runnable
  artifact when a derived build is bad.

When documents disagree, prefer the live generated service contract and schema
of record, then the canonical domain skill, then broad orientation prose. For
managed source operations, [Vibestudio VCS](../vibestudio-vcs/SKILL.md) is
canonical.
