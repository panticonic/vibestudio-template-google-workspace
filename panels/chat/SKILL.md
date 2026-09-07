---
name: chat-panel
description: Develop the workspace chat panel's product composition, model preflight, channel creation, installed-agent lifecycle, state arguments, and exact-context UI verification.
---

# Chat panel

`panels/chat` is the product composition root for an agentic conversation. It
selects the channel, model setup, installed agents, feature set, and reusable
`@workspace/agentic-chat` surface. It does not own generic transcript rendering,
the agent loop, channel persistence, or the event vocabulary.

For a coordinated stack change, read [agentic development](../../skills/agentic-development/SKILL.md).
For reusable presentation behavior, read
[agentic chat](../../packages/agentic-chat/SKILL.md). For panel lifecycle and
visual diagnosis, read [workspace development](../../skills/workspace-dev/SKILL.md).

## Invariants

- The host-bound panel `contextId` is authoritative. State args may describe a
  channel or presentation, but never select or contradict the workspace branch.
- Channel creation, durable slot placement, agent creation, subscription, and
  model readiness are distinct states. Preserve their typed failures instead of
  collapsing them into a loading boolean or retry loop.
- Persist each installed agent's minted object key and per-agent configuration.
  Rehydration reuses that identity; it does not spawn a replacement participant.
- Launch and unsubscribe through `@workspace/agentic-core` lifecycle helpers.
  Do not resolve a guessed DO key or add a second subscription path in the panel.
- Browser-owned chat capabilities are fixed for the participant lifetime. A
  changed advertised method surface requires a new join.
- Keep model selection and credential setup in the model-settings workflow.
  The chat panel must not infer readiness from the presence of a secret.

Put reusable component, transcript, composer, renderer, and theming changes in
`packages/agentic-chat`. Put generic agent launch state machines in
`packages/agentic-core`. Put agent execution behavior in `packages/agentic-do`
or `workers/agent-worker`.

## Verification

Run focused tests beside `bootstrap.ts`, `agentLifecycle.ts`, and the affected
chat behavior, then build `panels/chat` against the exact semantic context.
Open or rebuild one panel with an explicit matching context and
the ref `ctx:${ctx.contextId}`. Reuse its handle; inspect lifecycle observation,
structured snapshot, screenshot, accessibility, and console errors. Exercise
channel creation or rehydration when the change touches either path, and remove
temporary agents and panels when finished.

Saving managed source advances the semantic working state; it does not reload
an open chat page. `handle.reload()` restarts the currently selected immutable
build and is appropriate for renderer-state recovery. `handle.rebuild()`
resolves and prepares the panel's active ref again, then atomically replaces the
runtime attempt and waits for the boot handshake. Use `rebuild()` after changes
to `panels/chat` or any transitive package such as `packages/agentic-chat`.
Rebuilding a panel whose active ref is `main` does not adopt unpublished context
work; navigate or open it at the explicit context ref first. Publication may
prepare a new main artifact, but it does not forcibly reload an open page.

The panel slot id and handle survive a rebuild. Its `attemptId`, runtime entity,
build key, and CDP page may not. Refresh a retained CDP session after rebuild;
never keep using its old page. Rebuilding the chat panel reconnects the UI to
the durable channel but does not replace the separately running agent worker.
