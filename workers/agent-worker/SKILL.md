---
name: chat-agent-worker
description: Develop the default AiChatWorker product adapter, including participant identity, prompt-resource composition, channel feature bindings, and standard or panel-debug tool selection.
---

# Chat agent worker

`workers/agent-worker` is the thin product adapter for the default chat agent.
Core execution, trajectory folding, model effects, failure envelopes, and
subagent supervision belong in `packages/agentic-do`; pure subscription and
client types belong in `packages/agentic-core`.

Read [agentic development](../../skills/agentic-development/SKILL.md) for a
coordinated stack change and [Agentic DO](../../packages/agentic-do/SKILL.md)
before changing runtime mechanics.

## Invariants

- `AiChatWorker` is a per-channel Durable Object participant. Its handle,
  participant metadata, respond policy, and advertised methods must agree with
  the subscription configuration and channel contract.
- Normal prompt composition loads `meta/AGENTS.md` and the live workspace skill
  index. A `systemPromptMode: "replace"` subscription is complete by definition
  and intentionally loads neither. Do not create another prompt-loading path.
- Omitted channel tool configuration means the standard tool set. Explicit
  configuration is a closed selection: resolve declared resource bindings,
  reject unknown or duplicate tools, and never silently add ambient tools.
- Panel-debug tools operate only on their bound panel-slot resource. Tool
  availability does not grant the underlying host capability.
- Keep requested capabilities and service protocols truthful in `package.json`.
  A new tool or service call and its authority declaration are one change.

## Self-modification and verification

The running worker cannot replace its own loaded image or prompt resources.
After focused worker and authority-manifest tests and an exact-context build,
launch a uniquely named canary agent in the same context through
[agents](../../skills/agents/SKILL.md). Give it a bounded task that exercises
the changed prompt/tool behavior, inspect its durable trajectory and invocation
failures from the parent, then unsubscribe and retire it. Do not reuse the
parent agent's key or claim the current turn adopted the new implementation.
