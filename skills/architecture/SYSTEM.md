# Topology and Trust

## The two-tier trust model

Vibestudio separates the **trusted host** from **workspace-authored code**.
Browser panels, workerd workers and native processes have different execution
boundaries; a workspace label alone does not establish native containment.

**The host** is the Electron shell (or headless server + paired native
clients) plus the workspace server process. It owns, exclusively:

- authentication (tokens, device credentials, pairing) and the permission
  system (grants, approval prompts)
- credential storage and injection on network egress
- protected VCS refs (`main` per repo) and the approval-gated compare-and-swap
  that advances them
- the build system and the content-addressed blob/build stores
- disk projection (materializing workspace state into context folders)
- supervision of workerd, extension processes, and panel webviews

**Userland** is everything under the workspace root — the tree that is *your*
file root as an agent. All of it is agent-writable source, versioned in the
workspace VCS and built on demand. The host never
executes workspace code in its own process.

Protected application APIs authenticate callers, preserve workspace identity and
gate effects such as publishing `main` or using credentials. Native commands,
builds and extensions share one workspace runtime: Unix uses stock MXC with
selected filesystem resources and open networking; Windows runs directly with
the application's OS-user permissions. Windows native code has no filesystem or
network confinement. Contexts are branches, not native security domains, and
credentials deliberately exposed to a shared workspace are available to its
commands. RPC approvals do not confine raw native effects.

## Unit kinds

Admission identifies the exact declared package, source and requested authority;
neither a package name nor its filesystem position grants trust. Native client
hosting additionally checks the user's designated System workspace. An ordinary
workspace or website cannot gain client authority by declaring an `apps/` path.

| Kind | Runs in | Trust | Use for |
|---|---|---|---|
| **Panel** (`panels/*`) | Isolated webview, talks to server over WebSocket RPC | Sandboxed | User-facing UI surfaces |
| **Worker / DO** (`workers/*`) | workerd V8 isolate | Sandboxed | Server-side userland logic; DOs are the app-database primitive (`this.sql`) |
| **Extension** (`extensions/*`) | Native Node process in its workspace runtime | Exact source admission plus the platform's native execution contract | Wrapping native deps and long-lived Node services |
| **App** (`apps/*`) | Trusted client runtime: `electron` shell view, `react-native` signed bundle, or `terminal` artifact | **Trusted** client unit | Client software with its own runtime target |
| **Package** (`packages/*`) | Wherever imported | As importer | Shared libraries |
| **Project** (`projects/*`), `meta/` | Content only | n/a | Plain content repos; ungated push |

Panels/workers retain browser/workerd isolation. Native extensions follow the
platform contract above; client apps require their separate exact-code admission.
Source approval does not turn a workspace into a host process or lend it another
workspace's grants. New workspaces own their source and runtime state; adopting
Base source does not create a live dependency on a Base workspace.

## RPC vs workspace services

Two deliberate systems, non-overlapping:

- **Platform RPC** (`@vibestudio/rpc`) is fetch-shaped: one caller, one
  target, one value or one streamed Response. Used for host service calls
  (`fs.read`, `credentials.fetch`, `blobstore.*`), credential proxying, model
  fetches.
- **Workspace services** are workspace-authored workers/DOs resolved by
  protocol (declared in `meta/vibestudio.yml`, resolved via
  `workers.resolveService`). Conversation-shaped: multiple subscribers,
  replay, participants, structured streaming chunks. Channels are the
  canonical example.

Rule of thumb: point-to-point call/response → RPC; anything with subscribers,
replay, or durable multi-participant state → declare a workspace service.

## Transport identity

Every RPC transport carries two identity layers:

- `callerId` — durable application identity (shell, a panel id, a worker id).
  May have zero..many live connections. Safe to persist.
- `connectionId` — ephemeral transport identity for one authenticated socket.
  **Never persisted.**

Event delivery is either pub/sub (`emit` — reaches subscribers only) or direct
(`emitToCaller` — every live session of a durable caller; `emitToConnection` —
exactly one transport instance). Reconnect semantics: `resubscribe` is state
recovery (desired subscription state), `cold-recover` is an edge-triggered
server-restart repair; handlers must be idempotent around reconnect
boundaries.

## The agentic stack

The agent system is a 2-layer userland architecture — it enjoys no special
host privileges:

```
Panel (chat UI)  ⇄  Channel DO (pub/sub log)  ⇄  Agent Worker DO (embeds Pi in-process)
```

- **Channel DO** — a generic userland pub/sub substrate over the unified log:
  durable envelopes, participant roster with unique handles, replay for late
  subscribers. The chat transcript *is* a reduction over persisted channel
  envelopes; there is no separate transcript store.
- **Agent worker DO** — extends `AgentWorkerBase`
  (`packages/agentic-do`), owns one Pi runner per subscribed channel. Pi (the
  coding-agent engine) runs *in-process* in the DO — no harness child
  process. The runner converts Pi lifecycle events into canonical trajectory
  events (`message.*`, `invocation.*`, `turn.*`), appends them to the
  workspace store, and publishes selected events to the channel.
- **System prompt composition** — base prompt + `meta/AGENTS.md` + a generated
  one-line-per-skill index (name, path, description). Full skill docs are
  *pulled* by the agent via `read()`; nothing else is pushed into context.
- **Tools** — the agent's `eval` runs server-side in its own per-agent
  `EvalDO` as an ordinary `do`-principal caller. This is the reachability
  guarantee: anything a DO can call, an agent can reach through eval, with
  the same permission gates and consent prompts. Direct tool allow-lists on
  host services are a UX optimization, not the capability model.
- **Multi-agent** — other agents are just more worker DOs subscribed to the
  same channel; subagents are delegated child agents with their own task
  channel and child context. Channel handle uniqueness lets participants'
  advertised methods become tools without collision.

Because agents, panels, and workers are all just channel participants and RPC
callers, "what can the agent do?" always reduces to "what can this caller
identity do through the permission system?" — see SECURITY.md.

## Contexts

A context is an isolated execution environment with its own materialized
**context folder**, context ID, committed event, and working head. Panels
sharing a context share a filesystem; the chat agent and the panels it spawns
typically share one. Reads stay on that exact event/application state as
`main` advances elsewhere (see STORAGE.md for the VCS semantics).

Contexts are branches inside one workspace. They do not load source, state, or
authority from another workspace. Quickfire remains in the workspace of its
target panel; the native client is sourced from the user's private System
workspace, while workspace-local pages such as `about/new` load locally.
