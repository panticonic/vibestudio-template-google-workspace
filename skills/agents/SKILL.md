---
name: agents
description: Add or remove a worker-backed agent from a chat channel.
---

# Adding an agent to a channel

This skill operates existing agent implementations. To author or change the
chat panel, agent worker/runtime, channel, or protocol, read
[agentic development](../agentic-development/SKILL.md).

An agent is a worker DO inside the current workspace. The generic chat-agent
example is `workers/agent-worker` / `AiChatWorker`; `workers/explorer-agent` is
a Personal-specific diagnostic worker and is not a general application agent.
Use the general helper to create an instance and
subscribe it:

```ts
import { addAgentToChannel } from "@workspace-skills/agents";

const result = await addAgentToChannel({
  source: "workers/agent-worker",
  className: "AiChatWorker",
  handle: "assistant",
  name: "Assistant",
  channelId: chat.channelId, // defaults contextId to the current runtime context
  replay: true, // only when eligible existing history should be admitted
  config: {
    /* model, respondPolicy, … per-agent behavior */
  },
});
// → { ok, channelId, contextId, targetId, participantId, key: "explorer-<channelId>" }
```

Remove with `removeAgentFromChannel({ source, className, handle, channelId })`.

The worker, channel, prompt resources, and agent state are resolved in the
workspace that owns the target panel. Contexts are branches inside that same
workspace; they do not load source from another workspace. Quickfire follows
the target panel's workspace as well. Personal and System are private
per-user workspaces, and native client code runs from that user's System
workspace.

## Per-channel identity

Instances are keyed per channel (`${handle}-${channelId}`), so every channel
gets its own agent DO. This is load-bearing:

- Never reuse a scheduled or shared instance key for an ad-hoc channel — sharing
  one DO across channels mixes turn state and corrupts logs.
- Never replace the helper with `resolveDurableObject` and a guessed key — that
  resolves a supplied identity rather than minting a safe channel-local one.

That per-channel key is also this instance's **directory identity**. Joining a
channel registers the agent in the workspace agent directory as
`<handle>@<channelId>`, which is directly addressable:
`notify({ to: "agent:<handle>@<channelId>" })`. One worker in three channels is
three directory rows sharing a worker id — correct, because "message the gmail
agent" is meaningless without saying where. See the `messaging` skill.

Re-adding the same handle to the same channel is idempotent. Membership is
durable; presence and typing are disposable UI state. The helper delegates to
the canonical `launchAgentIntoChannel` lifecycle. Panel products that can
request workspace review pass their approval adapter as `waitForReview`; the
helper then waits and retries the same idempotent launch.

## Multi-agent product topology

Use `respondPolicy: "mentioned-strict"` for agents that should act only on
addressed work. Give ordinary unmentioned player text one explicit default
recipient—usually a command interpreter—instead of broadcasting it. A direct
mention may bypass the interpreter when the product intends expert access.

Address work with the `notify` addressee grammar (`@handle`,
`participant:<id>`, `agent:<handle>@<channelId>`) rather than hand-rolled
mention plumbing; an unresolvable addressee fails the call with suggestions
instead of degrading into a broadcast. The `messaging` skill is the reference.

A command interpreter translates natural language into narrow addressed
requests. It must reread authoritative application state before resolving
references such as “the first plan” or “Engineering's proposal,” and ask a
clarifying question rather than inventing an identifier. Do not give it mutation
authority merely because it coordinates the conversation. State-changing
methods validate the authenticated caller and leave legality, costs, and
invariants to deterministic code.

Treat agent-to-agent progression as an addressed durable effect. When a state
transition requires a follow-up message, persist the transition and pending
directive together, publish with a deterministic idempotency key, and clear the
directive only after publication succeeds. Redrive it after hibernation or
reload. A successful mutation followed by an unrecorded best-effort send is not
a complete workflow.

## Per-agent setup wrappers

Agents needing credentials, onboarding, or custom config should wrap this
helper. Keep prerequisites in the wrapper; channel membership stays here.
